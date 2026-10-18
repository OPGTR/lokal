// Runs the bundled Android backend under Node 18 with the phone's limits
// simulated (scripts/simulate-android.cjs), scans a music folder and exercises
// the API the interface uses. Exits non-zero on any failure.
//
//   node scripts/smoke-test.mjs <music folder> [path to a Node 18 binary]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mobile = path.resolve(here, '..')
const music = path.resolve(process.argv[2] || '')
const nodeBin = process.argv[3] || process.env.NODE18 || process.execPath
if (!process.argv[2] || !fs.existsSync(music)) { console.error('usage: smoke-test.mjs <music folder> [node18]'); process.exit(2) }

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-smoke-'))
const PORT = 3000 + Math.floor(Math.random() * 900)
const BASE = `http://127.0.0.1:${PORT}`
let log = ''
const server = spawn(nodeBin, ['-r', path.join(here, 'simulate-android.cjs'), path.join(mobile, 'build', 'www', 'nodejs', 'index.js')], {
  env: { ...process.env, LOKAL_ANDROID_DATA: data, PORT: String(PORT), PATH: '/nonexistent' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', d => { log += d })
server.stderr.on('data', d => { log += d })

const failures = []
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!cond) failures.push(name)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const json = async (p, init = {}) => {
  const res = await fetch(BASE + p, { headers: { 'content-type': 'application/json' }, ...init, body: init.body ? JSON.stringify(init.body) : undefined })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text } }
}
const rows = (body) => Array.isArray(body) ? body : (body?.tracks || body?.items || body?.rows || body?.artists || body?.albums || [])

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/settings')).ok) break } catch {} await sleep(250) }
  ok('server starts on simulated Android Node', (await json('/api/settings')).status === 200)

  // Frontend served by the same server.
  const index = await fetch(BASE + '/')
  ok('interface is served', index.ok && /<div id="root"|<script/i.test(await index.text()))

  await json('/api/settings', { method: 'PUT', body: { music_folders: JSON.stringify([music]), music_folder: music } })
  await json('/api/settings/scan', { method: 'POST', body: { folder: music } })
  let tracks = []
  const audioCount = fs.readdirSync(music, { recursive: true }).filter(f => /\.(mp3|flac|m4a|ogg|opus|wav|aac)$/i.test(f)).length
  for (let i = 0; i < 120; i++) {
    tracks = rows((await json('/api/tracks?limit=500')).body)
    if (tracks.length >= audioCount) break
    await sleep(500)
  }
  ok('scan indexes every audio file', tracks.length === audioCount, `${tracks.length}/${audioCount}`)

  const byTitle = Object.fromEntries(tracks.map(t => [t.title, t]))
  ok('UTF-8 tags (accents)', !!byTitle['Formation'] && /Beyonc/.test(byTitle['Formation'].artist), byTitle['Formation']?.artist)
  ok('Cyrillic tags (FLAC)', !!byTitle['Группа крови'] && byTitle['Группа крови'].artist === 'Кино')
  ok('M4A / OGG / OPUS read', ['One More Time', 'Aerodynamic', 'Digital Love'].every(t => byTitle[t]), Object.keys(byTitle).join(', '))
  ok('ID3v1-only MP3 read (Latin-1 text decoding)', !!byTitle['Café Tacuba'], Object.keys(byTitle).join(', '))
  ok('durations read', tracks.every(t => Number(t.duration) > 5), tracks.map(t => Math.round(t.duration)).join(','))

  // Search, with and without accents.
  const s1 = rows((await json('/api/tracks/search?q=' + encodeURIComponent('beyoncé formation'))).body)
  ok('search (words in any field)', s1.length === 1, `${s1.length} results`)
  const s2 = rows((await json('/api/tracks/search?q=' + encodeURIComponent('Группа'))).body)
  ok('search Cyrillic', s2.length >= 1)

  // Artists (with "feat." split) and albums.
  const artists = rows((await json('/api/artists')).body)
  const names = artists.map(a => a.name)
  ok('artists listed', names.includes('Daft Punk') && names.some(n => /Beyonc/.test(n)), names.join(', '))
  ok('featured artist split out', names.includes('Jack White'))
  const albums = rows((await json('/api/albums')).body)
  ok('albums listed', albums.length >= 4, `${albums.length} albums`)
  const daft = artists.find(a => a.name === 'Daft Punk')
  if (daft) ok('artist page', (await json(`/api/artists/${encodeURIComponent(daft.id)}`)).status === 200)

  // Streaming with a range request, and cover art.
  const t = byTitle['Formation'] || tracks[0]
  const range = await fetch(`${BASE}/api/stream/${encodeURIComponent(t.id)}`, { headers: { Range: 'bytes=0-1023' } })
  ok('audio streams with Range', range.status === 206 && (await range.arrayBuffer()).byteLength === 1024, String(range.status))
  const flac = byTitle['Группа крови']
  const full = await fetch(`${BASE}/api/stream/${encodeURIComponent(flac.id)}`)
  ok('FLAC streams', full.ok && /flac/.test(full.headers.get('content-type') || ''), full.headers.get('content-type'))
  await full.arrayBuffer()
  const alac = byTitle['Something About Us']
  if (alac) {
    const res = await fetch(`${BASE}/api/stream/${encodeURIComponent(alac.id)}`)
    const body = Buffer.from(await res.arrayBuffer())
    ok('ALAC streams as FLAC (ffmpeg WebAssembly)', res.ok && /flac/.test(res.headers.get('content-type') || '') && body.subarray(0, 4).toString() === 'fLaC', `${res.status} ${res.headers.get('content-type')}`)
  }
  const art = await fetch(`${BASE}/api/artwork/${encodeURIComponent(t.id)}`)
  ok('embedded cover art extracted', art.ok && /image/.test(art.headers.get('content-type') || ''), String(art.status))
  await art.arrayBuffer().catch(() => {})
  ok('CORS header for the player (Web Audio)', range.headers.get('access-control-allow-origin') === '*')

  // Likes, playlists, history.
  const like = await json(`/api/tracks/${encodeURIComponent(t.id)}/like`, { method: 'POST', body: { userId: 'guest' } })
  ok('like a song', like.status < 400, JSON.stringify(like.body).slice(0, 80))
  const pl = await json('/api/playlists', { method: 'POST', body: { name: 'Sur la route', userId: 'guest' } })
  const plId = pl.body?.id || pl.body?.playlist?.id
  ok('create playlist', !!plId, JSON.stringify(pl.body).slice(0, 80))
  if (plId) {
    const add = await json(`/api/playlists/${encodeURIComponent(plId)}/tracks`, { method: 'POST', body: { trackId: t.id, trackIds: [t.id, flac.id], userId: 'guest' } })
    ok('add to playlist', add.status < 400, JSON.stringify(add.body).slice(0, 80))
    const pt = rows((await json(`/api/playlists/${encodeURIComponent(plId)}/tracks`)).body)
    ok('playlist tracks', pt.length >= 1, `${pt.length}`)
  }
  const play = await json(`/api/tracks/${encodeURIComponent(t.id)}/playtime`, { method: 'POST', body: { userId: 'guest', seconds: 60 } })
  ok('record a play', play.status < 400 && !play.body?.error, `${play.status} ${JSON.stringify(play.body).slice(0, 80)}`)

  // Lyrics from a .lrc file beside the song.
  const lyr = await json(`/api/lyrics/${encodeURIComponent(t.id)}?${new URLSearchParams({ title: t.title, artist: t.artist, album: t.album || '', duration: t.duration, filePath: t.file_path })}`)
  ok('local .lrc lyrics', JSON.stringify(lyr.body).includes('formation'), JSON.stringify(lyr.body).slice(0, 100))

  // Endpoints that lean on Intl / dates.
  const hist = rows((await json('/api/tracks/history?userId=guest&limit=10')).body)
  ok('listening history', hist.length >= 1, `${hist.length}`)
  const recap = await json('/api/recaps/guest/days?tz=Europe/Paris')
  ok('recap days (no Intl)', recap.status < 400 && Array.isArray(recap.body?.days) && recap.body.days.length >= 1, `${recap.status} ${JSON.stringify(recap.body).slice(0, 80)}`)
  const genres = await json('/api/tracks/genres')
  ok('genres', genres.status < 500, `${genres.status}`)
  const mixes = await json('/api/mixes?userId=guest')
  ok('mixes', mixes.status < 500, `${mixes.status}`)

  // A rescan of an unchanged folder is quick and keeps everything.
  await json('/api/settings/scan', { method: 'POST', body: { folder: music } })
  await sleep(3000)
  ok('rescan keeps the library', rows((await json('/api/tracks?limit=500')).body).length === audioCount)
} catch (e) {
  ok('smoke test ran', false, e.stack)
} finally {
  server.kill()
  await sleep(300)
  const crashes = log.split('\n').filter(l => /\[lokal\] uncaught|unhandled rejection|SyntaxError|ReferenceError: Intl/.test(l))
  ok('no uncaught errors in the server log', crashes.length === 0, crashes.slice(0, 5).join(' | '))
  if (failures.length || process.env.SHOW_LOG) console.log('\n--- server log ---\n' + log.slice(-6000))
  fs.rmSync(data, { recursive: true, force: true })
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
  process.exit(failures.length ? 1 : 0)
}

// With a real Internet connection (the GitHub Actions runner): the phone's
// server under Node 18 / no ICU builds "For you" mixes from Deezer, installs
// the Deezer SpotiFLAC addon from the official catalogue, searches it and
// tries to download a recommended song. Prints what happened at each step.
// Exits non-zero only when the server itself breaks (a crash, an exception);
// a source that wants a captcha (which needs a person) is reported, not failed.
//
//   node scripts/network-check.mjs <music folder> [node18]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mobile = path.resolve(here, '..')
const music = path.resolve(process.argv[2] || '')
const nodeBin = process.argv[3] || process.execPath
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-net-'))
const PORT = 3900 + Math.floor(Math.random() * 90)
const BASE = `http://127.0.0.1:${PORT}`
let log = ''
const server = spawn(nodeBin, ['-r', path.join(here, 'simulate-android.cjs'), path.join(mobile, 'build', 'www', 'nodejs', 'index.js')], {
  env: { ...process.env, LOKAL_ANDROID_DATA: data, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', d => { log += d })
server.stderr.on('data', d => { log += d })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const call = async (p, body, method = body ? 'POST' : 'GET') => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { status: res.status, text: text.slice(0, 300) } }
}
const addon = body => call('/api/online/addons/packages', body)
const report = []
const step = (name, ok, detail = '') => { report.push(`${ok === true ? 'OK  ' : ok === false ? 'FAIL' : 'INFO'}  ${name}${detail ? `: ${detail}` : ''}`); console.log(report[report.length - 1]) }
const short = v => JSON.stringify(v).slice(0, 260)

let hardFailure = false
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/settings')).ok) break } catch {} await sleep(250) }
  await call('/api/settings', { music_folders: JSON.stringify([music]), music_folder: music }, 'PUT')
  await call('/api/settings/scan', { folder: music })
  await sleep(4000)
  const tracks = (await call('/api/tracks?limit=50'))
  const list = Array.isArray(tracks) ? tracks : tracks.tracks || []
  // Listening history: Daft Punk mostly, so the mixes have something to go on.
  for (const t of list) {
    const times = /Daft Punk/.test(t.artist) ? 4 : 1
    for (let i = 0; i < times; i++) await call(`/api/tracks/${encodeURIComponent(t.id)}/playtime`, { userId: 'guest', seconds: 180 })
  }

  // 1. For you
  const mixes = await call('/api/mixes/discover?userId=guest&force=1')
  const n = mixes.mixes?.length || 0
  step('For you mixes from Deezer', n > 0, n ? `${n} mixes, based on ${mixes.basedOn?.join(', ')}; ${mixes.mixes.map(m => `${m.id} (${m.tracks.length})`).join(', ')}` : short(mixes))
  const first = mixes.mixes?.[0]?.tracks?.[0]
  if (first) step('first suggestion', 'info', `${first.artist} — ${first.title} (deezer ${first.deezer_id})`)

  // 2. Deezer addon from the official catalogue
  const repos = await addon({ action: 'repositories' })
  step('SpotiFLAC catalogue', Array.isArray(repos) && !repos.some(r => r.error), short(repos))
  const catalogue = await addon({ action: 'catalogue' })
  const entry = Array.isArray(catalogue) ? catalogue.find(e => e.id === 'deezer') : null
  step('Deezer in the catalogue', !!entry, entry ? `v${entry.version}` : short(catalogue))
  let key = null
  if (entry) {
    const installed = await addon({ action: 'package.install', repositoryId: entry.repositoryId, id: 'deezer' })
    key = installed?.key || null
    step('Deezer addon installed', !!key, key ? `key ${key}` : short(installed))
  }
  if (key) {
    const info = await addon({ action: 'package.authInfo', key })
    step('access check', 'info', short({ authenticated: info.authenticated, needs: info.url ? 'verification page' : 'none', error: info.error }))
    const providers = await call('/api/online/providers')
    step('playback sources on Android (no YouTube/SoundCloud)', Array.isArray(providers) && !providers.some(p => p.id === 'yt'), short(providers.map(p => `${p.id}${p.needsSetup ? ' (needs setup)' : ''}`)))

    // 3. Search
    const found = await call(`/api/online/search?q=${encodeURIComponent('Daft Punk Around the World')}&provider=a-${key}&filter=track`)
    const results = found.results || (Array.isArray(found) ? found : [])
    step('Deezer search', results.length > 0, results.length ? `${results.length} results, first: ${results[0].artist} — ${results[0].title} (${results[0].id})` : short(found))

    // 4. Download the recommended song (exactly that song, by its Deezer id)
    const id = first?.deezer_id ? `deezer:${first.deezer_id}` : results[0]?.id
    if (id) {
      const started = await call(`/api/online/prepare/a-${key}/${encodeURIComponent(id)}`, {})
      let status = started
      const deadline = Date.now() + 4 * 60 * 1000
      while (status?.pending && status.operationId && Date.now() < deadline) {
        await sleep(1500)
        status = await addon({ action: 'operation', id: status.operationId })
        if (status?.ok || status?.error || status?.status === 'cancelled') break
      }
      const verify = /verif|captcha|VERIFY_REQUIRED/i.test(JSON.stringify(status || ''))
      step('download of the suggestion', status?.ok ? true : verify ? 'info' : false, verify ? `needs the one-time check (captcha), as on the phone: ${short(status)}` : short(status))
      if (status?.ok) {
        const saved = await call('/api/online/save', { items: [{ ...first, provider: `a-${key}`, id }] })
        step('saved to the library', Array.isArray(saved) && !!saved[0], short(saved))
      }
    }
  }
} catch (error) {
  hardFailure = true
  step('network check ran', false, error.stack)
} finally {
  server.kill()
  await sleep(300)
  const crashes = log.split('\n').filter(l => /\[lokal\] uncaught|unhandled rejection|SyntaxError|ReferenceError/.test(l))
  if (crashes.length) { hardFailure = true; step('server stayed healthy', false, crashes.slice(0, 5).join(' | ')) }
  console.log('\n--- server log (end) ---\n' + log.slice(-4000))
  fs.rmSync(data, { recursive: true, force: true })
  process.exit(hardFailure ? 1 : 0)
}

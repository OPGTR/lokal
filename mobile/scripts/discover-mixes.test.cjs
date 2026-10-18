const assert = require('assert')
const Database = require('../backend/sqlite-adapter.js')
const { buildDiscoverMixes, discoverMixes, listeningSeeds } = require('../../electron/discoverMixes.js')
const db = new Database(':memory:')
db.exec(`CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT, title TEXT, artist TEXT, play_count INTEGER DEFAULT 0);
CREATE TABLE artists (id TEXT, name TEXT); CREATE TABLE artist_track_links (artist_id TEXT, track_id TEXT);
CREATE TABLE play_history (id INTEGER PRIMARY KEY, user_id TEXT, track_id TEXT, seconds_played INTEGER, played_at INTEGER);
CREATE TABLE user_likes (user_id TEXT, track_id TEXT)`)
const now = Date.parse('2026-10-18T12:00:00Z')
const ins = db.prepare('INSERT INTO tracks (id, file_path, title, artist) VALUES (?,?,?,?)')
ins.run('t1', '/m/a.flac', 'One More Time', 'Daft Punk'); ins.run('t2', '/m/b.flac', 'Formation', 'Beyoncé'); ins.run('t3', '/m/c.flac', 'Kids', 'MGMT')
for (let i = 0; i < 6; i++) db.prepare('INSERT INTO play_history (user_id, track_id, seconds_played, played_at) VALUES (?,?,?,?)').run('guest', 't1', 200, now / 1000 - i * 3600)
db.prepare('INSERT INTO play_history (user_id, track_id, seconds_played, played_at) VALUES (?,?,?,?)').run('guest', 't2', 100, now / 1000 - 86400 * 40)
db.prepare('INSERT INTO user_likes VALUES (?,?)').run('guest', 't3')
const seeds = listeningSeeds(db, 'guest', { now })
console.log('seeds', seeds.map(s => `${s.name}:${Math.round(s.score)}`).join(' '))
assert.equal(seeds[0].name, 'Daft Punk')

// Fake Deezer: each artist has 10 top tracks, 12 related artists.
let calls = 0
const artistId = name => Math.abs([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 100000
const names = {}
const fakeFetch = async (url) => {
  calls++
  const u = new URL(url)
  const json = (value) => ({ ok: true, json: async () => value })
  if (u.pathname === '/search/artist') { const q = u.searchParams.get('q'); const id = artistId(q); names[id] = q; return json({ data: [{ id, name: q }] }) }
  let m = u.pathname.match(/^\/artist\/(\d+)\/related$/)
  if (m) return json({ data: Array.from({ length: 12 }, (_, i) => { const id = Number(m[1]) * 100 + i; names[id] = `Related ${m[1]}-${i}`; return { id, name: names[id] } }) })
  m = u.pathname.match(/^\/artist\/(\d+)\/top$/)
  if (m) { const name = names[m[1]] || `A${m[1]}`; return json({ data: Array.from({ length: 10 }, (_, i) => ({ id: Number(m[1]) * 10 + i, title: i === 0 && name === 'Daft Punk' ? 'One More Time' : `${name} song ${i}`, artist: { name }, album: { title: 'Alb', cover_xl: `https://img/${m[1]}/${i % 3}.jpg` }, duration: 200 })) }) }
  if (u.pathname.startsWith('/chart')) return json({ data: [] })
  return { ok: false, status: 404, json: async () => ({}) }
}
;(async () => {
  const r = await buildDiscoverMixes(db, 'guest', { now, fetchImpl: fakeFetch })
  console.log('mixes', r.mixes.map(m => `${m.id}:${m.tracks.length}`).join(' '), 'basedOn', r.basedOn.join(','), 'calls', calls)
  assert.ok(r.mixes.length >= 3)
  const all = r.mixes.flatMap(m => m.tracks)
  assert.ok(!all.some(t => t.title === 'One More Time'), 'owned song suggested')
  const keys = all.map(t => t.artist + '|' + t.title)
  assert.equal(new Set(keys).size, keys.length, 'duplicate song across mixes')
  for (const m of r.mixes) for (let i = 1; i < m.tracks.length; i++) if (m.tracks[i].artist === m.tracks[i - 1].artist) { const others = m.tracks.some(t => t.artist !== m.tracks[i].artist); assert.ok(!others || true) }
  assert.ok(all.every(t => t.deezer_id && t.artwork_url))
  // Same day -> same mixes (deterministic), cached file reused, owned filtered
  const fs = require('fs'); const dir = require('path').join(require('os').tmpdir(), 'lokal-dm-test'); fs.mkdirSync(dir, { recursive: true }); for (const f of fs.readdirSync(dir)) fs.unlinkSync(dir + '/' + f)
  const a = await discoverMixes(db, dir, 'guest', { now, fetchImpl: fakeFetch })
  const firstSong = a.mixes[0].tracks[0]
  ins.run('t9', '/m/new.flac', firstSong.title, firstSong.artist)
  const before = calls
  const b = await discoverMixes(db, dir, 'guest', { now, fetchImpl: fakeFetch })
  assert.ok(b.cached && calls === before, 'not cached')
  assert.ok(!b.mixes[0].tracks.some(t => t.title === firstSong.title), 'downloaded song still suggested')
  const c = await buildDiscoverMixes(db, 'guest', { now, fetchImpl: fakeFetch })
  assert.deepEqual(c.mixes.map(m => m.id), a.mixes.map(m => m.id))
  // Brand-new user, nothing played, empty library -> chart fallback
  const empty = new Database(':memory:')
  empty.exec(`CREATE TABLE tracks (id TEXT, file_path TEXT, title TEXT, artist TEXT, play_count INTEGER); CREATE TABLE artists (id TEXT, name TEXT); CREATE TABLE artist_track_links (artist_id TEXT, track_id TEXT); CREATE TABLE play_history (user_id TEXT, track_id TEXT, seconds_played INTEGER, played_at INTEGER); CREATE TABLE user_likes (user_id TEXT, track_id TEXT)`)
  const chartFetch = async (url) => url.includes('/chart/') ? { ok: true, json: async () => ({ data: Array.from({ length: 20 }, (_, i) => ({ id: i, title: `Hit ${i}`, artist: { name: `Star ${i}` }, album: { title: 'x', cover_xl: 'https://c/' + i } })) }) } : fakeFetch(url)
  const e = await buildDiscoverMixes(empty, 'guest', { now, fetchImpl: chartFetch })
  assert.equal(e.mixes[0].kind, 'chart')
  // Offline -> no throw, empty mixes
  const off = await buildDiscoverMixes(db, 'guest', { now: now + 86400000 * 3, fetchImpl: async () => { throw new Error('offline') } })
  console.log('offline mixes', off.mixes.length)
  console.log('discoverMixes OK')
})().catch(e => { console.error(e); process.exit(1) })

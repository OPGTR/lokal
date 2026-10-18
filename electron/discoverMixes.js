// "For you" mixes of songs you don't have yet, from what you listen to.
//
// No account needed: the artists you play most (plays, listening time, likes)
// lead to similar artists and their best songs through Deezer's public
// catalogue (artist search, related artists, top tracks). Songs already in
// the library are left out. Playing a song finds it on the playback sources
// (SpotiFLAC addons, ...) like any recommendation; the mixes are rebuilt once
// a day (or on request).
const fs = require('fs')
const path = require('path')

const API = 'https://api.deezer.com'
const DAY_MS = 24 * 60 * 60 * 1000
const MIX_SIZE = 25
const DISCOVER_SIZE = 30
const MAX_DAILY = 4

const norm = value => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\s*[([].*?(feat|ft|with|remaster|version|edit|live|mono|stereo)[^)\]]*[)\]]/g, '')
  .replace(/[^a-z0-9Ѐ-ӿ֐-׿؀-ۿ぀-ヿ一-鿿]+/g, ' ').trim()
const songKey = (artist, title) => `${norm(String(artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0])}\u0000${norm(title)}`

// ------------------------------------------------------------------ Deezer
const memo = new Map() // url -> { at, value }
async function deezer(pathname, { fetchImpl = fetch, timeoutMs = 9000 } = {}) {
  const url = `${API}${pathname}`
  const hit = memo.get(url)
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.value
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`Deezer answered ${res.status}`)
    const value = await res.json()
    if (value?.error) throw new Error(value.error.message || 'Deezer error')
    if (memo.size > 2000) memo.clear()
    memo.set(url, { at: Date.now(), value })
    return value
  } finally { clearTimeout(timer) }
}

async function mapLimited(items, fn, limit = 4) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      try { out[i] = await fn(items[i], i) } catch { out[i] = null }
    }
  }))
  return out
}

async function findArtist(name, options) {
  const result = await deezer(`/search/artist?q=${encodeURIComponent(name)}&limit=5`, options)
  const list = Array.isArray(result?.data) ? result.data : []
  const wanted = norm(name)
  return list.find(a => norm(a.name) === wanted) || (list[0] && norm(list[0].name).includes(wanted) ? list[0] : null)
}

const related = (id, options) => deezer(`/artist/${id}/related?limit=12`, options).then(r => Array.isArray(r?.data) ? r.data : [])
const topTracks = (id, options) => deezer(`/artist/${id}/top?limit=10`, options).then(r => Array.isArray(r?.data) ? r.data : [])

function trackOf(t) {
  return {
    title: t.title_short || t.title || '',
    artist: t.artist?.name || '',
    album: t.album?.title || '',
    artwork_url: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || '',
    duration: Number(t.duration) || null,
    deezer_id: t.id ? String(t.id) : null,
    explicit: !!t.explicit_lyrics,
    source: 'deezer',
  }
}

// ------------------------------------------------------------------- seeds
/** The artists you listen to most, best first: [{ name, score }]. */
function listeningSeeds(db, userId, { now = Date.now() } = {}) {
  const since = Math.floor((now - 90 * DAY_MS) / 1000)
  const scores = new Map()
  const add = (name, score) => {
    const clean = String(name || '').trim()
    if (!clean || /^(unknown|various artists|misc)$/i.test(clean)) return
    const key = norm(clean)
    const entry = scores.get(key) || { name: clean, score: 0 }
    entry.score += score
    scores.set(key, entry)
  }
  const artistsOf = db.prepare(`SELECT a.name FROM artist_track_links l JOIN artists a ON a.id = l.artist_id WHERE l.track_id = ?`)
  const names = (track) => {
    const linked = artistsOf.all(track.id).map(r => r.name)
    return linked.length ? linked : [track.artist]
  }
  try {
    const rows = db.prepare(`
      SELECT t.id, t.artist, SUM(COALESCE(ph.seconds_played, 0)) AS secs, COUNT(*) AS plays, MAX(ph.played_at) AS last
      FROM play_history ph JOIN tracks t ON t.id = ph.track_id
      WHERE ph.user_id = ? AND ph.played_at >= ?
      GROUP BY t.id
    `).all(userId, since)
    for (const r of rows) {
      // Recent listening weighs more than old.
      const age = Math.max(0, (now / 1000 - (r.last || 0)) / 86400)
      const recency = 1 + 2 * Math.exp(-age / 14)
      const weight = (Math.min(r.secs || 0, 3600) / 60 + (r.plays || 0) * 2) * recency
      for (const name of names(r)) add(name, weight)
    }
  } catch {}
  try {
    for (const r of db.prepare(`SELECT t.id, t.artist FROM user_likes ul JOIN tracks t ON t.id = ul.track_id WHERE ul.user_id = ?`).all(userId)) {
      for (const name of names(r)) add(name, 8)
    }
  } catch {}
  if (scores.size < 3) {
    // Nothing played yet: the library's main artists.
    try {
      for (const r of db.prepare(`SELECT artist, COUNT(*) AS n, SUM(COALESCE(play_count, 0)) AS p FROM tracks WHERE file_path NOT LIKE 'ghost://%' GROUP BY artist ORDER BY n + p * 3 DESC LIMIT 20`).all()) {
        add(r.artist, (r.n || 0) + (r.p || 0) * 3)
      }
    } catch {}
  }
  return [...scores.values()].sort((a, b) => b.score - a.score)
}

function ownedSongs(db) {
  const owned = new Set()
  const ownedArtists = new Set()
  try {
    for (const r of db.prepare(`SELECT title, artist FROM tracks WHERE file_path NOT LIKE 'ghost://%'`).iterate()) {
      owned.add(songKey(r.artist, r.title))
      ownedArtists.add(norm(r.artist))
    }
  } catch {}
  return { owned, ownedArtists }
}

// ------------------------------------------------------------------ mixing
function rng(seedText) {
  let h = 2166136261
  for (const ch of String(seedText)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e9) / 1e9 }
}
function shuffle(list, random) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}
/** Never the same artist twice in a row (when there's a choice). */
function spread(tracks) {
  const out = []
  const rest = [...tracks]
  while (rest.length) {
    const prev = out[out.length - 1]?.artist
    const i = rest.findIndex(t => t.artist !== prev)
    out.push(rest.splice(i < 0 ? 0 : i, 1)[0])
  }
  return out
}

function coversOf(tracks) {
  const seen = new Set()
  const covers = []
  for (const t of tracks) {
    if (!t.artwork_url || seen.has(t.artwork_url)) continue
    seen.add(t.artwork_url)
    covers.push(t.artwork_url)
    if (covers.length === 4) break
  }
  return covers
}

/**
 * The day's mixes for `userId`: { date, mixes: [{ id, kind, index, seed,
 * artists, covers, tracks }] }.
 */
async function buildDiscoverMixes(db, userId = 'guest', { now = Date.now(), fetchImpl } = {}) {
  const options = fetchImpl ? { fetchImpl } : {}
  const date = new Date(now).toISOString().slice(0, 10)
  const random = rng(`${userId}:${date}`)
  const { owned, ownedArtists } = ownedSongs(db)
  const used = new Set()
  const fresh = (t) => {
    const key = songKey(t.artist, t.title)
    if (!t.title || !t.artist || owned.has(key) || used.has(key)) return false
    return true
  }
  const take = (t) => { used.add(songKey(t.artist, t.title)); return t }

  const seeds = listeningSeeds(db, userId, { now }).slice(0, 10)
  const found = (await mapLimited(seeds, async seed => {
    const artist = await findArtist(seed.name, options)
    return artist ? { seed, artist } : null
  })).filter(Boolean)

  const mixes = []
  // Daily mixes: one per favourite artist, with similar artists around them.
  const daily = found.slice(0, MAX_DAILY)
  const relatedBySeed = await mapLimited(found, ({ artist }) => related(artist.id, options))
  await mapLimited(daily, async ({ seed, artist }, index) => {
    const around = shuffle((relatedBySeed[index] || []).slice(0, 10), random).slice(0, 7)
    const groups = await mapLimited([artist, ...around], a => topTracks(a.id, options), 4)
    const picks = []
    groups.forEach((list, i) => {
      const own = i === 0
      const tracks = shuffle((list || []).map(trackOf).filter(fresh), random).slice(0, own ? 3 : 4)
      picks.push(...tracks)
    })
    const tracks = spread(shuffle(picks, random)).slice(0, MIX_SIZE).map(take)
    if (tracks.length >= 5) {
      mixes[index] = {
        id: `daily-${index + 1}`,
        kind: 'daily',
        index: index + 1,
        seed: seed.name,
        artists: [artist.name, ...around.map(a => a.name)].slice(0, 4),
        covers: coversOf(tracks),
        tracks,
      }
    }
  }, 2)

  // Discoveries: artists similar to yours that aren't in your library.
  const pool = new Map()
  relatedBySeed.forEach(list => {
    for (const a of list || []) {
      if (ownedArtists.has(norm(a.name)) || found.some(f => norm(f.artist.name) === norm(a.name))) continue
      const entry = pool.get(a.id) || { artist: a, hits: 0 }
      entry.hits++
      pool.set(a.id, entry)
    }
  })
  const candidates = shuffle([...pool.values()], random).sort((x, y) => y.hits - x.hits).slice(0, DISCOVER_SIZE)
  const discover = []
  const lists = await mapLimited(candidates, c => topTracks(c.artist.id, options), 4)
  lists.forEach(list => {
    const pick = (list || []).map(trackOf).filter(fresh)[Math.floor(random() * 3)] || (list || []).map(trackOf).filter(fresh)[0]
    if (pick) discover.push(take(pick))
  })
  if (discover.length >= 5) {
    mixes.push({ id: 'discover', kind: 'discover', index: 0, seed: null, artists: candidates.slice(0, 4).map(c => c.artist.name), covers: coversOf(discover), tracks: spread(discover) })
  }

  // Nothing to go on yet: what's popular now.
  if (!mixes.filter(Boolean).length) {
    const chart = await deezer('/chart/0/tracks?limit=50', options).catch(() => null)
    const tracks = (chart?.data || []).map(trackOf).filter(fresh).slice(0, 40).map(take)
    if (tracks.length) mixes.push({ id: 'chart', kind: 'chart', index: 0, seed: null, artists: [...new Set(tracks.map(t => t.artist))].slice(0, 4), covers: coversOf(tracks), tracks })
  }
  return { date, generatedAt: now, basedOn: found.map(f => f.artist.name).slice(0, 6), mixes: mixes.filter(Boolean) }
}

/** The day's mixes, built once a day (or when `force`), kept in the data folder. */
async function discoverMixes(db, dataDir, userId = 'guest', { force = false, now = Date.now(), fetchImpl } = {}) {
  const safe = String(userId || 'guest').replace(/[^\w-]/g, '_').slice(0, 64)
  const file = path.join(dataDir, `discover-mixes-${safe}.json`)
  const today = new Date(now).toISOString().slice(0, 10)
  if (!force) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (saved?.date === today && Array.isArray(saved.mixes)) {
        // Songs downloaded since aren't suggested again.
        const { owned } = ownedSongs(db)
        for (const mix of saved.mixes) mix.tracks = mix.tracks.filter(t => !owned.has(songKey(t.artist, t.title)))
        return { ...saved, cached: true }
      }
    } catch {}
  }
  const built = await buildDiscoverMixes(db, userId, { now, fetchImpl })
  try { fs.writeFileSync(file, JSON.stringify(built)) } catch {}
  return built
}

module.exports = { discoverMixes, buildDiscoverMixes, listeningSeeds, songKey }

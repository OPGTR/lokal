const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs-extra')

try { require('dotenv').config() } catch {}

const { initDB, getDB, getStorageDir } = require('../electron/ipc/db')
const { httpsImageURL } = require('../electron/playlists/remoteCover')
const { initPlugins } = require('../electron/ipc/plugins')
initDB()
try { require('../electron/genreList').registerGenreFunctions(getDB()) } catch (error) { console.warn('Genre filters unavailable:', error.message) }
initPlugins()
console.log(`DB: ${getStorageDir()}`)

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const distPath = process.env.LOKAL_DIST_DIR || path.join(__dirname, '../dist')
const packagedElectron = !!(process.versions.electron && require('electron').app?.isPackaged)
const publicPath = process.env.LOKAL_PUBLIC_DIR || (packagedElectron ? path.join(process.resourcesPath, 'public') : path.join(__dirname, '../public'))
function isPhoneRemoteEnabled() {
  try {
    const saved = getDB().prepare("SELECT value FROM settings WHERE key = 'phone_remote_enabled'").get()?.value
    return saved !== '0'
  } catch { return true }
}
app.use((req, res, next) => {
  if (['/remote', '/remote.html', '/remote-manifest.json', '/remote-sw.js'].includes(req.path) && !isPhoneRemoteEnabled()) {
    return res.status(403).send('Phone Remote is disabled in Lokal Settings.')
  }
  next()
})
if (fs.existsSync(distPath)) app.use(express.static(distPath))
if (fs.existsSync(publicPath)) app.use(express.static(publicPath))

// API_KEY in .env: every /api route below needs it (see apiKey.js).
const { requireApiKey, authRoute } = require('./apiKey')
app.use('/api', requireApiKey)
app.post('/api/auth', authRoute)


app.use('/api/tracks', require('./routes/tracks'))
const artistsRouter = require('./routes/artists')
app.use('/api/artists', artistsRouter)
app.use('/api/playlists', require('./routes/playlists'))
app.use('/api/lyrics', require('./routes/lyrics'))
app.use('/api/users', require('./routes/users'))
app.use('/api/download', require('./routes/download'))
app.use('/api/artwork-fx', require('./routes/artworkFx'))
app.use('/api/settings', require('./routes/settings'))
app.use('/api/mixes', require('./routes/mixes'))
app.use('/api/albums', require('./routes/albums'))
app.use('/api/lastfm', require('./routes/lastfm'))
app.use('/api/listenbrainz', require('./routes/listenbrainz'))
app.use('/api/online', require('./routes/online'))
app.use('/api/radio', require('./routes/radio'))
app.use('/api/remote', (req, res, next) => {
  if (!isPhoneRemoteEnabled()) return res.status(403).json({ error: 'Phone remote is disabled in Lokal Settings.', disabled: true })
  next()
})
app.use('/api/remote', require('./routes/remote'))
app.use('/api/plugins', require('./routes/plugins'))
app.use('/api/recaps', require('./routes/recaps'))
app.use('/api/quality', require('./routes/quality'))

const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm' }

app.get('/api/stream/:trackId', async (req, res) => {
  const track = getDB().prepare('SELECT file_path FROM tracks WHERE id = ?').get(req.params.trackId)
  if (!track || !fs.existsSync(track.file_path)) return res.status(404).send('Not found')
  // Browsers can't decode Apple Lossless (and a few others): stream a cached
  // FLAC/AAC copy instead, made once with ffmpeg.
  let filePath = track.file_path
  try {
    const { playableCopy } = require('../electron/download/convert')
    filePath = (await playableCopy(filePath, { cacheDir: path.join(getStorageDir(), 'playback-cache') })) || filePath
  } catch {}
  const type = AUDIO_TYPES[path.extname(filePath).toLowerCase()] || 'audio/mpeg'
  const stat = fs.statSync(filePath)
  const range = req.headers.range
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-')
    const start = parseInt(s), end = e ? parseInt(e) : stat.size - 1
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
    })
    fs.createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(filePath).pipe(res)
  }
})

app.get('/api/artwork/:trackId', (req, res) => {
  const dir = path.join(getStorageDir(), 'artwork')
  const p = path.join(dir, `${req.params.trackId}.jpg`)
  if (path.dirname(p) === dir && fs.existsSync(p)) return res.sendFile(p)
  // Covers not named after the track (a download's thumbnail "t-<id>.jpg",
  // one found online, one shared from the same album): the track's own
  // artwork_path, as long as it's in the artwork folder.
  let remoteArtworkUrl = null
  try {
    const db = getDB()
    const stored = db.prepare('SELECT artwork_path, artwork_url FROM tracks WHERE id = ?').get(req.params.trackId)
    remoteArtworkUrl = stored?.artwork_url || null
    const resolved = stored?.artwork_path ? path.resolve(stored.artwork_path) : null
    const musicFolder = db.prepare("SELECT value FROM settings WHERE key = 'music_folder'").get()?.value
    const root = musicFolder ? path.resolve(musicFolder) : null
    const isWithin = (base, candidate) => {
      const relative = path.relative(base, candidate)
      return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    }
    if (resolved && fs.existsSync(resolved)) {
      const realArtwork = fs.realpathSync(resolved)
      let inCache = false
      let inMusicFolder = false
      try { inCache = isWithin(fs.realpathSync(dir), realArtwork) } catch {}
      try { inMusicFolder = !!root && isWithin(fs.realpathSync(root), realArtwork) } catch {}
      if (inCache || inMusicFolder) return res.sendFile(resolved)
    }
  } catch {}
  // Streamed tracks keep their cover as an external artwork_url rather than
  // an on-disk artwork_path. The phone remote (and other artwork consumers)
  // still requests this same endpoint, so safely redirect to that HTTPS image
  // when no local copy is available.
  const externalArtwork = httpsImageURL(remoteArtworkUrl)
  if (externalArtwork) {
    res.set('Cache-Control', 'private, max-age=300')
    return res.redirect(302, externalArtwork.href)
  }
  res.status(404).send('No artwork')
})

app.get('/api/artist-image/:artistId', (req, res) => {
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
    const p = path.join(getStorageDir(), 'artwork', `artist-${req.params.artistId}${ext}`)
    if (fs.existsSync(p)) return res.sendFile(p)
  }
  const db = getDB()
  const artist = db.prepare('SELECT id, image_path FROM artists WHERE id = ?').get(req.params.artistId)

  // Match the fallback the artists list/detail endpoints already apply (see
  // addArtistFallback in server/routes/artists.js): if the artist has no
  // dedicated image, use a top track's embedded artwork instead. Without
  // this, the client sees a truthy `image_path` for such artists (from the
  // fallback applied there) but this endpoint 404s, producing a broken
  // image instead of falling back to the generated avatar (issue #14).
  //
  // addArtistFallback only falls back when image_path is empty -- it
  // doesn't check the file still exists on disk. Clear a stale path first
  // so a deleted/moved artist image doesn't shadow perfectly good track
  // artwork underneath it.
  const artistForFallback = artist && artist.image_path && !fs.existsSync(artist.image_path)
    ? { ...artist, image_path: null }
    : artist
  const withFallback = artistForFallback ? artistsRouter.addArtistFallback(db, artistForFallback) : null
  if (withFallback?.image_path && fs.existsSync(withFallback.image_path)) {
    return res.sendFile(withFallback.image_path)
  }
  res.status(404).send('No image')
})

app.get('/api/avatar/:userId', (req, res) => {
  const p = path.join(getStorageDir(), 'avatars', `${req.params.userId}.jpg`)
  fs.existsSync(p) ? res.sendFile(p) : res.status(404).send('No avatar')
})


app.use('/api', (req, res) => res.status(404).json({ error: `API route not found: ${req.method} ${req.path}` }))

app.get('/remote', (req, res) => {
  const p = path.join(publicPath, 'remote.html')
  if (fs.existsSync(p)) return res.sendFile(p)
  return res.status(404).send('Remote UI not found')
})


app.get('*', (req, res) => {
  fs.existsSync(distPath)
    ? res.sendFile(path.join(distPath, 'index.html'))
    : res.send('Run npm run build first, or use npm run dev:web')
})

const PORT = process.env.PORT || 3421
const server = app.listen(PORT, process.env.LOKAL_HOST || '0.0.0.0', () => {
  console.log(`Lokal Music → http://localhost:${PORT}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is busy. Server is likely already running.`);
  } else {
    console.error('Server Error:', err);
  }
});
module.exports = app

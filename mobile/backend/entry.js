'use strict'
// Lokal's server, started inside the Android app's embedded Node.js.
require('./polyfills')
// ffmpeg / ffprobe as WebAssembly: before any backend module grabs child_process.
require('./tools').install()

const path = require('path')
const os = require('os')
const fs = require('fs')

let bridge = null
try { bridge = require('bridge') } catch {}

const dataRoot = (bridge && typeof bridge.getDataPath === 'function' && bridge.getDataPath())
  || process.env.LOKAL_ANDROID_DATA
  || path.join(os.tmpdir(), 'lokal-android')

process.env.LOKAL_DATA_DIR = process.env.LOKAL_DATA_DIR || path.join(dataRoot, 'data')
process.env.LOKAL_DIST_DIR = process.env.LOKAL_DIST_DIR || path.join(__dirname, 'ui')
process.env.LOKAL_PUBLIC_DIR = process.env.LOKAL_PUBLIC_DIR || path.join(__dirname, 'public')
// Only this phone may reach the server: never listen on the Wi-Fi network.
process.env.LOKAL_HOST = process.env.LOKAL_HOST || '127.0.0.1'
process.env.PORT = process.env.PORT || '3421'
process.env.LOKAL_ANDROID = '1'
if (!process.env.HOME || process.env.HOME === '/') process.env.HOME = dataRoot
try { fs.mkdirSync(process.env.LOKAL_DATA_DIR, { recursive: true }) } catch {}

// Server messages, for the app's "couldn't start" screen.
if (bridge && bridge.channel) {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      original(...args)
      try { bridge.channel.send('lokal-log', args.map(a => (a && a.stack) || (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 2000)) } catch {}
    }
  }
}

// The working directory on Android is "/"; some code builds paths from it.
try { process.chdir(dataRoot) } catch {}

// A crash anywhere must not take the whole server (and the music) down.
process.on('uncaughtException', (error) => { console.error('[lokal] uncaught:', error && error.stack || error) })
process.on('unhandledRejection', (error) => { console.error('[lokal] unhandled rejection:', error && error.stack || error) })

require('../../server/index.js')

// The desktop app watches the music folder; on a phone, files arrive while
// Lokal is closed (copied over USB, downloaded...). Catch up at each start
// with a quick incremental rescan (unchanged files are skipped).
setTimeout(async () => {
  try {
    const scanner = require('../../electron/ipc/scanner')
    for (const folder of scanner.configuredMusicFolders()) {
      try { if (!fs.statSync(folder).isDirectory()) continue } catch { continue }
      if (scanner.getScanStatus().scanning) break
      await scanner.scanFolder(folder, { saveRoot: false, watch: false })
    }
  } catch (error) { console.error('[lokal] startup rescan failed:', error && error.message) }
}, 5000)

// SpotiFLAC sync: while Lokal runs, look at the folder the SpotiFLAC app
// downloads into every half minute; when its files change, scan it (only
// the new or changed files are read). Lokal also asks for this when it comes
// back to the foreground (see the shell page).
;(() => {
  const AUDIO = /\.(mp3|flac|m4a|mp4|aac|ogg|oga|opus|wav|aiff?|wma|ape|wv|alac)$/i
  let last = null
  const signature = (dir) => {
    let count = 0, size = 0, newest = 0
    const walk = (d, depth) => {
      if (depth > 6) return
      let entries
      try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (AUDIO.test(e.name)) {
          try { const st = fs.statSync(full); count++; size += st.size; newest = Math.max(newest, st.mtimeMs) } catch {}
        }
      }
    }
    walk(dir, 0)
    return `${count}:${size}:${Math.round(newest)}`
  }
  const tick = async () => {
    try {
      const { getDB } = require('../../electron/ipc/db')
      const folder = getDB().prepare("SELECT value FROM settings WHERE key = 'spotiflac_sync_folder'").get()?.value
      if (!folder || !fs.existsSync(folder)) { last = null; return }
      const now = signature(folder)
      if (last !== null && now !== last) {
        const scanner = require('../../electron/ipc/scanner')
        if (!scanner.getScanStatus().scanning) {
          const status = await scanner.scanFolder(folder, { saveRoot: false, watch: false })
          if (status.added) console.log(`[lokal] SpotiFLAC sync: ${status.added} new track(s)`)
        } else return // try again next time
      }
      last = now
    } catch (error) { console.error('[lokal] SpotiFLAC sync failed:', error && error.message) }
  }
  setTimeout(() => { tick(); setInterval(tick, 30000) }, 15000)
})()

if (bridge && bridge.channel) {
  // Tell the app the server is up (it also polls, so this is only a speed-up).
  const http = require('http')
  const ping = (tries = 0) => {
    const req = http.get({ host: '127.0.0.1', port: Number(process.env.PORT), path: '/api/settings', timeout: 2000 }, (res) => {
      res.resume()
      try { bridge.channel.send('lokal-ready', process.env.PORT) } catch {}
    })
    req.on('error', () => { if (tries < 120) setTimeout(() => ping(tries + 1), 250) })
  }
  ping()
}

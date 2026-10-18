// The Android app's own page. It waits for Lokal's server (Node.js inside the
// app) to start, asks for access to the music on the phone, then shows the
// Lokal interface in a full-screen frame and gives it the native side:
// media notification / lock screen controls, folder picker, back button.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'
import { NodeJS } from 'capacitor-nodejs'
import { MediaSession } from '@capgo/capacitor-media-session'

const LokalNative = registerPlugin('LokalNative')
const SystemBars = registerPlugin('SystemBars')

const PORT = 3421
const ORIGIN = `http://127.0.0.1:${PORT}`
const START_TIMEOUT_MS = 90_000

const fr = /^fr\b/i.test(navigator.language || '')
const T = fr ? {
  starting: 'Démarrage…',
  firstStart: 'Premier démarrage : préparation de Lokal…',
  accessTitle: 'Accès à ta musique',
  accessText: 'Lokal lit les fichiers audio de ton téléphone (dossier Musique, carte SD…). Rien ne quitte ton appareil.',
  allow: 'Autoriser',
  later: 'Plus tard',
  deniedTitle: 'Accès refusé',
  deniedText: 'Sans cet accès, Lokal ne peut pas voir ta musique. Tu peux l\'autoriser dans les réglages de l\'app (Autorisations → Musique et audio).',
  openSettings: 'Ouvrir les réglages',
  continueAnyway: 'Continuer sans',
  failedTitle: 'Lokal n\'a pas pu démarrer',
  failedText: 'Le serveur interne ne répond pas.',
  retry: 'Réessayer',
  restart: 'Redémarrer l\'app',
} : {
  starting: 'Starting…',
  firstStart: 'First start: getting Lokal ready…',
  accessTitle: 'Access to your music',
  accessText: 'Lokal plays the audio files on your phone (Music folder, SD card…). Nothing leaves your device.',
  allow: 'Allow',
  later: 'Later',
  deniedTitle: 'Access denied',
  deniedText: 'Without it, Lokal can\'t see your music. You can allow it in the app\'s settings (Permissions → Music and audio).',
  openSettings: 'Open settings',
  continueAnyway: 'Continue without',
  failedTitle: 'Lokal couldn\'t start',
  failedText: 'The built-in server isn\'t answering.',
  retry: 'Try again',
  restart: 'Restart the app',
}

const $ = (id) => document.getElementById(id)
const frame = $('app')
const nodeLog = []

function status(text, busy = true) {
  $('status').textContent = text || ''
  $('spinner').hidden = !busy
}

/** A card with up to two buttons; resolves with 'primary' or 'secondary'. */
function card({ title, text, primary, secondary, log }) {
  $('card').hidden = false
  $('card-title').textContent = title
  $('card-text').textContent = text
  $('card-primary').textContent = primary || ''
  $('card-primary').hidden = !primary
  $('card-secondary').textContent = secondary || ''
  $('card-secondary').hidden = !secondary
  $('card-log').hidden = !log
  $('card-log').textContent = log || ''
  status('', false)
  return new Promise((resolve) => {
    $('card-primary').onclick = () => { $('card').hidden = true; resolve('primary') }
    $('card-secondary').onclick = () => { $('card').hidden = true; resolve('secondary') }
  })
}

// --------------------------------------------------------------- Node.js
let nodeReady = false
NodeJS.addListener('lokal-ready', () => { nodeReady = true }).catch?.(() => {})
NodeJS.addListener('lokal-log', (event) => {
  const line = (event?.args || []).join(' ')
  nodeLog.push(line)
  if (nodeLog.length > 80) nodeLog.shift()
}).catch?.(() => {})

async function serverUp() {
  try {
    const res = await fetch(`${ORIGIN}/api/settings`, { cache: 'no-store' })
    return res.ok
  } catch { return false }
}

async function waitForServer() {
  const started = Date.now()
  let slowShown = false
  while (Date.now() - started < START_TIMEOUT_MS) {
    if (await serverUp()) return true
    if (!slowShown && Date.now() - started > 4000) { status(T.firstStart); slowShown = true }
    await new Promise(r => setTimeout(r, nodeReady ? 100 : 300))
  }
  return false
}

// ------------------------------------------------------------ permissions
async function ensureMusicAccess() {
  let access
  try { access = await LokalNative.storageAccess() } catch { return }
  if (access.media || access.allFiles) return
  let asked = false
  try { asked = localStorage.getItem('lokal-access-asked') === '1' } catch {}
  if (!asked) {
    const choice = await card({ title: T.accessTitle, text: T.accessText, primary: T.allow, secondary: T.later })
    try { localStorage.setItem('lokal-access-asked', '1') } catch {}
    if (choice !== 'primary') return
  }
  for (;;) {
    try { access = await LokalNative.requestMediaAccess() } catch { return }
    if (access.media || access.allFiles) return
    const choice = await card({ title: T.deniedTitle, text: T.deniedText, primary: T.openSettings, secondary: T.continueAnyway })
    if (choice !== 'primary') return
    await LokalNative.openAppSettings().catch(() => {})
    // Back from the settings screen: check again.
    await new Promise((resolve) => {
      const sub = App.addListener('resume', () => { Promise.resolve(sub).then(s => s.remove()); resolve() })
    })
    access = await LokalNative.storageAccess().catch(() => ({}))
    if (access.media || access.allFiles) return
  }
}

// -------------------------------------------------- bridge with the frame
const send = (message) => frame.contentWindow?.postMessage({ lokal: 1, ...message }, ORIGIN)
const emit = (name, data) => send({ type: 'event', name, data })

const nativeMethods = {
  async pickFolder() {
    const result = await LokalNative.pickFolder()
    return result?.path || null
  },
  async openUrl(url) {
    if (!/^(https?|mailto):/i.test(url)) throw new Error('Unsupported link')
    await LokalNative.openUrl({ url })
    return true
  },
  async minimize() { await App.minimizeApp(); return true },
  async appVersion() { return (await App.getInfo()).version },
  async storageAccess() { return LokalNative.storageAccess() },
  async requestAllFilesAccess() { return LokalNative.requestAllFilesAccess() },
  async openApp(pkg) {
    if (!/^[a-z][\w.]{2,200}$/i.test(String(pkg || ''))) throw new Error('Unknown app')
    return LokalNative.openApp({ package: pkg })
  },
  async appInstalled(pkg) { return (await LokalNative.appInstalled({ package: String(pkg || '') })).installed },
  // A SpotiFLAC addon's verification page, in a window of its own.
  async addonAuth(options) {
    if (!options || typeof options.url !== 'string' || !options.url.startsWith('https://')) throw new Error('No verification page')
    return LokalNative.addonAuth({ url: options.url, callback: options.callback || null, domains: Array.isArray(options.domains) ? options.domains.map(String) : [] })
  },
}

const MEDIA_ACTIONS = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekto', 'seekbackward', 'seekforward']
let mediaReady = false
async function setUpMediaActions() {
  if (mediaReady) return
  mediaReady = true
  for (const action of MEDIA_ACTIONS) {
    try {
      await MediaSession.setActionHandler({ action }, (details) => emit('media-action', { ...(details || {}), action }))
    } catch (e) { console.warn('media action', action, e) }
  }
}

let lastState = 'none'
const media = {
  metadata(data) {
    if (!data) return MediaSession.setMetadata({ title: '', artist: '', album: '', artwork: [] })
    // Artwork comes from Lokal's server; only pass what's on it.
    const artwork = (data.artwork || []).filter(a => typeof a.src === 'string' && a.src.startsWith(ORIGIN + '/')).slice(-1)
    return MediaSession.setMetadata({ title: data.title, artist: data.artist, album: data.album, artwork })
  },
  state(value) {
    const state = ['playing', 'paused'].includes(value) ? value : 'none'
    if (state === lastState) return
    lastState = state
    return MediaSession.setPlaybackState({ playbackState: state })
  },
  position(data) {
    if (!data || !Number.isFinite(data.duration) || data.duration <= 0) return
    return MediaSession.setPositionState({ duration: data.duration, position: Math.min(data.position || 0, data.duration), playbackRate: data.playbackRate || 1 })
  },
  actions() { return setUpMediaActions() },
}

window.addEventListener('message', async (event) => {
  if (event.origin !== ORIGIN || event.source !== frame.contentWindow) return
  const m = event.data
  if (!m || m.lokal !== 1) return
  if (m.type === 'call') {
    const fn = nativeMethods[m.method]
    try {
      if (!fn) throw new Error(`Unknown method ${m.method}`)
      send({ type: 'reply', id: m.id, result: await fn(...(m.args || [])) })
    } catch (e) {
      send({ type: 'reply', id: m.id, error: e?.message || String(e) })
    }
  } else if (m.type === 'media' && media[m.op]) {
    try { await media[m.op](m.data) } catch (e) { console.warn('media', m.op, e) }
  } else if (m.type === 'theme' && typeof m.bg === 'string' && /^#[0-9a-f]{3,8}$|^rgb/i.test(m.bg)) {
    document.documentElement.style.setProperty('--bg', m.bg)
    SystemBars.setStyle({ style: m.light ? 'LIGHT' : 'DARK' }).catch(() => {})
  }
})

// Back from another app (SpotiFLAC...): pick up what it downloaded now.
App.addListener('resume', () => {
  if (frame.hidden) return
  fetch(`${ORIGIN}/api/settings/sync-folder`, { method: 'POST' }).catch(() => {})
})

App.addListener('backButton', () => {
  if (frame.hidden) { App.minimizeApp(); return }
  emit('back')
})

// --------------------------------------------------------------------- go
async function start() {
  status(T.starting)
  await ensureMusicAccess()
  status(T.starting)
  for (;;) {
    if (await waitForServer()) break
    const choice = await card({ title: T.failedTitle, text: T.failedText, primary: T.retry, secondary: T.restart, log: nodeLog.slice(-25).join('\n') })
    if (choice === 'secondary') { await LokalNative.restartApp().catch(() => location.reload()); return }
    status(T.starting)
  }
  frame.src = `${ORIGIN}/?lokal-android=1`
  frame.addEventListener('load', () => {
    frame.hidden = false
    $('screen').hidden = true
  }, { once: true })
}

if (Capacitor.isNativePlatform()) start()
else status('Open this page in the Lokal Android app.', false)

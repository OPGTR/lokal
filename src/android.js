// The interface running inside the Lokal Android app.
//
// On a phone, Lokal's server runs in the app's own Node.js and this interface
// is shown in a frame of the app's shell page (mobile/shell), which has the
// native side: media notification and lock-screen controls, the folder
// picker, storage permissions, the back button. This module talks to it with
// postMessage. Everywhere else (desktop, web mode) it does nothing.

const SHELL_ORIGINS = ['http://localhost', 'https://localhost', 'capacitor://localhost']

function detect() {
  try {
    if (window.parent === window) return false
    const params = new URLSearchParams(window.location.search)
    if (params.get('lokal-android') === '1') sessionStorage.setItem('lokal-android', '1')
    return sessionStorage.getItem('lokal-android') === '1'
  } catch { return false }
}

export const isAndroid = detect()

let seq = 0
const pending = new Map()
const listeners = new Map()

function post(message) {
  try { window.parent.postMessage({ lokal: 1, ...message }, '*') } catch {}
}

if (isAndroid) {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !SHELL_ORIGINS.includes(event.origin)) return
    const m = event.data
    if (!m || m.lokal !== 1) return
    if (m.type === 'reply' && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) reject(new Error(m.error))
      else resolve(m.result)
    } else if (m.type === 'event') {
      for (const fn of listeners.get(m.name) || []) { try { fn(m.data) } catch (e) { console.error(e) } }
    }
  })
}

/** Calls a native method of the shell; rejects outside the app. */
export function callNative(method, ...args) {
  if (!isAndroid) return Promise.reject(new Error('Not running in the Android app'))
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    post({ type: 'call', id, method, args })
  })
}

export function onNative(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set())
  listeners.get(name).add(fn)
  return () => listeners.get(name)?.delete(fn)
}

// ------------------------------------------------------------ media session
// The app's WebView shows no media notification by itself. Mirror what the
// player tells navigator.mediaSession to the shell, which drives Android's
// notification, lock screen, headset buttons and Bluetooth controls (and
// keeps the app playing in the background).
function absolute(url) {
  try { return new URL(url, window.location.href).href } catch { return url }
}

function installMediaSession() {
  const handlers = new Map()
  let metadata = null
  let playbackState = 'none'
  let lastPosition = 0

  class MediaMetadataShim {
    constructor(init = {}) {
      this.title = init.title || ''
      this.artist = init.artist || ''
      this.album = init.album || ''
      this.artwork = Array.isArray(init.artwork) ? init.artwork : []
    }
  }

  const session = {
    get metadata() { return metadata },
    set metadata(value) {
      metadata = value
      post({
        type: 'media', op: 'metadata',
        data: value ? {
          title: value.title || '', artist: value.artist || '', album: value.album || '',
          artwork: [...(value.artwork || [])].map(a => ({ src: absolute(a.src), sizes: a.sizes || '', type: a.type || '' })),
        } : null,
      })
    },
    get playbackState() { return playbackState },
    set playbackState(value) {
      playbackState = value
      post({ type: 'media', op: 'state', data: value })
    },
    setActionHandler(action, handler) {
      if (handler) handlers.set(action, handler)
      else handlers.delete(action)
      post({ type: 'media', op: 'actions', data: [...handlers.keys()] })
    },
    setPositionState(state = {}) {
      // At most a few times a second; the notification interpolates.
      const now = Date.now()
      if (now - lastPosition < 900 && state.position) return
      lastPosition = now
      post({ type: 'media', op: 'position', data: { duration: state.duration || 0, position: state.position || 0, playbackRate: state.playbackRate || 1 } })
    },
    setMicrophoneActive() {},
    setCameraActive() {},
  }

  try { window.MediaMetadata = MediaMetadataShim } catch {}
  try { Object.defineProperty(navigator, 'mediaSession', { configurable: true, get: () => session }) } catch {}

  onNative('media-action', (details) => {
    const handler = handlers.get(details?.action)
    if (handler) handler({ ...details })
  })
}

// --------------------------------------------------------------- back button
// Android's back button: close what's open (dialogs, the full-screen player,
// menus react to Escape), else go back a page, else leave the app in the
// background (the music keeps playing).
function installBackButton() {
  onNative('back', () => {
    const before = document.querySelectorAll('[role="dialog"], [aria-modal="true"], .fixed.inset-0').length
    if (before) {
      document.activeElement?.blur?.()
      const escape = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true })
      document.dispatchEvent(escape)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))
      setTimeout(() => {
        const after = document.querySelectorAll('[role="dialog"], [aria-modal="true"], .fixed.inset-0').length
        if (after < before) return
        goBack()
      }, 120)
      return
    }
    goBack()
  })
  const goBack = () => {
    if (window.location.pathname !== '/' && window.history.length > 1) window.history.back()
    else callNative('minimize').catch(() => {})
  }
}

// The app's status and navigation bars take the theme's background.
function installThemeSync() {
  let last = ''
  const report = () => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    if (!bg || bg === last) return
    last = bg
    let light = false
    const m = bg.match(/^#([0-9a-f]{6})/i)
    if (m) {
      const n = parseInt(m[1], 16)
      light = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150
    }
    post({ type: 'theme', bg, light })
  }
  new MutationObserver(report).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
  window.addEventListener('load', report)
  setTimeout(report, 1500)
}

if (isAndroid) {
  installMediaSession()
  installThemeSync()
  installBackButton()
  document.documentElement.classList.add('lokal-android')
  // A service worker would keep serving an old interface after an app update.
  try { navigator.serviceWorker?.getRegistrations?.().then(list => list.forEach(r => r.unregister())) } catch {}
  post({ type: 'hello' })
}

// SpotiFLAC addon verification (a captcha, a sign-in): the desktop app opens
// the page in a window of its own; here the app does, and hands back where it
// ended and the cookies it set.
const addonAuthListeners = new Set()
function withAddonVerification(original) {
  const verify = async (request) => {
    const info = await original({ action: 'package.authInfo', key: request.key })
    if (!info || info.error || !info.url) return info
    const result = await callNative('addonAuth', { url: info.url, callback: info.callback, domains: info.domains })
    const status = await original({ action: 'package.authComplete', key: request.key, url: result?.url || null, cookies: result?.cookies || [] })
    for (const fn of addonAuthListeners) { try { fn({ key: request.key, ...(status || {}) }) } catch {} }
    return status
  }
  return async (request) => {
    if (request && ['package.verify', 'package.verifyAndWait', 'package.openAuth'].includes(request.action)) {
      try { return await verify(request) } catch (e) { return { error: e.message } }
    }
    return original(request)
  }
}

/** Android versions of the API calls that need the phone (see api.js). */
export function androidApi(api) {
  if (!isAndroid) return api
  const addonsPackages = api.addonsPackages
  return Object.assign(api, {
    addonsPackages: withAddonVerification(addonsPackages),
    onAddonAuthChanged: (fn) => { addonAuthListeners.add(fn); return () => addonAuthListeners.delete(fn) },
    openFolder: () => callNative('pickFolder').catch(() => null),
    openExternal: (url) => callNative('openUrl', String(url || '')).catch(() => window.open(url, '_blank')),
    relaunchApp: () => Promise.resolve(window.location.reload()),
    getVersion: () => callNative('appVersion').catch(() => ''),
    storageAccess: () => callNative('storageAccess'),
    openApp: (pkg) => callNative('openApp', pkg),
    appInstalled: (pkg) => callNative('appInstalled', pkg).catch(() => false),
    requestAllFilesAccess: () => callNative('requestAllFilesAccess'),
  })
}

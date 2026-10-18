// First: on Android it sets up the media session bridge before the player.
import './android'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import RenderErrorBoundary from './RenderErrorBoundary'
import { LanguageProvider } from './i18n'
import './index.css'
import { applyTheme, THEMES } from './theme'

async function initTheme() {
  try {
    const settings = await window.electron?.getSettings() || {}
    const saved = settings.theme || 'dark'
    const customOverrides = settings.theme_overrides ? JSON.parse(settings.theme_overrides) : {}
    const baseVars = THEMES[saved]?.vars || THEMES.dark.vars
    applyTheme({ ...baseVars, ...customOverrides })
  } catch (e) {
    console.error('Failed to load theme:', e)
    applyTheme(THEMES.dark.vars)
  }
}

initTheme()

// Every weight of the app's fonts, loaded up front. The browser otherwise
// fetches a weight the first time a page uses it (e.g. on opening Settings)
// and swaps it in a few frames later, so that page's text visibly reflows.
const FONT_FACES = ['400 1em "DM Sans"', '500 1em "DM Sans"', '600 1em "DM Sans"', '400 1em "DM Mono"', '500 1em "DM Mono"']
function preloadFonts() {
  if (!document.fonts?.load) return
  for (const face of FONT_FACES) document.fonts.load(face).catch(() => {})
}
preloadFonts()
// Again once the font stylesheet itself is in (before that, no face matches).
window.addEventListener('load', preloadFonts, { once: true })

if ('serviceWorker' in navigator && import.meta.env.PROD && !document.documentElement.classList.contains('lokal-android')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(()=>{}))
}

ReactDOM.createRoot(document.getElementById('root')).render(<RenderErrorBoundary><LanguageProvider><App /></LanguageProvider></RenderErrorBoundary>)

// The phone layout: on a narrow screen (the Android app, or a phone browser
// in web mode) the sidebars give way to a bottom bar with the mini player and
// tabs, and the sidebar opens as a slide-in menu.
import { useSyncExternalStore } from 'react'
import { isAndroid } from './android'

const QUERY = '(max-width: 760px)'

function subscribe(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const list = window.matchMedia(QUERY)
  list.addEventListener?.('change', onChange)
  window.addEventListener('resize', onChange)
  return () => {
    list.removeEventListener?.('change', onChange)
    window.removeEventListener('resize', onChange)
  }
}

export function isPhoneLayout() {
  if (typeof window === 'undefined') return false
  // The app always uses it, even on a tablet held sideways: the desktop
  // layout needs a mouse.
  if (isAndroid && window.innerWidth < 1100) return true
  return !!window.matchMedia?.(QUERY).matches
}

export function usePhoneLayout() {
  return useSyncExternalStore(subscribe, isPhoneLayout, () => false)
}

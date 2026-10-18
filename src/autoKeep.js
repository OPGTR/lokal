// The Android app: a song streamed from a SpotiFLAC addon (a recommendation,
// a search result) is kept in the library once it has really started playing.
// The addon already fetched the whole file to play it, so saving it costs no
// second download (the download manager reuses the playback copy).
// Settings → Playback → "Keep the songs you stream" turns it off.
import { useEffect } from 'react'
import { usePlayerStore } from './store/player'
import { api, peekSettings } from './api'
import { isStreamed, streamRef, isAddonProvider, saveToLibrary } from './onlineTracks'
import { showToast } from './components/Toaster'

const kept = new Set()

export function keepStreamedEnabled() {
  return (peekSettings()?.keep_streamed_songs ?? '1') !== '0'
}

export function useAutoKeepStreamed(t) {
  useEffect(() => {
    if (!api.isAndroid) return undefined
    let timer = null
    let watching = null
    const check = (state) => {
      const track = state.currentTrack
      const ref = streamRef(track)
      const eligible = track && isStreamed(track) && ref && isAddonProvider(ref.provider) && keepStreamedEnabled()
      const key = eligible ? `${ref.provider}:${ref.id}` : null
      if (key !== watching) {
        clearTimeout(timer)
        watching = key
        timer = null
      }
      if (!key || kept.has(key) || timer || !state.isPlaying) return
      // Five seconds of playing: a real listen, not a skip.
      timer = setTimeout(async () => {
        const now = usePlayerStore.getState()
        const current = streamRef(now.currentTrack)
        if (!current || `${current.provider}:${current.id}` !== key || kept.has(key)) return
        kept.add(key)
        const result = await saveToLibrary(now.currentTrack).catch(error => ({ error: error.message }))
        if (result?.error) { kept.delete(key); return }
        if (!result?.alreadyInLibrary) showToast(t('“{title}” is being saved to your library.', { title: now.currentTrack.title }))
      }, 5000)
    }
    check(usePlayerStore.getState())
    const unsubscribe = usePlayerStore.subscribe(check)
    return () => { clearTimeout(timer); unsubscribe() }
  }, [t])
}

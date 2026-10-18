// The phone layout's bottom bar: the mini player (tap it for the full-screen
// player) above the tabs, and the slide-in menu holding the sidebar
// (every page, playlists, account).
import React, { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Home, Search, Library, Menu, Play, Pause, SkipForward, Heart, Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { usePlayerStore, useAppStore } from '../store/player'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { trackArtURL } from '../onlineTracks'
import { isStationTrack } from '../radio/stations'
import Sidebar from './Sidebar'
import { showToast } from './Toaster'
import { useAutoKeepStreamed } from '../autoKeep'

function MiniPlayer() {
  const { t } = useTranslation()
  const {
    currentTrack, isPlaying, isBuffering, progress, duration, togglePlay, next, toggleFullscreen, likedIds, setLiked,
  } = usePlayerStore(useShallow(s => ({
    currentTrack: s.currentTrack, isPlaying: s.isPlaying, isBuffering: s.isBuffering, progress: s.progress, duration: s.duration,
    togglePlay: s.togglePlay, next: s.next, toggleFullscreen: s.toggleFullscreen, likedIds: s.likedIds, setLiked: s.setLiked,
  })))
  const user = useAppStore(s => s.user)
  if (!currentTrack) return null
  const art = trackArtURL(currentTrack)
  const station = isStationTrack(currentTrack)
  const liked = !station && likedIds?.has?.(currentTrack.id)
  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0
  const stop = (fn) => (e) => { e.stopPropagation(); fn() }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => toggleFullscreen()}
      onKeyDown={(e) => { if (e.key === 'Enter') toggleFullscreen() }}
      aria-label={t('Now playing')}
      className="relative mx-2 mb-1.5 flex items-center gap-3 overflow-hidden rounded-xl border border-border px-2 py-2"
      style={{ backgroundColor: 'rgb(var(--surface-rgb) / 0.96)' }}
    >
      <div className="h-11 w-11 flex-shrink-0 overflow-hidden rounded-lg bg-elevated">
        {art && <img src={art} alt="" className="h-full w-full object-cover" draggable={false} />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">{currentTrack.title}</p>
        <p className="truncate text-xs text-muted">{currentTrack.artist}</p>
      </div>
      {!station && setLiked && (
        <button type="button" onClick={stop(async () => {
          const r = await api.toggleLike(currentTrack.id, user?.id, currentTrack)
          setLiked(currentTrack.id, typeof r === 'boolean' ? r : r?.liked ?? false)
        })} aria-label={t(liked ? 'Remove from Liked Songs' : 'Add to Liked Songs')}
          className={`flex h-10 w-10 items-center justify-center rounded-full ${liked ? 'text-accent' : 'text-muted'}`}>
          <Heart size={19} fill={liked ? 'currentColor' : 'none'} />
        </button>
      )}
      <button type="button" onClick={stop(togglePlay)} aria-label={t(isPlaying ? 'Pause' : 'Play')}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-base">
        {isBuffering ? <Loader2 size={18} className="animate-spin" /> : isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
      </button>
      {!station && (
        <button type="button" onClick={stop(next)} aria-label={t('Next')} className="flex h-10 w-9 items-center justify-center text-white">
          <SkipForward size={20} fill="currentColor" />
        </button>
      )}
      <div className="absolute bottom-0 left-0 h-[2px] bg-accent" style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function PhoneBar() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const loc = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)

  useAutoKeepStreamed(t)

  // Songs that arrive by themselves (the SpotiFLAC sync, the start-up
  // rescan): say so, and refresh the pages showing the library.
  useEffect(() => {
    if (!api.isAndroid) return undefined
    return api.onScanProgress((progress) => {
      if (!progress?.complete || !(progress.added > 0)) return
      window.dispatchEvent(new Event('lokal:refresh'))
      showToast(progress.added === 1 ? t('1 new song added to your library.') : t('{count} new songs added to your library.', { count: progress.added }))
    })
  }, [t])

  // Any navigation (a page picked in the menu) closes the menu.
  useEffect(() => { setMenuOpen(false) }, [loc.pathname])
  // The back button closes it (android.js sends Escape to what's open).
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const path = loc.pathname
  const tabs = [
    { icon: Home, label: 'Home', active: path === '/' || path.startsWith('/home/'), go: () => nav('/') },
    { icon: Search, label: 'Search', active: path === '/search', go: () => nav('/search') },
    { icon: Library, label: 'Library', active: path === '/library', go: () => nav('/library') },
    { icon: Menu, label: 'Menu', active: menuOpen, go: () => setMenuOpen(v => !v) },
  ]

  return (
    <>
      <div className="relative z-40 flex-shrink-0 pt-1.5" data-phone-bar style={{ backgroundColor: 'rgb(var(--surface-rgb) / 0.92)', backdropFilter: 'blur(14px)' }}>
        <MiniPlayer />
        <nav aria-label={t('Main')} className="grid grid-cols-4 border-t border-border">
          {tabs.map(({ icon: Icon, label, active, go }) => (
            <button key={label} type="button" onClick={go} aria-current={active ? 'page' : undefined}
              className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${active ? 'text-accent' : 'text-muted'}`}>
              <Icon size={21} />
              {t(label)}
            </button>
          ))}
        </nav>
      </div>
      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div key="scrim" className="fixed inset-0 z-[90] bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setMenuOpen(false)} />
            <motion.div key="drawer" role="dialog" aria-modal="true" aria-label={t('Menu')}
              className="fixed inset-y-0 left-0 z-[91] w-[82vw] max-w-[320px] shadow-2xl" style={{ backgroundColor: 'var(--bg)' }}
              initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }} transition={{ type: 'tween', duration: 0.22 }}
              drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: 0.6, right: 0 }}
              onDragEnd={(_, info) => { if (info.offset.x < -80) setMenuOpen(false) }}>
              <Sidebar drawer onClose={() => setMenuOpen(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}

// Spotify-style search in the window header: a Home button, then the search
// box with a Flow button (shuffle icon) where Spotify has Browse, then the
// Cast button (CastButton.jsx). The Flow button starts Flow with the mood and
// tuner last set on Home → Flow.
//
// - Focusing the box opens the Search page; its results follow the text live.
// - While the box is focused, past searches drop down under it: all of them
//   when it's empty, then only the closest matches as letters are typed.
// - A pasted link is offered for download on the Search page; Enter starts it.
// - Typing anywhere in the app (outside a text field, with nothing like the
//   fullscreen player or a dialog on top) starts a search; "/" or Ctrl/Cmd+K
//   just focus the box.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Clock, Home, Search as SearchIcon, Shuffle, X } from 'lucide-react'
import { useSearchStore } from '../store/search'
import { usePlayerStore, useAppStore } from '../store/player'
import { readFlowSettings, saveFlowSettings, startFlow } from '../flow/session'
import { FLOW_MOODS } from '../flow/engine'
import { MOOD_ICONS } from '../flow/moodIcons'
import ContextMenu, { useContextMenu } from './ContextMenu'
import { api } from '../api'
import { useTranslation } from '../i18n'
import {
  HISTORY_EVENT, clearRecentSearches, getRecentSearches, matchRecentSearches, removeRecentSearch, saveRecentSearch,
} from '../searchHistory'
import { asLink } from '../downloadLinks'
import CastButton from './CastButton'
import PhoneRemoteButton from './PhoneRemoteButton'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')

/** Is `el` somewhere the user types (input, textarea, select, contenteditable)? */
function isTextField(el) {
  if (!el || el === document.body) return false
  if (el.isContentEditable) return true
  return !!el.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
}

/** Is the main app what's in front (no fullscreen player, dialog, onboarding...)? */
function appInFront() {
  const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
  if (!top || !top.closest('[data-app-layout]')) return false
  return !top.closest('.fixed, [role="dialog"], [aria-modal="true"]')
}

/** The typed text with the part matching `typed` emphasised. */
function Highlighted({ text, typed }) {
  const { t } = useTranslation()
  const q = typed.trim().toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  if (at < 0) return <span className="text-text/80">{text}</span>
  return (
    <span className="text-text/60">
      {text.slice(0, at)}
      <span className="text-text font-medium">{text.slice(at, at + q.length)}</span>
      {text.slice(at + q.length)}
    </span>
  )
}

/** The header's Home button, search box, history dropdown and Flow button. */
export default function HeaderSearch({ phone = false } = {}) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const loc = useLocation()
  const query = useSearchStore(s => s.query)
  const setQuery = useSearchStore(s => s.setQuery)
  const focusSeq = useSearchStore(s => s.focusSeq)
  const requestFocus = useSearchStore(s => s.requestFocus)
  const submit = useSearchStore(s => s.submit)
  const playQueue = usePlayerStore(s => s.playQueue)
  const userId = useAppStore(s => s.user?.id)

  const inputRef = useRef(null)
  const [focused, setFocused] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [history, setHistory] = useState(getRecentSearches)
  const [active, setActive] = useState(-1)
  const [randomLoading, setRandomLoading] = useState(false)

  const onSearchPage = loc.pathname === '/search'
  const onHome = loc.pathname === '/'

  // History can change from the Search page (a result opened) or elsewhere.
  useEffect(() => {
    const refresh = () => setHistory(getRecentSearches())
    window.addEventListener(HISTORY_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener(HISTORY_EVENT, refresh); window.removeEventListener('storage', refresh) }
  }, [])

  // Leaving the Search page empties the box, like Spotify.
  useEffect(() => {
    if (!onSearchPage) { setQuery(''); setDropdownOpen(false) }
  }, [onSearchPage, setQuery])

  // Someone asked for the box (typing anywhere, "/", Ctrl+K).
  useEffect(() => {
    if (!focusSeq) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    const end = input.value.length
    try { input.setSelectionRange(end, end) } catch {}
  }, [focusSeq])

  const link = asLink(query)
  const isLink = !!link
  // No past searches under a pasted link (and links aren't kept as searches).
  const suggestions = useMemo(() => (isLink ? [] : matchRecentSearches(history, query)), [history, query, isLink])
  useEffect(() => { setActive(-1) }, [query, dropdownOpen])

  /** Go to the Search page unless already there. */
  const openSearchPage = useCallback(() => {
    if (loc.pathname !== '/search') nav('/search')
  }, [nav, loc.pathname])

  // Typing anywhere starts a search.
  useEffect(() => {
    /** Global keydown: start a search from anywhere, or focus the box for "/" and Ctrl/Cmd+K. */
    const onKey = (e) => {
      if (e.defaultPrevented || e.isComposing) return
      const altGraph = e.getModifierState?.('AltGraph')
      if ((e.key === 'k' || e.key === 'K') && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        openSearchPage()
        requestFocus()
        inputRef.current?.select()
        return
      }
      if ((e.ctrlKey || e.metaKey || e.altKey) && !altGraph) return
      if (e.key.length !== 1 || /\s/.test(e.key)) return
      if (isTextField(e.target) || isTextField(document.activeElement)) return
      if (!appInFront()) return
      e.preventDefault()
      openSearchPage()
      if (e.key === '/') { requestFocus(); return }
      const { query: current, setQuery: set } = useSearchStore.getState()
      // On the Search page it adds to what's there; elsewhere it's a new search.
      set((loc.pathname === '/search' ? current : '') + e.key)
      requestFocus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSearchPage, requestFocus, loc.pathname])

  /** Search again for a past search picked from the dropdown. */
  const pick = (entry) => {
    setQuery(entry.query)
    saveRecentSearch(entry.query)
    setDropdownOpen(false)
    openSearchPage()
  }

  /** Keys inside the box: arrows move through the history, Enter picks or saves, Escape steps back. */
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return
      e.preventDefault()
      setDropdownOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      const n = suggestions.length
      // -1 is the text box itself; wrap around through the list.
      setActive(i => { let next = i + step; if (next >= n) next = -1; if (next < -1) next = n - 1; return next })
      return
    }
    if (e.key === 'Enter') {
      if (dropdownOpen && active >= 0 && suggestions[active]) { e.preventDefault(); pick(suggestions[active]); return }
      if (isLink) { e.preventDefault(); openSearchPage(); submit(link); return }
      if (query.trim()) saveRecentSearch(query)
      setDropdownOpen(false)
      return
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (dropdownOpen && suggestions.length) setDropdownOpen(false)
      else if (query) setQuery('')
      else inputRef.current?.blur()
    }
  }

  /**
   * Start Flow with the listener's mood and tuner (a random song when Flow
   * has nothing to play); `mood` picked from the button's right-click menu
   * becomes the listener's mood.
   */
  const playRandom = async mood => {
    if (randomLoading) return
    setRandomLoading(true)
    try {
      const uid = userId || 'guest'
      const settings = readFlowSettings(uid)
      if (typeof mood === 'string') { settings.mood = mood; saveFlowSettings(uid, settings) }
      if ((await startFlow({ userId: uid, ...settings })) !== 0) return
      const track = await api.getRandomTrack()
      if (track && !track.error) playQueue([track], 0)
    } catch (error) {
      console.warn('[search] Could not pick a random song:', error)
    } finally {
      setRandomLoading(false)
    }
  }

  const showDropdown = focused && dropdownOpen && suggestions.length > 0
  const moodMenu = useContextMenu()

  return (
    <div className="flex items-center gap-1.5 min-w-0 w-full justify-center" style={{ WebkitAppRegion: 'no-drag' }}>
      {!phone && <button
        onClick={() => nav('/')}
        title={t("Home")}
        aria-label={t("Home")}
        className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors bg-elevated hover:bg-card ${onHome ? 'text-text' : 'text-muted hover:text-text'}`}
      >
        <Home size={15} strokeWidth={onHome ? 2.4 : 1.8} />
      </button>}

      <div className="relative min-w-0" style={{ flex: phone ? '1 1 auto' : '0 1 474px' }} data-tour="search">
        <div
          className={`group ${phone ? 'h-10' : 'h-7'} flex items-center rounded-full bg-elevated border transition-colors ${focused ? 'border-accent/60' : 'border-transparent hover:border-border2 hover:bg-card'}`}
          onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); inputRef.current?.focus() } }}
        >
          <SearchIcon size={15} className={`ml-3 mr-1.5 flex-shrink-0 ${focused ? 'text-text' : 'text-muted group-hover:text-text'}`} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setDropdownOpen(true); openSearchPage() }}
            onFocus={() => { setFocused(true); setDropdownOpen(true); openSearchPage() }}
            onBlur={() => { setFocused(false); setDropdownOpen(false); if (query.trim().length >= 2 && onSearchPage && !isLink) saveRecentSearch(query) }}
            onKeyDown={onKeyDown}
            placeholder={phone ? t("Songs, artists, a link…") : t("What do you want to play? Or paste a link")}
            spellCheck={false}
            aria-label={t("Search, or paste a link to download")}
            aria-expanded={showDropdown}
            aria-controls="header-search-history"
            aria-activedescendant={active >= 0 ? `header-search-history-${active}` : undefined}
            className={`flex-1 min-w-0 bg-transparent outline-none ${phone ? 'text-[16px]' : 'text-[14px]'} leading-none text-text placeholder:text-muted`}
          />
          {query && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setQuery(''); inputRef.current?.focus() }}
              title={t("Clear search")}
              aria-label={t("Clear search")}
              className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-muted hover:text-text"
            >
              <X size={14} />
            </button>
          )}
          <span className="flex-shrink-0 w-px h-4 bg-border2 mx-1" />
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => playRandom()}
            onContextMenu={event => {
              const current = readFlowSettings(userId || 'guest').mood
              moodMenu.open(event, FLOW_MOODS.map(item => ({
                label: item.label, // "Flow" first, then the moods by name
                icon: MOOD_ICONS[item.id],
                hint: item.id === current ? 'Current' : undefined,
                onSelect: () => playRandom(item.id),
              })))
            }}
            disabled={randomLoading}
            title={t("Play Flow (right-click for a mood)")}
            aria-label={t("Play Flow")}
            className="flex-shrink-0 w-7 h-7 mr-0.5 rounded-full flex items-center justify-center text-muted hover:text-text disabled:opacity-60 transition-colors"
          >
            {randomLoading
              ? <span className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              : <Shuffle size={15} />}
          </button>
        </div>
        <ContextMenu menu={moodMenu} />

        <AnimatePresence>
          {showDropdown && (
            <motion.div
              id="header-search-history"
              role="listbox"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.12 }}
              onMouseDown={(e) => e.preventDefault()}
              className="absolute top-full left-0 right-0 mt-2 bg-elevated border border-border rounded-xl shadow-2xl z-50 overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-2 border-b border-border">
                <span className="text-xs text-muted flex items-center gap-2">
                  <Clock size={11} /> {query.trim() ? 'Matching searches' : 'Recent searches'}
                </span>
                {!query.trim() && (
                  <button onClick={() => { clearRecentSearches(); setDropdownOpen(false) }} className="text-xs text-muted hover:text-text transition-colors">
                    Clear
                  </button>
                )}
              </div>
              <div className="py-1 max-h-80 overflow-y-auto">
                {suggestions.map((entry, i) => (
                  <div
                    key={entry.query}
                    id={`header-search-history-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(entry)}
                    className={`group/row flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${i === active ? 'bg-card' : ''}`}
                  >
                    <Clock size={13} className="text-muted flex-shrink-0" />
                    <span className="flex-1 min-w-0 truncate text-sm"><Highlighted text={entry.query} typed={query} /></span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeRecentSearch(entry.query) }}
                      title={t("Remove from history")}
                      aria-label={`Remove ${entry.query} from history`}
                      className="opacity-0 group-hover/row:opacity-100 w-6 h-6 rounded-full flex items-center justify-center text-muted hover:text-text"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <CastButton />
      <PhoneRemoteButton />
    </div>
  )
}

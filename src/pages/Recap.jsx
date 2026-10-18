import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { BarChart3, CalendarRange, Clock3, Disc3, ListMusic, ListPlus, Play, Plus, RefreshCw, Sparkles, Share2 } from 'lucide-react'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { useCachedState, usePageReady } from '../pageCache'
import { useAppStore, usePlayerStore } from '../store/player'
import TrackList from '../components/TrackList'
import FadeImg from '../components/FadeImg'
import { latestPeriod, listenerTimeZone, nextPeriodBoundary, periodPlace, periodQuery, recapPlaylistName, recapTree, treePeriods, markRecapOpened } from '../recapPeriods'
import { plural } from '../plural'
import { filteredGenres, fmtDate, fmtHour, fmtMinutes, trackArt } from '../recapText'
import RecapStory from '../components/RecapStory'
import { showToast } from '../components/Toaster'
import { saveAsPlaylist } from '../trackActions'
import { openShareCard, coversOf } from '../shareCard'


function Metric({ label, value, icon: Icon }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-xl border border-border bg-elevated/80 p-4">
      <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-muted">
        <Icon size={12} />
        {t(label)}
      </div>
      <div className="mt-3 text-2xl font-display text-white">{value}</div>
    </div>
  )
}

/**
 * A session's covers: four different ones as a 2x2 mosaic, else the first
 * one whole. Songs from the same album share a cover (it used to repeat),
 * and songs without one are skipped (no grey filler squares).
 */
function CoverMosaic({ tracks = [] }) {
  // Same album, same cover (each track has its own artwork URL, so they
  // can't be compared).
  const covers = []
  const seen = new Set()
  for (const track of tracks) {
    const art = trackArt(track)
    const album = track.album ? `${track.album_artist || track.artist || ''}|${track.album}`.toLowerCase() : ''
    if (!art || seen.has(album || art) || (track.artwork_path && seen.has(track.artwork_path))) continue
    seen.add(album || art)
    if (track.artwork_path) seen.add(track.artwork_path)
    covers.push(art)
    if (covers.length === 4) break
  }
  return (
    <div className="aspect-square w-full overflow-hidden rounded-lg bg-card">
      {covers.length === 4 ? (
        <div className="grid h-full w-full grid-cols-2 grid-rows-2">
          {covers.map(art => <FadeImg key={art} src={art} className="h-full w-full object-cover" />)}
        </div>
      ) : covers.length ? (
        <FadeImg src={covers[0]} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted/50"><Disc3 size={22} /></div>
      )}
    </div>
  )
}

/** A small round action button (play, save as playlist). */
function RoundAction({ onClick, label, disabled, accent, children }) {
  return (
    <button onClick={(event) => { event.stopPropagation(); onClick() }} disabled={disabled} title={label} aria-label={label}
      className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-40 ${accent ? 'border-accent/30 bg-accent/10 text-accent hover:bg-accent hover:text-base' : 'border-border bg-card text-muted hover:border-accent/40 hover:text-white'}`}>
      {children}
    </button>
  )
}

function SessionCard({ session, onPlay, onSave }) {
  const genres = filteredGenres(session.topGenres || []).slice(0, 3)
  const topArtist = session.topArtists?.[0]
  const duration = fmtMinutes(session.durationMinutes || 0)
  const hasTracks = !!session.tracks?.length

  return (
    <div className="group overflow-hidden rounded-xl border border-border bg-elevated transition-colors hover:border-accent/35">
      {/* Two cards a row from a large page on (both sidebars open included): a smaller cover mosaic until the cards get wide. */}
      <div className="grid items-start gap-4 p-4 @sm:grid-cols-[minmax(0,1fr)_8rem] @lg:grid-cols-[minmax(0,1fr)_6.5rem] @2xl:grid-cols-[minmax(0,1fr)_8rem]">
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-base font-display text-white">{session.label}</p>
              <p className="mt-1 text-xs text-muted">{fmtDate(session.start)}</p>
            </div>
            <div className="flex items-center gap-2">
              <RoundAction onClick={onSave} disabled={!hasTracks} label="Save this session as a playlist"><ListPlus size={15} /></RoundAction>
              <RoundAction onClick={onPlay} disabled={!hasTracks} label="Play this session" accent><Play size={14} fill="currentColor" /></RoundAction>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {[['Time', duration], ['Tracks', session.trackCount || 0], ['Skips', session.skippedCount || 0]].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border/70 bg-card px-3 py-2">
                <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
                <div className="mt-1 truncate text-sm text-white">{value}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {topArtist?.artist && (
              <span className="max-w-full truncate rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-[10px] text-accent">
                {topArtist.artist}
              </span>
            )}
            {genres.map(genre => (
              <span key={genre.genre} className="max-w-full truncate rounded-full border border-border bg-card px-2.5 py-1 text-[10px] text-muted">{genre.genre}</span>
            ))}
          </div>
        </div>

        <button onClick={onPlay} disabled={!hasTracks} title="Play this session" aria-label={`Play ${session.label}`}
          className="hidden transition-opacity hover:opacity-90 @sm:block">
          <CoverMosaic tracks={session.tracks} />
        </button>
      </div>
    </div>
  )
}

/**
 * Top Artists / Genres: a row plays that artist's (or genre's) songs from
 * this recap; its button saves them as a playlist.
 */
function RankedList({ title, items, nameKey, emptyText, busyKey, onPlay, onSave }) {
  const { t } = useTranslation()
  return (
    <section className="rounded-xl border border-border bg-elevated p-4">
      <h2 className="text-xs font-display uppercase tracking-widest text-muted">{t(title)}</h2>
      <div className="mt-4 space-y-2">
        {items.map((item, index) => {
          const name = item[nameKey]
          const busy = busyKey === `${nameKey}:${name}`
          return (
            <div key={name || index} className="group/row flex items-center gap-1 rounded-lg bg-card pr-1 transition-colors hover:bg-white/[0.06]">
              <button onClick={() => onPlay(name)} disabled={busy} title={`${t("Play")} ${name}`} aria-label={`${t("Play")} ${name}`}
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left disabled:opacity-60">
                <span className="w-4 flex-shrink-0 text-xs text-muted">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-white">{name}</span>
                <span className="flex-shrink-0 text-xs text-muted group-hover/row:hidden">{plural(item.plays, 'play')}</span>
                <Play size={13} fill="currentColor" className="hidden flex-shrink-0 text-accent group-hover/row:block" />
              </button>
              <button onClick={() => onSave(name)} disabled={busy} title={`${t("Save")} ${name} ${t("as a playlist")}`} aria-label={`${t("Save")} ${name} ${t("as a playlist")}`}
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">
                {busy ? <RefreshCw size={13} className="animate-spin" /> : <ListPlus size={14} />}
              </button>
            </div>
          )
        })}
        {!items.length && <p className="text-xs text-muted">{t(emptyText)}</p>}
      </div>
    </section>
  )
}

const SHORT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** One chip of the period picker. */
function PeriodChip({ active, context, dashed, onClick, onPrefetch, children, title }) {
  return (
    <button onClick={onClick} title={title} onPointerEnter={onPrefetch} onFocus={onPrefetch}
      className={`flex-shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-display uppercase tracking-wider transition-colors ${active ? 'border-accent bg-accent text-base' : context ? 'border-accent/60 bg-accent/10 text-accent' : `${dashed ? 'border-dashed' : ''} border-border bg-elevated text-muted hover:text-white`}`}>
      {children}
    </button>
  )
}

/** A row of period chips under the year row, opening and closing smoothly. */
function ChipRow({ label, contentKey, reduceMotion, children }) {
  const { t } = useTranslation()
  const ease = [0.22, 1, 0.36, 1]
  return (
    // Height only: framer draws it frame by frame. Its opacity animations
    // run on the compositor and blinked for a frame at their end, so the
    // row's fade-in is CSS (.chips-swap) and closing just folds it away.
    <motion.div
      initial={{ height: 0 }}
      animate={{ height: 'auto' }}
      exit={{ height: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease }}
      className="chips-swap overflow-hidden">
      <div className="flex items-center gap-3 pt-3">
        <span className="w-14 flex-shrink-0 text-[10px] font-display uppercase tracking-widest text-muted">{t(label)}</span>
        <div key={contentKey} className="chips-swap flex gap-2 overflow-x-auto pb-0.5">
          {children}
        </div>
      </div>
    </motion.div>
  )
}

// Which plays a recap counts: every song, the library's files, or songs only
// streamed (YouTube Music, SoundCloud, addons). Remembered on this computer.
const SOURCES_KEY = 'lokal-recap-sources'
const RECAP_SOURCES = [['all', 'All', 'Every song you played'], ['library', 'Library', 'Songs in your library (files)'], ['streamed', 'Streamed', 'Songs you only streamed (YouTube Music, SoundCloud, addons)']]
const savedSources = () => {
  try { const value = localStorage.getItem(SOURCES_KEY); return RECAP_SOURCES.some(([id]) => id === value) ? value : 'all' } catch { return 'all' }
}

// Remounted per user (and per source filter), so one user's cached recap
// never shows for another, nor one filter's for another.
export default function Recap() {
  const { user } = useAppStore()
  const [sources, setSources] = useState(savedSources)
  const changeSources = (value) => {
    setSources(value)
    try { localStorage.setItem(SOURCES_KEY, value) } catch {}
  }
  return <RecapContent key={`${user?.id || 'guest'}:${sources}`} user={user} sources={sources} onSourcesChange={changeSources} />
}

function SourcesFilter({ value, onChange }) {
  const { t } = useTranslation()
  return (
    <div role="group" aria-label={t("Songs counted")} className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card/70 p-0.5">
      {RECAP_SOURCES.map(([id, label, title]) => (
        <button key={id} type="button" aria-pressed={value === id} title={title} onClick={() => onChange(id)}
          className={`rounded-md px-2.5 py-1 !text-[11px] transition-colors ${value === id ? 'bg-accent text-base' : 'text-muted hover:text-white'}`}>
          {t(label)}
        </button>
      ))}
    </div>
  )
}

function RecapContent({ user, sources = 'all', onSourcesChange }) {
  const { t } = useTranslation()
  // Kept across visits (per user and filter): coming back shows the recap as
  // it was while the periods refresh quietly, instead of rebuilding it on screen.
  const k = `recap:${user?.id || 'guest'}${sources === 'all' ? '' : `:${sources}`}`
  // A period's recap, of the songs the filter counts.
  const recapQuery = (period) => ({ ...periodQuery(period), ...(sources === 'all' ? {} : { sources }) })
  const [tree, setTree, treeWasCached] = useCachedState(`${k}:tree`, [])
  const [navYear, setNavYear] = useCachedState(`${k}:year`, null)
  const [navMonth, setNavMonth] = useCachedState(`${k}:month`, null) // 'YYYY-MM' whose weeks are shown
  const [selectedId, setSelectedId] = useCachedState(`${k}:selected`, '')
  const [recapsById, setRecapsById] = useCachedState(`${k}:byId`, {})
  const [recap, setRecap] = useCachedState(`${k}:recap`, null)
  // The period the recap on screen belongs to (can lag the selection while
  // the next one loads), so its heading always matches its numbers.
  const [shownId, setShownId] = useCachedState(`${k}:shownId`, '')
  const [periodsError, setPeriodsError] = useState('')
  const [loading, setLoading] = useState(false)
  // The recap on screen dims only when the next one takes a moment to build.
  const [slowLoad, setSlowLoad] = useState(false)
  useEffect(() => {
    if (!loading) { setSlowLoad(false); return undefined }
    const timer = setTimeout(() => setSlowLoad(true), 180)
    return () => clearTimeout(timer)
  }, [loading])
  const reduceMotion = useReducedMotion()
  const [checkingPeriods, setCheckingPeriods] = useState(!treeWasCached)
  const [status, setStatus] = useState('')
  const [storyOpen, setStoryOpen] = useState(false)
  const playQueue = usePlayerStore(s => s.playQueue)
  // The period selected right now, for answers that arrive after a switch.
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  // Each recap load gets a number; only the latest one applies its answer.
  const recapRequestRef = useRef(0)
  const loadingRef = useRef(loading)
  loadingRef.current = loading
  // Keyboard can't reach the dimmed recap either while the next one loads.
  const recapBodyRef = useRef(null)
  useLayoutEffect(() => {
    if (recapBodyRef.current) recapBodyRef.current.inert = loading
  })

  const periods = treePeriods(tree)
  const selectedPeriod = periods.find(period => period.id === selectedId) || null
  const shownPeriod = periods.find(period => period.id === shownId) || selectedPeriod
  const yearEntry = tree.find(y => y.year === navYear) || null
  const monthEntry = yearEntry?.months.find(m => m.key === navMonth) || null
  // Shown once the periods and the selected recap are in, so the page doesn't
  // go "no recap" -> "looking..." -> chips -> "building..." -> recap on screen.
  usePageReady(!checkingPeriods && !loading && (!selectedPeriod || !!recapsById[selectedPeriod.id] || !!status))

  /** Select a period and show where it sits (its year, and its month's weeks). */
  const select = (period, currentTree = tree) => {
    if (!period) return
    const place = periodPlace(currentTree, period.id)
    setSelectedId(period.id)
    if (place) { setNavYear(place.year); setNavMonth(place.monthKey) }
  }

  // Picking a year shows the whole year when it's over, else its latest
  // month or week; picking it again (it's already the one open) shows the
  // year so far.
  const pickYear = (entry) => {
    if (entry.period) { setSelectedId(entry.period.id); setNavYear(entry.year); setNavMonth(null); return }
    if (entry.soFar && navYear === entry.year) { setSelectedId(entry.soFar.id); setNavMonth(null); return }
    const latestMonth = [...entry.months].reverse().find(m => m.period || m.weeks.length || m.soFar)
    select(latestMonth?.period || latestMonth?.weeks[latestMonth.weeks.length - 1] || latestMonth?.soFar || entry.soFar)
  }

  // Picking a month shows it; while it's going, its latest finished week,
  // then the month so far when it's picked again.
  const pickMonth = (entry) => {
    const again = navMonth === entry.key
    setNavMonth(entry.key)
    if (entry.period) setSelectedId(entry.period.id)
    else if (entry.soFar && (again || !entry.weeks.length)) setSelectedId(entry.soFar.id)
    else if (entry.weeks.length) setSelectedId(entry.weeks[entry.weeks.length - 1].id)
  }
  const wholeOf = (entry) => entry.period || entry.soFar

  // What picking a year or month would open (the same rules as above), so
  // it can be built while the pointer is on its chip.
  const yearTarget = (entry) => {
    if (entry.period) return entry.period
    if (entry.soFar && navYear === entry.year) return entry.soFar
    const latestMonth = [...entry.months].reverse().find(m => m.period || m.weeks.length || m.soFar)
    return latestMonth?.period || latestMonth?.weeks[latestMonth.weeks.length - 1] || latestMonth?.soFar || entry.soFar
  }
  const monthTarget = (entry) => {
    if (entry.period) return entry.period
    if (entry.soFar && (navMonth === entry.key || !entry.weeks.length)) return entry.soFar
    return entry.weeks[entry.weeks.length - 1]
  }
  // A recap built ahead (on hover or focus) swaps in at once when picked.
  const prefetching = useRef(new Set())
  const prefetch = (period) => {
    if (!period || recapsById[period.id] || prefetching.current.has(period.id)) return
    prefetching.current.add(period.id)
    Promise.resolve(api.getListeningRecap(user?.id || 'guest', recapQuery(period)))
      .then(result => {
        if (result && !result.error) setRecapsById(current => (current[period.id] ? current : { ...current, [period.id]: result }))
      })
      .catch(() => {})
      .finally(() => prefetching.current.delete(period.id))
  }

  // Worked out on each load, so a period that just ended shows up.
  const loadPeriodList = async () => {
    // Quietly when the chips are already on screen (only the icon spins).
    setCheckingPeriods(true)
    setStatus('')
    let days = null
    let failure = 'No answer'
    try {
      const result = await api.getListeningDays(user?.id || 'guest', { tz: listenerTimeZone(), ...(sources === 'all' ? {} : { sources }) })
      if (Array.isArray(result?.days)) days = result.days
      else failure = result?.error || failure
    } catch (e) { failure = e?.message || failure }
    // A failed request keeps the periods (and recap) already shown, and never
    // reads as "no listening data".
    if (!days) {
      if (!tree.length) setPeriodsError(failure)
      setCheckingPeriods(false)
      return
    }
    setPeriodsError('')
    // The selection now, not when the request started (it may have changed).
    const selectedId = selectedIdRef.current
    const nextTree = recapTree(days)
    const available = treePeriods(nextTree)
    // Drop the saved recaps, but keep the one on screen: it stays until the
    // refreshed one replaces it, instead of blanking into "Building recap...".
    setRecapsById(current => (selectedId && current[selectedId] && available.some(p => p.id === selectedId) ? { [selectedId]: current[selectedId] } : {}))
    setTree(nextTree)
    const latest = latestPeriod(nextTree)
    const keep = available.find(period => period.id === selectedId)
    // Nothing finished yet: the newest month (or year) so far.
    const soFar = available.find(period => period.partial && period.scope === 'month') || available.find(period => period.partial)
    select(keep || latest || soFar, nextTree)
    // Same period still selected: its recap is fetched again in the
    // background (the one on screen stays until the fresh one arrives).
    if (keep) refreshRecap(keep)
    // The sidebar's "new recap" badge is of all the listening, not one filter's.
    if (latest && sources === 'all') {
      localStorage.setItem('lokal-recap-latest-completed', latest.id)
      window.dispatchEvent(new CustomEvent('lokal:recap-periods-changed', { detail: { latestId: latest.id } }))
    }
    setCheckingPeriods(false)
  }

  /** Fetch a period's recap again without the loading state; applied only if it's still selected. */
  const refreshRecap = async (period) => {
    try {
      const result = await api.getListeningRecap(user?.id || 'guest', recapQuery(period))
      if (!result || result.error) return
      setRecapsById(current => ({ ...current, [period.id]: result }))
      // A recap "so far" has changed since: its artists' and genres' songs are read again too.
      if (period.partial) {
        for (const key of [...subjectTracksRef.current.keys()]) {
          if (key.startsWith(`${period.id}|`)) subjectTracksRef.current.delete(key)
        }
      }
      // Not over a load started since (it has the newer answer on its way).
      if (selectedIdRef.current === period.id && !loadingRef.current) { setRecap(result); setShownId(period.id) }
    } catch {}
  }

  const loadRecap = async () => {
    if (!selectedPeriod) return
    const period = selectedPeriod
    const request = ++recapRequestRef.current
    const current = () => request === recapRequestRef.current && selectedIdRef.current === period.id
    setLoading(true)
    setStatus('')
    try {
      const cached = recapsById[period.id]
      const result = cached || await api.getListeningRecap(user?.id || 'guest', recapQuery(period))
      // A newer load (another period, or this one again) takes over.
      if (!current()) return
      if (result?.error) {
        setStatus(result.error)
        setRecap(null)
      } else {
        setRecap(result)
        setShownId(period.id)
        setRecapsById(current => ({ ...current, [period.id]: result }))
      }
    } catch (e) {
      if (!current()) return
      setStatus(e.message)
      setRecap(null)
    } finally {
      if (request === recapRequestRef.current) setLoading(false)
    }
  }

  // Checked (quietly) on opening, like the other pages, and again whenever
  // it could have changed while the page stays open: a week or month ends,
  // the app comes back (a timer doesn't fire while the computer sleeps), or
  // the library changes. No Refresh button needed.
  const loadPeriodListRef = useRef(loadPeriodList)
  useLayoutEffect(() => { loadPeriodListRef.current = loadPeriodList })
  useEffect(() => {
    const check = () => loadPeriodListRef.current()
    let timer = null
    const scheduleNext = () => {
      clearTimeout(timer)
      const wait = Math.max(1000, nextPeriodBoundary().getTime() - Date.now() + 1000)
      timer = setTimeout(() => { check(); scheduleNext() }, Math.min(wait, 2 ** 31 - 1))
    }
    const onResume = () => {
      if (document.visibilityState === 'hidden') return
      check()
      scheduleNext()
    }
    check()
    scheduleNext()
    window.addEventListener('lokal:refresh', check)
    window.addEventListener('focus', onResume)
    document.addEventListener('visibilitychange', onResume)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('lokal:refresh', check)
      window.removeEventListener('focus', onResume)
      document.removeEventListener('visibilitychange', onResume)
    }
  }, [user?.id])

  useEffect(() => {
    loadRecap()
  }, [selectedId, user?.id])

  // Opened once its recap is actually on screen (shownId only follows a
  // successful load): not when it's picked, nor for one whose load failed
  // or that was left before it arrived.
  useEffect(() => {
    if (!shownId || !recap) return
    markRecapOpened(shownId, user?.id)
    window.dispatchEvent(new CustomEvent('lokal:recap-viewed', { detail: { periodId: shownId } }))
  }, [shownId, !!recap, user?.id])

  const topTracks = recap?.topTracks || []
  const replayQueue = recap?.replayQueue || topTracks
  const heroTrack = topTracks[0]
  const heroArt = trackArt(heroTrack)

  // The share card: the period's top covers, its numbers and top artists.
  const shareRecap = () => {
    if (!recap) return
    openShareCard({
      kind: 'Recap',
      title: shownPeriod?.title || t('My recap'),
      subtitle: `${fmtDate(recap.from)} – ${fmtDate(recap.to)}`,
      art: coversOf(topTracks, 4),
      // Plays (each listen of 30 s or more) and tracks (different songs), as the page shows them.
      stats: [[t('Listened'), fmtMinutes(recap.totalMinutes)], [t('Plays'), (recap.totalPlays || 0).toLocaleString()], [t('Tracks'), (recap.uniqueTracks || 0).toLocaleString()], [t('Artists'), (recap.uniqueArtists || 0).toLocaleString()]],
      list: (recap.topArtists || []).length
        ? { title: t('Top artists'), items: recap.topArtists.slice(0, 5).map(item => [item.artist, plural(item.plays, 'play')]) }
        : { title: t('Top tracks'), items: topTracks.slice(0, 5).map(track => [track.title, track.artist]) },
      fileName: `Recap ${shownPeriod?.title || ''}`,
    })
  }
  // This recap's genres, counted the same way as its top artists.
  const topGenres = filteredGenres(recap?.topGenres || [])

  /** Save `tracks` as a new playlist called `name`. Returns the name, or null. */
  const saveTracks = async (name, tracks) => {
    const playlist = await saveAsPlaylist(name, tracks, { userId: user?.id, description: `From your ${shownPeriod?.title || 'listening recap'}` }).catch(() => null)
    return playlist ? name : null
  }

  // Playlists are named after what they hold and the recap they're from
  // ("Top 50 - September 2026 - Week 3"), so ones from different recaps
  // can be told apart.
  const savePlaylist = async () => {
    // Not while another period loads: the tracks shown are still the old period's.
    if (loading || !replayQueue.length || !shownPeriod) return
    setStatus('Creating playlist...')
    const saved = await saveTracks(recapPlaylistName(`Top ${Math.min(replayQueue.length, 50)}`, shownPeriod), replayQueue.slice(0, 50))
    setStatus(saved ? `Saved ${saved}` : 'Could not create playlist')
  }

  const saveSession = async (session) => {
    if (loading) return
    // A session is one sitting: its own date says which one.
    const saved = await saveTracks(`${session.label} - ${fmtDate(session.start)}`, session.tracks)
    showToast(saved ? `Saved ${saved}` : 'Could not create playlist')
  }

  // An artist's or genre's songs in the recap on screen (fetched once each).
  const subjectTracksRef = useRef(new Map())
  const [busySubject, setBusySubject] = useState('')
  const subjectTracks = async (kind, name) => {
    const key = `${shownId}|${kind}|${name}`
    if (!subjectTracksRef.current.has(key)) {
      const result = await api.getRecapTracks(user?.id || 'guest', { ...recapQuery(shownPeriod), [kind]: name }).catch(() => null)
      if (!Array.isArray(result?.tracks)) return []
      subjectTracksRef.current.set(key, result.tracks)
    }
    return subjectTracksRef.current.get(key)
  }
  const withSubject = async (kind, name, use) => {
    if (loading || !shownPeriod || busySubject) return
    setBusySubject(`${kind}:${name}`)
    try {
      const tracks = await subjectTracks(kind, name)
      if (!tracks.length) showToast(`Couldn't load the songs for ${name}`)
      else await use(tracks)
    } finally {
      setBusySubject('')
    }
  }
  const playSubject = (kind, name) => withSubject(kind, name, (tracks) =>
    playQueue(tracks, 0, { type: 'recap', id: `${shownId}:${kind}:${name}`, name: recapPlaylistName(name, shownPeriod) }))
  const saveSubject = (kind, name) => withSubject(kind, name, async (tracks) => {
    const saved = await saveTracks(recapPlaylistName(name, shownPeriod), tracks)
    showToast(saved ? `Saved ${saved}` : 'Could not create playlist')
  })

  return (
    <div className="p-4 @md:p-6 pb-10 space-y-6 w-full max-w-6xl mx-auto">
      <div className="flex flex-col gap-4 @lg:flex-row @lg:items-end @lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-accent">
            <Sparkles size={13} />
            {t("Listening Recaps")}
            {(checkingPeriods || loading) && <RefreshCw size={11} className="animate-spin text-muted" aria-label={t("Checking for new recaps")} />}
          </div>
          <h1 className="mt-2 text-3xl font-display text-white">{t("Your listening eras")}</h1>
          <p className="mt-1 text-sm text-muted">{t("A recap for every finished week (Monday to Sunday), month and year, built from your listening sessions. Click a month or year again to see it so far.")}</p>
          <div className="mt-3"><SourcesFilter value={sources} onChange={onSourcesChange} /></div>
        </div>
        {/* One row, always: short labels that never wrap, and on a narrow
            page the icons alone (named on hover and for screen readers). */}
        <div className="flex flex-shrink-0 flex-nowrap gap-2">
          <button onClick={() => replayQueue.length && playQueue(replayQueue, 0)} disabled={loading || !replayQueue.length} title={t("Replay this era")} aria-label={t("Replay this era")} className="flex items-center gap-2 whitespace-nowrap rounded-xl bg-accent px-3 py-2 text-sm font-medium text-base transition-colors hover:bg-accent/85 disabled:opacity-50 @md:px-4">
            <Play size={14} fill="currentColor" />
            <span className="hidden @sm:inline">{t("Replay")}</span>
          </button>
          <button onClick={savePlaylist} disabled={loading || !replayQueue.length} title={t("Save as a playlist")} aria-label={t("Save as a playlist")} className="flex items-center gap-2 whitespace-nowrap rounded-xl border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/25 disabled:opacity-50 @md:px-4">
            <Plus size={14} />
            <span className="hidden @sm:inline">{t("Save as playlist")}</span>
          </button>
          <button onClick={() => setStoryOpen(true)} disabled={loading || !recap || recap.totalPlays === 0} title={t("Show the story")} aria-label={t("Show the story")} className="flex items-center gap-2 whitespace-nowrap rounded-xl border border-border bg-elevated px-3 py-2 text-sm text-white transition-colors hover:border-accent/40 disabled:opacity-50 @md:px-4">
            <Sparkles size={14} />
            <span className="hidden @sm:inline">{t("Story")}</span>
          </button>
        </div>
      </div>

      {checkingPeriods && !tree.length ? (
        <div className="rounded-xl border border-border bg-elevated p-6 text-sm text-muted">{t("Looking for finished recaps with listening data...")}</div>
      ) : periods.length > 0 ? (
        // Year, then month, then week: only periods with plays are listed.
        <div className="rounded-xl border border-border bg-elevated/60 p-4">
          <div className="flex items-center gap-3">
            <span className="w-14 flex-shrink-0 text-[10px] font-display uppercase tracking-widest text-muted">{t("Year")}</span>
            <div className="flex gap-2 overflow-x-auto pb-0.5">
              {tree.map(entry => (
                <PeriodChip key={entry.year} active={selectedId === wholeOf(entry)?.id} context={navYear === entry.year && selectedId !== wholeOf(entry)?.id} onClick={() => pickYear(entry)} onPrefetch={() => prefetch(yearTarget(entry))}
                  title={entry.period ? `The whole of ${entry.year}` : navYear === entry.year ? `${entry.year} so far` : `${entry.year} is still going: click again for the year so far`}>
                  {entry.year}
                </PeriodChip>
              ))}
            </div>
          </div>
          {/* The Month and Week rows open and close smoothly (the recap
              below glides instead of jumping), and another year's months or
              another month's weeks fade in rather than popping. */}
          <AnimatePresence initial={false}>
            {yearEntry && (
              <ChipRow key="month" label={t("Month")} contentKey={yearEntry.year} reduceMotion={reduceMotion}>
                {yearEntry.months.map(entry => (
                  <PeriodChip key={entry.key} active={selectedId === wholeOf(entry)?.id} context={navMonth === entry.key && selectedId !== wholeOf(entry)?.id}
                    dashed={!entry.period} title={entry.period ? undefined : navMonth === entry.key ? 'This month so far' : 'Still going: click again for the month so far'} onClick={() => pickMonth(entry)} onPrefetch={() => prefetch(monthTarget(entry))}>
                    {SHORT_MONTH_NAMES[entry.month - 1]}
                  </PeriodChip>
                ))}
              </ChipRow>
            )}
            {monthEntry && monthEntry.weeks.length > 0 && (
              <ChipRow key="week" label={t("Week")} contentKey={monthEntry.key} reduceMotion={reduceMotion}>
                {monthEntry.weeks.map(period => (
                  <PeriodChip key={period.id} active={selectedId === period.id} onClick={() => setSelectedId(period.id)} onPrefetch={() => prefetch(period)}>
                    {period.label}
                  </PeriodChip>
                ))}
              </ChipRow>
            )}
          </AnimatePresence>
        </div>
      ) : periodsError ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-elevated p-6 text-sm text-muted">
          Couldn't load your listening days ({periodsError}).
          <button onClick={loadPeriodList} className="rounded-lg border border-border px-3 py-1 text-xs hover:text-white">{t("Retry")}</button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-elevated p-6 text-sm text-muted">{t("No finished recap periods with listening data yet.")}</div>
      )}

      {status && <div className="rounded-xl border border-border bg-elevated px-4 py-3 text-sm text-muted">{status}</div>}

      {loading && !recap ? (
        <div className="rounded-xl border border-border bg-elevated p-10 text-center text-sm text-muted">{t("Building recap...")}</div>
      ) : !recap || recap.totalPlays === 0 ? (
        <div className="rounded-xl border border-border bg-elevated p-10 text-center">
          <Disc3 size={36} className="mx-auto text-muted/40" />
          <p className="mt-3 text-sm text-white">{t("No finished recap selected yet.")}</p>
          <p className="mt-1 text-xs text-muted">{t("Once a completed period has enough listening data, it will show up here.")}</p>
        </div>
      ) : (
        // Switching period keeps the current recap until the next is built:
        // not clickable, and dimmed only if that takes a moment (a recap
        // that's ready swaps at once). The next one then fades in (.recap-swap).
        <div ref={recapBodyRef} aria-busy={loading} className={`transition-opacity duration-300 ${loading ? 'pointer-events-none' : ''} ${slowLoad ? 'opacity-60' : ''}`}>
          <div key={shownId} className="recap-swap space-y-6">
          <section className="relative overflow-hidden rounded-xl border border-border bg-elevated">
            {heroArt && <div className="absolute inset-0 bg-cover bg-center opacity-20 blur-xl scale-110" style={{ backgroundImage: `url("${heroArt}")` }} />}
            <div className="relative grid grid-cols-[minmax(0,1fr)] gap-6 p-6 @lg:grid-cols-[minmax(0,1fr)_260px]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-muted">
                  <CalendarRange size={12} />
                  {fmtDate(recap.from)} - {fmtDate(recap.to)}
                  <button onClick={shareRecap} title={t("Share as a picture")}
                    className="ml-auto flex items-center gap-1.5 rounded-full border border-border bg-black/20 px-3 py-1 text-[10px] font-display uppercase tracking-widest text-muted transition-colors hover:border-accent/30 hover:text-white">
                    <Share2 size={11} /> {t('Share')}
                  </button>
                </div>
                <h2 className="mt-3 break-words text-3xl font-display text-white @sm:text-4xl">{shownPeriod?.title}</h2>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
                  {t('You played {tracks} ({plays}) for {duration}, with {sessions} sessions strong enough to name.', { tracks: plural(recap.uniqueTracks || 0, 'track'), plays: plural(recap.totalPlays, 'play'), duration: fmtMinutes(recap.totalMinutes), sessions: recap.sessions?.length || 0 })}
                </p>
                <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-3 @sm:grid-cols-2 @xl:grid-cols-4">
                  <Metric label={t('Minutes')} value={fmtMinutes(recap.totalMinutes)} icon={Clock3} />
                  <Metric label={t('Tracks')} value={recap.uniqueTracks || 0} icon={ListMusic} />
                  <Metric label={t('Artists')} value={recap.uniqueArtists || 0} icon={BarChart3} />
                  <Metric label={t('Peak Hour')} value={fmtHour(recap.peakHour?.hour)} icon={Clock3} />
                </div>
              </div>
              <div className="rounded-xl border border-border bg-black/20 p-4">
                <div className="aspect-square overflow-hidden rounded-lg bg-card">
                  {heroArt ? <FadeImg src={heroArt} className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-muted"><Disc3 size={32} /></div>}
                </div>
                <p className="mt-3 truncate text-sm font-medium text-white">{heroTrack?.title}</p>
                <p className="truncate text-xs text-muted">{heroTrack?.artist}</p>
              </div>
            </div>
          </section>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
            <section className="min-w-0 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-display uppercase tracking-widest text-muted">{t("Top Tracks")}</h2>
                <button onClick={() => playQueue(topTracks, 0)} className="text-xs font-display uppercase tracking-wider text-accent hover:text-accent/70">{t("Play Top 50")}</button>
              </div>
              <TrackList tracks={topTracks.slice(0, 20)} reduceMotion />
            </section>

            <aside className="min-w-0 space-y-4">
              <RankedList title={t("Top Artists")} items={(recap.topArtists || []).slice(0, 5)} nameKey="artist"
                emptyText="No artist stood out yet." busyKey={busySubject}
                onPlay={(name) => playSubject('artist', name)} onSave={(name) => saveSubject('artist', name)} />
              <RankedList title={t("Genres")} items={topGenres.slice(0, 5)} nameKey="genre"
                emptyText="No specific genre stood out yet." busyKey={busySubject}
                onPlay={(name) => playSubject('genre', name)} onSave={(name) => saveSubject('genre', name)} />
            </aside>
          </div>

          {recap.sessions?.length > 0 && (
            <section className="space-y-3">
              <div className="flex flex-col gap-1 @sm:flex-row @sm:items-end @sm:justify-between">
                <div>
                  <h2 className="text-xs font-display uppercase tracking-widest text-muted">{t("Listening Sessions")}</h2>
                  <p className="mt-1 text-sm text-muted">{t("Your strongest runs from this recap, grouped by listening shape.")}</p>
                </div>
                <span className="text-xs text-muted">{recap.sessions.length} {t("named sessions")}</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @lg:grid-cols-2">
                {recap.sessions.slice(0, 8).map((session, index) => (
                  <SessionCard
                    key={session.id || index}
                    session={session}
                    onPlay={() => session.tracks?.length && playQueue(session.tracks, 0, { type: 'recap', id: `${shownId}:session:${session.id || index}`, name: `${session.label} - ${fmtDate(session.start)}` })}
                    onSave={() => saveSession(session)}
                  />
                ))}
              </div>
            </section>
          )}
          </div>
        </div>
      )}

      <RecapStory open={storyOpen} onClose={() => setStoryOpen(false)} recap={recap} period={shownPeriod} onSavePlaylist={savePlaylist} playlistStatus={status} />
    </div>
  )
}

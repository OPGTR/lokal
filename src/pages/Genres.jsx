import React, { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Music, Play, Search, Shuffle, Tags } from 'lucide-react'
import { api } from '../api'
import { usePlayerStore } from '../store/player'
import { peekCache, writeCache, usePageReady } from '../pageCache'
import FadeImg from '../components/FadeImg'
import CoverPlay from '../components/CoverPlay'
import { plural } from '../plural'
import { useTranslation } from '../i18n'
import TrackList from '../components/TrackList'
import { isPlayable, trackArtURL } from '../onlineTracks'
import { fetchAllTrackPages, shuffledLibraryTracks } from '../libraryHelpers'

// Songs without any genre, as a genre of its own (see genreFilter in
// electron/ipc/scanner.js).
export const NO_GENRE = '__none__'

const genrePath = name => `/genre/${encodeURIComponent(name)}`
const artURL = item => (api.isElectron ? `file://${item.artwork_path}` : api.artworkURL(item.track_id))

/** Up to four covers of the genre's songs, as a square. */
function GenreCover({ artworks }) {
  if (!artworks?.length) {
    return <div className="flex h-full w-full items-center justify-center"><Tags size={34} className="text-muted" /></div>
  }
  if (artworks.length < 4) return <FadeImg src={artURL(artworks[0])} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
  return (
    <div className="grid h-full w-full grid-cols-2 grid-rows-2 transition-transform duration-300 group-hover:scale-[1.03]">
      {artworks.slice(0, 4).map(item => <FadeImg key={item.track_id} src={artURL(item)} alt="" className="h-full w-full object-cover" />)}
    </div>
  )
}

function GenreCard({ name, label, count, artworks, onOpen, onPlay }) {
  const { t } = useTranslation()
  const first = artworks?.[0]
  return (
    <motion.div initial={false} whileHover={{ y: -3 }}
      className="group overflow-hidden rounded-[1.5rem] border border-border bg-card/60 transition-colors hover:border-accent/35"
      style={{ contentVisibility: 'auto', containIntrinsicSize: '320px' }}>
      <div className="relative aspect-square overflow-hidden bg-black/20">
        <GenreCover artworks={artworks} />
        <CoverPlay label={t('Play {name}', { name: label })} onPlay={onPlay} />
      </div>
      <button type="button" onClick={onOpen} className="group/open relative block w-full overflow-hidden px-4 py-3 text-left">
        <div className="absolute inset-0 scale-110 blur-xl"
          style={{ backgroundImage: first ? `url("${artURL(first)}")` : 'none', backgroundPosition: 'center', backgroundSize: 'cover', opacity: first ? 0.18 : 0 }} />
        <div className="absolute inset-0 bg-black/35" />
        <div className="relative space-y-1">
          <p className="truncate text-sm font-medium text-white decoration-white/60 underline-offset-2 group-hover/open:underline" title={label}>{label}</p>
          <p className="text-[11px] uppercase leading-snug tracking-[0.16em] text-muted/70">{plural(count, 'track')}</p>
        </div>
      </button>
    </motion.div>
  )
}

/**
 * The Genres tab: every genre in the library as a card (a song tagged
 * "Рэп/Караоке" is in both "Рэп" and "Караоке"), plus "No genre". A card
 * opens the genre's songs, sorted and filtered like the Library tab's.
 */
export default function Genres() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const playQueue = usePlayerStore(s => s.playQueue)
  const [summary, setSummaryState] = useState(() => peekCache('genres:summary') || null)
  const [query, setQuery] = useState('')
  usePageReady(!!summary)

  useEffect(() => {
    const load = () => Promise.resolve(api.getGenreSummary())
      .then(result => {
        if (!result || result.error) return
        writeCache('genres:summary', result)
        setSummaryState(result)
      })
      .catch(() => {})
    load()
    window.addEventListener('lokal:refresh', load)
    return () => window.removeEventListener('lokal:refresh', load)
  }, [])

  const shown = useMemo(() => {
    const lower = query.trim().toLocaleLowerCase()
    const list = summary?.genres || []
    return lower ? list.filter(item => item.name.toLocaleLowerCase().includes(lower)) : list
  }, [summary, query])
  const noGenre = summary?.none || 0
  const showNoGenre = noGenre > 0 && (!query.trim() || t('No genre').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  const play = async (genre) => {
    const tracks = await Promise.resolve(api.getTracks({ genre, sort: 'added_at DESC', limit: 5000 })).catch(() => null)
    if (Array.isArray(tracks) && tracks.length) playQueue(tracks, 0)
  }

  return (
    <div className="min-h-full p-4 @md:p-6 pb-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <div className="flex flex-col gap-4 @md:flex-row @md:items-end @md:justify-between">
          <div>
            <p className="text-[11px] font-display uppercase tracking-[0.32em] text-muted">{t('Collection')}</p>
            <h1 className="mt-2 font-display text-3xl uppercase tracking-[0.14em] text-white">{t('Genres')}</h1>
            <p className="mt-3 text-sm text-muted">{summary ? t('{n} genres', { n: (summary.genres?.length || 0).toLocaleString() }) : ' '}</p>
          </div>
          <div className="relative w-full max-w-xl">
            <Search size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search genres...')}
              className="w-full rounded-2xl border border-border bg-elevated/90 pl-11 pr-4 py-3 text-sm text-white outline-none transition-colors focus:border-accent/50 placeholder:text-muted" />
          </div>
        </div>

        {summary && !shown.length && !showNoGenre && (
          <div className="py-24 text-center text-muted">
            <Tags size={48} className="mx-auto mb-4 opacity-20" />
            <p>{query.trim() ? t('No genres match your search.') : t('No genres in your library yet.')}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 @sm:grid-cols-3 @lg:grid-cols-4 @xl:grid-cols-5 @2xl:grid-cols-6">
          {shown.map(item => (
            <GenreCard key={item.name} name={item.name} label={item.name} count={item.count} artworks={item.artworks}
              onOpen={() => navigate(genrePath(item.name))} onPlay={() => play(item.name)} />
          ))}
          {showNoGenre && (
            <GenreCard name={NO_GENRE} label={t('No genre')} count={noGenre} artworks={[]}
              onOpen={() => navigate(genrePath(NO_GENRE))} onPlay={() => play(NO_GENRE)} />
          )}
        </div>
      </div>
    </div>
  )
}

/** /genre/:name -- a dedicated playlist view for one genre. */
export function GenreTracks() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { name = '' } = useParams()
  const genre = name
  const [tracks, setTracks] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const playQueue = usePlayerStore(s => s.playQueue)
  usePageReady(loaded)

  useEffect(() => {
    let live = true
    setLoaded(false)
    setLoadError(false)
    setTracks([])
    fetchAllTrackPages(options => api.getTracks(options), { genre, sort: 'added_at DESC' }, 5000)
      .then(result => {
        if (!live) return
        setTracks(Array.isArray(result) ? result : [])
        setLoaded(true)
      })
      .catch(() => {
        if (!live) return
        setTracks([])
        setLoadError(true)
        setLoaded(true)
      })
    return () => { live = false }
  }, [genre])

  const playableTracks = useMemo(() => tracks.filter(track => isPlayable(track)), [tracks])
  const title = genre === NO_GENRE ? t('No genre') : genre
  const shuffle = () => {
    if (playableTracks.length) playQueue(shuffledLibraryTracks(playableTracks), 0)
  }

  return (
    <div className="min-h-full p-4 @md:p-6 pb-10 space-y-6">
      <button type="button" onClick={() => navigate('/genres')}
        className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-white">
        <ArrowLeft size={16} />{t('Back to Genres')}
      </button>

      <div className="flex items-end gap-4">
        <div className="h-28 w-28 flex-shrink-0 overflow-hidden rounded-2xl border border-border bg-elevated shadow-xl">
          {tracks.length > 0 ? (
            tracks.length < 4 ? (
              trackArtURL(tracks[0]) ? <FadeImg src={trackArtURL(tracks[0])} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center"><Music size={36} className="text-muted" /></div>
            ) : (
              <div className="grid h-full w-full grid-cols-2 grid-rows-2">
                {tracks.slice(0, 4).map(track => (
                  trackArtURL(track)
                    ? <FadeImg key={track.id} src={trackArtURL(track)} alt="" className="h-full w-full object-cover" />
                    : <div key={track.id} className="flex items-center justify-center"><Music size={20} className="text-muted" /></div>
                ))}
              </div>
            )
          ) : <div className="flex h-full w-full items-center justify-center"><Tags size={36} className="text-muted" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs font-display uppercase tracking-widest text-muted">{t('Genre playlist')}</p>
          <h1 className="truncate font-display text-2xl text-white" title={title}>{title}</h1>
          <p className="mt-1 text-sm text-muted">{loaded ? plural(tracks.length, 'track') : t('Loading...')}</p>
        </div>
      </div>

      <TrackList
        tracks={tracks}
        showQuality
        reduceMotion
        toolbarStart={(
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => playableTracks.length && playQueue(playableTracks, 0)}
              disabled={!playableTracks.length} aria-label={t('Play All')} title={t('Play All')}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-[rgb(var(--bg-rgb))] transition-colors hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40">
              <Play size={17} fill="currentColor" className="translate-x-px" />
            </button>
            <button type="button" onClick={shuffle} disabled={!playableTracks.length}
              aria-label={t('Shuffle')} title={t('Shuffle')}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted transition-colors hover:bg-elevated hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
              <Shuffle size={17} />
            </button>
          </div>
        )}
      />

      {loaded && !tracks.length && (
        <div className="py-16 text-center text-muted">
          <Music size={40} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm">{loadError ? t('Could not load this genre. Please try again.') : t('No tracks in this genre yet.')}</p>
        </div>
      )}
    </div>
  )
}

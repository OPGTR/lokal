// An album that isn't in the library, from a streamed song's album shortcut
// (or an online artist page): its songs from the catalogue, played and
// downloaded from the playback sources. When the library does have the
// album, its own page opens instead.

import { useTranslation } from '../i18n'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Disc3, Download, ListPlus, Play, Shuffle } from 'lucide-react'
import DiscoveryImage from '../components/DiscoveryImage'
import ImageZoom from '../components/ImageZoom'
import OnlineSongList from '../components/OnlineSongList'
import RefreshButton from '../components/RefreshButton'
import { usePageReady } from '../pageCache'
import { albumCacheKey, isOnlineTrack, libraryAlbum, loadOnlineAlbumCached, mergeWithLibrary, onlineAlbumPath, peekOnline } from '../onlineBrowse'
import { api } from '../api'
import { downloadOnline, playOnline, resolveOnline } from '../onlineActions'
import { saveAsPlaylist } from '../trackActions'
import { artistPath } from '../releaseActions'
import { showToast } from '../components/Toaster'

const shuffled = list => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export default function OnlineAlbum() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const artist = params.get('artist') || ''
  const album = params.get('album') || ''
  const albumId = params.get('albumId') || ''
  // An addon's album: that addon and its album id (see onlineAlbumPath).
  const provider = params.get('source') || ''
  const sourceAlbumId = params.get('sourceAlbum') || ''
  const anchor = location.state?.anchor || null
  const artwork = location.state?.artwork || ''
  const highlightTitle = location.state?.highlightTitle || ''
  // Kept once loaded (see cachedOnline): coming back shows it at once.
  const cacheKey = albumCacheKey({ artist, album, albumId, provider, sourceAlbumId })
  const fromCache = () => {
    const hit = peekOnline(cacheKey)
    return hit ? { loading: false, tracks: hit.value.tracks, error: '', progress: '', artwork: hit.value.artwork || '', title: hit.value.title || '', artist: hit.value.artist || '', loadedAt: hit.at } : null
  }
  const [state, setState] = useState(() => fromCache() || { loading: true, tracks: [], error: '', progress: '', albumTitle: album })
  const [busy, setBusy] = useState('')
  const [reload, setReload] = useState(0)
  const request = useRef(0)

  useEffect(() => {
    const version = ++request.current
    const isCurrent = () => version === request.current
    const cached = reload ? null : fromCache()
    setState(cached || { loading: true, tracks: [], error: '', progress: '', albumTitle: album })
    ;(async () => {
      // In the library after all (downloaded since, say): its own page.
      const own = album ? await libraryAlbum({ artist, album }) : null
      if (!isCurrent()) return
      // Opened as an online album: show it whole there ("Full album online"),
      // not only the songs the library has.
      if (own) { nav('/albums', { replace: true, state: { album: own, connect: true } }); return }
      if (cached) return
      const result = await loadOnlineAlbumCached({ artist, album, albumId, artwork, provider, sourceAlbumId, anchor }, undefined, {
        isCurrent, onProgress: progress => { if (isCurrent()) setState(current => ({ ...current, progress })) },
      }, { refresh: reload > 0 })
      const resolvedAlbum = result.title || album
      const resolvedArtist = result.artist || artist
      if (provider && sourceAlbumId && resolvedAlbum) {
        const resolvedOwn = await libraryAlbum({ artist: resolvedArtist, album: resolvedAlbum })
        if (!isCurrent()) return
        if (resolvedOwn) { nav('/albums', { replace: true, state: { album: resolvedOwn, connect: true } }); return }
      }
      if (isCurrent()) setState({ loading: false, tracks: result.tracks, error: result.error || '', progress: '', artwork: result.artwork || '', title: result.title || '', artist: result.artist || '', loadedAt: Date.now() })
    })()
    return () => { request.current++ }
  }, [artist, album, albumId, provider, sourceAlbumId, reload]) // eslint-disable-line react-hooks/exhaustive-deps

  // The library's songs of this album (downloaded since the page opened, say):
  // marked "In library" in the list, played from the files; the page itself
  // stays as it is.
  const [libraryTracks, setLibraryTracks] = useState([])
  const libraryAlbumTitle = state.title || album
  const libraryAlbumArtist = state.artist || artist
  useEffect(() => {
    let current = true
    if (!libraryAlbumTitle) { setLibraryTracks([]); return () => { current = false } }
    const read = () => Promise.resolve(api.getAlbumTracks({ title: libraryAlbumTitle, album_artist: libraryAlbumArtist }))
      .then(found => { if (current) setLibraryTracks(Array.isArray(found) ? found : []) }).catch(() => {})
    read()
    window.addEventListener('lokal:refresh', read)
    return () => { current = false; window.removeEventListener('lokal:refresh', read) }
  }, [libraryAlbumArtist, libraryAlbumTitle])

  usePageReady(true)
  const merged = useMemo(() => mergeWithLibrary(state.tracks, libraryTracks), [state.tracks, libraryTracks])
  const owned = state.tracks.length ? merged.owned : 0
  // The album in order, the library's copies in their places (extras of the
  // library's aren't added here: this is the album as published).
  const tracks = owned ? merged.tracks.slice(0, state.tracks.length) : state.tracks
  const cover = state.artwork || artwork || tracks.find(track => track.artwork_url)?.artwork_url || ''
  const path = onlineAlbumPath({ artist, album, albumId, provider, sourceAlbumId })
  const displayAlbum = state.title || album || anchor?.album || anchor?.title || t('Unknown album')
  const displayArtist = state.artist || artist
  const label = `“${displayAlbum}”`
  const run = async (key, work) => {
    if (busy) return
    setBusy(key)
    try { await work() } finally { setBusy('') }
  }
  const play = (selected, list = tracks) => playOnline(list, { selected, name: displayAlbum, path })
  // With some of it in the library: only the songs it doesn't have.
  const missing = tracks.filter(isOnlineTrack)
  const download = () => run('download', () => downloadOnline(missing, { label: owned ? `${missing.length} missing songs` : label }))
  const savePlaylist = () => run('playlist', async () => {
    const rows = await resolveOnline(tracks, { label })
    if (!rows.length) return
    const playlist = await saveAsPlaylist(displayAlbum, rows, { description: `${displayAlbum} by ${displayArtist}`, coverURL: /^https:\/\//.test(cover) ? cover : undefined }).catch(() => null)
    showToast(playlist ? `Saved ${label} as a playlist.` : `Could not save ${label}.`)
  })
  const duration = useMemo(() => tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0), [tracks])
  // The cover, big (click it).
  const [zoom, setZoom] = useState(false)

  return (
    <div className="p-4 @md:p-6 pb-10">
      <button onClick={() => nav(-1)} className="mb-5 inline-flex items-center gap-2 text-xs text-muted transition-colors hover:text-white">
        <ArrowLeft size={14} /> {t('Back')}
      </button>
      <div className="mb-8 flex flex-col gap-5 @md:flex-row @md:items-end">
        <ImageZoom src={cover} alt={displayAlbum} open={zoom} onClose={() => setZoom(false)} />
        <div onClick={cover ? () => setZoom(true) : undefined} title={cover ? t('View the cover') : undefined} className={`h-44 w-44 flex-shrink-0 overflow-hidden rounded-2xl border border-border bg-elevated shadow-xl ${cover ? 'cursor-zoom-in' : ''}`}>
          <DiscoveryImage item={{ title: displayAlbum, artist: displayArtist }} type="album" src={cover} lookup={!state.loading} className="h-full w-full object-cover" fallback={<div className="flex h-full w-full items-center justify-center text-muted"><Disc3 size={52} /></div>} />
        </div>
        <div className="min-w-0">
        <p className="mb-1 text-xs font-display uppercase tracking-widest text-muted">{t("Album · Online")}</p>
          <h1 className="truncate text-3xl font-display text-white">{displayAlbum}</h1>
          <button onClick={() => nav(artistPath(displayArtist), { state: { name: displayArtist, anchor: tracks[0] ? { title: tracks[0].title, album: displayAlbum } : null } })} className="mt-1 text-sm text-muted transition-colors hover:text-accent hover:underline">{displayArtist}</button>
          {!state.loading && tracks.length > 0 && <p className="mt-1 text-xs text-subtle">{t(tracks.length === 1 ? '{count} song' : '{count} songs', { count: tracks.length })}{duration ? ` · ${t('{count} min', { count: Math.round(duration / 60) })}` : ''}{owned ? ` · ${t(owned === tracks.length ? 'All songs are in your library.' : '{owned} of {total} songs are in your library.', { owned, total: tracks.length })}` : ''}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={() => play(tracks[0])} disabled={!tracks.length} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base transition-opacity hover:opacity-90 disabled:opacity-40"><Play size={15} fill="currentColor" /> {t("Play")}</button>
            <button onClick={() => { const list = shuffled(tracks); play(list[0], list) }} disabled={!tracks.length} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-40"><Shuffle size={15} /> {t("Shuffle")}</button>
            {missing.length > 0 && <button onClick={download} disabled={!!busy} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-40"><Download size={15} /> {busy === 'download' ? t('Finding songs…') : owned ? t('Download missing ({count})', { count: missing.length }) : t('Download album')}</button>}
            <button onClick={savePlaylist} disabled={!tracks.length || !!busy} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-40"><ListPlus size={15} /> {busy === 'playlist' ? t('Saving…') : t('Save as playlist')}</button>
            <RefreshButton onClick={() => setReload(n => n + 1)} loading={state.loading} loadedAt={state.loadedAt} />
          </div>
        </div>
      </div>
      {state.loading
        ? <p role="status" className="text-sm text-muted">{state.progress ? t(state.progress) : t('Loading {album}…', { album: displayAlbum })}</p>
        : tracks.length
          ? <OnlineSongList tracks={tracks} numbered markOwned={owned > 0} highlightTitle={highlightTitle} onPlay={track => play(track)} />
          : <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-muted">{state.error ? t(state.error) : t('No songs were found for {album}.', { album: displayAlbum })}</p>}
    </div>
  )
}

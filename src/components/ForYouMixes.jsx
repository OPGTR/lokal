// "For you": daily mixes of songs you don't have yet, picked from what you
// listen to (electron/discoverMixes.js). Tap a mix's play button: its first
// song is found on your SpotiFLAC addons, downloaded and played, the rest
// follow; songs you listen to are kept in your library (see AutoKeep).
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, RefreshCw, Download, Sparkles, X, Loader2, Blocks } from 'lucide-react'
import { api } from '../api'
import { useAppStore, usePlayerStore } from '../store/player'
import { useTranslation } from '../i18n'
import { showLoadingToast } from './Toaster'
import { playRecommendationPool } from '../recommendationPlayback'
import { resolveRecommendationTracks, dispatchAddonVerificationRequired, playbackFallbackMessage } from '../recommendations'
import { saveTracksToLibrary, libraryDownloadMessage } from '../onlineTracks'

function mixTitle(t, mix) {
  if (mix.kind === 'daily') return t('Daily Mix {n}', { n: mix.index })
  if (mix.kind === 'discover') return t('Discoveries')
  return t('Popular right now')
}
function mixSubtitle(t, mix) {
  const names = (mix.artists || []).slice(0, 3)
  if (!names.length) return ''
  return t('With {names}', { names: names.join(', ') })
}

function Cover({ covers = [], className = '' }) {
  const list = covers.slice(0, 4)
  if (list.length < 4) {
    return <div className={`overflow-hidden bg-card ${className}`}>{list[0] && <img src={list[0]} alt="" loading="lazy" className="h-full w-full object-cover" />}</div>
  }
  return (
    <div className={`grid grid-cols-2 grid-rows-2 overflow-hidden bg-card ${className}`}>
      {list.map((src, i) => <img key={i} src={src} alt="" loading="lazy" className="h-full w-full object-cover" />)}
    </div>
  )
}

export default function ForYouMixes() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const user = useAppStore(s => s.user)
  const uid = user?.id || 'guest'
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(null)
  const [sources, setSources] = useState(null) // addons that can play, or null while unknown
  const [busy, setBusy] = useState(null)

  const load = async (force = false) => {
    setLoading(true)
    try {
      const result = await api.getDiscoverMixes(uid, force)
      setData(result)
    } finally { setLoading(false) }
  }
  useEffect(() => { load(false) }, [uid])
  useEffect(() => {
    Promise.resolve(api.onlineProviders?.()).then(list => setSources((Array.isArray(list) ? list : []).filter(p => p.addon && p.package && !p.needsSetup)))
      .catch(() => setSources([]))
  }, [])

  // With the Deezer addon, a recommended song (from Deezer's catalogue) is
  // that very song: no search, no wrong match. Other addons search for it.
  const deezerAddon = (sources || []).find(p => p.addonId === 'deezer' || /^deezer$/i.test(p.label || ''))
  const candidates = tracks => tracks.map(track => deezerAddon && track.deezer_id
    ? { ...track, exact: true, provider: deezerAddon.id, id: `deezer:${track.deezer_id}` }
    : track)

  const play = async (mix, selected = null) => {
    const title = mixTitle(t, mix)
    const version = usePlayerStore.getState().playbackGeneration
    const toast = showLoadingToast(t('Finding “{title}”…', { title: selected?.title || title }))
    setBusy(mix.id)
    try {
      const started = await playRecommendationPool(candidates(mix.tracks), {
        selected: selected || mix.tracks[0],
        firstPlayable: true,
        context: { type: 'mix', name: title },
        isCurrent: () => usePlayerStore.getState().playbackGeneration >= version,
        onProgress: message => toast.update(message),
        onProviderFailure: failure => toast.update(playbackFallbackMessage(failure)),
      })
      toast.close(started === false ? t('None of these songs could be found on your addons.') : '')
    } catch (error) {
      toast.close(error?.message || t('Could not play this mix.'))
    } finally { setBusy(null) }
  }

  const downloadAll = async (mix) => {
    const toast = showLoadingToast(t('Finding the songs of {title}…', { title: mixTitle(t, mix) }))
    try {
      const tracks = await resolveRecommendationTracks(candidates(mix.tracks), api, {
        prepareStreams: false,
        onProgress: message => toast.update(message),
        onAddonVerificationRequired: error => dispatchAddonVerificationRequired(error, () => downloadAll(mix)),
      })
      if (!tracks.length) { toast.close(t('None of these songs could be found on your addons.')); return }
      const result = await saveTracksToLibrary(tracks, { onProgress: message => toast.update(message) })
      result.failed += mix.tracks.length - tracks.length
      toast.close(libraryDownloadMessage(result))
    } catch (error) { toast.close(error?.message || '') }
  }

  const mixes = data?.mixes || []
  if (!loading && !mixes.length && !data?.error) return null

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Sparkles size={14} className="text-accent" />
        <h2 className="text-xs font-display uppercase tracking-widest text-muted">{t('For you')}</h2>
        <button type="button" onClick={() => load(true)} disabled={loading} aria-label={t('Refresh')}
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-muted hover:text-white disabled:opacity-50">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {data?.basedOn?.length > 0 && <p className="-mt-2 mb-3 text-xs text-muted">{t('Based on {names}', { names: data.basedOn.slice(0, 3).join(', ') })}</p>}
      {sources && !sources.length && (
        <button type="button" onClick={() => nav('/settings', { state: { category: 'addons' } })}
          className="mb-3 flex w-full items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 p-3 text-left">
          <Blocks size={18} className="flex-shrink-0 text-accent" />
          <span className="text-xs text-white">{t('To listen to and download these songs, install a SpotiFLAC addon (Deezer, Qobuz, Tidal…) in Settings → Addons.')}</span>
        </button>
      )}
      {data?.error && !mixes.length && <p className="text-xs text-muted">{t('Recommendations need an Internet connection.')}</p>}
      {loading && !mixes.length && (
        <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
          {[0, 1, 2, 3].map(i => <div key={i} className="aspect-square animate-pulse rounded-xl bg-elevated" />)}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {mixes.map(mix => (
          <div key={mix.id} className="min-w-0">
            <button type="button" onClick={() => setOpen(mix)} className="relative block w-full text-left">
              <Cover covers={mix.covers} className="aspect-square w-full rounded-xl" />
              <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 rounded-b-xl bg-gradient-to-t from-black/70 to-transparent" />
              <span className="absolute bottom-2 left-2 right-14 truncate text-sm font-semibold text-white drop-shadow">{mixTitle(t, mix)}</span>
            </button>
            <div className="relative">
              <button type="button" onClick={() => play(mix)} aria-label={t('Play {title}', { title: mixTitle(t, mix) })}
                className="absolute -top-14 right-2 flex h-11 w-11 items-center justify-center rounded-full bg-accent text-base shadow-lg active:scale-95">
                {busy === mix.id ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
              </button>
            </div>
            <p className="mt-1.5 line-clamp-2 text-xs text-muted">{mixSubtitle(t, mix)}</p>
          </div>
        ))}
      </div>

      {open && (
        <div className="fixed inset-0 z-[120] flex flex-col justify-end bg-black/70" role="dialog" aria-modal="true" onClick={() => setOpen(null)}>
          <div className="flex max-h-[88%] flex-col rounded-t-2xl border-t border-border" style={{ backgroundColor: 'var(--bg)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 p-4">
              <Cover covers={open.covers} className="h-16 w-16 flex-shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-white">{mixTitle(t, open)}</p>
                <p className="truncate text-xs text-muted">{mixSubtitle(t, open)}</p>
              </div>
              <button type="button" onClick={() => setOpen(null)} aria-label={t('Close')} className="flex h-10 w-10 items-center justify-center rounded-full text-muted"><X size={20} /></button>
            </div>
            <div className="flex gap-2 px-4 pb-3">
              <button type="button" onClick={() => { play(open); setOpen(null) }} className="flex flex-1 items-center justify-center gap-2 rounded-full bg-accent py-2.5 text-sm font-medium text-base">
                <Play size={16} fill="currentColor" /> {t('Play')}
              </button>
              <button type="button" onClick={() => downloadAll(open)} className="flex flex-1 items-center justify-center gap-2 rounded-full border border-border py-2.5 text-sm text-white">
                <Download size={16} /> {t('Download all')}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-6">
              {open.tracks.map((track, i) => (
                <button key={`${track.artist}-${track.title}-${i}`} type="button" onClick={() => { play(open, track); setOpen(null) }}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-elevated">
                  <img src={track.artwork_url} alt="" loading="lazy" className="h-11 w-11 flex-shrink-0 rounded-md bg-card object-cover" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-white">{track.title}</span>
                    <span className="block truncate text-xs text-muted">{track.artist}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

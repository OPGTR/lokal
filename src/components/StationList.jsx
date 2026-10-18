// Online radio: the catalogue's stations, one row each, like a song list.
// Always in the catalogue's order (no sorting, filtering or dragging). Its
// columns are set up like a song list's, but saved apart (src/radio/stationColumns.js).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ExternalLink, Link2, Loader2, Pause, Play, Radio, RefreshCw } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { usePlayerStore, useAppStore } from '../store/player'
import { useRadioStore } from '../store/radio'
import { useStationColumnsStore } from '../store/stationColumns'
import { RADIO_CONTEXT, stationTrack } from '../radio/stations'
import { MAX_FIXED_WIDTH } from '../trackColumns'
import { usePhoneLayout } from '../phoneLayout'
import { STATION_ALWAYS_SHOWN, STATION_COLUMN_DEFS, STATION_OTHER_OPTIONS, stationColumnLayout, stationColumnPreferences } from '../radio/stationColumns'
import { useAppearanceFlag, useAppearanceValue } from '../appearanceFlags'
import { useTranslation } from '../i18n'
import { api } from '../api'
import TrackColumnPicker from './TrackColumnPicker'
import ContextMenu, { useContextMenu } from './ContextMenu'
import { showToast } from './Toaster'
import { CatalogErrorModal } from './RadioCatalogSetup'

// Once per launch, the list opens scrolled to the station that was playing.
let revealedAtLaunch = false

const isLink = value => /^https?:\/\/\S+$/i.test(String(value || '').trim())

const STATION_POLL_MS = 30000

export default function StationList({ catalog, configUrl = '', toolbarStart = null, stickyBleed = '0.5rem' }) {
  const { t } = useTranslation()
  const stations = catalog?.stations || []
  const { currentTrack, isPlaying, isBuffering, playTrack, togglePlay } = usePlayerStore(useShallow(({ currentTrack, isPlaying, isBuffering, playTrack, togglePlay }) => ({ currentTrack, isPlaying, isBuffering, playTrack, togglePlay })))
  const streamInfo = useRadioStore(s => s.streamInfo)
  const songsByStation = useRadioStore(s => s.nowPlaying)
  // Every station that has an API shows its song, not only the one playing:
  // asked when the list opens and every STATION_POLL_MS while it's open.
  const withApi = stations.filter(station => station.api).map(station => `${station.id}`).join('|')
  useEffect(() => {
    if (!withApi) return undefined
    let live = true
    const refresh = () => {
      for (const station of stations) {
        if (!station.api || !api.radioNowPlaying) continue
        Promise.resolve(api.radioNowPlaying(station.api)).then(info => {
          if (live && info?.title) useRadioStore.getState().setNowPlaying(station.id, { artist: info.artist || '', title: info.title, ...(info.cover ? { cover: info.cover } : {}) })
        }).catch(() => {})
      }
    }
    refresh()
    const timer = setInterval(refresh, STATION_POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [withApi]) // eslint-disable-line react-hooks/exhaustive-deps
  const catalogUrl = useRadioStore(s => s.url)
  const catalogLoading = useRadioStore(s => s.loading)
  const loadCatalog = useRadioStore(s => s.loadCatalog)
  const [catalogErrors, setCatalogErrors] = useState(null)
  // Same as Settings > Online Radio > Update: download the catalogue again.
  const updateCatalog = async () => {
    const result = await loadCatalog(catalogUrl)
    if (result?.ok) showToast(t('Loaded: {n} station|Loaded: {n} stations', { n: result.catalog?.stations?.length || 0 }))
    else setCatalogErrors(result?.errors?.length ? result.errors : [{ path: '', code: 'network' }])
  }
  const { user } = useAppStore()
  const profile = String(user?.id || 'guest')
  const phone = usePhoneLayout()
  const saved = useStationColumnsStore(s => s.profiles[profile])
  const setColumn = useStationColumnsStore(s => s.setColumn)
  const resetColumns = useStationColumnsStore(s => s.resetColumns)
  const columns = stationColumnPreferences(saved)
  const glass = useAppearanceFlag('glass_player_bar')
  const glassTransparency = Math.max(0, Math.min(90, useAppearanceValue('player_bar_glass_transparency', 40)))
  const menu = useContextMenu()

  const listRef = useRef(null)
  const [listWidth, setListWidth] = useState(0)
  useLayoutEffect(() => {
    const node = listRef.current
    const measure = () => setListWidth(node.clientWidth / (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const layout = stationColumnLayout(listWidth, columns)

  // At launch the playing station sits in the middle of the screen, as a
  // folder's playing song does (Library.jsx).
  const currentId = currentTrack?.id ?? null
  useEffect(() => {
    if (revealedAtLaunch || currentId == null || !stations.length) return
    revealedAtLaunch = true
    const index = stations.findIndex(station => station.id === currentId)
    if (index < 0) return
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelectorAll('[data-station-row]')[index]
      try { row?.scrollIntoView({ behavior: 'auto', block: 'center' }) } catch { row?.scrollIntoView() }
    })
  }, [currentId, stations])
  const rowPadding = `${columns.rowGap}rem`

  const queue = () => stations.map(station => stationTrack(station, catalog?.title || ''))
  const play = (station, event) => {
    event?.stopPropagation()
    if (currentTrack?.id === station.id) { togglePlay(); return }
    const list = queue()
    playTrack(list.find(item => item.id === station.id), list, { type: RADIO_CONTEXT, name: catalog?.title || t('Online Radio') })
  }
  const copyLink = (station) => {
    if (!navigator.clipboard?.writeText) { showToast(t('Could not copy to the clipboard')); return }
    Promise.resolve(navigator.clipboard.writeText(station.url))
      .then(() => showToast(t('Copied: {text}', { text: station.url })))
      .catch(() => showToast(t('Could not copy to the clipboard')))
  }
  const openMenu = (event, station) => menu.open(event, [
    { label: t(currentTrack?.id === station.id && isPlaying ? 'Pause' : 'Play'), icon: currentTrack?.id === station.id && isPlaying ? Pause : Play, onSelect: () => play(station) },
    { label: t('Copy stream link'), icon: Link2, onSelect: () => copyLink(station) },
    ...(isLink(station.history) ? [{ label: t('Open station history'), icon: ExternalLink, onSelect: () => api.openExternal(station.history.trim()) }] : []),
  ])

  // Dragging a header edge: a fixed column takes the new width in rem; a flex
  // one takes room from the other flex columns (saved as shares).
  const setWidths = widths => setColumn(profile, 'widths', widths)
  const resetColumnWidth = key => {
    const { [key]: _, ...rest } = columns.widths
    setWidths(rest)
  }
  const startColumnResize = (key, event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const header = event.currentTarget.closest('[data-station-header]')
    const cells = Object.fromEntries([...header.querySelectorAll('[data-col]')].map(el => [el.dataset.col, el.getBoundingClientRect().width]))
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const startX = event.clientX
    const def = STATION_COLUMN_DEFS[key]
    const flexKeys = layout.order.filter(k => STATION_COLUMN_DEFS[k]?.flex)
    const move = e => {
      const dx = e.clientX - startX
      if (!def?.flex) {
        setWidths({ ...columns.widths, [key]: Math.round(Math.min(MAX_FIXED_WIDTH, Math.max(def?.min || 2, (cells[key] + dx) / rem)) * 100) / 100 })
        return
      }
      const others = flexKeys.filter(k => k !== key)
      if (!others.length) return
      const total = flexKeys.reduce((sum, k) => sum + cells[k], 0)
      const othersStart = total - cells[key]
      const othersMin = others.reduce((sum, k) => sum + STATION_COLUMN_DEFS[k].min * rem, 0)
      const size = Math.min(total - othersMin, Math.max(def.min * rem, cells[key] + dx))
      const scale = (total - size) / othersStart
      const next = { ...columns.widths, [key]: Math.round(size) }
      for (const k of others) next[k] = Math.round(cells[k] * scale)
      setWidths(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const headerLabel = key => ({
    number: <span className="text-center">#</span>,
    title: <span>{t('Station')}</span>,
    genre: <span className="truncate tracking-normal">{t('Genre')}</span>,
    comment: <span className="truncate tracking-normal">{t('Comment')}</span>,
    history: <span className="truncate tracking-normal">{t('History')}</span>,
    nowPlaying: <span className="truncate tracking-normal">{t('Now playing')}</span>,
    stream: <span className="truncate text-right tracking-normal">{t('Stream')}</span>,
  })[key] || null

  return (
    <div ref={listRef} className="w-full min-w-0" style={{ '--st-columns': layout.template }}>
      <div className={`sticky top-0 z-20 pt-5 pb-1 ${glass ? 'backdrop-blur-lg backdrop-saturate-150' : ''}`}
        style={{ marginInline: `calc(-1 * ${stickyBleed})`, paddingInline: stickyBleed, backgroundColor: glass ? `rgb(var(--surface-rgb) / ${(1 - glassTransparency / 100).toFixed(2)})` : 'rgb(var(--surface-rgb))' }}>
        <div className="mb-1 flex items-center justify-between gap-3 px-2">
          {toolbarStart || <span />}
          <div className="flex items-center gap-1">
            {catalogUrl && (
              <button type="button" disabled={catalogLoading} onClick={updateCatalog} title={t('Download the catalogue again')}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-elevated hover:text-text disabled:opacity-50 focus-visible:outline focus-visible:outline-accent">
                {catalogLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {t('Update')}
              </button>
            )}
            {configUrl && (
              <button type="button" onClick={() => api.openExternal(configUrl)} title={configUrl}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-elevated hover:text-text focus-visible:outline focus-visible:outline-accent">
                <ExternalLink size={14} /> {t('Open config')}
              </button>
            )}
            {!phone && <TrackColumnPicker columns={columns}
              onChange={(key, value) => setColumn(profile, key, value)} onReset={() => resetColumns(profile)}
              defs={STATION_COLUMN_DEFS} alwaysShown={STATION_ALWAYS_SHOWN} otherOptions={STATION_OTHER_OPTIONS}
              buttonLabel="Edit station list columns" panelLabel="Station list columns" heading="Show in the station list"
              note="Saved for the station list in this profile. Drag a column's edge in the header to resize it. Stations keep the catalogue's order." />}
          </div>
        </div>
        <div data-station-header className={`${phone ? 'hidden' : ''} grid grid-cols-[var(--st-columns)] items-center gap-2 pl-1 pr-4 py-1.5 text-xs text-muted uppercase tracking-widest border-b border-border font-display mb-0.5`}>
          {layout.order.map(key => (
            <div key={key} data-col={key} className="relative grid min-w-0 items-center">
              {headerLabel(key)}
              <span aria-hidden="true" title={t('Drag to resize')} onPointerDown={e => startColumnResize(key, e)}
                onDoubleClick={e => { e.stopPropagation(); resetColumnWidth(key) }} onClick={e => e.stopPropagation()}
                className="absolute -right-[7px] inset-y-[-4px] z-10 w-2.5 cursor-col-resize" />
            </div>
          ))}
        </div>
      </div>

      <div role="list">
        {stations.map((station, index) => {
          const isCurrent = currentTrack?.id === station.id
          const playingHere = isCurrent && isPlaying
          const info = streamInfo[station.id]
          const listed = songsByStation[station.id]
          const song = isCurrent && currentTrack.song_key ? [currentTrack.artist, currentTrack.title].filter(Boolean).join(' - ') : [listed?.artist, listed?.title].filter(Boolean).join(' - ')
          const playButton = (
            <button onClick={e => play(station, e)} aria-label={t(playingHere ? 'Pause {title}' : 'Play {title}', { title: station.title })}
              className={isCurrent ? 'text-accent' : 'text-white'}>
              {playingHere ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="translate-x-px" />}
            </button>
          )
          return (
            <div key={station.id} role="listitem" data-track-row data-station-row tabIndex={0}
              onClick={e => play(station, e)}
              onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) play(station, e) }}
              onContextMenu={e => openMenu(e, station)}
              style={{ paddingBlock: rowPadding, '--tl-row-scale': columns.rowSize }}
              className={`relative grid grid-cols-[var(--st-columns)] gap-2 pl-1 pr-4 rounded-lg items-center cursor-default group transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${isCurrent ? 'bg-accent/8' : 'hover:bg-elevated'}`}>
              {layout.order.map(key => {
                switch (key) {
                  case 'number': return (
                    <div key={key} className="flex items-center justify-center h-7 text-xs text-muted font-display">
                      <span className={`group-hover:hidden ${isCurrent ? 'text-accent' : ''}`}>
                        {isCurrent && isBuffering && isPlaying ? <Loader2 size={13} className="animate-spin" /> : index + 1}
                      </span>
                      <span className="hidden group-hover:inline-flex">{playButton}</span>
                    </div>
                  )
                  case 'title': return (
                    <div key={key} className="min-w-0 flex items-center gap-2.5">
                      {columns.artwork && (
                        <div className="rounded flex-shrink-0 overflow-hidden bg-card relative" style={{ width: '2rem', height: '2rem' }}>
                          {station.icon
                            ? <img src={station.icon} className="w-full h-full object-cover" alt="" loading="lazy" decoding="async" />
                            : <div className="w-full h-full flex items-center justify-center text-muted"><Radio size={12} /></div>}
                          {!layout.number && (
                            <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">{playButton}</span>
                          )}
                        </div>
                      )}
                      {!columns.artwork && !layout.number && <span className="shrink-0">{playButton}</span>}
                      <div className="min-w-0 flex-1">
                        <p title={station.title} className={`min-w-0 text-sm font-medium truncate ${isCurrent ? 'text-accent' : 'text-white'}`}>{station.title}</p>
                        {/* What doesn't fit in its own column goes under the name: the song, or the genre. */}
                        {(() => {
                          const under = !layout.nowPlaying && song ? song : !layout.genre ? (station.genre || '') : ''
                          return under ? <p className="truncate text-xs text-muted leading-4 h-4" title={under}>{under}</p> : null
                        })()}
                      </div>
                    </div>
                  )
                  case 'genre': return <p key={key} className="truncate text-xs text-muted" title={station.genre || undefined}>{station.genre || ''}</p>
                  case 'comment': return isLink(station.description)
                    ? <button key={key} type="button" onClick={e => { e.stopPropagation(); api.openExternal(station.description.trim()) }}
                        title={station.description} className="min-w-0 truncate text-left text-xs text-muted hover:text-accent hover:underline">{station.description}</button>
                    : <p key={key} className="truncate text-xs text-muted" title={station.description || undefined}>{station.description || ''}</p>
                  case 'history': return isLink(station.history)
                    ? <button key={key} type="button" onClick={e => { e.stopPropagation(); api.openExternal(station.history.trim()) }}
                        title={station.history} className="min-w-0 truncate text-left text-xs text-muted hover:text-accent hover:underline">{t('History')}</button>
                    : <p key={key} className="truncate text-xs text-muted" title={station.history || undefined}>{station.history || ''}</p>
                  case 'nowPlaying': return <p key={key} className={`truncate text-xs ${isCurrent ? 'text-text' : 'text-muted'}`} title={song || undefined}>{song}</p>
                  case 'stream': return (
                    <span key={key} className="truncate text-right text-xs text-muted font-display">
                      {[info?.codec, info?.bitrate ? `${info.bitrate} kbps` : ''].filter(Boolean).join(' · ')}
                    </span>
                  )
                  default: return null
                }
              })}
            </div>
          )
        })}
      </div>
      <ContextMenu menu={menu} />
      <CatalogErrorModal errors={catalogErrors} onClose={() => setCatalogErrors(null)} />
    </div>
  )
}

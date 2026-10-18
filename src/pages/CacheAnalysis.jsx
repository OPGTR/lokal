// Cache Analysis: what takes space in the app's folder (%APPDATA%\lokal-music)
// -- the library database and its tables, covers, Lokal's caches, tools,
// Chromium's caches, sign-in sessions, logs and app state. Counted on open;
// Refresh counts again. See electron/cacheAnalysis.js.

import React, { useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, HardDrive, Loader2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { api } from '../api'
import Modal from '../components/Modal'
import { useTranslation } from '../i18n'
import { usePageReady } from '../pageCache'

const percent = (n, total) => (total ? `${((n / total) * 100).toFixed(2)}%` : '—')

const SECTIONS = {
  artwork: { label: 'Covers & artist images', desc: 'Pictures saved from your files and downloaded for artists and playlists.', color: '#60a5fa' },
  browserCache: { label: 'Web engine cache', desc: 'Images, pages and shaders the built-in browser engine keeps. Safe to clear.', color: '#f59e0b' },
  lokalCache: { label: "Lokal's caches", desc: 'Motion covers, converted copies and videos. Everything here can be made again.', color: '#a78bfa' },
  database: { label: 'Library database', desc: 'Your library, playlists, play history, search index and saved lyrics.', color: '#34d399' },
  tools: { label: 'Tools', desc: 'Programs Lokal downloads to work (yt-dlp and others).', color: '#f472b6' },
  sessions: { label: 'Sign-in sessions', desc: 'Separate browser profiles for YouTube Music sign-in and verification.', color: '#22d3ee' },
  logs: { label: 'Logs', desc: 'Diagnostic logs.', color: '#94a3b8' },
  appState: { label: 'Settings & app state', desc: 'Window state, preferences and local storage.', color: '#fb923c' },
  userFiles: { label: 'Lyrics files, avatars & plugins', desc: 'Files you added to Lokal.', color: '#facc15' },
  other: { label: 'Other', desc: 'Anything else in the folder.', color: '#64748b' },
}

const ITEMS = {
  dbMain: 'Database file', dbWal: 'Write-ahead log (WAL)', dbShm: 'Shared memory index (SHM)', dbJournal: 'Rollback journal',
  trackCovers: 'Track covers', artistImages: 'Artist images', playlistCovers: 'Playlist covers', otherArtwork: 'Other images',
  motionCovers: 'Motion covers (video)', playbackCache: 'Playback copies (converted files)', musicVideoCache: 'Music video cache',
  castCache: 'Cast copies', addonCache: 'Addon audio cache', musicVideoIndex: 'Music video index',
  lyricsFiles: 'Lyrics files', avatars: 'Avatars', plugins: 'Plugins', youtubeCookies: 'YouTube cookies',
  ghostTracks: 'Online tracks (ghost)', ytMusicSession: 'YouTube Music sign-in', youtubeAttest: 'YouTube verification', webSession: 'Web session',
}

// What Chromium's own folders hold, shown next to their names.
const HINTS = {
  'Cache': 'Covers and pages loaded from the internet', 'Code Cache': 'Compiled scripts',
  'GrShaderCache': 'GPU shaders', 'ShaderCache': 'GPU shaders', 'GPUCache': 'GPU shaders', 'DawnGraphiteCache': 'GPU shaders',
  'DawnWebGPUCache': 'GPU shaders', 'GPUPersistentCache': 'GPU shaders', 'Shared Dictionary': 'Compression dictionaries',
  'Service Worker': 'Service workers', 'blob_storage': 'Temporary data', 'VideoDecodeStats': 'Video playback stats',
  'Local Storage': 'Page storage', 'Session Storage': 'Page storage', 'WebStorage': 'Page storage', 'Network': 'Cookies and network state',
  'Preferences': 'Engine preferences', 'logs': 'Diagnostic logs',
}

function useBytes() {
  const { t } = useTranslation()
  return (bytes) => {
    const n = Number(bytes) || 0
    if (n < 1024) return `${n} ${t('B')}`
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = n / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    const digits = unit >= 2 ? 2 : value >= 100 ? 0 : 1
    return `${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${t(units[unit])}`
  }
}

// What each clean-up button removes, shown in its confirmation window.
const CLEAN = {
  safe: {
    title: 'Safe cache cleanup',
    intro: 'Removes only what nothing uses any more or what comes back by itself:',
    list: [
      'Covers no track, artist or playlist uses any more',
      'Covers and pages loaded from the internet, compiled scripts and GPU shaders (loaded again when needed)',
      'Motion covers and converted copies (made again when needed)',
      'Sign-in profiles left over from unfinished sign-ins',
      'Logs of earlier launches',
      'Online tracks nobody uses (not in playlists, likes or history)',
      'Unused space inside the database (it is compacted)',
    ],
    keep: 'Your library, playlists, settings, covers in use and sign-ins stay.',
  },
  full: {
    title: 'Full cache cleanup',
    intro: 'Removes everything the safe cleanup does, and also data better kept:',
    list: [
      'YouTube Music sign-in: you will be signed out',
      'Cookies and stored data of every web service and sign-in profile',
      'YouTube cookies exported for downloads',
      'Music video cache',
      'Online tracks with only play history, and that history',
    ],
    keep: 'Your library, playlists, settings, covers in use and online tracks in playlists or likes stay. You will need to sign in to web services again.',
  },
}

// One row: name, size, share of the whole folder, files, and a note.
function Stat({ label, size, total, files, note, color, tone = 'text-white', small, onClick, open }) {
  const { t } = useTranslation()
  const bytes = useBytes()
  const pct = total ? (size / total) * 100 : 0
  return (
    <div onClick={onClick}
      className={`relative flex min-w-0 items-center gap-4 overflow-hidden rounded-xl border border-border px-4 ${small ? 'ml-8 bg-card/25 py-1.5' : 'bg-card/50 py-2'} ${onClick ? 'cursor-pointer hover:bg-card' : ''}`}>
      <div className="pointer-events-none absolute inset-y-0 left-0 opacity-[0.12]" style={{ width: `${pct}%`, background: color || 'currentColor' }} />
      <span className={`flex shrink-0 items-center gap-2 truncate text-[11px] uppercase tracking-wider text-muted ${small ? 'w-[17rem]' : 'w-[19rem]'}`} title={label}>
        {onClick && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        {color && <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />}
        <span className="truncate">{label}</span>
      </span>
      <span className={`w-28 shrink-0 tabular-nums ${small ? 'text-sm' : 'font-display text-xl'} ${tone}`} title={`${size.toLocaleString()} ${t('bytes')}`}>{bytes(size)}</span>
      <span className="w-20 shrink-0 text-sm tabular-nums text-white/70">{total != null ? percent(size, total) : ''}</span>
      <span className="w-28 shrink-0 text-xs tabular-nums text-muted">{files != null ? t('{n} file|{n} files', { n: files.toLocaleString(), count: files }) : ''}</span>
      {note && <span className="min-w-0 truncate text-sm text-muted" title={note}>{note}</span>}
    </div>
  )
}

export default function CacheAnalysis() {
  const { t } = useTranslation()
  const bytes = useBytes()
  const [report, setReport] = useState(null)
  const [running, setRunning] = useState(false)
  const [current, setCurrent] = useState('')
  const [error, setError] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState({})
  const [confirm, setConfirm] = useState(null) // 'safe' | 'full' | null
  const [cleaning, setCleaning] = useState(null)
  const [cleaned, setCleaned] = useState(null)
  usePageReady(loaded)

  const clean = async (mode) => {
    setConfirm(null)
    setCleaning(mode)
    setCleaned(null)
    setError(null)
    try {
      if (mode === 'full' && api.isElectron) await Promise.resolve(api.youtubeDisconnect?.()).catch(() => null)
      const result = await api.cacheAnalysisClean(mode)
      if (result?.ok) setCleaned(result)
      else setError(result?.unsupported ? t('Cache analysis works in the desktop app.') : (result?.error || '?'))
    } catch (e) { setError(e?.message || '?') }
    setCleaning(null)
    run()
  }

  const run = () => {
    setError(null)
    setRunning(true)
    setCurrent('')
    api.cacheAnalysisRun().then(result => {
      if (result?.unsupported) setError(t('Cache analysis works in the desktop app.'))
      else if (result?.ok) setReport(result.report)
      else setError(result?.error || '?')
    }).catch(e => setError(e?.message || '?')).finally(() => { setRunning(false); setLoaded(true) })
  }

  useEffect(() => {
    const off = api.onCacheAnalysisProgress(p => setCurrent(p?.current || ''))
    run()
    return off
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const total = report?.total
  const itemLabel = (it) => {
    if (it.id === 'ghostTracks') return `${t(ITEMS.ghostTracks)} · ${it.rows}`
    if (ITEMS[it.id] && it.name) return `${t(ITEMS[it.id])} · ${it.name}`
    if (ITEMS[it.id]) return t(ITEMS[it.id])
    return it.name || it.id
  }
  const itemNote = (it) => {
    if (it.id === 'ghostTracks') return t('{unused} unused, {history} with only history, {kept} in playlists or likes', it)
    if (it.average) return t('{size} per file on average', { size: bytes(it.average) })
    if (it.name && HINTS[it.name]) return t(HINTS[it.name])
    return null
  }
  const dbFile = report?.sections.find(s => s.id === 'database')?.items.find(i => i.id === 'dbMain')?.size || 0

  const dialog = confirm && CLEAN[confirm]
  const estimate = mode => (report?.cleanup && !running ? ` · ~${bytes(report.cleanup[mode])}` : '')

  return (
    <div className="w-full space-y-6 px-4 @md:px-6 pb-12 pt-6">
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={dialog ? t(dialog.title) : ''} width="max-w-md">
        {dialog && (
          <div className="space-y-4 text-sm">
            {confirm === 'full' && (
              <p className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-300">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {t('This also deletes sign-ins and cookies. It cannot be undone.')}
              </p>
            )}
            {report?.cleanup && (
              <p className="flex items-baseline gap-2">
                <span className="text-muted">{t('Will free about')}</span>
                <span className={`font-display text-2xl tabular-nums ${confirm === 'full' ? 'text-red-400' : 'text-white'}`}>{bytes(report.cleanup[confirm])}</span>
                <span className="text-xs tabular-nums text-muted">{percent(report.cleanup[confirm], report.total.size)}</span>
              </p>
            )}
            <p className="text-white/80">{t(dialog.intro)}</p>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              {dialog.list.map(line => <li key={line}>{t(line)}</li>)}
            </ul>
            <p className="text-xs text-muted">{t(dialog.keep)}</p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setConfirm(null)} className="rounded-full border border-border px-4 py-1.5 text-xs text-muted hover:text-white">{t('Cancel')}</button>
              <button onClick={() => clean(confirm)}
                className={`rounded-full px-4 py-1.5 text-xs font-medium ${confirm === 'full' ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-white text-black hover:bg-white/85'}`}>
                {confirm === 'full' ? t('Delete everything') : t('Clean up')}
              </button>
            </div>
          </div>
        )}
      </Modal>
      <section>
        <div className="flex flex-wrap items-center gap-3">
          <HardDrive size={18} className="text-accent" />
          <h1 className="font-display text-lg uppercase tracking-[0.28em] text-white">{t('Cache Analysis')}</h1>
          {report?.finishedAt && !running && (
            <span className="text-xs text-muted">{t('Counted {date}', { date: new Date(report.finishedAt).toLocaleString() })}</span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button onClick={() => setConfirm('safe')} disabled={running || !!cleaning}
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-white/85 disabled:opacity-50">
              {cleaning === 'safe' ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} {t('Safe cache cleanup')}<span className="tabular-nums">{estimate('safe')}</span>
            </button>
            <button onClick={() => setConfirm('full')} disabled={running || !!cleaning}
              className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50">
              {cleaning === 'full' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} {t('Full cache cleanup')}<span className="tabular-nums">{estimate('full')}</span>
            </button>
            <button onClick={run} disabled={running || !!cleaning}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:text-white disabled:opacity-50">
              {running ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {t('Refresh')}
            </button>
          </div>
        </div>

        {running && !report && (
          <div className="mt-6 flex items-center gap-3 text-sm text-muted">
            <Loader2 size={16} className="animate-spin text-accent" />
            <span className="truncate">{current || t('Looking for files...')}</span>
          </div>
        )}

        {cleaning && <p className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin text-accent" /> {t('Cleaning up...')}</p>}
        {!cleaning && cleaned && (
          <p className="mt-4 text-sm text-accent">
            {t('Freed {size}: {before} → {after}', { size: bytes(cleaned.freed), before: bytes(cleaned.before), after: bytes(cleaned.after) })}
          </p>
        )}
        {!running && error && <p className="mt-4 text-sm text-red-400">{error}</p>}

        {total && (
          <div className={`mt-6 space-y-4 ${running ? 'opacity-60' : ''}`}>
            <div>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="font-display text-4xl tabular-nums text-white">{bytes(total.size)}</span>
                <span className="text-xs tabular-nums text-muted">{total.size.toLocaleString()} {t('bytes')}</span>
                <span className="text-xs tabular-nums text-muted">{t('On disk: {size}', { size: bytes(total.disk) })}</span>
                <span className="text-xs tabular-nums text-muted">{t('{n} file|{n} files', { n: total.files.toLocaleString(), count: total.files })}</span>
              </div>
              <p className="mt-1 truncate text-xs text-muted" title={report.root}>{report.root}</p>
            </div>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/[0.08]">
              {report.sections.map(s => (
                <div key={s.id} className="h-full" title={`${t(SECTIONS[s.id]?.label || s.id)}: ${bytes(s.size)} (${percent(s.size, total.size)})`}
                  style={{ width: `${(s.size / total.size) * 100}%`, background: SECTIONS[s.id]?.color }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {report.sections.map(s => (
                <span key={s.id} className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ background: SECTIONS[s.id]?.color }} />
                  {t(SECTIONS[s.id]?.label || s.id)} <span className="tabular-nums text-white/70">{percent(s.size, total.size)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {total && (
        <section className={`flex flex-col gap-1.5 ${running ? 'opacity-60' : ''}`}>
          {report.sections.map(s => {
            const meta = SECTIONS[s.id] || {}
            const isOpen = open[s.id] ?? true
            return (
              <React.Fragment key={s.id}>
                <Stat label={t(meta.label || s.id)} size={s.size} total={total.size} files={s.files} color={meta.color}
                  note={meta.desc && t(meta.desc)} open={isOpen} onClick={() => setOpen(o => ({ ...o, [s.id]: !isOpen }))} />
                {isOpen && s.items.map((it, i) => (
                  <Stat key={`${it.id}-${it.name || i}`} small label={itemLabel(it)} size={it.size} total={total.size} files={it.id === 'ghostTracks' ? null : it.files}
                    color={meta.color} note={itemNote(it)} tone="text-white/90" />
                ))}
                {isOpen && s.id === 'artwork' && report.artwork?.unused && (
                  <Stat small label={t('Not used by the library')} size={report.artwork.unused.size} total={total.size}
                    files={report.artwork.unused.files} tone={report.artwork.unused.files ? 'text-red-400' : 'text-muted'}
                    note={t('Covers of tracks, artists and playlists that are no longer in the library')} />
                )}
              </React.Fragment>
            )
          })}
        </section>
      )}

      {report?.database?.tables?.length > 0 && (
        <section className={running ? 'opacity-60' : ''}>
          <div className="mb-2 flex flex-wrap items-baseline gap-3">
            <h2 className="text-[11px] uppercase tracking-wider text-muted">{t('Database tables')}</h2>
            <span className="text-xs text-muted">
              {t('Unused pages inside the file: {size}', { size: bytes(report.database.freeBytes) })}
            </span>
          </div>
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="w-[34%] px-3 py-2 font-normal">{t('Table')}</th>
                <th className="px-2 py-2 text-right font-normal">{t('Rows')}</th>
                <th className="px-2 py-2 text-right font-normal">{t('Data')}</th>
                <th className="px-2 py-2 text-right font-normal">{t('Indexes')}</th>
                <th className="px-2 py-2 text-right font-normal">{t('Total')}</th>
                <th className="px-3 py-2 text-right font-normal">{t('Of database')}</th>
              </tr>
            </thead>
            <tbody>
              {report.database.tables.map(row => (
                <tr key={row.name} className="border-t border-border/60 tabular-nums hover:bg-card">
                  <td className="truncate px-3 py-1.5 text-white" title={row.name}>{row.name}</td>
                  <td className="px-2 py-1.5 text-right text-muted">{row.rows != null ? row.rows.toLocaleString() : '—'}</td>
                  <td className="px-2 py-1.5 text-right text-white/80">{bytes(row.data)}</td>
                  <td className={`px-2 py-1.5 text-right ${row.indexes ? 'text-white/80' : 'text-muted/40'}`}>{row.indexes ? `${bytes(row.indexes)} (${row.indexCount})` : '—'}</td>
                  <td className="px-2 py-1.5 text-right text-accent">{bytes(row.size)}</td>
                  <td className="px-3 py-1.5 text-right text-muted">{percent(row.size, dbFile)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {report?.largestFiles?.length > 0 && (
        <section className={running ? 'opacity-60' : ''}>
          <h2 className="mb-2 text-[11px] uppercase tracking-wider text-muted">{t('Largest files')}</h2>
          <table className="w-full table-fixed text-sm">
            <tbody>
              {report.largestFiles.map(f => (
                <tr key={f.path} className="border-t border-border/60 tabular-nums hover:bg-card">
                  <td className="truncate px-3 py-1.5 text-white" title={f.path}>{f.path}</td>
                  <td className="w-32 px-2 py-1.5 text-right text-white/80">{bytes(f.size)}</td>
                  <td className="w-24 px-3 py-1.5 text-right text-muted">{percent(f.size, total.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

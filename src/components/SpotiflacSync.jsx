// Android app: sync with the SpotiFLAC app. Songs it downloads into the
// chosen folder show up in Lokal by themselves: checked every half minute
// while Lokal runs, at once when you come back to Lokal, and at start-up.
import React, { useEffect, useState } from 'react'
import { FolderSync, FolderOpen, ExternalLink, RefreshCw, Loader2 } from 'lucide-react'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { showToast } from './Toaster'

export const SPOTIFLAC_PACKAGE = 'com.zarz.spotiflac'

/** Opens the SpotiFLAC app, or says it isn't installed. */
export async function openSpotiflacApp(t) {
  try { await api.openApp(SPOTIFLAC_PACKAGE) } catch { showToast(t("The SpotiFLAC app isn't installed on this phone.")) }
}

export default function SpotiflacSync() {
  const { t } = useTranslation()
  const [folder, setFolder] = useState('')
  const [installed, setInstalled] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    api.getSettings().then(s => setFolder(s?.spotiflac_sync_folder || '')).catch(() => {})
    Promise.resolve(api.appInstalled?.(SPOTIFLAC_PACKAGE)).then(v => setInstalled(!!v)).catch(() => setInstalled(false))
  }, [])

  const choose = async () => {
    const picked = await api.openFolder()
    if (!picked) return
    setBusy(true); setMessage('')
    try {
      await api.saveSettings({ spotiflac_sync_folder: picked })
      setFolder(picked)
      // Part of the library from now on (and scanned now).
      const settings = await api.getSettings()
      let roots = []
      try { roots = JSON.parse(settings?.music_folders || '[]') } catch {}
      if (!Array.isArray(roots)) roots = []
      if (!roots.length && settings?.music_folder) roots = [settings.music_folder]
      const inside = roots.some(r => picked === r || picked.startsWith(r.replace(/\/+$/, '') + '/'))
      if (!inside) await api.scanFolders([...roots, picked])
      else await syncNow(false)
      window.dispatchEvent(new Event('lokal:refresh'))
      setMessage(t('SpotiFLAC folder set. New downloads will appear in your library.'))
    } finally { setBusy(false) }
  }

  const syncNow = async (report = true) => {
    setBusy(true)
    try {
      const r = await fetch('/api/settings/sync-folder', { method: 'POST' }).then(res => res.json()).catch(() => null)
      if (r?.ok) {
        window.dispatchEvent(new Event('lokal:refresh'))
        if (report) setMessage(r.added === 1 ? t('1 new song from SpotiFLAC.') : r.added ? t('{count} new songs from SpotiFLAC.', { count: r.added }) : t('Up to date: no new songs.'))
      } else if (report) {
        setMessage(r?.reason === 'missing' ? t("This folder can't be found any more: choose it again.") : r?.reason === 'busy' ? t('A scan is already running.') : t('Choose the SpotiFLAC folder first.'))
      }
    } finally { setBusy(false) }
  }

  const stop = async () => {
    await api.saveSettings({ spotiflac_sync_folder: '' })
    setFolder('')
    setMessage(t('Sync turned off. Songs already in your library stay there.'))
  }

  return (
    <div className="rounded-xl border border-border bg-elevated p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"><FolderSync size={18} /></div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">{t('Sync with the SpotiFLAC app')}</p>
          <p className="mt-0.5 text-xs text-muted">{t('Songs the SpotiFLAC app downloads into this folder appear in Lokal by themselves. In SpotiFLAC, set the download folder (Settings) to a folder of the phone such as Music/SpotiFLAC, not the app-specific folder, which other apps can’t read.')}</p>
        </div>
      </div>
      <p className="truncate rounded-lg bg-card px-3 py-2 font-display text-xs text-muted">{folder || t('Not set')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={choose} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-base disabled:opacity-50">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />} {folder ? t('Change folder') : t('Choose the folder')}
        </button>
        {folder && (
          <button type="button" onClick={() => syncNow(true)} disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted disabled:opacity-50">
            <RefreshCw size={13} /> {t('Sync now')}
          </button>
        )}
        {installed !== false && (
          <button type="button" onClick={() => openSpotiflacApp(t)} className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted">
            <ExternalLink size={13} /> {t('Open SpotiFLAC')}
          </button>
        )}
        {folder && (
          <button type="button" onClick={stop} className="rounded-lg px-3 py-2 text-xs text-muted underline">{t('Turn off')}</button>
        )}
      </div>
      {message && <p className="text-xs text-accent">{message}</p>}
    </div>
  )
}

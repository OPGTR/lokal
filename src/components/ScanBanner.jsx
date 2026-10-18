// Library > Music Folder: the folder Lokal indexes, with Rescan / Change and
// the scan's progress. A finished scan refreshes every page showing the library.

import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw, ScanLine } from 'lucide-react'
import { api, peekSettings } from '../api'
import { plural } from '../plural'
import { useTranslation } from '../i18n'

const refreshLibrary = () => window.dispatchEvent(new Event('lokal:refresh'))
// The desktop app reports the scan's end (progress `complete`), which
// refreshes; the web server has no progress events, so its request does.
const refreshAfterRequest = () => { if (!api.isElectron) refreshLibrary() }

export default function ScanBanner() {
  const { t } = useTranslation()
  // From the settings already read, so the folder doesn't show "Not set" first.
  const [folder, setFolder] = useState(() => peekSettings()?.music_folder || '')
  const [folderKnown, setFolderKnown] = useState(() => !!peekSettings())
  const [progress, setProgress] = useState(null)

  useEffect(() => {
    api.getSettings().then(s => { if (s?.music_folder) setFolder(s.music_folder) }).catch(() => {}).finally(() => setFolderKnown(true))
    const unsub = api.onScanProgress((_, data) => {
      setProgress(data)
      if (data.complete) { refreshLibrary(); setTimeout(() => setProgress(null), 3000) }
    })
    return () => { if (typeof unsub === 'function') unsub() }
  }, [])

  const scan = async () => {
    // Desktop: the folder picker (cancelling it scans nothing). Web: the
    // server's folder, or a path typed in when there's none yet.
    const f = api.canPickFolders
      ? await api.openFolder()
      : folder || window.prompt('Path to your music folder on the server')?.trim()
    if (!f) return
    setFolder(f)
    api.scanFolder(f).then(refreshAfterRequest)
  }

  return (
    <div className="bg-elevated border border-border rounded-xl p-4 flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{t("Music Folder")}</p>
        <p className="text-xs text-muted mt-0.5 font-display truncate">{folder || (folderKnown ? t('Not set') : '\u00a0')}</p>
        {progress && !progress.complete && (
          <div className="mt-2 space-y-1">
            <p className="text-xs text-accent">Scanning… {progress.done}/{progress.total} · {progress.skipped || 0} skipped</p>
            <div className="h-0.5 bg-border rounded-full w-48 overflow-hidden">
              <motion.div className="h-full bg-accent rounded-full" animate={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '0%' }} />
            </div>
          </div>
        )}
        {progress?.complete && <p className="text-xs text-accent mt-1">✓ {plural(progress.done - (progress.skipped || 0), 'track')} indexed</p>}
      </div>
      <div className="flex gap-2 flex-shrink-0">
        {folder && (
          <button onClick={() => api.scanFolder(folder).then(refreshAfterRequest)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card border border-border text-xs text-muted hover:text-white transition-colors">
            <RefreshCw size={12} /> Rescan
          </button>
        )}
        <button onClick={scan} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-base text-xs font-medium hover:bg-accent/80 transition-colors">
          <ScanLine size={12} /> {folder ? t('Change') : t('Select Folder')}
        </button>
      </div>
    </div>
  )
}

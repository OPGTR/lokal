import { useTranslation } from '../i18n'
import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Minus, Settings, Square, X } from 'lucide-react'
import { api } from '../api'
import HeaderSearch from './HeaderSearch'
import { DownloadManagerPanel, DownloadsButton } from './DownloadManager'
import { usePhoneLayout } from '../phoneLayout'

/**
 * The window header: on the left the app name (the draggable part in the
 * desktop app) with Settings and Downloads right after it, close to the
 * sidebar and search (Settings nearer the edge: the downloads panel opens
 * inwards, to the right, so Settings stays in reach); the Home button and
 * search in the middle; the window controls on the right. In the browser it's
 * the same bar without the window controls.
 */
/**
 * Phone: the app's name, then Downloads and Settings; on the search page the
 * search field fills the bar.
 */
function PhoneTitleBar() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const path = useLocation().pathname
  const onSettings = path === '/settings'
  const onSearch = path === '/search'
  return (
    <div data-phone-top className="relative z-40 flex h-14 flex-shrink-0 items-center gap-2 px-3 border-b border-border"
      style={{ backgroundColor: 'rgb(var(--surface-rgb) / 0.92)', backdropFilter: 'blur(14px)' }}>
      {onSearch ? (
        <div className="min-w-0 flex-1"><HeaderSearch phone /></div>
      ) : (
        <button type="button" onClick={() => nav('/')} className="flex min-w-0 items-center gap-2" aria-label={t('Home')}>
          <img src="/lokal-icon.png" alt="" className="h-8 w-8 flex-shrink-0 rounded-full" />
          <span className="truncate font-display text-sm uppercase tracking-[0.2em] text-white">Lokal</span>
        </button>
      )}
      <div className="ml-auto flex flex-shrink-0 items-center gap-1 [&_[data-downloads-toggle]]:h-10 [&_[data-downloads-toggle]]:w-10">
        <DownloadsButton />
        <DownloadManagerPanel />
        {!onSearch && (
          <button type="button" onClick={() => nav('/settings')} aria-label={t('Settings')} aria-current={onSettings ? 'page' : undefined}
            className={`flex h-10 w-10 items-center justify-center rounded-full ${onSettings ? 'bg-accent/15 text-accent' : 'text-muted'}`}>
            <Settings size={20} />
          </button>
        )}
      </div>
    </div>
  )
}

export default function TitleBar() {
  const phone = usePhoneLayout()
  return phone ? <PhoneTitleBar /> : <DesktopTitleBar />
}

function DesktopTitleBar() {
  const { t } = useTranslation()
  const desktop = api.isElectron
  const nav = useNavigate()
  const onSettings = useLocation().pathname === '/settings'
  return (
    <div
      className={`${desktop ? 'titlebar' : ''} relative z-40 h-[35px] grid items-center gap-3 px-3 border-b border-border flex-shrink-0`}
      style={{ gridTemplateColumns: 'minmax(max-content, 1fr) minmax(0, 520px) minmax(0, 1fr)', backgroundColor: 'rgb(var(--surface-rgb) / 0.85)', backdropFilter: 'blur(12px)' }}
    >
      <div className="flex min-w-0 items-center gap-1">
        {/* A narrow window keeps the buttons, not the name. */}
        <span className="mr-2 hidden min-w-0 truncate font-display text-xs text-muted tracking-widest uppercase sm:inline">{t("Lokal Music")}</span>
        <button
          type="button"
          data-tour="settings"
          onClick={() => nav('/settings')}
          title={t("Settings")}
          aria-label={t("Settings")}
          aria-current={onSettings ? 'page' : undefined}
          className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors ${onSettings ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-elevated hover:text-text'}`}
        >
          <Settings size={15} />
        </button>
        <DownloadsButton />
        <DownloadManagerPanel />
      </div>

      <HeaderSearch />

      <div className="flex items-center gap-1 justify-end">
        {desktop && (
          <>
            <button
              onClick={() => window.electron?.minimize()}
              className="w-7 h-7 rounded flex items-center justify-center text-muted hover:text-text hover:bg-elevated transition-colors"
            >
              <Minus size={12} />
            </button>
            <button
              onClick={() => window.electron?.maximize()}
              className="w-7 h-7 rounded flex items-center justify-center text-muted hover:text-text hover:bg-elevated transition-colors"
            >
              <Square size={11} />
            </button>
            <button
              onClick={() => window.electron?.close()}
              className="w-7 h-7 rounded flex items-center justify-center text-muted hover:bg-red/30 hover:text-red transition-colors"
            >
              <X size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

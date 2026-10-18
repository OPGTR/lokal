import { useTranslation } from '../i18n'
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { AudioLines, CheckCircle2, Gamepad2, LogIn, Music2, RefreshCw } from 'lucide-react'
import { YoutubeIcon } from './SourceIcon'
import { api } from '../api'
import { LastfmSignInModal, ListenBrainzSignInModal } from './ScrobblerSignIn'
import { discordClientId } from '../discord'
import { getYoutubeAccountStatus, subscribeYoutubeAccountStatus } from '../youtubeAccountStatus'

function StatusDot({ connected }) {
  const { t } = useTranslation()
  return <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-border'}`} aria-hidden="true" />
}

function ActionButton({ children, onClick, disabled = false, muted = false }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        muted
          ? 'border-border bg-card text-muted hover:border-accent/30 hover:text-white'
          : 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/25'
      }`}
    >
      {children}
    </button>
  )
}

function AccountCard({ icon: Icon, tint, name, connected, status, note, children }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-xl border border-border bg-card/40 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${tint}`}><Icon size={16} /></div>
          <div>
            <p className="text-sm font-medium text-white">{name}</p>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted"><StatusDot connected={connected} />{status}</div>
          </div>
        </div>
        {connected && <CheckCircle2 size={16} className="text-green-400" />}
      </div>
      <div className="flex flex-nowrap items-center gap-2">{children}</div>
      {note && <p className="text-xs leading-relaxed text-red-300">{t(note)}</p>}
    </div>
  )
}

/**
 * Account entry points shared by first-run setup and Integrations.
 *
 * Desktop YouTube Music sign-in owns a persistent, automatically refreshed session.
 */
export default function ProviderConnections({ compact = false, settingsOverride = null, onSettingsChanged, onListenBrainzChanged }) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState(() => settingsOverride || {})
  const [loading, setLoading] = useState(!settingsOverride)
  const [refreshing, setRefreshing] = useState(false)
  const [signIn, setSignIn] = useState(null) // 'lastfm' | 'listenbrainz'
  const [listenbrainz, setListenbrainz] = useState(null)
  const [discord, setDiscord] = useState({ connected: false, busy: false, error: '' })
  const [youtubeAuthorizing, setYoutubeAuthorizing] = useState(false)
  const [youtubeSigningIn, setYoutubeSigningIn] = useState(false)
  const [youtubeState, setYoutubeState] = useState({ message: '', tone: 'muted' })
  const [settingsError, setSettingsError] = useState('')
  const youtubeStatus = useSyncExternalStore(subscribeYoutubeAccountStatus, getYoutubeAccountStatus)

  useEffect(() => {
    if (!settingsOverride) return
    setSettings(settingsOverride)
    setLoading(false)
  }, [settingsOverride])

  const refreshListenBrainz = () => Promise.resolve(api.listenbrainzStatus?.()).then(status => {
    if (!status || status.error) return
    setListenbrainz(status)
    onListenBrainzChanged?.(status)
  }).catch(() => {})
  useEffect(() => { refreshListenBrainz() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshDiscord = () => Promise.resolve(api.discordStatus?.()).then(status => setDiscord(d => ({ ...d, connected: !!status?.connected }))).catch(() => {})
  useEffect(() => { if (api.isElectron) refreshDiscord() }, [])

  const connectDiscord = async () => {
    const id = discordClientId(settings)
    if (!id) { setDiscord(d => ({ ...d, error: t('Add your Discord app ID under Discord Rich Presence first.') })); return }
    setDiscord(d => ({ ...d, busy: true, error: '' }))
    await Promise.resolve(api.saveSettings({ discord_client_id: id })).catch(() => {})
    const ok = await Promise.resolve(api.discordConnect(id)).catch(() => false)
    setDiscord({ connected: !!ok, busy: false, error: ok ? '' : t('Could not connect. Is Discord open?') })
  }

  const disconnectDiscord = async () => {
    setDiscord(d => ({ ...d, busy: true, error: '' }))
    await Promise.resolve(api.discordDisconnect()).catch(() => {})
    setDiscord({ connected: false, busy: false, error: '' })
  }

  const changeSettings = patch => {
    setSettings(previous => ({ ...previous, ...patch }))
    onSettingsChanged?.(patch)
  }

  const loadSettings = async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    try {
      const next = await api.getSettings()
      if (next && !next.error) {
        setSettings(next)
        setSettingsError('')
        onSettingsChanged?.(Object.fromEntries(Object.entries(next).filter(([key]) => key.startsWith('yt_') || key.startsWith('lastfm_'))))
      } else if (next?.error) {
        setSettingsError(t(next.error))
      }
    } catch (error) {
      setSettingsError(t(error?.message || 'Could not load account settings.'))
    } finally {
      if (quiet) setRefreshing(false)
      else setLoading(false)
    }
    refreshListenBrainz()
    if (api.isElectron) refreshDiscord()
  }

  useEffect(() => {
    if (!settingsOverride) loadSettings()
  }, [settingsOverride])

  const lastfmConnected = Boolean(settings.lastfm_session_key && settings.lastfm_username)
  const listenbrainzConnected = !!listenbrainz?.connected
  const youtubeAccountReady = settings.yt_account_session === '1'
  const youtubeConnected = youtubeAccountReady && youtubeStatus.verified && youtubeStatus.connected
  useEffect(() => api.onYoutubeSignInStatus(status => {
    if (status?.message) setYoutubeState({ message: t(status.message), tone: 'muted' })
  }), [])
  const verifyYouTube = async () => {
    setYoutubeAuthorizing(true)
    const result = await api.youtubeAccount(true).catch(error => ({ error: error.message }))
    setYoutubeAuthorizing(false)
    const verified = result?.authenticated === true && !result.error
    setYoutubeState({ message: verified ? t('YouTube Music account access verified.') : t(result?.error || 'YouTube Music did not confirm account access. Please sign in again.'), tone: verified ? 'success' : 'error' })
  }
  const signInYouTube = async () => {
    setYoutubeAuthorizing(true)
    setYoutubeSigningIn(true)
    setYoutubeState({ message: '', tone: 'muted' })
    try {
      const result = await api.youtubeSignIn({ mode: 'embedded' })
      await loadSettings(true)
      const verified = result?.authenticated === true && !result.error
      setYoutubeState({ message: verified ? t('YouTube Music account access verified.') : t(result?.error || 'Sign-in was closed before account access could be verified. Please sign in again.'), tone: verified ? 'success' : 'error' })
    } catch (error) { setYoutubeState({ message: t(error.message || 'YouTube Music sign-in failed.'), tone: 'error' }) }
    finally { setYoutubeAuthorizing(false); setYoutubeSigningIn(false) }
  }

  const disconnectLastfm = async () => {
    if (!window.confirm(t("Disconnect Last.fm?"))) return
    const patch = { lastfm_session_key: '', lastfm_auth_token: '', lastfm_username: '' }
    const saved = await Promise.resolve(api.saveSettings(patch)).catch(error => ({ error: error.message }))
    if (saved?.error) { setSettingsError(saved.error); return }
    changeSettings(patch)
  }

  const disconnectListenBrainz = async () => {
    if (!window.confirm(t("Disconnect ListenBrainz?"))) return
    await Promise.resolve(api.listenbrainzDisconnect()).catch(() => {})
    refreshListenBrainz()
  }

  const disconnectYouTube = async () => {
    if (!window.confirm(t("Disconnect YouTube Music and sign out of its saved session?"))) return
    setYoutubeAuthorizing(true)
    try {
      const result = await api.youtubeDisconnect()
      if (!result?.ok || result.error) throw new Error(result?.error || t('Could not disconnect YouTube Music.'))
      await loadSettings(true)
      setYoutubeState({ message: t('YouTube disconnected from Lokal.'), tone: 'success' })
      window.dispatchEvent(new Event('lokal:refresh'))
    } catch (error) { setYoutubeState({ message: t(error.message || 'Could not disconnect YouTube Music.'), tone: 'error' }) }
    finally { setYoutubeAuthorizing(false) }
  }

  if (loading) {
    return <div className="rounded-xl border border-border bg-card/40 p-4 text-xs text-muted">{t("Loading account connections…")}</div>
  }

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-white">{t("Account connections")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            {api.isElectron || api.isAndroid ? t('Lokal keeps provider credentials on this device and uses them only for the selected integration.') : t('Web mode sends provider credentials to the Lokal server, where they remain under that server’s control and are used only for the selected integration.')}
          </p>
          {settingsError && <p className="mt-1 text-xs text-red-400">{t(settingsError)} <button type="button" onClick={() => loadSettings(true)} className="text-accent hover:underline">{t("Retry")}</button></p>}
        </div>
        <button
          type="button"
          onClick={() => loadSettings(true)}
          disabled={refreshing}
          title={t("Refresh account status")}
          aria-label={t("Refresh account status")}
          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-card hover:text-white disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className={compact ? 'space-y-3' : 'grid gap-3 @md:grid-cols-2'}>
        <AccountCard icon={Music2} tint="bg-red-500/10 text-red-300" name="Last.fm" connected={lastfmConnected}
          status={lastfmConnected ? t('Connected as {username}', { username: settings.lastfm_username }) : t('Not connected')}>
          <ActionButton onClick={() => setSignIn('lastfm')}><LogIn size={13} />{lastfmConnected ? t('Reconnect') : t('Sign in')}</ActionButton>
          {lastfmConnected && <ActionButton onClick={disconnectLastfm} muted>{t('Disconnect')}</ActionButton>}
        </AccountCard>

        <AccountCard icon={AudioLines} tint="bg-orange-500/10 text-orange-300" name="ListenBrainz" connected={listenbrainzConnected}
          status={listenbrainzConnected ? t('Connected as {username}', { username: listenbrainz.username || t('ListenBrainz user') }) : t('Not connected')}>
          {listenbrainzConnected
            ? <><ActionButton onClick={() => api.openExternal(`https://listenbrainz.org/user/${encodeURIComponent(listenbrainz.username || '')}/`)} muted>{t('Profile')}</ActionButton><ActionButton onClick={disconnectListenBrainz} muted>{t('Disconnect')}</ActionButton></>
            : <ActionButton onClick={() => setSignIn('listenbrainz')}><LogIn size={13} />{t('Sign in')}</ActionButton>}
        </AccountCard>

        <AccountCard icon={YoutubeIcon} tint="bg-red-600/10 text-red-300" name="YouTube Music" connected={youtubeConnected}
          note={youtubeState.tone === 'error' ? youtubeState.message : youtubeStatus.error}
          status={api.isAndroid ? t('Not available on Android') : !api.isElectron ? t('Available in the desktop app') : youtubeConnected ? t('Connected') : youtubeAccountReady ? youtubeStatus.error ? t('Needs signing in again') : t('Not verified') : t('Not connected')}>
          {api.isElectron && !youtubeConnected && <ActionButton onClick={signInYouTube} disabled={youtubeAuthorizing}>{youtubeSigningIn ? <RefreshCw size={13} className="animate-spin" /> : <LogIn size={13} />}{t('Sign in')}</ActionButton>}
          {youtubeSigningIn && <ActionButton onClick={() => api.youtubeCancelSignIn()} muted>{t('Cancel')}</ActionButton>}
          {api.isElectron && youtubeAccountReady && !youtubeSigningIn && <ActionButton onClick={verifyYouTube} disabled={youtubeAuthorizing} muted>{t('Verify')}</ActionButton>}
          {api.isElectron && youtubeAccountReady && !youtubeSigningIn && <ActionButton onClick={disconnectYouTube} disabled={youtubeAuthorizing} muted>{t('Disconnect')}</ActionButton>}
        </AccountCard>

        <AccountCard icon={Gamepad2} tint="bg-[#5865F2]/15 text-[#8b95f5]" name="Discord" connected={discord.connected} note={t(discord.error)}
          status={api.isAndroid ? t('Not available on Android') : !api.isElectron ? t('Available in the desktop app') : discord.connected ? t('Rich Presence connected') : t('Not connected')}>
          {api.isElectron && (discord.connected
            ? <ActionButton onClick={disconnectDiscord} disabled={discord.busy} muted>{t('Disconnect')}</ActionButton>
            : <ActionButton onClick={connectDiscord} disabled={discord.busy}>{discord.busy ? <RefreshCw size={13} className="animate-spin" /> : <LogIn size={13} />}{t('Connect')}</ActionButton>)}
        </AccountCard>
      </div>
      <LastfmSignInModal open={signIn === 'lastfm'} onClose={() => setSignIn(null)} settings={settings} onConnected={changeSettings} />
      <ListenBrainzSignInModal open={signIn === 'listenbrainz'} onClose={() => setSignIn(null)} onConnected={refreshListenBrainz} />
    </div>
  )
}

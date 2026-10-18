// The smart playlist editor: a name, rules ("Genre is Jazz", "Folder is in
// D:\Music\Live"...), whether all or any must match, an order and an
// optional limit. A live count shows what the rules give before saving.
// Opened with openSmartPlaylistEditor() (src/smartPlaylists.js), for a new
// smart playlist or to edit one.

import { useTranslation } from '../i18n'
import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Plus, X, FolderOpen, Loader2 } from 'lucide-react'
import Modal from './Modal'
import { api } from '../api'
import { useAppStore } from '../store/player'
import { plural } from '../plural'
import { SMART_FIELDS, SMART_SORTS, newRule, readRules, ruleComplete } from '../smartPlaylists'

const field = 'rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60'

function fmtLength(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function RuleRow({ rule, genres, onChange, onRemove }) {
  const { t } = useTranslation()
  const spec = SMART_FIELDS[rule.field]
  const set = (patch) => onChange({ ...rule, ...patch })
  const pickFolder = async () => {
    const folder = await api.openFolder()
    if (folder) set({ value: folder })
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select aria-label={t("Field")} value={rule.field} onChange={(e) => onChange(newRule(e.target.value))} className={`${field} w-32`}>
        {Object.entries(SMART_FIELDS).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
      </select>
      <select aria-label={t("Condition")} value={rule.op} onChange={(e) => set({ op: e.target.value })} className={`${field} w-36`}>
        {spec.ops.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      {spec.input === 'select' && (
        <select aria-label={t("Value")} value={rule.value} onChange={(e) => set({ value: e.target.value })} className={`${field} min-w-0 flex-1`}>
          {spec.options.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      )}
      {(spec.input === 'text' || spec.input === 'genre') && (
        <input aria-label={t("Value")} value={rule.value} onChange={(e) => set({ value: e.target.value })}
          list={spec.input === 'genre' ? 'smart-genres' : undefined}
          placeholder={spec.input === 'genre' ? (genres[0] || 'Jazz') : ''} className={`${field} min-w-0 flex-1`} />
      )}
      {(spec.input === 'number' || (spec.input === 'days' && rule.op !== 'never')) && (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <input aria-label={t("Value")} type="number" min="0" value={rule.value} onChange={(e) => set({ value: e.target.value })}
            placeholder={spec.placeholder || '30'} className={`${field} w-24`} />
          <span className="text-xs text-muted">{spec.unit || spec.suffix?.[rule.op] || ''}</span>
        </span>
      )}
      {spec.input === 'folder' && (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <input aria-label={t("Folder")} value={rule.value} onChange={(e) => set({ value: e.target.value })}
            placeholder={api.canPickFolders ? 'Choose a folder…' : '/music/Live'} className={`${field} min-w-0 flex-1`} />
          {api.canPickFolders && (
            <button onClick={pickFolder} title={t("Choose a folder")} aria-label={t("Choose a folder")}
              className="rounded-lg border border-border p-1.5 text-muted hover:text-white"><FolderOpen size={13} /></button>
          )}
        </span>
      )}
      {(spec.input === 'none' || (spec.input === 'days' && rule.op === 'never')) && <span className="flex-1" />}
      <button onClick={onRemove} title={t("Remove this rule")} aria-label={t("Remove this rule")} className="rounded p-1 text-muted hover:bg-card hover:text-white">
        <X size={13} />
      </button>
    </div>
  )
}

export default function SmartPlaylistModal() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const user = useAppStore(s => s.user)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null) // the playlist being edited, or null for a new one
  const [name, setName] = useState('')
  const [rules, setRules] = useState({ match: 'all', rules: [newRule()], sort: 'artist', limit: 0 })
  const [limitOn, setLimitOn] = useState(false)
  const [preview, setPreview] = useState(null) // { count, duration } | { loading } | { error }
  const [genres, setGenres] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const show = (e) => {
      const playlist = e.detail?.playlist || null
      const read = playlist ? readRules(playlist.smart_rules) : null
      setEditing(playlist)
      setName(playlist?.name || '')
      setRules(read ? { ...read, rules: read.rules.length ? read.rules : [newRule()] } : { match: 'all', rules: [newRule()], sort: 'artist', limit: 0 })
      setLimitOn(!!read?.limit)
      setPreview(null)
      setOpen(true)
      Promise.resolve(api.getAllGenres()).then(list => setGenres(Array.isArray(list) ? list.map(g => (typeof g === 'string' ? g : g?.genre || g?.name)).filter(Boolean) : [])).catch(() => {})
    }
    window.addEventListener('lokal:smart-playlist', show)
    return () => window.removeEventListener('lokal:smart-playlist', show)
  }, [])

  // What is saved: complete rules only, the limit only when it's on.
  const saved = useMemo(() => ({
    match: rules.match,
    rules: rules.rules.filter(ruleComplete),
    sort: rules.sort,
    limit: limitOn ? Math.max(1, Number(rules.limit) || 0) : 0,
  }), [rules, limitOn])

  // The live count, a moment after the last change.
  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setPreview(p => ({ ...(p || {}), loading: true }))
    const timer = setTimeout(() => {
      Promise.resolve(api.smartPlaylistPreview(saved, user?.id))
        .then(result => { if (alive) setPreview(result?.error ? { error: result.error } : result) })
        .catch(e => { if (alive) setPreview({ error: e.message }) })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [open, saved, user?.id])

  const close = () => setOpen(false)
  const setRule = (i, rule) => setRules(r => ({ ...r, rules: r.rules.map((old, j) => (j === i ? rule : old)) }))
  const removeRule = (i) => setRules(r => ({ ...r, rules: r.rules.filter((_, j) => j !== i) }))

  const save = async () => {
    const title = name.trim()
    if (!title || saving) return
    setSaving(true)
    try {
      let playlist = editing
      if (!playlist) playlist = await api.createPlaylist(title, user?.id)
      if (!playlist?.id) throw new Error(playlist?.error || 'Could not create the playlist')
      const update = { smartRules: saved }
      if (editing && title !== editing.name) update.name = title
      const result = await api.updatePlaylist(playlist.id, update)
      if (!result || result.error) {
        // A new one that didn't get its rules would be an empty regular playlist: remove it.
        if (!editing) await Promise.resolve(api.deletePlaylist(playlist.id)).catch(() => {})
        throw new Error(result?.error || 'Could not save the rules')
      }
      window.dispatchEvent(new CustomEvent(editing ? 'lokal:playlist-updated' : 'lokal:playlists-changed', { detail: { playlistId: playlist.id, action: editing ? 'updated' : 'created' } }))
      if (editing) window.dispatchEvent(new CustomEvent('lokal:playlists-changed', { detail: { playlistId: playlist.id, action: 'updated' } }))
      setOpen(false)
      if (!editing) nav(`/playlist/${playlist.id}`)
    } catch (e) {
      setPreview({ error: e.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={close} title={editing ? 'Edit smart playlist' : 'New smart playlist'} width="max-w-2xl">
      <div className="space-y-5">
        <div>
          <label htmlFor="smart-name" className="mb-1.5 block text-[11px] font-display uppercase tracking-widest text-muted">{t("Name")}</label>
          <input id="smart-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Jazz I haven't heard lately")}
            onKeyDown={(e) => { if (e.key === 'Enter') save() }}
            className="w-full rounded-xl border border-border bg-card px-3.5 py-2 text-sm text-white outline-none placeholder:text-subtle focus:border-accent/60" />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted">
            Songs that match
            <select aria-label={t("Match")} value={rules.match} onChange={(e) => setRules(r => ({ ...r, match: e.target.value }))} className={field}>
              <option value="all">{t("all")}</option>
              <option value="any">{t("any")}</option>
            </select>
            of these rules
          </div>
          {rules.rules.map((rule, i) => (
            <RuleRow key={i} rule={rule} genres={genres} onChange={(next) => setRule(i, next)} onRemove={() => removeRule(i)} />
          ))}
          <datalist id="smart-genres">{genres.map(g => <option key={g} value={g} />)}</datalist>
          <button onClick={() => setRules(r => ({ ...r, rules: [...r.rules, newRule()] }))}
            className="flex items-center gap-1.5 rounded-lg px-1 py-1 text-xs text-muted hover:text-accent">
            <Plus size={13} /> Add a rule
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <label className="flex items-center gap-2">
            Order
            <select aria-label={t("Order")} value={rules.sort} onChange={(e) => setRules(r => ({ ...r, sort: e.target.value }))} className={field}>
              {SMART_SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={limitOn} onChange={(e) => { setLimitOn(e.target.checked); if (e.target.checked && !rules.limit) setRules(r => ({ ...r, limit: 50 })) }} className="accent-accent" />
            Only the first
            <input aria-label={t("Limit")} type="number" min="1" value={rules.limit || ''} disabled={!limitOn}
              onChange={(e) => setRules(r => ({ ...r, limit: e.target.value }))} className={`${field} w-20 disabled:opacity-40`} />
            songs
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <p className="flex min-w-0 items-center gap-2 text-xs text-muted">
            <Sparkles size={13} className="flex-shrink-0 text-accent" />
            {preview?.error ? <span className="text-red-400">{preview.error}</span>
              : preview?.count === undefined ? <span className="flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> {t("Counting…")}</span>
                : <span className={preview.loading ? 'opacity-60' : ''}>{plural(preview.count, 'song')}{preview.count ? ` · ${fmtLength(preview.duration)}` : ''} · updates as your library changes</span>}
          </p>
          <div className="flex flex-shrink-0 gap-2">
            <button onClick={close} className="rounded-xl border border-border bg-card px-4 py-2 text-sm text-muted hover:text-white">{t("Cancel")}</button>
            <button onClick={save} disabled={!name.trim() || saving}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-base hover:bg-accent-dim disabled:opacity-40">
              {editing ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export const MAX_FIXED_WIDTH = 30
export const ROW_SIZE = { min: 0.75, max: 1.5, step: 0.05, initial: 1 }
export const ROW_GAP = { min: 0.0625, max: 1, step: 0.0625, initial: 0.375 }

// Widths are in rem, including gaps, so larger text uses the compact layout
// sooner. Header and rows use the exact same template, never content-sized cells.
export const TRACK_COLUMN_OPTIONS = [
  ['number', 'Track number'],
  ['artwork', 'Artwork'],
  ['artist', 'Artist'],
  ['source', 'Source'],
  ['quality', 'Quality'],
  ['added', 'Date added'],
  ['time', 'Duration'],
  ['actions', 'Quick actions'],
  ['grip', 'Drag handle'],
]

export function trackColumnDefaults(showQuality = false, playlist = false) {
  return { number: true, artwork: true, artist: true, source: true, quality: showQuality, added: playlist, time: true, actions: true, grip: true }
}

export function trackColumnPreferences(saved, showQuality = false, playlist = false) {
  const result = trackColumnDefaults(showQuality, playlist)
  for (const [key] of TRACK_COLUMN_OPTIONS) {
    if (typeof saved?.[key] === 'boolean') result[key] = saved[key]
  }
  return result
}

export function trackColumnLayout(width, columns, { playlist = false, actionSlots = 0, likedTrack = false, extraColumns = [], album = true } = {}) {
  const visible = {}
  // Padding, a readable Title, and the always-reachable More menu.
  let remaining = width - 2 - 11 - 1.25 - 0.5 - (likedTrack ? 1.25 : 0)
  const fit = (key, size, enabled = true) => {
    visible[key] = enabled && remaining >= size + 0.5
    if (visible[key]) remaining -= size + 0.5
  }
  // Keep quality and the tiny source mark before less essential metadata.
  fit('quality', 4.5, columns.quality)
  fit('source', 2, columns.source)
  for (const column of extraColumns) fit(column.key, column.width || 5.5)
  fit('album', 8, album)
  fit('time', 3, columns.time)
  fit('number', 2, columns.number)
  fit('added', 5.5, columns.added)
  fit('grip', 1, playlist && columns.grip)
  const extraActions = actionSlots * 1.25 + 1.5
  fit('actions', extraActions, columns.actions)
  // The More button is always present. A liked track also needs room for its
  // persistent heart even when optional quick actions are hidden.
  const actionsWidth = (visible.actions ? extraActions + 1.25 : 1.25) + (likedTrack ? 1.25 : 0)
  const template = [
    visible.grip && '1rem',
    visible.number && '2rem',
    'minmax(0,3fr)',
    visible.album && 'minmax(0,2fr)',
    visible.source && '2rem',
    visible.quality && '4.5rem',
    ...extraColumns.map(column => visible[column.key] && `${column.width || 5.5}rem`),
    visible.added && '5.5rem',
    visible.time && '3rem',
    `${actionsWidth}rem`,
  ].filter(Boolean).join(' ')
  return { ...visible, likedTrack, template }
}

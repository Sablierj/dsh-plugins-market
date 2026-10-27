/**
 * 收藏与最近访问（F01-09）.
 *
 * ## Two lists that look alike and answer different questions
 *
 *   - **收藏** is a decision: the user said "this one matters". It survives
 *     everything, it is ordered by nothing in particular, and only the user
 *     removes it.
 *   - **最近访问** is a record: it is ordered by time, it is capped, and it
 *     forgets on its own.
 *
 * They are stored separately and never derived from one another. A favourite
 * that fell out of the recent list is still a favourite; a recent visit that was
 * never favourited is still worth returning to. Collapsing them into one list
 * with a flag would make "un-favourite" silently delete a visit that happened.
 *
 * ## Why a JSON blob in `setting` rather than a table
 *
 * 「点过哪些对象、按什么顺序」 is a small ordered list belonging to one person,
 * and this batch adds no migration. `setting` already stores strings, so the two
 * keys are declared in the whitelist and the list is JSON in the value. The cost
 * is that a hand-edited value can be malformed — which is why every reader here
 * goes through `readList`, which returns an empty list rather than throwing.
 * **A bad character in a UI preference must not take the home page down.**
 *
 * ## Ordering, de-duplication and the cap are one operation
 *
 * `pushRecent` re-inserts at the front and then truncates, and it de-duplicates
 * **by object, not by time**. Visiting A, B, then A again must leave A at the
 * front with one entry — otherwise the list is a log of clicks wearing the name
 * of a list of places, and one object the user keeps returning to fills it.
 */

import { getSetting, setSetting } from '../../store/settings.js'

/** The two keys, named once. They are declared in `store/settings.js`. */
export const PIN_KEYS = {
  favorites: 'ui.favorites',
  recent: 'ui.recent',
}

/** The cap on the recent list. The acceptance criterion is "≤ 20". */
export const MAX_RECENT = 20

/** What identifies "the same object" across two visits. */
function entryKey(entry) {
  return `${String(entry?.module ?? '')}:${String(entry?.id ?? '')}`
}

/** One entry, or `null` when it does not name an object. */
function normalize(entry) {
  const module = String(entry?.module ?? '').trim()
  const id = String(entry?.id ?? '').trim()
  if (module === '' || id === '') return null
  const label = String(entry?.label ?? id).trim() || id
  return { module, id, label }
}

/**
 * One stored list, or `[]`.
 *
 * Tolerant on purpose: this is a value a person can edit in the settings table,
 * and half-written JSON is a thing that happens. An exception here would take
 * the whole home page with it, which is far worse than forgetting two entries.
 */
export function readList(store, key) {
  let raw
  try {
    raw = getSetting(store, key)
  } catch {
    /* The key is not declared — a store from before this batch. Same answer. */
    return []
  }
  const parsed = typeof raw === 'string' ? safeParse(raw) : raw
  if (!Array.isArray(parsed)) return []
  return parsed.map(normalize).filter(entry => entry !== null)
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function writeList(store, key, list) {
  setSetting(store, key, JSON.stringify(list))
  return list
}

/** Both lists, as the page reads them. */
export function readPins(store) {
  return {
    favorites: readList(store, PIN_KEYS.favorites),
    recent: readList(store, PIN_KEYS.recent),
    maxRecent: MAX_RECENT,
  }
}

/**
 * Record a visit.
 *
 * Returns `{ ok, recent }`; `ok: false` when the entry names no object, because
 * "we did not record that" and "we recorded it" must not look the same to a
 * caller that is about to tell the user something.
 */
export function pushRecent(store, entry) {
  const item = normalize(entry)
  if (item === null) return { ok: false, error: 'module and id are both required', recent: [] }

  const key = entryKey(item)
  const kept = readList(store, PIN_KEYS.recent).filter(existing => entryKey(existing) !== key)
  const recent = [item, ...kept].slice(0, MAX_RECENT)
  writeList(store, PIN_KEYS.recent, recent)
  return { ok: true, recent, dropped: kept.length + 1 - recent.length }
}

/**
 * Add or remove a favourite.
 *
 * Newest first, like the recent list, so the one just starred is the one at the
 * top — the reader's next action is almost always on it.
 */
export function toggleFavorite(store, entry) {
  const item = normalize(entry)
  if (item === null) return { ok: false, error: 'module and id are both required', favorites: [] }

  const current = readList(store, PIN_KEYS.favorites)
  const key = entryKey(item)
  const without = current.filter(existing => entryKey(existing) !== key)
  const added = without.length === current.length
  const favorites = added ? [item, ...without] : without
  writeList(store, PIN_KEYS.favorites, favorites)
  return { ok: true, added, favorites }
}

/** 收藏置顶，其余按时间 —— 两条分开的列表，一个块里读。 */
export function pinView(store) {
  const pins = readPins(store)
  const favourites = new Set(pins.favorites.map(entryKey))
  return {
    ...pins,
    /* The recent list still contains anything that is also a favourite. The page
       marks those rows rather than removing them: a visit really did happen, and
       hiding it would make the timeline look like it had a hole in it. */
    recentFavourited: pins.recent.filter(entry => favourites.has(entryKey(entry))).map(entryKey),
  }
}

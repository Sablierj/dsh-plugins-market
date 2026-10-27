/**
 * The four categories a product line's signals live in, and what each stored
 * shape means.
 *
 * Until v23 a line's signals were one flat list. That list was doing four jobs
 * without saying which: the words that *are* this category, the words that rule
 * it out, the situations it is used in, and the materials it is made of. A user
 * editing it could not tell which of the four they were editing, and the
 * classifier could not either.
 *
 * So: `core` / `exclude` / `scenario` / `material`, and this module is the only
 * place that decides what a stored value means. Everything else — the page, the
 * tool, the classifier, the impact preview — reads through here, because the
 * failure mode of two readers is that they disagree about the one case that
 * matters most:
 *
 *   - `'builtin'`  — the column is NULL: never configured, fall back to the
 *                    constant in `classify.js`.
 *   - `'custom'`   — configured; use it.
 *   - `'empty'`    — configured to be empty: this line matches **nothing**.
 *   - `'broken'`   — unparseable. Hand-edited stores only.
 *
 * `builtin` and `empty` must never be collapsed. "I never touched this line" and
 * "I emptied this line on purpose" lead to opposite fixes, and a display that
 * showed both as "0 词" would make the second look like the first — which is how
 * a deliberate change gets silently reverted.
 *
 * **A missing key inside a stored object is that category being empty, not a
 * fallback.** `{"core":["bench"]}` has no `scenario` words; it does not inherit
 * the shipped scenario words. Inheriting would make it impossible to remove one
 * category's words without also removing the others.
 */

import { PRODUCT_LINE_SIGNALS } from './classify.js'

/** The four categories, in the order the page and the tool list them. */
export const SIGNAL_CATEGORIES = ['core', 'exclude', 'scenario', 'material']

/** The four states a stored value can be in. */
export const SIGNAL_MODES = ['builtin', 'custom', 'empty', 'broken']

/** The words that make a keyword *belong* to a line. `exclude` is the opposite. */
export const POSITIVE_CATEGORIES = ['core', 'scenario', 'material']

/**
 * The constant list for a line, or `null` when the code ships none for it.
 *
 * `null` rather than `[]` because the page says "无内置词表" for a user-created
 * line, and an empty array would render as "内置 0 词" — a claim that the code
 * has a list and it happens to be empty, which is a different and wrong thing.
 */
export function builtinSignals(lineId) {
  const list = PRODUCT_LINE_SIGNALS[lineId]
  return Array.isArray(list) ? [...list] : null
}

/** An empty four-category object. */
function emptySignals() {
  return { core: [], exclude: [], scenario: [], material: [] }
}

/** Strings only, trimmed and lowercased, blanks dropped, duplicates removed. */
function cleanList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    /* Case and inner whitespace are folded at the boundary, not at match time:
       a signal stored as `Yoga  Mat` never matches a lowercased keyword, and
       nothing downstream would report that. */
    const word = entry.trim().toLowerCase().replace(/\s+/g, ' ')
    if (word === '' || out.includes(word)) continue
    out.push(word)
  }
  return out
}

/**
 * Read a stored `signals_json` into one of the four states.
 *
 * `lineId` is what resolves the built-in fallback; pass it whenever it is known.
 */
export function readSignalCategories(json, lineId) {
  const builtin = builtinSignals(lineId)
  if (json === null || json === undefined) {
    return { mode: 'builtin', signals: { ...emptySignals(), core: builtin ?? [] }, builtin }
  }

  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return { mode: 'broken', signals: null, builtin }
  }
  /* A stored JSON `null` is the faithful snapshot of "never configured" — the
     shape v23 writes into `product_line_version` for a line that had no signals.
     It is not the same as `'{}'`, which means configured-empty. */
  if (parsed === null) return { mode: 'builtin', signals: { ...emptySignals(), core: builtin ?? [] }, builtin }
  if (typeof parsed !== 'object') return { mode: 'broken', signals: null, builtin }

  /* The pre-v23 flat list. `include` is the older object spelling of the same
     thing, and v23 rewrites both into `core`; this branch keeps a store that has
     not been through the migration readable rather than broken. */
  const signals = emptySignals()
  if (Array.isArray(parsed)) {
    signals.core = cleanList(parsed)
  } else {
    signals.core = cleanList(parsed.core ?? parsed.include)
    signals.exclude = cleanList(parsed.exclude)
    signals.scenario = cleanList(parsed.scenario)
    signals.material = cleanList(parsed.material)
  }

  const empty = SIGNAL_CATEGORIES.every(category => signals[category].length === 0)
  return { mode: empty ? 'empty' : 'custom', signals, builtin }
}

/**
 * The canonical JSON text for a four-category signal set, or `null` for "not
 * configured".
 *
 * Canonical means: every category present, in one order, cleaned. Two edits that
 * leave the same words must produce the same string, or the page would keep
 * showing unsaved changes after a save.
 */
export function signalsJson(signals) {
  if (signals === null || signals === undefined) return null
  /* A bare array is the pre-v23 shape, and it means `core` — the same reading
     `readSignalCategories` gives it. Without this branch a writer handed an
     array would store four empty categories, which is the opposite of what the
     caller said. */
  const source = Array.isArray(signals) ? { core: signals } : signals
  const clean = emptySignals()
  for (const category of SIGNAL_CATEGORIES) clean[category] = cleanList(source[category])
  return JSON.stringify(clean)
}

/**
 * The words that make a keyword belong to a line: core + scenario + material.
 *
 * `exclude` is deliberately not here — it is the opposite kind of word, and a
 * caller that merged them would make every exclude word attract the very
 * keywords it was meant to repel.
 */
export function positiveSignals(signals) {
  if (signals === null || signals === undefined) return []
  return POSITIVE_CATEGORIES.flatMap(category => cleanList(signals[category]))
}

/** The words that rule a keyword out. */
export function excludeSignals(signals) {
  if (signals === null || signals === undefined) return []
  return cleanList(signals.exclude)
}

/**
 * Whether one keyword belongs to a line under one signal set.
 *
 * Pure and exported: the preview and the save path both have to answer this the
 * same way, and a second copy of "which words count" is how "the preview said
 * 214 and the save said 209" starts.
 */
export function matchesSignals(keyword, signals) {
  const text = String(keyword ?? '').toLowerCase()
  if (text === '') return false
  const excludes = excludeSignals(signals)
  if (excludes.some(word => text.includes(word))) return false
  const positives = positiveSignals(signals)
  return positives.some(word => text.includes(word))
}

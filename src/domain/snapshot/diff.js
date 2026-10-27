/**
 * The field-level diff between two frozen snapshot payloads.
 *
 * The acceptance criterion this file exists for is phrased as a negative: the
 * comparison must NOT collapse to "有变化" (something changed). A one-line
 * "changed" answer is worse than no answer, because it looks like a comparison
 * and leaves the reader to open both payloads and do it by eye — which is the
 * work the feature was supposed to remove.
 *
 * So the output is one entry per field: `{ field, before, after }`. Nested
 * objects are walked with a dotted path (`attributes.color`), because a payload
 * is not flat and `attributes` as one leaf would hide exactly the field that
 * moved. Arrays are compared whole: a reordered bullet list is one change to
 * `bullets`, and pretending it is N field changes would bury the real edit.
 *
 * Added and removed fields are reported too, with the missing side as `null`.
 * `presence` decides that, not the value: a field that *was* explicitly null and
 * is now gone is a change, and comparing the two nulls would miss it.
 *
 * Pure and dependency-free on purpose — the page, the store and any future tool
 * all diff with this one function, so "what counts as a change" is stated once.
 */

/** True when two leaf values are the same as far as a payload comparison cares. */
function sameValue(left, right) {
  if (left === right) return true
  /* Objects and arrays that got here are leaves (nested objects were flattened
     away). JSON is the equality the store itself uses when it writes payloads,
     so it is the equality a diff should use to read them back. */
  if (left === null || right === null) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Walk a parsed payload into `path -> leaf`, so a nested change has a name.
 *
 * Scalars, arrays and null are leaves, and so is an empty object **at a nested
 * path**: `attributes` holding `{}` is a real, present value, and folding it away
 * would make "explicitly empty" and "no such field" read the same.
 *
 * The root is the one path that is not a field name. An **empty** object there
 * contributes nothing — "this payload has no fields" is what the empty result
 * already says — instead of a leaf keyed `''`. Before this, `diffPayloads({},
 * payload)` was one entry longer than the payload's own field list: a row no
 * reader can name, and a count that disagreed with the diff table under it.
 *
 * A root that is not a plain object at all (an array payload) is still reported
 * as one unnamed leaf. It has no field names either, but dropping it would make
 * two different payloads read as "no change", which is the worse answer.
 */
function flatten(value, prefix, out) {
  const isPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isPlainObject) {
    out[prefix] = value
    return
  }
  const keys = Object.keys(value)
  if (keys.length === 0) {
    if (prefix !== '') out[prefix] = {}
    return
  }
  for (const key of keys) {
    flatten(value[key], prefix === '' ? key : `${prefix}.${key}`, out)
  }
}

/** A payload as a flat map; a null/absent side flattens to no fields at all. */
function flattenPayload(payload) {
  const out = {}
  const source = payload !== null && payload !== undefined && typeof payload === 'object' ? payload : {}
  flatten(source, '', out)
  return out
}

/**
 * The diff between two payloads, as a field list.
 *
 * Returns `[]` only when the two payloads are equal field by field. Sorted by
 * field name so the same pair always reads the same way — a diff whose order
 * depends on insertion order is a diff two people cannot compare.
 */
export function diffPayloads(before, after) {
  const left = flattenPayload(before)
  const right = flattenPayload(after)
  const fields = new Set([...Object.keys(left), ...Object.keys(right)])

  const changes = []
  for (const field of [...fields].sort()) {
    const inLeft = Object.prototype.hasOwnProperty.call(left, field)
    const inRight = Object.prototype.hasOwnProperty.call(right, field)
    if (inLeft !== inRight) {
      /* Added or removed. The absent side reads as null rather than undefined,
         so the entry survives JSON.stringify on its way to the page. */
      changes.push({ field, before: inLeft ? left[field] : null, after: inRight ? right[field] : null })
      continue
    }
    if (!sameValue(left[field], right[field])) {
      changes.push({ field, before: left[field], after: right[field] })
    }
  }
  return changes
}

/**
 * The one numeric clamp the five detail tabs share.
 *
 * Every tab takes a `limit`, and every tab has to answer the same three questions
 * about it: what does a missing value mean, what does a nonsense value mean, and
 * what is the hard ceiling. Five hand-written copies of `Math.min(Math.max(…))`
 * would be five places to get the ceiling wrong — and the failure mode is silent:
 * a limit that is one digit too large does not throw, it just returns a payload
 * nobody planned for. `store/queries.js` and `store/audit.js` each grew their own
 * clamp before this file existed; this is the one the module 05 tabs share.
 *
 * `fallback` is applied first, so a missing or nonsense value lands on the
 * documented default rather than on `NaN`. Four spellings mean "not given" and are
 * tested **before** `Number()`: `undefined`, `null`, `''` and `0`.
 *
 *   · `Number(null)` and `Number('')` are both `0` — a finite number — so a
 *     `Number`-only test would read "no limit was given" as "the caller asked for
 *     zero" and clamp it up to 1. The payload then comes back with one row and
 *     looks like an answer.
 *   · `0` joins them because that is this repository's existing convention for a
 *     list limit: `queries.js` clamps with `filters.limit ?? 30`, `store/audit.js`
 *     with `Number(filters.limit ?? 100) || 100`, `listRollbackTasks` with
 *     `Number(limit) || 50` — all three turn `0` into the default. A `0`-means-one-row
 *     reading here would be the only one of the four that behaves differently, and
 *     "the limit silently became 1" is precisely the failure this file exists to
 *     prevent. **This is a stated decision, not an accident.**
 *
 * `Math.max(1, NaN)` is `NaN`, and a `LIMIT NaN` binding is the other way the limit
 * silently stops existing.
 */
export function clampLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number === 0) return fallback
  return Math.min(Math.max(Math.trunc(number), 1), max)
}

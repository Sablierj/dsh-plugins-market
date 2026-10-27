/**
 * The rules about *what* a collection task may target, in one place.
 *
 * ## Why this moved out of `sources/collection.js`
 *
 * Four callers now have to agree on the same answers, and they live on both
 * sides of the service:
 *
 *   · `collection.submit()` — the minimum-level entry point (pinned by the
 *     existing assertions, its signature untouched);
 *   · `amzn_collect_preview` / the `collect-preview` route — which must refuse
 *     exactly what a submission would refuse, **before** anything is written;
 *   · `amzn_collect_run` — which does both, in one call;
 *   · the section detail builder, for the "how many requests" number.
 *
 * A preview that validated targets with a second implementation would be a form
 * that says "7 valid ASINs" and then submits four. That is the drift this file
 * removes; the service keeps its public behaviour byte for byte (the messages
 * here are the ones `tests/run.mjs` already asserts).
 *
 * ## What is deliberately NOT here
 *
 * Nothing here reads the store or the network. These are pure functions over
 * arguments, which is what lets the preview stay "500 ms, no browser" (contract
 * §3) and lets a test drive every branch without a fixture.
 */

import { COLLECTION_SECTIONS } from './sections.js'

/** `^[A-Z0-9]{10}$` — the same shape `store/collection-section.js` enforces. */
export function isValidAsin(value) {
  return /^[A-Z0-9]{10}$/.test(String(value ?? '').trim().toUpperCase())
}

/**
 * Validate and de-duplicate the target list.
 *
 * Duplicates are collapsed — the same ASIN twice in one submission is a slip,
 * not a request, and collecting it twice spends a request and looks like a
 * scraper.
 *
 * A malformed ASIN, on the other hand, is **always** an error, even when the
 * rest of the list is fine. Dropping it quietly would be the worst outcome: the
 * agent reports "collected 2 ASINs", the user believes 3 are in the library,
 * and nobody finds out until a report is missing a product. Refusing the whole
 * submission costs one turn and the message names every bad entry.
 */
export function normalizeTargets(targets) {
  if (!Array.isArray(targets)) throw new Error('targets must be an array of {asin, marketplace}')

  const seen = new Map()
  const problems = []
  for (const entry of targets) {
    const asin = String(entry?.asin ?? '').trim().toUpperCase()
    const marketplace = String(entry?.marketplace ?? 'US').trim().toUpperCase()
    if (!isValidAsin(asin)) {
      problems.push(`"${entry?.asin ?? '(missing)'}" is not a 10-character ASIN`)
      continue
    }
    /* The declared side rides through **de-duplication**, and it has to: it is
       ownership level 1 (contract §6.4), the one tier a person owns outright.
       Dropping it here would leave `selfAsins` / `competitorAsins` looking like
       two boxes that silently collect rather than two statements of ownership —
       every target would fall through to level 5 and `side_split_json` would be
       all-`unknown` however carefully the form was filled in. A coordinate nobody
       declared a side for keeps `side: null` — one shape, so a reader never has
       to ask whether a missing key means "no side" or "not carried through". */
    seen.set(`${asin}|${marketplace}`, {
      asin,
      marketplace,
      side: entry?.side === 'self' || entry?.side === 'competitor' ? entry.side : null,
    })
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 8)
    const rest = problems.length > shown.length ? ` (and ${problems.length - shown.length} more)` : ''
    throw new Error(
      `invalid targets: ${shown.join('; ')}${rest}. Nothing was submitted — fix the list and call again.`,
    )
  }
  return [...seen.values()]
}

/**
 * Check the requested fields against what the source says it can provide.
 *
 * Same reasoning as the target list: a field the source cannot fill must be
 * refused up front, not silently ignored. Otherwise the agent asks for
 * `keywords` from the browser channel, gets a task that "succeeded", and tells
 * the user the keywords were collected.
 *
 * Returns the wanted list (de-duplicated, original order) or throws.
 */
export function validateFieldSelection(requested, supported, { sourceId = 'source' } = {}) {
  if (!Array.isArray(requested) || requested.length === 0) return null
  const available = Array.isArray(supported) ? supported : []
  const wanted = [...new Set(requested.map(String))]
  const unknown = wanted.filter(field => !available.includes(field))
  if (unknown.length > 0) {
    throw new Error(
      `source "${sourceId}" cannot provide: ${unknown.join(', ')}. `
      + `It can provide: ${available.join(', ')}.`,
    )
  }
  return wanted
}

/**
 * The same check, as a refusal rather than a throw — for the preview, which
 * answers with a code instead of failing the turn (`FIELDS_UNSUPPORTED`).
 */
export function fieldSelectionProblem(requested, supported, { sourceId = 'source' } = {}) {
  try {
    return { wanted: validateFieldSelection(requested, supported, { sourceId }), code: null, error: null }
  } catch (error) {
    return { wanted: null, code: 'FIELDS_UNSUPPORTED', error: error.message }
  }
}

/**
 * Rough runtime, so the agent can tell the user "about four minutes" instead of
 * "I don't know". Deliberately pessimistic: over-promising here is how a status
 * check looks like it hung.
 */
export function estimateMinutes(count, pacing) {
  const perTargetMs = average(pacing.beforeNavigateMs) + average(pacing.afterLoadMs) + 6_000
  const longBreaks = Math.floor(count / pacing.longBreakEvery) * average(pacing.longBreakMs)
  return Math.max(1, Math.round((count * perTargetMs + longBreaks) / 60_000))
}

/**
 * How many page requests a run of `targetCount` ASINs over `sections` will cost.
 *
 * **One counting rule, shared with `estimateMinutes`** (contract §6.2.3): both
 * answer "how big is this job", and a preview that said "91 requests" while the
 * estimate said two minutes for a different count would be two answers to one
 * question. The shared part is `targetCount` — the number of *normalized*
 * targets, not the number of arguments the caller typed.
 */
export function estimateRequests(targetCount, { sections = COLLECTION_SECTIONS } = {}) {
  const asins = Math.max(0, Math.trunc(Number(targetCount) || 0))
  const count = Array.isArray(sections) ? sections.length : 0
  return { asins, sections: count, total: asins * count }
}

/**
 * Accept either `targets` or the `asins` shorthand — and the two split boxes.
 *
 * The shorthand exists because the common request is "these ten ASINs on US",
 * and making the agent expand that into ten objects is a token tax on every
 * single call. `selfAsins` / `competitorAsins` are the page's two boxes; an ASIN
 * typed into one of them is a **level-1 ownership statement** (`user-input`),
 * which is why the side rides on the target rather than being re-derived later.
 *
 * Nothing is validated here beyond the shape of the arguments: the ASIN shape
 * check lives in `normalizeTargets`, so there is one ruler and one message.
 */
export function targetsFromArgs(args = {}) {
  const marketplace = args?.marketplace === undefined || args?.marketplace === null || String(args.marketplace).trim() === ''
    ? 'US'
    : String(args.marketplace).trim().toUpperCase()

  const out = []
  for (const entry of Array.isArray(args?.targets) ? args.targets : []) {
    out.push({
      asin: String(entry?.asin ?? '').trim().toUpperCase(),
      marketplace: entry?.marketplace === undefined || entry?.marketplace === null || String(entry.marketplace).trim() === ''
        ? marketplace
        : String(entry.marketplace).trim().toUpperCase(),
      side: entry?.side === 'self' || entry?.side === 'competitor' ? entry.side : null,
    })
  }
  for (const asin of Array.isArray(args?.asins) ? args.asins : []) {
    out.push({ asin: String(asin ?? '').trim().toUpperCase(), marketplace, side: null })
  }
  for (const asin of Array.isArray(args?.selfAsins) ? args.selfAsins : []) {
    out.push({ asin: String(asin ?? '').trim().toUpperCase(), marketplace, side: 'self' })
  }
  for (const asin of Array.isArray(args?.competitorAsins) ? args.competitorAsins : []) {
    out.push({ asin: String(asin ?? '').trim().toUpperCase(), marketplace, side: 'competitor' })
  }
  return out
}

const average = ([min, max]) => (min + max) / 2

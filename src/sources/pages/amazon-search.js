/**
 * Amazon search pages, and the suggestion dropdown.
 *
 * Two capabilities live here, and both exist to answer a question the ASIN
 * extractor cannot:
 *
 *   - **Suggestions** — where a keyword library comes from. A seed word typed
 *     into the real search box makes Amazon's own JS ask for its own
 *     suggestions. See `DESIGN.md` §5.4 for why this is typed rather than
 *     fetched: the completion endpoint needs a marketplace id, and a wrong one
 *     returns another storefront's suggestions *silently* — the exact failure
 *     the per-target storefront switching was built to prevent.
 *   - **Search results** — where `asin_keyword.rank` comes from. The organic
 *     position of a tracked ASIN for a keyword is the measurement the whole
 *     coverage gap is computed from.
 *
 * Layout note, measured 2026-09-21 on amazon.com: a results page renders
 * exactly **16** natural results (`1-16`, `17-32`, `33-48` in the info bar),
 * up to 20 pages. Paid placements are *not* `s-search-result`, so filtering on
 * that component type is what makes a stored rank organic. The census the scan
 * returns exists so that if Amazon ever starts shipping ads under the same
 * component type, the change shows up as data instead of as a quiet rank shift.
 *
 * As everywhere in this plugin: the injected scripts only *collect*; every
 * judgement is a pure function below, so it can be tested without a browser.
 */

import { RESULTS_PER_PAGE } from '../keyword-tiers.js'

/** How many suggestions to ask the page for. Amazon's own default is 11. */
export const SUGGESTION_LIMIT = 11

/** Pages of results a scan may walk. Measured: amazon.com offers 20. */
export const MAX_SCAN_PAGES = 20

/** The search box. `#twotabsearchtextbox` has been stable for years. */
export const SEARCH_BOX_SELECTOR = '#twotabsearchtextbox'

/** The results page for a keyword. `page` is 1-based. */
export function searchUrl(storefront, keyword, page = 1) {
  const term = String(keyword ?? '').trim()
  if (term === '') throw new Error('keyword is required')
  const p = Math.max(1, Math.trunc(Number(page) || 1))
  return `https://${storefront.domain}/s?k=${encodeURIComponent(term)}&page=${p}`
}

/**
 * Put the caret in the search box and empty it.
 *
 * Clearing matters: a leftover term from a previous seed would make the page
 * suggest completions of the *old* word, and the results would be filed under
 * the new keyword — wrong data that looks entirely plausible.
 */
export const FOCUS_SEARCH_BOX = `(() => {
  const box = document.querySelector(${JSON.stringify(SEARCH_BOX_SELECTOR)})
  if (box === null) return { found: false }
  box.focus()
  box.click()
  const selectAll = document.createEvent('Event')
  selectAll.initEvent('select', true, true)
  box.dispatchEvent(selectAll)
  return { found: true, visible: box.offsetParent !== null, value: box.value }
})()`

/**
 * Dismiss the dropdown before navigating away.
 *
 * Blur is enough — the flyout closes on focus loss. A navigation started while
 * the overlay is open can leave the next page with a stale flyout on top of the
 * results, which then swallows the scroll the scan relies on.
 */
export const DISMISS_SUGGESTIONS = `(() => {
  const box = document.querySelector(${JSON.stringify(SEARCH_BOX_SELECTOR)})
  if (box !== null) box.blur()
  document.body.click()
  return { dismissed: true }
})()`

/**
 * Read the open suggestion dropdown.
 *
 * Returns raw candidates rather than a filtered list on purpose: the page's
 * dropdown mixes two different things under the same `.s-suggestion` class —
 * real keyword completions, and *widget* rows such as the "by price" facets
 * ("Under $25", "$25 to $50"). A widget row is not a keyword, and filing it as
 * one would pollute the library with things nobody searches for. Deciding that
 * is `pickKeywordSuggestions`, a pure function with tests.
 *
 * **The only usable signal is the class.** Measured on amazon.com: every
 * suggestion — widget and keyword alike — lives inside
 * `#sac-suggestion-row-<n>-cell-1`, so a container check carries no information
 * at all. An earlier version used one, and it rejected all fifteen candidates,
 * producing "no suggestions" from a dropdown that was full of them. What does
 * separate them is the class list: facets carry `discover-tr-suggestion`,
 * keywords carry `s-suggestion s-suggestion-ellipsis-direction`.
 *
 * `echoes` is the raw box value, so the caller can tell "the dropdown never
 * opened" (no candidates) from "the dropdown opened for the wrong term".
 */
export const READ_SUGGESTIONS = `(() => {
  const box = document.querySelector(${JSON.stringify(SEARCH_BOX_SELECTOR)})
  const nodes = [...document.querySelectorAll('.s-suggestion, [role="option"]')]
  const candidates = nodes.map((el) => {
    const cls = String(el.className || '')
    return {
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
      role: el.getAttribute('role'),
      cls: cls.slice(0, 120),
      widget: /discover-tr/.test(cls),
      visible: el.offsetParent !== null,
    }
  })
  return {
    typed: box === null ? null : box.value,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 120),
  }
})()`

/**
 * Turn the raw dropdown into keywords.
 *
 * Pure. Drops widget rows, deduplicates case-insensitively, normalises the
 * whitespace Amazon sometimes leaves, and caps the length so a stray block of
 * page text cannot enter the library as a "keyword".
 *
 * A `limit` that is not a positive number falls back to the default rather than
 * meaning "no limit". `Math.max(1, Math.trunc(undefined))` is `NaN`, and every
 * `length >= NaN` is false — so a bad argument would silently remove the cap
 * and let a whole dropdown's worth of furniture into the library.
 */
export function pickKeywordSuggestions(raw, { limit } = {}) {
  const candidates = Array.isArray(raw?.candidates) ? raw.candidates : []
  const wanted = Number(limit)
  const cap = Number.isFinite(wanted) && wanted > 0 ? Math.trunc(wanted) : SUGGESTION_LIMIT
  const seen = new Set()
  const kept = []
  const rejected = []

  for (const candidate of candidates) {
    const text = String(candidate?.text ?? '').replace(/\s+/g, ' ').trim()
    if (text === '') continue
    if (candidate?.widget === true) { rejected.push(text); continue }
    // A suggestion is a search phrase. Anything this long is page furniture
    // that happened to be inside the dropdown container.
    if (text.length > 80) { rejected.push(text); continue }
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(text)
    if (kept.length >= cap) break
  }

  return { keywords: kept, rejected, limit: cap }
}

/**
 * Scan a results page for natural placements.
 *
 * Only `s-search-result` is read. Sponsored blocks use other component types
 * (`sp-sponsored-result`, and the `aspa-*` lazy slots), so a rank taken from
 * here is organic by construction. The component census and the info-bar text
 * come back with the rows so a layout change is visible rather than silent.
 */
export const READ_SEARCH_RESULTS = `(() => {
  const census = {}
  for (const el of document.querySelectorAll('[data-component-type]')) {
    const type = el.getAttribute('data-component-type')
    census[type] = (census[type] || 0) + 1
  }

  const nodes = [...document.querySelectorAll('[data-component-type="s-search-result"]')]
  const rows = nodes.map((el, i) => {
    const text = el.textContent || ''
    // The title is not the first h2 span on this layout: the first child is the
    // brand link, which renders as just "JBL". The real title is the longest
    // span, which is also the cheapest reliable way to skip the brand.
    const spans = [...el.querySelectorAll('h2 span')]
      .map(s => (s.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(t => t.length > 0)
    const title = spans.slice().sort((a, b) => b.length - a.length)[0] || null
    return {
      index: i + 1,
      asin: el.getAttribute('data-asin') || null,
      sponsored: /Sponsored/i.test(text.slice(0, 500)),
      title: title === null ? null : title.slice(0, 300),
    }
  }).filter(row => row.asin !== null)

  const info = (document.querySelector('[data-component-type="s-result-info-bar"]')?.textContent || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 200)

  return {
    url: location.href,
    rowCount: nodes.length,
    rows,
    census,
    infoLine: info,
    // "1-16 of over 3,000 results" — the only place Amazon states the page size,
    // so it is worth keeping: it is what tells us 16 is still 16.
    pageWindow: /(\\d+)\\s*-\\s*(\\d+)\\s+of/.exec(info)?.slice(1, 3)?.map(Number) ?? null,
    captcha: /api-services-support@amazon\\.com|Enter the characters you see below/i.test(document.body?.innerText || ''),
  }
})()`

/**
 * Merge per-seed suggestion lists into one keyword set.
 *
 * Pure, and extracted because the caps here are easy to get subtly wrong. There
 * are two of them and they must agree:
 *
 *   - per seed, `limit` suggestions are kept (`pickKeywordSuggestions`);
 *   - across seeds, the union cannot exceed `limit × seeds`, and each keyword
 *     remembers which seeds produced it.
 *
 * An earlier version capped each seed at the *default* 11 while capping the
 * union at `limit × seeds`, so asking for 8 per seed from one seed silently
 * returned 8 out of the 10 that were found. Nothing errored; the library was
 * just quietly short.
 *
 * `cap` is a ceiling on the whole call, not per seed, so a caller that wants
 * "everything these seeds produced" gets it without a second argument.
 */
export function mergeSuggestionSets(perSeed, { limit = SUGGESTION_LIMIT } = {}) {
  const wanted = Number(limit)
  const perSeedCap = Number.isFinite(wanted) && wanted > 0 ? Math.trunc(wanted) : SUGGESTION_LIMIT
  const sets = Array.isArray(perSeed) ? perSeed : []
  const union = new Map()

  for (const entry of sets) {
    for (const keyword of entry?.keywords ?? []) {
      const key = String(keyword).toLowerCase()
      const existing = union.get(key)
      if (existing === undefined) union.set(key, { keyword, seeds: [entry.seed] })
      else if (!existing.seeds.includes(entry.seed)) existing.seeds.push(entry.seed)
    }
  }

  const cap = perSeedCap * Math.max(1, sets.length)
  return { keywords: [...union.values()].slice(0, cap), perSeedCap, cap }
}

/**
 * Which of our ASINs the page placed where.
 *
 * Pure. `page` matters: the stored rank is global, not per-page, and an
 * off-by-one here would shift every rank in the library by a page.
 */
export function pickPlacements(scan, { page = 1, tracked = [] } = {}) {
  const wanted = new Set(tracked.map(asin => String(asin).trim().toUpperCase()))
  const rows = Array.isArray(scan?.rows) ? scan.rows : []
  const offset = (Math.max(1, Math.trunc(Number(page) || 1)) - 1) * RESULTS_PER_PAGE

  return rows
    .filter(row => wanted.size === 0 || wanted.has(String(row.asin).toUpperCase()))
    .map(row => ({
      asin: String(row.asin).toUpperCase(),
      rank: offset + Number(row.index),
      page: Math.max(1, Math.trunc(Number(page) || 1)),
      sponsored: row.sponsored === true,
      title: row.title ?? null,
    }))
}

/**
 * Is this page a real results page?
 *
 * A scan that silently reads a bot-check page finds zero results, which is
 * indistinguishable from "our ASIN is not ranking" — the single most dangerous
 * way for this feature to be wrong. So the caller refuses to store a verdict
 * from a page that did not render results.
 */
export function classifySearchPage(scan) {
  if (scan === null || scan === undefined) return { ok: false, reason: 'no-scan' }
  if (scan.captcha === true) return { ok: false, reason: 'captcha' }
  const rows = Array.isArray(scan.rows) ? scan.rows : []
  if (rows.length === 0) {
    // Zero rows is legitimate on a deep page past the end of the results, so
    // the info bar is what decides.
    if (typeof scan.infoLine === 'string' && /results?/i.test(scan.infoLine)) {
      return { ok: true, reason: 'past-last-result', empty: true }
    }
    return { ok: false, reason: 'no-results-rendered' }
  }
  return { ok: true, reason: 'results', empty: false }
}

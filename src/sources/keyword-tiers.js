/**
 * Keyword tiering — the rule that turns measurements into a decision.
 *
 * The design doc reserves `T1–T4` and leaves the definition open ("来自分层算法").
 * This is that definition, and the reasoning matters more than the labels:
 *
 *   The two things an operator can actually act on are
 *   **(a) does the ASIN already rank for the word** and
 *   **(b) does the listing already say the word.**
 *   Everything else — search volume, difficulty — needs a third-party source
 *   we do not have yet (§4.2), and guessing at it would put a fabricated number
 *   underneath a real decision.
 *
 * So the tier is the 2×2 those two facts form, with rank depth splitting the
 * "ranks" half, because page one is a different job from page three:
 *
 *   T1 守位   ranks, and on page one (≤16)     → don't lose it
 *   T2 冲刺   ranks, but past page one (>16)   → position is the gap, keep going
 *   T3 抢占   no rank, listing already says it → relevance settled, weight missing
 *   T4 观察   no rank, listing silent          → judge relevance before spending
 *
 * **A word that has never been scanned gets no tier at all.** "No rank" and
 * "never looked" are different facts, and collapsing them would silently turn
 * an unmeasured word into a T4 conclusion. `rank: null, scanDepth: null` is the
 * unmeasured case and returns `tier: null`.
 *
 * Pure functions only — no store, no browser. The whole point is that this is
 * testable without either.
 */

/** Natural results Amazon returns per search page. Measured, not assumed: the
 *  info bar reads "1-16", "17-32", "33-48" across pages 1–3. */
export const RESULTS_PER_PAGE = 16

/** Page one is `rank ≤ 16`; this is the boundary T1/T2 turns on. */
export const FIRST_PAGE_DEPTH = RESULTS_PER_PAGE

export const TIERS = ['T1', 'T2', 'T3', 'T4']

export const TIER_LABELS = {
  T1: '守位',
  T2: '冲刺',
  T3: '抢占',
  T4: '观察',
}

export const TIER_MEANING = {
  T1: '已有自然排名且在第 1 页，目标是守住位置',
  T2: '已有自然排名但在第 1 页之外，位置就是缺口',
  T3: '没有自然排名，但 listing 文本里已经出现该词 —— 相关度已确认，缺的是权重',
  T4: '没有自然排名，listing 也没提 —— 先判断相关度，再决定是否投入',
}

/** Is `tier` one of the four we define? Used to validate manual input. */
export function isTier(value) {
  return TIERS.includes(String(value ?? '').toUpperCase())
}

/**
 * Where a keyword sits for one ASIN.
 *
 * @param {object} input
 * @param {number|null} input.rank        organic position, or null if not seen
 * @param {number|null} input.scanDepth   how many results were looked at; null
 *                                        means the keyword has never been scanned
 * @param {boolean} input.inListing       does the listing text contain the word
 * @returns {{ tier: string|null, basis: object }}
 */
export function classifyKeyword({ rank = null, scanDepth = null, inListing = false } = {}) {
  const position = normalizeRank(rank)
  const depth = normalizeDepth(scanDepth)
  const covered = inListing === true

  // Never measured. Saying "T4" here would be a conclusion we did not earn.
  if (position === null && depth === null) {
    return {
      tier: null,
      basis: { reason: 'not-scanned', rank: null, scanDepth: null, inListing: covered },
    }
  }

  if (position !== null) {
    const onFirstPage = position <= FIRST_PAGE_DEPTH
    return {
      tier: onFirstPage ? 'T1' : 'T2',
      basis: {
        reason: onFirstPage ? 'ranks-on-first-page' : 'ranks-below-first-page',
        rank: position,
        page: Math.ceil(position / RESULTS_PER_PAGE),
        scanDepth: depth,
        inListing: covered,
      },
    }
  }

  // No rank, but we did look — `depth` is therefore a real number here.
  return {
    tier: covered ? 'T3' : 'T4',
    basis: {
      reason: covered ? 'no-rank-but-listing-covers' : 'no-rank-and-listing-silent',
      rank: null,
      scanDepth: depth,
      inListing: covered,
      // Worth spelling out, because it is the honest limit of the measurement:
      // "no rank" here means "not in the first N results", not "nowhere".
      note: `扫描了前 ${depth} 条自然结果，未出现`,
    },
  }
}

/**
 * The library-level tier: the best tier any of our ASINs achieves for the word.
 *
 * A keyword is not good or bad in the abstract — it is good or bad *for a
 * listing*. The library only needs to answer "is this word worth anyone's
 * attention", and the best result across the tracked ASINs is the least
 * misleading summary of that.
 */
export function rollupTier(tiers = []) {
  const known = tiers.filter(tier => TIERS.includes(tier))
  if (known.length === 0) return { tier: null, basis: { reason: 'no-asin-scanned' } }
  const tier = TIERS.find(candidate => known.includes(candidate))
  return {
    tier,
    basis: { reason: 'best-across-asins', from: known, count: known.length },
  }
}

/**
 * Global organic rank from a page number and a position within that page.
 *
 * Exported because both the scan and the tests need the same arithmetic, and an
 * off-by-one here would silently shift every stored rank by one.
 */
export function organicRank(page, indexInPage) {
  const p = Number(page)
  const i = Number(indexInPage)
  if (!Number.isFinite(p) || p < 1) throw new Error(`invalid page ${page}`)
  if (!Number.isFinite(i) || i < 1) throw new Error(`invalid indexInPage ${indexInPage}`)
  return (Math.trunc(p) - 1) * RESULTS_PER_PAGE + Math.trunc(i)
}

/**
 * Does the listing text actually contain the keyword?
 *
 * Not a naive `includes`, for two reasons:
 *   - `car` must not be satisfied by `cart` / `carbon`, so Latin-script matches
 *     need a boundary on both sides.
 *   - Chinese, Japanese and Korean are written without spaces, so a boundary
 *     requirement would make every CJK keyword unmatchable. Those fall back to
 *     a plain substring test.
 *
 * Amazon's own text is messy: multiple spaces, newlines inside bullet points,
 * `&amp;`, curly apostrophes. Normalising first means the same keyword is not
 * reported as missing because the listing wrote "Bluetooth  Speaker".
 */
export function keywordInText(keyword, text) {
  const needle = normalizeText(keyword)
  const haystack = normalizeText(text)
  if (needle === '' || haystack === '') return false

  if (containsCjk(needle)) return haystack.includes(needle)

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `[^a-z0-9]` rather than `\b`: `\b` treats `-` as a boundary, so "flip 7"
  // would match inside "flip-7", which is the same keyword written differently
  // and should count. Using a non-alphanumeric class keeps that match while
  // still refusing `car` → `cart`.
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack)
}

/**
 * Lowercase, unify punctuation, collapse whitespace.
 *
 * Separators become spaces rather than being kept, because a search term is a
 * *sequence of tokens*: Amazon writes the same keyword as "Flip-7", "Flip 7"
 * and "Flip_7" depending on the field, and a listing that says one of those
 * does cover a search for another. Without this, `flip 7` failed to match
 * `Flip-7 Portable` — a listing that plainly does target the term.
 *
 * The apostrophe/dash folding happens before the separator pass so that a
 * typographic apostrophe inside a word (`don’t`) becomes `don't` rather than
 * two tokens.
 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/[-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The searchable body of a listing: title, bullets, description, A+. */
export function listingText({ title, bullets, description, a_plus: aPlus } = {}) {
  const parts = [title, description, aPlus]
  if (Array.isArray(bullets)) parts.push(...bullets)
  else if (typeof bullets === 'string') parts.push(bullets)
  return parts.filter(part => typeof part === 'string' && part !== '').join('\n')
}

function normalizeRank(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.trunc(n)
}

function normalizeDepth(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

function containsCjk(text) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(text)
}

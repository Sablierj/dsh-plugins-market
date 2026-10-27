/**
 * Keyword classification — the rules that turn raw facts into a decision.
 *
 * Ported from the hub's `03_merge_and_enrich.py` (plus `00_import_ad_xlsx.py`
 * and `10_extract_asin_keywords.py` for the parts that live there), with three
 * deliberate corrections. Each is a case where the Python version produced a
 * plausible answer that was wrong, which is the only kind of bug worth a
 * comment.
 *
 *   **1. `cvr` is a percentage, everywhere.** The ABA export reports
 *   `购买量：购买率%` as `1.1639` (percent) while the ad report's
 *   `广告转化率` is `0.0023` (a fraction). The hub compared both against `2`
 *   in the same expression. This module fixes the unit at *percent* and the
 *   importers convert at the boundary; `classifyFunnel` and `forListing` then
 *   have one unit to reason about.
 *
 *   **2. "No signal" is not "bench-cushion".** `detect_product_line` fell back
 *   to `bench-cushion` for every unmatched word, so an unclassifiable keyword
 *   was filed as a bench-cushion keyword and counted in that line's totals.
 *   `detectProductLine` returns the same default so the pipeline behaves
 *   identically, but also returns `matched`, and the master record keeps it.
 *
 *   **3. CJK listing text yields nothing, loudly.** `extract_ngrams` split on
 *   `\s` and so returned the entire Chinese title as one "word" for a CJK
 *   listing. `extractNgrams` returns `[]` plus a `cjk` flag instead, so the
 *   caller can report "not supported" rather than "no keywords found".
 *
 * Pure functions only — no store, no filesystem, no browser.
 */

/* The four-category reader and the positive-word projection. Imported from
   `signals.js`, which imports `PRODUCT_LINE_SIGNALS` back from this file — a
   cycle that is safe because each side only touches the other's binding inside a
   function, never while the modules are evaluating. */
import { positiveSignals, readSignalCategories } from './signals.js'

/* ────────────────────────── product line ────────────────────────── */

/**
 * Signal words per product line, ported verbatim from the hub.
 *
 * They are substring tests against the lowercased keyword, which makes the
 * *order* significant: `bench-cushion` lists `seat`, `pad` and `outdoor`, so
 * anything checked after it would be starved. The order below is the hub's and
 * puts the narrow lines first.
 *
 * This table is the **seed and the fallback**. v23 moved a line's own signals
 * into four categories in the store (`domain/keywords/signals.js`); this is what
 * a line with no configuration falls back to. It is imported *by* signals.js,
 * and this module imports the reader back — a cycle that is safe because neither
 * side reads the other's binding while the modules are evaluating, only inside
 * functions that run long afterwards.
 */
export const PRODUCT_LINE_SIGNALS = {
  'rocker-cushion': ['rocking chair', 'rocker', 'glider', 'nursery', 'ottoman', 'wingback', 'adirondack'],
  'jiuzhendian': ['patch', 'bandage', 'wound', 'acne', 'hydrocolloid', 'medical', '敷贴', '伤口', 'pimple', 'zit', 'boil', 'abscess'],
  'chair-cushion': ['chair cushion', 'office chair', 'dining chair', 'kitchen chair', 'bar stool', 'seat pad', 'chair pad', 'upholstery foam', 'high density foam', 'foam cushion', 'chair seat'],
  'flower-edge-cushion': ['flower', 'edge', 'embroidery', 'lace', 'ruffle', 'decorative'],
  'bench-cushion': ['bench', 'cushion', 'pad', 'pillow', 'seat', 'outdoor', 'window sill', 'bay window', 'patio'],
}

/** Check order, narrowest first. The last entry is the default. */
export const PRODUCT_LINE_ORDER = [
  'rocker-cushion', 'jiuzhendian', 'chair-cushion', 'flower-edge-cushion', 'bench-cushion',
]

export const DEFAULT_PRODUCT_LINE = 'bench-cushion'

/**
 * The signal lists to classify with, preferring the store over the constant.
 *
 * v17 moved `product_line.signals_json` out of code so a user can add a line
 * without a code change. The constant above stays as the **fallback**, and the
 * two states it falls back for are deliberately different:
 *
 *   - `NULL` — nobody ever configured this line. Use the constant, so a store
 *     that has never been edited behaves exactly like the code always did.
 *   - `'{}'` (or `'[]'`) — configured to be empty. Use it as-is, so "I turned
 *     this line's signals off" means nothing matches rather than silently
 *     reverting to the shipped list.
 *
 * Collapsing those two into "falsy → use the constant" is the bug this guard
 * exists for: it would make clearing a list look like it did nothing.
 *
 * Only lines that have a non-empty list are returned, so a line whose signals
 * were cleared stops matching while still appearing in `PRODUCT_LINE_ORDER` —
 * which is what makes an emptied line observable in the classification result
 * rather than invisible.
 */
export function productLineSignalsFrom(store) {
  if (store === null || store === undefined) return PRODUCT_LINE_SIGNALS

  let rows
  try {
    rows = store.all('SELECT id, signals_json FROM product_line')
  } catch {
    /* A store from before v17 has no such column. Falling back keeps an
       unmigrated database working instead of making classification the thing
       that fails first. */
    return PRODUCT_LINE_SIGNALS
  }

  const merged = { ...PRODUCT_LINE_SIGNALS }
  for (const row of rows) {
    const read = readSignalCategories(row.signals_json, row.id)
    /* `builtin` is a line that was never configured (keep the constant) and
       `broken` is one nobody can read (keep the constant, loudly, at the page).
       Neither is an instruction to change what matches. */
    if (read.mode === 'builtin' || read.mode === 'broken') continue
    /* core + scenario + material. `exclude` is the opposite kind of word, and a
       caller that merged it in would make every exclude word attract the very
       keywords it was meant to repel. */
    merged[row.id] = positiveSignals(read.signals)
  }
  return merged
}

/**
 * Which product line a keyword belongs to.
 *
 * @param {string} keyword
 * @param {object} [signals] per-line signal lists; defaults to the ported set
 * @returns {{ productLine: string, matched: string|null, productLines: string[] }}
 *   `matched` is the signal that fired, or null when the answer is only the
 *   default. `productLines` is every line that matched, for callers that want
 *   the multi-label view the ad importer used.
 */
export function detectProductLine(keyword, signals = PRODUCT_LINE_SIGNALS) {
  const text = String(keyword ?? '').toLowerCase()
  if (text === '') return { productLine: DEFAULT_PRODUCT_LINE, matched: null, productLines: [] }

  const order = Object.keys(signals)
  const hits = []
  for (const line of order) {
    const hit = (signals[line] ?? []).find(signal => signal !== '' && text.includes(signal))
    if (hit !== undefined) hits.push({ line, hit })
  }
  if (hits.length === 0) return { productLine: DEFAULT_PRODUCT_LINE, matched: null, productLines: [] }

  // The hub's priority order decides the single label; the full list is kept.
  const preferred = PRODUCT_LINE_ORDER.find(line => hits.some(entry => entry.line === line))
  const chosen = preferred ?? hits[0].line
  return {
    productLine: chosen,
    matched: hits.find(entry => entry.line === chosen)?.hit ?? null,
    productLines: hits.map(entry => entry.line),
  }
}

/* ──────────────────────── volume & funnel ──────────────────────── */

export const SV_TIERS = [
  { id: 'L1', label: 'L1-超级热词', min: 100_000 },
  { id: 'L2', label: 'L2-热词', min: 50_000 },
  { id: 'L3', label: 'L3-核心词', min: 10_000 },
  { id: 'L4', label: 'L4-长尾词', min: 1_000 },
  { id: 'L5', label: 'L5-长尾尾词', min: 0 },
]

/** Search-volume band. `null` volume is `L5` but flagged, not assumed. */
export function classifySvTier(searchVolume) {
  const sv = numberOr(searchVolume, null)
  if (sv === null) return { tier: 'L5', label: 'L5-长尾尾词', known: false }
  const found = SV_TIERS.find(entry => sv >= entry.min) ?? SV_TIERS[SV_TIERS.length - 1]
  return { tier: found.id, label: found.label, known: true }
}

export const FUNNELS = {
  TOFU: 'TOFU 泛需求（大词，先要曝光）',
  MOFU: 'MOFU 比较期（核心词，要转化）',
  BOFU: 'BOFU 决策期（长尾词，要成交）',
}

/**
 * Funnel stage from volume and conversion rate (percent).
 *
 * `cvr` is percent — see the module header. A caller holding a fraction must
 * convert first; passing `0.023` here reads as "0.023%" and lands in BOFU.
 */
export function classifyFunnel(searchVolume, cvrPercent) {
  const sv = numberOr(searchVolume, 0)
  const cvr = numberOr(cvrPercent, 0)
  if (sv >= 50_000) return 'TOFU'
  if (sv >= 10_000 || cvr >= 5) return 'MOFU'
  return 'BOFU'
}

/**
 * How much of this word we already own, from ABA brand-share percentages.
 *
 * `none` is the interesting value: it means the word has volume and we are
 * absent, which is the definition of an opportunity. It is also the value that
 * a missing ABA row produces — hence `ownStatus` is only meaningful together
 * with `hasAba`.
 */
export function classifyOwnStatus(brandClickPct, brandConvPct) {
  const click = numberOr(brandClickPct, 0)
  const conv = numberOr(brandConvPct, 0)
  if (click >= 1 || conv >= 0.5) return 'strong'
  if (click >= 0.1 || conv >= 0.1) return 'moderate'
  if (click > 0 || conv > 0) return 'weak'
  return 'none'
}

export const PRIORITY_MEANING = {
  P0: '核心词：搜索量 > 10,000 且转化率 > 2%',
  P1: '重要词：搜索量 1,000–10,000 且转化率 0.5–2%',
  P2: '长尾词：其余（含没有搜索量的）',
}

/**
 * The SOP's P0/P1/P2 — "how good is this word in the abstract".
 *
 * Distinct from `opportunityFor`, which asks "how much is there to gain for
 * *us*". A P0 word we already dominate is not an opportunity; a P2 word with no
 * brand presence can be. Collapsing the two would lose the second question.
 */
export function classifyPriority({ searchVolume, cvr }) {
  const sv = numberOr(searchVolume, null)
  const rate = numberOr(cvr, null)
  if (sv !== null && sv > 10_000 && rate !== null && rate > 2) return 'P0'
  if (sv !== null && sv >= 1_000 && sv <= 10_000 && rate !== null && rate >= 0.5 && rate <= 2) return 'P1'
  return 'P2'
}

/** The hub's `scores.priority`: opportunity given our current presence. */
export function opportunityFor({ ownStatus, searchVolume }) {
  const sv = numberOr(searchVolume, 0)
  if (ownStatus === 'none' && sv >= 10_000) return 'high'
  if ((ownStatus === 'weak' || ownStatus === 'none') && sv >= 5_000) return 'medium'
  return 'low'
}

/* ────────────────────────── modifiers ────────────────────────── */

/** Modifier vocabulary, ported from the hub (duplicates removed). */
export const MODIFIERS = [
  'indoor', 'outdoor', 'waterproof', 'thick', 'soft', 'high density',
  'foam', 'chenille', 'tufted', 'slip', 'replacement', 'clearance',
  'extra', 'large', 'small', 'mini', 'premium', 'set', 'covers',
  'washable', 'non-slip', 'cushioned', 'ergonomic', 'memory foam',
  'round', 'square', 'rectangle', 'oval', 'birthday', 'gift', 'nursery',
  'floor', 'chair', 'seat', 'car', 'kitchen', 'bay window',
  'patio', 'porch', 'garden', 'pool', 'balcony',
]

/** Modifiers present in a keyword, capped so one word cannot carry the list. */
export function extractModifiers(keyword, { limit = 10 } = {}) {
  const text = String(keyword ?? '').toLowerCase()
  if (text === '') return []
  return MODIFIERS.filter(modifier => text.includes(modifier)).slice(0, limit)
}

/* ─────────────────────── listing application ─────────────────────── */

/**
 * Where a word is worth using, from volume band and conversion.
 *
 * The hub gated on `sv_tier` numbers plus `sv` thresholds. Kept identical,
 * because these thresholds are the SOP's (§6.1–6.4) and changing them would
 * silently move words between the title and the backend — a change nobody would
 * notice until the listing was rewritten.
 *
 * `backend` is `true` unconditionally in the hub. That is not laziness: the
 * backend field takes whatever does not fit in the title, and "does not fit" is
 * a property of the finished title, not of the word. It is decided at export
 * time (§6.3 rule 1 — do not repeat title/bullet words).
 */
export function forListing({ searchVolume, svTier, cvr, role = 'unknown' }) {
  const sv = numberOr(searchVolume, 0)
  const rate = numberOr(cvr, 0)
  const tierNum = { L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 }[svTier] ?? 5
  /* 标题只放行 identity（身份词完整命中）。之前这里只看搜索量，实测后果是
     219 个够格词里 95 个既不含 bench 也不含 cushion —— `patio furniture set`
     会被写进标题，把主身份冲淡。其余位置不受影响：泛词仍可打广告。 */
  const onIdentity = role === 'identity'
  return {
    title: onIdentity && sv >= 10_000 && tierNum <= 3,
    bullets: onIdentity && sv >= 1_000 && tierNum <= 4,
    backend: true,
    adsExact: sv >= 5_000 && tierNum <= 3,
    adsPhrase: sv >= 2_000 && tierNum <= 4,
    adsBroad: sv >= 500 && rate >= 3,
  }
}

/* ───────────────────── n-gram extraction ───────────────────── */

/**
 * Stop words, ported from `10_extract_asin_keywords.py`.
 *
 * Brand names are in here on purpose: an ASIN title is full of its own brand,
 * and "rofiejox bench cushion" is not a keyword anybody searches for.
 */
export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'in', 'on', 'at', 'to',
  'with', 'your', 'our', 'you', 'is', 'are', 'it', 'its', 'this', 'that',
  'easy', 'perfect', 'great', 'best', 'lovely', 'nice', 'beautiful',
  'amazon', 'rofiejox', 'arden', 'detiblue', 'rofielty', 'ywamzdz',
  'com', 'selection', 'click', 'satisfaction', 'guarantee',
  'money', 'back', 'worry', 'free', 'care', 'wash', 'instructions',
])

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** Is the text mostly CJK? Used to refuse rather than to guess. */
export function isMostlyCjk(text) {
  const value = String(text ?? '')
  if (value === '') return false
  const cjk = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  const letters = (value.match(/[A-Za-z0-9]/g) ?? []).length
  return cjk > letters
}

/**
 * Word n-grams from listing text, 2–5 words, stop-word-trimmed.
 *
 * Returns `{ keywords, cjk, tokens }`. `cjk: true` means the text was mostly
 * CJK and nothing was extracted — deliberately, because the alternative is a
 * single "keyword" equal to the whole title.
 */
export function extractNgrams(text, { minLength = 2, maxLength = 5, stopWords = STOP_WORDS } = {}) {
  const value = String(text ?? '')
  if (value.trim() === '') return { keywords: [], cjk: false, tokens: 0 }
  if (isMostlyCjk(value)) return { keywords: [], cjk: true, tokens: 0 }

  const cleaned = value.replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim()
  const words = cleaned.toLowerCase().split(' ').filter(word => word !== '')
  if (words.length < minLength) return { keywords: [], cjk: false, tokens: words.length }

  const found = new Set()
  const upper = Math.min(maxLength, words.length)
  for (let n = minLength; n <= upper; n += 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const slice = words.slice(i, i + n)
      if (stopWords.has(slice[0]) || stopWords.has(slice[slice.length - 1])) continue
      const phrase = slice.join(' ')
      if (phrase.length < 3) continue
      if (/^[\d\s.,/-]+$/.test(phrase)) continue
      if (/^[\dx"]+$/.test(phrase)) continue
      found.add(phrase)
    }
  }
  return { keywords: [...found], cjk: false, tokens: words.length }
}

/* ───────────────────── third-party field parsing ───────────────────── */

/**
 * 卖家精灵 `关键词类型` / `流量词类型` → tags.
 *
 * The hub read only `关键词类型` (column 5). In the real exports that column is
 * **empty on many rows** while `流量词类型` (column 7) is populated — the first
 * data row of `竞品关键词数据ASIN-US-B0DS49VC81(823)-20260328.xlsx` is
 * `outdoor chair cushions`, traffic share 17.8%, with column 5 blank and column
 * 7 reading `自然搜索词`. Importing only column 5 therefore dropped the tags
 * for the single biggest traffic word in the file. Both columns are read here.
 */
export const KEYWORD_TYPE_LABELS = {
  主要流量词: 'primary_traffic',
  自然搜索词: 'organic',
  AC推荐词: 'ac_recommend',
  SP广告词: 'sp_ad',
  品牌广告词: 'brand_ad',
  视频广告词: 'video_ad',
  HR推荐词: 'hr_recommend',
  自然搜索: 'organic',
  自然: 'organic',
  AC: 'ac_recommend',
  SP: 'sp_ad',
  SB: 'brand_ad',
  SOR: 'organic',
}

/**
 * 卖家精灵 API `badges` enum → tags.
 *
 * The JSON dump carries its tags in two places: a human `position` string
 * (`自然搜索词/HR推荐词/SP广告词`) and this machine enum. Reading only one loses
 * words whose `position` is null but whose badges are populated, which happens
 * on the ad-only rows.
 */
export const BADGE_LABELS = {
  NATURAL_SEARCHING: 'organic',
  AMAZON_RECOMMENDED: 'ac_recommend',
  ADS: 'sp_ad',
  HIGHLY_RATED: 'highly_rated',
  NEW_RELEASE: 'new_release',
}

/** Tags from the `badges` array. Unknown badges pass through lowercased. */
export function parseBadgeTags(badges) {
  if (!Array.isArray(badges)) return []
  const tags = new Set()
  for (const badge of badges) {
    const key = String(badge ?? '').trim().toUpperCase()
    if (key === '') continue
    tags.add(BADGE_LABELS[key] ?? key.toLowerCase())
  }
  return [...tags]
}

/** Tags from one or more raw type strings (`A/B/C` separated). */
export function parseKeywordTypeTags(...rawValues) {
  const tags = new Set()
  for (const raw of rawValues) {
    const text = String(raw ?? '')
    if (text.trim() === '') continue
    // Split on the separators these exports use, then match each piece.
    for (const piece of text.split(/[/,、|;]/)) {
      const key = piece.trim()
      if (key === '') continue
      for (const [label, tag] of Object.entries(KEYWORD_TYPE_LABELS)) {
        if (key === label || key.includes(label)) tags.add(tag)
      }
    }
  }
  return [...tags]
}

/**
 * 卖家精灵 `自然排名` text → `{ rank, page, noRank, malformed }`.
 *
 * Five shapes occur in the real files:
 *   `4`                 a plain position on page 1
 *   `第1页 75/82`       page 1, position 75 of 82 results
 *   `第2页`             on page 2, position unknown
 *   `前3页无排名`       scanned three pages, absent — a real finding
 *   `中03.28 17:45`     a timestamp, i.e. the export's column drift
 *
 * The last one is why `malformed` exists: it is not "no rank", it is "this cell
 * holds a different column's value", and storing it as `rank: null` would turn
 * a broken export into a measured gap.
 */
export function parseOrganicRank(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { rank: null, page: null, noRank: false, malformed: false }
  if (/^\d+$/.test(text)) return { rank: Number(text), page: 1, noRank: false, malformed: false }

  const paged = /第\s*(\d+)\s*页\s*(\d+)\s*\/\s*(\d+)/.exec(text)
  if (paged !== null) return { rank: Number(paged[2]), page: Number(paged[1]), noRank: false, malformed: false }

  if (/前\s*\d+\s*页\s*无排名/.test(text) || /无排名/.test(text)) {
    return { rank: null, page: null, noRank: true, malformed: false }
  }

  const pageOnly = /第\s*(\d+)\s*页\s*$/.exec(text)
  if (pageOnly !== null) return { rank: null, page: Number(pageOnly[1]), noRank: false, malformed: false }

  return { rank: null, page: null, noRank: false, malformed: true }
}

/**
 * 西柚 `自然排名(页码-页内排名)` text → `{ rank, page, index }`.
 *
 * `P1-2` is page 1, second position — the same 16-per-page arithmetic the
 * browser scan uses (`organicRank` in `keyword-tiers.js`). The xiyou export
 * also carries a numeric `自然排名` column, so this is the fallback; the two
 * agreeing is what makes the fallback safe to use.
 */
export function parsePageRank(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { page: null, index: null, rank: null }
  const m = /^P(\d+)\s*-\s*(\d+)$/i.exec(text)
  if (m === null) {
    if (/^\d+$/.test(text)) return { page: null, index: null, rank: Number(text) }
    return { page: null, index: null, rank: null }
  }
  const page = Number(m[1])
  const index = Number(m[2])
  return { page, index, rank: (page - 1) * 16 + index }
}

/** `"$1.26"` / `"$1.06-$1.52"` → `{ low, high }`. */
export function parseBidRange(raw) {
  const text = String(raw ?? '').replace(/[$€£¥\s]/g, '')
  if (text === '') return { low: null, high: null }
  const parts = text.split(/[-–~至]/).filter(part => part !== '')
  const numbers = parts.map(part => numberOr(part, null)).filter(value => value !== null)
  if (numbers.length === 0) return { low: null, high: null }
  if (numbers.length === 1) return { low: numbers[0], high: numbers[0] }
  return { low: Math.min(...numbers), high: Math.max(...numbers) }
}

/** 西柚 `竞争难度档位` → a stable English token. */
export function parseDifficultyBand(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  if (text.includes('难') && !text.includes('中等')) return 'hard'
  if (text.includes('中')) return 'medium'
  if (text.includes('易')) return 'easy'
  return null
}

function numberOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

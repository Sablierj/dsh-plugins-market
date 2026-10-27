/**
 * What a change to a product line's signals would do, before it is made.
 *
 * The number this module produces has to be **the same number** the save path
 * reports afterwards, and the only way to guarantee that is for both to call
 * this one function. Two implementations would agree on the day they were
 * written and drift on the first day somebody fixed one of them — and the
 * symptom would be a preview that says "214 词" followed by a save that says
 * "209", which is worse than no preview at all, because it teaches the user the
 * number is not to be trusted.
 *
 * ## It is pure
 *
 * `classifyWithSignals` reads the store and writes nothing. `previewSignalImpact`
 * calls it twice — once with the proposed signals and once with the ones in
 * force — and subtracts. Calling the preview must not bump a version, and the
 * assertion that says so is what keeps this honest.
 *
 * ## What the two numbers mean
 *
 *   - `keywords` — how many library words this line would cover: they match one
 *     of its core / scenario / material words and none of its exclude words.
 *   - `asins` — how many of *our* ASINs those words are linked to.
 *
 * Neither is a count of the whole library, because "this line covers 214 of
 * 1,900 words" is a statement about the line, and "the library has 1,900 words"
 * is a statement about the library.
 *
 * ## `rejected` is a reserved slot
 *
 * The prototype shows a third number ("rejected: 1 high-volume word"). The PRD
 * does not, so nothing computes it — but the field is in the shape with the
 * value `0`, so adding that dimension later changes a number rather than a
 * signature. A caller reading `rejected` today reads the truth: nothing was
 * rejected, because nothing was checked for rejection.
 */

import { matchesSignals, readSignalCategories } from './signals.js'

/** How many changed words the delta carries before it stops listing them. */
const MAX_LISTED = 50

/**
 * Classify the keyword library against one signal set, for one line.
 *
 * Pure: no writes, no version bumps, no audit rows.
 */
export function classifyWithSignals(store, { productLineId, signals }) {
  const rows = store.all('SELECT keyword FROM kw_master')
  const matched = []
  for (const row of rows) {
    const keyword = String(row.keyword ?? '')
    if (keyword === '') continue
    if (matchesSignals(keyword, signals)) matched.push(keyword)
  }

  /* The ASINs are counted through `asin_keyword`, which is what links *our*
     products to the words. `kw_master.asin_count` counts the ASINs a competitor
     advertises on the word, which answers a different question. */
  const wanted = new Set(matched.map(keyword => keyword.toLowerCase()))
  const asins = new Set()
  for (const row of store.all('SELECT DISTINCT asin, keyword FROM asin_keyword')) {
    if (wanted.has(String(row.keyword ?? '').toLowerCase())) asins.add(row.asin)
  }

  return {
    productLineId: productLineId ?? null,
    keywords: matched.length,
    asins: asins.size,
    rejected: 0,
    matched,
  }
}

/**
 * The impact of replacing one line's signals, as a preview.
 *
 * `delta.added` / `delta.removed` are counts of *words that change side*, and
 * the word lists beside them are the same change made inspectable — a count
 * alone tells the user something happened and not what.
 */
export function previewSignalImpact(store, { productLineId, signals }) {
  const row = store.get('SELECT id, signals_json FROM product_line WHERE id = ?', [String(productLineId ?? '').trim()])
  if (row === undefined) throw new Error(`no product line "${productLineId}"`)

  const before = classifyWithSignals(store, {
    productLineId: row.id,
    signals: readSignalCategories(row.signals_json, row.id).signals,
  })
  const after = classifyWithSignals(store, { productLineId: row.id, signals })

  const beforeSet = new Set(before.matched.map(keyword => keyword.toLowerCase()))
  const afterSet = new Set(after.matched.map(keyword => keyword.toLowerCase()))
  const added = after.matched.filter(keyword => !beforeSet.has(keyword.toLowerCase()))
  const removed = before.matched.filter(keyword => !afterSet.has(keyword.toLowerCase()))

  return {
    productLineId: row.id,
    keywords: after.keywords,
    asins: after.asins,
    delta: { added: added.length, removed: removed.length },
    /* Capped, because this travels to a page and a tool result: a signals edit
       can move thousands of words, and the useful part is the shape of the
       change, not the full list. The counts above are the whole truth. */
    added: added.slice(0, MAX_LISTED),
    removed: removed.slice(0, MAX_LISTED),
    addedTruncated: added.length > MAX_LISTED,
    removedTruncated: removed.length > MAX_LISTED,
    rejected: 0,
    /** The state the line is in now, so the page can say "from N to M". */
    before: { keywords: before.keywords, asins: before.asins },
  }
}

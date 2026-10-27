/**
 * Per-ASIN reviews and buyer Q&A (module 05, F05-02 tab 6 of 9).
 *
 * ## Where reviews actually live
 *
 * Not in a `review` table — there is none. The collector reads the `reviews`
 * collection section and stores the parsed reading in
 * `collection_section_result.parsed_value_json` (`store/schema.js`, section roster
 * in `domain/collect/sections.js`): `reviews_total`, `reviews_visible`,
 * `review_summary`, `review_items`. This module reads that **same** reading the
 * `sections` tab already read — `buildSectionView`'s output is injected, exactly
 * the way `buildAsinHealthSummary` takes `fields` and `precheck` — so "which row is
 * the newest reading of this section" has one implementation and one answer on one
 * page.
 *
 * ## Four states, because three of them look alike and are not
 *
 * The interesting failure mode of a reviews panel is saying "no reviews" when what
 * happened is "we never read this section" or "we tried and the selector missed".
 * Those three send the reader to three different places, so they are three states:
 *
 *   `never-collected`  there is no reading for this section at all → go collect.
 *   `unreadable`       there is a reading and the attempt itself failed or was
 *                      blocked → go find out why the reader stopped.
 *   `empty`            the attempt succeeded and the page carried no review data
 *                      → the product genuinely has none visible, or the page
 *                      renders reviews client-side.
 *   `ok`               at least one of the four cells carries a value. A product
 *                      with `reviews_total === 0` is **`ok`**: that zero is a
 *                      measurement, and printing it as "nothing" is the lie this
 *                      module exists to avoid.
 *
 * "Did this cell carry a value" is `sectionValueCounts` — the same judgement the
 * 13-section tab and the collection panel use. It is imported, never re-expressed:
 * a local `value !== null` test would call `{title: ''}` a collected review, which
 * is the trap that function documents.
 *
 * ## Q&A is a different kind of hole, and says which kind
 *
 * `qa_1..qa_8` exist as **listing field declarations** (`domain/rules/listing-fields.js`,
 * `amazonPath: customer_questions_and_answers`), but no collection section reads
 * them and the optimizer marks the whole kind `notModelled`
 * (`domain/optimize/evidence.js`). So this is "nothing in this repository writes
 * it" — a structural hole — not "we tried and got nothing". It goes in
 * `unsourced[]`, and it must never be rendered as an empty list of questions.
 */

import { ASIN_NO_SOURCE_TEXT, unsourced } from './unsourced.js'
import { resolveReviewFamily } from '../../store/review.js'
import { readReviewAnalysis } from './review-analysis-run.js'
import { sectionValueCounts } from '../collect/sections.js'
import { countVerdict } from '../ui/count-verdict.js'

/** The four cells of the `reviews` section, with the labels the page prints. */
export const ASIN_REVIEW_FIELD_LABELS = {
  reviews_total: '评论总数',
  reviews_visible: '页面可见条数',
  review_summary: '评论摘要',
  review_items: '逐条样本',
}

export const ASIN_REVIEW_STATES = ['ok', 'empty', 'never-collected', 'unreadable']

export const ASIN_REVIEW_STATE_LABELS = {
  ok: '有评论读数',
  empty: '采到了、评论这一节是空的',
  'never-collected': '从没采过评论这一节',
  unreadable: '试过、这一节没读出来',
}

/** How many review samples are handed to a reader. */
export const REVIEW_ITEM_LIMIT = 50

/** The section id this module reads. Not a second roster — it is a lookup key. */
export const REVIEW_SECTION_ID = 'reviews'

export const ASIN_REVIEW_QA_REASON =
  'Q&A 有字段声明（qa_1..qa_8，src/domain/rules/listing-fields.js:152-159，'
  + 'amazonPath customer_questions_and_answers），但 13 个采集节里没有一节读它'
  + '（src/domain/collect/sections.js:53-105），优化器自己也把它标成 notModelled'
  + '（src/domain/optimize/evidence.js:418）。所以「有字段」不等于「有来源」：'
  + '本仓没有任何一条路径把 Q&A 写进库。'

/**
 * The section statuses that mean "the attempt itself did not produce a reading".
 *
 * Taken from the five-state collection vocabulary (`domain/states.js`), not
 * invented here: `failed` is "we could not tell", `blocked` is "a bot check or a
 * login wall stopped us". Neither is "the page had no reviews".
 */
const UNREADABLE_SECTION_STATUSES = ['failed', 'blocked']

/**
 * `ok` / `empty` / `never-collected` / `unreadable`, first hit wins.
 *
 * The order **is** the criterion. `never-collected` is tested before `unreadable`
 * because a section with no row cannot have failed — its status does not exist.
 */
export function classifyReviewState(section) {
  if (section === null || section === undefined || section.notCollected === true) return 'never-collected'
  if (UNREADABLE_SECTION_STATUSES.includes(String(section.status ?? ''))) return 'unreadable'
  const counts = sectionValueCounts(REVIEW_SECTION_ID, section.parsedValue)
  if (counts === null) return 'unreadable'
  return counts.collected === 0 ? 'empty' : 'ok'
}

const blankToNull = value => {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** The four cells of the reading, each saying whether **it** carried a value. */
function fieldCells(parsedValue) {
  const record = parsedValue !== null && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
    ? parsedValue
    : {}
  const counts = sectionValueCounts(REVIEW_SECTION_ID, parsedValue)
  const missing = new Set(counts === null ? [] : counts.missing)
  return Object.entries(ASIN_REVIEW_FIELD_LABELS).map(([id, label]) => ({
    id,
    label,
    present: !missing.has(id),
    value: record[id] === undefined ? null : record[id],
  }))
}

/**
 * One ASIN's review reading.
 *
 * `sections` is **required** and injected. Passing `undefined` throws instead of
 * silently reading the table again: a second read here would be a second answer to
 * "which reading is the current one", and the two would eventually disagree on a
 * page that shows both.
 */
export function buildAsinReviewView(store, { asin, marketplace, sections } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (key === '') return { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }
  if (market === '') return { ok: false, code: 'BAD_REQUEST', error: 'marketplace is required' }
  if (sections === undefined || sections === null || !Array.isArray(sections.sections)) {
    throw new Error('buildAsinReviewView needs the section view (buildSectionView output) — '
      + 'reading the section table a second time would be a second answer to "which reading is current"')
  }

  const section = sections.sections.find(entry => entry.section === REVIEW_SECTION_ID) ?? null
  const state = classifyReviewState(section)
  const parsed = section === null || section.notCollected === true ? null : (section.parsedValue ?? null)
  const fields = fieldCells(parsed)

  const rawItems = parsed !== null && Array.isArray(parsed.review_items) ? parsed.review_items : []
  const itemsTruncated = rawItems.length > REVIEW_ITEM_LIMIT
  const items = rawItems.slice(0, REVIEW_ITEM_LIMIT).map((item, index) => ({
    index: index + 1,
    rating: item?.rating ?? null,
    title: blankToNull(item?.title),
    body: blankToNull(item?.text),
  }))

  /* `null`, not `0`, when the cell is absent. A `0` in `reviews_total` means the
     page said "0 reviews"; a missing cell means the page said nothing. */
  const totals = {
    reviewsTotal: parsed === null || parsed.reviews_total === undefined ? null : parsed.reviews_total,
    reviewsVisible: parsed === null || parsed.reviews_visible === undefined ? null : parsed.reviews_visible,
  }
  /* D-9 挂点（LLD §0.3 强制引用）：计数格的判读走 domain 单一实现 countVerdict ——
     「未取到」= 0/缺 + 无观测时间，「测出来的 0」= 0 + 有观测时间。展示层只引不重写。 */
  const observedAt = section === null ? null : (section.collectedAt ?? section.observedAt ?? null)
  const countVerdicts = {
    reviewsTotal: countVerdict(totals.reviewsTotal, observedAt),
    reviewsVisible: countVerdict(totals.reviewsVisible, observedAt),
  }

  const notes = []
  if (itemsTruncated) {
    notes.push(`这次读数带 ${rawItems.length} 条评论样本，只印前 ${REVIEW_ITEM_LIMIT} 条 —— `
      + '「没印出来」与「读数里没有」不是一件事。')
  }
  if (state === 'ok' && String(countVerdicts.reviewsTotal) === '0（测出来的）') {
    notes.push('评论总数是 0 —— 这是**测出来的 0**（页面说了 0 条），不是「没有数据」。')
  }
  if (section !== null && section.contentUnread === true) {
    notes.push('这一节标记为「看见了、却没读出来」—— 页面上有评论区，但解析器一条都没拿到。')
  }

  return {
    ok: true,
    asin: key,
    marketplace: market,
    source: 'collection_section_result#reviews',
    state,
    stateLabel: ASIN_REVIEW_STATE_LABELS[state],
    section: section === null ? null : {
      id: section.section,
      label: section.label,
      order: section.order,
      status: section.status ?? null,
      statusLabel: section.statusLabel ?? null,
      notCollected: section.notCollected === true,
      collectedAt: section.collectedAt ?? null,
      taskId: section.taskId ?? null,
      schemeVersion: section.schemeVersion ?? null,
      snapshotRef: section.snapshotRef ?? null,
      contentUnread: section.contentUnread === true,
      errors: Array.isArray(section.errors) ? section.errors : [],
      readTruncated: section.readTruncated === true,
    },
    totals,
  countVerdicts,
    summary: parsed === null ? null : blankToNull(parsed.review_summary),
    items,
    itemCount: rawItems.length,
    itemsTruncated,
    fields,
    fieldsPresent: fields.filter(cell => cell.present).length,
    states: [...ASIN_REVIEW_STATES],
    stateLabels: { ...ASIN_REVIEW_STATE_LABELS },
    fieldLabels: { ...ASIN_REVIEW_FIELD_LABELS },
    unsourced: [unsourced({
      id: 'qa-pairs',
      label: '买家问答（Q&A）',
      feature: 'F05-02',
      reason: ASIN_REVIEW_QA_REASON,
    })],
    /* T70 评论分析（O-01 拍板后）：最近一次 run 的载荷；没跑过 → hasRun:false
       （「没跑过」≠「跑了是 0 个痛点」——四态口径，页面照此分话）。
       家族口径：评论按**父 ASIN** 聚（铁律 2），子体进来先经 resolveReviewFamily 解析。 */
    reviewAnalysis: readReviewAnalysis({
      store,
      parentAsin: resolveReviewFamily(store, { asin: key, marketplace: market }),
      marketplace: market,
    }),
    noSourceText: ASIN_NO_SOURCE_TEXT,
    notes,
  }
}

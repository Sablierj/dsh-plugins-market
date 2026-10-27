/**
 * Turning one page reading into the thirteen `collection_section_result` rows
 * (module 04 F04-07, contract §4.2).
 *
 * ## Why this module exists
 *
 * `store/collection-section.js` writes the rows and `domain/collect/sections.js`
 * knows the thirteen sections; neither of them knows **which page reading became
 * which verdict**. That decision lived nowhere in this repository, which is why
 * `collection_section_result` had zero rows in production while five tables,
 * twelve tools, eight routes and a page were built on top of it — verified on a
 * live collection on 2026-10-09: `ok:true / written:1 / selectorMiss:0` and the
 * table still empty.
 *
 * ## The five states are derived here, never reported by the caller
 *
 * The caller hands in a *page verdict* (`ok` / `unexpected` / `blocked` /
 * `notfound`) plus what the page literally said. The status of a section is then
 * a pure function of **content**:
 *
 *   · every declared field carries a value      → `collected`
 *   · some do, some do not                      → `partial`
 *   · none do, on a page that parsed            → `missing`   (亚马逊确实没有)
 *   · none do, on a page that did NOT parse     → `failed`    (我们没测出来)
 *   · the request was cut off by a bot check    → `blocked`
 *
 * There is deliberately **no `status` parameter anywhere in this module**. The
 * shape this batch exists to correct is a writer that says `status: 'collected'`
 * next to a one-field payload (`tests/b04-collect-tools.mjs:1183` builds exactly
 * that row, and `:1201` asserts `collected:1` on it) — a writer that can be told
 * its verdict will eventually be told a wrong one, and nothing downstream
 * recomputes it. Here the verdict cannot be handed in, and
 * `collectedIsComplete` is checked again after derivation, so a drift between
 * "how much we counted" and "how much we claim" is caught rather than stored.
 *
 * ## `missing` and "not measured" are different rows, not different labels
 *
 * A section of a target nobody reached produces **no row at all**: this module is
 * only ever called for a target whose page was read, and a task stopped at ASIN
 * #3 writes rows for #1, #2 and #3 and none for the rest. A section we reached
 * and could not read is a `failed` row; a section the page simply does not have
 * is a `missing` row. Writing no row for the third case would make "we never
 * looked" and "Amazon has none" the same thing on the 13-section page.
 */

import { COLLECTION_SECTIONS, sectionValueCounts, reviewsVisibleVerdict } from './sections.js'
import { COLLECTION_SECTION_STATES } from '../states.js'

/**
 * The page verdicts this module understands.
 *
 * A closed set so an unknown verdict is a programming error rather than
 * something that silently falls through to `missing` — the fall-through would
 * turn an unmodelled page into a statement about Amazon. The four are exactly
 * the verdicts the extractor emits (`src/sources/pages/amazon.js`), which is why
 * "some other page" is not a fifth one.
 */
export const SECTION_PAGE_STATUSES = ['ok', 'unexpected', 'blocked', 'notfound']

/**
 * Statuses a *whole page* forces on every one of its sections.
 *
 * `blocked` and `notfound` are verdicts about the request, not about a region of
 * the document, so they are applied to the thirteen uniformly: the page never
 * rendered, and per-section parsing cannot be more precise than that.
 *
 * They are still written (rather than skipped) because "we tried this ASIN and
 * were shut out" and "we never tried this ASIN" are different facts, and only
 * the second one is allowed to produce no rows.
 *
 * `notfound` maps to `failed` and **not** to `missing`: a 404 says "we got no
 * page", it does not say "Amazon publishes no Best Sellers Rank for this
 * product". `missing` is a claim about a section of a rendered page.
 */
const PAGE_FORCED_STATUS = { blocked: 'blocked', notfound: 'failed' }

/**
 * The one place where an empty field list means two different things.
 *
 * `variations.children` is `[]` both when the page renders no variant tile and
 * when the page renders tiles this reader could not recognise — and those are
 * not the same fact. The first is a statement about Amazon; the second is a
 * statement about us. Measured on a live listing on 2026-10-10: **12** child
 * ASINs sat on `li[data-asin]` inside the Color row while the reader's child
 * selector matched nothing, and the stored row read `partial 1/3` — in the table
 * indistinguishable from a listing that genuinely has no variants, and quieter
 * than the `missing` it used to be.
 *
 * The two are told apart by a **measurement in the payload**, never by a flag the
 * reader sets about itself: `child_tiles` is how many ASIN-bearing tiles the
 * child reading looked at. The verdict is therefore recomputable from the stored
 * row alone:
 *
 *   · `children: []` and `child_tiles > 0`  → we saw them and read none → `failed`
 *   · `children: []` and `child_tiles: 0`  → the page has none      → the verdict
 *     the field counts give it: `partial` when the dimension row was read, `missing`
 *     when nothing at all was
 *   · `children: [...]`                     → the question does not arise
 *
 * A **missing** `child_tiles` (a row written before this field existed, a
 * non-Amazon source, a reading that never reached the page reader) is not read as
 * `0`: "not measured" must not be turned into a measurement, so the predicate
 * stays false and the row keeps whatever verdict its field counts give it.
 *
 * Returns the measurement it decided from, so a caller — and the audit below —
 * can show the arithmetic instead of the conclusion.
 */
export function variationsChildrenUnread(parsedValue) {
  const record = parsedValue !== null && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
    ? parsedValue
    : null
  const children = record === null || !Array.isArray(record.children) ? null : record.children
  const tiles = record === null || !Number.isFinite(record.child_tiles) ? null : record.child_tiles
  const count = children === null ? null : children.length
  if (children === null || tiles === null) return { unread: false, tiles, children: count, reason: null }
  if (count > 0) return { unread: false, tiles, children: count, reason: null }
  if (tiles <= 0) return { unread: false, tiles, children: 0, reason: null }
  return {
    unread: true,
    tiles,
    children: 0,
    reason: `变体行里有 ${tiles} 个带 ASIN 的色块，却一个子 ASIN 都没解析出来（子选择器可能已过期）`,
  }
}

/**
 * The five-state verdict for one section, from content.
 *
 * `error` is "this section's extraction threw"; `counts` is what
 * `sectionValueCounts` measured; `parsedValue` is the payload those counts were
 * taken from, and is used only by the one rule that a count cannot express (see
 * `variationsChildrenUnread`). All three are inputs to a rule, not answers —
 * this function is the only place that turns them into one of the closed five.
 */
export function sectionRecordStatus({ pageStatus, error = null, counts = null, parsedValue = null } = {}) {
  if (!SECTION_PAGE_STATUSES.includes(pageStatus)) {
    throw new Error(`page status "${pageStatus}" is not one of ${SECTION_PAGE_STATUSES.join(' / ')}`)
  }
  const forced = PAGE_FORCED_STATUS[pageStatus]
  if (forced !== undefined) return forced
  // A section we could not even read is "we did not find out", which is what
  // `failed` means. It is never `missing`: that word is a claim about the page.
  if (error !== null && error !== undefined) return 'failed'
  if (counts === null) return 'failed'
  /* Before the "nothing at all" branch, not after it: a page whose variant row
     rendered 12 ASIN-bearing tiles and yielded none of them must not be able to
     fall through to `missing` ("Amazon has no variations") just because the
     dimension row was missed too — that is the original defect one layout
     further on, and it is the louder half of the same mistake. */
  if (variationsChildrenUnread(parsedValue).unread) return 'failed'
  /* T69（铁律 3）：reviews 的 n/N 内容级判据在字段覆盖之前 —— 0/N 是 partial 含
     0 条（不是 missing），0/0 是 collected（页面明示无评论如实 0 条）。与
     variationsChildrenUnread 同一形状：判据从解析值可复算，不是写入方自报。 */
  const reviews = reviewsVisibleVerdict(parsedValue)
  if (reviews.decided) return reviews.state
  if (counts.total === 0 || counts.collected === 0) {
    // The page parsed (status `ok`) and this section still yielded nothing →
    // Amazon does not have it. The page did **not** parse (`unexpected` — the
    // title selector missed, i.e. our knowledge of the DOM is stale) → we cannot
    // tell whether the section is absent or unreadable, and §4.2 says `failed`.
    return pageStatus === 'ok' ? 'missing' : 'failed'
  }
  if (counts.collected < counts.total) return 'partial'
  return 'collected'
}

/**
 * Does a `collected` claim actually cover every declared field?
 *
 * The consistency check between "the status we wrote" and "the payload we wrote
 * next to it". `sectionValueCounts` already answers it, so this is not a second
 * definition of coverage — it is the one place that pairs the answer with the
 * decision to call a row `collected`.
 *
 * `total > 0` is required on purpose: a dynamic section (`attributes`) with no
 * keys at all is `0 / 0`, and reading that as "everything is there" is the bug
 * `sections.js` names at `sectionValueCounts`.
 */
export function collectedIsComplete(sectionId, parsedValue) {
  const counts = sectionValueCounts(sectionId, parsedValue)
  if (counts === null) return { ok: false, counts: null, missing: [], reason: 'unknown section' }
  /* T69：reviews 的「完整」由内容判据说了算（n/N 达成），字段覆盖不重复裁 ——
     页面明示无评论（0/0）时 review_summary 是空的，字段覆盖 3/4 会把 collected
     降级成 partial，而 LLD §1.2.3 明确 0/0 → collected 0 条如实。 */
  const reviews = reviewsVisibleVerdict(parsedValue)
  if (reviews.decided) {
    return reviews.short
      ? { ok: false, counts, missing: [], reason: reviews.reason }
      : { ok: true, counts, missing: [], reason: null }
  }
  if (counts.total === 0) return { ok: false, counts, missing: [], reason: 'no declared field had a value to compare against' }
  if (counts.collected < counts.total) {
    return { ok: false, counts, missing: counts.missing, reason: `${counts.collected}/${counts.total}` }
  }
  return { ok: true, counts, missing: [], reason: null }
}

/**
 * Is a row **that was already stored** consistent with its own payload?
 *
 * This is the check the corrected defect is about: until now the five states
 * were self-reported at the write site and the counts were recomputed by whoever
 * read the table, with **no consistency check between the two**. A reader that
 * recomputes cannot repair a bad claim, so the claim has to be audited where it
 * was made — and it has to be audited against what actually landed in the
 * database, not against the object the writer still holds in memory. That is not
 * pedantry: `JSON.stringify({title: undefined})` is `{}`, so a record whose
 * fields are `undefined` counts as complete before the write and as empty after
 * it. Only the stored row can answer the question.
 *
 * Returns `null` when consistent, or `{code, detail}` describing the drift.
 */
export function auditStoredSectionResult(row) {
  if (row === null || row === undefined) return { code: 'ROW_MISSING', detail: '写完读回来是空的' }
  const section = String(row.section ?? '').trim()
  const counts = sectionValueCounts(section, row.parsedValue ?? null)
  if (counts === null) {
    return { code: 'UNKNOWN_SECTION', detail: `section "${section}" 不在 13 节词表里` }
  }
  /* The `variations` half of the same question, in both directions: the payload
     carries the measurement that decides whether an empty `children` means "the
     page has none" or "we recognised none", so a row whose status disagrees with
     its own payload is exactly the drift this function exists to catch. Checked
     before the `collected` branch because it applies to every status, and derived
     from `parsedValue` alone — nothing here trusts a flag the writer set.
     (The collector's generic correction rewrites an unknown code to `partial`,
     which for this one is still not the truth; the payload keeps saying what
     happened either way, and the reason travels in `errors_json`.) */
  const unread = variationsChildrenUnread(row.parsedValue ?? null)
  if (unread.unread === true && row.status !== 'failed') {
    return { code: 'VARIATION_CHILDREN_UNREAD', detail: `${unread.reason}，但 status=${row.status}` }
  }
  if (row.status === 'failed' && unread.children !== null && unread.children > 0) {
    return { code: 'VARIATION_CHILDREN_READ', detail: `status=failed 但解析值里有 ${unread.children} 个子 ASIN` }
  }
  if (row.status === 'collected') {
    const check = collectedIsComplete(section, row.parsedValue ?? null)
    if (check.ok !== true) {
      return {
        code: 'STATUS_OVERCLAIMED',
        detail: `status=collected 但解析值只覆盖 ${check.reason}`,
      }
    }
    return null
  }
  /* Under-claiming is not dangerous the way over-claiming is, but it is still a
     disagreement between what the payload says and what the row says — and a
     silent one. Reporting it keeps "the two definitions moved apart" visible in
     both directions; only the over-claim is rewritten, because only that one
     tells a reader something false. */
  if (row.status === 'partial' && counts.total > 0 && counts.collected === counts.total
    && !(reviewsVisibleVerdict(row.parsedValue ?? null).short)) {
    /* T69：reviews 的内容级 partial（n/N 受限）不算 under-claim —— 字段覆盖 4/4
       而可见 3/10 的行是**正确的 partial**，不是「明明读全了却说部分」。 */
    return {
      code: 'STATUS_UNDERCLAIMED',
      detail: `status=partial 但解析值覆盖了全部 ${counts.total} 个声明字段`,
    }
  }
  return null
}

/** The thirteen, in contract order, each with the fields a reading must cover. */
function declaredSections() {
  return COLLECTION_SECTIONS
}

/**
 * Build the thirteen records for **one target whose page was read**.
 *
 * `page` is `{ status, sections }` where `sections` is the extractor's own map
 * (`{ [id]: {pageRegion, rawValue, parsedValue, selectorHits, errors, error} }`).
 * When the page never rendered (`blocked` / `notfound`) `sections` is `null` and
 * `evidence` — the little that is known about the page — becomes the raw value,
 * because "what did we see" must not be an empty cell even then.
 *
 * Returns records shaped for `store/collection-section.js#recordSectionResult`,
 * always all thirteen, always in contract order.
 */
export function buildSectionRecords({
  page = {},
  observedAt = null,
  schemeVersion = null,
  snapshotRef = null,
  evidence = null,
} = {}) {
  const status = page?.status
  if (!SECTION_PAGE_STATUSES.includes(status)) {
    throw new Error(`page status "${status}" is not one of ${SECTION_PAGE_STATUSES.join(' / ')}`)
  }
  const readings = page?.sections ?? null
  const forced = PAGE_FORCED_STATUS[status]

  return declaredSections().map((definition) => {
    if (forced !== undefined) {
      return {
        section: definition.id,
        status: forced,
        rawValue: evidence,
        parsedValue: null,
        pageRegion: null,
        selectorHits: null,
        errors: [],
        collectedAt: observedAt,
        schemeVersion,
        /* No snapshot exists for a page that never rendered, and pointing at the
           previous one would claim this reading came from it. */
        snapshotRef: null,
      }
    }

    const reading = readings === null || readings === undefined ? null : readings[definition.id] ?? null
    if (reading === null) {
      /* The extractor did not report this section at all. That is not "the page
         has nothing" — it is a hole in the reader, and it must read as `failed`
         with a reason rather than as `missing`. */
      return {
        section: definition.id,
        status: 'failed',
        rawValue: evidence,
        parsedValue: null,
        pageRegion: null,
        selectorHits: null,
        errors: [{ code: 'NOT_READ', detail: `${definition.id} 不在采集器的节读数里` }],
        collectedAt: observedAt,
        schemeVersion,
        snapshotRef,
      }
    }

    const error = reading.error ?? null
    /* The counts are computed here from `parsedValue`, never taken from the
       reader: a reader that reported its own counts would be the self-reporting
       writer this batch removes, one layer down. */
    const counts = sectionValueCounts(definition.id, reading.parsedValue ?? null)
    let derived = sectionRecordStatus({ pageStatus: status, error, counts, parsedValue: reading.parsedValue ?? null })
    const errors = [...(reading.errors ?? [])]
    if (error !== null) errors.push({ code: 'SECTION_ERROR', detail: String(error) })

    /* `failed` says "we did not find out"; a reader of the row is owed **what**
       we did not find out. The code is derived from the same payload measurement
       the verdict is, so the two cannot disagree — and unlike a flag the reader
       sets about itself, it can be recomputed from the stored row by
       `variationsChildrenUnread`, which is what `auditStoredSectionResult` does. */
    const unread = variationsChildrenUnread(reading.parsedValue ?? null)
    if (unread.unread && derived === 'failed') {
      errors.push({ code: 'VARIATION_CHILDREN_UNREAD', detail: unread.reason })
    }

    /* The belt to the derivation's braces. If the two could ever disagree, the
       row must not be stored claiming a coverage the payload does not have — and
       the disagreement must be loud, because it means one of the two definitions
       moved. */
    if (derived === 'collected') {
      const check = collectedIsComplete(definition.id, reading.parsedValue ?? null)
      if (check.ok !== true) {
        derived = 'partial'
        errors.push({
          code: 'STATUS_DOWNGRADED',
          detail: `collected 被降级为 partial：解析值只覆盖 ${check.reason}`,
        })
      }
    }

    if (!COLLECTION_SECTION_STATES.includes(derived)) {
      throw new Error(`derived status "${derived}" is not one of ${COLLECTION_SECTION_STATES.join(' / ')}`)
    }

    return {
      section: definition.id,
      status: derived,
      rawValue: reading.rawValue ?? null,
      parsedValue: reading.parsedValue ?? null,
      pageRegion: reading.pageRegion ?? null,
      selectorHits: reading.selectorHits ?? null,
      errors,
      collectedAt: observedAt,
      schemeVersion,
      snapshotRef,
    }
  })
}

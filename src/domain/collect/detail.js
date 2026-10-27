/**
 * The 13-section detail builder (module 04 F04-07; contract §4.4).
 *
 * ## One builder, two doors
 *
 * `amzn_collect_detail` and `GET /api/sections` return the same shape because
 * they call this: the tool is what the agent reads and the route is what the page
 * draws, and a second implementation is how the two would come to disagree about
 * what a section's status is. The contract says so explicitly ("同一 builder，
 * 两条路径不能给两个答案").
 *
 * ## Sections that were never attempted are reported, but not as `missing`
 *
 * The five section states are a **closed** vocabulary, and none of them means
 * "we did not look at this part at all". Calling an unattempted section
 * `missing` would say Amazon does not have a description when in truth nobody
 * opened the page for it — the exact confusion (`missing` vs `failed`) the
 * vocabulary exists to prevent. So an unattempted section comes back with
 * `status: null` and `notCollected: true`, and it is **not** counted in
 * `summary`: the summary is a count of rows that exist, which is also what makes
 * acceptance 20 (one section per state → five counts) exact.
 *
 * ## `raw` is behind a flag, `diff` is not
 *
 * A description or an A+ body is up to 64 KB (contract §3), and the page asks for
 * one ASIN at a time — so the raw reading is opt-in. The diff is three short
 * lists and is on by default; it is the answer to "what changed since last
 * time", which is most of the reason to open this panel.
 */

import { COLLECTION_SECTIONS, SECTION_BY_ID, normalizeSectionIds, sectionContentUnread, sectionValueCounts } from './sections.js'
import { getCollectionTask } from '../../store/queries.js'
import {
  listSectionResultsWithCoverage, sectionSummaryWithCoverage, taskAsinSummariesWithCoverage,
} from '../../store/collection-section.js'

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** The task's target list, parsed. A malformed row yields `[]`, not a throw. */
function safeParseList(text) {
  try {
    const value = JSON.parse(text ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/**
 * One section's row, plus the counts the page prints.
 *
 * `collected` / `total` are derived from the stored `parsed_value_json` through
 * the vocabulary's own counter, never from the row's status: a row can be
 * `partial` with a parsed value that has since been rewritten by a retry, and
 * printing the status as if it were a count is how "11/11, partially collected"
 * appears on screen.
 *
 * `contentUnread` is here for the same reason `collected` / `total` are: it is
 * the **builder's** answer to a question about this row, and the reader prints
 * what it is given. It used to be missing from this payload, and `page.js`
 * covered the gap by recomputing the rule inline for this one call site — a
 * second implementation that agreed with the ASIN-detail payload right up until
 * one of them changed, at which point the page quietly used its own copy and
 * **no assertion failed**. One rule, computed once, carried by both payloads.
 *
 * ## "No row" is not "0 of N" (T73k)
 *
 * A section with no row used to come back with `collected: 0` next to a real
 * denominator, so the page drew `0/N 已采` — the same reading as "we read the
 * page and not one field had a value". Those two call for opposite actions
 * (go and collect it vs. go and fix the selector), and nothing in the payload
 * distinguished them except a flag the number contradicted. So `collected` is
 * **null** when there is no reading, and `0` only when a reading really carried
 * nothing. `total` stays the declared field-list length either way: removing the
 * denominator is worse than removing the numerator, and `0/0` reads as
 * "complete". `domain/asin/sections.js` states the same rule for the same
 * reason — the two builders are two doors onto one fact.
 */
function sectionEntry(definition, row) {
  const base = {
    section: definition.id,
    label: definition.label,
    order: definition.order,
  }
  if (row === null || row === undefined) {
    return {
      ...base,
      status: null,
      notCollected: true,
      /* There is no reading, so there is no numerator. See the header note: `0`
         here would be a fabricated reading, and the page prints it as `0/N`. */
      collected: null,
      total: definition.fields.length,
      /* No reading means no missing list either, so it is **null**, not `[]`
         (T73k, second pass): an empty array next to a section nobody ever opened
         says "nothing is missing" — the same fabricated reading as `collected: 0`.
         Both page readers guard with `Array.isArray(...)`, so the screen is
         identical; `t73k` pins those guards so removing one goes red here instead
         of throwing on `null.length` in production. */
      missingFields: null,
      collectedAt: null,
      schemeVersion: null,
      snapshotRef: null,
      /* 未采集的节永远不带「没读到」标记 —— 那不是「看见了读不出」，是「根本没看过」。
         显式给 false（而不是留空），否则读者要靠 `undefined` 去猜，而「没有这个字段」
         与「这个字段是假的」在页面上长得一样。 */
      contentUnread: false,
    }
  }
  const counts = sectionValueCounts(definition.id, row.parsedValue)
  /* The second half of the same rule: "we could not count this" is not "we
     counted zero". `sectionValueCounts` returns null only for a section id that
     is not in the vocabulary, and every id here comes from `COLLECTION_SECTIONS`
     — so this branch is unreachable by construction. That is exactly why it must
     not fabricate a reading: the day someone widens where ids come from, an
     unreachable lie becomes a reachable one. A null numerator plus a named
     reason cannot be mistaken for a measurement. */
  if (counts === null) {
    return {
      ...base,
      status: row.status,
      statusLabel: row.statusLabel,
      notCollected: false,
      collected: null,
      total: definition.fields.length,
      /* Could not count this row at all, so there is no missing list to give —
         see the note above: `[]` would claim "nothing is missing". */
      missingFields: null,
      countsUnavailable: true,
      collectedAt: row.collectedAt,
      schemeVersion: row.schemeVersion,
      snapshotRef: row.snapshotRef,
      errors: row.errors,
      parsedValue: row.parsedValue,
      contentUnread: sectionContentUnread({ notCollected: false, errors: row.errors, parsedValue: row.parsedValue }),
    }
  }
  return {
    ...base,
    status: row.status,
    statusLabel: row.statusLabel,
    notCollected: false,
    collected: counts.collected,
    total: counts.total,
    missingFields: counts.missing,
    collectedAt: row.collectedAt,
    schemeVersion: row.schemeVersion,
    snapshotRef: row.snapshotRef,
    errors: row.errors,
    parsedValue: row.parsedValue,
    /* The same function, on the same row, as `buildSectionView` calls — not a
       copy of it. See `sectionContentUnread` for the signals it reads. */
    contentUnread: sectionContentUnread({ notCollected: false, errors: row.errors, parsedValue: row.parsedValue }),
  }
}

/**
 * Build the answer.
 *
 * Refusals are codes on the return value (`TASK_NOT_FOUND`, `ASIN_NOT_IN_TASK`,
 * `SECTION_UNKNOWN`, `NOT_COLLECTED`) — the tool hands them straight back and the
 * route maps them to HTTP statuses, so neither has to re-derive them.
 */
export function buildSectionDetail({
  store, taskId, asin = null, marketplace = null, sections = null, includeRaw = false, includeDiff = true,
} = {}) {
  const id = blankToNull(taskId)
  if (id === null) return { ok: false, code: 'BAD_REQUEST', error: 'taskId is required' }
  const task = getCollectionTask(store, id)
  if (task === undefined) return { ok: false, code: 'TASK_NOT_FOUND', error: `no collection task "${id}"` }

  const requested = normalizeSectionIds(sections)
  if (requested.unknown.length > 0) {
    return {
      ok: false,
      code: 'SECTION_UNKNOWN',
      error: `unknown section(s): ${requested.unknown.join(', ')}`,
      hint: `13 节 id：${COLLECTION_SECTIONS.map(section => section.id).join(', ')}`,
    }
  }
  const wanted = requested.sections.length > 0 ? requested.sections : COLLECTION_SECTIONS.map(section => section.id)
  const definitions = wanted.map(sectionId => SECTION_BY_ID[sectionId])

  const wantedAsin = blankToNull(asin)
  if (wantedAsin === null) {
    /* The list view: one summary per ASIN, no section detail. Without this, a
       50-ASIN task would ship 650 rows on every panel refresh (contract §6.2.7).
       Read with coverage: a 500-ASIN task is 6 500 rows and hits the 5 000-row cap
       on an entirely ordinary task, and the ASINs past the cap would simply not be
       in this list — which reads as "the task never collected them". */
    const read = taskAsinSummariesWithCoverage(store, { taskId: id })
    return {
      ok: true,
      taskId: id,
      asin: null,
      marketplace: null,
      summaries: read.summaries,
      sections: [],
      truncated: false,
      coverage: read.coverage,
      note: read.summaries.length === 0 ? '这个任务还没有写出任何节结果' : null,
    }
  }

  const read = listSectionResultsWithCoverage(store, {
    taskId: id,
    asin: wantedAsin,
    marketplace: blankToNull(marketplace),
  })
  const rows = read.rows
  const bodyRows = rows.filter(row => wanted.includes(row.section))

  /* "This ASIN was never part of the task" and "the task has not reached it yet"
     are two different answers, and the second one is normal while a run is in
     flight. Telling them apart is a targets read, not a section read. */
  const targets = safeParseList(task.targets_json)
  const inTask = targets.some(target => String(target?.asin ?? '').trim().toUpperCase() === String(wantedAsin).toUpperCase())
  if (!inTask) {
    return {
      ok: false,
      code: 'ASIN_NOT_IN_TASK',
      error: `${String(wantedAsin).toUpperCase()} is not a target of task ${id}`,
      hint: '用不带 asin 的调用先列出这个任务的 ASIN',
    }
  }

  if (bodyRows.length === 0) {
    const anyRead = listSectionResultsWithCoverage(store, { taskId: id, asin: wantedAsin })
    if (anyRead.rows.length === 0) {
      /* A capped read cannot answer "there is nothing" — it can only answer "I did
         not see any". `rows` empty while `total` is not is impossible through the
         cap (the bound is at least 1), so this guard is about not letting a future
         change to that bound silently turn into a false NOT_COLLECTED. */
      return {
        ok: false,
        code: 'NOT_COLLECTED',
        error: anyRead.truncated
          ? `task ${id} 里 ${String(wantedAsin).toUpperCase()} 的节结果只读到一部分（${anyRead.note}）—— 不能据此说它没有`
          : `task ${id} 里还没有 ${String(wantedAsin).toUpperCase()} 的节结果`,
        hint: '任务可能还没跑到这个 ASIN，或者它被拒收了（站点/语言/币种不符不写库）',
      }
    }
    return {
      ok: false,
      code: 'NOT_COLLECTED',
      error: `task ${id} 里 ${String(wantedAsin).toUpperCase()} 没有所请求的节`,
      hint: '去掉 sections 过滤再看一次',
    }
  }

  const bySection = new Map(bodyRows.map(row => [row.section, row]))
  const entries = definitions.map(definition => {
    const row = bySection.get(definition.id) ?? null
    const entry = sectionEntry(definition, row)
    if (includeDiff === true && row !== null) entry.diff = row.diff
    if (includeRaw === true && row !== null) entry.raw = row.rawValue
    return entry
  })

  const detailed = sectionSummaryWithCoverage(store, {
    taskId: id,
    asin: wantedAsin,
    marketplace: blankToNull(marketplace),
  })
  const summary = detailed.summary
  /* `summary` counts rows for this coordinate across **all** sections, while the
     entry list may be filtered. The page needs both numbers to be honest, so the
     filtered view says how many rows it left out. */
  const hidden = rows.length - bodyRows.length
  const truncated = bodyRows.some(row => (row.errors ?? []).some(error => error?.code === 'TRUNCATED'))

  return {
    ok: true,
    taskId: id,
    asin: String(wantedAsin).toUpperCase(),
    marketplace: blankToNull(marketplace) === null ? (bodyRows[0]?.marketplace ?? null) : String(marketplace).toUpperCase(),
    summary,
    sections: entries,
    hiddenSections: hidden,
    truncated,
    /* A second, differently-named truncation: `truncated` above is the 64 KB raw
       value being clipped; this one is the row read being capped. Both must be
       said out loud, and neither may be passed off as the other. One coverage key
       only: this summary and the `rows` above are read with the same filters and
       the same cap, so a second copy could only ever drift from it. */
    coverage: detailed.coverage,
  }
}

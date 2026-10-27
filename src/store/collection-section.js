/**
 * `collection_section_result`: what was collected per section, per ASIN, per task
 * (schema v36, module 04 F04-07).
 *
 * ## The identity is a coordinate, and the schema says so
 *
 * `id` is built as `<taskId>:<asin>:<marketplace>:<section>` and the table also
 * carries `UNIQUE (task_id, asin, marketplace, section)`. That is not a
 * duplicated key: the text id is the coordinate spelled out for anyone reading a
 * dump, and the UNIQUE is what makes a second row for the same coordinate
 * **impossible at the schema level**. This matters twice over:
 *
 *   · breakpoint recovery (§5.5) asks "which sections of this ASIN are already
 *     `collected`" and must get one answer per section;
 *   · an upsert that was actually an append would make the page show one section
 *     twice with two different readings and no way to pick.
 *
 * `recordSectionResult` is an upsert on that same coordinate, so a retry
 * overwrites the reading it is retrying instead of adding a second opinion.
 *
 * ## `raw_value_json` is not `parsed_value_json`
 *
 * Two columns, never one. The raw reading is what the page said; the parsed value
 * is what a parser made of it. Overwriting the raw with the parsed result — the
 * obvious shortcut — makes "what did the listing actually say in March" (the
 * whole point of an audit trail, §1 acceptance 6) unanswerable after the first
 * parse, and it makes a parser bug indistinguishable from a page change.
 *
 * ## The 64 KB cap lives here, not in the caller
 *
 * Descriptions and A+ bodies can be enormous, and the cap (contract §3) has to
 * hold for every writer. A cap implemented at each call site is a cap that one
 * new call site forgets. Truncation is recorded in `errors_json` (`TRUNCATED`),
 * because a value that was clipped must not read as a complete one.
 *
 * ## `missing` and `failed` are different words
 *
 * `missing` = the page rendered and the section genuinely has nothing
 * ("Amazon does not have it"); `failed` = we could not tell (selector missed,
 * page never rendered, timeout). Merging them turns "we did not measure it" into
 * "it does not exist", which then feeds an optimization decision. The vocabulary
 * is `COLLECTION_SECTION_STATES` (domain/states.js) and is enforced on write.
 */

import {
  COLLECTION_SECTION_STATES, COLLECTION_SECTION_LABELS,
} from '../domain/states.js'

/** Contract §3: one section's raw reading, 64 KB, truncate and mark. */
export const COLLECTION_RAW_VALUE_LIMIT_BYTES = 64 * 1024

const TRUNCATION_MARKER = '…[TRUNCATED]'

/**
 * The row cap every section read gets, exported.
 *
 * Exported because a reader must be able to **name the number it applied**. A cap
 * the reader cannot print is a cap whose effect is invisible: the caller gets a
 * shorter list and nothing that tells it apart from the real thing.
 */
export const SECTION_RESULT_MAX_ROWS = 5000

/** The coordinate spelled out. Kept in one place so the id and the key agree. */
export function sectionResultId(taskId, asin, marketplace, section) {
  return `${String(taskId).trim()}:${asinOf(asin)}:${marketplaceOf(marketplace)}:${sectionOf(section)}`
}

function asinOf(value) {
  const asin = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new Error(`asin "${value}" is not a 10-character ASIN`)
  }
  return asin
}

function marketplaceOf(value) {
  const marketplace = String(value ?? '').trim().toUpperCase()
  if (marketplace === '') throw new Error('marketplace is required')
  return marketplace
}

/**
 * The section id as given, not case-folded.
 *
 * Marketplaces and ASINs are folded in this store because their identity is
 * case-insensitive in the domain. Section ids are the opposite: they are a closed
 * vocabulary of lower-case snake ids, so `'Basic'` is a **typo**, and folding it
 * would store a coordinate nobody can look up by the spelling they used. The
 * shape is checked here; the thirteen legal ids arrive with the vocabulary
 * (`domain/collect/sections.js`, contract §4.1) in the sub-batch that owns the
 * section tools and the page.
 */
function sectionOf(value) {
  const section = String(value ?? '').trim()
  if (!/^[a-z0-9_]+$/.test(section)) {
    throw new Error(`section "${value}" is not a lower-case id (letters, digits, underscore)`)
  }
  return section
}

function statusOf(value) {
  const status = String(value ?? '').trim()
  if (!COLLECTION_SECTION_STATES.includes(status)) {
    throw new Error(`status "${value}" is not one of ${COLLECTION_SECTION_STATES.join(' / ')}`)
  }
  return status
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

function integerOf(value, fallback = null) {
  if (value === undefined || value === null) return fallback
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) throw new Error(`expected a number, got ${JSON.stringify(value)}`)
  return number
}

/**
 * Serialise the raw reading under the byte cap.
 *
 * The budget is measured in **UTF-8 bytes**, not characters: a 64 K-character
 * description of Chinese text is roughly 190 KB on disk, which is the growth this
 * cap exists to stop. The prefix is found by binary search over the *encoded*
 * document — quotes, escapes and the marker included — rather than by slicing
 * bytes, which would cut a multi-byte character in half and store invalid UTF-8.
 *
 * What lands in the column is a **marker object** (`{_truncated, text, originalBytes}`),
 * not a clipped string. Two reasons: the column still parses as JSON for every
 * reader, and a reader can tell the three cases apart — the value, a value that
 * was too big and got clipped, and no value at all. Storing a bare prefix would
 * put a truncated JSON *document* in a `*_json` column (unparseable), and storing
 * the clipped text as a plain string would be indistinguishable from a raw
 * reading that genuinely was a string.
 */
function encodeRawValue(value) {
  const text = JSON.stringify(value)
  if (text === undefined) return { text: null, truncated: false }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= COLLECTION_RAW_VALUE_LIMIT_BYTES) return { text, truncated: false }

  const encode = count => JSON.stringify({
    _truncated: true,
    text: text.slice(0, count) + TRUNCATION_MARKER,
    originalBytes: bytes,
  })
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(encode(middle), 'utf8') <= COLLECTION_RAW_VALUE_LIMIT_BYTES) low = middle
    else high = middle - 1
  }
  return { text: encode(low), truncated: true }
}

function hydrate(row) {
  if (row === null || row === undefined) return null
  return {
    id: row.id,
    taskId: row.task_id,
    asin: row.asin,
    marketplace: row.marketplace,
    section: row.section,
    status: row.status,
    statusLabel: COLLECTION_SECTION_LABELS[row.status] ?? row.status,
    rawValue: parseJson(row.raw_value_json, null),
    parsedValue: parseJson(row.parsed_value_json, null),
    pageRegion: row.page_region ?? null,
    selectorHits: parseJson(row.selector_hits_json, null),
    errors: parseJson(row.errors_json, []),
    collectedAt: row.collected_at ?? null,
    schemeVersion: row.scheme_version === null || row.scheme_version === undefined ? null : Number(row.scheme_version),
    snapshotRef: row.snapshot_ref ?? null,
    diff: parseJson(row.diff_json, null),
  }
}

/**
 * Write (or rewrite) one section coordinate.
 *
 * A rewrite is a rewrite of the *same* coordinate — the section was retried — so
 * the row keeps its id and gains the new reading. Callers that need history keep
 * the old row by writing a **new task** (`retry_of`), which is exactly how the
 * contract models a retry.
 */
export function recordSectionResult(store, record = {}) {
  const taskId = blankToNull(record.taskId)
  if (taskId === null) throw new Error('taskId is required')
  const asin = asinOf(record.asin)
  const marketplace = marketplaceOf(record.marketplace)
  const section = sectionOf(record.section)
  const status = statusOf(record.status)

  const raw = encodeRawValue(record.rawValue)
  /* A non-array `errors` is a caller bug, not "no errors": silently dropping it
     would hide the reason a section is `failed`, which is the field the reader
     came for. */
  if (record.errors !== undefined && record.errors !== null && !Array.isArray(record.errors)) {
    throw new Error('errors must be an array of {code, detail}')
  }
  const errors = Array.isArray(record.errors) ? [...record.errors] : []
  if (raw.truncated) {
    errors.push({
      code: 'TRUNCATED',
      detail: `raw_value_json exceeded ${COLLECTION_RAW_VALUE_LIMIT_BYTES} bytes and was truncated`,
    })
  }

  const id = blankToNull(record.id) ?? sectionResultId(taskId, asin, marketplace, section)
  const collectedAt = blankToNull(record.collectedAt)

  store.run(
    `INSERT INTO collection_section_result
       (id, task_id, asin, marketplace, section, status, raw_value_json, parsed_value_json,
        page_region, selector_hits_json, errors_json, collected_at, scheme_version, snapshot_ref, diff_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, asin, marketplace, section) DO UPDATE SET
       status = excluded.status,
       raw_value_json = excluded.raw_value_json,
       parsed_value_json = excluded.parsed_value_json,
       page_region = excluded.page_region,
       selector_hits_json = excluded.selector_hits_json,
       errors_json = excluded.errors_json,
       collected_at = excluded.collected_at,
       scheme_version = excluded.scheme_version,
       snapshot_ref = excluded.snapshot_ref,
       diff_json = excluded.diff_json`,
    [
      id, taskId, asin, marketplace, section, status, raw.text, json(record.parsedValue),
      blankToNull(record.pageRegion), json(record.selectorHits), json(errors), collectedAt,
      integerOf(record.schemeVersion), blankToNull(record.snapshotRef), json(record.diff ?? null),
    ],
  )
  return getSectionResult(store, { taskId, asin, marketplace, section })
}

export function getSectionResult(store, { taskId, asin, marketplace, section } = {}) {
  const row = store.get(
    `SELECT * FROM collection_section_result
      WHERE task_id = ? AND asin = ? AND marketplace = ? AND section = ?`,
    [String(taskId).trim(), asinOf(asin), marketplaceOf(marketplace), sectionOf(section)],
  )
  return hydrate(row)
}

/**
 * The rows **and how many there were** — the shape every reader that draws a
 * conclusion has to use.
 *
 * The cap is not the defect: an unbounded read inside a page request is. The
 * defect was that the cap had **no signal**. A caller that hit it got a shorter
 * list and no way to tell it apart from "this ASIN has thirteen sections", which
 * is this repository's worst reading — a section outside the cap is not "never
 * collected", it is "not read", and the two lead to opposite actions (补采 vs 排查).
 *
 * So this returns `rows` plus `read` / `total` / `limit` / `truncated` / `note`.
 * `total` is the pre-cap count under the **same** filters, so `truncated` is a
 * fact about this read rather than about the table.
 *
 * `maxRows` exists so a test can produce a **real** truncation instead of
 * asserting the absence of one. It can only ever *tighten* the cap: the effective
 * cap is `min(maxRows, SECTION_RESULT_MAX_ROWS)`, so no caller can raise it.
 */
export function listSectionResultsWithCoverage(store, {
  taskId = null, asin = null, marketplace = null, status = null,
  limit = SECTION_RESULT_MAX_ROWS, maxRows = SECTION_RESULT_MAX_ROWS,
} = {}) {
  const clauses = []
  const params = []
  if (blankToNull(taskId) !== null) {
    clauses.push('task_id = ?')
    params.push(String(taskId).trim())
  }
  if (blankToNull(asin) !== null) {
    clauses.push('asin = ?')
    params.push(asinOf(asin))
  }
  if (blankToNull(marketplace) !== null) {
    clauses.push('marketplace = ?')
    params.push(marketplaceOf(marketplace))
  }
  if (blankToNull(status) !== null) {
    clauses.push('status = ?')
    params.push(statusOf(status))
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const cap = Math.min(Math.max(Math.trunc(Number(maxRows) || SECTION_RESULT_MAX_ROWS), 1), SECTION_RESULT_MAX_ROWS)
  const bound = Math.min(Math.max(Math.trunc(Number(limit) || cap), 1), cap)
  const total = Number(store.get(`SELECT COUNT(*) AS n FROM collection_section_result ${where}`, params)?.n ?? 0)
  const rows = store
    .all(`SELECT * FROM collection_section_result ${where} ORDER BY asin, marketplace, section LIMIT ?`, [...params, bound])
    .map(hydrate)
  const truncated = total > rows.length
  return {
    rows,
    read: rows.length,
    total,
    limit: bound,
    truncated,
    /* The sentence a reader prints. Kept here, next to the numbers it is made of,
       so two readers cannot describe the same read two different ways. */
    note: truncated
      ? `只读到前 ${rows.length} 行（这个筛选条件下共 ${total} 行，读的上限是 ${bound} 行）`
        + ' —— 没读到的部分不是「没有」：别把「没读到」当成「没采集」'
      : null,
  }
}

/**
 * The five state counts for one ASIN in one task — the shape the detail tool and
 * the page both render (`{collected, missing, partial, failed, blocked, total}`).
 *
 * Always all six keys, zero included: a missing key and a zero read differently in
 * JSON (`undefined` prints as an absent field), and the page prints these numbers.
 *
 * The counts come **with the read they were computed from**, because a summariser
 * that cannot say "I only read the first N" turns a truncated read into a smaller,
 * confident, wrong set of counts.
 */
export function sectionSummaryWithCoverage(store, { taskId, asin, marketplace, maxRows = SECTION_RESULT_MAX_ROWS } = {}) {
  const read = listSectionResultsWithCoverage(store, { taskId, asin, marketplace, maxRows })
  const summary = { collected: 0, missing: 0, partial: 0, failed: 0, blocked: 0, total: read.rows.length }
  for (const row of read.rows) summary[row.status] += 1
  return { summary, coverage: coverageOf(read) }
}

/** The read-side half of a coverage object — the numbers a reader prints. */
function coverageOf(read) {
  return { read: read.read, total: read.total, limit: read.limit, truncated: read.truncated, note: read.note }
}

/**
 * One summary per ASIN in a task — the list view of the detail tool (contract
 * §6.2.7: `asin` omitted returns summaries, not 2 600 rows) — plus the read it
 * came from.
 *
 * This is the reader where a silent cap costs the most: a 500-ASIN task with
 * thirteen sections each is 6 500 rows, so the list view hits `SECTION_RESULT_MAX_ROWS`
 * on a perfectly ordinary task — and the ASINs that fell outside the cap simply
 * are not in the list, which reads as "this task never collected them".
 */
export function taskAsinSummariesWithCoverage(store, { taskId, maxRows = SECTION_RESULT_MAX_ROWS } = {}) {
  const read = listSectionResultsWithCoverage(store, { taskId, maxRows })
  const byCoordinate = new Map()
  for (const row of read.rows) {
    const key = `${row.asin}|${row.marketplace}`
    if (!byCoordinate.has(key)) {
      byCoordinate.set(key, {
        asin: row.asin,
        marketplace: row.marketplace,
        sections: [],
      })
    }
    byCoordinate.get(key).sections.push(row)
  }
  const summaries = [...byCoordinate.values()].map(entry => {
    const summary = { collected: 0, missing: 0, partial: 0, failed: 0, blocked: 0, total: entry.sections.length }
    let collectedAt = null
    for (const section of entry.sections) {
      summary[section.status] += 1
      if (section.collectedAt !== null && (collectedAt === null || section.collectedAt > collectedAt)) {
        collectedAt = section.collectedAt
      }
    }
    return { asin: entry.asin, marketplace: entry.marketplace, summary, collectedAt }
  })
  return { summaries, coverage: coverageOf(read) }
}

/**
 * The sections of one coordinate that are already `collected` — the breakpoint
 * answer (§5.5: a recovered task must not re-collect what it already has).
 *
 * Only `collected` counts. A `partial` section is deliberately **not** in this
 * list: re-running it is what a retry is for, and treating partial as done would
 * freeze half a section forever.
 */
export function collectedSections(store, { taskId, asin, marketplace } = {}) {
  return store
    .all(
      `SELECT section FROM collection_section_result
        WHERE task_id = ? AND asin = ? AND marketplace = ? AND status = 'collected'
        ORDER BY section`,
      [String(taskId).trim(), asinOf(asin), marketplaceOf(marketplace)],
    )
    .map(row => row.section)
}

/** How many section rows a task has produced (the "kept" count a cancel reports). */
export function countSectionResults(store, { taskId } = {}) {
  const row = store.get(
    'SELECT COUNT(*) AS rows FROM collection_section_result WHERE task_id = ?',
    [String(taskId).trim()],
  )
  return Number(row?.rows ?? 0)
}

/**
 * How many **snapshots** a task's section rows point at.
 *
 * Distinct, because several sections of one reading reference the same
 * `asin_snapshot` row and counting rows would report the same snapshot five
 * times. This is the number `keptSnapshots` means (`waiting_resolve` reports it
 * next to `keptSections`): "the readings we keep" and "the product snapshots
 * those readings came from" are two different counts, and reporting one under
 * the other's name is a number that looks right and answers the wrong question.
 */
export function countKeptSnapshots(store, { taskId } = {}) {
  const row = store.get(
    `SELECT COUNT(DISTINCT snapshot_ref) AS rows FROM collection_section_result
      WHERE task_id = ? AND snapshot_ref IS NOT NULL`,
    [String(taskId).trim()],
  )
  return Number(row?.rows ?? 0)
}

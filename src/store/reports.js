/**
 * The report registry: one list of everything the report page should show.
 *
 * Before this, reports existed in two unconnected places — optimization reports
 * live in `optimization_run.report_html`, and the keyword library's reports and
 * CSVs exist only as files on disk. Neither place can answer "show me every
 * report for this ASIN", so the report page could only ever list half of them.
 *
 * The registry is an **index, not a second copy** (§3.6):
 *
 *   - An optimization report keeps its body in `optimization_run.report_html`;
 *     the row here carries `ref_id` pointing at the run. Copying the HTML would
 *     create two bodies that can disagree, and the one the page shows would be
 *     the older.
 *   - A library report or CSV keeps its body in the file named by `path`.
 *   - A **generated** report (F14-01, v48) keeps its body in this row's `body`
 *     column — not because the index started copying things, but because for
 *     those eight kinds there is no other copy to point at. See the v48
 *     migration's comment; the distinction is the whole reason `body` is allowed
 *     to exist while a second copy of the optimisation HTML is not.
 *
 * **The one invariant** is that a row points at *something*: for each kind,
 * exactly one of `ref_id` / `path` / `body` is the thing that makes it readable,
 * and a row without it is a report that can be listed and never opened — the
 * silent-empty shape this project keeps refusing. It is enforced here rather than
 * as a `CHECK` in the migration, because a CHECK would freeze a rule that has to
 * be free to change, and because the guard belongs at the one boundary every
 * writer crosses.
 *
 * `kind` is not a foreign key: an optimization run, a keyword report and a data
 * quality report have no common parent table. Same choice as `kw_import.kind`.
 *
 * ## One table, five readers (F14-01)
 *
 * `REPORT_KIND_TABLE` is the **only** place a kind is declared. Its readers are
 * `recordReport` (which pointer a kind must carry), `listReports` /
 * `reportCounts` (labels, chips, the status clause), `src/tools/report.js` (the
 * agent-facing list — it used to keep its own copy of the three ids and the three
 * labels), `src/web/routes.js` (which hands labels to the page, which used to keep
 * a *third* copy of the labels) and `src/domain/search/index.js` (which kinds have
 * a body worth searching). Adding a kind is one entry; breaking the table has to
 * break all of them at once, and `tests/f14-01-report-library.mjs` asserts
 * exactly that.
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'

/**
 * The eleven kinds.
 *
 * ⚠️ The audit line this batch answers says 「十类报告只落 3 类」 and then lists
 * **eight** missing kinds — 3 + 8 = 11, not 10. The mismatch is in the audit, not
 * in the count below: this table holds the three that existed plus every kind the
 * audit named, because dropping one to make the arithmetic come out would be
 * editing the requirement to fit the sentence.
 *
 * Per kind:
 *   - `pointer` — which column makes the row readable: `ref` (`ref_id`),
 *     `path`, or `body`. This is the invariant, in data form.
 *   - `bodyIn` — `row` (this table), `ref` (the pointed-at row) or `file` (the
 *     path on disk). Used by search to say **which kinds it could not search**
 *     instead of silently searching fewer bytes than it claims.
 *   - `writer` — the code path that creates these rows. Not decoration: the audit
 *     gap was 「无 kind、**无写入方**」, so every kind names its writer.
 *   - `source` — the tables the content comes from, for a reader who wants to
 *     check the document against the store.
 */
export const REPORT_KIND_TABLE = [
  {
    id: 'optimization',
    label: '优化报告',
    pointer: 'ref',
    bodyIn: 'ref',
    writer: 'amzn_optimize_save（recordOptimizationReport）',
    source: 'optimization_run.report_html',
  },
  {
    id: 'kw-report',
    label: '总库报告',
    pointer: 'path',
    bodyIn: 'file',
    writer: 'amzn_kw_report / 关键词管道导出（recordFileReport）',
    source: '磁盘上的 HTML 文件（path）',
  },
  {
    id: 'kw-export',
    label: '总库 CSV',
    pointer: 'path',
    bodyIn: 'file',
    writer: 'amzn_kw_export / 关键词管道导出（recordFileReport）',
    source: '磁盘上的 CSV 文件（path）',
  },
  {
    id: 'data-quality',
    label: '数据质量报告',
    pointer: 'body',
    bodyIn: 'row',
    writer: 'amzn_report_build',
    source: 'dq_issue（store/quality.js 的 listIssues / issueStats）',
  },
  {
    id: 'collection',
    label: '采集报告',
    pointer: 'body',
    bodyIn: 'row',
    writer: 'amzn_report_build',
    source: 'collection_task ⋈ collection_task_event ⋈ collection_section_result',
  },
  {
    id: 'asin-health',
    label: 'ASIN 健康报告',
    pointer: 'body',
    bodyIn: 'row',
    writer: 'amzn_report_build',
    source: 'domain/asin/health.js#buildAsinHealthSummary ⋈ asin / asin_field_source / field_conflict / dq_issue / listing',
  },
  {
    id: 'competitor-gap',
    label: '竞品差距报告',
    pointer: 'body',
    bodyIn: 'row',
    writer: 'amzn_report_build',
    source: 'domain/asin/competitor.js#buildAsinCompetitorView ⋈ competitor_set / kw_competitor_fact',
  },
  {
    id: 'rule-policy-impact',
    label: '规则政策影响报告',
    pointer: 'body',
    bodyIn: 'row',
    writer: 'amzn_report_build',
    source: 'rule / rule_set ⋈ policy ⋈ store/rules.js#diffVersions / domain/rules/registry.js#missingChecks',
  },
  {
    id: 'prompt-agent-eval',
    label: 'Prompt·Agent 评估报告',
    pointer: 'body',
    bodyIn: 'row',
    writer: 'amzn_report_build',
    source: 'prompt_eval_set / prompt_eval_case ⋈ domain/agent/metrics.js#agentMetrics ⋈ domain/prompts/eval-dimensions.js',
  },
  {
    id: 'post-publication',
    label: '发布后效果报告',
    pointer: 'body',
    bodyIn: 'row',
    writer: 'amzn_report_build',
    source: 'publication_record ⋈ observation_plan / observation_checkpoint ⋈ domain/observe/metrics.js#OBSERVATION_METRICS',
  },
  {
    id: 'ops-summary',
    label: '运营汇总报告',
    pointer: 'body',
    bodyIn: 'row',
    writer: 'amzn_report_build',
    source: 'domain/dashboard/health.js#buildHealthCards + 各模块 counts（asin / kw_master / collection_task / optimization_run / publication_record / dq_issue）',
  },
]

/** The ids, in declaration order. A fourth kind is a code change, so it is a closed set. */
export const REPORT_KINDS = REPORT_KIND_TABLE.map(kind => kind.id)

/**
 * The three states a report can be in — **recomputed, never stored**.
 *
 * The v48 migration deliberately did not add a `state` column: the three states
 * have two different authorities (does the body still resolve; is `archived_at`
 * set), and a stored string would be a second answer to the same question that a
 * writer could get wrong while the reader gets it right.
 */
export const REPORT_STATUSES = ['ready', 'unopenable', 'archived']

/** The status labels. One spelling; the page reads them out of the payload. */
export const REPORT_STATUS_LABELS = {
  ready: '可取回',
  unopenable: '取不回',
  archived: '已归档',
}

/** One kind's declaration, or `null`. Callers must not invent a default label. */
export function reportKindSpec(kind) {
  const id = String(kind ?? '').trim()
  return REPORT_KIND_TABLE.find(entry => entry.id === id) ?? null
}

/**
 * The SQL that decides "the body resolves", derived from `REPORT_KIND_TABLE`.
 *
 * Two engines, one rule: `reportStatus` below answers the same question in JS for
 * a hydrated row, and `tests/f14-01-report-library.mjs` asserts the two agree on
 * every row — a filter that disagreed with the badge would show a row under
 * 「可取回」 while its chip said 取不回. Keeping the rule in the table means a new
 * kind cannot make the filter and the badge disagree: it changes both or neither.
 */
function openableSql(alias = '') {
  const prefix = alias === '' ? '' : `${alias}.`
  const branches = REPORT_KIND_TABLE.map(entry => {
    const column = entry.pointer === 'ref' ? 'ref_id' : (entry.pointer === 'path' ? 'path' : 'body')
    return `WHEN '${entry.id}' THEN ${prefix}${column} IS NOT NULL`
  })
  return `(CASE ${prefix}kind ${branches.join(' ')} ELSE (${prefix}ref_id IS NOT NULL OR ${prefix}path IS NOT NULL) END)`
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/** A blank string, `null` and `undefined` all mean "not recorded". */
function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** The pointer a kind demands, or `null` when the table says nothing. */
function pointerOf(kind) {
  const spec = reportKindSpec(kind)
  return spec === null ? null : spec.pointer
}

/**
 * Register a report. Returns the stored row.
 *
 * `kind` is checked against `REPORT_KINDS` and the pointer invariant is checked
 * here, both **by name** — a report that cannot be opened must not be creatable,
 * because it will look fine in the list and fail only when someone clicks it.
 */
export function recordReport(store, record = {}) {
  const kind = String(record.kind ?? '').trim()
  if (!REPORT_KINDS.includes(kind)) {
    throw new Error(`unknown report kind "${kind}" — known: ${REPORT_KINDS.join(', ')}`)
  }

  const refId = blankToNull(record.refId)
  const path = blankToNull(record.path)
  const body = blankToNull(record.body)

  /* The invariant. A row that points at nothing is listable and unopenable. */
  if (refId === null && path === null && body === null) {
    throw new Error(`report "${kind}" needs a refId or a path — a row with neither can be listed but never opened`)
  }
  if (kind === 'optimization' && refId === null) {
    throw new Error('an optimization report is the run\'s own report_html — it needs refId pointing at the run')
  }
  if ((kind === 'kw-report' || kind === 'kw-export') && path === null) {
    throw new Error(`a ${kind} is a file on disk — it needs a path`)
  }
  /* A generated kind's body lives in this row, so a `path` alone would promise a
     file nobody wrote, and a `refId` alone would promise a row nobody resolved. */
  if (pointerOf(kind) === 'body' && body === null) {
    throw new Error(`a ${kind} report is a generated document — it needs a body `
      + '(its content lives in this registry; no file and no other row carries it)')
  }

  const id = String(record.id ?? '').trim() || randomUUID()
  const scope = record.scope === undefined || record.scope === null
    ? (record.scopeJson === undefined ? null : parseJson(record.scopeJson, null))
    : record.scope

  const tags = record.tags === undefined || record.tags === null
    ? null
    : JSON.stringify(normalizeTags(record.tags))

  store.run(
    `INSERT INTO report (id, kind, scope_json, path, ref_id, title, created_at, note, body, created_by, favorite, tags_json, archived_at, archived_by, archive_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, scope_json = excluded.scope_json,
       path = excluded.path, ref_id = excluded.ref_id, title = excluded.title,
       created_at = excluded.created_at, note = excluded.note,
       body = COALESCE(excluded.body, report.body),
       created_by = COALESCE(excluded.created_by, report.created_by),
       favorite = excluded.favorite,
       tags_json = COALESCE(excluded.tags_json, report.tags_json),
       archived_at = excluded.archived_at,
       archived_by = excluded.archived_by,
       archive_reason = excluded.archive_reason`,
    [
      id, kind,
      scope === null ? null : JSON.stringify(scope),
      path, refId,
      record.title ?? null,
      record.createdAt ?? nowIso(),
      record.note ?? null,
      body,
      blankToNull(record.createdBy),
      record.favorite === true || record.favorite === 1 ? 1 : 0,
      tags,
      blankToNull(record.archivedAt),
      blankToNull(record.archivedBy),
      blankToNull(record.archiveReason),
    ],
  )
  return getReport(store, id)
}

/** Trimmed, de-duplicated, sorted — one spelling of a tag list. */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new Error('tags must be a list of strings')
  const out = []
  for (const tag of tags) {
    const text = String(tag ?? '').trim()
    if (text === '') continue
    if (!out.includes(text)) out.push(text)
  }
  return out.sort()
}

/**
 * The registry row for one optimization run, or `null`.
 *
 * One row per run (`ref_id` is the run id), which is why this is a lookup and not
 * a list. F14-10 needs it in two places — the export route (which is addressed by
 * report id and must find the run's bytes) and `amzn_optimize_report` (which is
 * addressed by run id and must name the export URL) — and a `SELECT` written twice
 * for the same question is how the two answers start to disagree about which row
 * belongs to which run.
 */
export function reportForRun(store, runId) {
  const id = String(runId ?? '').trim()
  if (id === '') return null
  const row = store.get("SELECT * FROM report WHERE kind = 'optimization' AND ref_id = ?", [id])
  return row === undefined || row === null ? null : hydrateReport(row)
}

/**
 * Register the report for an optimization run, if it has one.
 *
 * Called at save time. Idempotent on `runId` (one row per run) so re-saving a run
 * updates its index entry instead of adding a second one — the page would
 * otherwise grow a duplicate per save.
 */
export function recordOptimizationReport(store, run, { title = null, note = null } = {}) {
  const runId = String(run?.id ?? '').trim()
  if (runId === '') throw new Error('recordOptimizationReport needs a run with an id')
  if (run.report_html === null || run.report_html === undefined || String(run.report_html).trim() === '') {
    /* Not an error: a run that has not produced a report yet has nothing to
       index, and inventing a row for it would put an empty report in the list. */
    return null
  }

  const existing = reportForRun(store, runId)
  /* `??` and `||` cannot be mixed without parentheses (it is a syntax error, not
     a precedence question), and the two are doing different jobs here: `??` fills
     a missing field, `||` picks a fallback when the built string is blank. */
  const fromRun = `${run.asin ?? ''} ${run.marketplace ?? ''}`.trim()
  return recordReport(store, {
    id: existing?.id,
    kind: 'optimization',
    refId: runId,
    scope: { asin: run.asin ?? null, marketplace: run.marketplace ?? null, runId },
    title: title ?? (fromRun === '' ? `优化报告 ${runId}` : fromRun),
    createdAt: run.finished_at ?? run.started_at ?? undefined,
    note,
  })
}

/**
 * Register one file a writer just produced.
 *
 * Three places write report files — `amzn_kw_report` (one HTML), `amzn_kw_export`
 * (one CSV per set) and the pipeline's export stage — and all three come through
 * here. That is deliberate: the **id scheme** decides whether re-running today's
 * export duplicates the list, and a rule like that kept in three callers is a rule
 * that will be right in two of them.
 *
 * The id is derived from the path, which makes a re-run idempotent for free: file
 * names carry the date and the scope, so running the same export twice in one day
 * writes the same names, and the second run updates its rows rather than adding a
 * second set. A different day or a different directory is genuinely a different
 * artefact and gets its own row.
 *
 * One row per **file**, not per export call, because the invariant this table is
 * built on is "a row points at something openable" (see the module comment). An
 * export's directory is not a document; each CSV is.
 */
export function recordFileReport(store, { kind, file, title = null, scope = null, createdAt = undefined } = {}) {
  if (kind !== 'kw-report' && kind !== 'kw-export') {
    throw new Error(`recordFileReport is for file reports — "${kind}" is not one of: kw-report, kw-export`)
  }
  const path = String(file ?? '').trim()
  if (path === '') throw new Error('recordFileReport needs the path of the file that was written')

  return recordReport(store, {
    id: `${kind}:${path}`,
    kind,
    path,
    /* Falling back to the file name rather than to null: a row whose title is
       blank is one the page shows as an empty line, and the file name always says
       which artefact it is. */
    title: title ?? path.split(/[\\/]/).pop(),
    scope,
    createdAt,
  })
}

/**
 * The status of one hydrated row, **recomputed** from what the row can show.
 *
 * `archived` wins over `unopenable`: an archived report with a lost body is still
 * archived, and "archived" is the answer to "why is this not in my working set".
 */
export function reportStatus(row) {
  const raw = row ?? {}
  if (raw.archivedAt !== null && raw.archivedAt !== undefined) return 'archived'
  return raw.openable === true ? 'ready' : 'unopenable'
}

export function getReport(store, id) {
  const row = store.get('SELECT * FROM report WHERE id = ?', [String(id ?? '').trim()])
  return row === undefined || row === null ? null : hydrateReport(row)
}

export function hydrateReport(row) {
  const spec = reportKindSpec(row.kind)
  const refId = row.ref_id ?? null
  const path = row.path ?? null
  const body = row.body ?? null
  const pointer = spec === null ? null : spec.pointer
  /**
   * Whether the body is reachable. An optimization report lives in the run, so
   * this says the run still exists; a file report says the path is recorded; a
   * generated report says its own body is in this row. The page prints this
   * rather than discovering it on click.
   */
  const openable = pointer === 'ref'
    ? refId !== null
    : (pointer === 'path'
      ? path !== null
      : (pointer === 'body' ? body !== null : (refId !== null || path !== null || body !== null)))
  const hydrated = {
    id: row.id,
    kind: row.kind,
    kindLabel: spec === null ? row.kind : spec.label,
    scope: parseJson(row.scope_json, null),
    path,
    refId,
    title: row.title ?? null,
    createdAt: row.created_at,
    note: row.note ?? null,
    createdBy: row.created_by ?? null,
    favorite: Number(row.favorite ?? 0) === 1,
    tags: parseJson(row.tags_json, null),
    archivedAt: row.archived_at ?? null,
    archivedBy: row.archived_by ?? null,
    archiveReason: row.archive_reason ?? null,
    /* Whether the body lives in this row. `hasBody` is about the row; `openable`
       is about the report: an optimization row is openable through its pointer and
       still carries no body here. */
    hasBody: body !== null,
    openable,
    /* `ref` / `path` / `body` — which column makes this row readable, straight out of
       `REPORT_KIND_TABLE` (`null` for a kind the table does not declare). Exposed
       because **F14-10's export decision is a function of it**: "正文住在哪一列" is
       what decides whether a row has three export formats or none. Before this
       field existed, `routes.js` and `domain/reports/export.js` each spelled
       `kind === 'optimization'` to mean the same thing — and `B05T-⑦b` counted
       those literals in `routes.js` as a copied column list, which is exactly the
       shape it is: one fact, several spellings. */
    pointer,
  }
  hydrated.status = reportStatus(hydrated)
  hydrated.statusLabel = REPORT_STATUS_LABELS[hydrated.status]
  return hydrated
}

/** The body, or `null`. Separate from `hydrateReport` so the list stays small. */
export function getReportBody(store, id) {
  const row = store.get('SELECT body FROM report WHERE id = ?', [String(id ?? '').trim()])
  return row === undefined || row === null || row.body === null ? null : String(row.body)
}

/**
 * The list the report page draws.
 *
 * Filtering by ASIN reads `scope_json`'s `asin` because that is where a report's
 * scope lives (see the migration comment for why scope is JSON and not columns).
 * `kind`, the date range, the creator, the favourite flag and the archive stamp
 * are plain columns; the product line and the tag list read the JSON for the same
 * reason ASIN does — 「范围」 differs per kind, and a column per dimension would
 * need a migration per kind.
 *
 * `status` is **not a column**: it is the three-state answer `reportStatus`
 * recomputes, translated into a WHERE clause here. `all` is the default, matching
 * the 2026-10-13 ruling that archived rows stay visible (with a chip) unless the
 * caller asks otherwise.
 */
export function listReports(store, {
  kind = null, asin = null, marketplace = null, since = null,
  productLine = null, status = null, createdBy = null, favorite = null, tag = null,
  limit = 100,
} = {}) {
  const where = []
  const params = []
  if (kind !== null && kind !== '') { where.push('kind = ?'); params.push(String(kind)) }
  if (asin !== null && asin !== '') {
    where.push("json_extract(scope_json, '$.asin') = ?")
    params.push(String(asin).trim().toUpperCase())
  }
  if (marketplace !== null && marketplace !== '') {
    where.push("json_extract(scope_json, '$.marketplace') = ?")
    params.push(String(marketplace).trim().toUpperCase())
  }
  if (productLine !== null && productLine !== '') {
    where.push("json_extract(scope_json, '$.productLine') = ?")
    params.push(String(productLine).trim())
  }
  if (createdBy !== null && createdBy !== '') {
    where.push('created_by = ?')
    params.push(String(createdBy).trim())
  }
  if (favorite === true) where.push('favorite = 1')
  if (tag !== null && tag !== '') {
    where.push('EXISTS (SELECT 1 FROM json_each(report.tags_json) WHERE json_each.value = ?)')
    params.push(String(tag).trim())
  }
  if (since !== null && since !== '') { where.push('created_at >= ?'); params.push(String(since)) }

  const wanted = status === null || status === undefined || status === '' ? 'all' : String(status)
  if (wanted !== 'all' && !REPORT_STATUSES.includes(wanted)) {
    /* An unknown status that silently matched nothing would read as "there are no
       such reports" — a wrong answer dressed as an empty one. Recompute refuses
       rather than inventing a filter; the route validates it too. */
    throw new Error(`unknown report status "${wanted}" — known: all, ${REPORT_STATUSES.join(', ')}`)
  }
  if (wanted === 'ready') where.push(`archived_at IS NULL AND ${openableSql()}`)
  if (wanted === 'unopenable') where.push(`archived_at IS NULL AND NOT ${openableSql()}`)
  if (wanted === 'archived') where.push('archived_at IS NOT NULL')

  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 1000)
  const rows = store.all(
    `SELECT * FROM report
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...params, cap],
  )
  return {
    rows: rows.map(hydrateReport),
    /* Two denominators, and they answer different questions: `total` is 「库里
       有多少份报告」, `matched` is 「这个筛选选中了多少份」. A caller that printed
       only one of them could not tell 「库是空的」 from 「这个条件没有结果」 — the
       distinction the empty states are built on. */
    total: Number(store.get('SELECT COUNT(*) AS n FROM report')?.n ?? 0),
    matched: Number(store.get(
      `SELECT COUNT(*) AS n FROM report ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`,
      params,
    )?.n ?? 0),
    limit: cap,
  }
}

/**
 * Counts per kind, plus the three statuses, so the page can draw every chip
 * without a query per chip.
 *
 * Every declared kind appears with a real 0 when it has no rows — that 0 means
 * 「这一类有写入方，但还没有人跑过它」, which is a measurement. A kind with **no**
 * writer would have to be reported differently; the assertion in the test file is
 * that no such kind exists in `REPORT_KIND_TABLE` (every entry names its `writer`
 * and the build path `amzn_report_build` really constructs each one).
 */
export function reportCounts(store) {
  const out = Object.fromEntries(REPORT_KINDS.map(kind => [kind, 0]))
  for (const row of store.all('SELECT kind, COUNT(*) AS n FROM report GROUP BY kind')) {
    /* A row whose kind is no longer in the table (a downgrade) still counts toward
       `total`; it must not create a chip, so it is only added below. */
    if (out[row.kind] !== undefined) out[row.kind] = Number(row.n)
  }
  const perKind = REPORT_KIND_TABLE.map(entry => ({
    id: entry.id,
    label: entry.label,
    count: out[entry.id],
    writer: entry.writer,
    source: entry.source,
    bodyIn: entry.bodyIn,
  }))

  const byStatus = Object.fromEntries(REPORT_STATUSES.map(status => [status, 0]))
  for (const row of store.all('SELECT * FROM report')) {
    byStatus[reportStatus(hydrateReport(row))] += 1
  }

  const favorites = Number(store.get('SELECT COUNT(*) AS n FROM report WHERE favorite = 1')?.n ?? 0)
  return {
    ...out,
    total: Number(store.get('SELECT COUNT(*) AS n FROM report')?.n ?? 0),
    kinds: perKind,
    byStatus,
    favorites,
  }
}

/**
 * The creator values actually present, so the page's select offers only real
 * ones. `null` (未记录) is its own count rather than being folded into `''`:
 * 「没人记录过是谁生成的」 is a fact about the rows, not a missing filter value.
 */
export function reportCreators(store) {
  const named = store
    .all('SELECT DISTINCT created_by AS v FROM report WHERE created_by IS NOT NULL ORDER BY v')
    .map(row => row.v)
  const unrecorded = Number(store.get('SELECT COUNT(*) AS n FROM report WHERE created_by IS NULL')?.n ?? 0)
  return { named, unrecorded }
}

/** The product lines the scope JSON actually names, for the same reason. */
export function reportProductLines(store) {
  return store.all(
    `SELECT DISTINCT json_extract(scope_json, '$.productLine') AS v
       FROM report WHERE json_extract(scope_json, '$.productLine') IS NOT NULL
      ORDER BY v`,
  ).map(row => row.v)
}

/** The tag values in use, de-duplicated across rows. */
export function reportTags(store) {
  return store.all(
    `SELECT DISTINCT json_each.value AS v FROM report, json_each(report.tags_json)
      WHERE json_each.value IS NOT NULL ORDER BY v`,
  ).map(row => row.v)
}

/** Mark one report. Returns the row read back, so the caller cannot report a guess. */
export function setReportFavorite(store, id, favorite) {
  const key = String(id ?? '').trim()
  const before = store.get('SELECT id FROM report WHERE id = ?', [key])
  if (before === undefined || before === null) return null
  store.run('UPDATE report SET favorite = ? WHERE id = ?', [favorite === true || favorite === 1 ? 1 : 0, key])
  return getReport(store, key)
}

/**
 * Replace a report's tag list.
 *
 * `[]` and `null` are **different**: `null` means 「没人打过标签」 and `[]` means
 * 「打过，又清空了」. Collapsing them would make clearing the tags silently revert
 * to "never tagged" — the same NULL-vs-[] choice `product_line.signals_json`
 * documents (v17).
 */
export function setReportTags(store, id, tags) {
  const key = String(id ?? '').trim()
  const before = store.get('SELECT id FROM report WHERE id = ?', [key])
  if (before === undefined || before === null) return null
  const next = tags === null ? null : JSON.stringify(normalizeTags(tags))
  store.run('UPDATE report SET tags_json = ? WHERE id = ?', [next, key])
  return getReport(store, key)
}

/**
 * Archive or restore. Restoring clears all three stamp columns together — a
 * restored row with a leftover `archived_at` would read as archived forever.
 */
export function setReportArchived(store, id, archived, { by = null, reason = null } = {}) {
  const key = String(id ?? '').trim()
  const before = store.get('SELECT id FROM report WHERE id = ?', [key])
  if (before === undefined || before === null) return null
  if (archived === true) {
    store.run(
      'UPDATE report SET archived_at = ?, archived_by = ?, archive_reason = ? WHERE id = ?',
      [nowIso(), blankToNull(by), blankToNull(reason), key],
    )
  } else {
    store.run(
      'UPDATE report SET archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE id = ?',
      [key],
    )
  }
  return getReport(store, key)
}

export function deleteReport(store, id) {
  const before = store.get('SELECT id FROM report WHERE id = ?', [String(id ?? '').trim()])
  store.run('DELETE FROM report WHERE id = ?', [String(id ?? '').trim()])
  return before !== null && before !== undefined
}

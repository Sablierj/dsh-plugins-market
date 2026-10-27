/**
 * The policy-check candidate store (S2-T72).
 *
 * Two tables, two jobs:
 *
 *   - `policy_check_runs` is the **run record** the PRD's AC② asks for: when the
 *     button was pressed, what query was used, whether the search channel failed
 *     (and why), how many sources came back, and how many machine-readable
 *     differences were found. A failed run is a row with `status='failed'` and an
 *     error — never an empty candidate list pretending the search succeeded.
 *   - `policy_candidates` is **evidence, not policy**. A row here has not entered
 *     the policy library and must not be read as one. Only a human decision moves
 *     it to `confirmed` (which is the moment a `policy` row is written by the
 *     domain's confirm path) or `rejected`.
 *
 * Nothing here fetches anything and nothing here decides anything. The store
 * writes rows; `domain/policy/candidate.js` owns the search, the diff and the
 * confirm path.
 *
 * The status vocabulary is deliberately narrow: `candidate → confirmed |
 * rejected`, first decision wins. Re-deciding is refused at the domain layer and
 * the UPDATE here is guarded by `status = 'candidate'`, so a second writer cannot
 * silently rewrite a human's decision (跨模块铁律 #6).
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/**
 * The provenance row a confirmed candidate is imported under.
 *
 * Created **lazily on first confirm**, not seeded by the migration: v11's
 * 「三个政策来源」 is a historical invariant other suites assert, and a library
 * that never used the search button should not grow an empty fourth source.
 * `INSERT OR IGNORE` makes it idempotent.
 */
export function ensureSearchPolicySource(store) {
  store.run(
    `INSERT OR IGNORE INTO policy_source (id, kind, name, url, note) VALUES
       ('web-search', 'search', 'SearXNG 政策检索', NULL,
        'S2-T72 检索通道：候选来自 SearXNG 搜索结果的标题/链接/原文片段，人工确认后才写入政策库；来源 URL 记在 policy.url 与候选行上。')`,
  )
}

/** One `policy_check_runs` row in the shape the domain and the page consume. */
function rowToRun(row) {
  return {
    id: row.id,
    query: row.query,
    marketplace: row.marketplace,
    status: row.status,
    errorCode: row.error_code,
    error: row.error,
    sourceCount: Number(row.source_count ?? 0),
    diffCount: Number(row.diff_count ?? 0),
    /* `null` = 这一行没有耗时记录（v66 之前的老 run / 未执行完），不是 0 ms。 */
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    sources: parseJson(row.sources_json, []),
    confirmedBy: row.confirmed_by,
    confirmReason: row.confirm_reason,
    observedAt: row.observed_at,
    decidedAt: row.decided_at,
  }
}

/** One `policy_candidates` row in the shape the domain and the page consume. */
function rowToCandidate(row) {
  return {
    id: row.id,
    runId: row.run_id,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    snippet: row.snippet,
    retrievedAt: row.retrieved_at,
    query: row.query,
    status: row.status,
    policyId: row.policy_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    decisionReason: row.decision_reason,
    diff: parseJson(row.diff_json, { matched: [], differences: [], notes: [] }),
    createdAt: row.created_at,
  }
}

/**
 * Open one run row. Written **before** the search starts so a process that dies
 * mid-search leaves a `running` row rather than no record at all — "we tried and
 * do not know" is a different fact from "nobody pressed the button".
 */
export function createCheckRun(store, record = {}) {
  const id = String(record.id ?? randomUUID())
  const query = String(record.query ?? '').trim()
  if (query === '') throw new Error('query is required')
  const observedAt = record.observedAt ?? nowIso()
  store.run(
    `INSERT INTO policy_check_runs
       (id, query, marketplace, status, error_code, error, source_count, diff_count,
        duration_ms, sources_json, confirmed_by, confirm_reason, observed_at, decided_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, ?, NULL)`,
    [id, query, record.marketplace ?? null, String(record.status ?? 'running'), observedAt],
  )
  return getCheckRun(store, id)
}

/**
 * Close the search step: `pending_confirm` when the channel answered (including
 * a legitimate 0-result answer), `failed` when it did not.
 *
 * `sources_json` keeps the raw hits **even when no candidate survives** (e.g.
 * every hit lacked a title), because "the channel returned 12 rows and 12 were
 * unusable" is not the same fact as "the channel returned nothing".
 */
export function finishCheckRun(store, record = {}) {
  const id = String(record.id ?? '').trim()
  if (id === '') throw new Error('run id is required')
  const status = String(record.status ?? '').trim()
  if (!['pending_confirm', 'failed', 'confirmed', 'rejected'].includes(status)) {
    throw new Error(`unknown run status "${status}"`)
  }
  const rawDuration = Number(record.durationMs)
  const durationMs = record.durationMs === undefined || record.durationMs === null || !Number.isFinite(rawDuration)
    ? null
    : Math.max(0, Math.round(rawDuration))
  store.run(
    `UPDATE policy_check_runs
        SET status = ?, error_code = ?, error = ?, source_count = ?, diff_count = ?,
            duration_ms = ?, sources_json = ?,
            decided_at = CASE WHEN ? IN ('confirmed', 'rejected') THEN ? ELSE decided_at END
      WHERE id = ?`,
    [
      status,
      record.errorCode ?? null,
      record.error ?? null,
      Number(record.sourceCount ?? 0),
      Number(record.diffCount ?? 0),
      durationMs,
      record.sources === undefined || record.sources === null ? null : JSON.stringify(record.sources),
      status,
      nowIso(),
      id,
    ],
  )
  return getCheckRun(store, id)
}

/** Insert the candidates of one run. Ids are generated here so the caller cannot collide. */
export function insertCandidates(store, rows = []) {
  const written = []
  for (const row of rows) {
    const id = String(row.id ?? randomUUID())
    const runId = String(row.runId ?? '').trim()
    const sourceTitle = String(row.sourceTitle ?? '').trim()
    if (runId === '') throw new Error('runId is required')
    if (sourceTitle === '') throw new Error('sourceTitle is required')
    const createdAt = row.createdAt ?? nowIso()
    store.run(
      `INSERT INTO policy_candidates
         (id, run_id, source_url, source_title, snippet, retrieved_at, query, status,
          policy_id, confirmed_by, confirmed_at, diff_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', NULL, NULL, NULL, ?, ?)`,
      [
        id,
        runId,
        row.sourceUrl ?? null,
        sourceTitle,
        String(row.snippet ?? ''),
        row.retrievedAt ?? createdAt,
        String(row.query ?? '').trim(),
        JSON.stringify(row.diff ?? { matched: [], differences: [], notes: [] }),
        createdAt,
      ],
    )
    written.push(id)
  }
  return written
}

/** One run by id, or `null`. */
export function getCheckRun(store, id) {
  const target = String(id ?? '').trim()
  if (target === '') return null
  const row = store.get('SELECT * FROM policy_check_runs WHERE id = ?', [target])
  return row === undefined || row === null ? null : rowToRun(row)
}

/** The newest run, or `null` when the button has never been pressed. */
export function latestCheckRun(store) {
  const row = store.get('SELECT * FROM policy_check_runs ORDER BY observed_at DESC, rowid DESC LIMIT 1')
  return row === undefined || row === null ? null : rowToRun(row)
}

/** Recent runs, newest first — the history the PRD asks to be able to check. */
export function listCheckRuns(store, limit = 10) {
  const size = Math.max(1, Math.min(100, Number(limit) || 10))
  return store.all(
    'SELECT * FROM policy_check_runs ORDER BY observed_at DESC, rowid DESC LIMIT ?',
    [size],
  ).map(rowToRun)
}

/** Candidates, optionally of one run and/or one status. */
export function listCandidates(store, options = {}) {
  const where = []
  const params = []
  const runId = String(options.runId ?? '').trim()
  if (runId !== '') {
    where.push('run_id = ?')
    params.push(runId)
  }
  const status = String(options.status ?? '').trim()
  if (status !== '') {
    where.push('status = ?')
    params.push(status)
  }
  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
  return store.all(
    `SELECT * FROM policy_candidates ${clause} ORDER BY created_at ASC, rowid ASC`,
    params,
  ).map(rowToCandidate)
}

/** One candidate by id, or `null`. */
export function getCandidate(store, id) {
  const target = String(id ?? '').trim()
  if (target === '') return null
  const row = store.get('SELECT * FROM policy_candidates WHERE id = ?', [target])
  return row === undefined || row === null ? null : rowToCandidate(row)
}

/**
 * Record a human decision on one candidate.
 *
 * Guarded by `status = 'candidate'`: the row is only updated when it is still
 * undecided, so a second writer cannot overwrite the first decision. Returns the
 * updated row, or `null` when nothing was updated (already decided / missing).
 */
export function decideCandidate(store, record = {}) {
  const id = String(record.id ?? '').trim()
  const status = String(record.status ?? '').trim()
  if (id === '') throw new Error('candidate id is required')
  if (!['confirmed', 'rejected'].includes(status)) throw new Error(`unknown candidate status "${status}"`)
  const at = record.at ?? nowIso()
  const result = store.run(
    `UPDATE policy_candidates
        SET status = ?, policy_id = ?, confirmed_by = ?, confirmed_at = ?, decision_reason = ?
      WHERE id = ? AND status = 'candidate'`,
    [status, record.policyId ?? null, record.by ?? null, at, record.reason ?? null, id],
  )
  if (Number(result?.changes ?? 0) === 0) return null
  return getCandidate(store, id)
}

/**
 * Recompute the run's terminal status from its candidates.
 *
 * The run is **derived**, never self-reported: while any candidate is still
 * `candidate` the run stays `pending_confirm`; once every candidate is decided it
 * becomes `confirmed` if at least one was adopted, otherwise `rejected`. A failed
 * run is never rewritten — the search never got far enough to have candidates.
 */
export function recomputeRunStatus(store, runId) {
  const run = getCheckRun(store, runId)
  if (run === null) return null
  if (run.status === 'failed') return run
  const rows = listCandidates(store, { runId: run.id })
  if (rows.length === 0) return run
  const open = rows.filter(row => row.status === 'candidate').length
  if (open > 0) {
    if (run.status !== 'pending_confirm') {
      store.run("UPDATE policy_check_runs SET status = 'pending_confirm' WHERE id = ?", [run.id])
    }
    return getCheckRun(store, run.id)
  }
  const confirmed = rows.filter(row => row.status === 'confirmed').length
  const status = confirmed > 0 ? 'confirmed' : 'rejected'
  if (run.status !== status) {
    /* The run-level 确认人/理由 is copied from the **last** decision of the run
       (per-candidate rows keep every decision). A run with several candidates can
       have several people; the run row is a summary, not a substitute for them. */
    const decided = rows
      .filter(row => row.status === status)
      .sort((a, b) => String(a.confirmedAt ?? '').localeCompare(String(b.confirmedAt ?? '')))
    const last = decided[decided.length - 1] ?? null
    store.run(
      'UPDATE policy_check_runs SET status = ?, decided_at = ?, confirmed_by = ?, confirm_reason = ? WHERE id = ?',
      [status, nowIso(), last?.confirmedBy ?? null, last?.decisionReason ?? null, run.id],
    )
  }
  return getCheckRun(store, run.id)
}

/**
 * The page slice: the newest run, its candidates, the counts of that run, and a
 * short run history.
 *
 * `latestRun: null` is its own answer ("never pressed"), not a zero-count run.
 * `counts` are counted over the newest run only, so a confirmed old run cannot
 * make today's empty run look busy.
 */
export function policyCandidateView(store, options = {}) {
  const latest = latestCheckRun(store)
  const rows = latest === null ? [] : listCandidates(store, { runId: latest.id })
  const counts = { total: rows.length, candidate: 0, confirmed: 0, rejected: 0 }
  for (const row of rows) {
    if (row.status === 'candidate') counts.candidate += 1
    if (row.status === 'confirmed') counts.confirmed += 1
    if (row.status === 'rejected') counts.rejected += 1
  }
  return {
    latestRun: latest,
    rows,
    counts,
    recentRuns: listCheckRuns(store, 5),
    defaultQuery: options.defaultQuery ?? null,
  }
}

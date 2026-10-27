/**
 * The keyword pipeline's run log — what ran, with which parameters, and how
 * many rows each stage let through.
 *
 * The five stages of the optimization pipeline already existed as five separate
 * entry points (`queryMaster`, the `classify.js` pure functions,
 * `buildKeywordAllocation`, `buildEmbeddingPlan`, and the export). Nothing tied
 * them together, so "what did this run actually do" had no answer afterwards.
 * This module is the trace: one row per run, one row per stage.
 *
 * Three properties hold it together:
 *
 *   - **Run-level facts live once.** `marketplace` / `params_json` /
 *     `started_at` describe the run, not the step. Putting `stage` on the run
 *     row would repeat them five times per run, and a fact stored five times
 *     eventually disagrees with itself.
 *
 *   - **The chain invariant is checked here, not by the caller.** Every stage's
 *     output is the next stage's input; that is what makes the numbers mean
 *     something. A guard in the orchestrator only protects the orchestrator, so
 *     `assertChain` runs at this boundary and a broken chain is refused rather
 *     than written.
 *
 *   - **A failed run is still a run.** The stages that completed keep their
 *     rows, the stage that threw gets `status='failed'`, and the run carries the
 *     message. Dropping a failed run silently would make the history say the
 *     pipeline never ran when in fact it ran and broke.
 *
 * `params_json` is a snapshot of the inputs, not a promise of reproducibility:
 * three weeks later `kw_master` has moved on, so re-running gives different
 * numbers. What is reproducible is the parameters and the definitions — callers
 * must say that, not "the result can be reproduced exactly".
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'

/** The five stages, in the order the pipeline runs them. */
export const PIPELINE_STAGES = ['filter', 'tier', 'assign', 'place', 'export']

/** Stage names as the page and the tools print them. */
export const STAGE_LABELS = {
  filter: '筛选',
  tier: '分层',
  assign: '分派',
  place: '落位',
  export: '出表',
}

const RUN_STATUSES = new Set(['done', 'failed'])
const STAGE_STATUSES = new Set(['done', 'failed'])

function int(value) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? Math.trunc(number) : 0
}

function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(Math.max(Math.trunc(number), min), max)
}

/**
 * The invariants of one run's stage rows.
 *
 * Four rules, and each one exists because breaking it produces a log that reads
 * fine and is wrong:
 *
 *   1. stages are numbered 1..n with no gaps, and stage n is the nth stage of
 *      the pipeline — so a missing step cannot pass as a shorter pipeline;
 *   2. a failed stage is the last row — a failure ends the run, and a stage
 *      after a failure would have no input to describe;
 *   3. a run whose last row is `done` has all five stages — "the pipeline
 *      finished" and "the pipeline stopped early" must not look the same;
 *   4. each stage's output count equals the next stage's input count — the
 *      numbers are a chain, and an unchained count is decoration.
 *
 * Rule 4 stops at the export stage: its output is CSV rows, not words, so the
 * chain is checked *into* export and never out of it.
 */
export function assertChain(stages) {
  if (stages.length === 0) throw new Error('a pipeline run needs at least one stage row')
  if (stages.length > PIPELINE_STAGES.length) {
    throw new Error(`a pipeline run has ${PIPELINE_STAGES.length} stages, got ${stages.length} rows`)
  }

  for (const [index, stage] of stages.entries()) {
    const seq = index + 1
    if (stage.seq !== seq) {
      throw new Error(`stage rows must be numbered 1..n with no gaps: expected seq ${seq}, got ${stage.seq}`)
    }
    const expected = PIPELINE_STAGES[index]
    if (stage.stage !== expected) {
      throw new Error(`stage ${seq} must be "${expected}", got "${stage.stage}"`)
    }
    if (!STAGE_STATUSES.has(stage.status)) {
      throw new Error(`stage ${seq} (${stage.stage}) has status "${stage.status}"; expected done or failed`)
    }
    if (stage.status === 'failed' && index !== stages.length - 1) {
      throw new Error(`stage ${seq} (${stage.stage}) failed but is not the last row — a failure ends the run`)
    }
  }

  const last = stages[stages.length - 1]
  if (last.status === 'done' && stages.length !== PIPELINE_STAGES.length) {
    throw new Error(
      `a completed run needs all ${PIPELINE_STAGES.length} stage rows, got ${stages.length} — `
      + 'a finished run and a truncated one must not look the same',
    )
  }

  for (let index = 0; index < stages.length - 1; index += 1) {
    const current = stages[index]
    const next = stages[index + 1]
    if (current.output_count !== next.input_count) {
      throw new Error(
        `stage chain broken between ${current.stage} and ${next.stage}: `
        + `${current.stage}.output_count=${current.output_count} but ${next.stage}.input_count=${next.input_count}`,
      )
    }
  }

  return true
}

/** One `kw_pipeline_run` row, camelCased and with its JSON columns parsed. */
function runToRun(row, stages = null) {
  if (row === null || row === undefined) return null
  const run = {
    runId: row.id,
    marketplace: row.marketplace,
    productLine: row.product_line,
    params: parseJson(row.params_json, {}),
    trigger: row.trigger,
    inputCount: row.input_count,
    outputCount: row.output_count,
    status: row.status,
    error: row.error,
    result: parseJson(row.result_json, null),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
  if (stages !== null) run.stages = stages.map(stageToStage)
  return run
}

function stageToStage(row) {
  return {
    seq: row.seq,
    stage: row.stage,
    label: STAGE_LABELS[row.stage] ?? row.stage,
    inputCount: row.input_count,
    outputCount: row.output_count,
    params: parseJson(row.params_json, null),
    result: parseJson(row.result_json, null),
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/**
 * Write one run and its stages, atomically.
 *
 * The whole thing is one transaction on purpose: a run row with no stages, or a
 * stage list missing a step, is a log that cannot be read. Either all of it
 * lands or none of it does.
 *
 * The caller is expected to call this **even when the pipeline threw** — with
 * the completed stages marked `done`, the stage that failed marked `failed`, and
 * the run's `error` set. The error then travels on from the caller; this
 * function does not swallow it and does not throw one of its own.
 */
export function recordRun(store, { run, stages } = {}) {
  const id = String(run?.id ?? randomUUID())
  const status = String(run?.status ?? 'done')
  if (!RUN_STATUSES.has(status)) throw new Error(`unknown run status "${status}" (expected done or failed)`)

  const error = run?.error === undefined || run?.error === null ? null : String(run.error)
  if (status === 'failed' && (error === null || error === '')) {
    throw new Error('a failed run must carry its error — recording a failure without a reason is lying about it')
  }

  const record = {
    id,
    marketplace: String(run?.marketplace ?? 'US').toUpperCase(),
    productLine: run?.productLine === undefined || run?.productLine === null ? null : String(run.productLine),
    paramsJson: json(run?.params ?? {}),
    trigger: String(run?.trigger ?? 'tool'),
    inputCount: int(run?.inputCount),
    outputCount: int(run?.outputCount),
    status,
    error,
    resultJson: json(run?.result ?? null),
    startedAt: String(run?.startedAt ?? nowIso()),
    finishedAt: run?.finishedAt === undefined || run?.finishedAt === null ? nowIso() : String(run.finishedAt),
  }

  const stageRows = (Array.isArray(stages) ? stages : []).map((stage, index) => ({
    id: String(stage?.id ?? randomUUID()),
    runId: id,
    seq: int(stage?.seq ?? index + 1),
    stage: String(stage?.stage ?? PIPELINE_STAGES[index] ?? ''),
    inputCount: int(stage?.inputCount),
    outputCount: int(stage?.outputCount),
    paramsJson: json(stage?.params ?? null),
    resultJson: json(stage?.result ?? null),
    status: String(stage?.status ?? 'done'),
    startedAt: String(stage?.startedAt ?? record.startedAt),
    finishedAt: stage?.finishedAt === undefined || stage?.finishedAt === null ? record.finishedAt : String(stage.finishedAt),
  }))

  assertChain(stageRows)

  store.tx(() => {
    store.run(
      `INSERT INTO kw_pipeline_run
         (id, marketplace, product_line, params_json, trigger, input_count, output_count,
          status, error, result_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id, record.marketplace, record.productLine, record.paramsJson, record.trigger,
        record.inputCount, record.outputCount, record.status, record.error, record.resultJson,
        record.startedAt, record.finishedAt,
      ],
    )
    for (const stage of stageRows) {
      store.run(
        `INSERT INTO kw_pipeline_stage
           (id, run_id, seq, stage, input_count, output_count, params_json, result_json,
            status, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stage.id, stage.runId, stage.seq, stage.stage, stage.inputCount, stage.outputCount,
          stage.paramsJson, stage.resultJson, stage.status, stage.startedAt, stage.finishedAt,
        ],
      )
    }
  })

  return getRun(store, id)
}

/** One run with its stages, or `null` when there is no such run. */
export function getRun(store, id) {
  const key = String(id ?? '').trim()
  if (key === '') return null
  const row = store.get('SELECT * FROM kw_pipeline_run WHERE id = ?', [key])
  if (row === undefined) return null
  const stages = store.all(
    'SELECT * FROM kw_pipeline_stage WHERE run_id = ? ORDER BY seq ASC',
    [key],
  )
  return runToRun(row, stages)
}

/**
 * The most recent runs, newest first.
 *
 * Deliberately without their stages: the history list is read on every state
 * poll, and loading five stage rows per run to draw a one-line summary is cost
 * with no reader. `getRun` is the way to get one run in full.
 */
export function listRuns(store, { marketplace = null, limit = 10 } = {}) {
  const market = marketplace === null || marketplace === undefined || String(marketplace).trim() === ''
    ? null
    : String(marketplace).toUpperCase()
  const cap = clamp(limit, 1, 100)

  const rows = store.all(
    `SELECT * FROM kw_pipeline_run
      ${market === null ? '' : 'WHERE marketplace = ?'}
      ORDER BY started_at DESC, rowid DESC
      LIMIT ?`,
    market === null ? [cap] : [market, cap],
  )
  const total = Number(store.get(
    `SELECT COUNT(*) AS n FROM kw_pipeline_run ${market === null ? '' : 'WHERE marketplace = ?'}`,
    market === null ? [] : [market],
  )?.n ?? 0)

  return { rows: rows.map(row => runToRun(row)), total }
}

/**
 * How many runs exist, and how many of them failed.
 *
 * `failed` is counted separately and always reported: a history that shows only
 * the successful runs is a history that hides the breakages.
 */
export function runStats(store, { marketplace = null } = {}) {
  const market = marketplace === null || marketplace === undefined || String(marketplace).trim() === ''
    ? null
    : String(marketplace).toUpperCase()
  const params = market === null ? [] : [market]
  const where = market === null ? '' : 'WHERE marketplace = ?'
  return {
    total: Number(store.get(`SELECT COUNT(*) AS n FROM kw_pipeline_run ${where}`, params)?.n ?? 0),
    failed: Number(store.get(`SELECT COUNT(*) AS n FROM kw_pipeline_run ${where === '' ? 'WHERE' : `${where} AND`} status = 'failed'`, params)?.n ?? 0),
    lastStartedAt: store.get(`SELECT started_at AS t FROM kw_pipeline_run ${where} ORDER BY started_at DESC LIMIT 1`, params)?.t ?? null,
  }
}

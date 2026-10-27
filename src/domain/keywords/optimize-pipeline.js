/**
 * The keyword pipeline: one run of the five stages, with a trace.
 *
 * This is an **orchestrator**, not an implementation. Every stage already
 * exists and none of them is rewritten here:
 *
 *   1  filter  `queryMaster`                        src/store/kw.js
 *   2  tier    the tier columns `recomputeMaster` already wrote
 *   3  assign  `buildKeywordAllocation`             src/domain/optimize/plan.js
 *   4  place   `buildEmbeddingPlan` / `backendCandidates`  src/domain/optimize/embedding.js
 *   5  export  `writeActiveSets`                    src/domain/keywords/export.js
 *
 * What was missing was a single caller that runs them in order, counts what
 * went in and out of each, and writes that down. Five separate entry points is
 * why "what did this run actually do" had no answer: the numbers existed, the
 * run did not.
 *
 * Two rules the caller can rely on:
 *
 *   - **A dry run writes nothing at all** — no CSV, no run row. A preview that
 *     records itself as a run makes the history say the pipeline ran when the
 *     user was only looking.
 *   - **A failure is recorded before it is re-thrown.** The stages that
 *     completed keep their rows, the stage that threw is marked `failed`, and
 *     the run carries the message. The error still propagates — this function
 *     does not turn a breakage into a quiet `{ ok: false }`.
 *
 * Stage 2 does not recompute tiers: `recomputeMaster` already assigned them, and
 * recomputing here would be a second implementation of the same judgement that
 * could disagree with the stored one. It only counts.
 */

import { randomUUID } from 'node:crypto'

import { buildKeywordAllocation } from '../optimize/plan.js'
import { backendCandidates, buildEmbeddingPlan } from '../optimize/embedding.js'
import { nowIso } from '../../store/db.js'
import { queryMaster } from '../../store/kw.js'
import { PIPELINE_STAGES, STAGE_LABELS, recordRun } from '../../store/pipeline.js'
import { recordFileReport } from '../../store/reports.js'
import { writeActiveSets } from './export.js'

/** How far down the library a run looks when the caller does not say. */
export const DEFAULT_PIPELINE_LIMIT = 2000

/** The cap, so a caller cannot ask for the whole library by accident. */
export const MAX_PIPELINE_LIMIT = 50_000

function positiveInt(value, fallback, max = MAX_PIPELINE_LIMIT) {
  const number = Number(value)
  // `Math.max(1, NaN)` is NaN, and `length >= NaN` is always false — an invalid
  // limit would silently remove the cap rather than tighten it.
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.trunc(number), max)
}

/**
 * Rows in volume order, without a page cap.
 *
 * `queryMaster` clamps its own limit to 1,000, so a run that wants more has to
 * page. The page size matches the export's for the same reason the export has
 * one: two callers reading "the library in volume order" must read the same
 * order, or the CSV the pipeline writes and the CSV the export writes would
 * differ in content while both claiming to be volume-ordered.
 */
function collectRows(store, { marketplace, productLine, filters, limit }) {
  const rows = []
  const pageSize = 1000
  for (let offset = 0; offset < limit; offset += pageSize) {
    const page = queryMaster(store, {
      ...filters,
      marketplace,
      productLine: productLine ?? undefined,
      order: 'volume',
      limit: Math.min(pageSize, limit - offset),
      offset,
    })
    rows.push(...page.rows)
    if (page.rows.length < pageSize) break
  }
  return rows
}

/**
 * Run one stage, record its counts, and let its error through.
 *
 * The failed stage's `input_count` is the real one — it was handed that many
 * rows — and its `output_count` is 0, because it produced nothing. That is what
 * keeps the chain readable after a breakage: the counts up to the failure still
 * add up.
 */
function runStage(stages, name, inputCount, body) {
  const seq = stages.length + 1
  const startedAt = nowIso()
  try {
    const outcome = body() ?? {}
    stages.push({
      seq,
      stage: name,
      inputCount,
      outputCount: Number(outcome.outputCount ?? inputCount),
      params: outcome.params ?? null,
      result: outcome.result ?? null,
      status: 'done',
      startedAt,
      finishedAt: nowIso(),
    })
    return outcome.value
  } catch (error) {
    stages.push({
      seq,
      stage: name,
      inputCount,
      outputCount: 0,
      params: null,
      result: { error: error.message },
      status: 'failed',
      startedAt,
      finishedAt: nowIso(),
    })
    throw error
  }
}

/**
 * Run the five stages and return what happened.
 *
 * `params` is snapshotted into the run row as given, so a run re-read later can
 * say what it was asked to do. It is a snapshot of the *request*, not a promise
 * that repeating it reproduces the bytes: `kw_master` moves as files are
 * imported, so the same parameters against a later library give different
 * numbers. Callers must say that, not "the result can be reproduced exactly".
 */
export function runPipeline(store, params = {}) {
  const marketplace = String(params.marketplace ?? 'US').trim().toUpperCase()
  const productLine = params.productLine === undefined || params.productLine === null || String(params.productLine).trim() === ''
    ? null
    : String(params.productLine)
  const limit = positiveInt(params.limit, DEFAULT_PIPELINE_LIMIT)
  const purpose = String(params.purpose ?? 'all').trim().toLowerCase()
  const outDir = String(params.outDir ?? '').trim()
  const dryRun = params.dryRun === true
  const trigger = String(params.trigger ?? 'tool')

  if (outDir === '') throw new Error('outDir is required — the pipeline has to be told where the CSVs go')

  const filters = {}
  if (params.minVolume !== undefined && params.minVolume !== null) filters.minVolume = Number(params.minVolume)
  if (params.svTier !== undefined && params.svTier !== null && String(params.svTier).trim() !== '') filters.svTier = String(params.svTier)
  if (params.opportunity !== undefined && params.opportunity !== null && String(params.opportunity).trim() !== '') filters.opportunity = String(params.opportunity)
  if (params.productLine !== undefined && params.productLine !== null && String(params.productLine).trim() !== '') filters.productLine = String(params.productLine)

  const startedAt = nowIso()
  const stages = []
  let runId = null

  try {
    /* Stage 1 — filter. Its input is the whole scope, before the filters, so
       "how much of the library did the filters let through" is answerable. */
    const scopeTotal = Number(queryMaster(store, {
      marketplace,
      productLine: productLine ?? undefined,
      limit: 1,
    }).total)
    const rows = runStage(stages, 'filter', scopeTotal, () => {
      const collected = collectRows(store, { marketplace, productLine, filters, limit })
      return {
        outputCount: collected.length,
        params: { ...filters, limit, productLine },
        result: { scopeTotal, returned: collected.length, truncated: collected.length >= limit && scopeTotal > collected.length },
        value: collected,
      }
    })

    /* Stage 2 — tier. Counting only; the tiers were assigned by
       `recomputeMaster` and are read from the row. */
    const tierCounts = runStage(stages, 'tier', rows.length, () => {
      const byTier = {}
      for (const row of rows) {
        const key = row.sv_tier ?? 'unknown'
        byTier[key] = (byTier[key] ?? 0) + 1
      }
      return { outputCount: rows.length, result: { byTier }, value: byTier }
    })

    const keywords = rows.map(row => ({
      keyword: row.keyword,
      tier: row.sv_tier ?? null,
      rank: row.rank ?? null,
      scan_depth: row.scan_depth ?? null,
      libraryTier: row.sv_tier ?? null,
    }))

    /* Stage 3 — assign. No listing and no draft: a pipeline run works from the
       library, not from one ASIN's copy, so the allocation is decided by tier
       and volume alone. */
    const allocation = runStage(stages, 'assign', rows.length, () => {
      const built = buildKeywordAllocation({ keywords, listing: null, fields: {}, marketplace })
      return {
        outputCount: built.entries.length,
        result: {
          entries: built.entries.length,
          byOwner: Object.fromEntries(Object.entries(built.byOwner ?? {}).map(([owner, list]) => [owner, list.length])),
          violations: built.violations?.length ?? 0,
        },
        value: built,
      }
    })

    /* Stage 4 — place. Which word goes in which field, and which are left for
       the backend. */
    const placed = runStage(stages, 'place', allocation.entries.length, () => {
      const plan = buildEmbeddingPlan({ keywords, listing: null })
      const backend = backendCandidates({ plan, fields: {}, marketplace })
      return {
        outputCount: plan.entries.length,
        result: { entries: plan.entries.length, backendCandidates: backend.length, quickWins: plan.quickWins?.length ?? 0 },
        value: { plan, backend },
      }
    })

    /* Stage 5 — export. Same function the export tool calls, so the two
       artefacts cannot drift apart. `write: false` on a dry run still computes
       the files and their row counts, which is what makes the preview and the
       real run agree on the numbers. */
    const exported = runStage(stages, 'export', placed.plan.entries.length, () => {
      const written = writeActiveSets({ rows, outDir, purpose, marketplace, productLine, write: !dryRun })
      const csvRows = written.files.reduce((sum, file) => sum + file.count, 0)
      return {
        outputCount: csvRows,
        params: { purpose, outDir },
        result: { files: written.files.map(file => ({ id: file.id, count: file.count, path: file.file })), csvRows },
        value: written,
      }
    })

    const totals = {
      inputCount: stages[0].inputCount,
      outputCount: exported.files.reduce((sum, file) => sum + file.count, 0),
    }

    if (dryRun !== true) {
      const run = recordRun(store, {
        run: {
          id: randomUUID(),
          marketplace,
          productLine,
          params: { ...filters, limit, purpose, outDir, dryRun: false },
          trigger,
          inputCount: totals.inputCount,
          outputCount: totals.outputCount,
          status: 'done',
          result: { files: exported.files.map(file => ({ path: file.file, rows: file.count })) },
          startedAt,
          finishedAt: nowIso(),
        },
        stages,
      })
      runId = run.runId

      /* Index the CSVs this run wrote, next to the run itself and inside the same
         `dryRun !== true` guard — a dry run writes no files, and registering the
         ones it merely computed would put rows in the report centre pointing at
         paths that do not exist. Same call the export tool makes, so the two
         cannot disagree about what an exported file looks like. */
      for (const file of exported.files) {
        recordFileReport(store, {
          kind: 'kw-export',
          file: file.file,
          title: `${marketplace}${productLine === null || productLine === undefined ? '' : ` / ${productLine}`} · ${file.label}（管道）`,
          scope: { marketplace, productLine, set: file.id, runId },
        })
      }
    }

    return {
      ok: true,
      runId,
      dryRun,
      marketplace,
      productLine,
      stages: stages.map(stage => ({
        seq: stage.seq,
        stage: stage.stage,
        label: STAGE_LABELS[stage.stage] ?? stage.stage,
        inputCount: stage.inputCount,
        outputCount: stage.outputCount,
        status: stage.status,
      })),
      totals,
      tierCounts,
      files: exported.files.map(file => ({ path: file.file, rows: file.count, id: file.id, label: file.label })),
      backend: { bytes: exported.backend.bytes, budget: exported.backend.budget, overflow: exported.backend.overflow },
      message: describeRun({ marketplace, productLine, rows, totals, tiers: tierCounts, limit, scopeTotal, dryRun }),
    }
  } catch (error) {
    /* Record first, then re-throw. A run that broke is still a run, and a
       history that only holds the successes is a history that lies. */
    if (dryRun !== true && stages.length > 0) {
      try {
        recordRun(store, {
          run: {
            id: randomUUID(),
            marketplace,
            productLine,
            params: { ...filters, limit, purpose, outDir, dryRun: false },
            trigger,
            inputCount: stages[0].inputCount,
            outputCount: stages[stages.length - 1].outputCount,
            status: 'failed',
            error: error.message,
            result: { failedStage: stages[stages.length - 1].stage },
            startedAt,
            finishedAt: nowIso(),
          },
          stages,
        })
      } catch (recordError) {
        // Never let the record-keeping failure replace the real one: the real
        // one is what the user needs to see.
        console.warn(`[amazon-ops] could not record the failed pipeline run: ${recordError.message}`)
      }
    }
    throw error
  }
}

/**
 * The run in one paragraph, including what it did *not* cover.
 *
 * The truncation sentence is the point: a run that stopped at `limit` and says
 * only "2,000 words" reads as "the library holds 2,000 words". The two numbers
 * are printed together, or the smaller one gets read as the whole.
 */
function describeRun({ marketplace, productLine, rows, totals, tiers, limit, scopeTotal, dryRun }) {
  const scope = [marketplace, productLine].filter(Boolean).join(' / ')
  const parts = [
    `${dryRun ? '试跑（未写文件、未落库）' : '运行完成'}: ${scope}`,
    `筛选 ${scopeTotal} → ${rows.length} 条`,
    /* 2026-10-25（R-72）：这一行原来只说「出表 N 行 CSV」，而 N 是**各集合行数合计**
       （见下面 `exported.files.reduce(sum + file.count)`）。它上一行是「落位 2,000 条」——
       两个数并排、单位不同，读者只能读成「最后一步死了 1,082 个词」。

       实测（dryRun, US/bench-cushion, limit 2000）：
         落位 2,000 → 出表 918
       而 amzn_kw_export 同一批参数给出的七个集合是 8 / 77 / 17 / 148 / 456 / 114 / 98 —— **加起来正是 918**。
       所以「918」不是「活下来的词数」，是「词 × 命中的集合」的行数：
       一个词可以同时进标题与广告词组，也可能一个集合都没进（各集合有自己的门槛）。 */
    `出表 ${totals.outputCount} 行 CSV（各集合行数合计 —— 不是词数）`,
  ]
  if (totals.outputCount !== rows.length) {
    parts.push(`落位 ${rows.length} 条词 → 出表 ${totals.outputCount} 行：**这两个数不是同一个单位**。`
      + '一行 = 一个词进了一个集合，按 SOP §6.1–6.4 的门槛分档'
      + '（如标题要搜索量 ≥ 10,000 且层级 ≤ L3；后台词还要受 249 字节预算挤压）。'
      + '所以既可能一词多行，也可能有词一个集合都没进 —— 要看具体哪些词进了哪个集合，用 `amzn_kw_export`。')
  }
  if (rows.length >= limit && scopeTotal > rows.length) {
    parts.push(`⚠️ 已到上限 ${limit} 条，库里还有 ${scopeTotal - rows.length} 条没进这次运行 —— 提高 limit 或收窄筛选条件`)
  }
  const tierText = Object.entries(tiers ?? {})
    .map(([key, count]) => `${key}=${count}`)
    .join('  ')
  if (tierText !== '') parts.push(`分层: ${tierText}`)
  parts.push('这些数字是按当时的库与这些参数算出的；库变了，同样的参数会得到不同的数。')
  return parts.join('\n')
}

/** The stage names, exported so a caller can label a table without re-typing. */
export { PIPELINE_STAGES }

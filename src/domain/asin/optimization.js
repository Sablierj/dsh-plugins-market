/**
 * Per-ASIN optimization history (module 05, F05-02 tab 8 of 9).
 *
 * ## Four tables, one story
 *
 * "Did this ASIN get optimized, what did it change, was it published, and did we
 * roll it back" is answered by four tables that already have readers:
 *
 *   `optimization_run`     → `listOptimizationRuns`   (`store/queries.js`)
 *   `optimization_draft`   → `listOptimizationDrafts` (`store/queries.js`)
 *   `publication_record`   → `listPublications`      (`store/observe.js`)
 *   `rollback_task`        → `listRollbackTasks`      (`store/observe.js`)
 *   `observation_plan`     → `listObservationPlans`   (`store/observe.js`)
 *
 * This module arranges them for one ASIN. It does not re-read any of them with its
 * own SQL: a second `SELECT * FROM optimization_run WHERE asin = ?` would be a
 * second answer to "which runs does this ASIN have", and the two would differ on
 * ordering and on the `draft_count` join.
 *
 * ## The draft's decision is five states, derived from content
 *
 * `accepted` is a nullable integer — `1` accepted, `0` rejected, `null` undecided
 * (`queries.js` documents the three). Two later columns, `voided_at` and
 * `deferred_at`, override it. The order matters and is the criterion:
 *
 *   a draft that was accepted and **then voided** is currently `voided`. Printing
 *   `accepted` for it sends a reader to re-apply a change that was already
 *   withdrawn — and the row would look perfectly fine while they did it.
 *
 * The labels live here and the page prints them; the page contains no
 * `accepted === 1` test.
 *
 * ## What this tab cannot say
 *
 * 「草案被采纳的时间与操作人」. `optimization_draft` has `accepted` and
 * `updated_at`, and `updated_at` moves for the void/defer writes too, so the row
 * cannot answer who decided or when. `accepted_at` exists in this repository — on
 * `optimization_plan_check`, a different table for a different decision (B-13c/d) —
 * which is exactly why this is worth saying out loud rather than guessing.
 */

import { listOptimizationDrafts, listOptimizationRuns } from '../../store/queries.js'
import { listObservationPlans, listPublications, listRollbackTasks } from '../../store/observe.js'
import { OPTIMIZATION_RUN_STATUSES } from '../states.js'
import { ASIN_NO_SOURCE_TEXT, unsourced } from './unsourced.js'
import { clampLimit } from './limits.js'

/**
 * The status vocabulary is **not** declared here: `optimization_run.status` is
 * written through `assertRunStatus`, whose closed set is `OPTIMIZATION_RUN_STATUSES`
 * (`domain/states.js`). A copy would let this module render a status the writer
 * refuses. Only the Chinese labels are new, because nothing else needed them.
 */
export const ASIN_RUN_STATUS_LABELS = {
  running: '进行中',
  done: '已完成',
  failed: '失败',
  abandoned: '已放弃',
}

export const ASIN_ACCEPTANCE_STATES = ['accepted', 'declined', 'pending', 'voided', 'deferred']

export const ASIN_ACCEPTANCE_LABELS = {
  accepted: '已采纳',
  declined: '未采纳',
  pending: '待裁决',
  voided: '已作废',
  deferred: '已延后',
}

export const ASIN_RUN_ROW_LIMIT = 20
export const ASIN_RUN_ROW_LIMIT_MAX = 200
export const ASIN_RUN_DRAFT_LIMIT = 200
export const ASIN_PUBLICATION_LIMIT = 50

export const ASIN_DRAFT_ACCEPTANCE_REASON =
  'optimization_draft 只有 accepted INTEGER 一列（src/store/schema.js:489）与 updated_at（:609），'
  + '没有 accepted_at / accepted_by。updated_at 是「最后一次写这一行」，它也会被 voided_at / deferred_at '
  + '的写入推走，所以从这一行读不出「谁在什么时候采纳了它」。'
  + '全仓 grep accepted_at 只命中 optimization_plan_check（:3095，B-13c/d 的另一张表）。'

/**
 * `accepted` / `declined` / `pending` / `voided` / `deferred`, first hit wins.
 *
 * The order **is** the criterion. `voided` and `deferred` are tested before
 * `accepted` so that a withdrawn change is never reported as a live decision.
 */
export function classifyDraftAcceptance(draft) {
  const voidedAt = draft?.voided_at ?? draft?.voidedAt
  if (voidedAt !== null && voidedAt !== undefined && String(voidedAt).trim() !== '') return 'voided'
  const deferredAt = draft?.deferred_at ?? draft?.deferredAt
  if (deferredAt !== null && deferredAt !== undefined && String(deferredAt).trim() !== '') return 'deferred'
  if (draft?.accepted === 1 || draft?.accepted === true) return 'accepted'
  if (draft?.accepted === 0 || draft?.accepted === false) return 'declined'
  return 'pending'
}

const parseJson = (text, fallback) => {
  if (text === null || text === undefined) return fallback
  try {
    const parsed = JSON.parse(String(text))
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/** One ASIN's optimization history. */
export function buildAsinOptimizationView(store, { asin, marketplace, limit } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (key === '') return { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }
  if (market === '') return { ok: false, code: 'BAD_REQUEST', error: 'marketplace is required' }

  const bound = clampLimit(limit, ASIN_RUN_ROW_LIMIT, ASIN_RUN_ROW_LIMIT_MAX)
  const listed = listOptimizationRuns(store, { asin: key, marketplace: market, limit: bound })

  const runs = listed.rows.map(row => {
    const drafts = listOptimizationDrafts(store, row.id)
    const draftsTruncated = drafts.length > ASIN_RUN_DRAFT_LIMIT
    const kept = draftsTruncated ? drafts.slice(0, ASIN_RUN_DRAFT_LIMIT) : drafts
    return {
      id: row.id,
      status: row.status,
      statusLabel: ASIN_RUN_STATUS_LABELS[row.status] ?? row.status,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
      draftCount: Number(row.draft_count ?? drafts.length),
      draftVersion: row.draft_version ?? null,
      rulesVersion: row.rules_version ?? null,
      ruleSetVersion: row.rule_set_version ?? null,
      hasReport: row.report_html !== null && row.report_html !== undefined
        && String(row.report_html).trim() !== '',
      hasReportMd: row.report_md !== null && row.report_md !== undefined
        && String(row.report_md).trim() !== '',
      sessionId: row.session_id ?? null,
      summary: row.summary ?? null,
      error: row.error ?? null,
      draftsTruncated,
      drafts: kept.map(draft => {
        const state = classifyDraftAcceptance(draft)
        return {
          id: draft.id,
          field: draft.field,
          before: draft.before ?? null,
          after: draft.after ?? null,
          accepted: draft.accepted === null || draft.accepted === undefined ? null : Number(draft.accepted),
          acceptedState: state,
          acceptedLabel: ASIN_ACCEPTANCE_LABELS[state],
          severity: draft.severity ?? null,
          rationale: draft.rationale ?? null,
          keywords: parseJson(draft.keywords_json, null),
          violations: parseJson(draft.violations_json, null),
          voidedAt: draft.voided_at ?? null,
          deferredAt: draft.deferred_at ?? null,
          updatedAt: draft.updated_at ?? null,
        }
      }),
    }
  })

  /* A recount of the drafts that were returned, never an accumulator. The page
     prints these and the list beside them, so a drifted total is a page that
     contradicts itself with no error anywhere. */
  const allDrafts = runs.flatMap(run => run.drafts)
  const totals = {
    runs: runs.length,
    drafts: allDrafts.length,
    accepted: allDrafts.filter(d => d.acceptedState === 'accepted').length,
    declined: allDrafts.filter(d => d.acceptedState === 'declined').length,
    pending: allDrafts.filter(d => d.acceptedState === 'pending').length,
    voided: allDrafts.filter(d => d.acceptedState === 'voided').length,
    deferred: allDrafts.filter(d => d.acceptedState === 'deferred').length,
    withReport: runs.filter(run => run.hasReport).length,
  }

  const publicationList = listPublications(store, {
    asin: key, marketplace: market, limit: ASIN_PUBLICATION_LIMIT,
  })
  const publications = publicationList.rows.map(record => {
    /* `listRollbackTasks` answers with `{rows, limit}`, not an array — unlike
       `listObservationPlans`, which answers with an array. The two readers are
       neighbours in `store/observe.js` and disagree on their return shape, so this
       is read from the source rather than assumed. */
    const rollbacks = listRollbackTasks(store, { publicationId: record.id, limit: 20 }).rows
    const plans = listObservationPlans(store, record.id)
    return {
      id: record.id,
      kind: record.kind,
      publishedAt: record.publishedAt ?? null,
      runId: record.runId ?? null,
      draftVersion: record.draftVersion ?? null,
      rollbackOf: record.rollbackOf ?? null,
      deviated: record.deviated === true,
      deviationRule: record.deviationRule ?? null,
      baselineChoice: record.baselineChoice ?? null,
      observationStartAt: record.observationStartAt ?? null,
      observationTerminatedAt: record.observationTerminatedAt ?? null,
      approvedFields: record.approved === null ? null : Object.keys(record.approved ?? {}),
      publishedFields: Object.keys(record.published ?? {}),
      uncoveredFields: Array.isArray(record.uncovered) ? record.uncovered : [],
      rollbackProtected: record.rollbackProtected === true,
      rollbacks: rollbacks.map(task => ({
        id: task.id,
        status: task.status,
        statusLabel: task.statusLabel ?? null,
        reason: task.reason ?? null,
        createdAt: task.createdAt ?? null,
        closedAt: task.closedAt ?? null,
        stale: task.stale === true,
        staleReason: task.staleReason ?? null,
      })),
      observationPlans: plans.map(plan => ({
        id: plan.id,
        status: plan.status,
        hypothesis: plan.hypothesis ?? null,
        windowDays: plan.windowDays ?? null,
        changedCount: Array.isArray(plan.changed) ? plan.changed.length : 0,
        successCount: Array.isArray(plan.success) ? plan.success.length : 0,
        failCount: Array.isArray(plan.fail) ? plan.fail.length : 0,
        rebuild: plan.rebuild === true,
        createdAt: plan.createdAt ?? null,
      })),
    }
  })

  const notes = []
  if (listed.total > runs.length) {
    notes.push(`这条 ASIN 一共有 ${listed.total} 轮优化，这次只列前 ${runs.length} 轮 —— `
      + '「没列出来」与「没有这一轮」不是一件事。')
  }
  if (runs.some(run => run.draftsTruncated)) {
    notes.push(`有轮次的草案超过 ${ASIN_RUN_DRAFT_LIMIT} 条，只列了前面那些。`)
  }
  if (publications.some(record => record.deviated === true)) {
    notes.push('有发布记录偏离了批准的草案 —— 偏离是「与批准的不一致」，不是「发布失败」。')
  }

  return {
    ok: true,
    asin: key,
    marketplace: market,
    source: 'optimization_run + optimization_draft + publication_record + rollback_task + observation_plan',
    runs,
    runCount: runs.length,
    runsTruncated: listed.total > runs.length,
    runTotal: listed.total,
    totals,
    publications,
    publicationCount: publications.length,
    publicationTotal: publicationList.total,
    statuses: [...OPTIMIZATION_RUN_STATUSES],
    statusLabels: { ...ASIN_RUN_STATUS_LABELS },
    acceptanceStates: [...ASIN_ACCEPTANCE_STATES],
    acceptanceLabels: { ...ASIN_ACCEPTANCE_LABELS },
    unsourced: [unsourced({
      id: 'draft-acceptance-audit',
      label: '草案被采纳的时间与操作人',
      feature: 'F05-02',
      reason: ASIN_DRAFT_ACCEPTANCE_REASON,
    })],
    noSourceText: ASIN_NO_SOURCE_TEXT,
    notes,
  }
}

/**
 * Does this draft still belong to the context it was written in?
 *
 * The failure this exists to prevent is specific and quiet. A user selects
 * `US / bench-cushion`, the agent prepares an optimization and saves a draft
 * against it. Then the user switches the scope to `DE`, and later presses
 * "accept" on a draft that was written from US data, US limits and a US rule
 * set. Nothing about that draft looks wrong — it is a well-formed draft — and
 * the report it produces would be a confident answer about the wrong product on
 * the wrong site.
 *
 * So a draft carries the id of the context it was written in, and the submit
 * path asks this module before it accepts anything.
 *
 * ## Fail-closed on an unknown context
 *
 * A draft with no `context_id` is one written **before** the column existed
 * (v19 leaves them `NULL` on purpose — inventing an id for a historical row
 * would be forging the very fact being checked). It is reported as `unknown`,
 * and `unknown` is not submittable. That is the strict direction, and it is the
 * right one here: the cost of re-preparing a draft is one tool call, and the
 * cost of publishing the wrong one is a listing.
 *
 * This is the mechanism only. `amzn_optimize_save` is the submit path that asks
 * it — before it decides a single field, so a refusal costs no write — and the
 * draft it judges carries the id it was written under, stamped by the persist
 * path (`amzn_optimize_validate`) from the workbench's current context. The
 * page's accept button asking the same question is still module 13's job.
 */

import { PROBLEM_CODES } from '../states.js'

/** The three answers, spelled out so a caller cannot invent a fourth. */
export const DRAFT_CONTEXT_STATES = ['ok', 'context_changed', 'unknown']

/**
 * The state of a draft against the context selected now.
 *
 * `contextId` is the id of the *current* context; a missing or empty one is
 * treated as "there is no current context", which cannot match any draft and
 * therefore reports `context_changed` rather than `ok`.
 */
export function draftContextState(draft, contextId) {
  const stored = draft?.context_id ?? draft?.contextId ?? null
  const storedText = stored === null || stored === undefined ? '' : String(stored).trim()
  if (storedText === '') return 'unknown'
  const currentText = contextId === null || contextId === undefined ? '' : String(contextId).trim()
  if (currentText === '') return 'context_changed'
  return storedText === currentText ? 'ok' : 'context_changed'
}

/**
 * May this draft be submitted in the context selected now?
 *
 * Returns `{ ok: false, code, state, error }` rather than throwing, because
 * this is asked at the edge of a write (the error contract in ARCHITECTURE §9)
 * and the caller has to turn the answer into a message either way.
 *
 * Both non-`ok` states share one code. They are different facts — "the scope
 * moved" and "this draft never recorded a scope" — and the message says which,
 * but a caller branching on the *code* wants one branch for "not submittable",
 * and a second code would only invite one of the two to be forgotten.
 */
export function canSubmitDraft(draft, contextId) {
  const state = draftContextState(draft, contextId)
  if (state === 'ok') return { ok: true, state }
  const error = state === 'unknown'
    ? '这份草案没有记录它是在哪个上下文里生成的（v19 之前的草案），不能提交：请重新生成一版。'
    : '上下文已变化：这份草案生成时的上下文与当前选中的不一致，不能提交。请按当前上下文重新生成。'
  return { ok: false, state, code: PROBLEM_CODES.DRAFT_CONTEXT_CHANGED, error }
}

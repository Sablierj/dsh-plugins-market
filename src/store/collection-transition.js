/**
 * One status change and its history row, written together.
 *
 * ## Why this is its own module
 *
 * Contract §5.2 says every transition of a collection task must append a row to
 * `collection_task_event`. Three writers now move that status — the run path
 * (`sources/collection.js`), the human decisions (`domain/collect/waiting.js`)
 * and the timeout scan — and "remember to append the event" is not a rule a
 * caller can be trusted to follow three times. Writing the pair here means the
 * only way to change a status is to leave a trace of it, and the failure mode
 * this removes is invisible: a task list that looks right with a timeline that
 * is quietly short.
 *
 * ## Why not in `collection-task-event.js`
 *
 * That module's charter is "append-only: **no update and no delete**", and it is
 * asserted as such (`tests/b04-collect-foundation.mjs` ㉝). A function that
 * UPDATEs `collection_task` does not belong in a file whose whole point is that
 * nothing there is ever rewritten — the reader would have to check which of its
 * exports mutate what.
 *
 * ## `fromStatus` and the terminal stamp
 *
 * `fromStatus` is the status the caller read before calling; it is recorded as
 * given, because the history is a record of what happened rather than a
 * derivation of it. `resolved_at` is stamped only for a **terminal** state
 * (`done` / `cancelled`) — `partial` and `failed` are retried by submitting a
 * new task, so stamping "this ended" on them would be the same mistake as
 * calling them `done`.
 */

import { COLLECTION_TASK_TERMINAL_STATES } from '../domain/states.js'
import { appendTaskEvent } from './collection-task-event.js'
import { updateCollectionTask } from './queries.js'
import { nowIso } from './db.js'

/**
 * Move one task, and append the event that says so.
 *
 * Returns the timestamp used for both writes, so a caller that needs to report
 * "when" does not have to read the row back to find out.
 */
export function transitionCollectionTask(store, {
  taskId, fromStatus = null, toStatus, reason = null, source = 'plugin', by = null,
  evidence = null, patch = {}, at = null,
} = {}) {
  const stamp = at ?? nowIso()
  const terminal = COLLECTION_TASK_TERMINAL_STATES.includes(toStatus) ? { resolved_at: stamp } : {}
  updateCollectionTask(store, taskId, { ...patch, status: toStatus, ...terminal })
  appendTaskEvent(store, { taskId, fromStatus, toStatus, reason, source, by, evidence, at: stamp })
  return stamp
}

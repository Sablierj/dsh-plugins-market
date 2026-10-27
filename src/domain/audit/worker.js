/**
 * Funnel ③ — the background worker's writes.
 *
 * ## Why there are three funnels and not one
 *
 * The tool funnel (`src/tools/index.js`) wraps a tool's `execute`, and the page
 * funnel (`src/web/routes.js`) wraps a route body. Both wrap *something with a
 * single entry point*, which is what lets "every write is audited" be true
 * without touching a tool file or a route body.
 *
 * A worker has no such point. The collection worker's write is one iteration of
 * a loop that also drives a browser, parses a page and pushes progress; the
 * import worker's write is one call in the middle of parsing a file. There is no
 * callback to hand over, and wrapping the whole task would record "a task ran"
 * rather than "this ASIN row and this snapshot were written" — which is the
 * question §31 sends a reader to the audit log with.
 *
 * So the worker calls this itself, once per object it wrote. The **same three
 * rules** the other two funnels keep:
 *
 *   - **Only writes are recorded.** A skipped file, a dry run, a page that
 *     parsed nothing — each returns before reaching a call, so no row is written
 *     for a write that did not happen. That is control flow, not a check.
 *   - **Only successful writes.** A target that failed or was blocked is not
 *     passed here; the caller emits rows for the targets it actually wrote.
 *   - **A failed read of the old value does not fail the write**, and it is
 *     named in `reason` rather than left as an unexplained `null`. "There was no
 *     previous value" and "we could not read one" are different facts.
 *
 * ## `worker` is part of the row, not a detail of the caller
 *
 * The `route` column is what an audit reader uses to tell the planes apart
 * (`tool:…` / `api:…`). A worker row says `worker:<name>`, and the name is
 * required: a row from an unnamed worker is a row a reader has to guess about,
 * which is the one thing an audit log cannot afford.
 *
 * `actorKind` stays **`system`**, which is the third value the schema already
 * declares (`schema.js`: 「actor_kind 区分 'page' | 'agent' | 'system'」). A
 * fourth value would be a plane nobody can filter by — the audit view's dropdown
 * and `amzn_audit_query`'s enum both list the declared three — so the rows would
 * be written and then be findable only by scrolling. The precision the reader
 * needs is not lost: `route` says `worker:collect` / `worker:kw-import`, so
 * "which worker" is answered by the column that exists for exactly that.
 *
 * ## Why a throw here never reaches the caller
 *
 * By the time this runs the write has committed. Letting a descriptor bug
 * propagate would turn a successful collection into a failed one to save a log
 * line. The failure is reported through `onError` — the two callers pass their
 * own channel (the collection worker keeps an activity feed, the import worker
 * keeps a logger) — so a broken descriptor is loud somewhere rather than silent
 * everywhere.
 *
 * ## Redaction is not repeated here
 *
 * `recordAudit` already runs every payload through
 * `domain/audit/redact.js` before it stringifies it, so a credential-shaped key
 * cannot reach the table by way of a new call site. A second mask in this file
 * would be the second ruler that module's header warns about.
 */

import { recordAudit } from '../../store/audit.js'

/**
 * Record one write made by a background worker.
 *
 * @param {object} store
 * @param {object} entry
 * @param {string} entry.worker       which worker wrote ('collect' / 'kw-import')
 * @param {string} entry.action       the action string, from `domain/audit/targets.js` ACTIONS
 * @param {string} entry.objectType   a member of AUDIT_OBJECT_TYPES
 * @param {string|null} [entry.objectId]
 * @param {object|null} [entry.before] the state read before the write
 * @param {object|null} [entry.after]  the state read back after the write
 * @param {object|null} [entry.impact] counts that do not fit one object
 * @param {string|null} [entry.reason] why a value is missing (a failed prior read)
 * @param {(error: Error) => void} [onError] where a descriptor bug is reported
 * @returns {boolean} whether a row was written
 */
export function recordWorkerWrite(store, entry = {}, onError) {
  try {
    const worker = String(entry.worker ?? '').trim()
    /* A row that cannot say which worker wrote it is the shape this funnel exists
       to avoid, so it is a bug in our own call site rather than bad user input. */
    if (worker === '') throw new Error('a worker write must name the worker that made it')
    recordAudit(store, {
      action: entry.action,
      objectType: entry.objectType,
      objectId: entry.objectId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      impact: entry.impact ?? null,
      reason: entry.reason ?? null,
      route: `worker:${worker}`,
      /* 'system', not 'agent' and not 'page': neither the conversation nor a
         click asked for this write — a queued task or an import ran. See the
         header for why this is not a fourth actor kind. */
      actorKind: 'system',
    })
    return true
  } catch (error) {
    onError?.(error)
    return false
  }
}

/** The worker names this plugin writes rows under. Exported so a caller and a
 *  test name the same plane rather than two spellings of it. */
export const WORKER_NAMES = {
  collect: 'collect',
  keywordImport: 'kw-import',
}

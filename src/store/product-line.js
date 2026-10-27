/**
 * `product_line_version`: the append-only history of how a line was configured.
 *
 * A product line is a **versioned configuration object**. Changing its signals
 * does not edit the row's meaning — it publishes a new version — because a past
 * optimization run was judged against the configuration of its day, and editing
 * that in place makes "what was this line when that run happened" unanswerable.
 *
 * The same discipline the rule roster already follows, for the same reason.
 *
 * `product_line.signals_json` stays as the **current effective value**: a lot of
 * queries read it (the classifier, the master recompute, the page), and making
 * them all resolve a version would be a join on every read to answer a question
 * they are not asking. It is a cache with a source now, which it never had.
 */

import { nowIso } from './db.js'
import { classifyWithSignals } from '../domain/keywords/impact.js'
import { readSignalCategories, signalsJson } from '../domain/keywords/signals.js'

/** The newest version row for a line, or `null` when it has never had one. */
export function currentLineVersion(store, productLineId) {
  const row = store.get(
    'SELECT * FROM product_line_version WHERE product_line_id = ? ORDER BY version DESC LIMIT 1',
    [String(productLineId ?? '').trim()],
  )
  return row ?? null
}

/** Every version of a line, newest first. */
export function listLineVersions(store, productLineId, { limit = 50 } = {}) {
  return store.all(
    'SELECT * FROM product_line_version WHERE product_line_id = ? ORDER BY version DESC LIMIT ?',
    [String(productLineId ?? '').trim(), Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 200)],
  )
}

/**
 * Append one version row.
 *
 * `signals` is the JSON text to snapshot (the canonical form), not an object:
 * a version is a record of bytes, and re-serialising at read time would let the
 * snapshot change shape with the code.
 */
export function recordLineVersion(store, record = {}) {
  const productLineId = String(record.productLineId ?? '').trim()
  if (productLineId === '') throw new Error('productLineId is required')
  const version = Math.trunc(Number(record.version))
  if (!Number.isFinite(version) || version < 1) throw new Error(`version must be a positive integer (got ${record.version})`)
  const signals = record.signals === undefined || record.signals === null ? 'null' : String(record.signals)
  const id = String(record.id ?? '').trim() || `plv-${productLineId}-v${version}`
  store.run(
    `INSERT INTO product_line_version (id, product_line_id, version, name, signals_json, note, changed_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      productLineId,
      version,
      record.name === undefined ? null : String(record.name),
      signals,
      record.note === undefined || record.note === null ? null : String(record.note),
      record.changedBy === undefined || record.changedBy === null ? null : String(record.changedBy),
      nowIso(),
    ],
  )
  return store.get('SELECT * FROM product_line_version WHERE id = ?', [id])
}

/**
 * Write a line's signals as a new version, and return what changed.
 *
 * Returns `{ id, version, changed, signals, impact }`. `changed: false` means the
 * canonical form of the incoming signals equals what is stored — writing a
 * version for an identical value would fill the history with no-ops and make
 * "how many times was this line changed" a question about clicks.
 *
 * `impact` is computed with **the same function the preview uses**, on the
 * signals that were just stored, so "the preview said 214" and "the save says
 * 214" are the same call and not two that happen to agree.
 */
export function setLineSignalsVersioned(store, record = {}) {
  const id = String(record.id ?? record.productLineId ?? '').trim()
  if (id === '') throw new Error('product line id is required')

  return store.tx(() => {
    const row = store.get('SELECT * FROM product_line WHERE id = ?', [id])
    if (row === undefined) throw new Error(`no product line "${id}"`)
    const next = signalsJson(record.signals)

    /* Compare the *canonical* forms. `readSignalCategories` accepts the old
       shapes, so a line that v23 has not rewritten yet still compares equal to
       its own content rather than looking changed on every save. */
    const current = signalsJson(readSignalCategories(row.signals_json, id).signals)
    if (next === current) {
      return {
        id,
        version: Number(row.version ?? 1),
        changed: false,
        signals: next,
        impact: classifyWithSignals(store, { productLineId: id, signals: readSignalCategories(next, id).signals }),
      }
    }

    const latest = currentLineVersion(store, id)
    const version = latest === null ? 1 : Number(latest.version) + 1
    const name = record.name === undefined || record.name === null ? row.name : String(record.name)
    const note = record.note === undefined ? row.note : (record.note === null ? null : String(record.note))

    recordLineVersion(store, { productLineId: id, version, name, signals: next, note, changedBy: record.changedBy })
    store.run(
      'UPDATE product_line SET name = ?, note = ?, signals_json = ?, version = ? WHERE id = ?',
      [name, note, next, version, id],
    )
    return {
      id,
      version,
      changed: true,
      signals: next,
      impact: classifyWithSignals(store, { productLineId: id, signals: readSignalCategories(next, id).signals }),
    }
  })
}

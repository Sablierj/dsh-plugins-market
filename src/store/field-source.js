/**
 * `asin_field_source`: who told us this field, when, and in what shape.
 *
 * The table has existed since v1 with a `source_id` and a normalised `value`.
 * That answered "which source" and nothing else — not *when* the value was
 * observed, not what it looked like before parsing, and not whether it was
 * collected or imported. v24 adds the seven columns that answer those, and this
 * module is the only place they are written.
 *
 * ## The three timestamps, and why they are not one
 *
 *   - `observed_at` — when the fact was true *in the world*. The collector knows
 *     this; an import usually does not, and says so by passing `null`.
 *   - `ingested_at` — when the row reached this database. Always known.
 *   - `updated_at` — when the row was last written. Known, but it moves.
 *
 * Collapsing them would make a value imported today from a file exported last
 * month look a month fresher than it is. **`observed_at` is never defaulted to
 * now**: a value nobody dated must read as undated, because the alternative is a
 * timestamp that looks measured and was invented.
 *
 * ## `raw_value` is kept beside `value`
 *
 * `1,299.99` and `1.299,99` are the same number on different storefronts, and the
 * parser is what decides. Keeping the original is what makes a parse bug
 * findable: without it, a mis-parsed price is a plausible number with nothing to
 * compare it against.
 */

import { DATA_STATES } from '../domain/states.js'
import { nowIso } from './db.js'
import { refreshConflictsFor } from './conflict.js'

/** Where a value came from. `derived` is a value this plugin computed. */
export const SOURCE_TYPES = ['collect', 'import', 'manual', 'derived']

/** The seven data states (upstream §8.2), from the one vocabulary. */
export const QUALITY_STATES = DATA_STATES

/** The three-state contract: `undefined` keeps, `null` clears. */
function optional(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** One field's sources, newest observation first. */
export function listFieldSources(store, { asin, marketplace, field } = {}) {
  const clauses = []
  const params = []
  if (asin !== undefined) { clauses.push('asin = ?'); params.push(String(asin).trim().toUpperCase()) }
  if (marketplace !== undefined) { clauses.push('marketplace = ?'); params.push(String(marketplace).trim().toUpperCase()) }
  if (field !== undefined) { clauses.push('field = ?'); params.push(String(field).trim()) }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  return store.all(
    `SELECT * FROM asin_field_source${where} ORDER BY observed_at DESC NULLS LAST, updated_at DESC`,
    params,
  )
}

/** Every field of one ASIN, grouped by field name. */
export function fieldProvenance(store, { asin, marketplace }) {
  const rows = listFieldSources(store, { asin, marketplace })
  const byField = new Map()
  for (const row of rows) {
    if (!byField.has(row.field)) byField.set(row.field, [])
    byField.get(row.field).push(row)
  }
  return byField
}

/**
 * Write one field's provenance.
 *
 * `sourceType` is derived from the source's `kind` when the caller does not say:
 * a browser source collects, a manual one is typed. An unknown source leaves it
 * `null` rather than guessing `collect` — the field exists to distinguish the
 * four cases, and a default that is right most of the time is wrong exactly when
 * somebody is looking.
 */
export function upsertFieldSource(store, record = {}) {
  const asin = String(record.asin ?? '').trim().toUpperCase()
  const marketplace = String(record.marketplace ?? '').trim().toUpperCase()
  const field = String(record.field ?? '').trim()
  const sourceId = String(record.sourceId ?? '').trim()
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN "${record.asin}"`)
  if (marketplace === '') throw new Error('marketplace is required')
  if (field === '') throw new Error('field is required')
  if (sourceId === '') throw new Error('sourceId is required')

  const sourceType = record.sourceType === undefined
    ? deriveSourceType(store, sourceId)
    : (record.sourceType === null ? null : String(record.sourceType))
  if (sourceType !== null && !SOURCE_TYPES.includes(sourceType)) {
    throw new Error(`sourceType must be one of: ${SOURCE_TYPES.join(' | ')} (got ${JSON.stringify(record.sourceType)})`)
  }
  const qualityState = record.qualityState === undefined || record.qualityState === null
    ? null
    : String(record.qualityState)
  if (qualityState !== null && !QUALITY_STATES.includes(qualityState)) {
    throw new Error(`qualityState must be one of: ${QUALITY_STATES.join(' | ')} (got ${JSON.stringify(record.qualityState)})`)
  }

  const now = nowIso()
  store.run(
    `INSERT INTO asin_field_source
       (asin, marketplace, field, source_id, value, confidence, updated_at,
        source_type, observed_at, ingested_at, raw_value, raw_unit, parser_version, quality_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asin, marketplace, field, source_id) DO UPDATE SET
       value          = excluded.value,
       confidence     = excluded.confidence,
       updated_at     = excluded.updated_at,
       source_type    = COALESCE(excluded.source_type, asin_field_source.source_type),
       /* COALESCE, so a later write that does not restate the observation time
          does not erase the one that was recorded. "I do not know when" must not
          overwrite "I know when". */
       observed_at    = COALESCE(excluded.observed_at, asin_field_source.observed_at),
       ingested_at    = excluded.ingested_at,
       raw_value      = COALESCE(excluded.raw_value, asin_field_source.raw_value),
       raw_unit       = COALESCE(excluded.raw_unit, asin_field_source.raw_unit),
       parser_version = COALESCE(excluded.parser_version, asin_field_source.parser_version),
       quality_state  = COALESCE(excluded.quality_state, asin_field_source.quality_state)`,
    [
      asin,
      marketplace,
      field,
      sourceId,
      record.value === undefined || record.value === null ? null : JSON.stringify(record.value),
      Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : 1,
      now,
      sourceType,
      /* Explicitly null when not given: an import that does not know when the
         file was produced must not look like it observed the value just now. */
      optional(record.observedAt),
      optional(record.ingestedAt) ?? now,
      optional(record.rawValue),
      optional(record.rawUnit),
      optional(record.parserVersion),
      qualityState,
    ],
  )
  /* The primary detection hook: writing a source that disagrees with the ones
     already there must raise the conflict here, so "a conflict exists" is a
     consequence of the write path rather than of somebody remembering to scan. */
  refreshConflictsFor(store, { asin, marketplace, fields: [field] })
  return store.get(
    'SELECT * FROM asin_field_source WHERE asin = ? AND marketplace = ? AND field = ? AND source_id = ?',
    [asin, marketplace, field, sourceId],
  )
}

/** `browser` collects, `manual` is typed, `api` collects. Unknown → `null`. */
function deriveSourceType(store, sourceId) {
  const row = store.get('SELECT kind FROM source WHERE id = ?', [sourceId])
  if (row === undefined) return null
  if (row.kind === 'manual') return 'manual'
  if (row.kind === 'browser' || row.kind === 'api') return 'collect'
  return null
}

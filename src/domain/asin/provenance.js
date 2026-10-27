/**
 * Per-ASIN provenance and audit trail (module 05, F05-02 tab 9 of 9).
 *
 * ## `audit_log.object_id` has more than one shape, and that is not a detail
 *
 * The audit funnel records "what was written" with one `object_id` string per
 * action, and the ASIN actions do not agree on what that string is:
 *
 *   `asin.upsert`         the **bare** ASIN          (`domain/audit/targets.js`)
 *   `asin.field_correct`  `<ASIN>@<MARKETPLACE>`
 *   `asin.archive`        `<ASIN>@<MARKETPLACE>`
 *   variant writes        `<PARENT>-><CHILD>@<MARKETPLACE>` (object_type `asin_variant`)
 *   `asin.import`         **null** — one import moves N rows
 *
 * A tab that queried `object_id = '<ASIN>@US'` would silently drop every bulk
 * upsert; one that queried the bare ASIN would drop every field correction. Both
 * would render a perfectly plausible list. So this module reads all three
 * matchable shapes, records on every row **which** shape matched
 * (`matchedBy` / `objectIdForm`, both derived here), and names the fourth shape —
 * the null one — as a structural hole in `unsourced[]`, because no object lookup
 * can ever reach it.
 *
 * ## `observed_at` NULL is not "observed at zero"
 *
 * `asin_field_source.observed_at` is nullable on purpose: v24's backfill left it
 * NULL for pre-v24 rows rather than inventing a timestamp, and
 * `upsertFieldSource` COALESCEs it so a later write that does not restate the time
 * cannot erase one that was recorded. A row with no `observed_at` therefore means
 * "we do not know when", which is a different sentence from any date — so it gets
 * its own state, and the page prints the label this module produced.
 *
 * ## One rule, one implementation
 *
 *   field sources     → `listFieldSources`   (`store/field-source.js`)
 *   disagreements     → `fieldConflictsOf`   (`domain/asin/conflicts.js`, B-05c)
 *   audit rows        → `listAudit`          (`store/audit.js`)
 *   version index     → `listSnapshots`      (`store/snapshot.js`)
 *   conflicts         → `listConflicts`      (`store/conflict.js`)
 *   variant edges     → `listVariantRelations` (`store/variant.js`)
 *
 * Nothing here re-derives any of them. `archiveEvents` is injected because
 * `buildAsinDetail` already read it for the detail header — reading it twice would
 * be two answers to "has this ASIN ever been archived".
 */

import { listFieldSources, SOURCE_TYPES } from '../../store/field-source.js'
import { listAudit } from '../../store/audit.js'
import { listSnapshots } from '../../store/snapshot.js'
import { listConflicts } from '../../store/conflict.js'
import { listVariantRelations } from '../../store/variant.js'
import { fieldConflictsOf } from './conflicts.js'
import { ASIN_NO_SOURCE_TEXT, unsourced } from './unsourced.js'
import { clampLimit } from './limits.js'

/** The four shapes `object_id` takes for ASIN writes. */
export const ASIN_AUDIT_ID_FORMS = ['bare', 'qualified', 'variant', 'null']

export const ASIN_AUDIT_ID_FORM_LABELS = {
  bare: '裸 ASIN',
  qualified: '<ASIN>@<站点>',
  variant: '变体边坐标',
  null: '没有对象（批量写入）',
}

/**
 * Which shapes an object lookup can reach.
 *
 * `null` is listed and marked unmatchable rather than omitted: the shape exists in
 * the writer, and a vocabulary that silently lacks it is how "we did not look" and
 * "there is nothing to find" become the same row on a page.
 */
export const ASIN_AUDIT_ID_FORM_MATCHABLE = {
  bare: true, qualified: true, variant: true, null: false,
}

export const ASIN_FIELD_SOURCE_STATES = ['observed', 'unobserved']

export const ASIN_FIELD_SOURCE_STATE_LABELS = {
  observed: '有观测时间',
  unobserved: '未记录观测时间',
}

export const ASIN_SOURCE_TYPE_LABELS = {
  collect: '采集', import: '导入', manual: '人工', derived: '派生',
}

export const ASIN_AUDIT_ROW_LIMIT = 50
export const ASIN_AUDIT_ROW_LIMIT_MAX = 500
export const ASIN_SNAPSHOT_ROW_LIMIT = 50
export const ASIN_SNAPSHOT_ROW_LIMIT_MAX = 200

export const ASIN_IMPORT_ATTRIBUTION_REASON =
  '一次批量导入的审计行 object_id 是 null（src/domain/audit/targets.js:743，理由在 :740-742：一次导入动的是 N 行），'
  + 'impact 里只有 characters / sourceId / onInvalid / onDuplicate（:748-755），没有 ASIN。'
  + '所以按对象反查不到它，按内容也反查不到它 —— 「这条 ASIN 的某个字段是被哪一次导入覆盖的」在本仓没有来源。'
  + '要能回答它得给 asin.import 的 impact 加一份 ASIN 清单（或给字段来源行记导入批次），那是迁移与新表，不在本批。'

/**
 * `observed` / `unobserved`, derived from content.
 *
 * The test is on the observation time, not on `ingested_at`: an import that was
 * ingested today but observed at an unknown date is still "we do not know when".
 */
export function classifyFieldSourceState(row) {
  const at = row?.observed_at ?? row?.observedAt
  return at === null || at === undefined || String(at).trim() === '' ? 'unobserved' : 'observed'
}

/** Which of the four shapes this `object_id` is. Derived from the string itself. */
export function classifyAuditObjectId(objectId) {
  if (objectId === null || objectId === undefined || String(objectId).trim() === '') return 'null'
  const text = String(objectId)
  if (text.includes('->')) return 'variant'
  return text.includes('@') ? 'qualified' : 'bare'
}

/** The variant edge coordinate the audit funnel writes, for one relation row.
 *
 *  `listVariantRelations` **hydrates** its rows (`parentAsin` / `childAsin`), so the
 *  coordinate is built from the camelCase names. Reading `parent_asin` off a
 *  hydrated row yields `undefined` and the lookup key becomes `->@US` — which does
 *  not throw, it just matches nothing, and "no variant writes in this ASIN's trail"
 *  reads exactly like "this ASIN has no variant writes". */
function variantKey(relation) {
  const parent = String(relation.parentAsin ?? relation.parent_asin ?? '').toUpperCase()
  const child = String(relation.childAsin ?? relation.child_asin ?? '').toUpperCase()
  const market = String(relation.marketplace ?? '').toUpperCase()
  return `${parent}->${child}@${market}`
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

/**
 * One ASIN's provenance and audit trail.
 *
 * `archiveEvents` is injected (required): `buildAsinDetail` reads it once for the
 * header chip, and this tab prints the same list.
 */
export function buildAsinSourceView(store, {
  asin, marketplace, archiveEvents, auditLimit, snapshotLimit,
} = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (key === '') return { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }
  if (market === '') return { ok: false, code: 'BAD_REQUEST', error: 'marketplace is required' }
  if (!Array.isArray(archiveEvents)) {
    throw new Error('buildAsinSourceView needs `archiveEvents` (listArchiveEvents output) — '
      + 'reading it a second time would be a second answer to "has this ASIN ever been archived"')
  }

  const auditBound = clampLimit(auditLimit, ASIN_AUDIT_ROW_LIMIT, ASIN_AUDIT_ROW_LIMIT_MAX)
  const snapshotBound = clampLimit(snapshotLimit, ASIN_SNAPSHOT_ROW_LIMIT, ASIN_SNAPSHOT_ROW_LIMIT_MAX)

  /* ── field-level provenance ─────────────────────────────────────────────── */
  const sourceRows = listFieldSources(store, { asin: key, marketplace: market })
  const conflictedFields = fieldConflictsOf(sourceRows)

  const fieldSources = sourceRows.map(row => {
    const state = classifyFieldSourceState(row)
    return {
      field: row.field,
      sourceId: row.source_id,
      sourceType: row.source_type ?? null,
      sourceTypeLabel: row.source_type === null || row.source_type === undefined
        ? '未知'
        : (ASIN_SOURCE_TYPE_LABELS[row.source_type] ?? row.source_type),
      value: row.value ?? null,
      confidence: row.confidence ?? null,
      observedAt: row.observed_at ?? null,
      ingestedAt: row.ingested_at ?? null,
      updatedAt: row.updated_at ?? null,
      qualityState: row.quality_state ?? null,
      parserVersion: row.parser_version ?? null,
      state,
      stateLabel: ASIN_FIELD_SOURCE_STATE_LABELS[state],
    }
  })

  const byFieldMap = new Map()
  for (const row of fieldSources) {
    if (!byFieldMap.has(row.field)) byFieldMap.set(row.field, [])
    byFieldMap.get(row.field).push(row)
  }
  const byField = [...byFieldMap.entries()].map(([field, sources]) => {
    const distinct = new Set(sources.map(row => JSON.stringify(row.value)).filter(text => text !== 'null'))
    return {
      field,
      sources,
      sourceCount: sources.length,
      distinctValues: distinct.size,
      conflicted: conflictedFields.has(field),
    }
  }).sort((left, right) => left.field.localeCompare(right.field))

  const fieldCounts = {
    rows: fieldSources.length,
    fields: byField.length,
    sources: new Set(fieldSources.map(row => row.sourceId)).size,
    observed: fieldSources.filter(row => row.state === 'observed').length,
    unobserved: fieldSources.filter(row => row.state === 'unobserved').length,
    unknownSourceType: fieldSources.filter(row => row.sourceType === null).length,
    conflicted: byField.filter(row => row.conflicted).length,
  }

  /* ── the audit trail: three matchable shapes, merged ────────────────────── */
  const seen = new Map()
  const collect = (rows, matchedBy) => {
    for (const entry of rows) {
      if (entry === null) continue
      const previous = seen.get(entry.id)
      /* One row can match two shapes only if the shapes are equal, so first wins is
         enough — but the form is always derived from the row, never assumed. */
      if (previous !== undefined) continue
      seen.set(entry.id, { ...entry, matchedBy, objectIdForm: classifyAuditObjectId(entry.objectId) })
    }
  }

  collect(listAudit(store, { objectType: 'asin', objectId: key, limit: auditBound + 1 }), 'bare')
  collect(listAudit(store, { objectType: 'asin', objectId: `${key}@${market}`, limit: auditBound + 1 }), 'qualified')

  /* Variant writes name the edge, not the ASIN, so the edge coordinates have to be
     enumerated first. Only edges this ASIN is an endpoint of — a variant write that
     touches neither end of this ASIN is not part of its trail. */
  const edges = [
    ...listVariantRelations(store, { marketplace: market, parentAsin: key }),
    ...listVariantRelations(store, { marketplace: market, childAsin: key }),
  ]
  const edgeKeys = [...new Set(edges.map(variantKey))]
  for (const coordinate of edgeKeys) {
    collect(listAudit(store, { objectType: 'asin_variant', objectId: coordinate, limit: auditBound + 1 }), 'variant')
  }

  const merged = [...seen.values()].sort((left, right) => {
    if (left.at !== right.at) return left.at < right.at ? 1 : -1
    return left.id < right.id ? 1 : -1
  })
  const auditTruncated = merged.length > auditBound
  const audit = (auditTruncated ? merged.slice(0, auditBound) : merged).map(entry => ({
    id: entry.id,
    at: entry.at,
    actor: entry.actor,
    actorKind: entry.actorKind,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    objectIdForm: entry.objectIdForm,
    objectIdFormLabel: ASIN_AUDIT_ID_FORM_LABELS[entry.objectIdForm],
    matchedBy: entry.matchedBy,
    route: entry.route,
    reason: entry.reason,
    impact: entry.impact,
  }))

  const auditFormCounts = Object.fromEntries(ASIN_AUDIT_ID_FORMS.map(form => [form, 0]))
  for (const entry of audit) auditFormCounts[entry.objectIdForm] += 1

  /* ── version index, scheme versions, conflicts ─────────────────────────── */
  /* `listSnapshots` hydrates its rows (camelCase) and reports `matched` for the
     filtered count — the difference between "this ASIN has none" and "the cap hid
     them" is exactly what `matched` is for, so it is read rather than re-counted. */
  const snapshotPage = listSnapshots(store, {
    objectType: 'listing', objectId: `${key}@${market}`, includeArchived: true, limit: snapshotBound + 1,
  })
  const snapshotTruncated = snapshotPage.rows.length > snapshotBound
  const snapshotKept = snapshotTruncated ? snapshotPage.rows.slice(0, snapshotBound) : snapshotPage.rows
  const snapshots = snapshotKept.map(row => ({
    id: row.id,
    objectType: row.objectType,
    objectId: row.objectId,
    version: row.version ?? null,
    refTable: row.refTable ?? null,
    refId: row.refId ?? null,
    createdAt: row.createdAt ?? null,
    createdBy: row.createdBy ?? null,
    archivedAt: row.archivedAt ?? null,
    archived: row.archived === true,
    readable: row.readable === true,
    comparable: row.comparable === true,
    note: row.note ?? null,
  }))

  /* Which scheme version produced each section reading. Read from the section
     results rather than from `collection_scheme` directly: the question is "what
     was this reading taken with", and only the reading row knows. */
  const schemeVersions = store.all(
    `SELECT section, scheme_version, collected_at, task_id
       FROM collection_section_result
      WHERE asin = ? AND marketplace = ? AND scheme_version IS NOT NULL
      ORDER BY collected_at DESC`,
    [key, market],
  ).map(row => ({
    section: row.section,
    schemeVersion: row.scheme_version,
    collectedAt: row.collected_at ?? null,
    taskId: row.task_id ?? null,
  }))

  const conflicts = listConflicts(store, { asin: key, marketplace: market }).map(row => ({
    id: row.id,
    field: row.field,
    status: row.status,
    adoptedValue: row.adoptedValue ?? null,
    adoptedSourceId: row.adoptedSourceId ?? null,
    openedAt: row.openedAt ?? null,
    resolvedAt: row.resolvedAt ?? null,
    resolvedBy: row.resolvedBy ?? null,
    note: row.note ?? null,
  }))

  const notes = []
  if (auditTruncated) {
    notes.push(`审计流水超过 ${auditBound} 行，只印最新的那些 —— 「没印出来」与「没有这条记录」不是一件事。`)
  }
  if (fieldCounts.unobserved > 0) {
    notes.push(`${fieldCounts.unobserved} 行来源没有观测时间 —— 那是「未记录」，不是「观测于 0 点」。`)
  }
  if (auditFormCounts.null > 0) {
    notes.push(`有 ${auditFormCounts.null} 条审计行的 object_id 是空的（批量写入）—— 它们**不**在这份按 ASIN 反查的清单里。`)
  }

  return {
    ok: true,
    asin: key,
    marketplace: market,
    source: 'asin_field_source + audit_log + snapshot_registry + collection_section_result + field_conflict + asin_archive_event',
    fieldSources,
    fieldCounts,
    byField,
    audit,
    auditCount: audit.length,
    auditTotal: merged.length,
    auditTruncated,
    auditFormCounts,
    snapshots,
    snapshotCount: snapshots.length,
    snapshotTruncated,
    schemeVersions,
    schemeVersionCount: schemeVersions.length,
    conflicts,
    conflictCount: conflicts.length,
    archiveEvents,
    sourceTypes: [...SOURCE_TYPES],
    sourceTypeLabels: { ...ASIN_SOURCE_TYPE_LABELS },
    fieldSourceStates: [...ASIN_FIELD_SOURCE_STATES],
    fieldSourceStateLabels: { ...ASIN_FIELD_SOURCE_STATE_LABELS },
    auditObjectIdForms: [...ASIN_AUDIT_ID_FORMS],
    auditObjectIdFormLabels: { ...ASIN_AUDIT_ID_FORM_LABELS },
    auditObjectIdFormMatchable: { ...ASIN_AUDIT_ID_FORM_MATCHABLE },
    unsourced: [unsourced({
      id: 'import-attribution',
      label: '哪些批量导入动过这条 ASIN',
      feature: 'F05-02',
      reason: ASIN_IMPORT_ATTRIBUTION_REASON,
    })],
    noSourceText: ASIN_NO_SOURCE_TEXT,
    notes,
  }
}

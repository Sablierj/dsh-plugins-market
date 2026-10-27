/**
 * The external-entry prefill (module 04 F04-04; contract §2.3 `prefill_json`).
 *
 * ## What a prefill is, and what it is not
 *
 * A prefill is **a default that a person can see and change**, and the changed
 * ones are recorded (`changes`). It is not a hidden merge: if the form did not
 * show it, the run would be acting on a value nobody agreed to.
 *
 * ## The default range is "only the fields that are out of date"
 *
 * When a run is started *from an external entry* (an observation card, the ASIN
 * panel's 采集 button, the dashboard's expired-data card), re-collecting
 * everything spends requests on data that is still fresh. So the prefill's
 * default field range is derived from the targets' snapshot ages against
 * `freshnessDays`: sections whose newest snapshot is older than the window (or
 * that were never collected at all) contribute their adapter fields.
 *
 * ## The section → adapter-field mapping is declared, not inferred
 *
 * A collection section (`basic`) and a collector field (`title`) are two
 * vocabularies (`registry.js`'s `KNOWN_FIELDS` versus `sections.js`), and nothing
 * derives one from the other today. The mapping below is a **declared
 * correspondence for this one purpose**; it is deliberately conservative — a
 * section with no adapter field yet contributes nothing, and `seo_meta` is
 * omitted even though it holds `search_terms`, because backend search terms are
 * collected by the keyword scan (`amzn_keyword_scan`), not by this path.
 */

import { COLLECTION_SECTIONS } from './sections.js'

/** Contract §6.2.3 default for the reuse window. Imported by the preview too. */
export const PREFILL_FRESHNESS_DAYS = 7

/**
 * Section id → the collector fields that section is read through.
 *
 * `bullets`, `variations`, `attributes`, `description`, `aplus`, `video`,
 * `reviews`, `page_signals` and `related_competitors` have **no entry today**:
 * the collector cannot fill them yet (contract §9-O6), so a prefill that asked
 * for them would ask for something the source refuses with `FIELDS_UNSUPPORTED`.
 */
export const SECTION_ADAPTER_FIELDS = {
  basic: ['title', 'brand', 'price', 'currency', 'rating', 'reviews'],
  images: ['image_url'],
  bsr: ['bsr', 'category'],
}

const DAY_MS = 24 * 60 * 60 * 1_000

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/**
 * The sections that are out of date for **at least one** target.
 *
 * Freshness is read per `(asin, marketplace, section)` from the section table
 * itself — that is the only place a section's own `collected_at` exists, and
 * using a snapshot's timestamp instead would call all thirteen stale whenever
 * *any* of them aged out. "Out of date for at least one target" is the honest
 * rule for a prefill: skipping a section because one ASIN still had it would
 * leave the other ASINs uncovered by a run the person believes covers them.
 *
 * A target with no section rows at all makes every section stale, which is the
 * right answer — nothing about it has ever been collected.
 */
export function expiredSections(store, targets, { days = PREFILL_FRESHNESS_DAYS, now = new Date() } = {}) {
  if (targets.length === 0) return []
  const cutoff = new Date(now).getTime() - days * DAY_MS
  return COLLECTION_SECTIONS
    .filter(section => targets.some(target => {
      const row = store.get(
        `SELECT MAX(collected_at) AS at FROM collection_section_result
          WHERE asin = ? AND marketplace = ? AND section = ? AND status = 'collected'`,
        [target.asin, target.marketplace, section.id],
      )
      const at = row?.at ?? null
      if (at === null) return true
      const time = new Date(at).getTime()
      return !Number.isFinite(time) || time <= cutoff
    }))
    .map(section => section.id)
}

/** The adapter fields the expired sections map to, filtered to what is supported. */
export function defaultFieldsFor(sections, supported) {
  const wanted = []
  for (const section of sections) {
    for (const field of SECTION_ADAPTER_FIELDS[section] ?? []) {
      if (supported.includes(field) && !wanted.includes(field)) wanted.push(field)
    }
  }
  return wanted
}

/**
 * Build `prefill_json`, or `null` when there is no external entry.
 *
 * `null` is the honest value for a submission typed straight into the form: it
 * says "nothing was prefilled", which is a different fact from "everything was
 * prefilled and nothing changed".
 */
export function prefillFor({ store, sourceContextId, args = {}, targets, supported = [], now = new Date() }) {
  const contextId = blankToNull(sourceContextId)
  if (contextId === null) return null

  const days = Number.isFinite(Number(args.freshnessDays)) && Number(args.freshnessDays) >= 0
    ? Number(args.freshnessDays)
    : PREFILL_FRESHNESS_DAYS
  const sections = expiredSections(store, targets, { days, now })
  const defaultFields = defaultFieldsFor(sections, supported)

  /* One change per key that was actually sent and actually differs. "改一项 →
     恰好多一条 change" is the acceptance, and it is the reason this is a loop
     over the sent keys rather than a diff of the whole form: a default nobody
     touched is not a change. */
  const changes = []
  const record = (path, from, to) => {
    if (to === null) return
    if (JSON.stringify(from) === JSON.stringify(to)) return
    changes.push({ path, from, to, at: new Date(now).toISOString() })
  }
  if (Array.isArray(args.fields)) record('fields', defaultFields, args.fields.map(String))
  if (blankToNull(args.marketplace) !== null) record('marketplace', targets[0]?.marketplace ?? 'US', String(args.marketplace).trim().toUpperCase())
  if (blankToNull(args.schemeId) !== null) record('schemeId', null, String(args.schemeId).trim())

  const from = contextId.includes(':') ? contextId.slice(0, contextId.indexOf(':')) : contextId
  return {
    contextId,
    from,
    prefilledAt: new Date(now).toISOString(),
    freshnessDays: days,
    defaultSections: sections,
    defaultFields,
    changes,
  }
}

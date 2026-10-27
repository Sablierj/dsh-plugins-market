/**
 * `site_profile` and `site_verification`: the writable half of a site's dossier.
 *
 * The read-only half — domain, language, currency, units, title cap, and the
 * three-way rule state — is a projection of `marketplaces.js` and is **not
 * stored**. Storing it would create a second copy of a fact that already has an
 * owner, and the failure mode of two copies is not "one is stale": it is that
 * nobody can tell which one the page is showing.
 *
 * What *is* stored is the two things the code cannot know:
 *
 *   - `site_profile` — preferences. How this workspace likes sizes written, which
 *     colour names it standardises on, a note. Small, editable, per workspace.
 *
 *   - `site_verification` — **events**. "On this date, by this actor, against
 *     this evidence, the rules for this site were checked." Append-only, and
 *     never edited: a verification record that can be rewritten is not a record
 *     of anything, and the whole point of asking "when was this last verified"
 *     is to get an answer that does not change retroactively.
 *
 * The seed rows v21 writes carry `verified_by = 'system-seed'`. That value is
 * load-bearing: it means *the rule manual says so about itself*, which is
 * neither a person checking nor Amazon confirming. `isSeedVerification` is the
 * one place that decides, so the page cannot label one of them as an Amazon
 * verification by accident.
 */

import { randomUUID } from 'node:crypto'

import { PERMISSION_LEVELS } from '../domain/states.js'
import { nowIso } from './db.js'

/**
 * The actor recorded for a verification nobody performed.
 *
 * Spelled once, and imported by the migration, the store and the page: three
 * copies of this string is three chances for one of them to say something else
 * and quietly stop matching.
 */
export const SYSTEM_SEED_ACTOR = 'system-seed'

/** Whether a verification row came from the migration rather than from a person. */
export function isSeedVerification(row) {
  return String(row?.verified_by ?? '') === SYSTEM_SEED_ACTOR
}

/** Normalise a site code the way every other table keys it. */
function code(value) {
  return String(value ?? '').trim().toUpperCase()
}

/** The profile row for one workspace + site, or `undefined`. */
export function getSiteProfile(store, workspaceId, marketplace) {
  return store.get(
    'SELECT * FROM site_profile WHERE workspace_id = ? AND marketplace = ?',
    [String(workspaceId ?? '').trim(), code(marketplace)],
  )
}

/** Every stored profile in one workspace, by site code. */
export function listSiteProfiles(store, workspaceId) {
  return store.all(
    'SELECT * FROM site_profile WHERE workspace_id = ? ORDER BY marketplace',
    [String(workspaceId ?? '').trim()],
  )
}

/**
 * Create or update the preferences for one site.
 *
 * `localization` is stored as JSON because it is a small open set of display
 * preferences and each new one should not need a migration. `undefined` keeps
 * the stored value, `null` clears it — the same three-state contract the
 * product-line signals use, and for the same reason: "not mentioned" and
 * "deliberately empty" are different instructions.
 */
export function upsertSiteProfile(store, record = {}) {
  const workspaceId = String(record.workspaceId ?? '').trim()
  if (workspaceId === '') throw new Error('workspaceId is required')
  const marketplace = code(record.marketplace)
  if (marketplace === '') throw new Error('marketplace is required')

  const existing = getSiteProfile(store, workspaceId, marketplace)
  const now = nowIso()
  const localization = record.localization === undefined
    ? (existing?.localization_json ?? null)
    : (record.localization === null ? null : JSON.stringify(record.localization))
  const note = record.note === undefined
    ? (existing?.note ?? null)
    : (record.note === null ? null : String(record.note))

  store.run(
    `INSERT INTO site_profile (workspace_id, marketplace, localization_json, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, marketplace) DO UPDATE SET
       localization_json = excluded.localization_json,
       note              = excluded.note,
       updated_at        = excluded.updated_at`,
    [workspaceId, marketplace, localization, note, existing?.created_at ?? now, now],
  )
  return getSiteProfile(store, workspaceId, marketplace)
}

/**
 * Append one verification event.
 *
 * `verifiedAt` defaults to now; the seeded rows pass the manual's own date, which
 * is the one case where the date is not "when somebody looked" but "when the
 * source says it was written". The caller has to say which it means, so the
 * parameter is explicit rather than inferred from `verifiedBy`.
 */
export function recordSiteVerification(store, record = {}) {
  const workspaceId = String(record.workspaceId ?? '').trim()
  if (workspaceId === '') throw new Error('workspaceId is required')
  const marketplace = code(record.marketplace)
  if (marketplace === '') throw new Error('marketplace is required')
  const verifiedBy = String(record.verifiedBy ?? '').trim()
  if (verifiedBy === '') {
    /* A verification with no actor is an anonymous claim, and the one question
       this table exists to answer is "who says so". */
    throw new Error('verifiedBy is required — a verification with no actor answers nothing')
  }
  /* `system-seed` is reserved for the migration. It means "the rule manual says
     this about itself", and a person pressing a button cannot make that claim —
     if they could, the one value that tells a self-report from a verification
     would be worthless. The migration writes it with raw SQL, which is the only
     place it can come from. */
  if (verifiedBy === SYSTEM_SEED_ACTOR) {
    throw new Error(`verifiedBy "${SYSTEM_SEED_ACTOR}" is reserved for the migration that seeds the manual's own date`)
  }
  if (verifiedBy !== 'local' && !PERMISSION_LEVELS.includes(verifiedBy)) {
    throw new Error(`unknown actor "${verifiedBy}" — one of: local | ${PERMISSION_LEVELS.join(' | ')}`)
  }
  const verifiedAt = record.verifiedAt === undefined || record.verifiedAt === null
    ? nowIso()
    : String(record.verifiedAt)
  if (Number.isNaN(Date.parse(verifiedAt))) throw new Error(`verifiedAt is not a date: ${verifiedAt}`)

  const id = String(record.id ?? '').trim() || `sv-${randomUUID()}`
  store.run(
    `INSERT INTO site_verification
       (id, workspace_id, marketplace, verified_at, verified_by, evidence_url, evidence_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      marketplace,
      verifiedAt,
      verifiedBy,
      record.evidenceUrl === undefined || record.evidenceUrl === null ? null : String(record.evidenceUrl),
      record.evidenceNote === undefined || record.evidenceNote === null ? null : String(record.evidenceNote),
      nowIso(),
    ],
  )
  return store.get('SELECT * FROM site_verification WHERE id = ?', [id])
}

/** Every verification event for one site, newest first. */
export function listSiteVerifications(store, workspaceId, marketplace) {
  return store.all(
    `SELECT * FROM site_verification
      WHERE workspace_id = ? AND marketplace = ?
      ORDER BY verified_at DESC, created_at DESC`,
    [String(workspaceId ?? '').trim(), code(marketplace)],
  )
}

/** Every verification in one workspace, newest first — the page's audit list. */
export function listAllVerifications(store, workspaceId) {
  return store.all(
    'SELECT * FROM site_verification WHERE workspace_id = ? ORDER BY verified_at DESC, marketplace',
    [String(workspaceId ?? '').trim()],
  )
}

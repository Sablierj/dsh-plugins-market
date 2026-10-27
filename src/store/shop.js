/**
 * `shop` and `brand`: the two objects an ASIN's ownership points at.
 *
 * A **shop** is where the product is sold (a marketplace plus a storefront
 * identity). A **brand** is whose product it is, and `is_own` — ours or a
 * competitor's — is the only place that question is answered.
 *
 * `is_own` lives on the brand rather than on the ASIN on purpose. "This brand is
 * ours" is a fact about the brand; putting it on each ASIN would let two ASINs
 * of one brand disagree, and then every competitor comparison would have to
 * decide which of them to believe.
 *
 * ## Aliases are matched, not guessed
 *
 * A brand's `aliases_json` is what an incoming product title is tested against
 * (`findBrandByAlias`). Matching is case- and whitespace-insensitive but
 * otherwise exact-substring, and the match is returned **with the alias that
 * hit** — because "this title is ours" without "because it says ROFIEJX" is a
 * claim nobody can check.
 *
 * `forbidden_json` is a different list: spellings the brand does not want used
 * (a former name, a common misspelling). It is stored here so the compliance
 * side has one place to read it from; nothing in this file acts on it.
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'

/** Trim, or `null` for anything empty — an empty string is not an alias. */
function optional(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/**
 * A marketplace code, folded the way every other table folds it, or `null`.
 *
 * The fold is not cosmetic: `asin.marketplace` is `'US'`, so a shop stored as
 * `'us'` would never join to anything and the mismatch would surface as an
 * empty list rather than as an error.
 */
function upperOrNull(value) {
  const text = optional(value)
  return text === null ? null : text.toUpperCase()
}

/** A JSON-encoded string list, with blanks dropped and duplicates removed. */
function stringList(value) {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) throw new Error(`expected a list of strings, got ${JSON.stringify(value)}`)
  const seen = []
  for (const entry of value) {
    const text = String(entry ?? '').trim()
    if (text === '' || seen.includes(text)) continue
    seen.push(text)
  }
  return JSON.stringify(seen)
}

function parseList(text) {
  if (text === null || text === undefined) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/* ────────────────────────────── shops ────────────────────────────── */

export function listShops(store, workspaceId, { includeArchived = false } = {}) {
  const rows = store.all(
    `SELECT * FROM shop
      WHERE workspace_id = ?${includeArchived ? '' : ' AND archived_at IS NULL'}
      ORDER BY name`,
    [String(workspaceId ?? '').trim()],
  )
  return rows.map(viewShop)
}

/** The row with the archive pair named, so the page never has to read snake_case. */
export function viewShop(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    marketplace: row.marketplace ?? null,
    note: row.note,
    archivedAt: row.archived_at ?? null,
    archivedBy: row.archived_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getShop(store, id) {
  return store.get('SELECT * FROM shop WHERE id = ?', [String(id ?? '').trim()])
}

/**
 * Create or rename one shop.
 *
 * `marketplace` is optional and stays `NULL` when it is not given: a shop that
 * has not been tied to a site is a real state (somebody is still setting it up),
 * and defaulting it to US would put a claim in the row that nobody made.
 */
export function upsertShop(store, record = {}) {
  const name = String(record.name ?? '').trim()
  if (name === '') throw new Error('shop name is required')
  const id = String(record.id ?? '').trim() || `shop-${randomUUID()}`
  const existing = getShop(store, id)
  if (existing?.archived_at) throw new Error('shop is archived — restore it before editing')
  /* `workspaceId` is required to *create* a shop and ignored when updating one:
     an update addressed by id already says which workspace it belongs to, and
     demanding the id again would make a rename fail for a reason that has
     nothing to do with the rename. */
  const workspaceId = String(record.workspaceId ?? '').trim()
  if (existing === undefined && workspaceId === '') throw new Error('workspaceId is required')
  const now = nowIso()
  store.run(
    `INSERT INTO shop (id, workspace_id, name, marketplace, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name        = excluded.name,
       marketplace = excluded.marketplace,
       note        = excluded.note,
       updated_at  = excluded.updated_at`,
    [
      id,
      existing?.workspace_id ?? workspaceId,
      name,
      record.marketplace === undefined ? (existing?.marketplace ?? null) : upperOrNull(record.marketplace),
      record.note === undefined ? (existing?.note ?? null) : optional(record.note),
      existing?.created_at ?? now,
      now,
    ],
  )
  return getShop(store, id)
}

/* ────────────────────────────── brands ───────────────────────────── */

export function listBrands(store, workspaceId, { isOwn, includeArchived = false } = {}) {
  const rows = store.all(
    `SELECT * FROM brand
      WHERE workspace_id = ?${includeArchived ? '' : ' AND archived_at IS NULL'}
      ORDER BY is_own DESC, name`,
    [String(workspaceId ?? '').trim()],
  )
  return rows
    .filter(row => isOwn === undefined || (row.is_own === 1) === Boolean(isOwn))
    .map(viewBrand)
}

export function getBrand(store, id) {
  const row = store.get('SELECT * FROM brand WHERE id = ?', [String(id ?? '').trim()])
  return row === undefined ? undefined : viewBrand(row)
}

/** The row with its two JSON lists parsed — the shape every reader wants. */
export function viewBrand(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    aliases: parseList(row.aliases_json),
    forbidden: parseList(row.forbidden_json),
    isOwn: row.is_own === 1,
    note: row.note,
    archivedAt: row.archived_at ?? null,
    archivedBy: row.archived_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Create or update one brand.
 *
 * `undefined` keeps a stored list, `null` clears it, `[]` stores an empty list —
 * the same three-state contract the product-line signals use, and for the same
 * reason: "not mentioned" and "deliberately emptied" are different instructions.
 */
export function upsertBrand(store, record = {}) {
  const name = String(record.name ?? '').trim()
  if (name === '') throw new Error('brand name is required')
  const id = String(record.id ?? '').trim() || `brand-${randomUUID()}`
  const existing = store.get('SELECT * FROM brand WHERE id = ?', [id])
  if (existing?.archived_at) throw new Error('brand is archived — restore it before editing')
  /* Required to create, ignored to update — same reason as `upsertShop`. */
  const workspaceId = String(record.workspaceId ?? '').trim()
  if (existing === undefined && workspaceId === '') throw new Error('workspaceId is required')
  const now = nowIso()

  const aliases = record.aliases === undefined
    ? (existing?.aliases_json ?? null)
    : (record.aliases === null ? null : stringList(record.aliases))
  const forbidden = record.forbidden === undefined
    ? (existing?.forbidden_json ?? null)
    : (record.forbidden === null ? null : stringList(record.forbidden))
  const isOwn = record.isOwn === undefined ? (existing?.is_own ?? 1) : (record.isOwn ? 1 : 0)

  store.run(
    `INSERT INTO brand (id, workspace_id, name, aliases_json, forbidden_json, is_own, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name           = excluded.name,
       aliases_json   = excluded.aliases_json,
       forbidden_json = excluded.forbidden_json,
       is_own         = excluded.is_own,
       note           = excluded.note,
       updated_at     = excluded.updated_at`,
    [
      id,
      existing?.workspace_id ?? workspaceId,
      name,
      aliases,
      forbidden,
      isOwn,
      record.note === undefined ? (existing?.note ?? null) : optional(record.note),
      existing?.created_at ?? now,
      now,
    ],
  )
  return getBrand(store, id)
}

/**
 * The brand an incoming name or title belongs to, or `null`.
 *
 * Matching order is deliberate: the canonical name first, then the aliases, and
 * the first brand that matches wins. It returns **which string matched**, because
 * "this is ours" is a claim the caller has to be able to show the evidence for —
 * a bare boolean would make a wrong alias indistinguishable from a right one.
 *
 * `isOwn` is not a filter: a competitor's brand is exactly as matchable as ours,
 * since the question being asked is "whose is this", not "is this ours".
 */
export function findBrandByAlias(store, alias, workspaceId) {
  const needle = String(alias ?? '').trim().toLowerCase()
  if (needle === '') return null
  for (const brand of listBrands(store, workspaceId)) {
    if (brand.name.toLowerCase() === needle) return { ...brand, matched: brand.name }
    const hit = brand.aliases.find(candidate => candidate.toLowerCase() === needle)
    if (hit !== undefined) return { ...brand, matched: hit }
  }
  /* No exact hit: fall back to a contains test over aliases, longest alias
     first, so a title like "ROFIEJX Bench Cushion 44x19x4" resolves to the
     brand whose alias actually appears in it rather than to a shorter one that
     happens to be a substring of another brand's name. */
  const candidates = listBrands(store, workspaceId)
    .flatMap(brand => brand.aliases.map(candidate => ({ brand, candidate })))
    .filter(entry => entry.candidate.length >= 3 && needle.includes(entry.candidate.toLowerCase()))
    .sort((a, b) => b.candidate.length - a.candidate.length)
  return candidates.length === 0 ? null : { ...candidates[0].brand, matched: candidates[0].candidate }
}

/* ── archive / restore (v60) ─────────────────────────────────────────────
   Archive is the only "removal" this module offers: `product_profile.shop_id`
   is a foreign key, so deleting a shop would break the ownership rows that
   point at it. An archived row stays readable and refuses writes until it is
   restored; nothing is deleted and the audit row carries who and when. */

export function archiveShop(store, id, by = null) {
  const existing = getShop(store, id)
  if (existing === undefined) throw new Error('no such shop')
  if (existing.archived_at) return viewShop(existing)
  const now = nowIso()
  store.run(
    'UPDATE shop SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ?',
    [now, optional(by), now, String(id).trim()],
  )
  return viewShop(getShop(store, id))
}

export function restoreShop(store, id) {
  const existing = getShop(store, id)
  if (existing === undefined) throw new Error('no such shop')
  if (!existing.archived_at) return viewShop(existing)
  const now = nowIso()
  store.run(
    'UPDATE shop SET archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id = ?',
    [now, String(id).trim()],
  )
  return viewShop(getShop(store, id))
}


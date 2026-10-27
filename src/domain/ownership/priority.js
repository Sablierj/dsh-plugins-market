/**
 * The five-level ownership chain (module 04 F04-08; contract §6.4).
 *
 * ## This is not `resolveOwnership`, and it wraps it rather than replacing it
 *
 * `domain/ownership/resolve.js` answers "given these rows, which side is this
 * ASIN on" with **two** tiers: `manual` wins over `auto`, and within a tier two
 * opposite sides are a conflict worth refusing. That machine is unchanged and
 * still pinned by its own assertions.
 *
 * This file answers a different question — "where did the *side* come from" —
 * with five levels, tried in order. First hit wins, and a lower level may never
 * overturn a higher one. That ordering is the whole point: a brand mapping must
 * not overrule a person who said otherwise.
 *
 * | # | tier | what it reads |
 * |---|---|---|
 * | 1 | `user-input` | the side the caller declared (`selfAsins` / `competitorAsins`) |
 * | 2 | `confirmed-relation` | an active `manual` `side` row in `asin_ownership` |
 * | 3 | `brand-mapping` | the ASIN's brand, matched against the `brand` table |
 * | 4 | `signal-suggestion` | an active `auto` row — a machine's opinion |
 * | 5 | `unknown` | nothing matched |
 *
 * ## Only levels 1 and 2 decide; 3 and 4 only suggest
 *
 * Contract §6.4-2: a `side` is only ever *decided* by a person (level 1 is the
 * person's own typing, level 2 is a person's recorded judgement). Levels 3 and 4
 * come back as `suggestion` and are rendered in the preview for a human to
 * confirm — nothing here writes `asin_ownership`. A brand match that wrote a
 * `manual` row would destroy the only thing the manual tier means.
 *
 * ## Level 3 is a mapping, not a guess
 *
 * `brand` is a table with `is_own` and aliases (`schema.js:1474`): the ASIN's
 * `brand` field is matched against the canonical name and every alias,
 * case-insensitively. A brand that is not in the table matches nothing — the
 * absence of a row is not evidence of anything, which is why an unmatched brand
 * falls through to level 4 rather than to "competitor".
 */

import { resolveOwnership } from './resolve.js'
import { DEFAULT_WORKSPACE_ID } from '../context/scope.js'

/** The five tiers, in the order they are tried. */
export const OWNERSHIP_TIERS = ['user-input', 'confirmed-relation', 'brand-mapping', 'signal-suggestion', 'unknown']

/** Chinese labels, for the tool output and the panel. */
export const OWNERSHIP_TIER_LABELS = {
  'user-input': '人工输入',
  'confirmed-relation': '已确认关系',
  'brand-mapping': '品牌映射',
  'signal-suggestion': '信号建议',
  unknown: '未判定',
}

function normalizeAsin(value) {
  return String(value ?? '').trim().toUpperCase()
}

function normalizeMarketplace(value) {
  return String(value ?? 'US').trim().toUpperCase()
}

function safeJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback
  try {
    const value = JSON.parse(text)
    return value === null || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/** Every ownership row for one coordinate, newest first. */
export function ownershipRows(store, asin, marketplace) {
  return store.all(
    'SELECT * FROM asin_ownership WHERE asin = ? AND marketplace = ? ORDER BY created_at DESC',
    [normalizeAsin(asin), normalizeMarketplace(marketplace)],
  )
}

/**
 * Level 3: the ASIN's brand against the `brand` table.
 *
 * The default workspace is searched first and the rest of the table only after
 * it — a brand roster is workspace-scoped, and "the same brand name in another
 * workspace" is a weaker statement than the one the current scope made. Both
 * are searched because a user who has one workspace's roster and collects from
 * another would otherwise get no mapping at all; the weaker match is reported as
 * such through `evidence.workspace`.
 */
export function brandMappingFor(store, { asin, marketplace }) {
  const row = store.get('SELECT brand FROM asin WHERE asin = ? AND marketplace = ?', [normalizeAsin(asin), normalizeMarketplace(marketplace)])
  const brand = String(row?.brand ?? '').trim()
  if (brand === '') return null

  const brands = store.all('SELECT * FROM brand ORDER BY (workspace_id = ?) DESC, name', [DEFAULT_WORKSPACE_ID])
  const wanted = brand.toLowerCase()
  for (const candidate of brands) {
    const aliases = safeJson(candidate.aliases_json, [])
    const names = [String(candidate.name ?? '').toLowerCase(), ...(Array.isArray(aliases) ? aliases.map(alias => String(alias).toLowerCase()) : [])]
    if (!names.includes(wanted)) continue
    return {
      brandId: candidate.id,
      brandName: candidate.name,
      matched: brand,
      workspace: candidate.workspace_id,
      side: candidate.is_own === 1 ? 'self' : 'competitor',
    }
  }
  return null
}

/**
 * Resolve one target's tier, first hit wins.
 *
 * Returns `{asin, marketplace, tier, side, suggestion, decidedBy, evidence}`:
 *
 *   · `side` is non-null only for levels 1 and 2 — the levels a person owns;
 *   · `suggestion` is `{side, reason, …}` for levels 3 and 4 (and null when
 *     there is nothing to suggest), for a human to confirm in the preview;
 *   · `decidedBy` names the level in words, so a reader never has to infer it
 *     from `tier`.
 */
export function resolveOwnershipTier(store, { asin, marketplace, declaredSide = null } = {}) {
  const coordinate = { asin: normalizeAsin(asin), marketplace: normalizeMarketplace(marketplace) }
  const base = { ...coordinate, tier: 'unknown', side: null, suggestion: null, decidedBy: 'unknown', evidence: null }

  /* Level 1 — the person typed the ASIN into one of the two boxes. */
  if (declaredSide === 'self' || declaredSide === 'competitor') {
    return {
      ...base,
      tier: 'user-input',
      side: declaredSide,
      decidedBy: 'user-input',
      evidence: { source: 'input', declaredSide },
    }
  }

  const rows = ownershipRows(store, coordinate.asin, coordinate.marketplace)
  const active = rows.filter(row => row.retracted_at === null)

  /* Level 2 — a person's recorded judgement. `resolveOwnership` is reused rather
     than re-implemented: it already knows that two opposite manual sides are a
     conflict and that a conflict decides nothing. */
  const manual = active.filter(row => row.source === 'manual')
  if (manual.length > 0) {
    const resolved = resolveOwnership(manual)
    if (resolved.side !== null) {
      return {
        ...base,
        tier: 'confirmed-relation',
        side: resolved.side,
        decidedBy: 'manual',
        evidence: { rowId: resolved.side === 'self' ? resolved.selfRows[0]?.id ?? null : resolved.competitorRows[0]?.id ?? null, source: 'asin_ownership.manual' },
      }
    }
    /* Manual rows exist and contradict each other. That is a real answer, and it
       is not "unknown" — the human has to settle it, and hiding the conflict
       behind the next level would be exactly the override-vs-contradiction
       confusion `resolve.js` warns about. */
    return {
      ...base,
      tier: 'confirmed-relation',
      side: null,
      decidedBy: 'manual',
      suggestion: null,
      conflict: true,
      evidence: { reason: resolved.reason, selfRows: resolved.selfRows.map(row => row.id), competitorRows: resolved.competitorRows.map(row => row.id) },
    }
  }

  /* Level 3 — a brand mapping. A suggestion, never a decision. */
  const mapping = brandMappingFor(store, coordinate)
  if (mapping !== null) {
    return {
      ...base,
      tier: 'brand-mapping',
      suggestion: {
        side: mapping.side,
        reason: `品牌「${mapping.brandName}」在 brand 表里标记为${mapping.side === 'self' ? '自有' : '竞品'}品牌`,
        brandId: mapping.brandId,
        matched: mapping.matched,
        workspace: mapping.workspace,
      },
      decidedBy: 'brand-mapping',
      evidence: { source: 'brand', brandId: mapping.brandId, matched: mapping.matched },
    }
  }

  /* Level 4 — the machine's own earlier opinion, offered again as a suggestion. */
  const auto = active.filter(row => row.source === 'auto')
  if (auto.length > 0) {
    const resolved = resolveOwnership(auto)
    if (resolved.side !== null) {
      return {
        ...base,
        tier: 'signal-suggestion',
        suggestion: { side: resolved.side, reason: 'asin_ownership 里已有一条 auto 判定' },
        decidedBy: 'auto',
        evidence: { rowIds: auto.map(row => row.id) },
      }
    }
  }

  return base
}

/**
 * `{self: [asin…], competitor: [asin…], unknown: [asin…]}` — the split the task
 * row freezes (`side_split_json`, contract §2.3).
 *
 * Only levels 1 and 2 land in `self` / `competitor`; everything else is
 * `unknown`, including a would-be suggestion. A suggestion that was silently
 * counted as a side is how "we think" becomes "we decided" without anybody
 * deciding.
 */
export function sideSplitOf(resolutions) {
  const split = { self: [], competitor: [], unknown: [] }
  for (const entry of resolutions) {
    if (entry.side === 'self') split.self.push(entry.asin)
    else if (entry.side === 'competitor') split.competitor.push(entry.asin)
    else split.unknown.push(entry.asin)
  }
  return split
}

/** The per-ASIN evidence list, trimmed to what the audit reader needs. */
export function ownershipEvidenceOf(resolutions) {
  return resolutions.map(entry => ({
    asin: entry.asin,
    marketplace: entry.marketplace,
    side: entry.side,
    decidedBy: entry.decidedBy,
    tier: entry.tier,
    conflict: entry.conflict === true,
    suggestion: entry.suggestion === null ? null : { side: entry.suggestion.side, reason: entry.suggestion.reason },
    evidence: entry.evidence ?? null,
  }))
}

/** The entries a human still has to decide — no side, but maybe a suggestion. */
export function unresolvedOf(resolutions) {
  return resolutions
    .filter(entry => entry.side === null)
    .map(entry => ({
      asin: entry.asin,
      marketplace: entry.marketplace,
      tier: entry.tier,
      conflict: entry.conflict === true,
      suggestion: entry.suggestion === null ? null : { side: entry.suggestion.side, reason: entry.suggestion.reason },
    }))
}

/**
 * Who an ASIN belongs to, and whether the answer contradicts itself.
 *
 * `asin.product_line_id` used to be the whole answer, and it was three answers
 * at once: the current value, the reason, and the history — so every re-run
 * overwrote the last one and both "why is it here" and "where was it before"
 * disappeared together. v22 splits that into **relationship records**.
 *
 * ## Two tiers, and why the conflict is judged within one
 *
 * An ownership row is either `auto` (a machine decided, from signal words or a
 * brand alias) or `manual` (a person said so). They can both exist for the same
 * ASIN, and the manual one wins.
 *
 * That precedence is why the self/competitor conflict is judged **inside a
 * tier** rather than across all active rows. A manual `competitor` over an auto
 * `self` is not a contradiction — it is the override doing its job. Judging
 * across tiers would make the one action the manual tier exists for impossible.
 * Within a tier, two opposite sides for one ASIN *is* a contradiction, and the
 * honest answer is to write neither and say so, because picking one would be
 * inventing a decision nobody made.
 *
 * ## Retraction, not deletion
 *
 * `retractOwnership` sets `retracted_at`. The row stays. Deleting it would
 * delete the evidence for a judgement that was made, and the next person asking
 * "why was this ever in 竞品?" would find nothing. Retracting also makes the
 * override reversible: retract the manual row and the auto row underneath is
 * the effective answer again, which is what "traceable" has to mean to be worth
 * anything.
 */

/** The four things an ownership row can point at. */
export const OWNERSHIP_OBJECT_TYPES = ['product_line', 'brand', 'shop', 'side']

/** `side` rows take one of these two ids instead of a table row. */
export const OWNERSHIP_SIDES = ['self', 'competitor']

/** Where a judgement came from. `auto` is a machine, `manual` is a person. */
export const OWNERSHIP_SOURCES = ['auto', 'manual']

/** Only rows that have not been retracted. */
function activeRows(rows) {
  return (rows ?? []).filter(row => row !== null && row !== undefined && row.retracted_at === null)
}

/**
 * The effective rows: the manual tier when it says anything, otherwise auto.
 *
 * Exported because the store's write gate and the page's "why is this here"
 * both need the same answer, and a second implementation of "manual wins" is
 * exactly the kind of rule that drifts.
 */
export function effectiveRows(rows) {
  const active = activeRows(rows)
  const manual = active.filter(row => row.source === 'manual')
  return manual.length > 0 ? manual : active
}

/**
 * The write gate: may these rows exist together?
 *
 * `rows` is the set the store is *about to* hold for one (asin, marketplace) —
 * the existing active rows plus whatever is being written. Returns the side, or
 * `conflict: true` with the two rows that disagree.
 */
export function resolveOwnership(rows) {
  const effective = effectiveRows(rows)
  const sides = effective.filter(row => row.object_type === 'side')
  const self = sides.filter(row => row.object_id === 'self')
  const competitor = sides.filter(row => row.object_id === 'competitor')
  const conflict = self.length > 0 && competitor.length > 0

  if (conflict) {
    return {
      side: null,
      conflict: true,
      reason: '同一个 ASIN 同时被标为「自有」与「竞品」——两条都不写，先决定它是哪一个',
      selfRows: self,
      competitorRows: competitor,
    }
  }
  return {
    side: self.length > 0 ? 'self' : (competitor.length > 0 ? 'competitor' : null),
    conflict: false,
    reason: null,
    selfRows: self,
    competitorRows: competitor,
  }
}

/**
 * The read view of one ASIN's ownership: what is in force, what was retracted,
 * and where each judgement came from.
 *
 * A different question from `resolveOwnership` — that one decides whether a
 * write may land, this one explains what is already there. The retracted rows
 * are returned rather than hidden, because "it used to be in 竞品 and somebody
 * took it out" is a fact the reader is usually looking for.
 */
export function classifyOwnership(rows) {
  const active = activeRows(rows)
  const retracted = (rows ?? []).filter(row => row !== null && row !== undefined && row.retracted_at !== null)
  const effective = effectiveRows(rows)
  const resolved = resolveOwnership(rows)

  /** One row per target, manual first — the shape the page draws. */
  const byTarget = new Map()
  for (const row of effective) {
    const key = `${row.object_type}:${row.object_id}`
    if (!byTarget.has(key)) byTarget.set(key, row)
  }

  return {
    side: resolved.side,
    conflict: resolved.conflict,
    reason: resolved.reason,
    /* Whether the answer came from a person or from the machine. The page says
       which, because "we think it is ours" and "somebody said it is ours" are
       not the same claim. */
    decidedBy: effective.some(row => row.source === 'manual') ? 'manual' : (effective.length > 0 ? 'auto' : null),
    targets: [...byTarget.values()].map(row => ({
      objectType: row.object_type,
      objectId: row.object_id,
      source: row.source,
      confidence: row.confidence,
      evidence: row.evidence_json === null || row.evidence_json === undefined ? null : safeJson(row.evidence_json),
    })),
    activeCount: active.length,
    retracted: retracted.map(row => ({
      id: row.id,
      objectType: row.object_type,
      objectId: row.object_id,
      source: row.source,
      retractedAt: row.retracted_at,
    })),
  }
}

function safeJson(text) {
  if (text === null || text === undefined) return null
  if (typeof text === 'object') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

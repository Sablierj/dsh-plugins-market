/**
 * Multi-source disagreement, folded from provenance rows — the one expression of
 * "these sources disagree about this field".
 *
 * The judgement belongs to the quality cockpit: `DQ-CONSIST-001` in
 * `domain/data/quality-rules.js` fires when one `(asin, marketplace, field)` has
 * more than one distinct `value` in `asin_field_source`. Two features in this batch
 * need that same judgement over rows they have already read — the import preview
 * (does this cell sit on top of a disagreement?) and the health summary (how many
 * of this ASIN's fields are contested?) — and neither should re-express it as a
 * third SQL string. So it lives here, as a pure function over rows, and both call
 * it.
 *
 * `JSON.stringify` is the equality, deliberately. `1` and `"1"` were written by two
 * different sources and are two different values, and normalising through JSON
 * keeps that explicit instead of depending on how `Set` happens to compare mixed
 * types. `null` values are skipped: a source that recorded "no value" is not a
 * source claiming a value.
 */

/**
 * `(field → [sourceId, …])` for every field with more than one distinct value.
 *
 * A `Map`, not an object: a field name is untrusted input from a payload, and a
 * field literally called `__proto__` would do something surprising to an object
 * literal. The returned map only contains contested fields — a field with one value
 * is absent, not present-with-one-entry, so "is it contested" is one lookup.
 */
export function fieldConflictsOf(sourceRows) {
  const byField = new Map()
  for (const row of sourceRows ?? []) {
    if (row === null || row === undefined) continue
    const value = row.value
    if (value === null || value === undefined) continue
    const field = String(row.field ?? '')
    if (!byField.has(field)) byField.set(field, new Map())
    byField.get(field).set(JSON.stringify(value), row.source_id ?? null)
  }
  const out = new Map()
  for (const [field, values] of byField) {
    if (values.size > 1) out.set(field, [...values.values()])
  }
  return out
}

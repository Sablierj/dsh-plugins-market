/**
 * The catalogue's read side: one place that counts rows, and one place that
 * assembles the three levels.
 *
 * `datasetRowCounts` exists because `counts()` covers eight tables and the
 * catalogue covers fifteen. The alternative — a second counting rule written
 * inside the page — is how "the export says 412 and the page says 411" starts.
 * Where the two overlap (`asin`, `keyword`) they must give **the same number**,
 * and the assertion says so; where they do not, the catalogue is the only source
 * and it is still one query per table with no arithmetic in between.
 *
 * A table that cannot be counted is reported as `null`, not as 0 and not as an
 * omission. "This table is gone" and "this table is empty" are different, and a
 * catalogue that showed both as 0 would hide a broken schema behind a plausible
 * number.
 */

import { ASSET_TYPES, DATASETS } from '../domain/catalog/datasets.js'

/**
 * How many rows each dataset holds, keyed by dataset id.
 *
 * `null` for a dataset whose table cannot be read. The identifier is taken from
 * the declaration, not from the caller — there is no path from a request body to
 * the table name in this query.
 */
export function datasetRowCounts(store) {
  const out = {}
  for (const dataset of DATASETS) {
    try {
      out[dataset.id] = Number(store.get(`SELECT COUNT(*) AS n FROM ${dataset.table}`)?.n ?? 0)
    } catch {
      out[dataset.id] = null
    }
  }
  return out
}

/**
 * The catalogue as three levels.
 *
 * Every attribute the design names is present on every dataset, including the
 * ones that are `null` for a given table: a missing key would let a reader
 * assume the attribute does not exist, and `null` says "declared, no value".
 */
export function catalogView(store) {
  const counts = datasetRowCounts(store)
  return ASSET_TYPES.map(asset => ({
    id: asset.id,
    label: asset.label,
    datasets: DATASETS
      .filter(dataset => dataset.assetType === asset.id)
      .map(dataset => ({
        id: dataset.id,
        label: dataset.label,
        table: dataset.table,
        grain: dataset.grain,
        primaryKey: [...dataset.primaryKey],
        unit: dataset.unit,
        nullSemantics: dataset.nullSemantics,
        sources: [...dataset.sources],
        rowCount: counts[dataset.id],
        ownerRole: dataset.ownerRole,
        freshnessClass: dataset.freshnessClass,
        downstream: [...dataset.downstream],
        fields: [...dataset.fields],
      })),
  }))
}

/** One dataset's catalogue entry, or `null`. */
export function datasetView(store, id) {
  for (const asset of catalogView(store)) {
    const found = asset.datasets.find(dataset => dataset.id === id)
    if (found !== undefined) return found
  }
  return null
}

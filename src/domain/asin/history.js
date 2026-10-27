/**
 * ASIN snapshot history and the diff between **any two** collection snapshots
 * (module 05, F05-04).
 *
 * ## What was missing, said precisely
 *
 * The workbench could already show "this field changed since the previous
 * snapshot": `buildFieldFacts` reads the newest two rows of `asin_snapshot` and
 * diffs them (`domain/asin/fields.js`). What had no door at all was choosing the
 * two time points yourself — `diffSnapshots` in `store/snapshot.js` is refused for
 * these rows because an ASIN snapshot is registered as a **pointer** (`ref_table =
 * 'asin_snapshot'`, `payload_json` NULL), and a pointer has no frozen body to
 * compare. The body is in `asin_snapshot.payload_json`; this module reads it and
 * calls the same `diffPayloads` the "previous version" path calls, so "what counts
 * as a change" is stated once in the repository.
 *
 * ## Change kinds and attributions are derived from content, never stored
 *
 * There is no `kind` column and no `attribution` column anywhere, here or in the
 * schema. Both are computed from what the two snapshots and the provenance tables
 * actually contain, which is the only way "recompute it and get the same answer"
 * can be an acceptance criterion rather than a promise. It also means the page has
 * nothing to infer: it renders the label this module produced.
 *
 * ## An unclassified source is "未知", not a blank
 *
 * A blank cell reads as "there is no attribution column". `ASIN_ATTRIBUTIONS`
 * therefore ends in `unknown`, and an unmatched change gets it. Same rule as
 * everywhere else in this plugin: refusing to name a thing is a value.
 *
 * ## What this module deliberately does NOT report
 *
 * 「来源类型变化」 (a field's `source_type` moving between `collect` / `import` /
 * `manual` / `derived`). The vocabulary exists (`store/field-source.js`), but
 * `asin_field_source` is keyed `(asin, marketplace, field, source_id)` and a second
 * write to the same source **overwrites in place** — no column and no table keeps
 * that history. So this module reports the change of the snapshot's own
 * **collection source** (`asin_snapshot.source_id`), and says out loud that the
 * other half has no source in this repository (`sourceChange.note`). Drawing it as
 * "unchanged" would be the exact mistake the module exists to avoid.
 */

import { diffPayloads } from '../snapshot/diff.js'
import { listFieldSources } from '../../store/field-source.js'
import { listPublications } from '../../store/observe.js'

/** The closed vocabulary of change kinds. Six, and `other` is a real answer. */
export const ASIN_CHANGE_KINDS = ['text', 'numeric', 'image', 'attribute', 'variant', 'other']

export const ASIN_CHANGE_KIND_LABELS = {
  text: '文本',
  numeric: '数值',
  image: '图片/A+',
  attribute: '属性',
  variant: '变体',
  other: '其他',
}

/** The closed vocabulary of attributions. `unknown` names the absence of evidence. */
export const ASIN_ATTRIBUTIONS = ['manual', 'publication', 'conflict', 'amazon_page', 'unknown']

export const ASIN_ATTRIBUTION_LABELS = {
  manual: '人工修正',
  publication: '优化发布',
  conflict: '来源冲突',
  amazon_page: 'Amazon 页面',
  unknown: '未知',
}

/**
 * The exact sentence for the half of 「来源变化」 this repository has no source
 * for. A constant, because the tool and the page both print it and two copies of
 * one sentence drift into two sentences that read like two different facts.
 */
export const ASIN_SOURCE_TYPE_HISTORY_NOTE =
  '来源类型（collect/import/manual/derived）的变化本仓没有来源：asin_field_source 按 '
  + '(asin,marketplace,field,source_id) 原地覆盖，不存历史。这里报的是快照行的采集来源（source_id）变化。'

/** Image / A+ surfaces — a name match, because these arrive as ad-hoc payload keys. */
const IMAGE_FIELDS = new Set([
  'image_url', 'image_alt', 'images', 'aplus', 'a_plus', 'brand_story', 'video_script', 'video_url',
])

/** Variant surfaces — the same shape of problem as the image keys above. */
const VARIANT_FIELDS = new Set([
  'variations', 'variants', 'variation_dimensions', 'variant_dimensions',
  'parent_asin', 'parentAsin', 'child_asin', 'childAsin',
])

/**
 * A string that is a number, and nothing else.
 *
 * `Number()` is the wrong tool twice over: `Number('') === 0` would call an empty
 * string numeric, and `Number('12abc')` is `NaN`, which is not equal to itself, so
 * a `NaN === NaN` comparison silently reports "changed" for two identical values.
 * One regex, evaluated in one place.
 */
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/

function isNumericLeaf(value) {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  return NUMERIC_TEXT.test(value.trim())
}

function isImageField(field) {
  if (IMAGE_FIELDS.has(field)) return true
  return /^(aplus|a_plus|image|video)_/.test(field)
}

function isVariantField(field) {
  if (VARIANT_FIELDS.has(field)) return true
  return /^variant[._]/.test(field)
}

/**
 * Which kind of change this is. The order **is** the criterion, and it is stated
 * once, here:
 *
 *   1. `attribute.*`  — the optimizer's field namespace, the most specific prefix
 *   2. variant names  — likewise a namespace, just spelled differently by callers
 *   3. image / A+     — a surface whose change is never "just text"
 *   4. numeric both sides
 *   5. string both sides
 *   6. everything else (arrays, objects, added/removed sides) is `other`
 *
 * A prefix is checked before a value type on purpose: `attribute.price` holding
 * `"12.5"` is an attribute change, and calling it a numeric one would file it
 * under the wrong heading on the page.
 */
export function classifyChange(field, before, after) {
  const name = String(field ?? '')
  if (name.startsWith('attribute.')) return 'attribute'
  if (isVariantField(name)) return 'variant'
  if (isImageField(name)) return 'image'
  if (isNumericLeaf(before) && isNumericLeaf(after)) return 'numeric'
  if (typeof before === 'string' && typeof after === 'string') return 'text'
  return 'other'
}

function parseJson(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Two cell values are the same fact, for the purpose of "did the human set this". */
function sameLeaf(left, right) {
  if (left === right) return true
  if (left === null || right === null || left === undefined || right === undefined) return false
  return String(left) === String(right)
}

/** `ASIN@MARKETPLACE` — the object key the whole workbench already agrees on. */
function objectKey(asin, marketplace) {
  return `${asin}@${marketplace}`
}

/**
 * Why this field moved, from the store's own evidence.
 *
 * The four rules below are checked **in this order**, and the first match wins:
 *
 *   1. `manual`      — a person edited this field in the window. Read from
 *                      `asin_field_source` (`source_type = 'manual'`, written by
 *                      `correctAsinField` for both the tool and the page plane),
 *                      because that row names the field. Deliberately not read from
 *                      `audit_log`: the page's `asin-field-correct` descriptor
 *                      records `{adoptedValue, sources}` as its after value, which
 *                      does **not** name the field, so an audit-based rule would
 *                      attribute by guesswork.
 *   2. `publication` — something was published for this ASIN in the window
 *   3. `conflict`    — a conflict was opened on this field in the window
 *   4. `amazon_page` — the *collector* that produced the later snapshot has a
 *                      provenance row for this field (so it was read off the page)
 *
 * A field nobody can account for is `unknown` — with `evidence: null` and no
 * pretend reason.
 */
export function attributeChange(store, {
  asin, marketplace, field, after, from, to,
} = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const name = String(field ?? '').trim()
  const fromAt = from?.collectedAt ?? null
  const toAt = to?.collectedAt ?? null
  const inWindow = at => at !== null && at !== undefined
    && (fromAt === null || String(at) > String(fromAt))
    && (toAt === null || String(at) <= String(toAt))

  const rows = listFieldSources(store, { asin: key, marketplace: market, field: name })

  const human = rows.find(row => row.source_type === 'manual'
    && inWindow(row.updated_at)
    && sameLeaf(parseJson(row.value) ?? row.value, after))
  if (human !== undefined) {
    return {
      attribution: 'manual',
      label: ASIN_ATTRIBUTION_LABELS.manual,
      evidence: `source:${human.source_id}@${human.updated_at}`,
    }
  }

  const published = listPublications(store, { asin: key, marketplace: market, limit: 200 })
    .rows.find(record => inWindow(record.publishedAt ?? record.published_at))
  if (published !== undefined) {
    return {
      attribution: 'publication',
      label: ASIN_ATTRIBUTION_LABELS.publication,
      evidence: `publication:${published.id}`,
    }
  }

  const conflict = store.get(
    'SELECT id, opened_at FROM field_conflict WHERE asin = ? AND marketplace = ? AND field = ?',
    [key, market, name],
  )
  if (conflict !== undefined && inWindow(conflict.opened_at)) {
    return {
      attribution: 'conflict',
      label: ASIN_ATTRIBUTION_LABELS.conflict,
      evidence: `conflict:${conflict.id}`,
    }
  }

  const toSourceId = to?.sourceId ?? null
  if (toSourceId !== null && rows.some(row => row.source_id === toSourceId)) {
    return {
      attribution: 'amazon_page',
      label: ASIN_ATTRIBUTION_LABELS.amazon_page,
      evidence: `source:${toSourceId}`,
    }
  }

  return { attribution: 'unknown', label: ASIN_ATTRIBUTION_LABELS.unknown, evidence: null }
}

/**
 * The field paths a payload holds, using **the same flattening the diff uses**.
 *
 * `diffPayloads({}, payload)` is the obvious call and it is the right one: `flatten`
 * reports one entry per named path, so an empty before-payload contributes nothing.
 * A second walker here is exactly how "7 fields" beside a nine-row diff happens, and
 * both numbers would look authoritative.
 *
 * T-1: the one-field-too-long answer this used to work around (`flatten` treating the
 * empty root object as a leaf, so `diffPayloads({}, payload)` gained a spurious
 * `{field: '', before: {}, after: null}`) is fixed in `domain/snapshot/diff.js`, and
 * the by-name filter that used to sit here is gone with it. "Count the fields" and
 * "diff the fields" are once again the same walk, with no exception.
 */
function payloadFields(payload) {
  return diffPayloads({}, payload).map(change => change.field)
}

/**
 * Every snapshot this ASIN has, newest first.
 *
 * `fieldCount` / `fields` come from {@link payloadFields} rather than from a private
 * flatten: the number beside a snapshot must count the same fields the diff below it
 * names.
 *
 * `registryId` is the pointer row in `snapshot_registry` (`object_type = 'listing'`,
 * written by `upsertSnapshot` and backfilled by v26). It is reported, not required:
 * a snapshot collected before that migration has one too, but a row created by a
 * test that inserts into `asin_snapshot` directly may not — and "no pointer" must
 * read as "no pointer", not as "no snapshot".
 */
export function listAsinSnapshots(store, { asin, marketplace, limit = 100 } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500)

  const total = Number(store.get(
    'SELECT COUNT(*) AS n FROM asin_snapshot WHERE asin = ? AND marketplace = ?', [key, market],
  )?.n ?? 0)

  const rows = store.all(
    `SELECT id, source_id, collected_at, payload_json FROM asin_snapshot
      WHERE asin = ? AND marketplace = ?
      ORDER BY collected_at DESC, id DESC
      LIMIT ?`,
    [key, market, cap],
  )

  const snapshots = rows.map(row => {
    const payload = parseJson(row.payload_json) ?? {}
    const fields = payloadFields(payload)
    const pointer = store.get(
      `SELECT id, version FROM snapshot_registry
        WHERE object_type = 'listing' AND object_id = ? AND ref_table = 'asin_snapshot' AND ref_id = ?`,
      [objectKey(key, market), String(row.id)],
    )
    return {
      id: row.id,
      sourceId: row.source_id,
      collectedAt: row.collected_at,
      fieldCount: fields.length,
      fields,
      registryId: pointer?.id ?? null,
      registryVersion: pointer?.version ?? null,
    }
  })

  return { snapshots, total, limit: cap, truncated: total > snapshots.length }
}

/**
 * Resolve `from` / `to` — an explicit snapshot id, an ISO instant, or nothing.
 *
 * An ISO instant resolves to **the newest snapshot at or before that instant**. If
 * nothing resolves, this returns `null` and the caller refuses by name. Picking the
 * newest snapshot instead would make "I meant that moment" and "I picked something"
 * look identical on the page, and they are not the same question.
 */
function resolveSlot(snapshots, wanted) {
  if (wanted === null || wanted === undefined || String(wanted).trim() === '') return null
  const text = String(wanted).trim()
  const byId = snapshots.find(snapshot => String(snapshot.id) === text)
  if (byId !== undefined) return byId
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null
  return snapshots.find(snapshot => String(snapshot.collectedAt) <= text) ?? null
}

/** The sentence for each of the four "why is there no diff" states. */
export function noDiffNote(snapshots) {
  if (snapshots.length === 0) {
    return '这个 ASIN 还没有任何采集快照 —— 「从没采过」与「采过但没变化」不是一件事'
  }
  if (snapshots.length === 1) {
    return `只有一份快照（${snapshots[0].collectedAt}），两个时间点无从比较`
  }
  return null
}

/**
 * The history view: the list, the chosen pair, and the diff between them.
 *
 * Returns `{ok:true}` with `diff: null` for 0 or 1 snapshots. That is a **state**,
 * not an error — a 500 here would tell the reader the feature is broken when the
 * truth is that nothing has been collected yet.
 */
export function buildAsinHistory(store, {
  asin, marketplace = 'US', from = null, to = null, limit = 100,
} = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (key === '') return { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }
  if (market === '') return { ok: false, code: 'BAD_REQUEST', error: 'marketplace is required' }

  const row = store.get('SELECT asin, marketplace FROM asin WHERE asin = ? AND marketplace = ?', [key, market])
  if (row === undefined) {
    return {
      ok: false,
      code: 'ASIN_NOT_FOUND',
      error: `${key} (${market}) 不在库内`,
      hint: '先用 amzn_asin_upsert 导入，或确认站点代码对不对 —— 同一个 ASIN 在不同站点是两条记录',
    }
  }

  const listed = listAsinSnapshots(store, { asin: key, marketplace: market, limit })
  const snapshots = listed.snapshots
  const notes = []

  const wantedFrom = from === null || from === undefined || String(from).trim() === '' ? null : String(from).trim()
  const wantedTo = to === null || to === undefined || String(to).trim() === '' ? null : String(to).trim()

  const base = {
    ok: true,
    asin: key,
    marketplace: market,
    snapshots,
    total: listed.total,
    limit: listed.limit,
    truncated: listed.truncated,
    pair: null,
    diff: null,
    changedFieldCount: 0,
    changedSnapshotCount: snapshots.length,
    notes,
  }

  if (snapshots.length < 2) {
    notes.push(noDiffNote(snapshots))
    return base
  }

  if (listed.truncated && (wantedFrom !== null || wantedTo !== null)) {
    notes.push(`历史共 ${listed.total} 份，本次只读了最近 ${listed.limit} 份 —— 更早的快照没有参与选择`)
  }

  const explicit = wantedFrom !== null || wantedTo !== null
  let fromSlot = null
  let toSlot = null
  let selection = 'previous'

  if (explicit) {
    selection = 'explicit'
    fromSlot = wantedFrom === null ? snapshots[1] : resolveSlot(snapshots, wantedFrom)
    toSlot = wantedTo === null ? snapshots[0] : resolveSlot(snapshots, wantedTo)
    const missing = []
    if (wantedFrom !== null && fromSlot === null) missing.push(`from=${wantedFrom}`)
    if (wantedTo !== null && toSlot === null) missing.push(`to=${wantedTo}`)
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'SNAPSHOT_NOT_FOUND',
        error: `这条 ASIN 里找不到 ${missing.join(' / ')} 对应的快照（id 精确匹配，时间取该时刻或之前最近的一份）`,
        hint: `可选的是: ${snapshots.slice(0, 20).map(snapshot => `${snapshot.id}@${snapshot.collectedAt}`).join(', ')}`
          + (listed.truncated ? `（只列了最近 ${listed.limit} 份，共 ${listed.total} 份）` : ''),
      }
    }
    if (String(fromSlot.id) === String(toSlot.id)) {
      return {
        ok: false,
        code: 'SNAPSHOT_PAIR_INVALID',
        error: 'from 与 to 解析到了同一份快照，两份之间的差异不存在',
        hint: `换一份（可选: ${snapshots.slice(0, 20).map(snapshot => `${snapshot.id}@${snapshot.collectedAt}`).join(', ')}）`,
      }
    }
  } else {
    fromSlot = snapshots[1]
    toSlot = snapshots[0]
  }

  /* Older → newer. A pair given the other way round is a caller mistake worth
     naming rather than silently swapping: swapping would hide the mistake and
     then answer a question nobody asked. */
  if (String(fromSlot.collectedAt) > String(toSlot.collectedAt)) {
    return {
      ok: false,
      code: 'SNAPSHOT_PAIR_INVALID',
      error: `from（${fromSlot.collectedAt}）比 to（${toSlot.collectedAt}）更晚 —— 差异的方向是「较早 → 较晚」`,
      hint: '把两个参数调过来，或在页面上先选较早的那一份',
    }
  }

  const fromRow = store.get('SELECT payload_json FROM asin_snapshot WHERE id = ?', [fromSlot.id])
  const toRow = store.get('SELECT payload_json FROM asin_snapshot WHERE id = ?', [toSlot.id])
  const changes = diffPayloads(parseJson(fromRow?.payload_json) ?? {}, parseJson(toRow?.payload_json) ?? {})

  const fromRef = { id: fromSlot.id, collectedAt: fromSlot.collectedAt, sourceId: fromSlot.sourceId }
  const toRef = { id: toSlot.id, collectedAt: toSlot.collectedAt, sourceId: toSlot.sourceId }

  const enriched = changes.map(change => {
    const kind = classifyChange(change.field, change.before, change.after)
    const attributed = attributeChange(store, {
      asin: key, marketplace: market, field: change.field, after: change.after, from: fromRef, to: toRef,
    })
    return {
      field: change.field,
      before: change.before,
      after: change.after,
      kind,
      kindLabel: ASIN_CHANGE_KIND_LABELS[kind],
      attribution: attributed.attribution,
      attributionLabel: attributed.label,
      evidence: attributed.evidence,
    }
  })

  const counts = Object.fromEntries(ASIN_CHANGE_KINDS.map(kind => [kind, 0]))
  for (const change of enriched) counts[change.kind] += 1
  counts.total = enriched.length

  const sourceChanged = String(fromRef.sourceId) !== String(toRef.sourceId)

  return {
    ...base,
    pair: { from: fromRef, to: toRef, selection },
    changedFieldCount: enriched.length,
    diff: {
      changes: enriched,
      counts,
      sourceChange: {
        changed: sourceChanged,
        before: fromRef.sourceId,
        after: toRef.sourceId,
        /* 「同一个来源采了两次」是一句有用的话，而且它和「换了来源」的修法不同。 */
        label: sourceChanged
          ? `采集来源从 ${fromRef.sourceId} 变成了 ${toRef.sourceId}`
          : `两次快照都来自 ${fromRef.sourceId}`,
        note: ASIN_SOURCE_TYPE_HISTORY_NOTE,
      },
      empty: enriched.length === 0,
      note: enriched.length === 0 ? '这两份快照的字段逐项相同，没有变化' : null,
    },
  }
}

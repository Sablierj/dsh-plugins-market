/**
 * 把采集到的「产品规格与属性」投影进库。
 *
 * ## 为什么需要这一层（2026-10-20 运营走查实测）
 *
 * 采集**一直拿得到**这几项：`collection_section_result.attributes` 是 `collected 5/5`，
 * 里面有 `attribute.fill_material: "Foam"`、`attribute.color: "Custom Color"` 之类。
 * 但采集侧**没有任何写入路径**把它们落到 `asin_field_source` 或 `listing.attributes_json`。
 *
 * 后果是两道优化门永远降级，而且补数清单还指向一条修不好的路：
 *
 *   门 3「属性 ≤30 天」→ 看 listing.attributes_json 在不在 ⇒ 永远「无快照」
 *   门 8「43 属性足够」→ 数同一份 ⇒ 永远 0/43
 *   补数清单却说「重采一次 13 节详情」—— **重采一百次也不会变**，因为断的是写入不是采集。
 *
 * 43 项里采集能覆盖的只有 4 项（`fill_material` / `color` / `size` / `brand`），
 * 这是真话：剩下的 39 项确实必须人工或后台补。但 4/43 和 0/43 是不一样的 ——
 * 前者告诉运营「这条路走对了，只是还差 39 项」，后者只会让人以为采集不干活。
 *
 * ## 四条纪律
 *
 * 1. **只补空缺，绝不覆盖。** 人工确认过的属性比页面更可信；采一次就把人改过的值冲掉，
 *    是用「新」替换「对」。
 * 2. **每格留来源与观测时间。** `asin_field_source` 存在的意义就是这个 —— 没有它，
 *    下游只能说「有值」，说不了「什么时候看到的」。
 * 3. **只投影 `attribute.` 前缀。** 那是采集契约里属性的键空间，别的键不猜。
 * 4. **占位值不投影。** 复用 `isPlaceholderValue`（与 43 属性门同一个判据，不写第二份）；
 *    页面上写着 N/A / 待定 的那一格是断开的节点，投影进去等于替页面填一个它没说的值。
 */

import { ATTRIBUTE_FIELD_PREFIX, isPlaceholderValue } from '../rules/attributes.js'
import { upsertFieldSource } from '../../store/field-source.js'
import { upsertListing } from '../../store/queries.js'

/** 一个值算不算「有内容」——空串与占位值都不算。与 43 属性门同一判据。 */
function hasValue(value) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  return text !== '' && !isPlaceholderValue(text)
}

/**
 * 从 `attributes` 节的 parsedValue 里挑出可投影的条目。
 * 输入形如 `{"attribute.fill_material":"Foam", ...}`，输出 `[{ field, value }]`。
 */
export function collectableAttributes(parsed) {
  const out = []
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') return out
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== 'string' || !key.startsWith(ATTRIBUTE_FIELD_PREFIX)) continue
    if (!hasValue(value)) continue
    out.push({ field: key, value: String(value).trim() })
  }
  return out
}

/** 现有 attributes_json 里**已经有值**的键（占位值不算有值）。 */
function existingAttributes(store, asin, marketplace) {
  const row = store.get(
    'SELECT attributes_json FROM listing WHERE asin = ? AND marketplace = ?',
    [asin, marketplace],
  ) ?? null
  const raw = row === null ? null : row.attributes_json
  let parsed = {}
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    try {
      const decoded = JSON.parse(String(raw))
      parsed = decoded !== null && typeof decoded === 'object' ? decoded : {}
    } catch {
      /* 读不出来就当没有 —— 但不能因此覆盖它：下面只会补键，不会清空。 */
      parsed = {}
    }
  }
  const filled = new Set()
  for (const [key, value] of Object.entries(parsed)) {
    if (hasValue(value)) filled.add(key)
  }
  return { parsed, filled }
}

/**
 * 投影一次采集结果。
 *
 * @returns {{recorded:number, merged:number, skippedFilled:number, entries:number}}
 *   `recorded` 写进 asin_field_source 的格数；`merged` 真正补进 listing 的格数；
 *   `skippedFilled` 因为已有值而没动的格数。三个数分开，是为了让调用方
 *   （以及将来的报告）能说清「采到了但没写」与「写进去了」的区别。
 */
export function projectCollectedAttributes(store, {
  asin,
  marketplace,
  parsed = null,
  observedAt = null,
  sourceId = 'browser-local',
} = {}) {
  const entries = collectableAttributes(parsed)
  if (entries.length === 0) return { recorded: 0, merged: 0, skippedFilled: 0, entries: 0 }

  /* ① 来源行：每一格一条，带 observed_at。这一步即使不合并进 listing 也要做 ——
        它让「这一格是什么时候看到的」有答案。 */
  for (const entry of entries) {
    upsertFieldSource(store, {
      asin,
      marketplace,
      field: entry.field,
      sourceId,
      value: entry.value,
      sourceType: 'collect',
      observedAt,
    })
  }

  /* ② listing.attributes_json：只补空缺。 */
  const { parsed: existing, filled } = existingAttributes(store, asin, marketplace)
  const merged = { ...existing }
  let mergedCount = 0
  let skippedFilled = 0
  for (const entry of entries) {
    if (filled.has(entry.field)) {
      skippedFilled += 1
      continue
    }
    merged[entry.field] = entry.value
    mergedCount += 1
  }

  if (mergedCount > 0) {
    /* origin 用 `snapshot`：这份值来自一次采集快照，与「人工录入」和「草案采纳」
       都不同。不用 `collected` 是因为那不是一个合法的 origin 值 —— 为了一句话
       去改数据库的词表，代价大于收益。 */
    upsertListing(store, {
      asin,
      marketplace,
      attributes: merged,
      sourceId,
      origin: 'snapshot',
    })
  }

  return { recorded: entries.length, merged: mergedCount, skippedFilled, entries: entries.length }
}

/**
 * ASIN 的字段级写入口（模块 05 F05-03）—— **人工修正写「人工来源」，不动原始值**。
 *
 * ## 这一条是需求原话，不是实现细节
 *
 * 模块设计 §3.3：「人工修正写入『人工来源』，不改原始采集值。」它在库里的落地方式是
 * 三条同时成立的事实，缺一条这句话就是假的：
 *
 *   1. 人工值写成 `asin_field_source` 里一条 `source_type='manual'`（来源 id `manual`）的
 *      **新行**，与采集/导入那一行并排存在 —— 不是覆盖它；
 *   2. `asin.<field>` 这一列更新为人工值，因为「当前采用值」就是这一列
 *      （`domain/data/lineage.js` 的第一跳这么读的），采用值的变更必须被任何读那列的人看到；
 *   3. **采集快照 `asin_snapshot.payload_json` 一个字节都不动** —— 那是「亚马逊当时
 *      打印了什么」的原文，人工修正与它无关。
 *
 * 于是「修正前是什么」永远读得回来：来源行里有、快照里有。测试断言的是第 1 与第 3 条
 * （行数与快照原文前后逐字节相等），因为它们才是会被人不小心破坏的部分。
 *
 * ## 为什么只收 `ASIN_FACT_FIELDS` 里的字段
 *
 * 那些是 `asin` 表上的列。bullets / description / A+ 这些内容字段住在 `listing` 表
 * （"内容草案"类），人工修正它们要走另一条带审批的路径（模块设计 §4「不同类别采用不同
 * 编辑和审批规则」）。本批**不做**那条路径，所以这里**明说拒绝**并指出它属于哪一类，
 * 而不是把它们硬塞进 asin 列（那会让「建议内容」看起来像「已发布内容」）。
 */

import { nowIso } from './db.js'
import { assertAsinWritable } from './archive.js'
import { upsertFieldSource } from './field-source.js'
/* FR-M2-05：人工修正**就是一次裁决**，所以它要把那条冲突落成 resolved（见下面的注释）。 */
import { resolveConflict } from './conflict.js'
import { ASIN_FACT_FIELDS, MANUAL_SOURCE_ID, isNumericFactField } from '../domain/asin/fields.js'

/** `asin` 表上没有的 Listing 字段，报错时点名它们去哪了。 */
const CONTENT_FIELDS = [
  'bullets', 'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5',
  'description', 'search_terms', 'item_highlights', 'a_plus', 'aplus', 'images', 'video',
]

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/** 一个字段现在的全部来源行，按写入时间倒序。 */
function sourcesOf(store, asin, marketplace, field) {
  return store
    .all(
      `SELECT source_id, source_type, value, raw_value, observed_at, ingested_at, updated_at, confidence
         FROM asin_field_source WHERE asin = ? AND marketplace = ? AND field = ?
        ORDER BY updated_at DESC, source_id ASC`,
      [asin, marketplace, field],
    )
    .map(row => ({
      sourceId: row.source_id,
      sourceType: row.source_type ?? null,
      value: parseJson(row.value, null),
      rawValue: row.raw_value ?? null,
      observedAt: row.observed_at ?? null,
      ingestedAt: row.ingested_at ?? null,
      updatedAt: row.updated_at,
      isManual: row.source_type === 'manual' || row.source_id === MANUAL_SOURCE_ID,
    }))
}

/**
 * 人工修正一个字段。
 *
 * 抛出的错误都带 `code`（`FIELD_NOT_A_COLUMN` / `VALUE_REQUIRED` / `VALUE_NOT_NUMERIC` /
 * `ASIN_ARCHIVED`）。抛而不是返回 `{ok:false}`：这一层是 store，调用方（工具、路由）
 * 各自决定怎么把它回报给用户，而工具漏斗把异常转成返回值正是它存在的理由之一。
 */
export function correctAsinField(store, record = {}) {
  const asin = String(record.asin ?? '').trim().toUpperCase()
  const marketplace = String(record.marketplace ?? '').trim().toUpperCase()
  const field = String(record.field ?? '').trim()
  if (field === '') {
    const error = new Error('field is required')
    error.code = 'FIELD_REQUIRED'
    throw error
  }
  if (!ASIN_FACT_FIELDS.includes(field)) {
    const error = new Error(CONTENT_FIELDS.includes(field)
      ? `字段 "${field}" 不是 asin 表上的列，它在 listing 表上（内容类字段走审批路径，本批不做）—— `
        + `本批可人工修正的字段：${ASIN_FACT_FIELDS.join(', ')}`
      : `未知字段 "${field}"；可人工修正的字段：${ASIN_FACT_FIELDS.join(', ')}`)
    error.code = 'FIELD_NOT_A_COLUMN'
    throw error
  }

  assertAsinWritable(store, { asin, marketplace, action: '人工修正字段' })

  const raw = record.value
  const provided = raw !== null && raw !== undefined && String(raw).trim() !== ''
  if (!provided) {
    /* 空值不是「改成空」：在 `asin` 列上它会把一个已有值擦掉，而「清空」是另一个
       必须显式的动作（模块设计 §3.5 对导入也定了同一条：空白不覆盖已有值）。 */
    const error = new Error(`value is required —— 空值不覆盖已有值；要清空请显式说明（本批不提供清空）`)
    error.code = 'VALUE_REQUIRED'
    throw error
  }

  let value = raw
  if (isNumericFactField(field)) {
    const numeric = Number(String(raw).replace(/,/g, '').trim())
    if (!Number.isFinite(numeric)) {
      const error = new Error(`${field} 是数值列，人工值 "${raw}" 不是数字 —— `
        + 'SQLite 会把文本安静地存进 REAL 列，然后每一个 sum/avg 都算错')
      error.code = 'VALUE_NOT_NUMERIC'
      throw error
    }
    value = numeric
  } else {
    value = String(raw).trim()
  }

  const marketplaceKey = marketplace === '' ? 'US' : marketplace
  const before = {
    adoptedValue: store.get('SELECT * FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplaceKey])?.[field] ?? null,
    sources: sourcesOf(store, asin, marketplaceKey, field),
  }
  const snapshotBefore = store.get(
    'SELECT id, payload_json FROM asin_snapshot WHERE asin = ? AND marketplace = ? ORDER BY collected_at DESC, id DESC LIMIT 1',
    [asin, marketplaceKey],
  )

  const now = nowIso()
  const sourceId = blankToNull(record.sourceId) ?? MANUAL_SOURCE_ID
  store.tx(() => {
    /* 人工来源行。`sourceType` 显式写 'manual'：不靠 `source` 表的 kind 去推 ——
       来源 id 可以被改名，而「这一行是人写的」这句话不该随它漂。 */
    upsertFieldSource(store, {
      asin,
      marketplace: marketplaceKey,
      field,
      sourceId,
      value,
      sourceType: 'manual',
      confidence: 1,
      /* `observedAt` 刻意不填：人工修正说明的是「采用值现在应该是这个」，
         而不是「这个事实在世界上是什么时候成立的」。一个编出来的观察时间
         会让新鲜度看起来是刚测过的 —— 它是没有观测时间的。 */
      observedAt: record.observedAt ?? null,
    })
    store.run(
      `UPDATE asin SET ${field} = ?, updated_at = ? WHERE asin = ? AND marketplace = ?`,
      [value, now, asin, marketplaceKey],
    )

    /* ── FR-M2-05：人工修正**就是一次裁决** ──────────────────────────────────
       上面那次 `upsertFieldSource` 会顺手开一条冲突行（人工值 vs 采集值，见
       `store/field-source.js` 的检测钩子）。可是在那之前与之后，它一直停在
       `open` + `adopted_value = null` —— 读起来像「还没人决定」，而**人刚刚才决定过**。
       更坏的是：一旦有人再 upsert 把这个字段覆盖回去，那行就成了「与事实相反的痕迹」
       （建议仍指向人工值、状态仍是待裁决）。实测复现：
       `team/dev/fr-m2-05-coalesce-repro.mjs`。

       所以这里把它落成 `resolved`：采用值 = 人工值、来源 = 人工来源。
       之后若真被覆盖，`upsertAsin` 会 reopen 它并写明「谁覆盖了什么」——
       两个方向都有出口：**人裁了就记成裁了；被推翻了就重新摆回人面前。** */
    const conflict = store.get(
      'SELECT id, status FROM field_conflict WHERE asin = ? AND marketplace = ? AND field = ?',
      [asin, marketplaceKey, field],
    )
    if (conflict !== undefined && conflict !== null && conflict.status === 'open') {
      /* 采用值按来源里的存法（JSON）写进去：`conflictView` 把两边原样印出来比较，
         一边是 `"line-b"` 一边是 `line-b` 会让「是不是同一个值」肉眼判不出来。 */
      resolveConflict(store, {
        id: conflict.id,
        adoptedValue: JSON.stringify(value),
        adoptedSourceId: sourceId,
        resolvedBy: blankToNull(record.resolvedBy) ?? 'local',
        note: '人工修正（correctAsinField）：采用值已写为人工值',
      })
    }
  })

  const snapshotAfter = store.get(
    'SELECT id, payload_json FROM asin_snapshot WHERE asin = ? AND marketplace = ? ORDER BY collected_at DESC, id DESC LIMIT 1',
    [asin, marketplaceKey],
  )

  return {
    ok: true,
    asin,
    marketplace: marketplaceKey,
    field,
    value,
    sourceId,
    before,
    after: {
      adoptedValue: value,
      sources: sourcesOf(store, asin, marketplaceKey, field),
    },
    /* 三条事实里最容易被人不小心破掉的两条，作为返回值直接可断言：
       采集快照没被写、原始那一行还在。 */
    snapshot: {
      id: snapshotBefore?.id ?? null,
      unchanged: (snapshotBefore?.payload_json ?? null) === (snapshotAfter?.payload_json ?? null),
      note: snapshotBefore === undefined
        ? '这个 ASIN 还没有采集快照 —— 没有快照可动，也就没有「改了快照」这回事'
        : '采集快照的 payload 未被这次修正改动',
    },
    reason: blankToNull(record.reason),
    by: blankToNull(record.by),
    text: `已把 ${asin}@${marketplaceKey} 的 ${field} 人工修正为 ${JSON.stringify(value)}`
      + `（来源 ${sourceId}，原来的 ${before.sources.filter(source => !source.isManual).length} 条采集/导入来源一行未动）`,
  }
}

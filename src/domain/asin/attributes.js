/**
 * 属性补齐的**唯一实现**（R-95）—— 工具与页面路由都走这里。
 *
 * 本仓的规矩：页面路由不内联重算，模型工具也不另写一份（`amzn_asin_attribute_set`
 * 与 `asin-attribute-save` 是同一次动作的两条入口）。所以判定、合并、来源行都收在这个文件里。
 *
 * 三条规矩（写在这里，因为两条入口都要守）：
 * 1. 只认登记表里的属性 id —— 手打一个错的 id 进来，只会得到一个没人读取的键；
 * 2. 占位值 / 空值一律拒 —— `N/A`、`待定`、`无` 在统计里等同于空，写进去只是把缺口伪装成已填；
 * 3. 只补不清 —— 没传的键原样保留；同一个键再写一次是「更正」。
 */

import {
  ATTRIBUTES, ATTRIBUTE_FIELD_PREFIX, attributeCoverage, attributeField,
  isPlaceholderValue, labelForAttribute,
} from '../rules/attributes.js'
import { upsertFieldSource } from '../../store/field-source.js'
import { upsertListing } from '../../store/queries.js'

export function normaliseAsin(value) {
  const asin = String(value ?? '').trim().toUpperCase()
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null
}

export function normaliseMarketplace(value) {
  return String(value ?? 'US').trim().toUpperCase() || 'US'
}

/** `listing.attributes_json` 读成对象。查不到行时 store.get 给的是 **undefined**（不是 null）。 */
export function readAttributes(store, asin, marketplace) {
  const row = store.get('SELECT attributes_json FROM listing WHERE asin = ? AND marketplace = ?', [asin, marketplace])
  if (row === null || row === undefined || row.attributes_json === null || row.attributes_json === undefined) return {}
  try {
    const parsed = JSON.parse(row.attributes_json)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function asinExists(store, asin, marketplace) {
  const row = store.get('SELECT asin FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace])
  return row !== null && row !== undefined
}

/** 读：43 项必填里已填 / 空 / 占位三份清单 + 还缺哪几项。 */
export function attributeStatus(store, { asin, marketplace = 'US' } = {}) {
  const code = normaliseAsin(asin)
  if (code === null) return { ok: false, error: `invalid ASIN "${asin}"`, hint: '10 letters/digits' }
  const market = normaliseMarketplace(marketplace)
  if (!asinExists(store, code, market)) {
    return {
      ok: false,
      error: `${code}@${market} 不在 ASIN 库里`,
      hint: '先把这个 ASIN 建出来（amzn_asin_upsert / 采集），属性才有地方挂。',
    }
  }
  const fields = readAttributes(store, code, market)
  const coverage = attributeCoverage(fields)
  const missing = [
    ...coverage.empty.map(id => ({ id, kind: '空', label: labelForAttribute(id), field: `${ATTRIBUTE_FIELD_PREFIX}${id}` })),
    ...coverage.placeholder.map(id => ({ id, kind: '占位值', label: labelForAttribute(id), field: `${ATTRIBUTE_FIELD_PREFIX}${id}` })),
  ]
  return { ok: true, asin: code, marketplace: market, coverage, missing }
}

/**
 * 写：人工补属性。
 *
 * 返回 `{ ok:false, error, hint }` 的那几种情况都**没有写库** —— 调用方（工具 / 页面）
 * 原样把 error 与 hint 上屏即可，不要自己编一句更客气的话。
 */
export function saveAttributes(store, { asin, marketplace = 'US', values, note = null, by = null } = {}) {
  const code = normaliseAsin(asin)
  if (code === null) return { ok: false, error: `invalid ASIN "${asin}"`, hint: '10 letters/digits' }
  const market = normaliseMarketplace(marketplace)
  if (!asinExists(store, code, market)) {
    return {
      ok: false,
      error: `${code}@${market} 不在 ASIN 库里`,
      hint: '先把这个 ASIN 建出来（amzn_asin_upsert / 采集），属性才有地方挂。',
    }
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, error: 'values must be an object: { "<attribute id>": "<value>" }' }
  }
  const ids = Object.keys(values)
  if (ids.length === 0) return { ok: false, error: 'values 是空的 —— 什么都没说，就不该写库' }

  const known = new Set(Object.keys(ATTRIBUTES))
  const unknown = ids.filter(id => !known.has(id))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `未知属性 id：${unknown.join(', ')}`,
      hint: `属性 id 必须来自登记表（${known.size} 个）。写进去只会得到一个没人读取的键。`,
    }
  }

  const cleaned = {}
  const placeholders = []
  const blanks = []
  for (const id of ids) {
    const raw = values[id]
    const value = raw === undefined || raw === null ? '' : String(raw).trim()
    if (value === '') { blanks.push(id); continue }
    if (isPlaceholderValue(value)) { placeholders.push(id); continue }
    cleaned[id] = value
  }
  if (blanks.length > 0 || placeholders.length > 0) {
    return {
      ok: false,
      error: [
        blanks.length > 0 ? `空值：${blanks.join(', ')}` : null,
        placeholders.length > 0 ? `占位值：${placeholders.join(', ')}` : null,
      ].filter(Boolean).join(' · '),
      hint: '占位值（N/A / 待定 / 无 / -）在统计里等同于空 —— 写进去只是把缺口伪装成已填。',
    }
  }

  const merged = { ...readAttributes(store, code, market) }
  for (const id of Object.keys(cleaned)) merged[attributeField(id)] = cleaned[id]

  const sourceId = 'manual'
  const at = new Date().toISOString()
  upsertListing(store, { asin: code, marketplace: market, attributes: merged, sourceId, origin: 'manual' })
  for (const id of Object.keys(cleaned)) {
    upsertFieldSource(store, {
      asin: code,
      marketplace: market,
      field: attributeField(id),
      sourceId,
      value: cleaned[id],
      sourceType: 'manual',
      observedAt: at,
    })
  }

  return {
    ok: true,
    asin: code,
    marketplace: market,
    written: Object.keys(cleaned),
    coverage: attributeCoverage(merged),
    by: String(by ?? '').trim() || 'manual',
    note: String(note ?? '').trim() || null,
  }
}

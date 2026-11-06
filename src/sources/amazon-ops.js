/**
 * amazon-ops 的只读适配器。
 *
 * 为什么读它：amazon-ops 有 `listing` 表（标题/五点/描述/A+/属性/后台词），
 * 那是它用 CDP 从商品页采的**真文案**。sif-ops 只读、绝不写它的库。
 *
 * 三个必须守的规矩：
 *   1. 打不开（没装/被锁/版本不同）→ 返回 null 并说明，不抛错；
 *   2. 只 SELECT，不 ATTACH 建视图、不写；
 *   3. 读到的字段一律标 `source: 'amazon-ops'`，和 SIF 来源区分开。
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export const AMAZON_OPS_DB = 'D:/deepseek-harness-h/workspace/dsh-plugins/amazon-ops/data/amazon-ops.db'

export function readAmazonOpsListing({ asin, marketplace = 'US', dbPath = AMAZON_OPS_DB, logger = console } = {}) {
  if (!asin) return null
  if (!existsSync(dbPath)) return { ok: false, reason: `amazon-ops 数据库不存在：${dbPath}` }
  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare(
      `SELECT asin, marketplace, title, bullets_json, description, a_plus, search_terms, attributes_json, item_highlights, updated_at
       FROM listing WHERE asin = ? AND marketplace = ? LIMIT 1`).get(asin, marketplace)
    if (!row) return { ok: true, found: false, reason: 'amazon-ops 还没有这个 ASIN 的 listing 采集' }
    return {
      ok: true,
      found: true,
      source: 'amazon-ops',
      updatedAt: row.updated_at ?? null,
      listing: {
        title: row.title ?? '',
        bullets: safeJson(row.bullets_json, []),
        description: row.description ?? '',
        searchTerms: row.search_terms ?? '',
        attributes: safeJson(row.attributes_json, []),
        itemHighlights: row.item_highlights ?? '',
        aplus: row.a_plus === null || row.a_plus === undefined ? null : Number(row.a_plus) === 1,
      },
    }
  } catch (error) {
    logger.warn?.(`[sif-ops] 读 amazon-ops 失败：${error.message}`)
    return { ok: false, reason: error.message }
  } finally {
    try {
      db?.close()
    } catch {
      /* 已关 */
    }
  }
}

function safeJson(text, fallback) {
  if (!text) return fallback
  try {
    return JSON.parse(text) ?? fallback
  } catch {
    return fallback
  }
}

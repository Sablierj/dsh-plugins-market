/**
 * 同步编排：预算 → 缓存 → 调用 → 摊平入库 → 记账。
 *
 * 一条铁律：**只要不是第一次抓，就不该再花点。** 命中 6 小时缓存就 0 点返回，
 * 并如实标 cached，页面显示「复用」而不是「已同步」。
 */
import { hashOf, insertRaw, logQuota, recentRaw } from '../store/queries.js'
import { parseDataDate } from './normalize.js'

/** 各档位的工具与单价（点数取自 sif_catalog，2026-11-05）。 */
export const LEVELS = {
  L1: {
    label: '日报（流量趋势 + Listing 渠道结构）',
    costPerAsin: 5,
    tools: [
      { tool: 'ops_get_asin_traffic_trend', cost: 2 },
      { tool: 'ops_get_listing_traffic_overview', cost: 3 },
    ],
  },
  L2: {
    label: '周报（关键词信号 + 广告结构 + 销量）',
    costPerAsin: 6,
    tools: [
      { tool: 'market_get_asin_keyword_signals', cost: 3 },
      { tool: 'ads_get_asin_ad_structure', cost: 2 },
      { tool: 'ops_get_asin_sales_trend', cost: 1 },
    ],
  },
}

export function planSync({ store, level, asins, dailyBudget }) {
  const spec = LEVELS[level]
  if (!spec) throw new Error(`未知的档位：${level}（只支持 ${Object.keys(LEVELS).join(' / ')}）`)
  const list = [...new Set((asins ?? []).map(value => String(value).trim().toUpperCase()).filter(Boolean))]
  const cost = spec.costPerAsin * list.length
  const spent = require_spent(store)
  const budget = Number(dailyBudget ?? 60)
  return {
    level,
    label: spec.label,
    costPerAsin: spec.costPerAsin,
    asins: list,
    cost,
    todaySpent: spent,
    budget,
    overBudget: spent + cost > budget,
    tools: spec.tools,
  }
}

function require_spent(store) {
  const row = store.get(`SELECT COALESCE(SUM(cost_points), 0) AS spent FROM sif_sync_run WHERE date(started_at) = date('now')`)
  return Number(row?.spent ?? 0)
}

/** 一次工具调用：缓存命中不扣点；否则调一次、存 raw、记配额。 */
async function callTool({ client, store, tool, params, useCache = true }) {
  const hash = hashOf(tool, params)
  if (useCache) {
    const cached = recentRaw(store, hash)
    if (cached) return { payload: cached.response, cost: 0, cached: true }
  }
  const payload = await client.callTool(tool, params)
  const cost = Number(payload?._quota?.costThisCall ?? 0)
  insertRaw(store, { tool, params, hash, dataDate: parseDataDate(payload?.data_notice), cost, ok: true, response: payload })
  logQuota(store, tool, payload)
  return { payload, cost, cached: false }
}

export { callTool }

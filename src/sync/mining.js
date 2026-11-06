/**
 * 关键词挖掘：给定词根，把「同源关系词」一次捞进来当候选词（3 点/次）。
 *
 * 挖到的词默认是 candidate（候选），不是 tracked：候选词只进词库、不进日报，
 * 要人/模型决定「这个词值得追」再升级为 tracked，避免词库被 300 个长尾词灌满。
 */
import { upsertKeyword } from '../store/keywords.js'
import { parseDataDate } from './normalize.js'
import { callTool } from './plan.js'

export const MINING_COST = 3

export async function mineKeywords({ client, store, marketplace = 'US', root, pageSize = 100, logger = console }) {
  const keywordRoot = String(root ?? '').trim().toLowerCase()
  if (!keywordRoot) throw new Error('词根不能为空')

  const mined = await callTool({
    client,
    store,
    tool: 'market_screen_keyword_opportunities',
    params: {
      keyword_root: keywordRoot,
      country: marketplace,
      pageSize,
      sort_by: 'rank',
      returnFields: ['keyword_root', 'total', 'keywords', 'pagination', 'data_notice', '_quota'],
    },
  })

  const payload = mined.payload ?? {}
  const dataDate = parseDataDate(payload.data_notice)
  let added = 0
  for (const item of payload.keywords ?? []) {
    if (!item?.keyword) continue
    upsertKeyword(store, {
      marketplace,
      keyword: item.keyword,
      status: 'candidate',
      source: `mining:${keywordRoot}`,
      root: keywordRoot,
      volumeWeek: num(item.search_volume),
      clicksWeek: num(item.clicks_week),
      ctrWeek: num(item.search_ctr_week),
      note: item.data_status === 'not_indexed' ? '未被经济学表收录' : null,
    })
    added += 1
  }

  logger.info?.(`[sif-ops] 挖掘 ${keywordRoot}: ${added} 个候选词（共 ${payload.total ?? '?'} 个关系词）`)
  return {
    root: keywordRoot,
    ok: true,
    cost: mined.cost,
    cached: mined.cached,
    added,
    total: payload.total ?? null,
    // 说清覆盖率：只拿了第 1 页，不等于词根只有这么多词
    pagination: payload.pagination ?? null,
    dataDate,
  }
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

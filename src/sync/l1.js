/**
 * L1 日报：每 ASIN 5 点（流量趋势 2 + Listing 渠道结构 3）。
 *
 * 为什么这两件事绑在一起：一个是「量在怎么变」，一个是「量从哪些渠道来」。
 * 只看趋势会误判（广告停了看起来像自然位崩了），两个一起才能回答「这次跌是谁的问题」。
 */
import { finishRun, startRun, upsertListingOverview, upsertTraffic } from '../store/queries.js'
import { nowIso } from '../store/time.js'
import { overviewRow, parseDataDate, trafficRowsFromTrend } from './normalize.js'
import { callTool } from './plan.js'

const TRAFFIC_FIELDS = [
  'asin', 'dates', 'totalScore', 'nfScore', 'adScore', 'spScore', 'sbScore', 'sbvScore',
  'trend_analysis', 'latest_point_date', 'boughtInPastMonth', 'data_notice', '_quota',
]

export async function runL1({ client, store, marketplace = 'US', asin, logger = console }) {
  const fetchedAt = nowIso()
  const runId = startRun(store, {
    level: 'L1',
    tool: 'ops_get_asin_traffic_trend',
    params: { asin, marketplace, granularity: 'week' },
    objects: [asin],
  })
  let cost = 0
  let rows = 0
  try {
    const traffic = await callTool({
      client,
      store,
      tool: 'ops_get_asin_traffic_trend',
      params: { asin, country: marketplace, granularity: 'week', lastMonths: 3, returnFields: TRAFFIC_FIELDS },
    })
    cost += traffic.cost
    const trafficRows = trafficRowsFromTrend(traffic.payload, { marketplace, asin, fetchedAt })
    for (const row of trafficRows) {
      upsertTraffic(store, row)
      rows += 1
    }

    const overview = await callTool({
      client,
      store,
      tool: 'ops_get_listing_traffic_overview',
      params: {
        asin,
        country: marketplace,
        isListingSearch: true,
        timePieceType: 'latelyDay',
        timePieceValue: '7',
        returnFields: ['total', 'overview', 'ad', 'recommend', 'data_notice', '_quota'],
      },
    })
    cost += overview.cost
    upsertListingOverview(store, overviewRow(overview.payload, { marketplace, asin, fetchedAt }))
    rows += 1

    finishRun(store, runId, { cost, rows })
    return {
      asin,
      ok: true,
      cost,
      rows,
      weeks: trafficRows.length,
      cached: traffic.cached && overview.cached,
      dataDate: parseDataDate(traffic.payload?.data_notice),
    }
  } catch (error) {
    finishRun(store, runId, { cost, rows, status: 'failed', error: error.message })
    logger.warn?.(`[sif-ops] L1 ${asin} 失败：${error.message}`)
    return { asin, ok: false, cost, rows, error: error.message }
  }
}

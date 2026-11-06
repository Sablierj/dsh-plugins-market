/**
 * L0 画像：把一个 ASIN 的「是谁」抓下来（2 点/ASIN，一次即可）。
 *
 * 放在「加对象」这一步，而不是每天同步里：价格、评分、上架日、变体数几乎不变，
 * 每天重抓是浪费点数；加进清单时抓一次，之后要刷新再手动点。
 */
import { finishRun, startRun, upsertAsin } from '../store/queries.js'
import { nowIso } from '../store/time.js'
import { parseDataDate, stripAsin } from './normalize.js'
import { callTool } from './plan.js'

export async function fetchProfile({ client, store, marketplace = 'US', asin, logger = console }) {
  const runId = startRun(store, { level: 'L0', tool: 'market_get_asin_profile', params: { asin, marketplace }, objects: [asin] })
  let cost = 0
  try {
    const result = await callTool({
      client,
      store,
      tool: 'market_get_asin_profile',
      params: {
        asins: [asin],
        country: marketplace,
        returnFields: [
          'count', 'list', 'data_notice', '_quota',
        ],
      },
    })
    cost = result.cost
    const payload = result.payload ?? {}
    const raw = Array.isArray(payload.list) ? payload.list[0] : null
    if (!raw) {
      finishRun(store, runId, { cost, rows: 0, status: 'ok' })
      return { asin, ok: true, cost, cached: result.cached, found: false }
    }
    // `asin` 字段是 markdown 链接，剥壳后再入库
    upsertAsin(store, marketplace, { ...raw, asin: stripAsin(raw.asin) }, {
      dataDate: parseDataDate(payload.data_notice),
      observedAt: nowIso(),
    })
    finishRun(store, runId, { cost, rows: 1 })
    logger.info?.(`[sif-ops] L0 ${asin}: ${raw.title?.slice(0, 40) ?? ''} $${raw.price ?? '?'}`)
    return { asin, ok: true, cost, cached: result.cached, found: true, title: raw.title ?? null, price: raw.price ?? null }
  } catch (error) {
    finishRun(store, runId, { cost, rows: 0, status: 'failed', error: error.message })
    logger.warn?.(`[sif-ops] L0 画像失败 ${asin}: ${error.message}`)
    return { asin, ok: false, cost, error: error.message }
  }
}

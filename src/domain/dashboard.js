/**
 * 看板数据：一次把「该看的几件事」装配成一个结构，页面和模型都用这一份。
 *
 * 全部读本地库（0 点）。页面不自己算指标——它只画这里给的东西，
 * 所以「屏幕上显示的」和「模型引用的」不可能不一致。
 */
import { computeInsights } from './insights.js'
import { listObjects } from '../store/queries.js'
import { nowIso } from '../store/time.js'

export function buildDashboard(store, { marketplace = 'US' } = {}) {
  const objects = listObjects(store, marketplace)

  const asins = objects.map(object => {
    const weeks = store.all(
      `SELECT period_start, total_score, nf_score, ad_score, nf_ratio, ad_ratio, total_change_ratio, data_date, is_complete
       FROM sif_traffic WHERE marketplace = ? AND asin = ? AND period_type = 'week'
       ORDER BY period_start ASC`, [marketplace, object.asin])
    const latest = weeks[weeks.length - 1] ?? null
    const previous = weeks[weeks.length - 2] ?? null

    const keywords = store.all(
      `SELECT keyword, traffic_share, contri_change, organic_page, organic_pos, organic_total,
              gap_severity, rank_evolution, traffic_dependency
       FROM sif_asin_keyword WHERE marketplace = ? AND asin = ?
       ORDER BY traffic_share DESC LIMIT 8`, [marketplace, object.asin])

    const ads = store.get(
      `SELECT observed_at, sp_count, sb_count, sbv_count, total_count, data_date
       FROM sif_ad_summary WHERE marketplace = ? AND asin = ? ORDER BY observed_at DESC LIMIT 1`,
      [marketplace, object.asin]) ?? null

    const sales = store.all(
      `SELECT month, bought, bought_band FROM sif_sales_month WHERE marketplace = ? AND asin = ?
       ORDER BY month DESC LIMIT 6`, [marketplace, object.asin])

    const coverage = store.get(
      `SELECT (SELECT COUNT(*) FROM sif_traffic WHERE marketplace = ? AND asin = ?) AS traffic_rows,
              (SELECT COUNT(*) FROM sif_asin_keyword WHERE marketplace = ? AND asin = ?) AS keyword_rows,
              (SELECT COUNT(*) FROM sif_sales_month WHERE marketplace = ? AND asin = ?) AS sales_rows,
              (SELECT MAX(data_date) FROM sif_traffic WHERE marketplace = ? AND asin = ?) AS data_date`,
      [marketplace, object.asin, marketplace, object.asin, marketplace, object.asin, marketplace, object.asin]) ?? {}

    return {
      asin: object.asin,
      label: object.label,
      title: object.title ?? null,
      price: object.price ?? null,
      star: object.star_rating ?? null,
      reviews: object.rating_num ?? null,
      lastSync: object.last_sync ?? null,
      dataDate: coverage.data_date ?? null,
      weeks,
      latest,
      previous,
      keywords,
      ads,
      sales,
      coverage: {
        trafficRows: coverage.traffic_rows ?? 0,
        keywordRows: coverage.keyword_rows ?? 0,
        salesRows: coverage.sales_rows ?? 0,
      },
      insights: computeInsights(store, { marketplace, asin: object.asin }),
    }
  })

  const allInsights = asins.flatMap(item => item.insights.map(insight => ({ ...insight, asin: item.asin })))
  return {
    marketplace,
    generatedAt: nowIso(),
    objects: asins.length,
    alerts: {
      high: allInsights.filter(item => item.severity === 'high').length,
      medium: allInsights.filter(item => item.severity === 'medium').length,
      low: allInsights.filter(item => item.severity === 'low').length,
    },
    asins,
  }
}

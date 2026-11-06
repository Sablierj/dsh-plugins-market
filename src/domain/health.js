/**
 * 数据健康：先回答「这份报告能不能信」，再谈结论。
 *
 * 资深运营最容易踩的坑不是看不懂数，是**拿着缺一层的数下判断**。
 * 所以这里把「覆盖 / 时效 / 缺口」三件事摊开，缺什么直接点名到「去哪个页签补」。
 */
export function dataHealth(store, { marketplace = 'US' } = {}) {
  const one = sql => Number(store.get(sql)?.n ?? 0)

  const counts = {
    objects: one(`SELECT COUNT(*) AS n FROM sif_object WHERE marketplace = '${esc(marketplace)}'`),
    trafficRows: one(`SELECT COUNT(*) AS n FROM sif_traffic WHERE marketplace = '${esc(marketplace)}'`),
    keywordRows: one(`SELECT COUNT(*) AS n FROM sif_asin_keyword WHERE marketplace = '${esc(marketplace)}'`),
    abaRows: one(`SELECT COUNT(*) AS n FROM sif_keyword_aba WHERE marketplace = '${esc(marketplace)}'`),
    demandRows: one(`SELECT COUNT(*) AS n FROM sif_keyword_demand WHERE marketplace = '${esc(marketplace)}'`),
    adRows: one(`SELECT COUNT(*) AS n FROM sif_ad_summary WHERE marketplace = '${esc(marketplace)}'`),
    salesRows: one(`SELECT COUNT(*) AS n FROM sif_sales_month WHERE marketplace = '${esc(marketplace)}'`),
    competitorRows: one(`SELECT COUNT(*) AS n FROM sif_competitor WHERE marketplace = '${esc(marketplace)}'`),
    reportRows: one(`SELECT COUNT(*) AS n FROM sif_report WHERE marketplace = '${esc(marketplace)}'`),
  }

  const latestData = store.get(
    `SELECT MAX(data_date) AS d FROM sif_traffic WHERE marketplace = ?`, [marketplace])?.d ?? null
  const ageDays = latestData ? Math.floor((Date.now() - Date.parse(latestData + 'T00:00:00Z')) / 86_400_000) : null

  const asins = store.all(`SELECT asin FROM sif_object WHERE marketplace = ? ORDER BY created_at`, [marketplace])
  const perAsin = asins.map(({ asin }) => {
    const traffic = store.get(
      `SELECT COUNT(*) AS rows, MAX(period_start) AS last_period, MAX(data_date) AS data_date
       FROM sif_traffic WHERE marketplace = ? AND asin = ?`, [marketplace, asin]) ?? {}
    const keywords = one(`SELECT COUNT(*) AS n FROM sif_asin_keyword WHERE marketplace = '${esc(marketplace)}' AND asin = '${esc(asin)}'`)
    const sales = one(`SELECT COUNT(*) AS n FROM sif_sales_month WHERE marketplace = '${esc(marketplace)}' AND asin = '${esc(asin)}'`)
    const ads = one(`SELECT COUNT(*) AS n FROM sif_ad_summary WHERE marketplace = '${esc(marketplace)}' AND asin = '${esc(asin)}'`)
    const layers = { traffic: traffic.rows ?? 0, keywords, sales, ads }
    return {
      asin,
      lastPeriod: traffic.last_period ?? null,
      dataDate: traffic.data_date ?? null,
      layers,
      missing: Object.entries(layers).filter(([, value]) => !value).map(([name]) => name),
    }
  })

  const gaps = []
  if (!counts.trafficRows) gaps.push({ layer: 'traffic', fix: '同步页跑 L1（5 点/ASIN）' })
  if (!counts.keywordRows) gaps.push({ layer: 'keywords', fix: '同步页跑 L2（6 点/ASIN）' })
  if (!counts.abaRows) gaps.push({ layer: 'aba', fix: '词库页拉 tracked 词数据（按批计费）' })
  if (!counts.salesRows) gaps.push({ layer: 'sales', fix: 'L2 会带销量；若为空说明 SIF 前台未展示档位' })
  if (!counts.competitorRows) gaps.push({ layer: 'competitor', fix: '竞品页跑一次格局（2 点/词）' })
  if (ageDays !== null && ageDays >= 2) gaps.push({ layer: 'freshness', fix: `数据截止 ${latestData}，已滞后 ${ageDays} 天，重跑一次 L1` })

  const coverage = {
    traffic: asins.length ? perAsin.filter(item => item.layers.traffic > 0).length / asins.length : 0,
    keywords: asins.length ? perAsin.filter(item => item.layers.keywords > 0).length / asins.length : 0,
    sales: asins.length ? perAsin.filter(item => item.layers.sales > 0).length / asins.length : 0,
    ads: asins.length ? perAsin.filter(item => item.layers.ads > 0).length / asins.length : 0,
  }

  return {
    marketplace,
    counts,
    latestData,
    ageDays,
    perAsin,
    gaps,
    coverage,
    ok: gaps.filter(gap => gap.layer !== 'freshness').length === 0,
  }
}

function esc(value) {
  return String(value).replace(/'/g, "''")
}

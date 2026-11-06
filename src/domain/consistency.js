/**
 * 数据对账：拿「原始返回」和「摊平后的表」逐项比数量。
 *
 * 为什么需要它：报告里的每个数字都来自摊平表，而摊平表是 importer 写的。
 * 如果 importer 少写了几周，页面不会报错、报告也不会有异常字样——只是数字偏小。
 * 这里是唯一能发现「静默丢数」的地方：raw 里 10 周，表里也必须 10 行。
 */
export function checkConsistency(store, { marketplace = 'US' } = {}) {
  const checks = []

  // 1) 流量：最新一次 raw 的 dates 数量 == 表里该 ASIN 的周行数（同周期类型）
  const trafficRaw = store.all(
    `SELECT id, tool, params_json, response_json, fetched_at FROM sif_raw
     WHERE tool = 'ops_get_asin_traffic_trend' ORDER BY id DESC LIMIT 20`)
  const seenAsin = new Set()
  for (const raw of trafficRaw) {
    let payload
    let params
    try {
      payload = JSON.parse(raw.response_json)
      params = JSON.parse(raw.params_json)
    } catch {
      continue
    }
    const asin = params?.asin
    if (!asin || seenAsin.has(asin)) continue
    seenAsin.add(asin)
    const dates = Array.isArray(payload?.dates) ? payload.dates : []
    // 按「唯一周」比：SIF 偶尔会返回重复周（实测 ABA 有重复日期），
    // 表里是主键去重后的行数，拿 length 直接比会误报。
    const unique = new Set(dates).size
    const expected = unique
    const actual = Number(store.get(
      `SELECT COUNT(*) AS n FROM sif_traffic WHERE marketplace = ? AND asin = ? AND period_type = 'week'`,
      [marketplace, asin])?.n ?? 0)
    const duplicates = dates.length - unique
    checks.push({
      layer: 'traffic',
      object: asin,
      expected,
      actual,
      duplicatedWeeks: duplicates,
      status: expected === actual ? 'ok' : 'mismatch',
      note: expected === actual
        ? (duplicates ? `raw 有 ${duplicates} 条重复周，已按唯一周入库` : '')
        : `raw 唯一周 ${expected}，表里只有 ${actual} 行 —— 可能有周被覆盖或漏写`,
    })
  }

  // 2) 关键词：最新一次 keyword_signals 的 top_keywords 数量 == 表里该 ASIN/窗口的行数
  const kwRaw = store.all(
    `SELECT id, params_json, response_json FROM sif_raw
     WHERE tool = 'market_get_asin_keyword_signals' ORDER BY id DESC LIMIT 20`)
  const seenKw = new Set()
  for (const raw of kwRaw) {
    let payload
    let params
    try {
      payload = JSON.parse(raw.response_json)
      params = JSON.parse(raw.params_json)
    } catch {
      continue
    }
    const asin = params?.asin
    if (!asin || seenKw.has(asin)) continue
    seenKw.add(asin)
    const expected = Array.isArray(payload?.top_keywords) ? payload.top_keywords.length : 0
    const actual = Number(store.get(
      `SELECT COUNT(*) AS n FROM sif_asin_keyword WHERE marketplace = ? AND asin = ? AND period_type = 'lately'`,
      [marketplace, asin])?.n ?? 0)
    checks.push({
      layer: 'keywords',
      object: asin,
      expected,
      actual,
      status: expected === actual ? 'ok' : 'mismatch',
      note: expected === actual ? '' : `raw 返回 ${expected} 个词，表里 ${actual} 行`,
    })
  }

  // 3) ABA：某个词最新一次 history 的 dates 数量 == 表里该词的行数
  const abaRaw = store.all(
    `SELECT id, params_json, response_json FROM sif_raw
     WHERE tool = 'market_get_keyword_history' ORDER BY id DESC LIMIT 20`)
  const seenAba = new Set()
  for (const raw of abaRaw) {
    let payload
    let params
    try {
      payload = JSON.parse(raw.response_json)
      params = JSON.parse(raw.params_json)
    } catch {
      continue
    }
    for (const item of payload?.keywords ?? []) {
      const keyword = String(item?.keyword ?? '').toLowerCase()
      if (!keyword || seenAba.has(keyword)) continue
      seenAba.add(keyword)
      const dates = Array.isArray(item.dates) ? item.dates : []
      const unique = new Set(dates).size   // 同上：按唯一周比，SIF 原始数据里有重复周
      const expected = unique
      const actual = Number(store.get(
        `SELECT COUNT(*) AS n FROM sif_keyword_aba WHERE marketplace = ? AND keyword = ?`,
        [marketplace, keyword])?.n ?? 0)
      const duplicates = dates.length - unique
      checks.push({
        layer: 'aba',
        object: keyword,
        expected,
        actual,
        duplicatedWeeks: duplicates,
        status: expected === actual ? 'ok' : 'mismatch',
        note: expected === actual
          ? (duplicates ? `raw 有 ${duplicates} 条重复周，已按唯一周入库` : '')
          : `raw 唯一周 ${expected}，表里 ${actual} 行`,
      })
    }
  }

  const mismatches = checks.filter(item => item.status === 'mismatch')
  return {
    marketplace,
    checkedAt: new Date().toISOString(),
    total: checks.length,
    ok: checks.length - mismatches.length,
    mismatches: mismatches.length,
    checks,
    verdict: checks.length === 0
      ? '还没有可对账的原始数据（先同步一次）'
      : mismatches.length === 0
        ? `全部 ${checks.length} 项对得上：raw 与表数量一致`
        : `${mismatches.length}/${checks.length} 项对不上，见明细`,
  }
}

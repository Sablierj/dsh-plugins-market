/**
 * SIF 返回值 → 本地行的规范化。这里只做「形状」转换，不做业务判断。
 *
 * 三件事必须做对，否则后面全是脏数据：
 *   1. `asin` 字段返回的是 markdown 链接（`[B0…](https://…)`），要剥壳；
 *   2. 数据截止日藏在 `data_notice` 的散文里（"Data updated through 2026-11-04 …"）；
 *   3. 自然位是字符串 `"p2,11/48"`（第 2 页第 11 位 / 共 48 位）。
 */

export function stripAsin(value) {
  const text = String(value ?? '').trim()
  const match = /\[([A-Z0-9]{10})\]\(/.exec(text)
  if (match) return match[1]
  if (/^[A-Z0-9]{10}$/.test(text)) return text
  return text.toUpperCase()
}

export function parseDataDate(notice) {
  const match = /through (\d{4}-\d{2}-\d{2})/.exec(String(notice ?? ''))
  return match ? match[1] : null
}

export function parseRank(raw) {
  if (raw === null || raw === undefined) return { page: null, pos: null, total: null }
  const text = String(raw)
  // p2,11/48
  const paged = /p(\d+),(\d+)\/(\d+)/.exec(text)
  if (paged) return { page: Number(paged[1]), pos: Number(paged[2]), total: Number(paged[3]) }
  // 12/48 或 12
  const bare = /(?:^|[^\d])(\d+)(?:\/(\d+))?$/.exec(text)
  if (bare) return { page: null, pos: Number(bare[1]), total: bare[2] ? Number(bare[2]) : null }
  return { page: null, pos: null, total: null }
}

/** `ops_get_asin_traffic_trend` 的平行数组 → 一行一周。 */
export function trafficRowsFromTrend(payload, { marketplace, asin, scope = 'listing', periodType = 'week', fetchedAt }) {
  const dates = Array.isArray(payload?.dates) ? payload.dates : []
  const pick = (list, index) => (Array.isArray(list) ? list[index] : null) ?? null
  const dataDate = parseDataDate(payload?.data_notice)
  const rows = []
  for (let i = 0; i < dates.length; i += 1) {
    const total = pick(payload.totalScore, i) ?? {}
    const nf = pick(payload.nfScore, i) ?? {}
    const ad = pick(payload.adScore, i) ?? {}
    const sp = pick(payload.spScore, i) ?? {}
    const sb = pick(payload.sbScore, i) ?? {}
    const sbv = pick(payload.sbvScore, i) ?? {}
    rows.push({
      marketplace,
      asin,
      scope,
      periodType,
      periodStart: dates[i],
      totalScore: total.score ?? null,
      nfScore: nf.score ?? null,
      adScore: ad.score ?? null,
      spScore: sp.score ?? null,
      recSpScore: null, // 该工具不单列 SP 推荐，渠道级拆解看 listing overview
      sbScore: sb.score ?? null,
      sbvScore: sbv.score ?? null,
      totalChange: total.scoreChange ?? null,
      totalChangeRatio: total.scoreChangeRatio ?? null,
      nfRatio: nf.scoreRatio ?? null,
      adRatio: ad.scoreRatio ?? null,
      isComplete: i === dates.length - 1 ? null : 1, // 末点是否跑完未知，存 NULL 而不是猜 1
      tool: 'ops_get_asin_traffic_trend',
      fetchedAt,
      dataDate,
    })
  }
  return rows
}

/** `ops_get_listing_traffic_overview` 的嵌套渠道 → 一行 + 原始 JSON。 */
export function overviewRow(payload, { marketplace, asin, windowType = 'latelyDay', windowValue = '7', fetchedAt }) {
  const overview = payload?.overview ?? {}
  return {
    marketplace,
    asin,
    windowType,
    windowValue,
    totalScore: payload?.total ?? null,
    nfRatio: overview?.nf?.ratio ?? null,
    adRatio: overview?.ad?.ratio ?? null,
    payload,
    dataDate: parseDataDate(payload?.data_notice),
    fetchedAt,
  }
}

/**
 * 规则引擎：把库里的数字变成「能派活」的结论。
 *
 * 每条结论都必须带 evidence（哪几周、哪个词、差几位），因为运营要能回查，
 * 模型也要能引用。**没有证据就不产出结论**（比如数据不足时只给 no_data，不猜）。
 */
const SEVERITY = { high: 0, medium: 1, low: 2 }

export function computeInsights(store, { marketplace, asin }) {
  const out = []
  const weeks = store.all(
    `SELECT period_start, total_score, nf_score, ad_score, ad_ratio, total_change_ratio
     FROM sif_traffic WHERE marketplace = ? AND asin = ? AND period_type = 'week'
     ORDER BY period_start DESC LIMIT 8`, [marketplace, asin])

  if (weeks.length === 0) {
    out.push({
      kind: 'no_data',
      severity: 'medium',
      title: '这个 ASIN 还没有流量数据',
      evidence: { asin },
      suggestion: '先在「同步」页跑一次 L1（5 点）',
    })
    return sort(out)
  }

  // 1) 广告依赖：近 4 周里 ≥2 周广告占比 ≥60%
  const recent4 = weeks.slice(0, 4)
  const dependent = recent4.filter(week => (week.ad_ratio ?? 0) >= 0.6)
  if (dependent.length >= 2) {
    const avg = dependent.reduce((sum, week) => sum + (week.ad_ratio ?? 0), 0) / dependent.length
    out.push({
      kind: 'ad_dependency',
      severity: 'high',
      title: `广告依赖：近 4 周有 ${dependent.length} 周广告占比 ≥60%（均值 ${(avg * 100).toFixed(1)}%）`,
      evidence: { weeks: dependent.map(w => ({ period_start: w.period_start, ad_ratio: w.ad_ratio })) },
      suggestion: '先别加预算。把最差的 ad group 停掉、预算挪给已带量的自然词，观察自然分是否补位。',
    })
  }

  // 2) 下滑是「广告刹车」还是「自然位掉了」
  const latest = weeks[0]
  const prev = weeks[1] ?? null
  if (prev && (latest.total_change_ratio ?? 0) <= -0.25) {
    const nfDrop = ratio(latest.nf_score, prev.nf_score)
    const adDrop = ratio(latest.ad_score, prev.ad_score)
    const adLed = adDrop !== null && nfDrop !== null && Math.abs(adDrop) > Math.abs(nfDrop) * 1.5
    out.push({
      kind: adLed ? 'drop_ad_led' : 'drop_real',
      severity: 'high',
      title: adLed
        ? `本周流量 ${pct(latest.total_change_ratio)}，主因是广告掉量（广告 ${pct(adDrop)}，自然 ${pct(nfDrop)}）`
        : `本周流量 ${pct(latest.total_change_ratio)}，自然分同步下滑（自然 ${pct(nfDrop)}，广告 ${pct(adDrop)}）`,
      evidence: {
        period_start: latest.period_start,
        total_change_ratio: latest.total_change_ratio,
        nf_score: latest.nf_score,
        prev_nf_score: prev.nf_score,
        ad_score: latest.ad_score,
        prev_ad_score: prev.ad_score,
      },
      suggestion: adLed
        ? '先查广告结构（预算/竞价/否词），Listing 不要动。'
        : '自然位在掉：查头词排名与竞品动作，别只加广告补量。',
    })
  }

  // 3) 缺口：已带量但没进首页的词（需要 L2 的关键词数据）
  const gaps = store.all(
    `SELECT keyword, traffic_share, organic_page, organic_pos, organic_total, gap_severity
     FROM sif_asin_keyword
     WHERE marketplace = ? AND asin = ? AND traffic_share >= 0.05
       AND organic_page IS NOT NULL AND organic_page >= 2
     ORDER BY traffic_share DESC LIMIT 5`, [marketplace, asin])
  if (gaps.length) {
    const top = gaps[0]
    out.push({
      kind: 'kw_gap',
      severity: top.gap_severity === 'severe' ? 'high' : 'medium',
      title: `${gaps.length} 个带量词没进首页；最重的「${top.keyword}」占 ${(top.traffic_share * 100).toFixed(1)}% 流量，在第 ${top.organic_page} 页第 ${top.organic_pos} 位`,
      evidence: { gaps },
      suggestion: '给这些词单独开精确/词组，并把词埋进 Listing 标题与五点；按周看位置变化。',
    })
  }

  // 4) 数据陈旧：最新一周的数据截止日落后
  const dataDate = store.get(
    `SELECT MAX(data_date) AS d FROM sif_traffic WHERE marketplace = ? AND asin = ?`, [marketplace, asin])?.d
  if (dataDate) {
    const ageDays = Math.floor((Date.now() - Date.parse(dataDate + 'T00:00:00Z')) / 86_400_000)
    if (ageDays >= 2) {
      out.push({
        kind: 'data_stale',
        severity: 'low',
        title: `数据截止 ${dataDate}，已滞后 ${ageDays} 天`,
        evidence: { data_date: dataDate, age_days: ageDays },
        suggestion: 'SIF 侧是 T-1 更新；如果持续落后，先确认密钥配额与工具是否正常返回。',
      })
    }
  }

  return sort(out)
}

function ratio(current, previous) {
  if (current === null || previous === null || previous === 0 || previous === undefined) return null
  return (current - previous) / previous
}

function pct(value) {
  if (value === null || value === undefined) return '—'
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`
}

function sort(list) {
  return list.sort((a, b) => (SEVERITY[a.severity] ?? 9) - (SEVERITY[b.severity] ?? 9))
}

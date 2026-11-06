/**
 * 今日待办：把「洞察 + 词库 + 格局」压成一张排序过的行动清单。
 *
 * 资深运营看的不是「有多少指标」，而是「今天先动哪一件」。所以这里做三件事：
 *   1. 每条动作都带**影响面**（该词占总流量多少、差几位进首页、距旺季几周）——不编造绝对增量；
 *   2. 排序用「影响面 × 严重度」，不是按时间；
 *   3. 每条只给一个动词（冲位/收预算/补位/铺词/观望），不给模棱两可的「关注一下」。
 */
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 }

export function buildActions(store, { marketplace = 'US', asin } = {}) {
  const actions = []

  const traffic = store.all(
    `SELECT period_start, total_score, nf_score, ad_score, nf_ratio, ad_ratio, total_change_ratio
     FROM sif_traffic WHERE marketplace = ? AND asin = ? AND period_type = 'week'
     ORDER BY period_start DESC LIMIT 4`, [marketplace, asin])
  const latest = traffic[0] ?? null
  const previous = traffic[1] ?? null

  // 1) 缺口词：已带量但没进首页 —— 运营最该动的就是这一类
  const gaps = store.all(
    `SELECT keyword, traffic_share, organic_page, organic_pos, organic_total, gap_severity
     FROM sif_asin_keyword
     WHERE marketplace = ? AND asin = ? AND traffic_share >= 0.03
       AND organic_page IS NOT NULL AND organic_page >= 2
     ORDER BY traffic_share DESC LIMIT 5`, [marketplace, asin])
  for (const gap of gaps) {
    const share = gap.traffic_share ?? 0
    const positions = gap.organic_total && gap.organic_pos ? (gap.organic_total - gap.organic_pos + 1) : null
    actions.push({
      kind: 'push_rank',
      verb: '冲位',
      priority: score(SEVERITY_WEIGHT[gap.gap_severity] ?? 2, share),
      title: `把「${gap.keyword}」从第 ${gap.organic_page} 页推到首页`,
      detail: `该词占总流量 ${(share * 100).toFixed(1)}%，现在 p${gap.organic_page} 第 ${gap.organic_pos ?? '?'} 位`
        + (positions ? `，页面内还有 ${positions} 位` : '') + '。',
      impact: { trafficShare: share, page: gap.organic_page, pos: gap.organic_pos, gapSeverity: gap.gap_severity },
      action: '该词单开精确/词组 + 把词埋进标题与五点；按周看位置，别只看广告 ACOS。',
    })
  }

  // 1b) 连前 3 页都没进的高份额词 —— 这是最贵的一类问题：
  //     SIF 只告诉我们「没进前 3 页」，但我们知道它占了多大流量，所以按「补位」提出来。
  const unranked = store.all(
    `SELECT keyword, traffic_share, organic_rank_raw
     FROM sif_asin_keyword
     WHERE marketplace = ? AND asin = ? AND traffic_share >= 0.15 AND organic_page IS NULL
     ORDER BY traffic_share DESC LIMIT 3`, [marketplace, asin])
  for (const word of unranked) {
    const share = word.traffic_share ?? 0
    actions.push({
      kind: 'push_unranked',
      verb: '补位',
      priority: score(SEVERITY_WEIGHT.high, share),
      title: `「${word.keyword}」占 ${(share * 100).toFixed(1)}% 流量，却连前 3 页都没进`,
      detail: '最大的单一流量来源，却拿不到自然位——通常是词没埋进去，或相关性对不上，不是预算问题。',
      impact: { trafficShare: share, ranked: false },
      action: '先核对标题 / 五点 / 后台搜索词是否含这个词，再开精确匹配验证相关性；位置比出价重要。',
    })
  }

  // 2) 广告依赖
  const dependent = traffic.filter(week => (week.ad_ratio ?? 0) >= 0.6)
  if (dependent.length >= 2) {
    const avg = dependent.reduce((sum, week) => sum + week.ad_ratio, 0) / dependent.length
    actions.push({
      kind: 'cut_ad',
      verb: '收预算',
      priority: score(SEVERITY_WEIGHT.high, avg),
      title: `广告依赖：近 ${traffic.length} 周有 ${dependent.length} 周广告占比 ≥60%（均值 ${(avg * 100).toFixed(1)}%）`,
      detail: '自然位没起来时加预算只会把占比推得更高，先把钱停在没有自然位支撑的广告组。',
      impact: { adRatio: avg, weeks: dependent.map(week => week.period_start) },
      action: '停最差的 ad group → 预算挪给已带量的自然词 → 观察自然分是否补位。',
    })
  }

  // 3) 急跌
  if (previous && (latest?.total_change_ratio ?? 0) <= -0.25) {
    const nfDrop = delta(latest.nf_score, previous.nf_score)
    const adDrop = delta(latest.ad_score, previous.ad_score)
    const adLed = nfDrop !== null && adDrop !== null && Math.abs(adDrop) > Math.abs(nfDrop) * 1.5
    actions.push({
      kind: adLed ? 'check_ads' : 'check_rank',
      verb: adLed ? '查广告' : '查排名',
      priority: score(SEVERITY_WEIGHT.high, Math.abs(latest.total_change_ratio)),
      title: `本周流量 ${signed(latest.total_change_ratio)}（${latest.period_start}）`,
      detail: adLed
        ? `广告 ${signed(adDrop)}、自然 ${signed(nfDrop)} —— 掉的是广告，不是自然位。`
        : `自然 ${signed(nfDrop)}、广告 ${signed(adDrop)} —— 自然位在掉，别只加广告补量。`,
      impact: { nfDrop, adDrop, totalChange: latest.total_change_ratio },
      action: adLed ? '先看预算/竞价/否词三件事，Listing 不要动。' : '看头词排名与竞品动作，必要时花 10 点做一次根因诊断。',
    })
  }

  // 4) 旺季窗口：词库里 <=12 周进入旺季的词，现在铺是最便宜的
  const nearPeak = store.all(
    `SELECT k.keyword, d.weeks_to_peak, d.diagnosis, d.action_hint, d.season_position
     FROM sif_keyword k
     JOIN sif_keyword_demand d ON d.marketplace = k.marketplace AND d.keyword = k.keyword
     WHERE k.marketplace = ? AND k.status = 'tracked'
       AND d.weeks_to_peak IS NOT NULL AND d.weeks_to_peak <= 12
     ORDER BY d.weeks_to_peak ASC LIMIT 5`, [marketplace])
  for (const word of nearPeak) {
    actions.push({
      kind: 'season_window',
      verb: '铺词',
      priority: score(2, 1 / Math.max(1, word.weeks_to_peak)),
      title: `旺季窗口：「${word.keyword}」还有 ${word.weeks_to_peak} 周进旺季`,
      detail: `${word.diagnosis ?? ''}${word.season_position ? `（季节位置：${word.season_position}）` : ''}`.trim(),
      impact: { weeksToPeak: word.weeks_to_peak, diagnosis: word.diagnosis },
      action: word.action_hint ?? '现在铺自然位，旺季靠自然流量收割。',
    })
  }

  // 5) 格局机会：集中度低 + 转化分散 → 强产品可切
  const snapshot = store.get(
    `SELECT keyword, concentration_level, top3_click_share, top3_conversion_share, divergence
     FROM sif_market_snapshot WHERE marketplace = ?
     ORDER BY observed_at DESC LIMIT 1`, [marketplace])
  if (snapshot && snapshot.divergence === 'diverging') {
    actions.push({
      kind: 'market_entry',
      verb: '观望',
      priority: score(2, 0.5),
      title: `「${snapshot.keyword}」出现点击-转化背离，存在切入窗口`,
      detail: `Top3 点击 ${pct(snapshot.top3_click_share)}、转化 ${pct(snapshot.top3_conversion_share)}，`
        + '点击被位置锁住、成交更分散。',
      impact: { top3Click: snapshot.top3_click_share, top3Conversion: snapshot.top3_conversion_share },
      action: '先用一款强卖点产品试切入（差异化主图/价格带），别用它打价格战。',
    })
  }

  if (!actions.length) {
    actions.push({
      kind: 'watch',
      verb: '观望',
      priority: 0,
      title: '没有触发任何阈值',
      detail: '流量、结构、词库都在历史区间内。',
      impact: {},
      action: '保持节拍：每天 L1、每周 L2、每月词库体检。',
    })
  }

  return actions.sort((a, b) => b.priority - a.priority)
}

function score(severity, weight) {
  return Number((severity * (1 + Math.min(2, Math.abs(weight ?? 0)))).toFixed(3))
}

function delta(current, previous) {
  if (current === null || current === undefined || !previous) return null
  return (current - previous) / previous
}

function signed(value) {
  return value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`
}

function pct(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

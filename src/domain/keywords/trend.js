/**
 * 搜索量趋势 —— 逐月累积的**唯一回报**。
 *
 * ## 为什么必须现在做
 *
 * ABA 事实表里已经躺着 **7 个周期**（2025-Q1…2026-03），其中 2,596 个词有 ≥2 期、
 * 1,696 个词有 ≥3 期。但 `composeMaster` 只取 `newestAba` 一条 —— **趋势算得出来，
 * 却从来没算过**。每个月再导一份，被丢掉的只会更多。
 *
 * ## 口径
 *
 * 周期标签有两种写法：`2025-Q1`（季报）与 `2026-03`（月报）。把它们折成同一个
 * 数值键才能排序：季 → 3/6/9/12 月，于是 `2025-Q4` = 202512、`2026-01` = 202601，
 * 天然可比。**不把季报和月报混成一个"期数"**：一个季度抵三个月，混着算环比会把
 * 「Q4 → 1 月」当成一次普通环比，那不是一个月的变化。
 *
 * 所以环比只跟**紧邻的前一期**比，并在结果里写明两期各是什么，让人能自己判断
 * "这是月环比还是季环比"。
 */

/** 把 `2025-Q3` / `2026-03` 折成可比较的数值键（年*100 + 月）。 */
export function periodKey(period) {
  const text = String(period ?? '').trim()
  const quarter = /^(\d{4})-?Q([1-4])$/i.exec(text)
  if (quarter !== null) return Number(quarter[1]) * 100 + Number(quarter[2]) * 3
  const month = /^(\d{4})-?(\d{2})$/.exec(text)
  if (month !== null) {
    const mm = Number(month[2])
    if (mm >= 1 && mm <= 12) return Number(month[1]) * 100 + mm
  }
  return null
}

/** 环比超过这个幅度才算涨/跌，否则算平。±15% 是经验值，不是定理。 */
const TREND_THRESHOLD_PCT = 15

/**
 * 从**全部** ABA 事实算趋势。
 *
 * @param {Array<{period: string, searchVolume: number|null, score: number|null}>} history
 * @returns {{trend: string, periods: number, latest: string|null, previous: string|null,
 *            svLatest: number|null, svPrev: number|null, momPct: number|null,
 *            avg: number|null, basis: object}}
 */
export function abaTrend(history = []) {
  const usable = []
  for (const row of history ?? []) {
    const key = periodKey(row?.period)
    if (key === null) continue
    const volume = Number(row?.searchVolume)
    usable.push({
      period: String(row.period),
      key,
      volume: Number.isFinite(volume) ? volume : null,
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
    })
  }
  usable.sort((a, b) => a.key - b.key)

  const empty = {
    trend: 'insufficient',
    periods: usable.length,
    latest: null,
    previous: null,
    svLatest: null,
    svPrev: null,
    momPct: null,
    avg: null,
    basis: { reason: 'no-aba-history' },
  }
  if (usable.length === 0) return empty

  const latest = usable[usable.length - 1]
  const previous = usable.length >= 2 ? usable[usable.length - 2] : null

  /* 只拿有搜索量的期来算均值：ABA 有的期会缺数量（该词那期没进榜），
     把 null 当 0 会把均值压低，看起来像"跌了"。 */
  const withVolume = usable.filter(row => row.volume !== null)
  const avg = withVolume.length === 0
    ? null
    : Math.round(withVolume.reduce((sum, row) => sum + row.volume, 0) / withVolume.length)

  const svLatest = latest.volume
  const svPrev = previous?.volume ?? null
  const momPct = svLatest !== null && svPrev !== null && svPrev > 0
    ? Math.round(((svLatest - svPrev) / svPrev) * 1000) / 10
    : null

  let trend = 'insufficient'
  if (momPct !== null) {
    if (momPct >= TREND_THRESHOLD_PCT) trend = 'rising'
    else if (momPct <= -TREND_THRESHOLD_PCT) trend = 'falling'
    else trend = 'flat'
  } else if (svLatest !== null) {
    /* 只有一期：没法说趋势，但也不该说"不知道" —— 说清楚只有一期。 */
    trend = 'single-period'
  }

  return {
    trend,
    periods: usable.length,
    latest: latest.period,
    previous: previous?.period ?? null,
    svLatest,
    svPrev,
    momPct,
    avg,
    basis: {
      thresholdPct: TREND_THRESHOLD_PCT,
      periodsUsed: usable.map(row => row.period),
      note: '环比只与紧邻前一期比；季报与月报不混算',
    },
  }
}

/** 一句话结论，页面与导出共用。 */
export const TREND_MEANING = {
  rising: '比上一期涨了 15% 以上',
  falling: '比上一期跌了 15% 以上',
  flat: '与上一期相差不到 15%',
  'single-period': '只有一期数据，判断不了趋势',
  insufficient: '没有可用的历史期',
}

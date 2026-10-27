/**
 * P2-2 健康卡片的趋势：这一期比上一期好还是坏。
 *
 * ## 口径先说清（这是这个模块唯一的难点）
 *
 * 六张卡片现在的数字是「**近 30 天**」（`WINDOW_DAYS = 30`）。所以趋势**不能**拿
 * 「本周 vs 上周」来比 —— 那会让主数值与对比值落在两个不同的窗口上，
 * 读起来像"涨了"，其实只是窗口变短了。
 *
 * 这里的做法：**保持主数值的窗口不变，把同一个 `build` 跑在紧挨着的前一个等长窗口上**
 * （30–60 天前）。于是：
 *
 *   · 主数值 = 近 30 天
 *   · 对比值 = 前 30 天（30–60 天前）
 *   · 两者**由同一个函数算出**，所以不可能出现两套口径
 *
 * ## 三种「算不出趋势」，各自给原因
 *
 * ① 卡片本身是 `empty`（分母为 0）→ 没有比率可比；
 * ② 上一周期分母为 0 → 上一期"没有可观测的对象"，与"0%"不是一回事；
 * ③ 卡片 `error` → 它连自己的数都算不出来。
 *
 * **任何一项算不出来，趋势就是 `null` + 原因，不是 0、不是"持平"。**
 * "持平"是一个结论，"不知道"是另一个结论，把后者写成前者是本仓反复拒绝的错。
 */

/** 比率本身：分母为 0 时返回 null（不是 0）。 */
function ratioOf(card) {
  if (card === null || card === undefined) return null
  const numerator = Number(card.numerator)
  const denominator = Number(card.denominator)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null
  if (denominator === 0) return null
  return numerator / denominator
}

/**
 * 比较同一张卡片的两个周期。
 *
 * @param current 本期卡片（`buildHealthCards` 的那一份）
 * @param previous 上一周期同 id 的卡片
 */
export function trendOf(current, previous) {
  const base = {
    id: current?.id ?? null,
    currentRatio: ratioOf(current),
    previousRatio: ratioOf(previous),
    /** 比率之差（本期 − 上期）。正数=变好，负数=变差。 */
    delta: null,
    /** 相对变化（差值 / 上期）。上期为 0 时无意义，保持 null。 */
    change: null,
    direction: null,
    reason: null,
    /**
     * 这个趋势是否值得报。样本太小时，比率的一点抖动不是信号。
     * 阈值同时看**两边分母**：任一期不足 10 条，就不下"变好/变差"的判断。
     */
    meaningful: false,
  }

  if (current === null || current === undefined) {
    return { ...base, reason: '没有本期卡片 —— 趋势无从谈起' }
  }
  if (current.status === 'error') {
    return { ...base, reason: '本期卡片计算失败，趋势不建立在失败的数上' }
  }
  if (previous === null || previous === undefined) {
    return { ...base, reason: '没有上一周期的卡片（该卡片没有实现窗口参数，或上一期没跑）' }
  }
  if (previous.status === 'error') {
    return { ...base, reason: `上一周期卡片计算失败：${previous.error ?? '原因未记录'}` }
  }

  const now = base.currentRatio
  const then = base.previousRatio

  if (Number(current.denominator) === 0) {
    return { ...base, reason: `本期分母为 0（${current.unit ?? '无可观测对象'}）—— 没有比率可比` }
  }
  if (then === null) {
    return {
      ...base,
      reason: `上一周期分母为 0 —— 上一期「没有可观测的对象」，不是「0%」。`
        + '把这两种情况当成同一个，会让一次首次采集看起来像"改善了 100%"',
    }
  }

  const delta = now - then
  const change = then === 0 ? null : delta / then
  const direction = Math.abs(delta) < 1e-9 ? 'flat' : (delta > 0 ? 'up' : 'down')

  /* 样本量门槛：任一期少于 10 条时，"变好/变差"多半是抖动。 */
  const SAMPLE_FLOOR = 10
  const smallSample = Number(current.denominator) < SAMPLE_FLOOR || Number(previous.denominator) < SAMPLE_FLOOR

  return {
    ...base,
    delta: Math.round(delta * 10000) / 10000,
    change: change === null ? null : Math.round(change * 10000) / 10000,
    direction,
    meaningful: !smallSample,
    reason: smallSample
      ? `样本太小（本期 ${current.denominator} 条 / 上期 ${previous.denominator} 条，门槛 ${SAMPLE_FLOOR}）`
        + ' —— 比值会抖，不据此判断变好还是变差'
      : null,
  }
}

/** 一句话描述，供页面直接显示。 */
export function describeTrend(trend) {
  if (trend === null || trend === undefined) return '趋势：不知道'
  if (trend.reason !== null) return `趋势：不知道 —— ${trend.reason}`
  const pct = (value) => `${(value * 100).toFixed(1)}%`
  const arrow = trend.direction === 'up' ? '↑' : (trend.direction === 'down' ? '↓' : '→')
  const from = pct(trend.previousRatio)
  const to = pct(trend.currentRatio)
  if (trend.direction === 'flat') return `趋势：持平（${from} → ${to}，前 30 天 → 近 30 天）`
  return `趋势：${arrow} ${from} → ${to}（前 30 天 → 近 30 天，${trend.delta > 0 ? '+' : ''}${(trend.delta * 100).toFixed(1)} 个百分点）`
}

/**
 * 六张卡片 + 各自趋势。
 *
 * ## 只有 `collection` 真的能有趋势，其余五张不能 —— 这必须说清
 *
 * 逐张核过（`check-card-time.mjs`）：
 *
 *   · `collection` —— 统计「近 30 天完成的任务里成功多少」，**是时间窗口统计**，
 *     可以原样跑在前一个等长窗口上，得到真正可比的上一期。
 *   · `freshness` —— 「**现在**有多少 ASIN 在 7 天内有新快照」。它虽然有 `collected_at`，
 *     但问的是**此刻**的状态；「30 天前那一刻有多少 ASIN 新鲜」本仓没有记录
 *     （没有对卡片结论做历史归档），所以拿不出上一期。
 *   · `fieldComplete` / `keywordCoverage` / `rulePolicyRisk` / `optimizationDraft`
 *     —— 全是当前状态快照，没有时间维度。
 *
 * 所以这里**不假装它们有趋势**：能算的给数，不能算的给原因。
 * 给那五张编一个"上一期"等于凭空造数据。
 *
 * @param buildCards `(window) => cards`，`window` 为 `null` 表示本期。
 *        由调用方注入 —— 趋势必须与主数值走同一个 `buildHealthCards`，
 *        否则就是两套口径。
 * @param trendCapableIds 明确支持窗口参数的卡片 id（目前只有 `collection`）
 */
export function buildHealthTrends(buildCards, { trendCapableIds = ['collection'] } = {}) {
  const capable = new Set(trendCapableIds)
  const current = buildCards(null)
  const previous = buildCards({ offsetDays: 1, days: 30 })
  const byId = new Map((Array.isArray(previous) ? previous : []).map(card => [card.id, card]))

  return (Array.isArray(current) ? current : []).map((card) => {
    if (!capable.has(card.id)) {
      return {
        card,
        trend: {
          id: card.id,
          currentRatio: null,
          previousRatio: null,
          delta: null,
          change: null,
          direction: null,
          meaningful: false,
          reason: `「${card.label}」说的是当前状态（此刻有多少满足条件），不是一段时间内的统计 —— `
            + '本仓没有对这类结论做历史归档，所以没有可比的上一期。给它编一个上一期等于凭空造数。',
        },
      }
    }
    return { card, trend: trendOf(card, byId.get(card.id) ?? null) }
  })
}

/**
 * P1-4 采集耗时对账 —— 预估与实际差多少。
 *
 * ## 为什么这件事值得有
 *
 * `estimateMinutes()` 算出的 `estimatedMinutes` 会出现在采集预览里，运营据此排期。
 * 但**没有人在核对它准不准**：预估写的是 12 分钟，实际跑了 40 分钟，运营当天就废了，
 * 而系统里没有任何地方会告诉他"这个数一直在骗你"。
 *
 * ## 口径（先说清，避免自欺）
 *
 * - **实际耗时** = `finished_at − submitted_at`。这是**任务从提交到结束**的墙钟时间，
 *   包含排队、冷却、等待人工处理 —— 它不等于"浏览器干活的时间"。
 *   拿它跟"纯采集时间"的预估比，本身就会偏大，所以本函数**只报告偏差，不下"预估不准"的结论**。
 * - **预估耗时** = 用同一条 `estimateMinutes(count, pacing)` 按目标的**市场数**重算。
 *   `estimatedMinutes` 在被预览算出来之后**没有落库**（任务行里没这一列），所以只能重算；
 *   重算用的是当前 pacing，**历史 pacing 可能已经改过** —— 这一点必须在输出里标出来。
 * - 目标数从 `targets_json` 数，**去重后**数：同一次提交里重复的 ASIN 只算一次。
 *
 * ## 「算不出来」的四种情况，各自给原因
 *
 * 这个库的规矩是「不知道就说不知道」，所以每个 `null` 都配 `reason`：
 *   ① 没有 `finished_at`（还没跑完 / 老行没写）
 *   ② 时间戳解析不了或结束早于开始（时钟回拨、手改过数据）
 *   ③ `targets_json` 是空数组或读不出来（数不出目标数）
 *   ④ 样本量为 0（一条已完成的都没有）
 */

/**
 * 刻意**不在这里提供默认 pacing**，而是要求调用方传真实的。
 *
 * 我第一版在这里编了一份 `{ perTargetSec, longBreakSec }` —— 而 `estimateMinutes`
 * 真正读的是 `{ beforeNavigateMs, afterLoadMs, longBreakEvery, longBreakMs }`
 * （`domain/collect/targets.js:126`），且那三个时长是**区间数组**
 * （`sources/pacing.js:19-24` 的 `[1800, 4200]` 这种），不是单值。
 * 编错形状的后果是每次重算都静默走进 `undefined` 算术得出 `NaN`，
 * 然后被下游当成"没有预估"——一套看起来跑通、实际什么都没算的代码。
 *
 * 所以：pacing 必须由调用方给（真实值来自 `resolvePacing()`），缺失就报错。
 */
function requirePacing(pacing) {
  const problems = []
  for (const key of ['beforeNavigateMs', 'afterLoadMs', 'longBreakMs']) {
    const value = pacing?.[key]
    const ok = Array.isArray(value)
      ? value.length > 0 && value.every(v => typeof v === 'number' && Number.isFinite(v))
      : typeof value === 'number' && Number.isFinite(value)
    if (!ok) problems.push(`${key}（应为数字或非空数字数组）`)
  }
  const every = pacing?.longBreakEvery
  if (!(typeof every === 'number' && Number.isFinite(every) && every > 0)) {
    problems.push('longBreakEvery（应为正数）')
  }
  if (problems.length > 0) {
    throw new Error(
      `pacing 不可用：${problems.join('、')} —— 不能编一份默认值代替真实采集参数，`
      + '那会让重算结果默默变成 NaN 而看起来像"没有预估"',
    )
  }
  return pacing
}

function parseIso(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** `targets_json` → 目标数（去重）。读不出来时返回 null，而不是 0。 */
export function countTargets(targetsJson) {
  if (typeof targetsJson !== 'string' || targetsJson.trim() === '') return null
  let parsed
  try {
    parsed = JSON.parse(targetsJson)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const keys = new Set()
  for (const target of parsed) {
    if (target === null || typeof target !== 'object') continue
    const asin = typeof target.asin === 'string' ? target.asin.trim().toUpperCase() : ''
    const market = typeof target.marketplace === 'string' ? target.marketplace.trim().toUpperCase() : ''
    if (asin !== '') keys.add(`${asin}@${market}`)
    else keys.add(JSON.stringify(target))
  }
  return keys.size
}

/**
 * 对一条已完成任务做对账。
 *
 * @param task      任务行（需要有 status / submitted_at / finished_at / targets_json）
 * @param estimate  预估函数 `(count, pacing) => minutes`，由调用方注入，
 *                  这样这里不用重新实现一条口径（**只有一份**预估规则）
 * @param pacing    重算预估用的 pacing
 */
export function reconcileTask(task, { estimate, pacing } = {}) {
  const submittedAt = parseIso(task?.submitted_at)
  const finishedAt = parseIso(task?.finished_at)
  const count = countTargets(task?.targets_json)

  const base = {
    id: task?.id ?? null,
    status: task?.status ?? null,
    targets: count,
    actualMinutes: null,
    estimatedMinutes: null,
    ratio: null,
    deltaMinutes: null,
    reason: null,
  }

  if (finishedAt === null) {
    return { ...base, reason: '没有 finished_at：任务还没跑完，或这是条没有结束时点的老行' }
  }
  if (submittedAt === null) {
    return { ...base, reason: 'submitted_at 缺失或解析不了，算不出起止间隔' }
  }
  if (finishedAt < submittedAt) {
    return { ...base, reason: 'finished_at 早于 submitted_at（时钟回拨或数据被手改过），不拿它算耗时' }
  }
  if (count === null) {
    return { ...base, reason: 'targets_json 读不出目标数（空数组或非法 JSON），算不出预估' }
  }
  if (count === 0) {
    return { ...base, targets: 0, reason: 'targets_json 是空数组：没有目标就没有可比的耗时' }
  }
  if (typeof estimate !== 'function') {
    return { ...base, reason: '调用方没有注入预估函数 —— 这里不自己编一条口径' }
  }

  const actualMinutes = (finishedAt - submittedAt) / 60_000
  let estimatedMinutes
  try {
    estimatedMinutes = Number(estimate(count, requirePacing(pacing)))
  } catch (error) {
    return { ...base, actualMinutes, reason: error.message }
  }
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) {
    return { ...base, actualMinutes, reason: '预估函数返回了不可用的值（≤0 或非数字）' }
  }

  return {
    ...base,
    actualMinutes: Math.round(actualMinutes * 10) / 10,
    estimatedMinutes: Math.round(estimatedMinutes * 10) / 10,
    ratio: Math.round((actualMinutes / estimatedMinutes) * 100) / 100,
    deltaMinutes: Math.round((actualMinutes - estimatedMinutes) * 10) / 10,
    reason: null,
  }
}

/**
 * 一批任务的对账汇总。
 *
 * 刻意**不给"平均偏差"一个数就完事**：
 *   - `comparable` 是真正参与统计的条数，`skipped` 是算不出来的条数 + 原因分布；
 *   - 除平均值外给 `median` —— 一条跑了 10 小时的异常任务能把平均值彻底带歪；
 *   - `overBudgetShare` 回答运营真正关心的问题：**多大概率会超时**。
 */
export function reconcileTasks(tasks, options = {}) {
  const rows = (Array.isArray(tasks) ? tasks : []).map(task => reconcileTask(task, options))
  const comparable = rows.filter(row => row.reason === null)
  const skipped = rows.filter(row => row.reason !== null)

  const reasons = {}
  for (const row of skipped) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1

  if (comparable.length === 0) {
    return {
      count: rows.length,
      comparable: 0,
      skipped: skipped.length,
      skipReasons: reasons,
      meanRatio: null,
      medianRatio: null,
      overBudgetShare: null,
      rows,
      conclusion: rows.length === 0
        ? '没有已完成的任务 —— 一条样本都没有，谈不上预估准不准'
        : `没有一条能对账（${skipped.length} 条都缺数据），结论只能是「不知道」`,
    }
  }

  const ratios = comparable.map(row => row.ratio).sort((a, b) => a - b)
  const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length
  const mid = Math.floor(ratios.length / 2)
  const median = ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid]
  const over = comparable.filter(row => row.ratio > 1).length

  const roundedMean = Math.round(mean * 100) / 100
  const roundedMedian = Math.round(median * 100) / 100
  /* 结论用中位数下 —— 平均值容易被单条异常任务带歪，而运营排期是按"典型情况"排的。 */
  let base
  if (roundedMedian <= 1.0) base = `实际不慢于预估（中位比值 ${roundedMedian}），预估可用作排期基准`
  else if (roundedMedian <= 1.25) base = `实际略慢于预估（中位比值 ${roundedMedian}），排期时留 25% 余量`
  else base = `实际明显慢于预估（中位比值 ${roundedMedian}），按现预估排期会持续误期 —— 需要看重算里漏掉的排队/冷却时间`

  /* 样本量提示。第一版没有这一句，于是 n=1（一个目标、跑了两分钟）也会被
     一本正经地报成「明显慢于预估、会持续误期」—— 那是把一次偶然当成了规律。
     结论再对，n=1 也支撑不起「持续」这个词。 */
  const SMALL_SAMPLE = 3
  const conclusion = comparable.length < SMALL_SAMPLE
    ? `${base}（⚠️ 只有 ${comparable.length} 条可比样本，这个结论还不可信 —— 少于 ${SMALL_SAMPLE} 条时只能当线索）`
    : base

  return {
    count: rows.length,
    comparable: comparable.length,
    skipped: skipped.length,
    skipReasons: reasons,
    meanRatio: roundedMean,
    medianRatio: roundedMedian,
    overBudgetShare: Math.round((over / comparable.length) * 100) / 100,
    rows,
    conclusion,
  }
}

/**
 * 一个采集/关键词任务的进度视图 —— 把 `progress_json` 里已有的数字
 * 补成「人能用来判断还要等多久」的形状。
 *
 * ## 为什么这是一个纯函数，而不是让采集引擎多写几个字段
 *
 * `progress_json` 已经由采集引擎在写（`{ done, total, phase, startedAt, keyword|asin }`），
 * 引擎本身跑了很多测试也承担着真正的风险。**进度是读出来的，不是再写一遍的**：
 * 同一个 `done/total` 派生出来的东西，放在一次干净的投影里，引擎就不用为了
 * 多一个「还剩几分钟」而改一行。
 *
 * ## 三件必须显式说「不知道」的事
 *
 * 这条和本仓的四态纪律是同一件事：**「算不出来」不能被写成 `0`**。
 *
 *   - `total` 是 0 或缺失 → `percent: null`，不是 0%。
 *     「一个目标都没有」和「0% 完成」读起来完全不一样。
 *   - `done` 还是 0、或刚开始没有可用的耗时 → `remainingMinutes: null`，不是 0 分钟。
 *     「马上就好」和「不知道还要多久」是两句相反的话。
 *   - 任务已经结束 → `remainingMinutes: null`，原因写「已结束」。
 *     结束的任务没有「还剩」，把它算成 0 会让页面显示「预计还剩 0 分钟」。
 *
 * 每一个 `null` 都配一条 `*Reason`，这样页面能说「为什么不知道」，
 * 而不是把一个破折号丢给用户。
 */

/** 这些状态说明任务不会再动了，所以「还剩多少」在这里没有意义。 */
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'partial'])

/** 分钟数保留整数并向上取整：宁可多等一分钟，也不要说「还剩 0 分钟」然后继续等。 */
function minutesBetween(fromIso, toIso) {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  const ms = to - from
  if (ms < 0) return null
  return ms / 60_000
}

/**
 * 数字或 null —— **绝不让 `Number(null) === 0` 把「不知道」变成 0**。
 *
 * 这不是洁癖：写成 `Number.isFinite(Number(x)) ? Number(x) : null` 时，
 * `x === null` / `x === undefined` 都会先变成 `0`，于是「引擎没记失败数」
 * 会被读成「失败 0 个」——正好是这套代码最该防的那类静默错误。
 * 测试 ⑦ 第一次跑就是被这个坑红的。
 */
function toCountOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 把一条任务的 `progress` 变成视图。
 *
 * @param progress  `progress_json` 解析后的对象，或 null
 * @param status    任务状态（`queued` / `running` / `done` / `failed` / …）
 * @param submittedAt  入参兜底：`progress.startedAt` 缺失时用它当起点
 * @param finishedAt   已结束任务的终点；缺省时用 now
 * @param now        ISO 字符串，注入而不是内部取 `Date.now()`，测试才能确定
 */
export function progressView(progress, { status = null, submittedAt = null, finishedAt = null, now } = {}) {
  const at = typeof now === 'string' && now !== '' ? now : new Date().toISOString()
  const source = progress !== null && typeof progress === 'object' ? progress : null

  if (source === null) {
    return {
      known: false,
      reason: '任务行上没有 progress_json —— 这个任务还没开始记进度（排队中的老行也可能是这个形状）',
      done: null, total: null, percent: null,
      phase: null, elapsedMinutes: null,
      remainingMinutes: null, remainingReason: null,
      startedAt: null, failures: null, failuresReason: null,
    }
  }

  const done = toCountOrNull(source.done)
  const total = toCountOrNull(source.total)

  /* 百分比：total 不可用就是 null。「没有目标」不是「0%」。 */
  const percent = total !== null && total > 0 && done !== null
    ? Math.min(100, Math.max(0, Math.round((done / total) * 100)))
    : null

  const startedAt = typeof source.startedAt === 'string' && source.startedAt !== ''
    ? source.startedAt
    : (typeof submittedAt === 'string' && submittedAt !== '' ? submittedAt : null)

  const terminal = typeof status === 'string' && TERMINAL.has(status)
  const endIso = finishedAt !== null && finishedAt !== undefined && finishedAt !== '' ? finishedAt : at
  const elapsedMinutes = startedAt === null ? null : minutesBetween(startedAt, endIso)

  let remainingMinutes = null
  let remainingReason = null
  if (terminal) {
    remainingReason = `任务已结束（${status}），没有「还剩多少」`
  } else if (done === null || total === null) {
    remainingReason = 'progress 里没有 done / total，算不出速率'
  } else if (done <= 0) {
    remainingReason = '还没有完成任何目标，算不出每个目标要多久'
  } else if (elapsedMinutes === null || elapsedMinutes <= 0) {
    remainingReason = '刚开始，还没有可用的耗时'
  } else if (done >= total) {
    remainingMinutes = 0
  } else {
    const perItem = elapsedMinutes / done
    remainingMinutes = Math.max(1, Math.ceil(perItem * (total - done)))
  }

  /* 失败数：引擎只在部分写入里带了 `failed` / `blocked`。没有就是 null，
     不去拿「done 与 total 的差」冒充失败 —— 差值是「还没做」，不是「失败了」。 */
  const rawFailed = source.failed ?? source.blocked ?? null
  const failures = toCountOrNull(rawFailed)
  const failuresReason = failures === null
    ? 'progress_json 没有逐目标失败计数（要这个数字得让采集引擎写，本函数不去猜）'
    : null

  return {
    known: true,
    reason: null,
    done,
    total,
    percent,
    phase: typeof source.phase === 'string' ? source.phase : null,
    elapsedMinutes: elapsedMinutes === null ? null : Math.round(elapsedMinutes),
    remainingMinutes,
    remainingReason,
    startedAt,
    failures,
    failuresReason,
  }
}

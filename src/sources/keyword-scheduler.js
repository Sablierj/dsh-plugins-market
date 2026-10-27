/**
 * 排班计时器 —— 让「每周日 12:00」真的会自己跑。
 *
 * ## 为什么要有它
 *
 * `collection_plan` / `keyword_plan` 那些表只存**规则**，从不触发：窗口是在"有人提交"
 * 的那一刻才被判断。要做周期扫描，必须有一个真的在跑的计时器。
 *
 * 计时器放在插件进程里（`setInterval` 每分钟），唯一的依赖是 Host 还活着 ——
 * 这与"打开页面才检查"有本质区别：后者没人看的时候永远不跑。
 *
 * ## 三条硬规则
 *
 * ① **一个排班一次只提交一个任务**：提交完立刻把 `next_run_at` 推到下一格，
 *    所以哪怕计时器同一分钟被触发两次，第二次也查不到 due 的行。
 * ② **不改数据的时间戳**：跑的是"这次本该跑的时间"，不是"现在"（见 store 的 markRun）。
 * ③ **错过不补跑**：算下次时间永远从 now 往后算，不回溯。一周后开机补一次两周前
 *    的扫描，只会得到一条时间戳骗人的观测。
 */

import { dueSchedules, markRun } from '../store/scan-schedule.js'
import { describeSchedule } from '../domain/keywords/schedule.js'

/** 默认每分钟检查一次。一分钟的粒度对一个按天/按周的规则足够。 */
export const DEFAULT_TICK_MS = 60_000

/** 排班没指定关键词时，用监控清单（`keyword` 表）里的词。 */
function watchlistKeywords(store, marketplace) {
  return store
    .all(
      'SELECT keyword FROM keyword WHERE marketplace = ? ORDER BY keyword',
      [String(marketplace).toUpperCase()],
    )
    .map(row => row.keyword)
}

export function createKeywordScheduler({
  store, keywords, logger = console, tickMs = DEFAULT_TICK_MS, now = () => new Date(),
}) {
  let timer = null
  let ticking = false

  /** 跑一条排班。返回提交结果，供工具与测试直接调用。 */
  function runOne(schedule) {
    const market = String(schedule.marketplace).toUpperCase()
    const words = Array.isArray(schedule.keywords)
      ? schedule.keywords
      : watchlistKeywords(store, market)

    if (words.length === 0) {
      /* 没有词可扫：仍然推进下次时间，否则这一行会每分钟被判定为 due，
         日志被刷满、而人永远不知道"其实什么都没跑"。 */
      markRun(store, { id: schedule.id, scheduledAt: schedule.nextRunAt, taskId: null, now: now() })
      logger?.warn?.(`[amazon-ops] 排班「${schedule.name}」没有可扫的关键词，本次跳过`)
      return { skipped: true, reason: 'no-keywords' }
    }

    try {
      const result = keywords.submit({
        marketplace: market,
        keywords: words,
        asins: Array.isArray(schedule.asins) ? schedule.asins : null,
        pages: schedule.pages,
        source: 'schedule',
      })
      markRun(store, {
        id: schedule.id,
        scheduledAt: schedule.nextRunAt,
        taskId: result.taskId ?? null,
        now: now(),
      })
      logger?.info?.(
        `[amazon-ops] 排班「${schedule.name}」已提交：${describeSchedule(schedule)} · `
        + `${words.length} 个词 · task ${result.taskId}`,
      )
      return { submitted: true, taskId: result.taskId, keywords: words.length }
    } catch (error) {
      /* 提交失败也要推进：否则一条坏排班（比如站点没有 ASIN）会每分钟重试一次，
         把队列和日志堵死。错误写进日志，人自己看得见。 */
      markRun(store, { id: schedule.id, scheduledAt: schedule.nextRunAt, taskId: null, now: now() })
      logger?.error?.(`[amazon-ops] 排班「${schedule.name}」提交失败：${error.message}`)
      return { failed: true, error: error.message }
    }
  }

  /** 检查一次。可被测试直接调用，不必等计时器。 */
  function tick() {
    if (ticking) return []
    ticking = true
    try {
      const due = dueSchedules(store, now())
      return due.map(schedule => ({ schedule, result: runOne(schedule) }))
    } finally {
      ticking = false
    }
  }

  function start() {
    if (timer !== null) return { started: false, reason: 'already-running' }
    timer = setInterval(() => {
      try {
        tick()
      } catch (error) {
        logger?.error?.(`[amazon-ops] 排班计时器出错：${error.message}`)
      }
    }, tickMs)
    /* 不让计时器把进程钉住：Host 该退就退。 */
    timer.unref?.()
    return { started: true, tickMs }
  }

  function stop() {
    if (timer === null) return { stopped: false }
    clearInterval(timer)
    timer = null
    return { stopped: true }
  }

  return { start, stop, tick, runOne, isRunning: () => timer !== null }
}

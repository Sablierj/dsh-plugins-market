/**
 * Pacing: how fast the collector is allowed to move.
 *
 * The numbers live here rather than inline in the collector so that the thing
 * an operator wants to tune is in one place, and so `capabilities()` can report
 * the same values the collector actually obeys. A rate limit that is documented
 * in one unit and enforced in another is worse than no limit at all.
 *
 * Randomness is uniform over the given range. That is deliberately simple:
 * what matters is that the gaps are not a constant, not that they follow some
 * particularly lifelike distribution. See DESIGN.md §4.2 for the honest
 * version of what pacing does and does not achieve.
 */

export const DEFAULT_PACING = {
  /** Hard cap per task. Enforced at submit time, so the agent is told no early. */
  perTaskMax: 50,
  /** Pause before each navigation, except the first. */
  beforeNavigateMs: [1_800, 4_200],
  /** Pause after the page reports complete, before reading it. */
  afterLoadMs: [1_200, 3_500],
  /** Every N targets, take a longer break. */
  longBreakEvery: 7,
  longBreakMs: [8_000, 20_000],
  /** Minimum gap between two tasks on the same source. */
  taskGapMs: [5_000, 15_000],
  /** Per-navigation ceiling, including in-page waiting. */
  pageTimeoutMs: 45_000,
  /** Whether to dispatch mouse movement and scrolling. */
  humanize: true,
  /**
   * How many **targets** may be collected per local day, across every task.
   *
   * It lives here rather than only in the settings table because everything
   * downstream reads one resolved object — the collection service asks the
   * resolver for its limits and then uses the result, and a field the resolver
   * does not carry is a field that silently becomes `undefined` at the call
   * site. That is not hypothetical: `dailyLimit` was read from the settings
   * store, dropped by this function, and the daily cap therefore never fired,
   * because `used >= undefined` is always false. A resolved-limits object that
   * is missing a limit is worse than one that does not offer the field at all.
   */
  dailyLimit: 1_200,
}

/** Merge operator overrides over the defaults, ignoring junk. */
export function resolvePacing(overrides = {}) {
  const pacing = { ...DEFAULT_PACING }
  if (overrides === null || typeof overrides !== 'object') return pacing

  if (Number.isFinite(Number(overrides.perTaskMax))) {
    pacing.perTaskMax = Math.min(Math.max(Math.trunc(Number(overrides.perTaskMax)), 1), 500)
  }
  if (Number.isFinite(Number(overrides.pageTimeoutMs))) {
    pacing.pageTimeoutMs = Math.min(Math.max(Math.trunc(Number(overrides.pageTimeoutMs)), 5_000), 180_000)
  }
  if (Number.isFinite(Number(overrides.dailyLimit))) {
    pacing.dailyLimit = Math.max(Math.trunc(Number(overrides.dailyLimit)), 1)
  }
  if (typeof overrides.humanize === 'boolean') pacing.humanize = overrides.humanize

  for (const key of ['beforeNavigateMs', 'afterLoadMs', 'longBreakMs', 'taskGapMs']) {
    const value = overrides[key]
    if (Array.isArray(value) && value.length === 2 && value.every(item => Number.isFinite(Number(item)))) {
      const low = Math.max(0, Math.trunc(Number(value[0])))
      const high = Math.max(low, Math.trunc(Number(value[1])))
      pacing[key] = [low, high]
    }
  }
  if (Number.isFinite(Number(overrides.longBreakEvery))) {
    pacing.longBreakEvery = Math.max(1, Math.trunc(Number(overrides.longBreakEvery)))
  }

  return pacing
}

/**
 * A pacer bound to one task.
 *
 * `wait()` returns the number of milliseconds it slept, which the caller puts
 * in the task result — the honest way to show a user why fifty ASINs took
 * several minutes rather than seconds.
 */
export function createPacer({ pacing = DEFAULT_PACING, random = Math.random } = {}) {
  const between = ([min, max]) => min + random() * Math.max(0, max - min)

  return {
    pacing,

    /** Before navigating to the target at `position` (0-based). */
    async beforeNavigate(position) {
      if (position === 0) return 0
      let ms = between(pacing.beforeNavigateMs)
      if (position % pacing.longBreakEvery === 0) ms += between(pacing.longBreakMs)
      await sleep(ms)
      return ms
    },

    async afterLoad() {
      const ms = between(pacing.afterLoadMs)
      await sleep(ms)
      return ms
    },

    async betweenTasks() {
      const ms = between(pacing.taskGapMs)
      await sleep(ms)
      return ms
    },
  }
}

/** The one-line summary shown by `amzn_source_list`. */
export function describePacing(pacing) {
  const range = ([min, max]) => `${Math.round(min / 1000)}–${Math.round(max / 1000)} 秒`
  return [
    `每任务 ≤${pacing.perTaskMax} 个 ASIN`,
    `每次导航前 ${range(pacing.beforeNavigateMs)}`,
    `每 ${pacing.longBreakEvery} 个休息 ${range(pacing.longBreakMs)}`,
    `任务间 ${range(pacing.taskGapMs)}`,
    pacing.humanize ? '启用鼠标/滚动拟人化' : '关闭拟人化',
  ].join('，')
}

/** Not `unref`'d: see the note on `sleep` in cdp/client.js. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

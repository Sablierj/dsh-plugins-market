/**
 * Whether a plan's run window is open (module 04 F04-10, contract §2.2).
 *
 * ## Why the verdict is computed and never stored
 *
 * There is no resident timer in this plugin, and no date in a plan: a window is
 * `{from, to, tz}` — a daily time range. "Is it open now" is a function of the
 * clock at the moment somebody asks, so storing `openNow` (or a `next_run_at`)
 * would store a calculation that is wrong a minute later. The contract says the
 * same thing about `next_run_at`: a column only a human can work out is a
 * calculation error saved to disk.
 *
 * ## Windows that cross midnight are refused, upstream
 *
 * `store/collection-plan.js` refuses `from >= to` rather than guessing, because
 * "23:30 inside 22:00–02:00" needs a date and there is none here. So this module
 * only ever compares two `HH:MM` strings on one side of midnight.
 */

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/
/* `to` 多接受一个 `24:00`：区间右端是**开**的，所以「整天」只能用 `00:00–24:00` 表达。
   用 `00:00–23:59` 会在每天最后一分钟关闭——而操作者最自然的写法恰恰是它
   （复验席 2026-10-25 §10：那条断言每天 UTC 23:59 必然红，生产侧同样受影响）。 */
const HH_MM_END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/

/**
 * The local time in `tz` as `HH:MM`.
 *
 * `Intl` is used rather than an offset table because timezone rules change and
 * Node ships the rules. An unrecognised zone is reported as `tzUnknown` and the
 * window is then treated as **open** — the alternative (closed) would silently
 * stop a plan whose only problem is a typo in a timezone name, and a task stuck
 * in `waiting_human` for that reason is worse than one run slightly early.
 */
function localHHMM(tz, now) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now)
    const hour = parts.find(part => part.type === 'hour')?.value
    const minute = parts.find(part => part.type === 'minute')?.value
    if (hour === undefined || minute === undefined) return null
    /* `en-GB` with hour12: false can render midnight as `24` in some ICU builds;
       normalising it is cheaper than a reader wondering why `24:00` sorts after
       `23:59` and before `00:00` at the same time. */
    const normalised = hour === '24' ? '00' : hour
    return `${normalised}:${minute}`
  } catch {
    return null
  }
}

/**
 * The state of one window at `now`.
 *
 * Returns `null` when there is no window at all — "no window" is not "a window
 * that never opens", and folding the two together would make every plan without
 * a window look permanently blocked.
 */
export function windowState(win, now = new Date()) {
  if (win === null || win === undefined || typeof win !== 'object') return null
  const from = String(win.from ?? '').trim()
  const to = String(win.to ?? '').trim()
  /* 左端不能是 24:00（那不是一天的起点），右端可以。
     `to` 是**开区间**：`00:00–24:00` 才是整天；`00:00–23:59` 会漏掉 23:59 那一分钟。
     字符串比较在这里是安全的：'HH:MM' 定长，'24:00' 字典序大于任何 '23:59 及以前'。 */
  if (!HH_MM.test(from) || !HH_MM_END.test(to)) return null
  const tz = String(win.tz ?? '').trim() || 'UTC'
  const localTime = localHHMM(tz, now)
  if (localTime === null) {
    return { from, to, tz, localTime: null, openNow: true, tzUnknown: true }
  }
  return { from, to, tz, localTime, openNow: localTime >= from && localTime < to, tzUnknown: false }
}

/** Convenience: is the window open right now? No window means "always open". */
export function isWindowOpen(win, now = new Date()) {
  const state = windowState(win, now)
  return state === null ? true : state.openNow
}

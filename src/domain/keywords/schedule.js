/**
 * 扫描排班 —— 「每周日 12:00」「每天 09:00」这种话说清楚，并且算得出下次时间。
 *
 * ## 时区
 *
 * **只用本机本地时间，不存时区。** 插件跑在谁的机器上就是谁的时间：存一个时区字段，
 * 「每周日 12 点」就变成一句需要解释的话（UTC+8 的 12 点还是用户看到的 12 点？）。
 * 代价是换机器要重设 —— 这个代价比"算错八小时"小得多。
 *
 * ## 两种周期
 *
 * `daily`  —— 每天 `at_time` 一次。
 * `weekly` —— `weekdays` 里列的每一天 `at_time` 一次。**可以多选**：
 *             「周一和周四各跑一次」是运营的常见需求，不该逼人建两条。
 *
 * ## 一个必须写清楚的边界
 *
 * 「下次运行时间」是**按当前这条规则从 now 往后算出来的**，不是 cron 表达式。
 * 所以若机器关机错过了 12:00，下次开机时算出来的仍然是**下一个** 12:00 ——
 * 补跑需要显式 `run-now`。**不自动补跑**：一周后开机补跑一次两周前的扫描，
 * 数据的时间戳会骗人。
 */

/** 周期取值，与表里的 `cadence` 一一对应。 */
export const CADENCES = ['daily', 'weekly']

/** ISO 星期：1=周一 … 7=周日（与 `weekdays_json` 的存法一致）。 */
export const WEEKDAY_NAMES = {
  1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日',
}

/**
 * 解析 'HH:MM'。返回 null 表示不合法 —— 不猜一个默认时间。
 */
export function parseAtTime(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute, text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
}

/** JS 的 getDay()（0=周日）→ ISO 星期（7=周日）。 */
function isoWeekday(date) {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

/**
 * 从 `from` 往后算第一次应该跑的时间。
 *
 * @returns {Date|null} 规则不完整时返回 null（例如 weekly 但没选星期），不编一个时间。
 */
export function computeNextRun({ cadence, atTime, weekdays = [], from = new Date() } = {}) {
  if (!CADENCES.includes(cadence)) return null
  const parsed = parseAtTime(atTime)
  if (parsed === null) return null

  const days = Array.isArray(weekdays) ? weekdays.map(Number).filter(day => day >= 1 && day <= 7) : []
  if (cadence === 'weekly' && days.length === 0) return null

  /* 从今天开始往后找，最多找 8 天（一周 + 今天已过）。 */
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset,
      parsed.hour, parsed.minute, 0, 0)
    if (candidate.getTime() <= from.getTime()) continue
    if (cadence === 'weekly' && !days.includes(isoWeekday(candidate))) continue
    return candidate
  }
  return null
}

/** 一句话描述，页面与工具共用。 */
export function describeSchedule({ cadence, atTime, weekdays = [] } = {}) {
  const parsed = parseAtTime(atTime)
  if (parsed === null) return '时间未设置'
  if (cadence === 'daily') return `每天 ${parsed.text}`
  if (cadence === 'weekly') {
    const days = (Array.isArray(weekdays) ? weekdays : []).map(Number).filter(day => WEEKDAY_NAMES[day])
    if (days.length === 0) return `每周（未选星期）${parsed.text}`
    return `每${days.map(day => WEEKDAY_NAMES[day]).join('、')} ${parsed.text}`
  }
  return '周期未设置'
}

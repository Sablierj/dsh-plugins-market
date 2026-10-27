/**
 * 一份「期间标签」的合法性判定。
 *
 * ## 为什么需要它
 *
 * 2026-10-25 真实数据实测（R-5）：运营汇总报告印出
 * `20260314-20160412` —— **结束早于开始，是一个不可能的区间**。
 *
 * 查下去发现**不是我们的解析错**：亚马逊后台导出的文件名本身就是
 * `深谷-us-sp-搜索词-20260314-20160412-1-20260412115914548.xlsx`，
 * 而文件名尾部 `20260412115914548` 说明这份文件产出于 **2026-04-12**。
 * 所以期间几乎肯定是 `2026-03-14 ~ 2026-04-12`，**源文件把 2026 打成了 2016**。
 *
 * ## 但我们的问题在这里
 *
 * 我们**原样采信了它**，于是报告里出现一个 2016 年的期间。
 * 读者看到 `20160412` 只会有一句「数据是 2016 年的？」——
 * **一个不可能的值被原样印出来，就等于替源数据背书。**
 *
 * 本仓在别处已经立过同一条规矩（0 / 空 / 未测量要分开），这里是它的第三种形态：
 * **不可能的值**必须被标成「不可能」，并附上原文，而不是当作正常值渲染。
 *
 * ## 判据（只做能证伪的那几条，不猜正确值）
 *
 * - `YYYYMMDD-YYYYMMDD`：解析两端，**结束 ≥ 开始**才合法；不成立 → `impossible`。
 * - `YYYY-MM-DD~YYYY-MM-DD`（带分隔符变体）：同上。
 * - 其余形状（`202603`、`2026-01`、`2025-Q1` 等）：**不判**，原样返回 `label`。
 *   —— 「我没法判」和「我判了它不对」是两件事，不能混。
 */

const DASH_RANGE = /^(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})$/
const SEP_RANGE = /^(\d{4})-(\d{2})-(\d{2})\s*[~-]\s*(\d{4})-(\d{2})-(\d{2})$/

function toDate(y, m, d) {
  const year = Number(y)
  const month = Number(m)
  const day = Number(d)
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { key: year * 10000 + month * 100 + day, iso: `${y}-${m}-${d}` }
}

/**
 * @returns {{ raw: string, state: 'ok'|'impossible'|'unjudged', label: string, note: string|null }}
 */
export function describePeriod(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return { raw, state: 'unjudged', label: '—', note: null }

  const match = DASH_RANGE.exec(raw) ?? SEP_RANGE.exec(raw)
  if (match === null) {
    /* 不是区间形状：202603 / 2026-01 / 2025-Q1 这些合法，原样放行。
       「我没法判」不是「它不对」。 */
    return { raw, state: 'unjudged', label: raw, note: null }
  }

  const [, ay, am, ad, by, bm, bd] = match
  const from = toDate(ay, am, ad)
  const to = toDate(by, bm, bd)
  if (from === null || to === null) {
    return { raw, state: 'impossible', label: raw, note: '期间的端点不是一个合法日期' }
  }
  if (to.key < from.key) {
    return {
      raw,
      state: 'impossible',
      label: raw,
      note: `结束早于开始（${to.iso} < ${from.iso}）—— 源文件里的期间自相矛盾，本仓原样保留、不替你改写`,
    }
  }
  return { raw, state: 'ok', label: raw, note: null }
}

/**
 * 把一组期间标签拼成一行，并把不可能的逐个标出来。
 * 报告里用这个，而不是 `GROUP_CONCAT` 的结果直接印。
 */
export function describePeriods(values) {
  const list = (Array.isArray(values) ? values : String(values ?? '').split(','))
    .map(entry => describePeriod(entry))
    .filter(entry => entry.raw !== '')
  if (list.length === 0) return { label: '—', impossible: [] }
  const label = list.map(entry => entry.label).join(', ')
  const impossible = list.filter(entry => entry.state === 'impossible')
  return { label, impossible }
}

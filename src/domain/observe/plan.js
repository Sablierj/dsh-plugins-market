/**
 * 模块 14 §7：把「一次存量优化」当成一个受控变更。
 *
 * §7 的原话是：
 *
 *   「单轮原则上修改 ≤30%，五点每次 1–2 条；若全量重写，必须标为重建而非小实验。」
 *
 * 这句话有一个**必须由代码执行**的部分：一个声明自己只动了 20%、实际重写了
 * 整个 listing 的计划，不能只是一条「原则上」的注释。因为「这是个小实验」正是
 * 观测期结论能成立的前提 —— 一次全量重写之后排名变了，你说不清是标题改对了
 * 还是整个页面被 Amazon 重新索引了。所以：
 *
 *   - 超过预算 **且** 没有标 `rebuild` → **拒收**，并说明超了多少、怎么改；
 *   - 标了 `rebuild` → 收下，并且它从此不是「小实验」，观测期的结论要按重建读。
 *
 * 这是 fail-closed：宁可让调用方多传一个 `rebuild: true`，也不要收下一份
 * 说不清自己是什么的变更声明。
 */

import { BULLET_FIELDS } from '../rules/listing-fields.js'

/** §7 的 30%。与 deviation.js 的 0.3 是**两个不同的**阈值，故各自导出。 */
export const PLAN_CHANGE_RATIO = 0.3

/** §7：「五点每次 1–2 条」。 */
export const PLAN_BULLET_LIMIT = 2

/** §8 的默认观测节点，也是 §7「观察窗口」的默认值。 */
export const DEFAULT_WINDOW_DAYS = [7, 14, 30]

function asArray(value) {
  return Array.isArray(value) ? value.map(entry => String(entry ?? '').trim()).filter(entry => entry !== '') : []
}

/**
 * 判断一份变更声明够不够格叫「小实验」。
 *
 * `ratio` 的分母是「动了的 + 没动的」，也就是这次声明覆盖的字段总数。若两边都空，
 * 分母是 0 —— 此时 `ratio` 是 `null` 而不是 0：**一份什么都没声明的计划不是
 * 「0% 改动」**，它是没有内容。把 0/0 写成 0 会让空计划看起来最安全。
 */
export function checkChangeBudget({ changed, unchanged, rebuild = false } = {}) {
  const changedFields = asArray(changed)
  const unchangedFields = asArray(unchanged)
  const total = changedFields.length + unchangedFields.length
  const ratio = total === 0 ? null : changedFields.length / total
  const bulletsChanged = changedFields.filter(field => BULLET_FIELDS.includes(field))

  const overRatio = ratio !== null && ratio > PLAN_CHANGE_RATIO
  const overBullets = bulletsChanged.length > PLAN_BULLET_LIMIT
  const isRebuild = rebuild === true
  /* 「够不够格叫小实验」与「收不收」是两件事：重建也是一种合法声明。 */
  const withinBudget = !overRatio && !overBullets
  const accepted = withinBudget || isRebuild

  const reasons = []
  if (overRatio) {
    reasons.push(`变更占比 ${(ratio * 100).toFixed(1)}% 超过 ${PLAN_CHANGE_RATIO * 100}%（${changedFields.length}/${total}）`)
  }
  if (overBullets) reasons.push(`五点改了 ${bulletsChanged.length} 条，超过每次 ${PLAN_BULLET_LIMIT} 条`)

  return {
    ratio,
    total,
    changedCount: changedFields.length,
    bulletsChanged: bulletsChanged.length,
    withinBudget,
    isRebuild,
    accepted,
    reasons,
    /** 给调用方看的一句话：为什么被拒，或者为什么被当成重建收下。 */
    note: accepted
      ? (withinBudget ? '在预算内，按小实验记录' : `超出小实验预算（${reasons.join('；')}），已按**重建**记录`)
      : `超出小实验预算（${reasons.join('；')}）—— 若确实要全量重写，请显式传 rebuild: true，把它标为重建`,
  }
}

/** 解析 `'7,14,30'` 这类窗口串。空串回落到 §8 的默认节点。 */
export function parseWindowDays(value) {
  if (value === undefined || value === null || String(value).trim() === '') return [...DEFAULT_WINDOW_DAYS]
  const parts = String(value).split(',').map(part => part.trim()).filter(part => part !== '')
  const days = parts.map(Number)
  if (days.length === 0) throw new Error('windowDays is empty — pass e.g. "7,14,30" or omit it for the §8 default')
  for (const day of days) {
    if (!Number.isInteger(day) || day < 1) throw new Error(`windowDays must be positive whole days, got "${value}"`)
  }
  /* 排序而不是原样保留：§8 的节点是要按顺序到期的，一份写着 '30,7,14' 的计划会
     让「下一个该观测的节点」变成一个看运气的问题。 */
  return [...new Set(days)].sort((a, b) => a - b)
}

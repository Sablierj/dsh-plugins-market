/**
 * 模块 14 §6：实际发布值 vs 已批准草案。
 *
 * ## 为什么这件事值得单独一个文件
 *
 * §6 的验收是「没有发布记录时，报告不得显示『已上线』」，而它另一半是「有发布
 * 记录时要能说清**发布的和批准的是不是一回事**」。后者有一个很容易写错、而且
 * 错了以后**看起来完全正常**的写法：
 *
 *   拿「模型改过的字段」（草案的 delta）当批准基线。
 *
 * 那样写，运营把整段 listing 粘进 Seller Central 之后，所有**本次没改动**的字段
 * 都会落进「发布里出现了、批准草案没有」，于是每一次正确的发布都亮「已偏离批准
 * 草案」。横幅天天亮，人就会学会无视它 —— 这个功能于是从「保护」变成了噪音。
 *
 * 所以批准基线是**完整的目标 listing**：这次运行考虑过的每个字段都有一项，
 * 采纳的用 `after`，没采纳的用 `before`。构建它的是 `buildApprovedSnapshot`。
 *
 * ## 一个明示的边界，不是遗漏
 *
 * 发布里出现的、批准草案**没有覆盖**的字段（`uncovered`）**记录并报告，但不计入
 * 差异比值**。理由：拿不到线上副本时，无法区分「运营粘了一个本次没动的字段」和
 * 「运营自己编了个值」。把它计入，等于把上一条那个 bug 换个地方再犯一次。
 *
 * 代价是：一个真的自己编了新字段的发布，不会因为**那个字段**被判偏离（但若它同时
 * 动了核心字段或改超 30%，仍会被判）。这个代价是明示的 —— `uncovered` 在结果里
 * 有一席之地，读的人看得到它，而不是被悄悄吞掉。
 */

import { REQUIRED_CORE_FIELDS } from '../optimize/validate.js'

/**
 * §6：「差异字段数 >30%」。
 *
 * 导出而不是内联，理由与 CORE_FIELDS 相同：阈值是一个会被争论的数字，它应当只有
 * 一处，而且改名或改值时 diff 里看得见。
 */
export const DEV_DEVIATION_RATIO = 0.3

/**
 * §6 的「核心字段」。文档从未定义它，而本仓已经声明过**唯一**一份「核心字段」：
 * `validate.js` 的 `REQUIRED_CORE_FIELDS`（title / description / search_terms /
 * item_highlights）。这里 import 而不是抄一份 —— 两份同义的清单，是阈值在有人
 * 改其中一份时悄悄移动的标准路径。
 */
export const CORE_FIELDS = REQUIRED_CORE_FIELDS

/** 值比较：`undefined`（没发布这个字段）与 `null`（发布了空值）不是一回事。 */
function differs(approvedValue, publishedValue) {
  if (publishedValue === undefined) return true
  return String(approvedValue ?? '') !== String(publishedValue ?? '')
}

/**
 * 逐字段比对批准草案与实际发布。
 *
 * 入参是两个普通对象：`approved` = `{field: 目标值}`，`published` = `{field: 实际值}`。
 * 返回的 `changed` 只含**批准草案里的**字段；`uncovered` 是反方向的多出来的字段。
 */
export function computeDeviation({ approved, published } = {}) {
  const baseline = approved !== null && typeof approved === 'object' ? approved : {}
  const actual = published !== null && typeof published === 'object' ? published : {}

  const changed = []
  for (const field of Object.keys(baseline)) {
    if (differs(baseline[field], actual[field])) {
      changed.push({ field, approved: baseline[field] ?? null, published: actual[field] ?? null })
    }
  }

  /* 反方向：发布里有、批准草案里没有的字段。见文件头「一个明示的边界」。 */
  const uncovered = Object.keys(actual).filter(field => !Object.hasOwn(baseline, field)).sort()

  const total = Object.keys(baseline).length
  const ratio = total === 0 ? 0 : changed.length / total
  const coreChanged = changed.filter(entry => CORE_FIELDS.includes(entry.field)).map(entry => entry.field)

  /* §6 的阈值是一个 OR。两个条件同时成立时报 `core-field`：它是**更强**的那个
     理由 —— 一条只改标题的发布和一个改了 40% 字段的发布都会被拦，但拦下来之后
     要说清楚是哪一条拦的，否则人无法判断该不该放行。 */
  const overThreshold = ratio > DEV_DEVIATION_RATIO
  const deviated = coreChanged.length > 0 || overThreshold
  const rule = coreChanged.length > 0 ? 'core-field' : (overThreshold ? 'over-threshold' : null)

  return {
    changed,
    changedCount: changed.length,
    total,
    ratio,
    coreChanged,
    uncovered,
    deviated,
    rule,
  }
}

/**
 * 把一次运行解析成**完整的目标 listing**（§6 的批准基线）。
 *
 * 每个草案行贡献一项：采纳（`accepted === 1`）用 `after`，其余（未决定 / 不采纳）
 * 用 `before` —— 「没采纳」的含义就是「保持原样」，所以它的目标值就是原值。
 *
 * 这里只覆盖**这次运行考虑过的字段**。运行没考虑过的字段不在基线里，这是构造上
 * 的事实，也正是 `uncovered` 要报告的东西。
 */
export function buildApprovedSnapshot(drafts = []) {
  const snapshot = {}
  for (const draft of drafts) {
    const field = String(draft?.field ?? '').trim()
    if (field === '') continue
    const accepted = draft?.accepted === 1 || draft?.accepted === true
    const value = accepted ? draft?.after : draft?.before
    snapshot[field] = value === undefined ? null : value
  }
  return snapshot
}

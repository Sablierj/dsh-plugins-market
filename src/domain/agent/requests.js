/**
 * 模块 12 F12-03 —— 补充数据请求的**状态词表**。
 *
 * 需求 §4 的原话是「需要新数据时发起补充数据请求，**不能自行扩大范围**」。所以一条请求
 * 回答的是：「这次运行缺什么数据、为什么缺」，以及**谁把它结掉的**。
 *
 * ## ⚠️ 插件不执行补充
 *
 * 本插件**不驱动 Agent**，也**不会去补**数据。一条请求是一条**记录** —— 给会话 / 人看的。
 * 任何「系统会去补」的说法都是插件做不到的承诺，不许写进文案。
 *
 * ## 三个状态，两段
 *
 * `open` 是**唯一**的非终态；`fulfilled` / `declined` 是两种结束方式（补到了 / 明确不补）。
 * 两者分开而不是合成一个 `closed`：一条被拒绝的请求与一条被满足的请求，下一个人要做的
 * 事完全不同 —— 拒绝意味着「这条路走不通」，满足意味着「数据在了」。
 */

/** 一条补充数据请求只可能是这三个之一。 */
export const AGENT_DATA_REQUEST_STATUSES = ['open', 'fulfilled', 'declined']

/** 唯一非终态。新开的请求都是它。 */
export const AGENT_DATA_REQUEST_OPEN = 'open'

/** 能由「结清」一步到达的两个终态（`open` 不是一次结清）。 */
export const AGENT_DATA_REQUEST_RESOLUTIONS = ['fulfilled', 'declined']

/**
 * 是不是一次「结清」的目标状态（`fulfilled` / `declined`）。
 *
 * 生产调用方：`store/agent-request.js` 的 `resolveDataRequest` **用它拒绝**把一条请求
 * 「结」成 `open` —— 那是它出生的状态，不是一次结清。
 *
 * ⚠️ 这里曾经还有一个 `isDataRequestStatus`（判断是不是三个状态之一）。**已删除**：它
 * 没有任何生产调用方（只有测试用），正是本仓接线守卫逐字抓的「零调用导出」。删法同
 * §3.28 的 `AVAILABLE_ROLE_IDS`：一个没人读的导出是负资产，不留。
 */
export function isResolvedStatus(value) {
  return AGENT_DATA_REQUEST_RESOLUTIONS.includes(String(value ?? '').trim())
}

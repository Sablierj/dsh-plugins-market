/**
 * 模块 14 §8：观测节点的状态机。
 *
 * ## 这个文件唯一要守住的事
 *
 * §8 有一句硬约束，整份文档里最像「防呆」的一句：
 *
 *   「不允许把空数据渲染成『无变化』结论」。
 *
 * 它之所以需要写进代码而不是留在文档里，是因为**空数据和持平长得一模一样**。
 * 一个没有数据的观测点，如果状态是 `concluded`、结论是 `keep`，在卡片上就是
 * 「第 7 天：无变化」—— 和真的持平**逐字相同**。人不会去查它的 `metrics_json`
 * 是不是空的，因为「无变化」这个结论已经回答了问题。
 *
 * 于是这个模块把三件事做成**不可混淆**的：
 *
 *   - 没到点 → `pending`，不接受任何结论（连 `insufficient` 也不接受：你还没看，
 *     不是看了没看懂。想提前动手走 §9 的回滚流程，那是另一条路）。
 *   - 到点了但没有数据 → `blocked`，**只能**给出 `insufficient` 一个结论，并且
 *     必须带着补数清单。`keep`/`watch`/`revise`/`rollback` 四个一律拒收。
 *   - 到点了且有数据 → `ready`，五个结论都收，但「哪些指标没拿到」跟着结论一起存。
 *
 * ## 为什么 `blocked` 的结论被限制成一个
 *
 * 「有数据」与「没数据」的差别不是数据量，是**能不能回答「这次改动有用吗」**。
 * 没有数据时给出 `keep`，等于用「我没看」支持「不用改」。所以 `blocked` 上只留
 * `insufficient` —— 它是唯一一个不需要数据的结论，因为它说的就是「数据不够」。
 *
 * 想回滚而不想等数据的，走 §9（回滚建议不依赖观测结论）。两条路分开，是因为
 * 它们要的证据不一样：§8 要「改了之后怎么样」，§9 要「现在线上的是不是我们要的」。
 */

import { DEFAULT_WINDOW_DAYS } from './plan.js'

/**
 * 六个存储状态。
 *
 * `retired` 与 `terminated` 必须分开，不能都叫「终止」：
 *
 *   `terminated` §9 的回滚终止 —— 「这次发布被撤回了，观测就此结束」。
 *   `retired`    观测计划的窗口变了（§7 的 `window_days` 是设计项），这个节点不在
 *                新窗口里了 —— 「这次发布还在观察，只是不在这天看了」。
 *
 * 合成一个词会让卡片状态说谎：改一次窗口就会让整个 ASIN 显示成「已回滚终止」。
 * 这两个词各自还有 `terminated_reason` / `retired_reason` 说明来龙去脉。
 */
export const OBSERVATION_STATUSES = ['pending', 'ready', 'blocked', 'concluded', 'terminated', 'retired']

/** 派生状态不再重算的终态。`concluded` 是人的动作，另外两个是「这个节点结束了」。 */
const TERMINAL_STATUSES = ['concluded', 'terminated', 'retired']

/** §8 的结论词表。闭集：加第六个是代码改动，所以它在这里而不是在调用方。 */
export const OBSERVATION_CONCLUSIONS = ['keep', 'watch', 'revise', 'rollback', 'insufficient']

/**
 * §9 列出的五个结论的中文原词：保留 / 继续观察 / 局部修订 / 回滚 / 无法判断。
 *
 * 放在这里而不是页面里，是因为它同时被三处用到（卡片、通知、工具输出），而三处
 * 各自抄一份的结果是「同一件事在通知里叫『无法判断』、在卡片上叫『数据不足』」——
 * 读的人会以为这是两种不同的状态。
 */
export const CONCLUSION_LABELS = {
  keep: '保留',
  watch: '继续观察',
  revise: '局部修订',
  rollback: '回滚',
  insufficient: '无法判断',
}

/**
 * 发布记录**卡片级**的状态，比节点状态多两个。
 *
 *   `waiting_human` §6 的偏离草案未处置。此时观测起点还可能被「以实际发布值为新
 *                   基线」推到现在，所以**不能**物化观测节点 —— 算出来的到期日
 *                   会建立在一个即将移动的起点上。
 *   `terminated`    §9 回滚终止（见 store/observe.js 的 terminateObservation）。
 */
export const OBSERVATION_CARD_STATES = ['waiting_human', 'pending', 'ready', 'blocked', 'concluded', 'terminated']

/** §8 的节点词表：结论里唯一不需要数据的那个。 */
export const INSUFFICIENT_ONLY = ['insufficient']

const DAY_MS = 86400000

/** 观测节点的 id 是**确定性**的，不是 uuid —— 见 store/observe.js 的 ensureCheckpoints。 */
export function checkpointIdFor(publicationId, day) {
  return `${String(publicationId ?? '').trim()}:d${Number(day)}`
}

/**
 * 到期时刻 = 观测起点 + N 天。
 *
 * 起点不是 `published_at`：§6 把「观测起点」单列，§9 说窗口自发布记录**重新计时**
 * （偏离处置里「以实际发布值为新基线」会把它推到现在）。用发布时间算，会让一条
 * 被重新起算的发布记录的第一个节点立刻过期。
 *
 * 无法解析的起点**抛错**而不是回落到现在：回落会静默地把所有节点挪到今天，
 * 于是一次数据损坏表现为「所有观测点都到期了」。
 */
export function dueAtFor(observationStartAt, day) {
  const start = Date.parse(String(observationStartAt ?? ''))
  if (Number.isNaN(start)) {
    throw new Error(`cannot compute a due date from observation start "${observationStartAt}" — expected an ISO timestamp`)
  }
  const days = Number(day)
  if (!Number.isInteger(days) || days < 1) throw new Error(`observation day must be a positive whole number, got "${day}"`)
  return new Date(start + days * DAY_MS).toISOString()
}

/**
 * 派生状态 —— **读的时候以这个为准**，表里那一列只是缓存（为 `idx_observation_due` 服务）。
 *
 * 终态一旦落上就不再派生：它们是**发生过的事**，不是时间的函数。重算会让一个已下
 * 结论的节点在数据被清理之后倒回 `blocked`，或者让一个已回滚终止的节点复活成
 * 「待观测」—— 后者更糟，它会让人以为还有一次观测没做。
 */
export function deriveStatus({ storedStatus, dueAt, now, sufficient }) {
  const stored = String(storedStatus ?? '').trim()
  if (TERMINAL_STATUSES.includes(stored)) return stored
  const due = Date.parse(String(dueAt ?? ''))
  const current = Date.parse(String(now ?? ''))
  if (Number.isNaN(due) || Number.isNaN(current)) return 'pending'
  if (current < due) return 'pending'
  return sufficient ? 'ready' : 'blocked'
}

/**
 * 一个结论在这个节点上是否成立。返回 `null` 表示可以收下，否则返回拒收理由。
 *
 * 返回值是**理由字符串**而不是布尔：调用方要把它原样报出去。一个只说「不行」的
 * 守卫，会让人以为是 bug 而不是规则。
 */
export function refuteConclusion({ conclusion, status, day, dueAt }) {
  const wanted = String(conclusion ?? '').trim()
  if (!OBSERVATION_CONCLUSIONS.includes(wanted)) {
    return `unknown conclusion "${conclusion}" — known: ${OBSERVATION_CONCLUSIONS.join(', ')}`
  }
  const state = String(status ?? '').trim()

  if (state === 'concluded') {
    return `observation day ${day} already has a conclusion — the first conclusion is the one that happened (§8)`
  }
  if (state === 'terminated') {
    return `observation day ${day} was terminated by a rollback (§9) — a terminated node takes no conclusion`
  }
  if (state === 'retired') {
    return `observation day ${day} is no longer in the observation window (§7) — it was retired when the plan changed, `
      + 'so there is nothing to conclude here'
  }
  if (state === 'pending') {
    return `observation day ${day} is not due until ${dueAt} — a node that has not been reached cannot be concluded. `
      + 'To act before the window closes, use the §9 rollback flow instead.'
  }
  if (state === 'blocked' && wanted !== 'insufficient') {
    /* 这就是 §8 那条硬约束的落点。见文件头「为什么 blocked 的结论被限制成一个」。 */
    return `observation day ${day} has no usable data, so "${wanted}" cannot be supported — `
      + `only "insufficient" is available. Collect the data listed in the checklist first.`
  }
  return null
}

/**
 * 发布记录级别的卡片状态。
 *
 * `blocked` 优先于 `ready`：blocked 要人**去做别的事**（补数据），ready 只要人读
 * 一眼。把 blocked 排在 ready 后面，补数清单就会永远轮不到被看见 —— 而它正是
 * §8 存在的理由。
 *
 * `retired` 的节点**不参与**判断：它们不在当前窗口里，既不待办也不阻塞。把它们算
 * 进来会让改过一次窗口的卡片永远显示成「还有节点没做」。
 */
export function cardState({ waitingHuman = false, terminatedAt = null, checkpoints = [] } = {}) {
  if (waitingHuman) return 'waiting_human'
  if (terminatedAt !== null && terminatedAt !== undefined && String(terminatedAt).trim() !== '') return 'terminated'
  const states = checkpoints
    .map(item => String(item?.status ?? '').trim())
    .filter(status => status !== 'retired')
  if (states.length === 0) return 'pending'
  for (const wanted of ['blocked', 'ready', 'pending']) {
    if (states.includes(wanted)) return wanted
  }
  return 'concluded'
}

/**
 * 节点清单：把一份 `windowDays` 展开成 `[{day, dueAt}]`。
 *
 * 节点取自**观测计划**（§7 的设计项），没有计划时回落到 §8 的默认 7/14/30。
 * 计划存在但窗口为空是不可能的（`parseWindowDays` 会拒收空串），所以这里不需要
 * 再判一次 —— 多写一个永远不成立的兜底分支，只会让人以为它可能成立。
 */
export function checkpointSchedule(observationStartAt, windowDays = null) {
  const days = Array.isArray(windowDays) && windowDays.length > 0 ? windowDays : [...DEFAULT_WINDOW_DAYS]
  const valid = [...new Set(days)]
    .map(day => Number(day))
    .filter(day => Number.isInteger(day) && day >= 1)
    .sort((a, b) => a - b)
  /* 空排期在这里**抛错**而不是返回 `[]`：调用方会把它拼成 `day NOT IN ()` 之类的
     空列表，那是一个 SQL 语法错误，或者更糟 —— 一个把所有节点都当成「不在窗口里」
     的查询。一个具名的错误比一个静默的错误结果好。 */
  if (valid.length === 0) {
    throw new Error(`observation window produced no nodes from ${JSON.stringify(windowDays)} — expected positive whole days`)
  }
  return valid.map(day => ({ day, dueAt: dueAtFor(observationStartAt, day) }))
}

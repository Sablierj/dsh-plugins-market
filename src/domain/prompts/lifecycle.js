/**
 * 模块 11 F11-05 —— 提示词生命周期的状态机。
 *
 * 需求原文（v2.0 §25）：
 *   `draft→review→testing→active→deprecated/rolled_back`；编辑与激活分离；
 *   active 才能用于生产；激活新版本不改变历史运行；可一键回滚。
 *
 * 这个文件是**边的唯一一处**。store 的每一次写入都问它，页面与工具都不自己写一份
 * 允许关系 —— 两份允许关系里较松的那一份会变成事实上生效的那一份，而没有人知道。
 *
 * ## 六个状态，与「谁能到谁」
 *
 * ```
 *   draft ──→ review ──→ testing ──→ active ──→ deprecated
 *     ↑         │  ↑        │          │            │
 *     └─────────┘  └────────┘          └──→ rolled_back ──→ review
 *                                        ↑
 *   （deprecated ──→ active：把一个退休的版本重新启用）
 * ```
 *
 * 逐条理由：
 *
 *   - `draft → review` 是唯一的入口：**没有从 draft 直接到 active 的边**。这是
 *     「编辑与激活分离」在状态机里的写法 —— 如果 draft 能一步到 active，那么保存
 *     一次正文就等于激活，两件事又合成一件。
 *   - `review → draft` / `testing → review` 是两条**回退边**。没有它们，一个状态
 *     机只能往前走，写错一次就只能新建一条提示词 —— 而「回退边」正是本仓
 *     `keyword_lifecycle` 与 `collection_scheme` 两台机器都有的形状。
 *   - `testing → active` 是**唯一进入 active 的用户边**（另一条是 deprecated →
 *     active，见下）。
 *   - `active → deprecated` 与 `active → rolled_back` 是两件不同的事，所以是两个
 *     状态而不是一个：`deprecated` 是「我不要它了」，`rolled_back` 是「它被一个
 *     更早的活动版本顶掉了」。合成一个会让审计回答不了「这一版是怎么离开生产的」。
 *     `rolled_back` 正常由 `rollbackPromptVersion` 写；把边也放进表里，是因为回滚
 *     本身要走同一台机器的校验，而不是绕过它。
 *   - `deprecated → active`：一个退休的版本可以重新启用。它此前**已经**过了
 *     review / testing，再走一遍不是「更严格」，是「重复劳动」。
 *   - `rolled_back → review`：被回滚掉的版本要重新上岗，必须重新评审 —— 它被回滚
 *     是因为它出了问题，而问题不会因为时间过去而消失。
 *
 * ## 一个状态都不能少，一个也不能多
 *
 * `PROMPT_LIFECYCLE_STATES` 与 `PROMPT_LIFECYCLE_EDGES` 的键集**必须相等**：
 * 少一个键，`canTransition` 会对那个状态一律返回 false（一台拒绝一切、看起来
 * 「很安全」的机器），多一个键则是一个谁也到不了的状态。两条都在测试里钉住。
 */

/** 六个状态，按需求原文的箭头顺序。 */
export const PROMPT_LIFECYCLE_STATES = ['draft', 'review', 'testing', 'active', 'deprecated', 'rolled_back']

/**
 * 一个版本「谁都没说过它是什么」时的状态。
 *
 * **是 draft，不是 active。** 沉默不是许可：把「没有记录」当成「在生产里」，正是
 * 本仓反复拒绝的「把缺失渲染成一个像值的值」。所以一条从来没有生命周期事件的提示词
 * 版本**不在生产里** —— 它需要有人走一遍 review → testing → active。
 *
 * （唯一的例外是 v38 迁移与种子：它们给「本批之前就在库里的那些版本」补一条**显式**的
 *  `active` 事件，把「它们当时就在生产里」这个既成事实写进数据，而不是靠沉默生效。
 *  见 `store/schema.js` 的 v38 迁移注释。）
 */
export const PROMPT_LIFECYCLE_INITIAL = 'draft'

/** 中文标签。页面与工具都从这里取，不各写一份。 */
export const PROMPT_LIFECYCLE_LABELS = {
  draft: '草稿',
  review: '评审中',
  testing: '测试中',
  active: '生效',
  deprecated: '已停用',
  rolled_back: '已回滚',
}

/** 允许的边。键集与 `PROMPT_LIFECYCLE_STATES` 逐字相等（测试钉住）。 */
export const PROMPT_LIFECYCLE_EDGES = {
  draft: ['review'],
  review: ['draft', 'testing'],
  testing: ['review', 'active'],
  active: ['deprecated', 'rolled_back'],
  deprecated: ['active'],
  rolled_back: ['review'],
}

/** 唯一允许进入 `active` 的两个来源，单独导出给「激活」工具与页面用。 */
export const PROMPT_LIFECYCLE_ACTIVE_SOURCES = ['testing', 'deprecated']

/** 这个字符串是不是六个状态之一。 */
export function isPromptLifecycleState(value) {
  return PROMPT_LIFECYCLE_STATES.includes(value)
}

/**
 * 能不能从 `from` 走到 `to`。
 *
 * 未知的 `from` 一律 false（不是抛）—— 调用方多半是在问「这一格能不能点」，
 * 一个未知状态不该让整个页面崩掉；要报错的地方用 `assertPromptTransition`。
 */
export function canTransition(from, to) {
  const allowed = PROMPT_LIFECYCLE_EDGES[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

/** 从 `from` 出发的合法下一步（页面据此画按钮，不自己抄一份边）。 */
export function promptLifecycleNextStates(from) {
  const allowed = PROMPT_LIFECYCLE_EDGES[from]
  return Array.isArray(allowed) ? [...allowed] : []
}

/** 一个版本要进入生产，它的状态必须是这个。 */
export function isPromptProductionStatus(status) {
  return status === 'active'
}

/**
 * 同 `canTransition`，但**按名字**报错 —— 每一次写入都先过这里。
 *
 * 报错必须点名 `from` 与 `to`，并列出 `from` 真正允许的下一步：只说「非法转移」的
 * 报错，排查的人还得回去翻这个文件才知道哪一步是合法的。
 */
export function assertPromptTransition(from, to) {
  if (!isPromptLifecycleState(from)) {
    throw new Error(`unknown prompt lifecycle status "${from}" — known: ${PROMPT_LIFECYCLE_STATES.join(' / ')}`)
  }
  if (!isPromptLifecycleState(to)) {
    throw new Error(`unknown prompt lifecycle status "${to}" — known: ${PROMPT_LIFECYCLE_STATES.join(' / ')}`)
  }
  if (!canTransition(from, to)) {
    const next = promptLifecycleNextStates(from)
    throw new Error(`a prompt version cannot move from "${from}" to "${to}"`
      + ` — allowed from "${from}": ${next.length > 0 ? next.join(' / ') : '（终态，无出口）'}`)
  }
}

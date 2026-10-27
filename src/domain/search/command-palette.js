/**
 * P3-4 命令面板（Ctrl+K）的数据层。
 *
 * ## 为什么逻辑放在服务端，而不是客户端自己拼
 *
 * 面板里会出现三类东西：**跳转模块**、**执行动作**、**搜索数据**。这三类在本仓都已经
 * 有唯一实现：
 *
 *   · 模块清单 —— `MODULE_GROUPS`（导航与页签共用同一份，15 个叶子模块）
 *   · 动作 —— `buildQuickActions()`，每条的 `target` 经 `targetLink()` 变成 `#module#anchor`
 *   · 数据 —— `searchAll()`，十个搜索类目、各自带 `available` 与 `reason`
 *
 * 如果让客户端再写一份"有哪些模块可以跳"，就会出现「导航里有、面板里没有」或
 * 「面板跳到的地方不存在」—— 这正是仓库里被反复裁决掉的那类第二个来源。
 *
 * ## 命令面板与全局搜索不是同一件事
 *
 * 全局搜索只回答「数据里有什么」；面板还要回答「我能去哪」和「我能做什么」。
 * 所以这里把三类合成一个列表，但**每条都标 `kind`**，让用户与测试都能分清
 * 「这是一条数据」还是「这是一个动作」。
 */

/** 命令的种类。`command` 是走这条链路时唯一需要的分类维度。 */
export const COMMAND_KINDS = ['module', 'action', 'data']

/**
 * 把模块清单摊成命令。
 *
 * 对齐 `state/workbench.js` 的 `MODULE_GROUPS` 真实形状：
 * `[{ id, label, modules: [{ id, label, sections?: [{ id, label }] }] }]`。
 * 注意字段名是 `modules` 而不是 `items` —— 我第一版写的就是 `items`，
 * 那会静默返回 0 条命令（`Array.isArray(undefined)` 是 false），面板永远空白。
 *
 * `sections` 是**页内分区**，不是模块：它不占导航位、也不是合法跳转目标
 * （`MODULE_IDS` 里没有它）。所以这里**不**把它们摊成独立命令，
 * 而是挂到所属模块上作为 `sections`，由页面决定怎么显示 ——
 * 把分区当模块跳过去会被 `set({ module })` 拒绝。
 */
function moduleCommands(groups) {
  const out = []
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const module of Array.isArray(group?.modules) ? group.modules : []) {
      const id = String(module?.id ?? '').trim()
      if (id === '') continue
      const sections = Array.isArray(module?.sections)
        ? module.sections
          .map(section => ({ id: String(section?.id ?? '').trim(), label: String(section?.label ?? '') }))
          .filter(section => section.id !== '')
        : []
      out.push({
        kind: 'module',
        id: `module:${id}`,
        label: String(module.label ?? id),
        detail: group.label === undefined ? null : String(group.label),
        link: `#${id}`,
        sections,
        /* 模块命令不需要确认：切页签不是危险动作。 */
        confirm: false,
      })
    }
  }
  return out
}

/**
 * 快捷动作 → 命令。
 *
 * 对齐 `buildQuickActions()` 的**真实**返回形状：
 * `{ id, label, effect, note, available, unavailableText, target, link }`。
 * 注意 `link` 在 `available === false` 时**是 null** —— 那不是缺陷，是设计：
 * 这条动作现在做不了，就不给一个跳过去也做不了的链接。面板照这个语义走，
 * 把它转成一条"不可用"记录而不是死链。
 */
function actionCommands(actions) {
  const out = []
  const skipped = []
  for (const action of Array.isArray(actions) ? actions : []) {
    if (action?.available === false) {
      skipped.push({
        id: action?.id ?? null,
        label: action?.label ?? null,
        reason: String(action?.unavailableText ?? '这条动作现在不可用'),
      })
      continue
    }
    const link = typeof action?.link === 'string' && action.link !== '' ? action.link : null
    if (link === null) {
      skipped.push({
        id: action?.id ?? null,
        label: action?.label ?? null,
        reason: '这条动作没有可跳转的 target，面板里点它无处可去',
      })
      continue
    }
    out.push({
      kind: 'action',
      id: `action:${String(action.id ?? link)}`,
      label: String(action.label ?? link),
      detail: action.effect === undefined || action.effect === null ? null : String(action.effect),
      link,
      confirm: false,
    })
  }
  return { commands: out, skipped }
}

/** 搜索结果 → 命令。每个类目取前几条，类目不可用时**留一行说明**而不是消失。 */
function dataCommands(search, { perGroup = 3 } = {}) {
  if (search === null || search === undefined) {
    return { commands: [], unavailable: [{ reason: '还没有输入搜索词 —— 数据类命令要有关键词才有意义' }] }
  }
  const out = []
  const unavailable = []
  for (const group of Array.isArray(search.groups) ? search.groups : []) {
    if (group.available === false) {
      unavailable.push({ id: group.id, label: group.label, reason: group.reason ?? '本仓没有这类来源' })
      continue
    }
    if (group.failed !== null && group.failed !== undefined) {
      unavailable.push({ id: group.id, label: group.label, reason: `这一类查询失败：${group.failed}` })
      continue
    }
    for (const row of (Array.isArray(group.rows) ? group.rows : []).slice(0, perGroup)) {
      const module = String(row.module ?? group.module ?? '').trim()
      if (module === '') continue
      out.push({
        kind: 'data',
        id: `data:${group.id}:${String(row.id ?? row.label ?? '')}`,
        label: String(row.label ?? row.id ?? ''),
        detail: `${group.label}${row.detail === undefined ? '' : ' · ' + String(row.detail)}`,
        link: '#' + module,
        confirm: false,
      })
    }
  }
  return { commands: out, unavailable }
}

/** 大小写不敏感的包含匹配；关键词为空时**全部保留**（面板空态就是"全部可去的地方"）。 */
function matches(command, needle) {
  if (needle === '') return true
  const haystack = `${command.label} ${command.detail ?? ''} ${command.link}`.toLowerCase()
  return haystack.includes(needle)
}

/**
 * 拼出面板内容。
 *
 * @param query 用户输入；空串时返回"全部模块 + 全部动作"，那是这个面板的默认视图
 * @returns 命令列表 + **被排除的那些及原因**（不静默丢弃）
 */
export function commandPalette({ query = '', groups = [], actions = [], search = null, limit = 40 } = {}) {
  const needle = String(query ?? '').trim().toLowerCase()

  const modules = moduleCommands(groups)
  const actionPart = actionCommands(actions)
  const dataPart = dataCommands(search)

  const all = [...modules, ...actionPart.commands, ...dataPart.commands]
  const filtered = all.filter(command => matches(command, needle))

  /* 排序：能跳的模块与动作优先于数据；同等档次内保持原有顺序（不按字母重排 ——
     使用者记的是"在上面第三个"，不是"字母序第三个"）。 */
  const rank = { module: 0, action: 1, data: 2 }
  const ordered = filtered
    .map((command, index) => ({ command, index }))
    .sort((a, b) => (rank[a.command.kind] - rank[b.command.kind]) || (a.index - b.index))
    .map(entry => entry.command)

  const counts = { module: 0, action: 0, data: 0 }
  for (const command of ordered) counts[command.kind] += 1

  return {
    query: String(query ?? '').trim(),
    commands: ordered.slice(0, limit),
    /* 被截断的条数要说出来，否则用户会以为"就这么多" */
    truncated: Math.max(0, ordered.length - limit),
    counts,
    total: ordered.length,
    /* 排除记录：跳过了哪些动作、哪些搜索类目不可用、以及原因 */
    skipped: actionPart.skipped,
    unavailable: dataPart.unavailable,
    empty: ordered.length === 0,
    emptyReason: ordered.length === 0
      ? (needle === ''
        ? '没有可跳转的模块、没有可执行的动作 —— 这本身是个异常，正常情况下至少会有 15 个模块'
        : `没有匹配「${String(query).trim()}」的模块、动作或数据。`)
      : null,
  }
}

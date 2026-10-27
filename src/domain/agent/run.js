/**
 * 运行状态机、blocked 原因、范围校验与门禁判定 —— 判断都在这里，写入在 store/agent.js。
 *
 * ## blocked 的**原因**是一个封闭词表，不是一个自由文本
 *
 * `agent_run.blocked_reason` 是自由文本，能说清「卡在哪」但**分不出类**：一句
 * 「这次跑不动了」既可以指数据过期也可以指权限不足，而 §9 要求**按原因**给出口动作。
 * 从自由文本里猜原因就是本仓最忌的那件事 —— **给缺失造一个像数据的替身**（一个
 * 正则猜出来的「数据过期」，和真的数据过期，在界面上长得一样）。
 *
 * 所以 F12-06 加了一列 `blocked_kind`，取值只能来自 `BLOCKED_KINDS`。它回答的是
 * 「这条运行为什么走不动了」，而**出口动作是这条词表的一部分**（`exit`），不是页面
 * 自己另写一张表 —— 一句事实活在两个文件里，就是本仓已经记过的那条教训。
 *
 * ## 范围校验为什么不是「过滤一下」
 *
 * §15-2 是「Agent 不会使用当前页面范围外的数据」。把它做成「查出来的行按范围过滤」
 * 会得到一个**空的成功结果**：调用方分不清「范围内确实没有」和「你要的东西在范围
 * 外」。这两件事要做的下一件事完全不同 —— 前者是结论，后者是「申请扩大范围」。
 * 所以范围外是一个**结构化拒绝**，带着它想要什么和范围是什么。
 *
 * 一个维度**缺席**不算限制（`marketplaces: undefined` = 不按站点限制），一个维度
 * **为空数组**算作「这一维什么都不许」。两者是不同的声明，合成一个会让「我没有
 * 限制站点」和「我不许任何站点」长得一样。
 *
 * ## 门禁的两个方向都要断言
 *
 * `gateRefusal` 只在**没有获批**时返回拒绝；获批就返回 `null` 放行。反过来断言
 * （未获批被拒 **且** 获批放行）是必须的：只断言前者的话，一个永远拒绝的实现也能过，
 * 而那等于把功能锁死 —— B17.1 刚踩过这个形状。
 */

import { AGENT_RUN_STATUSES, TERMINAL_RUN_STATUSES, gateById } from './roles.js'

/** The run-state edges of §6. Anything not listed here is refused. */
const RUN_EDGES = {
  draft: ['ready', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['waiting_human', 'blocked', 'completed', 'failed', 'cancelled'],
  waiting_human: ['running', 'blocked', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

/** Whether the run machine allows this move. */
export function canTransitionRun(from, to) {
  const allowed = RUN_EDGES[String(from ?? '').trim()]
  if (allowed === undefined) return false
  return allowed.includes(String(to ?? '').trim())
}

/** A status that nothing moves out of. */
export function isTerminal(status) {
  return TERMINAL_RUN_STATUSES.includes(String(status ?? '').trim())
}

/** Every status the machine knows, re-exported so callers need one import. */
export const RUN_STATUSES = AGENT_RUN_STATUSES

/** The scope dimensions an object can be checked against. */
export const SCOPE_DIMENSIONS = ['marketplaces', 'productLines', 'asins']

/** Normalise one dimension to a Set, or `null` for "not restricted". */
function dimension(scope, name) {
  const value = scope?.[name]
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return null
  return new Set(value.map(entry => String(entry ?? '').trim().toUpperCase()).filter(entry => entry !== ''))
}

/**
 * Whether one object is inside the frozen scope.
 *
 * An object carries whatever of `marketplace / productLine / asin` it has; a
 * dimension the object does not carry is not checked, because the scope cannot
 * exclude something the object does not claim.
 */
export function inScope(scope, object) {
  const markets = dimension(scope, 'marketplaces')
  const lines = dimension(scope, 'productLines')
  const asins = dimension(scope, 'asins')

  const market = String(object?.marketplace ?? '').trim().toUpperCase()
  if (markets !== null && market !== '' && !markets.has(market)) return false
  const line = String(object?.productLine ?? '').trim().toUpperCase()
  if (lines !== null && line !== '' && !lines.has(line)) return false
  const asin = String(object?.asin ?? '').trim().toUpperCase()
  if (asins !== null && asin !== '' && !asins.has(asin)) return false
  return true
}

/**
 * The structured refusal for an object outside the run's scope, or `null`.
 *
 * `code` is its own value (`AGENT_OUT_OF_SCOPE`) rather than a generic error: the
 * caller's next move is 「申请扩大范围」, which is a different move from 「重试」.
 */
export function scopeRefusal(scope, object) {
  if (inScope(scope, object)) return null
  return {
    ok: false,
    code: 'AGENT_OUT_OF_SCOPE',
    object: {
      asin: object?.asin ?? null,
      marketplace: object?.marketplace ?? null,
      productLine: object?.productLine ?? null,
    },
    scope: {
      marketplaces: scope?.marketplaces ?? null,
      productLines: scope?.productLines ?? null,
      asins: scope?.asins ?? null,
    },
    reason: '这个对象不在本次运行冻结的范围里。Agent 只能使用上下文包内的事实，'
      + '需要更多数据要发起补充数据请求，不能自行扩大范围（§4 / §15-2）。',
    hint: '要么把这个对象加进 scope 重开一次运行，要么让用户确认后调整范围。',
  }
}

/** Whether this run already carries an accepted decision for this gate. */
export function gateApproved(store, runId, gateId) {
  const wanted = String(gateId ?? '').trim()
  if (wanted === '') return false
  const row = store.get(
    "SELECT id FROM agent_artifact WHERE run_id = ? AND type = 'gate-decision' AND object_id = ? AND status = 'accepted'"
    + ' ORDER BY created_at DESC LIMIT 1',
    [String(runId ?? '').trim(), wanted],
  )
  return row !== undefined && row !== null
}

/**
 * The refusal for a gated action that nobody approved yet, or `null` to proceed.
 *
 * The code is `AGENT_GATE_REQUIRED`, deliberately **not** the approval policy's
 * `APPROVAL_REQUIRED`: those two are different questions. One is 「这个工作空间的设置
 * 要求先确认」(a policy switch the user turned on); this one is 「这一次运行的流程走到
 * 了一个必须有人看的节点」(a step in a plan). A caller that conflated them could not
 * say which of the two it was waiting for, and §11 requires exactly that.
 */
export function gateRefusal(store, runId, gateId) {
  const definition = gateById(gateId)
  if (definition === undefined) {
    return {
      ok: false,
      code: 'AGENT_UNKNOWN_GATE',
      gate: gateId,
      reason: `不认识的门禁 ${JSON.stringify(gateId)} —— 门禁清单在 domain/agent/roles.js 的 AGENT_GATES 里。`,
    }
  }
  if (gateApproved(store, runId, definition.id)) return null
  return {
    ok: false,
    code: 'AGENT_GATE_REQUIRED',
    gate: definition.id,
    gateLabel: definition.label,
    reason: `「${definition.label}」需要人工批准：${definition.why}`,
    hint: '确认后调 amzn_agent_gate_decide 记下这次批准，然后重跑这一步；运行会停在 waiting_human 等你。',
  }
}

/**
 * 两次运行的上下文包**差在哪**（F12-09）。
 *
 * §12 逐字：「上下文变化：**创建新运行，不修改旧运行**」。一个 `supersedes_run_id` 指针
 * 只说明了「我取代了谁」，说不清「**变的是什么**」—— 而后者才是「为什么必须新建」的
 * 理由。这个函数把那句话变成可读的一行。
 *
 * ⚠️ 它**只报差异，不判断「该不该新建」**：上下文没变也可以新建一次运行（手动重跑），
 * 那不是错误。谁把它读成一道闸门，就是在给自己造一条需求里没有的规则。
 *
 * `null` 入参（旧运行不存在、或新运行还没落库）→ `null`（**没有可比的东西**，
 * 不是「没有差异」—— 那两种要做的下一件事不同）。
 *
 * 比较用 `JSON.stringify`：两侧的快照都由 `store/agent.js` 的同一批函数生成，键顺序
 * 同源，所以这个比较是稳定的。
 */
export function snapshotDiff(previous, next) {
  if (previous === null || previous === undefined || next === null || next === undefined) return null
  const dimensions = [
    ['对象范围', 'scope'],
    ['数据快照', 'dataSnapshot'],
    ['规则快照', 'rulesSnapshot'],
    ['Prompt 快照', 'promptsSnapshot'],
    ['角色配置', 'roleConfig'],
  ]
  return dimensions
    .filter(([, key]) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null))
    .map(([label, key]) => ({ label, key }))
}

/* ────────────────────────────────────────────────────────────────────────────
   blocked 的原因词表（F12-06）
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * `agent_run.blocked_kind` 的**封闭词汇表**。七条，来源有两处。
 *
 * ## 七条 = §6.2 的六类 + §12 的中断一类
 *
 * 需求 §6.2 逐字给了 blocked 的**六类**用途：数据过期、缺失必需变量、规则判定不可用、
 * 权限不足、采集风控、成本超限。这六条都在下面，`requirement` 逐字标了出处。
 *
 * 第七条 `interrupted` **不来自 §6.2**，它来自 §12 的「任务中断：从最后持久化步骤恢复」
 * —— 由 `recoverStaleAgentRuns` 写入。把它放进**同一个**封闭列而不是另开一列，是因为
 * 「这条运行为什么走不动了」只能有一个答案；开第二列就是本仓反复付代价的「同一件事的
 * 第二个名字」。（⚠️ 这是一处**契约扩充**，已写进 `F12-02-03-06-09-contract.md` 的 §2.8。）
 *
 * ## 出口动作是词表的一部分，而且**四种「没有出口」要分开**
 *
 * §9 逐字给了四类的出口：数据过期 → 跳转补采表单；缺失变量 → 跳转来源模块；
 * 权限不足 → 显示所需权限层级与申请路径；成本超限 → 提供「缩小范围重试」。
 *
 * 那四类里有两类**在本插件里做不到**，而且原因各不相同：
 *
 *   - `permission-denied`：§9 要的是「显示**所需权限层级**与申请路径」，而本插件**没有
 *     权限模型**（`amzn_agent_artifact_decide` 的 `by` 是自报标签、没有用户表、没有角色
 *     权限）。画一个「所需层级：管理员」就是编的 —— 所以这里如实说做不到。
 *   - `cost-exceeded`：§9 要的「缩小范围重试」本来做得到（`blocked → running` 有边），
 *     但**这一类根本没有东西能产生它**：模块 12 不调 LLM，`agent_run` 没有 token / 费用列
 *     （`domain/agent/gap.js` 的 `cost-cap` 登记的是同一件事）。**为一个点不着的按钮
 *     留一个位置，比没有这个按钮更糟** —— 所以它 `reachable: false`，页面不画按钮。
 *
 * 另外两类**§9 根本没有给出口**（`rules-unusable`、`collection-risk`），`exit` 是 `null`
 * 且 `exitGap: 'requirement-silent'`。⚠️ **不许**为了「整齐」给它们硬套一个跳转：
 * 「规则判定不可用」跳去哪个模块？需求没说，编一个就是**把猜测写成规格**。
 *
 * 于是 `exitGap` 有三种取值，页面据此说**三句不同的话**：
 *
 *   - `null` —— 有出口，画按钮；
 *   - `'requirement-silent'` —— 需求没给这一类出口；
 *   - `'not-implementable'` —— 需求给了，但本插件做不到（并说清做不到的原因）；
 *   - `'not-reachable'` —— 需求给了、也做得到，但这一类在本仓不可达。
 *
 * ## `exit.type` 只有三种，每种都能指到一段真代码
 *
 *   - `'navigate'` —— 页面跳转。走的是**既有**的 `patchContext`（`page.js` 的
 *     `renderNav` 与 B-12.5 的两个出口按钮同一条机制），不是本批新造的路由。
 *   - `'act'` —— 页面上的一个写动作（本批只有「继续这次运行」，走 `agent-run` 路由）。
 *   - `'explain'` —— 只显示一段话，不做任何事。**本批没有任何一条用它**：§9 唯一
 *     需要「显示」的是权限那一类，而那一类被判定做不到（见上）。留着这个取值是为了
 *     词表能表达「有出口但它是纯说明」这件事，不是为了现在用。
 */
export const BLOCKED_KINDS = [
  {
    id: 'stale-data',
    label: '数据过期',
    requirement: '§6.2「数据过期」',
    exitRequirement: '§9「数据过期 → 跳转 04 §4.4 补采表单（预填对象）」',
    exit: { type: 'navigate', module: 'collect', label: '去采集面板' },
    exitGap: null,
    exitNote: '跳到采集器面板看这次运行等的那批数据。⚠️ 本页只跳转 —— 重新发起采集由会话侧'
      + '在对话里做，本页不执行采集。§9 要的「预填对象」本版也没有：跳过去时只带运行上下文，'
      + '不带预填的表单值。',
    reachable: true,
  },
  {
    id: 'missing-variable',
    label: '缺失必需变量',
    requirement: '§6.2「缺失必需变量」',
    exitRequirement: '§9「缺失变量 → 跳转来源模块（08/09/11，预填对象）」',
    exit: { type: 'navigate', module: 'settings', section: 'sources', label: '去来源模块' },
    exitGap: null,
    exitNote: '跳到「站点与采集配置 · 数据源管理」看这次运行要读的来源。⚠️ 同 `stale-data`：'
      + '本页只跳转，不改数据源、也不重跑运行，「预填对象」本版没有。',
    reachable: true,
  },
  {
    id: 'rules-unusable',
    label: '规则判定不可用',
    requirement: '§6.2「规则判定不可用」',
    /* §9 的出口清单里**没有**这一类。 */
    exitRequirement: null,
    exit: null,
    exitGap: 'requirement-silent',
    exitNote: '§9 的出口清单只给了四类（数据过期 / 缺失变量 / 权限不足 / 成本超限），'
      + '**这一类不在其中**。规则不可用时该跳去哪，需求没说 —— 所以这里没有按钮，'
      + '也不编一个。要给它出口，先补需求。',
    reachable: true,
  },
  {
    id: 'permission-denied',
    label: '权限不足',
    requirement: '§6.2「权限不足」',
    exitRequirement: '§9「权限不足 → 显示所需权限层级与申请路径」',
    exit: null,
    exitGap: 'not-implementable',
    exitNote: '§9 要的是「显示**所需权限层级**与申请路径」，而本插件**没有权限模型**：'
      + '没有用户表、没有角色权限表，`agent_artifact.decide` 的 `by` 是自报标签'
      + '（见 `tools/agent.js` 的说明）。画不出「所需层级：管理员」这种话 —— 那是编的。'
      + '权限层级在哪一层判定，不在本仓可证明的范围内，所以这里不声称有出口。',
    reachable: true,
  },
  {
    id: 'collection-risk',
    label: '采集风控',
    requirement: '§6.2「采集风控」',
    /* §9 的出口清单里**也没有**这一类。 */
    exitRequirement: null,
    exit: null,
    exitGap: 'requirement-silent',
    exitNote: '同 `rules-unusable`：§9 没给这一类出口。采集风控的下一步是等风控解除还是'
      + '换采集路径，需求没说，所以没有按钮。',
    reachable: true,
  },
  {
    id: 'cost-exceeded',
    label: '成本超限',
    requirement: '§6.2「成本超限」',
    exitRequirement: '§9「成本超限 → 提供「缩小范围重试」」',
    exit: { type: 'navigate', module: 'agent', label: '缩小范围重试' },
    exitGap: 'not-reachable',
    /* ⚠️ 出口**有**（缩小范围重试），但这一类**没有任何东西能产生它** —— 所以页面不画
       那个按钮。这与「需求没给」是两句不同的话：这里是「有按钮，但按钮永远不会出现」。 */
    exitNote: '§9 给的出口「缩小范围重试」本身做得到（`blocked → running` 有边，改 scope 再'
      + '重开一次运行即可）。但**这一类不可达**：本插件不调 LLM，`agent_run` 没有 token /'
      + '费用列，没有任何一条路径能算出「成本超限」并写下这个 kind —— `domain/agent/gap.js`'
      + '的 `cost-cap` 登记的是同一个洞。所以这里**不画**那个按钮：一个永远点不着的按钮，'
      + '比没有这个按钮更糟。',
    reachable: false,
  },
  {
    id: 'interrupted',
    label: '运行中断',
    requirement: '§12「任务中断：从最后持久化步骤恢复」（⚠️ 不在 §6.2 的六类里 —— 见本词表的文件头）',
    exitRequirement: '§12 同上',
    exit: { type: 'act', action: 'retry', label: '继续这次运行' },
    exitGap: null,
    /* ⚠️ 这里必须说清「恢复」在插件侧到底做了什么，否则会被读成「插件会自动接着跑」。 */
    exitNote: '「继续」= 把运行从 blocked 放回 running，让会话 / 人接着往下回报步骤。'
      + '⚠️ 本插件**不驱动 Agent**：它不会自动重跑任何一步，也不会替会话决定从哪一步续。'
      + '`recordStep` 按 `(run_id, seq)` upsert，所以续跑时重复回报已完成的步骤不会堆出'
      + '第二条历史（§15-6）。',
    reachable: true,
  },
]

/** 词表里的 id 清单，按声明顺序。 */
export const BLOCKED_KIND_IDS = BLOCKED_KINDS.map(kind => kind.id)

/** 一个 blocked 原因，或 `undefined`。 */
export function blockedKindById(id) {
  return BLOCKED_KINDS.find(kind => kind.id === String(id ?? '').trim())
}

/**
 * 写 `blocked_kind` 之前的那一问：这个值能用吗。
 *
 * ⚠️ **必填**。`status = 'blocked'` 而没有 kind 时，§9 的「按原因给出口」就无从下手 ——
 * 页面只能退回「固定两个按钮」，那正是 F12-06 要消灭的东西。所以这里拒绝，而不是
 * 写一个 `null` 让下游去猜。
 *
 * `cost-exceeded` **照收**（它在词表里、需求点了名），只是页面不为它画按钮 ——
 * 「写得出但判不出」与「根本写不出」是两件事，前者是本仓的真实状态。
 */
export function blockedKindRefusal(kind) {
  const wanted = String(kind ?? '').trim()
  if (wanted === '') {
    return {
      ok: false,
      code: 'AGENT_BLOCKED_KIND_REQUIRED',
      error: 'blocked_kind is required — §9 gives exit actions **by reason**, so a blocked run without a reason cannot be routed',
      hint: `取值只能是这 ${BLOCKED_KIND_IDS.length} 个之一：${BLOCKED_KIND_IDS.join(' | ')}`,
    }
  }
  if (blockedKindById(wanted) === undefined) {
    return {
      ok: false,
      code: 'AGENT_UNKNOWN_BLOCKED_KIND',
      error: `unknown blocked_kind ${JSON.stringify(kind)}`,
      hint: `取值只能是这 ${BLOCKED_KIND_IDS.length} 个之一：${BLOCKED_KIND_IDS.join(' | ')}。`
        + '这不是自由文本 —— §9 按原因分派出口，所以原因必须来自词表（见 domain/agent/run.js 的 BLOCKED_KINDS）。',
    }
  }
  return null
}

/* ────────────────────────────────────────────────────────────────────────────
   「多次失败停止自动重试」（F12-09 / §12）
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * 一次运行里失败步骤达到这个数，就不再指望它自己恢复（§12「多次失败：停止自动重试并给
 * 人工方案」）。
 *
 * ⚠️ **阈值声明在 domain，不许硬编码在页面里。** 页面只渲染 `retryBudget` 的结论
 * —— 一个数字活在两个文件里，改一处就漂一处（本仓「两个常量活在不同文件」那一类）。
 *
 * ⚠️ 本插件**本来就不自动重试**（它不驱动 Agent），所以这条在插件侧的真实含义是：
 * **告诉人别再等它自己好了**。它**不**改变运行状态、**不**自动阻止任何写入 ——
 * 把这句话读成「插件会自动停掉重试」就是这个缺陷形状的新一次。
 */
export const MAX_AUTO_RETRIES = 3

/**
 * 这次运行的重试预算。纯函数，不碰库。
 *
 * `failedSteps` 数的是 `agent_step` 里 `status = 'failed'` 的行 —— **总数**，不是尾部
 * 连续数。本版取总数的理由：插件不自动重试，所以这个数字的用途只是「这次运行已经失败
 * 了多少步」，而「连续」需要按 seq 回溯，多出来的精度换不到任何一件插件能做的事。
 * 这个选择写在这里，免得读者以为它是「连续失败」。
 */
export function retryBudget(run) {
  const steps = Array.isArray(run?.steps) ? run.steps : []
  const failedSteps = steps.filter(step => step?.status === 'failed').length
  return {
    failedSteps,
    limit: MAX_AUTO_RETRIES,
    exhausted: failedSteps >= MAX_AUTO_RETRIES,
  }
}

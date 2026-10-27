/**
 * 模块 12 的八个工具：把 Agent 的运行变成可查、可恢复、可审阅的留痕。
 *
 * 这一版**不接 LLM**（§17 的边界）：工具负责**确定性的**部分 —— 开一次运行并冻结
 * 上下文包、逐步回报、存产物、记门禁裁决、**由人裁决草案**、按运行 id 查回来、
 * 读 §14 的指标。分析、生成与编排由 DSH Agent 在会话侧做（§13 的分工）。所以每个
 * 工具都刻意不「替 Agent 思考」：`run_step` 不判断这一步该不该做，只记它做了什么。
 *
 * 三件守卫都在这里，而不是留给调用方：
 *   - **范围**：带着对象过来的工具先过 `scopeRefusal`，范围外是结构化拒绝，不是空结果。
 *   - **门禁**：会改变下游的产物（候选词包、位置计划）先过 `gateRefusal`。
 *   - **状态机**：写步骤与收尾都要问 `store/agent.js`，那里是唯一判断。
 *
 * ## 产物的状态只有人能动（§11 草案级控制）
 *
 * `amzn_agent_artifact_save` 只能存 `draft` —— 它不能把自己产出的东西标成
 * `accepted`/`rejected`（那是「Agent 自己批自己的作业」）。把草案从 `draft` 推走
 * 的**唯一**入口是 `amzn_agent_artifact_decide`，它要求一个非空的 `by`（本阶段没有
 * 用户表，`by` 是**自报标签、不是认证身份**），并把这次裁决追加成一条
 * `artifact-decision` 产物（自报的 `by` / 为什么 / 何时），而不是覆盖历史。
 */

/* 2026-10-25（R-58）：这里原来只 import 了 `table, text`，而 :618 用了 `truncate`。
   实测 `amzn_agent_run_list` 直接抛：
     { "ok": false, "error": "truncate is not defined", "tool": "amzn_agent_run_list" }
   那条路径只在「运行有 error 字段」时才走到（`row.error ? … truncate(…) : ''`），
   所以一直没被发现 —— **今天第二个「某个名字没定义」（第一个是 R-28 的 `scanWritten`）。**
   两者的共同点：只有在某种数据条件下才会走到那一行，而测试没覆盖那个条件。 */
import { table, text, truncate } from './render.js'
import {
  amendAndAcceptArtifact, decideArtifact, getRun, listRuns, recordStep, recoverStaleAgentRuns, saveArtifact,
  setRunStatus, startRun,
} from '../store/agent.js'
import {
  AGENT_GATES, AGENT_ROLES, AGENT_RUN_STATUSES, AGENT_STEP_STATUSES, AGENT_TASK_TYPE_LABELS,
  AGENT_TASK_TYPES, roleById, toolsForRole, toolsFromRoleConfig,
} from '../domain/agent/roles.js'
import {
  latestRoleConfig, listRoleConfigVersions, publishRoleConfig, roleConfigVersion,
} from '../store/agent-config.js'
import { listDataRequests, openDataRequest, resolveDataRequest } from '../store/agent-request.js'
import { AGENT_DATA_REQUEST_RESOLUTIONS } from '../domain/agent/requests.js'
import { agentMetrics } from '../domain/agent/metrics.js'
import { AGENT_PLAN_MODE_LABELS, planNextStep } from '../domain/agent/orchestration.js'
import { AGENT_GAP_COUNT, AGENT_GAP_ELEMENTS, AGENT_GAP_SUMMARY } from '../domain/agent/gap.js'
import { CONVENTIONAL_ARTIFACT_TYPES, QUALITY_SUMMARY_TYPE } from '../domain/agent/artifact-types.js'
import { BLOCKED_KINDS, blockedKindById, blockedKindRefusal, gateRefusal, retryBudget, scopeRefusal, snapshotDiff } from '../domain/agent/run.js'

/** The artifact types whose write is gated, and which gate guards each. */
export const GATED_ARTIFACT_TYPES = {
  'keyword-package': 'keyword-package-write',
  'placement-plan': 'placement-plan-change',
}

function runOrError(store, runId) {
  const run = getRun(store, runId)
  if (run === null) return { error: { ok: false, error: `no agent run ${runId}`, hint: '用 amzn_agent_run_list 看运行 id。' } }
  return { run }
}

/**
 * 编排判词里「拒绝一次步骤写入」的判据。返回拒绝对象，或 `null`（该写）。
 *
 * ⚠️ 拒绝**必须**是 `{ok:false, error, hint}`，不能是一句字符串：审计漏斗
 * （`src/tools/index.js` 的 `recordToolAudit`）与遥测（同文件 `ok: value?.ok !== false`）
 * 都靠 `value?.ok === false` 判断「这次写没发生」。一句字符串会被记成**成功写入** ——
 * 一次没发生的写留下一条「写过了」的审计，比没有记录更糟。所以这里绝不返回纯字符串。
 *
 * 实际判词由 `domain/agent/orchestration.js` 的 `planNextStep` 算 —— 那是**纯函数**，
 * 自带测试，本工具只负责把它的两个「拒绝态」翻译成结构化拒绝。`ok` / `done` 放行。
 */
function orchestrationRefusal(run, args) {
  const role = roleById(run.role)
  /* 把**这一次要写的行**并进 recorded 再算判词 —— 否则「先做了后面的步骤」永远查不到：
     乱序的判据是「存在一个 passed 的契约步骤，前面还有没 passed 的」，而这一次要写的
     行正是那个候选。仅当状态是 passed 时才并进去比较顺序；running 的行不构成「做了」。 */
  const recorded = run.steps.map(step => ({ seq: step.seq, step: step.step, status: step.status }))
  const attempted = {
    seq: Number.isInteger(Number(args?.seq)) ? Number(args.seq) : (recorded.length + 1),
    step: String(args?.step ?? ''),
    status: String(args?.status ?? 'running'),
  }
  /* 步骤契约取**这次运行冻结的那一版**（`agent_run.role_config_json`，F12-02），
     代码里的 `AGENT_ROLES` 只是「这个角色还没有任何配置版本」时的兜底。
     不这么取会出现一种自相矛盾：`run_start` 说「角色配置 v2」并按 v2 下发工具，
     `run_step` 却按代码常量（可能还是 v1 的空 steps）判 out-of-contract ——
     同一份契约两个来源，正是本仓反复要避免的那类缺陷。 */
  const frozenSteps = Array.isArray(run.roleConfig?.steps) ? run.roleConfig.steps : null
  const contractSteps = frozenSteps ?? role?.steps ?? []
  const plan = planNextStep({ role: run.role, id: run.role, steps: contractSteps }, [...recorded, attempted])

  if (plan.verdict === 'out-of-contract') {
    const offending = plan.outOfContract.join('、')
    return {
      ok: false,
      error: `步骤 ${offending} 不在角色「${run.roleLabel}（${run.role}）」的步骤契约里`,
      hint: `契约允许的步骤（按顺序）: ${plan.expected.join(' → ')}。`
        + '名字写错了就改名字；这一步不归这个角色管，就换一个角色开运行。',
    }
  }
  if (plan.verdict === 'out-of-order') {
    return {
      ok: false,
      error: `步骤顺序不对：契约要求 ${plan.expected.join(' → ')}，但更前面的步骤还没 passed`,
      hint: `该先做的是 ${plan.next}（已发生乱序：先做了后面的步骤）。补齐 ${plan.next} 再往下走。`,
    }
  }
  return null
}

export function agentRunStartTool({ store }) {
  return {
    name: 'amzn_agent_run_start',
    description:
      'Start one Agent run and freeze its context package: object scope, data snapshot (kw_master version + import batch), '
      + 'rule roster, and prompt set versions. The four are **copies**, so upgrading rules or prompts mid-run does not '
      + 'change this run (§15-5). Returns the run id plus the tool scope this role **declares** for the task — a declared '
      + 'scope, not an enforced permission boundary: this plugin does not block an out-of-scope call. Whether any other '
      + 'layer does is outside what this repo can show, so it is not claimed here. What this plugin **does** '
      + 'enforce is §15-2\'s data scope and §15-4\'s gates, via scopeRefusal / gateRefusal in src/domain/agent/run.js. The '
      + 'declared list deliberately contains no publishing tool (§15-8). '
      + 'Roles available today: ' + AGENT_ROLES.filter(role => role.available).map(role => role.id).join(', ')
      + '. Roles declared but not available are refused by name with the reason.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role id, e.g. data-steward / keyword-research / pipeline-maintenance.' },
        goal: { type: 'string', description: 'What this run is trying to produce, in one sentence.' },
        scope: {
          type: 'object',
          description: 'Object range frozen for this run. A **missing** dimension is not a restriction; an **empty array** '
            + 'means nothing is allowed on that dimension.',
          properties: {
            marketplaces: { type: 'array', items: { type: 'string' }, description: 'e.g. ["US"].' },
            productLines: { type: 'array', items: { type: 'string' }, description: 'e.g. ["bench-cushion"].' },
            asins: { type: 'array', items: { type: 'string' }, description: 'e.g. ["B0..."]' },
          },
        },
        trigger: { type: 'string', description: 'What started it: page / chat / schedule. Default manual.' },
        humanConstraint: {
          type: 'string',
          description: 'A constraint a person adds **on top of** this run (e.g. "do not touch these ASINs"), '
            + 'frozen at start and never changed. Omit it to mean "none given" — an empty string is refused, '
            + 'not folded into null. ⚠️ This plugin records it and draws it; it does **not** enforce it (it does '
            + 'not drive the agent), so a violation is not blocked here.',
        },
        outputFormat: {
          type: 'string',
          description: 'The agreed output format (e.g. json / table / prose), frozen at start. ⚠️ This is a '
            + '**convention, not a validation**: this plugin has no artifact-format checker, so writing "json" '
            + 'and then saving prose will **not** raise an error. Omit it to mean "not agreed".',
        },
        supersedesRunId: {
          type: 'string',
          description: 'The run this one **replaces** (§12: when the context changes, create a new run instead of '
            + 'editing the old one). It must name a run that exists — a pointer to a run that does not exist is '
            + 'refused. This only records the pointer: the new run freezes its **own** context package and the old '
            + 'run is not touched. Omit it when this is not a replacement. ⚠️ A differing context is **not** required '
            + '— re-running with the same context is a legitimate new run.',
        },
        type: {
          type: 'string',
          enum: AGENT_TASK_TYPES,
          description: 'One of the six task types of §5: '
            + AGENT_TASK_TYPES.map(id => id + '（' + AGENT_TASK_TYPE_LABELS[id] + '）').join(' / ') + '. '
            + '⚠️ **Omitting it means "not declared"** — this plugin has no default type, and both the page and this '
            + 'tool render an undeclared run as undeclared. Do **not** pick one just to fill the field: a guessed '
            + 'type is indistinguishable from a real one downstream.',
        },
      },
      required: ['role'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const run = startRun(store, {
          role: args?.role,
          goal: args?.goal ?? null,
          scope: args?.scope ?? {},
          trigger: args?.trigger ?? 'manual',
          humanConstraint: args?.humanConstraint ?? null,
          outputFormat: args?.outputFormat ?? null,
          supersedesRunId: args?.supersedesRunId ?? null,
          taskType: args?.type ?? null,
        })
        /* F12-09：取代关系。§12 说「上下文变化 → 创建新运行，不修改旧运行」，所以这里只
           记一个指针，并**说出变了什么** —— 一个只有指针、没有差异的「取代」回答不了
           「为什么必须新建」。⚠️ 差异**不是一道闸门**：上下文没变也可以新建（手动重跑），
           那不是错误；所以这里只报事实，不拒绝任何东西。 */
        const previous = run.supersedesRunId === null ? null : getRun(store, run.supersedesRunId)
        const diff = previous === null ? null : snapshotDiff(previous, run)
        /* F12-02：这次运行要带的工具**从冻结的角色配置算出来**，不是从代码常量。
           配置里改了 `tools`，这里下发的名单就跟着变 —— 这是本批唯一的承重断言。
           `run.roleConfig` 为 null（v40 之前的运行）才回落到配置读侧。 */
        const declaredTools = toolsFromRoleConfig(run.roleConfig) ?? toolsForRole(store, run.role)
        return [
          `Agent 运行已开始: ${run.id}`,
          /* F12-09：取代关系与**差异**。差异为空也要说 —— 「一样都没变」与「没记差异」
             是两件事，而这里说的是前者。 */
          ...(run.supersedesRunId === null ? [] : [
            `取代: ${run.supersedesRunId}`,
            `上下文变化: ${diff.length === 0
              ? '（一样都没变 —— 这次新建不是由上下文变化引起的，那不是错误）'
              : diff.map(entry => entry.label).join('、')}`,
          ]),
          `角色: ${run.roleLabel}（${run.role}）    目标: ${run.goal ?? '—'}`,
          /* F12-04：§5 的六类任务类型。⚠️ 未声明就**照实画「未声明」**，不折算成某一类 ——
             给缺失造一个像数据的替身是本仓铁律里最贵的那条。带上英文 id，因为读这段的是
             会话侧的 Agent，它要拿这个 id 去比对 / 复述。 */
          run.taskType === null
            ? '任务类型: 未声明（这次运行没有声明类型）'
            : `任务类型: ${AGENT_TASK_TYPE_LABELS[run.taskType] ?? run.taskType}（${run.taskType}）`,
          `范围: 站点 ${(run.scope.marketplaces ?? ['（不限）']).join('/')}`
            + ` · 产品线 ${(run.scope.productLines ?? ['（不限）']).join('/')}`
            + ` · ASIN ${(run.scope.asins ?? []).length || '（不限）'}`,
          '',
          '冻结的上下文包（拷贝，运行中改规则/Prompt/**角色配置**不影响它）:',
          `  数据快照: ${run.dataSnapshot?.importBatchId ?? '（还没有导入批次）'}`
            + ` · kw_master ${run.dataSnapshot?.kwMasterRows ?? 0} 行`,
          `  规则快照: ${run.rulesSnapshot?.origin} ${run.rulesSnapshot?.version}（${run.rulesSnapshot?.count} 条）`,
          `  Prompt 快照: ${run.promptsSnapshot?.count ?? 0} 个集合`,
          `  角色配置: ${run.roleConfigVersion === null ? '（没有配置版本）' : `v${run.roleConfigVersion}`}`
            + ` · 允许读 ${run.roleConfig?.reads?.join('/') ?? '（未声明）'}`
            + ` · 失败策略 ${run.roleConfig?.onFailure ?? '（未声明）'}`
            + ` · 步骤上限 ${run.roleConfig?.maxSteps ?? '（未声明）'}`,
          /* F12-03 的两样。⚠️ 都把边界写在同一行：人工约束插件**记但不拦**；输出格式是
             **约定不是校验**。一句「已记录」不加这半句，读者会以为插件兜住了它。 */
          `  人工约束: ${run.humanConstraint ?? '（没给）'}（本插件只记，不拦 —— 它不驱动 Agent）`,
          `  输出格式: ${run.outputFormat ?? '（没约定）'}（约定，不是校验：没有产物格式检查器）`,
          '',
          `本次声明的工具范围（${declaredTools.length} 个，随这次运行下发）: ${declaredTools.join(', ')}`,
          '这是**声明**，不是权限边界：本插件不会拦截范围外的调用。'
            + '本插件强制的是 §15-2 的数据范围与 §15-4 的门禁。',
          '按角色的步骤契约逐步回报: amzn_agent_run_step(runId, seq, step, status, output)；收尾用 amzn_agent_run_finish。',
        ].join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: '角色清单见 amzn_agent_run_start 的说明；不可用的角色会说明为什么。'
            + 'humanConstraint / outputFormat 想表示「没给」就**省略参数**，不要传空串 —— 空串会被拒绝（它看起来像「给了」）。',
        }
      }
    },
  }
}

export function agentRunStepTool({ store }) {
  return {
    name: 'amzn_agent_run_step',
    description:
      'Record one step of a run: seq, name, status (pending/running/passed/failed/skipped), optional input/output summaries '
      + 'and an error. Re-recording the same seq is the normal case — a step goes running → passed, and a resumed run '
      + 're-reports finished steps onto the same row instead of stacking a second history (§15-6). '
      + 'To query data for a step, pass the object you are about to use in `object`; anything outside the run scope is '
      + 'refused with AGENT_OUT_OF_SCOPE rather than silently returning nothing (§15-2). '
      + '`agentRole` and `toolName` are §9\'s 「每步负责 Agent」 and 「工具调用」 columns: pass them when you know them, '
      + 'omit them to record nothing — omitting does **not** mean "the run\'s own role". '
      + '`retryable` (§12 「是否可重试」) is three-valued: omit it and a **failed** step inherits the answer from the '
      + 'run\'s **frozen** role config (`onFailure`: continue → yes, stop → no), while a step that has not failed gets '
      + 'nothing — a step that never failed has no retry question yet, and writing "no" there would render as a fact '
      + 'that never happened.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        seq: { type: 'number', description: 'Step number within the run, 1-based.' },
        step: { type: 'string', description: 'Step name, e.g. interpret-quality.' },
        status: { type: 'string', enum: AGENT_STEP_STATUSES },
        input: { description: 'What went in (a short summary or an object).' },
        output: { description: 'What came out.' },
        error: { type: 'string' },
        agentRole: {
          type: 'string',
          description: 'Which agent was responsible for this step (§9 「每步负责 Agent」). Omit to record nothing — '
            + 'an omitted value is **not** filled in with the run\'s own role, because a substitute for a missing '
            + 'value is worse than an admitted hole. An empty string is refused.',
        },
        toolName: {
          type: 'string',
          description: 'Which tool this step called (§9 「工具调用」). Omit to record nothing. An empty string is refused.',
        },
        retryable: {
          type: 'boolean',
          description: 'Whether this step can be retried (§12). Pass it when you know why the tool failed '
            + '(a flaky network vs a bad argument — the plugin cannot tell). Omit it and a failed step falls back to '
            + 'the run\'s frozen role config `onFailure`; a step that has not failed gets nothing recorded.',
        },
        object: {
          type: 'object',
          description: 'The object this step touches, checked against the frozen scope.',
          properties: {
            asin: { type: 'string' },
            marketplace: { type: 'string' },
            productLine: { type: 'string' },
          },
        },
      },
      required: ['runId', 'seq', 'step'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const found = runOrError(store, args?.runId)
      if (found.error !== undefined) return found.error

      /* 范围外是拒绝，不是空结果：两者要做的下一件事不同。 */
      if (args?.object !== undefined && args.object !== null) {
        const refusal = scopeRefusal(found.run.scope, args.object)
        if (refusal !== null) return refusal
      }
      /* F12-05：写入前用角色的步骤契约算判词。out-of-contract / out-of-order 拒绝
         （结构化拒绝，见 orchestrationRefusal 的说明）；ok / done 放行。判词把这一次
         要写的行一并算进去 —— 「先做了后面的步骤」正是这一次尝试本身。 */
      const contractRefusal = orchestrationRefusal(found.run, args)
      if (contractRefusal !== null) return contractRefusal
      try {
        const step = recordStep(store, {
          runId: found.run.id,
          seq: args?.seq,
          step: args?.step,
          status: args?.status ?? 'running',
          input: args?.input ?? null,
          output: args?.output ?? null,
          error: args?.error ?? null,
          agentRole: args?.agentRole ?? null,
          toolName: args?.toolName ?? null,
          retryable: args?.retryable ?? null,
        })
        /* `retryable` 的三态里**只有 `null` 不打印** —— `false` 是一个真的结论
           （「这一步失败过、且不可重试」），不能因为它是假值就被吞掉。 */
        const retryLine = step.retryable === null
          ? ''
          : `\n可重试: ${step.retryable ? '是' : '否'}`
            + (typeof args?.retryable === 'boolean'
              ? '（你给的）'
              : '（按该运行**冻结**的角色配置 onFailure 推出来的；显式传 retryable 可以覆盖）')
        return `步骤 ${step.seq} ${step.step}: ${step.status}`
          + (step.error ? `（错误: ${step.error}）` : '')
          + retryLine
          + `\n运行 ${found.run.id} 现有 ${getRun(store, found.run.id).steps.length} 步。`
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

export function agentRunFinishTool({ store }) {
  return {
    name: 'amzn_agent_run_finish',
    description:
      'Move a run to a terminal or waiting status. waiting_human and blocked **require** a reason — §11 says an Agent '
      + 'must say what it is waiting for, not just 「需要确认」, and the store refuses the write without one. '
      + '`blocked` **additionally requires** `blockedKind`: §9 gives exit actions **by reason**, so a blocked run '
      + 'without a reason class cannot be routed anywhere. The values are a closed vocabulary (§6.2\'s six kinds plus '
      + '§12\'s interruption): ' + BLOCKED_KINDS.map(kind => kind.id).join(' | ') + '. '
      + 'Only moves the run state machine allows are accepted.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        status: { type: 'string', enum: AGENT_RUN_STATUSES },
        waitingReason: { type: 'string', description: 'Required when status is waiting_human.' },
        blockedReason: { type: 'string', description: 'Required when status is blocked.' },
        blockedKind: {
          type: 'string',
          enum: BLOCKED_KINDS.map(kind => kind.id),
          description: 'Required when status is blocked — the reason **class**, from §6.2 (data stale / missing '
            + 'variable / rules unusable / permission denied / collection risk / cost exceeded) plus §12\'s '
            + '`interrupted`. ⚠️ It is a closed vocabulary, not free text: §9 routes the exit action by reason, so a '
            + 'reason guessed out of prose would be a substitute for a fact. `cost-exceeded` is accepted but '
            + '**unreachable** — this plugin has no cost source, so nothing can produce it.',
        },
        error: { type: 'string' },
      },
      required: ['runId', 'status'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        /* F12-06：`blocked` 的原因类别先在这里问一次，**在碰库之前** —— 这样拒绝是一个
           三件套 `{ok:false, error, hint}`，而不是落进下面那个只带 `error` 的 catch
           （本文件四处 catch 都是那个形状，是既有约定，这一批不动它们）。
           判定用的是 `domain/agent/run.js` 的同一个 `blockedKindRefusal`，所以
           「什么算合法原因」仍然只有一处定义；`setRunStatus` 里那次是给别的调用方的
           兜底，不是第二份口径。 */
        if (String(args?.status ?? '').trim() === 'blocked') {
          const refusal = blockedKindRefusal(args?.blockedKind)
          if (refusal !== null) return refusal
        }
        /* F12-05：收尾是**人的决定**，所以 verdict !== 'done' 时仍然允许收尾 ——
           但输出必须写出「还有哪几条契约步骤没 passed」。不拦，但要说得清楚，
           否则一次「已完成」的运行会掩盖一份没走完的契约。 */
        const before = getRun(store, args?.runId)
        const plan = before === null ? null : planNextStep(
          { role: before.role, id: before.role, steps: roleById(before.role)?.steps ?? [] },
          before.steps.map(step => ({ seq: step.seq, step: step.step, status: step.status })),
        )
        const run = setRunStatus(store, args?.runId, args?.status, {
          waitingReason: args?.waitingReason ?? null,
          blockedReason: args?.blockedReason ?? null,
          blockedKind: args?.blockedKind ?? null,
          error: args?.error ?? null,
        })
        return `运行 ${run.id} → ${run.status}`
          + (run.waitingReason ? `\n在等: ${run.waitingReason}` : '')
          + (run.blockedReason ? `\n卡住: ${run.blockedReason}` : '')
          + blockedExitTail(run)
          + retryBudgetTail(run)
          + contractTail(plan)
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

/**
 * 收尾输出里关于 blocked **出口**的那一段（F12-06）。
 *
 * §9 按原因给出口动作，所以一次 blocked 的收尾必须说出「这一类该怎么往下走」——
 * 否则调用方只看到一句「卡住了」，而**「下一步不一样」正是这一批要区分的东西**。
 *
 * ⚠️ 三种「没有出口」在这里**分开说**（词表的 `exitGap`）：需求没给 / 插件做不到 /
 * 这一类不可达。折成一句「没有出口」会把三种不同的下一件事混成一件 —— 而它们要做的
 * 下一件事完全不同（补需求 / 换一层做 / 什么都不用做）。
 *
 * ⚠️ 不返回 `{ok:false}`：出口是**附注**，不是拒绝。收尾已经发生了。
 */
function blockedExitTail(run) {
  if (run.status !== 'blocked') return ''
  const kind = blockedKindById(run.blockedKind)
  if (kind === undefined) {
    /* v40 之前写的 blocked 行没有这一列 —— 如实说「没记」，**不猜**一个原因。 */
    return '\n⚠️ 这条运行没有记 blocked 原因类别（v40 之前写的行），所以给不出按原因分派的出口。'
  }
  if (kind.exit !== null && kind.reachable) {
    return `\n出口（${kind.label}）: ${kind.exit.label}`
  }
  if (kind.exitGap === 'not-reachable') {
    return `\n出口（${kind.label}）: **这一类在本仓不可达** —— ${kind.exitNote}`
  }
  if (kind.exitGap === 'not-implementable') {
    return `\n出口（${kind.label}）: **需求给了，但本插件做不到** —— ${kind.exitNote}`
  }
  return `\n出口（${kind.label}）: **需求没给这一类出口** —— ${kind.exitNote}`
}

/**
 * 收尾输出里关于「多次失败停止自动重试」的那一段（F12-09 / §12）。
 *
 * ⚠️ 阈值来自 `domain/agent/run.js` 的 `MAX_AUTO_RETRIES`，**不在这里写一个数** ——
 * 一个数字活在两个文件里就会漂（本仓「两个常量活在不同文件」那一类）。
 *
 * ⚠️ 它**不改变任何状态**：本插件本来就不自动重试（它不驱动 Agent），所以这句话的真实
 * 含义是「别再等它自己好了」，不是「插件已经把重试停掉了」。
 */
function retryBudgetTail(run) {
  const budget = retryBudget(run)
  if (!budget.exhausted) return ''
  return `\n⚠️ 已有 ${budget.failedSteps} 步失败（阈值 ${budget.limit}）—— 按 §12 不再指望自动重试，`
    + '请人工决定：改参数重跑、缩小范围、还是放弃这次运行。'
    + '（本插件不驱动 Agent，它不会自动重试任何一步；这一行是给人看的判词。）'
}

/**
 * 扫一遍僵死的 `running` 运行，把它们标成 `blocked`（F12-09 / §12「任务中断」）。
 *
 * ## ⚠️ 这是本批最容易写错的一条
 *
 * §12 说「任务中断：从最后持久化步骤恢复」。把它读成「插件会自动接着跑」，就是把插件
 * **做不到**的事写成了能力 —— 本插件不驱动 Agent，真正在跑的是会话侧的 DSH Agent。
 * 所以这个工具做的**只有一件事**：把「这条 running 很久没动了」这个事实写下来，把决定权
 * 交回人 / 会话。它**不**重跑任何一步、**不**回报任何步骤、**不**把任何东西改回 `running`。
 *
 * ## 阈值由调用方给，插件不自己定
 *
 * 不给 `staleMinutes` 就**一条都不扫**（`store/agent.js` 的 `recoverStaleAgentRuns` 会说明）。
 * 一个内置默认值会变成「插件自己决定谁该被中断」—— 那是运维判断，不是插件判断。
 */
export function agentRunRecoverTool({ store }) {
  return {
    name: 'amzn_agent_run_recover',
    description:
      'Scan for agent runs that have been `running` with no activity for longer than `staleMinutes` and mark them '
      + '`blocked` with reason class `interrupted` (§12 「任务中断：从最后持久化步骤恢复」). '
      + '⚠️ This plugin does **not** drive the agent, so "recovery" here means exactly one thing: it records that a '
      + 'run stopped moving and hands the decision back to a person / the conversation. It **never** restarts a run, '
      + 'never re-reports a step, and never moves anything back to running. '
      + '⚠️ `staleMinutes` is required for anything to happen — with it omitted, nothing is scanned. A built-in '
      + 'default would be this plugin deciding on its own which runs count as interrupted. '
      + 'The runs it does touch keep every persisted step, which is what makes them resumable at all.',
    parameters: {
      type: 'object',
      properties: {
        staleMinutes: {
          type: 'number',
          description: 'How long without activity counts as interrupted, in minutes. Must be positive. '
            + 'Omit it and **nothing is scanned** (that is a real answer, not a default).',
        },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const result = recoverStaleAgentRuns(store, { staleMinutes: args?.staleMinutes ?? null })
      if (result.interrupted.length === 0) {
        if (result.staleMinutes === null) return `没有扫描任何运行：${result.note}`
        return `扫描了 ${result.scanned} 条 running 运行，没有一条超过 ${result.staleMinutes} 分钟没动`
          + `（阈值内还在跑的 ${result.held.length} 条，一条都没动）。`
      }
      return [
        `扫描了 ${result.scanned} 条 running 运行；其中 ${result.interrupted.length} 条超过 `
          + `${result.staleMinutes} 分钟没动，已标成 blocked（原因类别 interrupted）:`,
        '',
        table(result.interrupted, [
          { label: '运行', value: row => row.id },
          { label: '角色', value: row => row.role },
          { label: '最后活动', value: row => String(row.lastActivityAt).slice(0, 19).replace('T', ' ') },
          { label: '已回报步骤', value: row => row.stepCount },
        ]),
        '',
        '⚠️ 只标了状态：本插件不驱动 Agent，**不会自动重跑任何一步**。已持久化的步骤都在，',
        '从哪一步继续由人 / 会话决定（页面上的「继续这次运行」把运行放回 running）。',
        `阈值内还在跑的 ${result.held.length} 条，一条都没动。`,
      ].join('\n')
    },
  }
}

/**
 * 收尾输出里关于步骤契约的那一段。`verdict === 'done'` 时确认走完整份契约；
 * 否则逐条点名**还没 passed** 的契约步骤（部分完成要说清剩下哪几条）。
 *
 * 不返回 `{ok:false}`：收尾是人的决定，未走完契约不该拦。这一段只是一句诚实的
 * 附注，所以它进的是正常输出的文本，不是拒绝对象。
 *
 * ## ⚠️ B-12.10：这里**没有** `plan === null` 分支，而且那不是漏写 —— 它可证死
 *
 * B-12.6 的交接条曾说这段的静默「同时覆盖顺序 / `plan === null` / `expected.length === 0`
 * 三种情形，读者分不出」。**那句话在函数契约层成立，在运行时是错的**（见
 * `docs/requirements/B-12.10-honest-closeout-contract.md` §0.2 —— 这是对上一批
 * 自己的 over-claim 的订正）。实测（本文件 `amzn_agent_run_finish` 的 `execute`）：
 *
 *   - `plan === null` 需要 `before === null`（`getRun` 没找到这条运行）。但**紧接着**的
 *     `setRunStatus`（`src/store/agent.js`）对**同一个 run id** 会先 `getRun` 并抛
 *     `no agent run <id>` → 控制流落到 `catch` → `contractTail(plan)` **根本不被求值**。
 *     ⇒ 该分支是**可证死代码**。留一个「看起来在处理第三种输入」的空壳，正是本仓最贵的
 *     形状（沉默与「顺序」不可区分）—— 所以删掉它，并把原因写在这里。
 *   - `expected.length === 0` 需要 `roleById(run.role)?.steps` 为空。**三条路径可达**：
 *     ① 运行的 `role` 不在 `AGENT_ROLES` 里（旧库行 / 直接插库）；② **配置发布路径** ——
 *     `amzn_agent_role_config_release` 可以把一个**代码 `steps` 为空、但在表里**的角色
 *     （如 `collect-coordinator`）发布成 `available: true`（`validateRoleConfig` 明确允许
 *     `steps: []`，它的 hint 逐字写着「空数组是允许的」），`startRun` 只查 `config.available`
 *     于是放行，而 `planNextStep` 取的是**代码** `steps` ⇒ 这一支被触发，**而角色就在表里**；
 *     ③ 三个可用角色的代码 `steps` 都非空（`roles.js`），所以「可用且代码有步骤」走不到这里。
 *     ⇒ 这一支**可达**，所以**不许**继续 `return ''`：沉默会把「契约是空的」渲染成
 *     「一切正常」。它现在**说出来**，且**不断言原因**（路径 ② 的角色就在表里）。
 *     ⚠️ P5 的不变量只约束**代码声明**，约束不到**已发布的配置** —— 那是它钉不住的边界。
 *
 * `tests/b12-9-task-type.mjs` 的对照臂（顺序**不**报模式）是**证伪控制**，不是缺陷 ——
 * 所以 `sequential` 仍然不加模式句，那几行断言一个字都不许改。
 */
function contractTail(plan) {
  if (plan.expected.length === 0) {
    /* 契约是空的，核对无从谈起 —— 说出来，不沉默。
       ⚠️ **这一支有三条可达路径，其中两条的角色都在角色表里**（见上面的 JSDoc）：
       ① `role` 不在 `AGENT_ROLES` 里（旧库行 / 直接插库）；② 配置发布路径 —— 把一个
       代码 `steps` 为空、**但在表里**的角色发布成 `available: true`。
       ⇒ 所以这句话**只陈述可观察的事实，不断言原因**。写成「该角色不在角色表里」会在
       路径 ② 上变成假话 —— 而那正是本批要消灭的形状（假说法），不能由本批再引入一次。
       P5 的结构性不变量只钉住「可用角色**的代码声明**有步骤」，钉不到已发布的配置。 */
    return '\n⚠️ 这次运行的角色没有可核对的步骤契约（`AGENT_ROLES` 里它的 `steps` 是空的），无法核对契约是否走完。'
  }
  /* F12-05：编排模式。**只有审阅循环才说** —— 顺序是常态，每次都报一遍是噪声。
     数字取 `plan.reviewCount`（**不在这里重算**：`orchestration.js` 是唯一口径）。 */
  const modeTail = plan.mode === 'review-loop'
    ? '\n编排模式: ' + AGENT_PLAN_MODE_LABELS[plan.mode] + '（同一步骤已被重复 ' + plan.reviewCount + ' 次）'
    : ''
  if (plan.verdict === 'done') {
    return '\n步骤契约：全部 passed（' + plan.expected.join(' → ') + '）。' + modeTail
  }
  const pending = plan.expected.filter(name => !plan.done.includes(name))
  return '\n⚠️ 步骤契约未走完（' + plan.verdict + '）：还没 passed 的契约步骤有 '
    + pending.join('、') + '。收尾是人的决定，但这份运行没有走完它声明的步骤。' + modeTail
}

export function agentRunListTool({ store }) {
  return {
    name: 'amzn_agent_run_list',
    description:
      'List the most recent Agent runs, newest first, with their step and artifact counts. Read-only. '
      + 'The run id here is the same id the workbench page shows, which is how the page and the conversation line up on '
      + 'one task (§15-7).',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many runs. Default 20, max 100.' } },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const listed = listRuns(store, { limit: args?.limit ?? 20 })
      if (listed.rows.length === 0) return '还没有 Agent 运行。用 amzn_agent_run_start 开一次。'
      return [
        `最近 ${listed.rows.length} 次 Agent 运行（共 ${listed.total} 次）:`,
        '',
        table(listed.rows, [
          { label: '运行', value: row => row.id },
          { label: '角色', value: row => row.roleLabel },
          {
            label: '状态',
            /* F12-06：blocked 那一栏带上**原因类别**。只有一句自由文本时，读者分不出
               「数据过期」与「权限不足」—— 而那正是 §9 要按原因分派的东西。
               kind 认不出来（v40 之前写的行）就不加，**不猜**。 */
            value: row => row.status
              + (row.waitingReason ? `（等: ${row.waitingReason}）` : '')
              + (row.blockedReason
                ? `（卡${blockedKindById(row.blockedKind) === undefined ? '' : `: ${blockedKindById(row.blockedKind).label}`}`
                  + `: ${row.blockedReason}）`
                : '')
              /* 2026-10-25 真实数据实测（R-8）：`failed` 的运行**库里写着完整原因**（`error` 列），
                 而列表只印 `failed · 0 步 · 0 产物` —— 读者完全不知道发生了什么。
                 实测那次失败写的是「run_step 的契约校验读的是代码常量，未热重载时仍是空 steps，
                 导致三步全部 out-of-contract」——这种解释不露出来，等于白记。
                 **状态是一个词，原因是那段话；只给词等于没给。** */
              + (row.error ? `（错误: ${truncate(String(row.error), 90)}）` : ''),
          },
          { label: '步', value: row => row.stepCount },
          { label: '产物', value: row => row.artifactCount },
          { label: '开始', value: row => String(row.startedAt).slice(0, 19).replace('T', ' ') },
        ]),
      ].join('\n')
    },
  }
}

export function agentArtifactSaveTool({ store }) {
  return {
    name: 'amzn_agent_artifact_save',
    description:
      'Save one Agent artifact: a versioned object rather than a chat bubble (§10). Pass parentId to create the next '
      + 'version of the same chain — the old row is marked superseded and stays resolvable, so a report written against '
      + 'v1 still points at v1 (§15-7). `supersedeParents` is refused when the parent is accepted: a human decision is '
      + 'not the agent\'s to overwrite, so add a version without that flag instead. '
      + 'Two types are gated: keyword-package (候选词包入库) and placement-plan (位置计划变更) both need an approved '
      + 'decision on this run first, otherwise the write is refused with AGENT_GATE_REQUIRED and the run should sit in '
      + 'waiting_human. Everything else saves freely — a read-only analysis must not be buried in approvals (§17-4). '
      + 'This tool always writes `draft`: an Agent must not accept or reject its own output. Moving a draft to '
      + 'accepted / rejected is the human act of §11, and its only entry point is amzn_agent_artifact_decide.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        stepSeq: { type: 'number', description: 'Which step produced it.' },
        type: { type: 'string', description: 'Artifact type, e.g. quality-summary / keyword-package / rerun-advice.' },
        objectType: { type: 'string' },
        objectId: { type: 'string' },
        parentId: { type: 'string', description: 'Previous version of this artifact, to supersede it.' },
        /* 只允许 `draft`：产物的状态只能由人推走（§11），入口是
           amzn_agent_artifact_decide。收窄成单值是**声明**——execute 里还有一道运行时拒绝，
           因为直调工具的调用方（测试、路由）不走宿主校验。 */
        status: { type: 'string', enum: ['draft'], description: 'Always draft. Use amzn_agent_artifact_decide to decide.' },
        body: { description: 'The artifact itself.' },
        supersedeParents: { type: 'boolean', description: 'Also mark the parent superseded. Default false. Refused when the parent is accepted — a human decision stands, so add a version without this flag instead.' },
      },
      required: ['runId', 'type'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const found = runOrError(store, args?.runId)
      if (found.error !== undefined) return found.error

      /* 自批洞：这个工具**只**能存 draft。把它自己产出的东西标成 accepted/rejected
         是「Agent 自己批自己的作业」，而 §11 的草案级控制是一次**人工**动作。 */
      const wanted = String(args?.status ?? 'draft').trim()
      if (wanted !== 'draft') {
        return {
          ok: false,
          error: `amzn_agent_artifact_save only writes draft — got status "${wanted}"`,
          hint: '裁决草案是人工动作（§11）：调 amzn_agent_artifact_decide(artifactId, accept, by)。'
            + '要改内容就带 parentId 存一版新的（旧版标 superseded，历史不断）。',
        }
      }

      const type = String(args?.type ?? '').trim()
      const gate = GATED_ARTIFACT_TYPES[type]
      if (gate !== undefined) {
        const refusal = gateRefusal(store, found.run.id, gate)
        if (refusal !== null) return refusal
      }

      try {
        const artifact = saveArtifact(store, {
          runId: found.run.id,
          stepSeq: args?.stepSeq ?? null,
          type,
          objectType: args?.objectType ?? null,
          objectId: args?.objectId ?? null,
          parentId: args?.parentId ?? null,
          status: args?.status ?? 'draft',
          body: args?.body ?? null,
          supersedeParents: args?.supersedeParents === true,
        })
        return `产物已存: ${artifact.id}  ${artifact.type} v${artifact.version}（${artifact.status}）`
          + (artifact.parentId ? `\n取代: ${artifact.parentId}` : '')
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

export function agentGateDecideTool({ store }) {
  return {
    name: 'amzn_agent_gate_decide',
    description:
      'Record a person\'s decision on one of the two gates of a run. Approving writes an accepted gate-decision artifact '
      + 'and (if the run is waiting) moves it back to running; rejecting writes a rejected one and leaves the run waiting. '
      + 'The decision is an artifact like any other, so it has a version and a chain and can be cited later. '
      + 'Gates: ' + AGENT_GATES.map(gate => `${gate.id}（${gate.label}）`).join(', ') + '.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        gate: { type: 'string', description: 'Gate id, e.g. keyword-package-write.' },
        approve: { type: 'boolean', description: 'true to approve, false to reject.' },
        note: { type: 'string', description: 'Why — recorded with the decision.' },
        by: { type: 'string', description: 'Who decided. Default local.' },
      },
      required: ['runId', 'gate', 'approve'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const found = runOrError(store, args?.runId)
      if (found.error !== undefined) return found.error
      const gate = AGENT_GATES.find(entry => entry.id === String(args?.gate ?? '').trim())
      if (gate === undefined) {
        return { ok: false, error: `unknown gate: ${args?.gate}`, hint: `可用: ${AGENT_GATES.map(entry => entry.id).join(' | ')}` }
      }
      try {
        const artifact = saveArtifact(store, {
          runId: found.run.id,
          type: 'gate-decision',
          objectType: 'agent-gate',
          objectId: gate.id,
          status: args?.approve === true ? 'accepted' : 'rejected',
          body: { gate: gate.id, label: gate.label, approve: args?.approve === true, note: args?.note ?? null, by: String(args?.by ?? 'local') },
        })
        let moved = ''
        if (args?.approve === true && found.run.status === 'waiting_human') {
          setRunStatus(store, found.run.id, 'running')
          moved = '\n运行已从 waiting_human 回到 running。'
        }
        return `门禁裁决已记录: ${gate.label} → ${args?.approve === true ? '批准' : '驳回'}（${artifact.id}）`
          + (args?.note ? `\n理由: ${args.note}` : '') + moved
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

/**
 * 裁决一个草案产物：接受 / 驳回（§11 草案级人工控制）。
 *
 * 这是把草案从 `draft` 推走的**唯一**入口。它要求一个非空的 `by` —— 一条没有署名的
 * 裁决正是 §11 禁掉的「需要确认」形状；并把这次处置追加成一条 `artifact-decision`
 * 产物（自报的 `by` / 为什么 / 何时），而不是覆盖被裁决产物的历史。裁决**不改**草案正文。
 * `by` 是自报标签而不是认证身份：本阶段没有用户表。
 */
export function agentArtifactDecideTool({ store }) {
  const RECOVERY = '产物 id 在运行视图（工作台 Agent 页签）里；先用 amzn_agent_run_list 找到运行，'
    + '再点开它看产物清单。'
  return {
    name: 'amzn_agent_artifact_decide',
    description:
      'Record a disposition of one draft artifact: accept it (accept: true) or reject it (accept: false). '
      + 'This is the human half of §11\'s 草案级控制 — amzn_agent_artifact_save only writes draft, so a draft can only '
      + 'leave draft through this tool. It requires `by` (an unattributed decision is refused) and appends an '
      + 'artifact-decision artifact carrying who / why / when. `by` is a **self-declared label, not an authenticated '
      + 'identity**: this phase has no user table, so the value is recorded as given and proves nothing about who ran it '
      + '(the page path records the actor as `page`). '
      + 'The decided artifact\'s body is **not** modified when `body` is omitted: a decision is not an edit. '
      + 'Pass `body` for the third option §11 names — 修改后接受: the plugin writes a **new version** (parentId) carrying '
      + 'your edited body, marks the old draft superseded, and accepts the new one, so the store can answer "who wrote '
      + 'the body that was accepted". `body` with accept:false is refused — 修改后驳回 is not in §11; amend-then-accept '
      + 'and reject are two separate acts. A decision is append-only — deciding an already-decided artifact is refused; '
      + 'make a new version (parentId) instead.',
    parameters: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'The draft artifact to decide.' },
        accept: { type: 'boolean', description: 'true to accept, false to reject.' },
        note: { type: 'string', description: 'Why — recorded with the decision.' },
        by: { type: 'string', description: 'A self-declared label for who decided (no user table this phase — recorded as given, not authenticated). Required: an unattributed decision is not a decision (§11).' },
        body: {
          type: 'object',
          description: 'Optional. The **edited** body — this is 修改后接受 (§11\'s third option): a new version '
            + 'carrying this body is written, the old draft is marked superseded, and the new version is accepted. '
            + 'Requires accept: true. Omit it for a plain accept/reject (the body is then untouched). '
            + 'Pass null to accept a body you deliberately emptied — null is a real body, absence is not.',
        },
      },
      required: ['artifactId', 'accept', 'by'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const artifactId = String(args?.artifactId ?? '').trim()
      if (artifactId === '') {
        return { ok: false, error: 'artifactId is required', hint: RECOVERY }
      }
      if (typeof args?.accept !== 'boolean') {
        return { ok: false, error: 'accept must be true (接受) or false (驳回)', hint: RECOVERY }
      }
      const by = String(args?.by ?? '').trim()
      if (by === '') {
        return {
          ok: false,
          error: 'by is required — an unattributed decision is not a decision (§11)',
          hint: '填上做这次裁决的人（本仓没有用户表：权限层级只是枚举占位，写你在用的名字即可）。',
        }
      }
      /* `body` 的判据是 `!== undefined`，**不是** `!== null`：`null` 是合法正文
         （人把正文清空是一次真实的修改），`undefined` 才是「没传这个键」。
         写成 `args?.body != null` 会把「清空正文」洗成「没改」—— 本仓最忌的形状。
         ⚠️ 也不要拿 `body` 的存在去**推断** `accept`：`accept` 有它自己的判据（上面那条），
         两者各自独立判断，谁也替代不了谁。 */
      const hasBody = args?.body !== undefined
      if (hasBody && args.accept !== true) {
        return {
          ok: false,
          error: 'body is only meaningful with accept: true — 修改后驳回不在 §11 里',
          hint: '§11 的草案级只有三个选项：接受 / 修改后接受 / 驳回。'
            + '要「改完再驳回」请分两步：先修改后接受，或直接驳回。',
        }
      }
      try {
        if (hasBody) {
          const { artifact, decision, superseded, supersededVersion } = amendAndAcceptArtifact(store, {
            artifactId, body: args.body, note: args?.note ?? null, by,
          })
          return `产物裁决已记录: ${artifact.type} v${artifact.version} → ${artifact.status}（${decision.id}）`
            + `\n裁决人: ${by}`
            + (args?.note ? `\n理由: ${args.note}` : '')
            + `\n改后接受 —— 正文已按修改写入新版本；已取代 v${supersededVersion}（${superseded}）`
        }
        const { artifact, decision } = decideArtifact(store, {
          artifactId, accept: args.accept, note: args?.note ?? null, by,
        })
        return `产物裁决已记录: ${artifact.type} v${artifact.version} → ${artifact.status}（${decision.id}）`
          + `\n裁决人: ${by}`
          + (args?.note ? `\n理由: ${args.note}` : '')
          + '\n草案正文未改动 —— 裁决不是编辑。'
      } catch (error) {
        return { ok: false, error: error.message, hint: RECOVERY }
      }
    },
  }
}

/**
 * §14 的十项指标：算得出来的给数字（**带分母**），算不出来的写明**缺哪份记录**。
 *
 * 只读工具 —— 它存在的理由是同一份答案在会话侧也要能问到，而不是只画在页面上。
 * 口径（只对终态运行取平均、采纳率按裁决记录数）写在 `domain/agent/metrics.js` 的
 * 文件头，这里不再重复一份。
 */
export function agentMetricsTool({ store }) {
  return {
    name: 'amzn_agent_metrics',
    description:
      'Read module 12 §14\'s ten metrics. Three are computable today and come back with their numerator and '
      + 'denominator (a percentage without its denominator lies when the sample is one or two); the other seven come '
      + 'back as unavailable, each naming the record that is missing — a table, a column, a pass-through — rather '
      + 'than saying "not implemented". Read-only: it writes nothing and is not audited.',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: (_args, value) => text(value) },
    execute() {
      const model = agentMetrics(store)
      const lines = [
        '模块 12 §14 指标（本版只给算得出来的数字；算不出来的写明缺哪份记录）',
        '',
        `算得出来的 ${model.computed.length} 项:`,
      ]
      for (const metric of model.computed) {
        lines.push(`  ${metric.label}: ${metric.display}（${metric.numerator} / ${metric.denominator}）`)
        lines.push(`    ${metric.note}`)
      }
      lines.push('')
      lines.push(`本版算不出来的 ${model.unavailable.length} 项（缺的是记录，不是「未实现」）:`)
      for (const metric of model.unavailable) {
        lines.push(`  ${metric.label}: ${metric.why}`)
        lines.push(`    缺: ${metric.missing}`)
      }
      return lines.join('\n')
    },
  }
}

/** Every role as the page draws it — declared or not. */
export function roleView() {
  return AGENT_ROLES.map(role => ({
    id: role.id,
    label: role.label,
    duty: role.duty,
    available: role.available === true,
    why: role.why ?? null,
    steps: role.steps,
    forbidden: role.forbidden,
    gates: role.gates,
  }))
}

/**
 * §0 那九个「无数据来源」的要素，随角色一起下发。
 *
 * ## 为什么挂在 `roleView` 上，而不是新开一个工具
 *
 * 契约冻结了「块 C 不加新工具」：加工具要**两处注册表同步**，还会动一批计数断言，
 * 代价远大于收益。可这九个要素本来就**关于角色**（F12-02 的五个全是角色级声明，
 * F12-03 的四个是运行产出，而运行由角色驱动），所以它们跟着角色视图走是最自然的
 * 位置 —— 页面已经在 `routes.js` 的 `agentState` 里调 `roleView()`，会话侧也能从
 * 同一条路读到，**零新工具、零新注册表**。
 *
 * 它**只读**，不写库、不进审计（与 `metrics` 同一条规矩）。
 */
export function agentGapView() {
  return {
    summary: AGENT_GAP_SUMMARY,
    count: AGENT_GAP_COUNT,
    elements: AGENT_GAP_ELEMENTS,
  }
}

/**
 * 发布一版角色配置（F12-02）。**追加**，不覆盖。
 *
 * ## 为什么叫 `_release` 而不是契约里的 `_publish`
 *
 * 工作台有一条工具命名守卫（`tests/m14-observation.mjs` 等三处逐字）：
 * 工具名去掉 `amzn_` 之后不许含 `publish|apply|push|deploy` —— 那是 §15 「插件不发布到
 * 线上」的机械落点。本仓已有两条为它改名的先例（`_batch` 而不是 `_apply`、
 * `_decide` 而不是 `_approve`）。这里发布的是**本地库里的角色配置版本**，一个字都不碰
 * 线上 listing，所以用一个既不误导、又过得去守卫的词：`release`。
 *
 * ## 它写什么
 *
 * `publishRoleConfig`（`store/agent-config.js`）追加 `v = MAX+1` 一行，**永不 UPDATE 旧行**。
 * 传进来的 `config` 可以只写要改的字段（其余沿用当前版本）。失败一律 `{ok:false, error, hint}`。
 */
export function agentRoleConfigReleaseTool({ store }) {
  const RECOVERY = '角色清单用 amzn_agent_role_config_list 看；某一版的完整内容用 amzn_agent_role_config_show。'
  return {
    name: 'amzn_agent_role_config_release',
    description:
      'Release a new version of a role\'s configuration (F12-02). This **appends** a version '
      + '(v = max + 1) and never updates an older one, so a run that froze an earlier version keeps '
      + 'resolving to it. `config` may carry only the fields you are changing; the rest are inherited '
      + 'from the role\'s current version (an omitted field means "unchanged", so pass [] / null '
      + 'explicitly to clear one). This only versions the role declaration in the local database — it '
      + 'publishes nothing to Seller Central and changes no listing. Named `_release` rather than '
      + '`_publish` because the workbench refuses any tool name containing publish/apply/push/deploy '
      + '(§15). Changing `tools` here changes the whitelist the next run declares; changing `maxSteps` '
      + 'caps the step numbers `amzn_agent_run_step` will accept for runs started after this version. '
      + 'To roll back: read the older version with amzn_agent_role_config_show and release its config as a '
      + 'new version — versions are never overwritten, so "rollback" is another append, not a delete.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role id, e.g. data-steward / keyword-research / pipeline-maintenance.' },
        config: {
          type: 'object',
          description: 'The role declaration fields to change (merged over the current version). May include '
            + 'available / steps / tools / forbidden / gates / reads / promptModule / onFailure / maxSteps.',
        },
        note: { type: 'string', description: 'Why this version exists — recorded on the row.' },
        by: { type: 'string', description: 'A self-declared label for who released it (no user table this phase). Recorded on the audit row, not the config row.' },
      },
      required: ['role', 'config'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const published = publishRoleConfig(store, {
        role: args?.role,
        config: args?.config,
        note: args?.note ?? null,
        by: args?.by ?? null,
      })
      if (published.ok !== true) return published
      return `角色配置已发布: ${published.role} → v${published.version}（${published.id}）`
        + (published.note ? `\n说明: ${published.note}` : '')
        + `\n这一版声明 ${published.config.tools.length} 个工具`
        + ` · 允许读 ${published.config.reads.join('/') || '（未声明）'}`
        + ` · 失败策略 ${published.config.onFailure}`
        + ` · 步骤上限 ${published.config.maxSteps ?? '（未声明）'}`
        + '\n新增的是**追加**的一版：旧版本一字未动，跑在旧版上的运行仍然读得到它。'
        + `\n${RECOVERY}`
    },
  }
}

/** 角色配置版本清单（只读）。给 `role` 就列它的每一版；不给就列每个角色的当前版本。 */
export function agentRoleConfigListTool({ store }) {
  return {
    name: 'amzn_agent_role_config_list',
    description:
      'List role configuration versions (F12-02). With `role`: every version of that role, newest '
      + 'first. Without it: each declared role\'s current version and how many versions exist. '
      + 'Read-only. A role with no version at all is shown as such rather than as version 0.',
    parameters: {
      type: 'object',
      properties: { role: { type: 'string', description: 'Optional role id. Omit to list every role.' } },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    execute(args) {
      const wanted = String(args?.role ?? '').trim()
      if (wanted !== '') {
        const definition = roleById(wanted)
        if (definition === undefined) {
          return `没有这个角色：${wanted}。已声明的角色：${AGENT_ROLES.map(role => role.id).join(' | ')}`
        }
        const versions = listRoleConfigVersions(store, wanted)
        if (versions.length === 0) {
          return `角色 ${wanted}（${definition.label}）还没有任何配置版本 —— `
            + '没有任何东西可以列（这不是「有 0 版」）。'
        }
        return [
          `角色 ${wanted}（${definition.label}）共 ${versions.length} 个版本（最新在前）:`,
          '',
          table(versions, [
            { label: '版本', value: row => `v${row.version}` },
            { label: '工具数', value: row => row.config.tools.length },
            { label: '允许读', value: row => row.config.reads.join('/') },
            { label: '失败策略', value: row => row.config.onFailure },
            { label: '步骤上限', value: row => row.config.maxSteps ?? '（未声明）' },
            { label: '说明', value: row => row.note ?? '' },
            { label: '发布', value: row => String(row.createdAt).slice(0, 19).replace('T', ' ') },
          ]),
        ].join('\n')
      }
      const rows = AGENT_ROLES.map(role => {
        const latest = latestRoleConfig(store, role.id)
        const count = listRoleConfigVersions(store, role.id).length
        return { id: role.id, label: role.label, latest: latest?.version ?? null, count, available: role.available === true }
      })
      return [
        `总共 ${rows.length} 个角色（当前版本来自 agent_role_config，不是代码声明）:`,
        '',
        table(rows, [
          { label: '角色', value: row => row.id },
          { label: '名称', value: row => row.label },
          { label: '当前版本', value: row => row.latest === null ? '（还没有配置版本）' : `v${row.latest}` },
          { label: '版本数', value: row => row.count },
          { label: '代码声明可用', value: row => row.available ? '是' : '否' },
        ]),
      ].join('\n')
    },
  }
}

/** 一版角色配置的完整内容（只读）。默认取当前版本。 */
export function agentRoleConfigShowTool({ store }) {
  return {
    name: 'amzn_agent_role_config_show',
    description:
      'Show one version of a role\'s configuration (F12-02) — the current version by default, or a '
      + 'specific `version`. Read-only. It answers the three different "nothing" cases separately: '
      + 'the role is not declared / the role has no version yet / that version does not exist.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role id.' },
        version: { type: 'number', description: 'Which version. Omit for the current (newest) one.' },
      },
      required: ['role'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    execute(args) {
      const wanted = String(args?.role ?? '').trim()
      const definition = roleById(wanted)
      if (definition === undefined) {
        return `没有这个角色：${wanted}。已声明的角色：${AGENT_ROLES.map(role => role.id).join(' | ')}`
      }
      const asked = args?.version
      const row = asked === undefined || asked === null
        ? latestRoleConfig(store, wanted)
        : roleConfigVersion(store, wanted, asked)
      if (row === null) {
        const existing = listRoleConfigVersions(store, wanted).map(entry => `v${entry.version}`)
        if (asked === undefined || asked === null) {
          return `角色 ${wanted} 还没有任何配置版本（没有可展示的内容）。`
        }
        return `角色 ${wanted} 没有 v${asked}。`
          + (existing.length === 0 ? '（它还没有任何版本）' : `现有：${existing.join(' / ')}`)
      }
      const config = row.config
      const list = (value) => Array.isArray(value) && value.length > 0 ? value.join(', ') : '（空 / 未声明）'
      return [
        `角色 ${wanted}（${config.label}）配置 v${row.version}`,
        `发布: ${String(row.createdAt).slice(0, 19).replace('T', ' ')}`
          + (row.note ? `    说明: ${row.note}` : ''),
        '',
        `职责: ${config.duty}`,
        `可用: ${config.available === true ? '是' : `否 — ${config.why ?? '（没写原因）'}`}`,
        `步骤契约: ${list(config.steps)}`,
        `允许的工具: ${list(config.tools)}`,
        `禁止: ${list(config.forbidden)}`,
        `门禁: ${list(config.gates)}`,
        `允许读取的数据: ${list(config.reads)}`,
        `默认提示词模块: ${config.promptModule ?? '（未声明 —— null 不是「空模块」）'}`,
        `失败策略: ${config.onFailure}（声明式：插件不驱动 Agent，它只影响页面措辞与 retryable 默认值，不会自动降级）`,
        `步骤上限: ${config.maxSteps ?? '（未声明 —— null 不是 0）'}`,
        '',
        `下发工具范围（含只读地板，${toolsFromRoleConfig(config).length} 个）: ${toolsFromRoleConfig(config).join(', ')}`,
      ].join('\n')
    },
  }
}

/**
 * 记下一条**补充数据请求**（F12-03，需求 §4：「需要新数据时发起补充数据请求，
 * **不能自行扩大范围**」）。
 *
 * ⚠️ **插件不补数据。** 它不驱动 Agent，所以这条工具只把「这次运行缺什么、为什么缺」
 * 记成一条**记录**给会话 / 人看。**没有任何东西会因为这条请求被创建而去补数据** ——
 * 谁把它读成「插件会去补」，就是这个缺陷形状的新一次。
 */
export function agentDataRequestTool({ store }) {
  const RECOVERY = '运行 id 用 amzn_agent_run_list 看；这次运行缺什么就写进 what。'
  return {
    name: 'amzn_agent_data_request',
    description:
      'Record one supplementary-data request for a run (F12-03, requirement §4: when new data is needed, '
      + 'raise a request instead of widening the run\'s scope by itself). This writes a **record** — a row '
      + 'saying what is missing and why — for the conversation / a person to read. ⚠️ This plugin does **not** '
      + 'fetch the data and does not drive the agent: nothing changes as a result of raising a request. '
      + '`what` is required; `why` is optional (omit it to mean "not stated"; an empty string is refused). '
      + 'The request starts `open`; it is closed with amzn_agent_data_request_resolve.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The run this request belongs to.' },
        what: { type: 'string', description: 'What data is missing, e.g. 产品线归属表 / 近 30 天广告报告.' },
        why: { type: 'string', description: 'Why it is needed. Omit to mean "not stated"; an empty string is refused.' },
      },
      required: ['runId', 'what'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const opened = openDataRequest(store, { runId: args?.runId, what: args?.what, why: args?.why ?? null })
      if (opened.ok !== true) return opened
      const request = opened.request
      return `补充数据请求已记录: ${request.id}（${request.status}）`
        + `\n运行: ${request.runId}`
        + `\n要什么: ${request.what}`
        + (request.why ? `\n为什么: ${request.why}` : '')
        + '\n⚠️ 这是一条**记录**：本插件不驱动 Agent，不会因为这条请求去补数据。'
        + '\n结清用 amzn_agent_data_request_resolve（fulfilled / declined）。'
        + `\n${RECOVERY}`
    },
  }
}

/** 列补充数据请求（只读）。给了 `runId` 只看那次运行，不给看全部。 */
export function agentDataRequestListTool({ store }) {
  return {
    name: 'amzn_agent_data_request_list',
    description:
      'List supplementary-data requests (F12-03). With `runId`: just that run\'s requests. Without: all of '
      + 'them, newest first. Read-only. It answers the three different "nothing" cases separately: that run '
      + 'has no request / the whole table is empty / there is no such run.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Optional run id. Omit to list every request.' } },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    execute(args) {
      const given = String(args?.runId ?? '').trim()
      const listed = listDataRequests(store, { runId: given === '' ? null : given })
      if (given !== '' && listed.runExists === false) {
        return `没有这次运行：${given}。`
          + `（这与「这次运行没有请求」不是一件事 —— 那是一次真的运行，只是没有请求。）`
      }
      if (listed.rows.length === 0) {
        if (given === '') {
          return listed.total === 0
            ? '全库还没有任何补充数据请求（0 条）。'
            : `全库有 ${listed.total} 条请求，但这次查询没取到（异常）。`
        }
        return listed.total === 0
          ? `运行 ${given} 没有请求，全库也还没有任何请求（一共 0 条）。`
          : `运行 ${given} 没有请求；全库共 ${listed.total} 条，都在别的运行上。`
      }
      return [
        given === '' ? `全部 ${listed.rows.length} 条补充数据请求（最新在前）:` : `运行 ${given} 的 ${listed.rows.length} 条补充数据请求:`,
        '',
        table(listed.rows, [
          { label: '请求', value: row => row.id },
          { label: '运行', value: row => row.runId },
          { label: '要什么', value: row => row.what },
          { label: '为什么', value: row => row.why ?? '' },
          { label: '状态', value: row => row.status },
          { label: '怎么结的', value: row => row.resolution ?? '' },
          { label: '开于', value: row => String(row.openedAt).slice(0, 19).replace('T', ' ') },
        ]),
        '',
        '⚠️ 这些是**记录**：本插件不驱动 Agent，不会因为一条请求去补数据。',
      ].join('\n')
    },
  }
}

/** 结清一条补充数据请求（只读之外的写；`open` 不是一次结清）。 */
export function agentDataRequestResolveTool({ store }) {
  const RECOVERY = '请求 id 用 amzn_agent_data_request_list 看。'
  return {
    name: 'amzn_agent_data_request_resolve',
    description:
      'Close one supplementary-data request (F12-03): fulfilled (the data arrived) or declined (it will not). '
      + '`open` is the state a request starts in, not a way to close it, so it is refused here. A request is '
      + 'closed once — resolving an already-closed request is refused. ⚠️ Closing a request records a fact; '
      + 'this plugin still does not fetch anything.',
    parameters: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Which request to close.' },
        status: { type: 'string', enum: AGENT_DATA_REQUEST_RESOLUTIONS, description: 'fulfilled or declined.' },
        resolution: { type: 'string', description: 'How it was closed — who supplied it / why it was declined. Omit to mean "not stated"; an empty string is refused.' },
      },
      required: ['requestId', 'status'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const done = resolveDataRequest(store, {
        requestId: args?.requestId, status: args?.status, resolution: args?.resolution ?? null,
      })
      if (done.ok !== true) return done
      return `补充数据请求 ${done.request.id} → ${done.request.status}`
        + `\n要什么: ${done.request.what}`
        + (done.request.resolution ? `\n怎么结的: ${done.request.resolution}` : '')
        + `\n${RECOVERY}`
    },
  }
}

/**
 * 被命名的约定产物类型（F12-03）。随 agent state 一起下发，页面照它画「这次有没有质量摘要」。
 *
 * ⚠️ 它是**清单**不是闭集：列表之外的 `type` 照样合法（见 `artifact-types.js` 的文件头）。
 * 页面**不自己写一份**类型名 —— 一句事实活在两个文件里就是本仓记过的那条教训。
 */
export function agentArtifactConventions() {
  return { types: CONVENTIONAL_ARTIFACT_TYPES, qualitySummaryType: QUALITY_SUMMARY_TYPE }
}

/** One role, or `undefined`. Re-exported so the page slice imports one module. */
export { roleById }

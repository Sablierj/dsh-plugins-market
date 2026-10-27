/**
 * 模块 12 §14 的十项指标。
 *
 * 需求原文（逐字抄在这里，供对表 —— 模型的 `computed` + `unavailable` 必须正好覆盖它）：
 *
 *   任务成功率、平均步骤、重试率、人工等待时间、无证据结论数、越权调用、上下文遗漏、
 *   草案采纳率、每次运行成本和恢复成功率。
 *
 * ## 只给「算得出来」的数字，算不出来的逐条说明缺哪份记录
 *
 * 把十项都画成数字，是这个项目最怕的缺陷形状：**把「缺失」渲染成「真实值」**。
 * 所以这一版：
 *
 *   - 算得出来的（3 项）给 `value` **和** `numerator` / `denominator`。分母必须一起
 *     给出去 —— 一个没有分母的百分比在样本只有一两次时会撒谎（1/1 和 90/90 都写
 *     「100%」）。`display` 由**这里**格式化，页面只渲染它，不自己算百分比
 *     （与 B-12.1 的 `pendingReason` 同一条规矩：一句事实只活在一处）。
 *   - 算不出来的（7 项）`missing` 必须**指名缺的那份记录**（一张表 / 一列 / 一次透传），
 *     不是「未实现」三个字。缺的是记录，读者才知道要补什么。
 *
 * 覆盖守卫（`tests/b12-2-agent-metrics.mjs`）断言两边加起来**正好十项**、id 与 §14
 * 逐字对应 —— 谁悄悄丢掉一项，测试就红。这里还有一道运行期兜底：`AGENT_METRIC_IDS`
 * 里出现一个既没 builder、也没理由的 id 时**直接抛**，因为「一项指标静默消失」比
 * 「报错」难查得多。
 *
 * ## 两个口径决定（写在这里，免得以后重新讨论）
 *
 * 1. **平均步骤只对终态运行取平均。** 一次还在跑的运行只有部分步骤，把它平均进去，
 *    得到的数字既不表示「典型完成的任务」，也不表示别的东西。分母 = 终态运行数，
 *    随输出一起给出。
 * 2. **草案采纳率按裁决记录数，不按被裁决产物当前的 `status` 列。** 那个列会被后来的
 *    版本覆盖：一条 `rejected` 的草案之后被 supersede，就会从「按 status 统计」里
 *    **静默消失**，采纳率凭空变好看。裁决记录（`type = 'artifact-decision'`）是
 *    **追加式**的 —— B-12.1 正是为此把它做成记录 —— 所以它才是这个比例的事实来源。
 */

import { TERMINAL_RUN_STATUSES } from './roles.js'

/** §14 的十项，顺序与需求逐字一致。模型必须正好覆盖它。 */
export const AGENT_METRIC_IDS = [
  'task_success_rate',
  'average_steps',
  'retry_rate',
  'human_wait_time',
  'unevidenced_conclusions',
  'out_of_scope_calls',
  'context_omissions',
  'draft_adoption_rate',
  'cost_per_run',
  'recovery_success_rate',
]

/** 十项的中文名，逐字取自 §14。 */
export const AGENT_METRIC_LABELS = {
  task_success_rate: '任务成功率',
  average_steps: '平均步骤',
  retry_rate: '重试率',
  human_wait_time: '人工等待时间',
  unevidenced_conclusions: '无证据结论数',
  out_of_scope_calls: '越权调用',
  context_omissions: '上下文遗漏',
  draft_adoption_rate: '草案采纳率',
  cost_per_run: '每次运行成本',
  recovery_success_rate: '恢复成功率',
}

/** 分母为 0 时页面与工具显示的那句话 —— 由服务端给出，页面不自己编。 */
export const NOTHING_TO_COMPUTE = '还没有可计算的数字（分母是 0）'

/**
 * 本版算不出来的七项。`missing` 是**缺的那份记录**，不是「未实现」。
 *
 * 每一句都指到具体的表 / 列 / 透传，理由是：写「未实现」的指标表和一张空表长得一样，
 * 而这两种情况要读者做的事完全不同 —— 一个是「去补记录」，一个是「去写代码」。
 */
const UNAVAILABLE_REASONS = {
  retry_rate: {
    why: '一次步骤被重试过几次，库里没有这个数字。',
    missing: '「同一步骤的重试次数」：`recordStep` 在 UNIQUE (run_id, seq) 上 upsert，重试覆盖同一行，'
      + '`agent_step` 没有 attempt 计数列。',
  },
  human_wait_time: {
    why: '运行在 waiting_human 上停了多久，算不出来。',
    missing: '「进入 waiting_human 的时刻」：`setRunStatus` 只在终态写 `finished_at`，'
      + '`agent_run` 没有状态变更时间线（进入 / 离开每个状态的时刻）。',
  },
  unevidenced_conclusions: {
    why: '产物里哪一段是结论、它有没有证据，没有约定。',
    missing: '「结论 / 证据」的约定：产物 `body_json` 是自由结构，没有标记哪一部分是结论，'
      + '也没有一个证据字段可以判空。',
  },
  out_of_scope_calls: {
    why: '越权调用（调了不在声明范围内的工具）没有被记下来。',
    missing: '「这次调用属于哪次运行」：非 Agent 工具不知道自己在哪次运行里，'
      + '没有把 runId 透传进工具调用，所以无法把一次调用归到某次运行的声明范围上比对。',
  },
  context_omissions: {
    why: '上下文遗漏（该带的事实没带进上下文包）没有可比对的清单。',
    /* 这条 missing 原来写的是「§5 的任务类型未实现，没有『每个任务类型的必需上下文』清单」。
       **前半句过期了**：任务类型在 v45（agent-run-task-type）交付 —— `AGENT_TASK_TYPES` 六类、
       `agent_run.task_type` 可空、`amzn_agent_run_start` 收 type；上下文包从 v30 起是
       `agent_run` 上的七个不可变项（不是一张 `context_package` 表，那一类在快照登记里
       零行、理由在 store/snapshot.js）。仍然缺的是后半句：没有任何地方声明「每一类任务
       必需带哪些上下文」，所以没有清单可以拿来比对上下文包缺了什么 —— 缺的是**判据**。 */
    missing: '「该有哪些」的清单：任务类型本身已在（`AGENT_TASK_TYPES` 六类 + `agent_run.task_type` 列，'
      + 'v45），上下文包也在（`agent_run` 上的七个不可变项）；缺的是「每一类任务类型的必需上下文」'
      + '这份声明 —— 没有它，就没有东西可以拿来比对上下文包缺了什么。',
  },
  cost_per_run: {
    why: '本版不接 LLM，没有任何 token / 费用记录。',
    missing: '成本来源：`agent_run` 没有 token / 费用列，插件也不调用任何计费的模型接口 ——'
      + '没有数字可加。',
  },
  recovery_success_rate: {
    why: '有没有发生过中断 / 恢复，没有记录。',
    missing: '「一次运行被恢复过」的记录：`agent_run` 没有恢复次数 / 恢复结果列，'
      + '恢复与否在库里看不出区别。',
  },
}

/** 算得出来的三项的 builder。key 必须是 §14 的 id。 */
const COMPUTED_BUILDERS = {
  task_success_rate: ({ completed, terminal }) => ({
    value: terminal === 0 ? null : completed / terminal,
    unit: 'ratio',
    numerator: completed,
    denominator: terminal,
    note: '分母 = 已到终态（completed / failed / cancelled）的运行数；还在跑的不算，'
      + '它既不是成功也不是失败。',
  }),
  average_steps: ({ stepTotal, terminal }) => ({
    value: terminal === 0 ? null : stepTotal / terminal,
    unit: 'steps',
    numerator: stepTotal,
    denominator: terminal,
    note: '只对终态运行取平均：还在跑的运行只有部分步骤，平均进去得到的数字不代表任何东西。',
  }),
  draft_adoption_rate: ({ accepted, decided }) => ({
    value: decided === 0 ? null : accepted / decided,
    unit: 'ratio',
    numerator: accepted,
    denominator: decided,
    note: '按**裁决记录**数（type = artifact-decision）而不是被裁决产物当前的 status：'
      + '那个列会被后来的版本覆盖，一条 rejected 草案被 supersede 后会静默消失。'
      + '裁决记录是追加式的。',
  }),
}

/** ratio 显示成一位小数的百分比，steps 显示原值；分母为 0 时是那句诚实话。 */
function displayFor(value, unit) {
  if (value === null) return NOTHING_TO_COMPUTE
  if (unit === 'ratio') return (value * 100).toFixed(1) + '%'
  return String(value)
}

/**
 * §14 的十项指标，算得出来的给数字 + 分母，算不出来的给「缺哪份记录」。
 *
 * 只读：不写库、不进审计（`WRITE_TARGETS['amzn_agent_metrics']` 显式 null）。
 */
export function agentMetrics(store) {
  /* 终态运行的步骤数。一次查询取回 (status, 步骤数)，在 JS 里求和 —— 这样
     「0 步的终态运行」也计入分母（子查询 AVG 会把它漏掉，平均会偏高）。 */
  const placeholders = TERMINAL_RUN_STATUSES.map(() => '?').join(', ')
  const terminalRuns = store.all(
    `SELECT r.status AS status,
            (SELECT COUNT(*) FROM agent_step s WHERE s.run_id = r.id) AS steps
       FROM agent_run r
      WHERE r.status IN (${placeholders})`,
    TERMINAL_RUN_STATUSES,
  )
  const terminal = terminalRuns.length
  const completed = terminalRuns.filter(row => row.status === 'completed').length
  const stepTotal = terminalRuns.reduce((sum, row) => sum + Number(row.steps ?? 0), 0)

  /* 裁决记录按 status 分组。追加式记录 —— 见文件头的口径决定 2。 */
  const decisionRows = store.all(
    "SELECT status, COUNT(*) AS n FROM agent_artifact WHERE type = 'artifact-decision' GROUP BY status",
  )
  const decisionsBy = status => Number(decisionRows.find(row => row.status === status)?.n ?? 0)
  const accepted = decisionsBy('accepted')
  const decided = accepted + decisionsBy('rejected')

  const facts = { completed, terminal, stepTotal, accepted, decided }
  const computed = []
  const unavailable = []
  for (const id of AGENT_METRIC_IDS) {
    const label = AGENT_METRIC_LABELS[id]
    const build = COMPUTED_BUILDERS[id]
    if (build !== undefined) {
      const metric = build(facts)
      computed.push({
        id,
        label,
        value: metric.value,
        unit: metric.unit,
        numerator: metric.numerator,
        denominator: metric.denominator,
        /* 服务端格式化，页面只渲染 —— 页面没有自己的百分比算法。 */
        display: displayFor(metric.value, metric.unit),
        note: metric.note,
      })
      continue
    }
    const reason = UNAVAILABLE_REASONS[id]
    if (reason === undefined) {
      /* 「一项指标静默消失」比报错难查得多。 */
      throw new Error(`metric ${id} is neither computable nor has a documented missing record`)
    }
    unavailable.push({ id, label, why: reason.why, missing: reason.missing })
  }

  return { computed, unavailable, total: AGENT_METRIC_IDS.length }
}

/**
 * 模块 12 的角色、门禁与状态词表。
 *
 * ## 代码是**默认值**，配置版本在库里（F12-02）
 *
 * `agent_run.role` 存的是这里的 id，`agent_run.role` 不做外键：库记事实，代码记**默认声明**。
 *
 * ⚠️ **本批（F12-02）之前**这句话是「角色本身没有落库」。**现在不对了**：角色的声明
 * 会按版本落进 `agent_role_config`（`store/agent-config.js` 播种 v1，发布新版只追加），
 * 一次运行把**当时的版本**冻结进 `agent_run.role_config_version` / `role_config_json`。
 * 所以代码与库**确实有两份**，这是**有意的**，不是本仓一贯避免的那种「两份会漂的声明」：
 *
 *   - 代码里这一份是**默认值**（`seedRoleConfigs` 只在角色**还没有任何版本**时播种 v1）；
 *   - 库里那一份是**事实**（发布过一次之后，代码改这个对象**不会**改变已发布的版本）；
 *   - 谁是当前版本由 `MAX(version)` 推导，唯一；运行冻结的是它当时读到的那一版。
 *
 * 因此：**读角色当前声明（工具集、允许数据、失败策略…）要走配置，不要读这个常量**。
 * `toolsForRole` 已经这么做了（见文件末尾）。这个常量仍然是**种子来源**与不可用角色的
 * 「为什么不可用」的登记处，但不再是「运行实际用哪套工具」的答案。
 *
 * ### ⚠️ B-12.10 的边界：订正 `why` 文案时，页面与配置面**不会同时**更新
 *
 * 不可用角色的 `why` 也是**代码声明**：`roleView()`（`src/tools/agent.js`）直接读
 * `AGENT_ROLES`，所以**页面角色表会立即显示新文案**。**但** `roleConfigOf`（本文件末尾）
 * 把 `why` 也收进配置载荷，而 `seedRoleConfigs`（`src/store/agent-config.js`）**只播种
 * v1、且已有版本一律不覆盖**（`index.js` 的 apply 只在 `MAX(version) IS NULL` 时播种）。
 * ⇒ **已经播种过的库行里仍是旧文案**，`amzn_agent_role_config_show` / `_list` 会显示旧文案。
 *
 * 本批**不做数据写入**（发布 v2 是运行期动作，走既有的 `amzn_agent_role_config_release`），
 * 所以「页面（代码）与配置面（库）不一致」是一条**已知边界，不是「没问题」**：
 * 要让配置面也更新，得真的发布一版新配置。把这条写在这里，是因为下一个人改这四个 `why`
 * 时，会以为改完代码就万事大吉 —— 而 `_show` 会拿着旧文案反驳他。
 *
 * ## 九个角色都可用（2026-10-21 补齐）
 *
 * 第一版按 §17-1 只落地三个角色；2026-10-21 把剩下六个的步骤与工具补齐，
 * 现在**九个**角色都是 `available: true`。补齐的是**声明**（steps / tools / reads /
 * promptModule / onFailure / maxSteps），不是新的执行引擎 —— 插件仍然只做确定性查询、
 * 校验与本地写入，真正的分析与生成由 DSH Agent 在会话侧完成（§13 的分工）。
 *
 * 六个角色各自的边界写在 `forbidden` 里，其中两条值得单独记住：
 * `copywriter` **不另建草案写入路径**（只走模块 13 的 amzn_optimize_*），
 * `compliance-reviewer` **不替人做发布决定**（只出违规/警告/待确认）。
 *
 * 九个角色这一版**不接 LLM**：交付的是编排骨架 + 留痕 + 门禁。每个角色声明
 * 它的步骤序列与允许的工具，真实的分析与生成由 DSH Agent 在会话侧完成（§13 的
 * 分工），插件负责确定性查询、校验与本地写入。所以 `steps` 是**会话侧 Agent 的
 * 回报契约**：Agent 按它逐步回报，工具与页面据它渲染进度。
 *
 * 但要说清楚：本插件**不校验**这份序列 —— `recordStep`（`src/store/agent.js`）
 * 只按 `seq` upsert 一行，`step` 名**不在** `role.steps` 里也**不拒绝**，顺序不检查，
 * 也不触发下一步。全仓没有一条代码因为 `steps` 而拒绝任何东西；它约束的是会话侧
 * Agent 与页面的读法，不是这里的写路径。把这份序列读成插件在跑的校验，会让人以为
 * 插件兜住了它 —— 那正是文件头下面「工具集是声明的范围」警告的同一种形状。
 *
 * ## 工具集是**声明的范围**，不是强制边界
 *
 * `tools` 声明这次运行该带哪些工具，并随 `amzn_agent_run_start` 的返回**下发给调用方**。
 * §8 把工具分四级，只读与本地写入在这一版可用，高影响动作要走门禁，外部动作
 * （Seller Central 发布）**当前禁用** —— §15-8 的验收就是「外部发布工具不在可用工具
 * 列表中」，所以这里连一个发布类工具都不列。
 *
 * 但要说清楚：本插件**不拦截**范围外的调用 —— 插件这边没有一条代码会因为一个工具不在
 * `tools` 里而拒绝它。是否有别的层（会话 / 宿主）按这份声明去拦，不在本仓能证明的范围
 * 内，所以这里**不**断言它。本插件真正强制的是 §15-2 的数据范围与 §15-4 的门禁
 * （`domain/agent/run.js` 的 `scopeRefusal` / `gateRefusal`）。把这份名单读成权限边界
 * 会让人以为插件兜住了它，而那正是「承诺了能力然后把它丢掉」的形状。
 */

/* ⚠️ 循环导入（roles.js ↔ store/agent-config.js）：`toolsForRole(store, id)` 要读库里的
   当前配置版本，而 `agent-config.js` 要读 AGENT_ROLES 来校验与播种。两个模块都**只在
   函数体里**用对方的导出（模块求值期不碰），所以 ESM 的循环在这一层是安全的 —— 调用
   发生时两边都已求值完毕。改动这两个文件时**不要**把这种用法提到顶层。 */
import { latestRoleConfig } from '../../store/agent-config.js'

/** 运行状态机（§6）。一条运行只能沿这些边移动，`domain/agent/run.js` 是判官。 */
export const AGENT_RUN_STATUSES = [
  'draft', 'ready', 'running', 'waiting_human', 'blocked', 'completed', 'failed', 'cancelled',
]

/** 每条步骤的状态（§6 末段）。 */
export const AGENT_STEP_STATUSES = ['pending', 'running', 'passed', 'failed', 'skipped']

/**
 * §5 六类任务类型。**词表与中文标签各只有一份** —— 页面与工具照它画，不写第二份。
 *
 * ⚠️ **「未声明」不在这份词表里，而且必须看得见。** `agent_run.task_type` 可空、
 * 无默认值、迁移不播种：老运行与不传 `type` 的新运行都是 NULL。把 NULL 折算成
 * 某一个类型 = 给缺失造一个像数据的替身（本仓铁律里最贵的那条）。
 * 所以**六类 + 「未声明」是七个状态，不是六个**。
 */
export const AGENT_TASK_TYPES = ['qa', 'analysis', 'generation', 'validation', 'flow', 'maintenance']

/** 六类的中文标签。键集合与 `AGENT_TASK_TYPES` 必须**对称差为空**（测试钉住）。 */
export const AGENT_TASK_TYPE_LABELS = {
  qa: '单步问答',
  analysis: '分析',
  generation: '生成',
  validation: '校验',
  flow: '流程',
  maintenance: '维护',
}

/** 产物的四态。`superseded` 是链上的旧版本 —— 它还在，旧报告还引用得到它。 */
export const AGENT_ARTIFACT_STATUSES = ['draft', 'accepted', 'rejected', 'superseded']

/**
 * 四态的中文标签。键集合与 `AGENT_ARTIFACT_STATUSES` 必须**对称差为空**（测试钉住）。
 *
 * ⚠️ **「未声明」不在这份表里，而且不存在这个情形** —— `agent_artifact.status` 是
 * `NOT NULL`、无默认值、写入侧只走 `draft` 与 `agent_artifact_decide` 的
 * `accepted` / `rejected`（`superseded` 由新版本写链时给）。所以这里**没有** NULL
 * 可折叠的余地，四个 id 正好四个标签。这与 §5 任务类型那张表不同：`agent_run.task_type`
 * 可空，所以那张表旁边必须站着「未声明」这个第七态。
 */
export const AGENT_ARTIFACT_STATUS_LABELS = {
  draft: '草案',
  accepted: '已接受',
  rejected: '已驳回',
  superseded: '已取代',
}

/** 终止态：不再移动的运行。 */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled']

/**
 * 两个人工门禁（§17-4：首批只开两个）。
 *
 * 其余只读分析**免审批** —— 「避免单人团队被审批淹没」是原文的措辞。所以这份
 * 名单是白名单：没在这里的动作，`assertGate` 直接放行，而不是要求调用方自己
 * 判断要不要问。
 */
export const AGENT_GATES = [
  {
    id: 'keyword-package-write',
    label: '候选词包入库',
    why: '候选词包一旦入库就成了后续位置计划的输入。生成一份词包很便宜，把一份没被看过的词包写进去很贵 —— 它的影响会出现在所有下游。',
  },
  {
    id: 'placement-plan-change',
    label: '位置计划变更',
    why: '位置计划决定哪个词放在哪个字段。改它等于改一份正在被执行的计划，回滚要重新跑一遍分类。',
  },
]

/**
 * 只读工具：任何角色都可以调（§8 的「只读」一级）。
 *
 * ## 它**被读**，但它不是门禁
 *
 * `toolsForRole`（本文件末尾）确实读它 —— 把它并进**每个**角色声明的工具集：
 * `[...new Set([...READ_ONLY_TOOLS, ...role.tools])]`。所以它不是一个装饰性的常量，
 * 删掉它会改变每个角色声明出去的工具范围。它承担的是「只读是所有人共享的地板，
 * 不必每个角色各列一遍」这件事。
 *
 * 它**不**承担的是拦截：没有一条代码因为一个工具在这份名单里而放行或拒绝什么
 * —— 「声明」本身不拦截（见文件头）。那条「只读工具永不过门禁」的性质也**不来自**
 * 这份名单，而来自门禁只挂在两个**写**类型上：`GATED_ARTIFACT_TYPES`
 * （`src/tools/agent.js`）只列了 `keyword-package` 与 `placement-plan`，所以一个只读
 * 工具根本走不到 `gateRefusal`。留着它是因为它是需求 §8 里的一级，并且真的参与
 * 组装声明范围 —— 而不是因为它拦了什么。
 */
export const READ_ONLY_TOOLS = [
  'amzn_dashboard', 'amzn_asin_query', 'amzn_asin_get', 'amzn_kw_query', 'amzn_kw_pipeline_history',
  'amzn_keyword_coverage', 'amzn_report_list', 'amzn_dq_scan', 'amzn_conflict_resolve', 'amzn_audit_query',
  'amzn_agent_run_list', 'amzn_agent_metrics',
]

/**
 * §2 的表列了**八个**角色；本仓这里是**九个** —— 多出来的是 `report-analyst`。
 * 2026-10-21 起九个角色全部 `available: true`（此前只有三个）。
 *
 * `steps` 是交给 DSH Agent 的步骤契约：会话侧按它逐步回报，工具与页面据它渲染进度。
 */
export const AGENT_ROLES = [
  {
    id: 'data-steward',
    label: '数据管家',
    duty: '管道运行完成后解读质量报告：重复文件、周期重叠、列错位、未归类产品线；产出「本次导入可信域 + 待人工处理清单」。',
    available: true,
    steps: ['read-pipeline-run', 'interpret-quality', 'emit-trusted-scope'],
    tools: ['amzn_kw_pipeline_history', 'amzn_kw_query', 'amzn_keyword_coverage', 'amzn_dq_scan', 'amzn_agent_artifact_save'],
    forbidden: ['写回任何导入事实', '替用户认定产品线归属'],
    gates: [],
    /* 允许数据（F12-02）：它解读质量报告，读的是**导入批次 / 词库 / 质量问题**三样。
       名字都是本仓真实存在的表（kw_import / kw_master / dq_issue）。 */
    reads: ['kw_import', 'kw_master', 'dq_issue'],
    /* 默认提示词**模块**（不是集合 id）。数据管家的活是「周期重叠 / 列错位 / 未归类产品线」，
       `prompt_set.module = 'kw'` 那组里逐字有「查周期重叠」—— 按模块解析最近的正是它。
       ⚠️ 这是**按模块的近似**，不是「这个角色的那套」（契约 §6）。 */
    promptModule: 'kw',
    /* 失败策略：质量报告读不出来（管道历史 / 扫描失败）时，「可信域」这个结论就没有
       立足点 —— 停在原地让人看，比带着一份没底的结论往下走更安全。 */
    onFailure: 'stop',
    /* 步骤上限：步骤契约是 3 步，留出重试与附加检查的余量。这是一个**可被新版本覆盖的
       声明值** —— 它存在的意义是让「上限」真的可执行（recordStep 据此拒绝越界 seq），
       不是一个业务常量。null 才是「未声明」（不是 0）。 */
    maxSteps: 8,
  },
  {
    id: 'keyword-research',
    label: '关键词研究',
    duty: '基于 kw_master + 竞品差距生成候选词包（带证据与周期）。',
    available: true,
    steps: ['read-master', 'compare-competitor', 'propose-package'],
    tools: ['amzn_kw_query', 'amzn_keyword_coverage', 'amzn_keyword_research', 'amzn_agent_artifact_save'],
    forbidden: ['直接把词写进位置计划'],
    /* 词包落库是门禁动作：它是这条角色唯一的高影响出口。 */
    gates: ['keyword-package-write'],
    /* 允许数据（F12-02）：职责逐字是「基于 kw_master + 竞品差距」，所以读词库与竞品词事实。
       kw_competitor_fact 是本仓真实的表（竞品词事实）。 */
    reads: ['kw_master', 'kw_competitor_fact'],
    /* 默认提示词**模块**：这组活（建词库 / 查词库 / 测覆盖）逐字在 `module = 'research'`
       那组里。⚠️ 按模块的近似，不是精确绑定（契约 §6）。 */
    promptModule: 'research',
    /* 失败策略：read-master / compare-competitor 失败时，候选词包就没有证据基础 ——
       带着一份没证据的包走到入库门禁，只会让人在门禁前才发现。停。 */
    onFailure: 'stop',
    maxSteps: 8,
  },
  {
    id: 'pipeline-maintenance',
    label: '管道维护',
    duty: '失败阶段重跑建议；月度导入提醒（每月 1–5 日窗口）；D4 类文件周期确认催办。',
    available: true,
    steps: ['read-history', 'propose-rerun', 'check-cadence'],
    tools: ['amzn_kw_pipeline_history', 'amzn_kw_source', 'amzn_agent_artifact_save'],
    forbidden: ['自动重跑管道（只给建议）'],
    gates: [],
    /* 允许数据（F12-02）：读管道历史、导入批次与数据源三样（都是真实表）。 */
    reads: ['kw_pipeline_run', 'kw_import', 'source'],
    /* 默认提示词**模块**：「跑管道 / 看历史」逐字在 `module = 'pipeline'` 那组里。
       ⚠️ 按模块的近似（契约 §6）。 */
    promptModule: 'pipeline',
    /* 失败策略：这条角色是**建议**型的（重跑建议 / 到期提醒 / 催办），一检查失败不该
       把别的检查一起停掉 —— 换下一个继续。 */
    onFailure: 'continue',
    maxSteps: 8,
  },
  {
    id: 'collect-coordinator',
    label: '采集协调',
    duty: '体检、规划最小采集范围、处理失败与等待人工；产出采集计划与恢复建议。',
    available: true,
    steps: ['check-env', 'preview-scope', 'propose-plan'],
    tools: ['amzn_collect_env_check', 'amzn_collect_preview', 'amzn_collect_status', 'amzn_collect_waiting_resolve', 'amzn_agent_artifact_save'],
    forbidden: ['不擅自提交批量采集（只给计划与建议）', '不绕过验证码或站点冷却'],
    gates: [],
    reads: ['asin', 'collection_task', 'collection_scheme', 'source'],
    promptModule: 'collect',
    onFailure: 'continue',
    maxSteps: 8,
  },
  {
    id: 'competitor-analyst',
    label: '竞品分析',
    duty: '对比 Listing / 关键词 / 口碑；产出机会清单与证据包。',
    available: true,
    steps: ['read-own-coverage', 'compare-quadrants', 'emit-opportunities'],
    tools: ['amzn_competitor_analyze', 'amzn_competitor_quadrants', 'amzn_keyword_coverage', 'amzn_competitor_set_upsert', 'amzn_agent_artifact_save'],
    forbidden: ['把未测量词当缺口', '把竞品品牌词当机会'],
    gates: [],
    reads: ['kw_master', 'kw_competitor_fact', 'asin_keyword', 'competitor_set'],
    promptModule: 'competitor',
    onFailure: 'continue',
    maxSteps: 8,
  },
  {
    id: 'listing-strategy',
    label: 'Listing 策略',
    duty: '决定定位、字段分工和关键词计划。',
    available: true,
    steps: ['read-coverage', 'propose-plan', 'emit-plan-draft'],
    tools: ['amzn_keyword_plan_propose', 'amzn_keyword_plan_get', 'amzn_keyword_plan_save', 'amzn_keyword_coverage', 'amzn_agent_artifact_save'],
    forbidden: ['把计划直接发布到站点'],
    gates: ['placement-plan-change'],
    reads: ['kw_master', 'keyword_plan', 'keyword_plan_entry', 'asin_keyword'],
    promptModule: 'optimize',
    onFailure: 'stop',
    maxSteps: 8,
  },
  {
    id: 'copywriter',
    label: '文案生成',
    duty: '按字段输出草案。',
    available: true,
    /* 只有一条草案写入路径：模块 13 的 amzn_optimize_*。这个角色不另建一条，只是把那条线跑起来。 */
    steps: ['read-strategy', 'draft-fields', 'validate-draft'],
    tools: ['amzn_optimize_strategy', 'amzn_optimize_prepare', 'amzn_optimize_validate', 'amzn_optimize_save', 'amzn_agent_artifact_save'],
    forbidden: ['另建草案写入路径（只走 amzn_optimize_*）', '写没有证据的参数'],
    gates: [],
    reads: ['optimization_run', 'optimization_draft', 'keyword_plan'],
    promptModule: 'optimize',
    onFailure: 'stop',
    maxSteps: 10,
  },
  {
    id: 'compliance-reviewer',
    label: '合规审阅',
    duty: '规则、事实、容量和风险复核；产出违规/警告/待确认。',
    available: true,
    steps: ['read-rules', 'check-draft', 'emit-verdict'],
    tools: ['amzn_optimize_validation', 'amzn_optimize_review', 'amzn_rule_list', 'amzn_policy_list', 'amzn_agent_artifact_save'],
    forbidden: ['替人做发布决定', '把 warn 当 block'],
    gates: [],
    reads: ['rule', 'policy', 'optimization_draft', 'optimization_review'],
    promptModule: 'rules',
    onFailure: 'stop',
    maxSteps: 8,
  },
  {
    id: 'report-analyst',
    label: '报告分析',
    duty: '汇总变化与效果；产出优化报告与观测结论。',
    available: true,
    steps: ['read-publication', 'pull-metrics', 'emit-report'],
    tools: ['amzn_publication_list', 'amzn_observation_list', 'amzn_report_build', 'amzn_report_diff', 'amzn_agent_artifact_save'],
    forbidden: ['把无数据当无变化'],
    gates: [],
    reads: ['publication_record', 'observation_plan', 'observation_checkpoint', 'report'],
    promptModule: 'report',
    onFailure: 'continue',
    maxSteps: 8,
  },
]

/* 可用角色的 id 清单曾是这里的一个导出（`AVAILABLE_ROLE_IDS`），但它**零读者**：
   页面用 `roles.filter(role => role.available)` 自算，路由用 `roleView` —— 都不经过它。
   已删除，且**不留替代品**（留一个同样没人读的「替代导出」等于同一个错犯两次）。 */

/** 一个角色，或 `undefined`。 */
export function roleById(id) {
  return AGENT_ROLES.find(role => role.id === String(id ?? '').trim())
}

/** 一个门禁，或 `undefined`。 */
export function gateById(id) {
  return AGENT_GATES.find(gate => gate.id === String(id ?? '').trim())
}

/** `true` 只当作 `true`：一个角色的 `available` 写 `1` / `'true'` 都不算可用。 */
function isAvailable(role) {
  return role?.available === true
}

/**
 * 一个角色的**完整声明**，作为配置版本（`agent_role_config.config_json`）的载荷。
 *
 * ⚠️ `configVersion` **不在其中**：版本号由表给（`MAX(version)+1`），不是声明里的一栏。
 * 谁想在角色对象上写一个 `configVersion`，就是在造第二个版本来源 —— 那正是本仓
 * 「两个常量活在不同文件」那一类缺陷。
 */
export function roleConfigOf(role) {
  return {
    id: role.id,
    label: role.label,
    duty: role.duty,
    available: isAvailable(role),
    why: role.why ?? null,
    steps: [...(role.steps ?? [])],
    tools: [...(role.tools ?? [])],
    forbidden: [...(role.forbidden ?? [])],
    gates: [...(role.gates ?? [])],
    reads: [...(role.reads ?? [])],
    promptModule: role.promptModule ?? null,
    onFailure: role.onFailure ?? 'stop',
    maxSteps: role.maxSteps ?? null,
  }
}

/**
 * 校验一份角色配置声明的基本形状。返回 `{ok:true}` 或 `{ok:false, error, hint}`。
 *
 * 这是**形状**校验，不是业务校验：它保证一份配置读得下去（数组是数组、单值是单值、
 * `onFailure` 是那两个词之一、`maxSteps` 是正整数或 null），不判断「这个工具名存不存在」
 * —— 那是 `tools` 那一层的事，而这里的职责是「别把一份 `{tools: 42}` 存进版本表」。
 *
 * ⚠️ 失败**必须**是结构化的（`{ok:false, error, hint}`）：本仓的写工具失败一律结构化，
 * 让调用方（与审计漏斗）能分辨「这次写没发生」。
 */
export function validateRoleConfig(value) {
  const bad = (error, hint) => ({ ok: false, error, hint })
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return bad(`config must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`, '传一个角色声明对象。')
  }
  if (typeof value.available !== 'boolean') {
    return bad('config.available must be a boolean', '写 true 或 false —— 1 / "true" 都不算。')
  }
  for (const key of ['steps', 'tools', 'forbidden', 'gates', 'reads']) {
    const list = value[key]
    if (list === undefined || list === null) continue
    if (!Array.isArray(list) || list.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
      return bad(`config.${key} must be an array of non-empty strings`, `把 ${key} 写成字符串数组（空数组是允许的）。`)
    }
  }
  if (value.promptModule !== null && value.promptModule !== undefined
      && (typeof value.promptModule !== 'string' || value.promptModule.trim() === '')) {
    return bad('config.promptModule must be a non-empty string or null', 'null = 没有声明；要声明就写模块名。')
  }
  if (value.onFailure !== 'stop' && value.onFailure !== 'continue') {
    return bad(`config.onFailure must be "stop" or "continue", got ${JSON.stringify(value.onFailure)}`,
      '声明式：插件不驱动 Agent，这两个词只影响页面措辞与 retryable 默认值。')
  }
  if (value.maxSteps !== null && value.maxSteps !== undefined
      && (!Number.isInteger(value.maxSteps) || value.maxSteps < 1)) {
    return bad(`config.maxSteps must be a positive integer or null, got ${JSON.stringify(value.maxSteps)}`,
      '⚠️ null = 未声明，不是 0；要声明就写正整数。')
  }
  return { ok: true }
}

/** 这份配置声明的工具范围：角色工具集 ∪ 只读工具。`null` 入参返回 `null`（不是空数组）。 */
export function toolsFromRoleConfig(config) {
  if (config === null || config === undefined) return null
  const declared = Array.isArray(config.tools) ? config.tools : []
  return [...new Set([...READ_ONLY_TOOLS, ...declared])].sort()
}

/** 一个 `store` 与一个角色 id 分得出来吗 —— 只读探针，别把 id 当 store。 */
function looksLikeStore(value) {
  return value !== null && typeof value === 'object'
    && typeof value.get === 'function' && typeof value.all === 'function'
}

/**
 * 这次运行**声明**要带的工具：角色的工具集 ∪ 只读工具。
 *
 * 只读做并集而不是让每个角色各列一遍，理由与 §8 的工具分级一致：只读不该是每个
 * 角色各自声明的特权，它是所有角色共享的地板。发布类工具**一个都不在里面**（§15-8）。
 * 这是**声明**而不是拦截：没列到的工具，插件不会拒绝调用（见文件头「工具集是声明的
 * 范围」）。是否有别的层按这份声明去拦，不在本仓可证明的范围内。
 *
 * ## 两种入参（F12-02）
 *
 *   - `toolsForRole(store, roleId)` —— **读该角色当前的配置版本**（`agent_role_config`
 *     的最新一版）。这是运行真正下发的那一份：改了配置里的 `tools`，下一次运行的工具
 *     白名单**必须**跟着变。运行冻结的 `role_config_json` 与它同源。
 *   - `toolsForRole(roleId)` —— 保留的旧路径，读**代码声明**（`AGENT_ROLES`）。给只做
 *     静态对照、手上没有 store 的调用方（既有断言走的就是这条路）。
 *
 * 两条路在角色**还没有任何配置版本**时给出同一个答案（`seedRoleConfigs` 把代码声明
 * 播种成 v1，所以默认就是它）。发布过新版本之后它们才会分叉 —— 而分叉时**以配置为准**。
 */
export function toolsForRole(first, second) {
  const fromCode = (id) => {
    const role = roleById(id)
    if (role === undefined) return []
    return [...new Set([...READ_ONLY_TOOLS, ...role.tools])].sort()
  }
  if (!looksLikeStore(first)) return fromCode(first)
  /* 有 store：优先读配置；角色还没有配置版本时**回落到代码声明**（不是静默给空集 ——
     一个空白名单会让「这次运行声明不带任何工具」看起来像事实）。 */
  const latest = latestRoleConfig(first, second)
  const configured = latest === null ? null : toolsFromRoleConfig(latest.config)
  return configured ?? fromCode(second)
}

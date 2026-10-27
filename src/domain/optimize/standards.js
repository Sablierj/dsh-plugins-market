/**
 * F14-02 §28.2 / §28.4 —— 报告**标准**的那一层：摘要四字段、字段级置信度与风险、
 * 实际发布值与草案的对比。
 *
 * ## 为什么单独一个文件，而不是塞进 `report.js`
 *
 * `report.js` 的 `buildReportModel` 是这份报告**唯一的模型**，两种渲染都只读它 —— 这条
 * 不变。但「这一轮的数据截止是哪天」「这个字段的草案有多可信」是**判据**，不是排版：
 * 它们各自有一张规则表，而规则表必须能单独被测试逐条打中（哪一条规则在什么输入下
 * 让等级移动）。把它们和 `push('## 十二…')` 混在一个 1200 行的文件里，测试就只能
 * 「渲染出来再 includes 一个词」—— 那正是本仓 `INCLUDES-AUDIT` 两轮审计反复抓到的
 * 假绿形状。所以判据在这里、**纯函数**、出结构化结果；`report.js` 只负责把它们放进
 * 模型并渲染。
 *
 * ## 三件事必须分得开（本仓最贵的一条）
 *
 * 每一条判据都同时回答「有 / 是 0 / 没有落点」：
 *
 *   · **数据截止**：十类证据包里有带日期的 → 给日期；证据包**在**但一类都没有日期
 *     → 「读不到（不是 0）」；证据包**不在** → 「这一类观测没有落点」。
 *   · **Prompt 版本**：列里有 / 列里没有但包里冻结了逐层版本 / 两处都没有。
 *     「这一轮没有记录」**绝不**写成「本系统不支持」—— 提示词库的版本机制从 v38 起就在。
 *   · **Agent 流程**：有引用且运行行在 / 有引用但运行行已不在 / 没有引用。
 *     模块 12 的 `agent_run` 是这一样东西的落点，「没关联」不是「没有这个机制」。
 *   · **草案状态**：`draft_version = 0` 是「**没有追踪过**版本」（版本从 1 开始），
 *     不是「第 0 版」；没有草案行是「这一轮没有字段」，不是「草案是空的」。
 *
 * ## 实际发布值不是自报的
 *
 * 逐字段的「实际发布值」只从 `publication_record.published_json` 里读（模块 14 §6 的
 * 登记内容），差异判定用 `computeDeviation` 的同一份函数 —— 登记时冻结的那一份是
 * §6 的**权威**，报告不重算它（草案登记之后还会被人改，重算会让「当时为什么说偏离」
 * 变答案）。报告额外给一条**逐字段的现时对比**（发布值 vs 本轮草案的 `after`），
 * 两条的措辞必须不同，否则读者会以为它们是同一件事。
 */

import { AGENT_TASK_TYPE_LABELS } from '../agent/roles.js'
/* 十类的 `appliesTo`（`all` / `copy` / `keywords` / `field`）只有一处实现 —— 证据包自己。
   这里 import 而不是再写一张「哪类证据管哪个字段」的表：那第二张表迟早和第一张不一致。 */
import { EVIDENCE_KINDS } from './evidence.js'

const APPLIES_TO = Object.fromEntries(EVIDENCE_KINDS.map(kind => [kind.id, kind.appliesTo]))

/**
 * 提示词身份串：`layer@vN`，按层序用 `; ` 连接。
 *
 * 层的顺序来自 `PROMPT_LAYERS`（`resolvePrompts` 已经按它排好），所以这里**不排序** ——
 * 再排一次就是第二个层序表。空数组给 `null`：没有层就没有版本，不编一个 `''`。
 */
export function promptVersionOf(layers = []) {
  const list = (Array.isArray(layers) ? layers : [])
    .map(layer => ({ layer: String(layer?.layer ?? '').trim(), version: layer?.version ?? null }))
    .filter(layer => layer.layer !== '' && layer.version !== null && layer.version !== undefined)
  if (list.length === 0) return null
  return list.map(layer => `${layer.layer}@v${layer.version}`).join('; ')
}

/** 等级的中文标签（可信度与风险共用同一套三档 —— 两张标签表是两处会漂的东西）。 */
const LEVEL_LABELS = { high: '高', medium: '中', low: '低' }

/**
 * 这一轮报告的**数据截止**。
 *
 * 来源只有一处：这一轮**冻结的证据包**（`optimization_evidence.source_at`）。理由有两个：
 *
 *   ① 报告要能在三个月后仍然解释得通。去读**今天的** `asin_snapshot` 会让同一份报告的
 *      数据截止随新采集漂移，而它已经在文件里印着了 —— 一份自相矛盾的报告比一份旧的更坏。
 *   ② 「当时我看到的是这些」在本仓已经有一份实现（F13-03 的十类证据包，含 `absent` /
 *      `not_modelled` 的区分）。再写一套取数就是第二份口径。
 *
 * 取的是十类里**最新**的一条时间（与 hub §28.2 的「数据截止日 = 各来源 MAX(data_end)」
 * 同一口径）。逐类时间一起返回：只印一个 MAX，读者就看不出哪一类老了。
 */
export function dataCutoffOf({ evidence = null } = {}) {
  if (evidence === null || evidence === undefined || evidence.ok !== true) {
    return {
      state: 'no-pack',
      value: null,
      label: null,
      rows: [],
      kinds: 0,
      dated: 0,
    }
  }
  const rows = (Array.isArray(evidence.rows) ? evidence.rows : []).map(row => ({
    kind: String(row.kind ?? ''),
    label: String(row.label ?? row.kind ?? ''),
    status: String(row.status ?? ''),
    appliesTo: APPLIES_TO[String(row.kind ?? '')] ?? 'all',
    at: row.at === null || row.at === undefined || String(row.at).trim() === '' ? null : String(row.at),
    source: row.source ?? null,
    count: row.count === null || row.count === undefined ? null : Number(row.count),
  }))
  const dated = rows.filter(row => row.at !== null)
  if (dated.length === 0) {
    return { state: 'undated', value: null, label: null, rows, kinds: rows.length, dated: 0 }
  }
  /* ISO-8601 UTC 字符串按字典序就是时间序（本仓所有时间戳都是这个形状），所以不引入
     第二个时间解析器。平手取**先出现**的那一类：`EVIDENCE_KINDS` 的顺序是规范顺序。 */
  const newest = dated.reduce((best, row) => (row.at > best.at ? row : best), dated[0])
  return {
    state: 'dated',
    value: newest.at,
    label: newest.label,
    kind: newest.kind,
    rows,
    kinds: rows.length,
    dated: dated.length,
  }
}

/** 六类任务类型的中文标签只有一处实现（`domain/agent/roles.js`），这里不抄一份。 */
const TASK_TYPE_UNKNOWN = '未声明'

/**
 * 字段级判据：**草案可信度**与**发布风险**。
 *
 * 两个等级都从**这一轮已有的内容**推出来，没有一项是「模型觉得」：
 *
 * 可信度（这份草案有多可信 —— 证据与判定的覆盖程度，不是概率）：
 *   · 没有草案文本 / 没有可对比的原值（这一字段从未被观测）/ 有阻断违规  ⇒ 低
 *   · 规则在本站点**没有执行**（skipped）/ 有警告 / 事实字段只能提议 /
 *     没有写回路径（要人工搬）                                       ⇒ 中
 *   · 其余                                                            ⇒ 高
 *
 * 风险（把它交出去的风险）：
 *   · 有阻断违规 / 超出上限（字节或字符）                              ⇒ 高
 *   · 有警告 / 事实字段（填错影响整组链接）/ 没有写回路径 /
 *     线上已发布的值与本轮草案不同                                    ⇒ 中
 *   · 其余                                                            ⇒ 低
 *
 * 等级取**所有命中里最低/最高**的那一档（不是第一条命中），理由全带上 —— 只印一条
 * 理由会让读者以为「没有别的理由了」。
 */
export function assessField({
  before = null,
  after = null,
  block = 0,
  warn = 0,
  needsConfirmation = false,
  publishable = true,
  budget = null,
  skippedRules = [],
  published = null,
} = {}) {
  const confidenceReasons = []
  const confidenceLow = []
  const confidenceMedium = []

  const hasText = value => value !== null && value !== undefined && String(value).trim() !== ''

  if (!hasText(after)) {
    confidenceLow.push('这一字段没有草案文本')
  }
  if (!hasText(before)) {
    confidenceLow.push('这一字段没有可对比的原值（从未被观测）')
  }
  if (Number(block) > 0) confidenceLow.push(`有 ${block} 条阻断违规`)
  if (Array.isArray(skippedRules) && skippedRules.length > 0) {
    confidenceMedium.push(`有 ${skippedRules.length} 条规则在本站点没有执行（${skippedRules.join('、')}）`)
  }
  if (Number(warn) > 0) confidenceMedium.push(`有 ${warn} 条警告`)
  if (needsConfirmation === true) confidenceMedium.push('这是事实字段，模型只能提议，要人对着实物确认')
  if (publishable !== true) confidenceMedium.push('没有写回路径，要人工在独立编辑器里搬')

  let confidence = 'high'
  if (confidenceMedium.length > 0) confidence = 'medium'
  if (confidenceLow.length > 0) confidence = 'low'
  confidenceReasons.push(...confidenceLow, ...confidenceMedium)
  if (confidenceReasons.length === 0) confidenceReasons.push('有观测到的原值、规则全部执行、没有违规')

  const riskReasons = []
  const riskHigh = []
  const riskMedium = []

  if (Number(block) > 0) riskHigh.push(`有 ${block} 条阻断违规`)
  if (budget !== null && budget !== undefined && budget.over === true) {
    const unit = budget.unit === 'bytes' ? '字节' : '字符'
    riskHigh.push(`超出上限（${budget.used}/${budget.max} ${unit}）`)
  }
  if (Number(warn) > 0) riskMedium.push(`有 ${warn} 条警告`)
  if (needsConfirmation === true) riskMedium.push('事实字段填错会影响整组链接')
  if (publishable !== true) riskMedium.push('要人工在独立编辑器里搬，容易漏')
  /* 现时对比：发布登记里这一字段的值与本轮草案不同 —— 说明**线上已经不是这一版**了。
     这一条不是 §6 的偏离判定（那是登记时冻结的），措辞里不许让它读成同一个东西。
     `published` 为 null = 这个字段没有被登记过（**不是**「发布值是空」）。 */
  if (published !== null && published !== undefined && Object.hasOwn(published, 'value')) {
    if (String(published.value ?? '') !== String(after ?? '')) {
      riskMedium.push('线上已发布的值与本轮草案不同')
    }
  }

  let risk = 'low'
  if (riskMedium.length > 0) risk = 'medium'
  if (riskHigh.length > 0) risk = 'high'
  riskReasons.push(...riskHigh, ...riskMedium)
  if (riskReasons.length === 0) riskReasons.push('没有阻断、没有超限；照第十二节的清单操作即可')

  return {
    confidence: { level: confidence, label: LEVEL_LABELS[confidence], reasons: confidenceReasons },
    risk: { level: risk, label: LEVEL_LABELS[risk], reasons: riskReasons },
  }
}

/** `validate.js` 的 `skipped` 用的是**位置**名（`bullets` / `draft`），草案是逐字段的。 */
function appliesToField(ruleField, field) {
  const name = String(ruleField ?? '').trim()
  if (name === '') return false
  if (name === field) return true
  /* `draft` 是文档级的伪字段：它的结论关于整份草稿，不只关于某一格。 */
  if (name === 'draft') return false
  if (name === 'bullets') return String(field).startsWith('bullet_')
  if (name === 'attributes') return String(field).startsWith('attribute.')
  return false
}

/**
 * 这一轮登记过的**实际发布值**，逐字段读回来。
 *
 * 只扫 `published_json` 的键 —— 不看任何自报的状态字段（与 `buildDelivery` 同一条纪律）。
 * 同一字段出现了多次时取**最新**那条登记（`publishedAt` 最大），因为「线上现在是什么」
 * 是最后一次登记说的，不是第一次。
 */
export function buildActivation({ publications = [], rows = [] } = {}) {
  const records = (Array.isArray(publications) ? publications : [])
    .filter(record => record !== null && record !== undefined)
    .slice()
    .sort((left, right) => String(right.publishedAt ?? '').localeCompare(String(left.publishedAt ?? '')))
  const latest = records[0] ?? null

  const byField = new Map()
  for (const record of records) {
    const published = record.published !== null && typeof record.published === 'object' ? record.published : {}
    for (const [field, value] of Object.entries(published)) {
      if (byField.has(field)) continue
      byField.set(field, {
        field,
        value: value ?? null,
        publicationId: record.id ?? null,
        publishedAt: record.publishedAt ?? null,
        draftVersion: record.draftVersion ?? null,
      })
    }
  }

  const draftAfter = new Map((Array.isArray(rows) ? rows : []).map(row => [row.field, row.after ?? null]))
  const entries = [...byField.values()].map(entry => {
    const draft = draftAfter.has(entry.field) ? draftAfter.get(entry.field) : undefined
    return {
      ...entry,
      inThisRound: draftAfter.has(entry.field),
      draftAfter: draft === undefined ? null : draft,
      /* `agrees` 是三态：`null` = 本轮没有这个字段的草案，所以「一致不一致」这个问题
         问不出来（不是「不一致」）。 */
      agrees: draft === undefined ? null : String(draft ?? '') === String(entry.value ?? ''),
    }
  })

  return {
    count: records.length,
    latest,
    entries,
    byField: Object.fromEntries(entries.map(entry => [entry.field, entry])),
    fields: entries.map(entry => entry.field),
    /* §6 的偏离判定是**登记时算出来并冻结**的（`deviation_json`）。报告读它，不重算。 */
    deviation: latest?.deviation ?? null,
    deviated: latest?.deviated === true,
    deviationRule: latest?.deviationRule ?? null,
    uncovered: Array.isArray(latest?.uncovered) ? latest.uncovered : [],
  }
}

/**
 * 摘要四字段：**值的措辞只在这里写一次**，两种渲染都念它。
 *
 * 每一行是 `{ id, label, value, note }`：`value` 是那一格读者要读的答案，`note` 是
 * 「为什么是这个答案 / 为什么没有答案」。两者分开，是因为本仓被「把缺失写成一个像
 * 数据的值」坑过太多次 —— 而 `includes('Prompt 版本')` 这种断言只有在标签与值分开
 * 时才有意义（否则改坏了值、标签还在，断言照样绿）。
 */
export function buildProvenance({
  run = {},
  packageJson = null,
  agentRun = null,
  drafts = [],
  cutoff = null,
} = {}) {
  const rows = []

  /* ── ① 数据截止 ─────────────────────────────────────────────────────────── */
  const cutoffInfo = cutoff ?? dataCutoffOf({ evidence: null })
  if (cutoffInfo.state === 'dated') {
    rows.push({
      id: 'data-cutoff',
      label: '数据截止',
      value: cutoffInfo.value,
      note: `取本轮证据包里最新的一条观测时间（${cutoffInfo.label}）；十类里 ${cutoffInfo.dated}/${cutoffInfo.kinds} 类带日期，逐类见附录。`,
    })
  } else if (cutoffInfo.state === 'undated') {
    rows.push({
      id: 'data-cutoff',
      label: '数据截止',
      value: '读不到',
      note: `本轮证据包在（${cutoffInfo.kinds} 类），但没有一类带观测时间 —— 这不是「截止时间是 0」，是没有可用的日期。`,
    })
  } else {
    rows.push({
      id: 'data-cutoff',
      label: '数据截止',
      value: '读不到',
      note: '这一轮还没有证据包（本批之前建的轮次会在 save 收尾时补冻）—— 所以不是「截止时间是空的」，是这一类观测还没有落点。',
    })
  }

  /* ── ② Prompt 版本 ──────────────────────────────────────────────────────── */
  const layers = Array.isArray(packageJson?.prompts)
    ? packageJson.prompts.map(entry => ({ layer: entry?.layer ?? null, label: entry?.label ?? null, version: entry?.version ?? null })).filter(entry => entry.layer !== null)
    : []
  const fromPackage = promptVersionOf(layers)
  const fromColumn = run.prompt_version === null || run.prompt_version === undefined || String(run.prompt_version).trim() === ''
    ? null
    : String(run.prompt_version).trim()
  const layerText = layers.filter(layer => layer.version !== null && layer.version !== undefined)
    .map(layer => `${layer.label ?? layer.layer} v${layer.version}`).join(' / ')
  if (fromPackage !== null) {
    rows.push({
      id: 'prompt-version',
      label: 'Prompt 版本',
      value: fromPackage,
      note: fromColumn === null
        ? `列里没有记录（v47 之前建的轮次，或建轮次时没写索引），但本轮包里冻结了逐层版本：${layerText} —— 那就是这一轮实际渲染的那几版。`
        : (fromColumn === fromPackage
          ? `逐层：${layerText}（来自本轮冻结的 package_json.prompts）。`
          : `列里记的是 ${fromColumn}，与本轮包冻结的 ${fromPackage} **不一致** —— 包是内容，列是索引，以包为准。`),
    })
  } else if (fromColumn !== null) {
    rows.push({
      id: 'prompt-version',
      label: 'Prompt 版本',
      value: fromColumn,
      note: '列里记着这个版本，但本轮包里没有提示词快照 —— 无法逐层核对。',
    })
  } else {
    rows.push({
      id: 'prompt-version',
      label: 'Prompt 版本',
      value: '未记录',
      note: '这一轮没有记录 Prompt 版本 —— 不是「本系统没有 Prompt 版本」：提示词库的版本机制从 v38 起就在（amzn_prompt_lifecycle_get 读得到），缺的是这一轮建轮次时没带上它（v47 之前建的轮次全部如此）。',
    })
  }

  /* ── ③ Agent 流程 ───────────────────────────────────────────────────────── */
  const agentRunId = run.agent_run_id === null || run.agent_run_id === undefined || String(run.agent_run_id).trim() === ''
    ? null
    : String(run.agent_run_id).trim()
  const sessionText = run.session_id === null || run.session_id === undefined || String(run.session_id).trim() === ''
    ? '会话 id 也没记'
    : `会话 id ${String(run.session_id).trim()}`
  if (agentRunId === null) {
    rows.push({
      id: 'agent-flow',
      label: 'Agent 流程',
      value: '未关联',
      note: `这一轮没有关联到某次 Agent 运行（${sessionText}）—— 不是「本系统没有 Agent 流程」：模块 12 的 agent_run 就是它的落点，这一轮只是没有引用它。`,
    })
  } else if (agentRun === null || agentRun === undefined) {
    rows.push({
      id: 'agent-flow',
      label: 'Agent 流程',
      value: `#${agentRunId}（运行行已不在）`,
      note: `这一轮引用了一次 Agent 运行，但 agent_run 里已经查不到它 —— 引用还在、内容没了，不是「没有运行」。${sessionText}。`,
    })
  } else {
    const taskLabel = agentRun.taskType === null || agentRun.taskType === undefined
      ? TASK_TYPE_UNKNOWN
      : (AGENT_TASK_TYPE_LABELS[agentRun.taskType] ?? agentRun.taskType)
    const steps = Array.isArray(agentRun.steps) ? agentRun.steps.length : 0
    rows.push({
      id: 'agent-flow',
      label: 'Agent 流程',
      value: `#${agentRun.id} · ${agentRun.roleLabel ?? agentRun.role ?? '未记角色'} · ${taskLabel} · ${agentRun.status ?? '未记状态'} · ${steps} 步`,
      note: `${sessionText}。角色 / 任务类型 / 状态 / 步骤都读自 agent_run 那一行。`,
    })
  }

  /* ── ④ 草案状态 ─────────────────────────────────────────────────────────── */
  /* 三态计数**从草案行自己数**，不接受调用方传进来的数字：一个人可以传对，也可以传
     一个好看的数字 —— 而「采纳了几个」正是这一格要回答的问题。 */
  const total = Array.isArray(drafts) ? drafts.length : 0
  const counts = { accepted: 0, rejected: 0, pending: 0 }
  for (const draft of (Array.isArray(drafts) ? drafts : [])) {
    const state = draft?.accepted
    if (state === 1 || state === true) counts.accepted += 1
    else if (state === 0 || state === false) counts.rejected += 1
    else counts.pending += 1
  }
  const version = run.draft_version === null || run.draft_version === undefined ? null : Number(run.draft_version)
  if (total === 0) {
    rows.push({
      id: 'draft-state',
      label: '草案状态',
      value: '本轮没有草案字段',
      note: '这一轮一个草案行都没有 —— 不是「草案是空的」：空草案是「有这个字段、文本为空」。',
    })
  } else {
    const versionText = version === null || !Number.isFinite(version)
      ? '版本读不到'
      : (version === 0 ? '版本 0（**没有追踪过**，不是「第 0 版」）' : `版本 v${version}`)
    rows.push({
      id: 'draft-state',
      label: '草案状态',
      value: `${versionText} · ${total} 个字段：采纳 ${counts.accepted} / 未采纳 ${counts.rejected} / 待定 ${counts.pending}`,
      note: '版本从 1 开始，只在采纳/驳回**真的改变**时递增；三态计数读自 optimization_draft.accepted。',
    })
  }

  return { rows, cutoff: cutoffInfo }
}

export { appliesToField }

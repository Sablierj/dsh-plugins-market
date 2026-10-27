/**
 * Optimization tools — prepare, validate, save, report.
 *
 * The shape of this flow is the point, and it is deliberately not a single
 * "optimize this ASIN" tool:
 *
 *   取数据（插件）→ 生成文案（DSH agent）→ 合规校验（插件）→ 不过就重写 ↺ → 落库 + 报告
 *
 * The plugin does not generate copy. The hub's own engine spec
 * (`OPTIMIZATION-ENGINE-SPEC.md`) is explicit that template filling produces
 * indistinguishable listings, and DSH already has the model — so a
 * `amzn_optimize_generate` tool would be the plugin competing with its own host
 * for no reason. What the plugin owns is everything the model cannot do
 * reliably: the real numbers, the real keyword ranks, and a deterministic
 * verdict on 46 published rules.
 *
 * `validate` is callable as many times as needed, which is what makes the loop
 * work: the agent rewrites and re-checks without the user in the middle. Only
 * `save` writes, and it is marked 🔒 for that reason.
 */

import { randomUUID } from 'node:crypto'
import {
  getAsin,
  getListing,
  getOptimizationRun,
  insertOptimizationRun,
  keywordCoverage,
  listingBefore,
  listOptimizationRuns,
  setDraftAccepted,
  updateOptimizationRun,
  upsertListing,
  upsertOptimizationDraft,
} from '../store/queries.js'
import { OPTIMIZATION_RUN_STATUSES } from '../domain/states.js'
/* F14-02：`getRun` 是模块 12 `agent_run` 的唯一读取口。报告摘要的「Agent 流程」
   必须读那一行（角色 / 任务类型 / 状态 / 步骤），不在报告里再拼一份。 */
import { getRun as getAgentRun } from '../store/agent.js'
/* F14-10：Excel 导出只给**地址**，不给字节（工具结果是文本）。地址由报告库里这一条
   决定，`reportForRun` 是那一行的读取口 —— 与导出路由用的是同一条查询。 */
import { reportForRun } from '../store/reports.js'
import { availabilityOf, exportPlan } from '../domain/reports/export.js'
/* F14-02：提示词身份串的**唯一**实现（`layer@vN; …`）。prepare 把它写进
   `optimization_run.prompt_version`（v47），报告再从包里逐层核对。 */
import { promptVersionOf } from '../domain/optimize/standards.js'
import { loadActiveRoster, rosterForValidation } from '../store/rules.js'
import { mergeKey, queryMaster } from '../store/kw.js'
import { resolvePrompts } from '../store/prompt.js'
/* The 增量 priority order reads the findings the data-quality module already
   made rather than re-deriving "this fact looks wrong" from the copy. */
import { listIssues } from '../store/quality.js'
import { recordOptimizationReport } from '../store/reports.js'
import { ATTRIBUTES, REQUIRED_ATTRIBUTE_TARGET, REQUIRED_ATTRIBUTES, attributeField } from '../domain/rules/attributes.js'
import {
  BULLET_FIELDS, DRAFT_FIELDS, MANUAL_FIELDS,
  SECTION_LABELS, fieldRank, isAttributeField, isPublishable, labelForField, sectionOf, writebackSplit,
} from '../domain/rules/listing-fields.js'
import { limitsFor, profileFor, provisionalNote } from '../domain/rules/marketplaces.js'
import { keywordInText } from '../sources/keyword-tiers.js'
import { budgetFor, measureDraft, trimDraft } from '../domain/optimize/budget.js'
/* F01-01 #4: a draft written under one context must not be accepted under
   another. `canSubmitDraft` is the verdict, `draftContextState` is the same
   question asked for disclosure only (validate says which of the run's drafts
   the current scope has already invalidated). */
import { canSubmitDraft, draftContextState } from '../domain/optimize/context.js'
import { backendCandidates, buildEmbeddingPlan, coverageDelta } from '../domain/optimize/embedding.js'
/* F13-02 / F13-04: the nine pre-flight gates and the four optimization modes.
   Both are resolved from the run's own package when a run exists, so the page,
   `validate` and `save` cannot disagree about which mode a run is in or what its
   pre-flight said. */
import {
  OPTIMIZE_MODES, TARGETED_SCOPES,
  auditRefusal, fieldInScope, incrementalOverflow, modeSpec, rankIncrementalFields, scopeRefusal,
} from '../domain/optimize/mode.js'
import {
  PRECHECK_BLOCKED, evaluatePrecheck, precheckRefusal,
} from '../domain/optimize/precheck.js'
import { EMBED_POSITIONS, buildGlobalPlan } from '../domain/optimize/plan.js'
import { buildReportModel, renderExcel, renderHtml, renderMarkdown } from '../domain/optimize/report.js'
/* R-91：报告要按**字段模板**印全量字段（本轮没草稿的也印出来）。 */
import { ensureTemplate, getTemplateVersion } from '../store/field-template.js'
import { ATTRIBUTES as TEMPLATE_ATTRIBUTES } from '../domain/rules/attributes.js'
import { COPY_FIELDS as TEMPLATE_COPY_FIELDS } from './field-template.js'
import { normalizeDraft, GATES, runGates, validateDraft } from '../domain/optimize/validate.js'
/* F13-01: the inbox. `buildInbox` / `draftInboxRow` are the same functions the
   optimize page's payload is built from — the panel does not derive a draft's
   state, and neither does this tool. */
import {
  DRAFT_CONTEXT_FILTERS, INBOX_GROUP_IDS, buildInbox, draftInboxRow,
} from '../domain/optimize/inbox.js'
/* F13-03: the evidence package. Frozen at prepare, read-only after.
   `activePolicies` 是第十一类与 prepare 数据包**共用**的那一次取数 —— 两处各写一份
   查询会出现「证据包说 3 条、prepare 说 2 条」这种没人能解释的差。 */
import {
  EVIDENCE_KINDS, activePolicies, collectEvidence, freezeEvidence, readEvidence,
} from '../domain/optimize/evidence.js'
/* F13-05: the nine-item strategy card and the 「人工确认后进入生成」 gate.
   `strategyGate` is the one judgement — the page and the tools both read it, and
   neither re-derives it. */
import {
  STRATEGY_SOURCE, STRATEGY_VERSION, buildStrategy, readStrategy, readStrategyRow, strategyGate, writeStrategy,
} from '../domain/optimize/strategy.js'
/* F13-06: the position-plan reconciliation. It **inherits** module 08's persisted
   plan and writes back through `savePlan` — this file never inserts a plan row. */
import {
  PLAN_CHECK_VERSION, inheritPlan, readPlanCheck, suggestPlan, writePlanCheck,
} from '../domain/optimize/position-plan.js'
/* F13-08: the validation system — rules / gates / Agent review behind one entry.
   `readValidationSystem` is the same call the workbench page's payload is built
   from, so the tool and the three panels cannot answer differently. `REVIEW_ITEMS`
   is the review roster (11 upstream + 3 added); the report's 8.3 lists the same
   array, which is why this file no longer imports `LLM_ONLY_CHECKS` directly. */
import {
  REVIEW_CODES, REVIEW_CONCLUSIONS, REVIEW_ITEMS, REVIEW_SOURCE, REVIEW_VERSION,
  checkReviewInput, readReview, recordReview, reviewStateLabel,
} from '../domain/optimize/review.js'
import { VALIDATION_SOURCE, VALIDATION_VERSION, readValidationSystem } from '../domain/optimize/validation-system.js'
/* 政策挂的规则是否还在生效规则集里 —— 「政策写着、代码没查」比没有政策更危险。 */
import { policyRuleDrift, policyRuleDriftLine } from '../domain/optimize/policy-drift.js'
/* F13-09: the delivery boundary — the operation checklist, the three kinds of
   "missing", and the publication-registration hand-off. Only `publicationsForRun`
   is imported here: the checklist itself is built inside `buildReportModel`
   (report.js) so the report body and the workbench panel read **one** delivery
   object rather than two calls that could drift. It reads module 14's
   registrations through that module's own reader, never a second SELECT, so the
   checklist's 「已登记」 is recomputed from what was actually recorded. */
import { publicationsForRun } from '../domain/optimize/delivery.js'
import { table, text, truncate } from './render.js'
/* S1-B17.1: the 接受草案 gate, asked before any draft is decided. `approvalPolicy`
   is also what the inbox's 审批状态 column reports — one reading of the policy. */
import { approvalPolicy, approvalRefusal } from '../domain/approval/policy.js'

/**
 * The rule set as a value, read from the store's active roster.
 *
 * The check functions are code and cannot be serialised, so what gets stored is
 * the *roster*: which rules, at which version, with which severity and citation.
 * That is what a report needs to be explicable — "these rules were in force,
 * here is what each one says" — and it is worth being precise that it is a
 * record of the rule set, not a frozen engine.
 *
 * B02 moved the source of this from the code constant to `rule_set` / `rule`, so
 * a rule the user turned off is off in the snapshot too. When the store has no
 * roster the load falls back to the code seed and marks `fromCode: true`, which
 * the caller can disclose rather than hide.
 */
/** 空串当 null：写库时「没给」和「给了空白」对 listing 是同一件事，
 *  而 null 会被 upsertListing 的 COALESCE 保留旧值。四个 applyListing 字段共用这一条。
 *  R-13 的第二个入口：validate 挡住空串进 accepted，写库这一层也要挡 ——
 *  只守一个入口，守的是入口，不是规则。 */
function nullIfBlank(value) {
  return String(value ?? '').trim() === '' ? null : value
}

export function ruleSnapshot(store) {
  const roster = loadActiveRoster(store)
  return {
    version: roster.version,
    source: roster.source,
    count: roster.count,
    fromCode: roster.fromCode,
    rules: roster.rules.map(rule => ({
      id: rule.id,
      kind: rule.kind ?? 'code',
      appliesTo: rule.appliesTo,
      scope: rule.scope,
      severity: rule.severity,
      source: rule.source,
      title: rule.title,
      ...(rule.params === null || rule.params === undefined ? {} : { params: rule.params }),
    })),
  }
}

/**
 * The context the workbench is in right now, or `null` when there is no
 * workbench to ask.
 *
 * `null` is a real answer, not "the default context". A caller with no workbench
 * — a script, a test harness that builds the tool itself — genuinely does not
 * know which scope it is writing in, and stamping a draft with a context nobody
 * selected is the forgery v19's NULL column exists to avoid. The submit gate
 * reads that NULL as `unknown` and refuses, which is the strict direction and
 * the documented one (see `domain/optimize/context.js`).
 */
function workbenchContextId(workbench) {
  const id = workbench?.get?.()?.contextId
  return id === undefined || id === null || String(id).trim() === '' ? null : String(id)
}

/**
 * The keyword set the plan is built from: this ASIN's measurements, the
 * library's words, and — when asked for — the imported master library.
 *
 * Three origins, and they are not interchangeable:
 *
 *   `measured`  this ASIN was scanned; `rank` is a real position, and `null`
 *               means "scanned and not found", which is a finding.
 *   `untested`  in the `keyword` table but never scanned for this ASIN. No rank,
 *               because we never looked — the library tier came from other
 *               products and using it here would claim a check nobody made.
 *   `master`    only in `kw_master`, i.e. only in the imported export files. No
 *               rank either, and never one: the library knows the word's volume,
 *               not our position in it.
 *
 * `includeMaster` therefore adds **words**, never measurements, and it is off by
 * default for that reason. Turning it on cannot change a rank, a tier or a scan
 * depth on a word that was already there — the master pass only appends keys it
 * has not seen, and it appends them untouched.
 *
 * Sameness is decided by `mergeKey` (case-insensitive), not by the write key —
 * see its comment. The library can hold `wireless mouse` while the measurement
 * holds `Wireless Mouse`, and those are one word for the purpose of "the
 * measured row wins".
 */
function keywordSetFor(store, asin, marketplace, limit, { includeMaster = false } = {}) {
  const coverage = keywordCoverage(store, asin, marketplace, { limit })
  const measured = coverage.rows.map(row => ({
    keyword: row.keyword,
    tier: row.tier,
    rank: row.rank,
    scan_depth: row.scan_depth,
    libraryTier: row.library_tier,
    origin: 'measured',
    searchVolume: row.search_volume ?? null,
    // Neither `asin_keyword` nor `keyword` records where a volume came from, so
    // this is null rather than a guess. Only `kw_master` has a source column,
    // which is exactly why the master rows carry one.
    searchVolumeSource: null,
  }))
  /* A word the library knows but this ASIN was never scanned for is *unmeasured
     for this ASIN* — the library tier came from other products, and using it here
     would claim a rank we never checked. Carried alongside, not substituted. */
  const untested = coverage.untested.map(row => ({
    keyword: row.keyword,
    tier: null,
    rank: null,
    scan_depth: null,
    libraryTier: row.tier ?? null,
    origin: 'untested',
    searchVolume: row.search_volume ?? null,
    searchVolumeSource: null,
  }))

  const keywords = [...measured, ...untested]
  if (includeMaster !== true) return { coverage, keywords }

  /* The master pass fills gaps and nothing else. A word already present — under
     the merge key — is dropped whole: it must not add a row, and it must not
     rewrite a field on the row it collides with. */
  const seen = new Set(keywords.map(row => mergeKey(row.keyword, marketplace)))
  const master = []
  for (const row of queryMaster(store, { marketplace, order: 'opportunity', limit }).rows) {
    const key = mergeKey(row.keyword, marketplace)
    if (seen.has(key)) continue
    seen.add(key)
    master.push({
      keyword: row.keyword,
      tier: null,
      rank: null,
      scan_depth: null,
      libraryTier: row.sv_tier ?? null,
      origin: 'master',
      searchVolume: row.search_volume ?? null,
      searchVolumeSource: row.search_volume_source ?? null,
    })
  }

  return { coverage, keywords: [...keywords, ...master] }
}

/**
 * The draft fields a rule or a plan position stands for.
 *
 * Rules and the embedding plan name *positions* (`bullets`), while a draft is
 * written *per field* (`bullet_1` … `bullet_5`). The two vocabularies meet here
 * and only here, so a rule that fires on `bullets` counts against all five and a
 * plan slot of `title` counts against `title`.
 */
function expandFieldName(field) {
  const name = String(field ?? '').trim()
  if (name === 'bullets') return [...BULLET_FIELDS]
  if (name === 'item_highlights') return ['item_highlights']
  if (name === 'search_terms') return ['search_terms']
  if (name === 'title') return ['title']
  if (name === '' || name === 'attributes') return []
  return [name]
}

/**
 * F13-04 增量: which fields this round should touch first, and why.
 *
 * §4.2 names the priority ("优先解决阻断、事实错误和高价值缺口") but not the signals,
 * so each rank is read off a fact this repo already produces rather than guessed:
 * block-severity rule violations on the current copy, data-quality findings in
 * the validity / consistency dimensions, and T1/T2 keywords the plan wants in a
 * position where the copy does not have them yet.
 *
 * Every list is returned even when empty, so the report can say "本轮没有事实
 * 错误类缺口" instead of leaving the reader to wonder whether the rank was
 * checked at all.
 */
function incrementalGuidance({ store, asin, marketplace, fields, keywords, before }) {
  const listing = getListing(store, asin, marketplace) ?? getAsin(store, asin, marketplace)?.row ?? null
  const result = validateDraft({
    fields,
    listing,
    keywords,
    options: { marketplace },
    roster: rosterForValidation(store, null),
  })

  const blockedFields = new Set()
  for (const violation of result.violations) {
    if (violation.severity !== 'block') continue
    for (const field of expandFieldName(violation.field)) blockedFields.add(field)
  }

  /* The data-quality findings for this object, by dimension. `validity` and
     `consistency` are the two dimensions that say "a stored fact is wrong or two
     sources disagree", which is what §4.2 means by 事实错误 — §7.6 forbids
     inferring a hard fact by reading the copy, so this does not try. */
  const issues = listIssues(store, { objectId: `${asin}@${marketplace}` })
  const issueFields = new Set()
  for (const issue of issues) {
    if (issue.dimension !== 'validity' && issue.dimension !== 'consistency') continue
    for (const field of expandFieldName(issue.field)) issueFields.add(field)
  }

  const quickWinFields = new Set()
  if (before !== null) {
    for (const entry of buildEmbeddingPlan({ keywords, listing: before }).quickWins) {
      for (const field of expandFieldName(entry.position)) quickWinFields.add(field)
    }
  }

  const order = rankIncrementalFields({
    fields,
    blockedFields: [...blockedFields],
    issueFields: [...issueFields],
    quickWinFields: [...quickWinFields],
  })

  return {
    order,
    blockedFields: [...blockedFields],
    issueFields: [...issueFields],
    quickWinFields: [...quickWinFields],
    openIssues: issues.length,
  }
}

/** The mode spec a run was started in — `full` for a run that predates modes. */
function runModeSpec(run) {
  const stored = parseJson(run?.package_json, null)
  const mode = String(stored?.mode?.id ?? 'full').trim()
  const scope = stored?.mode?.scope ?? null
  return modeSpec(mode, { scope }) ?? modeSpec('full')
}

/** The keyword set a run works from, capped the same way prepare caps it. */
function runKeywords(store, run) {
  return keywordSetFor(store, run.asin, run.marketplace, 200).keywords
}

/**
 * The one entry point to the nine pre-flight gates (F13-02).
 *
 * There are three consumers — `amzn_optimize_precheck`, `amzn_optimize_prepare`
 * and the workbench's optimize slice — and the requirement is that one criterion
 * drives all of them. Folding the *call* as well as the rule into one function is
 * what makes that checkable rather than promised: the gate list, the keyword set
 * the denominators are counted over, and the mode that decides whether 评分
 * blocks or merely degrades are all resolved here, once, for every caller.
 *
 * What it does beyond `evaluatePrecheck`:
 *
 *   ① reads the mode as a *spec* (`modeSpec`), so 专项 without a scope is a
 *      caller error rather than a run that quietly behaves like 全量;
 *   ② resolves the keyword set the same way `prepare` does, because the 搜索量
 *      90-day window is judged per keyword in *this round* — a caller that passed
 *      no keywords would otherwise get a denominator of 0 and a green gate over
 *      a listing whose words were never looked at.
 *
 * Returns `null` for an unknown mode/scope pair. The callers each already have a
 * way to say that (the tools return `{ ok:false }`, the page shows the refusal),
 * and substituting a default here would hide a typo behind a plausible report.
 */
export function precheckFor(store, {
  asin,
  marketplace = 'US',
  mode = 'full',
  scope = null,
  keywords = null,
  declarations = {},
  now = new Date(),
} = {}) {
  const spec = modeSpec(mode, { scope })
  if (spec === null) return null

  const resolved = Array.isArray(keywords)
    ? keywords
    : keywordSetFor(store, asin, marketplace, 200).keywords

  return evaluatePrecheck(store, {
    asin,
    marketplace,
    keywords: resolved,
    mode: spec.id,
    scope: spec.scope,
    declarations,
    now,
  })
}

/**
 * The pre-flight report in force for a run.
 *
 * Frozen first, live second. §33 asks that an optimization run "固定使用当时判定
 * 结果", and the run's package already freezes the rule set and the prompt text;
 * the nine answers go in the same place. A run with no stored report — one built
 * before this batch, or by hand in a test — gets the gates evaluated now, because
 * reading "no report" as "passed" is the single answer this feature must not give.
 *
 * The live half goes through `precheckFor`, the same door the page and the
 * read-only tool use. Re-deriving it here would be the second implementation this
 * batch exists to remove.
 */
function precheckForRun(store, run, now = new Date()) {
  const stored = parseJson(run?.package_json, null)
  const frozen = stored?.precheck
  if (frozen !== null && frozen !== undefined && Array.isArray(frozen.gates) && frozen.gates.length > 0) return frozen
  const spec = runModeSpec(run)
  return precheckFor(store, {
    asin: run.asin,
    marketplace: run.marketplace,
    keywords: runKeywords(store, run),
    mode: spec.id,
    scope: spec.scope,
    declarations: frozen?.declarations ?? {},
    now,
  })
}

/** The nine gates as text, for the tool output. One line per gate, worst first. */
function renderPrecheckLines(report, { heading = '## 前置检查（九项门槛）' } = {}) {
  const lines = []
  lines.push(heading)
  const tag = { pass: '✅ 通过', degrade: '⚠️ 降级', block: '⛔ 阻断' }
  lines.push(`结论 ${tag[report.verdict]}　${report.counts.pass} 通过 / ${report.counts.degrade} 降级 / ${report.counts.block} 阻断（共 ${report.counts.total} 项）`)
  if (report.blocked) lines.push('⛔ 有阻断项：本轮不生成、不写入。先按下面的补数清单补齐，再重跑。')
  lines.push('')
  lines.push(table(report.gates, [
    { label: '#', value: row => row.index },
    { label: '门槛', value: row => row.label },
    { label: '结果', value: row => tag[row.verdict] ?? row.verdict },
    { label: '实测 / 分母', value: row => `${row.counts.matched} / ${row.counts.total} ${row.counts.label}` },
    { label: '判据', value: row => truncate(row.criterion, 60) },
  ]))
  lines.push('')
  for (const entry of report.gates) {
    lines.push(`### ${entry.index}. ${entry.label} — ${tag[entry.verdict] ?? entry.verdict}`)
    lines.push(`判据：${entry.criterion}`)
    lines.push(`实测（分母 ${entry.counts.total} ${entry.counts.label}）：`)
    for (const measurement of entry.measured) {
      lines.push(`- ${measurement.name}：${measurement.value}${measurement.at === null || measurement.at === undefined ? '' : `（观测 ${measurement.at}）`}${measurement.note ? `　${measurement.note}` : ''}`)
    }
    for (const note of entry.notes) lines.push(`- 说明：${note}`)
    for (const note of entry.degradeNotes) lines.push(`- 降级说明：${note}`)
    if (entry.missing.length > 0) {
      lines.push('- 缺什么：')
      for (const text of entry.missing) lines.push(`  · ${text}`)
      lines.push('- 去哪里补：')
      for (const fix of entry.remedy) lines.push(`  · ${fix.moduleLabel}：${fix.action}${fix.tool ? `（${fix.tool}）` : ''}`)
    }
    lines.push(`- 判据来源：${entry.basis}`)
    lines.push('')
  }
  return lines
}

/* ── F13-05 的门禁 ─────────────────────────────────────────────────────────────
   本插件不生成文案（模块头），所以「人工确认后进入生成」唯一能被强制执行的落点是
   **草案进入这一轮的那一刻**：`validate(persist: true)` 与 `save`。拦 prepare 等于
   没有策略卡可确认；拦只读的 validate 只会让人不敢试。

   `absent`（这一轮没有策略行 —— 本批之前建的轮次）**放行**，但状态说得清为什么
   放行，不冒充「已确认」。 */
function strategyRefusalFor(store, run) {
  const gate = strategyGate(readStrategyRow(store, run?.id))
  if (gate.open) return null
  return {
    ok: false,
    code: gate.code,
    gate,
    runId: run.id,
    error: `第 ${String(run.id).slice(0, 8)} 轮的策略还没有人工确认 —— ${gate.reason}`,
    hint: '先策略后文案：把九项策略卡（amzn_optimize_strategy）给用户看，让他在工作台'
      + '「优化 → 策略阶段」确认之后再提交。只做检查不落库（去掉 persist）不会被拦。',
  }
}

/* ── F13-05 / F13-06：策略卡与位置计划核对的文字形式 ─────────────────────────────
   两块都是**渲染**，没有一处判据：九项的 status / source / facts 与门禁的 open /
   state 都由 `domain/optimize/strategy.js` 算好；继承、建议与决策由
   `domain/optimize/position-plan.js` 算好。这里只画。 */

const STRATEGY_STATUS_TAG = {
  derived: '有来源',
  absent: '这一轮没有输入',
  not_modelled: '本仓没有这一项',
}

function renderStrategyLines(items, gate) {
  const lines = []
  lines.push(`## 策略阶段（九项策略卡 · ${STRATEGY_VERSION}）`)
  lines.push(`来源：${STRATEGY_SOURCE}`)
  lines.push(gate.open
    ? `门禁：**${gate.state === 'confirmed' ? '已确认' : '放行'}** —— ${gate.reason}`
    : `门禁：**未确认，草案进不了这一轮** —— ${gate.reason}`)
  lines.push('')
  for (const entry of items) {
    lines.push(`### ${entry.label}　${STRATEGY_STATUS_TAG[entry.status] ?? entry.status}`)
    lines.push(`这一项回答：${entry.question}`)
    lines.push(entry.text)
    if (entry.facts.length > 0) {
      lines.push(table(entry.facts, [
        { label: '事实 / 判据', value: row => row.name },
        { label: '值', value: row => truncate(String(row.value ?? ''), 70) },
        { label: '时间', value: row => row.at ?? '—' },
        { label: '说明', value: row => truncate(String(row.note ?? ''), 50) },
      ]))
    }
    lines.push(`来源：${entry.source ?? '（本仓没有这一项的来源）'}`)
    if (entry.note) lines.push(`说明：${entry.note}`)
    lines.push('')
  }
  lines.push('⚠️ 「本仓没有这一项」与「这一轮没有输入」是两句不同的话：前者是这个仓库里根本没有'
    + '承载它的表 / 列 / 读取口，后者是这一轮的对象或包里缺了输入。两者的补法也不一样。')
  return lines
}

function renderPlanCheckLines(inherited, suggestion) {
  const lines = []
  lines.push(`## 位置计划核对（继承模块 08 · ${PLAN_CHECK_VERSION}）`)
  if (inherited.status === 'none') {
    lines.push(`⚠️ **没有可继承的位置计划**：${inherited.note}`)
    lines.push('注意这与「计划里有 0 个位置」不是一件事 —— 前者是 08 里没有行，后者是有行而条目为空。')
    return lines
  }
  lines.push(inherited.note)
  lines.push(`来源：${inherited.source}`)
  lines.push('')
  lines.push(`本轮建议计划（${suggestion.counts.suggested} 条，位置词表是 08 的八个，不是 13 的十二个埋词位置）：`)
  if (suggestion.entries.length === 0) {
    lines.push('（这一轮的关键词里没有一个被计划决定过 —— 建议计划是 0 条，不是「计划不存在」。）')
  } else {
    lines.push(table(suggestion.entries.slice(0, 30), [
      { label: '关键词', value: row => truncate(row.keyword, 26) },
      { label: '计划主人', value: row => row.ownerPositionLabel },
      { label: '对应埋词位置', value: row => row.embedPosition ?? '（无对应物）' },
      { label: '本轮分配', value: row => row.roundOwner ?? '—' },
      { label: '变化', value: row => ({
        unchanged: '一致',
        'owner-moved': '主人位置不同',
        'not-comparable': '比不了',
        'plan-only': '本轮包里没有这个词',
      }[row.roundChange] ?? row.roundChange) },
    ]))
  }
  if (suggestion.uncovered.length > 0) {
    lines.push('')
    lines.push(`⚠️ 本轮有 ${suggestion.uncovered.length} 个词**计划没决定过**：`
      + `${suggestion.uncovered.slice(0, 15).join(' | ')}${suggestion.uncovered.length > 15 ? ' …' : ''}`)
    lines.push('它们不进建议计划 —— 为一个词编一个位置就是产生第二份口径。要加，去 08 里加。')
  }
  if (suggestion.unmapped.length > 0) {
    lines.push('')
    lines.push('⚠️ 08 用了、而 13 没有对应埋词位置的位置（**逐条列出，不静默丢弃**）：')
    for (const item of suggestion.unmapped) {
      lines.push(`- ${item.label}（${item.position}）× ${item.count}：${item.reason}`)
    }
  }
  lines.push('')
  lines.push('写回：人在工作台「优化 → 位置计划」点「采纳并写回 08 新版本」，走的是模块 08 的 `savePlan` ——'
    + '与 `amzn_keyword_plan_save` 是同一个函数。**本工具与 prepare 都不写计划行。**')
  return lines
}

export function optimizePrepareTool({ store, workbench, pagePath }) {
  return {
    name: 'amzn_optimize_prepare',
    description:
      'Start an optimization run and return the data package to write from: the current listing text, the tiered keyword '
      + 'set for this ASIN, where each keyword should be embedded, the character budget of every field, and the exact '
      + 'rule set the draft will be judged against. '
      + 'It also runs the nine-gate pre-flight check first (F13-02) and returns each gate separately — criterion, measured '
      + 'value, denominator, and where to go and fill the gap. A blocking gate refuses the run before it exists; a dry run '
      + 'still returns the checklist so you can see what is missing. '
      + 'The mode (F13-04) decides what the run may write: full / incremental (≤30% of fields, ordered 阻断 > 事实错误 > '
      + '高价值缺口) / targeted (one of eight scopes) / audit (check only, generate nothing). '
      + 'F13-05: the package opens with a nine-item strategy card (目标用户 / 核心差异化 / 购买疑问 / 事实边界 / '
      + '关键词优先级与所有权 / 字段分工 / 保留内容 / 风险待确认 / 修改幅度). It is frozen **unconfirmed** — show it to '
      + 'the user and have them confirm it in the workbench (优化 → 策略阶段) before you write copy: with the strategy '
      + 'unconfirmed, amzn_optimize_validate with persist and amzn_optimize_save are both refused (STRATEGY_UNCONFIRMED). '
      + 'F13-06: the package also reports the position plan **inherited from module 08** (the only persistence layer for '
      + 'it) and this round\'s suggestion against it; the user accepts it in the workbench, which writes back a new version '
      + 'in module 08. This tool never writes a plan row. '
      + 'This tool does NOT write copy — you write it. Then call amzn_optimize_validate (as many times as needed) until '
      + 'nothing is blocked, and amzn_optimize_save to store the result and produce the report. '
      + 'The package also lists the checks that code cannot make (hallucinated specs, contradictions) so you know which '
      + 'verdicts are yours to give.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Restrict the run to these keywords. Omit to use every keyword known for this ASIN.' },
        maxKeywords: { type: 'number', description: 'Cap on keywords pulled into the package. Default 200.' },
        includeMaster: {
          type: 'boolean',
          description:
            'Also pull in words that exist only in the imported master library (kw_master), not in this ASIN\'s '
            + 'measurements. Default false. These words enter with origin="master" and rank=null — the library knows '
            + 'their search volume, never our position, so they must not be written as if they had been measured. '
            + 'They add words to work with; they never add or change a measurement.',
        },
        category: { type: 'string', description: 'Category, e.g. apparel / shoes / jewelry — those cap the title at 80 chars.' },
        maxTitleChars: { type: 'number', description: 'Override the title cap explicitly.' },
        maxHighlightsChars: { type: 'number', description: 'Override the Item Highlights cap. Site default 125 chars.' },
        mode: {
          type: 'string',
          enum: [...OPTIMIZE_MODES],
          description:
            'Optimization mode (F13-04). full = cover every optimizable field (first build or a badly incomplete listing). '
            + 'incremental = an existing listing, ≤30% of its fields in one round, ordered 阻断 > 事实错误 > 高价值缺口. '
            + 'targeted = one of the eight scopes in `scope`. audit = check only, generate nothing. Default full.',
        },
        scope: {
          type: 'string',
          enum: TARGETED_SCOPES.map(entry => entry.id),
          description: `Required when mode=targeted. One of: ${TARGETED_SCOPES.map(entry => `${entry.id}（${entry.label}）`).join(' / ')}.`,
        },
        keywordsReviewed: {
          type: 'boolean',
          description:
            'Declare that this round\'s keywords have been reviewed for relevance. The schema has no "reviewed" column, so this '
            + 'gate is closed by an explicit declaration (recorded in the run package) or by module 08 ownership claims — never by '
            + 'reading a neighbouring column and calling it a review. Default false.',
        },
        noCompetitors: {
          type: 'boolean',
          description:
            'Declare that there is deliberately no competitor input for this site. §27.2 allows "明确无竞品输入" as an answer; '
            + 'without either a competitor_set for the site or this declaration the 竞品组 gate degrades. Default false.',
        },
        sessionId: { type: 'string', description: 'DSH session id, so the report can be traced back to the conversation that produced it.' },
        agentRunId: {
          type: 'string',
          description:
            'Agent run this optimization round belongs to (module 12 `agent_run.id`). Stored as an identity index on the run (v47); '
            + 'the report prints that run\'s role / task type / status / steps. Omit when the round was not started from an agent run '
            + '— the report then says「本轮没有关联 Agent 运行」, which is NOT the same as「本系统没有 Agent 流程」.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'Return the package without creating a run row. Default false. A dry run still returns the nine-gate pre-flight report '
            + 'even when a gate blocks — seeing what is missing before committing is the reason to ask for one.',
        },
      },
      required: ['asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const asin = String(args?.asin ?? '').trim().toUpperCase()
      const marketplace = String(args?.marketplace ?? 'US').trim().toUpperCase()
      if (!/^[A-Z0-9]{10}$/.test(asin)) return { ok: false, error: `invalid ASIN "${args?.asin}" (expected 10 letters/digits)` }

      const asinRow = getAsin(store, asin, marketplace)
      const before = listingBefore(store, asin, marketplace)
      const includeMaster = args?.includeMaster === true
      const { coverage, keywords: all } = keywordSetFor(store, asin, marketplace, args?.maxKeywords ?? 200, { includeMaster })

      /* The input filter and the merge key are the same key by construction.
         Both must stay case-insensitive: the library may hold `Wireless Mouse`
         while the caller types `wireless mouse`, and a case-sensitive filter
         would drop that word silently rather than say it matched nothing. Going
         through `mergeKey` is what keeps this filter from drifting away from the
         key the merge uses. */
      const wanted = Array.isArray(args?.keywords) && args.keywords.length > 0
        ? new Set(args.keywords.map(item => mergeKey(item, marketplace)))
        : null
      const keywords = wanted === null ? all : all.filter(row => wanted.has(mergeKey(row.keyword, marketplace)))

      /* F13-04: which mode this run is in, resolved before anything is written.
         A typo is refused rather than defaulted — a run silently started as 全量
         when 审核 was asked for would generate copy the caller did not want. */
      const spec = modeSpec(args?.mode ?? 'full', { scope: args?.scope })
      if (spec === null) {
        const wantedScope = String(args?.scope ?? '').trim()
        return {
          ok: false,
          error: `unknown mode/scope ${JSON.stringify(args?.mode)}${wantedScope === '' ? '' : ` + ${JSON.stringify(args?.scope)}`} — `
            + `mode 必须是 ${OPTIMIZE_MODES.join(' | ')}`
            + `${wantedScope === '' && String(args?.mode ?? '') === 'targeted' ? '；targeted 必须给 scope' : ''}`
            + `；targeted 的 scope 取值：${TARGETED_SCOPES.map(entry => `${entry.id}(${entry.label})`).join(' / ')}`,
        }
      }

      /* F13-02: the nine gates. Evaluated here, before the run exists, and the
         answer is frozen into the package so `validate`, `save` and the page all
         judge by the same nine answers (§33's「优化运行固定使用当时判定结果」).
         `precheckFor` is the same call `amzn_optimize_precheck` and the optimize
         page make — one entry point, three consumers. */
      const declarations = {
        keywordsReviewed: args?.keywordsReviewed === true,
        noCompetitors: args?.noCompetitors === true,
      }
      const precheck = precheckFor(store, {
        asin,
        marketplace,
        keywords,
        mode: spec.id,
        scope: spec.scope,
        declarations,
      })

      /* A blocked pre-flight really stops the run: no run row, no data package,
         and a structured refusal that names the gate, what is missing and where
         to go and fix it. `dryRun` is the one exception and it is the useful one —
         the point of a dry run is to see the checklist before committing, and
         refusing to show it would send the caller back to guesswork. */
      if (precheck.blocked && args?.dryRun !== true) return precheckRefusal(precheck)

      /* The plan is built before any copy exists, and that ordering is the whole
         point. Deciding where each keyword goes *after* the draft is written is
         how a listing ends up with the title carrying everything and the other
         eleven positions empty — the complaint this round exists to fix. */
      const beforeFields = fieldsForListing(before)
      const plan = buildGlobalPlan({ keywords, listing: before, fields: beforeFields, marketplace })
      const options = {
        marketplace,
        category: args?.category,
        maxTitleChars: args?.maxTitleChars,
        maxHighlightsChars: args?.maxHighlightsChars,
      }
      const limits = limitsFor(marketplace, options)
      const profile = profileFor(marketplace)
      const provisional = provisionalNote(marketplace)
      const rules = ruleSnapshot(store)

      /* 增量's ordering, computed once and frozen with the run: it is a statement
         about *this* listing today, and recomputing it at save time would compare
         the draft against a plan built from a listing the run never saw. */
      const guidance = spec.id === 'incremental'
        ? incrementalGuidance({ store, asin, marketplace, fields: spec.fields, keywords, before })
        : null

      /* The writing strategy, read from the prompt library rather than living in
         the model's head. `resolvePrompts` is the same resolver the page uses, so
         editing the assemble prompt in the workbench changes what the next prepare
         hands over — that is the whole point of putting it in the database. It is
         stored in the run's package, so a report re-read later can show what the
         agent was told to do, not just what it produced. */
      /* 政策快照：冻结进这一轮的数据包，并渲染进提示词的 evidence 层。
         以前政策只活在政策库里，提示词层只有一句「遵守亚马逊政策」，等于没有依据。
         只取生效中的（superseded / expired 是历史），正文不进来（可能上万字），
         要读原文按 id 用 amzn_policy_list —— 包要能冻得住。 */
      const policySnapshot = activePolicies(store, marketplace)
      const policyText = policySnapshot.rows
        .map(policy => {
          const when = policy.effectiveFrom === null ? '生效日未记录' : `生效 ${policy.effectiveFrom}`
          const severity = policy.severity === null ? '严重度未判定' : `严重度 ${policy.severity}`
          const rules = policy.ruleIds.length === 0 ? '' : `；关联规则 ${policy.ruleIds.join('、')}`
          return `- ${policy.title}（${when}；${severity}${rules}）`
        })
        .join('\n')

      /* 政策挂着规则才有代码在查它。挂空（没挂 / 挂的规则已不在生效集）时，
         政策只是文字 —— 人以为有保护，于是不再盯这件事。这里算一次，下面点名。 */
      const policyDrift = policyRuleDrift(policySnapshot.rows, rules)
      const policyDriftText = policySnapshot.count === 0
        ? null
        : policyRuleDriftLine(policyDrift, rules.version)

      const writing = resolvePrompts(store, {
        module: 'optimize',
        variables: {
          scope: asin,
          selectedKeywords: keywords.map(entry => entry.keyword).join('、'),
          rulesVersion: rules.version,
          /* 空串 = 政策库没有生效中的政策 → `{{#policies}}` 整段消失（设计内降级）。
             有值则逐条列出标题 / 生效日 / 严重度 / 关联规则。 */
          policies: policyText,
        },
      }).assemble

      /* F14-02 §28.2：这一轮实际渲染的提示词版本 —— **身份索引**写进 v47 的列，
         逐层正文仍由 `package_json.prompts` 承载。两处同源（同一份 `writing`），
         所以列与包不可能记着不同的版本；报告会逐层核对并在不一致时说出来。
         `writing` 为空时是 `null`（= 这一轮没有可用的组装提示词），不是空串。 */
      const promptVersion = promptVersionOf(writing)

      /* 2026-10-25（R-26）：原来这里无条件生成 runId —— **dryRun 时它也会生成，
         而 dryRun 不建 run**。于是返回里带着一个格式上像 id、语义上不存在的字符串，
         输出末尾「交回来的格式」示例又把它当成「这一轮的 id」展示；
         任何照着它去调 amzn_optimize_validate 的人都会拿到「找不到这一轮」。

         实测：dryRun 返回 runId=c45bc8dc-…，而库里 optimization_run 里查不到它，总数也是 0。
         **一个「格式上像 id、语义上不是 id」的字符串比没有更坏，因为它会被当成事实使用。**

         dryRun 时给 null —— 后面所有用到它的地方都在 `if (dryRun !== true)` 块内，
         输出那一行也是二选一（dryRun 走「未建 run」那半句），所以不会读到 null。 */
      const runId = args?.dryRun === true ? null : randomUUID()

      /* ── F13-05 策略阶段：九项策略卡，在轮次建出来之前先算好 ────────────────────
         算在这里、写在那之后，是因为策略行挂在 run 上（外键）。九项全部来自这一轮
         已经算出来的东西（计划 / 门槛 / 模式 / 当前文案 / 关键词），**不重新读一遍
         活数据** —— 那会让「这一轮开始时看到的是什么」变成「今天是什么」。 */
      const strategyItems = buildStrategy(store, {
        asin,
        marketplace,
        keywords,
        plan,
        precheck,
        spec,
        fields: beforeFields,
        hasListing: before !== null,
      })

      /* ── F13-06 位置计划核对：**继承**模块 08 的持久计划 ──────────────────────
         只读：这里不写 08 的任何一行。写回发生在人工采纳时（`decidePlanCheck`），
         并且唯一走 `savePlan`。 */
      const planInherit = inheritPlan(store, { asin, marketplace, keywords })
      const planSuggestion = suggestPlan({ inherited: planInherit, allocation: plan.allocation })

      /* 政策快照已在上方算好（拼提示词要用），这里不再重复取数 —— 两次取数会出现
         「提示词里有 3 条、数据包里 2 条」这种没人能解释的差。 */

      if (args?.dryRun !== true) {
        insertOptimizationRun(store, {
          id: runId,
          asin,
          marketplace,
          status: 'running',
          sessionId: args?.sessionId ?? null,
          /* F14-02 §28.2 的两个身份索引（v47）。两列都可空：`promptVersion` 在提示词库
             没有可用组装提示词时是 null，`agentRunId` 在调用方没给时是 null
             —— 两种 null 都表示「这一轮没有记录」，不是「本系统没有」。 */
          promptVersion,
          agentRunId: args?.agentRunId ?? null,
          rulesVersion: rules.version,
          /* The version as an index, next to the snapshot that is the authority.
             `rules_json` is a copy — editing the rule set later cannot reach back
             into this run (arch §3.4). */
          ruleSetVersion: rules.version,
          rules,
          package: {
            keywords,
            /* 这一轮生效中的政策（第十一类证据的同一次取数）。它不是"背景资料"：
               写文案时「标题不得超过 200 字符」「不得出现 XX 功效宣称」这类约束
               就来自这里，而在此之前提示词层只写了一句"遵守亚马逊政策"。
               政策为空时是 `{count:0, rows:[]}` —— 是「读过了，0 条」，不是缺席。 */
            policies: policySnapshot,
            /* 政策挂的规则是否还在生效集里 —— 挂空的政策只是文字。
               冻结进包，是因为「当时挂没挂上」是这一轮的事实，不是今天的状态。 */
            policyDrift,
            /* The resolved numbers, not the request that produced them. A report
               re-read in three months has to say "title cap 200" and be able to
               show where that came from — re-deriving it would silently pick up
               whatever the rule file says by then. */
            options,
            limits,
            profile: { code: profile.code, label: profile.label, units: profile.units, authoritative: profile.authoritative },
            plan: { positions: plan.positions.length, plannedCells: plan.coverageMatrix.summary.plannedCells },
            /* F13-04: the mode as a value, not as a flag the readers each
               re-derive. `fields` is a count because the full list is 75 long and
               is a function of the registry; the count is what a budget needs. */
            mode: {
              id: spec.id,
              label: spec.label,
              scope: spec.scope,
              scopeLabel: spec.scopeLabel,
              generates: spec.generates,
              note: spec.note,
              fieldCount: spec.fields.length,
              budget: spec.budget,
            },
            /* F13-04 增量: the order and the three signal sets that produced it,
               kept so a report can explain *why* this field came first instead of
               printing an unexplained ranking. */
            guidance: guidance === null ? null : {
              order: guidance.order.slice(0, 40).map(entry => ({ position: entry.position, field: entry.field, priority: entry.priority, label: entry.label })),
              blockedFields: guidance.blockedFields,
              issueFields: guidance.issueFields,
              quickWinFields: guidance.quickWinFields,
            },
            /* F13-02: the nine answers, frozen with the run. */
            precheck,
            /* The writing strategy the agent was handed, as rendered text. Kept
               here so the run can answer "what was it told to write" the same way
               `rules_json` answers "what was it judged against". The layer order
               is canonical (fixed → evidence → contract), so a report can print
               them in a stable order. */
            prompts: writing.map(entry => ({
              layer: entry.layer,
              label: entry.label,
              version: entry.version ?? null,
              text: entry.text,
            })),
            before: before === null ? null : { title: before.title, bullets: before.bullets, description: before.description, search_terms: before.search_terms, item_highlights: before.item_highlights ?? null, source: before.source },
          },
        })
        workbench?.record('optimize:prepare', { runId, asin, marketplace, keywords: keywords.length }, 'plugin')

        /* F13-03: 十类证据与九项判定**同批冻结**。§33 要求「优化运行固定使用当时判定
           结果」，证据包是同一件事的另一半 —— 报告要能说「当时我看到的是这些」，而
           「当时」必须有一个不随今天变化的落点。四类本来就在包里（文案 / 关键词与计划
           / 规则 / Prompt），另外六类在这里第一次落下来。
           新建的轮次必然没有已冻结的行，所以这一次一定写成功；守卫在 save 那一侧。 */
        const frozenRun = getOptimizationRun(store, runId)
        freezeEvidence(store, runId, collectEvidence(store, { run: frozenRun }))

        /* F13-05: 九项策略卡与轮次同批冻结，且**未确认**（`confirmed_at` 为 NULL）。
           门禁在 validate(persist) 与 save 上：先策略后文案，确认之后草案才能进这一轮。 */
        writeStrategy(store, runId, strategyItems)
        /* F13-06: 这一轮继承到哪一版、建议了什么，与轮次同批记下来 —— 人裁决时看到的
           就是这一份，之后由裁决改写（写回 08 的新版本号也记在同一行）。 */
        writePlanCheck(store, runId, {
          planId: planInherit.planId,
          lineageId: planInherit.lineageId,
          version: planInherit.version,
          entries: planSuggestion.entries,
          uncovered: planSuggestion.uncovered,
          unmapped: planSuggestion.unmapped,
        })
      }

      const lines = []
      lines.push(`优化数据包 · ${asin} · ${marketplace}${args?.dryRun === true ? '（dryRun，未建 run）' : ` · run ${runId}`}`)
      lines.push('')

      /* The mode and the nine gates come first, before the data they qualify:
         a package whose reader skims to the writing template without seeing
         "核心数据过期" is the failure this ordering exists to prevent. */
      lines.push(`## 优化模式：${spec.label}`)
      lines.push(spec.note)
      lines.push(`本轮可写字段 ${spec.fields.length} 个${spec.budget === null ? '' : `，单轮上限 ${spec.budget.allowed} 个（${Math.round(spec.budget.ratio * 100)}% × ${spec.budget.total}）`}。`)
      if (spec.generates === false) lines.push('**审核模式：本轮不生成任何文案。** 下面的清单是检查范围，不是可写字段。')
      lines.push('')
      if (guidance !== null) {
        lines.push('**优先级（阻断 > 事实错误 > 高价值缺口 > 稳定内容）—— 这是顺序，不是字段顺序：**')
        lines.push(table(guidance.order.slice(0, 12), [
          { label: '#', value: row => row.position },
          { label: '字段', value: row => labelForField(row.field) },
          { label: '优先级', value: row => row.label },
          { label: '为什么', value: row => truncate(row.why, 60) },
        ]))
        lines.push('排在后两档的字段默认不动 —— 不为了「看起来不一样」重写稳定内容。')
        lines.push('')
      }
      lines.push(...renderPrecheckLines(precheck))
      lines.push('')

      /* F13-05 / F13-06 两块先画，再画提示词库的写作策略：提示词库讲的是「怎么写」，
         而这两块讲的是「这一轮到底写什么、凭什么」—— 先策略后文案的顺序在**输出的
         顺序**上也成立，读者不会先看到模板再看到它要服从的判断。 */
      /* 2026-10-25（R-45）：这里原来是**硬编码传了一个 
ull**（不是读库）。
         而传 null 的含义是「这一轮没有策略卡」，于是 `prepare` 的输出永远印：
           「门禁：**放行** —— 这一轮没有策略卡（本批之前建的轮次，或轮次不是 prepare 建的）」

         而它上面第 924 行刚刚 `writeStrategy(store, runId, strategyItems)` 写了一张。
         实测 run `4e60241a`：
             run.started_at      = 16:19:09.276Z
             strategy.created_at = 16:19:09.326Z   ← 晚了 50 毫秒
         紧接着 `amzn_optimize_validate { persist: true }` 被 `STRATEGY_UNCONFIRMED` 拒掉，
         报错说「这一轮的九项策略卡还没有人工确认」。

         **报告说放行，下一步说未确认，相隔不到一分钟。**

         修法：读库，不再传字面量。
         - dryRun 时不写卡 → 读不到行 → 门禁判「没有策略卡」（正确）
         - 正式跑时已写卡 → 读到那一行（`confirmed_at` 为 NULL）→ 「未确认，草案进不了这一轮」（正确）

         这一条比前面那些「同一屏两句矛盾」更严重：那些只是读起来别扭，**这一条会让流程真的卡住** ——
         一个 agent 读到「门禁放行」，写完草稿再撞 STRATEGY_UNCONFIRMED，收到一个它十分钟前就该知道的拒绝。

         ⚠️ 上面对「原来的写法」只用文字描述，**不把那串代码贴回来** ——
         这一条的自检判据是「源码里不许出现那串字面量」，而注释也算源码。
         今天已经有六次「在注释里复述旧写法、然后被自己的守门打红」。 */
      lines.push(...renderStrategyLines(strategyItems, strategyGate(readStrategyRow(store, runId))))
      lines.push(...renderPlanCheckLines(planInherit, planSuggestion))
      lines.push('')

      /* The strategy first, before any data: it says how to write, and the rest of
         the package says what to write from. It comes from the prompt library, so
         the user can change it without a code change. */
      lines.push('## 写作策略（提示词库）')
      if (writing.length === 0) {
        lines.push('⚠️ 提示词库里没有 optimize 的组装提示词。用 amzn_prompt_list 看看，或在工作台「优化提示词专区」补上 —— 这一轮没有给你任何写作策略。')
      } else {
        for (const layer of writing) {
          lines.push(`### ${layer.label}`)
          lines.push(layer.text)
          lines.push('')
        }
      }

      lines.push('## 站点档案')
      lines.push(`${profile.code} · ${profile.label}${profile.authoritative ? '' : '　⚠️ 本机规则文档只覆盖北美站（US/CA），这个站点的数字是按 Amazon 通用档位套的，没有经过该站点的规则源核验'}`)
      lines.push('')
      lines.push(table([
        { label: '标题上限', value: `${limits.titleMax} 字符` },
        { label: '标题建议', value: `${limits.titleMin}–${limits.titleRecommended} 字符（前 ${limits.titleGoldenZone} 是黄金锚点）` },
        { label: '移动端截断', value: `约 ${limits.titleMobileAnchor} 字符` },
        { label: 'Item Highlights', value: `${limits.itemHighlightsMax} 字符` },
        { label: '五点', value: `每条 ${limits.bulletMin}–${limits.bulletMax} 字符，共 ${limits.bulletsMax} 条` },
        { label: '描述', value: `${limits.descriptionMax} 字符` },
        { label: '后台搜索词', value: `${limits.backendMaxBytes} 字节（注意是字节）` },
        { label: '计量单位', value: `${profile.units.length} / ${profile.units.weight} / ${profile.units.temperature}` },
      ], [
        { label: '项目', value: row => row.label },
        { label: '这个站点的值', value: row => row.value },
      ]))
      lines.push(`标题上限受类目影响${args?.category ? `（当前类目 ${args.category}）` : '（如 apparel / shoes / jewelry 会降到 80）'}。`)
      if (provisional !== null) {
        lines.push('')
        lines.push(`⚠️ **站点规则未核验** ${provisional.text}`)
      }
      lines.push('')
      lines.push('**这个站点的购买习惯（影响文案怎么写，不只是写多长）:**')
      if (profile.habits.length === 0) {
        lines.push('- ⚠️ 这个站点没有核验过的购买习惯数据。下面所有关于"当地人怎么买"的判断都由你给出，不要照搬美国站的结论 —— 计量单位、颜色命名、场景词、尺寸写法在各地都不同。')
      } else {
        for (const habit of profile.habits) lines.push(`- ${habit.text}　（依据 ${habit.source}）`)
      }
      lines.push('')

      /* 政策放在「当前文案」之前：写文案时它比现状更靠前 —— 现状告诉你现在长什么样，
         政策告诉你**不许写成什么样**。以前这里只有提示词层的一句「遵守亚马逊政策」，
         模型没有任何可引用的条款。 */
      lines.push('## 本轮政策依据（写文案时的硬约束）')
      if (policySnapshot.count === 0) {
        lines.push(`⚠️ ${marketplace} 站点在政策库里没有生效中的政策 —— 这是「读过了，0 条」，`
          + '不是「没有政策」。本轮文案只受规则集约束；要加政策约束先 amzn_policy_import。')
      } else {
        for (const policy of policySnapshot.rows) {
          const when = policy.effectiveFrom === null ? '生效日未记录' : `生效 ${policy.effectiveFrom}`
          const severity = policy.severity === null ? '严重度未判定' : `严重度 ${policy.severity}`
          const rules = policy.ruleIds.length === 0 ? '' : `；关联规则 ${policy.ruleIds.join('、')}`
          lines.push(`- **${policy.title}**（${when}；${severity}${rules}）`)
        }
        lines.push('以上是**冻结在这一轮**的政策快照，不随政策库后续变动。要读原文：`amzn_policy_list`。')
        if (policyDriftText !== null) lines.push(policyDriftText)
        /* 「有政策」与「模型看得见政策」是两件事。提示词是**用户的资产**：
           模板里没有 {{policies}} 这段，值就会被渲染器丢掉 —— 那样这一节就只是
           给人看的，模型仍然什么都不知道。这里点名，而不是让人以为已经生效。 */
        const promptMentionsPolicies = Array.isArray(writing)
          && writing.some(layer => String(layer?.text ?? '').includes(policySnapshot.rows[0].title))
        if (!promptMentionsPolicies) {
          lines.push(`⚠️ 本轮有 ${policySnapshot.count} 条政策，但**当前提示词没有引用 {{policies}}** ——`
            + '模型看不到它们。到「优化提示词专区 → 组装提示词 → 证据层」加上 `{{#policies}}{{policies}}{{/policies}}`，'
            + '下一次 prepare 才会生效。')
        }
      }
      lines.push('')

      lines.push('## 当前文案')
      if (before === null) {
        lines.push('⚠️ 没有这个 ASIN 的文案（既没有 listing 行也没有采集快照）。先去采集，或用 amzn_asin_upsert 写入现状。')
      } else {
        lines.push(`来源 ${before.source === 'listing' ? 'listing 表' : '最新采集快照'}${before.version === null ? '' : ` · 版本 v${before.version}`}`)
        lines.push('')
        /* 2026-10-25 真实数据实测（R-4）：listing 行的 title 是 NULL，而 asin.title 有真实标题。
           原来的输出只印「(空)」—— **运营会以为这个商品没有标题，然后去重写一个已经有的标题。**
           本仓的采集只把标题写进 asin 表，不写 listing 表（listing 的唯一生产写入方是草案采纳），
           所以「listing 为空」和「商品页没有文案」是两件事，必须分开说。 */
        const asinTitle = String(asinRow?.title ?? '').trim()
        const titleMissing = String(before.title ?? '').trim() === ''
        lines.push(`**标题** (${String(before.title ?? '').length} 字符)`)
        lines.push(`> ${String(before.title ?? '(空)')}`)
        if (titleMissing && asinTitle !== '') {
          lines.push('')
          lines.push('⚠️ **本仓的 listing 表里没有标题 —— 但商品页上有。**（采集把标题写进 asin 表，不写 listing；listing 只由草案采纳写入）')
          lines.push(`> ${truncate(asinTitle, 200)}`)
          lines.push('别把这条当成「标题是空的」去重写：listing 全文要人工从卖家后台导出，或等草案采纳后由本仓写入。')
        }
        lines.push('')
        const bullets = Array.isArray(before.bullets) ? before.bullets : []
        lines.push(`**五点** (${bullets.length} 条)`)
        for (const [index, bullet] of bullets.entries()) lines.push(`> ${index + 1}. ${bullet}`)
        if (bullets.length === 0) lines.push('> (无)')
        lines.push('')
        lines.push(`**描述** (${String(before.description ?? '').length} 字符)`)
        lines.push('> ' + truncate(String(before.description ?? '(空)'), 300))
        lines.push('')
        lines.push(`**后台搜索词**: ${before.search_terms ? truncate(before.search_terms, 200) : '(未记录 —— 后台词只在卖家后台，采集拿不到，需要人工提供)'}`)
      }

      lines.push('')
      lines.push(`## 埋词位置（${EMBED_POSITIONS.length} 个，按权重降序）`)
      lines.push(table(EMBED_POSITIONS.map((position, index) => ({ ...position, rank: index + 1 })), [
        { label: '#', value: row => row.rank },
        { label: '位置', value: row => row.label },
        { label: '落点', value: row => row.where },
        { label: '权重', value: row => row.weightLabel },
      ]))
      lines.push('Item Highlights 不在 SOP §三 的 11 个位置里 —— 该 SOP 早于这个字段；它 2026-07 才进注册表，是 Alexa for Shopping 的检索入口，所以列进来。')
      lines.push('「变体关系父产品」与「Search Terms 推荐」没有对应的可写字段，落到这两处的词要人工在后台放。')

      lines.push('')
      lines.push('## 关键词分配（每个词一个主人 + 可复用的位置）')
      if (keywords.length === 0) {
        lines.push('⚠️ 这个 ASIN 一个关键词都没有。先用 amzn_keyword_discover 建库、amzn_keyword_scan 测覆盖。')
      } else {
        const allocation = plan.allocation
        lines.push(`共 ${keywords.length} 个词：标题 ${allocation.byOwner.title?.length ?? 0}　五点 ${allocation.byOwner.bullets?.length ?? 0}　后台词 ${allocation.byOwner.search_terms?.length ?? 0}　计划落点合计 ${plan.coverageMatrix.summary.plannedCells} 处`)
        lines.push('')
        lines.push(table(allocation.entries.slice(0, 30), [
          { label: '关键词', value: row => truncate(row.keyword, 28) },
          { label: '分层', value: row => row.tierLabel },
          { label: '排名', value: row => row.rank ?? '—' },
          { label: '主人', value: row => row.ownerLabel },
          { label: '还可复用到', value: row => (row.supporting.length === 0 ? '—' : row.supporting.map(item => item.positionLabel).join('+')) },
        ]))
        if (allocation.entries.length > 30) lines.push(`… 共 ${allocation.entries.length} 个，完整清单（含每条复用理由）在报告里。`)
        if (allocation.violations.length > 0) {
          lines.push('')
          lines.push('**分配冲突:**')
          for (const violation of allocation.violations) lines.push(`- ${violation.detail}`)
        }
        const embedding = buildEmbeddingPlan({ keywords, listing: before })
        if (embedding.quickWins.length > 0) {
          lines.push('')
          lines.push(`⭐ **白拿的相关性（${embedding.quickWins.length} 个）**: 已经在排名，但当前文案里根本没写 —— 优先补。`)
          lines.push(`   位置按分层走（T1/T2 进标题，T3/T4 进五点），不要因为「已经在排名」就都塞进标题：标题装不下，装下了也是稀释。`)
          lines.push(`   ${embedding.quickWins.slice(0, 12).map(entry => entry.keyword).join(' | ')}`)
        }
        const backend = backendCandidates({ plan: embedding, fields: beforeFields, marketplace })
        if (backend.length > 0) {
          lines.push('')
          lines.push(`后台词候选（249 字节的战争，已排除前端已有词）: ${backend.slice(0, 25).map(entry => entry.keyword).join(' | ')}${backend.length > 25 ? ` …共 ${backend.length}` : ''}`)
        }
        lines.push('')
        lines.push('⚠️ 埋词是**建议不是硬规则**：T1 的词丢了排名会掉，T4 的词硬塞进标题只会稀释。判断相关度是你的活。')
        lines.push('⚠️「主人」是必须写的位置，「还可复用到」是加分位置。同一个词出现在 3 个位置比 1 个位置更容易被检索到，但每次复用得给得出理由 —— 理由在报告里逐条列出。')
      }

      lines.push('')
      /* The vocabulary is narrowed to the mode's scope here rather than filtered
         later, because this table *is* the permission list a reader takes away:
         a 标题专项 whose table still shows all 75 fields is a licence to rewrite
         the description. */
      const vocabularyAll = fieldVocabulary(options, beforeFields)
      const vocabulary = vocabularyAll.filter(row => fieldInScope(spec, row.field))
      lines.push(spec.generates === false
        ? `## 检查范围（${vocabulary.length} 个字段，只检查不生成）`
        : `## ${spec.id === 'full' ? '全量优化字段' : '本轮可写字段'}（${vocabulary.length} 个，注册表共 ${vocabularyAll.length} 个）`)
      lines.push(`当前 listing 在作用域内有 ${vocabulary.filter(row => row.present).length} / ${vocabulary.length} 个字段有内容。下面每一个都可以写，标 ❌ 的现在没有内容。`)
      lines.push('')
      lines.push(table(vocabulary, [
        { label: '字段', value: row => row.label },
        { label: '章节', value: row => row.section },
        { label: '上限', value: row => `${row.max}${row.unit === 'bytes' ? 'B' : ''}` },
        { label: '现在', value: row => (row.present ? '有' : '❌ 空') },
        { label: '投递方式', value: row => (row.publishable ? '可粘贴' : '独立编辑器') },
      ]))
      lines.push('「可粘贴」= 能直接复制进卖家后台；「独立编辑器」= A+ 编辑器 / 品牌故事控制台 / Q&A 区 / 图片，文案要人工搬过去。')
      lines.push('')
      lines.push(`属性请按 attribute.<id> 的形式提交，例如 "attribute.material": "Fade-Resistant Chenille"。注册表里共 ${Object.keys(ATTRIBUTES).length} 项，其中标为必填的 ${REQUIRED_ATTRIBUTE_TARGET} 项。`)
      lines.push('')
      lines.push('**采集不到、也推断不出来、必须人工填的字段:** ' + MANUAL_FIELDS.map(field => field.label).join('、'))

      lines.push('')
      lines.push('## 字符预算（当前文案）')
      const budgets = measureDraft(beforeFields, options)
      if (budgets.length === 0) {
        lines.push('（没有可测量的字段）')
      } else {
        lines.push(table(budgets, [
          { label: '字段', value: row => row.label },
          { label: '当前', value: row => row.used },
          { label: '上限', value: row => row.max },
          { label: '单位', value: row => (row.unit === 'bytes' ? '字节' : '字符') },
          { label: '来源', value: row => (row.limitSource === 'documented' ? '文档规定' : '经验值') },
        ]))
        lines.push(`标题：前 ${limits.titleGoldenZone} 字符是黄金锚点，移动端约在第 ${limits.titleMobileAnchor} 字符截断${limits.limitsVerified ? '' : '（通用档位，未按本站核验）'}。`)
        lines.push('后台搜索词按**字节**算，其他按**字符**算 —— 一个中文字 3 字节。「经验值」是我们给的区间，不是文档规定的上限。')
      }

      lines.push('')
      lines.push('## 判定规则')
      lines.push(`规则版本 ${rules.version}（${rules.count} 条机检），来源 ${rules.source}。`)
      lines.push('')
      lines.push('**必须由你判断的（机检管不了）:**')
      /* F13-08：这里列的是**审阅清单**（14 项），与报告 8.3、工作台的审阅面板
         同一份 —— 给模型看的清单里少三项，它就不会去写自然度与说服力。
         `needsHuman` 的那三项标出来：它们连模型也只能提议（属性是事实、AI 占比
         是最终资产的属性、品牌语气本仓没有来源）。 */
      for (const item of REVIEW_ITEMS) {
        lines.push(`- ${item.label}${item.needsHuman === true ? '（只能人判）' : ''}: ${item.ask}　（依据 ${item.source}）`)
      }

      lines.push('')
      lines.push('## 收尾闸门（save 时逐条判）')
      lines.push(table(GATES, [
        { label: '闸门', value: row => row.label },
        { label: '判什么', value: row => row.what },
        { label: '依据', value: row => row.source },
      ]))
      lines.push('规则回答「这样合法吗」，闸门回答「这样算做完了吗」。一个 listing 可以完全合法却缺了 11 个章节里的 7 个 —— 那是闸门拦的，不是规则。')

      if (spec.generates === false) {
        /* 审核模式 writes nothing, so the drafting template is not merely
           discouraged here — it is absent. `amzn_optimize_validate` refuses a
           generated field on an audit run, and a package that still handed over
           the template would be inviting a refusal. */
        lines.push('')
        lines.push('## 交回来的格式（审核模式：不生成文案）')
        lines.push('审核模式没有可提交的 draft：`amzn_optimize_validate` 会拒绝任何生成字段。')
        lines.push('把你对现有 Listing 的检查结论直接写在回复里，并指出引用了哪条证据（现有文案 / 关键词包 / 规则 id / 竞品组）。')
        lines.push('要生成文案，另开一轮 full / incremental / targeted 的运行 —— 审核模式的运行不会变成生成运行。')
        return lines.join('\n')
      }

      lines.push('')
      lines.push('## 交回来的格式')
      lines.push('调用 `amzn_optimize_validate` 时按这个结构提交。**只提交你要改的字段**，没提交的字段不进报告、也不会被改动。')
      lines.push(`本轮模式是「${spec.label}」，只有作用域内的 ${spec.fields.length} 个字段会被接受（见上面的字段表）。`)
      lines.push('```')
      lines.push('{')
      lines.push('  "runId": "' + runId + '",')
      lines.push('  "draft": {')
      lines.push('    "title": "…",')
      lines.push('    "item_highlights": "…（≤' + limits.itemHighlightsMax + ' 字符，和标题是强制联动组，标题承诺的这里要对得上）",')
      lines.push('    "bullets": ["…", "…", "…", "…", "…"],')
      lines.push('    "description": "…（HTML 或纯文本都行）",')
      lines.push('    "search_terms": "…（≤' + limits.backendMaxBytes + ' 字节，别重复前端已有词）",')
      lines.push('    "aplus": [{ "module": "品牌故事", "headline": "…", "body": "…" }],')
      lines.push('    "brand_story": "…（品牌故事控制台，三件事：我们为谁做、为什么做、凭什么）",')
      lines.push('    "qa": [{ "question": "…", "answer": "…（答案里要有具体数字）" }],')
      lines.push('    "image_alt": { "main": "…", "1": "…", "2": "…" },')
      lines.push('    "attributes": { "material": "Fade-Resistant Chenille", "item_type": "…" }')
      lines.push('  },')
      lines.push('  "rationale": { "title": "改了什么、依据哪条规则、植入了哪些词", "bullet_1": "…" }')
      lines.push('}')
      lines.push('```')
      lines.push('每个字段的 `rationale` 是 SOP 强制的「优化说明」，会原样进报告 —— 没有它，报告就只是两段文字并排，读者无法判断该不该采纳。')
      lines.push('`attributes` 里的每一项都要写 `rationale` 里的对应说明：属性是**事实**，不是文案。从标题推断出来的材质如果没人确认过，就不要填。')
      lines.push('A+ / 品牌故事 / Q&A / 图片 Alt Text 这四组不在卖家后台的"编辑 listing"页里，要去各自的编辑器。草稿照样提交、照样校验、照样进报告，只是末尾会标「独立编辑器」。')

      return lines.join('\n')
    },
  }
}

export function optimizeValidateTool({ store, workbench }) {
  return {
    name: 'amzn_optimize_validate',
    description:
      'Check a draft against the rule set, the field budgets and the six closing gates. Returns every violation with the '
      + 'rule id, severity (block = Amazon rejects or de-indexes it; warn = legal but weaker) and the doc section it comes '
      + 'from, plus the character/byte budget of each field, the embedding-coverage matrix (planned vs actual places) and '
      + 'the gate roster. '
      + 'Rules answer "is this legal"; gates answer "is this finished" — a listing can be perfectly legal and still be '
      + 'missing 7 of the 11 sections, and only the gates catch that. '
      + 'Call it as many times as you need — rewriting until nothing is blocked and the gates pass is the intended loop. '
      + 'Set persist to also store the drafts on the run, so a report can be built from them later. '
      + 'Warns are not blockers: a draft with warnings is publishable, and treating them as blockers means nothing ships.',
    parameters: {
      type: 'object',
      properties: {
        draft: {
          type: 'object',
          description: 'The draft. Accepts title / bullets[] or bullet_1..5 / description / search_terms / item_highlights / '
            + 'aplus[] or aplus_1..6 / brand_story / qa[] or qa_1..8 / image_alt{} or image_alt_* / attributes{} or attribute.<id> / video_script.',
        },
        runId: { type: 'string', description: 'Run to validate against. Omit to validate without a run (no rule snapshot recorded).' },
        asin: { type: 'string', description: 'Used for the brand/listing context rules when no runId is given.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US. Decides every limit and unit.' },
        category: { type: 'string', description: 'Category — apparel/shoes/jewelry cap the title at 80 chars.' },
        maxTitleChars: { type: 'number', description: 'Override the title cap.' },
        maxHighlightsChars: { type: 'number', description: 'Override the Item Highlights cap.' },
        rationale: { type: 'object', description: 'Per-field 优化说明, e.g. { "title": "…" }. Only used when persisting.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords this draft was supposed to embed; used for the coverage delta and the plan.' },
        trim: { type: 'boolean', description: 'Also return each field trimmed to its budget (word boundaries preserved). Default false.' },
        persist: { type: 'boolean', description: 'Store the drafts on the run. Default false.' },
      },
      required: ['draft'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const draft = args?.draft
      if (draft === null || typeof draft !== 'object') return { ok: false, error: 'draft is required and must be an object' }

      const run = args?.runId ? getOptimizationRun(store, args.runId) : null
      if (args?.runId && run === null) return { ok: false, error: `no optimization run ${args.runId}` }

      /* F13-04 审核模式: an audit run generates nothing, so a draft submitted
         against one is refused before it is even normalised. §27.2's "只检查不
         生成" is only real if it is enforced somewhere; a mode that changed a
         label and nothing else would let the check turn into a rewrite silently. */
      const spec = run === null ? null : runModeSpec(run)
      if (spec !== null && spec.generates === false) {
        const refusal = auditRefusal(spec, args?.draft)
        if (refusal !== null) return refusal
      }

      /* F13-02: the run's own pre-flight, frozen at prepare and read back here.
         A blocking gate means this run was never supposed to produce copy, so the
         submission stops before anything is read or written. A run that predates
         the feature carries no report; for those the gates are evaluated now,
         because "no report" is not the same answer as "passed". */
      if (run !== null) {
        const refusal = precheckRefusal(precheckForRun(store, run))
        if (refusal !== null) return refusal
      }

      /* F13-05: 只有**落库**才被策略门禁拦。不带 persist 的校验是只读的 ——
         拦它等于把「试着校验一下」也变成一次需要人点头的动作，而那不会让策略
         更容易被确认，只会让人绕开这个工具。 */
      if (run !== null && args?.persist === true) {
        const refusal = strategyRefusalFor(store, run)
        if (refusal !== null) return refusal
      }

      /* The scope this draft is being written in, stamped onto every persisted
         field below. Without it a draft is `unknown` at the submit gate and is
         refused there — so a persist that could not find a context says so here
         rather than leaving the reader to discover it at save time. */
      const currentContextId = workbenchContextId(workbench)

      const asin = String(run?.asin ?? args?.asin ?? '').trim().toUpperCase()
      const marketplace = String(run?.marketplace ?? args?.marketplace ?? 'US').trim().toUpperCase()
      const options = {
        marketplace,
        category: args?.category,
        maxTitleChars: args?.maxTitleChars,
        maxHighlightsChars: args?.maxHighlightsChars,
      }

      /* The rules read `listing.brand` for the brand-position and all-caps checks,
         so this has to be a flat row — `getAsin` returns a wrapper object. */
      const listing = asin === '' ? null : (getListing(store, asin, marketplace) ?? getAsin(store, asin, marketplace)?.row ?? null)
      const fields = normalizeDraft(draft)
      if (Object.keys(fields).length === 0) return { ok: false, error: 'draft has no recognisable fields (title / bullets / description / search_terms / item_highlights / aplus / qa / attributes)' }

      const planned = keywordsFrom(store, asin, marketplace, args?.keywords)

      /* Which roster judges this draft, from the one function that decides it:
         the run's own snapshot when a run was given, the live rule library
         otherwise. Passing the descriptor — not a bare array — is what keeps the
         origin attached, so the reader below can say which of the two they got.
         Before this, a runless call fell through to the code constant: a rule the
         user had switched off in 规则中心 still fired, which is what made the
         switch look inert at the first place anyone would try it. */
      const roster = rosterForValidation(store, run)
      const result = validateDraft({
        fields,
        listing,
        keywords: planned,
        options,
        roster,
      })

      /* The plan and the gates are built from the *draft being checked*, not from
         the live listing. A draft that is still missing its attributes should fail
         the completeness gate now — reporting that at save time would be the same
         verdict delivered one step too late to act on. */
      const plan = buildGlobalPlan({ keywords: planned, listing, fields, validation: result, marketplace })
      const gates = runGates({ fields, listing, keywords: planned, validation: result, plan, options })

      const lines = []
      lines.push(`合规校验 · ${result.counts.block} 阻断 / ${result.counts.warn} 警告　（${result.fields.length} 个字段）`)
      /* Read off the verdict itself, not off the local `roster` — the point is
         that the result knows what judged it, so no caller can print a verdict
         without also being able to say which roster produced it. */
      lines.push(rosterLine(result.roster))
      lines.push(`闸门 · ${gates.passed}/${gates.total} 通过${gates.ok ? '' : `　未过：${gates.gates.filter(gate => !gate.pass).map(gate => gate.label).join('、')}`}`)
      if (result.counts.block === 0) {
        lines.push(result.counts.warn === 0 ? '✅ 机检全过，可以发布。' : '✅ 没有阻断项，可以发布；下面是可选的改进点。')
      } else {
        lines.push('❌ 有阻断项，改完再提交（重写后重新调用本工具）。')
      }
      lines.push('')
      lines.push('规则回答「这样合法吗」，闸门回答「这样算做完了吗」。下面分开列 —— 一个 listing 可以完全合法却缺了 11 个章节里的 7 个。')
      lines.push('')

      lines.push('## 收尾闸门')
      lines.push(table(gates.gates, [
        { label: '闸门', value: row => row.label },
        { label: '结果', value: row => (row.pass ? '✅ 通过' : '❌ 未过') },
        { label: '说明', value: row => truncate(row.detail, 90) },
      ]))
      lines.push('')

      lines.push('## 规则命中')
      const blocks = result.violations.filter(v => v.severity === 'block')
      const warns = result.violations.filter(v => v.severity === 'warn')
      if (result.violations.length === 0) lines.push('机检 0 命中。')
      for (const [label, list] of [['阻断（必须改）', blocks], ['警告（可改可不改）', warns]]) {
        if (list.length === 0) continue
        lines.push(`${label}:`)
        lines.push(table(list, [
          { label: '字段', value: row => labelForField(row.field) },
          { label: '规则', value: row => row.ruleId },
          { label: '依据', value: row => truncate(row.source, 30) },
          { label: '说明', value: row => truncate(row.messages.join('；'), 70) },
        ]))
        lines.push('')
      }
      lines.push('**这份校验不判定的事**（需要你自己判；工作台的「校验体系 → Agent 审阅」面板逐项记结论，'
        + '每条结论必须引用可核对的证据；报告与面板列的是同一份 14 项清单）:')
      for (const item of REVIEW_ITEMS) {
        lines.push(`- ${item.label}${item.needsHuman === true ? '（只能人判）' : ''}: ${item.ask}`)
      }

      lines.push('')
      lines.push('## 埋词完成度')
      const coverage = plan.coverageMatrix.summary
      /* 完成率没有分母时印「不判读」，不印 0% / 100% / NaN%。 */
      lines.push(`计划落点 ${coverage.plannedCells} 处 / 实际命中 ${coverage.reachedCells} 处（完成率 ${coverage.fillRate === null || coverage.fillRate === undefined ? '不判读：这一轮没有可判的分母' : Math.round(coverage.fillRate * 100) + '%'}）`)
      lines.push(`写入的位置 ${plan.writtenPositions.length} / ${plan.positions.length} 个　·　平均每词 ${coverage.averagePlaces} 处（计划 ${coverage.averagePlanned} 处）`)
      lines.push('')
      lines.push(table(plan.coverageMatrix.rows.filter(row => row.plannedCount > 0 || row.total > 0).slice(0, 20), [
        { label: '关键词', value: row => truncate(row.keyword, 26) },
        { label: '分层', value: row => row.tier ?? '未测' },
        { label: '主人', value: row => labelForField(row.owner) },
        /* 2026-10-25（R-44）：**这三列原来不构成一个算式。**
           「实际」印的是 `row.total`（所有位置的命中数，**包含不可核对的位置**如 adsBroad），
           而「计划」印 `row.plannedCount`、`gap` 用 `planned − reached`（**只数可核对的位置**）。
           于是出现 `实际 3 / 计划 2 / 还差 1` —— 三个数来自两套口径，读者算不出来。

           实测那一行：`total=3`（3 处命中，其中 1 处在不可核对的位置）、
           `plannedCount=2`（只有 2 个位置可核对）、`reached=1`（2 个里只命中 1 个）、`gap=1`。
           **四个数都对，但摆在一起会让人以为「实际比计划还多，却还差 1」。**

           改法：「实际」也只数**可核对**的那部分 —— 与「计划」「还差」同一套口径。
           不可核对的位置本来就不该进分母（plan.js:744 的注释说的就是这个）。 */
        { label: '实际', value: row => (Array.isArray(row.planned) ? row.planned.filter(t => row.cells?.[t] === true).length : row.total) },
        { label: '计划', value: row => row.plannedCount },
        { label: '还差', value: row => (row.gap > 0 ? row.gap : '0') },
      ]))
      lines.push('「还差」不为 0 的词就是这一轮没埋到位的词 —— 这是「埋词要尽可能多」的可核对版本。')
      if (plan.allocation.violations.length > 0) {
        lines.push('')
        lines.push('**分配冲突:**')
        for (const violation of plan.allocation.violations) lines.push(`- ${violation.detail}`)
      }

      lines.push('')
      lines.push('## 字符预算')
      lines.push(table(measureDraft(fields, options), [
        { label: '字段', value: row => row.label },
        { label: '用量', value: row => row.used },
        { label: '上限', value: row => row.max },
        { label: '单位', value: row => (row.unit === 'bytes' ? '字节' : '字符') },
        { label: '余量', value: row => (row.remaining >= 0 ? row.remaining : `超 ${-row.remaining}`) },
      ]))

      if (args?.trim === true) {
        const trimmed = trimDraft(fields, options)
        if (trimmed.changes.length === 0) {
          lines.push('', '预算裁剪: 全部字段都在预算内，没有改动。')
        } else {
          lines.push('', '预算裁剪（只在词边界切，不切半个单词）:')
          for (const change of trimmed.changes) {
            lines.push(`- ${change.label}: 压到 ${change.used}/${change.max} ${change.unit === 'bytes' ? '字节' : '字符'}，丢掉「${truncate(change.dropped, 60)}」${change.hardCut ? '（单个词就超长，只能硬截）' : ''}`)
          }
          lines.push('', '裁剪后的字段:')
          for (const change of trimmed.changes) lines.push(`**${change.label}**\n> ${trimmed.fields[change.field]}`)
        }
      }

      /* Coverage is only meaningful when we know which words were supposed to be
         covered; guessing a set would produce a delta nobody asked for. */
      if (asin !== '' && run !== null) {
        const before = listingBefore(store, asin, marketplace)
        const delta = coverageDelta({ keywords: keywordsFrom(store, asin, marketplace, args?.keywords), before, after: fields })
        lines.push('', '## 关键词覆盖变化')
        lines.push(`优化前 ${delta.summary.beforeCovered} → 优化后 ${delta.summary.afterCovered}（净 ${delta.summary.delta >= 0 ? '+' : ''}${delta.summary.delta}）`)
        if (delta.gained.length > 0) lines.push(`新增: ${delta.gained.slice(0, 20).map(entry => entry.keyword).join(' | ')}${delta.gained.length > 20 ? ` …共 ${delta.gained.length}` : ''}`)
        if (delta.lost.length > 0) {
          lines.push(`⚠️ **丢失 ${delta.lost.length} 个**: ${delta.lost.slice(0, 20).map(entry => `${entry.keyword}(${entry.tierLabel}${entry.rank === null ? '' : ` 排名${entry.rank}`})`).join(' | ')}`)
          lines.push('   已经在排名的词丢掉之后，排名会在几周内慢慢消失，而新文案本身读起来更好。确认是有意为之再继续。')
        }
      }

      /* Which of this run's stored drafts the current scope has already
         invalidated, said before anything is written. Only `context_changed` is
         listed: a draft with no recorded context is a different problem with a
         different remedy, and it already has its own place on the 待办 list. */
      if (run !== null) {
        const stale = run.drafts
          .filter(draft => draftContextState(draft, currentContextId) === 'context_changed')
          .map(draft => labelForField(draft.field))
        if (stale.length > 0) {
          lines.push('', `⚠️ 上下文已变化：这个 run 里有 ${stale.length} 个草案是别的上下文写的（${stale.join('、')}）。`
            + '提交它们会被拒绝；按当前上下文重新校验并 persist，它们会重新记在当前上下文下。')
        }
      }

      if (args?.persist === true) {
        if (run === null) {
          lines.push('', '⚠️ 没有 runId，无法落库。先调 amzn_optimize_prepare 拿一个 run。')
          return lines.join('\n')
        }
        /* `before` comes from the current listing, not from a previous draft:
           the question the report answers is "what changed against the copy that
           is live", and a draft overwritten twice would otherwise compare the
           new text against the intermediate one. */
        const beforeFields = fieldsForListing(listingBefore(store, asin, marketplace))
        const planned = keywordsFrom(store, asin, marketplace, args?.keywords)

        /* F13-04 专项: the scope is a permission list, so a field outside it is
           refused here — before the first row is written, and naming every
           offending field rather than the first one. */
        const outOfScope = scopeRefusal(spec, fields)
        if (outOfScope !== null) return outOfScope

        /* F13-04 增量: the ≤30% cap, counted against the live listing's own
           values rather than against how many fields the caller happened to send
           — 20 fields of which 3 differ is a 3-field round. */
        const changed = Object.entries(fields)
          .filter(([field, value]) => String(value ?? '') !== String(beforeFields[field] ?? ''))
          .map(([field]) => field)
        const overflow = incrementalOverflow(spec, changed.length)
        if (overflow !== null) return { ...overflow, fields: changed }

        let stored = 0
        for (const [field, value] of Object.entries(fields)) {
          upsertOptimizationDraft(store, {
            runId: run.id,
            field,
            before: beforeFields[field] ?? null,
            after: value,
            /* The context this draft was written in (v19's column). A persist is
               a (re-)generation, so it stamps the current scope even over a
               draft that recorded an older one — which is exactly the remedy the
               submit gate's refusal asks for. */
            contextId: currentContextId,
            violations: result.violations.filter(v => v.field === field || (field.startsWith('bullet_') && v.field === 'bullets')),
            /* The same word-match the coverage matrix uses. A bare `includes`
               here would report "car" as embedded in "cart" — so the per-field
               "植入了" line and the coverage matrix could contradict each other
               in the same report. One matcher, one answer. */
            keywords: planned.filter(entry => entry.tier !== null && keywordInText(entry.keyword, value)).map(entry => ({ keyword: entry.keyword, tier: entry.tier })),
            rationale: args?.rationale?.[field] ?? null,
          })
          stored += 1
        }
        lines.push('', `已落库 ${stored} 个字段的草稿到 run ${run.id}。`)
      }

      return lines.join('\n')
    },
  }
}

export function optimizeSaveTool({ store, workbench, pagePath }) {
  return {
    name: 'amzn_optimize_save',
    description:
      'Finish a run: mark which fields are accepted, run the six closing gates against the accepted text, write the report '
      + '(Markdown + self-contained HTML), and optionally apply the accepted text to the stored listing. '
      + 'Only accepted fields are ever applied, and applying is off unless applyListing is true — this is the one place '
      + 'the plugin overwrites the copy, so it takes an explicit flag rather than a default. '
      + 'Only the fields the listing table owns are applied (title / bullets / description / search_terms / item_highlights / '
      + 'attributes); A+ / 品牌故事 / Q&A / Alt Text are drafted into the report but have no write path from here. '
      + 'This writes to the database: confirm the drafts with the user first.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run to finish.' },
        accept: { type: 'array', items: { type: 'string' }, description: 'Fields to mark accepted, e.g. ["title","bullet_1"]. Omit to accept every field with no blocking violation.' },
        reject: { type: 'array', items: { type: 'string' }, description: 'Fields to mark rejected.' },
        summary: { type: 'string', description: 'Executive summary written by you. Goes at the top of the report.' },
        applyListing: { type: 'boolean', description: 'Also write the accepted text into the stored listing. Default false.' },
        sourceId: { type: 'string', description: 'Source id for the listing write. Default manual.' },
        status: { type: 'string', description: 'done (default) | failed | abandoned' },
        category: { type: 'string', description: 'Only needed when the run did not record it — the run package is used otherwise.' },
        maxTitleChars: { type: 'number', description: 'Only needed if the run did not record it.' },
        maxHighlightsChars: { type: 'number', description: 'Only needed if the run did not record it.' },
        confirm: {
          type: 'boolean',
          description:
            'Set true when this workspace has turned on the 接受草案 二次确认 and this call will mark at least one '
            + 'field accepted. Without it such a call is refused with code APPROVAL_REQUIRED and no draft is decided. '
            + 'A call that rejects everything never needs it.',
        },
      },
      required: ['runId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const runId = String(args?.runId ?? '').trim()
      if (runId === '') return { ok: false, error: 'runId is required' }
      /* Refused here as well as in the store, and the two are not the same job:
         this one gives the agent a refusal it can act on, and the store's guard
         is what makes the closed set true for every other writer. Checked before
         anything is read or written, so a bad status costs no work. */
      const finalStatus = String(args?.status ?? 'done')
      if (!OPTIMIZATION_RUN_STATUSES.includes(finalStatus)) {
        return {
          ok: false,
          error: `unknown status ${JSON.stringify(args?.status)} — expected one of: ${OPTIMIZATION_RUN_STATUSES.join(' | ')}`,
        }
      }
      const run = getOptimizationRun(store, runId)
      if (run === null) return { ok: false, error: `no optimization run ${runId}` }
      if (run.drafts.length === 0) {
        return { ok: false, error: `run ${runId} has no drafts — call amzn_optimize_validate with persist: true first` }
      }

      /* F13-04: same two mode boundaries the persist path asks, asked again here
         because `save` is the other door — a run whose drafts were written before
         a mode change, or by a caller that went straight to the store, still has
         to pass the same two rules. */
      const spec = runModeSpec(run)
      if (spec !== null && spec.generates === false) {
        const refusal = auditRefusal(spec, Object.fromEntries(run.drafts.map(draft => [draft.field, draft.after])))
        if (refusal !== null) return refusal
      }

      /* F13-02: the pre-flight this run was started under. Blocked runs produce no
         report and no listing write — the refusal comes before the 接受草案 gate
         and before any decision row is written, so a refusal costs no write. */
      const precheckRefused = precheckRefusal(precheckForRun(store, run))
      if (precheckRefused !== null) return precheckRefused

      /* F13-05: 收尾是「进入生成」的另一扇门 —— 一份没确认过策略的报告，就是这一批
         要消灭的那个东西。拒绝在任何写入之前，所以一次拒绝不花任何代价。 */
      const strategyRefused = strategyRefusalFor(store, run)
      if (strategyRefused !== null) return strategyRefused

      const acceptList = Array.isArray(args?.accept) ? new Set(args.accept) : null
      const rejectList = Array.isArray(args?.reject) ? new Set(args.reject) : new Set()
      /* Decided first, persisted after. `setDraftAccepted` used to run inside this
         loop, which meant the 接受草案 gate below would have refused *after*
         writing the decisions it was refusing. */
      const decisions = run.drafts.map(draft => {
        const violations = parseJson(draft.violations_json, [])
        const blocked = violations.some(v => v.severity === 'block')
        let accepted
        if (rejectList.has(draft.field)) accepted = false
        else if (acceptList !== null) accepted = acceptList.has(draft.field)
        /* Default: accept what nothing blocks. Accepting a blocked field by
           default would make the flag meaningless, and the block would end up in
           the report as "accepted" — a contradiction the reader cannot resolve. */
        else accepted = !blocked
        return { field: draft.field, accepted, blocked, violations: violations.length }
      })

      /* 上下文闸门 (F01-01 验收第 4 条). A draft written under one scope and
         accepted under another is the quiet failure `domain/optimize/context.js`
         exists to stop: it is well formed, it validates, and the report it
         produces is a confident answer about the wrong product on the wrong
         site. Asked only for the fields this call would actually **accept** — a
         call that rejects everything is not submitting anything — and asked
         before the first `setDraftAccepted`, so a refusal leaves the run exactly
         as it was and the caller can re-prepare.
         `unknown` (no recorded context) is refused too: that is this module's
         documented direction, and the 待办 list already carries those rows. */
      const accepting = decisions.filter(decision => decision.accepted === true)

      /* F13-04 增量: the ≤30% cap over what this round actually delivers — the
         accepted fields whose text differs from the copy they replace. Counted
         before the first write, so an over-budget round leaves the run exactly as
         it was and the caller can hand back a shorter list. */
      const acceptedChanged = decisions
        .filter((decision) => {
          if (decision.accepted !== true) return false
          const draft = run.drafts.find(entry => entry.field === decision.field)
          return String(draft?.after ?? '') !== String(draft?.before ?? '')
        })
        .map(decision => decision.field)
      const overflow = incrementalOverflow(spec, acceptedChanged.length)
      if (overflow !== null) return { ...overflow, fields: acceptedChanged }

      if (accepting.length > 0) {
        const currentContextId = workbenchContextId(workbench)
        const stale = accepting
          .map(decision => ({
            field: decision.field,
            verdict: canSubmitDraft(run.drafts.find(draft => draft.field === decision.field), currentContextId),
          }))
          .filter(entry => entry.verdict.ok !== true)
        if (stale.length > 0) {
          /* The message names the change when *any* field changed context: a
             refusal that only said "no context recorded" while another field was
             written on the other site would report the smaller problem. */
          const primary = stale.find(entry => entry.verdict.state === 'context_changed') ?? stale[0]
          const states = [...new Set(stale.map(entry => entry.verdict.state))]
          return {
            ok: false,
            code: primary.verdict.code,
            state: states.length === 1 ? states[0] : states,
            fields: stale.map(entry => entry.field),
            error: `${primary.verdict.error}（涉及字段：${stale.map(entry => entry.field).join('、')}）`,
          }
        }
      }

      /* 接受草案闸门。只在这次调用**真的会采纳**字段时问：一份全被驳回的 run
         没有在采纳任何东西，把它也拦下来会让这个闸门的名字变成「写优化结果」。 */
      if (accepting.length > 0) {
        const refusal = approvalRefusal(store, 'acceptDraft', args?.confirm,
          `这次会采纳 ${accepting.length} 个字段：${accepting.map(decision => decision.field).join('、')}。`
          + '采纳只写进报告，真正改 listing 还要 applyListing。确认无误就再调一次并带 confirm: true。')
        if (refusal !== null) return refusal
      }

      for (const decision of decisions) setDraftAccepted(store, runId, decision.field, decision.accepted)

      const refreshed = getOptimizationRun(store, runId)
      /* ── F13-03：冻结后拒写守卫 ─────────────────────────────────────────────
         证据包在 prepare 时冻好，这里**再收一次**并交给 `freezeEvidence`：
           · 还没有行（本批之前建的轮次）→ 补冻，并在输出里说明这是补冻；
           · 已经冻过且内容一致 → 幂等，什么都不写；
           · 已经冻过但内容**变了** → 拒写，**一个字节都不改**，并把漂移的类目点名报出来。
         最后一种是真的会发生：这一轮开始之后又跑过一次采集 / 质量扫描，`listing 历史`
         或 `质量缺失项` 就与冻结时不同了。报告写的是**冻结的那一份**，所以这里不覆盖它
         —— 覆盖会让报告与它引用的证据对不上，而没有任何东西会重新渲染那份报告。
         收尾本身照常进行：save 与证据包是两件事，不能因为证据漂移就拒绝出一份报告。

         **冻结点在 `updateOptimizationRun` 之后**，理由是「补冻」这个判断必须是**从内容
         算得出来的**：`readEvidence` 拿 `frozen_at` 与 run 的 `finished_at` 比 —— 冻结
         晚于收尾就是补冻。放在收尾之前，这两个时刻的先后就永远说不清，那个布尔值也就
         只能靠一个自报的标记。 */
      let evidence = { ok: true, unchanged: true, written: 0, frozenAt: null }
      /* `getAsin` returns { row, snapshots, provenance, keywords, listing } — the
         report wants the flat ASIN row, and handing it the wrapper produced a
         product section of empty cells that looked like missing data. */
      const asinRow = getAsin(store, refreshed.asin, refreshed.marketplace)?.row ?? null
      const before = listingBefore(store, refreshed.asin, refreshed.marketplace)
      const { keywords } = keywordSetFor(store, refreshed.asin, refreshed.marketplace, 500)

      /* The options come from the run's own package, not from today's defaults.
         A run started for JP with a category override has to be reported with
         those numbers even if the caller forgot to pass them again — otherwise
         the report judges a Japanese draft against US limits and says so
         confidently. */
      const storedPackage = parseJson(refreshed.package_json, null)
      const storedOptions = storedPackage?.options ?? {}
      const options = {
        marketplace: refreshed.marketplace,
        category: args?.category ?? storedOptions.category,
        maxTitleChars: args?.maxTitleChars ?? storedOptions.maxTitleChars,
        maxHighlightsChars: args?.maxHighlightsChars ?? storedOptions.maxHighlightsChars,
      }

      const afterFields = Object.fromEntries(refreshed.drafts.filter(d => d.after !== null && d.after !== undefined).map(d => [d.field, d.after]))
      const coverage = coverageDelta({ keywords, before, after: afterFields })

      /* Validated and gated against the *accepted* text, so the report's compliance
         section describes what is actually being handed over. Running the gates
         against the full draft would pass on fields the user just rejected. */
      const acceptedFields = Object.fromEntries(
        refreshed.drafts.filter(draft => draft.accepted === 1 && draft.after).map(draft => [draft.field, draft.after]),
      )
      const finalFields = Object.keys(acceptedFields).length > 0 ? acceptedFields : afterFields
      /* Judged through the same resolver `validate` used, so the report's
         compliance section and the validate output the user just read cannot
         disagree about the same draft. A run always has a snapshot by now; the
         resolver still handles the runless case rather than assuming. */
      const roster = rosterForValidation(store, refreshed)
      const validation = validateDraft({
        fields: finalFields,
        listing: before,
        keywords,
        options,
        roster,
      })
      const plan = buildGlobalPlan({ keywords, listing: before, fields: finalFields, validation, marketplace: refreshed.marketplace })
      const gates = runGates({ fields: finalFields, listing: before, keywords, validation, plan, options })

      /* The listing write happens BEFORE the report is rendered, so the report
         can state what actually happened instead of guessing. It is captured
         rather than allowed to throw here: the report must always be produced,
         and a failed write must be *recorded* in it — a report that stays silent
         about a write that failed is the lie this whole area exists to prevent.
         The failure is re-raised after the report is stored. */
      let applyListing = null
      if (args?.applyListing === true) {
        try {
          const accepted = acceptedFields
          const bullets = BULLET_FIELDS.map(field => accepted[field]).filter(Boolean)
          /* Only the fields the listing table owns are written here — six groups:
             title / bullet_* / description / search_terms / item_highlights /
             attribute.*. A+, brand story, Q&A and Alt Text live in surfaces this
             plugin has no write path to, so claiming to have "applied" them would
             be a lie the user only discovers in Seller Central. They are drafted,
             not applied. */
          const attributes = Object.fromEntries(
            Object.entries(accepted)
              .filter(([field]) => isAttributeField(field))
              .map(([field, value]) => [field.slice('attribute.'.length), value]),
          )
          const saved = upsertListing(store, {
            asin: refreshed.asin,
            marketplace: refreshed.marketplace,
            title: nullIfBlank(accepted.title),
            bullets: bullets.length > 0 ? bullets : null,
            description: nullIfBlank(accepted.description),
            /* R-13 的第二个入口：`upsertListing` 是 `COALESCE(excluded.x, listing.x)` ——
               传 **null** 会保留旧值，传**空串**会把已有值覆盖成空。
               `validate` 那一门（t89）已经挡住空串进 accepted，但这里不能只靠上游：
               只要有人绕过 validate 直接 save，一个空串就会把已经写好的后台词清掉。
               **同一条规则的两个入口要一起守**，否则守的是入口，不是规则。 */
            searchTerms: nullIfBlank(accepted.search_terms),
            itemHighlights: nullIfBlank(accepted.item_highlights),
            attributes: Object.keys(attributes).length > 0 ? attributes : null,
            sourceId: args?.sourceId ?? 'manual',
            /* This write is the plugin's own draft, not the storefront's copy.
               Recording it lets a *later* report label its 「优化前」 as
               "本插件上一版草稿 —— 不是线上真实文案" instead of comparing against
               its own shadow while sounding like it compared against the live
               listing. */
            origin: 'draft-applied',
          })
          /* `applied` counts the fields that actually reached `upsertListing`,
             not every accepted draft. Those are different quantities: a full
             report accepts ~75 fields, but A+ / 品牌故事 / Q&A / Alt Text / 视频
             脚本 have no write path, so ~52 land. Counting the drafts made this
             tool print "已写入 listing 75 个字段" — a number that disagrees with
             the database. The split is derived from the field registry, so it
             cannot drift from the vocabulary. */
          const split = writebackSplit(Object.keys(accepted))
          applyListing = {
            ok: true,
            applied: split.writable.count,
            draftedOnly: split.draftOnly.fields,
            draftedGroups: split.draftOnly.groups,
            version: saved?.version ?? null,
            error: null,
          }
        } catch (error) {
          applyListing = {
            ok: false, applied: 0, draftedOnly: [], draftedGroups: '', version: null, error: error.message,
          }
        }
      }

      /* The status goes into the report, so it has to be the final one. Building
         the model before the update wrote "running" into a report of a finished
         run — the document contradicted its own run row. `finalStatus` was
         validated at the top of this handler. */
      const rules = parseJson(refreshed.rules_json, ruleSnapshot(store))
      /* F13-09：报告第十二节的操作清单要说出「哪几条已经登记过发布」，而那是**读**
         模块 14 的登记内容重算出来的（不是自报的状态）。重出一份报告时（同一轮又跑了一次
         save）已经存在的登记必须还在清单里显示为已登记 —— 否则读者会以为他白做了。 */
      const publications = publicationsForRun(store, refreshed)
      /* F14-02 §28.2：摘要的「数据截止」只从这一轮**冻结的证据包**算（理由见
         `standards.js#dataCutoffOf`）。这里在渲染之前读一次 —— 读是幂等的，冻结写在
         收尾之后（那时 `finished_at` 已落，补冻才判得出来），顺序不变。
         「Agent 流程」同理：`getAgentRun` 是模块 12 那一行的读取口，读不到就是
         `null`（引用还在、行没了），报告会分开说。 */
      const evidenceAtRender = readEvidence(store, runId)
      const agentRun = refreshed.agent_run_id === null || refreshed.agent_run_id === undefined
        ? null
        : getAgentRun(store, refreshed.agent_run_id)
      /* R-91：这一轮报告要覆盖的**全量字段清单**（当前生效模板）。读不到时退化成 []
         —— 报告仍能出，但就只印本轮草稿；这个退化有代价，注释留在这一处。 */
      const templateItemsForReport = () => {
        try {
          ensureTemplate(store, { attributes: TEMPLATE_ATTRIBUTES, copyFields: TEMPLATE_COPY_FIELDS })
          const active = getTemplateVersion(store, { status: 'active' })
          return active === null ? [] : active.items
        } catch {
          return []
        }
      }
      const model = buildReportModel({
        run: { ...refreshed, status: finalStatus, summary: args?.summary ?? refreshed.summary },
        asin: asinRow,
        listing: before,
        drafts: refreshed.drafts,
        coverage,
        plan,
        gates,
        validation,
        rules,
        options,
        applyListing,
        publications,
        evidence: evidenceAtRender,
        agentRun,
        /* R-91（需求方指定）：报告字段要**全量** —— 把当前生效的字段模板整份交给渲染器，
           本轮没有草稿的字段也逐行印出来（「本轮没有草稿」），而不是从表里消失。 */
        templateItems: templateItemsForReport(),
      })
      const markdown = renderMarkdown(model)
      const html = renderHtml(model)
      /* F14-10：Excel 是同一份模型的**第三种**渲染。三份一起落库、同一刻 —— 导出端点
         只发字节，不在导出时重新渲染（理由见 v50 迁移那段注释；重基前写作 v49，
         与远端先落地的 v49 撞号后改号为 v50）。 */
      const excel = renderExcel(model)

      updateOptimizationRun(store, runId, {
        status: finalStatus,
        summary: args?.summary ?? refreshed.summary ?? null,
        reportMd: markdown,
        reportHtml: html,
        reportXlsx: Buffer.from(excel),
        finishedAt: new Date().toISOString(),
      })

      /* Index the report so the report page can list it. Idempotent on the run
         id, so re-saving updates the entry rather than adding a second one. This
         is the only place an optimization report comes into existence, which is
         why the registry is written here and not by a caller that might forget. */
      recordOptimizationReport(store, {
        ...refreshed,
        id: runId,
        report_html: html,
        finished_at: new Date().toISOString(),
      })

      /* F13-03：收尾已经落地，现在冻结/核对证据包。此刻 `finished_at` 已写，
         所以「冻结晚于收尾」= 补冻，是读得出来的事实（见上面那段）。 */
      const finalRun = getOptimizationRun(store, runId)
      const evidenceBefore = readEvidence(store, runId)
      if (evidenceBefore.ok !== true) {
        evidence = { ok: false, code: evidenceBefore.code, kinds: [], error: evidenceBefore.error }
      } else if (evidenceBefore.rows.length === 0) {
        evidence = freezeEvidence(store, runId, collectEvidence(store, { run: finalRun }), {
          note: '收尾时补冻：这一轮开始时还没有证据包（本批之前建的轮次）。',
        })
      } else {
        evidence = freezeEvidence(store, runId, collectEvidence(store, { run: finalRun }))
      }

      const applied = applyListing?.ok === true ? applyListing.applied : 0
      workbench?.record('optimize:save', { runId, accepted: decisions.filter(d => d.accepted).length, applied }, 'plugin')

      const lines = [
        `运行 ${runId} 已收尾（${args?.status ?? 'done'}）`,
        `采纳 ${decisions.filter(d => d.accepted).length} / 拒绝 ${decisions.filter(d => !d.accepted).length} / 共 ${decisions.length} 个字段`,
        `闸门 ${gates.passed}/${gates.total} 通过${gates.ok ? '' : `　未过：${gates.gates.filter(gate => !gate.pass).map(gate => gate.label).join('、')}`}`,
      ]
      const blocked = decisions.filter(d => d.blocked)
      if (blocked.length > 0) {
        lines.push(`⚠️ 其中 ${blocked.length} 个字段仍有阻断违规: ${blocked.map(d => d.field).join(', ')}`)
      }
      if (!gates.ok) {
        /* 2026-10-25（R-47）：这句原来指向「第八章」，**而第八章是「合规校验」**（11 条规则警告），
           不是闸门。报告里确实有闸门信息，但在别处：
             · 「一、结论」有一行闸门摘要（report.js:778-779：`- 闸门：5/6 通过，未过：字段完整性`）
             · 「五、属性字段」与「十一、必须人工填的字段」才是「该补什么」
           而「逐条列出缺什么」这件事 —— **报告里没有这一节**，六道闸门只有一行摘要。
           所以旧的那句话把读者指向了一个不存在的东西，还指到了另一章。

           实测（run 4e60241a 的报告，661 行）：章节从「六、可直接复制粘贴的内容」
           直接跳到「八、合规校验」，第七章 `optional: 'surfaceRows'` 本轮无内容被按设计跳过；
           而第八章的内容是 11 条 `bullets.digits` 之类的规则警告。

           改法：指向真实存在的那几处，并把「只有摘要、没有逐条」说明白 ——
           否则读者会以为报告里有明细，翻遍全文找不到。 */
        lines.push('⚠️ 有闸门未过，说明这份 listing 还缺东西。'
          + '闸门摘要见报告的「一、结论」（一行六道门的通过数）；'
          + '该补什么见「五、属性字段」与「十一、必须人工填的字段」。')
      }
      lines.push('')
      lines.push(`报告: 运行 ${runId}`)
      lines.push(`  Markdown 已存库（${markdown.length} 字符）`)
      lines.push(`  HTML 视图 ${pagePath}/report/${runId}`)
      /* F14-10：三份导出件同一刻落库，所以这里说的是**字节大小**，不是「生成了」。
         Excel 的下载地址由报告库里那一行的 id 决定（`exportPlan`），这里不拼 URL 的形状。 */
      lines.push(`  Excel 已存库（${excel.length} 字节；与上面两份同一份模型、同一刻）`)
      lines.push(`  关键词覆盖 ${coverage.summary.beforeCovered} → ${coverage.summary.afterCovered}（净 ${coverage.summary.delta >= 0 ? '+' : ''}${coverage.summary.delta}）`)
      lines.push(`  埋词完成度 ${plan.coverageMatrix.summary.fillRate === null || plan.coverageMatrix.summary.fillRate === undefined ? '不判读（没有计划落点）' : Math.round(plan.coverageMatrix.summary.fillRate * 100) + '%'}（${plan.coverageMatrix.summary.reachedCells}/${plan.coverageMatrix.summary.plannedCells} 处，平均每词 ${plan.coverageMatrix.summary.averagePlaces} 处）`)
      if (coverage.lost.length > 0) lines.push(`  ⚠️ 丢失 ${coverage.lost.length} 个已覆盖关键词: ${coverage.lost.slice(0, 10).map(entry => entry.keyword).join(' | ')}`)
      if (applyListing === null) {
        lines.push('  未改动 listing（applyListing 未开启）。确认无误后重新调用并传 applyListing: true。')
      } else if (applyListing.ok) {
        const draftedNote = applyListing.draftedOnly.length === 0
          ? ''
          : `；另有 ${applyListing.draftedOnly.length} 个字段（${applyListing.draftedGroups}）只出草案，无写回路径`
        lines.push(`  已写入 listing ${applyListing.applied} 个字段（版本已 +1）${draftedNote}`)
      } else {
        lines.push(`  ⚠️ listing 写入失败：${applyListing.error}`)
        lines.push('  报告已存库并记录了这次失败；库内 listing 未改动。修好后重试。')
      }
      if (evidence.ok !== true) {
        lines.push(`  ⚠️ 证据包未重冻（${evidence.code}）：${evidence.error}`)
        lines.push('  已冻结的那一份**保持原样**（一个字节都没改）—— 报告引用的就是它。'
          + '要带着新证据重做，用「基于此草案重新优化」开新的一轮。')
      } else if (evidence.unchanged !== true) {
        lines.push(`  证据包已冻结 ${evidence.written} 类（这一轮开始时还没有证据包，属于补冻）。`)
      }

      /* A failed write is a real failure: the report is already stored (with the
         failure recorded), so raise it now rather than returning a success-shaped
         string for a save that did not save. */
      if (applyListing?.ok === false) {
        throw new Error(`listing 写入失败：${applyListing.error}`)
      }

      return lines.join('\n')
    },
  }
}

export function optimizeReportTool({ store, pagePath }) {
  return {
    name: 'amzn_optimize_report',
    description:
      'Read a run\'s report. Returns the Markdown, or the URL of the self-contained HTML view, or the download URL of '
      + 'the Excel workbook (Markdown / HTML / Excel are three renderings of one model, written once at save time — so if '
      + 'a number looks different from what you saw earlier, the run was re-saved, not mis-rendered). '
      + 'format=excel returns the URL of the stored .xlsx, not its bytes: a tool result is text, and base64 of a workbook '
      + 'is not something a reader can open. '
      + 'Also lists recent runs when no runId is given.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run to read. Omit to list recent runs.' },
        format: { type: 'string', description: 'md (default) | html | both | xlsx' },
        asin: { type: 'string', description: 'When listing: filter by ASIN.' },
        limit: { type: 'number', description: 'When listing: how many runs. Default 20.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const format = String(args?.format ?? 'md').toLowerCase()
      if (!args?.runId) {
        const listed = listOptimizationRuns(store, { asin: args?.asin, limit: args?.limit ?? 20 })
        if (listed.rows.length === 0) return '还没有任何优化运行。用 amzn_optimize_prepare 开始一次。'
        return [
          `优化运行 (${listed.rows.length}/${listed.total}):`,
          table(listed.rows, [
            { label: 'run', value: row => row.id.slice(0, 8) },
            { label: 'ASIN', value: row => row.asin },
            { label: '站点', value: row => row.marketplace },
            { label: '状态', value: row => row.status },
            { label: '字段', value: row => row.draft_count },
            { label: '开始', value: row => String(row.started_at ?? '').slice(0, 16).replace('T', ' ') },
          ]),
        ].join('\n')
      }

      const run = getOptimizationRun(store, args.runId)
      if (run === null) return { ok: false, error: `no optimization run ${args.runId}` }
      const url = `${pagePath}/report/${run.id}`
      if (format === 'html') return `HTML 报告: ${url}\n（自包含，可直接打开或转发）`
      if (format === 'both') return `HTML 报告: ${url}\n\n---\n\n${run.report_md ?? '（这个 run 还没有报告，先调 amzn_optimize_save）'}`
      /* F14-10 — Excel：给下载地址，不给字节。**报告库里没有这一条**时不编一个地址：
         `reportForRun` 查不到就说明这一轮还没被索引（`recordOptimizationReport` 在
         save 里跑，没跑过就没有行），那是「还没有这一条」，不是「地址坏了」。 */
      if (format === 'xlsx' || format === 'excel') {
        const indexed = reportForRun(store, run.id)
        if (indexed === null) {
          return `这一轮还没有进报告库（没有 report 行），所以没有导出地址。\n`
            + `先调一次 amzn_optimize_save 收尾 —— 它会同时生成 Markdown / HTML / Excel 三份并登记。`
        }
        const plan = exportPlan({ row: indexed, has: availabilityOf(run), pagePath })
        const excel = plan.formats.find(entry => entry.id === 'xlsx')
        if (excel === undefined || excel.available !== true) {
          return `Excel 导出件取不到：${excel?.reason ?? plan.note}\n`
            + `（Markdown 与 HTML 仍在：${url}）`
        }
        return [
          `Excel 导出: ${excel.url}`,
          `（这是**那一刻**渲染出的那一份字节，不是现在重新算的：Markdown / HTML / Excel 三份同源、同一刻落库。）`,
          `报告库里那一条: ${indexed.id}`,
        ].join('\n')
      }
      return run.report_md ?? `运行 ${run.id} 还没有报告。调 amzn_optimize_save 生成。`
    },
  }
}

/**
 * F13-02 — ask the nine gates without starting a run.
 *
 * This is the read-only half of the pre-flight, and it exists for two reasons
 * that are about the *shape* of the answer rather than about convenience:
 *
 *   ① `amzn_optimize_prepare` is the generation path, so its refusal has to
 *      refuse. The question "what exactly is missing, and where do I go and fill
 *      it" therefore needs a door that never writes and never refuses — otherwise
 *      the only way to see the checklist is to attempt the thing that is blocked.
 *   ② The page's 开跑这一轮 button and this tool must give the same nine answers
 *      (the requirement is that one criterion drives both paths). Both go through
 *      `precheckFor`, which resolves the mode spec and the keyword set and then
 *      calls `evaluatePrecheck` — so "the same rule" is not a promise about two
 *      implementations agreeing, there is only one implementation.
 *
 * The report itself is structured (one object per gate, each with its own verdict,
 * criterion, measurement, denominator, missing list and remedy); this renderer
 * prints one section per gate. The nine are never folded into a single boolean: a
 * caller that only received `ok:false` could not tell a stale price from a missing
 * brand, and those two need different work.
 */
export function optimizePrecheckTool({ store }) {
  return {
    name: 'amzn_optimize_precheck',
    description:
      'Run the nine pre-flight gates for one ASIN + site without starting a run (F13-02). '
      + 'Returns each gate separately — criterion (with its numbers), measured value, denominator, verdict (pass / degrade / '
      + 'block), what is missing and which module to go and fill it from. '
      + 'It reads only: it never creates a run and never refuses. Use it to see the checklist; use amzn_optimize_prepare to '
      + 'start a run (which refuses when a gate blocks). '
      + 'Thresholds are the shared 7 / 30 / 90 days — the same table the quality cockpit reads — and "no data" is reported as '
      + 'its own state rather than as zero.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        mode: {
          type: 'string',
          enum: [...OPTIMIZE_MODES],
          description:
            'Which mode the answer is for. It matters for two gates: 评分 below 3.8 blocks 全量/增量 but only degrades a '
            + '专项 or 审核 (a wholesale rewrite is the thing §27.6 rules out). Default full.',
        },
        scope: {
          type: 'string',
          enum: TARGETED_SCOPES.map(entry => entry.id),
          description: `When mode=targeted, one of: ${TARGETED_SCOPES.map(entry => entry.id).join(' / ')}.`,
        },
        keywordsReviewed: { type: 'boolean', description: 'Declare this round\'s keywords have been reviewed (see amzn_optimize_prepare).' },
        noCompetitors: { type: 'boolean', description: 'Declare there is deliberately no competitor input for this site.' },
      },
      required: ['asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const asin = String(args?.asin ?? '').trim().toUpperCase()
      const marketplace = String(args?.marketplace ?? 'US').trim().toUpperCase()
      if (!/^[A-Z0-9]{10}$/.test(asin)) return { ok: false, error: `invalid ASIN "${args?.asin}" (expected 10 letters/digits)` }

      const spec = modeSpec(args?.mode ?? 'full', { scope: args?.scope })
      if (spec === null) {
        return {
          ok: false,
          error: `unknown mode/scope ${JSON.stringify(args?.mode)} / ${JSON.stringify(args?.scope)} — `
            + `mode 必须是 ${OPTIMIZE_MODES.join(' | ')}；targeted 的 scope 取值：${TARGETED_SCOPES.map(entry => entry.id).join(' / ')}`,
        }
      }

      const report = precheckFor(store, {
        asin,
        marketplace,
        mode: spec.id,
        scope: spec.scope,
        declarations: { keywordsReviewed: args?.keywordsReviewed === true, noCompetitors: args?.noCompetitors === true },
      })
      /* Unreachable while `precheckFor` and this tool resolve the mode the same
         way, and kept rather than asserted away: a null here would otherwise be
         read as a report a moment later. */
      if (report === null) return { ok: false, error: `unknown mode/scope ${JSON.stringify(spec.id)}` }

      const lines = []
      lines.push(`前置检查 · ${asin} · ${marketplace} · 模式 ${spec.label}`)
      lines.push('')
      lines.push(...renderPrecheckLines(report, { heading: '## 九项门槛' }))
      if (report.supplement.length > 0) {
        lines.push('## 补数清单')
        for (const entry of report.supplement) {
          lines.push(`- ${entry.gateLabel}（${entry.verdict}）：${entry.missing.join('；')}`)
          for (const fix of entry.remedy) lines.push(`  → ${fix.moduleLabel}：${fix.action}${fix.tool ? `（${fix.tool}）` : ''}`)
        }
      } else {
        lines.push('## 补数清单')
        lines.push('（九项全过，没有要补的）')
      }
      if (report.degradations.length > 0) {
        lines.push('')
        lines.push('## 降级说明')
        for (const entry of report.degradations) lines.push(`- ${entry.gateLabel}：${entry.notes.join('；')}`)
      }
      lines.push('')
      lines.push(report.blocked
        ? `结论：${PRECHECK_BLOCKED} —— amzn_optimize_prepare 会拒绝这一轮；审核模式（mode=audit）仍然可以只做检查。`
        : '结论：没有阻断项。amzn_optimize_prepare 可以开始这一轮。')
      return lines.join('\n')
    },
  }
}

/**
 * F13-01 — 草案收件箱，按五态分组读出来。
 *
 * 这个工具与工作台那一屏**读同一份判据**：分组来自 `domain/optimize/inbox.js` 的
 * `draftInboxGroup`，行来自 `draftInboxRow`，筛选来自 `inboxMatches`。所以
 * 「页面上看到 3 条待人工选择、工具说 5 条」这种分歧不可能发生 —— 不是两个实现
 * 互相保证，是只有一个实现。
 *
 * 只读：它不写任何一行，也不改任何草案的状态。状态的四条写路径在
 * `POST /api/optimize-inbox`（页面）与 `amzn_optimize_save`（会话）上。
 */
export function optimizeInboxTool({ store, workbench }) {
  return {
    name: 'amzn_optimize_inbox',
    description:
      'The draft inbox (F13-01): every optimization draft, grouped into 待人工选择 / 待审批 / 驳回待修订 / 稍后 / 已作废. '
      + 'Each row carries the six columns the inbox exists for — object, site, generation time, block/warn counts, '
      + 'outstanding confirmations, approval state — plus the context verdict (does this draft still belong to the scope '
      + 'selected now?). Read-only: it never decides, voids or defers anything. '
      + 'The group is recomputed from the row\'s own columns, never self-reported, and the same function answers for this '
      + 'tool and for the workbench panel. '
      + 'Three different empties are reported apart: no drafts at all, none matching the filter, and "filtered to the '
      + 'current context while there is no current context".',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'One optimization run. Omit to read every run.' },
        asin: { type: 'string', description: 'Narrow to one object.' },
        marketplace: { type: 'string', description: 'Narrow to one site.' },
        group: {
          type: 'string',
          enum: [...INBOX_GROUP_IDS],
          description: 'One of the five groups. Omit for all of them.',
        },
        context: {
          type: 'string',
          enum: [...DRAFT_CONTEXT_FILTERS],
          description:
            'current = the draft belongs to the scope selected now; changed = it was written under another scope '
            + '(cannot be submitted); orphan = it recorded no scope at all (v19 and earlier, refused fail-closed).',
        },
        contextId: { type: 'string', description: 'The scope id `context=current` compares against. Defaults to the workbench\'s current context.' },
        limit: { type: 'number', description: 'Rows to return. Default 50, cap 200.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const limit = clampLimit(args?.limit, 50, 200)
        const runId = String(args?.runId ?? '').trim()
        const requestedContext = String(args?.context ?? '').trim()
        const requestedContextId = String(args?.contextId ?? '').trim()

        const listed = listOptimizationRuns(store, {
          asin: args?.asin,
          marketplace: args?.marketplace,
          status: undefined,
          limit: 200,
        })
        const runs = runId === '' ? listed.rows : listed.rows.filter(row => row.id === runId)

        /* A named run that does not exist is its own empty — not "the inbox is
           empty". Collapsing the two would let a typo read as "nothing to do". */
        if (runId !== '' && runs.length === 0) {
          return {
            ok: true,
            filters: { runId, asin: args?.asin ?? null, marketplace: args?.marketplace ?? null, group: args?.group ?? null, context: requestedContext === '' ? null : requestedContext, limit },
            groups: [], counts: { total: 0, shown: 0, byGroup: {} }, context: null, rows: [],
            empty: { kind: 'no-run', text: `没有第 ${runId.slice(0, 8)} 轮优化 —— 这不是「收件箱是空的」，是这一轮不存在。` },
          }
        }

        /* 当前上下文：显式给了就用它；没给才去问工作台。工作台不在（脚本、测试）时
           拿不到 id，`context=current` 会降级并**明说**降级的原因 —— 空列表必须说得出
           为什么空。 */
        const fromWorkbench = workbenchContextId(workbench)
        const currentContextId = requestedContextId === '' ? fromWorkbench : requestedContextId
        const approvalRequired = approvalPolicy(store).acceptDraft === true

        const rows = []
        for (const run of runs) {
          const full = getOptimizationRun(store, run.id)
          if (full === null) continue
          for (const draft of full.drafts) {
            rows.push(draftInboxRow(draft, { run: full, currentContextId, approvalRequired }))
          }
        }
        /* Newest round first: the same order the run list uses, so the two lists
           cannot present the same rounds in two different orders. */
        rows.sort((left, right) => String(right.generatedAt ?? '').localeCompare(String(left.generatedAt ?? '')))

        const filter = {
          group: INBOX_GROUP_IDS.includes(String(args?.group ?? '')) ? String(args.group) : null,
          context: DRAFT_CONTEXT_FILTERS.includes(requestedContext) ? requestedContext : null,
        }
        const inbox = buildInbox(rows, { filter, currentContextId })
        const shown = inbox.rows.slice(0, limit)

        const lines = []
        lines.push(`草案收件箱 · ${runId === '' ? `全部轮次（${runs.length} 轮）` : `轮次 ${runId.slice(0, 8)}`}`)
        lines.push('')
        lines.push('## 五态分组')
        lines.push(table(inbox.groups, [
          { label: '分组', value: row => row.label },
          { label: '条数', value: row => row.count },
          { label: '这是什么', value: row => truncate(row.why, 70) },
        ]))
        lines.push(`合计 ${inbox.counts.total} 条；当前筛选下 ${inbox.counts.shown} 条，显示前 ${shown.length} 条。`)
        lines.push('')
        lines.push('## 上下文')
        if (inbox.context.available) {
          lines.push(`当前上下文 ${inbox.context.currentId}：匹配 ${inbox.context.matched} 条 · 上下文已变化 ${inbox.context.changed} 条 · 没有上下文 ${inbox.context.unknown} 条。`)
        } else {
          lines.push('工作台没有当前上下文（没有选中的范围），所以「只看当前上下文」这一项无从比对 —— '
            + `这一批共 ${inbox.counts.total} 条草案，其中 ${inbox.context.changed} 条上下文已变化、${inbox.context.unknown} 条没有上下文。`)
        }
        lines.push('')
        lines.push('## 草案')
        if (inbox.empty !== null) {
          lines.push(`（${inbox.empty.kind}）${inbox.empty.text}`)
        } else {
          lines.push(table(shown, [
            { label: '分组', value: row => row.groupLabel },
            { label: '对象', value: row => row.asin ?? '—' },
            { label: '站点', value: row => row.marketplace ?? '—' },
            { label: '字段', value: row => row.label },
            { label: '生成', value: row => row.generatedAt ?? '—' },
            { label: '阻断/警告', value: row => `${row.blocked}/${row.warnings}` },
            { label: '待确认', value: row => row.confirmations.length === 0 ? '—' : row.confirmations.map(item => item.text).join('；') },
            { label: '审批', value: row => row.approvalLabel },
            { label: '上下文', value: row => row.contextState === 'ok' ? '匹配' : (row.contextState === 'unknown' ? '没有上下文' : '已变化') },
          ]))
        }
        lines.push('')
        lines.push('只读：这个工具不改任何草案的状态。作废 / 恢复 / 稍后在 '
          + `POST /api/optimize-inbox（页面）上；采纳与驳回走 amzn_optimize_save 的 accept / reject。`)
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: `收件箱读取失败：${error.message}` }
      }
    },
  }
}

/**
 * F13-03 — 十类证据包，逐类读出来。
 *
 * 「没有数据」与「数据是 0」在这里必须分开，而且**是分开的三句**：
 *   frozen + count 0  读过了，答案是 0（例：这个对象一条质量记录都没有）
 *   absent            这一类在这个对象上不存在可冻结的东西（对象本身缺，或这一轮没输入）
 *   not_modelled      本仓没有这一类的来源（评论主题样本、QA）
 * 所以这个工具**永远返回十行**，一行都不省 —— 省掉一行会让「这一类没有」与
 * 「这一类没被看过」长得一模一样。
 */
export function optimizeEvidenceTool({ store }) {
  return {
    name: 'amzn_optimize_evidence',
    description:
      'The ten-class evidence package for one optimization run (F13-03): current copy, keyword package and position plan, '
      + 'rule snapshot, prompt snapshot, listing history, review topics, Q&A, competitor opportunities, product-line facts '
      + 'and brand, quality gaps. '
      + 'Every class carries its 来源 (which table / reader the bytes came from), 时间 (when they were observed — null means '
      + 'undated, never "now") and 适用字段 (which fields it bears on). '
      + 'The three ways a class can be missing are reported apart and never collapsed: "read it, the answer is 0" / '
      + '"there is nothing of this kind for this object" / "this repository has no source for this kind at all" '
      + '(review topics and Q&A are the last one — no table, no reader). '
      + 'Read-only, and the package is frozen: it is written once when the run starts and refuses to be overwritten.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The optimization run whose package to read.' },
        kind: {
          type: 'string',
          enum: EVIDENCE_KINDS.map(entry => entry.id),
          description: 'Read one class instead of all ten.',
        },
        includePayload: { type: 'boolean', description: 'Include the frozen bodies. Default false — some are large.' },
      },
      required: ['runId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const runId = String(args?.runId ?? '').trim()
        if (runId === '') return { ok: false, error: 'runId is required' }
        const read = readEvidence(store, runId, { kind: args?.kind ?? null })
        if (read.ok !== true) return read

        const lines = []
        lines.push(`证据包 · 轮次 ${read.runId.slice(0, 8)} · ${read.asin} ${read.marketplace}`)
        lines.push(`冻结于 ${read.frozenAt ?? '（还没有冻结）'}${read.lateFreeze ? '（**收尾时补冻**，不是这一轮开始时冻的）' : ''}`)
        lines.push(`十类里：冻结 ${read.counts.frozen} · 不存在 ${read.counts.absent} · 本仓没有 ${read.counts.notModelled}`)
        if (read.missing.length > 0) {
          lines.push(`⚠️ 证据包里**缺**这 ${read.missing.length} 类的行：${read.missing.join('、')} —— 缺行不等于「这一类没有」。`)
        }
        lines.push('')
        for (const row of read.rows) {
          const tag = { frozen: '✅ 已冻结', absent: '⛔ 不存在', not_modelled: '⛔ 本仓没有' }[row.status] ?? row.status
          lines.push(`### ${row.label}（${row.kind}）— ${tag}`)
          lines.push(`来源：${row.source ?? '（本仓没有这一类证据的来源）'}`)
          lines.push(`时间：${row.at ?? '无日期'}`)
          lines.push(`适用字段：${row.fields.length === 0 ? '整轮（或这一类不落在某个字段上）' : row.fields.join('、')}`)
          lines.push(`条数：${row.count === null ? '—（这一类数不出来）' : row.count}`)
          if (row.note) lines.push(`说明：${row.note}`)
          if (args?.includePayload === true && row.payload !== null) {
            lines.push('正文：')
            lines.push('```json')
            lines.push(JSON.stringify(row.payload, null, 2))
            lines.push('```')
          }
          lines.push('')
        }
        if (read.empty !== null) lines.push(`（${read.empty.kind}）${read.empty.text}`)
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: `证据包读取失败：${error.message}` }
      }
    },
  }
}

/**
 * F13-05 — 九项策略卡与「人工确认后进入生成」的门禁，只读。
 *
 * 这个工具**永远返回九行**，一行都不省 —— 省掉一行会让「本仓没有这一项」与
 * 「这一项没被看过」长得一模一样。三种「没有」分开说：`derived`（读过了，0 也是
 * 发现）/ `absent`（这一项建模了，这一轮没有输入）/ `not_modelled`（本仓没有来源）。
 *
 * 只读：确认走工作台「优化 → 策略阶段」（`POST /api/optimize-strategy-confirm`）。
 * 门禁的判据只有一份（`domain/optimize/strategy.js#strategyGate`），页面读的是
 * 同一个函数算出来的 `gate`。
 */
export function optimizeStrategyTool({ store }) {
  return {
    name: 'amzn_optimize_strategy',
    description:
      'The nine-item strategy card for one optimization run (F13-05), and the gate that decides whether copy may enter '
      + 'this run at all. '
      + 'The nine items: 目标用户 / 核心差异化 / 购买疑问 / 事实边界 / 关键词优先级与所有权 / 字段分工 / 保留内容 / '
      + '风险待确认 / 修改幅度. Each carries its 来源, its 事实 and its 判据 — never a bare claim. '
      + 'Three kinds of "missing" are reported apart and never collapsed: read it and the answer is 0 / this round has no '
      + 'input for it / this repository has no source for it at all. '
      + 'The gate is recomputed from the row (confirmed_at), never self-reported: unconfirmed means '
      + 'amzn_optimize_validate with persist and amzn_optimize_save are both refused (STRATEGY_UNCONFIRMED). A run built '
      + 'before this feature has no strategy row — the gate opens for it and **says why**, rather than pretending it was '
      + 'confirmed. Read-only: confirmation happens in the workbench.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The optimization run whose strategy to read.' },
      },
      required: ['runId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const runId = String(args?.runId ?? '').trim()
        if (runId === '') return { ok: false, error: 'runId is required' }
        const read = readStrategy(store, runId)
        if (read.ok !== true) return read

        const lines = []
        lines.push(`策略阶段 · 轮次 ${read.runId.slice(0, 8)} · ${read.asin} ${read.marketplace}`)
        lines.push(`九项里：有来源 ${read.counts.derived} · 这一轮没有输入 ${read.counts.absent} · 本仓没有 ${read.counts.notModelled}`)
        lines.push(read.gate.open
          ? `门禁：**${read.gate.state === 'confirmed' ? '已确认' : '放行'}** —— ${read.gate.reason}`
          : `门禁：**未确认** —— ${read.gate.reason}`)
        if (read.present && read.confirmed) {
          lines.push(`确认于 ${read.confirmedAt}（${read.confirmedBy ?? '未署名'}）`
            + `${read.edited ? '　·　人工改过其中若干项的文字（构建时的那一份仍可读）' : '　·　按构建原样确认，一个字未改'}`)
        }
        lines.push('')
        lines.push(`来源：${STRATEGY_SOURCE}`)
        lines.push(...renderStrategyLines(read.items, read.gate).slice(2))
        if (read.empty !== null) lines.push(`（${read.empty.kind}）${read.empty.text}`)
        lines.push('只读：这个工具不改任何东西。确认走工作台「优化 → 策略阶段」。')
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: `策略卡读取失败：${error.message}` }
      }
    },
  }
}

/**
 * F13-06 — 位置计划核对，只读。
 *
 * 继承的那一份是**模块 08 的持久计划**（`keyword_plan`，位置计划的唯一持久层）；
 * 这一轮的建议计划用的是**08 的八个位置**，不是 13 的十二个埋词位置。映射不到的
 * 位置逐条报出来，不静默丢弃。
 *
 * 只读：采纳 / 否决走工作台「优化 → 位置计划」，采纳时写回 08 的**新版本**，
 * 走的是 08 的 `savePlan`（与 `amzn_keyword_plan_save` 同一个函数）。
 */
export function optimizePlanCheckTool({ store }) {
  return {
    name: 'amzn_optimize_plan_check',
    description:
      'The position-plan reconciliation for one optimization run (F13-06). '
      + 'The plan itself has exactly one persistence layer — module 08\'s keyword_plan — and this run **inherits** the '
      + 'current version of it (same read as the workbench\'s 当前计划) instead of computing a second one. '
      + 'Reports: which version was inherited (planId / lineage / version), this round\'s suggestion expressed in '
      + '**module 08\'s eight positions** (never module 13\'s twelve embedding surfaces), the words this round has that '
      + 'the plan does not decide (uncovered), and the 08 positions that have no counterpart here (unmapped — listed one '
      + 'by one, never silently dropped). '
      + 'The decision state is recomputed from the row (accepted_at / declined_at / written_plan_id), never '
      + 'self-reported. Accepting writes back a **new version in module 08** through its own savePlan. '
      + 'Read-only: the decision happens in the workbench.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The optimization run whose plan check to read.' },
      },
      required: ['runId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const runId = String(args?.runId ?? '').trim()
        if (runId === '') return { ok: false, error: 'runId is required' }
        const read = readPlanCheck(store, runId)
        if (read.ok !== true) return read

        const lines = []
        lines.push(`位置计划核对（继承模块 08） · 轮次 ${read.runId.slice(0, 8)} · ${read.asin} ${read.marketplace}`)
        if (!read.present) {
          lines.push(`（${read.empty.kind}）${read.empty.text}`)
          return lines.join('\n')
        }
        lines.push(`继承：${read.inherited.status === 'inherited'
          ? `模块 08 的 ${read.inherited.planId} v${read.inherited.version}（族 ${read.inherited.lineageId}，`
            + `那一版共 ${read.inherited.entryCount === null ? '读不到条数' : `${read.inherited.entryCount} 条`}）`
          : '**没有可继承的计划**（08 里一份都没有）'}`)
        lines.push(read.inherited.note ?? '')
        /* 2026-10-25（R-51）：这里原来是 `read.decision.decidedAt === null ? '' : …`。
           实测 run 4e60241a 的输出是：
             `决策：还没有人裁决　·　undefined（未署名）`
           ——**`decidedAt` 是 `undefined` 而不是 `null`**，`undefined === null` 为 false，
           于是走了 else 分支，把一个 `undefined` 印进了给用户看的句子。

           **这是 `=== null` 与 `== null` 的区别**：前者不兜 `undefined`，
           而这个字段来自 `row.decided_at ?? null` 之外的路径时，`undefined` 会原样流过来。

           改成 `== null` 同时兜住两者 —— 这里没有「null 与 undefined 要区别对待」的语义。 */
        lines.push(read.decision.state === undefined
          ? `决策：${read.decision.state}`
          : `决策：${{
            pending: '还没有人裁决',
            accepted: `已采纳，写回 ${read.writtenBack === null ? '（写回信息缺失）' : `${read.writtenBack.planId} v${read.writtenBack.version}`}`,
            declined: '已否决（没有写回 08）',
          }[read.decision.state] ?? read.decision.state}`
            + (read.decision.decidedAt == null ? '' : `　·　${read.decision.decidedAt}（${read.decision.decidedBy ?? '未署名'}）`))
        lines.push(`建议计划 ${read.counts.suggested} 条（一致 ${read.counts.unchanged} · 主人位置不同 ${read.counts.moved}）`
          + ` · 计划没决定过的词 ${read.counts.uncovered} · 无对应埋词位置 ${read.counts.unmapped}`)
        /* 「本轮没有建议计划」与「计划里有 0 个位置」都会让上面那个数字是 0，所以
           哪一种是哪一句由领域层给，不留给读者从 0 里猜。 */
        if (read.suggested.note !== null) lines.push(`⚠️ ${read.suggested.note}`)
        lines.push('')
        if (read.suggested.entries.length > 0) {
          lines.push(table(read.suggested.entries.slice(0, 40), [
            { label: '关键词', value: row => truncate(row.keyword, 26) },
            { label: '计划主人', value: row => row.ownerPositionLabel },
            { label: '对应埋词位置', value: row => row.embedPosition ?? '（无对应物）' },
            { label: '本轮分配', value: row => row.roundOwner ?? '—' },
            { label: '变化', value: row => row.roundChange },
          ]))
        }
        if (read.suggested.uncovered.length > 0) {
          lines.push(`⚠️ 计划没决定过的词（${read.suggested.uncovered.length}）：`
            + read.suggested.uncovered.slice(0, 20).join(' | '))
        }
        for (const item of read.suggested.unmapped) {
          lines.push(`⚠️ 无对应埋词位置：${item.label}（${item.position}）× ${item.count} —— ${item.reason}`)
        }
        lines.push('')
        lines.push('位置计划的唯一持久层是模块 08（`keyword_plan`）。这一轮只继承与冻结，不产生第二份口径；'
          + '采纳时写回 08 的**新版本**，走的是 08 的 `savePlan`。只读：裁决走工作台。')
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: `位置计划核对读取失败：${error.message}` }
      }
    },
  }
}

/**
 * F13-08 — 校验体系：规则 / 闸门 / Agent 审阅，一个入口，只读。
 *
 * 这三块就是审计 :353 说的那一整套。以前它们散在三处：规则命中在页面上是两个
 * 数字、闸门画在轮次表头那一条里、Agent 审阅连载荷都没有。这个工具是**统一入口**：
 * 它读的是 `readValidationSystem`，而工作台的三块面板读的是**同一个函数**的产出
 * （`/api/state` 的 `optimizations.validation`），所以「工具说闸门 4/6、面板说 5/6」
 * 在结构上不可能发生 —— 不是靠两个实现互相保证，而是只有一个实现。
 *
 * 三块各自的判据要说清楚，因为它们**不是同一个时刻**的判定：
 *   · 规则命中读的是这一轮 `validate` 时写下的那一份（与收件箱、表头同一个数字）；
 *   · 闸门是对**当前草案**现算的（与报告第八章同源）；
 *   · 审阅状态由 `optimization_review` 的行重算。
 * listing 在这一轮开始之后变过，前两者就会不同 —— 这个工具把它们分开摆，不合成一个。
 *
 * 只读：这条路径一个字节都不写。记审阅结论走 `amzn_optimize_review`。
 */
export function optimizeValidationTool({ store }) {
  return {
    name: 'amzn_optimize_validation',
    description:
      'The validation system of one optimization run (F13-08), in one read: the rule violations, the six closing '
      + 'gates, and the Agent-review roster with its conclusions. '
      + 'Rules answer "is this legal", gates answer "is this finished" — a listing can be perfectly legal and still be '
      + 'missing half its sections, and neither answer replaces the other. '
      + 'The review roster is 14 items (the 11 model-only checks + 自然度 / 说服力 / 品牌语气); each item can carry '
      + 'conclusions per field, and every conclusion must cite evidence that resolves. '
      + 'Three kinds of "missing" are kept apart: this run has no drafts / nobody has reviewed this item / a rule found '
      + 'nothing. Read-only — record conclusions with amzn_optimize_review, and it is the same function the workbench '
      + 'panel calls.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The optimization run whose validation system to read.' },
      },
      required: ['runId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const runId = String(args?.runId ?? '').trim()
        if (runId === '') return { ok: false, error: 'runId is required' }
        const system = readValidationSystem(store, runId)
        if (system.ok !== true) return system

        const lines = []
        lines.push(`校验体系 · 轮次 ${system.runId.slice(0, 8)} · ${system.asin} ${system.marketplace}`)
        const roster = system.judge.roster
        lines.push(`规则口径 · ${roster === null
          ? '⚠️ 未知（没有记录判定所用规则集）'
          : `${roster.origin === 'run-snapshot' ? '本次运行快照' : roster.origin === 'active' ? '规则库当前版本' : roster.origin}`
            + ` ${roster.version ?? '版本未记录'}（${roster.count ?? '?'} 条生效）`
            + `${roster.fromCode ? '　⚠️ 规则库为空，用的是代码内置规则集' : ''}`}`)
        lines.push(system.judge.note)
        lines.push('')

        /* ── ① 规则校验 ───────────────────────────────────────────────────── */
        lines.push(`## ① 规则校验（${system.rules.counts.block} 阻断 / ${system.rules.counts.warn} 警告）`)
        if (system.rules.empty !== null) {
          lines.push(`（${system.rules.empty.kind}）${system.rules.empty.text}`)
        } else if (system.rules.rows.length === 0) {
          lines.push('机检 0 命中 —— 这一轮有草案，规则一条都没触发。')
        } else {
          lines.push(table(system.rules.rows.slice(0, 60), [
            { label: '字段', value: row => truncate(row.fieldLabel, 16) },
            { label: '规则', value: row => row.ruleId },
            { label: '严重度', value: row => row.severity },
            { label: '依据', value: row => truncate(row.source ?? '—', 24) },
            { label: '说明', value: row => truncate(row.messages.join('；'), 60) },
          ]))
          lines.push(`共 ${system.rules.rows.length} 行（去重后 ${system.rules.distinct} 条${system.rules.duplicates > 0
            ? ` —— 聚合字段（bullets / draft）的规则会被记在它覆盖的每个字段上，所以同一句话出现多次是**存储的形状**`
            : ''}）`)
          if (system.rules.uncounted > 0) {
            lines.push(`⚠️ 其中 ${system.rules.uncounted} 行的严重度不是 block/warn —— 它们**不计入**上面那两个数字。`)
          }
        }
        if (system.rules.drift) {
          lines.push(`⚠️ 口径不一致：这里数出来 ${system.rules.counts.block}/${system.rules.counts.warn}，`
            + `收件箱用的那个数字是 ${system.rules.persisted.block}/${system.rules.persisted.warn} —— 投影与源不同步。`)
        }
        lines.push('')

        /* ── ② 闸门判定 ───────────────────────────────────────────────────── */
        lines.push(`## ② 闸门判定（${system.gates.passed}/${system.gates.total} 通过）`)
        if (system.gates.empty !== null) {
          lines.push(`（${system.gates.empty.kind}）${system.gates.empty.text}`)
        } else {
          for (const gate of system.gates.rows) {
            lines.push(`- ${gate.pass ? '✅' : '❌'} **${gate.label}**（${gate.id}）: ${gate.detail ?? ''}`)
            if (gate.what !== null) lines.push(`    判据：${gate.what}`)
            if (gate.source !== null) lines.push(`    依据：${gate.source}`)
          }
        }
        lines.push('')

        /* ── ③ Agent 审阅 ─────────────────────────────────────────────────── */
        const review = system.review
        lines.push(`## ③ Agent 审阅（${review.ok === true ? `${review.counts.items - review.counts.pending}/${review.counts.items} 项有结论` : '读不出来'}）`)
        if (review.ok !== true) {
          lines.push(`⚠️ ${review.error}`)
        } else {
          lines.push(`来源：${REVIEW_SOURCE}`)
          if (review.empty !== null) lines.push(`（${review.empty.kind}）${review.empty.text}`)
          for (const item of review.items) {
            lines.push(`- [${item.state === 'pending' ? ' ' : item.state === 'pass' ? 'x' : '!'}] **${item.label}**（${item.id}）`
              + ` · ${item.stateLabel}${item.needsHuman ? ' · 只能人判' : ''}`)
            lines.push(`    ${item.ask}`)
            if (item.rows.length > 0) {
              for (const row of item.rows) {
                lines.push(`    · ${row.fieldLabel}: ${row.conclusion}`
                  + `${row.note === null ? '' : ` —— ${row.note}`}`
                  + `　证据 ${row.evidence.map(ref => `${ref.kind}:${ref.ref}`).join('、')}`
                  + `　（${row.reviewedAt}${row.reviewedBy === null ? '' : ` / ${row.reviewedBy}`}）`)
              }
            }
          }
          const drift = review.rosterDrift
          if (drift.missing.length > 0 || drift.duplicate.length > 0 || drift.unlabelled.length > 0) {
            lines.push(`⚠️ 清单与上游不同步：缺 ${drift.missing.join('、') || '无'}；`
              + `重复 ${drift.duplicate.join('、') || '无'}；无标签 ${drift.unlabelled.join('、') || '无'}`)
          }
        }
        lines.push('')
        lines.push(`三块各自的判据来源：${VALIDATION_SOURCE}（${VALIDATION_VERSION}）`)
        lines.push('只读：这条路径一个字节都不写。记结论走 amzn_optimize_review（或工作台「校验体系 → Agent 审阅」）。')
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: `校验体系读取失败：${error.message}` }
      }
    },
  }
}

/**
 * F13-08 — Agent 审阅的读 / 记。
 *
 * 不带 `conclusions` 时只读（等价于校验体系里的那一块）；带了就是**记录结论**：
 * 每条结论必须引用证据（`{ kind, ref }`），而 `rule` / `draft` / `evidence` 三种引用
 * 会被逐条解开 —— 引用一个不存在的规则、或引用这一轮没有的字段，都会被拒。
 * 「结论引用证据」这个载体只有在这一步有牙。
 *
 * 一次可以记多条，但**先全部校验再写第一条**：半批写入在库里与一次故意提交没法区分，
 * 所以任何一条不合法就一条都不写（`REVIEW_BATCH_REJECTED`，逐条报原因）。
 */
export function optimizeReviewTool({ store }) {
  return {
    name: 'amzn_optimize_review',
    description:
      'Read — or record — the Agent review of one optimization run (F13-08). '
      + 'The roster is 14 items: the 11 model-only checks (hallucination, contradiction, intent, COSMO causal chain, '
      + 'noun phrases, review alignment, GEO answerability, Q&A seeding, A+ increment, attribute facts, AI disclosure) '
      + 'plus 自然度 / 说服力 / 品牌语气. '
      + 'Each item can be concluded per field (a field-scoped conclusion is a different claim from a whole-draft one), '
      + 'and every conclusion must cite evidence: { kind: rule | draft | evidence | fact | human, ref }. '
      + 'rule / draft / evidence refs are resolved before anything is written — citing a rule that does not exist, or a '
      + 'field this run never drafted, is refused. '
      + 'Conclusions are persisted (optimization_review), and the item state is recomputed from the rows, never '
      + 'self-reported: pass / fail / unclear, and "nobody concluded this" is pending — not unclear. '
      + 'Call without conclusions to read; with conclusions to record (all-or-nothing per call).',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The optimization run to read or review.' },
        conclusions: {
          type: 'array',
          description: 'Omit to read only. Each entry records one conclusion.',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string', description: `One of the 14 review items: ${REVIEW_ITEMS.map(item => item.id).join(' / ')}` },
              field: { type: 'string', description: 'Optional. A draft field of this run (title / bullet_1 / attribute.x / …). Omit for a whole-draft conclusion.' },
              conclusion: { type: 'string', enum: REVIEW_CONCLUSIONS, description: 'pass / fail / unclear. "unclear" needs a note.' },
              note: { type: 'string', description: 'One line saying what was judged (required for unclear).' },
              evidence: {
                type: 'array',
                description: 'Required, non-empty. { kind, ref }: rule id / draft field of this run / evidence kind id / a fact label / what a human looked at.',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', description: 'rule | draft | evidence | fact | human' },
                    ref: { type: 'string', description: 'The thing pointed at. rule / draft / evidence refs must resolve.' },
                  },
                  required: ['kind', 'ref'],
                },
              },
            },
            required: ['itemId', 'conclusion', 'evidence'],
          },
        },
        by: { type: 'string', description: 'Who recorded it (e.g. agent / page).' },
      },
      required: ['runId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const runId = String(args?.runId ?? '').trim()
        if (runId === '') return { ok: false, error: 'runId is required' }
        const entries = Array.isArray(args?.conclusions) ? args.conclusions : null

        if (entries === null || entries.length === 0) {
          const review = readReview(store, runId)
          if (review.ok !== true) return review
          const lines = []
          lines.push(`Agent 审阅 · 轮次 ${review.runId.slice(0, 8)} · ${review.asin} ${review.marketplace}`)
          lines.push(`来源：${REVIEW_SOURCE}（${REVIEW_VERSION}）`)
          lines.push(`${review.counts.items} 项里：有结论 ${review.counts.items - review.counts.pending}`
            + `（通过 ${review.counts.pass} · 不通过 ${review.counts.fail} · 判不了 ${review.counts.unclear}）`
            + ` · 没有人下过结论 ${review.counts.pending}`)
          if (review.empty !== null) lines.push(`（${review.empty.kind}）${review.empty.text}`)
          lines.push('')
          for (const item of review.items) {
            lines.push(`- [${item.state === 'pending' ? ' ' : item.state === 'pass' ? 'x' : '!'}] ${item.label}（${item.id}）`
              + ` · ${item.stateLabel}${item.needsHuman ? ' · 只能人判' : ''} —— ${item.ask}`)
            lines.push(`    依据：${item.source}`)
            for (const row of item.rows) {
              lines.push(`    · ${row.fieldLabel}: ${row.conclusion}`
                + `${row.note === null ? '' : ` —— ${row.note}`}`
                + `　证据 ${row.evidence.map(ref => `${ref.kind}:${ref.ref}`).join('、')}`)
            }
          }
          lines.push('')
          lines.push('记录结论：再调一次本工具并带 conclusions（每条必须引用证据）。'
            + '`unclear` 必须带 note —— 「判不了什么」本身也是要写下来的信息。')
          return lines.join('\n')
        }

        /* 先全部校验，再写第一条。 */
        const checked = entries.map((entry, index) => ({
          index,
          itemId: String(entry?.itemId ?? ''),
          field: String(entry?.field ?? ''),
          result: checkReviewInput(store, runId, entry),
        }))
        const rejected = checked.filter(entry => entry.result.ok !== true)
        if (rejected.length > 0) {
          return {
            ok: false,
            code: REVIEW_CODES.BATCH_REJECTED,
            rejected: rejected.map(entry => ({
              index: entry.index,
              itemId: entry.itemId,
              field: entry.field,
              code: entry.result.code,
              error: entry.result.error,
            })),
            error: `这一批 ${entries.length} 条里有 ${rejected.length} 条不合法，**一条都没写**：`
              + rejected.map(entry => `[${entry.index}] ${entry.itemId || '（没有 itemId）'} —— ${entry.result.error}`).join('；'),
            hint: '半批写入在库里与一次故意提交没法区分，所以这里不写任何一条。改好再整批提交。',
          }
        }

        const written = []
        for (const entry of checked) {
          const result = recordReview(store, {
            runId,
            itemId: entry.result.item.id,
            field: entry.result.field,
            conclusion: entry.result.conclusion,
            note: entry.result.note,
            evidence: entry.result.refs,
            by: args?.by ?? 'agent',
          })
          if (result.ok !== true) return result
          written.push(result)
        }

        const after = readReview(store, runId)
        const lines = []
        lines.push(`已记录 ${written.length} 条审阅结论（轮次 ${runId.slice(0, 8)}）`
          + `${written.every(entry => entry.unchanged === true) ? '　—— 每一条都与库里已有的内容相同，没有改动' : ''}`)
        for (const entry of written) {
          lines.push(`- ${REVIEW_ITEM_BY_ID_LABEL(entry.itemId)}（${entry.itemId}）`
            + `${entry.field === '' ? ' · 整份草稿' : ` · ${labelForField(entry.field)}`}`
            + ` → **${reviewStateLabel(entry.conclusion)}**`
            + `　项状态 ${reviewStateLabel(entry.state)}（通过 ${entry.counts.pass} / 不通过 ${entry.counts.fail} / 判不了 ${entry.counts.unclear}）`)
        }
        if (after.ok === true) {
          lines.push('')
          lines.push(`这一轮的审阅进度：${after.counts.items - after.counts.pending}/${after.counts.items} 项有结论`
            + `（不通过 ${after.counts.fail} · 判不了 ${after.counts.unclear} · 还没有人下结论 ${after.counts.pending}）`)
          for (const item of after.items) {
            if (item.state === 'pass') continue
            lines.push(`- ${item.state === 'pending' ? '（没有结论）' : `（${item.stateLabel}）`}${item.label}（${item.groupLabel}）`)
          }
        }
        lines.push('')
        lines.push('这一行写在 optimization_review 上，工作台的「校验体系 → Agent 审阅」面板读的就是它。'
          + '结论可以改（再记一次同样的项与字段就是覆盖）。')
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: `审阅结论记录失败：${error.message}` }
      }
    },
  }
}

/** 14 项里的中文标签，读不到就回 id —— 输出里不该出现一个空白。 */
function REVIEW_ITEM_BY_ID_LABEL(itemId) {
  const item = REVIEW_ITEMS.find(entry => entry.id === itemId)
  return item === undefined ? String(itemId) : item.label
}

/** One place for "how many rows may this read return". */
function clampLimit(value, fallback, cap) {  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(number, cap)
}

/**
 * A stored listing row as numbered draft fields.
 *
 * The listing stores bullets as an array and the draft model numbers them, so
 * this is where the two shapes meet. Used for both the budget display and the
 * "before" column, which is why it lives here rather than inline in either.
 */
function fieldsForListing(listing) {
  if (listing === null || listing === undefined) return {}
  const fields = {}
  if (listing.title) fields.title = listing.title
  const bullets = Array.isArray(listing.bullets) ? listing.bullets : []
  bullets.forEach((bullet, index) => { fields[`bullet_${index + 1}`] = bullet })
  if (listing.description) fields.description = listing.description
  if (listing.search_terms) fields.search_terms = listing.search_terms
  return fields
}

/** Keyword rows for a context, or an empty list when there is no ASIN yet. */
function keywordsFrom(store, asin, marketplace, override) {
  if (asin === '') return []
  const { keywords } = keywordSetFor(store, asin, marketplace, 500)
  if (!Array.isArray(override) || override.length === 0) return keywords
  const wanted = new Set(override.map(item => String(item).replace(/\s+/g, ' ').trim().toLowerCase()))
  return keywords.filter(row => wanted.has(row.keyword.toLowerCase()))
}

/**
 * Every field the agent is allowed to write, with its own budget.
 *
 * Three things this deliberately does not do. It does not omit fields that have
 * no content yet — that is the point of the table, the report exists to show what
 * is missing. It does not collapse the 43 attributes into one "属性" row, because
 * one line is exactly how 42 of them go unwritten. And it does not sort by
 * anything but the registry's own order, so the report and the prepare package
 * list fields the same way and a reader can go back and forth.
 *
 * Attributes come last on purpose: they are the part a model should be most
 * reluctant to fill. They are facts, and a plausible-looking material is worse
 * than an empty one — an empty attribute reads as "unknown", a wrong one reads as
 * "verified".
 */
function fieldVocabulary(options, fields = {}) {
  const rows = []
  const push = (field) => {
    const budget = budgetFor(field, options)
    if (budget === null) return
    const value = fields[field]
    rows.push({
      field,
      label: budget.label,
      section: SECTION_LABELS[sectionOf(field)] ?? '其他',
      max: budget.max,
      unit: budget.unit,
      present: value !== undefined && value !== null && String(value).trim() !== '',
      publishable: isPublishable(field),
    })
  }
  for (const field of [...DRAFT_FIELDS].sort((a, b) => fieldRank(a) - fieldRank(b))) push(field)
  for (const id of REQUIRED_ATTRIBUTES) push(attributeField(id))
  return rows
}

/* The "which fields can be written back" split used to live here as a
   hand-written field list (`isListingWritable`) plus a section-label map. It is
   now `writebackSplit` in `domain/rules/listing-fields.js`, so the tool's stdout
   and the report body are computed from the field registry rather than from two
   copies that could drift. */

/**
 * One line saying which rule roster judged this draft.
 *
 * Printed rather than inferred because the two origins mean different things to
 * the reader. "规则库 2026.4.3" says *this is what your rule library says today*
 * — edit a rule in 规则中心 and the next validate reflects it. "运行快照 2026.4"
 * says *this is what it said when the run was made*, and a rule switched off
 * since then is deliberately still on here. A user who does not know which one
 * they are looking at concludes the rule switch is broken, when in fact they are
 * reading a frozen run.
 *
 * `code-seed` and `fromCode` are the honest-fallback cases: the store had no
 * roster, so the built-in seed was used. Flagged loudly, because it means rule
 * centre edits are not reaching this verdict.
 */
function rosterLine(roster) {
  if (roster === null || roster === undefined) return '规则口径 · ⚠️ 未知（没有记录判定所用规则集）'
  const where = roster.origin === 'run-snapshot'
    ? '本次运行快照'
    : roster.origin === 'active'
      ? '规则库当前版本'
      : roster.origin === 'code-seed'
        ? '代码内置规则集（未经规则库解析）'
        : `调用方直接给定的规则列表（来源未声明）`
  const version = roster.version === null || roster.version === undefined ? '版本未记录' : roster.version
  const warning = roster.fromCode ? '　⚠️ 规则库为空，用的是代码内置规则集，规则中心的改动不会体现在这里' : ''
  return `规则口径 · ${where} ${version}（${roster.count} 条生效）${warning}`
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

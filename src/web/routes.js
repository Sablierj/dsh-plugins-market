/**
 * The workbench's HTTP surface: one page, one JSON API, one event stream.
 *
 * Three routes, deliberately:
 *
 *   exact  /custom/amazon-ops          the page itself
 *   prefix /custom/amazon-ops/api      state read + context write
 *   prefix /custom/amazon-ops/events   server-sent events, held open
 *
 * A prefix route path must NOT end with a slash. The router matches
 * `pathname === prefix || pathname.startsWith(prefix + '/')`, so registering
 * `/custom/amazon-ops/api/` makes the match require a doubled slash and the
 * route silently never fires — the request falls through to the 404 fallback.
 *
 * The progress channel is SSE rather than WebSocket on purpose. A `WebRoute`
 * handler owns the whole response lifecycle and may hold it open, so SSE costs
 * one route and no framing code; `registerUpgrade` would mean implementing the
 * WebSocket handshake and frame encoding by hand, for a channel that only ever
 * pushes server→page. The page→plugin direction already has POST.
 *
 * Routes are registered inside `ctx.inject(['webServer'], …)` because reading
 * the service once with `ctx.get()` can run before its fiber is active and
 * silently leave the page unregistered.
 */

import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

import { nowIso } from '../store/db.js'
import {
  counts, getAsin, getCollectionTask, getOptimizationRun, keywordCoverage, listOptimizationRuns, listProductLines,
  optimizationArtifactMap, queryAsins, queryKeywords, upsertProductLine,
} from '../store/queries.js'
/* 模块 04 第二子批 — 采集中心的八条路由。每一条都调**与工具同一个函数**：页面点一次与
   会话调一次在审计里必须是同一条，而保证这件事的唯一办法是同一份代码。 */
import { ENV_CHECK_META, runEnvCheck, siteCooldown } from '../domain/collect/env.js'
import { previewCollection } from '../domain/collect/preview.js'
/* F04-04: the prefill banner is built by the **same** function the run path uses
   (`collection.js` submitCollectionTask), so the range the form shows as the
   default and the range the run records in `prefill_json` cannot disagree. */
import { prefillFor } from '../domain/collect/prefill.js'
import { buildSectionDetail } from '../domain/collect/detail.js'
import { resolveWaiting, waitingView } from '../domain/collect/waiting.js'
import { windowState } from '../domain/collect/window.js'
import { planSave, schemeSave, schemeTransition } from '../domain/collect/scheme.js'
import { latestEnvChecks } from '../store/collection-env.js'
import { adoptCompetitor, discoverCompetitors, listAllCompetitors, retireCompetitor, reverseCompetitorFacts, upsertCompetitor } from '../store/asin-competitor.js'
import {
  buildProductPlan, commitProductPlan, fingerprintOf, listProfiles, readProductRows,
  recommendBrand, resolveProductDir, scanProductDir,
} from '../domain/asin/product-import.js'
import { listSchemes } from '../store/collection-scheme.js'
/* `listPlans` is already taken in this file by the **keyword** position plan's store
   (`store/keyword-plan.js`) — a different table about a different thing — so the
   collection plan's reader is aliased rather than shadowing it. `getPlan` and
   `setPlanEnabled` come from the same file: `set-enabled` is a **narrow** flip, and
   the existence check has to read the row before anything is written. */
import { getPlan as getCollectionPlan, listPlans as listCollectionPlans, setPlanEnabled } from '../store/collection-plan.js'
import { countSectionResults, taskAsinSummariesWithCoverage } from '../store/collection-section.js'
import {
  getCompetitorSet, listCompetitorSets, masterStats, normalizeAsinList, queryMaster, readCompetitorSides,
  readLibraryMembership, readResearchCompetitor, readResearchLibrary, recomputeMaster, setImportIncluded,
  upsertCompetitorSet,
} from '../store/kw.js'
import { getRun, listRuns, runStats } from '../store/pipeline.js'
import { readCompetitorEvidence } from '../store/competitor-evidence.js'
/* R-91：字段模板的页面写路径 —— 按钮「更新字段模板 / 确认提案 / 回滚」「保存改动」都落这四个函数。 */
import {
  confirmTemplateVersion, getTemplateVersion, rollbackTemplate, saveTemplateVersion,
} from '../store/field-template.js'
import { attributeStatus, saveAttributes } from '../domain/asin/attributes.js'
import { competitorBrandHits } from '../store/keyword-ownership.js'
import {
  REPORT_KINDS, REPORT_STATUSES, getReport, getReportBody, listReports, recordReport,
  reportCounts, reportCreators, reportProductLines, reportTags,
  setReportArchived, setReportFavorite, setReportTags,
} from '../store/reports.js'
/* F14-10 — 导出件的判定与字节都在 `domain/reports/export.js`：路由发字节、页面拿链接，
   两半读同一份 `exportPlan`，所以按钮不会承诺一个路由拒绝的格式。 */
import { attachmentHeader, exportArtifact, exportPlan } from '../domain/reports/export.js'
/* F14-01 — 八类生成报告的正文构建器。页面不自己拼文档：它调与 `amzn_report_build`
   同一个函数，两者对「一份报告长什么样」只能有一种看法。 */
import { GENERATED_KINDS, buildReport } from '../domain/reports/build.js'
import {
  declaredSettings, deleteSetting, getSetting, listSettings, listSourcesRedacted, postalCodeFor,
  setSetting, settingsRowsFor,
} from '../store/settings.js'
/* S1-B17: the approval policy. The page's six toggles write through
   `setApproval` rather than through `setSetting` directly — the floor rule
   ("may be tightened, never relaxed") lives there, and a route that wrote the
   key itself would be the one door it does not cover. `approvalFor` is the
   shared routing test, so the route and the tool cannot disagree about which
   keys those are. */
import {
  CONFIGURABLE_APPROVALS, HARD_APPROVALS, approvalFor, approvalPolicy, approvalRefusal, setApproval,
} from '../domain/approval/policy.js'
/* S1-B18: the first-run wizard. Its three steps and their required fields are
   transcribed from prototype/02-settings.html; the module reads the store, so
   "可采集" is a computation rather than a recorded progress flag. */
import { wizardState } from '../domain/setup/wizard.js'
/* 模块 12：任务画布。运行/步骤/产物三张表由 store/agent.js 读，角色与门禁是代码里的
   声明（domain/agent/roles.js）—— 库记事实、代码记声明，两边在这一层合成一个答案。 */
import { getRun as getAgentRun, listAllArtifacts, listRuns as listAgentRuns, startRun as startAgentRun } from '../store/agent.js'
import { listDataRequests } from '../store/agent-request.js'
import { agentMetrics } from '../domain/agent/metrics.js'
import { AGENT_PLAN_MODE_LABELS, planNextStep } from '../domain/agent/orchestration.js'
import {
  agentArtifactConventions, agentArtifactDecideTool, agentGateDecideTool, agentGapView, agentRunFinishTool, roleView,
} from '../tools/agent.js'
import { AGENT_ARTIFACT_STATUSES, AGENT_ARTIFACT_STATUS_LABELS, AGENT_GATES, AGENT_TASK_TYPE_LABELS, roleById } from '../domain/agent/roles.js'
/* F12-06 / F12-09：blocked 的原因词表、重试预算与上下文包差异。都由服务端算好下发，
   页面只渲染 —— 出口动作表（哪个原因跳哪个模块）如果页面自己再写一份，就是「一句事实
   活在两个文件里」，与 F12-03 的产物类型清单同一条规矩。 */
import { BLOCKED_KINDS, retryBudget, snapshotDiff } from '../domain/agent/run.js'
import { TIER_LABELS, TIER_MEANING, TIERS } from '../sources/keyword-tiers.js'
import { readSignalCategories } from '../domain/keywords/signals.js'
import { previewSignalImpact } from '../domain/keywords/impact.js'
import { buildCompetitorDiff, buildEvidenceView, classifyQuadrants, DIFF_ORDERS, quadrantRows, QUADRANT_ORDER, QUADRANT_PAGE_SIZE } from '../domain/keywords/competitor.js'
import { buildResearchCandidates, collectCandidateKeywords } from '../domain/keywords/research.js'
/* 关键词数据源目录：固定的四个子目录 + 扫描 + 系统级的"打开 / 选择目录"。 */
import { createMissingDirs, kindForFile, looksLikeSourceRoot, scanSourceDir, sourceRoot } from '../domain/keywords/source-dir.js'
import { importDirectory } from '../domain/keywords/pipeline.js'
import { asinPortfolio } from '../domain/asin/portfolio.js'
import { openInExplorer, pickFolder } from '../domain/keywords/source-dir-os.js'
import { renderTemplate } from '../domain/optimize/prompt.js'
/* F13-02 / F13-04（模块 13 第一子批）：九项前置门槛与四种优化模式。页面**不自己
   判**这九项 —— 它读这份由 `precheckFor` 产出的报告，而 `precheckFor` 就是
   `amzn_optimize_precheck` 与 `amzn_optimize_prepare` 用的那一个函数。
   只取 `precheckFor`：这一批的页面不调工具，它读同一个入口算出来的报告，
   多列一个没人用的名字会被「每个具名 import 都要被用到」那条断言拦下来。 */
import { OPTIMIZE_MODES, OPTIMIZE_MODE_LABELS, TARGETED_SCOPES, modeCatalog } from '../domain/optimize/mode.js'
import { precheckFor } from '../tools/optimize.js'
/* F-7 第一块：「开跑」的页面入口调的是**同一个工具**（optimizePrepareTool），
   不是路由里重写一套参数校验 —— 两套校验迟早会对同一个 ASIN 给出两个答案。
   单独一行 import，不与 precheckFor 合并：b13-page ① 钉着上一行的精确字面量。 */
import { optimizePrepareTool } from '../tools/optimize.js'
import { promptVariableRows, variableReport } from '../domain/prompts/variables.js'
import { EVAL_DIMENSION_COUNT, EVAL_DIMENSIONS, EVAL_DIMENSION_SUMMARY } from '../domain/prompts/eval-dimensions.js'
import { referencesForPrompt, scanPromptReferences } from '../domain/prompts/references.js'
/* The resolved run view is shared with `amzn_report_diff` — see that file for why
   it is not defined here any more. */
import { describeOptimizationRun } from '../domain/optimize/run-view.js'
/* B-13b / F13-01：草案收件箱。分组、筛选谓词、行投影都在 `domain/optimize/inbox.js`
   —— 页面拿到的 `group` / `buckets` / `contextState` 全是算好的，它只做
   `buckets.includes(id)` 这样的成员测试，**不重算任何判据**。 */
import {
  INBOX_GROUP_IDS, applyInboxAction, buildInbox, inboxFilterFrom, reoptimizeFromDraft,
} from '../domain/optimize/inbox.js'
/* B-13b / F13-03：十类证据包。读的是只读冻结表；冻结发生在 prepare 与 save 里。 */
import { collectEvidence, freezeEvidence, readEvidence } from '../domain/optimize/evidence.js'
/* B-13c / F13-05：九项策略卡与门禁。页面**一分数都不算** —— 九项的 status / source /
   facts 与门禁的 open / state 全部读 `readStrategy` 算好的那一份，确认走
   `confirmStrategy`（与工具侧同一个判据函数）。 */
import { confirmStrategy, readStrategy } from '../domain/optimize/strategy.js'
/* B-13c / F13-06：位置计划核对。继承与建议由 `inheritPlan` / `suggestPlan` 算好；
   采纳时写回模块 08 的**新版本**，走 `decidePlanCheck` → 08 的 `savePlan`。 */
import { decidePlanCheck, readPlanCheck } from '../domain/optimize/position-plan.js'
/* B-13d / F13-08：校验体系的三块面板（规则 / 闸门 / Agent 审阅）读的是
   `readValidationSystem` —— 与工具 `amzn_optimize_validation` 同一个函数。
   页面**一条判据都不算**，所以「把域层改坏 → 工具侧与页面侧两条断言同时红」是
   结构上成立的，不是靠自觉。审阅结论的写入走同一个 `recordReview`。 */
import { recordReview } from '../domain/optimize/review.js'
import { readValidationSystem } from '../domain/optimize/validation-system.js'
/* B-13d / F13-09：交付边界（可复制字段 / 操作清单 / 发布登记跳转）。它与报告第十二节
   是**同一个 `buildDelivery`**，所以面板上那一条清单与报告里那一条不会分成两份。 */
import { buildDelivery, manualFieldRows, publicationsForRun } from '../domain/optimize/delivery.js'
/* S1-B17.1 的审批策略，页面这一侧也要读：收件箱的「审批状态」一列与 save 的
   接受草案闸门必须是同一份策略读数。`approvalPolicy` 已在上面那一组具名 import 里。 */
import { missingChecks } from '../domain/rules/registry.js'
import { documentationGaps, readManual } from '../domain/rules/parse.js'
import { limitsFor, profileFor } from '../domain/rules/marketplaces.js'
import { MARKETPLACES } from '../sources/pages/index.js'
import {
  linkPolicyToRules, listPolicies, listPolicySources, policyLinksByRule, policyStats,
} from '../store/policy.js'
import { policyCandidateView } from '../store/policy-candidate.js'
import {
  DEFAULT_POLICY_QUERY, confirmPolicyCandidate, rejectPolicyCandidate, startPolicyCheck,
} from '../domain/policy/candidate.js'
import {
  activatePromptVersion, getPrompt, listEvalCases, listEvalSets, listPrompts, listPromptSets, previewPrompt, promptHistory,
  promptLifecycleView, promptProductionGate, promptStats, recordPromptLifecycle, resolvePrompts,
  rollbackPrompt, rollbackPromptVersion, upsertPrompt,
} from '../store/prompt.js'
import { activeVersion, listVersions, loadActiveRoster, loadRosterVersion, setRuleEnabled } from '../store/rules.js'
/* S1-B11: the snapshot registry — the unified index of versioned objects. The
   page reads a lazy slice and archives one version at a time. */
import { archiveSnapshot, getSnapshot, snapshotView } from '../store/snapshot.js'
/* S1-B19: retention. Soft delete goes through the registry's own archive, but
   only after the reference graph says nothing still points at the version — and
   the refusal names the referrers. */
import { restore, retentionView, softDelete } from '../store/retention.js'
import { conflictView, resolveConflict } from '../store/conflict.js'
import {
  archiveWorkspace, createWorkspace, exportWorkspaceConfig, listWorkspaces,
  renameWorkspace, setDefaultWorkspace, view as workspaceView, workspaceWriteRefusal,
} from '../store/workspace.js'
import { listAllVerifications, listSiteProfiles, recordSiteVerification, upsertSiteProfile } from '../store/site.js'
import { archiveShop, getShop, listBrands, listShops, findBrandByAlias, restoreShop, upsertBrand, upsertShop } from '../store/shop.js'
import { readReviewFamily, resolveReviewFamily } from '../store/review.js'
import { runReviewAnalysis } from '../domain/asin/review-analysis-run.js'
import { archivedShopFor, shopsState } from '../domain/asin/shops.js'
import { deriveOwnership, ownershipView, retractOwnership, upsertOwnership } from '../store/ownership.js'
import { siteProfileView } from '../domain/site/profile.js'
import { discoverProfiles, loginView, profileView, resolveImportDir, thirdPartyView } from '../domain/collect/profile.js'
import { buildHealthCards } from '../domain/dashboard/health.js'
import { buildHealthTrends, describeTrend } from '../domain/dashboard/trends.js'
import { buildDecisions, buildDigest, buildTodos } from '../domain/dashboard/todos.js'
import { buildRecent } from '../domain/dashboard/recent.js'
/* S1-B14: the six quick actions and the three-step first-run guide. The guide's
   third step reads the cards, so `homeState` builds the cards first and hands
   them to it — the tick and the card are then computed from one array and
   cannot disagree. */
import { buildQuickActions } from '../domain/dashboard/quick-actions.js'
import { commandPalette } from '../domain/search/command-palette.js'
import { spendReport } from '../domain/reports/spend-monthly.js'
import { MODULE_GROUPS } from '../state/workbench.js'
import { buildOnboarding, emptyCardsNote } from '../domain/dashboard/onboarding.js'
/* S1-B15: one box over everything. The kinds, their tables and the reason SKU
   cannot be answered all live in the domain module; this file only decides when
   to run it. */
import { searchAll } from '../domain/search/index.js'
/* S1-B20: 收藏与最近访问. The two lists are read for the home panel and written
   by the two routes below; the domain module owns the ordering, the de-dupe and
   the cap. */
import { pinView, pushRecent, toggleFavorite } from '../domain/dashboard/pins.js'
import { catalogView } from '../store/catalog.js'
import { traceField } from '../domain/data/lineage.js'
/* S1-B09: the quality cockpit. The page reads a lazy slice (the issue list plus
   the counts) and moves one issue at a time; `setIssueStatus` is the state
   machine's only door, so the page cannot write a status the machine lacks. */
import { issueStats, listIssues, setIssueStatus } from '../store/quality.js'
/* S1-B16: the notification list. `unreadCount` is cheap and needed on every poll
   (the bell is in the top bar); the rows are only read when the panel is open. */
import { KEEP_DAYS, clearByKind, markAllRead, markRead, notificationView, unreadCount } from '../store/notification.js'
import { DIMENSION_LABELS, DIMENSIONS } from '../domain/data/quality-rules.js'
import { AUDIT_OBJECT_TYPES, DQ_ISSUE_STATUSES, DQ_ISSUE_TRANSITIONS, PROBLEM_CODES, SEVERITIES } from '../domain/states.js'
import { DEFAULT_WORKSPACE_ID, scopeWorkspaceIdOf } from '../domain/context/scope.js'
/* S1-B12: the audit log's page funnel. The descriptors say which routes write
   and how to read the old value; `recordAudit` is the log's only writer. */
import { PAGE_WRITE_TARGETS, composeReason } from '../domain/audit/targets.js'
import { auditStats, listAudit, recordAudit } from '../store/audit.js'
/* 模块 14 §6-§9：发布闭环的读切片与四条写路由。读用 store/observe.js 的视图，
   写**只走工具**（tools/observe.js）—— 审计漏斗挂在工具上，绕过就丢审计。 */
import {
  BASELINE_CHOICES, ensureCheckpoints, getPublication, listObservationPlans, listPublications,
  listRollbackTasks, publicationObservation, publicationRate,
} from '../store/observe.js'
import {
  observationConcludeTool, publicationBaselineDecideTool, publicationRecordTool, rollbackSuggestTool,
} from '../tools/observe.js'
import { CONCLUSION_LABELS } from '../domain/observe/observation.js'
/* 模块 08 F08-07：关键词九态生命周期。读用 store/keyword-lifecycle.js 的计数与列表，
   写**只走工具**（tools/kw-lifecycle.js）—— 审计漏斗挂在工具上，绕过就丢审计。九态
   词表与中文标签从 domain/states.js 读，路由里不重写一份。 */
import { keywordLifecycleCounts } from '../store/keyword-lifecycle.js'
import { keywordLifecycleBatchSetTool, keywordLifecycleSetTool } from '../tools/kw-lifecycle.js'
/* FR-M6-19：US/CA 排名对比视图。读口在 store 里（判定与文案都在那一份），这里只透传 ——
   页面点一次和路由算一次不能有两份口径。竞品页的 §20.3 判定被它 import 复用，不改。 */
import { compareMarketplaceRanks } from '../store/keyword-marketplace-compare.js'
/* FR-M6-03：批次视图（期间标签分组）。批次标识是**既有**的 `kw_import`（一次导入一行），
   词→批次走事实表的 `source_file` → `kw_import.file_path`；这里只透传，不解析 period。 */
import { keywordBatchView, listKeywordBatches, PERIOD_SHAPE_NOTE } from '../store/keyword-batch-view.js'
/* v69 — 产品线**归属**。判定只有 store 的 `effectiveProductLine`（内部 `resolveProductLine`）
   一处；路由只读、只透传，不自己写 COALESCE(人工, 派生)。 */
import {
  effectiveProductLine, listEffectiveProductLines, productLineCounts, productLineOptions,
} from '../store/keyword-product-line.js'
import { keywordProductLineBatchSetTool } from '../tools/keyword-product-line.js'
import { KEYWORD_LIFECYCLE_LABELS, KEYWORD_LIFECYCLE_STATES } from '../domain/states.js'
/* 模块 08 F08-04：关键词所有权工作台。读用 store/keyword-ownership.js 的视图与统计
   （主人与冲突都是推导的，页头徽标与工作台表共用同一份推导，不会各说各话），写**只走
   工具**（tools/kw-ownership.js）—— 审计漏斗挂在工具上，绕过就丢审计。 */
import { keywordOwnershipStats, keywordOwnershipView, ownershipForKeywords } from '../store/keyword-ownership.js'
import {
  keywordOwnershipBatchTool, keywordOwnershipPreviewTool, keywordOwnershipResolveTool,
} from '../tools/kw-ownership.js'
/* 模块 08 F08-05：位置计划持久层。读用 store/keyword-plan.js 的列表 / 单计划 / 提案 /
   覆盖；写**走 store 的 savePlan**（与 tools/kw-plan.js 的 `_save` 是同一个函数，审计
   action 也共用 `keywordPlanSave`）。提案**不写库**，所以页面上的「生成提案」不进审计。
   计划覆盖与实际覆盖**分开返回**：页面没有 listing 文案，实际覆盖是 null 而不是 0。 */
import { getPlan, listPlans, planCoverage, planPositions, proposePlan, savePlan } from '../store/keyword-plan.js'
/* 模块 08 F08-08：关键词详情。只读，按选中的 (关键词, 站点) 组装七个 §8.2 项，
   交给页面渲染。缺失分「未测量」与「本系统没有这个字段」两种说法，词表在
   store/keyword-detail.js 里，路由与页面都不自己编。 */
import { ABSENCE_UNMEASURED, readKeywordDetail } from '../store/keyword-detail.js'
/* 模块 05 第一子批：ASIN 详情与数据层。两条读路由（详情 / 归档影响预览）直接读
   domain 的 builder；四条写路由**只走工具**（tools/asin.js）—— 审计漏斗挂在工具上，
   绕过它页面点一次就不会留下那一行，而「每次写操作记录」看起来仍然是满足的。
   详情用 GET：它是纯读且参数简单，与 B-04 的 /api/sections 同一条理由。 */
import { buildAsinDetail } from '../domain/asin/detail.js'
/* FR-M2-05 ②：行内改归属前的影响面。域层一份实现，页面与（将来的）工具共用。 */
import { asinFieldImpact } from '../domain/asin/impact.js'
/* F05-01：17 列的目录与列配置收敛，以及保存视图的读 / 存 / 删。
   目录**由服务端注入页面**（见 page.js 的 ASIN_COLUMNS）—— 页面脚本是模板字符串、
   没有模块系统，手写第二份列清单就会与工具印的漂开，而漂开时两边都不报错。 */
import { ASIN_COLUMNS, asinColumnCatalog, resolveAsinColumns } from '../domain/asin/table.js'
import { deleteAsinSavedView, listAsinSavedViews, saveAsinSavedView } from '../store/asin-view.js'
import { archiveImpact, archivedAsinCount } from '../store/archive.js'
import { asinReferenceReport } from '../domain/asin/archive-refs.js'
import {
  asinArchiveTool, asinDeleteTool, asinFieldCorrectTool, asinVariantCorrectTool, asinVariantUpsertTool,
} from '../tools/asin.js'
/* FR-M2-05：归属的写入口。页面路由与工具共用这一个（同一个 store 函数、同一个动作名）。 */
import { asinOwnershipSetTool } from '../tools/asin-ownership.js'
/* B-05c 第二批 —— F05-04 历史 diff / F05-07 健康摘要 / F05-05 批量导入。
   三条读路径直接调 domain 的 builder（与 asin-detail 同一条约定）；导入那一条**只走工具**
   （`asinImportTool`），因为审计漏斗挂在工具/路由上，而计划与写库的编排只能有一份 ——
   页面自己再拼一遍就是第二份实现，两边漂开时谁都不报错。
   健康摘要需要的两样注入（fields / precheck）在这里解析：`fields` 来自 buildFieldFacts，
   `precheck` 来自 precheckFor —— 后者就是 amzn_optimize_precheck 与页面的「开跑这一轮」按钮用的同一个入口。 */
import { buildAsinHistory } from '../domain/asin/history.js'
import { buildAsinHealthSummary } from '../domain/asin/health.js'
import { buildFieldFacts } from '../domain/asin/fields.js'
import { asinImportTool } from '../tools/asin-import.js'
import { renderWorkbenchPage } from './page.js'
import { sendHtml } from './compress.js'
import { progressView } from '../domain/collect/progress.js'
import { reconcileTasks } from '../domain/collect/estimate-audit.js'
import { estimateMinutes } from '../domain/collect/targets.js'

/**
 * 导入的失败码 → HTTP 状态。两个导入路由共用这一份，所以「同一个拒绝在预览与写两条路
 * 上给同一个状态码」不靠自觉。
 *
 * 409 是「这份文件本身没问题，是状态/策略不允许现在写」：重复行、覆盖未确认。
 * 400 是「文件或参数不合法」。
 */
const ASIN_IMPORT_STATUS = {
  DUPLICATE_ROWS: 409,
  APPROVAL_REQUIRED: 409,
  EMPTY_INPUT: 400,
  NO_DELIMITER: 400,
  MISSING_HEADER: 400,
  MISSING_ASIN_COLUMN: 400,
  INVALID_ROWS: 400,
  UNKNOWN_SOURCE: 400,
  ASIN_IMPORT_READBACK_MISMATCH: 500,
}

const MAX_BODY_BYTES = 1_000_000
const HEARTBEAT_MS = 25_000

/**
 * 页面 ASIN 表的归档口径 —— **显式的一格，不是「不传参数碰巧得到的东西」**。
 *
 * 它今天与 `store/queries.js` 的 `ASIN_ARCHIVE_DEFAULT` 相同（`all`），而这个「相同」
 * 正是要防的东西：两个默认值一致时，靠「不传 archived」也能得到对的结果，
 * 于是**没有任何东西**保证它们继续一致。数据层改默认的那一天，页面的行为会在
 * 没有代码改动、没有测试变红的情况下改变 —— 所以这一格写出来，由页面这一侧拥有。
 *
 * 口径本身不是随便选的：`domain/asin/table.js` 的 `projectAsinRow` 已经决定了
 * 「不隐藏归档的行、只给它们打芯片」（把一条记录藏起来会让它看起来像数据丢了），
 * `tools/asin.js` 会话侧同样逐行印「（已归档）」。三处说的是同一件事。
 */
const ASIN_PAGE_ARCHIVED = 'all'

/**
 * 页面那一份 ASIN 列表。
 *
 * 除了归档口径，它还要挡住一个**具体的失败**：`filters` 是从工作台上下文来的，
 * 而上下文里的筛选可以由**一份保存视图**（`asin_saved_view.filters_json`，任意 JSON）
 * 带进来。一个认不出的 `archived` 值会让 `queryAsins` 抛错 —— 而它挂在 `/api/state` 上，
 * 一次抛错就是整个工作台白屏。所以这里把那一类错误**收拢成载荷里的一格**：
 * 用页面默认口径继续出数，同时把「你要的筛选值不合法」明说出去。
 * 静默退回默认是不行的 —— 那会把「筛的是别的口径」渲染成「筛的就是这个口径」。
 */
function asinListingForPage(store, filters, limit) {
  const requested = filters?.archived ?? ASIN_PAGE_ARCHIVED
  try {
    return { ...queryAsins(store, { ...filters, archived: requested, limit }), archivedFilterError: null }
  } catch (error) {
    if (error?.code !== 'ASIN_ARCHIVED_FILTER') throw error
    return {
      ...queryAsins(store, { ...filters, archived: ASIN_PAGE_ARCHIVED, limit }),
      archivedFilterError: error.message,
    }
  }
}

/* ── the quality module: six views, five of them built ──────────────────────── */

/* The tab ids, in draw order. The ids are the domain's — the page owns the
   labels, the same split as TODO_BUCKET_LABELS, and the suite asserts the two
   lists agree in both directions. Exported so that assertion can read the
   domain's list rather than restating it.

   Six, not four: the design's module 03 is F03-01…F03-06 (目录 / 血缘 / 驾驶舱 /
   冲突 / 快照 / 审计). A tab list that stops at four makes the other two
   unreachable — the exact failure the two-way assertion exists to catch. */
export const QUALITY_TABS = ['catalog', 'cockpit', 'lineage', 'conflicts', 'snapshot', 'audit']

/* F-4：优化页「选一个 ASIN」下拉一次最多给多少条。
   它是**下拉**不是列表页：超过这个数就不是「挑一个」而是「翻一页」了，那件事该去
   ASIN 库做。页面在 `total > limit` 时必须把「只给了前 N 条」说出来，不许静默截断。 */
const OPTIMIZE_ASIN_OPTION_LIMIT = 100

/**
 * Which HTTP status a collection-centre refusal answers with (contract §6.3:
 * 成功 200 / 参数错 400 / 对象不存在 404 / 状态不允许 409).
 *
 * Written down once instead of at fourteen call sites: "which status does
 * `NOT_CANCELLABLE` get" has one answer, and answering it per route is how two
 * routes come to answer it differently.
 */
const COLLECT_HTTP_STATUS = {
  /* 对象不存在 —— 404 */
  TASK_NOT_FOUND: 404,
  ASIN_NOT_IN_TASK: 404,
  PLAN_NOT_FOUND: 404,
  SCHEME_NOT_FOUND: 404,
  SOURCE_UNKNOWN: 404,
  /* 状态不允许 —— 409（`APPROVAL_REQUIRED` 也在这里：请求本身没问题，是需要一个人） */
  NOT_WAITING: 409,
  WAITING_EXPIRED: 409,
  NOT_COLLECTED: 409,
  NOT_CANCELLABLE: 409,
  ACTION_NOT_ALLOWED: 409,
  COOLING_DOWN: 409,
  ENV_CHECK_FAILED: 409,
  SCHEME_IN_USE: 409,
  SCHEME_IMMUTABLE: 409,
  SCHEME_NOT_SELECTABLE: 409,
  SCHEME_VERIFY_FAILED: 409,
  ILLEGAL_TRANSITION: 409,
  APPROVAL_REQUIRED: 409,
  LOCKED: 409,
  DUPLICATE_NAME: 409,
  /* 其余一律 400（参数错）：答案从这个表里来，不是从每个路由自己猜。 */
}

function collectHttpStatus(code) {
  return COLLECT_HTTP_STATUS[String(code ?? '')] ?? 400
}

/* Which batch fills each tab that has nothing behind it yet. Carried in the
   payload instead of hard-coded in the page: the page is a template string with
   no build step, so a batch number written there is a promise nothing updates.
   `cockpit` left this map in S1-B09, `conflicts` in S1-B10 and `audit` in
   S1-B12, when their views were built — a tab that is still listed here while
   its view exists is a page telling the user to wait for a batch that already
   shipped.

   It is **empty now**, and that is the honest state rather than a leftover: all
   six of module 03's views are built. The map stays because the page reads the
   *presence* of an entry to decide whether to draw the "not built yet" sentence
   — an empty map is what makes that mechanism say nothing today, and what makes
   it work again for the seventh tab before its batch lands. */
const QUALITY_PENDING = {}

/* The fields the lineage view offers. A fixed list rather than every column of
   `asin`: the question worth answering is where a *value somebody uses* came
   from, and a column like `updated_at` has no source to trace — offering it
   would produce a chain that always ends at "never collected" and teach the
   reader to ignore the view. */
const LINEAGE_FIELDS = ['price', 'bsr', 'rating', 'title', 'brand', 'category', 'image_url']

export function registerWeb(ctx, { store, workbench, sources, collection, collector = null, keywordService, pagePath, dataDir = null, chromePath = null, browserChannel = {} }) {
  const apiPath = `${pagePath}/api`
  const eventsPath = `${pagePath}/events`
  /* The report view is its own prefix route rather than part of the API: it
     returns a full HTML document meant to be opened, bookmarked and forwarded,
     which is a different contract from the JSON the page talks to. */
  const reportPath = `${pagePath}/report`

  /**
   * Funnel ②: the page's write funnel — the twin of `instrument()` in
   * `src/tools/index.js`, over `PAGE_WRITE_TARGETS` instead of `WRITE_TARGETS`.
   *
   * ## Why it is two calls instead of one wrapper
   *
   * The tools are wrapped: `instrument(definition)` hands the tool's `execute`
   * over and the wrapper decides what to do around it. The route bodies cannot
   * be wrapped that way. They are inline — validation, the write and the reply
   * are interleaved, and a request that fails validation must answer 400
   * *without* the write having run. There is no single callback to hand over.
   *
   * So each route calls this itself: once **before** the write, which is when
   * the old value has to be read, and once **after** it, with the reply it is
   * about to send. The second call is the recorder, and a route that answers a
   * validation error simply never reaches it — which is exactly the "a failed
   * write leaves no row" rule, enforced by control flow rather than by a check.
   *
   * ## The three rules, the same three as funnel ①
   *
   *   - **Only writes are recorded.** A route whose descriptor is `null`
   *     (`context`, the two previews) gets a no-op recorder and never touches
   *     the log.
   *   - **Only successful writes.** The recorder returns without writing when
   *     the reply says `ok: false`. A 409 from a state machine or a 404 for a
   *     missing row is a refusal, and a refusal is not a change.
   *   - **A failed read of the old value does not fail the write.** Same as the
   *     tool funnel: the row is written with `reason` naming the failed read, so
   *     "there was no previous value" and "we could not read one" stay apart.
   *
   * An audit failure never fails the request: by the time the recorder runs the
   * write has committed, and turning a successful write into a 400 to save the
   * log would misreport the store. It is loud on the activity feed instead.
   */
  function pageWrite(route, body) {
    const target = PAGE_WRITE_TARGETS[route]
    if (target === undefined || target === null) return () => {}

    let before = null
    let beforeNote = null
    try {
      before = target.readBefore(store, body)
    } catch (error) {
      before = null
      beforeNote = `前值读取失败: ${error.message}（写仍然发生，前值未知）`
    }

    return (result) => {
      if (result !== undefined && result !== null && result.ok === false) return
      /* The page-side twin of the tool funnel's `skip` rule: a call that wrote
         nothing must not leave an audit row. `body` and `result` are both passed
         because a skip can depend on the request (`dryRun`) or on what the route
         actually did. A throw inside `skip` must not swallow the row: the write
         already happened, so fall through and record it, naming the failure on
         the feed rather than dropping the audit. */
      let skipped = false
      try {
        skipped = target.skip?.(body, result) === true
      } catch (error) {
        workbench.record('audit:error', { route: `api:${route}`, error: `skip: ${error.message}` })
      }
      if (skipped) {
        workbench.record('audit:skip', { route: `api:${route}`, reason: 'skip' })
        return
      }
      try {
        recordAudit(store, {
          action: target.action,
          objectType: target.objectType,
          objectId: target.objectId(body, result),
          before,
          after: pageAfterValue(target, body, result),
          route: `api:${route}`,
          actorKind: 'page',
          reason: composeReason(target, body, beforeNote),
        })
      } catch (error) {
        workbench.record('audit:error', { route: `api:${route}`, error: error.message })
      }
    }
  }

  /**
   * The new value, read the same way the old one was — one rule, shared with
   * funnel ①: **re-read the object with the same reader; if there is no object
   * to re-read, the route's own reply is the after value.**
   *
   * A create has no id to re-read by (the body omitted it and the store minted
   * one), so the reply's row is the only description of what now exists. A
   * reader that throws is treated the same way, never as a reason to drop the
   * row.
   */
  function pageAfterValue(target, body, result) {
    try {
      const read = target.readBefore(store, body)
      if (read !== null && read !== undefined) return read
    } catch {
      /* fall through to the reply */
    }
    return result === undefined ? null : result
  }

  /**
   * 归档即只读, enforced where the write happens.
   *
   * `store/workspace.js` has said since v20 that the rule is enforced **at the
   * write**, not by the page hiding buttons — and until this batch nothing under
   * `src/` called `assertWorkspaceWritable`, so the rule was a sentence in a
   * comment. This is the page's half of it; the three write tools over the same
   * tables ask the same function, so a click and a tool call get one answer.
   *
   * Every **configuration** write it covers — `setting` / `source` /
   * `product_line` / `site_profile` / `shop` / `brand` — passes **two** ids,
   * because one write has two real targets: the workspace the row **lands in**,
   * resolved the way its own writer resolves it (an existing row keeps its
   * workspace, a create takes the body's — each site reads the row rather than
   * assuming), and the workspace the **scope bar is showing**. "Read-only" means
   * nothing changes while you are in that space, not merely that its own rows are
   * frozen: a page sitting in an archived workspace that could still edit the
   * default one's settings would make the archive a label.
   *
   * What is deliberately **not** covered, named so the absence reads as a
   * decision: `workspace-save` (the lifecycle route — gating it would refuse
   * `restore`; it says so at its own definition), `site-verify` (an append-only
   * event, not a preference), and the writes whose subject has no workspace
   * dimension at all — the rule / prompt / policy / competitor-set libraries, and
   * `asin_ownership`, whose table carries no such column by design
   * (`store/schema.js:1456`: whose ASIN it is in a marketplace does not depend on
   * which workspace is looking).
   *
   * A refusal answers 400, not 409: 409 is this file's "well formed, but it needs
   * a person" answer (the approval gates), and an archived workspace needs no
   * person. The `code` rides along so the page branches on it instead of on the
   * sentence — the same shape `workspace-save` already returns for this code.
   */
  function scopeWorkspaceId() {
    /* Through the shared reader, so the page and the three write tools cannot
       come to different conclusions about which workspace the bar is on. */
    return scopeWorkspaceIdOf(workbench)
  }

  ctx.inject(['webServer'], (webCtx) => {
    const logger = webCtx.logger ?? ctx.logger ?? console

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: pagePath,
      handler(req, res) {
        const html = renderWorkbenchPage({
          pagePath,
          /* Only the context is injected. The panels and the nav are both derived
             from MODULE_GROUPS inside the page, so there is no second, injectable
             module list that could disagree with the one the page draws. */
          initialState: { context: workbench.get() },
        })
        /* 传输压缩：只在客户端声明 Accept-Encoding 时才压（测试替身不带这个头，
           所以既有断言拿到的仍是字符串）。实测 744.6 KB → 169.5 KB（brotli）。
           见 src/web/compress.js 顶部的测量与取舍说明。 */
        sendHtml(req, res, html)
      },
    }), 'amazon-ops: workbench page')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: apiPath,
      async handler(req, res) {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const route = pathname === apiPath ? '' : pathname.slice(apiPath.length + 1)
        try {
          if (route === 'state' && req.method === 'GET') {
            /* `buildState` 抛出来的任何东西都**不许**原样进响应：那是一句 TypeError
               （"Cannot read properties of undefined (reading 'id')"），对页面毫无
               意义，还会让客户端把「服务端构建挂了」误读成「库里没数据」。这里兜住：
               结构化错误 + 一行固定文案，完整栈进服务端日志。
               为什么不是 500：本文件对 API 错误的既有约定就是 400 + { ok:false, code }，
               无参 GET 本身没有参数可挑错 —— 真正的修法是让 buildState 不抛（见
               collectionPanel 里 `?? null` 的那一条），这一层只保证**下一次**别的
               构建函数再抛时，页面拿到的仍然是一句结构化的话。 */
            try {
              return sendJson(res, await buildState())
            } catch (error) {
              logger.warn?.(`[amazon-ops] api state build failed: ${error.stack ?? error.message}`)
              return sendJson(res, {
                ok: false,
                code: 'STATE_BUILD_FAILED',
                error: 'state 构建失败，页面保留上一次的数据；完整栈在服务端日志。',
              }, 400)
            }
          }
          if (route === 'context' && req.method === 'POST') {
            const patch = await readJson(req)
            const context = workbench.set(patch, 'page')
            return sendJson(res, { ok: true, context })
          }
          // Include / exclude one imported file from the keyword master rollup.
          // A POST because it writes, and its own route rather than part of
          // `context` because it is not UI state — it changes what the totals
          // are, and the recompute has to happen server-side before the page
          // re-reads them.
          if (route === 'kw-source' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('kw-source', body)
            const id = String(body?.id ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, error: 'id is required' }, 400)
            const row = setImportIncluded(store, id, body?.included !== false)
            if (row === undefined) return sendJson(res, { ok: false, error: `no import with id "${id}"` }, 404)
            const rollup = recomputeMaster(store, { marketplace: row.marketplace })
            workbench.record('kw:source', {
              file: row.file_name, included: row.included === 1, rows: rollup.rows,
            }, 'page')
            done({ ok: true, id: row.id, included: row.included })
            return sendJson(res, { ok: true, id: row.id, included: row.included, masterRows: rollup.rows })
          }
          /* ── 关键词数据源的根目录 ──────────────────────────────────────────
             扫描单独一个 GET，不挂在 `state` 上：它要把目录里每个文件读一遍算
             hash（37 个文件、约 20MB），放进每几秒一次的轮询里是纯浪费。
             页面进到这个模块时取一次，动作之后再取一次。 */
          if (route === 'kw-source-dir' && req.method === 'GET') {
            return sendJson(res, scanSourceDir(store, {}))
          }
          /* 改根目录。空串 = 回到默认（不是"没有目录"）。 */
          if (route === 'kw-source-dir-set' && req.method === 'POST') {
            const body = await readJson(req)
            const next = String(body?.path ?? '').trim()
            if (next !== '' && !existsSync(next)) {
              return sendJson(res, { ok: false, error: `目录不存在：${next}` }, 400)
            }
            /* 审计要在写之前取前值 —— pageWrite 返回的那个函数负责写后落一行。 */
            const done = pageWrite('kw-source-dir-set', body)
            setSetting(store, 'kw.sourceDir', next === '' ? null : next)
            workbench.record('kw:sourcedir', { path: next === '' ? null : next, via: 'typed' }, 'page')
            /* 一个已知子目录都没有时，如实说「这不像关键词数据源目录」——
               但不拦：也许人家正要在这里建结构。猜"你选错了"比不猜更糟。 */
            const looksRight = next === '' ? true : looksLikeSourceRoot(next)
            done({ ok: true, path: next, looksLikeSourceRoot: looksRight })
            return sendJson(res, {
              ok: true,
              looksLikeSourceRoot: looksRight,
              scan: scanSourceDir(store, {}),
            })
          }
          /* 弹系统对话框选目录。取消返回 cancelled，**不改设置** ——
             "取消"和"清空"是两件事。 */
          if (route === 'kw-source-dir-pick' && req.method === 'POST') {
            const body = await readJson(req)
            const current = sourceRoot(store)
            const picked = await pickFolder({ initial: String(body?.initial ?? current.root) })
            if (picked.ok !== true) {
              return sendJson(res, {
                ok: false,
                cancelled: picked.cancelled === true,
                error: picked.error ?? null,
              })
            }
            const pickedDone = pageWrite('kw-source-dir-pick', body)
            setSetting(store, 'kw.sourceDir', picked.path)
            workbench.record('kw:sourcedir', { path: picked.path, via: 'dialog' }, 'page')
            const looksRight = looksLikeSourceRoot(picked.path)
            pickedDone({ ok: true, path: picked.path, looksLikeSourceRoot: looksRight })
            return sendJson(res, {
              ok: true,
              path: picked.path,
              looksLikeSourceRoot: looksRight,
              scan: scanSourceDir(store, {}),
            })
          }
          /* 用资源管理器打开当前根目录（去看，不是去选）。 */
          if (route === 'kw-source-dir-open' && req.method === 'POST') {
            const current = sourceRoot(store)
            const opened = await openInExplorer(current.root)
            return sendJson(res, { ok: opened.ok, error: opened.error ?? null, root: current.root })
          }
          /* 补齐缺失的子目录。只建空目录，不写任何文件。 */
          if (route === 'kw-source-dir-mkdir' && req.method === 'POST') {
            const current = sourceRoot(store)
            const made = createMissingDirs(current.root)
            workbench.record('kw:sourcedir', { path: current.root, created: made.created }, 'page')
            return sendJson(res, {
              ok: made.ok,
              created: made.created,
              error: made.error ?? null,
              scan: scanSourceDir(store, {}),
            })
          }
          /* 整目录导入：按子目录定类型，按内容 hash 幂等（同一个文件再导是 no-op）。
             写事实表 + 重算主库，所以是个写动作。 */
          if (route === 'kw-source-dir-import' && req.method === 'POST') {
            const body = await readJson(req)
            const current = sourceRoot(store)
            const dryRun = body?.dryRun === true
            const done = pageWrite('kw-source-dir-import', body)
            const summary = importDirectory(store, {
              dir: current.root,
              recursive: true,
              dryRun,
              kindFor: filePath => kindForFile(current.root, filePath).kind,
            })
            const rollup = dryRun ? null : recomputeMaster(store, {})
            workbench.record('kw:sourcedir', {
              imported: summary.imported, skipped: summary.skipped, failed: summary.failed, dryRun,
            }, 'page')
            done({ ok: true, found: summary.found, imported: summary.imported, failed: summary.failed, dryRun })
            return sendJson(res, {
              ok: true,
              dryRun,
              summary: {
                found: summary.found,
                imported: summary.imported,
                skipped: summary.skipped,
                failed: summary.failed,
                /* 只回前 50 条：一次 37 个文件已经够长，全回会把响应撑大。 */
                results: summary.results.slice(0, 50).map(row => ({
                  file: row.file, ok: row.ok !== false, kind: row.kind ?? null,
                  period: row.period ?? null, factsWritten: row.factsWritten ?? null,
                  skipped: row.skipped === true, error: row.error ?? null,
                })),
              },
              masterRows: rollup === null ? null : rollup.rows,
              scan: scanSourceDir(store, {}),
            })
          }
          // Enabling / disabling one rule. A POST because it writes, and its own
          // route rather than part of `context` because it is not UI state: it
          // publishes a new rule version, which is what every future run is then
          // judged against (arch §4.3). The page and `amzn_rule_upsert` both call
          // the same `setRuleEnabled`, so the two paths cannot drift.
          if (route === 'rule-toggle' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('rule-toggle', body)
            const ruleId = String(body?.ruleId ?? '').trim()
            if (ruleId === '') return sendJson(res, { ok: false, error: 'ruleId is required' }, 400)
            const enabled = body?.enabled !== false
            const result = setRuleEnabled(store, ruleId, enabled)
            workbench.record('rule:toggle', { ruleId, enabled: result.enabled, version: result.version }, 'page')
            done({ ok: true, ruleId, enabled: result.enabled, version: result.version })
            return sendJson(res, { ok: true, ruleId, enabled: result.enabled, version: result.version })
          }
          // Linking a policy to the rules it affects. A POST for the same reasons
          // as `rule-toggle`: it writes, and it is one fact — "this policy's rule
          // set is now these". `ruleIds` replaces the set, so unlink is the same
          // call with a shorter list. The page and `amzn_policy_link` both call
          // `linkPolicyToRules`, so the two paths cannot drift.
          if (route === 'policy-link' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('policy-link', body)
            const policyId = String(body?.policyId ?? '').trim()
            if (policyId === '') return sendJson(res, { ok: false, error: 'policyId is required' }, 400)
            const result = linkPolicyToRules(store, {
              policyId,
              ruleIds: Array.isArray(body?.ruleIds) ? body.ruleIds : [],
              fields: body?.fields,
            })
            workbench.record('policy:link', {
              policyId, rules: result.ruleIds.length, added: result.added.length, removed: result.removed.length,
            }, 'page')
            done({ ok: true, policyId, ruleIds: result.ruleIds })
            return sendJson(res, {
              ok: true, policyId, ruleIds: result.ruleIds, fields: result.fields,
              added: result.added, removed: result.removed,
            })
          }
          /* S2-T72 —— 政策按钮四步链路：检索 / 确认入库 / 驳回。
             三个 POST 都走 domain/policy/candidate.js 的同一函数，页面与将来的工具面
             不会对「确认」有两种看法。检索失败返回 400 + code=UNAVAILABLE，run 行已
             落库（failed + 原因），所以刷新后失败态仍可见 —— 不回落成「0 条」。 */
          if (route === 'policy-check-start' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('policy-check-start', body)
            const result = await startPolicyCheck(store, {
              query: body?.query,
              marketplace: body?.marketplace,
              limit: body?.limit,
            })
            if (result.ok === false) {
              return sendJson(res, {
                ok: false, code: result.code ?? null, error: result.error, runId: result.runId ?? null,
              }, 400)
            }
            workbench.record('policy:check', {
              runId: result.runId, sources: result.sourceCount,
              candidates: result.candidateCount, diffs: result.diffCount,
            }, 'page')
            done({ ok: true, runId: result.runId, candidateCount: result.candidateCount })
            return sendJson(res, result)
          }
          if (route === 'policy-candidate-confirm' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('policy-candidate-confirm', body)
            const result = await confirmPolicyCandidate(store, {
              candidateId: body?.candidateId,
              ruleIds: Array.isArray(body?.ruleIds) ? body.ruleIds : [],
              reason: body?.reason,
              by: body?.by ?? 'page',
            })
            if (result.ok === false) {
              const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'CONFLICT' ? 409 : 400
              return sendJson(res, result, status)
            }
            workbench.record('policy:candidate-confirm', {
              candidateId: result.candidateId, policyId: result.policyId, rules: result.linksWritten,
            }, 'page')
            done(result)
            return sendJson(res, result)
          }
          if (route === 'policy-candidate-reject' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('policy-candidate-reject', body)
            const result = await rejectPolicyCandidate(store, {
              candidateId: body?.candidateId,
              reason: body?.reason,
              by: body?.by ?? 'page',
            })
            if (result.ok === false) {
              const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'CONFLICT' ? 409 : 400
              return sendJson(res, result, status)
            }
            workbench.record('policy:candidate-reject', { candidateId: result.candidateId }, 'page')
            done(result)
            return sendJson(res, result)
          }
          /**
           * F14-01 — 生成一份报告（八类里的一个）并登记。
           *
           * 走路由而不是让页面自己拼文档：正文的构建器在 `domain/reports/build.js`，
           * 它调各自模块**既有**的 builder。页面另写一遍就是把同一套判据抄第二份。
           *
           * 与 `amzn_report_build` 是同一个函数 —— 两条入口不能对「一份报告长什么样」
           * 有两种看法。
           */
          if (route === 'report-build' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('report-build', body)
            const built = buildReport(store, {
              kind: body?.kind,
              asin: body?.asin ?? null,
              marketplace: body?.marketplace ?? null,
              productLine: body?.productLine ?? null,
              precheckFor,
            })
            if (built.ok === false) {
              return sendJson(res, { ok: false, error: built.error, code: built.code ?? null, hint: built.hint ?? null }, 400)
            }
            const row = recordReport(store, {
              id: body?.reportId ? String(body.reportId).trim() : built.reportId,
              kind: built.kind,
              title: built.title,
              scope: built.scope,
              body: built.body,
              createdAt: built.now,
              createdBy: 'page',
            })
            workbench.record('report:build', {
              kind: row.kind, id: row.id, chars: built.body.length,
            }, 'page')
            done({ ok: true, report: row })
            return sendJson(res, {
              ok: true,
              report: row,
              /* The body goes back with the reply so the page can show it without a
                 second round trip; the list slice does not carry bodies. */
              body: built.body,
            })
          }

          /**
           * F14-01 — 收藏 / 标签 / 归档。
           *
           * 三个动作一个路由，因为它们改的是同一行的同一类东西（「这一份在我的工作集里
           * 怎么找」）。归档**不是删除**：2026-10-13 对 ASIN 归档的裁决同样适用于报告 ——
           * 归档的行照样列出来、逐行标「已归档」，只有 `status=archived` 才只看归档的。
           */
          if (route === 'report-update' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('report-update', body)
            const id = String(body?.id ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, error: 'id is required' }, 400)
            let row = null
            if (body?.favorite !== undefined) {
              row = setReportFavorite(store, id, body.favorite === true)
              if (row === null) return sendJson(res, { ok: false, error: `no report ${id}` }, 404)
            }
            if (body?.tags !== undefined) {
              if (!Array.isArray(body.tags)) return sendJson(res, { ok: false, error: 'tags must be an array of strings' }, 400)
              row = setReportTags(store, id, body.tags)
              if (row === null) return sendJson(res, { ok: false, error: `no report ${id}` }, 404)
            }
            if (body?.archived !== undefined) {
              row = setReportArchived(store, id, body.archived === true, {
                by: body?.by ?? 'page',
                reason: body?.archiveReason ?? null,
              })
              if (row === null) return sendJson(res, { ok: false, error: `no report ${id}` }, 404)
            }
            if (row === null) {
              return sendJson(res, { ok: false, error: 'nothing to change: give favorite, tags or archived' }, 400)
            }
            workbench.record('report:update', {
              id: row.id, favorite: row.favorite, archived: row.archivedAt !== null,
            }, 'page')
            done({ ok: true, report: row })
            return sendJson(res, { ok: true, report: row })
          }

          // Saving one prompt from the editor. A POST for the same reasons as
          // `rule-toggle`: it writes, and it is one fact — "this prompt is now
          // this". The page and `amzn_prompt_upsert` both call `upsertPrompt`, so
          // the two paths cannot drift about what a valid prompt is.
          if (route === 'prompt-save' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('prompt-save', body)
            const row = upsertPrompt(store, {
              id: body?.id,
              module: body?.module,
              scenario: body?.scenario,
              layer: body?.layer,
              label: body?.label,
              body: body?.body,
              enabled: body?.enabled,
            })
            workbench.record('prompt:save', {
              id: row.id, module: row.module, scenario: row.scenario, version: row.version, created: row.created,
            }, 'page')
            done({ ok: true, prompt: row, created: row.created })
            return sendJson(res, { ok: true, prompt: row, created: row.created })
          }
          // Rolling one prompt back to a frozen version. A POST for the same
          // reasons as `prompt-save`: it writes, and it is one fact — "this
          // prompt's body is now the one that was frozen". `rollbackPrompt`
          // freezes the pre-rollback body first, so the edit counter goes up and
          // nothing is erased; the tool and this route are the same fact.
          if (route === 'prompt-rollback' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('prompt-rollback', body)
            const row = rollbackPrompt(store, { id: body?.id, snapshotId: body?.snapshotId })
            workbench.record('prompt:rollback', {
              id: row.id, restoredVersion: row.restoredVersion, version: row.version,
            }, 'page')
            done({ ok: true, prompt: row, restoredVersion: row.restoredVersion })
            return sendJson(res, { ok: true, prompt: row, restoredVersion: row.restoredVersion })
          }
          // B-11.3 / F11-05 — the lifecycle, three writes. Each POST is one fact and
          // calls exactly the store function its tool calls, so the page cannot walk
          // a prompt along a path the tool would refuse. `prompt-lifecycle` is one
          // step (review / testing / deprecated…), and its action is the same string
          // as `amzn_prompt_lifecycle_transition`'s.
          if (route === 'prompt-lifecycle' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('prompt-lifecycle', body)
            const row = getPrompt(store, body?.id)
            if (row === null) {
              return sendJson(res, { ok: false, error: `no prompt ${body?.id}` }, 404)
            }
            const moved = recordPromptLifecycle(store, {
              id: body?.id,
              version: body?.version === undefined ? row.version : body?.version,
              to: body?.to,
              by: 'page',
              note: body?.note ?? null,
            })
            workbench.record('prompt:lifecycle', {
              id: moved.id, version: moved.version, from: moved.from, to: moved.status,
            }, 'page')
            done({ ok: true, lifecycle: promptLifecycleView(store, moved.id) })
            return sendJson(res, { ok: true, lifecycle: promptLifecycleView(store, moved.id) })
          }
          // Putting the current version into production — its own route and its own
          // action, because 「谁把这一版放进了生产」 is the question the audit has to
          // be able to answer.
          if (route === 'prompt-version-activate' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('prompt-version-activate', body)
            const row = getPrompt(store, body?.id)
            if (row === null) {
              return sendJson(res, { ok: false, error: `no prompt ${body?.id}` }, 404)
            }
            const moved = activatePromptVersion(store, { id: body?.id, by: 'page', note: body?.note ?? null })
            workbench.record('prompt:activate', {
              id: moved.id, version: moved.version, from: moved.from,
            }, 'page')
            done({ ok: true, lifecycle: promptLifecycleView(store, moved.id) })
            return sendJson(res, { ok: true, lifecycle: promptLifecycleView(store, moved.id) })
          }
          // Rolling production back to the previous active version. NOT
          // `prompt-rollback`: that one swaps the body; this one moves which version
          // is in production and writes no body at all.
          if (route === 'prompt-version-rollback' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('prompt-version-rollback', body)
            const row = getPrompt(store, body?.id)
            if (row === null) {
              return sendJson(res, { ok: false, error: `no prompt ${body?.id}` }, 404)
            }
            const moved = rollbackPromptVersion(store, { id: body?.id, by: 'page', note: body?.note ?? null })
            workbench.record('prompt:version-rollback', {
              id: moved.id, from: moved.rolledBackFrom, to: moved.rolledBackTo,
            }, 'page')
            done({ ok: true, lifecycle: promptLifecycleView(store, moved.id) })
            return sendJson(res, { ok: true, lifecycle: promptLifecycleView(store, moved.id) })
          }
          // Creating or editing one competitor set from the page's table. A POST
          // for the same reasons as `rule-toggle`: it writes, and it is one fact —
          // "this set is now these ASINs". The page and
          // `amzn_competitor_set_upsert` both call `upsertCompetitorSet`, so the
          // two paths cannot drift about what a valid set is.
          if (route === 'competitor-set' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('competitor-set', body)
            const result = upsertCompetitorSet(store, {
              id: body?.id,
              name: body?.name,
              marketplace: body?.marketplace,
              asins: body?.asins,
              note: body?.note,
            })
            workbench.record('competitor:set', {
              id: result.id, name: result.name, marketplace: result.marketplace, asins: result.asins.length,
            }, 'page')
            done({ ok: true, set: result })
            return sendJson(res, { ok: true, set: result })
          }
          /* 打开产品表目录：只开资源管理器，不扫描、不写库、不删任何东西。 */
          if (route === 'product-open-dir' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('product-open-dir', body)
            const resolved = resolveProductDir(store, { dataDir: dataDir ?? process.cwd() })
            if (!existsSync(resolved.dir)) {
              return sendJson(res, { ok: false, code: 'NO_DIR', error: `目录不存在：${resolved.dir}` }, 400)
            }
            execFile('explorer.exe', [resolved.dir], () => { /* 打开失败不影响页面 */ })
            done({ ok: true })
            return sendJson(res, { ok: true, dir: resolved.dir })
          }
          /* 产品表导入（赛狐）：scan / preview 是读，commit 才写。
             只有 commit 记审计 —— 扫目录不该留痕。 */
          if (route === 'product-import' && req.method === 'POST') {
            const body = await readJson(req)
            /* 归档 workspace 是只读：products 的 scan / preview / commit 都是
               「往这个店铺的产品档案里导入」的一部分，不能只挡 commit。目标店铺
               可能属于另一个 workspace（页面按 shopId 指定），所以目标 workspace
               与当前 scope 都要检查 —— 和 shop-save / source-save 同一守卫。 */
            const targetShop = body?.shopId ? getShop(store, body.shopId) : null
            const targetWorkspace = targetShop?.workspace_id ?? scopeWorkspaceId()
            const refusal = workspaceWriteRefusal(store, targetWorkspace, scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)
            const done = pageWrite('product-import', body)
            const action = String(body?.action ?? 'scan')
            const resolved = resolveProductDir(store, { dataDir: dataDir ?? process.cwd() })

            if (action === 'scan') {
              return sendJson(res, { ok: true, ...resolved, ...scanProductDir(resolved.dir) })
            }
            if (action === 'list') {
              return sendJson(res, { ok: true, rows: listProfiles(store, { limit: body?.limit ?? 200 }) })
            }
            let path = body?.path ? String(body.path) : null
            if (path === null) {
              const scanned = scanProductDir(resolved.dir)
              if (scanned.files.length === 0) {
                return sendJson(res, { ok: false, code: 'NO_FILES', error: `目录里没有表格：${scanned.dir}` }, 400)
              }
              path = scanned.files[0].path
            }
            let parsed
            try {
              parsed = readProductRows(readFileSync(path))
            } catch (error) {
              return sendJson(res, { ok: false, code: 'PARSE_FAILED', error: error.message }, 400)
            }
            const recommend = recommendBrand(store, parsed.rows)
            const brand = String(body?.brand ?? '').trim()
            if (action === 'preview') {
              /* S1：店铺自动创建还没闭环（commitProductPlan 不插 shop 行，product_profile.shop_id
                 有 FK），所以这里不启用 —— autoCreateShop 参数与 shopIdFor 保留给下一迭代。
                 `shopId` 必须生效：店铺详情导入只写当前店，行里写了别的店进待补清单。 */
              const plan = buildProductPlan(store, {
                rows: parsed.rows,
                brand: brand === '' ? recommend.brand : brand,
                shopId: body?.shopId ?? null,
              })
              return sendJson(res, { ok: true, path, plan, recommend })
            }
            if (action === 'commit') {
              if (brand === '') {
                return sendJson(res, { ok: false, code: 'BRAND_REQUIRED', error: '品牌必填 —— 这一批的品牌要人选' }, 400)
              }
              const plan = buildProductPlan(store, {
                rows: parsed.rows,
                brand,
                shopId: body?.shopId ?? null,
              })
              const result = commitProductPlan(store, { plan, path, fingerprint: fingerprintOf(readFileSync(path)) })
              workbench.record('product:import', { path, brand, written: result.written }, 'page')
              done({ ok: true, ...result })
              return sendJson(res, { ok: true, ...result })
            }
            return sendJson(res, { ok: false, code: 'BAD_ACTION', error: action }, 400)
          }
          /* 停用一条竞品关系：标记 inactive，不删 —— 「它上次排第几」是历史。 */
          if (route === 'competitor-retire' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('competitor-retire', body)
            const retired = retireCompetitor(store, {
              marketplace: String(body?.marketplace ?? 'US').toUpperCase(),
              parentAsin: body?.parentAsin,
              competitorAsin: body?.competitorAsin,
              scope: body?.scope ?? 'family',
              scopeAsin: body?.scopeAsin ?? '',
              reason: body?.reason ?? null,
            })
            done({ ok: retired })
            return sendJson(res, { ok: retired })
          }
          /* 自动发现竞品：suggest 把候选写成 suggested，adopt 才转 active。
             两条都在一个路由里，因为它们只差最后一步「写不写成人定的」——
             分成两个路由会让「预览」和「采纳」有机会用不同的判定。 */
          if (route === 'competitor-discover' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('competitor-discover', body)
            const market = String(body?.marketplace ?? 'US').toUpperCase()
            const parent = String(body?.asin ?? '').toUpperCase()
            if (parent === '') {
              done({ ok: false, code: 'BAD_REQUEST', error: 'asin is required' })
              return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }, 400)
            }
            if (body?.action === 'adopt') {
              const adopted = []
              for (const code of Array.isArray(body?.competitors) ? body.competitors : []) {
                if (adoptCompetitor(store, { marketplace: market, parentAsin: parent, competitorAsin: code })) {
                  adopted.push(String(code).toUpperCase())
                }
              }
              workbench.record('competitor:adopt', { asin: parent, marketplace: market, adopted: adopted.length }, 'page')
              done({ ok: true, adopted })
              return sendJson(res, { ok: true, adopted })
            }
            /* 默认：suggest。写 suggested，不写 active —— 机器猜的不算竞品。 */
            const found = discoverCompetitors(store, {
              marketplace: market, ourAsin: parent, limit: body?.limit ?? 10,
            })
            const written = []
            for (const candidate of found.candidates) {
              upsertCompetitor(store, {
                marketplace: market,
                parentAsin: parent,
                competitorAsin: candidate.competitorAsin,
                source: 'auto:library',
                rankSeen: candidate.bestRank,
                status: 'suggested',
                note: candidate.evidence,
              })
              written.push(candidate.competitorAsin)
            }
            workbench.record('competitor:discover', { asin: parent, marketplace: market, candidates: found.candidates.length }, 'page')
            done({ ok: true, written })
            return sendJson(res, { ok: true, written, candidates: found.candidates })
          }

          // Previewing a render before saving it. A POST because the body can be
          // long, and its own route rather than part of `state` because it is a
          // request for one answer, not a slice of state. The same `previewPrompt`
          // the tool calls, so a template that fails here fails there too.
          if (route === 'prompt-preview' && req.method === 'POST') {
            const body = await readJson(req)
            const result = previewPrompt(store, {
              id: body?.id,
              body: body?.body,
              variables: body?.variables,
            })
            return sendJson(res, {
              ok: true,
              text: result.text,
              variables: result.variables,
              /* §7.1：预览要展示「变量来源和缺失项」。同一份报告既给文本也给页面。 */
              missing_required: result.missing_required,
              dropped_optional: result.dropped_optional,
              degraded: result.degraded,
              reason: result.reason,
            })
          }
          /* Saving one setting from the settings page. A POST for the same reasons
             as `rule-toggle`: it writes, and it is one fact — "this setting is now
             this". The page and `amzn_setting_set` both call `setSetting`, so the
             two paths cannot drift about what a legal value is; the validation
             (by name, with range bounds) lives at the store, not in two places.
             Clearing a `marketplace.<CODE>.postalCode` row deletes it, so "unset"
             goes back to the collection site's own code rather than to an empty
             string the storefront dialog would reject. */
          if (route === 'setting-set' && req.method === 'POST') {
            const body = await readJson(req)
            const key = String(body?.key ?? '').trim()
            if (key === '') return sendJson(res, { ok: false, error: 'key is required' }, 400)
            /* `setSetting` writes ON CONFLICT(key) and never touches `workspace_id`,
               so the row keeps the workspace it already belongs to — NULL, which
               v20 defines as the default. Resolved from the row, not assumed. */
            const refusal = workspaceWriteRefusal(store,
              store.get('SELECT workspace_id FROM setting WHERE key = ?', [key])?.workspace_id,
              scopeWorkspaceId(),
            )
            if (refusal !== null) return sendJson(res, refusal, 400)
            const done = pageWrite('setting-set', body)

            const before = getSetting(store, key)
            let stored
            try {
              const approval = approvalFor(key)
              if (approval !== null) {
                /* An approval toggle goes through the policy, which is where
                   「只能收紧不能放宽」 lives. It writes with `setSetting` itself,
                   so this is still one write path and one audit action. */
                const result = setApproval(store, approval.id, body?.value)
                if (result.ok !== true) return sendJson(res, { ok: false, code: result.code, error: result.error }, 400)
                stored = result.value
              } else if (body?.value === null && /^marketplace\.[A-Z]{2}\.postalCode$/.test(key)) {
                deleteSetting(store, key)
                stored = getSetting(store, key)
              } else {
                stored = setSetting(store, key, body?.value, body?.note ?? null)
              }
            } catch (error) {
              /* The store's own message names the key and the reason; passing it
                 through is what lets the page say "pacing.taskIntervalSec must be
                 >= 1" instead of "400 Bad Request". */
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
            workbench.record('setting:set', { key, before, after: stored }, 'page')
            done({ ok: true, key, before, value: stored })
            return sendJson(res, { ok: true, key, before, value: stored })
          }
          /* Writing a source's credential. A POST for the same reasons as
             `rule-toggle`, and its own route rather than part of `setting-set`
             because the two write different tables for different reasons: a
             credential belongs to the source that uses it. The reply is redacted
             — field names, never values — and so is the recorded event, because
             an event is read by a page and copied into conversations. */
          if (route === 'source-save' && req.method === 'POST') {
            const body = await readJson(req)
            const id = String(body?.id ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, error: 'id is required' }, 400)
            const row = store.get('SELECT * FROM source WHERE id = ?', [id])
            if (row === null || row === undefined) {
              return sendJson(res, { ok: false, error: `no source with id "${id}"` }, 404)
            }
            /* 归档即只读. The UPDATE below never writes `workspace_id`, so the row
               keeps the space it already belongs to — read from the row, never
               assumed from the body. The scope bar's space is checked too: a
               page parked in an archived workspace must not be able to edit the
               default one's credentials. */
            const refusal = workspaceWriteRefusal(store, row.workspace_id, scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)
            const done = pageWrite('source-save', body)

            const sets = []
            const params = []
            const put = (column, value) => { sets.push(`${column} = ?`); params.push(value) }
            if (body?.name !== undefined) {
              const name = String(body.name).trim()
              if (name === '') return sendJson(res, { ok: false, error: 'name 不能为空' }, 400)
              put('name', name)
            }
            if (body?.enabled !== undefined) put('enabled', body.enabled === true ? 1 : 0)
            if (body?.notes !== undefined) put('notes', body.notes === null ? null : String(body.notes))

            const removed = []
            if (body?.config !== undefined && body.config !== null) {
              if (typeof body.config !== 'object' || Array.isArray(body.config)) {
                return sendJson(res, { ok: false, error: 'config 必须是对象' }, 400)
              }
              let current = {}
              try {
                current = row.config_json ? JSON.parse(row.config_json) : {}
              } catch {
                current = {}
              }
              for (const [field, value] of Object.entries(body.config)) {
                if (value === null || String(value).trim() === '') { delete current[field]; removed.push(field); continue }
                current[field] = String(value)
              }
              put('config_json', Object.keys(current).length === 0 ? null : JSON.stringify(current))
            }

            if (sets.length === 0) return sendJson(res, { ok: false, error: '没有任何要改的字段' }, 400)
            params.push(id)
            store.run(`UPDATE source SET ${sets.join(', ')} WHERE id = ?`, params)

            const after = store.get('SELECT * FROM source WHERE id = ?', [id])
            let configKeys = []
            try {
              configKeys = Object.keys(after.config_json ? JSON.parse(after.config_json) : {})
            } catch {
              configKeys = []
            }
            workbench.record('source:save', {
              id, enabled: after.enabled === 1, configKeys, removed,
            }, 'page')
            done({ ok: true, id, enabled: after.enabled === 1 })
            return sendJson(res, { ok: true, id, enabled: after.enabled === 1, configKeys, removed })
          }
          /* Writing a product line. Its own route for the same reason
             `source-save` is: it writes a different table, and it calls the same
             `upsertProductLine` the tool does, so the page and
             `amzn_product_line_upsert` cannot disagree about what a legal line is.

             `signals` carries three states and the page sends them explicitly —
             a list to override, `null` to reset to the built-in, `[]` to match
             nothing. The store is what validates the shape, and its message is
             passed through, so a bad body says which field was wrong instead of
             "400 Bad Request". */
          /* R-91（需求方指定）：字段模板的四个页面写路径。
             「更新字段模板」这一颗按钮**不自己产生字段** —— 它把「请研究会话产出提案」这件事记下来
             （写一版 proposed，内容与现役相同、带 research.requested 标记），AI 会话随后用
             amzn_field_template_propose 覆盖成真正的提案，人再点「确认提案」。
             这样按钮不会假装它搜过网 —— 它只负责发起，不负责编。 */
          /* R-95：属性补齐的两条页面入口。判定与写库都在 domain/asin/attributes.js，
             与 amzn_asin_attribute_status / _set 是**同一对函数** —— 页面不内联重算，
             于是「工具能做的」和「页面能做的」不可能长出两套规矩。 */
          if (route === 'asin-attributes' && req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://x').searchParams
            const result = attributeStatus(store, {
              asin: query.get('asin'),
              marketplace: query.get('marketplace') ?? 'US',
            })
            return sendJson(res, result, result.ok === false ? 400 : 200)
          }
          if (route === 'asin-attribute-save' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('asin-attribute-save', body)
            const result = saveAttributes(store, {
              asin: body?.asin,
              marketplace: body?.marketplace ?? 'US',
              values: body?.values,
              note: body?.note,
              by: body?.by ?? 'page',
            })
            done(result)
            return sendJson(res, result, result.ok === false ? 400 : 200)
          }
          /* R-91：字段模板的读接口 —— 面板那三颗按钮要知道「现在第几版、有没有待确认的提案」。 */
          if (route === 'field-template' && req.method === 'GET') {
            const active = getTemplateVersion(store, { status: 'active' })
            const proposed = getTemplateVersion(store, { status: 'proposed' })
            return sendJson(res, {
              ok: true,
              active: active === null ? null : {
                version: active.version,
                fields: active.items.length,
                required: active.items.filter(item => item.required).length,
                confirmedAt: active.confirmedAt,
                /* R-93：面板要能**逐行改**模板（需求方：可编辑、可增加、可删减字段），
                   所以读接口必须把整张字段表交出去 —— 只给「几个字段」的计数，页面就只能看不能改。 */
                items: active.items,
              },
              proposed: proposed === null ? null : {
                version: proposed.version,
                fields: proposed.items.length,
                diff: proposed.diff === null ? null : proposed.diff.summary,
                research: proposed.research,
                createdAt: proposed.createdAt,
              },
            })
          }
          if (route === 'field-template-research' && req.method === 'POST') {
            const body = await readJson(req)
            const active = getTemplateVersion(store, { status: 'active' })
            if (active === null) return sendJson(res, { ok: false, error: '模板还不存在' }, 400)
            const done = pageWrite('field-template-research', body)
            const result = saveTemplateVersion(store, {
              items: active.items,
              status: 'proposed',
              by: 'page',
              note: '页面点「更新字段模板」：等 AI 会话产出',
              research: {
                requested: true,
                at: nowIso(),
                by: 'page',
                query: body?.query === undefined || body?.query === null ? null : String(body.query),
              },
            })
            return sendJson(res, {
              ok: true,
              version: result.version.version,
              text: `已提交研究请求（提案 v${result.version.version}）。让 AI 会话搜索并产出字段清单后，'
                + '这一版会被换成真正的提案；人点「确认提案」才生效。`,
              ...(done === null || done === undefined ? {} : { audit: done }),
            })
          }

          if (route === 'field-template-confirm' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('field-template-confirm', body)
            try {
              const row = confirmTemplateVersion(store, {
                version: Number(body?.version),
                by: 'page',
                note: '页面确认',
              })
              return sendJson(res, { ok: true, version: row.version, text: `模板 v${row.version} 已生效（字段 ${row.items.length} 个）`, audit: done })
            } catch (error) {
              return sendJson(res, { ok: false, error: String(error && error.message ? error.message : error) }, 400)
            }
          }

          if (route === 'field-template-rollback' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('field-template-rollback', body)
            try {
              const result = rollbackTemplate(store, { by: 'page', note: '页面回滚' })
              return sendJson(res, {
                ok: true,
                version: result.version.version,
                text: `已回滚：v${result.rolledBackFrom} → 内容取自 v${result.rolledBackTo}，另起 v${result.version.version}`,
                audit: done,
              })
            } catch (error) {
              return sendJson(res, { ok: false, error: String(error && error.message ? error.message : error) }, 400)
            }
          }

          if (route === 'field-template-save' && req.method === 'POST') {
            const body = await readJson(req)
            const items = Array.isArray(body?.items) ? body.items : []
            if (items.length === 0) return sendJson(res, { ok: false, error: 'items is required' }, 400)
            const done = pageWrite('field-template-save', body)
            try {
              const result = saveTemplateVersion(store, {
                items, status: 'active', by: 'page', note: body?.note ?? '页面编辑',
              })
              return sendJson(res, { ok: true, version: result.version.version, text: `模板 v${result.version.version} 已生效（字段 ${result.version.items.length} 个）`, audit: done })
            } catch (error) {
              return sendJson(res, { ok: false, error: String(error && error.message ? error.message : error) }, 400)
            }
          }
          if (route === 'product-line-save' && req.method === 'POST') {
            const body = await readJson(req)
            const id = String(body?.id ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, error: 'id is required' }, 400)

            /* An omitted `name` keeps the stored one, so the page can save a
               signals edit without echoing the name back and risking a stale
               overwrite. A new line has no stored name, so it must supply one —
               and the store, not this handler, is what says so.
               The row's `workspace_id` is read here for the same reason it is
               read for the name: `upsertProductLine` neither inserts nor updates
               that column, so an existing line keeps its space and a new one is
               inserted with NULL, which v20 defines as the default. */
            const existing = store.get('SELECT name, workspace_id FROM product_line WHERE id = ?', [id])
            const refusal = workspaceWriteRefusal(store, existing?.workspace_id, scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)
            const done = pageWrite('product-line-save', body)
            const name = body?.name === undefined
              ? String(existing?.name ?? '').trim()
              : String(body.name).trim()

            let result
            try {
              result = upsertProductLine(store, {
                id,
                name,
                note: body?.note === undefined ? undefined : (body.note === null ? null : String(body.note)),
                signals: body?.signals,
                changedBy: 'local',
              })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }

            const row = store.get('SELECT id, name, note, signals_json, version FROM product_line WHERE id = ?', [id])
            const read = readSignalCategories(row.signals_json, row.id)
            /* The event carries the mode, not the word list: a workbench event is
               read by a page and copied into conversations, and the signals are
               the line's whole configuration. */
            workbench.record('product-line:save', {
              id, created: result.created, mode: read.mode, version: result.version,
            }, 'page')
            done({ ok: true, id, created: result.created })
            return sendJson(res, {
              ok: true,
              id,
              created: result.created,
              mode: read.mode,
              signals: read.mode === 'broken' ? null : read.signals.core,
              categories: read.mode === 'broken' ? null : read.signals,
              /* The version and the impact come from the store, which computed
                 them with the same function `product-line-preview` calls — so
                 "the preview said 214" and "the save says 214" are one call. */
              version: result.version,
              impact: result.impact,
            })
          }

          /* Previewing a signals edit. Its own route because it **reads**: it
             must not bump a version, and a POST that shares the save route would
             be one boolean away from writing by accident. Same
             `classifyWithSignals` as the save, so the two numbers cannot drift. */
          if (route === 'product-line-preview' && req.method === 'POST') {
            const body = await readJson(req)
            const id = String(body?.id ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, error: 'id is required' }, 400)
            try {
              return sendJson(res, { ok: true, preview: previewSignalImpact(store, { productLineId: id, signals: body?.signals }) })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }
          /* Creating / renaming / archiving a workspace, and promoting one to
             default. Its own route for the same reason `product-line-save` is:
             it writes a different table, and it calls the same
             `store/workspace.js` functions `amzn_workspace_upsert` calls, so the
             page and the agent cannot come to different conclusions about what a
             legal workspace name is. The store's refusals carry a machine code
             (WORKSPACE_ARCHIVED / WORKSPACE_NOT_FOUND) and it is passed through
             so the page can say why rather than "400 Bad Request".

             **Deliberately not behind `workspaceWriteRefusal`**, unlike every
             other configuration route: this is the workspace's own lifecycle —
             archive *and restore*. Gating it would refuse `restore`, and a space
             that can be archived but not restored is a delete wearing archive's
             name, which is exactly what `archiveWorkspace(store, id, false)`
             exists to prevent. The archived state it must protect is already
             enforced inside `setDefaultWorkspace`, which refuses an archived
             workspace as the default. */
          if (route === 'workspace-save' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('workspace-save', body)
            const action = String(body?.action ?? '').trim()
            const id = String(body?.id ?? '').trim()

            /* S1-B17.1 归档闸门. Only on the archive edge — restore is the
               opposite act and gating it would rename this gate 「工作空间生命
               周期」. 409 rather than 400: the request is well formed, the move
               is what needs a person. The funnel's recorder is not called, so a
               refusal leaves no audit row (the same rule a failed write lives
               by). */
            if (action === 'archive') {
              const refusal = approvalRefusal(store, 'archive', body?.confirm,
                `要归档的工作空间：${id}。归档后它是只读的，列表里仍然在、也能恢复。确认无误就带 confirm: true 再提交一次。`)
              if (refusal !== null) return sendJson(res, refusal, 409)
            }

            try {
              let row
              if (action === 'create') {
                row = createWorkspace(store, { id: id === '' ? undefined : id, name: body?.name, note: body?.note })
              } else if (action === 'rename') {
                row = renameWorkspace(store, id, body?.name)
              } else if (action === 'archive') {
                row = archiveWorkspace(store, id, true)
              } else if (action === 'restore') {
                row = archiveWorkspace(store, id, false)
              } else if (action === 'set_default') {
                row = setDefaultWorkspace(store, id)
              } else {
                return sendJson(res, {
                  ok: false,
                  error: `action must be one of: create | rename | archive | restore | set_default (got ${JSON.stringify(body?.action)})`,
                }, 400)
              }
              workbench.record('workspace:save', { action, id: row.id }, 'page')
              done({ ok: true, action, workspace: workspaceView(row) })
              return sendJson(res, { ok: true, action, workspace: workspaceView(row) })
            } catch (error) {
              return sendJson(res, {
                ok: false,
                error: error.message,
                ...(error.code === undefined ? {} : { code: error.code }),
              }, 400)
            }
          }

          /* 模块 12 的门禁裁决。一次真实写入：批准写一条 accepted 的 gate-decision
             产物，运行若停在 waiting_human 就回到 running；驳回写 rejected 并让运行
             继续等着。裁决走**同一个**工具而不是在路由里重写一遍判断 —— 页面和会话
             对同一个门禁只能有一个答案。 */
          if (route === 'agent-gate' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('agent-gate', body)
            const runId = String(body?.runId ?? '').trim()
            const gate = String(body?.gate ?? '').trim()
            try {
              const output = await agentGateDecideTool({ store }).execute({
                runId, gate, approve: body?.approve === true, note: body?.note ?? null, by: 'page',
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('agent:gate', { runId, gate }, 'page')
              done({ ok: true, runId, gate })
              return sendJson(res, { ok: true, runId, gate, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* 模块 12 的草案级裁决（§11 接受 / 驳回）。一次真实写入：把一条 `draft` 产物
             定成 accepted 或 rejected，并追加一条 `artifact-decision` 产物（谁 / 为什么 /
             何时）—— 被裁决产物的正文不动。裁决走**同一个**工具而不是在路由里重写一遍
             判断（理由同上面 agent-gate）：页面和会话对同一条草案只能有一个答案，而且
             「存产物只能写 draft、草案只能由人推走」这条规则也在那个工具里。拒绝是一个
             `{ok:false}`，此时 `done` 不调用 —— 拒绝不是一次改动，审计里不留行。 */
          if (route === 'agent-artifact' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('agent-artifact', body)
            const artifactId = String(body?.artifactId ?? '').trim()
            try {
              /* `accept` is passed through **raw** on purpose. The tool is the single
                 judge (`typeof args?.accept !== 'boolean'`), and it can only judge what
                 it is given: `body?.accept === true` would launder a **missing** field
                 (and the string "true") into `false` — a real rejection — before the
                 guard ever saw it. That is 「把缺失渲染成真实值」, the B-11.1 shape. A
                 route must not re-implement the judgement; here it must simply stop
                 laundering the input.
                 `by` is deliberately **not** read from the body: the page path records
                 the actor as `page`. Silently dropping a caller-supplied field is itself
                 worth stating, so it is stated here. */
              /* `body`（产物正文）也**原样**透传，理由与 `accept` 完全相同：
                 `body?.body ?? null` 会把「**没传**」洗成「**传了 null**」，而这两者
                 在 `amendAndAcceptArtifact` 里**行为相反** —— 没传是「没有改动，拒绝」，
                 null 是「人把正文清空，是一次真实的修改」。一个 `??` 就能把拒绝变成接受，
                 这正是 B-11.1 那个形状。 */
              const output = await agentArtifactDecideTool({ store }).execute({
                artifactId, accept: body?.accept, note: body?.note ?? null, by: 'page',
                body: body?.body,
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('agent:artifact', { artifactId }, 'page')
              done({ ok: true, artifactId })
              return sendJson(res, { ok: true, artifactId, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* 模块 12 F12-06 / F12-09 的运行入口：**取消**与**修复后继续**。
             两条都只做一次状态移动，判断在 `setRunStatus`（状态机）里 —— 所以这里
             走**同一个工具** `amzn_agent_run_finish`，页面点一次和会话调一次对同一条
             运行只能有一个答案（与上面 agent-gate / agent-artifact 同一条规矩）。
             ⚠️ `retry` 要求一条理由：§9 说 blocked 状态下「重试」改为「修复后重试」、
             修复完成前禁用，而本插件**检测不到**「修好了没有」（契约 §6.2）—— 所以
             由人确认，而一条没有理由的确认正是 §11 禁掉的「需要确认」形状。 */
          if (route === 'agent-run' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('agent-run', body)
            const runId = String(body?.runId ?? '').trim()
            const action = String(body?.action ?? '').trim()
            const targetStatus = { cancel: 'cancelled', retry: 'running' }[action]
            if (targetStatus === undefined) {
              return sendJson(res, {
                ok: false,
                error: `action must be one of: cancel | retry (got ${JSON.stringify(body?.action)})`,
                hint: '取消 → cancelled；修复后继续 → running（只有 blocked 与 waiting_human 有这条边）。',
              }, 400)
            }
            const reason = String(body?.reason ?? '').trim()
            if (action === 'retry' && reason === '') {
              return sendJson(res, {
                ok: false,
                error: 'reason is required for retry — 修复后重试是一次人工断言，必须说清修了什么',
                hint: '§9 的「修复后重试」在本插件里检测不到「修好了没有」，所以由人确认；'
                  + '一条没有理由的确认与「需要确认」是同一种话（§11）。',
              }, 400)
            }
            try {
              const output = await agentRunFinishTool({ store }).execute({ runId, status: targetStatus })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('agent:run', { runId, action }, 'page')
              done({ ok: true, runId, action })
              return sendJson(res, { ok: true, runId, action, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* 模块 12 F12-09 的**取代重开**：§12「上下文变化：创建新运行，不修改旧运行」。
             所以这条路只**新建**，一个字节都不动旧运行（它连状态都不变）。

             这里直接调 `startRun` 而不经过 `amzn_agent_run_start` 工具，理由是那个工具
             返回的是**渲染文本**（既有测试依赖这一点），拿不到新运行的 id 做审计的
             `objectId`。判断没有分叉：角色可用性、配置版本冻结、取代指针的存在性
             **全在 `startRun` 里**（工具只是把它的结果画成一段话）。`workspace-save`
             路由直接调 `createWorkspace` 是同一个做法。

             人工约束与输出格式**沿用旧运行**：页面上的「重开」是「同一件事再跑一遍」，
             静默丢掉人给过的约束比继承它更糟。返回文本里说明这一点，用户可以自己再开
             一次改掉。 */
          if (route === 'agent-run-supersede' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('agent-run-supersede', body)
            const runId = String(body?.runId ?? '').trim()
            const previous = getAgentRun(store, runId)
            if (previous === null) {
              return sendJson(res, { ok: false, error: `no agent run ${runId}` }, 400)
            }
            try {
              const created = startAgentRun(store, {
                role: previous.role,
                goal: previous.goal,
                scope: previous.scope,
                trigger: 'page',
                humanConstraint: previous.humanConstraint,
                outputFormat: previous.outputFormat,
                supersedesRunId: previous.id,
                /* F12-04：任务类型同样**沿用**。上面的注释已经说了理由 —— 重开是
                   「同一件事再跑一遍」，静默把「分析」降成「未声明」比丢掉人给的约束
                   更糟（它让两件同一类的事长得不一样）。 */
                taskType: previous.taskType,
              })
              const changed = snapshotDiff(previous, created)
              workbench.record('agent:run-supersede', { from: previous.id, to: created.id }, 'page')
              done({ ok: true, runId: created.id })
              return sendJson(res, {
                ok: true,
                runId: created.id,
                supersedes: previous.id,
                changed: changed.map(entry => entry.key),
                text: `已新建运行 ${created.id} 取代 ${previous.id}`
                  + (changed.length === 0
                    ? '（上下文一样都没变 —— 这次重开不是由上下文变化引起的，那不是错误）'
                    : `（变了：${changed.map(entry => entry.label).join('、')}）`)
                  + '\n人工约束与输出格式沿用旧运行；要改就再开一次运行。'
                  + '\n旧运行一个字节都没动。',
              })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* The site's **editable** half: the note and the localisation
             preference. The factual half (domain, currency, units, title cap)
             has no route at all, which is the structural way of saying those are
             not the user's to edit — the same reason `marketplace.US.titleMax`
             is not a declared setting. */
          if (route === 'site-save' && req.method === 'POST') {
            const body = await readJson(req)
            /* Computed once and used for both the gate and the write: computing
               it twice is how the refusal ends up checking a different workspace
               from the one the row lands in. `site_profile` is keyed by
               (workspace_id, marketplace), so the target is unambiguous. */
            const workspaceId = String(body?.workspaceId ?? '').trim() || DEFAULT_WORKSPACE_ID
            const refusal = workspaceWriteRefusal(store, workspaceId, scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)
            const done = pageWrite('site-save', body)
            try {
              const row = upsertSiteProfile(store, {
                workspaceId,
                marketplace: body?.marketplace,
                localization: body?.localization,
                note: body?.note,
              })
              workbench.record('site:save', { marketplace: row.marketplace }, 'page')
              done({ ok: true, site: row })
              return sendJson(res, { ok: true, site: row })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* Recording that somebody checked a site's rules against a source.
             **Append-only**: this route can add an event and there is no route
             that changes or removes one — a verification record that can be
             rewritten answers nothing. `verifiedBy` defaults to `local` (phase 1
             has no user table, and the person at the keyboard is the actor), and
             `system-seed` is refused by the store: that value means "the manual
             says so about itself" and only the migration may claim it. */
          if (route === 'site-verify' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('site-verify', body)
            try {
              const row = recordSiteVerification(store, {
                workspaceId: String(body?.workspaceId ?? '').trim() || DEFAULT_WORKSPACE_ID,
                marketplace: body?.marketplace,
                verifiedBy: body?.verifiedBy,
                verifiedAt: body?.verifiedAt,
                evidenceUrl: body?.evidenceUrl,
                evidenceNote: body?.evidenceNote,
              })
              workbench.record('site:verify', { marketplace: row.marketplace, verifiedBy: row.verified_by }, 'page')
              done({ ok: true, verification: row })
              return sendJson(res, { ok: true, verification: row })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* The configuration export. A GET because it reads, and its own route
             rather than part of `state` because it is a file, not a panel: the
             tree is meant to be written to disk and handed to somebody, and
             shipping it on every state poll would cost every reader for one
             button. `content-disposition` makes the browser save it rather than
             render it, so the page can offer it as a plain link.
             Credentials are excluded, not masked — see `exportWorkspaceConfig`. */
          if (route === 'workspace-export' && req.method === 'GET') {
            const params = new URL(req.url ?? '/', 'http://x').searchParams
            const workspaceId = String(params.get('workspaceId') ?? '').trim() || DEFAULT_WORKSPACE_ID
            try {
              const tree = exportWorkspaceConfig(store, workspaceId)
              const body = JSON.stringify(tree, null, 2)
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'content-disposition': `attachment; filename="amazon-ops-${tree.workspace.id}.json"`,
              })
              res.end(body)
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 404)
            }
            return undefined
          }

          /* ── S1-B03: shops, brands and ownership ─────────────────────────── */

          /* One shop, one POST. The same three-state note contract the site
             profile uses, and the same reason: a shop with no site is a real
             state, so an omitted `marketplace` must not become US. */
          if (route === 'shop-save' && req.method === 'POST') {
            const body = await readJson(req)
            const workspaceId = String(body?.workspaceId ?? '').trim() || DEFAULT_WORKSPACE_ID
            /* `upsertShop` ignores `workspaceId` when the id already exists — an
               update belongs to the space the row is in — so the landing space is
               read from the row and only falls back to the body's for a create.
               A gate that used the body's id alone would let a page rename a shop
               inside an archived workspace by naming a different one. */
            const existing = store.get('SELECT workspace_id FROM shop WHERE id = ?', [String(body?.id ?? '').trim()])
            const refusal = workspaceWriteRefusal(store, existing?.workspace_id ?? workspaceId, scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)
            const done = pageWrite('shop-save', body)
            try {
              const row = upsertShop(store, {
                id: body?.id,
                workspaceId,
                name: body?.name,
                marketplace: body?.marketplace,
                note: body?.note,
              })
              /* ADR-004 D3：建店同时创建/复用品牌，并写一条默认 `shop_brand_rule`。
                 品牌仍是 **workspace 级**（不挂 shop_id）；这条规则只影响导入时的
                 品牌推荐，不写任何产品事实。失败不阻断建店：店已经建好，品牌可以再补。 */
              const brandName = String(body?.brand ?? '').trim()
              let brand = null
              let brandError = null
              if (brandName !== '') {
                try {
                  const hit = listBrands(store, workspaceId)
                    .find(entry => entry.name.toLowerCase() === brandName.toLowerCase())
                  brand = hit ?? upsertBrand(store, { workspaceId, name: brandName, isOwn: true })
                  const ruleId = 'sbr-' + row.id + '-default'
                  const existingRule = store.get('SELECT id FROM shop_brand_rule WHERE id = ?', [ruleId])
                  if (existingRule === undefined) {
                    const now = nowIso()
                    store.run(
                      `INSERT INTO shop_brand_rule
                         (id, shop_id, brand, match_type, pattern, priority, is_default, note, created_at, updated_at)
                       VALUES (?, ?, ?, 'default', '', 100, 1, NULL, ?, ?)`,
                      [ruleId, row.id, brand.name, now, now],
                    )
                  }
                } catch (error) {
                  brandError = error.message
                }
              }
              workbench.record('shop:save', { id: row.id }, 'page')
              done({ ok: true, shop: row, brand, brandError })
              return sendJson(res, { ok: true, shop: row, brand, brandError })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* One brand, one POST. `isOwn` is what makes a competitor a
             competitor, so it is a first-class field here rather than a flag
             buried in the aliases. */
          if (route === 'brand-save' && req.method === 'POST') {
            const body = await readJson(req)
            const workspaceId = String(body?.workspaceId ?? '').trim() || DEFAULT_WORKSPACE_ID
            /* Same two ids, same reason as `shop-save`: `upsertBrand` keeps the
               stored workspace on an update, so the row decides where the write
               lands and the body only decides for a create. */
            const existing = store.get('SELECT workspace_id FROM brand WHERE id = ?', [String(body?.id ?? '').trim()])
            const refusal = workspaceWriteRefusal(store, existing?.workspace_id ?? workspaceId, scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)
            const done = pageWrite('brand-save', body)
            try {
              const row = upsertBrand(store, {
                id: body?.id,
                workspaceId,
                name: body?.name,
                aliases: body?.aliases,
                forbidden: body?.forbidden,
                isOwn: body?.isOwn,
                note: body?.note,
              })
              workbench.record('brand:save', { id: row.id, isOwn: row.isOwn }, 'page')
              done({ ok: true, brand: row })
              return sendJson(res, { ok: true, brand: row })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* 店铺归档/恢复：只读软状态，不删除。`product_profile.shop_id` 是 FK，
             物理删店会破坏归属；归档后新导入/采集/加竞品一律拒绝。 */
          if (route === 'shop-archive' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('shop-archive', body)
            const id = String(body?.id ?? '').trim()
            const existing = store.get('SELECT workspace_id FROM shop WHERE id = ?', [id])
            const refusal = workspaceWriteRefusal(store, existing?.workspace_id ?? DEFAULT_WORKSPACE_ID, scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)
            try {
              const row = archiveShop(store, id, body?.by ?? 'page')
              workbench.record('shop:archive', { id: row.id }, 'page')
              done({ ok: true, shop: row })
              return sendJson(res, { ok: true, shop: row })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          if (route === 'shop-restore' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('shop-restore', body)
            const id = String(body?.id ?? '').trim()
            const existing = store.get('SELECT workspace_id FROM shop WHERE id = ?', [id])
            const refusal = workspaceWriteRefusal(store, existing?.workspace_id ?? DEFAULT_WORKSPACE_ID, scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)
            try {
              const row = restoreShop(store, id)
              workbench.record('shop:restore', { id: row.id }, 'page')
              done({ ok: true, shop: row })
              return sendJson(res, { ok: true, shop: row })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* 批量/单 ASIN 加竞品：先全部校验，再逐条写；结果逐行返回，
             不接受「静默跳过」。family 与 child 共用这一条路由。 */
          if (route === 'competitor-batch-add' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('competitor-batch-add', body)
            const marketplace = String(body?.marketplace ?? 'US').toUpperCase()
            const parentAsin = String(body?.parentAsin ?? '').trim().toUpperCase()
            const scope = body?.scope === 'child' ? 'child' : 'family'
            const scopeAsin = scope === 'child' ? String(body?.scopeAsin ?? '').trim().toUpperCase() : ''
            const inputs = Array.isArray(body?.competitors) ? body.competitors : []
            if (parentAsin === '') return sendJson(res, { ok: false, code: 'PARENT_REQUIRED', error: '父 ASIN 必填' }, 400)
            if (inputs.length === 0) return sendJson(res, { ok: false, code: 'NO_COMPETITORS', error: '至少一个竞品 ASIN' }, 400)
            /* T39 F3：归档店铺必须在这里就拒绝 —— 页面隐藏按钮不算守卫，API 仍可绕过。 */
            const archivedShop = archivedShopFor(store, {
              shopId: body?.shopId ?? null,
              parentAsins: [parentAsin],
              marketplace,
            })
            if (archivedShop !== null) {
              return sendJson(res, {
                ok: false, code: 'SHOP_ARCHIVED',
                error: `店铺「${archivedShop.name}」已归档，不能新增竞品；恢复后再试。`,
              }, 409)
            }
            if (scope === 'child') {
              const child = store.get(
                'SELECT 1 AS hit FROM product_profile WHERE asin = ? AND parent_asin = ? AND marketplace = ? LIMIT 1',
                [scopeAsin, parentAsin, marketplace],
              )
              if (child === undefined) {
                return sendJson(res, { ok: false, code: 'NOT_A_CHILD', error: `子 ASIN ${scopeAsin || '(空)'} 不在父 ${parentAsin} 下` }, 400)
              }
            }
            const existing = listAllCompetitors(store, { marketplace, parentAsin, limit: 1000 })
            const active = new Set(existing
              .filter(row => row.status === 'active')
              .map(row => [row.scope, row.scope_asin ?? '', row.competitor_asin].join('|')))
            const seen = new Set()
            const results = []
            for (const raw of inputs) {
              const asin = String(raw ?? '').trim().toUpperCase()
              let status = 'added'
              let reason = null
              if (!/^[A-Z0-9]{10}$/.test(asin)) {
                status = 'rejected'; reason = 'ASIN 必须是 10 位字母数字'
              } else if (asin === parentAsin) {
                status = 'rejected'; reason = 'an ASIN cannot be its own competitor'
              } else if (seen.has(asin)) {
                status = 'duplicate'; reason = '批次内重复'
              } else {
                const own = store.get(
                  'SELECT 1 AS hit FROM product_profile WHERE asin = ? AND marketplace = ? LIMIT 1',
                  [asin, marketplace],
                )
                if (own !== undefined) {
                  status = 'rejected'; reason = '这是自家产品，不能当竞品'
                } else if (active.has([scope, scopeAsin, asin].join('|'))) {
                  status = 'unchanged'; reason = '已存在（未新增）'
                } else {
                  try {
                    upsertCompetitor(store, {
                      marketplace, parentAsin, competitorAsin: asin,
                      scope, scopeAsin, source: 'manual', status: 'active',
                    })
                    active.add([scope, scopeAsin, asin].join('|'))
                  } catch (error) {
                    status = 'rejected'; reason = error.message
                  }
                }
              }
              seen.add(asin)
              results.push({ asin, status, reason })
            }
            const summary = {
              added: results.filter(row => row.status === 'added').length,
              unchanged: results.filter(row => row.status === 'unchanged').length,
              rejected: results.filter(row => row.status === 'rejected').length,
              duplicate: results.filter(row => row.status === 'duplicate').length,
            }
            workbench.record('competitor:batch-add', { parentAsin, marketplace, scope, ...summary }, 'page')
            done({ ok: true, results, summary })
            return sendJson(res, { ok: true, results, summary })
          }

          /* Writing an ASIN's ownership, or retracting one.
             `POST` because it writes; its own route because it writes a
             different table from the brand and shop forms.

             A self/competitor contradiction comes back as `{ ok:false,
             conflict:true }` with **nothing written** — it is a finding, not a
             crash, and the caller has a decision to surface. That is also why
             this handler does not turn it into a 400: the request was well
             formed, the *result* is what cannot be held. */
          if (route === 'ownership' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('ownership', body)
            const asin = String(body?.asin ?? '').trim().toUpperCase()
            const marketplace = String(body?.marketplace ?? '').trim().toUpperCase()
            try {
              if (body?.action === 'retract') {
                const retracted = retractOwnership(store, {
                  asin, marketplace, objectType: body?.objectType, objectId: body?.objectId, source: body?.source,
                })
                workbench.record('ownership:retract', { asin, marketplace, retracted }, 'page')
                done({ ok: true, retracted })
                return sendJson(res, { ok: true, retracted, ownership: ownershipView(store, { asin, marketplace }) })
              }

              /* The machine's opinion, written on request. It is an explicit
                 action rather than something that happens behind the user's
                 back, because it writes rows: the brand comes from the title
                 (through the alias table, with the alias that matched kept as
                 evidence) and the line from the ASIN's current classification.
                 Nothing is derived when neither is known — an "auto" row with no
                 evidence is a guess wearing a record's clothes. */
              if (body?.action === 'auto') {
                const row = store.get(
                  'SELECT asin, marketplace, brand, product_line_id FROM asin WHERE asin = ? AND marketplace = ?',
                  [asin, marketplace],
                )
                if (row === undefined) return sendJson(res, { ok: false, error: `no ASIN ${asin} in ${marketplace}` }, 404)
                const brand = row.brand === null || row.brand === undefined
                  ? null
                  : findBrandByAlias(store, row.brand, DEFAULT_WORKSPACE_ID)
                const records = deriveOwnership({
                  asin,
                  marketplace,
                  productLineId: row.product_line_id,
                  brandIsOwn: brand === null ? null : brand.isOwn,
                  confidence: brand === null ? null : 0.9,
                  evidence: { brand: brand === null ? null : brand.matched, productLine: row.product_line_id ?? null },
                })
                if (records.length === 0) {
                  return sendJson(res, {
                    ok: true, derived: 0,
                    error: '这个 ASIN 既没有品牌命中，也没有产品线，判定不出归属 —— 不写空记录。',
                    ownership: ownershipView(store, { asin, marketplace }),
                  })
                }
                const derived = upsertOwnership(store, { records })
                if (derived.ok === false) {
                  return sendJson(res, {
                    ok: false, conflict: true, code: derived.code, error: derived.reason,
                    ownership: ownershipView(store, { asin, marketplace }),
                  }, 409)
                }
                workbench.record('ownership:auto', { asin, marketplace, derived: records.length }, 'page')
                done({ ok: true, derived: records.length })
                return sendJson(res, { ok: true, derived: records.length, ownership: ownershipView(store, { asin, marketplace }) })
              }

              const result = upsertOwnership(store, {
                asin,
                marketplace,
                objectType: body?.objectType,
                objectId: body?.objectId,
                source: body?.source ?? 'manual',
                confidence: body?.confidence,
                evidence: body?.evidence,
              })
              if (result.ok === false) {
                return sendJson(res, {
                  ok: false, conflict: true, code: result.code, error: result.reason,
                  ownership: ownershipView(store, { asin, marketplace }),
                }, 409)
              }
              workbench.record('ownership:write', { asin, marketplace, objectType: body?.objectType, objectId: body?.objectId }, 'page')
              done({ ok: true, ownership: true })
              return sendJson(res, { ok: true, ownership: ownershipView(store, { asin, marketplace }) })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* ── F05-01: the ASIN table's saved views ───────────────────────────
             Two routes, and both call the same `store/asin-view.js` pair the three
             `amzn_asin_view_*` tools call. A view is a saved **intention**
             (filters + column configuration), not a saved result, so loading one
             is the page's own job: it puts these two values back into `filters`
             and the query runs as usual.

             Saving is `POST asin-view-save` and not part of `context` because it
             writes a table: `context` is in-memory UI state that a refresh
             rebuilds, which is exactly what "saved" must not mean. The route is
             also why the same view survives a restart — see the v42 migration.

             The refusal is the store's own message (empty name, name too long,
             filters not an object), passed through so a bad body says which field
             was wrong instead of "400 Bad Request". */
          if (route === 'asin-view-save' && req.method === 'POST') {
            const body = await readJson(req)
            const name = String(body?.name ?? '').trim()
            if (name === '') return sendJson(res, { ok: false, error: 'name is required' }, 400)

            const refusal = workspaceWriteRefusal(store, scopeWorkspaceId(), scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)

            const done = pageWrite('asin-view-save', body)
            let result
            try {
              result = saveAsinSavedView(store, {
                name,
                filters: body?.filters ?? {},
                columns: body?.columns === undefined ? ASIN_COLUMNS.map(column => column.id) : body.columns,
                note: body?.note,
                workspaceId: scopeWorkspaceId(),
              })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }

            workbench.record('asin:view-save', {
              name, created: result.created, columns: result.view.columns.length,
            }, 'page')
            done({ ok: true, name, created: result.created })
            return sendJson(res, {
              ok: true,
              name,
              created: result.created,
              /* 认不出的列 id 报回去 —— 不报的话，用户勾了一列、存下来、
                 再打开发现没有它，而没有任何东西说过为什么。 */
              droppedColumns: result.droppedColumns,
              views: listAsinSavedViews(store, { workspaceId: scopeWorkspaceId() }),
            })
          }

          /* Deleting a saved view. Its own route rather than a flag on the save
             route: "make this not exist" and "make this exist with these values"
             are different operations, and a shared route would be one boolean away
             from deleting on a save. A name that was never saved answers 404 with
             the store's own list of what does exist — "I deleted it" and "there was
             nothing to delete" must not both read as success. */
          if (route === 'asin-view-delete' && req.method === 'POST') {
            const body = await readJson(req)
            const name = String(body?.name ?? '').trim()
            if (name === '') return sendJson(res, { ok: false, error: 'name is required' }, 400)

            const refusal = workspaceWriteRefusal(store, scopeWorkspaceId(), scopeWorkspaceId())
            if (refusal !== null) return sendJson(res, refusal, 400)

            const done = pageWrite('asin-view-delete', body)
            const removed = deleteAsinSavedView(store, { name, workspaceId: scopeWorkspaceId() })
            if (removed === undefined) {
              done({ ok: false, removed: 0 })
              return sendJson(res, {
                ok: false,
                error: `没有叫「${name}」的视图，什么都没删`,
                code: 'ASIN_VIEW_NOT_FOUND',
                views: listAsinSavedViews(store, { workspaceId: scopeWorkspaceId() }),
              }, 404)
            }

            workbench.record('asin:view-delete', { name }, 'page')
            done({ ok: true, removed: 1 })
            return sendJson(res, {
              ok: true,
              removed: removed.name,
              views: listAsinSavedViews(store, { workspaceId: scopeWorkspaceId() }),
            })
          }

          /* Hiding one snapshot version from the default view. A POST for the
             same reasons as `rule-toggle`: it writes, and it is one fact —
             "this version is now hidden" — that is reversible. It is NOT a
             delete: the row keeps its pointer or payload, so every id that
             referenced it still resolves. `archiveSnapshot` is the same function
             a future tool would call, so the page and the agent cannot drift
             about what archiving means. */
          if (route === 'snapshot-archive' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('snapshot-archive', body)
            const id = String(body?.id ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, error: 'id is required' }, 400)

            /* S1-B17.1 归档闸门, the second of the two archive edges. Same 409 +
               same code as the workspace one, so a caller that learned one has
               learned both. */
            const refusal = approvalRefusal(store, 'archive', body?.confirm,
              `要归档的快照：${id}。归档只是从默认视图里藏起来，按 id 仍然解析得出来。确认无误就带 confirm: true 再提交一次。`)
            if (refusal !== null) return sendJson(res, refusal, 409)

            try {
              const result = archiveSnapshot(store, id, { note: body?.note ?? null })
              workbench.record('snapshot:archive', {
                id, changed: result.changed, objectType: result.after.objectType,
              }, 'page')
              done({ ok: true, changed: result.changed, snapshot: result.after })
              return sendJson(res, { ok: true, changed: result.changed, snapshot: result.after })
            } catch (error) {
              /* The store's own message names the id; pass it through so the page
                 says which snapshot was not found rather than "400". */
              return sendJson(res, { ok: false, error: error.message }, 404)
            }
          }

          /* Reference-checked soft delete (S1-B19, F03-07). It is the guarded
             twin of `snapshot-archive`: the same write (the registry's
             `archived_at` flag), but it asks the reference graph first and
             refuses when anything still points at the version. The reply for a
             refusal carries the referrer list and `code: RETENTION_REFERENCED`
             at 409 — a 400 would say the request was malformed, and it was not:
             the *move* is what the graph does not have. Nothing is written on a
             refusal, which is why the funnel records nothing for it: `pageWrite`
             is called but its recorder returns early on `ok: false`.

             `softDelete` is the store's own verb; a future tool would call the
             same one, so the page and the agent cannot disagree about why a
             delete failed. */
          if (route === 'snapshot-delete' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('snapshot-delete', body)
            const id = String(body?.id ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, error: 'id is required' }, 400)
            const snapshot = getSnapshot(store, id)
            if (snapshot === null) return sendJson(res, { ok: false, error: `no snapshot with id "${id}"` }, 404)
            const result = softDelete(store, {
              id, objectType: snapshot.objectType, objectId: snapshot.objectId, note: body?.note ?? null,
            })
            if (result.ok !== true) {
              const status = result.code === 'RETENTION_REFERENCED' ? 409 : 404
              return sendJson(res, {
                ok: false, code: result.code, error: result.error, referrers: result.referrers ?? [],
              }, status)
            }
            workbench.record('snapshot:delete', {
              id, objectType: snapshot.objectType, changed: result.changed,
            }, 'page')
            done({ ok: true, changed: result.changed, snapshot: result.snapshot })
            return sendJson(res, { ok: true, changed: result.changed, snapshot: result.snapshot })
          }

          /* Bringing a hidden version back into the default view (S1-B19). The
             inverse of the delete above and of `snapshot-archive`: it clears
             `archived_at` and leaves the body where it was. Restoring a version
             that is already visible is a plain `changed: false`, not an error —
             those are two different facts and the page shows both. */
          if (route === 'snapshot-restore' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('snapshot-restore', body)
            const id = String(body?.id ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, error: 'id is required' }, 400)
            const result = restore(store, { id, note: body?.note ?? null })
            if (result.ok !== true) {
              return sendJson(res, { ok: false, code: result.code, error: result.error }, 404)
            }
            workbench.record('snapshot:restore', { id, changed: result.changed }, 'page')
            done({ ok: true, changed: result.changed, snapshot: result.snapshot })
            return sendJson(res, { ok: true, changed: result.changed, snapshot: result.snapshot })
          }

          /* Moving one quality issue along the state machine. A POST because it
             writes, and its own route rather than part of `context` because the
             status is not UI state — it is a fact about the data that survives a
             reload.

             The page offers only the edges `DQ_ISSUE_TRANSITIONS` declares, but
             the page is not the guard: `setIssueStatus` re-checks the machine and
             returns `DQ_ILLEGAL_TRANSITION` with **nothing written**. That
             refusal is a 409 rather than a 400 — the request was well formed, the
             *move* is what the machine does not have — and the store's own
             message is passed through so the page names the two states instead of
             saying "409". A missing id is a different refusal (404): it is not an
             illegal transition, it is a row that is not there. */
          if (route === 'dq-issue' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('dq-issue', body)
            const id = String(body?.id ?? '').trim()
            const to = String(body?.to ?? '').trim()
            if (id === '' || to === '') {
              return sendJson(res, { ok: false, error: 'id and to are required' }, 400)
            }
            const result = setIssueStatus(store, { id, to, note: body?.note ?? null, assignee: body?.assignee ?? null })
            if (result.ok !== true) {
              const status = result.code === PROBLEM_CODES.DQ_ILLEGAL_TRANSITION ? 409 : 404
              return sendJson(res, { ok: false, error: result.error, code: result.code ?? null, hint: result.hint ?? null }, status)
            }
            workbench.record('dq:status', { id, from: result.before, to: result.after }, 'page')
            done({ ok: true, before: result.before, after: result.after })
            return sendJson(res, { ok: true, before: result.before, after: result.after, issue: result.issue })
          }

          /* Adopting one value for a field two sources disagree on.

             A POST because it writes a decision, and it writes **only** the
             conflict row: the sources that lost are left exactly where they
             were. `resolveConflict` is the same function `amzn_conflict_resolve`
             calls, so the page and the agent cannot drift about what adopting a
             value means.

             The refusals are distinct statuses on purpose: 404 for a row that is
             not there, 409 for a move the state machine does not have (the
             request was well formed — the *result* cannot be held), 400 for a
             missing value or an unknown source. The store's own message names
             the id or the two states, and is passed through unchanged. */
          if (route === 'conflict-resolve' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('conflict-resolve', body)
            const id = String(body?.id ?? '').trim()
            const adoptedValue = body?.adoptedValue
            if (id === '' || adoptedValue === undefined || adoptedValue === null || String(adoptedValue).trim() === '') {
              return sendJson(res, { ok: false, error: 'id 与 adoptedValue 都是必填' }, 400)
            }
            const result = resolveConflict(store, {
              id,
              adoptedValue,
              adoptedSourceId: body?.adoptedSourceId,
              resolvedBy: body?.resolvedBy,
              note: body?.note,
            })
            if (result.ok !== true) {
              const status = result.code === 'CONFLICT_NOT_FOUND'
                ? 404
                : (result.code === 'CONFLICT_ILLEGAL_TRANSITION' ? 409 : 400)
              return sendJson(res, { ok: false, code: result.code, error: result.error }, status)
            }
            workbench.record('conflict:resolve', {
              id, adoptedValue: result.after.adoptedValue,
              from: result.before.status, to: result.after.status,
            }, 'page')
            done({ ok: true, conflict: result.conflict })
            return sendJson(res, { ok: true, conflict: result.conflict })
          }

          /* ── 模块 14 §6-§9：发布闭环的四条写路径 ─────────────────────────────
             每条都调**同一个工具**而不是在路由里重写一遍判断 —— 页面点一次和会话调
             一次，对同一件事只能有一个答案，审计也才落在同一个 action 上。工具的
             成功返回是一段渲染文本；失败返回 { ok:false, error, hint }，这里原样透传
             并给 400 —— 一次被拒的写入不是「空成功」。 */

          /* §6 的登记。运营在 Seller Central 改完之后回来记一笔（本插件不发布）。
             kind=draft 关联运行与草案版本并当场算差异；manual 不关联也不进发布率；
             rollback 必须指出在回滚哪一条。 */
          if (route === 'publication-record' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('publication-record', body)
            try {
              const output = await publicationRecordTool({ store }).execute({
                asin: body?.asin,
                marketplace: body?.marketplace,
                kind: body?.kind,
                runId: body?.runId ?? null,
                draftVersion: body?.draftVersion ?? null,
                published: body?.published ?? {},
                rollbackOf: body?.rollbackOf ?? null,
                operator: body?.operator ?? null,
                note: body?.note ?? null,
                evidenceRef: body?.evidenceRef ?? null,
                publishedAt: body?.publishedAt ?? null,
                observationStartAt: body?.observationStartAt ?? null,
                rollbackProtected: body?.rollbackProtected === true,
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('publication:record', {
                asin: String(body?.asin ?? ''),
                marketplace: String(body?.marketplace ?? ''),
                kind: String(body?.kind ?? ''),
              }, 'page')
              done({ ok: true, text: output })
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* §6 的偏离处置。**这是 §8 那道闸门的钥匙**：偏离未处置（waiting_human）的
             发布，`ensureCheckpoints` 拒绝物化，观测永远不开始。没有这条路由，那道闸门
             就是一把没有钥匙的锁。 */
          if (route === 'baseline-choice' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('baseline-choice', body)
            try {
              const output = await publicationBaselineDecideTool({ store }).execute({
                publicationId: body?.publicationId,
                choice: body?.choice,
                note: body?.note ?? null,
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('publication:baseline', {
                publicationId: String(body?.publicationId ?? ''),
                choice: String(body?.choice ?? ''),
              }, 'page')
              done({ ok: true, text: output })
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* §8 的结论。数据不足的节点只收 insufficient —— 那条规则在 store 与 domain
             的 refuteConclusion 里，路由不重写它，工具会把拒收理由原样带回。 */
          if (route === 'observation-conclude' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('observation-conclude', body)
            try {
              const output = await observationConcludeTool({ store }).execute({
                checkpointId: body?.checkpointId,
                conclusion: body?.conclusion,
                note: body?.note ?? null,
                by: body?.by ?? 'page',
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('observation:conclude', {
                checkpointId: String(body?.checkpointId ?? ''),
                conclusion: String(body?.conclusion ?? ''),
              }, 'page')
              done({ ok: true, text: output })
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* §9 的回滚交付包。**本插件不执行回滚**：这里只生成人工清单，人改完再回 §6
             登记一条 kind=rollback 的记录才闭环。不是线上那一版时工具拒收，理由透传。 */
          if (route === 'rollback-suggest' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('rollback-suggest', body)
            try {
              const output = await rollbackSuggestTool({ store }).execute({
                publicationId: body?.publicationId,
                reason: body?.reason ?? null,
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('rollback:suggest', { publicationId: String(body?.publicationId ?? '') }, 'page')
              done({ ok: true, text: output })
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* 模块 08 F08-07 的「改生命周期」。页面只读视图，写**只走工具** —— 这条路由
             调用 `amzn_keyword_lifecycle_set` 的同一个工具，不在路由里重写一遍判断：
             页面点一次和会话调一次，对同一件事只能有一个答案，审计也才落在同一个
             action 上。非法流转（含「设成它已经是的状态」这个同态）与未知状态由工具
             拒掉并带回理由，这里原样透传并给 400 —— 一次被拒的写入不是「空成功」。 */
          if (route === 'keyword-lifecycle' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('keyword-lifecycle', body)
            try {
              const output = await keywordLifecycleSetTool({ store }).execute({
                keyword: body?.keyword,
                marketplace: body?.marketplace,
                to: body?.to,
                reason: body?.reason ?? null,
                source: body?.source ?? 'manual',
                by: body?.by ?? 'page',
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('keyword:lifecycle', {
                keyword: String(body?.keyword ?? ''),
                to: String(body?.to ?? ''),
              }, 'page')
              done({ ok: true, text: output })
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* 模块 08 F08-07 的「**批量**改生命周期」（F-5，走查 2026-10-25）。
             走查看到的总库是「已设置 0 / 未设置 30,778」，而页面写着「点选一条词」——
             3 万条只支持单条操作不是效率问题。这条路由与工具是**同一个函数**
             （`amzn_keyword_lifecycle_batch_set`），不在这里重写状态机或上限：页面上点
             一次和会话里调一次，对同一件事只能有一个答案，审计也落在同一个 action 上。
             `dryRun` 的预览**不写库**，`PAGE_WRITE_TARGETS` 里配了 skip，所以它一行审计
             都不记（记一条「写」就是撒谎）。被拒的批量（非法边 / 同态 / 超限 / 词不在库）
             由工具抛出，这里原样透传并给 400。 */
          if (route === 'keyword-lifecycle-batch' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('keyword-lifecycle-batch', body)
            try {
              const output = await keywordLifecycleBatchSetTool({ store }).execute({
                keywords: Array.isArray(body?.keywords) ? body.keywords : null,
                filter: body?.filter ?? null,
                marketplace: body?.marketplace,
                to: body?.to,
                reason: body?.reason ?? null,
                by: body?.by ?? 'page',
                dryRun: body?.dryRun === true,
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('keyword:lifecycle-batch', {
                selection: Array.isArray(body?.keywords) ? `keywords:${body.keywords.length}` : 'filter',
                to: String(body?.to ?? ''),
                dryRun: body?.dryRun === true,
              }, 'page')
              done({ ok: true, text: output })
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* v69 — 产品线**归属**的页面写路径。与工具是同一个函数
             （`amzn_keyword_product_line_batch_set`）：路由不判断「人工 > 派生」、不判断
             product line id 是否存在、不判断「已经在目标值」—— 那些都在 store 的批量里。
             `revoke: true` 走同一条（撤销也是人的决定，事件行里 to 为 NULL）。 */
          if (route === 'keyword-product-line-batch' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('keyword-product-line-batch', body)
            try {
              const output = await keywordProductLineBatchSetTool({ store }).execute({
                keywords: Array.isArray(body?.keywords) ? body.keywords : null,
                filter: body?.filter ?? null,
                marketplace: body?.marketplace,
                to: body?.to ?? null,
                revoke: body?.revoke === true,
                reason: body?.reason ?? null,
                by: body?.by ?? 'page',
                dryRun: body?.dryRun === true,
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('keyword:product-line-batch', {
                selection: Array.isArray(body?.keywords) ? `keywords:${body.keywords.length}` : 'filter',
                to: body?.revoke === true ? '(revoke)' : String(body?.to ?? ''),
                dryRun: body?.dryRun === true,
              }, 'page')
              done({ ok: true, text: output })
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }


          /* 模块 08 F08-04 的所有权工作台。三条路由，读一写二 —— 预览**不写库**
             （`PAGE_WRITE_TARGETS` 里是 `null`），批量与采纳**只走工具**：页面点一次和
             会话调一次，对同一件事只能有一个答案，审计也才落在同一个 action 上。
             预览与执行是**同一个 store 函数**（`dryRun` 参数），所以预览说的「直接 N 词 /
             牵连 M 词 / 解除 K 起冲突」与真正执行的结果逐项相等 —— 两份实现迟早分叉，
             然后「预览说 3 词、执行改了 24 词」。被拒的写入（词不在总库、锁定词、竞品
             品牌词、活跃运行未二次确认）由工具抛出，这里原样透传并给 400 —— 一次被拒的
             写入不是「空成功」。 */
          if (route === 'keyword-ownership-preview' && req.method === 'POST') {
            const body = await readJson(req)
            try {
              const output = await keywordOwnershipPreviewTool({ store }).execute({
                action: body?.action,
                keywords: body?.keywords,
                marketplace: body?.marketplace,
                asin: body?.asin ?? null,
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          if (route === 'keyword-ownership' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('keyword-ownership', body)
            try {
              const output = await keywordOwnershipBatchTool({ store }).execute({
                action: body?.action,
                keywords: body?.keywords,
                marketplace: body?.marketplace,
                asin: body?.asin ?? null,
                reason: body?.reason ?? null,
                source: body?.source ?? 'manual',
                by: body?.by ?? 'page',
                confirmed: body?.confirmed === true,
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('keyword:ownership', {
                action: String(body?.action ?? ''),
                keywords: Array.isArray(body?.keywords) ? body.keywords.length : 0,
              }, 'page')
              done({ ok: true, text: output })
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          if (route === 'keyword-ownership-resolve' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('keyword-ownership-resolve', body)
            try {
              const output = await keywordOwnershipResolveTool({ store }).execute({
                keyword: body?.keyword,
                marketplace: body?.marketplace,
                asin: body?.asin ?? null,
                reason: body?.reason ?? null,
                by: body?.by ?? 'page',
              })
              if (typeof output !== 'string') return sendJson(res, output, 400)
              workbench.record('keyword:ownership-resolve', {
                keyword: String(body?.keyword ?? ''),
                asin: String(body?.asin ?? ''),
              }, 'page')
              done({ ok: true, text: output })
              return sendJson(res, { ok: true, text: output })
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* 模块 08 F08-05 的「存一版位置计划」。只走 store 的 `savePlan` —— 与
             `amzn_keyword_plan_save` 工具是**同一个函数**，所以页面点一次和会话调一次
             对同一件事只有一个答案，审计也落在同一个 `keywordPlanSave` 上。一次被拒的
             保存（位置不在词表、同一个词出现两次、复现位没理由）由 store 抛出，这里原样
             透传并给 400 —— 一次被拒的写入不是「空成功」，而且**什么都没写**。 */
          if (route === 'keyword-plan' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('keyword-plan', body)
            try {
              const saved = savePlan(store, {
                asin: body?.asin,
                marketplace: body?.marketplace,
                name: body?.name ?? null,
                note: body?.note ?? null,
                entries: body?.entries ?? [],
                source: body?.source ?? 'manual',
                status: body?.status ?? 'draft',
                lineageId: body?.lineageId ?? null,
                createdBy: body?.by ?? 'page',
              })
              workbench.record('keyword:plan', {
                asin: String(body?.asin ?? ''),
                entries: Array.isArray(body?.entries) ? body.entries.length : 0,
              }, 'page')
              const result = {
                ok: true,
                plan: saved.plan,
                text: `已保存位置计划 v${saved.plan.version}（${saved.entries.length} 词）· `
                  + `版本族 ${saved.plan.lineageId}。改计划请带 lineageId，新版本进同一族。`,
              }
              done(result)
              return sendJson(res, result)
            } catch (error) {
              return sendJson(res, { ok: false, error: error.message }, 400)
            }
          }

          /* 通知的三条写路径。它们**不进审计** —— `PAGE_WRITE_TARGETS` 里三条都是
             `null`，理由写在那张表旁边：改的是这份提醒列表自己，不是任何一条业务
             数据。把「已读」记进「谁改了什么」，只会把真正重要的改动淹掉。

             三条的拒绝各不相同：缺 id / 缺 kind 是 400；找不到那条通知是 404；
             而清理一个没有东西的类型**不是错**，返回 removed: 0 —— 「清了 0 条」和
             「按钮坏了」必须长得不一样，否则用户会去修一个没坏的东西。 */
          if (route === 'notification-read' && req.method === 'POST') {
            const body = await readJson(req)
            const id = String(body?.id ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, error: 'id is required' }, 400)
            const result = markRead(store, id)
            if (result.ok !== true) {
              return sendJson(res, { ok: false, code: result.code, error: result.error }, 404)
            }
            workbench.record('notification:read', { id, changed: result.changed }, 'page')
            return sendJson(res, { ok: true, changed: result.changed, unread: unreadCount(store) })
          }

          if (route === 'notification-read-all' && req.method === 'POST') {
            const result = markAllRead(store)
            workbench.record('notification:read-all', { changed: result.changed }, 'page')
            return sendJson(res, { ok: true, changed: result.changed, unread: unreadCount(store) })
          }

          if (route === 'notification-clear' && req.method === 'POST') {
            const body = await readJson(req)
            const kind = String(body?.kind ?? '').trim()
            if (kind === '') return sendJson(res, { ok: false, error: 'kind is required' }, 400)
            const result = clearByKind(store, kind)
            workbench.record('notification:clear', { kind, removed: result.removed }, 'page')
            return sendJson(res, { ok: true, removed: result.removed, unread: unreadCount(store) })
          }

          /* 收藏与最近访问（S1-B20）。两条都**不进审计**（`PAGE_WRITE_TARGETS`
             里两条都是 null）：改的是这个人的界面状态，不是业务数据 —— 和
             `context` 同类，只是它需要跨重启保留。把「谁点了收藏」记进审计，
             只会把真正重要的改动淹掉。

             拒绝的形状和 store 一致：缺 module 或缺 id 是 400，且**什么都没写**。
             recent-push 是幂等的（同一对象重复访问只更新它的位置），所以它可以被
             页面放心地在每次跳转时调用。 */
          if (route === 'recent-push' && req.method === 'POST') {
            const body = await readJson(req)
            const result = pushRecent(store, body)
            if (result.ok !== true) return sendJson(res, { ok: false, error: result.error }, 400)
            workbench.record('pins:recent', { module: String(body?.module ?? ''), id: String(body?.id ?? '') }, 'page')
            return sendJson(res, { ok: true, recent: result.recent })
          }

          if (route === 'pin-toggle' && req.method === 'POST') {
            const body = await readJson(req)
            const result = toggleFavorite(store, body)
            if (result.ok !== true) return sendJson(res, { ok: false, error: result.error }, 400)
            workbench.record('pins:toggle', {
              module: String(body?.module ?? ''), id: String(body?.id ?? ''), added: result.added,
            }, 'page')
            return sendJson(res, { ok: true, added: result.added, favorites: result.favorites })
          }

          /* ── 模块 04 第二子批：采集中心（契约 §6.3）──────────────────────────
             七条 POST + 一条 GET。`sections` 用 GET 是因为它纯读且参数多（契约 §6.3 的
             原话）；其余七条都在写，所以每条自己调 `pageWrite`（页面漏斗没有包装器可用，
             见 `pageWrite` 上的说明）。 */
          if (route === 'collect-preview' && req.method === 'POST') {
            const body = await readJson(req)
            /* 只读：不打开浏览器、不建任何行，所以没有 `pageWrite` —— 漏斗的守卫同时
               检查反方向：登记为「不写」的路由不许调它。 */
            const result = previewCollection({ store, sources, args: body ?? {} })
            if (result.ok !== true) return sendJson(res, result, collectHttpStatus(result.code))
            return sendJson(res, result)
          }

          if (route === 'collect-env-check' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('collect-env-check', body)
            const result = await runEnvCheck({
              store,
              collector,
              dataDir,
              chromePath,
              marketplace: body?.marketplace ?? 'US',
              taskId: body?.taskId ?? null,
              checks: Array.isArray(body?.checks) ? body.checks : null,
              repair: body?.repair === true,
              confirm: body?.confirm === true,
              logger,
            })
            if (result.ok !== true) return sendJson(res, result, collectHttpStatus(result.code))
            done(result)
            return sendJson(res, result)
          }

          if (route === 'collect-run' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('collect-run', body)
            if (typeof collection?.submitCollectionTask !== 'function') {
              return sendJson(res, { ok: false, error: 'no collection service is registered in this profile' }, 400)
            }
            /* T39 F3：归档店铺不能提交采集。命中即 409，且在 submitCollectionTask
               之前返回 —— 0 条任务；恢复后同一请求可写。 */
            const archivedCollectShop = archivedShopFor(store, {
              shopId: body?.shopId ?? null,
              asins: Array.isArray(body?.targets) ? body.targets : [],
              marketplace: body?.marketplace ?? 'US',
            })
            if (archivedCollectShop !== null) {
              return sendJson(res, {
                ok: false, code: 'SHOP_ARCHIVED',
                error: `店铺「${archivedCollectShop.name}」已归档，不能提交采集；恢复后再试。`,
              }, 409)
            }
            const result = await collection.submitCollectionTask(body ?? {})
            if (result.ok !== true) return sendJson(res, result, collectHttpStatus(result.code))
            done(result)
            return sendJson(res, result)
          }

          /* 「重填」按需取一条任务的原始目标。单独一条 GET，而不是塞进 /api/state：
             那条载荷每 3 秒轮询一次，200 条任务的目标全带上会把它顶到 155.6 KB
             （B04P-㉛ 的 120 KB 预算）。这里没有缓存也没有副作用，读的就是任务行。 */
          if (route === 'collect-task-targets' && req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://x').searchParams
            const id = String(query.get('taskId') ?? '').trim()
            if (id === '') {
              return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: 'taskId is required' }, 400)
            }
            const row = getCollectionTask(store, id)
            if (row === null || row === undefined) {
              return sendJson(res, { ok: false, code: 'NOT_FOUND', error: 'no collection task with that id' }, 404)
            }
            let parsed = []
            try { parsed = JSON.parse(row.targets_json ?? '[]') } catch { parsed = [] }
            const targets = (Array.isArray(parsed) ? parsed : [])
              .map(target => ({
                asin: target !== null && target !== undefined && target.asin ? String(target.asin) : null,
                marketplace: target !== null && target !== undefined && target.marketplace ? String(target.marketplace) : null,
              }))
              .filter(target => target.asin !== null)
            return sendJson(res, {
              ok: true,
              taskId: id,
              kind: row.kind ?? 'asin',
              status: row.status,
              targets,
              total: targets.length,
            })
          }

          if (route === 'collect-cancel' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('collect-cancel', body)
            const id = String(body?.taskId ?? '').trim()
            if (id === '') return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: 'taskId is required' }, 400)
            const result = collection.cancel(id, { reason: body?.reason ?? null, source: 'page' })
            if (result.ok !== true) return sendJson(res, result, collectHttpStatus(result.code))
            const kept = countSectionResults(store, { taskId: id })
            workbench.record('collect:cancel', { taskId: id, kept }, 'page')
            done({ ...result, keptSections: kept })
            return sendJson(res, { ...result, keptSections: kept })
          }

          if (route === 'collect-waiting' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('collect-waiting', body)
            const result = await resolveWaiting({
              store,
              collection,
              collector,
              taskId: body?.taskId,
              action: body?.action,
              reason: body?.reason ?? null,
              by: 'page',
            })
            if (result.ok !== true) return sendJson(res, result, collectHttpStatus(result.code))
            workbench.record('collect:waiting', { taskId: result.taskId, status: result.status }, 'page')
            done(result)
            return sendJson(res, result)
          }

          if (route === 'collect-scheme' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('collect-scheme', body)
            const op = String(body?.op ?? 'save').trim()
            if (op === 'transition') {
              const result = await schemeTransition({ store, collector, dataDir, chromePath, args: body })
              if (result.ok !== true) return sendJson(res, result, collectHttpStatus(result.code))
              workbench.record('collect:scheme', { id: result.scheme.id, version: result.scheme.version, action: body?.action }, 'page')
              done(result)
              return sendJson(res, result)
            }
            if (op !== 'save') {
              return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: `unknown op "${body?.op}"` }, 400)
            }
            const saved = schemeSave({ store, args: body })
            if (saved.ok !== true) return sendJson(res, saved, collectHttpStatus(saved.code))
            workbench.record('collect:scheme', { id: saved.scheme.id, version: saved.scheme.version, created: saved.created }, 'page')
            done(saved)
            return sendJson(res, saved)
          }

          if (route === 'collect-plan' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('collect-plan', body)
            const op = String(body?.op ?? 'save').trim()
            /* `set-enabled` 只翻一个布尔，**不做整行替换**（契约 §6.3 的主理人修订，
               2026-10-09 —— 原文「启用/停用是同一个 save」是缺陷）：`planSave` 缺
               `name`/`targets` 直接拒、没给的列写 null，拿它翻转一个布尔会顺手把别人
               刚改的运行窗口写回去，而窗口被另一个读路径消费（`nextWindow` 每次读时算），
               改回去之后**没有任何信号**。窄更新走 `setPlanEnabled`（store 里那一个
               「语义正好是只翻 enabled」的函数，在此之前生产代码零调用点）。 */
            if (op === 'set-enabled') {
              const id = String(body?.id ?? '').trim()
              /* 布尔就是布尔：`!!enabled` 会把 "false"（字符串，真值）翻成 true，
                 而那个值是调用方从别处读来的 —— 一次静默的反向翻转。 */
              if (typeof body?.enabled !== 'boolean') {
                return sendJson(res, {
                  ok: false, code: 'BAD_REQUEST',
                  error: `enabled must be a boolean (got ${JSON.stringify(body?.enabled)})`,
                }, 400)
              }
              if (id === '' || getCollectionPlan(store, id) === null) {
                /* 一行都不写，也不进审计：`pageWrite` 的 `done()` 只有成功路径才调。 */
                return sendJson(res, {
                  ok: false, code: 'PLAN_NOT_FOUND', error: `collection_plan ${id} does not exist`,
                }, collectHttpStatus('PLAN_NOT_FOUND'))
              }
              let updated = null
              try {
                updated = setPlanEnabled(store, id, body.enabled)
              } catch (error) {
                return sendJson(res, { ok: false, code: 'STORE_REFUSED', error: error.message }, 400)
              }
              const reply = {
                ok: true,
                plan: { ...updated, nextWindow: updated.window === null ? null : windowState(updated.window) },
              }
              workbench.record('collect:plan', { id: updated.id, enabled: updated.enabled }, 'page')
              done(reply)
              return sendJson(res, reply)
            }
            if (op !== 'save') {
              return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: `unknown op "${body?.op}"` }, 400)
            }
            const result = planSave({ store, args: body })
            if (result.ok !== true) return sendJson(res, result, collectHttpStatus(result.code))
            workbench.record('collect:plan', { id: result.plan.id, enabled: result.plan.enabled }, 'page')
            done(result)
            return sendJson(res, result)
          }

          /* ── 模块 05 第一子批：ASIN 详情与数据层 ────────────────────────────────
             F05-02 的前四个标签页（概览 / Listing 全字段 / 13 节 / 变体关系）、
             F05-03 的字段级事实与人工修正、F05-06 的关系数据层、F05-08 的归档数据层。

             **两条读 + 四条写**。读的两条是 GET，所以它们不在 `PAGE_WRITE_TARGETS`
             里 —— 那张表的键必须与 routes.js 里的 POST 路由逐名相等（s1b12 的守卫），
             而这里也真的没有写：影响预览只算不写，详情只读。

             四条写每条都调**与工具同一个函数**（`xxxTool({store}).execute(...)`）：
             页面点一次与会话调一次，在审计里必须是同一条，而且工具自己的输入校验
             （字段不在白名单、值不是数字、理由为空、关系不存在）只写了一遍。
             一条被拒的写入**不是**「空成功」：结果原样透传并给 400。 */
          if (route === 'asin-detail' && req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://x').searchParams
            const detail = buildAsinDetail({
              store,
              asin: query.get('asin'),
              marketplace: query.get('marketplace') ?? 'US',
            })
            if (detail.ok !== true) {
              return sendJson(res, detail, detail.code === 'ASIN_NOT_FOUND' ? 404 : 400)
            }
            return sendJson(res, detail)
          }

          /* ── FR-M2-05 ②：行内改归属的**影响面**（纯读，所以是 GET）────────────
             与 `asin-archive-impact` 同一条理由与同一种形状：改之前先看清会牵动什么。
             判据在 `domain/asin/impact.js`（域层，页面与将来的工具共用同一份），
             所以「页面上说没有影响」与「工具说没有影响」不可能各说一套。
             **注意 `none`**：全零时它带一句完整的话，页面必须把这句话印出来 ——
             空白会被读成「没查」，而那正是这一格要避免的误读。 */
          if (route === 'asin-field-impact' && req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://x').searchParams
            const impact = asinFieldImpact({
              store,
              asin: query.get('asin'),
              marketplace: query.get('marketplace') ?? 'US',
              field: query.get('field'),
              value: query.get('value'),
            })
            if (impact.ok !== true) {
              return sendJson(res, impact, impact.code === 'ASIN_NOT_FOUND' ? 404 : 400)
            }
            return sendJson(res, impact)
          }

          if (route === 'asin-archive-impact' && req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://x').searchParams
            try {
              const asin = query.get('asin')
              const marketplace = query.get('marketplace') ?? 'US'
              return sendJson(res, {
                ok: true,
                impact: archiveImpact(store, { asin, marketplace }),
                /* B-05e：同一条读路由也回答「能不能删」。**与工具侧同一个
                   `asinReferenceReport`**，所以「预览说 0 处引用、执行却被拦住」
                   不可能发生 —— 页面与 `amzn_asin_archive(action:"delete_preview")`
                   读的是同一份函数，不是一个页面上另算的近似。 */
                references: asinReferenceReport(store, { asin, marketplace }),
              })
            } catch (error) {
              /* 参数错（ASIN 形状不对、站名为空）是 400；「这条 ASIN 不在库内」在这里
                 也算参数错 —— 预览一条不存在的 ASIN 的影响面没有意义，而那与「影响面
                 是 0」必须长得不一样。 */
              return sendJson(res, { ok: false, code: error.code ?? null, error: error.message }, 400)
            }
          }

          /* ── B-05c：F05-04 的历史 diff ────────────────────────────────────────
             纯读、参数简单，所以是 GET（与 asin-detail / api/sections 同一条理由）。
             from / to 可以是快照 id 或 ISO 时间；两者都省略时比较最新两份 —— 也就是详情页
             那句「与上一版」，但这里是同一个 builder 的默认值，不是第二次实现。 */
          if (route === 'asin-history' && req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://x').searchParams
            const history = buildAsinHistory(store, {
              asin: query.get('asin'),
              marketplace: query.get('marketplace') ?? 'US',
              from: query.get('from'),
              to: query.get('to'),
              limit: query.get('limit') ?? 100,
            })
            if (history.ok !== true) {
              const notFound = history.code === 'ASIN_NOT_FOUND' || history.code === 'SNAPSHOT_NOT_FOUND'
              return sendJson(res, history, notFound ? 404 : 400)
            }
            return sendJson(res, history)
          }

          /* ── B-05c：F05-07 的数据健康摘要 ────────────────────────────────────
             两样注入在这里解析，builder 只负责把它们摆成六项：
               · `fields`  —— buildFieldFacts 的产出（核心字段完整率与新鲜度的**唯一**算法）
               · `precheck` —— precheckFor 的产出（43 属性与优化前置的**唯一**判据，
                              与 amzn_optimize_precheck / 页面的「开跑这一轮」按钮同一个入口）
             缺哪一样都是程序错误（builder 会抛），所以这里的捕获如实回 500 并把 code 透出去。 */
          if (route === 'asin-health' && req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://x').searchParams
            const asin = String(query.get('asin') ?? '').trim()
            const marketplace = String(query.get('marketplace') ?? 'US').trim()
            if (asin === '') return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }, 400)

            const fields = buildFieldFacts(store, { asin, marketplace })
            if (fields === null) {
              return sendJson(res, {
                ok: false,
                code: 'ASIN_NOT_FOUND',
                error: `${asin.toUpperCase()} (${marketplace.toUpperCase()}) 不在库内`,
                hint: '先用 amzn_asin_upsert 导入，或确认站点代码对不对 —— 同一个 ASIN 在不同站点是两条记录',
              }, 404)
            }

            try {
              const summary = buildAsinHealthSummary(store, {
                asin,
                marketplace,
                fields,
                precheck: precheckFor(store, { asin, marketplace, mode: 'full' }),
              })
              if (summary.ok !== true) {
                return sendJson(res, summary, summary.code === 'ASIN_NOT_FOUND' ? 404 : 400)
              }
              return sendJson(res, summary)
            } catch (error) {
              return sendJson(res, {
                ok: false,
                code: error.code ?? 'ASIN_HEALTH_FAILED',
                error: error.message,
              }, 500)
            }
          }

          /* ── B-05c：F05-05 批量导入的预览 ────────────────────────────────────
             **POST 但写 0 行**（描述符在 PAGE_WRITE_TARGETS 里是 null，所以它绝不能调
             `pageWrite` —— tests/s1b12-audit.mjs 两个方向都会抓）。用 POST 而不是 GET：
             一份 CSV 正文放进 query string 会撞长度上限，且它会出现在每一条访问日志里。
             这里把 dryRun 钉成 true，所以这条路无论传什么都不会写库。 */
          if (route === 'asin-import-preview' && req.method === 'POST') {
            const body = await readJson(req)
            const output = await asinImportTool({ store }).execute({ ...(body ?? {}), dryRun: true })
            if (output?.ok !== true) {
              return sendJson(res, output, ASIN_IMPORT_STATUS[output?.code] ?? 400)
            }
            return sendJson(res, output)
          }

          /* ── B-05c：F05-05 批量导入的写 ──────────────────────────────────────
             与其它 ASIN 写路由同一条约定：**只走工具**（`asinImportTool`），所以计划与
             写库的编排只有一份实现。审计只在**真的写**的时候记（`dryRun === false`）：
             一次预览留一条「导入发生了」的记录，就是关于一件没发生的事的记录 ——
             与 `amzn_asin_import` 描述符上的 `skip` 同一个判断，只是两处各写一次判据
             在这里是必要的（漏斗在路由里，工具漏斗看不到页面的入参）。

             ⚠️ 这个漏斗调用是**有条件**的：预览那条分支根本不到达它。s1b12 的守卫读的是
             路由源码里有没有那四个字母加左括号，所以「写了却不说」与「说了却没写」两个方向
             仍然都被它盯着。（这一段注释里刻意不写那个字面量 —— 守卫会把注释也算进去，
             而一条注释里的字面量会让它误判成「说读写路由调了漏斗」。） */
          if (route === 'asin-import' && req.method === 'POST') {
            const body = await readJson(req)
            const dryRun = body?.dryRun !== false
            const done = dryRun ? null : pageWrite('asin-import', body)
            const output = await asinImportTool({ store }).execute({ ...(body ?? {}) })
            if (output?.ok !== true) {
              return sendJson(res, output, ASIN_IMPORT_STATUS[output?.code] ?? 400)
            }
            if (done !== null) {
              workbench.record('asin:import', {
                created: output.summary?.created ?? 0,
                updated: output.summary?.updated ?? 0,
                skipped: output.summary?.skipped ?? 0,
              }, 'page')
              done(output)
            }
            return sendJson(res, output)
          }

          /* T70 评论分析触发器（lead 裁决 #1：a 案，本批唯一新增 POST）。
             入参 {asin, marketplace}；父 ASIN 走既有 resolveReviewFamily，不自写解析。
             四态分开：① 无评论 → NO_REVIEWS（不写 run，「还没有评论数据」≠ 0 痛点）；
             ② ASIN 不存在 → 404 ASIN_NOT_FOUND（**不自动建 ASIN 行**）；③ n<5 → 200 +
             insufficient:true（run 照写、标注不写）；④ 正常 → runId/样本/覆盖率。 */
          if (route === 'review-analysis-run' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('review-analysis-run', body)
            const asin = String(body?.asin ?? '').trim().toUpperCase()
            const market = String(body?.marketplace ?? '').trim().toUpperCase()
            if (asin === '' || market === '') {
              return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: 'asin 与 marketplace 必填' }, 400)
            }
            const row = getAsin(store, asin, market)
            if (row === undefined) {
              return sendJson(res, { ok: false, code: 'ASIN_NOT_FOUND', error: `${asin} (${market}) 不在库内` }, 404)
            }
            const parentAsin = resolveReviewFamily(store, { asin, marketplace: market })
            const family = readReviewFamily(store, { parentAsin, marketplace: market })
            if (family.length === 0) {
              return sendJson(res, {
                ok: false, code: 'NO_REVIEWS',
                error: '还没有评论数据，先采集再分析（「没有评论」不是「0 个痛点」）',
              }, 400)
            }
            const result = runReviewAnalysis({ store, parentAsin, marketplace: market, asin })
            done(result)
            return sendJson(res, { ok: true, ...result })
          }

          /* FR-M2-05 ①：归属（自有/竞品、产品线）的页面写路径。
             它调**同一个工具**（`asinOwnershipSetTool` → `setAsinOwnership`），
             所以页面与会话走的是同一条路、落同一个 `ACTIONS.asinOwnershipSet`。
             **它不写 `asin.product_line_id`** —— 那一列是缓存，由 `syncProductLineCache`
             从边刷出来；直接写它会被下一次归属写入刷掉且不留痕
             （见 `team/dev/derived-columns-2026-10-25.md`）。 */
          if (route === 'asin-ownership-set' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('asin-ownership-set', body)
            const output = await asinOwnershipSetTool({ store }).execute({
              asin: body?.asin,
              marketplace: body?.marketplace ?? 'US',
              objectType: body?.objectType,
              objectId: body?.objectId,
              revoke: body?.revoke === true,
              source: body?.source ?? 'manual',
              reason: body?.reason ?? null,
              by: body?.by ?? 'page',
            })
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('asin:ownership', {
              asin: String(body?.asin ?? ''), objectType: String(body?.objectType ?? ''),
              objectId: String(body?.objectId ?? ''), revoke: body?.revoke === true,
            }, 'page')
            done(output)
            return sendJson(res, output)
          }

          if (route === 'asin-field-correct' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('asin-field-correct', body)
            const output = await asinFieldCorrectTool({ store }).execute({
              asin: body?.asin,
              marketplace: body?.marketplace ?? 'US',
              field: body?.field,
              value: body?.value,
              reason: body?.reason ?? null,
              observedAt: body?.observedAt ?? null,
              sourceId: body?.sourceId ?? null,
              by: body?.by ?? 'page',
            })
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('asin:field-correct', {
              asin: String(body?.asin ?? ''), field: String(body?.field ?? ''),
            }, 'page')
            done(output)
            return sendJson(res, output)
          }

          if (route === 'asin-variant' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('asin-variant', body)
            const output = await asinVariantUpsertTool({ store }).execute({
              parentAsin: body?.parentAsin,
              childAsin: body?.childAsin,
              marketplace: body?.marketplace ?? 'US',
              sourceId: body?.sourceId ?? null,
              evidence: body?.evidence ?? null,
              dimensions: body?.dimensions ?? [],
              by: body?.by ?? 'page',
            })
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('asin:variant', {
              parent: String(body?.parentAsin ?? ''), child: String(body?.childAsin ?? ''),
            }, 'page')
            done(output)
            return sendJson(res, output)
          }

          if (route === 'asin-variant-correct' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('asin-variant-correct', body)
            const output = await asinVariantCorrectTool({ store }).execute({
              parentAsin: body?.parentAsin,
              childAsin: body?.childAsin,
              marketplace: body?.marketplace ?? 'US',
              reason: body?.reason ?? null,
              evidence: body?.evidence ?? null,
              by: body?.by ?? 'page',
            })
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('asin:variant-correct', {
              parent: String(body?.parentAsin ?? ''), child: String(body?.childAsin ?? ''),
            }, 'page')
            done(output)
            return sendJson(res, output)
          }

          if (route === 'asin-archive' && req.method === 'POST') {
            const body = await readJson(req)
            /* preview 是**读**，它的路由是上面的 GET。让它从这个 POST 进来，审计漏斗
               会在日志里留下一条「归档了」—— 一条关于没有发生的事的记录。所以这里
               显式拒绝，并指出正确的入口。 */
            if (String(body?.action ?? '').trim() === 'preview') {
              return sendJson(res, {
                ok: false,
                code: 'PREVIEW_IS_A_GET',
                error: '影响预览走 GET /api/asin-archive-impact —— 让它走写路由会在审计里留下一条假的归档记录',
              }, 400)
            }
            const done = pageWrite('asin-archive', body)
            const output = await asinArchiveTool({ store }).execute({
              action: body?.action,
              asin: body?.asin,
              marketplace: body?.marketplace ?? 'US',
              reason: body?.reason ?? null,
              by: body?.by ?? 'page',
              confirm: body?.confirm === true,
            })
            /* 409 是「请求本身没问题，但需要一个人」：归档闸门（`APPROVAL_REQUIRED`）
               属于这一类，页面的 `apiWithApproval` 就是按这个分支去问用户的。 */
            if (output?.ok !== true) return sendJson(res, output, output?.code === 'APPROVAL_REQUIRED' ? 409 : 400)
            workbench.record('asin:archive', {
              asin: String(body?.asin ?? ''), action: String(body?.action ?? ''),
            }, 'page')
            done(output)
            return sendJson(res, output)
          }

          /* B-05e / F05-08 —— 页面侧的删除入口。与 `amzn_asin_delete` 是**同一次操作**：
             `pageWrite('asin-delete', …)` 记的 action 与工具那条逐字相同
             （`ACTIONS.asinDelete`，`s1b12` 的守卫比对这两张表）。
             读动作（`delete_preview`）同样从这条 POST 上被拒 —— 它有自己的 GET 入口，
             从写路由进来会在审计里留下一条假的删除记录。 */
          if (route === 'asin-delete' && req.method === 'POST') {
            const body = await readJson(req)
            if (String(body?.action ?? '').trim() === 'delete_preview') {
              return sendJson(res, {
                ok: false,
                code: 'PREVIEW_IS_A_GET',
                error: '引用检查走 GET /api/asin-archive-impact 的 references 一格 —— 让它走写路由会在审计里留下一条假的删除记录',
              }, 400)
            }
            const done = pageWrite('asin-delete', body)
            const output = await asinDeleteTool({ store }).execute({
              action: body?.action,
              asin: body?.asin,
              marketplace: body?.marketplace ?? 'US',
              reason: body?.reason ?? null,
              by: body?.by ?? 'page',
              confirm: body?.confirm === true,
            })
            /* 409 是「请求本身没问题，但需要一个人」：删除的恒定确认（`APPROVAL_REQUIRED`）
               与「还有引用」（`ASIN_REFERENCED`）都是这一类 —— 两者都不是参数写错了。
               页面按 409 去问用户 / 去列引用，与归档那条同一个分支。 */
            if (output?.ok !== true) {
              const status = output?.code === 'APPROVAL_REQUIRED' || output?.code === 'ASIN_REFERENCED' ? 409 : 400
              return sendJson(res, output, status)
            }
            workbench.record('asin:delete', { asin: String(body?.asin ?? '') }, 'page')
            done(output)
            return sendJson(res, output)
          }

          /* ── B-13b / F13-01：草案收件箱的五个写动作 ──────────────────────────
             五个动作五个路由，与 `ACTIONS` 里那五条一一对应。合成一条
             `optimize-inbox` 会让审计回答不了「这次是作废还是恢复」—— 而那是要查的
             （与 snapshot-delete / snapshot-restore 同一条口径）。

             四个状态动作走 `applyInboxAction`（`domain/optimize/inbox.js`），它在写完
            之后**读回那一行、重算分组、与目标比对** —— 对不上就报 INBOX_STATE_MISMATCH，
             不谎报成功。这就是「状态必须能由内容重算出来」的机器可验证形式。

             四条状态路由**逐条写开**，而不是走一张 { route: action } 表：s1b12 的守卫
             按 route === '...' && req.method === 'POST' 的字面形态扫路由名，表驱动会让
             这四条在审计里**根本不存在**（守卫当场就红了，而那正是它该做的）。

             「基于此草案重新优化」建的是**一轮新运行**（不是改草案），所以它单独一条，
             走 `reoptimizeFromDraft`，并在建完之后冻结它的证据包 —— 新的一轮与 prepare
             建的那一轮在这一点上没有区别。 */
          /* ── F-7 第一块：优化页的「开跑」 ─────────────────────────────────────
             走的是**同一个工具** `amzn_optimize_prepare` 的 `execute`（与
             `asin-import` / `keyword-lifecycle-batch-set` 那几条页面路由同一条做法：
             直接调工具工厂的 execute）。所以：

               · 参数校验只有一套 —— ASIN 形状、模式与专项的取值、九门门槛，全在工具里；
               · 阻断时拿回的是 `precheckRefusal` 的形状（ok:false + 哪几门 + 缺什么），
                 路由原样转成 400，页面拿它写「哪一门阻断」；
               · 成功时工具返回的是渲染好的数据包文本（不是行），所以 run id 从
                 `listOptimizationRuns` 读最新一轮 —— 与页面读同一张表、同一个排序。
             页面上的按钮在阻断时是 disabled 的，所以这里的 400 是**第二道**：
             按钮状态与这里用的是同一个 `precheck.blocked`，不会出现「按钮能点、
             后端拒绝」这种两套判定。 */
          if (route === 'optimize-prepare' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('optimize-prepare', body)
            const output = await optimizePrepareTool({ store, workbench, pagePath }).execute(body ?? {})
            /* 成功时 execute 返回的是文本（渲染好的数据包），拒绝时返回的是对象。
               `ok === false` 只在拒绝分支成立 —— 用 `===` 而不是 falsy 判断，
               免得把「文本为空」也当成拒绝。 */
            if (output !== null && typeof output === 'object' && output.ok === false) {
              return sendJson(res, { ...output, runId: null }, 400)
            }
            const asin = String(body?.asin ?? '').trim().toUpperCase()
            const marketplace = String(body?.marketplace ?? 'US').trim().toUpperCase()
            const latest = listOptimizationRuns(store, { asin, marketplace, limit: 1 }).rows[0] ?? null
            const payload = {
              ok: true,
              runId: latest === null ? null : latest.id,
              status: latest === null ? null : latest.status,
              asin,
              marketplace,
            }
            workbench.record('optimize:prepare', payload, 'page')
            done(payload)
            return sendJson(res, payload)
          }

          if (route === 'optimize-draft-void' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('optimize-draft-void', body)
            const output = applyInboxStateAction(store, 'void', body)
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('optimize:inbox', inboxAuditNote(output), 'page')
            done(output)
            return sendJson(res, output)
          }

          if (route === 'optimize-draft-restore' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('optimize-draft-restore', body)
            const output = applyInboxStateAction(store, 'restore', body)
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('optimize:inbox', inboxAuditNote(output), 'page')
            done(output)
            return sendJson(res, output)
          }

          if (route === 'optimize-draft-defer' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('optimize-draft-defer', body)
            const output = applyInboxStateAction(store, 'defer', body)
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('optimize:inbox', inboxAuditNote(output), 'page')
            done(output)
            return sendJson(res, output)
          }

          if (route === 'optimize-draft-resume' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('optimize-draft-resume', body)
            const output = applyInboxStateAction(store, 'resume', body)
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('optimize:inbox', inboxAuditNote(output), 'page')
            done(output)
            return sendJson(res, output)
          }

          if (route === 'optimize-draft-reoptimize' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('optimize-draft-reoptimize', body)
            const runId = String(body?.runId ?? '').trim()
            const parent = runId === '' ? null : getOptimizationRun(store, runId)
            const output = reoptimizeFromDraft(store, { parentRun: parent, field: body?.field ?? null })
            if (output?.ok !== true) return sendJson(res, output, 400)
            /* 新轮次的证据包与 prepare 建的那一轮同批冻结：它同样是「这一轮开始时看到
               了什么」。没有它，新轮次会在证据包里显示成「还没有冻结」，而它其实刚刚开始。 */
            const fresh = getOptimizationRun(store, output.runId)
            freezeEvidence(store, output.runId, collectEvidence(store, { run: fresh }))
            workbench.record('optimize:inbox', {
              action: 'reoptimize', runId: output.runId, derivedFrom: output.derivedFrom, field: output.field,
            }, 'page')
            done(output)
            return sendJson(res, output)
          }

          /* ── B-13c / F13-05：确认这一轮的九项策略卡 ──────────────────────────
             「人工确认后进入生成」的门禁。确认走 `confirmStrategy`（domain/optimize/
             strategy.js），它在写完**读回那一行、重算门禁、与目标比对** —— 对不上就报
             STRATEGY_STATE_MISMATCH，不谎报成功。工具侧的门禁读的是同一个
             `strategyGate`，所以「页面说已确认、工具说未确认」不可能发生。
             body.items 可选：确认时可以改九项的文字（人工确认不是橡皮图章）。 */
          if (route === 'optimize-strategy-confirm' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('optimize-strategy-confirm', body)
            const output = confirmStrategy(store, {
              runId: body?.runId,
              items: Array.isArray(body?.items) ? body.items : null,
              by: body?.by ?? 'page',
            })
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('optimize:strategy', {
              runId: output.runId,
              action: 'confirm',
              edited: output.edited === true,
              unchanged: output.unchanged === true,
            }, 'page')
            done(output)
            return sendJson(res, output)
          }

          /* ── B-13c / F13-06：裁决这一轮的建议位置计划 ────────────────────────
             `accept` 会**写回模块 08 的新版本**，走的是 `decidePlanCheck` →
             08 的 `savePlan`（与 amzn_keyword_plan_save 同一个函数）。这个文件里没有、
             也不会有 `INSERT INTO keyword_plan` —— 「不产生第二份口径」的机制就是这一条。
             `decline` 只写 declined_at，**不碰 08**。 */
          if (route === 'optimize-plan-decide' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('optimize-plan-decide', body)
            const output = decidePlanCheck(store, {
              runId: body?.runId,
              decision: body?.decision,
              by: body?.by ?? 'page',
            })
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('optimize:plan-check', {
              runId: output.runId,
              decision: output.decision,
              writtenPlanId: output.writtenBack === null || output.writtenBack === undefined ? null : output.writtenBack.planId,
              writtenVersion: output.writtenBack === null || output.writtenBack === undefined ? null : output.writtenBack.version,
            }, 'page')
            done(output)
            return sendJson(res, output)
          }

          /* ── B-13d / F13-08：记录一条 Agent 审阅结论 ─────────────────────────
             走 `recordReview`（domain/optimize/review.js），它在写完**读回那一行、
             重算这一项的汇总状态、与这次意图比对** —— 对不上就报 REVIEW_STATE_MISMATCH。
             工具 `amzn_optimize_review` 用的是同一个函数、同一个 action，所以
             「页面记的」与「会话记的」在审计里是同一条。
             一条结论必须引用证据（{ kind, ref }），而 rule / draft / evidence 三种引用
             会被逐条解开 —— 引用一个不存在的规则会被拒在这里，不是在报告里被读者发现。 */
          if (route === 'optimize-review-record' && req.method === 'POST') {
            const body = await readJson(req)
            const done = pageWrite('optimize-review-record', body)
            const output = recordReview(store, {
              runId: body?.runId,
              itemId: body?.itemId,
              field: body?.field ?? '',
              conclusion: body?.conclusion,
              note: body?.note ?? null,
              evidence: body?.evidence ?? [],
              by: body?.by ?? 'page',
            })
            if (output?.ok !== true) return sendJson(res, output, 400)
            workbench.record('optimize:review', {
              runId: output.runId,
              itemId: output.itemId,
              field: output.field,
              conclusion: output.conclusion,
              state: output.state,
              unchanged: output.unchanged === true,
            }, 'page')
            done(output)
            return sendJson(res, output)
          }

          if (route === 'sections' && req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://x').searchParams
            const sections = query.get('sections')
            const result = buildSectionDetail({
              store,
              taskId: query.get('taskId'),
              asin: query.get('asin'),
              marketplace: query.get('marketplace'),
              sections: sections === null || sections === '' ? null : sections.split(','),
              includeRaw: query.get('includeRaw') === '1' || query.get('includeRaw') === 'true',
              includeDiff: query.get('includeDiff') !== '0',
            })
            if (result.ok !== true) return sendJson(res, result, collectHttpStatus(result.code))
            return sendJson(res, result)
          }

          sendJson(res, { ok: false, error: `no route ${req.method} ${pathname}` }, 404)
        } catch (error) {
          logger.warn?.(`[amazon-ops] api ${route} failed: ${error.message}`)
          sendJson(res, { ok: false, error: error.message }, 400)
        }
      },
    }), 'amazon-ops: workbench api')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: reportPath,
      handler(req, res) {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const tail = pathname === reportPath ? '' : decodeURIComponent(pathname.slice(reportPath.length + 1))
        /* F14-01 — `<pagePath>/report/body/<reportId>` serves a **generated** report's
           own Markdown (its body lives in `report.body`; there is no file to link to).
           Same prefix rather than a new one so the page's `url` builder has one shape,
           and the two branches cannot disagree about the base path.

           Served as `text/plain; charset=utf-8` on purpose: the body is Markdown the
           user (or their editor) reads, and rendering it as HTML would mean this
           route becomes an HTML sink for any content a builder ever emits. */
        if (tail.startsWith('body/')) {
          const reportId = tail.slice('body/'.length)
          const body = reportId === '' ? null : getReportBody(store, reportId)
          if (body === null) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end(`没有正文可显示的生成报告 ${reportId}\n\n`
              + '两种可能，报告本身都写得出是哪一种：\n'
              + '  · 这一行不是生成类报告（正文在 audit 之外的地方：优化 run 的 report_html，或磁盘上的文件）；\n'
              + '  · 这一行的 body 是空的 —— 那不是「正文是空的」，是它没有正文。\n')
            return
          }
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
          return
        }
        /* F14-10 — `<pagePath>/report/export/<reportId>/<format>` sends one artifact
           as a download. Three formats, and the decision of which ones exist is in
           `domain/reports/export.js` (`exportPlan`) — the same function the page's
           buttons come from, so a button cannot promise a format this route refuses.

           Why an attachment and not the inline view above: the inline view is one
           HTML page you read; an export is a file you keep, forward and open in
           Excel. `content-disposition` is the only difference the browser respects.

           A missing artifact answers **with the reason**, in text, at the status
           that matches it (404 for "this round has no such artifact", 400 for
           "there is no such format") — an empty 404 body would read as "the route
           is wrong", which is the silent-empty shape this repo refuses. */
        if (tail.startsWith('export/')) {
          const rest = tail.slice('export/'.length)
          const slash = rest.lastIndexOf('/')
          const reportId = slash === -1 ? rest : rest.slice(0, slash)
          const format = slash === -1 ? '' : rest.slice(slash + 1)
          const row = reportId === '' ? null : getReport(store, reportId)
          if (row === null) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end(`报告库里没有 ${reportId} 这一条\n\n`
              + '两种可能，两种都要分开看：\n'
              + '  · id 抄错了（报告 id 是报告库那一行的主键，不是优化运行 id）；\n'
              + '  · 这一条被删掉了（归档不会删行 —— 归档只是盖一个时间戳）。\n')
            return
          }
          /* `row.pointer` is the declared answer to "which column makes this row
             readable" (`REPORT_KIND_TABLE`, copied onto the hydrated row). Not a
             `kind === …` test: `B05T-⑦b` counts kind-id literals in this file as a
             copied column list, and that is what they were — four more spellings of
             one fact. */
          const pointsAtRun = row.pointer === 'ref'
          const run = pointsAtRun && row.refId !== null ? getOptimizationRun(store, row.refId) : null
          if (pointsAtRun && run === null) {
            res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end(`报告 ${row.id} 指向的运行 ${row.refId} 已经不在了 —— 引用还在、内容没了。\n`
              + '这不是「导出坏了」：优化报告的正文一直住在 optimization_run 那一行上，行没了就没有可导出的字节。\n')
            return
          }
          /* 生成类报告的正文不在 hydrated 行上（那一行只说「有没有」，不搬正文），
             所以字节从这里取一次交给 `exportArtifact` —— 不在导出模块里再写一遍
             `SELECT body`。 */
          const body = pointsAtRun ? null : getReportBody(store, row.id)
          const artifact = exportArtifact({ row, run, body, format })
          if (artifact.ok !== true) {
            res.writeHead(artifact.status ?? 400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end(`${artifact.message}\n\n（${artifact.code}；报告 ${row.id}，类型 ${row.kind}）\n`)
            return
          }
          res.writeHead(200, {
            'content-type': artifact.format.type,
            'content-disposition': attachmentHeader(artifact.filename, row),
            'content-length': Buffer.byteLength(artifact.body),
            'cache-control': 'no-store',
          })
          res.end(artifact.body)
          return
        }
        const runId = tail
        const run = runId === '' ? null : getOptimizationRun(store, runId)
        if (run === null || !run.report_html) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(notFoundPage(runId))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(run.report_html)
      },
    }), 'amazon-ops: report view')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: eventsPath,
      handler(req, res) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          // Tells any reverse proxy not to buffer, which would defeat streaming.
          'x-accel-buffering': 'no',
        })
        res.write(': open\n\n')

        const send = (event) => {
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
          } catch {
            // The socket is gone; `close` will clean up.
          }
        }

        send({ at: nowIso(), kind: 'hello', origin: 'plugin', payload: { recent: workbench.recent(20) } })
        const unsubscribe = workbench.subscribe(send)
        const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
        heartbeat.unref?.()

        req.on('close', () => {
          clearInterval(heartbeat)
          unsubscribe()
        })
      },
    }), 'amazon-ops: workbench events')

    logger.info?.(`[amazon-ops] workbench ready at ${pagePath}`)
    /* Deliberate console, not a stray debug print: the host's logger may be
       silent (the pipeline-host harness runs with a quiet logger), and the page
       URL is the one line an operator cannot find another way — without it,
       "the page did not register" and "I opened the wrong path" look identical.
       Two channels for two audiences: the logger for the host's own log, stdout
       for the human who launched it. */
    console.log(`[amazon-ops] workbench page: ${pagePath}  (store=${store.file})`)
  })

  async function buildState() {
    /* 契约 §5.4：「等待人工」的 30 分钟超时**没有定时器**，页面的 3 秒轮询就是那次心跳。
       扫描按状态选行、幂等，所以每次轮询跑它没有副作用；失败不阻断 —— 一个扫不动超时的
       工作台不该因此打不开。 */
    try {
      collection.scanWaitingTimeouts?.()
    } catch (error) {
      logger?.warn?.(`[amazon-ops] waiting timeout scan skipped: ${error.message}`)
    }
    const context = workbench.get()
    const filters = context.filters ?? {}
    const limit = Number.isFinite(Number(filters.limit)) ? Number(filters.limit) : 100
    /* The ASIN list comes from `queryAsins`, not from an inline copy of its SQL.
       There was a second copy here once, and it had drifted: it selected only
       `keyword_count` / `keyword_gap` while the page also drew `keyword_ranked`
       and `keyword_unscanned`, so two columns rendered the literal `undefined`
       and nothing errored. One implementation, no drift.
       Lazy like the slices below, with arithmetic behind it: the page re-polls
       /api/state every three seconds **while a collection runs** — exactly when
       the server is busiest — the query returns up to 500 joined rows, and the
       only reader of those rows is `renderTable`, the ASIN panel. During a
       collection watched from the collect panel, those rows were serialized and
       shipped every tick for nobody, and `total` is read by the same panel, so
       both go lazy together. Kept as `null` rather than `[]`: "not fetched" and
       "fetched and empty" are different facts, and the page's empty-state test
       knows the difference. */
    const listing = context.module === 'asin'
      ? asinListingForPage(store, filters, Math.min(Math.max(limit, 1), 500))
      : null

    /* ASIN 组合概览：这一批 ASIN 的内容完整度分级与缺口。
       学的是 WSL 那套系统 AsinList.vue 顶部那排统计 —— 列表页要能先回答
       "先看哪一批、该补什么"，而不是让人从头翻表。
       它**不是**健康度：43 属性覆盖与九道门在 amzn_asin_health 里，一条一算。 */
    const asinPortfolioSummary = context.module === 'asin'
      ? asinPortfolio(store, { marketplace: filters?.marketplace ?? null })
      : null

    /* F05-01 的另外三样，同样只在 ASIN 模块下取：
         · `asinColumns` —— 列目录（id / 列名 / 有没有来源 / 没有来源时的解释）。
           页面照它画表头与列选择器，**不写第二份清单**。
         · `asinVisibleColumns` —— 这一次生效的列（`filters.asinCols` 收敛之后）。
           认不出的 id 也报出来（`asinUnknownColumns`）：用户存过一个视图、列改名了，
           症状是「打开发现少了几列」而没有任何东西说为什么。
         · `asinSavedViews` —— 这个空间里存下来的视图。页面加载一个视图就是把它里面的
           筛选与列配置**交回** `filters`，查询照常发生（视图存的是输入，不是结果）。
       `null` 而不是 `[]` 用于非 asin 模块：与 listing 同一条约定，让页面能分开
       「没取」与「取了但空」。 */
    const asinColumns = context.module === 'asin' ? asinColumnCatalog() : null
    const resolvedColumns = context.module === 'asin'
      ? resolveAsinColumns(filters.asinCols)
      : null
    const asinSavedViews = context.module === 'asin'
      ? listAsinSavedViews(store, { workspaceId: scopeWorkspaceId() })
      : null
    /* 筛选控件的候选值。产品线来自 `product_line`（它有自己的名字），品牌来自
       `asin.brand` 的**全库**去重值 —— 只从这一屏的行里收集的话，一个筛选器会
       随着你选中的东西把自己越缩越小，而用户看不出那是它干的。 */
    const asinFilterOptions = context.module === 'asin'
      ? {
        productLines: listProductLines(store, { limit: 200 }).rows.map(row => ({
          id: row.id, name: row.name, asinCount: Number(row.asin_count ?? 0),
        })),
        brands: store.all(
          `SELECT DISTINCT brand FROM asin
            WHERE brand IS NOT NULL AND TRIM(brand) <> ''
            ORDER BY brand LIMIT 200`,
        ).map(row => String(row.brand)),
      }
      : null

    /* 模块 05 F05-08：全库有多少条已归档。它**不是** `listing.total` 的一部分 ——
       列表读的是「按筛选能看到的行」，归档的行在里面看起来和别的行一样。数字是
       `null` 时表示**这一次没读出来**，而那不是 0：页面上「0 条已归档」与
       「这个数读不出来」必须是两句不同的话（`archivedAsinCount` 的注释写了为什么）。
       非 asin 模块是 `null`，含义是「没取」—— 这一格只有 ASIN 面板画，所以两条路径
       不会在同一页上撞车。 */
    const archivedAsins = context.module === 'asin' ? archivedAsinCount(store) : null

    // The keyword library is only fetched for the module that shows it. One
    // filter bag serves both modules on purpose — `marketplace` and `q` mean the
    // same thing to each, so switching tabs keeps the scope you were looking at
    // instead of silently resetting it.
    const keywords = context.module === 'research'
      ? queryKeywords(store, {
        marketplace: filters.marketplace,
        q: filters.q,
        tier: filters.tier,
        order: filters.order,
        limit: Math.min(Math.max(limit, 1), 500),
      })
      : null

    // The imported-data library, fetched only for its own module. It is a
    // different table over different tables from `keywords` above: that one is
    // browser measurements of our ASINs, this one is what export files said
    // about the words. Loading it always would make every ASIN-list poll carry
    // a hundred master rows nobody asked for.
    const master = context.module === 'kw' ? masterState(store, filters, context.selection) : null

    // The pipeline's run log, fetched only for its own module — the same lazy
    // pattern as `master` and `rules`. The list is small, but it is read on
    // every state poll, and loading it while the user is looking at the ASIN
    // list would be cost with no reader.
    const pipeline = context.module === 'pipeline' ? pipelineState(store, filters) : null

    /* The competitor panel: the saved sets plus the diff for the one being looked
       at. Lazy like the rest — it reads `asin_keyword`, `kw_competitor_fact` and
       `kw_master` in one go, and the ASIN list does not need any of it. */
    const competitor = context.module === 'competitor'
      ? competitorState(store, filters, context.selection)
      : null

    /* Research candidates, from the seeds in the page's own box. Only the two
       sources that need no browser (see `researchState`). Lazy for the same
       reason as the others: it is a merge over three tables. */
    const research = context.module === 'research' ? researchState(store, filters) : null

    // Coverage for a single selected ASIN. The page's job is to show the
    // object; deciding what to do about it is the agent's, via a prompt.
    const selected = context.selection?.asins ?? []
    const coverage = selected.length === 1
      ? keywordCoverage(store, selected[0].asin, selected[0].marketplace, { limit: 50 })
      : null

    /* F-4：优化页自带 ASIN 选择（PRD 的 G-2：进入主流程点击 ≤5）。
       它只需要「库里有哪些 ASIN」这一小撮 —— 不是整张 ASIN 表（列目录 / 视图 /
       筛选候选 / 组合概览都不带）。走的是与 ASIN 列表**同一个读取口**
       (`queryAsins`)，所以「库里有什么」不可能在两处给出两个答案；`archived: 'hide'`
       与列表默认口径一致（已归档的不该出现在「跑优化」的候选里）。

       ⚠️ 它挂在 `optimizations` 里面，**不另开一个顶层 state 键**：页面脚本有一条
       守卫「页面读的每个 `state.x` 都必须被赋值」（run.mjs 的 slice 守卫），而赋值
       那一列写在 page.js 的 refresh 里 —— 那不在本单写域。挂在已经赋值的
       `state.optimizations` 下，守卫的口径不变（仍然「页面读的东西都由 state 端点喂」），
       也不用去动别人的文件。 */
    const optimizeAsinOptions = context.module === 'optimize'
      ? (() => {
        const read = queryAsins(store, {
          marketplace: filters.marketplace,
          archived: 'hide',
          limit: OPTIMIZE_ASIN_OPTION_LIMIT,
        })
        return {
          rows: read.rows.map(row => ({
            asin: row.asin, marketplace: row.marketplace, title: row.title ?? null,
          })),
          total: read.total,
          limit: OPTIMIZE_ASIN_OPTION_LIMIT,
        }
      })()
      : null

    // Runs are fetched only for the optimize module, and the drafts of just one
    // run — the selected one, or the newest. Loading every run's drafts would
    // make this endpoint's cost grow with the history for no benefit, since the
    // panel shows one at a time.
    const optimizationBase = context.module === 'optimize'
      ? optimizationState(store, filters, pagePath, context.contextId ?? null)
      : null
    /* `null` 原样保留（不把它摊成 `{}`）：这个字段的 null 有含义，页面按
       `data ? data.rows : []` 读 —— 摊平之后 `data.rows` 是 undefined，
       接着 `runs.length` 就会炸。 */
    const optimizations = optimizationBase === null
      ? null
      : { ...optimizationBase, asinOptions: optimizeAsinOptions }

    // The rule roster, fetched only for its own module — same lazy pattern as
    // `master` above. It is a different table over different tables again: the
    // rule set, not the keyword library.
    const rules = context.module === 'rules' ? rulesState(store, filters) : null

    // The policy library, fetched only for its own module — same lazy pattern as
    // `rules` above, over a different pair of tables again. It is the upstream of
    // the rule roster: a policy is the input, a rule is the product.
    const policy = context.module === 'policy' ? policyState(store, filters) : null

    /* The report registry. Lazy like the rest: it is a second table over
       `optimization_run` + the filesystem, and the ASIN list has no reader for it.
       `reportCounts` rides along so the page can draw the kind tabs without a
       query per tab — and so a tab that is empty says "0 of that kind" rather than
       quietly disappearing. */
    const reports = context.module === 'report' ? reportState(store, filters, pagePath) : null

    /* The snapshot registry, fetched only for the module that shows it (数据资产
       与质量). Same lazy pattern again: it indexes six other tables, and the ASIN
       list has no reader for any of it. The slice carries the tab vocabulary and
       the per-type counts so a tab that is empty says "0 of that kind" — and each
       declared type this version registers no row for carries its reason
       (`objectTypes[].pendingReason`) so it does not look forgotten. */
    const snapshots = context.module === 'quality' ? snapshotView(store, filters) : null

    /* The retention slice (S1-B19), lazy for the same reason and for the same
       module: it walks the reference graph over the whole registry, and no other
       panel has a reader for it. It carries the per-snapshot referrer info keyed
       by id so the snapshot tab can annotate each row — "被引用 N" and a disabled
       delete button — without a per-row round trip, plus the summary that names
       which object types have no referrer at all. */
    const retention = context.module === 'quality' ? retentionView(store, { includeDeleted: true }) : null

    /* 通知（S1-B16）。**半懒**：铃在顶栏，未读数是每一页都要显示的一个数字，所以那个
       COUNT 每次都跑（它是一次索引查找）。列表只在面板真的开着时才读——那是唯一会
       随通知数量增长的部分。
       关着的时候 `rows` 是 `null` 而不是 `[]`：`[]` 是「这一类没有东西」，
       `null` 是「没读」，页面据此不画列表。 */
    const notificationsOpen = String(filters.notificationsOpen ?? '') === '1'
    const notifications = notificationsOpen
      ? notificationView(store, filters)
      : { rows: null, unread: unreadCount(store), counts: null, keepDays: KEEP_DAYS, filters: { kind: '' } }

    /* The source list is resolved once, before the slices that need it. It is
       awaited here rather than inline in the payload because `settingsState`
       reads it too — and passing the *service* instead of the resolved list is a
       runtime `TypeError` (`(sources ?? []).map is not a function`) that takes
       the whole settings panel down with a 400. One resolution, one shape. */
    const sourceList = await sources.list({ checkHealth: true })

    /* Redacted separately from `sourceList`: the health-checked list is what the
       collection panel wants (live status per source), the redacted one is what
       the settings panel wants (field names, never values, and readable with the
       network down). `listSourcesRedacted` is async, so it is awaited here rather
       than inline — an un-awaited Promise in the payload would arrive at the page
       as `{}` and the sources block would render empty with no error. */
    const redactedSources = context.module === 'settings' ? await listSourcesRedacted(store) : null

    /* The settings surface. Three things it may show and one it may not:
       the declared preferences (editable), the per-marketplace postal codes
       (editable), and the redacted source rows (field names only). Verified market
       facts — title caps, character units — are read from `marketplaces.js` and
       shown **read-only**, because a page that offers to edit them is offering to
       edit the answer to "is this title legal". Secrets never appear at all. */
    const settings = context.module === 'settings'
      ? settingsState(store, filters, collection, sourceList, redactedSources, context.scope?.workspaceId, context.selection, browserChannel)
      : null

    /* 店铺管理页的惰性切片（P2 / ADR-004）。 */
    const shops = context.module === 'shops'
      ? shopsState(store, filters, scopeWorkspaceId())
      : null

    /* The dashboard's six cards, its four todo buckets, the five kinds of thing
       the workbench produces, the six quick actions, and the three-step
       first-run guide. Lazy like every other slice: they read a dozen different
       groups of tables, and a state poll for the ASIN list has no reader for any
       of it. `homeState` is a named function rather than an inline object
       because the guide's third step reads the cards. */
    const home = context.module === 'home' ? homeState(store, context.scope ?? {}, filters) : null

    /* The quality module's four views. Lazy like the rest: the catalogue counts
       fifteen tables in one go, and the lineage traces seven fields over three
       more. Neither has a reader while the user is looking at the ASIN list. */
    const quality = context.module === 'quality' ? qualityState(store, context, filters) : null

    /* 模块 12：任务画布。跟着模块走，和别的惰性切片一样 —— 它要读运行、步骤、
       产物三张表，只有看着这一页的人有读者。 */
    const agent = context.module === 'agent' ? agentState(store, filters) : null

    /* The prompt library is NOT lazy. The aside buttons ("丢给 agent") are drawn
       on every module and depend on the current module and selection, so the
       resolved button list has to ride along with every state read. It is tiny —
       at most one module's buttons plus the shared one. The editor's full set list
       is only built for the prompts module, because that is the only panel that
       shows it. */
    const prompts = promptState(store, context, rules)

    return {
      ok: true,
      context,
      asins: listing === null ? null : listing.rows,
      total: listing === null ? null : listing.total,
      archivedAsins,
      /* B-05e 的读回对账四格，全部来自**这一次真的生效**的查询（`listing`），
         不是页面自己再算一遍：
           · `asinArchived`       —— 实际生效的口径（页面回显它，所以控件说的与查的一致）；
           · `asinArchivedHidden` —— 这一屏按在架口径挡掉了多少条（`only`/`all` 下是 0，是事实）；
           · `asinArchivedTotal`  —— 与 `archivedAsins` 同源（`archivedAsinCount`）的第二个读点；
           · `asinArchivedFilterError` —— 上下文里的筛选值认不出时的原话（见
             `asinListingForPage`），页面必须把它说出来而不是装作筛的就是它。 */
      asinArchived: listing === null ? null : listing.archived,
      asinArchivedHidden: listing === null ? null : listing.archivedHidden,
      asinArchivedTotal: listing === null ? null : listing.archivedTotal,
      asinArchivedFilterError: listing === null ? null : (listing.archivedFilterError ?? null),
      /* F05-01：列目录 / 生效列 / 认不出的列 id / 保存视图 / 筛选候选值。
         五样都跟着模块走（`null` = 没取），与 asins 同一条约定。 */
      asinColumns,
      /* 组合概览：内容完整度分级 + 缺口。页面顶部那排统计读它。 */
      asinPortfolio: asinPortfolioSummary,
      asinVisibleColumns: resolvedColumns === null ? null : resolvedColumns.ids,
      asinUnknownColumns: resolvedColumns === null ? null : resolvedColumns.unknown,
      asinSavedViews,
      asinFilterOptions,
      keywords: keywords === null ? null : { rows: keywords.rows, total: keywords.total },
      master,
      /* 模块 08 F08-04：页头的「N 起所有权冲突」徽标。**不跟着模块走** —— 徽标在顶栏，
         每一页都要显示，和通知未读数同一类（那一个也是每次 state 都跑）。它读的是
         store 自己的 `keywordOwnershipStats`，与工作台表同一份推导，所以徽标与表格不会
         对「这个词算不算冲突」给出两个答案。 */
      ownershipStats: keywordOwnershipStats(store, {}),
      pipeline,
      competitor,
      research,
      rules,
      policy,
      reports,
      snapshots,
      retention,
      notifications,
      settings,
      shops,
      home,
      quality,
      agent,
      prompts,
      coverage: coverage === null ? null : {
        asin: coverage.asin,
        marketplace: coverage.marketplace,
        summary: coverage.summary,
        gaps: coverage.gaps.slice(0, 10),
      },
      optimizations,
      tiers: TIERS.map(tier => ({ id: tier, label: `${tier} ${TIER_LABELS[tier]}`, meaning: TIER_MEANING[tier] })),
      status: counts(store),
      sources: sourceList,
      // Collection progress is the one thing on this page that changes without
      // anyone clicking, so it rides along with state instead of needing its own
      // route — the page already re-fetches state on every agent tool event.
      collection: collectionSummary(collection, store),
      tasks: collection.list(15).tasks.map(collectTaskRow),
      /* 模块 04 第二子批：采集面板的只读切片（契约 §6.3）。13 节明细**不随 state 全量
         下发** —— 页面每 3 秒轮询一次，全量下发会把轮询变成一次几百 KB 的搬运。这里只给
         `selectedTask` 的逐 ASIN 摘要，节明细走 `GET /api/sections`。
         `sources` / `selection` / 工作区是**有理由的入参**而不是顺手的上下文：来源通道决定
         预填的默认字段范围（`prefillFor` 要 supported），选中项是外部入口带过来的目标，
         工作区决定站点块读谁的行 —— 少一个都会让横幅或站点表按另一份默认值答话。 */
      collectPanel: collectionPanel(store, filters, {
        sources,
        selection: context.selection,
        workspaceId: context.scope?.workspaceId ?? null,
        collection,
      }),
      /* P3-4 命令面板（Ctrl+K）的**数据**，放在载荷顶层而不是 `home` 里：
         它是个全局操作，站在 ASIN 页按 Ctrl+K 也必须能开。放在 `home` 下会让
         `homeState` 的惰性切片决定它的有无（只有 module==='home' 才算），
         于是"在别的页签按快捷键没反应"——一个只在特定页签工作的全局功能。
         21 条命令（15 模块 + 6 动作），不含数据类；数据类留给首页那个搜索框，
         因为它要服务端查十类实体，不该被每次轮询带上。 */
      commandPalette: commandPalette({
        query: '',
        groups: MODULE_GROUPS,
        actions: buildQuickActions(),
      }),
    }
  }
}

/**
 * The rule roster's data for the page: the version list, the viewed version's
 * rules, the kind/severity counts, and the two gaps against the manual.
 *
 * The gaps are the point of showing this on a page at all. `rulesWithoutDoc` are
 * `kind='code'` rules whose `source` cites no section of the manual — a judgement
 * with no published origin. `docsWithoutCheck` are manual sections no code rule
 * answers to — prose that cannot be judged, and the reason "导入手册" must not be
 * read as "规则就绪". A gap that only exists in a tool's output is a gap nobody
 * looks at.
 *
 * The two gaps are measured against the manual itself (parsed on demand), not
 * against the stored doc rows, so the numbers mean the same thing before and
 * after an import: 21 rules the manual does not document, 18 sections no code
 * rule answers to. An unreadable manual degrades to empty lists plus `manualError`,
 * never to a silent zero. `implMissing` is the third, different hole — a roster
 * `code` row with no `CHECKS` implementation — and it is computed from the roster
 * alone, with no manual involved.
 *
 * Disabled rules are included in `rows` (with `enabled:false`) so the checkbox
 * reflects the real state; `loadActiveRoster` would have dropped them.
 */
function rulesState(store, filters) {
  const versions = listVersions(store)
  const active = versions.find(version => version.is_active === 1) ?? null
  const requested = filters.ruleVersion ? String(filters.ruleVersion) : ''
  /* The requested version if it exists, else the active one, else the code seed
     (a store with no roster at all — reported with `fromCode`, never hidden). */
  const loaded = (requested !== '' ? loadRosterVersion(store, requested) : null)
    ?? (active !== null ? loadRosterVersion(store, active.version) : null)
  const roster = loaded ?? loadActiveRoster(store)

  const stats = { total: roster.rules.length, block: 0, warn: 0, code: 0, lexicon: 0, threshold: 0, doc: 0 }
  for (const rule of roster.rules) {
    const kind = rule.kind ?? 'code'
    stats[kind] = (stats[kind] ?? 0) + 1
    stats[rule.severity] = (stats[rule.severity] ?? 0) + 1
  }
  const byId = new Map(roster.rules.map(rule => [rule.id, rule]))
  /* Which policies touch each rule — the "受政策 X 影响" column on the rules tab.
     Read once for the whole table rather than per row: it is a join over two small
     tables, and doing it per row would be the same query 72 times. */
  const policyByRule = policyLinksByRule(store)

  let gaps = { rulesWithoutDoc: [], docsWithoutCheck: [] }
  let manualError = null
  let manualCount = 0
  try {
    const parsed = readManual()
    manualCount = parsed.docs.length
    gaps = documentationGaps(roster.rules, parsed.docs)
  } catch (error) {
    manualError = error.message
  }

  return {
    versions: versions.map(version => ({
      version: version.version,
      isActive: version.is_active === 1,
      ruleCount: version.rule_count,
      enabledCount: version.enabled_count,
      publishedAt: version.published_at,
      note: version.note,
    })),
    version: roster.version,
    isActive: loaded ? loaded.isActive : true,
    fromCode: roster.fromCode === true,
    source: roster.source,
    manualCount,
    manualError,
    rows: roster.rules.map(rule => ({
      id: rule.id,
      kind: rule.kind ?? 'code',
      appliesTo: rule.appliesTo ?? [],
      scope: rule.scope,
      severity: rule.severity,
      title: rule.title,
      source: rule.source,
      enabled: rule.enabled !== false,
      policies: policyByRule.get(rule.id) ?? [],
    })),
    stats,
    rulesWithoutDoc: gaps.rulesWithoutDoc.map(id => {
      const rule = byId.get(id)
      return {
        id,
        kind: rule?.kind ?? 'code',
        appliesTo: rule?.appliesTo ?? [],
        title: rule?.title ?? '',
        source: rule?.source ?? '',
      }
    }),
    docsWithoutCheck: gaps.docsWithoutCheck.map(id => ({ id, title: byId.get(id)?.title ?? '' })),
    /* The third hole, and a different kind from the other two: a roster row that
       says "this is a code rule" while `CHECKS` has no function for it — the data
       and the code have diverged. `validate` reports it as `rule-check-missing`
       and blocks, and this is the only place that decision is visible as a red
       bar rather than a line in a report. */
    implMissing: missingChecks(roster.rules).map(id => {
      const rule = byId.get(id)
      return { id, kind: rule?.kind ?? 'code', appliesTo: rule?.appliesTo ?? [], title: rule?.title ?? '', source: rule?.source ?? '' }
    }),
  }
}

/**
 * The policy library's data for the page: the recent policies, the rule roster the
 * link control offers, and the counts.
 *
 * Two things here are deliberately not smoothed over:
 *
 *   - `severityHint` is sent as `null` when the policy never said, so the page can
 *     draw 「未判定」 instead of a severity nobody stated — and `severityRaw` carries
 *     the phrase the level was read from, so the chip can show 「高（原文：「必须立即
 *     整改」）」 rather than a bare level that reads like a label Amazon gave.
 *   - `sinceExcluded` counts the policies whose effective date could not be read.
 *     They are excluded by a `since` filter (a policy cannot take effect after a
 *     date it does not carry), and the page says how many were set aside rather
 *     than returning a silently shorter list.
 *
 * The `rules` list is the active roster's `kind='code'` rows — the things a policy
 * can affect. It comes from `loadRosterVersion`, not `loadActiveRoster`, so a rule
 * that is currently switched *off* is still offered: the rules tab draws disabled
 * rows too, and the two panels must agree about what a rule is. `doc` rows are
 * manual sections, not judgements, so they are not offered as link targets.
 */
function policyState(store, filters) {
  const marketplace = filters.policyMarketplace ? String(filters.policyMarketplace).toUpperCase() : null
  const status = filters.policyStatus ? String(filters.policyStatus) : null
  const since = filters.policySince ? String(filters.policySince) : null
  const listed = listPolicies(store, { marketplace, status, since })
  const active = listVersions(store).find(version => version.is_active === 1) ?? null
  const roster = (active !== null ? loadRosterVersion(store, active.version) : null) ?? loadActiveRoster(store)

  return {
    rows: listed.rows.map(row => ({
      id: row.id,
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      sourceKind: row.sourceKind,
      marketplace: row.marketplace,
      title: row.title,
      body: row.body_md,
      url: row.url,
      publishedAt: row.publishedAt,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      severityHint: row.severityHint,
      severityRaw: row.severityRaw,
      status: row.status,
      supersededBy: row.supersededBy,
      /* The reverse direction — the ids this policy replaced. Only derivable from
         the stored forward links, and the page needs it to draw 「取代了谁」. */
      supersedes: row.supersedes,
      fields: row.fields,
      rules: row.rules,
      importedAt: row.importedAt,
    })),
    total: listed.total,
    sinceExcluded: listed.sinceExcluded,
    filters: { marketplace, status, since },
    sources: listPolicySources(store).map(source => ({ id: source.id, name: source.name, kind: source.kind })),
    rules: roster.rules
      .filter(rule => String(rule.kind ?? 'code') === 'code')
      .map(rule => ({ id: rule.id, title: rule.title })),
    stats: policyStats(store),
    /* S2-T72：候选区（最新 run + 候选行 + 计数）。没有 run 时 latestRun:null ——
       「没检索过」不是「0 条候选」。 */
    candidates: policyCandidateView(store, { defaultQuery: DEFAULT_POLICY_QUERY }),
  }
}

/**
 * The report centre's data.
 *
 * Before F14-01 this answered three axes (kind, ASIN, marketplace, since) and
 * carried `counts` — which the page used to draw its chips **from a second copy of
 * the three kind labels it kept itself**. That copy is gone: `kinds` below is the
 * store's `REPORT_KIND_TABLE`, so a kind added there appears on the page with its
 * label, and a label changed there changes on both sides or neither.
 *
 * `openable` is carried through rather than filtered on. A report whose body is
 * gone is still a report this workbench produced, and hiding it would make the
 * history read as complete; the page prints 「取不回」 instead, which is the honest
 * version and the one that prompts someone to look into why.
 *
 * `status` is the **recomputed** three-state answer, and the same string the filter
 * accepts — one vocabulary, so a chip and a filter option cannot disagree.
 *
 * `url` is built here for the same reason `optimizationState` builds it: the page
 * must not own a second copy of the route shape. Three cases:
 *   - an optimization report → its run's `report_html` (`/report/<runId>`);
 *   - a generated report → its own row's body (`/report/body/<reportId>`);
 *   - a file report → `null`, because there is no in-page viewer for a CSV and a
 *     link that 404s is worse than a path the user can paste.
 */
function reportState(store, filters, pagePath) {
  const kind = filters.reportKind ? String(filters.reportKind) : null
  const status = filters.reportStatus ? String(filters.reportStatus) : null
  const listed = listReports(store, {
    kind: kind !== null && REPORT_KINDS.includes(kind) ? kind : null,
    asin: filters.reportAsin ?? null,
    marketplace: filters.marketplace ?? null,
    productLine: filters.reportProductLine ?? null,
    status: status !== null && (status === 'all' || REPORT_STATUSES.includes(status)) ? status : null,
    createdBy: filters.reportCreatedBy ?? null,
    favorite: filters.reportFavorite === true || filters.reportFavorite === '1' || filters.reportFavorite === 1,
    tag: filters.reportTag ?? null,
    since: filters.reportSince ?? null,
    limit: clampInt(filters.reportLimit, 1, 500, 100),
  })

  const counts = reportCounts(store)
  const creators = reportCreators(store)

  /* F14-10 — 哪些优化报告真的有那三份字节：**一条读库**（`optimizationArtifactMap`），
     不是每行一次 `getOptimizationRun`。这一页 3 秒轮询一次、最多 100 行，逐行查询会把
     一次状态轮询变成 100 次带上三个 blob 的 `SELECT *`。判据不在这个文件里：批量读与
     单条导出都走 `domain/reports/export.js#availabilityOf`（见那个函数的文件头），
     所以页面上的按钮不会承诺一个路由拒绝的格式。非 ref 类报告根本不进这条查询。 */
  const availability = optimizationArtifactMap(
    store,
    listed.rows.filter(row => row.pointer === 'ref' && row.refId !== null).map(row => String(row.refId)),
  )

  return {
    rows: listed.rows.map(row => {
      /* One `exportPlan` call per row: the links, the reasons and the count are all
         read off the same object (calling it twice is how the count and the links
         start to disagree on a day someone edits one branch). */
      const plan = exportPlan({
        row,
        has: row.pointer === 'ref'
          ? (availability.get(String(row.refId)) ?? { md: false, html: false, xlsx: false })
          : { md: row.hasBody === true, html: false, xlsx: false },
        pagePath,
      })
      return {
        id: row.id,
        kind: row.kind,
        kindLabel: row.kindLabel,
        scope: row.scope,
        scopeLine: reportScopeLine(row.scope),
        title: row.title,
        createdAt: row.createdAt,
        note: row.note,
        openable: row.openable,
        status: row.status,
        statusLabel: row.statusLabel,
        path: row.path,
        refId: row.refId,
        hasBody: row.hasBody,
        favorite: row.favorite,
        tags: row.tags,
        createdBy: row.createdBy,
        archivedAt: row.archivedAt,
        archivedBy: row.archivedBy,
        archiveReason: row.archiveReason,
        url: row.pointer === 'ref' && row.refId !== null
          ? `${pagePath}/report/${encodeURIComponent(row.refId)}`
          : (row.hasBody ? `${pagePath}/report/body/${encodeURIComponent(row.id)}` : null),
        /* F14-10 — 这一行能导出成什么、每个链接指向哪里、不能导的那几个为什么。
           `exportPlan` 是唯一判定处：页面只渲染这几条，不自己拼 URL，也不自己猜
           「有没有」。`available === false` 的条目也下发 —— 页面要能在按钮的位置
           说出理由，而不是画一个点不动的灰块。 */
        exports: { note: plan.note, formats: plan.formats },
        exportable: plan.formats.filter(entry => entry.available).length,
      }
    }),
    total: listed.total,
    matched: listed.matched,
    /* P2-4 月度花费。**先读清它统计的是什么**：本仓没有「采集成本」这个概念
       （采集走本地浏览器，不按次计费），所以这里做的是**广告花费**月报，
       数据来自运营导入的广告报告（`kw_ad_fact`）。`subject` 字段会把这句话
       一并带给页面，避免读者把它当成采集成本。
       聚合规则在 `domain/reports/spend-monthly.js`：同一 (keyword, marketplace,
       period) 被多份文件覆盖时取较大的那份而不求和 —— 否则花费会翻倍。 */
    spendMonthly: spendReport(
      store.all(
        /* T-3 的缺失标记**必须一起 SELECT**：`spend-monthly.js` 靠 `spend_missing` /
           `sales_missing` 判断「这一行没取到花费」。这两列不读出来，月桶的
           `missing.spend` 就永远不响 —— 而 `t73h` 用 `SELECT *`，所以它绿。
           这就是「测试绿、线上不生效」（dev-10 2026-10-25 抓到，lead 复核确认）。 */
        `SELECT keyword, marketplace, period, source_file, clicks, orders, spend, sales,
                spend_missing, sales_missing,
                first_date, last_date
           FROM kw_ad_fact`,
      ),
      { month: filters.reportSpendMonth ? String(filters.reportSpendMonth) : null },
    ),
    /* The kind table itself, label and writer included. This is what replaces the
       page's own `REPORT_KIND_LABELS`. */
    kinds: counts.kinds,
    counts,
    byStatus: counts.byStatus,
    /* The facet values that actually occur, so each select offers only real ones
       instead of a hand-written list that drifts from the data. `creators.unrecorded`
       is its own number: 「没人记录过」 is a fact about the rows, not a missing value. */
    facets: {
      creators: creators.named,
      creatorsUnrecorded: creators.unrecorded,
      productLines: reportProductLines(store),
      tags: reportTags(store),
    },
    /* Only the eight generated kinds can be built by a button; the three indexed
       ones are written by the work that produces them. The page draws the build
       controls from this list, not from a copy. */
    buildable: GENERATED_KINDS.map(id => {
      const entry = counts.kinds.find(spec => spec.id === id)
      return { id, label: entry?.label ?? id }
    }),
    statuses: REPORT_STATUSES,
    filters: {
      kind: kind !== null && REPORT_KINDS.includes(kind) ? kind : '',
      asin: filters.reportAsin ? String(filters.reportAsin).toUpperCase() : '',
      marketplace: filters.marketplace ? String(filters.marketplace).toUpperCase() : '',
      productLine: filters.reportProductLine ? String(filters.reportProductLine) : '',
      status: status !== null && (status === 'all' || REPORT_STATUSES.includes(status)) ? status : 'all',
      createdBy: filters.reportCreatedBy ? String(filters.reportCreatedBy) : '',
      favorite: filters.reportFavorite === true || filters.reportFavorite === '1' || filters.reportFavorite === 1,
      tag: filters.reportTag ? String(filters.reportTag) : '',
      since: filters.reportSince ? String(filters.reportSince) : '',
    },
  }
}

/** The '范围' cell: whatever the report's scope actually says, nothing invented. */
function reportScopeLine(scope) {
  if (scope === null || typeof scope !== 'object') return '—'
  const parts = []
  if (scope.asin) parts.push(String(scope.asin).toUpperCase())
  if (scope.marketplace) parts.push(String(scope.marketplace).toUpperCase())
  if (scope.productLine) parts.push(String(scope.productLine))
  if (scope.stage) parts.push(`阶段 ${scope.stage}`)
  if (scope.runId) parts.push(`run ${String(scope.runId).slice(0, 8)}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

/**
 * The quality module's data. Six views behind six tabs, and **all six are
 * built** — the last one, the audit log, lands with S1-B12.
 *
 * A view that is not built is reported as `null` with its batch named in
 * `pendingTabs`, rather than as an empty array or an empty object. "This view
 * has nothing in it" and "this view does not exist yet" are different claims,
 * and a page that drew the first for the second would send somebody looking for
 * a data problem that is really a missing feature. That map is empty now, and
 * the mechanism stays because the seventh tab will need it.
 *
 * The catalogue is *not* lazy within itself: it is one count per table over
 * fifteen tables, and the page draws all three levels at once. The slice as a
 * whole is lazy like every other — the ASIN list has no reader for it.
 *
 * `lineage` is built from the selected ASIN, and from the selection's own
 * marketplace rather than from the filter bag: a chain drawn for the wrong
 * storefront would answer confidently about a different product. With nothing
 * selected it is `null` and the page says "先选一个 ASIN" — an empty chain of
 * seven fields would read as "this product has no provenance", which is false.
 */
function qualityState(store, context, filters) {
  const requested = String(filters.qualityTab ?? '')
  /* F-6：默认落在**质量驾驶舱**，不是数据目录。
     数据目录是一份数据字典（表 / 行数 / 主键 / 责任角色 / 空值含义 / 下游），受众是
     数据管家；运营点进这个导航组问的是「我的数据哪里有问题」，答案在驾驶舱。目录保留
     （治理视图有价值），只是不该当落地页。**tab 的顺序一个字没动** —— 顺序是评审过的，
     这里只改「没指定时选哪个」；显式带 qualityTab 的深链照旧生效（同一个 includes）。 */
  const tab = QUALITY_TABS.includes(requested) ? requested : 'cockpit'

  const picked = (context.selection?.asins ?? [])[0] ?? null
  const asin = picked === null ? null : String(picked.asin).toUpperCase()
  const marketplace = picked === null ? '' : String(picked.marketplace ?? '').toUpperCase()
  const lineage = asin === null || marketplace === ''
    ? null
    : {
      asin,
      marketplace,
      fields: LINEAGE_FIELDS.map(field => traceField(store, { asin, marketplace, field })),
    }

  /* The cockpit is lazy *within* the lazy slice: the issue list is a whole table
     and only this one tab reads it, so a poll for the catalogue or the lineage
     view does not build it. The state machine's edges and the three vocabularies
     ride along from the domain, so the page draws only the moves the machine
     actually has — a page that owned a second copy would offer a transition the
     store then refuses, which is the "button that always fails" the snapshot view
     avoids the same way. */
  const cockpit = tab === 'cockpit'
    ? {
      issues: listIssues(store, {
        status: filters.dqStatus,
        severity: filters.dqSeverity,
        dimension: filters.dqDimension,
      }),
      stats: issueStats(store),
      statuses: [...DQ_ISSUE_STATUSES],
      severities: [...SEVERITIES],
      dimensions: [...DIMENSIONS],
      dimensionLabels: { ...DIMENSION_LABELS },
      transitions: DQ_ISSUE_TRANSITIONS,
      filters: {
        status: String(filters.dqStatus ?? ''),
        severity: String(filters.dqSeverity ?? ''),
        dimension: String(filters.dqDimension ?? ''),
      },
    }
    : null

  /* The audit view (S1-B12) is lazy within the lazy slice, exactly like the
     cockpit: the log is the one table that grows with every write in the whole
     plugin, so a poll for the catalogue or the lineage view must not read it.
     The rows are the newest change stream, and the stats ride along so the
     header can name the split between the agent plane and the page without a
     second query. */
  const audit = tab === 'audit'
    ? {
      rows: listAudit(store, {
        action: filters.auditAction,
        objectType: filters.auditObjectType,
        objectId: filters.auditObjectId,
        actorKind: filters.auditActorKind,
        limit: clampInt(filters.auditLimit, 1, 500, 200),
      }),
      stats: auditStats(store),
      /* The vocabularies the filter controls offer, from the domain rather than
         from the rows on screen: a filter that listed only the actions already
         present could never be used to look for one that is not. */
      objectTypes: [...AUDIT_OBJECT_TYPES],
      actorKinds: ['agent', 'page', 'system'],
      filters: {
        action: String(filters.auditAction ?? ''),
        objectType: String(filters.auditObjectType ?? ''),
        objectId: String(filters.auditObjectId ?? ''),
        actorKind: String(filters.auditActorKind ?? ''),
      },
    }
    : null

  return {
    tab,
    catalog: catalogView(store),
    lineage,
    /* The conflict workbench (S1-B10) is a real slice now: the decisions, the
       competing sources of each, and the counts. It is drawn as a tab of this
       container, so the slice rides along with the quality payload. */
    conflicts: conflictView(store, filters),
    /* `cockpit` left this group in S1-B09, `conflicts` in S1-B10 and `audit` in
       S1-B12 — all six of module 03's views are real slices now, and the last
       two are built only while their own tab is active. */
    cockpit,
    audit,
    pendingTabs: { ...QUALITY_PENDING },
  }
}

/**
 * One dossier per site the collector knows, plus any site with a stored profile.
 *
 * The second group is not redundant: a site that left the registry but still has
 * a stored profile is a configuration that exists, and dropping it would hide it.
 * The order is the registry's, so the list does not reshuffle itself when a
 * preference is saved.
 *
 * Shared by the settings panel and the collection form (contract §7.2: the form's
 * site block reuses this one). Two builds of "which sites are there" is how a form
 * comes to offer a site the settings page has never heard of — or to print one
 * postal code while the collector uses another.
 */
function siteDossiers(store, workspaceId) {
  const currentWorkspaceId = String(workspaceId ?? '').trim() || DEFAULT_WORKSPACE_ID
  const storedProfiles = new Map(
    listSiteProfiles(store, currentWorkspaceId).map(row => [row.marketplace, row]),
  )
  const verifications = listAllVerifications(store, currentWorkspaceId)
  const siteCodes = [...Object.keys(MARKETPLACES)]
  for (const code of storedProfiles.keys()) {
    if (!siteCodes.includes(code)) siteCodes.push(code)
  }
  return siteCodes.map((code) => {
    const stored = storedProfiles.get(code) ?? null
    return {
      ...siteProfileView(code, {
        verifications: verifications.filter(row => row.marketplace === code),
        localization: stored === null ? null : safeJson(stored.localization_json),
      }),
      /* What the page needs to offer an edit, and to tell "nothing stored" from
         "stored empty". */
      stored: stored !== null,
      note: stored?.note ?? null,
      updatedAt: stored?.updated_at ?? null,
      profileId: `${currentWorkspaceId}:${code}`,
    }
  })
}

/**
 * The settings surface's data.
 *
 * Three blocks, and the split between them is the module's whole point:
 *
 *   - `settings` — the declared preferences, with `stored` telling the page
 *     whether a value is the default or was chosen. A row that was never saved
 *     shows its default rather than a blank, so the form is complete on a fresh
 *     install.
 *   - `marketplaces` — per-site postal codes, each with both the effective value
 *     and the site's built-in one, so the page can show 「覆盖中」 vs 「站点默认」
 *     and a user can tell an override from a coincidence.
 *   - `sources` — redacted. `configKeys` names the credential fields; the values
 *     never leave the store (`redactSource`).
 *   - `facts` — the verified market facts, **read-only**, marked as such. They are
 *     here to be *read*, which is why they carry `editable: false` rather than
 *     simply being omitted: an omission invites someone to add the edit box later.
 *
 * `pacing` reports what the collector will actually obey, read from the live
 * service rather than re-resolved here — a settings page that computed the
 * effective rate itself would be the second implementation that drifts.
 */
function settingsState(store, filters, collection, sourceList, redactedSources, workspaceId, selection, browserChannel = {}) {
  const rows = listSettings(store)
  /* Which workspace the page is looking at. The scope bar's workspace, falling
     back to the default — the same fallback `assertWorkspaceWritable` makes, so
     a page and a tool call that omit it land on the same space. */
  const currentWorkspaceId = String(workspaceId ?? '').trim() || DEFAULT_WORKSPACE_ID
  /* Built once, outside the row map: it describes the plugin's declared keys, not
     the repository's rows, and rebuilding it per row would be 20 identical objects. */
  const DECLARED_SETTINGS = declaredSettings()
  const marketplaceRows = rows.filter(row => /^marketplace\.[A-Z]{2}\.postalCode$/.test(row.key))

  /* `postalCodeFor`, not `profileFor`. `profileFor` carries the site's identity
     (domain, language, units) — `postalCode` is not on it, so reading it there
     returned `undefined`, which the page printed as `—`. And the site default is
     only half the answer anyway: the page exists to show the *effective* code, so
     a stored override has to be what wins here. */
  const effective = code => postalCodeFor(store, code)

  const marketplaces = marketplaceRows.map(row => {
    const code = row.key.split('.')[1]
    const site = MARKETPLACES[code]?.postalCode ?? null
    return {
      code,
      key: row.key,
      /* `value` is the **effective** code, not the stored override. The page has
         one "生效邮编" column and it has to answer "what will the collector use",
         which for a site with no override is the site default. `stored` is what
         distinguishes the two cases for the UI. */
      value: effective(code),
      stored: row.stored,
      updatedAt: row.updatedAt,
      /* What the site itself would use, so an override reads as an override
         rather than as the only number that ever existed. */
      siteDefault: site,
    }
  })

  /* Every marketplace the collection layer knows, so a site with no override row
     still appears with its default — otherwise the page would only list sites
     someone had already edited, which reads as "these are all the sites". */
  const known = []
  for (const code of Object.keys(MARKETPLACES)) {
    if (marketplaces.some(entry => entry.code === code)) continue
    const site = MARKETPLACES[code]?.postalCode ?? null
    known.push({
      code,
      key: `marketplace.${code}.postalCode`,
      value: site,
      stored: false,
      updatedAt: null,
      siteDefault: site,
    })
  }

  const usage = collection && typeof collection.dailyUsage === 'function' ? collection.dailyUsage() : null

  /* ── S1-B05: 采集与数据源 ────────────────────────────────────────────────── */

  /* The browser channel's own health, which is where the login verdict lives.
     The **live** blob is used when it exists (the registry just probed), and the
     stored one otherwise — with `checked_at` beside it, because "we never looked"
     and "we looked and could not tell" are different answers and only the
     timestamp separates them. */
  const liveBrowser = sourceList.find(source => source.kind === 'browser') ?? null
  const storedBrowser = redactedSources.find(source => source.kind === 'browser') ?? null
  const profileDir = getSetting(store, 'browser.profileDir')
  const discovered = discoverProfiles()

  /* Read once and used twice: the 采集与数据源 block shows it, and the setup
     wizard's step 2 asks whether it passed. Two `loginView` calls would be two
     verdicts on one probe, and the page would be able to show "已登录" beside a
     wizard that says step 2 is not done. */
  const login = loginView({
    health: liveBrowser?.health ?? storedBrowser?.lastHealth ?? null,
    checkedAt: storedBrowser?.checkedAt ?? null,
  })

  const collect = {
    /* Reported, never editable here: the port is an operator's plugin config,
       and a field that did not reach the launcher would be a number the
       collector ignored. */
    channel: {
      host: browserChannel.host ?? null,
      port: browserChannel.port ?? null,
      chromePath: browserChannel.chromePath ?? null,
      sourceId: liveBrowser?.id ?? null,
      status: liveBrowser?.status ?? null,
      statusNote: liveBrowser?.statusNote ?? null,
    },
    browser: {
      profileDir,
      profiles: discovered,
      profile: profileView({ configured: profileDir, discovered }),
      login,
    },
    defaultSource: getSetting(store, 'collect.defaultSource'),
    /* Resolved by the same function `amzn_kw_import` uses when no path is given,
       so the directory this row prints is the directory an import will read.
       The page used to compute it here while the tool demanded a path outright —
       an input box that changed nothing. */
    importDir: resolveImportDir(store),
    /* Third-party connections: identity and which credential fields exist, never
       a value. A source with no credentials reports `configured:false` and an
       **empty** key list, because a blank key field on screen reads as a
       credential that exists and happens to be empty — a different claim. */
    thirdParty: thirdPartyView(redactedSources),
  }

  /* ── S1-B02: the workspace block, and the site dossiers ──────────────────── */

  /* The workspaces, and which one this page is looking at. The list is always
     sent, even with one row: this block is the page's "where am I" answer, and a
     block that only appeared once you had two workspaces would be missing exactly
     when a reader needs to learn that a default exists. */
  const workspaces = listWorkspaces(store)
  const currentWorkspace = workspaces.find(entry => entry.id === currentWorkspaceId)
    ?? workspaces.find(entry => entry.is_default === 1)
    ?? null

  /* One dossier per site the collector knows, plus any site that has a stored
     profile but is no longer in the registry — dropping that second group would
     hide a configuration that still exists. The order is the registry's, so the
     list does not reshuffle itself when a preference is saved.
     Built by `siteDossiers` because the collection form shows the same rows: two
     builds of "which sites exist" is how the form comes to offer a site the
     settings page has never heard of. */
  const sites = siteDossiers(store, currentWorkspaceId)

  /* The product lines, with their signals read into a **named state** rather than
     handed over as a raw JSON string.

     The page has three different actions to offer per line (save a list, reset to
     the built-in, empty it so it matches nothing) and it cannot choose between
     them if all it receives is `signals_json` — `null` and `'[]'` both look like
     "nothing" from there, and they mean opposite things. `readSignalCategories` is the
     one place that decides, shared with `amzn_product_line_upsert`, so the page
     and the tool cannot come to different conclusions about the same row. */
  const productLines = listProductLines(store, { limit: 200 }).rows.map(row => {
    const read = readSignalCategories(row.signals_json, row.id)
    return {
      id: row.id,
      name: row.name,
      note: row.note,
      version: row.version ?? 1,
      asinCount: row.asin_count,
      mode: read.mode,
      /* The flat `core` list, kept because the table's one-line summary uses it
         and because every pre-v23 consumer speaks this shape.
         D-1（T75）：`broken` 的 read.signals 是 **null**（signals.js 的坏 JSON 分支），
         原式只挡 builtin 不挡 null，`null.core` 一炸整个 buildState —— /api/state 400，
         连锁把 settings 的「格式不对」chip 变成死分支。守卫改成「builtin 或没有 signals
         就给 null」：builtin 语义原样，broken 走 chip 的降级路径，不再进解引用。 */
      signals: read.mode === 'builtin' || read.signals === null ? null : read.signals.core,
      /* All four categories, which is what the editor edits. `builtin` is the
         constant for this id, or null when the code ships none — the page draws
         it as the placeholder, and `null` must not become an empty box. */
      categories: read.mode === 'broken' ? null : read.signals,
      builtin: read.builtin,
    }
  })

  return {
    rows: rows.map(row => ({
      key: row.key,
      value: row.value,
      stored: row.stored,
      updatedAt: row.updatedAt,
      note: row.note,
      /* The declared type, so the page can choose a control without keeping a
         second table of its own — a second table is what drew every boolean as
         a text box and made `browser.headless` unwritable.

         Listed here explicitly, and that matters: this map picks fields, so a
         field added upstream is **silently dropped** rather than reaching the
         page. That is how this one went missing once already. If a column is
         meant to be seen, it has to be named in this object. */
      kind: row.kind,
      min: row.min,
      /* 什么时候生效，**照声明原样**。采集面板要用它说清「改限速下一次任务才算数」，
         而这句话在 `store/settings.js` 的声明里已经有一份 —— 页面里再写一份，两边就会
         在某个时刻各说各话。 */
      effect: row.effect ?? null,
      /* Distinguishes "a key the plugin ships" from "a per-site override somebody
         added". A key-existence test, not a truthiness test — the value in
         `declaredSettings()` is a spec object, so the naive `!== undefined` check
         would call every key declared, including a typo'd one that somehow
         reached the table.

         The same idea used to also appear as a **top-level** `declared: row => …`
         function in this payload, which was dead twice over: nothing read it, and
         `JSON.stringify` drops functions, so it never reached the page at all. It
         is gone rather than left in place — a payload key that looks like it
         carries the declared map is worse than one that is simply absent. */
      declared: row.key in DECLARED_SETTINGS,
    })),
    marketplaces: [...marketplaces, ...known],
    sources: redactedSources,
    productLines,
    workspace: {
      currentId: currentWorkspace === null ? null : currentWorkspace.id,
      current: currentWorkspace === null ? null : workspaceView(currentWorkspace),
      rows: workspaces.map(workspaceView),
    },
    sites,
    collect,

    /* ── S1-B03: shops, brands, and the ownership of what is selected ──────── */

    /* The brands are read through `listBrands`, which parses the two JSON lists
       — the page has to draw aliases and forbidden spellings as lists, and a raw
       `aliases_json` string would make the page parse JSON in a template
       literal. */
    shops: listShops(store, currentWorkspaceId).map(row => ({
      id: row.id,
      name: row.name,
      marketplace: row.marketplace,
      note: row.note,
      updatedAt: row.updated_at,
    })),
    brands: listBrands(store, currentWorkspaceId),

    /* Ownership is computed for the **selected** ASINs, because that is the only
       way to ask "whose is this" — the question needs an object. An empty
       selection returns an empty list rather than every row in the table: a
       section that listed all ownerships would be unreadable and would answer a
       question nobody asked. */
    ownership: (selection?.asins ?? []).map(entry => ({
      asin: entry.asin,
      marketplace: entry.marketplace,
      ...ownershipView(store, { asin: entry.asin, marketplace: entry.marketplace }),
    })),
    /* Read-only, and labelled so. The `authoritative` flag is the point: a site
       whose limits are not verified must say so wherever it is displayed.
       
       `titleMax` comes from `limitsFor`, not from `profileFor`: the profile
       carries the site's identity (domain, language, units) and the limits are a
       separate lookup (`GLOBAL_LIMITS` merged with any per-site override). Reading
       `profileFor(code).titleMax` returns `undefined` — which renders as a blank
       cell that looks like "this site has no title cap" rather than "the page
       asked the wrong object". Same for `limitsVerified`. */
    facts: Object.keys(MARKETPLACES).map(code => {
      const site = profileFor(code)
      const limits = limitsFor(code)
      return {
        code,
        label: site.label,
        titleMax: limits.titleMax,
        authoritative: site.authoritative,
        limitsVerified: limits.limitsVerified === true,
        units: site.units,
      }
    }),
    pacing: {
      resolved: collection && typeof collection.pacing === 'function' ? pickPacing(collection.pacing()) : null,
      used: usage === null ? null : usage.used,
      limit: usage === null ? null : usage.limit,
      remaining: usage === null ? null : usage.remaining,
    },
    /* The health the header already shows, so the sources block can say "启用但
       CDP 连不上" instead of "已启用" — the two are different and the second is a
       claim the first does not support.
       
       `sourceList` is the **resolved array** (`sources.list()`), not the registry
       service, and it is deliberately not guarded with `Array.isArray`: passing the
       service instead fails here with a TypeError that names the cause, whereas a
       `(sourceList ?? [])` guard turns the same mistake into a silently empty health
       block — a settings page that shows every source as unknown rather than an
       error anyone can act on. The guard hides exactly the bug it looks like it
       prevents, which is why it is not there. */
    health: Object.fromEntries(sourceList.map(source => [source.id, {
      status: source.status, ok: source.health?.ok ?? null, detail: source.health?.detail ?? null,
    }])),
    /* S1-B17 审批策略. Two lists that the page draws differently on purpose:
       the hard three have no key at all, so there is nothing to toggle and the
       page renders them as statements; the six carry the key they write and
       whether they shipped on (the one state a write may not undo). `enabled` is
       the value in effect — read from the settings table, not from the
       declaration — so the switch shows what the store holds rather than what it
       shipped as. */
    approvals: approvalState(store),
    /* S1-B18 首次设置向导. Read from the same workspace the page is showing, and
       from the login verdict this same call computed — the wizard's step 2 asks
       about it, and a second probe is a second answer. */
    setup: wizardState(store, { workspaceId: currentWorkspaceId, login }),
  }
}

/** The 审批策略 block of the settings slice. Read once, not once per item. */
function approvalState(store) {  const policy = approvalPolicy(store)
  return {
    policy,
    hard: HARD_APPROVALS.map(item => ({ id: item.id, label: item.label, why: item.why })),
    configurable: CONFIGURABLE_APPROVALS.map(item => ({
      id: item.id,
      key: item.key,
      label: item.label,
      note: item.note,
      enabled: policy[item.id] === true,
      /* True when the item shipped ON: turning it off is the one write the
         policy refuses, and the page has to be able to say so before the reader
         clicks rather than after. This **is** the floor, stated as the one thing
         the page can do with it. There used to be a second field here —
         `floor: item.default` — and the page never read it; a payload field with
         no reader is a promise nobody keeps (the same shape as a tool argument
         nobody consumes), so it is gone. The rule itself stays in the store. */
      cannotRelax: item.default === true,
    })),
  }
}

/** The pacing numbers worth showing, picked explicitly rather than spread whole. */
function pickPacing(pacing) {
  if (pacing === null || typeof pacing !== 'object') return null
  return {
    perTaskMax: pacing.perTaskMax ?? null,
    taskGapMs: Array.isArray(pacing.taskGapMs) ? pacing.taskGapMs : null,
    beforeNavigateMs: Array.isArray(pacing.beforeNavigateMs) ? pacing.beforeNavigateMs : null,
    humanize: pacing.humanize === true,
  }
}

/**
 * Two things are resolved here rather than in the browser, and both for the same
 * reason — the renderer must exist once. The button list is rendered server-side
 * and sent as text, so the page never holds a second copy of the template engine
 * (a copy that would drift, and whose drift would be invisible). The variable bag
 * is built here too: `scope` from the selection, `selectedKeywords` as the
 * already-joined string (the renderer adds no separator), and `rulesVersion` from
 * the *viewed* rules version — because the old page's rules buttons named the
 * version the user was looking at, not the active one.
 *
 * The editor block is only built for the prompts module: it carries every set and
 * every row, and no other panel shows it.
 */
function promptState(store, context, rules) {
  const module = String(context.module ?? '')
  const count = Array.isArray(context.selection?.asins) ? context.selection.asins.length : 0
  const scope = count === 0 ? '库里的全部 ASIN' : `当前选中的 ${count} 个 ASIN`
  const selectedKeywords = (Array.isArray(context.selection?.keywords) ? context.selection.keywords : [])
    .map(entry => entry.keyword)
    .join('、')
  /* `rulesVersion` is the version that is actually **in force**, read from the
     store rather than guessed from the module.

     It used to fall back to the sentence 「当前生效版本」 for every module but
     `rules` — and the editor runs as the `prompts` module, so it fed that
     sentence to the rules buttons: 「把规则版本 当前生效版本 设为生效版本」. That
     is not a default, it is a placeholder shaped like a version name, and a
     reader cannot tell it from a real one. §5 forbids pretending a missing value
     is present; a fake that looks like data is worse than a hole.

     The renderer's own header says a default has to come from the resolver, so
     supplying one is legitimate — but only a **true** one. `scope`'s
     「库里的全部 ASIN」 is a true description of the range when nothing is
     selected, so it stays. A version number has no true stand-in: when nothing is
     activated the variable is genuinely missing, and the required check says so. */
  const rulesVersion = module === 'rules' && rules && rules.version
    ? String(rules.version)
    : activeVersion(store)
  const variables = { scope, selectedKeywords, rulesVersion }

  const resolved = resolvePrompts(store, { module, variables })

  return {
    module,
    variables,
    buttons: resolved.buttons,
    assemble: resolved.assemble,
    stats: promptStats(store),
    editor: module === 'prompts' ? promptEditor(store, variables) : null,
  }
}

/**
 * The editor's data: every set, and every row with its current render.
 *
 * The render is sent alongside the raw body so the editor can show "what this
 * looks like now" without the page owning a renderer. A stored body always parses
 * (both writers — `upsertPrompt` and `rollbackPrompt` — refuse one that does not),
 * so this cannot throw here.
 */
/* Exported so a test can drive it against a **counting** store and measure how many
   times the route reads the run tables. Measuring the route's own scan count is the
   only way to catch "the page scans once per row" — asserting the two helper
   functions in isolation cannot see it, because neither of them is what regressed. */
/**
 * F11-08 —— 双版本对比的**材料**（不是评分）。
 *
 * 并排两版正文：**左 = 当前正文**（`row.body`），**右 = 最近一条冻结正文**
 * （`history.rows[0]`，`promptHistory` 已按新→旧返回）。两者都只做**投影**，
 * 不改一个字；页面只渲染它，不自己取正文（`page.js:4258-4274` 的既有单源规矩）。
 *
 * **只取一条冻结版**，不是「全部历史」：本块是**双**版本对比，不是版本浏览器
 * （版本列表是 B-11.2b 已经画好的那一块）。取最近一条是为了让「上一版 vs 这一版」
 * 这个最常见的问题有一个确定的答案，而不是让读者自己在几十行里挑。
 *
 * ⚠️ **`body === null` 不折成空串。** pointer 快照不发明正文
 * （`src/store/prompt.js:1005`），`bodyIsNull: true` 就是它老实的样子 ——
 * 页面对它画「这一版没有冻结正文」，而不是一个空白格（空白格会读成「空正文」）。
 *
 * ⚠️ **冻结数 ≠ 版本数。** `history.matched` 才是「有几条冻结正文」，
 * `row.version` 只是编辑计数器（`src/store/prompt.js:965-968`）。两个都下发，
 * 让页面说得出「没冻结」与「没找到」的区别。
 */
function compareMaterial(store, row, history) {
  const frozen = history.rows[0] ?? null
  return {
    /* 左：当前版本。正文来自 `row.body`，与编辑器同源。 */
    current: {
      version: row.version,
      label: '当前版本',
      body: row.body,
      bodyIsNull: row.body === null || row.body === undefined,
    },
    /* 右：最近一条冻结正文。**没有**冻结行时是 `null` —— 那不是「空的版本」，
       是「根本没有可比的那一版」，页面对这两种状态要说不同的话。 */
    previous: frozen === null
      ? null
      : {
        version: frozen.version,
        label: '上一冻结版本',
        body: frozen.body,
        /* 冻结正文可以是 null（pointer 快照）—— 如实标记，不折成空串。 */
        bodyIsNull: frozen.body === null || frozen.body === undefined,
        createdAt: frozen.createdAt ?? null,
        note: frozen.note ?? null,
      },
    /* 能不能对比，由**材料**决定，不由页面猜。理由：页面判「有没有两版」只能靠
       自己数行数，而「行数」正好是冻结数 ≠ 版本数的那个陷阱。这里把判据一次算好。 */
    comparable: frozen !== null,
    /* 冻结数量与编辑计数器分开下发 —— 两者经常不等，合并成一个数就是那个陷阱本身。 */
    frozenMatched: history.matched,
    editCounter: row.version,
    /* ⚠️ 「该提示词的评估样例输入」**没有来源** —— 契约 §2.4 的这句话在本数据模型里
       不成立，不是「查不到」，是**没有这条关联**。
       理由（两条，各自独立成立）：
       ① **两个 id 空间不相交。** `prompt.set_id` 指向 `prompt_set(id)`
          （`src/store/schema.js:1081`：`set_id TEXT NOT NULL REFERENCES prompt_set(id)`），
          而样例挂在 `prompt_eval_set` 上（`src/store/prompt.js:1158-1172` 的
          `getEvalSet` 查的是 `SELECT * FROM prompt_eval_set`）。拿 `prompt_set` 的 id
          去查 `prompt_eval_set`，永远查不到 —— 两者不是一套 id。
       ② **version 的类型都对不上。** `prompt.version` 是 INTEGER（schema.js:1087，
          编辑计数器），`prompt_eval_set.version` 是 TEXT（schema.js:2832）；
          `getEvalSet` 还会 `String(version).trim()` 去比 TEXT 列（prompt.js:1161-1165）。
       实测：即便把真实评估集 `keyword-listing-v1` 导入到库（`importEvalSet`），
       44 行提示词的这一格仍然全是 `[]` —— 证明它**结构性恒空**，不是数据没到位。
       ⚠️ **不许在这里 `?? []`**：那会把「没有这条关联」洗成一个看起来像「查过了、是空的」
       的空数组。将来真要这条关联，是**另一次迁移**（新增关联表），不是在这里补一行查询。 */
    evalInputs: { available: false, reason: 'no-prompt-eval-link' },
  }
}

export function promptEditor(store, variables) {
  /* F11-09：反查「这条提示词被哪些运行用过」。
     ⚠️ 扫描只做**一次**，不是每行一次 —— 44 行各扫 2000 条 run 会在每次 state 请求里
     变成 17 万次行解析。所以先扫一次建索引，再每行做 Map 查表。
     判据同 promptHistory：页面与工具必须用**同一份**匹配逻辑，否则两边会分别回答
     「哪些运行用过这一条」。所以这里调的是 domain 层那个函数，页面不自己写一个。 */
  const referenceScan = scanPromptReferences(store)
  /* F11-08 —— 双版本对比的**材料**（不含评分）。取法是 `promptHistory`：同一提示词的
     历史正文，权威、只读。⚠️ 两个陷阱在这里如实处理，不折叠：
       ① 冻结数 ≠ 版本数 —— `promptHistory` 的 `matched` 可能小于 `version − 1`
          （`src/store/prompt.js:965-968`：「creating a row freezes nothing」）；
       ② pointer 快照的 `body` 是 `null`（`src/store/prompt.js:1005` 明确「不发明正文」）
          —— 必须如实标记成 `bodyIsNull`，**不许** `?? ''` 折成空串（那是把「没有」画成「空」）。
     还随行下发 `evalInputs` —— 「该提示词的评估样例输入」**没有来源**（数据模型里没有
     「提示词 ↔ 评估集」这条关联，理由见 `compareMaterial` 里的 `evalInputs` 注释），
     所以这里如实登记 `available:false`，**不**给一个看起来像样例的空数组。 */
  return {
    sets: listPromptSets(store),
    rows: listPrompts(store).map(row => {
      /* `promptHistory` defaults to `PROMPT_HISTORY_LIMIT` — the one cap the page
         and `amzn_prompt_history` share. The route does not pass a `limit` of its
         own: when it said `50` the page drew a truncated list with nothing saying
         so, and the tool (200) and the page disagreed about how much history
         exists. `history` stays the rows array; `historyMeta` carries the counts
         the page needs to say how many there really are. */
      const history = promptHistory(store, { id: row.id })
      return {
        id: row.id,
        module: row.module,
        scenario: row.scenario,
        layer: row.layer,
        label: row.label,
        body: row.body,
        variables: row.variables,
        version: row.version,
        enabled: row.enabled,
        preview: renderTemplate(row.body, variables),
        /* §7.1 / §12.2：每一行都带上「这一行现在缺了什么」。预览文本本身看不出
           空洞与「提示词选择了不说」的区别，这份报告才是能显示的那一半。 */
        missing: variableReport(row.body, variables),
        /* B-11.2b：这一行被冻结过的正文（保存前的那一版）。页面据此画版本列表与
           回滚按钮。`historyMeta` 的三个数都来自同一次 `promptHistory` 调用 ——
           页面与工具因此不可能各算各的。 */
        history: history.rows,
        historyMeta: {
          matched: history.matched,
          matchedAll: history.matchedAll,
          archived: history.matchedAll - history.matched,
          limit: history.limit,
          tableTotal: history.tableTotal,
        },
        /* F11-08：双版本对比的材料。**两版正文** = 当前正文 + 最近一条冻结正文；
           冻结正文缺的时候如实标 `bodyIsNull`。**不在此算任何分**。 */
        compare: compareMaterial(store, row, history),
        /* B-11.3 / F11-05：这一行的生命周期。`status`/`statusLabel`/`next` 都来自
           store 的一次推导（页面不自己抄一份边）；`production` 说明它离进生产还差
           哪道门，两道分别点名 —— 只说「没生效」的话，读的人不知道该去动哪里。 */
        lifecycle: promptLifecycleView(store, row.id),
        production: promptProductionGate(store, row),
        /* F11-09：与工具同源的引用反查（同一次扫描的索引，不重扫）。 */
        references: referencesForPrompt({
          id: row.id,
          label: row.label,
          module: row.module,
          version: Number(row.version),
          setId: row.setId,
        }, referenceScan),
      }
    }),
    /* 变量注册表（§5 的八项）随编辑器一起下发，页面不自己抄一份。 */
    registry: promptVariableRows(),
    variables,
    /* F11-07 —— 固定评估集。**只读**：页面展示，导入走工具。
       这里对每一套都展开它的 `cases`（页面的那一块要逐条显示期望）。
       `isEmpty` 与 `caseCount` 一起下发，理由同 store 那一层：
       调用方拿到 `0` 时无从分辨「这套是空的」与「我查错了」。 */
    evalSets: listEvalSets(store).map(set => ({
      id: set.id,
      version: set.version,
      title: set.title,
      category: set.category,
      note: set.note,
      caseCount: set.caseCount,
      isEmpty: set.isEmpty,
      cases: listEvalCases(store, set.id, set.version) ?? [],
    })),
    /* F11-08 —— 九维缺失登记随编辑器一起下发。**页面只渲染，不自己数**：
       哪九维、分几类、每类缺哪份记录，全部由 domain/prompts/eval-dimensions.js
       给出（与 metrics / gaps 同一条单源规矩）。九条**都是声明**、**没有任何分值**，
       所以这里原样透传，不在这里也不在页面里补任何数字。 */
    compareDimensions: {
      count: EVAL_DIMENSION_COUNT,
      summary: EVAL_DIMENSION_SUMMARY,
      dimensions: EVAL_DIMENSIONS,
    },
  }
}

/**
 * The page's view of a plan's coverage — planned and actual kept apart.
 *
 * The page has no listing text, so `actual` is **null** here, and the shape says
 * so explicitly (`actualIsNull` / `actualTotal: null`). Collapsing it to `0`
 * would make the page show "0 / 10" for a plan nobody measured, which reads
 * exactly like a plan that was measured and found empty.
 */
function pageCoverage(store, planId) {
  const coverage = planCoverage(store, { planId, fields: null })
  return {
    plannedTotal: coverage.planned.total,
    checkableTotal: coverage.planned.checkableTotal,
    actualIsNull: coverage.actual === null,
    actualTotal: coverage.actual === null ? null : coverage.actual.total,
    fillRate: coverage.fillRate === undefined ? null : coverage.fillRate,
    reason: coverage.reason ?? null,
  }
}

/**
 * The keyword master library's data for the page.
 *
 * Rows are projected down to the columns the table actually draws. A master row
 * carries ~60 columns and a hundred of them is a payload an order of magnitude
 * larger than anything else this endpoint returns — for fields no panel shows.
 * The stats block is sent whole, because its whole job is to be read.
 *
 * 模块 08 F08-08 adds a `detail` slice, keyed by the selected row
 * (`selection.keywords[0]`). It is read from the **fact tables**, not from the
 * aggregated master row: `getMaster` keeps only the newest ABA period, sums ads
 * across every period and file, and takes `MAX(...)` for competitors — exactly
 * the per-period / per-file / per-ASIN rows the timeline needs.
 */
function masterState(store, filters, selection = {}) {
  const marketplace = filters.marketplace ? String(filters.marketplace).toUpperCase() : null
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500)

  const page = queryMaster(store, {
    marketplace,
    /* 关键词总库自己的搜索框。**不能用 filters.q** —— 那个键属于 ASIN 列表/关键词库，
       换页签后它仍然留在 context.filters 里（实测 `q:"ZZZ"` 残留会把总库筛成 0 行，
       而页面上搜索框是空的）。两个面板各用各的键，页面才不会被上一次筛选污染。 */
    q: filters.masterQ,
    productLine: filters.masterLine || undefined,
    svTier: filters.masterTier || undefined,
    /* 模块 08 F08-07：按生命周期状态筛。值只可能来自页面的下拉（九态 + 全部），
       所以这里不做二次校验 —— 校验在 store 的 listKeywordLifecycle 与工具里。 */
    lifecycleStatus: filters.masterLifecycle || undefined,
    order: filters.masterOrder ?? 'volume',
    limit,
    offset: clampInt(filters.masterOffset, 0, 1_000_000, 0),
  })
  const stats = masterStats(store, { marketplace })
  const lifecycle = keywordLifecycleCounts(store, { marketplace })
  /* 模块 08 F08-04：总库大表的「主人」列与所有权工作台。两处都读 store 的同一份推导
     （主人 = 唯一生效主张；≥2 条生效主张即冲突），所以列与工作台不会各说各话。 */
  const ownership = ownershipForKeywords(store, { marketplace, keywords: page.rows.map(row => row.keyword) })
  const ownershipView = keywordOwnershipView(store, { marketplace })
  /* 模块 08 F08-05：位置计划。计划是**按 (ASIN, 站点)** 的，而总库面板本身不带站点筛选，
     所以站点没选时取**总库里词最多的站点**作为默认，而不是静默假设 US，也不是让这一块永远
     空着（那正是「承诺了能力然后把它丢掉」）。列表给版本；当前取该站点最新一版；提案是只读
     推导（`proposePlan` 不写库）；覆盖**分开算**计划与实际 —— 页面没有 listing 文案，所以
     实际覆盖是 null，页面显示「无法计算（null）」而不是 0。 */
  const planMarket = marketplace ?? (store.get(
    'SELECT marketplace FROM kw_master GROUP BY marketplace ORDER BY COUNT(*) DESC, marketplace LIMIT 1',
  )?.marketplace ?? null)
  const planVersions = planMarket === null ? [] : listPlans(store, { marketplace: planMarket })
  const currentPlan = planVersions.length === 0 ? null : getPlan(store, { planId: planVersions[0].id })
  const planSlice = {
    marketplace: planMarket,
    versions: planVersions.slice(0, 20),
    current: currentPlan === null ? null : currentPlan.plan,
    rows: currentPlan === null ? [] : currentPlan.entries,
    proposal: planMarket === null
      ? { asin: null, marketplace: null, entries: [], note: '总库还是空的，没有可提案的词。' }
      : proposePlan(store, { marketplace: planMarket }),
    positions: planPositions(),
    coverage: currentPlan === null ? null : pageCoverage(store, currentPlan.plan.id),
  }

  /* 模块 08 F08-08：关键词详情。跟着**选中的那一行**走 —— 总库大表点一行写
     `selection.keywords = [{keyword, marketplace}]`，这里把那一行读成七个 §8.2 项。
     没选中任何词时 `detail` 是 null（页面显示「点选一行」），不是空对象。
     自有排名是 ASIN 维度的：选中的 ASIN（`selection.asins[0]`）带进去，没有就
     由 store 读成「需选定 ASIN」，不是 0。 */
  const pickedKeyword = (selection?.keywords ?? [])[0] ?? null
  const pickedMarket = pickedKeyword === null
    ? null
    : (pickedKeyword.marketplace ?? marketplace ?? null)
  const pickedAsin = (selection?.asins ?? [])[0]?.asin ?? null
  const detail = pickedKeyword === null
    ? null
    : (pickedMarket === null
      /* 关键词身份按 (关键词, 站点) 口径；站点都读不出来时**不给**一个假装完整的
         详情，而是把原因说出来 —— 静默给一个空详情会被读成「这个词什么都没有」。 */
      ? { keyword: pickedKeyword.keyword, marketplace: null, unavailable: { kind: ABSENCE_UNMEASURED, text: '需选定站点', why: '关键词详情按 (关键词, 站点) 口径读取，选中项没有站点。' } }
      : readKeywordDetail(store, { keyword: pickedKeyword.keyword, marketplace: pickedMarket, asin: pickedAsin }))

  /* FR-M6-19：US/CA 排名对比视图。**只在页面切到对比模式时才算** —— 行集来自
     `kw_rank_observation`（被观测过的词），不是 30,778 条全库，所以不切模式就一次查询都不发。
     判定（§20.3 两侧周期不一致不判读）与文案都在 `store/keyword-marketplace-compare.js`
     那一份里；这里只把筛选原样透传，路由里不写第二份判定。
     站点对：左侧取当前筛选的站点（默认 US），右侧取 `kwCompareRight`（默认 CA）。 */
  const compareMode = String(filters.kwCompare || '') === 'us-ca'
  const compare = compareMode
    ? compareMarketplaceRanks(store, {
      left: filters.marketplace || 'US',
      right: filters.kwCompareRight || 'CA',
      q: filters.masterQ || null,
      state: String(filters.kwCompareState || 'all'),
      limit: Number(filters.kwCompareLimit) || 50,
      offset: Number(filters.kwCompareOffset) || 0,
    })
    : null

  /* FR-M6-03：批次视图（期间标签分组）。只有页面切进这个视图时才读批次清单，
     选了某一次导入才查它的词表 —— 不切模式就一次查询都不发。
     `period` 原样带出（五种形状不折算，见 store/keyword-batch-view.js 的文件头）。 */
  const batchMode = String(filters.kwBatchView || '') === 'batch'
  const batchList = batchMode ? listKeywordBatches(store, { marketplace }) : null
  const batchView = batchMode && String(filters.kwBatch || '') !== ''
    ? keywordBatchView(store, {
      importId: String(filters.kwBatch),
      q: filters.masterQ || null,
      limit: Number(filters.kwBatchLimit) || 100,
      offset: Number(filters.kwBatchOffset) || 0,
    })
    : null

  /* v69 — 产品线归属：这一页词的**生效值**（人工 > 派生）+ 三档计数 + 下拉选项。
     生效值来自 store 的唯一读口（按页批量版 `listEffectiveProductLines`），路由不重算
     「人工 > 派生」—— 任何一处自己写 COALESCE 都是第二份口径（t78 ⑩ 源码级断言）。 */
  const productLineMarket = marketplace ?? (page.rows[0]?.marketplace ?? null)
  const productLineByKeyword = productLineMarket === null
    ? new Map()
    : listEffectiveProductLines(store, {
      keywords: page.rows.map(row => row.keyword),
      marketplace: productLineMarket,
    })
  const productLineDecisions = {
    marketplace: productLineMarket,
    /* 三档计数与「未分类」的口径都在 store 里（迁移前后 unclassified 必须都是 3,386）。 */
    counts: productLineMarket === null ? null : productLineCounts(store, { marketplace: productLineMarket }),
    options: productLineOptions(store),
    sourceLabels: { manual: '人工', derived: '自动', unclassified: '未分类' },
  }

  return {
    rows: page.rows.map(row => ({
      keyword: row.keyword,
      marketplace: row.marketplace,
      search_volume: row.search_volume,
      search_volume_source: row.search_volume_source,
      sv_tier: row.sv_tier,
      priority: row.priority,
      opportunity: row.opportunity,
      funnel: row.funnel,
      product_line: row.product_line,
      product_line_matched: row.product_line_matched,
      impressions: row.impressions,
      clicks: row.clicks,
      orders: row.orders,
      spend: row.spend,
      sales: row.sales,
      cvr_pct: row.cvr_pct,
      acos_pct: row.acos_pct,
      competitor_best_rank: row.competitor_best_rank,
      competitor_ranked_count: row.competitor_ranked_count,
      sources: row.sources,
      /* 生命周期状态，**可为 null** —— null 是「没人决定过」，页面据此显示「未设置」，
         而不是把它当成 candidate。这个区别是 F08-07 的 ⑤ 号断言钉的那一条。 */
      lifecycle_status: row.lifecycle_status ?? null,
      /* 模块 08 F08-04 的「主人」列。`owner` 为 null 时页面要分两种：有冲突 → 「未决」，
         没有任何主张 → 「未分配」。这个区别由 `conflict` 与 `claim_count` 一起表达，
         不能让两者都渲染成同一个「无」。 */
      ownership_owner: ownership.get(row.keyword)?.owner ?? null,
      ownership_conflict: ownership.get(row.keyword)?.conflicted === true,
      ownership_conflict_count: ownership.get(row.keyword)?.conflictCount ?? 0,
      ownership_claim_count: ownership.get(row.keyword)?.claimCount ?? 0,
      /* v69：**生效归属**（人工 > 派生）与它的来源 —— 页面据此画「人工 / 自动 / 未分类」，
         绝不自己拼。`row.product_line` 仍然是**派生值**（分类器的判断），两者不是同一个数：
         一个词可以「派生为 bench-cushion」而「人工定为 rocker-cushion」。 */
      product_line_effective: productLineByKeyword.get(row.keyword)?.value ?? null,
      product_line_source: productLineByKeyword.get(row.keyword)?.source ?? 'unclassified',
      product_line_manual: productLineByKeyword.get(row.keyword)?.manual ?? null,
    })),
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    productLines: stats.byProductLine,
    /* 生命周期这一块的读数：九态各自的数量 + 未设置。`unset` 是**真的算出来**的
       （master 里没有对应 lifecycle 行的条数），不是「总数减掉已设置」——那样会把
       两个站点口径不同时的差异藏起来。 */
    lifecycle: {
      total: lifecycle.total,
      unset: lifecycle.unset,
      byStatus: lifecycle.byStatus,
      states: KEYWORD_LIFECYCLE_STATES.map(status => ({ status, label: KEYWORD_LIFECYCLE_LABELS[status] })),
    },
    /* 模块 08 F08-04 的所有权工作台：词 / 候选 ASIN / 当前主人 / 冲突原因 / 建议。
       `rows` 只含**有主张或建议**的词（没有的不是一行，也不是一起冲突），`stats` 给
       这一块的计数。主人与冲突是推导的，页面只渲染不重算。 */
    ownership: ownershipView,
    /* 模块 08 F08-05 的位置计划切片。`coverage` 把计划与实际**分开**交出去：页面没有
       listing 文案，所以 `actualIsNull` 为真、`actualTotal` 为 null —— 页面据此显示
       「无法计算（null）」，而不是把计划数当成实际数。 */
    plan: planSlice,
    /* FR-M6-19：US/CA 对比切片。null = 没切到对比模式（页面据此画总库表）。
       行集是**被观测过的词**，`summary` 的分母是这一页（页面上写「本页」），
       只有 `total` 是全库命中数 —— 两个分母不能混。 */
    compare,
    /* FR-M6-03：批次视图。`batchList` 非 null = 页面在批次视图里（据此画选择器）；
       `batchView` 非 null = 已经选了某一次导入（据此画词表）。两者分开，所以「进来还没选」
       是一个明确的状态，不是一张空表。 */
    batchList,
    batchView,
    /* period 的形状限制由 store 的常量带上来 —— 页面不抄第二份文案，否则两句「不折算
       自然月」迟早一句被改一句没改。 */
    batchNote: batchMode ? PERIOD_SHAPE_NOTE : null,
    /* v69：产品线归属的切片。`counts` 三档（人工 / 自动 / 未分类）分母是该站点总库条数；
       `options` 是产品线下拉（页面不自己拼第二份清单）；`sourceLabels` 是「人工 / 自动 /
       未分类」这三个词的唯一出处 —— 页面与工具都读它。 */
    productLineDecisions,
    /* 模块 08 F08-08 的关键词详情切片。**跟着选中的那一行**（`selection.keywords[0]`）：
       没选中时是 null，页面据此显示「点选一行」而不是一个空详情。它读的是三张事实表
       的**原始行**（不经过 getMaster 的聚合），以及所有权 / 位置计划 / 数据质量 / 生命
       周期历史 / 变体归档。缺失分「未测量」与「本系统没有这个字段」两种说法，词表随
       视图一起带出去。 */
    detail,
    stats: {
      total: stats.total,
      withVolume: stats.withVolume,
      withoutVolume: stats.withoutVolume,
      withAba: stats.withAba,
      withAd: stats.withAd,
      withCompetitor: stats.withCompetitor,
      productLineDefaulted: stats.productLineDefaulted,
      totalSpend: stats.totalSpend,
      totalSales: stats.totalSales,
      totalImpressions: stats.totalImpressions,
      totalClicks: stats.totalClicks,
      totalOrders: stats.totalOrders,
      byFunnel: stats.byFunnel,
      bySvTier: stats.bySvTier,
      byPriority: stats.byPriority,
      byOpportunity: stats.byOpportunity,
    },
    imports: stats.imports.map(row => ({
      id: row.id,
      kind: row.kind,
      file_name: row.file_name,
      marketplace: row.marketplace,
      period: row.period,
      rows_read: row.rows_read,
      /* v68 的缺失标记**必须一起下发**：页面拿不到它，就只能看到 rows_read 的 0，
         于是把「没记到」画成「这份文件 0 行」。这与上面月度花费那条 spend_missing
         是同一个坑 —— 标记列不跟着切片走，库里的修复在屏幕上等于没修。 */
      rows_read_missing: row.rows_read_missing,
      facts_written: row.facts_written,
      included: row.included,
    })),
    overlaps: stats.overlaps.map(entry => ({
      a: `${entry.a.file_name} (${entry.a.period})`,
      b: `${entry.b.file_name} (${entry.b.period})`,
    })),
  }
}

/**
 * 模块 12：任务画布的数据。
 *
 * 选中的运行由 `filters.agentRunId` 决定，缺省取最新一次 —— 与管道面板同一套
 * 「点了哪一行就展开哪一行」的约定（B13.1 那条）。运行 id 与工具用的是**同一个**
 * id，所以会话里开的运行在这一页就是同一行（§15-7）。
 *
 * `selected.gates` 是把**声明的**两个门禁挂到运行上：运行表不存门禁清单（它是代码
 * 里的声明），页面要画「哪些还没裁决」就需要两边合起来看，合在这里而不是在渲染层，
 * 这样页面拿到的是一份完整的答案。
 *
 * `metrics` 是 §14 的十项指标（`domain/agent/metrics.js`）。它**跟着这一页走**，因为
 * 指标要读者在同一屏里对着运行看；它只读，所以没有对应的写路由（`WRITE_TARGETS` 里
 * 显式 null）。页面**不拥有**这份清单，也不自己算百分比 —— 服务端把 `display` 一起
 * 给出去（B-12.1 的 `pendingReason` 同一条规矩）。
 */
function agentState(store, filters) {
  const listed = listAgentRuns(store, { limit: 20 })
  const wanted = String(filters.agentRunId ?? '').trim()
  const chosen = wanted !== '' ? wanted : (listed.rows[0]?.id ?? null)
  const selected = chosen === null ? null : getAgentRun(store, chosen)
  /* F12-07：产物**独立列表视图**。跨运行，按类型 / 状态 / 对象类型筛。
     三个筛选键各自独立（`artifactType` 而不是 `type`）：与报告专区的 `reportKind`
     同一条理由 —— 一个裸的 `type` 会被别的面板读成对**它们**那张表的筛选。
     `limit` 走 `clampInt`（缺省 100，上限 500 与 `listAllArtifacts` 的 cap 一致）。 */
  const artifacts = listAllArtifacts(store, {
    type: filters.artifactType ?? null,
    status: filters.artifactStatus ?? null,
    objectType: filters.artifactObjectType ?? null,
    limit: clampInt(filters.artifactLimit, 1, 500, 100),
  })
  return {
    runs: listed,
    /* ⚠️ `agent_run` 的**总数**单独下发，空态 A/B 的分辨靠它。
       `listed.total` 才是总数 —— `listed.rows` 是 `limit 20` 截断过的（`listRuns`
       的 cap 是 20），拿 `rows.length` 当总次数会把「跑过 30 次」说成「跑过 20 次」，
       于是空态 B 那句「跑过 N 次运行」会报一个错的 N。 */
    runTotal: listed.total,
    selectedRunId: selected === null ? null : selected.id,
    /* F12-07：产物切片。四个键里 `filters` 是**回填控件**用的（照 `reportState`），
       并且它是服务端**实际采用**的值 —— 页面把非法值交给服务端时，回填的是被夹紧后的
       真值，控件不会声称一个 payload 忽略了的筛选。 */
    artifacts: {
      /* `runId` 由 `hydrateArtifact` 的投影带出来 —— 它就是为了跨运行列表才带上
         `run_id` 的（见 `store/agent.js` 该投影上的注释）。这一层**不再补一份**。
         ⚠️ 这里曾经是 `rows.map(row => ({ runId: row.runId ?? null, ...row }))`，而注释
         声称「`hydrateArtifact` 的投影里没有它」。**两处都是错的**：投影里**有** `runId`，
         于是那个 map 是**空操作**；而且 `?? null` 会被后面的 `...row` 覆盖 —— 就算真的
         缺这一格，它也补不成 `null`（`agent_artifact.run_id` 是 `NOT NULL`，本来也没有
         null 这一档，所以那半个兜底从一开始就是死代码）。
         **本仓把「注释与代码不符」算缺陷**（§7.3 D2 同款），所以删掉空 map、把话说对。 */
      rows: artifacts.rows,
      total: artifacts.total,
      limit: artifacts.limit,
      filters: {
        type: filters.artifactType ? String(filters.artifactType) : '',
        status: filters.artifactStatus ? String(filters.artifactStatus) : '',
        objectType: filters.artifactObjectType ? String(filters.artifactObjectType) : '',
      },
    },
    /* F12-05：判词在**服务端**算一次，跟着选中运行一起下发。页面直接复用它、
       不重算 —— 与 §14 指标同一条单源规矩（页面不拥有这份清单，也不自己算）。
       verdict 是纯函数 domain/agent/orchestration.js 的输出，不落库、不新增列。 */
    selected: selected === null
      ? null
      : { ...selected, gates: AGENT_GATES, orchestration: planNextStep(
        { role: selected.role, id: selected.role, steps: roleById(selected.role)?.steps ?? [] },
        selected.steps.map(step => ({ seq: step.seq, step: step.step, status: step.status })),
      ),
      /* F12-09：「多次失败停止自动重试」的判词。**阈值来自 domain**（MAX_AUTO_RETRIES），
         页面只渲染结论 —— 一个数字活在两个文件里，改一处就漂一处。 */
      retryBudget: retryBudget(selected) },
    roles: roleView(),
    gates: AGENT_GATES,
    /* F12-06：blocked 的原因词表（含**每一类的出口动作**）。页面**不自己写一份**
       「数据过期跳采集、缺失变量跳来源」的表 —— 那张表活在 `domain/agent/run.js` 一处，
       页面照它画。⚠️ 词表里的 `reachable: false`（成本超限）与 `exitGap`
       （需求没给 / 插件做不到）都要原样带下去，否则页面会把「没有出口」画成一个按钮。 */
    blockedKinds: BLOCKED_KINDS,
    /* F12-04：§5 六类任务类型的**中文标签**，服务端下发、页面零副本 —— 页面是浏览器
       脚本，import 不到 roles.js；让它自己写一份标签表就是「一句事实活在两个文件里」
       （本仓招牌缺陷，见 §3.8b）。
       ⚠️ **「未声明」不在这份表里**：它是 `taskType === null`，页面单独画。把 NULL
       折算成某一类 = 给缺失造一个像数据的替身。 */
    taskTypeLabels: AGENT_TASK_TYPE_LABELS,
    /* F12-07 修正：产物**四态的中文标签**，同样服务端下发、页面零副本 —— 页面是浏览器
       脚本，import 不到 roles.js；新列表的状态列与状态下拉此前各写了一份中文，于是同一份
       数据在运行详情块与独立列表里显示成两种东西（B-12.10 在任务类型上刚解决过同形状的
       问题，见上面 `taskTypeLabels`）。
       ⚠️ **没有「未声明」这一档**：`agent_artifact.status` 是 NOT NULL（schema.js 建表），
       不像 `task_type` 那样可空，所以这里四个 id 就是全部，不必也不能折算 NULL。 */
    artifactStatusLabels: AGENT_ARTIFACT_STATUS_LABELS,
    /* 词表的 **id 顺序**也一起下发：页面据此重建状态下拉的选项顺序，而不是自己按标签
       对象键序排（对象键序是实现细节，不该被页面依赖）。id 与标签同源 roles.js。 */
    artifactStatusIds: AGENT_ARTIFACT_STATUSES,
    /* F12-05：编排模式标签，同样单源（domain/agent/orchestration.js）。 */
    planModeLabels: AGENT_PLAN_MODE_LABELS,
    metrics: agentMetrics(store),
    /* §0 那九个「无数据来源」的要素（`domain/agent/gap.js`）。它们随角色一起下发
       —— 五个是角色级声明，四个是运行产出，都关于角色；挂在这里**零新工具**，
       不动两处注册表。页面只渲染，不自己数（与 `metrics` 同一条规矩）。 */
    gaps: agentGapView(),
    /* F12-03：「被命名的约定产物类型」（质量摘要那一把）。页面**不自己写一份类型名** ——
       它照这份清单画「这次运行有没有质量摘要」，而清单活在 `domain/agent/artifact-types.js`
       一处。⚠️ 它是清单不是闭集：不在里面的 type 照样合法。 */
    artifactTypes: agentArtifactConventions(),
    /* F12-03：选中那次运行的补充数据请求。⚠️ 三种「没有」在**服务端就分开**，页面照三种
       说法各写各的：没选运行 → `null`；这次运行没有请求 → `rows: []` 且 `total` 可能 > 0
       （别的运行有）；全库一条都没有 → `total: 0`。折成一句「没有请求」就是本仓最忌的
       「把缺失渲染成真实值」。 */
    dataRequests: selected === null ? null : listDataRequests(store, { runId: selected.id }),
  }
}

/**
 * The home page's five blocks.
 *
 * `recent` is deliberately **not** narrowed by the scope, unlike the cards and
 * the todos: it answers "what did this workbench last produce", and a scope
 * filter would hide a run that just finished while the empty state still read
 * 「暂无」 — which claims there is nothing, not nothing here. The reason is
 * written out in the domain module rather than left to be inferred from the
 * missing argument.
 *
 * `onboarding` is handed the cards this same call produced rather than reading
 * them a second time: the guide's third step is "a card has data", and a second
 * computation is a second answer that can differ from the one on screen.
 */
function homeState(store, scope, filters = {}) {
  const cards = buildHealthCards(store, scope, {})
  /* P2-2 趋势。只有 `collection` 能算 —— 它统计的是「近 30 天完成的任务里成功多少」，
     可以原样跑在前一个等长窗口上。其余五张说的是**当前状态**，没有可比的上一期，
     模块会给它们一条说明原因而不是编一个数。
     注意这里会**再算一遍六张卡片**（一次本期、一次上一期）—— 那是趋势的必要成本，
     而且两次都走同一个 `buildHealthCards`，所以数字与趋势不可能是两套口径。 */
  const healthTrends = buildHealthTrends(window => buildHealthCards(store, scope, { window }))
  /* 趋势文案在这里算，不交给客户端 —— `describeTrend` 是**唯一**一处把趋势翻译成
     人话的实现。客户端再写一份「上升/下降/持平」的措辞，就会出现"页面说持平、
     载荷说 up"这种两张嘴。所以载荷里直接带最终那句。 */
  const trendTexts = healthTrends.map(entry => ({
    id: entry.card.id,
    text: describeTrend(entry.trend),
    direction: entry.trend.direction,
    meaningful: entry.trend.meaningful,
    reason: entry.trend.reason,
  }))
  const onboarding = buildOnboarding({ store, cards })
  const searchQuery = String(filters.searchQuery ?? '').trim()
  /* T75：待办只算一次，摘要从它读。两次调用会让「今天有 N 件事」与下面待办区的
     条数各说一句 —— 同一个数在一屏里出现两个值，是这类摘要最典型的坏法。 */
  const todos = buildTodos(store, scope)
  return {
    cards,
    /* 与 `cards` 同序的 `{ card, trend }`。页面按 id 对齐，不按下标。 */
    trends: healthTrends,
    /* 已经翻译好的一句话（每张卡一条）。页面只负责显示。 */
    trendTexts,
    todos,
    /* T75 ①：一句话摘要。**只读** `todos` 与 `cards` 两份已经算好的东西，
       不另算一套（见 `domain/dashboard/todos.js` 的 buildDigest）。 */
    digest: buildDigest({ todos, cards }),
    /* T75 ③：四类待决策合并成一张表。只汇总入口，不重做那四个功能。 */
    decisions: buildDecisions(store, scope),
    recent: buildRecent(store, {}),
    actions: buildQuickActions(),
    onboarding,
    /* The 跳步 consequence, for the cards block to print. Decided here rather
       than in the renderer so the sentence and the condition that shows it are
       one piece of code — see the domain module. */
    cardsNote: emptyCardsNote(onboarding, cards),
    /* Global search (S1-B15). `null` until a query is typed, so a poll with an
       empty box does not run ten indexed scans and carry ten empty groups. The
       block the page draws is the same one either way — 「还没搜」 and 「搜了没
       有」 are different sentences and the page says which. */
    search: searchQuery === '' ? null : searchAll(store, searchQuery),
    /* 收藏与最近访问（S1-B20）。两条小列表，跟着首页走；它们不是业务数据，
       所以不进审计（见 PAGE_WRITE_TARGETS 里那两条 null 的理由）。 */
    pins: pinView(store),
  }
}

/**
 * The pipeline module's data: recent runs, plus the newest one in full.
 *
 * Only the newest run is expanded (stages included), because that is what the
 * panel draws — the stage-by-stage counts of the most recent run, above the
 * history. Expanding every run in the list would make this endpoint's cost grow
 * with the history for no reader.
 *
 * `failed` is reported separately and always: a run that broke has to be visible
 * without expanding anything, or the history reads as "it has always worked".
 */
function pipelineState(store, filters) {
  const marketplace = filters.marketplace ? String(filters.marketplace).toUpperCase() : null
  const stats = runStats(store, { marketplace })
  const listed = listRuns(store, { marketplace, limit: 20 })
  const newest = listed.rows[0] ?? null

  /* A run id may arrive from a 「最近运行」 link, and it is expanded instead of
     the newest one: a link that lands on a different run's stage counts has
     moved the search rather than done it.

     A run that no longer exists is reported as `focusId` with `focused: null`
     rather than falling back to the newest — "the one you clicked is gone" and
     "you did not ask for one" are different answers, and the panel says which.

     The focused run is looked up by id without the marketplace filter, on
     purpose: the 「最近运行」 block is not scoped, so a link can legitimately
     name a run outside the scope now selected. The run's own site is printed on
     its header, so the panel never implies it belongs to the current scope. */
  const focusId = String(filters.runId ?? '').trim() || null
  const focused = focusId === null ? null : getRun(store, focusId)

  return {
    runs: listed.rows.map(run => ({
      runId: run.runId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      marketplace: run.marketplace,
      productLine: run.productLine,
      trigger: run.trigger,
      inputCount: run.inputCount,
      outputCount: run.outputCount,
      status: run.status,
    })),
    latest: newest === null ? null : getRun(store, newest.runId),
    focusId,
    focused,
    total: stats.total,
    failed: stats.failed,
    lastStartedAt: stats.lastStartedAt,
  }
}

/**
 * The competitor panel's data: the saved sets, and the diff for the set being
 * looked at.
 *
 * Our ASIN comes from the page's selection, not from a filter box of its own:
 * the workbench already has exactly one notion of "the ASIN I am looking at"
 * (`context.selection.asins`), and a second one on this panel would let the two
 * disagree — the ASIN list showing one product while the diff compared another.
 *
 * Returns `diff: null` with a `reason` rather than an empty diff whenever it
 * cannot answer. An empty diff and "nothing to compare" render identically in a
 * two-column layout, and the difference is the whole message: one says "you are
 * covered", the other says "pick something first".
 */
/* #13：按关键词反查竞品（只读）。词表来自 `competitorReverseKeywords`，
   站点来自 `competitorReverseMarketplace`（缺省回落到当前站点）。 */
function competitorReverseState(store, filters) {
  const keywords = String(filters?.competitorReverseKeywords ?? '')
    .split(/[,，\n]/)
    .map(word => word.trim())
    .filter(word => word !== '')
    .slice(0, 5)
  const marketplace = String(filters?.competitorReverseMarketplace ?? filters?.marketplace ?? 'US')
    .trim().toUpperCase() || 'US'
  return reverseCompetitorFacts(store, { marketplace, keywords })
}

function competitorState(store, filters, selection) {
  const sets = listCompetitorSets(store, { limit: 50 }).map(set => ({
    id: set.id, name: set.name, marketplace: set.marketplace, asins: set.asins, updatedAt: set.updated_at,
  }))
  /* #13 只读反查：输入走 filters（刷新后结果还在），最多 5 个词；站点独立于
     全局筛选。只查 `kw_competitor_fact`，不发起任何采集/搜索。 */
  const reverse = competitorReverseState(store, filters)

  const picked = (selection?.asins ?? [])[0] ?? null
  const asin = String(filters.competitorAsin ?? picked?.asin ?? '').trim().toUpperCase()
  const marketplace = String(filters.marketplace ?? picked?.marketplace ?? '').trim().toUpperCase()
  if (asin === '' || marketplace === '') {
    return { sets, diff: null, reverse, reason: '先在 ASIN 列表里选一个我们的 ASIN，或在本页填一个。' }
  }
  /* Validated here, not left to `readCompetitorSides`, because that throws and a
     throw inside `buildState` is a 500 — the page would go blank instead of
     saying "that is not an ASIN". A page-level filter box is exactly where a
     half-typed ASIN arrives. */
  try {
    normalizeAsinList([asin])
  } catch {
    return { sets, asin, marketplace, diff: null, reverse, reason: `「${asin}」不是有效的 ASIN（应为 10 位字母/数字）。` }
  }

  const setId = String(filters.competitorSetId ?? '').trim()
  const set = setId !== '' ? getCompetitorSet(store, setId) : sets[0] ?? null
  if (set === null) {
    return {
      sets, asin, marketplace, diff: null, reverse,
      reason: sets.length === 0
        ? '还没有竞品组。在下面建一个（填名称 + 竞品 ASIN），或让 agent 调 amzn_competitor_set_upsert。'
        : `找不到竞品组 "${setId}"。`,
    }
  }
  if (set.marketplace !== marketplace) {
    return {
      sets, asin, marketplace, selectedSetId: set.id, diff: null, reverse,
      reason: `竞品组「${set.name}」的站点是 ${set.marketplace}，与当前 ${marketplace} 不一致。竞品组按站点保存，跨站点比较没有意义。`,
    }
  }

  /* A set stored by hand (or by an older build) can hold an invalid ASIN, and
     `readCompetitorSides` rejects the whole list rather than skipping the bad
     entry — correctly, since a silently dropped competitor is one that is not
     being compared. At the page level that has to become a sentence, not a 500. */
  let sides
  try {
    sides = readCompetitorSides(store, { asin, marketplace, competitors: set.asins })
  } catch (error) {
    return {
      sets, asin, marketplace, selectedSetId: set.id, selectedSetName: set.name, diff: null, reverse,
      reason: `竞品组「${set.name}」读不了：${error.message}`,
    }
  }
  if (sides.peers.length === 0) {
    return {
      sets, asin, marketplace, selectedSetId: set.id, selectedSetName: set.name, diff: null, reverse,
      reason: '这个竞品组里只有我们自己的 ASIN，没有可比较的对象。',
    }
  }

  /* Order and page size ride in the filter bag, like every other table on this
     page, so the server sorts *before* it caps. Sorting in the browser would only
     reorder whatever survived the default sort. */
  const diff = buildCompetitorDiff(sides, {
    limit: clampInt(filters.competitorLimit, 50, 2000, 100),
    theirsOrder: orderOr(filters.competitorTheirsOrder, 'volume'),
    oursOrder: orderOr(filters.competitorOursOrder, 'volume'),
  })

  /* F06-04 四象限：分类的是两侧关键词的**并集**，所以两侧都有排名的词也在内
     （差集列表里没有它们）。品牌识别复用 `competitorBrandHits` —— 不在这里写
     第二个匹配器。 */
  const classified = classifyQuadrants(quadrantRows(sides), {
    marketplace: sides.marketplace,
    brandHitsFor: keyword => competitorBrandHits(store, keyword),
  })

  /* 每桶按**唯一一处上限** `QUADRANT_PAGE_SIZE` 截断，页面渲染的就是这里给出去的
     内容、不再自己截一次。`counts` 保持真实总数，`truncated[key]` 让用户知道还有更多。 */
  const sliced = {}
  const truncated = {}
  for (const key of QUADRANT_ORDER) {
    const bucket = classified.quadrants[key]
    sliced[key] = bucket.slice(0, QUADRANT_PAGE_SIZE)
    truncated[key] = bucket.length > QUADRANT_PAGE_SIZE
  }
  const quadrants = { ...classified, quadrants: sliced, truncated }

  /* 证据：**就是渲染出来的那些行**，不是「桶序并集的前 N 条」。
     两个来源：
       - 差集表（#comptheirs / #compours）的行 —— 本次提交才第一次变得可点击，
         它们按 `competitorLimit` 截断，与桶的插入顺序无关；
       - 四象限表（#compquadrants）截断后的行。
     把「渲染集」和「证据集」做成同一个集合，而不是靠两处算术凑巧相等 —— 上一版
     路由写 300、页面写 40，于是 87% 的可见差距点开是空的。 */
  const diffKeywords = [...diff.theirsOnly, ...diff.oursOnly].map(row => row.keyword)
  const renderedQuadrantKeywords = QUADRANT_ORDER.flatMap(key => sliced[key].map(row => row.keyword))
  const evidenceKeywords = [...new Set([...diffKeywords, ...renderedQuadrantKeywords])]
  const rawEvidence = readCompetitorEvidence(store, {
    asin: sides.asin, marketplace: sides.marketplace, peers: sides.peers, keywords: evidenceKeywords,
  })
  const evidence = {}
  for (const keyword of evidenceKeywords) {
    const raw = rawEvidence.get(keyword) ?? { our: null, their: null }
    evidence[keyword] = buildEvidenceView({
      keyword, marketplace: sides.marketplace, our: raw.our, their: raw.their,
    })
  }

  return {
    sets,
    asin,
    marketplace,
    reverse,
    selectedSetId: set.id,
    selectedSetName: set.name,
    excludedSelf: sides.excludedSelf,
    peers: sides.peers,
    diff,
    quadrants,
    evidence,
    /* 自动发现竞品的预览：从库里已有反查事实算，**不写库**。
       写库要人点头，走 POST competitor-discover。 */
    discover: safeDiscover(store, { asin: sides.asin, marketplace: sides.marketplace }),
    /* 竞品关系总表：三种状态都列（active / suggested / inactive），
       否则「候选没采纳」和「已停用」都会变成「不存在」。 */
    relations: listAllCompetitors(store, { marketplace: sides.marketplace, limit: 300 }),
  }
}

/** An order key the diff actually implements; anything else falls back. */
/**
 * 自动发现竞品的预览。读完不写 —— 写库要人点头（POST competitor-discover）。
 * 失败返回 null 而不是抛：竞品页其他部分还有用，不该被这一块拖垮。
 */
function safeDiscover(store, { asin, marketplace }) {
  try {
    const found = discoverCompetitors(store, { ourAsin: asin, marketplace, limit: 10 })
    return {
      candidates: found.candidates,
      keywords: found.consideredKeywords,
      note: found.note,
    }
  } catch (error) {
    return { error: error.message, candidates: [], keywords: [], note: null }
  }
}

function orderOr(value, fallback) {
  return Object.hasOwn(DIFF_ORDERS, String(value ?? '')) ? String(value) : fallback
}

/** A filter value as an integer, clamped, with a default for anything unusable. */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/**
 * The research panel's candidates.
 *
 * Seeds come from the page's own box (`filters.seeds`), and this reads the
 * library and the competitor facts — the two sources that need no browser. The
 * third source, Amazon's suggestions, needs a real storefront and several
 * seconds per seed, so it is **not** done here: the panel's 扩词 button writes a
 * prompt for the agent, who runs `amzn_keyword_research` with the browser
 * (ARCHITECTURE §4.6).
 *
 * That split is why the panel is useful before anyone talks to an agent: type a
 * seed and you immediately see what is already known about it, which is usually
 * the answer to "do I need to research this at all".
 */
function researchState(store, filters) {
  const seeds = parseSeeds(filters.seeds)
  const marketplace = String(filters.marketplace ?? 'US').trim().toUpperCase()
  if (seeds.length === 0) return { seeds: [], marketplace, candidates: null }

  const library = seeds.flatMap(seed => readResearchLibrary(store, { marketplace, seed, limit: 400 }))
  const competitor = seeds.flatMap(seed => readResearchCompetitor(store, { marketplace, seed, limit: 400 }))
  const merged = { seeds, marketplace, suggest: [], library, competitor }
  const inLibrary = readLibraryMembership(store, { marketplace, keywords: collectCandidateKeywords(merged) })

  return {
    seeds,
    marketplace,
    candidates: buildResearchCandidates({ ...merged, inLibrary }, { limit: 200 }),
  }
}

/**
 * One text box, comma- or newline-separated.
 *
 * **Spaces are deliberately not a separator.** A seed is usually a phrase —
 * "bluetooth speaker" is one seed, not two — so splitting on whitespace would
 * turn every multi-word seed into a pile of single words, and the result would
 * look like a working search that found the wrong things. Commas and new lines
 * are what a person types when they mean "these are separate".
 */
function parseSeeds(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '')
  return [...new Set(raw.split(/[,\n]/).map(seed => seed.trim()).filter(seed => seed !== ''))]
}

/**
 * 收件箱四个状态动作共用的那一半：查轮次 → 交给 `applyInboxAction`。
 *
 * 四条路由各自写开（审计守卫要看得见字面路由名），但「轮次不存在时说什么」只有一份
 * —— 四条路由各写一遍就会有四句措辞，而其中一句迟早会写成「操作失败」这种什么也没说的
 * 话。这里返回的是**拒绝对象**，路由原样发回去。
 */
function applyInboxStateAction(store, action, body) {
  const runId = String(body?.runId ?? '').trim()
  const run = runId === '' ? null : getOptimizationRun(store, runId)
  if (run === null) {
    return {
      ok: false,
      code: 'INBOX_DRAFT_NOT_FOUND',
      error: `没有第 ${runId.slice(0, 8)} 轮优化 —— 草案挂在轮次上，先跑一次 amzn_optimize_prepare。`,
    }
  }
  return applyInboxAction(store, { action, run, field: body?.field })
}

/** 一条收件箱写动作的活动记录。四个动作共一种形状，动作名在 `action` 里。 */
function inboxAuditNote(output) {
  return {
    action: output.action,
    runId: output.runId,
    field: output.field,
    group: output.group,
    unchanged: output.unchanged,
  }
}

/** The optimize module's data: the run list, the one run being looked at, and
 *  模块 14 §6-§9 的发布闭环切片（发布记录 / 偏离 / 观测 / 回滚）。 */
function optimizationState(store, filters, pagePath, currentContextId = null) {
  const listed = listOptimizationRuns(store, {
    asin: filters.asin,
    marketplace: filters.marketplace,
    limit: 30,
  })
  const runId = filters.runId ?? listed.rows[0]?.id ?? null
  const run = runId === null ? null : getOptimizationRun(store, runId)

  /* `now` 只取一次：卡片状态、到期判断、回滚就绪度都从同一个时刻算 —— 三次
     `nowIso()` 会让同一屏里「第 7 天还没到」和「第 7 天已到期」同时出现。 */
  const now = nowIso()
  const publications = listPublications(store, {
    asin: filters.asin ?? null,
    marketplace: filters.marketplace ?? null,
    limit: 30,
  })
  /* 通知链接 '#optimize#observation:<publicationId>' 的 id 段**优先于**行点击留下的
     `publicationId`：它来自最近一次点击，是更晚的意图（page.js 在换选一行时会丢掉
     这个锚点，所以它不会一直盖住行点击）。 */
  const anchorId = observationAnchor(filters.anchor)
  const requestedId = String(filters.publicationId ?? '').trim() || null
  const selectedPublicationId = anchorId ?? requestedId ?? publications.rows[0]?.id ?? null
  const publication = selectedPublicationId === null ? null : getPublication(store, selectedPublicationId)
  const rate = publicationRate(store, {
    asin: filters.asin ?? null,
    marketplace: filters.marketplace ?? null,
  })
  /* 全库的回滚任务：§9 的 stale 判定是「任务 vs 当前线上」的跨发布事实，列表不按
     ASIN 收窄，否则一条更早的发布上的待办任务会被悄悄漏掉。`listRollbackTasks`
     返回 `{ rows, limit }`，页面要的是 `rows` —— 把整个包装对象塞进 payload 会让
     `Array.isArray` 为假，回滚任务表**永远是空的**。 */
  const rollbackTasks = listRollbackTasks(store, { limit: 50 }).rows

  /* 同一张卡片可能被列表和展开各读一次；缓存它，别把同一张卡片算两遍。 */
  const cards = new Map()
  const cardOf = (id) => {
    if (!cards.has(id)) cards.set(id, publicationObservation(store, id, { now }))
    return cards.get(id)
  }

  /* ── F13-02 / F13-04：九项门槛与四种模式 ───────────────────────────────────
     页面**不自己判**这九项。有选中轮次时读那一轮冻结下来的判定（§33：优化运行固定
     使用当时判定结果）；没有冻结报告时才为筛选中的 ASIN 现算一次 —— 两条路都是
     `precheckFor` 的产出，而 `precheckFor` 就是 `amzn_optimize_precheck` 与
     `amzn_optimize_prepare` 用的那一个函数。所以「页面点一次与会话调一次是同一条
     规则」不是两个实现互相保证，而是只有一个实现。

     `optimizeMode` / `optimizeScope` 走 `OPTIMIZE_MODES.includes` 而不是查表：
     `OPTIMIZE_MODE_LABELS['constructor']` 会命中原型链上的函数，然后页面拿着一个
     函数当作模式名渲染（B13.1 ① 的同款）。 */
  const optimizeMode = OPTIMIZE_MODES.includes(String(filters.optimizeMode ?? '')) ? String(filters.optimizeMode) : 'full'
  const optimizeScope = TARGETED_SCOPES.some(scope => scope.id === filters.optimizeScope) ? String(filters.optimizeScope) : null
  const frozenReport = run === null ? null : readFrozenPrecheck(run)
  const liveReport = frozenReport === null && (filters.asin ?? '') !== ''
    ? precheckFor(store, {
        asin: filters.asin,
        marketplace: filters.marketplace ?? 'US',
        mode: optimizeMode,
        scope: optimizeScope,
      })
    : null
  const precheck = frozenReport ?? liveReport

  /* ── B-13b / F13-01：收件箱 ────────────────────────────────────────────────
     逐行投影在 `describeOptimizationRun` 里（它调 `draftInboxRow`），分组与筛选在
     `buildInbox` / `inboxFilterFrom` 里 —— 全是 `domain/optimize/inbox.js` 那一份。
     页面拿到的每个 `group` / `buckets` / `contextState` 都是算好的，它不重算。

     `contextId` 从工作台来：`current` 这个筛选值要与它比对。工作台没有上下文时
     `current` 匹配不到任何行，而 `buildInbox` 会把这件事**说成一个独立的空**
     （`no-current-context`），不是「没有草案」。 */
  const approvalRequired = approvalPolicy(store).acceptDraft === true
  const described = run === null
    ? null
    : describeOptimizationRun(store, run, { currentContextId, approvalRequired })
  const inbox = buildInbox(described === null ? [] : described.drafts, {
    filter: inboxFilterFrom(filters),
    currentContextId,
  })
  /* F13-03：证据包。只读；`readEvidence` 连「十类里缺了哪几类」一起给出来，
     缺行不等于「这一类没有」。没有选中轮次时是 null —— 「没选」与「这一轮没有」
     是两件事，页面分开说。 */
  const evidence = run === null ? null : readEvidence(store, run.id)
  /* ── B-13c / F13-05 · F13-06：策略卡与位置计划核对 ──────────────────────────
     两块都是**读算好的那一份**：九项的 status / source / facts 与门禁的 open / state
     来自 `readStrategy`（它内部调 `strategyGate`，与工具侧同一个函数）；继承、建议、
     决策与写回来自 `readPlanCheck`。页面**不重算任何判据**，所以「把域层改坏 →
     工具侧与页面侧两条断言同时红」是结构上成立的，不是靠自觉。
     没有选中轮次时两块都是 null —— 「没选一轮」与「这一轮没有策略卡」是两件事。 */
  const strategy = run === null ? null : readStrategy(store, run.id)
  const planCheck = run === null ? null : readPlanCheck(store, run.id)

  /* ── B-13d / F13-08：校验体系（规则 / 闸门 / Agent 审阅三块）──────────────────
     `described` 传进去而不是让它自己再算一次：闸门面板与上面表头那个 chip 必须来自
     **同一次** `runGates`，否则同一屏上会有两个「闸门 4/6」和「闸门 5/6」，而两边都
     不报错。规则命中读的是 `described.drafts[].violations` —— 与收件箱的分组、
     表头的 chip 是同一份内容（不是再跑一遍 `validateDraft`，那会与它们打架）。 */
  const validation = run === null ? null : readValidationSystem(store, run.id, { view: described })

  /* ── B-13d / F13-09：交付边界（操作清单 + 发布登记跳转）──────────────────────
     「已登记」由**读这一轮的发布登记内容**重算（`publicationsForRun` 走模块 14 自己的
     读口），而不是由任何自报的状态得出。手填字段的三态用 `manualFieldRows` —— 与报告
     第十一节同一个函数，所以面板与报告不会对「这个字段库内有没有」给出两个答案。 */
  const runPublications = run === null ? [] : publicationsForRun(store, run)
  const asinRow = run === null ? null : (getAsin(store, run.asin, run.marketplace)?.row ?? null)
  const delivery = run === null ? null : buildDelivery({
    run: {
      id: run.id,
      asin: run.asin,
      marketplace: run.marketplace,
      draftVersion: described?.draftVersion ?? null,
    },
    rows: (described?.drafts ?? []).map(draft => ({
      field: draft.field,
      accepted: draft.accepted === true,
      after: draft.after,
    })),
    manualFields: manualFieldRows(asinRow),
    publications: runPublications,
    now,
  })

  /* ── B-13d / F13-09：发布登记跳转带来的意图 ───────────────────────────────
     锚点约定 'publication:draft:<runId>'（与模块 14 的 'observation:<id>' 同一套：
     冒号后是参数，落点仍然是那个区块）。解析不出就是 null —— 退化成「这一屏不是从
     跳转来的」，不崩。

     **草案版本从 run 行读回来**，绝不写进链接：`amzn_publication_record` 要求
     「草案版本必须等于该运行的当前 draft_version」，链接里钉一个版本号会在草案又改过
     之后变成一次注定被拒的登记 —— 而用户会以为是插件坏了。 */
  const publicationIntent = publicationAnchor(filters.anchor)
  const publicationPrefill = publicationIntent === null
    ? null
    : publicationPrefillFor(store, publicationIntent.runId, { now })

  return {
    rows: listed.rows.map(row => ({
      id: row.id,
      asin: row.asin,
      marketplace: row.marketplace,
      status: row.status,
      draftCount: row.draft_count,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
    total: listed.total,
    run: described,
    reportUrl: run === null ? null : `${pagePath}/report/${run.id}`,
    /* B-13b / F13-01：五态分组 + 上下文画像 + 筛选后的行。`groupIds` 是页面画
       分组条时用的词表 —— 它从载荷来，不在页面里再写一份。 */
    inbox: { ...inbox, groupIds: [...INBOX_GROUP_IDS], currentContextId },
    /* B-13b / F13-03：十类证据包（只读冻结表的内容 + 缺哪几类）。 */
    evidence,
    /* B-13c / F13-05：九项策略卡 + 门禁（确认状态由 `confirmed_at` 重算）。
       B-13c / F13-06：位置计划核对（继承 08 的哪一版 / 本轮建议 / 决策 / 写回哪一版）。 */
    strategy,
    planCheck,
    /* B-13d / F13-08：校验体系（规则 / 闸门 / Agent 审阅三块，一个入口）。
       B-13d / F13-09：交付边界（操作清单 + 边界三态 + 发布登记跳转）。 */
    validation,
    delivery,
    /* B-13d / F13-09：锚点 'publication:draft:<runId>' 带来的登记意图与预填值。
       null = 这一屏不是从那条跳转来的（不是「读不到」）。 */
    publicationIntent,
    publicationPrefill,

    publications: publications.rows.map(record => ({
      ...publicationRow(record),
      observationState: cardOf(record.id)?.state ?? null,
    })),
    publicationsTotal: publications.total,
    publicationRate: {
      numerator: rate.numerator,
      denominator: rate.denominator,
      ratio: rate.ratio,
      manualExcluded: rate.manualExcluded,
      note: rate.note,
    },
    selectedPublicationId,
    /* 一个留在 context 里的 publicationId 指向已消失的记录时，页面要说出来，
       而不是画一个空面板 —— 和 `run === null` 的处理同款。 */
    publicationGone: selectedPublicationId !== null && publication === null,
    publication: publication === null ? null : publicationClosure(store, publication, cardOf(publication.id), now),
    rollbackTasks,
    baselineChoices: [...BASELINE_CHOICES],
    conclusionLabels: { ...CONCLUSION_LABELS },
    anchor: anchorId,

    /* F13-04：模式与专项的词表，只有一个来源（domain/optimize/mode.js）。 */
    modes: modeCatalog(),
    mode: optimizeMode,
    modeLabel: OPTIMIZE_MODE_LABELS[optimizeMode],
    targetedScopes: TARGETED_SCOPES.map(scope => ({
      id: scope.id,
      label: scope.label,
      why: scope.why,
      fieldCount: scope.fields.length,
    })),
    scope: optimizeScope,

    /* F13-02：九项门槛的报告。`precheckSource` 说这份判定是从哪来的 ——
       frozen 是这一轮开始时的判定，live 是现在算的，「不说是哪一种」会让读者
       把一份历史判定当成今天的事实。 */
    precheck,
    precheckSource: frozenReport !== null ? 'frozen' : (liveReport !== null ? 'live' : null),
  }
}

/**
 * The pre-flight report a run was started under, or `null`.
 *
 * Read, never re-derived: §33 asks that an optimization run fix the freshness
 * verdict it started with, and re-running the gates here would quietly replace a
 * frozen judgement with today's — the page would then show a run "passing" gates
 * it never passed. A run with no report (one started before this feature) returns
 * `null`, and the slice falls back to a live evaluation instead of assuming it
 * passed.
 */
function readFrozenPrecheck(run) {
  const parsed = safeJson(run?.package_json)
  const report = parsed === null || typeof parsed !== 'object' ? null : parsed.precheck
  if (report === null || report === undefined) return null
  return Array.isArray(report.gates) && report.gates.length > 0 ? report : null
}

/** 通知链接的锚点约定：'#optimize#observation:<publicationId>'（store/observe.js 的
 *  notificationLink）。解析不出就返回 null —— 页面据此退化成「选中最新一条」，不崩。 */
function observationAnchor(anchor) {
  const match = /^observation:(.+)$/.exec(String(anchor ?? '').trim())
  return match === null ? null : match[1].trim() || null
}

/**
 * 优化面板的发布登记跳转带来的锚点：'publication:draft:<runId>'。
 *
 * 与上面的 `observationAnchor` 同一套约定（冒号后是参数、落点仍是区块），但参数是
 * **哪一轮**而不是**哪一条发布**：跳转的语义是「我要为这一轮登记一次发布」，
 * 而登记记录还不存在（它正是这次要去建的东西）—— 所以它只能指向轮次。
 * 解析不出返回 null，不是 `{}`：一个空意图与「没有意图」会让表单做两件不同的事。
 */
function publicationAnchor(anchor) {
  const match = /^publication:draft:(.+)$/.exec(String(anchor ?? '').trim())
  if (match === null) return null
  const runId = match[1].trim()
  return runId === '' ? null : { kind: 'draft', runId }
}

/**
 * 发布登记表单的预填值 —— **从那一轮的 run 行读回来**。
 *
 * 四条都必须从库里读、不能写进链接：
 *   · `draftVersion` —— 见上面那段（版本必须等于当前值，否则登记必被拒）；
 *   · `asin` / `marketplace` —— 登记时必须与那一轮的一致；
 *   · `fields` —— 「实际发布值」的建议内容 = 这一轮**可复制粘贴**的那些字段，
 *     也就是人刚从报告里抄过去的东西。它只是一个**建议**：真正发布的是后台里那一个
 *     值，登记的人要自己核对并删掉没改的项。表单默认把它填进 textarea，
 *     而不是留一个空框让人从零手打 JSON。
 *
 * 轮次不存在时返回一个**说得出「找不到」**的对象（`found: false`），
 * 而不是 null —— null 的含义是「这一屏不是从跳转来的」，两者不是一件事。
 */
function publicationPrefillFor(store, runId, { now = nowIso() } = {}) {
  const target = getOptimizationRun(store, runId)
  if (target === null || target === undefined) {
    return {
      kind: 'draft',
      found: false,
      runId,
      note: `这条跳转指向的第 ${String(runId).slice(0, 8)} 轮已经不在了 —— 表单不预填任何东西。`,
    }
  }
  const described = describeOptimizationRun(store, target)
  const delivery = buildDelivery({
    run: {
      id: target.id,
      asin: target.asin,
      marketplace: target.marketplace,
      draftVersion: described?.draftVersion ?? null,
    },
    rows: (described?.drafts ?? []).map(draft => ({
      field: draft.field,
      accepted: draft.accepted === true,
      after: draft.after,
    })),
    manualFields: manualFieldRows(getAsin(store, target.asin, target.marketplace)?.row ?? null),
    publications: publicationsForRun(store, target),
    now,
  })
  const version = described?.draftVersion
  return {
    kind: 'draft',
    found: true,
    runId: target.id,
    asin: target.asin,
    marketplace: target.marketplace,
    draftVersion: Number.isFinite(Number(version)) ? Number(version) : null,
    /* 「读不到版本」与「版本是 0」分开：前者会在登记时被拒（且理由要说清），
       后者是一个合法的版本号。 */
    draftVersionKnown: Number.isFinite(Number(version)),
    fields: delivery.ok === true ? delivery.registration.fields : [],
    anchor: `publication:draft:${target.id}`,
    note: '实际发布值由**你**核对后提交：预填的是这一轮可复制粘贴的那些字段，'
      + '只保留你真的在后台改过的；登记不是「已上线」的证明。',
  }
}

/** 一条发布记录的页面视图。字段名与 store 的 hydratePublication 一致，方便对照。 */
function publicationRow(record) {
  return {
    id: record.id,
    asin: record.asin,
    marketplace: record.marketplace,
    kind: record.kind,
    runId: record.runId,
    draftVersion: record.draftVersion,
    deviated: record.deviated,
    deviationRule: record.deviationRule,
    baselineChoice: record.baselineChoice,
    baselineDecidedAt: record.baselineDecidedAt,
    operator: record.operator,
    note: record.note,
    publishedAt: record.publishedAt,
    observationStartAt: record.observationStartAt,
    observationTerminatedAt: record.observationTerminatedAt,
  }
}

/**
 * 选中发布的展开：§7 的观测计划、§8 的观测卡片、§9 的回滚就绪度。
 *
 * `blockedBy` 用的是 `ensureCheckpoints` 的**词**，但只在它确实会拦的时候调它 ——
 * waiting_human / terminated 两条分支在任何写之前就返回（见 store/observe.js 的
 * ensureCheckpoints），所以这里对它们是只读的，而且拿到的是 store 自己那句 reason。
 * 判据不在这一层重写：store 的注释点名过，两份同样的条件迟早分叉。
 */
function publicationClosure(store, record, card, now) {
  let blockedBy = null
  let blockedReason = null
  if (card !== null && (card.waitingHuman || card.terminatedAt !== null)) {
    const gate = ensureCheckpoints(store, record.id, { now })
    blockedBy = gate.blockedBy
    blockedReason = gate.reason
  }
  return {
    ...publicationRow(record),
    plans: listObservationPlans(store, record.id),
    plan: card === null ? null : card.plan,
    observation: card === null ? null : {
      state: card.state,
      waitingHuman: card.waitingHuman,
      blockedBy,
      blockedReason,
      terminatedAt: card.terminatedAt,
      terminatedReason: card.terminatedReason,
      window: card.window,
      nextDue: card.nextDue,
      data: card.data,
      checkpoints: card.checkpoints,
    },
    rollback: card === null ? null : card.rollback,
  }
}

/* `describeOptimizationRun` used to live here. It moved to `src/domain/optimize/run-view.js`
   when `amzn_report_diff` needed the same resolved view: a tool importing it from
   this file would have pulled the page template into the tool graph to reach one
   function, and a second copy of the limits/roster rules would have let the diff
   and the panel disagree about the same run. */

/** A report that is missing must say so, not return an empty page. */
function notFoundPage(runId) {
  const escaped = String(runId ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<title>报告不存在</title>',
    '<style>body{margin:0;padding:60px 24px;font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'background:#f6f7f9;color:#1c1f24}main{max-width:560px;margin:0 auto}code{background:#eceff3;padding:1px 5px;border-radius:4px}',
    'a{color:#2f6feb}</style></head><body><main>',
    '<h1 style="font-size:18px">这份报告还没有生成</h1>',
    escaped === ''
      ? '<p>没有指定运行 ID。</p>'
      : `<p>运行 <code>${escaped}</code> 不存在，或者还没有调用 <code>amzn_optimize_save</code> 生成报告。</p>`,
    '<p>报告是在 <code>amzn_optimize_save</code> 时生成的 —— 只做过 prepare / validate 的运行还没有报告。</p>',
    '<p><a href="javascript:history.back()">返回</a></p>',
    '</main></body></html>',
  ].join('')
}

/**
 * One row of the page's `tasks` slice, narrowed to the fields the page reads.
 *
 * `renderTasks` (`page.js:6180-6203`) reads exactly these; the header's
 * running-task line (`page.js:5962`) reads `kind` + `status`. Everything else in
 * `hydrate()` has **no reader on this payload** — `targets` and `result.results`
 * above all — and §8-46's budget is what pays for it: at the contract's own
 * per-task ceiling (200 ASINs) those two fields are ~437 KB for the fifteen rows,
 * which is 3.9× the 120 KB the endpoint is allowed (主理人修订 2026-10-09, 契约 §6.3).
 *
 * A whitelist rather than a delete-list: a field added upstream reaches the page
 * only when somebody names it here, so the next heavy blob cannot ride along
 * unnoticed. `src/tools/collect.js` reads `collection.list()` directly and is not
 * affected — the `targets`/`result.results` it may want are still there.
 */
function collectTaskRow(task) {
  const result = task.result === null || task.result === undefined ? null : task.result
  /* 只回传目标的**条数**，不回传目标本身。
     200 条任务 × 每任务 200 目标时，整份 targets 会把 /api/state 从 120 KB 的预算
     顶到 155.6 KB（B04P-㉛ 当场就红了）。「重填」按钮点下去时再按 id 取一次
     （collect-task-targets），那是**一次点击换一次请求**，不是每秒轮询都带。 */
  const rawTargets = Array.isArray(task.targets) ? task.targets : []
  return {
    id: task.id,
    kind: task.kind,
    source: task.source,
    status: task.status,
    submittedAt: task.submittedAt,
    finishedAt: task.finishedAt ?? null,
    error: task.error ?? null,
    progress: task.progress ?? null,
    targetsCount: rawTargets.length,
    /* P3-3：剩余时间与「算不出来」的原因由 domain 的纯投影给出。
       加在这里而不是 `hydrate()` —— 实测这条 payload 走的是 collectTaskRow，
       `hydrate()` 在这条路径上没有读者（见上面那段注释）。 */
    progressView: progressView(task.progress ?? null, {
      status: task.status,
      submittedAt: task.submittedAt,
      finishedAt: task.finishedAt ?? null,
    }),
    result: result === null ? null : {
      written: result.written ?? null,
      failed: result.failed ?? null,
      scanned: result.scanned ?? null,
    },
  }
}

/** The header needs to know whether anything is running; the rows come from list(). */
function collectionSummary(collection, store = null) {
  const listed = collection.list(1)
  /* `waitingCount` / `coolingCount` are counted in SQL rather than by walking
     `list(15)`: a waiting task is exactly the one that must NOT fall off the end
     of a fifteen-row window, and `todayUsage` is the number the next submission
     will be measured against. */
  const byStatus = status => (store === null
    ? 0
    : Number(store.get('SELECT COUNT(*) AS rows FROM collection_task WHERE status = ?', [status])?.rows ?? 0))
  return {
    running: listed.running,
    queue: listed.queue,
    queueDepth: listed.queue.length,
    waitingCount: byStatus('waiting_human'),
    coolingCount: byStatus('cooling_down'),
    checkingCount: byStatus('checking_env'),
    todayUsage: collection.dailyUsage === undefined ? null : collection.dailyUsage(),
  }
}

/**
 * The collection panel's read-only slice (contract §6.3).
 *
 * Everything here is small or bounded, because it rides on a three-second poll:
 * ten environment rows, one row per scheme, the plans, the site's current risk,
 * and — only for the selected task — its per-ASIN summaries. The section detail
 * is deliberately **not** here; it is one ASIN at a time through
 * `GET /api/sections`, which is what keeps this payload under the contract's
 * 120 KB ceiling.
 *
 * `collection` is required (no default): the 「此刻生效」 half-sentence has to come
 * from the service that actually obeys it, and a missing service must fail here
 * rather than ship a null the page would then report as an outage.
 */
function collectionPanel(store, filters = {}, { sources = null, selection = null, workspaceId = null, collection } = {}) {
  const envRows = latestEnvChecks(store, { taskId: null })
  const env = envRows.length === 0 ? null : {
    checkedAt: envRows[0].checkedAt,
    checks: envRows.map(row => ({
      /* The ten *labels* live in `ENV_CHECK_META` and the stored row keeps only
         the id, so they are joined here. Copying them into the page instead would
         be a second spelling of the ten item names — and the one a reader would
         believe when the two drifted. */
      id: row.checkId,
      label: ENV_CHECK_META[row.checkId]?.label ?? row.checkId,
      status: row.status,
      detail: row.detail,
      repairable: row.repairable,
      repairAction: row.repairAction,
      risk: row.risk,
    })),
    summary: {
      ok: envRows.filter(row => row.status === 'ok').length,
      warn: envRows.filter(row => row.status === 'warn').length,
      fail: envRows.filter(row => row.status === 'fail').length,
      unknown: envRows.filter(row => row.status === 'unknown').length,
      repairable: envRows.filter(row => row.repairable).length,
      total: envRows.length,
    },
  }

  const taskId = String(filters?.taskId ?? '').trim()
  /* `getCollectionTask` 就是 `store.get`，查不到时回的是 **undefined**，不是 null。
     这里原来只写了 `taskId === '' ? null : ...`，于是 filters.taskId 指向一条不存在的
     任务（过期的、截断的、手写错的 id）时 `selected` 是 undefined —— 下面两处
     `selected === null` 的判空全部漏过，`selected.id` 当场抛 TypeError，整个
     buildState 挂掉，/api/state 变 400、所有切片都到不了页面（T61 的 BLOCK 回归）。
     `?? null` 把「没查到」收敛成「没有选中」，与 `taskId === ''` 同一句回答。 */
  const selected = taskId === '' ? null : (getCollectionTask(store, taskId) ?? null)
  const newestRisk = store.get(
    'SELECT risk_json, submitted_at FROM collection_task WHERE risk_json IS NOT NULL ORDER BY submitted_at DESC LIMIT 1',
  )
  const cooldown = siteCooldown(store, String(filters?.marketplace ?? 'US').toUpperCase())

  /* F04-04: the prefill banner. Built by the **same** `prefillFor` the run path
     calls, from the same entries: the external entry hands over its ASINs in the
     workbench selection and its name in `filters.collectContextId`, and the form
     shows the default range before anything is submitted. A second build of
     "which fields are out of date" is how the banner would promise one range and
     the run record another. `prefillFor` returns null when there is no external
     entry — that is "nothing was prefilled", not an empty prefill. */
  const sourceId = String(getSetting(store, 'collect.defaultSource') ?? 'browser-local')
  const supported = sources?.get?.(sourceId)?.capabilities?.().fields ?? []
  const targets = (Array.isArray(selection?.asins) ? selection.asins : [])
    .map(entry => ({
      asin: String(entry?.asin ?? '').trim().toUpperCase(),
      marketplace: String(entry?.marketplace ?? filters?.marketplace ?? 'US').trim().toUpperCase(),
    }))
    .filter(entry => entry.asin !== '')
  const prefill = prefillFor({
    store,
    sourceContextId: filters?.collectContextId,
    args: {
      marketplace: filters?.marketplace,
      schemeId: filters?.schemeId,
      fields: Array.isArray(filters?.fields) ? filters.fields : undefined,
    },
    targets,
    supported,
  })

  /* The form's site block: the same dossiers the settings panel lists, plus the
     **effective** postal code (`postalCodeFor`, not the site default) — the form
     has to print the number `amzn_collect_run` will actually use. */
  const sites = siteDossiers(store, workspaceId).map(site => ({
    code: site.code,
    label: site.label,
    postalCode: postalCodeFor(store, site.code),
    language: site.language,
    currency: site.currency,
  }))

  const summariesRead = selected === null
    ? null
    : taskAsinSummariesWithCoverage(store, { taskId: selected.id })

  return {
    env,
    /* 限速控件读的那几行（契约 §6.3 主理人修订 2026-10-09）。它们**不能**靠
       `settings` 那份惰性切片：那一份只在 `context.module === 'settings'` 时才算，
       而控件长在**采集**模块的发起表单里 —— 于是 `module=collect` 时
       `state.settings === null`，那一格永远走「读不到设置行」（实测：settings=null /
       pacing rows = n/a）。反过来把整份设置面塞进采集页的轮询也是不自洽的：
       这里要的只有几行数字，`collectPanel` 本来就是采集页的专属载荷。
       按**声明的前缀**取（`settingsRowsFor` 走 `DECLARED`），不写死键名。 */
    pacingRows: settingsRowsFor(store, 'pacing.'),
    /* 「服务端此刻生效」那半句（契约 §6.3 主理人修订 2026-10-09 第二次）。B-04c-2 时它读的是
       `settings.pacing.resolved` —— 而 `settings` 是惰性切片（只在 `module === 'settings'`
       时算），于是采集模块上这一格永远印「服务端未就绪，读不到生效值」，**右边却印着真实的
       用量**（那一份来自 `collection.todayUsage`）。一句假话紧挨着一个真数字，读者无从分辨。

       这里**只加 `resolved`**：`used / limit / remaining` 在采集模块上本来就渲染正确，
       再放一份就是同一个数字的第二来源（与本节前面两条裁决同一条纪律）。

       取值走 `pickPacing(collection.pacing())` —— 与采集服务自己用的是**同一个函数**，
       不在这里新写一份「怎么算生效值」。也**不给** `collection` 兜底：这份载荷是采集页的
       专属切片，服务没接上时应该在这里炸出来，而不是安静地发一份 null 让页面继续说那句
       假话。 */
    pacing: { resolved: pickPacing(collection.pacing()) },
    /* P1-4 采集耗时对账。为什么放在采集页：`estimateMinutes` 的预估就出现在这一页的
       发起表单里，运营据此排期，而**从来没有人在核对它准不准**。
       喂进去的是真实数据：`finished_at − submitted_at` 是墙钟耗时（含排队/冷却），
       预估用同一个 `estimateMinutes` + **同一份完整 pacing** 重算。

       ⚠️ 这里**不能用 `pickPacing()` 的返回值**：那是给页面控件显示用的投影，
       只留 4 个字段（perTaskMax / taskGapMs / beforeNavigateMs / humanize），
       故意丢掉了 `afterLoadMs` / `longBreakMs` / `longBreakEvery` ——
       而这三个正是 `estimateMinutes` 要读的。我第一次就是这么写的，真机上
       直接得到「pacing 不可用」的对账结论：一套能跑、但永远算不出来的代码。
       所以取完整的 `collection.pacing()`。 */
    estimateAudit: (() => {
      const fullPacing = collection.pacing()
      return reconcileTasks(
        store.all(
          `SELECT id, status, submitted_at, finished_at, targets_json FROM collection_task
            WHERE kind = 'asin' AND finished_at IS NOT NULL
            ORDER BY submitted_at DESC LIMIT 50`,
        ),
        { estimate: estimateMinutes, pacing: fullPacing },
      )
    })(),
    schemes: listSchemes(store),
    plans: listCollectionPlans(store).map(plan => ({
      ...plan,
      nextWindow: plan.window === null ? null : windowState(plan.window),
    })),
    risk: {
      /* Two different facts, both needed by the panel: the **most recent** risk
         a task recorded, and whether this site is cooling **right now**. Deriving
         one from the other is how an expired cooldown keeps looking active. */
      last: newestRisk === undefined ? null : { ...safeJson(newestRisk.risk_json), at: newestRisk.submitted_at },
      cooldown,
    },
    waiting: selected === null ? null : waitingView(selected),
    selectedTask: selected === null ? null : {
      taskId: selected.id,
      status: selected.status,
      error: selected.error ?? null,
      waiting: waitingView(selected),
      /* With coverage: the panel's "这个任务记下了 N 个 ASIN" is a claim about the
         task, and a capped read can only support a claim about the first 5 000 rows. */
      summaries: summariesRead.summaries,
      summariesCoverage: summariesRead.coverage,
    },
    prefill,
    sites,
  }
}

/* The page's filter set is small and fixed, so the SQL fragments are chosen
   from literals rather than built from the request body. */
function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** Parse a stored JSON blob, or hand back the raw text a hand-edited row holds. */
function safeJson(text) {
  if (text === null || text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Read and parse a JSON body, refusing anything unreasonably large. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (body.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

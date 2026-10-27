/**
 * Tool registration.
 *
 * Every tool this plugin exposes is registered here, and every one of them is
 * wrapped by `instrument` first. That wrapper is what gives the workbench its
 * activity feed for free: because the tools live in this plugin, this module is
 * already the place where "what did the agent do" is known, with no need to read
 * DSH's session store.
 *
 * The wrapper also converts a thrown error into a returned failure. A tool that
 * throws kills the whole turn, which is the wrong outcome for something like a
 * malformed ASIN: the agent should get "invalid ASIN" back and try again.
 */

/* 模块 05 第一子批：详情（F05-02 前四页）、字段级事实（F05-03）、变体关系（F05-06）、
   归档（F05-08）。同名同样一批名字必须同时出现在 index.js 的 TOOLS 里 —— 漏一处
   的后果是工具存在、不可调用、且不报错。 */
import {
  asinArchiveTool, asinDeleteTool, asinDetailTool, asinExportTool, asinFieldCorrectTool, asinGetTool, asinQueryTool,
  asinUpsertTool, asinVariantCorrectTool, asinVariantUpsertTool, asinCompetitorTool,
} from './asin.js'
/* 模块 05 F05-01 的保存视图：三个工具，读一写二。视图是**一组输入**
   （筛选 + 列配置），不是一份结果 —— 与页面的两条写路由共用同一对 store 函数，
   所以「同名怎么办」「什么算合法视图名」只有一份实现。 */
import { asinViewDeleteTool, asinViewListTool, asinViewSaveTool } from './asin-view.js'
/* B-05c 第二批：F05-04 历史 diff / F05-07 健康摘要 / F05-05 批量导入。三个自成一体的
   文件 —— 与 `asin-view.js` 同一个分法：各自读写的表与别的工具不相干，
   塞进已经一千多行的 `asin.js` 只会让下一次改动更难看清影响面。 */
import { asinHistoryTool } from './asin-history.js'
/* FR-M2-05：归属的写入口。页面路由与它共用同一个 store 函数与同一个动作名 ——
   两个写入点两套审计，等于没有审计。 */
import { asinOwnershipSetTool } from './asin-ownership.js'
import { asinHealthTool } from './asin-health.js'
import { productImportTool } from './product-import.js'
/* R-95 属性补齐：一条读（还缺哪几项）+ 一条写（人工补，带来源与时间）。 */
import { asinAttributeSetTool, asinAttributeStatusTool } from './asin-attribute.js'
import { asinImportTool } from './asin-import.js'
import { auditQueryTool } from './audit.js'
import { collectDoctorTool, collectStatusTool, collectSubmitTool } from './collect.js'
/* 模块 04 F04-01…F04-10 的第二子批：采集中心的工具面与路由面。十二个工具，读七写五
   （`env_check` / `preview` / `detail` / `scheme_list` / `plan_list` 只读），每一条都是
   页面路由会调的同一个函数 —— 页面点一次与会话调一次在审计里必须是同一条。 */
import {
  collectCancelTool, collectDetailTool, collectEnvCheckTool, collectPlanListTool, collectPlanSaveTool,
  collectPreviewTool, collectRepairTool, collectRunTool, collectSchemeListTool, collectSchemeSaveTool,
  collectSchemeTransitionTool, collectWaitingResolveTool,
} from './collect-center.js'
/* 合并取并集：main 侧给 competitor 加了四象限工具（B-06.1），本批不动它。 */
import { competitorAnalyzeTool, competitorQuadrantsTool, competitorSetUpsertTool } from './competitor.js'
import { workbenchContextTool, workbenchFocusTool } from './context.js'
import { keywordCoverageTool, keywordDiscoverTool, keywordImportTool, keywordQueryTool, keywordResearchTool, keywordScanTool } from './keyword.js'
import { kwScanScheduleTool, kwRankHistoryTool, kwExportTool, kwImportTool, kwMergeTool, kwPipelineHistoryTool, kwPipelineRunTool, kwQueryTool, kwReportTool, kwSourceTool } from './kw.js'
/* 模块 08 F08-07 — 关键词九态生命周期。五个工具，读二写三：列表 / 历史 / 单条流转 /
   显式发布关联 / **批量（人的决定）**。生命周期独立于 kw_master（那张表每次导入都整层
   重建），见 src/store/keyword-lifecycle.js 的文件头。 */
import {
  keywordLifecycleBatchSetTool, keywordLifecycleBatchTool, keywordLifecycleHistoryTool,
  keywordLifecycleListTool, keywordLifecycleSetTool,
} from './kw-lifecycle.js'
/* v69 — 关键词的产品线**归属**（F-5 的 B 半）。两条：读一个词的生效归属（人工 / 自动 /
   未分类 + 凭什么），与批量裁决归属。判定只有 store/keyword-product-line.js 的
   `effectiveProductLine` 一处；这两个工具都不自己算「人工 > 派生」。 */
import {
  keywordProductLineBatchSetTool, keywordProductLineGetTool,
} from './keyword-product-line.js'
/* 模块 08 F08-04 — 关键词所有权工作台。五个工具，读二写三：工作台 / 影响预览 / 批量 /
   Agent 建议 / 人工裁决。主人与冲突是推导的，预览与执行共用一个函数，见
   src/store/keyword-ownership.js 的文件头。 */
import {
  keywordOwnershipBatchTool, keywordOwnershipListTool, keywordOwnershipPreviewTool,
  keywordOwnershipResolveTool, keywordOwnershipSuggestTool,
} from './kw-ownership.js'
/* 模块 08 F08-05 — 位置计划持久层。五个工具，读四写一：列表 / 单计划 / 提案（不写库）/
   存一版 / 计划覆盖与实际覆盖。计划是**分配决定**，与 kw_master.for_listing_json 的
   **资格**不是一回事；本模块是计划唯一的持久层（§10），13 只引用不另存。见
   src/store/keyword-plan.js 的文件头。 */
import {
  keywordPlanCoverageTool, keywordPlanGetTool, keywordPlanListTool, keywordPlanProposeTool, keywordPlanSaveTool,
} from './kw-plan.js'
/* 模块 08 F08-08 — 关键词详情（只读）。把 §8.2 七项一次读全，交给会话侧 Agent。
   它最要紧的职责不是列数据，而是不把缺失渲染成真实值：`未测量`（字段在、无行）
   与 `本系统没有这个字段`（概念未建模）是分开的两个词，相关性属于后者。 */
import { keywordDetailTool } from './kw-detail.js'
import { optimizeJobTool } from './optimize-job.js'
import { optimizeEvidenceTool, optimizeInboxTool, optimizePlanCheckTool, optimizePrecheckTool, optimizePrepareTool, optimizeReportTool, optimizeReviewTool, optimizeSaveTool, optimizeStrategyTool, optimizeValidateTool, optimizeValidationTool } from './optimize.js'
import { policyImportTool, policyLinkTool, policyListTool } from './policy.js'
import { productLineClassifyTool, productLineUpsertTool } from './product-line.js'
import { shopTool } from './shop.js'
/* R-91：字段模板 —— 「实际优化时有哪些字段」的唯一登记处（可编辑 / 有版本 / 可回滚）。 */
import {
  fieldTemplateConfirmTool, fieldTemplateDiffTool, fieldTemplateGetTool,
  fieldTemplateProposeTool, fieldTemplateRollbackTool, fieldTemplateSaveTool,
} from './field-template.js'
import { reviewIngestTool } from './review-ingest.js'
import {
  promptHistoryTool, promptListTool, promptPreviewTool, promptReferencesTool, promptRollbackTool, promptUpsertTool,
  promptLifecycleTool, promptLifecycleTransitionTool, promptVersionActivateTool, promptVersionRollbackTool,
  promptEvalImportTool, promptEvalListTool, promptEvalShowTool,
} from './prompt.js'
import { ruleActivateTool, ruleDiffTool, ruleImportTool, ruleListTool, ruleUpsertTool } from './rule.js'
import { reportBuildTool, reportDiffTool, reportListTool, reportUpdateTool } from './report.js'
import { settingListTool, settingSetTool } from './setting.js'
import { sourceListTool, sourceUpsertTool } from './source.js'
import { workspaceUpsertTool } from './workspace.js'
import { dashboardTool } from './dashboard.js'
import { conflictResolveTool, qualityScanTool } from './quality.js'
/* 模块 12 — the Agent orchestration tools. Eleven of them: the run lifecycle, the
   artifact save, the two human decisions (gate + draft artifact), the list, the
   §14 metrics reader, and F12-02's role-config trio (release one version / list
   versions / show one version). The artifact save is where the two human gates are
   asked; the artifact decide is the only way a draft leaves `draft`; the metrics
   reader is read-only and names the record each unavailable metric is missing; the
   role-config release is append-only and named `_release` to pass the naming guard. */
import {
  agentArtifactDecideTool, agentArtifactSaveTool, agentDataRequestListTool, agentDataRequestResolveTool,
  agentDataRequestTool, agentGateDecideTool, agentMetricsTool,
  agentRoleConfigListTool, agentRoleConfigReleaseTool, agentRoleConfigShowTool,
  agentRunFinishTool, agentRunListTool, agentRunRecoverTool, agentRunStartTool, agentRunStepTool,
} from './agent.js'
/* 模块 14 §6/§7 — 发布记录与实验设计。四个工具：登记一次发布、查（含三态分离与
   发布率）、处置偏离、登记观测计划。**没有发布工具**，也永远不会有（§15 的发布
   边界）—— 这里的「登记」永远是「运营在后台改完了，回来记一笔」。 */
import {
  observationCheckTool, observationConcludeTool, observationListTool, observationPlanSaveTool,
  observationScanDueTool, publicationBaselineDecideTool, publicationListTool, publicationRecordTool,
  rollbackListTool, rollbackSuggestTool,
} from './observe.js'
import { WRITE_TARGETS, composeReason, writeTargetFor } from '../domain/audit/targets.js'
import { recordAudit } from '../store/audit.js'
import { CROSS_CUTTING_TOOLS, createFacadeTools, facadeCoverage } from './facades.js'

export function registerTools(ctx, deps) {
  const definitions = buildTools(deps)
  const instrumented = definitions.map(definition => instrument(definition, deps))
  const exposure = process.env.AMAZON_OPS_TOOL_EXPOSURE ?? 'full'

  /* Default: the full 142-name surface, exactly as before. The facade mode is
     opt-in until the facade suite and the role-config switch have been verified;
     turning it on early would change every Agent's tool list in one step. */
  if (exposure !== 'facades') {
    for (const definition of instrumented) ctx.tools.register(definition)
    return definitions.map(definition => definition.name)
  }

  const facades = createFacadeTools(instrumented)
  const { uncovered } = facadeCoverage(definitions.map(definition => definition.name))

  /* Fail closed: a facade set that does not cover every handler would silently
     remove tools from the model. Until the coverage suite is complete, keep the
     full surface and say why instead of activating a lossy subset. */
  if (uncovered.length > 0) {
    console.warn(`[amazon-ops] facade exposure refused: ${uncovered.length} tool(s) uncovered (${uncovered.join(', ')}); keeping full surface`)
    for (const definition of instrumented) ctx.tools.register(definition)
    return definitions.map(definition => definition.name)
  }

  const keep = new Set([...CROSS_CUTTING_TOOLS, ...facades.map(facade => facade.name)])
  const modelTools = [
    ...instrumented.filter(definition => keep.has(definition.name)),
    ...facades,
  ]
  for (const definition of modelTools) ctx.tools.register(definition)
  return modelTools.map(definition => definition.name)
}

/** The tool list, in the order the implementation steps introduce them. */
function buildTools(deps) {
  return [
    // Step 0 — the workbench seam
    workbenchContextTool(deps),
    workbenchFocusTool(deps),
    sourceListTool(deps),
    // The write half of the source list — added by B07 so enabling a source (or
    // handing it a credential) no longer means editing the database by hand.
    sourceUpsertTool(deps),

    // Step 1 — ASIN data management
    asinQueryTool(deps),
    asinGetTool(deps),
    asinUpsertTool(deps),
    /* 模块 05 第一子批。读一写四：详情（F05-02 前四个标签页）、字段级人工修正（F05-03：
       写人工来源、不动原始值与快照）、变体关系与维度（F05-06 的数据层）、纠正一条错误
       关系（同样的数据层：不删行、留历史）、归档与恢复（F05-08 的数据层）。 */
    asinDetailTool(deps),
    asinFieldCorrectTool(deps),
    asinOwnershipSetTool(deps),
    asinVariantUpsertTool(deps),
    asinVariantCorrectTool(deps),
  /* 竞品关系：一行一个竞品，可反查。 */
  asinCompetitorTool(deps),
    asinArchiveTool(deps),
    /* B-05e / F05-08 的受限删除。**独立一个工具**而不是归档那个的第五个动作：
       归档与恢复是同一个可逆标志的两个方向，删除不是那个轴上的东西 ——
       理由写在 `tools/asin.js` 的 `asinDeleteTool` 上。 */
    asinDeleteTool(deps),
    /* F05-01 的剩下三件事：17 列的导出，以及保存视图的读 / 存 / 删。
       导出是只读的（返回文本，不落盘、不写库）；两个视图写动作与页面路由
       调同一对 store 函数。 */
    asinExportTool(deps),
    asinViewListTool(deps),
    asinViewSaveTool(deps),
    asinViewDeleteTool(deps),
    /* B-05c 的第二批：三个工具，按 F05-04 / F05-07 / F05-05 排序。
       两个读（任意两快照的 diff、单 ASIN 的健康摘要）一个写（按表头映射的批量导入，
       dryRun 默认 true —— 预览不写库，也不落审计行）。
       三者的页面路由调的是同一个 builder，页面不内联重算。 */
    asinHistoryTool(deps),
    asinHealthTool(deps),
    productImportTool(deps),
    /* R-95：`listing.attributes_json` 在此之前**没有任何人工写入口** ——
       43 属性那道门只能靠优化轮次采纳草案，人在页面上没地方填。 */
    asinAttributeStatusTool(deps),
    asinAttributeSetTool(deps),
    asinImportTool(deps),
    // The grouping asin.product_line_id points at — a reader/filter with no
    // writer until this tool existed. See src/tools/product-line.js.
    productLineUpsertTool(deps),
    shopTool(deps),
    /* R-91 字段模板：读 / 保存 / 提案 / 确认 / 回滚 / 对照 —— 六件，都在 tools/field-template.js。 */
    fieldTemplateGetTool(deps),
    fieldTemplateSaveTool(deps),
    fieldTemplateProposeTool(deps),
    fieldTemplateConfirmTool(deps),
    fieldTemplateRollbackTool(deps),
    fieldTemplateDiffTool(deps),
  reviewIngestTool(deps),
    // 归类：只读，回答"这个 ASIN 该挂哪条线"；写入仍走 amzn_asin_upsert。
    productLineClassifyTool(deps),

    // Step 2 — collection
    collectSubmitTool(deps),
    collectStatusTool(deps),
    collectDoctorTool(deps),
    // 模块 04 第二子批 — 采集中心。十二个工具按 F04-01…F04-10 排序：
    // 体检（读）/ 修复（写）/ 预览（读）/ 发起（写：建任务行）/ 取消（写）/ 待人工处置（写）/
    // 13 节详情（读）/ 方案列表（读）/ 方案创建改版（写：追加一行版本）/ 方案流转（写状态）/
    // 计划列表（读）/ 计划保存（写）。`amzn_collect_submit` 保持不动 —— 它是最低层入口，
    // 既有断言钉着它，新的编排走 `amzn_collect_run`。
    collectEnvCheckTool(deps),
    collectRepairTool(deps),
    collectPreviewTool(deps),
    collectRunTool(deps),
    collectCancelTool(deps),
    collectWaitingResolveTool(deps),
    collectDetailTool(deps),
    collectSchemeListTool(deps),
    collectSchemeSaveTool(deps),
    collectSchemeTransitionTool(deps),
    collectPlanListTool(deps),
    collectPlanSaveTool(deps),

    // Step 3 — keyword master library, discovery and coverage
    keywordQueryTool(deps),
    keywordCoverageTool(deps),
    keywordImportTool(deps),
    keywordDiscoverTool(deps),
    keywordScanTool(deps),

    // Step 4 — optimization and reporting
    optimizePrepareTool(deps),
    // F13-02: the nine pre-flight gates, readable without starting a run. It sits
    // beside prepare because the page's 开跑这一轮 button and this tool have to return
    // the same nine answers — same `evaluatePrecheck`, so one rule, two doors.
    optimizePrecheckTool(deps),
    optimizeValidateTool(deps),
    optimizeSaveTool(deps),
    optimizeReportTool(deps),
    // B-13b / F13-01：草案收件箱的只读入口。它与工作台那一屏读同一个
    // `domain/optimize/inbox.js`，所以「页面说 3 条待人工选择、工具说 5 条」
    // 不可能发生 —— 不是两个实现互相保证，是只有一个实现。
    optimizeInboxTool(deps),
    // B-13b / F13-03：十类证据包的只读入口。永远返回十行，缺的那一类明说
    // 「不存在」还是「本仓没有」—— 省掉一行会让两者长得一模一样。
    optimizeEvidenceTool(deps),
    optimizeJobTool(deps),
    // B-13c / F13-05：九项策略卡的只读入口 + 「人工确认后进入生成」的门禁判据。
    // 与工作台「优化 → 策略阶段」读同一个 `domain/optimize/strategy.js#strategyGate`，
    // 所以「工具说放行、页面说未确认」不可能发生 —— 只有一个实现。确认本身是人的动作，
    // 落在页面上（POST optimize-strategy-confirm），这个工具只读。
    optimizeStrategyTool(deps),
    // B-13c / F13-06：位置计划核对的只读入口。它继承的是**模块 08 的持久计划**
    // （keyword_plan，唯一持久层），建议计划用 08 的八个位置，映射不到的逐条报出。
    // 采纳写回 08 新版本走的是 08 的 `savePlan`，与 amzn_keyword_plan_save 同一个函数。
    optimizePlanCheckTool(deps),
    // B-13d / F13-08：校验体系的统一入口（规则 / 闸门 / Agent 审阅三块，只读）。
    // 它与工作台那三块面板读的是同一个 `readValidationSystem`，所以
    // 「工具说闸门 4/6、面板说 5/6」不可能发生 —— 只有一个实现。
    optimizeValidationTool(deps),
    // B-13d / F13-08：Agent 审阅的读/记入口。记结论是**写**，所以它按写工具的规矩来：
    // 一条不合法就整批不写、每条结论必须引用能解开的证据、写完读回重算状态。
    optimizeReviewTool(deps),

    // Step 5 — the keyword master library (imported data, not browser scans)
    kwImportTool(deps),
    kwSourceTool(deps),
    kwMergeTool(deps),
    kwQueryTool(deps),
    kwExportTool(deps),
    kwReportTool(deps),
  /* 排名观测历史：与上面六个不同 —— 它们读导入的事实，这个读浏览器扫描的历史。 */
  kwRankHistoryTool(deps),
  /* 排班：写的是「什么时候自己跑」，不是数据本身。 */
  kwScanScheduleTool(deps),

    // Step 10 — the keyword pipeline (B05). The five stages that already
    // existed, run as one run and recorded; `pipeline.js` in the store is the
    // trace, `optimize-pipeline.js` in the domain is the orchestration.
    kwPipelineRunTool(deps),
    kwPipelineHistoryTool(deps),

    // Step 7 — the rule roster (B02). Importing the manual is B02c: it writes
    // only kind='doc' rows, never a judgement.
    ruleListTool(deps),
    ruleUpsertTool(deps),
    ruleActivateTool(deps),
    ruleDiffTool(deps),
    ruleImportTool(deps),

    // Step 8 — the policy library (B03). The upstream of the rule roster: a policy
    // is the input, a rule is the product. Import is paste / file only — no fetch.
    policyListTool(deps),
    policyImportTool(deps),
    policyLinkTool(deps),

    // Step 9 — the prompt library (B04). The page's buttons and the writing
    // strategy amzn_optimize_prepare hands the agent, both as editable data.
    promptListTool(deps),
    promptUpsertTool(deps),
    promptPreviewTool(deps),
    // B-11.2b — 保存即冻结的两半：读冻结正文，和把它写回去（新编辑，不是抹历史）。
    promptHistoryTool(deps),
    promptRollbackTool(deps),
    /* B-11.3 / F11-05 — 生命周期。四个：读、走一步、激活当前版、退回上一活动版本。
       ⚠️ `amzn_prompt_version_rollback` 与上面的 `amzn_prompt_rollback` 不是同一件事：
       上面那个换**正文**（编辑计数 +1），这个换**活动版本**（一个字都不写正文）。 */
    promptLifecycleTool(deps),
    promptLifecycleTransitionTool(deps),
    promptVersionActivateTool(deps),
    promptVersionRollbackTool(deps),
    // F11-09 — 反向查「这条提示词被哪些运行用过」。只读，纯反查，不落审计。
    promptReferencesTool(deps),
    /* F11-07 — 固定评估集。三个：导入、看目录、看一套的全部样例。
       ⚠️ **没有第四个**（没有「跑评估」）：本插件没有 LLM 通道，也没有评估器，
       一个 `_run` 只能产出编出来的通过率。将来真有评估器，它带来的是一张**结果表**。 */
    promptEvalImportTool(deps),
    promptEvalListTool(deps),
    promptEvalShowTool(deps),

    // Step 11 — competitor analysis and keyword research (B06). Both read; the
    // only writer is competitor_set_upsert, which writes a set of ASINs and
    // nothing else. Neither ever drives the browser unless research is asked to
    // collect suggestions, and even then it only reads the dropdown.
    competitorSetUpsertTool(deps),
    competitorAnalyzeTool(deps),
    /* B-06.1 — 四象限与证据。只读：分类与证据都由纯函数算，读的是已有事实。 */
    competitorQuadrantsTool(deps),
    keywordResearchTool(deps),

    // Step 12 — the report centre and the settings surface (B07). `amzn_report_list`
    // reads the registry one table wide, so it can see an optimization report and
    // a library CSV in the same answer; the two setting tools are split read/write
    // because reading is free and writing changes how the machine hits Amazon.
    reportListTool(deps),
    // `amzn_report_diff` sits beside the list rather than in the optimize group
    // (T4): the question it answers is about two runs at once, and the run panel's
    // own tools are all single-run.
    reportDiffTool(deps),
    /* F14-01 — 八类生成报告的**写入方**与报告自身的收藏/标签/归档。二者都是有描述符的
       写工具（`domain/audit/targets.js`），不是 null：它们真的往 `report` 表写。
       `amzn_report_build` 单独成一个工具而不是挂在 `amzn_dq_scan` 之类后面，理由写在
       `tools/report.js`：报告是一次**冻结的快照**，应该在有人要它的那一刻产生。 */
    reportBuildTool(deps),
    reportUpdateTool(deps),
    settingListTool(deps),
    settingSetTool(deps),

    // S1-B02 — the workspace lifecycle. The object every configuration row now
    // belongs to: before v20 there was no such thing, and "the settings" meant
    // "the settings", full stop.
    workspaceUpsertTool(deps),

    // S1-B06 — the home page's six health cards, from the same builder the page
    // uses. Read-only; a card that fails is reported as failed, not dropped.
    dashboardTool(deps),

    // S1-B09 — the quality cockpit's scan. Writing (it persists findings so a
    // status can be attached), and idempotent: the second run over an unchanged
    // store inserts nothing. The same `runQualityScan` the page calls.
    qualityScanTool(deps),

    // S1-B10 — the conflict workbench's decision. The design lists exactly two
    // tools for this area (scan / resolve); this is the second. Writing, and it
    // writes only `field_conflict` — adopting a value never deletes a source.
    conflictResolveTool(deps),

    // S1-B12 — the read half of the audit log. The log has exactly one writer
    // (the two funnels) and no delete; without a reader, "every write is
    // audited" is a claim about a table nobody can see. Read-only, and declared
    // `null` in WRITE_TARGETS.
    auditQueryTool(deps),

    // 模块 12 — Agent 编排。十一个工具：开运行（冻结上下文包）/ 逐步回报 / 收尾 /
    // 列表（只读）/ 存产物（只写 draft）/ 记门禁裁决 / **由人裁决草案** / 读 §14 指标 /
    // 角色配置的版本化（F12-02：发布一版 / 版本清单 / 某一版的完整内容）。
    // 这一版不接 LLM，交付的是留痕与门禁；分析与生成由 DSH Agent 在会话侧做（§13 的分工）。
    // `_decide` 是草案离开 draft 的唯一入口（§11 草案级控制），存产物那个工具做不到。
    // `_metrics` 只读：它把 §14 十项里算得出来的三项给数字（带分母），另外七项逐条写明
    // 缺哪份记录 —— 它不是「未实现」，是「缺记录」。
    agentRunStartTool(deps),
    agentRunStepTool(deps),
    agentRunFinishTool(deps),
    agentRunListTool(deps),
    // F12-09 — 中断恢复扫描：把僵死的 running 运行标成 blocked（原因类别 interrupted）。
    // ⚠️ **只标状态，绝不自动重跑**（本插件不驱动 Agent）。阈值由调用方给。
    agentRunRecoverTool(deps),
    agentArtifactSaveTool(deps),
    agentGateDecideTool(deps),
    agentArtifactDecideTool(deps),
    agentMetricsTool(deps),
    // F12-02 — 角色配置的版本化。发布是**追加**一版（`_release`，不是 `_publish`：那条
    // publish|apply|push|deploy 命名守卫）；两个只读工具看清单与某一版的完整内容。
    agentRoleConfigReleaseTool(deps),
    agentRoleConfigListTool(deps),
    agentRoleConfigShowTool(deps),
    // F12-03 — 补充数据请求。开一条**记录**（插件不补数据）/ 列 / 结清。
    agentDataRequestTool(deps),
    agentDataRequestListTool(deps),
    agentDataRequestResolveTool(deps),

    // 模块 14 §6/§7 — 发布记录与实验设计。这一批把「改完 listing 之后」接上：
    // 登记实际发布、把批准草案与实际发布逐字段比出差异、处置偏离、把变更声明成
    // 一个受控实验。
    publicationRecordTool(deps),
    publicationListTool(deps),
    publicationBaselineDecideTool(deps),
    observationPlanSaveTool(deps),

    // 模块 14 §8/§9 — 效果观测与回滚。§6 记下「发布了什么」之后，这一批回答
    // 「改了之后怎么样」以及「不行怎么撤」：到期节点物化、数据前置检查（数据不足
    // 就只能「无法判断」）、结论冻结读数、到期扫描（通知表**第一个真正的生产者**）、
    // 回滚交付包与闭环。仍然没有发布工具，也没有一键回滚 —— §9 的原话。
    observationListTool(deps),
    observationCheckTool(deps),
    observationConcludeTool(deps),
    observationScanDueTool(deps),
    rollbackSuggestTool(deps),
    rollbackListTool(deps),

    // 模块 08 F08-07 — 关键词九态生命周期。这一批把「这个词现在算不算在用」变成一条
    // 可流转、可追溯、不可删除的事实：状态独立于 kw_master（重建会抹掉它），每一次
    // 流转追加一行永不修改的历史。`assigned→used` 的「自动」实现为**显式声明的发布
    // 关联**（batch 工具）—— 库里没有「这次发布用了哪些词」的关联，猜不得。
    keywordLifecycleListTool(deps),
    keywordLifecycleHistoryTool(deps),
    keywordLifecycleSetTool(deps),
    keywordLifecycleBatchTool(deps),
    // F-5（走查 2026-10-25）：3 万条只支持单条操作走不通。批量是**一次人的决定**：
    // all-or-nothing、强制 by/reason、一次最多 500 词、可按筛选选（服务端解析并记进
    // 事件行），状态机校验与单条共用 store 里的 refusalFor —— 这个文件不判断任何边。
    keywordLifecycleBatchSetTool(deps),

    // v69 — 产品线**归属**（F-5 的 B 半）。生效值 = 人工 > 派生（派生值每次导入都会被
    // recompute 重写，所以人工归属只能住在自己的表里）。批量与生命周期批量共用同一套
    // 骨架（上限/坏项拒收/筛选词表/选区进事件行/dryRun），这里不另起一套。
    keywordProductLineGetTool(deps),
    keywordProductLineBatchSetTool(deps),

    // 模块 08 F08-04 — 关键词所有权工作台。五条：读工作台 / 读影响预览 / 批量分配·释放·
    // 锁定 / Agent 回写建议 / 人工裁决。主人与冲突是推导的（不存标志位），释放不删行，
    // 预览与执行共用一个函数（dryRun），批量影响活跃优化运行时要显式二次确认。批量工具
    // 叫 `_batch` 而不是 `_apply` —— 那条 publish|apply|push|deploy 命名守卫。
    keywordOwnershipListTool(deps),
    keywordOwnershipPreviewTool(deps),
    keywordOwnershipBatchTool(deps),
    keywordOwnershipSuggestTool(deps),
    keywordOwnershipResolveTool(deps),

    // 模块 08 F08-05 — 位置计划持久层。计划是**分配决定**（哪个词归哪个位置），与
    // for_listing_json 的**资格**（哪个词**允许**进哪个位置）是两件事，审计报告 §4.5
    // 点名的「两个数都是 14 就以为对齐了」正是把这两件事混起来。本模块是计划唯一的持久层
    // （§10），13 只引用与冻结。`_propose` 只读不写；`_save` 拒绝重复词（一词一主人在库
    // 层就是主键约束）与无理由的复现位（一位一用途 / supporting_reuse_requires_field_and_reason）。
    keywordPlanListTool(deps),
    keywordPlanGetTool(deps),
    keywordPlanProposeTool(deps),
    keywordPlanSaveTool(deps),
    keywordPlanCoverageTool(deps),

    // 模块 08 F08-08 — 关键词详情（只读）。七个 §8.2 项一次读全。只读，`WRITE_TARGETS`
    // 里显式登记为 null。缺失分两种说法（未测量 / 本系统没有这个字段），相关性归后者，
    // 且不得由 CVR、搜索量、层级或 embedding 推导伪相关性。
    keywordDetailTool(deps),
  ]
}

/**
 * Wrap one tool with the activity feed and, for the tools that write, the audit
 * log.
 *
 * ## Two things ride on this wrapper, and they are not the same thing
 *
 * The `workbench.record` calls are the live feed: in-memory, capped, replayed
 * to the browser, gone on restart. They are unchanged by S1-B12 and they must
 * stay that way — the feed answers "what is happening", and nothing about the
 * audit log makes that question different.
 *
 * The `recordAudit` call is the durable one, and it happens **only** for a tool
 * `WRITE_TARGETS` classifies as a write, **only** when the tool reported
 * success, and **only** when the descriptor's own `skip` does not apply (two
 * tools have a dry-run flag that genuinely writes nothing; recording a write
 * that did not happen is the one lie an audit log cannot afford).
 *
 * ## The before value, and what happens when reading it fails
 *
 * `readBefore` is called before `inner`. If it throws — a getter for a row that
 * is not there, an undeclared setting key — the write still proceeds: a failure
 * to read the old value is not a reason to refuse the new one, and the tool's
 * own validation is what decides whether the write is legal.
 *
 * What it must NOT do is write a row whose `before_json` is null with no
 * explanation, because that row says "there was no previous value" when the
 * truth is "we could not read one". Those are different facts and a reader
 * cannot tell them apart. So the failure is recorded in `reason`, which is the
 * column for exactly this kind of note. The row still exists: a write that
 * happened and left no trace is worse than a write whose before value is
 * missing but named as missing.
 *
 * ## Why an audit failure does not fail the tool
 *
 * `recordAudit` throwing is a bug in our own descriptor, never bad user input —
 * by the time it runs the write has already committed. Letting it propagate
 * would turn a successful write into `{ok:false}`, which misreports the store
 * to save the log. So it is caught, reported on the activity feed where it is
 * visible, and the tool's own answer is returned unchanged.
 */
function instrument(definition, deps) {
  const inner = definition.execute
  const workbench = deps.workbench
  const target = writeTargetFor(WRITE_TARGETS, definition.name)

  return {
    ...definition,
    async execute(args, ...rest) {
      const startedAt = Date.now()
      workbench.record('tool:start', { tool: definition.name, args: summarizeArgs(args) })

      /* The old value, read before the write. `note` carries the reason the
         audit row will give if this failed. */
      let before = null
      let beforeNote = null
      if (target !== undefined && target !== null) {
        try {
          before = target.readBefore(deps, args)
        } catch (error) {
          before = null
          beforeNote = `前值读取失败: ${error.message}（写仍然发生，前值未知）`
        }
      }

      try {
        const value = await inner(args, ...rest)
        workbench.record('tool:done', {
          tool: definition.name,
          ms: Date.now() - startedAt,
          ok: value?.ok !== false,
          summary: summarizeResult(definition.name, value),
        })
        if (target !== undefined && target !== null) {
          recordToolAudit({ deps, definition, target, args, value, before, beforeNote, workbench })
        }
        return value
      } catch (error) {
        workbench.record('tool:error', {
          tool: definition.name,
          ms: Date.now() - startedAt,
          ok: false,
          error: error.message,
        })
        return {
          ok: false,
          error: error.message,
          tool: definition.name,
          hint: 'The call failed. Check the arguments, or tell the user what is missing rather than retrying blindly.',
        }
      }
    },
  }
}

/** The audit half of the wrapper: decides whether this call gets a row. */
function recordToolAudit({ deps, definition, target, args, value, before, beforeNote, workbench }) {  /* A failed write is not audited. A tool reports failure by returning
     `{ok:false}` rather than by throwing, so both paths are checked here. */
  if (value?.ok === false) return
  /* A dry run writes nothing, so there is nothing to record. Named on the feed
     so the skip is visible rather than looking like a broken descriptor. */
  if (typeof target.skip === 'function' && target.skip(args) === true) {
    workbench.record('audit:skip', { tool: definition.name, reason: 'dryRun' })
    return
  }

  try {
    recordAudit(deps.store, {
      action: target.action,
      objectType: target.objectType,
      /* The result is handed over as well as the args: a creation names an
         object that did not exist before the call, so its id is only in what
         the call returned. See the note on `objectId` in domain/audit/targets.js. */
      objectId: target.objectId(args, value),
      before,
      after: readAfterValue({ deps, target, args, value }),
      impact: typeof target.impact === 'function' ? target.impact(args, value) : null,
      reason: composeReason(target, args, beforeNote),
      route: `tool:${definition.name}`,
      actorKind: 'agent',
    })
  } catch (error) {
    /* See the comment on `instrument`: the write already happened, so the tool's
       answer stands. The failure is loud on the feed instead. */
    workbench.record('audit:error', { tool: definition.name, error: error.message })
  }
}

/**
 * The new value of the object, read the same way the old one was.
 *
 * One rule, because the alternative is a per-target convention nobody can
 * check: **re-read the object with the same reader; if there is no object to
 * re-read, the call's own result is the after value.** A setting, an ASIN row
 * and a rule all come back as rows. A submitted collection task, a whole-store
 * scan and a keyword import have no single row — their after value is what the
 * call produced, which is the only description of what now exists.
 *
 * A reader that throws here is treated as "no object to re-read" rather than
 * failing the audit: the write has already happened, and the row's `after_json`
 * is not the place to report a read error.
 */
function readAfterValue({ deps, target, args, value }) {
  if (typeof target.readAfter === 'function') {
    try {
      const read = target.readAfter(deps, args, value)
      if (read !== undefined) return read
    } catch {
      /* fall through to the result */
    }
  } else if (typeof target.readBefore === 'function') {
    try {
      const read = target.readBefore(deps, args)
      if (read !== null && read !== undefined) return read
    } catch {
      /* fall through to the result */
    }
  }
  return value === undefined ? null : value
}

/**
 * Keep the activity feed small. A collection request can carry hundreds of
 * targets, and the feed is rendered in a browser panel, so only the shape of the
 * call is recorded, never its bulk.
 */
function summarizeArgs(args) {
  if (args === undefined || args === null || typeof args !== 'object') return {}
  const summary = {}
  for (const [key, value] of Object.entries(args)) {
    if (Array.isArray(value)) summary[key] = `${value.length} 项`
    else if (value !== null && typeof value === 'object') summary[key] = '{…}'
    else if (typeof value === 'string' && value.length > 60) summary[key] = `${value.slice(0, 57)}…`
    else summary[key] = value
  }
  return summary
}

/** One line for the feed: the first meaningful line of the tool's own answer. */
function summarizeResult(tool, value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return firstLine(value)
  if (typeof value === 'object') {
    if (value.ok === false) return `失败: ${value.error ?? ''}`
    const rendered = value.text ?? value.summary ?? value.message
    if (typeof rendered === 'string') return firstLine(rendered)
  }
  return ''
}

function firstLine(value) {
  const line = String(value).split('\n').find(candidate => candidate.trim() !== '') ?? ''
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

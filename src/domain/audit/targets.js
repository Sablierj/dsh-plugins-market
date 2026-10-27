/**
 * Which operations are writes, and what object each one writes.
 *
 * This is the only place that answers that question. The two funnels — the tool
 * wrapper in `src/tools/index.js` and (next batch) the page's write route
 * wrapper in `src/web/routes.js` — read these tables and nothing else, which is
 * what lets "every write is audited" be true without a single line changing in
 * the tool files or the route bodies.
 *
 * ## The one thing to understand before editing: `null` is an answer
 *
 * A target maps to either a descriptor or `null`, and `null` means **"this was
 * looked at and it is not a database write"** — not "nobody filled this in
 * yet". The two are indistinguishable in a diff, so the guard in
 * `tests/s1b12-audit.mjs` asserts that these tables cover *every* registered
 * tool and *every* POST route: adding a tool without deciding what it is makes
 * the suite red. That is the only way the decision gets made.
 *
 * `context` is the clearest example. It is a POST, it changes what the page
 * shows, and it writes nothing: the workbench context is in-memory UI state. A
 * funnel that audited it by route shape would fill the log with rows about
 * which tab was open.
 *
 * ## readBefore: why it lives here and not in the tool
 *
 * The before value has to be read *before* the write, and the obvious place to
 * put that read is inside the tool that does the writing. It is deliberately
 * not: a descriptor means the tool file does not change at all, and it means
 * the 27 write tools cannot each invent their own idea of what "before" is.
 *
 * `readBefore` may return `null`, and it does so for two different reasons,
 * which the comments below name individually:
 *
 *   1. **The object does not exist before the call.** A submitted collection
 *      task, a new optimization run, an import — there is no prior row, and
 *      `null` is the honest value. It is not "we did not look".
 *   2. **The write is a bulk operation with no single prior object.** A scan
 *      over the whole store, a merge of the keyword master — the "before" would
 *      have to be the whole table, and storing that would make the audit row
 *      bigger than the thing it describes.
 *
 * It may also throw (a getter for a row that is not there), and the funnel
 * tolerates that: a failed read of the old value must not fail the write. See
 * the comment in `instrument()` for what the funnel records in that case.
 *
 * ## The action string is shared, on purpose
 *
 * `ACTIONS` exists so that the tool and the page cannot name the same operation
 * two different ways. `amzn_setting_set` and the page's `setting-set` are the
 * same fact — "this setting is now this" — and assertion ⑥ of S1-B12 pins that
 * they produce one action. Two string literals would drift the first time
 * somebody renamed one of them.
 *
 * ## `objectId(args, result)`, and why the second argument exists
 *
 * An update names an object that already exists, so its id is in `args`. A
 * **create** names an object that did not exist a moment ago: the id was minted
 * by the call itself, and the only place it can be read from is what the call
 * returned. `objectId` therefore takes the result as well, and a creation
 * descriptor reads the generated id out of it.
 *
 * Most creation tools here return a rendered string, not a row, so there is
 * nothing to read and their `objectId` stays `null` — with a comment naming
 * why, because "the id is not in the result" and "nobody thought about it" look
 * identical in a diff. Where the tool does return a row (`workspace_upsert`
 * returns `{workspace}`), the id is filled in. The alternative — regexing the
 * id out of the tool's prose — would make the audit log depend on the wording
 * of a sentence, which is the coupling this whole table exists to avoid.
 */

import { DEFAULT_WORKSPACE_ID } from '../context/scope.js'
import { getConflict } from '../../store/conflict.js'
import { getCompetitorSet, getImport } from '../../store/kw.js'
import { listOwnership, ownershipView } from '../../store/ownership.js'
import { getPolicy } from '../../store/policy.js'
import { getCandidate } from '../../store/policy-candidate.js'
import { getPrompt, promptLifecycleView, getEvalSet } from '../../store/prompt.js'
import { getIssue } from '../../store/quality.js'
import { getAsin, getCollectionTask, getOptimizationRun, listOptimizationDrafts, listProductLines, listSources } from '../../store/queries.js'
import { getSchemeVersion, currentSchemeVersion } from '../../store/collection-scheme.js'
import { latestEnvChecks } from '../../store/collection-env.js'
import { getPlan as getCollectionPlan } from '../../store/collection-plan.js'
import { activeVersion, loadActiveRoster } from '../../store/rules.js'
import { getSetting } from '../../store/settings.js'
import { getBrand, getShop } from '../../store/shop.js'
import { getSiteProfile } from '../../store/site.js'
import { getSnapshot } from '../../store/snapshot.js'
import { getArtifact as getAgentArtifact, getRun as getAgentRun } from '../../store/agent.js'
import { latestRoleConfig } from '../../store/agent-config.js'
import { getDataRequest, listDataRequests } from '../../store/agent-request.js'
import { activeObservationPlan, getCheckpoint, getPublication } from '../../store/observe.js'
/* 模块 08 F08-07：生命周期的前值就是这条词的当前状态。读 store 自己的 reader，不在
   这里写第二份查询 —— 与其它描述符同一条规则。 */
import { getKeywordLifecycle } from '../../store/keyword-lifecycle.js'
/* 模块 08 F08-04：所有权的前值就是这条词的工作台行（主张 + 建议）。同样读 store 自己
   的 reader —— 尤其是建议那一侧，`readBefore` 要能回答「改之前建议的是什么」。 */
import { getKeywordOwnership, getOwnershipSuggestion } from '../../store/keyword-ownership.js'
/* 模块 08 F08-05：位置计划的前值就是这一版计划本身。读 store 自己的 reader。 */
import { getPlan as readKeywordPlan } from '../../store/keyword-plan.js'
/* B-13c：两条新页面写动作的前值读取口。读的是**领域模块自己的** SELECT（与工具、
   页面用的是同一个函数），不在描述符里写第二份查询 —— 这正是 s1b12 那条守卫盯的
   「一个对象两个读法」。 */
import { readStrategyRow } from '../optimize/strategy.js'
import { readPlanCheckRow } from '../optimize/position-plan.js'
/* B-13d / F13-08：审阅结论行的读取口 —— 与工具、页面、读回对账用的是同一个 SELECT。 */
import { readReviewRow } from '../optimize/review.js'
import { getWorkspace } from '../../store/workspace.js'
/* 模块 05 F05-01：保存视图的前值就是**同名的那一个视图**（存之前的样子 / 删掉的那一行）。
   读 store 自己的 reader —— 与其它描述符同一条规则，不在描述符里写第二份查询。 */
import { listAsinSavedViews } from '../../store/asin-view.js'
/* 模块 05 第一子批：字段级人工修正 / 变体关系 / 归档。前值都读 store 自己的 reader ——
   与其它描述符同一条规则，不在描述符里写第二份查询。 */
import { listFieldSources } from '../../store/field-source.js'
import { getVariantRelation } from '../../store/variant.js'
/* F14-01 — 报告库的读回。`amzn_report_update` 改的是已有的一行（收藏/标签/归档），
   所以它的前值就是这个函数读出来的那一行；`amzn_report_build` 的「前值」会是整张
   `report` 表（同日同范围可能已有旧快照），与 `amzn_dq_scan` 同一条理由，登记 null。 */
import { getReport } from '../../store/reports.js'

/**
 * Actions two planes share. A tool and its page route are the same operation,
 * so they are the same string — defined once, used twice.
 */
/** R-91：模板写动作的 before —— 当前生效版本号与字段数。 */
const readFieldTemplate = deps => {
  const active = getTemplateVersion(deps.store, { status: 'active' })
  return active === null
    ? null
    : { version: active.version, status: active.status, fields: active.items.length }
}

export const ACTIONS = {
  settingSet: 'setting.set',
  /* FR-M2-05（B 方案）—— **一次机器写入覆盖了人工来源的值**。
     与 `asin.upsert` 分开，不是因为它写的是另一张表（都是 `asin`），而是因为它们
     回答两个不同的问题：`asin.upsert` 说「有人把这批字段导进来了」，
     这一条说「它顺手改掉了运营改过的那一格」。
     合成一条的后果是：审计能告诉你「那天有人 upsert 过」，但不能回答
     「谁把我改的产品线换回去了」—— 而那正是这一条存在的唯一理由。
     写入点在 `store/queries.js` 的 `upsertAsin`（覆盖前比对人工来源）。 */
  asinManualOverridden: 'asin.field.manual-overridden',
  /* FR-M2-05 —— 归属判断（自有/竞品、产品线）的写入。与 `keyword_ownership.*` 同族：
     一个是「这个词归谁」，一个是「这条 ASIN 归谁」。页面路由与工具共用这一个动作名，
     因为「页面点一次」与「会话调一次」在审计里必须是同一条。

     名字是 `asin_ownership.set` 而不是 `asin.ownership.set`：审计动作的格式是
     **`<object_type>.<verb>`，只许一个点**（s1b12-audit 有一条正则守它），而这一条的
     objectType 就是 `asin_ownership`。三段式写起来像「更细的分类」，实际会让
     「按前缀分组」这件事失效 —— 读者按 `asin.` 前缀捞，会漏掉所有归属写入。 */
  asinOwnershipSet: 'asin_ownership.set',
  productLineUpdate: 'product_line.update',
  sourceSave: 'source.save',
  workspaceUpdate: 'workspace.update',
  promptSave: 'prompt.save',
  /* T70 —— 评论分析 run 是一次业务写（run 行 + 标注行落库），审计记「谁跑了哪一版
     词典法、样本多大」——方法版本是 run 的字段，审计是第二个可查点。 */
  reviewAnalysisRun: 'review_analysis.run',
  /* B-11.2b — 回滚与保存是两件不同的事：保存是「这条现在长这样」，回滚是「这条回到
     了它曾经长的那样子」。合成一条 `prompt.save` 会让审计回答不了「这次是改写还是
     回退」，而这个区别正是要查的。页面那条写路由与 `amzn_prompt_rollback` 共用它。 */
  promptRollback: 'prompt.rollback',
  /* B-11.3 / F11-05 — 生命周期是**三个**动作，不是一个 `prompt.lifecycle.write`：
     走一步（review / testing / deprecated…）、把某一版放进生产、把生产退回上一活动
     版本，是「谁在什么时候把生产用的那一版换掉了」的三个不同答案。合成一条会让审计
     回答不了「这次是评审推进，还是换掉了生效版本」。 */
  promptLifecycle: 'prompt.lifecycle',
  promptActivate: 'prompt.activate',
  promptVersionRollback: 'prompt.version_rollback',
  /* F11-07 — 导入一套固定评估集。与 `prompt.save` 分开：一个是「提示词的正文现在长
     这样」，一个是「这一套样例现在是这样」。合成一条会让审计回答不了「谁把评估集的
     内容换掉了」—— 而重导入是**整份替换**，正是最该留痕的那种写。 */
  promptEvalImport: 'prompt.eval_import',
  competitorSetSave: 'competitor_set.save',
  ruleToggle: 'rule.toggle',
  policyLink: 'policy.link',
  /* S2-T72：一次检索写 run + 候选（两个表），一次确认写 policy + 挂规则 + 候选决定，
     一次驳回写候选决定。三件事分开记，审计要回答的是「谁按了检索 / 谁确认了哪条 /
     谁驳回了哪条」。objectType 统一用已有的 `policy` 词汇（候选与 run 都是政策
     输入链上的对象）；具体对象 id 由 objectId 区分。 */
  policyCheckStart: 'policy.check',
  policyCandidateConfirm: 'policy.candidate_confirm',
  policyCandidateReject: 'policy.candidate_reject',
  kwSourceToggle: 'kw_import.toggle',
  dqIssueStatus: 'dq_issue.status',
  conflictResolve: 'field_conflict.resolve',
  /* S1-B19. Delete and restore are the same flag on the snapshot row, but they
     are two different facts, so they are two actions rather than one. Both are
     named here rather than inlined at the route for the same reason as the rest
     of the table: one string, and the tool that joins the page later reads it
     rather than retyping it. */
  snapshotDelete: 'snapshot.delete',
  snapshotRestore: 'snapshot.restore',
  /* 模块 12 — Agent 编排。六条写动作分开而不是合成一条 `agent.write`：一次运行
     的开始、每一步、收尾、产物、门禁裁决、中断恢复扫描是六件不同的事，审计要回答的是
     「谁在什么时候把这次运行推到了下一步」。 */
  agentRunStart: 'agent_run.start',
  agentRunStep: 'agent_run.step',
  agentRunFinish: 'agent_run.finish',
  /* F12-09 — 中断恢复扫描。与 `agent_run_finish` **分开**：收尾是「有人把**这一条**运行
     推到了某个状态」，恢复扫描是「有人扫了**一遍**僵死的运行、把其中 N 条标成 blocked」。
     合成一条之后，审计里就分不出「是谁把这条推走的」与「是一次扫描顺手推走的」。 */
  agentRunRecover: 'agent_run.recover',
  agentArtifactSave: 'agent_artifact.save',
  agentGateDecide: 'agent_gate.decide',
  /* B-12.1 — 草案级人工裁决（§11 接受 / 驳回）。与 `agent_artifact_save` 分开而不是
     合成一条 `agent_artifact.write`：保存是「Agent 产出了一版草案」，裁决是「它被定成
     了 accepted / rejected」。审计要回答的是「**哪一版**在什么时候被推到了哪个状态」。
     注意署名口径：本阶段没有用户表，`by` 是**自报标签、不是认证身份**，页面那条路径
     记的执行者是 `page` —— 所以这一行能回答「什么时候、从什么到什么」，但**不能**回答
     「是哪个自然人」。页面那条写路由与 `amzn_agent_artifact_decide` 共用它。 */
  agentArtifactDecide: 'agent_artifact.decide',
  /* F12-02 — 发布一版角色配置。与上面五条分开：它改的不是某一次运行，而是**角色这个声明
     本身**（工具范围 / 允许数据 / 失败策略 / 步骤上限），影响的是**之后**开的运行。
     审计要能回答「谁在什么时候把某个角色换成了哪一版」，所以是一条独立动作。
     ⚠️ 动词用 `release` 不用 `publish`：工作台有一条守卫拒绝以 `.publish` 结尾的动作
     （§15 的发布边界）—— 这里发布的是本地库里的角色配置，不是 listing。 */
  agentRoleConfigRelease: 'agent_role_config.release',
  /* F12-03 — 补充数据请求的两条写动作。开与结分开：审计要回答的是「谁在什么时候说缺什么」
     与「谁在什么时候把它结掉、结成了什么」，合成一条这两问都答不了。
     ⚠️ 这里**没有**「补数据」这个动作 —— 本插件不驱动 Agent、不去补数据（§3），
     所以审计里只有「记一条请求」与「结一条请求」。 */
  agentDataRequestOpen: 'agent_data_request.open',
  agentDataRequestResolve: 'agent_data_request.resolve',
  /* 模块 14 §6/§7 — 三条写动作，分开而不是合成一条 `publication.write`：登记一次
     发布、处置一次偏离、声明一份观测计划是三件不同的事，而审计要回答的是「谁在
     什么时候把这条发布推到了下一步」。**没有「发布」这个动作** —— 本插件不发布
     （§15 的发布边界），所以「发布」在审计里不存在，只有「登记发布」。 */
  publicationRecord: 'publication_record.create',
  publicationBaselineDecide: 'publication_record.baseline_decide',
  observationPlanSave: 'observation_plan.save',
  /* 模块 14 §8/§9 — 四条写动作。同样不合成一条 `observation.write`：物化节点、下
     结论、扫到期、生成回滚包是四件不同的事，而审计要回答的是「谁在什么时候把这次
     观测推到了下一步」。**没有「回滚」这个动作** —— §9 的原话是系统不提供一键回滚，
     所以这里只有「生成回滚交付包」，真正的回滚在审计里表现为一条 `publication_record.create`
     （kind=rollback）。 */
  observationMaterialise: 'observation.materialise',
  observationConclude: 'observation.conclude',
  observationScanDue: 'observation.scan_due',
  rollbackSuggest: 'rollback.suggest',
  /* B-13b / F13-01 — 草案的四个状态动作，**分开而不是合成一条
     `optimization_draft.state`**：作废与恢复是同一个列的两个方向，但它们是两件不同的
     事实（「这份草案不做了」与「它又回到桌上了」），押后与取消押后同理。合成一条会让
     审计回答不了「这次是作废还是恢复」—— 而那正是要查的。这与 snapshot.delete /
     snapshot.restore、prompt.rollback / prompt.save 是同一条口径。
     **没有「继续审阅」这个动作**：它只改页面的筛选袋（内存），不落库，因此不是写。
     `optimizeRunReoptimize` 与这四个分开：它建的是**一轮新运行**，不是改草案状态。 */
  optimizeDraftVoid: 'optimization_draft.void',
  optimizeDraftRestore: 'optimization_draft.restore',
  optimizeDraftDefer: 'optimization_draft.defer',
  optimizeDraftResume: 'optimization_draft.resume',
  optimizeRunReoptimize: 'optimization_run.reoptimize',
  /* F-7 第一块 — 「开跑」有了页面入口。**页面与工具是同一条动作名**：同一次「建一轮
     优化运行」，从页面上点按钮和从对话里调 `amzn_optimize_prepare` 是同一个事实，
     审计里必须是同一个字符串（这正是 `ACTIONS` 存在的理由，见文件头「The action
     string is shared, on purpose」）。两个字符串字面量会在第一次改名时分叉。 */
  optimizePrepare: 'optimization_run.create',
  /* B-13c / F13-05 · F13-06 — 两条写动作，**分开而不是合成一条 `optimize.stage`**：
     「确认这一轮的九项策略」与「裁决这一轮的建议位置计划」是两件不同的事，审计要回答
     的是「谁在什么时候让文案进了这一轮、谁在什么时候让计划变成了新的一版」。
     合成一条会让这两个问题都答不出来 —— 与 optimizeDraftVoid / optimizeDraftRestore
     同一条口径。
     `optimization_plan.decide` 的采纳分支**会**在模块 08 里追加一版计划，但审计里
     记的是「谁裁决了核对」，不是「谁存了一版计划」—— 后者由 08 自己的
     `keyword_plan.save` 记（`savePlan` 是同一个函数，页面那条路由也落在它上面）。
     两条动作都只有页面写路由，没有工具写入口：确认策略是人的动作。 */
  optimizeStrategyConfirm: 'optimization_strategy.confirm',
  optimizePlanDecide: 'optimization_plan.decide',
  /* B-13d / F13-08 — Agent 审阅的结论写入。与前两条分开的理由是它们是**不同的东西**：
     前两条改的是「这一轮能不能进生成」与「位置计划是哪一版」，这一条写的是
     「14 项审阅里某一项、某个字段的结论是什么」。合成一条 `optimize.review` 还不行 ——
     一次调用可以记多条，而每条都有自己的 item / field / conclusion，审计里一行记不下。
     记进 `reason`：这一条写的是哪一项、哪个字段、什么结论（读者不该靠比对前后值去猜）。 */
  optimizeReviewRecord: 'optimization_review.record',
  /* W1-7 — the four writes the background worker makes, and the reason they are
     named here rather than typed at each call site: `asin.upsert` and
     `kw_import.create` are the **same fact** whether a tool or the worker caused
     them (an ASIN row was written; an import row exists), so one string is what
     keeps the two planes from drifting into two vocabularies a reader has to
     map. `listing.snapshot` and `kw_master.recompute` have no tool counterpart:
     nothing a person or an agent calls writes a page snapshot or rebuilds the
     derived layer — only the worker does. */
  asinUpsert: 'asin.upsert',
  listingSnapshot: 'listing.snapshot',
  kwImportCreate: 'kw_import.create',
  kwMasterRecompute: 'kw_master.recompute',
  /* 模块 08 F08-07 — 三条写动作。**分开而不是合成一条 `keyword_lifecycle.write`**：
     人手动把一条词推到下一个状态、一次人的批量决定、与「这次发布用了这几个词」的显式
     声明，是三件不同的事，审计要回答的是「谁在什么时候把它推到了哪一步、凭什么」。
     页面那条写路由与 `amzn_keyword_lifecycle_set` 共用 `keywordLifecycleSet` —— 页面点
     一次和会话调一次，在审计里必须是同一条。批量同理共用 `keywordLifecycleBatchSet`：
     一次动最多 500 行的决定，必须能整条读回来。 */
  keywordLifecycleSet: 'keyword_lifecycle.set',
  keywordLifecycleBatch: 'keyword_lifecycle.batch',
  keywordLifecycleBatchSet: 'keyword_lifecycle.batch_set',
  /* v69 — 产品线归属（F-5 的 B 半）。**一条写**：批量裁决归属（含撤销）。
     与生命周期那三条分开，因为回答的是另一个问题：「这个词属于哪条线、谁定的」。
     页面那条写路由与 `amzn_keyword_product_line_batch_set` 共用这一个 action ——
     页面点一次和会话调一次，在审计里必须是同一条。读工具显式登记为 null。 */
  keywordProductLineBatchSet: 'keyword_product_line.batch_set',
  /* 模块 08 F08-04 — 三条写动作。**分开而不是合成一条 `keyword_ownership.write`**：
     一次批量裁决（分配 / 释放 / 锁定）、一次 Agent 建议回写、一次人工采纳，是三件不同
     的事，审计要回答的是「谁在什么时候把这个词的主人定成了谁、凭什么」。页面那条写路由
     与 `amzn_keyword_ownership_batch` 共用 `keywordOwnershipBatch`；采纳路由与
     `amzn_keyword_ownership_resolve` 共用 `keywordOwnershipResolve` —— 页面点一次和会话
     调一次，在审计里必须是同一条。 */
  keywordOwnershipBatch: 'keyword_ownership.batch',
  keywordOwnershipSuggest: 'keyword_ownership.suggest',
  keywordOwnershipResolve: 'keyword_ownership.resolve',
  /* 模块 08 F08-05 — 一条写动作（存一版位置计划）。**没有 `keyword_plan.propose`**：
     提案不写库，它的 WRITE_TARGETS 是 null。页面那条写路由与 `amzn_keyword_plan_save`
     共用 `keywordPlanSave` —— 页面点一次和会话调一次，在审计里必须是同一条。 */
  keywordPlanSave: 'keyword_plan.save',
  /* 模块 04 第二子批 — 采集中心的六条写动作。**分开而不是合成一条 `collection.write`**：
     发起一次采集、取消一次、处置一次待人工、修一次环境、存一版方案、流转一次方案状态、
     存一条计划，是七件不同的事，审计要回答的是「谁在什么时候把这次采集推到了哪一步」。
     `amzn_collect_submit` 用的是既有的 `'collection_task.submit'` 字面量（不动它，既有
     断言钉着它）；`amzn_collect_run` 与页面那条 `collect-run` 共用下面这一条。 */
  collectionRun: 'collection_task.submit',
  collectionCancel: 'collection_task.cancel',
  collectionWaiting: 'collection_task.waiting',
  collectionEnvCheck: 'collection_env_check.run',
  collectionSchemeSave: 'collection_scheme.save',
  collectionSchemeTransition: 'collection_scheme.transition',
  collectionPlanSave: 'collection_plan.save',
  /* 模块 05 第一子批 — 四条写动作。**分开而不是合成一条 `asin.write`**：人工改一个字段
     的值、记一条父子关系、判定一条关系是错的、把一个 ASIN 归档，是四件不同的事，
     而审计要回答的正是「谁在什么时候把这条 ASIN 的哪一部分改成了什么」。
     `asin.archive` 同时服务归档与恢复两个方向 —— 与工作空间生命周期同一个约定
     （`workspace.update` 也是五个边共用一个 action）：方向写在 before/after 里，
     而多一个字符串只会多一处要同步的东西。 */
  asinFieldCorrect: 'asin.field_correct',
  /* R-95 —— 属性是**事实**，人工补进来和采集补进来不是一回事：
     `asin.attribute_set` 说的是「有人声称这些属性值为真」，追问方式与 field_correct 相同但对象不同
     （一次补一批，不是一格）。 */
  asinAttributeSet: 'asin.attribute_set',
  asinArchive: 'asin.archive',
  /* B-05e / F05-08 —— 受限删除**不与归档共用一条 action**，哪怕它们共用同一个工具名
     （`amzn_asin_archive` 的 `action` 入参）。理由是本仓反复用的那一条：归档可恢复、
     删除不可恢复，而审计要回答的正是「这是一次能撤回的动作，还是一次不能的」。
     合成 `asin.archive` 会让日志里一次删除长得像一次归档，而这两件事的追问方式完全不同
     （「把它放回来」vs「它原来是什么、谁批的」）。 */
  asinDelete: 'asin.delete',
  asinVariantUpsert: 'asin_variant.upsert',
  asinVariantCorrect: 'asin_variant.correct',
  /* 模块 05 F05-01 —— 保存视图的两条写动作。**不是一条 `asin_saved_view.write`**：
     存一个视图与删一个视图，读日志的人要问的问题不同（「这个视图是谁建的、当时的
     筛选是什么」vs「谁把这个视图删了」），而 before/after 的差异不足以分开它们 ——
     删除的 after 是空，覆盖的 after 是一组新筛选，两者在日志里长得不一样，但
     「这是删除」这件事不该靠读者比对 JSON 才看得出来。 */
  asinViewSave: 'asin_saved_view.save',
  asinViewDelete: 'asin_saved_view.delete',
  /* B-05c / F05-05 — 一次批量导入。**与 `asin.upsert` 分开**：写一条 ASIN 与「有人拿一份
     文件批量改了 N 条」是不同的两件事，审计要回答的是「谁在什么时候、用哪份文件、覆盖了
     哪些字段」。多一个字符串比多一处歧义便宜。
     这里**没有** `asin.import_preview` 之类的动作：预览不写库，它的描述符是 `skip`，
     一次预览一行审计都不落（`skip` 的判据见下面 `amzn_asin_import` 那一条）。 */
  asinImport: 'asin_import.apply',
  /* F14-01 — 报告库的两个写动作。**两个而不是一个**：「生成一份正文」与「把这一行
     加星/打标签/归档」是两件事，审计要回答的是「谁在什么时候产出了这份文档」与
     「谁把它挪进了归档」。两者共用同一个 objectType（`report`），所以查一条报告的
     完整历史仍然是一次按 (objectType, objectId) 的查询。 */
  reportBuild: 'report.build',
  reportUpdate: 'report.update',
  /* R-91 —— 字段模板的四个写动作。**四个而不是一个**：人手改一版、AI 出提案、人工确认、
     回滚，是四件不同的事，而审计要回答的正是「这一版是谁弄出来的」。
     它们共用 `objectType: 'field_template'`，所以查一个模板的完整历史仍是一次查询。 */
  fieldTemplateSave: 'field_template.save',
  fieldTemplatePropose: 'field_template.propose',
  fieldTemplateConfirm: 'field_template.confirm',
  fieldTemplateRollback: 'field_template.rollback',
}

/** The first row of a list whose predicate matches, or null. */
function first(rows, predicate) {
  return rows.find(predicate) ?? null
}

/* ── the readers ──────────────────────────────────────────────────────────────
   Each is the store's own reader, called the way its own writer's callers call
   it. None of them writes, and none of them is a second query written here:
   `readBefore` reads through the store's API so that a row's shape is defined
   in exactly one place. */

const readSource = (store, id) => first(listSources(store), row => row.id === String(id ?? ''))
const readProductLine = (store, id) => first(listProductLines(store, { limit: 500 }).rows, row => row.id === String(id ?? ''))
/* 一个保存视图的前值。按**名字**找 —— 视图的主键是 (workspace_id, name)，
   而 name 是用户认得出的那一半（描述符的 objectId 也只写名字）。 */
const readAsinSavedView = (store, name) => first(
  listAsinSavedViews(store, {}),
  row => row.name === String(name ?? '').trim(),
)

/* B-13b / F13-01：一份草案的前值。读 `listOptimizationDrafts`（optimization_draft 的
   唯一读取口），不在描述符里写第二份 SELECT —— 与其它描述符同一条规则。
   `(run_id, field)` 是这张表的唯一键，所以两个参数都要。 */
const readOptimizationDraft = (store, runId, field) => first(
  listOptimizationDrafts(store, runId),
  row => row.field === String(field ?? '').trim(),
)

/* 模块 05：字段级人工修正的前值 —— 这个字段**现在**的采用值 + 它的全部来源行。
   两份都要：只有采用值看不到「这次修正会不会盖掉一条采集读数」，而来源行正是那句
   需求（人工修正不改原始值）在审计里唯一能被复查的证据。 */
const readAsinField = (store, asin, marketplace, field) => {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? 'US').trim().toUpperCase()
  const name = String(field ?? '').trim()
  const found = getAsin(store, key, market)
  if (found === undefined) return null
  return {
    adoptedValue: Object.prototype.hasOwnProperty.call(found.row, name) ? (found.row[name] ?? null) : null,
    sources: listFieldSources(store, { asin: key, marketplace: market, field: name }),
  }
}

/** 变体关系的坐标，也是审计里那句「说的是哪一条边」的答案。 */
const variantKey = a => `${String(a?.parentAsin ?? '').trim().toUpperCase()}->${String(a?.childAsin ?? '').trim().toUpperCase()}@${String(a?.marketplace ?? 'US').trim().toUpperCase()}`

const readVariant = (deps, a) => getVariantRelation(deps.store, {
  marketplace: a?.marketplace ?? 'US',
  parentAsin: a?.parentAsin,
  childAsin: a?.childAsin,
})

/* 模块 12：运行的前值。只取要记的那几列，不是整包 —— 一次运行的 steps/artifacts
   可能很多，把它们塞进每一行审计会让日志变成一份运行副本。 */
const readAgentRun = (store, id) => {
  const run = getAgentRun(store, String(id ?? '').trim())
  if (run === null) return null
  return { id: run.id, role: run.role, status: run.status, stepCount: run.steps.length, artifactCount: run.artifacts.length }
}

/* 模块 12 F12-02：发布一版角色配置之后，记「换成了哪一版、换了什么」。只取说明这件事的
   字段，不把整份声明塞进审计行（与 readAgentRun / readAgentArtifact 同一条判断）。
   读的是**刚成为当前版本**的那一行（`readAfter` 在写之后调用），所以 version 就是新版本。 */
const readAgentRoleConfig = (store, role) => {
  const row = latestRoleConfig(store, String(role ?? '').trim())
  if (row === null) return null
  return {
    id: row.id,
    role: row.role,
    version: row.version,
    tools: row.config.tools,
    reads: row.config.reads,
    onFailure: row.config.onFailure,
    maxSteps: row.config.maxSteps,
  }
}

/* 模块 12：产物裁决的前值。只取要记的那几列 —— `body_json` 可能很大，把它塞进审计行
   会让日志变成产物副本，而这一行要回答的是「它原来是什么状态、被推到了哪个状态」。
   读 store 自己的 `getArtifact`（对不存在的 id 返回 null），不在这里写第二份查询。 */
const readAgentArtifact = (store, id) => {
  const artifact = getAgentArtifact(store, String(id ?? '').trim())
  if (artifact === null) return null
  return {
    id: artifact.id,
    type: artifact.type,
    objectType: artifact.objectType,
    objectId: artifact.objectId,
    version: artifact.version,
    status: artifact.status,
  }
}

/**
 * A publication record, trimmed to the facts an audit row should carry.
 *
 * The whole `published` object would put a listing's worth of copy into the log
 * for every registration, and the log is read to answer "who changed the state
 * of this thing" — so what is kept is the *state* (which kind, which run and
 * draft version, whether it deviated, how it was handled), not the prose.
 */
const readPublication = (store, id) => {
  const record = getPublication(store, String(id ?? '').trim())
  if (record === null) return null
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
    fieldCount: Object.keys(record.published ?? {}).length,
    observationStartAt: record.observationStartAt,
    /* §9 的终止事实是**发布记录**的性质，所以它属于这条读取 —— 少了它，审计里
       「这次观测什么时候被回滚终止的」就无处可查。 */
    observationTerminatedAt: record.observationTerminatedAt,
  }
}

/* 模块 14 §8：结论之前的节点状态。只取要记的几列：`metrics_json` 是一屏读数，
   把它塞进每一行审计会让日志变成观测卡片副本。 */
const readCheckpoint = (store, id) => {
  const checkpoint = getCheckpoint(store, String(id ?? '').trim())
  if (checkpoint === null) return null
  return {
    id: checkpoint.id,
    publicationId: checkpoint.publicationId,
    day: checkpoint.day,
    dueAt: checkpoint.dueAt,
    status: checkpoint.status,
    materialised: checkpoint.materialised,
    conclusion: checkpoint.conclusion,
    availableConclusions: checkpoint.availableConclusions,
  }
}

/** The active plan for a publication — the one a new plan replaces in effect. */
const readActivePlan = (store, publicationId) => {
  const plan = activeObservationPlan(store, publicationId)
  if (plan === null) return null
  return {
    id: plan.id,
    publicationId: plan.publicationId,
    status: plan.status,
    changed: plan.changed.length,
    unchanged: plan.unchanged.length,
    windowDays: plan.windowDays,
    rebuild: plan.rebuild,
  }
}

/**
 * 一条关键词的生命周期前值，只取要记的那几列。
 *
 * 没有记录时返回 `null` —— 那是**「没人决定过」**，是这条读取的诚实答案，而不是
 * 「没查」。所以它读 store 自己的 `getKeywordLifecycle`（它对无记录就返回 null），
 * 不在这里把 null 归一成 `candidate`：那会把「未设置」写进审计，读的人再也分不出
 * 「没人决定」和「决定为候选」。
 */
const readKeywordLifecycle = (store, keyword, marketplace) => {
  if (keyword === undefined || keyword === null || String(keyword).trim() === '') return null
  if (marketplace === undefined || marketplace === null || String(marketplace).trim() === '') return null
  const row = getKeywordLifecycle(store, { keyword, marketplace })
  if (row === null) return null
  return {
    keyword: row.keyword,
    marketplace: row.marketplace,
    status: row.status,
    source: row.source,
    changed_at: row.changed_at,
  }
}

const readRule = (store, ruleId) => first(loadActiveRoster(store)?.rules ?? [], row => row.ruleId === String(ruleId ?? ''))
const readActiveVersion = (store) => {
  const version = activeVersion(store)
  return version === null ? null : { version }
}

/**
 * 一条关键词的所有权前值，只取要记的几列。
 *
 * 没有主张也没有建议时返回 `null` —— 那是**「没人认领过」**，是这条读取的诚实答案，不是
 * 「没查」。读 store 自己的 `getKeywordOwnership`（它对两者皆无就返回 null），不在这里
 * 把它归一成一个「无主人」的形状：那会让审计读不出「此前无人认领」与「此前认领过又被
 * 释放」的区别。
 */
const readKeywordOwnership = (store, keyword, marketplace) => {
  if (keyword === undefined || keyword === null || String(keyword).trim() === '') return null
  if (marketplace === undefined || marketplace === null || String(marketplace).trim() === '') return null
  const row = getKeywordOwnership(store, { keyword, marketplace })
  if (row === null) return null
  return {
    keyword: row.keyword,
    marketplace: row.marketplace,
    owner: row.owner,
    claimCount: row.claimCount,
    conflicted: row.conflicted,
    conflictReasons: row.conflictReasons,
    candidates: row.candidates,
  }
}

/** 一条 Agent 建议的前值。没有建议时是 `null`，不是空对象。 */
const readOwnershipSuggestion = (store, keyword, marketplace) => {
  if (keyword === undefined || keyword === null || String(keyword).trim() === '') return null
  if (marketplace === undefined || marketplace === null || String(marketplace).trim() === '') return null
  const row = getOwnershipSuggestion(store, { keyword, marketplace })
  if (row === null) return null
  return {
    keyword: row.keyword,
    marketplace: row.marketplace,
    suggestedAsin: row.suggestedAsin,
    adoptedAt: row.adoptedAt,
    adoptedAsin: row.adoptedAsin,
    suggestedAt: row.suggestedAt,
  }
}

const readSiteProfile = (store, workspaceId, marketplace) => getSiteProfile(
  store,
  String(workspaceId ?? '').trim() || DEFAULT_WORKSPACE_ID,
  String(marketplace ?? '').trim(),
)
const readOwnership = (store, asin, marketplace) => ownershipView(store, {
  asin: String(asin ?? '').trim().toUpperCase(),
  marketplace: String(marketplace ?? '').trim().toUpperCase(),
})

/* ── 模块 04 第二子批的前值读取 ──────────────────────────────────────────────
   全都读 store 自己的 reader，不在这里写第二份查询（与上面所有读取同一条规则）。 */

/** 一个采集任务行，或 null。取消与待人工处置的前值都是「它当时长什么样」。 */
const readCollectionTask = (store, taskId) => {
  const id = taskId === undefined || taskId === null ? '' : String(taskId).trim()
  if (id === '') return null
  return getCollectionTask(store, id) ?? null
}

/**
 * 一版采集方案。没有版本号时读**最新版** —— 那正是「改草稿」这条路径要动的行；
 * 有版本号时读那一版（流转动作的前值）。`null` 是「这一版还不存在」，不是「没查」。
 */
const readCollectionScheme = (store, id, version) => {
  const schemeId = id === undefined || id === null ? '' : String(id).trim()
  if (schemeId === '') return null
  if (version === undefined || version === null) return currentSchemeVersion(store, schemeId)
  return getSchemeVersion(store, schemeId, Math.trunc(Number(version)))
}

/** 一条计划采集行，或 null（新建时没有前值）。 */
const readCollectionPlan = (store, id) => {
  const planId = id === undefined || id === null ? '' : String(id).trim()
  return planId === '' ? null : getCollectionPlan(store, planId)
}

/**
 * 最近一轮体检的摘要（每项只取状态）。
 *
 * 一轮十项、每项一行，所以「前值」不是某一行：挑一行会让读的人以为这一行就是全部。
 * 摘要只留 `checkId/status`，明细在表里 —— 与 `collection_task.env_check_json` 的分工
 * 一致（任务上是摘要，表里是明细）。
 */
const readLatestEnvSummary = (store, taskId) => latestEnvChecks(store, { taskId })
  .map(row => ({ checkId: row.checkId, status: row.status }))

/* ── funnel ①: the tools ──────────────────────────────────────────────────────
   Keys are every name in `TOOLS`. `readBefore(deps, args)` — `deps` rather than
   `store` because a tool's dependencies are what it was built with, and a tool
   that needed something other than the store to read its old value would
   otherwise be un-auditable. */

export const WRITE_TARGETS = {
  /* ── UI state, not a database write ───────────────────────────────────── */
  'amzn_workbench_context': null,  // 选中/范围/筛选：内存里的工作台上下文，刷新即重建
  'amzn_workbench_focus': null,    // 同上，只是换一种焦点

  /* ── reads ────────────────────────────────────────────────────────────── */
  'amzn_source_list': null,
  'amzn_asin_query': null,
  'amzn_asin_get': null,
  /* 模块 05：详情是只读的（四个标签页全部由读构成）。显式登记为 null，不是漏了 ——
     s1b12 的那条守卫要求每个工具都被决定过一次。 */
  'amzn_asin_detail': null,
  /* F05-01：17 列的导出。**只读** —— 它把当前筛选的结果序列化成文本返回，
     既不写库也不落盘（「写到哪个文件」由会话里那个人决定，见 tools/asin.js 的说明）。 */
  'amzn_asin_export': null,
  /* F05-01 的保存视图：读一个，写两个。写的那两个在下面有完整描述符。 */
  'amzn_asin_view_list': null,
  /* B-05c：F05-04 的任意两快照 diff 与 F05-07 的单 ASIN 健康摘要。两条都是**纯读** ——
     diff 读 asin_snapshot / field_conflict / publication_record / asin_field_source，
     摘要读 asin / listing / asin_field_source / field_conflict / dq_issue，外加模块 13
     的 precheckFor（只读）。显式登记为 null，不是漏填。 */
  'amzn_asin_history': null,
  'amzn_asin_health': null,
  'amzn_asin_attribute_status': null,
  /* 产品表导入：只有 commit 写库，scan/preview 是读。 */
  'amzn_product_import': {
    action: 'product_profile.import',
    objectType: 'product_profile',
    objectId: a => (a?.path === undefined || a?.path === null ? 'product-import' : String(a.path)),
    readBefore: () => null,
    skip: a => (a?.action ?? 'preview') !== 'commit',
  },
  /* 只读：作业单阶段从行里算，不写库。 */
  'amzn_optimize_job': null,
  /* 只读：只回答"这个 ASIN 该挂哪条产品线"，不写库（写入仍走 amzn_asin_upsert）。 */
  'amzn_product_line_classify': null,
  'amzn_collect_status': null,
  'amzn_collect_doctor': null,     // 自检明确不写库（见 src/tools/collect.js 的说明）
  'amzn_keyword_query': null,
  'amzn_keyword_coverage': null,
  /* 排名观测历史：只读，不写任何东西。 */
  'amzn_kw_rank_history': null,
  /* 排班 save/delete 会写库；list/run-now 不写。按写工具登记。 */
  /* 竞品关系：add / retire 写库，list / reverse 只读。 */
  'amzn_asin_competitor': {
    action: 'asin_competitor.write',
    objectType: 'asin_competitor',
    objectId: a => (a?.parentAsin === undefined ? null : String(a.parentAsin).toUpperCase()),
    readBefore: () => null,
    /* discover 只在 write:true 时写库；预览是读，不该留审计行。 */
    skip: a => ['list', 'reverse'].includes(a?.action ?? 'list')
      || (a?.action === 'discover' && a?.write !== true),
  },
  'amzn_kw_scan_schedule': {
    action: 'kw_schedule.write',
    objectType: 'kw_scan_schedule',
    objectId: a => (a?.id === undefined || a?.id === null ? null : String(a.id)),
    readBefore: () => null,
    skip: a => (a?.action ?? 'list') === 'list',
  },
  'amzn_keyword_research': null,   // 明确只读：候选词要人挑，再由 keyword_import 写
  'amzn_optimize_report': null,
  /* F13-02（模块 13 第一子批）：九项前置门槛的只读入口。不写库，也不建 run ——
     它读 asin / listing / asin_field_source / keyword / keyword_ownership /
     competitor_set / rule_set / prompt / dq_issue，全部是已有事实。 */
  'amzn_optimize_precheck': null,
  /* B-13b / F13-01：草案收件箱的只读入口。它读 optimization_run 与
     optimization_draft，一行都不写 —— 作废 / 恢复 / 稍后在页面的
     `optimize-inbox` 路由上，采纳与驳回走 `amzn_optimize_save`。 */
  'amzn_optimize_inbox': null,
  /* B-13b / F13-03：十一类证据包的只读入口。读 optimization_evidence（只读冻结表）
     与 optimization_run，不写任何一行 —— 冻结只发生在 prepare 与 save 里。 */
  'amzn_optimize_evidence': null,
  /* B-13c / F13-05：九项策略卡的只读入口。读 optimization_strategy 与
     optimization_run，一行都不写 —— 确认走页面的 `optimize-strategy-confirm` 路由。 */
  'amzn_optimize_strategy': null,
  /* B-13c / F13-06：位置计划核对的只读入口。读 optimization_plan_check、
     optimization_run 与模块 08 的 keyword_plan，一行都不写 —— 裁决与写回走页面的
     `optimize-plan-decide` 路由。 */
  'amzn_optimize_plan_check': null,
  /* B-13d / F13-08：校验体系的统一入口（规则 / 闸门 / Agent 审阅三块）。**只读** ——
     它读 optimization_run / optimization_draft / optimization_review 与规则快照，
     一行都不写。审阅结论的写入在下面（`amzn_optimize_review`）与页面的
     `optimize-review-record` 路由上。 */
  'amzn_optimize_validation': null,
  'amzn_kw_query': null,
  'amzn_kw_pipeline_history': null,
  'amzn_rule_list': null,
  'amzn_rule_diff': null,
  'amzn_policy_list': null,
  'amzn_prompt_list': null,
  'amzn_prompt_preview': null,     // 渲染预览，不落库
  'amzn_prompt_history': null,     // 读冻结正文，不落库
  'amzn_prompt_lifecycle_get': null, // B-11.3：读状态与事件，不落库
  /* F11-09 — 反查「被哪些运行用过」。**只读**：它扫 optimization_run 与 agent_run
     的包，不写任何一行。给 `null` 是「看了，不是业务写」的登记，不是因为忘了填。 */
  'amzn_prompt_references': null,
  /* F11-07 — 固定评估集的读半边。`import` 才算写，所以只有它在下面有描述符。 */
  'amzn_prompt_eval_list': null,   // 读评估集目录，不落库
  'amzn_prompt_eval_show': null,   // 读一套的样例，不落库
  'amzn_competitor_analyze': null, // 明确只读：读 kw_competitor_fact / asin_keyword / kw_master
  /* B-06.1 — 四象限与证据。只读：分类与证据都是纯函数算出来的，读的是已有事实。 */
  'amzn_competitor_quadrants': null,
  'amzn_report_list': null,
  'amzn_report_diff': null,
  /* R-91 —— 字段模板的读半边。读当前模板、两版对照，都不落库。 */
  'amzn_field_template_get': null,
  'amzn_field_template_diff': null,
  /* F14-01 — 八类生成报告的**写入方**，以及报告自身的收藏/标签/归档。
     两者都是对 `report` 表的业务写入，所以有描述符，不是 null。 */
  'amzn_report_build': {
    action: ACTIONS.reportBuild,
    objectType: 'report',
    /* 一次 build 可能**新建**一行（今天的快照）或**更新**今天那一行，
       所以 id 只能从结果里读 —— 与 `amzn_workspace_upsert` 同一个形状。 */
    objectId: (a, r) => r?.report?.id ?? r?.id ?? null,
    readBefore: () => null,
    impact: a => ({ kind: a?.kind ?? null, dryRun: a?.dryRun === true }),
    skip: a => a?.dryRun === true,
  },
  'amzn_report_update': {
    action: ACTIONS.reportUpdate,
    objectType: 'report',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => getReport(deps.store, a?.id),
    impact: a => ({
      favorite: a?.favorite ?? null,
      archived: a?.archived ?? null,
      tags: a?.tags ?? null,
    }),
  },
  'amzn_setting_list': null,
  'amzn_dashboard': null,
  'amzn_audit_query': null,        // 审计日志的读半边：只读，不写库
  'amzn_agent_run_list': null,     // 模块 12 的读半边：列运行，不写库
  'amzn_agent_metrics': null,      // 模块 12 §14 的读半边：算指标，一个字节都不写
  /* 模块 14 的读半边：列发布记录 / 看一条记录的全貌。只读 —— 而且它读的东西本身
     就是「有没有登记过发布」，所以它更不能写。 */
  'amzn_publication_list': null,

  /* ── writes ───────────────────────────────────────────────────────────── */
  'amzn_source_upsert': {
    action: ACTIONS.sourceSave,
    objectType: 'source',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => readSource(deps.store, a?.id),
  },
  'amzn_asin_upsert': {
    action: ACTIONS.asinUpsert,
    objectType: 'asin',
    objectId: a => a?.records?.[0]?.asin ?? null,
    /* The first record is the object; the rest ride in `impact`. Reading one
       row's before value is the honest answer for a bulk upsert — the
       alternative is a before value the size of the request. */
    readBefore: (deps, a) => {
      const head = a?.records?.[0]
      if (head === undefined || head === null || head.asin === undefined) return null
      return getAsin(deps.store, head.asin, head.marketplace ?? 'US')
    },
    impact: (a) => ({ records: a?.records?.length ?? 0, asins: (a?.records ?? []).map(row => row?.asin ?? null) }),
  },
  /* 模块 05 第一子批的四条写工具。objectId 一律是 `<asin>@<marketplace>` 或边坐标 ——
     `asin` 表的主键就是 (asin, marketplace)，所以只写 ASIN 会让同一个 ASIN 在两个站点
     的两行审计看起来在说同一件事。变体那条的对象类型是 `asin_variant`（v37 的三张表），
     不是 `asin`：一次关系写入改的不是 ASIN 行。 */
  'amzn_asin_attribute_set': {
    action: ACTIONS.asinAttributeSet,
    objectType: 'asin',
    objectId: a => `${String(a?.asin ?? '').trim().toUpperCase()}@${String(a?.marketplace ?? 'US').trim().toUpperCase()}`,
    /* 读「写之前这一批属性长什么样」—— 只读 attributes_json 这一格，别在这里重算覆盖度。 */
    readBefore: (deps, a) => {
      const asin = String(a?.asin ?? '').trim().toUpperCase()
      const marketplace = String(a?.marketplace ?? 'US').trim().toUpperCase()
      const row = deps.store.get('SELECT attributes_json FROM listing WHERE asin = ? AND marketplace = ?', [asin, marketplace])
      if (row === null || row === undefined) return null
      return { attributes: row.attributes_json === null || row.attributes_json === undefined ? null : JSON.parse(row.attributes_json) }
    },
  },
  'amzn_asin_field_correct': {
    action: ACTIONS.asinFieldCorrect,
    objectType: 'asin',
    objectId: a => `${String(a?.asin ?? '').trim().toUpperCase()}@${String(a?.marketplace ?? 'US').trim().toUpperCase()}`,
    readBefore: (deps, a) => readAsinField(deps.store, a?.asin, a?.marketplace ?? 'US', a?.field),
    reason: a => a?.reason ?? null,
  },
  /* FR-M2-05 —— 归属（自有/竞品、产品线）的**唯一**写入口。
     与 `amzn_asin_field_correct` 分开，是因为它们写的不是同一张表：那一列住在
     `asin` 表，归属住在 `asin_ownership` 决策表（行不删、撤销只置时间戳）。
     合成一条会让审计回答不了「这次改的是那一列的值，还是一次归属判断」。
     `readBefore` 读的是这一类型当前的 live 边 —— 只读一处，别在这里重算派生值。 */
  'amzn_asin_ownership_set': {
    action: ACTIONS.asinOwnershipSet,
    objectType: 'asin_ownership',
    objectId: a => `${String(a?.asin ?? '').trim().toUpperCase()}@${String(a?.marketplace ?? 'US').trim().toUpperCase()}`
      + `:${String(a?.objectType ?? '').trim()}`,
    readBefore: (deps, a) => listOwnership(deps.store, { asin: a?.asin, marketplace: a?.marketplace ?? 'US' })
      .filter(row => row.retracted_at === null && row.object_type === String(a?.objectType ?? '').trim())
      .map(row => row.object_id),
    reason: a => a?.reason ?? null,
  },
  'amzn_asin_variant_upsert': {
    action: ACTIONS.asinVariantUpsert,
    objectType: 'asin_variant',
    objectId: a => variantKey(a),
    readBefore: readVariant,
    reason: a => a?.evidence ?? null,
    impact: a => ({ dimensions: Array.isArray(a?.dimensions) ? a.dimensions.length : 0 }),
  },
  'amzn_asin_variant_correct': {
    action: ACTIONS.asinVariantCorrect,
    objectType: 'asin_variant',
    objectId: a => variantKey(a),
    readBefore: readVariant,
    reason: a => a?.reason ?? null,
  },
  'amzn_asin_archive': {
    action: ACTIONS.asinArchive,
    objectType: 'asin',
    objectId: a => `${String(a?.asin ?? '').trim().toUpperCase()}@${String(a?.marketplace ?? 'US').trim().toUpperCase()}`,
    /* 归档的「前值」= 这一行现在的样子（含三个归档列）。恢复同样读它，所以
       before/after 的差异就是「方向」本身 —— 这也是归档与恢复共用一条 action 的依据。 */
    readBefore: (deps, a) => getAsin(deps.store, String(a?.asin ?? '').trim().toUpperCase(), String(a?.marketplace ?? 'US').trim().toUpperCase()),
    reason: a => a?.reason ?? null,
    /* ★ preview 是**读**：漏斗必须跳过审计，否则一次「看看影响面」会在日志里留下一条
       「归档了」—— 一条关于没有发生的事的记录，比没有记录更糟（本仓在 dryRun 上
       已经踩过同一个形状）。 */
    skip: a => String(a?.action ?? '').trim() === 'preview',
  },
  /* 2026-10-25（R-27 断点二）：amzn_review_ingest 把采到的评论正文回填进 reviews 表。
     它**是写工具**（写 reviews / review_bindings），所以必须有描述符 —— 本仓的规矩是
     「每个注册工具都要决定它是写还是非写」，漏一个就红（s1b12-audit ⑦ 就是这条）。
     objectId 用 asin；impact 记「写了几条」—— 「这次回填到底动没动数据」的答案就在那个数字里。 */
  'amzn_review_ingest': {
    action: 'review.ingest',
    objectType: 'review',
    objectId: a => String(a?.asin ?? '').trim().toUpperCase() || null,
    readBefore: () => null,
    impact: r => ({ written: r?.written ?? 0, skipped: r?.skipped ?? 0 }),
  },
  /* B-05e / F05-08 —— 受限删除是**另一个工具**，不是 `amzn_asin_archive` 的第五个动作。
     三条理由，每条都独立成立：
       · 归档与恢复是**同一个可逆标志**的两个方向，所以它们共用一条 action、共用一个工具；
         删除不属于那个轴 —— 它没有反方向。axis 不同，工具就不同。
       · 这条 action 必须是静态字符串（`s1b12` 的守卫按字面量校验描述符 —— 一个函数形态的
         action 在那条守卫眼里就是「malformed」）。把守卫放松到「能解析函数」是为了让一个
         设计选择过得去而削弱一条守卫，方向反了。
       · 删除的确认是**硬前置条件**（`confirm: true` 恒定要求），归档的确认是一个可以关掉的
         设置。两套闸门放在一个入参枚举里，会让「这个 action 的 confirm 是什么意思」
         依赖另一个字段的值。 */
  'amzn_asin_delete': {
    action: ACTIONS.asinDelete,
    objectType: 'asin',
    objectId: a => `${String(a?.asin ?? '').trim().toUpperCase()}@${String(a?.marketplace ?? 'US').trim().toUpperCase()}`,
    /* 前值就是这行记录**最后的样子**。删除之后没有行可以再读（`readAfterValue` 会退回
       这次调用的返回值），所以 `before` 是这条记录唯一还有人记得的内容 ——
       而它正是「删掉的到底是什么」这个问题的答案。 */
    readBefore: (deps, a) => getAsin(deps.store, String(a?.asin ?? '').trim().toUpperCase(), String(a?.marketplace ?? 'US').trim().toUpperCase()),
    reason: a => a?.reason ?? null,
    /* `delete_preview` 是读：引用检查什么都不写，所以它不能留下一条「删除了」的记录。 */
    skip: a => String(a?.action ?? '').trim() === 'delete_preview',
  },
  'amzn_product_line_upsert': {
    action: ACTIONS.productLineUpdate,
    objectType: 'product_line',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => readProductLine(deps.store, a?.id),
    impact: a => ({ signals: Array.isArray(a?.signals) ? a.signals.length : null }),
    /* dryRun 只算影响、不写（`tools/product-line.js` 的 `if (!dryRun ...)` 才写）。 */
    skip: a => a?.dryRun === true,
  },
  /* R-91 —— 字段模板的四个写动作。对象是**模板本身**（一个模板一条身份），
     版本号在结果里；`documented` 的细节见 `store/field-template.js` 上那段注释。 */
  'amzn_field_template_save': {
    action: ACTIONS.fieldTemplateSave,
    readBefore: readFieldTemplate,
    objectType: 'field_template',
    objectId: () => 'listing-optimize',
    impact: a => ({ fields: Array.isArray(a?.items) ? a.items.length : null }),
  },
  'amzn_field_template_propose': {
    action: ACTIONS.fieldTemplatePropose,
    readBefore: readFieldTemplate,
    objectType: 'field_template',
    objectId: () => 'listing-optimize',
    impact: a => ({ fields: Array.isArray(a?.items) ? a.items.length : null }),
  },
  'amzn_field_template_confirm': {
    action: ACTIONS.fieldTemplateConfirm,
    readBefore: readFieldTemplate,
    objectType: 'field_template',
    objectId: () => 'listing-optimize',
    impact: a => ({ version: a?.version ?? null }),
  },
  'amzn_field_template_rollback': {
    action: ACTIONS.fieldTemplateRollback,
    readBefore: readFieldTemplate,
    objectType: 'field_template',
    objectId: () => 'listing-optimize',
    impact: a => ({ to: a?.to ?? null }),
  },
  /* 2026-10-25（R-10）：`amzn_shop_upsert` 是 `shop-save` 那条页面路由的工具版。
     **动作名与页面共用 `shop.update`** —— 同一个语义用同一个名字，否则「谁改的这个店铺」要查两个动作。
     `action: "list"` 是读，不留痕；create / update / archive / restore 都写同一行，
     真实的那个动词记在 `impact.action` 里 —— 比塞进动作名诚实（动作名答「动了哪类对象」，impact 答「做了什么」）。
     ⚠️ 这条**必须在 WRITE_TARGETS（工具段）里**，不是 PAGE_WRITE_TARGETS（路由段）——
     我第一版放错段，主套件当场报「amzn_shop_upsert route is classified as a write but no route block」。
     它没有页面路由，它是工具。 */
  'amzn_shop_upsert': {
    action: 'shop.update',
    objectType: 'shop',
    objectId: (a, r) => a?.id ?? r?.shop?.id ?? null,
    readBefore: (store, a) => (String(a?.id ?? '').trim() === '' ? null : getShop(store, String(a.id).trim())),
    impact: (a, r) => ({
      action: String(a?.action ?? 'list').trim().toLowerCase(),
      created: String(a?.id ?? '').trim() === '' && r?.shop?.id ? r.shop.id : null,
    }),
    skip: a => String(a?.action ?? 'list').trim().toLowerCase() === 'list',
  },
  /* F05-01 的两条保存视图写动作。objectId 是**视图名**（主键里用户认得出的那一半），
     前值是同名视图存之前的样子 —— 「我把筛选改成什么了」这个问题的答案就在
     before/after 的 filters 差异里。 */
  'amzn_asin_view_save': {
    action: ACTIONS.asinViewSave,
    objectType: 'asin_saved_view',
    objectId: a => String(a?.name ?? '').trim() || null,
    readBefore: (deps, a) => readAsinSavedView(deps.store, a?.name),
    impact: a => ({ columns: Array.isArray(a?.columns) ? a.columns.length : null }),
  },
  'amzn_asin_view_delete': {
    action: ACTIONS.asinViewDelete,
    objectType: 'asin_saved_view',
    objectId: a => String(a?.name ?? '').trim() || null,
    readBefore: (deps, a) => readAsinSavedView(deps.store, a?.name),
  },
  'amzn_asin_import': {
    action: ACTIONS.asinImport,
    objectType: 'asin',
    /* 一次导入没有「一条」对象：它动的是 N 行。写第一行的 ASIN 会让日志看起来像
       「只动了这一条」（与 `amzn_kw_merge` / `amzn_agent_run_recover` 同一个判断），
       所以 objectId 是 null，影响面进 `impact`。 */
    objectId: () => null,
    /* 前值：整份文件的前值会是整个库，所以读**会被覆盖的那些格子的前值**已经由
       `buildAsinImportPlan` 的 rollback 承担；这里按 `amzn_keyword_discover` 的先例
       给 null（批量：前值会是整张表），并在 `impact` 里说清影响面。 */
    readBefore: () => null,
    impact: a => ({
      /* 计划由同一次调用产出，所以影响面从入参里读不出来 —— 报「这份文件有多大」，
         而不是编一个行数。真正写了几行由工具返回值说明。 */
      characters: typeof a?.text === 'string' ? a.text.length : null,
      sourceId: a?.sourceId ?? null,
      onInvalid: a?.onInvalid ?? 'reject',
      onDuplicate: a?.onDuplicate ?? 'reject',
    }),
    /* ★ 预览（默认）**不是写**：`dryRun` 省略或为 true 时这个工具一行都不写，
       记一条「导入发生了」的记录就是关于一件没发生的事的记录 —— 与
       `amzn_asin_archive` 的 preview、`amzn_keyword_discover` 的 dryRun 同一条纪律。 */
    skip: a => a?.dryRun !== false,
  },
  'amzn_collect_submit': {
    action: 'collection_task.submit',
    objectType: 'collection_task',
    /* The task id is minted by this call and the tool returns it inside a
       rendered sentence, not as a field. Reading it back would mean a regex
       over the tool's own prose, so it stays null — see the note on
       `objectId(args, result)` at the top of this file. */
    objectId: () => null,
    readBefore: () => null,        // 同上：没有「改之前」的行
    /* ── the worker boundary, written down because it is the point ─────────
       What is audited here is **"this collection task was submitted"** — a row
       in `collection_task` now exists and the agent asked for it. It is NOT
       "the data was written to the library". The scraping happens later, in a
       separate process, minutes after this call has returned; a task that is
       blocked by a captcha, or that finds the selector changed, writes nothing
       and leaves this audit row standing. That is not a lie: the submit really
       did happen. But a reader must not treat the presence of this row as
       evidence that the library changed — for that, read the task's own
       outcome, or the `asin` rows it wrote. */
    impact: a => ({
      targets: Array.isArray(a?.targets) ? a.targets.length : (Array.isArray(a?.asins) ? a.asins.length : 0),
      marketplaces: [...new Set([
        ...(a?.targets ?? []).map(t => t?.marketplace ?? a?.marketplace ?? 'US'),
        ...(a?.asins ?? []).map(() => a?.marketplace ?? 'US'),
      ])],
    }),
  },
  'amzn_keyword_import': {
    action: 'kw_master.import',
    objectType: 'kw_master',
    objectId: () => null,          // 批量入库，没有单一对象
    readBefore: () => null,        // 批量：前值会是整张表
    impact: a => ({
      keywords: Array.isArray(a?.keywords) ? a.keywords.length : 0,
      measurements: Array.isArray(a?.measurements) ? a.measurements.length : 0,
    }),
  },
  'amzn_keyword_discover': {
    action: 'kw_master.discover',
    objectType: 'kw_master',
    objectId: () => null,
    readBefore: () => null,
    impact: a => ({ seeds: Array.isArray(a?.seeds) ? a.seeds.length : 0, marketplace: a?.marketplace ?? 'US' }),
    /* dryRun 只报告不写库（见 src/tools/keyword.js 的说明）。记一条没发生的写就是
       谎报，所以这一条明确跳过 —— 这是描述符唯一一处「按参数决定要不要审计」，
       它存在的理由是那个参数真的会让工具什么都不写。 */
    skip: a => a?.dryRun === true,
  },
  'amzn_keyword_scan': {
    action: 'collection_task.submit',
    objectType: 'collection_task',
    /* Same as `collect_submit` above: the task id is created by this call but
       only reaches the caller inside the rendered text, so it stays null. */
    objectId: () => null,
    readBefore: () => null,
    /* ── the same worker boundary as `collect_submit`, and it matters more
       here because the name is more convincing. This audits "a keyword coverage
       scan was submitted"; the ranking verdicts it exists to produce are
       written minutes later by the worker, and a scan that is blocked writes
       none of them. The audit row says the scan was asked for — nothing about
       whether it found anything. */
    impact: a => ({ keywords: Array.isArray(a?.keywords) ? a.keywords.length : 0, marketplace: a?.marketplace ?? 'US' }),
  },
  'amzn_optimize_prepare': {
    /* 与页面的 `optimize-prepare` 路由共用同一个动作名（F-7）：同一件事，一个字符串。 */
    action: ACTIONS.optimizePrepare,
    objectType: 'optimization_run',
    /* The run id is minted here, but the tool returns a rendered package, so
       there is no field to read it from — null, named rather than silently
       blank. */
    objectId: () => null,
    readBefore: () => null,
    impact: a => ({ asin: a?.asin ?? null, marketplace: a?.marketplace ?? 'US' }),
    /* dryRun 只返回数据包、不建 run 行（`tools/optimize.js` 的
       `if (args?.dryRun !== true)` 才写 run）。记一条没发生的 create 就是假账。 */
    skip: a => a?.dryRun === true,
  },
  'amzn_optimize_validate': {
    action: 'optimization_draft.validate',
    objectType: 'optimization_draft',
    objectId: a => a?.runId ?? null,
    /* 这次调用会把校验结果写进草案；草案在调用前可能还不存在，读不到就是 null，
       而不是「没查」。 */
    readBefore: () => null,
    impact: a => ({ runId: a?.runId ?? null }),
    /* 只有 `persist === true` **且有 runId** 才落草案（`tools/optimize.js` 的
       `if (args?.persist === true)` 里面还有 `run === null` 的提前返回：
       只提示「没有 runId，无法落库」，一行不写）。不带 persist、或 persist 但没有
       runId 的校验都是只读的，记一条 `optimization_draft.validate` 就是给没发生的写记账。 */
    skip: a => a?.persist !== true || String(a?.runId ?? '').trim() === '',
  },
  'amzn_optimize_save': {
    action: 'optimization_draft.save',
    objectType: 'optimization_draft',
    objectId: a => a?.runId ?? null,
    /* The before value is the draft set this call is about to finalise — the
       text the agent produced and the verdicts it was given, read through the
       store's own reader for a run's drafts. The tool's result is a report, not
       a row, so this is the only place the prior state can come from. */
    readBefore: (deps, a) => listOptimizationDrafts(deps.store, a?.runId),
    impact: a => ({ runId: a?.runId ?? null, accepted: Array.isArray(a?.accepted) ? a.accepted.length : null }),
  },
  /* B-13d / F13-08：Agent 审阅的**写**入口。一次调用可以记多条，所以 objectId 指向
     被审阅的那一轮（结论挂在轮次上），而「这次记的是哪几项、什么结论」进 `reason`。
     `readBefore` 读的是这一轮**这一项**的结论行 —— 前值必须是「被改的那一行」，
     而不是整轮的全部结论（那会把别人的结论也算成这次改动的前值）。
     `skip`：不带 conclusions 时这个工具是**只读**的，一次只读调用必须一行审计都不落
     （与 `amzn_asin_detail` 这类只读工具同一条纪律：审计里不许出现一次没有发生的写）。 */
  'amzn_optimize_review': {
    action: ACTIONS.optimizeReviewRecord,
    objectType: 'optimization_run',
    objectId: a => a?.runId ?? null,
    readBefore: (deps, a) => {
      const first = Array.isArray(a?.conclusions) ? a.conclusions[0] : null
      return first === null || first === undefined
        ? null
        : readReviewRow(deps.store, a?.runId, first?.itemId, first?.field ?? '')
    },
    reason: a => {
      const list = Array.isArray(a?.conclusions) ? a.conclusions : []
      if (list.length === 0) return null
      return list.map(entry => `${entry?.itemId ?? '?'}${entry?.field ? `@${entry.field}` : ''}=${entry?.conclusion ?? '?'}`).join('；')
    },
    skip: a => !Array.isArray(a?.conclusions) || a.conclusions.length === 0,
  },
  'amzn_kw_import': {
    action: ACTIONS.kwImportCreate,
    objectType: 'kw_import',
    objectId: () => null,          // import id 由这次调用生成，但结果是一段渲染文本，读不到
    readBefore: () => null,
    impact: a => ({ path: a?.path ?? a?.file ?? null, recursive: a?.recursive === true }),
    /* dryRun 只解析、不写库（`tools/kw.js` 把 `dryRun` 原样交给 import 函数）。 */
    skip: a => a?.dryRun === true,
  },
  'amzn_kw_source': {
    action: ACTIONS.kwSourceToggle,
    objectType: 'kw_import',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => getImport(deps.store, a?.id),
  },
  'amzn_kw_merge': {
    action: 'kw_master.merge',
    objectType: 'kw_master',
    objectId: () => null,          // 批量合并
    readBefore: () => null,
    impact: a => ({ keywords: Array.isArray(a?.keywords) ? a.keywords.length : 0, marketplace: a?.marketplace ?? 'US' }),
  },
  'amzn_kw_export': {
    action: 'report.export',
    objectType: 'report',
    objectId: () => null,          // report 行由这次调用登记，但工具返回渲染文本
    readBefore: () => null,
    impact: a => ({ marketplace: a?.marketplace ?? 'US', purpose: a?.purpose ?? 'all' }),
  },
  'amzn_kw_report': {
    action: 'report.generate',
    objectType: 'report',
    objectId: () => null,          // 同上：report id 不在结构化结果里
    readBefore: () => null,
    impact: a => ({ marketplace: a?.marketplace ?? 'US' }),
  },
  'amzn_kw_pipeline_run': {
    action: 'kw_pipeline_run.create',
    objectType: 'kw_pipeline_run',
    objectId: () => null,          // run id 由这次调用生成，工具返回的是渲染文本
    readBefore: () => null,
    impact: a => ({ marketplace: a?.marketplace ?? 'US', productLine: a?.productLine ?? null }),
    /* dryRun 不写文件也不落 run 行（见 src/tools/kw.js 的说明）。 */
    skip: a => a?.dryRun === true,
  },
  'amzn_rule_upsert': {
    action: 'rule.upsert',
    objectType: 'rule',
    objectId: a => a?.rule_id ?? null,
    readBefore: (deps, a) => readRule(deps.store, a?.rule_id),
    impact: a => ({ kind: a?.kind ?? 'doc', severity: a?.severity ?? 'warn' }),
  },
  'amzn_rule_activate': {
    action: 'rule_set.activate',
    objectType: 'rule_set',
    objectId: a => a?.version ?? null,
    /* 前值是「当前生效的是哪一版」，不是一个规则行 —— 这一版的规则集可能有几百行，
       记整份会让审计行比它描述的东西还大。 */
    readBefore: deps => readActiveVersion(deps.store),
  },
  'amzn_rule_import': {
    action: 'rule.import',
    objectType: 'rule',
    objectId: () => null,          // 文档导入是批量的
    readBefore: () => null,
    impact: a => ({ path: a?.path ?? null }),
    /* `dryRun` 默认 true（`tools/rule.js` 的 `args?.dryRun !== false`）——
       默认调用就是预览，不写库；只有显式 dryRun:false 才发布新版本。 */
    skip: a => a?.dryRun !== false,
  },
  'amzn_policy_import': {
    action: 'policy.import',
    objectType: 'policy',
    objectId: () => null,          // policy id 由这次调用生成，工具返回渲染文本，读不到
    readBefore: () => null,
    impact: a => ({ source: a?.source ?? null }),
  },
  'amzn_policy_link': {
    action: ACTIONS.policyLink,
    objectType: 'policy',
    objectId: a => a?.policyId ?? null,
    readBefore: (deps, a) => getPolicy(deps.store, a?.policyId),
    impact: a => ({ ruleIds: Array.isArray(a?.ruleIds) ? a.ruleIds.length : 0 }),
  },
  'amzn_prompt_upsert': {
    action: ACTIONS.promptSave,
    objectType: 'prompt',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => getPrompt(deps.store, a?.id),
  },
  'amzn_prompt_rollback': {
    action: ACTIONS.promptRollback,
    objectType: 'prompt',
    objectId: a => a?.id ?? null,
    /* 前值就是回滚**之前**的那一版正文 —— 与保存读同一个 reader，回滚才回答得了
       「从哪一版退回去的」。 */
    readBefore: (deps, a) => getPrompt(deps.store, a?.id),
  },
  /* B-11.3 / F11-05 — 生命周期的三个写动作。前值统一读那条 prompt 行：状态本身在
     `prompt_lifecycle_event` 里、由事件推导，而 readBefore 要的是**对象**当前的样子 ——
     版本（编辑计数）就是「当时动的是哪一版」的答案。 */
  'amzn_prompt_lifecycle_transition': {
    action: ACTIONS.promptLifecycle,
    objectType: 'prompt',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => getPrompt(deps.store, a?.id),
  },
  'amzn_prompt_version_activate': {
    action: ACTIONS.promptActivate,
    objectType: 'prompt',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => getPrompt(deps.store, a?.id),
  },
  'amzn_prompt_version_rollback': {
    action: ACTIONS.promptVersionRollback,
    objectType: 'prompt',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => getPrompt(deps.store, a?.id),
  },
  /* F11-07 — 导入评估集。`readBefore` 读的是同一 (setId, version) **导入前**的那一份，
     因为导入是整份替换：审计要回答的是「这一版原来是什么、被换成了什么」，
     所以前值必须是那个版本的对象，而不是整张表的快照。
     `impact` 报样例条数 —— 一条被换掉的评估集，条数变化是最先要看到的那个数。 */
  'amzn_prompt_eval_import': {
    action: ACTIONS.promptEvalImport,
    objectType: 'prompt_eval_set',
    objectId: a => (a?.setId === undefined || a?.setId === null ? null : String(a.setId)),
    readBefore: (deps, a) => getEvalSet(deps.store, a?.setId, a?.version),
    impact: a => ({ cases: Array.isArray(a?.cases) ? a.cases.length : 0 }),
  },
  'amzn_competitor_set_upsert': {
    action: ACTIONS.competitorSetSave,
    objectType: 'competitor_set',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => getCompetitorSet(deps.store, a?.id),
    impact: a => ({ asins: Array.isArray(a?.asins) ? a.asins.length : 0 }),
  },
  'amzn_setting_set': {
    action: ACTIONS.settingSet,
    objectType: 'setting',
    objectId: a => a?.key ?? null,
    /* getSetting 对未声明的键会抛。这里不吞掉：漏斗会把「读不到前值」记成 null，
       而写本身仍然发生（设置类写入失败的判定由工具自己的返回决定）。 */
    readBefore: (deps, a) => getSetting(deps.store, a?.key),
    /* The tool's `note` parameter — "why this setting changed" — recorded where
       that question belongs. It used to be passed to `setSetting`, which takes
       three arguments: the fourth was dropped on the floor, so the parameter
       was a promise the code did not keep. See `reason` in the header. */
    reason: a => a?.note ?? null,
  },
  'amzn_workspace_upsert': {
    action: ACTIONS.workspaceUpdate,
    objectType: 'workspace',
    /* The one creation descriptor whose id can be read from the result: this
       tool returns `{ ok, action, workspace, text }`, so a `create` with no id
       in `args` still names the row it made. The other lifecycle actions pass
       the id in `args`, and both paths meet here. */
    objectId: (a, r) => a?.id ?? r?.workspace?.id ?? null,
    readBefore: (deps, a) => getWorkspace(deps.store, a?.id),
    impact: a => ({ action: a?.action ?? null }),
  },
  'amzn_dq_scan': {
    action: 'dq_issue.scan',
    objectType: 'dq_issue',
    objectId: () => null,          // 全库扫描，不是单个对象
    readBefore: () => null,        // 前值会是整张 dq_issue
    impact: a => ({ marketplace: a?.marketplace ?? null }),
  },
  'amzn_conflict_resolve': {
    action: ACTIONS.conflictResolve,
    objectType: 'field_conflict',
    objectId: a => a?.id ?? null,
    readBefore: (deps, a) => getConflict(deps.store, a?.id),
    impact: a => ({ adoptedSourceId: a?.adoptedSourceId ?? null }),
  },

  /* 模块 12 — Agent 编排。五条写动作。
     `readBefore` 读的都是运行本身（或运行的产物），因为审计要回答的是「这次运行
     被推到了哪一步、当时状态是什么」；`amzn_agent_run_start` 是一次 create，没有
     前值可读，所以是 `null` —— 与其它 create 描述符同一个判断。 */
  'amzn_agent_run_start': {
    action: ACTIONS.agentRunStart,
    objectType: 'agent_run',
    /* The id is minted by the store and rides on the result's run object. */
    objectId: (a, r) => r?.id ?? null,
    readBefore: () => null,
    impact: a => ({ role: a?.role ?? null, scope: a?.scope ?? null }),
  },
  'amzn_agent_run_step': {
    action: ACTIONS.agentRunStep,
    objectType: 'agent_run',
    objectId: a => a?.runId ?? null,
    readBefore: (deps, a) => readAgentRun(deps.store, a?.runId),
    impact: a => ({ seq: a?.seq ?? null, step: a?.step ?? null, status: a?.status ?? null }),
  },
  'amzn_agent_run_finish': {
    action: ACTIONS.agentRunFinish,
    objectType: 'agent_run',
    objectId: a => a?.runId ?? null,
    readBefore: (deps, a) => readAgentRun(deps.store, a?.runId),
    impact: a => ({ status: a?.status ?? null }),
  },
  /* F12-09 — 中断恢复扫描。它改的是**一批**运行（running → blocked），所以 `objectId`
     是 `null`：一次调用可能动 N 条，写其中一条的 id 会让那一行看起来像「只动了这一条」。
     动了哪几条由工具输出说明；审计这一行回答的是「谁在什么时候扫了一遍、用什么阈值」。
     `readBefore` 也是 `null` —— 扫描之前没有「一条」可以读，`staleMinutes` 是入参
     而不是前值。 */
  'amzn_agent_run_recover': {
    action: ACTIONS.agentRunRecover,
    objectType: 'agent_run',
    objectId: () => null,
    readBefore: () => null,
    impact: a => ({ staleMinutes: a?.staleMinutes ?? null }),
  },
  'amzn_agent_artifact_save': {
    action: ACTIONS.agentArtifactSave,
    objectType: 'agent_artifact',
    objectId: (a, r) => r?.id ?? null,
    readBefore: () => null,
    impact: a => ({ type: a?.type ?? null, objectType: a?.objectType ?? null, objectId: a?.objectId ?? null }),
  },
  'amzn_agent_gate_decide': {
    action: ACTIONS.agentGateDecide,
    objectType: 'agent_gate',
    objectId: a => a?.gate ?? null,
    /* The before value is the run: 「这次裁决把运行从哪个状态放回了哪个状态」 is the
       fact worth recording, and the gate itself has no row to read. */
    readBefore: (deps, a) => readAgentRun(deps.store, a?.runId),
    impact: a => ({ runId: a?.runId ?? null, approve: a?.approve === true }),
    reason: a => a?.note ?? null,
  },
  'amzn_agent_artifact_decide': {
    action: ACTIONS.agentArtifactDecide,
    objectType: 'agent_artifact',
    objectId: a => a?.artifactId ?? null,
    /* 前值是被裁决的那条产物 —— 「它从哪个状态被推到了哪个状态」正是这一行要能回答
       的，而 `readAgentArtifact` 只取状态那几列，不把正文搬进日志。 */
    readBefore: (deps, a) => readAgentArtifact(deps.store, a?.artifactId),
    impact: a => ({ artifactId: a?.artifactId ?? null, accept: a?.accept === true }),
    reason: a => a?.note ?? null,
  },
  /* F12-02 — 发布一版角色配置。一次 **create**：新版本行的 id 由这次调用铸造，而工具
     回的是渲染文本（不是一个带 id 的对象），所以 `objectId` 与 `amzn_publication_record`
     同一个判断 —— 没有 id 可读，写 null 而不是编一个。
     「发布了哪一版」由 `readAfter`（回读刚成为当前版本的那一行）与 `impact.role` 说明，
     不给一个看起来像对象 id 的假值。`by` 是自报标签，落在 `reason` 上（配置行本身没有
     发布人一栏 —— 契约定的列里没有它）。 */
  'amzn_agent_role_config_release': {
    action: ACTIONS.agentRoleConfigRelease,
    objectType: 'agent_role_config',
    objectId: () => null,
    readBefore: () => null,
    readAfter: (deps, a) => readAgentRoleConfig(deps.store, a?.role),
    impact: a => ({ role: a?.role ?? null, note: a?.note ?? null }),
    reason: a => [a?.by ? `发布人 ${a.by}` : null, a?.note ? `说明 ${a.note}` : null].filter(Boolean).join('；') || null,
  },
  /* F12-02 的两个读工具：显式登记为「不写」而不是漏登记（漏登记与登记成只读在守卫眼里
     一样，但后者是说过的话）。 */
  'amzn_agent_role_config_list': null,
  'amzn_agent_role_config_show': null,

  /* F12-03 — 补充数据请求的两条写动作。
     **开**：一次 create。id 由这次调用铸造、工具回的是渲染文本，所以 `objectId` 与
     `amzn_publication_record` 同一个判断（没有 id 可读就给 null，不编一个）。「开了哪一条」
     由 `readAfter`（回读这次运行最新的一条请求）与 `impact` 说明。
     **结**：id 就在 `args` 里，所以 `objectId` 直接用它；前值是结清**前**那一行、后值是
     结清**后**那一行 —— 「它从 open 变成了什么」正是这一行要回答的。 */
  'amzn_agent_data_request': {
    action: ACTIONS.agentDataRequestOpen,
    objectType: 'agent_data_request',
    objectId: () => null,
    readBefore: () => null,
    readAfter: (deps, a) => {
      const listed = listDataRequests(deps.store, { runId: a?.runId })
      return listed.rows.length === 0 ? null : listed.rows[listed.rows.length - 1]
    },
    impact: a => ({ runId: a?.runId ?? null, what: a?.what ?? null }),
    reason: a => a?.why ?? null,
  },
  'amzn_agent_data_request_resolve': {
    action: ACTIONS.agentDataRequestResolve,
    objectType: 'agent_data_request',
    objectId: a => a?.requestId ?? null,
    readBefore: (deps, a) => getDataRequest(deps.store, a?.requestId),
    readAfter: (deps, a) => getDataRequest(deps.store, a?.requestId),
    impact: a => ({ status: a?.status ?? null }),
    reason: a => a?.resolution ?? null,
  },
  /* F12-03 的读工具：显式登记为「不写」。 */
  'amzn_agent_data_request_list': null,

  /* 模块 14 §6/§7。三条写动作。 */
  'amzn_publication_record': {
    action: ACTIONS.publicationRecord,
    objectType: 'publication_record',
    /* A create: the id is minted by this call, and the tool returns a rendered
       string rather than the row, so there is nothing to read it from. */
    objectId: () => null,
    /* No prior row — this is the call that brings the record into existence.
       `null` here is "it did not exist", not "we did not look". */
    readBefore: () => null,
    impact: a => ({
      asin: a?.asin ?? null,
      marketplace: a?.marketplace ?? null,
      kind: a?.kind ?? null,
      runId: a?.runId ?? null,
      draftVersion: a?.draftVersion ?? null,
      /* The field names, not their values: the values are a listing's worth of
         copy, and the log answers "what state did this change". */
      fields: a?.published !== null && typeof a?.published === 'object' ? Object.keys(a.published) : null,
    }),
    reason: a => a?.note ?? null,
  },
  'amzn_publication_baseline_decide': {
    action: ACTIONS.publicationBaselineDecide,
    objectType: 'publication_record',
    objectId: a => a?.publicationId ?? null,
    /* The state being decided is the record's own: `deviated` and the
       observation start are what this call moves. Reading the row here is what
       makes 「处置前观测起点 → 处置后」 answerable. */
    readBefore: (deps, a) => readPublication(deps.store, a?.publicationId),
    impact: a => ({ publicationId: a?.publicationId ?? null, choice: a?.choice ?? null }),
    reason: a => a?.note ?? null,
  },
  'amzn_observation_plan_save': {
    action: ACTIONS.observationPlanSave,
    objectType: 'observation_plan',
    objectId: () => null,          // 新建；工具返回渲染文本，id 读不到
    /* Not `null`-as-"nothing existed": a publication has at most one **active**
       plan, and saving a second one is the moment the first stops being the one
       §8 will read. That replacement is the fact worth recording. */
    readBefore: (deps, a) => readActivePlan(deps.store, a?.publicationId),
    impact: a => ({
      publicationId: a?.publicationId ?? null,
      changed: Array.isArray(a?.changed) ? a.changed.length : null,
      unchanged: Array.isArray(a?.unchanged) ? a.unchanged.length : null,
      rebuild: a?.rebuild === true,
      windowDays: a?.windowDays ?? null,
    }),
  },

  /* 模块 14 §8/§9。四条写 + 两条只读。

     `null` 在这里仍然是「看过并且它不是数据库写入」，所以两条只读工具显式登记为
     null —— 漏登记与「登记成只读」在守卫眼里一样，但后者是**说过**的。 */
  'amzn_observation_list': null,
  'amzn_rollback_list': null,

  'amzn_observation_check': {
    action: ACTIONS.observationMaterialise,
    /* 物化改的是 `observation_checkpoint`，但**对象**是那条发布记录：调用方说的是
       「把这条发布的观测节点算出来」，而节点是派生物。把 objectType 写成节点会让
       `objectId` 变成一个 publicationId，那种错位读日志的人第一眼就会绊一下。 */
    objectType: 'publication_record',
    objectId: a => a?.publicationId ?? null,
    /* 观测起点与偏离处置都可能被前一步改过，所以前值是发布记录当前的样子 ——
       「物化时用的是哪个起点」正是这一行要能回答的。 */
    readBefore: (deps, a) => readPublication(deps.store, a?.publicationId),
    impact: a => ({ publicationId: a?.publicationId ?? null }),
  },

  'amzn_observation_conclude': {
    action: ACTIONS.observationConclude,
    objectType: 'observation_checkpoint',
    objectId: a => a?.checkpointId ?? null,
    /* 前值必须能回答「下结论时这个节点是什么状态」—— 尤其是它当时是 `blocked`
       还是 `ready`，因为那决定了「无法判断」是唯一选项还是人的选择。 */
    readBefore: (deps, a) => readCheckpoint(deps.store, a?.checkpointId),
    impact: a => ({ checkpointId: a?.checkpointId ?? null, conclusion: a?.conclusion ?? null }),
    reason: a => a?.note ?? null,
  },

  'amzn_observation_scan_due': {
    action: ACTIONS.observationScanDue,
    objectType: 'notification',
    /* 一批，不是一条：一次扫描可能写好几条通知，而 `notification` 的对象 id 是
       单条通知的 id。给 `null` 而不是随便挑一条，是因为「哪一条」不是这个动作的
       对象 —— 动作的对象是「这次扫描」。 */
    objectId: () => null,
    readBefore: () => null,
    impact: a => ({ notify: a?.notify !== false, limit: a?.limit ?? null }),
  },

  'amzn_rollback_suggest': {
    action: ACTIONS.rollbackSuggest,
    objectType: 'rollback_task',
    objectId: () => null,          // 新建；工具返回渲染文本，id 读不到
    /* 前值是被回滚的那条发布记录：§9 的交付包完全由它和它的前一条算出来，所以
       「生成时线上是哪一版」是这一行最该留下的东西。 */
    readBefore: (deps, a) => readPublication(deps.store, a?.publicationId),
    impact: a => ({ publicationId: a?.publicationId ?? null }),
    reason: a => a?.reason ?? null,
  },

  /* 模块 08 F08-07。两条读、两条写。
     两条读显式登记为 `null`：`null` 在这里是「看过并且它不是数据库写入」，漏登记与
     登记成只读在守卫眼里一样，但后者是**说过**的。 */
  'amzn_keyword_lifecycle_list': null,
  'amzn_keyword_lifecycle_history': null,

  'amzn_keyword_lifecycle_set': {
    action: ACTIONS.keywordLifecycleSet,
    objectType: 'keyword_lifecycle',
    /* 对象是「这条词在**这个站点**的生命周期」。(keyword, marketplace) 是它的主键，
       所以 id 也带上站点 —— 只写 keyword 会让两个站点的同一拼写共用一个 object_id，
       而本项目一贯的口径是「不同站点同拼写不是同一个业务词」。 */
    objectId: a => (a?.keyword === undefined || a?.keyword === null
      ? null
      : `${String(a.keyword).toLowerCase()}@${String(a.marketplace ?? '').toUpperCase()}`),
    /* 前值是这条词当前的状态；没有记录就是 null（「没人决定过」），不是 candidate。 */
    readBefore: (deps, a) => readKeywordLifecycle(deps.store, a?.keyword, a?.marketplace),
    impact: a => ({ to: a?.to ?? null, source: a?.source ?? 'manual' }),
    reason: a => a?.reason ?? null,
  },

  'amzn_keyword_lifecycle_batch': {
    action: ACTIONS.keywordLifecycleBatch,
    objectType: 'keyword_lifecycle',
    /* 一批，不是一条：一次声明可以推很多词，而 object_id 是单条词的键。给 null 而不是
       随便挑一条 —— 这个动作的对象是「这次声明」，不是其中某一个词。 */
    objectId: () => null,
    /* 前值会是整张 keyword_lifecycle（被声明的那些词各自的原状态），与 `amzn_kw_merge`
       的批量判断同一条理由。 */
    readBefore: () => null,
    impact: a => ({
      publicationId: a?.publicationId ?? null,
      to: a?.to ?? null,
      marketplace: a?.marketplace ?? null,
      keywords: Array.isArray(a?.keywords) ? a.keywords.length : 0,
    }),
    reason: a => a?.reason ?? null,
  },

  /* F-5（走查 2026-10-25）：关键词的**批量**改生命周期 —— 一次人的决定。
     与上面那条 `_batch`（显式发布关联）是两个动作：那条回答「这次发布用了哪些词」，
     这条回答「人决定这一批词到哪一步」。动作分开、对象同是 `keyword_lifecycle`，
     因为后者才是这张表的业务对象。 */
  'amzn_keyword_lifecycle_batch_set': {
    action: ACTIONS.keywordLifecycleBatchSet,
    objectType: 'keyword_lifecycle',
    /* 一批，不是一条：object_id 是单条词的键，这次决定的对象是「这一批」。
       与前两条同一条理由 —— 随便挑一条词的 id 会让审计读成「只改了那一条」。 */
    objectId: () => null,
    /* 前值会是整张 keyword_lifecycle（被选中那些词各自的原状态）。批量给 null，
       与 `amzn_keyword_lifecycle_batch` / `amzn_keyword_ownership_batch` 一致。 */
    readBefore: () => null,
    impact: a => ({
      to: a?.to ?? null,
      marketplace: a?.marketplace ?? null,
      selection: Array.isArray(a?.keywords) ? `keywords:${a.keywords.length}` : (a?.filter ? 'filter' : null),
      keywords: Array.isArray(a?.keywords) ? a.keywords.length : 0,
      filter: a?.filter ?? null,
      dryRun: a?.dryRun === true,
    }),
    /* 预览（dryRun）一行都没写 —— 审计记一条「写」就是撒谎。 */
    skip: a => a?.dryRun === true,
    reason: a => a?.reason ?? null,
  },

  /* v69 — 产品线归属。一条读（显式 null）+ 一条写。
     写：批量裁决归属（含撤销）。对象类型是 `keyword_product_line`（v69 新增到
     AUDIT_OBJECT_TYPES），与生命周期的 `keyword_lifecycle` 分开 —— 归属与流转是两个问题。 */
  'amzn_keyword_product_line_get': null,
  'amzn_keyword_product_line_batch_set': {
    action: ACTIONS.keywordProductLineBatchSet,
    objectType: 'keyword_product_line',
    /* 一批：object_id 是单条词的键，这次决定的对象是「这一批」。 */
    objectId: () => null,
    readBefore: () => null,
    impact: a => ({
      to: a?.to ?? null,
      revoke: a?.revoke === true,
      marketplace: a?.marketplace ?? null,
      selection: Array.isArray(a?.keywords) ? `keywords:${a.keywords.length}` : (a?.filter ? 'filter' : null),
      filter: a?.filter ?? null,
      dryRun: a?.dryRun === true,
    }),
    skip: a => a?.dryRun === true,
    reason: a => a?.reason ?? null,
  },

  /* 模块 08 F08-04。两条读、三条写。
     两条读显式登记为 `null`：`null` 在这里是「看过并且它不是数据库写入」，漏登记与
     登记成只读在守卫眼里一样，但后者是**说过**的。 */
  'amzn_keyword_ownership_list': null,
  'amzn_keyword_ownership_preview': null,   // 影响预览：dryRun 不写库

  'amzn_keyword_ownership_batch': {
    action: ACTIONS.keywordOwnershipBatch,
    objectType: 'keyword_ownership',
    /* 一批，不是一条：一次批量操作可以动很多词，而 object_id 是单条主张的键。给 null
       而不是随便挑一条 —— 这个动作的对象是「这次批量」，不是其中某一个词。 */
    objectId: () => null,
    /* 前值会是整张 keyword_ownership（被点名的词各自的当前主人与冲突），与
       `amzn_keyword_lifecycle_batch` 的批量判断同一条理由。 */
    readBefore: () => null,
    impact: a => ({
      action: a?.action ?? null,
      marketplace: a?.marketplace ?? null,
      asin: a?.asin ?? null,
      keywords: Array.isArray(a?.keywords) ? a.keywords.length : 0,
      confirmed: a?.confirmed === true,
    }),
    reason: a => a?.reason ?? null,
  },

  'amzn_keyword_ownership_suggest': {
    action: ACTIONS.keywordOwnershipSuggest,
    objectType: 'keyword_ownership_suggestion',
    /* 建议表的主键是 (keyword, marketplace)，所以 id 也带上站点 —— 与生命周期那条同一
       口径：不同站点同拼写不是同一个业务词。 */
    objectId: a => (a?.keyword === undefined || a?.keyword === null
      ? null
      : `${String(a.keyword).toLowerCase()}@${String(a.marketplace ?? '').toUpperCase()}`),
    /* 前值是这条词当前的建议（可能为空）。「改之前建议的是什么」正是这一行要能回答的。 */
    readBefore: (deps, a) => readOwnershipSuggestion(deps.store, a?.keyword, a?.marketplace),
    impact: a => ({ suggestedAsin: a?.suggestedAsin ?? null, marketplace: a?.marketplace ?? null }),
    reason: a => a?.reason ?? null,
  },

  'amzn_keyword_ownership_resolve': {
    action: ACTIONS.keywordOwnershipResolve,
    objectType: 'keyword_ownership',
    /* 对象是「这条词在**这个站点**的主人」。所以 id 是 (keyword, marketplace)，与 set 那条
       同一个理由。 */
    objectId: a => (a?.keyword === undefined || a?.keyword === null
      ? null
      : `${String(a.keyword).toLowerCase()}@${String(a.marketplace ?? '').toUpperCase()}`),
    /* 前值是这条词当前的工作台行：谁在认领、是否冲突。采纳前后都要读得到「原来是什么样」。 */
    readBefore: (deps, a) => readKeywordOwnership(deps.store, a?.keyword, a?.marketplace),
    impact: a => ({ asin: a?.asin ?? null, marketplace: a?.marketplace ?? null }),
    reason: a => a?.reason ?? null,
  },

  /* 模块 08 F08-05。四条读、一条写。
     四条读显式登记为 `null`：`null` 在这里是「看过并且它不是数据库写入」，漏登记与
     登记成只读在守卫眼里一样，但后者是**说过**的。`propose` 尤其要显式 null —— 它
     从 kw_master 推导一份提案却**不写库**，漏登记会让人以为它写。 */
  'amzn_keyword_plan_list': null,
  'amzn_keyword_plan_get': null,
  'amzn_keyword_plan_propose': null,   // 提案：只读推导，dryRun 语义
  'amzn_keyword_plan_coverage': null,  // 覆盖统计：只读

  /* 模块 08 F08-08 — 关键词详情。**只读**：它把七个 §8.2 项从事实表与三张 08 侧表
     读成一个对象，一行都不写。显式登记为 null（`null` 在这里是「看过并且它不是数据库
     写入」，漏登记与登记成只读在守卫眼里一样，但后者是**说过**的）。 */
  'amzn_keyword_detail': null,

  'amzn_keyword_plan_save': {
    action: ACTIONS.keywordPlanSave,
    objectType: 'keyword_plan',
    /* 对象是「这一版计划」。新建时 id 只在返回值里（`plan.id`），改版时调用方给了
       lineageId 而不是 planId —— 所以 id 从**结果**里取，与其它「创建型」描述符同一条
       规则（见 objectId 上的说明）。 */
    objectId: (_a, value) => value?.plan?.id ?? null,
    /* 前值：改版时是被改的那一族的最新一版；新建时没有前值（null）。lineageId 缺省
       就是新建，所以这里对 null 是诚实的「没有前值」，不是「读失败」。 */
    readBefore: (deps, a) => {
      const lineage = a?.lineageId === undefined || a?.lineageId === null ? null : String(a.lineageId).trim()
      if (lineage === null || lineage === '') return null
      const latest = deps.store.get(
        'SELECT id FROM keyword_plan WHERE lineage_id = ? ORDER BY version DESC LIMIT 1',
        [lineage],
      )
      if (latest === undefined || latest === null) return null
      return readKeywordPlan(deps.store, { planId: latest.id })
    },
    impact: a => ({
      asin: a?.asin ?? null,
      marketplace: a?.marketplace ?? null,
      entries: Array.isArray(a?.entries) ? a.entries.length : 0,
      lineageId: a?.lineageId ?? null,
    }),
    reason: a => a?.reason ?? null,
  },

  /* ── 模块 04 第二子批：采集中心 ──────────────────────────────────────────────
     五条读显式登记为 `null`：`null` 在这里是「看过并且它不是数据库写入」，漏登记与登记成
     只读在守卫眼里一样，但后者是**说过**的。体检两条**不是** null —— 每一次体检都会往
     `collection_env_check` 写一轮，把它写成只读会让「每一条写都留痕」这句话变成假的。 */
  'amzn_collect_preview': null,
  'amzn_collect_detail': null,
  'amzn_collect_scheme_list': null,
  'amzn_collect_plan_list': null,

  'amzn_collect_env_check': {
    action: ACTIONS.collectionEnvCheck,
    objectType: 'collection_env_check',
    /* 体检挂到任务上时对象就是那个任务（人问的是「这个任务为什么没过」），独立体检则
       没有任务可归属，于是用这一轮的时刻当对象 id —— 给 null 会让这一行说不出是哪一轮。 */
    objectId: (_a, value) => value?.taskId ?? value?.checkedAt ?? null,
    /* 前值是一轮体检的**结果摘要**，不是某一行：一轮十项、每项一行，挑一行当「前值」会
       让读的人以为这一行就是全部。所以读的是最近一轮的摘要（`latestEnvChecks`）。 */
    readBefore: deps => readLatestEnvSummary(deps.store, null),
    impact: a => ({ repair: a?.repair === true, checks: Array.isArray(a?.checks) ? a.checks.length : 10 }),
  },

  'amzn_collect_repair': {
    action: ACTIONS.collectionEnvCheck,
    /* 对象是**这次修复**。它没有自己的表：修复动作改的是环境（目录、端口、站点上下文），
       而这一批里描述「环境」的唯一已声明对象类型是体检明细 —— 修复结束时会重写一轮体检。
       所以 objectType 用 `collection_env_check`，object_id 是动作名：读的人要回答的是
       「谁在哪一刻修了哪一项」，动作名才是那个答案。 */
    objectType: 'collection_env_check',
    objectId: (_a, value) => value?.action ?? null,
    readBefore: deps => readLatestEnvSummary(deps.store, null),
    impact: a => ({ marketplace: a?.marketplace ?? null, confirm: a?.confirm === true }),
    skip: a => a?.confirm !== true && String(a?.action ?? '') === 'launch_browser',
  },

  'amzn_collect_run': {    action: ACTIONS.collectionRun,
    objectType: 'collection_task',
    /* A create: the id is minted by the store and rides on the result. */
    objectId: (_a, value) => value?.taskId ?? null,
    readBefore: () => null,
    impact: a => ({
      targets: Array.isArray(a?.targets) ? a.targets.length : (Array.isArray(a?.asins) ? a.asins.length : 0),
      draft: a?.draft === true,
      sourceContextId: a?.sourceContextId ?? null,
    }),
    reason: a => a?.reason ?? null,
  },

  'amzn_collect_cancel': {
    action: ACTIONS.collectionCancel,
    objectType: 'collection_task',
    objectId: a => a?.taskId ?? null,
    /* 前值是任务在取消之前的样子：「它当时是什么状态」正是这一行要回答的 —— 一个
       queued 任务的取消与一个 running 任务的中止请求是两件事。 */
    readBefore: (deps, a) => readCollectionTask(deps.store, a?.taskId),
    reason: a => a?.reason ?? null,
  },

  'amzn_collect_waiting_resolve': {
    action: ACTIONS.collectionWaiting,
    objectType: 'collection_task',
    objectId: a => a?.taskId ?? null,
    readBefore: (deps, a) => readCollectionTask(deps.store, a?.taskId),
    impact: a => ({ action: a?.action ?? null }),
    reason: a => a?.reason ?? null,
  },

  'amzn_collect_scheme_save': {
    action: ACTIONS.collectionSchemeSave,
    objectType: 'collection_scheme',
    /* 对象是「这一版方案」，所以 id 带上版本 —— 只写 id 会让 v1 与 v2 共用同一个
       object_id，而这一整张表存在的理由就是版本是身份的一部分。 */
    objectId: (_a, value) => (value?.scheme === undefined || value?.scheme === null
      ? null
      : `${value.scheme.id}@${value.scheme.version}`),
    /* 新建时没有前值；原地改草稿时前值就是那一版。 */
    readBefore: (deps, a) => readCollectionScheme(deps.store, a?.id, a?.baseVersion),
    impact: a => ({ sections: Array.isArray(a?.sections) ? a.sections.length : null, baseVersion: a?.baseVersion ?? null }),
  },

  'amzn_collect_scheme_transition': {
    action: ACTIONS.collectionSchemeTransition,
    objectType: 'collection_scheme',
    objectId: a => (a?.id === undefined || a?.id === null ? null : `${a.id}@${a.version ?? ''}`),
    readBefore: (deps, a) => readCollectionScheme(deps.store, a?.id, a?.version),
    impact: a => ({ action: a?.action ?? null, confirm: a?.confirm === true }),
    reason: a => a?.reason ?? null,
  },

  'amzn_collect_plan_save': {
    action: ACTIONS.collectionPlanSave,
    objectType: 'collection_plan',
    /* A create: the id is either given (an update) or minted (a create) and rides
       on the result either way. */
    objectId: (a, value) => a?.id ?? value?.plan?.id ?? null,
    readBefore: (deps, a) => readCollectionPlan(deps.store, a?.id),
    impact: a => ({
      enabled: a?.enabled === true,
      marketplace: a?.marketplace ?? null,
      targets: Array.isArray(a?.targets) ? a.targets.length : 0,
    }),
    reason: a => a?.reason ?? null,
  },
}

/* ── funnel ②: the page's write routes ────────────────────────────────────────
   Keys are every `route === '<name>' && req.method === 'POST'` in
   `src/web/routes.js`. `readBefore(store, body)` — the body is what the page
   sent, and the route bodies read the same way (see `setting-set` at
   src/web/routes.js:273, which already computes `before` by hand).

   The routes cannot be wrapped the way the tools are: their bodies are inline,
   with validation, the write and the reply interleaved, so there is no single
   callback to hand over. Instead each route calls `pageWrite` itself — once
   before the write (which reads the old value) and once after it (which
   records). The wiring guard in `tests/s1b12-audit.mjs` reads this file's
   sibling for `pageWrite(` inside every non-null route's block, so a route
   added without its funnel call turns the suite red rather than going silently
   unaudited.

   `objectId(body, result)` — same second argument as funnel ①, for the same
   reason: a route that creates a row (a shop, a brand, a workspace) has no id
   in the body, and the created row is in the result. */

/**
 * Why this write happened, as one string for the audit row.
 *
 * Two sources, and both are kept rather than one winning:
 *
 *   - `target.reason(args)` — what the caller said. That is the only place
 *     "why did you change this" is ever expressed.
 *   - `beforeNote` — set only when `readBefore` threw. It says the *before*
 *     value is unknown, which is a different fact and must not be lost behind
 *     the caller's sentence.
 *
 * It lives here, beside the descriptor tables, because **both funnels** need
 * it — the tool wrapper in `src/tools/index.js` and `pageWrite` in
 * `src/web/routes.js` — and two copies of this rule is how the two would come
 * to describe the same write differently.
 *
 * It exists at all because `reason` was, for one commit, a descriptor field read
 * by nobody: declared here, and the funnel passed `beforeNote` alone. A
 * parameter the code accepts and drops is worse than no parameter — it reads as
 * a feature.
 */
export function composeReason(target, args, beforeNote) {
  const parts = []
  const stated = typeof target?.reason === 'function' ? target.reason(args) : null
  if (stated !== null && stated !== undefined && String(stated).trim() !== '') {
    parts.push(String(stated).trim())
  }
  if (beforeNote !== null && beforeNote !== undefined) parts.push(String(beforeNote))
  return parts.length === 0 ? null : parts.join('；')
}

export const PAGE_WRITE_TARGETS = {
  /* ── POSTs that write nothing ─────────────────────────────────────────── */
  'context': null,             // 纯 UI 状态：选中/范围/筛选，写的是内存里的工作台上下文
  'prompt-preview': null,      // 渲染预览，不落库
  'product-line-preview': null, // 影响预览，不落库
  /* 通知的已读与清理（S1-B16）。它们**确实**改库，但仍然不是业务写：动的是这份
     提醒列表自己，不是任何一条业务数据。审计回答的是「谁改了什么」，把「谁点了
     已读」记进去，只会让真正重要的改动更难被找到。
     这是设计文档 §4.1 表的原始决定（'notification': null），此处分列三条而不是
     合成一个名字。 */
  'notification-read': null,
  'notification-read-all': null,
  'notification-clear': null,
  /* 收藏与最近访问（S1-B20）。它们落库（`setting` 表里的两条 JSON），但仍然
     不是业务写：改的是这个人的界面状态 —— 和 `context` 同类，只是需要跨重启
     保留。审计回答「谁改了什么」，把「谁点了收藏」记进去只会让真正重要的改动
     更难被找到。 */
  'pin-toggle': null,
  'recent-push': null,

  /* ── writes ───────────────────────────────────────────────────────────── */
  /* T70 评论分析触发器（lead 裁决 #1 的那条 POST）：写 run 行 + 标注行 —— 业务写，
     进审计。objectId 取入参 asin（分析对象）。 */
  'review-analysis-run': {
    action: ACTIONS.reviewAnalysisRun,
    objectType: 'review_analysis_run',
    objectId: b => String(b?.asin ?? '').trim().toUpperCase() || null,
    readBefore: null,
  },
  /* F05-01 的两条保存视图路由。action 与 objectType **逐字照抄**上面 WRITE_TARGETS 里
     `amzn_asin_view_save` / `amzn_asin_view_delete` 的条目 —— 页面点一次与会话调一次，
     在审计里必须是同一条（`s1b12-audit.mjs` 逐对比较这两个表）。 */
  'asin-view-save': {
    action: ACTIONS.asinViewSave,
    objectType: 'asin_saved_view',
    objectId: b => String(b?.name ?? '').trim() || null,
    readBefore: (store, b) => readAsinSavedView(store, b?.name),
  },
  'asin-view-delete': {
    action: ACTIONS.asinViewDelete,
    objectType: 'asin_saved_view',
    objectId: b => String(b?.name ?? '').trim() || null,
    readBefore: (store, b) => readAsinSavedView(store, b?.name),
  },
  /* B-05c / F05-05 —— 页面的两条导入路由。
     ① `asin-import-preview` 是 **POST 但写 0 行**（与 `context` 同一类）：它跑的是
        `buildAsinImportPlan`，一行都不写库，所以描述符是 null，而且**不许调
        `pageWrite(`** —— tests/s1b12-audit.mjs 两个方向都会抓（写了却不说、说了却没写）。
     ② `asin-import` 是写：action / objectType 与 `amzn_asin_import` **同一对字符串**，
        页面点一次和会话调一次在审计里必须是同一条。 */
  'asin-import-preview': null,
  'asin-import': {
    action: ACTIONS.asinImport,
    objectType: 'asin',
    objectId: () => null,
    readBefore: () => null,
  },
  /* F14-01 —— 报告库的两条页面写路由。action / objectType **逐字照抄**上面
     `amzn_report_build` / `amzn_report_update` 的描述符：页面点一次与会话调一次，
     在审计里必须是同一条（`s1b12-audit.mjs` 逐对比较这两个表）。
     `report-build` 的页面路由没有 dryRun 分支（按钮就是「生成」），所以这里不需要
     `skip`；工具侧有，两处都登记才不会一个跳过、一个记一行。 */
  'report-build': {
    action: ACTIONS.reportBuild,
    objectType: 'report',
    objectId: (b, r) => r?.report?.id ?? null,
    readBefore: () => null,
  },
  'report-update': {
    action: ACTIONS.reportUpdate,
    objectType: 'report',
    objectId: b => String(b?.id ?? '').trim() || null,
    readBefore: (store, b) => getReport(store, b?.id),
  },
  'kw-source': {
    action: ACTIONS.kwSourceToggle,
    objectType: 'kw_import',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getImport(store, b?.id),
  },
  /* 关键词数据源目录：改根目录的两个入口（手输 / 对话框）写的是同一个设置项，
     所以按 setting.set 审计，objectId 固定成那个 key。
     `mkdir` 只在磁盘上建空目录、`open` 只调资源管理器 —— 两者都不动数据库，
     显式登记成 null，而不是漏登记（漏登记与"决定过它不是写"是两件事）。 */
  'kw-source-dir-set': {
    action: ACTIONS.settingSet,
    objectType: 'setting',
    objectId: () => 'kw.sourceDir',
    readBefore: store => getSetting(store, 'kw.sourceDir'),
  },
  'kw-source-dir-pick': {
    action: ACTIONS.settingSet,
    objectType: 'setting',
    objectId: () => 'kw.sourceDir',
    readBefore: store => getSetting(store, 'kw.sourceDir'),
  },
  'kw-source-dir-mkdir': null,
  'kw-source-dir-open': null,
  /* 整目录导入：写的是关键词事实表，与 amzn_kw_import 是同一个动作，
     所以用同一条 action；objectId 同样是 null（import id 由这次调用生成，
     一次导入多个文件本来就没有单一的 id）。 */
  'kw-source-dir-import': {
    action: ACTIONS.kwImportCreate,
    objectType: 'kw_import',
    objectId: () => null,
    readBefore: () => null,
  },
  'rule-toggle': {
    action: ACTIONS.ruleToggle,
    objectType: 'rule',
    objectId: b => b?.ruleId ?? null,
    readBefore: (store, b) => readRule(store, b?.ruleId),
  },
  'policy-link': {
    action: ACTIONS.policyLink,
    objectType: 'policy',
    objectId: b => b?.policyId ?? null,
    readBefore: (store, b) => getPolicy(store, b?.policyId),
  },
  /* S2-T72 —— 三个 POST 都写库，必须进审计漏斗。前值：
       · 检索：新建 run，没有前值；
       · 确认/驳回：候选行的前状态（candidate）与前后值，审计回答「谁把哪条候选
         从待确认改成了什么」。 */
  'policy-check-start': {
    action: ACTIONS.policyCheckStart,
    objectType: 'policy',
    objectId: (_b, r) => r?.runId ?? null,
    readBefore: () => null,
  },
  'policy-candidate-confirm': {
    action: ACTIONS.policyCandidateConfirm,
    objectType: 'policy',
    objectId: b => b?.candidateId ?? null,
    readBefore: (store, b) => getCandidate(store, b?.candidateId),
  },
  'policy-candidate-reject': {
    action: ACTIONS.policyCandidateReject,
    objectType: 'policy',
    objectId: b => b?.candidateId ?? null,
    readBefore: (store, b) => getCandidate(store, b?.candidateId),
  },
  'prompt-save': {
    action: ACTIONS.promptSave,
    objectType: 'prompt',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getPrompt(store, b?.id),
  },
  /* action 与 objectType **逐字照抄**上面 WRITE_TARGETS 里 `amzn_prompt_rollback`
     的条目 —— 页面点一次和会话调一次，在审计里必须是同一条。 */
  'prompt-rollback': {
    action: ACTIONS.promptRollback,
    objectType: 'prompt',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getPrompt(store, b?.id),
  },
  /* B-11.3 / F11-05 — action 与 objectType **逐字照抄**上面 WRITE_TARGETS 里对应的
     工具条目（页面点一次和会话调一次，在审计里必须是同一条）。前值读的是**生命周期
     视图**「状态 + 活动版本」而非正文：这三个动作改的是状态，审计要回答的正是
     「动之前它是什么状态、活动版本是哪个」。 */
  'prompt-lifecycle': {
    action: ACTIONS.promptLifecycle,
    objectType: 'prompt',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => promptLifecycleView(store, b?.id),
  },
  'prompt-version-activate': {
    action: ACTIONS.promptActivate,
    objectType: 'prompt',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => promptLifecycleView(store, b?.id),
  },
  'prompt-version-rollback': {
    action: ACTIONS.promptVersionRollback,
    objectType: 'prompt',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => promptLifecycleView(store, b?.id),
  },
  'competitor-set': {
    action: ACTIONS.competitorSetSave,
    objectType: 'competitor_set',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getCompetitorSet(store, b?.id),
  },
  /* 自动发现竞品：写的是 asin_competitor 行（suggested 或 active）。
     对象 id 用父 ASIN —— 一次发现影响的是「这个产品的竞品表」。 */
  'competitor-discover': {
    action: 'asin_competitor.discover',
    objectType: 'asin_competitor',
    objectId: b => (b?.asin === undefined ? null : String(b.asin).toUpperCase()),
    readBefore: () => null,
  },
      /* 停用竞品关系：标记 inactive，不删。 */
      /* 产品表导入：scan / preview 是读，不记审计；只有 commit 写库。 */
      /* 打开目录：不是数据库写入，不记审计。 */
      'product-open-dir': {
        action: 'product_dir.open',
        objectType: 'setting',
        objectId: () => 'asin.sourceDir',
        readBefore: () => null,
        skip: () => true,
      },
      'product-import': {
        action: 'product_profile.import',
        objectType: 'product_profile',
        objectId: b => (b?.path === undefined ? null : String(b.path)),
        readBefore: () => null,
        skip: a => (a?.action ?? 'scan') !== 'commit',
      },
      'competitor-retire': {
        action: 'asin_competitor.retire',
        objectType: 'asin_competitor',
        objectId: b => (b?.parentAsin === undefined ? null : String(b.parentAsin).toUpperCase()),
        readBefore: () => null,
      },
  'setting-set': {
    action: ACTIONS.settingSet,
    objectType: 'setting',
    objectId: b => b?.key ?? null,
    readBefore: (store, b) => getSetting(store, b?.key),
    /* Same as the tool's: a body that carries a note gets it recorded as the
       reason. The page does not send one today, but the route accepts it, and a
       route that accepts a field and drops it is the shape being fixed here. */
    reason: b => b?.note ?? null,
  },
  /* 模块 12 的门禁裁决。与工具 `amzn_agent_gate_decide` 是**同一件事**，所以共用
     `ACTIONS.agentGateDecide` —— 页面批一次和会话批一次，在审计里必须是同一条。 */
  'agent-gate': {
    action: ACTIONS.agentGateDecide,
    objectType: 'agent_gate',
    objectId: b => b?.gate ?? null,
    readBefore: (store, b) => readAgentRun(store, b?.runId),
    impact: b => ({ runId: b?.runId ?? null, approve: b?.approve === true }),
  },
  /* 模块 12 的草案级裁决。与工具 `amzn_agent_artifact_decide` 是**同一件事**，所以共用
     `ACTIONS.agentArtifactDecide` —— 页面点一次和会话调一次，在审计里必须是同一条。
     `impact` 故意不写：`pageWrite` 不把它交给 `recordAudit`（只有工具漏斗传），写一个
     没人读的字段比不写更糟（与模块 14 / 模块 08 的页面写条目同一条规则）。 */
  'agent-artifact': {
    action: ACTIONS.agentArtifactDecide,
    objectType: 'agent_artifact',
    objectId: b => b?.artifactId ?? null,
    readBefore: (store, b) => readAgentArtifact(store, b?.artifactId),
    reason: b => b?.note ?? null,
  },
  /* 模块 12 F12-06 / F12-09 的两条运行入口。
     `agent-run`（取消 / 修复后继续）与工具 `amzn_agent_run_finish` 是**同一件事**，所以
     共用 `ACTIONS.agentRunFinish`；`agent-run-supersede` 与 `amzn_agent_run_start` 同源，
     共用 `ACTIONS.agentRunStart`。页面点一次和会话调一次，在审计里必须是同一条 ——
     两条各写一个 action 会让「谁把这条运行推走了」有两个答案。
     ⚠️ `agent-run` 的 `reason` 只在 `retry` 时有值（§9 的「修复后重试」是一次人工断言，
     必须说清修了什么）；`cancel` 没有理由可写，那就是 `null` —— **不是空串**。
     ⚠️ `agent-run-supersede` 是 create，`readBefore` 为 `null`（没有前值可读，与
     `amzn_agent_run_start` 同一个判断），`objectId` 取新建运行自己的 id。 */
  'agent-run': {
    action: ACTIONS.agentRunFinish,
    objectType: 'agent_run',
    objectId: b => b?.runId ?? null,
    readBefore: (store, b) => readAgentRun(store, b?.runId),
    reason: b => b?.reason ?? null,
  },
  'agent-run-supersede': {
    action: ACTIONS.agentRunStart,
    objectType: 'agent_run',
    objectId: (b, r) => r?.runId ?? null,
    readBefore: () => null,
  },
  'source-save': {
    action: ACTIONS.sourceSave,
    objectType: 'source',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => readSource(store, b?.id),
  },
  /* ── F-7 第一块：优化页的「开跑」 ─────────────────────────────────────────
     这一条与 `WRITE_TARGETS['amzn_optimize_prepare']` 是**同一个动作名**
     （`ACTIONS.optimizePrepare`）：从页面上点按钮和从对话里调工具是同一次「建一轮
     优化运行」。两条分开登记是因为两个漏斗各查各的表（工具查 WRITE_TARGETS、页面
     查 PAGE_WRITE_TARGETS），但动作名只有一个 —— 于是「这个 ASIN 被谁开跑过」在
     审计里是一件事，不是两件。

     前值：**这一轮在调用前不存在**（`readBefore: () => null`），与
     `amzn_optimize_prepare` 的描述符同一个理由 —— 那不是「没读」，是「还没有」。

     `skip`：`dryRun` 只返回数据包、不建 run 行；页面路由照原样把 body 交给工具，
     所以这条 skip 与工具侧那条是同一句话（`tools/optimize.js` 的
     `if (args?.dryRun !== true)` 才写 run）。 */
  'optimize-prepare': {
    action: ACTIONS.optimizePrepare,
    objectType: 'optimization_run',
    /* 新 run 的 id 由这次调用生成、只出现在回复里（与工具那条同款），所以读回复。 */
    objectId: (b, r) => r?.runId ?? null,
    readBefore: () => null,
    skip: b => b?.dryRun === true,
  },
  /* ── B-13b / F13-01：草案收件箱的五个页面写动作 ─────────────────────────────
     前值一律读 store 自己的 reader（`listOptimizationDrafts` 是 optimization_draft
     的唯一读取口），不在描述符里写第二份查询。
     五个动作分开登记，与 `ACTIONS` 里那五条一一对应：作废 / 恢复 / 押后 / 取消押后是
     四个不同的状态事实，「基于此草案重新优化」建的是**一轮新运行**，所以它的 objectType
     是 optimization_run 而不是 optimization_draft。
     `impact` 故意不写：`pageWrite` 不把它交给 `recordAudit`（只有工具漏斗传），
     写一个没人读的字段比不写更糟 —— 与模块 14 / 模块 08 的页面写条目同一条规则。 */
  'optimize-draft-void': {
    action: ACTIONS.optimizeDraftVoid,
    objectType: 'optimization_draft',
    objectId: b => b?.runId ?? null,
    readBefore: (store, b) => readOptimizationDraft(store, b?.runId, b?.field),
    reason: b => b?.reason ?? null,
  },
  'optimize-draft-restore': {
    action: ACTIONS.optimizeDraftRestore,
    objectType: 'optimization_draft',
    objectId: b => b?.runId ?? null,
    readBefore: (store, b) => readOptimizationDraft(store, b?.runId, b?.field),
    reason: b => b?.reason ?? null,
  },
  'optimize-draft-defer': {
    action: ACTIONS.optimizeDraftDefer,
    objectType: 'optimization_draft',
    objectId: b => b?.runId ?? null,
    readBefore: (store, b) => readOptimizationDraft(store, b?.runId, b?.field),
    reason: b => b?.reason ?? null,
  },
  'optimize-draft-resume': {
    action: ACTIONS.optimizeDraftResume,
    objectType: 'optimization_draft',
    objectId: b => b?.runId ?? null,
    readBefore: (store, b) => readOptimizationDraft(store, b?.runId, b?.field),
    reason: b => b?.reason ?? null,
  },
  'optimize-draft-reoptimize': {
    action: ACTIONS.optimizeRunReoptimize,
    objectType: 'optimization_run',
    /* 新 run 的 id 由这次调用生成、只出现在回复里（与 `amzn_optimize_prepare`
       同款），所以读回复；父轮 id 在 body 里。 */
    objectId: (b, r) => r?.runId ?? b?.runId ?? null,
    readBefore: (store, b) => getOptimizationRun(store, b?.runId),
    reason: b => b?.reason ?? null,
  },
  /* ── B-13c / F13-05 · F13-06：策略确认与位置计划裁决 ────────────────────────
     前值一律读领域模块自己的 reader（`readStrategyRow` / `readPlanCheckRow`）——
     与工具、页面用的是同一个 SELECT，不在描述符里写第二份查询。
     两条的 objectType 都是 optimization_run：被裁决的是**这一轮的**策略与计划核对，
     策略行 / 核对行本身没有独立于轮次的身份（run_id 就是主键）。
     `impact` 故意不写：`pageWrite` 不把它交给 `recordAudit`（只有工具漏斗传），
     写一个没人读的字段比不写更糟 —— 与 B-13b 那五条同一条规则。 */
  'optimize-strategy-confirm': {
    action: ACTIONS.optimizeStrategyConfirm,
    objectType: 'optimization_run',
    objectId: b => b?.runId ?? null,
    readBefore: (store, b) => readStrategyRow(store, b?.runId),
  },
  'optimize-plan-decide': {
    action: ACTIONS.optimizePlanDecide,
    objectType: 'optimization_run',
    objectId: b => b?.runId ?? null,
    readBefore: (store, b) => readPlanCheckRow(store, b?.runId),
    /* 裁决本身是「采纳」还是「不采纳」—— 这是这条审计行最要紧的一个词，所以记进
       `reason`，而不是留给读的人去比对前后值猜。 */
    reason: b => (b?.decision === undefined || b?.decision === null ? null : `decision=${String(b.decision)}`),
  },
  /* ── B-13d / F13-08：Agent 审阅的页面写路由 ─────────────────────────────────
     与工具 `amzn_optimize_review` **共用同一个 action**：页面点一次与会话调一次
     在审计里必须是同一条（否则「谁记了这条结论」会有两个答案）。
     前值读的是**这一项这一字段**的结论行（与工具那条描述符同一个 reader）——
     读整轮的全部结论会把别人写的结论算成这次改动的前值。
     一次调用可以记多条，所以「记的是哪几项、什么结论」进 `reason`。 */
  'optimize-review-record': {
    action: ACTIONS.optimizeReviewRecord,
    objectType: 'optimization_run',
    objectId: b => b?.runId ?? null,
    readBefore: (store, b) => readReviewRow(store, b?.runId, b?.itemId, b?.field ?? ''),
    reason: b => (b?.itemId === undefined || b?.itemId === null
      ? null
      : `${String(b.itemId)}${b?.field ? `@${String(b.field)}` : ''}=${String(b?.conclusion ?? '?')}`),
  },
  'product-line-save': {
    action: ACTIONS.productLineUpdate,
    objectType: 'product_line',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => readProductLine(store, b?.id),
  },
  /* R-91 —— 字段模板的四条页面写路径。动作与 objectType 逐字照抄工具条目
     （`amzn_field_template_{save,propose,confirm,rollback}`），所以「谁把字段清单改成这样」
     在审计里只有一种答案，不因为改的人用的是页面还是会话而分成两条。 */
  'field-template-research': {
    action: ACTIONS.fieldTemplatePropose,
    objectType: 'field_template',
    objectId: () => 'listing-optimize',
    readBefore: store => readFieldTemplate({ store }),
  },
  'field-template-confirm': {
    action: ACTIONS.fieldTemplateConfirm,
    objectType: 'field_template',
    objectId: () => 'listing-optimize',
    readBefore: store => readFieldTemplate({ store }),
  },
  'field-template-rollback': {
    action: ACTIONS.fieldTemplateRollback,
    objectType: 'field_template',
    objectId: () => 'listing-optimize',
    readBefore: store => readFieldTemplate({ store }),
  },
  /* R-95：页面填属性与 amzn_asin_attribute_set 是同一次动作 —— action 必须一模一样，
         否则审计里同一个事实会长出两种写法（B05T-③ 守的就是这条）。 */
  'asin-attribute-save': {
    action: ACTIONS.asinAttributeSet,
    objectType: 'asin',
    objectId: a => `${String(a?.asin ?? '').trim().toUpperCase()}@${String(a?.marketplace ?? 'US').trim().toUpperCase()}`,
    readBefore: (store, a) => {
      const asin = String(a?.asin ?? '').trim().toUpperCase()
      const marketplace = String(a?.marketplace ?? 'US').trim().toUpperCase()
      const row = store.get('SELECT attributes_json FROM listing WHERE asin = ? AND marketplace = ?', [asin, marketplace])
      if (row === null || row === undefined) return null
      return { attributes: row.attributes_json === null || row.attributes_json === undefined ? null : JSON.parse(row.attributes_json) }
    },
  },
  'field-template-save': {
    action: ACTIONS.fieldTemplateSave,
    objectType: 'field_template',
    objectId: () => 'listing-optimize',
    readBefore: store => readFieldTemplate({ store }),
  },
  'workspace-save': {
    action: ACTIONS.workspaceUpdate,
    objectType: 'workspace',
    /* Same as `amzn_workspace_upsert`: a create has no id in the body, and the
       reply is `{ ok, action, workspace }`. */
    objectId: (b, r) => b?.id ?? r?.workspace?.id ?? null,
    readBefore: (store, b) => getWorkspace(store, b?.id),
  },
  'site-save': {
    action: 'site_profile.update',
    objectType: 'site_profile',
    objectId: b => b?.marketplace ?? null,
    readBefore: (store, b) => readSiteProfile(store, b?.workspaceId, b?.marketplace),
  },
  'site-verify': {
    action: 'site_verification.record',
    objectType: 'site_verification',
    objectId: b => b?.marketplace ?? null,
    /* A verification is **appended**: this call adds an event, and there is no
       "previous version of the row being written" to read. The site profile is
       not it — recording the profile here would put an unchanged object in
       before and after and the row would describe nothing. `null` is the
       honest before for an append, and the after value is the verification row
       the route just created. */
    readBefore: () => null,
  },
  'shop-save': {
    action: 'shop.update',
    objectType: 'shop',
    /* A create omits `id` and the store mints one; the route's reply carries the
       row, so the audit can name it. An update passes the id in the body. */
    objectId: (b, r) => b?.id ?? r?.shop?.id ?? null,
    readBefore: (store, b) => getShop(store, b?.id),
  },
  'brand-save': {
    action: 'brand.update',
    objectType: 'brand',
    objectId: (b, r) => b?.id ?? r?.brand?.id ?? null,
    readBefore: (store, b) => getBrand(store, b?.id),
  },
  /* v60 归档边界：归档/恢复都是对同一行的软状态写入，审计里必须留下
     「谁、什么时候、从哪一态到哪一态」。 */
  'shop-archive': {
    action: 'shop.archive',
    objectType: 'shop',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getShop(store, b?.id),
  },
  'shop-restore': {
    action: 'shop.restore',
    objectType: 'shop',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getShop(store, b?.id),
  },
  'competitor-batch-add': {
    action: 'asin_competitor.batch_add',
    objectType: 'asin_competitor',
    objectId: b => (b?.parentAsin === undefined ? null : String(b.parentAsin).toUpperCase()),
    readBefore: () => null,
  },
  'ownership': {
    action: 'asin_ownership.record',
    objectType: 'asin_ownership',
    objectId: b => b?.asin ?? null,
    readBefore: (store, b) => readOwnership(store, b?.asin, b?.marketplace),
  },
  'snapshot-archive': {
    action: 'snapshot.archive',
    objectType: 'snapshot',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getSnapshot(store, b?.id),
  },
  'snapshot-delete': {
    action: ACTIONS.snapshotDelete,
    objectType: 'snapshot',
    /* readBefore is the whole reason a refused delete leaves no audit row the
       funnel has to reason about: the old value is read here, and the recorder
       only runs when the route's reply says ok. A `RETENTION_REFERENCED` reply
       is `ok: false`, so the log stays silent on a refusal — a refusal is not a
       change. */
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getSnapshot(store, b?.id),
  },
  'snapshot-restore': {
    action: ACTIONS.snapshotRestore,
    objectType: 'snapshot',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getSnapshot(store, b?.id),
  },
  'dq-issue': {
    action: ACTIONS.dqIssueStatus,
    objectType: 'dq_issue',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getIssue(store, b?.id),
  },
  'conflict-resolve': {
    action: ACTIONS.conflictResolve,
    objectType: 'field_conflict',
    objectId: b => b?.id ?? null,
    readBefore: (store, b) => getConflict(store, b?.id),
  },

  /* 模块 14 §6-§9 的四条页面写路径。action 与 objectType **逐字照抄**上面
     WRITE_TARGETS 里对应的工具描述符 —— 页面点一次和会话调一次，在审计里必须是
     同一条。`impact` 故意不写：`pageWrite` 不把它交给 `recordAudit`（只有工具漏斗
     传），写一个没人读的字段比不写更糟。 */
  'publication-record': {
    action: ACTIONS.publicationRecord,
    objectType: 'publication_record',
    objectId: () => null,
    readBefore: () => null,
    reason: b => b?.note ?? null,
  },
  'baseline-choice': {
    action: ACTIONS.publicationBaselineDecide,
    objectType: 'publication_record',
    objectId: b => b?.publicationId ?? null,
    readBefore: (store, b) => readPublication(store, b?.publicationId),
    reason: b => b?.note ?? null,
  },
  'observation-conclude': {
    action: ACTIONS.observationConclude,
    objectType: 'observation_checkpoint',
    objectId: b => b?.checkpointId ?? null,
    readBefore: (store, b) => readCheckpoint(store, b?.checkpointId),
    reason: b => b?.note ?? null,
  },
  'rollback-suggest': {
    action: ACTIONS.rollbackSuggest,
    objectType: 'rollback_task',
    objectId: () => null,
    readBefore: (store, b) => readPublication(store, b?.publicationId),
    reason: b => b?.reason ?? null,
  },
  /* 模块 08 F08-07 的「改生命周期」。action 与 objectType **逐字照抄**上面
     WRITE_TARGETS 里 `amzn_keyword_lifecycle_set` 的条目 —— 页面点一次和会话调一次，
     在审计里必须是同一条。`impact` 故意不写：`pageWrite` 不把它交给 `recordAudit`。 */
  'keyword-lifecycle': {
    action: ACTIONS.keywordLifecycleSet,
    objectType: 'keyword_lifecycle',
    objectId: b => (b?.keyword === undefined || b?.keyword === null
      ? null
      : `${String(b.keyword).toLowerCase()}@${String(b.marketplace ?? '').toUpperCase()}`),
    readBefore: (store, b) => readKeywordLifecycle(store, b?.keyword, b?.marketplace),
    reason: b => b?.reason ?? null,
  },
  /* 模块 08 F08-07 的「批量改生命周期」（F-5）。action 与 objectType **逐字照抄**上面
     WRITE_TARGETS 里 `amzn_keyword_lifecycle_batch_set` 的条目 —— 页面点一次和会话调一次，
     在审计里必须是同一条。批量给 null 的对象 id，与所有权批量同一条理由：这次决定的对象
     是「这一批」，不是其中某个词。 */
  'keyword-lifecycle-batch': {
    action: ACTIONS.keywordLifecycleBatchSet,
    objectType: 'keyword_lifecycle',
    objectId: () => null,
    readBefore: () => null,
    /* 预览（dryRun）不写库，因此不记审计行 —— pageWrite 的 `skip` 与工具漏斗同一口径。 */
    skip: b => b?.dryRun === true,
    reason: b => b?.reason ?? null,
  },
  /* v69 — 产品线归属的页面写路径。动作与 objectType 逐字照抄工具条目；
     撤销（revoke: true）也走这里，因为它同样是一次人的决定。 */
  'keyword-product-line-batch': {
    action: ACTIONS.keywordProductLineBatchSet,
    objectType: 'keyword_product_line',
    objectId: () => null,
    readBefore: () => null,
    skip: b => b?.dryRun === true,
    reason: b => b?.reason ?? null,
  },
  /* 模块 08 F08-04 的两条页面写路径 + 一条预览。action 与 objectType **逐字照抄**上面
     WRITE_TARGETS 里对应工具的条目 —— 页面点一次和会话调一次，在审计里必须是同一条。
     预览那条是 `null`：它 dryRun，不写库。`impact` 故意不写：`pageWrite` 不把它交给
     `recordAudit`（只有工具漏斗传），写一个没人读的字段比不写更糟。 */
  'keyword-ownership-preview': null,
  'keyword-ownership': {
    action: ACTIONS.keywordOwnershipBatch,
    objectType: 'keyword_ownership',
    objectId: () => null,
    readBefore: () => null,
    reason: b => b?.reason ?? null,
  },
  'keyword-ownership-resolve': {
    action: ACTIONS.keywordOwnershipResolve,
    objectType: 'keyword_ownership',
    objectId: b => (b?.keyword === undefined || b?.keyword === null
      ? null
      : `${String(b.keyword).toLowerCase()}@${String(b.marketplace ?? '').toUpperCase()}`),
    readBefore: (store, b) => readKeywordOwnership(store, b?.keyword, b?.marketplace),
    reason: b => b?.reason ?? null,
  },
  /* 模块 08 F08-05 的「存一版计划」。action 与 objectType **逐字照抄**上面 WRITE_TARGETS
     里 `amzn_keyword_plan_save` 的条目 —— 页面点一次和会话调一次，在审计里必须是同一条。 */
  'keyword-plan': {
    action: ACTIONS.keywordPlanSave,
    objectType: 'keyword_plan',
    objectId: (_b, result) => result?.plan?.id ?? null,
    readBefore: () => null,
    reason: b => b?.reason ?? null,
  },

  /* 模块 04 第二子批的七条采集路由。action 与 objectType **逐字照抄**上面 WRITE_TARGETS
     里对应工具的条目 —— 页面点一次和会话调一次，在审计里必须是同一条。预览那条是
     `null`：它只算不写（不打开浏览器、不建任何行）。 */
  'collect-preview': null,
  'collect-env-check': {
    action: ACTIONS.collectionEnvCheck,
    objectType: 'collection_env_check',
    objectId: (_b, result) => result?.taskId ?? result?.checkedAt ?? null,
    readBefore: store => readLatestEnvSummary(store, null),
  },
  'collect-run': {
    action: ACTIONS.collectionRun,
    objectType: 'collection_task',
    objectId: (_b, result) => result?.taskId ?? null,
    readBefore: () => null,
  },
  'collect-cancel': {
    action: ACTIONS.collectionCancel,
    objectType: 'collection_task',
    objectId: b => b?.taskId ?? null,
    readBefore: (store, b) => readCollectionTask(store, b?.taskId),
    reason: b => b?.reason ?? null,
  },
  'collect-waiting': {
    action: ACTIONS.collectionWaiting,
    objectType: 'collection_task',
    objectId: b => b?.taskId ?? null,
    readBefore: (store, b) => readCollectionTask(store, b?.taskId),
    reason: b => b?.reason ?? null,
  },
  'collect-scheme': {
    action: ACTIONS.collectionSchemeSave,
    objectType: 'collection_scheme',
    /* 两条 op 共用一条路由，所以对象 id 从**结果**里取：save 与 transition 各自回一条
       `{scheme}`，而 request body 里 transition 给的是 id+version、save 可能什么都不给。 */
    objectId: (_b, result) => (result?.scheme === undefined || result?.scheme === null
      ? null
      : `${result.scheme.id}@${result.scheme.version}`),
    readBefore: (store, b) => readCollectionScheme(store, b?.id, b?.version ?? b?.baseVersion),
    reason: b => b?.reason ?? null,
  },
  'collect-plan': {
    action: ACTIONS.collectionPlanSave,
    objectType: 'collection_plan',
    objectId: (b, result) => b?.id ?? result?.plan?.id ?? null,
    readBefore: (store, b) => readCollectionPlan(store, b?.id),
    reason: b => b?.reason ?? null,
  },

  /* 模块 05 第一子批的四条页面写路径。action 与 objectType **逐字照抄**上面
     WRITE_TARGETS 里对应工具的条目 —— 页面点一次和会话调一次，在审计里必须是同一条。
     `impact` 故意不写：`pageWrite` 不把它交给 `recordAudit`（只有工具漏斗传），
     写一个没人读的字段比不写更糟。（影响预览走的是 **GET** `/api/asin-archive-impact`，
     所以它不在这张表里：这张表的键必须与 routes.js 里的 POST 路由逐名相等。） */
  'asin-field-correct': {
    action: ACTIONS.asinFieldCorrect,
    objectType: 'asin',
    objectId: b => `${String(b?.asin ?? '').trim().toUpperCase()}@${String(b?.marketplace ?? 'US').trim().toUpperCase()}`,
    readBefore: (store, b) => readAsinField(store, b?.asin, b?.marketplace ?? 'US', b?.field),
    reason: b => b?.reason ?? null,
  },
  /* FR-M2-05：归属的页面写路径。与上面 `amzn_asin_ownership_set` **同一个 action 与
     objectType**（照这一段开头的规矩），所以「谁把这条改成竞品了」在审计里只有一种答案，
     不会因为改的人用的是页面还是会话而分成两条。 */
  'asin-ownership-set': {
    action: ACTIONS.asinOwnershipSet,
    objectType: 'asin_ownership',
    objectId: b => `${String(b?.asin ?? '').trim().toUpperCase()}@${String(b?.marketplace ?? 'US').trim().toUpperCase()}`
      + `:${String(b?.objectType ?? '').trim()}`,
    readBefore: (store, b) => listOwnership(store, { asin: b?.asin, marketplace: b?.marketplace ?? 'US' })
      .filter(row => row.retracted_at === null && row.object_type === String(b?.objectType ?? '').trim())
      .map(row => row.object_id),
    reason: b => b?.reason ?? null,
  },
  'asin-variant': {
    action: ACTIONS.asinVariantUpsert,
    objectType: 'asin_variant',
    objectId: b => variantKey(b),
    readBefore: (store, b) => readVariant({ store }, b),
    reason: b => b?.evidence ?? null,
  },
  'asin-variant-correct': {
    action: ACTIONS.asinVariantCorrect,
    objectType: 'asin_variant',
    objectId: b => variantKey(b),
    readBefore: (store, b) => readVariant({ store }, b),
    reason: b => b?.reason ?? null,
  },
  'asin-archive': {
    action: ACTIONS.asinArchive,
    objectType: 'asin',
    objectId: b => `${String(b?.asin ?? '').trim().toUpperCase()}@${String(b?.marketplace ?? 'US').trim().toUpperCase()}`,
    /* 归档与恢复是同一条路由（`action` 在 body 里），所以前值就是这一行现在的样子：
       before/after 的差异本身就是方向。 */
    readBefore: (store, b) => getAsin(store, String(b?.asin ?? '').trim().toUpperCase(), String(b?.marketplace ?? 'US').trim().toUpperCase()),
    reason: b => b?.reason ?? null,
    /* ★ 工具侧那条描述符一直有 skip，这里一直没有 —— 差别在于页面走的是**另一条**
       GET 路由（`asin-archive-impact`）做归档预览，所以这条 POST 上从来没出现过 preview。
       现在它会承担 `delete_preview`（页面的删除入口要先看引用检查），
       于是这一条 skip 从「碰巧不需要」变成「必须有」：漏掉它就会在日志里
       留下一条关于没有发生的删除的记录。 */
    skip: b => ['preview', 'delete_preview'].includes(String(b?.action ?? '').trim()),
  },
  /* 页面侧的删除入口。与工具 `amzn_asin_delete` **同一条 action 字符串** ——
     「会话里删的」与「页面上删的」在审计里必须是同一条（`s1b12` 的守卫逐字比对这两张表）。 */
  'asin-delete': {
    action: ACTIONS.asinDelete,
    objectType: 'asin',
    objectId: b => `${String(b?.asin ?? '').trim().toUpperCase()}@${String(b?.marketplace ?? 'US').trim().toUpperCase()}`,
    readBefore: (store, b) => getAsin(store, String(b?.asin ?? '').trim().toUpperCase(), String(b?.marketplace ?? 'US').trim().toUpperCase()),
    reason: b => b?.reason ?? null,
    skip: b => String(b?.action ?? '').trim() === 'delete_preview',
  },
}

/**
 * Look one up without caring which funnel is asking.
 *
 * `undefined` (not `null`) for an unknown name: a tool nobody classified is a
 * bug the guard catches, and the funnel treats "unknown" the same as "not a
 * write" so that an unclassified tool keeps working rather than throwing on
 * every call.
 */
export function writeTargetFor(table, name) {
  return table[name]
}

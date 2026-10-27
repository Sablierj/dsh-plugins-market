/**
 * The plugin's enumerations and state machines, in one place.
 *
 * Every one of these was previously either absent or about to be typed out a
 * second time in whichever module needed it first. A vocabulary that lives in
 * two files is a vocabulary that will disagree with itself: the badge would say
 * `fresh` while the scan wrote `ok`, and nothing would throw — the two would
 * just stop meaning the same thing.
 *
 * This module holds **no logic beyond the state machines**. It is a vocabulary,
 * so a reader can answer "what values can this column take" without opening six
 * files, and so `tests/run.mjs` can assert against the same list the code uses
 * rather than against a copy of it.
 *
 * Naming: the `PROBLEM_CODES` values follow the machine code style the
 * optimizer's validator already ships (`rule-check-missing` is the precedent).
 * They are the machine half of the error contract in ARCHITECTURE §9 — `error`
 * is for the person, `code` is for the branch.
 */

/**
 * The seven data states (上游 §8.2). One vocabulary for badges, the catalogue,
 * lineage, conflicts and quality issues.
 *
 * `unknown` is not a synonym for `missing`: `unknown` means "nobody measured
 * this", `missing` means "we looked and it was not there". Collapsing them
 * would let "we never collected it" read as "Amazon does not publish it".
 */
export const DATA_STATES = ['unknown', 'fresh', 'stale', 'missing', 'failed', 'conflict', 'confirmed']

/** The quality-issue state machine's five states. */
export const DQ_ISSUE_STATUSES = ['open', 'acknowledged', 'fixing', 'resolved', 'accepted_risk']

/**
 * The four legal transitions, and nothing else.
 *
 * `resolved` and `accepted_risk` are terminal on purpose. A "resolved" issue
 * that can slide back to "open" without a new scan is a status nobody can
 * trust, and the way a problem is reopened here is that a re-scan finds it
 * again — a new detection, not a status edit.
 */
export const DQ_ISSUE_TRANSITIONS = {
  open: ['acknowledged', 'resolved', 'accepted_risk'],
  acknowledged: ['fixing', 'resolved', 'accepted_risk'],
  fixing: ['resolved', 'accepted_risk'],
  resolved: [],
  accepted_risk: [],
}

/**
 * Whether one issue status may become another.
 *
 * Returns false rather than throwing: this is a predicate, and the caller that
 * needs to refuse says so in its own words. A transition to the *same* state is
 * not legal either — it is not a transition, it is a no-op, and letting it
 * through would make "the status changed" untestable.
 */
export function canTransition(from, to) {
  const allowed = DQ_ISSUE_TRANSITIONS[from]
  if (allowed === undefined) return false
  return allowed.includes(to)
}

/* ── 模块 08 F08-07：关键词的九态生命周期 ──────────────────────────────────────
   The keyword master library's lifecycle, a second state machine beside the DQ
   one. It is *not* the same machine and it is deliberately not named `canTransition`
   (that one belongs to `dq_issue` and must not change behaviour). */

/**
 * The nine states, **in the order the upstream chain is written** (§22.2):
 *
 *   candidate → active → assigned → used → observing → retained / paused / excluded / archived
 *
 * The order is part of the vocabulary: the page prints the chain in this order,
 * and a test asserts it word for word, so re-ordering the array is a change to
 * what the product says the flow is — not a tidy-up.
 */
export const KEYWORD_LIFECYCLE_STATES = [
  'candidate', 'active', 'assigned', 'used', 'observing', 'retained', 'paused', 'excluded', 'archived',
]

/** Chinese labels, for the page and the tools. Same shape as `SNAPSHOT_TYPE_LABELS`. */
export const KEYWORD_LIFECYCLE_LABELS = {
  candidate: '候选',
  active: '在库',
  assigned: '已分配',
  used: '已使用',
  observing: '观察中',
  retained: '保留',
  paused: '暂停',
  excluded: '已排除',
  archived: '已归档',
}

/**
 * Why a state changed. A closed set, because `source` is read by a human trying
 * to answer "was this decided by a person, by a publication, or by an
 * observation conclusion" — a free-form string would let three spellings of
 * `manual` coexist and the question would stop being answerable.
 *
 *   - `manual`      — a person set it (the page's 改生命周期, or the set tool).
 *   - `publication` — an **explicitly declared** publication association: the
 *                     caller said "this publication used these words" and the
 *                     system recorded it. See the store's batch entry.
 *   - `observation` — an observation conclusion drove it. The *edges* for this
 *                     exist in the table below (`observing → retained / paused /
 *                     assigned`, §915); the automatic link from a checkpoint's
 *                     conclusion is **not wired in this batch** and the source
 *                     value is here for the explicit call that will carry it.
 */
export const KEYWORD_LIFECYCLE_SOURCES = ['manual', 'publication', 'observation']

/**
 * The legal transitions, and nothing else. Every edge is here for a named reason:
 *
 *   candidate → active      promotion into the working library.
 *   candidate → excluded    a candidate that was never worth keeping.
 *
 *   active    → assigned    given to a product line / ASIN.
 *   active    → paused      temporarily out of the rotation.
 *   active    → excluded    ruled out, with a reason.
 *   active    → archived    retired from the working set.
 *
 *   assigned  → used        the word was actually put to use (in this batch: by
 *                           an explicitly declared publication association).
 *   assigned  → active      released back to the pool.
 *   assigned  → paused / excluded / archived   the same three exits as active.
 *
 *   used      → observing   put into effect, now being watched.
 *   used      → assigned    the assignment is re-opened.
 *   used      → archived    done with it.
 *
 *   observing → retained    §915「保留」: the observation says keep it.
 *   observing → paused      the observation says stop watching.
 *   observing → assigned    §915「局部修订」: back to the assignment to be
 *                           revised. **「继续观察」 is NOT an edge here** — it
 *                           does not change the state, and a transition to the
 *                           same state is not a transition. That is exactly why
 *                           `canTransitionKeyword` refuses `observing → observing`.
 *   observing → archived    the window closed with nothing to keep.
 *
 *   retained  → assigned / paused / archived   「保留」 is the *current*
 *                           conclusion, not a life sentence: it can be revised,
 *                           suspended, or retired.
 *
 *   paused    → active / assigned / archived   resuming, or re-scoping.
 *
 *   excluded  → active      **`excluded` is not terminal.** §22.6 keeps the
 *                           reason on the word so the Agent will not recommend it
 *                           again — but if the product line changes, the word
 *                           must be able to come back. A terminal `excluded`
 *                           would make that impossible, and the only way back
 *                           would be to edit the database.
 *
 *   archived  → active      **`archived` is not terminal either.** Archiving is a
 *                           decision about the working set, not a deletion; and
 *                           this plugin does not delete keywords.
 */
export const KEYWORD_LIFECYCLE_TRANSITIONS = {
  candidate: ['active', 'excluded'],
  active: ['assigned', 'paused', 'excluded', 'archived'],
  assigned: ['used', 'active', 'paused', 'excluded', 'archived'],
  used: ['observing', 'assigned', 'archived'],
  observing: ['retained', 'paused', 'assigned', 'archived'],
  retained: ['assigned', 'paused', 'archived'],
  paused: ['active', 'assigned', 'archived'],
  excluded: ['active'],
  archived: ['active'],
}

/**
 * Whether one lifecycle state may become another.
 *
 * Same contract as `canTransition` above, on purpose: it is a predicate, it
 * returns false rather than throwing, and a transition to the **same** state is
 * false — it is not a transition, it is a no-op, and letting it through would
 * make "the status changed" untestable. It is a separate function (not an
 * overload of `canTransition`) because the two machines are different machines;
 * sharing one would mean the DQ roster and the keyword roster could never
 * diverge, which they must be free to do.
 *
 * A `from` that is not one of the nine (including `null`, which is what "no
 * record yet" looks like) returns false: there is no prior state, so there is no
 * edge. The *first* write is a creation, not a transition, and the store handles
 * it separately rather than pretending `null` is a state.
 */
export function canTransitionKeyword(from, to) {
  const allowed = KEYWORD_LIFECYCLE_TRANSITIONS[from]
  if (allowed === undefined) return false
  return allowed.includes(to)
}

/* ── 模块 08 F08-04：关键词所有权 ────────────────────────────────────────────
 *
 * 所有权不是生命周期。生命周期回答「这个词走到哪一步了」（九态、有边、可流转）；
 * 所有权回答「**哪个 ASIN 认领了它**」。两者正交：一个词可以在 observing，同时主人
 * 未决。
 *
 * 这两个词表是**闭集**，理由与上面九态一样：`status` 被一个读的人用来回答「这条主张
 * 还算不算数」，自由字符串会让 `claimed` / `active` / `owned` 三种拼写共存，那个问题
 * 就再也答不了。
 */

/**
 * 一条主张的状态。
 *
 *   - `claimed`  — 生效。词下**唯一**一条生效主张就是当前主人；≥2 条生效主张就是冲突。
 *   - `released` — 已释放。**不是删除**：行还在，带 released_at / released_reason，
 *                  可以再被认领回来。释放是撤销一个判断，不是抹掉它发生过。
 */
export const KEYWORD_OWNERSHIP_STATUSES = ['claimed', 'released']

/** Chinese labels, for the page and the tools. Same shape as the lifecycle labels. */
export const KEYWORD_OWNERSHIP_LABELS = {
  claimed: '生效',
  released: '已释放',
}

/**
 * 主张是谁提出的。闭集，因为读的人要回答「这是人工指派的、Agent 建议后被采纳的、
 * 还是自动推断的」—— 三者的可信度不同，而一个自由字符串会让这个区别消失。
 *
 *   - `manual` — 人通过工具 / 页面直接指派。
 *   - `agent`  — Agent 建议被采纳后写下的主张（采纳是一路人工裁决，见 store）。
 *   - `auto`   — 自动推断（本批没有产生它的写入路径；值在这里，因为规则一旦接入
 *               就要落在这个词表里，而不是届时临时加一个拼写）。
 */
export const KEYWORD_OWNERSHIP_CLAIM_SOURCES = ['manual', 'agent', 'auto']

/** Severity, worst first. `block` stops a publish; `info` is a remark. */
export const SEVERITIES = ['block', 'warn', 'info']

/**
 * The statuses an optimization run may hold.
 *
 * Four values, and the two that look alike are not:
 *
 *   - `running`   — the run exists and has drafts; nothing has been concluded.
 *   - `done`      — `amzn_optimize_save` finished and the report was built.
 *   - `failed`    — the run broke, and the reason is on the row.
 *   - `abandoned` — someone stopped it on purpose. A failure is news; an
 *                   abandonment is a decision, and merging them would lose
 *                   which of the two happened.
 *
 * A **closed set**, and it is enforced at the store boundary rather than only
 * at the tool that happens to call it today: `amzn_optimize_save` takes `status`
 * as a free-form string, so without this a run could be stored as
 * `"constructor"` and the page would render the chip as `undefined` — a data
 * problem wearing a rendering problem's clothes.
 */
export const OPTIMIZATION_RUN_STATUSES = ['running', 'done', 'failed', 'abandoned']

/**
 * The four buckets a dashboard todo lands in. The order is the order they are
 * read in: what stops you, what needs a person, what you should do, what you
 * could do.
 */
export const TODO_BUCKETS = ['blocking', 'needs_human', 'should_handle', 'optimization']

/**
 * Permission levels. There is no user table in phase 1 (Q4) — this is the
 * vocabulary a future one will use, and the value `dq_issue.assignee` and
 * `product_line_version.changed_by` store today.
 */
export const PERMISSION_LEVELS = ['workspace_admin', 'ops_editor', 'data_steward', 'reviewer', 'viewer']

/**
 * The kinds of object the snapshot registry can hold.
 *
 * `context_package` is in the list and this version registers **no row** for it
 * — not because the Agent plane is missing (module 12 shipped: `agent_run` /
 * `agent_step` / `agent_artifact` exist), but because a context package is a
 * field of a run, already frozen as four immutable columns on `agent_run`, and a
 * second name for the same fact is the drift the registry refuses. A page that
 * hid the category would leave the reader to conclude snapshots do not cover it,
 * so it is shown with the reason (`SNAPSHOT_PENDING_REASONS` in store/snapshot.js).
 */
export const SNAPSHOT_OBJECT_TYPES = [
  'listing', 'kw_master', 'competitor_set', 'rule_set', 'prompt_set', 'prompt', 'draft', 'context_package',
]

/**
 * The object types an audit row may name. Singular table names, so
 * `audit_log.object_type` and the table it describes are one word apart rather
 * than two vocabularies that have to be mapped.
 *
 * S1-B12 gave this list its first real reader (`recordAudit` validates against
 * it) and, doing so, found three tables that write and had no entry: `kw_master`
 * (import / discover / merge), `report` (the export and report tools register a
 * row) and `kw_pipeline_run` (a pipeline run is a record, not just files). They
 * are added here rather than in the audit module because this is the vocabulary,
 * and a second copy of it is the drift the comment above is warning about.
 */
export const AUDIT_OBJECT_TYPES = [
  'workspace', 'setting', 'product_line', 'product_line_version', 'source', 'shop', 'brand',
  'asin_ownership', 'site_profile', 'site_verification', 'rule', 'rule_set', 'policy', 'prompt',
  'competitor_set', 'asin', 'product_profile', 'shop_brand_rule', 'listing', 'collection_task', 'optimization_run', 'optimization_draft',
  'kw_import', 'kw_master', 'kw_pipeline_run', 'report', 'dq_issue', 'field_conflict', 'snapshot',
  'notification', 'approval_policy',
  /* 关键词扫描排班：save / delete 会写库，必须落审计。 */
  'kw_scan_schedule',
  /* 评论：回填 reviews / review_bindings 是写库，必须落审计（R-27 断点二的工具入口）。 */
  'review',
  /* R-91：字段模板。save / propose / confirm / rollback 四个写动作都落这一条 ——
     「谁把字段清单改成这样、谁确认的、谁回滚的」要能查得到。 */
  'field_template',
  /* ASIN 竞品关系：add / retire 会写库。 */
  'asin_competitor',
  /* 模块 12 的三样。**它们是补上的，不是新加的**：`WRITE_TARGETS` 从 v30 起就把三个
     Agent 写动作描述成这三种对象，而这个白名单里没有它们 —— 于是 `recordAudit` 每次
     都抛「objectType 不在白名单里」，异常被 `instrument` 的 try/catch 收成一条
     `audit:error` 的上报，**工具照常工作、审计行一行都没有**。模块 12 的六条写路径
     因此全部静默地没被审计，而「每次写操作记录」（§15 §5）看起来是满足的。 */
  'agent_run', 'agent_step', 'agent_artifact', 'agent_gate',
  /* 模块 14 §6/§7 的两样。同上：少了它们，登记一次发布在审计里是不存在的。 */
  'publication_record', 'observation_plan',
  /* 模块 14 §8/§9 的两样。`notification` 上面已经有了（B16 就在用），所以扫描到期
     不需要再加词；这两样是新增的：没有它们，下结论与生成回滚包在审计里同样不存在 ——
     与模块 12 那次一模一样的形状。 */
  'observation_checkpoint', 'rollback_task',
  /* 模块 08 F08-07 的一样本批新增。少了它，改一次生命周期在审计里不存在 —— 与模块
     12 那次一模一样的形状（`recordAudit` 抛错被 instrument 吞成一条 audit:error，
     工具照常工作、审计一行都没有）。 */
  'keyword_lifecycle',
  /* 模块 08 F08-04 的两样。同上：少了它们，指派 / 释放 / 锁定一条所有权、或回写一条
     Agent 建议，在审计里都不存在。两个类型而不是一个：主张（keyword_ownership）与
     建议（keyword_ownership_suggestion）是两张表、两件事。 */
  'keyword_ownership', 'keyword_ownership_suggestion',
  /* 模块 08 F08-05 的一样本批新增。少了它，存一版位置计划在审计里不存在 —— 与模块
     12 那次一模一样的形状（`recordAudit` 抛错被 instrument 吞成一条 audit:error，
     工具照常工作、审计一行都没有）。 */
  'keyword_plan',
  /* v69（F-5 的 B 半）一样本批新增。少了它，改一次产品线归属在审计里不存在 —— 与上面
     几处一模一样的形状（`recordAudit` 抛「不在白名单里」被 instrument 吞成一条
     audit:error，工具照常工作、审计一行都没有）。 */
  'keyword_product_line',
  /* 模块 04 第二子批的三样。同上：少了它们，体检一轮、存一版采集方案、存一条计划
     采集在审计里都不存在，而「每次写操作记录」看起来是满足的。三个类型而不是一个：
     体检明细、方案版本、计划是三张表、三件事。 */
  'collection_env_check', 'collection_scheme', 'collection_plan',
  /* 模块 05 第一子批的一样本批新增。少了它，记一条父子关系、或判定一条关系是错的，
     在审计里都不存在 —— 与模块 12/14 那次一模一样的形状（`recordAudit` 抛错被
     `instrument` 吞成一条 `audit:error`，工具照常工作、审计一行都没有）。
     一个类型而不是两个：关系与维度都是同一条边的事实，纠正是这条边的一个状态。 */
  'asin_variant',
  /* 模块 05 F05-01 的一样本批新增。少了它，存 / 删一个 ASIN 保存视图在审计里不存在 ——
     与模块 12/14/08/04/05/11 每一次都一模一样的形状（`recordAudit` 抛错被 `instrument`
     吞成一条 `audit:error`，工具照常工作、审计一行都没有）。
     ⚠️ **两处必须同时改**：`targets.js` 的 `WRITE_TARGETS` 描述符，和这里。 */
  'asin_saved_view',
  /* 模块 11 F11-07 的一样本批新增。少了它，导入一套固定评估集在审计里不存在 ——
     与模块 12/14/08/04/05 每一次都一模一样的形状（`recordAudit` 抛错被 `instrument`
     吞成一条 `audit:error`，工具照常工作、审计一行都没有）。
     ⚠️ **这不是「顺手加的」**：本批的三个工具里只有 import 是写，而它的 `WRITE_TARGETS`
     描述符是本批新写的 —— 新描述符 + 新 objectType 是这条形状最容易复发的地方，
     所以新增写路径时**两处必须同时改**：`targets.js` 的描述符，和这里。 */
  'prompt_eval_set',
  /* 模块 12 F12-02 的一样本批新增。少了它，发布一版角色配置在审计里不存在 —— 与模块
     12/14/08/04/05/11 每一次都一模一样的形状（`recordAudit` 抛错被 `instrument` 吞成一条
     `audit:error`，工具照常工作、审计一行都没有）。
     一个类型而不是两个：角色配置的每一版是同一张 `agent_role_config` 表上的行。 */
  'agent_role_config',
  /* 模块 12 F12-03 的一样本批新增。少了它，记一条补充数据请求 / 结掉一条在审计里不存在 ——
     与模块 12/14/08/04/05/11 每一次都一模一样的形状（`recordAudit` 抛错被 `instrument`
     吞成一条 `audit:error`，工具照常工作、审计一行都没有）。
     一个类型而不是两个：开与结是同一张 `agent_data_request` 表上的两条 write 动作。 */
  'agent_data_request',
  /* T70 评论分析（`review_analysis_runs` + `review_annotations`）的一样本批新增。
     **这是真对象，不是路由为了省事造的名字**：run 有自己的 id（`ra-…`）与 created_at，
     标注行以 run_id 为外键，读回也以「最近一次 run」为单位；缺了它，跑一次分析在审计里
     不存在 —— 与模块 12/14/08 一模一样的形状（`recordAudit` 抛错被 `pageWrite` 吞成一条
     `audit:error`，页面照常显示结果、审计一行都没有）。objectType 用单数表名，与
     `agent_run` / `publication_record` 同一条命名规则。 */
  'review_analysis_run',
]

/**
 * Machine-readable failure codes, for callers that branch on the reason.
 *
 * Only the codes something actually returns belong here. A code that no writer
 * emits is a code a reader will branch on and never see — the failure mode of
 * an aspirational enum.
 */
export const PROBLEM_CODES = {
  /** The draft was written in a different context than the one now selected. */
  DRAFT_CONTEXT_CHANGED: 'DRAFT_CONTEXT_CHANGED',
  /** A write was attempted against an archived workspace. */
  WORKSPACE_ARCHIVED: 'WORKSPACE_ARCHIVED',
  /** The named workspace does not exist. */
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  /** One ASIN was marked both ours and a competitor's, so neither row was written. */
  OWNERSHIP_CONFLICT: 'OWNERSHIP_CONFLICT',
  /** A quality issue was moved along an edge the state machine does not have. */
  DQ_ILLEGAL_TRANSITION: 'DQ_ILLEGAL_TRANSITION',
  /** A conflict that is already resolved was resolved again without new evidence. */
  CONFLICT_ALREADY_RESOLVED: 'CONFLICT_ALREADY_RESOLVED',
}

/* ── 模块 08 F08-05：位置计划 ──────────────────────────────────────────────────
 *
 * 需求 §22.2 原话：「标题/五点/属性/后台词/广告 exact·phrase·broad/否定的分配规则；
 * 一词一主人、一位一用途；**位置计划唯一持久层在本模块**；计划覆盖与实际覆盖分开
 * 统计。」这一节就是这句话里那三张词表。
 *
 * ## 一位一用途，位置是**闭集**
 *
 * 位置不是自由字符串。一个位置恰好有一个**用途**（purpose），在这里声明一次；计划条目
 * 不能改写它 —— 条目只能把某个词**指派**给某个位置，不能重新定义那个位置是干什么的。
 * 这正是「一位一用途」：位置的含义是词表给的，不是每一条计划各自给的。
 *
 * ## 位置 id 与 forListing 的**漂移守卫**
 *
 * 这 8 个位置里，有 6 个的**资格规则**由 `domain/keywords/classify.js` 的 `forListing`
 * 产出（title / bullets / backend / adsExact / adsPhrase / adsBroad），另外 2 个
 * （attributes / negatives）**本模块没有资格规则** —— 它们的资格是 `manual`：要不要把
 * 一个词放进属性或否定，是人判断的，不是搜索量阈值算出来的。所以 `proposePlan`
 * **永远不能**从这两个位置里挑主人（拿一个没有规则的位置去自动分配，就是凭空造规则）。
 *
 * 位置的 id **不在这里手写第二份**：下面这张用途表按 forListing 产出的 id 作键，而
 * tests/b08-plan.mjs 的 ⑨ 号断言证明「本表的键集合 == forListing 的键 ∪ manual 两个」
 * —— 谁往 classify.js 加一个位置却不在这里声明用途，那条断言当场失败。
 */

/** 一个计划版本的三种状态。闭集，理由与上面所有词表一样。 */
export const PLAN_STATUSES = ['draft', 'active', 'archived']

/** Chinese labels, for the page and the tools. */
export const PLAN_STATUS_LABELS = {
  draft: '草稿',
  active: '生效',
  archived: '已归档',
}

/**
 * 本模块**没有资格规则**的两个位置。
 *
 * 它们的资格是 `manual`：属性字段要不要放这个词、否定要不要排这个词，是人的判断，
 * 不是 sv / cvr 阈值能算的。`proposePlan` 从这两个位置里挑主人就是凭空造规则。
 */
export const PLAN_MANUAL_POSITIONS = ['attributes', 'negatives']

/**
 * 位置 → 用途。**一位一用途**：这个映射是位置含义的唯一定义，计划条目不能改写它。
 *
 * 键就是 forListing 产出的 id 加上上面两个 manual 位置；⑨ 号断言守着这个等式。
 */
export const PLAN_POSITION_PURPOSES = {
  title: { label: '标题', purpose: '承载最强的核心词：标题字符最贵，只放搜索量与层级都最高的词' },
  bullets: { label: '五点', purpose: '展开卖点：标题放不下的词在这里复现一次，抬高语义密度' },
  attributes: { label: '属性字段', purpose: '规格与材质词进属性（本模块无资格规则，人工判断）' },
  backend: { label: '后台搜索词', purpose: '前台索引不到的长尾词兜底；前台已有的词不再写进后台（白占字节）' },
  adsExact: { label: '广告 exact', purpose: '精确匹配：承接核心转化词，控词最紧' },
  adsPhrase: { label: '广告 phrase', purpose: '短语匹配：承接相关扩展词，兼顾覆盖与相关' },
  adsBroad: { label: '广告 broad', purpose: '广泛匹配：用来发现新词，回报最不确定' },
  negatives: { label: '否定', purpose: '明确排除的词（本模块无资格规则，人工判断）' },
}

/** 计划允许的全部位置，顺序即用途表的声明顺序。 */
export const PLAN_POSITIONS = Object.keys(PLAN_POSITION_PURPOSES)

/** Is `position` one of the eight? */
export function isPlanPosition(position) {
  return Object.prototype.hasOwnProperty.call(PLAN_POSITION_PURPOSES, position)
}

/**
 * 计划从哪来。闭集：读的人要回答「这份计划是人工排的、Agent 建议后存的、还是从资格
 * 推导的提案」—— 三者的可信度不同，自由字符串会让这个区别消失。
 *
 *   - `manual`   — 人在页面 / 工具里排的。
 *   - `agent`    — Agent 建议被采纳后存下的。
 *   - `proposal` — `proposePlan` 的推导结果被直接存下（资格 → 一个主人）。
 */
export const PLAN_SOURCES = ['manual', 'agent', 'proposal']

/* ── 模块 04：采集中心 ────────────────────────────────────────────────────────
 *
 * 这里住着**四套**互不相同的闭集，它们都服务于采集中心，但回答的问题不一样：
 *
 *   · 任务状态（十态）    —— 这一次采集走到哪一步了（`collection_task.status`）。
 *     与 `deriveStatus`（src/sources/collection.js）**共存，不是取代**：deriveStatus
 *     的职责收窄成「`running` 如何落成 `partial|done|failed|cancelled`」，本表里新增的
 *     四态（`draft`/`checking_env`/`waiting_human`/`cooling_down`）发生在它**之前**。
 *   · 节状态（五态）      —— 任务里的**某一节**采到了什么（`collection_section_result`）。
 *     `missing`（页面确实没有）与 `failed`（我们没测出来）必须是两个词，合并会让
 *     「没采到」被读成「不存在」，从而污染优化决策。
 *   · 方案状态（四态）    —— 一份采集方案能不能被选（`collection_scheme`）。
 *   · 体检状态 / 风险等级 / 修复动作 / 计划两个枚举 —— 见下。
 *
 * **逐目标的采集结果码**（ok / blocked / notfound / selector-miss / wrong-storefront /
 * error，见 `collection.js` 的 STATUS_LABEL）**不是任务态**，不在这四套里，也不许混用：
 * 一份状态里同时住着「任务在排队」与「这个 ASIN 没找到」，读的人就分不清句子在说谁。
 */

/**
 * 采集任务的十态，顺序即契约 §5.1 的声明顺序。
 *
 * `done` 而不是 `completed`：§4.5 与原型写的是 `completed`，但代码与库里一直是 `done`
 * （`collection.js` 的 deriveStatus、页面 TASK_STATUS 的键）。改名需要一次全表 UPDATE，
 * 那是一次不可逆的数据改动，会让依赖 `'done'` 的既有断言集体变红。**里程碑名保留原型
 * 口径，落库值保留代码口径**，两侧在契约里显式对齐 —— 这是决定，不是遗漏。
 */
export const COLLECTION_TASK_STATES = [
  'draft',
  'queued',
  'checking_env',
  'running',
  'waiting_human',
  'cooling_down',
  'partial',
  'done',
  'failed',
  'cancelled',
]

/**
 * 同一个十态词表的第二个名字。
 *
 * 契约 §5.1 写 `COLLECTION_TASK_STATES`，而批次任务书写 `COLLECTION_TASK_STATUSES`。
 * 两个名字**指向同一个数组**（不是两份定义）—— 复制一份字面量会让两边慢慢漂开，
 * 而漂开的那天没人知道该信哪一个。
 */
export const COLLECTION_TASK_STATUSES = COLLECTION_TASK_STATES

/** 中文标签，页面与工具共用。落库值一律是上面的英文 id。 */
export const COLLECTION_TASK_STATUS_LABELS = {
  draft: '草稿',
  queued: '排队',
  checking_env: '体检中',
  running: '进行中',
  waiting_human: '待人工',
  cooling_down: '冷却中',
  partial: '部分完成',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

/**
 * 两个终态：到了这里就不再有出路。`partial` / `failed` 允许「重试」，但重试是**新建一个
 * 任务**（`retry_of` 指向本任务），不是本任务的状态迁移 —— 所以它们不是终态。
 */
export const COLLECTION_TASK_TERMINAL_STATES = ['done', 'cancelled']

/**
 * 合法迁移表（契约 §5.2）。**只声明边，不声明副作用**：每一次迁移必须同时追加一行
 * `collection_task_event`（`src/store/collection-task-event.js`），`from_status` 首次为
 * NULL —— 那是「此前没有状态」，不是某个初始态。
 *
 * `partial` / `failed` 的 `['queued']` 不是「这两个状态能变成 queued」：一个失败的任务
 * 不会自己复活。它表达的是「允许从这里再发起一次尝试」，而那一次尝试是**新任务**；
 * 之所以仍列在这里，是因为重试入队时用同一张表做闸门，留一条边比在每个调用点各判一次
 * 「这个状态能不能重试」更难写错。
 */
export const COLLECTION_TASK_TRANSITIONS = {
  draft: ['queued', 'cancelled'],
  queued: ['checking_env', 'cancelled'],
  checking_env: ['running', 'waiting_human', 'cooling_down', 'failed', 'cancelled'],
  running: ['waiting_human', 'cooling_down', 'partial', 'done', 'failed', 'cancelled'],
  waiting_human: ['running', 'cancelled'],
  cooling_down: ['queued', 'waiting_human', 'cancelled'],
  partial: ['queued'],
  done: [],
  failed: ['queued'],
  cancelled: [],
}

/**
 * 采集任务能不能从 `from` 走到 `to`。
 *
 * 与 `canTransition` / `canTransitionKeyword` 分开命名，理由与那两个一样：三台不同的
 * 机器，共用一个函数就等于它们永远不能各自演进。
 *
 * `from` 不认识（含 `null`）返回 false —— 没有前状态就没有边，**第一次写入是创建，
 * 不是迁移**，由 store 单独处理，不假装 `null` 是一个状态。
 */
export function canTransitionCollectionTask(from, to) {
  const allowed = COLLECTION_TASK_TRANSITIONS[from]
  if (allowed === undefined) return false
  return allowed.includes(to)
}

/** 谁发起的这次流转。自由字符串会让「人点的」与「超时自动的」混成一个词。 */
export const COLLECTION_TASK_EVENT_SOURCES = ['plugin', 'page', 'plan', 'human', 'timeout']

/**
 * `waiting_human` 的三类触发（契约 §5.4），`waiting_json.trigger` 的值域。
 *
 * 三类对应三种**不同的处置动作**，所以必须分开：登录态掉了要人登录后重体检，撞了登录墙
 * 要人处理完点继续，计划窗口没到要人放行或等 —— 合并成「等待中」会让页面上的两个按钮
 * 不知道各自该做什么。
 */
export const COLLECTION_WAITING_TRIGGERS = ['profile-logged-out', 'login-wall', 'plan-window']

/**
 * 13 节的节级五态（契约 §4.2）。
 *
 *   · `collected` 本节字段清单里的字段**全部**解析到非空值；
 *   · `missing`   页面渲染完成，但本节所有字段都没出现 → 「亚马逊确实没有」；
 *   · `partial`   部分有值、部分没有；
 *   · `failed`    本次**没能判定**（选择器未命中 / 页面未渲染 / 超时）→「我们没测出来」；
 *   · `blocked`   被风控或登录墙截停，请求未完成。
 *
 * `missing` 与 `failed` 的界线是这一套词表存在的全部理由。
 */
export const COLLECTION_SECTION_STATES = ['collected', 'missing', 'partial', 'failed', 'blocked']

/** 节状态的中文标签，页面与工具共用。 */
export const COLLECTION_SECTION_LABELS = {
  collected: '已采到',
  missing: '页面没有',
  partial: '部分采到',
  failed: '采集失败',
  blocked: '被拦截',
}

/**
 * 采集方案的四态（契约 §2.1 / §6.2.10）。
 *
 * `obsolete` 是**终态**：已废弃的方案不可复活，否则「已废弃」就没有意义（`restore` 只对
 * `disabled` 有效）。`draft` 是唯一允许原地改的状态 —— 非 draft 的方案改内容只能出新
 * 版本，这是「版本化资产」的判据本身。
 */
export const COLLECTION_SCHEME_STATUSES = ['draft', 'active', 'disabled', 'obsolete']

/** 方案状态的中文标签。 */
export const COLLECTION_SCHEME_STATUS_LABELS = {
  draft: '草稿',
  active: '可用',
  disabled: '已停用',
  obsolete: '已废弃',
}

/** 方案状态迁移表（契约 §6.2.10）。`obsolete` 无出边。 */
export const COLLECTION_SCHEME_TRANSITIONS = {
  draft: ['active', 'obsolete'],
  active: ['disabled', 'obsolete'],
  disabled: ['active', 'obsolete', 'draft'],
  obsolete: [],
}

/**
 * 方案能不能从 `from` 走到 `to`。
 *
 * 这里的 `draft` 有两个含义，值得写下来：迁移表里的 `disabled → draft` 是**状态回落**
 * （把一份停用的方案放回草稿态以便改版），而「改版」本身（`baseVersion`）产出的是一行
 * 新版本，不是这次迁移。两件事在数据上不同：前者改的是同一行的 status。
 */
export function canTransitionScheme(from, to) {
  const allowed = COLLECTION_SCHEME_TRANSITIONS[from]
  if (allowed === undefined) return false
  return allowed.includes(to)
}

/** 体检十项的单项状态（契约 §6.2.1）。`unknown` 是「查不了」，不是「没过」。 */
export const COLLECTION_ENV_CHECK_STATES = ['ok', 'warn', 'fail', 'unknown']

/** 风险等级。预览与体检共用同一套值，所以只在这里声明一次。 */
export const COLLECTION_RISK_LEVELS = ['low', 'medium', 'high']

/**
 * 四个**可修**动作（F04-02）。值同时也是体检行 `repair_action` 的值域。
 *
 * 「自动登录 / 强杀进程 / 绕验证码 / 静默下载浏览器」四条禁令**不在这张表里**：它们不是
 * 动作，是拒绝。把禁令写成一个可被调用的动作，就等于给「绕验证码」留了一个入口。
 */
export const COLLECTION_REPAIR_ACTIONS = ['mkdir', 'launch_browser', 'reconnect_port', 'set_context']

/** 计划采集的失败策略（契约 §2.2）。 */
export const COLLECTION_PLAN_FAILURE_POLICIES = ['stop', 'continue', 'retry_once']

/** 计划采集的通知口径（契约 §2.2）。`none` 是默认：默认不打扰。 */
export const COLLECTION_PLAN_NOTIFY = ['none', 'on_failure', 'always']

/** 采集方案的驱动方式值域 = `source.id`，校验时对库里的 source 表比对，不硬编码。 */
export const COLLECTION_SCHEME_DEFAULT_DRIVER = 'browser-local'

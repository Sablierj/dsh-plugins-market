/**
 * T73 提示词变量注册表 —— 43 个变量的**唯一**闭集与契约。
 *
 * ## 为什么是 43 个扁平变量（Q1=A）
 *
 * 契约表 §2 把七类证据拆成 43 个可逐条验收的变量：4 个基线 + 39 个新增。
 * 渲染器是扁平的，section 结构要改渲染器；v1 不冒这个险（lead 拍板 Q1=A）。
 *
 * ## 命名：4 个 camelCase 原名不动（Q2=A）
 *
 * `scope` / `selectedKeywords` / `rulesVersion` / `policies` 保持原名 —— 改名会
 * 静默打断所有已存提示词正文，兼容优先；**新增变量一律 snake_case**。
 *
 * ## 未测量母集：kw_master，不是 legacy keyword（Q3=B）
 *
 * `kw_library_total_n` / `kw_untested_n` 的母集是 `kw_master`（约 30k 条，按站点/
 * 产品线筛选后），不是 legacy `keyword` 表的 16 条。用 16 条算覆盖率会系统性高估。
 *
 * ## 三态缺失行为（本单的命门）
 *
 * 每个变量**只**声明一种：
 *   - `omit`        —— 整个 `{{#name}}…{{/name}}` 段连自带标点消失（仅 string 可选段）
 *   - `placeholder` —— 印注册表里的固定文案（非空、类型一致；绝不印空串）
 *   - `fail`        —— 拒绝渲染并点名（不产出半截文本）
 *
 * 不变式在模块加载时由 `validatePromptVariableRegistry` 检查：`required ===
 * (missingBehavior === 'fail')`；`omit` 只能用于 string；placeholder 文案不能是
 * `''` / `'0'` / `'—'` / `'N/A'`。坏契约整张注册表拒绝加载（CONTRACT_MISSING）。
 *
 * ## 四态归一：没取到 ≠ 没有
 *
 * `''` / 纯空白 / `null` / `undefined` / `[]` / `{}` 一律先归一为「缺失」，再走上面
 * 三态。`0` / `'0'` **不是缺失** —— 0 是测出来的事实，把 0 印成「本处未记」会把
 * 「一条都没有」改写成「没测过」。
 *
 * ## 与渲染器的关系
 *
 * 本文件只做**声明与校验**。执行在 `render.js`：它按 `type` 序列化（object →
 * 稳定 key 序 JSON；array → 「、」连接），按 `maxLength` 截断，按 `missingBehavior`
 * 分派。`domain/optimize/prompt.js` 的旧 4 名闭集由 lead 统一接线后改为从
 * `PROMPT_VARIABLES` 导入（本批不碰那个文件）。
 */

import { parsePromptTemplate, templateUsage } from './template.js'

/** 变量的四种类型。`'text'` 是旧注册表的叫法，T73 起统一为 `string`。 */
export const PROMPT_VARIABLE_TYPES = ['string', 'number', 'object', 'array']

/** 缺失行为只有三种，没有第四种「当空串处理」。 */
export const PROMPT_MISSING_BEHAVIORS = ['omit', 'placeholder', 'fail']

/** 变量可以注入的 listing 字段（`all` = 合规相关全字段）。 */
export const PROMPT_APPLIES_TO = [
  'title', 'bullets', 'description', 'search_terms', 'attributes', 'aplus',
  'brand_story', 'qa', 'image_alt', 'video_script', 'all',
]

/** 七类证据 + 基线。侧栏勾选以类为 bundle，变量以类归档。 */
export const PROMPT_EVIDENCE_CLASSES = [
  'baseline', 'asin', 'competitor', 'review', 'kw_master', 'kw_coverage', 'geo', 'policy',
]

/** 注册表契约错误：加载期发现字段缺失 / 枚举非法 / 不变式被破坏。 */
export class PromptVariableContractError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'PromptVariableContractError'
    this.code = 'CONTRACT_MISSING'
    this.errors = errors
  }
}

/** 渲染期变量错误：缺必填 / 配对缺失 / omit 用错位置 / 类型不符。 */
export class PromptVariableError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'PromptVariableError'
    this.code = code
    this.missingNamed = detail.missingNamed ?? []
    this.detail = detail
  }
}

function defaultFormat(type) {
  if (type === 'object') return 'json'
  if (type === 'array') return 'join'
  if (type === 'number') return 'number'
  return 'text'
}

/**
 * 定义一个变量。`required` 由 `missingBehavior` 推导，避免两处各写一份而漂掉
 * （契约不变式：`required === (missingBehavior === 'fail')`）。
 */
function defineVariable(fields) {
  const missingBehavior = fields.missingBehavior
  return {
    name: fields.name,
    label: fields.label,
    description: fields.description,
    type: fields.type,
    source: fields.source,
    required: missingBehavior === 'fail',
    requiredBasis: fields.requiredBasis,
    maxLength: fields.maxLength,
    sensitive: false,
    defaultBehavior: fields.defaultBehavior,
    missingBehavior,
    ...(missingBehavior === 'placeholder' ? { placeholder: fields.placeholder } : {}),
    appliesTo: fields.appliesTo,
    pairWith: fields.pairWith ?? [],
    evidenceClass: fields.evidenceClass,
    timeSource: fields.timeSource,
    format: fields.format ?? defaultFormat(fields.type),
  }
}

/**
 * 43 个变量的契约。顺序 = 契约表 §2.8 的顺序：4 个基线 → 七类各按表内顺序。
 *
 * 字段来源分两类（报告里逐条列出）：
 *   - **照契约表抄的**：name / label / description / type / source / missingBehavior /
 *     placeholder / maxLength / appliesTo / pairWith / timeSource / 七类归属；
 *   - **本实现补的**：requiredBasis / defaultBehavior / format / sensitive（均为
 *     `false`，契约表未逐条给，但旧注册表与工具需要它们保持可读）。
 */
export const PROMPT_VARIABLE_SPECS = {
  /* ── 基线（4） ─────────────────────────────────────────────────────────── */
  scope: defineVariable({
    name: 'scope',
    label: '业务范围',
    description: '这次要对谁做事 —— 一句话说清范围，例如「当前选中的 3 个 ASIN」或「库里的全部 ASIN」。',
    type: 'string',
    source: '页面 promptState 从 context.selection.asins 算出（src/web/routes.js）；'
      + 'agent 侧由调用方提供（amzn_prompt_preview 的 scope 参数）。',
    missingBehavior: 'fail',
    maxLength: 2000,
    appliesTo: ['all'],
    evidenceClass: 'baseline',
    timeSource: '页面 promptState 即时（没有值时由调用方提供）',
    requiredBasis: '44 条种子模板里 {{scope}} 内联出现在 11 条（按钮场景）；缺了它这些句子中间就是空的。',
    defaultBehavior: '无默认值。页面给「库里的全部 ASIN」作为**值**，不是占位句。',
  }),
  selectedKeywords: defineVariable({
    name: 'selectedKeywords',
    label: '关键词包',
    description: '当前选中的关键词，已经用「、」连成一串（渲染器不加分隔符）。',
    type: 'string',
    source: '页面 promptState 从 context.selection.keywords 取 keyword 并用「、」连接（src/web/routes.js）；'
      + '选中为空时是空串。agent 侧由调用方提供。',
    missingBehavior: 'omit',
    maxLength: 4000,
    appliesTo: ['all'],
    evidenceClass: 'baseline',
    timeSource: '页面 promptState 即时（没有值时由调用方提供）',
    requiredBasis: '44 条种子里只有 2 条引用 {{selectedKeywords}}，且两条都是 {{#selectedKeywords}}…{{/selectedKeywords}} 包着的可选段'
      + '（段内还有一个内联 {{selectedKeywords}}，usage=both）。',
    defaultBehavior: '空则整段（连同它自带的标点）被移除。',
  }),
  rulesVersion: defineVariable({
    name: 'rulesVersion',
    label: '规则版本',
    description: '规则集的人读版本标签，例如「2026.9」；库里没有生效版本时它是缺失，不会被编成一个占位句子。',
    type: 'string',
    source: '页面 promptState 取当前查看的规则集版本，没有查看中的版本时取 activeVersion(store)'
      + '（真正生效的那一个，src/web/routes.js）；两者都没有时为空，交给必填检查报出来。',
    missingBehavior: 'fail',
    maxLength: 120,
    appliesTo: ['all'],
    evidenceClass: 'baseline',
    timeSource: 'rule_set.activeVersion / 页面查看中的版本',
    requiredBasis: '44 条种子里 {{rulesVersion}} 内联出现在 2 条（rules 模块的两个按钮）；缺了它这两句中间就是空的。',
    defaultBehavior: '无默认值。版本号没有诚实的替身；库里没有生效版本时这里就是缺失。',
  }),
  policies: defineVariable({
    name: 'policies',
    label: '政策约束',
    description: '本轮**生效中**的政策，一行一条：「标题（生效 2026-01-01；严重度 block；关联规则 …）」。它是硬约束，不是参考材料。',
    type: 'string',
    source: 'amzn_optimize_prepare 从 policy 表取 status=active 且 marketplace 匹配的行'
      + '（domain/optimize/evidence.js 的 activePolicies，与证据包第十一类同一次取数）。'
      + '政策库为空时是空串 —— 不是「没有政策」，是「读过了，0 条」。',
    missingBehavior: 'omit',
    maxLength: 4000,
    appliesTo: ['all'],
    evidenceClass: 'baseline',
    timeSource: 'policy.effective_from / policy.imported_at',
    requiredBasis: '种子的证据层里是一个可选段 {{#policies}}…{{/policies}}（2026-10-21 加）；政策库为空时整段消失是设计内行为。',
    defaultBehavior: '空则整段（连同它自带的标点）被移除。',
  }),

  /* ── 第 1 类：ASIN 现状（5） ───────────────────────────────────────────── */
  asin_snapshot: defineVariable({
    name: 'asin_snapshot',
    label: 'ASIN 现状',
    description: '当前 ASIN 的 listing 文案（title / bullets / description / A+）、属性、核心字段（品牌 / 价格 / 评分 / 评论数 / BSR / 类目）与 13 节采集状态摘要；一段可直接读的现状块。',
    type: 'string',
    source: 'listing + asin + collection_section_result；reader buildAsinDetail（src/domain/asin/detail.js）→ '
      + 'buildOverview（overview.js）/ buildFieldFacts（fields.js）/ buildSectionView（sections.js）。',
    missingBehavior: 'placeholder',
    placeholder: 'ASIN 现状：未取到（还没采过或读数失败）',
    maxLength: 8000,
    appliesTo: ['title', 'bullets', 'description', 'aplus', 'attributes'],
    pairWith: ['asin_observed_at'],
    evidenceClass: 'asin',
    timeSource: 'max(asin.updated_at, listing.updated_at, 最新 asin_snapshot.collected_at)',
    requiredBasis: '契约表 §2.1 声明为 placeholder；模板引用 {{asin_snapshot}} 时缺值印固定文案，不印空串。',
    defaultBehavior: '缺值印「ASIN 现状：未取到（还没采过或读数失败）」。',
  }),
  asin_rating: defineVariable({
    name: 'asin_rating',
    label: '平均评分',
    description: '当前平均评分（1-5）。',
    type: 'number',
    source: 'asin.rating；buildOverview / buildAsinDetail。',
    missingBehavior: 'placeholder',
    placeholder: '本处未记',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'description'],
    pairWith: ['asin_review_count', 'asin_observed_at'],
    evidenceClass: 'asin',
    timeSource: 'asin.updated_at',
    requiredBasis: '契约表 §2.1 声明为 placeholder；{{asin_rating}} 的分母是评论数，配 {{asin_review_count}} / {{asin_observed_at}}。',
    defaultBehavior: '缺值印「本处未记」。',
  }),
  asin_review_count: defineVariable({
    name: 'asin_review_count',
    label: '评论数',
    description: '当前评论数。',
    type: 'number',
    source: 'asin.reviews；buildOverview / buildAsinDetail。',
    missingBehavior: 'placeholder',
    placeholder: '本处未记',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'description'],
    pairWith: ['asin_rating', 'asin_observed_at'],
    evidenceClass: 'asin',
    timeSource: 'asin.updated_at',
    requiredBasis: '契约表 §2.1 声明为 placeholder；{{asin_review_count}} 与 {{asin_rating}} / {{asin_observed_at}} 成对。',
    defaultBehavior: '缺值印「本处未记」。',
  }),
  asin_bsr: defineVariable({
    name: 'asin_bsr',
    label: 'Best Sellers Rank',
    description: '当前 Best Sellers Rank（类目内排名）。',
    type: 'number',
    source: 'asin.bsr + asin.category；buildOverview / buildAsinDetail。',
    missingBehavior: 'placeholder',
    placeholder: '本处未记',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['asin_observed_at'],
    evidenceClass: 'asin',
    timeSource: 'asin.updated_at；榜单口径=asin.category',
    requiredBasis: '契约表 §2.1 声明为 placeholder；{{asin_bsr}} 的榜单口径是 asin.category 对应的类目，且配 {{asin_observed_at}}。',
    defaultBehavior: '缺值印「本处未记」。',
  }),
  asin_observed_at: defineVariable({
    name: 'asin_observed_at',
    label: 'ASIN 现状读数时间',
    description: '上述 ASIN 现状读数的时间（ISO 8601）。',
    type: 'string',
    source: 'max(asin.updated_at, listing.updated_at, fields[].observedAt, 最新 asin_snapshot.collected_at)；'
      + '现有 reader 不返回单值，需在变量解析层取 max。',
    missingBehavior: 'fail',
    maxLength: 40,
    appliesTo: ['all'],
    evidenceClass: 'asin',
    timeSource: '自身',
    requiredBasis: '契约表 §2.1 声明为 fail；{{asin_observed_at}} 缺时间，所有 ASIN 数字都失去时间口径。',
    defaultBehavior: '拒绝渲染并点名。',
  }),

  /* ── 第 2 类：竞品分析（4） ────────────────────────────────────────────── */
  competitor_summary: defineVariable({
    name: 'competitor_summary',
    label: '竞品分析摘要',
    description: '竞品分析摘要：竞品组名/成员、五桶象限计数、缺口词（ourAbsent）、隔离词（brandOnly）、测量期是否一致；不合成总分。',
    type: 'string',
    source: 'competitor_set + kw_competitor_fact + asin_keyword；reader buildAsinCompetitorView（src/domain/asin/competitor.js）→ '
      + 'listCompetitorSets（src/store/kw.js）/ readCompetitorSides / classifyQuadrants（src/domain/keywords/competitor.js）。',
    missingBehavior: 'placeholder',
    placeholder: '竞品分析：还没有竞品组——缺的是竞品组本身',
    maxLength: 6000,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: [],
    evidenceClass: 'competitor',
    timeSource: 'competitor_set.updated_at + kw_competitor_fact.collected_at + asin_keyword.collected_at',
    requiredBasis: '契约表 §2.2 声明为 placeholder；模板引用 {{competitor_summary}} 时缺值印「还没有竞品组」。',
    defaultBehavior: '缺值印「竞品分析：还没有竞品组——缺的是竞品组本身」。',
  }),
  competitor_set: defineVariable({
    name: 'competitor_set',
    label: '竞品组',
    description: '竞品组：组名 + 竞品 ASIN 列表。',
    type: 'array',
    source: 'competitor_set；listCompetitorSets（src/store/kw.js）。',
    missingBehavior: 'placeholder',
    placeholder: ['竞品组：本处未记'],
    maxLength: 1000,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: [],
    evidenceClass: 'competitor',
    timeSource: 'competitor_set.updated_at',
    requiredBasis: '契约表 §2.2 声明为 placeholder；{{competitor_set}} 为空数组时印固定文案，不伪造空数组。',
    defaultBehavior: '缺值印「竞品组：本处未记」。',
  }),
  competitor_quadrant_counts: defineVariable({
    name: 'competitor_quadrant_counts',
    label: '竞品五桶计数',
    description: '五桶计数：own_advantage / contested / our_absent / unmeasured / brand_only + total。',
    type: 'object',
    source: 'classifyQuadrants 的 counts；buildAsinCompetitorView。',
    missingBehavior: 'placeholder',
    placeholder: { state: '本处未记' },
    maxLength: 500,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['competitor_periods'],
    evidenceClass: 'competitor',
    timeSource: '与 competitor_periods 同',
    requiredBasis: '契约表 §2.2 声明为 placeholder；{{competitor_quadrant_counts}} 必须与 {{competitor_periods}} 同现，期不一致不判读。',
    defaultBehavior: '缺值印 {"state":"本处未记"}。',
  }),
  competitor_periods: defineVariable({
    name: 'competitor_periods',
    label: '竞品双侧测量期',
    description: '双侧测量期与判读闸门：our_periods / their_periods / period_mismatch / judgement_blocked。',
    type: 'object',
    source: 'buildEvidenceView（src/domain/keywords/competitor.js）；kw_competitor_fact.collected_at + asin_keyword.collected_at。',
    missingBehavior: 'fail',
    maxLength: 500,
    appliesTo: ['all'],
    evidenceClass: 'competitor',
    timeSource: '自身（双侧 kw_competitor_fact.collected_at / asin_keyword.collected_at）',
    requiredBasis: '契约表 §2.2 声明为 fail；{{competitor_periods}} 缺了就无法判断两侧是否同期，任何对比都是伪证据。',
    defaultBehavior: '拒绝渲染并点名。',
  }),

  /* ── 第 3 类：评论分析（8） ────────────────────────────────────────────── */
  review_summary: defineVariable({
    name: 'review_summary',
    label: '评论分析摘要',
    description: '评论分析摘要：评分分布、四类标注、覆盖率 n/N、方法版本；不合成总分。',
    type: 'string',
    source: 'reviews + review_analysis_runs + review_annotations；reader readReviewAnalysis（src/domain/asin/review-analysis-run.js）→ '
      + 'readReviewFamily（src/store/review.js）/ distribution（review-analysis.js）/ readAnnotationCounts（src/store/review-analysis.js）。',
    missingBehavior: 'placeholder',
    placeholder: '评论分析：还没跑过分析（方法=词典法 v1）',
    maxLength: 4000,
    appliesTo: ['bullets', 'description', 'aplus'],
    pairWith: ['review_method_version', 'review_observed_at'],
    evidenceClass: 'review',
    timeSource: 'review_analysis_runs.created_at；分布另带 reviews.observed_at',
    requiredBasis: '契约表 §2.3 声明为 placeholder；模板引用 {{review_summary}} 时缺值印「还没跑过分析」。',
    defaultBehavior: '缺值印「评论分析：还没跑过分析（方法=词典法 v1）」。',
  }),
  review_method_version: defineVariable({
    name: 'review_method_version',
    label: '评论分析方法版本',
    description: '评论分析方法版本：lexicon-v1 + lexicon_hash。',
    type: 'string',
    source: 'review_analysis_runs.method_version / lexicon_hash；readReviewAnalysis。',
    missingBehavior: 'fail',
    maxLength: 120,
    appliesTo: ['bullets', 'description'],
    pairWith: [],
    evidenceClass: 'review',
    timeSource: 'review_analysis_runs.created_at',
    requiredBasis: '契约表 §2.3 声明为 fail；{{review_method_version}} 缺了，任何评论标注都无法证明是用哪种方法产出的。',
    defaultBehavior: '拒绝渲染并点名。',
  }),
  review_sample_n: defineVariable({
    name: 'review_sample_n',
    label: '评论分析样本数',
    description: '分析样本数（家族去重评论条数）。',
    type: 'number',
    source: 'review_analysis_runs.sample_n；readReviewAnalysis。',
    missingBehavior: 'placeholder',
    placeholder: '未跑过分析',
    maxLength: 32,
    appliesTo: ['bullets', 'description'],
    pairWith: ['review_matched_n', 'review_coverage', 'review_observed_at'],
    evidenceClass: 'review',
    timeSource: 'review_analysis_runs.created_at',
    requiredBasis: '契约表 §2.3 声明为 placeholder；{{review_sample_n}} 是分母，必须与 {{review_matched_n}} / {{review_coverage}} / {{review_observed_at}} 成对。',
    defaultBehavior: '缺值印「未跑过分析」。',
  }),
  review_matched_n: defineVariable({
    name: 'review_matched_n',
    label: '评论分析命中数',
    description: '命中至少一个标签的评论数（去重）。',
    type: 'number',
    source: 'review_analysis_runs.matched_n；readReviewAnalysis。',
    missingBehavior: 'placeholder',
    placeholder: '未跑过分析',
    maxLength: 32,
    appliesTo: ['bullets', 'description'],
    pairWith: ['review_sample_n', 'review_coverage', 'review_observed_at'],
    evidenceClass: 'review',
    timeSource: 'review_analysis_runs.created_at',
    requiredBasis: '契约表 §2.3 声明为 placeholder；{{review_matched_n}} 是分子，必须与 {{review_sample_n}} / {{review_coverage}} / {{review_observed_at}} 成对。',
    defaultBehavior: '缺值印「未跑过分析」。',
  }),
  review_coverage: defineVariable({
    name: 'review_coverage',
    label: '评论分析覆盖率',
    description: '覆盖率 = review_matched_n / review_sample_n（0-1 小数，渲染时同时印 n/N）。',
    type: 'number',
    source: 'readReviewAnalysis 按 matched_n / sample_n 计算（review-analysis-run.js）。',
    missingBehavior: 'placeholder',
    placeholder: '未跑过分析',
    maxLength: 32,
    appliesTo: ['bullets', 'description'],
    pairWith: ['review_sample_n', 'review_matched_n', 'review_observed_at'],
    evidenceClass: 'review',
    timeSource: 'review_analysis_runs.created_at',
    requiredBasis: '契约表 §2.3 声明为 placeholder；{{review_coverage}} 必须与 {{review_sample_n}} 成对，单独一个百分比不合格。',
    defaultBehavior: '缺值印「未跑过分析」。',
  }),
  review_distribution: defineVariable({
    name: 'review_distribution',
    label: '评分分布',
    description: '评分分布：1-5 星各自 numerator、denominator、unrated；分布是当前家族行聚合，带自己的 observed_at。',
    type: 'object',
    source: 'distribution（src/domain/asin/review-analysis.js）+ readReviewFamily（src/store/review.js）。',
    missingBehavior: 'placeholder',
    placeholder: { state: '未跑过分析' },
    maxLength: 1000,
    appliesTo: ['bullets', 'description', 'aplus'],
    pairWith: [],
    evidenceClass: 'review',
    timeSource: 'max(reviews.observed_at)（对象内）',
    requiredBasis: '契约表 §2.3 声明为 placeholder；{{review_distribution}} 的分布是当前家族聚合，必须自带 observed_at，不能拿 run 的时间冒充。',
    defaultBehavior: '缺值印 {"state":"未跑过分析"}。',
  }),
  review_label_counts: defineVariable({
    name: 'review_label_counts',
    label: '评论四类标注计数',
    description: '四类标注计数：category / label / count / conclusion_allowed / matched_terms；四类=topic/pain/objection/scene。',
    type: 'object',
    source: 'readAnnotationCounts（src/store/review-analysis.js）+ review_annotations。',
    missingBehavior: 'placeholder',
    placeholder: { state: '未跑过分析' },
    maxLength: 3000,
    appliesTo: ['bullets', 'description', 'aplus'],
    pairWith: ['review_observed_at'],
    evidenceClass: 'review',
    timeSource: 'review_analysis_runs.created_at',
    requiredBasis: '契约表 §2.3 声明为 placeholder；{{review_label_counts}} 的 count=COUNT(DISTINCT review_key)，count<2 只列不判，配 {{review_observed_at}}。',
    defaultBehavior: '缺值印 {"state":"未跑过分析"}。',
  }),
  review_observed_at: defineVariable({
    name: 'review_observed_at',
    label: '评论分析时间',
    description: '评论分析 run 的时间（ISO 8601）。',
    type: 'string',
    source: 'review_analysis_runs.created_at。',
    missingBehavior: 'fail',
    maxLength: 40,
    appliesTo: ['all'],
    evidenceClass: 'review',
    timeSource: '自身',
    requiredBasis: '契约表 §2.3 声明为 fail；{{review_observed_at}} 缺时间，评论的 n/N 与标注都失去时间口径。',
    defaultBehavior: '拒绝渲染并点名。',
  }),

  /* ── 第 4 类：关键词总库（4） ──────────────────────────────────────────── */
  kw_master_summary: defineVariable({
    name: 'kw_master_summary',
    label: '关键词总库摘要',
    description: '关键词总库摘要：总词数、有/无搜索量、ABA/广告/竞品覆盖、层级/优先级/漏斗分布、产品线未分类数；不把无搜索量印成 0。',
    type: 'string',
    source: 'kw_master + kw_import；masterStats（src/store/kw.js）/ queryMaster（src/store/kw.js）。',
    missingBehavior: 'placeholder',
    placeholder: '关键词总库为空（读过了，0 条）',
    maxLength: 4000,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['kw_master_total_n', 'kw_master_observed_at'],
    evidenceClass: 'kw_master',
    timeSource: 'max(kw_master.updated_at) / 最新 kw_import.imported_at',
    requiredBasis: '契约表 §2.4 声明为 placeholder；模板引用 {{kw_master_summary}} 时缺值印「关键词总库为空（读过了，0 条）」。',
    defaultBehavior: '缺值印「关键词总库为空（读过了，0 条）」。',
  }),
  kw_master_total_n: defineVariable({
    name: 'kw_master_total_n',
    label: '关键词总库总词数',
    description: '总库总词数（当前站点/产品线筛选后）。',
    type: 'number',
    source: 'masterStats.total（src/store/kw.js）。',
    missingBehavior: 'fail',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['kw_master_observed_at'],
    evidenceClass: 'kw_master',
    timeSource: 'max(kw_master.updated_at)',
    requiredBasis: '契约表 §2.4 声明为 fail；{{kw_master_total_n}} 是分母，0 是事实（库为空），读不到就必须拒绝渲染。',
    defaultBehavior: '拒绝渲染并点名。',
  }),
  kw_master_volume_tiers: defineVariable({
    name: 'kw_master_volume_tiers',
    label: '关键词搜索量层级',
    description: '搜索量层级分布：L1-L5 计数 + with_volume / without_volume。',
    type: 'object',
    source: 'masterStats.bySvTier + withVolume / withoutVolume（src/store/kw.js）。',
    missingBehavior: 'placeholder',
    placeholder: { state: '本处未记' },
    maxLength: 1000,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['kw_master_total_n', 'kw_master_observed_at'],
    evidenceClass: 'kw_master',
    timeSource: 'max(kw_master.updated_at)',
    requiredBasis: '契约表 §2.4 声明为 placeholder；{{kw_master_volume_tiers}} 的 L5 含无搜索量，without_volume ≠ 0 搜索量，必须与 {{kw_master_total_n}} 同现。',
    defaultBehavior: '缺值印 {"state":"本处未记"}。',
  }),
  kw_master_observed_at: defineVariable({
    name: 'kw_master_observed_at',
    label: '关键词总库读数时间',
    description: '总库读数时间（ISO 8601）。',
    type: 'string',
    source: 'max(kw_master.updated_at) / 最新 kw_import.imported_at；现有 masterStats 不返回单值时间，需要补一个 reader。',
    missingBehavior: 'fail',
    maxLength: 40,
    appliesTo: ['all'],
    evidenceClass: 'kw_master',
    timeSource: '自身',
    requiredBasis: '契约表 §2.4 声明为 fail；{{kw_master_observed_at}} 缺时间，总库的 30k 数字就没有读数时点。',
    defaultBehavior: '拒绝渲染并点名。',
  }),

  /* ── 第 5 类：关键词分析（9，Q3=B：母集取 kw_master） ───────────────────── */
  kw_coverage_summary: defineVariable({
    name: 'kw_coverage_summary',
    label: '关键词覆盖摘要',
    description: '该 ASIN 的关键词覆盖摘要：已测/有排名/已测无排名/未扫描/未关联、T1-T4 分层、扫描深度、建议顺序；未测≠缺席。',
    type: 'string',
    source: 'asin_keyword + kw_master（Q3=B：未测量母集取 kw_master，不取 legacy keyword）；'
      + 'reader keywordCoverage（src/store/queries.js）/ buildAsinKeywordView（src/domain/asin/keywords.js）+ kwCoverageAgainstMaster（计划新增）。',
    missingBehavior: 'placeholder',
    placeholder: '这个 ASIN 还没有任何关键词数据（没测过 ≠ 没排名）',
    maxLength: 4000,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['kw_measured_n', 'kw_scan_observed_at'],
    evidenceClass: 'kw_coverage',
    timeSource: 'max(asin_keyword.collected_at)',
    requiredBasis: '契约表 §2.5 声明为 placeholder；模板引用 {{kw_coverage_summary}} 时缺值印「没测过 ≠ 没排名」。',
    defaultBehavior: '缺值印「这个 ASIN 还没有任何关键词数据（没测过 ≠ 没排名）」。',
  }),
  kw_library_total_n: defineVariable({
    name: 'kw_library_total_n',
    label: '未测量判定母集大小',
    description: '未关联判定的母集大小（Q3=B：kw_master 按站点/产品线筛选后的总词数，不是 legacy keyword 16 条）。',
    type: 'number',
    source: 'kw_master COUNT(*)（kwCoverageAgainstMaster，计划新增；lead Q3=B 拍板）。',
    missingBehavior: 'fail',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: [],
    evidenceClass: 'kw_coverage',
    timeSource: 'max(kw_master.updated_at)',
    requiredBasis: '契约表 §2.5 声明为 fail；{{kw_library_total_n}} 是 {{kw_untested_n}} 的母集，缺了「未测量」就没有分母。',
    defaultBehavior: '拒绝渲染并点名。',
  }),
  kw_measured_n: defineVariable({
    name: 'kw_measured_n',
    label: '已测词数',
    description: '已测词数（asin_keyword 行数，含未扫描行）。',
    type: 'number',
    source: 'summary.measured；keywordCoverage（src/store/queries.js）。',
    missingBehavior: 'placeholder',
    placeholder: '本处未记',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['kw_ranked_n', 'kw_gap_n', 'kw_unscanned_n', 'kw_scan_observed_at'],
    evidenceClass: 'kw_coverage',
    timeSource: 'max(asin_keyword.collected_at)',
    requiredBasis: '契约表 §2.5 声明为 placeholder；{{kw_measured_n}} = {{kw_ranked_n}} + {{kw_gap_n}} + {{kw_unscanned_n}}，四个数必须同现。',
    defaultBehavior: '缺值印「本处未记」。',
  }),
  kw_ranked_n: defineVariable({
    name: 'kw_ranked_n',
    label: '有排名词数',
    description: '有排名词数。',
    type: 'number',
    source: 'summary.ranked；keywordCoverage。',
    missingBehavior: 'placeholder',
    placeholder: '本处未记',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['kw_measured_n', 'kw_scan_observed_at'],
    evidenceClass: 'kw_coverage',
    timeSource: 'max(asin_keyword.collected_at)',
    requiredBasis: '契约表 §2.5 声明为 placeholder；{{kw_ranked_n}} 是分子，与 {{kw_measured_n}} 成对。',
    defaultBehavior: '缺值印「本处未记」。',
  }),
  kw_gap_n: defineVariable({
    name: 'kw_gap_n',
    label: '已测无排名词数',
    description: '已测无排名词数（rank IS NULL 且 scan_depth 非空）。',
    type: 'number',
    source: 'summary.gaps；keywordCoverage。',
    missingBehavior: 'placeholder',
    placeholder: '本处未记',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['kw_measured_n', 'kw_scan_depth', 'kw_scan_observed_at'],
    evidenceClass: 'kw_coverage',
    timeSource: 'max(asin_keyword.collected_at)',
    requiredBasis: '契约表 §2.5 声明为 placeholder；{{kw_gap_n}} 不是「没排名」，是「没进前 N」，必须配 {{kw_scan_depth}}。',
    defaultBehavior: '缺值印「本处未记」。',
  }),
  kw_unscanned_n: defineVariable({
    name: 'kw_unscanned_n',
    label: '已关联未扫描词数',
    description: '已关联但未扫描的词数（scan_depth IS NULL）。',
    type: 'number',
    source: 'summary.unscanned；keywordCoverage。',
    missingBehavior: 'placeholder',
    placeholder: '本处未记',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['kw_measured_n', 'kw_scan_observed_at'],
    evidenceClass: 'kw_coverage',
    timeSource: 'max(asin_keyword.collected_at)',
    requiredBasis: '契约表 §2.5 声明为 placeholder；{{kw_unscanned_n}} 与 {{kw_gap_n}} 分开：未扫描 ≠ 已测无排名。',
    defaultBehavior: '缺值印「本处未记」。',
  }),
  kw_untested_n: defineVariable({
    name: 'kw_untested_n',
    label: '未测量词数',
    description: '库里有、该 ASIN 从未关联/测过的词数（Q3=B：母集是 kw_master，不是 legacy keyword）。',
    type: 'number',
    source: 'kwCoverageAgainstMaster（计划新增；lead Q3=B 拍板）：kw_master 有、asin_keyword 无该 ASIN 行的词数。',
    missingBehavior: 'placeholder',
    placeholder: '本处未记',
    maxLength: 32,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: ['kw_library_total_n'],
    evidenceClass: 'kw_coverage',
    timeSource: 'max(kw_master.updated_at)',
    requiredBasis: '契约表 §2.5 声明为 placeholder；{{kw_untested_n}} 的母集是 {{kw_library_total_n}}，未测 ≠ 缺席。',
    defaultBehavior: '缺值印「本处未记」。',
  }),
  kw_scan_depth: defineVariable({
    name: 'kw_scan_depth',
    label: '最近扫描深度',
    description: '最近一次扫描深度（前 N 名）。',
    type: 'number',
    source: 'max(asin_keyword.scan_depth)；现有 keywordCoverage 不返回单值 max，需要补 reader。',
    missingBehavior: 'fail',
    maxLength: 32,
    appliesTo: ['search_terms'],
    pairWith: ['kw_gap_n'],
    evidenceClass: 'kw_coverage',
    timeSource: 'max(asin_keyword.collected_at)',
    requiredBasis: '契约表 §2.5 声明为 fail；{{kw_scan_depth}} 缺了，{{kw_gap_n}} 的「没进前 N」不可解释。',
    defaultBehavior: '拒绝渲染并点名。',
  }),
  kw_scan_observed_at: defineVariable({
    name: 'kw_scan_observed_at',
    label: '关键词扫描时间',
    description: '关键词扫描时间（ISO 8601）。',
    type: 'string',
    source: 'max(asin_keyword.collected_at)；现有 keywordCoverage 不返回单值 max，需要补 reader。',
    missingBehavior: 'fail',
    maxLength: 40,
    appliesTo: ['all'],
    evidenceClass: 'kw_coverage',
    timeSource: '自身',
    requiredBasis: '契约表 §2.5 声明为 fail；{{kw_scan_observed_at}} 缺时间，所有 kw 数值都失去扫描时点。',
    defaultBehavior: '拒绝渲染并点名。',
  }),

  /* ── 第 6 类：SEO·GEO（5，四组各自计数，禁总分） ───────────────────────── */
  geo_summary: defineVariable({
    name: 'geo_summary',
    label: 'GEO 四组事实摘要',
    description: 'GEO 四组事实摘要：①属性完整度 ②Q&A 覆盖 ③对比维度可比性 ④事实一致性；四组各自分子/分母/来源/时间；组④ state=pending（判据待 O-02 拍板），不合成总分。',
    type: 'string',
    source: 'readGeoFacts / buildGeoFacts（src/domain/geo/citability.js）；四组是平级对象，返回体没有聚合键。',
    missingBehavior: 'placeholder',
    placeholder: 'GEO 四组事实：本仓没有来源 / 未计算',
    maxLength: 4000,
    appliesTo: ['title', 'bullets', 'description', 'aplus', 'attributes'],
    pairWith: [],
    evidenceClass: 'geo',
    timeSource: '各组 observedAt（组内；组②/组④为 null）',
    requiredBasis: '契约表 §2.6 声明为 placeholder；模板引用 {{geo_summary}} 时缺值印「本仓没有来源 / 未计算」。',
    defaultBehavior: '缺值印「GEO 四组事实：本仓没有来源 / 未计算」。',
  }),
  geo_attribute_group: defineVariable({
    name: 'geo_attribute_group',
    label: 'GEO 属性完整度',
    description: '①属性完整度：已建模属性有值数 / 43。',
    type: 'object',
    source: 'readGeoFacts → buildGeoFacts → attributeGroupFromHealth（src/domain/geo/citability.js）；复用 buildAsinHealthSummary 的 attributes-43 门（src/domain/asin/health.js）/ attributeCoverage。',
    missingBehavior: 'placeholder',
    placeholder: { state: '本处未记' },
    maxLength: 600,
    appliesTo: ['attributes', 'title', 'bullets'],
    pairWith: [],
    evidenceClass: 'geo',
    timeSource: 'asin_field_source.observed_at（组内 observedAt）',
    requiredBasis: '契约表 §2.6 声明为 placeholder；{{geo_attribute_group}} 的分母固定 43，0/43 是事实。',
    defaultBehavior: '缺值印 {"state":"本处未记"}。',
  }),
  geo_qa_group: defineVariable({
    name: 'geo_qa_group',
    label: 'GEO Q&A 覆盖',
    description: '②Q&A 覆盖：本仓没有采集节，整组 no-source，numerator/denominator 为 null，不是 0/0。',
    type: 'object',
    source: 'buildGeoFacts → qaGroup（src/domain/geo/citability.js）；无表、无采集节，qa_1..qa_8 只是优化草案字段声明。',
    missingBehavior: 'placeholder',
    placeholder: { state: 'no-source', reason: '本仓没有来源（Q&A 没有采集节）' },
    maxLength: 600,
    appliesTo: ['qa', 'aplus', 'description'],
    pairWith: [],
    evidenceClass: 'geo',
    timeSource: 'null（组内 observedAt=null；本仓没有来源）',
    requiredBasis: '契约表 §2.6 声明为 placeholder；{{geo_qa_group}} 只能给 no-source，禁止 0/0 或伪造 Q&A。',
    defaultBehavior: '缺值印 {"state":"no-source","reason":"本仓没有来源（Q&A 没有采集节）"}。',
  }),
  geo_comparability_group: defineVariable({
    name: 'geo_comparability_group',
    label: 'GEO 对比维度可比性',
    description: '③对比维度可比性：双侧同期可比维度数 / 维度总数；期不一致的维度单列，不进分子；没有竞品组时 state=no-source，numerator/denominator 为 null（不出 0/43）。',
    type: 'object',
    source: 'buildGeoFacts → compareDimensions（src/domain/geo/citability.js），测量期判据复用 buildEvidenceView（src/domain/keywords/competitor.js）。',
    missingBehavior: 'placeholder',
    placeholder: { state: 'no-source', reason: '本仓没有来源（没有竞品事实）' },
    maxLength: 600,
    appliesTo: ['title', 'bullets', 'search_terms'],
    pairWith: [],
    evidenceClass: 'geo',
    timeSource: '双侧 periods（组内 observedAtAll）',
    requiredBasis: '契约表 §2.6 声明为 placeholder；{{geo_comparability_group}} 期不一致时 judgement_blocked:true，不出判读。',
    defaultBehavior: '缺值印 {"state":"no-source","reason":"本仓没有来源（没有竞品事实）"}。',
  }),
  geo_consistency_group: defineVariable({
    name: 'geo_consistency_group',
    label: 'GEO 事实一致性',
    description: '④事实一致性：T71 当前 state=pending（判据待 O-02 拍板），numerator/denominator 为 null；本组不读 field_conflict、不给一致性结论。',
    type: 'object',
    source: 'buildGeoFacts → consistencyGroup（src/domain/geo/citability.js）；state=pending，本组不读表。',
    missingBehavior: 'placeholder',
    placeholder: { state: '本处未记' },
    maxLength: 600,
    appliesTo: ['attributes', 'title', 'bullets'],
    pairWith: [],
    evidenceClass: 'geo',
    timeSource: 'null（组内 observedAt=null；判据未拍板）',
    requiredBasis: '契约表 §2.6 声明为 placeholder；{{geo_consistency_group}} 只给 state=pending 与「判据待 O-02 拍板」，不产一致性结论。',
    defaultBehavior: '缺值印 {"state":"本处未记"}。',
  }),

  /* ── 第 7 类：最新政策规则（4） ────────────────────────────────────────── */
  policy_check_summary: defineVariable({
    name: 'policy_check_summary',
    label: '政策检查摘要',
    description: '最近一次政策检查摘要：状态（policy_check_runs.status）、比对源数 source_count、差异数 diff_count（新增/变更/疑似失效）、观察时间 observed_at；未确认差异不注入。',
    type: 'string',
    source: 'policy_check_runs（status / source_count / diff_count / observed_at）+ policy_candidates；reader latestCheckRun（src/store/policy-candidate.js）/ startPolicyCheck（src/domain/policy/candidate.js）。',
    missingBehavior: 'placeholder',
    placeholder: '还没检查过最新政策（T72 未跑）',
    maxLength: 2000,
    appliesTo: ['all'],
    pairWith: ['policy_check_state', 'policy_observed_at'],
    evidenceClass: 'policy',
    timeSource: 'policy_check_runs.observed_at（latestCheckRun 映射为 observedAt）',
    requiredBasis: '契约表 §2.7 声明为 placeholder；模板引用 {{policy_check_summary}} 时缺值印「还没检查过最新政策（T72 未跑）」。',
    defaultBehavior: '缺值印「还没检查过最新政策（T72 未跑）」。',
  }),
  policy_check_state: defineVariable({
    name: 'policy_check_state',
    label: '政策检查状态',
    description: '检查运行状态：running / pending_confirm / confirmed / rejected / failed（列名是 status，不是 state）。',
    type: 'string',
    source: 'policy_check_runs.status；latestCheckRun（src/store/policy-candidate.js）映射为 status。',
    missingBehavior: 'placeholder',
    placeholder: '未检查',
    maxLength: 40,
    appliesTo: ['all'],
    pairWith: ['policy_check_summary'],
    evidenceClass: 'policy',
    timeSource: 'policy_check_runs.observed_at',
    requiredBasis: '契约表 §2.7 声明为 placeholder；{{policy_check_state}} 与 {{policy_check_summary}} 同源。',
    defaultBehavior: '缺值印「未检查」。',
  }),
  policy_diff_count: defineVariable({
    name: 'policy_diff_count',
    label: '政策检查差异数',
    description: '本次检查的差异条数（新增+变更+疑似失效）。',
    type: 'number',
    source: 'policy_check_runs.diff_count；latestCheckRun 映射为 diffCount。',
    missingBehavior: 'placeholder',
    placeholder: '未检查',
    maxLength: 32,
    appliesTo: ['all'],
    pairWith: ['policy_observed_at'],
    evidenceClass: 'policy',
    timeSource: 'policy_check_runs.observed_at',
    requiredBasis: '契约表 §2.7 声明为 placeholder；{{policy_diff_count}} 的 0 是事实（检查过、无差异），未检查 ≠ 0。',
    defaultBehavior: '缺值印「未检查」。',
  }),
  policy_observed_at: defineVariable({
    name: 'policy_observed_at',
    label: '政策检查时间',
    description: '政策检查时间（ISO 8601）。',
    type: 'string',
    source: 'policy_check_runs.observed_at；latestCheckRun 映射为 observedAt。',
    missingBehavior: 'fail',
    maxLength: 40,
    appliesTo: ['all'],
    pairWith: [],
    evidenceClass: 'policy',
    timeSource: '自身',
    requiredBasis: '契约表 §2.7 声明为 fail；{{policy_observed_at}} 缺时间，{{policy_diff_count}} 就不知道是哪次检查的差异数。',
    defaultBehavior: '拒绝渲染并点名。',
  }),
}

/** 43 个名字，派生 —— 永远不是第二份手写名单。 */
export const PROMPT_VARIABLES = Object.freeze(Object.keys(PROMPT_VARIABLE_SPECS))

/** 旧名字保留：既有调用方读的是这个名字。 */
export const PROMPT_VARIABLE_NAMES = PROMPT_VARIABLES

/**
 * 加载期契约校验。任何一条不满足 → 整张注册表拒绝加载。
 *
 * @param {Record<string, object>} specs
 * @throws {PromptVariableContractError} code = CONTRACT_MISSING
 */
export function validatePromptVariableRegistry(specs = PROMPT_VARIABLE_SPECS) {
  const errors = []
  const entries = Object.entries(specs)
  for (const [key, spec] of entries) {
    const where = `变量 ${key}`
    if (spec === null || typeof spec !== 'object') {
      errors.push(`${where}: 不是对象`)
      continue
    }
    for (const field of ['name', 'label', 'description', 'type', 'source', 'requiredBasis',
      'defaultBehavior', 'timeSource', 'evidenceClass', 'format']) {
      if (spec[field] === undefined || spec[field] === null || String(spec[field]).trim() === '') {
        errors.push(`${where}: 字段 ${field} 为空`)
      }
    }
    if (spec.name !== key) errors.push(`${where}: name 字段是 ${JSON.stringify(spec.name)}，与键不一致`)
    if (!PROMPT_VARIABLE_TYPES.includes(spec.type)) errors.push(`${where}: type 非法 ${JSON.stringify(spec.type)}`)
    if (!PROMPT_MISSING_BEHAVIORS.includes(spec.missingBehavior)) {
      errors.push(`${where}: missingBehavior 非法 ${JSON.stringify(spec.missingBehavior)}`)
    }
    if (typeof spec.required !== 'boolean') errors.push(`${where}: required 不是布尔`)
    if (spec.required !== (spec.missingBehavior === 'fail')) {
      errors.push(`${where}: 违反不变式 required === (missingBehavior === 'fail')`)
    }
    if (!Number.isInteger(spec.maxLength) || spec.maxLength <= 0) errors.push(`${where}: maxLength 不是正整数`)
    if (!Array.isArray(spec.appliesTo) || spec.appliesTo.length === 0) {
      errors.push(`${where}: appliesTo 为空`)
    } else {
      for (const field of spec.appliesTo) {
        if (!PROMPT_APPLIES_TO.includes(field)) errors.push(`${where}: appliesTo 含非法字段 ${JSON.stringify(field)}`)
      }
    }
    if (!Array.isArray(spec.pairWith)) errors.push(`${where}: pairWith 不是数组`)
    if (spec.missingBehavior === 'omit' && spec.type !== 'string') {
      errors.push(`${where}: omit 只能用于 string 可选段`)
    }
    if (spec.missingBehavior === 'placeholder') {
      const placeholder = spec.placeholder
      if (placeholder === undefined || placeholder === null || placeholder === '') {
        errors.push(`${where}: placeholder 缺固定文案`)
      } else if (typeof placeholder === 'string' && ['0', '—', 'N/A'].includes(placeholder)) {
        errors.push(`${where}: placeholder 是禁止的占位值 ${JSON.stringify(placeholder)}`)
      } else if (typeof placeholder === 'string' && placeholder.trim() === '') {
        errors.push(`${where}: placeholder 是空白`)
      }
      /* placeholder 必须与变量 type 同形：object 不能拿字符串顶，array 不能拿对象顶。 */
      if (spec.type === 'object' && (typeof placeholder !== 'object' || placeholder === null || Array.isArray(placeholder))) {
        errors.push(`${where}: type=object 的 placeholder 不是对象`)
      }
      if (spec.type === 'array' && !Array.isArray(placeholder)) {
        errors.push(`${where}: type=array 的 placeholder 不是数组`)
      }
      if ((spec.type === 'string' || spec.type === 'number') && typeof placeholder !== 'string') {
        errors.push(`${where}: type=${spec.type} 的 placeholder 不是字符串文案`)
      }
    }
  }
  if (errors.length > 0) {
    throw new PromptVariableContractError(
      `prompt variable registry refused to load (CONTRACT_MISSING):\n- ${errors.join('\n- ')}`,
      errors,
    )
  }
  return true
}

/* 加载即校验：坏契约不能等到第一次渲染才炸。 */
validatePromptVariableRegistry(PROMPT_VARIABLE_SPECS)

/** 一个变量的 spec；闭集外的名字返回 `null`。 */
export function promptVariableSpec(name) {
  return Object.hasOwn(PROMPT_VARIABLE_SPECS, String(name)) ? PROMPT_VARIABLE_SPECS[String(name)] : null
}

/**
 * 值是不是「缺失」。四态归一在这里，不在渲染器里各写一份。
 *
 * `0` / `'0'` / `false` 是事实，不是缺失；`''` / 纯空白 / `null` / `undefined` /
 * `[]` / `{}` 是缺失。`NaN` 不是一个可读的测量值，也归一为缺失（它渲染出来就是
 * "NaN"，比空白更糟）。
 */
export function isPromptValueMissing(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (typeof value === 'number') return Number.isNaN(value)
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/** 递归按 key 排序，保证同一份对象永远渲染成同一段文本。 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key])
    return out
  }
  return value
}

/** 稳定的 JSON：对象 key 排序、数组保序。 */
export function stableStringify(value) {
  return JSON.stringify(sortDeep(value))
}

function typeMismatch(spec, value) {
  return new PromptVariableError(
    'TYPE_MISMATCH',
    `变量 ${spec.name} 期望 ${spec.type}，收到 ${Array.isArray(value) ? 'array' : typeof value}；`
    + '不把类型不符的值 String() 成一段看起来像事实的文本。',
    { variable: spec.name, expected: spec.type, actual: Array.isArray(value) ? 'array' : typeof value },
  )
}

/**
 * 按注册的 type 序列化一个**有值**的变量。
 *
 * - `string` → 原样
 * - `number` → 数字（数字字符串接受，`NaN` / `Infinity` 拒绝）
 * - `object` → 稳定 key 序 JSON（绝不 `[object Object]`）
 * - `array`  → 「、」连接（元素是对象则逐个稳定 JSON）
 */
export function formatPromptValue(value, spec) {
  switch (spec.type) {
    case 'string': {
      if (value !== null && typeof value === 'object') throw typeMismatch(spec, value)
      return String(value)
    }
    case 'number': {
      const number = typeof value === 'number' ? value : Number(String(value).trim())
      if (!Number.isFinite(number)) throw typeMismatch(spec, value)
      return String(number)
    }
    case 'object': {
      if (Array.isArray(value) || value === null || typeof value !== 'object') throw typeMismatch(spec, value)
      return stableStringify(value)
    }
    case 'array': {
      if (!Array.isArray(value)) throw typeMismatch(spec, value)
      return value.map(item => (item !== null && typeof item === 'object' ? stableStringify(item) : String(item))).join('、')
    }
    default:
      throw new PromptVariableContractError(`变量 ${spec.name} 的 type ${JSON.stringify(spec.type)} 没有序列化规则`)
  }
}

/** 注册表里的固定 placeholder 文案，按变量类型序列化（number 的文案是字符串，照印）。 */
export function formatPromptPlaceholder(spec) {
  if (spec.missingBehavior !== 'placeholder') return null
  /* placeholder 是注册表里的固定字面量，按声明顺序印（state 在 reason 前面）；
     只有**运行时的值**才需要稳定 key 序（见 formatPromptValue）。 */
  if (spec.type === 'object') return JSON.stringify(spec.placeholder)
  if (spec.type === 'array') {
    return spec.placeholder.map(item => (item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item))).join('、')
  }
  return String(spec.placeholder)
}

/** 按渲染后字符数截断（按码点，避免把 emoji / 中文切成半个）。 */
export function truncatePromptValue(text, maxLength) {
  const characters = Array.from(text)
  if (characters.length <= maxLength) return { text, truncated: false, originalLength: characters.length }
  return {
    text: characters.slice(0, maxLength).join(''),
    truncated: true,
    originalLength: characters.length,
  }
}

/** 人类可读的缺失行为（工具/页面表格用；机器判定读 `spec.missingBehavior`）。 */
export function describeMissingBehavior(spec) {
  if (spec.missingBehavior === 'omit') return 'omit：整段（连自带标点）消失，记入 droppedOptional'
  if (spec.missingBehavior === 'fail') return 'fail：拒绝渲染并点名'
  return `placeholder：${formatPromptPlaceholder(spec)}`
}

/** 一个变量的简短引用，供报告/工具行使用。 */
function brief(name) {
  const spec = promptVariableSpec(name)
  return {
    name,
    label: spec?.label ?? name,
    description: spec?.description ?? null,
    source: spec?.source ?? null,
    required: spec?.required === true,
    missingBehavior: spec?.missingBehavior ?? null,
    placeholder: spec?.placeholder,
    appliesTo: spec?.appliesTo ?? [],
  }
}

/**
 * 报告一个模板引用了什么、缺了什么。**不渲染、不抛缺失错误** —— 渲染器负责拒绝，
 * 这个函数负责把「缺了什么、为什么」说清楚（`amzn_prompt_preview` / `resolvePrompts`
 * 的既有调用方读它）。
 *
 * 三态分开报：
 *   - `missingRequired` —— `fail` 变量缺失（渲染会被拒绝）
 *   - `placeholders`    —— `placeholder` 变量缺失（文本里印固定文案）
 *   - `droppedOptional` —— `omit` 变量缺失（整段消失）
 *   - `pairMissing`     —— A 有值但配对的 B 不在包里（独立 PAIR_MISSING）
 *
 * @param {string|{children: Array}} body
 * @param {Record<string, unknown>} variables
 */
export function variableReport(body, variables = {}) {
  const parsed = body !== null && typeof body === 'object' && Array.isArray(body.children)
    ? body
    : parsePromptTemplate(body, PROMPT_VARIABLES)
  const bag = variables !== null && typeof variables === 'object' ? variables : {}
  const usage = templateUsage(parsed)

  const missingRequired = []
  const droppedOptional = []
  const placeholders = []
  const pairMissing = []

  for (const name of parsed.variables) {
    const spec = promptVariableSpec(name)
    if (!spec) continue
    if (!isPromptValueMissing(bag[name])) continue
    /* ⑪ 边界（b11）：空串 `''` 对谁都是「缺失」（整段消失）；**只有空白**的 `'  '`
       对必填（fail）是「洞」，对可选变量是「有值但为空」——可选段照常渲染。
       两者只差一个字符，话却不一样：「用户没填」和「用户填了个空白」。
       其余缺失（null/undefined/[]/{}）对谁都是缺失。 */
    if (spec.missingBehavior !== 'fail' && typeof bag[name] === 'string' && bag[name].length > 0) continue
    if (spec.missingBehavior === 'fail') missingRequired.push({ ...brief(name), behavior: 'fail' })
    else if (spec.missingBehavior === 'omit') droppedOptional.push({ ...brief(name), behavior: 'omit' })
    else {
      placeholders.push({
        ...brief(name),
        behavior: 'placeholder',
        text: formatPromptPlaceholder(spec),
      })
    }
  }

  /* 配对只在「A 真的有值」时检查：A 自己缺值时它走自己的 placeholder/fail，
     不会把一个数字当事实注入；此时再报 B 缺只会制造噪音。 */
  for (const name of parsed.variables) {
    const spec = promptVariableSpec(name)
    if (!spec || isPromptValueMissing(bag[name])) continue
    for (const pair of spec.pairWith) {
      if (isPromptValueMissing(bag[pair])) {
        pairMissing.push({
          name: pair,
          requiredBy: name,
          label: promptVariableSpec(pair)?.label ?? pair,
          behavior: 'fail',
        })
      }
    }
  }

  const missingNamed = []
  for (const item of [...missingRequired, ...pairMissing]) {
    if (!missingNamed.some(entry => entry.name === item.name)) missingNamed.push(item)
  }
  /* `degraded` 描述**渲染**的降级（fail / placeholder）；配对缺失是独立的
     `pairMissing` 列表（PAIR_MISSING），不混进这个布尔值。 */
  const degradedVariables = [...missingRequired, ...placeholders]
  const degraded = degradedVariables.length > 0

  let reason = null
  if (missingRequired.length > 0) {
    reason = `必填变量缺失：${missingRequired.map(item => item.name).join('、')} —— `
      + '这一段现在是空的，不是提示词选择了不说。'
  } else if (pairMissing.length > 0) {
    reason = `配对变量缺失：${pairMissing.map(item => `${item.name}（被 ${item.requiredBy} 需要）`).join('、')} —— `
      + '单个数字没有分母/时间，会被读成事实。'
  } else if (placeholders.length > 0) {
    reason = `可选事实缺失，已印固定占位：${placeholders.map(item => item.name).join('、')}。`
  } else if (droppedOptional.length > 0) {
    reason = `可选段被整段移除：${droppedOptional.map(item => item.name).join('、')}（设计内降级，不是缺失）。`
  }

  return {
    referenced: parsed.variables,
    usage,
    missingRequired,
    missingNamed,
    droppedOptional,
    placeholders,
    pairMissing,
    degradedVariables,
    degraded,
    reason,
  }
}

/**
 * 注册表作为行，供工具/页面表格。派生自 specs，没有第二份描述。
 *
 * `missingBehavior` 在这一层转成人读的句子（页面/工具直接打印它）；
 * 机器判定请读 `missingBehaviorKind`。
 */
export function promptVariableRows() {
  return PROMPT_VARIABLES.map(name => {
    const spec = PROMPT_VARIABLE_SPECS[name]
    return {
      name,
      label: spec.label,
      type: spec.type,
      required: spec.required,
      requiredBasis: spec.requiredBasis,
      maxLength: spec.maxLength,
      sensitive: spec.sensitive,
      source: spec.source,
      description: spec.description,
      defaultBehavior: spec.defaultBehavior,
      missingBehavior: describeMissingBehavior(spec),
      missingBehaviorKind: spec.missingBehavior,
      placeholder: spec.placeholder,
      appliesTo: spec.appliesTo,
      pairWith: spec.pairWith,
      evidenceClass: spec.evidenceClass,
      timeSource: spec.timeSource,
      format: spec.format,
    }
  })
}

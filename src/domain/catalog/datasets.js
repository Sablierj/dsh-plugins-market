/**
 * The data catalogue, as a declaration.
 *
 * Three levels — asset type → dataset → field — and every level says what the
 * thing *is* rather than what it currently holds. `rowCount` is the one field
 * filled in at read time; everything else here is a statement about the schema,
 * and a statement about the schema can be checked against the schema.
 *
 * ## Why this is data and not prose
 *
 * A catalogue written as a document is wrong the first time a column is added,
 * and nobody notices because nothing reads it. Here every entry is asserted
 * against `PRAGMA table_info`: a dataset whose `table` does not exist fails, and
 * a declared field that is not a real column fails. That is the check that
 * catches the failure this catalogue exists to prevent — a rule pointing at a
 * field name that does not exist, which never fires and reads exactly like a
 * check that passed.
 *
 * ## The nine attributes, and why each one earns its place
 *
 *   - `grain` — what one row means. Without it "the count" is ambiguous: a row
 *     per ASIN and a row per (ASIN, snapshot) are different numbers.
 *   - `primaryKey` — what makes a row unique. A dataset with no key cannot be
 *     joined to anything, and a "duplicate" has no meaning.
 *   - `unit` — rows? fields? files? The number next to it is unreadable without
 *     this.
 *   - `nullSemantics` — **what a NULL in this table means.** This is the one that
 *     matters most and the one most often missing: a NULL title (we looked, it
 *     was not there) and a NULL `observed_at` (nobody recorded it) are different
 *     facts, and a catalogue that showed both as "empty" would make the second
 *     look like the first. Three values, from `domain/states.js`:
 *     `missing` / `unknown` / `failed`.
 *   - `sources` — where the rows come from. A dataset nobody writes is a dataset
 *     that is always empty, which is worth knowing before you build on it.
 *   - `rowCount` — filled at read time, from one place (`datasetRowCounts`).
 *   - `ownerRole` — who is responsible, from `PERMISSION_LEVELS`. Phase 1 has no
 *     user table (Q4), so this is a **declared default**, not an editable field.
 *   - `freshnessClass` — the §33 band that applies, or `null` when no source
 *     states one for this dataset.
 *   - `downstream` — which modules read it. A dataset nothing reads is a
 *     candidate for deletion, and that is a decision somebody has to make.
 */

/** The three null states a catalogue entry can declare. */
export const NULL_STATES = ['missing', 'unknown', 'failed']

/** The asset types, in the order the catalogue draws them. */
export const ASSET_TYPES = [
  { id: 'product', label: '商品与 listing' },
  { id: 'keyword', label: '关键词' },
  { id: 'collection', label: '采集' },
  { id: 'rules', label: '规则与政策' },
  { id: 'optimization', label: '优化' },
  { id: 'config', label: '配置' },
]

/**
 * Every dataset the plugin knows about.
 *
 * `fields` lists the columns a reader actually uses — not every column in the
 * table. A catalogue that mirrored the schema would be a second copy of it, and
 * the copy would be wrong after the next migration; a catalogue that names the
 * fields people depend on is a statement about the *interface*, which is the
 * thing that should be stable.
 */
export const DATASETS = [
  {
    id: 'asin',
    assetType: 'product',
    label: 'ASIN 主表',
    table: 'asin',
    grain: '一行 = 一个 (ASIN, 站点)',
    primaryKey: ['asin', 'marketplace'],
    unit: '行',
    nullSemantics: {
      state: 'missing',
      note: '字段为空 = 这一轮没采到（商品本身可能就没有）。它不是「没采过」——没采过的 ASIN 根本没有这一行。',
      fields: { product_line_id: 'unknown', primary_source_id: 'unknown' },
    },
    sources: ['browser-local', 'manual'],
    ownerRole: 'data_steward',
    freshnessClass: 7,
    downstream: ['optimize', 'report', 'asin'],
    fields: ['asin', 'marketplace', 'title', 'brand', 'price', 'currency', 'bsr', 'category', 'rating', 'reviews', 'image_url', 'product_line_id', 'primary_source_id', 'first_seen_at', 'updated_at'],
  },
  {
    id: 'asin_snapshot',
    assetType: 'product',
    label: '采集快照',
    table: 'asin_snapshot',
    grain: '一行 = 一次采集结果（不覆盖，追加）',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'failed',
      note: 'payload_json 为空 = 页面拿到了但解析失败。它不是「没采过」——没采过就不会有这一行。',
      fields: { source_id: 'unknown' },
    },
    sources: ['browser-local'],
    ownerRole: 'data_steward',
    freshnessClass: 7,
    downstream: ['asin', 'optimize'],
    fields: ['id', 'asin', 'marketplace', 'source_id', 'collected_at', 'payload_json'],
  },
  {
    id: 'asin_field_source',
    assetType: 'product',
    label: '字段来源（多源并存）',
    table: 'asin_field_source',
    grain: '一行 = 一个字段的一个来源',
    primaryKey: ['asin', 'marketplace', 'field', 'source_id'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'observed_at 为空 = 这个值是什么时候观测到的没人记录（v24 之前的老行）。**不回填今天**——那会把「不知道」写成「今天」。',
      fields: { value: 'missing', quality_state: 'unknown' },
    },
    sources: ['browser-local', 'manual'],
    ownerRole: 'data_steward',
    freshnessClass: null,
    downstream: ['quality', 'optimize'],
    fields: ['asin', 'marketplace', 'field', 'source_id', 'value', 'confidence', 'updated_at', 'source_type', 'observed_at', 'ingested_at', 'raw_value', 'raw_unit', 'parser_version', 'quality_state'],
  },
  {
    id: 'listing',
    assetType: 'product',
    label: 'Listing 正文',
    table: 'listing',
    grain: '一行 = 一个 (ASIN, 站点) 的当前文案',
    primaryKey: ['asin', 'marketplace'],
    unit: '行',
    nullSemantics: {
      state: 'missing',
      note: '描述为空 = 这个 listing 没有描述。空字符串与 NULL 同义，都表示「没有」。',
    },
    sources: ['manual', 'browser-local'],
    ownerRole: 'ops_editor',
    freshnessClass: 30,
    downstream: ['optimize', 'report'],
    fields: ['asin', 'marketplace', 'title', 'bullets_json', 'description', 'a_plus', 'version', 'updated_at'],
  },
  {
    id: 'keyword',
    assetType: 'keyword',
    label: '关键词库（浏览器测量）',
    table: 'keyword',
    grain: '一行 = 一个 (关键词, 站点)',
    primaryKey: ['keyword', 'marketplace'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'search_volume 为空 = 没人测过搜索量。**不是 0**——0 是一个测出来的值。',
      fields: { tier: 'unknown', difficulty: 'unknown' },
    },
    sources: ['browser-local', 'manual'],
    ownerRole: 'ops_editor',
    freshnessClass: 90,
    downstream: ['research', 'pipeline', 'optimize'],
    fields: ['keyword', 'marketplace', 'tier', 'search_volume', 'difficulty', 'first_seen_at', 'updated_at'],
  },
  {
    id: 'asin_keyword',
    assetType: 'keyword',
    label: 'ASIN × 关键词（排名测量）',
    table: 'asin_keyword',
    grain: '一行 = 一个 ASIN 在一个词上的一次测量',
    primaryKey: ['asin', 'marketplace', 'keyword', 'source_id'],
    unit: '行',
    nullSemantics: {
      state: 'missing',
      note: 'rank 为空 = 测过、在扫描深度内没找到。**不是「没测」**——没测过的词不会出现在这里。',
      fields: { search_volume: 'unknown', tier: 'unknown' },
    },
    sources: ['browser-local'],
    ownerRole: 'ops_editor',
    freshnessClass: 7,
    downstream: ['research', 'competitor', 'optimize'],
    fields: ['asin', 'marketplace', 'keyword', 'source_id', 'rank', 'search_volume', 'collected_at', 'page', 'scan_depth', 'tier'],
  },
  {
    id: 'kw_master',
    assetType: 'keyword',
    label: '关键词总库（导入）',
    table: 'kw_master',
    grain: '一行 = 一个 (关键词, 站点) 的汇总',
    primaryKey: ['keyword', 'marketplace'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'search_volume 为空 = 导入的文件里没有这一项。',
      fields: { product_line: 'unknown', product_line_matched: 'unknown' },
    },
    sources: ['manual'],
    ownerRole: 'ops_editor',
    freshnessClass: 90,
    downstream: ['kw', 'pipeline', 'optimize'],
    fields: ['keyword', 'marketplace', 'word_id', 'product_line', 'product_line_matched', 'search_volume', 'asin_count', 'impressions', 'clicks', 'updated_at'],
  },
  {
    id: 'collection_task',
    assetType: 'collection',
    label: '采集任务',
    table: 'collection_task',
    grain: '一行 = 一次提交的采集任务',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'finished_at 为空 = 还没跑完。**不是「失败」**——失败会写 error。',
      fields: { error: 'missing', result_json: 'failed', progress_json: 'unknown' },
    },
    sources: ['browser-local', 'manual'],
    ownerRole: 'ops_editor',
    freshnessClass: null,
    downstream: ['collect', 'home'],
    fields: ['id', 'source_id', 'targets_json', 'fields_json', 'status', 'submitted_at', 'finished_at', 'error', 'result_json', 'progress_json', 'updated_at', 'kind'],
  },
  {
    id: 'rule',
    assetType: 'rules',
    label: '规则行',
    table: 'rule',
    grain: '一行 = 一个规则版本里的一条规则',
    primaryKey: ['rule_set_version', 'rule_id'],
    unit: '行',
    nullSemantics: {
      state: 'missing',
      note: 'body_md 为空 = 这条 code 规则没有正文（判定在代码里）。**不是缺失**——code 规则本来就不带正文。',
      fields: { deleted_at: 'unknown', params_json: 'missing' },
    },
    sources: ['manual'],
    ownerRole: 'reviewer',
    freshnessClass: null,
    downstream: ['rules', 'optimize', 'home'],
    fields: ['rule_set_version', 'rule_id', 'kind', 'applies_to_json', 'scope', 'severity', 'title', 'body_md', 'source', 'params_json', 'sort_order', 'enabled', 'deleted_at', 'updated_at'],
  },
  {
    id: 'policy',
    assetType: 'rules',
    label: '政策',
    table: 'policy',
    grain: '一行 = 一份导入的政策',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'effective_from 为空 = 政策没说什么时候生效。**不猜**——猜出来的日期会被当成依据。',
      fields: { severity_hint: 'unknown', published_at: 'unknown', superseded_by: 'unknown', deleted_at: 'unknown' },
    },
    sources: ['manual'],
    ownerRole: 'reviewer',
    freshnessClass: null,
    downstream: ['policy', 'rules'],
    fields: ['id', 'source_id', 'marketplace', 'title', 'body_md', 'url', 'published_at', 'effective_from', 'effective_to', 'severity_hint', 'status', 'superseded_by', 'fields_json', 'deleted_at'],
  },
  {
    id: 'prompt',
    assetType: 'optimization',
    label: '提示词',
    table: 'prompt',
    grain: '一行 = 一条提示词（按模块 + 场景）',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'layer 为空 = 这是 button 场景（按钮没有分层）。**不是漏填**。',
      fields: { deleted_at: 'unknown', variables_json: 'failed' },
    },
    sources: ['manual'],
    ownerRole: 'ops_editor',
    freshnessClass: null,
    downstream: ['prompts', 'optimize'],
    fields: ['id', 'set_id', 'scenario', 'layer', 'label', 'body', 'variables_json', 'version', 'sort_order', 'enabled', 'deleted_at', 'updated_at'],
  },
  {
    id: 'optimization_run',
    assetType: 'optimization',
    label: '优化轮次',
    table: 'optimization_run',
    grain: '一行 = 一个 ASIN 的一轮优化',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'finished_at 为空 = 这一轮还没跑完。prompt_version / agent_run_id 为空 = 这一轮**没有记录**'
        + '（v47 之前建的轮次，或建轮次时调用方没带上），不是「本系统没有 Prompt 版本 / Agent 流程」。',
      fields: { report_md: 'missing', report_html: 'missing', summary: 'missing', error: 'missing', prompt_version: 'missing', agent_run_id: 'missing' },
    },
    sources: ['manual'],
    ownerRole: 'ops_editor',
    freshnessClass: null,
    downstream: ['optimize', 'report'],
    fields: ['id', 'asin', 'marketplace', 'status', 'session_id', 'report_md', 'started_at', 'finished_at', 'rules_version', 'rules_json', 'package_json', 'summary', 'error', 'report_html', 'rule_set_version', 'prompt_version', 'agent_run_id'],
  },
  {
    id: 'optimization_draft',
    assetType: 'optimization',
    label: '优化草案',
    table: 'optimization_draft',
    grain: '一行 = 一轮优化里一个字段的改写',
    primaryKey: ['run_id', 'field'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'accepted 为空 = 还没人做决定（**不是「不采纳」**，不采纳会写 0）；context_id 为空 = 上下文未知，这一条不能提交。',
      fields: { before: 'missing', violations_json: 'missing', severity: 'unknown' },
    },
    sources: ['manual'],
    ownerRole: 'reviewer',
    freshnessClass: null,
    downstream: ['optimize', 'home'],
    fields: ['run_id', 'field', 'before', 'after', 'violations_json', 'keywords_json', 'severity', 'rationale', 'accepted', 'context_id', 'updated_at'],
  },
  {
    id: 'setting',
    assetType: 'config',
    label: '设置',
    table: 'setting',
    grain: '一行 = 一个设置键',
    primaryKey: ['key'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'workspace_id 为空 = 属于默认空间（v20 之前写的行）。',
      fields: { note: 'missing' },
    },
    sources: ['manual'],
    ownerRole: 'workspace_admin',
    freshnessClass: null,
    downstream: ['settings', 'collect'],
    fields: ['key', 'value_json', 'updated_at', 'note', 'workspace_id'],
  },
  {
    id: 'source',
    assetType: 'config',
    label: '数据源',
    table: 'source',
    grain: '一行 = 一个数据源',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'last_health 为空 = 还没探测过。config_json 里的凭据**任何页面与工具都不会读出来**。',
      fields: { config_json: 'unknown', checked_at: 'unknown' },
    },
    sources: ['manual'],
    ownerRole: 'workspace_admin',
    freshnessClass: null,
    downstream: ['settings', 'collect'],
    fields: ['id', 'kind', 'name', 'enabled', 'config_json', 'notes', 'last_health', 'checked_at', 'workspace_id'],
  },
  {
    id: 'publication_record',
    assetType: 'optimization',
    label: '发布记录',
    table: 'publication_record',
    grain: '一行 = 一次人工发布（或一次手工登记）',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'missing',
      note: 'run_id 为空 = 手工登记（§6：不计算草案差异、不参与发布率统计），**不是**「关联丢了」。'
        + 'baseline_choice 为空 = 这条发布偏离了批准草案但还没人处置 —— 此时该 ASIN 的观测卡片为 waiting_human。'
        + 'approved_json 为空 = 没有可比的批准基线，因此 deviation_json 也为空。',
      fields: {
        run_id: 'missing', draft_version: 'missing', approved_json: 'missing',
        deviation_json: 'missing', uncovered_json: 'missing', baseline_choice: 'missing',
        rollback_of: 'missing', operator: 'missing', evidence_ref: 'missing',
      },
    },
    /* 「来源」是**人**：这一行永远是运营在 Seller Central 改完之后回来登记的，
       本插件不发布（§15 的发布边界）。写 'browser-local' 会谎称我们抓过它。 */
    sources: ['manual'],
    ownerRole: 'ops_editor',
    freshnessClass: null,
    downstream: ['report', 'optimize'],
    fields: [
      'id', 'asin', 'marketplace', 'kind', 'run_id', 'draft_version', 'rollback_of',
      'approved_json', 'published_json', 'deviation_json', 'deviated', 'deviation_rule',
      'uncovered_json', 'baseline_choice', 'baseline_decided_at', 'operator', 'note',
      'evidence_ref', 'published_at', 'observation_start_at', 'rollback_protected', 'created_at',
    ],
  },
  {
    id: 'observation_plan',
    assetType: 'optimization',
    label: '观测计划',
    table: 'observation_plan',
    grain: '一行 = 一次发布的一份变更声明',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'hypothesis / confounders / rollback_conditions 为空 = 声明时没写 —— §7 要求这几项，'
        + '所以空值读作「没声明」，不读作「没有」。'
        + 'status=superseded 的行**还在**：§6 的偏离处置作废计划但不删除，因为「当时是这么计划的」本身是要留下的证据。'
        + '这份表里**没有观测值**：计划是变更**前**的声明，观测结果是 §8 的事。',
      fields: {
        hypothesis: 'unknown', baseline_start: 'unknown', baseline_end: 'unknown',
        confounders: 'unknown', rollback_conditions: 'unknown', superseded_reason: 'unknown',
      },
    },
    sources: ['manual'],
    ownerRole: 'ops_editor',
    freshnessClass: null,
    downstream: ['report', 'optimize'],
    fields: [
      'id', 'publication_id', 'hypothesis', 'baseline_start', 'baseline_end', 'changed_json',
      'unchanged_json', 'success_json', 'fail_json', 'window_days', 'confounders',
      'rollback_conditions', 'rebuild', 'status', 'superseded_reason', 'created_at',
    ],
  },
  {
    id: 'observation_checkpoint',
    assetType: 'optimization',
    label: '观测节点',
    table: 'observation_checkpoint',
    grain: '一行 = 一次发布的一个观测节点（默认 7/14/30 天）',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'conclusion 为空 = 还没下结论，**不是**「结论是无」—— 一个没有结论的节点在卡片上必须显示成'
        + '「未结论」，而不是显示成某种默认判断。missing_json 为空也有两种含义：`pending` 的节点上它是空的'
        + '（还没到点，窗口天然为空），而 `ready` 的节点上它为空才是「九类指标都拿到了」。'
        + '`retired` 与 `terminated` 是两件事：前者是 §7 的窗口变了，后者是 §9 回滚终止 —— 分开的理由见'
        + ' domain/observe/observation.js 的词表注释。metrics_json 只有下过结论的节点才有：'
        + '它是**下结论那一刻**的读数，之后数据再变也不重算。',
      fields: {
        blocked_reason: 'unknown', missing_json: 'unknown', metrics_json: 'unknown',
        conclusion: 'unknown', conclusion_note: 'unknown', concluded_at: 'unknown',
        concluded_by: 'unknown', terminated_at: 'unknown', terminated_reason: 'unknown',
        retired_at: 'unknown', retired_reason: 'unknown',
      },
    },
    sources: ['manual'],
    ownerRole: 'ops_editor',
    /* §8 的窗口是「发布后 N 天」，不是一个过期阈值 —— 节点自带 due_at，所以这里没有
       一个「够不够新」的天数可以说。写 30 会把「30 天窗口」和「30 天过期」混成同一件事。 */
    freshnessClass: null,
    downstream: ['report', 'optimize'],
    fields: [
      'id', 'publication_id', 'day', 'due_at', 'status', 'blocked_reason', 'missing_json',
      'metrics_json', 'conclusion', 'conclusion_note', 'concluded_at', 'concluded_by',
      'terminated_at', 'terminated_reason', 'retired_at', 'retired_reason', 'created_at',
    ],
  },
  {
    id: 'rollback_task',
    assetType: 'optimization',
    label: '回滚任务',
    table: 'rollback_task',
    grain: '一行 = 一次进行中的回滚（生成交付包 → 登记回滚记录 → 闭环）',
    primaryKey: ['id'],
    unit: '行',
    nullSemantics: {
      state: 'unknown',
      note: 'closed_at / closed_by_publication_id 为空 = 还没闭环（状态 pending_publish = 「回滚待发布」）。'
        + '**这不是「回滚失败」**：§9 的原话是系统不提供一键回滚，所以「待发布」会一直停到人改完 Seller Central '
        + '并回来登记一条 kind=rollback 的发布记录为止。package_json 是**生成当时**的那一份，只作留痕 —— '
        + '现行清单永远按 from/to 两条发布记录重算，否则一份会腐烂的快照会被当成现行清单。',
      fields: {
        from_publication_id: 'unknown', to_publication_id: 'unknown', package_json: 'unknown',
        reason: 'unknown', closed_at: 'unknown', closed_by_publication_id: 'unknown',
      },
    },
    sources: ['manual'],
    ownerRole: 'ops_editor',
    freshnessClass: null,
    downstream: ['report', 'optimize'],
    fields: [
      'id', 'publication_id', 'from_publication_id', 'to_publication_id', 'status', 'package_json',
      'reason', 'created_at', 'closed_at', 'closed_by_publication_id',
    ],
  },
]

/** One dataset by id, or `undefined`. */
export function datasetById(id) {
  const key = String(id ?? '').trim()
  return DATASETS.find(dataset => dataset.id === key)
}

/** The datasets under one asset type, in declaration order. */
export function datasetsForAsset(assetType) {
  const key = String(assetType ?? '').trim()
  return DATASETS.filter(dataset => dataset.assetType === key)
}

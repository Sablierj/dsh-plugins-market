/**
 * F13-05 策略阶段 —— 按 run 生成的九项策略卡，以及「人工确认后进入生成」的门禁。
 *
 * ## 这个文件存在的理由
 *
 * 在这一批之前，「策略」只有一份静态的写作策略提示词（`prompt-seed.js` 的三层
 * assemble：fixed / evidence / contract），它回答的是**怎么写**。九件必须在动笔
 * **之前**定下来的事它一件都不回答：
 *
 *     目标用户 / 核心差异化 / 购买疑问 / 事实边界 / 关键词优先级与所有权 /
 *     字段分工 / 保留内容 / 风险待确认 / 修改幅度
 *
 * 而且 `amzn_optimize_prepare` 把策略连同数据包**直接交给 Agent**，没有任何确认
 * 步骤 —— 「先策略后文案」在流程上无处落地。
 *
 * ## 门禁落在哪，以及为什么不落在 prepare
 *
 * 本插件**不生成文案**（`src/tools/optimize.js:9-15` 的模块头）。所以「进入生成」
 * 在本仓唯一能被强制执行的落点是**草案进入这一轮的那一刻**：
 *
 *   · `amzn_optimize_validate` 带 `persist: true` —— 草案落进 `optimization_draft`；
 *   · `amzn_optimize_save` —— 出报告、可能改 listing。
 *
 * 拦 prepare 等于没有策略卡可确认（那正是这一批要修的东西）。只读的 `validate`
 * 不拦：校验是免费的，拦它只会让人不敢试。
 *
 * ## 三种「没有」，三种说法（与 `evidence.js` 同一条纪律）
 *
 *   `derived` + 空事实   **读过了，答案是 0。** 例：本轮关键词里没有问句形式的词。
 *                        0 是一个发现，不是缺席。
 *   `absent`             **这一项建模了，但这一轮没有输入。** 对象本身缺（没有
 *                        listing、包里没有关键词）。它**不是**「0 条」。
 *   `not_modelled`       **本仓没有这一项的来源。** 「目标用户」是这一类：全库没有
 *                        persona / audience 的列、表或读取口（实测，见契约 §1.2）。
 *
 * 机器可检查的形式：`not_modelled` ⇒ `source === null && facts.length === 0` 且
 * `note` 非空；`absent` ⇒ `facts.length === 0` 且 `source` 非空、`note` 非空。
 * 测试逐项断言。
 *
 * ## 一条规则一份实现
 *
 * `buildStrategy` / `strategyGate` / `strategyEditState` 是判据的唯一定义处：
 *
 *   · 工具 `amzn_optimize_strategy` 直接调它们；
 *   · 页面拿到的是**算好的** `status` / `gate` / `edited`（`routes.js` 调同一个
 *     函数），只渲染，**不重算任何判据**。
 *
 * 把 `strategyGate` 改坏，工具侧与页面侧两条断言必须同时变红 —— 页面没有第二条路。
 */

import { currentLineVersion } from '../../store/product-line.js'
import { LLM_ONLY_CHECKS } from '../rules/listing-rules.js'
import { lexiconFor } from '../rules/lexicon.js'
import {
  MANUAL_FIELDS, labelForField, needsConfirmation,
} from '../rules/listing-fields.js'
import { LINKAGE_GROUPS } from './plan.js'
import { optimizableFields } from './mode.js'

/* ── the vocabulary ─────────────────────────────────────────────────────────── */

export const STRATEGY_VERSION = 'optimize-strategy.v1'

/** Where the nine items' inputs come from. Printed by both readers, so a card can
 *  never be read without the list of tables it was assembled from. */
export const STRATEGY_SOURCE =
  'F13-05 九项策略卡：事实台账（domain/optimize/plan.js）+ 关键词分配 + 模式作用域（mode.js）+ 九项前置门槛（precheck.js）+ 提示词库'

/**
 * The nine items, in reading order.
 *
 * `question` is what the item answers for this round, and it is spelled out
 * because the label alone is ambiguous: 「事实边界」 could mean "which facts are
 * in scope" or "which facts may not be invented" — the card means the second.
 */
export const STRATEGY_ITEMS = [
  {
    id: 'audience',
    label: '目标用户',
    question: '这一轮为谁写？谁的购买动机决定了取舍？',
    why: '同一条 listing 写给不同的人，标题里的第一个词就不一样。这一项定不下来，后面八项都在猜。',
  },
  {
    id: 'differentiation',
    label: '核心差异化',
    question: '凭什么选我们而不是竞品？哪几个事实支撑它？',
    why: '差异化必须落在**可核对的事实**上（尺寸 / 材质 / 属性），不能落在形容词上。',
  },
  {
    id: 'buyer_questions',
    label: '购买疑问',
    question: '买家在下单前会问什么？这些问题在文案里被回答了吗？',
    why: '问句形式的搜索词就是买家的问题本身；没回答的问题就是转化漏斗上的洞。',
  },
  {
    id: 'fact_boundary',
    label: '事实边界',
    question: '哪些是事实、只能照抄，哪些是文案、可以改写？',
    why: '属性是事实不是文案。把没确认过的材质从标题推断出来填进属性，是这个模块最容易犯的错。',
  },
  {
    id: 'keyword_priority',
    label: '关键词优先级与所有权',
    question: '哪些词必须写、写在哪个位置、哪些位置是加分？',
    why: '一个词一个主人 + 零到多个有理由的复现位。没有主人的词会掉排名，全都塞进标题会稀释。',
  },
  {
    id: 'field_split',
    label: '字段分工',
    question: '这一轮允许动哪些字段？哪些字段必须一起动？',
    why: '强制联动组（标题 ↔ 产品亮点、前端 ↔ 后台词）只改一半，就是前后矛盾。',
  },
  {
    id: 'preserve',
    label: '保留内容',
    question: '哪些内容这一轮**不许**动？',
    why: '「不为了看起来不一样而重写稳定内容」是一条硬要求，不是风格建议。',
  },
  {
    id: 'risks',
    label: '风险待确认',
    question: '这一轮有哪些必须先由人拍板的风险？',
    why: '机检管不了的判断（臆造参数、前后矛盾、语气）在这里点名，而不是在报告里第一次出现。',
  },
  {
    id: 'magnitude',
    label: '修改幅度',
    question: '这一轮最多改多少？改到什么程度算完成？',
    why: '增量模式的 ≤30% 是硬上限。幅度写在策略里，才不会在收尾时才发现超了。',
  },
]

export const STRATEGY_ITEM_IDS = STRATEGY_ITEMS.map(item => item.id)
export const STRATEGY_STATUSES = ['derived', 'absent', 'not_modelled']

export const STRATEGY_CODES = {
  NO_RUN: 'STRATEGY_NO_RUN',
  UNCONFIRMED: 'STRATEGY_UNCONFIRMED',
  STATE_MISMATCH: 'STRATEGY_STATE_MISMATCH',
  UNKNOWN_ITEM: 'STRATEGY_UNKNOWN_ITEM',
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function blank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

/* ── the nine builders ────────────────────────────────────────────────────────
   One function per item. Each returns the item's payload; `item()` below turns it
   into the stored shape, so the closed status set is checked in exactly one place
   rather than at nine call sites. */

function buildAudience() {
  /* 这一项**不是** not_modelled：本仓确实声明了「目标人群」——它是注册表里的一个
     必须人工填的类目属性（`MANUAL_FIELDS` 的 `target_audience`，「按 PTD 选择」）。
     缺的是**值**：没有任何一列存着它，采集拿不到，也不能从文案推断。所以是
     `absent`（这一项建模了，但这一轮没有可读的输入），不是「本仓没有这一项」。
     把它写成 not_modelled 会把「没存值」说成「没这个概念」，那是两个不同的错。 */
  const manual = MANUAL_FIELDS.find(field => field.id === 'target_audience') ?? null
  return {
    status: 'absent',
    source: 'MANUAL_FIELDS.target_audience @ domain/rules/listing-fields.js（类目属性，按 PTD 选择）',
    facts: [],
    text: '本仓**声明**了目标人群这个字段，但**不存它的值**：`target_audience` 是亚马逊的类目属性，'
      + '要在卖家后台按 PTD 选择 —— 采集拿不到，也不能从标题或描述里推断。'
      + '所以这一项没有可读的输入，只能由人提供。'
      + '在拿到它之前，任何关于「谁是我们买家」的判断都必须标为**待人工确认**：'
      + '把它当成已经核过的事实写进文案，就是把一个判断伪装成一条数据。',
    note: manual === null
      ? 'absent：这一项建模了（类目属性），但没有可读的输入。'
      : `absent：${manual.label}（${manual.id}）—— ${manual.why}。缺的是值，不是概念。`,
  }
}

function buildDifferentiation(store, { asin, marketplace, plan }) {
  const facts = []
  const ledgerRows = plan?.factLedger?.rows ?? []
  for (const row of ledgerRows) {
    if (row.source === '文案') continue
    facts.push({
      name: row.label,
      value: String(row.value),
      at: null,
      note: row.conflicted ? `同一个事实有 ${row.distinctValues.length} 个取值：${row.distinctValues.join(' / ')}` : null,
    })
  }
  const asinRow = store.get(
    'SELECT brand, product_line_id FROM asin WHERE asin = ? AND marketplace = ?',
    [asin, marketplace],
  ) ?? null
  const lineId = asinRow?.product_line_id ?? null
  const line = lineId === null ? null : currentLineVersion(store, lineId)
  if (line !== null) {
    facts.push({ name: '产品线', value: `${line.name ?? line.product_line_id} v${line.version}`, at: line.created_at, note: null })
  }
  const brandName = asinRow?.brand ?? null
  const brand = blank(brandName)
    ? null
    : store.get('SELECT * FROM brand WHERE name = ? ORDER BY is_own DESC, id LIMIT 1', [String(brandName)]) ?? null
  if (brand !== null) {
    facts.push({ name: '品牌', value: `${brand.name}${brand.is_own === 1 ? '（自有）' : '（竞品）'}`, at: brand.updated_at, note: null })
  }
  if (facts.length === 0) {
    return {
      status: 'absent',
      source: 'buildFactLedger @ listing + asin_snapshot；currentLineVersion @ product_line_version；brand',
      facts: [],
      text: '没有可支撑差异化的可核对事实：这个 ASIN 不在库里，也没有产品线归属与品牌归属。'
        + '先去采集或用 amzn_asin_upsert 写入现状 —— 差异化必须落在事实上，不能由文案自己编。',
      note: 'absent：这一项建模了，但这个对象没有任何输入。它不是「0 条事实」。',
    }
  }
  const conflicted = ledgerRows.filter(row => row.conflicted).length
  return {
    status: 'derived',
    source: 'buildFactLedger @ listing + asin_snapshot；currentLineVersion @ product_line_version；brand',
    facts,
    text: `可核对的事实共 ${facts.length} 条（尺寸 / 重量 / 属性 / 产品线 / 品牌）。`
      + '差异化只能建立在这些事实上：把它们之中**别人没有**的那几条放进标题与五点，'
      + '而不是把形容词堆上去。'
      + (conflicted > 0
        ? `⚠️ 其中 ${conflicted} 条事实在文案里有多个取值，先统一再写（见「事实边界」一项）。`
        : ''),
    note: '来源是事实台账与产品线 / 品牌归属，不重新读一遍今天的样子。',
  }
}

function buildBuyerQuestions({ marketplace, keywords, plan }) {
  const lex = lexiconFor(marketplace)
  const questionWords = []
  for (const entry of keywords) {
    const word = String(entry?.keyword ?? '')
    if (word === '') continue
    if (lex.questionRe.test(word)) questionWords.push(word)
  }
  const qaPlanned = (plan?.allocation?.entries ?? []).filter(entry =>
    entry.owner === 'qa' || (entry.supporting ?? []).some(slot => slot.position === 'qa'))
  const source = `lexiconFor(${marketplace ?? 'US'}).questionRe @ 本轮关键词；POSITION_FIELDS.qa @ domain/optimize/plan.js`
  const facts = questionWords.slice(0, 20).map(word => ({ name: '问句形式的词', value: word, at: null, note: null }))
  return {
    status: 'derived',
    source,
    facts,
    text: `本轮 ${keywords.length} 个关键词里，问句形式的有 ${questionWords.length} 个`
      + `${questionWords.length === 0 ? '（读过了，答案是 0 —— 不是没读）' : `：${questionWords.slice(0, 12).join(' | ')}`}。`
      + `计划里落到 Q&A 位置的有 ${qaPlanned.length} 个词。`
      + '⚠️ 本仓**没有 Q&A 的数据源**（全库没有问答表，也没有采集节），所以这里能给的只是'
      + '「哪些搜索词长得像问题」，不是「买家真的问了什么」。真实问答要去后台看。',
    note: 'QA 通道 not_modelled：本仓没有问答表；这一项给的是问句形式的搜索词，来源与它分开写明。',
  }
}

function buildFactBoundary({ plan, keywords }) {
  const factsRequired = []
  const confirmFields = []
  for (const field of optimizableFields()) {
    if (needsConfirmation(field) === true) confirmFields.push(field)
  }
  for (const field of confirmFields) {
    factsRequired.push({ name: '事实字段（只能照抄）', value: labelForField(field), at: null, note: field })
  }
  for (const field of MANUAL_FIELDS) {
    factsRequired.push({ name: '必须人工填（采集不到也推断不出来）', value: field.label, at: null, note: field.why ?? null })
  }
  const conflicts = plan?.factLedger?.conflicts ?? []
  const source = 'needsConfirmation @ domain/rules/listing-fields.js；MANUAL_FIELDS；buildFactLedger 的冲突'
  return {
    status: 'derived',
    source,
    facts: factsRequired,
    text: `事实字段 ${confirmFields.length} 个、必须人工填的字段 ${MANUAL_FIELDS.length} 个：这些只能照抄或由人提供，`
      + '不许从标题或描述里推断。'
      + (conflicts.length === 0
        ? '事实台账没有发现同一个事实的多个取值。'
        : `⚠️ 事实台账发现 ${conflicts.length} 处冲突：${conflicts.map(item => item.label).join('、')} —— 必须统一，`
          + '否则亚马逊的 AI 审核会按「前后矛盾」处理。'),
    note: `本轮关键词 ${keywords.length} 个；事实边界与关键词无关，它是字段层的约束。`,
  }
}

function buildKeywordPriority({ keywords, plan }) {
  if (keywords.length === 0) {
    return {
      status: 'absent',
      source: 'buildGlobalPlan#allocation @ domain/optimize/plan.js',
      facts: [],
      text: '这一轮的包里一个关键词都没有 —— 没有可分配的词。'
        + '先用 amzn_keyword_discover 建库、amzn_keyword_scan 测覆盖，再重开一轮。'
        + '这不是「分配了 0 个词」，是**没有可分配的东西**。',
      note: 'absent：这一项建模了，但这一轮没有输入。',
    }
  }
  const allocation = plan?.allocation ?? { entries: [], byOwner: {}, violations: [], summary: {} }
  const byOwner = allocation.byOwner ?? {}
  const facts = Object.entries(byOwner).map(([position, list]) => ({
    name: `主人位置：${position}`,
    value: `${list.length} 个词${list.length === 0 ? '' : `：${list.slice(0, 8).join(' | ')}`}`,
    at: null,
    note: null,
  }))
  const capacity = allocation.titleCapacity ?? plan?.allocation?.titleCapacity ?? null
  const violations = allocation.violations ?? []
  return {
    status: 'derived',
    source: 'buildGlobalPlan#allocation @ domain/optimize/plan.js（tier / owner / supporting / titleCapacity）',
    facts,
    text: `本轮 ${keywords.length} 个词，每个恰好一个主人：`
      + `标题 ${(byOwner.title ?? []).length}、五点 ${(byOwner.bullets ?? []).length}、`
      + `后台词 ${(byOwner.search_terms ?? []).length}，计划落点合计 ${allocation.summary?.total ?? 0} 处。`
      + (capacity === null || capacity.applicable !== false
        ? '标题里同一个词最多出现 2 次，装不下的词改放五点（不是降级，五点有它自己的预算）。'
        : `本站点不做单词重复约束：${capacity.note ?? ''}`)
      + (violations.length === 0 ? '分配没有冲突。' : `⚠️ 有 ${violations.length} 处分配冲突，写之前先看报告里的逐条理由。`),
    note: '「主人」是必须写的位置，「还可复用到」是加分位置 —— 每一条复现位都有理由，理由在计划里。',
  }
}

function buildFieldSplit({ spec }) {
  const all = optimizableFields()
  const inScope = new Set(spec?.fields ?? [])
  const groups = LINKAGE_GROUPS.map(group => ({
    id: group.id,
    label: group.label,
    mandatory: group.mandatory,
    touched: group.fields.some(field => inScope.has(field)),
    complete: group.fields.every(field => inScope.has(field)),
  }))
  const broken = groups.filter(group => group.touched && !group.complete)
  const facts = [
    { name: '本轮可写字段', value: `${inScope.size} / ${all.length}`, at: null, note: spec?.label ?? null },
    ...groups.map(group => ({
      name: `联动组：${group.label}`,
      value: group.complete ? '整组都在作用域内' : (group.touched ? '⚠️ 只动一半' : '本轮不动'),
      at: null,
      note: group.mandatory ? '强制联动组' : '建议联动组',
    })),
  ]
  return {
    status: 'derived',
    source: 'modeSpec#fields @ domain/optimize/mode.js；LINKAGE_GROUPS @ domain/optimize/plan.js',
    facts,
    text: (spec?.generates === false
      ? '审核模式：本轮**不生成任何文案**，下面的字段是检查范围，不是可写字段。'
      : `本轮可写 ${inScope.size} 个字段（注册表共 ${all.length} 个）。`)
      + (broken.length === 0
        ? '没有联动组被切开。'
        : `⚠️ 有 ${broken.length} 个联动组只动一半：${broken.map(group => group.label).join('、')} ——`
          + '强制联动组切开就是前后矛盾，先补齐或整组不动。'),
    note: '字段分工问的是「这一轮允许动哪些、哪些必须一起动」，不是「能改多少」。',
  }
}

function buildPreserve({ spec, fields, hasListing, plan }) {
  const all = optimizableFields()
  const inScope = new Set(spec?.fields ?? [])
  const outOfScope = all.filter(field => !inScope.has(field))
  /* `hasListing` is passed explicitly rather than inferred from `fields` being
     empty: `{}` and `{ title: '' }` are both "no copy", but so is a listing whose
     every field happens to be blank — and reporting 「有内容 0 个」 for a listing
     nobody read is the 「没有数据」/「数据是 0」 collapse this module forbids. */
  const present = hasListing !== true
    ? []
    : all.filter((field) => {
      const value = fields?.[field]
      return value !== undefined && value !== null && String(value).trim() !== ''
    })
  const inScopePresent = present.filter(field => inScope.has(field))
  const violations = plan?.complianceMatrix?.rows ?? []
  const blocked = new Set(violations.filter(row => row.block > 0).map(row => row.field))
  const stable = inScopePresent.filter(field => !blocked.has(field))
  const facts = [
    { name: '本轮作用域外（默认不动）', value: `${outOfScope.length} 个字段`, at: null, note: outOfScope.slice(0, 8).map(labelForField).join('、') },
    { name: '作用域内有内容', value: hasListing === true ? `${inScopePresent.length} 个字段` : '读不出来（这一轮没有当前文案）', at: null, note: null },
    { name: '其中当前无阻断', value: hasListing === true ? `${stable.length} 个字段` : '读不出来', at: null, note: stable.slice(0, 8).map(labelForField).join('、') },
  ]
  /* 审核模式没有「可写字段」，所以「作用域外的字段不许动」这句话在那一轮里是废话，
     而且会让人以为「作用域内的就能动」。审核模式说的是另一件事：**全部保持原样**。 */
  const audit = spec?.generates === false
  return {
    status: 'derived',
    source: 'modeSpec#fields @ mode.js；当前文案 @ optimization_run.package_json#before（fieldsForListing）',
    facts,
    text: (audit
      ? `审核模式：本轮**一个字段都不改**，注册表里的 ${all.length} 个字段全部保持原样。`
      : `作用域外的 ${outOfScope.length} 个字段这一轮**不许动**。`)
      + (hasListing === true
        ? (audit
          ? `当前文案里有内容的 ${present.length} 个字段这一轮只是被检查，不会被改写。`
          : `作用域内 ${stable.length} 个字段当前没有阻断项 —— 它们默认保持原样：不为了「看起来不一样」而重写稳定内容。`)
        : '⚠️ 这一轮没有「当前文案」，所以「作用域内有内容」这一项**未知**（不是 0）——'
          + '先采集或用 amzn_asin_upsert 写入现状，才能说清哪些内容该保留。'),
    note: hasListing === true
      ? (audit
        ? '审核模式没有可写字段，所以「保留内容」就是全部内容。'
        : '稳定内容不是不能改，是改了要有理由 —— 理由写进 rationale。')
      : '没有当前文案：这一项的两列是「未知」，不是「0 个字段」。',
  }
}

function buildRisks({ precheck, plan }) {
  const facts = []
  for (const gate of precheck?.gates ?? []) {
    if (gate.verdict === 'pass') continue
    facts.push({
      name: `前置门槛 ${gate.index}：${gate.label}`,
      value: gate.verdict === 'block' ? '阻断' : '降级',
      /* 门槛没有自己的观测时刻列（`counts` 只有 matched / total / label），所以这里是
         `null` = 无日期，**不回填今天** —— 与证据包的 `source_at` 同一条纪律。 */
      at: null,
      note: (gate.missing ?? [])[0] ?? gate.criterion,
    })
  }
  for (const conflict of plan?.factLedger?.conflicts ?? []) {
    facts.push({ name: `事实冲突：${conflict.label}`, value: conflict.values.join(' / '), at: null, note: conflict.detail })
  }
  for (const violation of plan?.allocation?.violations ?? []) {
    facts.push({ name: '分配冲突', value: violation.keyword, at: null, note: violation.detail })
  }
  for (const check of LLM_ONLY_CHECKS) {
    facts.push({ name: '只能由你判断', value: check.ask, at: null, note: check.source })
  }
  const blocking = (precheck?.gates ?? []).filter(gate => gate.verdict === 'block').length
  return {
    status: 'derived',
    source: 'evaluatePrecheck @ domain/optimize/precheck.js；buildFactLedger 冲突；allocation.violations；LLM_ONLY_CHECKS',
    facts,
    text: (blocking > 0
      ? `⛔ 有 ${blocking} 项前置门槛阻断 —— 这一轮根本不该生成文案，先补数再重跑。`
      : '前置门槛没有阻断项。')
      + `待确认风险共 ${facts.length} 条：机检管不了的判断（臆造参数、标题与描述互相矛盾、语气）都在这里，`
      + '不要等到报告里才第一次看到它们。'
      + (facts.length === 0 ? '这一轮没有待确认风险 —— 这是一句结论，不是「没检查」。' : ''),
    note: '「风险待确认」是**具名**清单，不是计数：一条风险说不清是什么，就等于没有说。',
  }
}

function buildMagnitude({ spec }) {
  const facts = []
  if (spec?.budget) {
    facts.push({
      name: '单轮上限',
      value: `${spec.budget.allowed} 个字段`,
      at: null,
      note: `${Math.round(spec.budget.ratio * 100)}% × ${spec.budget.total}`,
    })
  }
  facts.push({
    name: '本轮可写字段',
    value: spec?.generates === false ? '0（审核模式不生成）' : `${(spec?.fields ?? []).length} 个`,
    at: null,
    note: spec?.label ?? null,
  })
  facts.push({
    name: '模式',
    value: spec?.label ?? '未知',
    at: null,
    note: spec?.note ?? null,
  })
  return {
    status: 'derived',
    source: 'modeSpec @ domain/optimize/mode.js（budget / fields / generates）',
    facts,
    text: (spec?.generates === false
      ? '审核模式：修改幅度是 **0** —— 本轮不生成任何文案，只出检查结论。'
      : spec?.budget
        ? `增量模式：单轮最多改 ${spec.budget.allowed} 个字段（${Math.round(spec.budget.ratio * 100)}% × ${spec.budget.total}）。`
          + '超出的部分**不会**被接受 —— 收尾时会按「本轮实际交付的变更字段数」再判一次。'
        : `本轮可写 ${(spec?.fields ?? []).length} 个字段，没有比例上限（全量 / 专项模式）。`)
      + '「改了」按字段的实际文本是否变化计，不是按提交了几个字段。',
    note: '幅度是硬上限，不是建议：超了会被 amzn_optimize_save 拒，并且**什么都不写**。',
  }
}

/* ── the item shape ─────────────────────────────────────────────────────────── */

function item(id, payload) {
  const spec = STRATEGY_ITEMS.find(entry => entry.id === id)
  if (spec === undefined) throw new Error(`unknown strategy item ${JSON.stringify(id)}`)
  if (!STRATEGY_STATUSES.includes(payload.status)) {
    throw new Error(`unknown strategy status ${JSON.stringify(payload.status)} — expected one of: ${STRATEGY_STATUSES.join(' | ')}`)
  }
  const facts = Array.isArray(payload.facts) ? payload.facts : []
  /* The three statuses are checked **where they are made**, not where they are
     read: a fourth spelling invented at a call site would be rendered as itself
     and would read as an item nobody can explain. The implications below are the
     machine-checkable form the tests assert. */
  if (payload.status === 'not_modelled' && payload.source !== null) {
    throw new Error(`strategy item ${id} is not_modelled but carries a source — 「本仓没有」不能同时有来源`)
  }
  if (payload.status === 'absent' && blank(payload.source)) {
    throw new Error(`strategy item ${id} is absent but carries no source — 「这一轮没有输入」必须说得出读的是哪里`)
  }
  if (payload.status === 'derived' && blank(payload.source)) {
    throw new Error(`strategy item ${id} is derived but carries no source — 「读过了」必须说得出读的是哪里`)
  }
  if (payload.status !== 'derived' && facts.length > 0) {
    throw new Error(`strategy item ${id} is ${payload.status} but carries ${facts.length} facts — 没有来源就没有事实`)
  }
  return {
    id,
    label: spec.label,
    question: spec.question,
    why: spec.why,
    status: payload.status,
    source: payload.source ?? null,
    facts,
    text: String(payload.text ?? ''),
    note: payload.note ?? null,
  }
}

/**
 * The nine items for one round.
 *
 * Everything it needs is passed in, because `prepare` has already computed all of
 * it and re-deriving any of it here would be a second implementation of a rule
 * that already exists — the failure this whole module is written against.
 */
export function buildStrategy(store, {
  asin, marketplace, keywords = [], plan = null, precheck = null, spec = null, fields = {}, hasListing = false,
} = {}) {
  return [
    item('audience', buildAudience()),
    item('differentiation', buildDifferentiation(store, { asin, marketplace, plan })),
    item('buyer_questions', buildBuyerQuestions({ marketplace, keywords, plan })),
    item('fact_boundary', buildFactBoundary({ plan, keywords })),
    item('keyword_priority', buildKeywordPriority({ keywords, plan })),
    item('field_split', buildFieldSplit({ spec })),
    item('preserve', buildPreserve({ spec, fields, hasListing, plan })),
    item('risks', buildRisks({ precheck, plan })),
    item('magnitude', buildMagnitude({ spec })),
  ]
}

/* ── the gate ───────────────────────────────────────────────────────────────── */

/**
 * 「人工确认后进入生成」的判据 —— **从内容重算**，不由写入方自报。
 *
 * Three states, and the difference between the first two is the whole point:
 *
 *   `absent`      这一轮没有策略行（本批之前建的轮次，或手工插的轮次）。
 *                 门是**开**的 —— 没有可确认的东西。但状态说得出「为什么开」，
 *                 不冒充「已确认」。
 *   `unconfirmed` 有策略卡、没人确认过。门**关**着。
 *   `confirmed`   确认过了。门开着，并且说得出是谁在什么时候确认的。
 *
 * 把 `absent` 折进 `confirmed` 会让「这一轮从来没有策略卡」读成「策略已经确认过」——
 * 那正是「没有建模」与「没测到」必须分开的那条纪律在门禁上的样子。
 */
export function strategyGate(row) {
  if (row === null || row === undefined) {
    return {
      open: true,
      state: 'absent',
      code: 'STRATEGY_ABSENT',
      reason: '这一轮没有策略卡（本批之前建的轮次，或轮次不是 amzn_optimize_prepare 建的），'
        + '所以没有可确认的东西 —— 这不等于「策略已确认」。',
    }
  }
  if (blank(row.confirmed_at ?? row.confirmedAt)) {
    return {
      open: false,
      state: 'unconfirmed',
      code: STRATEGY_CODES.UNCONFIRMED,
      reason: '这一轮的九项策略卡还没有人工确认。先策略后文案：确认之后草案才能进入这一轮。'
        + '去工作台「优化 → 策略阶段」看九项，或调 amzn_optimize_strategy 读一遍。',
    }
  }
  return {
    open: true,
    state: 'confirmed',
    code: 'STRATEGY_CONFIRMED',
    reason: `策略已由 ${row.confirmed_by ?? row.confirmedBy ?? '（未署名）'} 于 `
      + `${row.confirmed_at ?? row.confirmedAt} 确认。`,
  }
}

/** Whether the human changed the text before confirming — derived, not flagged. */
export function strategyEditState(row) {
  if (row === null || row === undefined) return { edited: false, known: false }
  return {
    edited: String(row.built_json ?? '') !== String(row.items_json ?? ''),
    known: true,
  }
}

/* ── read / write / confirm ─────────────────────────────────────────────────── */

function hydrateStrategy(row) {
  if (row === null || row === undefined) return null
  return {
    runId: row.run_id,
    built: parseJson(row.built_json, []),
    items: parseJson(row.items_json, []),
    confirmedAt: row.confirmed_at ?? null,
    confirmedBy: row.confirmed_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The raw row, read back through the same SELECT the reconciliation uses. */
export function readStrategyRow(store, runId) {
  const row = store.get('SELECT * FROM optimization_strategy WHERE run_id = ?', [String(runId ?? '').trim()])
  return row ?? null
}

/**
 * Freeze the nine items for a run. Written once, at `prepare`.
 *
 * Idempotent by content: a second call with the same items writes nothing. A
 * second call with **different** items is refused rather than overwriting —
 * `prepare` is the only writer, and a strategy that changed under a run would
 * make 「这一轮一开始给的是什么」 unanswerable, which is exactly what
 * `built_json` exists to keep.
 */
export function writeStrategy(store, runId, items, { now = new Date() } = {}) {
  const run = String(runId ?? '').trim()
  if (run === '') throw new Error('runId is required')
  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  const payload = JSON.stringify(items)
  const existing = readStrategyRow(store, run)
  if (existing === null) {
    store.run(
      `INSERT INTO optimization_strategy (run_id, built_json, items_json, confirmed_at, confirmed_by, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
      [run, payload, payload, at, at],
    )
    return { ok: true, written: true, unchanged: false, at }
  }
  if (String(existing.built_json) === payload && String(existing.items_json) === payload) {
    return { ok: true, written: false, unchanged: true, at: existing.created_at }
  }
  return {
    ok: false,
    code: STRATEGY_CODES.STATE_MISMATCH,
    error: '这一轮已经有策略卡，且内容与这次要写的不一致 —— 策略在 prepare 时冻结一次，'
      + '之后只由人工确认改写（确认不改 built_json）。要换策略，另开一轮。',
  }
}

/** Everything a reader needs about one run's strategy. */
export function readStrategy(store, runId) {
  const run = store.get('SELECT * FROM optimization_run WHERE id = ?', [String(runId ?? '').trim()]) ?? null
  if (run === null) {
    return {
      ok: false,
      code: STRATEGY_CODES.NO_RUN,
      error: `没有第 ${String(runId ?? '').slice(0, 8)} 轮优化 —— 策略卡挂在轮次上，先跑一次 amzn_optimize_prepare。`,
    }
  }
  const row = readStrategyRow(store, run.id)
  const hydrated = hydrateStrategy(row)
  const items = hydrated === null ? [] : hydrated.items
  const counts = {
    items: STRATEGY_ITEM_IDS.length,
    derived: items.filter(entry => entry.status === 'derived').length,
    absent: items.filter(entry => entry.status === 'absent').length,
    notModelled: items.filter(entry => entry.status === 'not_modelled').length,
  }
  return {
    ok: true,
    runId: run.id,
    asin: run.asin,
    marketplace: run.marketplace,
    status: run.status,
    present: hydrated !== null,
    confirmed: hydrated !== null && !blank(hydrated.confirmedAt),
    confirmedAt: hydrated === null ? null : hydrated.confirmedAt,
    confirmedBy: hydrated === null ? null : hydrated.confirmedBy,
    ...strategyEditState(row),
    gate: strategyGate(row),
    counts,
    items,
    built: hydrated === null ? [] : hydrated.built,
    empty: hydrated === null
      ? {
        kind: 'no-strategy',
        text: '这一轮没有策略卡 —— 策略卡在 amzn_optimize_prepare 建完轮次时冻结。'
          + '本批之前建的轮次没有它，所以门禁对它们放行（并明说放行的理由）。',
      }
      : null,
  }
}

/**
 * 人工确认。**写完读回那一行、重算门禁、与「按内容它应当是 confirmed」比对。**
 *
 * 两边是两条不同的路：`expected` 是这次意图应当产生的状态（确认 → `confirmed`），
 * `gate` 是从**写之后读回来的那一行**重算出来的状态。写入没落地、落到了别的行、
 * 或者列名写错了，两者就会分叉。对不上就报 `STRATEGY_STATE_MISMATCH`，不谎报成功。
 *
 * `items` 是可选的：确认时可以改文字（人工确认不是橡皮图章）。改的是 `items_json`，
 * `built_json` 一个字都不动 —— 「这一轮一开始给的是什么」必须还读得出来。
 *
 * 幂等：已确认且内容没变 → `unchanged: true`，不改时刻戳。「做了一次没改变任何东西
 * 的调用」与「状态变了」是两件不同的事。
 */
export function confirmStrategy(store, { runId, items = null, by = null, now = new Date() } = {}) {
  const run = String(runId ?? '').trim()
  const row = readStrategyRow(store, run)
  if (run === '' || row === null) {
    return {
      ok: false,
      code: STRATEGY_CODES.NO_RUN,
      error: `第 ${run.slice(0, 8)} 轮没有策略卡 —— 没有可确认的东西。`
        + '策略卡在 amzn_optimize_prepare 建完轮次时冻结；本批之前建的轮次没有它。',
    }
  }

  let next = parseJson(row.items_json, [])
  if (items !== null && items !== undefined) {
    if (!Array.isArray(items)) {
      return { ok: false, code: STRATEGY_CODES.UNKNOWN_ITEM, error: 'items 必须是数组（每项 { id, text }）。' }
    }
    const unknown = items.map(entry => String(entry?.id ?? '')).filter(id => !STRATEGY_ITEM_IDS.includes(id))
    if (unknown.length > 0) {
      return {
        ok: false,
        code: STRATEGY_CODES.UNKNOWN_ITEM,
        error: `九项以外的 id：${unknown.join('、')} —— 策略卡是九项，加一项就是给这一轮编一个新判据。`,
      }
    }
    const edited = new Map(items.map(entry => [String(entry.id), String(entry.text ?? '')]))
    next = next.map(entry => (edited.has(entry.id) ? { ...entry, text: edited.get(entry.id) } : entry))
  }

  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  const already = !blank(row.confirmed_at)
  const same = JSON.stringify(next) === String(row.items_json)
  const changed = !already || !same
  if (changed) {
    store.run(
      'UPDATE optimization_strategy SET items_json = ?, confirmed_at = ?, confirmed_by = ?, updated_at = ? WHERE run_id = ?',
      [JSON.stringify(next), at, by === null || by === undefined ? null : String(by), at, run],
    )
  }

  /* ── 读回对账 ──────────────────────────────────────────────────────────────
     expected 是这次意图应当产生的状态；gate 是从写之后读回来的那一行重算的。 */
  const after = readStrategyRow(store, run)
  const gate = strategyGate(after)
  const expected = 'confirmed'
  if (gate.state !== expected) {
    return {
      ok: false,
      code: STRATEGY_CODES.STATE_MISMATCH,
      error: `确认之后读回重算的状态是「${gate.state}」，按内容它应当是「${expected}」——`
        + '这次写入没有产生它声称的结果。',
    }
  }

  return {
    ok: true,
    runId: run,
    unchanged: !changed,
    confirmedAt: after.confirmed_at,
    confirmedBy: after.confirmed_by ?? null,
    ...strategyEditState(after),
    gate,
  }
}

/**
 * F13-03 证据包 — 十一类快照，每条带「来源 / 时间 / 适用字段」，冻结之后拒写。
 *
 * ## 这个文件存在的理由
 *
 * 在这一批之前，「证据」是四份散在各处的东西：当前文案与关键词包躺在
 * `optimization_run.package_json`，规则快照躺在 `optimization_run.rules_json`，
 * Prompt 快照又回到包里。它们**没有来源、没有日期、没有适用范围**，也没有任何东西
 * 能在收尾之后拒绝改写 —— 报告说「当时是这样的」，而「当时」既没有出处也没有日子。
 *
 * 另外六类（listing 历史 / 评论主题样本 / QA / 竞品机会 / 产品线事实与品牌语气 /
 * 质量缺失项）根本没有落点。
 *
 * ## 三种「没有」，三种说法
 *
 * 这一节是本文件最要紧的地方。把「没有」压成一个空值，是这个项目反复付代价换来的
 * 教训（见 `store/schema.js` v40 那一段与 `preflight` 的 `missing` / `degradeNotes`）：
 *
 *   `frozen` + `count: 0`  **读过了，答案是 0。** 例：这个对象一条质量记录都没有。
 *                          0 是一个发现，不是缺席。
 *   `absent`               **这一类在这个对象上不存在可冻结的东西。** 对象本身缺
 *                          （没有 listing、没有竞品组、没有产品线归属），或这一轮
 *                          没有输入（包里没有关键词）。它**不是**「0 条」。
 *   `not_modelled`         **本仓没有这一类的来源。** 评论主题样本与 QA 是这一类：
 *                          全库没有表、没有读取口、没有采集节。说「这一类没有」，
 *                          不说「0 条」。
 *
 * 机器可检查的形式：`not_modelled` ⇒ `source === null && at === null && count === null`
 * 且 `fields === []`。`frozen` 一定有 `source` 与 `count`（可以是 0）。测试逐类断言。
 *
 * ## 来源与时间从哪来
 *
 * 四类已经冻结在 run 包里的证据（当前文案 / 关键词包与位置计划 / 规则快照 /
 * Prompt 快照）**不重新去读一次活数据** —— 那会让「冻结」变成「又算了一遍今天的样子」。
 * 它们的来源写成包里的那一格 + 底下的表名，时间写成 `run.started_at`（那一轮读到这些
 * 字节的时刻）。其余六类从各自的表读，时间取**那一类自己的观测时刻**（`MAX(collected_at)`
 * / `detected_at` / 版本创建时间），读不到就写 `null`（= 无日期），**绝不回填今天**。
 */

import { listingBefore } from '../../store/queries.js'
import { loadActiveRoster } from '../../store/rules.js'
import { listSnapshots } from '../../store/snapshot.js'
import { listCompetitorSets, readCompetitorSides } from '../../store/kw.js'
import { currentLineVersion } from '../../store/product-line.js'
import { listIssues } from '../../store/quality.js'
import { listPolicies } from '../../store/policy.js'
import { competitorBrandHits } from '../../store/keyword-ownership.js'
import { classifyQuadrants, quadrantRows } from '../keywords/competitor.js'
import { resolveReviewFamily } from '../../store/review.js'
import { readReviewAnalysis } from '../asin/review-analysis-run.js'

/**
 * The ten classes, in the order the package reads.
 *
 * `appliesTo` names the *shape* of the fields this class bears on, so a reader can
 * tell 「适用整轮」 (all) from 「适用某几个字段」 (copy / field) without inferring
 * it from an empty array.
 */
export const EVIDENCE_KINDS = [
  { id: 'current_copy', label: '当前文案', appliesTo: 'all' },
  { id: 'keywords_plan', label: '关键词包与位置计划', appliesTo: 'all' },
  { id: 'rules', label: '规则快照', appliesTo: 'all' },
  { id: 'prompts', label: 'Prompt 快照', appliesTo: 'all' },
  { id: 'listing_history', label: 'listing 历史', appliesTo: 'copy' },
  { id: 'review_topics', label: '评论主题样本', appliesTo: 'copy' },
  { id: 'qa', label: 'QA（问答）', appliesTo: 'copy' },
  { id: 'competitor_opportunities', label: '竞品机会', appliesTo: 'keywords' },
  { id: 'product_line_brand', label: '产品线事实与品牌语气', appliesTo: 'copy' },
  { id: 'quality_gaps', label: '质量缺失项', appliesTo: 'field' },
  /* 第十一类（2026-10-21）：政策与上架要求。
   *
   * 这一类的存在理由：文案要遵守的是**亚马逊当期**的政策（标题字符上限、禁用词、
   * 品类限制、AI 内容披露……），而在此之前这些只能靠提示词里的一句话，没有任何
   * 可引用的出处。政策库（policy 表 + amzn_policy_import）早就存在，只是没接进来。
   *
   * 三类「没有」在这里的分法很关键：
   *   库里有行   → frozen + count = N
   *   库里 0 行  → **仍然是 frozen + count 0**（读过了，答案是「这个站点当前没有
   *                生效中的政策」）。这是一个发现，不是缺席。
   *   表不存在   → 才轮到 not_modelled。本仓表在，所以永远走不到那一支。
   */
  { id: 'policies', label: '政策与上架要求', appliesTo: 'all' },
]

export const EVIDENCE_KIND_IDS = EVIDENCE_KINDS.map(kind => kind.id)
export const EVIDENCE_STATUSES = ['frozen', 'absent', 'not_modelled']

export const EVIDENCE_CODES = {
  NO_RUN: 'EVIDENCE_NO_RUN',
  UNKNOWN_KIND: 'EVIDENCE_UNKNOWN_KIND',
  FROZEN: 'EVIDENCE_FROZEN',
}

/** The copy fields a listing-shaped evidence class bears on. */
const COPY_FIELDS = ['title', 'bullets', 'description']

const NOT_MODELLED_NOTES = {
  /* T70 后 review_topics 不在此列（lead 裁决 #6）：表已建、读口已有 —— 它从
     「本仓没有来源」（第三种缺失）升级为「本仓有来源、本轮可能没跑」（第二种），
     由 collectReviewTopics 两态回答。旧注「全库没有评论主题表」已是假话，删。 */
  qa: '本仓没有这一类证据的来源：全仓没有 Q&A 表，也没有读取口。这不是「这一次没有」——是「本仓没有」。',
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

function maxIso(values) {
  const list = values.filter(value => value !== null && value !== undefined && String(value).trim() !== '').map(String)
  if (list.length === 0) return null
  return list.reduce((best, value) => (value > best ? value : best))
}

/** One class's answer. `count` is `null` only where counting is meaningless. */
function entry(kindId, { status, source = null, at = null, fields = [], count = null, payload = null, note = null }) {
  /* The three statuses are a closed set, checked where they are made rather than
     where they are read: a fourth spelling invented at a call site would be
     rendered as itself by the page and would read as a class nobody can explain. */
  if (!EVIDENCE_STATUSES.includes(status)) {
    throw new Error(`unknown evidence status ${JSON.stringify(status)} — expected one of: ${EVIDENCE_STATUSES.join(' | ')}`)
  }
  const kind = EVIDENCE_KINDS.find(entry => entry.id === kindId)
  return { kind: kindId, label: kind?.label ?? kindId, appliesTo: kind?.appliesTo ?? 'all', status, source, at, fields, count, payload, note }
}

function absent(kindId, source, { fields = [], note = null, at = null } = {}) {
  return entry(kindId, { status: 'absent', source, at, fields, count: null, note })
}

function notModelled(kindId) {
  return entry(kindId, {
    status: 'not_modelled',
    source: null,
    at: null,
    fields: [],
    count: null,
    note: NOT_MODELLED_NOTES[kindId] ?? '本仓没有这一类证据的来源。',
  })
}

/* ─────────────────────────── the ten collectors ─────────────────────────── */

/** ① 当前文案 — from the run's frozen `before`, never re-read from the listing. */
function collectCurrentCopy(store, { run, asin, marketplace }) {
  const before = parseJson(run?.package_json, null)?.before ?? null
  const live = before === null ? listingBefore(store, asin, marketplace) : null
  const copy = before ?? live
  if (copy === null) {
    return absent('current_copy', 'optimization_run.package_json#before @ listing + asin_snapshot', {
      fields: COPY_FIELDS,
      note: '这个对象在 listing 表与 asin_snapshot 里都没有文案 —— 没有「优化前」可比。',
    })
  }
  const payload = {
    title: copy.title ?? null,
    bullets: Array.isArray(copy.bullets) ? copy.bullets : [],
    description: copy.description ?? null,
    search_terms: copy.search_terms ?? null,
    item_highlights: copy.item_highlights ?? null,
    origin: copy.origin ?? null,
    version: copy.version ?? null,
  }
  const count = [payload.title, payload.description, payload.search_terms, payload.item_highlights]
    .filter(value => value !== null && value !== undefined && String(value).trim() !== '').length
    + payload.bullets.length
  return entry('current_copy', {
    status: 'frozen',
    source: before === null
      ? `listingBefore @ ${copy.source === 'snapshot' ? 'asin_snapshot' : 'listing'}`
      : 'optimization_run.package_json#before @ listing + asin_snapshot',
    at: run?.started_at ?? null,
    fields: COPY_FIELDS,
    count,
    payload,
    note: before === null
      ? '这一轮开始前还没有证据包，收尾时补冻：文案是从活数据读的。'
      : '取自这一轮开始时冻结的包，不重新读一次活数据。',
  })
}

/** ② 关键词包与位置计划 — counts only, and that limit is said out loud. */
function collectKeywordsPlan(store, { run, asin, marketplace }) {
  const pkg = parseJson(run?.package_json, null)
  const keywords = Array.isArray(pkg?.keywords) ? pkg.keywords : []
  const plan = pkg?.plan ?? null
  if (keywords.length === 0) {
    return absent('keywords_plan', 'optimization_run.package_json#keywords @ asin_keyword + keyword', {
      note: '这一轮的数据包里没有关键词 —— 不是「0 个词」，是这一轮没有词可用。',
    })
  }
  const at = maxIso(store.all(
    'SELECT collected_at FROM asin_keyword WHERE asin = ? AND marketplace = ?',
    [asin, marketplace],
  ).map(row => row.collected_at))
  return entry('keywords_plan', {
    status: 'frozen',
    source: 'optimization_run.package_json#keywords+plan @ asin_keyword + keyword',
    at,
    /* 位置计划在本仓**只存计数**（F13-06 的已知缺口：计划不落库）。所以这一条的
       「适用字段」是整轮而不是某几个字段 —— 不发明一份本仓没有的字段清单。 */
    fields: [],
    count: keywords.length,
    payload: { keywords, plan },
    note: '位置计划在本仓只存计数（F13-06 的缺口：计划本身不落库），所以「适用字段」是整轮，不是某几个字段。',
  })
}

/** ③ 规则快照 — the frozen roster, falling back to the active one by name. */
function collectRules(store, { run }) {
  const snapshot = parseJson(run?.rules_json, null)
  const frozenOk = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.rules)
  const roster = frozenOk ? snapshot : loadActiveRoster(store)
  const rules = Array.isArray(roster?.rules) ? roster.rules : []
  if (rules.length === 0) {
    return absent('rules', 'optimization_run.rules_json @ rule_set + rule', {
      note: '这一轮没有任何规则在生效（规则集与代码种子都是空的）—— 不是「0 条规则」，是没有规则可冻结。',
    })
  }
  const version = roster.version ?? null
  const set = version === null
    ? null
    : store.get('SELECT published_at FROM rule_set WHERE version = ?', [version]) ?? null
  return entry('rules', {
    status: 'frozen',
    source: frozenOk ? 'optimization_run.rules_json @ rule_set + rule' : 'loadActiveRoster @ rule_set + rule',
    at: set?.published_at ?? run?.started_at ?? null,
    fields: [],
    count: rules.length,
    payload: { version, source: roster.source ?? null, fromCode: roster.fromCode === true, rules },
    note: frozenOk ? null : '这一轮没有规则快照（本批之前建的轮次），收尾时按当前生效的规则集补冻。',
  })
}

/** ④ Prompt 快照 — from the run's package, same rule as ①. */
function collectPrompts(store, { run }) {
  const pkg = parseJson(run?.package_json, null)
  const prompts = Array.isArray(pkg?.prompts) ? pkg.prompts : []
  if (prompts.length === 0) {
    return absent('prompts', 'optimization_run.package_json#prompts @ prompt', {
      note: '这一轮没有拿到任何写作策略提示词（提示词库里没有 optimize 的组装提示词）—— 不是「0 条」。',
    })
  }
  return entry('prompts', {
    status: 'frozen',
    source: 'optimization_run.package_json#prompts @ prompt',
    at: run?.started_at ?? null,
    fields: [],
    count: prompts.length,
    payload: prompts,
    note: '取自这一轮开始时冻结的包（含每条的 layer / label / version / 正文）。',
  })
}

/** ⑤ listing 历史 — the registry's own listing rows for this object. */
function collectListingHistory(store, { asin, marketplace }) {
  const objectId = `${asin}@${marketplace}`
  const listed = listSnapshots(store, { objectType: 'listing', objectId, limit: 100 })
  const rows = listed.rows
  /* 「连当前版都没有」与「有当前版但没有历史」是两件事：前者是这一类不存在，
     后者是一个真实的 0（只登记过一版，或一版都没登记）。 */
  const live = listingBefore(store, asin, marketplace)
  if (rows.length === 0 && live === null) {
    return absent('listing_history', 'listSnapshots @ snapshot_registry', {
      fields: COPY_FIELDS,
      note: '这个对象既没有当前文案也没有任何采集快照 —— 谈不上「历史」。',
    })
  }
  return entry('listing_history', {
    status: 'frozen',
    source: 'listSnapshots @ snapshot_registry',
    at: maxIso(rows.map(row => row.createdAt)),
    fields: COPY_FIELDS,
    count: rows.length,
    payload: rows.map(row => ({
      id: row.id,
      version: row.version ?? null,
      createdAt: row.createdAt,
      refTable: row.refTable ?? null,
      refId: row.refId ?? null,
      archived: row.archived === true,
    })),
    note: rows.length === 0
      ? '读过了：快照登记表里这个对象没有历史版本（不是「历史是空的」——是没有登记过）。'
      : `登记表里共 ${rows.length} 个历史版本（含已归档的，因为「历史」正是它们存在的理由）。`,
  })
}

/** ⑧ 竞品机会 — 自有缺席 is the opportunity; 未测 is not. */
function collectCompetitorOpportunities(store, { asin, marketplace }) {
  const sets = listCompetitorSets(store, { marketplace, limit: 20 })
  const peers = [...new Set(sets.flatMap(set => Array.isArray(set.asins) ? set.asins : []))]
    .filter(peer => peer !== asin)
  if (peers.length === 0) {
    return absent('competitor_opportunities', 'listCompetitorSets @ competitor_set', {
      note: `这个站点（${marketplace}）没有定义任何竞品组 —— 没有可比的对象，不是「0 个机会」。`,
    })
  }
  const sides = readCompetitorSides(store, { asin, marketplace, competitors: peers })
  const classified = classifyQuadrants(quadrantRows(sides), {
    marketplace,
    brandHitsFor: keyword => competitorBrandHits(store, keyword),
  })
  const at = maxIso([
    ...store.all('SELECT collected_at FROM asin_keyword WHERE asin = ? AND marketplace = ?', [asin, marketplace]).map(row => row.collected_at),
    ...store.all('SELECT collected_at FROM kw_competitor_fact WHERE marketplace = ?', [marketplace]).map(row => row.collected_at),
  ])
  return entry('competitor_opportunities', {
    status: 'frozen',
    source: 'readCompetitorSides + classifyQuadrants @ kw_competitor_fact + asin_keyword',
    at,
    fields: [],
    count: classified.counts.ourAbsent ?? 0,
    payload: {
      peers,
      competitorSets: sets.map(set => ({ id: set.id, name: set.name, asins: set.asins })),
      counts: classified.counts,
      inputTotal: classified.inputTotal,
      candidates: classified.candidates,
      isolated: classified.isolated,
    },
    note: `机会 = 自有缺席 ${classified.counts.ourAbsent ?? 0} 个词。`
      + `未测 ${classified.counts.unmeasured ?? 0} 个词**不算机会**（未测不是缺席），命中竞品品牌的 ${classified.isolated.length} 个词进隔离区。`
      + '这是关键词层的证据，不适用某几个文案字段。',
  })
}

/** ⑨ 产品线事实与品牌语气 — the versioned line and the brand row. */
function collectProductLineBrand(store, { asin, marketplace }) {
  const asinRow = store.get(
    'SELECT brand, product_line_id FROM asin WHERE asin = ? AND marketplace = ?',
    [asin, marketplace],
  ) ?? null
  const lineId = asinRow?.product_line_id ?? null
  const line = lineId === null ? null : currentLineVersion(store, lineId)
  const brandName = asinRow?.brand ?? null
  const brand = brandName === null || String(brandName).trim() === ''
    ? null
    : store.get('SELECT * FROM brand WHERE name = ? ORDER BY is_own DESC, id LIMIT 1', [String(brandName)]) ?? null
  if (line === null && brand === null) {
    return absent('product_line_brand', 'currentLineVersion @ product_line_version + brand', {
      fields: COPY_FIELDS,
      note: '这个 ASIN 既没有产品线归属，品牌名也没有落在品牌表里 —— 没有可冻结的产品线事实与品牌语气。',
    })
  }
  return entry('product_line_brand', {
    status: 'frozen',
    source: 'currentLineVersion @ product_line_version + brand',
    at: maxIso([line?.created_at, brand?.updated_at]),
    fields: COPY_FIELDS,
    count: (line === null ? 0 : 1) + (brand === null ? 0 : 1),
    payload: {
      productLine: line === null ? null : {
        id: line.id,
        productLineId: line.product_line_id,
        version: line.version,
        name: line.name ?? null,
        signals: parseJson(line.signals_json, null),
        at: line.created_at,
      },
      brand: brand === null ? null : {
        id: brand.id,
        name: brand.name,
        aliases: parseJson(brand.aliases_json, []),
        forbidden: parseJson(brand.forbidden_json, []),
        isOwn: brand.is_own === 1,
        at: brand.updated_at,
      },
      /* 这一格**故意留空并说明**：本仓没有任何字段叫「品牌语气」——品牌表只有
         规范写法 / 别名 / 禁用写法。语气是模型写作时要遵守的东西，不是这里的一条记录。 */
      voiceNote: '本仓没有「品牌语气」这个字段：brand 表只有规范写法 / 别名 / 禁用写法。'
        + '语气由提示词层的写作策略承载，不在这里发明一条记录。',
    },
    note: '产品线事实取当前版本；品牌取规范写法 + 别名 + 禁用写法。品牌语气本仓没有对应字段（见 payload.voiceNote）。',
  })
}

/** ⑩ 质量缺失项 — what the data-quality scan recorded for this object. */
function collectQualityGaps(store, { asin, marketplace }) {
  const asinRow = store.get('SELECT asin FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace]) ?? null
  if (asinRow === null) {
    return absent('quality_gaps', 'listIssues @ dq_issue', {
      fields: [],
      note: '这个对象不在库里（asin 表没有这一行）—— 没有可查的质量记录。',
    })
  }
  const issues = listIssues(store, { objectId: `${asin}@${marketplace}` })
  const open = issues.filter(issue => issue.status === 'open' || issue.status === 'acknowledged' || issue.status === 'fixing')
  return entry('quality_gaps', {
    status: 'frozen',
    source: 'listIssues @ dq_issue',
    at: maxIso(issues.map(issue => issue.detectedAt ?? issue.detected_at)),
    fields: [],
    count: issues.length,
    payload: issues.map(issue => ({
      id: issue.id,
      ruleId: issue.ruleId,
      dimension: issue.dimension,
      severity: issue.severity,
      status: issue.status,
      field: issue.field ?? null,
      message: issue.message,
      detectedAt: issue.detectedAt ?? issue.detected_at ?? null,
    })),
    note: `读过了：dq_issue 里这个对象共 ${issues.length} 条记录，其中 ${open.length} 条还没关。`
      + '证据是「当时发现了什么」，所以已关闭的也在里面。',
  })
}

/**
 * ⑪ 政策与上架要求 — 这个站点当前**生效中**的政策。
 *
 * 只取 `status = 'active'`：被取代（superseded）与已过期（expired）的政策是历史，
 * 拿它们当写作依据会让文案遵守一条已经作废的规矩。历史仍有 `policyChain` 可查。
 *
 * 时间是 `max(effective_from, imported_at)` —— 政策这一类最要紧的日期是"什么时候
 * **开始**适用"，不是导入时间；`effective_from` 读不到时退回 `imported_at`，
 * 并把这个选择写在 note 里，而不是假装有一个生效日。
 */
/**
 * 这个站点当前**生效中**的政策，压成能进包的一行一行的形状。
 *
 * 证据包（第十一类）与 `amzn_optimize_prepare` 的数据包都要这个答案，
 * 所以只在这里取一次：两处各写一份查询，就会出现「证据包说有 3 条、
 * prepare 说 2 条」这种没人能解释的差。
 *
 * `listPolicies` 返回的是**已 hydrate 的驼峰行**（effectiveFrom / severityHint /
 * sourceName），不是表里的下划线列名 —— 用 `row.effective_from` 会静默拿到
 * undefined：条数还是对的、日期却是空的。
 */
export function activePolicies(store, marketplace) {
  const result = listPolicies(store, { marketplace, status: 'active' })
  const rows = Array.isArray(result.rows) ? result.rows : []
  return {
    count: rows.length,
    rows: rows.map(row => ({
      id: row.id,
      title: row.title,
      marketplace: row.marketplace ?? null,
      url: row.url ?? null,
      effectiveFrom: row.effectiveFrom ?? null,
      effectiveTo: row.effectiveTo ?? null,
      publishedAt: row.publishedAt ?? null,
      severity: row.severityHint ?? null,
      status: row.status,
      sourceName: row.sourceName ?? null,
      ruleIds: Array.isArray(row.ruleIds) ? row.ruleIds : [],
      /* 正文不进包：一份政策原文可能上万字，包要能冻得住。要读原文按 id 取。 */
      bodyIncluded: false,
    })),
  }
}

/**
 * ⑪ 政策与上架要求 — 这个站点当前**生效中**的政策。
 *
 * 只取 `status = 'active'`：被取代（superseded）与已过期（expired）的政策是历史，
 * 拿它们当写作依据会让文案遵守一条已经作废的规矩。历史仍有 `policyChain` 可查。
 *
 * 时间是 `max(effective_from, imported_at)` —— 政策这一类最要紧的日期是"什么时候
 * **开始**适用"，不是导入时间；`effective_from` 读不到时退回 `imported_at`，
 * 并把这个选择写在 note 里，而不是假装有一个生效日。
 */
function collectPolicies(store, { marketplace }) {
  const snapshot = activePolicies(store, marketplace)
  const rows = snapshot.rows

  if (rows.length === 0) {
    /* 这一支**不是** absent：政策库是存在的，读也读过了，答案是"这个站点当前没有
       生效中的政策"。把它写成 absent（"这一类在这个对象上不存在"）会把库的状态
       说成对象的状态 —— 而修法完全不同：前者要去导政策，后者要补对象。 */
    return entry('policies', {
      status: 'frozen',
      source: 'listPolicies @ policy',
      at: null,
      fields: [],
      count: 0,
      payload: [],
      note: `${marketplace} 站点在政策库里没有生效中的政策 —— 这是「读过了，0 条」，`
        + '不是「本仓没有这一类」。要用政策约束文案，先用 amzn_policy_import 导入。',
    })
  }

  return entry('policies', {
    status: 'frozen',
    source: 'listPolicies @ policy + policy_rule',
    /* 时间是"什么时候**开始**适用"，不是导入时间；`effective_from` 读不到时退回
       导入时间。这里不假装有一个生效日。 */
    at: maxIso(rows.flatMap(row => [row.effectiveFrom, row.importedAt, row.imported_at])),
    fields: [],
    count: rows.length,
    /* 形状由 `activePolicies` 一处决定（prepare 的数据包读同一份）—— 这里不再
       重新挑一遍字段，否则两处迟早会挑出不同的字段集。 */
    payload: rows,
    note: `读过了：${marketplace} 站点有 ${rows.length} 条生效中的政策（被取代 / 已过期的不算）。`
      + ' 正文不放进证据包，按 id 用 amzn_policy_list 取原文。',
  })
}

/* ─────────────────── review_topics（T70 后两态，lead 裁决 #6）───────────────────
 * 语义升级：不再是「本仓没有来源」——表（review_analysis_runs/review_annotations）与
 * 读口（readReviewAnalysis）都在。两态分开：
 *   有 run → frozen：引用 run（method_version / 词表哈希 / 覆盖率 / 样本量 / 时间）；
 *   没 run → 「这一类本轮没有生成」（跑一次 runReviewAnalysis 即有），**不许再说
 *            「本仓没有」**——那会喂给 T73 提示词组装，让 Agent 一直以为没有评论主题。
 */
function collectReviewTopics(store, ctx) {
  const parentAsin = resolveReviewFamily(store, { asin: ctx.asin, marketplace: ctx.marketplace })
  const analysis = readReviewAnalysis({ store, parentAsin, marketplace: ctx.marketplace })
  if (analysis.hasRun !== true) {
    return entry('review_topics', {
      status: 'absent',
      source: 'readReviewAnalysis @ review_analysis_runs',
      at: null,
      fields: COPY_FIELDS,
      count: null,
      payload: null,
      note: '本仓有来源（T70 的 review_analysis_runs / review_annotations），但这一类本轮没有生成——'
        + '跑一次评论分析（runReviewAnalysis）即可。不是「本仓没有」。',
    })
  }
  return entry('review_topics', {
    status: 'frozen',
    source: `readReviewAnalysis @ review_analysis_runs（${analysis.methodVersion}）`,
    at: analysis.triple?.time ?? null,
    fields: COPY_FIELDS,
    count: analysis.matchedN,
    payload: {
      labels: analysis.labels,
      coverage: analysis.coverage,
      sample: analysis.triple?.sample ?? null,
      labelsNote: analysis.labelsNote ?? null,
    },
    note: `评论主题来自词典法 ${analysis.methodVersion}（词表哈希 ${analysis.lexiconHash}）；`
      + `覆盖率 ${analysis.triple?.sample ?? '—'}；时间 ${analysis.triple?.time ?? '—'}。`
      + '标签不互斥：各标签计数合计可以大于样本数。',
  })
}

/* ───────────────────────────── the package ───────────────────────────── */
/**
 * All eleven classes for one run, in the canonical order.
 *
 * Every collector answers; none of them is skipped when it has nothing. A package
 * with nine rows would be indistinguishable from a package whose tenth class was
 * never looked at — and that is the whole failure this feature exists to end.
 */
export function collectEvidence(store, { run } = {}) {
  const asin = String(run?.asin ?? '').trim().toUpperCase()
  const marketplace = String(run?.marketplace ?? '').trim().toUpperCase()
  const ctx = { run, asin, marketplace }
  const byKind = {
    current_copy: () => collectCurrentCopy(store, ctx),
    keywords_plan: () => collectKeywordsPlan(store, ctx),
    rules: () => collectRules(store, ctx),
    prompts: () => collectPrompts(store, ctx),
    listing_history: () => collectListingHistory(store, ctx),
    review_topics: () => collectReviewTopics(store, ctx),
    qa: () => notModelled('qa'),
    competitor_opportunities: () => collectCompetitorOpportunities(store, ctx),
    product_line_brand: () => collectProductLineBrand(store, ctx),
    quality_gaps: () => collectQualityGaps(store, ctx),
    policies: () => collectPolicies(store, ctx),
  }
  return EVIDENCE_KINDS.map(kind => byKind[kind.id]())
}

/**
 * A canonical form for comparing two freezes.
 *
 * Key order must not decide whether the package "changed": an object built in a
 * different order holds the same evidence. So keys are sorted recursively and the
 * result is the string that gets compared.
 */
function canonical(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function signatureOf(row) {
  return canonical([
    row.status,
    row.source ?? null,
    row.at ?? null,
    Array.isArray(row.fields) ? row.fields : [],
    row.count ?? null,
    row.payload ?? null,
  ])
}

function hydrateEvidenceRow(row) {
  return {
    kind: row.kind,
    label: EVIDENCE_KINDS.find(kind => kind.id === row.kind)?.label ?? row.kind,
    status: row.status,
    source: row.source ?? null,
    at: row.source_at ?? null,
    fields: parseJson(row.fields_json, []),
    count: row.count === null || row.count === undefined ? null : Number(row.count),
    payload: parseJson(row.payload_json, null),
    note: row.note ?? null,
    frozenAt: row.frozen_at,
    createdAt: row.created_at,
  }
}

/** The rows stored for a run, in the canonical order (not the insert order). */
export function listEvidenceRows(store, runId) {
  const rows = store.all(
    'SELECT * FROM optimization_evidence WHERE run_id = ?',
    [String(runId ?? '').trim()],
  ).map(hydrateEvidenceRow)
  const order = new Map(EVIDENCE_KIND_IDS.map((id, index) => [id, index]))
  return rows.sort((left, right) => (order.get(left.kind) ?? 99) - (order.get(right.kind) ?? 99))
}

/**
 * Freeze the package. **One row per (run, kind) — and once frozen, the content
 * cannot change.**
 *
 * The comparison happens **before any write**, so a refusal leaves the package
 * exactly as it was: a half-refrozen package would be the worst of both, some
 * classes from the old reading and some from the new, with nothing saying which
 * is which.
 *
 * Idempotent by content, not by call count: `amzn_optimize_save` freezes again
 * (the listing may have been applied in between, and the report should say which
 * evidence it was written from), and re-freezing the same bytes is not a change.
 */
export function freezeEvidence(store, runId, entries, { now = new Date(), note = null } = {}) {
  const run = String(runId ?? '').trim()
  const existing = store.all('SELECT * FROM optimization_evidence WHERE run_id = ?', [run])
  const frozenAt = (now instanceof Date ? now : new Date(now)).toISOString()

  if (existing.length === 0) {
    for (const item of entries) {
      store.run(
        `INSERT INTO optimization_evidence
           (id, run_id, kind, status, source, source_at, fields_json, count, payload_json, note, frozen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `ev-${run}-${item.kind}`,
          run,
          item.kind,
          item.status,
          item.source ?? null,
          item.at ?? null,
          JSON.stringify(Array.isArray(item.fields) ? item.fields : []),
          item.count === null || item.count === undefined ? null : Number(item.count),
          item.payload === null || item.payload === undefined ? null : JSON.stringify(item.payload),
          item.note ?? note ?? null,
          frozenAt,
          frozenAt,
        ],
      )
    }
    return { ok: true, written: entries.length, unchanged: false, frozenAt }
  }

  const byKind = new Map(existing.map(row => [row.kind, row]))
  const drifted = []
  for (const item of entries) {
    const row = byKind.get(item.kind)
    if (row === undefined) { drifted.push(item.kind); continue }
    if (signatureOf(hydrateEvidenceRow(row)) !== signatureOf(item)) drifted.push(item.kind)
  }
  if (drifted.length === 0) {
    return { ok: true, written: 0, unchanged: true, frozenAt: existing[0].frozen_at }
  }
  return {
    ok: false,
    code: EVIDENCE_CODES.FROZEN,
    kinds: drifted,
    error: `证据包已经冻结，这 ${drifted.length} 类的内容与已冻结的不同：${drifted.join('、')}。`
      + '已冻结的内容是报告写下来的那一份，改写它会让报告与证据对不上。要接着改，用「基于此草案重新优化」开新的一轮。',
  }
}

/**
 * The package as stored, plus what is **not** in it.
 *
 * `missing` is not decoration: a run whose package holds nine rows must not read
 * as a complete package. It is the same distinction the three statuses make, one
 * level up.
 */
export function readEvidence(store, runId, { kind = null } = {}) {
  const run = store.get('SELECT * FROM optimization_run WHERE id = ?', [String(runId ?? '').trim()]) ?? null
  if (run === null) {
    return {
      ok: false,
      code: EVIDENCE_CODES.NO_RUN,
      error: `没有第 ${String(runId ?? '').slice(0, 8)} 轮优化 —— 证据包挂在轮次上，先跑一次 amzn_optimize_prepare。`,
    }
  }
  if (kind !== null && kind !== '' && !EVIDENCE_KIND_IDS.includes(String(kind))) {
    return {
      ok: false,
      code: EVIDENCE_CODES.UNKNOWN_KIND,
      error: `unknown evidence kind ${JSON.stringify(kind)} — 十一类是：${EVIDENCE_KIND_IDS.join(' / ')}`,
    }
  }

  const all = listEvidenceRows(store, run.id)
  const rows = kind === null || kind === '' ? all : all.filter(row => row.kind === String(kind))
  const present = new Set(all.map(row => row.kind))
  const missing = EVIDENCE_KIND_IDS.filter(id => !present.has(id))
  const frozenAt = all.length === 0 ? null : all.map(row => row.frozenAt).sort()[0]
  /* Derived, not flagged: a freeze that happened after the run was finalised is a
     late freeze, and the reader can see that from two timestamps it already has. */
  const lateFreeze = Boolean(frozenAt && run.finished_at && frozenAt > run.finished_at)

  let empty = null
  if (all.length === 0) {
    empty = {
      kind: 'no-evidence',
      text: '这一轮还没有证据包 —— 证据包在 amzn_optimize_prepare 建完轮次时冻结。'
        + '本批之前建的轮次会在 amzn_optimize_save 收尾时补冻。',
    }
  } else if (rows.length === 0) {
    empty = {
      kind: 'unknown-kind',
      text: `证据包里没有「${kind}」这一类（包里共 ${all.length} 类）。`,
    }
  }

  return {
    ok: true,
    runId: run.id,
    asin: run.asin,
    marketplace: run.marketplace,
    status: run.status,
    rulesVersion: run.rules_version ?? null,
    frozenAt,
    lateFreeze,
    counts: {
      kinds: EVIDENCE_KIND_IDS.length,
      frozen: all.filter(row => row.status === 'frozen').length,
      absent: all.filter(row => row.status === 'absent').length,
      notModelled: all.filter(row => row.status === 'not_modelled').length,
      present: all.length,
      missing: missing.length,
    },
    missing,
    rows,
    empty,
  }
}

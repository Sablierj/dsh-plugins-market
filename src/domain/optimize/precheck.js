/**
 * F13-02 — the nine pre-flight gates, evaluated as nine separate answers.
 *
 * §27.2 gives the list and §27.6 gives the failure contract:
 *
 *   九项门槛（对象明确 / 核心数据≤7 天 / 属性≤30 天 / 搜索量≤90 天 / 关键词已审核 /
 *   竞品组已确认 / 规则与 Prompt 可用 / 43 属性足够 / 评分≥3.8）；
 *   不满足输出补数清单或降级说明，不能悄悄猜。
 *
 * ## The one thing this module must never do
 *
 * "不能悄悄猜" is the whole requirement, and it fails in one specific way: a
 * gate that reports a number it did not measure. There are three ways to get
 * that wrong and each is handled explicitly here.
 *
 *   ① **No data is not zero.** A field with no `observed_at` has not been
 *      measured *old* — it has not been measured at all. `freshnessOf` already
 *      answers `unknown` for that, and `unknown` is a different verdict from
 *      `stale`: unknown degrades (and asks for the missing observation), stale
 *      blocks. Collapsing them would report "everything is out of date" on a
 *      store whose first collection has not run, which is the opposite of
 *      the truth.
 *   ② **No value is not an empty value.** The gates count `measured` rows by
 *      *content*, so `price = 0` and `price = NULL` land in different buckets —
 *      the same discipline `attributeCoverage` uses for placeholders.
 *   ③ **Not modelled is not "not measured".** Where this repo has no column for
 *      a gate's question (there is no `keyword.reviewed`), the gate says so in
 *      `basis` and asks for an explicit declaration instead of reading a
 *      neighbouring column and calling it a review.
 *
 * ## Verdicts, and why only three gates can block
 *
 * `pass` / `degrade` / `block`. A block is reserved for facts that say "we
 * looked, and this listing must not be optimized yet":
 *
 *   核心数据过期（dated and >7 days）   the numbers the copy will cite are known
 *                                       to be out of date — citing them is
 *                                       precisely the "猜" §27.6 forbids.
 *   规则不可用                          there is no rule set to judge the draft.
 *   评分 <3.8                          §27.6: 先提示产品问题，默认不做**大规模**文案
 *                                       优化 — so it blocks 全量 / 增量 and only
 *                                       degrades a 专项 (which does not rewrite
 *                                       the listing wholesale).
 *
 * Everything else degrades, and a degrade is a *finding*, not a shrug: it names
 * the missing thing, the module that owns it, and the tool that fixes it. §27.1's
 * worked example is exactly a degrade ("属性快照 32 天超阈值 → 降级（属性建议标低
 * 置信度），不阻断"), so attributes are the reference case for the softer verdict.
 *
 * ## Thresholds are read, never restated
 *
 * 7 / 30 / 90 come from `FRESHNESS_DAYS` — the same table `DQ-FRESH-001/002/003`
 * and the freshness card read. Writing "7" here as a literal would let the gate
 * and the quality cockpit disagree about the same field, and the reader would
 * have no way to tell which of the two was lying.
 */

import { ageInDays, freshnessClassFor, freshnessLabel } from '../data/freshness.js'
import { KNOWN_MARKETPLACES } from '../rules/marketplaces.js'
import { REQUIRED_ATTRIBUTE_TARGET, attributeCoverage, attributeField } from '../rules/attributes.js'
import { loadActiveRoster } from '../../store/rules.js'
import { resolvePrompts } from '../../store/prompt.js'
import { ownershipForKeywords } from '../../store/keyword-ownership.js'
import { keywordKey } from '../keywords/key.js'

/**
 * The machine code a blocked pre-flight returns.
 *
 * It lives here rather than in `domain/states.js`'s `PROBLEM_CODES` because this
 * batch's write scope is the optimize module, and because the code names a
 * refusal only this module raises. It is deliberately *not* a second vocabulary:
 * the shape (`code` for the branch, `error` for the person) is the one
 * ARCHITECTURE §9 fixes. Moving it into `PROBLEM_CODES` once a second module
 * wants it is a one-line change.
 */
export const PRECHECK_BLOCKED = 'OPTIMIZE_PRECHECK_BLOCKED'

export const PRECHECK_VERSION = 'optimize-precheck.v1'

/** The three answers a gate can give. Spelled out so nobody invents a fourth. */
export const PRECHECK_VERDICTS = ['pass', 'degrade', 'block']

export const PRECHECK_VERDICT_LABELS = { pass: '通过', degrade: '降级', block: '阻断' }

/** The nine, in §27.2's order. The order is the checklist's order on the page. */
export const PRECHECK_GATE_IDS = [
  'object',
  'core-freshness',
  'attribute-freshness',
  'search-volume',
  'keywords-reviewed',
  'competitors',
  'rules-prompts',
  'attributes-sufficient',
  'rating',
]

export const PRECHECK_GATE_LABELS = {
  object: '对象明确',
  'core-freshness': '核心数据 ≤7 天',
  'attribute-freshness': '属性 ≤30 天',
  'search-volume': '搜索量 ≤90 天',
  'keywords-reviewed': '关键词已审核',
  competitors: '竞品组已确认',
  'rules-prompts': '规则与 Prompt 可用',
  'attributes-sufficient': '43 属性足够',
  rating: '评分 ≥3.8',
}

/** The fields the "核心数据 ≤7 天" gate judges. Every one has a 7-day band. */
export const CORE_FRESHNESS_FIELDS = ['title', 'price', 'bsr', 'rating']

/** The two snapshots the "属性 ≤30 天" gate judges. Both have a 30-day band. */
export const SNAPSHOT_FRESHNESS_FIELDS = ['attributes', 'backend']

/** §27.6's rating floor. Below it, a wholesale rewrite is the wrong first move. */
export const RATING_FLOOR = 3.8

/* ── small shared pieces ───────────────────────────────────────────────────── */

/** A day count for a reader: `12 天`, or `—` when there is no measurement. */
function days(n) {
  return n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : `${Math.round(Number(n) * 10) / 10} 天`
}

/** One measured row. `state` is the four-state vocabulary, not a boolean. */
function row(name, value, state, { at = null, note = null } = {}) {
  return { name, value, state, at, note }
}

/**
 * One gate's answer, with the fields every gate must carry.
 *
 * `counts.total` is the denominator and it is **never** derived from the
 * findings: "3 of 4 core fields are dated" and "3 findings" are different
 * numbers, and a denominator that silently shrank to the number of problems
 * would make every ratio read as 100%.
 */
function gate(id, index, { criterion, basis, verdict, counts, measured, missing = [], remedy = [], degradeNotes = [], notes = [] }) {
  return {
    id,
    index,
    label: PRECHECK_GATE_LABELS[id],
    criterion,
    basis,
    verdict,
    counts,
    measured,
    missing,
    remedy,
    degradeNotes,
    notes,
  }
}

/** A remedy line: which module owns the gap and which tool closes it. */
function fix(moduleLabel, module_, action, tool = null) {
  return { module: module_, moduleLabel, action, tool }
}

/** `listing.attributes_json` keyed either way — `material` or `attribute.material`. */
function attributeFieldsFrom(listing) {
  const raw = listing?.attributes
  if (raw === null || raw === undefined || typeof raw !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    out[String(key).startsWith('attribute.') ? String(key) : attributeField(String(key))] = value
  }
  return out
}

/** Latest `observed_at` per field, plus how many of that field's rows are undated. */
function observationIndex(store, asin, marketplace) {
  const rows = store.all(
    `SELECT field, MAX(observed_at) AS observed_at, COUNT(*) AS rows,
            SUM(CASE WHEN observed_at IS NULL THEN 1 ELSE 0 END) AS undated
       FROM asin_field_source
      WHERE asin = ? AND marketplace = ?
      GROUP BY field`,
    [asin, marketplace],
  )
  const map = new Map()
  for (const entry of rows) {
    map.set(entry.field, {
      at: entry.observed_at ?? null,
      rows: Number(entry.rows ?? 0),
      undated: Number(entry.undated ?? 0),
    })
  }
  return map
}

/* ── the nine gates ────────────────────────────────────────────────────────── */

/**
 * ① 对象明确 — is the thing being optimized a thing we can name?
 *
 * This gate never blocks, and that is a decision rather than an omission. Its
 * gaps are all *fillable*: a missing ASIN row is closed by collecting, a missing
 * brand by setting ownership. Blocking there would stop a user from even
 * planning the run that would tell them what to collect. The hard stops are kept
 * for the gates whose answer is "we looked and the data is wrong", which no
 * amount of trying again will change.
 */
function gateObject(store, { asin, marketplace }) {
  const asinRow = store.get('SELECT asin, brand, product_line_id FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace]) ?? null
  const owned = new Set(
    store.all(
      `SELECT DISTINCT object_type FROM asin_ownership
        WHERE asin = ? AND marketplace = ? AND retracted_at IS NULL`,
      [asin, marketplace],
    ).map(entry => entry.object_type),
  )
  /* 2026-10-25 真实数据实测（R-11）：**「店铺」这一格原来是死的。**
     `asin_ownership.object_type` 的 schema 允许 `shop`，但唯一的写入口
     `refusalForAsinOwnership` 只放行 `['side', 'product_line']`，并明说
     「brand / shop 由别的路径维护」—— 而全仓**没有任何代码**往 asin_ownership 写 shop。
     于是 `owned.has('shop')` 恒为 false，第 1 门**永远降级**，无论补多少数据。

     「别的路径」是 `product_profile`（店铺 + 品牌 + 产品线 + ASIN 四元组，见 schema）。
     原来只有 brand / product_line 两格带兜底，**唯独店铺没有** —— 这里补上，
     让门槛承认那条已经存在的合法路径。**不推翻 refusal 的设计**（它仍然不管 shop），
     只是让门槛去它真正该看的地方看。 */
  const profileShop = store.get(
    `SELECT shop_id FROM product_profile
      WHERE asin = ? AND marketplace = ? AND shop_id IS NOT NULL AND shop_id <> ''
      LIMIT 1`,
    [asin, marketplace],
  )?.shop_id ?? null

  const siteKnown = KNOWN_MARKETPLACES.includes(marketplace)
  const elements = [
    { name: '对象（ASIN 行）', ok: asinRow !== null, missing: '库里没有这个 ASIN 的采集行' },
    { name: '站点（已核验站点表）', ok: siteKnown, missing: `站点 ${marketplace} 不在已核验站点表里` },
    /* 三格的兜底口径现在一致：owned（决策表）**或**那一格自己的落点（asin 行 / product_profile）。 */
    { name: '店铺', ok: owned.has('shop') || profileShop !== null, missing: profileShop === null ? '没有店铺归属记录（asin_ownership 不接受 shop，product_profile 里也没有这个 ASIN 的 shop_id）' : '' },
    { name: '品牌', ok: owned.has('brand') || (asinRow?.brand ?? '') !== '', missing: '没有品牌归属记录，也没有 asin.brand' },
    { name: '产品线', ok: owned.has('product_line') || (asinRow?.product_line_id ?? null) !== null, missing: '没有产品线归属记录' },
  ]
  const missing = elements.filter(entry => !entry.ok).map(entry => entry.missing)
  const matched = elements.filter(entry => entry.ok).length

  return gate('object', 1, {
    criterion: '五个身份要素（对象 / 站点 / 店铺 / 品牌 / 产品线）全部可解析',
    basis: '对象与站点来自 asin 行与 domain/rules/marketplaces.js 的已核验站点表；品牌 / 产品线来自 asin_ownership 的生效行（retracted_at 为空）或 asin 行本身的那一列；**店铺**来自 product_profile.shop_id（asin_ownership 的写入口不接受 shop，它明说 brand / shop 由别的路径维护，那条路径就是 product_profile）。',
    verdict: matched === elements.length ? 'pass' : 'degrade',
    counts: { matched, total: elements.length, label: '身份要素' },
    measured: elements.map(entry => row(entry.name, entry.ok ? '已解析' : '缺', entry.ok ? 'fresh' : 'missing')),
    missing,
    remedy: missing.length === 0 ? [] : [
      fix('采集', 'collect', '先把这个 ASIN 采集入库（对象 / 站点要素）', 'amzn_collect_run'),
      fix('配置', 'settings', '在设置页给这个 ASIN 记归属：店铺 / 品牌 / 产品线（配置要素）', 'amzn_workbench_context'),
    ],
    notes: ['这一项不阻断：它的缺口都是「补一次就有」的，阻断会让用户连「该补什么」的那一轮都跑不起来。硬阻断留给「已经看过、结果说不能优化」的三项。'],
  })
}

/**
 * ② 核心数据 ≤7 天 — the gate the whole feature exists for.
 *
 * Four states per field, and they are four because three of them need different
 * follow-up work: `fresh` nothing, `stale` re-collect (and the run is blocked),
 * `undated` record when it was observed, `absent` collect the value itself.
 */
function gateCoreFreshness(store, { asin, marketplace, now }) {
  const band = freshnessClassFor('price')
  const asinRow = store.get('SELECT title, price, bsr, rating FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace]) ?? null
  const listing = store.get('SELECT title FROM listing WHERE asin = ? AND marketplace = ?', [asin, marketplace]) ?? null
  const observations = observationIndex(store, asin, marketplace)

  const hasValue = (field) => {
    if (field === 'title') return (listing?.title ?? '') !== '' || (asinRow?.title ?? '') !== ''
    const value = asinRow?.[field]
    return value !== null && value !== undefined
  }

  const measured = []
  const stale = []
  const undated = []
  const absent = []
  let dated = 0

  for (const field of CORE_FRESHNESS_FIELDS) {
    const observation = observations.get(field) ?? null
    const at = observation?.at ?? null
    const age = at === null ? null : ageInDays(at, now)
    /* A timestamp in the future is not fresher than fresh — it is a clock
       problem or a hand-edited row (`freshnessOf` makes the same call). Counting
       it as dated would let a fabricated timestamp buy a pass. */
    const usable = age !== null && age >= 0

    if (hasValue(field) && usable && age > band) {
      stale.push(field)
      measured.push(row(field, days(age), 'stale', { at, note: `超过 ${freshnessLabel(band)}` }))
      continue
    }
    if (hasValue(field) && usable) {
      dated += 1
      measured.push(row(field, days(age), 'fresh', { at, note: `在 ${freshnessLabel(band)}内` }))
      continue
    }
    if (hasValue(field)) {
      undated.push(field)
      measured.push(row(field, '有值、无观测时间', 'unknown', { at: null, note: 'observed_at 为空，无法判定新鲜度（DQ-TRACE-001 的那一类）' }))
      continue
    }
    absent.push(field)
    measured.push(row(field, '无值', 'missing', { at: null, note: '库里这个字段本身是空的' }))
  }

  const verdict = stale.length > 0 ? 'block' : (undated.length > 0 || absent.length > 0 || dated < CORE_FRESHNESS_FIELDS.length) ? 'degrade' : 'pass'
  const missing = [
    ...stale.map(field => `${field} 的最近观测是 ${days(ageInDays(observations.get(field)?.at ?? null, now))}前，超过 ${freshnessLabel(band)}`),
    ...undated.map(field => `${field} 有值但没有观测时间`),
    ...absent.map(field => `${field} 没有值`),
  ]

  return gate('core-freshness', 2, {
    criterion: `${CORE_FRESHNESS_FIELDS.length} 个核心字段（title / price / bsr / rating）各自的最近观测都在 ${freshnessLabel(band)}内`,
    basis: '观测时间取自 asin_field_source.observed_at（按字段取最新一条）；值的「有没有」按内容判断，不按参数是否为 null。阈值来自 domain/data/freshness.js 的 FRESHNESS_DAYS，与数据质量模块同一份。',
    verdict,
    counts: { matched: dated, total: CORE_FRESHNESS_FIELDS.length, label: '核心字段' },
    measured,
    missing,
    remedy: missing.length === 0 ? [] : [
      fix('采集', 'collect', `重新采集这些字段，记下 observed_at（${[...stale, ...undated, ...absent].join('、') || '—'}）`, 'amzn_collect_run'),
      fix('数据质量', 'quality', '在质量驾驶舱确认这些字段的时效问题，扫完再看这一项', 'amzn_dq_scan'),
    ],
    degradeNotes: [
      ...(stale.length > 0 ? [`${stale.length} 个字段已过期：这一轮会阻断，因为文案里要引用的数字是已知过时的。`] : []),
      ...(undated.length > 0 ? [`${undated.length} 个字段有值但没有观测时间：不阻断，但新鲜度无法判定，本轮引用它们的字段要标低置信度。`] : []),
      ...(absent.length > 0 ? [`${absent.length} 个字段库里没有值：不阻断，但文案不能从别处猜这个数字。`] : []),
    ],
  })
}

/**
 * ③ 属性 ≤30 天 — §27.1's worked example, which is a *degrade*.
 *
 * Two snapshots, not four fields: "Backend/属性" is one band in the rule table
 * (`FRESHNESS_DAYS.backend` and `.attributes` are both 30), and the two live in
 * different places — the attribute set on the listing row, the backend terms in
 * the listing's `search_terms`. Both are read from the listing row when they
 * have content, because that row *is* the snapshot we hold; when a dated
 * `asin_field_source` row exists it wins, because it says when somebody looked.
 */
function gateAttributeFreshness(store, { asin, marketplace, now }) {
  const band = freshnessClassFor('attributes')
  const listing = store.get(
    'SELECT attributes_json, search_terms, updated_at FROM listing WHERE asin = ? AND marketplace = ?',
    [asin, marketplace],
  ) ?? null
  const observations = observationIndex(store, asin, marketplace)

  const parts = [
    { field: 'attributes', present: listing !== null && (listing.attributes_json ?? '') !== '' && listing.attributes_json !== 'null', label: '属性快照（listing.attributes_json）' },
    { field: 'backend', present: listing !== null && (listing.search_terms ?? '').trim() !== '', label: '后台词快照（listing.search_terms）' },
  ]

  const measured = []
  const stale = []
  const undated = []
  const absent = []
  let dated = 0

  for (const part of parts) {
    const observation = observations.get(part.field) ?? null
    const at = observation?.at ?? (part.present ? listing?.updated_at ?? null : null)
    const source = observation?.at !== null && observation?.at !== undefined ? 'asin_field_source' : (at === null ? null : 'listing.updated_at')
    const age = at === null ? null : ageInDays(at, now)
    const usable = age !== null && age >= 0

    if (!part.present) {
      absent.push(part.label)
      measured.push(row(part.label, '无快照', 'missing', { at: null, note: 'listing 行里没有这份快照' }))
      continue
    }
    if (!usable) {
      undated.push(part.label)
      measured.push(row(part.label, '有快照、无时间', 'unknown', { at: null, note: '既没有带日期的观测行，listing 行也没有写入时间' }))
      continue
    }
    if (age > band) {
      stale.push(part.label)
      measured.push(row(part.label, days(age), 'stale', { at, note: `超过 ${freshnessLabel(band)}（基准 ${source}）` }))
      continue
    }
    dated += 1
    measured.push(row(part.label, days(age), 'fresh', { at, note: `在 ${freshnessLabel(band)}内（基准 ${source}）` }))
  }

  /* §27.1: a stale attribute snapshot degrades, it does not block. The saved
     consequence is that attribute suggestions come back marked low-confidence —
     `degradeNotes` carries that mark so prepare and the report can print it
     rather than leaving it in a module nobody reads. */
  const verdict = stale.length > 0 || undated.length > 0 || absent.length > 0 ? 'degrade' : 'pass'

  return gate('attribute-freshness', 3, {
    criterion: `属性与后台词两份快照都在 ${freshnessLabel(band)}内`,
    basis: '时间基准优先取 asin_field_source 的 observed_at（field=attributes / backend），没有则用 listing.updated_at —— 后者是这份快照的写入时间，不是观测时间，所以每一行都标出用了哪个基准。',
    verdict,
    counts: { matched: dated, total: parts.length, label: '快照' },
    measured,
    missing: [
      ...stale.map(label => `${label} 超过 ${freshnessLabel(band)}`),
      ...undated.map(label => `${label} 没有可用的时间基准`),
      ...absent.map(label => `${label} 不存在`),
    ],
    remedy: remainingRemedy(stale, undated, absent),
    degradeNotes: stale.length > 0
      ? [`属性快照超过 ${freshnessLabel(band)}：本次运行降级，属性类建议一律标「低置信度」，需人工确认后才可采纳（模块设计 §27.1 的原话）。`]
      : [],
  })
}

/** The shared "go refresh the snapshots" remedy, said once. */
function remainingRemedy(stale, undated, absent) {
  if (stale.length === 0 && undated.length === 0 && absent.length === 0) return []
  return [
    /* 采集能刷新的是**属性**那一份（2026-10-20 起采集会把 attribute.* 投影进
       listing.attributes_json）。后台搜索词不在采集范围内 —— 它在 Seller Central
       后台，前台页面看不到，所以同一句话里不能把两份快照说成都能重采。 */
    fix('采集', 'collect', '重采一次 13 节详情，刷新属性快照（采集会把页面规格表里的属性投影进库）；'
      + '后台搜索词不在采集范围内 —— 那一份要人工或从后台导出补', 'amzn_collect_run'),
    fix('ASIN', 'asin', '或在 ASIN 详情页手工补属性 / 后台词，写入时间是这份快照的时间基准', 'amzn_asin_upsert'),
  ]
}

/**
 * ④ 搜索量 ≤90 天 — per keyword in this round, not per row in the library.
 *
 * The denominator is the keyword set the run will actually use, because "the
 * library has fresh volumes somewhere" is not a fact about the words being
 * embedded. A volume with no date is reported `undated` rather than fresh: the
 * keyword table's `updated_at` is when the row was written, which is a usable
 * proxy and is labelled as one in `basis`.
 *
 * Never blocks. The 90-day band is `info` severity in `QUALITY_RULES`
 * (DQ-FRESH-003), and a gate that blocked where the quality cockpit only
 * informs would make the two disagree about the same fact.
 */
function gateSearchVolume(store, { asin, marketplace, keywords, now }) {
  const band = freshnessClassFor('searchVolume')
  const list = Array.isArray(keywords) ? keywords : []
  if (list.length === 0) {
    return gate('search-volume', 4, {
      criterion: `本轮关键词的搜索量观测都在 ${freshnessLabel(band)}内`,
      basis: '关键词来自本轮 prepare 的包（origin 可能是 measured / untested / master）。',
      verdict: 'degrade',
      counts: { matched: 0, total: 0, label: '关键词' },
      measured: [row('本轮关键词', '0 个', 'missing', { note: '这一轮没有关键词，搜索量无从判定' })],
      missing: ['这一轮一个关键词都没有'],
      remedy: [fix('关键词', 'keywords', '先建关键词库并测覆盖，再跑优化', 'amzn_keyword_discover')],
      degradeNotes: ['没有关键词的运行仍然可以继续 —— 那是一场没有埋词目标的文案优化，报告里会写明。'],
    })
  }

  const keys = [...new Set(list.map(entry => keywordKey(entry.keyword ?? entry)).filter(key => key !== ''))]
  const library = new Map()
  for (let start = 0; start < keys.length; start += 200) {
    const chunk = keys.slice(start, start + 200)
    const holders = chunk.map(() => '?').join(', ')
    for (const entry of store.all(
      /* 2026-10-25（R-20）：原来只读 `keyword`（legacy 16 行），**而搜索量在 `kw_master`**。
         实拍：这一门说「16 个词都没有搜索量」，可 `kw_master` 里 13/16 都有 ——
         `bench cushion` **73,233**、`bench cushions for outdoor furniture` 31,330、
         `bench cushion cover` 12,594。**数据在库里，门槛却看不见它。**

         这是本批最重的一类错误：不是算错，是**读错了表**。
         「本轮有哪些词」来自 `keyword`；「这个词的搜索量」应当以 `kw_master` 为准
         （它是导入的 ABA / 广告报表合成出来的，`keyword` 那一列几乎没有值）。
         两侧都有值时以 master 为准，`updated_at` 跟着值走 —— **取值和取值时间必须同一个来源**，
         否则会出现「用 A 的量配 B 的时间」这种无法解释的行。 */
      `SELECT k.keyword AS keyword,
              COALESCE(m.search_volume, k.search_volume) AS search_volume,
              CASE WHEN m.search_volume IS NOT NULL THEN m.updated_at ELSE k.updated_at END AS updated_at
         FROM keyword k
         LEFT JOIN kw_master m
                ON m.keyword = k.keyword AND m.marketplace = k.marketplace
        WHERE k.marketplace = ? AND k.keyword IN (${holders})`,
      [marketplace, ...chunk],
    )) {
      library.set(keywordKey(entry.keyword), entry)
    }
  }

  const measured = []
  const fresh = []
  const stale = []
  const undated = []
  const noVolume = []

  for (const key of keys) {
    const entry = library.get(key) ?? null
    const volume = entry?.search_volume ?? null
    if (volume === null || volume === undefined) {
      noVolume.push(key)
      measured.push(row(key, '无搜索量', 'missing', { note: '关键词库里这个词没有 search_volume' }))
      continue
    }
    const at = entry?.updated_at ?? null
    const age = at === null ? null : ageInDays(at, now)
    const usable = age !== null && age >= 0
    if (!usable) {
      undated.push(key)
      measured.push(row(key, `搜索量 ${volume}`, 'unknown', { at: null, note: '有量、没有可用的时间基准' }))
      continue
    }
    if (age > band) {
      stale.push(key)
      measured.push(row(key, `搜索量 ${volume}`, 'stale', { at, note: days(age) + `前写入，超过 ${freshnessLabel(band)}` }))
      continue
    }
    fresh.push(key)
    measured.push(row(key, `搜索量 ${volume}`, 'fresh', { at, note: days(age) + '前写入' }))
  }

  const missing = [
    ...stale.map(key => `${key} 的搜索量超过 ${freshnessLabel(band)}`),
    ...undated.map(key => `${key} 的搜索量没有时间基准`),
    ...noVolume.map(key => `${key} 没有搜索量`),
  ]

  return gate('search-volume', 4, {
    criterion: `${keys.length} 个关键词的搜索量观测都在 ${freshnessLabel(band)}内`,
    basis: '时间基准是 keyword.updated_at（关键词库行的写入时间 = 这份搜索量进库的时间）；没有量记 missing、有量没时间记 unknown —— 两者不是同一件事。',
    verdict: fresh.length === keys.length ? 'pass' : 'degrade',
    counts: { matched: fresh.length, total: keys.length, label: '关键词' },
    measured,
    missing,
    remedy: missing.length === 0 ? [] : [
      fix('关键词总库', 'keywords', '重新导入 ABA / 广告报表，刷新这些词的搜索量与写入时间', 'amzn_kw_import'),
      fix('关键词', 'keywords', '或对这批词重跑一次覆盖测量', 'amzn_keyword_scan'),
    ],
    degradeNotes: [
      ...(stale.length > 0 ? [`${stale.length} 个词的搜索量超过 ${freshnessLabel(band)}（DQ-FRESH-003 是 info 级）：不阻断，但按搜索量分层排出的优先级会失准。`] : []),
      ...(noVolume.length > 0 ? [`${noVolume.length} 个词没有搜索量：它们只能按排名分层，不能按量排序。`] : []),
    ],
  })
}

/**
 * ⑤ 关键词已审核 — and an honest statement about what is *not modelled*.
 *
 * There is no `keyword.reviewed` column anywhere in this schema, so a gate that
 * claimed to read "reviewed" would be inventing a fact. What exists:
 *
 *   - `keyword_ownership` active claims (module 08's workbench), which are a
 *     human decision about a word, and are read through `ownershipForKeywords`
 *     so this gate and the workbench cannot disagree about who owns a word;
 *   - an explicit declaration on the run, which is the §27.2 "已审核" claim
 *     stated by the person making it and recorded in the run's package.
 *
 * Either closes the gate; the `basis` says which one did, per word.
 */
function gateKeywordsReviewed(store, { asin, marketplace, keywords, declarations }) {
  const list = Array.isArray(keywords) ? keywords : []
  const declared = declarations?.keywordsReviewed === true

  if (list.length === 0) {
    return gate('keywords-reviewed', 5, {
      criterion: '本轮的每个关键词都有审核痕迹（所有权认领）或本轮明确声明已审核',
      basis: '本仓没有「关键词相关性已审核」这一列 —— 这一项判的是声明 + 模块 08 的所有权认领痕迹，不假装它们是同一个状态。',
      verdict: 'degrade',
      counts: { matched: 0, total: 0, label: '关键词' },
      measured: [row('本轮关键词', '0 个', 'missing', { note: '没有词就没有可审核的对象' })],
      missing: ['这一轮没有关键词'],
      remedy: [fix('关键词', 'keywords', '先建库并测覆盖，再谈相关性审核', 'amzn_keyword_discover')],
      notes: ['「没有建模」与「没测到」是两件事：本仓确实没有审核状态列（没建模）；这一轮也一个词都没有（没测到）。两条都成立。'],
    })
  }

  const keys = [...new Set(list.map(entry => keywordKey(entry.keyword ?? entry)).filter(key => key !== ''))]
  const ownership = ownershipForKeywords(store, { marketplace, keywords: keys })
  const claimed = []
  const unclaimed = []
  for (const key of keys) {
    const view = ownership.get(key) ?? null
    if (view !== null && (view.claimCount ?? 0) > 0) claimed.push(key)
    else unclaimed.push(key)
  }

  const matched = declared ? keys.length : claimed.length
  const basis = declared
    ? '调用方在 prepare 里明确声明 keywordsReviewed —— 这是一个被记录下来的声明，不是从库里读出来的状态。'
    : '判据是模块 08 的 keyword_ownership 生效认领（status=claimed），读取口径与所有权工作台同一个函数（ownershipForKeywords）。本仓没有 keyword.reviewed 列。'

  return gate('keywords-reviewed', 5, {
    criterion: `${keys.length} 个关键词都已有审核痕迹或本轮声明已审核`,
    basis,
    verdict: matched === keys.length ? 'pass' : 'degrade',
    counts: { matched, total: keys.length, label: '关键词' },
    measured: [
      row('已认领（keyword_ownership）', `${claimed.length} 个`, claimed.length > 0 ? 'confirmed' : 'missing', { note: claimed.slice(0, 10).join('、') || '（无）' }),
      row('仅声明 keywordsReviewed', declared ? '是' : '否', declared ? 'confirmed' : 'unknown'),
      row('两者皆无', `${declared ? 0 : unclaimed.length} 个`, (declared || unclaimed.length === 0) ? 'confirmed' : 'missing', { note: declared ? '（声明覆盖全部）' : (unclaimed.slice(0, 10).join('、') || '（无）') }),
    ],
    missing: matched === keys.length ? [] : [`${declared ? 0 : unclaimed.length} 个词既没有所有权认领，本轮也没有声明已审核：${declared ? '' : unclaimed.slice(0, 10).join('、')}`],
    remedy: matched === keys.length ? [] : [
      fix('关键词所有权', 'keywords', '在所有权工作台逐词认领，或对这批词重跑一次所有权判定', 'amzn_keyword_ownership_resolve'),
      fix('优化运行', 'optimize', '如果这批词确实已经人工审过，在 prepare 里带 keywordsReviewed: true，把这个声明记进运行包', 'amzn_optimize_prepare'),
    ],
    degradeNotes: matched === keys.length ? [] : ['未审核的词直接埋进文案是 §27.5 明令禁止的动作（「未审关键词直接埋词」），所以这一项降级时，本轮的关键词分配只作为建议、不作为结论。'],
    notes: ['「关键词相关性已审核」在本仓没有专门建模：判据是声明 + 所有权认领痕迹，两者的来源逐条写在 basis 里。'],
  })
}

/**
 * ⑥ 竞品组已确认 — a set for this site, or an explicit "there are none".
 *
 * §27.2 says "竞品组已确认或明确无竞品输入", so the second half is a real
 * answer and needs a way to be said. `noCompetitors: true` on the run is that
 * way, and it is recorded in the run package like any other declaration —
 * "we decided there are no competitors" is a different fact from "nobody looked",
 * and only the first one closes this gate.
 */
function gateCompetitors(store, { asin, marketplace, declarations }) {
  const sets = store.all(
    'SELECT id, name, asins_json, updated_at FROM competitor_set WHERE marketplace = ? ORDER BY updated_at DESC',
    [marketplace],
  )
  const declared = declarations?.noCompetitors === true
  const contains = sets.filter((entry) => {
    try {
      const asins = JSON.parse(entry.asins_json ?? '[]')
      return Array.isArray(asins) && asins.map(item => String(item).toUpperCase()).includes(asin)
    } catch {
      return false
    }
  })

  const verdict = sets.length > 0 || declared ? 'pass' : 'degrade'
  const missing = verdict === 'pass' ? [] : [`${marketplace} 站点没有任何竞品组，本轮也没有声明「无竞品输入」`]

  return gate('competitors', 6, {
    criterion: '本站点存在至少一个竞品组，或本轮明确声明无竞品输入',
    basis: '竞品组读 competitor_set（按站点），确认口径是「这个站点有组」；本 ASIN 是否出现在组里只作为附注显示。没有组时，第二半靠调用方的 noCompetitors 声明关闭。',
    verdict,
    counts: { matched: (sets.length > 0 ? 1 : 0) + (declared ? 1 : 0), total: 1, label: '竞品输入' },
    measured: [
      row('本站点竞品组', `${sets.length} 个`, sets.length > 0 ? 'confirmed' : 'missing', { note: sets.slice(0, 5).map(entry => entry.name).join('、') || '（无）' }),
      row('本 ASIN 在某个组里', contains.length > 0 ? '是' : '否', contains.length > 0 ? 'confirmed' : 'fresh', { note: '竞品组装的是竞品 ASIN；本 ASIN 在里面只说明它被当成别人的竞品' }),
      row('声明 noCompetitors', declared ? '是' : '否', declared ? 'confirmed' : 'unknown'),
    ],
    missing,
    remedy: missing.length === 0 ? [] : [
      fix('竞品', 'competitor', '建一个本站点的竞品组（名称 + 竞品 ASIN）', 'amzn_competitor_set_upsert'),
      fix('优化运行', 'optimize', '或确认确实没有竞品输入，在 prepare 里带 noCompetitors: true', 'amzn_optimize_prepare'),
    ],
    degradeNotes: verdict === 'pass' ? [] : ['没有竞品输入时，文案只能与自身历史比 —— 报告里不会出现竞品均值这类对比证据。'],
  })
}

/**
 * ⑦ 规则与 Prompt 可用 — two halves that fail differently.
 *
 * No rule set blocks: `runGates` and `validateDraft` would have nothing to judge
 * with, so a draft produced from this run could not be checked at all. Missing
 * prompts only degrades: the model can still be asked to write, and the tool
 * already discloses the empty library — but a run whose strategy layer is empty
 * is a run with no declared writing policy, and the report should say so.
 */
function gateRulesPrompts(store, { asin }) {
  let roster = null
  let rosterError = null
  try {
    roster = loadActiveRoster(store)
  } catch (error) {
    rosterError = error?.message ?? String(error)
  }
  const ruleCount = Number(roster?.count ?? 0)

  let layers = []
  let promptError = null
  try {
    layers = resolvePrompts(store, {
      module: 'optimize',
      variables: { scope: asin, selectedKeywords: '', rulesVersion: roster?.version ?? '' },
    }).assemble ?? []
  } catch (error) {
    promptError = error?.message ?? String(error)
  }
  const desired = ['fixed', 'evidence', 'contract']
  const present = layers.map(entry => entry.layer)
  const missingLayers = desired.filter(layer => !present.includes(layer))

  const rulesOk = ruleCount > 0
  const promptsOk = layers.length > 0

  return gate('rules-prompts', 7, {
    criterion: '生效规则集不为空，且 optimize 的组装提示词有 fixed / evidence / contract 三层',
    basis: '规则来自 loadActiveRoster（库里没有规则集时代码种子兜底并标 fromCode）；提示词来自 resolvePrompts 的 assemble 层，与 prepare 交给 agent 的是同一个调用。',
    verdict: rulesOk && promptsOk ? 'pass' : (rulesOk ? 'degrade' : 'block'),
    counts: { matched: (rulesOk ? 1 : 0) + (promptsOk ? 1 : 0), total: 2, label: '规则 / Prompt' },
    measured: [
      row('生效规则', ruleCount > 0 ? `${ruleCount} 条 · 版本 ${roster?.version ?? '—'}${roster?.fromCode ? '（代码种子兜底）' : ''}` : '0 条', ruleCount > 0 ? 'confirmed' : 'missing', { note: rosterError ?? '' }),
      row('optimize 组装提示词', layers.length > 0 ? `${layers.length} 层（缺 ${missingLayers.length} 层：${missingLayers.join('、') || '无'}）` : '0 层', promptsOk ? (missingLayers.length === 0 ? 'confirmed' : 'fresh') : 'missing', { note: promptError ?? '' }),
    ],
    missing: [
      ...(rulesOk ? [] : ['没有生效的规则集']),
      ...(promptsOk ? [] : ['optimize 没有组装提示词']),
    ],
    remedy: [
      ...(rulesOk ? [] : [fix('规则中心', 'rules', '导入或激活一套规则集', 'amzn_rule_import')]),
      ...(promptsOk ? [] : [fix('提示词库', 'prompts', '在「优化提示词专区」补上 optimize 的组装提示词（固定策略 / 证据 / 输出契约三层）', 'amzn_prompt_upsert')]),
    ],
    degradeNotes: promptsOk ? [] : ['提示词为空时这一轮仍然能跑，但没有任何声明的写作策略 —— 报告会把「当时被告知要怎么写」记为空白，而不是编一段。'],
    notes: missingLayers.length > 0 && promptsOk ? [`组装提示词缺层：${missingLayers.join('、')}。三层齐全才能保证写作策略、证据与输出契约都在。`] : [],
  })
}

/**
 * ⑧ 43 属性足够 — counted by content, placeholders included in the gap.
 *
 * `attributeCoverage` already answers this and already refuses to count `N/A`
 * as filled; re-implementing the count here would be the second completeness
 * number the completeness rule warns about.
 */
function gateAttributesSufficient(store, { asin, marketplace }) {
  const listing = store.get('SELECT attributes_json FROM listing WHERE asin = ? AND marketplace = ?', [asin, marketplace]) ?? null
  const coverage = attributeCoverage(attributeFieldsFrom(listing === null ? null : { attributes: parseJson(listing.attributes_json, null) }))

  return gate('attributes-sufficient', 8, {
    criterion: `${REQUIRED_ATTRIBUTE_TARGET} 项必填属性都有非占位值`,
    basis: '判据来自 attributeCoverage：空字符串与 N/A / 待定 / 无 这类占位值同样算缺 —— 占位值看起来填了，其实是一个断开的节点。分母固定是 43，不随填了几项变化。',
    verdict: coverage.complete ? 'pass' : 'degrade',
    counts: { matched: coverage.filledCount, total: coverage.target, label: '必填属性' },
    measured: [
      row('已填（非占位）', `${coverage.filledCount} / ${coverage.target}`, coverage.filledCount > 0 ? 'confirmed' : 'missing'),
      row('空值', `${coverage.empty.length} 项`, coverage.empty.length === 0 ? 'confirmed' : 'missing', { note: coverage.empty.slice(0, 12).join('、') }),
      row('占位值（等同于空）', `${coverage.placeholder.length} 项`, coverage.placeholder.length === 0 ? 'confirmed' : 'missing', { note: coverage.placeholder.slice(0, 12).join('、') }),
    ],
    missing: coverage.complete ? [] : [`还差 ${coverage.missingCount} 项必填属性（空 ${coverage.empty.length} + 占位 ${coverage.placeholder.length}）`],
    remedy: coverage.complete ? [] : [
      /* 这句话原来写的是「属性是事实，**采集拿不到**、也不能从文案语义猜」。
         2026-10-20 的运营走查证伪了前半句：采集**拿得到**页面规格表里列出的那几项
         （实测 `attributes` 节 collected 5/5，其中 4 项落在 43 项里）。原文案会让运营
         一次性放弃整道门 —— 而其中 4/43 是能自动拿到的。现在改成说清覆盖面。
         R-95 起「去哪补」指向真的能写的那条路：在这之前仓里**没有人工写入口**，
         这句话只能指到 amzn_asin_upsert（它写的是 asin 表，不写 attributes_json）。 */
      fix('ASIN', 'asin', '在「优化 → 属性补齐」里逐项填（或 amzn_asin_attribute_set 批量写）；采集只能覆盖'
        + '页面规格表里列出的那几项（如 fill_material / color / size / brand），其余必须人工或后台补 ——'
        + '属性是事实，不能从文案语义猜', 'amzn_asin_attribute_set'),
      fix('优化运行', 'optimize', '或让本轮草案逐项给出建议值并标「需人工确认」', 'amzn_optimize_validate'),
    ],
    degradeNotes: coverage.complete ? [] : ['属性不足只降级、不阻断：属性建议会逐项标「需人工确认」，而不是替人猜一个硬事实（§7.6）。'],
  })
}

/**
 * ⑨ 评分 ≥3.8 — §27.6's "先提示产品问题，默认不做大规模文案优化".
 *
 * The word 大规模 is what makes this mode-dependent: a 专项 that only rewrites
 * the backend terms is not a wholesale rewrite, so it degrades instead of
 * blocking; 全量 / 增量 rewrite the listing and are blocked. 审核 generates
 * nothing at all and is never blocked by a product problem — a check is exactly
 * what you want to run on a listing whose product is struggling.
 */
function gateRating(store, { asin, marketplace, mode }) {
  const asinRow = store.get('SELECT rating FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace]) ?? null
  const rating = asinRow?.rating ?? null
  const hasRating = rating !== null && rating !== undefined && Number.isFinite(Number(rating))
  const value = hasRating ? Number(rating) : null
  const below = hasRating && value < RATING_FLOOR
  const wholesale = mode === 'full' || mode === 'incremental'

  const verdict = !hasRating ? 'degrade' : (below ? (wholesale ? 'block' : 'degrade') : 'pass')

  return gate('rating', 9, {
    criterion: `评分 ≥ ${RATING_FLOOR}`,
    basis: '评分取 asin.rating（本 ASIN 的实测值，不是竞品均值）。低于阈值时按运行模式分级：全量 / 增量阻断（§27.6「默认不做大规模文案优化」），专项与审核降级。',
    verdict,
    counts: { matched: hasRating && !below ? 1 : 0, total: 1, label: '评分门槛' },
    measured: [
      row('asin.rating', hasRating ? String(value) : '未测量', hasRating ? (below ? 'stale' : 'fresh') : 'missing', { note: hasRating ? (below ? `低于 ${RATING_FLOOR}` : `达到 ${RATING_FLOOR}`) : '库里没有评分，不是 0 分' }),
    ],
    missing: [
      ...(hasRating ? [] : ['这个 ASIN 没有评分数据']),
      ...(below ? [`评分 ${value} 低于 ${RATING_FLOOR}，先处理产品问题`] : []),
    ],
    remedy: [
      ...(hasRating ? [] : [fix('采集', 'collect', '先采到评分再判这一项', 'amzn_collect_run')]),
      ...(below ? [
        fix('评论', 'quality', '先看差评主题与产品问题：评分低于阈值时，文案优化通常不是杠杆', 'amzn_dq_scan'),
        fix('优化运行', 'optimize', '或改用专项模式，只做不涉及整体承诺的那一个专项', 'amzn_optimize_prepare'),
      ] : []),
    ],
    degradeNotes: below && !wholesale ? [`评分 ${value} < ${RATING_FLOOR}：本轮是${mode === 'audit' ? '审核' : '专项'}模式，不做大规模文案优化，只给检查结论或单专项建议。`] : [],
    notes: below && wholesale ? ['这一项阻断的是「大规模重写」，不是「不能看」：换专项模式或审核模式可以继续。'] : [],
  })
}

/* ── the report ───────────────────────────────────────────────────────────── */

/** `{ ok, ... }` → `{ ok:false, code, error }`; anything else is returned as-is. */
function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

/**
 * Evaluate all nine gates for one (asin, marketplace, mode) and return the report.
 *
 * Pure with respect to the store — it reads, never writes — so the page, the
 * tool and a test can all ask the same question and get the same answer. `now`
 * is a parameter so a test can pin "32 days after that observation" instead of
 * racing the clock.
 */
export function evaluatePrecheck(store, {
  asin,
  marketplace = 'US',
  keywords = [],
  mode = 'full',
  scope = null,
  declarations = {},
  now = new Date(),
} = {}) {
  const object = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? 'US').trim().toUpperCase()

  const gates = [
    gateObject(store, { asin: object, marketplace: market }),
    gateCoreFreshness(store, { asin: object, marketplace: market, now }),
    gateAttributeFreshness(store, { asin: object, marketplace: market, now }),
    gateSearchVolume(store, { asin: object, marketplace: market, keywords, now }),
    gateKeywordsReviewed(store, { asin: object, marketplace: market, keywords, declarations }),
    gateCompetitors(store, { asin: object, marketplace: market, declarations }),
    gateRulesPrompts(store, { asin: object, marketplace: market }),
    gateAttributesSufficient(store, { asin: object, marketplace: market }),
    gateRating(store, { asin: object, marketplace: market, mode }),
  ]

  return summarizeReport({
    asin: object,
    marketplace: market,
    mode,
    /* The scope *id* (`title`, `review-pain`, …), not its label: the label is a
       display concern and the page has its own table for it. */
    scope: scope ?? null,
    declarations: {
      keywordsReviewed: declarations?.keywordsReviewed === true,
      noCompetitors: declarations?.noCompetitors === true,
    },
    gates,
    now,
  })
}

/** Fold the nine answers into the report shape both callers depend on. */
function summarizeReport({ asin, marketplace, mode, scope, declarations, gates, now }) {
  const counts = { pass: 0, degrade: 0, block: 0 }
  for (const entry of gates) counts[entry.verdict] += 1

  const supplement = gates
    .filter(entry => entry.missing.length > 0)
    .map(entry => ({ gate: entry.id, gateLabel: entry.label, verdict: entry.verdict, missing: entry.missing, remedy: entry.remedy }))

  const degradations = gates
    .filter(entry => entry.verdict === 'degrade' && entry.degradeNotes.length > 0)
    .map(entry => ({ gate: entry.id, gateLabel: entry.label, notes: entry.degradeNotes }))

  const blocked = counts.block > 0
  return {
    version: PRECHECK_VERSION,
    ok: true,
    asin,
    marketplace,
    mode,
    scope,
    at: (now instanceof Date ? now : new Date(now)).toISOString(),
    verdict: blocked ? 'block' : (counts.degrade > 0 ? 'degrade' : 'pass'),
    blocked,
    counts: { ...counts, total: gates.length },
    gates,
    supplement,
    degradations,
    declarations,
    /** Only present when blocked — a refusal a caller can branch on. */
    ...(blocked ? { code: PRECHECK_BLOCKED } : {}),
  }
}

/** The blocking gates, in checklist order. */
export function blockingGates(report) {
  return (report?.gates ?? []).filter(entry => entry.verdict === 'block')
}

/**
 * The refusal an operator sees when a gate blocks.
 *
 * Structured on purpose: `code` for the branch, `gates` for the reader, `missing`
 * for "what is absent" and `remedy` for "where to go and fix it". A refusal that
 * only said "pre-flight failed" would force the caller to re-run the check to
 * find out what to do, which is the cost this feature exists to remove.
 */
export function precheckRefusal(report) {
  if (report === null || report === undefined || report.blocked !== true) return null
  const blocking = blockingGates(report)
  const missing = blocking.flatMap(entry => entry.missing.map(text => `${entry.label}：${text}`))
  const remedy = blocking.flatMap(entry => entry.remedy.map(entry2 => ({ gate: entry.id, gateLabel: entry.label, ...entry2 })))
  return {
    ok: false,
    code: PRECHECK_BLOCKED,
    verdict: report.verdict,
    gates: blocking.map(entry => ({
      id: entry.id,
      label: entry.label,
      criterion: entry.criterion,
      counts: entry.counts,
      measured: entry.measured,
    })),
    missing,
    remedy,
    error: `前置检查未过：${blocking.map(entry => entry.label).join('、')}。`
      + `缺：${missing.join('；') || '（见 gates）'}。`
      + `补数路径：${remedy.map(entry => `${entry.moduleLabel} → ${entry.action}`).join('；') || '（见 remedy）'}。`
      + '这一轮没有创建运行，也没有写入任何数据。',
  }
}

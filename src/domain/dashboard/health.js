/**
 * The six health cards on the home page.
 *
 * ## Each card is its own island
 *
 * The six read six different groups of tables. A dashboard that 500s because one
 * of them is broken is worse than a dashboard that says "this one card could not
 * be computed" — the other five are still true, and the user still has a page.
 * So every card is built inside its own `try/catch`, and a failure degrades to
 * one red card rather than a blank page. That is §32's 「单模块失败不拖垮」, and
 * the assertion for it injects a builder that always throws.
 *
 * ## The three fields every card must have
 *
 * `conclusion` / `denominator` / `updatedAt`. A card without a denominator is an
 * opinion — "37" means nothing until you know it is 37 out of 42 — and a card
 * without an `updatedAt` cannot be told from one that has not refreshed since
 * yesterday.
 *
 * ## Empty is not zero
 *
 * A store with no ASINs has a freshness rate of *nothing*, not of 0%. The
 * conclusion says 「暂无数据」 and the numerator/denominator are 0 — the page
 * draws the sentence, and a sentence that says "no data" cannot be mistaken for
 * a measurement that came out badly. This is the same rule as everywhere else in
 * this plugin: do not report a number nobody measured.
 *
 * ## Scope narrows the denominator
 *
 * Every card filters by the scope's marketplace when it is not `__all__`. A
 * card whose denominator ignored the scope would answer a question about a
 * different set of products than the bar above it claims.
 */

import { freshnessLabel, FRESHNESS_DAYS, freshnessOf } from '../data/freshness.js'
import { SCOPE_ALL } from '../context/scope.js'
import { SEED_ROSTER } from '../rules/listing-rules.js'
import { missingChecks } from '../rules/registry.js'

/** The sentence a card shows when there is nothing to measure. */
export const EMPTY_CONCLUSION = '暂无数据'

/** The sentence a card shows when its own builder threw. */
export const ERROR_CONCLUSION = '无法计算'

/** How many days of collection history a card looks back over. */
export const WINDOW_DAYS = 30

/** The card ids, in the order the page draws them. */
export const CARD_IDS = ['freshness', 'collection', 'fieldComplete', 'keywordCoverage', 'rulePolicyRisk', 'optimizationDraft']

/**
 * The marketplace a scope narrows to, or `null` for "every site".
 *
 * A helper rather than six copies: the six cards have to agree about what
 * `__all__` means, and six inline comparisons is six chances to write `===`
 * where `!==` was meant.
 */
function marketplaceOf(scope) {
  const value = String(scope?.marketplace ?? '').trim()
  if (value === '' || value.toLowerCase() === SCOPE_ALL) return null
  return value.toUpperCase()
}

/** `WHERE marketplace = ?` when the scope names one, otherwise nothing. */
function marketClause(scope, column = 'marketplace') {
  const market = marketplaceOf(scope)
  return market === null ? { sql: '', params: [] } : { sql: ` AND ${column} = ?`, params: [market] }
}

/** The newest timestamp in a list, or `null`. */
function newest(values) {
  const usable = values.filter(value => value !== null && value !== undefined && value !== '')
  if (usable.length === 0) return null
  return usable.reduce((latest, value) => (String(value) > String(latest) ? value : latest))
}

/** A card that counted something. */
function card(id, label, { numerator, denominator, unit, threshold, updatedAt, detailLink, source, note = null }) {
  const empty = denominator === 0
  /* 有分母、分子却是 0 —— 这不是「正常」，是「一样都没达标」。
     以前只有 empty / ok 两种，于是「字段完整率 0/1」也画成绿色「正常」。 */
  const ratio = empty ? null : numerator / denominator
  const belowThreshold = !empty && threshold !== null && threshold !== undefined && ratio < threshold
  const zeroOfMany = !empty && (threshold === null || threshold === undefined) && numerator === 0
  return {
    id,
    label,
    status: empty ? 'empty' : (belowThreshold || zeroOfMany ? 'attention' : 'ok'),
    conclusion: empty
      ? EMPTY_CONCLUSION
      : `${numerator}/${denominator} ${unit}`,
    numerator: empty ? 0 : numerator,
    denominator,
    unit,
    threshold: threshold ?? null,
    updatedAt: updatedAt ?? null,
    detailLink: detailLink ?? null,
    /* 2026-10-25（R-37）：**这个字段此前被静默丢掉。**
       `card()` 的参数解构里没有 `note`，所以调用方传了它、函数收了、然后无声地扔了 ——
       我在第 72 轮写 `note: '分母只数自有 ASIN…'` 时以为写进去了，
       实测读出来是 `(无)`。**一个只在代码里存在的说明，等于没有说明。**

       现在它进了返回值。前端读不读是另一回事（`detailLink` 那一层自己去取），
       但**函数答应了这件事就该做到** —— 悄悄丢字段是最难查的一类「不生效」：
       没有报错、没有空值、调用方以为写成功了。 */
    note: note ?? null,
    source,
  }
}

/* ─────────────────────────────── the six ─────────────────────────────── */

const CARD_SPECS = [
  {
    id: 'freshness',
    label: '数据新鲜度',
    source: 'asin ⋈ asin_snapshot',
    detailLink: '#asin',
    /**
     * The fraction of our ASINs with a snapshot collected inside the 7-day band.
     *
     * "自有 ASIN" means "a row in `asin`": that table only ever holds our own
     * products (competitors live in `kw_competitor_fact`), so there is no second
     * notion of ownership to reconcile here.
     */
    build(store, scope) {
      const market = marketClause(scope)
      /* 在架口径：归档 ASIN 是历史，不参与任何健康卡的分母（T54）。 */
      const asins = store.all(`SELECT asin, marketplace FROM asin WHERE archived_at IS NULL${market.sql}`, market.params)
      const cutoff = new Date(Date.now() - FRESHNESS_DAYS.price * 86_400_000).toISOString()
      let fresh = 0
      const stamps = []
      for (const row of asins) {
        const snapshot = store.get(
          'SELECT MAX(collected_at) AS at FROM asin_snapshot WHERE asin = ? AND marketplace = ?',
          [row.asin, row.marketplace],
        )
        const at = snapshot?.at ?? null
        stamps.push(at)
        /* One classification function, not a second `> cutoff` comparison: the
           card and `freshnessOf` must agree about what "7 days" means. */
        if (freshnessOf(at, 'price') === 'fresh') fresh += 1
      }
      return card('freshness', '数据新鲜度', {
        numerator: fresh,
        denominator: asins.length,
        unit: `个 ASIN 在 ${FRESHNESS_DAYS.price} 天内有新快照`,
        threshold: freshnessLabel(FRESHNESS_DAYS.price),
        updatedAt: newest(stamps),
        detailLink: '#asin',
        source: 'asin ⋈ asin_snapshot',
      })
    },
  },
  {
    id: 'collection',
    label: '采集成功率',
    source: 'collection_task',
    detailLink: '#collect',
    /**
     * Finished tasks that succeeded, over the last 30 days.
     *
     * P2-2：`window` 让同一张卡片能被算在**前一个等长窗口**上（30–60 天前），
     * 趋势因此与主数值走同一条实现 —— 不会出现"趋势用一套口径、数字用另一套"。
     * 缺省时行为与以前完全一致。 */
    build(store, scope, { window = null } = {}) {
      const market = marketplaceOf(scope)
      const days = window?.days ?? WINDOW_DAYS
      const endMs = window === null ? Date.now() : Date.now() - window.offsetDays * days * 86_400_000
      const startMs = endMs - days * 86_400_000
      const since = new Date(startMs).toISOString()
      const until = new Date(endMs).toISOString()
      /* A collection task has no `marketplace` column: its targets do. So the
         scope is applied to the targets, in JS — filtering on a column that does
         not exist would have thrown, which is how this was found. A task counts
         when at least one of its targets is in scope, because a task spanning two
         sites is work done for this scope. */
      const rows = store.all(
        "SELECT status, submitted_at, finished_at, targets_json FROM collection_task WHERE kind = 'asin' AND submitted_at >= ? AND submitted_at < ?",
        [since, until],
      ).filter(row => market === null || targetsInclude(row.targets_json, market))
      const finished = rows.filter(row => row.status === 'done' || row.status === 'failed' || row.status === 'partial')
      const done = finished.filter(row => row.status === 'done')
      return card('collection', '采集成功率', {
        numerator: done.length,
        denominator: finished.length,
        /* 2026-10-25（R-86）：这张卡的分母被**两重**条件收窄 —— SQL 里的 `kind = 'asin'`
           与 JS 里的「至少一个目标在本站点」（见上面那段注释）。**卡面原来一个字都没说**，
           于是读者会把它读成「所有采集都正常」；而库里此刻正有 2 条 `keyword` 采集任务失败，
           它们不出现在任何一张卡上。
           同一张页面上「字段完整率」那张会主动写「分母已排除竞品」—— 这里照它办。
           **只改说明，不动分子分母。** */
        unit: `个 ASIN 采集任务完全成功（${window === null ? `近 ${days} 天` : `前 ${days}–${days * 2} 天`}`
          + '；只算 kind=asin 且至少一个目标在本站点 —— 关键词采集任务不在里面）',
        threshold: freshnessLabel(days),
        updatedAt: newest(finished.map(row => row.finished_at)),
        detailLink: '#collect',
        source: 'collection_task',
      })
    },
  },
  {
    id: 'fieldComplete',
    label: '字段完整率',
    source: 'asin ⋈ listing',
    detailLink: '#asin',
    /**
     * ASINs whose listing carries a title, five bullets and a description.
     *
     * Those three are the ones every listing has and every report reads; a
     * listing missing one of them cannot be optimized, which is the decision this
     * card exists to support.
     *
     * `listing` **does** have an `attributes_json` column (migration v6
     * `optimization-runs`, `store/schema.js`). It holds the Seller Central-only
     * attributes the browser channel cannot read, and its only production writer is
     * the optimize flow applying an accepted draft (`tools/optimize.js` →
     * `upsertListing`). It is deliberately outside this count: a listing that has
     * only been collected is NULL on it, so the column cannot distinguish a
     * complete listing from an incomplete one — counting it would turn "never
     * pasted in" into "missing".
     */
    build(store, scope) {
      const market = marketClause(scope)
      /* 在架口径：归档 ASIN 不参与字段完整率的分母（T54）。 */
      const inShelf = store.all(
        `SELECT asin, marketplace FROM asin WHERE archived_at IS NULL${market.sql}`,
        market.params,
      )
      /* 2026-10-25（R-36）：**分母里混进了竞品。**
         实测：库里 4 个 ASIN，3 个是竞品（B09696LTCL / B0DQP37YND / B0DS49VC81），
         只有 B0GV55Q4JG 是自有的。竞品本来就不该有 listing，于是这张卡印「1/4」——
         看起来像「我们的 listing 四分之一完整」，**实际是 1/1**。

         `side` 归属此前**一条都没有**（`asin_ownership` 里 object_type='side' 是空的），
         所以第 71 轮先把那 4 条补上了。这里按 side 取分母。

         **没有 side 记录的 ASIN**：不默认当自有（会把竞品算进来），也不默认排除
         （会把新导入的自有 ASIN 漏掉）。两种口径分开，并在 `note` 里写明用的是哪种 ——
         一张卡只说数字不说口径，读者没法判断这个比率对谁成立。 */
      const selfAsins = new Set(store.all(
        "SELECT asin FROM asin_ownership WHERE object_type = 'side' AND object_id = 'self' AND retracted_at IS NULL",
      ).map(row => row.asin))
      const scopedBySide = selfAsins.size > 0
      const asins = scopedBySide ? inShelf.filter(row => selfAsins.has(row.asin)) : inShelf
      let complete = 0
      const stamps = []
      for (const row of asins) {
        const listing = store.get(
          'SELECT title, bullets_json, description, updated_at FROM listing WHERE asin = ? AND marketplace = ?',
          [row.asin, row.marketplace],
        )
        stamps.push(listing?.updated_at ?? null)
        if (listing === undefined) continue
        const bullets = safeArray(listing.bullets_json)
        if (nonEmpty(listing.title) && bullets.length > 0 && nonEmpty(listing.description)) complete += 1
      }
      return card('fieldComplete', '字段完整率', {
        numerator: complete,
        denominator: asins.length,
        /* 2026-10-25（R-36 收尾）：`card()` 不接收 `note`（传进去会静默丢掉，实测 `note` 读出来是 `(无)`），
           所以口径说明挂在 `unit` 上 —— **它必须出现在屏幕上**，否则 1/1 和 1/4 只是两个数字。 */
        unit: scopedBySide
          ? `个自有 ASIN 的 listing 有标题/五点/描述（分母已排除竞品：在架 ${inShelf.length} 个 → 自有 ${asins.length} 个）`
          : `个 ASIN 的 listing 有标题/五点/描述（库里没有任何 side 归属，分不出自有与竞品）`,
        threshold: null,
        updatedAt: newest(stamps),
        detailLink: '#asin',
        source: 'asin ⋈ listing ⋈ asin_ownership(side)',
      })
    },
  },
  {
    id: 'keywordCoverage',
    label: '关键词覆盖',
    source: 'asin_keyword',
    detailLink: '#research',
    /** ASINs with at least one keyword that ranks in the first page depth. */
    build(store, scope) {
      const market = marketClause(scope)
      /* 在架口径：归档 ASIN 不参与关键词覆盖的分母（T54）。 */
      const asins = store.all(`SELECT asin, marketplace FROM asin WHERE archived_at IS NULL${market.sql}`, market.params)
      let covered = 0
      const stamps = []
      for (const row of asins) {
        const hit = store.get(
          `SELECT COUNT(*) AS n, MAX(collected_at) AS at FROM asin_keyword
            WHERE asin = ? AND marketplace = ? AND rank IS NOT NULL`,
          [row.asin, row.marketplace],
        )
        stamps.push(hit?.at ?? null)
        if (Number(hit?.n ?? 0) > 0) covered += 1
      }
      return card('keywordCoverage', '关键词覆盖', {
        numerator: covered,
        denominator: asins.length,
        unit: '个 ASIN 至少有一个词进了排名',
        threshold: null,
        updatedAt: newest(stamps),
        detailLink: '#research',
        source: 'asin_keyword',
      })
    },
  },
  {
    id: 'rulePolicyRisk',
    label: '规则与政策',
    source: 'rule ⋈ policy',
    detailLink: '#rules',
    /**
     * Active rules that have an implementation.
     *
     * A `kind='code'` rule with no `CHECKS` entry is reported by the validator as
     * `rule-check-missing` and blocks — fail-closed. Counting them here means the
     * dashboard says so before a run does.
     */
    build(store) {
      const active = store.get('SELECT version FROM rule_set WHERE is_active = 1')
      /* No roster in the store: the **code seed** is in force, and the code seed
         is by definition implemented. Reporting 0/0 would read as "nothing is
         checked", which is the opposite of the truth. */
      const rows = active === undefined
        ? SEED_ROSTER.map(rule => ({ rule_id: rule.id, kind: rule.kind ?? 'code' }))
        : store.all('SELECT rule_id, kind FROM rule WHERE rule_set_version = ? AND deleted_at IS NULL', [active.version])
      const code = rows.filter(row => (row.kind ?? 'code') === 'code')
      const missing = new Set(missingChecks(code.map(row => ({ id: row.rule_id, kind: row.kind }))))
      const implemented = code.filter(row => !missing.has(row.rule_id))
      const policies = store.get('SELECT COUNT(*) AS n FROM policy WHERE status = ? AND deleted_at IS NULL', ['active'])
      return {
        ...card('rulePolicyRisk', '规则与政策', {
          numerator: implemented.length,
          denominator: code.length,
          unit: `条生效的 code 规则有判定（另有 ${Number(policies?.n ?? 0)} 条生效政策）`,
          threshold: null,
          updatedAt: null,
          detailLink: '#rules',
          source: 'rule ⋈ policy',
        }),
        ruleSetVersion: active?.version ?? null,
      }
    },
  },
  {
    id: 'optimizationDraft',
    label: '优化草案',
    source: 'optimization_run ⋈ optimization_draft',
    detailLink: '#optimize',
    /** Drafts a person has accepted, out of all drafts written. */
    build(store, scope) {
      const market = marketClause(scope, 'r.marketplace')
      const rows = store.all(
        `SELECT d.accepted, d.updated_at
           FROM optimization_draft d
           JOIN optimization_run r ON r.id = d.run_id
          WHERE 1 = 1${market.sql}`,
        market.params,
      )
      const accepted = rows.filter(row => row.accepted === 1)
      return card('optimizationDraft', '优化草案', {
        numerator: accepted.length,
        denominator: rows.length,
        unit: '条草案已采纳',
        threshold: null,
        updatedAt: newest(rows.map(row => row.updated_at)),
        detailLink: '#optimize',
        source: 'optimization_run ⋈ optimization_draft',
      })
    },
  },
]

/* ───────────────────────────── the assembler ───────────────────────────── */

/**
 * Build all six cards, isolating each one's failure.
 *
 * `deps` carries the pieces the cards may need beyond the store (the collection
 * service, the rule registry). It is passed through untouched so a card can use
 * what it needs and ignore the rest.
 *
 * The isolation is the point: a card whose table is broken must cost one card,
 * not the page. The assertion drives it by dropping a real table rather than by
 * injecting a fake builder — a test seam that only exists for the test would
 * prove the seam works, not the page.
 */
export function buildHealthCards(store, scope, deps = {}) {
  const cards = []
  /* P2-2：`window` 透传给每张卡的 `build`。只有真正做时间窗口统计的卡片（目前是
     `collection`）会用它，其余卡片忽略 —— 它们算的是当前状态，没有"上一期"。
     缺省 `undefined`，所以既有调用的行为一个字节都不变。 */
  const window = deps.window ?? null
  for (const spec of CARD_SPECS) {
    try {
      cards.push(spec.build(store, scope, { ...deps, window }))
    } catch (error) {
      cards.push({
        id: spec.id,
        label: spec.label,
        status: 'error',
        /* An error card still carries the three fields. A card with no
           `conclusion` would be drawn as a blank tile, which reads as "nothing to
           report" rather than "this one failed". */
        conclusion: ERROR_CONCLUSION,
        numerator: null,
        denominator: null,
        unit: null,
        threshold: null,
        updatedAt: null,
        detailLink: spec.detailLink ?? null,
        source: spec.source,
        error: error.message,
      })
    }
  }
  return cards
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function nonEmpty(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function safeArray(json) {
  if (json === null || json === undefined) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Whether any target in a stored target list names this marketplace. */
function targetsInclude(json, marketplace) {
  return safeArray(json).some(target => String(target?.marketplace ?? '').trim().toUpperCase() === marketplace)
}

/**
 * The home page's four buckets of things to do.
 *
 * The buckets are ordered by who can act on them:
 *
 *   - `blocking`     — nothing can proceed until this is fixed (a rule that is in
 *                      force and has no implementation: `validate` reports it as
 *                      `rule-check-missing` and refuses to pass a draft).
 *   - `needs_human`  — a decision only a person can make.
 *   - `should_handle`— work that should happen but is not stopping anything.
 *   - `optimization` — opportunities, not problems.
 *
 * ## Same-class items are one row, with a count
 *
 * Forty stale ASINs are one problem, not forty. A list of forty identical rows
 * buries the two items that are actually different, which is the failure mode of
 * every task list that grows by appending. Each source below therefore groups its
 * own items — the drafts query groups by run, the staleness scan folds every
 * ASIN into one row — and `aggregateCount` says how many objects the row stands
 * for. `sample` carries up to five concrete ids, because "12 个" is actionable
 * and "which 12" is the next question.
 *
 * For an aggregate, `objectId` is the **group key**, not an object id — there is
 * no single row it points at. That is stated here rather than left for a reader
 * to infer from a suspicious-looking id.
 *
 * ## The link carries the filter
 *
 * A todo that says "3 drafts need a decision" and then drops the reader on an
 * unfiltered page has moved the work rather than done it. `link` is
 * `#<module>#<anchor>` and `filters` is what to apply on arrival, so the panel
 * opens showing exactly the rows the todo counted.
 */

import { TODO_BUCKETS } from '../states.js'
import { SCOPE_ALL } from '../context/scope.js'
import { SEED_ROSTER } from '../rules/listing-rules.js'
import { missingChecks } from '../rules/registry.js'
import { freshnessOf } from '../data/freshness.js'
import { listDataRequests } from '../../store/agent-request.js'
import { awaitingBaselineChoice } from '../../store/observe.js'

/** How many concrete ids an aggregate carries for a follow-up question. */
export const SAMPLE_SIZE = 5

/** The empty-bucket text. A bucket that hides itself reads as "no such feature". */
export const EMPTY_BUCKET_TEXT = '暂无'

/* ───────────────────── T75：三列（负责人 / 已等 / 下一步） ───────────────────── */

/**
 * 「负责人」这一列在本仓**没有数据源**，而且是**字段不存在**、不是「这一行没填」。
 *
 * 实测：`grep -n assignee src/store/schema.js` 只有一处 —— `dq_issue.assignee`
 * （数据质量问题那张表，见 schema 的 DQ 段）。四类待办的来源（rule_set / shop /
 * optimization_draft / asin_snapshot）**没有任何一张表**有 owner / assignee /
 * assignee_id 这类列。
 *
 * 所以这一列：域层给固定的 `null`（不是空串、不是 '—'），页面印 `UNRECORDED_TEXT`。
 * **不许自己造一个字段填进去** —— 「负责人：product-owner」这种值如果是从别处抄来的，
 * 读的人会拿它当排班依据，而它只是抄的。
 */
export const TODO_OWNER_UNSOURCED = null

/** 打印「没有这个读数」的那把词。空列比假值诚实，所以页面照印这一列。 */
export const UNRECORDED_TEXT = '未记录'

/**
 * 「已等多久」：`since` 有值就印人话，没有就 `null`（页面印「未记录」）。
 *
 * 三个刻意的判断：
 *   · 时间戳解析不出来 / 是未来 → `null`，不是「已等 0 分钟」。一个未来时间换算成
 *     「已等 -3 小时」或者「刚刚」都是在编；
 *   · 不足 1 分钟 → 「不到 1 分钟」，不印「已等 0 分钟」——0 是个读数，这不是；
 *   · 单位只到「天」，不印「已等 6 天 3 小时」：这一列是给「谁等太久了」用的，
 *     多一位精度只会让人以为它是个准数。
 */
export function waitedText(since, now = new Date()) {
  const raw = String(since ?? '').trim()
  if (raw === '') return null
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return null
  const ms = now.getTime() - at
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `已等 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `已等 ${hours} 小时`
  return `已等 ${Math.floor(hours / 24)} 天`
}


function marketplaceOf(scope) {
  const value = String(scope?.marketplace ?? '').trim()
  if (value === '' || value.toLowerCase() === SCOPE_ALL) return null
  return value.toUpperCase()
}

/**
 * The four buckets, always all four, each with its items.
 *
 * Empty buckets are returned as empty arrays rather than omitted: the page draws
 * 「暂无」 in each one, and a bucket that disappeared would be indistinguishable
 * from a feature that does not exist.
 */
export function buildTodos(store, scope, { now = new Date() } = {}) {
  const market = marketplaceOf(scope)
  const items = [
    ...blockingItems(store),
    ...needsHumanItems(store, market),
    ...shouldHandleItems(store, market),
    ...optimizationItems(store, market),
  ]
  const buckets = {}
  for (const bucket of TODO_BUCKETS) buckets[bucket] = []
  for (const item of items) buckets[item.bucket].push(stampColumns(item, now))
  return buckets
}

/**
 * 补齐**画出来的那两列**（已等多久 / 下一步）—— **一处盖章**，四个来源谁都不用自己拼。
 *
 * 为什么在出口处补而不是在每个来源里写：四个来源各自拼一次，就是四份「没有数据源时
 * 印什么」的判定，而这类判定的分歧不会有人发现（每一处单独看都对）。
 *
 * 「负责人」不在其中：本仓阶段 1 没有用户表，四类待办的来源表没有 owner/assignee
 * 字段（全库只有 `dq_issue.assignee` 一处，与待办无关）。**这一列不画**，页面在表下
 * 用一句话说清 —— 「永远空着的列」是噪音，而「这一行没有负责人」这个事实仍然留在
 * `owner: null` 上，只是不占一格。
 *
 * `nextStep` 的来源就是 `suggestedAction`：同一句话，不另造一份措辞。
 */
function stampColumns(item, now) {
  const since = item.since ?? null
  const waited = waitedText(since, now)
  return {
    ...item,
    /* 事实，不是界面：这一行没有负责人（这个系统还没有这个概念）。页面不画它。 */
    owner: TODO_OWNER_UNSOURCED,
    since,
    waited,
    waitedLabel: waited ?? UNRECORDED_TEXT,
    /* 下一步有数据源：`suggestedAction` 就是那句动作，`link` 就是那个链接。 */
    nextStep: item.suggestedAction ?? null,
    nextStepLabel: item.suggestedAction ?? UNRECORDED_TEXT,
  }
}

/** The total across all four, for a caller that only wants the number. */
export function countTodos(todos) {
  return TODO_BUCKETS.reduce((sum, bucket) => sum + (todos[bucket]?.length ?? 0), 0)
}

/* ───────────────────────────── the four sources ───────────────────────────── */

/**
 * Rules that are in force and have no implementation.
 *
 * `validate` blocks on these (`rule-check-missing`), so they are blocking here
 * too — a dashboard that filed them under "should handle" would be lying about
 * what happens on the next run.
 */
function blockingItems(store) {
  const active = store.get('SELECT version FROM rule_set WHERE is_active = 1')
  const rows = active === undefined
    ? SEED_ROSTER.map(rule => ({ rule_id: rule.id, kind: rule.kind ?? 'code' }))
    : store.all('SELECT rule_id, kind FROM rule WHERE rule_set_version = ? AND deleted_at IS NULL', [active.version])
  const code = rows.filter(row => (row.kind ?? 'code') === 'code')
  const missing = missingChecks(code.map(row => ({ id: row.rule_id, kind: row.kind })))
  if (missing.length === 0) return []
  return [{
    bucket: 'blocking',
    objectType: 'rule_set',
    objectId: active?.version ?? 'code-seed',
    reason: `${missing.length} 条生效的 code 规则没有实现，校验会报 rule-check-missing 并阻断`,
    suggestedAction: '用 amzn_rule_list 看是哪几条：补上实现，或把它们改成 kind=doc / 停用',
    responsibleModule: 'rules',
    link: '#rules',
    aggregateCount: missing.length,
    filters: { ruleGap: 'implMissing' },
    sample: missing.slice(0, SAMPLE_SIZE),
  }]
}

/** Decisions only a person can make. */
function needsHumanItems(store, market) {
  const items = []

  /* Drafts written before v19 have no context and cannot be submitted
     (fail-closed). Only the ones still awaiting a decision: an accepted draft is
     history, not a task. */
  const orphanDrafts = store.all(
    `SELECT d.run_id, r.asin, r.marketplace, COUNT(*) AS n, MAX(d.updated_at) AS at
       FROM optimization_draft d
       JOIN optimization_run r ON r.id = d.run_id
      WHERE d.context_id IS NULL AND d.accepted IS NULL${market === null ? '' : ' AND r.marketplace = ?'}
      GROUP BY d.run_id, r.asin, r.marketplace`,
    market === null ? [] : [market],
  )
  for (const row of orphanDrafts) {
    items.push({
      bucket: 'needs_human',
      objectType: 'optimization_run',
      objectId: row.run_id,
      reason: `${row.n} 条草案没有记录上下文，不能提交（${row.asin} ${row.marketplace}）`,
      suggestedAction: '按当前上下文重新生成一版；旧的那版留着，别直接改',
      responsibleModule: 'optimize',
      link: '#optimize#inbox',
      aggregateCount: Number(row.n),
      filters: { runId: row.run_id, draftStatus: 'orphan' },
      sample: [row.asin],
      /* 这一组是「最后一次动过」的时间。同一轮里多条草案只取最晚的一条 ——
         最早的那条可能早就写完了，拿它当「等了多久」会把等的时间算长。 */
      since: row.at ?? null,
    })
  }

  /* A shop with no site cannot be used for anything: every collection target and
     every report is per-site. */
  for (const row of store.all('SELECT id, name, created_at FROM shop WHERE marketplace IS NULL ORDER BY id')) {
    items.push({
      bucket: 'needs_human',
      objectType: 'shop',
      objectId: row.id,
      reason: `店铺「${row.name}」没有指定站点`,
      suggestedAction: '在设置中心给它选一个站点，否则它不会出现在任何采集目标里',
      responsibleModule: 'settings',
      link: '#settings#shops',
      aggregateCount: 1,
      filters: { settingsSection: 'shops' },
      sample: [row.id],
      /* 店铺是哪天建的，就是这件事等了多久。站点一直是空的话，它已经等了这么久。 */
      since: row.created_at ?? null,
    })
  }

  return items
}

/** Work that should happen but is not stopping anything. */
function shouldHandleItems(store, market) {
  const asins = store.all(
    `SELECT asin, marketplace FROM asin WHERE 1 = 1${market === null ? '' : ' AND marketplace = ?'}`,
    market === null ? [] : [market],
  )
  const stale = []
  for (const row of asins) {
    const snapshot = store.get(
      'SELECT MAX(collected_at) AS at FROM asin_snapshot WHERE asin = ? AND marketplace = ?',
      [row.asin, row.marketplace],
    )
    /* One classification function, shared with the freshness card: "stale" must
       mean the same thing in both places or the dashboard contradicts itself. */
    if (freshnessOf(snapshot?.at ?? null, 'price') !== 'fresh') stale.push(`${row.asin}@${row.marketplace}`)
  }
  if (stale.length === 0) return []
  return [{
    bucket: 'should_handle',
    objectType: 'asin',
    objectId: 'stale-7d',
    reason: `${stale.length} 个 ASIN 超过 7 天没有新快照`,
    suggestedAction: '跑一次采集；如果这些 ASIN 已经不上架了，先把它们从库里清出去',
    responsibleModule: 'collect',
    link: '#collect',
    aggregateCount: stale.length,
    filters: { freshness: 'stale' },
    sample: stale.slice(0, SAMPLE_SIZE),
  }]
}

/** Opportunities, not problems: drafts that can be accepted. */
function optimizationItems(store, market) {
  const rows = store.all(
    `SELECT d.run_id, r.asin, r.marketplace, COUNT(*) AS n, MAX(d.updated_at) AS at
       FROM optimization_draft d
       JOIN optimization_run r ON r.id = d.run_id
      WHERE d.accepted IS NULL AND d.context_id IS NOT NULL${market === null ? '' : ' AND r.marketplace = ?'}
      GROUP BY d.run_id, r.asin, r.marketplace
      ORDER BY at DESC`,
    market === null ? [] : [market],
  )
  return rows.map(row => ({
    bucket: 'optimization',
    objectType: 'optimization_run',
    objectId: row.run_id,
    reason: `${row.n} 条草案等着决定（${row.asin} ${row.marketplace}）`,
    suggestedAction: '逐条看：采纳的进报告，不要的丢掉；采纳前确认上下文没变',
    responsibleModule: 'optimize',
    /* `#inbox` is the drafts inbox inside the optimize panel — the anchor the
       page scrolls to, and the filter below is what narrows it to these rows. */
    link: '#optimize#inbox',
    aggregateCount: Number(row.n),
    filters: { runId: row.run_id, draftStatus: 'pending' },
    sample: [row.asin],
    /* 同上：这一轮草案最后一次被改动的时间。 */
    since: row.at ?? null,
  }))
}

/* ───────────────────────── T75：首页摘要（一句话） ───────────────────────── */

/** 摘要里最多列几件事（与原型一致：三件 + 其余）。 */
export const DIGEST_MAX_ITEMS = 3

/** 零待办时**必须**说出来的那句话。整块隐藏读起来像「没有这个功能」。 */
export const DIGEST_EMPTY_TEXT = '今天没有需要你处理的事'

/**
 * The one-line digest at the top of the home page.
 *
 * ## 数字只来自两处
 *
 * `total` 是 `buildTodos()` 那四档的条数之和，`cardsNote` 是健康卡自己的 status
 * 计数。**这里不另算一套**：页面不数、摘要不数，三处数字只有一个来源，否则
 * 「今天有 3 件事」会和下面待办区那四档的条数对不上，而对不上的时候没人知道信哪个。
 *
 * ## 空的时候不许编一条
 *
 * 零待办 → `empty: true` 且 `shown: []`，页面印 `DIGEST_EMPTY_TEXT`。**不隐藏整块**
 * （隐藏 = 读起来像「这个功能没有」），也**不**为了显得有用去凑一条假的。
 *
 * ## 为什么最多 3 条
 *
 * 摘要要能在第一屏一眼读完；第 4 条以后去下面的待办区看（`more` 说还有几件）。
 * 原型也是三件。
 */
export function buildDigest({ todos = null, cards = [] } = {}, { now = new Date() } = {}) {
  const buckets = todos ?? {}
  const flat = []
  for (const bucket of TODO_BUCKETS) {
    for (const item of buckets[bucket] ?? []) flat.push({ ...item, bucket })
  }
  const shown = flat.slice(0, DIGEST_MAX_ITEMS).map(item => ({
    bucket: item.bucket,
    text: String(item.reason ?? ''),
    /* 摘要行与待办行走同一条导航：`link` + `filters` 原样带过去，不另拼一个链接。 */
    link: item.link,
    filters: item.filters ?? {},
    owner: item.owner ?? null,
    waited: item.waited ?? null,
    nextStep: item.nextStep ?? null,
  }))

  /* 卡片的四态各自数一次，不合并成一句「其余都正常」——「计算失败」和「暂无数据」
     都不是「正常」，把它们并进去是把两件要做的不同的事说成了一件。 */
  const countBy = status => cards.filter(card => card?.status === status).length
  const cardParts = []
  const ok = countBy('ok')
  if (ok > 0) cardParts.push(`其余 ${ok} 张健康卡正常`)
  const attention = countBy('attention')
  if (attention > 0) cardParts.push(`${attention} 张要注意`)
  const emptyCards = countBy('empty')
  if (emptyCards > 0) cardParts.push(`${emptyCards} 张暂无数据`)
  const broken = countBy('error')
  if (broken > 0) cardParts.push(`${broken} 张计算失败`)

  return {
    total: flat.length,
    shown,
    more: Math.max(0, flat.length - shown.length),
    empty: flat.length === 0,
    emptyText: DIGEST_EMPTY_TEXT,
    /* 一张卡都没有时说「还没读到卡片」，而不是空串：空串读起来像这块没渲染。 */
    cardsNote: cardParts.length === 0 ? '健康卡还没有读数' : cardParts.join(' · '),
    /* `now` 不往下传：`waited` 是待办行算好带过来的，摘要不重算第二遍时间。 */
    now: now.toISOString(),
  }
}

/* ─────────────────────── T75：待决策（四类合并收件箱） ─────────────────────── */

/**
 * 四类「等你决定」的事，合并成一张表。
 *
 * ## 这是汇总入口，不是第五套功能
 *
 * 四类各自的处置页面都已经存在（门禁在 `#agent` 的裁决按钮、草案在 `#optimize#inbox`、
 * 发布偏离在 `#optimize` 的发布区、补数在 `#agent` 的请求块）。这里**只汇总**：
 * 每一行带着去那一页的链接与筛选参数，点下去就是真正处理它的那个界面。
 *
 * ⚠️ **补数这一行只能「去看」，不能在页面上结清**：本仓的
 * `amzn_agent_data_request_resolve` 是工具，页面侧没有对应路由（实测 `routes.js` 里
 * `data-request` 只出现在 import 与读路径上）。链接仍然指向 `#agent`（那一页会把
 * 请求原文印出来），但「结清」这一步今天只能在工具里做。这条写在这里，不是留给人猜。
 *
 * ## 四类都空时
 *
 * `rows: []` + `emptyText`。页面**照画这一块**并印 `DECISIONS_EMPTY_TEXT` —— 隐藏
 * 一块空表读起来像「这个功能没有」。
 */
export const DECISION_CATEGORIES = [
  ['gate', '门禁'],
  ['data_request', '补数'],
  ['draft', '草案'],
  ['deviation', '发布偏离'],
]

export const DECISIONS_EMPTY_TEXT = '没有等你决定的事'

/** 一次最多汇多少行：这一块是入口，不是清单本身。 */
export const DECISIONS_LIMIT = 20

export function buildDecisions(store, scope, { now = new Date(), limit = DECISIONS_LIMIT } = {}) {
  const market = marketplaceOf(scope)
  const rows = []

  /* ① 门禁：运行停在 waiting_human，就是在等人批。`waiting_reason` 是 §11 要求的
     「在等什么」，所以这一行印它而不是印一个泛泛的「等待裁决」。 */
  for (const run of store.all(
    "SELECT id, role, goal, waiting_reason, started_at FROM agent_run WHERE status = 'waiting_human'"
    + ' ORDER BY started_at DESC LIMIT ?',
    [limit],
  )) {
    rows.push({
      decisionKind: 'gate',
      decisionLabel: '门禁',
      objectType: 'agent_run',
      objectId: run.id,
      text: run.waiting_reason ?? run.goal ?? `${run.role} 停在待人工`,
      since: run.started_at ?? null,
      link: '#agent',
      filters: { runId: run.id },
      /* 页面没有结清入口时的说明；有就为 null（见本函数头注）。 */
      resolveHint: null,
    })
  }

  /* ② 补数：只有 `open` 是「还在等你」。fulfilled / declined 都已经是结论。 */
  for (const request of listDataRequests(store).rows) {
    if (String(request.status ?? '') !== 'open') continue
    rows.push({
      decisionKind: 'data_request',
      decisionLabel: '补数',
      objectType: 'agent_data_request',
      objectId: request.id,
      text: request.what,
      since: request.openedAt ?? null,
      link: '#agent',
      filters: { runId: request.runId },
      /* 页面只能看、不能结清（工具才有 resolve）。写明，别让读者找按钮。 */
      resolveHint: '只能在工具里结清（amzn_agent_data_request_resolve）',
    })
  }

  /* ③ 草案：与待办区「可优化」同一批（同一条 SQL 口径），但这里是**等决策**的入口，
     不是机会清单 —— 所以只保留「还没决定」的。 */
  for (const row of store.all(
    `SELECT d.run_id, r.asin, r.marketplace, COUNT(*) AS n, MAX(d.updated_at) AS at
       FROM optimization_draft d
       JOIN optimization_run r ON r.id = d.run_id
      WHERE d.accepted IS NULL AND d.context_id IS NOT NULL${market === null ? '' : ' AND r.marketplace = ?'}
      GROUP BY d.run_id, r.asin, r.marketplace
      ORDER BY at DESC
      LIMIT ?`,
    market === null ? [limit] : [market, limit],
  )) {
    rows.push({
      decisionKind: 'draft',
      decisionLabel: '草案',
      objectType: 'optimization_run',
      objectId: row.run_id,
      text: `${row.n} 条草案等决定（${row.asin} ${row.marketplace}）`,
      since: row.at ?? null,
      link: '#optimize#inbox',
      filters: { runId: row.run_id, draftStatus: 'pending' },
      resolveHint: null,
    })
  }

  /* ④ 发布偏离：`awaitingBaselineChoice` 是 §6 那一条「未选择前观测卡片为
     waiting_human」的**唯一**读取口，这里直接用它，不写第二条 SQL。 */
  for (const record of awaitingBaselineChoice(store, { marketplace: market })) {
    rows.push({
      decisionKind: 'deviation',
      decisionLabel: '发布偏离',
      objectType: 'publication_record',
      objectId: record.id,
      text: `${record.asin} ${record.marketplace} 的实际发布偏离了批准草案，等你定基线`,
      since: record.publishedAt ?? null,
      link: '#optimize',
      filters: { publicationId: record.id },
      resolveHint: null,
    })
  }

  /* `byKind` 的键是**决策类别**，与「空切片 kind」无关：这一轮的字段名是
     `decisionKind` 而不是 `kind`，因为 `tests/empty-kind-map.mjs` 会把「一个对象里
     既有 kind 字符串、又有 text」这种形状当成 domain 的空切片，并要求每个 kind 在
     `domain/ui/empty-kind.js` 里有四态映射。决策行不是空切片，给它一个 borrowed
     的 kind 名字只会让那个测试在别人的文件里红（实测红过两次：先是 gate/draft，
     再是这段注释里的示范字面量本身）。 */
  const byKind = {}
  for (const [kind] of DECISION_CATEGORIES) byKind[kind] = 0
  for (const row of rows) byKind[row.decisionKind] += 1

  return {
    /* `waitedLabel` 与待办行同一条规矩：值 + 显示串，页面只印。 */
    rows: rows.map(row => {
      const waited = waitedText(row.since, now)
      return { ...row, waited, waitedLabel: waited ?? UNRECORDED_TEXT }
    }),
    total: rows.length,
    byKind,
    categories: DECISION_CATEGORIES.map(([id, label]) => ({ id, label })),
    emptyText: DECISIONS_EMPTY_TEXT,
    unrecordedText: UNRECORDED_TEXT,
  }
}

/* ─────────────────────────────── aggregation ─────────────────────────────── */

/* The grouping is done by each source's own query rather than by a generic pass
   over the items: the drafts group by run, the staleness scan folds every ASIN
   into one row, and a second generic aggregator on top would never merge anything
   the sources had not already merged. The per-source version also keeps the
   `sample` list meaningful — it is filled by the query that knows what the group
   is about. */

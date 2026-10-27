/**
 * ASIN 竞品关系 —— 一行一个竞品，父子共享，允许子级覆盖。
 *
 * ## 为什么不是「一个字段用逗号隔开」
 *
 * 那种写法在**展示**上省事，在**存储**上三件事全废：
 *   ① 反向查不了：谁是 B0XXX 的竞品，只能 `LIKE '%,B0XXX,%'` 全表扫；
 *   ② 带不了属性：这个竞品排第几、从哪来的、还活着吗，一个字段装不下；
 *   ③ 更新是读-改-写：两个人同时加竞品会互相覆盖。
 *
 * 所以存储用这张关系表，展示用视图 `v_asin_family_competitor`（GROUP_CONCAT 出逗号串）。
 *
 * ## 两个约定
 *
 * **单向**：我把他当竞品，不代表他把我当竞品。反查走 `competitorFamilies()`。
 * **不删**：竞品下架了记 `status='inactive'` + `last_seen_at`，删了就不知道它上次排第几。
 */

import { keywordKey } from '../domain/keywords/key.js'
import { nowIso } from './db.js'

/* suggested：自动发现出来、还没人采纳的候选。它**不算竞品**——amilyCompetitorsFor`n   只认 active，这样页面上的「我的竞品」不会被机器猜的东西污染。 */
export const COMPETITOR_STATUSES = ['suggested', 'active', 'inactive']
export const COMPETITOR_SCOPES = ['family', 'child']

function normalize(value) {
  return String(value ?? '').trim().toUpperCase()
}

/** 新增或更新一条竞品关系。同一个 (父, 竞品, scope, scope_asin) 是更新，不是第二条。 */
export function upsertCompetitor(store, {
  marketplace = 'US',
  parentAsin,
  competitorAsin,
  scope = 'family',
  scopeAsin = '',
  source = null,
  rankSeen = null,
  status = 'active',
  note = null,
} = {}) {
  const market = normalize(marketplace)
  const parent = normalize(parentAsin)
  const competitor = normalize(competitorAsin)
  if (parent === '' || competitor === '') throw new Error('parentAsin and competitorAsin are required')
  if (parent === competitor) throw new Error('an ASIN cannot be its own competitor')
  if (!COMPETITOR_SCOPES.includes(scope)) throw new Error(`scope must be one of ${COMPETITOR_SCOPES.join(' / ')}`)
  if (!COMPETITOR_STATUSES.includes(status)) throw new Error(`status must be one of ${COMPETITOR_STATUSES.join(' / ')}`)
  if (scope === 'child' && normalize(scopeAsin) === '') throw new Error('scope=child needs scopeAsin')

  const now = nowIso()
  store.run(
    `INSERT INTO asin_competitor
       (marketplace, parent_asin, competitor_asin, scope, scope_asin, source, rank_seen,
        status, last_seen_at, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(marketplace, parent_asin, competitor_asin, scope, scope_asin) DO UPDATE SET
       source = excluded.source,
       rank_seen = COALESCE(excluded.rank_seen, asin_competitor.rank_seen),
       status = excluded.status,
       last_seen_at = excluded.last_seen_at,
       note = COALESCE(excluded.note, asin_competitor.note),
       updated_at = excluded.updated_at`,
    [market, parent, competitor, scope, scope === 'child' ? normalize(scopeAsin) : '',
      source, Number.isFinite(Number(rankSeen)) ? Number(rankSeen) : null,
      status, now, note, now, now],
  )
  return { marketplace: market, parentAsin: parent, competitorAsin: competitor, scope }
}

/** 某个父 ASIN 的竞品列表（含已失效的，用 status 区分）。 */
export function listCompetitors(store, { marketplace = 'US', parentAsin, status = null } = {}) {
  const market = normalize(marketplace)
  const parent = normalize(parentAsin)
  if (parent === '') return []
  const params = [market, parent]
  let sql = `SELECT * FROM asin_competitor WHERE marketplace = ? AND parent_asin = ?`
  if (status !== null) { sql += ' AND status = ?'; params.push(status) }
  return store.all(`${sql} ORDER BY scope, competitor_asin`, params)
}

/** 反向：这个竞品 ASIN 出现在哪些父产品下。 */
export function competitorFamilies(store, { marketplace = 'US', competitorAsin, status = 'active' } = {}) {
  const market = normalize(marketplace)
  const competitor = normalize(competitorAsin)
  if (competitor === '') return []
  const params = [market, competitor]
  let sql = 'SELECT * FROM asin_competitor WHERE marketplace = ? AND competitor_asin = ?'
  if (status !== null) { sql += ' AND status = ?'; params.push(status) }
  return store.all(`${sql} ORDER BY parent_asin`, params)
}

/** 标为失效，不删 —— 「上次它排第几」是历史，删了就没了。 */
export function retireCompetitor(store, { marketplace = 'US', parentAsin, competitorAsin, scope = 'family', scopeAsin = '', reason = null } = {}) {
  const market = normalize(marketplace)
  const parent = normalize(parentAsin)
  const competitor = normalize(competitorAsin)
  const result = store.run(
    `UPDATE asin_competitor
        SET status = 'inactive', last_seen_at = ?, note = COALESCE(?, note), updated_at = ?
      WHERE marketplace = ? AND parent_asin = ? AND competitor_asin = ? AND scope = ? AND scope_asin = ?`,
    [nowIso(), reason, nowIso(), market, parent, competitor, scope, scope === 'child' ? normalize(scopeAsin) : ''],
  )
  return result.changes > 0
}

/**
 * 给一个 ASIN（可能是子）算出它的竞品集合。
 *
 * 链路：child → asin_variant_relation（找父）→ asin_competitor。
 * **子级覆盖父级**：同一个竞品如果子级也声明了，只出现一次。
 * 这个 ASIN 自己就是父（没挂在任何父下）时，直接按父查。
 */
export function familyCompetitorsFor(store, { marketplace = 'US', asin } = {}) {
  const market = normalize(marketplace)
  const code = normalize(asin)
  if (code === '') return { asin: code, parents: [], competitors: [], resolvedFrom: 'none' }

  /* 是不是别人的子；一个子挂两个父是**要暴露的矛盾**，所以把全部父都取出来。 */
  let parents = []
  try {
    parents = store.all(
      'SELECT parent_asin FROM asin_variant_relation WHERE marketplace = ? AND child_asin = ?',
      [market, code],
    ).map(row => row.parent_asin)
  } catch {
    /* 老库没有这张表：把这个 ASIN 自己当父。 */
    parents = []
  }

  const owners = parents.length > 0 ? parents : [code]
  const out = []
  const seen = new Set()
  for (const parent of owners) {
    const family = store.all(
      `SELECT competitor_asin, scope, scope_asin, source, rank_seen, status
         FROM asin_competitor
        WHERE marketplace = ? AND parent_asin = ? AND status = 'active'
        ORDER BY CASE scope WHEN 'child' THEN 0 ELSE 1 END, competitor_asin`,
      [market, parent],
    )
    for (const row of family) {
      /* child 级只对声明它的那个子生效；family 级对所有子生效。 */
      if (row.scope === 'child' && normalize(row.scope_asin) !== code) continue
      if (seen.has(row.competitor_asin)) continue
      seen.add(row.competitor_asin)
      out.push({ ...row, parentAsin: parent })
    }
  }
  out.sort((a, b) => (a.rank_seen ?? 1e9) - (b.rank_seen ?? 1e9))

  return {
    asin: code,
    parents: owners,
    competitors: out.map(row => row.competitor_asin),
    details: out,
    resolvedFrom: parents.length > 0 ? 'variant-parent' : 'self',
  }
}

/**
 * 「一行逗号串」—— 页面显示用。
 *
 * **不用数据库视图**：迁移里建视图会把 `tests/kw-key.mjs` 的 v14 回滚工具搞坏
 * （那个工具靠解析迁移 SQL 里的 CREATE TABLE / ALTER TABLE 来撤销，多一种对象就多一种没被解析到的残留），
 * 全量套件会直接崩在迁移 37 上。GROUP_CONCAT 在查询里做，一样是一次查询、一个字符串。
 */
export function familyCompetitorRow(store, { marketplace = 'US', parentAsin } = {}) {
  const row = store.get(
    `SELECT marketplace, parent_asin,
            GROUP_CONCAT(competitor_asin, ',') AS competitors,
            COUNT(*) AS competitor_count
       FROM asin_competitor
      WHERE marketplace = ? AND parent_asin = ? AND status = 'active'
      GROUP BY marketplace, parent_asin`,
    [normalize(marketplace), normalize(parentAsin)],
  )
  return row ?? null
}

/* ──────────────────── 自动发现竞品 ──────────────────── */

/**
 * 从**库里已有的事实**发现竞品候选 —— 不发请求、不开浏览器。
 *
 * 两个入口，一条规则：
 *   手动（`add`）     人说「这是竞品」，直接 active。
 *   自动（`discover`） 机器从 `kw_competitor_fact`（卖家精灵/西柚反查）里，
 *                      把这个 ASIN 正在打的词的前 N 名捞出来，**写成 suggested**。
 *                      suggested 不算竞品（`familyCompetitorsFor` 只认 active），
 *                      要人 `adopt` 之后才算 —— 机器猜的东西不该直接进「我的竞品」。
 *
 * 为什么按词聚合而不是按单个词取前 10：
 * 一个 ASIN 通常打十几个词，每个词的 Top10 有重叠。按「出现在几个词里 + 最好名次」
 * 排序，重复出现的才是真竞品；只在冷门长尾词里露一次脸的，排在后面。
 */
export function discoverCompetitors(store, {
  marketplace = 'US', ourAsin, keywords = null, limit = 10, minRank = 1, maxRank = 50,
} = {}) {
  const market = normalize(marketplace)
  const mine = normalize(ourAsin)
  if (mine === '') throw new Error('ourAsin is required')

  /* 没给词就用这个 ASIN 正在打的词（asin_keyword 里有名次的那批）。 */
  let words = Array.isArray(keywords) && keywords.length > 0
    ? keywords.map(word => String(word).trim().toLowerCase())
    : store.all(
      'SELECT DISTINCT keyword FROM asin_keyword WHERE asin = ? AND marketplace = ? ORDER BY keyword',
      [mine, market],
    ).map(row => row.keyword)

  if (words.length === 0) return { ok: true, candidates: [], consideredKeywords: [], note: 'no-keywords' }

  const placeholders = words.map(() => '?').join(',')
  const rows = store.all(
    `SELECT keyword, asin, organic_rank, organic_no_rank, traffic_share
       FROM kw_competitor_fact
      WHERE marketplace = ? AND keyword IN (${placeholders})`,
    [market, ...words],
  )

  /* 按 ASIN 聚合：出现次数、最好名次、涉及哪些词。 */
  const byAsin = new Map()
  for (const row of rows) {
    const code = normalize(row.asin)
    if (code === '' || code === mine) continue                    // 自己不是自己的竞品
    if (Number(row.organic_no_rank) === 1) continue               // 明确没进榜的不算候选
    const rank = Number(row.organic_rank)
    if (!Number.isFinite(rank) || rank < minRank || rank > maxRank) continue
    let entry = byAsin.get(code)
    if (entry === undefined) {
      entry = { competitorAsin: code, keywords: [], bestRank: rank, bestKeyword: row.keyword, appearances: 0 }
      byAsin.set(code, entry)
    }
    entry.appearances += 1
    entry.keywords.push(row.keyword)
    if (rank < entry.bestRank) { entry.bestRank = rank; entry.bestKeyword = row.keyword }
  }

  const candidates = [...byAsin.values()]
    .sort((a, b) => (b.appearances - a.appearances) || (a.bestRank - b.bestRank))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))

  return {
    ok: true,
    ourAsin: mine,
    marketplace: market,
    consideredKeywords: words,
    candidates: candidates.map(entry => ({
      ...entry,
      evidence: `${entry.appearances} 个词里出现，最好第 ${entry.bestRank} 名（${entry.bestKeyword}）`,
    })),
    note: candidates.length === 0 ? 'no-candidates' : null,
  }
}

/**
 * 按关键词反查库内已有的竞品事实 —— **只读**。
 *
 * 这是竞品页「按关键词反查竞品」入口的读半边：同一个词在 `kw_competitor_fact`
 * 里已经有哪些 ASIN、各自第几名、哪一天观测的。没有导入过反查表的词会出现在
 * `noFactKeywords` 里，让页面可以说「本仓没有可反查的竞品事实」而不是画一个 0。
 *
 * **不采集、不搜索、不写库。** `kw_competitor_fact` 由卖家精灵 / 西柚导出经导入器
 * 写入；这个函数只 SELECT。要发起一次真实搜索，得走 `amzn_keyword_scan`，那是另一
 * 个动作（见页面上的 prompt 入口，需另行确认采集配额）。
 *
 * 同一个 (keyword, asin) 可能有多个来源行（source_id 不同）：这里按最好名次聚合，
 * 并把来源与最近观测时间一起带出来。`organic_rank` 为 NULL 且 `organic_no_rank=1`
 * 是「进过结果页但没进榜」，`organic_rank` 为 NULL 且没有 no_rank 是「这一行没给名次」
 * —— 两者都显示 `null`，页面用 `noRank` 区分，绝不写成 0。
 */
export function reverseCompetitorFacts(store, {
  marketplace = 'US', keywords = [], ourAsin = null, limit = 400,
} = {}) {
  const market = normalize(marketplace)
  const words = [...new Set((Array.isArray(keywords) ? keywords : [])
    .map(word => keywordKey(word))
    .filter(word => word !== ''))].slice(0, 20)
  const cap = Math.max(1, Math.min(2000, Number(limit) || 400))
  if (words.length === 0) {
    return { marketplace: market, keywords: [], rows: [], shownRows: 0, keywordStats: [], noFactKeywords: [], totalRows: 0 }
  }

  const marks = words.map(() => '?').join(',')
  const raw = store.all(
    `SELECT keyword, asin,
            MIN(CASE WHEN organic_rank IS NOT NULL THEN organic_rank END) AS organic_rank,
            MAX(organic_no_rank) AS organic_no_rank,
            MAX(monthly_volume) AS monthly_volume,
            MAX(weekly_searches) AS weekly_searches,
            MAX(collected_at) AS collected_at,
            GROUP_CONCAT(DISTINCT source_id) AS sources
       FROM kw_competitor_fact
      WHERE marketplace = ? AND keyword IN (${marks})
      GROUP BY keyword, asin
      ORDER BY keyword ASC,
               CASE WHEN MIN(organic_rank) IS NULL THEN 1 ELSE 0 END,
               MIN(organic_rank) ASC,
               asin ASC
      LIMIT ?`,
    [market, ...words, cap],
  )

  /* 当前我们的竞品关系（若页面选了我们的 ASIN）：只用于把「已在关系里」和
     「只是候选」标出来，不参与筛选。父 ASIN 为空时不读，避免把所有父的竞品混进来。 */
  const relation = new Map()
  const ours = normalize(ourAsin)
  if (ours !== '') {
    for (const row of store.all(
      'SELECT competitor_asin, status FROM asin_competitor WHERE marketplace = ? AND parent_asin = ?',
      [market, ours],
    )) relation.set(row.competitor_asin, row.status)
  }

  const rows = raw.map(row => {
    const rank = row.organic_rank === null || row.organic_rank === undefined ? null : Number(row.organic_rank)
    return {
      keyword: row.keyword,
      asin: row.asin,
      rank,
      noRank: rank === null && Number(row.organic_no_rank) === 1,
      monthlyVolume: row.monthly_volume ?? null,
      weeklySearches: row.weekly_searches ?? null,
      collectedAt: row.collected_at ?? null,
      sources: String(row.sources ?? '').split(',').filter(Boolean).sort(),
      relation: relation.get(row.asin) ?? null,
    }
  })

  /* 每个词的事实数单独算：`rows` 有 LIMIT，若一个词有 400+ 个 ASIN，它的行可能
     全部落在截断之外 —— 用 `rows` 反推事实数，会把「有事实、只是没显示」说成
     「本仓没有可反查的竞品事实」。那正是四态里最不能混的一格。 */
  const counts = new Map(words.map(word => [word, { factRows: 0, rankedRows: 0 }]))
  for (const row of store.all(
    `SELECT keyword,
            COUNT(DISTINCT asin) AS fact_rows,
            COUNT(DISTINCT CASE WHEN organic_rank IS NOT NULL THEN asin END) AS ranked_rows
       FROM kw_competitor_fact
      WHERE marketplace = ? AND keyword IN (${marks})
      GROUP BY keyword`,
    [market, ...words],
  )) {
    counts.set(row.keyword, { factRows: Number(row.fact_rows ?? 0), rankedRows: Number(row.ranked_rows ?? 0) })
  }
  const byKeyword = new Map(words.map(word => [word, {
    keyword: word, factRows: counts.get(word).factRows, rankedRows: counts.get(word).rankedRows, asins: [],
  }]))
  for (const row of rows) {
    const entry = byKeyword.get(row.keyword)
    if (entry !== undefined) entry.asins.push(row.asin)
  }
  const keywordStats = [...byKeyword.values()]
  return {
    marketplace: market,
    keywords: words,
    rows,
    shownRows: rows.length,
    keywordStats,
    noFactKeywords: keywordStats.filter(entry => entry.factRows === 0).map(entry => entry.keyword),
    totalRows: keywordStats.reduce((sum, entry) => sum + entry.factRows, 0),
  }
}

/** 把一条 suggested 采纳成 active。人做的决定，才有资格进「我的竞品」。
 *  D-4 ③ 审计补的一行：只认 status='suggested' —— 原 UPDATE 无状态过滤，对人工
 *  已退役（inactive）/已采纳（active）的关系也会「采纳」（把退役行静默复活），与
 *  本文档句、工具面的 'no such suggested relation' 自相矛盾。 */
export function adoptCompetitor(store, { marketplace = 'US', parentAsin, competitorAsin, scope = 'family', scopeAsin = '' } = {}) {
  const result = store.run(
    `UPDATE asin_competitor SET status = 'active', updated_at = ?
      WHERE marketplace = ? AND parent_asin = ? AND competitor_asin = ? AND scope = ? AND scope_asin = ?
        AND status = 'suggested'`,
    [nowIso(), normalize(marketplace), normalize(parentAsin), normalize(competitorAsin),
      scope, scope === 'child' ? normalize(scopeAsin) : ''],
  )
  return result.changes > 0
}

/**
 * 整个站点（或某个父 ASIN）的竞品关系清单 —— 页面上的那张总表。
 *
 * `listCompetitors` 要一个父 ASIN，回答不了「我这几个产品一共挂了哪些竞品」。
 * 这里按站点列，带状态，**不过滤** suggested/inactive：三种状态都要能看见，
 * 否则「候选没采纳」和「已停用」都会变成"不存在"。
 */
export function listAllCompetitors(store, { marketplace = 'US', parentAsin = null, limit = 300 } = {}) {
  const params = [normalize(marketplace)]
  let sql = `SELECT * FROM asin_competitor WHERE marketplace = ?`
  if (parentAsin !== null && String(parentAsin).trim() !== '') {
    sql += ' AND parent_asin = ?'
    params.push(normalize(parentAsin))
  }
  sql += ' ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'suggested\' THEN 1 ELSE 2 END, parent_asin, competitor_asin LIMIT ?'
  params.push(Math.max(1, Math.min(1000, Number(limit) || 300)))
  return store.all(sql, params)
}
/**
 * "Us vs them" — turning two sets of readings into two lists worth acting on.
 *
 * Everything here is a pure function over plain objects. The store reads the
 * rows (`readCompetitorSides`); this module decides what they mean. The split is
 * not ceremony: the interesting cases are all classification, and classification
 * tested through a database is a test that spends most of its time on SQLite and
 * the rest on guessing which fixture produced the odd row.
 *
 * ## The distinction this module exists to protect
 *
 * "The competitor has this word and we do not" is two different claims:
 *
 *   - we measured the word and we are absent  → a finding, act on it;
 *   - we never measured the word              → not a finding at all.
 *
 * Reporting the second as the first invents a problem. The library's whole
 * discipline is "do not report what was not measured" (see `keywordCoverage`),
 * and a diff is exactly where that discipline is easiest to lose — the list
 * looks the same either way. So every row carries `our_status`, and `counts`
 * keeps `absent` and `untested` apart.
 *
 * A null rank with no `scan_depth` is *untested*, not absent. Without a depth
 * there is no way to say how far the scan looked, so "not found" is not a
 * claim the data supports.
 */

/**
 * The orders a diff list can be shown in.
 *
 * Sorting happens **here, before the cap**, and that is the whole reason this is
 * not left to the page. The two lists are capped, so a client-side sort would
 * only ever reorder the rows that survived a different sort — "by competitor
 * rank" would mean "by competitor rank, among the top 200 by volume", which is
 * not what the control says and is not something the reader could notice.
 *
 * `volume` is the default because search volume is the only quantity in the
 * pipeline that is a measurement rather than a judgement, and a null volume
 * sorts last in every order rather than counting as zero.
 */
export const DIFF_ORDERS = {
  volume: '搜索量',
  best_rank: '竞品最好排名',
  ranked_count: '竞品有排名数',
  our_rank: '我们排名',
  keyword: '关键词',
}

const COMPARATORS = {
  volume: (a, b) => (b.search_volume ?? -1) - (a.search_volume ?? -1),
  best_rank: (a, b) => (a.competitor_best_rank ?? Infinity) - (b.competitor_best_rank ?? Infinity),
  ranked_count: (a, b) => b.competitor_ranked_count - a.competitor_ranked_count,
  our_rank: (a, b) => (a.our_rank ?? Infinity) - (b.our_rank ?? Infinity),
  keyword: () => 0,
}

/**
 * `null`/`undefined` last, then the requested order, then the spelling.
 *
 * The spelling tiebreak is not decoration: without it two rows with the same
 * volume come back in whatever order the Map iterated, so the same data renders
 * in a different order between two page loads and the panel looks unstable.
 */
function sortRows(rows, order) {
  const primary = COMPARATORS[order] ?? COMPARATORS.volume
  return rows.sort((a, b) => primary(a, b)
    || (a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0))
}

/**
 * Build the two lists.
 *
 * @param {object} sides — the shape `readCompetitorSides` returns.
 * @param {{limit?: number, theirsOrder?: string, oursOrder?: string}} [options]
 * @returns {{
 *   asin: string, marketplace: string, competitors: string[], excludedSelf: boolean,
 *   theirsOnly: object[], oursOnly: object[],
 *   counts: {theirsOnly: number, oursOnly: number, ranked: number, absent: number, untested: number},
 *   coverage: {competitorKeywords: number, ourKeywords: number, competitorAsins: number},
 * }}
 */
export function buildCompetitorDiff(sides, { limit = 500, theirsOrder = 'volume', oursOrder = 'volume' } = {}) {
  const { asin, marketplace, peers = [], excludedSelf = false } = sides
  const ours = sides.ours ?? new Map()
  const theirs = sides.theirs ?? new Map()
  const volumes = sides.volumes ?? new Map()
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 500), 1), 5000)

  const theirsOnly = []
  const oursOnly = []
  let ranked = 0
  let absent = 0
  let untested = 0

  for (const [keyword, their] of theirs) {
    const mine = ours.get(keyword)
    const ourRank = mine?.rank ?? null
    const ourStatus = classifyOurSide(mine)
    if (ourStatus === 'ranked') { ranked += 1; continue }
    if (ourStatus === 'absent') absent += 1
    else untested += 1

    const volume = pickVolume(volumes.get(keyword), mine?.searchVolume, their.monthlyVolume, their.weeklySearches)
    theirsOnly.push({
      keyword,
      search_volume: volume.value,
      competitor_best_rank: their.bestRank ?? null,
      /* `?? 0` 会把「没有竞品度量」写成「竞品排了 0 个」——于是象限判成 ownAdvantage
         （我们上榜、他们没上）。没测过不等于没上榜，所以这里**保留 null**。 */
      competitor_ranked_count: their.rankedCount === null || their.rankedCount === undefined ? null : Number(their.rankedCount),
      competitor_total: peers.length,
      // Present-but-unranked is not the same as ranked, and it is the number
      // that explains a "1/3" the user cannot otherwise account for.
      competitor_present_count: their.presentCount === null || their.presentCount === undefined ? null : Number(their.presentCount),
      competitor_asins: their.asins ?? [],
      our_rank: ourRank,
      our_status: ourStatus,
      origin: volume.origin,
      // We hold no competitor-side measurement for this word — by construction,
      // since the word only reached this list because a competitor has a row for
      // it. The flag exists so the page can render "该词无竞品数据" from the row
      // alone, rather than inferring it from `competitor_best_rank === null` and
      // getting the inference wrong for a competitor that is present but unranked.
      no_data: false,
    })
  }

  for (const [keyword, mine] of ours) {
    if (!hasRank(mine.rank)) continue
    if (theirs.has(keyword)) continue
    const volume = pickVolume(volumes.get(keyword), mine.searchVolume, null, null)
    oursOnly.push({
      keyword,
      search_volume: volume.value,
      // null, never 0 — no competitor holds this word, and a best rank of 0
      // would read as "ranked first".
      competitor_best_rank: null,
      competitor_ranked_count: 0,
      competitor_total: peers.length,
      competitor_present_count: 0,
      competitor_asins: [],
      our_rank: mine.rank,
      our_status: 'ranked',
      origin: volume.origin,
      // True by construction: no competitor holds this word, so there is nothing
      // on their side to report. `competitor_best_rank` is already null above —
      // this flag is what stops a view from rendering that null as a 0.
      no_data: true,
    })
  }

  return {
    asin,
    marketplace,
    competitors: peers,
    excludedSelf,
    theirsOnly: sortRows(theirsOnly, theirsOrder).slice(0, cap),
    oursOnly: sortRows(oursOnly, oursOrder).slice(0, cap),
    theirsOrder,
    oursOrder,
    // The pre-cap totals, so a truncated list can say so instead of looking
    // complete. `counts` and `theirsOnly.length` are different numbers whenever
    // the cap bites, and both are needed.
    truncated: {
      theirsOnly: theirsOnly.length > cap,
      oursOnly: oursOnly.length > cap,
    },
    counts: {
      theirsOnly: theirsOnly.length,
      oursOnly: oursOnly.length,
      ranked,
      absent,
      untested,
    },
    coverage: {
      competitorKeywords: theirs.size,
      ourKeywords: ours.size,
      competitorAsins: peers.length,
    },
  }
}

/**
 * Whether a rank value is a real measurement.
 *
 * `null`/`undefined` are the obvious "no rank". The empty string is the one that
 * bites: it arrives from a hand-built row or a CSV cell, and `'' !== null` is
 * true, so a naive `!== null` check promotes "no value at all" to "ranked" —
 * inventing a rank nobody measured. Same discipline as everywhere else in this
 * module: a missing value is missing, not a finding.
 */
function hasRank(value) {
  return value !== null && value !== undefined && value !== ''
}

/**
 * Where our ASIN stands on one keyword.
 *
 * `ranked` — we hold a rank.
 * `absent` — we measured it, with a depth, and we are not in those results.
 * `untested` — no measurement, or one with no depth. Deliberately the fallback:
 *   an unreadable row must not be promoted to a finding.
 */
export function classifyOurSide(mine) {
  if (mine === undefined || mine === null) return 'untested'
  if (hasRank(mine.rank)) return 'ranked'
  if (mine.scanDepth === null || mine.scanDepth === undefined || mine.scanDepth === '') return 'untested'
  return 'absent'
}

/**
 * `search_volume` and where it came from, in one answer.
 *
 * Ordered by how directly each source measures *our* situation: our own scan,
 * then the master library, then the competitor export. Returning the value
 * without the origin is what lets a library full of competitor-monthly volumes
 * read as a library of measured ones.
 */
export function pickVolume(master, measured, monthly, weekly) {
  if (measured !== null && measured !== undefined) return { value: measured, origin: 'measured' }
  if (master !== null && master !== undefined) return { value: master, origin: 'master' }
  const competitor = monthly ?? weekly ?? null
  return { value: competitor, origin: competitor === null ? null : 'competitor_fact' }
}

/* ── F06-04 关键词差距四象限 ───────────────────────────────────────────────────
 *
 * 需求 §20 的四个象限：自有优势 / 共同竞争 / 自有缺席 / 仅品牌不相关。
 *
 * ## 这一块真正要守住的两条
 *
 * ① **未测 ≠ 缺席。** 一条词只因为「竞品有、我们没有」就落进「自有缺席」是最容易
 *    犯的错 —— 两侧的列表长得一模一样，但「我们测过、确实不在结果里」是一个发现，
 *    「我们从没测过」不是。所以 `our_status === 'untested'` 有**自己的桶**
 *    （`unmeasured` 未测），并且它不进候选。把它当成缺席，就是把这个项目反复拒绝的
 *    「把缺失渲染成真实值」又做了一遍。
 *
 * ② **品牌词隔离。** 命中竞品品牌的词进 `brandOnly`，且**永不进候选/机会**。
 *    §20.6 的原话是「不在自有 Listing 使用竞品品牌词」，所以一个把品牌词混进机会
 *    列表的实现在这里当场失败。品牌识别不在这里重写 —— 调用方传入
 *    `competitorBrandHits` 的结果，词汇表只有一份（`store/keyword-ownership.js`）。
 *
 * 分类是**全划分**：每个输入词恰好落进一个桶，桶计数之和等于输入数。调用方
 * （工具/页面）与测试都按这条断言。
 */

/** 五个桶。四象限 + 未测。键是机器名，值是给人看的标签。 */
export const QUADRANTS = {
  ownAdvantage: '自有优势',
  contested: '共同竞争',
  ourAbsent: '自有缺席',
  brandOnly: '仅品牌不相关',
  unmeasured: '未测',
}

/** 展示顺序。未测排在品牌隔离之前，因为它是「待补测量」而不是「要隔离」。 */
export const QUADRANT_ORDER = ['ownAdvantage', 'contested', 'ourAbsent', 'unmeasured', 'brandOnly']

/**
 * 每个象限最多展示多少条。**这是唯一一处上限。**
 *
 * 页面与路由**都**按它来：路由在这里截桶，页面渲染收到的内容、不再自己截一次。
 * 两处各写一个常量（曾经路由写 300、页面写 40）就是「证据集」与「渲染出的行」分家
 * 的成因 —— 用户点得到行、行上却没有证据，而两处算术看起来都「差不多对」。
 */
export const QUADRANT_PAGE_SIZE = 40

/**
 * 一条词落在哪个象限。**品牌命中优先于一切** —— 命中竞品品牌的词无论我们排第几，
 * 都进隔离区，因为它不能出现在自有 Listing 里，讨论「优势」没有意义。
 */
export function classifyQuadrant(row, { brandHits = [] } = {}) {
  if (Array.isArray(brandHits) && brandHits.length > 0) return 'brandOnly'
  const status = row?.our_status
  if (status === 'ranked') {
    /* 竞品侧**没有度量**时，不许判 ownAdvantage（「我们上榜、他们没上」）——
       没测过 ≠ 没上榜。判成 unmeasured，页面会说「未测量」，而不是替用户下一句
       他没法复核的结论。`competitor_total === 0`（没有对端）同理：没有对端就没有对比。 */
    const measured = (row?.competitor_ranked_count !== null && row?.competitor_ranked_count !== undefined)
      || (row?.competitor_best_rank !== null && row?.competitor_best_rank !== undefined)
    if (!measured) return 'unmeasured'
    const theyRank = Number(row.competitor_ranked_count ?? 0) > 0
      || (row?.competitor_best_rank !== null && row?.competitor_best_rank !== undefined)
    return theyRank ? 'contested' : 'ownAdvantage'
  }
  if (status === 'absent') return 'ourAbsent'
  /* 没有测量、或测量没有深度 —— 归 `unmeasured`，**不是** `ourAbsent`。 */
  return 'unmeasured'
}

/**
 * 把词表分成五个桶，并给出计数与候选。
 *
 * `brandHitsFor(keyword)` 返回该词命中的竞品品牌（空数组表示没有命中）。传函数而不是
 * 传 store：本模块对数据库一无所知，品牌识别由调用方复用
 * `store/keyword-ownership.js` 的 `competitorBrandHits` 完成。
 */
export function classifyQuadrants(rows, { brandHitsFor = () => [], marketplace = null } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const buckets = Object.fromEntries(QUADRANT_ORDER.map(key => [key, []]))
  /* T-4b（自洽，不是语义）：逐桶数出「对端未测量」的行。
     这些行的桶归属**一个都不改**（改归属是 T-4a，要动已评审的字面断言），
     这里只是把「这一行对端没数据」这件事**送到页面上**，好让页面不要一边把词算进
     「自有优势」、一边在「对端命中」格印「该词无竞品数据」——同一行两句矛盾的话。 */
  const noData = Object.fromEntries(QUADRANT_ORDER.map(key => [key, 0]))
  for (const row of list) {
    const hits = brandHitsFor(row.keyword) ?? []
    const quadrant = classifyQuadrant(row, { brandHits: hits })
    if (row?.no_data === true) noData[quadrant] += 1
    buckets[quadrant].push({
      ...row,
      marketplace: row.marketplace ?? marketplace,
      quadrant,
      quadrant_label: QUADRANTS[quadrant],
      brand_hits: hits,
    })
  }
  const counts = Object.fromEntries(QUADRANT_ORDER.map(key => [key, buckets[key].length]))
  const classified = QUADRANT_ORDER.reduce((sum, key) => sum + counts[key], 0)

  return {
    quadrants: buckets,
    counts,
    /* 对端未测量的行数，按桶分。**派生字段，不影响任何归属**。
       页面用它来加一句「本页 N 条词的对端没测过，归类口径待定」，而不是改桶名。 */
    noDataByBucket: noData,
    noDataTotal: QUADRANT_ORDER.reduce((sum, key) => sum + noData[key], 0),
    /* 输入数与分类数分开给：两者不等就是分类漏词或重复计数，调用方可以当场断言。 */
    inputTotal: list.length,
    classified,
    /* 候选/机会：只有「我们测过、确实缺席」才算可行动的机会。
       brandOnly 永不进候选（§20.6）；unmeasured 也不进（未测不是缺席）。 */
    candidates: buckets.ourAbsent.map(row => ({
      keyword: row.keyword,
      marketplace: row.marketplace,
      quadrant: 'ourAbsent',
      search_volume: row.search_volume ?? null,
      competitor_best_rank: row.competitor_best_rank ?? null,
    })),
    /* 隔离区：命中竞品品牌的词。它们是**结论**，不是机会 —— 单独给出去，好让调用方
       无法把它们和 candidates 混在一起。 */
    isolated: buckets.brandOnly.map(row => ({
      keyword: row.keyword,
      marketplace: row.marketplace,
      brand_hits: row.brand_hits,
    })),
  }
}

/**
 * 全划分的输入：两侧关键词的并集，每条词一行。
 *
 * `buildCompetitorDiff` 只返回两张差集列表，**两侧都有排名的词不在其中**（它们被算进
 * `counts.ranked` 就 continue 了）。四象限要覆盖每一个词，所以这里从 `sides` 的
 * 两张 Map 直接取并集，行的形状与差集行一致，好让同一个分类器吃两种行。
 */
export function quadrantRows(sides) {
  const ours = sides?.ours ?? new Map()
  const theirs = sides?.theirs ?? new Map()
  const volumes = sides?.volumes ?? new Map()
  const peers = sides?.peers ?? []
  const keywords = [...new Set([...theirs.keys(), ...ours.keys()])]
  return keywords.map(keyword => {
    const mine = ours.get(keyword)
    const their = theirs.get(keyword)
    const volume = pickVolume(volumes.get(keyword), mine?.searchVolume, their?.monthlyVolume, their?.weeklySearches)
    return {
      keyword,
      search_volume: volume.value,
      our_rank: mine?.rank ?? null,
      /* T68：扫描深度跟行走。它是「测了不在前 N」的 N —— 我方侧本来就带
         （readCompetitorSides 的 ours.scanDepth），这里原来丢了。缺失是 null
         （没记深度 = 未测口径，classifyOurSide 同一把尺），渲染层印「本处未记」，
         不补 0。 */
      our_scan_depth: mine?.scanDepth ?? null,
      our_status: classifyOurSide(mine),
      competitor_best_rank: their?.bestRank ?? null,
      /* T-4a（2026-10-25 拍板，需求方授权交付方判断）：**对端没有事实 = 未测量，不是「0 个上榜」**。
         这里原来写 `Number(their?.rankedCount ?? 0)`，于是「没测过」变成「测过、0 个上榜」，
         `classifyQuadrant` 据此判 `ownAdvantage`（我们的优势）——**一句运营没法复核的结论**，
         而同一行的 `no_data` 是 true、页面右格印「该词无竞品数据」。

         改语义的代价（记录在案，不粉饰）：撞 2 条已评审的**字面**断言——
         `b05d-tabs.mjs` 的 C1（`counts.ownAdvantage === 1`）与 `cr1-quadrant-card.mjs` 的 T1
         （字面串 `'1|0|1|1|0'`）。两条都按下面的新口径改，并各带一行理由。

         语义边界（改完「自有优势」这个词的含义收窄了，必须一起读）：
         · 有竞品事实 + 0 个上榜 → 仍判 `ownAdvantage`（真测过，才是优势）；
         · 竞品侧无事实 → `unmeasured`（没测过 ≠ 没上榜）。 */
      competitor_ranked_count: their === undefined ? null : Number(their.rankedCount ?? 0),
      competitor_present_count: their === undefined ? null : Number(their.presentCount ?? 0),
      competitor_total: peers.length,
      competitor_asins: their?.asins ?? [],
      origin: volume.origin,
      no_data: their === undefined,
    }
  })
}

/* ── 差距的证据视图（§20.7「每个差距可点击查看原始数据和时间」） ────────────────
 *
 * ## 这一块守的是 §20.3 那一句
 *
 * 「差距结论必须带周期与来源，**不用不同周期的两侧直接对比**。」
 *
 * 所以两侧各自带 `period`（观测时间）与 `source`（来源），而**只有当两侧周期一致、
 * 且两侧都有测量时**才给出结论 `verdict`。周期不同 → `periodMismatch = true`、
 * `verdict = null`、并给出一句警告。一个把两侧数字直接相减的实现，会在两个不同周期
 * 的数据上写出一个看似权威的差值 —— 那正是这句话禁止的。
 *
 * ## 竞品侧自己跨了多个观测日，也不能给结论
 *
 * 竞品侧是**多个 ASIN 的多行事实**。它的 `period` 取的是 `MAX(collected_at)`，所以
 * 当 14 个竞品分别在 09-01 和 09-08 采集时，一个「我方 09-05 vs 竞品 09-08」的对比
 * 会看起来周期一致，实际上拿一个日期去对一个**跨多日的最大值**。读端把这件事算成了
 * `mixedPeriods` / `periods`，这里消费它：竞品侧多于一个观测日 → `theirPeriodsMixed`
 * 为真、`comparable = false`、`verdict = null`，警告**点名那些日期**。这条警告与
 * `periodMismatch` 分开，因为两者是不同的事实：一个是「两侧不同」，一个是「一侧自己
 * 就不止一个日子」。
 *
 * 缺失一律是 `null`，由渲染层写成「未知 / 未测」，**永不写 0**：0 是一个测量值，
 * 「没有测量」不是。
 */
export function buildEvidenceView({ keyword, marketplace = null, our = null, their = null } = {}) {
  const ourPeriod = our?.period ?? null
  const theirPeriod = their?.period ?? null
  const theirPeriods = Array.isArray(their?.periods) ? their.periods.filter(p => p !== null && p !== undefined) : []
  const theirPeriodsMixed = their?.mixedPeriods === true || theirPeriods.length > 1
  const bothMeasured = our?.measured === true && their?.measured === true
  const bothPeriods = ourPeriod !== null && theirPeriod !== null
  const periodMismatch = bothPeriods && ourPeriod !== theirPeriod
  const comparable = bothMeasured && bothPeriods && !periodMismatch && !theirPeriodsMixed

  return {
    keyword,
    marketplace,
    our: {
      period: ourPeriod,
      source: our?.source ?? null,
      sources: our?.sources ?? (our?.source == null ? [] : [our.source]),
      measured: our?.measured === true,
      facts: our?.facts ?? {},
    },
    their: {
      period: theirPeriod,
      source: their?.source ?? null,
      sources: their?.sources ?? (their?.source == null ? [] : [their.source]),
      periods: theirPeriods,
      mixedPeriods: theirPeriodsMixed,
      measured: their?.measured === true,
      facts: their?.facts ?? {},
    },
    periodMismatch,
    /* 竞品侧自己跨了多个观测日 —— 与 `periodMismatch` 是两回事。 */
    theirPeriodsMixed,
    /* 只有周期一致、竞品侧只有一个观测日、且两侧都有测量时才为 true。 */
    comparable,
    /* 结论：一个对象或 null。null 不是「没有差距」，是「这条不给结论」。 */
    verdict: comparable
      ? {
        our_rank: our?.facts?.rank ?? null,
        competitor_best_rank: their?.facts?.best_rank ?? null,
        our_period: ourPeriod,
        their_period: theirPeriod,
      }
      : null,
    warning: periodMismatch
      ? `两侧观测周期不同（我方 ${ourPeriod} / 竞品 ${theirPeriod}），按 §20.3 不用不同周期的两侧直接对比，本次不给结论。`
      : theirPeriodsMixed
        ? `竞品侧有 ${theirPeriods.length} 个观测日（${theirPeriods.join('、')}），竞品周期不是一个日期 —— 按 §20.3 不给结论。`
        : (bothMeasured ? null : '有一侧没有测量数据，无法对比 —— 缺失显示为「未知/未测」，不是 0。'),
  }
}

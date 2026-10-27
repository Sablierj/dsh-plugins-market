/**
 * 「每个差距可点击查看原始数据和时间」的读半边（§20.7）。
 *
 * 这个模块只**读**，一行都不写，也不做任何判断 —— 判断（周期是否一致、要不要给结论）
 * 在 `domain/keywords/competitor.js` 的 `buildEvidenceView` 里，那里是纯函数，测起来
 * 不碰 SQLite。
 *
 * ## 为什么是一个新文件，而不是扩 `readCompetitorSides`
 *
 * `readCompetitorSides` 只回答「两侧各自的排名聚合」，它按关键词把多行压成一个数，
 * **时间与来源在那一步就丢了**。证据视图要的恰好是那两样，而且必须逐条保留：
 * 我方 `asin_keyword.collected_at`、竞品 `kw_competitor_fact.collected_at`。
 * 把它塞回聚合函数会让每一处调用都背上两次额外的列 —— 所以这里单开一个按关键词批量
 * 取原始行的 reader。
 *
 * ## 为什么按关键词批量取，而不是一条一次
 *
 * 页面一次要为一整屏差集行准备证据（默认上限 100 条）。一条一次查询是 100 次往返；
 * 这里按 400 个关键词分块、每侧一条 `IN (...)`，两次往返封顶。分块是因为 SQLite 的
 * 绑定参数有上限。
 */

/**
 * 我方：同一个关键词可能有多个来源行，取**有排名的最好一条**；都没有排名时取第一条。
 * 这样 `period`/`source` 与展示的 `rank` 是同一行，不会出现「排名来自 A、时间来自 B」。
 */
function betterOur(previous, next) {
  if (previous === undefined) return next
  const left = previous.facts.rank
  const right = next.facts.rank
  if (left === null || left === undefined) return (right === null || right === undefined) ? previous : next
  if (right === null || right === undefined) return previous
  return right < left ? next : previous
}

/**
 * 按关键词读两侧的原始事实，返回 `Map<keyword, { our, their }>`。
 *
 * @param {object} store
 * @param {{asin: string, marketplace: string, peers?: string[], keywords?: string[]}} args
 */
export function readCompetitorEvidence(store, { asin, marketplace, peers = [], keywords = [] } = {}) {
  const ourAsin = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const peerList = [...new Set((peers ?? []).map(peer => String(peer ?? '').trim().toUpperCase()).filter(Boolean))]
  const words = [...new Set((keywords ?? []).map(word => String(word ?? '')).filter(word => word !== ''))]
  const out = new Map()
  if (words.length === 0 || market === '') return out

  for (let i = 0; i < words.length; i += 400) {
    const chunk = words.slice(i, i + 400)
    const marks = chunk.map(() => '?').join(',')

    if (ourAsin !== '') {
      for (const row of store.all(
        `SELECT keyword, source_id, collected_at, rank, scan_depth, search_volume
           FROM asin_keyword
          WHERE asin = ? AND marketplace = ? AND keyword IN (${marks})`,
        [ourAsin, market, ...chunk],
      )) {
        const candidate = {
          period: row.collected_at ?? null,
          source: row.source_id ?? null,
          sources: row.source_id === null || row.source_id === undefined ? [] : [row.source_id],
          measured: true,
          facts: {
            rank: row.rank ?? null,
            scan_depth: row.scan_depth ?? null,
            search_volume: row.search_volume ?? null,
          },
        }
        const entry = out.get(row.keyword) ?? { our: null, their: null }
        entry.our = betterOur(entry.our ?? undefined, candidate)
        out.set(row.keyword, entry)
      }
    }

    if (peerList.length > 0) {
      const peerMarks = peerList.map(() => '?').join(',')
      const grouped = new Map()
      for (const row of store.all(
        `SELECT keyword, asin, source_id, collected_at, organic_rank, organic_no_rank,
                monthly_volume, weekly_searches
           FROM kw_competitor_fact
          WHERE marketplace = ? AND asin IN (${peerMarks}) AND keyword IN (${marks})`,
        [market, ...peerList, ...chunk],
      )) {
        const current = grouped.get(row.keyword) ?? {
          period: null, sources: new Set(), periods: new Set(), asins: new Set(),
          ranked: 0, present: 0, best_rank: null, monthly_volume: null, weekly_searches: null,
        }
        current.present += 1
        current.asins.add(row.asin)
        if (row.source_id !== null && row.source_id !== undefined) current.sources.add(row.source_id)
        /* `collected_at` 是可空的 —— 空的就**不写**，而不是写一个今天的时间。 */
        if (row.collected_at !== null && row.collected_at !== undefined) {
          current.periods.add(row.collected_at)
          if (current.period === null || row.collected_at > current.period) current.period = row.collected_at
        }
        if (row.organic_rank !== null && row.organic_rank !== undefined) {
          current.ranked += 1
          if (current.best_rank === null || row.organic_rank < current.best_rank) current.best_rank = row.organic_rank
        }
        if (row.monthly_volume !== null && row.monthly_volume !== undefined) {
          current.monthly_volume = current.monthly_volume === null
            ? row.monthly_volume
            : Math.max(current.monthly_volume, row.monthly_volume)
        }
        if (row.weekly_searches !== null && row.weekly_searches !== undefined) {
          current.weekly_searches = current.weekly_searches === null
            ? row.weekly_searches
            : Math.max(current.weekly_searches, row.weekly_searches)
        }
        grouped.set(row.keyword, current)
      }
      for (const [keyword, agg] of grouped) {
        const periods = [...agg.periods].sort()
        const entry = out.get(keyword) ?? { our: null, their: null }
        entry.their = {
          period: agg.period,
          source: [...agg.sources].sort().join(', ') || null,
          sources: [...agg.sources].sort(),
          measured: true,
          /* 多个来源、多个观测日都如实说出来：一个「聚合后的一个时间」会假装两侧
             的观测是同一天的。 */
          periods,
          mixedPeriods: periods.length > 1,
          facts: {
            best_rank: agg.best_rank,
            ranked_count: agg.ranked,
            present_count: agg.present,
            asins: [...agg.asins].sort(),
            monthly_volume: agg.monthly_volume,
            weekly_searches: agg.weekly_searches,
          },
        }
        out.set(keyword, entry)
      }
    }
  }

  /* 没有事实的词也给一条空白，好让调用方区分「查过、没有」与「没查」。 */
  for (const word of words) {
    if (!out.has(word)) out.set(word, { our: null, their: null })
  }
  return out
}

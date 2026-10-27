/**
 * Persistence for the keyword master library (schema v9) and the competitor sets
 * that say who we are comparing against (schema v16).
 *
 * Three fact tables and one rollup. The rollup is a **pure function of the
 * facts** — `recomputeMaster` deletes nothing and adds nothing, it recomputes
 * every column from `kw_aba_fact` / `kw_ad_fact` / `kw_competitor_fact`. That
 * is what makes re-running a merge idempotent, and it is the one structural
 * difference from the hub's `keyword_master.db`, which accumulated.
 *
 * The competitor half lives here rather than in its own module because it reads
 * the same fact table: `readCompetitorSides` joins `kw_competitor_fact` (what the
 * 反查 exports said about other ASINs) against `asin_keyword` (what our own
 * browser scans measured), and splitting them would put the two sides of one
 * comparison in two files. It fetches and stops there — deciding which list a
 * word belongs in is a judgement, and it lives in
 * `domain/keywords/competitor.js`.
 *
 * `included = 0` on a `kw_import` row takes that file's facts out of the
 * rollup without deleting them. It exists because ad reports genuinely overlap:
 * the raw SP export covers `20260101-20260415` and the aggregated one covers
 * `20260401-20260416`, so summing both double-counts the overlap. The honest
 * options are "let the user choose" or "silently double-count"; this picks the
 * first, and `findOverlaps` is what makes the choice visible.
 */

import { createHash, randomUUID } from 'node:crypto'

import { composeMaster, wordId } from '../domain/keywords/master.js'
import { productLineSignalsFrom } from '../domain/keywords/classify.js'
import { keywordKey } from '../domain/keywords/key.js'
import { nowIso } from './db.js'
/* The master layer and the competitor sets are both versioned objects, and both
   are *mutable* — the row is overwritten in place — so the version is registered
   from the write path that changes them, not by a later sweep. */
import { registerSnapshot } from './snapshot.js'

/* ───────────────────────────── import log ───────────────────────────── */

/** A file's identity: its size plus a hash of its bytes. */
export function fingerprintOf(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '')
  return `${bytes.length}:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`
}

/**
 * The import log row for these bytes, if they have been imported before.
 *
 * There is deliberately no lookup by `file_name`, and this comment is where that
 * absence is recorded: a `findImportByName` sat here with no caller, no test and
 * no comment, and the reason it stayed unused is that the name is not an
 * identity in this store. `pipeline.js` reports `same-bytes-different-name` as
 * its own skip reason, because two names over one file would double-count every
 * metric if both were imported — and the reverse is just as wrong, since a
 * lookup by name says "already imported" for a *different* file that reuses a
 * name. Identity is the bytes; anything else is a guess wearing a dedupe's
 * clothes.
 */
export function findImportByFingerprint(store, fingerprint) {
  return store.get('SELECT * FROM kw_import WHERE fingerprint = ? ORDER BY imported_at DESC LIMIT 1', [String(fingerprint)])
}

export function getImport(store, id) {
  return store.get('SELECT * FROM kw_import WHERE id = ?', [String(id)])
}

export function listImports(store, { limit = 50, kind = null, included = null } = {}) {
  const where = []
  const params = []
  if (kind !== null) { where.push('kind = ?'); params.push(String(kind)) }
  if (included !== null) { where.push('included = ?'); params.push(included ? 1 : 0) }
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500)
  return store.all(
    `SELECT * FROM kw_import
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY imported_at DESC LIMIT ?`,
    [...params, cap],
  )
}

export function setImportIncluded(store, id, included) {
  store.run('UPDATE kw_import SET included = ? WHERE id = ?', [included ? 1 : 0, String(id)])
  return getImport(store, id)
}

export function recordImport(store, record) {
  /* 同一份文件（同内容哈希）只能有一条导入记录。
     以前这里永远新生成一个 id，于是 `force: true` 重导一次就多一行；
     任何「按 source_file 关联 kw_import」的查询都会把同一份文件算两遍 ——
     实测重导两个广告文件后，文件级合计正好是真值的 2 倍。
     重导的语义是「重新解析同一份文件」，不是「又导入了一份新文件」。 */
  let importId = record?.id
  if (importId === undefined || importId === null) {
    const fingerprint = String(record?.fingerprint ?? '')
    const existing = fingerprint === ''
      ? null
      : store.get('SELECT id FROM kw_import WHERE fingerprint = ? ORDER BY imported_at LIMIT 1', [fingerprint])
    importId = existing?.id ?? randomUUID()
  }
  const id = String(importId)
  store.run(
    `INSERT INTO kw_import
       (id, kind, source_id, file_path, file_name, bytes, fingerprint, marketplace, period,
        granularity, layout, rows_read, rows_read_missing, facts_written, status, included, problems_json,
        stats_json, note, imported_at, date_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       rows_read = excluded.rows_read,
       rows_read_missing = excluded.rows_read_missing,
       facts_written = excluded.facts_written,
       status = excluded.status,
       included = excluded.included,
       problems_json = excluded.problems_json,
       stats_json = excluded.stats_json,
       note = excluded.note,
       imported_at = excluded.imported_at`,
    [
      id,
      String(record.kind),
      String(record.sourceId ?? 'manual'),
      String(record.filePath ?? ''),
      String(record.fileName ?? ''),
      Number(record.bytes ?? 0),
      String(record.fingerprint ?? ''),
      String(record.marketplace ?? 'US').toUpperCase(),
      String(record.period ?? 'unknown'),
      record.granularity ?? null,
      record.layout ?? null,
      /* 列是 NOT NULL，装不下「没记到」：那种时候它只能放 0，**真相由下一格的标记说**。
         这不是「0 是个可以接受的缺省」，而是「列装不下 null，所以另立一列记缺失」——
         与 v67 对 `kw_ad_fact.spend` 的处理同一个办法（迁移 v68 的注释里有完整口径）。 */
      record.rowsRead === null || record.rowsRead === undefined ? 0 : Number(record.rowsRead),
      record.rowsRead === null || record.rowsRead === undefined ? 1 : 0,
      Number(record.factsWritten ?? 0),
      String(record.status ?? 'ok'),
      record.included === false ? 0 : 1,
      record.problems === undefined ? null : JSON.stringify(record.problems),
      record.stats === undefined ? null : JSON.stringify(record.stats),
      record.note ?? null,
      record.importedAt ?? nowIso(),
      record.dateSource ?? null,
    ],
  )
  return getImport(store, id)
}

/** File paths whose facts are excluded from the rollup. */
function excludedFiles(store) {
  return new Set(store.all('SELECT file_path FROM kw_import WHERE included = 0').map(row => row.file_path))
}

/**
 * 从文件名认广告类型：sp / sb / sd，认不出是 null。
 *
 * 为什么要认：**SP、SB、SD 是三个不同的广告产品**，同一个搜索词可以同时出三种广告位，
 * 它们的曝光是**相加**的，不是重复。只按日期判"重叠"会把 SP 与 SB 报成重复计数，
 * 用户照做就会把 SB 的真实数据排除掉 —— 那是"修一个不存在的错"。
 *
 * 认不出时返回 null，调用方按"同一类"处理：**宁可多报一次，不可漏报**。
 */
function adTypeOf(fileName) {
  const name = String(fileName ?? '').toLowerCase()
  if (/[-_\s]sp[-_\s]/.test(name)) return 'sp'
  if (/[-_\s]sb[-_\s]/.test(name)) return 'sb'
  if (/[-_\s]sd[-_\s]/.test(name)) return 'sd'
  return null
}

/**
 * Periods claimed by more than one included ad file for a marketplace.
 *
 * Overlap is not an error — it is a fact about the exports that the user has to
 * know about before trusting the totals. Reported as a warning, never resolved
 * silently.
 */
export function findOverlaps(store, marketplace = null) {
  const market = marketplace === null ? null : String(marketplace).toUpperCase()
  const rows = store.all(
    `SELECT file_name, period, marketplace, granularity FROM kw_import
      WHERE included = 1 AND kind = 'ad_report'
        ${market === null ? '' : 'AND marketplace = ?'}
      ORDER BY period`,
    market === null ? [] : [market],
  )
  const overlaps = []
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      /* 两种广告产品报同一段时间不是重复（见 adTypeOf）。 */
      const typeA = adTypeOf(rows[i].file_name)
      const typeB = adTypeOf(rows[j].file_name)
      if (typeA !== null && typeB !== null && typeA !== typeB) continue
      if (periodsOverlap(rows[i].period, rows[j].period)) {
        overlaps.push({ a: rows[i], b: rows[j] })
      }
    }
  }
  return overlaps
}

/**
 * Do two period labels describe intersecting windows?
 *
 * Two shapes occur: a closed range `20260101-20260415` and a single bucket
 * `202603` / `20260401-20260416`. A single bucket is turned into a range by
 * appending the end of its granularity, which is why `granularity` is stored.
 */
export function periodsOverlap(a, b) {
  const ra = periodRange(a)
  const rb = periodRange(b)
  if (ra === null || rb === null) return false
  return ra.start <= rb.end && rb.start <= ra.end
}

/**
 * A period label → `{start, end}`, or null when it cannot be trusted.
 *
 * An inverted range (`20260314-20160412`, a year typo in a real filename)
 * returns null rather than being normalised. Normalising by min/max would give
 * a ten-year span that overlaps everything and bury the real overlaps in noise;
 * normalising by guessing the intended year would write a fabricated label into
 * a primary key. Returning null means "this file is not part of overlap
 * detection", which the import reports as a problem.
 */
export function periodRange(period) {
  const text = String(period ?? '')
  const range = /^(\d{8})-(\d{8})$/.exec(text)
  if (range !== null) {
    if (range[2] < range[1]) return null
    return { start: range[1], end: range[2] }
  }
  const month = /^(\d{6})$/.exec(text)
  if (month !== null) return { start: `${month[1]}01`, end: `${month[1]}31` }
  const day = /^(\d{8})$/.exec(text)
  if (day !== null) return { start: day[1], end: day[1] }
  return null
}

/* ─────────────────────────────── facts ─────────────────────────────── */

/** Write ABA facts. Keyed by period, so a re-import replaces rather than adds. */
export function upsertAbaFacts(store, facts, { marketplace, period, sourceFile }) {
  const now = nowIso()
  let written = 0
  store.tx(() => {
    for (const fact of facts) {
      store.run(
        `INSERT INTO kw_aba_fact
           (keyword, marketplace, period, report_date, score, search_volume, total_impressions,
            brand_impressions, brand_impression_pct, total_clicks, brand_clicks, brand_click_pct,
            total_purchases, brand_purchases, brand_conv_pct, cvr_pct, source_file, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(keyword, marketplace, period) DO UPDATE SET
           report_date = excluded.report_date, score = excluded.score,
           search_volume = excluded.search_volume, total_impressions = excluded.total_impressions,
           brand_impressions = excluded.brand_impressions,
           brand_impression_pct = excluded.brand_impression_pct,
           total_clicks = excluded.total_clicks, brand_clicks = excluded.brand_clicks,
           brand_click_pct = excluded.brand_click_pct,
           total_purchases = excluded.total_purchases, brand_purchases = excluded.brand_purchases,
           brand_conv_pct = excluded.brand_conv_pct, cvr_pct = excluded.cvr_pct,
           source_file = excluded.source_file, imported_at = excluded.imported_at`,
        [
          keywordKey(fact.keyword), marketplace, period,
          fact.reportDate ?? null, int(fact.score), int(fact.searchVolume),
          int(fact.totalImpressions), int(fact.brandImpressions), num(fact.brandImpressionPct),
          int(fact.totalClicks), int(fact.brandClicks), num(fact.brandClickPct),
          int(fact.totalPurchases), int(fact.brandPurchases), num(fact.brandConvPct),
          num(fact.cvr), sourceFile, now,
        ],
      )
      written += 1
    }
  })
  return written
}

/** Write ad facts. Keyed by (period, file), so re-importing a file replaces. */
export function upsertAdFacts(store, facts, { marketplace, period, sourceFile }) {
  const now = nowIso()
  let written = 0
  store.tx(() => {
    for (const fact of facts) {
      store.run(
        `INSERT INTO kw_ad_fact
           (keyword, marketplace, period, source_file, impressions, clicks, orders, spend, sales,
            spend_missing, sales_missing,
            ad_rows, asins_json, match_types_json, campaigns_json, ad_types_json,
            first_date, last_date, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(keyword, marketplace, period, source_file) DO UPDATE SET
           impressions = excluded.impressions, clicks = excluded.clicks, orders = excluded.orders,
           spend = excluded.spend, sales = excluded.sales,
           spend_missing = excluded.spend_missing, sales_missing = excluded.sales_missing,
           ad_rows = excluded.ad_rows,
           asins_json = excluded.asins_json, match_types_json = excluded.match_types_json,
           campaigns_json = excluded.campaigns_json, ad_types_json = excluded.ad_types_json,
           first_date = excluded.first_date, last_date = excluded.last_date,
           imported_at = excluded.imported_at`,
        [
          keywordKey(fact.keyword), marketplace, period, sourceFile,
          int(fact.impressions) ?? 0, int(fact.clicks) ?? 0, int(fact.orders) ?? 0,
          num(fact.spend) ?? 0, num(fact.sales) ?? 0,
          /* T-3：缺失标记随行走。列是 NOT NULL DEFAULT 0，所以「0」只意味着
             「这一行没被标记为缺失」，不意味着「数据完整」（老数据也是 0）。 */
          int(fact.spendMissing) ?? 0, int(fact.salesMissing) ?? 0,
          int(fact.adRows) ?? 0,
          json(fact.asins), json(fact.matchTypes), json(fact.campaigns), json(fact.adTypes),
          fact.firstDate ?? null, fact.lastDate ?? null, now,
        ],
      )
      written += 1
      /* 日粒度：只有行内带日期的文件（SP/SB 导出）才有 daily。
         聚合报表没有日期列，这里是空数组 —— 不猜、不用文件名补。 */
      if (Array.isArray(fact.daily) && fact.daily.length > 0) {
        for (const day of fact.daily) {
          store.run(
            `INSERT INTO kw_ad_daily
               (keyword, marketplace, ad_date, ad_type, source_file,
                impressions, clicks, orders, spend, sales, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(keyword, marketplace, ad_date, ad_type, source_file) DO UPDATE SET
               impressions = excluded.impressions, clicks = excluded.clicks,
               orders = excluded.orders, spend = excluded.spend, sales = excluded.sales,
               imported_at = excluded.imported_at`,
            [keywordKey(fact.keyword), marketplace, day.date, day.adType ?? "", sourceFile,
              int(day.impressions) ?? 0, int(day.clicks) ?? 0, int(day.orders) ?? 0,
              num(day.spend) ?? 0, num(day.sales) ?? 0, now],
          )
        }
      }
    }
  })
  return written
}

/** Write competitor facts. Keyed by (ASIN, source), so the newest export wins. */
export function upsertCompetitorFacts(store, facts, { marketplace, sourceFile }) {
  const now = nowIso()
  let written = 0
  store.tx(() => {
    for (const fact of facts) {
      const asin = fact.asin === null || fact.asin === undefined ? '' : String(fact.asin).toUpperCase()
      if (asin === '') continue
      store.run(
        `INSERT INTO kw_competitor_fact
           (keyword, marketplace, asin, source_id, organic_rank, organic_page, organic_no_rank,
            ad_rank, keyword_types_json, traffic_share, weekly_impressions, weekly_searches,
            monthly_volume, purchases, purchase_rate_pct, spr, aba_rank, title_density, products,
            cpc, bid_low, bid_high, difficulty, difficulty_band, top_asins, collected_at,
            source_file, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(keyword, marketplace, asin, source_id) DO UPDATE SET
           organic_rank = excluded.organic_rank, organic_page = excluded.organic_page,
           organic_no_rank = excluded.organic_no_rank, ad_rank = excluded.ad_rank,
           keyword_types_json = excluded.keyword_types_json, traffic_share = excluded.traffic_share,
           weekly_impressions = excluded.weekly_impressions, weekly_searches = excluded.weekly_searches,
           monthly_volume = excluded.monthly_volume, purchases = excluded.purchases,
           purchase_rate_pct = excluded.purchase_rate_pct, spr = excluded.spr,
           aba_rank = excluded.aba_rank, title_density = excluded.title_density,
           products = excluded.products, cpc = excluded.cpc, bid_low = excluded.bid_low,
           bid_high = excluded.bid_high, difficulty = excluded.difficulty,
           difficulty_band = excluded.difficulty_band, top_asins = excluded.top_asins,
           collected_at = excluded.collected_at, source_file = excluded.source_file,
           imported_at = excluded.imported_at`,
        [
          keywordKey(fact.keyword), marketplace, asin, String(fact.sourceId ?? 'sellersprite'),
          int(fact.organicRank), int(fact.organicPage), fact.organicNoRank === true ? 1 : 0,
          int(fact.adRank), json(fact.keywordTypes), num(fact.trafficShare),
          num(fact.weeklyImpressions), num(fact.weeklySearches), int(fact.monthlyVolume),
          int(fact.purchases), num(fact.purchaseRatePct), int(fact.spr), int(fact.abaRank),
          int(fact.titleDensity), int(fact.products), num(fact.cpc),
          num(fact.bid?.low), num(fact.bid?.high), num(fact.difficulty),
          fact.difficultyBand ?? null, fact.topAsins ?? null, fact.collectedAt ?? null,
          sourceFile, now,
        ],
      )
      written += 1
    }
  })
  return written
}

/* ───────────────────────────── rollup ───────────────────────────── */

/**
 * Recompute `kw_master` from the facts.
 *
 * `keywords` limits the work to a set of words — the import path uses it so
 * importing a 20k-row ad report does not recompute the whole library. Passing
 * nothing recomputes everything, which is what `amzn_kw_merge` does.
 *
 * @returns {{ rows: number, keywords: number, excludedFiles: number }}
 */
export function recomputeMaster(store, { marketplace = null, keywords = null, registerVersion = null } = {}) {
  const market = marketplace === null ? null : String(marketplace).toUpperCase()
  const excluded = excludedFiles(store)
  // Folded, because the fact tables now store folded keywords: filtering with a
  // mixed-case list would silently recompute nothing for those words.
  const only = keywords === null ? null : new Set([...keywords].map(keywordKey))
  /* The product-line signal lists, resolved once. Every keyword in this pass
     classifies against the same five lists, so this is read here and not inside
     the loop — a per-keyword read would be one query per row for a value that
     cannot change mid-transaction. */
  const signalsFor = () => productLineSignalsFrom(store)

  /* 真增量：把关键词过滤**下推到 SQL**。
     以前这里是「先把三张事实表全查出来，再在 JS 里按 `only` 过滤」—— 于是
     "只重算 2 个词"仍要读 6 万行事实，实测 1.9 秒。改成 IN 查询后，代价只跟
     这次涉及的词数有关，与本库总规模无关。
     IN 列表按 500 个一批切：SQLite 对单条语句的绑定变量个数有上限，
     两万个关键词塞进一条语句会直接报错。 */
  const factsFor = (table) => {
    const marketClause = market === null ? '' : 'AND marketplace = ?'
    const marketParams = market === null ? [] : [market]
    if (only === null) {
      return store.all(
        `SELECT * FROM ${table} WHERE 1 = 1 ${marketClause}`,
        marketParams,
      )
    }
    const words = [...only]
    const out = []
    for (let index = 0; index < words.length; index += 500) {
      const chunk = words.slice(index, index + 500)
      out.push(...store.all(
        `SELECT * FROM ${table} WHERE keyword IN (${chunk.map(() => '?').join(', ')}) ${marketClause}`,
        [...chunk, ...marketParams],
      ))
    }
    return out
  }

  const abaRows = factsFor('kw_aba_fact')
  const adRows = factsFor('kw_ad_fact')
  const compRows = factsFor('kw_competitor_fact')

  const grouped = new Map()
  const bucket = (keyword, marketKey) => {
    const key = `${keyword}\u0000${marketKey}`
    let entry = grouped.get(key)
    if (entry === undefined) {
      entry = { keyword, marketplace: marketKey, aba: [], ads: [], competitor: [], listed: [] }
      grouped.set(key, entry)
    }
    return entry
  }

  for (const row of abaRows) {
    if (excluded.has(row.source_file)) continue
    if (only !== null && !only.has(row.keyword)) continue
    bucket(row.keyword, row.marketplace).aba.push(hydrateAbaFact(row))
  }
  for (const row of adRows) {
    if (excluded.has(row.source_file)) continue
    if (only !== null && !only.has(row.keyword)) continue
    bucket(row.keyword, row.marketplace).ads.push(hydrateAdFact(row))
  }
  for (const row of compRows) {
    if (excluded.has(row.source_file)) continue
    if (only !== null && !only.has(row.keyword)) continue
    bucket(row.keyword, row.marketplace).competitor.push(hydrateCompetitorFact(row))
  }

  // A keyword can exist only in `keyword` (added by hand, discovered by the
  // browser, or imported from a plain list) with no fact rows at all. Those
  // still belong in the master library — they are the words nothing has been
  // imported *about*.
  //
  // `search_volume` and `difficulty` come along because a hand-written list
  // usually carries them, and dropping them here would mean a list imported
  // with volumes produces a library full of volume-less words: the numbers
  // would be in the database and nowhere any query could reach them.
  //
  // `source_file` decides whether the word is in at all. A word that came from
  // a plain-list import belongs to that import and goes away when it is
  // excluded; a word with no source file came from the browser or from a human,
  // is part of the standing library, and is nobody's import to exclude.
  const listedRows = only === null
    ? store.all(
      `SELECT keyword, marketplace, search_volume, difficulty, source_file FROM keyword ${market === null ? '' : 'WHERE marketplace = ?'}`,
      market === null ? [] : [market],
    )
    : [...only].flatMap(keyword => store.all(
      `SELECT keyword, marketplace, search_volume, difficulty, source_file FROM keyword WHERE keyword = ?${market === null ? '' : ' AND marketplace = ?'}`,
      market === null ? [keyword] : [keyword, market],
    ))
  for (const row of listedRows) {
    if (row.source_file !== null && row.source_file !== undefined && excluded.has(row.source_file)) continue
    const entry = bucket(row.keyword, row.marketplace)
    entry.listed.push({ source: 'keyword', searchVolume: row.search_volume, difficulty: row.difficulty })
  }

  // `first_seen_at` is the one column that is *not* a function of the facts —
  // it is history, and it must survive the rebuild below.
  const firstSeen = new Map(
    store
      .all(
        `SELECT keyword, marketplace, first_seen_at FROM kw_master ${market === null ? '' : 'WHERE marketplace = ?'}`,
        market === null ? [] : [market],
      )
      .map(row => [`${row.keyword}\u0000${row.marketplace}`, row.first_seen_at]),
  )

  const now = nowIso()
  let rows = 0
  let removed = 0
  /* 信号表在这次重算里只读**一次**。
     原来 signals: signalsFor() 写在循环体里 —— 每个词都去查一遍 product_line，
     3 万个词就是 3 万次查询。注释写的是 per recompute 读一次，代码不是。
     这也是增量重算为什么有个 1.5 秒固定成本：它和词数无关，只和库的大小有关。 */
  const signalsSnapshot = signalsFor()
  /* 预编译一次 UPSERT：3 万次写入共用同一个 statement。 */
  const upsertStatement = store.raw.prepare(UPSERT_MASTER_SQL)
  store.tx(() => {
    /* 不再「先全删再全插」。
       `upsertMaster` 本身是 `ON CONFLICT DO UPDATE`，已经能覆盖已有行；先删再插
       唯一的作用是清掉「事实已经没了」的行，而那件事可以更便宜地做 —— 见下面的
       「列出本次产出、删掉其余」。删除量从 3 万行降到真正消失的那几行，
       全量重算因此从 8.9 秒降到 1 秒级。 */
    const produced = new Set()

    for (const entry of grouped.values()) {
      const newestAba = entry.aba.length === 0
        ? null
        : entry.aba.reduce((best, row) => (String(row.period) > String(best.period) ? row : best))
      const record = composeMaster({
        keyword: entry.keyword,
        marketplace: entry.marketplace,
        aba: newestAba,
        /* 全部 ABA 期一起给：趋势要用历史，不能只看最新一条。 */
        abaHistory: entry.aba,
        ads: entry.ads,
        competitor: entry.competitor,
        listed: entry.listed,
        /* The signal lists, read from the store so a product line the user added
           through the settings page actually classifies. Read once per recompute
           rather than per keyword: it is the same five rows every time, and a
           per-keyword query would be 30k identical reads. A store that has never
           had `signals_json` set falls back to the code constant inside
           `productLineSignalsFrom`, so this is additive. */
        signals: signalsSnapshot,
      })
      upsertMaster(store, record, now, firstSeen.get(`${entry.keyword}\u0000${entry.marketplace}`) ?? now, upsertStatement)
      produced.add(`${entry.keyword}\u0000${entry.marketplace}`)
      rows += 1
    }

    /* 清掉「这一轮没有产出」的行。
       全量重算：本市场里所有没被产出的行（事实被排除 / 删除后的残留）；
       增量重算：`only` 里那些一个事实都不剩的词。
       用临时表而不是 NOT IN (?,?,…)：3 万个占位符会撞绑定变量上限。 */
    if (only === null) {
      store.run('CREATE TEMP TABLE IF NOT EXISTS _kw_seen (keyword TEXT NOT NULL, marketplace TEXT NOT NULL, PRIMARY KEY (keyword, marketplace))')
      store.run('DELETE FROM _kw_seen')
      for (const key of produced) {
        const split = key.indexOf('\u0000')
        store.run('INSERT OR IGNORE INTO _kw_seen (keyword, marketplace) VALUES (?, ?)', [key.slice(0, split), key.slice(split + 1)])
      }
      removed = store.run(
        `DELETE FROM kw_master
          WHERE ${market === null ? '' : 'marketplace = ? AND '}NOT EXISTS (
            SELECT 1 FROM _kw_seen s
             WHERE s.keyword = kw_master.keyword AND s.marketplace = kw_master.marketplace)`,
        market === null ? [] : [market],
      ).changes
    } else {
      const words = [...only]
      for (let index = 0; index < words.length; index += 500) {
        const chunk = words.slice(index, index + 500)
        const existing = store.all(
          `SELECT keyword, marketplace FROM kw_master WHERE keyword IN (${chunk.map(() => '?').join(', ')})${market === null ? '' : ' AND marketplace = ?'}`,
          market === null ? chunk : [...chunk, market],
        )
        for (const row of existing) {
          if (produced.has(`${row.keyword}\u0000${row.marketplace}`)) continue
          removed += store.run(
            'DELETE FROM kw_master WHERE keyword = ? AND marketplace = ?',
            [row.keyword, row.marketplace],
          ).changes
        }
      }
    }
  })

  /* A version of the whole layer, registered where the layer is rebuilt.
     `kw_master` has no per-row id to point at — the object *is* the set of rows
     for a marketplace — so a pointer would name nothing.

     The body is **not** frozen, and that is the deliberate difference from the
     other mutable object (the competitor set). This layer is *derived*:
     `recomputeMaster` rebuilds every column from the three fact tables, and the
     fact tables are what module 03's retention policy keeps. Freezing the
     derivative would be both expensive and redundant — measured on the real
     store, US at 30 777 rows, one frozen body is **49 MB**, and this function
     runs on every import merge. The descriptor below says what the version *is*
     and lets anyone check it by rebuilding.

     Only a pass that actually changed something registers: a merge that wrote
     and removed nothing is not a new version, and a registry that gains a row
     per no-op recompute is a registry nobody can read. */
  /* 增量导入**不**生成整层版本。
     为什么：`masterSnapshotPayload` 要把 3 万行读一遍做摘要，实测每次约 1.5 秒 ——
     这是增量重算那个"和词数无关的固定成本"。而一个整层版本对每一次文件导入都记一条，
     结果就是导入 36 个文件得到 36 个几乎一样的版本，既贵又没人读得动。
     版本属于**库这一层**的状态，由显式的全量合并（amzn_kw_merge）产生；
     增量导入只是把事实搬进主表，它改变的是行，不是这一层的定义。
     需要强制记录时传 registerVersion: true。 */
  const wantsVersion = registerVersion === null ? only === null : registerVersion === true
  if ((rows > 0 || removed > 0) && wantsVersion) {
    const touched = market !== null
      ? [market]
      : [...new Set([...grouped.values()].map(entry => entry.marketplace))]
    for (const touchedMarket of touched) {
      registerSnapshot(store, {
        objectType: 'kw_master',
        objectId: touchedMarket,
        payload: masterSnapshotPayload(store, touchedMarket),
      })
    }
  }

  return { rows, keywords: grouped.size, excludedFiles: excluded.size, removed }
}

/**
 * What a `kw_master` version *is*, in bounded space.
 *
 * The digest is taken row by row rather than over one `JSON.stringify(rows)`:
 * the single string would be ~49 MB at the current size, and hashing it means
 * holding all of it at once for no gain. Row order is fixed by `ORDER BY
 * keyword` so the same facts always hash the same — which is the property the
 * assertion "rebuilding twice over the same facts gives the same digest" rests
 * on, and therefore the property that makes "resolve this version" mean
 * "rebuild and compare" instead of "read back a copy".
 *
 * `updated_at` is **left out**, and that exclusion is the whole difference
 * between a digest that verifies content and one that only tells the time:
 * `recomputeMaster` rewrites that column on every pass, so hashing it made two
 * rebuilds over identical facts disagree (caught by the assertion, not by
 * inspection). `first_seen_at` stays in — it is the one column that is not a
 * function of the facts (`kw.js` reads the old value back), so it *is* content.
 *
 * `count` and `columns` are here as well as inside the digest because a digest
 * that differs tells you *that* something changed and nothing about what.
 */
function masterSnapshotPayload(store, marketplace) {
  const rows = store.all('SELECT * FROM kw_master WHERE marketplace = ? ORDER BY keyword', [marketplace])
  const hash = createHash('sha256')
  for (const row of rows) {
    const { updated_at: _volatile, ...content } = row
    hash.update(JSON.stringify(content))
  }
  return {
    marketplace,
    count: rows.length,
    columns: rows.length > 0 ? Object.keys(rows[0]).length : 0,
    digest: hash.digest('hex'),
    composedAt: nowIso(),
    /* How to turn this descriptor back into the layer it describes. A version
       that cannot be resolved is a row that can be listed and never read. */
    rebuild: { from: 'fact tables', via: 'recomputeMaster' },
  }
}

/**
 * Fact rows → the shape `composeMaster` takes.
 *
 * The rollup's contract is the **importers'** shape — camelCase, JSON columns
 * already parsed — because that is what `composeMaster` is unit-tested against
 * and what the import path feeds it. A raw SQLite row is snake_case with
 * `*_json` strings, so it has to be translated at this one boundary.
 *
 * Skipping this step does not throw. It reads `row.organicRank` as `undefined`,
 * and `undefined` flows through `Number(...)` guards as `null`, so the rollup
 * quietly reports "no competitor ranks for this word" for a library that is
 * full of competitor ranks — and `search_volume` as unknown for 11,927 words
 * that have it. Both symptoms look like data, which is why this boundary is
 * spelled out rather than inlined with `??`.
 */
export function hydrateAbaFact(row) {
  return {
    keyword: row.keyword,
    period: row.period,
    reportDate: row.report_date,
    score: row.score,
    searchVolume: row.search_volume,
    totalImpressions: row.total_impressions,
    brandImpressions: row.brand_impressions,
    brandImpressionPct: row.brand_impression_pct,
    totalClicks: row.total_clicks,
    brandClicks: row.brand_clicks,
    brandClickPct: row.brand_click_pct,
    totalPurchases: row.total_purchases,
    brandPurchases: row.brand_purchases,
    brandConvPct: row.brand_conv_pct,
    cvr: row.cvr_pct,
  }
}

export function hydrateAdFact(row) {
  return {
    keyword: row.keyword,
    period: row.period,
    sourceFile: row.source_file,
    impressions: row.impressions,
    clicks: row.clicks,
    orders: row.orders,
    spend: row.spend,
    sales: row.sales,
    adRows: row.ad_rows,
    asins: parseJson(row.asins_json, []),
    matchTypes: parseJson(row.match_types_json, []),
    campaigns: parseJson(row.campaigns_json, []),
    adTypes: parseJson(row.ad_types_json, []),
    firstDate: row.first_date,
    lastDate: row.last_date,
  }
}

export function hydrateCompetitorFact(row) {
  return {
    keyword: row.keyword,
    asin: row.asin,
    sourceId: row.source_id,
    organicRank: row.organic_rank,
    organicPage: row.organic_page,
    organicNoRank: row.organic_no_rank === 1,
    adRank: row.ad_rank,
    keywordTypes: parseJson(row.keyword_types_json, []),
    trafficShare: row.traffic_share,
    weeklyImpressions: row.weekly_impressions,
    weeklySearches: row.weekly_searches,
    monthlyVolume: row.monthly_volume,
    purchases: row.purchases,
    purchaseRatePct: row.purchase_rate_pct,
    spr: row.spr,
    abaRank: row.aba_rank,
    titleDensity: row.title_density,
    products: row.products,
    cpc: row.cpc,
    bid: { low: row.bid_low, high: row.bid_high },
    difficulty: row.difficulty,
    difficultyBand: row.difficulty_band,
    topAsins: row.top_asins,
    collectedAt: row.collected_at,
  }
}

/** Columns written by `upsertMaster`, in the order the INSERT lists them. */
const MASTER_COLUMNS = [
  'word_id', 'product_line', 'product_line_matched', 'product_lines_json', 'sources_json',
  'has_aba', 'has_ad', 'has_competitor', 'listed',
  'search_volume', 'search_volume_source', 'search_volume_period', 'weekly_searches', 'aba_score',
  'impressions', 'clicks', 'orders', 'spend', 'sales', 'ad_rows', 'ad_files',
  'ad_periods_json', 'ad_match_types_json', 'ad_asins_json', 'asin_count',
  'ctr_pct', 'cvr_pct', 'cvr_source', 'acos_pct', 'roas', 'cpc',
  'brand_impressions', 'brand_impression_pct', 'brand_clicks', 'brand_click_pct',
  'brand_purchases', 'brand_conv_pct', 'total_impressions', 'total_clicks', 'total_purchases',
  'own_status', 'funnel', 'sv_tier', 'sv_tier_label', 'sv_tier_known', 'modifiers_json',
  'priority', 'opportunity',
  'competitor_best_rank', 'competitor_best_asin', 'competitor_ranked_count',
  'competitor_absent_count', 'competitor_asins_json', 'competitor_tags_json',
  'competitor_top_traffic_share', 'competitor_cpc', 'competitor_difficulty',
  'competitor_sources_json', 'competitor_ranked_json',
  'listed_volume', 'listed_difficulty', 'for_listing_json',
  /* 词角色：这个词是不是在说"本产品"。标题资格由它决定（见 domain/keywords/role.js）。 */
  'role', 'role_basis_json',
  'trend_json', 'placement_json',
  /* 落位槽位的真实列：让筛标题候选能走索引，不用 json_extract 全表扫。 */
  'placement_slot',
]

/* 一条 UPSERT 的 SQL 文本，只拼一次。`recomputeMaster` 会拿它跑 3 万次 —— 每次现拼
   一遍字符串，再让 `store.run` 现 prepare 一遍，是纯浪费。 */
const UPSERT_MASTER_SQL = `INSERT INTO kw_master (keyword, marketplace, ${MASTER_COLUMNS.join(', ')}, first_seen_at, updated_at)
     VALUES (?, ?, ${MASTER_COLUMNS.map(() => '?').join(', ')}, ?, ?)
     ON CONFLICT(keyword, marketplace) DO UPDATE SET
       ${MASTER_COLUMNS.map(column => `${column} = excluded.${column}`).join(',\n       ')},
       updated_at = excluded.updated_at`

export function upsertMaster(store, record, now = nowIso(), firstSeenAt = null, statement = null) {
  const values = MASTER_COLUMNS.map(column => masterValue(column, record))
  // The stored spelling is the folded one, and the caller gets back what was
  // actually written rather than what it passed in — otherwise a caller that
  // echoes `record.keyword` onwards reports a spelling the library does not hold.
  const keyword = keywordKey(record.keyword)
  const params = [keyword, record.marketplace, ...values, firstSeenAt ?? now, now]
  /* `statement` 由重算调用方传进来（预编译一次）；单次写入的调用方不传，走 store.run。 */
  if (statement !== null && statement !== undefined) statement.run(...params)
  else store.run(UPSERT_MASTER_SQL, params)
  return { keyword, marketplace: record.marketplace }
}

/**
 * Column → value, for the INSERT.
 *
 * Most columns map to the camelCase field of the same name (`ad_rows` ←
 * `adRows`), derived rather than listed: a 63-entry hand-written map is 63
 * chances to write `ad_rows` ← `record.ad_rows`, which reads fine and stores
 * `null` — and `ad_rows` is `NOT NULL`, so it surfaces as a constraint failure
 * rather than as a silently missing number. The few columns that need real
 * translation (`*_json`, the booleans, the hash) are listed above it.
 */
function masterValue(column, record) {
  switch (column) {
    case 'word_id': return record.word_id ?? wordId(record.keyword)
    case 'product_lines_json': return json(record.productLines)
    case 'sources_json': return json(record.sources)
    case 'has_aba': return record.hasAba ? 1 : 0
    case 'has_ad': return record.hasAd ? 1 : 0
    case 'has_competitor': return record.hasCompetitor ? 1 : 0
    case 'listed': return record.listed ? 1 : 0
    case 'ad_periods_json': return json(record.adPeriods)
    case 'ad_match_types_json': return json(record.adMatchTypes)
    case 'ad_asins_json': return json(record.adAsins)
    case 'modifiers_json': return json(record.modifiers)
    case 'sv_tier_known': return record.svTierKnown ? 1 : 0
    case 'competitor_asins_json': return json(record.competitorAsins)
    case 'competitor_tags_json': return json(record.competitorTags)
    case 'competitor_sources_json': return json(record.competitorSources)
    case 'competitor_ranked_json': return json(record.competitorRanked)
    case 'for_listing_json': return json(record.forListing)
    case 'role_basis_json': return json(record.roleBasis)
    case 'trend_json': return json(record.trend)
    case 'placement_json': return json(record.placement)
    case 'placement_slot': return record.placement?.slot ?? null
    default: {
      const key = camel(column)
      if (record[key] !== undefined) return record[key] ?? null
      return record[column] ?? null
    }
  }
}

/** `ad_rows` → `adRows`. */
function camel(column) {
  return String(column).replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase())
}

/* ───────────────────────────── queries ───────────────────────────── */

/** Filters a caller may use, mapped to SQL. Kept next to the schema it reads. */
export function queryMaster(store, filters = {}) {
  const where = []
  const params = []

  if (filters.marketplace) { where.push('m.marketplace = ?'); params.push(String(filters.marketplace).toUpperCase()) }
  if (filters.productLine) { where.push('m.product_line = ?'); params.push(String(filters.productLine)) }
  if (filters.funnel) { where.push('m.funnel = ?'); params.push(String(filters.funnel).toUpperCase()) }
  if (filters.svTier) { where.push('m.sv_tier = ?'); params.push(String(filters.svTier).toUpperCase()) }
  if (filters.priority) { where.push('m.priority = ?'); params.push(String(filters.priority).toUpperCase()) }
  if (filters.opportunity) { where.push('m.opportunity = ?'); params.push(String(filters.opportunity).toLowerCase()) }
  if (filters.ownStatus) { where.push('m.own_status = ?'); params.push(String(filters.ownStatus).toLowerCase()) }
  // Folded for the same reason as in `queryKeywords`: the store holds folded
  // keywords, and `LIKE` here is case-sensitive.
  if (filters.q) { where.push('m.keyword LIKE ?'); params.push(`%${keywordKey(filters.q)}%`) }
  if (filters.source) { where.push('m.sources_json LIKE ?'); params.push(`%${String(filters.source)}%`) }
  if (filters.hasAba !== undefined) { where.push('m.has_aba = ?'); params.push(filters.hasAba ? 1 : 0) }
  if (filters.hasAd !== undefined) { where.push('m.has_ad = ?'); params.push(filters.hasAd ? 1 : 0) }
  if (filters.hasCompetitor !== undefined) { where.push('m.has_competitor = ?'); params.push(filters.hasCompetitor ? 1 : 0) }
  if (filters.minVolume !== undefined && filters.minVolume !== null) {
    where.push('m.search_volume IS NOT NULL AND m.search_volume >= ?')
    params.push(Number(filters.minVolume))
  }
  if (filters.maxVolume !== undefined && filters.maxVolume !== null) {
    where.push('m.search_volume IS NOT NULL AND m.search_volume <= ?')
    params.push(Number(filters.maxVolume))
  }
  if (filters.forListing) {
    where.push(`json_extract(m.for_listing_json, '$.${String(filters.forListing)}') = 1`)
  }
  /* 模块 08 F08-07：按生命周期状态筛。状态住在 keyword_lifecycle（独立于这张表 ——
     见 schema v33 的注释），所以这里用子查询而不是 JOIN：`SELECT m.*` 的列集合不该
     因为多了一个筛选条件而改变。一个不存在的状态会筛出空列表，与既有的 svTier 筛选
     同一行为。 */
  if (filters.lifecycleStatus) {
    where.push(`(SELECT l.status FROM keyword_lifecycle l
                  WHERE l.keyword = m.keyword AND l.marketplace = m.marketplace) = ?`)
    params.push(String(filters.lifecycleStatus))
  }

  const order = {
    volume: 'm.search_volume IS NULL, m.search_volume DESC, m.keyword ASC',
    updated: 'm.updated_at DESC, m.keyword ASC',
    keyword: 'm.keyword ASC',
    priority: `m.priority IS NULL, m.priority ASC, m.search_volume IS NULL, m.search_volume DESC`,
    opportunity: `CASE m.opportunity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, m.search_volume IS NULL, m.search_volume DESC`,
    spend: 'm.spend DESC, m.keyword ASC',
    orders: 'm.orders DESC, m.keyword ASC',
    competitors: 'm.competitor_ranked_count DESC, m.keyword ASC',
  }[filters.order] ?? 'm.search_volume IS NULL, m.search_volume DESC, m.keyword ASC'

  const limit = clamp(filters.limit ?? 50, 1, 1000)
  const offset = clamp(filters.offset ?? 0, 0, 1_000_000)

  const rows = store.all(
    `SELECT m.*,
            /* 生命周期状态：与这张表分开存（每次重算会整层重建 kw_master），所以在这里
               按主键子查询取回来。没有记录时是 NULL —— 调用方据此显示「未设置」，而不是
               把它当成 candidate。 */
            (SELECT l.status FROM keyword_lifecycle l
              WHERE l.keyword = m.keyword AND l.marketplace = m.marketplace) AS lifecycle_status
       FROM kw_master m
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )
  const total = Number(store.get(
    `SELECT COUNT(*) AS n FROM kw_master m ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  )?.n ?? 0)

  return { rows: rows.map(hydrateMaster), total, limit, offset }
}

export function getMaster(store, keyword, marketplace) {
  // Folded on the way in, for the same reason `keywordKey` folds on the way out:
  // the caller's spelling is not the stored one. A lookup for `B002VNJF8W` has to
  // find the row now stored as `b002vnjf8w`, or the fold would have traded a
  // duplicate for a miss.
  const row = store.get(
    'SELECT * FROM kw_master WHERE keyword = ? AND marketplace = ?',
    [keywordKey(keyword), String(marketplace ?? '').trim().toUpperCase()],
  )
  return row === undefined ? null : hydrateMaster(row)
}

/** Parse the `_json` columns back into values, once, at the read boundary. */
export function hydrateMaster(row) {
  if (row === null || row === undefined) return row
  return {
    ...row,
    productLines: parseJson(row.product_lines_json, []),
    sources: parseJson(row.sources_json, []),
    adPeriods: parseJson(row.ad_periods_json, []),
    adMatchTypes: parseJson(row.ad_match_types_json, []),
    adAsins: parseJson(row.ad_asins_json, []),
    modifiers: parseJson(row.modifiers_json, []),
    competitorAsins: parseJson(row.competitor_asins_json, []),
    competitorTags: parseJson(row.competitor_tags_json, []),
    competitorSources: parseJson(row.competitor_sources_json, []),
    competitorRanked: parseJson(row.competitor_ranked_json, []),
    forListing: parseJson(row.for_listing_json, {}),
    /* 角色：判定依据一并带出来，页面与导出才能回答"凭什么这么判"。 */
    role: row.role ?? null,
    roleBasis: parseJson(row.role_basis_json, null),
    trend: parseJson(row.trend_json, null),
    placement: parseJson(row.placement_json, null),
    hasAba: row.has_aba === 1,
    hasAd: row.has_ad === 1,
    hasCompetitor: row.has_competitor === 1,
    listed: row.listed === 1,
    svTierKnown: row.sv_tier_known === 1,
  }
}

/**
 * Library totals, grouped the ways the page and the report show them.
 *
 * `count(extra)` rather than a pile of ternaries: the marketplace scope is
 * optional, so every statement needs a `WHERE` when it is absent and an `AND`
 * when it is not, and getting that wrong in one of fifteen strings is exactly
 * the kind of mistake that produces a `SQLITE_ERROR` in production and nowhere
 * else.
 */
export function masterStats(store, { marketplace = null } = {}) {
  const market = marketplace === null ? null : String(marketplace).toUpperCase()
  const params = market === null ? [] : [market]
  const where = extra => `WHERE ${market === null ? '' : 'marketplace = ? AND '}${extra}`
  const count = extra => Number(store.get(`SELECT COUNT(*) AS n FROM kw_master ${where(extra)}`, params)?.n ?? 0)
  const sum = column => Number(store.get(`SELECT SUM(${column}) AS n FROM kw_master ${where('1 = 1')}`, params)?.n ?? 0)
  const group = column => store.all(
    `SELECT ${column} AS key, COUNT(*) AS n, SUM(COALESCE(search_volume, 0)) AS volume
       FROM kw_master ${where(`${column} IS NOT NULL`)}
      GROUP BY ${column} ORDER BY n DESC`,
    params,
  )

  return {
    marketplace: market,
    total: count('1 = 1'),
    withAba: count('has_aba = 1'),
    withAd: count('has_ad = 1'),
    withCompetitor: count('has_competitor = 1'),
    withVolume: count('search_volume IS NOT NULL'),
    withoutVolume: count('search_volume IS NULL'),
    // The words the library knows about only because someone listed them —
    // no volume, no ads, no competitor data. They are the honest measure of
    // "how much of this library is actually sourced".
    listedOnly: count("sources_json = '[\"manual\"]'"),
    // `product_line_matched IS NULL` means no signal word fired and the line is
    // only the default. Reporting the default line's total without this number
    // makes 19,005 "bench-cushion" words look like a product line when most of
    // them are words nobody classified — see `detectProductLine`.
    productLineDefaulted: count('product_line_matched IS NULL'),
    totalSpend: sum('spend'),
    totalSales: sum('sales'),
    totalImpressions: sum('impressions'),
    totalClicks: sum('clicks'),
    totalOrders: sum('orders'),
    byProductLine: group('product_line'),
    byFunnel: group('funnel'),
    bySvTier: group('sv_tier'),
    byPriority: group('priority'),
    byOpportunity: group('opportunity'),
    byOwnStatus: group('own_status'),
    imports: store.all(
      /* **显式列清单，加列时最容易忘的那一处。** 这是本文件里唯一一条不用 `SELECT *`
         的 `kw_import` 查询（其余三条都是 `SELECT *`，新列自动带出），所以只有它会漏。
         2026-10-25 已经栽过一次同形状的事故：`/api/state` 的月度花费 SELECT 漏了
         `spend_missing`/`sales_missing`，于是缺失标记在线上永远不响（函数级正确、线上不生效）。
         `rows_read_missing`（v68）必须在这里，否则页面与总库报告永远看不到「未记录」。 */
      `SELECT id, kind, file_name, marketplace, period, granularity, rows_read, rows_read_missing, facts_written,
              status, included, imported_at
         FROM kw_import ${where('1 = 1')} ORDER BY imported_at DESC LIMIT 50`,
      params,
    ),
    overlaps: findOverlaps(store, market),
  }
}

/* ─────────────────────────── competitor sets ─────────────────────────── */

/**
 * A competitor ASIN list, canonicalised: upper case, trimmed, de-duplicated,
 * sorted.
 *
 * All four steps are load-bearing, and the last one is the one that looks like
 * fussiness. Writing the same list twice has to produce the **same string**:
 * the page decides whether to enable its save button by comparing what is in
 * the form against what came back from the server, so a set that re-orders
 * itself on every save would show unsaved changes forever. Sorting is what
 * makes the comparison mean "the members are the same" rather than "the members
 * arrived in the same order", which is not something the user controls.
 *
 * Invalid entries are rejected rather than dropped. A silently ignored ASIN is
 * a competitor that is not being compared and nothing says so.
 */
export function normalizeAsinList(value) {
  const list = Array.isArray(value) ? value : []
  const seen = new Set()
  for (const entry of list) {
    const asin = String(entry ?? '').trim().toUpperCase()
    if (asin === '') continue
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN "${entry}" in the competitor list (expected 10 letters/digits)`)
    seen.add(asin)
  }
  return [...seen].sort()
}

/** Create or replace a named competitor set. `id` omitted → a new one. */
export function upsertCompetitorSet(store, record = {}) {
  const id = String(record.id ?? '').trim() || randomUUID()
  const name = String(record.name ?? '').trim()
  if (name === '') throw new Error('competitor set needs a name')
  const marketplace = String(record.marketplace ?? '').trim().toUpperCase()
  if (marketplace === '') throw new Error('competitor set needs a marketplace')
  const asins = normalizeAsinList(record.asins)
  if (asins.length === 0) throw new Error('competitor set needs at least one ASIN')

  store.run(
    `INSERT INTO competitor_set (id, name, marketplace, asins_json, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       marketplace = excluded.marketplace,
       asins_json = excluded.asins_json,
       note = excluded.note,
       updated_at = excluded.updated_at`,
    [id, name, marketplace, JSON.stringify(asins), record.note ?? null, nowIso()],
  )
  const saved = getCompetitorSet(store, id)
  /* A competitor set is a mutable object: the row above is overwritten in place,
     so a pointer would quietly follow the next edit and "the set this run
     compared against" would stop being answerable. The body is frozen — the
     same call the v25 backfill made for every set it found. */
  registerSnapshot(store, {
    objectType: 'competitor_set',
    objectId: saved.id,
    payload: saved,
  })
  return saved
}

export function getCompetitorSet(store, id) {
  const row = store.get('SELECT * FROM competitor_set WHERE id = ?', [String(id ?? '')])
  return row === undefined ? null : hydrateCompetitorSet(row)
}

export function listCompetitorSets(store, { marketplace = null, limit = 50 } = {}) {
  const market = marketplace === null || marketplace === undefined || marketplace === ''
    ? null
    : String(marketplace).toUpperCase()
  return store
    .all(
      `SELECT * FROM competitor_set ${market === null ? '' : 'WHERE marketplace = ?'}
        ORDER BY updated_at DESC LIMIT ?`,
      market === null ? [clamp(limit, 1, 200)] : [market, clamp(limit, 1, 200)],
    )
    .map(hydrateCompetitorSet)
}

export function hydrateCompetitorSet(row) {
  return { ...row, asins: parseJson(row.asins_json, []) }
}

/* ──────────────────────────── competitor reads ──────────────────────────── */

/**
 * The raw material for a "us vs them" comparison, read but not judged.
 *
 * This function only fetches. Deciding what the numbers *mean* — whether a
 * missing rank is "absent" or "never measured", where a search volume came
 * from, which list a word belongs in — is a judgement, and it lives in
 * `domain/keywords/competitor.js`. Keeping the split means the classification
 * can be tested against hand-written rows with no database at all, which is
 * where the interesting cases are.
 *
 * Our own ASIN is removed from the competitor side if it appears there, and
 * `excludedSelf` says so. It does appear in practice — one of the three tracked
 * ASINs is in `kw_competitor_fact` with 87 rows from 卖家精灵 — and comparing an
 * ASIN against itself would report every word we hold as "theirs too", quietly.
 *
 * @returns {{
 *   asin: string, marketplace: string, peers: string[], excludedSelf: boolean,
 *   ours: Map<string, {rank: number|null, scanDepth: number|null, searchVolume: number|null}>,
 *   theirs: Map<string, {bestRank: number|null, rankedCount: number, presentCount: number,
 *                        monthlyVolume: number|null, weeklySearches: number|null, asins: string[]}>,
 *   volumes: Map<string, number|null>,
 * }}
 */
export function readCompetitorSides(store, { asin, marketplace, competitors } = {}) {
  const ourAsin = String(asin ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(ourAsin)) throw new Error(`invalid ASIN "${asin}" (expected 10 letters/digits)`)
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (market === '') throw new Error('marketplace is required')

  const requested = normalizeAsinList(competitors)
  const peers = requested.filter(peer => peer !== ourAsin)
  const excludedSelf = peers.length !== requested.length

  /* Our side: what the browser actually measured. `scan_depth` is what separates
     "measured and absent" from "measured with no depth recorded" — a null rank
     with no depth cannot support the claim "we are absent". */
  const ours = new Map()
  for (const row of store.all(
    `SELECT keyword, rank, scan_depth, search_volume FROM asin_keyword
      WHERE asin = ? AND marketplace = ?`,
    [ourAsin, market],
  )) {
    // One ASIN can have rows from several sources; keep the best rank and the
    // first non-null depth rather than letting row order decide.
    const previous = ours.get(row.keyword)
    ours.set(row.keyword, {
      rank: bestOf(previous?.rank, row.rank),
      scanDepth: previous?.scanDepth ?? row.scan_depth ?? null,
      searchVolume: previous?.searchVolume ?? row.search_volume ?? null,
    })
  }

  /* Their side, grouped per keyword. `ranked_count` counts ASINs that actually
     hold a rank — a competitor with a row and `organic_no_rank = 1` appears for
     the word but does not rank for it, and counting it would inflate the "3/3"
     the page shows. `present_count` keeps that distinction visible. */
  const theirs = new Map()
  if (peers.length > 0) {
    for (const row of store.all(
      `SELECT c.keyword AS keyword,
              MIN(CASE WHEN c.organic_rank IS NOT NULL THEN c.organic_rank END) AS best_rank,
              COUNT(DISTINCT CASE WHEN c.organic_rank IS NOT NULL THEN c.asin END) AS ranked_count,
              COUNT(DISTINCT c.asin) AS present_count,
              MAX(c.monthly_volume) AS monthly_volume,
              MAX(c.weekly_searches) AS weekly_searches,
              GROUP_CONCAT(DISTINCT c.asin) AS asin_list
         FROM kw_competitor_fact c
        WHERE c.marketplace = ? AND c.asin IN (${peers.map(() => '?').join(',')})
        GROUP BY c.keyword`,
      [market, ...peers],
    )) {
      theirs.set(row.keyword, {
        bestRank: row.best_rank ?? null,
        rankedCount: Number(row.ranked_count ?? 0),
        presentCount: Number(row.present_count ?? 0),
        monthlyVolume: row.monthly_volume ?? null,
        weeklySearches: row.weekly_searches ?? null,
        asins: String(row.asin_list ?? '').split(',').filter(Boolean).sort(),
      })
    }
  }

  return {
    asin: ourAsin,
    marketplace: market,
    peers,
    excludedSelf,
    ours,
    theirs,
    volumes: masterVolumes(store, market, [...new Set([...theirs.keys(), ...ours.keys()])]),
  }
}

/** `null` loses to any number; two numbers keep the smaller (better) rank. */
function bestOf(a, b) {
  const left = a ?? null
  const right = b ?? null
  if (left === null) return right
  if (right === null) return left
  return Math.min(left, right)
}

/** Master volumes for a keyword set, chunked to stay inside SQLite's bind limit. */
function masterVolumes(store, marketplace, keywords) {
  const map = new Map()
  if (keywords.length === 0) return map
  for (let i = 0; i < keywords.length; i += 500) {
    const chunk = keywords.slice(i, i + 500)
    for (const row of store.all(
      `SELECT keyword, search_volume FROM kw_master
        WHERE marketplace = ? AND keyword IN (${chunk.map(() => '?').join(',')})`,
      [marketplace, ...chunk],
    )) map.set(row.keyword, row.search_volume)
  }
  return map
}

/* ──────────────────────────── research reads ──────────────────────────── */

/**
 * Escape a user-typed substring for a `LIKE` pattern.
 *
 * `%` and `_` are wildcards in `LIKE`, so a seed containing either would match
 * far more than the user asked for — and silently, because the result is a
 * longer list, not an error. `_` is not hypothetical: ASIN-shaped and
 * model-number-shaped seeds are exactly the kind of thing typed here.
 */
function likePattern(value) {
  return `%${keywordKey(value).replace(/[\\%_]/g, ch => `\\${ch}`)}%`
}

/**
 * Library words related to one seed — the "库内已有" source of a research run.
 *
 * One seed per call, not a list, because every row comes back tagged with the
 * seed that matched it. A batch call would have to invent that tag, and the tag
 * is load-bearing: it is what lets the caller say "this seed produced nothing"
 * as opposed to "this seed is missing from the list" — and with a list of seeds
 * and one `OR`ed `LIKE` there is no way to tell which pattern matched.
 *
 * "Related" is a substring match on the seed, which is a rule the user can
 * predict and verify by typing it into the library search box. Anything cleverer
 * (stemming, embedding distance) would be a relevance judgement presented as a
 * lookup, and the candidate list is where the user decides relevance, not here.
 *
 * `kw_master` is joined rather than read instead, because the master rollup is
 * the one that carries the rollup's own `search_volume`; a word can exist in
 * `keyword` (we track it) without a master row (nothing has been imported about
 * it), and in that case it is still "already in the library".
 */
export function readResearchLibrary(store, { marketplace, seed, limit = 300 } = {}) {
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (market === '') throw new Error('marketplace is required')
  const pattern = likePattern(seed)
  if (pattern === '%%') return []

  return store.all(
    `SELECT k.keyword,
            k.tier,
            k.search_volume,
            k.difficulty,
            m.search_volume AS master_volume
       FROM keyword k
       LEFT JOIN kw_master m ON m.keyword = k.keyword AND m.marketplace = k.marketplace
      WHERE k.marketplace = ? AND k.keyword LIKE ? ESCAPE '\\'
      ORDER BY k.keyword ASC
      LIMIT ?`,
    [market, pattern, clamp(limit, 1, 2000)],
  ).map(row => ({
    seed: String(seed ?? '').trim(),
    keyword: row.keyword,
    tier: row.tier ?? null,
    // Our own measured volume wins over the rollup's, for the same reason
    // `competitor.js` prefers `measured`: it is the more direct measurement.
    searchVolume: row.search_volume ?? row.master_volume ?? null,
    difficulty: row.difficulty ?? null,
  }))
}

/**
 * Competitor words related to one seed — the "竞品反查" source.
 *
 * Reads `kw_competitor_fact` and **only** that. It does not collect, does not
 * open a browser and does not call the collector: the fact table is filled by
 * the existing importer, and a research run that quietly started a scrape would
 * be a side effect the user cannot see (§7 of the architecture).
 *
 * Grouped per keyword across every competitor ASIN present in the table, so
 * "3/7 有排名" means what the page says it means. `bestRank` is `null` — never
 * `0` — when nobody holds a rank, because a best rank of 0 reads as "ranked
 * first".
 */
export function readResearchCompetitor(store, { marketplace, seed, limit = 300 } = {}) {
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (market === '') throw new Error('marketplace is required')
  const pattern = likePattern(seed)
  if (pattern === '%%') return []

  // The denominator for "3/7": every competitor ASIN the library knows about in
  // this marketplace. Reported so the ratio is readable without a second call.
  const total = store.get(
    'SELECT COUNT(DISTINCT asin) AS n FROM kw_competitor_fact WHERE marketplace = ?',
    [market],
  )?.n ?? 0

  return store.all(
    `SELECT c.keyword AS keyword,
            MIN(CASE WHEN c.organic_rank IS NOT NULL THEN c.organic_rank END) AS best_rank,
            COUNT(DISTINCT CASE WHEN c.organic_rank IS NOT NULL THEN c.asin END) AS ranked_count,
            COUNT(DISTINCT c.asin) AS present_count,
            MAX(c.monthly_volume) AS monthly_volume,
            GROUP_CONCAT(DISTINCT c.asin) AS asin_list
       FROM kw_competitor_fact c
      WHERE c.marketplace = ? AND c.keyword LIKE ? ESCAPE '\\'
      GROUP BY c.keyword
      ORDER BY c.keyword ASC
      LIMIT ?`,
    [market, pattern, clamp(limit, 1, 2000)],
  ).map(row => ({
    seed: String(seed ?? '').trim(),
    keyword: row.keyword,
    searchVolume: row.monthly_volume ?? null,
    bestRank: row.best_rank ?? null,
    rankedCount: Number(row.ranked_count ?? 0),
    presentCount: Number(row.present_count ?? 0),
    total,
    asins: String(row.asin_list ?? '').split(',').filter(Boolean).sort(),
  }))
}

/**
 * Which of these exact keywords are already in the library.
 *
 * Deliberately **not** the same thing as `readResearchLibrary`. That one is a
 * *source*: it finds library words related to a seed by substring, which is how
 * "here are words we already track around this seed" is answered. This one is a
 * *fact about a candidate*: is this exact word already ours?
 *
 * The two are not interchangeable, and using the first for the second was a real
 * bug. A candidate that arrived from Amazon's dropdown ("speaker stand") is not
 * a substring match for the seed that produced it ("bluetooth speaker"), so the
 * substring read never returned it — and the candidate was reported as `fresh`
 * and offered for import while the library already held it at T2. Checking
 * membership by exact keyword is the only way that answer can be right, whatever
 * route the candidate took to get here.
 *
 * Returns a `Map` keyed by the stored (folded) keyword, so the caller's lookup is
 * `map.get(keywordKey(candidate))` and cannot accidentally compare case.
 */
export function readLibraryMembership(store, { marketplace, keywords } = {}) {
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (market === '') throw new Error('marketplace is required')

  const wanted = [...new Set((keywords ?? []).map(word => keywordKey(word)).filter(word => word !== ''))]
  const map = new Map()
  // Chunked: SQLite's default bind limit is 999, and a research run can easily
  // produce more candidates than that.
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500)
    for (const row of store.all(
      `SELECT k.keyword,
              k.tier,
              k.search_volume,
              k.difficulty,
              m.search_volume AS master_volume
         FROM keyword k
         LEFT JOIN kw_master m ON m.keyword = k.keyword AND m.marketplace = k.marketplace
        WHERE k.marketplace = ? AND k.keyword IN (${chunk.map(() => '?').join(',')})`,
      [market, ...chunk],
    )) {
      map.set(row.keyword, {
        tier: row.tier ?? null,
        searchVolume: row.search_volume ?? row.master_volume ?? null,
        difficulty: row.difficulty ?? null,
      })
    }
  }
  return map
}

/* ───────────────────────────── helpers ───────────────────────────── */

/* The canonical spelling lives in `domain/keywords/key.js` — it is a keyword
   concept, and both `store/queries.js` and `domain/keywords/importers.js` need
   it without either depending on the other. Re-exported here because this module
   was its home before B05.1 and callers still import it from here. */
export { keywordKey, normalizeKeyword } from '../domain/keywords/key.js'

/**
 * The merge key — the identity used when deciding two keywords are one word.
 *
 * **After v15 this is the same fold as `keywordKey`, applied a second time.**
 * That is not a bug and not redundancy to tidy away: the write path now stores
 * folded words, so folding again is a no-op, and the callers that need a single
 * notion of sameness (`amzn_optimize_prepare`'s `keywords` input filter, and the
 * `measured`/`master` merge) keep getting it from one function instead of each
 * writing its own comparison.
 *
 * The history matters, because it is the reason the fold direction is fixed.
 * While the write path kept case, this key had to be the *insensitive* one: a
 * case-sensitive merge key would have made `Wireless Mouse` and `wireless mouse`
 * two words, both entering the data package, and "the measured row wins" would
 * have failed silently. Insensitivity is safe in that direction — sensitive
 * equality implies insensitive equality, so this key can only join *more*, never
 * fewer. Folding the write path does not change that reasoning; it removes the
 * asymmetry it was compensating for.
 *
 * **Do not make this case-sensitive.** With the store folded it would still be
 * correct for stored data, but it would break for anything handed in from
 * outside (a pasted keyword list, a filename), which is exactly where the mixed
 * case comes from. See ARCHITECTURE §7.1-E4 决定 D1.
 */
export function mergeKey(keyword, marketplace) {
  return `${keywordKey(keyword)}|${String(marketplace ?? '').trim().toUpperCase()}`
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
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

/**
 * `null`/`undefined`/`''` → null. **Not** via `Number()` alone.
 *
 * `Number(null)` is `0` and `Number('')` is `0`, so a guard written as
 * `Number.isFinite(Number(v)) ? Number(v) : null` maps "no value" to a real
 * zero. On the way in that turned 西柚's empty 月搜索量 into a search volume of
 * 0, which then became `search_volume_source: 'competitor-monthly'` on three
 * words nobody had a volume for — a number that looked sourced.
 */
function int(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : null
}

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(Math.trunc(n), min), max)
}

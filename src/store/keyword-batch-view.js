/**
 * 批次视图（FR-M6-03）：**哪一次导入带来了这个词**。
 *
 * ## 批次标识是既有的，没有新造列
 *
 * 本仓已经有一个够用的批次标识：**一次导入 = 一行 `kw_import`**（`kind` / `period` /
 * `marketplace` / `imported_at` / `file_path` / `file_name`）。三张事实表的
 * `source_file` 就是那次导入的 `kw_import.file_path` —— 实库实测，`kw_aba_fact` /
 * `kw_ad_fact` / `kw_competitor_fact` 的 `source_file` 对 `kw_import.file_path`
 * **未匹配数都是 0**。所以「词 → 批次」是一次 join，不是一次迁移。
 *
 * 反过来有一条必须说清的空：`keyword.source_file`（旧的手工词表）在实库**全为 NULL**，
 * 而 `kw_master` 里确实有词**一条事实都没有**。那些词的批次是**未知**，不是「批次 0」，
 * 也不能给它编一个「默认批次」—— 那是拿一个看起来像批次的列冒充事实。
 *
 * ## `period` 不是统一月格式，所以这个视图不折算自然月
 *
 * 实存的 `period` 至少有五种形状：`2025-Q1`（季度）/ `2026-01`（月）/
 * `202603`（月，另一种写法）/ `20260101-20260415`（区间）/ `202606-202607`（跨月区间）。
 * 把区间折成月份要么挑一个端点是猜，要么把区间说成一个月是错的。所以：
 *
 *   - 筛选器列的是**实际存在的 period 原值**，不解析、不合并；
 *   - 批次列原样显示 `period + kind + imported_at`；
 *   - 界面上写死一句话说明这件事（限制写在界面上，比写在报告里有用）。
 *
 * 因此本视图的名字是「**批次视图（期间标签分组）**」，不是「月批次」。
 *
 * ## 行与列
 *
 * 行 = 选中那次导入带来的词（可再按词搜索）。列里的「批次」是这个词的**全部批次**：
 * 同一个词常常来自多个文件（ABA 一个、广告三四个、竞品若干），只显示「一个批次」
 * 会让人以为一个词只属于一份文件。
 */

import { keywordKey } from '../domain/keywords/key.js'

/** `period` 的实存形状。页面拿它写那句限制，不在这里二次解释。 */
export const PERIOD_SHAPE_NOTE =
  'period 有五种实际形状（季度 2025-Q1 / 月 2026-01 / 月 202603 / 区间 20260101-20260415 / 跨月 202606-202607），'
  + '本视图按原样分组显示，不折算自然月。'

function marketOf(value) {
  const text = String(value ?? '').trim()
  return text === '' ? null : text.toUpperCase()
}

/**
 * 全部批次的清单 —— 筛选器的选项。
 *
 * `words` 是这次导入带来的词数（按 keyword 去重，跨三张事实表）。它让「选哪一次导入」
 * 不是一个凭文件名猜的选择。
 */
export function listKeywordBatches(store, { marketplace = null, limit = 200 } = {}) {
  const market = marketOf(marketplace)
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500)
  const rows = store.all(
    `SELECT id, kind, source_id, file_name, file_path, marketplace, period, granularity,
            rows_read, rows_read_missing, facts_written, status, included, imported_at
       FROM kw_import
      ${market === null ? '' : 'WHERE marketplace = ?'}
      ORDER BY imported_at DESC, period DESC
      LIMIT ?`,
    market === null ? [cap] : [market, cap],
  )
  /* 每次导入带来的词数：一条聚合，不是每行一次查询。 */
  const counts = new Map(
    store.all(
      `SELECT source_file, COUNT(DISTINCT keyword) AS n FROM (
         SELECT keyword, source_file FROM kw_aba_fact
         UNION ALL SELECT keyword, source_file FROM kw_ad_fact
         UNION ALL SELECT keyword, source_file FROM kw_competitor_fact)
        GROUP BY source_file`,
    ).map(row => [row.source_file, Number(row.n ?? 0)]),
  )
  return rows.map(row => ({ ...row, words: counts.get(row.file_path) ?? 0 }))
}

/** 一次导入的元信息，或者抛 —— 未知的 importId 不许变成一个空视图。 */
function batchOf(store, importId) {
  const id = String(importId ?? '').trim()
  if (id === '') throw new Error('importId is required — a batch view without a batch is not a batch view')
  const row = store.get('SELECT * FROM kw_import WHERE id = ?', [id])
  if (row === undefined) throw new Error(`no import ${id} — refusing to draw a batch that does not exist`)
  return row
}

/**
 * 一个词的全部批次 —— `Map<keyword, { count, periods, latest }>`。
 *
 * 只查这一页的词（`IN (?, …)`），走三张事实表各自的 `keyword` 索引。全库 3 万词一次
 * 聚合要 330ms（实测），而一页 100 词是 1ms 级 —— 页面上每一行都要的列不能按全库算。
 */
export function keywordBatchTags(store, { keywords = [], marketplace } = {}) {
  const market = marketOf(marketplace)
  const words = [...new Set((Array.isArray(keywords) ? keywords : []).map(entry => keywordKey(entry)).filter(entry => entry !== ''))]
  const tags = new Map()
  if (words.length === 0 || market === null) return tags
  const placeholders = words.map(() => '?').join(', ')
  const rows = store.all(
    `SELECT f.keyword, i.id AS import_id, i.period, i.kind, i.imported_at, i.file_name
       FROM (SELECT keyword, marketplace, source_file FROM kw_aba_fact WHERE marketplace = ? AND keyword IN (${placeholders})
             UNION ALL
             SELECT keyword, marketplace, source_file FROM kw_ad_fact WHERE marketplace = ? AND keyword IN (${placeholders})
             UNION ALL
             SELECT keyword, marketplace, source_file FROM kw_competitor_fact WHERE marketplace = ? AND keyword IN (${placeholders})) f
       JOIN kw_import i ON i.file_path = f.source_file`,
    [market, ...words, market, ...words, market, ...words],
  )
  for (const row of rows) {
    const entry = tags.get(row.keyword) ?? { count: 0, periods: [], latest: null }
    /* 同一次导入在三张事实表里可能各出现一次 —— 批次是 **import**，不是事实行。 */
    if (!entry.periods.includes(row.period)) entry.periods.push(row.period)
    /* 比较的是**对象里的键**（camelCase），不是 SQL 列的拼写。写成 `imported_at` 时
       取到的是 undefined，字符串比较永远为 false —— 于是「最近批次」永远停在第一行
       （t80 ⑤ 抓到的就是这个：latest 停在 2026-01 而不是 2026-03）。 */
    if (entry.latest === null || String(row.imported_at) > String(entry.latest.importedAt)) {
      entry.latest = { importId: row.import_id, period: row.period, kind: row.kind, importedAt: row.imported_at, fileName: row.file_name }
    }
    tags.set(row.keyword, entry)
  }
  for (const entry of tags.values()) {
    entry.count = entry.periods.length
    entry.periods = entry.periods.slice().sort()
  }
  return tags
}

/**
 * 一次导入的词表（服务端分页）。
 *
 * 行集由 `kw_master` 收口：事实表里有、但总库里没有的词不进这张表 —— 这个视图是
 * 「关键词总库按批次看」，不是「原始事实行列表」。
 *
 * @returns {{ batch: object, rows: Array, total: number, limit: number, offset: number,
 *             periodNote: string }}
 */
export function keywordBatchView(store, { importId, q = null, limit = 100, offset = 0 } = {}) {
  const batch = batchOf(store, importId)
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const skip = Math.min(Math.max(Number(offset) || 0, 0), 1_000_000)
  const market = String(batch.marketplace ?? '').trim().toUpperCase()

  const where = ['m.marketplace = ?', `m.keyword IN (
      SELECT keyword FROM kw_aba_fact WHERE source_file = ?
      UNION SELECT keyword FROM kw_ad_fact WHERE source_file = ?
      UNION SELECT keyword FROM kw_competitor_fact WHERE source_file = ?)`]
  const params = [market, batch.file_path, batch.file_path, batch.file_path]
  if (q !== null && q !== undefined && String(q).trim() !== '') {
    where.push('m.keyword LIKE ?')
    params.push(`%${keywordKey(q)}%`)
  }

  const total = Number(store.get(
    `SELECT COUNT(*) AS n FROM kw_master m WHERE ${where.join(' AND ')}`,
    params,
  )?.n ?? 0)

  const rows = store.all(
    `SELECT m.keyword, m.marketplace, m.search_volume, m.sv_tier, m.product_line, m.product_line_matched
       FROM kw_master m
      WHERE ${where.join(' AND ')}
      ORDER BY m.keyword ASC
      LIMIT ? OFFSET ?`,
    [...params, cap, skip],
  )
  const tags = keywordBatchTags(store, { keywords: rows.map(row => row.keyword), marketplace: market })

  return {
    batch: {
      id: batch.id,
      kind: batch.kind,
      period: batch.period,
      marketplace: batch.marketplace,
      fileName: batch.file_name,
      importedAt: batch.imported_at,
      rowsRead: batch.rows_read,
      rowsReadMissing: batch.rows_read_missing === 1,
      factsWritten: batch.facts_written,
      included: batch.included === 1,
      granularity: batch.granularity,
    },
    rows: rows.map(row => ({
      keyword: row.keyword,
      marketplace: row.marketplace,
      searchVolume: row.search_volume,
      svTier: row.sv_tier,
      productLine: row.product_line,
      productLineUnclassified: row.product_line_matched === null || row.product_line_matched === undefined,
      /* 这个词的**全部**批次。没有批次（一条事实都没有）时是「批次未知」，不是 0。 */
      batch: tags.get(row.keyword) ?? null,
    })),
    total,
    limit: cap,
    offset: skip,
    periodNote: PERIOD_SHAPE_NOTE,
  }
}

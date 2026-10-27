/**
 * 店铺管理页的读模型（P2 / ADR-004）。
 *
 * **派生字段一律现算**：产品数、未采集、最近采集、竞品数都不落库 —— 它们是
 * `product_profile` / `asin_snapshot` / `asin_competitor` 的函数，存一份就会和
 * 事实漂开。成本按店算（一店几条聚合查询），只在 `shops` 模块下取；别的页面的
 * state 轮询不为它付费。
 *
 * 这里也是「未采集」四态唯一的算法：`never`（没有任何快照）/ `stale`（最新快照
 * 超过 freshnessDays）/ `fresh`（7 天内）/ `collecting`（有未结束任务包含该 ASIN）。
 * 页面只画，不重算。
 */
import { listBrands, listShops } from '../../store/shop.js'
import { listProfiles } from './product-import.js'

/**
 * T39 F3：给人/给路由共用的「这属于哪家归档店」判定。
 * `shopId` 直接命中优先；否则按目标 ASIN（或父 ASIN）反查 `product_profile`
 * 所属店铺。返回 `{ id, name }` 或 null。路由据此在写入前 409 SHOP_ARCHIVED。
 */
export function archivedShopFor(store, { shopId = null, asins = [], parentAsins = [], marketplace = 'US' } = {}) {
  const direct = String(shopId ?? '').trim()
  if (direct !== '') {
    const row = store.get('SELECT id, name FROM shop WHERE id = ? AND archived_at IS NOT NULL', [direct])
    if (row !== undefined) return row
  }
  for (const entry of asins) {
    const asin = String(entry?.asin ?? entry ?? '').trim().toUpperCase()
    if (asin === '') continue
    const market = String(entry?.marketplace ?? marketplace ?? 'US').trim().toUpperCase()
    const row = store.get(
      `SELECT DISTINCT s.id AS id, s.name AS name FROM product_profile p
         JOIN shop s ON s.id = p.shop_id
        WHERE p.asin = ? AND p.marketplace = ? AND s.archived_at IS NOT NULL LIMIT 1`,
      [asin, market],
    )
    if (row !== undefined) return row
  }
  for (const entry of parentAsins) {
    const parent = String(entry ?? '').trim().toUpperCase()
    if (parent === '') continue
    const row = store.get(
      `SELECT DISTINCT s.id AS id, s.name AS name FROM product_profile p
         JOIN shop s ON s.id = p.shop_id
        WHERE p.parent_asin = ? AND s.archived_at IS NOT NULL LIMIT 1`,
      [parent],
    )
    if (row !== undefined) return row
  }
  return null
}

export function shopsState(store, filters, workspaceId) {
  const includeArchived = filters?.shopsArchived === '1' || filters?.shopsArchived === true
  const shopQuery = String(filters?.shopQ ?? '').trim().toLowerCase()
  const allShops = listShops(store, workspaceId, { includeArchived: true })
  const rows = allShops.filter(shop => (includeArchived || shop.archivedAt === null)
    && (shopQuery === '' || shop.name.toLowerCase().includes(shopQuery)))
  /* CR-T60-1（T65）：已归档数**不受 includeArchived 影响** —— 计数行要在「含已归档」
     未勾选时也说得出「另有 X 家已归档」，否则「0 启用 → 看起来像从未建店」的误导还在
     （R2-03）。口径与 rows 同一把尺：同一个 workspace、同一个搜索词；只有
     includeArchived 这一层被绕开。页面拿它画计数行与空态，不在页面重算。 */
  const archivedCount = allShops.filter(shop => shop.archivedAt !== null
    && (shopQuery === '' || shop.name.toLowerCase().includes(shopQuery))).length
  const freshnessDays = 7
  const cutoff = new Date(Date.now() - freshnessDays * 24 * 60 * 60 * 1000).toISOString()
  const counter = (sql, params) => Number(store.get(sql, params)?.n ?? 0)
  const summarize = shop => ({
    ...shop,
    productCount: counter('SELECT COUNT(*) AS n FROM product_profile WHERE shop_id = ?', [shop.id]),
    brandCount: counter('SELECT COUNT(DISTINCT brand) AS n FROM product_profile WHERE shop_id = ?', [shop.id]),
    brandRuleCount: counter('SELECT COUNT(DISTINCT brand) AS n FROM shop_brand_rule WHERE shop_id = ?', [shop.id]),
    /* 已采集 = 最新快照在 7 天内；与 never/stale 互补，但单独算一次而不是
       用减法，避免 collecting 把数算丢。 */
    collectedCount: counter(
      `SELECT COUNT(*) AS n FROM product_profile p
        WHERE p.shop_id = ?
          AND (SELECT MAX(s.collected_at) FROM asin_snapshot s
                WHERE s.asin = p.asin AND s.marketplace = p.marketplace) >= ?`,
      [shop.id, cutoff],
    ),
    neverCount: counter(
      `SELECT COUNT(*) AS n FROM product_profile p
        WHERE p.shop_id = ?
          AND NOT EXISTS (SELECT 1 FROM asin_snapshot s WHERE s.asin = p.asin AND s.marketplace = p.marketplace)`,
      [shop.id],
    ),
    staleCount: counter(
      `SELECT COUNT(*) AS n FROM product_profile p
        WHERE p.shop_id = ?
          AND EXISTS (SELECT 1 FROM asin_snapshot s WHERE s.asin = p.asin AND s.marketplace = p.marketplace)
          AND (SELECT MAX(s2.collected_at) FROM asin_snapshot s2
                WHERE s2.asin = p.asin AND s2.marketplace = p.marketplace) < ?`,
      [shop.id, cutoff],
    ),
    lastCollectedAt: store.get(
      `SELECT MAX(s.collected_at) AS t FROM product_profile p
         JOIN asin_snapshot s ON s.asin = p.asin AND s.marketplace = p.marketplace
        WHERE p.shop_id = ?`,
      [shop.id],
    )?.t ?? null,
    competitorCount: counter(
      `SELECT COUNT(*) AS n FROM asin_competitor c
        WHERE c.status = 'active'
          AND c.parent_asin IN (SELECT DISTINCT parent_asin FROM product_profile WHERE shop_id = ?)`,
      [shop.id],
    ),
  })
  const shopRows = rows.map(summarize)
  const selectedId = String(filters?.shopId ?? '').trim()
  const selectedBase = selectedId === '' ? null : (allShops.find(shop => shop.id === selectedId) ?? null)
  if (selectedBase === null) {
    return {
      rows: shopRows, includeArchived, archivedCount, selected: null,
      products: null, allProductCount: 0, brandOptions: [], lineOptions: [],
      imports: null, brands: listBrands(store, workspaceId), parents: [],
      filters: {
        shopBrand: String(filters?.shopBrand ?? ''),
        shopLine: String(filters?.shopLine ?? ''),
        shopParent: String(filters?.shopParent ?? ''),
      },
      freshnessDays,
    }
  }
  const selected = summarize(selectedBase)
  const lineNames = new Map(store.all('SELECT id, name FROM product_line').map(row => [row.id, row.name]))
  const productRows = listProfiles(store, { shopId: selected.id, limit: 2000 })
    .map(row => {
      const latest = store.get(
        'SELECT MAX(collected_at) AS t FROM asin_snapshot WHERE asin = ? AND marketplace = ?',
        [row.asin, row.marketplace],
      )?.t ?? null
      const running = store.get(
        `SELECT 1 AS hit FROM collection_task
          WHERE status IN ('queued','checking_env','cooling_down','waiting_human','running')
            AND targets_json LIKE ? LIMIT 1`,
        [`%${row.asin}%`],
      ) !== undefined
      let collectState = 'no_data'
      if (running) collectState = 'collecting'
      else if (latest === null) collectState = 'never'
      else if (latest < cutoff) collectState = 'stale'
      else collectState = 'fresh'
      return {
        asin: row.asin,
        parentAsin: row.parent_asin,
        brand: row.brand,
        sku: row.sku ?? null,
        productName: row.product_name ?? null,
        productLineId: row.product_line_id ?? null,
        productLineName: row.product_line_id === null || row.product_line_id === undefined
          ? null
          : (lineNames.get(row.product_line_id) ?? row.product_line_id),
        marketplace: row.marketplace,
        sourceId: row.source_id,
        sourceFile: row.source_file,
        updatedAt: row.updated_at,
        lastCollectedAt: latest,
        collectState,
      }
    })
  const imports = store.all(
    `SELECT DISTINCT pi.* FROM product_import pi
       JOIN product_profile p ON p.source_file = pi.path
      WHERE p.shop_id = ?
      ORDER BY pi.imported_at DESC LIMIT 20`,
    [selected.id],
  )
  const parents = [...new Set(productRows.map(row => row.parentAsin).filter(value => value !== null && value !== ''))]
    .sort()
  /* G3/G5：品牌 / 产品线 / 父 ASIN 三个筛选。都是「包含」而不是精确，
     因为品牌与产品线在导入时可能是人写的长名字；空 = 不筛，不是「筛空」。 */
  const brandQuery = String(filters?.shopBrand ?? '').trim().toLowerCase()
  const lineQuery = String(filters?.shopLine ?? '').trim().toLowerCase()
  const parentQuery = String(filters?.shopParent ?? '').trim().toUpperCase()
  const filteredProducts = productRows.filter(row =>
    (brandQuery === '' || String(row.brand ?? '').toLowerCase().includes(brandQuery))
    && (lineQuery === '' || String(row.productLineName ?? row.productLineId ?? '').toLowerCase().includes(lineQuery))
    && (parentQuery === '' || String(row.parentAsin ?? '').toUpperCase().includes(parentQuery)))
  const brandOptions = [...new Set(productRows.map(row => row.brand).filter(value => value !== null && value !== ''))].sort()
  const lineOptions = [...new Map(productRows
    .filter(row => row.productLineId !== null && row.productLineId !== '')
    .map(row => [row.productLineId, { id: row.productLineId, name: row.productLineName ?? row.productLineId }])).values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return {
    rows: shopRows,
    includeArchived,
    archivedCount,
    selected,
    products: filteredProducts,
    allProductCount: productRows.length,
    brandOptions,
    lineOptions,
    imports,
    brands: listBrands(store, workspaceId),
    parents,
    filters: {
      shopBrand: String(filters?.shopBrand ?? ''),
      shopLine: String(filters?.shopLine ?? ''),
      shopParent: String(filters?.shopParent ?? ''),
    },
    freshnessDays,
  }
}

/**
 * 产品表导入（赛狐）—— 自有 ASIN 的**归属配置**。
 *
 * ## 为什么单独一层
 *
 * `asin` 是市场事实：同一个 ASIN 谁看都一样（标题、价格、BSR）。
 * 这张表记的是**我们的营业归属**：这家店、这个品牌、这个父体。
 * 混进 `asin` 里去，改归属就会动到事实。
 *
 * ## 键
 *
 * UNIQUE(shop_id, brand, parent_asin, asin)。四段缺一段就**不入库**，
 * 进待补清单 —— 配置表可以拒绝残缺，事实表不行。
 *
 * `brand` 在键里，所以它是必填。这也解释了为什么这份表要人补品牌：
 * 赛狐导出的「商品品牌」列实测 315 行全空。
 *
 * ## 品牌从哪来（三条，按优先级）
 *
 *   ① `shop_brand_rule` 命中（prefix / contains / regex）→ 标 `rule`
 *   ② 店铺默认品牌（`is_default = 1`）                 → 标 `default`
 *   ③ 都没有                                            → 空，标 `none`，进待补
 *
 * 规则不是猜：`ROFIEJOX` 是品牌，`Adirondack` 是品类词 —— 后者故意不建规则，
 * 让它落进待补清单等人确认，而不是被静默判成品牌。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { readFirstSheet } from '../keywords/xlsx.js'
import { nowIso } from '../../store/db.js'
import { getSetting } from '../../store/settings.js'

/** 赛狐产品表的列名（按表头名匹配，不按位置）。 */
export const PRODUCT_COLUMNS = {
  asin: ['ASIN'],
  parentAsin: ['父ASIN', '父 ASIN'],
  title: ['标题', '商品标题'],
  shop: ['店铺'],
  site: ['站点'],
  brand: ['商品品牌', '品牌'],
  msku: ['MSKU'],
  sku: ['SKU'],
  productName: ['品名'],
  productLine: ['产品线', '产品线名称', '产品线ID'],
  listedAt: ['上架时间'],
}

/** 站点中文 → 站点代码。表里写的是「美国」。 */
const SITE_CODE = {
  美国: 'US', 加拿大: 'CA', 墨西哥: 'MX', 英国: 'UK', 德国: 'DE',
  法国: 'FR', 意大利: 'IT', 西班牙: 'ES', 日本: 'JP', 澳大利亚: 'AU',
}

/** 默认目录：插件数据目录下的 imports/products（跟插件走，不写死盘符）。 */
export function defaultProductDir(dataDir) {
  return join(dataDir, 'imports', 'products')
}

/**
 * 解析产品表目录：设置里给了就用它，否则用默认。
 *
 * 返回的是**解析后的绝对路径**，不是配置值 —— 页面上要显示的就是它。
 */
export function resolveProductDir(store, { dataDir }) {
  /* 走 `getSetting` 而不是自己拼 SQL：setting 表里那一列叫 `value_json`（值也是
     JSON 编码的字符串），写 `SELECT value` 会直接 `no such column: value` —— 页面点
     「扫描目录」和工具每一条 scan/preview/commit 都会因此 500。声明与读取只有一份。 */
  const value = getSetting(store, 'asin.sourceDir')
  const configured = value === null || value === undefined ? '' : String(value).trim()
  return {
    dir: configured === '' ? defaultProductDir(dataDir) : configured,
    fromSetting: configured !== '',
    defaultDir: defaultProductDir(dataDir),
  }
}

/** 目录里能导入的表格文件。读不到就抛，不返回空数组装作「没有文件」。 */
export function scanProductDir(dir) {
  if (!existsSync(dir)) return { dir, exists: false, files: [] }
  const files = []
  for (const name of readdirSync(dir)) {
    if (!/\.(xlsx|xlsm|csv)$/i.test(name)) continue
    const path = join(dir, name)
    let size = 0
    let mtime = null
    try {
      const info = statSync(path)
      size = info.size
      mtime = info.mtime.toISOString()
    } catch { /* 读不到大小不算致命 */ }
    files.push({ name, path, size, mtime })
  }
  files.sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')))
  return { dir, exists: true, files }
}

/** 表头名 → 列下标。缺列返回 null（由调用方决定是「拒绝」还是「跳过」）。 */
function mapHeader(headerRow, names) {
  const index = {}
  for (const [key, candidates] of Object.entries(names)) {
    let found = null
    for (let i = 0; i < headerRow.length; i += 1) {
      const text = String(headerRow[i] ?? '').trim()
      if (candidates.includes(text)) { found = i; break }
    }
    index[key] = found
  }
  return index
}

/** 读一份产品表。ASIN 是必需的，缺了就整份拒绝 —— 没有 ASIN 的行不是产品。 */
export function readProductRows(buffer) {
  const sheet = readFirstSheet(buffer)
  const rows = sheet.rows ?? []
  if (rows.length === 0) throw new Error('表格是空的')
  const index = mapHeader(rows[0] ?? [], PRODUCT_COLUMNS)
  if (index.asin === null) {
    throw new Error('找不到 ASIN 列 —— 这不是赛狐的产品表，或表头被改过')
  }
  const get = (row, key) => {
    const at = index[key]
    if (at === null || at === undefined) return ''
    const value = row[at]
    return value === null || value === undefined ? '' : String(value).trim()
  }
  const out = []
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] ?? []
    const asin = get(row, 'asin').toUpperCase()
    if (asin === '') continue
    out.push({
      line: i + 1,
      asin,
      parentAsin: get(row, 'parentAsin').toUpperCase(),
      title: get(row, 'title'),
      shop: get(row, 'shop'),
      site: get(row, 'site'),
      brandRaw: get(row, 'brand'),
      msku: get(row, 'msku'),
      sku: get(row, 'sku'),
      productName: get(row, 'productName'),
      productLine: get(row, 'productLine'),
      listedAt: get(row, 'listedAt'),
    })
  }
  return { rows: out, headerIndex: index }
}

/** 站点中文 → 代码；认不出就返回 null（不猜）。 */
export function siteCodeOf(siteText) {
  const text = String(siteText ?? '').trim()
  if (text === '') return null
  if (/^[A-Z]{2}$/.test(text)) return text
  return SITE_CODE[text] ?? null
}

/**
 * 从标题推品牌。返回 `{ brand, source }`，source 是 `rule` / `default` / `none`。
 *
 * 命中顺序：prefix → contains → regex → default。同一类型里按 priority 小的先。
 */
export function deriveBrand(title, rules = []) {
  const text = String(title ?? '')
  const firstToken = text.split(/\s+/)[0] ?? ''
  const ordered = [...rules].sort((a, b) => (Number(a.priority) || 100) - (Number(b.priority) || 100))
  for (const rule of ordered) {
    const pattern = String(rule.pattern ?? '')
    if (pattern === '' && rule.matchType !== 'default') continue
    if (rule.matchType === 'prefix') {
      if (text.startsWith(pattern) || firstToken.toUpperCase() === pattern.toUpperCase()) {
        return { brand: rule.brand, source: 'rule', ruleId: rule.id }
      }
    } else if (rule.matchType === 'contains') {
      if (text.toLowerCase().includes(pattern.toLowerCase())) {
        return { brand: rule.brand, source: 'rule', ruleId: rule.id }
      }
    } else if (rule.matchType === 'regex') {
      try {
        if (new RegExp(pattern, 'i').test(text)) return { brand: rule.brand, source: 'rule', ruleId: rule.id }
      } catch { /* 坏正则跳过，不让一条规则拖垮整份导入 */ }
    }
  }
  const fallback = ordered.find(rule => rule.matchType === 'default' || rule.isDefault === 1 || rule.isDefault === true)
  if (fallback !== undefined) return { brand: fallback.brand, source: 'default', ruleId: fallback.id }
  return { brand: '', source: 'none', ruleId: null }
}

/** 从店铺名派生一个稳定的 shop id（中文名走哈希，保证同一家店两次导入是同一个 id）。 */
export function shopIdFor(name, marketplace) {
  const text = String(name ?? '').trim()
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (ascii !== '' && ascii.length >= 3) return `${ascii}-${String(marketplace ?? '').toLowerCase()}`
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 8)
  return `shop-${String(marketplace ?? '').toLowerCase()}-${hash}`
}

/** 某店铺的品牌规则。 */
export function brandRulesFor(store, shopId) {
  return store.all(
    'SELECT id, brand, match_type AS matchType, pattern, priority, is_default AS isDefault FROM shop_brand_rule WHERE shop_id = ? ORDER BY priority, id',
    [shopId],
  ).map(rule => ({ ...rule, matchType: rule.matchType }))
}

/** 存档：同一份文件按内容哈希认，重复导入是 no-op 而不是翻倍。 */
export function fingerprintOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 生成导入计划 —— **只读**，不写库。
 *
 * 每行四段（店铺 / 品牌 / 父 / ASIN）逐段检查，缺哪段就标哪段，
 * 页面据此显示「为什么这行进不了库」。
 */
/** 推荐品牌：按规则把每行推一遍，取出现最多的那个（**只是默认值**，不写库）。 */
export function recommendBrand(store, rows = []) {
  const tally = new Map()
  for (const row of rows) {
    if (row.brandRaw !== '') { tally.set(row.brandRaw, (tally.get(row.brandRaw) ?? 0) + 1); continue }
    const shop = store.get('SELECT id FROM shop WHERE name = ?', [row.shop])
    if (shop === undefined || shop === null) continue
    const derived = deriveBrand(row.title, brandRulesFor(store, shop.id))
    if (derived.brand === '' || derived.source !== 'rule') continue
    tally.set(derived.brand, (tally.get(derived.brand) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [brand, count] of tally) if (count > bestCount) { best = brand; bestCount = count }
  return { brand: best, hits: bestCount, considered: rows.length }
}

/**
 * 生成导入计划 —— **只读**，不写库。
 *
 * 品牌是**整批一个**（需求方：导入的这一批都是这个品牌），不是逐行推。
 * `brand` 为空 → 整批 pending-brand，一行也不写。
 * 逐行推出来的只用来当**默认值**（`recommendBrand`），不参与判定。
 */
export function buildProductPlan(store, { rows, brand = '', shopOverrides = {}, autoCreateShop = false, shopId = null }) {
  const shops = store.all('SELECT id, name, marketplace, archived_at FROM shop')
  const shopByName = new Map(shops.map(shop => [shop.name, shop]))
  /* A page that imports into one shop passes `shopId`, and the plan must honour
     it: without this the parameter would be a promise the page keeps and the
     server ignores (the exact 「声明了但没生效」 bug this batch fixes). A row that
     names a *different* shop is left in the pending-shop list rather than
     written into the wrong store. */
  const fixedShop = shopId === null || shopId === undefined || String(shopId).trim() === ''
    ? null
    : (shops.find(shop => shop.id === String(shopId).trim()) ?? null)
  if (shopId !== null && shopId !== undefined && String(shopId).trim() !== '' && fixedShop === null) {
    throw new Error(`no such shop "${shopId}"`)
  }
  if (fixedShop !== null && fixedShop.archived_at) {
    throw new Error('shop is archived — restore it before importing')
  }
  /* Which four-part keys already exist. `ready` used to fold create and update
     into one number, so a preview could not tell "3 new" from "3 overwrites". */
  const existingKeys = new Set(
    store.all('SELECT shop_id, brand, parent_asin, asin FROM product_profile')
      .map(row => [row.shop_id, row.brand, row.parent_asin, row.asin].join('|')),
  )
  const batchBrand = String(brand ?? '').trim()
  const seen = new Map()
  /* 本批会新建的店铺（autoCreateShop 时按店铺名 + 站点派生 id）。
     plan 是只读的：这里只登记，真正落库由调用方决定；不给它一个声明会让
     `newShops.size` 直接把整份导入计划打成 ReferenceError。 */
  const newShops = new Map()
  const out = []
  const counts = {
    total: rows.length, ready: 0, create: 0, update: 0,
    pendingBrand: 0, pendingShop: 0, duplicate: 0, unknownSite: 0,
  }

  for (const row of rows) {
    const shopName = shopOverrides[row.shop] ?? row.shop
    let shop = null
    let shopMismatch = false
    if (fixedShop !== null) {
      const rowShopName = String(shopName ?? '').trim()
      if (rowShopName === '' || rowShopName === fixedShop.name) {
        shop = fixedShop
      } else {
        const named = shopByName.get(rowShopName) ?? null
        if (named !== null && named.id === fixedShop.id) shop = fixedShop
        else shopMismatch = true
      }
    } else {
      shop = shopByName.get(shopName) ?? null
    }
    const parentAsin = row.parentAsin === '' ? row.asin : row.parentAsin
    const parentSource = row.parentAsin === '' ? 'self' : 'file'
    const marketplace = siteCodeOf(row.site) ?? shop?.marketplace ?? null
    /* 表里带店铺名和站点，店铺不存在时按它建 —— 「导入某个店铺的产品」本来就该把店建出来，
       而不是让人先去别处手工建店再回来。 */
    if (shop === null && !shopMismatch && autoCreateShop && marketplace !== null) {
      const id = shopIdFor(shopName, marketplace)
      shop = { id, name: shopName, marketplace }
      if (!newShops.has(id)) newShops.set(id, shop)
    }
    const missing = []
    if (shop === null) missing.push('shop')
    if (batchBrand === '') missing.push('brand')
    if (marketplace === null) missing.push('marketplace')
    if (String(row.site ?? '').trim() !== '' && siteCodeOf(row.site) === null) counts.unknownSite += 1

    const key = shop === null ? null : [shop.id, batchBrand, parentAsin, row.asin].join('|')
    let duplicate = false
    if (key !== null && batchBrand !== '') {
      if (seen.has(key)) duplicate = true
      else seen.set(key, row.line)
    }

    let status = 'ready'
    let action = null
    if (duplicate) { status = 'duplicate'; counts.duplicate += 1 }
    else if (shop === null) { status = 'pending-shop'; counts.pendingShop += 1 }
    else if (batchBrand === '') { status = 'pending-brand'; counts.pendingBrand += 1 }
    else {
      action = existingKeys.has(key) ? 'update' : 'create'
      if (action === 'create') counts.create += 1
      else counts.update += 1
      counts.ready += 1
    }

    out.push({
      ...row,
      shopId: shop?.id ?? null,
      shopName: shop?.name ?? row.shop,
      shopMismatch,
      marketplace,
      brand: batchBrand,
      parentAsin,
      parentSource,
      action,
      missing,
      status,
      duplicateOf: duplicate ? seen.get(key) : null,
    })
  }

  counts.newShops = newShops.size
  return { rows: out, counts, brand: batchBrand, newShops: [...newShops.values()] }
}

/**
 * 产品线文本 → `product_line.id`。
 *
 * 表里给的是人写的名字（如「坐垫」），库里主键是 id。先按 id / 名字精确匹配；
 * 没有就建一条（name = 原文），不猜别的线。返回 null 表示这一行没有产品线 ——
 * 那是「没写」，不是「属于默认线」。
 */
export function resolveProductLineId(store, text) {
  const name = String(text ?? '').trim()
  if (name === '') return null
  const found = store.get(
    'SELECT id FROM product_line WHERE id = ? OR lower(name) = lower(?) LIMIT 1',
    [name, name],
  )
  if (found !== undefined) return found.id
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const id = slug !== '' ? slug : `line-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`
  const clash = store.get('SELECT name FROM product_line WHERE id = ?', [id])
  if (clash === undefined) {
    store.run('INSERT INTO product_line (id, name, note) VALUES (?, ?, NULL)', [id, name])
  }
  return id
}

/**
 * 写入计划里 ready 的行。一次事务，要么全成要么全不成。
 *
 * 四元组命中 `ON CONFLICT` → 更新（重复导入是更新，不是插第二条）。
 * 父子关系顺手写进 `asin_variant_relation`（父 = 自己的不写，那是独立 listing）。
 */
export function commitProductPlan(store, { plan, path, fingerprint = null }) {
  const ready = plan.rows.filter(row => row.status === 'ready')
  const pending = plan.rows.filter(row => row.status !== 'ready')
  const now = nowIso()
  const unknown = plan.rows.filter(row => row.brand === '').length

  store.tx(() => {
    for (const row of ready) {
      const lineId = resolveProductLineId(store, row.productLine)
      store.run(
        `INSERT INTO product_profile
           (id, shop_id, brand, parent_asin, asin, marketplace, sku, product_name, product_line_id,
            source_id, source_file, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'saihu-import', ?, NULL, ?, ?)
         ON CONFLICT (shop_id, brand, parent_asin, asin) DO UPDATE SET
           marketplace = excluded.marketplace,
           sku = COALESCE(excluded.sku, product_profile.sku),
           product_name = COALESCE(excluded.product_name, product_profile.product_name),
           product_line_id = COALESCE(excluded.product_line_id, product_profile.product_line_id),
           source_file = excluded.source_file,
           updated_at  = excluded.updated_at`,
        [randomUUID(), row.shopId, row.brand, row.parentAsin, row.asin, row.marketplace,
          row.sku === '' ? null : row.sku,
          row.productName === '' ? null : row.productName,
          lineId,
          path ?? null, now, now],
      )
      if (row.parentSource === 'file' && row.parentAsin !== row.asin) {
        store.run(
          `INSERT INTO asin_variant_relation (id, marketplace, parent_asin, child_asin, source_id, evidence, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'saihu-import', ?, 'active', ?, ?)
           ON CONFLICT (marketplace, parent_asin, child_asin) DO UPDATE SET updated_at = excluded.updated_at`,
          [randomUUID(), row.marketplace, row.parentAsin, row.asin, path ?? null, now, now],
        )
      }
    }
    store.run(
      `INSERT INTO product_import
         (id, fingerprint, path, marketplace, rows_total, rows_written, rows_pending,
          brand_batch, brand_unknown, imported_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), fingerprint ?? randomUUID(), path ?? '', plan.counts.total, ready.length, pending.length,
        plan.brand ?? '', unknown, now],
    )
  })

  return { written: ready.length, pending: pending.length, brand: plan.brand ?? '', unknown }
}


/** 已入库的归属（页面总表用）。`shopId` 在 SQL 里过滤：先取全库再在 JS 里筛，
 *  500 行上限会把「这家店只有 1 行、全库有 500 行别的店」筛成 0 行 —— 那是
 *  一个看起来像「这家店没有产品」的静默错误。 */
export function listProfiles(store, { shopId = null, marketplace = null, limit = 500 } = {}) {
  const params = []
  const where = []
  let sql = 'SELECT * FROM product_profile'
  if (shopId !== null && shopId !== undefined && String(shopId).trim() !== '') {
    where.push('shop_id = ?'); params.push(String(shopId).trim())
  }
  if (marketplace !== null && marketplace !== '') {
    where.push('marketplace = ?'); params.push(marketplace)
  }
  if (where.length > 0) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY shop_id, brand, parent_asin, asin LIMIT ?'
  params.push(Math.max(1, Math.min(2000, Number(limit) || 500)))
  return store.all(sql, params)
}

/**
 * 直写一条产品四元组（店铺 + 品牌 + 父 ASIN + ASIN）。
 *
 * ## 为什么需要它（R-12，2026-10-25 真实数据实测）
 *
 * `product_profile` 原来是**只能靠导入赛狐 xlsx** 才写得进去的。而它是店铺归属、
 * 品牌归属、产品线归属的落点之一 —— 优化前置第 1 门的「店铺」就是读它的 `shop_id`。
 *
 * 结果就是：那一格虽然修活了（R-11 加了兜底），**agent 依然走不到** ——
 * 要写一条四元组就得先有一份 xlsx。**「能用」和「好走」是两件事。**
 *
 * ## 一个必须说清的约束
 *
 * 表的 `parent_asin` 是 **NOT NULL**：单 ASIN 商品（没有变体家族）在库里存不下
 * 「我没有父 ASIN」这个事实，只能写自指（`parent_asin = asin`）。
 * 本函数**不替调用方决定**：不传 parentAsin 时用 asin 自指，但会在返回值里
 * 标 `parentSelf: true` —— 让「这是自指、不是真的有一个父」这件事可查，
 * 而不是把所有单 ASIN 商品都伪装成「有一个叫它自己名字的父」。
 */
export function upsertProductProfile(store, record = {}) {
  const asin = String(record.asin ?? '').trim().toUpperCase()
  const marketplace = String(record.marketplace ?? '').trim().toUpperCase()
  const shopId = String(record.shopId ?? '').trim()
  const brand = String(record.brand ?? '').trim()
  const parentGiven = String(record.parentAsin ?? '').trim().toUpperCase()
  if (asin === '') return { ok: false, error: 'asin is required' }
  if (marketplace === '') return { ok: false, error: 'marketplace is required' }
  if (shopId === '') return { ok: false, error: 'shopId is required（先用 amzn_shop_upsert 建店铺）' }
  if (brand === '') return { ok: false, error: 'brand is required' }
  const parentAsin = parentGiven === '' ? asin : parentGiven
  const now = nowIso()
  const lineId = record.productLineId === undefined || record.productLineId === null
    ? null
    : String(record.productLineId).trim() || null
  store.run(
    `INSERT INTO product_profile
       (id, shop_id, brand, parent_asin, asin, marketplace, sku, product_name, product_line_id,
        source_id, source_file, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL, ?, ?, ?)
     ON CONFLICT (shop_id, brand, parent_asin, asin) DO UPDATE SET
       marketplace = excluded.marketplace,
       sku = COALESCE(excluded.sku, product_profile.sku),
       product_name = COALESCE(excluded.product_name, product_profile.product_name),
       product_line_id = COALESCE(excluded.product_line_id, product_profile.product_line_id),
       note = COALESCE(excluded.note, product_profile.note),
       updated_at = excluded.updated_at`,
    [randomUUID(), shopId, brand, parentAsin, asin, marketplace,
      record.sku == null ? null : String(record.sku),
      record.productName == null ? null : String(record.productName),
      lineId,
      record.note == null ? null : String(record.note), now, now],
  )
  const row = store.get(
    'SELECT * FROM product_profile WHERE shop_id = ? AND brand = ? AND parent_asin = ? AND asin = ?',
    [shopId, brand, parentAsin, asin],
  )
  return { ok: true, row, parentSelf: parentGiven === '' }
}

/**
 * SQLite 存储层：待收货订单落库、去重、查询、导出。
 *
 * 为什么是 SQLite：数据是本地个人订单（含收货人手机号/地址），不能进仓库、不能上云；
 * 单文件、可直接用任意 SQL 客户端查、导出也方便。Node 24 自带 node:sqlite，不引第三方依赖。
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  order_sn            TEXT PRIMARY KEY,
  platform            TEXT NOT NULL DEFAULT 'pdd',
  order_date          TEXT,
  tab                 TEXT,
  status              INTEGER,
  status_text         TEXT,
  shop_name           TEXT,
  mall_id             TEXT,
  receiver_name       TEXT,
  receiver_phone      TEXT,
  receiver_phone_mask TEXT,
  province            TEXT,
  city                TEXT,
  district            TEXT,
  address             TEXT,
  tracking_no         TEXT,
  carrier             TEXT,
  order_time          TEXT,
  ship_time           TEXT,
  expect_auto_receive TEXT,
  receive_time        TEXT,
  goods_amount_cents  INTEGER,
  pay_amount_cents    INTEGER,
  item_count          INTEGER,
  item_qty            INTEGER,
  first_seen_at       TEXT,
  updated_at          TEXT,
  raw_json            TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status_text);
CREATE INDEX IF NOT EXISTS idx_orders_tracking ON orders(tracking_no);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_name);
-- idx_orders_date 建在 migrate() 里：老库先 ALTER 加列，才能建这个索引

CREATE TABLE IF NOT EXISTS order_items (
  order_sn         TEXT NOT NULL,
  goods_id         TEXT,
  sku_id           TEXT,
  goods_name       TEXT,
  spec             TEXT,
  qty              INTEGER,
  unit_price_cents INTEGER,
  thumb_url        TEXT,
  link_url         TEXT,
  PRIMARY KEY (order_sn, goods_id, sku_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT,
  finished_at   TEXT,
  scope         TEXT,
  status        TEXT,
  orders_seen   INTEGER,
  orders_new    INTEGER,
  orders_updated INTEGER,
  detail_ok     INTEGER,
  detail_failed INTEGER,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS xianyu_orders (
  xy_sn         TEXT PRIMARY KEY,
  status        TEXT,
  shop          TEXT,
  buyer         TEXT,
  item_title    TEXT,
  spec          TEXT,
  qty           INTEGER,
  amount_cents  INTEGER,
  order_time    TEXT,
  pay_time      TEXT,
  ship_time     TEXT,
  receiver      TEXT,
  phone         TEXT,
  phone_masked  TEXT,
  address       TEXT,
  express       TEXT,
  tracking      TEXT,
  raw_json      TEXT,
  imported_at   TEXT
);

CREATE TABLE IF NOT EXISTS order_matches (
  xy_sn           TEXT PRIMARY KEY,
  pdd_sn          TEXT,
  source_platform TEXT NOT NULL DEFAULT 'pdd',
  alt_sn          TEXT,
  alt_platform    TEXT,
  score           REAL,
  score_alt       REAL,
  method          TEXT,
  decision        TEXT,
  note            TEXT,
  updated_at      TEXT
);

-- 状态/物流变化留痕：重复导入同一单时，变化写这里，历史不丢
CREATE TABLE IF NOT EXISTS order_status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_sn     TEXT NOT NULL,
  platform     TEXT,
  old_status   TEXT,
  new_status   TEXT,
  old_tracking TEXT,
  new_tracking TEXT,
  seen_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_status_history_order ON order_status_history(order_sn, seen_at);

-- 快递公司映射表：平台原样名字 → 闲鱼批量发货模板里的「物流公司」名字
CREATE TABLE IF NOT EXISTS carrier_map (
  platform    TEXT NOT NULL,
  source_name TEXT NOT NULL,
  target_name TEXT NOT NULL,
  note        TEXT,
  updated_at  TEXT,
  PRIMARY KEY (platform, source_name)
);
`

export function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)
  migrate(db, dbPath)
  return db
}

/** 老库补列：order_date 优先按「下单时间」回填，没有下单时间才退回订单号前缀。 */
function migrate(db, dbPath) {
  const columns = db.prepare('PRAGMA table_info(orders)').all().map((row) => row.name)
  if (!columns.includes('platform')) {
    // 首次跨平台迁移前先留一份原库，出事能回退
    try {
      if (dbPath && existsSync(dbPath)) copyFileSync(dbPath, `${dbPath}.bak-${Date.now()}`)
    } catch {
      /* 备份失败不阻塞迁移 */
    }
    db.exec("ALTER TABLE orders ADD COLUMN platform TEXT NOT NULL DEFAULT 'pdd'")
  }
  db.exec("UPDATE orders SET platform = 'pdd' WHERE platform IS NULL OR platform = ''")
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_platform_date ON orders(platform, order_date)')
  if (!columns.includes('order_date')) {
    db.exec('ALTER TABLE orders ADD COLUMN order_date TEXT')
  }
  // 以订单时间为准：order_time 存的是本地 ISO（2026-10-27T09:32:14+08:00）
  db.exec(`UPDATE orders SET order_date = substr(order_time, 1, 10)
           WHERE order_time IS NOT NULL AND order_time <> '' AND length(order_time) >= 10
             AND (order_date IS NULL OR order_date = '' OR order_date <> substr(order_time, 1, 10))`)
  db.exec(`UPDATE orders SET order_date = '20' || substr(order_sn, 1, 2) || '-' || substr(order_sn, 3, 2) || '-' || substr(order_sn, 5, 2)
           WHERE (order_date IS NULL OR order_date = '') AND length(order_sn) >= 6`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date)')

  // 匹配表补「来源平台 / 另一候选」
  const matchColumns = db.prepare('PRAGMA table_info(order_matches)').all().map((row) => row.name)
  const addMatchColumn = (name, ddl) => {
    if (!matchColumns.includes(name)) db.exec(`ALTER TABLE order_matches ADD COLUMN ${ddl}`)
  }
  addMatchColumn('source_platform', "source_platform TEXT NOT NULL DEFAULT 'pdd'")
  addMatchColumn('alt_sn', 'alt_sn TEXT')
  addMatchColumn('alt_platform', 'alt_platform TEXT')
  addMatchColumn('score_alt', 'score_alt REAL')
  db.exec("UPDATE order_matches SET source_platform = 'pdd' WHERE source_platform IS NULL OR source_platform = ''")
  seedCarrierMap(db)
}

/** 预置常用快递：新库就有映射，用户可以改成自己模板里的名字。 */
export const DEFAULT_CARRIERS = [
  '中通快递',
  '圆通速递',
  '申通快递',
  '韵达快递',
  '邮政快递包裹',
  '极兔速递',
  '顺丰速运',
  '德邦快递',
  '京东物流',
  '优速快递',
]

function seedCarrierMap(db) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO carrier_map (platform, source_name, target_name, note, updated_at)
     VALUES (?,?,?,?,?)`,
  )
  for (const platform of ['1688', 'pdd']) {
    for (const name of DEFAULT_CARRIERS) {
      insert.run(platform, name, name, '预置：同名直通', 'seed')
    }
  }
}

export function listCarrierMap(db, { platform } = {}) {
  const where = platform ? 'WHERE platform = ?' : ''
  return db
    .prepare(`SELECT * FROM carrier_map ${where} ORDER BY platform, source_name`)
    .all(...(platform ? [platform] : []))
}

export function upsertCarrierMap(db, entry, nowIso) {
  db.prepare(
    `INSERT INTO carrier_map (platform, source_name, target_name, note, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(platform, source_name) DO UPDATE SET
       target_name=excluded.target_name, note=excluded.note, updated_at=excluded.updated_at`,
  ).run(
    pickText(entry.platform || '*'),
    pickText(entry.sourceName),
    pickText(entry.targetName),
    pickText(entry.note),
    nowIso,
  )
}

export function deleteCarrierMap(db, platform, sourceName) {
  return db.prepare('DELETE FROM carrier_map WHERE platform = ? AND source_name = ?').run(platform, sourceName)
}

/** 查映射：先按平台，再退回通配 '*'，都没有就原样返回。 */
export function resolveCarrier(db, platform, sourceName) {
  const name = pickText(sourceName).trim()
  if (!name) return { target: '', mapped: false }
  const row =
    db.prepare('SELECT target_name FROM carrier_map WHERE platform = ? AND source_name = ?').get(platform, name) ||
    db.prepare("SELECT target_name FROM carrier_map WHERE platform = '*' AND source_name = ?").get(name)
  if (row && row.target_name) return { target: row.target_name, mapped: row.target_name !== name }
  return { target: name, mapped: false }
}

export function listStatusHistory(db, { orderSn, limit = 100 } = {}) {
  const where = orderSn ? 'WHERE order_sn = ?' : ''
  return db
    .prepare(`SELECT * FROM order_status_history ${where} ORDER BY id DESC LIMIT ?`)
    .all(...(orderSn ? [orderSn] : []), limit)
}

const pickText = (value) => (value === undefined || value === null ? '' : String(value))

/** 订单是否已存在（只读，不写库）。 */
export function orderExists(db, orderSn) {
  const row = db.prepare('SELECT order_sn, updated_at FROM orders WHERE order_sn = ?').get(orderSn)
  return row || null
}

export function upsertOrder(db, order, nowIso) {
  const existing = db.prepare('SELECT order_sn, first_seen_at, status_text, tracking_no, carrier, receiver_phone FROM orders WHERE order_sn = ?').get(order.orderSn)
  const itemCount = order.items.length
  const itemQty = order.items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
  const goodsAmount = Number.isFinite(order.goodsAmountCents) ? order.goodsAmountCents : null
  const payAmount = Number.isFinite(order.payAmountCents) ? order.payAmountCents : null

  db.prepare(
    `INSERT INTO orders (
      order_sn, platform, order_date, tab, status, status_text, shop_name, mall_id,
      receiver_name, receiver_phone, receiver_phone_mask,
      province, city, district, address,
      tracking_no, carrier, order_time, ship_time, expect_auto_receive, receive_time,
      goods_amount_cents, pay_amount_cents, item_count, item_qty,
      first_seen_at, updated_at, raw_json
    ) VALUES (
      ?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?
    )
    -- 重复导入不新建行，也不让「这次没读到」的字段把已有值抹掉（COALESCE 保旧值）
    ON CONFLICT(order_sn) DO UPDATE SET
      platform=COALESCE(NULLIF(excluded.platform,''), platform),
      order_date=COALESCE(NULLIF(excluded.order_date,''), order_date),
      tab=COALESCE(NULLIF(excluded.tab,''), tab),
      status=COALESCE(excluded.status, status),
      status_text=COALESCE(NULLIF(excluded.status_text,''), status_text),
      shop_name=COALESCE(NULLIF(excluded.shop_name,''), shop_name),
      mall_id=COALESCE(NULLIF(excluded.mall_id,''), mall_id),
      receiver_name=COALESCE(NULLIF(excluded.receiver_name,''), receiver_name),
      receiver_phone=COALESCE(NULLIF(excluded.receiver_phone,''), receiver_phone),
      receiver_phone_mask=COALESCE(NULLIF(excluded.receiver_phone_mask,''), receiver_phone_mask),
      province=COALESCE(NULLIF(excluded.province,''), province),
      city=COALESCE(NULLIF(excluded.city,''), city),
      district=COALESCE(NULLIF(excluded.district,''), district),
      address=COALESCE(NULLIF(excluded.address,''), address),
      tracking_no=COALESCE(NULLIF(excluded.tracking_no,''), tracking_no),
      carrier=COALESCE(NULLIF(excluded.carrier,''), carrier),
      order_time=COALESCE(NULLIF(excluded.order_time,''), order_time),
      ship_time=COALESCE(NULLIF(excluded.ship_time,''), ship_time),
      expect_auto_receive=COALESCE(NULLIF(excluded.expect_auto_receive,''), expect_auto_receive),
      receive_time=COALESCE(NULLIF(excluded.receive_time,''), receive_time),
      goods_amount_cents=COALESCE(excluded.goods_amount_cents, goods_amount_cents),
      pay_amount_cents=COALESCE(excluded.pay_amount_cents, pay_amount_cents),
      item_count=excluded.item_count, item_qty=excluded.item_qty,
      updated_at=excluded.updated_at, raw_json=excluded.raw_json`,
  ).run(
    pickText(order.orderSn),
    pickText(order.platform || 'pdd'),
    pickText(order.orderDate || ''),
    pickText(order.tab),
    Number.isFinite(order.status) ? order.status : null,
    pickText(order.statusText),
    pickText(order.shopName),
    pickText(order.mallId),
    pickText(order.receiverName),
    pickText(order.receiverPhone),
    pickText(order.receiverPhoneMasked),
    pickText(order.province),
    pickText(order.city),
    pickText(order.district),
    pickText(order.address),
    pickText(order.trackingNo),
    pickText(order.carrier),
    pickText(order.orderTime),
    pickText(order.shipTime),
    pickText(order.expectAutoReceive),
    pickText(order.receiveTime),
    goodsAmount,
    payAmount,
    itemCount,
    itemQty,
    existing ? existing.first_seen_at || nowIso : nowIso,
    nowIso,
    order.raw ? JSON.stringify(order.raw) : null,
  )

  const del = db.prepare('DELETE FROM order_items WHERE order_sn = ?')
  del.run(pickText(order.orderSn))
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_sn, goods_id, sku_id, goods_name, spec, qty, unit_price_cents, thumb_url, link_url)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
  for (const item of order.items) {
    insertItem.run(
      pickText(order.orderSn),
      pickText(item.goodsId),
      pickText(item.skuId),
      pickText(item.goodsName),
      pickText(item.spec),
      Number(item.qty) || 0,
      Number.isFinite(item.unitPriceCents) ? item.unitPriceCents : null,
      pickText(item.thumbUrl),
      pickText(item.linkUrl),
    )
  }
  if (!existing) return 'inserted'
  // 状态/物流变化留痕：同一单从「待发货」变「待收货」、或补上运单号，都记一条
  const nextStatus = pickText(order.statusText)
  const nextTracking = pickText(order.trackingNo)
  const statusChanged = nextStatus && existing.status_text && nextStatus !== existing.status_text
  const trackingAdded = nextTracking && !existing.tracking_no
  if (statusChanged || trackingAdded) {
    db.prepare(
      `INSERT INTO order_status_history (order_sn, platform, old_status, new_status, old_tracking, new_tracking, seen_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      pickText(order.orderSn),
      pickText(order.platform || 'pdd'),
      pickText(existing.status_text),
      nextStatus || pickText(existing.status_text),
      pickText(existing.tracking_no),
      nextTracking || pickText(existing.tracking_no),
      nowIso,
    )
  }
  return 'updated'
}

export function startRun(db, { scope, startedAt }) {
  const info = db
    .prepare('INSERT INTO sync_runs (started_at, scope, status) VALUES (?,?,?)')
    .run(startedAt, scope, 'running')
  return Number(info.lastInsertRowid)
}

export function finishRun(db, id, patch) {
  db.prepare(
    `UPDATE sync_runs SET finished_at=?, status=?, orders_seen=?, orders_new=?, orders_updated=?,
      detail_ok=?, detail_failed=?, error=? WHERE id=?`,
  ).run(
    patch.finishedAt || null,
    patch.status || 'done',
    patch.ordersSeen ?? null,
    patch.ordersNew ?? null,
    patch.ordersUpdated ?? null,
    patch.detailOk ?? null,
    patch.detailFailed ?? null,
    patch.error || null,
    id,
  )
}

const ORDER_COLUMNS = `order_sn, platform, order_date, tab, status, status_text, shop_name, receiver_name, receiver_phone,
  province, city, district, address, tracking_no, carrier, order_time, ship_time,
  expect_auto_receive, goods_amount_cents, pay_amount_cents, item_count, item_qty, updated_at`

export function queryOrders(db, { tab, platform, keyword, dateFrom, dateTo, limit = 100, offset = 0, withItems = false, order = 'desc' } = {}) {
  const where = []
  const params = []
  if (tab) {
    where.push('tab = ?')
    params.push(tab)
  }
  if (platform) {
    where.push('platform = ?')
    params.push(platform)
  }
  if (dateFrom) {
    where.push('order_date >= ?')
    params.push(dateFrom)
  }
  if (dateTo) {
    where.push('order_date <= ?')
    params.push(dateTo)
  }
  if (keyword) {
    where.push(
      `(order_sn LIKE ? OR tracking_no LIKE ? OR shop_name LIKE ? OR receiver_name LIKE ? OR receiver_phone LIKE ?
        OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_sn = orders.order_sn AND i.goods_name LIKE ?))`,
    )
    const like = `%${keyword}%`
    params.push(like, like, like, like, like, like)
  }
  const direction = order === 'asc' ? 'ASC' : 'DESC'
  const sql = `SELECT ${ORDER_COLUMNS} FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY order_time ${direction} LIMIT ? OFFSET ?`
  const rows = db.prepare(sql).all(...params, limit, offset)
  if (withItems && rows.length) {
    const itemsStmt = db.prepare('SELECT goods_id, sku_id, goods_name, spec, qty, unit_price_cents, thumb_url, link_url FROM order_items WHERE order_sn = ?')
    for (const row of rows) row.items = itemsStmt.all(row.order_sn)
  }
  return rows
}

export function stats(db) {
  const total = db.prepare('SELECT COUNT(*) c FROM orders').get().c
  const byTab = db.prepare('SELECT tab, COUNT(*) c FROM orders GROUP BY tab').all()
  const byPlatform = db.prepare('SELECT platform, COUNT(*) c FROM orders GROUP BY platform').all()
  const withTracking = db.prepare("SELECT COUNT(*) c FROM orders WHERE tracking_no IS NOT NULL AND tracking_no <> ''").get().c
  const withPhone = db.prepare("SELECT COUNT(*) c FROM orders WHERE receiver_phone IS NOT NULL AND receiver_phone <> ''").get().c
  const items = db.prepare('SELECT COUNT(*) c FROM order_items').get().c
  const lastRun = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get()
  // 库里数据的日期边界：面板用它解释「为什么这个日期范围是空的」
  const range = db.prepare('SELECT MIN(order_date) first, MAX(order_date) last FROM orders').get()
  const byDate = db.prepare('SELECT order_date d, COUNT(*) c FROM orders GROUP BY order_date ORDER BY d DESC LIMIT 30').all()
  return { total, byTab, byPlatform, withTracking, withPhone, items, lastRun, firstOrderDate: range.first || '', lastOrderDate: range.last || '', byDate }
}

/** 导出用的扁平行：一个订单一行，多商品拼成文本，Excel 里好读。 */
export function exportRows(db, { tab, dateFrom, dateTo } = {}) {
  const orders = queryOrders(db, { tab, dateFrom, dateTo, limit: 100000, offset: 0 })
  if (!orders.length) return []
  const itemsStmt = db.prepare('SELECT goods_name, spec, qty, unit_price_cents FROM order_items WHERE order_sn = ?')
  return orders.map((order) => {
    const items = itemsStmt.all(order.order_sn)
    const goodsText = items.map((item) => item.goods_name).join(' / ')
    const specText = items.map((item) => item.spec).filter(Boolean).join(' / ')
    return {
      订单号: order.order_sn,
      物流单号: order.tracking_no || '',
      快递公司: order.carrier || '',
      商品信息: goodsText,
      规格: specText,
      数量: order.item_qty || 0,
      商家店铺名称: order.shop_name || '',
      收货人: order.receiver_name || '',
      收货人手机号: order.receiver_phone || '',
      // address 存的就是完整地址（省市区已包含），不要再拼 province/city/district，否则会重复
      收货地址: order.address || [order.province, order.city, order.district].filter(Boolean).join(''),
      订单状态: order.status_text || order.tab || '',
      实付金额: order.pay_amount_cents != null ? (order.pay_amount_cents / 100).toFixed(2) : order.goods_amount_cents != null ? (order.goods_amount_cents / 100).toFixed(2) : '',
      下单时间: order.order_time || '',
      发货时间: order.ship_time || '',
      采集时间: order.updated_at || '',
    }
  })
}

export function toCsv(rows) {
  if (!rows.length) return '\uFEFF'
  const headers = Object.keys(rows[0])
  const escape = (value) => {
    const text = value === undefined || value === null ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [headers.join(',')]
  for (const row of rows) lines.push(headers.map((key) => escape(row[key])).join(','))
  return `\uFEFF${lines.join('\r\n')}`
}

// ---------------------------------------------------------------------------
// 闲鱼订单与核对
// ---------------------------------------------------------------------------

export function upsertXianyuOrder(db, order, nowIso) {
  db.prepare(
    `INSERT INTO xianyu_orders (
      xy_sn, status, shop, buyer, item_title, spec, qty, amount_cents,
      order_time, pay_time, ship_time, receiver, phone, phone_masked, address,
      express, tracking, raw_json, imported_at
    ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?)
    ON CONFLICT(xy_sn) DO UPDATE SET
      status=excluded.status, shop=excluded.shop, buyer=excluded.buyer,
      item_title=excluded.item_title, spec=excluded.spec, qty=excluded.qty, amount_cents=excluded.amount_cents,
      order_time=excluded.order_time, pay_time=excluded.pay_time, ship_time=excluded.ship_time,
      receiver=excluded.receiver, phone=excluded.phone, phone_masked=excluded.phone_masked, address=excluded.address,
      express=excluded.express, tracking=excluded.tracking, raw_json=excluded.raw_json, imported_at=excluded.imported_at`,
  ).run(
    order.xySn,
    order.status || '',
    order.shop || '',
    order.buyer || '',
    order.itemTitle || '',
    order.spec || '',
    Number(order.qty) || 0,
    Number.isFinite(order.amountCents) ? order.amountCents : null,
    order.orderTime || '',
    order.payTime || '',
    order.shipTime || '',
    order.receiver || '',
    order.phone || '',
    order.phoneMasked || '',
    order.address || '',
    order.express || '',
    order.tracking || '',
    order.raw ? JSON.stringify(order.raw) : null,
    nowIso,
  )
}

export function listXianyuOrders(db, { status, limit = 200 } = {}) {
  const where = []
  const params = []
  if (status) {
    where.push('status = ?')
    params.push(status)
  }
  return db
    .prepare(`SELECT * FROM xianyu_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY order_time DESC LIMIT ?`)
    .all(...params, limit)
}

export function upsertMatch(db, match, nowIso) {
  db.prepare(
    `INSERT INTO order_matches (xy_sn, pdd_sn, source_platform, alt_sn, alt_platform, score, score_alt, method, decision, note, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(xy_sn) DO UPDATE SET
       pdd_sn=excluded.pdd_sn, source_platform=excluded.source_platform,
       alt_sn=excluded.alt_sn, alt_platform=excluded.alt_platform,
       score=excluded.score, score_alt=excluded.score_alt, method=excluded.method,
       decision=excluded.decision, note=excluded.note, updated_at=excluded.updated_at`,
  ).run(
    match.xySn,
    match.pddSn || '',
    match.sourcePlatform || 'pdd',
    match.altSn || '',
    match.altPlatform || '',
    Number.isFinite(match.score) ? match.score : null,
    Number.isFinite(match.scoreAlt) ? match.scoreAlt : null,
    match.method || '',
    match.decision || 'auto',
    match.note || '',
    nowIso,
  )
}

/** 核对明细表：以闲鱼单为主表 LEFT JOIN，保证「没配上」的单也在表里。 */
export function listMatchSheet(db, { limit = 5000 } = {}) {
  return db
    .prepare(
      `SELECT x.xy_sn, x.status AS xy_status, x.receiver AS xy_receiver, x.phone AS xy_phone, x.phone_masked AS xy_phone_masked,
              x.address AS xy_address, x.item_title AS xy_item, x.order_time AS xy_order_time,
              m.pdd_sn, m.source_platform, m.decision, m.score, m.method, m.note, m.alt_sn, m.alt_platform, m.score_alt,
              o.status_text AS pdd_status, o.tracking_no, o.carrier, o.receiver_name AS pdd_receiver
       FROM xianyu_orders x
       LEFT JOIN order_matches m ON m.xy_sn = x.xy_sn
       LEFT JOIN orders o ON o.order_sn = m.pdd_sn
       ORDER BY x.order_time ASC
       LIMIT ?`,
    )
    .all(limit)
}

export function listMatches(db) {
  return db
    .prepare(
      `SELECT m.*, x.status AS xy_status, x.receiver AS xy_receiver, x.phone AS xy_phone, x.address AS xy_address,
              x.item_title AS xy_item, x.order_time AS xy_order_time,
              o.status_text AS pdd_status, o.tracking_no, o.carrier, o.receiver_name AS pdd_receiver,
              o.receiver_phone AS pdd_phone, o.address AS pdd_address, o.order_time AS pdd_order_time
       FROM order_matches m
       LEFT JOIN xianyu_orders x ON x.xy_sn = m.xy_sn
       LEFT JOIN orders o ON o.order_sn = m.pdd_sn
       ORDER BY x.order_time DESC`,
    )
    .all()
}

export function matchOf(db, xySn) {
  return db.prepare('SELECT * FROM order_matches WHERE xy_sn = ?').get(xySn)
}

export function deleteMatch(db, xySn) {
  db.prepare('DELETE FROM order_matches WHERE xy_sn = ?').run(xySn)
}


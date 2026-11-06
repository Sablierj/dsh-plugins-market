// 端到端同步脚本（与插件同一套模块）：列表 → 逐单详情 → SQLite。
// 用法: node tools/sync.mjs [--days 2] [--from 2026-10-27] [--to 2026-10-27] [--limit N] [--refresh] [--list-only]
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { connect, probe } from '../src/cdp.js'
import * as pdd from '../src/pdd.js'
import * as store from '../src/store.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}

const DATA_DIR = join(homedir(), '.dsh-pdd-workbench')
const DB_FILE = join(DATA_DIR, 'orders.db')
const CDP = opt('--cdp', 'http://127.0.0.1:9335')

const limit = Number(opt('--limit', 0))
const refresh = flag('--refresh')
const listOnly = flag('--list-only')
const fromList = opt('--from-list', '')
const days = Number(opt('--days', 2))
const sinceDate = opt('--from', days > 0 ? pdd.sinceDateForDays(days) : '')
const untilDate = opt('--to', '')
const tabKey = opt('--tab', 'shipped') === 'pending' ? 'pending' : 'shipped'
const tabType = tabKey === 'pending' ? 2 : 3
const tabLabel = tabKey === 'pending' ? '待发货' : '待收货'

function log(...parts) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts)
}

const browser = await probe(CDP)
if (!browser.ok) {
  console.error('调试端口没开：', CDP)
  process.exit(2)
}
const page = await connect(CDP, { match: (u) => u.includes('pinduoduo.com') || u.includes('/orders'), pickExisting: true })

let collected
if (fromList) {
  const list = JSON.parse(await readFile(fromList, 'utf8'))
  collected = { list, pages: 0, scanned: list.length }
  log(`复用名单 ${fromList}：${list.length} 个订单`)
} else {
  log(`开始收集列表（起始日期 ${sinceDate || '不限'}）…`)
  collected = await pdd.collectOrderList(page, {
    sinceDate,
    tabType,
    onProgress: ({ scrolls, cards, orders, final }) => {
      if (final || scrolls % 15 === 0) log(`  滚动 ${scrolls} 次，卡片 ${cards}，已收 ${orders ?? 0} 单`)
    },
  })
  log(`列表完成：${collected.pages} 页响应，扫描 ${collected.scanned ?? collected.list.length} 单，命中 ${collected.list.length} 单`)
  await (await import('node:fs/promises')).writeFile(join(process.cwd(), '.tmp/orders.json'), JSON.stringify(collected.list, null, 1), 'utf8')
}

if (listOnly) {
  page.close()
  process.exit(0)
}

const db = store.openStore(DB_FILE)
const runStartedAt = new Date().toISOString()
const runId = store.startRun(db, { scope: tabLabel, startedAt: runStartedAt })
const existing = new Set(db.prepare('SELECT order_sn FROM orders').all().map((row) => row.order_sn))
let targets = collected.list
if (untilDate) targets = targets.filter((order) => pdd.dateOfOrderSn(order.order_sn) <= untilDate)
if (!refresh) targets = targets.filter((order) => !existing.has(order.order_sn))
if (limit) targets = targets.slice(0, limit)
log(`库里已有 ${existing.size} 单；本轮要抓 ${targets.length} 单`)

let ok = 0
let failed = 0
for (let i = 0; i < targets.length; i++) {
  const listOrder = targets[i]
  try {
    const detail = await pdd.fetchOrderDetail(page, listOrder.order_sn, { tabLabel })
    const merged = pdd.normalizeOrderDetail(detail.order.raw, { orderSn: listOrder.order_sn, listOrder, tabLabel })
    const final = detail.source === 'dom' ? detail.order : merged
    const outcome = store.upsertOrder(db, final, new Date().toISOString())
    ok++
    if (i % 5 === 0 || i === targets.length - 1) {
      log(`  [${i + 1}/${targets.length}] ${listOrder.order_sn} ${outcome} ${final.receiverName} ${final.receiverPhone} ${final.trackingNo}`)
    }
  } catch (error) {
    failed++
    log(`  跳过 ${listOrder.order_sn}: ${String(error.message).slice(0, 100)}`)
  }
  await pdd.humanPause(i, { minMs: 1200, maxMs: 2600, longEvery: 10 })
}

log(`完成：成功 ${ok}，失败 ${failed}`)
const s = store.stats(db)
log(`库里合计 ${s.total} 单，其中带物流号 ${s.withTracking}，带手机号 ${s.withPhone}，商品行 ${s.items}`)
store.finishRun(db, runId, {
  finishedAt: new Date().toISOString(),
  status: 'done',
  ordersSeen: collected.list.length,
  ordersNew: ok,
  ordersUpdated: 0,
  detailOk: ok,
  detailFailed: failed,
})
db.close()
page.close()

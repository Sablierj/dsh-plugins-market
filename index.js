/**
 * 拼多多工作台 · 功能一：待收货订单导出入库。
 *
 * 数据流：
 *   自动化 Chrome（独立 profile，扫码登录一次）
 *     → 订单列表页自然滚动到底（页面自己的列表响应里拿到 order_sn）
 *     → 逐个打开 order.html（真实页面），读页面已下发的 window.rawData
 *     → 归一化后写入本机 SQLite（~/.dsh-pdd-workbench/orders.db）
 *     → 查询 / 统计 / 导出 CSV
 *
 * 设计原则（按需求方的口径）：
 *  - 不调私有接口、不并发轰炸、不绕验证码；节奏按真人：慢滚、逐单、随机停顿。
 *  - 数据落在本机用户目录，不进仓库（里面有收货人手机号和地址）。
 *  - 只读页面已经渲染/已下发的内容，不改订单状态、不点确认收货。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { probe, connect, sleep } from './src/cdp.js'
import * as pdd from './src/pdd.js'
import * as store from './src/store.js'
import * as xianyu from './src/xianyu.js'
import * as ali1688 from './src/ali1688.js'
import * as env from './src/env.js'
import * as audit from './src/audit.js'
import * as pstatus from './src/platform-status.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const HERE_SCRIPTS = join(HERE, 'scripts')

const DATA_DIR = join(homedir(), '.dsh-pdd-workbench')
const CONFIG_FILE = join(DATA_DIR, 'config.json')
const DB_FILE = join(DATA_DIR, 'orders.db')
const EXPORT_DIR = join(DATA_DIR, 'exports')
const ALI_DOWNLOAD_DIR = join(DATA_DIR, 'downloads', '1688')
const PLATFORM_STATE_FILE = join(DATA_DIR, 'platform-state.json')
const API_PATH = '/pdd-workbench/api'

const DEFAULT_CONFIG = {
  cdpUrl: 'http://127.0.0.1:9335',
  chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  profileDir: join(DATA_DIR, 'chrome-profile'),
  autoLaunch: true,
  // 只采最近 N 天（含今天）：需求方口径「只要指定日期内的订单，一般近两天」
  recentDays: 2,
  refreshExisting: false,
  // xlsx 读写交给本机 Python（openpyxl），Node 侧不引第三方依赖
  pythonPath: 'C:\\Users\\78452\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
  xianyuTemplate: join(homedir(), 'Downloads', '批量发货导入模板.xlsx'),
  pacing: { minMs: 1500, maxMs: 3800, longEvery: 8 },
}

function nowIso() {
  return new Date().toISOString()
}

async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      pacing: { ...DEFAULT_CONFIG.pacing, ...(raw.pacing || {}) },
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

async function saveConfig(config) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
}

function db() {
  return store.openStore(DB_FILE)
}

function portOf(cdpUrl) {
  const match = /:(\d+)/.exec(String(cdpUrl || ''))
  return match ? Number(match[1]) : 9335
}

async function launchChrome(config) {
  const port = portOf(config.cdpUrl)
  await mkdir(config.profileDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${config.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    // 本机系统代理挂了会直接 ERR_PROXY_CONNECTION_FAILED，采集浏览器一律直连
    '--no-proxy-server',
    '--proxy-bypass-list=*',
    'about:blank',
  ]
  const child = spawn(config.chromePath, args, { detached: true, stdio: 'ignore' })
  child.unref()
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const p = await probe(config.cdpUrl)
    if (p.ok) return p
    await sleep(500)
  }
  const error = new Error(`Chrome 没能在 ${config.cdpUrl} 开起来，检查 chromePath / 端口占用`)
  error.code = 'NO_BROWSER'
  throw error
}

async function ensureBrowser(config) {
  const p = await probe(config.cdpUrl)
  if (p.ok) return { ...p, launched: false }
  if (!config.autoLaunch) {
    const error = new Error(`调试端口 ${config.cdpUrl} 没开，且 autoLaunch=false`)
    error.code = 'NO_BROWSER'
    throw error
  }
  const launched = await launchChrome(config)
  return { ...launched, launched: true }
}

/** 登录态判断：只读当前标签页 URL，不主动导航。 */
async function loginState(config) {
  const browser = await probe(config.cdpUrl)
  if (!browser.ok) return { browser: false, login: null, reason: '浏览器没开（调 action=login 会自己拉起来）' }
  const page = await connect(config.cdpUrl, { match: (url) => url.includes('pinduoduo.com'), pickExisting: true })
  try {
    const url = await page.currentUrl()
    if (!url) return { browser: true, login: null, reason: '标签页读不到地址' }
    return { browser: true, login: !/login\.html/.test(url), url }
  } finally {
    page.close()
  }
}

// ---------------------------------------------------------------------------
// 后台同步任务：工具调用只负责启动与查询，避免一次调用跑十几分钟
// ---------------------------------------------------------------------------

let activeRun = null

function publicRun(run) {
  if (!run) return null
  return {
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    seen: run.seen,
    done: run.done,
    inserted: run.inserted,
    updated: run.updated,
    failed: run.failed,
    currentOrderSn: run.currentOrderSn || null,
    messages: run.messages.slice(-8),
    error: run.error || null,
  }
}

async function runSync(config, { limit, refresh, sinceDate, untilDate, tabType = 3, tabLabel = '待收货' }) {
  const run = {
    runId: `sync-${Date.now()}`,
    status: 'running',
    startedAt: nowIso(),
    seen: 0,
    done: 0,
    inserted: 0,
    updated: 0,
    failed: 0,
    messages: [],
    currentOrderSn: null,
  }
  activeRun = run
  const dbHandle = db()
  const dbRunId = store.startRun(dbHandle, { scope: tabLabel, startedAt: run.startedAt })
  let page = null
  try {
    const browser = await ensureBrowser(config)
    run.messages.push(browser.launched ? '已拉起自动化浏览器' : '复用已开着的自动化浏览器')
    page = await connect(config.cdpUrl, {
      match: (url) => url.includes('/orders.html') || url.includes('/order.html'),
      pickExisting: true,
    })

    const collected = await pdd.collectOrderList(page, {
      sinceDate,
      tabType,
      onProgress: ({ scrolls, cards, orders, final }) => {
        if (final || scrolls % 20 === 0) run.messages.push(`列表滚动 ${scrolls} 次，卡片 ${cards}，已收 ${orders ?? 0} 单`)
      },
    })
    run.seen = collected.list.length
    run.messages.push(
      `列表完成：扫描 ${collected.scanned ?? run.seen} 单、${collected.pages} 页响应；` +
        `${sinceDate ? `${sinceDate} 起命中 ${run.seen} 单` : `去重后 ${run.seen} 单`}` +
        `${collected.reachedCutoff ? '（已滚到起始日之前，提前停）' : ''}`,
    )

    if (!run.seen) {
      run.status = 'done'
      run.messages.push('列表里没有订单（或页面没加载出来）')
      store.finishRun(dbHandle, dbRunId, {
        finishedAt: nowIso(),
        status: 'empty',
        ordersSeen: 0,
        ordersNew: 0,
        ordersUpdated: 0,
        detailOk: 0,
        detailFailed: 0,
      })
      return
    }

    const existing = new Set(dbHandle.prepare('SELECT order_sn FROM orders').all().map((row) => row.order_sn))
    let targets = collected.list
    if (untilDate) targets = targets.filter((order) => pdd.dateOfOrderSn(order.order_sn) <= untilDate)
    if (!refresh) targets = targets.filter((order) => !existing.has(order.order_sn))
    if (limit) targets = targets.slice(0, limit)
    run.messages.push(`待抓详情 ${targets.length} 单（已入库跳过 ${run.seen - targets.length} 单）`)

    for (let i = 0; i < targets.length; i++) {
      const listOrder = targets[i]
      run.currentOrderSn = listOrder.order_sn
      try {
        const detail = await pdd.fetchOrderDetail(page, listOrder.order_sn, { tabLabel })
        const merged = pdd.normalizeOrderDetail(detail.order.raw, { orderSn: listOrder.order_sn, listOrder, tabLabel })
        const finalOrder = detail.source === 'dom' ? detail.order : merged
        const outcome = store.upsertOrder(dbHandle, finalOrder, nowIso())
        run[outcome === 'inserted' ? 'inserted' : 'updated']++
        run.done++
      } catch (error) {
        run.failed++
        run.messages.push(`跳过 ${listOrder.order_sn}：${String((error && error.message) || error).slice(0, 120)}`)
        if (error && /login\.html|验证码|risk|风控/i.test(String(error.message))) throw error
      }
      await pdd.humanPause(i, config.pacing)
    }
    run.status = 'done'
    store.finishRun(dbHandle, dbRunId, {
      finishedAt: nowIso(),
      status: 'done',
      ordersSeen: run.seen,
      ordersNew: run.inserted,
      ordersUpdated: run.updated,
      detailOk: run.done,
      detailFailed: run.failed,
    })
  } catch (error) {
    run.status = 'failed'
    run.error = String((error && error.message) || error)
    if (error && error.code === 'NOT_LOGGED_IN') run.messages.push('未登录：请调 action=login 扫码后再跑')
    try {
      store.finishRun(dbHandle, dbRunId, {
        finishedAt: nowIso(),
        status: 'failed',
        ordersSeen: run.seen,
        ordersNew: run.inserted,
        ordersUpdated: run.updated,
        detailOk: run.done,
        detailFailed: run.failed,
        error: run.error,
      })
    } catch {
      /* ignore */
    }
  } finally {
    run.finishedAt = nowIso()
    run.currentOrderSn = null
    if (page) page.close()
    dbHandle.close()
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function actionStatus(config) {
  const login = await loginState(config)
  const handle = db()
  let dbStats
  try {
    dbStats = store.stats(handle)
  } finally {
    handle.close()
  }
  return {
    ok: true,
    browser: {
      cdpUrl: config.cdpUrl,
      connected: login.browser,
      login: login.login,
      currentUrl: login.url || null,
      reason: login.reason || null,
    },
    profileDir: config.profileDir,
    database: { path: DB_FILE, exists: existsSync(DB_FILE), ...dbStats },
    ...(await platformReadiness(login.browser)),
    running: publicRun(activeRun),
  }
}

/** 登录成功后顺手把缓存刷新，面板立刻显示「已登录」。 */
async function rememberLogin(platformId, login, detail) {
  const state = await pstatus.readState(PLATFORM_STATE_FILE).catch(() => ({}))
  state[platformId] = { login, detail: detail || '', checkedAt: new Date().toISOString() }
  await pstatus.writeState(PLATFORM_STATE_FILE, state).catch(() => {})
}

/** 两个平台的登录态（读缓存 → 翻成人话），面板每 5 秒调用也不卡。 */
async function platformReadiness(connected) {
  const state = await pstatus.readState(PLATFORM_STATE_FILE)
  const list = pstatus.PLATFORMS.map((platform) => pstatus.readiness(platform, state[platform.id], { connected }))
  return { platforms: list, platformSummary: pstatus.summarize(list) }
}

/** 真去查一次两个平台的登录态（要开页面，10~30 秒），结果写缓存。 */
async function actionCheckLogin(config) {
  const state = await env.checkPlatforms(config, {
    connect,
    pdd,
    ali1688,
    writeState: pstatus.writeState,
    stateFile: PLATFORM_STATE_FILE,
  })
  const probeResult = await probe(config.cdpUrl).catch(() => ({ ok: false }))
  const list = pstatus.PLATFORMS.map((platform) => pstatus.readiness(platform, state[platform.id], { connected: probeResult.ok }))
  const summary = pstatus.summarize(list)
  return {
    ok: true,
    connected: probeResult.ok,
    checkedAt: state.checkedAt,
    platforms: list,
    summary,
    hint: summary.ready ? '两个平台都已登录，可以开始采集' : '按 guide 里的按钮去扫码登录，登录完再点一次「检测登录」',
  }
}

async function actionLogin(config, { url }) {
  const browser = await ensureBrowser(config)
  const page = await connect(config.cdpUrl, { match: (u) => u.includes('pinduoduo.com'), pickExisting: true })
  try {
    if (url) {
      await page.navigate(url)
    } else {
      const current = await page.currentUrl()
      if (!current || /about:blank/.test(current)) await page.navigate(pdd.ORDERS_URL)
    }
    const landed = await page.currentUrl()
    if (/login\.html/.test(landed)) {
      const switched = await page.evaluate(`(() => {
        const el = [...document.querySelectorAll('span')].find((e) => e.textContent.trim() === '扫码登录')
        if (el) { el.click(); return true }
        return false
      })()`)
      return {
        ok: true,
        launched: browser.launched,
        needScan: true,
        qrTab: Boolean(switched),
        message: '自动化浏览器已打开登录页，请用拼多多 App 扫码登录；登录后回话调 action=export',
        url: await page.currentUrl(),
      }
    }
    await rememberLogin('pdd', true, '已登录（订单页可读）')
    return { ok: true, launched: browser.launched, needScan: false, url: landed }
  } finally {
    page.close()
  }
}

/** 打开自动化浏览器并停在 1688 买家工作台，让用户扫一次码。 */
async function actionLogin1688(config) {
  const browser = await ensureBrowser(config)
  const page = await connect(config.cdpUrl, {
    match: (u) => u.includes('1688.com'),
    pickExisting: true,
    newTabUrl: ali1688.BUYER_ORDERS_URL,
  })
  try {
    const current = await page.currentUrl().catch(() => '')
    if (!current || /about:blank/.test(current) || !/1688\.com/.test(current)) {
      await page.navigate(ali1688.BUYER_ORDERS_URL)
    }
    await page.waitForReady(45000).catch(() => {})
    const login = await ali1688.detectLogin(page).catch(() => ({ login: null, reason: '检测失败（页面可能还在加载）' }))
    if (login.login === true) await rememberLogin('1688', true, '已登录（1688 工作台可读）')
    if (login.login === false) await rememberLogin('1688', false, login.reason || '未登录')
    return {
      ok: true,
      launched: browser.launched,
      url: await page.currentUrl().catch(() => ''),
      login: login.login,
      reason: login.reason,
      message: login.login
        ? '1688 已是登录态，可以直接跑 action=sync1688'
        : '自动化浏览器已停在 1688 工作台，请在这个窗口里扫码登录，登录后回话调 action=sync1688',
    }
  } finally {
    page.close()
  }
}

/** 解析列表类动作的日期口径：默认近 N 天；days=0 表示全部。 */
function dateScope(config, args) {
  const explicitDays = Number(args.days)
  const days = Number.isFinite(explicitDays) && explicitDays >= 0 ? explicitDays : Number(config.recentDays) || 2
  const dateFrom = args.from ? String(args.from) : days > 0 ? pdd.sinceDateForDays(days) : ''
  const dateTo = args.to ? String(args.to) : ''
  return { days, dateFrom, dateTo }
}

function actionList(config, args) {
  const handle = db()
  try {
    const scope = dateScope(config, args)
    const tabLabel = args.tab && pdd.TAB_LABELS[args.tab] ? pdd.TAB_LABELS[args.tab] : args.tab && args.tab !== 'all' ? String(args.tab) : ''
    const rows = store.queryOrders(handle, {
      tab: tabLabel || null,
      platform: args.platform && args.platform !== 'all' ? String(args.platform) : '',
      keyword: args.keyword || '',
      dateFrom: scope.dateFrom,
      dateTo: scope.dateTo,
      limit: Math.min(Number(args.limit) || 50, 500),
      offset: Number(args.offset) || 0,
      withItems: Boolean(args.withItems),
      order: args.order === 'desc' ? 'desc' : 'asc',
    })
    return { ok: true, scope, count: rows.length, rows }
  } finally {
    handle.close()
  }
}

function actionStats(config) {
  const handle = db()
  try {
    return { ok: true, database: DB_FILE, ...store.stats(handle) }
  } finally {
    handle.close()
  }
}

async function actionExportCsv(config, args) {
  const handle = db()
  try {
    const tab = args.tab && pdd.TAB_LABELS[args.tab] ? pdd.TAB_LABELS[args.tab] : args.tab && args.tab !== 'all' ? String(args.tab) : ''
    const scope = dateScope(config, args)
    const rows = store.exportRows(handle, { tab: tab || undefined, platform: args.platform && args.platform !== 'all' ? String(args.platform) : undefined, dateFrom: scope.dateFrom, dateTo: scope.dateTo })
    if (!rows.length) {
      return { ok: true, rows: 0, scope, message: `没有 ${scope.dateFrom || '全部'} 之后的订单，先跑 action=export` }
    }
    const csv = store.toCsv(rows)
    await mkdir(EXPORT_DIR, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = join(EXPORT_DIR, `pdd-${tab || '全部'}-${stamp}.csv`)
    await writeFile(file, csv, 'utf8')
    return { ok: true, file, rows: rows.length, bytes: Buffer.byteLength(csv), scope }
  } finally {
    handle.close()
  }
}

async function actionExport(config, args) {
  if (activeRun && activeRun.status === 'running') {
    return { ok: false, code: 'ALREADY_RUNNING', error: '上一轮还在跑', running: publicRun(activeRun) }
  }
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 0
  const refresh = args.refresh === undefined ? Boolean(config.refreshExisting) : Boolean(args.refresh)
  // 只采「指定日期内」，默认近 N 天（config.recentDays，一般是 2）
  const days = Number(args.days) > 0 ? Number(args.days) : Number(config.recentDays) || 2
  const sinceDate = args.from ? String(args.from) : pdd.sinceDateForDays(days)
  const untilDate = args.to ? String(args.to) : ''
  const tab = args.tab === 'pending' || args.tab === 'shipped' ? args.tab : 'both'

  const runTab = async (key) => {
    await runSync(config, {
      limit,
      refresh,
      sinceDate,
      untilDate,
      tabType: pdd.TAB_TYPES[key],
      tabLabel: pdd.TAB_LABELS[key],
    })
  }
  // 两个页签串行跑（同一个浏览器窗口，不能并发）
  ;(async () => {
    if (tab === 'both') {
      await runTab('pending')
      await sleep(2000)
      await runTab('shipped')
    } else {
      await runTab(tab)
    }
  })().catch(() => {})

  await sleep(200)
  return {
    ok: true,
    runId: activeRun ? activeRun.runId : null,
    scope: { sinceDate, untilDate: untilDate || '今天', days, tab },
    message: `已开始后台同步（${tab === 'both' ? '待发货 + 已发货' : pdd.TAB_LABELS[tab]}，只采 ${sinceDate} 起），用 action=status 查进度`,
  }
}

async function actionGetOrder(config, args) {
  const handle = db()
  try {
    const row = handle.prepare('SELECT * FROM orders WHERE order_sn = ?').get(args.orderSn)
    if (!row) return { ok: false, code: 'NOT_FOUND', error: `库里没有 ${args.orderSn}` }
    row.items = handle.prepare('SELECT * FROM order_items WHERE order_sn = ?').all(args.orderSn)
    delete row.raw_json
    return { ok: true, order: row }
  } finally {
    handle.close()
  }
}

// ---------------------------------------------------------------------------
// 闲鱼：导入 / 配对 / 导出批量发货模板
// ---------------------------------------------------------------------------

function actionXianyuList(config, args) {
  const handle = db()
  try {
    const rows = store.listXianyuOrders(handle, { status: args.status || '', limit: Math.min(Number(args.limit) || 100, 1000) })
    const matches = new Map(store.listMatches(handle).map((m) => [m.xy_sn, m]))
    return {
      ok: true,
      count: rows.length,
      rows: rows.map((row) => ({
        xy_sn: row.xy_sn,
        status: row.status,
        receiver: row.receiver,
        phone: row.phone || row.phone_masked,
        address: row.address,
        item_title: row.item_title,
        order_time: row.order_time,
        match: matches.get(row.xy_sn) || null,
        mark: audit.decorateMatch(matches.get(row.xy_sn)),
      })),
    }
  } finally {
    handle.close()
  }
}

async function actionImportXianyu(config, args) {
  if (!args.path) {
    return { ok: false, code: 'NEED_PATH', error: '要给 xlsx 路径（例如 C:\\Users\\78452\\Downloads\\所有订单20260729-20261027.xlsx）' }
  }
  const records = await xianyu.readXlsxRecords(config.pythonPath, args.path, tmpdir())
  const parsed = xianyu.parseXianyuRecords(records)
  const handle = db()
  try {
    for (const order of parsed) store.upsertXianyuOrder(handle, order, nowIso())
    const byStatus = {}
    for (const order of parsed) byStatus[order.status] = (byStatus[order.status] || 0) + 1
    return { ok: true, file: args.path, imported: parsed.length, byStatus }
  } finally {
    handle.close()
  }
}

function actionMatchXianyu(config, args) {
  const handle = db()
  try {
    const xyOrders = store.listXianyuOrders(handle, { limit: 5000 })
    const pddOrders = handle
      .prepare(
        `SELECT o.*, (SELECT goods_name FROM order_items i WHERE i.order_sn = o.order_sn LIMIT 1) AS goods_name
         FROM orders o`,
      )
      .all()
    const existing = new Map(handle.prepare('SELECT * FROM order_matches').all().map((row) => [row.xy_sn, row]))
    const results = xianyu.runMatch(xyOrders, pddOrders, existing)
    const now = nowIso()
    for (const result of results) store.upsertMatch(handle, result, now)
    // 这次没算出结果的闲鱼单，清掉旧结论（人工确认的保留）
    const keep = new Set(results.map((result) => result.xySn))
    for (const order of xyOrders) {
      if (keep.has(order.xy_sn)) continue
      const stale = existing.get(order.xy_sn)
      if (stale && stale.decision !== 'manual') store.deleteMatch(handle, order.xy_sn)
    }
    const summary = { auto: 0, candidate: 0, unmatched: 0 }
    for (const result of results) summary[result.decision] = (summary[result.decision] || 0) + 1
    return { ok: true, xyTotal: xyOrders.length, pddTotal: pddOrders.length, ...summary, updated: results.length }
  } finally {
    handle.close()
  }
}

/** 拼多多快递公司名 → 闲鱼批量发货模板接受的名称。 */
function mapCarrier(carrier, carriers) {
  const text = String(carrier || '').trim()
  if (!text) return ''
  const exact = carriers.find((item) => item.name === text)
  if (exact) return exact.name
  for (const item of carriers) {
    if (item.short && (text.includes(item.short) || item.short.includes(text))) return item.name
    if (text.includes(item.name) || item.name.includes(text)) return item.name
  }
  return text
}

async function actionExportShipping(config, args) {
  const template = args.template || config.xianyuTemplate
  if (!existsSync(template)) {
    return { ok: false, code: 'NO_TEMPLATE', error: `找不到闲鱼批量发货模板：${template}` }
  }
  const handle = db()
  try {
    const rows = handle
      .prepare(
        `SELECT m.xy_sn, m.decision, m.source_platform, x.status AS xy_status, x.receiver AS xy_receiver, x.phone AS xy_phone,
                o.order_sn AS pdd_sn, o.platform AS order_platform, o.status_text AS pdd_status, o.tracking_no, o.carrier,
                o.receiver_name AS pdd_receiver
         FROM order_matches m
         JOIN xianyu_orders x ON x.xy_sn = m.xy_sn
         JOIN orders o ON o.order_sn = m.pdd_sn
         WHERE m.decision IN ('auto', 'manual')`,
      )
      .all()
    const ready = rows.filter(
      (row) => row.xy_status === '待发货' && row.tracking_no && /待收货|已签收/.test(row.pdd_status || ''),
    )
    if (!ready.length) return { ok: true, rows: 0, message: '没有「闲鱼待发货 + 来源已发货」的订单可导出' }

    const carriersFile = join(tmpdir(), `pdd-carriers-${Date.now()}.json`)
    await execFileAsync(config.pythonPath, [join(HERE_SCRIPTS, 'xlsx_tool.py'), 'carriers', template, carriersFile], { windowsHide: true })
    const carriers = JSON.parse(await readFile(carriersFile, 'utf8'))
    const templateNames = new Set(carriers.map((item) => item.name))
    const unmapped = new Set()

    const payload = {
      rows: ready.map((row) => {
        // 先查自定义映射表（平台原样名 → 模板名），再按模板里的简称兜底
        const resolved = store.resolveCarrier(handle, row.source_platform || row.order_platform || 'pdd', row.carrier)
        const mapped = templateNames.has(resolved.target) ? resolved.target : mapCarrier(resolved.target, carriers)
        if (!templateNames.has(mapped)) unmapped.add(`${row.carrier} → ${mapped}`)
        return { orderSn: row.xy_sn, carrier: mapped, tracking: row.tracking_no }
      }),
    }
    await mkdir(EXPORT_DIR, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = join(EXPORT_DIR, `闲鱼批量发货-${stamp}.xlsx`)
    const payloadFile = join(tmpdir(), `pdd-shipping-${Date.now()}.json`)
    await writeFile(payloadFile, JSON.stringify(payload), 'utf8')
    await execFileAsync(config.pythonPath, [join(HERE_SCRIPTS, 'xlsx_tool.py'), 'write-shipping', template, file, payloadFile], { windowsHide: true })
    return {
      ok: true,
      file,
      rows: ready.length,
      skipped: rows.length - ready.length,
      unmappedCarriers: [...unmapped],
      hint: unmapped.size ? '这些快递名不在模板的「物流公司」表里，先补 carrierMap 再导一次' : '',
    }
  } finally {
    handle.close()
  }
}

async function actionExportXlsx(config, args) {
  const handle = db()
  try {
    const tab = args.tab && args.tab !== 'all' ? pdd.TAB_LABELS[args.tab] : ''
    const scope = dateScope(config, args)
    const rows = store.exportRows(handle, { tab, platform: args.platform && args.platform !== 'all' ? String(args.platform) : undefined, dateFrom: scope.dateFrom, dateTo: scope.dateTo })
    if (!rows.length) return { ok: true, rows: 0, scope, message: '这个范围里没有订单' }
    const columns = ['订单号', '物流单号', '快递公司', '商品信息', '规格', '数量', '商家店铺名称', '收货人', '收货人手机号', '收货地址', '订单状态', '实付金额', '下单时间', '发货时间', '采集时间']
    const widths = { 订单号: 22, 物流单号: 24, 快递公司: 10, 商品信息: 52, 规格: 34, 数量: 6, 商家店铺名称: 18, 收货人: 10, 收货人手机号: 14, 收货地址: 60, 订单状态: 10, 实付金额: 10, 下单时间: 20, 发货时间: 20, 采集时间: 20 }
    const payloadFile = join(tmpdir(), `pdd-orders-${Date.now()}.json`)
    await writeFile(payloadFile, JSON.stringify({ columns, rows, widths }), 'utf8')
    await mkdir(EXPORT_DIR, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = join(EXPORT_DIR, `拼多多订单-${tab || '全部'}-${stamp}.xlsx`)
    await execFileAsync(config.pythonPath, [join(HERE_SCRIPTS, 'xlsx_tool.py'), 'write-orders', file, payloadFile], { windowsHide: true })
    return { ok: true, file, rows: rows.length, scope }
  } finally {
    handle.close()
  }
}

function actionOpenDir(config, args) {
  const target = args.path && String(args.path).trim() ? String(args.path) : EXPORT_DIR
  // 只允许打开导出目录：避免这条命令变成任意路径执行器
  if (!target.startsWith(EXPORT_DIR)) {
    return { ok: false, code: 'DIR_NOT_ALLOWED', error: `只允许打开导出目录：${EXPORT_DIR}` }
  }
  spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
  return { ok: true, dir: target }
}

/** 打开数据目录（库文件所在处），只允许 DATA_DIR 本身。 */
function actionOpenDataDir(config) {
  spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref()
  return { ok: true, dir: DATA_DIR, database: DB_FILE }
}

/**
 * 导入 1688「导出当前条件」下载的 xlsx。
 * 1688 的导出一次给 50 列（订单号/下单时间/状态/收货人/地址/手机/物流公司/运单号/货品/数量），
 * 所以不需要逐单抓详情页。
 */
/** 人工指定某条闲鱼单用哪个来源订单（manual 不会被自动核对覆盖）。 */
function actionSetMatch(config, args) {
  if (!args.xySn || !args.orderSn) {
    return { ok: false, code: 'NEED_ARGS', error: '要给 xySn 和 orderSn' }
  }
  const handle = db()
  try {
    const order = handle.prepare('SELECT order_sn, platform, status_text, tracking_no FROM orders WHERE order_sn = ?').get(args.orderSn)
    if (!order) return { ok: false, code: 'NOT_FOUND', error: `库里没有 ${args.orderSn}` }
    const previous = store.matchOf(handle, args.xySn)
    store.upsertMatch(
      handle,
      {
        xySn: args.xySn,
        pddSn: order.order_sn,
        sourcePlatform: order.platform,
        altSn: previous && previous.pdd_sn !== order.order_sn ? previous.pdd_sn : '',
        altPlatform: previous && previous.pdd_sn !== order.order_sn ? previous.source_platform : '',
        score: 1,
        scoreAlt: previous ? previous.score : null,
        method: '人工指定',
        decision: 'manual',
        note: args.note || '',
      },
      nowIso(),
    )
    return { ok: true, xySn: args.xySn, orderSn: order.order_sn, platform: order.platform, status: order.status_text, tracking: order.tracking_no }
  } finally {
    handle.close()
  }
}

/** 采集前自检：环境 + 登录态。 */
async function actionPreflight(config, args) {
  const handle = db()
  let stats
  try {
    stats = store.stats(handle)
  } finally {
    handle.close()
  }
  const base = await env.preflight(config, {
    dbStats: stats,
    dbPath: DB_FILE,
    dataDir: DATA_DIR,
    exportDir: EXPORT_DIR,
    downloadDir: ALI_DOWNLOAD_DIR,
  })
  if (!args.deep) return { ...base, deep: false }
  const login = await env.loginChecks(config, { connect, pdd, ali1688 })
  const checks = [...base.checks, ...login]
  const failed = checks.filter((c) => c.status === 'fail')
  const warned = checks.filter((c) => c.status === 'warn')
  return {
    ...base,
    deep: true,
    ok: failed.length === 0,
    ready: failed.length === 0,
    summary: failed.length ? `${failed.length} 项不满足` : warned.length ? `可用（${warned.length} 项提醒）` : '全部就绪',
    checks,
  }
}

/** 快递映射表：list / set / del。 */
function actionCarrierMap(config, args) {
  const handle = db()
  try {
    const op = args.op || 'list'
    if (op === 'list') {
      return { ok: true, rows: store.listCarrierMap(handle, { platform: args.platform || '' }), defaults: store.DEFAULT_CARRIERS }
    }
    if (op === 'set') {
      if (!args.sourceName || !args.targetName) return { ok: false, code: 'NEED_ARGS', error: '要给 sourceName 与 targetName' }
      store.upsertCarrierMap(handle, {
        platform: args.platform || '*',
        sourceName: args.sourceName,
        targetName: args.targetName,
        note: args.note || '',
      }, nowIso())
      return { ok: true, platform: args.platform || '*', sourceName: args.sourceName, targetName: args.targetName }
    }
    if (op === 'del') {
      if (!args.sourceName) return { ok: false, code: 'NEED_ARGS', error: '要给 sourceName' }
      store.deleteCarrierMap(handle, args.platform || '*', args.sourceName)
      return { ok: true, deleted: args.sourceName }
    }
    return { ok: false, code: 'BAD_OP', error: `不认识的 op: ${op}` }
  } finally {
    handle.close()
  }
}

function actionStatusHistory(config, args) {
  const handle = db()
  try {
    return { ok: true, rows: store.listStatusHistory(handle, { orderSn: args.orderSn || '', limit: Math.min(Number(args.limit) || 100, 500) }) }
  } finally {
    handle.close()
  }
}

/** 智能审核：全库一致性体检（只读）。 */
function actionAudit(config, args) {
  const handle = db()
  try {
    return { ok: true, ...audit.runAudit(handle, { limit: Math.min(Number(args.limit) || 500, 2000) }) }
  } finally {
    handle.close()
  }
}

const CSV_ESCAPE = (value) => {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 核对明细导出：每条闲鱼单一行，带标识（已匹配/待确认/未匹配/人工确认）。 */
async function actionExportMatches(config, args) {
  const handle = db()
  try {
    const rows = store.listMatchSheet(handle)
    if (!rows.length) return { ok: true, rows: 0, message: '还没有闲鱼订单，先跑 importXianyu' }
    const header = ['闲鱼订单号', '闲鱼状态', '收件人', '号码', '商品', '来源平台', '来源单号', '来源状态', '运单号', '快递', '匹配分', '置信度', '标识', '需要人工', '依据', '另一候选']
    const lines = [header.join(',')]
    for (const row of rows) {
      const mark = audit.decorateMatch(row)
      lines.push(
        [
          row.xy_sn,
          row.xy_status,
          row.xy_receiver,
          row.xy_phone,
          row.xy_item,
          row.pdd_sn ? (row.source_platform === '1688' ? '1688' : '拼多多') : '',
          row.pdd_sn,
          row.pdd_status,
          row.tracking_no,
          row.carrier,
          mark.score == null ? '' : mark.score,
          mark.confidence,
          mark.label,
          mark.needsReview ? '是' : '否',
          row.method,
          row.alt_sn ? `${row.alt_platform === '1688' ? '1688' : '拼多多'} ${row.alt_sn}` : '',
        ]
          .map(CSV_ESCAPE)
          .join(','),
      )
    }
    await mkdir(EXPORT_DIR, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = join(EXPORT_DIR, `核对明细-${stamp}.csv`)
    await writeFile(file, '\uFEFF' + lines.join('\r\n'), 'utf8')
    const needReview = rows.filter((row) => audit.decorateMatch(row).needsReview).length
    return { ok: true, file, rows: rows.length, needReview }
  } finally {
    handle.close()
  }
}

/** 自动找最新的 1688 导出文件并导入（插件下载目录 + 用户下载目录都看）。 */
async function actionImport1688Latest(config, args) {
  const { readdir, stat } = await import('node:fs/promises')
  const dirs = [ALI_DOWNLOAD_DIR, join(homedir(), 'Downloads')]
  const found = []
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [])
    for (const name of names) {
      if (!/\.(xlsx|xls)$/i.test(name) || name.startsWith('~$')) continue
      const info = await stat(join(dir, name)).catch(() => null)
      if (info) found.push({ file: join(dir, name), name, mtime: info.mtimeMs, size: info.size })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  const newest = found[0]
  if (!newest) return { ok: false, code: 'NO_FILE', error: '下载目录里没有 xlsx' }
  if (args.maxAgeHours && Date.now() - newest.mtime > args.maxAgeHours * 3600000) {
    return { ok: false, code: 'TOO_OLD', error: `最新的 xlsx 是 ${new Date(newest.mtime).toLocaleString()}，超过 ${args.maxAgeHours} 小时`, file: newest.file }
  }
  const result = await actionImport1688(config, { path: args.path || newest.file })
  return { ...result, picked: newest.file, mtime: new Date(newest.mtime).toISOString() }
}

/**
 * 1688 自动导出：打开工作台 → 点「导出当前条件」→ 点「生成新报表」。
 * 新版工作台是 Quark Web Components + 报表中心（两次导出要间隔 5 分钟），
 * 脚本点不中时返回 NEED_MANUAL，交给用户点两下、插件再自动取文件。
 */
async function actionSync1688(config, args) {
  const browser = await ensureBrowser(config)
  // 直接开「过滤好的列表」：状态 + 每页 100 条都能用 URL 定死，不用靠点 tab
  const tradeStatus = ['waitbuyerpay', 'waitsellersend', 'waitbuyerreceive'].includes(args.status) ? String(args.status) : 'waitbuyerreceive'
  const pageSize = [10, 20, 30, 50, 100].includes(Number(args.pageSize)) ? Number(args.pageSize) : 100
  const listUrl = ali1688.ORDER_LIST_URL(tradeStatus, pageSize)
  const page = await connect(config.cdpUrl, {
    match: (u) => u.includes('1688.com'),
    pickExisting: true,
    newTabUrl: listUrl,
  })
  try {
    const current = await page.currentUrl().catch(() => '')
    if (!/air\.1688\.com.*buyer-order-list/.test(current)) {
      await page.navigate(listUrl)
      await page.waitForReady(45000).catch(() => {})
      await sleep(3000)
    }
    const dismissed = await ali1688.dismissOnboarding(page).catch(() => 0)
    const counts = await ali1688.readCounts(page).catch(() => ({}))
    if (!Object.keys(counts).length) {
      return { ok: false, code: 'NOT_LOGGED_IN', error: '看不到订单计数，可能没登录', url: await page.currentUrl().catch(() => ''), hint: '调 action=login1688 扫码' }
    }
    await ali1688.setDownloadDir(page, ALI_DOWNLOAD_DIR).catch(() => false)

    // 先记下报表中心已有的报表：后面只认「新出现的那一行」，避免下到旧报表
    const baseline = new Set((await ali1688.readReports(page).catch(() => [])).map((row) => row.time))

    const opened = await ali1688.clickExport(page, { prefer: '当前条件' }).catch((error) => ({ clicked: false, reason: String(error.message || error) }))
    if (!opened.clicked) {
      return { ok: false, code: 'NEED_MANUAL', counts, reason: opened.reason, steps: ['在采集浏览器里点「导出当前条件」', '弹窗里点「生成新报表」', '回话调 action=import1688Latest 自动导入'] }
    }
    await sleep(1200)

    // 弹窗可能停在「提示页」（含生成新报表）或「报表中心」（只有刷新/下载）
    const dialogText = await page
      .evaluate(`(() => {
        const WALK = (root, out = []) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) WALK(el.shadowRoot, out) } return out }
        const t = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
        const box = WALK(document).find((el) => t(el).startsWith('批量导出') && el.getBoundingClientRect().height > 100)
        return box ? t(box).slice(0, 400) : ''
      })()`)
      .catch(() => '')
    let generated = { clicked: false, skipped: true }
    if (/生成新报表/.test(dialogText)) {
      generated = await ali1688.clickDialogButton(page, '生成新报表', { timeoutMs: 8000 })
      await sleep(1500)
      await ali1688.clickDialogButton(page, '确认', { timeoutMs: 2500 }).catch(() => ({ clicked: false }))
      await sleep(1500)
    }

    // 等「本次新出现的那一行」导出成功并能下载（1688 自己提示可能要 5 分钟）
    let target = null
    for (let i = 0; i < 24; i++) {
      const rows = await ali1688.readReports(page).catch(() => [])
      target = rows.find((row) => !baseline.has(row.time) && row.status === 'success' && row.hasDownload) || null
      if (target) break
      await sleep(20000)
      await ali1688.clickDialogButton(page, '刷新', { timeoutMs: 1500 }).catch(() => null)
      await sleep(1000)
    }
    if (!target) {
      return {
        ok: false,
        code: 'REPORT_PENDING',
        counts,
        generated,
        knownReports: [...baseline].slice(0, 3),
        message: '报表还在「导出中」（1688 提示可能要 5 分钟），稍后调 action=import1688Latest 取文件，或再跑一次 sync1688',
      }
    }

    const downloaded = await ali1688.downloadReportRow(page, target, ALI_DOWNLOAD_DIR)
    if (!downloaded.ok) return { ok: false, code: 'DOWNLOAD_FAILED', counts, downloaded, message: downloaded.reason }

    const imported = await actionImport1688(config, { path: downloaded.file })
    return {
      ok: true,
      counts,
      dismissed,
      generated,
      report: target,
      downloaded: { file: downloaded.file, size: downloaded.size },
      imported,
      message: `已自动导出并入库：${target.time} 的报表 → ${imported.rows} 行 / ${imported.orders} 单（新增 ${imported.inserted}，更新 ${imported.updated}）`,
    }
  } finally {
    page.close()
  }
}

/**
 * 只取「还没入过库的最新报表」：报表中心里找 导出成功 + 有下载 的行，
 * 按台账跳过已经导过的，下载后入库。可以反复调，天然幂等。
 */
async function actionFetch1688Report(config, args) {
  const ledgerFile = join(DATA_DIR, 'ali1688-reports.json')
  let ledger = []
  try {
    ledger = JSON.parse(await readFile(ledgerFile, 'utf8'))
    if (!Array.isArray(ledger)) ledger = []
  } catch {
    ledger = []
  }
  const page = await connect(config.cdpUrl, {
    match: (u) => u.includes('1688.com'),
    pickExisting: true,
    newTabUrl: ali1688.ORDER_LIST_URL('waitbuyerreceive', 100),
  })
  try {
    await ali1688.clickExport(page, { prefer: '当前条件' }).catch(() => null)
    await sleep(1500)
    let rows = []
    for (let i = 0; i < 5; i++) {
      rows = await ali1688.readReports(page).catch(() => [])
      if (rows.length) break
      await ali1688.clickDialogButton(page, '查看过往导出报表', { timeoutMs: 2000 }).catch(() => null)
      await sleep(1200)
    }
    const done = rows.filter((row) => row.status === 'success' && row.hasDownload)
    const fresh = done.filter((row) => !ledger.includes(row.time))
    if (!fresh.length) {
      return { ok: false, code: 'NO_NEW_REPORT', total: rows.length, done: done.length, importedBefore: ledger.slice(-3) }
    }
    const target = fresh[0]
    await ali1688.setDownloadDir(page, ALI_DOWNLOAD_DIR).catch(() => false)
    const downloaded = await ali1688.downloadReportRow(page, target, ALI_DOWNLOAD_DIR)
    if (!downloaded.ok) return { ok: false, code: 'DOWNLOAD_FAILED', downloaded }
    const imported = await actionImport1688(config, { path: downloaded.file })
    ledger.push(target.time)
    await writeFile(ledgerFile, JSON.stringify(ledger, null, 1), 'utf8').catch(() => {})
    return {
      ok: true,
      report: target.time,
      file: downloaded.file,
      imported,
      message: `已取 ${target.time} 的报表并入库：${imported.rows} 行 / ${imported.orders} 单（新增 ${imported.inserted}，更新 ${imported.updated}）`,
    }
  } finally {
    page.close()
  }
}

async function actionImport1688(config, args) {
  if (!args.path) {
    return { ok: false, code: 'NEED_PATH', error: '要给 1688 导出的 xlsx 路径（工作台点「导出当前条件」下载的那个文件）' }
  }
  if (!existsSync(args.path)) {
    return { ok: false, code: 'FILE_NOT_FOUND', error: `找不到文件：${args.path}` }
  }
  const { orders, rows } = await ali1688.parseExportFile(config.pythonPath, args.path)
  const handle = db()
  try {
    let inserted = 0
    let updated = 0
    const now = nowIso()
    for (const order of orders) {
      const exists = handle.prepare('SELECT order_sn FROM orders WHERE order_sn = ?').get(order.orderSn)
      store.upsertOrder(handle, order, now)
      if (exists) updated++
      else inserted++
    }
    const byStatus = {}
    for (const order of orders) byStatus[order.statusText] = (byStatus[order.statusText] || 0) + 1
    return { ok: true, file: args.path, rows, orders: orders.length, inserted, updated, byStatus }
  } finally {
    handle.close()
  }
}

export async function runAction(args = {}) {
  const config = await loadConfig()
  switch (args.action) {
    case 'status':
      return actionStatus(config)
    case 'login':
      return actionLogin(config, args)
    case 'login1688':
      return actionLogin1688(config)
    case 'export':
      return actionExport(config, args)
    case 'list':
      return actionList(config, args)
    case 'stats':
      return actionStats(config)
    case 'exportCsv':
      return actionExportCsv(config, args)
    case 'order':
      return actionGetOrder(config, args)
    case 'importXianyu':
      return actionImportXianyu(config, args)
    case 'matchXianyu':
      return actionMatchXianyu(config, args)
    case 'xianyuList':
      return actionXianyuList(config, args)
    case 'exportShipping':
      return actionExportShipping(config, args)
    case 'exportXlsx':
      return actionExportXlsx(config, args)
    case 'openDir':
      return actionOpenDir(config, args)
    case 'openDataDir':
      return actionOpenDataDir(config)
    case 'import1688':
      return actionImport1688(config, args)
    case 'import1688Latest':
      return actionImport1688Latest(config, args)
    case 'sync1688':
      return actionSync1688(config, args)
    case 'fetch1688Report':
      return actionFetch1688Report(config, args)
    case 'preflight':
      return actionPreflight(config, args)
    case 'checkLogin':
      return actionCheckLogin(config)
    case 'audit':
      return actionAudit(config, args)
    case 'exportMatches':
      return actionExportMatches(config, args)
    case 'carrierMap':
      return actionCarrierMap(config, args)
    case 'statusHistory':
      return actionStatusHistory(config, args)
    case 'setMatch':
      return actionSetMatch(config, args)
    case 'config': {
      const patch = args.settings && typeof args.settings === 'object' ? args.settings : null
      const next = patch ? { ...config, ...patch } : config
      if (patch) {
        if (patch.pacing && typeof patch.pacing === 'object') next.pacing = { ...config.pacing, ...patch.pacing }
        await saveConfig(next)
      }
      return { ok: true, config: next }
    }
    default: {
      const error = new Error(`未知 action: ${args.action}`)
      error.code = 'BAD_ACTION'
      throw error
    }
  }
}

function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function handleApi(req, res) {
  const send = (status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }
  try {
    if (req.method === 'POST') {
      send(200, await runAction(await readBody(req)))
      return
    }
    send(200, await actionStatus(await loadConfig()))
  } catch (error) {
    send(500, { ok: false, code: (error && error.code) || null, error: String((error && error.message) || error) })
  }
}

export const inject = ['tools', 'systemPrompt', 'webServer']

export function apply(ctx) {
  // 契约 §4：apply() 里抛错会拖垮整棵插件树、Host 起不来。
  // 每个挂载点单独 try/catch：失败要大声报错，但不能带走 Host。
  const safe = (label, fn) => {
    try {
      ctx.effect(fn)
    } catch (error) {
      console.warn(`[pdd-workbench] ${label} 注册失败：`, String((error && error.message) || error))
    }
  }

  safe('systemPrompt', () =>
    ctx.systemPrompt.section({
      name: 'pdd-workbench-sop',
      order: 64,
      text: () =>
        [
          '## 拼多多工作台（pdd-workbench 插件）',
          '功能一：待收货订单导出入库（订单号/物流单号/商品/数量/店铺/收货人/手机号/地址 → 本机 SQLite）。',
          '**只采指定日期内的订单，日期以「下单时间」为准**：默认近 2 天（`days=2` = 今天 + 昨天，例如今天 2026-10-27 就取 10-26 00:00 ~ 10-27 23:59）；可用 `from/to` 指定区间；`days=0` 才是全部。',
          '- `pdd_workbench action=status`：浏览器是否连着、是否登录、库里有多少单。',
          '- `pdd_workbench action=login`：拉起自动化浏览器并切到扫码登录（登录必须用户自己扫码，不要代填任何凭证）。',
          '- `pdd_workbench action=export days=2`：后台同步最近两天（逐单打开真实订单页，约 2-4 秒/单），立刻返回 runId。',
          '- `pdd_workbench action=status` 轮询进度；`action=stats` 看总量；`action=list days=2` 查明细；`action=exportCsv days=2` 导出 CSV。',
          '遇到 `NOT_LOGGED_IN`：让用户在自动化浏览器窗口扫码，不要索取账号密码；遇到验证码：停下等人工处理。',
        ].join('\n'),
    }),
  )

  safe('tools', () =>
    ctx.tools.register({
      name: 'pdd_workbench',
      description:
        '拼多多工作台：把「待发货 / 已发货（待收货）」订单导出到本机 SQLite，并与闲鱼订单做智能核对。' +
        'action=status 看状态；login 扫码登录；export 后台同步（tab=pending/shipped/both）；stats 统计；list 查明细；' +
        'exportXlsx 导出 Excel；exportCsv 导出 CSV；openDir 打开导出目录；importXianyu 导入闲鱼订单；matchXianyu 智能核对；' +
        'xianyuList 看闲鱼核对结果；exportShipping 生成闲鱼批量发货模板；order 看单条；config 改配置。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'status',
              'preflight',
              'checkLogin',
              'login',
              'login1688',
              'export',
              'sync1688',
              'import1688',
              'import1688Latest',
              'fetch1688Report',
              'list',
              'stats',
              'audit',
              'exportCsv',
              'exportXlsx',
              'openDir',
              'openDataDir',
              'importXianyu',
              'matchXianyu',
              'xianyuList',
              'exportMatches',
              'exportShipping',
              'setMatch',
              'carrierMap',
              'statusHistory',
              'order',
              'config',
            ],
            description:
              'status=状态（含两平台登录态，读缓存秒回）；checkLogin=真去检测拼多多/1688 是否已登录；preflight=采集前自检（deep=true 加查登录态）；login/login1688=扫码登录；' +
              'export=拼多多后台同步（tab=pending 待发货 / shipped 已发货 / both）；sync1688=1688 自动导出；' +
              'import1688=导入指定 1688 导出文件；import1688Latest=自动找最新 1688 导出文件导入；' +
              'fetch1688Report=从 1688 报表中心下载最新未入库的报表并导入（幂等，可反复调）；' +
              'list=查明细；stats=统计；audit=智能审核（全库一致性体检）；exportCsv/exportXlsx=导出；' +
              'openDir=打开导出目录；openDataDir=打开数据目录；importXianyu=导入闲鱼订单；matchXianyu=智能核对；' +
              'xianyuList=核对结果（带标识/置信度）；exportMatches=导出核对明细（带标识、需人工列）；' +
              'exportShipping=生成闲鱼批量发货模板；setMatch=人工指定匹配；carrierMap=快递映射表 list/set/del；' +
              'statusHistory=状态变化留痕；order=单条；config=配置',
          },
          limit: {
            type: 'number',
            description: 'export：本轮最多抓多少单（默认 0=全部待抓）；list：返回条数（默认 50，上限 500）',
          },
          days: {
            type: 'number',
            description: '日期口径（按订单的下单时间）：只处理最近 N 天（含今天，默认取配置 recentDays=2）；传 0 = 不限日期',
          },
          from: { type: 'string', description: '指定起始日期 YYYY-MM-DD（覆盖 days）' },
          to: { type: 'string', description: '指定结束日期 YYYY-MM-DD（省略=今天）' },
          refresh: { type: 'boolean', description: 'export：已入库的订单也重新抓一遍（默认 false）' },
          tab: { type: 'string', description: 'pending=待发货 / shipped=已发货 / all=全部（list / export / exportXlsx / exportCsv 通用）' },
          order: { type: 'string', description: 'list：排序，asc=按下单时间升序（默认）/ desc=降序' },
          path: { type: 'string', description: 'importXianyu：xlsx 路径；openDir：只允许导出目录下的路径' },
          status: { type: 'string', description: 'xianyuList：按闲鱼订单状态过滤，例如 待发货' },
          platform: { type: 'string', description: 'list/export：来源平台 all | pdd | 1688' },
          xySn: { type: 'string', description: 'setMatch：闲鱼订单号' },
          orderSn: { type: 'string', description: 'setMatch：要绑定的来源订单号（拼多多或 1688）' },
          keyword: { type: 'string', description: 'list：按订单号/物流单号/店铺/收货人/电话/商品名模糊搜' },
          offset: { type: 'number', description: 'list：偏移量' },
          withItems: { type: 'boolean', description: 'list：是否带商品明细' },
          orderSn: { type: 'string', description: 'order：订单号' },
          url: { type: 'string', description: 'login：要打开的地址（默认订单列表）' },
          settings: {
            type: 'object',
            description: 'config：整包配置（cdpUrl/chromePath/profileDir/maxPerRun/pacing…）',
            additionalProperties: true,
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        // 契约 §3 坑 3：output.schema 用 {} 最稳（省略 type = 任意 JSON 值）
        schema: {},
        render(_args, value) {
          return [{ type: 'text', text: jsonText(value) }]
        },
      },
      async execute(args) {
        try {
          return await runAction(args)
        } catch (error) {
          return {
            ok: false,
            code: (error && error.code) || null,
            error: String((error && error.message) || error),
            hint:
              error && error.code === 'NOT_LOGGED_IN'
                ? '调 action=login，让用户在自动化浏览器里扫码'
                : error && error.code === 'NO_BROWSER'
                  ? '检查 config.chromePath / cdpUrl 端口'
                  : '',
          }
        }
      },
    }),
  )

  safe('webServer', () =>
    ctx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      async handler(req, res) {
        await handleApi(req, res)
      },
    }),
  )
}

/**
 * 1688（阿里巴巴）买家订单：解析「导出当前条件」下载的 xlsx。
 *
 * 为什么不逐单抓页面：1688 买家工作台自带「导出当前条件」，一次就能拿到 50 列，
 * 含订单号/下单时间/订单状态/收货人/地址/手机/物流公司/运单号/货品标题/数量——
 * 这正是我们要的全部字段，而且比逐单打开详情页轻得多（对平台更像正常操作）。
 *
 * 这个文件只做「把导出的行翻译成统一订单结构」，不碰浏览器。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile, unlink } from 'node:fs/promises'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const PY_TOOL = join(HERE, '..', 'scripts', 'xlsx_tool.py')

/** 1688 订单状态 → 我们的两态（待发货 / 待收货）。认不出就原样保留。 */
export function normalize1688Status(raw) {
  const text = String(raw || '').trim()
  if (!text) return { status: '', label: '' }
  if (/等待卖家发货|待发货|等待发货/.test(text)) return { status: '待发货', label: '待发货' }
  if (/等待买家确认收货|待收货|已发货|卖家已发货|运输中/.test(text)) return { status: '待收货', label: '待收货' }
  if (/等待买家付款|待付款/.test(text)) return { status: '待付款', label: '待付款' }
  if (/交易关闭|已取消|退款成功|交易取消/.test(text)) return { status: '已关闭', label: text }
  if (/交易成功|已完成|确认收货/.test(text)) return { status: '已完成', label: text }
  return { status: text, label: text }
}

const pick = (row, ...names) => {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== '') return String(row[name]).trim()
  }
  return ''
}

const toCents = (value) => {
  const text = String(value === undefined || value === null ? '' : value).replace(/[^\d.-]/g, '')
  if (!text || text === '-' || text === '.') return NaN // 空单元格是「没有」，不是 0
  const num = Number(text)
  return Number.isFinite(num) ? Math.round(num * 100) : NaN
}

/** 2026-10-29 08:10:31 → 2026-10-29T08:10:31+08:00（本地时区） */
export function toLocalIso(text) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(text || '').trim())
  if (!match) return ''
  const [, y, mo, d, h, mi, s = '00'] = match
  const pad = (value) => String(value).padStart(2, '0')
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}+08:00`
}

/** 一条导出行 → 统一订单结构（与拼多多同一套字段名）。 */
export function normalize1688Row(row) {
  const orderSn = pick(row, '订单编号', '订单号')
  if (!orderSn) return null
  const status = normalize1688Status(pick(row, '订单状态'))
  const orderTime = toLocalIso(pick(row, '订单创建时间', '下单时间'))
  const goodsTitle = pick(row, '货品标题', '商品名称', '商品标题')
  const qty = Number(pick(row, '数量')) || 0
  const unitPrice = toCents(pick(row, '单价(元)', '单价'))
  const payAmount = toCents(pick(row, '实付款(元)', '实付款'))
  const address = pick(row, '收货地址').replace(/\s+/g, '')
  const phone = pick(row, '联系手机', '联系电话').replace(/[^\d]/g, '')
  return {
    orderSn,
    platform: '1688',
    orderDate: orderTime ? orderTime.slice(0, 10) : '',
    tab: status.label || status.status,
    status: null,
    statusText: status.status || status.label,
    shopName: pick(row, '卖家公司名', '卖家会员名'),
    mallId: '',
    receiverName: pick(row, '收货人姓名'),
    receiverPhone: phone,
    receiverPhoneMasked: phone.includes('*') ? phone : '',
    province: '',
    city: '',
    district: '',
    address,
    trackingNo: pick(row, '运单号'),
    carrier: pick(row, '物流公司'),
    orderTime,
    shipTime: '',
    expectAutoReceive: '',
    receiveTime: '',
    goodsAmountCents: Number.isFinite(payAmount) ? payAmount : unitPrice * qty,
    payAmountCents: Number.isFinite(payAmount) ? payAmount : NaN,
    items: [
      {
        goodsId: pick(row, 'Offer ID'),
        skuId: pick(row, 'SKU ID'),
        goodsName: goodsTitle,
        spec: [pick(row, '型号'), pick(row, '货号')].filter(Boolean).join(' '),
        qty,
        unitPriceCents: unitPrice,
        thumbUrl: '',
        linkUrl: '',
      },
    ],
    raw: row,
  }
}

export function normalize1688Rows(records) {
  const orders = []
  const seen = new Set()
  for (const row of records) {
    const order = normalize1688Row(row)
    if (!order || seen.has(order.orderSn)) continue
    seen.add(order.orderSn)
    orders.push(order)
  }
  return orders
}

/** 读 1688 导出的 xlsx（复用 scripts/xlsx_tool.py 的 read-orders）。 */
export async function readExportRecords(pythonPath, file) {
  const out = join(tmpdir(), `ali1688-${Date.now()}.json`)
  await execFileAsync(pythonPath, [PY_TOOL, 'read-orders', file, out], { windowsHide: true })
  const text = await readFile(out, 'utf8')
  await unlink(out).catch(() => {})
  return JSON.parse(text)
}

export async function parseExportFile(pythonPath, file) {
  const records = await readExportRecords(pythonPath, file)
  return { orders: normalize1688Rows(records), rows: records.length }
}

// ---------------------------------------------------------------------------
// 浏览器侧：打开买家工作台 → 判断登录 → 点「导出当前条件」→ 等文件落地
// ---------------------------------------------------------------------------

export const BUYER_ORDERS_URL =
  'https://work.1688.com/?spm=mropc.24336601.workmenu.dbuylist.76665895ucutvm&_path_=buyer2017Base/procurement/buyList'

/**
 * 新版订单列表页（air.1688.com）：状态与每页条数都能用 URL 参数定死，省得靠点 tab 猜。
 *   tradeStatus=waitbuyerreceive（待收货）/ waitsellersend（待发货）/ waitbuyerpay（待付款）
 *   pageSize 实测可选 10 / 20 / 30 / 50 / 100（最大 100）
 */
export const ORDER_LIST_URL = (tradeStatus = 'waitbuyerreceive', pageSize = 100, page = 1) =>
  `https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?tradeStatus=${encodeURIComponent(tradeStatus)}&page=${page}&pageSize=${pageSize}`

/** 1688 状态值 ↔ 我们的两态 */
export const ALI_STATUS = {
  waitbuyerpay: '待付款',
  waitsellersend: '待发货',
  waitbuyerreceive: '待收货',
}

/** 登录检测：工作台里出现「登录」按钮/登录框 = 没登录；出现「我的阿里」/下单账号 = 已登录。 */
export async function detectLogin(page) {
  return page.evaluate(`(() => {
    const text = document.body ? document.body.innerText : ''
    if (/请登录|密码登录|扫码登录|登录后查看/.test(text)) return { login: false, reason: '页面要求登录' }
    if (/我的阿里|采购|买到的货品|全部订单/.test(text) && !/登录\\/注册/.test(text)) return { login: true, reason: '工作台可见' }
    return { login: null, reason: '判不出来（页面还没渲染完或改版）' }
  })()`)
}

/** 把下载目录设到插件自己的目录，免得文件和用户日常下载混在一起。 */
export async function setDownloadDir(page, dir) {
  try {
    await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir })
    return true
  } catch {
    try {
      await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true })
      return true
    } catch {
      return false
    }
  }
}

/** 1688 工作台是 Web Components（BUYER-WORKBENCH），按钮在 shadow DOM 里，必须穿透找。 */
const WALK_SHADOW = `(root, out = []) => {
  for (const el of root.querySelectorAll('*')) {
    out.push(el)
    if (el.shadowRoot) WALK(el.shadowRoot, out)
  }
  return out
}`

export async function clickExport(page, { prefer = '当前条件' } = {}) {
  const found = await page.evaluate(`(() => {
    const WALK = ${WALK_SHADOW}
    const all = WALK(document)
    const text = (el) => (el.innerText || el.textContent || '').trim()
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight
    }
    // 优先「文字正好是导出按钮」，避免点到包着两个按钮的容器
    const exact = all.filter((el) => /^导出(当前条件|所选订单)$/.test(text(el)) && visible(el))
    const loose = all.filter((el) => /^导出/.test(text(el)) && text(el).length <= 14 && visible(el))
    const pool = exact.length ? exact : loose
    if (!pool.length) return null
    const hit = pool.find((el) => text(el) === '导出' + ${JSON.stringify(prefer)}) || pool[0]
    const r = hit.getBoundingClientRect()
    return { text: text(hit), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (!found) return { clicked: false, reason: '页面上没找到「导出」按钮（可能还在加载/需要登录）' }
  // 真人节奏：先移动、停一下，再按下
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x - 40, y: found.y + 12 })
  await new Promise((r) => setTimeout(r, 180))
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x, y: found.y })
  await new Promise((r) => setTimeout(r, 260))
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: found.x, y: found.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 90))
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: found.x, y: found.y, button: 'left', clickCount: 1 })
  return { clicked: true, text: found.text, x: found.x, y: found.y }
}

/**
 * 用 CDP 的 DOM 搜索 + boxModel 点一个「按文字找到的」元素。
 * 1688 的新版工作台是 Quark Web Components，按钮宿主 getBoundingClientRect 会是 0，
 * 只有 DOM.getBoxModel 能拿到真实几何，所以这条路径才点得中。
 */
export async function clickByTextCDP(page, label, { exact = true, timeoutMs = 8000 } = {}) {
  await page.send('DOM.enable')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { searchId, resultCount } = await page.send('DOM.performSearch', {
      query: label,
      includeUserAgentShadowDOM: true,
    })
    if (resultCount > 0) {
      const { nodeIds } = await page.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: Math.min(resultCount, 20) })
      for (const nodeId of nodeIds) {
        const text = await page
          .send('DOM.getOuterHTML', { nodeId })
          .then((r) => (r.outerHTML || '').replace(/<[^>]+>/g, '').trim())
          .catch(() => '')
        if (exact ? text === label : text.includes(label)) {
          const model = await page.send('DOM.getBoxModel', { nodeId }).catch(() => null)
          if (model && model.model && model.model.width > 0) {
            const quad = model.model.content
            const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4)
            const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4)
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 36, y: y + 10 })
            await new Promise((r) => setTimeout(r, 170))
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
            await new Promise((r) => setTimeout(r, 250))
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
            await new Promise((r) => setTimeout(r, 90))
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
            await page.send('DOM.disable').catch(() => {})
            return { clicked: true, text, x, y }
          }
        }
      }
      await page.send('DOM.discardSearchResults', { searchId }).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  await page.send('DOM.disable').catch(() => {})
  return { clicked: false, reason: `没找到可点的「${label}」` }
}

/** 点掉「AI订单巡检」这类引导弹层（每步都有「跳过」）。 */export async function dismissOnboarding(page, { rounds = 4 } = {}) {
  let dismissed = 0
  for (let i = 0; i < rounds; i++) {
    const hit = await page.evaluate(`(() => {
      const WALK = ${WALK_SHADOW}
      const text = (el) => (el.innerText || el.textContent || '').trim()
      const el = WALK(document).find((node) => text(node) === '跳过' && node.getBoundingClientRect().width > 0)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (!hit) break
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y })
    await new Promise((r) => setTimeout(r, 150))
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 80))
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
    dismissed++
    await new Promise((r) => setTimeout(r, 700))
  }
  return dismissed
}

/** 读页面计数：待发货 N / 待收货 N（穿透 shadow DOM）。 */
export async function readCounts(page) {
  return page.evaluate(`(() => {
    const WALK = ${WALK_SHADOW}
    const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    const tabs = {}
    for (const el of WALK(document)) {
      const t = text(el)
      const m = /^(待付款|待发货|待收货|退款售后|待评价)\\s*(\\d+)?$/.exec(t)
      if (m && m[2]) tabs[m[1]] = Number(m[2])
    }
    return tabs
  })()`)
}

/** 等下载目录里出现新的 xlsx（默认等 60 秒）。 */
/**
 * 在弹窗里按文字点一个按钮（Q-BUTTON 或普通元素）。
 * 关键点：1688 会把同一个按钮渲染两份，一份 rect 为 0（隐藏副本），
 * 所以必须过滤掉零尺寸节点，否则永远点在 (0,0)。
 */
export async function clickDialogButton(page, label, { timeoutMs = 8000, exact = true } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = await page.evaluate(`(() => {
      const WALK = ${WALK_SHADOW}
      const t = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
      const nodes = WALK(document).filter((el) => {
        const text = t(el)
        const ok = ${exact ? `text === ${JSON.stringify(label)}` : `text.includes(${JSON.stringify(label)})`}
        if (!ok) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight
      })
      if (!nodes.length) return null
      // 取面积最小的那个（真正的按钮，而不是包了一整行的容器）
      const el = nodes.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return ra.width * ra.height - rb.width * rb.height
      })[0]
      const r = el.getBoundingClientRect()
      return { text: t(el), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
    })()`)
    if (hit) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x - 24, y: hit.y + 6 })
      await new Promise((r) => setTimeout(r, 160))
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y })
      await new Promise((r) => setTimeout(r, 240))
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 95))
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
      return { clicked: true, ...hit }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return { clicked: false, reason: `没找到可点的「${label}」` }
}

/** 报表中心里最新一行是否已生成好（能点「下载」）。 */
export async function findDownloadLink(page) {
  return page.evaluate(`(() => {
    const WALK = ${WALK_SHADOW}
    const t = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    const links = WALK(document)
      .filter((el) => t(el) === '下载')
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { tag: el.tagName, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
      })
      .filter((n) => n.w > 0 && n.h > 0)
      .sort((a, b) => a.y - b.y)
    return links[0] || null
  })()`)
}

/** 读报表中心的行：[{ time, status, hasDownload, coords }]，按界面顺序（最新在上）。 */
export async function readReports(page) {
  return page.evaluate(`(() => {
    const WALK = ${WALK_SHADOW}
    const t = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    const rows = WALK(document).filter((el) => el.tagName === 'Q-TABLE-TR' || el.tagName === 'TR')
    const out = []
    for (const row of rows) {
      const text = t(row)
      const time = (text.match(/\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}/) || [])[0] || ''
      if (!time) continue
      const status = /导出成功/.test(text) ? 'success' : /导出中/.test(text) ? 'running' : /失败/.test(text) ? 'failed' : 'unknown'
      const link = [...row.querySelectorAll('*')].find((el) => t(el) === '下载')
      let coords = null
      if (link) {
        const r = link.getBoundingClientRect()
        if (r.width > 0) coords = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      }
      out.push({ time, status, hasDownload: Boolean(coords), coords })
    }
    return out
  })()`)
}

/** 点某一行的「下载」并等文件落盘。 */
export async function downloadReportRow(page, row, dir, { timeoutMs = 120000 } = {}) {
  if (!row || !row.coords) return { ok: false, reason: '这一行没有可点的「下载」' }
  const since = Date.now() - 3000
  const { x, y } = row.coords
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 12, y: y + 4 })
  await new Promise((r) => setTimeout(r, 150))
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await new Promise((r) => setTimeout(r, 220))
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 90))
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  const got = await waitForDownload(dir, { since, timeoutMs })
  return got ? { ok: true, file: got.file, name: got.name, size: got.size } : { ok: false, reason: '点了下载但没等到文件' }
}

/** 点报表中心里的「下载」，并等文件落到 dir。 */
export async function downloadNewestReport(page, dir, { timeoutMs = 90000 } = {}) {
  const link = await findDownloadLink(page)
  if (!link) return { ok: false, reason: '报表中心没有可下载的行（可能还在「导出中」）' }
  const since = Date.now() - 3000
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: link.x - 12, y: link.y + 4 })
  await new Promise((r) => setTimeout(r, 150))
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: link.x, y: link.y })
  await new Promise((r) => setTimeout(r, 220))
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: link.x, y: link.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 90))
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: link.x, y: link.y, button: 'left', clickCount: 1 })
  const got = await waitForDownload(dir, { since, timeoutMs })
  return got ? { ok: true, file: got.file, name: got.name, size: got.size } : { ok: false, reason: '点了下载但没等到文件' }
}

export async function waitForDownload(dir, { since = 0, timeoutMs = 60000, intervalMs = 1200, readdir } = {}) {
  const { readdir: read } = await import('node:fs/promises')
  const lister = readdir || read
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const files = await lister(dir).catch(() => [])
    const candidates = files.filter((name) => /\.(xlsx|xls)$/i.test(name) && !name.endsWith('.crdownload'))
    for (const name of candidates) {
      const full = join(dir, name)
      const { stat } = await import('node:fs/promises')
      const info = await stat(full).catch(() => null)
      if (info && info.mtimeMs > since && info.size > 1024) return { file: full, name, size: info.size }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return null
}

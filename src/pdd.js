/**
 * 拼多多 H5 页面读取层：订单列表 → 逐单打开详情 → 归一化成可入库的结构。
 *
 * 只做三件事：
 *  1) 列表页自然滚动到底，顺带收集页面自己请求的订单列表响应（拿到 order_sn）；
 *  2) 逐个打开 order.html（真实页面），读 window.rawData（服务端已给的订单数据）；
 *  3) 归一化：订单号/物流单号/商品/数量/店铺/收货人/手机号/地址。
 *
 * 不调私有接口、不批量并发、不绕过验证码：节奏交给调用方控制。
 */

import { sleep } from './cdp.js'

/** 拼多多订单页签：2=待发货，3=待收货（页面上叫「已发货」）。 */
export const TAB_TYPES = { pending: 2, shipped: 3 }
export const TAB_LABELS = { pending: '待发货', shipped: '待收货' }
export const ORDERS_URL = (type = 3) => `https://mobile.pinduoduo.com/orders.html?type=${type}`
export const ORDER_URL = (orderSn) => `https://mobile.pinduoduo.com/order.html?order_sn=${encodeURIComponent(orderSn)}&page_from=1&main_orders=1`

/** epoch 秒 → 本地 ISO（+08:00）。认不出来就返回空串，绝不猜。 */
export function toIso(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export async function isLoggedIn(page) {
  const url = await page.currentUrl()
  return !/login\.html/.test(url)
}

/** 订单号前缀就是开单日期：261026-xxx → 2026-10-26。解析不出来返回空串。 */
export function dateOfOrderSn(orderSn) {
  const m = /^(\d{2})(\d{2})(\d{2})-/.exec(String(orderSn || ''))
  if (!m) return ''
  return `20${m[1]}-${m[2]}-${m[3]}`
}

/** 下单时间戳（epoch 秒）→ 本地日期 YYYY-MM-DD。这是「以订单时间为准」的那个日期。 */
export function dateOfEpoch(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 一个订单归属哪一天：优先用下单时间，其次才退回订单号前缀。 */
export function orderDateOf(order) {
  return dateOfEpoch(order && order.order_time ? order.order_time : order && order.orderTime) || dateOfOrderSn(order && (order.order_sn || order.orderSn))
}

/** 「近 N 天」的起始日期（含今天）：days=2 → 昨天。 */
export function sinceDateForDays(days, now = new Date()) {
  const n = Math.max(1, Math.floor(Number(days) || 1))
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  d.setDate(d.getDate() - (n - 1))
  const pad = (value) => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 列表页：滚动并收集页面自己的订单响应。
 * sinceDate 给了就只收到这一天为止（列表按时间倒序，遇到更早的就不用再翻了）。
 *
 * 注意：只盯 order_list_v4 会漏单 —— 页面顶部那张「待商家处理退货申请」的卡片
 * 来自 express/track/status 而不是列表接口（实测新单全漏）。所以这里对页面自己的
 * 每个 JSON 响应都做一次订单号正则兜底，和 order_list_v4 的元数据取并集。
 */
export async function collectOrderList(page, { maxScrolls = 400, sinceDate = '', tabType = 3, onProgress } = {}) {
  await page.send('Network.enable', { maxTotalBufferSize: 256 * 1024 * 1024 })
  const captured = []
  const off = page.onEvent((msg) => {
    if (msg.method !== 'Network.responseReceived') return
    const { url, mimeType } = msg.params.response
    if (!/pinduoduo\.com/.test(url)) return
    if (!/json/.test(mimeType || '')) return
    if (!/\/api\/|order_list|track|order/i.test(url)) return
    captured.push({ requestId: msg.params.requestId, url })
  })

  // 带时间戳，避免同 URL 命中缓存导致第一页响应抓不到（踩过：新单全漏）
  await page.navigate(`${ORDERS_URL(tabType)}&_t=${Date.now()}`)
  await sleep(1200)
  const landed = await page.currentUrl()
  if (/login\.html/.test(landed)) {
    off()
    const error = new Error('拼多多未登录：页面跳到登录页，请先在自动化浏览器里扫码登录')
    error.code = 'NOT_LOGGED_IN'
    throw error
  }

  const bySn = new Map()
  const ORDER_SN_RE = /(?<!\d)(\d{6}-\d{13,})(?!\d)/g
  let drained = 0
  let cutoffReached = false
  const drain = async () => {
    while (drained < captured.length) {
      const { requestId, url } = captured[drained++]
      try {
        const body = await page.send('Network.getResponseBody', { requestId })
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
        // 元数据（列表接口才带）
        let pageOldest = ''
        try {
          const json = JSON.parse(text)
          for (const order of json.orders || []) {
            if (!order.order_sn) continue
            bySn.set(order.order_sn, order)
            const date = orderDateOf(order)
            if (date && (!pageOldest || date < pageOldest)) pageOldest = date
          }
        } catch {
          /* 不是 JSON 就只走正则 */
        }
        // 订单号兜底：不管哪个接口吐出来的，先收进名单（顶部售后卡片不在列表接口里）
        for (const match of text.matchAll(ORDER_SN_RE)) {
          const sn = match[1]
          if (!bySn.has(sn)) bySn.set(sn, { order_sn: sn })
        }
        // 只有列表接口的「本页最早日期」能用来判断是否已经翻过了起始日
        if (/order_list_v4/.test(url) && pageOldest && pageOldest < sinceDate) cutoffReached = true
      } catch {
        /* 单个响应读不到不影响其余 */
      }
    }
  }

  // 耐心版滚动：虚拟列表下 DOM 卡片数几乎不变，而下一页要等几十秒才来。
  // 因此用「已收订单数 / 卡片数 / scrollHeight 是否变高 / 是否显示正在加载」四个信号判断有没有进展，
  // 只要页面还在变高就不算停。
  let lastCards = 0
  let lastOrders = 0
  let lastHeight = 0
  let noGrowth = 0
  let index = 0
  for (; index < maxScrolls; index++) {
    const state = await page.evaluate(`(() => ({
      y: window.scrollY, h: window.innerHeight, sh: document.documentElement.scrollHeight,
      cards: document.querySelectorAll('div.U6SAh0Eo').length,
      loading: /正在加载中/.test(document.body.innerText.slice(-300))
    }))()`)
    await drain()
    const grew = bySn.size > lastOrders || state.cards > lastCards || state.sh > lastHeight + 50
    if (grew) {
      lastOrders = bySn.size
      lastCards = state.cards
      lastHeight = state.sh
      noGrowth = 0
      if (onProgress) onProgress({ scrolls: index, cards: state.cards, orders: bySn.size })
    } else if (!state.loading) {
      noGrowth++
    }
    if (sinceDate && cutoffReached) break
    if (noGrowth > 40) break
    await page.wheelScroll(240 + Math.random() * 420, { x: 640, y: 500 })
    await sleep(1400 + Math.random() * 1100)
  }
  await drain()
  if (onProgress) onProgress({ scrolls: index, cards: lastCards, orders: bySn.size, final: true })
  off()

  const all = [...bySn.values()]
  const filtered = sinceDate
    ? all.filter((order) => {
        const date = orderDateOf(order)
        return !date || date >= sinceDate
      })
    : all
  return { list: filtered, pages: captured.length, scanned: all.length, reachedCutoff: cutoffReached }
}

const STATUS_TEXT = {
  0: '待付款',
  1: '待发货',
  2: '待发货',
  3: '待收货',
  4: '已收货',
  5: '已评价',
  6: '已取消',
}

function arrive(detail) {
  const d = detail || {}
  const province = String(d.provinceName || '').trim()
  const city = String(d.cityName || '').trim()
  const district = String(d.districtName || '').trim()
  const detailAddr = String(d.shippingAddress || '').trim()
  if (!detailAddr) return [province, city === province ? '' : city, district].filter(Boolean).join('')
  // shippingAddress 有时已经是完整地址，有时只有街道门牌；不能无脑加前缀，否则会出现
  // 「广东省珠海市香洲区广东省珠海市香洲区…」这种重复。
  if (province && detailAddr.startsWith(province)) return detailAddr
  if (city && detailAddr.startsWith(city)) return `${province}${detailAddr}`
  if (district && detailAddr.startsWith(district)) return `${province}${city && city !== province ? city : ''}${detailAddr}`
  const prefix = [province, city && city !== province ? city : '', district].filter(Boolean).join('')
  return `${prefix}${detailAddr}`
}

/** 把 order.html 的 rawData.data 归一化成入库结构。 */
export function normalizeOrderDetail(raw, { orderSn, listOrder, tabLabel = '待收货' } = {}) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const goods = Array.isArray(d.orderGoods) ? d.orderGoods : []
  const items = goods.map((item) => ({
    goodsId: String(item.goodsId ?? item.goods_id ?? ''),
    skuId: String(item.skuId ?? item.sku_id ?? ''),
    goodsName: String(item.goodsName ?? item.goods_name ?? ''),
    spec: String(item.spec ?? ''),
    qty: Number(item.goodsNumber ?? item.goods_number ?? 0) || 0,
    unitPriceCents: Number(item.goodsPrice ?? item.goods_price ?? NaN),
    thumbUrl: String(item.thumbUrl ?? item.thumb_url ?? ''),
    linkUrl: String(item.linkUrl ?? item.link_url ?? ''),
  }))

  const statusCode = Number(d.status ?? listOrder?.status ?? NaN)
  const statusText =
    d.order_status_prompt || listOrder?.order_status_prompt || STATUS_TEXT[statusCode] || ''
  const carrier = d.shipping?.shippingName || d.shipping?.shipping_name || ''
  const trackingNo = String(d.trackingNumber || listOrder?.tracking_number || '')
  const mallName = d.mall?.mallName || d.mall?.mall_name || listOrder?.mall?.mall_name || ''
  const mallId = String(d.mall?.mallId ?? listOrder?.mall?.mall_id ?? '')

  return {
    orderSn: String(d.orderSn || orderSn || ''),
    orderDate: dateOfEpoch(d.orderTime) || dateOfOrderSn(orderSn || d.orderSn),
    tab: tabLabel,
    status: Number.isFinite(statusCode) ? statusCode : null,
    statusText,
    shopName: mallName,
    mallId,
    receiverName: String(d.receiveName || ''),
    receiverPhone: String(d.mobile || ''),
    receiverPhoneMasked: String(d.maskedMobile || ''),
    province: d.provinceName || '',
    city: d.cityName || '',
    district: d.districtName || '',
    address: arrive(d),
    trackingNo,
    carrier,
    orderTime: toIso(d.orderTime),
    shipTime: toIso(d.shippingTime || listOrder?.shipping_time),
    expectAutoReceive: toIso(d.expectAutoReceiveTime || listOrder?.expect_auto_receive_time),
    receiveTime: toIso(d.receiveTime),
    goodsAmountCents: Number(d.goodsAmount ?? NaN),
    payAmountCents: Number(d.orderAmount ?? NaN),
    items,
    raw: d,
  }
}

/** 详情页兜底：rawData 缺失时从 DOM 读（aria-label 里带完整手机号）。 */
export async function readDetailFromDom(page) {
  const text = await page.evaluate('document.body.innerText')
  const label = await page.evaluate(`(() => {
    const el = document.querySelector('[aria-label^="收货人信息"]')
    return el ? el.getAttribute('aria-label') : ''
  })()`)
  const parseLabel = (value) => {
    const m = /收货人信息[:：]\s*([^,，]*)[,，]联系方式[:：]\s*(\d{5,20})[,，]地址[:：]\s*(.*)$/.exec(value || '')
    if (!m) return null
    return { receiverName: m[1].trim(), receiverPhone: m[2].trim(), address: m[3].trim() }
  }
  const receiver = parseLabel(label)
  const orderSn = (/订单号[：:]\s*(\d{6}-\d+)/.exec(text) || [])[1] || ''
  const tracking = (/快递单号[：:]\s*([A-Za-z0-9-]+)/.exec(text) || [])[1] || ''
  const carrier = (/物流公司[：:]\s*([^\n]+)/.exec(text) || [])[1] || ''
  return { orderSn, tracking, carrier, receiver, text }
}

/** 打开一个订单详情页并读出归一化结果。 */
export async function fetchOrderDetail(page, orderSn, { timeoutMs = 30000, tabLabel = '待收货' } = {}) {
  await page.navigate(ORDER_URL(orderSn), { timeoutMs })
  const ready = await page.waitFor(
    `!!(window.rawData && window.rawData.data && (window.rawData.data.orderSn || window.rawData.data.order_sn))`,
    { timeoutMs: 12000, intervalMs: 300 },
  )
  if (ready) {
    const raw = await page.evaluate('window.rawData.data')
    const normalized = normalizeOrderDetail(raw, { orderSn, tabLabel })
    if (normalized.orderSn) return { ok: true, order: normalized, source: 'rawData' }
  }
  // 兜底：DOM
  const dom = await readDetailFromDom(page)
  if (!dom.orderSn && !dom.receiver) {
    const error = new Error(`订单 ${orderSn} 详情页没读到数据（可能被风控拦截或页面改版）`)
    error.code = 'DETAIL_UNREADABLE'
    throw error
  }
  const address = dom.receiver ? dom.receiver.address : ''
  return {
    ok: true,
    source: 'dom',
    order: {
      orderSn: dom.orderSn || orderSn,
      orderDate: dateOfOrderSn(dom.orderSn || orderSn),
      tab: tabLabel,
      status: null,
      statusText: '',
      shopName: '',
      mallId: '',
      receiverName: dom.receiver ? dom.receiver.receiverName : '',
      receiverPhone: dom.receiver ? dom.receiver.receiverPhone : '',
      receiverPhoneMasked: '',
      province: '',
      city: '',
      district: '',
      address,
      trackingNo: dom.tracking,
      carrier: dom.carrier,
      orderTime: '',
      shipTime: '',
      expectAutoReceive: '',
      receiveTime: '',
      goodsAmountCents: NaN,
      payAmountCents: NaN,
      items: [],
      raw: null,
    },
  }
}

/** 人味节奏：普通间隔 + 每 N 单一次长停顿。 */
export async function humanPause(index, { minMs = 1500, maxMs = 3800, longEvery = 8 } = {}) {
  const base = minMs + Math.random() * (maxMs - minMs)
  if (longEvery && index > 0 && index % longEvery === 0) {
    await sleep(base + 4000 + Math.random() * 6000)
    return
  }
  await sleep(base)
}

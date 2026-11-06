// 探针：在页面上下文里试几个「订单详情」候选接口，看哪个真能返回收货人/手机号。
// 用法: node tools/probe-api.mjs <port> <orderSn>
import { connect, sleep } from '../src/cdp.js'

const [, , portArg, orderSn] = process.argv
const base = `http://127.0.0.1:${portArg || 9335}`
const target = await (await fetch(`${base}/json/new?${encodeURIComponent('https://mobile.pinduoduo.com/orders.html?type=3')}`, { method: 'PUT' })).json()
const page = await connect(base, { match: (u) => u.includes('pinduoduo.com'), pickExisting: false })
await sleep(2500)
console.log('tab:', await page.currentUrl(), 'target:', target.id)

const candidates = [
  `/proxy/api/api/aristotle/order_detail?order_sn=${orderSn}`,
  `/proxy/api/api/aristotle/order_detail_v2?order_sn=${orderSn}`,
  `/proxy/api/api/aristotle/order_detail_v3?order_sn=${orderSn}`,
  `/proxy/api/api/order/detail?order_sn=${orderSn}`,
  `/proxy/api/api/order_detail?order_sn=${orderSn}`,
  `/proxy/api/api/aristotle/order_info?order_sn=${orderSn}`,
]

for (const path of candidates) {
  const result = await page.evaluate(`(async () => {
    try {
      const res = await fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { 'content-type': 'application/json' } })
      const text = await res.text()
      return JSON.stringify({ path: ${JSON.stringify(path)}, status: res.status, bytes: text.length, head: text.slice(0, 160) })
    } catch (error) { return JSON.stringify({ path: ${JSON.stringify(path)}, error: String(error) }) }
  })()`)
  console.log(result)
  await sleep(800)
}
page.close()

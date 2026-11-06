// 探针（耐心版）：滚到底并等页面自己把下一页加载完，收集所有 order_list_v4 响应。
// 用法: node tools/collect-list.mjs <port> [patience]
import { connect, sleep } from '../src/cdp.js'

const [, , portArg, patienceArg] = process.argv
const patience = Number(patienceArg || 30)
const base = `http://127.0.0.1:${portArg || 9335}`
const page = await connect(base, { match: (u) => u.includes('pinduoduo.com'), pickExisting: true })
await page.send('Network.enable', { maxTotalBufferSize: 256 * 1024 * 1024 })

const bodies = []
page.onEvent((msg) => {
  if (msg.method === 'Network.responseReceived' && msg.params.response.url.includes('aristotle/order_list_v4')) {
    bodies.push(msg.params.requestId)
  }
})

await page.navigate('https://mobile.pinduoduo.com/orders.html?type=3')
await sleep(3000)

let lastCards = 0
let noGrowth = 0
for (let i = 0; i < 2000; i++) {
  const state = await page.evaluate(`(() => ({
    y: window.scrollY, h: window.innerHeight, sh: document.documentElement.scrollHeight,
    cards: document.querySelectorAll('div.U6SAh0Eo').length,
    tail: document.body.innerText.slice(-40)
  }))()`)
  if (state.cards > lastCards) {
    lastCards = state.cards
    noGrowth = 0
    await page.evaluate(`(() => { const d = document.createElement('div'); d.id = '__pdd_progress'; return true })()`)
    console.log(`[${new Date().toISOString().slice(11, 19)}] cards=${state.cards} scrollY=${Math.round(state.y)} resp=${bodies.length}`)
  } else {
    noGrowth++
  }
  if (noGrowth > patience) {
    console.log('no growth for', patience, 'iterations, stop. lastCards=', lastCards)
    break
  }
  await page.wheelScroll(250 + Math.random() * 450, { x: 640, y: 500 })
  await sleep(1500 + Math.random() * 1200)
}

const orders = []
for (const requestId of bodies) {
  try {
    const body = await page.send('Network.getResponseBody', { requestId })
    const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
    const json = JSON.parse(text)
    for (const order of json.orders || []) orders.push(order)
  } catch {
    /* ignore */
  }
}
const seen = new Map()
for (const order of orders) if (order.order_sn && !seen.has(order.order_sn)) seen.set(order.order_sn, order)
console.log(JSON.stringify({ pages: bodies.length, rawOrders: orders.length, uniqueOrders: seen.size, cards: lastCards }, null, 1))
await (await import('node:fs/promises')).writeFile('.tmp/orders.json', JSON.stringify([...seen.values()], null, 1), 'utf8')
page.close()

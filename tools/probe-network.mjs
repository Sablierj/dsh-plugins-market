// 开发探针：抓当前页面加载过程中的 JSON 响应，打印 URL 与命中情况。
// 用法: node tools/probe-network.mjs <port> [reload|keep] [urlFilter]
import { connect, sleep } from '../src/cdp.js'

const [, , portArg, mode = 'reload', filter = ''] = process.argv
const base = `http://127.0.0.1:${portArg || 9335}`
const page = await connect(base, { match: (u) => u.includes('pinduoduo.com'), pickExisting: true })
await page.send('Network.enable', { maxTotalBufferSize: 100 * 1024 * 1024 })
const responses = new Map()
page.onEvent((msg) => {
  if (msg.method === 'Network.responseReceived') {
    const { requestId, response } = msg.params
    if (/json|text/.test(response.mimeType || '') && (!filter || response.url.includes(filter))) {
      responses.set(requestId, { url: response.url, status: response.status, mime: response.mimeType })
    }
  }
})
if (mode === 'reload') {
  await page.send('Page.reload')
}
await sleep(6000)
const out = []
for (const [requestId, meta] of responses) {
  try {
    const body = await page.send('Network.getResponseBody', { requestId })
    const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
    out.push({ url: meta.url.slice(0, 160), status: meta.status, bytes: text.length, orderSnHits: (text.match(/orderSn|order_sn/g) || []).length, head: text.slice(0, 120) })
  } catch (error) {
    out.push({ url: meta.url.slice(0, 160), status: meta.status, error: String(error.message).slice(0, 80) })
  }
}
console.log(JSON.stringify(out, null, 1))
page.close()

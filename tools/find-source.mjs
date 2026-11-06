// 找「第一页订单」到底来自哪个响应：reload 后逐个 JSON 响应检查是否含指定订单号。
// 用法: node tools/find-source.mjs <port> <orderSnFragment> [reload|keep]
import { connect, sleep } from '../src/cdp.js'

const [, , portArg, needle, mode = 'reload'] = process.argv
const base = `http://127.0.0.1:${portArg || 9335}`
const page = await connect(base, { match: (u) => u.includes('pinduoduo.com'), pickExisting: true })
await page.send('Network.enable', { maxTotalBufferSize: 256 * 1024 * 1024 })
const hits = []
page.onEvent((msg) => {
  if (msg.method === 'Network.responseReceived') {
    const { requestId, response } = msg.params
    if (/json/.test(response.mimeType || '')) hits.push({ requestId, url: response.url, fromDiskCache: response.fromDiskCache })
  }
})
if (mode === 'reload') {
  await page.send('Page.reload', { ignoreCache: true })
}
await sleep(8000)
const out = []
for (const hit of hits) {
  try {
    const body = await page.send('Network.getResponseBody', { requestId: hit.requestId })
    const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
    out.push({
      url: hit.url.replace(/\?.*/, ''),
      bytes: text.length,
      cache: Boolean(hit.fromDiskCache),
      hasNeedle: text.includes(needle),
      orderCount: (text.match(/"order_sn"/g) || []).length,
    })
  } catch (error) {
    out.push({ url: hit.url.replace(/\?.*/, ''), error: String(error.message).slice(0, 60) })
  }
}
console.log(JSON.stringify(out.filter((row) => row.orderCount || row.hasNeedle || row.error), null, 1))
page.close()

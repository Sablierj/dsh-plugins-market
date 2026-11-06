// 开发探针 2：把指定 URL 片段命中的响应体存到文件，便于分析字段。
// 用法: node tools/dump-response.mjs <port> <urlFilter> <outFile> [reload|keep]
import { connect, sleep } from '../src/cdp.js'

const [, , portArg, filter, outFile, mode = 'reload'] = process.argv
if (!filter || !outFile) {
  console.error('用法: node tools/dump-response.mjs <port> <urlFilter> <outFile> [reload|keep]')
  process.exit(1)
}
const base = `http://127.0.0.1:${portArg || 9335}`
const page = await connect(base, { match: (u) => u.includes('pinduoduo.com'), pickExisting: true })
await page.send('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024 })
const hits = []
page.onEvent((msg) => {
  if (msg.method === 'Network.responseReceived' && msg.params.response.url.includes(filter)) {
    hits.push({ requestId: msg.params.requestId, url: msg.params.response.url })
  }
})
if (mode === 'reload') await page.send('Page.reload')
await sleep(7000)
const { writeFile } = await import('node:fs/promises')
const saved = []
for (const hit of hits) {
  try {
    const body = await page.send('Network.getResponseBody', { requestId: hit.requestId })
    const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
    const file = hits.length > 1 ? outFile.replace(/\.json$/, `-${saved.length + 1}.json`) : outFile
    await writeFile(file, text, 'utf8')
    saved.push({ file, bytes: text.length })
  } catch (error) {
    saved.push({ url: hit.url, error: String(error.message).slice(0, 100) })
  }
}
console.log(JSON.stringify({ hits: hits.length, saved }, null, 1))
page.close()

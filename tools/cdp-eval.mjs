// 开发用小工具：连到指定 CDP 端口的一个标签页，跑一段 JS，把结果打成 JSON。
// 用法: node cdp-eval.mjs <port> <expr> [matchSubstring]
//   或: node cdp-eval.mjs <port> --file <path.js> [matchSubstring]
const [, , portArg, exprArg, ...rest] = process.argv
const port = Number(portArg || 9335)
let match = ''
let expr = exprArg
if (exprArg === '--file') {
  const { readFile } = await import('node:fs/promises')
  expr = await readFile(rest[0], 'utf8')
  match = rest[1] || ''
} else {
  match = rest[0] || ''
}

const base = `http://127.0.0.1:${port}`
const targets = await (await fetch(`${base}/json/list`)).json()
const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
const page = pages.find((t) => match && (t.url || '').includes(match)) || pages[0]
if (!page) {
  console.error('没有可用的标签页')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
  }
})
function send(method, params = {}) {
  const myId = ++id
  ws.send(JSON.stringify({ id: myId, method, params }))
  return new Promise((resolve, reject) => pending.set(myId, { resolve, reject }))
}
const result = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
  allowUnsafeEvalBlockedByCSP: true,
})
if (result.exceptionDetails) {
  console.error('PAGE ERROR:', result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  console.log(JSON.stringify({ url: page.url, title: page.title }, null, 2))
  process.exit(2)
}
console.log(JSON.stringify({ url: page.url, title: page.title, value: result.result.value }, null, 2))
ws.close()

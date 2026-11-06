// 开发调试 CLI：node tools/drive.mjs <port> <cmd> [...]
//   eval <js>           在页面里求值，打印 JSON
//   click <cssSel>      用真人鼠标事件点元素中心
//   clickjs <js>        用真人鼠标事件点 JS 表达式返回的元素
//   goto <url>          导航并等 hydration
//   shot <path>         截图落盘
//   text [max]          打印页面 innerText
//   save <js> <path>    求值结果（JSON 文本）直接写文件，UTF-8
//   tabs                列出标签页
import { connect, probe } from '../src/cdp.js'

const [, , portArg, cmd, ...args] = process.argv
const port = Number(portArg || 9335)
const base = `http://127.0.0.1:${port}`

if (cmd === 'tabs') {
  const p = await probe(base)
  console.log(JSON.stringify(p, null, 2))
  process.exit(0)
}

const page = await connect(base, { match: (u) => u.includes('pinduoduo.com'), pickExisting: true })

if (args[0] === '--file') {
  const { readFile } = await import('node:fs/promises')
  args.splice(0, 2, await readFile(args[1], 'utf8'))
}

if (cmd === 'eval') {
  const out = await page.evaluate(args[0])
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
} else if (cmd === 'click') {
  const sel = JSON.stringify(args[0])
  const ok = await page.clickHuman(`document.querySelector(${sel})`)
  console.log(JSON.stringify({ ok, url: await page.currentUrl() }))
} else if (cmd === 'clickjs') {
  const ok = await page.clickHuman(`(${args[0]})`)
  console.log(JSON.stringify({ ok, url: await page.currentUrl() }))
} else if (cmd === 'goto') {
  await page.navigate(args[0])
  console.log(JSON.stringify({ url: await page.currentUrl(), title: await page.evaluate('document.title') }))
} else if (cmd === 'shot') {
  console.log(JSON.stringify({ file: await page.screenshot(args[0]) }))
} else if (cmd === 'save') {
  const out = await page.evaluate(args[0])
  const text = typeof out === 'string' ? out : JSON.stringify(out)
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(args[1]), { recursive: true })
  await writeFile(args[1], text, 'utf8')
  console.log(JSON.stringify({ file: args[1], bytes: text.length }))
} else if (cmd === 'text') {
  const max = Number(args[0] || 3000)
  console.log(await page.evaluate(`document.body.innerText.slice(0,${max})`))
} else {
  console.error('未知命令:', cmd)
  process.exit(1)
}
page.close()

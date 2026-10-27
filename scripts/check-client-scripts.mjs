/**
 * 改完客户端脚本后**立刻**跑这个，比跑全量测试快得多（约 1 秒 vs 约 90 秒）。
 *
 * 它查的是同一类根因：`src/web/pages/*.js` 导出的是一整个模板字符串，里面任何
 * **未转义**的反引号或美元花括号都会提前结束它 / 被求值。我在这上面犯过三次，
 * 每次挂 100+ 个断言，所以值得有个 1 秒的闸门。
 *
 * 判定规则（精确到字符，跳过反斜杠转义）：
 *   · 模板体从 `export const XxxScript = <反引号>` 之后开始，到文件末尾那个收尾反引号为止
 *   · 体内出现 <反斜杠> + <任意字符> → 合法转义，跳过两个字符
 *   · 体内出现裸反引号 → 违规
 *   · 体内出现裸美元花括号 → 违规
 *
 * 最后再把渲染出的 <script> 交给 node --check，那是最接近浏览器的判据。
 *
 * 第一版这个脚本**自己误报了 35 处**：它把 export 之前 JSDoc 里的反引号、
 * 合法的转义写法、以及 kw.js 故意插的片段占位都算成了错误。所以这里按字符扫，
 * 不按行扫。
 *
 * 用法：node scripts/check-client-scripts.mjs
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pagesDir = join(root, 'src', 'web', 'pages')
const TICK = String.fromCharCode(96)
const DOLLAR = '$'

let problems = 0

/** 返回模板体在文件里的起止偏移；找不到返回 null。 */
function templateBody(text) {
  const exportAt = text.search(/export const \w+Script\s*=\s*/)
  if (exportAt === -1) return null
  const open = text.indexOf(TICK, exportAt)
  if (open === -1) return null
  const close = text.lastIndexOf(TICK)
  if (close <= open) return null
  return { start: open + 1, end: close }
}

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length
}

for (const name of readdirSync(pagesDir).filter(file => file.endsWith('.js'))) {
  const path = join(pagesDir, name)
  const text = readFileSync(path, 'utf8')
  const body = templateBody(text)
  if (body === null) continue

  let i = body.start
  while (i < body.end) {
    const char = text[i]
    /* 反斜杠转义：跳过下一个字符。pipeline.js 就靠这个写法在正文里带反引号。 */
    if (char === '\\') { i += 2; continue }
    if (char === TICK) {
      console.log(`  ✗ ${name}:${lineOf(text, i)} 模板体内出现裸反引号 —— 会提前结束它`)
      console.log(`      ${text.slice(i, i + 90).split('\n')[0]}`)
      problems += 1
    }
    if (char === DOLLAR && text[i + 1] === '{') {
      /* 唯一合法的情况：片段占位 `${<名字>Script}` —— kw 就是靠它把自己和 pipeline
         拼成同一段脚本（拆的是文件，不是作用域）。除此之外的插值都算违规。 */
      const closing = text.indexOf('}', i)
      const inner = closing === -1 ? '' : text.slice(i + 2, closing)
      if (/^[A-Za-z_]\w*Script$/.test(inner)) { i = closing + 1; continue }
      console.log(`  ✗ ${name}:${lineOf(text, i)} 模板体内出现美元花括号插值 —— 会被求值`)
      console.log(`      ${text.slice(i, i + 90).split('\n')[0]}`)
      problems += 1
    }
    i += 1
  }
}

/* 渲染出来的客户端脚本能不能解析 —— 最接近浏览器的判据 */
if (problems === 0) {
  const dir = mkdtempSync(join(tmpdir(), 'client-check-'))
  const out = join(dir, 'client.js')
  try {
    const { renderWorkbenchPage } = await import(new URL('../src/web/page.js', import.meta.url).href)
    const html = renderWorkbenchPage({
      pagePath: '/custom/amazon-ops',
      initialState: {
        context: {
          module: 'home', scope: {}, filters: {},
          selection: { asins: [], keywords: [] },
        },
      },
    })
    const match = /<script>([\s\S]*)<\/script>/.exec(html)
    if (match === null) {
      console.log('  ✗ 渲染结果里找不到 <script> 块')
      problems += 1
    } else {
      writeFileSync(out, match[1], 'utf8')
      try {
        execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' })
        console.log(`  ✓ 客户端脚本语法通过（${Math.round(match[1].length / 1024)} KB）`)
      } catch (error) {
        console.log('  ✗ 客户端脚本语法错误：')
        for (const line of String(error.stderr ?? error.message).split('\n').slice(0, 6)) {
          console.log('      ' + line)
        }
        problems += 1
      }
    }
  } catch (error) {
    console.log('  ✗ 渲染失败：' + error.message)
    problems += 1
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

console.log('')
if (problems === 0) console.log('✅ 客户端脚本检查通过')
else { console.log(`❌ 发现 ${problems} 处问题`); process.exit(1) }

/**
 * 页面自检：把真实服务出的 HTML 抓下来，抽出内联脚本交给 node 做语法检查。
 *
 * 为什么需要它：page.js 用模板字符串生成整页 HTML，写错一个 `\n` 就会让生成的
 * 脚本语法错，而**页面不会报错、只是所有 JS 静默不执行**（按钮全无反应）。
 * 这类 bug 肉眼看不出来，只有解析一遍才抓得到。
 *
 * 用法：node tools/check-page.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:60000'

const html = await (await fetch(`${base}/custom/sif-ops`)).text()
const start = html.indexOf('<script>')
const end = html.lastIndexOf('</script>')
if (start < 0 || end < 0) {
  console.error('✗ 页面里找不到 <script>')
  process.exit(1)
}
const code = html.slice(start + '<script>'.length, end)

try {
  // 只做解析，不执行：语法错会在这里抛出来，并能指出出错行
  new Function(code)
  console.log(`✓ inline script parses (${code.length} chars)`)
} catch (error) {
  const lines = code.split('\n')
  console.error('✗ 页面内联脚本语法错误：', error.message)
  // 把出错的附近几行打出来，方便定位（报错信息里通常带行号）
  const match = /line (\d+)/i.exec(error.stack ?? '')
  if (match) {
    const line = Number(match[1])
    lines.slice(Math.max(0, line - 3), line + 2).forEach((text, index) => {
      console.error(`  ${Math.max(1, line - 2) + index}: ${text}`)
    })
  }
  process.exit(1)
}

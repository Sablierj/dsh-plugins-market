/**
 * P1-1 拆分器：把 page.js 里客户端脚本按页签块切到 src/web/pages/<module>.js。
 *
 * 判据（每块都验）：`renderWorkbenchPage()` 在同一份 initialState 下输出**逐字节相同**。
 * 搬家不是重构 —— 任何行为改动都会让这条判据失去意义，所以脚本只搬不改。
 *
 * 用法：
 *   node split-page-blocks.mjs            # dry-run：只报告块边界与体积
 *   node split-page-blocks.mjs --apply    # 真写，并在写完后整页哈希复核
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
const PAGE = join(PLUGIN, 'src', 'web', 'page.js')
const PAGES_DIR = join(PLUGIN, 'src', 'web', 'pages')

const APPLY = process.argv.includes('--apply')

/** 物理顺序（按 page.js 里 render* 出现的先后），值是切片模块名与导出名。 */
const BLOCKS = [
  ['kw', 'renderMaster'],
  ['competitor', 'renderCompetitor'],
  ['research', 'renderResearch'],
  ['rules', 'renderRules'],
  ['policy', 'renderPolicy'],
  ['optimize', 'renderOptimizations'],
  ['report', 'renderReports'],
  ['agent', 'renderAgent'],
  ['settings', 'renderSettings'],
  ['home', 'renderHome'],
  ['quality', 'renderQuality'],
  ['asin', 'renderAsinPanel'],
  ['collect', 'renderCollect'],
  ['prompts', 'renderPromptEditor'],
]
// 已抽出（试点），不再处理
const DONE = new Set(['pipeline'])

const text = readFileSync(PAGE, 'utf8')

/** 大模板的起点（仅用于合理性校验） */
const tplStart = text.indexOf('return `<!doctype html>')
if (tplStart === -1) throw new Error('找不到 return `<!doctype html>')

/**
 * 客户端脚本的终点：模板里最后一个 `</script>` 之前。
 *
 * 不要用「起点之后第一个反引号」当模板终点 —— 模板内部有嵌套模板
 * （L1181 的 `${MODULE_GROUPS.flatMap(...)}` 里就有反引号），第一个反引号
 * 远早于真正的结束位置。`</script>` 是这段脚本唯一可靠的收尾标记。
 */
const scriptEnd = text.lastIndexOf('</script>')
if (scriptEnd === -1 || scriptEnd < tplStart) throw new Error('找不到 </script> 作为脚本终点')

/** 每个块的起点：`\nfunction <name>(` 在脚本范围内的偏移 */
const starts = []
for (const [module, fn] of BLOCKS) {
  const needle = `\nfunction ${fn}(`
  const at = text.indexOf(needle, tplStart)
  if (at === -1 || at > scriptEnd) throw new Error(`找不到 ${fn} 的定义（模块 ${module}）`)
  starts.push({ module, fn, at: at + 1 }) // +1 跳过换行符
}

// 物理顺序必须递增，否则说明我的表写错了
for (let i = 1; i < starts.length; i += 1) {
  if (starts[i].at <= starts[i - 1].at) {
    throw new Error(`块顺序不对：${starts[i - 1].fn} 在 ${starts[i].fn} 之后`)
  }
}

/** 计算每块的 [start, end) */
const spans = starts.map((b, i) => ({
  ...b,
  end: i + 1 < starts.length ? starts[i + 1].at : scriptEnd,
}))

console.log('大模板范围: %d .. %d （%d 字节）', tplStart, scriptEnd, scriptEnd - tplStart)
console.log('块数: %d\n', spans.length)

let bad = 0
/** 允许出现在切片里的插值：已抽出的兄弟切片导出名，由切片自己 import 进来。 */
const KNOWN_SLICE_EXPORTS = new Set(['pipelineScript'])
for (const s of spans) {
  const body = text.slice(s.at, s.end)
  const interp = (body.match(/\$\{[^}]*\}/g) ?? [])
  const backtick = (body.match(/`/g) ?? []).length
  const foreign = interp.filter((i) => !KNOWN_SLICE_EXPORTS.has(i.slice(2, -1)))
  const flag = foreign.length || backtick ? '  ⚠ 有无法解释的插值/反引号' : ''
  if (foreign.length || backtick) bad += 1
  console.log(
    '  %s  L%s  %s bytes%s',
    s.module.padEnd(11),
    String(text.slice(0, s.at).split('\n').length).padStart(6),
    String(Buffer.byteLength(body)).padStart(8),
    flag,
  )
  if (interp.length) console.log('        插值（引用已抽出的切片，会自己 import）:', interp.join(' '))
  if (backtick) console.log('        反引号数:', backtick)
}

if (bad > 0) {
  console.error('\n有 %d 块含无法解释的插值或反引号 —— 原样搬会被求值。先停下。', bad)
  process.exit(1)
}

if (!APPLY) {
  console.log('\n(dry-run) 未写任何文件。加 --apply 执行。')
  process.exit(0)
}

/* ── 真写 ───────────────────────────────────────────────────────────── */
mkdirSync(PAGES_DIR, { recursive: true })

const STATE = { pagePath: '/custom/amazon-ops', initialState: { module: 'home' } }
const hashOf = (s) => createHash('sha256').update(s).digest('hex')

/** 动态 import 一个临时 page 模块并渲染 */
async function renderFrom(file) {
  const mod = await import(pathToFileURL(file).href + '?v=' + Math.random())
  return mod.renderWorkbenchPage(STATE)
}

const baseline = await renderFrom(PAGE)
const baseHash = hashOf(baseline)
console.log('\n基线渲染: %d 字节, sha256=%s', Buffer.byteLength(baseline), baseHash.slice(0, 16))

// 从后往前替换，偏移就不会互相影响
let working = text
const created = []
for (let i = spans.length - 1; i >= 0; i -= 1) {
  const s = spans[i]
  const body = text.slice(s.at, s.end)
  const file = join(PAGES_DIR, `${s.module}.js`)
  const exportName = `${s.module}Script`
  /* 换行必须精确对齐，否则整页多/少一个 \n（第一次跑就是这么差 14 字节的）：
     span 通常已经包含块尾那个换行，而占位符占一行也需要一个换行 ——
     两边只能各留一个。所以把尾换行从切片体里摘掉，由占位符那一行提供。 */
  const bodyEndsWithNewline = body.endsWith('\n')
  const sliceBody = bodyEndsWithNewline ? body.slice(0, -1) : body
  const placeholder = '${' + exportName + '}' + (bodyEndsWithNewline ? '\n' : '')
  /* 切片里若引用了已抽出的兄弟切片（如 kw 块里的 ${pipelineScript}），
     切片必须自己把它 import 进来，否则搬过去就变成未定义标识符。
     这样求值结果与搬家前完全一致（搬的是文件，不是语义）。 */
  const needed = [...new Set((body.match(/\$\{([A-Za-z_][\w]*)\}/g) ?? [])
    .map((m) => m.slice(2, -1))
    .filter((name) => KNOWN_SLICE_EXPORTS.has(name)))]
  const siblingImports = needed
    .map((name) => `import { ${name} } from './${name.replace(/Script$/, '')}.js'`)
    .join('\n')
  const slice =
    '/**\n'
    + ` * 页签「${s.module}」的客户端脚本片段（P1-1 从 page.js 原样切出）。\n`
    + ' *\n'
    + ' * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。\n'
    + ' */\n'
    + (siblingImports ? siblingImports + '\n' : '')
    + `export const ${exportName} = \``
    + sliceBody
    + '`\n'
  writeFileSync(file, slice, 'utf8')
  created.push(file)
  working = working.slice(0, s.at) + placeholder + working.slice(s.end)
}

// 加 import 行（接在已有的 pages/pipeline.js import 后面）
const pipelineImport = "import { pipelineScript } from './pages/pipeline.js'"
if (!working.includes(pipelineImport)) throw new Error('找不到 pipeline 的 import 行，先确认试点状态')
const imports = BLOCKS.map(([m]) => `import { ${m}Script } from './pages/${m}.js'`).join('\n')
working = working.replace(pipelineImport, pipelineImport + '\n' + imports)

// 先写到临时文件验证，通过再落盘
const tmp = join(PLUGIN, 'src', 'web', '__split-check.js')
writeFileSync(tmp, working, 'utf8')
let after
try {
  after = await renderFrom(tmp)
} finally {
  rmSync(tmp, { force: true })
}
const afterHash = hashOf(after)
console.log('拆分后渲染: %d 字节, sha256=%s', Buffer.byteLength(after), afterHash.slice(0, 16))

if (afterHash !== baseHash) {
  console.error('\n❌ 输出不一致 —— 回滚切片文件，page.js 未改。')
  for (const f of created) rmSync(f, { force: true })
  // 定位首个差异
  const a = Buffer.from(baseline, 'utf8')
  const b = Buffer.from(after, 'utf8')
  let at = 0
  while (at < Math.min(a.length, b.length) && a[at] === b[at]) at += 1
  console.error('首个差异在字节 %d：基线 %j / 拆分后 %j', at,
    a.slice(Math.max(0, at - 40), at + 40).toString('utf8'),
    b.slice(Math.max(0, at - 40), at + 40).toString('utf8'))
  process.exit(1)
}

writeFileSync(PAGE, working, 'utf8')
console.log('\n✅ 逐字节相同，已写入 page.js + %d 个切片。', created.length)
console.log('   page.js: %d 字节 → %d 字节', Buffer.byteLength(text), Buffer.byteLength(working))

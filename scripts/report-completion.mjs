#!/usr/bin/env node
/**
 * 完成度矩阵生成器 —— `docs/PRD.md` 从代码里长出来，而不是靠人记得更新。
 *
 * 为什么要有这个脚本：`docs/PRD.md` 曾经是一份早期调研清单，写着当时的版本号、
 * 工具数和页签数，而代码已经往前走了十倍量级。**手写的数字一定会过期，而过期的
 * 数字比没有数字更坏** —— 下一个读它的人会据此判断「还剩多少没做」，然后要么把
 * 做完了的报成没做，要么把没做的当成做完了。
 *
 * 所以这里只有一条原则：**PRD 里每一个数字都必须由本脚本从代码里读出来**，
 * 模板里不许出现任何写死的计数。判据是可执行的：
 *
 *   node scripts/report-completion.mjs           # 重新生成 docs/PRD.md
 *   node scripts/report-completion.mjs --check   # 只比对，不写；过期则 exit 1
 *   node scripts/report-completion.mjs --root X  # 换一个根目录（自检用，不碰本仓）
 *
 * `--check` 是给闸门用的：代码变了忘了重跑，它会红。这条已接进仓库根的
 * `scripts/check.mjs` 的 degraded 档，所以「文档过期」是一个会被机器发现的失败，
 * 不是一个靠自觉的约定。
 *
 * 数据来源（全部只读，除了 docs/PRD.md 本身不写仓库里的任何东西）：
 *   src/store/schema.js      → SCHEMA_VERSION / MIGRATIONS.length / CREATE 语句
 *   临时库（真跑一遍迁移）    → 表数与索引数（数 sqlite_master，不数 CREATE 语句）
 *   src/state/workbench.js   → MODULE_GROUPS（页签树）与叶子模块
 *   src/web/page.js          → PANEL_RENDERERS / PANEL_NOTES（哪些页签真有页面）
 *   src/tools/*.js           → `name: 'amzn_*'`（工具总数与按模块分布）
 *   src/tools/index.js       → `XxxTool(deps)` 注册调用（定义是否都接上了）
 *   tests/run.mjs            → 注册的套件文件与调用
 *   src/sources/registry.js  → planned 适配器（代码里有、但还没接的通道）
 *
 * 两条口径纪律：
 *
 * 1. **「CREATE TABLE 语句数」和「表数」不是一回事**。迁移里有 `CREATE TEMP TABLE`、
 *    有 `DROP TABLE`，正则数出来的是「历史上出现过几张表」。所以两个都读、都写，
 *    并断言它们一致；不一致就报出来，而不是挑一个好看的。
 * 2. **读不到就写「读不到」**，不写 0。「没有数据」和「数据是 0」是两件事，
 *    把前者渲染成后者，正是这份文档要防的那类错误。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..')

/** `--root <path>`：只给自检/证伪用；正常生成永远读本仓。 */
function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

const ROOT = resolve(argValue('--root') ?? DEFAULT_ROOT)
const PRD_PATH = join(ROOT, 'docs', 'PRD.md')
const CHECK_ONLY = process.argv.includes('--check')
const rel = (p) => p.slice(ROOT.length + 1).split('\\').join('/')

/* ── 通用小工具 ───────────────────────────────────────────────────────── */

const read = (p) => readFileSync(p, 'utf8')
const countMatches = (text, re) => [...text.matchAll(re)].length
const uniqueSorted = (list) => [...new Set(list)].sort()

/**
 * 去掉注释再数，避免把「注释里提到的 CREATE TABLE / name:」算成真的。
 * 这不是洁癖：`schema.js` 里就有一句注释写着「用 CREATE TABLE AS SELECT 复制结构」，
 * 不剥注释就会多算一张表 —— 一个不会报错、只会安静多一的错。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/--[^\n]*/g, '')
}

function must(condition, message) {
  if (!condition) throw new Error(message)
}

/* ── 1. schema：版本、迁移条数、建表/建索引语句 ────────────────────────── */

async function readSchema() {
  const mod = await import(pathToFileURL(join(ROOT, 'src', 'store', 'schema.js')).href)
  const version = mod.SCHEMA_VERSION
  const migrations = mod.MIGRATIONS
  must(typeof version === 'number', 'src/store/schema.js 没有导出数字 SCHEMA_VERSION')
  must(Array.isArray(migrations), 'src/store/schema.js 没有导出 MIGRATIONS 数组')

  const numbers = migrations.map((m) => m.version ?? m.to ?? m.v)
  const seen = new Set()
  const dups = numbers.filter((n) => (seen.has(n) ? true : (seen.add(n), false)))

  const sql = stripComments(read(join(ROOT, 'src', 'store', 'schema.js')))
  return {
    version,
    count: migrations.length,
    dups,
    // 不变量，不是绝对值：这两个数必须相等，且版本号不许重复。
    consistent: version === migrations.length && dups.length === 0,
    createTable: countMatches(sql, /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:"[^"]+"|'[^']+'|`[^`]+`|[A-Za-z_][\w]*)/gi),
    createIndex: countMatches(sql, /CREATE (?:UNIQUE )?INDEX/gi),
    createTrigger: countMatches(sql, /CREATE TRIGGER/gi),
    createView: countMatches(sql, /CREATE VIEW/gi),
  }
}

/* ── 2. 表与索引：真跑一遍迁移，数 sqlite_master ───────────────────────── */

async function readStoreShape() {
  const dataDir = mkdtempSync(join(tmpdir(), 'amz-prd-'))
  let store
  try {
    const { openStore } = await import(pathToFileURL(join(ROOT, 'src', 'store', 'db.js')).href)
    store = openStore({ dataDir, logger: { info() {}, warn() {}, error() {} } })
    const tables = store.raw.prepare(
      "select count(*) as c from sqlite_master where type = 'table' and name not like 'sqlite_%'",
    ).get().c
    const indexes = store.raw.prepare(
      "select count(*) as c from sqlite_master where type = 'index' and name not like 'sqlite_%'",
    ).get().c
    return { tables, indexes, error: null }
  } catch (error) {
    // 数不出来就说数不出来，不填 0。
    return { tables: null, indexes: null, error: error.message }
  } finally {
    try { store?.close?.() } catch { /* 已经关了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* 临时目录，删不掉不影响结论 */ }
  }
}

/* ── 3. 页签树 ────────────────────────────────────────────────────────── */

async function readModules() {
  const mod = await import(pathToFileURL(join(ROOT, 'src', 'state', 'workbench.js')).href)
  const groups = mod.MODULE_GROUPS
  must(Array.isArray(groups) && groups.length > 0, 'src/state/workbench.js 没有导出非空 MODULE_GROUPS')
  const leaves = groups.flatMap((g) => g.modules ?? [])
  must(leaves.length > 0, 'MODULE_GROUPS 里一个叶子模块都没有')
  return { groups, leaves }
}

/* ── 4. 页面：哪些页签真有渲染器 ──────────────────────────────────────── */

/** 从 `const NAME = {` 开始，读到与它配对的 `}`（这两张表都是扁平对象，够用）。 */
function objectKeys(source, declaration) {
  const start = source.indexOf(declaration)
  if (start < 0) return null
  const open = source.indexOf('{', start)
  const end = source.indexOf('\n}', open)
  if (open < 0 || end < 0) return null
  const body = source.slice(open + 1, end)
  return uniqueSorted(
    [...body.matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)].map((m) => m[1] ?? m[2] ?? m[3]),
  )
}

function readPanels() {
  const source = read(join(ROOT, 'src', 'web', 'page.js'))
  const renderers = objectKeys(source, 'const PANEL_RENDERERS')
  const notes = objectKeys(source, 'const PANEL_NOTES')
  // null 是「读不到这张表」，不是「这张表是空的」。空表（0 个占位说明）是合法且
  // 值得骄傲的状态：它意味着没有哪个页签是「声明了但还没画」。
  return { renderers, notes, error: renderers === null ? '没找到 const PANEL_RENDERERS' : null }
}

/* ── 5. 工具：定义与注册 ──────────────────────────────────────────────── */

function readTools() {
  const dir = join(ROOT, 'src', 'tools')
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort()
  const byModule = new Map()
  const all = []
  for (const file of files) {
    const text = stripComments(read(join(dir, file)))
    const names = uniqueSorted([...text.matchAll(/name:\s*'(amzn_[a-z0-9_]+)'/g)].map((m) => m[1]))
    if (names.length > 0) {
      byModule.set(file.replace(/\.js$/, ''), names)
      all.push(...names)
    }
  }
  const defined = uniqueSorted(all)
  // index.js 是唯一注册点：每个工具都以 `xxxTool(deps)` 的形式列在 registerTools 里。
  // 「定义有、注册没有」的工具会存在但调不到，而且不报错 —— 这正是要数的东西。
  const indexSource = stripComments(read(join(dir, 'index.js')))
  const registerBody = indexSource.slice(indexSource.indexOf('export function registerTools'))
  const registeredCalls = [...registerBody.matchAll(/([A-Za-z0-9_]+Tool)\(deps\)/g)].map((m) => m[1])
  return {
    byModule,
    defined,
    moduleFiles: byModule.size,
    scannedFiles: files.length - 1, // index.js 是注册表，不是工具模块
    registeredCalls: registeredCalls.length,
    registeredDistinct: new Set(registeredCalls).size,
    registrationDupes: uniqueSorted(registeredCalls.filter((c, i) => registeredCalls.indexOf(c) !== i)),
  }
}

/* ── 6. 测试套件 ──────────────────────────────────────────────────────── */

function readSuites() {
  const file = join(ROOT, 'tests', 'run.mjs')
  must(existsSync(file), 'tests/run.mjs 不存在')
  const text = read(file)
  const suites = uniqueSorted([...text.matchAll(/from '\.\/([a-z0-9-]+\.mjs)'/g)].map((m) => m[1]))
  // 只数「套件函数」的调用：`await runPageScript(...)` 这类页面小工具也叫 run*，
  // 把它们算进套件数就会多出一截，而多出来的那些不是测试。
  const called = new Set([...text.matchAll(/await\s+(run[A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]))
  const imported = uniqueSorted([...text.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/([a-z0-9-]+\.mjs)'/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean)))
  const calledSuites = imported.filter((fn) => called.has(fn))
  return {
    runner: 'tests/run.mjs',
    suites,
    imported,
    // 导入了却没 await 的套件 = 一个不会跑的测试，比没有更坏。
    importedNotCalled: imported.filter((fn) => !called.has(fn)),
    calledSuites: calledSuites.length,
  }
}

/* ── 7. 数据源：代码里有、但还没接的通道 ──────────────────────────────── */

function readSources() {
  const file = join(ROOT, 'src', 'sources', 'registry.js')
  if (!existsSync(file)) return { planned: null, ready: null, error: 'src/sources/registry.js 不存在' }
  const text = read(file)
  const planned = [...text.matchAll(/\['([a-z0-9-]+)',\s*plannedAdapter\(\{/g)].map((m) => m[1])
  const ready = [...text.matchAll(/\['([a-z0-9-]+)',\s*(?:manualAdapter|browserAdapter)\(/g)].map((m) => m[1])
  // 这里只读「静态声明」。一个 source 现在能不能用是运行时事实（数据库里的
  // enabled + 本机 Chrome），本脚本不猜它 —— 那要用 amzn_source_list 看。
  return { planned: uniqueSorted(planned), ready: uniqueSorted(ready), error: null }
}

/* ── 8. 原始调研的 11 项需求落在哪 ────────────────────────────────────── */

/**
 * 这一张是**手写的映射**，也是本文件里唯一手写的东西 —— 但它映射的是「需求 → 页签
 * id」，不是数字，而且每一个 id 都会对着 MODULE_GROUPS 校验：页签改名或删掉，
 * 脚本会直接报错，不会安静地印一张死表。
 *
 * 它只回答「这项需求现在落在哪个页签」，**不回答「这项需求满足了吗」**。
 * 页签存在不等于行为对；后者要看 tests/run.mjs 与真机报告。
 */
const ORIGINAL_ASKS = [
  { ask: '亚马逊采集器', module: 'collect' },
  { ask: 'ASIN 数据管理器', module: 'asin' },
  { ask: '竞品数据分析', module: 'competitor' },
  { ask: '关键词总库', module: 'kw' },
  { ask: '关键词调研', module: 'research' },
  { ask: '关键词管道', module: 'pipeline' },
  { ask: '最新政策', module: 'policy' },
  { ask: '规则获取', module: 'rules' },
  { ask: '生成报告', module: 'report' },
  { ask: '优化报告专区', module: 'optimize' },
  { ask: '优化提示词专区', module: 'prompts' },
]

/* ── 9. 组装 ──────────────────────────────────────────────────────────── */

const dash = (value) => (value === null || value === undefined ? '读不到' : String(value))
const tick = (ok) => (ok ? '✅' : '❌')

function render({ schema, shape, modules, panels, tools, suites, sources }) {
  const L = []
  const push = (s = '') => L.push(s)
  const ids = new Set(modules.leaves.map((m) => m.id))
  const deadMappings = ORIGINAL_ASKS.filter((row) => !ids.has(row.module))
  /* 「读不到这张表」和「这张表是空的」必须分开：把前者渲染成后者，
     就会在 page.js 被改名的那天安静地印出一个 ✅ 全有。 */
  const panelsReadable = panels.renderers !== null
  const rendererSet = new Set(panels.renderers ?? [])
  const noRenderer = panelsReadable ? modules.leaves.filter((m) => !rendererSet.has(m.id)) : []
  const notesReadable = panels.notes !== null
  const placeholder = notesReadable ? panels.notes.filter((id) => ids.has(id)) : []
  const tableConsistent = schema.createTable === shape.tables
  const indexConsistent = schema.createIndex === shape.indexes
  const registrationConsistent = tools.defined.length === tools.registeredDistinct

  push('# amazon-ops 完成度矩阵（自动生成）')
  push()
  push('> **本文件的数字由 `node scripts/report-completion.mjs` 生成，不要手改。**')
  push('> 手改会在下次生成时被覆盖；代码变了而本文件没重跑，')
  push('> `node scripts/report-completion.mjs --check` 会红 —— 这条校验已接进仓库根的')
  push('> `node scripts/check.mjs`（degraded 档），所以「文档过期」是机器能发现的失败。')
  push('>')
  push('> **本文件不含生成时间。** 时间戳会让 `--check` 永远红；「新不新」由 `--check`')
  push('> 回答，不由一行日期回答。')
  push()
  push('这份文件回答一个问题：**这个插件现在做到哪一步，还差什么。**')
  push('上一版是一份早期调研清单，里面的版本、工具数、页签数都停在当时的规模，')
  push('与现在差了一个数量级。那种文档比没有文档更坏 —— 它让人照着过期的数字')
  push('判断「还剩多少没做」。所以这里每个数字都从代码里读；读不到就写「读不到」，')
  push('不拿一个假的零去填。')
  push()

  push('## 1. 当前实测基线')
  push()
  push('| 维度 | 数值 | 从哪读 |')
  push('|---|---|---|')
  push(`| 迁移版本 \`SCHEMA_VERSION\` | **${dash(schema.version)}** | \`src/store/schema.js\` |`)
  push(`| 迁移条数 \`MIGRATIONS.length\` | **${dash(schema.count)}** | \`src/store/schema.js\` |`)
  push(`| 版本自洽（条数 = 版本号、无重号） | ${tick(schema.consistent)} ${schema.consistent ? '成立' : `不成立（重号：${schema.dups.join(', ') || '无'}）`} | 不变量 |`)
  push(`| 表 | **${dash(shape.tables)}**${shape.error ? `（读不到：${shape.error}）` : ''} | 跑完迁移的空库，数 \`sqlite_master\` |`)
  push(`| 索引 | **${dash(shape.indexes)}**${shape.error ? '（同上）' : ''} | 同上 |`)
  push(`| 迁移里的 \`CREATE TABLE\` 语句 | **${schema.createTable}** | \`src/store/schema.js\`（已剥注释） |`)
  push(`| 迁移里的 \`CREATE INDEX\` 语句（含 UNIQUE） | **${schema.createIndex}** | 同上 |`)
  push(`| 两种数法是否一致（语句 = 实际表） | ${tick(tableConsistent && indexConsistent)} ${tableConsistent && indexConsistent ? '一致' : '**不一致，见下**'} | 不变量 |`)
  push(`| 页签分组 | **${modules.groups.length}** | \`src/state/workbench.js\` 的 \`MODULE_GROUPS\` |`)
  push(`| 叶子页签 | **${modules.leaves.length}** | 同上（各组 \`modules\` 之和） |`)
  push(`| 工具总数 | **${tools.defined.length}** | \`src/tools/*.js\` 的 \`name: 'amzn_*'\` |`)
  push(`| 工具模块文件 | **${tools.moduleFiles}** / ${tools.scannedFiles} | 同上（\`index.js\` 是注册表，不计） |`)
  push(`| 测试套件 | **${suites.suites.length}** | \`tests/run.mjs\` 的 import |`)
  push()
  if (!tableConsistent || !indexConsistent) {
    push(`> ⚠️ 语句数与实际数不一致：\`CREATE TABLE\` ${schema.createTable} 条 vs 实际 **${dash(shape.tables)}** 张；`)
    push(`> \`CREATE INDEX\` ${schema.createIndex} 条 vs 实际 **${dash(shape.indexes)}** 个。`)
    push('> 迁移里有 `DROP` / `CREATE TEMP TABLE` 时这就会发生 —— 以实际数为准，并去查是哪条迁移。')
    push()
  }

  push('## 2. 页签树（含页面完成度）')
  push()
  push('“渲染器”一列读的是 `src/web/page.js` 的 `PANEL_RENDERERS`：有，说明这个页签点开')
  push('是一块真页面；没有，说明它只是一行占位说明。')
  push()
  for (const group of modules.groups) {
    push(`### ${group.label}（\`${group.id}\`）`)
    push()
    push('| 页签 | id | 渲染器 | 页内分区 |')
    push('|---|---|---|---|')
    for (const m of group.modules ?? []) {
      const sections = Array.isArray(m.sections) && m.sections.length > 0
        ? m.sections.map((s) => `\`${s.id}\`（${s.label ?? s.id}）`).join(' / ')
        : '—'
      push(`| ${m.label} | \`${m.id}\` | ${panelsReadable ? tick(rendererSet.has(m.id)) : '读不到'} | ${sections} |`)
    }
    push()
  }

  push('## 3. 差距清单（从代码读，不是手写）')
  push()
  push('这一节是这份文档真正的用途：**哪些东西声明了但还没接上。**')
  push('每一条都是一个可复核的集合差，不是印象。')
  push()
  push('| 检查 | 结果 | 差集 |')
  push('|---|---|---|')
  push(`| 页签都有渲染器 | ${panelsReadable ? (noRenderer.length === 0 ? '✅ 全有' : `❌ 缺 ${noRenderer.length} 个`) : '**读不到**'} | ${!panelsReadable ? (panels.error ?? '未知原因') : (noRenderer.length === 0 ? '—' : noRenderer.map((m) => `\`${m.id}\``).join(' '))} |`)
  push(`| 页签没有占位说明（\`PANEL_NOTES\`） | ${notesReadable ? (placeholder.length === 0 ? '✅ 一个都没有' : `❌ ${placeholder.length} 个仍是占位`) : '**读不到**'} | ${!notesReadable ? '没找到 const PANEL_NOTES' : (placeholder.length === 0 ? '—' : placeholder.map((id) => `\`${id}\``).join(' '))} |`)
  push(`| 工具定义都注册了（\`index.js\` 的 \`registerTools\`） | ${registrationConsistent ? '✅ 一致' : `❌ 定义 ${tools.defined.length} / 注册 ${tools.registeredDistinct}`} | ${registrationConsistent ? '—' : `两边差 ${Math.abs(tools.defined.length - tools.registeredDistinct)} 个（定义 ${tools.defined.length}，注册 ${tools.registeredDistinct}）`} |`)
  push(`| 工具注册无重复 | ${tools.registrationDupes.length === 0 ? '✅ 无' : `❌ ${tools.registrationDupes.length} 个`} | ${tools.registrationDupes.length === 0 ? '—' : tools.registrationDupes.join(' ')} |`)
  push(`| 套件导入了都调用了 | ${suites.importedNotCalled.length === 0 ? '✅ 一致' : `❌ ${suites.importedNotCalled.length} 个导入没调用`} | ${suites.importedNotCalled.length === 0 ? '—' : suites.importedNotCalled.join(' ')} |`)
  push(`| 数据源适配器已接（\`planned\` 就是没接） | ${sources.planned === null ? '**读不到**' : (sources.planned.length === 0 ? '✅ 全部已接' : `⚠️ ${sources.planned.length} 个未接`)} | ${sources.planned === null ? (sources.error ?? '未知原因') : (sources.planned.length === 0 ? '—' : sources.planned.map((id) => `\`${id}\``).join(' '))} |`)
  push(`| 原始调研的需求都能落到一个现存页签 | ${deadMappings.length === 0 ? '✅ 全部能' : `❌ ${deadMappings.length} 项落空`} | ${deadMappings.length === 0 ? '—' : deadMappings.map((r) => `「${r.ask}」→ \`${r.module}\``).join(' ')} |`)
  push()
  push('> 最后一行只证明「需求有地方放」，**不证明需求被满足了**。页签存在 ≠ 行为对。')
  push('> 数据源那一行的 `planned` 是代码里的静态声明；它现在到底能不能用，是运行时事实，')
  push('> 要用 `amzn_source_list` 看，本脚本不猜。')
  push()

  push(`## 4. 原始调研的 ${ORIGINAL_ASKS.length} 项需求现在落在哪`)
  push()
  push('| 用户需求 | 页签 | 页面渲染器 |')
  push('|---|---|---|')
  for (const row of ORIGINAL_ASKS) {
    const module = modules.leaves.find((m) => m.id === row.module)
    const rendered = !panelsReadable ? '读不到' : (module && rendererSet.has(row.module) ? '✅' : '❌')
    push(`| ${row.ask} | ${module ? `\`${module.id}\`（${module.label}）` : `**\`${row.module}\` 已不存在**`} | ${rendered} |`)
  }
  push()
  push('这张表是**需求 → 页签的定位表**，不是验收表。它回答「这件事现在在哪」，')
  push('不回答「做完了没有」—— 后者要看第 6 节的套件和第 7 节的边界。')
  push()

  push('## 5. 工具分布（按模块文件）')
  push()
  push('| 模块文件 | 工具数 | 工具 |')
  push('|---|---|---|')
  const entries = [...tools.byModule.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  for (const [name, names] of entries) {
    push(`| \`src/tools/${name}.js\` | ${names.length} | ${names.map((n) => `\`${n}\``).join(' ')} |`)
  }
  push()

  push('## 6. 测试套件')
  push()
  push(`注册在 \`${suites.runner}\`，共 **${suites.suites.length}** 个套件文件，`
    + `**${suites.calledSuites}** 个套件函数被 \`await\` 调用。`)
  push()
  for (const s of suites.suites) push(`- \`tests/${s}\``)
  push()

  push('## 7. 这份矩阵证明不了什么')
  push()
  push(`- 它证明的是**规模与接线**，不是**行为**：${tools.defined.length} 个工具都注册了，`)
  push('  不等于每一个都被真机跑过；页面有渲染器，不等于每个按钮都对。')
  push('- 表数/索引数来自「跑一遍迁移的空库」，不是线上库；线上库可能还停在旧版本。')
  push('- 它不判断内容质量（文案好坏、规则是否最新、数据是否够用）。')
  push('- 要证明行为，看 `node tests/run.mjs` 的实测数字与 `docs/qa/` 下的真机报告。')
  push()
  push('<!-- 生成结束：以上内容全部由 scripts/report-completion.mjs 生成。 -->')

  return { text: L.join('\n') + '\n', facts: { deadMappings, noRenderer, placeholder, tableConsistent, indexConsistent, registrationConsistent } }
}

/* ── 10. 两档漂移：结构 vs 测试套件 ──────────────────────────────────── */

/**
 * 从「已生成的 PRD」里读回它自己记的测试套件清单。
 *
 * 为什么要读回来：`--check` 要能回答一个更细的问题 ——「漂移的到底是不是**只有**
 * 测试套件数」。做法是把文档里记的套件喂回渲染器再生成一遍；如果这样生成的文本
 * 与磁盘上的文档逐字相同，那就说明除了套件那一块，其余每个数字都对得上。
 *
 * 读不回来（章节被改坏、数字与清单条数不一致）就返回 null，让调用方按结构漂移
 * 处理 —— 宁可红，不可误判成「只是测试变了」。
 */
function documentedSuites(text) {
  const start = text.indexOf('## 6. 测试套件')
  if (start < 0) return null
  const rest = text.slice(start)
  const nextHeading = rest.indexOf('\n## ', 1)
  const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading)
  const list = [...section.matchAll(/^- `tests\/([a-z0-9-]+\.mjs)`$/gm)].map((m) => m[1])
  const numbers = section.match(/共 \*\*(\d+)\*\* 个套件文件，\*\*(\d+)\*\* 个套件函数被/)
  if (!numbers || list.length === 0) return null
  const declared = Number(numbers[1])
  // 文档自相矛盾（写的条数与列出的条数不等）不是「可解释的漂移」，是坏文档。
  if (declared !== list.length) return null
  return { list, called: Number(numbers[2]) }
}

/* ── 11. 主流程 ───────────────────────────────────────────────────────── */

const schema = await readSchema()
const shape = await readStoreShape()
const modules = await readModules()
const panels = readPanels()
const tools = readTools()
const suites = readSuites()
const sources = readSources()
const { text: next, facts } = render({ schema, shape, modules, panels, tools, suites, sources })

const current = existsSync(PRD_PATH) ? read(PRD_PATH) : null

const summary = `v${schema.version} · ${schema.count} 迁移 · ${dash(shape.tables)} 表（CREATE TABLE ${schema.createTable}）`
  + ` · ${dash(shape.indexes)} 索引（CREATE INDEX ${schema.createIndex}）`
  + ` · ${modules.groups.length} 组/${modules.leaves.length} 页签`
  + ` · ${tools.defined.length} 工具（注册 ${tools.registeredDistinct}）`
  + ` · ${suites.suites.length} 套件`

if (CHECK_ONLY) {
  if (current === next) {
    process.stdout.write(`[prd] docs/PRD.md 与代码一致 —— ${summary}\n`)
    process.exit(0)
  }

  /* 漂移分两档（多人并行时的约定）：
   *
   *   FAIL  产品结构变了 —— 工具/表/索引/页签/渲染器/面板。PRD 必须跟着改。
   *   WARN  只有测试套件数变了。加测试是日常动作，不该让别人的文档闸门红。
   *
   * 判据不是「差在哪几行」（那要 diff，容易漏），而是：把文档自己记的套件喂回
   * 渲染器重画一遍。画出来与磁盘逐字相同 ⇒ 除了套件，其余全对得上 ⇒ WARN。
   */
  const doc = current === null ? null : documentedSuites(current)
  if (doc) {
    const asDocumented = render({
      schema, shape, modules, panels, tools, sources,
      suites: { ...suites, suites: doc.list, calledSuites: doc.called },
    }).text
    if (current === asDocumented) {
      const from = doc.list.length
      const to = suites.suites.length
      process.stdout.write(`[prd] WARN docs/PRD.md 的结构数字一致，只有测试套件数漂移（文档 ${from} → 代码 ${to}）\n`)
      process.stdout.write('[prd] WARN 这是 WARN，不阻塞；想消掉它：node scripts/report-completion.mjs\n')
      process.exit(0)
    }
  }

  process.stdout.write('[prd] docs/PRD.md 已过期 —— 结构数字与代码对不上（不是只有测试套件变了）\n')
  process.stdout.write(`[prd] 代码侧：${summary}\n`)
  if (doc) {
    // 只在套件数真的不同时才提它，否则这句话在结构漂移的现场没有信息量。
    if (doc.list.length !== suites.suites.length) {
      process.stdout.write(`[prd] 顺带：文档记的套件 ${doc.list.length} 个，代码 ${suites.suites.length} 个\n`)
    }
  } else if (current !== null) {
    process.stdout.write('[prd] 文档侧的套件清单读不回来（章节被改坏或自相矛盾）\n')
  }
  process.stdout.write('[prd] 修：node scripts/report-completion.mjs\n')
  process.exit(1)
}

writeFileSync(PRD_PATH, next, 'utf8')
process.stdout.write(`[prd] 写入 ${rel(PRD_PATH)}\n`)
process.stdout.write(`[prd] ${summary}\n`)

// 生成成功但事实不自洽时，退出码 1：写出来的东西要能被下游的 --check 采信，
// 就不能在「表数对不上」的时候还报成功。
const broken = []
if (!schema.consistent) broken.push('迁移版本不自洽（条数与版本号不等，或有重号）')
if (!facts.tableConsistent) broken.push('CREATE TABLE 语句数与实际表数不一致')
if (!facts.indexConsistent) broken.push('CREATE INDEX 语句数与实际索引数不一致')
if (!facts.registrationConsistent) broken.push('有工具定义了却没注册进 registerTools')
if (facts.deadMappings.length > 0) broken.push(`需求映射指向不存在的页签：${facts.deadMappings.map((r) => r.module).join(', ')}`)
if (panels.error) broken.push(panels.error)
if (facts.noRenderer.length > 0) broken.push(`${facts.noRenderer.length} 个页签没有渲染器`)
for (const line of broken) process.stdout.write(`[prd] ⚠️ ${line}\n`)
if (broken.length > 0) process.exitCode = 1

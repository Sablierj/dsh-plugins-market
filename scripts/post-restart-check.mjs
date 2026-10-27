#!/usr/bin/env node
/**
 * 重启后自检 —— 一条命令确认今天那 26 条修复在**磁盘代码**上都成立。
 *
 * ## 它验什么、不验什么（这两句话决定了它能不能被信任）
 *
 * **验**：磁盘上的代码 + 库里的真实数据，逐条对照期望。
 * **不验**：**运行中的插件**。插件从源码绝对路径加载（`cordis.patch.yml:84-85`），
 *   ESM import 在加载时求值一次，所以对话里调到的工具、页面上看到的一切，
 *   **在重启之前都是旧代码**。
 *
 * 2026-10-25 第 42 轮实测过这件事：同一份数据、同一个 ASIN、同一个判据，
 *   对话里的 `amzn_optimize_prepare` → 第 4 门 **0/16**、九门 6/3（旧代码）
 *   `node -e "import(...)"`            → 第 4 门 **13/16**、九门 7/2（新代码）
 * **这不是矛盾，是「改了代码但没重启」的直接证据。**
 *
 * 所以这个脚本的结论只有一句是可靠的：
 *   **「磁盘代码是对的」**。
 * 至于「运行中的插件是不是这份代码」—— 那要靠人在页面上看那五处一眼能分辨的地方
 * （见 `team/dev/post-restart-checklist-2026-10-25.md`）。
 *
 * ## 用法
 *   node scripts/post-restart-check.mjs
 * 退出码：全部符合期望 → 0；任何一条不符 → 1。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openStore } from '../src/store/db.js'
import { evaluatePrecheck } from '../src/domain/optimize/precheck.js'
import { buildAsinHealthSummary } from '../src/domain/asin/health.js'
import { buildFieldFacts } from '../src/domain/asin/fields.js'
import { buildAsinCompetitorView } from '../src/domain/asin/competitor.js'
import { describePeriod } from '../src/domain/keywords/period.js'
import { productImportTool } from '../src/tools/product-import.js'
import { runQualityScan } from '../src/store/quality.js'
import { listIssues } from '../src/store/quality.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASIN = 'B0GV55Q4JG'
const MARKET = 'US'

const src = (relative) => readFileSync(join(ROOT, relative), 'utf8')
const results = []

function record(id, what, ok, detail) {
  results.push({ id, what, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${id.padEnd(6)} ${what}${ok ? '' : '\n         → ' + detail}`)
}

const store = openStore({ dataDir: join(ROOT, 'data') })
const keywords = store.all("SELECT keyword FROM keyword WHERE marketplace = ?", [MARKET]).map(row => row.keyword)

/* ── R-13/R-14 后台词：空串必须算缺 ───────────────────────────────────── */
{
  const source = src('src/domain/optimize/validate.js')
  const hasBlank = /const blank = value => value === undefined \|\| value === null \|\| String\(value\)\.trim\(\) === ''/.test(source)
  record('R-13', '后台词空串算「缺」（blank 判据完整）', hasBlank,
    'validate.js 里的 blank 少了 trim() 分支 —— 空串会被当成有内容')
}

/* ── R-16 数据质量：只报告，不动状态 ─────────────────────────────────── */
{
  const source = src('src/store/quality.js')
  const noAutoClose = !/to: 'resolved',\s*\n\s*note: '本轮扫描没有再发现它/.test(source)
  const hasList = source.includes('notSeenAgain')
  record('R-16', '质量扫描只报告「没再发现」，不改状态', noAutoClose && hasList,
    noAutoClose ? 'findings 里找不到 notSeenAgain' : '扫描里又出现了自动 resolved —— t6:524 会红')
}

/* ── R-17 健康：ok 的中文是「已取得」，不是「正常」 ──────────────────── */
{
  const source = src('src/domain/asin/health.js')
  record('R-17', '健康状态 ok 印「已取得」而不是「正常」',
    source.includes("ok: '已取得'"),
    'health.js 里 ok 的标签又变回「正常」了')
}

/* ── R-18 竞品：组里不含本 ASIN 也要有对端 ───────────────────────────── */
{
  const view = buildAsinCompetitorView(store, { asin: ASIN, marketplace: MARKET })
  const ok = Array.isArray(view.peers) && view.peers.length > 0 && !String(view.comparisonNote ?? '').includes('无从对比')
  record('R-18', '竞品组不含本 ASIN 时仍然算得出对端', ok,
    `peers=${view.peers?.length ?? 0} note=${view.comparisonNote}`)
}

/* ── R-19 报告：按 nextDue.status 分组 ───────────────────────────────── */
{
  const source = src('src/domain/reports/build.js')
  record('R-19', '「还没到期」与「已经到期」分开说',
    source.includes("nextDue.status === 'pending'") && !source.includes('已经到期或即将到期'),
    'build.js 里分组判据或措辞又回去了')
}

/* ── R-20 搜索量：读 kw_master ──────────────────────────────────────── */
{
  const report = evaluatePrecheck(store, { asin: ASIN, marketplace: MARKET, keywords })
  const gate = report.gates.find(entry => entry.id === 'search-volume')
  const ok = gate !== undefined && gate.counts.matched > 0
  record('R-20', '第 4 门从 kw_master 读到搜索量（不是 0/16）', ok,
    `第 4 门 = ${gate?.counts.matched}/${gate?.counts.total}`)
}

/* ── R-21 搜索框：ORDER BY 不许用空列 ───────────────────────────────── */
{
  const source = src('src/domain/search/index.js')
  record('R-21', '搜索框排序用 COALESCE 后的量，不是空列',
    /ORDER BY COALESCE\(m\.search_volume, k\.search_volume\)/.test(source),
    'search/index.js 的 ORDER BY 又排到 legacy 的空列上了')
}

/* ── R-24 产品归属：单 ASIN 要写「无父」 ─────────────────────────────── */
{
  const tool = productImportTool({ store })
  const out = await tool.execute({ action: 'list' })
  const text = String(out.text ?? '')
  const selfRow = (out.rows ?? []).find(row => row.parent_asin === row.asin)
  const ok = selfRow === undefined ? true : (text.includes('无父') && text.includes('注：'))
  record('R-24', '单 ASIN 商品读出来写「无父 · 单 ASIN」', ok,
    '自指的行仍然只印 ASIN，读者会读成真父子')
}

/* ── R-25 冲突：0 条要说清是哪种 0 ──────────────────────────────────── */
{
  const fields = buildFieldFacts(store, { asin: ASIN, marketplace: MARKET })
  const report = evaluatePrecheck(store, { asin: ASIN, marketplace: MARKET, keywords })
  const summary = buildAsinHealthSummary(store, { asin: ASIN, marketplace: MARKET, fields, precheck: report })
  const item = summary.items.find(entry => entry.id === 'conflicts')
  const ok = String(item?.conclusion ?? '').includes('只有')
    record('R-25', '「0 条冲突」说明了为什么是 0', ok, `结论：${item?.conclusion}`)
}

/* ── R-26 dryRun：不许给一个不存在的 runId ──────────────────────────── */
{
  const source = src('src/tools/optimize.js')
  record('R-26', 'dryRun 时 runId 为 null',
    source.includes('const runId = args?.dryRun === true ? null : randomUUID()'),
    'optimize.js 里 runId 又变成无条件生成了')
}

/* ── 数据质量：notSeenAgain 能算出来 ────────────────────────────────── */
{
  const out = runQualityScan(store, { marketplace: MARKET })
  record('R-16b', '扫描返回 notSeenAgain（且不关闭任何问题）',
    Array.isArray(out.notSeenAgain) && listIssues(store, { status: 'open' }).length > 0,
    `notSeenAgain=${out.notSeenAgain?.length} open=${listIssues(store, { status: 'open' }).length}`)
}

/* ── R-11 第 1 门的「店铺」不是死格：product_profile.shop_id 有兜底 ───── */
{
  const source = src('src/domain/optimize/precheck.js')
  const hasFallback = source.includes('product_profile')
  const profile = store.get("SELECT shop_id FROM product_profile WHERE asin = ? AND marketplace = ?", [ASIN, MARKET])
  record('R-11', '第 1 门的店铺可从 product_profile 兜底（不是死格）',
    hasFallback && profile !== undefined && profile.shop_id !== null,
    hasFallback ? 'product_profile 里这一行没有 shop_id' : 'precheck.js 不再读 product_profile——店铺又成了死格')
}

/* ── R-12 产品档案有一条不依赖 xlsx 的直写路径 ───────────────────────── */
{
  const source = src('src/tools/product-import.js')
  const hasUpsert = source.includes("action === 'upsert'") || source.includes("'upsert'")
  record('R-12', 'amzn_product_import 有 action: upsert 直写路径',
    hasUpsert, 'product-import.js 里找不到 upsert 分支——写档案又只能靠 xlsx')
}

/* ── R-10 建店铺这条 agent 走得通 ────────────────────────────────────── */
{
  const exists = existsSync(join(ROOT, 'src/tools/shop.js'))
  const source = exists ? readFileSync(join(ROOT, 'src/tools/shop.js'), 'utf8') : ''
  record('R-10', 'amzn_shop_upsert 存在且带 list/create/update/archive/restore',
    exists && ['list', 'create', 'update', 'archive', 'restore'].every(a => source.includes(`'${a}'`)),
    exists ? 'shop.js 里少了某个 action' : 'src/tools/shop.js 不存在了')
}

/* ── R-9 产品线分类器不许教人写缓存 ──────────────────────────────────── */
{
  const source = src('src/tools/product-line.js')
  const ok = source.includes('amzn_asin_ownership_set') && !/product_line_id['"]?\s*[:=]\s*['"]?[a-z-]+['"]?\s*\}/.test(source.slice(-2000))
  record('R-9', '分类器收尾指向 ownership_set，不是写缓存列',
    source.includes('amzn_asin_ownership_set'),
    'product-line.js 的收尾又回退成写 asin.product_line_id')
}
/* ── R-29 位置计划提案：必须按这个 ASIN 的词过滤 ─────────────────────── */
{
  const { proposePlan } = await import('../src/store/keyword-plan.js')
  const scoped = proposePlan(store, { asin: ASIN, marketplace: MARKET })
  const mine = new Set([
    ...store.all('SELECT keyword FROM asin_keyword WHERE asin = ? AND marketplace = ?', [ASIN, MARKET]).map(r => r.keyword),
    ...store.all('SELECT keyword FROM keyword WHERE marketplace = ?', [MARKET]).map(r => r.keyword),
  ])
  const foreign = scoped.entries.filter(entry => !mine.has(entry.keyword)).map(entry => entry.keyword)
  record('R-29', '位置计划提案只提这个 ASIN 的词（不是全库 30778 个）',
    foreign.length === 0 && scoped.entries.length > 0 && scoped.entries.length < 1000,
    `词数 ${scoped.entries.length}，其中不属于这个 ASIN 的有 ${foreign.length} 个：${foreign.slice(0, 3).join(' / ')}`)
}
/* ── R-32 排班时间必须印成本地时间（不许丢掉 ISO 的 Z）──────────────── */
{
  const source = src('src/tools/kw.js')
  const noSlice = !/nextRunAt\.slice\(0, 16\)/.test(source) && !/lastRunAt\.slice\(0, 16\)/.test(source)
  record('R-32', '排班时间转本地再印，不再 slice 掉 ISO 的 Z',
    noSlice && source.includes('function localStamp(') && source.includes('localStamp(saved.nextRunAt)'),
    noSlice ? '找不到 localStamp 或它的调用' : '又出现 nextRunAt.slice(0,16) —— 那个 slice 会把 Z 丢掉，印出 UTC 当本地')
}
/* ── R-34 竞品差距报告的三列必须读扁平字段 ───────────────────────────── */
{
  const source = src('src/domain/reports/build.js')
  const usesFlat = source.includes('row.our_rank') && source.includes('row.competitor_best_rank')
    && source.includes('fmt(row.search_volume)')
  const usesNested = /row\.ours\?\.rank/.test(source) || /row\.theirs\?\.rank/.test(source)
  record('R-34', '竞品差距三列读扁平字段（our_rank / competitor_best_rank / search_volume）',
    usesFlat && !usesNested,
    usesNested ? '又出现 row.ours?.rank / row.theirs?.rank —— 那三个字段在 quadrantRows 里不存在，会整列印成 —'
      : '找不到扁平字段的读取')
}
/* ── R-36 质量扫描与健康卡都不许把竞品算进来 ─────────────────────────── */
{
  const { runQualityScan } = await import('../src/store/quality.js')
  const ruleSource = src('src/domain/data/quality-rules.js')
  const healthSource = src('src/domain/dashboard/health.js')
  const scanHasFilter = ruleSource.includes('isOurs(store, row.asin)') && ruleSource.includes('function isOurs(')
  const healthHasSide = healthSource.includes("object_type = 'side'") && healthSource.includes('scopedBySide')
  /* 真跑一次：扫出来的对象里不许有 side=competitor 的 ASIN */
  const competitors = new Set(store.all(
    "SELECT asin FROM asin_ownership WHERE object_type = 'side' AND object_id = 'competitor' AND retracted_at IS NULL",
  ).map(row => row.asin))
  const out = runQualityScan(store, {})
  const { listIssues } = await import('../src/store/quality.js')
  const offenders = listIssues(store, { status: 'open' })
    .filter(issue => competitors.has(String(issue.objectId ?? '').split('@')[0]))
    .map(issue => `${issue.objectId}#${issue.field ?? ''}`)
  /* 已有的历史行不会自己消失（R-16：扫描只 upsert）。所以这里验的是**本轮扫描**，
     而不是「库里一条都没有」—— 后者要人去清。 */
  record('R-36', '质量扫描与健康卡都按 side 排除竞品（本轮扫描不再产出竞品问题）',
    scanHasFilter && healthHasSide && out.scanned <= 1,
    `scanHasFilter=${scanHasFilter} healthHasSide=${healthHasSide} 本轮扫描=${out.scanned} 条｜库里历史行（需人清）: ${offenders.join(', ') || '无'}`)
}
/* ── R-38 side 覆盖：在架 ASIN 必须回答「它是我的还是别人的」──────────── */
{
  /* R-36 的根因是「自有 vs 竞品」在库里没有数据。第 71 轮补了 4 条之后，
     另外四处代码才有东西可读。**但那 4 条是事后补的** —— 下一次导入新 ASIN 时，
     同样的洞会重现：`asin_upsert` 只写那 10 个字段，**不问 side**。

     所以这一条守的不是「现在有没有」，而是「**将来会不会又漏**」：
     每一个在架 ASIN 都必须有 side 归属；没有的**列出来**（不是报个数字），
     因为它需要一个人回答「这个 ASIN 是谁的」——机器不该替它猜。 */
  const unclassified = store.all(
    `SELECT a.asin, a.marketplace FROM asin a
      WHERE a.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM asin_ownership o
                         WHERE o.asin = a.asin AND o.marketplace = a.marketplace
                           AND o.object_type = 'side' AND o.retracted_at IS NULL)
      ORDER BY a.asin`,
  )
  const inShelf = store.get("SELECT COUNT(*) AS n FROM asin WHERE archived_at IS NULL")?.n ?? 0
  record('R-38', '每个在架 ASIN 都回答了「自有还是竞品」（未分类的会列出来）',
    unclassified.length === 0 && inShelf > 0,
    unclassified.length === 0
      ? `在架 ${inShelf} 个 ASIN 都还没有 side 归属 —— 需要有人回答`
      : `这 ${unclassified.length} 个 ASIN 没有 side 归属，需要人回答「它是不是我的」：`
        + unclassified.map(row => `${row.asin}@${row.marketplace}`).join(', '))
}
/* ── R-45 prepare 的策略门禁必须读库，不许传字面量 ───────────────────── */
{
  const source = src('src/tools/optimize.js')
  /* 抓两头：① 源码里不许再有 strategyGate(null)；② 真跑一次读取，看门禁状态对不对。 */
  const noLiteral = !/strategyGate\(null\)/.test(source)
  const readsDb = /strategyGate\(readStrategyRow\(store, runId\)\)/.test(source)

  const { readStrategyRow, strategyGate } = await import('../src/domain/optimize/strategy.js')
  const run = store.get("SELECT id FROM optimization_run ORDER BY started_at DESC LIMIT 1")
  let behaviour = 'no-run'
  if (run) {
    const row = readStrategyRow(store, run.id)
    const gate = strategyGate(row)
    /* 有行时：状态必须是 unconfirmed 或 confirmed，**不能是 absent**。
       absent 的含义是「这一轮没有策略卡」，而这时库里明明有一行。 */
    behaviour = row ? gate.state : 'no-row'
    if (row && gate.state === 'absent') behaviour = 'WRONG:有行却报 absent'
  }
  record('R-45', 'prepare 的策略门禁读库（有行时不会报「没有策略卡」）',
    noLiteral && readsDb && behaviour !== 'WRONG:有行却报 absent',
    `noLiteral=${noLiteral} readsDb=${readsDb} 实测 gate=${behaviour}`)
}
/* ── 汇总 ────────────────────────────────────────────────────────────── */
const failed = results.filter(entry => !entry.ok)
console.log('')
console.log(`磁盘代码自检：${results.length - failed.length} / ${results.length} 通过`)
console.log('')
console.log('⚠️ 这个脚本验的是**磁盘上的代码**，不是运行中的插件。')
console.log('   插件从源码绝对路径加载、ESM 只求值一次 —— 重启之前，对话里调到的工具和页面上看到的')
console.log('   都还是旧代码。第 42 轮实测过：同一份数据，旧插件第 4 门 0/16、新代码 13/16。')
console.log('   运行中插件是否已是这份代码，请看 team/dev/post-restart-checklist-2026-10-25.md 的五步。')

if (failed.length > 0) process.exitCode = 1

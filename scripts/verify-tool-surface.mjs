#!/usr/bin/env node
/**
 * verify-tool-surface.mjs —— 把「工具面」的三条全量扫描做成一条命令。
 *
 * ## 它验什么
 * 一个工具**失败**时应当返回 `{ok:false, error}`，而不是抛异常
 * （`src/tools/index.js` 的 `instrument` 注释：「A tool reports failure by returning `{ok:false}`
 * rather than by throwing」）。所以「抛了」就是违规。
 *
 * 三条扫描线：
 *   ① 空参数        —— 最普通的路径，缺必填参数应当 ok:false，不应当抛
 *   ② 真实参数袋    —— 真 ASIN + 真词 + 真站点，走到取数/聚合那一层
 *   ③ 每个 action 枚举值 —— 工具 × 动作全枚举（枚举从注册后的定义读，不用正则猜）
 *
 * ## 为什么必须在沙箱里跑
 * 第二条与第三条会真的写库（`review_ingest`、`env_check` 之类）。所以先把库
 * `VACUUM INTO` 到临时目录，在副本上跑，跑完整个删掉 —— **真实库一个字节不动**。
 *
 * ⚠ 沙箱的文件名必须是 `amazon-ops.db`（`src/store/db.js:25`）。写成别的名字时
 * `openStore` 会**静默建一个空库**，于是报错看起来像「数据不对」而不是「你开错了库」。
 *
 * ## 用法
 *   node scripts/verify-tool-surface.mjs            # 跑三条线
 *   node scripts/verify-tool-surface.mjs --bag-only # 只跑第二条（快）
 * 退出码：0 全部没抛；1 有工具抛了（会逐个列出「工具 / 参数 / 报错」）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db.js'
import { registerTools } from '../src/tools/index.js'

const ASIN = 'B0GV55Q4JG'
const MARKET = 'US'
const KEYWORD = 'bench cushion'

/* 会驱动真实浏览器 / 全库重算的工具：在这个脚本里跳过。
   它们的共同点是「必须在真环境 + 真数据里单独验」，跳过要说出来，不能悄悄少测。 */
const SKIP = /collect_run|keyword_scan|keyword_discover|kw_merge|kw_pipeline_run|asin_delete/
const SKIP_REASON = '驱动真实浏览器 / 全库重算 / 不可逆'

const BAG = {
  asin: ASIN,
  marketplace: MARKET,
  keyword: KEYWORD,
  limit: 5,
  topN: 5,
  pages: 1,
}

const TIMEOUT_MS = 15000

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'amzn-surface-'))
  const target = join(dir, 'amazon-ops.db').replace(/\\/g, '/')
  const source = openStore({ dataDir: './data' })
  source.run(`VACUUM INTO '${target}'`)
  source.close()
  return { dir, store: openStore({ dataDir: dir }) }
}

const toolsOf = (store, dir) => {
  const registered = {}
  registerTools({ tools: { register: definition => { registered[definition.name] = definition } } }, {
    store,
    dataDir: dir,
    workbench: { record: () => {}, get: () => ({ contextId: null }) },
    pagePath: '',
    collection: null,
    collector: null,
  })
  return registered
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve({ __timeout: true }), ms)),
])

/** 跑一个工具的调用，返回 'ok' | 'ok:false' | 'timeout'，或者抛出来由调用方收集。 */
const attempt = async (definition, args) => {
  const out = await withTimeout(Promise.resolve(definition.execute(args)), TIMEOUT_MS)
  if (out && out.__timeout === true) return 'timeout'
  if (out && typeof out === 'object' && out.ok === false) return 'ok:false'
  return 'ok'
}

const { dir, store } = sandbox()
const registered = toolsOf(store, dir)
const names = Object.keys(registered).sort()
const runnable = names.filter(name => !SKIP.test(name))
const skipped = names.filter(name => SKIP.test(name))

console.log(`工具总数 ${names.length} · 本轮扫 ${runnable.length} · 跳过 ${skipped.length}（${SKIP_REASON}）`)
for (const name of skipped) console.log(`  · 跳过 ${name}`)

const failures = []
const tally = { ok: 0, 'ok:false': 0, timeout: 0 }

const run = async (label, pairs) => {
  const before = failures.length
  for (const { name, action, args } of pairs) {
    try {
      const result = await attempt(registered[name], args)
      tally[result] += 1
      if (result === 'timeout') failures.push({ label, name, action, message: `超过 ${TIMEOUT_MS}ms 没返回` })
    } catch (e) {
      tally['ok:false'] += 0
      failures.push({ label, name, action, message: String(e && e.message ? e.message : e).slice(0, 160) })
    }
  }
  console.log(`  ${label}：${pairs.length} 次调用，新增异常 ${failures.length - before}`)
}

console.log('')
console.log('① 空参数')
await run('空参数', runnable.map(name => ({ name, action: null, args: {} })))

if (!process.argv.includes('--bag-only')) {
  console.log('② 真实参数袋')
  await run('参数袋', runnable.map(name => ({ name, action: null, args: { ...BAG } })))

  console.log('③ 每个 action 枚举值')
  const combos = []
  for (const name of runnable) {
    const values = registered[name]?.parameters?.properties?.action?.enum
    if (!Array.isArray(values) || values.length === 0) continue
    for (const action of values) combos.push({ name, action, args: { ...BAG, action } })
  }
  await run('action 枚举', combos)
}

store.close()
rmSync(dir, { recursive: true, force: true })

console.log('')
console.log(`结果：ok ${tally.ok} · ok:false ${tally['ok:false']} · 超时 ${tally.timeout}`)

if (failures.length === 0) {
  console.log('✅ 没有一个工具抛异常 —— 「失败返回 ok:false」这条契约在扫过的路径上都成立。')
  process.exit(0)
}

console.log('')
console.log(`❌ ${failures.length} 处抛了异常（违反契约）：`)
for (const f of failures) {
  const where = f.action === null ? f.name : `${f.name} / action=${f.action}`
  console.log(`  [${f.label}] ${where}`)
  console.log(`      ${f.message}`)
}
process.exit(1)

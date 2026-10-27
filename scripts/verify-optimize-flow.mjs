#!/usr/bin/env node
/**
 * verify-optimize-flow.mjs —— 在沙箱副本上跑**整条优化流程**，看它能不能走到终点。
 *
 * ## 为什么要有这条命令
 * 优化是这个插件最长的链路：九项前置门 → 冻结上下文包 + 九条策略卡 → 人工确认 →
 * 校验（规则 + 预算 + 六道收尾门）→ 保存出报告（MD / HTML / Excel）。
 * 前面每一段都被单独验过，但「**从 prepare 一路跑到报告**」只在会话里手搓过两次，**跑完就没了**。
 *
 * ## 断言看的是库，不是返回值
 * 这些工具的 `execute` 返回的是**给人看的那段文本**（`{ text }`），结构化结果不在返回里。
 * 所以每一步的判据都从库里读（`optimization_run` / `optimization_draft`）——
 * **这比断言返回值更硬：状态的真相在库里。**
 *
 * ## 它断言什么、不断言什么
 * 断言**流程能走通**：运行建出来了、策略确认了、草案落库了、状态推进到 done、报告有内容。
 * **不断言「文案写得好」** —— 那是模型判断（14 项审阅），不是这条脚本能判的。
 * 所以校验阶段报出的阻断违规会**打出来但不判失败**：那是内容问题，不是流程断点。
 *
 * ## 在沙箱里跑
 * 先 `VACUUM INTO` 到临时目录、在副本上跑、跑完删掉。真实库一个字节不动。
 * **沙箱文件名必须是 `amazon-ops.db`**（`src/store/db.js:25`），否则 `openStore` 会静默建空库。
 *
 * 用法：node scripts/verify-optimize-flow.mjs       退出码 0 通过 / 1 有一步断了
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db.js'
import { optimizePrepareTool, optimizeValidateTool, optimizeSaveTool, optimizeReportTool } from '../src/tools/optimize.js'
import { confirmStrategy, readStrategy } from '../src/domain/optimize/strategy.js'

const ASIN = process.env.VERIFY_ASIN ?? 'B0GV55Q4JG'
const MARKET = process.env.VERIFY_MARKET ?? 'US'

/* 一份**本分的**草案：不用促销词、不用绝对词、不塞 emoji、长度留余量。
   目的不是写得好，是让校验那一步有东西可判、让保存那一步有内容可存。 */
const DRAFT = {
  title: 'Custom Size Bench Cushion, 75D High Density Foam Filling, Indoor Outdoor Seat Pad',
  bullets: [
    'CUSTOM SIZE: measure your bench seat and choose the size that fits, so the cushion sits flat without gaps.',
    '75D HIGH DENSITY FOAM: firm support that keeps its shape after long sitting, no sinking in the middle.',
    'REMOVABLE COVER: the cover zips off for washing, and the inner foam keeps its shape after cleaning.',
    'INDOOR AND OUTDOOR: works on window benches, dining benches, porch swings and bay window seats.',
    'EASY TO PLACE: the pad stays in place on wood, metal and wicker benches.',
  ],
  description: 'A custom size bench cushion made to fit your own bench seat. Measure the seat length, depth and thickness, then pick the option that matches. The foam holds its shape, and the zip cover can be removed for washing.',
  search_terms: 'bench seat pad custom cushion outdoor furniture replacement foam',
}

const step = (n, name) => console.log(`\n${n}. ${name}`)
const textOf = out => String(typeof out === 'string' ? out : (out?.text ?? ''))
const problems = []

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'amzn-flow-'))
  const target = join(dir, 'amazon-ops.db').replace(/\\/g, '/')
  const source = openStore({ dataDir: './data' })
  source.run(`VACUUM INTO '${target}'`)
  source.close()
  return { dir, store: openStore({ dataDir: dir }) }
}

const { dir, store } = sandbox()
const workbench = { record: () => {}, get: () => ({ contextId: 'verify-optimize-flow' }) }
const newestRun = () => store.get(
  'SELECT id, status, report_md FROM optimization_run WHERE asin = ? AND marketplace = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
  [ASIN, MARKET],
)

try {
  step(1, 'prepare —— 冻结上下文包 + 九项前置门 + 九条策略卡')
  const prepareText = textOf(await optimizePrepareTool({ store, workbench, pagePath: '' }).execute({
    asin: ASIN, marketplace: MARKET, mode: 'full', keywordsReviewed: true, includeMaster: true,
  }))
  const run = newestRun()
  const runId = run?.id
  if (!runId) {
    problems.push('prepare 之后库里没有新建的 optimization_run 行')
    console.log('   返回文本前 200 字：' + prepareText.slice(0, 200).replace(/\n/g, ' '))
  } else {
    const gateLine = prepareText.split('\n').find(line => line.includes('通过') && line.includes('降级')) ?? '(没找到门槛结论那一行)'
    console.log(`   runId = ${runId} · 库里状态 = ${run.status}`)
    console.log('   ' + gateLine.trim().slice(0, 120))
    const strategyRow = store.get('SELECT items_json, confirmed_at FROM optimization_strategy WHERE run_id = ?', [runId])
    const cardCount = strategyRow ? (JSON.parse(strategyRow.items_json || '[]')?.length ?? 0) : 0
    console.log(`   策略卡 ${cardCount} 条 · 已确认 = ${strategyRow?.confirmed_at != null}`)
  }

  if (runId) {
    step(2, 'confirmStrategy —— 人工确认那一刻（页面上点的是同一个函数）')
    try {
      confirmStrategy(store, { runId, by: 'verify-optimize-flow' })
      const strategy = readStrategy(store, runId)
      console.log(`   已确认 = ${strategy?.confirmed === true}`)
      if (strategy?.confirmed !== true) problems.push('confirmStrategy 之后 confirmed 仍不是 true')
    } catch (e) {
      problems.push('confirmStrategy 抛了：' + String(e && e.message ? e.message : e))
    }

    step(3, 'validate —— 规则 + 预算 + 六道收尾门（persist 落草案）')
    const validateText = textOf(await optimizeValidateTool({ store, workbench }).execute({
      runId, draft: DRAFT, keywords: [], persist: true,
    }))
    const drafts = store.get('SELECT COUNT(*) AS n FROM optimization_draft WHERE run_id = ?', [runId])?.n ?? 0
    const blocked = store.get('SELECT COUNT(*) AS n FROM optimization_draft WHERE run_id = ? AND violations_json LIKE \'%"block"%\'', [runId])?.n ?? 0
    console.log(`   落库草案 ${drafts} 个字段 · 其中带阻断违规 ${blocked} 个`)
    if (drafts === 0) problems.push('validate(persist) 之后库里没有草案行')
    const gateLines = validateText.split('\n').filter(line => /通过|阻断|警告/.test(line)).slice(0, 3)
    for (const line of gateLines) console.log('   ' + line.trim().slice(0, 120))

    step(4, 'save —— 收稿、跑闭门、写报告')
    const saveRaw = await optimizeSaveTool({ store, workbench, pagePath: '' }).execute({
      runId,
      accept: ['title', 'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5', 'description', 'search_terms'],
      summary: 'verify-optimize-flow.mjs 自动跑通的一次流程验证；文案不是重点，链路才是。',
    })
    const saveText = textOf(saveRaw)
    const after = newestRun()
    console.log(`   库里状态 = ${after?.status} · report_md 长度 = ${String(after?.report_md ?? '').length}`)
    if (String(saveText).length > 0) console.log('   返回文本前 80 字：' + saveText.slice(0, 80).replace(/\n/g, ' '))
    else console.log('   ⚠ save 没有返回文本，原始返回：' + JSON.stringify(saveRaw).slice(0, 400))
    if (after?.status !== 'done') problems.push(`保存后运行状态不是 done，而是 ${after?.status ?? '(没有这一行)'}`)
    if (String(after?.report_md ?? '').length < 500) problems.push('report_md 太短，报告可能没写出来')

    step(5, 'report —— 把报告读回来')
    const reportText = textOf(await optimizeReportTool({ store, pagePath: '' }).execute({ runId }))
    console.log(`   读回 ${reportText.length} 字符 · 前 60 字：${reportText.slice(0, 60).replace(/\n/g, ' ')}`)
    if (reportText.length < 500) problems.push('report 读回的正文太短')

    /* 这一条是**白捡的**：第一次跑这个脚本时没给「上下文」，save 直接 fail-closed 拒了：
         {ok:false, code:'DRAFT_CONTEXT_CHANGED', error:'这份草案没有记录它是在哪个上下文里生成的…'}
       那不是 bug，那是它该做的事 —— 所以把它变成一条正式断言：没有上下文的草案**必须**提交不了。 */
    step(6, 'fail-closed：没有生成上下文的草案，必须提交不了')
    const noCtx = { record: () => {}, get: () => ({ contextId: null }) }
    textOf(await optimizePrepareTool({ store, workbench: noCtx, pagePath: '' }).execute({
      asin: ASIN, marketplace: MARKET, mode: 'full',
    }))
    const run2 = store.get(
      'SELECT id FROM optimization_run WHERE asin = ? AND marketplace = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
      [ASIN, MARKET],
    )
    if (!run2?.id) {
      problems.push('第二次 prepare（无上下文）没有建出运行')
    } else {
      confirmStrategy(store, { runId: run2.id, by: 'verify-optimize-flow' })
      await optimizeValidateTool({ store, workbench: noCtx }).execute({ runId: run2.id, draft: DRAFT, persist: true })
      const refused = await optimizeSaveTool({ store, workbench: noCtx, pagePath: '' }).execute({ runId: run2.id, accept: ['title'] })
      const status2 = store.get('SELECT status FROM optimization_run WHERE id = ?', [run2.id])?.status
      console.log(`   拒绝码 = ${refused?.code ?? '(没有拒绝)'} · 该运行状态 = ${status2}`)
      if (refused?.code !== 'DRAFT_CONTEXT_CHANGED') {
        problems.push(`没有上下文的草案居然被提交了（拒绝码 ${refused?.code ?? '无'}）`)
      }
    }
  }
} finally {
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (problems.length === 0) {
  console.log(`✅ 优化流程从 prepare 走到 report 全通，并且 fail-closed 那条也成立（ASIN ${ASIN}@${MARKET}，沙箱内）。`)
  process.exit(0)
}
console.log(`❌ ${problems.length} 处断了：`)
for (const p of problems) console.log('   · ' + p)
process.exit(1)

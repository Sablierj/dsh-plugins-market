#!/usr/bin/env node
/**
 * browser-cdp 冒烟测试：用桩 ctx 真正跑一遍工具逻辑（不是只 apply 一次）。
 *
 * 为什么要有它：本仓库的 `scripts/check.mjs` 只证明「装得上」，不调用工具逻辑；
 * 浏览器这类活真正的失败（找不到 Chrome、端口不通、CDP 握手失败、选择器写错）
 * 只有真跑一遍才会暴露。这条测试自己拉起浏览器、开页面、取文本、截图、再关掉，
 * 并把「本轮是不是我拉起的浏览器」说清楚，避免留下用户没要的窗口。
 *
 * 用法：node product-team/tools/smoke-browser.mjs [url] [--keep-open]
 * 退出码：0 全通过；1 有失败；2 前置条件不满足。
 */

import { createRequire } from 'node:module'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..', 'plugins', 'browser-cdp', 'index.cjs')

const argv = process.argv.slice(2)
const keepOpen = argv.includes('--keep-open')
const url = argv.find(entry => !entry.startsWith('--')) ?? 'http://127.0.0.1:19387'

if (!existsSync(PLUGIN)) {
  console.error(`找不到插件：${PLUGIN}`)
  process.exit(2)
}

const registered = []
const stub = {
  tools: {
    register(definition) {
      if (registered.some(entry => entry.name === definition.name)) {
        throw new Error(`工具名重复注册：${definition.name}`)
      }
      registered.push(definition)
      return () => {}
    },
  },
}

const plugin = require(PLUGIN)
const dispose = plugin.apply(stub, {})

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

const byName = name => registered.find(entry => entry.name === name)
const call = async (name, args) => {
  const definition = byName(name)
  if (definition === undefined) throw new Error(`工具未注册：${name}`)
  return definition.execute(args, { agent: { session: { header: { cwd: process.cwd() } } } })
}

const screenshotPath = join(tmpdir(), `dsh-browser-smoke-${Date.now()}.png`)
let launchedByMe = false
let failure = null

try {
  check('插件导出了 apply 且注册了 8 个工具', typeof plugin.apply === 'function' && registered.length === 8, registered.map(entry => entry.name).join(','))

  for (const definition of registered) {
    const problems = []
    if (typeof definition.description !== 'string' || definition.description.length < 30) problems.push('description 太短')
    if (definition.parameters?.type !== 'object') problems.push('parameters 不是 object')
    if (typeof definition.output?.render !== 'function') problems.push('缺 output.render')
    if (definition.output?.schema === undefined) problems.push('缺 output.schema')
    if (problems.length > 0) check(`工具 ${definition.name} 定义完整`, false, problems.join('；'))
  }
  check('每个工具定义都完整', true, `${registered.length} 个`)

  const statusBefore = await call('browser_status', {})
  launchedByMe = statusBefore.listening !== true
  console.log(`  （浏览器现状：${statusBefore.listening ? '已在运行，复用' : '未运行，将按需拉起'}；port=${statusBefore.port}；launchable=${statusBefore.launchable}）`)

  if (statusBefore.listening !== true && statusBefore.launchable !== true) {
    console.error('  找不到 Chrome/Edge，冒烟测试无法继续（设置 DSH_BROWSER_PATH 后重试）')
    process.exit(2)
  }

  const opened = await call('browser_open', { url })
  check('browser_open 打开页面', opened.ok === true && !opened.timedOut, JSON.stringify(opened))

  const page = await call('browser_page', { max_chars: 800 })
  check('browser_page 取到 URL 与文本', page.ok === true && typeof page.url === 'string' && page.url !== '', `title=${JSON.stringify(page.title)} text_len=${String(page.text ?? '').length} maxCharsApplied=${page.maxCharsApplied}`)

  const evaluated = await call('browser_eval', { expression: 'document.querySelectorAll("*").length' })
  check('browser_eval 返回页面里的值', evaluated.ok === true && /^\d+$/.test(String(evaluated.json)), `元素数=${evaluated.json}`)

  const shot = await call('browser_screenshot', { file_path: screenshotPath })
  check('browser_screenshot 落盘 PNG', shot.ok === true && existsSync(screenshotPath) && statSync(screenshotPath).size > 1000, `${shot.file_path} ${shot.bytes} bytes`)

  const statusAfter = await call('browser_status', {})
  check('browser_status 能列出标签页', statusAfter.ok === true && Array.isArray(statusAfter.tabs) && statusAfter.tabs.length >= 1, JSON.stringify(statusAfter.tabs?.slice(0, 3)))

  const clickMissing = await call('browser_click', { selector: '#this-element-does-not-exist-dsh-smoke' })
  check('点不存在的选择器返回结构化失败（不抛错）', clickMissing.ok === false && typeof clickMissing.error === 'string', clickMissing.error)

  if (!keepOpen) {
    const closed = await call('browser_close', { close_browser: launchedByMe })
    check(`收尾：${launchedByMe ? '关闭本轮拉起的浏览器' : '只关掉本轮标签页（浏览器本来就在跑）'}`, closed.ok === true, JSON.stringify(closed))
    const statusEnd = await call('browser_status', {})
    check('收尾后状态可读', statusEnd.ok === true, `listening=${statusEnd.listening}`)
  }
} catch (error) {
  failure = error
} finally {
  try { if (typeof dispose === 'function') dispose() } catch { /* 卸载失败不改变结论 */ }
  try { if (existsSync(screenshotPath)) unlinkSync(screenshotPath) } catch { /* 临时文件删不掉就算了 */ }
}

const failed = checks.filter(entry => !entry.ok)
if (failure !== null) {
  console.error(`\n冒烟测试中断：${failure.message}`)
  process.exit(1)
}
if (failed.length > 0) {
  console.error(`\n${failed.length}/${checks.length} 项失败`)
  process.exit(1)
}
console.log(`\n冒烟测试通过：${checks.length} 项全过（截图证据已按需清理）`)

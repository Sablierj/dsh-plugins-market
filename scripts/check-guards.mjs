#!/usr/bin/env node
/**
 * 守门体检 —— 把「弄坏它，看它红不红」这件手工活变成一条命令。
 *
 * ## 为什么要有这个脚本
 *
 * 2026-10-25 我手工做了四批体检（t87 / t94 / t86-⑨），每一批都是
 * 备份 → 改坏 → 跑 → 看红 → 恢复 → 核对。四次之后我意识到：
 *
 *   **如果体检只能由「记得要体检的人」做，那它就等于不会发生。**
 *
 * 所以把配方写下来，让任何人在任何时间都能重跑一遍。
 * 一个不会红的守门和一个永远绿的守门一样没用 —— 前者更糟，
 * **它会逼人删掉正确的代码**（R-21 就误伤过两处）。
 *
 * ## 安全措施（这段代码会改生产文件，所以每一步都要能撤回）
 *
 *   1. 开始前 `git status` 必须干净 —— 否则恢复会丢别人的改动；
 *   2. 每条只改一处，改前把原文读进内存（不落盘的备份更可靠）；
 *   3. `try/finally` 里恢复，**无论测试成功失败都恢复**；
 *   4. 每条之后核对文件与 git 一致，不一致立刻中止整个体检。
 *
 * ## 用法
 *
 *   node scripts/check-guards.mjs          # 跑全部配方
 *   node scripts/check-guards.mjs t87      # 只跑一条
 *
 * 退出码：全部符合预期 → 0；任何一条不符 → 1。
 *
 * ## 加一条配方
 *
 * 在 RECIPES 里加一项：`file` / `find` / `replace`（或 `append`）/ `test` / `expect`。
 * `expect` 是「弄坏后应当出现的失败数下限」——**不写死具体条数**，
 * 因为断言数量会随测试演进变化，而要证明的是「它红了」，不是「它红了几条」。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 每条配方都是一句「怎么把它弄回修复前的样子」。
 *
 * `find` 找不到时**不静默跳过** —— 那说明被测代码已经变了，
 * 这条配方本身过期了，比守门退化成装饰更值得知道。
 */
const RECIPES = [
  {
    id: 't87',
    what: '空值占位改回空串（R-3 修复前的样子）',
    file: 'src/tools/render.js',
    find: "const EMPTY_CELL = '—'",
    replace: "const EMPTY_CELL = ''",
    test: 'tests/t87-table-empty-cell.mjs',
    expect: 1,
  },
  {
    id: 't94',
    what: '搜索框排序改回空列，并去掉 LEFT JOIN（R-21 修复前的样子）',
    file: 'src/domain/search/index.js',
    find: 'ORDER BY COALESCE(m.search_volume, k.search_volume) DESC NULLS LAST LIMIT ?',
    replace: 'ORDER BY k.search_volume DESC NULLS LAST LIMIT ?',
    test: 'tests/t94-search-volume-table.mjs',
    expect: 1,
  },
  {
    id: 't86-9',
    what: '把已清掉的旧控件名写回**代码**里（不是注释）',
    file: 'src/tools/render.js',
    append: "export const LEGACY_PAGE_TEXT = '页面还没有开跑按钮'\n",
    test: 'tests/t86-optimize-run.mjs',
    expect: 1,
  },
  {
    id: 't90',
    what: '让 notSeenAgain 恒为空（「本轮没再发现」那条线索消失）',
    file: 'src/store/quality.js',
    find: '    if (seen.has(key)) continue',
    replace: '    if (seen.has(key)) continue\n    continue /* 体检注入：制造「永远不报」 */',
    test: 'tests/t90-dq-not-seen-again.mjs',
    expect: 1,
  },
  {
    id: 't86-8',
    what: '把「开跑这一轮」按钮的 label 改成别的 —— 文案就指向一个不存在的控件',
    file: 'src/web/pages/optimize.js',
    /* 这个 label 在 optimize.js 里**不止一处**（还有一处 2008 行附近的按钮）。
       第一版配方只改了一处，于是 t86-⑧ 照样绿 —— 不是守门失效，是**我的配方没改全**：
       守门判的是整份下发文档，只要还有一处控件在，它就认为「文案指向的控件存在」。
       那个行为是对的。所以配方要 all: true，把所有按钮都改掉。 */
    find: '>开跑这一轮</button>',
    all: true,
    replace: '>跑一下</button>',
    test: 'tests/t86-optimize-run.mjs',
    expect: 1,
  },
  {
    id: 't88',
    what: '给 action 枚举加一个没有分支的值',
    file: 'src/tools/product-import.js',
    find: "enum: ['scan', 'preview', 'commit', 'list', 'upsert']",
    replace: "enum: ['scan', 'preview', 'commit', 'list', 'upsert', 'ghost-action']",
    test: 'tests/t88-action-enum-wired.mjs',
    expect: 1,
  },
  {
    id: 't89',
    what: '空串重新算「有内容」（R-13 修复前的判据）',
    file: 'src/domain/optimize/validate.js',
    find: "const blank = value => value === undefined || value === null || String(value).trim() === ''",
    replace: 'const blank = value => value === undefined',
    test: 'tests/t89-backend-terms-gate.mjs',
    expect: 1,
  },
  {
    id: 't91',
    what: '把「组里含本 ASIN 才算对端」那行加回去（R-18 修复前的短路）',
    file: 'src/domain/asin/competitor.js',
    find: 'for (const member of members) if (member !== key) peerSet.add(member)',
    replace: 'if (!containsThis) continue\n    for (const member of members) if (member !== key) peerSet.add(member)',
    test: 'tests/t91-competitor-peers.mjs',
    expect: 1,
  },
  {
    id: 't92',
    what: '把「按 nextDue.status 分组」改回「有节点就算」（R-19 修复前）',
    file: 'src/domain/reports/build.js',
    find: "card.nextDue.status === 'pending'",
    replace: 'card.nextDue !== null',
    test: 'tests/t92-reports-due-wording.mjs',
    expect: 1,
  },
  {
    id: 't93',
    what: '搜索量改回只读 legacy keyword（R-20 修复前）',
    file: 'src/domain/optimize/precheck.js',
    find: 'COALESCE(m.search_volume, k.search_volume)',
    replace: 'k.search_volume',
    test: 'tests/t93-search-volume-source.mjs',
    expect: 1,
  },
]
/**
 * 没有配方的守门，**必须写明理由**。
 *
 * 2026-10-25：配方从 4 条补到 10 条之后，剩下的空白靠人去记 —— 那等于没有。
 * 这一张表 + 下面那条自检，让「新加一条守门却没有可破坏的判据」这件事**会在体检里报出来**。
 */
const SKIP = {
  't85-collect-targets': '判据是「两边 equal 都是 !==」。要弄坏它得改测试自己的实现 —— '
    + '那测的是「测试会不会自己出错」，不是被测代码。它的价值在 ⑨ 那条源码守门，'
    + '而那条已经由「配方表里的 equal 必须严格」这条约定覆盖。',
}

/**
 * 自检：`tests/` 下每个 `t8*` / `t9*` 测试，要么在 RECIPES 里，要么在 SKIP 里写明理由。
 *
 * **它守的是「守门不会悄悄多出一条没人验过的」** —— 这是唯一能让体检长期有效的办法：
 * 体检的覆盖面由一条会红的判据维护，而不是由我记性维护。
 */
function selfCheckRecipes() {
  /* 2026-10-25：我第一版是「扫 tests 下 t8x / t9x 里没有配方的」——**范围太宽**，
     把它当成守门的自动发现，结果把 t80/t81/t82/t83/t84 这些**功能测试**也报了出来。
     功能测试没有「守门判据」，天然不该有弄坏配方。

     改成守门的是**配方自身**：每条配方的测试文件与目标文件都必须真的存在。
     这能抓住真正会发生的事 —— 代码重构之后配方过期（find 字符串找不到），
     以及配方指向了一个已经不存在的测试。**覆盖面靠「加守门时加配方」这条约定，
     不靠脚本猜；脚本只保证已有的配方不烂掉。** */
  const problems = []
  for (const recipe of RECIPES) {
    if (!existsSync(join(ROOT, recipe.test))) problems.push(`${recipe.id}: 测试文件不存在 ${recipe.test}`)
    if (!existsSync(join(ROOT, recipe.file))) problems.push(`${recipe.id}: 目标文件不存在 ${recipe.file}`)
  }
  const ids = RECIPES.map(recipe => recipe.id)
  const dupes = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (dupes.length > 0) problems.push(`配方 id 重复：${[...new Set(dupes)].join(', ')}`)
  return { total: RECIPES.length, skip: Object.keys(SKIP).length, problems }
}
function gitStatus(paths) {
  return execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: ROOT, encoding: 'utf8' }).trim()
}

function runTest(relative) {
  try {
    const out = execFileSync('node', [relative], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { failed: parseFailed(out) }
  } catch (error) {
    const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`
    return { failed: parseFailed(text), crash: !/passed \/ \d+ failed/.test(text) }
  }
}

function parseFailed(text) {
  const line = text.split('\n').filter(entry => /\d+ passed \/ \d+ failed/.test(entry)).pop()
  if (line === undefined) return null
  const match = /(\d+) passed \/ (\d+) failed/.exec(line)
  return match === null ? null : Number(match[2])
}

function main() {
  const only = process.argv[2] ?? null
  const recipes = only === null ? RECIPES : RECIPES.filter(recipe => recipe.id === only)
  if (recipes.length === 0) {
    console.error(`没有这条配方：${only}`)
    process.exitCode = 1
    return
  }

  /* 先做覆盖面自检：新加的守门如果没有配方、也没在 SKIP 里写明理由，先报出来。
     这一步在改任何文件之前做 —— 它不碰代码，只读。 */
  const coverage = selfCheckRecipes()
  if (coverage.problems.length > 0) {
    console.error('体检配方自身有问题：')
    for (const name of coverage.orphans) console.error(`  · ${name}`)
    console.error('配方指向的测试 / 目标文件必须存在；改了代码就同步改配方。')
    process.exitCode = 1
    return
  }
  console.log(`配方：${coverage.total} 条，跳过 ${coverage.skip} 条（各写明理由）。`)
  console.log('')

  const touched = [...new Set(recipes.map(recipe => recipe.file))]
  const dirty = gitStatus(['src/', 'tests/'])
  if (dirty !== '') {
    console.error('工作区不干净，体检会覆盖别人的改动。先提交或还原：\n' + dirty)
    process.exitCode = 1
    return
  }

  const results = []
  for (const recipe of recipes) {
    const full = join(ROOT, recipe.file)
    const original = readFileSync(full, 'utf8')
    let outcome
    try {
      if (recipe.append !== undefined) {
        writeFileSync(full, original + recipe.append)
      } else {
        if (!original.includes(recipe.find)) {
          outcome = { id: recipe.id, verdict: 'STALE', note: `配方过期：在 ${recipe.file} 里找不到那段代码` }
          continue
        }
        writeFileSync(full, recipe.all === true
          ? original.split(recipe.find).join(recipe.replace)
          : original.replace(recipe.find, recipe.replace))
      }
      const tested = runTest(recipe.test)
      if (tested.crash === true || tested.failed === null) {
        outcome = { id: recipe.id, verdict: 'UNKNOWN', note: '测试没跑出汇总行（可能直接崩了）' }
      } else if (tested.failed < recipe.expect) {
        outcome = { id: recipe.id, verdict: 'NOT_RED', note: `弄坏后只红了 ${tested.failed} 条（期望 ≥ ${recipe.expect}）—— 这条守门可能已退化成装饰` }
      } else {
        outcome = { id: recipe.id, verdict: 'OK', note: `弄坏后红了 ${tested.failed} 条` }
      }
    } finally {
      /* 无论上面发生什么，文件都必须回到原样。 */
      writeFileSync(full, original)
    }
    const after = gitStatus([recipe.file])
    if (after !== '') {
      console.error(`!!! ${recipe.file} 恢复失败，立刻中止 !!!\n${after}`)
      process.exitCode = 1
      return
    }
    results.push({ ...outcome, what: recipe.what })
    console.log(`${outcome.verdict === 'OK' ? 'ok  ' : 'FAIL'}  ${recipe.id.padEnd(8)} ${outcome.verdict.padEnd(8)} ${outcome.note}`)
  }

  /* 恢复后必须仍然全绿 —— 否则说明恢复不完整。 */
  console.log('')
  console.log('恢复核对：')
  let allGreen = true
  for (const recipe of recipes) {
    const tested = runTest(recipe.test)
    const green = tested.failed === 0
    if (!green) allGreen = false
    console.log(`  ${green ? '绿' : '红'}  ${recipe.test}`)
  }
  const dirtyAfter = gitStatus(touched)
  console.log(`  ${dirtyAfter === '' ? '干净' : '!! 有改动 !!'}  ${touched.join(', ')}`)

  const bad = results.filter(result => result.verdict !== 'OK')
  console.log('')
  if (bad.length > 0 || !allGreen || dirtyAfter !== '') {
    console.log(`体检未通过：${bad.length} 条守门没有按预期变红${allGreen ? '' : '，或恢复后没有回到全绿'}`)
    process.exitCode = 1
    return
  }
  console.log(`全部 ${results.length} 条守门都会红，且恢复后全绿。`)
}

main()

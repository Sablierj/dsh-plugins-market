#!/usr/bin/env node
/**
 * 编制自检：每个角色技能章程是否齐全、是否与流程总纲对齐。
 *
 * 为什么要有它：8 份章程是并行写出来的，格式漂移是这种活最常见的失败模式
 * （少一节、术语换名、引用了不存在的路径）。这个脚本把「编制完整」变成一条命令。
 *
 * 用法：node product-team/tools/check-skills.mjs [skillsDir]
 * 退出码：0 全部通过；1 有问题；2 目录不存在。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILLS = resolve(process.argv[2] ?? join(HERE, '..', 'skills'))

/** 每个角色技能必须出现的二级标题，顺序一致。 */
const REQUIRED_SECTIONS = [
  '## 使命',
  '## 职责',
  '## 开工输入',
  '## 交付物',
  '## 完成的定义（DoD）',
  '## 明确不做',
  '## 与其他角色的接口',
  '## 本机可用能力与用法',
  '## 卡住了怎么办（升级路径）',
]

/** 必须存在、且必须与流程总纲写法一致的角色 id。 */
const EXPECTED = [
  'team-role-product-manager',
  'team-role-requirements-researcher',
  'team-role-architect',
  'team-role-fullstack-engineer',
  'team-role-ui-designer',
  'team-role-ux-designer',
  'team-role-qa-engineer',
  'team-role-amazon-operator',
]

/** 证据口径四个词必须至少各出现一次（除流程总纲外的角色章程）。 */
const EVIDENCE_WORDS = ['verified', 'documented', 'stale', 'unverified']

/** 已知失效的写法：本地插件没装进桌面 App 时，19387 上不存在工作台页。 */
const FORBIDDEN = [
  { pattern: /127\.0\.0\.1:19387\/custom\/amazon-ops/, why: '桌面 App 未加载 amazon-ops，该 URL 必然 404；开发实例是 3080' },
]

if (!statSync(SKILLS, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`skills 目录不存在：${SKILLS}`)
  process.exit(2)
}

const problems = []
const dirs = readdirSync(SKILLS).filter(name => statSync(join(SKILLS, name)).isDirectory()).sort()

for (const dir of dirs) {
  const file = join(SKILLS, dir, 'SKILL.md')
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    problems.push(`${dir}: 缺 SKILL.md`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/).length

  if (!/^---\r?\n/.test(text)) problems.push(`${dir}: 缺 frontmatter`)
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim()
  if (name !== dir) problems.push(`${dir}: frontmatter name 是 ${JSON.stringify(name)}`)
  if (!/^description:\s*\S/m.test(text)) problems.push(`${dir}: frontmatter 缺 description`)
  if (lines > 140) problems.push(`${dir}: ${lines} 行，超过 140 行上限`)

  if (dir !== 'product-team-process') {
    let cursor = -1
    for (const section of REQUIRED_SECTIONS) {
      const at = text.indexOf(section)
      if (at === -1) { problems.push(`${dir}: 缺小节 ${section}`); continue }
      if (at < cursor) problems.push(`${dir}: 小节顺序不对（${section}）`)
      cursor = at
    }
    for (const word of EVIDENCE_WORDS) {
      if (!text.includes(word)) problems.push(`${dir}: 未使用证据口径 ${word}`)
    }
    if (!text.includes('product-team-process')) problems.push(`${dir}: 未引用流程总纲技能`)
  }

  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(text)) problems.push(`${dir}: 出现失效写法（${why}）`)
  }
}

for (const expected of EXPECTED) {
  if (!dirs.includes(expected)) problems.push(`缺角色技能目录 ${expected}`)
}

for (const dir of dirs) console.log(`  ${problems.some(p => p.startsWith(dir + ':')) ? 'FAIL' : 'OK  '} ${dir}`)

if (problems.length === 0) {
  console.log(`\n编制自检通过：${dirs.length} 个技能，全部与流程总纲对齐`)
  process.exit(0)
}

console.log(`\n${problems.length} 个问题：`)
for (const problem of problems) console.log(`  - ${problem}`)
process.exit(1)

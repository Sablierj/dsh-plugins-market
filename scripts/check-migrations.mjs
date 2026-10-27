/* 迁移表自洽探针（10 秒）—— 合并后先跑这个，再决定要不要跑全量。
 *
 * 出处：WorkBuddy 的 §3.34（v40 版本号硬冲突的跨会话裁决请求）。它读
 * `src/store/db.js:86-114` 指出跳过条件是 `step.version <= current`：
 * 并列两条同版本号时**只有数组里靠前的那条会跑**；在已经升到该版本的库上
 * **两条都不跑**。而 `git merge` 成功不是证据（§3.1）。
 *
 * 期望输出：dups:[] 且 count === SCHEMA_VERSION 且 版本号是 1..N 连续升序。
 * 任何一条不成立 = 已经撞了。
 */
import { MIGRATIONS, SCHEMA_VERSION } from '../src/store/schema.js'

const versions = MIGRATIONS.map(m => m.version)
const dups = versions.filter((v, i) => versions.indexOf(v) !== i)
const continuous = versions.every((v, i) => v === i + 1)
const report = {
  count: MIGRATIONS.length,
  SCHEMA_VERSION,
  dups,
  continuous,
  last: MIGRATIONS.at(-1)?.name ?? null,
  first: MIGRATIONS[0]?.name ?? null,
}
console.log(JSON.stringify(report))

const problems = []
if (dups.length > 0) problems.push(`重复版本号: ${dups.join(', ')}`)
if (MIGRATIONS.length !== SCHEMA_VERSION) problems.push(`条数 ${MIGRATIONS.length} !== SCHEMA_VERSION ${SCHEMA_VERSION}`)
if (!continuous) problems.push('版本号不是 1..N 连续升序')

if (problems.length > 0) {
  console.error('迁移表已经撞了：')
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exit(1)
}
console.log('迁移表自洽 ✓')

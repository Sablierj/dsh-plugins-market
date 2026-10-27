/**
 * FR-M2-05 开工前的**最小复现**：`upsertAsin` 用 COALESCE 把人工决定吞掉，且不留痕。
 *
 * 跑法（仓库任意位置）：
 *   node team/dev/fr-m2-05-coalesce-repro.mjs
 *
 * 全部在**临时库**里做（`openStore` + `mkdtemp`），跑完删掉，不碰 `data/amazon-ops.db`。
 * 写库的调用形状与生产一致：`upsertAsin(store, record)`，来源在 `record.sourceId`
 * （`src/tools/asin.js` 就是这么传的）。
 *
 * 要看四件事：
 *   ① 采集落库 → adopted = line-a，来源记到 browser-local；
 *   ② 人工修正（`correctAsinField`，本仓唯一的人工通道）→ adopted = line-b，来源多一行 manual；
 *   ③ 再来一次**带 product_line_id 的 upsert**（= `amzn_product_line_classify` 之后的应用路径）
 *      → adopted 被换回 line-a，而 manual 那行**还写着 line-b**：采用值与来源互相矛盾；
 *      且 audit_log 与 field_conflict **各 0 行增量** —— 没有任何一处留下「这次覆盖」的痕迹；
 *   ④ 反面控制：upsert **不带** product_line_id 时，人工值活得好好的
 *      （证明是「带这一格」才吞，不是整个 upsert 都不可信）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../../src/store/db.js'
import { upsertAsin, upsertProductLine } from '../../src/store/queries.js'
import { correctAsinField } from '../../src/store/asin.js'

const LOGGER = { info() {}, warn() {}, error() {}, log() {} }
const dir = mkdtempSync(join(tmpdir(), 'amzn-frm205-'))
const store = openStore({ dataDir: dir, logger: LOGGER })

const line = id => ({ id, name: id.toUpperCase(), signals: { core: [id], exclude: [], scenario: [], material: [] } })
upsertProductLine(store, line('line-a'))
upsertProductLine(store, line('line-b'))

const ASIN = 'B0M205TEST'
const MARKET = 'US'
const adopted = () => store.get('SELECT product_line_id FROM asin WHERE asin = ? AND marketplace = ?', [ASIN, MARKET]).product_line_id
const sources = () => store.all(
  "SELECT source_id, value, source_type FROM asin_field_source WHERE asin = ? AND marketplace = ? AND field = 'product_line_id' ORDER BY source_id",
  [ASIN, MARKET],
)
const audits = () => store.get('SELECT COUNT(*) AS n FROM audit_log').n
const conflictRow = () => store.get("SELECT * FROM field_conflict WHERE field = 'product_line_id' AND asin = ? AND marketplace = ?", [ASIN, MARKET])

/* ① 采集 / 导入落库 */
upsertAsin(store, { asin: ASIN, marketplace: MARKET, title: '测试商品', product_line_id: 'line-a', sourceId: 'browser-local' })
console.log('① 采集落库      adopted =', JSON.stringify(adopted()), '· 来源 =', JSON.stringify(sources()),
  '· 冲突行 =', conflictRow() === undefined ? '无' : '有')

/* ② 人工在页面上改成 line-b（correctAsinField 会顺手开一条冲突行 —— 见下面 ③ 的说明） */
correctAsinField(store, { asin: ASIN, marketplace: MARKET, field: 'product_line_id', value: 'line-b', reason: '运营判断：属于 B 线' })
const openedAtHuman = conflictRow()
console.log('② 人工改完      adopted =', JSON.stringify(adopted()), '· 来源 =', JSON.stringify(sources()))
console.log('   注意：此时系统**自己开了一条冲突行**（人工值 vs 采集值）：',
  openedAtHuman === undefined ? '没有（不该）' : `status=${openedAtHuman.status} · adopted_value=${JSON.stringify(openedAtHuman.adopted_value)} · 建议来源=${JSON.parse(openedAtHuman.suggestion_json).byPriority.sourceId}(${JSON.parse(openedAtHuman.suggestion_json).byPriority.value})`)

const audit0 = audits()

/* ③ 分类器的应用路径：再 upsert 一次，带着它建议的 product_line_id */
upsertAsin(store, { asin: ASIN, marketplace: MARKET, product_line_id: 'line-a', sourceId: 'browser-local' })
const rows = sources()
const conflictAfter = conflictRow()
const suggestion = conflictAfter === undefined ? null : JSON.parse(conflictAfter.suggestion_json)
const overrideAudits = store.all("SELECT * FROM audit_log WHERE action = 'asin.field.manual-overridden'")
console.log('\n③ 再 upsert 一次（product_line_id: line-a）')
console.log('   adopted =', JSON.stringify(adopted()), '   ← 人工值 line-b 从采用值里消失了（B 方案：覆盖仍然发生）')
console.log('   来源    =', JSON.stringify(rows))
console.log('   audit_log 增量 =', audits() - audit0, '· asin.field.manual-overridden 行数 =', overrideAudits.length)
if (overrideAudits.length > 0) {
  const audit = overrideAudits[0]
  console.log('   审计内容: before =', audit.before_json, '· after =', audit.after_json)
  console.log('             reason =', audit.reason)
}
if (conflictAfter !== undefined) {
  console.log('   冲突行: status =', conflictAfter.status,
    '· adopted_value =', JSON.stringify(conflictAfter.adopted_value),
    '· adopted_source =', JSON.stringify(conflictAfter.adopted_source_id),
    '· note =', JSON.stringify(conflictAfter.note))
  console.log('           建议 byPriority =', suggestion === null ? null : `${suggestion.byPriority.sourceId}(${suggestion.byPriority.value})`)
}

/* ── B 方案的四条要求（lead 2026-10-25 拍板）: 逐条 PASS/FAIL ────────────── */
console.log('\n── B 方案四条要求 ──')
const verdicts = [
  ['① 覆盖仍然发生（不改采集语义）', adopted() === 'line-a'],
  ['② 覆盖留下了审计（带被覆盖的值与覆盖者）', overrideAudits.length === 1
    && overrideAudits[0].before_json.includes('line-b') && overrideAudits[0].after_json.includes('browser-local')],
  ['③ 冲突回到了工作台（status = open）', conflictAfter !== undefined && conflictAfter.status === 'open'],
  ['④ 而「人工值是什么」没有丢（adopted_value = 人工值）', conflictAfter !== undefined
    && JSON.parse(conflictAfter.adopted_value) === 'line-b' && conflictAfter.adopted_source_id === 'manual'],
]
let bad = 0
for (const [label, ok] of verdicts) {
  if (!ok) bad += 1
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

/* ④ 反面控制 */
correctAsinField(store, { asin: ASIN, marketplace: MARKET, field: 'product_line_id', value: 'line-b' })
upsertAsin(store, { asin: ASIN, marketplace: MARKET, title: '改了标题', sourceId: 'browser-local' })
console.log('\n④ 反面控制      人工再改回 line-b，然后 upsert **不带** product_line_id → adopted =', JSON.stringify(adopted()))

/* ⑤ 页面 / 工具的 provenance 页签看到的就是这两行 */
console.log('\n⑤ `amzn_asin_detail` 的 sources 页签会印出（两份来源互相矛盾，且没人判过）：')
for (const row of sources()) console.log('   ', JSON.stringify(row))

store.close()
rmSync(dir, { recursive: true, force: true })
console.log('\n临时库已删除。')

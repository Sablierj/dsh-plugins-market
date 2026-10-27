/**
 * 生成「43 项必填属性 · 缺口清单」—— 只写**证据**，不写猜测值。
 *
 * 输出：amazon-ops/team/dev/attr-backlog-2026-10-26.md
 *
 * 规矩（写进文档里）：能从库里找到证据的列「线索」，找不到的写「本仓无证据」。
 * 属性是事实，猜一个写进去就是假数据 —— 这份清单只负责让人**一次看懂该补什么、值大概长什么样**。
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openStore } from '../src/store/db.js'
import { ATTRIBUTES, REQUIRED_ATTRIBUTES, labelForAttribute } from '../src/domain/rules/attributes.js'
import { attributeStatus } from '../src/domain/asin/attributes.js'

const LOGGER = { info() {}, warn() {}, error() {}, debug() {} }
const ASIN = 'B0GV55Q4JG'
const MARKET = 'US'
const REAL = 'data/amazon-ops.db'

const dir = mkdtempSync(join(tmpdir(), 'amzn-backlog-'))
const copy = join(dir, 'amazon-ops.db')
const source = new DatabaseSync(REAL, { readOnly: true })
source.exec("VACUUM INTO '" + copy.replace(/\\/g, '/') + "'")
source.close()

const store = openStore({ dataDir: dir, logger: LOGGER })
const status = attributeStatus(store, { asin: ASIN, marketplace: MARKET })
const listing = store.get('SELECT title, description, attributes_json FROM listing WHERE asin = ? AND marketplace = ?', [ASIN, MARKET])
const title = listing === null ? '' : String(listing.title ?? '')
const description = listing === null ? '' : String(listing.description ?? '')
const hay = (title + ' ' + description).toLowerCase()

/** 每个属性在文案/快照里可能留下的痕迹。命中就给线索，不命中就写「本仓无证据」。 */
const HINTS = {
  material: ['polyester', 'cotton', 'linen', 'velvet', 'leather', 'fabric', 'microfiber', 'foam'],
  material_composition: ['polyester', 'cotton', '%'],
  outer_material: ['cover', 'fabric', 'polyester', 'velvet'],
  inner_material: ['foam', 'filling', 'insert', 'sponge'],
  fill_material: ['foam', 'filling', 'insert'],
  color: ['beige', 'gray', 'grey', 'white', 'black', 'brown', 'blue', 'green', 'khaki', 'navy'],
  size: ['inch', 'in.', 'custom size', '48', '16', '18', 'thick'],
  product_dimensions: ['inch', 'x', 'thick', 'custom size'],
  item_weight: ['lb', 'pound', 'ounce', 'kg'],
  item_type: ['cushion', 'seat', 'pad'],
  intended_use: ['indoor', 'outdoor', 'patio', 'window', 'bench'],
  specific_uses: ['bench', 'window', 'seat', 'chair', 'rocker'],
  target_audience: ['adult', 'kid', 'pet', 'child'],
  country_of_origin: ['made in', 'china', 'usa', 'imported'],
  pattern: ['solid', 'floral', 'striped', 'plaid'],
  style: ['modern', 'rustic', 'classic', 'farmhouse'],
  theme: ['farmhouse', 'modern', 'nature'],
  shape: ['rectangular', 'square', 'round', 'u-shape'],
}

function hintsFor(id) {
  const words = HINTS[id]
  if (!Array.isArray(words)) return []
  return words.filter(word => hay.includes(word))
}

const lines = []
lines.push('# 43 项必填属性 · 缺口清单（' + ASIN + '@' + MARKET + '）')
lines.push('')
lines.push('> 生成方式：`VACUUM INTO` 真库副本 → `attributeStatus()` → 对每个缺项在标题/描述里找痕迹。')
lines.push('> **这份文档只写证据，不写猜测值。** 属性是事实：猜一个写进去，就是一条看起来像真的假数据。')
lines.push('')
lines.push('- 必填属性：' + status.coverage.filledCount + ' / ' + status.coverage.target)
lines.push('- 空值：' + status.coverage.empty.length + ' 项 · 占位值：' + status.coverage.placeholder.length + ' 项')
lines.push('- 标题：' + (title === '' ? '（空）' : title))
lines.push('')
lines.push('| # | 属性 id | 名称 | 线索（来自本库文案/快照） | 说明 |')
lines.push('| --- | --- | --- | --- | --- |')

status.missing.forEach((row, index) => {
  const hits = hintsFor(row.id)
  const evidence = hits.length === 0 ? '本仓无证据' : '命中：' + hits.join(' / ')
  const note = hits.length === 0
    ? '必须人工/后台给值'
    : '文案里出现过这些词，但**文案不是事实来源** —— 需人工确认后写入'
  lines.push('| ' + (index + 1) + ' | `' + row.id + '` | ' + (row.label ?? row.id) + ' | ' + evidence + ' | ' + note + ' |')
})

lines.push('')
lines.push('## 怎么补')
lines.push('')
lines.push('页面：优化 → 属性补齐（填 ASIN → 读取属性 → 逐项填 → 保存属性）')
lines.push('')
lines.push('命令行：')
lines.push('')
lines.push('```')
lines.push('amzn_asin_attribute_set { asin: "' + ASIN + '", marketplace: "US", values: { "country_of_origin": "China" } }')
lines.push('```')
lines.push('')
lines.push('拒绝规则（与工具同一实现）：未知属性 id、空值、占位值（N/A / 待定 / 无 / -）一律不写库。')

mkdirSync('team/dev', { recursive: true })
const out = 'team/dev/attr-backlog-2026-10-26.md'
writeFileSync(out, lines.join('\n') + '\n', 'utf8')
console.log('写出：' + out + '（' + lines.length + ' 行）')
console.log('缺口 ' + status.missing.length + ' 项 · 其中有文案线索的 ' + status.missing.filter(row => hintsFor(row.id).length > 0).length + ' 项')
store.close()
rmSync(dir, { recursive: true, force: true })

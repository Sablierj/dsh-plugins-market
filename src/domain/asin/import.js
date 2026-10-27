/**
 * Batch import for the ASIN library (module 05, F05-05).
 *
 * ## What "batch import" was missing
 *
 * `amzn_asin_upsert` could already write many records, so "import" was never about
 * the write. It was about everything before it: reading a table someone exported,
 * working out **which column is which field**, showing what the file would do
 * before it does it, saying which cells it is about to overwrite, and handing back
 * something that can undo it. That is the eight-step shape in the requirement, and
 * this module is steps ①–⑥ plus the rollback artifact; steps ⑦ and ⑧ are the
 * approval gate and the quality report, both in here too.
 *
 * ## Header-mapped, never position-mapped
 *
 * The precedent is the keyword importer (`src/tools/kw.js`): a file's column order
 * belongs to whoever exported it. Mapping by position means the day somebody
 * reorders columns in Excel, `price` lands in `bsr` and every row still succeeds —
 * the worst possible failure. So a column is identified by its **header text**,
 * through `ASIN_IMPORT_HEADER_ALIASES`, and a header nobody recognises is reported
 * rather than guessed at.
 *
 * ## An empty cell is silence, not a deletion
 *
 * `upsertAsin`'s update is `COALESCE(excluded.x, asin.x)` — omitting a field is
 * silence, not a clear. The export → edit → re-import loop is the most common way
 * this feature gets used, and an importer that treated an empty cell as "delete"
 * would blank every field the editor did not touch. So an empty cell is
 * `action: 'absent'` and is never written.
 *
 * ## Fail-closed by default, and loud about it
 *
 * `onDuplicate: 'reject'`, `onInvalid: 'reject'`, `dryRun: true` are the defaults.
 * "Later row wins" and "skip the bad rows" are both defensible — and both are
 * indistinguishable from the opposite choice in a preview table — so they have to
 * be asked for. A caller that wants them says so.
 *
 * ## No whole-file transaction, and the rollback says so
 *
 * Each row goes through `upsertAsin`, which is one transaction per row. Wrapping
 * 10 000 rows in one transaction means the last row's error throws all of them
 * away, which is the one outcome an operator cannot accept. So a partial failure
 * is a partial success, reported per line — and the undo is {@link buildRollbackCsv}:
 * the **before values of every cell this import would overwrite**, produced with the
 * preview and long before anyone presses apply. It is not a transaction, and it
 * cannot restore a cell that was empty before (there is no value to write back
 * through a `COALESCE`) — both stated in the result rather than implied.
 */

import { ASIN_LISTING_FIELDS } from './table.js'
import { isNumericFactField } from './fields.js'
import { fieldConflictsOf } from './conflicts.js'
import { getAsin, upsertAsin } from '../../store/queries.js'
import { assertAsinWritable } from '../../store/archive.js'
import { listFieldSources } from '../../store/field-source.js'
import { approvalRefusal } from '../approval/policy.js'

/** `asin` + the ten writable library fields, derived rather than retyped. */
export const ASIN_IMPORT_FIELDS = ['asin', ...ASIN_LISTING_FIELDS]

/** The three delimiters this importer recognises, in tie-break order. */
export const ASIN_IMPORT_DELIMITERS = [',', '\t', ';']

export const ASIN_IMPORT_DELIMITER_LABELS = {
  ',': 'CSV（逗号分隔）',
  '\t': 'TSV（制表符分隔）',
  ';': 'CSV（分号分隔）',
}

export const ASIN_IMPORT_INVALID_POLICIES = ['reject', 'skip']
export const ASIN_IMPORT_DUPLICATE_POLICIES = ['reject', 'last']

export const ASIN_IMPORT_APPROVAL_GATE = 'overwriteField'

/**
 * Header text → field id. Chinese and English, because a file exported from this
 * workbench and one typed by hand both arrive here.
 *
 * Normalisation (see `normalizeHeader`) strips case, whitespace, `_` and `-`, so
 * the keys below are written in their normalised form as well.
 */
const HEADER_ALIASES = {
  asin: ['asin', 'asin码', 'asin号', '产品asin', '亚马逊asin', '子asin', '父asin'],
  marketplace: ['marketplace', '站点', '市场', '国家站点', '站点代码'],
  title: ['title', '标题', '产品标题', 'listing标题', '商品标题'],
  brand: ['brand', '品牌', '品牌名'],
  price: ['price', '价格', '售价', '现价', '当前价格'],
  currency: ['currency', '币种', '货币', '货币单位'],
  bsr: ['bsr', 'bsr排名', '排名', '大类排名', '销售排名', '畅销排名'],
  category: ['category', '类目', '分类', '商品类目'],
  rating: ['rating', '评分', '星级', '平均评分'],
  reviews: ['reviews', '评论数', '评价数', '评论数量', '评价数量'],
  image_url: ['imageurl', '主图', '主图链接', '图片', '图片链接'],
  product_line_id: ['productlineid', '产品线', '产品线id', '产品线编号'],
}

/** `normalized header` → field id. Built once, so the two cannot drift. */
const BY_ALIAS = new Map(
  Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) => aliases.map(alias => [normalizeHeader(alias), field])),
)

/** The `asin` shape the store enforces. Kept identical to `upsertAsin`'s test. */
const ASIN_PATTERN = /^[A-Z0-9]{10}$/

/**
 * Header text as a lookup key: no BOM, no case, no whitespace, no `_` / `-`.
 *
 * A file that came out of Excel carries a BOM on the first cell and often a space
 * after a comma. Without this, the very first column of the most common file
 * fails to map and the import refuses with "no asin column".
 */
export function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/\uFEFF/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]/g, '')
}

/**
 * Which delimiter this text uses.
 *
 * Counted on the **header line only**: a description field containing a comma
 * would otherwise outvote the real delimiter in a TSV file. A tie goes to
 * `ASIN_IMPORT_DELIMITERS` order, so the answer is deterministic.
 */
export function detectAsinImportFormat(text) {
  const headerLine = String(text ?? '').split('\n')[0] ?? ''
  const counts = ASIN_IMPORT_DELIMITERS.map(delimiter => ({ delimiter, count: headerLine.split(delimiter).length - 1 }))
  const best = counts.reduce((top, entry) => (entry.count > top.count ? entry : top), counts[0])
  if (best.count === 0) {
    return {
      delimiter: null,
      label: null,
      reason: `表头行里没有可识别的分隔符（试过 ${ASIN_IMPORT_DELIMITERS.map(d => JSON.stringify(d)).join(' / ')}）`,
      counts,
    }
  }
  return {
    delimiter: best.delimiter,
    label: ASIN_IMPORT_DELIMITER_LABELS[best.delimiter] ?? best.delimiter,
    reason: `表头行里 ${JSON.stringify(best.delimiter)} 出现 ${best.count} 次（最多）`,
    counts,
  }
}

/**
 * Split delimited text into records, honouring RFC4180 quoting.
 *
 * A quoted cell may contain the delimiter and newlines, and `""` inside it is one
 * `"`. A `"` in the middle of an unquoted cell is a literal quote — only a quote
 * that starts a cell opens a quoted region, which is what spreadsheet exports do.
 *
 * `line` is the **record number** (1 = header), not the physical line: a quoted
 * newline makes the two differ, and a reader told "line 7" wants the record they
 * can find in the table, not the row of bytes.
 */
export function parseDelimited(text, delimiter) {
  const records = []
  let record = []
  let cell = ''
  let quoted = false
  let started = false

  const source = String(text ?? '')
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1 } else { quoted = false }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"' && cell.trim() === '') {
      quoted = true
      started = true
      cell = ''
      continue
    }
    if (char === delimiter) {
      record.push(cell)
      cell = ''
      started = true
      continue
    }
    if (char === '\n') {
      record.push(cell)
      cell = ''
      if (started || record.some(value => value.trim() !== '')) records.push(record)
      record = []
      started = false
      continue
    }
    if (char === '\r') continue
    cell += char
    started = true
  }
  record.push(cell)
  if (started || record.some(value => value.trim() !== '')) records.push(record)
  return records
}

/** The parsed file: the header row, the data records, and ragged-row complaints. */
export function parseAsinImport(text) {
  const format = detectAsinImportFormat(text)
  if (format.delimiter === null) return { format, headers: null, rows: [], errors: [] }

  const records = parseDelimited(text, format.delimiter)
  if (records.length === 0) return { format, headers: null, rows: [], errors: [] }

  const headers = records[0].map(cell => cell.trim())
  const errors = []
  const rows = []
  for (let index = 1; index < records.length; index += 1) {
    const cells = records[index]
    const line = index + 1
    /* A row with fewer cells than headers is read as "the trailing cells are
       empty" only when every missing cell really is absent from the text. Saying
       so explicitly is the difference between a truncated export and a person who
       left a column blank. */
    if (cells.length > headers.length && cells.slice(headers.length).some(value => value.trim() !== '')) {
      errors.push({ line, reason: `这一行有 ${cells.length} 格，表头只有 ${headers.length} 列`, cells })
      continue
    }
    rows.push({ line, cells })
  }
  return { format, headers, rows, errors }
}

/**
 * Header text → column index, per field.
 *
 * Three answers, and they are different: `mapping` (a field to a column),
 * `unmapped` (a column this importer does not know, or a second column claiming a
 * field already mapped), and `missingRequired` (`asin`). A duplicate column is
 * reported instead of silently overwriting the first: a file with both `价格` and
 * `price` has two answers to one question, and picking one without saying so hides
 * a real ambiguity in the file.
 */
export function mapAsinImportHeaders(headers) {
  const mapping = {}
  const unmapped = []
  const duplicates = []

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]
    const field = BY_ALIAS.get(normalizeHeader(header)) ?? null
    if (field === null) {
      if (String(header).trim() !== '') unmapped.push({ index, header, reason: 'unknown' })
      continue
    }
    if (Object.prototype.hasOwnProperty.call(mapping, field)) {
      duplicates.push({ index, header, field, firstIndex: mapping[field] })
      unmapped.push({ index, header, reason: 'duplicate' })
      continue
    }
    mapping[field] = index
  }

  const missingRequired = Object.prototype.hasOwnProperty.call(mapping, 'asin') ? [] : ['asin']
  return { mapping, unmapped, duplicates, missingRequired }
}

/**
 * The conflict check that step ⑤ needs — "same field, different values across
 * sources" — lives in `./conflicts.js`, not here: the health summary folds the same
 * judgement over the same rows, and two folds would drift away from
 * `DQ-CONSIST-001`.
 */

/** `1,299.99` → `1299.99`; anything that is not a number → `null`. */
function numericValue(raw) {
  const text = String(raw ?? '').replace(/,/g, '').trim()
  if (text === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** A cell as the store would see it: trimmed text, or a number for a numeric column. */
function cellValue(field, raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { empty: true, value: null, problem: null }
  if (isNumericFactField(field)) {
    const value = numericValue(text)
    if (value === null) {
      return {
        empty: false,
        value: null,
        problem: `${field} 是数值列，"${text}" 不是数字 —— SQLite 会把文本安静地存进 REAL 列，之后每个 sum/avg 都算错`,
      }
    }
    return { empty: false, value, problem: null }
  }
  return { empty: false, value: text, problem: null }
}

function sameLeaf(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined
  if (right === null || right === undefined) return false
  return String(left) === String(right)
}

/** CSV cell escaping, so a title with a comma survives the round trip. */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The rollback artifact: every cell this import would **overwrite**, with the value
 * it holds now.
 *
 * Only overwritten cells, because only they have something to restore. The header
 * is always `asin,marketplace` + the field ids that appear, so the file is itself a
 * valid import (header-mapped, like every other file this importer accepts) — which
 * is what makes "re-import the rollback file" a real instruction rather than a
 * figure of speech.
 */
export function buildRollbackCsv(plan) {
  const fields = []
  const lines = []
  for (const row of plan?.rows ?? []) {
    for (const cell of row.cells ?? []) {
      if (cell.action !== 'overwrite') continue
      if (!fields.includes(cell.field)) fields.push(cell.field)
      lines.push({ asin: row.asin, marketplace: row.marketplace, field: cell.field, before: cell.before })
    }
  }
  const header = ['asin', 'marketplace', ...fields]
  /* One row per (asin, marketplace): the same ASIN can be overwritten on many
     fields and a restore file that names it twice is a file with duplicates. */
  const keys = new Map()
  for (const entry of lines) {
    const key = `${entry.asin}@${entry.marketplace}`
    if (!keys.has(key)) keys.set(key, { asin: entry.asin, marketplace: entry.marketplace, cells: {} })
    keys.get(key).cells[entry.field] = entry.before
  }
  const rows = [...keys.values()].map(entry => header.map(name => {
    if (name === 'asin') return csvCell(entry.asin)
    if (name === 'marketplace') return csvCell(entry.marketplace)
    return csvCell(Object.prototype.hasOwnProperty.call(entry.cells, name) ? entry.cells[name] : null)
  }).join(','))
  return {
    csv: [header.join(','), ...rows].join('\n'),
    rows: rows.length,
    fields,
    /* Said out loud, because it is the half a reader would otherwise assume. */
    note: '只含**会被覆盖**的格子。原本为空、这次填上值的格子不在里面 —— upsertAsin 是 COALESCE，'
      + '写不回空；而且它逐行一个事务，不是整份事务。',
  }
}

/**
 * The overwrite gate, asked in **one** place for both callers.
 *
 * `buildAsinImportPlan` asks it to produce the preview-with-refusal in one answer, and
 * `applyAsinImport` asks it again because a plan can be built and applied in two
 * different calls — defence that would be worthless if the gate's id, its switch or
 * its sentence lived in two copies.
 *
 * `error` names the cells: it is what the model and the page read first. `reason`
 * stays the workspace's own sentence about this gate, because the page relays
 * **that** into the confirm dialog — replacing it with ours would make the dialog
 * describe a different switch than the one that fired.
 */
function overwriteRefusal(store, overwriteList, confirm) {
  if (overwriteList.length === 0) return null
  const detail = `这批导入会覆盖这些字段已有的非空值：${overwriteList.slice(0, 20).join('、')}`
    + `${overwriteList.length > 20 ? ` 等 ${overwriteList.length} 处` : ''}`
  const refusal = approvalRefusal(store, ASIN_IMPORT_APPROVAL_GATE, confirm,
    `${detail}。确认无误就再调一次并带 confirm: true。`)
  if (refusal === null) return null
  return { ...refusal, overwriteList, error: `${detail}。确认无误就再带 confirm: true。` }
}

/** The cells a writable row would overwrite, as `ASIN/SITE 的 field` strings. */
function overwriteCellsOf(rows) {
  return rows
    .filter(row => row.action === 'create' || row.action === 'update')
    .flatMap(row => row.cells.filter(cell => cell.action === 'overwrite')
      .map(cell => `${row.asin}/${row.marketplace} 的 ${cell.field}`))
}

/**
 * Build the plan: everything the file would do, and nothing written yet.
 *
 * `ok: false` is returned in two different shapes, and the difference matters:
 *
 *   · a **fatal** input problem (no delimiter, no header, no `asin` column) has no
 *     rows to show at all;
 *   · a **refusal** (`DUPLICATE_ROWS` / `INVALID_ROWS` under the default policies,
 *     or `APPROVAL_REQUIRED`) carries the **whole plan** alongside the refusal, so
 *     the page can draw the preview and the reason side by side. Making the
 *     operator re-submit the file to see which lines are wrong would be a second
 *     round trip for information this call already has.
 */
export function buildAsinImportPlan(store, {
  text,
  marketplace = 'US',
  sourceId = null,
  onInvalid = 'reject',
  onDuplicate = 'reject',
  confirm = false,
} = {}) {
  const body = String(text ?? '')
  if (body.trim() === '') {
    return { ok: false, code: 'EMPTY_INPUT', error: '导入内容为空 —— 粘一段带表头的 CSV/TSV 文本' }
  }

  const parsed = parseAsinImport(body)
  if (parsed.format.delimiter === null) {
    return { ok: false, code: 'NO_DELIMITER', error: parsed.format.reason, hint: '第一行必须是表头，列之间用逗号、制表符或分号' }
  }
  if (parsed.headers === null || parsed.headers.length === 0) {
    return { ok: false, code: 'MISSING_HEADER', error: '读不到表头行 —— 表头是字段映射的唯一依据' }
  }

  const mapped = mapAsinImportHeaders(parsed.headers)
  if (mapped.missingRequired.length > 0) {
    return {
      ok: false,
      code: 'MISSING_ASIN_COLUMN',
      error: `表头里没有能映射到 asin 的列（读过: ${parsed.headers.join(' | ')}）`,
      hint: `认得的别名: ${HEADER_ALIASES.asin.join(' / ')}`,
    }
  }

  const defaultMarketplace = String(marketplace ?? 'US').trim().toUpperCase() || 'US'
  const invalidPolicy = ASIN_IMPORT_INVALID_POLICIES.includes(String(onInvalid)) ? String(onInvalid) : 'reject'
  const duplicatePolicy = ASIN_IMPORT_DUPLICATE_POLICIES.includes(String(onDuplicate)) ? String(onDuplicate) : 'reject'

  let unknownSource = null
  const wantedSource = sourceId === null || sourceId === undefined || String(sourceId).trim() === ''
    ? null
    : String(sourceId).trim()
  if (wantedSource !== null) {
    const known = store.get('SELECT id FROM source WHERE id = ?', [wantedSource])
    if (known === undefined) {
      const ids = store.all('SELECT id FROM source ORDER BY id').map(row => row.id)
      unknownSource = {
        ok: false,
        code: 'UNKNOWN_SOURCE',
        error: `没有叫 "${wantedSource}" 的来源`,
        hint: ids.length === 0 ? '库里一个来源都没有，先用 amzn_source_upsert 建一个' : `已知来源: ${ids.join(', ')}`,
      }
    }
  }
  if (unknownSource !== null) return unknownSource

  const dataFields = ASIN_IMPORT_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(mapped.mapping, field))
  const sourceCache = new Map()
  const sourcesFor = (asin, market) => {
    const key = `${asin}@${market}`
    if (!sourceCache.has(key)) sourceCache.set(key, listFieldSources(store, { asin, marketplace: market }))
    return sourceCache.get(key)
  }

  const rows = []
  for (const record of parsed.rows) {
    const at = index => record.cells[index] ?? ''
    const rawAsin = String(at(mapped.mapping.asin)).trim().toUpperCase()
    const market = Object.prototype.hasOwnProperty.call(mapped.mapping, 'marketplace')
      ? (String(at(mapped.mapping.marketplace)).trim().toUpperCase() || defaultMarketplace)
      : defaultMarketplace

    const problems = []
    let invalidReason = null
    if (!ASIN_PATTERN.test(rawAsin)) {
      invalidReason = `ASIN "${String(at(mapped.mapping.asin)).trim()}" 不是 10 位字母/数字`
      problems.push({ code: 'INVALID_ASIN', field: 'asin', message: invalidReason })
    }

    const existing = invalidReason === null ? getAsin(store, rawAsin, market) : undefined
    const conflicts = invalidReason === null
      ? fieldConflictsOf(sourcesFor(rawAsin, market))
      : new Map()

    const cells = []
    for (const field of dataFields) {
      if (field === 'asin' || field === 'marketplace') continue
      const parsedCell = cellValue(field, at(mapped.mapping[field]))
      const before = existing === undefined || existing === null ? null : (existing.row[field] ?? null)
      if (parsedCell.problem !== null) {
        problems.push({ code: 'FIELD_NOT_NUMERIC', field, message: parsedCell.problem })
        if (invalidReason === null) invalidReason = parsedCell.problem
      }
      let action = 'absent'
      if (!parsedCell.empty && parsedCell.problem === null && invalidReason === null) {
        if (before === null || before === undefined) action = 'fill'
        else if (sameLeaf(before, parsedCell.value)) action = 'same'
        else action = 'overwrite'
      }
      cells.push({
        field,
        before,
        after: parsedCell.empty || parsedCell.problem !== null ? null : parsedCell.value,
        action,
        /* Reported beside the cell so the preview can mark it, rather than making
           the reader join the conflicts table to the preview by eye. */
        conflicts: conflicts.get(field) ?? null,
      })
    }

    if (invalidReason !== null) {
      rows.push({ line: record.line, asin: rawAsin, marketplace: market, action: 'invalid', invalidReason, cells, conflicts: [], problems })
      continue
    }

    const written = cells.filter(cell => cell.action !== 'absent')
    let action = 'create'
    if (existing !== undefined && existing !== null) {
      action = written.every(cell => cell.action === 'same') ? 'unchanged' : 'update'
    }
    rows.push({ line: record.line, asin: rawAsin, marketplace: market, action, invalidReason: null, cells, conflicts: [], problems })
  }

  /* Duplicate lines, decided in one pass over the whole file — a duplicate cannot
     be seen one row at a time, which is why it is a second pass and not a flag in
     the loop above. */
  const seen = new Map()
  for (const row of rows) {
    if (row.action === 'invalid') continue
    const key = `${row.asin}@${row.marketplace}`
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push(row)
  }
  const duplicateLines = []
  for (const group of seen.values()) {
    if (group.length < 2) continue
    duplicateLines.push(...group.map(row => row.line))
    if (duplicatePolicy === 'reject') {
      for (const row of group) row.action = 'duplicate'
    } else {
      for (const row of group.slice(0, -1)) row.action = 'superseded'
    }
  }

  const summary = {
    lines: rows.length,
    rows: rows.length,
    create: rows.filter(row => row.action === 'create').length,
    update: rows.filter(row => row.action === 'update').length,
    unchanged: rows.filter(row => row.action === 'unchanged').length,
    invalid: rows.filter(row => row.action === 'invalid').length,
    duplicate: rows.filter(row => row.action === 'duplicate').length,
    superseded: rows.filter(row => row.action === 'superseded').length,
    filledCells: rows.flatMap(row => row.cells).filter(cell => cell.action === 'fill').length,
    overwrittenCells: rows.flatMap(row => row.cells).filter(cell => cell.action === 'overwrite').length,
    conflictCells: rows.flatMap(row => row.cells).filter(cell => cell.conflicts !== null).length,
  }
  summary.writeCount = summary.create + summary.update

  const invalidRows = rows.filter(row => row.action === 'invalid')
  const duplicateRows = rows.filter(row => row.action === 'duplicate')

  const warnings = []
  if (mapped.unmapped.length > 0) {
    warnings.push({
      code: 'UNMAPPED_COLUMNS',
      message: `认不出的列没有导入: ${mapped.unmapped.map(entry => `${entry.header}（第 ${entry.index + 1} 列，${entry.reason === 'duplicate' ? '与前面某一列指向同一个字段' : '不认识'}）`).join('、')}`,
    })
  }
  const absentCells = rows.flatMap(row => row.cells).filter(cell => cell.action === 'absent').length
  if (absentCells > 0) {
    warnings.push({
      code: 'EMPTY_CELLS_NOT_WRITTEN',
      message: `有 ${absentCells} 个空格子不会被写入 —— 空格是「没说」，不是「删掉」（upsertAsin 是 COALESCE）。`,
    })
  }
  if (parsed.errors.length > 0) {
    warnings.push({ code: 'RAGGED_ROWS', message: `有 ${parsed.errors.length} 行的列数与表头不符，已跳过：${parsed.errors.map(entry => `第 ${entry.line} 行（${entry.reason}）`).join('、')}` })
  }
  if (wantedSource === null) {
    warnings.push({ code: 'NO_SOURCE_ID', message: '没有给 sourceId —— 这些字段写进去后没有来源标记，溯源会少一环。' })
  }
  if (summary.overwrittenCells > 0) {
    warnings.push({ code: 'OVERWRITES_EXIST', message: `有 ${summary.overwrittenCells} 个格子会覆盖已有非空值，回滚件在 rollback.csv 里。` })
  }
  if (summary.conflictCells > 0) {
    warnings.push({ code: 'SOURCE_CONFLICTS', message: `有 ${summary.conflictCells} 个格子所在的字段本来就有多源不同值（DQ-CONSIST-001 口径），导入不会替你裁决。` })
  }
  if (duplicatePolicy === 'last' && summary.superseded > 0) {
    warnings.push({ code: 'DUPLICATES_LAST_WINS', message: `文件里有重复行，按 onDuplicate='last' 只写每个 (ASIN, 站点) 的最后一行，被顶掉的有 ${summary.superseded} 行。` })
  }

  const blocking = []
  if (duplicateRows.length > 0) {
    blocking.push({
      code: 'DUPLICATE_ROWS',
      message: `文件里同一 (ASIN, 站点) 出现多次（行 ${duplicateLines.join('、')}）—— 前者胜还是后者胜在预览里长得一样，所以要明说。`,
    })
  }
  if (invalidRows.length > 0) {
    blocking.push({
      code: 'INVALID_ROWS',
      message: `有 ${invalidRows.length} 行不合法：${invalidRows.map(row => `第 ${row.line} 行（${row.invalidReason}）`).join('、')}`,
    })
  }

  const plan = {
    ok: true,
    format: { delimiter: parsed.format.delimiter, label: parsed.format.label, reason: parsed.format.reason },
    headers: parsed.headers,
    mapping: mapped.mapping,
    unmapped: mapped.unmapped,
    duplicates: mapped.duplicates,
    missingRequired: mapped.missingRequired,
    fields: dataFields,
    rows,
    summary,
    parsedErrors: parsed.errors,
    qualityReport: { ok: blocking.length === 0, blocking, warnings },
    rollback: buildRollbackCsv({ rows }),
    sourceId: wantedSource,
    marketplace: defaultMarketplace,
    invalidPolicy,
    duplicatePolicy,
  }

  if (invalidPolicy === 'reject' && invalidRows.length > 0) {
    return { ...plan, ok: false, code: 'INVALID_ROWS', error: blocking.find(entry => entry.code === 'INVALID_ROWS').message, hint: "要跳过不合法行、只导合法的那些，显式传 onInvalid: 'skip'" }
  }
  if (duplicatePolicy === 'reject' && duplicateRows.length > 0) {
    return { ...plan, ok: false, code: 'DUPLICATE_ROWS', error: blocking.find(entry => entry.code === 'DUPLICATE_ROWS').message, hint: "要让每个 (ASIN, 站点) 的最后一行胜出，显式传 onDuplicate: 'last'" }
  }

  /* The approval gate is asked **here**, at the point the plan is known, so the
     preview and the refusal arrive in one answer. `approvalRefusal` is the same
     function `amzn_asin_upsert` and the archive paths call, with the same gate id
     — "覆盖字段" is one switch for the user, so it is one gate for the code. */
  const refusal = overwriteRefusal(store, overwriteCellsOf(rows), confirm)
  if (refusal !== null) {
    /* The whole plan rides along: the page draws the preview and the refusal
       together, so the operator does not have to submit the file again to find out
       which cells the question is about. */
    return { ...plan, ...refusal }
  }

  return plan
}

/**
 * Apply a plan. Writes row by row through `upsertAsin`, then **reads every written
 * row back** and compares it to what the plan promised.
 *
 * The read-back is not ceremony. `upsertAsin` coalesces, coerces and validates; the
 * plan is a prediction about all three. A prediction nothing checks is exactly the
 * shape this repository keeps paying for — a writer that self-reports while a
 * reader computes its own answer. Here the two are compared inside one call and a
 * mismatch is a failure, not a log line.
 *
 * Returns `ok:false` for a refused plan and for a mismatched read-back. The second
 * one has already written, and says so: `written` is filled even when `ok` is
 * false, because pretending nothing happened would be a worse lie than a partial
 * success.
 */
export function applyAsinImport(store, plan, { confirm = false } = {}) {
  if (plan === null || plan === undefined || plan.ok !== true) {
    return {
      ok: false,
      code: plan?.code ?? 'PLAN_NOT_APPLICABLE',
      error: plan?.error ?? '这份导入计划不可执行 —— 先用 dryRun 拿到一份 ok:true 的计划',
    }
  }

  const overwriteList = overwriteCellsOf(plan.rows)
  const gateRefusal = overwriteRefusal(store, overwriteList, confirm)
  if (gateRefusal !== null) return gateRefusal

  const created = []
  const updated = []
  const unchanged = []
  const skipped = []
  const failed = []
  const mismatches = []

  for (const row of plan.rows) {
    if (row.action === 'invalid' || row.action === 'duplicate' || row.action === 'superseded') {
      skipped.push({ line: row.line, asin: row.asin, reason: row.action === 'invalid' ? row.invalidReason : `文件内重复行（${row.action}）` })
      continue
    }
    if (row.action === 'unchanged') { unchanged.push(`${row.asin}/${row.marketplace}`); continue }

    const record = { asin: row.asin, marketplace: row.marketplace, sourceId: plan.sourceId ?? undefined }
    const promised = []
    for (const cell of row.cells) {
      if (cell.action === 'absent') continue
      record[cell.field] = cell.after
      promised.push(cell)
    }

    try {
      /* 归档即只读（B-05e / F05-08）。闸门放在**这一行自己的 try 里**，所以一条已归档的
         记录是一次**逐行失败**，不是整份文件失败 —— 与这个导入器「逐行一个事务，
         失败的行不影响已成功的行」的既有语义一致（见下面的 note）。
         `mustExist: false`：这个导入器**能新建**。一条不在库里的坐标是正常的新建，
         不是错误；只有「坐标存在且已归档」才拒绝。
         `upsertAsin` 本身不加闸门：它是八十几条路径与后台采集 worker 共用的写口，
         在那里拦会让 worker 自己在归档的 ASIN 上失败。范围写清在契约 §5 非目标里。 */
      assertAsinWritable(store, {
        asin: row.asin, marketplace: row.marketplace, action: '批量导入', mustExist: false,
      })
      const result = upsertAsin(store, record)
      ;(result.created ? created : updated).push(`${result.asin}/${result.marketplace}`)
      const readBack = getAsin(store, row.asin, row.marketplace)
      for (const cell of promised) {
        const actual = readBack?.row?.[cell.field] ?? null
        if (!sameLeaf(actual, cell.after)) {
          mismatches.push({
            line: row.line,
            asin: row.asin,
            marketplace: row.marketplace,
            field: cell.field,
            promised: cell.after,
            actual,
          })
        }
      }
    } catch (error) {
      failed.push({ line: row.line, asin: row.asin, reason: error.message })
    }
  }

  const summary = {
    created: created.length,
    updated: updated.length,
    unchanged: unchanged.length,
    skipped: skipped.length,
    failed: failed.length,
    mismatchedCells: mismatches.length,
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      code: 'ASIN_IMPORT_READBACK_MISMATCH',
      error: `写完之后读回对账不一致（${mismatches.length} 格）—— 写入已经发生，下面是实际读到的值`,
      mismatches,
      created,
      updated,
      unchanged: unchanged.length,
      skipped,
      failed,
      summary,
    }
  }

  return {
    ok: true,
    created,
    updated,
    unchanged,
    skipped,
    failed,
    summary,
    readBackVerified: true,
    rollback: plan.rollback,
    note: '逐行一个事务，不是整份事务：失败的行不影响已成功的行。回滚用 plan.rollback.csv 再导一次。',
  }
}

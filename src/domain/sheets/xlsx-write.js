/**
 * A minimal XLSX **writer**, on `node:zlib` alone.
 *
 * This is the counterpart of `src/domain/keywords/xlsx.js` (the reader). They are
 * two files rather than one because they serve two different callers and two
 * different directions: the reader parses other people's workbooks in the import
 * pipelines, and the writer produces an export artifact nobody feeds back in.
 * They share the format's namespace constants only; the reading strategy (cells
 * placed by their `r` reference, sparse rows) has no counterpart here.
 *
 * ## Why hand-rolled
 *
 * Same reason as the reader: this plugin installs by copying a directory, has no
 * build step and no dependencies (`node:sqlite` is the only non-trivial built-in
 * it leans on). A spreadsheet library would break that property for every user
 * just to emit six sheets of text.
 *
 * ## What it emits, and what it refuses
 *
 * Emits what an export needs and nothing more: one workbook, N worksheets, one
 * bold frozen header row per sheet, inline strings, numbers and booleans. Not
 * emitted on purpose: shared strings (a second indirection for no gain at this
 * size), formulas, number formats, merged cells, images.
 *
 * Refuses **loudly** what it cannot represent — a sheet name over 31 characters
 * or carrying one of the seven characters Excel forbids, a duplicate sheet name,
 * a cell string past Excel's 32 767-character limit, a sheet past the row/column
 * limits, and a value type it has no cell for. The failure mode this exists to
 * prevent is the silent one: a cell that quietly lands blank in a report somebody
 * then reads as "there was no data". (`readWorkbook` in the reader refuses the
 * mirror image of this on the way in.)
 *
 * ## Determinism
 *
 * The zip timestamp is the DOS epoch, not `Date.now()`, so the same rows produce
 * byte-identical files. That is what lets a test assert the *stored* artifact
 * equals a fresh rendering of the same model instead of asserting "some bytes".
 */

import { deflateRawSync, crc32 } from 'node:zlib'

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/**
 * Excel's own limits, named rather than sprinkled.
 *
 * **Not exported on purpose**: the four numbers reach a reader only as a refusal
 * message, so the assertion that pins them is an assertion about the thrown text
 * (`tests/f14-10-report-export.mjs`). An exported constant here would let a test
 * compare the constant with itself and call that evidence — the same reason
 * `domain/reports/gaps.js` keeps its four kinds private.
 */
const SHEET_LIMITS = {
  nameMax: 31,
  /** The characters Excel rejects inside a sheet name. */
  nameForbidden: ['[', ']', ':', '*', '?', '/', '\\'],
  cellCharsMax: 32_767,
  rowsMax: 1_048_576,
  columnsMax: 16_384,
}

/* ─────────────────────────────── xml ─────────────────────────────── */

/**
 * Escape text for XML content.
 *
 * Control characters below 0x20 (except tab, LF, CR) are **stripped**: XML 1.0
 * does not allow them at all, so a string carrying one — a pasted field with a
 * stray 0x1b, say — would make the workbook unopenable rather than merely ugly.
 * Dropping them is the only option that keeps the rest of the cell readable, and
 * the alternative (throwing) would fail an export over a character nobody can
 * see. `]]>` is escaped because it would close a CDATA-ish sequence; we do not
 * use CDATA, but a `<` or `&` in a cell is the ordinary case.
 */
function xmlText(value) {
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** `0` → `A`, `25` → `Z`, `26` → `AA`. Internal: the caller writes rows, not refs. */
function columnName(index) {
  let n = Number(index)
  if (!Number.isInteger(n) || n < 0) throw new Error(`xlsx: bad column index ${JSON.stringify(index)}`)
  let name = ''
  n += 1
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/* ─────────────────────────────── zip ─────────────────────────────── */

/** DOS date/time for 1980-01-01 00:00 — the zip epoch, and the reason output is reproducible. */
const DOS_DATE = (1 << 5) | 1
const DOS_TIME = 0

/**
 * Wrap `{name, data}` entries into a zip archive.
 *
 * Method 8 (deflate) when it actually helps, method 0 (stored) otherwise — a
 * already-compressed or tiny part is bigger deflated, and the central directory
 * records which was used per entry. No zip64: this writer's inputs are bounded by
 * Excel's own limits, and the reader next door refuses zip64 for the same reason.
 */
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const deflated = deflateRawSync(raw)
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const checksum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...centrals, end])
}

/* ────────────────────────────── sheets ───────────────────────────── */

function checkSheetName(name, index, seen) {
  const text = String(name ?? '')
  if (text === '') throw new Error(`xlsx: sheet ${index + 1} has no name`)
  if ([...text].length > SHEET_LIMITS.nameMax) {
    throw new Error(`xlsx: sheet name "${text}" is ${[...text].length} characters — Excel allows ${SHEET_LIMITS.nameMax}`)
  }
  for (const character of SHEET_LIMITS.nameForbidden) {
    if (text.includes(character)) {
      throw new Error(`xlsx: sheet name "${text}" contains the character ${JSON.stringify(character)}, which Excel forbids in a sheet name`)
    }
  }
  if (text.startsWith("'") || text.endsWith("'")) {
    throw new Error(`xlsx: sheet name "${text}" starts or ends with an apostrophe, which Excel forbids`)
  }
  /* Excel compares sheet names case-insensitively: "Sheet1" and "sheet1" in one
     workbook makes the second one unopenable, so the rule is applied here. */
  const key = text.toLowerCase()
  if (seen.has(key)) throw new Error(`xlsx: duplicate sheet name "${text}" (Excel compares them case-insensitively)`)
  seen.add(key)
}

/** One cell. Returns `''` for a value that is deliberately blank. */
function cellXml(ref, value, styleIndex) {
  const style = styleIndex === undefined ? '' : ` s="${styleIndex}"`
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`xlsx: cell ${ref} holds a non-finite number (${value}) — Excel has no cell for it`)
    }
    return `<c r="${ref}"${style}><v>${value}</v></c>`
  }
  if (typeof value === 'boolean') return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`
  const text = String(value)
  if (text === '') return ''
  if ([...text].length > SHEET_LIMITS.cellCharsMax) {
    throw new Error(`xlsx: cell ${ref} holds ${[...text].length} characters — Excel allows ${SHEET_LIMITS.cellCharsMax} per cell`)
  }
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`
}

function sheetXml(sheet) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : []
  if (rows.length > SHEET_LIMITS.rowsMax) {
    throw new Error(`xlsx: sheet "${sheet.name}" has ${rows.length} rows — Excel allows ${SHEET_LIMITS.rowsMax}`)
  }
  const parts = []
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
  parts.push(`<worksheet xmlns="${SHEET_NS}">`)
  parts.push('<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '</sheetView></sheetViews>')
  const widths = Array.isArray(sheet.widths) ? sheet.widths : []
  if (widths.length > 0) {
    parts.push('<cols>')
    widths.forEach((width, index) => {
      if (width === null || width === undefined || !Number.isFinite(Number(width))) return
      const span = index + 1
      parts.push(`<col min="${span}" max="${span}" width="${Math.max(1, Math.round(Number(width)))}" customWidth="1"/>`)
    })
    parts.push('</cols>')
  }
  parts.push('<sheetData>')
  rows.forEach((row, rowIndex) => {
    const values = Array.isArray(row) ? row : [row]
    if (values.length > SHEET_LIMITS.columnsMax) {
      throw new Error(`xlsx: sheet "${sheet.name}" row ${rowIndex + 1} has ${values.length} cells — Excel allows ${SHEET_LIMITS.columnsMax}`)
    }
    const cells = []
    values.forEach((value, columnIndex) => {
      if (value === null || value === undefined) return
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`
      /* Row 1 is the header in every sheet this writer is used for: bold, frozen.
         A report whose header row scrolls away is a report whose columns lose
         their names two screens down. */
      const xml = cellXml(ref, value, rowIndex === 0 ? 1 : 0)
      if (xml !== '') cells.push(xml)
    })
    if (cells.length === 0) return
    parts.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`)
  })
  parts.push('</sheetData></worksheet>')
  return parts.join('')
}

const CONTENT_TYPES = (sheetCount) => [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
  ...Array.from({ length: sheetCount }, (_unused, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
  '</Types>',
].join('')

const ROOT_RELS = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  `<Relationships xmlns="${PKG_REL_NS}">`,
  `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>`,
  '</Relationships>',
].join('')

const WORKBOOK = (names) => [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>`,
  ...names.map((name, index) => `<sheet name="${xmlText(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`),
  '</sheets></workbook>',
].join('')

const WORKBOOK_RELS = (sheetCount) => [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  `<Relationships xmlns="${PKG_REL_NS}">`,
  ...Array.from({ length: sheetCount }, (_unused, index) => `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`),
  `<Relationship Id="rId${sheetCount + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`,
  '</Relationships>',
].join('')

/* Two fonts and two cell formats: plain and bold. The bold one is the header row. */
const STYLES = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  `<styleSheet xmlns="${SHEET_NS}">`,
  '<fonts count="2">',
  '<font><sz val="11"/><name val="Calibri"/></font>',
  '<font><b/><sz val="11"/><name val="Calibri"/></font>',
  '</fonts>',
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
  '<borders count="1"><border/></borders>',
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
  '<cellXfs count="2">',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  '</cellXfs>',
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
  '</styleSheet>',
].join('')

/**
 * Build a whole workbook from `[{ name, rows, widths? }]` and return its bytes.
 *
 * `rows` is positional: `[[header…], [value…], …]`. A `null` cell is blank at that
 * position — it does **not** shift the following cells, because every cell is
 * written with its explicit `A1` reference (the reader next door reads by
 * reference for the same reason, in the opposite direction).
 */
export function writeXlsx(sheets) {
  const list = Array.isArray(sheets) ? sheets : []
  if (list.length === 0) throw new Error('xlsx: a workbook needs at least one sheet')
  const seen = new Set()
  list.forEach((sheet, index) => checkSheetName(sheet?.name, index, seen))

  const entries = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES(list.length) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: WORKBOOK(list.map(sheet => String(sheet.name))) },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS(list.length) },
    { name: 'xl/styles.xml', data: STYLES },
    ...list.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheetXml(sheet) })),
  ]
  return new Uint8Array(zip(entries))
}

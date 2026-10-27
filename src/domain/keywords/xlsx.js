/**
 * A minimal XLSX reader, on `node:zlib` alone.
 *
 * Why hand-rolled rather than a library: this plugin installs by copying a
 * directory and has no build step and no dependencies (`node:sqlite`, the CDP
 * client and the page are all built-ins). Pulling in SheetJS for four import
 * pipelines would break that property for every user of the plugin.
 *
 * What it supports is what Amazon's own exports and the three third-party
 * exports actually contain: shared strings, inline strings, numbers, booleans,
 * errors, and sparse rows. What it does not support — zip64, encrypted
 * workbooks, cell styles — is refused loudly rather than silently mis-read.
 *
 * The one design decision worth spelling out is that **cells are placed by
 * their `r` reference, not by their order in the row**. That is not a detail:
 * `02_import_competitor.py` in the hub carries a long comment about 卖家精灵
 * exports having "列错位" (column drift), and reads by reference to work around
 * it. Reading positionally turns a single empty cell into a one-column shift
 * for the rest of the row, and the symptom is a plausible-looking number in the
 * wrong column — the failure mode that never announces itself.
 */

import { inflateRawSync } from 'node:zlib'

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** Refuse anything that would need a feature we do not implement. */
export class XlsxError extends Error {}

/* ─────────────────────────────── zip ─────────────────────────────── */

/**
 * Read the central directory and inflate every entry.
 *
 * The central directory is authoritative: a streaming writer may leave a
 * local header with zeroed sizes and put the real ones in a trailing data
 * descriptor (general-purpose bit 3), so trusting the local header would read
 * zero bytes for every entry.
 */
export function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)

  let eocd = -1
  const lowest = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new XlsxError('not a zip archive (no end-of-central-directory record)')

  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new XlsxError('zip64 archives are not supported by this reader')
  }

  const entries = new Map()
  let p = cdOffset
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length) throw new XlsxError('truncated central directory')
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError(`bad central directory entry at ${p}`)

    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    if ((flags & 0x0001) === 0x0001) throw new XlsxError(`"${name}" is encrypted`)

    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(start, start + compSize)

    if (method === 0) entries.set(name, Buffer.from(raw))
    else if (method === 8) entries.set(name, inflateRawSync(raw))
    else throw new XlsxError(`"${name}" uses unsupported compression method ${method}`)

    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/* ─────────────────────────────── xml ─────────────────────────────── */

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

export function decodeXmlEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return codePoint(Number.parseInt(body.slice(2), 16), whole)
    if (body.startsWith('#')) return codePoint(Number.parseInt(body.slice(1), 10), whole)
    return ENTITIES[body] ?? whole
  })
}

function codePoint(code, fallback) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

/** `<t>` runs inside one `<si>`/`<is>`, joined. Rich text splits a string. */
function collectText(xml) {
  let out = ''
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
  let m
  while ((m = re.exec(xml)) !== null) out += decodeXmlEntities(m[1])
  return out
}

/** `K12` → 10 (zero-based). `AA1` → 26. */
export function columnIndex(ref) {
  const m = /^([A-Za-z]+)/.exec(String(ref ?? ''))
  if (m === null) return null
  let index = 0
  for (const ch of m[1].toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64)
  return index - 1
}

function sharedStrings(entries) {
  const xml = entries.get('xl/sharedStrings.xml')
  if (xml === undefined) return []
  const text = xml.toString('utf8')
  const out = []
  // Non-greedy over <si>…</si>. A `<si>` never nests another `<si>`.
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g
  let m
  while ((m = re.exec(text)) !== null) out.push(collectText(m[1]))
  return out
}

/**
 * Sheet name → worksheet part.
 *
 * Needed rather than assuming `sheet1.xml`: 卖家精灵 exports carry a
 * `Unique Words` and a `Note` sheet alongside the data, and 西柚's second sheet
 * is a disclaimer. Picking by name is the difference between importing the
 * export and importing its footnote.
 */
function sheetParts(entries) {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''

  const targets = new Map()
  const relRe = /<Relationship\b[^>]*>/g
  let rm
  while ((rm = relRe.exec(rels)) !== null) {
    const id = /\bId="([^"]+)"/.exec(rm[0])?.[1]
    const target = /\bTarget="([^"]+)"/.exec(rm[0])?.[1]
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''))
  }

  const parts = []
  const sheetRe = /<sheet\b[^>]*>/g
  let sm
  while ((sm = sheetRe.exec(workbook)) !== null) {
    const name = /\bname="([^"]*)"/.exec(sm[0])?.[1]
    const rid = new RegExp(`r:id="([^"]+)"`).exec(sm[0])?.[1]
    const target = rid ? targets.get(rid) : undefined
    if (name === undefined) continue
    parts.push({ name: decodeXmlEntities(name), part: target ? `xl/${target}` : null })
  }

  // A workbook with no rels (rare, but legal) still has the parts in order.
  if (parts.every(entry => entry.part === null)) {
    const loose = [...entries.keys()]
      .filter(key => /^xl\/worksheets\/sheet\d+\.xml$/.test(key))
      .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]))
    parts.forEach((entry, index) => { entry.part = loose[index] ?? null })
  }
  return parts
}

/** One `<row>` → a dense array indexed by column reference. */
function readRow(rowXml, shared) {
  const cells = []
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
  let cm
  while ((cm = cellRe.exec(rowXml)) !== null) {
    const attrs = cm[1] ?? ''
    const body = cm[2] ?? ''
    const ref = /\br="([A-Za-z]+\d+)"/.exec(attrs)?.[1]
    const index = ref === undefined ? cells.length : columnIndex(ref)
    if (index === null) continue

    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n'
    let value = null

    if (type === 'inlineStr') {
      value = collectText(body)
    } else {
      const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1]
      if (raw !== undefined) {
        const decoded = decodeXmlEntities(raw)
        if (type === 's') value = shared[Number(decoded)] ?? null
        else if (type === 'b') value = decoded === '1'
        else if (type === 'e') value = decoded
        else if (type === 'str') value = decoded
        else value = coerceNumber(decoded)
      }
    }
    cells[index] = value
  }
  return cells
}

/** `"0.0639"` → `0.0639`, but `"B0DS49VC81"` and `"036"` stay strings. */
function coerceNumber(text) {
  if (text === '') return ''
  const n = Number(text)
  if (!Number.isFinite(n)) return text
  // A leading zero or a leading `+` is a string in the source, not a number:
  // ASINs and zero-padded ids must not come back as 36 or 12.
  if (/^[+-]?0\d/.test(text) || /^[+-]?\./.test(text)) return text
  return n
}

/**
 * Parse a workbook into `{ sheets: [{ name, rows }], shared }`.
 *
 * Rows are returned with their own length; a caller that needs a rectangle pads
 * with `cell(row, i)`. Trailing fully-empty rows are dropped, because Excel
 * writes a great many of them and a row count is used as a sanity check.
 */
export function readWorkbook(buffer, { sheets: wanted } = {}) {
  const entries = readZipEntries(buffer)
  const shared = sharedStrings(entries)
  const parts = sheetParts(entries)

  const sheets = []
  for (const { name, part } of parts) {
    if (wanted !== undefined && !wanted.includes(name)) continue
    if (part === null) continue
    const xml = entries.get(part)
    if (xml === undefined) continue

    const text = xml.toString('utf8')
    const rows = []
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
    let rm
    while ((rm = rowRe.exec(text)) !== null) rows.push(readRow(rm[2] ?? '', shared))

    while (rows.length > 0 && rows[rows.length - 1].every(cell => cell === undefined || cell === null || cell === '')) {
      rows.pop()
    }
    sheets.push({ name, rows })
  }

  if (sheets.length === 0) throw new XlsxError('the workbook has no readable worksheet')
  return { sheets, shared }
}

/** The first sheet, which is the data sheet in every export we import. */
export function readFirstSheet(buffer) {
  const { sheets } = readWorkbook(buffer)
  return { name: sheets[0].name, rows: sheets[0].rows }
}

/** Dense read of a cell, `undefined`/`null` → `''`. */
export function cell(row, index) {
  const value = row?.[index]
  return value === undefined || value === null ? '' : value
}

/** Header name → column index, case- and whitespace-insensitive. */
export function headerIndex(headerRow, names) {
  const wanted = (Array.isArray(names) ? names : [names]).map(normalizeHeader)
  for (let i = 0; i < (headerRow?.length ?? 0); i += 1) {
    if (wanted.includes(normalizeHeader(headerRow[i]))) return i
  }
  return -1
}

function normalizeHeader(value) {
  return String(value ?? '').replace(/\s+/g, '').replace(/^"|"$/g, '').toLowerCase()
}

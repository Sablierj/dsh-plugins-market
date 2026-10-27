/**
 * RFC 4180 CSV, plus the two things Amazon's exports do that the RFC does not
 * mention: a UTF-8 BOM, and a metadata line above the header.
 *
 * Hand-rolled for the same reason as the XLSX reader — no dependencies. A naive
 * `split(',')` would work on most rows and then quietly split
 * `"bench cushion, indoor"` into two fields, shifting every column after it.
 * The shift is silent, so the value lands in a neighbouring column and reads as
 * data.
 */

/** Strip a UTF-8 BOM. Amazon's brand-analytics exports all carry one. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Parse CSV text into rows of strings.
 *
 * Quoted fields may contain the delimiter, newlines and doubled quotes. A bare
 * `\r\n` and a bare `\n` both end a record.
 */
export function parseCsv(text) {
  const input = stripBom(String(text ?? ''))
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0

  const endField = () => { row.push(field); field = '' }
  const endRow = () => { endField(); rows.push(row); row = [] }

  while (i < input.length) {
    const ch = input[i]

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    if (ch === '"' && field === '') { inQuotes = true; i += 1; continue }
    if (ch === ',') { endField(); i += 1; continue }
    if (ch === '\r') { if (input[i + 1] === '\n') i += 1; endRow(); i += 1; continue }
    if (ch === '\n') { endRow(); i += 1; continue }

    field += ch
    i += 1
  }

  // A file ending without a newline still has a final record.
  if (field !== '' || row.length > 0) endRow()
  return rows
}

/** `"1,299.99"` / `"1.299,99"` / `""` → number or null. Never NaN. */
export function toNumber(value, { fallback = null } = {}) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  let text = String(value).trim().replace(/["'\s]/g, '')
  if (text === '') return fallback
  // Strip a currency symbol and a percent sign; both appear in these exports.
  text = text.replace(/^[$€£¥]/, '').replace(/%$/, '')
  if (text === '') return fallback

  const hasComma = text.includes(',')
  const hasDot = text.includes('.')
  if (hasComma && hasDot) {
    // Whichever separator comes last is the decimal separator.
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '')
  } else if (hasComma) {
    // `1,234` is thousands; `1,23` is a European decimal.
    const tail = text.slice(text.lastIndexOf(',') + 1)
    text = tail.length === 3 ? text.replace(/,/g, '') : text.replace(',', '.')
  }

  const n = Number(text)
  return Number.isFinite(n) ? n : fallback
}

/** `""` → null; trims and collapses internal whitespace otherwise. */
export function toText(value) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text === '' ? null : text
}

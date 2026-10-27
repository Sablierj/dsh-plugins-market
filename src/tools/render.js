/**
 * How tool results reach the model.
 *
 * A tool's `output.render` must return content blocks, not a string — the shape
 * is `[{ type: 'text', text }]`. These helpers keep that one place so no tool
 * has to remember it, and keep the rendered text compact: this text is what the
 * model reads, so it is a token budget, not a debug dump.
 */

export const text = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
]

/**
 * Render a fixed-width table.
 *
 * 空值印一个 `—` 而不是留空（2026-10-25 真实数据实测 R-3）：
 * 留空会让「整列为空」的那一列**视觉塌陷**，人眼跳过它，把后一列的数字读到前一列。
 * 实拍例子（四象限）：`bench cushion` 这一行「我们排名」是空的，`4` 是竞品最好排名，
 * 可列一空，读者（包括我）就把 4 读成了我们的排名 —— **我据此差点报一个不存在的 bug**。
 *
 * 这里原来注释写「dropping empty cells so narrow results stay narrow」：省几个 token
 * 是真的，但代价是**读错列**。可读性赢。占位符只要一个字符，表格不会宽多少。
 */
const EMPTY_CELL = '—'
export function table(rows, columns) {
  /* 2026-10-25（第 163 轮）：原来这里直接 `return '(no rows)'` —— 一个英文标记混在中文输出里。
     实测 `amzn_policy_list`：
        政策库: 共 0 条 · 生效中 0 · …
        (no rows)

     **为什么不改成纯中文**：`tests/d2-kw-table-order.mjs` 用
     `String(result.text).includes('(no rows)')` 判断「有行却走了空表早退」——
     那是一个真的会红的判据。把它换成「（无）」会让那两条断言永远通过，**守门就白写了**。

     所以：**保留 `(no rows)` 这个子串**（测试靠它），在后面补一句人话。
     `includes('(no rows)')` 仍然是 true，两条断言仍然有效。 */
  if (rows.length === 0) return '(no rows · 这一栏没有行)'
  const header = columns.map(column => column.label)
  const body = rows.map(row => columns.map((column) => {
    const value = column.value(row)
    return value === null || value === undefined || value === '' ? EMPTY_CELL : String(value)
  }))

  const widths = header.map((label, index) =>
    Math.max(displayWidth(label), ...body.map(line => displayWidth(line[index]))))

  const line = (cells) => cells
    .map((cell, index) => cell + ' '.repeat(Math.max(0, widths[index] - displayWidth(cell))))
    .join('  ')
    .replace(/\s+$/, '')

  return [line(header), widths.map(width => '─'.repeat(width)).join('  '), ...body.map(line)].join('\n')
}

/**
 * 行是**数组**（按位置对齐）时的适配器：`arrayTable(表头数组, 行数组)`.
 *
 * D-2 教训：把顺序写反（`table(表头, 行)`）编译期不报错，第一行真数据才抛
 * `column.value is not a function` —— 而 `table` 的空表早退（rows 为空直接返回
 * '(no rows)'）会让 0 行路径绿着，红被掩盖到有数据那天（B4b 空库绿盲区配方）。
 * 适配器贴着契约放：行是数组就用它，别手写反序的 table 调用。
 */
export function arrayTable(headers, rows) {
  return table(rows, headers.map((label, index) => ({ label, value: row => row[index] })))
}

/**
 * Pad by display width, not by length: a CJK glyph occupies two columns in a
 * terminal, so counting characters would misalign every Chinese title.
 */
function displayWidth(value) {
  let width = 0
  for (const character of String(value)) {
    const code = character.codePointAt(0)
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

/** `1234` → `1,234`; keeps numbers scannable in a table. */
export function num(value) {
  if (value === null || value === undefined) return ''
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value)
}

/** Trim long free text to something a table row can hold. */
export function truncate(value, max = 46) {
  if (value === null || value === undefined) return ''
  const string = String(value)
  return string.length <= max ? string : `${string.slice(0, max - 1)}…`
}

export const yes = (value) => (value ? '是' : '否')

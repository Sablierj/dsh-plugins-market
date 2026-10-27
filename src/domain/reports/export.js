/**
 * 报告导出 —— 哪一种报告能导出成哪几种格式，一处判定。
 *
 * ## 为什么这是一个模块，而不是路由里的三段 if
 *
 * 「这个按钮点了会得到什么」有两半：**能不能导**（这一行的正文在哪、有没有生成过）
 * 与**发什么字节**（读哪一列）。这两半必须读同一份判定，否则页面上的按钮会承诺一个
 * 路由拒绝的格式 —— 而那种不一致从来不报错，它只是让人点一下、看到一个 400。
 *
 * 所以：路由用 `exportPlan` 生成页面载荷里的每一条链接，也用 `exportArtifact` 发字节；
 * 页面对这份链接**只渲染，不推导**（与 `reportState` 的 `url` 同一条纪律）。
 *
 * ## 三种报告的三种答案
 *
 *   - **优化报告**（`pointer: 'ref'`，正文在 `optimization_run`）：Markdown / HTML /
 *     Excel 三种。三份字节是**同一份模型、同一刻**渲染出来的（v50 起 Excel 与另外两份
 *     并列落库），所以导出端点只发字节、绝不重新渲染。v50 之前收尾的轮次没有 Excel
 *     那一列 —— 那是「这一轮没有 Excel 导出件」，不是「Excel 是空的」。
 *     （这一列的迁移本批重基时从 **v49 改号成 v50**：v49 被远端先落地的
 *     `notification-created-at-index` 占了，见 `store/schema.js` 那段注释。）
 *   - **生成类报告**（`pointer: 'body'`，八类，正文是这一行自己的 Markdown）：只有
 *     Markdown。把 Markdown 转成 HTML 会引入**第二个渲染器**（与「一条规则一份实现」
 *     直接冲突），而把自由正文摊进表格对读者没有意义。
 *   - **文件类报告**（`pointer: 'path'`，关键词总库的 HTML 与 CSV）：**没有**导出。
 *     那个文件本身就是导出件；再生成一份就是 §3.6 说过的「第二份副本」，而两份里先
 *     过时的那一份没人知道。
 *
 * 三句话都写在 `exportPlan` 里，理由随行下发（`reason`），所以页面在按钮的位置就能说
 * 清为什么没有 —— 而不是让人点一个灰按钮去猜。
 */

/** The three formats, in the order the buttons appear. */
export const EXPORT_FORMATS = [
  { id: 'md', label: 'Markdown', ext: 'md', type: 'text/markdown; charset=utf-8', kind: 'text' },
  { id: 'html', label: 'HTML', ext: 'html', type: 'text/html; charset=utf-8', kind: 'text' },
  { id: 'xlsx', label: 'Excel', ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'binary' },
]

const FORMAT_BY_ID = Object.fromEntries(EXPORT_FORMATS.map(entry => [entry.id, entry]))

function blank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

/** A BLOB column: present means "a non-empty byte sequence", not "a truthy value". */
function hasBytes(value) {
  if (value === null || value === undefined) return false
  return Number(value.length ?? 0) > 0
}

/** `optimization-2026-10-19-ab12cd34.xlsx` — ASCII, so every header can carry it. */
function fileNameFor(row, format) {
  const kind = String(row?.kind ?? 'report').replace(/[^a-z0-9-]/gi, '') || 'report'
  const date = String(row?.createdAt ?? '').slice(0, 10) || 'undated'
  const shortId = String(row?.id ?? '').replace(/[^a-z0-9]/gi, '').slice(-8) || 'noid'
  return `amazon-ops-${kind}-${date}-${shortId}.${format.ext}`
}

/**
 * Which of the three artifacts an optimization run actually holds.
 *
 * Split out because the report **list** needs it for up to a hundred rows at once
 * (one query with `IS NOT NULL`, not a hundred `getOptimizationRun` calls on a
 * page that polls every three seconds), while a single export needs it for one
 * run. Both feed the same `exportPlan`, so the list and the endpoint cannot
 * disagree about a format being available.
 */
export function availabilityOf(run) {
  return {
    md: !blank(run?.report_md),
    html: !blank(run?.report_html),
    xlsx: hasBytes(run?.report_xlsx),
  }
}

/**
 * Which column makes this row readable — `ref` / `path` / `body` / `none`.
 *
 * Read off the row, where `store/reports.js#hydrateReport` copies it out of
 * `REPORT_KIND_TABLE`. **Not** a `kind === …` test anywhere in this file: the table
 * is the one place that declares where a kind's body lives, and a second test would
 * be a second answer to the same question — the two drift the first time a kind
 * changes its pointer, and nothing reports it. The fallback covers a caller that
 * hands over a raw (unhydrated) row.
 */
function pointerOf(row) {
  if (row?.pointer !== undefined && row?.pointer !== null) return row.pointer
  if (row?.hasBody === true) return 'body'
  return blank(row?.path) ? 'none' : 'path'
}

/**
 * What this report can be exported as, and where each link points.
 *
 * `has` is the artifact availability — `availabilityOf(run)` for an optimization
 * report; `{ md, html, xlsx }` for the others. Passed in rather than looked up here
 * so this module stays a pure decision: the caller owns the store, and the list
 * caller owns a batched query.
 *
 * `hasBody` (not `body`) decides the body case: `getReport` returns a **hydrated**
 * row, which deliberately does not carry the body text — only whether it exists.
 * Reading `row.body` here made every generated report's Markdown button grey
 * (`available: false`) against a real row while the row's body was right there in
 * the database. The bytes are fetched by the caller (`getReportBody`) and handed to
 * `exportArtifact`.
 */
export function exportPlan({ row, has = { md: false, html: false, xlsx: false }, pagePath = '' } = {}) {
  const pointer = pointerOf(row)

  const base = `${pagePath}/report/export/${encodeURIComponent(String(row?.id ?? ''))}`
  const make = (format, available, reason = null) => ({
    ...format,
    url: `${base}/${format.id}`,
    available,
    reason,
  })

  if (pointer === 'ref') {
    return {
      note: '三份导出件是同一份模型在同一刻渲染的：Markdown / HTML / Excel 念同一批字段，'
        + '所以它们不可能对同一个数给出两个答案。',
      formats: [
        make(FORMAT_BY_ID.md, has.md === true,
          '这一轮还没有 Markdown 正文（还没收尾，或收尾时没有生成）'),
        make(FORMAT_BY_ID.html, has.html === true,
          '这一轮还没有 HTML 正文（还没收尾，或收尾时没有生成）'),
        make(FORMAT_BY_ID.xlsx, has.xlsx === true,
          '这一轮**没有 Excel 导出件**：它是在 v50 之前收尾的（Excel 自 v50 起与另外两份一起落库）。'
          + '重跑一次 amzn_optimize_save 会生成 —— 那是用**今天**的输入重新渲染，不是找回原来那一份字节。'),
      ],
    }
  }

  if (pointer === 'body') {
    return {
      note: '这一类报告的正文是这一行自己的 Markdown。不转 HTML（那会引入第二个渲染器），'
        + '也不摊进表格（自由正文进格子没有读者）。',
      formats: [
        make(FORMAT_BY_ID.md, row?.hasBody === true, '这一行的 body 是空的 —— 不是「正文是空的」，是它没有正文'),
        make(FORMAT_BY_ID.html, false, '这一类没有 HTML 导出件：正文是 Markdown，转 HTML 会引入第二个渲染器。要 HTML 请用优化报告那一类'),
        make(FORMAT_BY_ID.xlsx, false, '这一类没有 Excel 导出件：自由正文没有表格结构，摊进格子会丢掉它是一篇文章这件事'),
      ],
    }
  }

  if (pointer === 'path') {
    return {
      note: '这一类报告的正文就是磁盘上那个文件（`report.path`）—— 它本身已经是导出件，'
        + '再生成一份就是第二份副本，先过时的那一份没人知道。请直接取那个文件。',
      formats: EXPORT_FORMATS.map(format => make(format, false,
        `正文是磁盘上的文件（${row?.path ?? 'path 未记录'}），不在这里重新生成`)),
    }
  }

  return {
    note: '这一行既没有指向别的行、也没有自己的正文、也没有磁盘路径 —— 它是一条可列出但取不回的报告。',
    formats: EXPORT_FORMATS.map(format => make(format, false, '这一行没有任何正文来源')),
  }
}

/**
 * The bytes (or the text) for one export, or the reason there are none.
 *
 * Never renders anything: an optimization report's three artifacts were rendered
 * once, at save time, from the model that existed then. Re-rendering here would
 * silently produce a report about *today* that claims to describe a round from
 * months ago — the exact drift `standards.js#dataCutoffOf` exists to prevent.
 *
 * `body` is the generated kind's Markdown, fetched by the caller
 * (`store/reports.js#getReportBody`) — a hydrated row does not carry it. Passing it
 * in keeps this function pure and keeps the "one reader per question" rule: the
 * route does not re-implement `SELECT body`.
 */
export function exportArtifact({ row, run = null, body = null, format = 'md' } = {}) {
  const spec = FORMAT_BY_ID[String(format ?? '').trim()]
  if (spec === undefined) {
    return {
      ok: false,
      code: 'EXPORT_UNKNOWN_FORMAT',
      status: 400,
      message: `没有这种导出格式 "${format}" —— 只有：${EXPORT_FORMATS.map(entry => entry.id).join(' / ')}`,
    }
  }
  const pointer = pointerOf(row)
  /* The availability a single export sees is the same one the list saw: for a run it
     is `availabilityOf(run)`, for a generated report it is "that row has a body". A
     `has` that ignored the body again would make every generated report 404 while the
     list drew it as available. */
  const text = body !== null && body !== undefined ? body : row?.body
  const has = pointer === 'ref'
    ? availabilityOf(run)
    : { md: !blank(text), html: false, xlsx: false }
  const plan = exportPlan({ row, has })
  const entry = plan.formats.find(candidate => candidate.id === spec.id)
  if (entry === undefined || entry.available !== true) {
    return {
      ok: false,
      code: 'EXPORT_UNAVAILABLE',
      status: 404,
      message: `${spec.label} 导出件取不到：${entry?.reason ?? plan.note}`,
    }
  }

  if (pointer === 'ref') {
    const value = spec.id === 'md' ? run?.report_md : (spec.id === 'html' ? run?.report_html : run?.report_xlsx)
    const bytes = spec.kind === 'binary' ? Buffer.from(value) : String(value)
    return { ok: true, format: spec, body: bytes, filename: fileNameFor(row, spec), plan }
  }

  /* Only Markdown is available for a body kind (see `exportPlan`), and its body
     is the row's own Markdown — served as-is. */
  return { ok: true, format: spec, body: String(text), filename: fileNameFor(row, spec), plan }
}

/**
 * `Content-Disposition` with an ASCII name **and** the UTF-8 one.
 *
 * The ASCII name is what an old client saves the file as; the `filename*` is what a
 * browser shows. Both are needed: a header carrying only the UTF-8 form is dropped
 * by some clients, and one carrying only ASCII loses the report's title in the save
 * dialog — and a file called `amazon-ops-optimization-2026-10-19-ab12cd34.xlsx` six
 * times in one folder is exactly how these exports stop being identifiable.
 */
export function attachmentHeader(filename, row) {
  const title = String(row?.title ?? '').trim()
  const suffix = title === '' ? '' : `-${title}`
  const utf8 = encodeURIComponent(`${filename.replace(/\.([a-z]+)$/, '')}${suffix}.${filename.split('.').pop()}`)
  return `attachment; filename="${filename}"; filename*=UTF-8''${utf8}`
}

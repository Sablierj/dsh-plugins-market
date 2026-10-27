/**
 * The report tools: one list of every report this workbench has produced, the
 * comparison of two optimization rounds, and (F14-01) the writer that turns a
 * module's live tables into one report document.
 *
 * The reason `amzn_report_list` is a tool and not just a page: the agent is the
 * one that has to answer "对比一下 B0XXXX 这两轮优化" and "上个月那份总库 CSV 在哪".
 * Before the registry, both answers required knowing which of two unrelated stores
 * to look in — `optimization_run` for one, the filesystem for the other — and an
 * agent that only knew about one of them would confidently report "没有" for a
 * report that exists. `amzn_report_list` reads one table and therefore cannot do
 * that.
 *
 * ## F14-01: the kind labels are **read from the store's table**, never copied
 *
 * Before this batch this file carried `const known = ['optimization', 'kw-report',
 * 'kw-export']` and `const KIND_LABELS = {…}` — a second and a third copy of the
 * kind vocabulary (`src/web/page.js` had a fourth). A fourth kind would have been
 * added in one place and silently missed in two, and the failure mode is the
 * quiet one: the row renders its raw id where a label belongs.
 *
 * So both now come from `REPORT_KIND_TABLE`. `tests/f14-01-report-library.mjs`
 * asserts the two sides go red together when that table is broken.
 */

/* 2026-10-26（R-88）：报告列表要 stat 一下文件还在不在 —— 见下面 `displayStatus` 的注释。 */
import { existsSync } from 'node:fs'
import { table, text, truncate } from './render.js'
import { getOptimizationRun, listOptimizationRuns } from '../store/queries.js'
import { describeOptimizationRun, diffGuard, diffRunViews } from '../domain/optimize/run-view.js'
import {
  REPORT_KINDS, REPORT_STATUSES, getReport, getReportBody, listReports, recordReport,
  reportCounts, reportKindSpec, reportStatus,
  setReportArchived, setReportFavorite, setReportTags,
} from '../store/reports.js'
import { GENERATED_KINDS, buildReport, systemClock } from '../domain/reports/build.js'
/** The same entry `amzn_asin_health` and the run button use (module 13's gates). */
import { precheckFor } from './optimize.js'

function scopeLine(scope) {
  if (scope === null || typeof scope !== 'object') return '—'
  const parts = []
  if (scope.asin) parts.push(`ASIN ${scope.asin}`)
  if (scope.marketplace) parts.push(String(scope.marketplace).toUpperCase())
  if (scope.productLine) parts.push(`产品线 ${scope.productLine}`)
  if (scope.runId) parts.push(`run ${String(scope.runId).slice(0, 8)}`)
  if (scope.stage) parts.push(`阶段 ${scope.stage}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

/** A kind's label, or its raw id when the table does not know it (a downgrade). */
function labelOf(kind) {
  return reportKindSpec(kind)?.label ?? String(kind)
}

/**
 * 2026-10-26（R-88）：**「可取回」是给人的承诺，而 `store` 层的 `openable` 只回答「有没有记着句柄」。**
 *
 * 存储层不碰文件系统是有道理的（`store/reports.js` 是纯数据层，测试用假路径，一 stat 就全红；
 * 而且「可取回」不该随磁盘状态变）。**但用户看到「可取回」时的意思是「我现在点得开」。**
 * 本次实测：23 条报告里恰好 1 条的文件已经不在了，而它是最新的那条 —— 于是点第一条就中。
 *
 * 所以文件存在性在**这一层**判：有 `path` 的行 stat 一下，不在就把它当成「取不回」。
 */
function displayStatus(row) {
  const status = row.status ?? (row.openable === true ? 'ready' : 'unopenable')
  if (status !== 'ready' || typeof row.path !== 'string' || row.path === '') return status
  return existsSync(row.path) ? status : 'unopenable'
}

/**
 * The status cell: the recomputed state, plus the two things a reader needs next
 * to it. Kept in **one cell** rather than two columns so the table stays six wide
 * — the existing assertions parse six cells, and widening it to eight for two
 * flags that are usually empty would make every row read worse.
 */
function statusCell(row) {
  const status = displayStatus(row)
  /* 「取不回」有两种，修法完全不同：一种是指针为空（本来就没记），一种是文件被删了（记着但不在）。
     两个都印成「取不回」会让人以为要去数据库里补指针 —— 而那里是好的。 */
  const missingFile = status === 'unopenable' && typeof row.path === 'string' && row.path !== '' && !existsSync(row.path)
  const parts = [missingFile ? '取不回（文件不在了）' : (row.statusLabel ?? row.status)]
  if (row.favorite) parts.push('★收藏')
  if (Array.isArray(row.tags) && row.tags.length > 0) parts.push(row.tags.map(tag => `#${tag}`).join(','))
  return parts.join(' ')
}

export function reportListTool({ store }) {
  return {
    name: 'amzn_report_list',
    description:
      'List every report this workbench has produced — optimization reports, keyword-library reports and CSV exports, '
      + 'and the eight generated reports (data quality / collection / ASIN health / competitor gap / rule-policy impact / '
      + 'prompt-agent eval / post-publication / operations summary) — newest first. '
      + 'Filter by kind, ASIN, marketplace, product line, status (ready | unopenable | archived), creator, favourite, tag or a '
      + 'lower-bound date. Pass `id` to read one report **including its body**. '
      + 'Use it to answer "this ASIN was optimized how many times and when", "where is that CSV", and "what do the quality '
      + 'numbers look like as of when". A report whose body is no longer reachable is reported as such rather than silently omitted.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: `One of: ${REPORT_KINDS.join(' | ')}. Omit for all.` },
        asin: { type: 'string', description: 'Only reports whose scope names this ASIN.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
        productLine: { type: 'string', description: 'Only reports whose scope names this product line.' },
        status: { type: 'string', description: `One of: all (default) | ${REPORT_STATUSES.join(' | ')}. Recomputed from the row, not a stored column.` },
        createdBy: { type: 'string', description: 'Only reports recorded by this creator. Use the value from the list; NULL (未记录) is its own thing and is not matched.' },
        favorite: { type: 'boolean', description: 'Only starred reports when true.' },
        tag: { type: 'string', description: 'Only reports carrying this exact tag.' },
        since: { type: 'string', description: 'ISO date; only reports created at or after it.' },
        id: { type: 'string', description: 'Read one report by id, including its body. Overrides the filters.' },
        limit: { type: 'number', description: 'Max rows. Default 100, max 1000.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      /* Filter shapes are validated by name rather than passed through, because
         an unrecognised `kind` that silently returns zero rows reads as "there are
         no reports of that kind" — a wrong answer dressed as an empty one. */
      const kind = args?.kind === undefined || args?.kind === null || String(args.kind).trim() === ''
        ? null : String(args.kind).trim()
      if (kind !== null && !REPORT_KINDS.includes(kind)) {
        return { ok: false, error: `未知的 kind "${kind}"`, hint: `用其中之一: ${REPORT_KINDS.join(' / ')}，或省略取全部。` }
      }
      const status = args?.status === undefined || args?.status === null || String(args.status).trim() === ''
        ? 'all' : String(args.status).trim()
      if (status !== 'all' && !REPORT_STATUSES.includes(status)) {
        return { ok: false, error: `未知的 status "${status}"`, hint: `用其中之一: all / ${REPORT_STATUSES.join(' / ')}。` }
      }

      /* One report by id: the body is what the caller came for, and it is the one
         case where returning the whole document is right. */
      const wantedId = args?.id === undefined || args?.id === null ? '' : String(args.id).trim()
      if (wantedId !== '') {
        const row = getReport(store, wantedId)
        if (row === null) {
          return { ok: false, error: `找不到报告 ${wantedId}`, hint: '用不带 id 的一次调用列出全部报告的 id。' }
        }
        const body = getReportBody(store, wantedId)
        const head = [
          `${labelOf(row.kind)} · ${row.title ?? '（无标题）'}`,
          `id ${row.id} · ${String(row.createdAt).slice(0, 19).replace('T', ' ')} · 状态 ${row.statusLabel}`,
          `范围 ${scopeLine(row.scope)}`,
          `来源 ${reportKindSpec(row.kind)?.source ?? '—'} · 写入方 ${reportKindSpec(row.kind)?.writer ?? '—'}`,
        ]
        if (row.note) head.push(`备注 ${row.note}`)
        if (Array.isArray(row.tags) && row.tags.length > 0) head.push(`标签 ${row.tags.join(', ')}`)
        if (row.createdBy !== null) head.push(`创建者 ${row.createdBy}`)
        if (row.archivedAt !== null) head.push(`已归档于 ${row.archivedAt}（${row.archiveReason ?? '没写原因'}）`)
        if (body !== null) {
          head.push('', '--- 正文 ---', '', body)
        } else if (row.path !== null) {
          head.push('', `正文是磁盘上的文件：${row.path}`)
        } else if (row.refId !== null) {
          head.push('', `正文在它指向的那一行里（ref_id ${row.refId}）—— 用 amzn_report_list 之外的那个模块的读工具打开。`)
        } else {
          head.push('', '⚠️ 这一行的正文**已经取不回**（指针为空）。它仍然被列出来，因为「报告存在过」这件事不会因为它丢了就消失。')
        }
        return head.join('\n')
      }

      const listed = listReports(store, {
        kind,
        asin: args?.asin ?? null,
        marketplace: args?.marketplace ?? null,
        productLine: args?.productLine ?? null,
        /* 2026-10-26（R-88）：ready / unopenable 交给下面按磁盘再筛，所以这里不要先让 SQL 筛一遍 ——
           否则筛「取不回」时 store 已经把那一行挡掉了（它按句柄判，认为可取回），我这边就无事可做。 */
        status: (status === 'ready' || status === 'unopenable') ? 'all' : status,
        createdBy: args?.createdBy ?? null,
        favorite: args?.favorite === true,
        tag: args?.tag ?? null,
        since: args?.since ?? null,
        limit: args?.limit ?? 100,
      })
      /* 2026-10-26（R-88）：`ready` / `unopenable` 在 store 层是按「有没有记着句柄」筛的，
         而那件事与「文件还在不在」不是一回事。这里按**显示用的那个状态**再筛一次 ——
         否则筛「可取回」会把死链留在列表里，筛「取不回」又找不到它。 */
      const statusNeedsDisk = status === 'ready' || status === 'unopenable'
      const rows = statusNeedsDisk ? listed.rows.filter(row => displayStatus(row) === status) : listed.rows
      const total = listed.total
      const limit = listed.limit
      const matched = statusNeedsDisk ? rows.length : listed.matched

      const head = [
        `报告 ${rows.length} 条（命中 ${matched} 条，库内共 ${total} 条${rows.length < matched ? `，本次取最近 ${limit}` : ''}）`,
      ]
      const filters = []
      if (kind !== null) filters.push(`kind=${kind}`)
      if (args?.asin) filters.push(`ASIN=${String(args.asin).toUpperCase()}`)
      if (args?.marketplace) filters.push(`站点=${String(args.marketplace).toUpperCase()}`)
      if (args?.productLine) filters.push(`产品线=${args.productLine}`)
      if (status !== 'all') filters.push(`状态=${status}`)
      if (args?.createdBy) filters.push(`创建者=${args.createdBy}`)
      if (args?.favorite === true) filters.push('只看收藏')
      if (args?.tag) filters.push(`标签=${args.tag}`)
      if (args?.since) filters.push(`since=${args.since}`)
      if (filters.length > 0) head.push(`筛选: ${filters.join(' · ')}`)

      if (rows.length === 0) {
        head.push('')
        if (total === 0) {
          /* Empty library. The three kinds that existed are written by the work
             that produces them; the eight generated ones need `amzn_report_build`.
             Both are said, because "no reports" and "nothing can make a report"
             are different claims and only one of them is true here. */
          head.push('库内还没有任何报告。两条路都可以让它出现：')
          head.push('  · 跑一次优化收尾（amzn_optimize_save）或让关键词总库出表 —— 索引类报告由产生它的那一步登记；')
          head.push(`  · amzn_report_build kind=<${GENERATED_KINDS.join('|')}> —— 生成类报告在你要它的那一刻冻结。`)
          head.push('这不是「本仓不支持报告」：' + `${REPORT_KINDS.length} 个类别每一个都登记了写入方（见 kind 说明）。`)
        } else if (kind !== null && reportCounts(store)[kind] === 0) {
          head.push(`库内有 ${total} 条报告，但**这一类一条都没有**：${labelOf(kind)}。`
            + `这不是「筛选条件太窄」—— 是这一类还没被生成过。写入方：${reportKindSpec(kind)?.writer ?? '—'}。`)
        } else {
          head.push(`这个筛选条件下没有报告（库内共 ${total} 条，本条件命中 0 条）。`
            + '放宽条件再试 —— 不要把它读成「没有报告」。')
        }
        return head.join('\n')
      }

      /* Six cells, and the fourth of them is the **recomputed** status. Widening
         the table for the favourite/tag flags would push it past what a terminal
         row can hold, so `statusCell` folds them into that one cell. */
      const body = table(rows, [
        { label: '时间', value: row => String(row.createdAt).slice(0, 19).replace('T', ' ') },
        { label: '类型', value: row => labelOf(row.kind) },
        { label: '范围', value: row => truncate(scopeLine(row.scope), 30) },
        { label: '标题', value: row => truncate(row.title ?? '—', 28) },
        { label: '状态', value: row => statusCell(row) },
        { label: 'id', value: row => row.id },
      ])

      const dead = rows.filter(row => row.openable !== true)
      const notes = []
      if (dead.length > 0) {
        notes.push('', `⚠️ 其中 ${dead.length} 条报告点开也取不到内容（正文已不在）—— 如实说明，不要用标题假装它还在:`)
        for (const row of dead) notes.push(`  - ${row.id} ${labelOf(row.kind)} ${row.title ?? ''}`.trimEnd())
      }

      const files = rows.filter(row => row.path !== null)
      if (files.length > 0) {
        notes.push('', '文件位置:')
        for (const row of files) notes.push(`  ${row.id} → ${row.path}`)
      }

      const generated = rows.filter(row => row.hasBody === true)
      if (generated.length > 0) {
        notes.push('', `正文在库里（可直接读）: ${generated.length} 条 —— 传 id=… 取全文。`)
      }

      head.push('', body, ...notes)
      return head.join('\n')
    },
  }
}

/**
 * `amzn_report_build` — the writer for the eight generated kinds (F14-01).
 *
 * Why a separate tool instead of a side effect on `amzn_dq_scan` / the collection
 * service: a report is a **frozen snapshot**, and it should be produced at the
 * moment somebody wants it, not quietly appended every time some other tool runs.
 * A scan that wrote a report row would make the report library grow without anyone
 * asking, and the newest row would describe a scan nobody chose to publish.
 *
 * It renders nothing of its own: the Markdown comes from
 * `src/domain/reports/build.js`, which calls each module's **existing** builder.
 * Two renderers for one criterion would eventually disagree, and the report would
 * be the one nobody re-checked.
 *
 * ## `clock`: the seam, not a knob the agent can turn
 *
 * The tool is the only writer of generated reports, so it is the only place that
 * decides "which day is this snapshot". That decision is taken from `clock`,
 * which defaults to `systemClock` — the same function `buildReport` falls back
 * to, so there is still exactly **one** reading of the real clock in this path.
 * Tests inject a fixed `clock`; nothing in the agent-facing `parameters` exposes
 * it, because a caller who could name the day could silently overwrite another
 * day's snapshot.
 */
export function reportBuildTool({ store, clock = systemClock }) {
  return {
    name: 'amzn_report_build',
    description:
      'Generate and register ONE report from the store as it is right now — the writer for the eight generated kinds. '
      + `Kinds: ${GENERATED_KINDS.join(' | ')}. `
      + 'The body is frozen into the report row at generation time (it is the only copy — there is no file), so re-reading it '
      + 'later shows what the data said then. Re-running on the same day for the same scope UPDATES that day\'s snapshot '
      + 'instead of piling up duplicates; a different day is a different snapshot. '
      + 'Every report ends with the four different kinds of "nothing" spelled out separately: no source in this repository / '
      + 'not modelled / source exists but nothing recorded / measured and it is zero. Read that section before reporting a 0 to the user. '
      + 'ASIN health and competitor-gap need `asin` + `marketplace`. Pass `dryRun: true` to read the document without writing it.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: `One of: ${GENERATED_KINDS.join(' | ')}.` },
        asin: { type: 'string', description: 'Required for asin-health and competitor-gap.' },
        marketplace: { type: 'string', description: 'Required for asin-health and competitor-gap. Default US when an ASIN is given.' },
        productLine: { type: 'string', description: 'Recorded into the report scope so the report library can filter by it.' },
        dryRun: { type: 'boolean', description: 'Build and return the document without registering it. Default false.' },
        reportId: { type: 'string', description: 'Overwrite this existing report id instead of the day-derived one.' },
      },
      required: ['kind'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const kind = String(args?.kind ?? '').trim()
      const asin = args?.asin === undefined || args?.asin === null || String(args.asin).trim() === ''
        ? null : String(args.asin).trim().toUpperCase()
      const marketplace = args?.marketplace === undefined || args?.marketplace === null || String(args.marketplace).trim() === ''
        ? (asin === null ? null : 'US')
        : String(args.marketplace).trim().toUpperCase()

      const built = buildReport(store, {
        kind, asin, marketplace,
        productLine: args?.productLine ?? null,
        now: clock(),
        precheckFor,
      })
      if (built.ok === false) {
        return {
          ok: false,
          code: built.code,
          error: built.error,
          hint: built.hint ?? null,
          tool: 'amzn_report_build',
        }
      }

      if (args?.dryRun === true) {
        return {
          ok: true,
          dryRun: true,
          kind: built.kind,
          reportId: built.reportId,
          title: built.title,
          written: false,
          text: built.body + '\n\n（dryRun：没有登记。去掉 dryRun 才会写进报告库。）',
        }
      }

      const explicitId = args?.reportId === undefined || args?.reportId === null || String(args.reportId).trim() === ''
        ? null : String(args.reportId).trim()
      const report = recordReport(store, {
        id: explicitId ?? built.reportId,
        kind: built.kind,
        title: built.title,
        scope: built.scope,
        body: built.body,
        createdAt: built.now,
        createdBy: 'amzn_report_build',
        note: null,
      })
      const head = [
        `${labelOf(report.kind)} 已登记 · ${report.title ?? ''}`,
        `id ${report.id} · 状态 ${report.statusLabel} · 正文 ${built.body.length} 字符（冻结在报告行里，这是唯一的一份）`,
        `范围 ${scopeLine(report.scope)} · 来源 ${reportKindSpec(report.kind)?.source ?? '—'}`,
      ]
      return { ok: true, report, text: head.join('\n') + '\n\n--- 正文 ---\n\n' + built.body }
    },
  }
}

/**
 * `amzn_report_update` — favourite / tag / archive one report.
 *
 * Three flags, one call, because they are the same act: "this row is in my working
 * set, and here is how I find it". Archiving is **not** deleting: the 2026-10-13
 * ruling on ASIN archive (「归档的行照样显示、逐行标『已归档』」) applies to
 * reports for the same reason — a row that vanished on its own looks exactly like
 * a bug.
 *
 * Every branch reads the row back with `getReport` and returns it, so the answer
 * is the stored state rather than what the caller asked for.
 */
export function reportUpdateTool({ store }) {
  return {
    name: 'amzn_report_update',
    description:
      'Star / tag / archive ONE report. `favorite` toggles the starred flag; `tags` replaces the tag list (an empty array '
      + 'CLEARS it, which is different from never having had tags); `archived: true` stamps the archive and `false` restores. '
      + 'Archiving does NOT hide the report — the library keeps showing it with a 「已归档」 chip and the status filter '
      + '(`status=archived`) is how you look at only the archived ones. Returns the stored row, read back.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The report id (full, from amzn_report_list).' },
        favorite: { type: 'boolean', description: 'Star (true) or unstar (false).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replace the tag list. [] clears it.' },
        archived: { type: 'boolean', description: 'true archives, false restores.' },
        archiveReason: { type: 'string', description: 'Why it was archived. Stored on the row; only used with archived=true.' },
        by: { type: 'string', description: 'Who archived it. Stored verbatim; omit when unknown (the column stays NULL = 未记录).' },
      },
      required: ['id'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id === '') return { ok: false, error: 'id 是必填项', hint: '先用 amzn_report_list 取 id（要完整 id，不是前 8 位）。' }

      const touched = []
      let row = null
      if (args?.favorite !== undefined) {
        row = setReportFavorite(store, id, args.favorite === true)
        if (row === null) return { ok: false, error: `找不到报告 ${id}` }
        touched.push(args.favorite === true ? '已加入收藏' : '已取消收藏')
      }
      if (args?.tags !== undefined) {
        if (!Array.isArray(args.tags)) return { ok: false, error: 'tags 必须是字符串数组（清空用 []）' }
        row = setReportTags(store, id, args.tags)
        if (row === null) return { ok: false, error: `找不到报告 ${id}` }
        touched.push(args.tags.length === 0 ? '标签已清空' : `标签已设为 ${args.tags.join(', ')}`)
      }
      if (args?.archived !== undefined) {
        row = setReportArchived(store, id, args.archived === true, {
          by: args?.by ?? null,
          reason: args?.archiveReason ?? null,
        })
        if (row === null) return { ok: false, error: `找不到报告 ${id}` }
        touched.push(args.archived === true ? '已归档（列表里仍会显示，带「已归档」）' : '已恢复')
      }
      if (row === null) {
        return { ok: false, error: '这条调用什么也没改 —— favorite / tags / archived 至少要给一个', hint: '例如 { id, favorite: true }。' }
      }

      const lines = [
        `${labelOf(row.kind)} · ${row.title ?? '（无标题）'}`,
        `id ${row.id} · 状态 ${row.statusLabel}`,
        ...touched.map(line => `· ${line}`),
        `读回：收藏 ${row.favorite ? '是' : '否'} · 标签 ${Array.isArray(row.tags) ? (row.tags.length === 0 ? '（清空了）' : row.tags.join(', ')) : '未打过'}`,
      ]
      if (row.archivedAt !== null) {
        lines.push(`归档于 ${row.archivedAt} · ${row.archiveReason ?? '没写原因'} · ${row.archivedBy ?? '没记是谁'}`)
      }
      /* Read-back reconciliation, not a self-check: the status is **recomputed** from
         the row, and the filter is a **different engine** (a SQL CASE built from the
         same `pointer` table). Asking the filter for the row it just wrote is what
         proves the two agree — comparing `row.status` with `reportStatus(row)` would
         be comparing a value with itself. */
      const status = reportStatus(row)
      const back = listReports(store, { status, limit: 1000 }).rows.some(entry => entry.id === row.id)
      if (!back) throw new Error(`刚写回的 ${row.id} 不在 status=${status} 的筛选结果里 —— 状态重算与筛选分支不一致`)
      return { ok: true, report: row, text: lines.join('\n') }
    },
  }
}


/** `0.29` → `+29.0%`; `-2` → `-2`; `0` → `0`; **`null`/`undefined` → `未记录`**。
 *  ⚠️ 最后那条是必须的：`Number(null)` 是 0、`Number(undefined)` 是 NaN，
 *  原来的实现在「上一轮没记录」时印 `0`（读成「没变化」）、在「读不到」时印 `NaN%`。
 *  没读数就是没读数，不许伪装成 0。 */
function signed(value, render = String) {
  if (value === null || value === undefined) return '未记录'
  const n = Number(value)
  if (!Number.isFinite(n)) return '未记录'
  if (n === 0) return '0'
  return `${n > 0 ? '+' : '-'}${render(Math.abs(n))}`
}

const asPercent = (value) => (value === null || value === undefined || !Number.isFinite(Number(value))
  ? '未记录'
  : `${(Number(value) * 100).toFixed(1)}%`)
const asCount = (value) => (value === null || value === undefined || !Number.isFinite(Number(value))
  ? '未记录'
  : String(Number(value)))

/**
 * Compare two optimization rounds.
 *
 * This exists because the two questions an operator actually asks after a second
 * pass — "did it get better" and "what did this round change" — are answered by
 * two different comparisons, and answering only one of them is how a round that
 * improved its score while dropping a field we already rank for gets called a win.
 * So it reports both: the gate/coverage/blocker movement, and the field-by-field
 * difference including the fields a round stopped proposing.
 *
 * Read-only, and it never re-derives anything: both sides come from `describeOptimizationRun`,
 * the same resolver the run panel and `amzn_optimize_report` use. A diff computed
 * from a second reading of the limits and roster rules could disagree with the
 * panel about the very same run, and there would be no way to tell which is right.
 */
export function reportDiffTool({ store }) {
  return {
    name: 'amzn_report_diff',
    description:
      'Compare two optimization rounds of the same listing (same ASIN, same marketplace): which fields were added, '
      + 'dropped or rewritten, whether each proposal was written, how the blockers and warnings moved, and how keyword '
      + 'coverage and the six gates changed. Read-only. Use it to answer "这一轮比上一轮改了什么、好在哪里", and to catch '
      + 'a round that improved its score while quietly dropping a field an earlier round had written.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '基准那一轮的 run id（较早的一轮）。完整 id，可从 amzn_report_list 或 amzn_optimize_* 的返回里取。' },
        to: { type: 'string', description: '要对比的那一轮的 run id（较晚的一轮）。' },
      },
      required: ['from', 'to'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const fromId = String(args?.from ?? '').trim()
      const toId = String(args?.to ?? '').trim()
      if (fromId === '' || toId === '') return 'from 和 to 都是必填项 —— 它们是两次优化运行的 run id。'

      const fromRun = getOptimizationRun(store, fromId)
      const toRun = getOptimizationRun(store, toId)
      if (fromRun === null || toRun === null) {
        const missing = [fromRun === null ? fromId : null, toRun === null ? toId : null].filter(Boolean)
        const recent = listOptimizationRuns(store, { limit: 10 }).rows
        const lines = [`找不到运行: ${missing.join(' / ')}`]
        lines.push(recent.length === 0
          ? '库内还没有任何优化运行 —— 对比要先有两次 amzn_optimize_prepare。'
          : '最近的运行（run id 要传完整的）:')
        for (const row of recent) {
          lines.push(`  ${row.id}  ${row.asin} ${row.marketplace} ${row.status} ${String(row.started_at).slice(0, 19)}`)
        }
        return lines.join('\n')
      }

      /* Guarded on the raw rows, before either run is resolved: comparing two
         different listings succeeds and is therefore worse than failing — every
         number in it is real and the whole answer is meaningless. */
      const refusal = diffGuard(fromRun, toRun)
      if (refusal !== null) return `不能对比这两次运行：${refusal}`

      const from = describeOptimizationRun(store, fromRun)
      const to = describeOptimizationRun(store, toRun)
      const diff = diffRunViews(from, to)

      const short = (id) => String(id).slice(0, 8)
      const lines = [`优化轮次对比 ${short(from.id)} → ${short(to.id)}`]
      lines.push(`ASIN ${to.asin} · ${String(to.marketplace).toUpperCase()}`)
      lines.push(`  基准 ${String(from.startedAt).slice(0, 19).replace('T', ' ')} · ${from.status} · 规则库 ${from.roster?.version ?? '—'}`)
      lines.push(`  对比 ${String(to.startedAt).slice(0, 19).replace('T', ' ')} · ${to.status} · 规则库 ${to.roster?.version ?? '—'}`)

      if (diff.backwards) {
        lines.push('', '⚠️ 基准那一次比对比那一次更晚 —— 这份差异的方向是反的，先确认哪一轮是新的再读。')
      }
      if (diff.roster.changed) {
        lines.push('', `⚠️ 两次运行之间规则库换过版本（${diff.roster.from ?? '—'} → ${diff.roster.to ?? '—'}）—— 判定标准本身变了，闸门与违规的差异不全是改动的功劳。`)
      }

      lines.push('', `闸门 ${diff.gates.passed.from}/${diff.gates.total.from} → ${diff.gates.passed.to}/${diff.gates.total.to} (${signed(diff.gates.passed.delta)})`)
      if (diff.gates.flipped.length === 0) {
        lines.push('  逐项没有翻转。')
      } else {
        for (const gate of diff.gates.flipped) {
          const mark = gate.from === null ? '＋' : (gate.to === null ? '－' : (gate.to ? '▲' : '▼'))
          const fromText = gate.from === null ? '（这次不判）' : (gate.from ? '已过' : '未过')
          const toText = gate.to === null ? '（不再判这一项）' : (gate.to ? '已过' : '未过')
          lines.push(`  ${mark} ${gate.label}  ${fromText} → ${toText}`)
          if (gate.detail) lines.push(`      ${truncate(gate.detail, 60)}`)
        }
      }

      lines.push('', `阻断 ${diff.counts.block.from} → ${diff.counts.block.to} (${signed(diff.counts.block.delta)})`
        + ` · 警告 ${diff.counts.warn.from} → ${diff.counts.warn.to} (${signed(diff.counts.warn.delta)})`)

      const coverage = diff.coverage.map(entry => ({
        label: entry.label,
        from: entry.key === 'fillRate' ? asPercent(entry.from) : asCount(entry.from),
        to: entry.key === 'fillRate' ? asPercent(entry.to) : asCount(entry.to),
        delta: entry.key === 'fillRate'
          ? signed(entry.delta, value => `${(value * 100).toFixed(1)}pt`)
          : signed(entry.delta),
      }))
      lines.push('', '词覆盖')
      lines.push(table(coverage, [
        { label: '指标', value: row => row.label },
        { label: '基准', value: row => row.from },
        { label: '对比', value: row => row.to },
        { label: '变化', value: row => row.delta },
      ]))

      const { added, removed, changed, unchanged, acceptedChanged } = diff.drafts
      lines.push('', `字段：新增 ${added.length} · 变更 ${changed.length} · 移除 ${removed.length}`
        + ` · 写入状态变化 ${acceptedChanged.length} · 未变 ${unchanged.length}`)
      if (added.length === 0 && removed.length === 0 && changed.length === 0 && acceptedChanged.length === 0) {
        lines.push('两次运行提出的字段和写入状态完全一致 —— 差异只在闸门、违规或词覆盖上。')
      }

      if (changed.length > 0) {
        lines.push('', '改写过的字段:')
        lines.push(table(changed, [
          { label: '字段', value: row => row.label },
          { label: '基准', value: row => truncate(row.afterFrom ?? row.beforeFrom, 26) },
          { label: '对比', value: row => truncate(row.afterTo ?? row.beforeTo, 26) },
          { label: '基准已写入', value: row => (row.acceptedFrom ? '是' : '否') },
          { label: '这一轮已写入', value: row => (row.acceptedTo ? '是' : '否') },
        ]))
      }

      if (added.length > 0) {
        lines.push('', '只有这一轮提出的字段:')
        lines.push(table(added, [
          { label: '字段', value: row => row.label },
          { label: '值', value: row => truncate(row.after, 34) },
          { label: '已写入', value: row => (row.accepted ? '是' : '否') },
        ]))
      }

      if (removed.length > 0) {
        lines.push('', '只有基准那一轮提出的字段（这一轮不再提）:')
        lines.push(table(removed, [
          { label: '字段', value: row => row.label },
          { label: '值', value: row => truncate(row.after, 34) },
          { label: '基准已写入', value: row => (row.accepted ? '是' : '否') },
        ]))
      }

      /* Text unchanged, write state changed. Easy to lose: the field does not
         appear in any of the three tables above, so a round that wrote something
         the previous round only proposed would read as "no field changes". */
      if (acceptedChanged.length > 0) {
        lines.push('', '文本没变、但写入状态变了的字段:')
        lines.push(table(acceptedChanged, [
          { label: '字段', value: row => row.label },
          { label: '基准已写入', value: row => (row.acceptedFrom ? '是' : '否') },
          { label: '这一轮已写入', value: row => (row.acceptedTo ? '是' : '否') },
        ]))
      }

      /* Two notes that exist because the obvious reading of the tables above is
         wrong in exactly these two cases. */
      const proposedOnly = changed.filter(row => !row.acceptedTo)
      if (proposedOnly.length > 0) {
        lines.push('', `⚠️ 其中 ${proposedOnly.length} 个字段只改了提案、这一轮没有写入 —— 库里仍是旧值，不要当成已生效。`)
      }
      const droppedWritten = removed.filter(row => Boolean(row.accepted))
      if (droppedWritten.length > 0) {
        lines.push('', `⚠️ ${droppedWritten.map(row => row.label).join('、')} 在基准那一轮已经写入，这一轮不再提出。`
          + '这不是「没变化」，是这一轮放弃了这个字段 —— 页面上它的值还是上一轮写的。')
      }

      return lines.join('\n')
    },
  }
}

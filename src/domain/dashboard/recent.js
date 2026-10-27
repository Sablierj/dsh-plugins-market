/**
 * 最近运行与产物 — the five kinds of thing the workbench produces, side by side.
 *
 * The dashboard already answers two questions: the six health cards say how the
 * data is doing, the four todo buckets say what needs doing. Neither answers
 * "what did this thing last produce", which is the first question a reader has
 * after a day away.
 *
 * ## Five kinds, always five
 *
 * The kinds are **declared** in `RECENT_KINDS`, not discovered by querying.
 * Four of them read a real table; the fifth (`Agent`) has no table at all. If
 * the list were built from "tables that came back with rows", the empty kinds
 * would vanish, and a kind that is not drawn is indistinguishable from a kind
 * that does not exist — the failure the todo buckets and the snapshot registry
 * are both built to avoid. So `buildRecent` always returns five entries, in
 * declaration order, and an empty one comes back as `rows: []` with a `note`.
 *
 * ## 「未接入」 is not 「暂无」
 *
 * The two sentences are different facts, and this module keeps them apart:
 *
 *   - `EMPTY_BUCKET_TEXT` (「暂无」) is for a kind whose table exists and has no
 *     rows. Running the thing would produce data, so the reader knows what to
 *     do next.
 *   - `UNAVAILABLE_KIND_TEXT` (「未接入」) is for a kind that has no table yet.
 *     Nothing the reader does today will produce a row, and 「暂无」 would send
 *     them hunting for a button that is not there.
 *
 * That is why `available` is a **declaration**, never "we queried and found
 * nothing": a query against a missing table and a query against an empty table
 * do not differ in their result, only in what the result means.
 *
 * ## Every row carries its object id
 *
 * A row that says "an optimization run finished twenty minutes ago" and then
 * drops the reader on the module's front page has moved the search rather than
 * done it. Each row therefore carries `objectId` / `objectType` plus the
 * filters to apply on arrival, following the todo buckets' link contract
 * (`#<module>#<anchor>` plus a filter bag).
 *
 * ## No scope filter, on purpose
 *
 * The cards and the todos are narrowed by the selected marketplace; this block
 * is not. It answers "what did the workbench last produce", and narrowing it
 * would make a run that just finished invisible because the scope happens to
 * point at another storefront — while the empty state would still read 「暂无」,
 * which claims there is nothing rather than nothing *in this scope*. A block
 * that is global says so by being global.
 */

import { hydrateReport } from '../../store/reports.js'
import { EMPTY_BUCKET_TEXT } from './todos.js'
/* 模块 12 的角色标签：角色是代码里的声明，这一行把 id 翻成人话。取 domain 里那份，
   不让页面和这里各存一份标签。 */
import { roleById } from '../agent/roles.js'

/** How many rows each kind shows. The rest are one click away in its module. */
/** 角色 id → 中文标签，取不到就原样显示（一个没声明的角色至少还看得出是哪个）。 */
function roleLabel(id) {
  return roleById(id)?.label ?? String(id ?? '')
}

/** How many rows each kind shows. The rest are one click away in its module. */
export const RECENT_LIMIT = 5

/** The sentence for a kind whose table does not exist yet — see the header. */
export const UNAVAILABLE_KIND_TEXT = '未接入'

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

function clampLimit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return RECENT_LIMIT
  return Math.min(Math.max(Math.trunc(number), 1), 20)
}

/* ──────────────────────────── what each row is ──────────────────────────── */

/* The titles name the object, not the table. "collection_task row 4f2a" tells a
   reader nothing they can act on; "ASIN 采集 · 12 个目标 · browser" is the thing
   they asked for. The counts come from the row's own JSON, parsed defensively —
   a targets_json that will not parse is a task with no targets we can name, not
   a crash in the dashboard. */

function collectionTitle(row) {
  const targets = parseJson(row.targets_json, [])
  const count = Array.isArray(targets) ? targets.length : 0
  const what = row.kind === 'keyword' ? '关键词扫描' : 'ASIN 采集'
  const source = String(row.source_id ?? '').trim()
  return `${what} · ${count} 个目标` + (source === '' ? '' : ` · ${source}`)
}

function pipelineTitle(row) {
  const line = row.product_line === null || row.product_line === undefined || row.product_line === ''
    ? ''
    : ` / ${row.product_line}`
  return `关键词管道 · ${row.marketplace}${line}`
}

function optimizationTitle(row) {
  const asin = String(row.asin ?? '').trim()
  const market = String(row.marketplace ?? '').trim()
  return `Listing 优化 · ${asin === '' ? '—' : asin} ${market}`.trim()
}

function reportScope(row) {
  const scope = parseJson(row.scope_json, null)
  return scope !== null && typeof scope === 'object' ? scope : {}
}

/* ───────────────────────────── the declaration ──────────────────────────── */

/**
 * The five kinds, in the order they are read.
 *
 * Each available kind declares the table it reads, the column its status lives
 * in, the column its time lives in, how to name a row, and how to build the
 * link back to it. `statusOf` exists only for a kind whose status is **derived**
 * rather than stored — today that is the report kind, and the derivation is
 * reused from `hydrateReport` rather than repeated here.
 */
export const RECENT_KINDS = [
  {
    id: 'collection',
    label: '采集',
    module: 'collect',
    table: 'collection_task',
    objectType: 'collection_task',
    statusColumn: 'status',
    timeColumn: 'submitted_at',
    available: true,
    title: collectionTitle,
    link: row => ({ link: '#collect', filters: { taskId: row.id } }),
  },
  {
    id: 'pipeline',
    label: '管道',
    module: 'pipeline',
    table: 'kw_pipeline_run',
    objectType: 'kw_pipeline_run',
    statusColumn: 'status',
    timeColumn: 'started_at',
    available: true,
    title: pipelineTitle,
    link: row => ({ link: '#pipeline', filters: { runId: row.id } }),
  },
  {
    /* 模块 12 落到主线之后，这一类从「未接入」变成了真的。
       原来那句「agent_run 表还没有」现在是假的 —— 表在 v30 建了，所以 `available`
       翻成 true，行也从空的占位换成真的读。这正是这一模块自己的规矩：`available`
       是**声明**，不是查询结果；声明不可用而表存在，是反过来的那个谎，它会让读者
       在有东西可看的时候不要去看。 */
    id: 'agent',
    label: 'Agent',
    module: 'agent',
    table: 'agent_run',
    objectType: 'agent_run',
    statusColumn: 'status',
    timeColumn: 'started_at',
    available: true,
    title: row => `${roleLabel(row.role)} · ${String(row.goal ?? '').trim() || '（没有写目标）'}`,
    link: row => ({ link: '#agent', filters: { agentRunId: row.id } }),
  },
  {
    id: 'optimization',
    label: '优化',
    module: 'optimize',
    table: 'optimization_run',
    objectType: 'optimization_run',
    statusColumn: 'status',
    timeColumn: 'started_at',
    available: true,
    title: optimizationTitle,
    /* `#inbox` is the drafts inbox inside the optimize panel — the same anchor
       the drafts todo uses, so the two links land in the same place. */
    link: row => ({ link: '#optimize#inbox', filters: { runId: row.id } }),
  },
  {
    /* `report` has no status column, and that is a fact about the table rather
       than an omission: a report is not running or finished, it either still
       has a body or it does not. The honest status is therefore `openable`,
       which `hydrateReport` already decides (an optimization report needs its
       run, a file report needs its path) — one implementation, reused. */
    id: 'report',
    label: '报告',
    module: 'report',
    table: 'report',
    objectType: 'report',
    statusColumn: null,
    timeColumn: 'created_at',
    available: true,
    title: row => String(row.title ?? '').trim() || String(row.id),
    statusOf: row => (hydrateReport(row).openable ? 'openable' : 'unreachable'),
    link: row => {
      const scope = reportScope(row)
      const filters = { reportKind: row.kind }
      const asin = String(scope.asin ?? '').trim()
      if (asin !== '') filters.reportAsin = asin.toUpperCase()
      return { link: '#report', filters }
    },
  },
]

/* ────────────────────────────── the builder ─────────────────────────────── */

/* The table and column names below are interpolated from the declaration above,
   never from a caller's string, so this is not a way in for anything. `SELECT *`
   rather than a column list because each kind reads different columns and the
   list would be a second declaration to keep in step with the first. */
function loadRows(store, kind, limit) {
  return store.all(
    `SELECT * FROM ${kind.table} ORDER BY ${kind.timeColumn} DESC, rowid DESC LIMIT ?`,
    [limit],
  )
}

function countRows(store, kind) {
  return Number(store.get(`SELECT COUNT(*) AS n FROM ${kind.table}`)?.n ?? 0)
}

function kindToRow(kind, row) {
  const status = kind.statusOf === undefined
    ? (kind.statusColumn === null ? null : row[kind.statusColumn] ?? null)
    : kind.statusOf(row)
  const target = kind.link(row)
  return {
    objectType: kind.objectType,
    objectId: String(row.id),
    title: kind.title(row),
    status: status === null ? null : String(status),
    at: row[kind.timeColumn] ?? null,
    link: target.link,
    filters: target.filters,
  }
}

/**
 * The five kinds, always five, each with its newest rows.
 *
 * A kind with no rows comes back as `rows: []` plus a `note` — the ordinary
 * 「暂无」 when its table exists, and 「未接入」 with the reason when it does not.
 * The page draws that note in the kind's own box; a box that disappeared would
 * read as a feature that was never built.
 *
 * `total` is the count of rows in the table, so the panel can say "newest 5 of
 * 137" instead of implying five is all there is.
 */
export function buildRecent(store, { limit = RECENT_LIMIT } = {}) {
  const cap = clampLimit(limit)
  return RECENT_KINDS.map(kind => {
    if (kind.available !== true) {
      return {
        id: kind.id,
        label: kind.label,
        available: false,
        table: kind.table,
        statusColumn: kind.statusColumn,
        total: 0,
        rows: [],
        /* The one sentence that must not be confused with 「暂无」: nothing the
           reader does today will put a row here. */
        note: `${UNAVAILABLE_KIND_TEXT}：${kind.unavailableReason}`,
      }
    }

    const rows = loadRows(store, kind, cap)
    return {
      id: kind.id,
      label: kind.label,
      available: true,
      table: kind.table,
      statusColumn: kind.statusColumn,
      total: countRows(store, kind),
      rows: rows.map(row => kindToRow(kind, row)),
      note: rows.length === 0 ? EMPTY_BUCKET_TEXT : null,
    }
  })
}

/**
 * ASIN 保存视图（模块 05 F05-01，schema v42）。
 *
 * ## 一个保存视图是**一组输入**，不是一份结果
 *
 * 存下来的两样东西是筛选（`filters_json`）与列配置（`columns_json`）。
 * 不存查询结果 —— 存了的话，这一行会随着库里的数据变旧，而一个「保存视图」
 * 看起来像一张报表、读起来像一张报表、却不是当下的库。加载视图 = 把这两样
 * 还给工作台的 `filters`，查询照常发生。
 *
 * ## 写入口只有这里，所以「同名覆盖」只在一处实现
 *
 * 工具（`amzn_asin_view_save` / `_delete`）与页面的两条写路由都调这一对函数。
 * 两条路径各写一遍 upsert，就是两份「什么算合法视图名」「同名怎么办」的实现，
 * 而它们漂开时两边都不报错。
 *
 * ## 读的时候不信任库里的 JSON
 *
 * `filters_json` / `columns_json` 是 TEXT。解析失败、或者解析出来不是预期的形状
 * （对象 / 数组）时，这个视图**照样列出来**，但带上 `broken: true` 与原因 ——
 * 静默跳过它的症状是「我明明存过这个视图」，而那是用户唯一能给出的证据。
 * 这与 `readSignalCategories`（产品线信号）同一个形状：坏数据要看得见。
 */

import { nowIso } from './db.js'
import { DEFAULT_WORKSPACE_ID } from '../domain/context/scope.js'
import { resolveAsinColumns } from '../domain/asin/table.js'

/** 视图名的上限。够长，但挡住「整段话当名字」——那会让选择框变成一个段落。 */
export const ASIN_VIEW_NAME_MAX = 80

function workspaceKey(workspaceId) {
  const key = String(workspaceId ?? '').trim()
  return key === '' ? DEFAULT_WORKSPACE_ID : key
}

/** 一个 JSON 文本 → 对象。解析失败或不是对象时返回 null（**不抛**：坏数据要看得见，不是炸页面）。 */
function readObject(text) {
  if (text === null || text === undefined) return null
  try {
    const parsed = JSON.parse(String(text))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 一个 JSON 文本 → 数组。同上。 */
function readArray(text) {
  if (text === null || text === undefined) return null
  try {
    const parsed = JSON.parse(String(text))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 一行 → 视图的读视图。
 *
 * `broken` 与 `brokenReason` 是这一层最要紧的两个字段：库里的 JSON 坏了的时候，
 * 一个安静地少掉列、少掉筛选的视图比一个报错的视图危险得多 —— 用户会以为自己
 * 存的那一组条件生效了，而实际上页面在按「全部」查。
 */
function asinSavedViewRow(row) {
  const filters = readObject(row.filters_json)
  const columns = readArray(row.columns_json)
  const reasons = []
  if (filters === null) reasons.push('filters_json 不是 JSON 对象')
  if (columns === null) reasons.push('columns_json 不是 JSON 数组')
  /* 认不出的列 id 也要报：它多半是「某一列被改名了」，而用户看到的症状是
     「这个视图少了几列」—— 说清是哪几个 id，比让他自己数有用。 */
  const resolved = resolveAsinColumns(columns ?? [])
  if (resolved.unknown.length > 0) reasons.push(`认不出的列 id: ${resolved.unknown.join(', ')}`)

  return {
    name: String(row.name),
    workspaceId: String(row.workspace_id),
    filters: filters ?? {},
    /* 列配置一律过一遍收敛：库里存着 17 个 id 而目录只剩 15 个时，
       页面拿到的是**能画的那几个**，而不是照着 17 个画出一堆空格子。 */
    columns: resolved.ids,
    requestedColumns: columns ?? [],
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    broken: reasons.length > 0,
    brokenReason: reasons.length === 0 ? null : reasons.join('；'),
  }
}

/**
 * 这个空间里的全部视图，最近改的在前。
 *
 * 排序在 SQL 里而不是调用方：两个读者（工具与页面）各排一次就是两份顺序，
 * 而「最近改的在最上面」正是这个列表被用起来的原因。
 */
export function listAsinSavedViews(store, { workspaceId = null } = {}) {
  const key = workspaceKey(workspaceId)
  return store.all(
    `SELECT * FROM asin_saved_view WHERE workspace_id = ? ORDER BY updated_at DESC, name ASC`,
    [key],
  ).map(asinSavedViewRow)
}

/** 一个视图，或 `undefined`。`undefined` 与「名字空」是两件事，调用方按前者分支。 */
function getAsinSavedView(store, { name, workspaceId = null } = {}) {
  const wanted = String(name ?? '').trim()
  if (wanted === '') return undefined
  const row = store.get(
    'SELECT * FROM asin_saved_view WHERE workspace_id = ? AND name = ?',
    [workspaceKey(workspaceId), wanted],
  )
  return row === undefined ? undefined : asinSavedViewRow(row)
}

/**
 * 存一个视图（同名覆盖）。
 *
 * 三件事写在这里，而不是让每个调用方各做一遍：
 *   · **名字必填、去空白、有上限** —— 一个空白名字在选择框里是一行看不见的选项，
 *     而它确实可点；
 *   · **列配置先过 `resolveAsinColumns` 再落库** —— 存进去的就是画得出来的，
 *     而不是「存的时候合法、读的时候认不出」；
 *   · **`created_at` 不被覆盖** —— 覆盖同名视图是「改」不是「重建」，
 *     把创建时间一起刷掉会让「这个视图什么时候建的」永远等于「最后改的」。
 *
 * `note` 的三态与 `upsertProductLine` 的 note 同一条规矩：`undefined` = 没提这件事
 * （保留原值）、`null` = 明确清空、字符串 = 写它。用 `??` 会把「清空」读成「保留」。
 */
export function saveAsinSavedView(store, {
  name, filters = {}, columns = [], note, workspaceId = null,
} = {}) {
  const wanted = String(name ?? '').trim()
  if (wanted === '') throw new Error('视图名不能为空')
  if (wanted.length > ASIN_VIEW_NAME_MAX) {
    throw new Error(`视图名最长 ${ASIN_VIEW_NAME_MAX} 个字符，收到 ${wanted.length} 个`)
  }
  if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new Error('filters 必须是一个对象（筛选键值）')
  }
  if (!Array.isArray(columns)) throw new Error('columns 必须是列 id 的数组')

  const key = workspaceKey(workspaceId)
  const resolved = resolveAsinColumns(columns)
  const now = nowIso()
  const filtersJson = JSON.stringify(filters)
  const columnsJson = JSON.stringify(resolved.ids)

  return store.tx(() => {
    const before = store.get(
      'SELECT name, created_at, note FROM asin_saved_view WHERE workspace_id = ? AND name = ?',
      [key, wanted],
    )
    const created = before === undefined

    store.run(
      `INSERT INTO asin_saved_view (workspace_id, name, filters_json, columns_json, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, name) DO UPDATE SET
         filters_json = excluded.filters_json,
         columns_json = excluded.columns_json,
         note = excluded.note,
         updated_at = excluded.updated_at`,
      [
        key,
        wanted,
        filtersJson,
        columnsJson,
        note === undefined ? (before?.note ?? null) : (note === null ? null : String(note)),
        created ? now : String(before.created_at),
        now,
      ],
    )

    return {
      created,
      /* 认不出的列 id **不落库**，但要报给调用方 —— 否则用户勾了一列、
         存下来、再打开发现没有它，而没有任何东西说过为什么。 */
      droppedColumns: resolved.unknown,
      view: getAsinSavedView(store, { name: wanted, workspaceId: key }),
    }
  })
}

/**
 * 删一个视图。返回**被删掉的那一个**，或 `undefined`。
 *
 * 返回整行而不是一个布尔：调用方要能说「删掉了『只看竞品』」，而不只是
 * 「删掉了 1 行」—— 后者在删错的时候也一样成功。`undefined` 是「本来就没有」，
 * 与「删掉了」是两句不同的话（路由据此回 404 而不是 200）。
 */
export function deleteAsinSavedView(store, { name, workspaceId = null } = {}) {
  const wanted = String(name ?? '').trim()
  if (wanted === '') return undefined
  const key = workspaceKey(workspaceId)
  return store.tx(() => {
    const before = getAsinSavedView(store, { name: wanted, workspaceId: key })
    if (before === undefined) return undefined
    store.run('DELETE FROM asin_saved_view WHERE workspace_id = ? AND name = ?', [key, wanted])
    return before
  })
}

/**
 * ASIN 保存视图的工具（模块 05 F05-01）。
 *
 *   amzn_asin_view_list    read  — 这个空间里存了哪些视图（筛选 + 列配置）
 *   amzn_asin_view_save    write — 存一个视图（同名覆盖）
 *   amzn_asin_view_delete  write — 删一个视图
 *
 * ## 为什么不是三个 `amzn_asin_view_*` 塞进 asin.js
 *
 * `asin.js` 已经是一个八百多行的文件，管着导入、查询、详情、字段修正、变体、归档。
 * 保存视图是一块**自成一体的状态**（它读写一张自己的表，不与 ASIN 数据本身发生关系），
 * 所以它有自己的文件 —— 与 `kw-ownership.js` / `kw-plan.js` 同一个分法。
 *
 * ## 为什么 `_list` 也在这里，而不是并进 `amzn_asin_query`
 *
 * 查询工具回答「库里有什么 ASIN」，这个回答「我存过哪几种看库的方式」。
 * 合成一个工具，就是让「想不起视图名」的人必须先查一遍 ASIN 表才知道自己存过什么 ——
 * 而视图的意义正是**在查之前**就知道要看什么。
 *
 * ## 写入口与页面共用同一对函数
 *
 * 三个工具与页面的两条写路由都调 `store/asin-view.js` 的那一对。两条路径各写一遍
 * 「同名怎么办」「什么算合法视图名」，就是两份实现，而它们漂开时两边都不报错。
 */

import {
  ASIN_VIEW_NAME_MAX, deleteAsinSavedView, listAsinSavedViews, saveAsinSavedView,
} from '../store/asin-view.js'
import { ASIN_COLUMNS, resolveAsinColumns } from '../domain/asin/table.js'
import { scopeWorkspaceIdOf } from '../domain/context/scope.js'
import { workspaceWriteRefusal } from '../store/workspace.js'
import { table, text, truncate } from './render.js'

/** 视图里那组筛选，印成一行。空对象是「没有筛选」——与「筛选读不出来」不是一件事。 */
function describeFilters(filters) {
  const entries = Object.entries(filters ?? {})
    .filter(([, value]) => value !== null && value !== undefined && String(value) !== '')
  if (entries.length === 0) return '（无筛选 = 全部）'
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(' · ')
}

/** 列配置印成「N 列」，并把没有来源的那几列点名 —— 它们不因为是视图就变成有来源。 */
function describeColumns(ids) {
  const resolved = resolveAsinColumns(ids)
  const without = ASIN_COLUMNS.filter(column => column.hasSource === false && resolved.ids.includes(column.id))
  return `${resolved.ids.length} 列`
    + (without.length === 0 ? '' : `（其中 ${without.map(column => column.label).join('、')} 本仓没有来源）`)
}

export function asinViewListTool({ store, workbench }) {
  return {
    name: 'amzn_asin_view_list',
    description:
      'List the saved ASIN-table views in this workspace: each one is a saved set of filters plus a column '
      + 'configuration, not a saved result — loading one re-runs the query. Read-only. '
      + 'Use it before amzn_asin_query when the user says "the view I saved" and you do not know its name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Show just this one view, in full (filters and column ids).' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const wanted = args?.name === undefined ? null : String(args.name).trim()
      const all = listAsinSavedViews(store, { workspaceId: scopeWorkspaceIdOf(workbench) })
      const views = wanted === null || wanted === '' ? all : all.filter(view => view.name === wanted)

      if (views.length === 0) {
        const head = wanted === null || wanted === ''
          ? '这个工作空间里还没有保存视图。'
          : `没有叫「${wanted}」的视图。`
        const known = all.length === 0 ? '（一个都没有）' : all.map(view => view.name).join('、')
        return [
          head,
          `已存视图: ${known}`,
          '存一个用 amzn_asin_view_save（filters + columns）。视图只存筛选与列配置，'
            + '不存结果 —— 加载它等于把这两样交回查询。',
        ].join('\n')
      }

      const lines = [`保存视图 (${views.length}${wanted === null || wanted === '' ? `/${all.length}` : ''}):`]
      lines.push(table(views, [
        { label: '名称', value: row => row.name },
        { label: '筛选', value: row => truncate(describeFilters(row.filters), 46) },
        { label: '列', value: row => describeColumns(row.columns) },
        { label: '备注', value: row => truncate(row.note ?? '', 24) },
        { label: '最近修改', value: row => row.updatedAt },
        /* 库里的 JSON 坏了的时候**照样列出来**并标出来。静默跳过它的症状是
           「我明明存过这个视图」，而那是用户唯一能给出的证据。 */
        { label: '状态', value: row => (row.broken ? `⚠️ ${row.brokenReason}` : '正常') },
      ]))

      if (wanted !== null && wanted !== '' && views.length === 1) {
        lines.push('')
        lines.push(`filters: ${JSON.stringify(views[0].filters)}`)
        lines.push(`columns: ${views[0].columns.join(', ')}`)
        if (views[0].requestedColumns.length !== views[0].columns.length) {
          lines.push(`（存的是 ${views[0].requestedColumns.length} 个 id，能画的是 ${views[0].columns.length} 个）`)
        }
      }
      return lines.join('\n')
    },
  }
}

export function asinViewSaveTool({ store, workbench }) {
  return {
    name: 'amzn_asin_view_save',
    description:
      'Save (or overwrite) a named ASIN-table view: a set of filters plus a column configuration. '
      + 'The same name in the same workspace overwrites — that is what "save this view again" means. '
      + 'filters takes the same keys amzn_asin_query takes (marketplace / productLineId / brand / q / order). '
      + 'columns is a list of column ids; omit it to keep all 17. Unknown column ids are dropped and reported, '
      + 'never stored. Nothing about the ASIN data is written — this only stores the view definition.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `View name, unique per workspace, max ${ASIN_VIEW_NAME_MAX} characters.` },
        filters: {
          type: 'object',
          description: 'The filter bag to save. Same keys amzn_asin_query accepts.',
          properties: {
            marketplace: { type: 'string', description: 'Marketplace code, e.g. US / DE.' },
            productLineId: { type: 'string', description: 'One product line id.' },
            brand: { type: 'string', description: 'Exact brand match.' },
            q: { type: 'string', description: 'Substring over ASIN / title / brand.' },
            order: { type: 'string', description: 'updated | bsr | reviews | asin' },
          },
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: `Visible column ids. Omit for all ${ASIN_COLUMNS.length}.`,
        },
        note: { type: 'string', description: 'What this view is looking at. Omit to keep the stored note; null clears it.' },
      },
      required: ['name'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const scopeId = scopeWorkspaceIdOf(workbench)
        /* 归档即只读（F02-01）。视图落在**当前空间**，所以这条判据查的就是这个空间 ——
           与产品线那条不同（那边的空间来自被写的那一行）。 */
        const refusal = workspaceWriteRefusal(store, scopeId, scopeId)
        if (refusal !== null) return refusal

        const result = saveAsinSavedView(store, {
          name: args?.name,
          filters: args?.filters ?? {},
          columns: args?.columns === undefined ? ASIN_COLUMNS.map(column => column.id) : args.columns,
          note: args?.note,
          workspaceId: scopeId,
        })

        const view = result.view
        const lines = [
          `${result.created ? '新增' : '更新'}视图「${view.name}」：`
            + `筛选 ${describeFilters(view.filters)}，${describeColumns(view.columns)}`,
        ]
        if (result.droppedColumns.length > 0) {
          lines.push(`⚠️ 认不出的列 id 没有存进去: ${result.droppedColumns.join(', ')}`
            + `（可用的是: ${ASIN_COLUMNS.map(column => column.id).join(', ')}）`)
        }
        lines.push('视图只存筛选与列配置，不存结果 —— 加载它时查询照常发生。')
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

export function asinViewDeleteTool({ store, workbench }) {
  return {
    name: 'amzn_asin_view_delete',
    description:
      'Delete a saved ASIN-table view by name. Returns the view that was deleted. '
      + 'A name that was never saved is reported as such rather than as a success — '
      + '"I deleted it" and "there was nothing to delete" are different answers.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'View name to delete.' },
      },
      required: ['name'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const scopeId = scopeWorkspaceIdOf(workbench)
        const refusal = workspaceWriteRefusal(store, scopeId, scopeId)
        if (refusal !== null) return refusal

        const removed = deleteAsinSavedView(store, { name: args?.name, workspaceId: scopeId })
        if (removed === undefined) {
          const known = listAsinSavedViews(store, { workspaceId: scopeId }).map(view => view.name)
          return [
            `没有叫「${String(args?.name ?? '').trim()}」的视图，什么都没删。`,
            `已存视图: ${known.length === 0 ? '（一个都没有）' : known.join('、')}`,
          ].join('\n')
        }
        return `已删除视图「${removed.name}」（筛选 ${describeFilters(removed.filters)}，`
          + `${describeColumns(removed.columns)}）。ASIN 数据一行都没动 —— 删的是「怎么看」，不是「看到了什么」。`
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

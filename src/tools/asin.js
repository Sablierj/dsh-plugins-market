/**
 * ASIN tools — the first vertical slice, and the one that proves the whole chain
 * (store → tool → agent → page) end to end.
 *
 * The read tools are deliberately plain: query with filters, fetch one with its
 * history. The write tool is the only way data enters the library before
 * collection exists, which makes it both the import path and the thing that
 * makes the plugin useful on day one — you can paste a spreadsheet's worth of
 * ASINs in and immediately have something to look at.
 */

import { getAsin, queryAsins, upsertAsin, upsertSnapshot } from '../store/queries.js'
import { adoptCompetitor, competitorFamilies, discoverCompetitors, familyCompetitorRow, familyCompetitorsFor, listCompetitors, retireCompetitor, upsertCompetitor } from '../store/asin-competitor.js'
import { arrayTable, num, table, text, truncate } from './render.js'
/* S1-B17.1: the 覆盖字段 gate, asked by the write itself. */
import { approvalRefusal } from '../domain/approval/policy.js'
/* 模块 05 第一子批：详情（F05-02 的前四个标签页）、字段级事实（F05-03）、
   父子变体关系（F05-06 的数据层）、归档与恢复（F05-08 的数据层）。 */
import { ASIN_DETAIL_TABS, buildAsinDetail } from '../domain/asin/detail.js'
/* The one wording for a section row that was not read because the read hit its
   row cap. Imported rather than typed here: the page prints the same row, and two
   spellings of one fact is how the tool and the page end up disagreeing about the
   same data with nothing failing. */
import {
  SECTION_CONTENT_UNREAD_LABEL, SECTION_READ_TRUNCATED_LABEL, sectionContentUnread,
} from '../domain/asin/sections.js'
import { correctAsinField } from '../store/asin.js'
import { archiveAsin, archiveImpact, archivedAsinCount, assertAsinWritable, deleteAsin, listArchiveEvents, restoreAsin } from '../store/archive.js'
import { asinReferenceReport } from '../domain/asin/archive-refs.js'
import { correctVariantRelation, upsertVariantDimension, upsertVariantRelation } from '../store/variant.js'
/* F05-01：17 列的目录、逐格文本、导出序列化，以及单元格在**文本读者**眼里的说法。
   全部来自 domain/asin/table.js —— 页面、工具、导出三处印一行用的是同一份实现。 */
import {
  ASIN_COLUMNS, asinCellDisplay, asinColumnsFor, asinTableCsv, asinTableMarkdown, resolveAsinColumns,
} from '../domain/asin/table.js'

/**
 * 「全库已归档 N 条」的一句话，给会话侧的列表读用。
 *
 * `null`（读不出来）与 `0`（一条都没有）在这里就分开印：合成一句「已归档 0 条」，
 * 读失败的库看起来就像一个干净的库。而这一行是**全库**口径 —— 它不随调用方给的
 * 筛选变，所以必须自己说明这一点，否则「筛选出 0 条 + 已归档 3 条」会被读成矛盾。
 */
function archivedSummaryLine(store) {
  const count = archivedAsinCount(store)
  return count === null
    ? '全库已归档: 读不出来（这一列读失败或库没升到位）—— 与「一条都没归档」不是一件事'
    : `全库已归档: ${count} 条（全库口径，不随上面的筛选变；归档是隐藏，不是删除）`
}

/**
 * `queryAsins` 对**认不出的 `archived` 值**是抛的（`ASIN_ARCHIVED_FILTER`，见
 * `normalizeArchivedFilter` 的注释：一个认不出的筛选值会改变整个结果集，不能静默退回
 * 默认）。工具不抛错是硬约束，所以这里把**那一类**错误转成返回值；别的错误照旧抛出去
 * —— 把「参数写错了」与「库读不出来」合成一个 `ok:false` 会让后者失去它的紧急性。
 */
function queryAsinsOrRefusal(store, filters) {
  try {
    return { result: queryAsins(store, filters), refusal: null }
  } catch (error) {
    if (error?.code !== 'ASIN_ARCHIVED_FILTER') throw error
    return { result: null, refusal: { ok: false, code: error.code, error: error.message } }
  }
}

/**
 * 「这一次的列表隐藏了多少条已归档的」+「怎么把它们列出来」。
 *
 * ★ 这一行是**读回对账**的入口：`archivedSummaryLine` 会报「全库已归档 N 条」，
 * 而 N 在 v46 之前**没有任何一条查询能列出来** —— 数字被声称、集合不可验证。
 * 所以只要这一次真的挡掉了东西，就说清挡了几条、以及把集合取出来要传什么。
 * 一条都没挡（`only` / `all`，或库里本来就没有归档的）时**不印这一行**：
 * 「这次没隐藏」与「隐藏了 0 条」不需要各说一句。
 */
function archivedHiddenLine(result) {
  if (result?.archived !== 'hide' || !(result.archivedHidden > 0)) return null
  return `本次列表按「在架」口径隐藏了 ${result.archivedHidden} 条已归档的 ASIN`
    + `（全库共 ${result.archivedTotal ?? '读不出来'} 条）—— 传 archived:"only" 可以把它们列出来，`
    + '或 archived:"all" 看全部。'
}

/**
 * 「这一批里有已归档的坐标吗」—— 归档即只读，在**工具层**的写口上拦。
 *
 * ## 为什么拦在工具层，而不是 `upsertAsin` 里
 *
 * `upsertAsin`（`store/queries.js`）是八十几条路径与**后台采集 worker** 共用的写口。
 * 在那里加闸门会让 worker 自己在归档的 ASIN 上失败，把一次用户动作变成一次后台任务的
 * 静默停摆 —— 而 worker 该不该写归档的 ASIN 是另一件事（它写的是采集结果，
 * 不是用户「现在要改这条记录」）。所以闸门在**面向用户的工具**上，范围明说：
 * 直连 `upsertAsin` 的路径**不受本批约束**，测试里有一条现状断言盯着这一点。
 *
 * ## 逐条检查，而不是只报第一条
 *
 * 一个批次里混着一条已归档的，报出来的必须是**那几条**。只报第一条的话，用户照着它
 * 恢复、再调一次，还是被同一条（下一条）挡住，而每一次都只说一个 —— 三次往返换一次成功。
 *
 * `mustExist: false`：这个工具**能新建**。一条不在库里的 ASIN 是正常的新建，不是错误；
 * 只有「坐标存在且已归档」才拒绝。
 */
function archivedWriteRefusal(store, records, defaultMarketplace, action) {
  const blocked = []
  for (const record of records) {
    const asin = String(record?.asin ?? '').trim().toUpperCase()
    if (asin === '') continue
    const marketplace = String(record?.marketplace ?? defaultMarketplace ?? 'US').toUpperCase()
    try {
      assertAsinWritable(store, { asin, marketplace, action, mustExist: false })
    } catch (error) {
      if (error?.code !== 'ASIN_ARCHIVED') throw error
      blocked.push(`${asin}@${marketplace}`)
    }
  }
  return blocked.length === 0
    ? null
    : {
      ok: false,
      code: 'ASIN_ARCHIVED',
      blocked,
      error: `这些坐标已归档，是只读的，${action} 被拒绝：${blocked.join('、')}。`
        + '先 amzn_asin_archive(action:"restore") 恢复再改 —— 归档是隐藏，不是删除，数据一个字节没动。',
    }
}

/** 「有排名/总数」，或 `—`（一个词都没跟踪时 0/0 不是一个比率）。 */
function keywordCoverageText(row) {
  if (row.keyword_count === null || row.keyword_count === undefined || row.keyword_count === 0) return '—'
  return `${row.keyword_ranked ?? 0}/${row.keyword_count}`
}

/**
 * 17 列在**会话里**的说法。一列一个取法，与页面 `renderAsinCell` 的 switch 一一对应 ——
 * 两处读的都是 `projectAsinRow` 的同一批键，所以不可能一个说「有值」另一个说「没有值」。
 *
 * 取原始值再交给 `asinCellDisplay`（而不是在取值时就把中文拼好）：`asinCellDisplay`
 * 是「认得出的翻译、认不出的照印」的唯一实现，页面也用它，所以 `fresh` 在会话里
 * 是「新鲜」、在导出里是 `fresh`，而这两种说法的分界只在这里决定一次。
 */
function asinRowValue(columnId, row) {
  switch (columnId) {
    case 'product_line':
      if (row.product_line === null || row.product_line === undefined) return null
      return row.product_line_name === null || row.product_line_name === undefined
        ? String(row.product_line)
        : `${row.product_line_name}（${row.product_line}）`
    case 'asin':
      return row.archived === true ? `${row.asin}（已归档）` : row.asin
    default:
      return row[columnId]
  }
}

/** 一行的 17 列文本。工具与页面各印一份布局，但**取值与措辞**都走上面那两个函数。 */
function asinRowCells(row) {
  return ASIN_COLUMNS.map(column => asinCellDisplay(column.id, asinRowValue(column.id, row)))
}

export function asinQueryTool({ store }) {
  return {
    name: 'amzn_asin_query',
    description:
      'Query the ASIN library. Returns one row per (ASIN, marketplace) with its keyword coverage. '
      + 'Use it to answer "what do we have", to find products by brand or product line, '
      + 'to find which ASINs have keyword gaps, and to get the concrete ASIN list behind a count. '
      + `Rows carry F05-01's ${ASIN_COLUMNS.length} columns, including the ones with no source in this repo — `
      + 'those print 「本仓没有来源」 rather than a blank, so "we never modelled this column" is never read as "0". '
      + 'If the user is pointing at the workbench page, call amzn_workbench_context first.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US / DE / JP. Omit for all.' },
        productLineId: { type: 'string', description: 'Restrict to one product line id.' },
        brand: { type: 'string', description: 'Exact brand match.' },
        q: { type: 'string', description: 'Substring match over ASIN, title, and brand.' },
        order: { type: 'string', description: 'updated (default) | bsr | reviews | asin' },
        archived: {
          type: 'string',
          enum: ['hide', 'only', 'all'],
          description:
            'Which archiving state to include. all (default) = on-shelf and archived together — archived rows are marked '
            + '（已归档）rather than dropped, because a row that vanishes reads as data loss. hide = only the ASINs on the '
            + 'shelf; only = only the archived ones. Use archived:"only" to get the concrete set behind the '
            + '「全库已归档 N 条」 line — that count is a library-wide fact and this is how you list what it counts.',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: `Which of the ${ASIN_COLUMNS.length} column ids to print. Omit for all of them.`,
        },
        limit: { type: 'number', description: 'Rows to return. Default 50, max 500.' },
        offset: { type: 'number', description: 'Rows to skip, for paging. Default 0.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const { result, refusal } = queryAsinsOrRefusal(store, args ?? {})
      if (refusal !== null) return refusal
      /* 归档总数两处都印（有行时与一行都没有时）：它是**库**的一个事实，不是这次查询的
         结果集的一部分，所以它不跟着结果集消失。 */
      const archivedLine = archivedSummaryLine(store)
      const hiddenLine = archivedHiddenLine(result)
      if (result.rows.length === 0) {
        return [
          `没有匹配的 ASIN（库内共 ${result.total} 条符合条件的记录）。`,
          archivedLine,
          ...(hiddenLine === null ? [] : [hiddenLine]),
          '库为空时用 amzn_asin_upsert 导入，或先确认采集通道：amzn_source_list。',
        ].join('\n')
      }

      /* 列配置由 `resolveAsinColumns` 收敛（认不出的 id 丢掉并报出来），
         与页面读 `filters.asinCols` 用的是同一个函数 —— 所以「会话里要的列」
         与「页面上勾的列」不可能有两套解释。 */
      const resolved = resolveAsinColumns(args?.columns)
      const columns = asinColumnsFor(resolved.ids)

      const lines = [
        `ASIN (${result.rows.length}/${result.total} 条，offset=${result.offset}，${columns.length} 列):`,
        table(result.rows, columns.map(column => ({
          label: column.label,
          value: row => asinCellDisplay(column.id, asinRowValue(column.id, row)),
        }))),
      ]
      if (resolved.unknown.length > 0) {
        lines.push(`⚠️ 认不出的列 id 没有印: ${resolved.unknown.join(', ')}`
          + `（可用的是: ${ASIN_COLUMNS.map(column => column.id).join(', ')}）`)
      }
      /* 「本仓没有来源」的那几列，**在表下面再说一遍**：一张 17 列的表里，
         某一列每一行都印着同一句话，容易被读成这一列全是那个值。
         说清它是**列**的性质，而不是这一批行的性质。 */
      const without = columns.filter(column => column.hasSource === false)
      if (without.length > 0) {
        lines.push(`⚠️ 上面 ${without.length} 列本仓没有来源（不是这一行没有值）：`
          + without.map(column => `${column.label}（${column.note}）`).join('；'))
      }
      lines.push(archivedLine)
      if (hiddenLine !== null) lines.push(hiddenLine)
      return lines.join('\n')
    },
  }
}

/**
 * F05-01 的导出：把当前这一屏的筛选结果落成 CSV（或 Markdown）文本。
 *
 * ## 为什么返回文本而不是写文件
 *
 * `amzn_kw_export` 写文件，因为它一次产四份、每份都有固定的用途与文件名。
 * 这张表不一样：它导出的是**用户此刻正在看的那一屏**（可能是一组筛选后的 37 行），
 * 而「写到哪个目录、叫什么名字」是会话里那个人当场决定的事 —— 工具替它决定，
 * 就会在磁盘上留下一个没人认领的文件。返回文本，由 agent 交给用户或写进它自己选的位置。
 *
 * ## 为什么默认 CSV
 *
 * 见 `domain/asin/table.js` 的文件头：17 列的中文表名在 Markdown 里读不出列，
 * 而**三种空**（`—` / `0` / 「本仓没有来源」）只有在 CSV 的单元格里才分得开。
 * Markdown 仍然给得出来（`format: 'markdown'`），因为粘进对话里让 agent 看一屏
 * 是它的正当用途 —— 它不是 CSV 的降级品，是另一个读者。
 *
 * ## 列配置与查询共用一份收敛
 *
 * `columns` 走 `resolveAsinColumns`，与页面勾选、与 `amzn_asin_query` 是同一个函数。
 * 导出**不是**「按页面当前的列导出」的第二个实现 —— 页面下载走的是同一个
 * `asinTableCsv`，只是它把结果交给浏览器而不是交给会话。
 */
export function asinExportTool({ store }) {
  return {
    name: 'amzn_asin_export',
    description:
      'Export the ASIN table as text: CSV (default) or Markdown. Takes the same filters as amzn_asin_query '
      + `and returns F05-01's ${ASIN_COLUMNS.length} columns by default. CSV carries a UTF-8 BOM and is the format to `
      + 'write to a .csv file for Excel / 飞书表格; Markdown is for pasting into a conversation. '
      + 'Columns with no source in this repo print 「本仓没有来源」 — never a blank and never a 0. '
      + 'Read-only: nothing is written to the database or to disk.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'csv (default) | markdown' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US / DE / JP. Omit for all.' },
        productLineId: { type: 'string', description: 'Restrict to one product line id.' },
        brand: { type: 'string', description: 'Exact brand match.' },
        q: { type: 'string', description: 'Substring match over ASIN, title, and brand.' },
        order: { type: 'string', description: 'updated (default) | bsr | reviews | asin' },
        archived: {
          type: 'string',
          enum: ['hide', 'only', 'all'],
          description:
            'Same three states as amzn_asin_query. all (default) exports both; hide exports only the ASINs on the shelf; '
            + 'only exports exactly the archived ones.',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: `Which of the ${ASIN_COLUMNS.length} column ids to export. Omit for all of them.`,
        },
        limit: { type: 'number', description: 'Rows to export. Default 200, max 500.' },
        offset: { type: 'number', description: 'Rows to skip. Default 0.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const format = String(args?.format ?? 'csv').trim().toLowerCase()
      if (format !== 'csv' && format !== 'markdown') {
        return { ok: false, error: `format 只能是 csv 或 markdown，收到「${format}」` }
      }

      const limit = Math.min(Math.max(Number(args?.limit) || 200, 1), 500)
      const { result, refusal } = queryAsinsOrRefusal(store, { ...(args ?? {}), limit })
      if (refusal !== null) return refusal
      const hiddenLine = archivedHiddenLine(result)
      const resolved = resolveAsinColumns(args?.columns)
      const columns = asinColumnsFor(resolved.ids)

      if (result.rows.length === 0) {
        return [
          `没有匹配的 ASIN（库内共 ${result.total} 条符合条件的记录），没有可导出的行。`,
          /* 「筛选后为空」与「库是空的」是两句话 —— 导出为空时最容易把它们合成一句，
             而它们的修法完全不同（一个是改筛选，一个是先导入）。 */
          archivedSummaryLine(store),
          ...(hiddenLine === null ? [] : [hiddenLine]),
        ].join('\n')
      }

      const body = format === 'csv'
        ? asinTableCsv(columns, result.rows)
        : asinTableMarkdown(columns, result.rows)

      const lines = [
        `ASIN 导出 (${format}，${result.rows.length}/${result.total} 行，${columns.length} 列`
          + `，limit=${limit}${result.rows.length < result.total ? '，**只导出了前一部分**' : ''}):`,
        body,
      ]
      /* 认不出的列 id 报出来，与 `amzn_asin_query` 同一句话：静默丢掉的话，
         用户按一份保存视图导出、发现少了一列，而没有任何东西说为什么。 */
      if (resolved.unknown.length > 0) {
        lines.push(`⚠️ 认不出的列 id 没有导出: ${resolved.unknown.join(', ')}`
          + `（可用的是: ${ASIN_COLUMNS.map(column => column.id).join(', ')}）`)
      }
      /* 「没有来源」的那几列在 CSV 里每一行都印同一句话，容易被读成这一列全是那个值 ——
         说清它是**列**的性质。Markdown 那一支已经把它写在表下面了，所以这里只管 CSV。 */
      const without = columns.filter(column => column.hasSource === false)
      if (without.length > 0 && format === 'csv') {
        lines.push(`⚠️ 上面 ${without.length} 列本仓没有来源（不是这一行没有值）：`
          + without.map(column => `${column.label}（${column.note}）`).join('；'))
      }
      /* 导出与查询**同一句话**：一次导出少了几行，必须说得出那是「按在架口径隐藏的
         已归档行」，而不是让读者以为库里只有这么些。 */
      if (hiddenLine !== null) lines.push(hiddenLine)
      return lines.join('\n')
    },
  }
}

export function asinGetTool({ store }) {
  return {
    name: 'amzn_asin_get',
    description:
      'Fetch one ASIN in full: current field values, where each field came from, every raw collection snapshot, '
      + 'its keyword coverage, and its current listing. '
      + 'Use it before optimising an ASIN or whenever the user asks about provenance ("where did this BSR come from").',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
      },
      required: ['asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const asin = String(args?.asin ?? '').trim().toUpperCase()
      const marketplace = String(args?.marketplace ?? 'US').trim().toUpperCase()
      const found = getAsin(store, asin, marketplace)
      if (found === undefined) {
        return `${asin} (${marketplace}) 不在库内。用 amzn_asin_upsert 导入，或先用 amzn_source_list 确认哪个源能采。`
      }

      const { row, snapshots, provenance, keywords, listing } = found
      const lines = [
        `${row.asin} · ${row.marketplace}`,
        `标题: ${row.title ?? '—'}`,
        `品牌: ${row.brand ?? '—'}    价格: ${row.price ?? '—'} ${row.currency ?? ''}    BSR: ${row.bsr ?? '—'}    类目: ${row.category ?? '—'}`,
        `评分: ${row.rating ?? '—'}    评论数: ${row.reviews ?? '—'}`,
        `首次见到: ${row.first_seen_at}    最后更新: ${row.updated_at}    整体主源: ${row.primary_source_id ?? '—'}`,
      ]

      if (provenance.length > 0) {
        lines.push('', `字段来源 (${provenance.length}):`)
        lines.push(table(provenance, [
          { label: '字段', value: item => item.field },
          { label: '来源', value: item => item.source_id },
          { label: '值', value: item => truncate(item.value, 32) },
          { label: '置信', value: item => item.confidence },
          { label: '更新', value: item => item.updated_at },
        ]))
      }

      if (snapshots.length > 0) {
        lines.push('', `采集快照 (最近 ${snapshots.length} 次):`)
        lines.push(snapshots
          .map(item => `- ${item.collected_at}  ${item.source_id}  ${truncate(item.payload_json, 90)}`)
          .join('\n'))
      }

      if (keywords.length > 0) {
        const gaps = keywords.filter(item => item.rank === null)
        lines.push('', `关键词 (${keywords.length} 条，其中未覆盖 ${gaps.length} 条):`)
        lines.push(table(keywords.slice(0, 30), [
          { label: '关键词', value: item => truncate(item.keyword, 30) },
          { label: '排名', value: item => (item.rank === null ? '未覆盖' : item.rank) },
          { label: '搜索量', value: item => num(item.search_volume) },
          { label: '来源', value: item => item.source_id },
        ]))
        lines.push('搜索量口径：这里是 asin_keyword 的测量快照（这个 ASIN 采到时记下的值）；'
          + '关键词总库 kw_master 的当前搜索量用 amzn_kw_query / amzn_keyword_detail 查 —— 两者可能不同。')
      }

      if (listing !== undefined) {
        lines.push('', `当前 listing (v${listing.version}, ${listing.updated_at}):`,
          `  标题: ${listing.title ?? '—'}`,
          `  五点: ${listing.bullets_json ? truncate(listing.bullets_json, 120) : '—'}`,
          `  描述: ${listing.description ? truncate(listing.description, 120) : '—'}`)
      } else {
        lines.push('', '当前 listing: 未记录')
      }

      return lines.join('\n')
    },
  }
}

/**
 * The fields whose value would be **replaced over a different, non-empty stored
 * value** by this record.
 *
 * The three ways to write to an ASIN are not the same act, and only one of them
 * is 「覆盖」:
 *
 *   - no row yet        → creating. Nothing is being replaced.
 *   - stored is empty   → filling in. Nothing is being lost.
 *   - same value        → a no-op that happens to be spelled as a write.
 *
 * Returning the list rather than a boolean is what lets the refusal name the
 * fields — 「会覆盖 标题、品牌」 is actionable, 「检测到覆盖」 is a puzzle.
 */
const OVERWRITE_FIELDS = ['title', 'brand', 'category', 'image_url', 'product_line_id', 'price', 'bsr', 'rating', 'reviews']

function nonEmpty(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value)
  return String(value).trim() !== ''
}

function overwrittenFields(store, record, defaultMarketplace) {
  const asin = String(record?.asin ?? '').trim().toUpperCase()
  if (asin === '') return []
  const marketplace = String(record?.marketplace ?? defaultMarketplace).trim().toUpperCase()
  const existing = store.get('SELECT * FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace])
  if (existing === undefined || existing === null) return []

  return OVERWRITE_FIELDS
    .filter(field => nonEmpty(record?.[field]) && nonEmpty(existing[field])
      && String(existing[field]) !== String(record[field]))
    .map(field => `${asin}/${marketplace} 的 ${field}`)
}

export function asinUpsertTool({ store }) {
  return {
    name: 'amzn_asin_upsert',
    description:
      'Insert or update ASINs in the library. This is how data gets in before collection is wired up, and how '
      + 'corrected values get written back. Omitted fields keep their previous value — passing a price does not blank a title. '
      + 'Always set sourceId so each field keeps its provenance. '
      + 'This writes to the database: confirm the exact rows with the user before calling it when the values came from a guess rather than from data.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Source id these values came from, e.g. browser-local or manual. Required for provenance.' },
        marketplace: { type: 'string', description: 'Default marketplace for rows that do not set one. Default US.' },
        records: {
          type: 'array',
          description: 'The ASINs to write.',
          items: {
            type: 'object',
            properties: {
              asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
              marketplace: { type: 'string', description: 'Marketplace code; overrides the default.' },
              title: { type: 'string' },
              brand: { type: 'string' },
              price: { type: 'number' },
              currency: { type: 'string' },
              bsr: { type: 'number' },
              category: { type: 'string' },
              rating: { type: 'number' },
              reviews: { type: 'number' },
              image_url: { type: 'string' },
              product_line_id: { type: 'string' },
            },
            required: ['asin'],
          },
        },
        rawSnapshot: { type: 'boolean', description: 'Also store the submitted records verbatim as a collection snapshot. Default false.' },
        confirm: {
          type: 'boolean',
          description:
            'Set true to confirm writing over an EXISTING, non-empty field value when this workspace has turned on '
            + 'the 覆盖字段 二次确认. Without it such a write is refused with code APPROVAL_REQUIRED and nothing is '
            + 'written. Creating a new row, filling an empty field, or re-writing the same value never needs it.',
        },
      },
      required: ['records'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const records = Array.isArray(args?.records) ? args.records : []
      if (records.length === 0) return { ok: false, error: 'records is empty' }

      const defaultMarketplace = String(args?.marketplace ?? 'US').toUpperCase()
      const sourceId = args?.sourceId ? String(args.sourceId) : null

      /* 归档闸门在**覆盖闸门之前**：它是硬拒绝（带 confirm 也过不去），而覆盖闸门是
         可确认的。先问可确认的那个，用户确认完才撞上硬拒绝 —— 一次白问。 */
      const archivedRefusal = archivedWriteRefusal(store, records, defaultMarketplace, '写入 ASIN')
      if (archivedRefusal !== null) return archivedRefusal

      /* 覆盖字段闸门。只在**真的覆盖**时问：新建不是覆盖，往空字段里填也不是，
         写下同一个值更不是。把这三件事也拦下来，这个闸门的名字就是假的 ——
         而一个名不副实的闸门，用户的第一反应是把它关掉。 */
      const overwrites = records.flatMap(record => overwrittenFields(store, record, defaultMarketplace))
      if (overwrites.length > 0) {
        const refusal = approvalRefusal(store, 'overwriteField', args?.confirm,
          '这些字段已经有非空值，这次写入会覆盖它们：' + overwrites.join('、')
          + '。确认无误就再调一次并带 confirm: true。')
        if (refusal !== null) return refusal
      }

      const created = []
      const updated = []
      const failed = []

      for (const record of records) {
        try {
          const result = upsertAsin(store, {
            ...record,
            marketplace: record.marketplace ?? defaultMarketplace,
            sourceId,
          })
          ;(result.created ? created : updated).push(`${result.asin}/${result.marketplace}`)
          if (args?.rawSnapshot === true && sourceId) {
            upsertSnapshot(store, {
              asin: result.asin,
              marketplace: result.marketplace,
              sourceId,
              payload: record,
            })
          }
        } catch (error) {
          failed.push(`${record?.asin ?? '(no asin)'}: ${error.message}`)
        }
      }

      return [
        `写入完成: 新增 ${created.length}，更新 ${updated.length}，失败 ${failed.length}`,
        created.length > 0 ? `新增: ${created.join(', ')}` : '',
        updated.length > 0 ? `更新: ${updated.join(', ')}` : '',
        failed.length > 0 ? `失败:\n${failed.map(line => `- ${line}`).join('\n')}` : '',
        sourceId ? '' : '⚠️ 未提供 sourceId，这些字段没有来源标记。',
      ].filter(Boolean).join('\n')
    },
  }
}

/* ── 模块 05 第一子批：详情 / 字段级事实 / 变体关系 / 归档 ─────────────────────
 *
 * 五个工具，对应 F05-02 的前四个标签页（读）、F05-03 的人工修正（写）、
 * F05-06 的关系与纠正（写两个）、F05-08 的归档与恢复（写一个）。
 *
 * 三条纪律，与既有工具一致：
 *   · **可预期的输入问题返回 `{ok:false, code, error}`，不抛**（抛会杀掉整个回合）；
 *   · **写工具返回结构化值**（`{ok, ...}` 而不是一句话）—— 审计漏斗的 `objectId`
 *     要从返回值里读，一句话的返回值会让审计行的 `object_id` 恒为 null；
 *   · **读工具是只读的**，在 `WRITE_TARGETS` 里显式登记为 `null`。
 */

/** 一行「有的东西」与「一共多少」：`3/10` 而不是 `30%`。 */
const ratio = (value, total) => `${value}/${total}`

/**
 * A capped read, said out loud — as lines to push next to the numbers it caps.
 *
 * This is the half that cannot be left out. `采过 3/13` and `采过 3/13` *when only
 * the first 5 000 rows were read* are the same sentence and only the second one is
 * true; printing the first one turns "we did not read it" into "nobody collected
 * it". The note itself is built by the store, next to the numbers, so two readers
 * cannot describe the same read two different ways.
 */
function coverageWarning(coverage) {
  if (coverage === null || coverage === undefined || coverage.truncated !== true) return []
  return [`⚠ ${coverage.note}`]
}

/** 时间戳到秒，不假装本地化。 */
function stamp(value) {
  const text = String(value ?? '')
  return text === '' ? '—' : text.replace('T', ' ').replace('Z', '').slice(0, 19)
}

/**
 * The legal `tab` values: the four built tabs **plus** `all`.
 *
 * Derived from the builder's own list instead of written out a second time. Same
 * reason the batch applies everywhere else: a hand-kept copy of a closed
 * vocabulary drifts, and this copy drifts in the worst direction — the tool
 * refuses a tab the page can draw, which reads as a broken detail view while the
 * server is perfectly fine. `all` is the only value added here, because it is a
 * request shape rather than a tab.
 */
const ASIN_DETAIL_TAB_VALUES = [...ASIN_DETAIL_TABS, 'all']

export function asinDetailTool({ store }) {
  return {
    name: 'amzn_asin_detail',
    description:
      'Read one ASIN the way the detail drawer does, all nine tabs: the overview (with every ratio showing its denominator), '
      + 'every Listing field with all of its sources / freshness / manual confirmation / change since the previous snapshot / '
      + 'downstream references, the thirteen collection sections, the parent-child variant family with its duplicates and '
      + 'contradictions, the keywords and their measured ranks, the reviews (and why Q&A has no source here), the competitor '
      + 'comparison, the optimization history, and the provenance / audit trail. '
      + 'Use it to answer "why is this value what it is" and "what is missing on this ASIN". '
      + 'Every tab also returns `unsourced[]`: the things this repository structurally cannot answer, each with the reason. '
      + 'Those are NOT empty results — never present them as an empty list or as 0.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        tab: {
          type: 'string',
          enum: [...ASIN_DETAIL_TAB_VALUES],
          description: 'Which slice(s) to return. Default all. The slices are all computed either way; this only trims the answer.',
        },
      },
      required: ['asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      const tab = String(args?.tab ?? 'all').trim()
      if (!ASIN_DETAIL_TAB_VALUES.includes(tab)) {
        return { ok: false, error: `tab must be one of ${ASIN_DETAIL_TAB_VALUES.join(' | ')} (got ${JSON.stringify(args?.tab)})` }
      }
      const detail = buildAsinDetail({ store, asin: args?.asin, marketplace: args?.marketplace ?? 'US' })
      if (detail.ok !== true) return { ...detail, tool: 'amzn_asin_detail' }

      const wanted = tab === 'all' ? detail.tabs : [tab]
      const value = {
        ok: true,
        asin: detail.asin,
        marketplace: detail.marketplace,
        tab,
        tabs: detail.tabs,
        tabLabels: detail.tabLabels,
        pendingTabs: detail.pendingTabs,
        archiveEvents: detail.archiveEvents,
      }
      for (const id of wanted) value[id] = detail[id]
      value.text = renderAsinDetailText(value, wanted)
      return value
    },
  }
}

/** The tool's own words: one compact block per requested tab. */
function renderAsinDetailText(value, wanted) {
  const lines = [`${value.asin} · ${value.marketplace}  (tab: ${wanted.join(' + ')})`]

  if (wanted.includes('overview')) {
    const overview = value.overview
    const identity = overview.identity
    lines.push(
      `标题: ${identity.title ?? '—'}`,
      `品牌: ${identity.brand ?? '—'}    价格: ${identity.price ?? '—'} ${identity.currency ?? ''}    BSR: ${identity.bsr ?? '—'}    类目: ${identity.category ?? '—'}`,
      `评分: ${identity.rating ?? '—'}    评论数: ${identity.reviews ?? '—'}    产品线: ${identity.productLineId ?? '—'}`,
      `首次见到: ${stamp(identity.firstSeenAt)}    最后更新: ${stamp(identity.updatedAt)}    主源: ${identity.primarySourceId ?? '—'}`,
      archiveStateLine(overview.archive),
      '',
      '完整率（分子/分母）：',
    )
    for (const item of Object.values(overview.completeness)) {
      lines.push(`  ${item.label}: ${ratio(item.value, item.total)}`
        + (item.percent === null ? '（分母为 0，没有比率可说）' : ` = ${item.percent}%`)
        + (item.missing.length === 0 ? '' : `  缺: ${item.missing.join(' ')}`))
    }
    lines.push(
      '',
      `新鲜度: 新鲜 ${overview.freshness.value} · 过期 ${overview.freshness.stale} · 未知 ${overview.freshness.unknown}`
        + `（共 ${overview.freshness.total} 个字段；其中无阈值 ${overview.freshness.noThreshold}、没有观测时间 ${overview.freshness.noObservationTime}）`,
      `多源冲突: ${overview.openConflicts} 个待裁决（共 ${overview.conflicts.length} 条冲突记录）`,
      `13 节: 采过 ${ratio(overview.sections.totals.attempted, overview.sections.totals.total)}`
        + ` · 已采到 ${overview.sections.summary.collected} / 页面没有 ${overview.sections.summary.missing}`
        + ` / 部分 ${overview.sections.summary.partial} / 失败 ${overview.sections.summary.failed} / 拦截 ${overview.sections.summary.blocked}`,
      ...coverageWarning(overview.sections.coverage),
      `变体: 角色 ${overview.variants.role} · 子体 ${ratio(overview.variants.counts.childrenWithDimensions, overview.variants.counts.children)} 有维度`
        + `（分母是不同子体数）· 同族关系 ${overview.variants.counts.familyRelations} 条`
        + ` · 矛盾 ${overview.variants.problemCount} · 不完整 ${overview.variants.incompleteCount}`
        + ` · 父体级批量优化${overview.variants.parentLevelOptimizationAllowed ? '可以' : '被禁止'}`,
      `快照: ${value.fields?.snapshots?.note ?? (value.overview.fields.snapshots.note ?? '可以比较最近两份')}`,
      '',
      '本批未计入（属于 F05-07，不是「都健康」）：' + overview.deferred.map(item => `${item.label}[${item.feature}]`).join('、'),
    )
  }

  if (wanted.includes('fields')) {
    const summary = value.fields.summary
    lines.push('', `Listing 全字段（${summary.withValue}/${summary.total} 有值）:`)
    lines.push(table(value.fields.fields, [
      { label: '字段', value: row => row.label },
      { label: '采用值', value: row => truncate(row.adoptedValue === null ? '' : String(row.adoptedValue), 24) },
      /* 2026-10-25（R-55）：这两列原来只看 `asin_field_source`。
         而本仓有两类字段：
           · 采集型（标题/价格/BSR…）→ 那张表有行，来源数 1；
           · 判断型（产品线 / 自有竞品归属）→ 来源在 `asin_ownership` 的边上，
             `asin_field_source` **永远 0 行**。

         实测 B0GV55Q4JG：「产品线 bench-cushion · 来源 — · 来源数 0 · 下游 3」——
         有值、有三个下游、却零个来源，读者只能得出「这个值是从天上掉下来的」。

         这里先做最小的一步：**值非空而来源数为 0 时，明确写出「无采集来源」**，
         而不是印一个 `—` 让读者以为是漏读。真正读 ownership 边的修法在
         domain/asin/fields.js 的 sources 构造里，比这一行重一档。 */
      { label: '来源', value: row => (row.adoptedSourceId
        ?? (row.adoptedValue === null || row.adoptedValue === undefined || row.sourceCount === 0
          ? (row.adoptedValue === null || row.adoptedValue === undefined ? '—' : '无采集来源')
          : '—')) },
      { label: '观测时间', value: row => stamp(row.observedAt) },
      { label: '新鲜度', value: row => (row.freshness === 'unknown'
        ? (row.freshnessReason === 'no-threshold' ? '无阈值' : '没有观测时间')
        : row.freshness) },
      { label: '人工', value: row => (row.manualConfirmed ? `是(${stamp(row.manualAt)})` : '') },
      { label: '来源数', value: row => (row.sourceCount === 0 && row.adoptedValue !== null && row.adoptedValue !== undefined
        ? '0（非采集型）'
        : row.sourceCount) },
      { label: '与上快照', value: row => (row.diff.changed ? `${JSON.stringify(row.diff.before)} → ${JSON.stringify(row.diff.after)}` : (row.diff.reason ?? '无变化')) },
      { label: '下游', value: row => (row.downstream.length === 0 ? '无引用' : row.downstream.length) },
    ]))
    const noDownstream = value.fields.fields.filter(row => row.downstream.length === 0).map(row => row.field)
    if (noDownstream.length > 0) lines.push(`没有任何下游引用的字段: ${noDownstream.join(', ')}`)
  }

  if (wanted.includes('sections')) {
    /* 2026-10-25（R-56）：这一行原来只说「采过 13/13」。
       而 `overview`（:698-700）对同一份数据是这么说的：
         「13 节: 采过 13/13 · 已采到 8 / 页面没有 1 / 部分 4 / 失败 0 / 拦截 0」

       **同一个数字，一个 tab 说全了，另一个只说了一半** ——
       而「只说一半」的这一屏恰恰是为看「每一节采到什么程度」而存在的。

       「采过 13/13」会被读成「13 节都采到了」，而实际只有 8 节完整：
       下面正有 4 节「部分采到」和 1 节「页面没有」。读者扫一眼标题就可能跳过它们。 */
    const sectionSummary = value.sections.summary ?? value.overview?.sections?.summary ?? null
    lines.push('', `13 节（采过 ${ratio(value.sections.totals.attempted, value.sections.totals.total)}`
      + (sectionSummary === null
        ? ''
        : ` · 已采到 ${sectionSummary.collected} / 页面没有 ${sectionSummary.missing}`
          + ` / 部分 ${sectionSummary.partial} / 失败 ${sectionSummary.failed} / 拦截 ${sectionSummary.blocked}`)
      + '；未采集不是「页面没有」）:')
    lines.push(...coverageWarning(value.sections.coverage))
    lines.push(table(value.sections.sections, [
      { label: '#', value: row => row.order },
      { label: '节', value: row => row.label },
      /* 读被截断时「没有这一节的行」有两个原因，而它们的动作相反：库里真的没有 vs
         这一节的行在上限之外没被读出来。后者印成「未采集」就是把没读到说成没人采过。 */
      /* 「看见了、却没读出来」（errors_json 的 VARIATION_CHILDREN_UNREAD /
         child_tiles>0 且 children:[] —— 行上已有的信号，不是新造的）与「页面只给了
         一部分」在五态里是同一个 partial：真机里 variations 的 1/3 与 2/3 都印
         partial，只有这个标记能把它们分开。五态不动，动的是呈现。 */
      { label: '状态', value: row => (row.notCollected === true
        ? (row.readTruncated === true ? SECTION_READ_TRUNCATED_LABEL : '未采集')
        : (row.statusLabel ?? row.status) + (sectionContentUnread(row) ? ` ${SECTION_CONTENT_UNREAD_LABEL}` : '')) },
      { label: '字段', value: row => (row.notCollected === true ? '—' : `${row.collected}/${row.total}`) },
      { label: '采集于', value: row => stamp(row.collectedAt) },
      { label: '任务', value: row => (row.taskId === null ? '' : String(row.taskId).slice(0, 8)) },
    ]))
  }

  if (wanted.includes('variants')) {
    const variants = value.variants
    lines.push('', `变体关系（角色 ${variants.role}）：${variants.note ?? ''}`)
    /* 两个数分开印：`children` 是**不同的子体 ASIN**，`familyRelations` 是**关系条数**。
       一个子体挂两个父体时它们是 1 与 2 —— 拿其中一个去填另一个的标签，数字就说大话了。 */
    if (variants.children.length > 0) {
      lines.push(`子体 ${variants.counts.children} 个不同 ASIN（其中 ${variants.counts.childrenWithDimensions} 个有维度）`
        + ` · 同族关系 ${variants.counts.familyRelations} 条`)
      if (variants.children.length !== variants.counts.children) {
        lines.push(`（下表每条关系一行、共 ${variants.children.length} 行：一个子体挂在两个父体下会出现两次）`)
      }
    }
    if (variants.parents.length > 0) {
      lines.push('父体: ' + variants.parents.map(parent => `${parent.asin}${parent.disputed ? '（有争议：这个子体还挂在别的父体下）' : ''}`).join('、'))
    }
    if (variants.children.length > 0) {
      lines.push(table(variants.children, [
        { label: '子体', value: row => row.asin },
        { label: '维度值', value: row => (row.dimensions.length === 0
          ? '（一个维度值都没有）'
          : row.dimensions.map(entry => `${entry.dimension}=${entry.values.join('/')}${entry.contradicted ? '⚠' : ''}`).join('  ')) },
        { label: '来源', value: row => row.sourceId ?? '—' },
      ]))
    }
    for (const problem of variants.problems) lines.push(`⚠ ${problem.kind}: ${problem.message}`)
    for (const item of variants.incomplete) lines.push(`ⓘ ${item.kind}: ${item.message}`)
    if (variants.problems.length === 0 && variants.incomplete.length === 0 && variants.children.length > 0) {
      lines.push('没有检测到重复或矛盾，维度集合一致。')
    }
    /* 2026-10-25（R-54）：这一行原来一律印「禁止（关系不完整或有矛盾）」。
       实测 B0GV55Q4JG：
         「变体关系（角色 unrelated）：这个 ASIN 在这个站点还没有任何变体关系…」
         「父体级批量优化: 禁止（关系不完整或有矛盾）」
         「这个 ASIN 没有任何变体关系……这是「没有关系」，不是「读不出来」。」
       —— **第 2 行给的理由与第 1、4 行的事实互相拆台**。

       三种情况都该禁止，但只有前两种叫「不完整/有矛盾」：
         · 关系不完整 = 有边，但缺某些子体；
         · 有矛盾     = 同一个子体挂在两个父体下；
         · 一条都没有 = 这个 ASIN 根本没进任何变体族。

       用户看到「关系不完整或有矛盾」会去找**那条不完整的边**去修 —— 而根本不存在任何边。 */
    const noRelation = variants.children.length === 0
      && variants.problems.length === 0
      && variants.incomplete.length === 0
    lines.push(`父体级批量优化: ${variants.parentLevelOptimizationAllowed
      ? '允许'
      : `禁止（${noRelation ? '这个 ASIN 没有变体关系' : '关系不完整或有矛盾'}）`}`)
    lines.push(...variantEventLines(variants.events))
  }

  if (wanted.includes('keywords')) {
    const keywords = value.keywords
    lines.push('', `关键词与排名（单位：一行一个「词 × 来源」；共 ${keywords.counts.rows} 行，`
      + `有名次 ${keywords.counts.ranked} / 测过没找到 ${keywords.counts.absent} / 未测 ${keywords.counts.untested}）：`)
    lines.push(table(keywords.rows, [
      { label: '关键词', value: row => truncate(row.keyword, 34) },
      { label: '来源', value: row => row.sourceId },
      /* 三态来自 `classifyOurSide`（domain/keywords/competitor.js），与竞品对比页**同一个**
         判据。这里只印它给的词，不自己看 rank 是不是 null —— 那会是第二份实现。 */
      { label: '状态', value: row => row.stateLabel },
      { label: '名次', value: row => (row.rank === null ? '—（没有名次）' : row.rank) },
      { label: '页/深度', value: row => `${row.page ?? '—'}/${row.scanDepth ?? '—'}` },
      { label: '搜索量', value: row => (row.searchVolume === null ? '—' : row.searchVolume) },
      { label: '总库', value: row => (row.master === null ? '总库里没有这个词' : `tier ${row.master.tier ?? '—'}`) },
      { label: '采集于', value: row => stamp(row.collectedAt) },
    ]))
    lines.push(...unsourcedLines(keywords))
    lines.push('搜索量口径：上表来自 asin_keyword 的测量快照；关键词总库 kw_master 的当前值见 amzn_kw_query / amzn_keyword_detail。')
    for (const note of keywords.notes) lines.push(`  ⓘ ${note}`)
  }

  if (wanted.includes('reviews')) {
    const reviews = value.reviews
    lines.push('', `评论问答（${reviews.stateLabel}；来源 ${reviews.source}）：`)
    if (reviews.section !== null) {
      lines.push(`  13 节的 reviews：状态 ${reviews.section.statusLabel ?? reviews.section.status ?? '—'}`
        + ` · 采集于 ${stamp(reviews.section.collectedAt)} · 任务 ${reviews.section.taskId ?? '—'}`
        + ` · 方案版本 ${reviews.section.schemeVersion ?? '—'}`)
    }
    lines.push(`  评论总数 ${reviews.totals.reviewsTotal === null ? '—（没有读数）' : reviews.totals.reviewsTotal}`
      + ` · 页面可见 ${reviews.totals.reviewsVisible === null ? '—（没有读数）' : reviews.totals.reviewsVisible}`
      + ` · 摘要 ${reviews.summary === null ? '—（没有）' : truncate(reviews.summary, 60)}`)
    lines.push('  四格读数: ' + reviews.fields.map(cell => `${cell.label}=${cell.present ? '有' : '没有'}`).join('  '))
    if (reviews.items.length > 0) {
      lines.push(table(reviews.items, [
        { label: '#', value: row => row.index },
        { label: '评分', value: row => (row.rating === null ? '—' : row.rating) },
        { label: '标题', value: row => truncate(row.title ?? '', 30) },
        { label: '正文', value: row => truncate(row.body ?? '', 40) },
      ]))
    }
    lines.push(...unsourcedLines(reviews))
    for (const note of reviews.notes) lines.push(`  ⓘ ${note}`)
  }

  if (wanted.includes('competitor')) {
    const competitor = value.competitor
    lines.push('', `竞品对比（这条 ASIN 在 ${competitor.memberSetCount} / ${competitor.setCount} 个竞品组里）：`)
    lines.push(table(competitor.membership, [
      { label: '组', value: row => truncate(row.name, 24) },
      { label: '成员', value: row => row.memberCount },
      { label: '含这条', value: row => (row.containsThis ? '是' : '否') },
      { label: '更新于', value: row => stamp(row.updatedAt) },
    ]))
    if (competitor.comparisonNote !== null) lines.push(`  ${competitor.comparisonNote}`)
    if (competitor.comparison !== null) {
      const comparison = competitor.comparison
      lines.push(`  对端 ${comparison.peerCount} 个：${comparison.peers.join('、')}`)
      lines.push('  五桶（词数）: ' + comparison.order
        .map(bucket => `${comparison.labels[bucket]} ${comparison.counts[bucket]}`).join(' · '))
      lines.push(`  输入 ${comparison.inputTotal} 个词，分类 ${comparison.classified} 个`
        + (comparison.inputTotal === comparison.classified ? '（全划分）' : '（⚠ 两者不等：分类漏词或重复计数）'))
      for (const bucket of comparison.order) {
        const rows = comparison.quadrants[bucket]
        if (rows.length === 0) continue
        lines.push(`  ${comparison.labels[bucket]}${comparison.truncated[bucket] ? `（只印前 ${comparison.limit} 条）` : ''}:`)
        lines.push(table(rows, [
          { label: '关键词', value: row => truncate(row.keyword, 34) },
          { label: '我方', value: row => row.our_rank ?? '—' },
          { label: '对端最好', value: row => row.competitor_best_rank ?? '—' },
          { label: '对端命中', value: row => `${row.competitor_ranked_count}/${row.competitor_total}` },
        ]))
      }
    }
    lines.push(...unsourcedLines(competitor))
    for (const note of competitor.notes) lines.push(`  ⓘ ${note}`)
  }

  if (wanted.includes('optimization')) {
    const optimization = value.optimization
    lines.push('', `优化历史（${optimization.runCount} 轮；草案 ${optimization.totals.drafts} 条：`
      + `已采纳 ${optimization.totals.accepted} / 未采纳 ${optimization.totals.declined} / `
      + `待裁决 ${optimization.totals.pending} / 已作废 ${optimization.totals.voided} / 已延后 ${optimization.totals.deferred}）：`)
    for (const run of optimization.runs) {
      lines.push(`  轮次 ${run.id}  ${run.statusLabel}  ${stamp(run.startedAt)} → ${stamp(run.finishedAt)}`
        + `  草案 ${run.draftCount} 条（版本 ${run.draftVersion ?? '—'}）`
        + `  报告 ${run.hasReport ? '有正文' : '没有正文'}`
        + `  规则版本 ${run.rulesVersion ?? '—'}`)
      if (run.drafts.length > 0) {
        lines.push(table(run.drafts, [
          { label: '字段', value: row => row.field },
          { label: '前', value: row => truncate(row.before ?? '—', 24) },
          { label: '后', value: row => truncate(row.after ?? '—', 24) },
          /* 处置态由 domain 推出（先作废/延后，再采纳）—— 页面与工具都只印它。 */
          { label: '处置', value: row => row.acceptedLabel },
        ]))
      }
    }
    if (optimization.publications.length > 0) {
      lines.push('', `  发布记录 ${optimization.publicationCount} 条：`)
      lines.push(table(optimization.publications, [
        { label: 'id', value: row => String(row.id).slice(0, 8) },
        { label: '类型', value: row => row.kind },
        { label: '发布', value: row => stamp(row.publishedAt) },
        { label: '偏离', value: row => (row.deviated ? `是（${row.deviationRule ?? '—'}）` : '否') },
        { label: '回滚任务', value: row => row.rollbacks.length },
        { label: '观测计划', value: row => row.observationPlans.length },
      ]))
    }
    lines.push(...unsourcedLines(optimization))
    for (const note of optimization.notes) lines.push(`  ⓘ ${note}`)
  }

  if (wanted.includes('sources')) {
    const sources = value.sources
    /* 2026-10-25（R-57）：这里原来只印「34 个字段 / 34 行来源」，而 `fields` tab 说「10/10 有值」。
       同一个 ASIN、同一个站点、两个「字段数」——**两个都不说范围**，读者会以为其中一个漏了 24 行。

       实测把这 34 行拆开：`attribute.*` 25 行 + 核心字段 9 行（brand / bsr / category / currency /
       image_url / price / rating / reviews / title）。
       而 `fields` 那 10 个 = 这 9 个 + `product_line`（判断型，来源在 asin_ownership，不进这张表 —— 见 R-55）。

       所以两个数都对，差的是**口径**：一个是「核心 Listing 字段」，一个是「采集到的字段明细（含属性）」。
       标题里必须把这两个数分开写，否则它只是一个更大的、没有范围的名词。 */
    const attrRows = sources.byField.filter(row => String(row.field).startsWith('attribute.')).length
    const coreRows = sources.fieldCounts.fields - attrRows
    lines.push('', `来源与审计（${sources.fieldCounts.fields} 个字段 = 核心 ${coreRows} + 属性 ${attrRows}；`
      + `${sources.fieldCounts.rows} 行来源；`
      + `有观测时间 ${sources.fieldCounts.observed} · 未记录 ${sources.fieldCounts.unobserved}）：`)
    lines.push(table(sources.byField, [
      { label: '字段', value: row => row.field },
      { label: '来源数', value: row => row.sourceCount },
      { label: '不同值', value: row => row.distinctValues },
      { label: '冲突', value: row => (row.conflicted ? '是' : '否') },
      { label: '来源', value: row => row.sources.map(source => `${source.sourceId}(${source.sourceTypeLabel})`).join('、') },
      { label: '观测于', value: row => row.sources.map(source => stamp(source.observedAt)).join('、') },
    ]))
    lines.push('', `审计流水 ${sources.auditCount} 行`
      + (sources.auditTruncated ? `（共 ${sources.auditTotal} 行，只印最新那些）` : '')
      + `；object_id 形状：` + sources.auditObjectIdForms
        .map(form => `${sources.auditObjectIdFormLabels[form]} ${sources.auditFormCounts[form]}`).join(' · '))
    lines.push(table(sources.audit, [
      { label: '时间', value: row => stamp(row.at) },
      { label: '动作', value: row => row.action },
      { label: '对象', value: row => `${row.objectId ?? '—'}（${row.objectIdFormLabel}）` },
      { label: '按', value: row => row.matchedBy },
      { label: '路', value: row => row.route },
    ]))
    lines.push(`  版本索引 ${sources.snapshotCount} 条 · 采集方案版本 ${sources.schemeVersionCount} 条`
      + ` · 待裁决冲突 ${sources.conflictCount} 条 · 归档事件 ${sources.archiveEvents.length} 条`)
    lines.push(...unsourcedLines(sources))
    for (const note of sources.notes) lines.push(`  ⓘ ${note}`)
  }

  /* 2026-10-25（R-53）：这一行原来是
       pendingTabs.length === 0 ? `九个标签页全部已建: ${wanted.join(', ')}` : …
     而 `wanted` 是**本次请求的 tab**，不是九个。
     实测（只请求 tab: "overview"）：
       `九个标签页全部已建: overview`
     前半句说「九个全部」，后半句只列了 1 个 —— 冒号把它们连起来，读起来像「全部 = overview」。

     修法：**保留「全部已建」这个契约短语**（`tests/b05-asin-detail.mjs` 的 B05P-⑥ 钉着它），
     在后面补一句本次范围 —— 这样既守住了「九个都建完了」的事实，也说清了「这一批只回了一个」。

     ⚠️ 我第一版把「全部已建」改成了「九个都已建」，**全量立刻红了 1 条**（B05P-⑥）。
     那条测试是对的：它钉的是「建完了就说建完了，不要继续交代未建」这个契约。
     **不要为了让一句话更准而拆掉一个被测试钉住的短语 —— 加半句比换掉更安全。 */
  lines.push('', value.pendingTabs.length === 0
    ? `九个标签页全部已建（本次返回 ${wanted.length} 个: ${wanted.join(', ')}）`
    : `本次返回: ${wanted.join(', ')}；未建: ${value.pendingTabs.map(tab => `${tab.label}[${tab.feature}]`).join('、')}`)
  return lines.filter(line => line !== undefined && line !== null).join('\n')
}

/**
 * 「本仓没有来源」那几条，印成独立的块。
 *
 * 它们**不是**空结果：一句「没有来源」与一个空列表在文本里长得几乎一样，所以这里
 * 连 `reason` 一起印 —— 读者要能看出「这一块本仓结构上答不了」与「这一块这次没数据」
 * 是两件事。文案本身来自 domain（`unsourced.js`），这里一个字都不写。
 */
function unsourcedLines(tab) {
  const entries = Array.isArray(tab?.unsourced) ? tab.unsourced : []
  if (entries.length === 0) return []
  const lines = ['', `  ⚠ ${tab.noSourceText}（${entries.length} 项）—— 不是「没有数据」，是「本仓没有来源」：`]
  for (const entry of entries) {
    lines.push(`    · ${entry.label}（${entry.feature}）：${entry.conclusion}`)
    lines.push(`      ${entry.reason}`)
  }
  return lines
}

/**
 * 变体事件历史那几行（F05-06 的追溯面）——「谁在什么时候改了什么」。
 *
 * 三种状态分开印，这是本仓「没测到 ≠ 没有」的同一条纪律：**读不出来** / 有关系但
 * **一条事件都没有** / **根本没有关系**。合成一句「没有事件」，第一种就被读成了第二种，
 * 而它们的处置动作相反（去修读路径 vs 去查那条边是怎么写进来的）。
 *
 * 事件与矛盾分两块印：一条 `corrected` 事件是「已经处理完了」，`problems` 里的每一条
 * 都是「还没处理」。合起来，处理过的边会永远挂着一个待办。
 */
function variantEventLines(events) {
  if (events === null || events === undefined) {
    return ['', '变体事件: 服务端没有给这一块 —— 与「一条事件都没有」不是一件事']
  }
  if (events.error !== null && events.error !== undefined) {
    return ['', `变体事件: 读不出来（${events.error}）—— 与「一条事件都没有」不是一件事`]
  }
  const lines = ['', `变体事件（${events.relationCount} 条边 · 共 ${events.total} 条事件；每条边最多印最近 ${events.limit} 条）:`]
  if (events.note !== null && events.note !== undefined) lines.push(`  ${events.note}`)
  for (const group of events.groups) {
    lines.push(`  ${group.parentAsin} → ${group.childAsin}（${group.status}，${group.count} 条事件`
      + (group.truncated ? `，下面只列最近 ${group.events.length} 条` : '') + '）')
    for (const event of group.events) {
      lines.push(`    ${stamp(event.at)}  ${event.action}  by ${event.by ?? '—'}`
        + (event.reason === null || event.reason === undefined ? '' : `  理由: ${event.reason}`)
        + (event.evidence === null || event.evidence === undefined ? '' : `  证据: ${truncate(event.evidence, 40)}`))
    }
  }
  lines.push('  事件是历史，不参与上面的矛盾检测：一条 corrected 事件说的是「这条边被纠正过」，不是「现在有矛盾」。')
  return lines
}

export function asinFieldCorrectTool({ store }) {
  return {
    name: 'amzn_asin_field_correct',
    description:
      'Record a HUMAN correction of one Listing field: the value is written with the manual source, the collected / imported '
      + 'sources and the collection snapshot are left untouched, so "what was there before" stays readable. '
      + 'This changes the adopted value (the one everything downstream reads), which is why it is a separate tool from '
      + 'amzn_asin_upsert: only a person may say "the page is wrong, the truth is this". '
      + 'Only the columns of the `asin` table are accepted; content fields (bullets, description, A+) live on `listing` '
      + 'and are refused by name. Never invent a correction the user did not state.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        field: {
          type: 'string',
          enum: ['title', 'brand', 'price', 'currency', 'bsr', 'category', 'rating', 'reviews', 'image_url', 'product_line_id'],
          description: 'Which field to correct.',
        },
        value: { description: 'The corrected value. Numeric fields accept a number or a numeric string ("1,299.99" is parsed).' },
        reason: { type: 'string', description: 'Why this correction is being made. Stored in the audit row, not in the value.' },
        observedAt: { type: 'string', description: 'Only when the human states WHEN this became true. Omit otherwise — an undated value must read as undated, never as "just now".' },
        sourceId: { type: 'string', description: 'Source id to record it under. Default "manual" (the human source).' },
        by: { type: 'string', description: 'Who made the correction. Default null.' },
      },
      required: ['asin', 'field', 'value'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      try {
        const result = correctAsinField(store, {
          asin: args?.asin,
          marketplace: args?.marketplace ?? 'US',
          field: args?.field,
          value: args?.value,
          reason: args?.reason ?? null,
          observedAt: args?.observedAt ?? null,
          sourceId: args?.sourceId ?? null,
          by: args?.by ?? null,
        })
        return result
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
          hint: 'Read the message: it names the field, the column, or the rule. Do not retry the same call unchanged.',
        }
      }
    },
  }
}

export function asinArchiveTool({ store }) {
  return {
    name: 'amzn_asin_archive',
    description:
      'Preview, archive, restore or (narrowly) delete one ASIN (marketplace by marketplace — the same ASIN in another site '
      + 'is another record). '
      + 'Archiving hides it from the default list, makes it read-only for new writes, and leaves every snapshot, draft and report '
      + 'readable. A delisted or mis-sold product must be ARCHIVED, never removed — that rule still holds. '
      + 'Use action "preview" first and show the numbers to the user: how many drafts, observations and competitor sets it affects. '
      + 'Restoring puts it back to active and leaves an audit event. '
      + 'Deletion is the one irreversible action here and is allowed ONLY for a row an import created by mistake and that '
      + 'nothing references: call "delete_preview" to get the reference report, show it, and only then "delete" with a reason. '
      + 'A row that has been collected, optimised or published always has references, so it cannot be deleted — archive it instead. '
      + 'Nothing is ever deleted on your own initiative: ask the user first.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['preview', 'archive', 'restore'],
          description:
            'preview reads only; archive and restore write. preview answers "what would archiving block" and writes nothing. '
            + 'Deleting is a different tool (amzn_asin_delete) — it is the one irreversible action here and does not belong '
            + 'on the same enum as a reversible flag.',
        },
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        reason: {
          type: 'string',
          description: 'Why it is being archived / restored. Stored on the event and in the audit row.',
        },
        by: { type: 'string', description: 'Who is doing it. Default null.' },
        confirm: {
          type: 'boolean',
          description:
            'Set true to archive when this workspace has turned on the 归档 二次确认. Without it an archive is refused with '
            + 'APPROVAL_REQUIRED and nothing is written. preview and restore never need it. '
            + 'This switch is about archiving only — it can never authorise the delete tool.',
        },
      },
      required: ['action', 'asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      const action = String(args?.action ?? '').trim()
      const ACTIONS = ['preview', 'archive', 'restore']
      if (!ACTIONS.includes(action)) {
        return { ok: false, error: `action must be one of preview | archive | restore (got ${JSON.stringify(args?.action)})` }
      }
      if (action === 'archive') {
        /* 与工作空间的归档同一个闸门（`archive`）：两处「归档」对用户是同一件事，
           两个开关名只会让人以为其中一个没生效。 */
        const refusal = approvalRefusal(store, 'archive', args?.confirm,
          `要归档的 ASIN：${String(args?.asin ?? '').toUpperCase()}@${String(args?.marketplace ?? 'US').toUpperCase()}。`
          + '归档后它从默认列表隐藏、且不可再新建采集/优化（历史快照与报告仍可读，也能恢复）。确认无误就再调一次并带 confirm: true。')
        if (refusal !== null) return refusal
      }

      try {
        if (action === 'preview') {
          const impact = archiveImpact(store, { asin: args?.asin, marketplace: args?.marketplace ?? 'US' })
          return {
            ok: true,
            action,
            impact,
            text: renderArchiveImpact(impact, '归档前影响预览（什么都没写）'),
          }
        }
        if (action === 'archive') {
          const result = archiveAsin(store, {
            asin: args?.asin, marketplace: args?.marketplace ?? 'US', reason: args?.reason ?? null, by: args?.by ?? null,
          })
          const events = listArchiveEvents(store, { asin: args?.asin, marketplace: args?.marketplace ?? 'US', limit: 5 })
          return {
            ok: true,
            action,
            changed: result.changed,
            asin: String(args?.asin ?? '').toUpperCase(),
            marketplace: String(args?.marketplace ?? 'US').toUpperCase(),
            impact: result.impact,
            archiveEvents: events,
            text: (result.changed
              ? `已归档 ${String(args?.asin ?? '').toUpperCase()}@${String(args?.marketplace ?? 'US').toUpperCase()}`
              : `${String(args?.asin ?? '').toUpperCase()} 本来就已归档（时间戳未改动）`)
              + (result.impact === null ? '' : `\n${renderArchiveImpact(result.impact, '这次归档的影响面')}`),
          }
        }
        const result = restoreAsin(store, {
          asin: args?.asin, marketplace: args?.marketplace ?? 'US', reason: args?.reason ?? null, by: args?.by ?? null,
        })
        const events = listArchiveEvents(store, { asin: args?.asin, marketplace: args?.marketplace ?? 'US', limit: 5 })
        return {
          ok: true,
          action,
          changed: result.changed,
          asin: String(args?.asin ?? '').toUpperCase(),
          marketplace: String(args?.marketplace ?? 'US').toUpperCase(),
          archiveEvents: events,
          text: result.changed
            ? `已恢复 ${String(args?.asin ?? '').toUpperCase()}@${String(args?.marketplace ?? 'US').toUpperCase()} —— 回到 active，`
              + '新鲜度按原有的观测时间重新判定（没有「恢复时刷新」这回事）。'
            : `${String(args?.asin ?? '').toUpperCase()} 本来就没有归档，无需恢复。`,
        }
      } catch (error) {
        return {
          ok: false,
          action,
          error: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
        }
      }
    },
  }
}

/**
 * 受限删除 —— 独立一个工具，不是 `amzn_asin_archive` 的一个动作。
 *
 * ## 为什么不是同一个工具里的第五个动作
 *
 * 归档与恢复是**同一个可逆标志的两个方向**：它们共用一条 action、共用一份前值，
 * 把方向交给 before/after 的差异去表达。删除**不属于那个轴** —— 它没有反方向。
 * 一个入参枚举里同时装着「可逆」与「不可逆」，会让「这个 action 的 confirm
 * 是什么意思」取决于另一个字段的取值：归档的确认是一个可以关掉的设置，
 * 删除的确认是一个恒定的前置条件。两种语义不该共用一个 `confirm`。
 *
 * 另外，`s1b12` 的守卫按**字面量**校验每条描述符的 `action`（非字符串即
 * malformed），而两条 action 必须分开。让守卫放松到「能解析一个函数」是为了让一个
 * 设计选择过得去而削弱一条守卫 —— 方向反了，所以拆工具。
 *
 * ## 两个动作
 *
 * `delete_preview` 只读，回答「什么引用了它、能不能删」——**与归档预览是两个不同的问题**
 * （一个问「归档会挡住谁」，一个问「删掉会带走谁」），所以没有合成一句「影响预览」：
 * 合成之后，用户会在一份为归档准备的数字上点删除。
 *
 * `delete` 写。它要求 `confirm: true`（恒定的，不可关闭）与一个非空的 `reason`。
 *
 * 不可删除的三种情形各有各的错误码，因为它们的下一步动作完全不同：
 * `ASIN_NOT_FOUND`（坐标写错了）、`ASIN_REFERENCED`（去清引用，或改成归档）、
 * `ASIN_REFERENCE_CHECK_INCOMPLETE`（引用检查本身有洞 —— 那是代码缺陷，不是用户能修的）。
 */
export function asinDeleteTool({ store }) {
  return {
    name: 'amzn_asin_delete',
    description:
      'Inspect and (very narrowly) perform the one irreversible action in this plugin: deleting a single ASIN row. '
      + 'Call action "delete_preview" first — it lists every row that references this ASIN and says whether the row is '
      + 'deletable, and it writes nothing. '
      + 'Deletion is allowed ONLY for a row an import created by mistake and that NOTHING references. Any row that has been '
      + 'collected, keyword-tracked, optimised or published always has references, so it cannot be deleted — archive it with '
      + 'amzn_asin_archive instead. A delisted or mis-sold product must never be removed. '
      + 'A delete always needs confirm: true (this confirmation cannot be switched off, unlike archiving) and a non-blank '
      + 'reason. Show the user the reference report before calling it.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['delete_preview', 'delete'],
          description: 'delete_preview reads only; delete writes and cannot be undone.',
        },
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        reason: {
          type: 'string',
          description:
            'Why this row is an import error. REQUIRED and must not be blank for action "delete" — deletion is the one thing '
            + 'nothing can undo, so this line plus the stored reference report is all that is left to review afterwards.',
        },
        by: { type: 'string', description: 'Who is doing it. Default null.' },
        confirm: {
          type: 'boolean',
          description:
            'Required (true) for action "delete". Unlike archiving, this is NOT a per-workspace setting: it can never be '
            + 'turned off, because the action it guards can never be undone. delete_preview never needs it.',
        },
      },
      required: ['action', 'asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      const action = String(args?.action ?? '').trim()
      if (!['delete_preview', 'delete'].includes(action)) {
        return { ok: false, error: `action must be one of delete_preview | delete (got ${JSON.stringify(args?.action)})` }
      }
      const asin = String(args?.asin ?? '').toUpperCase()
      const marketplace = String(args?.marketplace ?? 'US').toUpperCase()

      if (action === 'delete' && args?.confirm !== true) {
        /* ★ 删除的确认**不是一个可关闭的开关**，而是一个恒定的前置条件。
           归档走 `approvalRefusal('archive', …)`：那个开关可以关掉，因为归档可恢复。
           删除不行 —— 「确认可以关掉」正是唯一不可恢复的动作最不该有的性质。
           所以这里不读 approval 设置（那会需要一个 `approval.delete` 开关，
           而新增一个能被关掉的删除确认是自相矛盾的），直接要求 `confirm: true`。 */
        return {
          ok: false,
          action,
          code: 'APPROVAL_REQUIRED',
          error: `删除 ${asin}@${marketplace} 需要 confirm: true —— 删除是本仓唯一不可恢复的动作，`
            + '这条确认**不能**通过任何设置关掉。先用 action:"delete_preview" 看引用报告'
            + '（0 处引用才允许删除），把报告给用户看过再确认。',
        }
      }

      try {
        if (action === 'delete_preview') {
          const report = asinReferenceReport(store, { asin, marketplace })
          return {
            ok: true,
            action,
            references: report,
            deletable: report.deletable,
            text: renderReferenceReport(report, '删除前引用检查（什么都没写）'),
          }
        }

        const report = asinReferenceReport(store, { asin, marketplace })
        const result = deleteAsin(store, {
          asin,
          marketplace,
          reason: args?.reason ?? null,
          by: args?.by ?? null,
          /* 预览与执行共用**同一份**报告（与 `archiveAsin` 的 `impact` 同一条约定），
             所以「预览说 0 处引用、执行却被拦住」不可能发生。 */
          references: report,
        })
        /* 行已经没了，所以这里再读事件表 —— 它是这行记录唯一剩下的痕迹。
           `listArchiveEvents` 不依赖 `asin` 行存在（事件表没有指向它的外键）。 */
        const events = listArchiveEvents(store, { asin, marketplace, limit: 5 })
        return {
          ok: true,
          action,
          changed: result.changed,
          asin,
          marketplace,
          references: result.references,
          archiveEvents: events,
          text: `已删除 ${asin}@${marketplace}（理由：${String(args?.reason ?? '').trim()}）\n`
            + renderReferenceReport(result.references, '删除时的引用检查（已写进事件行）')
            + `\n这一行已经不存在了。「它曾经存在过、谁在什么时候删的、凭什么判定没有引用」留在事件表里`
            + `（${events.length} 条事件，最新一条是 delete）—— 那是不可恢复的动作唯一能复盘的材料。`,
        }
      } catch (error) {
        return {
          ok: false,
          action,
          error: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
          /* `ASIN_REFERENCED` 时把逐条引用带出去：调用方（会话或页面）要能直接把它们列给用户，
             而不是让用户再去猜是哪一张表挡住了。 */
          ...(Array.isArray(error.references) ? { references: error.references } : {}),
          ...(Array.isArray(error.gaps) ? { gaps: error.gaps } : {}),
        }
      }
    },
  }
}

/**
 * 归档状态那一行：**现在**是什么状态，以及「曾经归档过、现在是 active」这一态。
 *
 * 三态分开说，因为恢复之后再看到一句光秃秃的「归档: 否」会让人以为归档这件事从没发生过
 * —— 而「谁在什么时候把它藏起来又放回来」正是 F05-08 要留下的东西。三个分支的措辞
 * 与页面（`asinOverviewBody` 的那一段）说同一件事，只是这句给会话侧读。
 */
function archiveStateLine(archive) {
  if (archive.archived === true) {
    return `归档: 是（${stamp(archive.archivedAt)}，理由 ${archive.archiveReason ?? '无原因'}，`
      + `操作人 ${archive.archivedBy ?? '—'}）—— 隐藏不是删除：下面几页仍然读得出，血缘一个字节没动`
  }
  if (archive.everArchived === true) {
    const last = archive.lastEvent
    return `归档: 否（现在在架上，但曾经归档过：事件 ${archive.eventCount} 条，最近一条 `
      + `${last === null || last === undefined ? '—' : last.action} @ ${stamp(last === null || last === undefined ? null : last.at)}）`
  }
  return '归档: 否（从来没有归档过 —— 归档事件 0 条，那是「没归档过」，不是「读不出来」）'
}

/** 影响面的三句「会被挡住」+ 三句「保持可读」。数字与写进事件行的那一份同一个来源。 */
export function renderArchiveImpact(impact, title) {
  return [
    `${title}：${impact.asin}@${impact.marketplace}`,
    '会被挡住：' + impact.blocked.map(item => `${item.label} ${item.count}（${item.effect}）`).join(' · '),
    '保持只读可查：' + impact.readable.map(item => `${item.label} ${item.count}`).join(' · '),
    impact.competitorSets.length === 0
      ? '所属竞品组：0 个'
      : '所属竞品组：' + impact.competitorSets.map(set => `${set.name}(${set.id})`).join('、'),
  ].join('\n')
}

/**
 * 引用检查那一份报告，印成给人看的几行。
 *
 * ★ 每一行有**自己的前缀**（`引用:` / `挡删除的:` / `不挡删除的:` / `检查覆盖:`），
 * 而且**一件事实只出现在一行里**。理由是本仓刚做完的 `includes(标签)` 专项审计：
 * 同一份输出里只要还有另一行会印出同一个词（图例、说明、统计、空态文案），
 * 一条 `includes('0 处')` 就可能在**某一次**渲染里因为那一行而变绿 —— 而那一次
 * 恰恰是断言要抓的那一次。所以断言读的是**那一行自己的文字**，不是整份渲染。
 */
export function renderReferenceReport(report, title) {
  const list = items => (items.length === 0
    ? '无'
    : items.map(item => `${item.table}.${item.column} ${item.count} 行`).join(' · '))
  const lines = [
    `${title}：${report.asin}@${report.marketplace}`,
    report.total === 0
      ? '引用: 0 处（在检查覆盖到的范围内没有任何下游引用）'
      : `引用: ${report.total} 处 —— **不能删除**；误售停用的记录应当归档（归档可恢复，删除不可恢复）`,
    `挡删除的: ${list(report.references)}`,
    /* 「跟着一起删的」必须单独一行、且**必须在预览里**：它是这次删除会带走的东西。
       混进「挡删除的」会让人以为删除被拒绝；完全不提则是删完才发现。 */
    '跟着删的: ' + (report.cascade.length === 0
      ? '无'
      : report.cascade.map(item => `${item.table}.${item.column} ${item.count} 行（这条记录自己的状态）`).join(' · ')),
    /* 审计行与别人的 ASIN **单独一行**：它们存在且常常不为 0 却不挡删除，
       混在「挡删除的」那一行里会让读者以为这是个 bug（明明有引用却还能删）。 */
    '不挡删除的: ' + (report.record.length + report.audit.length + report.foreign.length === 0
      ? '无'
      : [
        ...report.record.map(item => `${item.table}.${item.column} ${item.count} 行（记录自身）`),
        ...report.audit.map(item => `${item.table}.${item.column} ${item.count} 行（审计历史：行删了它还在）`),
        ...report.foreign.map(item => `${item.table}.${item.column} ${item.count} 行（别人的 ASIN，与这条记录无关）`),
      ].join(' · ')),
    report.gaps.length === 0
      ? '检查覆盖: 完整（派生出的 asin 列全部被分类，分类表里的表与列全部存在）'
      : `检查覆盖: **不完整** —— ${report.gaps.join('；')}。这一状态下不允许删除`,
  ]
  return lines.join('\n')
}

export function asinVariantUpsertTool({ store }) {
  return {
    name: 'amzn_asin_variant_upsert',
    description:
      'Record that a child ASIN belongs to a parent ASIN in a marketplace, and (optionally) the variation dimension values '
      + '(Color=Red, Size=L). Writing the same edge twice is an update, not a second relation. '
      + 'A child may legitimately end up under two parents in this table — that is a contradiction to be FOUND by '
      + 'amzn_asin_detail and corrected by a human, not something to hide by refusing the write. '
      + 'An ASIN cannot be its own parent, and an archived ASIN refuses writes. Nothing is deleted.',
    parameters: {
      type: 'object',
      properties: {
        parentAsin: { type: 'string', description: 'The parent ASIN.' },
        childAsin: { type: 'string', description: 'The child ASIN.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US. A variation family is per marketplace.' },
        sourceId: { type: 'string', description: 'Where this relation was seen, e.g. browser-local. Required for dimension values.' },
        evidence: { type: 'string', description: 'What showed it (page URL, file name). Stored on the relation and on the event.' },
        dimensions: {
          type: 'array',
          description: 'The dimension values of this child within this family. Omit when they were not collected — an empty list is "unknown", not "no dimensions".',
          items: {
            type: 'object',
            properties: {
              dimension: { type: 'string', description: 'Dimension name as the page spells it, e.g. Color.' },
              value: { type: 'string', description: 'This child\'s value on that dimension.' },
              observedAt: { type: 'string', description: 'When the page said so. Omit if unknown.' },
            },
            required: ['dimension', 'value'],
          },
        },
        by: { type: 'string', description: 'Who recorded it. Default null.' },
      },
      required: ['parentAsin', 'childAsin'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      const marketplace = String(args?.marketplace ?? 'US')
      try {
        const written = upsertVariantRelation(store, {
          marketplace,
          parentAsin: args?.parentAsin,
          childAsin: args?.childAsin,
          sourceId: args?.sourceId ?? null,
          evidence: args?.evidence ?? null,
          by: args?.by ?? null,
        })
        const dimensions = []
        for (const entry of Array.isArray(args?.dimensions) ? args.dimensions : []) {
          dimensions.push(upsertVariantDimension(store, {
            marketplace,
            parentAsin: args?.parentAsin,
            childAsin: args?.childAsin,
            dimension: entry?.dimension,
            value: entry?.value,
            sourceId: args?.sourceId ?? 'manual',
            observedAt: entry?.observedAt ?? null,
          }).dimension)
        }
        return {
          ok: true,
          relation: written.relation,
          created: written.created,
          restored: written.restored,
          dimensions,
          text: `${written.created ? '已记录' : (written.restored ? '已重新生效' : '已更新')}变体关系 `
            + `${written.relation.parentAsin} → ${written.relation.childAsin}@${written.relation.marketplace}`
            + (dimensions.length === 0
              ? '（没有记维度值 —— 那不是「没有维度」，是「还没采到」）'
              : `，维度 ${dimensions.map(row => `${row.dimension}=${row.value}`).join('  ')}`),
        }
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
          hint: 'Read the message: it names the ASIN, the edge or the missing prerequisite.',
        }
      }
    },
  }
}

export function asinVariantCorrectTool({ store }) {
  return {
    name: 'amzn_asin_variant_correct',
    description:
      'Mark a recorded parent-child relation as WRONG. The row is kept with its correction time and reason, the correction is '
      + 'appended to the relation history, and the relation stops counting as active — so a contradiction it caused disappears '
      + 'from the duplicate/contradiction report without any row being deleted. '
      + 'A reason is mandatory: a correction without one cannot be reviewed six months later.',
    parameters: {
      type: 'object',
      properties: {
        parentAsin: { type: 'string', description: 'The parent ASIN of the relation being corrected.' },
        childAsin: { type: 'string', description: 'The child ASIN of the relation being corrected.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        reason: { type: 'string', description: 'Why the relation is wrong. Required.' },
        evidence: { type: 'string', description: 'What shows it is wrong.' },
        by: { type: 'string', description: 'Who corrected it. Default null.' },
      },
      required: ['parentAsin', 'childAsin', 'reason'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      try {
        const result = correctVariantRelation(store, {
          marketplace: args?.marketplace ?? 'US',
          parentAsin: args?.parentAsin,
          childAsin: args?.childAsin,
          reason: args?.reason,
          evidence: args?.evidence ?? null,
          by: args?.by ?? null,
        })
        return {
          ok: true,
          changed: result.changed,
          relation: result.relation,
          text: result.changed
            ? `已纠正关系 ${result.relation.parentAsin} → ${result.relation.childAsin}@${result.relation.marketplace}`
              + `（${result.relation.correctedAt}，原因：${result.relation.correctionReason}）。行仍在库里，历史多了一条 corrected。`
            : `关系 ${result.relation.parentAsin} → ${result.relation.childAsin} 早就是 corrected（时间与原因未改动）。`,
        }
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
        }
      }
    },
  }
}

/* ──────────────────── 竞品关系 ──────────────────── */

/**
 * 竞品 ASIN 的增删查。
 *
 * 存储是一行一个竞品（不是逗号串），因为要能反查、能带属性、能并发更新。
 * 给子 ASIN 查竞品时走「子 → 父 → 竞品」，子级声明优先于父级。
 */
export function asinCompetitorTool({ store }) {
  return {
    name: 'amzn_asin_competitor',
    description:
      'Competitor ASINs attached to a product family. One row per competitor (never a comma-joined '
      + 'field), so the relation can be searched backwards and carries its own source / rank / status. '
      + 'action="list" with `parentAsin` lists that family; with `asin` it resolves a child through its '
      + 'variant parent (child-scoped competitors override family-scoped ones). '
      + 'action="add" writes one relation; action="retire" marks it inactive instead of deleting it — '
      + '"what rank did it have last time" is history. action="reverse" answers "this competitor ASIN '
      + 'appears under which of my products". '
      + 'Nothing is deleted, and an ASIN cannot be its own competitor.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'retire', 'reverse', 'discover', 'adopt'], description: 'Default list.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        parentAsin: { type: 'string', description: 'The product (parent) ASIN.' },
        asin: { type: 'string', description: 'A child ASIN — resolved through its variant parent.' },
        competitorAsin: { type: 'string', description: 'The competitor ASIN (add / retire / reverse).' },
        scope: { type: 'string', enum: ['family', 'child'], description: 'family (default) or child.' },
        scopeAsin: { type: 'string', description: 'Required when scope=child: which child it applies to.' },
        source: { type: 'string', description: 'Where it came from: manual / sellersprite / xiyou.' },
        rankSeen: { type: 'number', description: 'Its organic rank when recorded.' },
        note: { type: 'string', description: 'Free note (also used as the retire reason).' },
        ourAsin: { type: 'string', description: 'discover: our ASIN whose keywords are used to find candidates.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'discover: limit to these keywords. Omit = the words this ASIN already competes on.' },
        limit: { type: 'number', description: 'discover: how many candidates. Default 10.' },
        write: { type: 'boolean', description: 'discover: write the candidates as suggested. Default false = preview only.' },
      },
    },
    /* 2026-10-25（R-65）：这里原来是 `text(value)` —— 把整个返回对象塞进文本渲染器。
       实测 `amzn_asin_competitor` 的返回是 `{ ok, resolved, text }`，于是用户看到的是 JSON：
         {
           "ok": true,
           "resolved": { "asin": "B0GV55Q4JG", "parents": ["B0GV55Q4JG"], … },
           "text": "ASIN B0GV55Q4JG 没有记录任何竞品。\n（解析路径：按自身作为父）"
         }
       而 `text` 字段里那句人话本来就是这个工具最该被读到的部分 —— 它连「凭什么说没有」都写好了。

       **同一个文件里其他 6 个工具（:645 / :1087 / :1155 / :1293 / :1478 / :1546）都写了
       `value?.text ?? value?.error ?? value`**，只有这一个没写。现在对齐。 */
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      const action = String(args?.action ?? 'list')
      const marketplace = String(args?.marketplace ?? 'US').toUpperCase()

      if (action === 'discover') {
        /* 自动获取：从库里已有的反查事实挑候选。**写成 suggested**，等人 adopt。 */
        try {
          const found = discoverCompetitors(store, {
            marketplace,
            ourAsin: args?.ourAsin ?? args?.parentAsin,
            keywords: Array.isArray(args?.keywords) ? args.keywords : null,
            limit: args?.limit ?? 10,
          })
          if (found.candidates.length === 0) {
            return {
              ok: true,
              ...found,
              text: '没有找到候选：这个 ASIN 的词在 kw_competitor_fact 里没有竞品排名数据。'
                + '（该表来自卖家精灵/西柚的反查导入；没有导入过就没有。）',
            }
          }
          /* D-4：机器不覆盖人工决定 —— 已有 active/inactive（人工 add/adopt、人工
             retire）的关系一条都不许被自动发现改写成 suggested：upsert 的
             ON CONFLICT 会 SET status=excluded.status，全量覆盖原状态，跑一次
             发现就让「我的竞品」静默少一个。跳过的如实报数。 */
          let skippedWrites = 0
          if (args?.write === true) {
            const parent = String(args?.ourAsin ?? args?.parentAsin ?? '').trim().toUpperCase()
            for (const candidate of found.candidates) {
              const existing = store.get(
                `SELECT status FROM asin_competitor
                  WHERE marketplace = ? AND parent_asin = ? AND competitor_asin = ? AND scope = 'family' AND scope_asin = ''`,
                [marketplace, parent, String(candidate.competitorAsin).trim().toUpperCase()],
              )
              if (existing !== undefined && existing !== null
                && (existing.status === 'active' || existing.status === 'inactive')) {
                skippedWrites += 1
                continue
              }
              upsertCompetitor(store, {
                marketplace,
                parentAsin: args?.ourAsin ?? args?.parentAsin,
                competitorAsin: candidate.competitorAsin,
                source: 'auto:library',
                rankSeen: candidate.bestRank,
                status: 'suggested',
                note: candidate.evidence,
              })
            }
          }
          const candidateLines = found.candidates.map((candidate, index) => [
            String(index + 1), candidate.competitorAsin, String(candidate.appearances),
            String(candidate.bestRank), candidate.bestKeyword,
          ])
          return {
            ok: true,
            ...found,
            written: args?.write === true,
            text: arrayTable(['#', '竞品 ASIN', '出现在几个词', '最好名次', '最好的那个词'], candidateLines)
              + (args?.write === true
                ? '\n\n已写成 suggested（**不算竞品**）。确认后调 action="adopt" 逐个采纳。'
                  + (skippedWrites > 0
                    ? '\n其中 ' + skippedWrites + ' 个候选已是竞品/已退役关系，**未改动**（机器不覆盖人工决定）。'
                    : '')
                : '\n\n以上只是预览，没有写库。要写就传 write: true。'),
          }
        } catch (error) {
          return { ok: false, error: error.message }
        }
      }

      if (action === 'adopt') {
        const done = adoptCompetitor(store, {
          marketplace,
          parentAsin: args?.parentAsin,
          competitorAsin: args?.competitorAsin,
          scope: args?.scope ?? 'family',
          scopeAsin: args?.scopeAsin ?? '',
        })
        if (!done) return { ok: false, error: 'no such suggested relation' }
        return { ok: true, text: `已采纳：${args?.parentAsin} → ${args?.competitorAsin}（suggested → active）` }
      }

      /* D-3：add 自己的块体。原结构把上面 discover / adopt 两个 if 吞进过 add 块
         （brace 追踪到 add 体末尾才闭合），discover/adopt 永远进不了各自分支、双双
         落 list 兜底 —— adopt 还会静默返回竞品列表（采纳根本没发生）。分支各归各。 */
      if (action === 'add') {
        try {
          const saved = upsertCompetitor(store, {
            marketplace,
            parentAsin: args?.parentAsin,
            competitorAsin: args?.competitorAsin,
            scope: args?.scope ?? 'family',
            scopeAsin: args?.scopeAsin ?? '',
            source: args?.source ?? 'manual',
            rankSeen: args?.rankSeen ?? null,
            note: args?.note ?? null,
          })
          return { ok: true, saved, text: `已记录竞品：${saved.parentAsin} → ${saved.competitorAsin}（${saved.scope}）` }
        } catch (error) {
          return { ok: false, error: error.message }
        }
      }

      if (action === 'retire') {
        const done = retireCompetitor(store, {
          marketplace,
          parentAsin: args?.parentAsin,
          competitorAsin: args?.competitorAsin,
          scope: args?.scope ?? 'family',
          scopeAsin: args?.scopeAsin ?? '',
          reason: args?.note ?? null,
        })
        if (!done) return { ok: false, error: 'no such active relation' }
        return { ok: true, text: `已标为失效：${args?.parentAsin} → ${args?.competitorAsin}（记录保留）` }
      }

      if (action === 'reverse') {
        const rows = competitorFamilies(store, { marketplace, competitorAsin: args?.competitorAsin })
        if (rows.length === 0) return { ok: true, families: [], text: `没有任何产品把这个 ASIN 当竞品：${args?.competitorAsin}` }
        const lines = rows.map(row => [row.parent_asin, row.scope, row.scope_asin || '—', row.source || '—', row.rank_seen ?? '—'])
        return {
          ok: true,
          families: rows,
          text: arrayTable(['父 ASIN', '范围', '子 ASIN', '来源', '记录时排名'], lines),
        }
      }

      /* list：给了 asin 就按子解析，否则按父列出 */
      if (args?.asin !== undefined && args?.asin !== null && String(args.asin).trim() !== '') {
        const resolved = familyCompetitorsFor(store, { marketplace, asin: args.asin })
        if (resolved.competitors.length === 0) {
          return {
            ok: true,
            resolved,
            text: `ASIN ${resolved.asin} 没有记录任何竞品。\n`
              + `（解析路径：${resolved.resolvedFrom === 'variant-parent' ? '经变体父 ' + resolved.parents.join('、') : '按自身作为父'}）`,
          }
        }
        const lines = resolved.details.map(row => [
          row.competitor_asin, row.parentAsin, row.scope, row.source || '—', row.rank_seen ?? '—',
        ])
        return {
          ok: true,
          resolved,
          text: `ASIN ${resolved.asin} 的竞品（${resolved.competitors.length} 个）\n`
            + `解析路径：${resolved.resolvedFrom === 'variant-parent' ? '经变体父 ' + resolved.parents.join('、') : '按自身作为父'}\n\n`
            + arrayTable(['竞品 ASIN', '所属父', '范围', '来源', '记录时排名'], lines),
        }
      }

      const rows = listCompetitors(store, { marketplace, parentAsin: args?.parentAsin })
      if (rows.length === 0) return { ok: true, competitors: [], text: `父 ASIN ${args?.parentAsin} 没有记录任何竞品。` }
      const summary = familyCompetitorRow(store, { marketplace, parentAsin: args?.parentAsin })
      const lines = rows.map(row => [
        row.competitor_asin, row.scope, row.scope_asin || '—', row.status,
        row.source || '—', row.rank_seen ?? '—', row.last_seen_at ? row.last_seen_at.slice(0, 10) : '—',
      ])
      return {
        ok: true,
        competitors: rows,
        summary,
        text: arrayTable(['竞品 ASIN', '范围', '子 ASIN', '状态', '来源', '记录排名', '最后见到'], lines)
          + (summary === null ? '' : `\n\n一行版（视图）：${summary.competitors}`),
      }
    },
  }
}

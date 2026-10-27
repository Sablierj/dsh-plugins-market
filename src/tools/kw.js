/**
 * The keyword master library tools.
 *
 * Six tools, split by *what question they answer* rather than by which module
 * they touch:
 *
 *   amzn_kw_import   put a file's data in
 *   amzn_kw_source   which files are in, and which of them count
 *   amzn_kw_merge    recompute the rollup (after excluding a file, or by hand)
 *   amzn_kw_query    what is in the library
 *   amzn_kw_export   the four SOP artefacts as CSV
 *   amzn_kw_report   the whole thing as a document
 *
 * They are deliberately separate from the step-3 keyword tools
 * (`amzn_keyword_query` / `_coverage` / `_discover` / `_scan`). Those answer
 * "where does our ASIN sit", from the browser. These answer "what do we know
 * about this word", from imported files. The two libraries share the `keyword`
 * table and nothing else, and merging the tools would make one description
 * carry two incompatible meanings of the word "keyword".
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { importDirectory, importFile } from '../domain/keywords/pipeline.js'
import { scanSourceDir, kindForFile } from '../domain/keywords/source-dir.js'
import { resolveImportDir } from '../domain/collect/profile.js'
import { DEFAULT_PIPELINE_LIMIT, MAX_PIPELINE_LIMIT, runPipeline } from '../domain/keywords/optimize-pipeline.js'
import { buildActiveSets, buildNegatives, renderMasterReport, writeActiveSets } from '../domain/keywords/export.js'
import { PRIORITY_MEANING, SV_TIERS } from '../domain/keywords/classify.js'
import { getRun, listRuns, runStats } from '../store/pipeline.js'
import { listImports, masterStats, queryMaster, recomputeMaster, setImportIncluded } from '../store/kw.js'
import { recordFileReport } from '../store/reports.js'
import { VERDICT_MEANING, rankChanges, rankSeries, rebuildRankAnalysis } from '../store/rank-observation.js'
import { deleteSchedule, getSchedule, listSchedules, saveSchedule } from '../store/scan-schedule.js'

/**
 * 把一个 ISO 时刻印成**本地时间**（R-32，2026-10-25）。
 *
 * 原来两处排班渲染都从 ISO 串里截前 16 个字符 —— **那个截断把末尾的时区标记丢掉了**，
 * 一个带时区的时刻变成了一个不带时区的字符串。
 * 而同一段回答里另一句（`每周六 03:30`，来自 `atTime`）是**本地时间**，
 * 于是读者有充分理由把这一列也读成本地时间 —— 实测差了 8 小时（还差一天）。
 *
 * **排班是「什么时候自动跑」的承诺**，按它等会等错。所以统一转成本地，并在表头/句子里标明。
 */
export function localStamp(iso) {
  if (iso === null || iso === undefined || String(iso).trim() === '') return '—'
  const when = new Date(String(iso))
  if (Number.isNaN(when.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
    + ` ${pad(when.getHours())}:${pad(when.getMinutes())}`
}
import { describeSchedule } from '../domain/keywords/schedule.js'
import { arrayTable, num, table, text, truncate } from './render.js'

/* ──────────────────────────── import ──────────────────────────── */

export function kwImportTool({ store }) {
  return {
    name: 'amzn_kw_import',
    description:
      'Import keyword data from an exported file (or a whole directory) into the master library. '
      + 'Recognised sources, detected from the filename: Amazon ABA 品牌视图 CSV, SP/SB/聚合 搜索词报告 xlsx, '
      + '卖家精灵 ASIN 反查 (xlsx / csv / sellersprite_api json), 西柚 关键词反查 xlsx, and any generic keyword list. '
      + 'This is the tool for "I exported something from Amazon / 卖家精灵 / 西柚, load it". '
      + 'Importing the same bytes twice is a no-op — a file is identified by its content hash, so a duplicated export '
      + 'cannot double every metric. Columns are found by header name, not by position, because the three ad-report '
      + 'layouts in circulation put the same field in different columns. '
      + 'Use dryRun first when the file is unfamiliar. This writes to the database. '
      + 'Omit path to import from the library\'s convention directory: the 导入目录 setting in the settings '
      + 'centre, or the built-in default when that is unset. Give path to read somewhere else — an explicit '
      + 'path always wins over the setting, so the setting can never silently redirect a named file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a file, or to a directory to import every recognised file in it. Omit to read the convention directory (the 导入目录 setting, else the built-in default).' },
        kind: {
          type: 'string',
          description: 'Force a parser: brand_terms | ad_report | competitor_sellersprite | competitor_sellersprite_json | competitor_xiyou | keyword_list. Omit to detect from the filename.',
        },
        marketplace: { type: 'string', description: 'Force a marketplace code. Omit to read it from the filename (defaults to US).' },
        recursive: { type: 'boolean', description: 'For a directory: descend into subdirectories. Default false.' },
        force: { type: 'boolean', description: 'Re-import even if these exact bytes were imported before. Facts are replaced, not accumulated.' },
        dryRun: { type: 'boolean', description: 'Parse and report without writing anything. Default false.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const given = String(args?.path ?? '').trim()
      /* No path means the convention directory — resolved by the *same* function
         the settings page prints, so "where will it read from" has one answer
         whether it is asked by the page or by this tool. The setting used to be
         displayed only; a named path still wins, which is what keeps the setting
         from quietly redirecting a file the caller actually named. */
      const convention = given === '' ? resolveImportDir(store) : null
      const path = given === '' ? convention.path : given
      const options = {
        kind: args?.kind === undefined ? undefined : String(args.kind),
        marketplace: args?.marketplace === undefined ? null : String(args.marketplace).toUpperCase(),
        force: args?.force === true,
        dryRun: args?.dryRun === true,
      }

      // A directory and a file take different paths; tell them apart by asking
      // the filesystem rather than by looking for a separator, because
      // `C:\data` and `C:\data\x.xlsx` are both valid absolute paths.
      /* 整目录导入时，**类型由子目录决定**（brand-terms → ABA、sellerjingling →
         卖家精灵……）。只在调用方没有强制 kind 时生效：显式指定永远优先。
         这一条解决的是实测到的真事故 —— `ReverseASIN-US-*.xlsx` 认不出文件名，
         退化成纯词表会把自然排名与竞品事实丢掉。 */
      const kindFor = args?.kind === undefined
        ? filePath => kindForFile(path, filePath).kind
        : null
      const asDirectory = importDirectorySafe(store, {
        dir: path, ...options, recursive: args?.recursive === true, kindFor,
      })
      if (asDirectory !== null) return renderDirectoryResult(asDirectory, { ...options, defaulted: convention !== null })

      if (convention !== null) {
        /* Nothing was named, so "it is not a directory" cannot mean "maybe it is
           a file" — the convention directory is a directory by definition.
           Falling through to importFile here would report a file-shaped error
           about a path the caller never gave, which is how the setting stayed
           invisible for so long. */
        return {
          ok: false,
          error: `约定导入目录读不到：${path}`
            + (convention.isDefault
              ? '（这是插件内置的约定路径，collect.importDir 没设过）'
              : '（collect.importDir 指向这里，但它不是一个可读目录）')
            + '。给它一个 path，或在设置中心把「导入目录」改成一个存在的目录。',
        }
      }

      const result = importFile(store, { filePath: path, ...options })
      return renderFileResult(result)
    },
  }
}

/** Try the directory path; `null` when `path` is not a readable directory. */
function importDirectorySafe(store, options) {
  try {
    return importDirectory(store, options)
  } catch (error) {
    if (/读不到目录/.test(error.message)) return null
    throw error
  }
}

function renderDirectoryResult(result, options) {
  const lines = [
    `目录导入${options.dryRun ? '（dryRun，未写库）' : ''}: ${result.dir}`
      + (options.defaulted === true ? '（没给 path，用的是约定导入目录）' : ''),
    `找到 ${result.found} 个可识别文件 —— 导入 ${result.imported}，跳过 ${result.skipped}，失败 ${result.failed}`,
    '',
  ]
  const rows = result.results.map(entry => ({
    file: truncate(entry.file, 44),
    kind: entry.kind ?? '—',
    period: entry.period ?? '—',
    market: entry.marketplace ?? '—',
    facts: entry.factsWritten ?? '—',
    master: entry.masterRows ?? '—',
    status: entry.ok === false ? `失败: ${truncate(entry.error, 40)}`
      : entry.skipped === true ? `跳过（${entry.reason}）`
        : entry.dryRun === true ? 'dryRun' : 'ok',
  }))
  lines.push(table(rows, [
    { label: '文件', value: row => row.file },
    { label: '类型', value: row => row.kind },
    { label: '周期', value: row => row.period },
    { label: '站点', value: row => row.market },
    { label: '事实', value: row => row.facts },
    { label: '主库', value: row => row.master },
    { label: '状态', value: row => row.status },
  ]))

  const problems = result.results.flatMap(entry => (entry.problems ?? []).map(problem => `${entry.file}: ${problem.code} — ${problem.detail}`))
  if (problems.length > 0) lines.push('', '解析提示:', ...problems.slice(0, 20).map(line => `- ${line}`))

  const overlaps = [...new Set(result.results.flatMap(entry => (entry.overlaps ?? []).map(pair => `${pair.a} ∩ ${pair.b}`)))]
  if (overlaps.length > 0) {
    lines.push('', '⚠️ 广告报告周期重叠（全部相加会重复计数）:')
    lines.push(...overlaps.map(line => `- ${line}`))
    lines.push('用 amzn_kw_source 把不需要的文件设为 excluded，再跑 amzn_kw_merge。')
  }

  lines.push('', '下一步: amzn_kw_query 看库，amzn_kw_report 出报告，amzn_kw_export 出 SOP 的四份 CSV。')
  return lines.join('\n')
}

function renderFileResult(result) {
  if (result.skipped === true) return result.message
  if (result.dryRun === true) {
    const counts = Object.entries(result.counts).map(([name, n]) => `${name}=${n}`).join(' ')
    return [
      `dryRun: ${result.file}`,
      `识别为 ${result.kind}${result.kindOverridden ? `（覆盖了自动判断的 ${result.detectedKind}）` : ''}，站点 ${result.marketplace}，周期 ${result.period}（${result.granularity}）`,
      result.layout === null ? '' : `广告报告版式: ${result.layout}`,
      `将写入: ${counts}`,
      result.problems.length > 0 ? `\n提示:\n${result.problems.map(p => `- ${p.code}: ${p.detail}`).join('\n')}` : '',
      '',
      `样例: ${JSON.stringify(result.sample?.first ?? {}).slice(0, 400)}`,
      '',
      '去掉 dryRun 再调用即可写入。',
    ].filter(Boolean).join('\n')
  }

  const lines = [
    `导入完成: ${result.file}`,
    `${result.kind} · 站点 ${result.marketplace} · 周期 ${result.period}（${result.granularity}）${result.layout === null ? '' : ` · 版式 ${result.layout}`}`,
    `写入事实 ${result.factsWritten} 条，涉及关键词 ${result.affectedKeywords} 个，重算主库 ${result.masterRows} 行`,
  ]
  if (result.kindOverridden) lines.push(`注意: 类型是显式指定的（${result.kind}），文件名看起来像 ${result.detectedKind}。`)
  if (result.detectionConfident === false) lines.push('注意: 文件名没有被识别成已知类型，按「通用关键词列表」处理 —— 如果不是词表，用 kind 参数指定类型重试。')
  if (result.problems.length > 0) {
    lines.push('', '解析提示:')
    lines.push(...result.problems.map(problem => `- ${problem.code}: ${problem.detail}`))
  }
  if (result.overlaps.length > 0) {
    lines.push('', '⚠️ 与已导入的广告报告周期重叠（两份都算会重复计数）:')
    lines.push(...result.overlaps.map(pair => `- ${pair.a} ∩ ${pair.b}`))
    lines.push('用 amzn_kw_source 排除不需要的文件，再跑 amzn_kw_merge。')
  }
  lines.push('', '下一步: amzn_kw_merge 全量重算，或直接 amzn_kw_query 看结果。')
  return lines.join('\n')
}

/* ──────────────────────────── sources ──────────────────────────── */

/**
 * 目录扫描的渲染。数据来自 `scanSourceDir`，与页面读的是同一份 ——
 * 页面上显示「37 个文件、未导入 37」，工具里就不可能是别的数。
 */
function renderSourceDir(scan) {
  if (scan.ok !== true) {
    return [
      `关键词数据源目录：${scan.root}`,
      '',
      '❌ 目录不可达 —— 这**不是**「0 个文件」这个答案。',
      '原因：路径不存在。WSL 可能没启动，或者 kw.sourceDir 指向了一个不存在的目录。',
      `默认路径：${scan.defaultRoot}`,
      scan.isDefault
        ? '（当前用的就是默认路径）'
        : '（当前是自定义路径；把 kw.sourceDir 清空即回到默认）',
    ].join('\n')
  }

  const lines = [
    `关键词数据源目录：${scan.root}`,
    scan.isDefault ? '（默认路径）' : '（自定义路径）',
    '',
    `${scan.counts.files} 个文件 · 未导入 ${scan.counts.new} · 已导入 ${scan.counts.imported}`
      + ` · 未识别 ${scan.counts.unrecognized}`,
    '',
    table(scan.dirs, [
      { label: '子目录', value: row => row.dir + (row.optional ? '（可选）' : '') },
      { label: '类型', value: row => row.label },
      { label: '文件', value: row => num(row.files) },
      { label: '未导入', value: row => num(row.new) },
      { label: '已导入', value: row => num(row.imported) },
      { label: '最近月份', value: row => row.latestMonth ?? '—' },
    ]),
  ]

  if (scan.missing.length > 0) {
    lines.push('', `⚠️ 缺 ${scan.missing.length} 个必需子目录：${scan.missing.join('、')}`)
    lines.push('   补齐是建空目录、不写文件 —— 这一步目前在对话里做（说「补齐缺失的目录」）。这里原来指向一个不存在的按钮（2026-10-25 守门扩面时抓到）。')
  }

  const pending = scan.files.filter(file => file.status === 'new')
  if (pending.length > 0) {
    lines.push('', `未导入的文件（前 20 个，共 ${pending.length} 个）:`)
    lines.push(...pending.slice(0, 20).map(file => (
      `- ${file.kind} · ${file.month ?? '月份未识别'} · ${file.name}`
    )))
  }

  const unknown = scan.files.filter(file => file.status === 'unrecognized')
  if (unknown.length > 0) {
    lines.push('', `⚠️ ${unknown.length} 个文件认不出类型（不猜）:`)
    lines.push(...unknown.slice(0, 10).map(file => `- ${file.name}`))
    lines.push('   把它们移到对应子目录，或在页面上手动指定类型。')
  }

  lines.push('', '要导入整个目录：amzn_kw_import 传这个路径（按内容 hash 幂等，重复导入是 no-op）。')
  return lines.join('\n')
}

export function kwSourceTool({ store }) {
  return {
    name: 'amzn_kw_source',
    description:
      'List the files that have been imported into the master library, and include or exclude each from the rollup. '
      + 'Excluding does not delete the facts — it takes that file out of the totals, which is what you need when two '
      + 'ad reports cover overlapping periods and adding both would double-count. '
      + 'After changing anything, run amzn_kw_merge to recompute. '
      + 'action="dir" instead scans the keyword **source directory** (read-only): it lists every file under the fixed '
      + 'subdirectories (brand-terms / search-terms / sellerjingling / xiyou), says which of them are already '
      + 'imported (by content hash), and names any missing subdirectory. Use it before importing a whole directory, '
      + 'so you can see what would come in.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list (default) | dir | exclude | include' },
        id: { type: 'string', description: 'Import id, for exclude / include.' },
        path: { type: 'string', description: 'Root directory for action="dir". Omit to use the configured kw.sourceDir, or its default.' },
        limit: { type: 'number', description: 'Rows for list. Default 50.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const action = String(args?.action ?? 'list').toLowerCase()

      if (action === 'dir') {
        return renderSourceDir(scanSourceDir(store, { root: args?.path ?? null }))
      }

      if (action === 'list') {
        const rows = listImports(store, { limit: args?.limit ?? 50 })
        if (rows.length === 0) {
          return '还没有导入任何文件。用 amzn_kw_import 导入（可以给一个目录，会导入里面所有能识别的文件）。'
        }
        const stats = masterStats(store, {})
        const lines = [
          `已导入 ${rows.length} 个文件:`,
          table(rows, [
            { label: 'id', value: row => truncate(row.id, 8) },
            { label: '类型', value: row => row.kind },
            { label: '文件', value: row => truncate(row.file_name, 40) },
            { label: '站点', value: row => row.marketplace },
            { label: '周期', value: row => row.period },
            /* 数据来自 `listImports`（`SELECT *`，`rows_read_missing` 自动带出）；
               这一格只负责说清楚：没记到就印「未记录」，不印 0。 */
            { label: '行', value: row => (row.rows_read_missing === 1 ? '未记录' : num(row.rows_read)) },
            { label: '事实', value: row => num(row.facts_written) },
            { label: '计入', value: row => (row.included === 1 ? '是' : '否') },
          ]),
        ]
        if (stats.overlaps.length > 0) {
          lines.push('', '⚠️ 周期重叠的广告报告（同时计入会重复计数）:')
          lines.push(...stats.overlaps.map(entry => `- ${entry.a.file_name} (${entry.a.period}) ∩ ${entry.b.file_name} (${entry.b.period})`))
        }
        lines.push('', 'exclude 一个文件后要跑 amzn_kw_merge 才会生效。')
        return lines.join('\n')
      }

      if (action !== 'exclude' && action !== 'include') {
        return { ok: false, error: `unknown action "${action}" (expected list / exclude / include)` }
      }
      const id = String(args?.id ?? '').trim()
      if (id === '') return { ok: false, error: `action=${action} needs an id (see amzn_kw_source action=list)` }

      const row = setImportIncluded(store, id, action === 'include')
      if (row === undefined) return { ok: false, error: `no import with id "${id}"` }
      const rollup = recomputeMaster(store, { marketplace: row.marketplace })
      return [
        `${action === 'include' ? '已恢复计入' : '已排除'}: ${row.file_name}（${row.period}）`,
        `已重算 ${row.marketplace} 主库 ${rollup.rows} 行。`,
        '主库总量因此变化是预期的 —— 这份文件的广告数据现在不再计入。',
      ].join('\n')
    },
  }
}

/* ──────────────────────────── merge ──────────────────────────── */

export function kwMergeTool({ store }) {
  return {
    name: 'amzn_kw_merge',
    description:
      'Recompute the keyword master library from its facts. Idempotent: it recalculates every column rather than '
      + 'accumulating, so running it twice changes nothing. '
      + 'Run it after importing, after excluding a source file, or when the facts were written by something else. '
      + 'This writes to the database (it overwrites kw_master, never the fact tables).',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Limit to one marketplace. Omit for all.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Limit to these keywords. Omit for the whole library.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const marketplace = args?.marketplace === undefined ? null : String(args.marketplace).toUpperCase()
      const keywords = Array.isArray(args?.keywords) ? args.keywords : null
      const before = masterStats(store, { marketplace })
      const rollup = recomputeMaster(store, { marketplace, keywords })
      const after = masterStats(store, { marketplace })

      const lines = [
        `重算完成: ${rollup.rows} 行（库内 ${after.total} 条关键词）`,
        `排除的文件: ${rollup.excludedFiles} 个`,
        '',
        `有搜索量 ${num(after.withVolume)} / 无搜索量 ${num(after.withoutVolume)}`,
        `有 ABA ${num(after.withAba)} · 有广告 ${num(after.withAd)} · 有竞品 ${num(after.withCompetitor)}`,
        `产品线未分类（落到默认线）${num(after.productLineDefaulted)}`,
      ]
      if (before.total > 0) lines.push(`（重算前 ${before.total} 条）`)

      const dist = (label, groups) => {
        if (groups.length === 0) return null
        return `${label}: ${groups.map(group => `${group.key ?? '未分类'}=${num(group.n)}`).join('  ')}`
      }
      for (const line of [
        dist('漏斗', after.byFunnel),
        dist('层级', after.bySvTier),
        dist('优先级', after.byPriority),
        dist('机会', after.byOpportunity),
        dist('我方存在', after.byOwnStatus),
        dist('产品线', after.byProductLine),
      ]) if (line !== null) lines.push(line)

      if (after.overlaps.length > 0) {
        lines.push('', '⚠️ 周期重叠的广告报告（当前都计入，总量会重复）:')
        lines.push(...after.overlaps.map(entry => `- ${entry.a.file_name} (${entry.a.period}) ∩ ${entry.b.file_name} (${entry.b.period})`))
        lines.push('用 amzn_kw_source action=exclude 排除其中一个。')
      }
      return lines.join('\n')
    },
  }
}

/* ──────────────────────────── query ──────────────────────────── */

export function kwQueryTool({ store }) {
  return {
    name: 'amzn_kw_query',
    description:
      'Query the keyword master library — kw_master, the large imported library (currently ~30,778 rows from ABA / ad reports / '
      + '卖家精灵 / 西柚). One row per (keyword, marketplace) with search volume, ad performance, funnel stage, volume tier, '
      + 'priority, and whether competitors rank for it. This is the library-level view and the default meaning of '
      + '"关键词总库". For the legacy 16-row per-ASIN association table use amzn_keyword_query (facade action query_asin); '
      + 'for "where does MY ASIN sit", use amzn_keyword_coverage. '
      + 'A word with searchVolume null means no source supplied a volume — it is not zero.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US. Omit for all.' },
        q: { type: 'string', description: 'Substring match over the keyword.' },
        productLine: { type: 'string', description: 'Product line id, e.g. bench-cushion / rocker-cushion.' },
        funnel: { type: 'string', description: 'TOFU | MOFU | BOFU' },
        svTier: { type: 'string', description: 'L1 | L2 | L3 | L4 | L5' },
        priority: { type: 'string', description: 'P0 | P1 | P2' },
        opportunity: { type: 'string', description: 'high | medium | low — volume weighted by how absent we are.' },
        ownStatus: { type: 'string', description: 'strong | moderate | weak | none — our ABA share.' },
        source: { type: 'string', description: 'Only words with this source: brand_aba | ad_report | sellersprite | xiyou | manual' },
        hasAba: { type: 'boolean', description: 'Only words with / without ABA data.' },
        hasAd: { type: 'boolean', description: 'Only words with / without ad data.' },
        hasCompetitor: { type: 'boolean', description: 'Only words with / without competitor data.' },
        minVolume: { type: 'number', description: 'search_volume >= this. Excludes words with no volume.' },
        maxVolume: { type: 'number', description: 'search_volume <= this.' },
        forListing: { type: 'string', description: 'Only words flagged for one place: title | bullets | backend | adsExact | adsPhrase | adsBroad' },
        order: { type: 'string', description: 'volume (default) | updated | keyword | priority | opportunity | spend | orders | competitors' },
        limit: { type: 'number', description: 'Rows to return. Default 30, max 1000.' },
        offset: { type: 'number', description: 'Rows to skip. Default 0.' },
        stats: { type: 'boolean', description: 'Include the library-wide distribution summary. Default false.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const result = queryMaster(store, args ?? {})
      const lines = []

      if (args?.stats === true) {
        const stats = masterStats(store, { marketplace: args?.marketplace ?? null })
        /* 2026-10-25（R-76）：`masterStats` 的签名只接 `marketplace`（store/kw.js:967），**不认 productLine**。
           于是带 productLine 调这个工具时，下面四行仍是站点全库的数，而表头那张表印的是「1/17,978」。
           实测（US + bench-cushion + stats:true + limit:1）：
             库内 30,778 条 · 有搜索量 12,336 · 无搜索量 18,442   ← 全库
             关键词总库 (1/17,978 条，offset=0)                    ← 只有 bench-cushion
           两个数并排、口径不同，读者会把 30,778 当成这次筛选的样本量。
           所以这里明写适用范围 —— 与 `amzn_asin_query` 那句「全库已归档: … （全库口径，不随上面的筛选变）」
           同一个句法：一个不随筛选变的数，必须自己说出来。 */
        const scopedLine = String(args?.productLine ?? '').trim()
        if (scopedLine !== '') {
          lines.push(`⚠ 下面四行是**站点全库**口径 —— \`masterStats\` 不接产品线筛选，所以它们不是本次「${scopedLine}」范围的数；本次样本量看下面表格标题里的「/N」。`)
        }
        lines.push(
          `库内 ${num(stats.total)} 条 · 有搜索量 ${num(stats.withVolume)} · 无搜索量 ${num(stats.withoutVolume)}`,
          `有 ABA ${num(stats.withAba)} · 有广告 ${num(stats.withAd)} · 有竞品 ${num(stats.withCompetitor)} · 仅人工列出 ${num(stats.listedOnly)}`,
          `产品线未分类 ${num(stats.productLineDefaulted)} 条（落到默认产品线）`,
          `广告合计: 曝光 ${num(stats.totalImpressions)} · 点击 ${num(stats.totalClicks)} · 订单 ${num(stats.totalOrders)} · 花费 ${num(Math.round(stats.totalSpend))} · 销售额 ${num(Math.round(stats.totalSales))}`,
        )
        const dist = (label, groups) => (groups.length === 0 ? null : `${label}: ${groups.map(group => `${group.key ?? '未分类'}=${num(group.n)}`).join('  ')}`)
        for (const line of [
          dist('产品线', stats.byProductLine),
          dist('漏斗', stats.byFunnel),
          dist('层级', stats.bySvTier),
          dist('优先级', stats.byPriority),
          dist('机会', stats.byOpportunity),
        ]) if (line !== null) lines.push(line)
        if (stats.overlaps.length > 0) {
          lines.push(`⚠️ ${stats.overlaps.length} 对广告报告周期重叠 —— 总量可能重复计数，见 amzn_kw_source。`)
        }
        lines.push('')
      }

      if (result.rows.length === 0) {
        lines.push(
          `没有匹配的关键词（库内共 ${num(result.total)} 条符合条件）。`,
        )
        if (result.total !== 0 || args?.stats === true) {
          lines.push('放宽筛选条件再试，或加 stats=true 看整体分布。')
        } else {
          /* 同上：说清「哪一本册子是空的」，别把两个库混成一句「库为空」。 */
          const tracked = store.get('SELECT COUNT(*) AS n FROM keyword WHERE marketplace = ?',
            [String(args?.marketplace ?? 'US').toUpperCase()])
          const trackedCount = Number(tracked === null || tracked === undefined ? 0 : tracked.n)
          if (trackedCount > 0) {
            lines.push(`注意：SOP 词库（kw_master）是空的，但关键词总库（keyword）里有 ${trackedCount} 条。`)
            /* 2026-10-21 实测改正：`recomputeMaster` 本来就会把 `keyword` 里的词并进
               kw_master（store/kw.js:371-393 那段注释写得很清楚）。所以"两边没有桥"
               是假的，"要先导入 ABA" 也是多余的 —— 跑一次 merge 就能有词，
               只是搜索量为空（没导入过 ABA，就没有量）。 */
            lines.push('跑一次 amzn_kw_merge 就会把这批词并进 SOP 词库 —— 不需要先导入任何文件。')
            lines.push('（搜索量会是空的：那是 ABA / 广告报表才有的数，没导入过就没有，不是 0。）')
          } else {
            lines.push('库为空时先用 amzn_kw_import 导入文件（可以给一个目录）。')
          }
        }
        return lines.join('\n')
      }

      lines.push(`关键词总库 (${result.rows.length}/${num(result.total)} 条，offset=${result.offset}):`)
      lines.push(table(result.rows, [
        { label: '关键词', value: row => truncate(row.keyword, 36) },
        { label: '站点', value: row => row.marketplace },
        { label: '搜索量', value: row => num(row.search_volume) },
        { label: '层级', value: row => row.sv_tier ?? '' },
        { label: '优先级', value: row => row.priority ?? '' },
        { label: '漏斗', value: row => row.funnel ?? '' },
        { label: '曝光', value: row => num(row.impressions) },
        { label: '订单', value: row => num(row.orders) },
        { label: '花费', value: row => (row.spend > 0 ? Math.round(row.spend) : '') },
        { label: 'CVR%', value: row => (row.cvr_pct === null ? '' : Number(row.cvr_pct).toFixed(2)) },
        { label: '竞品最好', value: row => (row.competitor_best_rank === null ? '' : `#${row.competitor_best_rank}`) },
        /* 2026-10-25（R-68）：这一格原来只印 `product_line`，于是两种完全不同的情况长得一模一样：
             ① 分类器命中信号（"patio furniture set" 命中「patio」）→ 真的判给了这条线；
             ② **一个信号都没命中，于是落到默认线**（"chair" 就是这种）。
           实测 `amzn_keyword_product_line_get("chair")` 明说「未分类 = 没有任何产品线信号命中，
           于是落到默认线 —— 不是『属于默认线』」，而总库表格里它印的是光秃秃的 `bench-cushion`。

           头部那行「产品线未分类 N 条（落到默认产品线）」是汇总，读者很难把 3,386 这个数
           对回眼前的某一行；而「chair 归到长凳垫」这种结论一旦被当真，就会拿着它去做
           关键词分配、做 listing 与广告。

           **所以只给「未分类」这一种加标记** —— 依据是 `kw_master.product_line_matched IS NULL`，
           纯净可判。至于「人工 / 自动」的区分这里**不印**：人工归属存在 `keyword_product_line`
           表里，`kw_master` 看不到，硬猜会造出第二个错。 */
        { label: '产品线', value: row => {
          const line = String(row.product_line ?? '')
          if (line === '') return ''
          const unclassified = row.product_line_matched === null || row.product_line_matched === undefined
          return unclassified ? `${line}（未分类·默认线）` : line
        } },
        { label: '来源', value: row => row.sources_json ?? '' },
      ]))
      lines.push('', `层级: ${SV_TIERS.map(tier => tier.label).join(' < ')}（按搜索量分档，L5 含无搜索量的词）`)
      lines.push(`优先级: ${Object.entries(PRIORITY_MEANING).map(([key, meaning]) => `${key}=${meaning}`).join('；')}`)
      lines.push('提示: 这里的「层级」是搜索量分档；浏览器扫出来的 T1–T4 分层在 amzn_keyword_query 里。')
      return lines.join('\n')
    },
  }
}

/* ──────────────────────────── export ──────────────────────────── */

export function kwExportTool({ store, dataDir }) {
  return {
    name: 'amzn_kw_export',
    description:
      'Turn the master library into the SOP\'s application sets and write them as CSV files: 标题关键词 / 五点关键词 / '
      + '后台搜索词 / 广告精确·词组·广泛匹配, plus a 否定词建议 list (spend with no orders). '
      + 'The rules are SOP §6.1–6.4, and the backend set is additionally cut at the 249-byte field budget with '
      + 'title/bullet words removed — a flag cannot know either, so the export is where those two constraints land. '
      + 'Returns the file paths and the counts. This writes CSV files to disk.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        productLine: { type: 'string', description: 'Product line id. Omit for every word on the marketplace.' },
        outDir: { type: 'string', description: 'Directory to write into. Default <plugin data>/exports.' },
        purpose: { type: 'string', description: 'all (default) | title | bullets | backend | ads | negatives' },
        limit: { type: 'number', description: `Max words considered, in volume order. Default and cap ${SET_SCAN_LIMIT}. The report uses the same number, so the two artefacts agree.` },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const marketplace = String(args?.marketplace ?? 'US').toUpperCase()
      const productLine = args?.productLine === undefined ? null : String(args.productLine)
      const purpose = String(args?.purpose ?? 'all').toLowerCase()
      const limit = Math.min(Math.max(Number(args?.limit) || SET_SCAN_LIMIT, 1), SET_SCAN_LIMIT)

      const rows = collectRows(store, { marketplace, productLine, limit })
      if (rows.length === 0) {
        /* 「kw_master 为空」与「关键词库为空」不是一件事。2026-10-20 走查里
           amzn_keyword_discover 刚写进 16 条（表 keyword），这里却报「库内没有关键词」——
           读起来像一条都没导入过，运营会去重新找 ABA 文件，而不是发现断的是两个库之间。 */
        const tracked = store.get('SELECT COUNT(*) AS n FROM keyword WHERE marketplace = ?', [marketplace])
        const trackedCount = Number(tracked === null || tracked === undefined ? 0 : tracked.n)
        const lines = [`${marketplace}${productLine === null ? '' : ` / ${productLine}`} 的 SOP 词库（kw_master）里没有词。`]
        if (trackedCount > 0) {
          lines.push(`但关键词总库（keyword）里有 ${trackedCount} 条 —— 那是模块 08 的词，`
            + '测排名与分层用的是它；SOP 导出用的是 kw_master。')
          /* 上一版这里写着"两者之间目前没有自动桥接"，那是错的：
             `recomputeMaster`（store/kw.js:371-393）本来就收 `keyword` 里那些
             没有任何事实文件的行。2026-10-21 在真库副本上验证：16 词 → merge → 16 行。 */
          lines.push('跑一次 amzn_kw_merge 就会把它们并进 SOP 词库 —— 不需要先导入文件。')
          lines.push('搜索量会是空的（ABA / 广告报表才有的数），has_aba / has_ad 也会是 0 —— '
            + '这不是"量是 0"，是"没导入过"。')
        } else {
          lines.push('先用 amzn_kw_import 导入文件。')
        }
        return lines.join('\n')
      }

      const outDir = args?.outDir === undefined
        ? join(dataDir ?? process.cwd(), 'exports')
        : String(args.outDir)

      /* One writer, shared with the pipeline orchestrator — see
         writeActiveSets. Writing the CSVs here and again there would be two
         implementations of the same artefact, and the two files would drift the
         first time a column was added to one of them. The unknown-purpose error
         comes back as a value rather than a throw, which is what the tools
         contract asks for. */
      let built
      let written
      try {
        built = writeActiveSets({ rows, outDir, purpose, marketplace, productLine })
        written = built.files
      } catch (error) {
        return { ok: false, error: error.message }
      }

      /* Index every CSV that was written, so the report centre can list the
         exports and not only the optimisation runs. One row per file: the
         registry's invariant is that a row points at something openable, and the
         directory these land in is not a document. Idempotent on the path, so
         re-running today's export updates these rows instead of adding a second
         set of them. */
      for (const entry of written) {
        recordFileReport(store, {
          kind: 'kw-export',
          file: entry.file,
          title: `${marketplace}${productLine === null ? '' : ` / ${productLine}`} · ${entry.label}`,
          scope: { marketplace, productLine, set: entry.id },
        })
      }

      const lines = [
        `导出完成: ${marketplace}${productLine === null ? '' : ` / ${productLine}`}，候选 ${num(rows.length)} 条`,
        `目录: ${outDir}`,
        '',
        table(written, [
          { label: '集合', value: row => row.label },
          { label: '词数', value: row => num(row.count) },
          { label: '规则', value: row => truncate(row.rule, 46) },
          { label: '文件', value: row => truncate(row.file.split(/[\\/]/).pop(), 40) },
        ]),
        '',
        `后台搜索词占用 ${built.backend.bytes}/${built.backend.budget} 字节`
        + (built.backend.overflow > 0 ? `，有 ${built.backend.overflow} 个词没放下（按搜索量从低到高落选）` : '，全部装得下'),
      ]
      if (built.backend.overflowSample.length > 0) {
        lines.push(`落选示例: ${built.backend.overflowSample.join(' | ')}`)
      }
      lines.push('', '提醒: 这些是候选集，不是可以直接粘贴的成品 —— 标题/五点的最终措辞还要过 amzn_optimize_validate。')
      return lines.join('\n')
    },
  }
}

/**
 * How far down the library the application sets and the negative list are
 * computed.
 *
 * Shared by the export and the report on purpose. They were separate numbers
 * (5,000 and 20,000), which made the report say "668 suggested negatives" while
 * the CSV the user then opened held 746 — the same question answered twice with
 * two different answers, and nothing on either artefact to say which was right.
 * One constant, so they cannot drift.
 */
export const SET_SCAN_LIMIT = 50_000

/** Rows in volume order, without a page cap — the sets need the whole line. */
function collectRows(store, { marketplace, productLine, limit }) {
  const rows = []
  const pageSize = 1000
  for (let offset = 0; offset < limit; offset += pageSize) {
    const page = queryMaster(store, {
      marketplace,
      productLine: productLine ?? undefined,
      order: 'volume',
      limit: Math.min(pageSize, limit - offset),
      offset,
    })
    rows.push(...page.rows)
    if (page.rows.length < pageSize) break
  }
  return rows
}

/* ──────────────────────────── report ──────────────────────────── */

export function kwReportTool({ store, dataDir }) {
  return {
    name: 'amzn_kw_report',
    description:
      'Generate a self-contained HTML report of the keyword master library: coverage boundaries, distributions, '
      + 'top words by volume and by spend, opportunity words, competitor coverage, and suggested negatives. '
      + 'The report has no scripts and no external references, so it opens from disk and can be forwarded as-is. '
      + 'Every section states where its numbers came from, including what is missing. '
      + 'This writes an HTML file and returns its path.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        productLine: { type: 'string', description: 'Limit to one product line. Omit for all.' },
        outDir: { type: 'string', description: 'Directory to write into. Default <plugin data>/reports.' },
        topN: { type: 'number', description: 'Rows per ranking section. Default 30.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const marketplace = String(args?.marketplace ?? 'US').toUpperCase()
      const productLine = args?.productLine === undefined ? null : String(args.productLine)
      const topN = Math.min(Math.max(Number(args?.topN) || 30, 5), 200)

      const stats = masterStats(store, { marketplace })
      if (stats.total === 0) {
        return [
          `${marketplace} 的库是空的，没有可报告的内容。`,
          '先用 amzn_kw_import 导入（可以给目录），再跑这个工具。',
        ].join('\n')
      }

      const scope = productLine === null ? {} : { productLine }
      const topVolume = queryMaster(store, { marketplace, ...scope, order: 'volume', limit: topN }).rows
      const topSpend = queryMaster(store, { marketplace, ...scope, order: 'spend', limit: topN }).rows
      const competitorTop = queryMaster(store, { marketplace, ...scope, order: 'competitors', limit: topN }).rows
      const opportunities = queryMaster(store, { marketplace, ...scope, opportunity: 'high', order: 'volume', limit: topN }).rows
      // Same scan limit as the export — see SET_SCAN_LIMIT.
      const scan = collectRows(store, { marketplace, productLine, limit: SET_SCAN_LIMIT })
      const negatives = buildNegatives(scan)
      const sets = buildActiveSets(scan)

      const html = renderMasterReport({
        stats, sets, negatives, topVolume, topSpend, opportunities, competitorTop, marketplace, productLine,
      })

      const outDir = args?.outDir === undefined
        ? join(dataDir ?? process.cwd(), 'reports')
        : String(args.outDir)
      mkdirSync(outDir, { recursive: true })
      const file = join(outDir, `keyword-master-${[marketplace, productLine].filter(Boolean).join('-')}-${new Date().toISOString().slice(0, 10)}.html`)
      writeFileSync(file, html, 'utf8')

      /* Index it. This is the "kw 报告" half of the report centre: without this
         the page could list optimisation runs and nothing the keyword library
         produced, which is exactly the gap B07's first acceptance criterion
         describes. Idempotent on the path, so re-running today's report replaces
         its entry rather than adding a second one for the same file. */
      recordFileReport(store, {
        kind: 'kw-report',
        file,
        title: `关键词总库报告 ${marketplace}${productLine === null ? '' : ` / ${productLine}`}`,
        scope: { marketplace, productLine },
      })

      return [
        `报告已生成: ${file}`,
        `${marketplace}${productLine === null ? '' : ` / ${productLine}`} · 库内 ${num(stats.total)} 条 · 有搜索量 ${num(stats.withVolume)} / 无 ${num(stats.withoutVolume)}`,
        // The scan count is printed because it is what the application sets and
        // the negative list were computed over. Without it, a report and a CSV
        // produced from the same library could disagree on the count and
        // neither artefact would say why.
        `机会词 ${opportunities.length} 条（Top ${topN} 已入报告）· 否定词建议 ${negatives.length} 条 · 应用集按搜索量扫描前 ${num(scan.length)} 条`,
        stats.overlaps.length > 0 ? `⚠️ 有 ${stats.overlaps.length} 对广告报告周期重叠，报告里已列出。` : '',
        '',
        '报告里第一节是「数据边界」—— 先说清楚哪些数字是缺的，再给结论。',
      ].filter(Boolean).join('\n')
    },
  }
}

/* ──────────────────────────── pipeline ──────────────────────────── */

/**
 * The five stages, run as one run.
 *
 * This tool exists because the stages were already there and nothing called
 * them together. `amzn_kw_export` did the last step, `amzn_optimize_prepare`
 * did the middle two, and the first two had no caller at all — so "the pipeline"
 * was a diagram, not something you could run or look back at.
 *
 * It answers the same question `amzn_kw_export` answers, with one difference
 * that matters: it writes down what each stage let through, so the numbers on a
 * CSV can be traced back to the run that produced it.
 */
export function kwPipelineRunTool({ store, dataDir }) {
  return {
    name: 'amzn_kw_pipeline_run',
    description:
      'Run the keyword pipeline end to end and record it: filter the master library → count the volume tiers → assign each '
      + 'word a position → decide which field it lands in → write the SOP CSV sets. '
      + 'The five steps already existed separately; this runs them as one run and records what each step let through, so '
      + '"what did that run actually do" has an answer afterwards. '
      + 'Returns the per-stage counts, the run id, and the files written. Use amzn_kw_pipeline_history to read past runs. '
      + 'dryRun=true runs all five steps but writes no file and records no run — the "look before you commit" path. '
      + 'The counts describe the library as it is now: running again later with the same parameters gives different numbers '
      + 'once new files have been imported. '
      + 'This writes CSV files and a run record.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: '站点代码，默认 US。' },
        productLine: { type: 'string', description: '产品线 id；省略 = 该站点全部。' },
        minVolume: { type: 'number', description: '只保留搜索量 >= 此值的词。' },
        svTier: { type: 'string', description: 'L1 | L2 | L3 | L4 | L5，见 classify.js SV_TIERS。' },
        opportunity: { type: 'string', description: 'high | medium | low。' },
        limit: { type: 'number', description: `进入管道的词数上限，默认 ${DEFAULT_PIPELINE_LIMIT}，最大 ${MAX_PIPELINE_LIMIT}。` },
        purpose: { type: 'string', description: 'all | title | bullets | backend | ads | negatives，默认 all。' },
        outDir: { type: 'string', description: 'CSV 输出目录；默认 <plugin data>/exports。' },
        dryRun: { type: 'boolean', description: '跑完五步但不写文件、不落 run 行，只回每步进出数。默认 false。' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const outDir = args?.outDir === undefined
        ? join(dataDir ?? process.cwd(), 'exports')
        : String(args.outDir)
      try {
        const result = runPipeline(store, {
          marketplace: args?.marketplace ?? 'US',
          productLine: args?.productLine,
          minVolume: args?.minVolume,
          svTier: args?.svTier,
          opportunity: args?.opportunity,
          limit: args?.limit,
          purpose: args?.purpose,
          outDir,
          dryRun: args?.dryRun === true,
          trigger: 'tool',
        })
        return renderPipelineRun(result)
      } catch (error) {
        /* The run was already recorded as failed inside runPipeline, before the
           error travelled here — so the history shows the breakage even though
           this returns a plain failure. Say that, rather than implying nothing
           happened. */
        return {
          ok: false,
          error: error.message,
          hint: '这次运行已作为 failed 记进 kw_pipeline_run（用 amzn_kw_pipeline_history 可以回看是哪一步断的）。'
            + 'CSV 目录里可能已有这次写出的文件，重跑前先看一眼。',
        }
      }
    },
  }
}

function renderPipelineRun(result) {
  const scope = `${result.marketplace}${result.productLine === null ? '' : ` / ${result.productLine}`}`
  const lines = [
    `${result.dryRun === true ? '试跑完成（未写文件、未落库）' : '运行完成'} · ${scope}`,
  ]

  /* The run id is printed in full, not truncated. It is the handle to the run —
     the only value `amzn_kw_pipeline_history`'s `runId` parameter accepts — and a
     truncated one is a handle nobody can turn. Printing eight characters here and
     accepting a 36-character uuid there made the parameter unreachable: the list
     truncated too, so no output anywhere supplied a usable value. */
  if (result.runId !== null) {
    lines.push(`run ${result.runId}`, '（这个 id 原样传给 amzn_kw_pipeline_history 的 runId 可以看逐步明细）')
  }

  lines.push(
    '',
    table(result.stages, [
      { label: '#', value: row => row.seq },
      { label: '阶段', value: row => row.label },
      { label: '进', value: row => num(row.inputCount) },
      { label: '出', value: row => num(row.outputCount) },
      { label: '状态', value: row => row.status },
    ]),
    '',
    `合计: 进 ${num(result.totals.inputCount)} → 出 ${num(result.totals.outputCount)} 行 CSV`,
  )

  if (result.dryRun === true) {
    lines.push('', '这是试跑：CSV 没写、run 没落库。去掉 dryRun 再调用即可真的跑一次。')
  } else {
    lines.push('', `产物 ${result.files.length} 个文件:`)
    lines.push(table(result.files, [
      { label: '集合', value: row => row.label },
      { label: '行数', value: row => num(row.rows) },
      { label: '文件', value: row => truncate(String(row.path).split(/[\\/]/).pop(), 40) },
    ]))
  }

  lines.push('', result.message)
  return lines.join('\n')
}

/**
 * What previous runs did.
 *
 * The failed ones are listed alongside the successful ones and counted
 * separately, because a history that quietly drops the breakages is worse than
 * no history: it reads as "it has always worked".
 */
export function kwPipelineHistoryTool({ store }) {
  return {
    name: 'amzn_kw_pipeline_history',
    description:
      'Read the keyword pipeline\'s run log: which runs happened, with which parameters, how many rows each stage let '
      + 'through, and which runs failed. Pass runId to see one run stage by stage. '
      + 'Use it to answer "when did this last run", "why is this CSV different from last week\'s", and "which step broke". '
      + 'Read-only.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: '只看这个站点。省略 = 全部。' },
        limit: { type: 'number', description: '返回条数，默认 10。' },
        runId: {
          type: 'string',
          description: '只看这一次运行（含逐步明细与参数）。完整 id 从 amzn_kw_pipeline_run 的输出取，或从下面列表的「run」列取。',
        },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const runId = String(args?.runId ?? '').trim()
      if (runId !== '') {
        const run = getRun(store, runId)
        if (run === null) return { ok: false, error: `没有 id 为 "${runId}" 的管道运行（用不带 runId 的调用列最近几次）` }
        return renderRunDetail(run)
      }

      const marketplace = args?.marketplace === undefined ? null : String(args.marketplace).toUpperCase()
      const stats = runStats(store, { marketplace })
      if (stats.total === 0) {
        return [
          `${marketplace === null ? '' : `${marketplace} 上`}还没有跑过关键词管道。`,
          '用 amzn_kw_pipeline_run 跑一次（可以先加 dryRun=true 只看每步进出数，不写文件）。',
        ].join('\n')
      }

      const listed = listRuns(store, { marketplace, limit: args?.limit ?? 10 })
      const lines = [
        `最近 ${listed.rows.length} 次运行（共 ${num(stats.total)} 次，其中失败 ${num(stats.failed)} 次）:`,
        table(listed.rows, [
          /* The full id, not eight characters of it. This table is the index into
             the run log, and a key that cannot be typed back into `runId` is not
             an index — see the note on renderPipelineRun. */
          { label: 'run', value: row => row.runId },
          { label: '开始', value: row => String(row.startedAt).slice(0, 19).replace('T', ' ') },
          { label: '站点', value: row => row.marketplace },
          { label: '产品线', value: row => row.productLine ?? '全部' },
          { label: '进', value: row => num(row.inputCount) },
          { label: '出', value: row => num(row.outputCount) },
          /* 2026-10-25（R-39）：**同一张表里「进」相同、「出」却差 747 条，而这里没有任何一列
             能解释它。** 实测两次运行：
                 12:02:44  进 17,978 → 出 1,827
                 12:20:15  进 17,978 → 出 1,080
             查 runId 明细才看到参数快照里有 `limit: 5000` —— 第 1 步「筛选 17,978 → 5,000」
             就是被它截断的。**两次的 limit 很可能不同**（或 purpose 不同），
             但历史列表只印进/出，于是差 747 条永远是个谜。

             `num_cap` 这一列就是那个被隐去的关键参数。取不到时印 `—` ——
             **宁可承认不知道，也不让读者以为两次运行一模一样。** */
          { label: '上限', value: row => {
            let params = row.params ?? row.paramsJson ?? null
            if (typeof params === 'string') { try { params = JSON.parse(params) } catch { params = null } }
            const cap = params?.limit ?? row.limit ?? null
            return cap === null || cap === undefined ? '—' : num(cap)
          } },
          { label: '状态', value: row => (row.status === 'failed' ? `失败: ${truncate(row.error ?? '', 30)}` : row.status) },
        ]),
      ]
      if (stats.failed > 0) {
        lines.push('', `⚠️ 有 ${num(stats.failed)} 次运行失败。失败的运行也留在记录里 —— 用 runId 看是哪一步断的。`)
      }
      lines.push('', '看某一次的逐步明细与参数: 把上表某一行的 run 列整段原样传给 runId 再调一次。')
      return lines.join('\n')
    },
  }
}

function renderRunDetail(run) {
  const scope = `${run.marketplace}${run.productLine === null ? '' : ` / ${run.productLine}`}`
  const lines = [
    `运行 ${run.runId} · ${scope} · ${run.status === 'failed' ? '失败' : '完成'}`,
    `开始 ${String(run.startedAt).slice(0, 19).replace('T', ' ')} · 结束 ${String(run.finishedAt ?? '').slice(0, 19).replace('T', ' ')} · 触发 ${run.trigger}`,
  ]
  if (run.error !== null && run.error !== undefined && run.error !== '') lines.push(`失败原因: ${run.error}`)
  lines.push(
    '',
    table(run.stages ?? [], [
      { label: '#', value: row => row.seq },
      { label: '阶段', value: row => row.label },
      { label: '进', value: row => num(row.inputCount) },
      { label: '出', value: row => num(row.outputCount) },
      { label: '状态', value: row => row.status },
    ]),
    '',
    `参数快照: ${JSON.stringify(run.params)}`,
  )
  if (run.result?.files !== undefined && run.result.files !== null) {
    lines.push('产物:')
    lines.push(...run.result.files.map(file => `- ${file.rows} 行 → ${file.path}`))
  }
  lines.push('', '这些数字是按当时的库与这些参数算出的；库变了，同样的参数会得到不同的数。')
  return lines.join('\n')
}

/* ──────────────────── 排名观测历史（监控） ──────────────────── */

/**
 * 某词在某 ASIN 上的排名曲线，或该 ASIN 下所有词的「这次 vs 上次」。
 *
 * 为什么单独一个工具而不是塞进 `amzn_keyword_coverage`：coverage 回答"现在盖没盖住"，
 * 这个回答"变了多少"。两个问题的时间尺度不同 —— 前者看快照，后者看曲线。
 */
export function kwRankHistoryTool({ store }) {
  return {
    name: 'amzn_kw_rank_history',
    description:
      'Rank history for one ASIN: what changed since the last scan. '
      + 'Pass `keyword` to get that one word\'s full curve; omit it to get every watched word\'s '
      + 'latest vs previous observation. '
      + 'Two kinds of "no rank" are kept apart: `found = 0` with a scan depth means "scanned and not '
      + 'in the first N", while having no observation at all means "not scanned that day" — they look '
      + 'the same as a null rank but are different facts. '
      + 'Ad rank is not collected yet (the scan reads organic placements only); it is reported as '
      + '未采集, never as 0.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'ASIN to read (required).' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        keyword: { type: 'string', description: 'Optional: one keyword, returns its full series.' },
        limit: { type: 'number', description: 'Rows. Default 50.' },
        rebuild: { type: 'boolean', description: 'Rebuild the analysis table from the raw observations first.' },
      },
      required: ['asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const asin = String(args?.asin ?? '').trim().toUpperCase()
      if (asin === '') return { ok: false, error: 'asin is required' }
      const marketplace = String(args?.marketplace ?? 'US').toUpperCase()
      const limit = Math.min(Math.max(Number(args?.limit ?? 50), 1), 500)
      /* 分析表是明细的汇总；明细被手工改动或迁移后缺行时，用 rebuild 重算一遍。 */
      if (args?.rebuild === true) {
        const built = rebuildRankAnalysis(store, { marketplace })
        return { ok: true, rebuilt: built, text: '已重建分析表：' + built.rows + ' 个 (词, ASIN) 行（来自 ' + built.keys + ' 组明细）' }
      }
      const keyword = String(args?.keyword ?? '').trim()

      if (keyword !== '') {
        const series = rankSeries(store, { keyword, marketplace, asin, limit })
        if (series.length === 0) {
          return {
            ok: true,
            asin,
            marketplace,
            keyword,
            series: [],
            note: `没有观测记录 —— 「没扫过」，不是「没排名」。`,
          }
        }
        const lines = series.map(row => [
          row.observed_on,
          row.found === 1 ? String(row.organic_rank) : '未进前 ' + String(row.scan_depth ?? '?'),
          row.ad_rank === null ? '未采集' : String(row.ad_rank),
        ])
        return {
          ok: true,
          asin,
          marketplace,
          keyword,
          series,
          text: `排名曲线 · ${keyword} · ${asin}（${marketplace}）\n\n`
            + arrayTable(['日期', '自然排名', '广告排名'], lines),
        }
      }

      const changes = rankChanges(store, { marketplace, asin, limit })
      if (changes.length === 0) {
        return { ok: true, asin, marketplace, changes: [], note: '这个 ASIN 还没有任何观测记录。' }
      }
      const lines = changes.map(row => [
        row.keyword.length > 34 ? row.keyword.slice(0, 33) + '…' : row.keyword,
        row.latestRank === null ? '未进前 ' + String(row.scanDepth ?? '?') : String(row.latestRank),
        row.previousRank === null ? '—' : String(row.previousRank),
        row.delta === null ? '—' : (row.delta > 0 ? '+' + row.delta : String(row.delta)),
        VERDICT_MEANING[row.verdict] ?? row.verdict,
        row.latestOn,
      ])
      return {
        ok: true,
        asin,
        marketplace,
        changes,
        text: `排名变化 · ${asin}（${marketplace}）· 共 ${changes.length} 个词\n\n`
          + arrayTable(['关键词', '本次', '上次', '变化', '结论', '观测日'], lines)
          + '\n\n「本次/上次」是名次数字，越小越好；「未进前 N」表示扫了前 N 名没有它，'
          + '与「没扫过」是两件事（没扫过不会有这一行）。广告排名当前未采集。'
          /* 2026-10-25（R-69）：这一行原来没有，于是「共 N 个词」被读成「我们只测过 N 个词」。
             实测 B0GV55Q4JG：
               kw_rank_observation（本工具读的表）= 1 行（bench cushion，2026-10-25）
               asin_keyword（覆盖页读的表）    = 8 行，其中 custom bench cushion outdoor 排名 32
             **两个数都对，但它们不是同一个东西** —— 而本工具只印了前者，
             于是「我们连一个排名都没有」这个结论会被读出来，而事实是我们有一个第 32 名的词。 */
          + '\n\n**这里的「共 N 个词」是本表（`kw_rank_observation`，每次扫描每天一行）的词数，'
          + '不是「我们测过的全部词数」。** 本 ASIN 在 `asin_keyword` 里可能还有更早的排名测量'
          + '（由另一条写入路径产生，不进这张表）—— 要看全部测量用 `amzn_keyword_coverage`。',
      }
    },
  }
}

/* ──────────────────── 扫描排班（真的会自己跑） ──────────────────── */

/**
 * 排班的增删改查 + 立即跑一次。
 *
 * 计时器在插件进程里（`createKeywordScheduler`），不是"打开页面才检查"——
 * 这一点是排班能不能算数的分界：没人看的时候也跑，才叫定时。
 */
export function kwScanScheduleTool({ store, keywordScheduler = null, keywordService = null }) {
  return {
    name: 'amzn_kw_scan_schedule',
    description:
      'Configure recurring keyword-rank scans inside the plugin. '
      + 'Actions: list (default) / save / delete / run-now. '
      + '`cadence` is daily or weekly; `atTime` is HH:MM in **the machine\'s local time** (no timezone '
      + 'is stored — "每周日 12:00" means 12:00 where the plugin runs). '
      + '`weekdays` uses ISO 1=Monday … 7=Sunday, and weekly accepts several days. '
      + 'Omit `keywords` to scan the watchlist (the `keyword` table); omit `asins` to scan every tracked '
      + 'ASIN on that storefront. '
      + 'Missed runs are NOT caught up: the next time is always computed forward from now, because '
      + 'replaying a two-week-old scan would write observations with misleading timestamps. '
      + 'Runs are serial — one browser, one scan at a time.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'delete', 'run-now'], description: 'Default list.' },
        id: { type: 'number', description: 'Schedule id (for save-as-update / delete / run-now).' },
        name: { type: 'string', description: 'Human name, e.g. 「每周日全量扫描」.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        cadence: { type: 'string', enum: ['daily', 'weekly'], description: 'daily or weekly.' },
        atTime: { type: 'string', description: 'HH:MM, local time.' },
        weekdays: { type: 'array', items: { type: 'number' }, description: 'ISO weekdays 1..7 (weekly only).' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Omit = watchlist.' },
        asins: { type: 'array', items: { type: 'string' }, description: 'Omit = all tracked ASINs.' },
        pages: { type: 'number', description: 'Result pages per keyword, 1..20. Default 1.' },
        enabled: { type: 'boolean', description: 'Default true.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const action = String(args?.action ?? 'list')
      if (action === 'list') {
        const rows = listSchedules(store)
        if (rows.length === 0) {
          return { ok: true, schedules: [], text: '还没有排班。用 action="save" 建一条，例如：\n'
            + '  cadence="weekly", weekdays=[7], atTime="12:00"（每周日 12:00）\n'
            + '  cadence="daily", atTime="09:00"（每天 09:00）' }
        }
        const nextCell = (row) => {
          if (!row.nextRunAt) return '—'
          const stamp = localStamp(row.nextRunAt)
          // 关着的计划不推进 nextRunAt —— 那个时刻只会越来越旧，不能当时刻用
          if (!row.enabled) return `—（关着；上次算出的是 ${stamp}）`
          const ms = Date.parse(String(row.nextRunAt))
          if (Number.isFinite(ms) && ms < Date.now()) return `${stamp}（已过期，等下一次触发时重算）`
          return stamp
        }
        const lines = rows.map(row => [
          String(row.id), row.name, row.marketplace, describeSchedule(row),
          row.enabled ? '开' : '关',
          /* 2026-10-25（R-32）：见 localStamp 的注释 —— 原来的写法会丢掉 ISO 串末尾的时区标记，
             把 UTC 当成本地时间印出去。排班是「什么时候自动跑」的承诺，按它等会等错。 */
          /* 2026-10-25（R-71）：这一格原来一律印 `localStamp(row.nextRunAt)`，于是**关着的计划**
             会永远印一个**已经过去**的时刻。实测本库两条计划都是 `enabled: false`：
               id 1「每周日全量扫描」下次 2026-10-25 12:00
               id 2「每天早间巡检」  下次 2026-10-22 09:00
             而当天是 2026-10-26 —— **「下次」比「现在」早 1 到 4 天**，读者只会得出一个结论：
             这个排班坏了 / 它马上要跑。真相是：**关着的计划不推进 nextRunAt，那一格是冻结值。**
             所以关着的时候不再印那个时刻当时刻用，而是把「它是上一次算出来的」写在旁边。 */
          nextCell(row),
          row.lastRunAt ? localStamp(row.lastRunAt) : '从未跑过',
        ])
        const disabledWithStamp = rows.filter(row => !row.enabled && row.nextRunAt).length
        return {
          ok: true,
          schedules: rows,
          text: arrayTable(['id', '名称', '站点', '周期', '状态', '下次（本地）', '上次（本地）'], lines)
            + (disabledWithStamp > 0
              ? `\n\n说明：上面 ${disabledWithStamp} 个「关」的计划**不会推进「下次」** ——`
                + '那一格显示的是它上一次算出来的时刻，**可能已经过去**；'
                + '打开计划（`action: "save", enabled: true`）时会按当时的时间重新算。'
              : ''),
        }
      }

      if (action === 'delete') {
        const removed = deleteSchedule(store, args?.id)
        if (removed === null) return { ok: false, error: `no schedule with id ${args?.id}` }
        return { ok: true, deleted: removed, text: `已删除排班「${removed.name}」` }
      }

      if (action === 'run-now') {
        const id = Number(args?.id)
        const schedule = getSchedule(store, id)
        if (schedule === null) return { ok: false, error: `no schedule with id ${args?.id}` }
        if (keywordScheduler === null) return { ok: false, error: 'scheduler is not running in this process' }
        const result = keywordScheduler.runOne(schedule)
        return { ok: true, result, text: `已立即触发排班「${schedule.name}」：${JSON.stringify(result)}` }
      }

      /* save */
      try {
        const saved = saveSchedule(store, {
          id: args?.id ?? null,
          name: args?.name,
          marketplace: args?.marketplace ?? 'US',
          cadence: args?.cadence,
          atTime: args?.atTime,
          weekdays: args?.weekdays ?? null,
          keywords: args?.keywords ?? null,
          asins: args?.asins ?? null,
          pages: args?.pages ?? 1,
          enabled: args?.enabled !== false,
        })
        return {
          ok: true,
          schedule: saved,
          text: `已保存排班 #${saved.id}「${saved.name}」：${describeSchedule(saved)}\n`
            + `下次运行：${localStamp(saved.nextRunAt)}（本地时间，与上面的 atTime 同一个基准）\n`
            + `关键词：${saved.keywords === null ? '监控清单（' + watchlistCount(store, saved.marketplace) + ' 个词）' : saved.keywords.length + ' 个'}\n`
            + `ASIN：${saved.asins === null ? '该站点全部跟踪的 ASIN' : saved.asins.length + ' 个'}`,
        }
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

function watchlistCount(store, marketplace) {
  return Number(store.get('SELECT COUNT(*) AS n FROM keyword WHERE marketplace = ?', [String(marketplace).toUpperCase()]).n)
}

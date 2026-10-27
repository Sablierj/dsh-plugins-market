/**
 * The import pipeline: file → facts → rollup.
 *
 * Four steps, and each one is a seam the caller can inspect:
 *
 *   1. **read**   the bytes, and fingerprint them
 *   2. **parse**  into normalised facts (`importers.js`) — pure, no store
 *   3. **write**  facts into the three fact tables (`store/kw.js`)
 *   4. **rollup** recompute `kw_master` for the words this file touched
 *
 * Step 4 is scoped to the affected keywords rather than the whole library. That
 * is not an optimisation: the ad report alone carries 20,602 distinct words, and
 * recomputing a 30k-row library after each of eleven files would make the tool
 * call take minutes. Scoping it also keeps the *result* identical, because the
 * rollup is a pure function of the facts — a word not in this file has the same
 * facts it had a moment ago.
 *
 * ## Idempotency, which the hub did not have
 *
 * `00_import_ad_xlsx.py` accumulated: importing the same report twice doubled
 * every metric, and both runs reported success. Here a file is identified by
 * its size plus a hash of its bytes, and a second import of the same bytes is a
 * **no-op** that says so. `force` re-imports, which is safe for the same reason
 * — the facts are keyed by `(keyword, period, file)`, so a re-import replaces
 * rows instead of adding them.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { parseSourceFile, detectImportKind } from './importers.js'
import {
  fingerprintOf, findImportByFingerprint, findOverlaps, recomputeMaster, recordImport,
  upsertAbaFacts, upsertAdFacts, upsertCompetitorFacts,
} from '../../store/kw.js'
import { ACTIONS } from '../audit/targets.js'
import { recordWorkerWrite, WORKER_NAMES } from '../audit/worker.js'

/** Files this pipeline will even look at. */
const IMPORTABLE = /\.(xlsx|xlsm|csv|json)$/i

/**
 * Import one file.
 *
 * @param {object} store
 * @param {object} options
 * @param {string} options.filePath
 * @param {string} [options.kind]        override detection
 * @param {string} [options.marketplace] override the filename's marketplace
 * @param {boolean} [options.force]      re-import even if the bytes are known
 * @param {boolean} [options.dryRun]     parse and report, write nothing
 * @returns {object} a summary the tool renders directly
 */
export function importFile(store, {
  filePath, kind, marketplace = null, force = false, dryRun = false, logger = null,
} = {}) {
  const given = String(filePath ?? '').trim()
  if (given === '') throw new Error('filePath is required')

  // `resolve`, not the caller's spelling. `source_file` is part of the ad fact
  // primary key, so `D:/x/a.xlsx` and `D:\x\a.xlsx` would be two different
  // sources for one file — and re-importing via the other spelling would
  // *add* a second copy of every metric instead of replacing it. That is not
  // hypothetical: it is what happened the first time this was run with a
  // hand-written path against a directory scan.
  const path = resolve(given)
  const fileName = basename(path)
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    throw new Error(`读不到文件 ${path}: ${error.message}`)
  }

  const fingerprint = fingerprintOf(buffer)
  const previous = findImportByFingerprint(store, fingerprint)

  if (previous !== undefined && force !== true && dryRun !== true) {
    const when = previous.imported_at.slice(0, 19).replace('T', ' ')
    return {
      ok: true,
      skipped: true,
      reason: previous.file_name === fileName ? 'same-file-already-imported' : 'same-bytes-different-name',
      file: fileName,
      filePath: path,
      fingerprint,
      previousImportId: previous.id,
      previousFileName: previous.file_name,
      previousImportedAt: previous.imported_at,
      factsWritten: 0,
      message: previous.file_name === fileName
        ? `这个文件（字节完全相同）已于 ${when} 导入过，未重复导入。`
          + `要强制重导，加 force=true —— 事实表按 (关键词, 周期, 文件) 覆盖，不会翻倍。`
        : `这个文件的字节与 ${previous.file_name} 完全相同（同名不同名各一份），已于 ${when} 导入过。`
          + `两个名字指向同一份数据，两份都算会翻倍，所以第二个跳过。`,
    }
  }

  const detected = detectImportKind(fileName)
  const parsed = parseSourceFile({
    buffer,
    text: /\.(csv|json)$/i.test(fileName) ? buffer.toString('utf8') : null,
    fileName,
    kind,
    marketplace,
  })

  const market = parsed.marketplace
  const period = parsed.period

  if (dryRun === true) {
    const counts = Object.fromEntries(
      Object.entries(parsed.facts).filter(([, list]) => list.length > 0).map(([name, list]) => [name, list.length]),
    )
    return {
      ok: true,
      dryRun: true,
      file: fileName,
      filePath: path,
      kind: parsed.kind,
      detectedKind: parsed.detectedKind,
      layout: parsed.layout ?? null,
      marketplace: market,
      period,
      granularity: parsed.granularity,
      counts,
      problems: parsed.problems,
      sample: sampleFacts(parsed.facts),
    }
  }

  const affected = new Set()
  for (const fact of parsed.facts.aba) affected.add(fact.keyword)
  for (const fact of parsed.facts.ads) affected.add(fact.keyword)
  for (const fact of parsed.facts.competitor) affected.add(fact.keyword)
  for (const fact of parsed.facts.keywords) affected.add(fact.keyword)

  let written = 0
  if (parsed.facts.aba.length > 0) {
    written += upsertAbaFacts(store, parsed.facts.aba, { marketplace: market, period, sourceFile: path })
  }
  if (parsed.facts.ads.length > 0) {
    written += upsertAdFacts(store, parsed.facts.ads, { marketplace: market, period, sourceFile: path })
  }
  if (parsed.facts.competitor.length > 0) {
    written += upsertCompetitorFacts(store, parsed.facts.competitor, { marketplace: market, period, sourceFile: path })
  }
  // A plain keyword list has no fact table of its own — the library row *is*
  // the fact. Those words still enter the rollup through `keyword`, which
  // `recomputeMaster` reads for exactly this reason.
  if (parsed.facts.keywords.length > 0) {
    written += seedLibraryKeywords(store, parsed.facts.keywords, {
      marketplace: market, sourceId: parsed.sourceId, sourceFile: path,
    })
  }

  /* 日期从哪来：行内有日期（SP/SB 导出）才能进日表；
     只有文件名的（数据聚合报表）标 filename —— 文件名是人起的，不信它。 */
  const adDailyRows = parsed.facts.ads.reduce((n, f) => n + (Array.isArray(f.daily) ? f.daily.length : 0), 0)
  const dateSource = parsed.facts.ads.length === 0 ? null : (adDailyRows > 0 ? 'row' : 'filename')

  const importRow = recordImport(store, {
    kind: parsed.kind,
    sourceId: parsed.sourceId,
    filePath: path,
    fileName,
    bytes: buffer.length,
    fingerprint,
    marketplace: market,
    period,
    granularity: parsed.granularity,
    layout: parsed.layout ?? null,
    /* 读了几行。**读不出来就是 null**（「未记录」），不是 0 —— 0 是一句
       「这份文件里一行都没有」，而解析器没报行数时那句话根本没被说过。
       台账 13 号遗留：这一格原来是「读不到就写 0」。 */
    rowsRead: rowsReadOf(parsed.stats),
    factsWritten: written,
    status: parsed.problems.length > 0 ? 'ok-with-problems' : 'ok',
    problems: parsed.problems,
    stats: parsed.stats === undefined || parsed.stats === null ? parsed.stats : { ...parsed.stats, dailyRows: adDailyRows },
    dateSource,
  })

  /* §31: the import worker's writes leave rows of their own. Two objects, because
     two things happened and they answer different questions — "this file became
     this import row" and "the derived layer now has this many rows". The tool
     funnel records one row for the tool *call* (`kw_import.create`, objectId
     null, because the id is minted here and the tool returns rendered text), so
     before this the per-file fact and the rollup existed nowhere in the log.

     Neither call can fail the import: `recordWorkerWrite` reports instead of
     throwing, because by the time it runs the write has committed. */
  const auditImport = error => logger?.warn?.(`[amazon-ops] audit of the import write failed: ${error.message}`)
  recordWorkerWrite(store, {
    worker: WORKER_NAMES.keywordImport,
    action: ACTIONS.kwImportCreate,
    objectType: 'kw_import',
    objectId: importRow.id,
    before: importDescriptor(previous),
    after: importDescriptor(importRow),
    impact: { file: fileName, factsWritten: written },
  }, auditImport)

  const masterRowsBefore = countMasterRows(store, market)
  const rollup = recomputeMaster(store, { marketplace: market, keywords: affected })
  const overlaps = findOverlaps(store, market)

  /* Only a pass that changed something is audited, which is the same rule the
     version registry keeps (W1-1): a merge that wrote and removed nothing is not
     a change to the layer, and a log that gains a row per no-op rebuild is a log
     nobody can read. */
  if (rollup.rows > 0 || rollup.removed > 0) {
    recordWorkerWrite(store, {
      worker: WORKER_NAMES.keywordImport,
      action: ACTIONS.kwMasterRecompute,
      objectType: 'kw_master',
      /* The layer's object id is its marketplace — the same one its snapshot
         versions use: one derived layer per site. */
      objectId: market,
      before: { marketplace: market, rows: masterRowsBefore },
      after: {
        marketplace: market,
        rows: countMasterRows(store, market),
        keywords: rollup.keywords,
        removed: rollup.removed,
        excludedFiles: rollup.excludedFiles,
      },
      impact: { file: fileName, affectedKeywords: affected.size },
    }, auditImport)
  }

  logger?.info?.(`[amazon-ops] imported ${fileName}: ${written} facts, ${rollup.rows} master rows`)

  return {
    ok: true,
    skipped: false,
    importId: importRow.id,
    file: fileName,
    filePath: path,
    bytes: buffer.length,
    kind: parsed.kind,
    detectedKind: parsed.detectedKind,
    kindOverridden: parsed.kindOverridden,
    detectionConfident: parsed.detectionConfident,
    layout: parsed.layout ?? null,
    marketplace: market,
    period,
    granularity: parsed.granularity,
    factsWritten: written,
    /* 与写进导入记录的那一格**同一个值、同一个入口**（`rowsReadOf`）：调用方
       （工具/页面）要印「未记录」时，读的就是这一格，不必再去反解 stats。 */
    rowsRead: rowsReadOf(parsed.stats),
    affectedKeywords: affected.size,
    masterRows: rollup.rows,
    problems: parsed.problems,
    stats: parsed.stats === undefined || parsed.stats === null ? parsed.stats : { ...parsed.stats, dailyRows: adDailyRows },
    dateSource,
    overlaps: overlaps.map(entry => ({
      a: `${entry.a.file_name} (${entry.a.period})`,
      b: `${entry.b.file_name} (${entry.b.period})`,
    })),
  }
}

/**
 * Register plain keywords in the `keyword` table so the rollup sees them.
 *
 * Reuses `upsertKeyword`'s shape rather than writing SQL here, because that
 * function already owns the rule that a re-add must not blank an existing
 * `first_seen_at`.
 */
function seedLibraryKeywords(store, rows, { marketplace, sourceId, sourceFile = null }) {
  const now = new Date().toISOString()
  let written = 0
  store.tx(() => {
    for (const row of rows) {
      const keyword = String(row.keyword ?? '').replace(/\s+/g, ' ').trim()
      if (keyword === '') continue
      store.run(
        `INSERT INTO keyword
           (keyword, marketplace, source_id, search_volume, difficulty, source_file,
            first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(keyword, marketplace) DO UPDATE SET
           source_id     = COALESCE(excluded.source_id, keyword.source_id),
           search_volume = COALESCE(excluded.search_volume, keyword.search_volume),
           difficulty    = COALESCE(excluded.difficulty, keyword.difficulty),
           source_file   = COALESCE(excluded.source_file, keyword.source_file),
           updated_at    = excluded.updated_at`,
        [
          keyword, marketplace, sourceId ?? 'manual',
          // `Number(null)` is 0 and `Number.isFinite(0)` is true, so a guard
          // written with `Number.isFinite(Number(v))` writes a real zero for
          // "no value". A list imported without a volume column would then put
          // `search_volume = 0` in the library, and 0 is a claim.
          finiteOrNull(row.searchVolume),
          finiteOrNull(row.difficulty),
          sourceFile,
          now, now,
        ],
      )
      written += 1
    }
  })
  return written
}

/**
 * Import every importable file in a directory (non-recursive by default).
 *
 * Files whose name is not recognised are listed as skipped with the reason, not
 * silently dropped — "I imported the folder" and "I imported three of the
 * eleven files" must not look the same.
 */
export function importDirectory(store, {
  dir, kind = undefined, marketplace = null, force = false, dryRun = false, recursive = false, logger = null,
  /* 一个可选回调：`filePath -> kind | null`。数据源目录用它按**子目录**定类型
     （brand-terms → ABA、sellerjingling → 卖家精灵……），因为那些文件的文件名
     未必认得出类型。不给回调时行为与以前完全一致。 */
  kindFor = null,
} = {}) {
  const root = String(dir ?? '').trim()
  if (root === '') throw new Error('dir is required')

  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    throw new Error(`读不到目录 ${root}: ${error.message}`)
  }

  /* 待导入的是**路径**；子目录递归回来的东西是**结果**。两者绝不能混在一个数组里
     —— 之前这里把 `nested.results`（对象）push 进 `files`，于是 `statSync(对象)`
     直接抛 TypeError：只要目录里有子目录、并且 recursive，整次导入就崩。
     这个 bug 在真目录上第一次跑才暴露（那套数据源目录全是子目录）。 */
  const files = []
  const nestedResults = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (recursive) {
        const nested = importDirectory(store, { dir: join(root, entry.name), kind, marketplace, force, dryRun, recursive, logger, kindFor })
        nestedResults.push(...nested.results.map(result => ({ ...result, file: `${entry.name}/${result.file}` })))
      }
      continue
    }
    if (!IMPORTABLE.test(entry.name)) continue
    if (entry.name.startsWith('~$')) continue // Excel lock files
    files.push(join(root, entry.name))
  }

  const results = [...nestedResults]
  for (const filePath of files) {
    try {
      const size = statSync(filePath).size
      // An empty spreadsheet is a failed export, not a source of zero facts.
      if (size === 0) {
        results.push({ ok: false, file: basename(filePath), error: '文件是空的（0 字节）' })
        continue
      }
      /* 每个文件各自的类型：回调给得出就用回调（数据源目录按子目录定），
         否则沿用调用方给的 kind（原行为）。 */
      let perFileKind = kind
      if (typeof kindFor === 'function') {
        try {
          const hinted = kindFor(filePath)
          if (hinted !== null && hinted !== undefined && hinted !== '') perFileKind = hinted
        } catch { /* 回调出错就当没给，退回 kind */ }
      }
      results.push(importFile(store, { filePath, kind: perFileKind, marketplace, force, dryRun, logger }))
    } catch (error) {
      results.push({ ok: false, file: basename(filePath), error: error.message })
    }
  }

  return {
    dir: root,
    /* `found` 数的是**这一趟处理过的所有文件**，不是本层目录里的文件数 ——
       递归时本层往往一个文件都没有（根目录下全是子目录），用 files.length
       会报「找到 0 个可识别文件」却又列出几十行，自相矛盾。 */
    found: results.length,
    imported: results.filter(result => result.ok === true && result.skipped !== true && result.dryRun !== true).length,
    skipped: results.filter(result => result.skipped === true).length,
    failed: results.filter(result => result.ok === false).length,
    results,
  }
}

/** A number, or null — never 0 for "absent". See the call site. */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 「这份文件读了几行」—— **唯一口径入口**：一个数，或者 `null`（= 解析器没报）。
 *
 * ## 为什么不是「空就兜 0」
 *
 * 台账 13 号：这里原来是「读不到行数就写 0」。看上去只是个默认值，实际是把
 * 「这份文件读了多少行」这句话在**没人说过**的时候替人说成了 0 —— 导入记录、
 * 审计行、页面上的「行」那一列于是都显示 0，而 0 读起来是「这份文件一行都没有」。
 *
 * 「真的读了 0 行」是**另一个值**，不是这个 0 的替身：它今天出不来（六个 parser 面对空输入
 * 全部抛 —— 空词表 / 只有表头的 ABA / 空 JSON 都走不到 `recordImport`），但契约上它存在，
 * 由 `rows_read = 0` + `rows_read_missing = 0` 表达；「没记到」由 `rows_read_missing = 1` 表达。
 *
 * ## 存储层怎么接住这个 `null`（v68）
 *
 * `kw_import.rows_read` 是 `INTEGER NOT NULL DEFAULT 0` —— 列装不下 `null`，所以缺的那件事
 * 记在**另一列**：`rows_read_missing`（v68）。`recordImport` 收到 `null` 会写
 * `rows_read = 0` + `rows_read_missing = 1`，读端据此印「未记录」。
 *
 * **返回值和库里的值现在是同一个答案。** 这句话在 2026-10-25 之前不成立：返回值是 `null`、
 * 库里是 0 —— 同一份导入在两个界面上各说一句。所以这一段注释改了，不是补一句
 * 「以后再说」：留着「过不了存储层」那句话，下一个人会以为已经修完了。
 *
 * ⚠️ `rows_read_missing = 0` 只意味着「没记到缺失」，不等于行数准确：v68 之前的老行一律 0。
 */
export function rowsReadOf(stats) {
  return finiteOrNull(stats?.rowsRead)
}

/* ── what the import worker leaves in the audit log (W1-7 / §31) ───────────── */

/**
 * The facts a `kw_import` row should put in the log, and no more.
 *
 * `problems_json` / `stats_json` are parsed blobs about one file's layout; an
 * audit row is read to answer "what did this import change", so what is kept is
 * the identity (id, file, fingerprint), the scope (marketplace, period) and the
 * counts. `filePath` is left out for the same reason the tool funnel leaves bulk
 * out: the file name identifies the file, and the full local path adds nothing a
 * reader acts on.
 *
 * `null` for "there was no previous import of these bytes" — which is a fact,
 * not a failed read: the caller looked the fingerprint up before the write.
 */
function importDescriptor(row) {
  if (row === null || row === undefined) return null
  return {
    id: row.id,
    kind: row.kind,
    fileName: row.file_name,
    marketplace: row.marketplace,
    period: row.period,
    bytes: row.bytes,
    fingerprint: row.fingerprint,
    /* 与工具/页面同一个口径：`rows_read_missing = 1` 时这一格是 `null`（未记录），
       不是 0。审计行是**机器写的人工可读记录**，它更不能替 parser 编一个读数。
       旧审计行没有这一列（`undefined === 1` 为假）→ 保留原来的数，不前向污染历史。 */
    rowsRead: row.rows_read_missing === 1 ? null : row.rows_read,
    factsWritten: row.facts_written,
    status: row.status,
    importedAt: row.imported_at,
  }
}

/** How many rows the derived layer for one site has right now. */
function countMasterRows(store, marketplace) {
  return Number(store.get('SELECT COUNT(*) AS n FROM kw_master WHERE marketplace = ?', [marketplace])?.n ?? 0)
}

/** A couple of rows from the biggest fact group, for a dry-run preview. */
function sampleFacts(facts) {
  const groups = Object.entries(facts).filter(([, list]) => list.length > 0)
  if (groups.length === 0) return null
  const [name, list] = groups.sort((a, b) => b[1].length - a[1].length)[0]
  return { group: name, first: list[0], last: list[list.length - 1] }
}

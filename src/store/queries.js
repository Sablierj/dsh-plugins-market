/**
 * Domain queries over the store.
 *
 * Kept apart from `db.js` so the driver stays swappable and these stay readable
 * as SQL. Everything here takes `store` as its first argument and returns plain
 * objects — no classes, because these results go straight to a tool's `render`
 * and to the page's JSON API.
 */

import { nowIso } from './db.js'
/* 「全库已归档 N 个」只有一份实现（`archivedAsinCount`），列表的 `archivedTotal`
   读它而不是自己再写一条 COUNT —— 两个 COUNT 迟早分叉，然后概览说 N、列表说 M。
   没有循环依赖：`store/archive.js` 那条链（db / observe / domain/asin/archive-refs）
   都不回到这里。 */
import { archivedAsinCount } from './archive.js'
/* 「这条变体边现在还算数吗」的**唯一判据**（T-8 缺陷 2）。修复前这里是
   「不等于 corrected 就算生效」（写成一个不等号），而 `domain/asin/variants.js` 写的是
   「等于 active」—— 一条规则两种拼法，取值集合一变就漂移。现在两边都从这一个模块拿判据。 */
import { ACTIVE_VARIANT_RELATION_STATUS, activeVariantRelationSql } from './variant-status.js'
import { keywordKey } from '../domain/keywords/key.js'
import { SIGNAL_CATEGORIES } from '../domain/keywords/signals.js'
import { COLLECTION_TASK_STATES, OPTIMIZATION_RUN_STATUSES } from '../domain/states.js'
/* F14-10：「这一轮有三份导出件里的哪几份」的**唯一判据**。批量读（上面
   `optimizationArtifactMap`）与单条导出（`exportArtifact`）都问它，所以列表上画得出来的
   按钮与导出端点接受得下的格式不会各说一套。 */
import { availabilityOf } from '../domain/reports/export.js'
/* FR-M2-05（B 方案）：一次 upsert 覆盖人工值时，必须留下**一条审计**并把冲突摆回人面前。
   审计的动作名从 `ACTIONS` 拿 —— 那是全仓动作词表的家，在本文件里再写一遍字面量
   就是第二份措辞，两份漂开时没有任何一处会报错。 */
import { ACTIONS } from '../domain/audit/targets.js'
import { recordAudit } from './audit.js'
import { reopenConflict } from './conflict.js'
/* The versioned writer for a line's signals. `upsertProductLine` delegates to it
   rather than writing `signals_json` itself, so there is exactly one place that
   bumps a version and one place that computes the impact number. */
import { setLineSignalsVersioned } from './product-line.js'
/* `refreshConflictsFor` is no longer imported here: conflict detection moved into
   `upsertFieldSource`, which `upsertAsin` now calls per field. Keeping the
   import would keep a second path that looks live and is not. */
/* The versioned writers, called from the paths that produce the object rather
   than from a sweep. A registry that is filled by "somebody remembering to run
   it" is the same dead mechanism as one with no caller at all. */
import { registerSnapshot } from './snapshot.js'
import { upsertFieldSource } from './field-source.js'
/* F05-01：ASIN 大表的列目录与逐行投影。**列清单与投影都只有一个家** ——
   `ASIN_LISTING_FIELDS` 同时是这里的写白名单与「完整率」那一列的分母，
   `projectAsinRow` 同时是工具、页面、导出三处印一行的唯一实现。 */
import {
  ASIN_LISTING_FIELDS, ASIN_COLUMNS, projectAsinRow, resolveAsinColumns,
} from '../domain/asin/table.js'

/** Columns a caller is allowed to write into `asin`. The list itself lives in
 *  `domain/asin/table.js` because it is also the completeness column's denominator —
 *  two homes for one list is how a denominator and a whitelist drift apart. */
const ASIN_FIELDS = ASIN_LISTING_FIELDS

/* ─────────────────────────────── sources ─────────────────────────────── */

export function listSources(store) {
  return store.all('SELECT * FROM source ORDER BY enabled DESC, id')
}

export function setSourceHealth(store, id, health) {
  store.run(
    'UPDATE source SET last_health = ?, checked_at = ? WHERE id = ?',
    [JSON.stringify(health ?? {}), nowIso(), id],
  )
}

/* ──────────────────────────── product lines ──────────────────────────── */

/**
 * Insert or update one product line.
 *
 * `product_line` is the grouping the ASIN library filters by: `asin.product_line_id`
 * references it, `queryAsins` and the page's `whereClause` both filter on it, and
 * `upsertAsin` validates the foreign key. It had readers and a validator but no
 * writer at all, so `product_line_id` was a trap — passing one threw "no product
 * lines exist yet" and the filter could only ever return nothing. This is the
 * missing write path.
 *
 * The update is narrow on purpose: `note` is `COALESCE(excluded.note, note)`, so
 * renaming a line does not silently wipe a note the caller did not repeat.
 *
 * @returns the id plus whether it was new, mirroring `upsertAsin`.
 */
export function upsertProductLine(store, record) {
  const id = String(record?.id ?? '').trim()
  const name = String(record?.name ?? '').trim()
  if (id === '') throw new Error('product line id is required')
  if (name === '') throw new Error(`product line "${id}" needs a name`)

  /* `signals` is the classification word set that decides which keywords land in
     this line. Three states, and the third is why this is not a plain `??`:
       - `undefined` — not mentioned. Keep whatever is stored, so an update that
         only renames a line does not wipe its signals.
       - `null` — explicitly cleared. Store NULL, which means "fall back to the
         code constant".
       - anything else — a signal set. Since v23 that is a four-category object
         (`{core, exclude, scenario, material}`); a bare array is still accepted
         and read as `core`, because that is the shape every pre-v23 store holds
         and a writer that refused it would make an old caller look like a bug.

     The write itself goes through `setLineSignalsVersioned` — one writer, so the
     version bump, the canonical JSON and the impact number cannot drift from the
     path the page and `amzn_product_line_upsert` take. */
  if (record.signals !== undefined) assertSignalShape(record.signals, id)

  const existing = store.get('SELECT id FROM product_line WHERE id = ?', [id])
  store.run(
    `INSERT INTO product_line (id, name, note)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       note = COALESCE(excluded.note, product_line.note)`,
    [id, name, record.note ?? null],
  )

  let version = Number(store.get('SELECT version FROM product_line WHERE id = ?', [id])?.version ?? 1)
  let impact = null
  if (record.signals !== undefined) {
    const written = setLineSignalsVersioned(store, {
      id,
      signals: record.signals,
      changedBy: record.changedBy,
    })
    version = written.version
    impact = written.impact
  }
  return { id, name, created: existing === undefined, version, impact }
}

/**
 * Refuse a signal set that is neither a list nor a four-category object, **by
 * name**.
 *
 * A store that accepted `"bench,cushion"` would parse it into no words at all
 * and the line would silently stop matching — the failure this file's guards
 * exist to prevent.
 */
function assertSignalShape(signals, id) {
  if (signals === null || Array.isArray(signals)) return
  if (typeof signals === 'object') {
    for (const category of SIGNAL_CATEGORIES) {
      const value = signals[category]
      if (value !== undefined && !Array.isArray(value)) {
        throw new Error(`product line "${id}": signals.${category} must be a list of strings (got ${JSON.stringify(value)})`)
      }
    }
    return
  }
  throw new Error(`product line "${id}": signals must be a four-category object, a list of strings, or null (got ${JSON.stringify(signals)})`)
}

/**
 * List product lines, with how many ASINs each one holds.
 *
 * The count is what makes the list useful on the page: an empty product line is
 * a line that was created and never used, which is different from one that is
 * quietly doing its job.
 */
export function listProductLines(store, { limit = 100 } = {}) {
  const cap = clamp(Number(limit ?? 100), 1, 500)
  const rows = store.all(
    `SELECT p.id, p.name, p.note, p.signals_json, p.version,
            (SELECT COUNT(*) FROM asin a WHERE a.product_line_id = p.id) AS asin_count
       FROM product_line p
      ORDER BY p.id
      LIMIT ?`,
    [cap],
  )
  return {
    rows,
    total: Number(store.get('SELECT COUNT(*) AS n FROM product_line')?.n ?? 0),
    limit: cap,
  }
}

/* ──────────────────────────────── ASIN ───────────────────────────────── */

/**
 * Insert or update one ASIN, then record where each field came from.
 *
 * The update is deliberately `COALESCE(excluded.x, asin.x)`: a collection that
 * only returned a price must not blank out a title collected last week. Passing
 * a field is a claim about it; omitting one is silence, not deletion.
 *
 * `sourceId` and `product_line_id` are foreign keys, so an unknown value would
 * surface as `FOREIGN KEY constraint failed` — accurate, and useless to whoever
 * has to fix it. Both are checked up front and rejected with the list of valid
 * values instead, so one turn is enough to correct the call.
 *
 * @returns the stored row plus whether the key was new.
 */
export function upsertAsin(store, record) {
  const asin = String(record?.asin ?? '').trim().toUpperCase()
  const marketplace = String(record?.marketplace ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN "${record?.asin}" (expected 10 letters/digits)`)
  if (!marketplace) throw new Error('marketplace is required')

  const sourceId = record.sourceId ? String(record.sourceId) : null
  if (sourceId !== null) {
    const known = store.get('SELECT id FROM source WHERE id = ?', [sourceId])
    if (known === undefined) {
      const ids = store.all('SELECT id FROM source ORDER BY id').map(row => row.id)
      throw new Error(`unknown source "${sourceId}"; known sources: ${ids.join(', ')}`)
    }
  }

  const productLineId = record.product_line_id === undefined || record.product_line_id === null
    ? null
    : String(record.product_line_id)
  if (productLineId !== null) {
    const known = store.get('SELECT id FROM product_line WHERE id = ?', [productLineId])
    if (known === undefined) {
      const ids = store.all('SELECT id FROM product_line ORDER BY id').map(row => row.id)
      throw new Error(ids.length === 0
        ? `no product lines exist yet, so product_line_id "${productLineId}" cannot be used`
        : `unknown product_line_id "${productLineId}"; known product lines: ${ids.join(', ')}`)
    }
  }

  const now = nowIso()
  const existing = store.get('SELECT asin FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace])

  const values = ASIN_FIELDS.map(field => (record[field] === undefined ? null : record[field]))

  /* ── FR-M2-05（B 方案）：覆盖人工值必须有痕 ────────────────────────────────
     一次 upsert 只要**带了**某个字段，就一定会覆盖它已有的值（下面 COALESCE 的
     `excluded.x` 优先）。如果那个已有的值来自**人工来源**，这次覆盖就是
     「人工决定被机器改掉了」—— 在 2026-10-25 之前这件事是完全静默的：
     采用值变了、audit_log 0 行、冲突行停在 open 且建议仍指向人工值。
     实测复现见 team/dev/fr-m2-05-coalesce-repro.mjs。

     这里只对**真的会变**的字段动手：一次批量读拿到这几个字段的人工来源行
     （不是每格一次查询，那会把日志和 IO 都淹掉），逐条比对值。
     写完之后做两件事：
       ① 落一条 `asin.field.manual-overridden` 审计，带被覆盖的值与覆盖者；
       ② 把该字段的冲突从 resolved 摆回 open（reopen）—— 它必须重新出现在
          冲突工作台上，并把「谁覆盖了什么」写进理由。停在 resolved 是不行的：
          那样工作台上看不到，而「人工决定被推翻」这件事就没有出口。
     注意：**采用值仍然被覆盖**（B 方案不改覆盖语义）。变的是它不再静默。 */
  const suppliedFields = ASIN_FIELDS.filter(field => record[field] !== undefined && record[field] !== null)
  const manualRows = suppliedFields.length === 0 ? [] : store.all(
    `SELECT field, source_id, value FROM asin_field_source
      WHERE asin = ? AND marketplace = ?
        AND (source_type = 'manual' OR source_id = 'manual')
        AND field IN (${suppliedFields.map(() => '?').join(', ')})`,
    [asin, marketplace, ...suppliedFields],
  )
  const manualOverrides = []
  for (const row of manualRows) {
    /* 来源里的值按 JSON 存（`upsertFieldSource` 的写入口径），解析失败就按原文比较 ——
       宁可比较得更严格（多报一次覆盖），也不能因为解析失败而漏掉一次覆盖。 */
    let stored = row.value
    try {
      stored = row.value === null || row.value === undefined ? null : JSON.parse(row.value)
    } catch {
      stored = row.value
    }
    if (String(stored) === String(record[row.field])) continue
    manualOverrides.push({ field: row.field, manualValue: stored, manualSourceId: row.source_id })
  }

  return store.tx(() => {
    store.run(
      `INSERT INTO asin (asin, marketplace, ${ASIN_FIELDS.join(', ')}, primary_source_id, first_seen_at, updated_at)
       VALUES (?, ?, ${ASIN_FIELDS.map(() => '?').join(', ')}, ?, ?, ?)
       ON CONFLICT(asin, marketplace) DO UPDATE SET
         ${ASIN_FIELDS.map(field => `${field} = COALESCE(excluded.${field}, asin.${field})`).join(',\n         ')},
         primary_source_id = COALESCE(excluded.primary_source_id, asin.primary_source_id),
         updated_at = excluded.updated_at`,
      [asin, marketplace, ...values, sourceId, now, now],
    )

    /* Field-level provenance: only for fields this call actually supplied.
       Two writes per field, and both are load-bearing.

       The raw INSERT is left exactly as it was: it deliberately omits the seven
       v24 trace columns, and the undated rows it writes are what `DQ-TRACE-001`
       counts. `upsertFieldSource` then lands on the *same* row (same conflict
       key) and fills in `observed_at` and the rest — so a collection that knows
       when it looked finally says so, while a caller that does not know leaves
       the row undated instead of inventing a timestamp. Which rows the
       traceability rule fires on therefore follows from whether the caller
       passed `observedAt`, which is the honest reading: a value nobody dated is
       a finding, a value dated last month is a freshness finding instead.

       `rawValue` / `rawUnit` / `parserVersion` / `qualityState` are left unset
       on purpose. This path has the normalised number, not the text the page
       printed, and a raw value copied out of a parsed field would be a second,
       wrong copy of it. */
    if (sourceId) {
      for (const field of ASIN_FIELDS) {
        if (record[field] === undefined || record[field] === null) continue
        store.run(
          `INSERT INTO asin_field_source (asin, marketplace, field, source_id, value, confidence, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(asin, marketplace, field, source_id) DO UPDATE SET
             value = excluded.value, confidence = excluded.confidence, updated_at = excluded.updated_at`,
          [asin, marketplace, field, sourceId, JSON.stringify(record[field]), Number(record.confidence ?? 1), now],
        )
        upsertFieldSource(store, {
          asin,
          marketplace,
          field,
          sourceId,
          value: record[field],
          confidence: record.confidence,
          /* Three states, and the middle one is why this is not `??`:
             `undefined` — the caller did not say, so the source's own `kind`
             decides; `null` — the caller says there is none; a string — the
             caller knows. */
          sourceType: record.sourceType,
          /* Only the collector knows the moment the page was read. Every other
             caller passes nothing and the row stays undated. */
          observedAt: record.observedAt,
        })
      }
    }

    /* Conflict detection used to be a batch pass here. It is gone rather than
       kept as a second sweep over the same fields: `upsertFieldSource` is now
       the hook, and it refreshes each field as it writes that field's
       provenance row (`store/field-source.js` calls itself the *primary*
       detection hook). Refreshing the same fields twice would be idempotent,
       but "idempotent" is not a reason to run a query.

       The behaviour that does not change: a caller with no `sourceId` writes no
       provenance rows, so there is nothing to compare and no conflict to raise.
       That was already true — the list this pass iterated stayed empty there. */

    /* FR-M2-05（B 方案）的第二半：被覆盖的人工值留痕 + 把冲突摆回人面前。
       审计行带三样东西，少一样事后就查不出来：**被覆盖的值**、**覆盖者**（sourceId）、
       以及这次是哪个字段。`objectId` 用 `ASIN@站点`，与 `amzn_asin_field_correct`
       那条审计的生产口径一致 —— 同一个人工字段、两个入口，必须是同一个 objectId。 */
    for (const item of manualOverrides) {
      recordAudit(store, {
        action: ACTIONS.asinManualOverridden,
        objectType: 'asin',
        objectId: `${asin}@${marketplace}`,
        before: { field: item.field, value: item.manualValue, sourceId: item.manualSourceId },
        after: { field: item.field, value: record[item.field], sourceId: sourceId ?? null },
        impact: {
          marketplace,
          sourceId: sourceId ?? null,
          /* 本次写入一共覆盖了几个人工值 —— 只看一行看不出「这次批量改了多少」。 */
          overriddenFields: manualOverrides.length,
        },
        reason: `一次写入（来源 ${sourceId ?? '未标注'}）把人工来源 ${item.manualSourceId} 的值 `
          + `${JSON.stringify(item.manualValue)} 覆盖为 ${JSON.stringify(record[item.field])}`,
        route: 'store:upsertAsin',
        actorKind: 'system',
      })

      /* 冲突行必须重新出现在工作台上。`resolved` 的冲突按 `reopenConflict` 的文档语义
         正是这个情形：**裁决之后又出现了与裁决相反的新证据**。`open` 的不动 ——
         它本来就在等人，重开一次只是噪音。 */
      const conflict = store.get(
        'SELECT id, status FROM field_conflict WHERE asin = ? AND marketplace = ? AND field = ?',
        [asin, marketplace, item.field],
      )
      if (conflict !== undefined && conflict !== null && conflict.status !== 'open') {
        reopenConflict(store, {
          id: conflict.id,
          reason: `人工值 ${JSON.stringify(item.manualValue)} 被来源 ${sourceId ?? '未标注'} 的写入覆盖为 `
            + `${JSON.stringify(record[item.field])}（审计动作 ${ACTIONS.asinManualOverridden}）`,
        })
      }
    }

    return { asin, marketplace, created: existing === undefined }
  })
}

/**
 * Query ASINs with their keyword coverage **and the rest of F05-01's 17 columns**.
 *
 * The sub-selects answer the question the workbench actually shows: how many
 * keywords this ASIN is tracked for, how many it ranks for, and how many it was
 * *measured and found missing* for.
 *
 * The last two are counted separately from "no rank" on purpose. A row with
 * `rank IS NULL` and a `scan_depth` is a finding; a row with no `scan_depth` was
 * never looked at. Counting both as a gap would show a brand-new ASIN as
 * "0/50 covered" when the truth is "50 words nobody has checked yet" — and that
 * number is what decides whether the user runs a scan or rewrites a listing.
 *
 * ## The 17 columns, and why the extra sub-selects are here and not in the page
 *
 * F05-01 wants a 17-column table. Six of those columns are `asin`'s own fields
 * and were already selected; the audit found the rest were simply never drawn
 * even though four of them (`rating`, `reviews`, `product_line_id`,
 * `snapshot_count`) were already coming back. The remaining ones have real
 * sources in this store, and this is the one place that reads them:
 *
 * | column | source |
 * |---|---|
 * | 父体 | `asin_variant_relation` where this ASIN is the child and the edge is `active`; 多个生效父体时这一格印第一个，而 `parent_contradicts` 一起带出来说清那不是唯一的 |
 * | 归属 | `asin_ownership` (live rows, `object_type='side'`) |
 * | 产品线名 | `product_line.name` for the cached id |
 * | 完整率 | the count of non-null columns among `ASIN_LISTING_FIELDS` |
 * | 新鲜度 | `MAX(asin_field_source.observed_at)` → classified by `freshnessOf` in the projection |
 * | 最近采集 | `MAX(asin_snapshot.collected_at)` |
 * | 优化状态 | newest `optimization_run.status` |
 * | 风险数 | `COUNT(field_conflict)` where `status='open'` |
 *
 * Each is a correlated sub-select rather than a JOIN: a join against a table with
 * more than one matching row (two live ownership edges, two snapshots, two runs)
 * would multiply the result set and silently change `total`. A sub-select cannot.
 *
 * **`SKU` has no source in this repo at all** and therefore no sub-select: there is
 * no `sku` column on `asin` and no collection section that reads one. The column
 * catalog carries that fact (`hasSource: false`) so the page prints
 * 「本仓没有来源」 instead of a blank that reads as "this row has none".
 *
 * ## Rows are projected, not raw
 *
 * What comes back is `projectAsinRow`'s output, so the tool, the page and the two
 * export formats all read the same keys. `ASIN_COLUMNS` is the column list, and
 * `resolveAsinColumns(filters.columns)` reports which of them the caller wants —
 * but **all 17 are always projected**: which columns are *shown* is a display
 * decision, and making the server skip them would mean a re-query on every
 * checkbox click.
 *
 * ## F05-08 收口：`filters.archived` 三态，默认 `all`
 *
 * 归档的语义是「从默认列表隐藏」，而 v46 之前**没有任何一条查询能把这个集合列出来**：
 * `archivedAsinCount` 会说「全库已归档 N 个」，但 N **不可核对** —— 数字被声称、
 * 集合不可验证，正是本仓那条「写入方自报、读者另算」的病。这个入参是那个集合的入口
 * （`archived: 'only'` 就是 N 条记录本身）。
 *
 * ## 默认为什么是 `all` 而不是 `hide`（**这一条实测改过一次**）
 *
 * 本批最初把默认定成 `hide`（「数据层安全默认：新调用方不该把归档项当候选」），
 * 结果**同时打破了两个读者各自已经落地并写明了理由的决定**：
 *
 *   · `domain/asin/table.js` 的 `projectAsinRow`：「列表**不隐藏**归档的行，
 *     因为不带标记的一行看起来与正常记录完全一样，而『归档没生效』正是那个样子」；
 *   · `tools/asin.js` 的 `renderAsinRowValue`（`case 'asin'`）：会话侧同样逐行印
 *     「（已归档）」而不是把它藏掉。
 *
 * 换句话说：这个仓库对「归档后隐藏」这句话的实现口径**已经决定过**了 ——
 * 隐藏的是「还能被拿去采集/优化的候选」这个含义上的隐藏，而不是「从库里看不见」。
 * 一个数据层默认值把两个读者一起翻转，是一次**没人要求的产品行为改变**，
 * 而且翻转得很安静（两边都还在工作，只是少了几行）。所以默认留在 `all`：
 * 想隐藏的调用方**说出来**（`archived: 'hide'`），而三态本身与读回对账照旧。
 * 口径之争记在契约 `docs/architecture/API-B05e-asin-archive.md` §7，等 PM 裁决。
 */
export const ASIN_ARCHIVE_FILTERS = ['hide', 'only', 'all']

/** 默认口径。**`all`** —— 见上面那一段：两个读者都已经决定「显示并标记，不隐藏」。 */
export const ASIN_ARCHIVE_DEFAULT = 'all'

/**
 * 归一化 `filters.archived`。认不出的值**抛**，不静默退回默认。
 *
 * 与 `resolveAsinColumns` 的 `unknownColumns`（报出来但继续）不同，两者不是同一种错：
 * 一个认不出的**列**不参与渲染，报出来就能继续；一个认不出的**筛选值**会改变整个
 * 结果集 —— 把 `'only'` 读成默认值会让「已归档 N 个」永远显示为空，
 * 而「空」与「筛错了」在页面上长得一模一样。
 */
export function normalizeArchivedFilter(value) {
  if (value === undefined || value === null || String(value).trim() === '') return ASIN_ARCHIVE_DEFAULT
  const mode = String(value).trim().toLowerCase()
  if (!ASIN_ARCHIVE_FILTERS.includes(mode)) {
    const error = new Error(
      `archived "${value}" is not one of ${ASIN_ARCHIVE_FILTERS.join(' / ')} —— 一条认不出的筛选值会改变整个结果集，不能静默退回默认`,
    )
    error.code = 'ASIN_ARCHIVED_FILTER'
    throw error
  }
  return mode
}

/**
 * `asin.archived_at` 这一列在不在。
 *
 * v37 才加的列，所以「库没升到位 / 这一列被删过」是一个**真实可能的失败**
 * （`store/archive.js` 的 `archivedAsinCount` 就是为它返回 `null` 的）。
 * 少了这一列还去写 `WHERE a.archived_at IS NULL`，整个 ASIN 列表会 500 —— 那是把
 * 「一个可选字段读不出来」升级成「页面白屏」。所以先问一句，问不到就**不加这个条件**。
 *
 * ★ 少了这一列时 `archived: 'only'` 返回的是**全部行**，不是空集。空集在这里是
 * 一个更坏的答案：它读起来正好是「一条都没归档」—— 本仓最贵的那类假 0。
 * 真实情况由 `archivedTotal: null` 与 `archivedHidden: null` 说出去（见下面的读回对账）。
 */
function asinHasArchivedColumn(store) {
  try {
    return store.all('PRAGMA table_info(asin)').some(column => column.name === 'archived_at')
  } catch {
    return false
  }
}

export function queryAsins(store, filters = {}) {
  const where = []
  const params = []

  if (filters.marketplace) {
    where.push('a.marketplace = ?')
    params.push(String(filters.marketplace).toUpperCase())
  }
  if (filters.productLineId) {
    /* 产品线可能来自 `asin` 自己，也可能来自产品档案导入（T52）：两者都算命中，
       否则「导入时填了产品线」的 ASIN 在筛选里会消失。 */
    where.push(`(a.product_line_id = ? OR EXISTS (
      SELECT 1 FROM product_profile pp
       WHERE pp.asin = a.asin AND pp.marketplace = a.marketplace AND pp.product_line_id = ?))`)
    params.push(String(filters.productLineId), String(filters.productLineId))
  }
  if (filters.brand) {
    where.push('a.brand = ?')
    params.push(String(filters.brand))
  }
  if (filters.q) {
    where.push('(a.asin LIKE ? OR a.title LIKE ? OR a.brand LIKE ?)')
    const like = `%${String(filters.q)}%`
    params.push(like, like, like)
  }

  /* 归档这一条**不带参数**（`IS NULL` / `IS NOT NULL` 是常量条件），所以两套 WHERE
     共用同一个 `params`：`where` 保持「调用方给的其它筛选」，归档条件单独加。
     这样「被挡掉的已归档行数」不必把参数按位置切开重排 —— 那正是最容易错的地方。 */
  const archivedMode = normalizeArchivedFilter(filters.archived)
  const archivedFilterable = asinHasArchivedColumn(store)
  const archivedClause = !archivedFilterable
    ? null
    : (archivedMode === 'hide'
      ? 'a.archived_at IS NULL'
      : (archivedMode === 'only' ? 'a.archived_at IS NOT NULL' : null))
  const whereWithArchived = archivedClause === null ? where : [...where, archivedClause]
  const whereSql = whereWithArchived.length ? `WHERE ${whereWithArchived.join(' AND ')}` : ''

  const order = {
    updated: 'a.updated_at DESC',
    bsr: 'a.bsr IS NULL, a.bsr ASC',
    reviews: 'a.reviews IS NULL, a.reviews DESC',
    asin: 'a.asin ASC',
  }[filters.order] ?? 'a.updated_at DESC'

  const limit = clamp(Number(filters.limit ?? 50), 1, 500)
  const offset = clamp(Number(filters.offset ?? 0), 0, 1_000_000)

  /* The completeness numerator, built from the write whitelist itself: a field
     added to `ASIN_LISTING_FIELDS` moves the numerator's SQL and the denominator
     together, so the ratio can never measure against a list nobody updated.
     `IS NOT NULL` and not `<> ''`: SQLite stores the empty string as a value, and
     an empty title is not "this field has a value" — the same call `blankToNull`
     makes on the read side. */
  const completenessValue = ASIN_LISTING_FIELDS
    .map(field => `(a.${field} IS NOT NULL AND a.${field} <> '')`)
    .join(' + ')

  const rows = store.all(
    `SELECT a.*,
            (SELECT COUNT(*) FROM asin_keyword k
              WHERE k.asin = a.asin AND k.marketplace = a.marketplace) AS keyword_count,
            (SELECT COUNT(*) FROM asin_keyword k
              WHERE k.asin = a.asin AND k.marketplace = a.marketplace AND k.rank IS NOT NULL) AS keyword_ranked,
            (SELECT COUNT(*) FROM asin_keyword k
              WHERE k.asin = a.asin AND k.marketplace = a.marketplace
                AND k.rank IS NULL AND k.scan_depth IS NOT NULL) AS keyword_gap,
            (SELECT COUNT(*) FROM asin_keyword k
              WHERE k.asin = a.asin AND k.marketplace = a.marketplace
                AND k.scan_depth IS NULL) AS keyword_unscanned,
            (SELECT COUNT(*) FROM asin_snapshot s
              WHERE s.asin = a.asin AND s.marketplace = a.marketplace) AS snapshot_count,
            /* ── 父体那一列：**不许再静默取第一个**（T-8 缺陷 3）─────────────────
               修复前这一格是 SELECT r.parent_asin ... ORDER BY r.parent_asin LIMIT 1：
               一个子体挂着两个生效父体时，它**静默挑一个**印成「这个子体的父体」，
               而 domain/asin/variants.js 的 parent-contradiction 报的正是这个矛盾。
               于是同一份库里，列表页给一个看起来确定的父体，问题清单说「有矛盾」——
               两个读法都不是错的，但列表页那个是在替人做判断（而且没说自己做了）。
               现在：父体列仍然只印**一个** ASIN（那是列表页的一格，不是矛盾清单），
               但同一行的子查询把「一共几个生效父体」数出来（parent_relation_count），
               于是「只有一个」与「有两个、这一格是其中一个」在**投影里**就是两件事。
               判据与 variants.js 的 parent-contradiction 同一条：生效的边
               （activeVariantRelationSql），被纠正过的边是历史、不算现状。
               ORDER BY r.parent_asin 保留：多父体时取哪一个仍然是**确定的**，
               只是不再是**说不出来的**。
               ⚠️ 这段注释里不许出现反引号：它在一个模板字符串里面（plugin-contract §8.1）。 */
            (SELECT r.parent_asin FROM asin_variant_relation r
              WHERE r.marketplace = a.marketplace AND r.child_asin = a.asin
                AND ${activeVariantRelationSql('r')}
              ORDER BY r.parent_asin LIMIT 1) AS parent_asin,
            (SELECT COUNT(*) FROM asin_variant_relation r
              WHERE r.marketplace = a.marketplace AND r.child_asin = a.asin
                AND ${activeVariantRelationSql('r')}) AS parent_relation_count,
            (SELECT o.object_id FROM asin_ownership o
              WHERE o.asin = a.asin AND o.marketplace = a.marketplace
                AND o.object_type = 'side' AND o.retracted_at IS NULL
              ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS ownership_side,
            (SELECT p.name FROM product_line p WHERE p.id = COALESCE(a.product_line_id,
              (SELECT pp.product_line_id FROM product_profile pp
                WHERE pp.asin = a.asin AND pp.marketplace = a.marketplace
                ORDER BY pp.updated_at DESC, pp.id DESC LIMIT 1))) AS product_line_name,
            /* T52：SKU / 产品名 / 产品线来自产品档案（product_profile），按 ASIN+站点
               取最近更新的一条。子查询而不是 JOIN：一个 ASIN 可能在多店/多品牌下各有一条
               档案，JOIN 会把列表行数乘出来。没有档案时是 NULL，页面印「—」。 */
            (SELECT pp.sku FROM product_profile pp
              WHERE pp.asin = a.asin AND pp.marketplace = a.marketplace
              ORDER BY pp.updated_at DESC, pp.id DESC LIMIT 1) AS sku,
            (SELECT pp.product_name FROM product_profile pp
              WHERE pp.asin = a.asin AND pp.marketplace = a.marketplace
              ORDER BY pp.updated_at DESC, pp.id DESC LIMIT 1) AS product_name,
            (SELECT pp.product_line_id FROM product_profile pp
              WHERE pp.asin = a.asin AND pp.marketplace = a.marketplace
              ORDER BY pp.updated_at DESC, pp.id DESC LIMIT 1) AS profile_product_line_id,
            (${completenessValue}) AS completeness_value,
            (SELECT MAX(f.observed_at) FROM asin_field_source f
              WHERE f.asin = a.asin AND f.marketplace = a.marketplace) AS last_observed_at,
            (SELECT MAX(s.collected_at) FROM asin_snapshot s
              WHERE s.asin = a.asin AND s.marketplace = a.marketplace) AS last_collected_at,
            (SELECT run.status FROM optimization_run run
              WHERE run.asin = a.asin AND run.marketplace = a.marketplace
              ORDER BY run.started_at DESC, run.id DESC LIMIT 1) AS optimization_status,
            (SELECT COUNT(*) FROM field_conflict c
              WHERE c.asin = a.asin AND c.marketplace = a.marketplace
                AND c.status = 'open') AS open_conflicts
       FROM asin a
       ${whereSql}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    /* 两个父体子查询各有一个绑定参数（`activeVariantRelationSql` 的 `?`）。
       ⚠️ 顺序按**它们在 SQL 文本里出现的先后**：这两条子查询在选择列表里（`WHERE` 之前），
       所以子查询参数在前、`WHERE` 的参数在后，最后是 `LIMIT / OFFSET`。
       绑错了不会抛任何错 —— 只会静默返回一个空集，看起来像「库里没有 ASIN」。
       （第一次按「WHERE 在前」的顺序写，实测 `store.all` 返回 0 行而 `total` 是 3。） */
    [ACTIVE_VARIANT_RELATION_STATUS, ACTIVE_VARIANT_RELATION_STATUS, ...params, limit, offset],
  )

  const total = store.get(
    `SELECT COUNT(*) AS n FROM asin a ${whereSql}`,
    params,
  )?.n ?? 0

  /* ★ 三格读回对账，全部**由内容算出**，不是把别处的数字抄一份：
       · `archived`       —— 这一次实际生效的模式（归一化后的字面值）；
       · `archivedHidden` —— 这一次被这一条规则挡掉的已归档行数。**只在 `hide` 且那一列
         读得出来时** 是一个数；`only` / `all` 下没有任何已归档的行被藏起来，
         报 0 是**事实**，不是兜底默认值；那一列不在时是 **`null`**（不知道）。
       · `archivedTotal`  —— 全库已归档总数，与 `archivedAsinCount` **同一个函数**
         （那一列不在时它也是 `null`）。

     恒等式（测试里断言，不在这里算）：`total('all') === total('hide') + total('only')`。
     同一条记录集合的两种切法必须正好拼回全集 —— 这是「状态能由内容重算出来」的落地。 */
  const archivedHidden = !archivedFilterable
    ? null
    : (archivedMode === 'hide'
      ? Number(store.get(
        `SELECT COUNT(*) AS n FROM asin a ${where.length ? `WHERE ${where.join(' AND ')} AND ` : 'WHERE '}a.archived_at IS NOT NULL`,
        params,
      )?.n ?? 0)
      : 0)
  const archivedTotal = archivedAsinCount(store)

  /* `columns` is resolved here so the caller gets the answer to "which columns did
     you actually mean" from the same place that owns the ids. `unknown` is
     reported rather than swallowed: a saved view naming a column that no longer
     exists must say so, or the reader is left diffing two lists by eye. */
  const columns = resolveAsinColumns(filters.columns)

  return {
    rows: rows.map(row => projectAsinRow({ ...row, completeness_total: ASIN_LISTING_FIELDS.length })),
    total,
    limit,
    offset,
    /* F05-08 的三格读回对账，见上面那一段注释。`archivedTotal` 在库升不到位时是
       `null`（`archivedAsinCount` 的约定）—— 与「0 个」不是一件事。 */
    archived: archivedMode,
    archivedHidden,
    archivedTotal,
    columns: columns.ids,
    unknownColumns: columns.unknown,
    /* The full catalog rides along so a caller can label the columns without
       importing the domain module — and so the page's header comes from the same
       list the rows were projected with. */
    columnCatalog: ASIN_COLUMNS.map(column => ({ id: column.id, label: column.label, hasSource: column.hasSource !== false })),
  }
}

export function getAsin(store, asin, marketplace) {
  const key = [String(asin).trim().toUpperCase(), String(marketplace).trim().toUpperCase()]
  const row = store.get('SELECT * FROM asin WHERE asin = ? AND marketplace = ?', key)
  if (row === undefined) return undefined

  return {
    row,
    snapshots: store.all(
      `SELECT id, source_id, collected_at, payload_json FROM asin_snapshot
        WHERE asin = ? AND marketplace = ? ORDER BY collected_at DESC LIMIT 20`,
      key,
    ),
    provenance: store.all(
      `SELECT field, source_id, value, confidence, updated_at FROM asin_field_source
        WHERE asin = ? AND marketplace = ? ORDER BY field, source_id`,
      key,
    ),
    keywords: store.all(
      `SELECT keyword, source_id, rank, search_volume, collected_at FROM asin_keyword
        WHERE asin = ? AND marketplace = ? ORDER BY rank IS NULL DESC, search_volume DESC LIMIT 200`,
      key,
    ),
    listing: store.get('SELECT * FROM listing WHERE asin = ? AND marketplace = ?', key),
  }
}

/**
 * Write one collection snapshot, and register it as a version of the listing.
 *
 * The registry row is written **here**, at the one boundary every collection
 * crosses, rather than at each caller: a version that only some callers register
 * is a registry that answers "which version did this run read?" for some runs.
 *
 * It is a *pointer*, not a frozen copy, because `asin_snapshot` is append-only —
 * the row is the body and cannot be overwritten, so a second copy here would be
 * a second thing to keep in sync. `created_at` is the row's own `collected_at`,
 * matching the v25 backfill (schema.js): a version whose timestamp disagrees
 * with the row it points at is worse than no version at all.
 */
export function upsertSnapshot(store, { asin, marketplace, sourceId, payload, collectedAt }) {
  const asinKey = String(asin).toUpperCase()
  const marketplaceKey = String(marketplace).toUpperCase()
  const at = collectedAt ?? nowIso()
  const written = store.run(
    `INSERT INTO asin_snapshot (asin, marketplace, source_id, collected_at, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
    [asinKey, marketplaceKey, String(sourceId), at, JSON.stringify(payload ?? {})],
  )
  registerSnapshot(store, {
    objectType: 'listing',
    objectId: `${asinKey}@${marketplaceKey}`,
    refTable: 'asin_snapshot',
    refId: String(written.lastInsertRowid),
    createdAt: at,
  })
  return written
}

/* ─────────────────────────────── keywords ─────────────────────────────── */

/**
 * Insert or update one keyword in the master library.
 *
 * The library is the *index* of words worth caring about; the per-ASIN facts
 * live in `asin_keyword`. So the update here is deliberately narrow: a word
 * already in the library keeps its `first_seen_at` (when we first came across
 * it is history), and a scan that has nothing to say about `tier` must not
 * erase a tier a previous, better-informed pass computed.
 */
export function upsertKeyword(store, record) {
  const keyword = keywordKey(record?.keyword)
  const marketplace = String(record?.marketplace ?? '').trim().toUpperCase()
  if (keyword === '') throw new Error('keyword is required')
  if (marketplace === '') throw new Error('marketplace is required')

  const sourceId = record.sourceId ? String(record.sourceId) : null
  if (sourceId !== null) assertSourceExists(store, sourceId)

  const now = nowIso()
  store.run(
    `INSERT INTO keyword
       (keyword, marketplace, tier, tier_basis_json, search_volume, difficulty, source_id,
        first_seen_at, updated_at, tags_json, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(keyword, marketplace) DO UPDATE SET
       tier             = COALESCE(excluded.tier, keyword.tier),
       tier_basis_json  = COALESCE(excluded.tier_basis_json, keyword.tier_basis_json),
       search_volume    = COALESCE(excluded.search_volume, keyword.search_volume),
       difficulty       = COALESCE(excluded.difficulty, keyword.difficulty),
       source_id        = COALESCE(excluded.source_id, keyword.source_id),
       tags_json        = COALESCE(excluded.tags_json, keyword.tags_json),
       note             = COALESCE(excluded.note, keyword.note),
       updated_at       = excluded.updated_at`,
    [
      keyword,
      marketplace,
      record.tier ?? null,
      record.tierBasis === undefined || record.tierBasis === null ? null : JSON.stringify(record.tierBasis),
      record.searchVolume ?? record.search_volume ?? null,
      record.difficulty ?? null,
      sourceId,
      now,
      now,
      record.tags === undefined || record.tags === null ? null : JSON.stringify(record.tags),
      record.note ?? null,
    ],
  )
  return { keyword, marketplace, created: false }
}

/**
 * Insert or update one (ASIN, keyword) measurement.
 *
 * `rank: null` is a real value here — it means "we looked and it was not
 * there". It is written as null, never as a missing row, because the coverage
 * gap is computed from exactly that distinction.
 */
export function upsertAsinKeyword(store, record) {
  const asin = String(record?.asin ?? '').trim().toUpperCase()
  const marketplace = String(record?.marketplace ?? '').trim().toUpperCase()
  const keyword = keywordKey(record?.keyword)
  const sourceId = String(record?.sourceId ?? '').trim()
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN "${record?.asin}" (expected 10 letters/digits)`)
  if (marketplace === '') throw new Error('marketplace is required')
  if (keyword === '') throw new Error('keyword is required')
  if (sourceId === '') throw new Error('sourceId is required')
  assertSourceExists(store, sourceId)

  store.run(
    `INSERT INTO asin_keyword
       (asin, marketplace, keyword, source_id, rank, page, scan_depth, tier, tier_basis_json,
        search_volume, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asin, marketplace, keyword, source_id) DO UPDATE SET
       rank             = excluded.rank,
       page             = excluded.page,
       scan_depth       = excluded.scan_depth,
       tier             = excluded.tier,
       tier_basis_json  = excluded.tier_basis_json,
       search_volume    = COALESCE(excluded.search_volume, asin_keyword.search_volume),
       collected_at     = excluded.collected_at`,
    [
      asin,
      marketplace,
      keyword,
      sourceId,
      record.rank ?? null,
      record.page ?? null,
      record.scanDepth ?? null,
      record.tier ?? null,
      record.tierBasis === undefined || record.tierBasis === null ? null : JSON.stringify(record.tierBasis),
      record.searchVolume ?? null,
      record.collectedAt ?? nowIso(),
    ],
  )
  return { asin, marketplace, keyword, sourceId }
}

/** Query the master library, with how many of our ASINs actually rank for each word. */
export function queryKeywords(store, filters = {}) {
  const where = []
  const params = []

  if (filters.marketplace) {
    where.push('k.marketplace = ?')
    params.push(String(filters.marketplace).toUpperCase())
  }
  if (filters.tier) {
    where.push('k.tier = ?')
    params.push(String(filters.tier).toUpperCase())
  }
  if (filters.q) {
    // Folded, because the store now holds folded keywords and `LIKE` is
    // case-sensitive in SQLite. Without this the substring box would stop
    // matching anything typed with a capital — a usability regression the fold
    // would otherwise have introduced.
    where.push('k.keyword LIKE ?')
    params.push(`%${keywordKey(filters.q)}%`)
  }
  if (filters.minVolume !== undefined && filters.minVolume !== null) {
    where.push('k.search_volume >= ?')
    params.push(Number(filters.minVolume))
  }
  if (filters.untiered === true) where.push('k.tier IS NULL')

  const order = {
    tier: 'k.tier IS NULL, k.tier ASC, k.keyword ASC',
    keyword: 'k.keyword ASC',
    volume: 'k.search_volume IS NULL, k.search_volume DESC, k.keyword ASC',
    coverage: 'ranked DESC, k.keyword ASC',
    updated: 'k.updated_at DESC',
  }[filters.order] ?? 'k.updated_at DESC'

  const limit = clamp(Number(filters.limit ?? 50), 1, 500)
  const offset = clamp(Number(filters.offset ?? 0), 0, 1_000_000)

  const rows = store.all(
    `SELECT k.*,
            (SELECT COUNT(*) FROM asin_keyword ak
              WHERE ak.keyword = k.keyword AND ak.marketplace = k.marketplace
                AND ak.rank IS NOT NULL) AS ranked,
            (SELECT COUNT(*) FROM asin_keyword ak
              WHERE ak.keyword = k.keyword AND ak.marketplace = k.marketplace
                AND ak.rank IS NULL AND ak.scan_depth IS NOT NULL) AS missing,
            (SELECT COUNT(*) FROM asin_keyword ak
              WHERE ak.keyword = k.keyword AND ak.marketplace = k.marketplace
                AND ak.scan_depth IS NULL) AS unscanned
       FROM keyword k
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )

  const total = store.get(
    `SELECT COUNT(*) AS n FROM keyword k ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  )?.n ?? 0

  return { rows, total, limit, offset }
}

/**
 * What one ASIN covers, what it is missing, and what is worth adding.
 *
 * Three lists, and the difference between the last two is the point:
 *
 *   - `rows`       — every keyword this ASIN has been measured against.
 *   - `gaps`       — measured, and absent. This is a finding.
 *   - `untested`   — in the library, never measured for this ASIN. This is *not*
 *                    a gap, and reporting it as one would invent a problem.
 *   - `suggested`  — the order to work in: T3 first (relevant, unranked), then
 *                    T4 (needs a relevance call), then untested.
 */
export function keywordCoverage(store, asin, marketplace, { limit = 200 } = {}) {
  const key = [String(asin).trim().toUpperCase(), String(marketplace).trim().toUpperCase()]
  const cap = clamp(Number(limit ?? 200), 1, 1_000)

  const rows = store.all(
    `SELECT ak.keyword, ak.source_id, ak.rank, ak.page, ak.scan_depth, ak.tier,
            ak.tier_basis_json, ak.search_volume, ak.collected_at, k.tier AS library_tier
       FROM asin_keyword ak
       LEFT JOIN keyword k ON k.keyword = ak.keyword AND k.marketplace = ak.marketplace
      WHERE ak.asin = ? AND ak.marketplace = ?
      ORDER BY ak.rank IS NULL, ak.rank ASC, ak.keyword ASC
      LIMIT ?`,
    [...key, cap],
  )

  const untested = store.all(
    `SELECT k.keyword, k.tier, k.search_volume
       FROM keyword k
      WHERE k.marketplace = ?
        AND NOT EXISTS (
          SELECT 1 FROM asin_keyword ak
           WHERE ak.asin = ? AND ak.marketplace = k.marketplace AND ak.keyword = k.keyword
        )
      ORDER BY k.tier IS NULL, k.tier ASC, k.keyword ASC
      LIMIT ?`,
    [key[1], key[0], cap],
  )

  const ranked = rows.filter(row => row.rank !== null)
  const gaps = rows.filter(row => row.rank === null && row.scan_depth !== null)
  const unscanned = rows.filter(row => row.scan_depth === null)

  const byTier = { T1: 0, T2: 0, T3: 0, T4: 0 }
  for (const row of rows) if (row.tier !== null && byTier[row.tier] !== undefined) byTier[row.tier] += 1

  const suggested = [
    ...rows.filter(row => row.tier === 'T3').map(row => ({ keyword: row.keyword, tier: 'T3', reason: 'listing 已含该词但没有自然排名' })),
    ...rows.filter(row => row.tier === 'T4').map(row => ({ keyword: row.keyword, tier: 'T4', reason: '没有排名且 listing 未提，先判断相关度' })),
    ...untested.map(row => ({ keyword: row.keyword, tier: row.tier ?? null, reason: '库里有，但这个 ASIN 还没测过' })),
  ].slice(0, cap)

  return {
    asin: key[0],
    marketplace: key[1],
    rows,
    summary: {
      measured: rows.length,
      ranked: ranked.length,
      gaps: gaps.length,
      unscanned: unscanned.length,
      untested: untested.length,
      byTier,
    },
    gaps,
    untested,
    suggested,
  }
}

/**
 * The latest snapshot's payload for an ASIN, or null if it has never been
 * collected.
 *
 * Kept in the store layer because it is pure persistence — read a row, parse
 * it. Turning that payload into a *listing text* is a domain decision and lives
 * with the keyword code, so this layer never has to know what a listing is.
 */
export function latestSnapshotPayload(store, asin, marketplace) {
  const row = store.get(
    `SELECT payload_json FROM asin_snapshot
      WHERE asin = ? AND marketplace = ?
      ORDER BY collected_at DESC LIMIT 1`,
    [String(asin).trim().toUpperCase(), String(marketplace).trim().toUpperCase()],
  )
  if (row === undefined) return null
  try {
    return JSON.parse(row.payload_json)
  } catch {
    return null
  }
}

function assertSourceExists(store, sourceId) {
  const known = store.get('SELECT id FROM source WHERE id = ?', [String(sourceId)])
  if (known !== undefined) return
  const ids = store.all('SELECT id FROM source ORDER BY id').map(row => row.id)
  throw new Error(`unknown source "${sourceId}"; known sources: ${ids.join(', ')}`)
}

/* ─────────────────────────── collection tasks ─────────────────────────── */

/**
 * Columns a caller may write into `collection_task`, in both the insert and the
 * update path.
 *
 * This map is a **whitelist**, and that is its whole purpose: a key that is not
 * in it is silently dropped (`patch[key] === undefined` below). The silent part
 * is the trap — before v36 the fourteen collection-center columns existed in the
 * table but not here, so `updateCollectionTask(store, id, { waiting_json: … })`
 * would have updated `updated_at` and nothing else, with no error and a page that
 * reads NULL forever. The map therefore lives in **one** place and both writers
 * read it, so a column can only be forgotten once, not once per path.
 *
 * Values are stringified: SQLite's column affinity converts `'3'` into an
 * INTEGER for `scheme_version` / `attempt`, and every other new column is TEXT.
 */
const TASK_COLUMNS = {
  status: 'status',
  finished_at: 'finished_at',
  error: 'error',
  result_json: 'result_json',
  progress_json: 'progress_json',
  /* ── v36: the collection-center columns (all nullable except attempt) ── */
  side_split_json: 'side_split_json',
  ownership_evidence_json: 'ownership_evidence_json',
  scheme_id: 'scheme_id',
  scheme_version: 'scheme_version',
  plan_id: 'plan_id',
  prefill_json: 'prefill_json',
  env_check_json: 'env_check_json',
  env_checked_at: 'env_checked_at',
  waiting_json: 'waiting_json',
  resolved_at: 'resolved_at',
  risk_json: 'risk_json',
  reused_snapshots_json: 'reused_snapshots_json',
  retry_of: 'retry_of',
  attempt: 'attempt',
}

/**
 * Refuse a status the state machine does not know.
 *
 * A closed vocabulary that nothing enforces is decoration: `'complete'` beside
 * `'done'` would make every `WHERE status = 'done'` quietly wrong, and the page
 * would render the unknown word as its own literal. The guard is here rather
 * than in each caller because this is the only door into the column.
 */
function checkTaskStatus(status) {
  const value = String(status)
  if (!COLLECTION_TASK_STATES.includes(value)) {
    throw new Error(`collection_task.status "${status}" is not one of ${COLLECTION_TASK_STATES.join(' / ')}`)
  }
  return value
}

/**
 * Collection tasks are rows rather than in-memory jobs because collection takes
 * minutes and the agent is told to come back later. If the service restarts in
 * between, "what was asked for" has to survive.
 *
 * `kind` is `'asin'` or `'keyword'`. Keyword coverage scans share this table on
 * purpose: they have the same shape (submit, walk a list, write as you go,
 * report later), and one table means one status tool for the agent to learn
 * instead of two nearly identical ones.
 *
 * Any column in `TASK_COLUMNS` may also be passed directly on the record — that
 * is how a `draft` row gets its side split, or a `cooling_down` row its plan id,
 * without a second round trip that would leave a task briefly saying something
 * the caller did not mean. The v36 columns are all nullable, so an insert that
 * names none of them produces exactly the row the pre-v36 code produced.
 */
export function insertCollectionTask(store, record = {}) {
  const { id, sourceId, kind = 'asin', targets, fields, status = 'queued' } = record
  const now = nowIso()

  const values = {
    id: String(id),
    source_id: String(sourceId),
    kind: String(kind),
    targets_json: JSON.stringify(targets ?? []),
    fields_json: fields === null || fields === undefined ? null : JSON.stringify(fields),
    status: checkTaskStatus(status),
    submitted_at: now,
    updated_at: now,
    progress_json: JSON.stringify({ done: 0, total: Array.isArray(targets) ? targets.length : 0, phase: 'queued' }),
  }

  /* Whitelisted extras. `status` / `progress_json` are already set above from
     their named parameters, so the same keys here would only repeat what the
     caller already said. */
  for (const [key, column] of Object.entries(TASK_COLUMNS)) {
    if (record[key] === undefined) continue
    values[column] = key === 'status' ? checkTaskStatus(record[key]) : (record[key] === null ? null : String(record[key]))
  }

  const names = Object.keys(values)
  store.run(
    `INSERT INTO collection_task (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map(name => values[name]),
  )
  return getCollectionTask(store, id)
}

export function updateCollectionTask(store, id, patch = {}) {
  const sets = []
  const params = []

  for (const [key, column] of Object.entries(TASK_COLUMNS)) {
    if (patch[key] === undefined) continue
    const value = key === 'status' ? checkTaskStatus(patch[key]) : patch[key]
    sets.push(`${column} = ?`)
    params.push(value === null ? null : String(value))
  }

  sets.push('updated_at = ?')
  params.push(nowIso(), String(id))

  store.run(`UPDATE collection_task SET ${sets.join(', ')} WHERE id = ?`, params)
  return getCollectionTask(store, id)
}

export function getCollectionTask(store, id) {
  return store.get('SELECT * FROM collection_task WHERE id = ?', [String(id)])
}

export function listCollectionTasks(store, limit = 20) {
  return store.all(
    'SELECT * FROM collection_task ORDER BY submitted_at DESC LIMIT ?',
    [clamp(Number(limit ?? 20), 1, 200)],
  )
}

/**
 * Deal with tasks left behind by a restart.
 *
 * Every state a restart can strand is handled, and each has exactly one honest
 * home (contract §5.5):
 *
 *   · `running` — no process is behind it any more → `failed`, with the reason
 *     kept from whatever was there before. Nothing already collected is
 *     re-collected: the sections that reached `collected` keep their rows and
 *     their timestamps, because a restart is not evidence that a page changed.
 *   · `checking_env` — the check that was running died with the process →
 *     `failed`. It is not re-queued: a task that failed its environment check
 *     is waiting for a person, and silently re-running the check on every boot
 *     would make the failure invisible.
 *   · `cooling_down` — a cooldown is a bounded wait, and a restart is not a
 *     reason to serve it again → back to `queued`, which is also what puts it
 *     back in front of the runner (the caller re-enqueues every `queued` id).
 *   · `waiting_human` — **left exactly as it is**, including `deadlineAt`. The
 *     30 minutes are counted from when the person first saw it, so a restart
 *     must not restart that clock; writing the row again would move
 *     `updated_at` and make "how long has this been waiting" unanswerable. It
 *     is reported back in `held` so the caller can say so rather than leave it
 *     invisible.
 *   · `queued` — never started → handed back to the caller, which re-enqueues
 *     it. Silently dropping work the user asked for would be the wrong kind of
 *     tidy.
 *
 * Each transition leaves a `collection_task_event` row (§5.5's own acceptance
 * says so for the `running` case: "多一行 `source='plugin'` 的 `failed`"), written
 * here with the same INSERT the append-only history module uses rather than by
 * importing that module — `store/collection-transition.js` already imports this
 * file, and a cycle between the two would be worse than the four extra lines.
 *
 * `kind` is required, and that is not a convenience. Two services drain this
 * table (ASIN collection and keyword scanning), and a shared "give me every
 * queued task" would hand a keyword scan to the ASIN collector, which would
 * read `{keyword, marketplace}` as a target and reject every entry as a
 * malformed ASIN. Partitioning here is what keeps each queue homogeneous.
 */
export function recoverStaleTasks(store, kind = 'asin') {
  const now = nowIso()
  const scope = String(kind)
  const rows = store
    .all(
      `SELECT id, status FROM collection_task
        WHERE status IN ('running','checking_env','cooling_down','waiting_human')
          AND COALESCE(kind, 'asin') = ?
        ORDER BY submitted_at`,
      [scope],
    )

  const interrupted = []
  const resumed = []
  const held = []
  let sequence = 0

  const event = (taskId, fromStatus, toStatus, reason) => {
    sequence += 1
    store.run(
      `INSERT INTO collection_task_event
         (id, task_id, from_status, to_status, reason, source, evidence_json, at, by)
       VALUES (?, ?, ?, ?, ?, 'plugin', NULL, ?, NULL)`,
      [`cte-${taskId}-${toStatus}-${sequence}-${now}`, taskId, fromStatus, toStatus, reason, now],
    )
  }

  for (const row of rows) {
    if (row.status === 'running') {
      store.run(
        `UPDATE collection_task
            SET status = 'failed', finished_at = ?, updated_at = ?,
                error = COALESCE(error, '服务重启，任务中断')
          WHERE id = ?`,
        [now, now, row.id],
      )
      event(row.id, 'running', 'failed', '服务重启，任务中断')
      interrupted.push(row.id)
      continue
    }
    if (row.status === 'checking_env') {
      store.run(
        `UPDATE collection_task
            SET status = 'failed', finished_at = ?, updated_at = ?,
                error = COALESCE(error, '服务重启，环境体检中断')
          WHERE id = ?`,
        [now, now, row.id],
      )
      event(row.id, 'checking_env', 'failed', '服务重启，环境体检中断')
      interrupted.push(row.id)
      continue
    }
    if (row.status === 'cooling_down') {
      /* A restart must not reset the cooldown clock: the recovery has to judge
         the deadline the task row already carries, not install a new one.
         (`submit` writes `risk_json.cooldownUntil` when it parks a task in
         `cooling_down`; a legacy row without one is given one bounded wait, not
         a silent fast lane back into the queue.) */
      const riskRow = store.get('SELECT risk_json FROM collection_task WHERE id = ?', [row.id])
      const risk = riskRow === undefined || riskRow.risk_json === null ? null : JSON.parse(riskRow.risk_json)
      const until = typeof risk?.cooldownUntil === 'string' && Number.isFinite(new Date(risk.cooldownUntil).getTime())
        ? new Date(risk.cooldownUntil).getTime()
        : null
      if (until !== null && until <= new Date(now).getTime()) {
        store.run(
          "UPDATE collection_task SET status = 'queued', updated_at = ? WHERE id = ?",
          [now, row.id],
        )
        event(row.id, 'cooling_down', 'queued', '冷却已结束，任务重新入队')
        resumed.push(row.id)
        continue
      }
      /* 冷却未过：留在 `cooling_down`，把「为什么没开跑」留在历史里 ——
         开跑前的复查（`collection.js` 的 `startCooldownGate`）另有事件。 */
      if (until === null) {
        const fallbackUntil = new Date(new Date(now).getTime() + 60 * 60_000).toISOString()
        store.run('UPDATE collection_task SET risk_json = ?, updated_at = ? WHERE id = ?', [
          JSON.stringify({ ...(risk ?? {}), level: 'high', cooldownUntil: fallbackUntil, cooldownMinutes: 60 }),
          now,
          row.id,
        ])
        event(row.id, 'cooling_down', 'cooling_down', '重启恢复：行上没有冷却截止时间，补记一个（60 分钟），防止直接开跑')
      } else {
        const remainingMinutes = Math.ceil((until - new Date(now).getTime()) / 60_000)
        event(row.id, 'cooling_down', 'cooling_down', `重启恢复：冷却未过（至 ${risk.cooldownUntil}，还剩 ${remainingMinutes} 分钟），保持冷却态`)
      }
      continue
    }
    /* `waiting_human`: deliberately not written. See the header. */
    held.push(row.id)
  }

  const queued = store
    .all("SELECT id FROM collection_task WHERE status = 'queued' AND COALESCE(kind, 'asin') = ? ORDER BY submitted_at", [scope])
    .map(row => row.id)
  return { interrupted, requeued: queued, held }
}

/* ─────────────────────── listing & optimization runs ─────────────────────── */

/**
 * The provenance values `listing.origin` may hold (v8).
 *
 *   draft-applied  the optimization write-back wrote this row — the plugin's own draft
 *   snapshot       materialised from a collection snapshot — the storefront's copy
 *   manual         hand-entered or imported by a human
 *
 * A row written before v8 has no origin. `listingBefore` reports that as `null`
 * rather than guessing, and the report labels it "未知" — the one honest answer
 * when we cannot tell whether it was online copy or an earlier plugin draft.
 */
export const LISTING_ORIGINS = ['draft-applied', 'snapshot', 'manual']

/**
 * Write the current listing for an ASIN.
 *
 * `version` increments on every write, because an optimization report has to say
 * which text it was judging. Without the counter, "the listing as it was when
 * this report was made" is unanswerable the moment anyone edits the copy.
 *
 * Backend search terms and attributes arrive here and nowhere else: they live in
 * Seller Central, not on the product page, so the browser channel can never
 * collect them. A null leaves the stored value alone — a caller that only knows
 * the title must not blank the attributes.
 *
 * `origin` (v8) records *who* wrote the row, so a later report can tell the
 * storefront's real copy from the plugin's own previous draft. It is optional:
 * omitted, the column keeps whatever it had (null on a fresh insert). A provided
 * value must be one of `LISTING_ORIGINS` — a typo must fail loud, not store a
 * provenance nothing can interpret.
 */
export function upsertListing(store, record) {
  const asin = String(record?.asin ?? '').trim().toUpperCase()
  const marketplace = String(record?.marketplace ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN "${record?.asin}" (expected 10 letters/digits)`)
  if (marketplace === '') throw new Error('marketplace is required')
  const sourceId = record.sourceId ? String(record.sourceId) : null
  if (sourceId !== null) assertSourceExists(store, sourceId)

  const origin = record.origin === undefined || record.origin === null || String(record.origin).trim() === ''
    ? null
    : String(record.origin).trim()
  if (origin !== null && !LISTING_ORIGINS.includes(origin)) {
    throw new Error(`invalid listing origin "${record.origin}" (expected one of ${LISTING_ORIGINS.join(' / ')})`)
  }

  const bullets = record.bullets
  const attributes = record.attributes
  const now = nowIso()

  store.run(
    `INSERT INTO listing
       (asin, marketplace, title, bullets_json, description, a_plus, search_terms,
        item_highlights, attributes_json, source_id, origin, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(asin, marketplace) DO UPDATE SET
       title           = COALESCE(excluded.title, listing.title),
       bullets_json    = COALESCE(excluded.bullets_json, listing.bullets_json),
       description     = COALESCE(excluded.description, listing.description),
       a_plus          = COALESCE(excluded.a_plus, listing.a_plus),
       search_terms    = COALESCE(excluded.search_terms, listing.search_terms),
       item_highlights = COALESCE(excluded.item_highlights, listing.item_highlights),
       attributes_json = COALESCE(excluded.attributes_json, listing.attributes_json),
       source_id       = COALESCE(excluded.source_id, listing.source_id),
       origin          = COALESCE(excluded.origin, listing.origin),
       version         = listing.version + 1,
       updated_at      = excluded.updated_at`,
    [
      asin,
      marketplace,
      record.title ?? null,
      bullets === undefined || bullets === null ? null : JSON.stringify(bullets),
      record.description ?? null,
      record.aPlus ?? record.a_plus ?? null,
      record.searchTerms ?? record.search_terms ?? null,
      record.itemHighlights ?? record.item_highlights ?? null,
      attributes === undefined || attributes === null ? null : JSON.stringify(attributes),
      sourceId,
      origin,
      now,
    ],
  )
  return getListing(store, asin, marketplace)
}

/** The stored listing, with bullets and attributes parsed back into values. */
export function getListing(store, asin, marketplace) {
  const row = store.get(
    'SELECT * FROM listing WHERE asin = ? AND marketplace = ?',
    [String(asin ?? '').trim().toUpperCase(), String(marketplace ?? '').trim().toUpperCase()],
  )
  if (row === undefined || row === null) return null
  return {
    ...row,
    bullets: parseJson(row.bullets_json, []),
    attributes: parseJson(row.attributes_json, null),
  }
}
/**
 * The listing text a report compares against.
 *
 * Falls back to the newest collected snapshot when no listing row exists, so a
 * first optimization on a freshly collected ASIN still has a "before" instead of
 * an empty column. The fallback is reported (`source`), because "before" that
 * came from a scrape and "before" that came from Seller Central are not the same
 * claim.
 *
 * `origin` (v8) says *who wrote the stored row*: `draft-applied` is the plugin's
 * own previous draft (the report compares against its own shadow), `snapshot` is
 * the storefront's copy, `manual` is hand-entered. It is `null` for a row written
 * before v8, which the report labels "未知" rather than guessing — collapsing
 * "a plugin draft" and "the live copy" is the exact confusion this column ends.
 */
export function listingBefore(store, asin, marketplace) {
  const stored = getListing(store, asin, marketplace)
  if (stored !== null) return { ...stored, source: 'listing', origin: stored.origin ?? null }
  const snapshot = latestSnapshotPayload(store, asin, marketplace)
  if (snapshot === null) return null
  return {
    asin: String(asin).trim().toUpperCase(),
    marketplace: String(marketplace).trim().toUpperCase(),
    title: snapshot.fields?.title ?? null,
    bullets: Array.isArray(snapshot.raw?.bullets) ? snapshot.raw.bullets : [],
    description: snapshot.fields?.description ?? null,
    search_terms: null,
    version: null,
    source: 'snapshot',
    /* A row that only exists as a snapshot is, by definition, the storefront's
       copy — not a plugin draft. */
    origin: 'snapshot',
  }
}

/* The status column is a closed set, and the guard is here rather than in the
   tool that happens to write it today. `amzn_optimize_save` takes `status` as a
   free-form string from the agent, so without this a run could be stored as
   `"constructor"` — which the page would then render as `undefined`, turning a
   data problem into a rendering one. Same reasoning as the package-origin guard
   below: a guard in the caller only protects that caller. */
function assertRunStatus(status) {
  if (!OPTIMIZATION_RUN_STATUSES.includes(status)) {
    throw new Error(
      `unknown optimization run status ${JSON.stringify(status)} — `
      + `expected one of: ${OPTIMIZATION_RUN_STATUSES.join(' | ')}`,
    )
  }
  return status
}

export function insertOptimizationRun(store, record) {
  const id = String(record?.id ?? '').trim()
  const asin = String(record?.asin ?? '').trim().toUpperCase()
  const marketplace = String(record?.marketplace ?? '').trim().toUpperCase()
  if (id === '') throw new Error('run id is required')
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN "${record?.asin}"`)
  if (marketplace === '') throw new Error('marketplace is required')
  const status = assertRunStatus(String(record?.status ?? 'running'))

  /* Every keyword in the package has to carry where it came from.
     A word with no `origin` reads as "we know this about our own listing", when
     it may have come from the imported library and never have been checked — the
     same failure as a search volume with no source. The guard lives here because
     this is the single place a package is written: a guard in the caller only
     protects that caller. */
  const packaged = record?.package?.keywords
  if (Array.isArray(packaged)) {
    const missing = packaged.filter(entry => entry === null || typeof entry !== 'object' || String(entry.origin ?? '') === '')
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} of ${packaged.length} keywords in the package have no origin `
        + `(first: "${missing[0]?.keyword ?? '?'}") — a word with no source reads as if we measured it`,
      )
    }
  }

  store.run(
    `INSERT INTO optimization_run
       (id, asin, marketplace, status, session_id, rules_version, rule_set_version, rules_json,
        package_json, summary, started_at, prompt_version, agent_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      asin,
      marketplace,
      status,
      record.sessionId ?? null,
      record.rulesVersion ?? null,
      record.ruleSetVersion ?? record.rulesVersion ?? null,
      record.rules === undefined || record.rules === null ? null : JSON.stringify(record.rules),
      record.package === undefined || record.package === null ? null : JSON.stringify(record.package),
      record.summary ?? null,
      record.startedAt ?? nowIso(),
      /* F14-02 §28.2 的两个「身份索引」（v47）。内容快照在别处，这里只记「是哪一版」：
          · `prompt_version` —— 这一轮实际渲染的 optimize 组装提示词各层版本（形如
            `fixed@v3; evidence@v1; contract@v2`）。逐层正文在 `package_json.prompts`，
            这里是索引，与 `rules_version`（索引）+ `rules_json`（内容）同一个配法。
          · `agent_run_id` —— 模块 12 的 `agent_run.id`。这一轮由哪次 Agent 运行发起，
            角色 / 任务类型 / 状态 / 步骤都在那一行上，这里只存引用，不复制。
         **不传就是 NULL**（= 这一轮没有记录），不编一个值。 */
      record.promptVersion ?? null,
      record.agentRunId ?? null,
    ],
  )
  return getOptimizationRun(store, id)
}

export function getOptimizationRun(store, id) {
  const row = store.get('SELECT * FROM optimization_run WHERE id = ?', [String(id ?? '').trim()])
  if (row === undefined || row === null) return null
  return { ...row, drafts: listOptimizationDrafts(store, row.id) }
}

/**
 * 三份导出件在不在 —— **一次读库回答一批 run**，返回 `Map<runId, {md, html, xlsx}>`。
 *
 * ## 为什么要有「批量」这一份
 *
 * 报告库列表一页最多 100 行、页面 3 秒轮询一次。逐行调 `getOptimizationRun` 是
 * `SELECT *`（连三个 blob 一起搬），100 行就是 3 秒内读一遍所有工作簿。所以这里一条
 * `IN (...)`，并且**只把「在不在」搬出来**：三列用 `substr(col, 1, 1)` 折成一个字符。
 *
 * ## 判据仍然只有 `availabilityOf`
 *
 * 折出来的值原样交给 `domain/reports/export.js#availabilityOf` —— 单条导出
 * （`exportArtifact`）走的是同一个函数、喂的是完整那一列，所以「列表说能导、点下去 404」
 * 这种不一致不可能从两套判据里长出来。
 *
 * SQL 那三个 `CASE` 只负责「要不要把内容交给它」，不负责下结论：`trim(…, 空白字符集)`
 * 与 `length(blob) > 0` 是 `availabilityOf` 里 `blank()` / `hasBytes()` 的 SQL 面。
 * 两份拼写能同时存在是因为一个在 JS、一个在 SQL；它们**行为一致**这件事由
 * `tests/f14-10-report-export.mjs` 用一组刁钻值（null / 空串 / 纯空白 / 有内容 /
 * 零长 blob / 非零 blob）逐条对账，而不是靠注释声明。
 */
export function optimizationArtifactMap(store, ids) {
  const out = new Map()
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id ?? '').trim()).filter(id => id !== ''))]
  if (list.length === 0) return out
  const placeholders = list.map(() => '?').join(', ')
  const rows = store.all(
    `SELECT id,
            CASE WHEN trim(report_md, ' ' || char(9) || char(10) || char(13) || char(11) || char(12)) <> ''
                 THEN substr(report_md, 1, 1) END AS report_md,
            CASE WHEN trim(report_html, ' ' || char(9) || char(10) || char(13) || char(11) || char(12)) <> ''
                 THEN substr(report_html, 1, 1) END AS report_html,
            CASE WHEN report_xlsx IS NOT NULL AND length(report_xlsx) > 0
                 THEN substr(report_xlsx, 1, 1) END AS report_xlsx
       FROM optimization_run WHERE id IN (${placeholders})`,
    list,
  )
  for (const row of rows) out.set(String(row.id), availabilityOf(row))
  return out
}

export function listOptimizationRuns(store, filters = {}) {
  const where = []
  const params = []
  if (filters.asin) { where.push('asin = ?'); params.push(String(filters.asin).trim().toUpperCase()) }
  if (filters.marketplace) { where.push('marketplace = ?'); params.push(String(filters.marketplace).trim().toUpperCase()) }
  if (filters.status) { where.push('status = ?'); params.push(String(filters.status)) }
  const limit = clamp(filters.limit ?? 30, 1, 200)
  const rows = store.all(
    `SELECT r.*, (SELECT COUNT(*) FROM optimization_draft d WHERE d.run_id = r.id) AS draft_count
       FROM optimization_run r
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.started_at DESC
       LIMIT ?`,
    [...params, limit],
  )
  return { rows, total: Number(store.get('SELECT COUNT(*) AS n FROM optimization_run')?.n ?? 0), limit }
}

/** Patch a run. Only the fields present are written; omitted ones are preserved.
 *
 *  ⚠️ `prompt_version` / `agent_run_id`（v47）**故意不在这里**：它们是「这一轮一开始
 *  用的是什么」的索引，写一次之后不许改。放进 patch 面就等于允许把一条老轮次的
 *  Prompt 版本改成今天的那一版 —— 而那一列存在的唯一目的，就是回答「**当时**用的
 *  是哪一版」。改它和给缺失编一个值是同一种错误。 */
export function updateOptimizationRun(store, id, patch = {}) {
  const sets = []
  const params = []
  const put = (column, value) => { sets.push(`${column} = ?`); params.push(value) }
  /* Checked before any other field is collected, so a refused status writes
     nothing at all rather than half a patch. */
  if (patch.status !== undefined) put('status', assertRunStatus(String(patch.status)))
  if (patch.summary !== undefined) put('summary', patch.summary)
  if (patch.reportMd !== undefined) put('report_md', patch.reportMd)
  if (patch.reportHtml !== undefined) put('report_html', patch.reportHtml)
  /* F14-10：Excel 是同一份模型的第三种渲染，与上面两列在**同一次** update 里落库。
     一次 update 而不是两次，是为了让「三份字节属于同一刻」这件事是结构上的：分开写
     就存在「MD/HTML 已更新、Excel 还是上一版」的中间态，而那种不一致不会报错。 */
  if (patch.reportXlsx !== undefined) {
    const value = patch.reportXlsx
    put('report_xlsx', value === null || value === undefined ? null : value)
  }
  if (patch.error !== undefined) put('error', patch.error)
  if (patch.finishedAt !== undefined) put('finished_at', patch.finishedAt)
  if (sets.length === 0) return getOptimizationRun(store, id)
  params.push(String(id ?? '').trim())
  store.run(`UPDATE optimization_run SET ${sets.join(', ')} WHERE id = ?`, params)
  return getOptimizationRun(store, id)
}

/**
 * Insert or update one field's draft.
 *
 * Keyed on (run_id, field) so re-validating a field replaces its verdict instead
 * of stacking a second copy — otherwise a report shows the same field twice with
 * two different sets of violations, and neither is wrong.
 */
export function upsertOptimizationDraft(store, record) {
  const runId = String(record?.runId ?? '').trim()
  const field = String(record?.field ?? '').trim()
  if (runId === '') throw new Error('runId is required')
  if (field === '') throw new Error('field is required')
  if (store.get('SELECT id FROM optimization_run WHERE id = ?', [runId]) === undefined) {
    throw new Error(`no optimization run ${runId}`)
  }

  const now = nowIso()
  store.run(
    `INSERT INTO optimization_draft
       (run_id, field, before, after, violations_json, keywords_json, severity, rationale, accepted, context_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, field) DO UPDATE SET
       before          = COALESCE(excluded.before, optimization_draft.before),
       after           = COALESCE(excluded.after, optimization_draft.after),
       violations_json = excluded.violations_json,
       keywords_json   = COALESCE(excluded.keywords_json, optimization_draft.keywords_json),
       severity        = excluded.severity,
       rationale       = COALESCE(excluded.rationale, optimization_draft.rationale),
       accepted        = COALESCE(excluded.accepted, optimization_draft.accepted),
       context_id      = COALESCE(excluded.context_id, optimization_draft.context_id),
       updated_at      = excluded.updated_at`,
    [
      runId,
      field,
      record.before ?? null,
      record.after ?? null,
      record.violations === undefined || record.violations === null ? null : JSON.stringify(record.violations),
      record.keywords === undefined || record.keywords === null ? null : JSON.stringify(record.keywords),
      record.severity ?? (Array.isArray(record.violations) && record.violations.some(v => v.severity === 'block') ? 'block' : record.violations ? 'warn' : null),
      record.rationale ?? null,
      record.accepted === undefined ? null : record.accepted,
      /* The context the draft was written in (v19). `null` is a real value here
         — "this write did not know its context" — and COALESCE keeps a draft's
         recorded context from being erased by a later edit that omitted it. */
      record.contextId === undefined || record.contextId === null ? null : String(record.contextId).trim(),
      now,
    ],
  )
  const row = store.get('SELECT * FROM optimization_draft WHERE run_id = ? AND field = ?', [runId, field])
  /* The draft's version. `optimization_draft` is keyed on (run_id, field) and
     overwritten in place, so there is no append-only row to point at: a pointer
     would silently follow the next re-validation. The body is frozen instead.
     The row id survives a re-write, which is what makes "version 2 of the same
     draft" mean the same draft and not a second one. */
  registerSnapshot(store, {
    objectType: 'draft',
    objectId: String(row.id),
    payload: row,
  })
  return row
}

export function listOptimizationDrafts(store, runId) {
  return store.all(
    'SELECT * FROM optimization_draft WHERE run_id = ? ORDER BY id',
    [String(runId ?? '').trim()],
  )
}

/**
 * Bump the run's draft version (v31).
 *
 * 模块 14 §6 要求发布记录引用「optimization_run_id **与草案版本**」，而草案在此之前
 * 没有任何版本概念。递增点是这里，因为 `setDraftAccepted` 是 `accepted` 的**唯一**
 * 写入方 —— 版本号只有在「有一个地方能改它」时才是一个真数字。
 */
export function bumpDraftVersion(store, runId) {
  const run = String(runId ?? '').trim()
  if (run === '') return null
  store.run('UPDATE optimization_run SET draft_version = draft_version + 1 WHERE id = ?', [run])
  return store.get('SELECT draft_version FROM optimization_run WHERE id = ?', [run])?.draft_version ?? null
}

/**
 * Accept or reject one field. `null` puts it back to undecided.
 *
 * **只在实际变化时递增草案版本。** 重复采纳同一个值是一次没有改变任何东西的调用，
 * 若它也递增，版本号就不再是「批准的是哪一版」而变成「有人点过多少次」，而 §6 的
 * 「发布记录引用草案版本」正是拿它来回答前一个问题的。
 *
 * `IS NOT` 而不是 `<>`：`<>` 遇到 NULL 求值为 NULL（当作假），于是「把未决定改成
 * 不采纳」会被判成没有变化 —— 而那恰恰是一次真实的决定，也是草案版本必须变的一次。
 */
export function setDraftAccepted(store, runId, field, accepted) {
  const run = String(runId ?? '').trim()
  const name = String(field ?? '').trim()
  const value = accepted === null || accepted === undefined ? null : (accepted ? 1 : 0)
  const result = store.run(
    'UPDATE optimization_draft SET accepted = ?, updated_at = ? WHERE run_id = ? AND field = ? AND (accepted IS NOT ?)',
    [value, nowIso(), run, name, value],
  )
  if (Number(result?.changes ?? 0) > 0) bumpDraftVersion(store, run)
  return store.get('SELECT * FROM optimization_draft WHERE run_id = ? AND field = ?', [run, name])
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/* ─────────────────────────────── counts ──────────────────────────────── */

/** One row per table the workbench header shows, in a single round trip. */
export function counts(store) {
  const one = (sql) => Number(store.get(sql)?.n ?? 0)
  return {
    asin: one('SELECT COUNT(*) AS n FROM asin'),
    /* 顶栏「库: N ASIN / M 词」里的 M。
     以前这里数的是 `keyword`（扫描层，16 行），而真正的关键词总库是 `kw_master`
     （30,778 行）—— 界面上写「16 词」，库里其实有三万个词，运营会以为自己只有一个词库底。
     两个数都留着：`keyword` 是"正在监控的词"，`keywordMaster` 是"总库有多少词"。 */
  keyword: one('SELECT COUNT(*) AS n FROM keyword'),
  keywordMaster: one('SELECT COUNT(*) AS n FROM kw_master'),
    asinKeyword: one('SELECT COUNT(*) AS n FROM asin_keyword'),
    snapshot: one('SELECT COUNT(*) AS n FROM asin_snapshot'),
    collectionTask: one('SELECT COUNT(*) AS n FROM collection_task'),
    collectionRunning: one("SELECT COUNT(*) AS n FROM collection_task WHERE status IN ('queued','running')"),
    optimizationRun: one('SELECT COUNT(*) AS n FROM optimization_run'),
    sourceEnabled: one('SELECT COUNT(*) AS n FROM source WHERE enabled = 1'),
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

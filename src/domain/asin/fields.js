/**
 * 字段级事实（模块 05 F05-03）—— 一个 Listing 字段的**全部**说法与它们的时间。
 *
 * ## 七项，一项都不能省
 *
 * 需求 §19.2 的 F05-03 列了七项：当前采用值 / 所有来源值 / 采集导入时间 / 新鲜度 /
 * 是否人工确认 / 与上一快照差异 / 下游被谁引用。少任何一项，这张表都会退化成
 * 「一个值加几个装饰」，而它存在的理由是回答「这个值凭什么」。
 *
 * ## 三条口径，写在这里免得每处各猜一次
 *
 *   1. **当前采用值 = `asin.<field>`**（`domain/data/lineage.js` 的第一跳也是这么说的）。
 *      来源那一列是**最近写这个字段的那条来源行**，不是「最可信的那条」——
 *      我们不做可信度排序，排序规则是编出来的，而「谁最后写的」是库里的一个事实。
 *   2. **人工修正不改原始值**：人工值落在 `asin_field_source` 的一条 `source_type='manual'`
 *      行上，采集/导入那一行**一个字节都不动**，快照里的原文也不动。于是
 *      `original` 这一栏指的是「被采用值压在下面的那份读数」，它仍然读得到。
 *   3. **没有观测时间就是没有**：`observed_at` 为空时新鲜度是 `unknown`，而不是
 *      `fresh`、也不是 `stale`。把「没人记过它什么时候是真的」画成一个日期，是这类
 *      页面最容易犯、也最没人能发现的错。
 *
 * ## 「本系统没有这个字段」与「这个字段没测到」分开说
 *
 * 每个字段带 `lineageState`（`present` / `never_collected` / `not_on_page` / `failed`，
 * 词表来自 `domain/data/lineage.js`）。四态各有各的修法，合并成「缺失」会让一个
 * 选择器 bug 变成「这个商品没有价格」并一直留着。
 */

import { ageInDays, FRESHNESS_STATES, freshnessClassFor, freshnessOf } from '../data/freshness.js'
import { diffPayloads } from '../snapshot/diff.js'
import { LINEAGE_STATES, lineageState } from '../data/lineage.js'

/**
 * 参与「字段级事实」的字段。
 *
 * 这是 `src/store/queries.js` 的 `ASIN_FIELDS`（写白名单）在**读侧**的那一份名字：
 * 两张表回答的问题不同（一个说「允许写哪些列」，一个说「要给哪些列讲清来历」），
 * 但它们的**名字必须一样** —— 名字漂开的那天，页面会给一个不存在的列讲故事。
 * 测试逐字比对这两份清单（从 queries.js 的源码里读出来），所以这条不靠自觉。
 */
export const ASIN_FACT_FIELDS = [
  'title', 'brand', 'price', 'currency', 'bsr', 'category',
  'rating', 'reviews', 'image_url', 'product_line_id',
]

/** 中文标签。页面与服务端工具共用一份，避免两处各写一套。 */
export const ASIN_FACT_LABELS = {
  title: '标题',
  brand: '品牌',
  price: '价格',
  currency: '币种',
  bsr: 'BSR',
  category: '类目',
  rating: '评分',
  reviews: '评论数',
  image_url: '主图',
  product_line_id: '产品线',
}

/** 人工修正用的来源 id。「写人工来源」这句话落到库上就是这一个字符串。 */
export const MANUAL_SOURCE_ID = 'manual'

/** 数值型的列。人工修正往这些列里写非数字，SQLite 会把它当文本存进去 —— 静默的脏数据。 */
const NUMERIC_FIELDS = new Set(['price', 'bsr', 'rating', 'reviews'])

/** 这个字段的列是不是数值型。工具/路由用它决定要不要先转数字再写。 */
export function isNumericFactField(field) {
  return NUMERIC_FIELDS.has(String(field ?? '').trim())
}

export const FIELD_FACT_STATES = LINEAGE_STATES
export const FIELD_FRESHNESS_STATES = FRESHNESS_STATES

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/** 值比 JSON 化后的字符串 —— `1` 与 `"1"` 是两件事，不能算「同一个值」。 */
function sameFact(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/**
 * 下游引用：谁在读这个 ASIN 的这个字段。
 *
 * 四种，分开列而不是合成一个数字 —— 「两个下游」这句话在「两次优化运行」与
 * 「两条发布记录」之间没有共同的处置动作：
 *
 *   · `optimization_draft` —— 有人为这个字段起草过改动（还没裁决的最值得看）；
 *   · `publication_record` —— 这个 ASIN 的发布记录（批准/实际发布的 payload 里含该字段时标记）；
 *   · `observation_checkpoint` —— 由那些发布记录派生的观测结论；
 *   · `asin_keyword` —— 关键词侧按这个 ASIN 记的排名事实。
 *
 * **空数组是有内容的答案**：它说的是「这个字段没有任何下游在读」。页面据此写
 * 「没有任何下游引用」，而不是留白 —— 留白会被读成「没查」。
 */
function downstreamFor(store, key, market, field) {
  const rows = []
  const drafts = store.all(
    `SELECT d.id AS draft_id, d.accepted, r.id AS run_id, r.status AS run_status
       FROM optimization_draft d JOIN optimization_run r ON r.id = d.run_id
      WHERE r.asin = ? AND r.marketplace = ? AND d.field = ?
      ORDER BY r.started_at DESC LIMIT 20`,
    [key, market, field],
  )
  for (const row of drafts) {
    rows.push({
      kind: 'optimization_draft',
      ref: `${row.run_id}#${row.draft_id}`,
      runId: row.run_id,
      label: `优化运行 ${String(row.run_id).slice(0, 8)}（${row.run_status}）的 ${field} 草案`,
      undecided: row.accepted === null || row.accepted === undefined,
    })
  }

  const publications = store.all(
    `SELECT id, kind, published_at, approved_json, published_json
       FROM publication_record WHERE asin = ? AND marketplace = ? ORDER BY published_at DESC LIMIT 20`,
    [key, market],
  )
  for (const row of publications) {
    const approved = parseJson(row.approved_json, null)
    const published = parseJson(row.published_json, null)
    /* 字段在不在 payload 里，用「有没有这个键」判断，不看值是不是空 —— payload 里的
       空值仍然是一次覆盖，而缺键才是「这次发布没有涉及它」。 */
    const inApproved = approved !== null && Object.prototype.hasOwnProperty.call(approved, field)
    const inPublished = published !== null && Object.prototype.hasOwnProperty.call(published, field)
    rows.push({
      kind: 'publication_record',
      ref: row.id,
      label: `发布记录 ${String(row.id).slice(0, 8)}（${row.kind}，${row.published_at}）`
        + (inPublished ? '含该字段' : '不含该字段'),
      inApproved,
      inPublished,
    })
  }

  const checkpoints = store.get(
    `SELECT COUNT(*) AS n FROM observation_checkpoint c
       JOIN publication_record p ON p.id = c.publication_id
      WHERE p.asin = ? AND p.marketplace = ?`,
    [key, market],
  )?.n ?? 0
  if (Number(checkpoints) > 0) {
    rows.push({
      kind: 'observation_checkpoint',
      ref: `${key}@${market}`,
      label: `${Number(checkpoints)} 个观测节点挂在它的发布记录下`,
    })
  }

  const keywords = store.get(
    'SELECT COUNT(*) AS n FROM asin_keyword WHERE asin = ? AND marketplace = ?', [key, market],
  )?.n ?? 0
  if (Number(keywords) > 0) {
    rows.push({
      kind: 'asin_keyword',
      ref: `${key}@${market}`,
      label: `${Number(keywords)} 条关键词排名事实按这个 ASIN 记`,
    })
  }
  return rows
}

/**
 * 一个字段的全部事实。
 *
 * `sources` 是所有来源行（含人工那一行），`original` 是**被人工值压在下面的那份
 * 读数**（采集/导入里最新的一条），`adopted` 是当前在 `asin` 列里生效的那一个。
 * 三者分开，是因为「人工修正不改原始值」这句话要靠它们能不能同时读出来证明。
 */
function fieldFact({ store, asinRow, key, market, field, sourceRows, previousSnapshot, currentSnapshot, previousDiff, conflict }) {
  const sources = sourceRows.map(row => ({
    sourceId: row.source_id,
    sourceType: row.source_type ?? null,
    value: parseJson(row.value, null),
    rawValue: row.raw_value ?? null,
    rawUnit: row.raw_unit ?? null,
    parserVersion: row.parser_version ?? null,
    qualityState: row.quality_state ?? null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    observedAt: row.observed_at ?? null,
    ingestedAt: row.ingested_at ?? null,
    updatedAt: row.updated_at ?? null,
    isManual: row.source_type === 'manual' || row.source_id === MANUAL_SOURCE_ID,
    matchesAdopted: sameFact(parseJson(row.value, null), asinRow[field] ?? null),
  }))

  const manual = sources.filter(source => source.isManual)
  const manualAt = manual
    .map(source => source.updatedAt ?? source.ingestedAt)
    .filter(value => typeof value === 'string' && value !== '')
    .sort()
    .pop() ?? null
  const manualLatest = manual
    .slice()
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0] ?? null
  /* 被覆盖的原始值 = 非人工来源里最新的那一条。人工值本身不算「原始值」，
     否则「修正前是什么」会显示成修正后的样子 —— 那一栏就白设了。 */
  const original = sources
    .filter(source => !source.isManual)
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0] ?? null

  const adoptedValue = asinRow === undefined || !Object.prototype.hasOwnProperty.call(asinRow, field)
    ? null
    : (asinRow[field] ?? null)
  /* 采用值的来源 = 与采用值相等的来源行里最近写入的一条。找不到匹配值时它是 null，
     而这就该是 null：一个「值来自哪」的猜测比一个 null 危险得多。 */
  const adoptedFrom = sources
    .filter(source => source.matchesAdopted)
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0] ?? null

  const observedAt = adoptedFrom?.observedAt ?? null
  const ingestedAt = adoptedFrom?.ingestedAt ?? manualLatest?.ingestedAt ?? null
  const freshnessDays = freshnessClassFor(field)
  const freshness = freshnessOf(observedAt, field)
  const age = ageInDays(observedAt)

  const previous = previousDiff === null
    ? null
    : (previousDiff.byField[field] ?? null)
  let diff = null
  if (previousSnapshot !== null && currentSnapshot !== null) {
    diff = {
      previousSnapshotId: previousSnapshot.id,
      previousAt: previousSnapshot.collected_at,
      currentSnapshotId: currentSnapshot.id,
      currentAt: currentSnapshot.collected_at,
      changed: previous !== null,
      /* 三个数字而不是一个布尔：新增、消失、改值在页面上是三句话。 */
      before: previous === null ? null : previous.before,
      after: previous === null ? null : previous.after,
      inPrevious: previousDiff.fields.has(field),
    }
  } else {
    diff = {
      previousSnapshotId: null,
      changed: false,
      reason: currentSnapshot === null
        ? '这个 ASIN 还没有任何采集快照 —— 不是「没有变化」'
        : '只有一份快照，没有可比的上一份',
    }
  }

  return {
    field,
    label: ASIN_FACT_LABELS[field] ?? field,
    adoptedValue,
    adoptedSourceId: adoptedFrom?.sourceId ?? null,
    adoptedSourceType: adoptedFrom?.sourceType ?? null,
    /* 人工那一行在，且采用值就是它 → 这个字段当前是人工值。 */
    manualConfirmed: manual.length > 0 && sameFact(adoptedValue, manualLatest?.value ?? null),
    hasManualSource: manual.length > 0,
    manualAt,
    manualValue: manualLatest?.value ?? null,
    manualSourceId: manualLatest?.sourceId ?? null,
    original: original === null ? null : {
      value: original.value,
      sourceId: original.sourceId,
      sourceType: original.sourceType,
      observedAt: original.observedAt,
      ingestedAt: original.ingestedAt,
      /* 原始值是否**仍然**与采用值相同：人工修正之后这里为 false，而那一行还在库里。 */
      unchanged: sameFact(original.value, adoptedValue),
    },
    sources,
    sourceCount: sources.length,
    observedAt,
    ingestedAt,
    ageDays: age === null ? null : Math.round(age * 10) / 10,
    freshness,
    freshnessDays,
    /* 「没有阈值」与「没有观测时间」都会得到 unknown，但它们是两件事，页面要分开说。 */
    freshnessReason: freshnessDays === null
      ? 'no-threshold'
      : (observedAt === null ? 'no-observation-time' : 'classified'),
    lineageState: lineageState({
      asinRow,
      sources: sourceRows,
      snapshot: currentSnapshot ?? undefined,
    }),
    conflict: conflict === null ? null : {
      id: conflict.id,
      status: conflict.status,
      adoptedValue: conflict.adopted_value ?? null,
      adoptedSourceId: conflict.adopted_source_id ?? null,
      openedAt: conflict.opened_at,
    },
    diff,
    downstream: downstreamFor(store, key, market, field),
  }
}

/**
 * 全部字段的事实 + 一份**带分母**的小结。
 *
 * 小结里的每个数字都带 `total`：`{value: 3, total: 10}`。只印一个 `30%` 的健康度是
 * 需求明令禁止的（§19.2 F05-07「必须显示分母和扣分项」），而 `3` 与 `3/10` 在
 * 页面上是两句不同的话。
 */
export function buildFieldFacts(store, { asin, marketplace } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const asinRow = store.get('SELECT * FROM asin WHERE asin = ? AND marketplace = ?', [key, market])
  if (asinRow === undefined) return null

  /* 三次读，给十个字段用：来源行一次读完再按字段分组，快照取最近两份（用来算
     「与上一快照差异」），冲突行一次读完。每个字段各查一遍是十倍的重复查询，
     而这条路是页面每次切换标签都会走的。 */
  const allSources = store.all(
    `SELECT * FROM asin_field_source WHERE asin = ? AND marketplace = ?
      ORDER BY field, observed_at DESC NULLS LAST, updated_at DESC`,
    [key, market],
  )
  const sourcesByField = new Map()
  for (const row of allSources) {
    if (!sourcesByField.has(row.field)) sourcesByField.set(row.field, [])
    sourcesByField.get(row.field).push(row)
  }

  const snapshots = store.all(
    `SELECT id, source_id, collected_at, payload_json FROM asin_snapshot
      WHERE asin = ? AND marketplace = ? ORDER BY collected_at DESC, id DESC LIMIT 2`,
    [key, market],
  )
  const currentSnapshot = snapshots[0] ?? null
  const previousSnapshot = snapshots[1] ?? null
  let previousDiff = null
  if (currentSnapshot !== null && previousSnapshot !== null) {
    const changes = diffPayloads(
      parseJson(previousSnapshot.payload_json, {}),
      parseJson(currentSnapshot.payload_json, {}),
    )
    previousDiff = {
      byField: Object.fromEntries(changes.map(change => [change.field, change])),
      fields: new Set(changes.map(change => change.field)),
    }
  }

  const conflictRows = store.all(
    'SELECT * FROM field_conflict WHERE asin = ? AND marketplace = ?', [key, market],
  )
  const conflictByField = new Map(conflictRows.map(row => [row.field, row]))

  const fields = ASIN_FACT_FIELDS.map(field => fieldFact({
    store,
    asinRow,
    key,
    market,
    field,
    sourceRows: sourcesByField.get(field) ?? [],
    previousSnapshot,
    currentSnapshot,
    previousDiff,
    conflict: conflictByField.get(field) ?? null,
  }))

  const withValue = fields.filter(entry => entry.adoptedValue !== null && entry.adoptedValue !== undefined
    && String(entry.adoptedValue).trim() !== '').length
  const summary = {
    total: fields.length,
    withValue,
    missing: fields.length - withValue,
    manualConfirmed: fields.filter(entry => entry.manualConfirmed).length,
    withAnySource: fields.filter(entry => entry.sourceCount > 0).length,
    fresh: fields.filter(entry => entry.freshness === 'fresh').length,
    stale: fields.filter(entry => entry.freshness === 'stale').length,
    freshnessUnknown: fields.filter(entry => entry.freshness === 'unknown').length,
    noThreshold: fields.filter(entry => entry.freshnessReason === 'no-threshold').length,
    noObservationTime: fields.filter(entry => entry.freshnessReason === 'no-observation-time').length,
    conflicting: fields.filter(entry => entry.conflict !== null && entry.conflict.status === 'open').length,
    neverCollected: fields.filter(entry => entry.lineageState === 'never_collected').length,
    notOnPage: fields.filter(entry => entry.lineageState === 'not_on_page').length,
    withoutDownstream: fields.filter(entry => entry.downstream.length === 0).length,
  }

  return {
    asin: key,
    marketplace: market,
    fields,
    summary,
    snapshots: {
      current: currentSnapshot === null ? null : {
        id: currentSnapshot.id, sourceId: currentSnapshot.source_id, collectedAt: currentSnapshot.collected_at,
      },
      previous: previousSnapshot === null ? null : {
        id: previousSnapshot.id, sourceId: previousSnapshot.source_id, collectedAt: previousSnapshot.collected_at,
      },
      /* 「只有一份快照」与「一份都没有」都不是「没有变化」。 */
      note: currentSnapshot === null
        ? '没有任何采集快照'
        : (previousSnapshot === null ? '只有一份快照，字段差异无从比较' : null),
    },
  }
}

/**
 * 概览（模块 05 F05-02 的第一个标签页）—— 一个 ASIN 的关键事实，**每个比例都带分母**。
 *
 * ## 为什么这里没有「健康分」
 *
 * 需求 §19.6 原话：「健康分不代替具体问题列表」，F05-07 又要求「必须显示分母和扣分项」。
 * 于是概览给出的每一个比例都是 `{value, total, percent, missing}` 四件套：
 * 一个 30% 与一个 3/10 在页面上是两句不同的话，而只印百分数的页面在第 11 个字段
 * 出现时会安静地把「3/10」变成「2.7/10」谁也看不出来。
 *
 * ## 「本批不做」的那些必须被点名
 *
 * 43 属性完整率、规则风险、优化前置条件是 F05-07 的内容，本子批不做。它们**不能**
 * 从概览里消失 —— 消失会被读成「这些都很健康」。所以它们出现在 `deferred` 里，
 * 每条带着它属于哪个功能点，页面画「本批未计入」而不是留白。
 *
 * ## 三个数字来自别处，这里不重算
 *
 * 字段完整率、13 节计数、变体完整性分别由 `fields.js` / `sections.js` / `variants.js`
 * 算好传进来。概览**不自己再数一遍** —— 一页上同一个数字有两个算法，就是两个数字。
 */

import { DATA_STATES } from '../states.js'

/** 发布记录/优化的表可能在某次迁移里换名字；缺表时读 0 而不是让整页 500。 */
function countSafe(store, sql, params) {
  try {
    return Number(store.get(sql, params)?.n ?? 0)
  } catch {
    return null
  }
}

export function buildOverview(store, {
  asin, marketplace, fields, sections, variants, archiveEvents = [], archived,
} = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const row = store.get('SELECT * FROM asin WHERE asin = ? AND marketplace = ?', [key, market])
  if (row === undefined) return null

  /* ★ 归档与否由调用方给（唯一判据是 `store/archive.js` 的 `isAsinArchived`），
     这里**不**再算一次 `row.archived_at !== null`。少给一个布尔值要当场炸，
     不能默认成 false —— 默认成 false 的症状是页面把一条已归档的记录说成「在架上」，
     而那正是 F05-08 最不该出错的这一句话。 */
  if (typeof archived !== 'boolean') {
    throw new Error('buildOverview 需要调用方给出 archived（判据在 store/archive.js 的 isAsinArchived）—— '
      + '不给就会把归档状态静默读成「没归档」')
  }

  const archivedAt = row.archived_at ?? null
  const lastArchiveEvent = archiveEvents.length === 0 ? null : archiveEvents[0]

  /* ── 三个比例，每个都带分子的名字与分母的来历 ─────────────────────────────── */

  const fieldValue = fields.summary.withValue
  const fieldTotal = fields.summary.total
  const sectionAttempted = sections.totals.attempted
  const sectionTotal = sections.totals.total

  const completeness = {
    fields: {
      id: 'core-fields',
      label: '核心 Listing 字段完整率',
      value: fieldValue,
      total: fieldTotal,
      percent: fieldTotal === 0 ? null : Math.round((fieldValue / fieldTotal) * 1000) / 10,
      /* 「扣分项」= 具体是哪几个字段没有值。只给数字的话，人还得自己去数。 */
      missing: fields.fields
        .filter(entry => entry.adoptedValue === null || entry.adoptedValue === undefined
          || String(entry.adoptedValue).trim() === '')
        .map(entry => entry.field),
      basis: `${fieldTotal} 个字段的清单来自 store/queries.js 的 ASIN_FIELDS（写白名单），不是这里自己编的`,
    },
    sections: {
      id: 'collection-sections',
      label: '13 节采集覆盖（采过的节）',
      value: sectionAttempted,
      total: sectionTotal,
      percent: sectionTotal === 0 ? null : Math.round((sectionAttempted / sectionTotal) * 1000) / 10,
      missing: sections.sections.filter(entry => entry.notCollected === true).map(entry => entry.section),
      /* 这个比例说的是「有没有人看过这一节」，不是「这一节采全了没有」——
         采全了的那一档在下面按五态给，别把两句话合成一个数。 */
      basis: '分母固定为 13 节；已采到的节里「采全了没有」看 summary 的五态计数',
    },
    variants: {
      id: 'variant-dimensions',
      label: '子体维度覆盖（分母是不同子体数）',
      value: variants.counts.childrenWithDimensions,
      total: variants.counts.children,
      percent: variants.counts.children === 0
        ? null
        : Math.round((variants.counts.childrenWithDimensions / variants.counts.children) * 1000) / 10,
      /* 去重：`variants.children` 是**边**，一个子体挂两个父体就是两条。缺维度清单按
         商品去重，否则同一个 ASIN 会在「缺」里被列两遍，而它只有一个子体。 */
      missing: [...new Set(
        variants.children.filter(child => child.hasDimensions !== true).map(child => child.asin),
      )],
      basis: '分母是这一族的**不同子体数**（不是关系条数 —— 一个子体挂两个父体是 2 条关系、1 个子体，'
        + '两种口径都印出来，各自的标签说清自己是哪个）；没有子体时百分比是 null（0/0 不是一个比率）',
    },
  }

  /* ADR-001 D9：类目 / 产品线是人工维护字段，不参与新鲜度分母。
     旧的 total/value/stale/unknown 保持原值（既有工具契约与 b05 测试按 10 条断言），
     页面用下面新增的 denominator / unknownExcludingManual 得到与 Listing 全字段页一致的口径（8）。
     这里是页面口径的唯一来源：页面不自己再数一遍。 */
  const manualFreshnessFields = ['category', 'product_line_id']
  const manualFields = Array.isArray(fields.fields)
    ? fields.fields.filter(entry => manualFreshnessFields.includes(entry.field))
    : []
  const manualUnknown = manualFields.filter(entry => entry.freshness === 'unknown').length
  const manualNoThreshold = manualFields.filter(entry => entry.freshnessReason === 'no-threshold').length
  const manualNoObservation = manualFields.filter(entry => entry.freshnessReason === 'no-observation-time').length
  const freshness = {
    value: fields.summary.fresh,
    stale: fields.summary.stale,
    unknown: fields.summary.freshnessUnknown,
    total: fields.summary.total,
    /* unknown 拆成两句话：没有阈值（这个字段没人定过多久算旧）与没有观测时间
       （有人记过这个值，但没记它什么时候是真的）。合成一个数字会让人去修错的东西。 */
    noThreshold: fields.summary.noThreshold,
    noObservationTime: fields.summary.noObservationTime,
    /* 页面口径：剔除人工维护字段后的分母与未知数（与 Listing 全字段页同一个算法）。 */
    denominator: Math.max(0, Number(fields.summary.total || 0) - manualFields.length),
    unknownExcludingManual: Math.max(0, Number(fields.summary.freshnessUnknown || 0) - manualUnknown),
    noThresholdExcludingManual: Math.max(0, Number(fields.summary.noThreshold || 0) - manualNoThreshold),
    noObservationTimeExcludingManual: Math.max(0, Number(fields.summary.noObservationTime || 0) - manualNoObservation),
    manualFields: manualFields.map(entry => ({ field: entry.field, label: entry.label })),
    basis: '阈值的唯一来源是 domain/data/freshness.js 的 7/30/90 天表；表里没有的字段是「无阈值」，不是「新鲜」；类目 / 产品线是人工维护字段，不参与新鲜度分母',
  }

  /* ── 关键事实 ────────────────────────────────────────────────────────────── */

  const identity = {
    asin: row.asin,
    marketplace: row.marketplace,
    title: row.title ?? null,
    brand: row.brand ?? null,
    price: row.price ?? null,
    currency: row.currency ?? null,
    bsr: row.bsr ?? null,
    category: row.category ?? null,
    rating: row.rating ?? null,
    reviews: row.reviews ?? null,
    imageUrl: row.image_url ?? null,
    productLineId: row.product_line_id ?? null,
    primarySourceId: row.primary_source_id ?? null,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  }

  const conflicts = store.all(
    'SELECT id, field, status, adopted_value, adopted_source_id, opened_at FROM field_conflict WHERE asin = ? AND marketplace = ? ORDER BY status, opened_at DESC',
    [key, market],
  ).map(entry => ({
    id: entry.id,
    field: entry.field,
    status: entry.status,
    adoptedValue: entry.adopted_value ?? null,
    adoptedSourceId: entry.adopted_source_id ?? null,
    openedAt: entry.opened_at,
  }))

  /* 来源清单：哪些来源说过这个 ASIN 的话，各说了几个字段。空数组 = 一行来源都没有
     （那是「只有主记录、没有溯源」），与「读不出来」不是一件事。 */
  const sourceRows = store.all(
    `SELECT source_id, COUNT(DISTINCT field) AS fields, MAX(COALESCE(observed_at, updated_at)) AS last_at
       FROM asin_field_source WHERE asin = ? AND marketplace = ?
      GROUP BY source_id ORDER BY source_id`,
    [key, market],
  ).map(entry => ({
    sourceId: entry.source_id,
    fieldCount: Number(entry.fields),
    lastAt: entry.last_at ?? null,
  }))

  return {
    asin: key,
    marketplace: market,
    identity,
    archive: {
      /* 这一个布尔**不是**在这里算的：它由 `buildAsinDetail` 从 `isAsinArchived` 读来
         再传进来，所以「现在是不是归档的」在全仓只有一个定义。 */
      archived,
      archivedAt,
      archiveReason: row.archive_reason ?? null,
      archivedBy: row.archived_by ?? null,
      eventCount: archiveEvents.length,
      lastEvent: lastArchiveEvent === null ? null : {
        action: lastArchiveEvent.action, at: lastArchiveEvent.at, reason: lastArchiveEvent.reason, by: lastArchiveEvent.by,
      },
      /* 「从来没有归档过」与「归档过又恢复了」在库里长得不一样（一个事件都没有 vs
         一对 archive/restore 行），页面必须能分开说。 */
      everArchived: archiveEvents.some(event => event.action === 'archive'),
    },
    completeness,
    freshness,
    sections: {
      summary: sections.summary,
      totals: sections.totals,
      /* 这次读有没有被 5000 行上限截断。必须有：上面那两个数在截断时都是
         **前缀上的**结论，而「采过 3/13」和「采过 3/13（只读到前 5000 行）」是两句
         不同的话。没有这一格时，截断与「真的只采过 3 节」印出来一模一样。 */
      coverage: sections.coverage ?? null,
    },
    variants: {
      role: variants.role,
      counts: variants.counts,
      problemCount: variants.problemCount,
      incompleteCount: variants.incompleteCount,
      parentLevelOptimizationAllowed: variants.parentLevelOptimizationAllowed,
    },
    fields: {
      summary: fields.summary,
      snapshots: fields.snapshots,
    },
    conflicts,
    openConflicts: conflicts.filter(entry => entry.status === 'open').length,
    counts: {
      keywords: countSafe(store, 'SELECT COUNT(*) AS n FROM asin_keyword WHERE asin = ? AND marketplace = ?', [key, market]),
      snapshots: countSafe(store, 'SELECT COUNT(*) AS n FROM asin_snapshot WHERE asin = ? AND marketplace = ?', [key, market]),
      optimizationRuns: countSafe(store, 'SELECT COUNT(*) AS n FROM optimization_run WHERE asin = ? AND marketplace = ?', [key, market]),
      publications: countSafe(store, 'SELECT COUNT(*) AS n FROM publication_record WHERE asin = ? AND marketplace = ?', [key, market]),
      listing: countSafe(store, 'SELECT COUNT(*) AS n FROM listing WHERE asin = ? AND marketplace = ?', [key, market]),
    },
    sources: sourceRows,
    /* 数据状态词表（`DATA_STATES`）在这里出现一次，好让「这个值是什么状态」与
       质量模块说同一套话 —— 页面不另写一份。 */
    dataStates: [...DATA_STATES],
    /* 本摘要**没有计入**的东西，点名而不是留白：它们属于 F05-07。理由写成今天仍然成立的
       那一条，不写「本批不做」—— 那是一种会过期的说法（前置条件在模块 13 交付之后就
       不再「没做」，只是模块 05 的摘要不读它）。 */
    deferred: [
      { id: 'attribute-coverage', label: '43 属性完整率', feature: 'F05-07', note: '属性矩阵归优化器的覆盖报告，模块 05 的摘要不读它' },
      { id: 'rule-risk', label: '规则风险数', feature: 'F05-07', note: '规则风险是工作空间级的政策口径，不是单 ASIN 摘要项' },
      { id: 'optimization-readiness', label: '优化前置是否满足', feature: 'F05-07', note: '前置条件由模块 13 的 amzn_optimize_precheck（九项门槛）判定，模块 05 的摘要不读它' },
    ],
  }
}

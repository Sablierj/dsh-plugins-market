/**
 * 「**什么引用了一条 ASIN**」—— 一份实现（B-05e / F05-08 的受限删除用）。
 *
 * ## 为什么候选集合从 schema 数出来，而不是手写一张表
 *
 * 手写一张表，漏掉一张就是一次**静默的错删**：删除会带走一行有引用的记录，
 * 而库里没有任何东西会抗议 —— 引用它的那张表只是少了一行，读起来像「本来就没有」。
 * 所以列这一类的候选集合**从库自己的 schema 数出来**（`sqlite_master` +
 * `PRAGMA table_info`），再由 `ASIN_REFERENCE_SOURCES` 显式分类；
 * `unclassifiedAsinCandidates()` 把「新表带了 asin 列但没人分类」报出来，
 * 于是**完整性可以被断言**，而不是靠人记得改一张表。
 *
 * ## 为什么显式这一段不能省
 *
 * 实测（`tests/probe-t5-refs.mjs`，空库）能数出 **20 张**带 asin 坐标的列，
 * 但库里还有**两种它找不到**的引用形态：
 *
 *   1. **JSON 列表**：`competitor_set.asins_json`（成员存成一列 JSON）、
 *      `collection_task.targets_json` / `collection_plan.targets_json`
 *      （`[{asin, marketplace, side}]`，见 `domain/collect/targets.js`）；
 *   2. **多态对象 id**：`dq_issue` 在 `object_type = 'asin'` 时 `object_id` 就是 ASIN。
 *
 * 两种都真的会**因为这条 ASIN 存在而存在**，都不带一个叫 asin 的列。所以：派生 ∪ 显式，
 * 且两边的完整性各断言一次（派生多出来的必须被分类；显式列出的表必须真的存在）。
 *
 * ## 保守的方向是**多报**，不是少报
 *
 * 有一些列的含义在库里是歧义的 —— `keyword_ownership_suggestion.suggested_asin`
 * 建议的 ASIN 完全可能是一个**还不在库里的外部 ASIN**。这里把它算成引用：
 * 对一个删除动作来说，**误挡的代价是一条能读懂的拒绝**（用户去把那条建议撤掉），
 * **误删的代价是一条不可恢复的记录**。两者不对称，所以选多报。
 */

import { isValidAsin } from '../collect/targets.js'

/** 五种分类。`reference` 挡删除，`own` 跟着删，其余三种留下不动。 */
export const ASIN_REFERENCE_KINDS = ['reference', 'own', 'record', 'audit', 'foreign']

/**
 * 列这一类的分类表。**每一条都必须带 `reason`**：这是给下一个人看的，
 * 让他知道「为什么这张表算引用」而不是猜。
 */
export const ASIN_REFERENCE_SOURCES = [
  /* ── 记录自身 ─────────────────────────────────────────────────────────── */
  { table: 'asin', column: 'asin', kind: 'record', reason: '这就是那条记录本身 —— 删除删的就是它' },

  /* ── 记录**自身**的状态（跟着删，不挡） ───────────────────────────────── */
  {
    table: 'asin_field_source',
    column: 'asin',
    kind: 'own',
    reason: '字段级溯源，但它由**写这条记录的那个写口自己**产生（`upsertAsin` 每写一个字段'
      + '就记一条来源）—— 它是这条记录的一部分，不是别人对它的引用。'
      + '★ 把它算成引用的后果实测过：一次 `amzn_asin_upsert` 之后的记录**必然**至少有一条，'
      + '于是受限删除永远删不掉任何东西（功能整个失效，而且失效得毫无提示）。'
      + '所以它跟着记录一起删：留着才是错的 —— 下一次导入同一坐标会撞上上一次的僵尸溯源行。',
  },

  /* ── 审计 ─────────────────────────────────────────────────────────────── */
  {
    table: 'asin_archive_event',
    column: 'asin',
    kind: 'audit',
    reason: '归档/恢复/删除的历史。**不挡删除**：否则一条 ASIN 只要被归档过一次就永远删不掉，'
      + '而「删除只用于导入错误」恰恰发生在归档之后。它没有指向 asin 的外键，所以行删了它还在 —— '
      + '这是删除之后唯一还能复盘的东西，所以它**也不跟着删**。',
  },

  /* ── 别人的 ASIN（外部对象，不是库内这条） ───────────────────────────── */
  { table: 'kw_competitor_fact', column: 'asin', kind: 'foreign', reason: '竞品反查里的**竞品** ASIN，与库内这条记录无关' },
  { table: 'kw_master', column: 'competitor_best_asin', kind: 'foreign', reason: '关键词的最佳**竞品** ASIN' },
  {
    table: 'kw_master_case_merge_archive',
    column: 'competitor_best_asin',
    kind: 'foreign',
    reason: 'v15 大小写折叠的一次性归档表，列的含义与 kw_master 同（竞品 ASIN）',
  },

  /* ── 库内引用（挡删除） ───────────────────────────────────────────────── */
  { table: 'asin_snapshot', column: 'asin', kind: 'reference', reason: '采集历史，每一次采集结果都在这里' },
  { table: 'asin_keyword', column: 'asin', kind: 'reference', reason: '这个 ASIN 的词覆盖与排名' },
  /* 排名观测历史：归档这个 ASIN 时，它的历史曲线仍然可读，算引用。 */
  { table: 'kw_rank_observation', column: 'asin', kind: 'reference', reason: '排名观测历史（周度监控的原始数据）' },
  /* 排名分析：明细的汇总行，同样是这个 ASIN 的引用。 */
  { table: 'kw_rank_analysis', column: 'asin', kind: 'reference', reason: '排名分析汇总（按词+ASIN 一行）' },
  /* 竞品关系：两列都指向 ASIN —— 父列是这个产品自己，竞品列是别人的商品。 */
  { table: 'asin_competitor', column: 'parent_asin', kind: 'reference', reason: '这个产品的竞品关系' },
  { table: 'asin_competitor', column: 'competitor_asin', kind: 'reference', reason: '被记录为竞品的 ASIN（别人家的商品）' },
  { table: 'asin_competitor', column: 'scope_asin', kind: 'reference', reason: '子级竞品声明指向的那个子 ASIN' },
  { table: 'product_profile', column: 'parent_asin', kind: 'reference', reason: '这个 ASIN 作为父体出现在产品归属里' },
  { table: 'product_profile', column: 'asin', kind: 'reference', reason: '这个 ASIN 的产品归属（店铺 + 品牌 + 父体）' },
  { table: 'listing', column: 'asin', kind: 'reference', reason: 'listing 版本与属性' },
  { table: 'optimization_run', column: 'asin', kind: 'reference', reason: '优化运行（草案挂在它下面的 run_id 上）' },
  { table: 'publication_record', column: 'asin', kind: 'reference', reason: '发布记录；观测检查点还要经它两跳才到这个 ASIN' },
  { table: 'field_conflict', column: 'asin', kind: 'reference', reason: '多源字段冲突' },
  { table: 'asin_ownership', column: 'asin', kind: 'reference', reason: 'ASIN 归属记录' },
  { table: 'asin_variant_relation', column: 'parent_asin', kind: 'reference', reason: '变体关系（这一条是父体）' },
  { table: 'asin_variant_relation', column: 'child_asin', kind: 'reference', reason: '变体关系（这一条是子体）' },
  { table: 'asin_variant_dimension', column: 'parent_asin', kind: 'reference', reason: '变体维度值（父体一侧）' },
  { table: 'asin_variant_dimension', column: 'child_asin', kind: 'reference', reason: '变体维度值（子体一侧）' },
  { table: 'collection_section_result', column: 'asin', kind: 'reference', reason: '采集中心逐节结果' },
  { table: 'reviews', column: 'parent_asin', kind: 'reference', reason: '评论家族池绑定的父体（铁律 2 双绑定之一）' },
  { table: 'reviews', column: 'child_asin', kind: 'reference', reason: '评论归属的子体（铁律 2 双绑定之二）' },
  { table: 'review_bindings', column: 'parent_asin', kind: 'reference', reason: '评论绑定行的父体一侧（家族键）' },
  { table: 'review_bindings', column: 'child_asin', kind: 'reference', reason: '评论绑定行的子体一侧（跨子体补绑定指针）' },
  /* T70 分析表（v64）：标注 run 挂家族与入口子体 —— 分析是「对这条 ASIN 家族的结论」，
     属引用（挡删除，与 reviews 同判：不是写记录时自动产生的，不能算 own）。 */
  { table: 'review_analysis_runs', column: 'parent_asin', kind: 'reference', reason: '评论分析 run 挂的家族父体（O-01 拍板产物）' },
  { table: 'review_analysis_runs', column: 'asin', kind: 'reference', reason: '分析 run 的入口子体（本轮从谁进来的）' },
  { table: 'review_annotations', column: 'parent_asin', kind: 'reference', reason: '标注行的家族键（标签可回溯到评论，评论可回溯到家族）' },
  { table: 'keyword_ownership', column: 'asin', kind: 'reference', reason: '关键词所有权：哪个 ASIN 拥有这个词' },
  { table: 'keyword_ownership_event', column: 'asin', kind: 'reference', reason: '关键词所有权的变更历史' },
  {
    table: 'keyword_ownership_suggestion',
    column: 'suggested_asin',
    kind: 'reference',
    reason: '建议采纳的 ASIN —— 可能是个还不在库里的外部 ASIN，本表**多报**（见文件头的取舍）',
  },
  { table: 'keyword_ownership_suggestion', column: 'adopted_asin', kind: 'reference', reason: '已被采纳的 ASIN' },
  { table: 'keyword_plan', column: 'asin', kind: 'reference', reason: '关键词方案按 ASIN 立' },
]

/**
 * JSON 列表这一类。`pick` 把一行的 JSON 解析成坐标列表；解析不出来就是空列表
 * （**不是**错误：「这一格坏了」与「这一格里没有你」在引用检查里方向一致 ——
 * 都不构成引用，而坏数据本身由数据质量面板负责）。
 */
export const ASIN_JSON_SOURCES = [
  {
    table: 'competitor_set',
    column: 'asins_json',
    kind: 'reference',
    reason: '竞品组的成员存成一列 JSON —— 不带 asin 列，所以探针找不到它',
    /* `{asin}` 字符串列表；成员在写入时已统一成大写、去重、排序（store/kw.js）。 */
    pick: parsed => (Array.isArray(parsed) ? parsed : []),
  },
  {
    table: 'collection_task',
    column: 'targets_json',
    kind: 'reference',
    reason: '采集任务的目标 `[{asin, marketplace, side}]` —— 提交过的任务就是一次引用的证据',
    pick: parsed => (Array.isArray(parsed) ? parsed : []),
  },
  {
    table: 'collection_plan',
    column: 'targets_json',
    kind: 'reference',
    reason: '采集计划的目标，形状与 collection_task 同',
    pick: parsed => (Array.isArray(parsed) ? parsed : []),
  },
]

/** 多态对象 id 这一类：`object_type` 说到哪张表，`object_id` 就是那条记录的主键。 */
export const ASIN_OBJECT_ID_SOURCES = [
  {
    table: 'dq_issue',
    column: 'object_id',
    typeColumn: 'object_type',
    typeValue: 'asin',
    kind: 'reference',
    reason: '数据质量问题挂在对象上；object_type = asin 时 object_id 就是 ASIN',
  },
]

/** 列名算不算「一个 asin 坐标」。与 `tests/probe-t5-refs.mjs` 同一条尺子。 */
function isAsinColumn(name) {
  return name === 'asin' || name.endsWith('_asin')
}

/** `^[A-Z0-9]{10}$`，大写归一 —— 形状这条规则借用 `domain/collect/targets.js` 那一份。 */
export function normalizeArchiveAsin(value) {
  const asin = String(value ?? '').trim().toUpperCase()
  if (!isValidAsin(asin)) throw new Error(`asin "${value}" is not a 10-character ASIN`)
  return asin
}

function normalizeArchiveMarketplace(value) {
  const marketplace = String(value ?? '').trim().toUpperCase()
  if (marketplace === '') throw new Error('marketplace is required')
  return marketplace
}

/** 库里所有「带 asin 坐标的列」，**从 schema 数出来**。 */
export function deriveAsinColumnCandidates(store) {
  const tables = store.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  const out = []
  for (const { name } of tables) {
    const columns = store.all(`PRAGMA table_info(${quoteIdent(name)})`)
    const names = columns.map(column => column.name)
    for (const column of names.filter(isAsinColumn)) {
      out.push({ table: name, column, hasMarketplace: names.includes('marketplace') })
    }
  }
  return out
}

/**
 * 派生出来但**没有人分类**的候选 —— 必须为空。
 *
 * 这是这一段里唯一一条「新加一张带 asin 列的表会让测试变红」的保证：
 * 新表要么被分类，要么检查会在下一次跑测试时停下来问「这张表算不算引用」。
 */
export function unclassifiedAsinCandidates(store) {
  const classified = new Set(ASIN_REFERENCE_SOURCES.map(source => `${source.table}.${source.column}`))
  return deriveAsinColumnCandidates(store)
    .filter(candidate => !classified.has(`${candidate.table}.${candidate.column}`))
    .map(candidate => ({ table: candidate.table, column: candidate.column }))
}

/**
 * 反方向：分类表里写了、库里却**没有这张表/这一列**的条目。
 *
 * 两个方向都要查。只看「派生 → 分类」的话，一次改名（表名或列名）会让那条分类
 * **静默地永远数出 0 条引用**，而检查照样通过 —— 那正是错删的来源。
 */
export function missingAsinReferenceSources(store) {
  const tables = store.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  const columnsByTable = new Map()
  for (const { name } of tables) {
    columnsByTable.set(name, store.all(`PRAGMA table_info(${quoteIdent(name)})`).map(column => column.name))
  }
  const missing = []
  for (const source of [...ASIN_REFERENCE_SOURCES, ...ASIN_JSON_SOURCES, ...ASIN_OBJECT_ID_SOURCES]) {
    const columns = columnsByTable.get(source.table)
    if (columns === undefined || !columns.includes(source.column)) {
      missing.push({ table: source.table, column: source.column })
    }
  }
  return missing
}

/**
 * 命中一条 ASIN 的竞品组。**唯一一处「这个 ASIN 属不属于这个竞品组」的实现** ——
 * 归档影响预览（`store/archive.js`）与引用检查都读它，所以两处不可能给出两个答案。
 *
 * 为什么先解析 JSON 再逐个精确比对、而不是拿 ASIN 去 LIKE 那一列的文本：
 * `B0AAAAAAAA` 是 `B0AAAAAAAAA` 的前缀，文本匹配会让两条**不同的** ASIN 变成同一个，
 * 而那在预览上表现为「多了一个竞品组」、在删除上表现为「一条本来能删的记录被挡住」——
 * 两种都看不出来是谁干的。
 */
export function competitorSetsContaining(store, { asin, marketplace } = {}) {
  const key = normalizeArchiveAsin(asin)
  const market = normalizeArchiveMarketplace(marketplace)
  return store
    .all('SELECT id, name, asins_json FROM competitor_set WHERE marketplace = ?', [market])
    .filter(row => parseJsonList(row.asins_json).some(entry => String(entry ?? '').trim().toUpperCase() === key))
    .map(row => ({ id: row.id, name: row.name }))
}

/**
 * 引用检查**本身有没有洞**。非空 ⇒ 不允许删除。
 *
 * ★ 这一条是本模块最重要的性质：一个覆盖不全的引用检查报出来的「0 处引用」
 * **不是一个可以据以删除的结论**，它只是「在检查覆盖到的范围内没有引用」。
 * 两句话在页面上长得一模一样，而后果相差一次不可恢复的删除。
 * 所以覆盖不全时 `deleteAsin` **拒绝执行**，而不是带着一个不知道有多大的洞去删。
 *
 * 两个方向都算洞：
 *   · 派生出来但没人分类（新加了一张带 asin 列的表）；
 *   · 分类表里有、库里没有（表名或列名被改了 —— 那条分类会**静默地永远数出 0 条**）。
 */
export function referenceCheckGaps(store) {
  const gaps = []
  for (const item of unclassifiedAsinCandidates(store)) {
    gaps.push(`${item.table}.${item.column} 带 asin 列但没有被分类（新增的表？分类表要跟上）`)
  }
  for (const item of missingAsinReferenceSources(store)) {
    gaps.push(`${item.table}.${item.column} 在分类表里但库里没有这一列（改名了？那它会永远数出 0 条）`)
  }
  return gaps
}

/**
 * 一条 ASIN 的引用报告 —— 删除**之前**要给人看的，也是写进删除事件行的那一份。
 *
 * `deletable` 与 `total` 是同一条规则的两种说法（`total === 0`），放在一起返回是
 * 为了让调用方**不可能**只读一个而忘了另一个：写进事件行的就是这一份。
 * `gaps` 非空时 `deletable` 为 `false` —— 见 `referenceCheckGaps`。
 */
export function asinReferenceReport(store, { asin, marketplace } = {}) {
  const key = normalizeArchiveAsin(asin)
  const market = normalizeArchiveMarketplace(marketplace)

  const candidates = new Map(
    deriveAsinColumnCandidates(store).map(candidate => [`${candidate.table}.${candidate.column}`, candidate]),
  )

  const references = []
  const record = []
  const cascade = []
  const audit = []
  const foreign = []

  for (const source of ASIN_REFERENCE_SOURCES) {
    const candidate = candidates.get(`${source.table}.${source.column}`)
    /* 分类表里没有对应列时不在这里报错：那是 `missingAsinReferenceSources` 的活，
       而它是一条**独立的**断言。这里数 0 并且不出现在报告里。 */
    if (candidate === undefined) continue
    const count = countColumnHits(store, source.table, source.column, key, market, candidate.hasMarketplace)
    if (count === 0) continue
    const row = { table: source.table, column: source.column, kind: source.kind, count, reason: source.reason }
    if (source.kind === 'reference') references.push(row)
    else if (source.kind === 'own') cascade.push(row)
    else if (source.kind === 'record') record.push(row)
    else if (source.kind === 'audit') audit.push(row)
    else foreign.push(row)
  }

  for (const source of ASIN_JSON_SOURCES) {
    const count = countJsonHits(store, source, key, market)
    if (count === 0) continue
    references.push({
      table: source.table, column: source.column, kind: source.kind, count, reason: source.reason,
    })
  }

  for (const source of ASIN_OBJECT_ID_SOURCES) {
    const count = countObjectIdHits(store, source, key)
    if (count === 0) continue
    references.push({
      table: source.table, column: source.column, kind: source.kind, count, reason: source.reason,
    })
  }

  const total = references.reduce((sum, row) => sum + row.count, 0)
  const gaps = referenceCheckGaps(store)
  return {
    asin: key,
    marketplace: market,
    total,
    /* 两件事都能让删除不可行：真有引用，或**检查覆盖不全**（那时 `total === 0`
       只说明「在覆盖到的范围内没有引用」，不足以据以删除）。合成一个布尔，
       调用方就不可能只看 `total` 而漏掉后者。 */
    deletable: total === 0 && gaps.length === 0,
    references,
    record,
    cascade,
    audit,
    foreign,
    gaps,
    unclassified: unclassifiedAsinCandidates(store),
  }
}

/**
 * 删一条记录时要**一起删掉**的「它自己的状态」表 —— 分类表里 `kind === 'own'` 的那些。
 *
 * 与 `references` 分开是必须的：这两组东西一条挡删除、一组跟着删，
 * 而它们的差别不在数据里，在这张分类表里。让 `deleteAsin` 从**同一张表**读它，
 * 就不会出现「分类说它该跟着删、删除代码忘了删」这种两份清单分叉的形态
 * （症状是库里留下僵尸溯源行，下一次导入同一坐标时撞上它）。
 */
export function asinCascadeTables() {
  return ASIN_REFERENCE_SOURCES
    .filter(source => source.kind === 'own')
    .map(source => ({ table: source.table, column: source.column }))
}

/** `UPPER(col) = ?`：库里的这几列原则上都是大写，但一次小写落库就会变成一次**错删**。 */
function countColumnHits(store, table, column, key, market, hasMarketplace) {
  const where = [`UPPER(${quoteIdent(column)}) = ?`]
  const params = [key]
  if (hasMarketplace) { where.push('marketplace = ?'); params.push(market) }
  return Number(store.get(
    `SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${where.join(' AND ')}`,
    params,
  )?.n ?? 0)
}

function countJsonHits(store, source, key, market) {
  const rows = store.all(`SELECT ${quoteIdent(source.column)} AS blob FROM ${quoteIdent(source.table)}`)
  let count = 0
  for (const row of rows) {
    const entries = source.pick(parseJsonValue(row.blob))
    const hit = entries.some(entry => {
      /* 两种形状都要认：`{asin, marketplace}` 的对象（collection_* 的目标）与
         裸的 ASIN 字符串（competitor_set 的成员）。 */
      if (typeof entry === 'string') return entry.trim().toUpperCase() === key
      if (entry === null || typeof entry !== 'object') return false
      if (String(entry.asin ?? '').trim().toUpperCase() !== key) return false
      const entryMarket = String(entry.marketplace ?? '').trim().toUpperCase()
      /* 目标自带 marketplace 时以**它自己**为准：一个计划可以列多个站点的目标，
         拿行上的 marketplace 去比会给出一条错误的「没有引用」。 */
      return entryMarket === '' || entryMarket === market
    })
    if (hit) count += 1
  }
  return count
}

function countObjectIdHits(store, source, key) {
  return Number(store.get(
    `SELECT COUNT(*) AS n FROM ${quoteIdent(source.table)} WHERE ${quoteIdent(source.typeColumn)} = ? AND UPPER(${quoteIdent(source.column)}) = ?`,
    [source.typeValue, key],
  )?.n ?? 0)
}

function parseJsonValue(value) {
  if (value === null || value === undefined || value === '') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function parseJsonList(value) {
  const parsed = parseJsonValue(value)
  return Array.isArray(parsed) ? parsed : []
}

/** 表名/列名进 SQL 文本时必须带引号：库里有 `collection_section_result` 这类名字，
    以及任何一天可能出现的保留字。**不是**为了防注入 —— 这里的名字全部来自
    `sqlite_master` 与上面那张写死的清单，没有一个字节来自用户输入。 */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

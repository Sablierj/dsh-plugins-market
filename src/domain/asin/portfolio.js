/**
 * ASIN 组合概览 —— 回答"我手上这批 ASIN 里，哪些该补、补什么"。
 *
 * ## 这一层是从哪学来的
 *
 * WSL 那套运营系统的 `AsinList.vue` 把 ASIN 管理做成了**运营看板**而不是数据表：
 * 顶部有统计，筛选里能直接选「五点数 ≥5 / ＜5」「有描述 / 无描述」「有 A+ / 无 A+」，
 * 健康等级 S/A/B/C 是一列。我们的强项在详情（9 个 tab、来源与新鲜度、变体矛盾），
 * 但列表页缺的正是"筛出该补的"这一层。
 *
 * 所以这里补两件事：**内容完整度分级**与**组合概览**。
 *
 * ## 为什么叫内容完整度，不叫健康度
 *
 * `amzn_asin_health` 已经是健康度：它要跑 43 属性覆盖、9 道前置门、时效与冲突，
 * 是个重查询，**不能对列表里每一行都跑**。这里只算**能一次查出来的东西**：
 * 有没有标题、几条五点、有没有描述、有没有 A+、填了多少属性。
 *
 * 两者不冲突，但也不能互相冒充：这里的分级**只说明内容齐不齐**，
 * 不说明数据是否可用、规则是否通过。
 */

/** 本地 JSON 解析：坏数据当作"没有"，不让一条脏 JSON 打断整个概览。 */
function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

/** 等级由高到低。C 最差（连标题都没有）。 */
export const CONTENT_GRADES = ['S', 'A', 'B', 'C']

export const GRADE_MEANING = {
  S: '标题 + 五点 + 描述 + A+ + 属性齐全',
  A: '标题 + 五点 + 描述齐全（缺 A+ 或属性少）',
  B: '有标题，但五点不足 3 条或缺描述',
  C: '没有标题 —— 这条 listing 基本还没有内容',
}

/** 属性填满到这个数才算 S 级。43 个属性里的一小半，是个保守门槛。 */
const S_ATTRIBUTES = 10

/**
 * 给一条 listing 的内容定级。
 *
 * 输入全部来自 `listing` 行；`null` 行（还没采集过文案）直接是 C ——
 * 「没采到」和「采到了但空着」在分级上都是 C，但在 `gaps` 里会分开说。
 */
export function contentGrade({ title = null, bullets = [], description = null, aPlus = null, attributes = {} } = {}) {
  const hasTitle = String(title ?? '').trim() !== ''
  const bulletCount = Array.isArray(bullets) ? bullets.filter(item => String(item ?? '').trim() !== '').length : 0
  const hasDescription = String(description ?? '').trim() !== ''
  const hasAplus = aPlus !== null && aPlus !== undefined && String(aPlus).trim() !== ''
  const attributeCount = attributes === null || typeof attributes !== 'object'
    ? 0
    : Object.values(attributes).filter(value => String(value ?? '').trim() !== '').length

  if (!hasTitle) return { grade: 'C', bulletCount, hasTitle, hasDescription, hasAplus, attributeCount }

  const complete = bulletCount >= 5 && hasDescription
  if (complete && hasAplus && attributeCount >= S_ATTRIBUTES) {
    return { grade: 'S', bulletCount, hasTitle, hasDescription, hasAplus, attributeCount }
  }
  if (complete) return { grade: 'A', bulletCount, hasTitle, hasDescription, hasAplus, attributeCount }
  if (bulletCount >= 3) return { grade: 'B', bulletCount, hasTitle, hasDescription, hasAplus, attributeCount }
  return { grade: 'C', bulletCount, hasTitle, hasDescription, hasAplus, attributeCount }
}

/** 从 listing 行（数据库拼写）转成 contentGrade 的输入。 */
export function listingContent(row) {
  if (row === null || row === undefined) {
    return { title: null, bullets: [], description: null, aPlus: null, attributes: {} }
  }
  const bullets = parseJson(row.bullets_json, [])
  const attributes = parseJson(row.attributes_json, {})
  return {
    title: row.title ?? null,
    bullets: Array.isArray(bullets) ? bullets : [],
    description: row.description ?? null,
    aPlus: row.a_plus ?? null,
    attributes: attributes !== null && typeof attributes === 'object' ? attributes : {},
  }
}

/**
 * 组合概览：一个站点（可选一条产品线）下，ASIN 的内容状况。
 *
 * 只读、一次查询。**不跑** 43 属性覆盖与九道门 —— 那是 `amzn_asin_health` 的事，
 * 每条 ASIN 单独算。这里给的是"先看哪一批"的入口，不是体检报告。
 */
export function asinPortfolio(store, { marketplace = null, productLineId = null } = {}) {
  const where = []
  const params = []
  if (marketplace !== null && marketplace !== '') {
    where.push('a.marketplace = ?')
    params.push(String(marketplace).toUpperCase())
  }
  if (productLineId !== null && productLineId !== '') {
    where.push('a.product_line_id = ?')
    params.push(String(productLineId))
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  /* 老库没有 `archived_at` 这一列（v-archive 之前）。缺列时不能整段查询报错 ——
     那会把整个 /api/state 打成 400，页面一片空白。所以先问一句再决定选不选它。 */
  const hasArchived = store.all('PRAGMA table_info(asin)').some(column => column.name === 'archived_at')

  const rows = store.all(
    `SELECT a.asin, a.marketplace, a.product_line_id, ${hasArchived ? 'a.archived_at' : 'NULL AS archived_at'},
            a.title AS asin_title,
            l.title, l.bullets_json, l.description, l.a_plus, l.attributes_json
       FROM asin a
       LEFT JOIN listing l ON l.asin = a.asin AND l.marketplace = a.marketplace
       ${whereSql}`,
    params,
  )

  const byGrade = { S: 0, A: 0, B: 0, C: 0 }
  const byProductLine = new Map()
  let archived = 0
  let noProductLine = 0
  let noListing = 0
  const missingTitle = []
  const missingBullets = []
  const missingDescription = []
  const missingAplus = []

  for (const row of rows) {
    if (row.archived_at !== null && row.archived_at !== undefined) archived += 1
    if (row.product_line_id === null || row.product_line_id === '') noProductLine += 1
    if (row.title === null || row.title === undefined) noListing += 1

    const graded = contentGrade({
      ...listingContent(row),
      /* 标题两个来源：listing 的正文标题，或 ASIN 主数据里的标题。
         只采到 ASIN 主数据、还没采到文案时，不该报"缺标题" —— 那是"文案还没采"，
         由 `noListing` 单独计数。 */
      title: row.title ?? row.asin_title ?? null,
    })
    byGrade[graded.grade] += 1

    const line = row.product_line_id ?? '（未归属产品线）'
    byProductLine.set(line, (byProductLine.get(line) ?? 0) + 1)

    if (!graded.hasTitle) missingTitle.push(row.asin)
    else if (graded.bulletCount < 5) missingBullets.push(row.asin)
    if (graded.hasTitle && !graded.hasDescription) missingDescription.push(row.asin)
    if (!graded.hasAplus) missingAplus.push(row.asin)
  }

  return {
    total: rows.length,
    archived,
    active: rows.length - archived,
    noProductLine,
    noListing,
    byGrade,
    byProductLine: [...byProductLine.entries()]
      .map(([productLine, count]) => ({ productLine, count }))
      .sort((a, b) => b.count - a.count),
    /* 该补什么：只列 ASIN，不在这里拼建议文案 —— 建议在页面上按等级给。 */
    gaps: {
      title: missingTitle.slice(0, 50),
      bullets: missingBullets.slice(0, 50),
      description: missingDescription.slice(0, 50),
      aplus: missingAplus.slice(0, 50),
    },
    gapCounts: {
      title: missingTitle.length,
      bullets: missingBullets.length,
      description: missingDescription.length,
      aplus: missingAplus.length,
    },
  }
}

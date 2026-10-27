/**
 * 变体关系视图与**重复/矛盾检测**（模块 05 F05-06 的第四个标签页）。
 *
 * ## 检测的是库里的状态，不是输入的合法性
 *
 * 「检测重复或矛盾变体」（模块设计 §3.6）这句话有一半在库层就完成了：自成的父体
 * （自己当自己的父体）是结构上的不可能，由 `asin_variant_relation` 的 CHECK 拒绝。
 * 但**重复**与**矛盾**是库里真实存在的状态，必须存得进去、报得出来 ——
 * 一条把矛盾挡在库外的约束，等于把检测实现成一个永远为空的列表。
 *
 * 所以本文件报四类问题，每一类都有明确的判据与**不能误报**的边界：
 *
 *   · `duplicate-coordinate` —— 同一个父体下两个**不同的子体**，维度值映射**完全相同
 *     且非空**。「非空」是这条判据的关键：两个都没有任何维度值的子体是「不知道」，
 *     不是「重复」。把不知道说成重复，会让人去删一条其实没问题的关系。
 *   · `dimension-contradiction` —— 同一个 (父体, 子体, 维度) 上，不同来源给出了
 *     **两个不同的值**。判据在值上，不在行数上：同一个值被两个来源各说一遍不是矛盾。
 *   · `parent-contradiction` —— 同一个子体同时挂在**两个不同父体**下（都还生效）。
 *     一个子体一次只属于一个变体族，所以这是矛盾；而它可能是「有人写错了」，
 *     也可能是「亚马逊上真的有两个父体」，两种都只能由人来判，所以报出来而不是自动选边。
 *   · `nested-variation` —— 同一个 ASIN 既是别人的子体、又是别人的父体。变体不嵌套。
 *
 * 另有**一类不是问题的问题**：`missing-dimensions` 与不一致的维度集合属于
 * 「**关系不完整**」，不是矛盾（§6 的页面状态里，关系不完整要「禁止父体级批量优化」）。
 * 分开报，因为处置动作不同：矛盾要人去纠正一条关系，不完整要去补采。
 *
 * ## 未生效的边不参与检测
 *
 * 被纠正过的边（status=corrected）是历史，不是现状：把它算进「两个父体」，
 * 就永远没有人能纠正完一条错误关系 —— 纠正之后检测还报着同一件事，
 * 而人很快就会学会无视这个列表。历史在 `corrected` 里单独给出来。
 * 「生效」的判据不在这里写第二遍：调 `store/variant-status.js` 的
 * `isActiveVariantRelation`，与列表页 SQL 用的是同一条（T-8 缺陷 2）。
 *
 * ## 事件历史是第四块，不并进上面任何一块
 *
 * `events` 回答的是「谁在什么时候改了什么」——`created` / `updated` / `corrected` /
 * `restored` 四条动作，每条带时间、操作人、理由与证据。它**不是**问题清单的一部分：
 * 一条 `corrected` 事件说的是「已经处理完了」，而 `problems` 里的每一条都是「还没处理」。
 * 合成一块，处理过的边会永远挂着一个红点。
 *
 * ## `counts` 里「子体」数的是商品，不是边
 *
 * `children`（那一列）是**边**：一个子体挂在两个父体下，它就出现两次。
 * 早期版本把 `counts.children` 也当成边数，于是概览印「子体 2/2 有维度」——
 * 而库里真实只有 **1 个子体**。这不是命名习惯问题，是**一个数字说大话**：
 * 而且 `problems` 已经单独报过那条 `parent-contradiction`，计数不该再替它虚增一次。
 *
 * 所以 `counts.children` / `counts.childrenWithDimensions` 数的是**不同的子体 ASIN**，
 * 关系条数由 `counts.familyRelations` 单独给（标签写「关系」）—— 两个问题、两个数。
 * 分母跟着一起变，否则会出现「2/1 有维度」这种自相矛盾的印法。
 * **矛盾检测本身没动**：`parent-contradiction` 照旧报，只是不再由计数重复说一遍。
 */

import { listVariantDimensions, listVariantEvents, listVariantRelations } from '../../store/variant.js'
/* 「生效的边」判据的唯一一份实现（T-8 缺陷 2）。这里不再自己比对 status 字段 ——
   那与列表页 SQL 里「只排除 corrected」的写法是一条规则的两种拼法，今天等价，
   加一个状态那天就会漂移。
   ⚠️ 两个判据都要写成「名字后跟左括号」的**调用**，不能只把函数名当回调递出去：
   本仓的接线检查（tests/wired-source.mjs 里那个 occurrences 计数）数的是有没有括号，
   没括号的引用会被当成孤儿（`VARIANT_EVENT_LIMIT` 上面那段注释记的就是同一条）。 */
import { isActiveVariantRelation, isCorrectedVariantRelation } from '../../store/variant-status.js'

/**
 * 一条边最多印这么多条事件。
 *
 * 事件表**只追加**：每一次 `upsertVariantRelation` / `correctVariantRelation` 都写一行，
 * 而一条边可以被人反复改（每次补维度、每次纠正、每次恢复）。这个上限是给人读的时间线，
 * 不是数据库的容量 —— 超出时丢的是**最早**的那几条，而且截断这件事会写进返回值
 * （`events.groups[].truncated`）由页面说出来。**静默丢历史**是本仓最不能接受的一类
 * 失败：留下的那几条看起来完全正常。
 *
 * 不导出：导出而没有「后跟左括号」的调用方，会被仓库的接线检查当成孤儿。
 */
const VARIANT_EVENT_LIMIT = 50

export const VARIANT_PROBLEM_KINDS = [
  'duplicate-coordinate',
  'dimension-contradiction',
  'parent-contradiction',
  'nested-variation',
]

/** 不是矛盾、但会拦住父体级批量优化的两件事。 */
export const VARIANT_INCOMPLETE_KINDS = ['missing-dimensions', 'inconsistent-dimensions']

function dimensionMapFor(rows) {
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.dimension)) map.set(row.dimension, [])
    map.get(row.dimension).push(row)
  }
  return map
}

/** 「这个子体在这一维度上的值」——同值多来源算一个值，不同值列表给出来。 */
function dimensionValues(rows) {
  return [...new Set(rows.map(row => row.value))]
}

/** 一个子体的维度坐标，用于找重复：按维度名排序，空映射返回空串（不参与重复判定）。 */
function coordinateKey(map) {
  const parts = [...map.entries()]
    .map(([dimension, rows]) => `${dimension}=${dimensionValues(rows).join('|')}`)
    .sort()
  return parts.length === 0 ? '' : parts.join('&')
}

/**
 * 四类矛盾 + 两类不完整的**唯一一份判据**（F05-06 的两半共用它）。
 *
 * ## 为什么要从 `buildVariantView` 里抽出来
 *
 * 这几个判据此前只长在 `buildVariantView` 里，于是唯一的消费者是「正在看某一个 ASIN
 * 的页面 / 工具」。F05-06 的另一半 —— **把变体矛盾落进 `dq_issue`**（数据质量扫描）——
 * 要的是**同一批**判据、**另一个范围**。在扫描里再写一遍 SQL 或再写一遍 JS，就是本仓
 * 反复付代价的那件事：一条规则两份实现，两处今天给出同一个答案，改一处那天给出两个。
 * 所以判据只有这一份，两侧都调它 —— 把它改坏，页面/工具侧与落库侧的断言必须同时变红。
 *
 * ## 两个范围
 *
 *   · `asin` 非空 —— **页面视角**：只看这个 ASIN 的那一族（它是子体时带上它的全部父体，
 *     否则从子体看过去只有一个父体、看不到兄弟）。`parent-contradiction` 也只报与它
 *     相关的 —— 本文件头那句「整个站点的矛盾列表属于『数据质量』视图，这个标签页回答的
 *     是『我正看着的这一族有什么问题』」里的另一个视图，就是下面的站点视角。
 *   · `asin === null` —— **站点视角**（质量扫描）：每个父体一族，四类矛盾与两类不完整
 *     全部报出来。族是按**父体**切的，因为「维度集合不一致」这类判据问的是
 *     「这一族里的子体带几种坐标」。
 *
 * ## 两件本函数**不**做的事
 *
 *   · **不看 `status`**：`active` 是调用方已经筛好的生效边（见文件头「未生效的边不参与
 *     检测」）。判据只有一处，页面与扫描都从那一处来，这里没有第二个拼法。
 *   · **不碰库**：输入是已经读出来的行。读多少由调用方定（页面读一族、扫描读一站），
 *     这也正是同一批判据能被喂两个范围的原因。
 *
 * `dimensions` 收数组**或**一个 thunk：页面在一族都没有时不该多发一次查询，而扫描总是
 * 要读整站的维度值，两种调用方式都自然。
 *
 * 返回的 `incomplete[]` 每一项都带 `familyParents`（这一条判据是**哪个族**的）——
 * 扫描据此把「族」映射成一个 `dq_issue` 的坐标；页面不用它，但两个范围对同一件事
 * 必须给出同一种形状，否则投影那一侧要自己再猜一遍。
 */
export function detectVariantProblems({ active: activeRows, dimensions: dimensionSource = [], asin = null } = {}) {
  const active = Array.isArray(activeRows) ? activeRows : []
  const rows = typeof dimensionSource === 'function'
    ? (dimensionSource() ?? [])
    : (Array.isArray(dimensionSource) ? dimensionSource : [])
  const key = asin === null || asin === undefined || String(asin).trim() === ''
    ? null
    : String(asin).trim().toUpperCase()

  const dimensionsByChild = new Map()
  for (const row of rows) {
    const id = `${row.parentAsin}|${row.childAsin}`
    if (!dimensionsByChild.has(id)) dimensionsByChild.set(id, [])
    dimensionsByChild.get(id).push(row)
  }

  /** 一个子体 → 它的维度（每个维度带上全部来源值）。 */
  const describeChild = (relation) => {
    const list = dimensionsByChild.get(`${relation.parentAsin}|${relation.childAsin}`) ?? []
    const map = dimensionMapFor(list)
    const entries = [...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([dimension, values]) => ({
      dimension,
      values: dimensionValues(values),
      contradicted: dimensionValues(values).length > 1,
      sources: values.map(row => ({
        sourceId: row.sourceId, value: row.value, observedAt: row.observedAt, ingestedAt: row.ingestedAt,
      })),
    }))
    return {
      asin: relation.childAsin,
      relationId: relation.id,
      parentAsin: relation.parentAsin,
      sourceId: relation.sourceId,
      evidence: relation.evidence,
      dimensions: entries,
      dimensionKeys: entries.map(entry => entry.dimension),
      hasDimensions: entries.length > 0,
    }
  }

  /* 「边」与「子体」是两个问题，两个数：一个子体挂两个父体就是两条边、一个子体。
     判据（见文件头）：`children` 数**边**，`distinctChildren` 数**不同的子体 ASIN**。 */
  const distinctByAsin = (list) => {
    const byChildAsin = new Map()
    for (const child of list) {
      if (!byChildAsin.has(child.asin)) byChildAsin.set(child.asin, [])
      byChildAsin.get(child.asin).push(child)
    }
    return [...byChildAsin.entries()].map(([childAsin, relations]) => ({
      asin: childAsin,
      relationCount: relations.length,
      /* 同一子体在不同父体下的维度是分开存的，所以「有维度」= 它**任一条边**上采到过维度。
         只取第一条会让一条边的缺失冒充整个子体的缺失。 */
      hasDimensions: relations.some(relation => relation.hasDimensions === true),
    })).sort((left, right) => left.asin.localeCompare(right.asin))
  }

  /** 一批子体**边**带着几种维度组合（空数组 = 一种都没有）。一个表达式，两处范围用它。 */
  const dimensionShapesOf = (list) => [...new Set(list
    .filter(child => child.hasDimensions)
    .map(child => child.dimensionKeys.slice().sort().join('|')))]

  const asParent = key === null ? [] : active.filter(relation => relation.parentAsin === key)
  const asChild = key === null ? [] : active.filter(relation => relation.childAsin === key)

  /* 这一批边属于哪些「族」。页面视角 = 一个族（子体视角可能跨多个父体，顺序与
     `buildVariantView` 一直以来的返回值一致）；站点视角 = 每个父体一族、按父体排序
     （扫描的输出必须与遍历顺序无关）。 */
  const familyParents = key === null
    ? [...new Set(active.map(relation => relation.parentAsin))].sort()
    : [...new Set([
      ...asChild.map(relation => relation.parentAsin),
      ...(asParent.length > 0 ? [key] : []),
    ])]
  const familyRelations = familyParents.length === 0
    ? []
    : active.filter(relation => familyParents.includes(relation.parentAsin))

  const children = familyRelations.map(relation => describeChild(relation))
    .sort((left, right) => left.asin.localeCompare(right.asin))
  const distinctChildren = distinctByAsin(children)

  /* ── 检测 ───────────────────────────────────────────────────────────────── */

  const problems = []

  /* 子体挂两个父体：在这一批边的范围内找，不只是这一族 —— 矛盾的另一半可能在别的族里。 */
  const parentsByChild = new Map()
  for (const relation of active) {
    if (!parentsByChild.has(relation.childAsin)) parentsByChild.set(relation.childAsin, [])
    parentsByChild.get(relation.childAsin).push(relation.parentAsin)
  }
  for (const [childAsin, list] of parentsByChild.entries()) {
    const unique = [...new Set(list)]
    if (unique.length < 2) continue
    /* 页面视角只报与本 ASIN 相关的那些（见上面「两个范围」）；站点视角全报 ——
       整个站点的矛盾列表就是质量扫描要的那个「数据质量视图」。 */
    if (key !== null && childAsin !== key
      && !familyParents.includes(list[0])
      && !familyParents.some(parent => unique.includes(parent))) continue
    problems.push({
      kind: 'parent-contradiction',
      childAsin,
      parents: unique,
      message: `子体 ${childAsin} 同时挂在 ${unique.length} 个父体下：${unique.join('、')} —— 一个子体一次只属于一个变体族，需要人判定哪一个是对的`,
    })
  }

  /* 维度值矛盾：同一个 (父体, 子体, 维度) 上不同来源给出不同值。 */
  for (const child of children) {
    for (const entry of child.dimensions) {
      if (entry.contradicted !== true) continue
      const byValue = new Map()
      for (const source of entry.sources) {
        if (!byValue.has(source.value)) byValue.set(source.value, [])
        byValue.get(source.value).push(source.sourceId)
      }
      problems.push({
        kind: 'dimension-contradiction',
        childAsin: child.asin,
        parentAsin: child.parentAsin,
        dimension: entry.dimension,
        values: [...byValue.entries()].map(([value, sources]) => ({ value, sources })),
        message: `子体 ${child.asin} 的 ${entry.dimension} 有两个值：`
          + [...byValue.entries()].map(([value, sources]) => `${value}（${sources.join('/')}）`).join(' 与 ')
          + ' —— 来源之间不一致，需要人判定',
      })
    }
  }

  /* 重复坐标：同一个父体下两个不同子体的维度映射完全相同且非空。 */
  const byParent = new Map()
  for (const child of children) {
    if (!byParent.has(child.parentAsin)) byParent.set(child.parentAsin, [])
    byParent.get(child.parentAsin).push(child)
  }
  for (const [parentAsin, list] of byParent.entries()) {
    const groups = new Map()
    for (const child of list) {
      const coordinate = coordinateKey(dimensionMapFor(
        (dimensionsByChild.get(`${parentAsin}|${child.asin}`) ?? []),
      ))
      /* 空坐标（一个维度值都没有）不进分组：那是「不知道」，不是「重复」。 */
      if (coordinate === '') continue
      if (!groups.has(coordinate)) groups.set(coordinate, [])
      groups.get(coordinate).push(child.asin)
    }
    for (const [coordinate, asins] of groups.entries()) {
      if (asins.length < 2) continue
      problems.push({
        kind: 'duplicate-coordinate',
        parentAsin,
        asins: [...asins].sort(),
        coordinate,
        message: `父体 ${parentAsin} 下 ${asins.length} 个子体的变体坐标完全相同（${coordinate}）：${[...asins].sort().join('、')} —— 要么是同一次采集把同一件商品写了两遍，要么是重复刊登`,
      })
    }
  }

  /* 嵌套：同一个 ASIN 既是子体又是父体。 */
  if (key === null) {
    const parentAsins = new Set(active.map(relation => relation.parentAsin))
    const childAsins = new Set(active.map(relation => relation.childAsin))
    for (const asin of [...childAsins].filter(value => parentAsins.has(value)).sort()) {
      const itsParents = active.filter(relation => relation.childAsin === asin).map(relation => relation.parentAsin)
      const itsChildren = active.filter(relation => relation.parentAsin === asin).map(relation => relation.childAsin)
      problems.push({
        kind: 'nested-variation',
        asin,
        message: `${asin} 既是 ${itsParents.join('、')} 的子体，又是 ${itsChildren.join('、')} 的父体 —— 变体不嵌套，需要人纠正其中一条`,
      })
    }
  } else if (asParent.length > 0 && asChild.length > 0) {
    problems.push({
      kind: 'nested-variation',
      asin: key,
      message: `${key} 既是 ${asChild.map(relation => relation.parentAsin).join('、')} 的子体，又是 ${asParent.map(relation => relation.childAsin).join('、')} 的父体 —— 变体不嵌套，需要人纠正其中一条`,
    })
  }

  /* ── 完整性（不是矛盾）：**按族**算 ────────────────────────────────────────
   *
   * 「这一族里有几个子体一个维度值都没有」「这一族的子体带几种维度组合」问的都是
   * **一族**，所以站点视角必须逐族算，不能把整站的子体合成一问 —— 合成一问之后
   * 「哪一族不完整」就没有答案了，而下游（父体级批量优化的那道禁令）要的正是那个答案。
   * 页面视角本来就只有一个族，直接用上面算好的那一份，不重算。 */
  const families = key === null
    ? familyParents.map((parentAsin) => {
      const relations = active.filter(relation => relation.parentAsin === parentAsin)
      const familyChildren = relations.map(relation => describeChild(relation))
        .sort((left, right) => left.asin.localeCompare(right.asin))
      return { familyParents: [parentAsin], children: familyChildren, distinctChildren: distinctByAsin(familyChildren) }
    })
    : [{ familyParents, children, distinctChildren }]

  const incomplete = []
  let uniform = true
  for (const [index, family] of families.entries()) {
    /* `uniform` 说的是**这一批边**的维度组合是否一致（页面 counts 读的就是它）。
       站点视角下它是第一个族的值，扫描不读它 —— 扫描读的是下面那条按族算的判据。 */
    if (index === 0) uniform = dimensionShapesOf(family.children).length <= 1

    /* 缺维度的是**子体**，所以按去重后的子体数报 —— 否则「2 个子体一个维度值都没有」
       会把同一个 ASIN 报两遍，而面板的头部同时印着「不同子体 1」。一句话里两个数打架。 */
    const childrenWithoutDimensions = family.distinctChildren.filter(child => child.hasDimensions !== true)
    if (childrenWithoutDimensions.length > 0) {
      incomplete.push({
        kind: 'missing-dimensions',
        familyParents: family.familyParents,
        asins: childrenWithoutDimensions.map(child => child.asin),
        message: `${childrenWithoutDimensions.length} 个子体一个维度值都没有：`
          + `${childrenWithoutDimensions.map(child => child.asin).join('、')} —— 这不等于重复，只是还没采到维度`,
      })
    }
    const distinctKeySets = dimensionShapesOf(family.children)
    /* 判据说的是「同一族的**子体**带着几种维度组合」，所以门槛也按子体数：一个子体
       （哪怕挂在两个父体下、两条边各记了一套维度）不该被说成「几种组合不一致」。 */
    if (family.distinctChildren.length > 1 && distinctKeySets.length > 1) {
      incomplete.push({
        kind: 'inconsistent-dimensions',
        familyParents: family.familyParents,
        shapes: distinctKeySets,
        message: `同一族的子体带着 ${distinctKeySets.length} 种维度组合（${distinctKeySets.map(shape => shape.replace(/\|/g, '+')).join(' / ')}）`
          + ' —— 维度集合不一致时，父体级的批量优化会拿错坐标',
      })
    }
  }

  return { asParent, asChild, familyParents, familyRelations, children, distinctChildren, problems, incomplete, uniform }
}

export function buildVariantView(store, { asin, marketplace } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()

  const all = listVariantRelations(store, { marketplace: market })
  const active = all.filter(relation => isActiveVariantRelation(relation))
  const corrected = all.filter(relation => isCorrectedVariantRelation(relation) && (relation.parentAsin === key || relation.childAsin === key))

  const asParent = active.filter(relation => relation.parentAsin === key)
  const asChild = active.filter(relation => relation.childAsin === key)

  const parents = [...new Set(asChild.map(relation => relation.parentAsin))]
    .map(parentAsin => ({
      asin: parentAsin,
      relationId: asChild.find(relation => relation.parentAsin === parentAsin)?.id ?? null,
      /* 一个子体挂在两个父体下 = 矛盾。这里只标记，不选边。 */
      disputed: asChild.length > 1,
    }))

  /* 判据只有一份实现（见 `detectVariantProblems` 上面那一段）：页面/工具读的是
     「这个 ASIN 的族」，数据质量扫描读的是「整个站点」—— 同一个函数，两个范围。
     维度值按需读：一族都没有时不多发一次查询（判据那边只有在真的要用时才调这个 thunk）。 */
  const detected = detectVariantProblems({
    active,
    dimensions: () => listVariantDimensions(store, { marketplace: market }),
    asin: key,
  })
  const { familyParents, familyRelations, children, distinctChildren, problems, incomplete, uniform } = detected

  /* `families` / `children` / `distinctChildren` / `uniform` 都出自上面那一次调用 ——
     它们是「这个 ASIN 的族」这一份读数的形状，判据不在这里写第二遍。 */

  /* ── 事件历史（F05-06 的追溯面）────────────────────────────────────────────
   *
   * 关系行说的是**现在**，事件行说的是**怎么变成现在这样的**。两者分开印，因为处置
   * 动作正好相反：一条 `corrected` 事件说的是「这条边已经被纠正过了」，把它并进
   * `problems` 会让每一条处理完的边看起来都还是一个待办。
   *
   * 读的是这个 ASIN 两侧的边：同族的生效边 + 与它有关的被纠正边（历史也属于它）。
   *
   * 三种状态必须分开说，不许合并 —— 这是本仓「没测到 ≠ 没有」的同一条纪律：
   *   · `error` 非空   —— 这一次**没读出来**（表/查询失败）；
   *   · 有关系、0 条事件 —— 那条边不是走 store 的写入口建的（每次 upsert 都会追加一条）；
   *   · 没有关系        —— 没有事件可言，`note` 说这句话。
   * 把第一种印成第二种，等于把「没读到」说成「没人改过」。 */
  const eventRelationById = new Map()
  for (const relation of [...familyRelations, ...corrected]) {
    if (!eventRelationById.has(relation.id)) eventRelationById.set(relation.id, relation)
  }
  const eventRelations = [...eventRelationById.values()]
    .sort((left, right) => `${left.parentAsin}|${left.childAsin}`.localeCompare(`${right.parentAsin}|${right.childAsin}`))

  let eventReadError = null
  const eventGroups = []
  for (const relation of eventRelations) {
    let rows = []
    try {
      rows = listVariantEvents(store, relation.id)
    } catch (error) {
      eventReadError = String(error?.message ?? error)
      break
    }
    /* store 的读法是**最新在后**（一条时间线），所以超出上限时砍掉的是开头那几条。 */
    const truncated = rows.length > VARIANT_EVENT_LIMIT
    eventGroups.push({
      relationId: relation.id,
      parentAsin: relation.parentAsin,
      childAsin: relation.childAsin,
      status: relation.status,
      /* 这条边一共有多少条事件（不是这一页印了几条）—— 两个数分开，截断时它们不等。 */
      count: rows.length,
      truncated,
      events: truncated ? rows.slice(-VARIANT_EVENT_LIMIT) : rows,
    })
  }

  const events = {
    groups: eventGroups,
    relationCount: eventRelations.length,
    total: eventGroups.reduce((sum, group) => sum + group.count, 0),
    limit: VARIANT_EVENT_LIMIT,
    /* null = 读到了（哪怕读到 0 条）。非空 = 这一次没读出来，与「0 条事件」不是一件事。 */
    error: eventReadError,
    note: eventReadError !== null
      ? null
      : (eventRelations.length === 0
        ? '这个 ASIN 没有任何变体关系，所以也没有变体事件可读 —— 这是「没有关系」，不是「读不出来」。'
        : (eventGroups.every(group => group.count === 0)
          ? '这些边一条事件都没有 —— 它们不是通过 store 的写入口建的（upsertVariantRelation 每次都会追加一条事件）。'
          : null)),
  }

  return {
    asin: key,
    marketplace: market,
    role: asParent.length > 0 && asChild.length > 0
      ? 'both'
      : (asParent.length > 0 ? 'parent' : (asChild.length > 0 ? 'child' : 'unrelated')),
    parents,
    children,
    familyParents,
    dimensionKeys: [...new Set(children.flatMap(child => child.dimensionKeys))].sort(),
    corrected: corrected.map(relation => ({
      relationId: relation.id,
      parentAsin: relation.parentAsin,
      childAsin: relation.childAsin,
      correctedAt: relation.correctedAt,
      correctionReason: relation.correctionReason,
    })),
    problems,
    problemCount: problems.length,
    incomplete,
    incompleteCount: incomplete.length,
    /* 事件历史单独一块：它不是问题清单的一部分（见上面那段注释）。 */
    events,
    /* §6 的「变体关系不完整 → 禁止父体级批量优化」：这个布尔就是那道禁令的依据，
       判据只有「有没有子体缺维度 / 维度集合是否一致」两条，不掺别的。 */
    parentLevelOptimizationAllowed: distinctChildren.length > 0 && incomplete.length === 0 && problems.length === 0,
    /* 每个键的**单位**写在它旁边，因为这里正是「子体」与「关系」最容易互相冒充的地方：
       `children` / `childrenWithDimensions` 数的是**不同的子体 ASIN**，
       `familyRelations` 数的是**边**。一个子体挂两个父体 → 前者 1、后者 2。 */
    counts: {
      activeRelations: active.filter(relation => relation.parentAsin === key || relation.childAsin === key).length,
      familyRelations: familyRelations.length,
      correctedRelations: corrected.length,
      children: distinctChildren.length,
      childrenWithDimensions: distinctChildren.filter(child => child.hasDimensions).length,
      parents: parents.length,
      uniform,
    },
    /* 「没有关系」是一个有内容的答案，不是空态：页面据此写「这个 ASIN 还没有任何变体关系」。 */
    note: familyRelations.length === 0
      ? '这个 ASIN 在这个站点还没有任何变体关系（既不是父体也不是子体）。'
      : null,
  }
}

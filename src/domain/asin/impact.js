/**
 * FR-M2-05 ② —— **改之前先说清会影响到什么**（影响面）。
 *
 * 这一块的判据只有一条：**没有影响也要说「没有」**。
 * 空白会被读成「没查」，「0」会被读成「没有」—— 两者在这一格里的区别是：
 * 前者让人不敢改，后者让人放心改。所以每一项都是**真的数出来的计数**，
 * 全零时额外给出 `none: true` 和一句完整的话（见 `note`），而不是留空。
 *
 * ## 它不做什么
 *
 * - **不预测**改完之后长什么样（那要跑一遍写入才知道，而写入是危险的那一步）；
 * - **不判断**该不该改（那是人的事）。它只回答「这一改会牵动哪些行」。
 *
 * ## 为什么按字段分，而不是给一张通用的表
 *
 * 「自有/竞品归属」住在 `asin_ownership`（决策表，撤销用 `retracted_at`），
 * 「产品线归属」住在 `asin.product_line_id`（列）+ `product_profile` 的第二份。
 * 两者的牵连面根本不是同一批表：前者牵动关键词所有权的「是不是我们的」判定，
 * 后者牵动档案回退与字段冲突。写成一个通用查询只会得到一个谁都不准的答案。
 */

import { getAsin } from '../../store/queries.js'

/** 改动会牵动的表，按字段各说各的。 */
const IMPACT_FIELDS = ['ownership', 'product_line']

const labelOfSide = side => (side === 'self' ? '自有' : (side === 'competitor' ? '竞品' : String(side ?? '—')))

function countOf(store, sql, params) {
  const row = store.get(sql, params)
  return row === undefined || row === null ? 0 : Number(row.n ?? 0)
}

/**
 * @param {object} input
 * @param {object} input.store
 * @param {string} input.asin
 * @param {string} input.marketplace
 * @param {string} input.field  `ownership` | `product_line`
 * @param {string|null} [input.value]  打算改成什么（用于「改成同一个值」的提示；可空）
 */
export function asinFieldImpact({ store, asin, marketplace, field, value = null } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? 'US').trim().toUpperCase() || 'US'
  const target = String(field ?? '').trim()
  if (key === '') {
    return { ok: false, code: 'ASIN_REQUIRED', error: 'asin 必填 —— 影响面是按一个 ASIN 算的' }
  }
  if (!IMPACT_FIELDS.includes(target)) {
    return {
      ok: false,
      code: 'FIELD_NOT_INLINE_EDITABLE',
      error: `字段 ${target} 不支持行内改；可改字段：${IMPACT_FIELDS.join(', ')}`,
      editable: IMPACT_FIELDS,
    }
  }
  const found = getAsin(store, key, market)
  if (found === undefined) {
    return { ok: false, code: 'ASIN_NOT_FOUND', error: `${key} (${market}) 不在库内` }
  }

  const items = []
  const runningRuns = countOf(
    store,
    "SELECT COUNT(*) AS n FROM optimization_run WHERE asin = ? AND marketplace = ? AND status = 'running'",
    [key, market],
  )

  if (target === 'ownership') {
    const edges = store.all(
      `SELECT object_id, source FROM asin_ownership
        WHERE asin = ? AND marketplace = ? AND object_type = 'side' AND retracted_at IS NULL
        ORDER BY object_id`,
      [key, market],
    )
    items.push({
      key: 'liveSideEdges',
      label: '这条 ASIN 现有的归属边',
      count: edges.length,
      detail: edges.length === 0
        ? '一条都没有：现在这一格是「—」（没有记过），不是「自有」'
        : edges.map(edge => `${labelOfSide(edge.object_id)}（${edge.source}）`).join('、')
          + '。写入新的归属会把它们标成撤销（**不删行**，历史都留着）',
    })
    /* 「是不是我们的」这件事被关键词所有权读着（store/keyword-ownership.js 的判定链）。
       改一次归属，这些词的主人判定会跟着变 —— 这一项就是那次变动的规模。 */
    items.push({
      key: 'keywordClaims',
      label: '挂着这条 ASIN 的关键词认领',
      count: countOf(store, "SELECT COUNT(*) AS n FROM keyword_ownership WHERE asin = ? AND marketplace = ? AND status = 'claimed'", [key, market]),
      detail: '归属变了，这些词的「是不是我们的」判定跟着变（词本身不删）',
    })
  } else {
    const profile = store.get(
      'SELECT product_line_id FROM product_profile WHERE asin = ? AND marketplace = ?',
      [key, market],
    )
    const adopted = found.row.product_line_id ?? null
    items.push({
      key: 'profileProductLine',
      label: '产品档案里的第二份归属',
      count: profile === undefined || profile === null ? 0 : (profile.product_line_id === null || profile.product_line_id === undefined ? 0 : 1),
      detail: profile === undefined || profile === null
        ? '这条 ASIN 没有产品档案行'
        : `档案里是 ${String(profile.product_line_id ?? '—')}；读取端用 COALESCE(asin.product_line_id, product_profile.product_line_id) 回退，`
          + `所以档案里那份只在 asin 这一列为空时才生效（现在是 ${String(adopted ?? '空')}）`,
    })
    items.push({
      key: 'openConflicts',
      label: '这一格上还没裁决的冲突',
      count: countOf(
        store,
        "SELECT COUNT(*) AS n FROM field_conflict WHERE asin = ? AND marketplace = ? AND field = 'product_line_id' AND status = 'open'",
        [key, market],
      ),
      detail: '改这一格就是对这些冲突的一次裁决（改完之后它们会落成 resolved）',
    })
  }

  items.push({
    key: 'runningOptimizations',
    label: '正在跑 / 已经跑过的优化轮次',
    count: runningRuns,
    detail: runningRuns === 0
      ? '没有正在跑的轮次（历史轮次不受这一格影响：它们冻的是当时的值）'
      : '有轮次正在跑：改这一格会让它在观测期里多出一个混淆因素',
  })

  const total = items.reduce((sum, item) => sum + item.count, 0)
  const same = value !== null && value !== undefined && target === 'product_line'
    && String(value) === String(found.row.product_line_id ?? '')
  return {
    ok: true,
    asin: key,
    marketplace: market,
    field: target,
    current: target === 'product_line'
      ? (found.row.product_line_id ?? null)
      : null,
    items,
    total,
    /* **这一条是本节的全部意义**：全零时给一句完整的话，而不是空白。 */
    none: total === 0,
    note: total === 0
      ? '没有任何影响：这一格没有被任何别的行引用（没有归属边、没有挂靠的认领、没有在跑的轮次、也没有未裁决的冲突），改动只动这一行。'
      : null,
    sameValue: same,
  }
}

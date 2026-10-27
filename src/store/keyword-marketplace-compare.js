/**
 * US / CA 的**排名对比视图**（模块 08，FR-M6-19）。
 *
 * ## 这个文件存在是为了守两条口径，而不是为了画一张表
 *
 * 1. **缺一侧就是「未测量」，不是 0。** 排名是 1 起的整数：`organic_rank = 0` 不存在，
 *    但一个把「没有数据」写成 0 的实现会让页面显示「CA 排第 0」——而 0 比 1 小，
 *    读者会把它读成「排第一」。这是竞品页已经写死过一次的口径，这里照抄：
 *    缺失是 `null`，渲染层印「未测量」。
 * 2. **两侧测量期不一致就不判读。** §20.3 那句「不用不同周期的两侧直接对比」在
 *    `domain/keywords/competitor.js` 里已经有一份实现（`buildEvidenceView`）。这个文件
 *    **只 import 它，不改它一个字节** —— 竞品页的口径是竞品页的。为了覆盖「任意一侧自己
 *    就跨了多个观测日」这个对称的情形，判定按两个方向各问一次（见 `compareOne`），
 *    任一方向 `comparable === false` 就不给结论。文案由这里本地化成 US/CA：竞品那句
 *    「竞品侧」搬到双站对比里就是错的字，而**判定与措辞分开**正是为了让这件事不发生。
 *
 * ## 行集从哪来，为什么不从 kw_master
 *
 * 这一屏回答的是「这个词在两个站点各自测得怎样」，所以行集是**被观测过的词**
 * （`kw_rank_observation` 里有行的词），不是 30,778 条全库。全库未测量的词在总库表里
 * 已经是「未测量」，在这里再列一遍只会把「真的没人扫过」淹没在 3 万行里。
 * 由此得到一个诚实的边界：**两侧都没测量过的词不会出现在这张表里**，也就不会出现
 * 「none」这个筛选值 —— 它在构造上不存在，不是漏了。
 *
 * ## 一侧的数据怎么取（口径）
 *
 * - `measured`：这个词在这个站点有没有**任何**观测行。「扫了但没进前 N」仍是 measured。
 * - `period`：**唯一**观测日；有多个观测日时 `period = null`、`mixedPeriods = true` ——
 *   一个站点自己就不止一个日子时，不存在「这一侧的那一天」，硬挑最近一天会把
 *   「跨期」伪装成「同期」。
 * - `rank`：**那一天**里 `found = 1` 的行的最小 `organic_rank`（我们名下最好的名次），
 *   并把给出这个名次的 `asin` 带出来 —— 「凭什么说第 3 名」要能回到那一行。
 * - `scannedNotRanked`：measured 且那天没有 `found = 1` 的行 —— 这是「扫了，不在前
 *   `scan_depth` 名内」，与「没扫过」是两件事，页面必须分开说。
 */

import { keywordKey } from '../domain/keywords/key.js'
import { buildEvidenceView } from '../domain/keywords/competitor.js'

/** 对比两侧的默认站点。PRD 的原话是 US/CA，左侧默认 US，可由调用方覆盖。 */
export const COMPARE_LEFT_DEFAULT = 'US'
export const COMPARE_RIGHT_DEFAULT = 'CA'

/** 筛选生效的取值。`none` 故意不在闭集里 —— 见文件头：两侧都没测过的词不成行。 */
export const COMPARE_STATES = ['all', 'both', 'left', 'right']

function marketOf(value, fallback) {
  const text = String(value ?? '').trim().toUpperCase()
  return text === '' ? fallback : text
}

/**
 * 行集：有观测的词，按 `state` 过滤，分页。
 *
 * 一条 SQL 出当前页的词、一条出总数，两处用**同一段** WHERE/HAVING（字符串只拼一次），
 * 否则「这一页 20 条 / 一共 3 条」这种对不上的数字迟早出现。
 */
function selectKeywords(store, { left, right, q, state, limit, offset }) {
  const where = ['marketplace IN (?, ?)']
  const params = [left, right]
  if (q !== null && q !== undefined && String(q).trim() !== '') {
    where.push('keyword LIKE ?')
    /* 库里存的是折叠后的拼写（与 kw_master 同一把尺），LIKE 大小写敏感。 */
    params.push(`%${keywordKey(q)}%`)
  }
  const having = {
    all: '1 = 1',
    both: 'COUNT(DISTINCT marketplace) = 2',
    /* 「只有左侧」= 只观测到一个站点，且那个站点是左侧。 */
    left: 'COUNT(DISTINCT marketplace) = 1 AND MIN(marketplace) = ?',
    right: 'COUNT(DISTINCT marketplace) = 1 AND MIN(marketplace) = ?',
  }[state]
  const havingParams = state === 'left' ? [left] : state === 'right' ? [right] : []

  const base = `FROM kw_rank_observation WHERE ${where.join(' AND ')} GROUP BY keyword`
  const total = Number(store.get(
    `SELECT COUNT(*) AS n FROM (SELECT keyword ${base} HAVING ${having})`,
    [...params, ...havingParams],
  )?.n ?? 0)

  const rows = store.all(
    `SELECT keyword, COUNT(DISTINCT marketplace) AS sides ${base} HAVING ${having}
      ORDER BY keyword ASC LIMIT ? OFFSET ?`,
    [...params, ...havingParams, limit, offset],
  )
  return { keywords: rows.map(row => row.keyword), total }
}

/** 一侧的观测行 → 这一侧的口径对象。缺什么都不猜。 */
function sideOf(rows, marketplace) {
  const days = [...new Set(rows.map(row => row.observed_on))].sort().reverse()
  const day = days.length === 1 ? days[0] : null
  const onDay = day === null ? [] : rows.filter(row => row.observed_on === day)
  const ranked = onDay.filter(row => Number(row.found) === 1 && row.organic_rank !== null && row.organic_rank !== undefined)
  const best = ranked.length === 0
    ? null
    : ranked.reduce((champion, row) => (Number(row.organic_rank) <= Number(champion.organic_rank) ? row : champion))
  const measured = rows.length > 0
  return {
    marketplace,
    measured,
    period: day,
    /* 展示用，最多列 5 个日子：警告里要把它们点名，而 30 个日子没人读。 */
    periods: days.slice(0, 5),
    periodCount: days.length,
    mixedPeriods: days.length > 1,
    rank: best === null ? null : Number(best.organic_rank),
    asin: best === null ? null : best.asin,
    observedAt: best === null ? (onDay[0]?.observed_at ?? rows[0]?.observed_at ?? null) : best.observed_at,
    scanDepth: onDay.length === 0 ? null : Math.max(...onDay.map(row => Number(row.scan_depth) || 0)),
    /* measured 且那天一条 found=1 都没有 —— 「扫了，不在前 N 名」。 */
    scannedNotRanked: measured && onDay.length > 0 && ranked.length === 0,
    source: 'browser-local',
  }
}

/** 交给 `buildEvidenceView` 的形状。判定逻辑全在那边，这里只负责搬字段。 */
function evidenceOf(side) {
  return {
    period: side.period,
    periods: side.periods,
    mixedPeriods: side.mixedPeriods,
    measured: side.measured,
    source: side.measured ? side.source : null,
    sources: side.measured ? [side.source] : [],
    facts: { rank: side.rank, best_rank: side.rank, asin: side.asin, scan_depth: side.scanDepth },
  }
}

/**
 * 一个词的判读。
 *
 * 两个方向各问一次 `buildEvidenceView`：它只把「对方一侧跨了多个观测日」算成
 * `theirPeriodsMixed`，所以单问一次会漏掉「我方自己跨了多个日子」。问两次之后，
 * 任意一侧跨期都会让 `comparable` 为假 —— 这是复用既有判定，而不是另写一份。
 */
function compareOne(keyword, leftRows, rightRows, left, right) {
  const leftSide = sideOf(leftRows, left)
  const rightSide = sideOf(rightRows, right)

  const leftFirst = buildEvidenceView({ keyword, our: evidenceOf(leftSide), their: evidenceOf(rightSide) })
  const rightFirst = buildEvidenceView({ keyword, our: evidenceOf(rightSide), their: evidenceOf(leftSide) })

  /* leftFirst 把右侧当「their」，所以它报的 theirPeriodsMixed 是**右侧**自己跨期；
     rightFirst 反之。 */
  const rightMixed = leftFirst.theirPeriodsMixed === true
  const leftMixed = rightFirst.theirPeriodsMixed === true
  const periodMismatch = leftFirst.periodMismatch === true

  /* 比两个名次，前提是**两个名次都存在**。`buildEvidenceView` 只回答「两侧都有测量
     且周期可比」，它不知道「测了但不在前 N 名」这种一侧没有数字的情形 —— 那一侧
     `measured = true`、`rank = null`，只靠它会让判读输出一个 `null` 排名。
     这一条是名次的性质，不是 §20.3 的周期规则，所以加在这里而不是改它。 */
  const leftRanked = leftSide.rank !== null
  const rightRanked = rightSide.rank !== null
  const bothRanked = leftRanked && rightRanked
  const comparable = bothRanked && leftFirst.comparable === true && rightFirst.comparable === true

  /* 文案本地化：判定与措辞分开，竞品页那句「竞品侧」在这里就是错的字。
     顺序即优先级：没测过 > 一侧自己跨期（那一侧根本没有「那一天」的名次）> 名次缺失
     （扫了但没进前 N）> 两侧周期不同。跨期必须排在「名次缺失」之前 —— 跨期的那一侧
     `rank` 也是 null，但原因不是「没进前 N」，先报「没进前 N」就是报错原因。 */
  const notRankedNote = (side, market) => `${market} 侧扫过但不在前 ${side.scanDepth === null ? 'N' : side.scanDepth} 名内`
    + '（未进前 N），没有名次可比 —— 这与「未测量」是两件事，但不判读。'
  const warning = !leftSide.measured
    ? `${left} 未测量，无法对比 —— 缺失显示为「未测量」，不是 0（0 会被读成「排第一」）。`
    : !rightSide.measured
      ? `${right} 未测量，无法对比 —— 缺失显示为「未测量」，不是 0（0 会被读成「排第一」）。`
      : leftMixed || rightMixed
        ? (leftMixed ? left : right) + ' 侧有 ' + (leftMixed ? leftSide : rightSide).periodCount + ' 个观测日（'
          + (leftMixed ? leftSide : rightSide).periods.join('、') + '），这一侧没有唯一的测量期 —— 按 §20.3 不判读。'
        : !leftRanked
          ? notRankedNote(leftSide, left)
          : !rightRanked
            ? notRankedNote(rightSide, right)
            : periodMismatch
              ? `两侧测量期不同（${left} ${leftSide.period} / ${right} ${rightSide.period}），按 §20.3 不用不同周期的两侧直接对比，本次不判读。`
              : null

  return {
    keyword,
    left: leftSide,
    right: rightSide,
    comparable,
    periodMismatch,
    leftMixed,
    rightMixed,
    bothRanked,
    /* 结论：对象或 null。null 不是「没有差距」，是「这条不判读」。 */
    verdict: comparable
      ? {
        [left]: leftSide.rank,
        [right]: rightSide.rank,
        left_rank: leftSide.rank,
        right_rank: rightSide.rank,
        left_period: leftSide.period,
        right_period: rightSide.period,
        /* 排名是「越小越好」，所以差值是右减左只作为**方向**提示，不是优劣分。 */
        delta: rightSide.rank === null || leftSide.rank === null ? null : rightSide.rank - leftSide.rank,
      }
      : null,
    warning: comparable ? null : warning,
  }
}

/**
 * 对比视图的一页。
 *
 * @returns {{ left: string, right: string, state: string, q: string|null,
 *             rows: Array, total: number, limit: number, offset: number,
 *             summary: { total: number, bothMeasured: number, leftOnly: number,
 *                        rightOnly: number, comparable: number, noVerdict: number,
 *                        leftMeasured: number, rightMeasured: number } }}
 */
export function compareMarketplaceRanks(store, {
  left = COMPARE_LEFT_DEFAULT,
  right = COMPARE_RIGHT_DEFAULT,
  q = null,
  state = 'all',
  limit = 50,
  offset = 0,
} = {}) {
  const leftMarket = marketOf(left, COMPARE_LEFT_DEFAULT)
  const rightMarket = marketOf(right, COMPARE_RIGHT_DEFAULT)
  if (leftMarket === rightMarket) {
    throw new Error(`comparison needs two different marketplaces (both "${leftMarket}")`)
  }
  const wanted = String(state ?? 'all').trim()
  if (!COMPARE_STATES.includes(wanted)) {
    throw new Error(`state "${state}" is not one of ${COMPARE_STATES.join(' / ')}`)
  }
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500)
  const skip = Math.min(Math.max(Number(offset) || 0, 0), 1_000_000)

  const selection = selectKeywords(store, {
    left: leftMarket, right: rightMarket, q, state: wanted, limit: cap, offset: skip,
  })

  /* 两侧各有多少行观测 —— 这是**全库**的，用来回答首屏那句「US 0 行 / CA 0 行」。
     没有它，空表只能写「没有数据」，读的人分不清「扫了但没找到」与「从来没扫过」。 */
  const observed = { [leftMarket]: { rows: 0, keywords: 0 }, [rightMarket]: { rows: 0, keywords: 0 } }
  for (const row of store.all(
    `SELECT marketplace, COUNT(*) AS rows, COUNT(DISTINCT keyword) AS keywords
       FROM kw_rank_observation WHERE marketplace IN (?, ?) GROUP BY marketplace`,
    [leftMarket, rightMarket],
  )) {
    observed[row.marketplace] = { rows: Number(row.rows ?? 0), keywords: Number(row.keywords ?? 0) }
  }

  const observationRows = selection.keywords.length === 0
    ? []
    : store.all(
      `SELECT keyword, marketplace, asin, observed_on, observed_at, organic_rank, found, scan_depth
         FROM kw_rank_observation
        WHERE marketplace IN (?, ?) AND keyword IN (${selection.keywords.map(() => '?').join(', ')})
        ORDER BY keyword ASC, observed_on DESC, observed_at DESC`,
      [leftMarket, rightMarket, ...selection.keywords],
    )

  const rows = selection.keywords.map((keyword) => {
    const forWord = observationRows.filter(row => row.keyword === keyword)
    return compareOne(
      keyword,
      forWord.filter(row => row.marketplace === leftMarket),
      forWord.filter(row => row.marketplace === rightMarket),
      leftMarket,
      rightMarket,
    )
  })

  /* 汇总是**这一页**的，不是全库的 —— 页面上写「本页」。分母只有 total 一个是全库的。 */
  const summary = {
    total: selection.total,
    bothMeasured: rows.filter(row => row.left.measured && row.right.measured).length,
    leftOnly: rows.filter(row => row.left.measured && !row.right.measured).length,
    rightOnly: rows.filter(row => !row.left.measured && row.right.measured).length,
    comparable: rows.filter(row => row.comparable).length,
    noVerdict: rows.filter(row => !row.comparable).length,
    leftMeasured: rows.filter(row => row.left.measured).length,
    rightMeasured: rows.filter(row => row.right.measured).length,
  }

  return {
    left: leftMarket,
    right: rightMarket,
    state: wanted,
    q: q === null || q === undefined || String(q).trim() === '' ? null : String(q),
    rows,
    total: selection.total,
    limit: cap,
    offset: skip,
    summary,
    /* 全库观测行数，按两侧站点。空表时页面据此写「US 0 行 / CA 0 行」，而不是一句
       「没有数据」——「从来没扫过」与「扫了没找到」是两件事。 */
    observed,
  }
}

/**
 * 模块 14 §8：观测指标，以及**每个指标的数据到底从哪来**。
 *
 * ## 为什么这张表必须先存在
 *
 * §8 要求「到达观测节点时先检查有没有新鲜数据；数据不足时输出补数清单（去模块 04
 * 补采排名、去模块 09 导入广告/SQP 报告，跳转时预填对象）」。一份**补数清单**如果
 * 指向一条不存在的通道，就比不给清单更糟 —— 它让人以为「照着做就能拿到数据」，而
 * 照着做完仍然什么都没有，于是这个功能被判定为坏了。
 *
 * 所以这里逐条声明每个指标的真实来源，并且把**没有来源**的那两个明说出来。三档：
 *
 *   `yes`     有表、有写入方，能查到数
 *   `partial` 查得到，但**口径与 §8 想说的不是一回事** —— 必须说清楚差在哪
 *   `no`      没有任何通道。补数清单里它是「没有这条路」，不是「去这里补」
 *
 * ## `partial` 是这张表最要紧的一档
 *
 * 「点击率、转化率」在 §8 里听起来像 listing 的表现，而这个仓里唯一能算出 CTR/CVR
 * 的地方是**广告报告**（`kw_ad_fact`）和 **ABA 品牌视图**（`kw_aba_fact`）。两者都
 * 只覆盖有广告投放/有品牌份额的那部分流量，**不是 listing 的整体点击率**。
 * 把它们当成整体 CTR 报出去，正是 §8 与 §10 都禁的那件事：「相关变化不自动归因于
 * Listing 修改」。所以它们是 `partial`，并且在结果里带着一句说明一起出现。
 *
 * ## 新鲜度的判据是「窗口内有没有」，不是「够不够新」
 *
 * §8 的原话是「该 ASIN 在**观测窗口内**是否有新鲜的排名/业务报告数据」。判据因此是
 * 时间戳落在 `[观测起点, 现在]` 区间内，而不是 `freshness.js` 的 7/30/90 天阈值 ——
 * 后者回答的是「这个值过期了吗」，窗口问的是「这次改动之后有没有人看过」。两者对
 * 同一个字段可以给出相反答案（一个 40 天前观测的搜索量对 90 天阈值是 fresh，对一次
 * 7 天窗口却什么也没说）。
 *
 * ## 过滤条件只有一份
 *
 * `windowFilter` 是「这个指标的窗口内数据」的**唯一**定义，`windowProbe`（判断有没有）
 * 与每个指标的 `read`（取值）都从它出发。两份各自拼 WHERE 的写法迟早会分叉，而分叉
 * 的后果是「卡片说有数据，点进去是空的」—— 这种不一致最容易被当成偶发。
 */

import { nowIso } from '../../store/db.js'

/** 三档可用性。见文件头。 */
export const METRIC_AVAILABILITY = ['yes', 'partial', 'no']

function num(value) {
  /* 2026-10-25（R-80 的根治）：`Number(null)` 是 **0**，而 `Number.isFinite(0)` 是 true ——
     所以这一行原来会把 SQL NULL 读成「值是 0」。R-80 在 organic-rank 上就是这个后果：
     基线期没有数据 → baseline = 0 → 印出「涨了 32 名」。
     现在显式把三种「没有值」挡在前面：null / undefined / 空串。
     （空串在这里也算没有值：导入表里的空单元格长成 ''，`Number('')` 同样是 0。）
     连带修掉的还有 bsr 那一条：`num(row?.bsr)` 在没取到行时原本也是 0。 */
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 比值，分母为 0 或缺失时是 `null` 而不是 0 —— 见 §7 的同一条理由。 */
function ratio(numerator, denominator) {
  const n = num(numerator)
  const d = num(denominator)
  if (n === null || d === null || d === 0) return null
  return n / d
}

/**
 * 一个指标在窗口内的行筛选条件。**唯一**的一份 —— 见文件头。
 *
 * 站点每一张表都要筛：`asin` 的主键是 `(asin, marketplace)`，漏掉站点会把同一个
 * ASIN 在别的站点的行算进来，于是一次「这个 ASIN 有数据」的判断实际看的是另一个
 * 国家的榜单。
 */
function windowFilter(metric, { asin = null, marketplace = null, windowStart, windowEnd }) {
  const where = []
  const params = []
  const asinScoped = metric.table === 'asin' || metric.table === 'asin_keyword'
  if (asinScoped && asin !== null && asin !== undefined && String(asin).trim() !== '') {
    where.push('asin = ?')
    params.push(String(asin).trim().toUpperCase())
  }
  where.push('marketplace = ?')
  params.push(String(marketplace ?? '').trim().toUpperCase())
  where.push(`${metric.timeColumn} >= ?`, `${metric.timeColumn} <= ?`)
  params.push(windowStart, windowEnd)
  return { clause: where.join(' AND '), params }
}

/**
 * §8 列出的九个指标，以及它们在这个仓里的真实来源。
 *
 * `timeColumn` 是判断「窗口内有没有数据」的那一列 —— 必须是真的观测/导入时间，
 * 不是业务周期（`period` 是「数据描述哪一段时间」，与「我们什么时候拿到的」是两件事，
 * 一份 6 月的数据 9 月才导入，落在 9 月的窗口里是合理的）。
 *
 * `read` 是取值函数，只在**已经确认窗口内有行**之后调用（调用方是 `snapshotMetrics`）。
 * 它与 `timeColumn` 共用 `windowFilter`，所以「说有数据」和「取到什么值」不会各说各话。
 *
 * ## `history`：这个指标能不能算出「变化」
 *
 *   `append-only`  每观测一次追加一行（asin_keyword、kw_ad_fact）。基线窗口里有历史，
 *                  所以 `snapshotMetrics` 能真的算出差值。
 *   `current-only` 只保存**当前值**，每个键一行（asin）。基线窗口里读不到过去 ——
 *                  除了「当前这一行恰好是那时更新的」这一种巧合。
 *
 * 这一项是必需的，不是注解：`bsr` 与 `rating-reviews` 的 `change` **永远**是 `null`，
 * 而一个总是 null 的字段如果不说为什么，读的人会以为「变化算不出来是数据的问题」，
 * 于是去补数据 —— 补完还是 null。原因在结构里：历史值在
 * `asin_snapshot.payload_json`，本版没有解析它。
 */
export const OBSERVATION_METRICS = [
  {
    id: 'organic-rank',
    label: '自然排名',
    availability: 'yes',
    history: 'append-only',
    table: 'asin_keyword',
    timeColumn: 'collected_at',
    valueColumns: ['rank'],
    unit: '名次',
    note: '我们自己的关键词扫描测出来的名次（T1–T4 口径），按 (asin, marketplace) 取窗口内的行。',
    read(metric, store, ctx) {
      const { clause, params } = windowFilter(metric, ctx)
      const row = store.get(
        `SELECT MIN(rank) AS best, AVG(rank) AS avg_rank, COUNT(rank) AS ranked, COUNT(DISTINCT keyword) AS keywords
           FROM asin_keyword WHERE ${clause}`,
        params,
      )
      /* 2026-10-25（R-80）：窗口内一行都没有时 `MIN(rank)` 是 SQL NULL，而 `num(null)` 给的是 0 ——
         于是「这个窗口没有数据」变成了「这个窗口的值是 0」。后果实测：
           基线窗口（2026-09-01~09-15，那时还没有任何排名数据）→ baseline = 0
           当期 = 32 → change = 32 → 结论卡片印「自然排名=32 名次 · 样本 1 · 变化 32」
         而同一个 item 的 `sample` 是 0 —— **它自己和自己矛盾**。
         要命的是**显示层本来是对的**：tools/observe.js 里有一条 `item.change === null` 的分支
         会印「（无基线，不算变化）」，而读取层从不给它 null，那条分支永远走不到。
         所以这里保留 null，让上层那道判据真的生效。 */
      const best = row?.best
      const avgRank = row?.avg_rank
      return {
        value: best === null || best === undefined ? null : num(best),
        sample: Number(row?.ranked ?? 0),
        detail: {
          avgRank: avgRank === null || avgRank === undefined ? null : num(avgRank),
          keywords: Number(row?.keywords ?? 0),
        },
      }
    },
  },
  {
    id: 'ctr',
    label: '点击率',
    availability: 'partial',
    history: 'append-only',
    table: 'kw_ad_fact',
    timeColumn: 'imported_at',
    periodColumn: 'period',
    valueColumns: ['impressions', 'clicks'],
    unit: '%',
    note: '**只有广告侧**：由 kw_ad_fact 的 clicks/impressions 算出。这不是 listing 的整体点击率 —— '
      + '没有广告投放的自然流量不在里面。ABA 品牌视图另有一套 brand_click_pct，口径是品牌份额，也不是整体。',
    scope: 'keyword',
    read(metric, store, ctx) {
      const { clause, params } = windowFilter(metric, ctx)
      const row = store.get(
        `SELECT SUM(impressions) AS impressions, SUM(clicks) AS clicks, GROUP_CONCAT(DISTINCT period) AS periods
           FROM kw_ad_fact WHERE ${clause}`,
        params,
      )
      return {
        value: ratio(row?.clicks, row?.impressions),
        sample: Number(row?.impressions ?? 0),
        detail: {
          impressions: num(row?.impressions),
          clicks: num(row?.clicks),
          periods: row?.periods ?? null,
        },
      }
    },
  },
  {
    id: 'cvr',
    label: '转化率',
    availability: 'partial',
    history: 'append-only',
    table: 'kw_ad_fact',
    timeColumn: 'imported_at',
    periodColumn: 'period',
    valueColumns: ['clicks', 'orders'],
    unit: '%',
    note: '**只有广告侧**：由 kw_ad_fact 的 orders/clicks 算出。同上，不是 listing 的整体转化率。',
    scope: 'keyword',
    read(metric, store, ctx) {
      const { clause, params } = windowFilter(metric, ctx)
      const row = store.get(
        `SELECT SUM(clicks) AS clicks, SUM(orders) AS orders, GROUP_CONCAT(DISTINCT period) AS periods
           FROM kw_ad_fact WHERE ${clause}`,
        params,
      )
      return {
        value: ratio(row?.orders, row?.clicks),
        sample: Number(row?.clicks ?? 0),
        detail: { clicks: num(row?.clicks), orders: num(row?.orders), periods: row?.periods ?? null },
      }
    },
  },
  {
    id: 'sessions-orders',
    label: '会话与订单',
    availability: 'no',
    table: null,
    why: '没有任何通道。业务报告（Business Report）的表单格式没有对应的解析器，'
      + 'kw_import 的六类识别里也没有它 —— 而「会话数」这个字段在本仓的任何一张表里都不存在。'
      + '把它列进补数清单会让人去找一个不存在的导入入口。',
  },
  {
    id: 'ad-search-term',
    label: '广告搜索词表现',
    availability: 'yes',
    history: 'append-only',
    table: 'kw_ad_fact',
    timeColumn: 'imported_at',
    periodColumn: 'period',
    valueColumns: ['impressions', 'clicks', 'orders', 'spend', 'sales'],
    unit: '次/元',
    note: '搜索词报告（amzn_kw_import 的 ad_report 类）。含 impressions/clicks/orders/spend/sales，'
      + '以及 first_date/last_date 两个真实日期边界。',
    scope: 'keyword',
    read(metric, store, ctx) {
      const { clause, params } = windowFilter(metric, ctx)
      const row = store.get(
        `SELECT SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(orders) AS orders,
                SUM(spend) AS spend, SUM(sales) AS sales, COUNT(*) AS rows_n,
                GROUP_CONCAT(DISTINCT period) AS periods
           FROM kw_ad_fact WHERE ${clause}`,
        params,
      )
      return {
        value: {
          impressions: num(row?.impressions),
          clicks: num(row?.clicks),
          orders: num(row?.orders),
          spend: num(row?.spend),
          sales: num(row?.sales),
        },
        sample: Number(row?.rows_n ?? 0),
        detail: { periods: row?.periods ?? null },
      }
    },
  },
  {
    id: 'bsr',
    label: 'BSR',
    availability: 'yes',
    history: 'current-only',
    table: 'asin',
    timeColumn: 'updated_at',
    valueColumns: ['bsr'],
    unit: '名次',
    note: 'asin 表的当前值，时间戳是这一行的更新时间。历史值在 asin_snapshot.payload_json 里。',
    read(metric, store, ctx) {
      const { clause, params } = windowFilter(metric, ctx)
      const row = store.get(`SELECT bsr, updated_at FROM asin WHERE ${clause} LIMIT 1`, params)
      return { value: num(row?.bsr), sample: row ? 1 : 0, detail: { observedAt: row?.updated_at ?? null } }
    },
  },
  {
    id: 'rating-reviews',
    label: '评分/评论变化',
    availability: 'yes',
    history: 'current-only',
    table: 'asin',
    timeColumn: 'updated_at',
    valueColumns: ['rating', 'reviews'],
    unit: '分/条',
    note: 'asin 表的当前值（rating + reviews）。评论**内容**不在这里，只有数量和均分。',
    read(metric, store, ctx) {
      const { clause, params } = windowFilter(metric, ctx)
      const row = store.get(`SELECT rating, reviews, updated_at FROM asin WHERE ${clause} LIMIT 1`, params)
      return {
        value: row ? { rating: num(row.rating), reviews: num(row.reviews) } : null,
        sample: row ? 1 : 0,
        detail: { observedAt: row?.updated_at ?? null },
      }
    },
  },
  {
    id: 'keyword-coverage',
    label: '关键词索引与覆盖',
    availability: 'yes',
    history: 'append-only',
    table: 'asin_keyword',
    timeColumn: 'collected_at',
    valueColumns: ['keyword'],
    unit: '个词',
    note: '窗口内这个词在 (asin, marketplace) 下有排名记录的行数 —— 与 amzn_keyword_coverage 同一口径。',
    read(metric, store, ctx) {
      const { clause, params } = windowFilter(metric, ctx)
      /* 2026-10-25（R-81）：`COUNT(...)` 在**一行都没有**时也给 0 —— 于是「这个窗口没采过」
         和「采了但一个词都没有」变成了同一个数。实测后果：
           基线窗口（2026-09-01~09-15）无任何采集 → baseline = 0
           当期 8 个词 → change = 8 → 卡片印「关键词覆盖 8 · 变化 8」=「覆盖涨了 8 个词」
         所以这里同时数 `COUNT(*)`：一行都没有时值就是 null（没采过），不是 0（采了是 0 个）。
         口径仍然是「有排名记录的行数」—— 与 amzn_keyword_coverage 一致，只是不再把「没有」写成 0。 */
      const row = store.get(
        `SELECT COUNT(DISTINCT keyword) AS keywords, COUNT(*) AS rows_n FROM asin_keyword WHERE ${clause}`,
        params,
      )
      const rows = Number(row?.rows_n ?? 0)
      const keywords = Number(row?.keywords ?? 0)
      return {
        value: rows === 0 ? null : keywords,
        sample: rows,
        detail: {},
      }
    },
  },
  {
    id: 'returns-themes',
    label: '退货/差评主题',
    availability: 'no',
    table: null,
    /* 这条 why 原来写的是「退货报告与评论正文都没有采集器也没有导入器；本仓对评论只知道
       一个数量（asin.reviews）」。**后半句过期了**：评论正文在采集器的 `reviews` 节里
       （`collection_section_result.parsed_value_json` 的 `reviews_total` /
       `reviews_visible` / `review_summary` / `review_items`，逐条样本含评分 / 标题 / 正文，
       读它的模块是 domain/asin/reviews.js）。今天仍然没有通道的是**退货报告**；而「主题」
       之所以还算不出来，是因为本仓没有主题词表或分类器 —— 缺的是**分类口径**，不是数据通道。
       把「没有口径」写成「没有数据」，正是这个模块从头到尾在防的那件事。 */
    /* 2026-10-25（R-33）：这一条原来写着「**差评正文已经在库里** —— 采集器 reviews 节的
       review_items 逐条带评分、标题、正文」。**那是错的**，而且错得很有代表性。

       R-27（第 45 轮）实测：`collection_section_result` 里 10 个 reviews 分节，
       `parsed_value_json.review_items` **全是空数组**，只有 `reviews_total`
       （2545 / 1032 / 41 …）—— **一条正文都没有。**

       所以「主题」算不出来的原因**不止一个**，而是两个：
         ① 本仓没有主题词表与分类器（缺**口径**）；
         ② **连原料都没有** —— 评论正文从来没进来过（缺**数据**）。

       原来那句只说了 ①，还顺手把 ② 说成了「已经有」。**这正是本模块最该防的那种错**
       —— 上面那段注释自己写着「把『没有口径』写成『没有数据』，正是这个模块
       从头到尾在防的那件事」，而这一句做的是**反过来的同一件事**：
       把「没有数据」写成了「有数据」。

       两个缺口要分开写，因为补法完全不同：①要有人定主题词表；②要让外部采集器产出正文。 */
    why: '退货报告没有任何通道（没有退货报告采集器，也没有导入器）。'
      + '**差评正文同样不在库里**：R-27 实测 10 个 reviews 分节的 review_items 全是空数组，'
      + '外部采集器只给了 reviews_total（2545 / 1032 / 41 …）—— 本仓不采集评论正文。'
      + '所以「主题」这个聚合量有两个缺口，补法不同：'
      + '① 本仓没有主题词表、也没有分类器（缺**口径**）；'
      + '② 评论正文从来没进过库（缺**数据**，要外部采集器产出 review_items）。',
  },
]

export const METRIC_BY_ID = Object.fromEntries(OBSERVATION_METRICS.map(metric => [metric.id, metric]))

/**
 * 一条补数建议：去哪、做什么、带着什么对象。
 *
 * `prefill` 是 §8 说的「跳转时预填对象」—— 页面的跳转链接据此带上 asin 与站点，
 * 而不是让人到了模块 04 再自己重新选一遍。
 */
function workItem(metric, { asin, marketplace }) {
  const prefill = { asin, marketplace }
  if (metric.availability === 'no') {
    return {
      metric: metric.id,
      label: metric.label,
      available: false,
      why: metric.why,
      route: null,
      prefill: null,
    }
  }
  /* 排名/评分/BSR 走采集（模块 04），广告与 SQP 走导入（模块 09）。这个分叉不是
     猜的：它跟着上面的 table 走 —— asin/asin_keyword 是浏览器通道采到的，
     kw_ad_fact/kw_aba_fact 是文件导入进来的。 */
  const byCollection = metric.table === 'asin' || metric.table === 'asin_keyword'
  return {
    metric: metric.id,
    label: metric.label,
    available: true,
    why: `窗口内没有 ${metric.label} 的数据`,
    route: byCollection
      ? { module: 'collect', label: '去采集器补采', prefill }
      : { module: 'kw', label: '去关键词总库导入报告', prefill },
    prefill,
  }
}

/** 一张表在窗口内有没有行，有多少行，最晚一行是什么时候。 */
function windowProbe(store, metric, ctx) {
  const { clause, params } = windowFilter(metric, ctx)
  const row = store.get(
    `SELECT COUNT(*) AS n, MAX(${metric.timeColumn}) AS latest FROM ${metric.table} WHERE ${clause}`,
    params,
  )
  return { rows: Number(row?.n ?? 0), latestAt: row?.latest ?? null }
}

/**
 * §8 的前置检查：在窗口内，这个 ASIN 到底有没有数据可看。
 *
 * ## 「足够」的判据是「至少有一个指标有数据」，不是「全都有」
 *
 * 若要求全部九个指标都有数据，这张卡片**永远**是 `blocked` —— 因为其中两个在
 * 这个仓里根本没有通道（`availability: 'no'`）。一张永远红的卡片会被学会无视，
 * 而那正是 §8 想避免的「把空数据渲染成结论」的另一种形式。
 *
 * 所以：有数据 → 可以观测，没有数据的指标进 `missing` 如实列出；一个都没有 →
 * `blocked`，并且**不是**「无变化」。
 */
export function checkObservationData(store, {
  asin = null, marketplace = null, windowStart, windowEnd = nowIso(), metrics = null,
} = {}) {
  const wanted = metrics === null ? OBSERVATION_METRICS : metrics
  const present = []
  const missing = []

  for (const metric of wanted) {
    if (metric.availability === 'no') {
      missing.push(workItem(metric, { asin, marketplace }))
      continue
    }
    const probe = windowProbe(store, metric, { asin, marketplace, windowStart, windowEnd })
    if (probe.rows > 0) {
      present.push({
        metric: metric.id,
        label: metric.label,
        availability: metric.availability,
        rows: probe.rows,
        latestAt: probe.latestAt,
        note: metric.note,
        /* 站点级的表不能假装是这个 ASIN 的。§8 要的是「能不能判断」，而一个
           站点级数字对单条 ASIN 的判断力是有限的 —— 说清楚，别让它冒充。 */
        scopeCaveat: metric.table === 'asin' || metric.table === 'asin_keyword'
          ? null
          : `${metric.label} 来自站点级的 ${metric.table}，不是这一个 ASIN 的专属数据`,
      })
    } else {
      missing.push(workItem(metric, { asin, marketplace }))
    }
  }

  const fillable = missing.filter(item => item.available === true)
  const noPath = missing.filter(item => item.available === false)

  return {
    sufficient: present.length > 0,
    present,
    missing,
    fillable,
    noPath,
    windowStart,
    windowEnd,
    note: present.length > 0
      ? `窗口内有 ${present.length} 类数据可用，${missing.length} 类没有（其中 ${noPath.length} 类在本插件里没有通道）。`
      : '窗口内**一类数据都没有** —— 这不是「没有变化」，是还没有人看过。',
  }
}

/**
 * §8 的取值：把「有数据」的那些指标真的读出来，冻结进 `metrics_json`。
 *
 * ## 它不自己判断有没有数据
 *
 * 先调 `checkObservationData`，只为它说 `present` 的指标取值。这样「卡片说有数据」
 * 与「冻结下来的值是空的」不可能同时发生 —— 它们是同一个判断的两半。
 *
 * ## 变化只在声明了基线窗口时才算
 *
 * §8 要「变化」，而变化需要一段对照。对照来自 §7 的 `baseline_start` / `baseline_end`。
 * 没有声明基线时 `change` 是 `null` 并带一句说明，**不是 0** —— 把「没有对照」写成
 * 「没变」正是这个模块从头到尾在防的那件事。
 */
export function snapshotMetrics(store, {
  asin = null, marketplace = null, windowStart, windowEnd = nowIso(),
  baselineStart = null, baselineEnd = null,
} = {}) {
  const data = checkObservationData(store, { asin, marketplace, windowStart, windowEnd })
  const hasBaseline = baselineStart !== null && baselineStart !== undefined && String(baselineStart).trim() !== ''
    && baselineEnd !== null && baselineEnd !== undefined && String(baselineEnd).trim() !== ''

  const items = []
  for (const entry of data.present) {
    const metric = METRIC_BY_ID[entry.metric]
    const now = metric.read(metric, store, { asin, marketplace, windowStart, windowEnd })

    let baseline = null
    let change = null
    let changeNote = null
    if (!hasBaseline) {
      changeNote = '未声明基线窗口（§7 的 baseline_start / baseline_end），因此只有绝对值，没有变化。'
    } else if (metric.history === 'current-only') {
      /* 结构性的，不是数据的问题 —— 见 `history` 的注释。说清楚「补数据也没用」，
         否则读的人会去补一轮，然后发现还是 null。 */
      changeNote = `${metric.label}只保存当前值（${metric.table} 每个键一行），基线窗口里读不到历史，`
        + '所以算不出变化。历史值在 asin_snapshot.payload_json 里，本版没有解析它。'
    } else {
      const before = metric.read(metric, store, { asin, marketplace, windowStart: baselineStart, windowEnd: baselineEnd })
      baseline = before?.value ?? null
      if (typeof now?.value === 'number' && typeof baseline === 'number') {
        change = now.value - baseline
      } else {
        changeNote = '该指标是复合值，或基线窗口内没有数据，不做差值。'
      }
    }

    items.push({
      metric: metric.id,
      label: metric.label,
      availability: metric.availability,
      history: metric.history,
      unit: metric.unit,
      value: now?.value ?? null,
      sample: now?.sample ?? 0,
      detail: now?.detail ?? {},
      /* 「来源」与「周期」是 §8 明说要跟着数值一起出现的两项 —— 没有它们，一个
         排名数字无法判断该不该信。 */
      source: metric.table,
      sourceNote: metric.note,
      timeColumn: metric.timeColumn,
      scopeCaveat: entry.scopeCaveat,
      latestAt: entry.latestAt,
      baseline,
      change,
      changeNote,
    })
  }

  return {
    items,
    data,
    baseline: hasBaseline ? { start: String(baselineStart).trim(), end: String(baselineEnd).trim() } : null,
    note: items.length === 0
      ? '没有可取值的指标 —— 这张观测卡片只能给 insufficient。'
      : `取到 ${items.length} 类指标；${hasBaseline ? '变化相对声明的基线窗口计算。' : '没有基线窗口，只报绝对值。'}`,
  }
}

/**
 * P2-4 月度花费报告。
 *
 * ## 先把一件事说清：本仓没有「采集成本」这个概念
 *
 * 任务清单写的是「采集成本月报」。核实之后不能照做，因为**采集不花钱**：
 * 采集走的是本地浏览器（`sources/collection.js` 驱动本机 Chrome），
 * 不存在按次计费的 API 调用。本仓也**没有任何**记录采集花费的表或字段
 * （`CREATE TABLE` 里只有 `kw_ad_fact.spend` / `kw_master.spend`，那是**广告花费**，
 * 来自运营自己导入的广告报告）。
 *
 * 所以如果照清单做一个"采集成本"页面，它要么永远显示 0（假装成本为零），
 * 要么显示一个编出来的数 —— 两种都是这个仓反复拒绝的那类谎。
 *
 * ## 真正有数据、也确实值得按月看的是：**广告花费**
 *
 * `kw_ad_fact` 带 `period` / `first_date` / `last_date` / `spend` / `sales` / `orders`，
 * 按关键字 × 站点 × 期间存。所以这里做的是「月度广告花费报告」，
 * 而且**明确标出它统计的是什么**，不让读者以为这是采集成本。
 *
 * ## 三个口径陷阱
 *
 * ① **同一期间可能被多个文件重复计入**：主键是 `(keyword, marketplace, period, source_file)`，
 *    两个月的报告若覆盖同一期间，直接 SUM 会翻倍。所以按 `(keyword, marketplace, period)`
 *    取**最大值**而不是求和 —— 那是"这个关键词这一期最多花了多少"的保守估计，
 *    并在输出里标明用了几份文件。
 * ② **ROAS 的分母**：`spend` 为 0 时 ROAS 无意义（不是 0，也不是无穷）。
 * ③ **没有日期的行**：`first_date` / `last_date` 可能有空值，
 *    这些行进「无法归月」而不是被丢进某个月。
 *
 * ## 缺失从哪来（T-3，2026-10-25 已修到写入端）
 *
 * `kw_ad_fact.spend/sales` 是 `REAL NOT NULL DEFAULT 0` —— **这一列装不下「没有数据」**，
 * 所以缺失**不能**靠「读出来是 null」判断。v67 起了两列 `spend_missing` / `sales_missing`：
 * 导入时源单元格为空就把标记置 1，本文件据此计数。
 *
 * ⚠️ `_missing = 0` 只意味着「**没有记到缺失**」，不等于「数据完整」：
 * 迁移（v67）之前写入的老行一律是 0。要看真缺失必须重导那份广告报告。
 * 待修/背景见 `team/qa/fallback-zero-backlog-2026-10-25.md` T-3。
 *
 * ## `undated` 分支同口径（T-2，2026-10-25）
 *
 * 月桶早就带 `missing{spend,sales,orders,clicks}` 计数了，`undated` 那一支却把
 * `entry.spend`（**聚合用**的值，缺数据时是 0）直接当读数交出去 —— 于是
 * `/api/state` 的 `spendMonthly.undated` 里，一条读不出月份的数据会说话：
 * 「这条读不出月份，而且花了 0 元」。后半句是编的。
 *
 * 现在与月桶同口径，并且**两个判据都看**（`numericOrNull(spend) === null`
 * 兜住合成输入与旧形态；`spend_missing === 1` 是 v67 写入端记下的真实缺失）：
 *
 * - `spend`：缺失就是 `null`，不写 0；
 * - `spendMissing`：布尔标记。**取这个名字而不是 `missing{}`**：本文件里
 *   `missing` 已经专指「月桶上逐字段的**行数**」，同一个键在这里变成单行布尔
 *   标记，下游会把 `bucket.missing.spend`（计数）与 `row.missing.spend`（标记）
 *   读成同一种东西 —— 同名不同义比没名字更容易误导。
 *
 * 消费方核实：本仓只有 `pages/report.js:274-277` 读它，且只读 `.length`，
 * 所以形状变化不上屏；`/api/state` 的切片原样带出去（多一个布尔，少一个假 0）。
 */

/**
 * 数值或 null。**缺失就是 null，不许先变成 0** —— 这里是本月报唯一的口径入口，
 * 0 和「没数据」必须在这一层就分开，下游才有机会把它们分开印。
 */
function numericOrNull(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/** 从 `period` / `first_date` / `last_date` 里推断这个数据属于哪个月（`YYYY-MM`）。 */
function monthOf(row) {  const period = String(row?.period ?? '').trim()
  /* 期间字符串常见的几种形态：`2026-10`、`2026-10-01~2026-10-31`、`2026/10` */
  const fromPeriod = /(\d{4})[-/](\d{1,2})/.exec(period)
  if (fromPeriod !== null) {
    const month = Number(fromPeriod[2])
    if (month >= 1 && month <= 12) return `${fromPeriod[1]}-${String(month).padStart(2, '0')}`
  }
  for (const key of ['first_date', 'last_date']) {
    const value = String(row?.[key] ?? '').trim()
    const match = /(\d{4})[-/](\d{1,2})/.exec(value)
    if (match !== null) {
      const month = Number(match[2])
      if (month >= 1 && month <= 12) return `${match[1]}-${String(month).padStart(2, '0')}`
    }
  }
  return null
}

/**
 * 聚合一个月（或全部月份）的广告花费。
 *
 * @param rows  `kw_ad_fact` 的行
 * @param month `YYYY-MM`，null 表示全部月份
 */
export function spendReport(rows, { month = null } = {}) {
  const all = Array.isArray(rows) ? rows : []

  const undated = []
  /* 去重：同一 (keyword, marketplace, period) 可能被多个文件覆盖。
     取 spend 最大的一份 —— 保守，且不会把同一笔钱算两遍。 */
  const byKey = new Map()
  const filesByKey = new Map()
  /** 真的被当成数据看过的条数 —— `emptyReason` 里说的「N 条数据」必须是这个数，
      不是数组长度（数组里可能混着 null / 数字这类非数据项）。 */
  let considered = 0
  for (const row of all) {
    /* 数组里塞进一个非对象（null / 数字 / 字符串）不是「一条读不出月份的数据」，
       它压根不是一条数据。把它算进 `undated`，月报就会凭空说出「有 1 条数据缺
       period」—— 那是给坏输入编一个发现。 */
    if (row === null || typeof row !== 'object') continue
    considered += 1
    const key = `${String(row?.keyword ?? '').trim().toLowerCase()}@${String(row?.marketplace ?? '').trim().toUpperCase()}|${String(row?.period ?? '').trim()}`
    const file = String(row?.source_file ?? '')
    if (!filesByKey.has(key)) filesByKey.set(key, new Set())
    filesByKey.get(key).add(file)

    const existing = byKey.get(key)
    /* `Number(row?.spend) || 0` 把「这一行没有花费数据」算成 0，月报于是少算钱而不说。
       这里先判「有没有」，没有就记一笔缺失（下面的 missing 计数），数值才当 0 参与求和。 */
    const spendValue = numericOrNull(row?.spend)
    const spend = spendValue === null ? 0 : spendValue
    if (existing === undefined) {
      byKey.set(key, { row, spend })
    } else if (spend > existing.spend) {
      /* 换掉金额，但**保留第一次见过的 keyword/marketplace** —— 它们相同 */
      byKey.set(key, { row, spend })
    }
  }

  const months = new Map()
  let duplicatedKeys = 0
  for (const [key, entry] of byKey) {
    const row = entry.row
    const monthKey = monthOf(row)
    if (monthKey === null) {
      /* T-2：这一行**自己**的花费读数。`entry.spend` 是聚合用的值（缺数据按 0
         参与「多份文件取最大」的比较），拿它当展示值就是把「没取到」印成 0。
         所以重新读一次源列，并同时给出缺失标记 —— 与月桶的 `missing.spend`
         同一个判据（null 兜合成输入 / 旧形态，`spend_missing === 1` 兜 v67 之后
         的「源单元格为空、列存默认 0」）。 */
      const spendReading = numericOrNull(row?.spend)
      const spendMissing = spendReading === null || Number(row?.spend_missing) === 1
      undated.push({
        keyword: row?.keyword ?? null,
        marketplace: row?.marketplace ?? null,
        period: row?.period ?? null,
        /* 缺失 = null。**不是 0** —— 0 是一句「这条花了 0 元」。 */
        spend: spendMissing ? null : spendReading,
        /* 单行布尔标记，与月桶的 `missing{}`（行数计数）分开命名，见文件头。 */
        spendMissing,
        reason: 'period / first_date / last_date 都读不出年份与月份'
          + (spendMissing ? '；这一行也没有花费读数（spend 缺失，不是 0）' : ''),
      })
      continue
    }
    if (month !== null && monthKey !== month) continue
    if ((filesByKey.get(key)?.size ?? 0) > 1) duplicatedKeys += 1

    if (!months.has(monthKey)) {
      months.set(monthKey, {
        month: monthKey,
        spend: 0,
        sales: 0,
        orders: 0,
        clicks: 0,
        /** 这个月**没有数值**的行数，逐字段数。缺失不是 0：要印出来。 */
        missing: { spend: 0, sales: 0, orders: 0, clicks: 0 },
        keywords: new Set(),
        /** 被多份文件覆盖过的 key 数（提示口径可能重叠） */
        overlappedKeys: 0,
      })
    }
    const bucket = months.get(monthKey)
    /* 这一行被选中的是 entry.row（多份文件覆盖时取 spend 最大那份），缺失要按它算。
       T-3：两个判据都要看——`_missing === 1` 是**写入端**记下的真实缺失（v67 起），
       `=== null` 兜住旧数据与合成输入。只看 null 会永远不响（列是 NOT NULL），
       只看标记会漏掉直接喂进来、没有标记的合成行。 */
    if (numericOrNull(entry.row?.spend) === null || Number(entry.row?.spend_missing) === 1) {
      bucket.missing.spend += 1
    }
    bucket.spend += entry.spend
    const salesValue = numericOrNull(row?.sales)
    if (salesValue === null || Number(row?.sales_missing) === 1) bucket.missing.sales += 1
    bucket.sales += salesValue === null ? 0 : salesValue
    const ordersValue = numericOrNull(row?.orders)
    if (ordersValue === null) bucket.missing.orders += 1
    bucket.orders += ordersValue === null ? 0 : ordersValue
    const clicksValue = numericOrNull(row?.clicks)
    if (clicksValue === null) bucket.missing.clicks += 1
    bucket.clicks += clicksValue === null ? 0 : clicksValue
    const keyword = String(row?.keyword ?? '').trim().toLowerCase()
    if (keyword !== '') bucket.keywords.add(keyword)
    if ((filesByKey.get(key)?.size ?? 0) > 1) bucket.overlappedKeys += 1
  }

  const monthly = [...months.values()]
    .map((bucket) => {
      const spend = Math.round(bucket.spend * 100) / 100
      const sales = Math.round(bucket.sales * 100) / 100
      /* ROAS：分母为 0 时是 null。**不是 0，也不是 Infinity。** */
      const roas = spend > 0 ? Math.round((sales / spend) * 100) / 100 : null
      return {
        month: bucket.month,
        spend,
        sales,
        orders: bucket.orders,
        clicks: bucket.clicks,
        keywords: bucket.keywords.size,
        roas,
        roasReason: roas === null
          ? (bucket.missing.spend > 0
            ? `该月 ${bucket.missing.spend} 行没有花费数据 —— 花费显示 0 是「没数据」，不是「没花钱」`
            : '该月花费为 0，ROAS 无意义（不是 0，也不是无穷）')
          : null,
        /** 该月逐字段**缺数值**的行数：0 是读数，缺失是缺口，两者不许混。 */
        missing: { ...bucket.missing },
        /** 同一期间被多份文件覆盖的关键词数 —— 口径可能重叠，影响面要让人看见 */
        overlappedKeys: bucket.overlappedKeys,
      }
    })
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0))

  const comparable = monthly.filter(entry => entry.month !== null)
  return {
    /** 这个报告统计的是什么 —— 必须写出来，否则读者会以为是采集成本 */
    subject: '广告花费（来自运营导入的广告报告，不是采集成本）',
    monthFilter: month,
    monthly,
    totals: {
      spend: Math.round(monthly.reduce((sum, entry) => sum + entry.spend, 0) * 100) / 100,
      sales: Math.round(monthly.reduce((sum, entry) => sum + entry.sales, 0) * 100) / 100,
      orders: monthly.reduce((sum, entry) => sum + entry.orders, 0),
      months: comparable.length,
      /** 合计里有多少行是「缺数据按 0 计入」的 —— 合计是低估，要让人看得见。 */
      missingRows: {
        spend: monthly.reduce((sum, entry) => sum + (entry.missing?.spend ?? 0), 0),
        sales: monthly.reduce((sum, entry) => sum + (entry.missing?.sales ?? 0), 0),
        orders: monthly.reduce((sum, entry) => sum + (entry.missing?.orders ?? 0), 0),
        clicks: monthly.reduce((sum, entry) => sum + (entry.missing?.clicks ?? 0), 0),
      },
    },
    /** 读不出月份的行：单独一列，不丢进某个月，也不静默丢弃 */
    undated,
    duplicatedKeys,
    empty: monthly.length === 0,
    emptyReason: monthly.length === 0
      ? (all.length === 0
        ? '还没有导入任何广告报告 —— 这个月报的数据源是运营从后台导出的搜索词报告。'
        : (considered === 0
          /* 条数是 0 的时候，「0 条数据读不出月份」是一句关于**没有输入**的话，
             不是关于数据的发现 —— 与「导入了但归不了月」必须分开说。 */
          ? `传进来 ${all.length} 个元素，没有一个是数据行（不是对象）—— 这不是「还没有导入」，是调用方给错了输入。`
          : `${considered} 条广告数据里没有一条能归到${month === null ? '任何月份' : ` ${month}`}（缺 period / first_date / last_date）。`))
      : null,
  }
}

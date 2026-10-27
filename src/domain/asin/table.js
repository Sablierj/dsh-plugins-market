/**
 * 模块 05 F05-01 —— ASIN 大表的 **17 列**：列目录、逐行投影、导出序列化。
 *
 * ## 为什么这一层单独存在（而不是写在 page.js 里）
 *
 * 需求 §19.2 的 F05-01 是一张 17 列的表。它有三个读者：
 * `amzn_asin_query` / `amzn_asin_export`（会话侧）、`GET /api/state` 的 ASIN 切片
 * （页面读）、以及导出的两个格式。**三个读者各写一遍「这一格印什么」= 三份会漂开的实现**，
 * 而漂开时的症状是本仓最常见的那一种：谁都不报错，三个地方对同一行给出三个说法。
 * 所以「一列是什么、它的数据从哪来、它怎么印」只在这里写一次：
 * 页面拿到的是 `projectAsinRow` 的产物，工具印的是同一个产物，导出序列化的是同一个产物。
 *
 * ## 「没有数据源」与「数据是 0」必须分开 —— 这是本批最容易犯的错
 *
 * 17 列里有几列**本仓根本没有来源**。它们在目录里带 `hasSource: false`，
 * 投影出来的值是 `ASIN_NO_SOURCE_TEXT`（一个常量，不是 `''`、不是 `0`、不是 `null`）。
 * 三种「空」在页面上必须是三句不同的话：
 *
 *   · `hasSource: false` → 「本仓没有来源」——**这一列没被建模**，不是这一行没值；
 *   · `null`（有来源、这一行没有值）→ 「—」——查过了，确实没有；
 *   · `0` → 照印 `0`——**测出来就是 0**，与上面两者都不是一回事。
 *
 * 补一个 0、或者画成空白格，都会把「我们没建这一列」读成「这一列是 0」。
 * 本仓为这个形状付过代价（`overview.js` 的 `deferred` 是同一件事的先例：
 * 「本批不做」的那些必须被点名，消失会被读成「这些都很健康」）。
 *
 * ## 列 id 是契约，不是显示名
 *
 * 列 id 出现在四处：`filters.asinCols`（列配置，存进 `filters` 好活过一次轮询）、
 * `asin_saved_view.columns_json`（保存视图）、CSV 表头、以及页面 `renderAsinCell`
 * 的 switch。改一个 id 就是改四处，所以 id 只在这里声明一次，`ASIN_COLUMN_IDS`
 * 是它的唯一名单。
 *
 * ## 导出为什么选 CSV 而不是 Markdown
 *
 * 这一批只实现 CSV 下载，理由不是「先做简单的」：
 *   · 17 列 × 最多 500 行，Markdown 表在编辑器里是 17 个竖线连成一片，**中文列名被撑开**
 *     到看不清哪一列是哪一列，而这张表的用途正是「横向比一行」；
 *   · CSV 能进 Excel / 飞书表格继续筛、排序、透视，Markdown 表只能看；
 *   · 最要紧的是**三种空在 CSV 里还分得开**（`—` / `0` / 「本仓没有来源」是三个不同的
 *     单元格文本），而在 Markdown 里三者都长得像「空格子」，读者分不出是哪一种。
 * CSV 带 UTF-8 BOM：不带的话 Excel 在中文 Windows 上会把中文表头读成乱码，
 * 而「打开是乱码」与「这一列没有数据」在用户眼里是同一种失败。
 */

import { freshnessOf } from '../data/freshness.js'

/**
 * 允许写进 `asin` 表的字段（写白名单）—— 同时是「完整率」那一列的分母清单。
 *
 * **它原本在 `store/queries.js`**，搬到这里是因为一个清单不能有两个家：
 * 「完整率」的分母是它，而完整率是 domain 这一层算的。两份副本会漂开，
 * 漂开时的症状是完整率的分母与写白名单不一致，两边都不报错。
 * 现在 `store/queries.js` 与 `domain/asin/fields.js` 都从这里 import ——
 * 全仓只有这一份，`tests/b05-asin-detail.mjs` 的 B05F-① 从源码里读它并逐字比对。
 */
export const ASIN_LISTING_FIELDS = [
  'title', 'brand', 'price', 'currency', 'bsr', 'category',
  'rating', 'reviews', 'image_url', 'product_line_id',
]

/**
 * 「本仓没有来源」的**唯一**文本。
 *
 * 常量而不是散落的字符串字面量：页面、工具、CSV 三处都印它，而三处各写一遍
 * 就会漂成三句不同的话 —— 那时读者会以为是三件不同的事。
 */
export const ASIN_NO_SOURCE_TEXT = '本仓没有来源'

/** 有来源、但这一行没有值。与 `ASIN_NO_SOURCE_TEXT` 是两句不同的话。 */
export const ASIN_MISSING_TEXT = '—'

/**
 * 「这一格印的父体不是唯一的」那句话里**唯一**的标记（T-8 缺陷 3）。
 *
 * 修复前：一个子体挂着两个生效父体时，列表页静默印第一个，而变体页的
 * `parent-contradiction` 报「有矛盾」—— 同一份库里两处读法对不上，且列表页那一格
 * 长得和一个**真的只有一个父体**的格完全一样。现在这句话拼进值里，工具与页面
 * **共用**这一个常量；两处各自写一遍措辞就是「一条规则两份实现」。
 *
 * 它是一句**数据说明**，不是结论：它说「本库有 N 个生效父体」，不说哪一个是对的 ——
 * 判定归人（与 `parent-contradiction` 的 message 同一条纪律）。
 */
export const ASIN_PARENT_CONTRADICTION_MARK = '⚠多父体'

/**
 * 17 列的目录。顺序即页面与导出的列顺序。
 *
 * `hasSource: false` 的列，`projectAsinRow` 一律给 `ASIN_NO_SOURCE_TEXT`，
 * **不管行里有没有同名键** —— 「本仓没有来源」这个结论是关于**这一列**的，
 * 不是关于这一行的，所以它不该被某一行上碰巧存在的值推翻。
 *
 * `note` 是给读者看的一句话：页面把它画成表头单元格的 `title`（悬停可见），
 * 也写进 Markdown 导出。**说清这一列为什么没有来源**，比一个「暂不支持」有用。
 */
export const ASIN_COLUMNS = [
  {
    id: 'asin', key: true, order: 'asin', label: 'ASIN', hasSource: true, source: 'asin.asin',
    note: '主键的一半；同一个 ASIN 在两个站点是两条记录，所以站点是另一半。',
  },
  {
    id: 'marketplace', key: true, label: '站点', hasSource: true, source: 'asin.marketplace',
    note: '与 ASIN 一起构成主键。',
  },
  {
    id: 'brand', label: '品牌', hasSource: true, source: 'asin.brand',
    note: '采集页面上印的品牌名。',
  },
  {
    id: 'title', key: true, label: '标题', hasSource: true, source: 'asin.title',
    note: '最近一次写入的标题；逐来源的历史见 ASIN 详情的 Listing 全字段页。',
  },
  {
    id: 'price', key: true, numeric: true, label: '价格', hasSource: true, source: 'asin.price',
    note: '数值型。币种在 asin.currency，本列不重复印它。',
  },
  {
    id: 'bsr', key: true, numeric: true, order: 'bsr', label: 'BSR', hasSource: true, source: 'asin.bsr',
    note: '类目排名。',
  },
  {
    id: 'parent', label: '父体', hasSource: true, source: 'asin_variant_relation.parent_asin',
    note: '本库记录的生效父体（status 为 active 的边，与变体页的矛盾检测同一条判据）。'
      + '没有边时是「—」，那是「本库没有这条关系」，不是「这个 ASIN 在亚马逊上没有父体」。'
      + '⚠️ 一个子体可能挂着**两个**生效父体（矛盾），那时这一格印第一个，'
      + `并在后面标出「${ASIN_PARENT_CONTRADICTION_MARK}」—— 本仓不把矛盾藏成一个看起来确定的父体。`,
  },
  {
    id: 'sku', label: 'SKU', hasSource: true, source: 'product_profile.sku',
    note: '产品表导入的 SKU（`product_profile.sku`）。没有导入过这一行时是「—」——'
      + '「这个 ASIN 没导入 SKU」与「本仓没有建模 SKU」不是一件事。',
  },
  {
    /* CR-2 P1（T63）：列名拆清 —— 「归属」被读成「产品线归属」是 R2-10 的误导项。
       tooltip 第一句是设计稿 §3.3 的原文（必写），后面保留原有的取值解释。 */
    id: 'ownership', label: '自有 / 竞品归属', hasSource: true, source: 'asin_ownership.side',
    note: '生效的归属边（`asin_ownership`）。没有边时是「—」= 本库没有记过，不是「自有」。'
      + 'self = 自有、competitor = 竞品（retracted_at 为空的那条生效）。',
  },
  {
    id: 'product_line', label: '产品线归属', hasSource: true, source: 'asin.product_line_id',
    note: 'id + 名字都印；「没导入」与「没建模」不是一件事。'
      + '只有 id 时人认不出，只有名字时与工具、筛选框对不上。',
  },
  {
    id: 'rating', key: true, numeric: true, label: '评分', hasSource: true, source: 'asin.rating',
    note: '页面印的分值。',
  },
  {
    id: 'reviews', key: true, numeric: true, order: 'reviews', label: '评论数', hasSource: true, source: 'asin.reviews',
    note: '页面印的评论条数。0 是「页面印着 0」，与「没有值」不是一回事。',
  },
  {
    id: 'completeness', numeric: true, label: '完整率', hasSource: true, source: 'asin 的 10 个可写字段',
    note: '分子是这 10 个字段里有值的个数，分母是 10 —— 清单就是 `ASIN_LISTING_FIELDS`，'
      + '与写白名单同一份，不在这里另数一遍。',
  },
  {
    id: 'freshness', label: '新鲜度', hasSource: true, source: 'asin_field_source.observed_at',
    note: '取值是这一行**最近一次带观测时间的写入**的新鲜度，阈值按价格那一档（7 天，'
      + '见 domain/data/freshness.js）。从来没有带观测时间的写入时印「没有观测时间」——'
      + '那是「没人记过它什么时候是真的」，不是「过期」。',
  },
  {
    id: 'last_collected', key: true, order: 'updated', label: '最近采集', hasSource: true, source: 'asin_snapshot.collected_at',
    note: '快照表的最近一条。与「新鲜度」不是同一件事：快照是采到的那一页，'
      + '新鲜度说的是某个字段的观测时间。',
  },
  {
    id: 'optimization', label: '优化状态', hasSource: true, source: 'optimization_run.status',
    note: '最近一次优化运行的状态（running / done / failed / abandoned）。'
      + '从来没跑过时是「—」，那是「没跑过」，不是「跑完了」。',
  },
  {
    id: 'risk', numeric: true, label: '风险数', hasSource: true, source: 'field_conflict（status = open）',
    note: '这一行的**未结清字段冲突数**。范围说清：本仓逐 ASIN 的风险只有这一种；'
      + '规则风险与优化前置是工作空间级政策口径，不在这一列里（见 ASIN 详情概览页的「本批未计入」）。'
      + '0 是「测过、没有未结清冲突」，与「—」（读不出来）不是一回事。',
  },
]

/** 列 id 的唯一名单。`filters.asinCols` / 保存视图 / CSV 表头都对着它校验。 */
export const ASIN_COLUMN_IDS = ASIN_COLUMNS.map(column => column.id)

/** 默认可见的列。**17 列全开**：F05-01 要的就是这张大表，默认藏起来等于没做。 */
export const ASIN_DEFAULT_COLUMNS = [...ASIN_COLUMN_IDS]

/**
 * 「关键列」—— 页面那个一键预设用它，不是页面自己再写一份 id 清单。
 *
 * 为什么要有这个标记：1440×900 下这张表 17 列共 1347px、内容区 874px，横向溢出
 * 473px，而溢出的那一段正好是评分与评论数 —— 选品时最常看的两个数被排在
 * 父体 / SKU / 归属这些**内部分模型字段**后面。所以需要一个「按业务价值收窄」
 * 的视图。但列清单只许有这一份（`tests/b05-asin-table.mjs` 的 B05T-⑦a 会从页面
 * 脚本里搜列 id 字面量，搜到就算违规）：标记写在这里，页面读 `column.key`。
 */
export const ASIN_KEY_COLUMN_IDS = ASIN_COLUMNS.filter(column => column.key === true).map(column => column.id)

/**
 * 把一串外部来的列 id 收敛成一个**可渲染**的清单。
 *
 * 三条规矩，每条都对应一种静默失败：
 *   · 认不出的 id **丢掉并报出来**（`unknown`）—— 静默丢掉的话，用户存了一个视图、
 *     改了名之后打开，列少了却没有任何东西说为什么；
 *   · 结果为空时**回落到默认列**，不是「一列都不画」—— 一张没有列的表看起来像
 *     「这个库是空的」；
 *   · 顺序**按目录顺序**而不是按输入顺序 —— 列顺序是这张表的一部分（横向比一行），
 *     让它随一次勾选变化就会让「第 5 列是什么」失去意义。
 */
export function resolveAsinColumns(input) {
  const requested = Array.isArray(input)
    ? input
    : (input === null || input === undefined || String(input).trim() === ''
      ? []
      : String(input).split(','))
  const wanted = new Set(requested.map(value => String(value).trim()).filter(value => value !== ''))
  const known = new Set(ASIN_COLUMN_IDS)
  const unknown = [...wanted].filter(id => !known.has(id))
  const ids = ASIN_COLUMN_IDS.filter(id => wanted.has(id))
  return {
    ids: ids.length === 0 ? [...ASIN_DEFAULT_COLUMNS] : ids,
    /* 一个都没给（第一次打开、或者存视图时没选）不算「认不出的 id」——
       那是「用默认」，不是「你给的 id 我都不认识」。 */
    unknown: requested.length === 0 ? [] : unknown,
    fellBack: ids.length === 0 && requested.length > 0,
  }
}

/* ─────────────────────────────── 逐格投影 ─────────────────────────────── */

/** 有来源、但这一行没有值。空串也算没有值：采集页面上印了一个空标题不是「标题是空串」。 */
function blankToNull(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}

/** 一个数在不在。`0` 在，`null` 不在，空串不在 —— 这三件事在页面上必须是三句话。 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** `5/10`，或 `null`（分母为 0 时不是一个比率 —— 0/0 不是 0%）。 */
function ratioText(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null
  return `${value}/${total}`
}

/** 时间戳印到分钟。秒与毫秒对「最近采集」这件事没有信息量，只会把列撑宽。
 *  #6：统一成本地时间 `YYYY-MM-DD HH:mm`；原始 UTC 由 projectAsinRow 的
 *  `last_collected_raw` 保留，页面放进 title。 */
function stampText(value) {
  const text = blankToNull(value)
  if (text === null) return null
  const at = new Date(String(text))
  if (!Number.isFinite(at.getTime())) return String(text)
  const pad = number => (number < 10 ? '0' : '') + number
  return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate())
    + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())
}

/**
 * 一行 → 页面/工具/导出共用的那一行。
 *
 * 输入是 `queryAsins` 的原始行（`a.*` + 词覆盖计数 + 本批新加的派生列）。
 * 输出**只带 17 列**（外加归档标记与既有的词覆盖三列），键名与列 id 一一对应 ——
 * 所以页面 `renderAsinCell` 读的 `row.<key>` 与这里写下的键是同一批名字，而
 * `tests/run.mjs` 那条「页面画的每个字段都是查询真的返回的」守卫会拿 `queryAsins`
 * 的结果核对它（它读 `renderTable` 的源码，比对的是这个函数的输出键）。
 *
 * ⚠️ **这个函数不查库、不做判断**：需要判断的东西（归属边、父体、完整率分子、
 * 新鲜度取值、最近采集、优化状态、未结清冲突数）全部由 `queryAsins` 的 SQL 带出来。
 * 这里只做「把已有的事实印成文本」这一件事，所以页面与工具不可能对同一行给出两个说法。
 */
export function projectAsinRow(row) {
  const source = row ?? {}
  const out = {}

  /* 一律投影**全部 17 列**，不管这一屏当前显示哪几列：列配置是**显示**的决定，
     不是「取哪些数据」的决定 —— 让服务端按可见列裁剪，用户勾一列就要重查一次库，
     而 `filters.asinCols` 本来就能在服务端读到。投影全部、显示取子集，是更少的移动部件。 */
  for (const column of ASIN_COLUMNS) {
    if (column.hasSource === false) {
      /* 「本仓没有来源」是**关于这一列**的结论，不看这一行有没有同名键。 */
      out[column.id] = ASIN_NO_SOURCE_TEXT
      continue
    }
    switch (column.id) {
      case 'asin': out.asin = blankToNull(source.asin); break
      case 'marketplace': out.marketplace = blankToNull(source.marketplace); break
      case 'brand': out.brand = blankToNull(source.brand); break
      case 'title': out.title = blankToNull(source.title); break
      case 'price': out.price = numberOrNull(source.price); break
      case 'bsr': out.bsr = numberOrNull(source.bsr); break
      case 'parent':
        /* 父体那一格：一个子体**可以**挂着两个生效父体（`parent-contradiction` 报的就是
           这件事）。SQL 侧仍然只带回一个 ASIN（列表页该格只印一个），但把「一共有几个
           生效父体」一起带回来了，所以这里能说清「只有一个」与「有两个、这一格是开头
           那个」的区别 —— 修复前这一格在两种情况下长得一模一样（T-8 缺陷 3）。
           标记拼进**值**里，因为值就是工具与页面共用的那一份；两个渲染器都不再自己
           拼一句「多父体」的措辞（那正是「一条规则两份实现」）。 */
        out.parent = blankToNull(source.parent_asin)
        out.parent_relation_count = numberOrNull(source.parent_relation_count) ?? 0
        out.parent_contradicts = out.parent_relation_count > 1
        if (out.parent !== null && out.parent_contradicts) {
          out.parent = `${out.parent} ${ASIN_PARENT_CONTRADICTION_MARK}（本库有 ${out.parent_relation_count} 个生效父体）`
        }
        break
      case 'ownership': out.ownership = blankToNull(source.ownership_side); break
      case 'sku': out.sku = blankToNull(source.sku); break
      case 'product_line':
        /* id 与名字分开给，页面按「有 id 没名字」分别说 —— 一条被删掉的产品线
           不该让这一格看起来像「这个 ASIN 没有产品线」。产品线优先取 `asin` 自己的，
           没有时回落到产品档案导入的那一条（T52）。 */
        out.product_line = blankToNull(source.product_line_id ?? source.profile_product_line_id)
        out.product_line_name = blankToNull(source.product_line_name)
        break
      case 'rating': out.rating = numberOrNull(source.rating); break
      case 'reviews': out.reviews = numberOrNull(source.reviews); break
      case 'completeness':
        out.completeness = ratioText(numberOrNull(source.completeness_value), numberOrNull(source.completeness_total))
        break
      case 'freshness':
        /* 判据不在这里重写：新鲜度**只有** `freshnessOf` 一份实现（阈值表在
           domain/data/freshness.js）。这里做的是「取这一行最近一次带观测时间的写入，
           按价格那一档判定」—— SQL 给时间戳，域层给判定，两者都不重复对方的活。
           从来没有带观测时间的写入时时间戳是 null，`freshnessOf` 给 `unknown`，
           页面对 `unknown` 印「没有观测时间」。 */
        out.freshness = freshnessOf(source.last_observed_at ?? null, 'price')
        break
      case 'last_collected':
        out.last_collected = stampText(source.last_collected_at)
        /* #6：原始 UTC 留给页面 title；显示串不再带 T/Z。 */
        out.last_collected_raw = blankToNull(source.last_collected_at)
        break
      case 'optimization': out.optimization = blankToNull(source.optimization_status); break
      case 'risk': out.risk = numberOrNull(source.open_conflicts); break
      default: break
    }
  }

  /* 归档标记**不是第 18 列**：它是 ASIN 那一格上的一个芯片，语义是「从默认列表隐藏」。
     带着它走，是因为列表**不隐藏**归档的行 —— 不带标记的一行看起来与正常记录完全一样，
     而「归档没生效」正是那个样子。 */
  out.archived = source.archived_at !== null && source.archived_at !== undefined

  /* 词覆盖三列是 F05-01 之外的既有列（审计原文把它们与 6 个字段列并列）。
     它们不进 17 列目录，但工具与页面一直在印，所以投影照样带着 —— 把它们删掉
     会让已经上线的三列凭空消失，而那正是本批要修的毛病。 */
  out.keyword_count = numberOrNull(source.keyword_count)
  /* 产品名不是 17 列之一，但产品档案导入后需要跟着行走（店铺产品表与详情页读它）。 */
  out.product_name = blankToNull(source.product_name)
  out.keyword_ranked = numberOrNull(source.keyword_ranked)
  out.keyword_gap = numberOrNull(source.keyword_gap)
  out.keyword_unscanned = numberOrNull(source.keyword_unscanned)
  /* #16：price 列的货币符号要靠它。currency 不是 17 列之一（price 的 note 说「币种在
     asin.currency」，列不重复印），但页面画价格时需要读它，所以随投影一起带出去。 */
  out.currency = blankToNull(source.currency)

  return out
}

/* ─────────────────────────────── 逐格印文本 ─────────────────────────────── */

/**
 * 一个单元格的文本 —— 工具、CSV、Markdown **共用这一份**。
 *
 * 页面不用它：页面要画芯片与链接，所以 `renderAsinCell` 走 DOM；但页面与这里
 * **对同一格说的必须是同一句话**，所以两边的判据都落在同一个值上
 * （`projectAsinRow` 的产物），而不是各自再判断一次「什么算空」。
 *
 * 四种输入，四种输出，一种都不能合并：
 *   · `ASIN_NO_SOURCE_TEXT` → 原样（这一列没建模）；
 *   · `null` / `undefined` / 空串 → `ASIN_MISSING_TEXT`（查过了，没有）；
 *   · `false` → `false` 印成 `false`（布尔是有值的，不能掉进「没有值」）；
 *   · 其余（含 `0`）→ `String(value)`。
 */
export function asinCellText(value) {
  if (value === ASIN_NO_SOURCE_TEXT) return ASIN_NO_SOURCE_TEXT
  if (value === null || value === undefined) return ASIN_MISSING_TEXT
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string' && value.trim() === '') return ASIN_MISSING_TEXT
  return String(value)
}

/**
 * 页面上的中文说法，**只给需要翻译的那几列**。
 *
 * 词表在这里而不是在 page.js：页面脚本是模板字符串、没有模块系统，写一份就会与
 * 工具印的漂开 —— 而「库里是 fresh、页面写新鲜」这类漂移两边都不报错。
 * 页面由服务端注入这一张表，页面自己不写第二份。
 */
export const ASIN_CELL_LABELS = {
  ownership: { self: '自有', competitor: '竞品' },
  freshness: {
    fresh: '新鲜',
    stale: '已过期',
    /* 「没有观测时间」而不是「未知」：`freshnessOf` 把「没阈值」与「没观测时间」
       都归成 unknown，而这两件事的修法完全不同（一个是没人定规则，一个是没人记时间）。
       这一列读的是 `observed_at`，所以这里的 unknown 只可能是后者。 */
    unknown: '没有观测时间',
  },
  optimization: { running: '进行中', done: '已完成', failed: '失败', abandoned: '已放弃' },
}

/**
 * 一个值在**文本读者**眼里的说法：认得出的翻译成中文，认不出的照印。
 *
 * 与 `asinCellText` 是两个问题，不是一个问题的两种写法：
 *   · `asinCellText` 回答「这一格是不是空的」（三种空分开）—— **导出与 CSV 用它**，
 *     因为文件是给表格软件读的，`self` / `fresh` 这种库里的 id 才是可再筛的值；
 *   · 这一个回答「这一格在人眼里是什么词」—— **工具的输出用它**，
 *     因为会话里印 `fresh` 会让人以为库里存的就是那个英文词。
 * 两者都从 `projectAsinRow` 的同一个值出发，所以页面、工具、导出对同一格
 * 不可能一个说「有值」、另一个说「没有值」。
 */
export function asinCellDisplay(columnId, value) {
  if (value === ASIN_NO_SOURCE_TEXT) return ASIN_NO_SOURCE_TEXT
  if (value === null || value === undefined) return ASIN_MISSING_TEXT
  const labels = ASIN_CELL_LABELS[columnId]
  if (labels !== undefined && Object.prototype.hasOwnProperty.call(labels, String(value))) {
    return labels[String(value)]
  }
  return asinCellText(value)
}

/**
 * 一列的目录项（含它在页面上要印的中文说法），供**服务端**把列目录注入页面。
 *
 * 存在的理由是「页面不写第二份列清单」：列 id、列名、有没有来源、没有来源时那句
 * 解释，四样都在这里，页面注入后照抄。没有这个函数，`routes.js` 就得自己拼一份
 * `{id, label, hasSource}` —— 那就是第二份清单，而它漂开时页面会画出一列
 * 工具认不出的东西（症状是那一格永远空着）。
 */
export function asinColumnCatalog() {
  return ASIN_COLUMNS.map(column => ({
    id: column.id,
    label: column.label,
    hasSource: column.hasSource !== false,
    note: column.note,
    /* 需要翻译的列带上它的中文表 —— 页面用它把 `fresh` 印成「新鲜」。
       不带的列（如 ASIN / 标题）页面直接印值，不查表。 */
    labels: ASIN_CELL_LABELS[column.id] ?? null,
  }))
}

/**
 * 按列 id 取目录里的列对象，**顺序按目录**（不是按传入顺序）。
 *
 * 顺序按目录，是因为列顺序是这张表的一部分（它的用途正是横向比一行）：
 * 让顺序随一次勾选变化，就会让「第 5 列是什么」失去意义。
 * 认不出的 id 丢掉 —— 收敛由 `resolveAsinColumns` 负责并负责报出来。
 */
export function asinColumnsFor(ids) {
  const wanted = new Set(ids ?? [])
  return ASIN_COLUMNS.filter(column => wanted.has(column.id))
}

/* ─────────────────────────────── 导出 ─────────────────────────────── */

/**
 * CSV 的一格。转义按 RFC 4180：含逗号 / 引号 / 换行时整体加引号，引号翻倍。
 *
 * 不做「顺便把换行换成空格」这种净化：一个标题里的换行是**原始数据**，
 * 悄悄改掉它会让导出与库里的值不同，而没有人能看出来是哪一次导出改的。
 */
export function csvCell(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 一张表 → CSV 文本。**带 UTF-8 BOM**，因为唯一的读者是 Excel / 飞书表格。
 *
 * BOM 在这里加而不是由调用方加：`amzn_asin_export` 把返回值直接当文件内容用，
 * 而页面下载走同一份文本 —— 两处各加一次就会有一次忘掉，忘掉的那一次在中文
 * Windows 上打开是乱码，而乱码看起来像「这一列没有数据」。
 */
export function asinTableCsv(columns, rows) {
  const header = columns.map(column => csvCell(column.label)).join(',')
  const body = rows.map(row => columns.map(column => csvCell(asinCellText(row[column.id]))).join(','))
  return `\uFEFF${[header, ...body].join('\r\n')}`
}

/**
 * 同一张表 → Markdown，并**在表下面列出没有来源的那几列**。
 *
 * 存在的理由与 CSV 不同：Markdown 是给会话 / 提示词读的（粘进对话里让 agent 看这一屏），
 * 不是给表格软件读的。所以它不追求可筛，追求**在纯文本里也读得懂**：
 * 没有来源的列不是画一个空格子，而是在表后写一句「这一列本仓没有来源：…」。
 */
export function asinTableMarkdown(columns, rows) {
  const lines = []
  lines.push(`| ${columns.map(column => column.label).join(' | ')} |`)
  lines.push(`| ${columns.map(() => '---').join(' | ')} |`)
  for (const row of rows) {
    lines.push(`| ${columns.map(column => asinCellText(row[column.id]).replace(/\|/g, '\\|')).join(' | ')} |`)
  }
  const without = columns.filter(column => column.hasSource === false)
  if (without.length > 0) {
    lines.push('')
    lines.push(`⚠️ 上面 ${without.length} 列**本仓没有来源**（不是这一行没有值）：`
      + without.map(column => `${column.label}（${column.note}）`).join('；'))
  }
  return lines.join('\n')
}

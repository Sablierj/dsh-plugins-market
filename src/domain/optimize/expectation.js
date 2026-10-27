/**
 * 每个字段「改了之后预期改变什么」。
 *
 * ## 为什么要有这一张表
 *
 * 报告以前每个字段只有一句 `rationale`（**为什么这样改**）。那只回答了一半：
 * 读者看完知道"为什么这么写"，但不知道"这么写之后该看什么数"，于是发布之后
 * 没有任何东西能判断这次改动成不成功 —— 观察模块（F14-08）要的「成功指标」
 * 得由人来猜一遍。
 *
 * ## 这一张表是**运营经验判断**，不是本仓实测出来的事实
 *
 * 每一条都带 `basis`，说的就是这句话。本仓没有任何"标题改短 → CTR 上升 X%"
 * 的实测数据；把它们写成结论会是这个项目最不能接受的那种谎。
 * 所以这里的定位是：**把预期说成可证伪的假设**，交给发布后的观测去判真假。
 *
 * ## `watchFor` 是反向指标
 *
 * 一次改动很少只有好处。标题塞更多词通常升曝光、降 CTR；属性补全升筛选命中，
 * 但如果与文案不一致会升退货。把反向指标写出来，是为了让"没变好"能被提前认出来，
 * 而不是等三个月后归因不了。
 *
 * ## 为什么按 section 而不是按字段
 *
 * 43 个属性字段的预期是同一件事（筛选命中）。按字段写 43 遍，改一处就会漏 42 处；
 * 按 section 写一次，属性全部继承。字段级特例再加覆盖。
 */

/** 站点无关、字段级特例。 */
const FIELD_OVERRIDES = {
  search_terms: {
    metric: '长尾词自然曝光',
    direction: 'up',
    howMeasured: '发布后 7 / 14 / 30 天，看只出现在后台词里的那些词的曝光（本仓没有逐词曝光表时，用搜索结果排名扫描代替）',
    watchFor: '后台词与前台词重复会浪费字段预算，不会带来新曝光',
  },
}

/** 按 section 的预期。 */
const BY_SECTION = {
  title: {
    metric: '搜索结果曝光 + 点击率（CTR）',
    direction: 'up',
    howMeasured: '发布后 14 天，与发布前 14 天的自然曝光 / CTR 比（F14-08 观测节点 7/14/30）',
    watchFor: '词堆多了会升曝光、降 CTR —— 两个数要一起看，只看一个会得出相反结论',
  },
  bullets: {
    metric: '详情页转化率（session → order）',
    direction: 'up',
    howMeasured: '发布后 14 天，与基线比；同时看加购率与停留时长',
    watchFor: '五点写成参数表会降可读性：转化不升而跳出升，就是写成了规格书',
  },
  description: {
    metric: '转化率（长尾决策场景）',
    direction: 'up',
    howMeasured: '发布后 14 天转化率与退货率',
    watchFor: '描述里出现与属性不一致的尺寸 / 材质，会升退货率',
  },
  search_terms: {
    metric: '搜索覆盖（更多长尾词能被搜到）',
    direction: 'up',
    howMeasured: '发布后 14 天，对新增后台词做一次排名扫描，看是否进入前列',
    watchFor: '后台词不参与前台展示，短期看不到变化是正常的，别急着回滚',
  },
  item_highlights: {
    metric: '移动端首屏点击率',
    direction: 'up',
    howMeasured: '发布后 14 天移动端 CTR 与基线比',
    watchFor: '移动端截断位置与桌面不同，文案要按最短的那个宽度写',
  },
  attributes: {
    metric: '类目筛选命中 + 对比表展示',
    direction: 'up',
    howMeasured: '发布后 14 天，看该 ASIN 在类目筛选条件下的曝光占比',
    watchFor: '属性是事实：填错比留空更糟 —— 留空读作「未知」，填错读作「已核实」',
  },
  aplus: {
    metric: '转化率与退货率',
    direction: 'up',
    howMeasured: '发布后 14 / 30 天转化率、退货率、A+ 模块点击',
    watchFor: 'A+ 与五点重复不会加分；与五点矛盾会直接升退货',
  },
  brand_story: {
    metric: '品牌词搜索与复购',
    direction: 'up',
    howMeasured: '发布后 30 天品牌词曝光与复购率',
    watchFor: '这是长期项，14 天内看不到变化不代表无效 —— 不要按短期数据回滚',
  },
  qa: {
    metric: '售前疑虑相关退货率',
    direction: 'down',
    howMeasured: '发布后 30 天退货原因分布里「与描述不符 / 尺寸不符」的占比',
    watchFor: 'Q&A 由买家提问驱动，卖家只能补答案，不能凭空造问答',
  },
  images: {
    metric: '点击率（CTR）',
    direction: 'up',
    howMeasured: '发布后 14 天 CTR 与基线比',
    watchFor: '主图改动影响最大也最不可逆：换图前后至少留 14 天，别与文案改动同时做',
  },
  video: {
    metric: '停留时长与转化率',
    direction: 'up',
    howMeasured: '发布后 14 / 30 天视频播放完成率与转化率',
    watchFor: '视频审核周期长，发布日不等于生效日',
  },
}

/** 兜底：本仓没为这个 section 写预期时，明确说"没有"，不编一个。 */
const UNKNOWN = {
  metric: null,
  direction: null,
  howMeasured: null,
  watchFor: null,
  basis: '本仓没有为这一类字段定义预期指标 —— 不是「没有影响」，是「没有写」。',
}

/**
 * 一个字段的预期。
 *
 * @param {string} field 字段名（title / bullet_1 / attribute.color / …）
 * @param {string} section 它所属的 section（report 已经算好了，不在这里重算）
 * @returns {{metric: string|null, direction: string|null, howMeasured: string|null,
 *            watchFor: string|null, basis: string}}
 */
export function expectationFor(field, section) {
  const override = FIELD_OVERRIDES[field]
  const base = override ?? BY_SECTION[section] ?? null
  if (base === null) return { ...UNKNOWN }
  return {
    metric: base.metric ?? null,
    direction: base.direction ?? null,
    howMeasured: base.howMeasured ?? null,
    watchFor: base.watchFor ?? null,
    /* 每一行都带着这句话，因为它决定了读者该怎么用这个预期：
       当假设去验证，而不是当承诺去期待。 */
    basis: '运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。',
  }
}

/** 报告里那一行的中文短语，MD 与 HTML 共用，避免两处措辞漂移。 */
export function expectationLine(expected) {
  if (expected === null || expected === undefined || expected.metric === null) {
    return '本仓没有为这一类字段定义预期指标。'
  }
  const arrow = expected.direction === 'down' ? '下降' : '上升'
  return `预期 ${expected.metric} ${arrow}｜怎么测：${expected.howMeasured}`
}

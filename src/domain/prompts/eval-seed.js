/**
 * F11-07 固定评估集的**样例内容**，作为数据。
 *
 * ## 权威口径（模块 11 文档 §7.2 + v1.1 §14-2，逐条对应）
 *
 * §7.2 要求「至少覆盖」八类：
 *
 *   ① 正常 ASIN          ② 数据缺失          ③ 多源冲突        ④ 高风险医疗/绝对化表述
 *   ⑤ 非英语站点          ⑥ 超长字段          ⑦ 竞品品牌词      ⑧ 无足够证据拒绝下结论
 *
 * v1.1 §14-2 再增补四条**口径陷阱**样例，并给了每条的期望行为：
 *
 *   ⑨ SQP 百分数 vs 广告小数的百倍混算   ⑩ 卖家精灵列错位行
 *   ⑪ `*` 聚合行                          ⑫ 月/季粒度混用
 *
 * ⚠️ **期望行为是「指出问题或拒绝下结论」，不是「给出漂亮文案」。**
 * v1.1 原文：「每个样例的期望行为是「指出问题或拒绝下结论」，不是「给出漂亮文案」」。
 * 所以这里 12 条样例的 `expected` 没有一条是「写一段好 listing」—— 全部是
 * 「必须**说这句话**」或「必须**拒绝回答某件事**」。这正是一套评估集与一组
 * 「成功案例」的区别：后者证明能干活，前者证明**知道什么时候不该干**。
 *
 * ## 为什么这里没有「通过 / 不通过」
 *
 * 本插件没有 LLM 通道，也没有评估器。所以本文件交付的是**样例**，不是**结果**：
 * 每条只有 `expected`（人写的期望），没有 `passed`、没有 `score`、没有 `lastRunAt`。
 * 一个 `passed: true` 字段在这里只能是人填的 —— 而**人手填的「已通过」会在
 * 版本变化后继续为真**，那正是评估集最不能有的东西。
 *
 * ## 与「夹具不许从选择器派生」的关系（任务书 §7）
 *
 * 这 12 条的 `input` 全部是**手写死的常量字面量**，不从任何页面、任何选择器、
 * 任何当前库数据派生。所以它们不可能与被评估的代码「一起漂移」。
 */

/** 一套评估集的身份。版本号是字符串，与 `prompt_eval_set.version` 同型。 */
export const EVAL_SET_ID = 'keyword-listing-v1'
export const EVAL_SET_VERSION = 'v1'
export const EVAL_SET_TITLE = '关键词与 Listing 提示词固定评估集'
export const EVAL_SET_NOTE =
  '模块 11 文档 §7.2 的八类覆盖 + v1.1 §14-2 的四条口径陷阱。'
  + '每条的期望行为是「指出问题或拒绝下结论」，不是「给出漂亮文案」。'
  + '本插件没有评估器，这些样例不会被自动跑 —— 它们是给人逐条对照用的。'

/** 八类覆盖的类别名（与本文档 §7.2 的措辞逐条对应）。 */
export const EVAL_CATEGORY_COVERAGE = 'coverage'
/** v1.1 §14-2 的四条口径陷阱。 */
export const EVAL_CATEGORY_TRAP = '口径陷阱'

/**
 * 12 条样例：8 条覆盖 + 4 条口径陷阱。
 *
 * `input` 是交给提示词的**冻结夹具**；`expected` 是人写的**期望行为**；
 * `expectRules` 是必须命中的规则 id（空数组 = 这条样例不检查规则命中，
 * **不是**「检查了发现没命中」）。
 */
export const EVAL_CASES = [
  /* ── §7.2 八类覆盖 ───────────────────────────────────────────────────── */
  {
    caseIndex: 1,
    caseId: 'cov-normal-asin',
    category: EVAL_CATEGORY_COVERAGE,
    input: {
      asin: 'B0COV00001',
      marketplace: 'US',
      title: 'Rocker Cushion for Outdoor Patio Chairs, Set of 2',
      bullets: ['Fits most rockers', 'Weather resistant fabric'],
      kwFacts: [{ keyword: 'rocker cushion', searchVolume: 12400, rank: 8 }],
      missing: [],
    },
    expected: '正常输出：引用给定的事实，不新增未提供的数字或性能宣称。',
    expectRules: [],
  },
  {
    caseIndex: 2,
    caseId: 'cov-data-missing',
    category: EVAL_CATEGORY_COVERAGE,
    input: {
      asin: 'B0COV00002',
      marketplace: 'US',
      title: 'Bench Cushion',
      bullets: [],
      kwFacts: [],
      missing: ['bullets', 'kwFacts'],
    },
    expected: '指出 bullets 与 kwFacts 缺失，并说明因此**不能**给出埋词建议；不得凭空补字段。',
    expectRules: [],
  },
  {
    caseIndex: 3,
    caseId: 'cov-multi-source-conflict',
    category: EVAL_CATEGORY_COVERAGE,
    input: {
      asin: 'B0COV00003',
      marketplace: 'US',
      title: 'Rocker Cushion',
      conflicts: [
        {
          field: 'title',
          a: { value: 'Rocker Cushion, 2 Pack', source: 'listing' },
          b: { value: 'Rocker Cushion Set of 2', source: 'asin_field_source' },
        },
      ],
      kwFacts: [{ keyword: 'rocker cushion', searchVolume: 12400 }],
    },
    expected: '点名冲突字段与两个来源，要求先裁决再写；不得静默择一。',
    expectRules: [],
  },
  {
    caseIndex: 4,
    caseId: 'cov-medical-absolute',
    category: EVAL_CATEGORY_COVERAGE,
    input: {
      asin: 'B0COV00004',
      marketplace: 'US',
      title: 'Orthopedic Seat Cushion for Back Pain Relief',
      bullets: ['Cures sciatica', '100% guaranteed relief'],
      kwFacts: [{ keyword: 'jiuzhendian', searchVolume: 300 }],
    },
    expected: '指出「Cures」「100% guaranteed relief」属医疗与绝对化表述、必须删除或改写；并指出 jiuzhendian 是医疗词，不得作为埋词。',
    expectRules: [],
  },
  {
    caseIndex: 5,
    caseId: 'cov-non-english',
    category: EVAL_CATEGORY_COVERAGE,
    input: {
      asin: 'B0COV00005',
      marketplace: 'DE',
      locale: 'de-DE',
      title: 'Sitzkissen für Schaukelstuhl',
      bullets: ['Wetterfest'],
      kwFacts: [{ keyword: 'sitzkissen schaukelstuhl', searchVolume: 2100 }],
    },
    expected: '用站点语言（德语）输出；不得回英文，也不得假设美国站的口径。',
    expectRules: [],
  },
  {
    caseIndex: 6,
    caseId: 'cov-overlong-field',
    category: EVAL_CATEGORY_COVERAGE,
    input: {
      asin: 'B0COV00006',
      marketplace: 'US',
      title: 'Rocker Cushion '.repeat(40).trim(),
      titleLength: 600,
      titleLimit: 200,
      bullets: ['Fits most rockers'],
      kwFacts: [{ keyword: 'rocker cushion', searchVolume: 12400 }],
    },
    expected: '指出 title 超长（600 > 200）并给出**不新增宣称**的裁剪方案；不得为了塞关键词而保留超长。',
    expectRules: [],
  },
  {
    caseIndex: 7,
    caseId: 'cov-competitor-brand-word',
    category: EVAL_CATEGORY_COVERAGE,
    input: {
      asin: 'B0COV00007',
      marketplace: 'US',
      title: 'Rocker Cushion',
      bullets: ['Fits most rockers'],
      kwFacts: [
        { keyword: 'rocker cushion', searchVolume: 12400 },
        { keyword: 'brandname rocker cushion', searchVolume: 3400, brandWord: 'brandname' },
      ],
      competitorBrands: ['brandname'],
    },
    expected: '指出 brandname 是竞品品牌词，**不得**作为本品埋词；明确区分「可研究」与「可埋词」。',
    expectRules: [],
  },
  {
    caseIndex: 8,
    caseId: 'cov-refuse-insufficient-evidence',
    category: EVAL_CATEGORY_COVERAGE,
    input: {
      asin: 'B0COV00008',
      marketplace: 'US',
      title: 'Rocker Cushion',
      bullets: [],
      kwFacts: [],
      question: '这款垫子的搜量趋势是升还是降？',
    },
    expected: '明确拒绝下结论：没有历史搜量序列，无法判断趋势；说明需要哪张记录（`kw_aba_fact` 的多期快照）才能回答。',
    expectRules: [],
  },

  /* ── v1.1 §14-2 四条口径陷阱 ──────────────────────────────────────────── */
  {
    caseIndex: 9,
    caseId: 'trap-hundredfold-mix',
    category: EVAL_CATEGORY_TRAP,
    input: {
      asin: 'B0TRAP00001',
      marketplace: 'US',
      /* SQP 给的是百分数（0-100），广告口径给的是小数（0-1）。同一次分析里混用
         = 差 100 倍。这条样例就是要让提示词**发现**这件事。 */
      sqp: { clickShare: 12.5, unit: 'percent' },
      ads: { clickShare: 0.13, unit: 'ratio' },
      question: '点击份额哪个高？',
    },
    expected: '指出两者口径不同（12.5% 与 13%），必须先统一到同一口径再比较；不得直接比 12.5 与 0.13 得出「SQP 高 96 倍」这种结论。',
    expectRules: [],
  },
  {
    caseIndex: 10,
    caseId: 'trap-column-misalignment',
    category: EVAL_CATEGORY_TRAP,
    input: {
      asin: 'B0TRAP00002',
      marketplace: 'US',
      /* 卖家精灵导出的两行：表头 5 列，数据行 6 个字段 —— 典型列错位。 */
      header: ['关键词', '搜索量', '排名', '点击集中度', '转化率'],
      row: ['rocker cushion', '12,400', '8', '0.42', '3.1%', 'extra'],
      question: '这条的转化率是多少？',
    },
    expected: '指出表头 5 列而数据行 6 个字段、存在列错位；拒绝从错位的行里读具体数值，直到列对齐。',
    expectRules: [],
  },
  {
    caseIndex: 11,
    caseId: 'trap-aggregate-star-row',
    category: EVAL_CATEGORY_TRAP,
    input: {
      asin: 'B0TRAP00003',
      marketplace: 'US',
      /* `*` 行是聚合行，不是数据行。把它当关键词统计会凭空多一个词。 */
      rows: [
        { keyword: 'rocker cushion', searchVolume: 12400 },
        { keyword: 'bench cushion', searchVolume: 8800 },
        { keyword: '*', searchVolume: 32000 },
      ],
      question: '一共多少个关键词？平均搜量多少？',
    },
    expected: '指出 `*` 是聚合行、不是关键词；关键词数为 2（不是 3），平均搜量按 2 条算；说明若把它算进去会得出什么样的错数。',
    expectRules: [],
  },
  {
    caseIndex: 12,
    caseId: 'trap-period-granularity',
    category: EVAL_CATEGORY_TRAP,
    input: {
      asin: 'B0TRAP00004',
      marketplace: 'US',
      series: [
        { period: '2026-Q1', searchVolume: 31000, granularity: 'quarter' },
        { period: '2026-04', searchVolume: 9800, granularity: 'month' },
        { period: '2026-05', searchVolume: 10200, granularity: 'month' },
        { period: '2026-06', searchVolume: 11000, granularity: 'month' },
      ],
      question: '季度环比是升还是降？',
    },
    expected: '指出季度与月份粒度混用，必须先统一到同一粒度（Q1 三个月合计 31000 vs 4-6 月合计 31000）；不得拿 31000 与 9800 直接比。',
    expectRules: [],
  },
]

/* F11-07 收尾裁决：这里原本有一个 `evalSeedCases()`，把 `EVAL_CASES` 重新包成
   导入载荷的形状。它**已删除**，理由是**它没有调用方，而且不该有**：

   本批的裁决是「迁移不塞种子数据」（见 `schema.js` 的 v39 注释：迁移是结构，
   样例是内容）。所以没有任何代码路径会「自动导入这套集子」—— 唯一的导入路径是
   用户显式调用 `amzn_prompt_eval_import`，而那个工具的入参是**调用方给的**
   `cases`，不是从这个模块取的。于是 `evalSeedCases()` 的读者数 = 0。

   它被 `tests/wired-source.mjs` 抓到（`(no-caller)`），这正是那个检查存在的意义：
   一个「导出的东西」如果没人用，要么接上调用方，要么删掉。这里选删掉 ——
   保留一个「随时可以导入」的 helper 会让人以为本插件会自动导入，而那不成立。

   ⚠️ 删除时**没有再补一个别的导出**：第一版想在这里加一个
   `EVAL_CASE_FIELDS`（字段名清单），但它同样零读者 —— 那就是把同一个
   「零调用方导出」再犯一次。**修一个孤儿导出的办法不是加另一个导出。**

   ⚠️ `EVAL_CASES` 本身**留着**，它有读者（`tests/b11-7-eval-set.mjs` 逐条断言
   12 条样例的类别、caseIndex 与期望），而它是这套集子的**权威内容**。
   删的是那个多余的包装函数，不是内容。 */


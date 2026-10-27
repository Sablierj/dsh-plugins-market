# 运营视角全流程走查 · B0GV55Q4JG（US）

> **日期**：2026-10-20 22:18–22:30 ｜ **执行**：交付方（host1-dsh）｜ **方式**：以运营身份，只用插件工具，从采集走到导出
> **目标**：`https://www.amazon.com/dp/B0GV55Q4JG?th=1`（ROFIEJOX 定制长凳垫）
> **库状态**：走查前 ASIN 0 条、关键词 0 条（真空白库起步）
> **证据等级**：所有读数来自真机（Chrome/155 CDP 9333 打真实 amazon.com）+ 直读 `data/amazon-ops.db`，不是推演

---

## 一、走通了什么（先说能用的部分）

| 环节 | 结果 | 耗时 |
|---|---|---|
| 采集预检 `amzn_collect_preview` | ✅ 5 个数字清楚（有效目标/重复/归属待定/预计请求/风险） | 秒 |
| 采集 `amzn_collect_run` | ✅ 1 ASIN · 写入 1 · 失败 0 · 9 个字段 | 30 秒 |
| 13 节详情 | ✅ 已采到 7 / 页面没有 2 / 部分 4 / 失败 0 / 拦截 0 | — |
| 数据健康 `amzn_asin_health` | ✅ 六项都有分子分母，3 条「本仓没有来源」单列 | 秒 |
| 关键词发现 `amzn_keyword_discover` | ✅ 2 个种子 → 16 条（20 秒，真开搜索框读建议） | 20 秒 |
| 关键词覆盖 `amzn_keyword_coverage` | ✅ 已测 2 / 未测 14，分层 T3/T4 讲得清 | 秒 |
| 优化前置 `amzn_optimize_precheck` | ✅ 九道门逐门给判据、实测、分母、缺什么、去哪补 | 秒 |
| 健康报告 `amzn_report_build --dryRun` | ✅ 六项 + 逐项口径 + 3 条「本仓没有来源」 | 秒 |
| 排名扫描 `amzn_keyword_scan` | ⚠️ 能跑（8 词约 7 分钟，量到 1 个词有排名）但**查不了进度**（P1-1）、**计数器口径错**（P1-5） | — |

**这套工具的"诚实"是真做到位的**：`amzn_agent_metrics` 给不出的 7 项逐条写明缺哪张表哪一列；健康摘要把「扫过干净」与「从没扫过」分开；属性 0/43 明说「没人记过 ≠ 记了都是空」。这不是装饰，是这一版最有价值的部分。

---

## 二、问题清单

严重度：**P0 = 流程断掉/数据错**；**P1 = 会误导运营做无用功**；**P2 = 数据质量**；**P3 = 文案/细节**

### P0-1 两套关键词库之间没有桥，而报错文案说「库内没有关键词」

**现象**

```
amzn_keyword_discover        → 写入 16 条   （表 keyword）
amzn_keyword_query           → 16 条        ✅
amzn_kw_query                → 0 条         （表 kw_master）
amzn_kw_export（SOP 词表）   → 「US 库内没有关键词。先用 amzn_kw_import 导入文件。」
```

**为什么是 P0**：运营最自然的路径是「搜建议 → 测排名 → 导出标题/五点/后台词/广告/否定词」。
这条路径**在中间断掉**，而断点的提示语读起来是「你还没导入过任何东西」——
运营会去重新找 ABA 文件，而不是发现「词在另一个库里」。

**优化方案（两选一，建议 A）**

- **A｜补桥**：`amzn_keyword_discover` / `amzn_keyword_import` 写 `keyword` 表后，
  同步把词 upsert 进 `kw_master` 的 fact 层（`source=browser-local`，搜索量留 null 并标「无来源」），
  再 `kw_merge`。这样 SOP 导出这条链立刻通，且不伪造搜索量。
- **B｜只说真话**：`kw_export` / `kw_query` 的空态改成三态——
  「kw_master 为空」「keyword 表有 N 条但未并入 master」「两者都空」，
  并给出桥接命令。成本低，但运营仍要多一步。

---

### P0-2 属性采到了却不入库，而两道优化门因此永远过不去

**现象**（直读库，不是猜）

```
collection_section_result.attributes = collected 5/5
  {"attribute.fill_material":"Foam","attribute.pillow_type":"Furniture Cushion",
   "attribute.color":"Custom Color","attribute.size":"Cutom Size","attribute.brand":"ROFIEJOX"}

asin_field_source 里 attribute.* 行数 = 0
listing.attributes_json              = 不存在
```

于是：

- 门 3「属性 ≤30 天」降级 → 补数路径写「**重采一次 13 节详情**，刷新属性快照」
- 门 8「43 属性足够」0/43 降级 → 补数路径写「属性是事实，**采集拿不到**」

**这两句互相矛盾，而且照门 3 做没有用**：重采 100 次也不会写 `listing.attributes_json`，
因为采集侧根本没有这条写入路径。

**优化方案**

1. 采集成功后把 `attribute.*` 写入 `asin_field_source`（source=`browser-local`，带 `observed_at`）
   并汇总进 `listing.attributes_json`；
2. 门 8 的分母保持 43，但把文案改准：**「采集可补 5 项（fill_material/pillow_type/color/size/brand），
   其余 38 项必须人工或后台补」** —— 现在这句「采集拿不到」会让运营一次性放弃整道门；
3. 门 3 的补数路径改成真实可执行的那条（`amzn_asin_upsert` 补属性），不要写「重采」。

---

### P1-1 `amzn_collect_status(taskId)` 在关键词扫描任务上直接崩

```
amzn_keyword_scan  → 「用 amzn_collect_status 查 274e08a6-…」
amzn_collect_status(taskId="274e08a6-…") → error: task.fields.join is not a function
```

同一个工具查采集任务（`dfe7fd71`）正常。**关键词任务的 `fields` 不是数组**（null 或字符串），
而代码直接 `.join`。

**优化方案**：`Array.isArray(task.fields) ? task.fields.join('、') : '—'` 兜底；
且关键词任务该展示的是「第 3/8 个词：bench cushion」，不是 ASIN 字段列表 —— 两套进度单位不同，
建议按 `task.kind` 分支渲染。

---

### P1-2 任务列表自相矛盾

```
当前没有任务在跑。

最近 2 个任务:
274e08a6  browser-local  进行中  6/8
```

**优化方案**：表头判据改为「是否存在非终态任务」，或干脆删掉这句 —— 表格已经说了。

---

### P1-3 「采集方案」三处说法不一致

| 位置 | 说法 |
|---|---|
| `amzn_collect_preview` | 方案：（没有可用的 active 方案） |
| `amzn_collect_run` | 照样入队并跑完 |
| `amzn_collect_env_check` 08 | **warn** 还没有可用的采集方案（draft 方案不能选） |

**优化方案**：定一条规则并三处一致。建议「没有 active 方案 = 用该源的全量字段跑，
并在 preview 里写明这一句」，把 env 的 08 从 `warn` 降为 `ok`（因为它实际不阻塞）。

---

### P1-4 定制类商品的 `price` 是语义陷阱

真机实测：选择器 `#corePrice_feature_div .a-offscreen` 命中，解析出 **5.89 USD**。
选择器没错，页面就是这么显示的 —— 但这是**定制选项价/起价**，
而下游（定价诊断、竞品比价）会把它当真实售价。

**优化方案**：采集 `price` 的同时保存价格块的**原始文本**（如 `From $5.89`），
在 `asin_field_source` 里以 `price_text` 一并入库；健康摘要与定价诊断在
「价格原始文本含 From/起价字样」时降级为 `degrade` 并提示「这是起价，不是售价」。

---

### P1-5 关键词扫描的「写入 0」是采集口径的计数器，读起来像什么都没写

扫描跑完后 `amzn_collect_status` 显示：

```
274e08a6  browser-local  完成  8/8   写入 0   失败 0
```

但实际测量**全部进库了** —— `amzn_keyword_coverage` 随后显示「已测 8 条：
有排名 1（`custom bench cushion outdoor` 第 1 页第 32 位）／已测无排名 7」。

**优化方案**：按 `task.kind` 换列名与单位 —— 采集任务是「写入/失败（ASIN）」，
关键词扫描应是「有排名 / 无排名 / 未测（词）」。现在这个「写入 0」会让运营
以为跑了个寂寞，转头重跑一遍。

---

### P2-1 变体父体采不到 → `variations` 只能 partial

```
{"parent_asin":null, "variation_dimensions":["color_name","size_name"],
 "children":[7 个 B0…], "child_tiles":12}
```

子体 7 个、维度 2 个都拿到了，唯独 `parent_asin` 为 null。

**优化方案**：从 `#twister` 的 `data-parent-asin` 或页面内 `parentAsin` 变量取；
若本页确实没有父体标识，状态改为「页面没有」并说明，而不是 `partial`（partial 会被读成「抓漏了」）。

---

### P2-2 评论只拿到总数，抓不到内容

```
reviews: partial 1/4
{"reviews_total":41,"reviews_visible":null,"review_summary":null,"review_items":[]}
```

同批里 `aplus`（也需要登录态）**采到了**，所以这不是登录墙 —— 是选择器没命中。

**影响**：`review-pain` 优化模式没有输入，评论驱动的文案改进无法开工。

**优化方案**：改用 `#cm-cr-dp-review-list` / `[data-hook="review"]`；
若被登录墙挡住，状态应为 `blocked` 而不是 `partial` —— 这两件事的下一步完全不同。

---

### P2-3 `video` 里存了 `blob:` 地址

```
{"position":2,"url":"blob:https://www.amazon.com/97371b01-…"}
```

blob URL 出了那个页面就打不开，存进库等于存了一个假链接。

**优化方案**：采集时过滤 `blob:` / `data:` 协议，或标记 `usable:false`。

---

### P2-4 A+ 只采到图片，`text` 全是空白

`{"index":1,"type":"celwidget","text":"\n ","images":[...]}`

A+ 文案多数压在图上，这本身正常；问题是**库里看起来"有 A+ 文案"**。

**优化方案**：A+ 段落增加 `textIsEmpty: true` 标记，让下游能把「有图无文案」与「有文案」分开。

---

### P2-5 产品线没有自动归类

5 条产品线都有 signals（`bench-cushion` 含内置 9 词），标题是
「Custom Size **Bench Cushion**, 75D High Density Foam Filling」，但 `product_line_id` 为空，
导致门 1「对象明确」3/5 降级。

**优化方案**：采集入库后按 signals 跑一次分类（复用关键词那套 `classify`），
先 `dryRun` 报影响面，再写。

---

### P3-1 `unknown section(s): seo, signals` 不列合法 id

运营/agent 只能猜。**方案**：错误信息带上 13 个合法 id。

### P3-2 precheck「关键词已审核」说 16 个、只列 10 个

无省略号、无「等 N 个」。**方案**：超长列表补「… 等 16 个」。

---

## 三、没能走通的流程（及卡点）

| 流程 | 状态 | 卡在哪 |
|---|---|---|
| 发布登记 → 观测窗口 → 回滚 | 未走 | 需要真实在 Seller Central 发布过。插件只登记人工操作，**我不能伪造一条发布记录**（那会污染库） |
| 竞品分析 | 未走 | 需要竞品 ASIN 组成立；页面「关联竞品」采到 0 个 |
| 优化草案 → 校验 → 采纳 | 未走 | 前置 6 项降级，且需要人确认策略卡；这是设计上的正确阻断 |
| 规则导入 / 提示词改版 | 未走 | 会改全局规则集，属需人确认的动作 |
| 三个第三方源 | 不可走 | 未接入（商务） |

---

## 四、修复状态（2026-10-20 22:40 起）

| 编号 | 问题 | 状态 | 提交 |
|---|---|---|---|
| **P0-2** | 属性采到了却不入库，两道优化门永远降级 | ✅ **已修** | `30a8f2e` |
| **P0-1** | 两套关键词库无桥，空态文案说谎 | ✅ **文案已修**（桥接待定） | `da6ee42` |
| **P1-1** | `collect_status(taskId)` 查关键词任务崩溃 | ✅ 已修 | `30a8f2e` |
| **P1-2** | 任务列表头与表格自相矛盾 | ✅ 已修 | `30a8f2e` |
| **P1-3** | 「采集方案」三处说法不一致 | ⬜ 待做 | — |
| **P1-4** | 定制类 `price` 是起价不是售价 | ⬜ 待做 | — |
| **P1-5** | 关键词扫描的「写入 0」计数口径错 | ✅ 已修 | `30a8f2e` |
| P2-1..5 / P3-1..2 | 数据质量与文案细节 | ⬜ 待做 | — |

### 修了什么

**P0-2｜`30a8f2e`** 新增 `domain/collect/attribute-projection.js`，采集时把
`attributes` 节的 `attribute.*` 投影进 `asin_field_source`（带 `observed_at`）并合并进
`listing.attributes_json`。四条纪律逐条有测试：只补空缺 / 留来源与时间 / 只认
`attribute.` 前缀 / 占位值不投影（复用 43 属性门同一个 `isPlaceholderValue`）。

**证伪**：删掉「已有值就跳过」那道守卫后，人工确认的 `Navy Blue` 被页面的
`Custom Color` 冲掉 —— 断言是承重的。

同时改准两处会误导人的文案：门 8 原来说「属性**采集拿不到**」（现在是假话），
门 3 原来说「重采一次刷新属性与后台词」（后台词在前台页面根本看不到）。

**P0-1｜`da6ee42`** `kw_export` / `kw_query` 的空态改成三态，说清**空的是哪一本册子**、
另一本里有几条、以及要把词送进 SOP 词库走哪条路。**桥接本身没做** —— 那是设计决定，
见上一节方案 A/B。

**P1-1 / P1-5** 同一个根因：`fields` 这一列在 ASIN 任务里是「字段清单」（数组），
在关键词任务里是「扫描选项」（对象）。现在按 `kind` 分支渲染；关键词任务的计数器
从「写入/失败」换成「有排名/无排名」—— 原来印「写入 0」让人以为白跑。

**P1-2** 列表头的主语（采集器）与表格的主语（库里的行）分开说。

### ⚠️ 需要重启才生效

**运行中的 Host 实例仍是旧代码**（插件按绝对路径加载，只有重启宿主才会重载模块图）。
需求方已于 2026-10-21 01:0x 重启，实测见下一节。

---

## 四之二、重启后的实测（2026-10-21 01:0x）

**这一节是读数，不是承诺。** 重启后重采 `B0GV55Q4JG`：

### 属性：5 → 25 条

| 指标 | 修前 | 修后 |
|---|---|---|
| `attributes` 节采到的标签对 | 5 | **31** |
| 写入 `asin_field_source` 的 `attribute.*` | **0** | **25** |
| `listing.attributes_json` 的键数 | 无快照 | **25**（`origin=snapshot`） |
| 43 项必填属性覆盖 | **0/43** | **17/43** |

命中的 17 项：`brand` `manufacturer` `recommended_uses` `fill_material` `cover_material`
`color` `size` `item_thickness` `shape` `pattern` `style` `item_firmness`
`number_of_items` `indoor_outdoor_usage` `age_range` `care_instructions` `special_feature`

还缺 26 项 —— 页面确实没有，或需要语义判断才能映射（例如页面只写
`Item Dimensions L x W`，而声明要的是 `product_dimensions`；这两者不是一回事，
硬映射就是替页面编了一个它没说的尺寸）。

### 两道门真的动了

| 门 | 修前 | 修后 |
|---|---|---|
| 3 属性 ≤30 天 | 0/2 快照 | **1/2**（属性快照 0 天、在 30 天内，只缺后台词） |
| 8 43 属性足够 | 0/43 | **17/43** |

门 3 的补数文案现在说的是真话：属性那份可以重采刷新，
**后台搜索词不在采集范围内**（它在 Seller Central 后台，前台页面看不到）。

### 顺带验掉 P1-1，并又抓到两处（`6f59b1b` 已修）

拿走查时崩过的关键词任务 id 复测 `amzn_collect_status`：不再崩，
「扫描设置 / 扫描 8 个词 · 有排名 1 · 无排名 7」都对。同一屏又暴露：

- **逐目标结果 8 行全空** —— 关键词任务的结果行没有 `asin/status/fields`，
  照采集的列渲染就是八行空。八行空白会让人以为"什么都没扫到"，
  而实际是 1 个词有排名、7 个没有。
- **「其中 true 个目标在采集前调整了配送地址」** —— 这个值在关键词任务里是布尔，
  不是计数；`true > 0` 成立就印成了「true 个」。

---

## 五、给运营的一句话结论

**这版插件"采集 → 看清 → 判断缺什么"已经能用了，而且说得比大多数工具诚实。**
断在两处**衔接**上：

1. **词从哪来**（发现词进得了 `keyword`，进不了 SOP 用的 `kw_master`）
2. **属性从哪来**（采得到 5 条，却写不进 `listing.attributes_json`，而两道优化门卡在这里）

这两处不接上，运营走完一遍会得出「工具说缺，我按它说的补了，还是缺」的结论 ——
这比直接说「做不了」更伤信任。

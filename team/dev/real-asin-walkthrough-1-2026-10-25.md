# 真实 ASIN 全模块实测 · 第一轮 · 2026-10-25

> 需求方指令：「用真实的 asin 数据测试各个模块的功能、流程，发现优化点，bug 则给出方案进行修正」。
> 方法：直接调本仓的真实工具（不是模拟、不是测试夹具），对象是库里的真商品
> `B0GV55Q4JG`（US / ROFIEJOX / Custom Size Bench Cushion）+ 从真实关键词事实反查出的竞品。
> 采集任务 `b4fb2658-e13f-4285-8673-002a607e6665` 已提交（4 个 ASIN，browser-local，真开浏览器）。

## 一、跑了什么（按模块）

| 模块 | 动作 | 结果 |
|---|---|---|
| 数据源 | `amzn_source_list` 的环境体检 | ok 7 / warn 1 / fail 0 / unknown 2 |
| ASIN 库 | `amzn_asin_query` | 1 条（全库已归档 0） |
| 竞品 | `amzn_asin_competitor discover`（**只读预览**） | 8 个候选，证据带「几个词 / 最好名次 / 最好的那个词」 |
| 采集 | `amzn_collect_preview` → `amzn_collect_submit` | 预览 4 目标 / 4 请求 / low 风险；提交后真在跑 |
| ASIN 健康 | `amzn_asin_health`（F05-07 六项） | 6/6 取到判据，另有 **3 条「本仓没有来源」** |
| 优化 | `amzn_optimize_precheck` 的九门 | **3 通过 / 6 降级 / 0 阻断** |

## 二、发现（按「会不会误导人」排）

### R-1 · 判据被当成结论印出来，同一屏两句话打架 —— **P2，已修**
`amzn_asin_health` 的「优化前置」那一格实拍：

```
属性 ≤30 天        degrade   | 属性与后台词两份快照都在 30 天内
搜索量 ≤90 天      degrade   | 16 个关键词的搜索量观测都在 90 天内
关键词已审核       degrade   | 16 个关键词都已有审核痕迹或本轮声明已审核
```

**而同一屏的 `missing` 说**：「后台词快照不存在」「16 个词没有搜索量」。

判据是**要满足的条件**，写成陈述句「两份快照都在 30 天内」，和实测结论并排一印，
**读起来就是「都符合」** —— 可它明明是 `degrade`。
根因：`src/domain/asin/health.js` 的 breakdown 直接 `note: gate.criterion`。

**修法（已落）**：新加 `gateNote(gate)` —— **优先印实测**（`3/5 项符合 · 缺：店铺、产品线`），
没有实测值时才退回判据，且明写「判据：」。判据和结论不能长得一样。

### R-2 · `amzn_collect_submit` 的参数契约不一致 —— **P1，待复现**
`amzn_collect_preview` 接受并正确解析了：

```json
{"marketplace":"US","selfAsins":["B0GV55Q4JG"],"competitorAsins":["B0DS49VC81",…]}
```

同参数交给 `amzn_collect_submit` 却**报错**：
> `no targets: pass targets=[{asin, marketplace}] or asins=["B0…"]`

换 `targets=[{asin,marketplace}]` 后立刻成功。
**两个工具处理「同一批目标」的方式不一样**，而且 submit 的报错只提 `targets`/`asins`，
**不提 preview 已经接受的 `selfAsins`/`competitorAsins`**。
人照着 preview 的形状提交会失败，然后照着错误提示改参数——**典型的「两个入口长一样但不认一样的东西」**。

**方案**（尚未实施）：二选一
- (a) `amzn_collect_submit` 也接受 `selfAsins`/`competitorAsins`（与 preview 对齐，同时保留 side 归属）；
- (b) 保持只认 `targets`，但**报错文案必须点名那两个参数名**：「preview 支持 selfAsins/competitorAsins，submit 只支持 targets」。
我倾向 **(a)**：两个工具对同一批目标给出不同的形状，迟早有人猜错。

### R-3 · 「规则风险 0」和「从来没扫过」长得一样 —— **不是 bug，是本仓口径**（已诚实标注）
健康摘要自己写明了：
> `dq_issue` 只存**发现**，不存一次扫描本身 —— 所以「0 条问题」既可能是「扫过、干净」，
> 也可能是「从来没扫过」，本仓分不开。

**处置：不动**（补一张 `dq_scan` 表是新表，不在本轮范围），但**已进「本仓没有来源」清单**，
不许任何人把那个 0 读成「没有风险」。

## 三、真实数据暴露的业务缺口（不是 bug，是「该补的东西」）

`B0GV55Q4JG` 的九门是 **3 通过 / 6 降级 / 0 阻断**，六条降级**每条都指向一件具体的活**：

| 缺什么 | 实测 | 怎么补 |
|---|---|---|
| **产品线归属** | `product_line_id` 是核心 10 列里唯一缺的 | 设置/ASIN 表里记一条归属（v69 已经能写了） |
| **店铺归属** | 无 `asin_ownership` 行 | 同上 |
| **43 属性** | **17/43**，空 26 项（item_type / material / product_dimensions / item_weight …） | 优化草案补属性，或采集属性节 |
| **后台词** | `listing.search_terms` **不存在** | 优化流程里的后台词字段 |
| **搜索量** | **16 个词全部没有搜索量** | 需要第三方源（卖家精灵/西柚）—— **本仓没有来源** |
| **竞品组** | US 站点**没有任何竞品组** | 用上面反查出的 8 个候选建一个（`write: true`） |

**这一栏的价值**：它把「6 条降级」翻译成了运营看得懂的六件事，而不是六个技术标签。

## 四、顺带记下的两条「做得对」的口径
- 新鲜度把 `unknown` 拆成**「无阈值」**（不在 7/30/90 表里）与**「有观测时间未知」**（有人记过值但没记时刻）——**修法不同，所以不能合**；
- 「43 属性完整率」明说：**`listing.attributes_json` 的唯一生产写入方是草案采纳，采集侧没有写属性的路径** —— 所以它**不能**被说成「页面采集的覆盖率」。这条写进了「本仓没有来源」。

## 五、下一轮要跑的
关键词管道（`amzn_kw_pipeline_run` dryRun）、优化全流程（九门 → 策略 → 草案 → 校验）、
发布登记 → 观测、报告生成、竞品四象限（需先建竞品组）。

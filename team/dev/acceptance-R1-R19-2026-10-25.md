# 真实 ASIN 实测 · 验收清单（R-1…R-19）· 2026-10-25

> **这份清单的用法**：不看结论，看第三列。每一条都写了「别人怎么独立验一遍」，
> 命令可以照抄、代码位置可以点开。**能被独立复核的才算修好。**
>
> 基线：全量 `2775 passed / 0 failed`（HEAD `329d2bf`），真实对象 `B0GV55Q4JG`（US / ROFIEJOX / 坐垫）。
> 全部 19 条都来自**直接调用生产工具**，不是跑测试夹具。

## 一、怎么用这份清单

```bash
cd C:\Users\win11\dsh-plugins\amazon-ops
node tests/run.mjs                    # 期望 2775 passed / 0 failed
node scripts/check-page.mjs           # 期望 3/3 passed
node tests/t8[5-9]-*.mjs              # 逐个跑，每个都应 0 failed
node tests/t9[0-2]-*.mjs
```

---

## 二、十九条，逐条

| # | 严重度 | 改了什么 | 证据（代码位置 / 提交） | **别人怎么独立验** |
|---|---|---|---|---|
| **R-1** | P2 | 健康摘要把**判据**当结论印（`degrade` 旁边写着「都属于 30 天内」） | `health.js` 的 `gateNote()` · `71d82e6` | 跑 `amzn_asin_health`，看「优化前置」每一项的 `note` —— 应当印 `3/5 项符合 · 缺：…`，不是陈述句 |
| **R-2** | P1 | `preview` 收 `selfAsins/competitorAsins`，`submit` 只收 `targets/asins` —— 照预览提交会失败 | `tools/collect.js#buildTargets` · `71d82e6` | `node tests/t85-collect-targets.mjs`（9 条，含四种形状互通 + 去重 + 源码守门） |
| **R-3** | P2 | 空值留白让「整列为空」的列视觉塌陷 —— 我自己把竞品排名读成了我们的排名 | `tools/render.js#table` 空值印 `—` · `ea9e9a2` | `node tests/t87-table-empty-cell.mjs`（6 条；③ 直接钉「竞品排名不许落进我们排名列」） |
| **R-4** | P1 | `当前文案 (空)` —— listing 表空被印成「商品页没有文案」 | `tools/optimize.js` prepare 的标题段 · `a636d03` | 跑 `amzn_optimize_prepare(dryRun)`，若 listing 无标题而 `asin.title` 有值，必须多印那三行警示 |
| **R-5** | P2 | `20260314-20160412`（结束早于开始）被原样印进报告 | `domain/keywords/period.js#describePeriods` · `e50b9ef` | `node -e "import('./src/domain/keywords/period.js').then(m=>console.log(m.describePeriod('20260314-20160412')))"` → `state: 'impossible'` 且带 note |
| **R-6** | P2 | 规则页「出处: SOP §3.3」与「有判定无文档」并列，像自相矛盾 | `tools/rule.js` 缺口段 · `5087815` | 跑 `amzn_rule_list`，缺口段下面必须有三句解释 + 一个能自证的例子 |
| **R-7** | P2 | 7 个「值来源没实现」的变量混在提示词注册表里（5 个标必填） | `tools/prompt.js` 变量表后 · `5087815` | 跑 `amzn_prompt_list`，必须有一节 `⚠️ 这 N 个变量的值来源还没实现`，且**是自动算的**（改 `source` 就消失） |
| **R-8** | P1 | 失败的 Agent 运行把原因留在库里、列表只印一个词 | `store/agent.js#listRuns` 补 `error` + `tools/agent.js` 状态列 · `7d8fe67` | 跑 `amzn_agent_run_list`，`failed` 那行必须带 `（错误: …）`；对照库里 `agent_run.error` 是否一致 |
| **R-9** | **P1** | 产品线分类器教人**写缓存**（门槛永远不动、下次同步抹掉） | `tools/product-line.js` 收尾 · `f2ff90b` | ① 跑 `amzn_product_line_classify` 看收尾是否指向 `amzn_asin_ownership_set`；② 写一次 `asin_upsert.product_line_id` 再跑 `syncProductLineCache`，值应被抹回 null |
| **R-10** | P1 | 建店铺这条路 **agent 走不了**（只有页面路由） | 新增 `src/tools/shop.js#amzn_shop_upsert` · `0d5014d` | `node -e "import('./src/tools/shop.js').then(m=>console.log(typeof m.shopTool))"`；或重启后调 `amzn_shop_upsert {action:'list'}` |
| **R-11** | **P1** | 第 1 门「店铺」是**死格** —— `asin_ownership` 不收 shop，门槛却只读它 | `domain/optimize/precheck.js#gateObject` 加 `product_profile.shop_id` 兜底 · `7749b56` | 用一个没有 `product_profile` 行的 ASIN 跑 precheck（第 1 门缺店铺），写一条 `product_profile` 再跑 → 3/5 变 4/5 |
| **R-12** | P1 | `product_profile` 只能靠 xlsx 写（agent 走不到） | `amzn_product_import` 加 `action:'upsert'` · `3304f4d` | 调 `amzn_product_import {action:'upsert', asin, shopId, brand, marketplace}`；重复调两次，行数仍为 1（幂等） |
| **R-13** | **P1** | 后台词「采集不到可以空，**优化后不能空**」—— 空串原来算有内容 | ① `validate.js` 字段完整性门认 blank；② `tools/optimize.js#nullIfBlank` 四个字段 · `4b0f6db` `32b0cb9` | `node tests/t89-backend-terms-gate.mjs`（11 条：undefined/空串/纯空白全部 FAIL，有内容才过；⑦ 实测空串会覆盖旧值） |
| **R-14** | P2 | 「0 个词各有唯一主人」被判 PASS —— 没有输入被画成通过 | `validate.js#keyword_allocation_unique` 加 `unverified` · `df6dd4a` | `node tests/t89-*.mjs` 的 ⑨⑩⑪ 三条 |
| **R-15** | P3 | 观测窗口印成「30 秒」，读者会以为算错 | `tools/observe.js#windowLine` · `982a7ab` | 刚登记发布就查 `amzn_observation_check`，窗口那行下面必须多一句「窗口只有 N 秒 —— 因为…」 |
| **R-16** | P1 | 「修好了、问题还挂着」（报告说标题空，实际已写好） | `store/quality.js#runQualityScan` 返回 `notSeenAgain` + `tools/quality.js` 印出来；**不动状态** · `54ba294` `c2b6c97` | `node tests/t90-dq-not-seen-again.mjs`（4 条；② 状态必须仍是 open，③ 人标 resolved 后不再提醒） |
| **R-17** | P2 | 「正常」把「算出来了」读成「合格」（17/43 和 6/9 都印正常） | `health.js` 的 `ok` 标签改「已取得」 · `64a158e` | 跑 `amzn_asin_health`，六项第一列应为「已取得 / 从没记过 / 本仓没有来源 / 取不到判据」，**不含「正常」** |
| **R-18** | **P1** | 竞品组被两处 short-circuit 废掉 —— 报告说「无从对比」，四象限能算 1,432 条词 | `domain/asin/competitor.js`：去掉 `if (!containsThis) continue`、判据改用 `allSets` · `2a479b0` | `node tests/t91-competitor-peers.mjs`（5 条；③ 组成员全是别人时必须算出对端） |
| **R-19** | P2 | 「还没到期」被印成「已经到期或即将到期」 | `domain/reports/build.js` 按 `nextDue.status` 分两组 · `281cea5` `329d2bf` | `node tests/t92-reports-due-wording.mjs`（4 条；④ 源码守门） |

---

## 三、这一类「批量」的独立验法

上表 19 条里有 **11 条**属于同一族：**把「X」印成「Y」**。它们的共同验法：

```bash
# 1) 全量绿 — 这是必要条件，不是充分条件
node tests/run.mjs | tail -1

# 2) 每个新守门自己要有反面控制 — 把它们故意弄坏，必须红
#    例：把 render.js 的空值占位改回空串 → t87-① 必须红
#    例：把 validate.js 的 blank 判据改回 === undefined → t89-② 必须红
#    例：把 competitor.js 的 continue 加回去 → t91-③ 必须红

# 3) 越过守门直接看生产输出
#    报告类：amzn_report_build(kind=…) dryRun
#    工具类：直接调该工具，看那些句子
```

**第 2 步是这份清单里最重要的一步。** 今天我自己写出过 4 条「永远绿」的假断言
（t87-② 空转、t85 软尺子、t88 恒真判据、t83 钉错名字），
**全部是靠「把实现弄坏、看它红不红」这一招抓出来的。**

---

## 四、我自己的事故（一并列出，供复核者判断可信度）

| # | 事故 | 怎么发现的 | 后果 |
|---|---|---|---|
| 1 | 整文件写坏（859 行 → 26 行） | **`node --check` 是绿的**，靠查文件大小才发现 | 已 `git checkout` 恢复 |
| 2 | 按行删除多删一行（`export const … = {`） | `node --check` 抓到了 | 已恢复 |
| 3 | 改了被测试钉死的语义边界（dq 自动关闭） | `t6-variant-dq:524` 红 | 已回退，改成只报告 |
| 4 | 又改了被钉死的边界（health 加 `attention` 档） | 两条测试红 | 已回退，只改标签 |
| 5 | 注释里复述已删文案，被自己的守门打红 | `t92-④` 红 | 已改写注释 |
| 6 | 报了假的「D-1…D-4 已清零」 | 复验席逐行读渲染行文 | 已真清零并给守门 |

**共同点：每次都是「检查手段通过了，而被检查的东西已经不对了」。**
所以这份清单的第三列全部要求**独立复核**，而不是引用我的说法。

---

## 五、还没做的（如实列，不混进上面）

1. **D-5**（`policy.js:113` 「右侧选一条关联」）—— 判不出是面板内布局还是右栏残留，**没猜**；
2. **`product_profile.parent_asin` NOT NULL** —— 单 ASIN 商品存不下「我没有父」，现在靠自指 + `parentSelf` 标记；
3. **写 `product_profile` 仍需重启后才有工具入口**（`amzn_product_import` 的 `upsert` 已提交，当前会话加载的是旧插件）；
4. **9 门剩 2 条降级**：搜索量（需第三方源）、43 属性（事实不能猜）—— **都不是代码问题**。

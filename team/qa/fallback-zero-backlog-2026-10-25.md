# `|| 0` 兜底清理台账（2026-10-25）

> 来源：dev-8 盘出 25 条违例 / 29 条待定 / 470 条合法（原始扫描在工作区 `team/qa/`）。
> 本文记**逐条去向**。规矩：每条只有三种归宿——**已修 / 判为误报（给理由）/ 待修（给风险与单号）**，
> 不许有第四条「看着不顺眼但没管」。
>
> **2026-10-25 修订**（独立复验席核对后）：补 T-3 / T-4a / T-4b / T-5；修正「已修」里对
> `rankedCount` 的过度声明；T-1 补全第二条改法。**原判不涂改**——被推翻的地方在原文下加
> 「⚠️ 复验席更正」。

## 一、已修

| 编号 | 位置 | 改法 |
|---|---|---|
| 6–9 | `optimize/validate.js` 三道闸门 | 缺 `plan`/`validation` → `pass:false` + **`unverified:true`** + 「这一关没有执行（不是通过）」 |
| 14 | `keywords/importers.js:300` | 搜索量缺失 → `null`（**端到端成立**：下游 `COALESCE` 保住 null） |
| 15–18 | `reports/spend-monthly.js` | 逐字段 `numericOrNull`；月桶带 `missing{}`；`roasReason` 区分「没数据」与「花费为 0」 |
| **T-3** | `kw_ad_fact` + 导入端 + 月报 | 见下节——**已修到写入端，端到端成立**（迁移 v67） |
| 1 | `optimize/report.js:221` | 评论数缺失 → 「—」不印「0 条」 |
| 2 | `optimize/plan.js:501` | 同上 |
| 3–4 | `keywords/export.js:389/390` | 无花费/销售额数据 → 「—」不印 `$0` |
| 19–22 | `keywords/competitor.js:110/114`（**`buildCompetitorDiff` 那一支**） | `rankedCount/presentCount` 保留 `null` |
| 23 | `keywords/competitor.js` `classifyQuadrant` | 竞品侧计数为 `null` → 判 `unmeasured` |

> ⚠️ **复验席更正（2026-10-25）**：上面 19–22 只对 **`buildCompetitorDiff`** 成立。
> **`quadrantRows`（`:377/378`）仍是 `Number(their?.rankedCount ?? 0)`**，而四条生产调用方
> 全走 `quadrantRows`。所以「竞品未测不判优势」**在生产路径上没生效**——
> 半真的「已修」比漏记更危险，故单列为 **T-4a**。
> 同样，23 的 null 分支在生产路径上不可达（行上永远拿不到 null），属**防御性分支**。

## 二、判为**误报**（1 条，后经复验席部分推翻）

| 编号 | 位置 | 我的原判 |
|---|---|---|
| 10 | `collect/env.js:706` `blocked ?? 0` | 判「不是违例」：读不到浏览器状态时不拦是刻意宽松；主动要求绕过验证码那一路仍拒绝 |

⚠️ **复验席推翻了一半**：`diagnostics.blocked` 是**进程级累计计数**
（`collector.js:117` 初始化、`:445` 只增、`:673-678` 的复位清单里没有它）→
进程里被拦过一次之后，连 `mkdir`（与验证码无关的纯文件动作）都会被永久拒掉，
文案还说「目标页是验证码页」。→ 改成 **T-1**。

## 三、待修

### T-1 · `repairRefusal` 把「验证码拦过一次」变成永久拒绝 —— ✅ **已修（P0，2026-10-25）**

**第 (1) 条：`blocked` 按轮次**
`collector.js` 加局部 `let blocked = 0`，`:445` 改局部自增，`:673-678` 写回 `diagnostics.blocked`
（累计值保留给诊断展示）。**只做这条不够**——重跑一轮归零后，这一轮再被拦，下一条 `mkdir` 还是被拒；
「这一轮被拦过」与「现在不能 mkdir」之间没有因果关系。

**第 (2) 条：把「读不到」与「读数是 0」分开（`env.js`）**
`snapshot === null || typeof snapshot.blocked !== 'number'` → **状态未知**，不许当 0：
- `mkdir` / `launch_browser` / `reconnect_port` **放行**（三个都不打开站点页面）；
- `set_context` **拒绝** —— 它是唯一真会 `navigate` 进 Amazon 并操作配送地址对话框的动作，
  风控状态未知时进站是四个里唯一有代价的。

> 只做 (1) 不做 (2)，`?? 0` 那个原始缺陷点还在。**必须两条一起。**

### T-2 · `spend-monthly.js` 的 `undated` 分支 —— ✅ **已修（2026-10-25，dev-10）**

无日期行的 `spend` 是读数 `0`，没有缺失标记（**载荷里的潜在谎言，尚未上屏**：
`pages/report.js:274-277` 只读 `undated.length`，但 `/api/state` 的 `spendMonthly` 原样带着它）。
已改 `spend: null` + `spendMissing: boolean`，与 `monthly` 同口径。
**为什么不用 `missing:{}`**：本文件里 `missing` 专指月桶的**行数计数**，同行同名不同义会误导。

### T-2 附 · 同批的展示层第三态（dev-10，同一类病）
| 位置 | 原状 | 改后 |
|---|---|---|
| `optimize/report.js` 埋词完成率 | `fillRate` 缺失 → `ok:false`，「未测」被读成「不达标」 | `{ok:false, unverified:true, result:'—'}` |
| 同上 · 「事实一致」自检 | `conflicts?.length ?? 0` + `=== 0`（同形兄弟） | 同一三态 |
| `keywords/pipeline.js` `rowsRead` | `?? 0` | `rowsReadOf()` → 数或 `null` |
| `optimize/plan.js:781` `fillRate` | 没有计划落点 → **`1`（满分）** | `null`（「这一轮没有可判的分母」），两处工具渲染印「不判读」 |
| `web/pages/kw.js:451` | 直接印 `fillRate`（会印 `null`） | 印「不判读」 |

⚠️ **`rows_read` 仍装不下「没记到」**：`NOT NULL DEFAULT 0` + `recordImport` 的 `Number(...)`，
`null` 到库里仍是 `0`。**13 号只到函数级，不是端到端**（同 T-3 的形状，待迁移 v68）。

### T-3 · `kw_ad_fact.spend` 装不下「没有数据」 —— ✅ **已修（端到端）**

`spend/sales` 是 `REAL NOT NULL DEFAULT 0`，改可空要重建表（本仓明确「不重建表、不删列」）。
采用**加列记缺失**：迁移 **v67** 加 `spend_missing` / `sales_missing`（纯 ALTER），
导入时源单元格为空置 1，月报据此计数。
`t73h` 4 条断言走**真链路**：导入 → 落库 → `spendReport`。
⚠️ 口径：`_missing = 0` 只意味着「没记到缺失」，**不等于数据完整**——迁移前的老行一律 0。

### T-4a · 竞品象限的**语义**：对端未测该不该判「自有优势」 —— **待拍板**
`quadrantRows:377/378` 把「对端无事实」写成 `0` → `classifyQuadrant` 判 `ownAdvantage`；
同一行 `no_data:true`，页面右格印「该词无竞品数据」——**一行自打脸**。
修它要改 **2 条已评审的字面断言**：`b05d-tabs.mjs:404-410`（`counts.ownAdvantage===1`）、
`cr1-quadrant-card.mjs:127`（字面串 `'1|0|1|1|0'`）。**这是产品口径变更，不是 bug 修复。**

### T-4b · 竞品象限的**自洽**：一行不许说两句矛盾的话 —— ✅ **已修（2026-10-25）**

做法（按复验席建议，**一个已钉字面量都没碰**）：
- `classifyQuadrants` 多返回派生计数 `noDataByBucket` / `noDataTotal`
  （= `row.no_data === true` 的行数，按桶分）。**只加字段，不改任何归属**；
- 页面新开一个 cell `cr1-unmeasured-note`，只在计数 > 0 时渲染，明说
  「本页 N 条词的对端未测量 —— 不是『他们没上榜』，是『没测过』。仍按现有归类显示，归类口径待定（T-4a）」；
- `cr1-bucket-label`（桶名串）、`cr1-bucket-count`、`competitor-quadrant`（逐词标签）
  **一个字节没改** —— 那三处是 `cr1-quadrant-card.mjs` T1 与 `b05d-tabs.mjs` W4 按字面钉住的。

配套 `t73i` 4 条断言，其中一条专门钉「归属一个字没改」：`counts.ownAdvantage` 仍是 1、
`classified === inputTotal`、逐词 `quadrant_label` 仍是「自有优势」。

### T-5 · `storefrontMiss` 同形缺陷 —— ✅ **已修（2026-10-25，与 T-1 同批）**
`collector.js` 原来把**进程级累计**的 `storefrontMiss` 写进本轮 `result` → 同进程第二次采集会带上次的数。
已加 `storefrontMissThisRun`（每轮复位）并让 `result.storefrontMiss` 读它。
⚠️ 原判「静态证据、未实测」保留：没有跑两轮真采集，**只到代码与单测层面**。

### 其余（低优先）
| 号 | 位置 | 风险 | 状态 |
|---|---|---|---|
| 5 | `optimize/report.js:1317` 埋词完成率 | 中：`fillRate` 缺失时 `ok:false`，「未测」被读成「不达标」 | ✅ 已修（第三态 + `planFillRate` 单一入口） |
| 11–12 | `sources/collection.js:1135/1136` | 中：`written ?? 0` → 未知判成 `failed`/`partial` | 待修 |
| 13 | `keywords/pipeline.js:173` | 低：`rowsRead ?? 0` | ✅ 函数级已修（**库里 `NOT NULL DEFAULT 0`，端到端未成立**，待 v68） |
| 24 | `asin/sections.js` + `collect/detail.js` | 中：没有节行时伪造 `{collected:0,total:N}` | ✅ 已修（含 `missingFields: [] → null`） |

> ⚠️ **24 的定位要更正**（dev-11 盘点 151 处消费方后实测）：`sections.js:161` 那个 `??` 是
> **结构上不可达**的（`sectionValueCounts` 只对「id 不在 13 节词表里」返回 null，而 id 全来自
> `COLLECTION_SECTIONS`）。**真正上屏的伪造在它上面的 `row === null` 早退分支
> （`sections.js:142` / `detail.js:96`）**。两处都改了。下一个人别去修那条不可达的分支，
> 以为修完了。
>
> 盘点结论：12 个读这两个字段的消费方里，**只有 `tools/collect-center.js:605` 会印错**
> （直接拼 `collected/total` → 印 `null/5`），已加守卫；页面两处本来就有 `Array.isArray` 短路。
> **没有任何一处对 `collected` 做算术**，所以改 null 不会算错，最坏是印错。

**24 / 25 的共同风险**：把「没有这一节」与「采到 0 个字段」区分开，会改变页面与工具的判定分支。
改前先列消费方（`grep sectionValueCounts` / `collected`），否则会把这两者的区分——也就是这批要保护的东西——反而搞混。

## 四、复验席追加的两条（**原 25 条之外的新发现**）

> 我宣布「台账全清」之后，复验席当场证伪：**`compactResult` 是同一类「缺失写成 0」，它不在那 25 条里。**
> 所以「全清」这句话当时不成立——记在这里，不涂改。

### T-6 · `compactResult` 把 `deriveStatus` 刚做的区分塌回去了 —— ✅ **已修**
`collection.js` 里 `deriveStatus` 因为「通道没报数」判 `partial`（我们不知道），
但同一行的 `compactResult` 写 `written: result.written ?? 0`（它写了 0 条）——
**状态列说「不知道」，存下来的结果说「就是 0」**，读 `result_json.written` 的下游看到的是 0。
改：`attempted / written / failed / selectorMiss / sectionsWritten / sectionCorrections`
一律 `countOrNull()`（知道数才写数，不知道写 null）。
`missingFields` / `sectionErrors` 是列表，`[]` 的语义另算（T-24 已处理）。

### T-7 · 采集窗口每天必红一分钟，且**没有任何可表达的窗口是整天开的** —— ✅ **已修**
`window.js` 判据是 `localTime < to`（右端**开**区间），所以 `00:00–23:59` 每天
23:59:00–23:59:59 必然关闭；而 `24:00` 被正则拒掉 → 最长只能表达 1439/1440 分钟。
**生产侧同样受影响**（`sources/collection.js` 用它判计划窗口）。
复验席 07:58 起跑正好撞进那一分钟：**同一棵树它拿到 2536/1，lead 拿到 2537/0** ——
所以那条断言原先不是「树的属性」，是**抽奖结果**。
改：`to` 多接受 `24:00`（`HH_MM_END`，三处校验同改：`window.js` / `collection-plan.js` / `scheme.js`），
`from` 仍不许 24:00。**右端开区间语义没动**（`T73o-②` 专门钉住它，免得修「整天」时被顺手改成闭区间）。
`T73o` 5 条用**固定时刻**，不再依赖「跑的时候几点」。

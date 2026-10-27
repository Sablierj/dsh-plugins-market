# Amazon Ops · 模块对齐审计（14 模块 × 需求设计文档 v2.0）

> ## ⚠️ 订正页（2026-10-13，产品经理 PM）—— 先读这一页，再看正文
>
> **订正人**：产品经理（PM，兼需求调研口径）｜ **状态**：订正中（正文已就地标注）｜
> **关联需求编号**：台账 `docs/COORDINATION.md` §7.3 的 **D3 / D4 / D5 / D6** 四行｜
> **证据等级**：本页每一条都是 **`verified`（2026-10-13 本机实测复核，附命令与行号）**。
> ⚠️ 其中 **D5 / D6 两行是「用户裁决」而不是「事实证伪」** —— 它们推翻的是**需求字面口径**，
> 不是本报告对当时 HEAD 的事实陈述。
>
> 本报告写于 `HEAD = 70120ef`（2026-10-03，schema v32、TOOLS 67）。此后仓库前进了 30+ 个提交，
> **下列 6 条结论已被实测证伪**（D3-1…D3-5、D4）。原文按本仓纪律**不删除**（保留可追溯的错），
> 在每条后面加 `⚠️ 订正` 标注，并在此处集中列出。
>
> **2026-10-13 追加两行 —— 这两行不是「事实证伪」，是「产品口径裁决」**：
> 用户在同一天对两条需求字面口径做了裁决（F05-08 归档后「隐藏」、F05-06「父体从采集得到」），
> 两条都**推翻了需求字面**。它们按同一条纪律就地订正（原文不删）。
>
> | # | 原文断言 | 原文等级 | 订正后等级 | 证伪（本机实测，2026-10-13） |
> |---|---|---|---|---|
> | D3-1 | `registerSnapshot` 在 `src/` 下**零调用方** | `documented` | **`stale`** | **5 处生产调用方**：`store/queries.js:487`、`store/queries.js:1328`、`store/kw.js:474`、`store/kw.js:915`、`store/prompt.js:807` |
> | D3-2 | `upsertFieldSource` **无生产调用方** | `documented` | **`stale`** | **2 处生产调用方**：`store/queries.js:247`（`upsertAsin` 内）、`store/asin.js:141` |
> | D3-3 | `upsertAsin` **不写** `observed_at`/`source_type`；`manual` 来源无写入路径 | `documented` | **`stale`** | `queries.js:247-262` **显式传** `sourceType`（`:258`）与 `observedAt`（`:261`）；`field-source.js:91-96` 在调用方未给时按 source `kind` 推（`deriveSourceType` 定义在 `:154`） |
> | D3-4 | `attributeCoverage` **全仓无调用方** | `documented` | **`stale`** | **4 处生产调用方**：`domain/optimize/precheck.js:685`、`domain/rules/listing-rules.js:1231`、`domain/optimize/validate.js:495`、`domain/optimize/report.js:325` |
> | D3-5 | 「模块 08 未建，所以 13 无法继承位置计划」 | `documented` | **`stale`** | 位置计划持久层 **schema v35 就已建**：`store/schema.js:2358-2362`（迁移 `version: 35, name: 'keyword-plan'`）、`:2397` `keyword_plan`、`:2415` `keyword_plan_entry`；`store/keyword-plan.js`；五个工具 `tools/kw-plan.js:49/91/145/205/274`；页面「存一版」路由 `web/routes.js:1832` |
> | D4 | 「优化前置是否满足」本仓**没有来源** | `documented` | **`stale`（口径错）** | **有来源**：`precheckFor`（`tools/optimize.js:364`，内部调 `evaluatePrecheck` `domain/optimize/precheck.js:771`），且 `domain/asin/health.js:119-120` 已把这一点写在源码里 |
> | D5（裁决） | F05-08 字面「归档后隐藏/只读/禁写」 | `documented`（需求字面） | **裁决：保留现状 `all` + 三态筛选** | 用户裁决（2026-10-13）。归档行**显示并逐行标「已归档」**，不隐藏；`hide` 由调用方说出来。实现位置（本次实测）：`store/queries.js:336-363`（三态 + 默认为 `all` 的理由原文）、`:517-542`（三格读回对账 `archived`/`archivedHidden`/`archivedTotal`）、`web/page.js:745-749`（`#asinArchived` 三态控件）、`:8570`（`id="asinArchivedScope"` 口径行）。两处读者早就落地相反口径：`domain/asin/table.js:292-295`、`tools/asin.js:145-146` |
> | D6（裁决） | F05-06 隐含「父体由采集得到」 | `documented`（需求字面） | **裁决：父体由人工/工具写入，采集成不了这条路径** | 用户裁决（2026-10-13）。本次实测：三张关系表建在 `store/schema.js:2596` 的迁移 **v37**（`asin_variant_relation` `:2632`、`asin_variant_dimension` `:2656`、`asin_variant_relation_event` `:2682`）；**生产写入方只有两个人工工具**（`tools/asin.js:1240`/`:1250`/`:1307`，网页表单 `web/routes.js:2283-2320` 也经这两个工具）；**`src/domain/collect/**` 零处 import `store/variant.js`**（全仓该 import 只有 `tools/asin.js:29`、`domain/asin/variants.js:53`、`domain/audit/targets.js:113` 三个只读者）；`tests/fixtures/*.html` **没有任何一份真机捕获含父体 ASIN**；生产库三张表 **0 行**、`PRAGMA user_version = 46` |
>
> **订正带来的方向性变化（比逐条更重要）**：
> 原文 §0 的结论「**不是『还差几个模块』，而是『已建成的机制有一半没接线』**」，
> 在 D3-1…D3-4 上**已经不成立**——那四处**都接线了**。今天真正的问题从「没接线」
> 变成了「**接线了，但口径还停在没接线时写的那句话上**」。
> ⇒ 本报告应作为**历史快照**引用，**不可**再作为「当前缺口清单」直接下单（见 D3 新增 §1.4）。
>
> **仍成立的部分（未订正，避免过度更正）**：D3-1…D3-4 的**下游后果**当时是真缺口，
> 其中一部分今天仍是；但**成因**必须重查——例如「时效维度不触发」若仍成立，
> 就**不再能**归因于「`upsertAsin` 不写 `observed_at`」。**归因与结论要分开验。**
>
> **日期**：2026-10-03 ｜ **作者角色**：QA（独立核验）＋ 主理人复核 ｜ **状态**：草稿（待 G1 裁决）
> **关联需求编号**：`amazon-ops-需求设计文档-v2.0.md` 的 F01-01 … F14-10，共 **119** 条，另加 §29–§33 跨模块需求
> **审计基线**：git `HEAD = 70120ef`（2026-10-03 08:17「模块14 §6-§9 页面闭环」），schema **v32**，`index.js` TOOLS = **67**
> **自检基线**：`node tests/run.mjs` = **767 passed / 0 failed**（主理人在 `70120ef` 实跑，verified）；`node scripts/check.mjs` = **OK，67 tool(s) registered**（同一次实跑）
> **证据等级**：本报告结论以 `read`（读源码与权威注册表）为主；每条都带可复查引用。**没有任何一条标 `verified` 的运行时结论**，除上行的自检基线。

## 0. 结论先行

- **126 条**（119 个 F 编号 + §29–§33 的 7 条跨模块）里：**17 条已实现、88 条部分、21 条缺失、0 条未判定**。
- 21 条缺失**全部**落在模块 04/05/06/07/08/09/11/12/13；模块 01/02/03/10/14 与跨模块**没有整块缺失，只有「缺一半」**。
- 「部分」占绝大多数（70%），且反复是同一种形态：**有出口、没有闭环**（建了机制但没有生产方/消费方）。
- 最严重的单点是模块 03 的 `registerSnapshot` 在 `src/` 下**零调用方**（主理人独立 grep 复核，verified）——
  快照登记表停在迁移那一刻，运行期不再追加版本，直接拖垮模块 05 的 diff 与模块 06 的竞品组版本化。
  > ⚠️ **订正（2026-10-13，`stale`）**：**这句已失效**。`registerSnapshot` 现有 **5 处生产调用方**
  > （`store/queries.js:487`、`:1328`、`store/kw.js:474`、`:915`、`store/prompt.js:807`），
  > 快照登记**已在运行期发生**。原文的 `verified` 等级**只对 2026-10-03 的 `70120ef` 成立**，
  > 对本仓当前状态**不成立**。**「拖垮模块 05/06」这个下游结论因此失去成因，需重查（不是自动翻案）。**
  > 详见文首「订正页」D3-1。
- 结论：**不是「还差几个模块」，而是「已建成的机制有一半没接线」**。补齐顺序应当按「接线」而非按「新模块」排。

## 1. 审计方法与判据

### 1.1 判「有没有实现」只看权威注册表

| 面 | 权威来源 |
|---|---|
| 工具 | `index.js` 的 `TOOLS` ＋ `src/tools/index.js` 的 `buildTools`（两处都要有，缺一处 = 工具存在但不可调用） |
| 模块/面板 | `src/state/workbench.js` 的 `MODULE_GROUPS` |
| 表结构 | `src/store/schema.js` 的 `MIGRATIONS`（v1–v32） |
| 路由 | `src/web/routes.js`（含全部 `POST /api/*`） |
| 页面 | `src/web/page.js` 的 `PANEL_RENDERERS` / `RICH_PANELS` / `PANEL_NOTES` |
| 测试 | `tests/*.mjs` 的断言名 |

**明确不用中文关键词 grep 源码**：本仓代码全英文，中文特性名（「覆盖」「体检」）永远不会出现在源码里，这样 grep 出的 0 是假阴性——本仓历史上有一次差点把已实现的功能报成缺失。

### 1.2 状态与置信度口径

| 状态 | 含义 |
|---|---|
| 已实现 `implemented` | 有实现，且能对上文档描述 |
| 部分 `partial` | 只做了一半；`缺口` 列必须写清缺哪一半 |
| 缺失 `missing` | 权威注册表里查无此项 |
| 未判定 `unknown` | 证据不足，不猜 |

置信度：`read` = 读源码得出（本报告绝大多数）；`verified` = 本次实际运行看到输出；`inferred` = 由邻近证据推断。

### 1.3 已知偏差（必读）

- **核验发生在基线移动期间**：13 路核验在 07:20–08:30 之间完成，其间 HEAD 从 `195e33e` 前移到 `78f289f` 再到 `70120ef`，工具数 61 → 67。凡引用 `schema.js` 行号、工具数、`page.js`/`routes.js` 内容的条目，以**各模块小节里注明的实际读取状态**为准。
- **未做运行时验收**：除主理人实跑的自检套件外，本报告没有启动 web 服务、没有用浏览器打开页面，因此「页面真的画出来」未经视觉验收。
- **原型不在仓库**：`prototype/` 在 WorkBuddy 工作区（`C:\Users\78452\WorkBuddy AI\2026-09-28-15-29-33\prototype\`），不在插件仓库，逐页对照只做了抽检。

### 1.4 ⚠️ 证据等级口径与「本报告会过期」这件事（2026-10-13 追加）

本报告写于 `70120ef`，**是一份有时效的快照，不是常驻事实源**。为免后来者误用，明确定义等级：

| 等级 | 含义 | 本报告的用法 |
|---|---|---|
| `verified` | 本次实测（跑了命令 / 看到输出 / 读到确切行号） | 只对**当时那个 HEAD** 成立；**换 HEAD 即需复验** |
| `documented` | 有文档记录、本次**未复验** | **不可**直接作为下单依据 |
| `stale` | **已被后续实测证伪** | 保留原文以可追溯，但**不得**据此排期 |
| `unverified` | 待确认 | 不得当结论用 |

⚠️ **本报告绝大多数条目是 `read`（读源码），不是 `verified`**（见 §1.2 与各模块小节的自述）。
**读源码得出的「零调用方」类断言尤其脆弱**：它断言的是一个**全称否定**（「全仓没有 X」），
而一次新提交就能证伪它——本报告 6 条订正里 **4 条正是这一类**。

⇒ **纪律**：引用本报告的任何「没有 / 零 / 未建」之前，**先跑一次全仓 grep 复验**。
本仓为此反复付过代价（§4.3「声明性未接入：『还没做』这句话过期了」）。

## 2. 总表

| 模块 | 文档 | 功能点 | 已实现 | 部分 | 缺失 | 未判定 |
|---|---|---|---|---|---|---|
| **01** 工作台首页与全局上下文 | §15 | 9 | 4 | 5 | 0 | 0 |
| **02** 店铺站点品牌产品线与设置中心 | §16 | 8 | 3 | 5 | 0 | 0 |
| **03** 数据资产与数据质量中心 | §17 | 7 | 3 | 4 | 0 | 0 |
| **04** 采集中心 | §18 | 10 | 0 | 6 | 4 | 0 |
| **05** ASIN 与 Listing 数据中心 | §19 | 8 | 0 | 5 | 3 | 0 |
| **06** 竞品情报中心 | §20 | 7 | 0 | 4 | 3 | 0 |
| **07** 关键词调研中心 | §21 | 7 | 0 | 5 | 2 | 0 |
| **08** 关键词总库 | §22 | 8 | 0 | 6 | 2 | 0 |
| **09** 关键词数据管道与来源管理 | §23 | 8 | 0 | 7 | 1 | 0 |
| **10** 规则、政策、SEO 与 GEO 中心 | §24 | 9 | 1 | 8 | 0 | 0 |
| **11** 提示词资产中心 | §25 | 9 | 0 | 6 | 3 | 0 |
| **12** Agent 编排与任务中心 | §26 | 10 | 0 | 9 | 1 | 0 |
| **13** Listing 优化中心 | §27 | 9 | 0 | 7 | 2 | 0 |
| **14** 报告、实验、效果观测与回滚中心 | §28 | 10 | 6 | 4 | 0 | 0 |
| **X** 跨模块需求（权限/通知/审计/非功能/新鲜度） | §29–§33 | 7 | 0 | 7 | 0 | 0 |
| **合计** | | **126** | **17** | **88** | **21** | **0** |

## 3. 逐模块明细

### 3.1 模块 01 · 工作台首页与全局上下文（文档 §15）

**整体结论**：模块 01 共 9 个功能点（F01-01…F01-09）。注册表核对：workbench.js:34 MODULE_GROUPS 首组即 home；index.js:258 TOOLS 与 src/tools/index.js:59 buildTools 一致（67 个）；page.js:836 有 home 渲染器。判定 implemented 4、partial 5、missing 0、unknown 0。五个 partial 各缺一半：F01-01 无页面五级选择器、context_id 未落到任务表；F01-02 两卡各缺后半、规则卡数的是实现覆盖率；F01-03 无 Agent waiting 一类；F01-05 optimize-prepare 按过期理由声明未接入；F01-06 SKU 声明不可搜。全部 read 级，未跑测试、未开页面。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F01-01` | 全局范围选择器 | P0 | 部分 | domain/context/scope.js:36 SCOPE_LEVELS 五级、:92 normalizeScope（站点空→DEFAULT_MARKETPLACE，其余空→__all__）、:112 contextIdFor 哈希；state/workbench.js:167-179 state.scope/contextId、:239 仅真变化才 bump revision；tools/context.js:22 读、:114 amzn_workbench_focus 写 scope；workbench.js:195 scopeText 与页面同源。 | 缺「选择器」这一半：page.js:69-75 自述 scope 条是 readout not a control，renderScopeBar(:821) 只印 scopeText；patchContext(:785) 从不发 scope，站点下拉 #marketplace(:5742) 改的是 filters.marketplace。另 context_id 只落在 optimization_draft(schema.js:1310)，collection_task(492-502) 与 agent_run(1913-1928 只有 scope_json) 不带。 |
| `F01-02` | 六张健康卡 | P0 | 部分 | domain/dashboard/health.js:50 CARD_IDS 六张、:79 card() 带 conclusion/numerator/denominator/updatedAt/detailLink、:323 每卡独立 try/catch 降级 ERROR_CONCLUSION、:41 空态写「暂无数据」不写 0；tools/dashboard.js:18 amzn_dashboard 同源；routes.js:2381；page.js:325 #homecards；run.mjs:3314 S1-B06。 | 三张卡各缺一半（对照原型 index.html:134-167 与文档 F01-02）：①「关键词覆盖」(health.js:212) 无「与冲突」半边——field_conflict 已由 store/conflict.js 生产（原型写「6 起所有权冲突」）；②「优化草案」(:281) 无「与观测」半边——observation_checkpoint 已由 store/observe.js:2120/:690 生产；③「规则与政策」(:243) 数的是 code 规则实现覆盖率+生效政策条数，不是原型第 5 卡的 block/warn 风险数。 |
| `F01-03` | 四档待办与异常 | P0 | 部分 | domain/dashboard/todos.js:60 buildTodos 恒返四桶；states.js:92 TODO_BUCKETS=blocking/needs_human/should_handle/optimization；每条含 objectType/objectId/reason/suggestedAction/responsibleModule/link/filters/sample；草案待审 link='#optimize#inbox'(:133/:211)；page.js:329 #hometodos；run.mjs:3567 S1-B07。 | 缺文档点名的「Agent waiting→12 画布」：todos.js 的来源只有规则缺实现/孤儿草案/无站点店铺/过期 ASIN/待审草案，没有读 agent_run.status='waiting_human'（该状态真实存在：domain/agent/run.js:28、store/agent.js:192，面板 page.js:2650 已能画），首页不会把停在等人处的运行算进「待人工」；页面也无 #agent#canvas 锚点。 |
| `F01-04` | 最近运行与产物 | P1 | 已实现 | domain/dashboard/recent.js:131 RECENT_KINDS 五类（采集/管道/Agent/优化/报告）按声明顺序恒返五条(:257)，空类给 note 而非消失；每行带 objectId/objectType/link/filters(:230-244)，报告类状态由 hydrateReport 派生(:202)；routes.js:2387；page.js:330-334 #homerecent；run.mjs:3758 S1-B13 断言被点名任务高亮、被点名管道运行展开。 | 无（Agent 类原 available:false，模块 12 落地后已在 recent.js:162-171 翻真读 agent_run）。 |
| `F01-05` | 快捷动作 | P1 | 部分 | domain/dashboard/quick-actions.js:56 QUICK_ACTIONS 六条，落地目标单源在 target、link 由 targetLink:103 推导（文案与跳转不会漂）；锚点确实存在：#competitor#opps(page.js:421)、#optimize#inbox(page.js:469)；page.js:326-327 #homeactions、:4182 renderQuickActions；tests/s1b14-quick.mjs:321-343。 | 六条里一条是死口且理由过期：optimize-prepare(quick-actions.js:84-93) available:false、link:null、显示「未接入」，note 写「阶段 1 不做模块 12，导航里没有这一项」——但模块 12 已交付：MODULE_GROUPS 有 agent 模块(workbench.js:83-85)、PANEL_RENDERERS.agent 在(page.js:851)、agent_run 表在(schema.js:1913)；目标锚点 canvas 也不存在。 |
| `F01-06` | 全局搜索 | P1 | 部分 | domain/search/index.js:41 SEARCH_KINDS 十类，searchAll:291 恒返十组（含无结果与不可用组）、逐类 try/catch 报 failed 而非空组、用 instr 不用 LIKE（% 与 _ 按字面）；routes.js:2383/2398 由 filters.searchQuery 触发、空查询返回 null；page.js:316-321 搜索框、:4010 renderSearch、:4091 点击记 recent-push；tests/s1b15-search.mjs 8 条断言。 | 十类里 SKU 不可搜：search/index.js:64-73 available:false，理由是「上架时人工指定，采集不到，库里没有这一列」，页面显示该原因而不是空白——但文档 F01-06 把 SKU 列为可搜类型，实际是 9 类可搜 + 1 类声明不可用。次要：品牌/规则/提示词行 site 恒为 '—'，「显示站点与状态」这两类只有状态没有站点。 |
| `F01-07` | 通知中心 | P1 | 已实现 | store/notification.js:53 upsertNotification（UNIQUE dedupe_key 幂等、重发清 read_at）、:119 listNotifications、:161 countsByKind、:171 markRead、:182 markAllRead、:196 clearByKind、:213 purge、:226 notificationView；routes.js:1169/:1181/:1187 三条 POST（400/404/removed:0）；page.js:303 徽标、:3867 renderNotifications。 | 无（生产端目前只有 store/observe.js:1038/1057 的观测到期扫描一个，由 index.js:119 在打开时跑；别的模块不发通知，但 F01-07 本身闭环完整）。 |
| `F01-08` | 首次使用引导 | P1 | 已实现 | domain/dashboard/onboarding.js:65 三步（每次查事实不存进度）、:121 buildOnboarding 出 done/current/pending、:174 emptyCardsNote 写跳步后果；:55 DISMISS_SETTING_KEY 在白名单 store/settings.js:75；page.js:324 #homeguide、:4123 renderGuide、:4170 dismissGuide 写 setting；tests/s1b14-quick.mjs 覆盖三态/跳步/收起。 | 无。 |
| `F01-09` | 最近访问与收藏 | P2 | 已实现 | domain/dashboard/pins.js:37 PIN_KEYS、:43 MAX_RECENT=20、:108 pushRecent（按对象去重、新的在前、截断）、:131 toggleFavorite、:145 pinView、:66 readList 坏 JSON 返空；routes.js:1204 recent-push、:1212 pin-toggle（缺 module/id→400 且不写）；page.js:323 #homepins、:3794 renderPins、:3851 goToPin；tests/s1b20-pins.mjs。 | 无。 |

**未判定/存疑**：

- 本次未运行 node tests/run.mjs（任务禁止），也未启动 dsh web 打开 /custom/amazon-ops 做端到端与截图，故所有结论均为 read 级、未经本次实测复现；文档 §15.7 的七条验收标准（如「两次点击内切到任一站点」「无数据/部分失败/加载/权限不足四态」「待办跳转自动带入筛选」）未逐条实测，其中部分由 run.mjs:2083/3567/2596 断言覆盖但未复跑。
- 未核：§15.5「页面向 Agent 传递允许的下一步工具、只读/可写状态」——amzn_workbench_context 返回 module/scope/selection/filters/activity（tools/context.js:101-109），未见「允许的下一步工具」与只读/可写标志字段，需对照架构契约确认这是缺口还是别处实现。

### 3.2 模块 02 · 店铺站点品牌产品线与设置中心（文档 §16）

**整体结论**：八个功能点：F02-05/06/08 判 implemented；F02-01/02/03/04/07 判 partial。四处「有出口、没有闭环」：①assertWorkspaceWritable 全仓无调用方，归档后只读只是文案；②「记录核验」路由未补 verifiedBy 默认值，按钮必然 400，核验证据也无处显示；③brand.forbidden_json 无合规消费方；④approval.markPublished 无动作读。产品线缺必填属性/默认竞品组/相关性要素/Listing 模板策略。基线（实测）：HEAD=70120ef、schema v32、TOOLS=67=buildTools；但工作树不干净（README.md、docs/plugin-contract.md 已改，product-team/ 未跟踪）。未运行任何测试，结论均为读源码。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F02-01` | 工作空间管理 | P0 | 部分 | store/workspace.js:72 create、:87 rename、:104 archive、:126 setDefault、:177 exportWorkspaceConfig（容量=counts() :270）；schema.js:1343 workspace 表、:1355 默认唯一索引；index.js:324 amzn_workspace_upsert；routes.js:609 workspace-save、:736 workspace-export；page.js:2887-2915 表+导出链接；run.mjs:2661/2698/2741/2790/2966 | 「归档后只读」无闭环：workspace.js:152 assertWorkspaceWritable 在 src/ 全仓无调用方（grep 仅命中其定义、注释 routes.js:1866 与 ARCHITECTURE.md:2179、单测 run.mjs:2713）。各配置写入器与路由都不检查 workspace.archived_at，写入已归档空间会成功。page.js:2882-2885 与 ARCHITECTURE.md:2179「由 store 在写入点拦」与实现不符。容量摘要只在导出树，页面无展示。 |
| `F02-02` | 站点档案 | P0 | 部分 | domain/site/profile.js:56 siteProfileView（域名/语言/币种/units，:65-67 口径三态，最近核验/本地化）；schema.js:1398 site_profile、:1408 site_verification；store/site.js:112 recordSiteVerification（:118 要求 verifiedBy）；routes.js:684 site-save、:709 site-verify；page.js:3067-3109 站点表、:3492 units；run.mjs:2817/2858/2916 | 两处各缺一半：(1) 页面「记录核验」（page.js:3103 → :3564-3566）只 POST {marketplace}，routes.js:716 未给 verifiedBy 默认值，store/site.js:118 抛「verifiedBy is required」→400，核验一条也记不下；routes.js:705 注释称默认 local，实现没有；且无测试覆盖该路由（run.mjs:2887-2909 只直调 store）。(2) evidence_url/evidence_note 可写可存，但无 UI 产出、也无处显示，「证据」这半缺失。 |
| `F02-03` | 店铺与品牌 | P0 | 部分 | schema.js:1462 shop（默认站点）、:1474 brand（写法/别名/禁用/is_own）、:1488 asin_ownership（auto\|manual、confidence、evidence、retracted）；store/ownership.js:227 deriveOwnership、:78 upsertOwnership（冲突不写）、:169 retract、:202 缓存回写；resolve.js:67；routes.js:759/781/811；page.js:3148-3165、:3198-3251；run.mjs:3053/3097/3118/3167 | brand.forbidden_json（禁用写法）只有写和显：routes.js:790 写、page.js:3155 显示，schema.js:1479 注明「合规检查用」，但 src/ 内没有任何合规规则读它 → 无消费方。另：auto 归属只由页面「按判定写入」这一显式动作产出（routes.js:833-866），采集与 amzn_asin_upsert 入库路径都不会自动派生，ASIN 归属需人工点一次才存在。 |
| `F02-04` | 产品线 | P0 | 部分 | schema.js:392 product_line 仅 id/name/note，+:1246 signals_json、+:1363 workspace_id、+:1542 version，:1544 product_line_version；domain/keywords/signals.js:37 四类、:40 四态；store/product-line.js:81 setLineSignalsVersioned；page.js:3414-3454 产品线表；routes.js:535；index.js:267；run.mjs:5147/5193/5295/5320/5386 | 10 个声明字段缺 4 个：必填属性（domain/rules/attributes.js 是全局 52 项注册表，不按产品线）、默认竞品组（competitor_set 无 product_line 关联，schema.js:1194-1201）、相关性要素、Listing 模板策略（prompt_set 只有粗粒度 module 标签，schema.js:1071-1077）。产品线实际列只有 id/name/note/signals_json/workspace_id/version。「信号只有一份、优化引用同一版本」这半已实现。 |
| `F02-05` | 变更影响预览 | P0 | 已实现 | domain/keywords/impact.js:82 previewSignalImpact（纯函数，返回 keywords/asins/delta）、:48 classifyWithSignals；routes.js:591 product-line-preview（只读，不动版本）、:535 保存复用同一函数；store/product-line.js:81 造新版本、同值不造；page.js:3434 预览按钮、:3683 显示「覆盖 N 词 / M ASIN…没有写库」；run.mjs:5226 | —（「确认」即普通「保存」按钮；产品线版本发布不设审批闸门，与 F02-07 的闸门清单一致，非缺口） |
| `F02-06` | 采集与数据源设置 | P0 | 已实现 | domain/collect/profile.js:85 discoverProfiles、:124 profileView、:138 loginView（三态）、:169 importView、:193 resolveImportDir、:205 thirdPartyView；store/settings.js:29 pacing.*/browser.*/collect.defaultSource/importDir、:60 postalCode 模式键；page.js:3284-3337（CDP、登录态、profile、导入目录、第三方源）；run.mjs:4984/5023/5049 | CDP 端口与并发不可改，均是有据决定：page.js:3319 明示端口来自 config.cdpPort「不在这一页改」（改了不生效的输入框更糟），并发由 sources/browser/gate.js:35 串行化为结构约束而非设置项。小瑕疵：thirdPartyView 返回的 status 字段没有任何列渲染它。 |
| `F02-07` | 审批策略 | P1 | 部分 | domain/approval/policy.js:57 HARD_APPROVALS（无 key）、:82 可配置六项、:165 setApproval（只能收紧）、:210 requireApproval、:274 approvalRefusal；调用点 collect.js:103、asin.js:237、rule.js:234、workspace.js:68 与 routes.js:622/908、optimize.js:796；page.js:2970-2996；routes.js:2153；tests/s1b17-approval.mjs、s1b17-1-gates.mjs | 六个可配置项中 5 项已接在动作上（batchCollect/overwriteField/activateVersion/archive/acceptDraft），approval.markPublished（policy.js:119-124）没有任何动作读它 —— policy.js:123 自述「到这里为止没有任何动作读它」，拨动开关不产生任何效果。硬审批三项不可关这一半成立（无设置键，setSetting 抛 unknown setting）。 |
| `F02-08` | 首次设置向导 | P1 | 已实现 | domain/setup/wizard.js:102 SETUP_STEPS 三步、:218 wizardState→{state,ready,steps,missing,message}、:59 READY_STATE；必填与「可稍后完善」由 required 区分，met 实时读库、无进度行；routes.js:2157 setup 切片；page.js:2767 renderSetupWizard、:2847-2858 绘制；tests/s1b18-setup.mjs:197/254/323/400 | —（「可采集」为实时计算而非落库标记，优于「记录用户说完成了」，非缺口） |

**未判定/存疑**：

- 未运行任何测试（明令禁止 node tests/run.mjs，且测试会创建临时文件），所有 status 为读源码所得，confidence 一律 read，无 verified 级功能结论
- F02-02「记录核验必然 400」是代码路径推断（page.js:3566 只送 marketplace → routes.js:716 无默认 → store/site.js:118 抛错），未真跑 HTTP 复现
- brand.forbidden_json 是否被仓库外的脚本/流程消费未查；仓库 src/ 内无消费方
- 工作树未提交改动（README.md、docs/plugin-contract.md）的具体内容与模块 02 是否相关未核

### 3.3 模块 03 · 数据资产与数据质量中心（文档 §17）

**整体结论**：模块 03 七个功能点：3 条 implemented（F03-01 目录、F03-03 驾驶舱、F03-04 冲突），4 条 partial（F03-02/05/06/07），0 missing。主干扎实且有测试：七维度九规则 + 五态机 + 幂等扫描、冲突裁决不删来源、字段级审计 diff、被引用快照拒删。两处结构性问题：① 溯源七列（observed_at 等）只有测试在写，生产写入路径仍是旧的裸 INSERT，导致时效维度永不触发、血缘链缺观测时间；② 快照登记没有生产方，新版本追加只在迁移回填里发生过，页面空态却承诺采集/优化之后会有内容。其余缺口：审计页无时间范围与跳回链接、accepted_risk 冲突状态无写入路径、中间缓存清理未实现。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F03-01` | 数据目录（资产类型→数据集→字段 + 九属性） | P0 | 已实现 | src/domain/catalog/datasets.js:66-475 声明 19 个数据集，九属性齐全（grain/primaryKey/unit/nullSemantics/sources/rowCount/ownerRole/freshnessClass/downstream，阈值只取 7/30/90）；src/store/catalog.js:46 catalogView；页面 page.js:4464；路由 routes.js:1826；测试 run.mjs:4025/4067/4126/4161。 | 模块 03 无 Agent 出口：index.js TOOLS 67 项中属本模块的只有 amzn_dq_scan/amzn_conflict_resolve/amzn_audit_query，无目录/血缘工具，§17.5「数据管家可…」无落点。目录覆盖 19 张表，未登记治理自身四表 dq_issue/field_conflict/audit_log/snapshot_registry 及 kw_aba_fact、kw_ad_fact、kw_import、report、agent_run 等约 20 张表。 |
| `F03-02` | 来源与血缘（每条事实带七项来源字段；从结论反查原始任务或文件） | P0 | 部分 | 七列由 v24 迁移加出（src/store/schema.js:1606-1617，observed_at 不回填今天）；四跳链 src/domain/data/lineage.js:45 traceField（值→字段来源→采集快照→采集任务），四种状态 present/never_collected/not_on_page/failed 分开（lineage.js:142-150）；页面 page.js:4515 qualityLineageHtml；测试 run.mjs:4290/4365/4416（写入→溯源、三种缺失、v23→v24 迁移）。 | 填这七列的 src/store/field-source.js:81 upsertFieldSource 在 src/ 内零调用方（仅 tests 调）；生产路径是 src/store/queries.js:213-219 的旧裸 INSERT（只写 source_id/value/confidence/updated_at），调用方 collector.js:276、tools/asin.js:249，故运行时 source_type/observed_at 等七列恒为 NULL。无「反查到文件」跳；血缘仅 7 个固定字段（routes.js:177）。<br>⚠️ **订正（2026-10-13，`stale`）**：本格「`upsertFieldSource` 在 `src/` 内零调用方（仅 tests 调）」「生产路径是旧裸 INSERT，故七列恒为 NULL」**已被实测证伪**。实测 `upsertFieldSource` 有 **2 处生产调用方**：`src/store/queries.js:247`（就在 `upsertAsin` 内，紧跟 `:240-246` 的裸 INSERT 之后、写**同一行**）、`src/store/asin.js:141`；且 `queries.js:258/261` 显式传 `sourceType`/`observedAt`。⇒ **「裸 INSERT 与富写入是两次写、同落一行」是设计**（`queries.js:220-236` 有长注释说明为何两写都承重），**不是「富写入没人调」**。详见文首订正页 D3-2 / D3-3。 |
| `F03-03` | 质量驾驶舱（七维度规则 + 问题五态机） | P0 | 已实现 | 七维度 src/domain/data/quality-rules.js:46-54，九规则 quality-rules.js:75-94（阈值只读 7/30/90）；状态机 src/domain/states.js:32/42-48；src/store/quality.js:123 runQualityScan 幂等、:185 setIssueStatus 拒非法迁移；路由 routes.js:994；工具 index.js:331；页面 page.js:4584；测试 s1b09-quality.mjs:108/131/150/207/276/303/384。 | 时效维度在生产库上不会命中：它只读 asin_field_source.observed_at（quality-rules.js:171-176），该列运行时恒为 NULL（见 F03-02），故 DQ-FRESH-* 永不触发、DQ-TRACE-001 反而对每个采集字段都触发。问题行无「负责人」写入路径：assignee 列在、setIssueStatus 接受它，但页面 moveDqIssue（page.js:4703）只发 id/to。 |
| `F03-04` | 冲突工作台（多源并列 + 优先级/新鲜度建议 + 裁决或保留未决 + 新证据重开） | P0 | 已实现 | src/domain/data/conflict.js:130 detectConflicts（一字段一冲突）、:167 suggestResolution（优先级+新鲜度两条独立建议）；src/store/conflict.js:286 resolveConflict 只写 field_conflict 不删来源，:201 refreshConflictsFor 挂两个写入路径自动重开；页面 page.js:4938；路由 routes.js:1025；工具 index.js:335；测试 s1b10-conflict.mjs:143/269/304/333/385。 | CONFLICT_STATUSES 含 accepted_risk 且页面画了它的计数 chip（page.js:4969），但没有任何写入路径能到达它：resolveConflict 只写 'resolved'，reopenConflict 只写 'open'，且 src/store/conflict.js:352 reopenConflict 在 src/ 内无路由/工具调用方（仅测试）——「接受风险」只有出口没有入口。 |
| `F03-05` | 快照管理（七类对象版本化，新版本追加不覆盖） | P0 | 部分 | 七类对象 src/domain/states.js:109 SNAPSHOT_OBJECT_TYPES（含 context_package，页面 page.js:4796 显式「待 Agent 平面接入」）；src/store/snapshot.js:98 registerSnapshot 追加新版本、:256 归档、:277 恢复、:296 字段级 diff；页面 page.js:4728；路由 routes.js:899/939/967；测试 tests/s1b11-snapshot.mjs:57/84/106/135/169/231。 | 没有生产方登记：registerSnapshot 在 src/ 内零调用方（grep 只命中 snapshot.js 自身），snapshot_registry 的 INSERT 只在 v26 迁移的一次性回填里（src/store/schema.js:1734-1781）。所以「新版本追加不覆盖」运行时从不发生——采集不会登记 Listing 新版本、优化不会登记草案；页面空态却承诺「跑一次采集或一次优化之后这里才会有东西」（page.js:4812）。无 amzn_* 快照工具。<br>⚠️ **订正（2026-10-13，`stale`）**：本格「`registerSnapshot` 在 `src/` 内零调用方（grep 只命中 snapshot.js 自身）」「运行时从不发生」**已被实测证伪**——实测 **5 处生产调用方**：`src/store/queries.js:487`（登记 `objectType: 'listing'`，在 `:482-485` 写 `asin_snapshot` 之后）、`queries.js:1328`（登记 `'draft'`）、`src/store/kw.js:474`、`kw.js:915`、`src/store/prompt.js:807`。⇒ **采集会登记 Listing 新版本、优化会登记草案**，「新版本追加不覆盖」在运行期**确实发生**。（`snapshot_registry` 的 v26 回填仍在，但那不再是唯一写入。）详见文首订正页 D3-1。 |
| `F03-06` | 全局审计视图（按对象/操作者/动作/时间检索 + 行内前后值 diff + 跳回来源模块） | P1 | 部分 | src/store/audit.js:98 recordAudit 是唯一写入者、:148 listAudit 支持 action/object_type/object_id/actor_kind/from/to；两个漏斗覆盖全部写（src/tools/index.js:311、src/web/routes.js:221）；页面 page.js:5121 renderAudit 逐字段画前值→后值；工具 index.js:339 amzn_audit_query（带 from/to）；测试 tests/s1b12-audit.mjs:171/202/216/230/289/342/384。 | 页面没有时间范围控件：routes.js:1800-1820 只透传 action/objectType/objectId/actorKind，from/to 只有 Agent 工具能用。缺「跳回来源模块」：审计行把 route 当纯文本显示（page.js:5199），没有回 setting/asin/rule 等模块的链接。「操作者」只有 actor_kind 三值（agent/page/system），actor 恒为 'local'（audit.js:118，无用户表）。 |
| `F03-07` | 留存与归档（原始/被引用快照长期保留；清理先展示影响；删除仅限无引用可重建且优先软删） | P1 | 部分 | src/store/retention.js:169 softDelete 先查引用、命中则拒写并列出引用者，:190 委托 archiveSnapshot（同一 archived_at 旗标，可 restore）；:78 REFERENCE_EDGES 声明引用图（rule_set←optimization_run）；页面 page.js:4843-4851 被引用行删除按钮 disabled 且 title 列出引用者；路由 routes.js:939；测试 tests/s1b19-retention.mjs:263/306/337/393/412/472。 | 「中间缓存清理先展示影响」整条无实现：src/ 内没有任何缓存清理入口（grep 缓存/cache 只命中派生列注释与 HTTP no-store）。「可重建」这一条件没检查——只查了「无引用」。引用图只有一条边，七类对象里六类无引用者，对它们「删除仅限无引用」实际不设防（retention.js:28-33 已如实说明）。 |

**未判定/存疑**：

- 本次只做只读核验，未运行 node tests/run.mjs（任务禁止）也未执行任何测试或插件代码，全部结论为读源码所得（confidence=read），没有 verified。
- 基线核对（只读命令）：父仓库 dsh-plugins HEAD=70120ef 2026-10-03 08:17「模块14 §6-§9 页面闭环」，amazon-ops 下 index.js TOOLS 计数 67，与给定一致；但工作树并非完全干净——README.md 与 docs/plugin-contract.md 有未提交改动，另有未跟踪的 amazon-ops/docs/COORDINATION.md 与 product-team/（均非本模块文件）。amazon-ops 源码/index.js/tests 相对 HEAD 无改动。
- F03-07 的「中间缓存」文档未定义指哪些表/哪一层，无法判断是否存在等价实现，故只按「无任何清理入口」判缺。
- F03-01/02/05/07 是否应有 amzn_* Agent 工具，需求 §17.5 只写了「数据管家可…」未落到工具清单，无法判定是设计要求还是本批范围外。
- F03-02「反查到原始任务或文件」中「文件」这一路（导入文件级溯源）没有可对照的实现或表，判定依据只有 lineage 四跳里没有文件跳。

### 3.4 模块 04 · 采集中心（文档 §18）

**整体结论**：模块 04 共 10 个功能点（F04-01..F04-10），逐条核权威注册表。落地的只有采集执行链：amzn_collect_submit/status/doctor 三个工具（两处注册表一致，67 个），任务生命周期 queued→running→done/partial/failed/cancelled 有测试钉住（run.mjs:1184 起）。环境体检只覆盖 5/10 项且散在设置页与 doctor；环境修复只在提交路径上隐式发生。『提交前预览』『waiting_human 处置』『13 节详情』『方案管理』『计划采集』五块不存在；采集面板（page.js:378-381）只有一行提示加一张扁平任务表。计数 0 implemented / 6 partial / 4 missing / 0 unknown。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F04-01` | 环境体检（十项检测） | P0 | 部分 | src/sources/browser/collector.js:457-518 healthCheck 只报 4 类信号（CDP 端口/版本、selectorMiss、storefrontMiss→login、missing 字段）；src/tools/collect.js:176-297 amzn_collect_doctor 报单个 ASIN 的选择器命中与站点校验；profile/端口/登录态在 routes.js:1944-1956；launcher.js:75 findBrowser 查运行时。tests/run.mjs:1648-1662 只断言『浏览器没起』一种情形。 | 十项里只有 运行时/浏览器/端口/登录态/站点匹配 5 项有落点，且散在设置页与 doctor 两处，没有『一键体检』；目录可写、方案版本、代理、冷却状态四项在源码中查无实现；结果也没有 是否可修/修复动作/风险 三个字段。 |
| `F04-02` | 环境修复 | P0 | 部分 | src/sources/cdp/launcher.js:61-107 ensureBrowser 幂等：先 probeVersion 探测端口，已在跑就直接复用（不强杀），否则 mkdirSync(profileDir,{recursive:true}) 建目录再 spawn 拉起并轮询端口；采集提交时经 collector.js:90-96 connect() 隐式触发。 | 四项修复动作里『建目录/启动浏览器/重连端口』只在提交采集的路径上隐式发生，没有可调用的修复入口（67 个工具无 repair，routes.js 无对应 POST），『重设站点上下文』也不作为修复动作存在；状态/说明/是否可修/修复动作/风险 五字段没有对外结构。 |
| `F04-03` | 发起采集 | P0 | 部分 | src/tools/collect.js:38-145 amzn_collect_submit 支持 targets/asins/marketplace/fields/perTaskMax/humanize/strictStorefront/confirm；src/sources/collection.js:149-220 做源校验、日上限、每任务上限，normalizeTargets(:456-479) 去重，validateFields(:489-501)；批量二次确认在 src/domain/approval/policy.js:84-86。 | 缺『提交前预览』整半：没有 preview/dryRun 出口，有效数/重复项/未知归属/请求量/风控风险/复用数 六个数字都不产出（去重只在服务端静默折叠）。参数也缺 站点邮编、自有/竞品分框、父体/分组、方案、并发限速、复用新鲜快照。ARCHITECTURE.md:2231 明说原型 04 的『仅核心节/仅过期节』与新鲜度驱动队列没做。 |
| `F04-04` | 外部入口预填 | P0 | 部分 | 01 入口存在但只是跳转：src/domain/dashboard/quick-actions.js:57-62『采集 8 个过期 ASIN』的 target 只有 {module:'collect'}，同文件:48-51 注释明说原型『发起表单预填 8 ASIN』对应的表单阶段 1 没有。对象预填靠提示词模板 {{scope}}（tests/run.mjs:8876-8882 断言 collect 按钮『采集库里的全部 ASIN，用 browser-local 源。』）。 | collection_task 无 context_id 列（src/store/schema.js:492-502/540-541/568），提交不携带来源上下文；采集面板（page.js:378-381）只有 collectHint + tasks 两个节点，没有来源横幅、没有预填表单、没有『默认仅补过期字段』的字段范围，也没有预填被改的留痕。 |
| `F04-05` | 任务状态机 | P0 | 部分 | src/sources/collection.js:508-516 deriveStatus 产出 queued/running/done/partial/failed/cancelled，:261-345 runTask 写 running→终态；风控即停 :512（stopped='blocked' 有写入判 partial，否则 failed）；重启恢复 :128-142 + src/store/queries.js:699-717（running→failed、queued 重新入队）。tests/run.mjs:1184/1254/1385。 | 九态只有 6 个：缺 draft、checking_env、waiting_human、cooling_down，终态叫 done 而非 completed。『断点恢复不重复写入』只有一半——重启把 running 标 failed、把 queued 整任务重跑，runTask 从 targets[0] 开始，没有已完成目标的下标检查点，重跑会再写一遍快照（upsertSnapshot 实为纯 INSERT，queries.js:336-348）。 |
| `F04-06` | waiting_human 处置 | P0 | 缺失 | 仓内 waiting_human 只属于模块 12 Agent 运行（src/store/schema.js:1921、src/domain/agent/run.js:28-29、src/store/agent.js:199）与模块 14 观测卡片（src/domain/observe/observation.js:78、src/store/observe.js:626）；采集任务侧无此状态：src/sources/collection.js:508-516 的终态集合里没有它，src/tools/collect.js:21-34 的 STATUS_LABEL 也没有。 | 三个触发（profile 未登录/登录墙验证码/计划窗口外放行）都没有；collection_task 没有 waiting_reason 列，没有『已处理继续』『放弃本次』两个动作，也没有 30 分钟无操作转 cancelled 的计时器（全仓无 1800000 / 30*60 计时）。 |
| `F04-07` | 13 节采集详情 | P0 | 缺失 | 仓内唯一的节表是 src/domain/rules/listing-fields.js:51-63 的 SECTIONS = 11 节（tests/run.mjs:6082 断言 eleven sections），那是优化字段词表不是采集基线；采集侧只登记 10 个扁平字段（src/sources/registry.js:36-39 KNOWN_FIELDS）；采集面板是扁平任务表 page.js:5430-5485。 | 13 节（基础信息/五点/图片/变体/规格属性/描述/A+/视频/SEO 元信息/BSR/评论/页面信号/关联竞品）在仓内无定义；没有按 ASIN 展开的节级视图，没有节级 collected/missing/partial/failed/blocked 状态，也没有节级 原始值/解析值/方案版本/快照差异。模块 05 的 LINEAGE_STATES（tests/run.mjs:4365）与 asin_field_source（schema.js:1606-1612）都不是 13 节。 |
| `F04-08` | 自有/竞品识别 | P0 | 部分 | 关系记录已存在：src/store/schema.js:1488-1504 asin_ownership(v22)；src/domain/ownership/resolve.js:54-90 手工层压自动层、同层自竞矛盾则两条都不写；src/store/ownership.js:78 upsertOwnership，品牌别名与产品线派生在 src/web/routes.js:833-847；tests/run.mjs:3051-3248 有断言。 | 该能力只挂在 ASIN 页的 POST /api/ownership（routes.js:811），没有 amzn_* 工具入口，采集流程（collect.js / collection.js）完全不参与归属判定：没有『未知归属』计数，没有提交前归属预览，自动判断也不在发起采集时给出建议；覆盖关系没有版本号，五级优先级里的『已确认关系』与『信号建议』没有分层落点。 |
| `F04-09` | 采集方案管理 | P1 | 缺失 | src/store/schema.js 的 MIGRATIONS v1–v32 无方案/协议表（grep scheme 只命中观测卡片注释）；index.js:258-366 的 67 个工具里没有 collect_scheme/collect_protocol 类工具；采集面板（page.js:378-381）没有方案管理区。 | 版本化资产整半缺失：没有草稿/可用/停用/已废弃四态，没有 版本/字段覆盖/验证时间/状态 的卡片，没有『草稿验证转可用』与『停用废弃需确认』两条动作，也没有 scheme_version 可供 F04-07 的节级详情引用。 |
| `F04-10` | 计划采集 | P2 | 缺失 | 无计划表：src/store/schema.js 的 MIGRATIONS v1–v32 里没有采集计划表；67 个工具（index.js:258-366）无 plan 类采集工具；grep schedule 只命中模块 14 的观测节点（src/store/observe.js:560 checkpointSchedule）与模块 12 的 trigger 枚举（src/tools/agent.js:59）。 | 整项缺失：没有按 站点/ASIN 集 创建计划的入口，没有 运行窗口/频率/上限/失败策略/冷却/暂停条件 六项配置，没有默认关闭的开关，也没有调度器。01 的『采集 8 个过期 ASIN』（quick-actions.js:57-62）只是跳转链接，不构成计划采集。 |

**未判定/存疑**：

- F04-01 的『目录可写/方案版本/代理/冷却状态』四项在插件源码中查无实现；无法排除由插件外部的 amazon-ops-hub 或 DSH 宿主承担，本次未核那两个仓。
- F04-04 的『从 03/05/14 进入』本次只核了 01 的 quick-actions 与 ASIN 面板提示词按钮，未逐一枚举 03/05/14 三个模块的全部按钮与预填路径。
- 按任务约束未运行 tests/run.mjs，全部测试结论均为读断言名与断言体所得，非本次实跑输出。

### 3.5 模块 05 · ASIN 与 Listing 数据中心（文档 §19）

**整体结论**：模块 05 共 8 个功能点：implemented 0、partial 5（F05-01/03/04/05/07）、missing 3（F05-02/06/08）。可用核心是 asin/asin_snapshot/asin_field_source/listing 四表，配 amzn_asin_query/get/upsert 三个工具、9 列 ASIN 表、七维度质量清单、六张带分母的健康卡、版本化快照字段级 diff。本仓反复出现的「有出口没有闭环」在此集中：富写入 upsertFieldSource 无生产调用方（写库的 upsertAsin 不写 observed_at）、diffSnapshots 无出口、attributeCoverage 无调用方、source_type=manual 无写入路径。9 Tab 详情、父子变体、ASIN 归档、表头映射批量导入四块整条未建。

> ⚠️ **订正（2026-10-13，`stale`）**：本段列举的四个「有出口没有闭环」例子中，**三个已被实测证伪**：
> `upsertFieldSource` **有**生产调用方（`queries.js:247`、`asin.js:141`）、`attributeCoverage` **有**调用方
> （`optimize/precheck.js:685` 等 4 处）、`source_type=manual` **有**写入路径（`queries.js:258` 传值；
> `field-source.js:91-96` 未传时按 source `kind` 推，`SOURCE_TYPES` 定义在 `:35`）。
> ⇒ **本段的「集中」结论不成立**，模块 05 的实际缺口须按当前 HEAD 重查（见文首订正页 D3-2/3/4）。
> ⚠️ 注意：「`DQ-FRESH-001` 永不触发 / `DQ-TRACE-001` 全量触发」是**下游后果**，
> 不能靠本段证伪自动翻案，也**不能**再归因于「`upsertAsin` 不写 `observed_at`」——**需独立复验**。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F05-01` | ASIN 大表（17 列核心列 + 保存视图/组合筛选/列配置/批量选择/导出） | P0 | 部分 | panel-asin 只有 #table 与 #coverage（page.js:361-408）；renderTable page.js:5363 只渲染 9 列（page.js:5394-5395）：ASIN/站点/品牌/标题/价格/BSR/词覆盖/已测缺口/词未测；数据源 queryAsins queries.js:249 已返回 a.* 与词覆盖计数、snapshot_count（queries.js:282-294）；工具 amzn_asin_query tools/asin.js:17；切片 routes.js:1459；点行切换选中 page.js:5398-5407。 | 17 列里只画 6 个字段列：父体/SKU/归属/产品线/评分/评论数/完整率/新鲜度/最近采集/优化状态/风险数 全未渲染——但 rating、reviews、product_line_id、snapshot_count 已由 queryAsins 返回，只是没画；归属另有 asin_ownership 表（schema.js:1488）与 ownership 路由（routes.js:811）。此外无保存视图、无列配置、无导出、无组合筛选 UI（筛选只作为工具参数 marketplace/productLineId/brand/q/order 存在）。 |
| `F05-02` | ASIN 详情 9 Tab（概览/Listing 全字段/13 节/变体关系/关键词与排名/评论问答/竞品对比/优化历史/来源与审计） | P0 | 缺失 | panel-asin 仅含 #table 与 #coverage（page.js:361-408）；PANEL_RENDERERS.asin = renderTable（page.js:840）；全页无 asindetail/drawer；路由清单 299-1222 无 asin-* 路由。最接近两处：amzn_asin_get 返回 provenance/snapshots/keywords/listing（tools/asin.js:67）；quality 血缘页按 7 个固定字段 traceField（routes.js:177/1763、page.js:4515）。 | 9 个 Tab 一个都没有：没有详情抽屉组件、没有按 ASIN 的详情数据切片、没有对应路由或工具，也没有 asin 详情相关的测试断言。字段来源只在 quality 模块的血缘页以 7 个固定字段（price/bsr/rating/title/brand/category/image_url）呈现，不在 ASIN 页；Listing 全字段、13 节、变体关系、评论问答、竞品对比、优化历史均无按 ASIN 的聚合入口。 |
| `F05-03` | 字段级事实（当前采用值/所有来源值/采集导入时间/新鲜度/人工确认/与上快照差异/下游引用） | P0 | 部分 | 表 asin_field_source（schema.js:426，v24 扩列 schema.js:1606-1612），主键含 source_id 故可存多源；读路径 amzn_asin_get provenance（queries.js:322、tools/asin.js:100-109）；血缘 4 跳 traceField（lineage.js:45）经 routes.js:1763 到 page.js:4515；裁决只写 field_conflict、不碰来源（conflict.js:286；测试 s1b10-conflict.mjs:269）。 | 唯一生产写入方是 upsertAsin（queries.js:213-219），采集（collector.js:276）与导入（tools/asin.js:249）都走它，而它不写 observed_at/source_type；富写入 upsertFieldSource（field-source.js:81）无生产调用方。后果：DQ-FRESH-001 永不触发（quality-rules.js:173）、DQ-TRACE-001 全量触发（:330）；manual 来源无写入路径（field-source.js:35）；无字段级与上快照差异；下游引用只覆盖 keyword（:348）。<br>⚠️ **订正（2026-10-13，`stale`）**：本格「它不写 observed_at/source_type」「`upsertFieldSource` 无生产调用方」「manual 来源无写入路径」**三条均被实测证伪**——`queries.js:247-262` 显式传 `sourceType`（`:258`）与 `observedAt`（`:261`）给 `upsertFieldSource`；`field-source.js:91-96` 在调用方未给时按 source `kind` 推（`deriveSourceType`，`:154`）。⇒ **后果栏**（`DQ-FRESH-001` 永不触发 / `DQ-TRACE-001` 全量触发）**成因已不成立，须独立复验**。详见文首订正页 D3-3。 |
| `F05-04` | 历史快照与 diff（任意两时间点比较 + 文本/数值/图片A+/属性/变体/来源变化 + 归因标签） | P0 | 部分 | 原始快照 asin_snapshot（schema.js:417）由 upsertSnapshot 写入（queries.js:336）；版本索引 snapshot_registry（schema.js:1706）；diffSnapshots（snapshot.js:296）、withPreviousDiffs（snapshot.js:319）、diffPayloads（diff.js:73）；页面按「与上一版」渲染字段差异（page.js:4831-4836）；测试 s1b11-snapshot.mjs:169/176/185/193。 | ① 任意两时间点比较无出口：diffSnapshots 只有定义与测试，全仓无生产调用方，页面只算「与上一版」。② SNAPSHOT_OBJECT_TYPES（snapshot.js:39-47）不含 asin，ASIN 自身历史无登记式 diff。③ 差异只有扁平字段级 before/after（diff.js:73），无文本字符级、无图片/A+ 增删语义、无属性、无变体、无来源变化。④ 归因标签（Amazon 页面/人工修正/优化发布/来源冲突/未知）全仓 0 处。 |
| `F05-05` | 批量导入（上传→识别表头→字段映射→预览→冲突检查→影响预览→确认→质量报告） | P1 | 部分 | 写入工具 amzn_asin_upsert 接受 records 数组、逐字段写入并返回新增/更新/失败、缺 sourceId 时告警（tools/asin.js:191-213、268-274），覆盖已有非空值前要 confirm（tools/asin.js:236-241，approval.overwriteField settings.js:110）；按表头映射的导入器只存在于关键词域（importers.js:70 detectImportKind、kw.js:39 amzn_kw_import）。 | 八步里只有「确认」（覆盖字段闸门）与写结果统计；无任何文件上传（page.js 搜 type=file / FileReader / upload 为 0 命中），无按表头的字段映射（对比：关键词导入明确「按表头不按列位置」kw.js:46），无写入前预览、无冲突检查、无影响预览、无质量报告，无导入路由，无导入测试。即：能批量写，不能批量导。 |
| `F05-06` | 父子变体（父体/子体、变体维度值、重复矛盾检测、父子层关键词所有权/优化/效果） | P1 | 缺失 | asin 表无父体/SKU/变体列（schema.js:398-415 全列）；src 全量搜 variant\|parent_asin\|parentAsin\|childAsin 只命中英文单词 invariant，无变体模型；MIGRATIONS（schema.js:376-2177）无变体表；TOOLS 67 个（index.js:259-365、src/tools/index.js:59-203）无变体工具；routes.js 无变体路由；tests 无变体断言。 | 整条缺失：没有父体/子体关系表、没有变体维度值、没有重复与矛盾检测、没有父子层分别定义关键词所有权/优化/效果。现有 asin_keyword（schema.js:448）只按 asin+marketplace 记录，没有父子层级概念；schema 中也没有任何列能表达「这个 ASIN 属于哪个父体」。<br>⚠️ **订正（2026-10-13，用户裁决 —— 父体写入路径订正为非目标，不是「暂未实现」）**：「**整条缺失**」这一句对**数据层**已过期（本次实测：三张变体表建在 `src/store/schema.js:2596` 的迁移 **v37**（`name: 'asin-datacenter'`）里 —— `asin_variant_relation` `:2632`、`asin_variant_dimension` `:2656`、`asin_variant_relation_event` `:2682`；库 `PRAGMA user_version = 46`，三张表都在）。<br>**裁决（用户，2026-10-13）：不做「采集自动得到父体」。父体由人工/工具写入；采集不自动产生父子关系。** ⇒ **本条据此写成明确的非目标**：<br>① **非目标**：从采集/真机页面自动推导并写入父子变体关系 —— **不做**（不是「暂未实现」，是**不做**）。<br>② **现状（本次实测）**：生产写入方**只有两个人工工具** —— `src/tools/asin.js:1240`（`upsertVariantRelation`，工具 `amzn_asin_variant_upsert`，`:1202` 起）、`:1250`（`upsertVariantDimension`）、`:1307`（`correctVariantRelation`，工具 `amzn_asin_variant_correct`，`:1284` 起）；网页表单 `src/web/routes.js:2283-2320`（`asin-variant` / `asin-variant-correct` 两个 POST）**也经过这两个工具**，不是第二条写入路径。<br>③ **采集侧零写入（本次实测）**：`src/domain/collect/**` **零处 import `store/variant.js`**。全仓 import 该模块的只有三处，且**全是只读读者**：`src/tools/asin.js:29`、`src/domain/asin/variants.js:53`、`src/domain/audit/targets.js:113`。页面读取器确实**读得懂**父体（`src/sources/pages/amazon.js:1528-1544` 的四条路：`data-defaultasin` → `data-dp-url-asin` → `#parentAsin` → `input[name="parentAsin"]`，落进 section 载荷 `:787` 的 `parent_asin`），但**没有任何一行代码把它写进关系表**。<br>④ **「从真机读出父体」是 `unverified`（本次逐份实测）**：`tests/fixtures/*.html` 六份逐份统计（剥掉 HTML 注释后）—— **唯一那份「真机 + 12 个变体磁贴」的 `amazon-dp-live-2026-10-10-inline-twister-tiles.html`：`data-defaultasin` 0 次、`#parentAsin` 0 次、`parentAsin` 0 次**（原始文本里的 2 次命中**全在 HTML 注释里**，一剥就没了）。唯一带**真实** `data-defaultasin` 属性的是 `amazon-dp-live-2026-10-09-swatch-links.html`，而它是**合成夹具**。⇒ **没有任何一份真机捕获含父体 ASIN**；生产库 `asin_variant_relation` / `asin_variant_dimension` / `asin_variant_relation_event` **各 0 行**（只读实测），所以「父体曾从真机读出并入库」在**本机证据里一次都没发生过**。<br>⑤ **触发本条非目标重估的条件**：拿到一份**含父体 ASIN 的真机捕获**，并**重新过 G1** —— 否则不得把「采集自动得到父体」写进任何批次。 |
| `F05-07` | 数据健康摘要（核心字段完整率/43 属性完整率/新鲜度/多源冲突/规则风险/优化前置，须显示分母与扣分项） | P0 | 部分 | 六张健康卡带分子/分母/口径/更新时间（health.js:50 CARD_IDS、:130-138 新鲜度、:200-208 字段完整率），工具 amzn_dashboard；七维度问题清单 quality-rules.js:46-94、scan :149，页面计数条含零档 page.js:4603-4617；多源冲突 DQ-CONSIST-001 quality-rules.js:276；冲突工作台 amzn_conflict_resolve tools/quality.js:123。 | 43 属性完整率缺失：attributeCoverage（attributes.js:156）全仓无调用方，scanCompleteness 明确不做（quality-rules.js:198-200 自述「43 属性矩阵属于优化器自己的覆盖报告」）。且没有单一的「数据健康摘要」把核心字段完整率/43 属性/新鲜度/多源冲突/规则风险/优化前置汇总成一处：健康卡只有分母与结论、没有扣分项明细；规则风险卡是 workspace 级政策口径；优化前置不在本摘要（page.js:4677 自述本版只产出 DQ-FRESH 问题、供模块 13 消费）。<br>⚠️ **订正（2026-10-13，`stale`，本格含一条口径错）**：① 「`attributeCoverage` 全仓无调用方」**错**——实测 **4 处生产调用方**：`domain/optimize/precheck.js:685`（模块 13 第 8 道门 `attributes-sufficient`）、`domain/rules/listing-rules.js:1231`、`domain/optimize/validate.js:495`、`domain/optimize/report.js:325`。② 「优化前置不在本摘要」**对当前 HEAD 已过期**：`domain/asin/health.js` 已把「优化前置」接进摘要，**来源就是 `precheckFor`**（`tools/optimize.js:364`），见 `health.js:119-120/181-183/214/388-415`。⚠️ **另附行号漂移**：本格引用的 `page.js:4677` 那句自述，**当前 HEAD 上已移到 `page.js:7627`**（原文「过期的 `DQ-FRESH-*` 问题供**优化前置检查**（模块 13）消费：本版只产出问题，不在这里阻断」）——**那句话本身仍成立**（数据质量面板确实只产问题、不阻断），但它说的是**该面板**，而 `asin/health.js` 是**另一个**摘要，**已含优化前置**。**两处不可混为一谈。**⇒ **口径错**：`precheckFor` 是「优化前置是否满足」的**真来源**，本仓**有**这一来源。<br>**真正没有来源的是另外三条**（源码已在 `domain/asin/health.js:125-149` 的 `ASIN_HEALTH_UNSOURCED` 里逐条登记，本次复核确认）：<br>① **规则风险的扫描基线**——`dq_issue` 只存**发现**、不存**扫描**（`store/quality.js:2` 自述「唯一写入方」；`asin/health.js:130-132`）；<br>② **`source_type` 的历史**——`asin_field_source` 主键 `(asin, marketplace, field, source_id)`，同源再写**原地覆盖**（`field-source.js:110-123` 的 `ON CONFLICT DO UPDATE`，其中 `source_type = COALESCE(excluded.source_type, …)`），无历史列/表（`health.js:138-139`）；<br>③ **属性的采集来源**——`listing.attributes_json` 的**唯一生产写入方是草案采纳**（`tools/optimize.js:1636` → `store/queries.js:1065 upsertListing`），采集侧不写它（`health.js:145-147`）。<br>⇒ **为什么「0 条问题」分不开「扫过、干净」与「从来没扫过」**：`runQualityScan` 只对 `scan()` 的**结果**做 upsert（`store/quality.js`），**不落任何「扫描发生过」的行**，也没有 `dq_scan` 之类的表。于是「扫描发生过但没发现问题」与「从未扫描」在库里**产生完全相同的行集（空集）**——`COUNT(*) = 0` 对两种情形是**同一个读数**。本仓为此专门要求这句话必须随读数一起走：`ASIN_HEALTH_SCAN_BASELINE_CAVEAT`（`asin/health.js:151-154`）。详见文首订正页 D4。 |
| `F05-08` | ASIN 归档与恢复（归档前影响预览、归档后隐藏/只读/禁写、恢复留审计、受限删除） | P0 | 缺失 | 归档能力只存在于 workspace（schema.js:1347 archived_at、workspace.js:104 archiveWorkspace、approval 'archive' tools/workspace.js:68）与快照版本（snapshot.js:256 archiveSnapshot；路由 snapshot-archive/snapshot-delete/snapshot-restore routes.js:899/939/967；测试 s1b19-retention.mjs:337）；kw_master 合并归档是另一件事（schema.js:295）。 | ASIN 归档整条缺失：asin 表无 archived/status 列（schema.js:398-415），routes.js 根本没有 asin 路由，TOOLS 无归档工具，WRITE_TARGETS 无 asin 归档项。缺归档影响预览（活跃草案/进行中观测/所属竞品组）、缺归档后默认隐藏+只读+禁止新写入的强制、缺恢复留审计、缺「仅限无引用导入错误且需管理员确认」的删除。快照版本归档与 workspace 归档都不能归档一个 ASIN。<br>⚠️ **订正（2026-10-13，用户裁决 —— 订正的是需求字面口径，不是状态）**：F05-08 的字面「归档后**隐藏**/只读/禁写」**已由用户裁决改口径**。裁决：**保留现状（默认 `all`，已归档的行照样显示、逐行标「已归档」）+ 提供三态筛选（`all`/`hide`/`only`）**。<br>**为什么需求字面与本实现相反**：本仓**两处读者早就落地了相反的决定并写明理由** —— `src/domain/asin/table.js:292-295`（`out.archived = source.archived_at !== null && source.archived_at !== undefined`；原注释：*「列表**不隐藏**归档的行 —— 不带标记的一行看起来与正常记录完全一样，而『归档没生效』正是那个样子」*）与 `src/tools/asin.js:145-146`（`return row.archived === true ? \`${row.asin}（已归档）\` : row.asin`），页面 `src/web/page.js:8495` 也印同一枚芯片。三处一个口径：归档的语义是「**不再作为候选**（采集/优化）」，不是「从库里看不见」；把行藏掉会让一次成功的归档长得像数据丢了。<br>**裁决已作，且已落地（T-5，已并入 main `8e6858d`）**：`src/store/queries.js:336-363`（`ASIN_ARCHIVE_FILTERS = ['hide','only','all']`、`ASIN_ARCHIVE_DEFAULT = 'all'`，并**逐字写下**「默认为什么是 `all` 而不是 `hide`」的理由 —— 本批最初定 `hide`，**同时打破两个读者各自已落地的决定**，属「没人要求的产品行为改变，而且翻转得很安静」）、`src/store/queries.js:517-542`（读回对账三格 `archived`/`archivedHidden`/`archivedTotal`，`hide` 时被挡掉多少条可核对）、`src/web/page.js:745-749`（`<select id="asinArchived">` 三态控件；上方注释写明「三态而不是一个复选框：一个『含已归档』勾选框说不出『只要已归档』」）、`src/web/page.js:8570`（`id="asinArchivedScope"` 口径行，与全库计数分成两句，因为它们是两个不同的数）。<br>⚠️ **仍开放、不由本条订正**：契约 `docs/architecture/API-B05e-asin-archive.md:364-370` 的 §7 第 1 条仍写着「**待 PM 裁决**」——那份契约的状态**已过期**（裁决已作），**该文件不在本次写作用域内，留待架构师订正**。§7 第 2 条（`delete` 的确认开关可否配置）**仍未裁决**。 |

**未判定/存疑**：

- 原型 prototype/05-asin.html（§19.4 称 v1.1 含归档操作与影响预览弹层、已归档视图）在仓库中不存在（无 prototype 目录），其实现状态无法从本仓核实。
- §19.4 的「详情抽屉 / 9 Tab」是否在未提交分支或 DSH 宿主侧另有实现，未核实。
- 环境事实「工作树干净」与实测不一致：amazon-ops/docs/COORDINATION.md 为未跟踪文件（git status）；未读其内容，不确定是否影响本模块结论。
- 未运行 node tests/run.mjs（任务禁止），故所有状态判定均为 read 而非 verified；tests/*.mjs 仅作为断言名证据使用。
- F05-01 中「优化状态」「风险数」两列的应有数据源（optimization_run / 规则风险聚合）是否已有可用接口，未逐条追到接口层。

### 3.6 模块 06 · 竞品情报中心（文档 §20）

**整体结论**：模块 06 只落地了「竞品组 + 关键词差集」这一条窄线：competitor_set 表(v16)、两个工具、一个 POST 路由与 #panel-competitor 面板，加 668 行 kw-competitor 测试；7 个功能点 0 个完整实现。竞品组无版本、无分层成员、无状态机；发现确认只有手工输入；对比矩阵、口碑主题、变化监测三块整条缺失；四象限与机会清单都停在「有列表、没有闭环」。§20.4 的六个页面只做出 2 个(竞品组列表/关键词差距)，且原型 prototype/06-competitor.html 在仓库与工作区均不存在。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F06-01` | 竞品组管理 | P0 | 部分 | schema.js:1194 competitor_set(id/name/marketplace/asins_json/note/updated_at)，v16；工具 amzn_competitor_set_upsert(index.js:307、src/tools/index.js:133)；页面 POST /api/competitor-set(routes.js:393)+#compsets(page.js:1301)；测试 kw-competitor.mjs:105「defined once and reused」。快照仅 v25 回填，registerSnapshot 无调用方。<br>⚠️ **订正（2026-10-13，`stale`）**：「`registerSnapshot` 无调用方」**已被实测证伪**（实测 5 处生产调用方，含 `store/kw.js:474`/`:915` 两处**正是关键词/竞品组侧**）。⚠️ **但本格的实质结论可能仍成立，且原因不同**：竞品组快照登记走的是 `registerSnapshot`，而本格指出的「表无 `version`/`revision` 列、成员变更**原地覆盖**（`kw.js:802 ON CONFLICT DO UPDATE`）」是**另一件事**——**登记了快照 ≠ 竞品组有版本语义**。⇒ **须重查「竞品组今天是否已有版本」，不可用本条订正直接判它已修**。详见文首订正页 D3-1。 | 缺版本：表无 version/revision 列，成员变更原地覆盖(kw.js:802 ON CONFLICT DO UPDATE)，「成员变更新分析用新版本、历史报告指向旧快照」不成立(仅 v25 回填行有 payload 副本)。缺 产品线、核心/参考/替代 三类成员、纳入理由/排除原因、时间窗、草稿/已确认/归档 状态机。 |
| `F06-02` | 竞品发现与确认 | P0 | 部分 | 来源核验：用户指定可用(competitor.js:68-72 asins、121-125 competitors[])；导入文件与 D1 联动经 kw_competitor_fact(schema.js:718；导入器 kw-master.mjs:527/565/591)。MODULE_GROUPS 只有 competitor 一个模块(workbench.js:57)，RICH_PANELS/PANEL_RENDERERS(page.js:50/836)无候选队列，47 张表无候选表，routes.js POST 无候选端点。 | 缺「系统给候选与理由→人工确认入组」这半个：无候选竞品队列(§20.4 六页之一)、无 also-viewed/关键词 Top ASIN/类目排名/相似度 四类来源、无纳入理由留痕(表无 reason/status 列)。现状只能人工手打 ASIN 或依赖卖家精灵/西柚导出文件。 |
| `F06-03` | 对比矩阵 | P0 | 缺失 | 47 张表(schema.js 的 CREATE TABLE)无维度对比表；TOOLS 67 项(index.js:258-366)只有 amzn_competitor_set_upsert 与 amzn_competitor_analyze；routes.js 的 POST 列表与 page.js 的 PANEL_RENDERERS 无矩阵页。competitor 面板只渲染关键词 diff(page.js:1230-1249，行=关键词、列=搜索量/竞品排名/我们排名)。 | 整条未实现：行=维度字段(基本盘/Listing 内容/口碑)、列=自有+竞品 的矩阵不存在；无领先/落后/缺失高亮，无「可查原始证据」入口。全仓没有任何按维度字段比较自有与竞品的代码，口碑维度连字段都没有。 |
| `F06-04` | 关键词差距四象限 | P0 | 部分 | buildCompetitorDiff 输出 theirsOnly/oursOnly/ranked 与 absent/untested 计数(domain/keywords/competitor.js:150-178)；面板两列表+计数卡(page.js:1217-1249)；测试 kw-competitor.mjs:228「three competitor ASINs -> the words they hold and we do not」、254「a missing competitor rank stays null and never becomes 0」。 | 缺四象限：只有「竞品有我们没有/我们有竞品没有/两侧都有」三桶，无 自有优势/共同竞争/自有缺席/仅品牌不相关 四分类，无竞品品牌词隔离区。缺「可加入调研候选」路径：diff 行带 data-keyword(page.js:1273) 但无点击处理器(全页仅 972/1056 两处 tr.onclick，绑在 #kwtable/#kmltable)。 |
| `F06-05` | 口碑主题 | P1 | 缺失 | 表清单无 review/theme 表；TOOLS 67 项无相关工具；routes.js 的 POST 列表与 page.js 无口碑渲染(源码 0 处「口碑」「主题」)；kw_competitor_fact 只存排名与搜索量(schema.js:718 起)；registry.js:38 的 reviews 只是可采的数量字段。 | 整条未实现：主题/正负/样本数/代表原文/涉及产品时间/可行动字段 六项全缺；没有任何评论样本与时间窗可引用，因此 §20.5「归纳评论主题并引用样本」也缺数据基础。 |
| `F06-06` | 变化监测 | P1 | 缺失 | TOOLS 67 项无变化监测工具；表清单无竞品变化表；notification 表唯一生产方是 amzn_observation_scan_due(index.js:359 注释)；asin_snapshot 只写不读(全 src 0 处引用)；kw_competitor_fact 无历史版本列。 | 整条未实现：标题/价格/图片/A+/评分/评论/BSR/变体 七类变化均无检测、无列表、无通知；也没有「变化只是信号、不自动推断对方策略成功」的呈现面。 |
| `F06-07` | 机会清单 | P0 | 部分 | 无 opportunity 表、无对应工具、routes.js POST 无相关路由；page.js:418-421 的 #sect-opps 只是把「竞品有我们没有」列表包了一个锚点，quick-actions.js:71-75「评估竞品缺口」把它标为 anchorLabel「机会清单」。 | 有可行动候选行(关键词+竞品证据+我方排名+排序+absent/untested 理由)，但没有「机会」对象：缺 用户价值/可行动字段/合规风险/新鲜度/置信度，缺 接受/忽略/待验证/转优化 处置状态机与「状态变化留理由」，且行不可点击 → 转优化/进关键词流程的路径不存在。 |

**未判定/存疑**：

- 文档引用的原型 prototype/06-competitor.html 在仓库与工作区均未找到，无法核对页面原型一致性
- 未运行 node tests/run.mjs(被本次任务禁止)，kw-competitor.mjs 的断言名为阅读所得，未实测通过
- §20.3 的「差距结论必须带周期与来源」是否在报告模块另有兜底，未逐页核对

### 3.7 模块 07 · 关键词调研中心（文档 §21）

**整体结论**：70120ef 上模块 07 只落地 B06 一版：种子输入框→三来源候选（suggest/library/competitor）→勾选交 amzn_keyword_import 入库，加 gap/fresh/known 分桶与「实测覆盖」分区。实测两处注册一致（TOOLS=67，buildTools 含 keywordResearchTool），schema v32，候选 17 键无相关性/意图字段。对照 §21：F07-01 输入砍成单框种子、F07-03 七来源只通三、F07-04 折叠有展示拼写被否决、F07-06 漏斗有意图无、F07-07 两栏有决策栏无（均 partial）；F07-02 十步流程、F07-05 五档相关性完全不存在（missing）。无一项完整闭环。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F07-01` | 调研任务输入 | P0 | 部分 | page.js:382-390 只有 rsSeed 单框（逗号分隔）+rsRun/rsImport，patchContext 写 filters.seeds（page.js:5686），无任务记录；tools/keyword.js:399-429 入参仅 seeds/marketplace/limit/dryRun；routes.js:2575-2590 researchState 直接返回候选；index.js TOOLS=67（实测）含 amzn_keyword_research。schema.js 48 表无 research/task 表。 | 缺站点语言/店铺/品牌/产品线上下文，无自有 ASIN 与竞品组绑定，无排除词、无目标（新品建词/补漏/差距/广告扩词/场景）、无时间窗与成本上限；种子只在 UI filters 与内存 state.research，不落库、无保存。 |
| `F07-02` | 十步调研流程 | P0 | 缺失 | domain/keywords/research.js:116-292 buildResearchCandidates 只有三来源合并与 gap/fresh/known 分桶；store/pipeline.js PIPELINE_STAGES=['filter','tier','assign','place','export'] 属模块 08 管道（optimize-pipeline.js 头注释）；kw_pipeline_run/stage 由 amzn_kw_pipeline_run 写。源码 grep 无 268/淘汰 字样。 | 十阶段（定义范围→收集种子→扩词→归一去重→初筛→相关性→意图→指标补全→人工审核→入总库）一个都没有；无阶段输入/输出/淘汰数与原因落盘，无中间阶段重跑；amzn_keyword_research 是单次纯函数，只往 workbench 内存记一条 research:candidates。 |
| `F07-03` | 扩词来源管理 | P0 | 部分 | research.js:78 SOURCE_RANK={competitor,suggest,library}；research.js:174-200 三段合并；实测候选字段含 sources/source。routes.js:2580-2582 只读 readResearchLibrary/readResearchCompetitor，suggest 由 amzn_keyword_research 经浏览器取（tools/keyword.js:463-466）。 | 七类来源只通三类：缺自有 Listing 正文、评论问答、导入文件、产品线词表（product_line.signals_json 只进 classify.js 分类，不进候选）；无 Agent 语义扩展通道，故「推断」标记无处存在——每个候选必须属三种真实来源之一。 |
| `F07-04` | 归一与去重 | P0 | 部分 | key.js:19-21 normalizeKeyword（trim+空白折叠）、key.js:62-63 keywordKey（再 toLowerCase）；research.js:126-131 touch() 按折叠键去重；tests/kw-competitor.mjs「the candidate key is the folded one, so the checkbox writes what it showed」；tests/run.mjs「duplicates collapse case-insensitively, first spelling wins」。 | 大小写折叠做了（实测 keywordKey('Bench  Cushion')→'bench cushion'），但「保留展示拼写」被明确否决：key.js:49-54 存储一律小写且不设 keyword_raw，原始写法不保留；「吸收了哪些原始写法」只有 v15 一次性归档表 kw_master_case_merge_archive，运行时无生产方。 |
| `F07-05` | 相关性判定 | P0 | 缺失 | 实测 buildResearchCandidates 候选 17 个键（bucket/keyword/sources/search_volume/reason 等）无 relevance/basis/evidence/confidence。schema.js keyword 表仅 keyword/marketplace/tier/search_volume/difficulty/source_id/updated_at；kw_master 无相关性列；全仓 grep irrelevant\|uncertain 无匹配。 | 五档 high/medium/low/irrelevant/uncertain 一个都没有，判定依据、反证、执行者、版本、置信度无字段也无入口。store/kw.js:982-983 把相关性推给用户判断，但页面无该判断落点；测试无相关性断言。「相关性是门槛、CVR 是排序」没有承载物。 |
| `F07-06` | 意图与漏斗 | P1 | 部分 | classify.js:202-204 FUNNELS={TOFU,MOFU,BOFU}，classify.js:213-219 classifyFunnel(sv,cvr)；master.js:28,146 写 kw_master.funnel；DDL 有 funnel 列；tools/kw.js:343 可筛 funnel。实测 60000→TOFU、20000→MOFU、100→BOFU。 | 只有漏斗这一维度且已落库。意图维度完全没有：无意图分类器、无意图列、无「12 类意图」。classify.js KEYWORD_TYPE_LABELS（13 值 primary_traffic/organic/sp_ad…）是竞品来源标签，不是意图；需求文档 §21 自身未定义这 12 类，口径缺失。 |
| `F07-07` | 审核工作台 | P0 | 部分 | page.js:1409-1431 candidateSections 按 gap/fresh/known 画三张单表格，列=勾选/关键词/来源/搜索量/竞品排名/库内/reason；page.js:1383-1390 仅 4 个 chip；routes.js 34 条路由字面量中无 research 相关 POST；page.js 的接受/拒绝/决策字样全在质量与优化模块（4579/4675/4969）。 | 候选词与证据两栏有，第三栏决策栏没有；决策只有勾选，无接受/拒绝/待验证/排除/竞品品牌/合并；无批量接受前的来源与相关性分布预览；审核进度不保存（filters.seeds 不落库），无续审。测试只断言候选分桶，无审核工作台用例。 |

**未判定/存疑**：

- 需求文档 §21 只说「12 类意图」，未给清单与判定规则；规则口径基线-v1.0.md 亦无意图口径，故 F07-06 意图半边只能判「无实现」。
- F07-01 的「成本上限」在 §21 未给数值口径，无法判定该字段是否本该有默认值。
- kw_master_case_merge_archive 是 v15 迁移的一次性产物，未在运行库验证其当前行数与内容（只读作业未开 data/amazon-ops.db）。
- 本次未运行 node tests/run.mjs 与 tests/kw-competitor.mjs（任务书禁止），断言名与覆盖来自读源码，测试是否全绿为 unverified。

### 3.8 模块 08 · 关键词总库（文档 §22）

**整体结论**：模块 08 交付的是「导入文件 → 三层事实/汇总 → 大表 + CSV/报告」这条链：三张事实表与 kw_master 分层清楚、可整层重建（store/kw.js:397-410），L1–L5 档位与文档逐字一致、未知量 L5+known=false（classify.js:185-199），分配规则与否词清单完整（export.js:36-43/109-114），后台词 249 字节且排除前台词（export.js:88-99）。缺的是「资产中心」的柱子：所有权工作台（F08-04）与九态生命周期（F08-07）不存在；正式关键词记录缺相关性及依据、所有者、状态标签；位置计划无本模块持久层，一词一主只在优化运行内判定（plan.js:24/449）；覆盖矩阵的 ASIN 维与位置维分散在两模块；详情无入口。8 条：0/6/2（implemented/partial/missing）。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F08-01` | 三层模型 | P0 | 部分 | 事实层 kw_aba_fact/kw_ad_fact/kw_competitor_fact（schema.js:675/697/718）、汇总层 kw_master（schema.js:756）分层清楚；recomputeMaster 先 DELETE 再重建、并保留 first_seen_at（store/kw.js:397-410、382）；应用层只落到 kw_master.for_listing_json（schema.js:827，由 master.js:233 的 forListing 写入）。 | 缺应用层的另两半：无位置计划表、无「一词一主」——主人判定在 optimize/plan.js:24/449 每次运行重算且不落库，本模块只有每词的可用位置布尔。测试只覆盖重建（kw-master.mjs:910/951），无本模块应用层用例。 |
| `F08-02` | 正式关键词记录 | P0 | 部分 | 有：规范写法 keywordKey 折叠（key.js:62）+ v15 迁移折库内拼写（schema.js:272-373）；产品线 product_line（schema.js:760）；漏斗 funnel（805、classify.js:213）；L1–L5 sv_tier/sv_tier_label/sv_tier_known（806-808）；周期 search_volume_period（771）与 ad_periods_json（782）；排名摘要 competitor_best_rank/best_asin/ranked_count（813-816）。 | 缺：相关性及依据（kw_master 与 keyword 都无 relevance 列）、所有者、状态标签。展示写法与原始变体被显式否决（key.js:50-54 否决了 keyword_raw 列），只在 v15 一次性归档表 kw_master_case_merge_archive（schema.js:295）留快照；禁用位置无（for_listing_json 只有可用）；质量只由通用 dq_issue 扫描产出（quality-rules.js:313/360），不是记录上的列。站点语言未落库，只能由 marketplace 经 marketplaces.js:195 推出。 |
| `F08-03` | 分层与选词 | P0 | 部分 | 档位与文档逐字一致：SV_TIERS L1≥100000/L2≥50000/L3≥10000/L4≥1000/L5≥0（classify.js:185-191）；未知量返回 L5 且 known=false（classify.js:196）；测试 kw-master.mjs:251 边界、1432「L5 with known=false」；排序把 search_volume IS NULL 置尾（store/kw.js:639-647），缺失不转 0（kw-master.mjs:1114）。 | 「先过相关性门槛」未实现：无 relevance 字段，queryMaster（store/kw.js:608-636）与管道 filter 阶段（optimize-pipeline.js:165-173）都只按筛选条件取数，没有任何相关性判定或门槛；「综合排序解释权重与缺失数据」只有单维排序键加工具里打印的层级/优先级定义（tools/kw.js:414-416），没有逐条权重解释。 |
| `F08-04` | 所有权工作台 | P0 | 缺失 | 无工具（index.js TOOLS 67 项里无所有权/位置类；本次 node 实测 TOOLS=67）、无表（schema.js 全部 CREATE TABLE 里没有关键词所有权表）、无路由（routes.js 只有 POST kw-source，307-320）、无面板（page.js:429-456 的 panel-kw 只有筛选/统计/大表/来源四块）。 | 整个功能点缺失：词/候选 ASIN/当前主人/冲突原因/证据/建议、批量分配/释放/锁定、冲突双出口（人工裁决或请求 Agent 建议回写建议列）、批量影响预览与活跃优化运行二次确认都没有。仓库里的 asin_ownership（schema.js:1488）是 ASIN 归属、field_conflict（1793）是 ASIN 字段冲突，都不是关键词所有权。设计原型 08-kw-master.html:179 画了这个工作台。 |
| `F08-05` | 位置分配 | P0 | 部分 | 分配规则齐：forListing 的 title/bullets/backend/adsExact/adsPhrase/adsBroad（classify.js:302-314）、ACTIVE_SETS 六集（export.js:36-43）、否词 buildNegatives（export.js:109-114）；后台词按 249 字节预算且排除前台已用词（export.js:33/72-74/88-99），测试 kw-master.mjs:1159/1170/1178。 | 「位置计划唯一持久层在本模块」不成立：无位置计划表，计划在 optimize/plan.js 每次运行重算（buildGlobalPlan:796），本模块只把可用位置布尔写进 kw_master.for_listing_json（schema.js:827）。「一词一主人/一位一用途」只在优化运行内判定（plan.js:24/449）；计划覆盖与实际覆盖的分开统计在 plan.js:745-780，也是单次运行内的，不是本模块的能力。 |
| `F08-06` | 覆盖矩阵 | P1 | 部分 | 两半分散在别处：queries.js:526 keywordCoverage（词 × ASIN 的实测/缺口/未测，供 amzn_keyword_coverage 与 research 面板 page.js:924-940）；plan.js:723 buildCoverageMatrix（词 × 位置 plannedCount/reached/fillRate/gap，供优化运行报告 page.js:1965-1978）。 | 没有 词 × ASIN/位置 的矩阵视图：kw 面板是一张平表（page.js:1029-1053），无矩阵、无「冲突」列。ASIN 维度没有计划覆盖（queries.js:526 只有实测），位置维度没有 ASIN 也没有冲突（plan.js:723）。 |
| `F08-07` | 生命周期管理 | P0 | 缺失 | domain/states.js 只有 DATA_STATES/DQ_ISSUE_STATUSES/OPTIMIZATION_RUN_STATUSES 等，没有关键词九态；全仓找不到 candidate/assigned/observing/retained/paused/excluded/archived 作为关键词状态；kw_master（schema.js:756-832）与 keyword（437-446、552-555）都没有 status 列。 | 整个功能点缺失：九态、流转触发、操作入口都没有。assigned→used 由发布记录自动置位、observing→retained/paused 与模块 14 观测结论联动都不存在（publication_record 只服务模块 14，不写关键词）。「不支持删除」目前只是因为没有任何生命周期入口，不是一条被实现并断言的约束。设计原型 08-kw-master.html:73 画了这条链。 |
| `F08-08` | 关键词详情 | P1 | 部分 | 数据在：getMaster（store/kw.js:667）返回聚合行，含 competitor_ranked_json 前 20 名、ad_periods_json、sources_json（master.js:186/227/164）；关键词级数据质量走通用扫描（quality-rules.js:313/360）。 | 没有任何详情入口：无路由、无渲染器（PANEL_RENDERERS page.js:836-852 只有 kw: renderMaster）、无工具；点行只写 context.selection（page.js:1055-1062），左栏只画一行文字（page.js:5487-5502）。缺多源事实时间线（事实在 master.js:158-234 被聚合成标量）、相关性证据、所有权与位置、原始变体合并记录。设计原型 08-kw-master.html:130 有详情面板。 |

**未判定/存疑**：

- 页面结论全部是 read 级：本次未启动服务、未打开 /custom/amazon-ops、未截图，kw 面板与「点行选中」的实际渲染没有做端到端实测。
- 未运行 node tests/run.mjs（任务禁止）；kw-master.mjs 等断言名只作读到的证据，未复跑。本次唯一的实测是 node 读 index.js 得到 TOOLS=67。
- 需求文档 §22.4 提到的原型 prototype/08-kw-master.html 不在插件仓库内，实际位于 C:\Users\78452\WorkBuddy AI\2026-09-28-15-29-33\prototype\；我只做了关键词检索确认它画了所有权工作台/九态/覆盖矩阵/详情，未逐屏核对。
- 工作树并非干净：README.md 与 docs/plugin-contract.md 有未提交修改，另有未跟踪的 amazon-ops/docs/COORDINATION.md 与 product-team/；但 HEAD 仍为 70120ef，schema 末版 v32（schema.js:2089），TOOLS=67。
- 「相关性及依据」是否由模块 07 调研以别的方式承载，本次只在本仓库检索确认 kw 侧无该字段，未逐模块交叉确认。

### 3.9 模块 09 · 关键词数据管道与来源管理（文档 §23）

**整体结论**：导入侧是实做的：表头驱动解析（六类文件、按 r 引用落位、必需列缺失即失败）、字节指纹去重、事实/汇总分离与幂等重算、含 BOM 的 SOP 应用集导出、5 段管道运行日志（含失败）均有源码+测试证据，我实测了 PIPELINE_STAGES、detectImportKind、periodFromName、kw_import 建表语句、schema v32、TOOLS=67。但 §23 只兑现一半：9 阶段管道实际是 5 段优化管道，导入路径不落阶段行、无定点重跑；来源库 D1–D5 无表无页面无工具；批次撤销、三层幂等、质量报告、四类导出与导出元数据都只有出口没有闭环。8 个功能点：0 implemented / 7 partial / 1 missing。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F09-01` | 文件接收与识别（单文件/目录批量、哈希识别重复、按表头与工作表名识别类型、周期 unknown、识别结果可人工纠正） | P0 | 部分 | pipeline.js:52/:256 单文件+目录导入，tools/kw.js:61,86。指纹去重 store/kw.js:37-40 + pipeline.js:74-95（reason 分同名/同字节 :81,89-93）。类型只按文件名 detectImportKind(fileName) importers.js:70-89（注释:59-69 name-based）；周期无则 unknown :114-156。实测 detect(2026-misc.xlsx)=keyword_list；测试 kw-master.mjs:632,823,831。 | 缺两半：① 类型识别只看文件名，表头/工作表名不参与（xlsx.js:262-265 只取 sheet[0]，readWorkbook 的 sheets 白名单参数无人用）；② 周期解析不出只能写成 'unknown'，工具无 period 入参（kw.js:52-65），D4 无法手填周期、也不阻断运行；「识别结果可人工纠正」只有导入前的 kind 覆盖（importers.js:800-802），导入后无纠正路径（routes.js:312 只有 include/exclude）。 |
| `F09-02` | 来源管理：D1–D5 来源库（格式/模板版本/指标口径/授权连接状态/启停/优先级/最近导入/质量历史/使用限制；planned 不显示为可用；预留 platform_api） | P0 | 缺失 | MIGRATIONS(schema.js) 无相关表（实测 32 条迁移中 0 处 D1..D5、0 处 platform_api）；MODULE_GROUPS(workbench.js:59-67) 关键词组只有 kw/research/pipeline，无来源库页；TOOLS 67 个中 amzn_kw_source(kw.js:202-265) 只是导入文件 include/exclude。仅有的 source 表(schema.js:381-390，种子:516-524) 是采集通道登记，无 格式/模板版本/指标口径/优先级/最近导入/质量历史/使用限制 字段。 | D1–D5 来源库整块缺失：无表、无页面、无工具；导入记录的 source_id 只是常量 FACT_SOURCE(importers.js:48-55) 的 6 个字符串，无行、无外键、无聚合（masterStats 只按文件列 kw_import，kw.js:753-758）。需求末两条（planned 不显示为可用、API 接口位）在另一个对象上成立——采集源注册表 source.js:39 显示「未接入」、registry.js:117-160 的 planned/kind:'api' 适配器——但那管的是采集任务，不是关键词文件来源，不足以算作本功能点的一半。 |
| `F09-03` | 映射与解析（表头名与别名匹配、xlsx 按引用位置落位、原始单位字段名保留、解析器版本写运行记录、映射模板版本化） | P0 | 部分 | 表头名+别名匹配、精确优先再子串 importers.js:183-246（findColumn :195-212），必需列找不到即失败不猜 :205-210；xlsx 按 r 引用落位、空单元格不左移 xlsx.js:14-21,182-200；原始表头原文写进 stats.columns importers.js:468。测试 kw-master.mjs:400(SP 布局同数)、:412(按位置读会错)、:1416(表头改名即失败)、:113(按 r 落位)。实测 kw_import 建表语句内无 parser_version。 | 缺两半：① 解析器版本没写进运行记录——kw_import 无 parser_version 列（实测 false），全仓该列只存在于 asin_field_source(schema.js:1611)，与关键词导入无关；② 映射模板没有版本化，也没有映射模板表/工具（keywords 相关代码 0 处 mapping/template 定义）。 |
| `F09-04` | 九阶段管道（接收→识别→校验元数据→解析原始行→写事实层→合并汇总层→分类相关性→生成应用层→质量报告；每阶段记录输入/输出/行数/跳过/错误/时间/版本） | P0 | 部分 | 有运行日志与阶段表：kw_pipeline_run / kw_pipeline_stage schema.js:1127-1159；recordRun 一事务写入、assertChain 不变量 store/pipeline.js:83-126,190-258；失败也落一条 run 并带 error optimize-pipeline.js:296-325；dryRun 不写不落库 :242；历史工具分列失败 tools/kw.js:754-814。实测 PIPELINE_STAGES=filter→tier→assign→place→export（5 段），非文档 9 段。 | 记的是 5 段优化管道（B05-DESIGN 亦如此定义），不是文档 9 段；导入路径是另一套 4 步 read/parse/write/rollup（domain/keywords/pipeline.js:1-9）且完全不落阶段行，所以「接收/识别/校验元数据/解析原始行/写事实层/合并汇总层」六段无输入输出记录。阶段行也没有 跳过/版本 字段；无定点重跑（无重跑工具、路由、参数，「重跑」只出现在 roles.js:107 的职责文案）。 |
| `F09-05` | 幂等三层（文件哈希→内容指纹→事实主键覆盖；每层独立提示不互相吞掉） | P0 | 部分 | 指纹=字节长度+sha256 前 16 store/kw.js:37-40；同字节第二次导入是空操作 pipeline.js:74-95，两种情况分别给不同 reason/message：same-file-already-imported 与 same-bytes-different-name（:81,89-93）；force 重导是覆盖而非累加，因为事实主键含 (keyword,marketplace,period[,source_file]) schema.js:694,715。测试 kw-master.mjs:823,831,838,856。 | 实际只有一层检查：第 1、2 层共用同一个 fingerprint 比较，是同一判断的两种措辞，不是两层独立提示。第 3 层按口径应是「周期重叠由事实主键覆盖」：实际两份周期重叠的广告报告都会被计入并求和，只给告警，靠人工 exclude + amzn_kw_merge（kw.js:127-145；测试 :856 第二份报告是累加）。重叠检测还写死 kind='ad_report'（kw.js:131），ABA 月/季重叠根本不检测。 |
| `F09-06` | 批次与撤销（唯一批次号+产物明细 新增/更新/跳过/无效+影响词数+操作者+文件哈希；无下游引用可撤销本批次，有引用则禁用并显示原因） | P0 | 部分 | 每次导入写一行 kw_import（store/kw.js:73-113、schema.js:839-859）：fingerprint/kind/source_id/period/rows_read/facts_written/status/included/problems_json/stats_json/imported_at；工具输出「涉及关键词 N」pipeline.js:195；操作者走审计（audit_log actor schema.js:1841，描述符 domain/audit/targets.js:395-401）。实测建表语句无 operator 列。 | 撤销这一半完全没有：无撤销工具/路由/参数，无下游引用检查、无衍生层重建、无反向审计（keywords 代码 0 处 undo/撤销；kw 类页面写路径只有 kw-source 的 include/exclude，routes.js:312-325）。批次这一半也弱：没有跨文件批次号（agent 快照里的 importBatchId 只是最新一行 kw_import，store/agent.js:38-52），产物明细只有 facts_written，没有新增/更新/跳过/无效的分解。 |
| `F09-07` | 质量报告（原始/有效/无效/重复/跳过、未识别列、空关键字段、单位量级异常、周期重叠、ASIN/站点不匹配、产物数量、待人工问题；必查项含 * 行数/列错位/月·季重叠/匹配类型未识别/D5 出现次数） | P0 | 部分 | 问题码+统计落在导入行并由工具回显：starred-rows-skipped(importers.js:438)、column-drift(:553)、period-inverted(:841)、no-asin-column(:433)、rows-skipped/rows-without-keyword(:786,:644)、必需列缺失即失败(:205-210)；stats 记 rowsRead/facts/skipped(:464-469,787)；周期重叠 findOverlaps store/kw.js:127-145，导入输出/kw_source/HTML 报告均显示。 | 没有「质量报告」这件产物：无工具、无路由、无页面、无表把这些问题聚合成报告，只有逐文件的 problems 提示。必查项缺三项：月·季重叠（重叠查询写死 kind='ad_report' kw.js:131）、匹配类型未识别（matchType 只存不检 importers.js:419-420）、D5 出现次数（全仓 0 处 ad_campaign_report，§23.6 的 D5 拒收未实现）。无效/未识别列/空关键字段/量级异常/ASIN·站点不匹配/待人工问题 均无独立计数。 |
| `F09-08` | 导出（总库/ASIN 词包/位置计划/广告建议/否定词/质量问题清单；含来源周期单位/运行 ID/过滤条件/质量告警/UTF-8·BOM 兼容） | P1 | 部分 | 实测 ACTIVE_SETS=title,bullets,backend,adsExact,adsPhrase,adsBroad + negatives（export.js:36-43,227-237，与实测输出一致）；后台 249 字节预算与前后台去重 export.js:69-99；CSV 带 BOM export.js:137-145（测试 kw-master.mjs:1195）；导出登记进报告中心 tools/kw.js:483-490、reports.js:33。 | 总库 / ASIN 词包 / 位置计划 / 质量问题清单 四类未导出，只有 SOP 应用集 + 否定词。CSV 列也不含来源/周期/单位/运行 ID/过滤条件/质量告警（ACTIVE_CSV_COLUMNS export.js:148-162 只有 13 个指标列）；这些元数据只存在于 HTML 报告（export.js:432-456）与报告登记 scope（且只有管道导出才带 runId，optimize-pipeline.js:266-273）。 |

**未判定/存疑**：

- 未运行 amazon-ops/tests/*.mjs 与 scripts/check.mjs（作业禁止 tests/run.mjs；且为遵守「只写一个文件」未执行任何会落临时文件的用例），故文中测试断言名是读源码得到的，未复跑；结论按 read 计。
- 未查 data/amazon-ops.db 实况：库内实际有多少导入批次、是否已存在 D5 类文件、problems_json 里真实出现过哪些问题码，均未验证。
- 文档 §23.4 提到的原型 prototype/09-kw-pipeline.html 在本仓库中不存在（amazon-ops 下无 prototype 目录），未核。
- 基线「工作树干净」不完全成立：仓库根 README.md 与 docs/plugin-contract.md 有未提交修改（amazon-ops/src、index.js、tests 干净，HEAD=70120ef，schema v32，TOOLS=67 已复核）。
- 文档 D1–D5 与代码里 source_id 六个取值（brand_aba/ad_report/sellersprite/xiyou/manual + keyword_list→manual）的对应关系，文档未给映射表，未判定。
- kw_pipeline_stage 阶段行是否记录了「跳过」与「版本」，仅从建表语句与 runStage 判定为无；未逐行复跑确认。

### 3.10 模块 10 · 规则、政策、SEO 与 GEO 中心（文档 §24）

**整体结论**：模块 10 骨架（政策库+规则名册+判定层）闭环：policy/rule 两表 + v10-v12 迁移、8 个工具（amzn_rule_* 5、amzn_policy_* 3）双注册(index.js:291-299 / tools/index.js:111-121)、rules/policy 两个渲染器、两条 POST 路由，tests/run.mjs:7281-8488 有断言。9 个功能点只有 F10-05 全闭合；其余 8 个都是「主链路通、声明缺一半」：F10-01/02 缺类目、政策七态生命周期与来源三级；F10-03/04 缺 severity=info、站点类目、生效失效、新建表单与启用门禁；F10-06 缺影响预览；F10-07 缺图片视频规则与联动组；F10-08 的 SEO 规则在规则中心不存在；F10-09 缺场景尺寸与免责声明。§24.4 五视图只有 2 个半。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F10-01` | 政策管理 | P0 | 部分 | schema.js:994-1010 policy 表含 body_md/url/published_at/effective_from/effective_to/marketplace/superseded_by；v11 种入 policy_source 三源 url/manual/file(975-982)；store/policy.js:444-491 取代链防环；tools/policy.js 三工具双注册(index.js:297-299 / tools/index.js:119-121)；page.js:1714-1832 renderPolicy | 缺 类目 列（policy 表无 category）。生命周期只写 active/superseded：applySupersede 只写这两个值，expired 仅在 page.js:1656-1660 可渲染、无人写，draft/verified/effective/rejected 不存在。来源三级（官方/研究/观察）与强视觉区分没有：source.kind 只有 url/manual/file，page.js:1796-1797 只作纯文本「（kind）」，也没有「观察不得伪装官方」的守卫。 |
| `F10-02` | 政策导入与审阅 | P1 | 部分 | domain/policy/parse.js:284-369 parsePolicy 解析标题/正文/站点/发布/生效/失效/severity_hint+severity_raw/url，返回 unrecognized[] 与 ambiguous[]；不存在的日期按当月天数拒绝（isoDate 129-137）；空正文拒绝（304）；歧义不选边（338-352）；tools/policy.js policyImportTool 双注册（index.js:298 / tools/index.js:120）；tests/run.mjs:8049、8105、8151 有对应断言。 | 缺 类目 与 关键条款：FIELD_LABELS(parse.js:34-41) 与 policy 表都没有 category 列；正文整段存 body_md，没有条款级抽取。所谓「进人工确认」只到 unrecognized 列表（页面显示「未判定」），没有逐字段人工确认/回填入口。 |
| `F10-03` | 规则管理 | P0 | 部分 | schema.js:926-942 rule 表：rule_id/kind/applies_to_json/scope/severity/title/body_md/source/params_json/enabled，PK(rule_set_version,rule_id)；72 条 SEED_ROSTER 由 ruleSeedSql 种入(60-95、951)；kind 四值 code/lexicon/threshold/doc(tools/rule.js:158)；判定经 registry.resolveCheck(registry.js:59-67)+CHECKS | severity 枚举只有 block\|warn（tools/rule.js:163），无 info。rule 表无 站点/类目 列——applies_to_json 只存字段名，站点差异靠 marketplaces.limitsFor 运行时算，不是规则属性。无 生效/失效 列（只有 rule_set.effective_from）。测试样例不是规则属性：tests/run.mjs:5724 的 PLANTED 是测试夹具，库里没有字段。 |
| `F10-04` | 手工建规 | P1 | 部分 | amzn_rule_upsert（index.js:292 / src/tools/index.js:112）可建 kind=code\|lexicon\|threshold\|doc 规则，带 params/severity/source/appliesTo/scope/body_md；store/rules.js:359-416 upsertRule 以发布新版本落地；lexicon/threshold 由 registry.genericCheck（registry.js:85-117）判定；tests/run.mjs:7788、7583 覆盖。 | 「新建规则」表单不存在：page.js:555-569 规则面板只有版本下拉、勾选框与三个生成 prompt 的按钮，没有表单。默认不是 draft 不启用——store/rules.js:390 的 record.enabled === false ? 0 : 1 缺省即启用，库里也没有 draft 状态。code/lexicon/threshold 缺判定实现或测试样例时，page.js:1534 的勾选框没有任何禁用与原因提示。 |
| `F10-05` | 缺判定处理 | P0 | 已实现 | validate.js:296-300 kind=doc 行 continue，不算通过也不算失败；399-413 无 CHECKS 时 severity 强制 block、code=rule-check-missing（失败关闭）；registry.missingChecks(registry.js:129-134) 是唯一判定源；tests/run.mjs:7507 断言 never passed silently；page.js:1516-1517 两个缺口 chip + renderRuleMissing/renderRuleDocs/renderRuleImpl 分三块列出 | 页面只把两个缺口分块列出，没有按缺口筛选规则表的控件（rules 面板唯一控件是 ruleVersion 下拉，page.js:1495）。 |
| `F10-06` | 规则集版本 | P0 | 部分 | store/rules.js:260-292 publishFrom：编辑/开关/导入都发新版本(upsertRule 359-416、setRuleEnabled 319-338、importDocRules 433-493)；activateVersion(204-214) 保证最多一个 is_active；diffVersions(513-529)+amzn_rule_diff；运行起快照 store/agent.js:61、174；rosterForValidation(114-161) 区分 [] 与 null；page.js:2689 显示快照版本 | 缺「影响预览」：全仓没有「新规则集会影响几个现有草案」的计算（grep 影响预览/affectedDrafts/draftsAffected 只命中 product-line-preview，属关键词信号预览）。两版本差异对比只有 amzn_rule_diff 工具；规则页的「版本差异」按钮 page.js:1571 只生成一句 prompt，没有页面级差异视图。 |
| `F10-07` | 字段规则 | P0 | 部分 | listing-rules.js RULES(245-1280) 覆盖 title/bullet/description/search_terms/item_highlights/aplus/qa/image_alt/brand_story/attribute 通配；跨字段一致 backend.title.repeat(888)、item_highlights.title.duplicate(937)、prose.*(140、959-1007)；数值上限 LIMITS 派生自 marketplaces.js:73 GLOBAL_LIMITS，未另存 | 图片/视频只有 Alt Text 三条；主图纯白底、≥1600px、≤9 张、视频 15–60 秒/1920×1080/MP4 全部无规则（grep 1600/白底/1920/mp4 在 src 无命中）。「联动组」未建模——标题↔Item Highlights 的强制联动只剩 item_highlights.title.duplicate 一条。全局一致性里的「前后矛盾」是 MODEL_CHECKS 的 audit.contradiction(listing-rules.js:1336)，属模型审阅项，不是机检规则。 |
| `F10-08` | SEO 规则 | P1 | 部分 | 规则中心无 SEO 条目：RULES 无 seo.* id；workbench.js:34-86 MODULE_GROUPS 无 seo 模块；page.js:836-852 PANEL_RENDERERS 无 seo 渲染器；routes.js 无 seo 路由；MIGRATIONS 无 SEO 表。能力散在优化层：embedding.js 的 tier→位置计划、budget.js 字符/字节预算、backend.title.repeat 前后台去重、bullets.fluff 与 title.word.repeat 堆砌 | 作为模块 10 的「SEO 规则」，规则集/标记/面板/表/路由在本模块全缺，规则中心里没有一条可开关、可引用 rule id 的 SEO 规则。「SEO 建议不覆盖合规规则」没有显式声明：block 规则经 validate→runGates 拦发布是通用机制，没有按 SEO 标注区分。 |
| `F10-09` | GEO 规则 | P2 | 部分 | listing-rules.js 5 条 geo.* 机检规则：geo.attribute.placeholder(1182)、geo.kgo.generic(1208)、geo.attributes.coverage(1222)、geo.intent.phrasing(1254)、geo.nounphrase.opener(1273)，随 SEED_ROSTER 入 rule 表；真实疑问覆盖另有 MODEL_CHECKS 的 audit.geo.answerable(listing-rules.js:1341) | 缺「场景材料尺寸明确」——无任何规则。缺「无证据功效规避」的 GEO 规则（只有 bullets.environmental/prose.environmental 等通用项）。「与 SEO 分开标记」无从谈起，SEO 侧不存在。没有「不宣称必然获得 AI 推荐」的免责声明，规则文案只说「命中率会低」(1269)。站点语言习惯只有一组英文问句标记词(1266)，JP/SA 站点未做。 |

**未判定/存疑**：

- §24.3「规则库当前版本 2026.4.3（71 条生效）」是运行期库状态：代码侧 RULES_VERSION='2026.4'(listing-rules.js:41)、SEED_ROSTER 72 条(245-1280)，71 条生效需查 data/amazon-ops.db 才能确认。本次为只读作业，未打开用户库，故标 unknown。
- §24.4 原型 prototype/10-rules.html 与「字段·SEO·GEO 覆盖矩阵」视图：仓库内 glob 无任何 .html 原型文件，代码里也无该覆盖矩阵视图（只有优化报告 §3.2 埋词覆盖矩阵），判为文档承诺未落盘；未起服务实际打开页面确认。
- 本次未运行 node tests/run.mjs（任务明令禁止）与 node scripts/check.mjs，也未打开 data/amazon-ops.db；全部结论证据等级为 read（读源码），无 verified。

### 3.11 模块 11 · 提示词资产中心（文档 §25）

**整体结论**：模块 11 只落地「库+编辑器+预览」：v13 迁移把 44 行提示词与 13 套集合种进 prompt_set/prompt；三个工具（list/upsert/preview）与两个路由（prompt-save/prompt-preview）同走 upsertPrompt/resolvePrompts，未知变量按名拒绝、空库不回落旧文案。但 §25 的资产化主张大半未落地：无片段实体、无多级作用域与继承、无变量注册表、无生命周期与激活/回滚（只有 enabled 开关）、无固定评估集、无九维双版本对比、无引用反查；版本只是每次保存 +1 的整数且原地覆盖，无历史行可对比。典型形态是「有出口、没有闭环」：运行侧记了 Prompt 文本与行版本，Prompt 侧查不到被谁用。9 条中 0 implemented、6 partial、3 missing（F11-05/07/08）。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F11-01` | 提示词集与版本 | P0 | 部分 | schema v13 prompt-library 建 prompt_set + prompt 两表（src/store/schema.js:1071-1092）；种子 40 按钮+1 通用+3 组装层=44 行/13 套（prompt-seed.js:78-214）；工具 amzn_prompt_list/upsert/preview（index.js:301-303；src/tools/index.js:125-127）；面板 prompts:renderPromptEditor（page.js:587-595,849）；测试 tests/run.mjs:8757。 | 组织维度只有 module+scenario(button/assemble)+layer(fixed/evidence/contract)，没有按「任务」（采集诊断/数据质量/竞品/关键词相关性/Listing 策略/分字段生成/合规审阅/报告解释）分。版本只是 prompt.version 整数，保存即原地 UPDATE 覆盖，无历史行、无版本树、无版本差异。文档要求的 system 指令/任务指令/变量定义/上下文选择规则/输出结构/禁止事项/示例反例/评估集/变更说明 九类要素没有独立字段，评估集与变更说明完全缺失（禁止事项、示例反例只存在于 assemble 正文文本里）。 |
| `F11-02` | 片段与组合 | P0 | 部分 | 组装顺序由 PROMPT_LAYERS=['fixed','evidence','contract'] 固定（src/domain/optimize/prompt.js:50），resolvePrompts 按层序排序（src/store/prompt.js:191-201）；common 集合按钮追加在各模块之后（prompt.js:182-187）；测试 tests/run.mjs:8892。命令核对：全仓无 fragment/snippet 标识符、无片段表、无片段引用关系。 | 没有可复用片段实体：品牌语气/产品线事实边界/站点语言规范/输出格式/审查清单五类片段无表、无注册表、无被引用关系，唯一的共用物是 common 模块的一条按钮。组合顺序只有三段 fixed→evidence→contract，不是文档的六段固定顺序（平台安全边界→角色职责→业务规则引用→任务目标→数据上下文→输出契约）。因为没有覆盖机制，「后级不能覆盖前级硬约束」既无实现物也无断言。 |
| `F11-03` | 作用域与继承 | P0 | 部分 | resolvePrompts 只解析 module+common 两级（src/store/prompt.js:176-203）；模块闭集 = MODULES + 'common'（prompt.js:50,249-251）；optimize run 包存 assemble 文本+行版本（src/tools/optimize.js:290-295）；agent run 存集合指纹（src/store/agent.js promptSnapshot；schema.js:1920）。 | prompt_set 只有 module 一列，没有全局/模块/站点/品牌/产品线/具体任务六级作用域，也没有继承、可配置项覆盖、硬边界保护、多重覆盖冲突阻止激活（系统里没有激活这一步）。运行前只显示单条正文渲染，不显示最终解析结果。快照方面 optimize run 存了文本+行版本，agent run 只存 prompt_set 指纹，而 prompt_set.version 从不更新（命令核对：全仓 0 处 UPDATE prompt_set），无法回答「这次运行用的是哪一版」。 |
| `F11-04` | 变量管理 | P0 | 部分 | 闭集 PROMPT_VARIABLES=['scope','selectedKeywords','rulesVersion']（src/domain/optimize/prompt.js:44）；variables_json 由 body 解析派生（src/store/prompt.js:277-283）；未知变量按名拒绝（prompt.js:60-67；src/tools/prompt.js:186-190）；测试 tests/run.mjs:8610。 | 没有变量注册表：名称/业务解释/类型/来源（表与口径）/必填/最大长度/敏感/默认行为 八项元数据一个都没有，只有从 body 解析出的名字数组。必填缺失时既不停止也不降级说明，缺失只渲染成空；没有类型与长度校验；没有敏感标记与脱敏；「未注册变量禁激活」只等价于保存/预览时拒绝。文档 §25.3 要求的 kw_master 汇总字段与 kw_*_fact 事实字段变量在闭集里不存在。 |
| `F11-05` | 生命周期 | P0 | 缺失 | prompt 表只有 enabled INTEGER 一个开关（src/store/schema.js:1079-1092），无状态列；32 个迁移里与提示词有关的只有 v13 prompt-library（src/store/schema.js）；工具仅 list/upsert/preview（index.js:301-303）；路由仅 prompt-save 与 prompt-preview（src/web/routes.js:370,413）；命令核对：无 activate/rollback 工具或路由，全仓无 rolled_back 标识。 | draft→review→testing→active→deprecated/rolled_back 六个状态、状态机与门禁全无实现；编辑与激活不分离（保存即生效）；「active 才能用于生产」无判定点；激活前「被哪些运行使用」确认、一键回滚、rolled_back 版本标记均不存在。原型 prototype/11-prompts.html:71,185-199 设计了生命周期与激活/回滚弹层，仓库里没有对应实现。 |
| `F11-06` | 试运行与预览 | P0 | 部分 | 工具 amzn_prompt_preview（src/tools/prompt.js:160-205）；路由 POST /api/prompt-preview（src/web/routes.js:413-421）；编辑器预览 promptPreviewBody（src/web/page.js:5621,5651-5665）；previewPrompt 渲染并列出变量（src/store/prompt.js:215-227）；测试 tests/run.mjs:8926。 | 缺变量来源展示（不显示每个变量来自哪张表、什么口径）；缺缺失项清单与「变量齐全/缺失」判定（原型 11-prompts.html:128 有「变量来源…缺失项：无」）；缺敏感内容脱敏，预览原样回显变量值。预览只针对单条正文，不渲染 fixed+evidence+contract 合成后的完整 Prompt，也不是文档场景①的「右侧实时组装预览」；面板是两栏（page.js:592-595），不是 §25.4 的三栏（集与版本树/编辑器/变量+预览+评估）。 |
| `F11-07` | 固定评估集 | P1 | 缺失 | 命令核对：schema 32 个迁移无评估集表；index.js 67 个工具无评估工具；routes.js 路由表无评估路由；tests/*.mjs 无评估集断言；仓库与文档内「评估集」0 处命中。tests/prompt-snapshot.json 是 pre-B04 按钮文案的逐字节快照夹具（tests/make-prompt-snapshot.mjs:100-106），不是评估集。 | 8 类覆盖样例（正常 ASIN/数据缺失/多源冲突/高风险表述/非英语站点/超长字段/竞品品牌词/无足够证据）与口径陷阱样例（百倍混算/列错位/* 行/月季粒度）的期望行为「指出问题或拒绝下结论」全无落地物：无样例表、无固定输入快照、无期望行为断言。原型 11-prompts.html:154「固定评估集 · v2.3 vs v2.4（同输入快照 EVAL-KW-12）」未实现。 |
| `F11-08` | 双版本对比评估 | P1 | 缺失 | 无九维评分常量/函数/表/工具/路由；命令核对：全仓无 eval/experiment/variant 及九维评分相关实现（dimension 仅指数据质量七维度 src/domain/data/quality-rules.js）；prompt 保存是 UPDATE 原地覆盖、无历史版本行（src/store/prompt.js:307-313），无「同一输入快照」对比机制。 | 事实一致/规则命中/关键词执行/结构完整/解释性/语气/稳定性/人工采纳率/成本 九维评分与 v2.3 vs v2.4 双版本对比完全不存在；没有固定输入快照，也就没有「避免把数据变化误认为 Prompt 变好」的同一快照约束；人工采纳率与成本两维在 publication_record/observation_plan 里也没有数据来源。 |
| `F11-09` | 引用追踪 | P2 | 部分 | optimize run 包存 assemble 各层 label/version/text（src/tools/optimize.js:290-295）；agent run 存 prompt_set 指纹（src/store/agent.js promptSnapshot；schema.js:1920）；快照登记表把 prompt_set 登记为可归档对象（schema.js:1774-1780）；测试 tests/m12-agent.mjs:166。 | 没有「被哪些运行使用」反查：无按 prompt/prompt_set id 查运行的查询、路由或页面（routes.js 只有 prompt-save 与 prompt-preview）；「版本被采纳字段与 30 天观测结论关联（接口预留）」无任何字段或接口，publication_record 与 observation_plan 均无 prompt 引用。且 prompt_set.version 从不更新（命令核对 0 处 UPDATE prompt_set），agent run 的 Prompt 快照定位不到编辑后的具体版本。 |

**未判定/存疑**：

- 本次为只读核验且禁止运行 node tests/run.mjs，所有结论基于权威注册表与源码阅读（read/verified），未做端到端运行验证。
- 原型 prototype/11-prompts.html 位于需求文档目录、未纳入插件仓库，仓库内没有前端视觉验收基线。
- 文档 §25.3 要求关键词相关 Prompt 集的变量锚定 schema v18 的 kw_master 与 kw_*_fact 字段，仓库提示词变量闭集只有 scope/selectedKeywords/rulesVersion；是否存在仓库外或未注册的关键词 Prompt 集定义，未在注册表中发现，记为 unknown。

### 3.12 模块 12 · Agent 编排与任务中心（文档 §26）

**整体结论**：模块 12 交付「编排骨架 + 留痕 + 门禁」，不含 LLM 调用（分析生成由会话侧 Agent 做）。10 个功能点：0 完整实现、9 partial、1 missing。最扎实的是状态机与门禁：三张表（v30 迁移）真在 schema 里，6 个 agent 工具在两处注册表都在（实测 67 个工具），范围外结构化拒绝与门禁双向断言都有测试。缺口三类：① 配置面几乎空白，无版本化/版本表，十要素缺五（F12-02）；② 上下文包只拷了 5 样，质量摘要/人工约束/输出格式/成本上限全缺（F12-03）；③ 编排与恢复没做，四种编排模式一条都没有（F12-05，唯一 missing），agent 运行没有 recover，重试/取消/blocked 出口页面上都没有入口（F12-06/09）。典型形态仍是「有出口没闭环」：产物有版本链却没有接受/驳回入口，运行 id 流不回会话。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F12-01` | 角色 Agent 体系（8 角色，结构化产物交接） | P0 | 部分 | roles.js:82-180 AGENT_ROLES 共 9 条；roles.js:183 AVAILABLE_ROLE_IDS 只含 data-steward/keyword-research/pipeline-maintenance（实测 roles 9 / available 3）。页面角色表 page.js:2657-2669 画全部角色并标「未接入/缺：…」。测试 m12-agent.mjs:153 断言 AGENT_ROLES.length=9。产物载体 agent_artifact（schema.js:1951，带 object_type/object_id）。 | 文档 8 角色里 5 个 available:false（采集协调/竞品分析/Listing 策略/文案生成/合规审阅，roles.js:114-179），实际只能跑 3 个；「角色间通过结构化产物交接」只具备产物的结构，没有任何代码把 A 角色的产物读成 B 角色的输入。§26.3 允许先上三角色最小闭环，故按现状判 partial。 |
| `F12-02` | Agent 配置管理（配置十要素 + 版本化 + 配置视图） | P0 | 部分 | 无 agent_config 类表：schema.js 搜 agent_config 零命中，v30 迁移只建 agent_run / agent_step / agent_artifact（schema.js:1913 / 1933 / 1951）。无配置工具：实测 registerTools 注册 67 个，amzn_agent_* 仅 6 个（start / step / finish / list / artifact_save / gate_decide）。角色声明含名称职责、工具、禁止动作、步骤、门禁（roles.js:85-91）；页面只有只读角色表 page.js:2657。 | 十要素缺五：允许数据（只有运行级 scope，无角色级声明）、默认提示词集、失败降级、状态版本、范围与成本上限；输入输出契约只到步骤名。没有配置版本化（角色是代码常量，改了就变，无版本、无回滚），也没有 §26.4 的「配置版本表」——与任务画布并列的只有只读角色表。 |
| `F12-03` | 上下文包（十要素，不可变，只用包内事实） | P0 | 部分 | store/agent.js:155-180 startRun 一次拷贝并落列四样：scope_json、data_snapshot_json（kw_master 指纹，:39-52）、rules_snapshot_json（:61-64）、prompts_snapshot_json（prompt_set 版本，:55-58）；schema.js:1917-1920 四列。run_start 回显四样快照 + toolsForRole 白名单（tools/agent.js:36-92）。测试 m12-agent.mjs:166、:194（改规则后旧运行快照逐字不变）。 | 十要素只落 5 样（目标 goal / 范围 scope / 数据快照 / 规则快照 / Prompt 快照）+ 运行时计算的工具权限，缺质量摘要、人工约束、输出格式、成本上限，表里也没有对应列。「需新数据发补充请求」只有 scopeRefusal 的文案（run.js:104-107），没有补充请求工具或表；context_package 仍是零行的待接入类型（snapshot.js:50 PENDING_SNAPSHOT_TYPES）。 |
| `F12-04` | 任务类型与状态机（六类 + 运行/步骤双状态机） | P0 | 部分 | 状态机完整：run.js:25-34 RUN_EDGES（draft→ready→running→waiting_human/blocked→completed/failed/cancelled，终止态不可回退）；roles.js:34-39 两个词表；store/agent.js:192-214 setRunStatus 强制 waiting_human/blocked 必带原因。测试 m12-agent.mjs:151/152 逐字断言两个词表、:364 断言状态机与 reason 必填、:377 canTransitionRun。schema.js:1921 / 1938 两列注释。 | 六类任务类型（单步问答/分析/生成/校验/流程/维护）完全没有落点：agent_run 无 type 列（schema.js:1913-1928），amzn_agent_run_start 参数只有 role/goal/scope/trigger（tools/agent.js:44-62），工具与页面都没有类型概念。缺类型那一半，状态机那一半完整。 |
| `F12-05` | 编排模式（顺序/并行/审阅循环/条件分支） | P1 | 缺失 | src/domain/agent 下 parallel\|loop\|branch\|mode 全部零命中；agent_run 无 mode 列（schema.js:1913-1928）；agent_step 只记 seq/step/status/input/output/error（schema.js:1933-1945）。roles.js:88 的 steps 只是名字数组，amzn_agent_run_step（tools/agent.js:95-154）只按 seq upsert，不校验顺序、不触发下一步、无审阅次数上限。 | 四种编排模式一条都没有实现：顺序/并行（含分字段并行后的合并检查）/审阅循环（超限转人工）/条件分支（评分<3.8 先修产品、非 authoritative 站点加人工复核）。插件只记录会话侧 Agent 自己编排的步骤，「顺序」也只是 seq 的排序，没有编排引擎。 |
| `F12-06` | 任务画布（步骤图/工具调用/人工决策/blocked 出口/恢复重试取消） | P0 | 部分 | page.js:504-516 面板 + renderAgent:2604-2674：运行列表 :2621（id/角色/状态/步/产物/开始）、运行头 :2645、等待与卡住原因 :2650-2651、snapshotBlock :2683、stepBlock :2695（含 elapsed :2709）、artifactBlock :2716、gateBlock :2732（批准/驳回按钮）；数据 agentState routes.js:2352-2364；写路由 POST /api/agent-gate routes.js:661-677（审计 targets.js:787-788）。 | 缺 blocked 的出口动作与「修复后重试在修复前禁用」：blocked 只显示一句原因文字（page.js:2651），没有去补采/去来源模块/申请权限/缩小范围重试任何按钮。缺「每步 Agent」与「工具调用」两栏（stepBlock 只有 #/步骤/状态/错误/耗时，agent_step 也无 agent/tool 列）；步骤图是表格；面板里没有恢复/重试/取消入口（唯一按钮是门禁批准/驳回与重新读取）。 |
| `F12-07` | 产物管理（版本化产物 + 父产物 + 审批引用） | P0 | 部分 | agent_artifact 表 schema.js:1951-1967（含 version/parent_id/status/body_json + 对象链索引）；saveArtifact store/agent.js:269-298（parentId 递增版本，supersedeParents 一次写把父版标 superseded，旧行不删）；四态 roles.js:42；工具 tools/agent.js:223-279；页面产物表 page.js:2716-2728；测试 m12-agent.mjs:274 断言 v2 取代 v1 且父链留两行。 | 规格里的「输入快照」不在产物行上（agent_artifact 无 input 列，只能靠 step_seq 指到步骤的 input_json）；「审批引用关系」只有一个 gate-decision 产物按 object_id 关联（run.js:111-120），产物行没有指向审批的字段；产物状态只能在写入时给定，页面没有接受/驳回入口；「产物列表」是运行详情里的内嵌表，没有独立列表视图。 |
| `F12-08` | 人工控制（草案级/字段级/证据级/流程级/版本级五层） | P0 | 部分 | 已实现三层：流程级 = 两个门禁 + 页面批准/驳回（roles.js:54-65、page.js:2732-2752、routes.js:661）；草案级 = 产物 status 四态（tools/agent.js:242）；版本级 = parentId/superseded（store/agent.js:280-296）。「Agent 必须说明等待什么」由 setRunStatus 强制（store/agent.js:199-204）。门禁双向断言 m12-agent.mjs:316（未批被拒 + 获批放行）、:349（驳回不放行）。 | 字段级与证据级控制在本模块没有落点：产物 body 是整块 JSON，没有字段粒度；没有「修改后接受」的路径（只有接受/驳回/新版本）；页面只能对门禁裁决，不能对产物做草案级接受/驳回。五层里缺两层。 |
| `F12-09` | 失败与恢复（可重试标记/中断恢复/取消保留产物） | P0 | 部分 | 中断不重复写入靠 recordStep 的 upsert（store/agent.js:216-259）+ UNIQUE(run_id,seq)（schema.js:1944），测试 m12-agent.mjs:274「re-recording a step lands on the same row, and a retry does not re-run the rest — ③ ⑥」；取消：状态机允许 →cancelled（run.js:25-34），产物无删除路径；参数摘要记在 agent_step.input_json（schema.js:1939）。 | 「是否可重试」没有字段（全仓 grep retryable 零命中，agent_step 只有 error）；「中断从最后持久化步骤恢复」没有自动恢复：index.js:174-196 只对 collection/keywords 调 recover，agent 运行没有 recover（recoverStaleTasks 仅 collection.js:132 与 keyword.js:434 调用），全靠会话侧主动重报；「上下文变化创建新运行」无检测逻辑；「多次失败停止自动重试给人工方案」无实现；页面无取消/重试按钮。 |
| `F12-10` | DSH 结合（会话入口 + 页面审批 + 运行 ID 互跳） | P0 | 部分 | 两处注册表都有 6 个 amzn_agent_* 工具（index.js:342-347、src/tools/index.js:177-182）；实测 registerTools 注册 67 个（含 agent 6 个），TOOLS.length=67。分工声明在 tools/agent.js:1-13。页面审批 POST /api/agent-gate（routes.js:661）。同一运行 id：测试 m12-agent.mjs:386（页面路由与工具回答同一运行 id — ⑦）；页面内跳转 recent.js:171（link '#agent' + agentRunId）。 | 「互跳」只做了会话→页面一半：运行 id 由工具产生、页面按同一 id 取行（page.js:2625 只以 <code title> 显示 id），页面→会话没有任何链接或复制入口。「稳定对象 ID」的跨平面跳转也没有落点：产物的 object_type/object_id 只在运行详情里显示，不可点、不可跳。 |

**未判定/存疑**：

- 未执行 node tests/run.mjs（任务禁止），也未单独执行 tests/m12-agent.mjs —— 只读作业不允许其 mkdtemp 落临时文件；测试结论来自断言名与源码阅读，不是本次执行输出。
- 未启动工作台服务或浏览器截图，页面的实际渲染效果与空态/异常态未做视觉验证，仅核到渲染函数与注册表。
- F12-02 的十要素判定基于 roles.js 的角色声明字段；是否存在模块外的等价配置面（如 setting_list 里的通用配置项）未逐项排查。
- F12-04「六类任务类型」只查了模块 12 相关注册表，未穷举其它模块是否有同义的任务类型落点。

### 3.13 模块 13 · Listing 优化中心（文档 §27）

**整体结论**：模块 13 的九条 P0：0 implemented / 7 partial / 2 missing（F13-02 前置检查九项、F13-04 优化模式）。四个工具（index.js:276-279 与 src/tools/index.js:90-93 两处都注册）把「取数→模型写→机检→落库出报告」跑通了：字段词表覆盖 11 章节 + 43 必填属性，规则与六道闸门分开显示，报告含前后值/理由/植入词/规则 id 与可复制字段。但对照 §27 验收标准，本模块典型形态是「有出口、没有闭环」：①页面无任何决策控件，四选只剩工具侧 accept/reject 数组；②context 守卫 canSubmitDraft（context.js:41-68）在 src 里零调用；③DQ 过期问题已产出但优化侧无消费者（page.js:4677）；④位置计划不落库、不继承 08。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F13-01` | 草案收件箱 | P0 | 部分 | page.js:462-469 面板有 #sect-inbox/#optdrafts；renderOptimizations page.js:1981 画轮次表+选中轮次的字段卡；DRAFT_FILTER_LABELS page.js:2499={pending,orphan}；routes.js:2608 optimizationState 只按 asin/marketplace 列 run；tests/s1b13-recent.mjs:547 断言过滤可开可关；run.mjs:3703 待办带 draftStatus=pending+anchor=inbox | 只做到「轮次列表 + 单轮字段卡」+ pending/orphan 二值过滤。缺：按 待人工选择/待审批/驳回待修订/稍后/已作废 分组；对象/站点/生成时间/阻断警告数/待确认项/审批状态 列；行尾「继续审阅 / 基于此草案重新优化」；作废与恢复（optimization_draft 仅 accepted 三态，无作废列、无审计动作）；从 01 待办进入按 context_id 筛选（只带 draftStatus）。 |
| `F13-02` | 前置检查（九项门槛） | P0 | 缺失 | quick-actions.js:64-69 原话「原型的落点是 13 的前置检查清单（九项），阶段 1 还没建」；page.js:4677 DQ-FRESH 问题「供优化前置检查（模块 13）消费：本版只产出问题」；tools/optimize.js:184-206 prepare 参数无门槛项，只在无 listing/无词时打印警告（:351-352、:383-384）；src 全库 grep 3.8/ratingMin 无命中 | 九项门槛整体未建：没有前置检查的工具、路由、面板或表，没有「补数清单 / 降级说明」输出，也没有降级标记（属性建议低置信度）。上游 DQ-FRESH-001/002/003（domain/data/quality-rules.js:76-80）已在数据质量侧产出过期问题，但优化侧没有消费者。 |
| `F13-03` | 证据包（十类快照） | P0 | 部分 | prepare 冻结 package_json={keywords,options,limits,profile,plan,prompts,before}（tools/optimize.js:275-297）+ rules_json 规则快照（schema.js:596-598；ruleSnapshot optimize.js:72-90）；tests/run.mjs:8904-8915 断言 fixed/evidence/contract 三层进包；report.js:134-142 「优化前」每次按当前 listing 重算 | 十类证据只冻结 4 类：当前文案、关键词包与位置计划计数、规则快照、Prompt 快照。缺 listing 历史、评论主题样本、QA、竞品机会、产品线事实与品牌语气、质量缺失项；每条证据没有「来源 / 时间 / 适用字段」三要素；没有只读冻结表或冻结后拒写守卫。 |
| `F13-04` | 优化模式（全量/增量/专项/审核） | P0 | 缺失 | 全库 grep incremental\|targeted\|OPTIMIZE_MODE\|optimizeMode\|full_mode\|audit_mode 无命中；tools/optimize.js:184-206 prepare 参数只有 asin/marketplace/keywords/maxKeywords/includeMaster/category/覆盖项/sessionId/dryRun；page.js:462-478 #panel-optimize 无模式控件；schema.js 无 mode 列 | 四种模式整体未建：没有模式字段、没有模式参数、没有页面控件，也没有增量模式的「存量单轮 ≤30%、优先阻断/事实错误/高价值缺口」幅度校验与专项模式（标题/五点/后台词/属性/A+/评论痛点/SEO·GEO/本地化）的字段范围收敛。 |
| `F13-05` | 策略阶段（先策略后文案 + 人工确认） | P0 | 部分 | prompt-seed.js:165-209 三层 assemble 提示词（fixed 固定策略层 / evidence 证据层 / contract 输出契约层）；resolvePrompts 在 prepare 取用并写入 run.package（tools/optimize.js:252-259、290-295）；页面「优化提示词专区」可编辑（page.js:596）；空库时明确告警（optimize.js:310-311） | 只有一份静态「写作策略」提示词。缺按 run 生成的九项策略卡（目标用户 / 核心差异化 / 购买疑问 / 事实边界 / 关键词优先级与所有权 / 字段分工 / 保留内容 / 风险待确认 / 修改幅度），缺「人工确认后进入生成」的门禁——prepare 直接把策略连同数据包交给 agent，没有确认步骤，页面也没有策略卡。 |
| `F13-06` | 位置计划核对（继承 08，不产生第二份口径） | P0 | 部分 | buildGlobalPlan 在 prepare 里先于任何文案生成（tools/optimize.js:229-234），但只存计数 plan:{positions,plannedCells}（:284）；位置权重表 EMBED_POSITIONS（domain/optimize/plan.js）；覆盖矩阵在 validate/面板/报告显示（run-view.js:118-128） | 没有 08 应用层位置计划的继承——模块 08 未建，quick-actions.js:76-82 明说所有权工作台阶段 1 没建。没有「本轮建议计划」的人工确认与写回 08 新版本；计划本身不落库（只存计数），无版本可核对，无法证明「本模块不产生第二份位置计划口径」。<br>⚠️ **订正（2026-10-13，`stale`）**：本格「没有 08 应用层位置计划的继承——**模块 08 未建**」**已被实测证伪**：位置计划持久层 **schema v35 就已建**（`store/schema.js:2358-2362` 迁移 `version: 35, name: 'keyword-plan'`；`:2397` `keyword_plan`、`:2415` `keyword_plan_entry`），配套 `store/keyword-plan.js`、五个工具（`tools/kw-plan.js:49/91/145/205/274`）、页面「存一版」路由（`web/routes.js:1832`）。⇒ **13 确实继承了 08 的持久计划**：`domain/optimize/position-plan.js` 从 `keyword-plan.js` 读（`:50` `import { getPlan, listPlans, savePlan }`），写回走 08 的 `savePlan`（`:489-490` 明写「本文件没有、也不会有 `INSERT INTO keyword_plan`」），`tools/optimize.js:2231/2243/2307` 同口径。**B-13c（`84fdb64`）已按实测做了真继承**（见 `COORDINATION.md` §7.3 的 2026-10-12 订正条）。<br>⚠️ **仍然成立的部分**：位置计划**不在优化运行内当场落库**（`buildGlobalPlan` 只存计数 `plan:{positions,plannedCells}`），这一点需按当前 HEAD 复验。详见文首订正页 D3-5。 |
| `F13-07` | 字段级生成与审阅（含决策四选） | P0 | 部分 | 字段词表 DRAFT_FIELDS/BULLET_FIELDS/MANUAL_FIELDS（listing-fields.js:80-196）、43 必填属性（tests/run.mjs:6104）；optimization_draft 存 before/after/rationale/keywords_json/violations_json（schema.js:482-490、606-608）；页面逐字段前后值+理由+违规+预算条（page.js:1891-1914、2069-2074）；报告行带 keywords/needsConfirmation（report.js:235-240） | 页面没有任何决策控件（无接受/拒绝按钮，routes.js 无对应 POST），四选只剩 amzn_optimize_save 的 accept[]/reject[]（tools/optimize.js:734-735）：「修改后接受」无记录、「稍后」=不入两表。缺逐字段置信度与结构化「风险待确认」（只有 needsConfirmation 布尔）；标题计数条是单刻度 used/max（page.js:1871），无 200 硬顶/75 目标双刻度；品牌第 1 位只是 warn 规则 title.brand.prefix（listing-rules.js:407），不是强制位置。 |
| `F13-08` | 校验体系（规则/闸门双面板 + Agent 审阅） | P0 | 部分 | 规则校验带 ruleId/severity/source（tools/optimize.js:606-620；listing-rules.js 的 CHECKS）；六道闸门 GATES（validate.js:484-574）与 runGates；工具输出与页面都把闸门与规则分开列（optimize.js:598-620；page.js:1947-1956 gateBlock + 违规 chips）；LLM_ONLY_CHECKS 11 项（listing-rules.js:1334-1346）；tests/run.mjs:5886、5900 | 规则校验 / 完成闸门双面板已分开（「合法≠完整」这半实现）。Agent 审阅那半只有一张静态清单：结论不落库、不逐字段，没有「自然度 / 说服力 / 品牌语气」条目，也没有「结论引用证据」的载体——prepare 与 validate 只是把 LLM_ONLY_CHECKS 打印给模型（optimize.js:459、621-622）。 |
| `F13-09` | 交付边界（可复制字段/操作清单/发布登记跳转） | P0 | 部分 | 报告含可复制字段（report.js:587、1000 pasteable）、独立编辑器字段清单（:602-606、1007-1009）、必须人工填的字段（:721-728、1090-1092）、Markdown+HTML 全文（renderMarkdown/renderHtml）；amzn_optimize_report 取回正文（tools/optimize.js:999-1041）；writebackSplit 写回口径（listing-fields.js:360）；全库无 Seller Central 按钮（仅散文引用） | 缺「记录实际发布值」跳转：发布登记表单存在，但 runId / 草案版本是空输入框（page.js:2207-2208），优化面板没有带预填的跳转链接。媒体 A+/图片/视频只有「独立编辑器字段」清单，没有操作清单。报告正文没有「接受草案 ≠ 已发布」的声明（该句只在模块 14 的表单提示 page.js:2213）。 |

**未判定/存疑**：

- 文档 §27.4 指定的原型 prototype/13-optimize.html（v1.1 含 #inbox 与 #precheck 锚点）在仓库中不存在——amazon-ops/prototype 目录整体缺失，无法核对 #precheck 的设计意图
- F13-07「修改后接受」是否由 validate 重写循环覆盖、还是需要独立记录，需求未定义，未据此单独判级
- 本轮只读作业，未运行 node tests/run.mjs（被禁止），故所有结论 confidence=read，未做 verified 复跑

### 3.14 模块 14 · 报告、实验、效果观测与回滚中心（文档 §28）

**整体结论**：模块 14 §6–§9（发布记录/偏离处置/观测前置检查/效果观测/实验设计/决策回滚）落地扎实，形成真闭环：登记→算差异→处置偏离→物化观测节点→数据前置检查→结论→回滚交付包→登记 kind=rollback 闭环并终止观测。node 实测 TOOLS=67 且含全部 10 个模块 14 工具；并实际执行了阈值、拒收、默认窗口等纯规则。缺口集中在报告侧：F14-01 十类只落 3 类且无收藏/标签/归档；F14-02 缺 Prompt/Agent/数据截止/实际发布值；F14-03 只有工具没有比较视图页；F14-10 无 Excel、无「非实时」声明；§28.4 的原型 prototype/14-reports.html 在整个工作区不存在。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `F14-01` | 报告库 | P0 | 部分 | reports.js:33 REPORT_KINDS=['optimization','kw-report','kw-export']；:202-229 listReports 支持 kind/asin/marketplace/since；page.js:479-503 报告专区面板+筛选条、:2529-2585 渲染（空库引导 2550-2558）；index.js:313 与 src/tools/index.js:141 两处注册表都有 amzn_report_list（node 实测 TOOLS=67）；search/index.js:243-264 报告进全局搜索。 | 十类报告只落 3 类：数据质量/采集/ASIN 健康/竞品差距/规则政策影响/Prompt·Agent 评估/发布后效果/运营汇总 八类无 kind、无写入方（recordReport 调用方只有 optimize 保存、kw 报告、kw/管道 CSV）。筛选缺 产品线/状态/创建者；无 收藏/标签/归档；全文搜索只查 title/ref_id/note，不含正文。 |
| `F14-02` | 优化报告标准 | P0 | 部分 | report.js:174-339 buildReportModel 单一模型；:358 renderMarkdown、:844 renderHtml 同源；摘要含规则集版本/埋词位置/字段数（365-366）；逐字段 前后值/rationale/ruleId/severity（225-242、528-570）；埋词位置+覆盖矩阵+分配（468-527）；8.2 本站不适用规则、8.3 不判定事项（651-675）；optimize.js:931-949 落 report_md/report_html。 | 摘要缺 §28.2 要求的 数据截止/Prompt 版本/Agent 流程/草案状态 四个显式字段（optimization_run 无 prompt_version/agent_run_id 列，schema.js:471-480）；字段级缺 置信度/风险，缺 实际发布值（report.js 全文无 publication 引用）；HTML 无目录导航与证据跳转（§28.4 报告详情）。 |
| `F14-03` | 比较视图 | P1 | 部分 | src/tools/report.js:147-301 amzn_report_diff 比两轮优化（同 ASIN/站点）；:187 diffGuard 不可比时给理由；:203-205 规则库版本变更单独告警；run-view.js:214-254 diffRunViews 分出新增/变更/移除/写入态四类差异；index.js:317 已注册（node 实测在 TOOLS）。 | 只有工具、没有页面：page.js:836-852 PANEL_RENDERERS 无比较渲染器，§28.4 的「比较视图」页缺。多 ASIN 对比、发布前后对比无实现；规则·Prompt 两版本只报一行「版本变了」的告警，不是真正的两版对比；草案 vs 实际发布值有 deviation（deviation.js:60）但不是可比较的视图。 |
| `F14-04` | 发布记录 | P0 | 已实现 | schema.js:1997-2049 v31 publication_record 建表，§28.2 各项列齐（run_id/draft_version/approved_json/published_json/deviation_json/operator）；amzn_publication_record/_list 在 TOOLS（node 实测）；routes.js:1063 POST publication-record；page.js:2194-2241 表单；manual 不计发布率 observe.js:339；无记录不显示「已上线」observe.js:200。 | — |
| `F14-05` | 偏离草案处置 | P0 | 已实现 | deviation.js:38 阈值 0.3、:46 CORE_FIELDS 取自 REQUIRED_CORE_FIELDS、:60-95 computeDeviation。本次实测：改核心字段→deviated=true/rule=core-field；10 字段改 4→ratio 0.60/rule=over-threshold。observe.js:275 setBaselineChoice、:797 waiting_human；routes.js:1098-1117；page.js:2298-2315 两个处置按钮；测试 m14-page.mjs:530 ⑪。 | — |
| `F14-06` | 观测前置检查 | P0 | 已实现 | metrics.js:353-400 checkObservationData（sufficient=至少一类有数据）；:303-329 补数清单带 module+prefill（去采集器/去关键词总库）；observe.js:1042 通知改写为「观测数据待补」。本次实测 refuteConclusion：blocked+keep 被拒并给出理由、blocked+insufficient 通过(null)、pending+keep 被拒；cardState(waitingHuman)=waiting_human；amzn_observation_check 已注册（node 实测）。 | — |
| `F14-07` | 效果观测 | P0 | 已实现 | plan.js:29 DEFAULT_WINDOW_DAYS=[7,14,30]（本次实测 checkpointSchedule 展开为第 7/14/30 天到期）；metrics.js:102-288 九类指标，:416-479 snapshotMetrics 带 绝对值/变化/样本量/来源/周期；observe.js:665「相关变化不自动归因」；observation_checkpoint 表 schema.js:2120-2142；amzn_observation_list/check/conclude/scan_due 已注册（node 实测）。 | 残余限制（代码已显式声明，非静默）：会话订单与退货差评主题两类在本仓无任何通道（metrics.js:187/283 availability='no'）；CTR/CVR 只有广告侧口径（:130/:162 partial）；BSR/评分评论 history='current-only'，change 恒为 null（:232/:248）。 |
| `F14-08` | 实验设计 | P1 | 已实现 | schema.js:2055-2081 observation_plan 九项设计字段齐（hypothesis/baseline_start/end/changed/unchanged/success/fail/window_days/confounders/rollback_conditions/rebuild）；plan.js:42-76 checkChangeBudget。本次实测：4/5=80% 未标 rebuild 被拒、标 rebuild 收下并记为重建、25% 通过；amzn_observation_plan_save 已注册；page.js:2317-2340 计划区块。 | — |
| `F14-09` | 决策与回滚 | P0 | 已实现 | observation.js:53 五结论闭集；observe.js:740-783 rollbackReadiness（末节点 30 天无改善才 ready，insufficient 不作依据）；:1199-1239 buildRollbackPackage（当前值/目标值/逐字段 diff/人工 steps）；:1251-1307 生成后 status=pending_publish「回滚待发布」；:1369-1393 登记 kind=rollback 后关任务并终止观测、原结论标「已回滚终止」(:989-1001)；无自动回滚（m14-publication.mjs:535 ⑩）。 | — |
| `F14-10` | 报告导出 | P1 | 部分 | optimize.js:931-949 同时产出 Markdown 与自包含 HTML 并存入 optimization_run.report_md/report_html；routes.js:1232-1245 GET <page>/report/<runId> 直接吐 HTML（可离线打开）；report.js:844-1112 renderHtml 内联 CSS；CSV 走 kw-export 并登记进 report 表（reports.js:33）。 | 无 Excel 导出：xlsx.js 只有 readWorkbook/readFirstSheet（读，:233/:262），全仓无 xlsx 写出器；导出件头部缺 报告 ID/对象/范围/来源/质量告警，且全仓 grep「非实时」0 命中；报告专区页无导出按钮，导出只能靠工具或直接访问 URL。 |

**未判定/存疑**：

- 文档 §28.4 指定的原型 prototype/14-reports.html 在仓库与整个 D:\deepseek-harness-h\workspace 下递归查找均 0 命中，无法判断是未提交、在别处，还是已废弃。
- tests/m14-*.mjs 本次未运行（任务禁止运行 node tests/run.mjs），因此「测试通过」未复验；三个 m14 测试文件中可 grep 到的具名 check 只有 9 条。
- 「十类报告」是否被规划到后续批次，v2.0 文档 §28 内无说明，无法判断是缺口还是有意分期。

### 3.15 模块 X · 跨模块需求（权限/通知/审计/非功能/新鲜度）（文档 §29–§33）

**整体结论**：模块 X（§29–§33）7 条全部 partial。骨架最实的是通知中心与审计日志：表、唯一写入者、去重、脱敏、只读、页面与工具齐备，但两者都缺生产方——通知 9 类触发只落 2 类，审计只挂在工具与页面两个漏斗，后台采集/关键词 worker 写库不留行。权限侧最薄：PERMISSION_LEVELS 只是 5 个词的词表（无 Agent 服务身份），无用户与角色身份，§29.2 五级动作分级与 §29.3 的 9×6 矩阵都无执行点；真正落地的是六个二次确认闸门与「收紧不可放宽」。§32 中可靠性、性能、可扩展性、凭据脱敏有实现，可用性缺权限不足与加载态、可访问性只有零星 aria、可观测性无统一运行 ID。§33 的 7/30/90 阈值、三条 DQ-FRESH 规则、政策生效日与站点核验日均在库，但阈值不可配置、优化运行不冻结时效判定。

| 编号 | 功能点 | 优先级 | 状态 | 证据（可复查） | 缺口 |
|---|---|---|---|---|---|
| `§29.1` | 权限层级（管理员/运营编辑者/数据管理员/审核者/只读查看者/Agent 服务身份） | P0 | 部分 | domain/states.js:99 PERMISSION_LEVELS=['workspace_admin','ops_editor','data_steward','reviewer','viewer']（5 个，无 Agent 服务身份）；同处 :95-97 自述阶段 1 无用户表（Q4），只作词表。读者只有两处：store/site.js:131-132 校验 site_verification.verified_by；catalog/datasets.js:36 的 ownerRole。store/audit.js:118 actor 恒写死 'local'。 | 缺「业务角色↔权限层级」映射（§3）与全部执行点：无用户/角色表、无会话身份，任何写路径都不问调用者是谁，也没有按层级拒绝的代码。6 个层级只落地 5 个，Agent 服务身份未定义。§29.1 目前是词汇表，不是权限模型。 |
| `§29.2` | 动作分级（只读/常规写入/批量·版本/破坏性/外部发布）与 Agent 权限约束 | P0 | 部分 | 五级未成表，靠审批闸门近似：domain/approval/policy.js:57-73 硬审批（自动发布/删历史快照/覆盖原始事实）、:82-125 六个可配置闸门（批量采集/覆盖字段/激活版本/归档/接受草案/标记发布），接在工具与页面写路径上（tests/s1b17-1-gates.mjs:216,279,308,379,394,452）。Agent 侧：domain/agent/roles.js:71-75 只读白名单、:202-206 角色工具白名单、:54-65 两个门禁；tests/m12-agent.mjs:411 断言无发布类工具。 | 没有「动作→级别」注册表：五级里没有一级被声明，闸门只覆盖 6 个动作，「常规写入需可撤销」无撤销机制。「Agent 权限不能高于发起者」无法实现——没有发起者身份（同 §29.1）。「不能绕过模块审批」只对 Agent 门禁成立，模块级审批未与之联动。 |
| `§29.3` | 默认权限矩阵（02 审批策略可收紧，不可放宽） | P0 | 部分 | 「收紧不可放宽」有实现：domain/approval/policy.js:165-198 setApproval 对 default===true 的项拒绝 enabled=false（APPROVAL_CANNOT_RELAX），:210-251 requireApproval 返回自带理由的裁决。测试 tests/s1b17-approval.mjs:296（硬/可配置九项不重叠）、:323（两处默认值不漂移）、:350（已开启的闸门关不掉且不写库）、:429。 | 矩阵本体（9 行关键操作 × 6 个角色）没有任何执行点：无角色身份，没有一处按角色拒绝操作；「02 审批策略」实现的是 6 个二次确认开关，不是矩阵的 9 个操作。六个闸门里 markPublished 自述无动作读它（policy.js:119-124），tests/s1b17-1-gates.mjs:469 把「没有动作的闸门」钉成显式名单。 |
| `§30` | 通知与待办（9 类触发 + 顶栏通知中心） | P1 | 部分 | 通知中心已实现：store/notification.js:53-107 按 dedupe_key 唯一索引 upsert、:119-154 列表、:171-202 已读/全部已读/按类型清理、:213-223 保留 30 天；顶栏面板 page.js:303 bell、:3867-3971 类型分组/清理/跳源对象；三条 POST routes.js:1169-1194；跨端同步走 SSE（page.js:5716 含 notification:）。生产触发只有两个：store/observe.js:1038 observation-due、:1057 rollback-ready。 | 触发清单 9 类只落了 2 类（7/14/30 天观测到期、达到回滚条件）。采集风控/失败、数据过期或冲突、管道部分失败、新政策待核验、规则/Prompt 待审批、Agent waiting_human、优化草案待审 共 7 类没有任何生产方调用 upsertNotification，面板上永远看不到它们（index.js:116 自述此前通知面板在生产里一直为空）。 |
| `§31` | 审计（每次写记录、批量影响清单、全局审计视图、只读不删、脱敏） | P0 | 部分 | store/audit.js:98-139 唯一写入者（:102-110 必填校验+白名单），:148-178 过滤读取，:186-194 统计；两个漏斗 tools/index.js:245-297（工具）与 web/routes.js:188-237（页面 POST）；批量 impact_json（tests/s1b12-audit.mjs:248）；脱敏 domain/audit/redact.js:65-76 递归走对象/数组/JSON 字符串；无删除（同文件:384）；页面视图 page.js:5121-5175（03 审计页签），读工具 amzn_audit_query。 | 覆盖不完整：审计只挂在两个漏斗上，后台服务直接写库不经漏斗——采集与关键词扫描 worker 写入的字段事实没有逐条审计行，只留一次提交动作。「完整敏感 Prompt 变量」未覆盖：SECRET_KEY（store/settings.js:383）按键名匹配，Prompt 变量若键名非凭据形状则原值入日志。 |
| `§32` | 非功能需求（可靠性/性能/可扩展性/可用性/可访问性/安全与隐私/可观测性） | P1 | 部分 | 可靠性：index.js:103-169 启动失败降级不拖垮宿主；collection.js:128,385、keyword.js:433 进度/取消/恢复；结构化错误 PROBLEM_CODES（states.js:152-164）。性能：服务端分页筛选排序（queries.js:297-298,501-502 LIMIT/OFFSET），按需切片（web/routes.js:1308-1349）。可扩展性：registry.js:1-51 适配器契约。安全：redact.js:65-76、tests/kw-report.mjs:630 断言密钥不出现在页面/日志。 | 可用性缺两态：有空态与「未就绪」，但没有「权限不足」（无权限模型，见 §29.1）与显式加载态。可访问性只有 aria-selected/aria-expanded（page.js:288,3880,3905）与 role="tab"，无键盘焦点管理与 :focus-visible。安全缺「外部连接必须显式授权」：Chrome 在首次采集时自动拉起（sources/cdp/launcher.js:1-18）。可观测性无统一运行 ID，logger 仅 2 处调用（routes.js:1224,1280），无业务/环境/系统错误分级。 |
| `§33` | 数据新鲜度默认值（7/30/90 天、政策生效日、可收紧、运行冻结判定） | P0 | 部分 | freshness.js:27-36 FRESHNESS_DAYS = 价格/BSR/评分/标题/竞品 7、Backend/属性 30、searchVolume 90；三条规则 quality-rules.js:76-81 DQ-FRESH-001/002/003（扫描 :171-189）；首页卡 health.js:102-134；政策发布日与生效日分列 policy.js:11,175-187；站点核验日 site/profile.js:70-98。tests/run.mjs:3471、s1b09-quality.mjs:150 钉死 7/30/90。 | 「阈值可按站点/产品线收紧、放宽需记录原因」未实现——freshness.js:5-8 自述阶段 1 不可配置（Q9/Q11）。「优化运行固定使用当时判定结果」未实现：优化 run 只冻结规则快照，不冻结时效判定，页面自述 DQ-FRESH 只产出问题、不在此阻断（page.js:4677）。规则口径基线 §71 的 `_EXPIRED` 标记全仓不存在。 |

**未判定/存疑**：

- 未运行 node tests/run.mjs（任务禁止），故所有「有测试断言」均为读断言名所得，未实测通过。
- 审计是否覆盖全部 POST 路由依赖 tests/s1b12-audit.mjs:289,342 的守卫断言，本次未执行，未实测。
- 后台服务写库未逐条审计是否在别处有补偿记录（如 collection_task.result_json / kw_pipeline_run），未逐条核。
- 「完整敏感 Prompt 变量」是否经其他路径脱敏（如 prompt 变量名恰含 key/token），未找到证据。
- 基线称工作树干净，实测 git status 有 README.md、docs/plugin-contract.md 改动与 amazon-ops/docs/COORDINATION.md、product-team/ 未跟踪项；非本模块产物，未复核。

## 4. 缺口聚类：88 条「部分」背后的四种形态

逐条读下来，88 条 partial 不是 88 个互不相关的小缺口，而是四种反复出现的形态。**形态决定修法，修法决定批次顺序。**

### 4.1 形态一：有出口、没有闭环（最普遍，也最便宜）

机制建好了、有表、有函数、甚至有测试，但**没有生产方写、或没有消费方读**。下面七条中带 ✅ 的是**主理人独立 grep 复核过**的，不是转述成员结论。

> ⚠️ **订正（2026-10-13，PM）**：下表前两条（`registerSnapshot`、`upsertFieldSource`）的 ✅「零调用方」
> **已被实测证伪**，行内已改标 ❌ + `stale`。**其余五条本次未逐条复验**，
> 但它们是**同一类全称否定断言**，**引用前必须重新 grep**（见 §1.4）。
> ⚠️ 并且：「✅ 复核过」当时为真、现在为假 —— **`verified` 是时点事实，不是永久属性。**

| 机制 | 建在哪 | 本该调用它的地方 | 现状 | 后果 |
|---|---|---|---|---|
| `registerSnapshot` | `src/store/snapshot.js:98` | 采集/优化/规则/提示词/竞品组的写入路径 | ❌ **订正（2026-10-13，`stale`）：实测 5 处生产调用方**——`store/queries.js:487`/`:1328`、`store/kw.js:474`/`:915`、`store/prompt.js:807` | 原文「快照表停在迁移回填那一刻」**已不成立**；「F05-04 listing diff 不可比 / F06-01 竞品组没有版本」的**成因**须独立复验 |
| `upsertFieldSource` | `src/store/field-source.js:81` | 采集写库路径 `upsertAsin` | ❌ **订正（2026-10-13，`stale`）：实测 2 处生产调用方**——`store/queries.js:247`（就在 `upsertAsin` 内）、`store/asin.js:141` | 原文「七列永远为空」**成因已不成立**（`queries.js:258/261` 显式传 `sourceType`/`observedAt`；`field-source.js:91-96` 按 kind 推）；「时效维度永不触发」须独立复验 |
| `assertWorkspaceWritable` | `src/store/workspace.js:152` | 站点/店铺/品牌/产品线/设置/数据源的写入点 | ✅ `src/` 下**零调用方**（只在注释里被提到） | F02-01 的「归档后只读」**只是一句文案**，归档空间仍可写 |
| `findImportByName` | `src/store/kw.js:46` | 导入去重 | ✅ 零调用方，**连测试都没调过** | 死代码 |
| `canSubmitDraft` | `src/domain/optimize/context.js:41-68` | 优化草案提交 | 零调用方 | 优化侧缺一道上下文守卫 |
| 健康卡 `detailLink` | `src/domain/dashboard/health.js` | `page.js` 的卡片模板 | 无消费方（`todos`/`actions`/`recent` 三者都有，只有卡片没有） | F01-02「每卡可追到明细对象」只做到「打印来源表名」 |
| 审计漏斗 | `routes.js` 的 `pageWrite` + `tools/index.js` 的 `instrument` | 后台采集 / 关键词 worker 的写库 | 只挂了「工具」与「页面」两个漏斗 | §31 要求「全部写操作」留痕，worker 写库不留行 |

**这一类是性价比最高的一批**：不动表结构、不写新页面，只把已有的调用点接上，就能一次性点亮多条 P0 验收。

### 4.2 形态二：工具与页面各做一半

| 例子 | 有工具 | 有页面 | 缺的那半 |
|---|---|---|---|
| F14-03 比较视图 | ✅ `amzn_report_diff` | ❌ | 只有工具，没有比较视图页 |
| F03-06 审计检索 | ✅ `amzn_audit_query` 支持 `from/to` | ⚠️ | 页面筛选控件没有时间范围 |
| F02-02 站点档案 | ❌ 无 `amzn_site_*` | ✅ 设置页有 | Agent 读不到站点口径与核验日期 |
| F04-04 外部入口预填 | 生产者已存在（模块 14 的补数建议带 `prefill`） | ❌ | 页面不读 `prefill`，来源横幅与字段范围预填都没有 |

### 4.3 形态三：声明性未接入（「还没做」这句话过期了）

仓库里有些地方**明确声明某个能力未接入**，但被依赖的东西后来已经交付了——声明没跟着更新，功能就被永久关在门外。

- **F01-05 快捷动作**：`optimize-prepare`（生成优化准备包）仍标 `available:false`，理由写的是「阶段 1 不做模块 12，导航里没有这一项」。而模块 12 已在 `253871e` 交付（`MODULE_GROUPS` 有 `agent` 组、有渲染器、6 个工具），目标锚点已可达。**更麻烦的是测试 `s1b14-quick.mjs:321` 把这条过期现状钉死了**——修它要连测试一起改。
- **F01-06 全局搜索**：SKU 一类声明不可检索（库里确实没有该列）——这是**诚实的不可用**，不算缺口，但验收时要与真缺口区分开。

### 4.4 形态四：整块缺失（21 条），按依赖聚成四簇

| 簇 | 缺失点 | 共同前置 |
|---|---|---|
| **采集侧** | F04-06 waiting_human、F04-07 13 节详情、F04-09 采集方案、F04-10 计划采集 | 需要新表（方案/计划）与任务状态机扩展；F04-07 依赖 F04-09 的方案版本 |
| **ASIN 侧** | F05-02 九 Tab 详情、F05-06 父子变体、F05-08 归档与恢复 | F05-06 要新表（变体关系）；F05-02 是纯页面聚合，但依赖 13 节（F04-07） |
| **资产中心柱子** | F08-04 关键词所有权、F08-07 生命周期、F06-03 对比矩阵、F06-05 口碑主题、F06-06 变化监测 | F08-04/07 要新表；F06-05 要**评论正文通道**（当前全仓对评论只有一个数量 `asin.reviews`） |
| **智能执行侧** | F11-05 提示词生命周期、F11-07 固定评估集、F11-08 双版本对比、F12-05 编排模式、F13-02 前置检查九项、F13-04 优化模式 | F13-02 依赖模块 03 的 DQ 问题**有消费者**；F11-07/08 要有固定输入快照 |

### 4.5 一个必须说清的边界

**21 条 missing 里有 4 条不是「没做」，而是「做在别的对象上」**：

- `source` 表（采集通道）不是 F09-02 要的 D1–D5 关键词来源库；
- `asin_ownership`（ASIN 归属）不是 F08-04 要的关键词所有权；
- `field_conflict`（ASIN 字段冲突）不是关键词级冲突；
- `workspace` / `snapshot_registry` 的归档不是 F05-08 要的 ASIN 归档。

> ⚠️ **订正（2026-10-13，用户裁决，本次实测）**：本表第 2 行的 `共同前置`「F05-06 要新表（变体关系）」
> **已过期** —— 变体关系**三张表在 schema v37 就建好了**（`store/schema.js:2632` / `:2656` / `:2682`）。
> 同时 **F05-06 的「父体从采集得到」已裁决为非目标**（父体由人工/工具写入，见 §3.5 的 F05-06 条与文首订正页 D6）。
> ⇒ 引用 §4.4 排批次时，**这一行的「缺失」性质已变**：它今天缺的不是表，是**消费方**（重复/矛盾检测的出口与父子层所有权）。

排批次时**不能拿这些当「已有基础」抵扣工作量**——本仓历史上正是「两个数都是 14 就以为对齐了」这种数数法掩盖过缺口。

## 5. 批次建议：先接线，再造新模块

排序原则两条：

1. **先接线、后补缺**。形态一（§4.1）不动表结构、不加新模块，却能一次点亮多条 P0；形态四（§4.4）每条都要新表 + 迁移 + 页面，成本高一个量级。
2. **按 §37 的实施顺序与依赖排**，不按模块号排。上游没接线，下游补了也是空转（例：F13-02 的前置检查要消费模块 03 的 DQ 问题，而 DQ 问题今天没有消费者）。

| 批次 | 内容 | 依赖 | 预估热文件 | 为什么排这个位置 |
|---|---|---|---|---|
| **W1 接线批**（建议下一批） | §4.1 的七条 + §4.3 的过期声明 | 无 | `queries.js` / `routes.js` / `page.js` / `tools/index.js` | 不动 schema、不加表；一次点亮 F01-02 / F02-01 / F03-02 / F03-05 / F05-03 / F05-04 / F06-01 / §31 的验收 |
| **B-04 采集中心** | F04-06/07/09/10 + F04-01/02/03 的缺半 | W1（F04-07 依赖快照与溯源接线） | `schema.js`（+v33）/ `collect.js` / `page.js` | 阶段 2 数据入口；13 节是模块 05 详情页的前置 |
| **B-05 ASIN 详情与变体** | F05-02/06/08 + F05-01 的 11 列 | B-04（13 节） | `schema.js`（+v34）/ `asin.js` / `page.js` | 详情页是运营每天打开的页面，价值密度最高 |
| **B-08 资产中心柱子** | F08-04 所有权、F08-07 生命周期 | W1 | `schema.js`（+v35）/ `kw.js` / `page.js` | 「一词一主」是总库的核心承诺，今天只在优化运行内判定、不落库 |
| **B-13 优化前置与模式** | F13-02 九项门槛、F13-04 四种模式 | W1（要 DQ 消费者） | `optimize.js` / `page.js` | 让「数据过期 → 优化被阻断」这条跨模块联动真正成立 |
| **B-06 竞品情报** | F06-03/05/06 + F06-01/02/04 的缺半 | B-08（竞品组版本化）；F06-05 需先建评论正文通道 | `schema.js` / `competitor.js` / `page.js` | 依赖最多，排在后面 |
| **B-11 提示词资产化** | F11-05/07/08 + F11 的缺半 | B-13（要运行侧引用反查） | `schema.js` / `prompt.js` / `page.js` | 评估集与双版本对比要有固定输入快照，快照来自 W1 |
| **B-12 Agent 编排补全** | F12-05 + F12-02/03/06/09 的缺半 | B-11 | `agent.js` / `page.js` | 编排模式依赖上下文包与提示词生命周期定型 |

### 5.1 每一批的通用门禁（照抄即可）

- **开工前**：在 `docs/COORDINATION.md` §3 认领表留一行（批次号 + 当班写者 + 目标）。
- **G2 设计门禁**：接口契约（入参/出参/错误码）、数据变更的迁移与回滚、非功能要求的数字。
- **实现**：`node tests/run.mjs` 全绿且断言数**只增不减**；`node scripts/check.mjs` 报 `OK`。
- **G3 发布门禁**：验收标准逐条有证据（命令 + 返回 + 关键行，或截图）；无 P0/P1 未决缺陷；有回滚方案；发布说明已写。
- **收尾**：按 `docs/COORDINATION.md` §2.1 留交接条（含「在途」一项）。

---

（§1–§3 由 workflow 审计结果自动汇总生成；§4–§5 由主理人撰写。全部结论的证据等级见各条「置信度」列与 §1.3。）

# amazon-ops — DSH 插件设计文档

> 草案 v0.7 · 2026-09-21
> 状态：**第 0、2、3、4 步已落地并验证**（数据模型 + 插件骨架 + 互联互通机制 + 浏览器采集 + 关键词总库 + 优化与报告）。
> 已定项与遗留问题见 §9，实施进度见 §10。
> v0.2：调研三家第三方源。
> v0.3：**存储定为 SQLite；报告定为 Markdown + HTML；采集通道定为「现在浏览器 / 后期 API·MCP」**。
> v0.4：第 0 步实现完成；进度推送由 WebSocket 改为 **SSE**（§7），页面路由落地（§6.1）。
> v0.5：第 2 步（采集）完成 —— 零依赖 CDP 客户端、Amazon 抽取器、限速采集器、任务生命周期。
> **新增站点切换（§4.2.1）**：只改域名不够，配送地址必须走 UI 改，语言靠 `lc-<站点>` cookie。
> 插件已纳入 git 仓库 `workspace\dsh-plugins`（仓库根即本地插件根，见该仓库 README）。
> v0.6：第 3 步（关键词总库）完成 —— 分层算法、发现、覆盖扫描、任务表按 `kind` 分区、5 个工具、关键词面板。
> **新增 §4.2.2 关键词来源（实测）**；§3.2 补 v5 迁移；**「已测缺口」与「从未测」是两个概念**（§3.2）。
> v0.7：第 4 步（优化 + 报告）完成 —— 迁移 v6、**48 条机检规则目录**、字段预算（字节/字符分开）、
> 埋词计划、双渲染报告、4 个工具、优化队列面板 + 报告路由。自检 105 → **145 条**。
> **新增 §5.7 规则引擎与预算的分工**、§6.4 补「读一个没人写的字段」这类静默失败、§10 第 4 步验证记录。
> v0.8：**针对「字段不全 / 优化深度不够」的两处返工** —— 迁移 v7（`listing` 补 `item_highlights`）、
> 规则 48 → **72 条**、埋词位置 11 → **12 个**、**全局埋词计划**（四矩阵 + 三不变量）、
> **站点档案**（20 个站点，US/CA 有核验来源）、**43 个必填属性**、**六道收尾闸门**、
> 全量字段词汇表（11 节 / 32 草稿字段 / 52 属性）。自检 145 → **173 条**。
> **新增 §5.9 全量字段、§5.10 优化深度（全局计划）、§5.11 站点档案、§5.12 收尾闸门**。
> v0.8.1：清掉「计划给出做不到的要求」这一类问题 —— 分层决定位置而不是排名（㉙）、
> 标题容量按重复规则计算（㉚）、支持位按词而不是按句比对（㉛）、报告只用一个计数来源（㉜）。
> 自检 173 → **176 条**；新增 `tests/make-sample-report.mjs` 生成**全量字段示例报告**
> （75 个字段 / 0 阻断 / 闸门 6/6 / 埋词完成度 86%）。
> v0.9：工作台导航分组（5 组 12 模块）+ 空状态；**规则集从代码搬进库**（迁移 v10，
> `rule_set` / `rule`，72 条全部 `kind='code'`）；规则可用化（4 个工具 + rules 页签 +
> `rule-toggle` 路由）；**手册可导入为 `doc` 行**（B02c，只写正文与出处，绝不动判定）。
> v1.0：**政策库**（迁移 v11，B03）—— 用户第 8 项需求「最新政策」，是规则管道的上游
> （政策是输入、规则是产物）。3 个工具 + 政策页签 + `policy-link` 路由；发布/生效分列、
> `severity_hint` 可空显示「未判定」、`superseded_by` 自引用可追。**不做抓取**（公告页有
> 风控，抓失败会被误读成「没有新政策」）。**新增 §5.13**。
> v1.0.1：迁移 v12 —— **归一化值必须带原词**（`severity_raw`）。`severity_hint` 单独存在会
> 冒充事实（「严重度：高」读起来像亚马逊的分类，其实是我们从「必须立即整改」推出来的），
> 所以另存可查询的一列，页面画「高（原文：「必须立即整改」）」。自检 357 → **358 条**。
> v1.0.2：B03 五处收口 —— **日期做日历校验**（`2026-02-30`/`2026-04-31`/`2026-02-29` 一律留
> NULL，不存在的日期入库比 NULL 更糟）；生效日期认「**自 X 起**」这类日期在前的写法；**取代折
> 进 `amzn_policy_import` 的 `supersedes`**（同事务、未知 id 具名拒绝、重复取代拒绝、回边整链
> 走）—— `supersede()` 此前**零调用方**；`sinceExcluded` 改**跟着查询自己的筛选走**。自检
> 358 → **≥365 条**。
> v1.0.3：**档位与原词的配对从解析层提到 store 层**（`importPolicy` 强制「同生同灭」，给了档位
> 不给原词按名字拒绝）—— 不变式加在**资源边界**而非调用者的任务边界。页面 `PROMPT_SETS.policy`
> 补一条「导入并取代」（取代只走 agent，页面只读展示，不加路由）。自检 362 → **363 条**。
> v1.0.4：**修尾随生效词的回归** —— B03 上一版把「`生效`/`执行`/`施行`」**替换**成了
> 「`起…`」一类，弄丢了前一类。改为**并集**（两类都收，边界同样收紧），一条 check 里 6 种
> 形式各一条断言 + 2 条反例。check 数不变（363）。
> v1.0.5：**提示词库（B04，schema v13）** —— 页面按钮（`PROMPT_SETS`）和 `amzn_optimize_prepare`
> 的写作策略一起从代码搬进库（`prompt_set` / `prompt`）。模板只有两种构造、变量是闭集、渲染器
> 不增删字符；不变式加在 store 层。`PROMPT_SETS` 从 `page.js` 删除，按钮由服务端解析器渲染后随
> `state.prompts` 下发。⑤ 逐字节一致由 pre-B04 快照（12 模块 × 8 变体）对**种子**和**库行**各证
> 一遍。详见 §5.14。check 数 363 → **376 条**。

---

## 0. 一句话目标

**打开 DSH，用对话驱动亚马逊运营全流程** —— 采集 → 关键词 → 优化 → 报告，
数据、工作台、agent 都在 DSH 里，不依赖外部系统。

---

## 1. 定位与非目标

### 是

一个**独立的 DSH 本地插件**，自带存储、自带领域逻辑、自带工作台页面。

### 不是

- **不是** `D:\amazon-ops-hub` 那套 FastAPI 系统的客户端。
- **不改动** amazon-ops 仓库（它的 `AgentChat` 等一切照旧，两套并存互不干扰）。

### 复用原则

amazon-ops 作为**参考实现与领域规则来源**，只搬领域资产，不搬架构。

| 搬（领域资产，DSH 没有） | 别搬（DSH 已经更强） |
|---|---|
| 关键词归一化 + T1–T4 分层 | `listing_workflow_service.py` 的 2416 行编排 → 由 agent loop 替代 |
| 规则快照 + 合规校验 | `llm_service.py` 双协议 → 用 DSH 的 LLM 服务 |
| 字段预算裁剪 | `agent_service.py` 的 Planner-Executor → 用 DSH agent |
| `04-agents` 的 24 SOP / 10 规则 → **DSH skill** | 自研 SSE、JWT 鉴权 → 用 DSH 的 |

> ⚠️ **那 2416 行编排在 DSH 里是负资产。** 搬过来等于把 agent 关进固定流程，
> 而 DSH 的价值恰恰是让 agent 自己决定怎么走。

---

## 2. 架构分层

```
DSH Host（对话 / Agent 循环 / 工具注册表 / LLM）      ← 已有，不重写
        │
   ┌────┴─────────────────────────────────────┐
   │  amazon-ops 插件                          │
   │   工具层  ctx.tools.register(...)         │
   │   页面层  webServer.register(...)         │
   │   WS 层   webServer.registerUpgrade(...)  │
   └────┬─────────────────────────────────────┘
        │
   领域层（归一化 / 分层 / 合规校验 / 字段预算）
        │
   存储层（SQLite）
        │
   数据源适配层   ← 可插拔，两种 kind 对上层同构
     ├─ kind='browser' CDP / Playwright（自有账号）    ← 现在实现
     └─ kind='api'     卖家精灵(MCP) / 西柚 / 赛狐      ← 后期有预算再接
```

**关键约束（已实测）**：DSH 本地插件只有两种挂载点 ——
`ctx.tools.register()` 注册模型工具，`ctx.inject(['webServer'], ...)` 注册 HTTP 路由
（以及 `registerUpgrade` 注册 WebSocket）。没有构建链、没有 Vue。
参考实现：`workspace/dsh-plugins/user-console/`（单文件 777 行，挂了一个 `/custom/vault` 页面）。

---

## 3. 数据模型（草案）

**存储已定：SQLite**（§9），下面的 DDL 就是实际模型。
所有表带 `marketplace`，因为**同一 ASIN 在不同站点是不同商品**，唯一键是 `(asin, marketplace)`。

### 3.1 主表

```sql
-- 数据源注册表
source(
  id            TEXT PRIMARY KEY,        -- 'cdp-local' | 'sellersprite' | 'xiyou' | 'saihu'
  kind          TEXT NOT NULL,           -- 适配器类型
  name          TEXT NOT NULL,
  enabled       INTEGER DEFAULT 1,
  config_json   TEXT,                    -- 凭据、额度、限速
  last_health   TEXT,                    -- 最近一次健康检查结果
  checked_at    TEXT
)

-- 产品线
product_line(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT
)

-- ASIN 主表（当前生效值）
asin(
  asin            TEXT NOT NULL,
  marketplace     TEXT NOT NULL,          -- 'US' | 'DE' | ...
  title           TEXT,
  brand           TEXT,
  price           REAL,
  bsr             INTEGER,
  rating          REAL,
  reviews         INTEGER,
  product_line_id TEXT REFERENCES product_line(id),
  primary_source_id TEXT REFERENCES source(id),   -- 整体主源
  first_seen_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (asin, marketplace)
)

-- 每次采集的完整快照（支持多源对比 + 趋势）
asin_snapshot(
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  asin         TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  source_id    TEXT NOT NULL REFERENCES source(id),
  collected_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
)

-- 字段级来源（§4 的 provenance 落地）
asin_field_source(
  asin        TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  field       TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  value       TEXT,
  confidence  REAL DEFAULT 1.0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (asin, marketplace, field, source_id)
)
```

### 3.2 关键词

```sql
keyword(
  keyword      TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  tier         TEXT,                       -- T1–T4；NULL = 从未扫描
  search_volume INTEGER,
  difficulty   REAL,
  source_id    TEXT REFERENCES source(id),
  first_seen_at TEXT,                      -- 第一次见到它是什么时候（历史，不被覆盖）
  tier_basis_json TEXT,                    -- 分层的依据快照，可回溯
  tags_json    TEXT,
  note         TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (keyword, marketplace)
)

-- ASIN ↔ 关键词 关联与覆盖
asin_keyword(
  asin         TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  rank         INTEGER,                    -- 自然位排名；NULL 有两种含义，见下
  page         INTEGER,                    -- rank 落在第几页
  scan_depth   INTEGER,                    -- 这次扫描看了多少条自然结果
  tier         TEXT,
  tier_basis_json TEXT,
  search_volume INTEGER,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (asin, marketplace, keyword, source_id)
)
```

> ⚠️ **`rank IS NULL` 有两种含义，必须靠 `scan_depth` 区分** —— 这是第 3 步最重要的一条设计：
>
> | `rank` | `scan_depth` | 含义 | 分层 |
> |---|---|---|---|
> | 有值 ≤16 | 有值 | 第一页就能看到 | **T1 守位** |
> | 有值 >16 | 有值 | 排名在，但不在第一页 | **T2 冲刺** |
> | NULL | 有值 | **测过了，前 N 条里没有它**（真缺口） | 看 listing 是否含该词 → **T3 抢占** / **T4 观察** |
> | NULL | NULL | **从来没测过**（盲区，不是缺口） | **NULL，不下结论** |
>
> 早期版本把 `rank IS NULL` 一律当缺口，结果一个刚入库、一个词都没测的 ASIN 会显示
> 「覆盖 0/50」——把「没测」说成了「测了没有」。分层算法因此宁可返回 `NULL` 也不猜。
> `scan_depth` 就是让 `NULL rank` 可读的那一列。

**分层规则**（`src/sources/keyword-tiers.js`，纯函数、不碰库也不碰浏览器）：

- **T1 守位**：自然位在第一页（≤16）→ 要守，别动它。
- **T2 冲刺**：有自然位但在第一页之后 → 值得往第一页推。
- **T3 抢占**：测过、没排名，但**当前 listing 文案里含这个词** → 平台认为相关却没给排名，最该优化。
- **T4 观察**：测过、没排名，listing 里也不含 → 相关性还没建立。
- **`tier: null`**：从未扫描。

> `keywordInText` 把分隔符（`-` `_` `/` `\`）归一成空格，所以 `flip 7` 能匹配 `Flip-7 Portable`；
> 拉丁词要求非字母数字边界（`car` 不匹配 `cart`），中日韩直接子串匹配。

### 3.3 Listing 与优化

第 4 步实际落地的形状（v6 迁移之后）：

```sql
listing(
  asin        TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  title       TEXT,
  bullets_json TEXT,                       -- 五点描述
  description TEXT,
  a_plus      TEXT,
  search_terms TEXT,                       -- 后台词：只在卖家后台，采集永远拿不到，只能人工给
  attributes_json TEXT,
  source_id   TEXT,
  version     INTEGER DEFAULT 1,           -- 每次写入 +1，报告要能说「当时判的是哪一版」
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (asin, marketplace)
)

optimization_run(
  id            TEXT PRIMARY KEY,          -- uuid
  asin          TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  status        TEXT NOT NULL,             -- running | done | failed
  session_id    TEXT,                      -- 关联的 DSH 会话，用于回溯「当时怎么想的」
  rules_version TEXT,                      -- 规则快照：三月的报告六月还要能解释
  rules_json    TEXT,
  package_json  TEXT,                      -- prepare 时给出去的数据包（含埋词计划）
  summary       TEXT,
  error         TEXT,
  report_md     TEXT,                      -- Markdown 是真相源
  report_html   TEXT,                      -- HTML 是渲染出来的视图（§5.8）
  started_at    TEXT NOT NULL,
  finished_at   TEXT
)

optimization_draft(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES optimization_run(id),
  field       TEXT NOT NULL,               -- title | bullet_1 … | description | search_terms
  before      TEXT,
  after       TEXT,
  violations_json TEXT,                    -- 合规校验结果（含规则 id 与文档出处）
  keywords_json   TEXT,                    -- 这个字段埋了哪些词
  severity    TEXT,                        -- block | warn | NULL
  rationale   TEXT,                        -- 为什么这么改（报告里逐字段显示）
  accepted    INTEGER,                     -- NULL 待定 / 0 弃用 / 1 采用
  updated_at  TEXT,
  UNIQUE (run_id, field)                   -- 重新校验是「替换判定」，不是再堆一行
)
```

> **`UNIQUE (run_id, field)` 是必须的。** 没有它，同一个字段校验两次会有两行、
> 带两套不同的违规结论，而**两套都不算错** —— 报告里同一个字段出现两遍，
> 读者无法判断哪份是最终版。迁移里还先跑一遍
> `DELETE … WHERE id NOT IN (SELECT MAX(id) … GROUP BY run_id, field)`，
> 这样老库也不会因为建唯一索引而迁移失败。

### 3.4 采集任务

```sql
collection_task(
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES source(id),
  targets_json TEXT NOT NULL,              -- [{asin, marketplace}]
  fields_json  TEXT,                       -- 只取这些字段，NULL = 全部
  kind         TEXT,                       -- 'asin' | 'keyword'，见下
  status       TEXT NOT NULL,              -- queued | running | done | failed | partial
  submitted_at TEXT NOT NULL,
  finished_at  TEXT,
  error        TEXT,
  result_json  TEXT
)
```

> ⚠️ **一张任务表装两种任务，`kind` 就是那条分界线。** 关键词扫描复用采集器的浏览器与任务表
> （否则要再起一套 Chrome），但**崩溃恢复必须按 `kind` 分区**：不分区的话，一个关键词扫描
> 任务会被交给 ASIN 采集器，里面每一条都会被当成畸形 ASIN 拒掉，表现为「扫描任务失败，
> 原因全是 ASIN 格式错」——一个跟关键词毫无关系的报错。
> 迁移 v5 给老行回填 `kind = 'asin'`，恢复查询用 `COALESCE(kind, 'asin') = ?`。


**工作台上下文（选中项 / 筛选 / 当前模块）不进数据库** —— 它是 UI 状态，
放插件进程内存即可，重启丢失可接受。

---

## 4. 数据源适配层

### 4.1 接口

```ts
interface SourceAdapter {
  readonly kind: string

  /** 声明这个源能提供哪些字段、有什么限制。agent 靠它决定问谁。 */
  capabilities(): {
    fields: string[]          // ['title','price','bsr','rating','reviews','keywords', ...]
    requiresAuth: boolean
    rateLimit?: string
    notes?: string
  }

  /** 实际采集。长任务应尽快返回，由 collection_task 跟踪进度。 */
  collect(req: CollectRequest): Promise<CollectResult>

  healthCheck(): Promise<{ ok: boolean; detail?: string }>
}

interface CollectRequest {
  targets: Array<{ asin: string; marketplace: string }>
  fields?: string[]
  options?: Record<string, unknown>
}
```

### 4.2 传输策略：现在走浏览器，API/MCP 留接口

> 2026-09-21 更新。原假设"三家都没有开放接口"不成立 —— **三家都有官方 API**，
> 但**都要单独付费**，而我们手上只有普通会员账号、没有接口额度。
> 所以真实约束不是"有没有接口"，而是**现在买不买得起**。

#### 调研结果（含真实价格门槛）

| 源 | 官方开放情况 | 门槛 |
|---|---|---|
| **卖家精灵** | 开放平台**按接口**订阅；另有 MCP 服务（**45 个工具**，覆盖 ASIN / 关键词 / 流量 / ABA / 市场 / 评论 / 商标） | ASIN 详情 **¥988/月**、查竞品 **¥2,999/月**、关键词选品 ¥2,988/月、查评论 **¥9,999/月**（各含 1–5 万次/月）。MCP 需开放平台的 `secret-key`，同样要先开额度 |
| **西柚** | `platform.xydc.com/openapi`，关键词 + ASIN | **按 ASIN 计费** |
| **赛狐** | 11 大板块、60+ 接口 | 需联系客户经理开通 |
| **自有账号 + 浏览器** | 无官方接口 | **¥0**，成本是维护 + 账号风险 |

→ **结论：现阶段走浏览器通道。** 上表也解释了为什么 —— 光一个 ASIN 详情的月费就是 ¥988，
而会员账号已经能看到同样的页面。

#### 分阶段落地

| 阶段 | 通道 | 形态 |
|---|---|---|
| **现在** | `kind='browser'` | CDP 驱动本机 Chrome（独立 profile + 会员登录态），抓亚马逊前台页与三家平台网页端 |
| **后期有预算** | `kind='api'` | 卖家精灵 = **MCP 客户端**；西柚 / 赛狐 = HTTP API |

**两条通道对上层完全同构**：`amzn_collect_submit(source, ...)` 不用改，agent 也不用知道区别。
这正是 `SourceAdapter` 抽象存在的理由 —— 现在写 browser 实现，以后加 api 实现，**上游零改动**。

#### 卖家精灵的接入成本极低（值得记一笔）

它的 MCP 是 **streamable-http 端点**：`https://mcp.sellersprite.com/mcp?secret-key=<密钥>`
（密钥在开放平台「我的密钥」页）。DSH 自带 MCP client 就支持这个传输，
所以将来接入 = **一个 MCP 客户端 + 一次归一化**，不用逐个封装 45 个 REST 接口。
它 45 个工具里的 `traffic_keyword`（流量词反查）、`keyword_order`（出单词反查）、
`aba_research_weekly/monthly`、`keyword_miner` 正好是关键词总库分层的输入 —— 以后接上会质变。

#### 浏览器通道的设计要求

采集器是**易碎资产**（页面结构会变、会被风控），所以：

1. **独立 Chrome profile**，与日常浏览器隔离；登录态持久化 —— 频繁重登本身就是风控信号。
2. **人类化节奏**：随机延迟、非匀速移动、逐字输入；**不要裸 headless**，用真 Chrome。
3. **限速与配额**：每任务限 N 个 ASIN、任务间随机间隔、按源分别设上限。
4. **遇风控即停**：撞到验证码 / 异常页立刻停下并如实报告，**不重试、不绕过**。
5. **`healthCheck()` 必须真做**：页面结构变了要报「选择器失效」，而不是静默返回空数据。

> ⚠️ 仍要说清楚：**"模拟真人操作就不被监控到"做不到**。风控看的是行为指纹
> （鼠标轨迹、时序、IP、设备指纹），上面 5 条只是**降低**被识别的概率。
> 用**专用账号**，别动主账号；网页端抓取同样受平台条款约束，风险由使用者承担。

### 4.2.1 站点切换：只改域名不够（2026-09-21 实测）

需求原话是「采集的时候站点要修改成对应的站点，避免数据混乱以及语言不对」，
以及「你要点击改变地址才能到对应的站点，因为我现在所在的环境是中国国内的网络」。

#### 实测：中国网络下 amazon.de 的真实表现

| 观测项 | 值 | 说明 |
|---|---|---|
| 配送地址 | `Deliver to China` | **由请求 IP 推导**，URL 里没有任何线索 |
| 币种 | `i18n-prefs=CNY` | 德国 listing 报价是人民币 |
| 界面语言 | `lc-acbde=en_GB` | 英文页 |
| `lc-main=de_DE` | 无效 | **`lc-<站点>` 胜过 `lc-main`** |

→ 结果是：一个德国商品，返回**英文标题 + 人民币价格**。每一项字段都能解析出来，
价格也像个正常的数字，**但全都是错的** —— 这正是最危险的一类失败。

#### 三个杠杆，只有一个能改配送地址

| 杠杆 | 能改什么 | 能不能伪造 |
|---|---|---|
| `i18n-prefs` cookie | 币种 | ✅ 能，直接 set |
| `lc-<站点>` cookie | 界面语言 | ✅ 能，但**名字要现场读**（见下） |
| **配送地址** | 币种 + 配送/库存 | ❌ **不能** —— 存在服务端，只能点 UI |

`lc-<站点>` 的名字（amazon.de 是 `lc-acbde`）**不能猜**，所以是**从当前页面读出来**再改，
这样没见过的站点也适用。

#### 关键发现：国家下拉里没有本站点自己的国家

"Deliver to" 弹窗里有个国家 `<select>`，直觉是选目标国家。**这条路走不通**：
**这个清单列的是「可以从本站点寄往的国家」，所以不含站点自己的国家。**

实测 amazon.de：242 个选项，`hasUS: true`，**`hasDE: false`** ——
你没法在 amazon.de 上选「德国」，因为你已经在那儿了。

**能走通的是邮编**：Amazon 会把邮编解析成国家并自己改写配送地址。

| 站点 | 弹窗形态 | 有效杠杆 |
|---|---|---|
| amazon.de | 国家下拉 + 邮编框 | **邮编**（`10115` → `10115 Berlin`） |
| amazon.com | 只有邮编框 | **邮编**（`10001` → `New York 10001`） |

→ 所以 `MARKETPLACES` 每个站点都带一个**代表邮编**，国家下拉只在能选到时顺手选一下。
两处都实测通过（DE：`China` → `10115 Berlin`；US：`China` → `New York 10001`）。

#### 实现

- `src/sources/pages/amazon-session.js` → `ensureStorefront()`：套用币种与请求头 →
  按页面上读到的真实名字修正语言 cookie → 打开弹窗填邮编 → 重载 → **再读一遍**并如实报告。
- `src/sources/cdp/launcher.js` 启动独立 Chrome profile，登录态与配送地址都留在里面，
  所以**切换是一次性成本**：第二次采集同一站点不需要再改（实测 58.7 秒 → 14.9 秒）。
- 校验分**阻断项**与**提示项**（§4.4 的 `verifyStorefront`）：站点域名 / 语言 cookie / 币种不符
  → 拒收不写库；`documentElement.lang` 与配送地址 → 只提示。
  理由：`lang` 属性实测**不可靠**（DE 上下文下报过 `en-gb`），而配送地址**改不动时不该丢掉一个本来正确的页面**。

### 4.2.2 关键词从哪来：三条路都实测过（2026-09-21，amazon.com）

关键词不是拍脑袋来的。写代码之前先探针实测了三种取词方式，结论决定了实现：

| 方式 | 实测结果 | 用不用 |
|---|---|---|
| 页面内调 `completion.amazon.com/api/2017/suggestions` | **200**，返回 10 条真词，`suggType: KeywordSuggestion`；同会话内无 CORS 问题 | ❌ 不用 |
| **敲真搜索框 `#twotabsearchtextbox`** | 页面自己的 JS 发请求，**自动带上正确的 marketplace `mid`/`lop`** | ✅ **主路径** |
| 搜索结果页抓自然位 | 每页**恰好 16** 条，翻页最多 **20** 页 | ✅ 覆盖扫描用 |

> **为什么不用那个能返回 200 的接口**：它要求调用方自己给 `mid`（US = `ATVPDKIKX0DER`）。
> 给错了不会报错，会**静默返回另一个站点的建议词**——正是站点切换那一节（§4.2.1）存在的理由。
> 敲搜索框没有这个自由度，页面自己知道自己在哪个站点。

**搜索结果页的实测事实**（决定了 `RESULTS_PER_PAGE = 16` 和最大深度 320）：

- `[data-component-type="s-search-result"]` **只含自然结果**。付费位用的是别的 component type
  （`sp-sponsored-result` / `aspa-asin-ajax-lazy-loader` / `s-searchgrid-carousel`）
  → 按这个 component type 过滤，**存下来的 rank 天然就是自然位**，不需要额外判广告。
- 每页 16 条（`1-16` / `17-32` / `33-48`），翻页最多 20 页 → **最大有意义深度 320**。
  全局 rank = `(page - 1) × 16 + indexInPage`。
- 页码超过最后一页时页面**不是空的**（有信息条、没有结果行）→ 这是「答案」不是「失败」，
  必须和「页面没渲染出来」区分开，否则短页会被读成「一个词都没覆盖」。

**下拉建议里混着两类东西**：

- 价格筛选器（`Under $25`）→ class `s-suggestion discover-tr-suggestion`
- 真关键词 → class `s-suggestion s-suggestion-ellipsis-direction`

> ⚠️ 这两类**都**在 `#sac-suggestion-row-<n>-cell-1` 里，所以「它在不在 suggestion row 里」
> 这个判断**不含任何信息**。**只有 class 能区分**。
> 第一版实现就是加了这个容器判断，结果 15 条候选全被判为 widget、发现结果返回 0 个词 ——
> 而探针明明找到了 10 个。已改成只看 class，并把「候选全被过滤」单独报成一个 problem code，
> 让它永远不会伪装成「这个词没有建议词」。

### 4.3 三个设计要点

1. **统一入口，源可插拔**：新增一个源 = 新增一个适配器文件，不改其他代码。
   入口工具只有一个：`amzn_collect_submit(source, targets, fields?)`。

2. **能力声明是给 agent 用的**，不是给人看的。
   agent 先调 `amzn_source_list()`，看到"卖家精灵能给关键词、赛狐能给订单库存"，
   才知道该问谁 —— 否则它只能瞎试。

3. **来源标记（provenance）必须有**。同一个 ASIN 的字段可能来自多个源、值还不一样。
   要能回答"这个覆盖数是卖家精灵给的还是自己采的"。落地在 `asin_field_source`。

### 4.4 归一化

各源字段名/精度/单位都不同，必须有归一化层，输出统一结构：

```ts
interface NormalizedRecord {
  asin: string
  marketplace: string
  fields: Record<string, unknown>   // 统一字段名
  sourceId: string
  collectedAt: string
  raw: unknown                      // 原始响应，留证据
}
```

> 归一化的思路借鉴 amazon-ops 的 `keyword_normalization.py`。

---

## 5. 工具清单

命名前缀 `amzn_`。★ = 互联互通关键，🔒 = 写操作，需过审批闸门。

### 5.1 上下文与源（第 0 步）

| 工具 | 入参 | 作用 |
|---|---|---|
| ★ `amzn_workbench_context` | — | 读工作台当前上下文：选中的 ASIN、筛选条件、打开的模块 |
| `amzn_source_list` | — | 列出数据源及其能力、健康状态 |

### 5.2 ASIN（第 1 步）

| 工具 | 入参 | 作用 |
|---|---|---|
| `amzn_asin_query` | filters, limit | 按产品线/品牌/覆盖度等查 ASIN |
| `amzn_asin_get` | asin, marketplace | 单个 ASIN 详情 + 快照历史 |
| 🔒 `amzn_asin_upsert` | records[], source | 写入/更新 ASIN（导入也走它） |

### 5.3 采集（第 2 步）

| 工具 | 入参 | 作用 |
|---|---|---|
| 🔒 `amzn_collect_submit` | source, targets[], fields?, strictStorefront? | 提交采集，**立刻返回 task_id** |
| `amzn_collect_status` | task_id | 查任务进度与结果 |
| `amzn_collect_doctor` | asin, marketplace | **选择器自检**：加载一个真实页面，报告每个字段命中了哪个选择器、哪些没命中，以及套用的站点上下文与校验结果。不写库 |

> **提交后不阻塞**是刻意的：采集是分钟级长任务，agent 提交完应该能去干别的，
> 过一会儿再回来查。这是 `submit` / `status` 拆成两个工具的唯一原因。

> **`doctor` 存在的原因是采集器坏起来不出声**。亚马逊改 DOM 时它不会崩，
> 只会返回 null —— 库里的行变成空壳，页面看着正常，没人知道为什么。
> `doctor` 把"命中了哪个选择器"直接摆出来，让「亚马逊改了页面」和
> 「这个商品本来就没有 BSR」可以区分。这一条不是设计洁癖：
> 实测一个配件 listing 全页确实没有 BSR 字样，而另一个 listing 的 BSR
> 藏在**折叠的 tab 里**（`innerText` 读不到，只有 `textContent` 有）——
> 两种情况在库里长得一模一样。

### 5.4 关键词（第 3 步）

| 工具 | 入参 | 作用 |
|---|---|---|
| `amzn_keyword_query` | filters, limit | 查关键词总库（**库优先**：先看手里有什么） |
| `amzn_keyword_coverage` | asin, marketplace | **ASIN 优先**：覆盖了哪些 / 已测缺口 / 还没测过 / 建议补哪些 |
| 🔒 `amzn_keyword_import` | keywords[], measurements[]? | 导入关键词与排名，**分层永远由插件重算** |
| `amzn_keyword_discover` | marketplace, seeds[], limit?, dryRun? | 敲搜索框取建议词，同步返回；`dryRun` 只报不写 |
| 🔒 `amzn_keyword_scan` | marketplace, keywords[], asins[]?, pages? | 提交覆盖扫描，**立刻返回 task_id，不要等** |

> **`query` 是库优先、`coverage` 是 ASIN 优先**，这不是重复：前者回答「我手里有哪些词」，
> 后者回答「这个产品缺哪些词」。agent 起手该调哪个，取决于用户问的是哪个问题。

> **`import` 不收 `tier`**：分层是插件根据「排名 + listing 是否含词」算出来的，
> 不是调用方声明出来的。允许外部传 `tier` 等于允许库里出现无法复现的结论。
> 导入后一律 `recomputeTiersForAsin` 重算。

> **`coverage` 把「已测缺口」和「从未测」分开返回**，理由见 §3.2。
> 合成一个数字会让新入库的 ASIN 看起来「覆盖率 0%」，而它其实只是没人测过。
> 建议补词的排序是 **T3 → T4 → 未测**：先补「平台认为相关却没给排名」的，
> 再补「相关性还没建立」的，最后才是盲区。

> **`scan` 同样是「提交后不阻塞」**（和 `amzn_collect_submit` 一个理由）：
> 扫 40 个词 × 多页是分钟级的事，agent 提交完应该能去干别的。

### 5.5 优化与报告（第 4 步）

| 工具 | 入参 | 作用 |
|---|---|---|
| `amzn_optimize_prepare` | asin, marketplace, category?, maxTitleChars?, maxHighlightsChars? | 开一轮优化，返回**数据包**：站点档案（上限 + 单位 + 购买习惯）+ 当前 listing（带来源）+ 关键词与**全局埋词计划** + 全量字段清单（32 草稿字段 + 43 必填属性）+ 字符预算 + 规则清单 + 六道收尾闸门 + 要求你回填的格式。**不写任何文案**。 |
| `amzn_optimize_validate` | run_id, draft, persist?, trim? | 跑 72 条机检规则，返回阻断/警告（每条带规则 id 与文档出处）+ **六道闸门** + **埋词完成度** + 字段预算。可反复调；`persist: true` 才落库。 |
| 🔒 `amzn_optimize_save` | run_id, summary, decisions?, applyListing? | 收尾：记录采纳决定、**按最终文案重跑闸门**、生成 **Markdown + HTML** 报告、存库。`applyListing` 默认关。 |
| `amzn_optimize_report` | run_id | 取回报告（Markdown 正文 + HTML 链接）。 |

**生成文案不设工具** —— 由 agent 用 DSH 自己的 LLM 生成，这正是分工的关键。
amazon-ops-hub 的 `OPTIMIZATION-ENGINE-SPEC.md` 自己写着「必须用 LLM，禁止模板填充」，
所以插件连一个 `generate` 工具都不提供：插件负责**数字、排名、和 72 条规则的确定性判定**，
模型负责**写字**。一旦插件也能写字，就会出现两套口径。

### 5.6 职责切分（优化流）

```
prepare（插件：给数据、给预算、给规则）
   → 写文案（DSH agent）
   → validate（插件：判定 + 预算裁剪）
   → 不过就重写 ↺（agent 自己循环，不需要人介入）
   → save（插件：落库 + 出报告，写操作过审批）
```

`validate` 之所以能反复调而不落库，是为了让 agent 在**没有人盯着**的情况下自己改到过为止；
只有 `save` 会写。这也是为什么 `validate` 的返回值里带着「改完再提交」这句话 ——
它要能独立指导一轮重写。

### 5.7 规则引擎与预算的分工

两件不同的事，刻意分成两个模块：

| | 规则 `domain/rules/listing-rules.js` | 预算 `domain/optimize/budget.js` |
|---|---|---|
| 回答 | 「这个写法合法吗」 | 「还剩多少位置」 |
| 输出 | 阻断 / 警告 + 规则 id + 文档出处 | 已用 / 上限 / 余量 + 单位 |
| 判定 | 确定性的 72 条 | 不算判定，只算空间 |

**单位是预算的一部分，不是显示细节。** `search_terms` 按**字节**封顶（249），其余按**字符**。
一个中文字 3 字节，所以把 249 当字符用会放出近三倍的量，而 Amazon 对超长后台词的处理是
**整个字段一个都不索引** —— 不是截断，是全部失效。所以预算在**服务端**算（`/api/state` 里直接给
`budgets`），页面只负责画条，不在浏览器里重算一遍这条规则。

**阻断 ≠ 警告，不是严重度修辞。** 阻断是 Amazon 会拒收/降权的项；警告只是偏弱、不影响上架。
所以两者用不同的颜色与标签，页面底部还写一句「警告不是不发它的理由」——
一份把 `4 警告` 渲染成琥珀色的面板，会教读者把它当成别发的借口。

**只做确定性判定，做不到的明确列出来。** `LLM_ONLY_CHECKS`（臆造参数、标题与描述互相矛盾、
COSMO 因果链、NPO、评论对齐）需要模型判断，报告里单列一节「这份报告不判定的事」——
否则「0 违规」会被读成「没问题」，而它只意味着「机检的 72 条没问题」。

**规则是数据，带出处。** 每条规则有 `id` / `kind` / `severity` / `source` / `title`，判定函数
按 `rule_id` 索引在 `domain/rules/registry.js` 的 `CHECKS` 里。规则集本身从 v10 起入库
（`rule_set` / `rule` 两张表），当前版本 `2026.4`（72 条，**全部 `kind='code'`**）；`rules_json`
连同 `rule_set_version` 存进 `optimization_run`。一份三月的报告六月还要能解释，所以它按**当时的
规则快照**判定，而不是按今天的代码 —— 快照是拷贝，不是外键，改规则不会动到老 run 一个字。

**⚠️「有规则无判定」必须显式报，绝不当成通过（fail-closed）。** 一条 `kind='code'` 的规则在
`CHECKS` 里找不到对应函数时，`validate` 必须报具名的 `rule-check-missing`，并**按阻断处理**
（severity 强制为 `block`）：规则声称回答「合法吗」却答不了，答案是「未知」，而未知不能读成通过。
同理，停用一条规则（页面勾选或 `amzn_rule_upsert`）必须**真的改变产物** —— 若页面显示「已停用」
而 `validate` 仍跑代码常量，那就是静默失败里最贵的一种。三道防线缺一不可：roster 当入参传、
缺失判定具名上报、配证伪测试（删掉 roster 传参后断言必须变红）。

**⚠️「导入手册」不得改动任何判定，只写 `doc` 行。** 手册
（`04-agents/shared/rules/amazon-listing-comprehensive-rules-2026.md` v3.0，路径写死）从 B02c 起可导入为
`kind='doc'` 行：**一小节一行、id 用锚点**（`doc.1.1` / `doc.checklist13`），绝不拆成多条、绝不给手册
编造 `rule_id`（一节常含多条规则，如 §1.2 含 5 条）。导入集 **42 节** = `§1.1`–`§12.5`（41，不含容器
`9.3`）+ `十三`；开头的 `## ⚠️ 2026-05-13 重大变更` 是**变更日志**、在章级结构之外，**不算**（引进来会
带出「章级结构外的 `##` 算不算」这个新问题）。导入只新增/更新 `doc` 行，那 72 条 `kind='code'` 行
**原样带过去、逐列 byte 相等** —— 断言与证伪各一条。

**两个缺口按手册算、且必须用同一条判据：语义归属，不是字符串包含。** 一条 code 规则算「引用手册某
节」，仅当它的 `source` 里有一个**不带 `SOP` / `范例` / `SPEC` / `delivery` 前缀**的 `§N.M` —— 那些文档
的节号与手册无关，`SOP §3.3` 不是手册的 §3.3。于是 `rulesWithoutDoc`（有判定、手册无出处）= **21** =
72 − 51，`docsWithoutCheck`（有文档、没有 code 规则引用）= **18** = 42 − 24。**一边用归属、一边用字符串包含
是不自洽的**：`SOP §3.2` 会在 rulesWithoutDoc 里算「非手册」、在 docsWithoutCheck 里算「命中手册 §3.2」，
§2.2 / §3.2 / §8.1 / §8.2 / §9.1 这 5 节就会无声地掉出缺口。**只有 `code` 规则算「引用」**：doc 行的
`source` 就是它自己的锚点，若把 doc 行也算进去，每个小节都会自我引用、缺口一导入就塌 —— 恰好反了。
「有文档无判定」不是缺陷（手册大半是公式/建议/算法/指标/清单），但它是「导入手册 ≠ 规则就绪」的全部
理由，所以页面把 `code` 与 `doc` 分色画、并把 `doc` 行标成「只有正文」。

**第三个缺口与上两个不同，也画在页面上：`rule-check-missing`。** 它不涉及手册 —— 是 **roster 里一条
`kind='code'` 行、`CHECKS` 里却没有对应函数**，也就是**数据和代码已经分叉**。`validate` 报具名的
`rule-check-missing` 并按阻断处理（见上一条 fail-closed），而页面的红条是这条决定**唯一**的界面形态；
把它挪进工具输出等于把它藏起来。三条列表互不合并：一个讲手册出处、一个讲手册覆盖、一个讲实现。

### 5.8 报告输出：Markdown 源 + HTML 视图

**单一真相源是 Markdown**，HTML 是渲染出来的，不单独维护 —— 避免两份格式各改各的、逐渐漂移：

- 报告 Markdown 存库（`optimization_run.report_md`）：可 diff、可版本化、agent 改起来最省 token。
- 插件把 Markdown 渲染成 HTML，挂在 `/custom/amazon-ops/report/<run_id>` —— 工作台里点开即看。
- 需要给别人时，HTML 走 DSH 的交付物机制直接呈现 / 导出。

**不做 PDF**：Markdown + HTML 已经够用，PDF 只是多一层脆弱的渲染链。

报告骨架（每节都能追溯到数据，不出现无源结论）：

```
1. 结论摘要     —— 这次改了什么、预期影响
2. 数据基线     —— ASIN 快照 + 来源标记（哪个字段来自哪个源）
3. 关键词覆盖   —— 已覆盖 / 缺口 / 建议补词（含 T1–T4 分层）
4. 逐字段改动   —— before → after，附改动理由
5. 合规校验     —— 违规项与处理结果
6. 待办与风险
```

### 5.9 全量字段：先把「有哪些字段」变成一份清单

第 4 步只写了 8 个字段（标题 / 五点 ×5 / 描述 / 后台词），而 hub 的
`listing_field_registry.py` 覆盖 **11 节**。用户反馈的「字段不全」不是漏了几个，
是**根本没有一份完整清单**——没有清单就没法判断漏了什么。

现在这份清单是代码，不是文档：`src/domain/rules/listing-fields.js`。

| | 数量 | 说明 |
|---|---|---|
| 节（`SECTIONS`） | 11 | 核心 / 五点 / 描述 / 后台词 / 产品亮点 / 属性 / A+ / 品牌故事 / Q&A / 图片 / 视频 |
| 可交付草稿字段（`DRAFT_FIELDS`） | 32 | 每个都有标签、节、预算 |
| 属性（`ATTRIBUTES`） | 52（**43 必填**） | `attribute.<id>` 寻址，与其它字段同一套排序 |
| 必须人工填（`MANUAL_FIELDS`） | 7 | 价格、库存、变体等**没有文案可粘贴**的字段 |

**属性不是「另一个编辑器里的东西」。** 它们和标题、五点一样，是敲进**同一个**
Seller Central 列表编辑器里的，只是换到 More Details 页签。早期版本把它们标成
「需独立编辑器」，等于让用户去找一个不存在的界面 —— 真正独立的只有 A+、品牌故事、
Q&A、图片这四种，而它们各自在 `FIELDS` 里都写明了这一点。

属性和其它字段的区别在**别的维度**：`needsConfirmation`。属性是事实，
粘贴很容易，但值必须有人担保 —— 所以属性在报告里单列一节，而不是混在「待粘贴」里。

**A+ / 品牌故事 / Q&A / Alt Text 出的是可粘贴草案**，但**没有写回路径**
（`applyListing` 只覆盖 listing 的 6 个字段）—— 报告里明说这一点，
免得一份草案被当成已经生效。

### 5.10 优化深度：先定全局计划，再谈埋词

`buildEmbeddingPlan`（旧）把 tier 映射到**一个**位置。hub 的契约要求的顺序相反：
**先出全局计划，再分配**（`listing_contract.py` 的四矩阵 + 三不变量）。
这两件事的区别，就是「埋词要尽可能的多」和「每个词恰好出现在一个地方」的区别。

`src/domain/optimize/plan.js` 现在做四件事：

1. **12 个埋词位置**（`EMBED_POSITIONS`），**按权重降序**。
   第 12 个是 **Item Highlights**（权重 60）——SOP §三 列的 11 个位置里没有它，
   因为它比 SOP 新（2026-07-27 起 Amazon 把它做成一等字段，125 字符），
   且与标题构成**强制联动组**。位置的 `source` 字段直接写着这件事，
   所以「为什么多了一个」在报告里可查，不靠记忆。
2. **每个词恰好一个主人**（`owner`），外加**有理由的**复用位（`support`）。
   两个字段抢同一个词是**互相稀释**，不是双倍权重 —— 所以分配唯一性是一道闸门。
3. **三条不变量**，每条都能报出具体违规：
   - 一个词只有一个主人；
   - **前端可见的词不进后台词**（前台已索引，后台重复只是白占字节）；
   - 后台词里的词必须真在后台词文本里（按**实际字段内容**判，不按主人判）。
4. **覆盖矩阵：计划 vs 实际**。`fillRate` / `averagePlaces` / 每词 `gap` ——
   这是「埋词够不够多」的可检查版本。**人工位（价格、库存）不算缺口**，
   否则每个 ASIN 都永远差几个词。

**计划必须先满足自己。** 一个给出做不到的要求的计划比没有计划更糟：完成率低不是文案差，
是计划错，而读者从数字上看不出来，于是学会忽略这个数字。三处曾经违反这一点：

- **分层决定位置，排名只决定优先级。** 「有排名但文案没写」曾经覆盖分层，把 T3/T4 也派进标题；
  一个 200 字符的标题被要求装 6 个词组。
- **标题容量由重复规则算出来，不是拍一个数字。** 标题里任一单词最多出现 2 次，
  而同一品类的词几乎都共享核心词（一个抱枕类目里 7 个词有 6 个含 "blanket"），
  所以能进标题的词组数由**共享词**决定。`titleCapacity()` 按排名贪心模拟这条规则，
  装不下的让给五点，并在理由里写明为什么。
- **支持位按词比对，不按整句。** 规则说「材质词进属性」，属性值是 "Chenille" ——
  要整条词组出现在 100 字符的属性值里，那一格永远打不上勾。

> **一处自我矛盾值得记**：早期版本把「前端可见的词」也分配给 `search_terms`，
> 然后第三条不变量又把它们判为违规 —— 分配器和校验器互相打架。
> 修法是让分配器**先看草稿里这个词在不在可见位置**（`visibleOwnerOf()`），
> 在就认那个位置当主人。同时把不变量从「按主人判」改成「按 `search_terms` 的实际文本判」，
> 因为**字节是被字段里的内容花掉的，不是被所有权花掉的**。

### 5.11 站点档案：让「需要哪个站点就只出哪个站点」是真的

`src/domain/rules/marketplaces.js` 给 **20 个站点**各一份档案：
上限、计量单位（inch/pound/°F vs centimetre/kilogram/°C）、目标语言、货币、默认邮编、
以及**购买习惯**（每条带出处）。

**「有核验来源」和「只有通用档位」必须分开说。** 只有 US / CA 标 `authoritative: true`；
其余 18 个站点的 `limitsVerified: false`，报告顶部渲染一节
**「⚠️ 站点规则未核验」**，点名用了哪些数字、以及「这个站点没有核验过的购买习惯数据，
不要把美国站的结论套过来」。不这么做的话，一份日本站报告会理直气壮地引用美国站的字符上限。

`profileFor('ZZ')` 不抛错：返回 `recognised: false` + 默认档案，报告里如实标「未识别」。

预算从站点解析（`limitsFor(code)`），所以 `budgetFor(field, { marketplace })`
给出的 `max` 是按站点算的 —— 页面和报告都读服务端算好的数字，不各自重算。

### 5.12 收尾闸门：规则回答「合法吗」，闸门回答「做完了吗」

这是两类不同的问题，之前混在一起了。一份文案可以**完全合法**却**漏了 11 节里的 7 节**。

| | 规则（72 条） | 闸门（6 道） |
|---|---|---|
| 回答 | 这样写合法吗 | 这样算做完了吗 |
| 单位 | 单条规则命中 | 整份交付物的完整性 |
| 例子 | 「标题里有促销语」 | 「属性只填了 3/43」 |

六道闸门（`GATES`，各带 `what` 说明）：字段完整性、关键词分配唯一、产品事实一致、
合规覆盖、字符与字节预算、跨模块联动。

- **`save` 时按最终文案重跑闸门**，不是复用 `validate` 时的结果 —— 因为
  `save` 采纳的是**落库的草稿**，可能与最后一次 `validate` 的内容不同。
- 一道闸门内部抛错时**不中断**：记 `pass: false` + 「闸门执行出错，未能判定」。
  静默跳过会让「6/6 通过」变成一句谎话。
- 闸门不过**不阻止 save**（该交付的还是要交付），但报告和页面都会写明哪道没过、缺什么。

### 5.13 政策库：政策是输入，规则是产物（B03，schema v11）

用户第 8 项需求「最新政策」的字面实现。它和 §5.7 的「规则获取」是**同一条管道**，只是
在上游：**政策是输入、规则是产物**。这一版只做三件事 —— 政策进得来、看得见、和规则挂得上
钩 —— 不做抓取。

**数据源以人工粘贴 / 文件导入为主，这是有意的。** 公告页有风控，抓失败会被误读成「没有
新政策」—— 对这个模块来说这是最坏的失败，因为它和好消息无法区分。`policy_source.kind`
从第一天就支持 `'url'`（种入 `amazon-seller-central`），将来开抓取只是多一个 kind，不用改表。

**三列各有一个代价，反了就是 bug：**

1. **`published_at` 与 `effective_from` 分开两列。** 发布与生效常差几周，合一列就再也查不出
   「这个月生效了哪些」—— 而这正是本模块存在的理由。`since` 过滤按 `effective_from` 走。
2. **`severity_hint` 可空，且归一化值必须带原词（v12）。** 政策没明说就留 `NULL`，页面显示
   「**未判定**」，不编结论。解析器把政策自己的用词（严重/紧急/必须/立即… → high、重要/注意/
   建议 → medium、可选/提示 → low）映射成档位，**不**替它判 block/warn —— 那是规则的严重度，
   不是政策的。但**归一化值单独存在会冒充事实**：页面上「严重度：高」读起来像亚马逊自己的分类，
   其实是我们从「必须立即整改」这类措辞推出来的。所以 v12 另存一列 **`severity_raw`**（可查询，
   不是塞进 note），页面画成「**高（原文：「必须立即整改」）**」。归一化值仍是 chip 的取值来源；
   `severity_hint` 为 NULL 时两列同为 NULL。**只有原词也在库里时，它才真的是 hint 而不是
   judgement** —— 这和关键词总库里 `search_volume_source` 必须记口径来源是同一个道理。
   **这条配对在 store 层强制**（`importPolicy`）：给了档位不给原词、或反过来，**按名字拒绝**。
   不变式要加在**资源边界**，不是调用者的任务边界 —— 加在解析器上只保护「你知道的那条路径」，
   换个调用方（未来的工具、测试、别的模块）就漏了。两列同 NULL 是合法的「没明说」，不拒。
3. **`superseded_by` 自引用。** A 取代 B 时，B 的 `status` 变 `superseded` **且**指向 A（一次
   事务里两半都写：只改状态不留指针，会留下一条「已被取代但无处可追」的记录，比任一单独状态
   都坏）。断言要**两半都查**：能从 B 走到 A，且 B 不再是 `active`。

**取代不是「只设指针」的独立工具，而是折进导入。** 早先 `supersede()` 在 `src/` 里**零调用
方**：页面有「已被取代」的 chip / 筛选 / 文案，却没有任何路径能触发取代 —— 这是产品面的真缺口，
不是测试没覆盖。现在 `amzn_policy_import` 有可选参数 `supersedes: '<旧政策 id>'`，**导入与取代
在同一事务**里完成（一条政策到了、另一条被取代了，是同一个事实；只做一半比两半都不做更坏 ——
半条事实：新行在了、旧行还是 active）。`supersedes` 指向不存在的政策 → **在事务开始前**按名字
拒绝，库一点没动。`amzn_policy_list` 与页面同时显示两个方向：「**被谁取代**」（存下来的
`superseded_by`）和「**取代了谁**」（只有反向推得出来，`supersedesMap` 现算）—— 一条只能单向
走的链是半条链。**重复取代会被拒**：把一个**已经被取代**的政策再指向另一个新政策，会悄悄改写
「谁取代了谁」，还会把它的状态翻回 active —— 具名拒绝并报出真正取代它的那条；自环与回边同样
拒绝，且**回边要顺着整条链走**（只看第一跳会放过三节点的环）。证伪：把回边整链走改成只看一跳，
或把「已取代」的拒绝去掉，对应断言必须变红。

**日期是日历校验，不是「日 ≤ 31」。** `isoDate` 按每月天数表 + 闰年规则
（`(y%4===0 && y%100!==0) || y%400===0`）判定：`2026-02-30`、`2026-04-31`、`2026-06-31`、
`2026-02-29`（2026 不是闰年）、`2026-13-01` 全部留 `NULL`。**一个不存在的日期入库比留 NULL
更糟 —— 它看起来像真数据**，后面每一个读的人都分不出它是正则编的。证伪：把日历校验退回
「月 1..12 + 日 1..31」，非法日期断言必须变红。

**生效日期在前、关键词在后的写法：这个槽接受两类尾随，是「并集」，不是二选一。**
① `起` / `开始`（可再接 `生效`/`执行`/`施行`）；② **不带 `起` 的** `生效` / `执行` / `施行`。
（`9cb65cf` 只认第 ② 类，B03 上一版把它**替换**成了第 ① 类，把 ② 弄丢了 —— 所以修法是**加**
不是换，6 种形式各留一条断言，少一种就红。）边界收得紧：关键词必须**紧跟**日期（最多一个
**半角或全角**空格），且**落在边界**（行尾 / 空白 / `，,。；;、`）或接已知动词 —— 所以
「起价」「起运」「执行中」不会被误读成生效，而 `2026-05-01 起（含当日）` 这种带括号的
**故意不认**（留 NULL 并报未识别：**漏是可见的，误认不是**）。证伪：把恢复的第 ② 类去掉，
那三条断言必须变红。

**`sinceExcluded` 跟着查询自己的筛选走。** 「另有 N 条生效日期未识别」必须用**和查询同一套
where/params**（只把 `effective_from >= since` 换成 `IS NULL`）。早先它数的是**整个库**的未识别
行，于是 `since + DE` 会报出所有站点的未识别数 —— 一个跟着**别的范围**走的数字，筛选一变它就
跟着动，读的人没法信。

**解析不出来的字段一律留 `NULL`，并且如实报出是哪几个。** 输出里既有「未识别字段」（没读到）
也有「有歧义、未取值」（读到了多个，如同时出现 US 和德国 —— 猜一个就是编事实）。**整段解析
出 0 行是错误，不是空政策**：标题之后没有正文时直接报错、**不写库** —— 一条看着像政策、实则
什么都没说的行，正是这个模块要防的静默空。证伪：把空正文的检查去掉，解析断言与「失败不写库」
断言必须同时变红。

**`policy_rule` 用 `rule_id` 字符串、不带版本。** 政策影响的是「这条规则」，不是「这条规则的
2026.4 那一版」；roster 重发十次，链接的含义不变。`amzn_policy_link` 的 `ruleIds` **替换**整
个链接集（所以解除关联是同一次调用的更短列表），未知 `rule_id` 具名拒绝。

**`fields_json` 是政策级的「影响哪些字段」**，挂在 `policy` 而不是 `policy_rule` 上：一份
字段清单挂在每条关联规则上会被复制多份，而政策可以只影响字段、不挂任何规则（「图片必须
1600px」没有任何规则可挂）。

页面 POST `/api/policy-link` 与 `amzn_policy_link` **调同一个 store 函数** `linkPolicyToRules`，
两条路径不会各自漂移。规则页签对每条规则显示「受政策 X 影响」。

### 5.14 提示词库：按钮和写作策略都是数据（B04，schema v13）

到 v12 为止，提示词是**两种东西、在两个地方**：页面右下角的按钮是 `page.js` 里的一个常量
（`PROMPT_SETS`），要改一句文案就得改代码、重装插件；而「优化组装提示词」—— `amzn_optimize_prepare`
交给 agent 的写作策略 —— **根本不存在**，它只活在模型的脑子里。这一步把两者都变成库里的数据。

**两张表，一张 per 模块、一张 per 行。** `prompt_set` 回答「哪个模块、哪一代」（`id` / `module` /
`name` / `version` / `note`）；`prompt` 是**一行提示词**（`id` / `set_id` / `scenario` / `layer` /
`label` / `body` / `variables_json` / `version` / `sort_order` / `enabled` / `deleted_at` / `updated_at`）。
`scenario` 是 **prompt 的列、不是 set 的** —— 一个模块的 `button` 和 `assemble` 属于同一套，打开一处
就能看全这个模块发出去的东西。

**`scenario` 两种取值，语义完全不同。** `button` 是页面按钮，点了生成一段 prompt 复制给 agent；
`assemble` 是 `amzn_optimize_prepare` 的写作策略，分三层 —— `fixed`（固定策略，house style）/
`evidence`（证据从哪来，sourcing policy）/ `contract`（交回来什么形状）。分层不是装饰：三层因为
不同的原因、以不同的频率变化。

**模板语法只有两种构造，且变量集是闭集。** `{{name}}` 是占位符，`{{#name}}…{{/name}}` 是可选段
（值为空时**整段连同它自带的标点一起去掉**）。没有 `{{#if}}`、没有比较、没有算术：模板一旦能计算，
「哪条提示词产出了这段文本」就不再能靠读它回答，而把提示词放进库的全部意义就是它可读。
变量只有 `scope` / `selectedKeywords` / `rulesVersion` 三个；别的名字**在解析期就报错**，
不渲染成空 —— `{{selctedKeywords}}` 这种拼错必须响亮地失败，因为「渲染成空」和「这条提示词
选择什么都不说」长得一模一样，用户永远发现不了。`0` 和 `'0'` **不算空**（一个计数为零是事实）。

**渲染器不增删任何字符** —— 不插分隔符、不去尾逗号、不合并双空格。所以一句可选的话要**自带标点**：
种子写成 `{{#selectedKeywords}}重点看 {{selectedKeywords}}。{{/selectedKeywords}}`，句号在花括号
**里面**。一个推论值得点名：因为渲染器从不发明文本，需要**默认值**的值只能来自**解析器**，不能来自
模板 —— 规则按钮渲染出「把规则版本 当前生效版本 设为生效版本」，`当前生效版本` 是 `rulesVersion`
这个变量的**值**，由解析器提供。

**不变式加在 store，不是编辑器。** 解析不了、变量越界的正文，在 `upsertPrompt` **具名拒绝**
（未知模块 / 未知 scenario / assemble 缺层或层错 / button 带层 / 空标题 / 空正文 / 解析失败），
而不是只在编辑器里拦。和 B03 的 hint/raw 配对同一条教训：**守卫在调用者只保护你认识的那个调用者，
守卫在资源边界保护每一个调用者**。`variables_json` 是**从 body 解析出来的**，从不接受调用者传入 ——
手填的变量表就是那份会过期的第二份拷贝。`version` 每次保存 +1（而 `set.version` 是人读的一代标签，
所以是 TEXT）。

**一个解析器。** `resolvePrompts` 是页面和 `amzn_optimize_prepare` **共同**调用的那个函数：
页面按钮的顺序（本模块自己的，再拼上共享的 `common`）和 `prepare` 读到的写作策略都由它决定，
两者不可能漂移成同一行的两种渲染。页面**不再持有模板引擎** —— 按钮由服务端渲染好、放进
`state.prompts.buttons`，预览走 `POST /api/prompt-preview`。一份引擎，无副本可漂移。

**⑤ 逐字节一致是证出来的，不是声称的。** `PROMPT_SETS` 在删除**之前**就被抓成了
`tests/prompt-snapshot.json`（`tests/make-prompt-snapshot.mjs` 从 pre-B04 的 `page.js` 副本生成），
12 模块 × 8 变体（`scope` × `selectedKeywords` × `rulesVersion`）全组合，测试对**种子**和
**迁移真正写进库的行**各比对一遍。证伪：把某个可选段的标点移到花括号外，两条快照断言同时变红。

三个工具：`amzn_prompt_list`（读）/ `amzn_prompt_upsert`（写，🔒）/ `amzn_prompt_preview`（渲染一段
正文或一条已存的，未知变量在此报错）。页面 POST `/api/prompt-save` 与 `amzn_prompt_upsert`
**调同一个 `upsertPrompt`**。

---

## 6. 页面设计

### 6.1 挂载方式

**Tier 1**：`webServer.register({ path: '/custom/amazon-ops', handler })`，
服务一个自包含 HTML 页。无构建链、无 Vue、无打包。

页面下再挂三条前缀路由：

| 路由 | 用途 |
|---|---|
| `/custom/amazon-ops/api` | `GET state` 读页面数据；`POST context` 写选中项（通道 ①） |
| `/custom/amazon-ops/events` | SSE 事件流（通道 ②④） |
| `/custom/amazon-ops/report/<run_id>` | 报告视图（§5.8）—— 返回一整个 HTML 文档，是要被打开、收藏、转发的，和页面说的 JSON 是两种契约，所以单独一条路由而不是塞进 `/api` |

> ⚠️ **前缀路由的 `path` 不能以斜杠结尾**。路由匹配是
> `pathname === prefix \|\| pathname.startsWith(prefix + '/')`，
> 所以注册成 `/custom/amazon-ops/api/` 会让匹配要求出现双斜杠 —— 路由永远不触发，
> 请求静默掉进 fallback 返回 404，没有任何报错。这一条已写进仓库的
> `docs/plugin-contract.md`。

代价：**不会出现在控制台侧边栏**，需要从对话里给链接点进去。
自定义路由不受 token 栅栏保护，直接访问即可。

### 6.2 布局

```
┌────────────────────────────────────────────────────────────┐
│ Amazon 运营工作台   当前: B0C4X2K9LM    ● 后端连通 ● 采集器 │
├──────────┬───────────────────────────────┬─────────────────┤
│ 采集任务 │  筛选 chips                    │ Agent           │
│ ASIN 库  │  ┌───────────────────────────┐ │ → prepare(...)  │
│ 关键词库 │  │ ASIN │ 标题 │ 覆盖 │ 操作 │ │ ← 52 词         │
│ 优化队列 │  │ ...  │ ...  │ 38/52│ 优化 │ │ → 生成文案…     │
│ 报告     │  └───────────────────────────┘ │ → validate 2 违 │
│ 设置     │                                │ ↻ 重写中        │
│          │                                │ [跑优化 ↗]      │
│          │                                │ [查缺口 ↗]      │
└──────────┴───────────────────────────────┴─────────────────┘
```

优化队列面板（第 4 步）画的是**一轮 run 的逐字段前后对照**：

```
┌ 共 12 轮，显示最近 12 轮 · 报告在 save 时生成 ─────────────────┐
│ 轮次     ASIN        站点  状态    字段  校验       开始       │
│ 6db787b0 B0BRKPVZB4  US    [完成]  8    [警告 8]   09-21 08:39│
├───────────────────────────────────────────────────────────────┤
│ B0BRKPVZB4 US  [完成] [警告 8]  规则 2026.3   打开报告 ↗       │
│ 标题补齐了防水与场景词，五点按 MATERIAL/… 重建。               │
├───────────────────────────────────────────────────────────────┤
│ 标题   [已采纳] [无违规]        81/200 字符 · 剩 119          │
│ ┌ 优化前 ────────────┐ ┌ 优化后 ────────────────────────┐    │
│ │ SoundCore Bluetooth│ │ SoundCore Bluetooth Speaker,   │    │
│ │ Speaker Portable…  │ │ IPX7 Waterproof Portable…      │    │
│ └────────────────────┘ └────────────────────────────────┘    │
│ 后台搜索词 [已采纳] [警告 2]     26/249 字节 · 剩 223          │
│   [警告] backend.comma  §5.2 用空格分隔，无需逗号              │
└───────────────────────────────────────────────────────────────┘
```

两处刻意的选择：

- **预算条由服务端算**（`/api/state` 里直接给 `budgets`），页面只画。
  单位（字节 / 字符）是市场规则，不是显示细节，在浏览器里重算等于复制一份会漂移的规则。
- **阻断与警告不同色、不同标签**，面板底部还写一句「警告不是不发它的理由」。
  把 `4 警告` 渲染成琥珀色，会教读者把它当成别发的借口。

### 6.3 核心主张：界面负责「选对象」，agent 负责「干活」

**按钮不是打开表单，而是生成一段预置 prompt 丢给 agent。**

好处：不用为每种操作写一套表单 + 校验 + 提交流程。界面只需要把
"用户选中了什么" 表达清楚，剩下的交给 agent。

### 6.4 每个模块都必须有自己的面板（第 3 步踩到的坑）

导航声明的模块（`collect` / `asin` / `keyword` / `optimize` / `report` / `settings`）
**每一个都要有自己的面板，并且要么有渲染器、要么有一条「尚未实现」的说明**。

原因是踩过：`renderMain()` 原本写成
`if (collect) … else if (keyword) … else renderTable()`，于是所有没实现的模块
（优化队列 / 报告 / 设置）都**掉进 `else` 渲染出 ASIN 表**——点「优化队列」看到的是一张
活生生、数据却不对的表。这比白屏难查得多：它看起来是个能用的功能。

现在：

- 面板由页面自己的 `MODULE_GROUPS` **派生**（`RICH_PANELS` 之外的那些），导航和面板同源，
  所以「声明了模块却忘了写面板」不可能发生，也没有第二条可注入的模块清单能跟导航打架。
- 渲染走 `PANEL_RENDERERS` 映射；映射里没有的模块走 `PANEL_NOTES` 显示说明。
- 面板的显隐是**按面板**遍历（`[id^="panel-"]`）而不是按已知模块列表，
  所以未知模块（例如改名后残留的旧 id）落在专门的 `panel-unknown` 上并写明「未知模块 …」，
  而不是把三张面板全叠出来，也不是留中栏空白。
- 点击失败（例如切到一个不存在的模块、服务端 400）由 `patchContext` 捕获并显示在
  `#pageError`，不再是没人看得见的 unhandled rejection。

自检里有几条断言盯着它：每个声明模块都有面板且「有渲染器或有说明」，
`renderMain` 里**不许再出现 `else renderTable()`** 这种掉进兜底的写法，
以及渲染出的 HTML 必须出现每个组标题和每个模块名。

### 6.5 页面的三种静默失败（第 4 步补齐的）

面板是其中之一，第 4 步又补了两类 —— 都是「页面看起来正常、数据是错的」：

**① 渲染器读一个没人写的字段。** `renderKeywords()` 读 `state.keywords`、
`renderCoverage()` 读 `state.coverage`，而 `refresh()` **从来没有给这两个字段赋过值**。
于是关键词库永远是「关键词库还是空的」，覆盖条永远不出现 —— 无论库里有多少词。
第 3 步没发现，是因为那一轮验证走的是**工具**，不是页面。

> 断言：「`state.X` 被读就必须被赋值」。这条断言比逐个手测靠得住。

**② 发出去的筛选条件不是当前的。** `state.filters` 在挂载时从 `INITIAL.context` 播种一次，
之后再没同步过。每个控件发的都是「我记得的全部 + 我这一项改动」，所以先选分层、再输搜索词，
**分层就被悄悄丢掉了** —— 用户看到的是「筛选不生效」，实际是筛选项被自己覆盖。

> 断言：`adoptContext()` 必须同时刷新 `state.filters`。

**③ 对象被 `String()` 掉。** 页面把选中的关键词发成 `{ keyword, marketplace }`，
而 workbench 用 `.map(String)` 收，于是选中项变成字面量字符串 `"[object Object]"`：
侧栏芯片、prompt 文本、`amzn_workbench_context` 返回给模型的内容，全是它。没有一处抛错。

> 断言：选中项里**不许出现 `[object Object]`**；对象缺 `keyword` 时跳过而不是字符串化。
> 关键词和 ASIN 现在同构（都带 `marketplace`）—— 同一个词在不同站点的排名不一样，
> 丢了站点的选中项没法用来查覆盖。

**共同点**：这三件事都不会让任何东西报错。页面是个字符串，没有构建期类型检查，
所以唯一的防线是**自检里解析那段脚本**（§10 第 0 步的「注入脚本」验证姿势）。
这也解释了为什么这一步把「每个模块都要有 prompt 集」也做成了映射 + 断言：
prompt 原来是三元链，兜底是 ASIN 那套，于是「设置」页提供「跑采集」、「报告」页提供「跑优化」——
**按钮看起来合理，作用于别的东西**。

---

## 7. 互联互通机制

工作台与会话之间四条通道：

| # | 方向 | 机制 | 状态 |
|---|---|---|---|
| ① | 页面 → 插件状态 | 用户选中 ASIN / 改筛选，`POST /custom/amazon-ops/api/context` | ✅ 已实现 |
| ② | 插件状态 → 页面 | **SSE** `GET /custom/amazon-ops/events`（`text/event-stream`，长连接 + 心跳） | ✅ 已实现 |
| ③ | 插件状态 → agent | **`amzn_workbench_context` 工具**，agent 读它就知道"这个"是谁 | ✅ 已实现 |
| ④ | agent → 插件状态 | 插件拥有全部工具，**天然知道 agent 调了什么**，记成事件流推给页面 | ✅ 已实现 |

**③ 是让体验"缝上"的关键**：你在页面上选中 `B07PQ3M8TX`，然后在对话里说"优化这个"，
agent 直接知道指谁 —— 不需要你复述 ASIN。成本只是一个工具 + 一份内存状态。

**④ 是白捡的**：因为工具都在插件里，插件不需要去读 DSH 的会话存储，
自己就是"agent 干了什么"的天然记录点。

### 为什么是 SSE 而不是 WebSocket

原设计写的是 `registerUpgrade`，实现时改成 SSE，理由是成本对比很悬殊：

- `WebRoute.handler` **拥有完整的响应生命周期，可以一直挂着不返回** ——
  SSE 就是一个前缀路由 + `res.write('data: …\n\n')`，几十行。
- `registerUpgrade` 只给到升级后的裸 socket，**握手与帧编码要自己实现**
  （sha1 + magic GUID、帧掩码、ping/pong、分片），而插件不能引第三方依赖。
- 这条通道**只做服务端 → 页面单向推送**，WebSocket 的双向能力用不上；
  反向已经有 POST（通道 ①）。

心跳每 25 秒发一次 `: ping` 注释帧，防止中间层掐掉空闲连接；
响应头带 `x-accel-buffering: no`，避免反代缓冲把流式效果吃掉。

---

## 8. 目录结构

仓库根是 `workspace\dsh-plugins`（**这个目录本身就是 DSH 的本地插件根**，
所以插件直接放在仓库根下，不改路径也不改部署脚本）。当前实际结构：

```
workspace/dsh-plugins/                  ← git 仓库根 = $DSH_HOME\dsh-plugins
├── README.md                           # 仓库说明：加插件、装 profile、预检
├── docs/plugin-contract.md             # 插件契约（踩过的坑都在这）
├── templates/plugin/                   # 新插件脚手架（.template 后缀）
├── scripts/new-plugin.mjs              # 生成新插件
├── scripts/check.mjs                   # 预检（包装 harness 的 checker）
│
├── amazon-ops/                         # ← 本插件
│   ├── package.json                    # dsh.bundle.patch → cordis.patch.yml
│   ├── cordis.patch.yml                # 往 profile 插行（绝对路径指向 index.js）
│   ├── DESIGN.md                       # 本文档
│   ├── index.js                        # 入口：开库 → 注册工具 → 注册页面，失败则降级不抛
│   ├── src/
│   │   ├── store/                      # db.js（连接+迁移）/ schema.js（DDL）/ queries.js
│   │   ├── state/workbench.js          # 工作台上下文 + 事件流（内存，不入库）
│   │   ├── sources/
│   │   │   ├── registry.js             # 数据源适配器（browser / manual / 三个 planned）
│   │   │   ├── pacing.js               # 限速：导航前后随机延迟、长休、任务间隔
│   │   │   ├── collection.js           # 任务生命周期：队列、进度、崩溃恢复、取消
│   │   │   ├── cdp/
│   │   │   │   ├── client.js           # 零依赖 CDP 客户端（Node 内置 WebSocket）
│   │   │   │   └── launcher.js         # 找并拉起采集专用 Chrome（独立 profile + 端口）
│   │   │   ├── browser/collector.js    # 采集循环：逐个目标切站点 → 取页 → 校验 → 落库
│   │   │   ├── keyword-tiers.js        # 分层算法（纯函数，不碰库也不碰浏览器）
│   │   │   ├── keyword.js              # 发现 + 覆盖扫描 + 关键词任务服务
│   │   │   └── pages/
│   │   │       ├── index.js            # 抽取器注册表
│   │   │       ├── amazon.js           # Amazon 商品页抽取器 + MARKETPLACES + 校验
│   │   │       ├── amazon-search.js    # 搜索页 + 建议词下拉（第 3 步）
│   │   │       └── amazon-session.js   # 站点切换：语言 cookie + 点弹窗改配送地址
│   │   ├── domain/                     # 领域逻辑（不碰库也不碰浏览器，纯函数）
│   │   │   ├── rules/
│   │   │   │   ├── listing-rules.js    # 72 条机检规则目录 + 词表 + 短语匹配
│   │   │   │   ├── listing-fields.js   # 全量字段词汇表：11 节 / 32 草稿字段 / 排序 / 标签
│   │   │   │   ├── attributes.js       # 52 个属性（43 必填）+ 具体性判定
│   │   │   │   └── marketplaces.js     # 20 个站点档案：上限、计量单位、购买习惯
│   │   │   └── optimize/
│   │   │       ├── budget.js           # 字段预算（字节/字符分开）+ 不切词裁剪
│   │   │       ├── plan.js             # 全局埋词计划：12 位置 + 唯一主人 + 三不变量 + 覆盖矩阵
│   │   │       ├── validate.js         # 草稿归一 + 规则运行 + 六道收尾闸门
│   │   │       ├── embedding.js        # 埋词计划 + 覆盖变化（丢词要点名）
│   │   │       └── report.js           # 报告模型（13 节）+ Markdown / HTML 双渲染
│   │   ├── tools/                      # context / source / asin / collect / keyword / optimize
│   │   └── web/                        # routes.js（4 条路由）/ page.js（自包含 HTML）
│   ├── tests/
│   │   ├── run.mjs                     # 自检（零框架，176 条断言）
│   │   ├── probe-optimize.mjs          # 端到端探针：prepare → validate → save，可 --dump
│   │   ├── probe-routes.mjs            # 路由层探针：真 apply() + 假 ctx，读页面拿到的 JSON
│   │   └── make-sample-report.mjs      # 生成全量字段示例报告（32 草稿字段 + 43 属性）
│   └── data/                           # SQLite 文件 + Chrome profile（已 gitignore）
│
└── user-console/                       # 凭据库页面 + 长期记忆桥
```

纯 ESM，相对导入，**零第三方依赖**（存储用 Node 内置 `node:sqlite`），
**不需要构建步骤**。

---

## 9. 已定 / 待确认

### 已定（2026-09-21）

| 项 | 决定 |
|---|---|
| 存储 | **SQLite** —— 单文件、零部署、好备份 |
| 报告输出 | **Markdown（源）+ HTML（视图）**，不做 PDF |
| 采集通道 | **现在浏览器，API/MCP 留接口**（§4.2） |
| 插件形态 | 独立插件，**不改动** amazon-ops |
| UI | Tier 1 自包含页面 + 与会话互联互通（§7） |
| 字段范围 | **全量 11 节 / 32 草稿字段 / 52 属性（43 必填）**（v0.8） |
| A+ / 品牌故事 / Q&A / Alt Text / 视频 | **全部出可粘贴草案**，但明说没有写回路径（v0.8） |
| 目标站点 | **按需出**：要美国站就只出美国站，要其它站点就只出其它站点的（v0.8，§5.11） |

### 仍需你确认（不阻塞开工，我按括号里的默认值先做）

1. **浏览器通道用哪个账号**：采集器要一个**专用** Chrome profile。
   新建一个买家/卖家账号，还是复用现有账号（风险自担）？（默认：新建专用 profile，你登录一次即可）
2. **采集频率上限**：每任务最多几个 ASIN、间隔多久？（默认：每任务 ≤50 个、任务间 5–15 秒随机间隔）
3. **报告给谁看**：只自己看（页面打开就行），还是要导出成文件发人？
   （默认：HTML 自包含、可离线打开，两种都覆盖）

> 第 3 条在第 4 步按默认值落地了：HTML 报告**不含任何外部资源**（无 CDN 字体、无图表库），
> 存库后从 `/custom/amazon-ops/report/<run_id>` 打开，另存下来离线也能看。
> 自检里有一条断言专门盯着「不许出现外链」。第 1、2 条仍然悬着 —— 它们只影响采集，
> 不影响已经跑通的优化与报告。

---

## 10. 实施顺序

| 步骤 | 内容 | 状态 |
|---|---|---|
| **0 地基** | 数据模型（SQLite）+ 插件骨架 + 互联互通机制 | ✅ **已完成并验证** |
| **1** | ASIN 数据管理（含导入） | 🔨 工具已就位（query / get / upsert），缺产品线与批量导入体验 |
| **2** | 采集（**浏览器通道**，含站点切换） | ✅ **已完成并验证** |
| **3** | 关键词总库 | ✅ **已完成并验证** |
| **4** | 优化 + 报告（Markdown → HTML） | ✅ **已完成并验证** |
| **5** | 第三方源（卖家精灵 / 西柚 / 赛狐） | ⏳ 等配额；接口形态已调研，先留接口 |

### 第 0 步实际交付与验证

**交付**：`index.js` + `src/{store,state,sources,tools,web}`，6 个工具，3 条路由，SQLite 迁移到 v3。

**验证方式**（三层，逐层加强）：

1. **预检** `node scripts/check.mjs` → 6 个工具注册成功，无 schema 违规。
   *这只证明"装得上"* —— `apply()` 不抛错、schema 合法。
2. **直接驱动工具**（桩 ctx + 真实 `execute`）→ 跑通：空库提示、来源清单（含真实
   CDP 健康检查 `Chrome/153.0.8010.48`）、3 条 ASIN 写入、**部分更新不清空既有字段**、
   多来源 provenance（同一 `price` 同时有 `manual` 与 `browser-local` 两个来源）、
   非法 ASIN 与未知来源的清晰报错。
   → 这一步抓到一个真 bug：`sourceId: 'manual'` 触发外键失败，报
   `FOREIGN KEY constraint failed`，对 agent 毫无意义。已修：补种 `manual` 来源，
   并把来源与产品线的校验前移成「列出合法值」的报错。
3. **起实例探 HTTP**（3081 端口，不动在跑的服务）→ 页面 200、`/api/state` 返回计数与
   来源健康、`POST /api/context` 写入后 `state` 能读到、未知路由 404 JSON 不崩、
   `/events` 返回 `text/event-stream` 并推来 `hello` 帧。
   → 这一步抓到第二个 bug：前缀路由带尾斜杠导致 `/api/*` 全部 404（见 §6.1）。

> **为什么采集不放第一步**：它是四块里工程风险最高的（多源适配 + 长任务 +
> 各源字段差异）。在数据模型没定时先做它，等于一边盖楼一边改地基，归一化层会被反复重构。
> 而数据管理不需要采集也能有数据 —— 导入就行。

### 第 2 步实际交付与验证

**交付**：零依赖 CDP 客户端 + Chrome 启动器 + Amazon 抽取器 + 站点切换 +
限速采集器 + 任务生命周期（含崩溃恢复）+ 3 个采集工具 + 页面采集面板 + 自检。

**验证方式**（四层，逐层加强；**每一层都抓到真 bug**）：

1. **预检** `node scripts/check.mjs` → 9 个工具注册成功，无 schema 违规。
2. **自检** `node tests/run.mjs` → **61 条断言全过**。挑的都是"错了也不会报错"的地方：
   价格解析、注入页面的脚本、任务状态推导、风控页分类、站点切换脚本。
   → 抓到：`￥12,800` 被解析成 `12.8`；列表里一个畸形 ASIN 被**静默丢弃**
   （agent 会报"采了 2 个"而用户以为提交了 3 个）；以及自检自身的一处
   `return` 换行触发 ASI，让地址脚本静默返回 `undefined`。
3. **实机 `doctor`**（真实浏览器 + 真实页面）→ 8/9 选择器命中，站点上下文与校验结果如实输出。
   → 抓到：**BSR 被静默丢掉**。探针证明排名就在页面上（`#56 in Electronics`），
   在折叠的 `#prodDetails` 里，而 `innerText` **跳过 `display:none` 的文字**。
   改成 `textContent` 后又发现第二层问题：`textContent` 没有分隔符，整块扫描会把
   下一行的标签粘进分类名 —— 于是改为**锚定"以标签开头"的那个元素再上溯到它所在的行**。
   两个都补了回归断言。
4. **实机双站点任务**（插件自身管线，一个任务混 DE + US）→ 两个目标都写入，
   各自带齐站点证据：

   | ASIN | 站点 | 语言 | 语言 cookie | 配送地址 | 结果 |
   |---|---|---|---|---|---|
   | B0FMGXH38Q | DE | `de-de` | `lc-acbde=de_DE` | `10115 Berlin` | 德语标题 / EUR / 德语分类 |
   | B0BRKPVZB4 | US | `en-us` | （US 无需该 cookie） | `New York 10001` | 英语标题 / USD / BSR 56 |

   → 这一步验证了**逐目标切换**：任务开始时 profile 停在 DE，采 US 时自动走完
   「开弹窗 → 国家清单里没有 US → 填邮编 10001 → 确认」。且第二次采同一站点
   **不再需要切换**（58.7 秒 → 14.9 秒）。

> **一个仍然存在的不确定性**：配送地址改完后，**首页的导航栏可能仍显示旧值**，
> 而商品页已经更新（实测 amazon.com）。采集发生在商品页，所以不影响采集；
> 但 `doctor` 在首页上跑时可能给出偏保守的结论。已按"如实报告"处理，不掩盖。

### 第 3 步实际交付与验证

**交付**：迁移 v5（keyword / asin_keyword 扩列 + `collection_task.kind` + 4 个索引）、
分层算法（`src/sources/keyword-tiers.js`，纯函数）、搜索页与建议词能力
（`src/sources/pages/amazon-search.js`）、发现 + 覆盖扫描 + 任务服务
（`src/sources/keyword.js`）、5 个关键词工具（共 14 个 `amzn_*`）、关键词面板，
自检从 61 条涨到 **105 条**。

**验证方式**（三层，逐层加强；**每一层都抓到真 bug**）：

1. **预检** `node scripts/check.mjs` → 14 个工具注册成功，无 schema 违规。
2. **自检** `node tests/run.mjs` → **105 条断言全过**。挑的都是「错了也不报错」的地方：
   分层规则、建议词分类、搜索结果分页、缺口与盲区的区分、任务按 `kind` 恢复、
   以及注入页面脚本与工作台页面（页面没有构建期检查，只能在这里解析）。
   → 抓到 5 个真 bug，见下表。
3. **实机端到端**（走插件自己的代码：`discoverKeywords` → `createKeywordService.submit` →
   扫描 → `keywordCoverage`）：

   ```
   [live] discovery: 10 per seed / 10 union (limit 11 cap 11) in 11.9 s; typed="bluetooth speaker"
   [live] wrote 10 keywords, 0 failed; library now 10
   [live] scan finished: done in 18.1 s
   [live] coverage: {"measured":2,"ranked":2,"gaps":0,"unscanned":0,"untested":8,"byTier":{"T1":2}}
   ```

   然后**另外写一个脚本独立读页面**核对：`B0BRKPVZB4` 在两个词下确实都排在**自然位第 4**，
   与库里存的 rank 完全一致（不是 index 偏移），10 个词入库 10 个。

**这一层抓到的 bug**（每一个都是「不报错但结果错」）：

| 现象 | 根因 | 修法 |
|---|---|---|
| 导入 `schema.js` 报 `SyntaxError: Unexpected identifier 'tier'` | SQL 注释里的反引号**终止了外层模板字符串** | 去掉 SQL 注释里的反引号 |
| 发现返回 0 个词，而探针明明找到 10 个 | 判 widget 时加了 `closest('[id^="sac-suggestion-row"]')`，而**所有**建议词都在这个容器里 | 只看 class；「候选全被过滤」单独报成 problem code |
| `keywordInText('flip 7', 'JBL Flip-7 Portable')` 为 false | `normalizeText` 没有把 `-` 归一成空格 | 分隔符 `[-_/\\]+` → 空格，并补回归断言 |
| `limit` 传非法值时**上限整个消失** | `Math.max(1, Math.trunc(undefined))` 是 `NaN`，而 `length >= NaN` 恒为 false | 非法值回落到默认上限，并把实际上限返回 |
| 发现报 10 个词、库里只有 8 个（且无写入失败） | 每个 seed 按默认 11 截断，并集按 `limit × seeds` = 8 截断，**两个上限各算各的** | 抽 `mergeSuggestionSets`，两个上限由同一个数推导 |
| ASIN 表把「没测过」算成「缺口」 | `queryAsins` 里 `rank IS NULL` 一律计为 gap | 拆成 `keyword_ranked` / `keyword_gap`（测过没有）/ `keyword_unscanned` |
| 点「优化队列」显示 ASIN 表 | `renderMain` 的 `else` 兜底把未实现模块渲染成 ASIN 表 | 面板按模块生成 + `PANEL_RENDERERS` 映射 + 说明文案（§6.4） |

> **`scan_depth` 是这一步最值钱的一列。** 没有它，「前 320 条里没有这个 ASIN」和
> 「从来没人查过」在库里长得一模一样，而前者是可以行动的信息（该优化），后者不是。
> 分层算法因此在两者都为空时返回 `tier: null` 而不是猜一个 T4。


### 第 4 步实际交付与验证

**交付**：迁移 v6（`listing` 补 3 列、`optimization_run` 补 6 列、`optimization_draft` 补 4 列 +
唯一索引 + 2 个查询索引）、**48 条机检规则目录**（`src/domain/rules/listing-rules.js`，纯数据 + 纯函数）、
字段预算（`src/domain/optimize/budget.js`，字节/字符分开）、草稿归一与校验
（`src/domain/optimize/validate.js`）、埋词计划（`embedding.js`）、双渲染报告（`report.js`）、
4 个优化工具（共 19 个 `amzn_*`）、优化队列面板 + 报告路由（§6.1 的第 4 条路由），
自检从 105 条涨到 **145 条**。

**验证方式**（三层，逐层加强；**每一层都抓到真 bug**）：

1. **预检** `node scripts/check.mjs` → 19 个工具注册成功，无 schema 违规。
   → 当场抓到页面脚本里的一个反引号（下面第 ⑭ 条）。
2. **自检** `node tests/run.mjs` → **145 条断言全过**。新增的 40 条集中在「错了也不报错」的地方：
   - **每条规则都要有一个种出来的违规样本**（`PLANTED` 表，39 条）。
     这条断言的价值在于：规则被重构改坏之后只是**不再报任何东西**，而那读起来和「干净」一模一样。
     表里少一条会被断言发现，所以新增规则必须同时给出它的违规样本。
   - 48 条规则的形状（id 唯一 / 有出处 / 有 severity / 有 check）、
     以及**没有规则指向草稿词汇表里不存在的字段**（两份手写清单漂移是这里的经典故障）。
   - `#1` 这类以 `#` 开头的短语能匹配（`\b` 永远匹配不到 `#` 前的位置）；
     `prevent` 不匹配 `prevents`（一票否决式的子串封禁会打到手册自己的范例上）。
   - 预算的单位（83 个中文字 = 249 字节 → 后台词刚好卡在上限；同一串按字符算远没超）。
   - `trimToBudget` **不切断单词**（`Non-Slip Bott` 这种读起来像错别字，不像 bug，所以没人报）。
   - 埋词计划的 tier→位置映射、`coverageDelta.lost`（重写丢词是**看不见的退步**）。
   - 报告的两个渲染出自同一个模型、HTML 不含任何外链、字段按阅读顺序排、产品行用**本插件的列名**。
   - 工作台页面：每个模块都要有 prompt 集、`state.X` 被读就必须被赋值、选中项里不许出现 `[object Object]`。
3. **实机端到端**（走插件自己的 `apply()`：真注册 19 个工具 + 4 条路由，用假 `ctx`，
   然后用**页面自己的 `/api/state` 处理器**问它浏览器会看到什么）：

   ```
   prepare  -> 标题候选 2 / 五点候选 2 / 后台候选 1，白拿的相关性 1 个（waterproof speaker）
   validate -> 合规校验 · 11 阻断 / 15 警告（8 个字段）   ← 故意写坏的草稿
   validate -> 合规校验 ·  0 阻断 /  8 警告（8 个字段）   ← 改好的草稿
   save     -> 已收尾（done）· 采纳 8/8 · Markdown 5241 字符 · 覆盖 1 → 2（净 +1）
   GET /api/state (module=optimize)
        run status=done rules=2026.3 counts={"block":0,"warn":8} hasReport=true
        budgets=8 -> title 81/200c, bullet_1 63/255c, …, search_terms 26/249B
        drafts=8  -> title(标题) accepted=1 violations=0 …
   GET /custom/amazon-ops/report/<run> -> 200 14006 bytes
   GET /custom/amazon-ops/report/nope  -> 404
   ```

   注意 `search_terms 26/249B` 那个 **B** —— 服务端给的就是字节数，页面不重算。

**这一层抓到的 bug**（每一个都是「不报错但结果错」）：

| 现象 | 根因 | 修法 |
|---|---|---|
| ① 报告说某轮 `状态 running`，其实已经跑完 | 报告模型在 `updateOptimizationRun` **之前**就构建了 | 先算 `finalStatus`，再传进 `buildReportModel` |
| ② 报告的产品概况整节空白 | `getAsin()` 返回的是 `{ row, snapshots, … }` 包装对象，我把包装对象当行传了 | 两处都改成 `getAsin(...)?.row ?? null` |
| ③ BSR 与评论数仍然空白 | 报告读的是 hub 那套 Python 列名（`bsr_rank` / `bsr_category` / `review_count`），本插件存的是 `bsr` / `category` / `reviews` | 抽 `productRows(asin)` 统一用本插件列名，两个渲染共用 |
| ④ `IP67` 被判为「全大写单词」 | 判据是 `word === word.toUpperCase()`，规格代码全中 | 改成 `/^[A-Z]+$/`（只认字母），并断言品牌名豁免 |
| ⑤ 报告字段顺序是写入顺序（标题→描述→后台→五点） | 草稿按插入顺序返回 | `FIELD_ORDER` + `fieldRank` 在模型里排序 |
| ⑥ 五点里两条完全相同、描述把一句粘贴 30 次，都没被报出来 | 规则表里**根本没有**这两条 —— 是探针自己撞出来的 | 补 `bullets.duplicate`、`description.repeat.phrase`（→ 48 条） |
| ⑦ `report_html` 写入时列不存在 | 迁移 v6 漏了这一列 | 补列 |
| ⑧ `ON CONFLICT(run_id, field)` 报错 | 没有唯一索引 | 加 `CREATE UNIQUE INDEX`，前面先 `DELETE … NOT IN (SELECT MAX(id) …)` 兜住老库 |
| ⑨ 描述里重复句子的密度规则对干净文案误报 | `findPhrases` 把重叠短语算了两次（`amazing` 与 `amazing quality` 同时命中） | 按长度降序，已被更长短语认领的跳过 |
| ⑩ `normalizeDraft` 有一段死循环 + 一条重复路径 | 同时读 `bullets[]` 与 `bullet_1..5` 会把五点翻倍，进而误报条数 | 数组非空时以数组为准；删掉死循环 |
| ⑪ 草稿里的五点关键词全被判为「缺失」 | `listingText` 收的是 `{ title, bullets[] }`，草稿是编号字段 → 五点整个不可见 | 加 `frontText(fields)` 适配器，覆盖与后台候选共用 |
| ⑫ 一处编辑产出了一行无意义代码（`lines.concat(…).catch(…)`） | 手工编辑事故 | 重写成 `if (run === null) { … }` |
| ⑬ 探针报「ASIN 不在库里」而我明明写过 | `amzn_asin_upsert` 收 `records: []`，我传了扁平对象 | 探针的错，不是插件的 —— 插件当时**如实说了**「库里没有这个 ASIN 的记录」 |
| ⑭ 插件预检直接 `Unexpected identifier 'state'` | 页面脚本注释里的**反引号终止了外层模板字符串**（第 3 步踩过同款） | 去掉反引号；这条坑已写进 `docs/plugin-contract.md` §8 |
| ⑮ 关键词库永远显示「还是空的」 | `renderKeywords` 读 `state.keywords`，而 `refresh()` **从没赋过值**；`state.coverage` 同样 | `refresh()` 补齐三个切片；加「被读就必须被赋值」断言 |
| ⑯ 先选分层再输搜索词，分层被丢掉 | `state.filters` 只在挂载时播种一次，之后不同步 | `adoptContext()` 每次读状态都刷新 filters |
| ⑰ 选中的关键词变成字符串 `"[object Object]"` | workbench 用 `.map(String)` 收页面发来的对象 | `normalizeKeywords()`：接受对象或裸字符串，缺 `keyword` 就跳过；关键词与 ASIN 同构（都带 `marketplace`） |

> **⑮⑯⑰ 是同一类**：页面是个字符串，没有构建期类型检查，读一个没人写的字段、
> 发一份过期的状态、把对象字符串化 —— 三件事都不抛错。所以这一步把自检扩到了
> **解析页面脚本本身**（§6.5）。第 3 步的验证走的是工具，所以这三条一个都没被发现。

### 第 4 步补充：全量字段与优化深度（v0.8）

**触发**：用户对第 4 步报告的两条反馈 ——
「**字段不全，要全量的优化字段**」和「**优化深度不够，埋词要尽可能的多且符合 SEO/GEO
的优化思路，也需要符合目标地区的购买习惯**」。

**先做缺口对照，再动手。** 两条反馈各自对应一个**结构性**缺口，不是零星漏项：

| 反馈 | 对照 hub 的权威来源 | 真实缺口 |
|---|---|---|
| 字段不全 | `listing_field_registry.py` 覆盖 11 节 | 只做了 SOP 的 4 / 11 个埋词位置、注册表的 4 / 11 节；**没有一份完整字段清单** |
| 深度不够 | `listing_contract.py` 要求**先出全局计划**（四矩阵 + 三不变量） | `buildEmbeddingPlan` 把 tier 映射到**一个**位置；没有覆盖矩阵，也没有「计划 vs 实际」 |
| 目标地区 | 采集层已有 20 个站点 | 优化层是**站点无关**的，上限写死在通用档位 |

**交付**：迁移 v7（`listing` 补 `item_highlights`）、4 个新模块
（`rules/listing-fields.js`、`rules/attributes.js`、`rules/marketplaces.js`、`optimize/plan.js`）、
规则 48 → **72 条**、埋词位置 11 → **12 个**、六道闸门、13 节报告、自检 145 → **173 条**
（收尾时又加 3 条，共 **176 条**）。

**验证方式**（三层，与第 4 步同一套，但第 6 层是本轮新加的）：

1. **预检** `node scripts/check.mjs` → 2 个本地插件都能 apply，19 个工具注册成功。
2. **自检** `node tests/run.mjs` → **176 条断言全过**（新增 31 条，四节 + 一节路由层）。
   新增断言刻意挑「不报错但结果错」的地方：
   - **字段词汇表**：11 节 / 32 草稿字段 / 52 属性 / 43 必填；`N/A` 算没填而 `unknown` 不算；
     属性可交付（不再是「独立编辑器」）；7 个必须人工填的字段；每个字段都有中文标签。
   - **站点决定数字**：20 个档案；`profileFor('ZZ')` 不抛错；US/CA 有核验来源而 JP 没有；
     分类上限；**按站点解析预算**；`BUDGET_SPEC.limitSource` 自洽
     （documented 必须指向 limit key，guideline 必须是字面数字）。
   - **全局计划**：位置按权重降序、每个位置有出处；人工位不算缺口；
     复用位改主人（前端已有的词不再进后台词）；后台重复不变量**双向**都测；
     一个词一个主人；覆盖矩阵计划 vs 实际；空草稿 fillRate = 0。
   - **六道闸门**：6 个 id 与顺序；**合法但没做完** → 完整性失败而合规通过
     （这条断言就是「字段不全」反馈的回归测试）；计划退化时闸门仍然出结果。
3. **路由层**（本轮新增的第 6 层）：真 `apply()` + 假 `ctx`，驱动真工具，
   再用**页面自己的 `/api/state` 处理器**问它浏览器会看到什么。

   ```
   19 个工具 / 4 条路由 / 前缀路由不以斜杠结尾
   asin_upsert -> 新增 1，更新 0
   keyword_import -> 7 条
   optimize_prepare -> run 720ebd4a
   optimize_validate -> 0 阻断 / 21 警告（14 个字段）
   optimize_save -> done · 采纳 14/14 · 闸门 5/6 通过　未过：字段完整性
   GET /state -> profile{code:JP, authoritative:false} · provisional 非空 · 单位 centimetre
                 闸门 5/6，FAIL 字段完整性「属性（已有 3/43）」
                 埋词完成度 fillRate 0.375 · keywordsUnderfilled 5
                 14 个字段预算全部解析出 max 与 limitSource
   GET /report/720ebd4a -> 200 28601 字符，含未核验声明与闸门一节
   GET /report/does-not-exist -> 404
   US 站对照：provisional = null，报告里**不出现**未核验声明
   ```

   > 这一层专门用来抓「路由改名 / 字段改名」——那类改动不会报错，
   > 只会让面板上某个数字**悄悄消失**。断言写的是「面板读的每个 `run.*` 路径都必须能解析出值」，
   > 而且路径是**从页面脚本里推导**出来的，不是手写清单。
   >
   > **这条断言证伪过一次**：第一版是空转的（见 ㉗），修完之后
   > 把 `itemHighlightsMax` 改名注入，它如期报错。**写完断言要证伪一次**，
   > 否则「断言存在」和「断言有效」分不出来。
4. **全量字段示例**（`node tests/make-sample-report.mjs --out <dir>`）：喂满 **32 个草稿字段 +
   43 个属性**走真代码路径，产出一份可直接打开的报告。

   ```
   合规校验  -> 0 阻断 / 19 警告（75 个字段）
   save      -> 采纳 75/75 · 闸门 6/6 · Markdown 41978 字符 · HTML 64378 字符
   埋词      -> 计划 21 处 / 实际 18 处 · 完成率 86% · 平均每词 4 处
   属性      -> 43/43
   章节 13 个 · 不含任何外部资源
   ```

   > 用**满字段**而不是探针那份薄草稿，是因为这一轮要回答的抱怨就是「字段不全」——
   > 一份只填 14/32 的样例恰好演示了反面。而且 43 个属性的草稿此前从没走过
   > `normalizeDraft` → 预算 → 事实台账 → 六道闸门这条链，它也是第一次被验证。

**这一层抓到的 bug**：

| 现象 | 根因 | 修法 |
|---|---|---|
| ⑱ 属性被标成「需独立编辑器」，用户会去找一个不存在的界面 | `isPublishable` 读 `FIELDS[field]?.publishable`，而属性没有 `FIELDS` 条目 | 属性 → `true`；`report.js` 改调 `isPublishable` 而不是自己读 `FIELDS`；另加 `needsConfirmation` 区分「粘贴容易但需人担保」 |
| ⑲ 报告说「按权重降序」但顺序是错的 | `EMBED_POSITIONS` 按 SOP 顺序声明，Item Highlights（60）被追加在中档（50）之后 | 改 `POSITION_LIST` + `.sort((a,b) => b.weight - a.weight)` |
| ⑳ 分配器把前端已有的词分给后台词，第三条不变量立刻判它违规 | 分配器与校验器各判一套 | 分配器先看草稿里这个词在不在可见位置（`visibleOwnerOf()`），在就认那个位置当主人 |
| ㉑ 后台重复的不变量**永远不可达** | 它按 `owner === 'search_terms'` 判，而 ⑳ 的修法让这个条件不再成立 | 改成按 `search_terms` 的**实际文本**判 —— 字节是被字段内容花掉的，不是被所有权花掉的 |
| ㉒ `isPublishable` 有两个同名不同参的函数 | `validate.js` 收 `result`，`listing-fields.js` 收 `field` | 前者改名 `isDraftPublishable`：同名不同参正是「传错也能拿到一个像样的布尔值」的来源 |
| ㉓ 站点档案里的购买习惯整块渲染了两遍（其中一遍是 `undefined`） | 打印了 `habit.label/detail`（真实形状是 `habit.text/source`） | 删掉过期那几行 |
| ㉔ 覆盖矩阵报「8 个位置有内容、0 命中」 | 探针没传 `tier`；且 ⑳ 是真 bug | 探针补 `tier`；⑳ 修掉 |
| ㉕ 路由层测试跑完删不掉临时目录（EBUSY） | 假 `ctx` 的 `effect` 把清理回调吞了，SQLite 句柄没关 | 桩主机收集 disposer，teardown 前先 dispose —— 症状读起来像「临时目录偶发抽风」，其实是句柄泄漏 |
| ㉖ `coverage` 一个名字两种含义 | 关键词面板里是 `state.coverage`，优化面板里是 `run.coverage`，形状不同 | 优化面板的局部改名 `embed`；静态检查加「别名有歧义就跳过」规则（宁可漏报，不要误报） |
| ㉗ **新加的「面板读的字段必须存在」断言是空转的** | 只推导了顶层 `run.X`；嵌套路径那份清单是手写的，而且**方向反了** —— 查的是 payload 有没有，不是页面读没读 | 改成从脚本推导**带一层别名**的读取路径（`const embed = run.coverage` → `embed.fillRate`）；并用**改名注入**证明它真会报 |
| ㉘ 页面脚本再次 `Unexpected identifier` | 我在 `page.js` 的 JSDoc 里写了反引号 —— **page.js 整个是模板字符串**（同 ⑭） | 注释里去掉反引号。这条坑踩第二次，说明「知道」不等于「不会踩」 |
| ㉙ **计划不可满足：6 个词组被派进 200 字符的标题** | `RANKED_BUT_SILENT` 把「有排名但文案没写」的词一律判给标题，覆盖了分层。T3（排名 44）也被要求进标题 | 分层决定**位置**、排名只决定**优先级**。`silent` 成为独立字段，`quickWins` 本来就带这个信号，不需要靠改位置来表达 |
| ㉚ **就算修了 ㉙，4 个词组还是塞不进标题** | 7 个词里 6 个含 "blanket"，而规则禁止同一词在标题出现超过 2 次 —— 能进标题的词组数**由共享词决定**，不是固定数字 | 新增 `titleCapacity()`：按排名贪心，模拟「任一单词出现 ≤2 次」，装不下的让给五点并在理由里说明。计划从此**可满足** |
| ㉛ 覆盖矩阵里「属性字段」那一格**永远打不上勾** | 规则说「材质词进属性」（`chenille`），校验却要求**整条词组**出现在属性值里 —— 而属性值是 "Chenille" 这种单词 | 支持位带上 `probe`：属性位按**规格词**比对，其余位仍按整条词组。**没人能关掉的缺口，就是教读者忽略缺口计数** |
| ㉜ 报告里两个警告数（结论 23 / 闸门 19），且文档级违规整条消失 | 结论用「逐字段存储行求和」，闸门用「重跑校验」；而文档级规则报在伪字段 `draft` 上，落库只按真实字段写行，于是被丢掉 | 结论改用**校验快照**的计数（一个数字一个来源），存储行求和降级为「没有快照时」的兜底。断言直接锁 `counts === validation.counts`，并**证伪过** |

> **㉑ 值得单独记**：一个「永远不可达的校验」和「没有这条校验」在测试里长得一样 ——
> 都不会报错。区别是前者会让人以为已经防住了。所以这条不变量**两个方向都写了断言**。

> **㉙㉚㉛ 是同一条线**：计划/校验里凡是**给出一个做不到的要求**的地方，
> 都会让计数失去意义 —— 完成率低不是文案差，是计划错。
> 一个不可满足的计划比没有计划更糟：它教读者忽略那个数字。
> 这三条的修法都是同一个动作：**把约束写进计划**（分层、重复规则、按词而不是按句），
> 而不是让计划先随便派、再让校验去骂。

> **㉗ 的修法比 bug 本身更值得记**：断言写完必须**证伪一次** ——
> 故意把页面读的字段改个名，看它会不会报。第一版没报（173 全过），
> 这就是「断言存在」和「断言有效」的区别。**一条不会失败的断言，和没有断言是同一件事，
> 而且更糟** —— 它会被算进覆盖率。


---

## 11. 第 5 步：关键词总库（从导出文件建库）

> 完整交付说明见会话根目录的 `amazon-ops-keyword-master.md`。本节只记设计与边界。

### 11.1 它和第 3 步的「关键词库」是什么关系

**两个东西，共用一张 `keyword` 表，别的都不共享。**

| | 第 3 步 `keyword` 页签 | 第 5 步 `kw` 页签 |
|---|---|---|
| 数据从哪来 | 浏览器**实测**（搜索下拉扩词 + 扫搜索结果页） | **别人导出的文件**（ABA / 广告报告 / 卖家精灵 / 西柚） |
| 回答什么 | 「**我们自己的 ASIN** 在这个词上排第几」 | 「**这个词本身**有多少量、多少竞品、值不值得做」 |
| 分层 | T1 守位 / T2 冲刺 / T3 抢占 / T4 观察（`asin_keyword.tier`） | L1–L5 搜索量分档（`kw_master.sv_tier`） |
| 工具前缀 | `amzn_keyword_*` | `amzn_kw_*` |

**两套工具不合并**：合并会让一个工具描述里「关键词」有两个互不相容的含义。

### 11.2 为什么是「事实表 + 汇总表」而不是一张宽表

hub 的 `keyword_master.db` 是一张宽表，每导一个文件就**累加**。后果：同一个文件导两次，
曝光量翻倍，**两次都报成功**。

这里改成：

```
kw_aba_fact        主键 (关键词, 站点, 周期)
kw_ad_fact         主键 (关键词, 站点, 周期, 文件)   ← 周期会重叠，文件必须进主键
kw_competitor_fact 主键 (关键词, 站点, 竞品ASIN, 来源)
        ↓  recomputeMaster()  —— 纯函数，先删后建
kw_master          主键 (关键词, 站点)
```

三条不变量：

1. **汇总表的每一列都是事实表的函数**，没有一列是「上次跑剩下的」。
   ⇒ 重导幂等、「排除文件」真的生效。（upsert-only 的版本对「只由该文件供给的词」
   完全不起作用 —— 那些词这轮没有事实、不会被访问，旧行原样留着。）
2. **`first_seen_at` 是唯一的历史列**，先删后建时必须单独搬运。
3. **`null` 不是 `0`**。没有搜索量就是没有，不是「搜索量 0」——
   后者会被 `classifySvTier` 当成 L5、被 `classifyPriority` 当成 P2，
   读起来像结论。

### 11.3 单位与来源都要能自证

- **单位写进列名**：`cvr_pct` / `ctr_pct` / `acos_pct` / `brand_click_pct` / `purchase_rate_pct`。
  hub 的单列 `cvr` 在 ABA 路径下是百分数、在广告路径下是小数，却和同一个阈值 `2` 比较。
- **口径来源写进列**：`search_volume_source`（brand_aba / competitor-monthly / manual）、
  `cvr_source`。同一个数来自 ABA 还是竞品工具，权重不一样。
- **不折算**：西柚只给**周均**搜索量。折算成月（×4.33）会伪造一个 SOP 阈值要用的估计值，
  所以它只进 `weekly_searches`，`search_volume` 保持为空。
- **不编造**：`relevance.score` 不做（hub 里是硬编码 80 + 「待评分系统填充」）。没有数据源就没有。

### 11.4 导入的幂等与可撤销

- 文件身份 = **大小 + 内容 sha256 前 16 位**。同一字节第二次导入是**空操作**并说明原因
  （同名 / 不同名都会报）。实测源目录里 `数据聚合-ASIN-搜索词(0)-202603.xlsx` 与
  `…-20260401-20260416.xlsx` **字节完全相同** —— 两份都算会翻倍。
- `source_file` 必须 `resolve()` 后再存：它是事实表主键的一部分，
  `D:/x/a.xlsx` 与 `D:/x/a.xlsx` 会被当成两个来源。
- **排除 ≠ 删除**：`kw_import.included = 0` 只把该文件从汇总里拿掉，事实表不动，恢复即原样回来。
  `keyword.source_file` 让这件事对**纯词表导入**也有效（那些词只有 `keyword` 一行、没有事实）。
  `source_file IS NULL` 的词来自浏览器扩词或人工 —— 是常驻词库，**不属于任何导入文件**，
  不该被排除动作带走。

### 11.5 周期重叠：只报不猜

广告报告的统计窗口天然重叠（SP 原始表 `20260101-20260415` 盖住聚合表 `202603`）。
两份都计入会重复计数，但**哪一份该排除是业务判断，不是代码能决定的**。
所以：报出重叠对（`amzn_kw_source` / 页面警告 / 报告第一节），并给一个**按文件排除**的开关。

`深谷-us-sp-搜索词-20260314-20160412-…` 的结束年份写成 **2016**（笔误）。当成正常区间会让
重叠检测失效；按 min/max 归一化会得到一个跨十年的区间，把所有东西都报成重叠；
猜成 2026 则往主键里写一个编造的值。**做法是三者都不选**：报告 `period-inverted`，
周期标签原样保留，但这个文件**不参与重叠检测**。

### 11.6 报告的第一节必须是「数据边界」

`amzn_kw_report` 的 HTML 第一节不是概览，是**边界声明**：

- 没有搜索量的词有多少（本库 19,469 / 31,805）—— 缺数据 ≠ 低价值；
- 落到默认产品线的未分类词有多少（4,414）—— 它出现在 `bench-cushion` 的计数里，但不是判定的结果；
- 哪几对广告报告周期重叠；
- 所有比率是百分数、口径来源在哪一列。

一个数字离开它的覆盖度就会被读成别的意思（「31,805 个关键词」被读成「31,805 个有搜索量的词」）。

### 11.7 报告与导出必须用同一个扫描上限

共享 `SET_SCAN_LIMIT`。分开写时报告说「否定词建议 668 条」、用户打开 CSV 却是 746 条 ——
同一个问题两个答案，且两个产物都没说为什么。**两个产物都打印自己扫了多少条**，这样这件事
是可检查的，而不是一个靠巧合成立的相等。

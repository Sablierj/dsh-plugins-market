# B-13d 校验体系与交付边界 · 接口契约（G2）

> **日期**：2026-10-12 ｜ **作者角色**：架构师（由全栈开发代拟，G2 由主理人裁决）｜ **状态**：**草稿 → 待 G2**
> **关联需求编号**：F13-08（校验体系：规则/闸门双面板 + Agent 审阅）、F13-09（交付边界：可复制字段/操作清单/发布登记跳转）
> **关联需求文档**：`docs/requirements/RESEARCH-module-alignment-v2.0.md` §3.13 模块 13 的 :353、:354 两行
> **关联协同**：`docs/COORDINATION.md` §7.3「B-13 剩余」
> **体例参照**：`docs/architecture/API-B13c-strategy-and-plan.md`（本仓上一批）
> **基线（开工前实测）**：`main bd8bad8`（worktree `wt-dsh-b13d` / 分支 `dsh-b13d`），
> `node amazon-ops/scripts/check-migrations.mjs` → `{"count":43,"SCHEMA_VERSION":43,"dups":[],"continuous":true}`，
> `TOOLS` = **128**（`node scripts/check.mjs` → `OK amazon-ops (plugin: workbench) — 128 tool(s) registered`），
> `node tests/run.mjs` = **1671 passed / 0 failed**，`node scripts/check-page.mjs` = **3/3**
> **本批目标**：schema **v44**，`TOOLS` 128 → **130**（**+2**：一个只读统一入口 + 一个可写的审阅结论）
> **证据等级**：本文「现状」一节每条都在本次作业中对着 `src/` 实测（`read`/`grep`/`node`），标 `verified`；引用需求文档的标 `documented`。

---

## 0. 范围与非目标

### 0.1 这一批做什么

| 功能点 | 本批交付的深度 |
|---|---|
| F13-08 校验体系 | **三块各有面板、一个统一入口**：① 规则校验（每条带 `ruleId` / `severity` / `source` / 字段 / 说明，逐条列出，不再只有 chips）；② 闸门判定（六道，每道带**判据（what）**与**依据（source）**，不只是 pass/detail）；③ Agent 审阅（14 项清单 = `LLM_ONLY_CHECKS` 的 11 项 + 新增的自然度/说服力/品牌语气，**结论落库、可逐字段、必须引用证据**）。统一入口 = `readValidationSystem()`，被 `amzn_optimize_validation` 与页面 `/api/state` 同时读，页面**不重算任何一条判据** |
| F13-09 交付边界 | ① **可复制字段**（已有，沿用）；② **操作清单**：一条一条「去后台做什么」，每条带落点（后台路径）、状态与判据，Markdown 用 `- [ ]`、HTML 用只读的 checkbox；③ **发布登记跳转**：优化面板 → 模块 14 发布登记，链接带 `runId`，草案版本**从 run 行读回来**（不是链接里的字面量），登记表单预填 kind/runId/draftVersion/asin/站点；④ **交付边界口径**：「插件提供的字段」「插件**不提供**的字段」「插件提供但**这一轮没有生成**的字段」三种分开计数，谁也不压成谁；⑤ 报告正文加「**接受草案 ≠ 已发布**」的声明 |

### 0.2 这一批明确不做（非目标）

1. **不做字段级决策四选**（F13-07）。收件箱与交付边界都只是**读者**：接受/驳回仍然只走 `amzn_optimize_save` 的 `accept[]` / `reject[]`，本批不新增任何改 `accepted` 的写入口。
2. **不做一个「全部通过」的绿灯**。三块面板各自报自己的结论；没有一处把「规则 0 命中 + 闸门 6/6 + 审阅 14/14」合成一个「可以发布」。本插件**不发布**（§15），「可以发布」这句话不在本批的词汇里。
3. **不新增第二个 Agent 审阅清单**。`REVIEW_ITEMS` 的 11 项**来自 `listing-rules.js` 的 `LLM_ONLY_CHECKS`**（import，不是抄一遍），只追加 3 项；测试钉住「每一个 `LLM_ONLY_CHECKS` 的 id 在 `REVIEW_ITEMS` 里恰好出现一次」，两边漂开就红。
4. **不把审阅结论压成布尔**。`pass` / `fail` / `unclear` 是三值；「这一项没有人下过结论」（`pending`，没有行）与「下过结论是 unclear」是两句不同的话。
5. **不做自动审阅**。本批只提供**载体**与**证据校验**：谁写结论、拿什么当依据由人/Agent 决定；插件不调用模型。
6. **不新增位置计划/证据/策略的任何第二份口径**（B-13b / B-13c 的边界继续有效）。
7. **不新增可勾选清单的持久化状态**。「这条后台操作做完了没有」的持久事实**就是发布登记**（模块 14 §6）：交付边界**读**发布登记的内容重算每条操作的状态，不再加一个自报的 `done` 列。
8. **不删任何列、不删任何既有表**；`optimization_draft.accepted` 三态、`optimization_run.status` 四态、`keyword_plan` 语义一律不变。
9. **不碰** `src/sources/**`、`src/domain/collect/**`、`src/domain/asin/**`、`src/domain/prompts/**`、`src/store/prompt.js`、`src/tools/prompt.js`、`src/domain/rules/**`（只 import，不改）。
10. **不做真机采集**；**不新增 Seller Central 的按钮/链接**（§15：本插件不发布，只给「去哪儿做」的文字与内部跳转）。

---

## 1. 现状复核（逐条 `verified`）

### 1.1 F13-08 今天有什么、缺什么

| 现状 | 证据 |
|---|---|
| 规则命中带 `ruleId` / `severity` / `source` | `src/domain/optimize/validate.js:278`（`validateDraft`）、`src/domain/rules/listing-rules.js:1320`（`CHECKS`） |
| 六道闸门与其 `what` / `source` | `validate.js:484-590`（`GATES`，每道都有 `what` 与 `source`）、`:606`（`runGates`） |
| 工具侧分开列闸门与规则 | `src/tools/optimize.js:1215-1239`（`## 收尾闸门` / `## 规则命中` / `**这份校验不判定的事**`） |
| 页面侧只有 chips + 逐字段违规 | `src/web/page.js:3923`（`闸门 p/t` 一个 chip）、`:3644`（`gateBlock` 画在 `optrun` 里，**不是**一个独立面板、不是跳转目标） |
| `LLM_ONLY_CHECKS` 11 项 | `listing-rules.js:1334-1346`；报告 8.3 列出（`report.js:666-673`） |

**缺口**（与审计 :353 逐条对齐）：
- **闸门没有自己的面板**：`gateBlock` 画在轮次表头那一块里，没有 `sect-` 落点，锚点跳不进去。
- **规则没有面板**：只有 `violationChips(run.counts)` 两个数字，逐条违规只在每个字段的卡片里出现。
- **Agent 审阅没有任何面板**，也不在页面载荷里（`grep optreview` 零命中）；结论**一行都不落库**（全库 `grep optimization_review` 零命中）。
- **三者没有统一入口**：工具侧是 `amzn_optimize_validate`（要求一份 draft 作入参，是**草案级**的），页面侧是散在 `optrun` 里的三小块；没有一个「这一轮的校验体系」的读入口。

### 1.2 F13-09 今天有什么、缺什么

| 现状 | 证据 |
|---|---|
| 可复制字段 | `report.js:587`（Markdown）、`:1000`（HTML）：`publishable && after && accepted` |
| 独立编辑器字段清单 | `report.js:602-606`、`:1007-1009` |
| 必须人工填的字段（三态：已知 / 空 / 库内无对应列） | `report.js:323-331` + `:769-772`（`manualStatusLabel`）；`listing-fields.js:181-189`（`MANUAL_FIELDS` 七项） |
| 写回口径（可写回 / 只出草案） | `listing-fields.js:360`（`writebackSplit`） |
| 发布登记表单 | `page.js:4139-4161`；`runId` 与「草案版本」是**两个空输入框**（`:4152-4153`） |
| 全库无 Seller Central 按钮 | 只有散文引用（`report.js:734-739` 的十二节） |

**缺口**（与审计 :354 逐条对齐）：
- **操作清单不存在**：第十二节是六条**写死的散文**（`report.js:732-742` 与 `:1095-1102`），不随这一轮的内容变，列不出「哪几个字段、去哪儿、什么状态」。
- **发布登记跳转不存在**：优化面板没有带预填的入口；`runId` / 草案版本靠人手抄。
- **交付边界说不清**：「插件提供但这一轮没生成」与「插件根本不提供」今天都被折叠进「没有这一项」（`rows` 里没有这个字段 / `MANUAL_FIELDS` 里这个字段）—— 这两句在本仓是**两句不同的话**。
- **报告正文没有「接受草案 ≠ 已发布」的声明**：该句只出现在模块 14 的表单提示里（`page.js:4157-4158` 的 hint 与 `observe.js:178`）。

---

## 2. 数据模型变更（schema v43 → v44）

### 2.0 版本号与追加纪律

- `SCHEMA_VERSION` 由 `MIGRATIONS` 末项的 `version` 派生，无字面量；**开工时实测为 43**（`check-migrations.mjs` 原文见 §7），故本批用 **44**。
- 本仓已发生**两次**迁移撞号（v40 / v42），所以：① 只在 `MIGRATIONS` 数组**尾部追加**一个 `version: 44` 的对象，不改动、不重排 1–43；② **合并前后各跑一次** `scripts/check-migrations.mjs`（`docs/COORDINATION.md` §7.5 第 4/5/6 条）。
- 迁移体全是 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`（幂等），**不加列、不删列、不改列**。

### 2.1 新表 `optimization_review`（F13-08 的 Agent 审阅）

```sql
CREATE TABLE IF NOT EXISTS optimization_review (
  run_id        TEXT NOT NULL REFERENCES optimization_run(id),
  item_id       TEXT NOT NULL,               -- REVIEW_ITEMS 的 id（14 项之一）
  field         TEXT NOT NULL DEFAULT '',    -- '' = 整份草稿；否则是逐字段的那一条
  conclusion    TEXT NOT NULL,               -- pass | fail | unclear
  note          TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',  -- 结论引用证据：{ kind, ref } 的数组
  reviewed_at   TEXT NOT NULL,
  reviewed_by   TEXT,                        -- 'agent' | 'page' | …
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (run_id, item_id, field)
);
CREATE INDEX IF NOT EXISTS idx_review_run ON optimization_review(run_id, item_id);
```

**为什么主键含 `field`**：审计的缺口之一是「**不逐字段**」。「一句话概括整份草稿」与「标题这一项没通过」是两条不同的结论，压成一行会让后者答不出来。`field = ''` 是「整份草稿」这一条，它本身也是一个位置，不是缺省值。

**为什么没有 `state` 列**：`pending` / `pass` / `fail` / `unclear` / `mixed` **由行本身重算**（`reviewItemState`），不给写入方自报的机会 —— 这是本仓刚修过的那个反例（B-13b §2.1、B-13c §2.1 同一条理由）。

**为什么证据是一个数组而不是一段文字**：`{ kind, ref }` 是**机器可检查**的引用（`rule` / `draft` / `evidence` / `fact` / `human`）。一段自由文字无法证伪「这个结论引用了不存在的规则」，而「结论引用证据」正是审计说的那个缺的载体。

### 2.2 迁移与回滚

- **迁移**：`version: 44`，一条 `CREATE TABLE IF NOT EXISTS` + 一条 `CREATE INDEX IF NOT EXISTS`。已有库平滑升上去：新表为空（= 这个库还没有任何审阅结论，页面必须说「这一轮没有审阅结论」而不是「0 项通过」）。
- **回滚**（原文）：

```sql
DROP INDEX IF EXISTS idx_review_run;
DROP TABLE IF EXISTS optimization_review;
```

回滚**丢数据**：审阅结论会消失。`optimization_run` / `optimization_draft` / `optimization_evidence` / `optimization_strategy` / `optimization_plan_check` / `keyword_plan` / `publication` 全部不受影响（本批**不新增**任何其它表、不新增列）。
- **可重复执行**：两条都是 `IF NOT EXISTS`，幂等。

---

## 3. 词表（本批新增的两个，防止「没有」被压成一个空值）

### 3.1 审阅结论 `REVIEW_CONCLUSIONS`

| 值 | 含义 | 机器可检查的形式 |
|---|---|---|
| `pass` | 看过这一项，通过 | 有一行，`conclusion='pass'`，`evidence` 非空 |
| `fail` | 看过这一项，不通过 | 同上，`conclusion='fail'` |
| `unclear` | 看了，**判不了**（缺输入 / 需要人对着实物） | 同上，`conclusion='unclear'` |
| （没有行） | **没有人对下过结论** | 行的数量是 0 —— 它**不是** `unclear` |

一项的汇总状态 `reviewItemState`：有 `fail` → `fail`；没有 `fail` 但有 `unclear` → `unclear`；全是 `pass` → `pass`；一条行都没有 → `pending`。

### 3.2 交付边界 `DELIVERY_BOUNDARY_KINDS`

| 值 | 含义 | 谁提供值 |
|---|---|---|
| `plugin` | 插件**提供**这个字段（草案由这一轮产出） | 插件 |
| `human_only` | 插件**不提供**这个字段（采集不到、也推断不出来） | 人 |
| `not_generated` | 插件**会**提供这个字段，但**这一轮没有生成**它的草案 | 取决于这一轮的输入/模式 |

**三者分开计数、分开列名**。把 `human_only` 与 `not_generated` 合成一句「没有这个字段」，正是本仓反复付代价的那种压缩（审计 :354 的一半缺口就在这里）。

---

## 4. F13-08 校验体系 · 接口

### 4.1 统一入口

唯一实现在 `src/domain/optimize/validation-system.js`：

```js
readValidationSystem(store, runId, { view = null } = {}) -> { ok, runId, asin, … , rules, gates, review, counts, empty }
```

- `view`（可选）是 `describeOptimizationRun(store, run)` 的产出。**传了就一定用它**，页面侧就是这样：`run.gates`（表头那个 chip）与 `validation.gates`（面板）**来自同一次计算**，「一个数字两处显示」不可能漂。
- 不传就自己调一次 `describeOptimizationRun`（工具侧）。

**三块各自的判据来源**（一句话：页面没有第二条能自己算出来的路）：

| 块 | 判据来源 | 是否重算 |
|---|---|---|
| `rules` | `view.drafts[].violations`（`violations_json` 的投影，与 run 表头的 `counts` 同源） | 否 |
| `gates` | `view.gates`（`runGates` 的产出，与表头 chip 同源） | 否 |
| `review` | `optimization_review` 的行 + `REVIEW_ITEMS` | 状态由行重算 |

### 4.2 `rules` 块

```
rules: {
  counts: { block, warn, total },      // 由下面那些行自己数出来的（只数 block/warn）
  persisted: { block, warn },          // view.counts —— 收件箱/表头用的那个数字
  drift: boolean,                      // 两者不等 → true（见下）
  rows: [ { draftField, draftFieldLabel, field, fieldLabel, ruleId, severity, source, title, messages[] } ],
  distinct: n,                         // 按 (字段, 规则, 说明) 去重后的条数
  duplicates: n,                       // rows.length - distinct —— 聚合字段的规则记在它覆盖的每个字段上
  uncounted: n,                        // 严重度不是 block/warn 的行（进 rows，不进 counts；今天恒为 0）
  empty: { kind, text } | null,
}
```

**`rows` 来自 `view.drafts[].violations`，不重算一遍 `validateDraft`。** 理由：那一份是**这一轮当初 persist 时写下的**判定，`violationChips` 与收件箱的「阻断/警告」列读的也是它；再算一遍会与同一屏上的另一个数字打架（B-13c 的 `validation`/`gates` 是**现算**的，两者可能不同 —— 因为 listing 可能在这之后变了）。

**`drift` 是真会发生的事**，所以要说出来而不是藏起来：`rules.counts` 数的是行，`view.counts` 走的是 `countViolations`（只数 `block`/`warn`）。两者不等说明**投影漏了行或数错了**，`drift: true` 且面板要显示它。测试里用一个「severity 不是 block/warn 的违规」把这条钉住。

### 4.3 `gates` 块

```
gates: {
  passed, total, ok,
  rows: [ { id, label, what, source, pass, detail } ],
  empty: { kind, text } | null,
}
```

`what`（这一道闸门判什么）与 `source`（依据哪份文档）**必须带出来**：审计 :353 说这半是「已实现」的，但页面今天只画了 `label / pass / detail` —— 一个没有判据的闸门行，读者只能猜它为什么没过。

> **实施时的一个实测发现**（`verified`）：这两个字段**当时根本不在 `runGates` 的产出里** —— `validate.js:612-620` 展开的是 `{ id, label, source, ...outcome }`，`what` 被丢掉了（`outcome` 只有 pass/detail/各闸门自己的载荷）。所以本批**必须**先把它接回来（`GATES` 自己的 `what`，不是从别处再查一次表），否则面板上的「判据」永远是空的。这条属于「审计说已实现，实测发现缺一个字段」。

**`gates` 是现算的**（`runGates` 在 `describeOptimizationRun` 里对当前草案跑一次），与 B-13c 的 `validation` 同源，本批**不改**这个口径，只是在载荷里说清 `judge.judgedAt = 'live'`。

### 4.4 `review` 块（Agent 审阅）

唯一实现在 `src/domain/optimize/review.js`：

```js
REVIEW_VERSION, REVIEW_SOURCE, REVIEW_CONCLUSIONS,
REVIEW_ITEMS, REVIEW_ITEM_IDS, REVIEW_CODES,
reviewItemState(rows)                 -> { state, counts, fields }
readReview(store, runId)              -> { ok, present, items: [...], counts, empty }
recordReview(store, { runId, itemId, field, conclusion, note, evidence, by, now })
listReviewRows(store, runId)
readReviewRow(store, runId, itemId, field)
```

**14 项清单**（`REVIEW_ITEMS`）：

- 前 11 项**逐项来自** `LLM_ONLY_CHECKS`（`listing-rules.js:1334`）：`audit.hallucination` / `audit.contradiction` / `audit.intent.coverage` / `audit.cosmo.causal` / `audit.npo` / `audit.review.alignment` / `audit.geo.answerable` / `audit.qa.buyer` / `audit.aplus.increment` / `audit.attribute.fact` / `audit.ai.disclosure`。`id / source / ask` **原样**取自它，本批只补「中文标签」与「分组」两个**显示**属性（`REVIEW_LABELS` / `REVIEW_GROUPS`），并有一条测试钉住两边一一对应。
- 后 3 项是审计点名缺的：`audit.naturalness`（自然度）/ `audit.persuasion`（说服力）/ `audit.brand_voice`（品牌语气）。

**每项带 `needsHuman`**：`audit.brand_voice` 与 `audit.attribute.fact` 只能由人对着实物/品牌规范判断 —— 本仓有 `brand` 表（`name / aliases_json / forbidden_json / is_own / note`，`schema.js:1474`），但**没有语气（tone/voice）这一列**。所以这一项的 `source` 指得出「品牌名与禁用写法在 `brand` 表里」，而**语气本身本仓没有来源** —— 这是「本仓没有这一项」的一半，不是「这次没测到」。报告与面板都必须这么写。

**`recordReview` 的入参 / 出参 / 拒绝**：

| 入参 | 必填 | 说明 |
|---|---|---|
| `runId` | 是 | 审阅的是**哪一轮** |
| `itemId` | 是 | 14 项之一；不是 → `REVIEW_UNKNOWN_ITEM` |
| `field` | 否 | 逐字段的那一条；给了就必须是**这一轮真的有的字段**（`optimization_draft.field`）→ 否则 `REVIEW_UNKNOWN_FIELD` |
| `conclusion` | 是 | `pass` / `fail` / `unclear`；其它 → `REVIEW_BAD_CONCLUSION` |
| `note` | 否 | 一句话；`unclear` 时**必填**（判不了要说清判不了什么）→ 否则 `REVIEW_NOTE_REQUIRED` |
| `evidence` | 是 | `[{ kind, ref }]`，非空；`kind` 不在五种里或 `ref` 解不开 → `REVIEW_EVIDENCE_UNRESOLVED`，逐条报出来 |
| `by` | 否 | `'agent'` / `'page'` / …；署名 |

**证据引用的可检查性**（`kind` → `ref` 必须解得开）：

| kind | ref | 怎么算解不开 |
|---|---|---|
| `rule` | 规则 id | 不在 `RULES`（`listing-rules.js:245`）里 |
| `draft` | 字段名 | 这一轮没有这个字段的草案 |
| `evidence` | 一个证据类 id | 不在 `EVIDENCE_KINDS`（`domain/optimize/evidence.js`）里 |
| `fact` | 事实台账里的标签 | 空串 |
| `human` | 人看过什么（一句话） | 空串 |

**幂等**：同 `(runId, itemId, field)` 再写一次、内容相同 → `unchanged: true`，不动时刻戳；内容不同 → 覆盖并更新 `updated_at`（一条结论可以被后来的审阅改，这是**更晚的意图**）。

**读回对账**：写完**重新读那一行**、用 `reviewItemState` 重算这一项的汇总状态，与「按这次意图它应当是的状态」比对；不一致 → `REVIEW_STATE_MISMATCH`，不谎报成功（B-13c 的 `confirmStrategy` 同款）。

### 4.5 工具 `amzn_optimize_validation`（只读，统一入口）

**入参**：`runId`（必填）。

**出参**（`ok: true` 时）

```
{
  ok: true, runId, asin, marketplace, status,
  judge: { roster: { version, source }, judgedAt: 'live' },
  rules:  { counts, persisted, drift, rows, distinct, duplicates, uncounted, empty },
  gates:  { passed, total, ok, rows, empty },
  review: { present, items, counts, conclusions, evidenceKinds, rosterDrift, empty },
  counts: { rules, gatesPassed, gatesTotal, reviewConcluded, reviewTotal },
  empty: { kind, text } | null
}
```

`review.conclusions`（三值）与 `review.evidenceKinds`（五种证据 kind）**随载荷走**：页面上的下拉框用它渲染，不在页面里再写一份「三值是哪三个」—— 页面里写死的那一份会在加值的时候静默变成旧词表。

### 4.6 工具 `amzn_optimize_review`（读 + 记录结论）

- **不带 `conclusions`**：只读，等价于 `readValidationSystem(...).review`（外加 14 项清单与每项的证据要求）。
- **带 `conclusions`**：逐条走 `recordReview`；**先全部校验再写第一条**（一条坏结论不会留下半批写入）。每条的拒绝都报 `itemId` / `field` / `code` / `error`。
- 写路径会在审计里留一行（`optimization_review.record`），**被拒的写一行都不留**（本仓的固定纪律：`value?.ok === false` 才不落审计，所以拒绝必须返回结构化对象）。

### 4.7 错误码（F13-08）

| code | 触发 |
|---|---|
| `VALIDATION_NO_RUN` | `runId` 不存在 |
| `REVIEW_NO_RUN` | 同上（审阅的写入口） |
| `REVIEW_UNKNOWN_ITEM` | `itemId` 不在 14 项里 |
| `REVIEW_UNKNOWN_FIELD` | `field` 不是这一轮真的有的字段 |
| `REVIEW_BAD_CONCLUSION` | `conclusion` 不是三值之一 |
| `REVIEW_NOTE_REQUIRED` | `unclear` 没有 `note` |
| `REVIEW_EVIDENCE_UNRESOLVED` | 证据引用解不开（逐条报） |
| `REVIEW_EVIDENCE_REQUIRED` | `evidence` 为空数组 |
| `REVIEW_STATE_MISMATCH` | 写完之后读回重算的状态与这次意图不符 |
| `REVIEW_BATCH_REJECTED` | 批量入口里有一条不合法 —— **整批一条都不写** |
| `REVIEW_ROSTER_DRIFT` | `REVIEW_ITEMS` 与 `LLM_ONLY_CHECKS` 对不上（只会在测试里被断言，`reviewRoster()` 把它当数据交出来、不抛 —— `apply()` 抛错会拖垮整棵插件树） |

### 4.8 页面（F13-08）

三个面板，各有 `sect-` 落点（锚点跳得进去）：

```html
<div id="sect-rules"><div id="optrules"></div></div>
<div id="sect-gates"><div id="optgates"></div></div>
<div id="sect-review"><div id="optreview"></div></div>
```

- 页面**只读载荷**：三块的每一行都来自 `state.optimizations.validation`，页面里不出现 `severity === 'block'` 之外的任何判据，也不重算 `passed/total`。
- `gateBlock(run)`（画在 `optrun` 里的那一块）**移进 `#optgates` 面板**并读同一份载荷 —— 同一份判据不再有两个渲染点。表头那个 `闸门 p/t` chip 保留（读 `run.gates`），并由一条测试钉住它与 `validation.gates` 是同一组数字。
- 审阅面板：14 行，每行显示 `state` chip、结论、证据引用、`needsHuman`；带一个「记录结论」的表单，POST `optimize-review-record`（与工具同一条领域函数 `recordReview` 与同一个审计 action）。

---

## 5. F13-09 交付边界 · 接口

### 5.1 唯一实现

`src/domain/optimize/delivery.js`：

```js
DELIVERY_VERSION, DELIVERY_SOURCE, DELIVERY_SURFACES, DELIVERY_BOUNDARY_KINDS, DELIVERY_CODES,
buildDelivery({ run, rows, manualFields, publications, pagePath, now }) -> { boundary, operations, registration, counts, empty }
```

- `rows`：这一轮的草案行，投影只取 `{ field, accepted, after }`（`publishable` / `label` / 落点**由领域层从字段注册表算**，不由调用方给）。
- `manualFields`：`manualFieldRows(asin)` 的产出（`{ id, label, why, done, evidence }`，`done` 三态）—— **函数住在 `delivery.js`**，报告第十一节与页面读的是同一份（见 §10.6）。
- `publications`：该 run 的发布登记行（`{ id, kind, draftVersion, published, publishedAt }`）；`[]` = 一条都没有（**不是**「读过没有」）。

### 5.2 出参

```
{
  boundary: {
    plugin:      { count, fields: [...], attributes: { drafted, target }, note },   // 插件提供、这一轮有草案的
    humanOnly:   { count, fields: [...], note },   // 插件不提供（MANUAL_FIELDS）
    notGenerated:{ count, fields: [...], note },   // 插件会提供、这一轮没生成（DRAFT_FIELDS 差集）
    totals: { drafted, registry },                 // 这一轮草案数 / 注册表里插件会产出的固定字段数
  },
  operations: [ {
    id, order, surface, surfaceLabel, where,        // 落点：后台路径
    field, fieldLabel, action,                      // 「做什么」一句话
    status, statusLabel, why,                       // 状态**由内容重算**
    accepted, publishable,
  } ],
  registration: {
    route: 'publication-record', sectionId: 'sect-publication',
    anchor: 'publication:draft:<runId>', href,
    runId, draftVersion, draftVersionKnown,
    fields: [ ... ],                                // 预填 published 的建议内容
    registered: { count, latestId, latestAt, fields: [...] },  // 已登记的内容（读回来的）
    hint,                                           // 「接受草案 ≠ 已发布」
  },
  counts: { operations, ready, editor, notAccepted, noText, humanRequired, humanKnown, humanUnknown, registered, unmappedSurfaces, notGenerated, humanOnly, registeredFields },
  unmappedSurfaces: [ ... ],                      // 注册表里有、但没人认领落点的 section（今天恒空，自检用）
  empty: { kind, text } | null,
}
```

`DELIVERY_SURFACES` 里每个落点声明自己认领哪些 `sections`，`SURFACE_BY_SECTION` 是**从那张表派生的**（不是第二张表）。所以「注册表加了一个 section 却忘了给它落点」会被 `unmappedSurfaces` 数出来，而不是悄悄归进「上架表格」。属性字段另有 `plugin.attributes = { drafted, target }`：属性集随类目变（43 项是注册表声明的目标），所以这里只给条数、不逐项断言「哪一项没生成」—— 逐项填写情况在报告的属性一节里。

### 5.3 操作清单：一条一条，状态由内容重算

每一行是「人照着去后台做什么」。`status` **不是**自报的，全部由内容重算：

| status | 含义 | 判据 |
|---|---|---|
| `registered` | 这个字段**已经登记过发布**（人已经在后台改过） | 该 run 的发布登记 `published` 里出现了这个字段 |
| `ready` | 可复制粘贴（`publishable`），草案已被采纳 | `accepted && after && isPublishable(field)` |
| `editor` | 去独立编辑器（A+ / 品牌故事 / Q&A / Alt Text / 视频） | `accepted && after && !isPublishable(field)` |
| `not_accepted` | 有草案，但**没被采纳** —— 不要去改 | `after && !accepted` |
| `no_text` | 这一轮**建模了**这个字段，但没有草案 | 字段在这一轮的 rows 里出现但 `after` 为空 |
| `human_required` / `human_known` / `human_unknown` | 插件不给，必须人填 | `MANUAL_FIELDS`；`done === null` → `human_unknown`（库内无对应列）。这三态的**措辞**来自 `manualStatusLabel`（与报告第十一节同一句） |

**「已登记」这一条就是读回对账**：写入方（模块 14 的 `amzn_publication_record`）自报「实际发布了哪些字段」，交付边界**不看它自报的任何状态**，而是**自己扫 `published` 的键**去重算每一条操作的状态。发布登记把某个字段写进 `published` 之后，对应的操作行必须变成 `registered` —— 这一条既证明「状态由内容推导」，也证明交付边界没有另存一份「做完了没有」。

### 5.4 发布登记跳转

- 优化面板（`#sect-delivery` → `#optdelivery`）里有一条跳转：`followTodo('#optimize#publication:draft:<runId>')` ——
  复用**页面已有的那一套**跳转（`followTodo` → `patchContext({ anchor })` → `scrollToSection`），不新造第二套。
- `routes.js` 解析锚点 `publication:draft:<runId>` → `publicationIntent = { kind: 'draft', runId }`；解析不出就 `null`（退化成「没带意图」，不崩）。
- **草案版本从 run 行读回来**（`run.draft_version`），不是链接里的字面量：`recordPublication` 要求「草案版本必须等于该运行的当前 `draft_version`」（`tools/observe.js:116-120`）。链接里钉一个版本号，会在草案又改过之后变成一次注定被拒的登记 —— 而 `draftVersionKnown: false`（读不到）与「版本是 0」也是两句不同的话。
- 预填的 `fields` = 操作清单里 `ready` 的那些字段（`field → after`），因为那正是「人刚从报告里复制过去的东西」。

### 5.5 报告正文（F13-09）

- 第十二节 **从写死的六条散文改成操作清单**（由 `model.delivery` 渲染）：
  - Markdown：`- [ ] 后台搜索词（Seller Central → Inventory → …）：复制第六节的内容` —— **可勾**；
  - HTML：`<input type="checkbox" disabled>`（报告是自包含的静态文档，勾选状态不落库；要留痕就去登记发布，那才是持久事实）；
  - 每条后面跟它的 `status` 判据，以及「已登记 / 未登记」。
- 新增 **12.x 交付边界**：三行分开的数字（插件提供 / 插件不提供 / 插件会提供但这一轮没生成）+ 一句「**接受草案 ≠ 已发布**：本插件不改你的 listing；这份报告里的文字在你到后台改完并登记发布之前，线上一个字都没变。」
- 8.3 的清单改用 `REVIEW_ITEMS`（14 项）而不是 `LLM_ONLY_CHECKS`（11 项）——报告与面板是同一份清单。
- `amzn_optimize_validate` 的「**这份校验不判定的事**」同样改用 `REVIEW_ITEMS`（否则同一件事在工具与页面是两个数字）。

### 5.6 错误码（F13-09）

| code | 触发 |
|---|---|
| `DELIVERY_NO_RUN` | `runId` 不存在 |
| `DELIVERY_NO_DRAFTS` | 这一轮一个字段都没起草过（**不是**「交付清单为空」） |

---

## 6. 关键数字

| 项 | 开工前（实测） | 本批后（实测） |
|---|---|---|
| `SCHEMA_VERSION` | 43 | **44** |
| `TOOLS` | 128 | **130** |
| 新表 | — | **1**（`optimization_review`） |
| Agent 审阅清单 | 0 项有面板 / 11 项只在报告里 | **14 项**（11 + 3） |
| 校验体系面板 | 0 个独立面板 | **3 个**（`sect-rules` / `sect-gates` / `sect-review`） |
| 交付边界：三种「没有」 | 折叠 | **3 类分开计数** |
| 操作清单 | 6 条写死的散文 | **由内容生成，逐条带状态** |
| 发布登记跳转 | 无（两个空输入框） | **有**（面板 → `sect-publication`，预填 kind/runId/版本/ASIN/站点/字段） |
| 页面写路由（optimize 区） | 7 | **8**（+`optimize-review-record`） |
| `node tests/run.mjs` | 1671 passed / 0 failed | **1696 passed / 0 failed**（+25：23 条在 `tests/b13d-validation-delivery.mjs`，2 条是随工具数增长的逐名守卫） |
| `node scripts/check-page.mjs` | 3/3 | **3/3** |
| `node scripts/check.mjs` | `OK … 128 tool(s) registered` | `OK amazon-ops (plugin: workbench) — 130 tool(s) registered`（**N > 0**；本文件 §11 解释为什么这一条命令的 **exit code 是 1** 而不是 0 —— 与本批代码无关） |

### 6.1 载荷契约变化

`data.optimizations` 多两块（并新增一个 `run.draftVersion`）：

- `validation`（`readValidationSystem` 的产出：`rules` / `gates` / `review` / `counts`）—— `optrun` 里原来内联的 `gateBlock` 改为读它；
- `delivery`（`buildDelivery` 的产出：`boundary` / `operations` / `registration` / `counts`）—— 面板与发布登记表单都读它；
- `publicationPrefill`（`{ kind, runId, draftVersion, draftVersionKnown, asin, marketplace, fields } | null`）—— 锚点带来的登记意图 + 从 run 行读回来的版本。

**页面不再自己推任何一条状态**：`drift` / `passed` / `total` / 每一项的 `state` / 每一条操作的 `status` 全部由服务端算好，页面只做 `includes` 式的成员测试与渲染。

---

## 7. 探针原文（开工前）

```
$ node amazon-ops/scripts/check-migrations.mjs
{"count":43,"SCHEMA_VERSION":43,"dups":[],"continuous":true,"last":"asin-saved-view","first":"initial-schema"}
迁移表自洽 ✓
```

```
$ node tests/run.mjs   （末尾）
1671 passed, 0 failed
```

```
$ node scripts/check-page.mjs
OK   ① outer node --check
OK   ③ template literal integrity — 2 template literal(s), 1 nested in ${…}
OK   ② inner node --check (.cjs) — 498542 chars, checked as a sloppy classic script

3/3 passed
```

```
$ node scripts/check.mjs   （节选）
  OK   amazon-ops (plugin: workbench) — 128 tool(s) registered: amzn_workbench_context, …
```

### 7.1 完工后（实测原文）

```
$ node amazon-ops/scripts/check-migrations.mjs
{"count":44,"SCHEMA_VERSION":44,"dups":[],"continuous":true,"last":"optimization-review","first":"initial-schema"}
迁移表自洽 ✓
```

```
$ node tests/run.mjs   （末尾）
1696 passed, 0 failed
```

```
$ node scripts/check-page.mjs
3/3 passed
```

```
$ node scripts/check.mjs   （节选；exit code 的解释见 §11）
  OK   amazon-ops (plugin: workbench) — 130 tool(s) registered: amzn_workbench_context, …
```

---

## 8. 非目标（再次，防止被读成承诺）

见 §0.2。特别是：**不做字段级四选**、**不合成一个「可以发布」的绿灯**、**不新增第二个审阅清单**、**不给操作清单加一个自报的 done 列**、**不调用模型**、**不发布**。

---

## 9. 破坏性验证（真跑，回退 → 变红 → 改回）

五次证伪都在本 worktree 上真跑（`node tests/run.mjs` 太慢，用同一套 check/checkAsync/equal 的
`scratch/run-b13d.mjs` 只跑本批 23 条；改回之后逐字节校验 SHA-256 一致）：

| # | 改坏什么 | 变红的是哪几条（原文） | 说明了什么 |
|---|---|---|---|
| ① | `validate.js#runGates` 的 `compliance_coverage` 改成恒 `pass: true` | `b13d-val ① and the compliance gate fails on it: expected false, got true`、**`b13d-page ⑬ the page sees the compliance gate fail: expected false, got true`** | **把域层改坏 → 工具侧与页面侧同时红**：页面没有第二条可以自己算出来的路 |
| ② | `review.js#reviewItemState` 改成恒 `'pass'` | `b13d-val ② every item is pending: expected 14, got 0`、`b13d-review ⑤/⑥/⑧/⑩`、**`b13d-page ⑬ the page sees the review item fail: expected "fail", got "pass"`**、`b13d-route ㉒`（共 7 条） | 「状态由内容重算」是真的在算；而且页面侧一起红 |
| ③ | `page.js` 的 `<div id="optrules">` 改成 `optrulesBROKEN`（**改坏夹具**） | 只有 `b13d-page ⑭ #optrules exists: expected false, got true`；负向对照 `#optValidationNothingHere` 仍绿，其余 22 条全绿 | 夹具坏了只有夹具那条红，判据没有连带失效 |
| ④ | `delivery.js` 把 `humanOnly` 与 `notGenerated` 合并成一个 37 项的 `missing` | `b13d-delivery ⑮ the hand-fill fields are the registry list: expected 7, got 37`、**`b13d-delivery ⑳ a field the plugin does model is not in the first row: expected false, got true`** | 「不提供」与「这一轮没生成」这条线在**面板侧与报告正文侧**两头都有牙 |
| ⑤ | `delivery.js` 不再扫发布登记 `published` 的键，改由自报状态推（恒空） | `b13d-delivery ⑱ one field is registered: expected 1, got 0` | 操作清单的「已登记」是**读回来**算的，不是自报的 |

改回之后：`node scratch/run-b13d.mjs` → **23 passed, 0 failed**；四个文件与备份 SHA-256 逐字节相同
（`validate.js BCFBBEC12587C871…`、`review.js 68D00C1C94DBDDD4…`、`page.js 1CBB842A5D43D36E…`、
`delivery.js 36CF54250898A433…`）。

---

## 10. 本批的实测订正与遗留

1. **审计 :353 的「规则校验 / 完成闸门双面板已分开」只对了一半**（`verified`）：闸门那一块**画在 `optrun` 里**（`page.js:3932` 调 `gateBlock`），没有 `sect-` 落点、不是面板；规则那一块在页面上只有两个 chip 数字（`violationChips(run.counts)`）。本批把两者做成真面板。
2. **`rules` 的口径**（`verified`）：页面上的「阻断/警告」数字来自**持久化的 `violations_json`**，而报告第八章的 `validation` 是 **save 时现算**的。本批**不改**这两者的口径，而是在载荷里把它们分开摆（`rules.persisted` vs `rules.counts`），并在面板上把 `drift` 说出来。
3. **`GATES` 的 `what` 当时不在 `runGates` 的产出里**（`verified`，实施时才发现）：`validate.js:612-620` 展开时丢掉了它。本批把它接回来（同一个对象自己的字段），否则闸门面板的「判据」一栏只能永远是空的。
4. **`readValidationSystem` 必须用 `getOptimizationRun`，不能用裸 `SELECT`**（`verified`）：第一版写的是 `store.get('SELECT * FROM optimization_run …')`，那一行**没有 `drafts`**，于是 `describeOptimizationRun` 在 `draftFieldsOf(run.drafts)` 上抛 `drafts is not iterable`。同一个对象的两个读法有同样的列名、不同的内容 —— 只有真跑才会发现。已在代码注释里写明。
5. **`tests/run.mjs` 的 `describeOptimizationRun` 导入者名单是【刻意】加了一项**（`verified`）：那条守卫把导入者**逐个列出**（不是数个数），本批新增的 `validation-system.js` 是第三个合法读取者，所以名单从 2 项改成 3 项。这不是放宽断言 —— 第四个不请自来的读取者仍然会红，而「定义只有一处」那一条一字未动。
6. **手填字段的三态搬了家**（`verified`）：`MANUAL_FIELD_EVIDENCE` / `manualStatusLabel` 从 `report.js` 移到 `delivery.js` —— 交付边界才是「哪些字段要人填」这个问题的属主，报告第十一节与操作清单读的是同一份 `done`。措辞也只有一处（`manualStatusLabel`），`DELIVERY_STATUS_LABELS` 里**没有**手填字段的三态。
7. **`check.mjs` 的 exit code**：见 §11。

---

## 11. `node scripts/check.mjs` 的 exit=1 说明（与代码无关，已证伪）

本 worktree 上这条命令的输出是：

```
  OK   amazon-ops (plugin: workbench) — 130 tool(s) registered: amzn_workbench_context, …
  FAIL amazon-ops — the profile's installed copy is not the plugin directory
       - profile "web": its node_modules copy of index.js is not the plugin's own
         (D:\deepseek-harness-h\workspace\profiles\web\node_modules\dsh-plugin-amazon-ops\index.js)
       fix: powershell -File scripts\link-user-plugins.ps1
```

**这是部署状态，不是插件状态**（`verified`，两条实测）：

1. `resolveInstalledCopy`（Harness 的 `scripts/check-user-plugins.mjs`）比较的是 profile 那份副本与本 worktree 的 `index.js` **字节**；profile 的副本 realpath 指向 `dsh-plugins`（主线），而本批的 `index.js` 多了两个工具名 → 字节不同。
2. 把 `index.js` 换回主线的版本跑一次：**exit 0**、仍然是 `130 tool(s) registered`（工具数来自 `src/tools/index.js` 的 `buildTools`，与 `index.js` 的名单无关）；换回本批的 `index.js`：又 FAIL。⇒ FAIL 只由那次字节差异导致。

**判定绿的两个信号都在**：`130 tool(s) registered`（**N > 0**，且 `apply()` 重放成功、Host 的 JSON Schema 校验全过）。
**没有**运行 `scripts\link-user-plugins.ps1` —— 它会改用户的 profile（那是不可逆的部署动作，且当前服务跑的是主线），不在本批的写作用域里。

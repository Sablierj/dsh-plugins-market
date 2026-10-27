# B-13b 优化收件箱与证据包 · 接口契约（G2）

> **日期**：2026-10-10 ｜ **作者角色**：架构师（由全栈开发代拟，G2 由主理人裁决）｜ **状态**：**草稿 → 待 G2**
> **关联需求编号**：F13-01（草案收件箱）、F13-03（证据包十类快照）
> **关联需求文档**：`docs/requirements/RESEARCH-module-alignment-v2.0.md` §3.13 模块 13 的两行（:346、:348）
> **关联协同**：`docs/COORDINATION.md` §7.3「B-13 剩余」一行（:2474）
> **体例参照**：`docs/architecture/API-B04-collect.md`
> **基线（开工前实测）**：`main bea5e6d`，`SCHEMA_VERSION` = **39**，`TOOLS` = **113**，`node tests/run.mjs` = **1527 passed / 0 failed**
> **本批目标**：schema **v40**，`TOOLS` 113 → **115**（**+2**）
> **证据等级**：本文「现状」一节每条都在本次作业中对着 `src/` 实测（`read`/`grep`/`node -e`），标 `verified`；引用需求文档的标 `documented`。

---

## 0. 范围与非目标

### 0.1 这一批做什么

| 功能点 | 本批交付的深度 |
|---|---|
| F13-01 草案收件箱 | 五态分组（待人工选择 / 待审批 / 驳回待修订 / 稍后 / 已作废）由**内容重算**；六个列（对象 / 站点 / 生成时间 / 阻断警告数 / 待确认项 / 审批状态）；行尾两个动作（继续审阅 / 基于此草案重新优化）；作废与恢复（两列 + 两条审计动作）；`context_id` 筛选 |
| F13-03 证据包 | 十类证据逐类落一行，**缺的那一类明说「这一类没有」**；每条带「来源 / 时间 / 适用字段」三要素；只读冻结表 `optimization_evidence` + 冻结后拒写守卫 |

### 0.2 这一批明确不做（非目标）

1. **不做字段级决策四选**（接受 / 驳回 / 修改后接受 / 稍后 的按钮）。F13-07 的验收项，属 B-13 剩余的后一半。本批只让 `accepted` 三态**被读出来**，不新增接受 / 驳回的写入口 —— 决策仍走 `amzn_optimize_save` 的 `accept[]` / `reject[]`。收件箱里的「待审批 / 驳回待修订」两个分组因此是**读者**，不是写者。
2. **不新建评论主题 / QA 的数据源**。本仓没有评论主题表、没有 Q&A 表、没有对应采集节；本批**不发明**这两类证据，而是在证据包里逐类写 `status='not_modelled'` 与理由（见 §4.4）。「本仓没有这一类」与「这一类这次是空的」是两句不同的话。
3. **不做「稍后」的到期提醒 / 定时器**。`deferred_at` 只是一个时刻戳；插件没有常驻定时器（`index.js` 的时间驱动规则只在打开工作台时跑），本批不引入调度器。
4. **不删任何列、不删任何既有表**；`accepted` 三态语义不变。
5. **不改 `optimization_run.status` 的四态词表**（`OPTIMIZATION_RUN_STATUSES`，`src/domain/states.js:251`）。
6. **不引第三方依赖**，不换存储，不换路由形态。
7. **不动 `src/domain/dashboard/todos.js`**（模块 01 的文件，不在本批写作用域）。01 待办行**仍然只带 `draftStatus`**；`context_id` 由**入口**（页面的 `followTodo`）补上并在筛选条上明示，见 §3.3。
8. **不做真机采集**，不碰 `src/sources/**`。

---

## 1. 现状复核（逐条 `verified`）

### 1.1 F13-01 今天有什么、缺什么

| 现状 | 证据 |
|---|---|
| 面板有 `#sect-inbox` / `#optdrafts` | `src/web/page.js:888` |
| 画「轮次表 + 选中轮次的字段卡」 | `page.js:3403-3414`（轮次表）、`page.js:3471-3475`（字段卡） |
| 过滤只有两个值 | `page.js:3901` `DRAFT_FILTER_LABELS = { pending: '未定', orphan: '没有上下文' }`；`page.js:3903-3907` `draftMatches` |
| 01 待办带 `draftStatus=pending` + `anchor=inbox` | `src/domain/dashboard/todos.js:211-213`；断言 `tests/run.mjs:3703` |
| `optimization_draft` 只有 `accepted` 三态 | `src/store/schema.js:482-490`（建表）+ `:606-608`（rationale / keywords_json / severity / updated_at）+ `:1310`（context_id） |
| 页面无任何 optimize 写路由 | `src/web/routes.js` 全文只有 `route === '…'` 的 GET/POST 表，无一条 optimize POST |

**缺口**（与审计 :346 逐条对齐）：五态分组、六个列、行尾两个动作、作废与恢复、`context_id` 筛选。

### 1.2 F13-03 今天冻结了哪四类

| 已冻结 | 证据 |
|---|---|
| 当前文案 | `package.before`，`src/tools/optimize.js:648` |
| 关键词包与位置计划**计数** | `package.keywords` / `package.plan`，`optimize.js:604`、`:612` |
| 规则快照 | `optimization_run.rules_json`（`schema.js:597`），由 `ruleSnapshot`（`optimize.js:91-109`）产出 |
| Prompt 快照 | `package.prompts`，`optimize.js:642-647` |

**缺口**（与审计 :348 逐条对齐）：listing 历史、评论主题样本、QA、竞品机会、产品线事实与品牌语气、质量缺失项；「来源 / 时间 / 适用字段」三要素；只读冻结表与冻结后拒写守卫。

**这两类的来源盘点（本批唯一承认的读取口）**：

| # | 证据类 | 来源 | 时间 | 适用字段 |
|---|---|---|---|---|
| 1 | 当前文案 | `listingBefore(store, asin, marketplace)`（`src/store/queries.js:1058`） | `listing.updated_at`（快照兜底时取 `asin_snapshot.collected_at`） | 全部起草字段 |
| 2 | 关键词包与位置计划 | `keywordSetFor`（`optimize.js:152`）+ `buildGlobalPlan`（`domain/optimize/plan.js`） | `asin_keyword.collected_at` 的最大值 | `plan` 的 12 个位置 |
| 3 | 规则快照 | `ruleSnapshot(store)` | `rule_set.published_at` | 全部（判定用） |
| 4 | Prompt 快照 | `resolvePrompts(store, { module: 'optimize', … })` | `prompt.updated_at` 的最大值 | 全部 |
| 5 | listing 历史 | `listSnapshots(store, { objectType: 'listing', objectId: '<ASIN>@<站点>' })`（`src/store/snapshot.js:247`） | 最新一行的 `created_at` | 历史各版本的 `title` / `bullets` / `description` |
| 6 | 评论主题样本 | **无来源** | — | — |
| 7 | QA（问答） | **无来源** | — | — |
| 8 | 竞品机会 | `readCompetitorEvidence`（`src/store/competitor-evidence.js:56`）+ `classifyQuadrant`（`domain/keywords/competitor.js:270`） | `kw_competitor_fact.collected_at` / `asin_keyword.collected_at` | 关键词覆盖相关字段 |
| 9 | 产品线事实与品牌语气 | `currentLineVersion`（`src/store/product-line.js:22`）+ `brand` 表（`schema.js:1474`） | `product_line_version.created_at` / `brand.updated_at` | `title` / `bullets` / `description` |
| 10 | 质量缺失项 | `listIssues(store, { objectId: '<ASIN>@<站点>' })`（`src/store/quality.js:152`） | `dq_issue.detected_at` | `dq_issue.field`（为空 = 对象级） |

`6` / `7` 的「无来源」是本次实测结论：全库 `grep reviewTopic|qaTopic|topics_json` 零命中，`schema.js` 的 67 张表里没有评论主题表也没有 Q&A 表。它们**必须**在证据包里以 `status='not_modelled'` 出现。

---

## 2. 数据模型变更（schema v39 → v40）

### 2.0 版本号与追加纪律

- `SCHEMA_VERSION` 由 `MIGRATIONS` 末项的 `version` 派生（`schema.js:2880`），无字面量；开工时实测为 **39**，故本批用 **40**。
- **只在 `MIGRATIONS` 数组尾部追加一个 `version: 40` 的对象**，不改动、不重排 1–39。
- 迁移体是追加式 SQL：`ALTER TABLE … ADD COLUMN`（SQLite 无 `IF NOT EXISTS`，只允许出现在只跑一次的迁移里）+ `CREATE TABLE IF NOT EXISTS`。

### 2.1 `optimization_draft` 加两列（F13-01）

| 列 | 类型 | 空值语义 | 说明 |
|---|---|---|---|
| `voided_at` | TEXT | **NULL = 没作废**（不是「作废时间未知」） | ISO-8601 UTC；非空即该草案被作废 |
| `deferred_at` | TEXT | **NULL = 没押后** | ISO-8601 UTC；非空即「稍后」 |

**为什么不加 `status` 一列**：`accepted` 三态是既成事实（`0 / 1 / NULL`，`setDraftAccepted` 是它唯一的写入方，`queries.js:1278`）。再加一个自报的 `status` 就是本仓刚修过的那个反例 —— **写入方自报、读者另算、两者无一致性检查**。五态因此**全部由内容重算**（§3.1），两列只承载「人做过的那两件 `accepted` 表达不了的事」。

**不加 `voided_by` / `deferred_by`**：署名归 `audit_log`（`recordAudit` 已经记 `actorKind` / `reason`）。加一列没人读的署名，就是给「谁做的」造第二份口径。

### 2.2 新表 `optimization_evidence`（F13-03，只读冻结表）

```sql
CREATE TABLE IF NOT EXISTS optimization_evidence (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES optimization_run(id),
  kind         TEXT NOT NULL,      -- 十类之一（EVIDENCE_KINDS 的 id）
  status       TEXT NOT NULL,      -- frozen | absent | not_modelled
  source       TEXT,               -- 字节来自哪个读取口（表名 / 读取函数名）
  source_at    TEXT,               -- 证据被观测到的时刻；NULL = 无日期（不是「就是现在」）
  fields_json  TEXT NOT NULL,      -- 这条证据适用的字段；'[]' = 适用整轮
  count        INTEGER,            -- 条数；not_modelled 时为 NULL（不是 0）
  payload_json TEXT,               -- 冻结副本
  note         TEXT,
  frozen_at    TEXT NOT NULL,      -- 冻结时刻
  created_at   TEXT NOT NULL,
  UNIQUE (run_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON optimization_evidence(run_id, kind);
```

**`UNIQUE (run_id, kind)` 就是「只读冻结表」的实现**：一类一行，重冻同内容幂等、重冻**不同**内容被拒（§4.5）。

### 2.3 迁移与回滚

- **迁移**：`version: 40`，两条 `ALTER TABLE` + 一条 `CREATE TABLE IF NOT EXISTS` + 一条 `CREATE INDEX IF NOT EXISTS`。已有库（`data/amazon-ops.db`）平滑升上去：两列对既有行是 `NULL`（= 未作废、未押后，与今天的读法一致），新表为空（= 这个库还没有证据包，页面必须说「没有」而不是「0 类」）。
- **回滚**：SQLite 支持 `ALTER TABLE … DROP COLUMN`（3.35+，`node:sqlite` 随 Node 22+ 带的版本满足）。回滚 SQL 写在 `docs/architecture/API-B13b-optimize-inbox.md` §2.4 与迁移同批交付的说明里，**不写成脚本**（本仓没有回滚脚本目录，回滚是「把这一批的迁移反向执行一次」这件事本身）。回滚**丢数据**：两列里的时刻戳与新表里的十类证据都会消失；`accepted` 与 `optimization_run` 不受影响。回滚**不删** `snapshot_registry` 里已有的草案快照。
- **可重复执行**：`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 幂等；两条 `ALTER TABLE` 只跑一次（迁移表按 version 记账），重复执行会抛 `duplicate column name` —— 这是**期望**行为，说明迁移被跑了两次。

### 2.4 回滚 SQL（原文）

```sql
DROP INDEX IF EXISTS idx_evidence_run;
DROP TABLE IF EXISTS optimization_evidence;
ALTER TABLE optimization_draft DROP COLUMN deferred_at;
ALTER TABLE optimization_draft DROP COLUMN voided_at;
```

---

## 3. F13-01 草案收件箱 · 接口

### 3.1 五态：由内容重算，不由写入方自报

唯一实现在 `src/domain/optimize/inbox.js`：

```js
draftInboxGroup(draft) -> 'voided' | 'deferred' | 'approval' | 'revision' | 'pending'
```

判据（**只看行自己的列**，优先级从高到低）：

| 序 | 条件 | 分组 | 组标签 |
|---|---|---|---|
| 1 | `voided_at` 非空 | `voided` | 已作废 |
| 2 | `deferred_at` 非空 | `deferred` | 稍后 |
| 3 | `accepted` 归一后 = 1 | `approval` | 待审批 |
| 4 | `accepted` 归一后 = 0 | `revision` | 驳回待修订 |
| 5 | 其余（`accepted` 为 NULL） | `pending` | 待人工选择 |

`accepted` 归一：SQLite 给 `1|0|null`，JSON 可能给 `true|false`；`1`/`true` → 1，`0`/`false` → 0，其余 → NULL。**「归一后是 NULL」与「读不出来」不是同一件事**：非 0/1/布尔的值按 NULL 处理并在行上标 `acceptedRaw`，读者能看见原值。

**读回对账**：四条状态路由在写完那两列之后**重新 SELECT 该行**，把原始列喂回 `draftInboxGroup`，再与「按内容它应当是什么」比对（set 动作用它声明的目标，clear 动作用**写之前**那一行把该列置空后重算的结果 —— 两边是两条不同的路，不是同一个表达式算两遍）。不一致就拒绝这次回报（`INBOX_STATE_MISMATCH`），**不谎报成功**。这条对账是本批的强制项，不是可选的自检，`tests/b13b-inbox-evidence.mjs` 用「把 `store.run` 换成空操作」来证伪它。

### 3.2 六个列

| 列 | 字段 | 来源（全部服务端算好） |
|---|---|---|
| 对象 | `asin` | 所属 run |
| 站点 | `marketplace` | 所属 run |
| 生成时间 | `generatedAt` | `run.started_at`（`generatedAtSource='run.started_at'`；草案本身无生成时间列，`schema.js:1728` 已把这个口径写死） |
| 阻断警告数 | `blocked` / `warnings` | `violations_json` 按 `severity` 计数（唯一实现在 `inbox.js#countViolations`，`run-view.js` 改为调它） |
| 待确认项 | `confirmations[]` | 见下 |
| 审批状态 | `approvalState` / `approvalLabel` | `approvalPolicy(store).acceptDraft`（`domain/approval/policy.js:148`）经 `requireApproval` 的判词，只有两个取值：`required`（需二次确认）/ `off`（免确认） |

`confirmations` 是**具名理由**的数组，不是计数：
- `field-fact` — `needsConfirmation(field)`（`domain/rules/listing-fields.js:274`）为真：这一项是事实不是文案。
- `context-mismatch` — `draftContextState(draft, currentContextId) !== 'ok'`（`domain/optimize/context.js:43`）：上下文变了或从没记过，**提交会被 `amzn_optimize_save` 拒**。

### 3.3 `context_id` 筛选

- 页面的筛选袋新增 `draftContext`，取值 `current` | `changed` | `orphan`（空 = 不限）。
  - `current`：`draftContextState === 'ok'`
  - `changed`：`=== 'context_changed'`
  - `orphan`：`=== 'unknown'`（与既有的 `draftStatus=orphan` 是**同一条判据的两种拼法**，见 §3.4）
- **从 01 待办进入时**：`page.js#followTodo` 在链接名到 `#optimize#inbox` 且筛选袋里带 `draftStatus` 时补上 `draftContext: 'current'`，并在筛选条上**明写**「只看当前上下文（<context_id>）」+ 一个「看全部」按钮。补这一下的理由是模块 01 的行只带 `draftStatus`（`todos.js:213`，非本批写作用域），而「待办说有 N 条等着决定」问的是**当前上下文**里的 N 条。
- 服务端 `optimizationState` 把 `workbench.get().contextId` 放进 `inbox.currentContextId`；`contextId` 为空（没有工作台）时 `current` 筛选**匹配不到任何行**，并回报 `inbox.contextFilterDegraded = 'no-current-context'` —— 空列表必须说得出为什么空。

### 3.4 筛选值 → 判据（一份实现）

`inbox.js#inboxFilterFrom(filters)` 把筛选袋解析成 `{ group, context }`，`inbox.js#inboxMatches(row, filter)` 是**唯一的谓词**。别名只有一条：`draftStatus='orphan'` 解析成 `{ group: null, context: 'orphan' }`（B13b 之前保存下来的链接带着它，`page.js:3901`）。

不认识的 `draftStatus` → `{ group: null, context: null }` = 显示全部（既有规则，`s1b13-recent.mjs:601-610` 有断言）。

**`buckets` 由谓词派生，不是另写一份**：`draftInboxBuckets(row)` 遍历 `INBOX_FILTER_IDS`，对每个 id 造一个描述符再问 `inboxMatches`。页面拿到的是算好的 `buckets`，只做 `buckets.includes(id)` 的成员测试 —— **页面里没有第二份判据可以自己算**。这也是「把域层改坏 → 工具侧与页面侧两条断言必须同时变红」的机制：页面没有第二条路。

⚠️ 组 id 与上下文 id 是**两个词表**，所以 `draftInboxBuckets` 里有一个 `filterDescriptorFor(id)` 负责说清哪个是哪个。用 `inboxFilterFrom({ draftStatus: 'current' })` 去造描述符是错的 —— `current` 不是任何人定义过的 `draftStatus`，那条路会返回「匹配一切」。（这条是实测踩出来的，不是设想。）

### 3.5 工具 `amzn_optimize_inbox`（只读）

**入参**

| 名字 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `runId` | string | 否 | 只看这一轮 |
| `asin` | string | 否 | 按对象收窄 |
| `marketplace` | string | 否 | 按站点收窄 |
| `group` | string(enum) | 否 | 五组之一；不给 = 全部 |
| `context` | string(enum) | 否 | `current` / `changed` / `orphan` |
| `contextId` | string | 否 | `context=current` 时要对齐的上下文 id；不给 = 读工作台当前上下文，读不到则降级并明说 |
| `limit` | integer | 否 | 默认 50，上限 200 |

**出参**（`ok: true` 时）

```
{
  ok: true,
  filters: { runId, asin, marketplace, group, context, limit },
  groups: [ { id, label, short, why, count } ],   // 五组，count 不受 group/context 收窄影响
  counts: { total, shown, byGroup: {pending, approval, revision, deferred, voided} },
  context: { currentId, available, state, matched, changed, unknown },
  rows: [ {
    id?, runId, field, label,
    group, groupLabel, accepted, acceptedRaw,
    asin, marketplace, generatedAt, generatedAtSource, updatedAt,
    blocked, warnings, confirmations: [ {code, text} ],
    approvalState, approvalLabel,
    contextId, contextState, buckets: [...],
    voidedAt, deferredAt, fieldNeedsConfirmation,
    before, after, rationale, violations
  } ],
  empty: { kind: 'no-drafts'|'no-match'|'no-current-context'|'no-run', text }
}
```

`context.state` 取值：`ok`（有当前上下文）/ `no-current-context`（筛了 `current` 而没有上下文）。

**空态四句必须不同**：库里一条草案都没有（`no-drafts`）/ 有草案但筛选后为空（`no-match`，带上未筛选的总数）/ 筛了当前上下文而没有当前上下文（`no-current-context`）/ 指定的 run 不存在（`no-run`）。

### 3.6 页面写路由：**五个动作五条路由**

| 路由 | `ACTIONS` | 对象类型 |
|---|---|---|
| `optimize-draft-void` | `optimization_draft.void` | `optimization_draft` |
| `optimize-draft-restore` | `optimization_draft.restore` | `optimization_draft` |
| `optimize-draft-defer` | `optimization_draft.defer` | `optimization_draft` |
| `optimize-draft-resume` | `optimization_draft.resume` | `optimization_draft` |
| `optimize-draft-reoptimize` | `optimization_run.reoptimize` | `optimization_run` |

**为什么不是一条 `optimize-inbox`**：合成一条会让审计回答不了「这次是作废还是恢复」—— 而那正是要查的。与 `snapshot-delete` / `snapshot-restore` 同一条口径。

**为什么四条状态路由要逐条写开、不走一张 `{ route: action }` 表**：s1b12 的守卫按 `route === '...' && req.method === 'POST'` 的**字面形态**扫路由名，表驱动会让这四条在审计里根本不存在。守卫当场就会红 —— 这条也是实测踩出来的。

**入参**

| 名字 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `runId` | string | 是 | 目标轮次 |
| `field` | string | 四条状态路由必填 | 目标字段 |
| `reason` | string | 否 | 写进审计的 `reason` |

**动作语义**

| 动作 | 写什么 | 幂等与拒绝 |
|---|---|---|
| `void` | `voided_at = now` | 已作废 → `unchanged: true`，不写；轮次已收尾 → 拒 |
| `restore` | `voided_at = NULL` | 本来就没作废 → `unchanged: true`；轮次已收尾 → 拒 |
| `defer` | `deferred_at = now`，并把 `accepted` 归 NULL | 已押后 → `unchanged: true`；轮次已收尾 → 拒 |
| `resume` | `deferred_at = NULL`（**不**恢复被清掉的决定） | 本来就没押后 → `unchanged: true`；轮次已收尾 → 拒 |
| `reoptimize` | **新建一轮** `optimization_run`（`status='running'`），包从父轮 `package_json` 原样继承，另加 `derivedFrom` 与 `derivedFromDraft`；建完立刻冻结新轮的证据包 | 父轮不存在 / `field` 不在父轮里 → 拒 |

**幂等的判据是「这一列本来是不是空的」，不是「它等不等于一个新的时刻戳」**：拿新戳去比永远不等，于是每一次重复调用都会被报成「变了」—— 而「做了一次没改变任何东西的调用」与「状态变了」是两件不同的事。（实测踩出来的。）

**「继续审阅」不是写路由**：它只把页面的筛选袋设成 `{ anchor: 'inbox', focusField: <field> }` 并滚到那张字段卡（`patchContext`，不落库、不进审计）。

**为什么 `reoptimize` 只建轮次不生成文案**：本插件不生成文案（`src/tools/optimize.js:9-15` 的模块头）。新轮次把父轮冻结的数据包原样带过去，页面明说「新轮次已建（未生成文案）：回到会话里让 agent 按它的数据包写」。这是「基于此草案重新优化」在**本仓架构下**唯一诚实的落点。

### 3.7 错误码（F13-01）

| code | 触发 | HTTP |
|---|---|---|
| `INBOX_UNKNOWN_ACTION` | `action` 不在四个状态动作里（`reoptimize` 走自己的路由） | 400 |
| `INBOX_DRAFT_NOT_FOUND` | 轮次不存在，或 `(runId, field)` 没有这一行 | 400 |
| `INBOX_RUN_FINALISED` | 轮次已收尾（`report_md` 非空或 `status !== 'running'`），状态不再可改 | 400 |
| `INBOX_STATE_MISMATCH` | 写完读回重算的分组与「按内容应当是什么」不一致（§3.1 的对账） | 400 |
| `INBOX_REOPTIMIZE_NO_PARENT` | 父轮不存在 | 400 |
| `INBOX_REOPTIMIZE_NO_DRAFT` | `field` 不在父轮里 | 400 |

---

## 4. F13-03 证据包 · 接口

### 4.1 十类，一类一行

唯一实现在 `src/domain/optimize/evidence.js`：

```js
EVIDENCE_KINDS: [ { id, label, appliesTo } × 10 ]
collectEvidence(store, { run, drafts }) -> [ { kind, label, status, source, at, fields, count, payload, note } × 10 ]
freezeEvidence(store, runId, entries)   -> { ok, written, unchanged, frozenAt }
readEvidence(store, runId)              -> { ok, runId, rows, counts, frozenAt }
```

十类的 `id`（**顺序即证据包的目录顺序**）：

`current_copy` 当前文案 ｜ `keywords_plan` 关键词包与位置计划 ｜ `rules` 规则快照 ｜ `prompts` Prompt 快照 ｜ `listing_history` listing 历史 ｜ `review_topics` 评论主题样本 ｜ `qa` QA ｜ `competitor_opportunities` 竞品机会 ｜ `product_line_brand` 产品线事实与品牌语气 ｜ `quality_gaps` 质量缺失项

### 4.2 三要素（每条都有，缺一不可）

| 要素 | 字段 | 缺了怎么说 |
|---|---|---|
| 来源 | `source` | `not_modelled` 时写 `'（本仓没有这一类证据的来源）'`；`absent` 时写清**表名**，表示「来源在，这次没有行」 |
| 时间 | `source_at` | `NULL` 渲染成「无日期」；**绝不填今天**（`schema.js:1723` 的既有纪律） |
| 适用字段 | `fields_json` | `'[]'` = 适用整轮；空数组是「整轮」不是「没有字段」 |

### 4.3 三种 status（「没有数据」与「数据是 0」分开，而「没有建模」是第三种）

| status | 含义 | 页面 / 工具怎么说 |
|---|---|---|
| `frozen` | 这一类有证据。`count` **一定是数字，可以是 0** | 正常显示来源 / 时间 / 适用字段 / 条数 |
| `absent` | **这一类在这个对象上不存在可冻结的东西** —— 对象本身缺（没有 listing、没有竞品组、没有产品线归属），或这一轮没有输入（包里没有关键词）。`count` 是 `null` | 「这一类没有：<来源> 里没有 <对象> 的行（不是 0 条，是没有）」 |
| `not_modelled` | 本仓**没有这一类的来源** | 「本仓没有这一类证据的来源 —— 不是「这次没有」，是「本仓没有」」 |

**机器可检查的形式**（测试逐类断言）：

- `not_modelled` ⇒ `source === null && at === null && count === null && fields.length === 0`，且 `note` 非空；
- `absent` ⇒ `count === null`（「没有这种东西」不许变成数字）；
- `frozen` ⇒ `typeof count === 'number'` 且 `source` 非空。

所以「读过了、答案是 0」（`frozen` + `count: 0`）与「没有可读的东西」（`absent`）在**列上就分得开**，不靠读的人去分辨。

### 4.4 逐类的 `status` 判据（本批实测）

| kind | 来源存在？ | `absent` 的条件 | `frozen` + `count: 0` 是什么意思 |
|---|---|---|---|
| `current_copy` | 是 | listing 与 asin_snapshot 里都没有文案 | —（有文案时 count ≥ 1） |
| `keywords_plan` | 是 | 这一轮的包里没有关键词 | —（有关键词时 count ≥ 1） |
| `rules` | 是 | 规则集与代码种子都没有规则 | — |
| `prompts` | 是 | 包里没有任何组装提示词 | — |
| `listing_history` | 是 | **当前版也不存在**（谈不上「历史」） | 有当前版，但快照登记表里一版都没登记 |
| `review_topics` | **否** | —（恒 `not_modelled`） | — |
| `qa` | **否** | —（恒 `not_modelled`） | — |
| `competitor_opportunities` | 是 | 这个站点没有定义任何竞品组（没有可比的对象） | 有竞品组，但自有缺席 0 个词（0 是发现） |
| `product_line_brand` | 是 | 既没有产品线归属，品牌名也没落在品牌表里 | — |
| `quality_gaps` | 是 | **对象本身不在库里**（asin 表没有这一行） | 读过了：dq_issue 里这个对象一条记录都没有 |

### 4.5 冻结与冻结后拒写

- **冻结点（prepare）**：`amzn_optimize_prepare` 建完 run 之后立刻冻结十类。§33 要求「优化运行固定使用当时判定结果」，证据包与九项判定同批冻结。
- **冻结点（save）**：`amzn_optimize_save` 在**收尾写完之后**再核对一次。位置是有讲究的 —— 「补冻」这个判断必须**从内容算得出来**：`readEvidence` 拿 `frozen_at` 与 run 的 `finished_at` 比，冻结晚于收尾就是补冻。放在收尾之前，这两个时刻的先后永远说不清，那个布尔值就只能靠一个自报的标记。
  - 还没有行（本批之前建的轮次）→ 补冻，`note` 写明是补冻；
  - 已经冻过且内容一致 → 幂等，一行都不写；
  - 已经冻过但内容**变了** → `{ ok: false, code: 'EVIDENCE_FROZEN', kinds: [...] }`，**一行都不写**（先全比后写，不留半冻状态）。
- **拒写不阻断收尾**：save 与证据包是两件事。漂移时 save 照常出报告，但输出里点名 `EVIDENCE_FROZEN` 与漂移的类目，并说明**已冻结的那一份保持原样** —— 报告引用的就是它，覆盖会让报告与它引用的证据对不上，而没有任何东西会重新渲染那份报告。
- **只读**：`readEvidence` 只有 SELECT；页面的证据包区块只读 `data.evidence`，不自己算。

### 4.6 工具 `amzn_optimize_evidence`（只读）

**入参**：`runId`（必填）、`kind`（否，十类之一）、`includePayload`（否，默认 false —— 正文可能很大）。

**出参**

```
{
  ok: true,
  runId, asin, marketplace, status, rulesVersion,
  frozenAt, lateFreeze: boolean,
  counts: { kinds: 10, frozen: n, absent: n, notModelled: n, present: n, missing: n },
  missing: [kindId],                 // 十类里**没有行**的那几类（缺行 ≠ 「这一类没有」）
  rows: [ { kind, label, status, source, at, fields, count, note, frozenAt, createdAt, payload? } ],
  empty: { kind: 'no-evidence'|'unknown-kind', text }
}
```

### 4.7 错误码（F13-03）

| code | 触发 |
|---|---|
| `EVIDENCE_NO_RUN` | `runId` 不存在 |
| `EVIDENCE_UNKNOWN_KIND` | `kind` 不在十类里（报出十类的 id） |
| `EVIDENCE_FROZEN` | 重冻内容与已冻结的不同（§4.5） |

---

## 5. 关键数字

| 项 | 开工前（实测） | 本批后 |
|---|---|---|
| `SCHEMA_VERSION` | 39 | **40** |
| `TOOLS` | 113 | **115** |
| `optimization_evidence` 的类数 | — | **10** |
| 收件箱分组数 | 2（`pending` / `orphan`） | **5**（+ 3 个上下文筛选值） |
| 页面写路由数（optimize 区） | 0 | **5** |
| 每类证据的三要素 | 0 | **3**（source / at / fields） |
| `node tests/run.mjs` | 1527 passed / 0 failed | **1548 passed / 0 failed**（只增不改） |
| `node scripts/check-page.mjs` | 3/3 | **3/3** |

### 5.1 载荷契约变化（会打到既有夹具）

`data.optimizations` 多了两块：`inbox`（分组 / 上下文 / 计数 / 筛选后的行）与 `evidence`（十类），
并且 `data.optimizations.run.drafts[]` 每一行多了 `group` / `groupLabel` / `buckets` /
`contextState` / `blocked` / `warnings` / `confirmations` / `approvalLabel` / `generatedAt` /
`generatedAtSource` / `updatedAt` / `voidedAt` / `deferredAt` / `fieldNeedsConfirmation` /
`acceptedRaw`。

**页面不再自己推任何一条状态**，所以**手搓的载荷夹具必须跟着契约走**：
`tests/s1b13-recent.mjs` 里那份三行草案的夹具补上了这些字段（`buckets` 与它真实的列一致），
**该文件里的断言一字未改**。这是契约变更的正常代价，不是放宽断言。

---

## 6. 非目标（再次，防止被读成承诺）

见 §0.2。特别是：**不做字段级决策四选**、**不新建评论主题 / QA 数据源**、**不做调度器**、**不动 `src/domain/dashboard/todos.js`**、**不做真机采集**。

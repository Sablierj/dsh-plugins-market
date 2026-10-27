# F11-07 固定评估集 · 契约先行（WorkBuddy，2026-10-10）

> 权威定义：`docs/requirements/RESEARCH-module-alignment-v2.0.md` §3.11 的 `F11-07` 行。
> 这是任务书 §4（W-C）的第一件事：**契约先行**。实现之前先把入参/出参/错误码、
> 迁移与回滚、数字写死在这里。
>
> ⚠️ **编号说明**：任务书与 `PLAN-remaining-2026-10-10.md` 把 `F11-08` 叫「引用追踪」，
> **那是错的**。权威文档 §3.11 写着：`F11-08` = **双版本对比评估**（九维评分），
> `F11-09` = 引用追踪。引用追踪已作为 **F11-09** 交付（`wb-f1109`）。本批做的是
> 真正的 `F11-07` = **固定评估集**。

## 0. 为什么先做这一条（不是 F11-08）

| | F11-07 固定评估集 | F11-08 双版本对比评估 |
|---|---|---|
| 需要 LLM 通道？ | **不需要** | **需要**（九维评分是模型打的） |
| 数据来源齐备？ | **齐备**（样例与期望行为是**人写的**） | **缺 2/9 维**（人工采纳率、成本在 `publication_record`/`observation_plan` 里**没有数据来源**） |
| 现在能做？ | ✅ | ❌ 做了就是把缺失渲染成真实值 |

**判据**：`F11-08` 要的「评分」没有产生者 —— 本插件**没有 LLM 调用**（模块 12 的整体结论
也写着「不含 LLM 调用」，`RESEARCH §3.12`）。假造一个 0 分正是本仓最忌讳的形状。
`F11-07` 不需要：**评估集的样例与「期望行为」都是人在设计文档里写下来的固定数据**，
不是测量值。所以本批能做，且做完是诚实的。

## 1. 缺陷形状：一句话承诺了不存在的能力

`src/tools/prompt.js:552` 现在写着：

```
lines.push('下一步: review → testing（在固定评估集上跑）→ active。')
```

**工具在指导用户去「在固定评估集上跑」，而全仓没有任何评估集。**
`grep -rn "eval_set\|评估集" src/ tests/` 的命中里没有一处是真的评估集实现。
这与 B-13 那批「工具说明比代码强」是同一个形状。

## 2. 权威文档要求的两类样例（这是内容的规格）

`RESEARCH §3.11` 的 `F11-07` 缺口栏逐条写明：

**A. 八类覆盖样例**（每类的期望行为是「指出问题或拒绝下结论」）：
1. 正常 ASIN　2. 数据缺失　3. 多源冲突　4. 高风险表述
5. 非英语站点　6. 超长字段　7. 竞品品牌词　8. 无足够证据

**B. 口径陷阱样例**：百倍混算、列错位、`*` 行、月季粒度

原型 `prototype/11-prompts.html:154` 的形态是「固定评估集 · v2.3 vs v2.4（同输入快照 EVAL-KW-12）」。

## 3. 数据模型（迁移 v39）

**新增一张表 + 两张只读视图所需的列**。设计原则：**样例是内容，运行结果是事实，两者分开存**。

```sql
-- 评估集：一个具名集合，带版本。版本是内容的一部分，所以一起进主键。
CREATE TABLE IF NOT EXISTS prompt_eval_set (
  id          TEXT NOT NULL,          -- 如 'EVAL-KW'
  version     TEXT NOT NULL,          -- 如 'v1'
  title       TEXT NOT NULL,
  /* 这个集合测的是哪一类。与 8 类覆盖样例对齐，但**不设 CHECK 闭集** ——
     将来加一类不该要一次迁移；反而「这个值还没注册」正是要在视图里点名的事。 */
  category    TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

-- 评估集里的一条样例。输入与期望行为都是**人写的固定数据**，不是测量值。
CREATE TABLE IF NOT EXISTS prompt_eval_case (
  id          TEXT NOT NULL,          -- 如 'EVAL-KW-12'
  set_id      TEXT NOT NULL,
  set_version TEXT NOT NULL,
  case_index  INTEGER NOT NULL,
  category    TEXT NOT NULL,
  /* 输入快照：原样存 JSON 文本。**不许从选择器或当前数据派生** ——
     本仓付过代价（任务书 §7）：夹具从被测对象派生，就永远不可能与被测对象不一致。 */
  input_json  TEXT NOT NULL,
  /* 期望行为：一句话说明「看到这个输入应当指出什么问题 / 拒绝下什么结论」。 */
  expected    TEXT NOT NULL,
  /* 期望**至少命中**的规则名（数组，JSON）。空数组 = 这条样例不检查规则命中。 */
  expect_rules_json TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (set_id, set_version) REFERENCES prompt_eval_set(id, version)
);
```

**为什么 `input_json` 存文本而不是建列**：不同类别的样例输入结构不同（一条可能是 ASIN 事实包，
另一条是关键词表的一个切片）。建列会把「某一类」当成通用形状。

**为什么不建「结果」表**：本批**不跑评估**（没有 LLM）。「期望行为」是**声明的**，
不是**跑出来的**。把「期望」和「结果」混在一张表里，就会让「还没跑过」读成「跑过了」。
**结果表留给将来真的有评估器的那一批**，那时它是新迁移。

## 4. 迁移 v39：内容从哪来

迁移**只建表，不插数据**。理由：评估集是**业务内容**（与提示词一样），
不该由 schema 迁移种下去 —— 种下去就会有两个来源（文档与代码里的常量），
而本仓刚为「两个常量活在不同文件」付过代价。

内容由一个新的**导入工具**写入（§5）。

**回滚**：本迁移是**纯新增**（只 `CREATE TABLE`），回滚 = 删两张表 + 从 `MIGRATIONS`
数组移除 v39 条目。不动任何既有表、不改任何既有列，因此**对既有数据零风险**。

## 5. 工具（新增 3 个，`amzn_` 前缀，不触发命名守卫）

> 命名守卫（`tests/m14-observation.mjs:814`）：`amzn_` 后含 `publish|apply|push|deploy` 被拒。
> 三个名字都不含这些词。

### 5.1 `amzn_prompt_eval_import`（写）
**入参**：`{ setId, version, title, category, note?, cases: [{ caseId, category, input, expected, expectRules? }] }`
**出参**：`{ ok: true, id, version, imported, text }`；重复导入同一 `(setId, version)` → 覆盖该集合的样例（先删后插，**同一事务**）。
**错误码**：`{ ok: false, error, hint }` —— 空 `cases`、缺 `expected`、`caseId` 重复、`setId/version` 为空。
> ⚠️ 失败**必须**返回 `{ok:false}`，不能只回一句话：审计漏斗（`src/tools/index.js:428`）与
> 工具遥测（同文件 `:400`）**两个**消费者都靠 `value?.ok === false` 判断「这次写没发生」。

### 5.2 `amzn_prompt_eval_list`（读）
**入参**：`{ setId?, version? }`　**出参**：集合清单 + 每个集合的样例数与类别分布。
**只读** → `WRITE_TARGETS` 记 `null`。

### 5.3 `amzn_prompt_eval_show`（读）
**入参**：`{ setId, version? }`（`version` 缺省取该集合**最新**版本）
**出参**：该集合的全部样例（含 `input` 与 `expected`）。
**五态必须分开说**：集合不存在 → `ok:false`（不是空数组）；集合存在但没有样例 → `ok:true` 且
`cases: []` 并**显式**带 `isEmpty: true`。**「没有这个集合」与「这个集合是空的」不是一回事。**
**只读** → `WRITE_TARGETS` 记 `null`。

## 6. 页面（提示词区的评估集一块）

在提示词面板加一块「固定评估集」：列出集合与样例数；点开看某集合的样例（输入摘要 + 期望行为）。
**复用服务端下发的数据，页面不自己算**（与 §14 指标、F12-05 判词同一条单源规矩）。
**空集合**渲染成「这个集合还没有样例」，**不渲染成「0 个问题」**。

## 7. 数字（写死在这里，实现后必须一致）

| 项 | 值 |
|---|---|
| 新迁移 | **v39**（`MIGRATIONS.length` 38 → 39，`SCHEMA_VERSION` → 39） |
| 新工具 | **+3**（TOOLS 109 → 112） |
| `page.js` 反引号预算 | **44 → 44**（不许增加） |
| 新测试文件 | `tests/b11-7-eval-set.mjs` |
| 新增断言 | **≥18 条**（断言只增不减） |
| 覆盖样例 | **12 条** = 8 类覆盖 + 4 条口径陷阱（百倍混算 / 列错位 / `*` 行 / 月季粒度） |

> ⚠️ 断言**不钉绝对数字**：钉的是不变量（`MIGRATIONS.length === SCHEMA_VERSION`、
> 版本号无重复且严格升序、每类样例至少一条、期望行为非空）。

## 8. 本批不做（不假装满足）

- **不跑评估**：没有 LLM 通道，无法自动判定「这条样例通过/不通过」。
  本批交付的是**评估集本身 + 能读它**，以及**把那句空承诺改成有落点的文案**。
- **不做 F11-08 双版本对比评估**：九维评分需要模型；其中两维（人工采纳率、成本）
  连数据来源都没有（`publication_record`/`observation_plan` 无 prompt 引用）。
- **不自动把评估结果关联到生命周期**：`testing → active` 的人工决定不由本批自动化。

## 9. 验收自我检查（任务书 §4 五条，逐条对标）

1. **契约先行** ✅ 本文件。
2. **全量绿且断言只增不减** → 跑 `node tests/run.mjs`，报实测数字 + EXIT，断言数只增。
3. **五态/缺失必须分开说** → §5.3 的 `isEmpty` 与「集合不存在」分开；页面不为空集合画 0。
4. **至少一次真证伪** → 回退某处（如 `isEmpty` 判定）→ 变红 → 改回，贴原文。
5. **夹具不许从选择器派生** → 本批样例是**人写的固定 JSON**，不从任何页面/选择器派生。

---

## 10. 交付实测（2026-10-10，本批收尾时补记）

### 10.1 契约第 §7 节数字的实测对账

| 项 | 契约写 | 实测 | 一致 |
|---|---|---|---|
| 新迁移 | v39 | `MIGRATIONS.length` 39、`SCHEMA_VERSION` 39、`PRAGMA user_version` 39 | ✅ |
| 新工具 | +3（109 → 112） | 注册面 **112**（探针实测） | ✅ |
| `page.js` 反引号 | 44 → 44 | **44** | ✅ |
| 新测试文件 | `tests/b11-7-eval-set.mjs` | 已建 | ✅ |
| 新增断言 | ≥18 | **261**（独立驱动实测） | ✅ |
| 覆盖样例 | 12 条 = 8 + 4 | 12 条，`caseIndex` 恰好 1..12 | ✅ |

### 10.2 五处落点（逐条对照契约 §3–§6）

1. **迁移 v39**（`src/store/schema.js`）：`prompt_eval_set`（PK `(id, version)`）+
   `prompt_eval_case`（PK `id`，`UNIQUE (set_id, set_version, case_index)`，
   复合外键指向集合版本）+ 两个索引。**不塞种子数据**（迁移是结构，样例是内容）。
2. **store 层**（`src/store/prompt.js`，+197 行）：`importEvalSet` / `getEvalSet` /
   `listEvalCases` / `listEvalSets` + 三个私有辅助。
3. **工具层**（`src/tools/prompt.js`）：`amzn_prompt_eval_import` / `_list` / `_show`
   三个，**没有第四个**（没有「跑评估」）。
4. **审计**（`src/domain/audit/targets.js` + `src/domain/states.js`）：
   `ACTIONS.promptEvalImport = 'prompt.eval_import'`；`prompt_eval_set` 进
   `AUDIT_OBJECT_TYPES`；两个读工具 `WRITE_TARGETS` 为 `null`。
5. **页面**（`src/web/page.js` + `src/web/routes.js`）：`#promptEval` 容器 +
   `renderPromptEval()` + `promptEditor.evalSets` 下发。**只读**（那一块没有 button）。

### 10.3 如实记录的三个「差点漏掉」

1. **`AUDIT_OBJECT_TYPES` 缺项（写本批时自己引入、又自己抓到）**：
   新写路径 + 新 `objectType` 是本仓反复出现的形状 —— `recordAudit` 对白名单外的
   objectType 抛错，`instrument` 把错吞成一条 `audit:error`，**工具照常工作、审计一行
   都没有**。本批的探针在提交前抓到（`audit 行数: 1 -> 1`），补进词表后 `1 -> 2`。
   这是本仓第六次遇到同一形状；前五次在模块 12 / 14 / 08 / 04 / 05。
2. **`UNIQUE (set_id, set_version, case_index)` 比断言先挡住追加缺陷**：证伪②第一次
   注入时抛出 `UNIQUE constraint failed` 而不是一条具名断言失败。这是**结构比断言强**
   的例子，但为了让断言本身可证伪，改用「保住旧样例 + 新样例 index 后移」的注入法，
   拿到具名失败（`期望 1 / 实际 4`）。
3. **`cov-normal-asin` 的期望**不含「指出/拒绝」—— 因为 §7.2 的第一类就是「正常 ASIN」，
   它的期望恰恰是「正常输出且**不加**宣称」。最初的断言把 12 条一律要求含
   「指出/拒绝」，会让这套评估集自相矛盾。已改成：这一条要求含「不新增/不得」，
   其余 11 条要求含「指出/拒绝/说明/不得」。

### 10.4 三次真证伪（回退 → 变红 → 改回，贴原文）

**证伪①：把「没有这一套」折叠成「这一套是空的」（`listEvalCases` 的 `?? []` 形状）**

注入（`src/store/prompt.js`）：
```js
-  if (targetId === '') return null
+  if (targetId === '') return []
-  if (set === null) return null
+  if (set === null) return []
```
结果：**258 通过 / 1 失败**
```
✗ ② 不存在的集合的样例 → null
    期望: null
    实际: []
```
改回后：**261 通过 / 0 失败**。

**证伪②：导入变成追加而不是整份替换**

注入（`src/store/prompt.js`，把 `DELETE` 那行换成「把新样例的 case_index 往后推」）：
```js
-    store.run('DELETE FROM prompt_eval_case WHERE set_id = ? AND set_version = ?', [targetId, targetVersion])
+    const __bump = store.get('SELECT COALESCE(MAX(case_index), 0) AS m FROM prompt_eval_case WHERE set_id = ? AND set_version = ?', [targetId, targetVersion]).m
+    for (const e of prepared) e.index = e.index + __bump
```
结果：**247 通过 / 14 失败**，核心是：
```
✗ ⑥ 库里**变成** 1 条（不是 3+1）
    期望: 1
    实际: 4
✗ ⑥ 剩下的是新那条
    期望: "z"
    实际: "a"
```
（附带：这次注入还让审计两半一起变红，因为追加路径破坏了事务 —— 那是缺陷的连带后果，
不是断言的假阳性。）

改回后：**261 通过 / 0 失败**（`md5 b78320d9df8fb588e0e24b028eae866e`）。

**证伪③：把 `prompt_eval_set` 从 `AUDIT_OBJECT_TYPES` 拿掉（本仓栽过五次的形状）**

注入（`src/domain/states.js`）：删掉 `'prompt_eval_set',` 一行。
结果：**250 通过 / 11 失败**，核心是：
```
✗ ⑩ 成功的导入落**一**行（对照）
    期望: 1
    实际: 0
✗ ⑩ 成功导入后审计表里确实有一行
✗ ⑩ 审计的 action
    期望: "prompt.eval_import"
    实际: undefined
```
**这就是那五次事故的形状**：工具照常返回成功、库里真的写了、审计一行都没有。
本批的断言 ⑩ 被证明是**承重的**（去掉它就抓不到这条）。

改回后：**261 通过 / 0 失败**（`md5 00cf9dacbdbbe10d84e05f9b0fecda95`）。

### 10.5 独立驱动口径

测试文件是 `tests/run.mjs` 注册的套件（`runB117EvalSetTests`），驱动脚本在 10 秒内
跑完 261 条断言，用于快速迭代与三次证伪 —— 每次证伪都在这个口径下取的数。
全量口径的数字见 `docs/COORDINATION.md` 的交接条。

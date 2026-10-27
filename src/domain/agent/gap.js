/**
 * 模块 12 —— F12-02 / F12-03 / F12-06 / F12-09 **仍然没有来源**的要素的如实登记。
 *
 * ## 这份清单从九条缩到三条 —— 每一次缩小都指向一个真的落地了的来源
 *
 * - **B-12.5 立表时九项全缺**（那一批明确不建表加列）。
 * - **F12-02 划掉 3 条**：`role-allowed-data`（→ 角色声明的 `reads`）、
 *   `role-failure-fallback`（→ `onFailure`）、`role-state-version`（→ `agent_role_config` 表
 *   + `agent_run.role_config_version`）。
 * - **F12-03 再划掉 3 条**：`human-constraint`（→ `agent_run.human_constraint` + `startRun` 的参数）、
 *   `output-format`（→ `agent_run.output_format` + 参数；⚠️ 它是**约定不是校验**）、
 *   `role-scope-and-cost-cap`（**合进了 `cost-cap`** —— 见下）。
 * - **剩 3 条**，各有各的「够不着」的理由（见每条的 `missing`）。
 *
 * ## 为什么把 `role-scope-and-cost-cap` 并进 `cost-cap`，而不是留两条
 *
 * F12-02 之后那一条已经只剩「成本那一半」（范围那一半由 `scope` 补上了）。而 `cost-cap`
 * 说的**就是**同一个洞。两条同义条目正是本仓反复付代价的「同一件事的第二个名字」
 * （`snapshot.js` 的 `context_package` 那段注释专门为这件事立过判据）。所以**合并成一条**：
 * 保留下来的那条 `requirement` 同时写 F12-02 与 F12-03，`missing` 里逐字说明
 * 「范围那一半已有来源、只剩成本」。合并**不是**丢信息：F12-02 的范围半边的来源写在
 * `missing` 里，成本半边的洞仍然被登记。
 *
 * ## 纪律：**不许给任何一条编数字**
 *
 * 每一条回答的是「**缺哪份记录**」，不是「值是多少」。成本那条尤其 —— 模块 12 **不调 LLM**，
 * 全仓**无任何 token / 费用记录**，所以它必须写成「**没有这个来源**」，**不是**「上限是 0」。
 * `0` 是一个值，「没有」是一个洞；把洞写成 0，就是本仓最贵的那个缺陷形状：
 * **把缺失渲染成真实值**。F12-02 / F12-03 都没有为成本建任何列。
 *
 * ## 它是常量，不是查询
 *
 * 每条都是**声明**（跟着代码走），所以这里导出一个结构化常量，不碰库、不写审计。
 * 谁把它渲染到哪一屏由调用方决定（当前挂在 `roleView()` 的 `gaps` 上，随工作台的 agent
 * 页签 state 一起下发 —— 见 `tools/agent.js`）。
 */

/**
 * 仍然没有来源的**三条**。顺序与原始九项里它们出现的顺序一致，便于逐条对账。
 *
 * `source` 里的行号是写这份清单时实测的；`missing` 不写行号，因为「缺的东西」
 * 本来就没有一行可以指。
 */
export const AGENT_GAP_ELEMENTS = [
  {
    id: 'role-default-prompt-set',
    requirement: 'F12-02',
    label: '默认提示词集（精确绑定）',
    evidenceOfNeed: '角色要绑定一套默认提示词，否则每次运行都得调用方自己挑。',
    missing: '「角色 → 提示词**集**」的精确绑定：F12-02 给角色加了 `promptModule`（指向一个**模块**），'
      + '但那是**按模块的近似**，不是「这个角色的那套」—— `prompt_set` 一个模块下可以有几套集合，'
      + '而角色声明的是**模块**不是**集合 id**。要精确绑定，需要一条「角色 → 集合」的关联列（那是另一次迁移）。',
    source: '近似的那一半**有了**：`roles.js` 的 `promptModule`（如数据管家 → `kw`）随配置版本承载；'
      + '`prompt_set.module` 能按模块取到那**一组**（`src/store/agent.js` 的 `promptSnapshot` 会读它的 id/module/version）。',
  },
  {
    id: 'quality-summary',
    requirement: 'F12-03',
    label: '质量摘要（产出与可信判定）',
    evidenceOfNeed: '运行产出要能给一份**质量摘要**，供人快速判断这次结果可不可信。',
    missing: '「谁来产出、凭什么算可信」：F12-03 把 `quality-summary` 登记成了**被命名的约定产物类型**'
      + '（`domain/agent/artifact-types.js` 的 `QUALITY_SUMMARY_TYPE`），视图也能**按类型取** —— 读者从此'
      + '找得到它。但**产出它**是会话侧的分析（本插件**没有 LLM 通道**），插件也**没有**任何产物内容校验器，'
      + '所以「一份质量摘要合格不合格」没有任何东西能判定。缺的是那两个：**产出方**与**判定方**。',
    source: '那**一半**有了：类型常量 + 视图按类型取（`artifact-types.js` / `agentArtifactConventions()`），'
      + '页面据此画「这次有没有质量摘要」。⚠️ 有名字 ≠ 会被产出：插件**不强制**任何运行产出它。',
  },
  {
    id: 'cost-cap',
    requirement: 'F12-02 / F12-03',
    label: '成本上限',
    evidenceOfNeed: '一次运行要能声明它的范围**与**成本上限，读者才知道它被允许花多少。'
      + '（F12-02 的那条 `role-scope-and-cost-cap` 已并进本条目 —— 见文件头。）',
    missing: '**成本那一半没有来源**：模块 12 不调 LLM，`agent_run` **没有** token / 费用列，'
      + '插件也**不调用任何计费的模型接口** —— **没有数字可加**。⚠️ 这不是「上限是 0」，'
      + '也不是「上限没设」，是**没有这个来源**。'
      + '（**范围那一半已有来源**：运行级的 `scope`，F12-02 起冻结进 `agent_run.scope_json`。）',
    source: '范围有（`src/tools/agent.js` 的 `scope` 参数 + `agent_run.scope_json`）；'
      + '成本无 —— `metrics.js:102` 的 `cost_per_run` 同一条登记。',
  },
]

/** 清单里「仍然没有来源」的要素条数 —— 恰好是上面这份列表的长度。 */
export const AGENT_GAP_COUNT = AGENT_GAP_ELEMENTS.length

/**
 * 这份清单的一句话结论，供页面 / 工具直接渲染，不让调用方自己数。
 *
 * ⚠️ 措辞如实说出**它是一份剩下多少的清单**：从九条起，F12-02 与 F12-03 各划掉几条，
 * 现在还剩几条。一个只写「N 项都缺」的说法会漏掉划掉的那些，读者就无从知道这份清单
 * **为什么越变越短**。
 */
export const AGENT_GAP_SUMMARY = `F12-02 / F12-03 / F12-06 / F12-09 共九项要素，`
  + `F12-02（角色配置版本化）与 F12-03（上下文包）已经补上了其中六项的来源，`
  + `**仍有 ${AGENT_GAP_COUNT} 项没有来源**（下表的每一行）。清单**只减不增**：`
  + '补上来源的条目必须从这张表里划掉，不许留在这里。'
  + '本插件不调 LLM，也不为成本建任何列；所以这里登记的是「缺哪份记录」，不是「值是多少」。'

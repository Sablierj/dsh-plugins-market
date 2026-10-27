/**
 * Agent 运行的留痕：运行、步骤、产物（模块 12 §17-2）。
 *
 * ## 结构照抄 kw_pipeline_run / kw_pipeline_stage
 *
 * 一次运行一行，每一步一行，`UNIQUE (run_id, seq)` 让「步骤不重复」由**结构**保证
 * 而不是靠写入方先查一次。§17-2 的原话是「复用 run+stage 双表模式，不另发明状态机」，
 * 所以这里的动词（`startRun` / `recordStep` / `setRunStatus`）与管道那边是同一套。
 *
 * ## 上下文包在开始时**拷贝**，不是引用
 *
 * §15-5 的验收是「运行中升级规则/Prompt 不改变该运行」。引用做不到：升级之后回读
 * 同一行会拿到新版本，那句验收就成了假的。所以 `rules_snapshot_json` 与
 * `prompts_snapshot_json` 存的是**当时的拷贝**，与 `optimization_run.rules_json`
 * 同一个做法（那里也是拷贝，理由一样）。
 *
 * 数据快照记的是「这次读的是哪一批」：kw_master 的最新更新时间 + 最新导入批次。
 * 它是**指纹**而不是数据本身 —— 把几千行词拷进运行表会让「运行」变成一份会过期
 * 的数据库副本，而它要回答的只是「当时看到的是哪一批」。
 *
 * ## 状态由 domain/agent/run.js 判定，这里只负责写
 *
 * 每个写入动词都先问一句状态机允不允许。放在这里而不是让调用方自己判断，理由与
 * 本仓其它守卫一致：调用方只保护它自己，这里是所有写入者都要过的门。
 */

import { randomUUID } from 'node:crypto'
import { nowIso } from './db.js'
import {
  AGENT_ARTIFACT_STATUSES, AGENT_RUN_STATUSES, AGENT_STEP_STATUSES, AGENT_TASK_TYPES,
  roleById, roleConfigOf,
} from '../domain/agent/roles.js'
import { canTransitionRun, isTerminal, blockedKindRefusal } from '../domain/agent/run.js'
import { latestRoleConfig } from './agent-config.js'
import { rosterForValidation } from './rules.js'

/** 一次运行的 id。可读前缀 + uuid，日志里能一眼认出是 Agent 运行。 */
function runId() {
  return `agent-${randomUUID()}`
}

/** The newest import batch, as a fingerprint: `null` when nothing was ever imported. */
function dataSnapshot(store) {
  const newest = store.get('SELECT id, imported_at, kind, marketplace FROM kw_import ORDER BY imported_at DESC LIMIT 1')
  const master = store.get('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM kw_master')
  return {
    /* 「这一批」是导入行，不是行数：同一个文件重复导入会得到不同的批次号，而行数
       可能一模一样 —— 用行数当指纹，两次不同的导入看起来会是同一次。 */
    importBatchId: newest?.id ?? null,
    importedAt: newest?.imported_at ?? null,
    importKind: newest?.kind ?? null,
    marketplace: newest?.marketplace ?? null,
    kwMasterRows: master?.n ?? 0,
    kwMasterUpdatedAt: master?.at ?? null,
  }
}

/** The prompt sets and their versions, as a fingerprint. */
function promptSnapshot(store) {
  const sets = store.all('SELECT id, module, version FROM prompt_set ORDER BY id')
  return { sets, count: sets.length }
}

/** The rule roster in effect right now — the same resolver every judge uses. */
function rulesSnapshot(store) {
  const roster = rosterForValidation(store, null)
  return { origin: roster.origin, version: roster.version, count: roster.rules.length, fromCode: roster.fromCode }
}

function parse(json, fallback) {
  if (json === null || json === undefined) return fallback
  try {
    return JSON.parse(json)
  } catch {
    return fallback
  }
}

/**
 * 一个可选的、调用方给的文本字段（F12-03 的 `humanConstraint` / `outputFormat`）。
 *
 * 三态，且**三态都要分得开**：
 *   - `null` / `undefined` → `null`（**没给**）；
 *   - 非空字符串 → **原样**存下（**不 trim**：静默改一个用户给的值，是另一种「把缺失
 *     渲染成真实值」—— 它把「他说的是这个」变成了「我认为他应该是这个」）；
 *   - 空串 / 只有空白 → **拒绝**，不折成 `null`。
 *
 * ⚠️ 为什么拒绝而不是折成 `null`：`''` 是一个**看起来像「给了」**的值。折成 `null` 之后
 * 「他没说」与「他说了一个空格」在库里长得一模一样，而这两种情况要做的下一件事不一样
 * （前者是「随他」，后者是「他填了个空的，去问一下」）。把前者渲染成后者、或反过来，
 * 都是本仓最忌的那类缺陷。
 */
function optionalText(value, field) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${field} must be a string, got ${typeof value}`)
  if (value.trim() === '') {
    throw new Error(`${field} must not be an empty string — omit it to mean "not given" instead of passing one`)
  }
  return value
}

/**
 * 一个可选的、指向**一次运行**的指针（F12-09 的 `supersedesRunId`）。
 *
 * 三态，与 `optionalText` 同一条规矩，只是多一道存在性检查：
 *   - `null` / `undefined` → `null`（**没有取代关系**，不是「取代了 0 号」）；
 *   - 空串 / 只有空白 → **拒绝**（它看起来像「给了」，却指不到任何东西）；
 *   - 其它 → 那次运行必须**真的存在**，返回它的 id。
 *
 * ⚠️ 为什么拒绝空串而不是折成 `null`：折了之后「他没说取代谁」与「他说了一个空格」
 * 在库里长得一样 —— 而前者是正常的一次新运行，后者是一个坏参数。与 `optionalText`
 * 同一条判据。
 *
 * ⚠️ 存在性检查在这里而不是在工具层：**每一个**开运行的调用方（工具、路由、测试）
 * 都要过这一关，把守卫留给调用方，就是只保护了它自己。
 */
function optionalRunRef(store, value, field) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${field} must be a string, got ${typeof value}`)
  const wanted = value.trim()
  if (wanted === '') {
    throw new Error(`${field} must not be an empty string — omit it to mean "not a supersede" instead of passing one`)
  }
  if (getRun(store, wanted) === null) {
    throw new Error(`no agent run ${wanted} to supersede — a pointer to a run that does not exist is not a provenance`)
  }
  return wanted
}

/**
 * 一个可选的、**封闭词表内**的任务类型（F12-04 / §5 的六类）。
 *
 *   - `null` / `undefined` → `null`（**未声明** —— 六类之外的第七个状态）；
 *   - 词表内的值 → 规范化（trim）后存下；
 *   - 其它（空串、词表外的名字）→ **拒绝**，不折成 `null`。
 *
 * ⚠️ 为什么拒绝空串而不是折成 `null`：与 `optionalText` 同一条判据 —— `''` 是一个
 * **看起来像「给了」**的值。折成 `null` 之后「他没说」与「他填了个空的」在库里长得
 * 一模一样，而这两件事要做的下一件事不一样。
 *
 * ⚠️ 为什么**不设默认值**：给一个默认类型 = 给缺失造一个像数据的替身（本仓铁律里
 * 最贵的那条）。老运行与不传 `type` 的新运行都留在 NULL，页面照实画「未声明」。
 *
 * ⚠️ 校验在这里而不是在工具层：**每一个**开运行的调用方（工具、路由、测试）都要过
 * 这一关 —— 把守卫留给调用方，就是只保护了它自己（与 `optionalRunRef` 同理）。
 */
function optionalTaskType(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`taskType must be a string, got ${typeof value}`)
  const wanted = value.trim()
  if (!AGENT_TASK_TYPES.includes(wanted)) {
    throw new Error(`unknown task type: ${value} — 允许的是 ${AGENT_TASK_TYPES.join(' / ')}（不传表示未声明）`)
  }
  return wanted
}

/** One run row, with its steps and artifacts. `null` when there is no such run. */
export function getRun(store, id) {
  const key = String(id ?? '').trim()
  if (key === '') return null
  const row = store.get('SELECT * FROM agent_run WHERE id = ?', [key])
  if (row === undefined || row === null) return null
  const steps = store.all('SELECT * FROM agent_step WHERE run_id = ? ORDER BY seq ASC', [key])
  const artifacts = store.all('SELECT * FROM agent_artifact WHERE run_id = ? ORDER BY created_at ASC, rowid ASC', [key])
  return {
    id: row.id,
    role: row.role,
    roleLabel: roleById(row.role)?.label ?? row.role,
    goal: row.goal,
    scope: parse(row.scope_json, {}),
    dataSnapshot: parse(row.data_snapshot_json, null),
    rulesSnapshot: parse(row.rules_snapshot_json, null),
    promptsSnapshot: parse(row.prompts_snapshot_json, null),
    /* F12-02：这次运行跑在**哪一版**角色定义上，以及那一版的内容（冻结的拷贝）。
       没有版本的行（v40 之前开的运行）是 `null` —— 那是「没记」，不是「第 0 版」。 */
    roleConfigVersion: row.role_config_version ?? null,
    roleConfig: parse(row.role_config_json, null),
    /* F12-03：调用方在开运行前加的两样，**开始时写、之后不改**。
       `null` = 「没给」（不是空串、不是空对象）—— 三种「没有」在这一层也要分得开。 */
    humanConstraint: row.human_constraint ?? null,
    outputFormat: row.output_format ?? null,
    /* F12-09：这次运行取代了哪一次（上下文变了就新建运行，不改旧的）。`null` = 不是取代
       关系（**不是**「取代了 0 号」）。 */
    supersedesRunId: row.supersedes_run_id ?? null,
    /* F12-04：§5 的六类任务类型。`null` = **未声明**（老运行、或调用方没传 type）。
       ⚠️ 这一层**不许**把 null 折算成任何一类 —— 「六类 + 未声明」是七个状态，
       折算会让页面永远画不出「未声明」（那是给缺失造一个像数据的替身）。 */
    taskType: row.task_type ?? null,
    status: row.status,
    waitingReason: row.waiting_reason,
    blockedReason: row.blocked_reason,
    /* F12-06：blocked 的**原因**（封闭词表，见 domain/agent/run.js 的 BLOCKED_KINDS）。
       ⚠️ `null` 有两种来源，页面必须分得开：① 这条运行**不是** blocked（这一格本来就没有
       值）；② 它是 v40 之前写的 blocked 行（那时还没有这一列）。两种都不该被渲染成一个
       具体的原因 —— 后者只能如实说「这条运行没记原因」。 */
    blockedKind: row.blocked_kind ?? null,
    trigger: row.trigger,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    steps: steps.map(step => ({
      id: step.id,
      seq: step.seq,
      step: step.step,
      status: step.status,
      input: parse(step.input_json, null),
      output: parse(step.output_json, null),
      error: step.error,
      /* F12-06：§9 的任务画布逐字要「每步负责 Agent」与「工具调用」两栏。`null` = 调用方
         没记（**不是**「等于运行的角色」—— 那会是给缺失造一个像数据的替身）。 */
      agentRole: step.agent_role ?? null,
      toolName: step.tool_name ?? null,
      /* F12-09：三态。`null` = 没记（这一步没有失败，所以「能不能重试」还没成为一个问题），
         `false` = 明确不可重试，`true` = 可重试。**`null` 与 `false` 不是一件事** ——
         `row.retryable === null` 走的是第一个分支，`0` 会落到 `=== 1` 为假。 */
      retryable: step.retryable === null || step.retryable === undefined ? null : step.retryable === 1,
      startedAt: step.started_at,
      finishedAt: step.finished_at,
    })),
    artifacts: artifacts.map(hydrateArtifact),
  }
}

/**
 * One `agent_artifact` row, hydrated: `body_json` parsed, columns renamed.
 *
 * ## Why this is a separate export rather than a `.map` callback inside `getRun`
 *
 * There are now **two** readers that turn a raw artifact row into the shape the
 * page and the tools consume: `getRun` (the artifacts of one run, ordered by
 * creation) and `listAllArtifacts` (a cross-run, filtered list). Before this
 * function existed both call sites spelled the same eight-field projection out,
 * and a column added to one of them would silently be missing from the other —
 * "一句话活在两个文件里", and this repository's最贵 variant of it, because
 * the drift is invisible: both shapes look complete until a reader asks for the
 * field that only one of them carries.
 *
 * ⚠️ It is **not** the deleted `listArtifacts` under a new name. That function
 * returned `getRun().artifacts ?? []` and queried nothing; this one maps **one
 * already-read row** and holds no `store` at all. See the prohibition note below
 * `decideArtifact` for why a run-scoped artifact reader must not exist.
 *
 * ⚠️ `body` uses `parse(..., null)`: a row with no body and a row whose body is
 * the JSON literal `null` are the same thing here (「没有正文」), which is what
 * both call sites want. `null` is deliberately **not** an empty object.
 */
export function hydrateArtifact(artifact) {
  return {
    id: artifact.id,
    /* ⚠️  在投影里，因为跨运行列表（listAllArtifacts）的每一行都要能说出自己
       属于哪一次运行。getRun 的消费方没有读者用这一格（它们本来就在那次运行的上下文
       里），多带一列在这里是**补齐**而不是冗余：少一列会让产物列表画不出运行入口。 */
    runId: artifact.run_id,
    stepSeq: artifact.step_seq,
    type: artifact.type,
    objectType: artifact.object_type,
    objectId: artifact.object_id,
    version: artifact.version,
    parentId: artifact.parent_id,
    status: artifact.status,
    body: parse(artifact.body_json, null),
    createdAt: artifact.created_at,
  }
}

/** The most recent runs, newest first. Without steps/artifacts: the list does not draw them. */
export function listRuns(store, { limit = 20 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 100)
  const rows = store.all('SELECT * FROM agent_run ORDER BY started_at DESC, rowid DESC LIMIT ?', [cap])
  return {
    rows: rows.map(row => ({
      id: row.id,
      role: row.role,
      roleLabel: roleById(row.role)?.label ?? row.role,
      goal: row.goal,
      /* F12-04：列表行也要能说出任务类型，否则列表里读者只能靠 goal 猜。
         `null` = 未声明 —— 同上，不折算。 */
      taskType: row.task_type ?? null,
      status: row.status,
      waitingReason: row.waiting_reason,
      blockedReason: row.blocked_reason,
      /* F12-06：列表也要能说出 blocked 的**原因**，否则工具输出里只有一句自由文本，
         读者仍然分不出「数据过期」与「权限不足」—— 而那正是 §9 要按原因分派的东西。 */
      blockedKind: row.blocked_kind ?? null,
      /* 2026-10-25 真实数据实测（R-8）：`SELECT *` 早就取到了 `error`，但映射时没带出来 ——
         于是工具层想印也印不到（我第一版只改了渲染那边，`row.error` 恒 undefined，
         **改了等于没改**）。失败的解释是这一行最有价值的东西，不能只留在库里。 */
      error: row.error ?? null,
      trigger: row.trigger,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      stepCount: store.get('SELECT COUNT(*) AS n FROM agent_step WHERE run_id = ?', [row.id]).n,
      artifactCount: store.get('SELECT COUNT(*) AS n FROM agent_artifact WHERE run_id = ?', [row.id]).n,
    })),
    total: store.get('SELECT COUNT(*) AS n FROM agent_run').n,
  }
}

/**
 * Start a run and freeze its context package.
 *
 * The snapshots are taken **here**, in one place, so no caller can start a run
 * with a half-taken package — §15-1 是「每次运行可复现数据/规则/Prompt 版本」，
 * 一份缺了规则快照的运行无法复现任何东西。F12-02 给这份包补上第五样：**当时的角色
 * 配置版本**（`role_config_version` + `role_config_json`），与规则 / Prompt 快照
 * **同一个形状**（拷贝，不是引用）。
 *
 * ## 校验读的是**配置**，不是代码常量
 *
 * 「这个角色可用吗」此前读 `roles.js` 的 `available`。现在读该角色**当前配置版本**里的
 * `available` —— 角色的声明是可以发布的，代码那份只是默认值（见 roles.js 文件头）。
 * 拒绝时把**版本号**带进错误信息，否则「为什么这个角色不可用」会指向一个读者看不到的
 * 版本。角色还没有任何配置版本时（理论上播种之后不会发生）回落到代码声明，不静默放行。
 *
 * ## F12-03 补的两样：人工约束与输出格式
 *
 * 两样都在**开始时冻结**（写一次，之后没有任何写入路径改它们）。区别只有一句：
 *
 *   - `humanConstraint` —— 人在这次运行**外加**的限制（「别动这几个 ASIN」）。插件把它
 *     存下来、并在运行详情里画出来；插件**不校验**它、也**不**真的去拦住谁（它不驱动 Agent）。
 *   - `outputFormat` —— **约定**，不是校验。插件**没有**产物格式校验器：调用方写
 *     `'json'` 而产物是散文，插件**不会报错**。这一列只是把约定**记下来**，供人和会话读。
 *
 * ⚠️ 两样都**拒绝空串**（见 `optionalText`）：`''` 是一个看起来像「给了」的值，
 * 折成 `NULL` 之后「他没说」与「他说了一个空格」就分不开了。
 *
 * ## F12-09 补的第六样：取代关系（`supersedesRunId`）
 *
 * §12 逐字：「上下文变化：**创建新运行，不修改旧运行**」。所以这条路径**只加一个指针**，
 * 一个字节都不动旧运行 —— 新运行自己重新冻结自己的快照（`startRun` 本来就这么做）。
 *
 * ⚠️ 指针必须指向一次**真的存在**的运行：一个指向不存在运行的「取代」是一条编出来的
 * 溯源。空串也拒绝（与 `humanConstraint` 同一条规矩）。
 *
 * ⚠️ 它**不是**上下文包的一部分，所以 `snapshot.js` 的「七个不可变项」不含它 ——
 * 「这次用什么跑的」与「这次取代了谁」是两件事。
 */
export function startRun(store, {
  role, goal = null, scope = {}, trigger = 'manual', status = 'running',
  humanConstraint = null, outputFormat = null, supersedesRunId = null, taskType = null,
} = {}) {
  const wanted = String(role ?? '').trim()
  const definition = roleById(wanted)
  if (definition === undefined) throw new Error(`unknown role: ${role}`)
  if (!AGENT_RUN_STATUSES.includes(status)) throw new Error(`unknown run status: ${status}`)
  /* 先校验参数，再碰库：一个坏参数不该在配置读完之后才被发现。 */
  const constraint = optionalText(humanConstraint, 'humanConstraint')
  const format = optionalText(outputFormat, 'outputFormat')
  const supersedes = optionalRunRef(store, supersedesRunId, 'supersedesRunId')
  const type = optionalTaskType(taskType)

  const configRow = latestRoleConfig(store, wanted)
  const config = configRow?.config ?? roleConfigOf(definition)
  if (config.available !== true) {
    const version = configRow === null ? '（还没有配置版本，读的是代码声明）' : `配置 v${configRow.version}`
    throw new Error(`role ${wanted} is declared but not available yet（${version}）— ${config.why ?? definition.why ?? ''}`)
  }

  const id = runId()
  store.run(
    `INSERT INTO agent_run (
       id, role, goal, scope_json, data_snapshot_json, rules_snapshot_json, prompts_snapshot_json,
       role_config_version, role_config_json, human_constraint, output_format, supersedes_run_id, task_type,
       status, waiting_reason, blocked_reason, blocked_kind, trigger, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, NULL)`,
    [
      id, wanted, goal === null ? null : String(goal),
      JSON.stringify(scope ?? {}),
      JSON.stringify(dataSnapshot(store)),
      JSON.stringify(rulesSnapshot(store)),
      JSON.stringify(promptSnapshot(store)),
      configRow === null ? null : configRow.version,
      JSON.stringify(config),
      constraint, format, supersedes, type,
      status, String(trigger ?? 'manual'), nowIso(),
    ],
  )
  return getRun(store, id)
}

/**
 * Move a run's status.
 *
 * Every move is checked against the state machine, so `waiting_human` cannot be
 * reached from `completed` and a finished run cannot be quietly reopened. The two
 * reason columns are **required** by the caller when the state is one that means
 * 「停在等人」 (waiting_human) or 「走不动了」 (blocked): §11 的原话是「Agent 必须说明
 * 等待什么，不只显示『需要确认』」，而一个没有原因的 waiting_human 就是那句被禁掉的
 * 话。
 */
export function setRunStatus(store, id, status, {
  waitingReason = null, blockedReason = null, blockedKind = null, error = null,
} = {}) {
  const run = getRun(store, id)
  if (run === null) throw new Error(`no agent run ${id}`)
  if (!AGENT_RUN_STATUSES.includes(status)) throw new Error(`unknown run status: ${status}`)
  if (!canTransitionRun(run.status, status)) {
    throw new Error(`cannot move run ${id} from ${run.status} to ${status}`)
  }
  if (status === 'waiting_human' && String(waitingReason ?? '').trim() === '') {
    throw new Error('waiting_human requires a reason — 「需要确认」 alone is not a reason (§11)')
  }
  if (status === 'blocked' && String(blockedReason ?? '').trim() === '') {
    throw new Error('blocked requires a reason (§6.2 names six kinds, §12 adds a seventh)')
  }
  /* F12-06：blocked 还要一个**原因类别**，因为 §9 是按原因分派出口动作的 —— 没有类别的
     blocked 只能退回「固定两个按钮」，那正是这一批要消灭的东西。
     ⚠️ 反过来，**非** blocked 的移动不接受 `blockedKind`：往 `running` 走的时候塞一个
     新原因，会让一条「已修复、继续跑」的运行看起来仍然是卡住的。 */
  if (status === 'blocked') {
    const refusal = blockedKindRefusal(blockedKind)
    if (refusal !== null) throw new Error(`${refusal.error} — ${refusal.hint}`)
  } else if (blockedKind !== null && blockedKind !== undefined) {
    throw new Error(`blockedKind is only written together with status "blocked" (got status ${status})`)
  }

  const finishedAt = isTerminal(status) ? nowIso() : null
  store.run(
    `UPDATE agent_run SET status = ?, waiting_reason = ?, blocked_reason = ?, blocked_kind = ?,
       error = ?, finished_at = COALESCE(?, finished_at)
     WHERE id = ?`,
    [status, waitingReason, blockedReason, blockedKind, error, finishedAt, run.id],
  )
  return getRun(store, run.id)
}

/**
 * 一个可选的**标签**字段（F12-06 的 `agentRole` / `toolName`）。
 *
 * 与 `optionalText` 的区别是它 `trim`：这两个是**标识符**（角色 id、工具名），不是人写的
 * 自由文本 —— 前后空格是笔误，不是内容。空串照旧**拒绝**（「没记」要省略参数，不是传空串）。
 */
function optionalLabel(value, field) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${field} must be a string, got ${typeof value}`)
  const wanted = value.trim()
  if (wanted === '') {
    throw new Error(`${field} must not be an empty string — omit it to mean "not recorded" instead of passing one`)
  }
  return wanted
}

/**
 * 这一步「能不能重试」的落点（F12-09 / §12「工具失败：记录参数摘要、错误类型、**是否可重试**」）。
 *
 * 三条规则，按优先级：
 *
 *   1. 调用方**显式**给了 `retryable`（boolean）→ 记它。一次工具失败**为什么**失败只有
 *      调用方知道（网络抖动 vs 参数写错），插件猜不出来。
 *   2. 没给、且这一步**失败了** → 从该运行**冻结的**角色配置的 `onFailure` 推：
 *      `continue` → 可重试，`stop` → 不可重试。
 *      ⚠️ **这是 `onFailure` 唯一的执行点。** F12-02 把它加进角色声明时它只是一句话，
 *      全仓没有任何东西读它 —— 一条「有出口、没有闭环」的声明。这一条让它有读者。
 *      读的是**冻结值**（`run.roleConfig`），不是当前配置：一步的处置建议不该在运行中途
 *      被一次配置发布改掉（与 `maxSteps` 同一条不可变纪律）。
 *   3. 没给、且这一步**没有失败** → `null`（**没记**）。§12 那一栏说的是「工具**失败**时
 *      记录…是否可重试」—— 一步还没失败，这个问题就还没出现。写 `false` 会把它渲染成
 *      「这一步失败过、而且不可重试」，那是一件没发生过的事（本仓最忌的形状）。
 *
 * 冻结配置里没有 `onFailure`（v40 之前开的运行）→ `null`，**不猜**。
 */
function retryableFor(run, status, given) {
  if (typeof given === 'boolean') return given
  if (given !== null && given !== undefined) {
    throw new Error(`retryable must be a boolean or omitted, got ${JSON.stringify(given)}`)
  }
  if (status !== 'failed') return null
  const policy = run.roleConfig?.onFailure
  if (policy === 'continue') return true
  if (policy === 'stop') return false
  return null
}

/**
 * Record one step. Upsert on `(run_id, seq)`.
 *
 * Re-recording a step is the normal case, not an error: a step goes
 * `running → passed`, and a retry re-records the same seq. The upsert is what makes
 * 「恢复后不重复已完成写入」（§15-6）true — a resumed run re-reports its finished
 * steps and they land on the same row instead of stacking a second history.
 *
 * ## F12-06 / F12-09 补的三列，以及它们为什么**直接覆盖**而不是 COALESCE
 *
 * `agent_role`（§9「每步负责 Agent」）、`tool_name`（§9「工具调用」）、`retryable`
 * （§12「是否可重试」）三列在 UPDATE 分支里都是**直接赋值**，不像 `input_json` /
 * `output_json` 那样 `COALESCE`。
 *
 * 这个区分是有意的：`input` / `output` 是**增量累积**的内容（第一次回报输入、第二次回报
 * 输出，第二次不该把第一次的抹掉），而这三列描述的是这一步**当前**的样子 —— 与 `status` /
 * `error` 同类。用 `COALESCE` 保留旧值，会让「这一次没记」变成「沿用上一次记的」，
 * 那正是给缺失造一个像数据的替身。
 */
export function recordStep(store, {
  runId, seq, step, status = 'running', input = null, output = null, error = null,
  agentRole = null, toolName = null, retryable = null,
} = {}) {
  const run = getRun(store, runId)
  if (run === null) throw new Error(`no agent run ${runId}`)
  if (!AGENT_STEP_STATUSES.includes(status)) throw new Error(`unknown step status: ${status}`)
  const index = Number(seq)
  if (!Number.isInteger(index) || index < 1) throw new Error(`step seq must be a positive integer (got ${seq})`)
  if (String(step ?? '').trim() === '') throw new Error('step name is required')

  /* F12-02：该运行**冻结的**角色配置若声明了 `maxSteps`，越界的 `seq` 在这里被拒绝。
     这是「最大步骤」从一句声明变成**可执行**的落点 —— 没有它，`maxSteps` 就只是一个
     没人读的字段，正是本批要消灭的「有出口、没有闭环」。
     读的是**冻结值**（`run.roleConfig`），不是当前配置：一次运行的上限不该在它跑的中途
     被一次发布改掉（与规则 / Prompt 快照同一条不可变纪律）。
     `null` / 非整数 = 未声明 → 放行（⚠️ `null` 不是 0）。 */
  const cap = run.roleConfig?.maxSteps
  if (Number.isInteger(cap) && index > cap) {
    throw new Error(
      `step seq ${index} exceeds the role's declared maxSteps ${cap}`
      + `（${run.role}${run.roleConfigVersion === null ? '' : ` 配置 v${run.roleConfigVersion}`}）`,
    )
  }

  /* F12-06：两栏都是可选的「没记」，且**空串被拒绝**（见 optionalLabel）。 */
  const role = optionalLabel(agentRole, 'agentRole')
  const tool = optionalLabel(toolName, 'toolName')
  /* F12-09：三态 + 缺省推导（见 retryableFor 的注释）。在碰库之前算完。 */
  const canRetry = retryableFor(run, status, retryable)
  const retryableValue = canRetry === null ? null : (canRetry ? 1 : 0)

  const existing = store.get('SELECT id FROM agent_step WHERE run_id = ? AND seq = ?', [run.id, index])
  const finishedAt = status === 'running' || status === 'pending' ? null : nowIso()
  if (existing === undefined) {
    store.run(
      `INSERT INTO agent_step (id, run_id, seq, step, status, input_json, output_json, error,
         agent_role, tool_name, retryable, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), run.id, index, String(step), status,
        input === null ? null : JSON.stringify(input),
        output === null ? null : JSON.stringify(output),
        error, role, tool, retryableValue, nowIso(), finishedAt,
      ],
    )
  } else {
    store.run(
      `UPDATE agent_step SET step = ?, status = ?, input_json = COALESCE(?, input_json),
         output_json = COALESCE(?, output_json), error = ?,
         agent_role = ?, tool_name = ?, retryable = ?, finished_at = COALESCE(?, finished_at)
       WHERE id = ?`,
      [
        String(step), status,
        input === null ? null : JSON.stringify(input),
        output === null ? null : JSON.stringify(output),
        error, role, tool, retryableValue, finishedAt, existing.id,
      ],
    )
  }
  return getRun(store, run.id).steps.find(entry => entry.seq === index)
}

/**
 * 把僵死的 `running` 运行标成 `blocked`（§12「任务中断：从最后持久化步骤恢复」）。
 *
 * ## ⚠️ 它**只标状态，绝不自动重跑**
 *
 * 需求 §12 说「从最后持久化步骤恢复」，但**恢复 ≠ 自动重跑**：本插件不驱动 Agent，
 * 真正在跑的是会话侧的 DSH Agent。插件若「自动恢复」，等于替会话决定继续执行 ——
 * 那是插件做不到、也不该做的承诺。所以这里只做一件事：把「这条 running 很久没动了」
 * 这个**事实**写下来，把决定权交回人 / 会话。
 *
 * ## 为什么标 `blocked` 而不是 `failed`
 *
 * `failed` 是**终止态**（`RUN_EDGES.failed = []`），一旦标上就只剩「新建一次运行」这条路
 * （§12 的 `supersedes_run_id`）。而中断的运行**本来就有已经持久化的步骤**，它要的是
 * **继续** —— `blocked → running` 有边。标成 `failed` 会让「可从该步恢复」这句需求原文
 * 落空。
 *
 * ## 判据：多久没动算僵死
 *
 * 用**最后一步的 `started_at`**（没有步骤就退回运行的 `started_at`）与当前时刻的差。
 * ⚠️ **不给 `staleMinutes` 就一条都不扫**（返回空结果）—— 一个内置默认阈值会变成
 * 「插件自己决定谁该被中断」，而阈值该由调用方（人 / 运维）给。这条与 `recoverStaleTasks`
 * 一样（那边也要调用方传 `kind`），但这里更明确：`null` 不是「用默认值」，是「不扫」。
 *
 * ## 与 `recoverStaleTasks` 的一处**不同**（不许当漏写）
 *
 * 那边会写一条 `collection_task_event` 事件行，把「从哪个状态被推到了哪个状态」记成历史。
 * 这边**没有对应的事件表** —— `agent_run` 没有 event 表。所以中断这件事只落在
 * `blocked_reason` 与 `blocked_kind` 上，**历史由审计回答**（`WRITE_TARGETS` 的
 * `readBefore` 读的就是这次运行，「它被从 running 推到了 blocked」正是那一行要回答的）。
 */
export function recoverStaleAgentRuns(store, { staleMinutes = null, now = null } = {}) {
  const minutes = Number(staleMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return {
      ok: true,
      staleMinutes: null,
      cutoff: null,
      scanned: 0,
      interrupted: [],
      held: [],
      note: '没有给 staleMinutes（或它不是正数）—— 一条运行都没扫。阈值由调用方给，插件不自己定。',
    }
  }
  const at = now === null ? nowIso() : String(now)
  const cutoff = new Date(new Date(at).getTime() - minutes * 60000).toISOString()

  const rows = store.all(
    `SELECT r.id AS id, r.role AS role, r.started_at AS started_at,
            (SELECT MAX(s.started_at) FROM agent_step s WHERE s.run_id = r.id) AS last_step_at,
            (SELECT COUNT(*) FROM agent_step s WHERE s.run_id = r.id) AS step_count
       FROM agent_run r
      WHERE r.status = 'running'
      ORDER BY r.started_at`,
  )

  const interrupted = []
  const held = []
  for (const row of rows) {
    /* 最后活动时刻：有步骤看最后一步，没有就看运行自己开始的那一刻。 */
    const last = row.last_step_at === null || row.last_step_at === undefined ? row.started_at : row.last_step_at
    if (String(last) >= cutoff) {
      held.push({ id: row.id, role: row.role, lastActivityAt: last, stepCount: row.step_count })
      continue
    }
    const steps = Number(row.step_count) || 0
    setRunStatus(store, row.id, 'blocked', {
      blockedKind: 'interrupted',
      blockedReason: `运行中断：${steps === 0 ? '还没有回报任何步骤' : `停在第 ${steps} 步之后`}`
        + `，最后活动 ${String(last).slice(0, 19).replace('T', ' ')}（超过 ${minutes} 分钟没有更新）。`
        + '已持久化的步骤都在，可以从该步继续。⚠️ 本插件不驱动 Agent：它不会自动重跑，'
        + '继续由人 / 会话决定。',
    })
    interrupted.push({ id: row.id, role: row.role, lastActivityAt: last, stepCount: steps })
  }

  return { ok: true, staleMinutes: minutes, cutoff, scanned: rows.length, interrupted, held, note: null }
}

/**
 * Save one artifact, versioned.
 *
 * Passing `parentId` makes a new version of the same chain; `supersedeParents`
 * marks the parent `superseded` in the same breath, so 「新版本取代旧版本」 is one
 * write instead of two that can half-happen. The old row is never deleted — §15-7
 * needs it to keep resolving for the reports that referenced it.
 *
 * ## ⚠️ 这是一个内部原语：两条规则分住在两层，别搞混
 *
 * 1. **「Agent 只能写 draft」在工具层**，不在这里。`status` 是自由的：直接调这个函数
 *    可以建一条任意状态的产物，包括 `accepted`。之所以**不**把这条规则挪进来：
 *    `agentGateDecideTool` 与 `decideArtifact` 都**合法地**通过这个函数写
 *    `accepted`/`rejected` —— 把规则写进 store 会把它们一起打死。它今天不可达：
 *    没有工具、没有路由暴露「任意 status 的 save」，而 `amzn_agent_artifact_save`
 *    只透传 `draft`。
 * 2. **「accepted 的父版本不能被 `supersedeParents` 抹掉」在这里**（见下），因为它是
 *    **数据完整性**：无论哪个调用方、哪条路径，一次人工裁决都不该被版本操作擦掉。
 *    两层各管一条，别以为 store 兜住了第 1 条、也别以为工具层兜住了第 2 条。
 */
export function saveArtifact(store, {
  runId, stepSeq = null, type, objectType = null, objectId = null,
  parentId = null, status = 'draft', body = null, supersedeParents = false,
} = {}) {
  const run = getRun(store, runId)
  if (run === null) throw new Error(`no agent run ${runId}`)
  if (String(type ?? '').trim() === '') throw new Error('artifact type is required')
  if (!AGENT_ARTIFACT_STATUSES.includes(status)) throw new Error(`unknown artifact status: ${status}`)

  let version = 1
  let parent = null
  if (parentId !== null && parentId !== undefined) {
    parent = store.get('SELECT * FROM agent_artifact WHERE id = ?', [String(parentId)])
    if (parent === undefined || parent === null) throw new Error(`no artifact ${parentId} to version`)
    if (parent.run_id !== run.id) throw new Error(`artifact ${parentId} belongs to another run`)
    version = Number(parent.version) + 1
  }

  /* 一个 accepted 的版本**不是 Agent 的**，不能由 `supersedeParents` 翻成 superseded。
   *
   * `agent_artifact.status` 一列兼两个职责：链位置（`superseded`）与**人的处置**
   * （`draft`/`accepted`/`rejected`）。不拦这一条的话，
   * `save {parentId: <accepted id>, supersedeParents: true}` 会把一条**人已经接受**的产物
   * 抹成 `superseded` —— Agent 不能自批，却能**擦掉**别人的批准，人的裁决就不是终局了。
   * （这是 §11 草案级控制的第二半：入口补上了，出口也得堵上。）
   *
   * 在 INSERT **之前**拒绝：什么都没写，也不需要事务 —— 拒绝发生在任何一行之前。
   * `draft` / `rejected` 的父版本照旧可以被取代：一份没人看过的稿子、一份被驳回的稿子，
   * 都不构成「人的终局裁决」。
   */
  if (supersedeParents && parent !== null && parent.status === 'accepted') {
    throw new Error(
      `artifact ${parent.id} is accepted — a human decision stands and the agent cannot supersede it;`
      + ' add a version without supersedeParents to revise it, or ask a person to decide again',
    )
  }

  const id = randomUUID()
  store.run(
    `INSERT INTO agent_artifact (id, run_id, step_seq, type, object_type, object_id, version, parent_id, status, body_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, run.id, stepSeq, String(type), objectType, objectId, version, parent?.id ?? null, status,
      body === null ? null : JSON.stringify(body), nowIso()],
  )
  if (supersedeParents && parent !== null) {
    store.run("UPDATE agent_artifact SET status = 'superseded' WHERE id = ?", [parent.id])
  }
  return getRun(store, run.id).artifacts.find(entry => entry.id === id)
}

/**
 * The true head of the version chain `row` belongs to — the row in that chain with
 * no child — or `null` when the head cannot be determined.
 *
 * **Walk forward, not one step.** A superseded row's *child* is not the head: on a
 * v1→v2→v3 chain the child of v1 is v2, which is itself superseded. A first version
 * of this function returned the child, so deciding v1 named 「the current version
 * (v2)」 — a **fabricated** answer, since v2 is dead too. Following `parent_id`
 * until there is no child is what makes the named id real.
 *
 * **`null` rather than a substitute.** When the walk ends where it started the row
 * has no descendant at all — a lone row marked `superseded` by hand. There is no
 * current version to point at, and naming the row itself (or some same-object row
 * from a different chain) would be inventing one. This project's rule is that a
 * substitute for a missing value is worse than an admitted hole, so the caller's
 * message names **nothing**.
 */
function currentVersion(store, row) {
  const seen = new Set([row.id])
  let head = row
  for (;;) {
    const child = store.get(
      `SELECT id, version, status FROM agent_artifact
        WHERE parent_id = ? ORDER BY version DESC, created_at DESC, rowid DESC LIMIT 1`,
      [head.id],
    )
    if (child === undefined || child === null) break
    /* A cycle is not a chain with a head; refuse to name one rather than loop. */
    if (seen.has(child.id)) return null
    seen.add(child.id)
    head = child
  }
  /* `head === row` means no descendant was found: nothing to name. */
  if (head.id === row.id) return null
  return head
}

/** One artifact by id, hydrated (the same shape `getRun` returns), or `null`. */
export function getArtifact(store, id) {
  const key = String(id ?? '').trim()
  if (key === '') return null
  /* Read the row we are actually returning, then hydrate it with the **same**
     projection `getRun` and `listAllArtifacts` use. It used to re-read the whole
     run (`getRun(store, row.run_id)`) and `find` the artifact inside it: correct,
     but it read every step and every artifact of that run to return one row.
     Delegating to `hydrateArtifact` also removes the only way the three artifact
     projections could drift — a column added to one would have been missing here. */
  const row = store.get('SELECT * FROM agent_artifact WHERE id = ?', [key])
  if (row === undefined || row === null) return null
  return hydrateArtifact(row)
}

/**
 * Decide a draft artifact: accept it or reject it (§11 的草案级人工控制).
 *
 * ## 由**人**推动产物状态的两条路径之一
 *
 * `agent_artifact.status` 有四态，而在这些路径存在之前，除了 Agent 自己调
 * `amzn_agent_artifact_save` 之外没有任何人能把它从 `draft` 推走 —— 一次运行跑完门禁
 * 之后草案永远停在 `draft`。`amzn_agent_gate_decide` 不是反例：它写一条**新的**
 * `gate-decision` 产物，从不碰被门禁守着的那个草案。
 *
 * ⚠️ **本文件里有两条人推的动作，别只数一条**：
 *   - 本函数：接受 / 驳回 —— **不动正文**（见下面那条字节级不变量）；
 *   - `amendAndAcceptArtifact`（F12-08 的第三个选项「修改后接受」）—— 建一个新版本
 *     带上人改过的正文，再接受新版本。
 *
 * 曾经这里写着「『草案级：接受 / 修改后接受 / 驳回』在代码里**不存在**」—— 那句话在
 * 接受/驳回补上时就只剩一半真，在「修改后接受」补上（B-12.13）后**整句都假了**。
 * 这正是本仓记过多次的形状：**否定式断言最容易过期，而且过期后没有任何测试会红。**
 *
 * ## 三条拒绝都是「下一步不一样」，不是格式校验
 *
 *   - **不存在的 id**：没有东西可裁决。
 *   - **superseded**：链上的旧版本不是要裁决的东西，要点名**当前版本** —— 裁决一个
 *     已经被取代的版本，等于给一份没人会读的稿子盖章。
 *   - **已经 accepted / rejected**：裁决是**追加式**的。第二次处置是一次**新版本**
 *     （`parentId`），不是静默覆盖 —— 与快照登记的纪律同一条（「新数据追加一版，
 *     永不覆盖历史」）。
 *
 * ## 一次事务，两处写入
 *
 * 「改草案状态」与「插入一条记录谁/为什么/何时」的裁决产物必须在**同一个事务**里，
 * 否则这次动作可能只发生一半：状态改了却没有留痕，或者留痕了状态却没改。
 * `store.tx` 只发 `BEGIN`，`store.run` 只是执行一条语句（不自己开事务），所以把
 * `saveArtifact` 放进 `store.tx` 里是安全的 —— 它复用产物版本链的**唯一**实现，
 * 而不是在这里再写一遍 INSERT（两份实现迟早分叉）。
 *
 * ## 草案的 `body_json` **一个字节都不动**
 *
 * 裁决不是编辑。被裁决的产物的正文保持原样，这是这条路径最容易写错的地方
 * （顺手把新状态一起写进 `body_json` 会看起来更「完整」）。测试里有一条字节级
 * 断言钉死它。
 */
export function decideArtifact(store, { artifactId, accept, note = null, by } = {}) {
  const { row, decider } = decisionTarget(store, artifactId, by)
  return store.tx(() => decideInTx(store, row, { accept, note, by: decider }))
}

/**
 * 「修改后接受」（F12-08 草案级三选里的第三个）—— 人改正文，然后接受改后的那一版。
 *
 * ## 为什么不给 `decideArtifact` 加一个 `body` 参数
 *
 * 上面那段 JSDoc 有一条字节级不变量：**裁决不是编辑**，被裁决产物的 `body_json`
 * 一个字节都不动，测试钉着它。让 `decideArtifact` 顺手改正文，会让那条不变量变成假话，
 * 而且会让库里**分不清「接受」与「改后接受」** —— 那正是本仓最忌的形状：
 * 把一次真实的编辑渲染成一次普通的接受。
 *
 * ⇒ 所以这是**独立的动作**，它做两件事、留两处痕：
 *   1. 用 `saveArtifact` 建 **v+1**（`parentId` = 原草案，正文 = 人改后的），
 *      并 `supersedeParents: true` 把原草案标 `superseded`（父版是 `draft`，不会撞上
 *      「accepted 的父版不能被抹掉」那条守卫）；
 *   2. 裁决 **v+1**（走**同一份**裁决记录实现 `decideInTx`），记录里写
 *      `amended: true` + `amendedFrom`。
 *
 * 这样库里能回答「这条被接受的正文是谁写的」—— 纯接受做不到这一点。
 *
 * ## `body === undefined` 必须拒绝（本函数最重要的一条）
 *
 * 没有改动就不叫「修改后接受」。放行它等于给一次**没改**的接受盖一个「改过」的章 ——
 * 「给缺失造一个像数据的替身」。直接接受请用 `decideArtifact`。
 *
 * ⚠️ 判据是 `=== undefined`，**不是** `=== null`：`null` 是一个合法的产物正文
 * （`saveArtifact` 对 `body === null` 写 SQL NULL），人把正文清空是一个**真实的修改**。
 * 写成 `!body` 会把 `null`、`0`、`''` 一起拒掉 —— 那三种都是合法的正文值。
 *
 * ## 一个事务
 *
 * `store.tx` 只发 `BEGIN`、**不可重入**，所以这里不能调 `decideArtifact`（它会再开一个）。
 * 两处写入必须在同一个事务里：否则可能出现「新版本写进去了、却没人裁决」或
 * 「裁决留痕了、新版本却不在」。
 */
export function amendAndAcceptArtifact(store, { artifactId, body, note = null, by } = {}) {
  const { row, decider } = decisionTarget(store, artifactId, by)
  if (body === undefined) {
    throw new Error(
      'an amend needs a body — 没有改动就不叫「修改后接受」；'
      + '直接接受请用 amzn_agent_artifact_decide（不带 body）。'
      + '（`null` 是允许的：把正文清空是一次真实的修改。）',
    )
  }
  return store.tx(() => {
    const revised = saveArtifact(store, {
      runId: row.run_id,
      stepSeq: row.step_seq,
      type: row.type,
      objectType: row.object_type,
      objectId: row.object_id,
      parentId: row.id,
      status: 'draft',
      body,
      supersedeParents: true,
    })
    /* `decideInTx` 收的是**库行**（`snake_case`），而 `saveArtifact` 返回的是驼峰投影 ——
       再读一次库行，比在这里手工做一次驼峰→下划线的映射安全（映射会随列变化而漂）。 */
    const revisedRow = store.get('SELECT * FROM agent_artifact WHERE id = ?', [revised.id])
    const decided = decideInTx(store, revisedRow, {
      accept: true,
      note,
      by: decider,
      amended: { from: row.id, fromVersion: row.version },
    })
    return { ...decided, superseded: row.id, supersededVersion: row.version }
  })
}

/**
 * 裁决的**共同前置**：找到那条产物、验署名、挡掉不该被裁决的三种状态。
 *
 * 抽出来是因为 `decideArtifact` 与 `amendAndAcceptArtifact` 的前置**必须一致** ——
 * 两份各写一遍，迟早一处漏掉「superseded 要点名当前版本」这类细节。
 */
function decisionTarget(store, artifactId, by) {
  const id = String(artifactId ?? '').trim()
  if (id === '') throw new Error('artifact id is required')

  const row = store.get('SELECT * FROM agent_artifact WHERE id = ?', [id])
  if (row === undefined || row === null) throw new Error(`no artifact ${id}`)

  const decider = String(by ?? '').trim()
  if (decider === '') {
    throw new Error('a decision needs an author — an unattributed disposition is the 「需要确认」 shape §11 forbids')
  }

  if (row.status === 'superseded') {
    const head = currentVersion(store, row)
    throw new Error(
      `artifact ${id} is superseded — decide the current version instead`
      + (head === null ? '' : ` (${head.id}, v${head.version}, ${head.status})`),
    )
  }
  if (row.status === 'accepted' || row.status === 'rejected') {
    throw new Error(
      `artifact ${id} is already ${row.status} — a decision is append-only;`
      + ' a second disposition is a new version (parentId), not a silent overwrite',
    )
  }
  return { row, decider }
}

/**
 * 裁决的**唯一实现**：改状态 + 追加一条 `artifact-decision`。
 *
 * ⚠️ **假定事务已开**（调用方负责 `store.tx`）。这不是风格问题：`store.tx` 只发 `BEGIN`，
 * 不可重入，所以这里再开一个会把 SQLite 弄坏。
 *
 * ⚠️ 收的是**库行**（`run_id` / `step_seq` 这种下划线形状），不是 `hydrateArtifact` 的驼峰投影。
 *
 * `amended` 为 `null` 表示**纯接受/驳回**，写 `amended: false`；
 * 非 `null` 时是改后接受，额外写 `amendedFrom` / `amendedFromVersion`。
 * ⚠️ **本批之前写的老记录没有 `amended` 键** —— 读者必须把「缺键」读成 `false`。
 * 这是**有意的兼容**（老记录确实不是改后接受），不是遗漏；别把它当成「不知道」。
 */
function decideInTx(store, row, { accept, note = null, by, amended = null }) {
  const nextStatus = accept === true ? 'accepted' : 'rejected'
  store.run('UPDATE agent_artifact SET status = ? WHERE id = ?', [nextStatus, row.id])
  const decision = saveArtifact(store, {
    runId: row.run_id,
    type: 'artifact-decision',
    objectType: 'agent-artifact',
    objectId: row.id,
    status: nextStatus,
    body: {
      artifactId: row.id,
      artifactType: row.type,
      accept: accept === true,
      note: note === null || note === undefined ? null : String(note),
      by,
      from: row.status,
      amended: amended !== null,
      ...(amended === null ? {} : { amendedFrom: amended.from, amendedFromVersion: amended.fromVersion }),
    },
  })
  return { artifact: getArtifact(store, row.id), decision }
}

/* F12-05 顺手裁决：这里原本有一个 `listArtifacts(store, runId)`，
   整个函数体是 `return getRun(store, runId)?.artifacts ?? []`。
   它**已删除**，理由是它不只是重复，而且是**有害**的重复：

   - 库层每一个别的 `list*`（`listRuns`、`listArtifacts` 的邻居们）都自己跑一条 SQL。
     `listArtifacts` 是唯一的例外 —— 它不查库，只是把 `getRun` 已经给出的字段再暴露一次。
     消费方的既定写法就是 `getRun(...).artifacts`：`page.js:4111-4150` 读
     `detail.artifacts` 读了四处，`getArtifact`（本文件 :328）与 :374 也都这么写。
   - 那 `?? []` 兜底把「**没有这次运行**」与「**这次运行没有产物**」折叠成同一个答案。
     调用方拿到 `[]` 无从分辨：运行不存在，还是运行存在但那一步真的一条产物都没有。
     这正是本仓的招牌缺陷形状 —— **把缺失渲染成真实值**（「没读到 ≠ 确实没有」）。
     要区分就得再查一次 `getRun`，那还不如一开始就用 `getRun`。

   ⚠️ **不要再把它加回来。** 需要某次运行的产物就用 `getRun(store, id)?.artifacts ?? []` ——
   在调用点写 `?? []` 时，你**看得见**自己在把 null 折叠成空数组；封进一个库函数里就看不见了。
   `ARTIFACT_STATUSES` 保留：它有读者（校验产物状态的调用方），与这个只做转发的函数不同。 */

/**
 * Every artifact in the store, across runs, with the four filters the page's
 * 「产物」section offers — the **independent list view** F12-07 asked for.
 *
 * ## Why this is not the deleted `listArtifacts`, and must not be renamed to it
 *
 * The prohibition note above records a run-scoped `listArtifacts(store, runId)`
 * that was deleted on purpose. Four things separate this function from it, and
 * all four are load-bearing:
 *
 *   | | the forbidden one | this one |
 *   |---|---|---|
 *   | input | one runId | cross-run filters (type / status / objectType / runId) |
 *   | queries | **no** — forwarded `getRun().artifacts` | its own SQL, like every other `list*` |
 *   | returns | `[]`, collapsing 「no such run」 into 「no artifacts」 | `{ rows, total, limit }` |
 *   | name | `listArtifacts` | **`listAllArtifacts`** |
 *
 * ⚠️ **Do not name it `listArtifacts`.** The name is the only thing that stops
 * the next reader from concluding the deletion was reversed.
 *
 * ## `total` deliberately carries no `where`
 *
 * `total` is the count of **every** artifact in the store, not of the filtered
 * set. That single decision is what makes three situations distinguishable at
 * the page: 「库内共 N 条」is a fact about the store, and the difference between
 * 「筛选把结果筛空了」and 「库里本来就没有」is `rows.length === 0 && total > 0`
 * versus `total === 0`. A `total` that re-applied the filter would fold the two
 * into one number, which is this project's signature defect — rendering a
 * missing thing as a real value. Same rule, and same reason, as
 * `store/reports.js:226`.
 *
 * ⚠️ It also means `total` is **not** `rows.length`, and a caller must not use
 * it as one: `limit` genuinely truncates.
 *
 * `runId` is one of the filters rather than the only input, so 「this run's
 * artifacts」 is expressed as `listAllArtifacts(store, { runId })`'s `rows`. A
 * caller that wants the run-scoped answer with the null-vs-empty distinction
 * visible should still use `getRun(store, id)?.artifacts ?? []` at the call site,
 * where the `?? []` is written out in the open.
 */
export function listAllArtifacts(store, {
  type = null, status = null, objectType = null, runId = null, limit = 100,
} = {}) {
  const where = []
  const params = []
  if (type !== null && type !== '') { where.push('type = ?'); params.push(String(type)) }
  if (status !== null && status !== '') { where.push('status = ?'); params.push(String(status)) }
  if (objectType !== null && objectType !== '') { where.push('object_type = ?'); params.push(String(objectType)) }
  if (runId !== null && runId !== '') { where.push('run_id = ?'); params.push(String(runId)) }

  /* Capped at 500, one notch below `listReports`'s 1000: an artifact row carries a
     versioned body and the page renders every one of them, so the payload is
     heavier per row than a report index entry. */
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500)
  const rows = store.all(
    `SELECT * FROM agent_artifact
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...params, cap],
  )
  return {
    rows: rows.map(hydrateArtifact),
    /* ⚠️ No `where` — see the doc comment. This is the only source of the page's
       「库内共 N 条」, and the only way to tell 「筛没了」 from 「库里没有」. */
    total: Number(store.get('SELECT COUNT(*) AS n FROM agent_artifact')?.n ?? 0),
    limit: cap,
  }
}

/** The artifact statuses the schema accepts, re-exported for callers that validate. */
export const ARTIFACT_STATUSES = AGENT_ARTIFACT_STATUSES

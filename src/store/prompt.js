/**
 * The prompt library, as data.
 *
 * Prompts used to be two different things in two different places: the page's
 * buttons were a constant in `page.js`, and the writing strategy `prepare` handed
 * the agent did not exist at all. This module is the store-side half of moving
 * both into one place the user can edit — the same move B02 made for the rule
 * roster and B03 for the policy library.
 *
 * Four properties hold the shape together:
 *
 *   - **A set is per module, a scenario is per row.** `prompt_set` answers "which
 *     module, which generation"; `prompt.scenario` answers "a page button, or the
 *     assemble block `prepare` reads". A module's buttons and its assemble block
 *     are one set, so opening one place shows everything that module sends.
 *
 *   - **The template is validated at this boundary.** A body that does not parse,
 *     or that names a variable outside the closed set, is refused **by name** here
 *     rather than written. `parse.js` states the same rule for policies; the guard
 *     lives at the store because that is the one place every caller passes — a
 *     guard in the editor only protects the editor. `variables_json` is *derived*
 *     from the body, never accepted from the caller: a hand-passed variable list
 *     is exactly the second copy that goes stale.
 *
 *   - **`version` counts edits; each *update* freezes what it replaced.** Saving
 *     an existing row bumps `prompt.version` by one **and** registers the
 *     pre-image (the body as it was before this write) in the snapshot registry
 *     as a `prompt` snapshot versioned by the row's old version. Creating a row
 *     freezes **nothing**: there is no pre-image to freeze, and freezing the
 *     fresh body would manufacture a "version 1" that is not a rollback target
 *     (rolling back to it would change nothing while looking like it did). So the
 *     frozen versions are `1…version−1`, each used once, and **frozen count =
 *     edit count − 1** — a row that has never been updated has zero. That gap of
 *     one is not a defect to pad away; it is what "the first draft was never
 *     replaced" means. `rollbackPrompt` writes a frozen body back as a **new**
 *     edit (the counter goes up), because a rollback is a decision, not an
 *     erasure — the same discipline as `states.js`'s 「archived 不是删除」. Only
 *     saves made **after** this batch are frozen: the bodies overwritten before
 *     it were never captured and cannot be recovered, so a row saved earlier can
 *     have even fewer than `version−1`.
 *
 *   - **One resolver, and it is where the production gate lives.** `resolvePrompts`
 *     is what both the page and `amzn_optimize_prepare` call, so the button the user
 *     clicks and the strategy the agent reads cannot drift into being two different
 *     renderings of one row. Since F11-05 it is also the one place a prompt can be
 *     kept out of production: a prompt is used only when **both** gates pass —
 *     `enabled` (row-level mute) and `status === active` (the version's lifecycle).
 *     Anything excluded is returned in `skipped` **by name, with the gate that
 *     excluded it**, because a silently dropped prompt is indistinguishable from a
 *     library that never had one.
 *
 * Nothing here fetches anything. Prompts arrive by the page editor or by
 * `amzn_prompt_upsert`.
 */

import { randomUUID } from 'node:crypto'

import { PROMPT_LAYERS, PROMPT_SCENARIOS, renderTemplate, templateVariables } from '../domain/optimize/prompt.js'
import {
  PROMPT_LIFECYCLE_INITIAL, PROMPT_LIFECYCLE_LABELS, PROMPT_LIFECYCLE_STATES,
  assertPromptTransition, isPromptLifecycleState, isPromptProductionStatus, promptLifecycleNextStates,
} from '../domain/prompts/lifecycle.js'
import { variableReport } from '../domain/prompts/variables.js'
import { renderPromptWithReport } from '../domain/prompts/render.js'
import { PROMPT_COMMON_MODULE, PROMPT_SEED_VERSION } from '../domain/optimize/prompt-seed.js'
import { MODULES } from '../state/workbench.js'
import { nowIso } from './db.js'
import { getSnapshot, listSnapshots, registerSnapshot } from './snapshot.js'

/**
 * The closed module set: the nav's modules plus the shared `common` one.
 *
 * A prompt for a module the page cannot show is a row nothing ever reads — the
 * same silent-empty failure the rest of this store refuses. `common` is in the
 * set and not in the nav, which is why it is named rather than derived.
 */
const PROMPT_MODULES = [...MODULES.map(module => module.id), PROMPT_COMMON_MODULE]

/**
 * How many frozen versions of one prompt are read at once — **the one place this
 * number lives.**
 *
 * The page and `amzn_prompt_history` both call `promptHistory`, and it defaults
 * to this. Neither of them passes a `limit` of its own: when the route said `50`
 * and the tool said `200`, the two surfaces could disagree about how much history
 * exists, and the page drew the truncated list with no sign it was truncated. A
 * single constant makes "how many are shown" one answer, and `promptHistory`
 * returns the real totals alongside the rows so a reader can tell a short list
 * from a short history.
 */
export const PROMPT_HISTORY_LIMIT = 500

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** One `prompt` row in the shape the tools and the page consume. */
function rowToPrompt(row) {
  return {
    id: row.id,
    setId: row.set_id,
    module: row.module,
    scenario: row.scenario,
    layer: row.layer,
    label: row.label,
    body: row.body,
    variables: parseJson(row.variables_json, []),
    version: row.version,
    sortOrder: row.sort_order,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  }
}

/** Every prompt set, with how many rows it holds. */
export function listPromptSets(store) {
  return store.all(
    `SELECT s.id, s.module, s.name, s.version, s.note,
            (SELECT COUNT(*) FROM prompt p WHERE p.set_id = s.id AND p.deleted_at IS NULL) AS prompt_count
       FROM prompt_set s
      ORDER BY s.module`,
  ).map(row => ({
    id: row.id,
    module: row.module,
    name: row.name,
    version: row.version,
    note: row.note,
    promptCount: Number(row.prompt_count ?? 0),
  }))
}

/**
 * Every prompt row, joined to its set's module.
 *
 * `module` and `scenario` are optional filters; both are applied as literals
 * chosen from the request rather than interpolated SQL, so a filter can only
 * narrow, never widen.
 */
export function listPrompts(store, options = {}) {
  const where = ['p.deleted_at IS NULL']
  const params = []
  if (options.module !== undefined && options.module !== null && String(options.module).trim() !== '') {
    where.push('s.module = ?')
    params.push(String(options.module).trim())
  }
  if (options.scenario !== undefined && options.scenario !== null && String(options.scenario).trim() !== '') {
    where.push('p.scenario = ?')
    params.push(String(options.scenario).trim())
  }
  const rows = store.all(
    `SELECT p.*, s.module AS module, s.name AS set_name, s.version AS set_version
       FROM prompt p JOIN prompt_set s ON s.id = p.set_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.module, p.scenario, p.sort_order, p.label`,
    params,
  )
  return rows.map(row => ({ ...rowToPrompt(row), setName: row.set_name, setVersion: row.set_version }))
}

/** One prompt by id, or `null`. */
export function getPrompt(store, id) {
  const target = String(id ?? '').trim()
  if (target === '') return null
  const row = store.get(
    `SELECT p.*, s.module AS module, s.name AS set_name, s.version AS set_version
       FROM prompt p JOIN prompt_set s ON s.id = p.set_id
      WHERE p.id = ? AND p.deleted_at IS NULL`,
    [target],
  )
  if (row === undefined || row === null) return null
  return { ...rowToPrompt(row), setName: row.set_name, setVersion: row.set_version }
}

/**
 * Every row of one (module, scenario), in order — **including disabled ones**.
 *
 * The `enabled = 1` filter used to live in this SQL. It moved out into the
 * production gate (`pickForProduction`) for one reason: a row this query dropped
 * could not be named in `skipped`, so a disabled prompt and a prompt that was
 * never configured looked exactly the same to the caller. The gate keeps the
 * filter's effect and adds the sentence that says why.
 */
function rowsFor(store, module, scenario) {
  return store.all(
    `SELECT p.*, s.module AS module
       FROM prompt p JOIN prompt_set s ON s.id = p.set_id
      WHERE s.module = ? AND p.scenario = ? AND p.deleted_at IS NULL
      ORDER BY p.sort_order, p.label`,
    [module, scenario],
  ).map(row => ({ ...rowToPrompt(row) }))
}

/** The set for one module, created if the store somehow lacks it. */
function ensureSet(store, module) {
  const existing = store.get('SELECT id FROM prompt_set WHERE module = ?', [module])
  if (existing !== undefined && existing !== null) return existing.id
  const id = randomUUID()
  store.run(
    'INSERT INTO prompt_set (id, module, name, version, note) VALUES (?, ?, ?, ?, ?)',
    [id, module, `${module} 的提示词`, PROMPT_SEED_VERSION, '由 amzn_prompt_upsert 新建（种子之外的模块）。'],
  )
  return id
}

/* ────────────────────────── 模块 11 F11-05：生命周期 ──────────────────────────
 *
 * 状态是**按版本**的：一条提示词的 v3 可以是 active，而它的 v4（刚编辑出来）还是
 * draft。`prompt` 表只有一行、`prompt.version` 是编辑计数，所以「这一行的状态」这句
 * 话表达不了两个版本各有各的状态。状态因此记在 `prompt_lifecycle_event` 里，按
 * (prompt_id, version) **只追加**；当前状态由「最新一条事件」推导。表与理由见 v38 迁移。
 *
 * ## 两道门，两个意思（不要把它们合成一个）
 *
 *   · `prompt.enabled`（0/1，行级）——「**整条提示词**关掉」。它跨版本：关掉之后
 *     v3 与 v4 一起不参与生产。用途是「这条先别用了」，与它走到哪一步无关。
 *   · `prompt_lifecycle_event.status`（版本级）——「**这个版本**走到生命周期哪一步」。
 *     同一行的另一个版本可以是别的状态。
 *
 * 生产要**两道都过**：`enabled = 1` 且「存在 active 版本」。两道都挡时两条都报出来，
 * 因为它们的修法不同（一道是勾选框，一道是走 review → testing → active）。
 *
 * ## 生产用的是**活动版本**的正文，不是当前行的正文
 *
 * 这是「编辑与激活分离」的落点。编辑一条 active 提示词会把它推进到 v4（draft），
 * 但生产**仍然**在用 v3 —— v3 是活动版本，它的正文在当时被冻结过，读得回来。所以
 * 「保存一次正文」不会改变生产交给 agent 的东西；改变它需要一个显式的激活。这也让
 * 「一键回滚到上一活动版本」成为一次纯状态变更（没有正文被写、没有历史被改）。
 */

/** One event row, in the shape the tools and the page consume. */
function rowToLifecycleEvent(row) {
  return {
    id: row.id,
    promptId: row.prompt_id,
    version: Number(row.version),
    status: row.status,
    at: row.at,
    by: row.by ?? null,
    note: row.note ?? null,
  }
}

/**
 * Every lifecycle event of one prompt, oldest first. Empty for an unknown id.
 *
 * The last tiebreak is `rowid`, **not** `id`: two events written in the same
 * millisecond have the same `at`, and ordering those by a random UUID would make
 * 「最新一条」 a coin flip — the fold that computes the current status would then
 * sometimes answer with the older of the two.
 */
export function promptLifecycleEvents(store, id) {
  const target = String(id ?? '').trim()
  if (target === '') return []
  return store.all(
    `SELECT id, prompt_id, version, status, at, by, note
       FROM prompt_lifecycle_event
      WHERE prompt_id = ?
      ORDER BY version ASC, at ASC, rowid ASC`,
    [target],
  ).map(rowToLifecycleEvent)
}

/**
 * `version -> 最新状态`, for every version that has at least one event.
 *
 * A version with no event is **absent** from the map rather than present as
 * `draft`: the callers that need a status use `promptLifecycleStatus`, which
 * supplies the initial state explicitly. Keeping "no events" out of the map is
 * what lets `activeVersionFromStatuses` answer "is there an active version"
 * without ever treating silence as `active`.
 */
export function promptLifecycleStatuses(store, id) {
  const out = new Map()
  for (const event of promptLifecycleEvents(store, id)) out.set(event.version, event.status)
  return out
}

/** The newest version whose latest status is `active`, or `null`. */
export function activeVersionFromStatuses(statuses) {
  let best = null
  for (const [version, status] of statuses) {
    if (!isPromptProductionStatus(status)) continue
    if (best === null || version > best) best = version
  }
  return best
}

/** The newest active version strictly below `before`, or `null`. */
export function previousActiveVersionFromStatuses(statuses, before) {
  let best = null
  for (const [version, status] of statuses) {
    if (!isPromptProductionStatus(status)) continue
    if (version >= before) continue
    if (best === null || version > best) best = version
  }
  return best
}

/**
 * The current status of one `(prompt, version)`.
 *
 * No event means `PROMPT_LIFECYCLE_INITIAL` (`draft`) — **silence is not a
 * licence**. A version nobody has judged is a draft, never `active`; the only
 * rows that start out active are the ones v38 wrote an explicit event for.
 */
export function promptLifecycleStatus(store, id, version) {
  const target = Number(version)
  if (!Number.isInteger(target)) {
    throw new Error(`prompt lifecycle needs an integer version — got ${JSON.stringify(version)}`)
  }
  return promptLifecycleStatuses(store, id).get(target) ?? PROMPT_LIFECYCLE_INITIAL
}

/* F11-09/W-D 顺手裁决：这里原本有一个 `activePromptVersion(store, id)`（B-11.3 建的）。
   它**已删除** —— 与其他「删除重复封装」的决定一样，理由不外乎重复；但这个还多一条：
   **接线会让生产代码变差。**

   它整个就是 `activeVersionFromStatuses(promptLifecycleStatuses(store, id))`。
   但生产代码里**每一个**真正需要活动版本的地方，都已经先拿到了 `statuses` 这张 Map
   （`promptLifecycleView`、`recordPromptLifecycle`、`rollbackPromptVersion`、
   `productionGate`、`pickForProduction` —— 共 7 处），于是直接调
   `activeVersionFromStatuses(statuses)`，**一次查询都不用多**。

   所以「接线」的代价是：在这些站点上把**手里已有的 Map** 换成再一次
   `promptLifecycleStatuses(store, id)` —— 每个调用点多一次库查询，换来的只是少写几个字符。
   一个方便调用方、而**没有一个调用方需要它**的函数。
   它此前唯一的读者是测试（`tests/b11-3-lifecycle.mjs` 4 处）—— 测试读者不算生产接线。

   ⚠️ **不要再把它加回来。** 需要某条提示词的活动版本时，先问「我手里有没有 `statuses`」：
   有就直接 `activeVersionFromStatuses(statuses)`；确实没有、又只想要那一个数，再自己
   写那两行 —— 写的时候你看得见自己多发了一次查询。 */

/**
 * One prompt's lifecycle, as the page and the tools read it.
 *
 * `next` is derived from the state machine rather than written here, so a caller
 * can draw one button per legal move without owning a second copy of the edges.
 * `previousActiveVersion` is present so 「一键回滚」 can say whether it would work
 * before it is clicked.
 */
export function promptLifecycleView(store, id) {
  const target = String(id ?? '').trim()
  if (target === '') return null
  const row = getPrompt(store, target)
  if (row === null) return null
  const statuses = promptLifecycleStatuses(store, target)
  const version = Number(row.version)
  const status = statuses.get(version) ?? PROMPT_LIFECYCLE_INITIAL
  const activeVersion = activeVersionFromStatuses(statuses)
  const previousActiveVersion = previousActiveVersionFromStatuses(statuses, version)
  return {
    id: target,
    version,
    status,
    statusLabel: PROMPT_LIFECYCLE_LABELS[status] ?? status,
    activeVersion,
    previousActiveVersion,
    /* 回滚只从**当前这一版是 active** 出发：没有在生产里的东西，就没有「退回
       上一活动版本」这回事。 */
    canRollback: isPromptProductionStatus(status) && previousActiveVersion !== null,
    next: promptLifecycleNextStates(status).map(state => ({
      status: state,
      label: PROMPT_LIFECYCLE_LABELS[state] ?? state,
    })),
    events: promptLifecycleEvents(store, target),
  }
}

/**
 * Record one transition, **validated against the state machine first**.
 *
 * The version must already exist (it may not be newer than the row's edit
 * counter) and must be an integer. `from` is the version's current status, so a
 * caller never supplies it — a caller-supplied `from` is a second opinion that
 * can disagree with the store.
 */
export function recordPromptLifecycle(store, { id, version, to, by = null, note = null } = {}) {
  const target = String(id ?? '').trim()
  if (target === '') throw new Error('recordPromptLifecycle needs a prompt id')
  const row = getPrompt(store, target)
  if (row === null) throw new Error(`no prompt ${target}`)

  const targetVersion = Number(version)
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error(`prompt lifecycle version must be an integer >= 1 — got ${JSON.stringify(version)}`)
  }
  if (targetVersion > Number(row.version)) {
    throw new Error(
      `prompt ${target} has only reached v${row.version}; v${targetVersion} does not exist`
      + ' — a status for a version that has no body would be a judgement about nothing',
    )
  }
  if (!isPromptLifecycleState(to)) {
    throw new Error(`unknown prompt lifecycle status "${to}" — known: ${PROMPT_LIFECYCLE_STATES.join(' / ')}`)
  }

  return store.tx(() => {
    const from = promptLifecycleStatus(store, target, targetVersion)
    /* 写入前先过状态机。放在 tx 里是为了让「读当前状态」与「写新事件」是同一件事的
       两半 —— 分开成两次事务，「读」之后「写」之前可以有另一次写入插进来，于是
       `from` 说的是一个已经不成立的状态。 */
    assertPromptTransition(from, to)
    const at = nowIso()
    store.run(
      `INSERT INTO prompt_lifecycle_event (id, prompt_id, version, status, at, by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), target, targetVersion, to, at, by, note],
    )
    const statuses = promptLifecycleStatuses(store, target)
    return {
      id: target,
      version: targetVersion,
      from,
      status: to,
      at,
      activeVersion: activeVersionFromStatuses(statuses),
      previousActiveVersion: previousActiveVersionFromStatuses(statuses, targetVersion),
    }
  })
}

/**
 * Activate the prompt's **current** version.
 *
 * A thin, named wrapper rather than a bare transition, for two reasons: the
 * requirement names 「激活新版本」 as its own act, and giving it its own action
 * means the audit can answer "who put this revision into production". The state
 * machine still decides whether the move is legal (`draft → active` is not; the
 * version has to have been through review and testing), so this cannot become a
 * back door around it.
 */
export function activatePromptVersion(store, { id, by = null, note = null } = {}) {
  const target = String(id ?? '').trim()
  if (target === '') throw new Error('activatePromptVersion needs a prompt id')
  const row = getPrompt(store, target)
  if (row === null) throw new Error(`no prompt ${target}`)
  return recordPromptLifecycle(store, { id: target, version: row.version, to: 'active', by, note })
}

/**
 * Roll production back to the prompt's previous active version. **One click, and
 * no body is written.**
 *
 * This is *not* `rollbackPrompt` (B-11.2b). That one restores a **body** from a
 * frozen snapshot and bumps the edit counter; this one moves **which version is
 * in production**, and the body it needs is already frozen and still readable.
 * Two different operations, two different tools, two different audits.
 *
 * It refuses unless the current version is itself `active`: 「回到上一活动版本」 is
 * a statement about production, and if the current version is not in production
 * there is nothing to come back *from*. It also refuses when there is no earlier
 * active version — a prompt whose first active version is the current one has
 * nowhere to go back to, and inventing one would be a rollback that rolled
 * nothing.
 *
 * The demoted version is recorded as `rolled_back` (a different fact from
 * `deprecated`: 「它被一个更早的活动版本顶掉了」 vs 「我不要它了」), and the earlier
 * version needs no new event — its latest status is already `active`, so it is
 * the active version again the moment the newer one leaves.
 */
export function rollbackPromptVersion(store, { id, by = null, note = null } = {}) {
  const target = String(id ?? '').trim()
  if (target === '') throw new Error('rollbackPromptVersion needs a prompt id')

  return store.tx(() => {
    const row = getPrompt(store, target)
    if (row === null) throw new Error(`no prompt ${target}`)
    /* 状态机是这条边的**唯一权威**。下面两条具体检查回答的是「为什么不能走」，
       但「能不能走」必须来自 `PROMPT_LIFECYCLE_EDGES` —— 否则把
       `active -> rolled_back` 这条边删掉，这条路径照样成功，边表就不再是
       「什么能走」的单一来源。
       2026-10-09 实测（B-11.3 验收探针 4）：只从内存里的边表删掉这条边，
       本函数仍然返回 `{to:1, status:'rolled_back'}` —— 它自己手写前置条件、
       从不查 `canTransition`。这正是本仓反复出现的「守卫没有守在它说守的地方」。 */
    assertPromptTransition('active', 'rolled_back')
    const current = Number(row.version)
    const statuses = promptLifecycleStatuses(store, target)
    const currentStatus = statuses.get(current) ?? PROMPT_LIFECYCLE_INITIAL
    if (!isPromptProductionStatus(currentStatus)) {
      throw new Error(
        `cannot roll back prompt ${target}: its current version v${current} is "${currentStatus}", not active`
        + ' — nothing from this prompt is in production, so there is no active version to roll back from',
      )
    }
    const previous = previousActiveVersionFromStatuses(statuses, current)
    if (previous === null) {
      throw new Error(
        `cannot roll back prompt ${target}: v${current} is the first active version`
        + ' — there is no earlier active version to go back to',
      )
    }
    const at = nowIso()
    store.run(
      `INSERT INTO prompt_lifecycle_event (id, prompt_id, version, status, at, by, note)
       VALUES (?, ?, ?, 'rolled_back', ?, ?, ?)`,
      [randomUUID(), target, current, at, by,
        note ?? `回滚：上一活动版本是 v${previous}`],
    )
    const after = promptLifecycleStatuses(store, target)
    return {
      id: target,
      rolledBackFrom: current,
      rolledBackTo: previous,
      activeVersion: activeVersionFromStatuses(after),
      status: 'rolled_back',
      at,
    }
  })
}

/**
 * 「哪一道门挡住的」的一句话，两道都挡时两句都在。
 *
 * 字段名（`enabled` / `status`）与层级（行级 / 版本级）都写进来，因为这两道门的
 * **修法**不同（一个勾选框 vs 走一遍 review → testing → active），只说「没生效」的话，
 * 读的人不知道该去动哪里。纯文本，不带 HTML —— 同一句话工具与页面都要用。
 */
function productionGateReason(gates, row, status) {
  const parts = []
  if (gates.includes('enabled')) {
    parts.push('整条提示词已停用（enabled = 0）—— 这是行级开关，与它走到哪一步无关')
  }
  if (gates.includes('status')) {
    parts.push(`它没有任何 active 版本（status 是版本级的那道门，v${row.version} 现在的状态是 "${status}"）`
      + ' —— 编辑与激活是两件事，保存一次正文不等于把它放进生产')
  }
  if (gates.includes('body')) {
    parts.push('它有一个 active 版本，但那一版的正文不在快照登记里 —— 取不回正文，'
      + '因此不把它当成生产提示词（这不是「没有配置提示词」）')
  }
  return parts.join('；')
}

/**
 * Which gates keep this row out of production, **named**, and the body it will
 * render if none of them do.
 *
 * `inProduction === true` means「每一道门都过了」. The gates are deliberately
 * separate fields rather than one boolean: they are fixed in different places
 * (one checkbox vs a review/testing/activate run vs a missing frozen body), so a
 * caller that only learns "it is off" cannot act on it.
 *
 * **Three gates, one computation.** `body` used to be checked only inside
 * `pickForProduction`, so the same fact had two answers: the resolver put the row
 * in `skipped` with `gates:['body']`, while `promptProductionGate` — the one the
 * page and the tools read — said `inProduction: true, gates: []`. The page showed
 * 「在产」 for a prompt the optimizer silently left out. Both views now come
 * through here, so the third gate is checked exactly once and the resolved body
 * travels back with it (reading it twice would be a second source for "which
 * version's body is production using").
 */
function productionGate(store, statuses, row) {
  const status = statuses.get(Number(row.version)) ?? PROMPT_LIFECYCLE_INITIAL
  const activeVersion = activeVersionFromStatuses(statuses)
  const gates = []
  if (row.enabled !== true) gates.push('enabled')
  if (activeVersion === null) gates.push('status')
  /* 活动版本**存在**不等于它的正文**取得回**：正文不在快照登记里时，生产拿到的是
     一个洞，而「洞」和「这一条选择了不说」长得一模一样 —— 所以它是一道门，不是
     一个兜底。 */
  const picked = activeVersion === null ? null : bodyForVersion(store, row, activeVersion)
  if (activeVersion !== null && picked === null) gates.push('body')
  return {
    status,
    activeVersion,
    gates,
    inProduction: gates.length === 0,
    reason: gates.length === 0 ? null : productionGateReason(gates, row, status),
    body: picked,
  }
}

/** `productionGate` for a caller that only has an id (the page, the tools). */
export function promptProductionGate(store, row) {
  return productionGate(store, promptLifecycleStatuses(store, row.id), row)
}

/**
 * The body of one version of a prompt row.
 *
 * The live row body when the version asked for *is* the current one; otherwise
 * the frozen `prompt` snapshot for that version (an edit froze the pre-image, so
 * an older active version's body is always on record). `null` when there is
 * nothing to read — never an empty string, because an empty body renders as a
 * button that says nothing and looks exactly like a prompt that chose to.
 */
function bodyForVersion(store, row, version) {
  if (Number(version) === Number(row.version)) return { body: row.body, source: 'live' }
  const frozen = store.get(
    `SELECT payload_json FROM snapshot_registry
      WHERE object_type = 'prompt' AND object_id = ? AND version = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [row.id, String(version)],
  )
  if (frozen === undefined || frozen === null) return null
  const payload = parseJson(frozen.payload_json, null)
  if (payload === null || typeof payload !== 'object' || typeof payload.body !== 'string') return null
  return { body: payload.body, source: 'frozen' }
}

/**
 * Resolve one row for the caller: either the body to render, or a named refusal.
 *
 * `includeInactive` is the editing/preview path. It skips both gates and renders
 * the **current** body (what the editor is looking at), handing back the status
 * so the page can label the row instead of hiding it. The default path answers
 * the production question and renders the **active version's** body.
 */
function pickForProduction(store, row, includeInactive) {
  const statuses = promptLifecycleStatuses(store, row.id)
  const status = statuses.get(Number(row.version)) ?? PROMPT_LIFECYCLE_INITIAL
  const activeVersion = activeVersionFromStatuses(statuses)

  if (includeInactive) {
    return {
      body: row.body,
      version: Number(row.version),
      bodySource: 'live',
      status,
      activeVersion,
      skipped: null,
    }
  }

  const gate = productionGate(store, statuses, row)
  if (!gate.inProduction) {
    return { skipped: {
      id: row.id,
      module: row.module,
      scenario: row.scenario,
      label: row.label,
      version: Number(row.version),
      status: gate.status,
      activeVersion: gate.activeVersion,
      gates: gate.gates,
      reason: gate.reason,
    } }
  }
  /* 走到这里 `gate.body` 必定不是 null —— 那正是第三道门（`body`）保证的事。正文与门
     来自**同一次**计算，所以「门说在产、正文却取不回」这种自相矛盾的结果不可能出现
     （它以前能出现：门只查两道，正文在别处另查一次）。

     这条不变量**在代码里**，不只在注释里：真有人把 `body` 那道门去掉时，这里抛一句
     说得出原因的话，而不是一个 `Cannot read properties of null` ——
     2026-10-09 的证伪实测就撞出了那个 TypeError，读的人得自己去猜是哪儿断的。 */
  const picked = gate.body
  if (picked === null) {
    throw new Error(`productionGate 说这一条在产，却没有给出正文（prompt ${row.id}）——`
      + ' `body` 那道门没有被应用。正文取不回时必须落进 skipped，不能静默当成在生产。')
  }
  return {
    body: picked.body,
    version: gate.activeVersion,
    bodySource: picked.source,
    status: 'active',
    activeVersion: gate.activeVersion,
    skipped: null,
  }
}

/**
 * The one resolver. Both the page and `amzn_optimize_prepare` call it.
 *
 * Buttons are the module's own rows followed by the shared `common` set's, in
 * that order — the composition the page has always drawn, kept because the order
 * is observable. `assemble` is the module's own rows, which carry a `layer`.
 *
 * Values are passed through to `renderTemplate` unchanged: the renderer adds and
 * removes nothing, so a caller that wants a default (「当前生效版本」) has to supply
 * it as the *value*, not as template text.
 *
 * ## Two gates, and a list that says who was kept out (F11-05)
 *
 * A prompt is used only when `enabled = 1` **and** it has an `active` version;
 * the body rendered is the **active version's**, not the row's current one, so
 * editing a prompt does not change production until someone activates the new
 * version. Everything excluded comes back in `skipped`, named, with its status
 * and the gate that stopped it — dropping it silently would make 「这条提示词没配」
 * and 「配了但没激活」 the same event, which is the one distinction this repo keeps
 * paying for.
 *
 * The default answers the production question. `includeInactive: true` is the
 * editing/preview opt-in: it returns every row (disabled included), carrying its
 * status, rendering the current body — and `skipped` is empty, because nothing
 * was skipped. A caller that forgets the flag gets the safe answer.
 *
 * @returns {{buttons: object[], assemble: object[], skipped: object[]}}
 */
export function resolvePrompts(store, options = {}) {
  const module = String(options.module ?? '').trim()
  const variables = options.variables !== null && typeof options.variables === 'object' ? options.variables : {}
  const includeInactive = options.includeInactive === true
  if (module === '') return { buttons: [], assemble: [], skipped: [] }

  const skipped = []
  const buttons = []
  const sources = module === PROMPT_COMMON_MODULE ? [module] : [module, PROMPT_COMMON_MODULE]
  for (const source of sources) {
    for (const row of rowsFor(store, source, 'button')) {
      const pick = pickForProduction(store, row, includeInactive)
      if (pick.skipped !== null) { skipped.push(pick.skipped); continue }
      buttons.push({
        id: row.id,
        label: row.label,
        text: renderTemplate(pick.body, variables),
        /* §5: 「必填变量缺失时…说明」. `text` is unchanged — this is the sentence
           that has to travel with it, so a caller that shows the button can also
           say the render was degraded. Added as a field so the existing
           consumers (module 13's `prepare`) keep working untouched. */
        missing: variableReport(pick.body, variables),
        /* 这一条正文来自哪一版、那一版的状态是什么。生产路径下 version 是**活动**
           版本（可能小于行上的编辑计数——那正是「编辑与激活分离」）。 */
        version: pick.version,
        bodySource: pick.bodySource,
        status: pick.status,
      })
    }
  }
  /* Layer order is the canonical `PROMPT_LAYERS`, not the insertion order. The seed happens to insert them in that order, but a user can save them in any order, and the assemble block reads as a document: fixed, then evidence, then contract. Sorting here means the order cannot drift with how the rows were edited. `sort_order` lives on the row (not on the pick), so the pairs are sorted before the entries are built.

     `version` rides along so the run's package can answer "which revision of the strategy did we hand over" — the same question `prompt.version` exists to answer. It is the **authoritative** version that was rendered (F11-05), not the row's edit counter. */
  const assembled = []
  for (const row of rowsFor(store, module, 'assemble')) {
    const pick = pickForProduction(store, row, includeInactive)
    if (pick.skipped !== null) { skipped.push(pick.skipped); continue }
    assembled.push({ row, pick })
  }
  assembled.sort((a, b) => PROMPT_LAYERS.indexOf(a.row.layer) - PROMPT_LAYERS.indexOf(b.row.layer)
    || a.row.sortOrder - b.row.sortOrder
    || a.row.label.localeCompare(b.row.label))
  const assemble = assembled.map(({ row, pick }) => ({
    id: row.id,
    layer: row.layer,
    label: row.label,
    version: pick.version,
    bodySource: pick.bodySource,
    status: pick.status,
    text: renderTemplate(pick.body, variables),
    missing: variableReport(pick.body, variables),
  }))
  return { buttons, assemble, skipped }
}

/**
 * Render a body (or a stored prompt's body) against a variable bag.
 *
 * A body that names a variable outside the closed set throws here — `{{typo}}`
 * must fail loudly rather than render as nothing, because a prompt that silently
 * dropped a word looks exactly like a prompt that chose not to say it. The tool
 * and the page's preview route both surface that error rather than swallowing it.
 *
 * ## The missing report (§5)
 *
 * 「必填变量缺失时停止或降级并说明，不能插入空字符串后假装完成」. The renderer's
 * semantics are unchanged — an empty value still renders as nothing — but a caller
 * that only received `text` would have no way to tell a degraded render from a
 * clean one: the hole in the middle of the sentence reads like the prompt chose
 * to say nothing. So the answer carries `missing_required` (name + business
 * meaning + source), `degraded` and a `reason` sentence. `text` is untouched.
 *
 * @returns {{text: string, variables: string[], missing_required: object[],
 *            dropped_optional: object[], degraded: boolean, reason: string|null}}
 */
export function previewPrompt(store, options = {}) {
  let source = options.body
  if (source === undefined || source === null || String(source) === '') {
    const id = String(options.id ?? '').trim()
    if (id === '') throw new Error('give either a prompt id or a body to preview')
    const row = getPrompt(store, id)
    if (row === null) throw new Error(`no prompt ${id}`)
    source = row.body
  }
  const text = String(source)
  const variables = options.variables !== null && typeof options.variables === 'object' ? options.variables : {}
  const report = variableReport(text, variables)
  /* T73 严格渲染器（生产调用点）：先按注册表的三态缺失行为渲染一次 ——
     缺必填会抛 `MISSING_REQUIRED`，配对缺失会抛 `PAIR_MISSING`，内联 omit 会抛
     `OMIT_INLINE`。预览**不能因此崩掉**（用户正是在这里看「为什么不能发布」），
     所以抛了就退回旧渲染器，把「拒绝渲染的理由」放进 `refused` 交给页面显示；
     旧渲染器的输出仍然给出来，因为「降级后长什么样」本身也是用户要看的信息。
     两个都印，比只印一个更像实话。 */
  let strict = null
  let refused = null
  try {
    strict = renderPromptWithReport(text, variables, { checkPairs: true })
  } catch (error) {
    if (typeof error?.code !== 'string' || !/^(MISSING_REQUIRED|PAIR_MISSING|OMIT_INLINE|OVER_LIMIT|TYPE_MISMATCH)$/.test(error.code)) throw error
    refused = { code: error.code, message: error.message, missingNamed: error.missingNamed ?? [] }
  }
  return {
    text: strict === null ? renderTemplate(text, variables) : strict.text,
    variables: report.referenced,
    /* 快照：这些是渲染出 `text` 的那一组值，缺了谁、它是什么、从哪来。 */
    missing_required: report.missingRequired,
    dropped_optional: report.droppedOptional,
    usage: report.usage,
    degraded: report.degraded,
    reason: report.reason,
    /* T73 新字段：严格渲染器的判定与产物。`refused` 非空 = 这段提示词**不能按注册表渲染**。 */
    refused,
    strict: strict === null ? null : { placeholders: strict.report.placeholderNames ?? [], truncated: strict.report.truncated ?? [] },
    pair_missing: report.pairMissing,
    placeholders: report.placeholders,
  }
}

/**
 * Freeze one prompt row's current body, versioned by its own edit counter.
 *
 * `version = String(row.version)` — the **pre-write** counter, not a fresh label
 * and not a date. `prompt.version` goes up by exactly one per write and this is
 * called before each one, so the frozen versions are exactly `1,2,3,…`, each
 * used once. `registerSnapshot` refuses a `(object_type, object_id, version)`
 * collision, which makes that invariant a free assertion rather than a promise.
 *
 * `payload`, never `refId`: the row this points at is overwritten in place, so a
 * pointer would follow the next edit and freeze nothing.
 */
function freezePromptRow(store, row, note) {
  registerSnapshot(store, {
    objectType: 'prompt',
    objectId: row.id,
    version: String(row.version),
    payload: {
      body: row.body,
      label: row.label,
      layer: row.layer,
      scenario: row.scenario,
      variables_json: row.variables_json,
      enabled: row.enabled,
      updated_at: row.updated_at,
    },
    note,
  })
}

/**
 * The one validator both writers cross.
 *
 * `upsertPrompt` and `rollbackPrompt` must refuse exactly the same records: the
 * second writes a body that was frozen by the first, so a rule that held on save
 * but not on rollback was never a rule. Everything a caller can get wrong is
 * refused **by name**: an unknown module, an unknown scenario, an `assemble` row
 * with no (or a wrong) layer, a `button` row that carries a layer, an empty
 * label, an empty body, and a body that does not parse. `variables_json` is the
 * parser's answer, derived from `body` — never taken from the caller, because a
 * hand-passed variable list is exactly the second copy that goes stale.
 *
 * `enabled` is **normalized** here, not passed through: the column is a 0/1 flag
 * (`rowsFor` reads `enabled = 1`), and a snapshot that froze `enabled: 9` would
 * otherwise write 9 back and silently disable the row. A rule that only half the
 * writers run is not a rule, so the normalization lives with the rest of them.
 *
 * @returns {{module: string, scenario: string, layer: string|null, label: string,
 *            body: string, variablesJson: string, enabled: 0|1}} the normalized record
 */
function validatePromptFields(record = {}) {
  const module = String(record.module ?? '').trim()
  if (module === '') throw new Error('module is required')
  if (!PROMPT_MODULES.includes(module)) {
    throw new Error(`unknown module "${module}" — a prompt for a module the page cannot show would never be read`)
  }

  const scenario = String(record.scenario ?? '').trim()
  if (!PROMPT_SCENARIOS.includes(scenario)) {
    throw new Error(`unknown scenario "${scenario}" — the closed set is ${PROMPT_SCENARIOS.join(' / ')}`)
  }

  const layerText = record.layer === null || record.layer === undefined ? '' : String(record.layer).trim()
  const layer = layerText === '' ? null : layerText
  if (scenario === 'assemble') {
    if (layer === null || !PROMPT_LAYERS.includes(layer)) {
      throw new Error(`an assemble prompt needs a layer in ${PROMPT_LAYERS.join(' / ')}`
        + (layer === null ? '' : ` — got "${layer}"`))
    }
  } else if (layer !== null) {
    throw new Error(`a button prompt has no layer — got "${layer}"`)
  }

  const label = String(record.label ?? '').trim()
  if (label === '') throw new Error('label is required — an unnamed button is unclickable')
  const body = String(record.body ?? '')
  if (body.trim() === '') throw new Error('body is required — an empty prompt is a button that says nothing')

  /* The template is validated here, at the boundary every caller passes, not only
     in the editor. `variables_json` is the parser's answer, derived — never taken
     from the caller. */
  let variables
  try {
    variables = templateVariables(body)
  } catch (error) {
    throw new Error(`prompt body does not parse: ${error.message}`)
  }

  /* `enabled` is a 0/1 flag in the table. A caller passes a boolean (`false` = off);
     a frozen payload carries the stored 0/1. Normalize both here so a snapshot that
     froze `enabled: 9` cannot write 9 back and silently disable the row. */
  const enabled = record.enabled === false || record.enabled === 0 ? 0 : 1

  return { module, scenario, layer, label, body, variablesJson: JSON.stringify(variables), enabled }
}

/**
 * Create or update one prompt.
 *
 * Everything a caller can get wrong is refused **by name** (see
 * `validatePromptFields`): an unknown module, an unknown scenario, an `assemble`
 * row with no (or a wrong) layer, a `button` row that carries a layer, an empty
 * label, an empty body, and a body that does not parse. Nothing is written until
 * all of that has passed, so a bad edit leaves the library exactly as it was.
 *
 * Omitting `id` inserts a new row at the end of its (module, scenario). Passing
 * an `id` updates that row and bumps its `version` — the count of times the row
 * has moved, so a reader can tell a first draft from a tenth revision.
 *
 * @param {{id?: string, module: string, scenario: string, layer?: string, label: string,
 *          body: string, enabled?: boolean}} record
 * @returns {object} the stored row, plus `created`
 */
export function upsertPrompt(store, record = {}) {
  const { module, scenario, layer, label, body, variablesJson, enabled } = validatePromptFields(record)

  const id = String(record.id ?? '').trim()

  return store.tx(() => {
    if (id === '') {
      const setId = ensureSet(store, module)
      const maxOrder = Number(store.get(
        'SELECT COALESCE(MAX(sort_order), -1) AS n FROM prompt WHERE set_id = ? AND scenario = ?',
        [setId, scenario],
      )?.n ?? -1)
      const newId = randomUUID()
      store.run(
        `INSERT INTO prompt
           (id, set_id, scenario, layer, label, body, variables_json, version, sort_order, enabled, deleted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)`,
        [newId, setId, scenario, layer, label, body, variablesJson, maxOrder + 1, enabled, nowIso()],
      )
      return { ...getPrompt(store, newId), created: true }
    }

    const existing = store.get('SELECT * FROM prompt WHERE id = ? AND deleted_at IS NULL', [id])
    if (existing === undefined || existing === null) throw new Error(`no prompt ${id}`)
    /* 冻结**被这次保存替换掉的那一版正文**。必须在 UPDATE 之前 —— 之后读到的就是
       新正文，冻结下来的会是它自己。`payload` 而不是 `refId`：`prompt.body` 是就地
       覆盖的，指针只会指向已经变掉的那一行（snapshot.js 的列注释：payload 给可变对象）。 */
    freezePromptRow(store, existing, '保存前冻结')
    store.run(
      `UPDATE prompt
          SET scenario = ?, layer = ?, label = ?, body = ?, variables_json = ?,
              version = version + 1, enabled = ?, updated_at = ?
        WHERE id = ?`,
      [scenario, layer, label, body, variablesJson, enabled, nowIso(), id],
    )
    return { ...getPrompt(store, id), created: false }
  })
}

/** Counts for the page's chips: how many rows, of each scenario, and how many off. */
export function promptStats(store) {
  const rows = store.all('SELECT scenario, layer, enabled FROM prompt WHERE deleted_at IS NULL')
  const stats = { total: rows.length, button: 0, assemble: 0, disabled: 0, sets: 0 }
  for (const row of rows) {
    if (row.scenario === 'button') stats.button += 1
    if (row.scenario === 'assemble') stats.assemble += 1
    if (row.enabled !== 1) stats.disabled += 1
  }
  stats.sets = Number(store.get('SELECT COUNT(*) AS n FROM prompt_set')?.n ?? 0)
  return stats
}

/**
 * The frozen bodies of one prompt, newest first. Read-only.
 *
 * This is the version history `prompt.version` only *counts*. Each row is one
 * body as it was **before** a save, keyed by the edit counter it replaced. The
 * counter and the frozen set are **not** the same number: creating a row freezes
 * nothing, so `frozen = version − 1` (see the module header), and a row saved
 * before B-11.2b can have even fewer.
 *
 * Three counts, each named for exactly what it is so none is read as another:
 *
 *   - `matched` — this prompt's frozen versions **shown** by default (archived
 *     ones hidden), i.e. how many `rows` there would be with no cap;
 *   - `matchedAll` — this prompt's frozen versions **including archived ones**.
 *     An archived version is still a rollback target (`getSnapshot` resolves it),
 *     so this is the true "how many old drafts can I roll back to";
 *   - `tableTotal` — the whole `snapshot_registry`. The name carries `table`
 *     because a bare `total` here was read as this object's count while it was
 *     the table's.
 *
 * @returns {{id: string, rows: object[], matched: number, matchedAll: number,
 *            tableTotal: number, limit: number}}
 */
export function promptHistory(store, { id, includeArchived = false, limit = PROMPT_HISTORY_LIMIT } = {}) {
  const target = String(id ?? '').trim()
  /* The early return carries the **same field set** as the normal one, zeros and
     all — a different shape for "no id" is a second contract the caller has to
     remember, and the one place it is forgotten is the one that reads `undefined`. */
  if (target === '') {
    return { id: target, rows: [], matched: 0, matchedAll: 0, tableTotal: 0, limit }
  }
  const list = listSnapshots(store, { objectType: 'prompt', objectId: target, includeArchived, limit })
  /* Archived versions are counted, not hidden: archiving a frozen body must not
     make the total quietly shrink with nothing saying so. When the caller already
     asked for archived rows the first call is the whole set. */
  const all = includeArchived
    ? list
    : listSnapshots(store, { objectType: 'prompt', objectId: target, includeArchived: true, limit: 1 })
  return {
    id: target,
    rows: list.rows.map(row => ({
      id: row.id,
      version: row.version,
      createdAt: row.createdAt,
      note: row.note,
      archivedAt: row.archivedAt,
      /* A pointer snapshot freezes no body; `null` says so rather than inventing one. */
      body: row.payload !== null && typeof row.payload === 'object' ? (row.payload.body ?? null) : null,
    })),
    matched: list.matched,
    matchedAll: all.matched,
    tableTotal: list.total,
    limit: list.limit,
  }
}

/**
 * Roll one prompt's body back to a frozen version. A **new edit**, not an erasure.
 *
 * Four refusals, each by name, because each one silently writing would be worse
 * than an error:
 *
 *   - the snapshot does not exist;
 *   - the snapshot freezes a **different** object (another prompt, or another
 *     kind) — writing one prompt's body into another is the worst outcome here;
 *   - the snapshot freezes **no body** (a pointer snapshot) — there is nothing to
 *     restore, and succeeding quietly would claim a rollback that did not happen;
 *   - the frozen body **does not pass the same validation a save does** (unknown
 *     scenario, a button carrying a layer, an empty label, a body that does not
 *     parse). A frozen body is a body: letting it reach the table because it
 *     arrived through a snapshot would let a hand-inserted bad row write back a
 *     body `renderTemplate` then throws on, and the whole `/state` route with it.
 *
 * `variables_json` is re-derived from the restored body, never copied from
 * `payload.variables_json` — the same rule as `upsertPrompt`, because the stored
 * variable list is the parser's answer and a frozen one is a stale second copy.
 *
 * On success the pre-rollback body is itself frozen first, then the row is
 * updated and its counter goes **up**. So a rollback never removes a version:
 * the body you rolled back *from* is still readable, which is what makes a
 * second rollback (back to where you were) possible.
 *
 * @returns {object} the stored row, plus `rolledBackFrom` (the version replaced)
 *   and `restoredVersion` (the frozen version whose body was written back)
 */
export function rollbackPrompt(store, { id, snapshotId } = {}) {
  const target = String(id ?? '').trim()
  if (target === '') throw new Error('rollbackPrompt needs a prompt id')
  const snapId = String(snapshotId ?? '').trim()
  if (snapId === '') throw new Error('rollbackPrompt needs a snapshotId')

  return store.tx(() => {
    const snapshot = getSnapshot(store, snapId)
    if (snapshot === null) throw new Error(`no snapshot ${snapId}`)
    if (snapshot.objectType !== 'prompt' || snapshot.objectId !== target) {
      throw new Error(
        `snapshot ${snapId} freezes ${snapshot.objectType}/${snapshot.objectId}, not prompt/${target}`
        + ' — refusing to write one prompt\'s body into another',
      )
    }
    const payload = snapshot.payload
    if (payload === null || typeof payload !== 'object' || typeof payload.body !== 'string') {
      throw new Error(
        `snapshot ${snapId} freezes no body (a pointer snapshot freezes nothing) — there is nothing to roll back to`,
      )
    }

    /* `module` is not frozen (a row cannot change its module — the set owns it),
       so it comes from the row that is there, never invented from the payload. */
    const existing = store.get(
      `SELECT p.*, s.module AS module
         FROM prompt p JOIN prompt_set s ON s.id = p.set_id
        WHERE p.id = ? AND p.deleted_at IS NULL`,
      [target],
    )
    if (existing === undefined || existing === null) throw new Error(`no prompt ${target}`)

    /* Validate before anything is written. `payload.scenario ?? existing.scenario`
       and friends keep a snapshot that predates a field readable, but every value
       still has to clear the same gate a save does — including `enabled`, which
       `validatePromptFields` normalizes to 0/1 so a frozen 9 cannot disable the row
       silently. */
    const fields = validatePromptFields({
      module: existing.module,
      scenario: payload.scenario ?? existing.scenario,
      layer: payload.layer ?? null,
      label: payload.label ?? existing.label,
      body: payload.body,
      enabled: payload.enabled ?? existing.enabled,
    })

    freezePromptRow(store, existing, '回滚前冻结')
    store.run(
      `UPDATE prompt
          SET scenario = ?, layer = ?, label = ?, body = ?, variables_json = ?,
              version = version + 1, enabled = ?, updated_at = ?
        WHERE id = ?`,
      [
        fields.scenario,
        fields.layer,
        fields.label,
        fields.body,
        fields.variablesJson,
        fields.enabled,
        nowIso(),
        target,
      ],
    )
    return {
      ...getPrompt(store, target),
      rolledBackFrom: existing.version,
      restoredVersion: snapshot.version,
    }
  })
}

/* ══ F11-07 固定评估集 ══════════════════════════════════════════════════════════
 *
 * 权威要求（RESEARCH §3.11 F11-07）：八类覆盖样例 + 口径陷阱样例，每条的期望行为是
 * 「指出问题或拒绝下结论」。
 *
 * ## 这一层刻意**不评估**
 *
 * 本插件没有 LLM 通道，无法自动判定「这条样例通过/不通过」。所以这里**只有读与写**：
 * 写 = 把评估集内容存进去；读 = 把它取出来给人看。
 * **没有**「跑评估」「算通过率」这类函数 —— 那需要一个不存在的评估器。
 * 本仓的规矩：**没有产生者的数字不造**。将来真有评估器，它带来的是一张**结果表**（新迁移），
 * 而不是把结果塞进现有的 `expected` 列里 —— 那样「期望」与「结果」就混成了一个字段，
 * 「还没跑过」会被读成「跑过了」。
 *
 * ## 与「夹具不许从选择器派生」的关系（任务书 §7）
 *
 * 评估集的 `input_json` 是**人写死的固定输入**。它不从任何页面、任何选择器、任何当前数据
 * 派生 —— 所以它不可能与被评估的代码「一起漂移」。这正是评估集存在的意义：
 * 它是**先于**被测对象写下的。
 */

/** 一个集合版本的样例，按集合内顺序。`null` 表示没有这个集合版本。 */
export function listEvalCases(store, setId, version) {
  const targetId = String(setId ?? '').trim()
  if (targetId === '') return null
  const set = getEvalSet(store, targetId, version)
  if (set === null) return null
  const rows = store.all(
    `SELECT * FROM prompt_eval_case
      WHERE set_id = ? AND set_version = ?
      ORDER BY case_index ASC`,
    [targetId, set.version],
  )
  return rows.map(rowToEvalCase)
}

/**
 * 一个评估集版本，或 `null`。
 *
 * `version` 缺省时取该集合**最新**的版本 —— 按 `created_at` 再按 `version` 兜底，
 * 因为同一毫秒内建的两个版本 `created_at` 会撞，那时用随机 UUID 排序等于掷硬币
 * （与 `prompt_lifecycle_event` 索引注释同一条规矩）。
 */
export function getEvalSet(store, setId, version = null) {
  const targetId = String(setId ?? '').trim()
  if (targetId === '') return null
  if (version !== null && version !== undefined && String(version).trim() !== '') {
    const row = store.get('SELECT * FROM prompt_eval_set WHERE id = ? AND version = ?', [
      targetId,
      String(version).trim(),
    ])
    return row === undefined || row === null ? null : rowToEvalSet(row)
  }
  const row = store.get(
    'SELECT * FROM prompt_eval_set WHERE id = ? ORDER BY created_at DESC, version DESC LIMIT 1',
    [targetId],
  )
  return row === undefined || row === null ? null : rowToEvalSet(row)
}

/**
 * 全部评估集，每个带样例数与**类别分布**。
 *
 * `caseCount` 与 `isEmpty` **两个都给**：0 个样例时 `isEmpty` 为真。
 * 这是本仓「五态必须分开说」的落地 —— 调用方拿到 `caseCount: 0` 时无从分辨
 * 「这个集合是空的」与「我查错了集合」，而 `isEmpty` 是集合自己说的。
 */
export function listEvalSets(store) {
  const sets = store.all('SELECT * FROM prompt_eval_set ORDER BY created_at DESC, id ASC, version DESC')
  return sets.map(row => {
    const set = rowToEvalSet(row)
    const counts = store.all(
      `SELECT category, COUNT(*) AS n FROM prompt_eval_case
        WHERE set_id = ? AND set_version = ?
        GROUP BY category ORDER BY category ASC`,
      [set.id, set.version],
    )
    const caseCount = counts.reduce((sum, entry) => sum + Number(entry.n), 0)
    return {
      ...set,
      caseCount,
      /* 分开说：0 条样例是一个**发现**，不是一个错误。 */
      isEmpty: caseCount === 0,
      categories: counts.map(entry => ({ category: entry.category, count: Number(entry.n) })),
    }
  })
}

/**
 * 写入（或按内容覆盖）一个评估集版本。返回落库后的集合。
 *
 * 覆盖语义：同一 `(setId, version)` 再导一次 = **整份替换**该版本的样例
 * （先删该版本全部样例，再插新的），一次事务里做完 —— 否则半份新半份旧，
 * 而「评估集里到底有几条、都是什么」会变成没人能回答的问题。
 */
export function importEvalSet(store, { setId, version, title, category, note = null, cases } = {}) {
  const targetId = requireNonEmpty(setId, 'setId')
  const targetVersion = requireNonEmpty(version, 'version')
  const targetTitle = requireNonEmpty(title, 'title')
  const targetCategory = requireNonEmpty(category, 'category')
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('评估集至少要有一条样例（cases 为空）—— 一条不留的「评估集」不是评估集')
  }
  const seen = new Set()
  const prepared = cases.map((entry, index) => {
    const caseId = requireNonEmpty(entry?.caseId, `cases[${index}].caseId`)
    if (seen.has(caseId)) throw new Error(`样例 id 重复: ${caseId}（同一集合里 id 必须唯一）`)
    seen.add(caseId)
    const expected = requireNonEmpty(entry?.expected, `样例 ${caseId} 的 expected`)
    const input = entry?.input
    if (input === undefined || input === null) {
      throw new Error(`样例 ${caseId} 缺 input —— 没有输入的评估样例只是一句期望`)
    }
    const expectRules = entry?.expectRules
    if (expectRules !== undefined && expectRules !== null && !Array.isArray(expectRules)) {
      throw new Error(`样例 ${caseId} 的 expectRules 必须是数组`)
    }
    return {
      caseId,
      index: Number.isInteger(entry?.caseIndex) ? entry.caseIndex : index + 1,
      category: String(entry?.category ?? targetCategory).trim() || targetCategory,
      inputJson: JSON.stringify(input),
      expected,
      /* 空数组 = 「这条样例不检查规则命中」，与「检查了没命中」是两回事，
         所以原样存 `[]`，不把它折成 null。 */
      expectRulesJson: JSON.stringify(Array.isArray(expectRules) ? expectRules.map(String) : []),
    }
  })
  const now = nowIso()
  return store.tx(() => {
    store.run(
      `INSERT INTO prompt_eval_set (id, version, title, category, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id, version) DO UPDATE SET title = excluded.title,
                                               category = excluded.category,
                                               note = excluded.note`,
      [targetId, targetVersion, targetTitle, targetCategory, note === null ? null : String(note), now],
    )
    /* 整份替换：先删该版本的全部样例，再插新的。与 `recomputeMaster` 同一套路数 ——
       但这里没有「人工决定」会被抹掉，因为样例就是内容本身，重导入 = 换内容。 */
    store.run('DELETE FROM prompt_eval_case WHERE set_id = ? AND set_version = ?', [targetId, targetVersion])
    for (const entry of prepared) {
      store.run(
        `INSERT INTO prompt_eval_case
           (id, set_id, set_version, case_index, category, input_json, expected, expect_rules_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.caseId,
          targetId,
          targetVersion,
          entry.index,
          entry.category,
          entry.inputJson,
          entry.expected,
          entry.expectRulesJson,
          now,
        ],
      )
    }
    return { set: getEvalSet(store, targetId, targetVersion), imported: prepared.length, replaced: true }
  })
}

/** 上面的写入器共用的空值检查 —— 报错点名是哪个字段。 */
function requireNonEmpty(value, field) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error(`${field} 不能为空`)
  return text
}

function rowToEvalSet(row) {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    category: row.category,
    note: row.note === null || row.note === undefined ? null : row.note,
    createdAt: row.created_at,
  }
}

function rowToEvalCase(row) {
  return {
    caseId: row.id,
    setId: row.set_id,
    setVersion: row.set_version,
    caseIndex: row.case_index,
    category: row.category,
    /* `input` 解析回对象给调用方用；解析失败时**不吞**，让坏数据立刻可见 ——
       经本文件的写入器进去的一定是可解析的 JSON，解析不了说明有人绕过写入器直插了库。 */
    input: JSON.parse(row.input_json),
    expected: row.expected,
    expectRules: parseJson(row.expect_rules_json, []),
    createdAt: row.created_at,
  }
}

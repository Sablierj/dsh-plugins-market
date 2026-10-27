/**
 * 模块 11 F11-09：引用追踪 —— 「这条提示词被哪些运行用过？」
 *
 * ## 这一批要解决的
 *
 * 在 F11-09 之前，这个仓库的形态是「**有出口、没有闭环**」：运行侧把 Prompt 文本
 * 与行版本都存进了库（`optimization_run.package_json.prompts`、
 * `agent_run.prompts_snapshot_json`），但 Prompt 侧**查不到被谁用**。结果是提示词
 * 改坏了以后，没有人能回答「这一改动会影响哪些已有报告」。
 *
 * ## ⚠️ 两种运行记的东西**不一样**，这个差别必须由数据类型承载，不能靠注释
 *
 * 这是本模块最容易做成「假答案」的地方：
 *
 *   · **optimize run** 的 `package_json.prompts[]` 每一层存了
 *     `{ layer, label, version, text }`，其中 `version` 来自 `resolvePrompts` →
 *     `pick.version`，是**活动版本的权威版本号**（F11-05 的落点，不是编辑计数）。
 *     ⇒ 它能定位到**具体版本**。证据等级：`version`。
 *
 *   · **agent run** 的 `prompts_snapshot_json` 存的是
 *     `{ sets: [{ id, module, version }], count }`，看起来也有 `version` ——
 *     但那个 `version` 是 **`prompt_set.version`，而全仓 `UPDATE prompt_set` 出现
 *     0 次**（F11-09 摸底实测），即它永远是种子时的初始值。用它去回答「这一次运行
 *     用的是第几版」会给出一个**看起来具体、实际从不更新**的数字。
 *     ⇒ 它只能定位到**集合**。证据等级：`set`。
 *
 * 把两者都写成「有 version」就等于把缺失渲染成真实值 —— 而这个仓库为这一类错误
 * 已经付过代价（13 节的 `variations`、B-12.2 的重试率）。所以 `match` 这个字段
 * 只有两个值，且**逐条**标出是哪一种；`versionKnown: false` 的那些，
 * `version` 一律是 `null`，**不给替代值**。
 *
 * ## 为什么 optimize 的反查是「扫包」而不是 SQL JOIN
 *
 * `optimization_run` 表**没有** prompt/prompt_set 列（只有 `rules_version` /
 * `package_json` 等）。所以反查只能解析 `package_json` 里的 `prompts[]`。代价是
 * 全表扫描，收益是**不需要迁移**——「不动 schema 也做得到」在这个仓库是硬约束
 * （新增一列会让每一条读 prompt 的语句都要跟着改）。
 *
 * 但扫描要有个上限，否则一个跑了半年的库会把页面拖死。上限落在
 * `PROMPT_REFERENCE_SCAN_LIMIT`，且**被扫过多少、命中多少必须分开报**，
 * 否则「3 条引用」既可能是「真的只有 3 条」也可能是「只扫了前 3 条」。
 */

/** How many runs the reverse lookup reads, newest first. */
export const PROMPT_REFERENCE_SCAN_LIMIT = 2000

/** The only two answers this lookup is allowed to give about a version. */
export const PROMPT_REFERENCE_MATCHES = ['version', 'set']

/**
 * Did this run pin a concrete prompt version, or only name a set?
 *
 * `version` means the run stored the authoritative rendered version number and can
 * therefore be pointed at "which revision was in production for this run".
 * `set` means the run only recorded the set it drew from, and the version it also
 * stored is `prompt_set.version` — a column this repository never updates.
 *
 * These are **not** two degrees of the same measurement. `version` is a fact about
 * the run; `set` is a fact about the run's *input selection* and says nothing about
 * which text was rendered. Keeping them as two named values is what stops a caller
 * from averaging them into "we know the version for most runs".
 */
export function referenceMatchMeaning(match) {
  if (match === 'version') {
    return '这一次运行定格了**活动版本的权威版本号**，能回答「用的是第几版」。'
  }
  if (match === 'set') {
    return '这一次运行只记了**取自哪个集合**；它同行的 `prompt_set.version` 在本仓库从不更新，'
      + '所以**无法**回答「用的是第几版」。'
  }
  throw new Error(`unknown match kind ${match}`)
}

/**
 * One layer of an optimize run's frozen prompt package, or `null` if the run predates it.
 *
 * Returns `{ label, version, layer }` per layer with `version` as a **number or null**.
 * A run written before the package carried prompts has no `prompts` array at all —
 * that is `null` here, distinct from an empty array (a run that carried prompts and
 * happened to render none).
 */
function runPromptLayers(packageJson) {
  if (packageJson === null || packageJson === undefined || packageJson === '') return null
  let pkg = null
  try {
    pkg = typeof packageJson === 'string' ? JSON.parse(packageJson) : packageJson
  } catch {
    return null
  }
  if (pkg === null || typeof pkg !== 'object') return null
  const prompts = pkg.prompts
  if (!Array.isArray(prompts)) return null
  return prompts.map(entry => ({
    layer: entry?.layer ?? null,
    label: entry?.label ?? null,
    version: Number.isInteger(entry?.version) ? entry.version : null,
  }))
}

/**
 * The prompt-set ids an agent run pinned, plus the version it claimed for each.
 *
 * Returned with `versionNeverUpdated: true` on every entry for one reason: the
 * caller that renders this **must** be handed the reason the version is unusable
 * rather than a bare number it might print. See the module comment.
 */
function runPromptSets(promptsSnapshotJson) {
  if (promptsSnapshotJson === null || promptsSnapshotJson === undefined || promptsSnapshotJson === '') return null
  let snap = null
  try {
    snap = typeof promptsSnapshotJson === 'string' ? JSON.parse(promptsSnapshotJson) : promptsSnapshotJson
  } catch {
    return null
  }
  if (snap === null || typeof snap !== 'object') return null
  const sets = snap.sets
  if (!Array.isArray(sets)) return null
  return sets.map(entry => ({
    setId: entry?.id ?? null,
    module: entry?.module ?? null,
    /* Kept, but alongside the flag that says why it must not be read as a
       revision — dropping it would lose the record of what the run stored.
       `prompt_set.version` is a TEXT column (schema v13), so this is the raw
       stored value, not a parsed number: coercing it would invent a type the
       schema does not have. */
    setVersion: entry?.version ?? null,
    versionNeverUpdated: true,
  }))
}

/**
 * One pass over the runs, indexed so the page can ask about EVERY prompt row
 * without re-scanning.
 *
 * ## Why this exists as a separate step
 *
 * The page renders all ~44 prompt rows at once. Calling `promptReferences` per row
 * would scan up to `PROMPT_REFERENCE_SCAN_LIMIT` runs 44 times — 44 × 4000 row
 * parses on every state request. That is not a hypothetical: it is the shape of
 * the trap this repository has already paid for twice (a per-row query inside a
 * list render). So the scan is done **once** and the result is indexed.
 *
 * The two indexes are keyed differently on purpose, because the two run kinds
 * record different things:
 *   · `byLabel`  — `module\u0000label` → optimize runs. Matched on label because a
 *                  run's package stores the label it rendered, not the row id.
 *   · `bySetId`  — agent runs, matched on the set id they pinned.
 */
export function scanPromptReferences(store, options = {}) {
  const limit = Number.isInteger(options?.limit) && options.limit > 0
    ? options.limit
    : PROMPT_REFERENCE_SCAN_LIMIT

  const byLabel = new Map()
  const bySetId = new Map()

  const optimizeRows = store.all(
    `SELECT id, asin, marketplace, status, started_at, package_json
       FROM optimization_run
      ORDER BY started_at DESC, id DESC
      LIMIT ?`,
    [limit],
  )
  let optimizeScanned = 0
  let optimizeCarriedPrompts = 0
  for (const row of optimizeRows) {
    optimizeScanned += 1
    const layers = runPromptLayers(row.package_json)
    if (layers === null) continue
    optimizeCarriedPrompts += 1
    for (const layer of layers) {
      if (layer.label === null) continue
      const key = `${OPTIMIZE_PACKAGE_MODULE}\u0000${layer.label}`
      if (!byLabel.has(key)) byLabel.set(key, [])
      byLabel.get(key).push({
        kind: 'optimize',
        runId: row.id,
        asin: row.asin,
        marketplace: row.marketplace,
        status: row.status,
        startedAt: row.started_at,
        layer: layer.layer,
        version: layer.version,
        matchedOn: 'label',
      })
    }
  }

  const agentRows = store.all(
    `SELECT id, role, status, started_at, prompts_snapshot_json
       FROM agent_run
      ORDER BY started_at DESC, id DESC
      LIMIT ?`,
    [limit],
  )
  let agentScanned = 0
  for (const row of agentRows) {
    agentScanned += 1
    const sets = runPromptSets(row.prompts_snapshot_json)
    if (sets === null) continue
    for (const set of sets) {
      if (set.setId === null) continue
      if (!bySetId.has(set.setId)) bySetId.set(set.setId, [])
      bySetId.get(set.setId).push({
        kind: 'agent',
        runId: row.id,
        role: row.role,
        status: row.status,
        startedAt: row.started_at,
        setId: set.setId,
        module: set.module,
        /* Deliberately null, not `set.setVersion`: see the module comment. */
        version: null,
        storedSetVersion: set.setVersion,
        versionKnown: false,
        reason: 'agent run 只记了集合；它存的 prompt_set.version 在本仓库从不更新。',
      })
    }
  }

  return {
    byLabel,
    bySetId,
    scanned: {
      optimize: { read: optimizeScanned, carriedPrompts: optimizeCarriedPrompts, limit },
      agent: { read: agentScanned, limit },
    },
    scannedComplete: optimizeScanned < limit && agentScanned < limit,
  }
}

/**
 * Every run that used one prompt.
 *
 * `{ id }` is a `prompt` row id. The answer has three parts that **must not be
 * summed**:
 *
 *   · `byVersion`  — runs that pinned a concrete version of this exact row.
 *   · `bySetOnly`  — agent runs that named the set this row belongs to, but whose
 *                    version is unusable. These are **candidates**, not matches:
 *                    the run drew from the set, which may or may not have included
 *                    this row.
 *   · `scanned`    — how many runs of each kind were read, so `byVersion.length`
 *                    can be told apart from "the scan stopped early".
 *
 * A prompt id that does not exist is an **error**, not an empty answer: returning
 * `{ byVersion: [], bySetOnly: [] }` for a typo would read as "nothing uses it",
 * which is the one thing this function exists to distinguish.
 *
 * ⚠️ This entry point scans, so it is the **single-prompt** path (the tool). A caller
 * asking about many rows must scan once and then use `referencesForPrompt` — the
 * page does. There is deliberately **no `scan` option here**: it was written first
 * and then removed, because no caller passed it, and a parameter nobody passes is
 * a claim nobody checks (and one that hid a falsification attempt — see the note
 * in `tests/b11-9-references.mjs` ⑧).
 */
export function promptReferences(store, options = {}) {
  const target = String(options?.id ?? '').trim()
  if (target === '') throw new Error('给一个提示词 id —— promptReferences 要知道查哪一条。')
  const prompt = getPromptRow(store, target)
  if (prompt === null) throw new Error(`no prompt ${target}`)

  return referencesForPrompt(prompt, scanPromptReferences(store, options))
}

/**
 * The same answer as `promptReferences`, from an already-completed scan.
 *
 * Split out so the page can use **one** scan for all 44 rows. Exported rather
 * than inlined because the two callers must agree on what a match is — if the
 * page grew its own matcher, the tool and the page would drift about which runs
 * "used" a prompt, which is exactly the class of defect this module documents.
 */
export function referencesForPrompt(prompt, scan) {
  const key = `${prompt.module}\u0000${prompt.label}`
  const byVersion = (scan.byLabel.get(key) ?? []).map(entry => ({
    ...entry,
    /* Was the version this run pinned still the one this row reports today? */
    isCurrent: entry.version !== null && entry.version === prompt.version,
  }))
  const bySetOnly = scan.bySetId.get(prompt.setId) ?? []

  return {
    prompt: {
      id: prompt.id,
      label: prompt.label,
      module: prompt.module,
      version: prompt.version,
      setId: prompt.setId,
    },
    byVersion,
    bySetOnly,
    /* The two lists above are different evidence levels, so they are never added
       together here. A caller that wants one number has to pick which question it
       is answering. */
    scanned: scan.scanned,
    scannedComplete: scan.scannedComplete,
  }
}

/**
 * The module an optimize run's prompt package belongs to.
 *
 * A run's `package_json.prompts[]` does **not** carry the prompt's id, so the
 * index key is `module\u0000label`. There is exactly one writer of
 * `package_json.prompts` in this repository: `amzn_optimize_prepare` calls
 * `resolvePrompts({ module: 'optimize', ... })` (`src/tools/optimize.js:582`) and
 * stores the result. So the module is not read off the package — it is a fact
 * about the only producer, and this constant names it in one place.
 *
 * ⚠️ If a second module ever writes an `assemble` package, this must become a real
 * lookup (the package would have to carry its module). Until then, deriving it
 * per-row would be inventing a distinction the data does not have.
 */
export const OPTIMIZE_PACKAGE_MODULE = 'optimize'

/** `prompt` + its set, or `null`. Kept local so the store owns its own SQL. */
function getPromptRow(store, id) {
  const row = store.get(
    `SELECT p.*, s.module AS module, s.id AS set_id
       FROM prompt p JOIN prompt_set s ON s.id = p.set_id
      WHERE p.id = ? AND p.deleted_at IS NULL`,
    [id],
  )
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    label: row.label,
    module: row.module,
    version: Number(row.version),
    setId: row.set_id,
  }
}

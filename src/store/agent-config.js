/**
 * 角色配置的**版本化**存储（模块 12 F12-02）。
 *
 * ## 这个模块存在，是为了让「配置」有真读者
 *
 * 本仓最贵的缺陷形状是「有出口、没有闭环」：建了一张表却没有任何东西因它而改变。
 * 所以这里不只是把角色声明存进 `agent_role_config` —— `toolsForRole(store, id)`
 * （`domain/agent/roles.js`）真的读它，`startRun`（`store/agent.js`）真的把当前版本
 * 冻结进运行，`recordStep` 真的据它执行 `maxSteps`。**改了配置，下一次运行就跟着变。**
 *
 * ## 追加式：发布只 INSERT，**永不 UPDATE 旧行**
 *
 * `publishRoleConfig` 写的是 `MAX(version) + 1`，不是覆盖。回滚不是 UPDATE，是**再追加
 * 一个新版本**（内容等于旧版）。所以历史始终完整：一个上个月开的运行回读
 * `agent_run.role_config_version` 指的那一版，拿到的永远是它当时跑的那一份声明。
 *
 * ## 三种「没有」必须分得开
 *
 * 本仓的招牌要求。这里的约定：
 *   - **角色还没有配置版本** → `latestRoleConfig` / `roleConfigVersion` 返回 `null`；
 *   - **角色不在 `AGENT_ROLES` 里** → 同样是 `null`（调用方要先校验角色，`publishRoleConfig`
 *     会给出结构化的 `{ok:false}`）；
 *   - **列表为空** → `listRoleConfigVersions` 返回 `[]`（它本来就是个列表，空列表是对的）。
 *
 * `null` **不是** `{}`，也**不是** `[]` —— 把「没有这一版」折叠成空对象，就是本仓最忌的
 * 「把缺失渲染成真实值」。
 *
 * ## 为什么播种（seed）不放进迁移
 *
 * 迁移只在升级那次跑一遍，之后列表不会再长。而「每个角色至少有一版默认配置」要每次启动
 * 都成立。所以 `seedRoleConfigs` 在插件启动时跑（`index.js` 的 apply()），**幂等**：
 * 已经有版本的角色**不覆盖** —— 否则每次重启都会把人工发布的版本冲掉，那是本模块的死穴。
 */

import { randomUUID } from 'node:crypto'
import { nowIso } from './db.js'
import { AGENT_ROLES, roleById, roleConfigOf, validateRoleConfig } from '../domain/agent/roles.js'

/**
 * 一行的读法，统一在这一个地方。
 *
 * `null`（而不是 `{}`）表示「没有这一行」。`config_json` **不**做静默兜底：它坏了就让它
 * 抛 —— 把一个坏掉的配置读成「没有配置」，正是「把缺失渲染成真实值」的另一种写法。
 */
function rowToConfig(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    role: row.role,
    version: Number(row.version),
    config: JSON.parse(row.config_json),
    note: row.note ?? null,
    createdAt: row.created_at,
  }
}

/**
 * 把 `AGENT_ROLES` 作为**默认值**播种成每个角色的 v1。**幂等**。
 *
 * ⚠️ 已经有版本的角色**不覆盖**。这条不是「顺手做的优化」：如果每次启动都按代码声明
 * 重播，那么任何一次人工发布的版本都会在**下一次重启**被静默冲掉，而配置版本化的全部
 * 意义就是「发布过的东西留下来」。所以判断是 `MAX(version) IS NULL`（一版都没有），
 * 不是「和代码不一致就重播」。
 *
 * 返回 `{ seeded, roles }`：播了几个 / 一共几个角色。调用方（apply）只在 seeded > 0 时说话。
 */
export function seedRoleConfigs(store) {
  let seeded = 0
  for (const role of AGENT_ROLES) {
    const existing = store.get('SELECT MAX(version) AS v FROM agent_role_config WHERE role = ?', [role.id])
    const has = existing !== undefined && existing !== null && existing.v !== null && existing.v !== undefined
    if (has) continue
    store.run(
      `INSERT INTO agent_role_config (id, role, version, config_json, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), role.id, 1, JSON.stringify(roleConfigOf(role)),
        'F12-02 播种：代码声明的默认版本（v1；它只出现一次，之后代码改动不影响已发布的版本）',
        nowIso(),
      ],
    )
    seeded += 1
  }
  return { seeded, roles: AGENT_ROLES.length }
}

/**
 * 发布一个新版本：`version = MAX(version) + 1`。**不 UPDATE 旧行**。
 *
 * ## `config` 可以只写要改的字段
 *
 * 传入的 `config` 会**合并**到该角色**当前最新一版**之上（还没有任何版本时合并到代码
 * 声明之上），再按 `roleConfigOf` 归一化，最后整体校验。所以发布一次工具集变更可以只传
 * `{ tools: [...] }`。
 *
 * ⚠️ 合并意味着「缺的字段沿用旧值，不是清空」。要清空一个数组字段就**显式**传 `[]`，
 * 要清掉 `promptModule` 就显式传 `null` —— 沉默不等于清空，这是本仓一再付学费的那条。
 *
 * ## 失败一律结构化
 *
 * `{ok:false, error, hint}`：角色不存在，或合并后的声明形状不合法。写工具失败必须让调用方
 * （与审计漏斗 `value?.ok === false`）分辨得出「这次写没发生」。
 *
 * ## `by` 不进配置行
 *
 * 配置行的列由 v40 迁移定死（`id/role/version/config_json/note/created_at`），**没有**
 * 发布人一栏。署名落在**审计行**上（工具的描述符读 `by` 写进 `reason`），与其它写同一条路。
 * 这里把 `by` 原样带进返回值，供工具层转交。
 */
export function publishRoleConfig(store, { role, config, note = null, by = null } = {}) {
  const wanted = String(role ?? '').trim()
  const definition = roleById(wanted)
  if (definition === undefined) {
    return {
      ok: false,
      error: `unknown role: ${role}`,
      hint: `可用角色: ${AGENT_ROLES.map(entry => entry.id).join(' | ')}`,
    }
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return {
      ok: false,
      error: `config must be an object, got ${config === null ? 'null' : Array.isArray(config) ? 'array' : typeof config}`,
      hint: '传要发布的角色声明（可以只写要改的字段，其余沿用当前版本）。',
    }
  }

  const base = latestRoleConfig(store, wanted)?.config ?? roleConfigOf(definition)
  /* ⚠️ **先校验、后归一化**，顺序不能反。`roleConfigOf` 会把 `available` 强转成
     `=== true`，若先归一化，一个 `available: 'yes'` 的笔误会被**静默**变成 `false` ——
     而 `false` 是一个有意义的值（角色被停用），不是「没写」。所以校验跑在归一化之前，
     让坏值在这一层就被结构化拒绝，而不是变成一个看起来像决定的结果。 */
  const raw = { ...base, ...config }
  const shape = validateRoleConfig(raw)
  if (shape.ok !== true) return shape
  const merged = roleConfigOf({ ...definition, ...raw, id: wanted })

  return store.tx(() => {
    const maxRow = store.get('SELECT MAX(version) AS v FROM agent_role_config WHERE role = ?', [wanted])
    const next = Number(maxRow?.v ?? 0) + 1
    const id = randomUUID()
    store.run(
      `INSERT INTO agent_role_config (id, role, version, config_json, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, wanted, next, JSON.stringify(merged), note === null || note === undefined ? null : String(note), nowIso()],
    )
    const row = rowToConfig(store.get('SELECT * FROM agent_role_config WHERE id = ?', [id]))
    return { ok: true, ...row, by: by === null || by === undefined ? null : String(by) }
  })
}

/**
 * 该角色**当前**（最新）的一版：`{id, role, version, config, note, createdAt}`，或 `null`。
 *
 * 「最新」按 `version DESC` 取，`rowid DESC` 只作同版本的兜底（`UNIQUE(role, version)`
 * 保证同版本至多一行，所以那个兜底实际上轮不到 —— 留着是为了「排序键不全」这种排序不撒谎）。
 */
export function latestRoleConfig(store, role) {
  const wanted = String(role ?? '').trim()
  if (wanted === '') return null
  const row = store.get(
    'SELECT * FROM agent_role_config WHERE role = ? ORDER BY version DESC, rowid DESC LIMIT 1',
    [wanted],
  )
  return rowToConfig(row)
}

/** 指定版本的一版，或 `null`（角色 / 版本任一不存在都是 `null`）。 */
export function roleConfigVersion(store, role, version) {
  const wanted = String(role ?? '').trim()
  const v = Number(version)
  if (wanted === '' || !Number.isInteger(v)) return null
  const row = store.get('SELECT * FROM agent_role_config WHERE role = ? AND version = ?', [wanted, v])
  return rowToConfig(row)
}

/**
 * 该角色的版本列表，**最新在前**。没有版本时是 `[]`（空列表，不是 `null` —— 它本来就是个列表）。
 */
export function listRoleConfigVersions(store, role) {
  const wanted = String(role ?? '').trim()
  if (wanted === '') return []
  return store.all('SELECT * FROM agent_role_config WHERE role = ? ORDER BY version DESC', [wanted])
    .map(rowToConfig)
}

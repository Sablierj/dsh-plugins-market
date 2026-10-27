/**
 * 补充数据请求（模块 12 F12-03）—— 一条**记录**，不是一次执行。
 *
 * ## ⚠️ 这个模块不补数据
 *
 * 需求 §4 说「需要新数据时发起补充数据请求，**不能自行扩大范围**」。本插件**不驱动 Agent**，
 * 所以它做的是：把「这次运行缺什么、为什么缺、最后谁把它结掉了」记下来。**没有**任何东西
 * 会因为一条请求被创建而去补数据 —— 那一句写进文案就是插件做不到的承诺。
 *
 * ## 三态与「三种没有」
 *
 * 一条请求的状态只有 `open` / `fulfilled` / `declined`（词表在 `domain/agent/requests.js`）。
 * 而读侧要分开的「没有」有**三种**，调用方不能把它们折成同一个答案：
 *
 *   1. **这次运行没有请求** —— 该运行存在，但 `agent_data_request` 里没有它的行（`rows: []`，
 *      且 `total` 可能 > 0，说明别的运行有）；
 *   2. **请求表是空的** —— 全库一条都没有（`rows: []` 且 `total === 0`）；
 *   3. **这次运行不存在** —— `runExists: false`（不是「没有请求」，是「问错了运行」）。
 *
 * 三种都要能说出来。`listDataRequests` 的返回值把这三件事一起给出，不靠调用方自己猜。
 */

import { randomUUID } from 'node:crypto'
import { nowIso } from './db.js'
import { getRun } from './agent.js'
import {
  AGENT_DATA_REQUEST_OPEN, AGENT_DATA_REQUEST_RESOLUTIONS, isResolvedStatus,
} from '../domain/agent/requests.js'

/** 一次请求的 id：可读前缀 + uuid（日志里一眼认出它是补充数据请求）。 */
function requestId() {
  return `data-req-${randomUUID()}`
}

/** 一行的读法，统一在这里（`null` 表示没有这一行，不是 `{}`）。 */
function rowToRequest(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    runId: row.run_id,
    what: row.what,
    why: row.why ?? null,
    status: row.status,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at ?? null,
    resolution: row.resolution ?? null,
  }
}

/**
 * 记下一条补充数据请求。失败一律 `{ok:false, error, hint}`（本仓的写工具失败必须结构化）。
 *
 * `what` 必填（说清要什么）；`why` 可选。⚠️ 可选的 `why` 给空串**也拒绝** —— 与
 * `startRun` 的 `humanConstraint` 同一条规矩：`''` 看起来像「给了」，折成 `null` 之后
 * 「他没说」与「他说了个空格」就分不开了，而它们要做的下一件事不一样。
 */
export function openDataRequest(store, { runId, what, why = null } = {}) {
  const run = getRun(store, runId)
  if (run === null) {
    return {
      ok: false,
      error: `no agent run ${runId}`,
      hint: '一条请求必须挂在一次**真的存在**的运行上；运行 id 用 amzn_agent_run_list 看。',
    }
  }
  const wanted = String(what ?? '').trim()
  if (wanted === '') {
    return {
      ok: false,
      error: 'what is required — a request that does not say what is missing is not a request',
      hint: '写清这次运行缺哪样数据（例如「产品线归属表」「近 30 天广告报告」）。',
    }
  }
  const reason = optionalText(why, 'why')
  if (reason.ok === false) return reason

  const id = requestId()
  store.run(
    `INSERT INTO agent_data_request (id, run_id, what, why, status, opened_at, resolved_at, resolution)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [id, run.id, wanted, reason.value, AGENT_DATA_REQUEST_OPEN, nowIso()],
  )
  return { ok: true, request: rowToRequest(store.get('SELECT * FROM agent_data_request WHERE id = ?', [id])) }
}

/**
 * 结掉一条请求：`fulfilled`（补到了）或 `declined`（明确不补）。
 *
 * - 不存在的 id、`open` 作为目标状态、已经结过的请求，都**拒绝** —— 一条请求只结一次
 *   （与 §11 的草案裁决同一条纪律：第二次处置是一次**新的事实**，不是静默覆盖）。
 * - `resolution` 可选；给了就必须非空（理由同上：空串与「没说」不是一回事）。
 *
 * ⚠️ 这里用 `UPDATE`（不是追加）是有意的，也是**唯一**一处：`agent_data_request` 的三列
 * `status` / `resolved_at` / `resolution` 记的就是「这一条**现在**怎么样了」，by design。
 * 它**不是**版本化的对象（配置版本那套的「永不 UPDATE」说的是版本表，不是这张）。
 */
export function resolveDataRequest(store, { requestId: id, status, resolution = null } = {}) {
  const wanted = String(id ?? '').trim()
  if (wanted === '') {
    return { ok: false, error: 'requestId is required', hint: '要结清哪一条？id 用 amzn_agent_data_request_list 看。' }
  }
  const row = store.get('SELECT * FROM agent_data_request WHERE id = ?', [wanted])
  if (row === undefined || row === null) {
    return { ok: false, error: `no data request ${wanted}`, hint: 'id 用 amzn_agent_data_request_list 看。' }
  }
  const target = String(status ?? '').trim()
  if (!isResolvedStatus(target)) {
    return {
      ok: false,
      error: `status must be one of ${AGENT_DATA_REQUEST_RESOLUTIONS.join(' / ')}, got ${JSON.stringify(status)}`,
      hint: '`open` 是「刚开」的状态，不是一次结清 —— 要结清就选 fulfilled（补到了）或 declined（不补）。',
    }
  }
  if (row.status !== AGENT_DATA_REQUEST_OPEN) {
    return {
      ok: false,
      error: `data request ${wanted} is already ${row.status}`,
      hint: '一条请求只结一次；要改判就先说清为什么，那是一次**新的事实**（本版没有这条路径）。',
    }
  }
  const note = optionalText(resolution, 'resolution')
  if (note.ok === false) return note

  store.run(
    'UPDATE agent_data_request SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?',
    [target, nowIso(), note.value, wanted],
  )
  return { ok: true, request: rowToRequest(store.get('SELECT * FROM agent_data_request WHERE id = ?', [wanted])) }
}

/**
 * 一条请求，按 id。没有就是 `null`。
 *
 * 它是审计描述符的**前值 / 后值读取器**（「这一条从 `open` 被结成了什么」正是那一行要
 * 回答的），也是 `resolveDataRequest` 的存在性检查 —— 一处实现，两处用。
 */
export function getDataRequest(store, id) {
  const wanted = String(id ?? '').trim()
  if (wanted === '') return null
  return rowToRequest(store.get('SELECT * FROM agent_data_request WHERE id = ?', [wanted]))
}

/**
 * 读一批请求。`runId` 给了就只看那次运行；不给就看全部（最新在前）。
 *
 * 返回值同时给出 `rows` / `total` / `runExists`，因为**三种「没有」要分开**
 * （见本文件文件头）：`rows: []` 到底是「这次运行没有」「全库都没有」还是「没这次运行」，
 * 只看 `rows` 是分不开的。
 */
export function listDataRequests(store, { runId = null } = {}) {
  const total = store.get('SELECT COUNT(*) AS n FROM agent_data_request').n
  const wanted = String(runId ?? '').trim()
  if (wanted === '') {
    return {
      rows: store.all('SELECT * FROM agent_data_request ORDER BY opened_at DESC, rowid DESC').map(rowToRequest),
      total,
      runExists: null,
    }
  }
  return {
    rows: store.all(
      'SELECT * FROM agent_data_request WHERE run_id = ? ORDER BY opened_at ASC, rowid ASC',
      [wanted],
    ).map(rowToRequest),
    total,
    runExists: getRun(store, wanted) !== null,
  }
}

/**
 * 一个可选的文本参数：`null`/缺省 → `{value: null}`；非空串 → `{value: <原样>}`；
 * 空串 / 只有空白 → `{ok:false, error, hint}`（**不折成 null**）。
 *
 * 与 `store/agent.js` 的 `optionalText` 是同一条规矩，只是这里要能返回结构化的拒绝
 * （那个是 `throw`，因为 `startRun` 的调用方是一个 try/catch）。
 */
function optionalText(value, field) {
  if (value === null || value === undefined) return { value: null }
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string, got ${typeof value}`, hint: '写一段文字，或者省略它表示「没说」。' }
  }
  if (value.trim() === '') {
    return {
      ok: false,
      error: `${field} must not be an empty string`,
      hint: '想表示「没说」就**省略**它，不要传空串 —— 空串看起来像「给了」。',
    }
  }
  return { value }
}

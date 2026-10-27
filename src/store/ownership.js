/**
 * `asin_ownership`: the relationship records that replaced a single column.
 *
 * Three rules shape this file:
 *
 *   - **The conflict check is inside the transaction.** `resolveOwnership` is
 *     asked about the set the table is *about to* hold, and if it says the two
 *     sides disagree, nothing is written. Checking before the write and then
 *     writing anyway is how a store ends up holding the contradiction it just
 *     refused.
 *
 *   - **The set can be written in one call.** A caller that knows both sides at
 *     once (an importer, a test) passes them together and gets "neither" rather
 *     than "the first one, then a refusal" — which is the difference between a
 *     store that holds no contradiction and one that holds half of one.
 *
 *   - **Retraction is a timestamp.** Rows are never deleted. See
 *     `domain/ownership/resolve.js` for why.
 *
 * `asin.product_line_id` is kept in step by `syncProductLineCache`, which is
 * the *only* writer of that column's ownership-derived value. It stays because
 * a lot of queries read it and it is now derivable rather than authoritative —
 * the cache has a source, which it never had before.
 */

import { randomUUID } from 'node:crypto'

import { OWNERSHIP_OBJECT_TYPES, OWNERSHIP_SIDES, OWNERSHIP_SOURCES, classifyOwnership, resolveOwnership } from '../domain/ownership/resolve.js'
import { PROBLEM_CODES } from '../domain/states.js'
import { nowIso } from './db.js'

/** Normalise one input record, or throw naming what was wrong with it. */
function normalizeRecord(record, index) {
  const asin = String(record?.asin ?? '').trim().toUpperCase()
  const marketplace = String(record?.marketplace ?? '').trim().toUpperCase()
  const objectType = String(record?.objectType ?? '').trim()
  const objectId = String(record?.objectId ?? '').trim()
  const source = String(record?.source ?? 'auto').trim()
  const where = index === undefined ? '' : ` (record #${index + 1})`

  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN "${record?.asin}"${where}`)
  if (marketplace === '') throw new Error(`marketplace is required${where}`)
  if (!OWNERSHIP_OBJECT_TYPES.includes(objectType)) {
    throw new Error(`objectType must be one of: ${OWNERSHIP_OBJECT_TYPES.join(' | ')} (got ${JSON.stringify(record?.objectType)})${where}`)
  }
  if (objectId === '') throw new Error(`objectId is required${where}`)
  if (objectType === 'side' && !OWNERSHIP_SIDES.includes(objectId)) {
    /* `side` points at a decision, not at a row. Letting an arbitrary string in
       here would make "is this ASIN ours" unanswerable while looking answered. */
    throw new Error(`objectId for objectType 'side' must be one of: ${OWNERSHIP_SIDES.join(' | ')} (got ${JSON.stringify(objectId)})${where}`)
  }
  if (!OWNERSHIP_SOURCES.includes(source)) {
    throw new Error(`source must be one of: ${OWNERSHIP_SOURCES.join(' | ')} (got ${JSON.stringify(record?.source)})${where}`)
  }
  return {
    asin,
    marketplace,
    objectType,
    objectId,
    source,
    confidence: source === 'manual' ? null : (Number.isFinite(Number(record?.confidence)) ? Number(record.confidence) : null),
    evidence: record?.evidence === undefined || record?.evidence === null ? null : JSON.stringify(record.evidence),
  }
}

/**
 * Write one ownership record, or a whole set of them, atomically.
 *
 * Accepts either a single record or `{ records: [...] }`. The set form exists
 * because "these two sides both belong to this ASIN" is a claim about the
 * *result*, and the store has to be able to refuse the result rather than the
 * second half of it.
 *
 * Returns `{ ok: true, rows }`, or `{ ok: false, conflict: true, reason }` with
 * **nothing written**. It does not throw for the conflict: a contradiction is a
 * finding, not a crash, and the caller has a decision to surface.
 */
export function upsertOwnership(store, input) {
  const records = Array.isArray(input?.records) ? input.records : [input]
  if (records.length === 0) throw new Error('at least one ownership record is required')
  const normalized = records.map((record, index) => normalizeRecord(record, index))
  const { asin, marketplace } = normalized[0]
  for (const record of normalized) {
    /* One call, one ASIN: a set spanning two ASINs cannot be checked for
       contradiction, and a caller that thinks it can is a caller about to
       believe a check that never ran. */
    if (record.asin !== asin || record.marketplace !== marketplace) {
      throw new Error('every record in one call must share the same asin and marketplace')
    }
  }

  return store.tx(() => {
    const existing = store.all(
      'SELECT * FROM asin_ownership WHERE asin = ? AND marketplace = ? AND retracted_at IS NULL',
      [asin, marketplace],
    )
    /* The set the table would hold: what is there now, plus what is arriving.
       A row that already exists (same five-part key) is replaced, not doubled.
       The arriving rows are spelled the way the table holds them — the domain
       decision reads columns, and handing it camelCase objects would make every
       `object_type` undefined and every contradiction invisible. */
    const arriving = new Map(normalized.map(record => [keyOf(record), record]))
    const merged = [
      ...existing.filter(row => !arriving.has(keyOf(row))),
      ...normalized.map(record => ({
        asin: record.asin,
        marketplace: record.marketplace,
        object_type: record.objectType,
        object_id: record.objectId,
        source: record.source,
        retracted_at: null,
      })),
    ]
    const verdict = resolveOwnership(merged)
    if (verdict.conflict) {
      return { ok: false, conflict: true, code: PROBLEM_CODES.OWNERSHIP_CONFLICT, reason: verdict.reason }
    }

    const now = nowIso()
    const written = []
    for (const record of normalized) {
      store.run(
        `INSERT INTO asin_ownership
           (id, asin, marketplace, object_type, object_id, source, confidence, evidence_json, created_at, retracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(asin, marketplace, object_type, object_id, source) DO UPDATE SET
           confidence    = excluded.confidence,
           evidence_json = excluded.evidence_json,
           retracted_at  = NULL`,
        [randomUUID(), record.asin, record.marketplace, record.objectType, record.objectId, record.source, record.confidence, record.evidence, now],
      )
      written.push(store.get(
        'SELECT * FROM asin_ownership WHERE asin = ? AND marketplace = ? AND object_type = ? AND object_id = ? AND source = ?',
        [record.asin, record.marketplace, record.objectType, record.objectId, record.source],
      ))
    }
    syncProductLineCache(store, { asin, marketplace })
    return { ok: true, rows: written }
  })
}

/** The five-part identity the UNIQUE constraint uses. */
function keyOf(row) {
  return `${row.asin}|${row.marketplace}|${row.object_type ?? row.objectType}|${row.object_id ?? row.objectId}|${row.source}`
}

/** Every ownership row for one ASIN, retracted ones included. */
export function listOwnership(store, { asin, marketplace }) {
  return store.all(
    'SELECT * FROM asin_ownership WHERE asin = ? AND marketplace = ? ORDER BY object_type, object_id, source',
    [String(asin ?? '').trim().toUpperCase(), String(marketplace ?? '').trim().toUpperCase()],
  )
}

/** The resolved view of one ASIN's ownership, ready to draw. */
export function ownershipView(store, { asin, marketplace }) {
  return classifyOwnership(listOwnership(store, { asin, marketplace }))
}

/**
 * Retract a row — or every row for one target.
 *
 * Retracting is how a person says "no, it is not in this line after all". The
 * row stays with its timestamp, so the next reader can see that a judgement was
 * made and then withdrawn, which is different from no judgement ever having
 * been made. Returns the number of rows retracted, so a caller can tell "I
 * retracted it" from "there was nothing to retract".
 */
export function retractOwnership(store, { asin, marketplace, objectType, objectId, source }) {
  const now = nowIso()
  return store.tx(() => {
    const before = store.all(
      `SELECT * FROM asin_ownership
        WHERE asin = ? AND marketplace = ? AND object_type = ? AND object_id = ? AND source = ? AND retracted_at IS NULL`,
      [String(asin ?? '').trim().toUpperCase(), String(marketplace ?? '').trim().toUpperCase(),
        String(objectType ?? '').trim(), String(objectId ?? '').trim(), String(source ?? '').trim()],
    )
    if (before.length === 0) return 0
    store.run(
      `UPDATE asin_ownership SET retracted_at = ?
        WHERE asin = ? AND marketplace = ? AND object_type = ? AND object_id = ? AND source = ? AND retracted_at IS NULL`,
      [now, String(asin).trim().toUpperCase(), String(marketplace).trim().toUpperCase(),
        String(objectType).trim(), String(objectId).trim(), String(source).trim()],
    )
    syncProductLineCache(store, { asin, marketplace })
    return before.length
  })
}

/**
 * Write the effective product line back into `asin.product_line_id`.
 *
 * The column is a **cache** now, not the answer: it exists because a lot of
 * queries read it, and it is refreshed from the ownership records every time
 * they change. Keeping it in step here — the one place ownership is written —
 * is what stops the cache and the records from disagreeing.
 *
 * When the effective ownership names no product line, the column is cleared
 * rather than left at its old value: a stale id is a claim that survived the
 * evidence being withdrawn.
 */
export function syncProductLineCache(store, { asin, marketplace }) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const view = classifyOwnership(store.all(
    'SELECT * FROM asin_ownership WHERE asin = ? AND marketplace = ?',
    [key, market],
  ))
  const target = view.targets.find(entry => entry.objectType === 'product_line')
  const productLineId = target === undefined ? null : target.objectId
  store.run(
    'UPDATE asin SET product_line_id = ?, updated_at = ? WHERE asin = ? AND marketplace = ?',
    [productLineId, nowIso(), key, market],
  )
  return productLineId
}

/**
 * Derive the ownership rows an ASIN's own signals imply.
 *
 * `auto` means "a machine decided", and this is the machine: a product line from
 * the keyword/brand signals, plus the self/competitor side from whether the
 * brand is one of ours. It returns records rather than writing them, so the
 * caller can pass the whole set through `upsertOwnership` and get the
 * contradiction check for free.
 */
export function deriveOwnership({ asin, marketplace, productLineId, brandIsOwn, evidence = null, confidence = null }) {
  const records = []
  if (productLineId !== null && productLineId !== undefined && String(productLineId).trim() !== '') {
    records.push({
      asin, marketplace, objectType: 'product_line', objectId: String(productLineId).trim(),
      source: 'auto', confidence, evidence,
    })
  }
  if (brandIsOwn !== null && brandIsOwn !== undefined) {
    records.push({
      asin, marketplace, objectType: 'side', objectId: brandIsOwn ? 'self' : 'competitor',
      source: 'auto', confidence, evidence,
    })
  }
  return records
}

/* ── FR-M2-05：页面与工具**共用的那一个**写入口 ─────────────────────────────
   为什么需要它：`asin.product_line_id` 不是事实列，是 `asin_ownership` 的缓存
   （见下面 `syncProductLineCache`）。任何直接写那一列的路径，都会被下一次归属写入
   **刷回去**，而且刷回去时不会有任何审计 —— 比「静默覆盖」更隐蔽。
   所以「改归属」只有一条正确的路：写**边**，缓存跟着边走。

   这个函数是那条路的唯一入口，被两处调用：
     · 工具 `amzn_asin_ownership_set`（agent 侧）
     · 页面路由 `asin-ownership-set`（人工侧）
   两处共用同一个 `ACTIONS.asinOwnershipSet`，因为「页面点一次」与「会话调一次」
   在审计里必须是同一条。

   两条语义细节：
     · **撤销是显式参数 `revoke: true`**，不是 `objectId: null` —— 「少传一个参数」
       和「明确撤销」长一样的话，一次手滑就是一次静默撤销（照 dev-12 的 `revoke`）。
     · 写新值之前先把同类型的 live 边全部撤销，再插新的：`upsertOwnership` 的
       冲突检查是**按整张表的 live 集合**判的，先撤后插才保证它看到的集合里
       不会同时存在「自有」和「竞品」。 */
export const INLINE_OWNERSHIP_TYPES = ['side', 'product_line']

/** 合法的写请求，或 `{ code, error }`。工具与路由都先问它，判据只此一份。 */
export function refusalForAsinOwnership(input = {}) {
  const asin = String(input?.asin ?? '').trim().toUpperCase()
  const marketplace = String(input?.marketplace ?? '').trim().toUpperCase()
  const objectType = String(input?.objectType ?? '').trim()
  if (asin === '') return { code: 'ASIN_REQUIRED', error: 'asin 必填' }
  if (marketplace === '') return { code: 'MARKETPLACE_REQUIRED', error: 'marketplace 必填' }
  if (!INLINE_OWNERSHIP_TYPES.includes(objectType)) {
    return {
      code: 'OBJECT_TYPE_NOT_WRITABLE',
      error: `objectType「${objectType}」不支持在这里写；可写：${INLINE_OWNERSHIP_TYPES.join(', ')}`
        + '（brand / shop 由别的路径维护）',
    }
  }
  if (input?.revoke === true) {
    /* 撤销不需要 objectId —— 它撤的是「这一类型的全部 live 边」。 */
    return null
  }
  const objectId = String(input?.objectId ?? '').trim()
  if (objectId === '') {
    return { code: 'OBJECT_ID_REQUIRED', error: 'objectId 必填；要撤销请显式传 revoke: true' }
  }
  if (objectType === 'side' && !OWNERSHIP_SIDES.includes(objectId)) {
    return { code: 'SIDE_NOT_A_SIDE', error: `side 只能是 ${OWNERSHIP_SIDES.join(' 或 ')}，收到「${objectId}」` }
  }
  return null
}

/** 写一条归属边（或撤销这一类型的全部 live 边）。**唯一入口**，见上面的注释。 */
export function setAsinOwnership(store, input = {}) {
  const refusal = refusalForAsinOwnership(input)
  if (refusal !== null) return { ok: false, ...refusal }

  const asin = String(input.asin).trim().toUpperCase()
  const marketplace = String(input.marketplace).trim().toUpperCase()
  const objectType = String(input.objectType).trim()
  const revoke = input.revoke === true
  const objectId = revoke ? null : String(input.objectId).trim()
  const source = OWNERSHIP_SOURCES.includes(String(input.source ?? '').trim())
    ? String(input.source).trim()
    : 'manual'

  /* `store.tx` **不可重入**（`store/db.js` 直接 BEGIN），而 `upsertOwnership` 自己
     开一个事务。所以这里是两步、各自原子：
       ① 撤销这一类型的全部 live 边（自己的事务）；
       ② 写新边（`upsertOwnership` 的事务，冲突检查在里面）。
     中间那一瞬若进程挂掉，库里留下的是「已撤销、未写入」——读起来是「没有判断过」，
     而不是一条错误的判断。硬用第二个事务包住第一个在这个 store 里做不到（BEGIN 会抛），
     硬做只会得到一个不存在的保证。 */
  const before = store.tx(() => {
    const live = store.all(
      `SELECT * FROM asin_ownership
        WHERE asin = ? AND marketplace = ? AND object_type = ? AND retracted_at IS NULL
        ORDER BY object_id`,
      [asin, marketplace, objectType],
    )
    if (live.length > 0) {
      /* 行不删，只置时间戳：历史都留着（这是本表的第一条规则）。 */
      store.run(
        `UPDATE asin_ownership SET retracted_at = ?
          WHERE asin = ? AND marketplace = ? AND object_type = ? AND retracted_at IS NULL`,
        [nowIso(), asin, marketplace, objectType],
      )
    }
    return live
  })

  if (revoke) {
    const productLineId = syncProductLineCache(store, { asin, marketplace })
    return {
      ok: true, asin, marketplace, objectType, objectId: null, revoked: true,
      before: before.map(row => row.object_id), retracted: before.length, productLineId,
    }
  }

  const written = upsertOwnership(store, {
    asin, marketplace, objectType, objectId, source,
    confidence: null, evidence: input.evidence ?? null,
  })
  if (written.ok !== true) return written
  /* 缓存只由 `syncProductLineCache` 从边刷出来 —— 这里不写 `asin.product_line_id`。 */
  const productLineId = syncProductLineCache(store, { asin, marketplace })
  return {
    ok: true, asin, marketplace, objectType, objectId, revoked: false,
    before: before.map(row => row.object_id), retracted: before.length, productLineId,
  }
}

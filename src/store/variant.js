/**
 * 父子变体的**关系与维度**（模块 05 F05-06，schema v37）。
 *
 * 三张表，三个问题（见 schema.js 的 v37 迁移注释）：边 / 维度值 / 事件历史。
 * 这个模块是它们唯一的写入口与读入口。
 *
 * ## 一次写入是什么
 *
 * `upsertVariantRelation` 写的是**一条边**（父→子）。同一条边写第二次是覆盖
 * （UNIQUE 在 (marketplace, parent_asin, child_asin) 上），不是第二行 —— 而
 * 「同一个子体挂在两个不同父体下」是**两次不同的写**，两行，**故意允许**：
 * 那是要被检测出来的矛盾，不是要在库层拒绝的输入。一条把矛盾挡在库外的约束，
 * 等于把「检测重复或矛盾变体」实现成一个永远为空的列表。
 *
 * ## 纠正为什么不删行
 *
 * `correctVariantRelation` 把 status 置成 `corrected` 并追加一条事件，行留在原地。
 * 「错误关系可纠正且留历史」（模块设计 §7.4）：删掉那一行，历史就只剩一句「现在
 * 是对的」，而「当时为什么认为它是错的」再也回答不了 —— 与 `field_conflict`
 * 的裁决不删来源是同一条纪律。
 *
 * ## 维度值的来源进主键
 *
 * `(marketplace, parent_asin, child_asin, dimension, source_id)` 唯一：同一个来源
 * 重写同一个维度是覆盖，两个来源给出两个值是两行。后者不是脏数据 —— 它是
 * 「矛盾变体」在这个库里的形状，而 `domain/asin/variants.js` 就是来报它的。
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'
import { assertAsinWritable } from './archive.js'

/** 一条边的两个状态。`corrected` 的行留着供追溯，永不删除。 */
export const VARIANT_RELATION_STATUSES = ['active', 'corrected']

/**
 * 事件动作。`created` 与 `updated` 分开：第一次建立这条边与后来往同一条边上补维度，
 * 在追溯里是两件事（「谁最早说它是子体」与「谁后来说它有红色」）。
 */
export const VARIANT_EVENT_ACTIONS = ['created', 'updated', 'corrected', 'restored']

function asinOf(value, what = 'asin') {
  const asin = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`${what} "${value}" is not a 10-character ASIN`)
  return asin
}

function marketplaceOf(value) {
  const marketplace = String(value ?? '').trim().toUpperCase()
  if (marketplace === '') throw new Error('marketplace is required')
  return marketplace
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function hydrateRelation(row) {
  if (row === null || row === undefined) return null
  return {
    id: row.id,
    marketplace: row.marketplace,
    parentAsin: row.parent_asin,
    childAsin: row.child_asin,
    sourceId: row.source_id ?? null,
    evidence: row.evidence ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    correctedAt: row.corrected_at ?? null,
    correctionReason: row.correction_reason ?? null,
  }
}

function hydrateDimension(row) {
  return {
    id: row.id,
    marketplace: row.marketplace,
    parentAsin: row.parent_asin,
    childAsin: row.child_asin,
    dimension: row.dimension,
    value: row.value,
    sourceId: row.source_id,
    observedAt: row.observed_at ?? null,
    ingestedAt: row.ingested_at,
    updatedAt: row.updated_at,
  }
}

/** 一条边，按坐标。`null` 而不是 `undefined`：调用方按「有没有」分支。 */
export function getVariantRelation(store, { marketplace, parentAsin, childAsin } = {}) {
  const row = store.get(
    `SELECT * FROM asin_variant_relation
      WHERE marketplace = ? AND parent_asin = ? AND child_asin = ?`,
    [marketplaceOf(marketplace), asinOf(parentAsin, 'parentAsin'), asinOf(childAsin, 'childAsin')],
  )
  return hydrateRelation(row)
}

/** 边，按父体 / 子体 / 状态过滤。都给了就都算（AND）。 */
export function listVariantRelations(store, { marketplace = null, parentAsin = null, childAsin = null, status = null } = {}) {
  const clauses = []
  const params = []
  if (blankToNull(marketplace) !== null) { clauses.push('marketplace = ?'); params.push(marketplaceOf(marketplace)) }
  if (blankToNull(parentAsin) !== null) { clauses.push('parent_asin = ?'); params.push(asinOf(parentAsin, 'parentAsin')) }
  if (blankToNull(childAsin) !== null) { clauses.push('child_asin = ?'); params.push(asinOf(childAsin, 'childAsin')) }
  if (blankToNull(status) !== null) {
    const wanted = String(status).trim()
    if (!VARIANT_RELATION_STATUSES.includes(wanted)) {
      throw new Error(`status "${status}" is not one of ${VARIANT_RELATION_STATUSES.join(' / ')}`)
    }
    clauses.push('status = ?')
    params.push(wanted)
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  return store
    .all(`SELECT * FROM asin_variant_relation${where} ORDER BY parent_asin, child_asin`, params)
    .map(hydrateRelation)
}

export function listVariantDimensions(store, { marketplace = null, parentAsin = null, childAsin = null } = {}) {
  const clauses = []
  const params = []
  if (blankToNull(marketplace) !== null) { clauses.push('marketplace = ?'); params.push(marketplaceOf(marketplace)) }
  if (blankToNull(parentAsin) !== null) { clauses.push('parent_asin = ?'); params.push(asinOf(parentAsin, 'parentAsin')) }
  if (blankToNull(childAsin) !== null) { clauses.push('child_asin = ?'); params.push(asinOf(childAsin, 'childAsin')) }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  return store
    .all(`SELECT * FROM asin_variant_dimension${where} ORDER BY child_asin, dimension, source_id`, params)
    .map(hydrateDimension)
}

/** 一条边的事件历史，最新在后（读起来像一条时间线）。
 *
 * ★ 并列时按 `rowid`，不按 `id`：`at` 是毫秒精度的 ISO 串，而「建立这条边」与
 * 「往同一条边上补一个维度」完全可能落在同一毫秒里。`id` 是随机 UUID，用它兜底
 * 等于让同一毫秒的两条事件**随机**排序 —— 时间线会时正时反，而这是读不出来的错
 * （两条事件都真实存在，只是顺序在撒谎）。`rowid` 是插入顺序，这才是时间线的兜底。 */
export function listVariantEvents(store, relationId) {
  const id = blankToNull(relationId)
  if (id === null) throw new Error('relationId is required')
  return store
    .all('SELECT * FROM asin_variant_relation_event WHERE relation_id = ? ORDER BY at, rowid', [id])
    .map(row => ({
      id: row.id,
      relationId: row.relation_id,
      action: row.action,
      reason: row.reason ?? null,
      evidence: row.evidence ?? null,
      at: row.at,
      by: row.by ?? null,
    }))
}

function appendEvent(store, { relationId, action, reason = null, evidence = null, by = null, at }) {
  if (!VARIANT_EVENT_ACTIONS.includes(action)) {
    throw new Error(`unknown variant event action "${action}"`)
  }
  store.run(
    `INSERT INTO asin_variant_relation_event (id, relation_id, action, reason, evidence, at, by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`variant-event-${randomUUID()}`, relationId, action, blankToNull(reason), blankToNull(evidence), at, blankToNull(by)],
  )
}

/**
 * 写一条边（幂等），并留下一条 `created` / `updated` 事件。
 *
 * 自成一个父体在这里被**先拦一次**：库里那条 `CHECK (parent_asin <> child_asin)`
 * 是结构兜底，报的是 `CHECK constraint failed`；而「自己不能是自己的父体」这句话
 * 才是给人看的。两条都在（测试里两条都断言），因为真正危险的是只有其中一条。
 *
 * 已归档的 ASIN 拒绝写入（`ASIN_ARCHIVED`）—— 子体或父体任一被归档都算：
 * 往一条归档的 ASIN 上挂新子体，与往它上面写字段是同一类越权。
 */
export function upsertVariantRelation(store, record = {}) {
  const marketplace = marketplaceOf(record.marketplace)
  const parentAsin = asinOf(record.parentAsin, 'parentAsin')
  const childAsin = asinOf(record.childAsin, 'childAsin')
  if (parentAsin === childAsin) {
    throw new Error(`parentAsin 与 childAsin 相同（${parentAsin}）—— 自己不能是自己的父体`)
  }
  assertAsinWritable(store, { asin: parentAsin, marketplace, action: '写变体关系' })
  assertAsinWritable(store, { asin: childAsin, marketplace, action: '写变体关系' })

  const existing = getVariantRelation(store, { marketplace, parentAsin, childAsin })
  const at = nowIso()
  const sourceId = blankToNull(record.sourceId)
  const evidence = blankToNull(record.evidence)
  const by = blankToNull(record.by)

  const relation = store.tx(() => {
    if (existing === null) {
      const id = `variant-relation-${randomUUID()}`
      store.run(
        `INSERT INTO asin_variant_relation
           (id, marketplace, parent_asin, child_asin, source_id, evidence, status, created_at, updated_at,
            corrected_at, correction_reason)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
        [id, marketplace, parentAsin, childAsin, sourceId, evidence, at, at],
      )
      appendEvent(store, { relationId: id, action: 'created', evidence, by, at })
      return getVariantRelation(store, { marketplace, parentAsin, childAsin })
    }

    /* 一条被纠正过的边又被写了：它是**重新生效**，不是「新建一条」—— id 与创建时间
       都不变，因为这条边从来只有一条。事件动作记 `restored`，与 `created` 分开。 */
    const restored = existing.status === 'corrected'
    store.run(
      `UPDATE asin_variant_relation
          SET status = 'active', corrected_at = NULL, correction_reason = NULL, updated_at = ?,
              source_id = COALESCE(?, source_id), evidence = COALESCE(?, evidence)
        WHERE id = ?`,
      [at, sourceId, evidence, existing.id],
    )
    appendEvent(store, {
      relationId: existing.id,
      action: restored ? 'restored' : 'updated',
      evidence,
      by,
      at,
    })
    return getVariantRelation(store, { marketplace, parentAsin, childAsin })
  })

  return { relation, created: existing === null, restored: existing !== null && existing.status === 'corrected' }
}

/**
 * 纠正一条边：status → corrected，原因与时间写进行，历史追加一条。
 *
 * 幂等：已经 corrected 的边再纠正一次返回 `{changed:false}`，不重盖 `corrected_at` ——
 * 「什么时候被判定为错的」只有一个答案（与归档时间同一条规矩）。
 */
export function correctVariantRelation(store, record = {}) {
  const marketplace = marketplaceOf(record.marketplace)
  const parentAsin = asinOf(record.parentAsin, 'parentAsin')
  const childAsin = asinOf(record.childAsin, 'childAsin')
  const reason = blankToNull(record.reason)
  if (reason === null) throw new Error('纠正一条关系必须给 reason —— 没有理由的纠正在半年后无法复盘')

  const existing = getVariantRelation(store, { marketplace, parentAsin, childAsin })
  if (existing === null) {
    throw new Error(`no variant relation ${parentAsin} → ${childAsin}@${marketplace}`)
  }
  if (existing.status === 'corrected') {
    return { changed: false, relation: existing }
  }

  const at = nowIso()
  store.tx(() => {
    store.run(
      `UPDATE asin_variant_relation
          SET status = 'corrected', corrected_at = ?, correction_reason = ?, updated_at = ?
        WHERE id = ?`,
      [at, reason, at, existing.id],
    )
    appendEvent(store, {
      relationId: existing.id,
      action: 'corrected',
      reason,
      evidence: blankToNull(record.evidence),
      by: blankToNull(record.by),
      at,
    })
  })
  return { changed: true, before: existing, relation: getVariantRelation(store, { marketplace, parentAsin, childAsin }) }
}

/**
 * 写一个维度值（按来源幂等）。
 *
 * 边必须先存在：库里的复合外键兜底，这里先给一句能读懂的话（同一件事的两个层次，
 * 与 `parentAsin === childAsin` 的处理一致）。`observed_at` 不默认成现在 —— 一个
 * 没人记过观察时间的维度值必须读作「不知道什么时候」，与 `asin_field_source` 同一条纪律。
 */
export function upsertVariantDimension(store, record = {}) {
  const marketplace = marketplaceOf(record.marketplace)
  const parentAsin = asinOf(record.parentAsin, 'parentAsin')
  const childAsin = asinOf(record.childAsin, 'childAsin')
  const dimension = blankToNull(record.dimension)
  if (dimension === null) throw new Error('dimension is required')
  const value = blankToNull(record.value)
  if (value === null) {
    throw new Error('value is required —— 空值不是「这个维度没有值」，那件事由「没有这一行」表达')
  }
  const sourceId = blankToNull(record.sourceId)
  if (sourceId === null) throw new Error('sourceId is required —— 一个没有来源的维度值没人能追溯')

  assertAsinWritable(store, { asin: childAsin, marketplace, action: '写变体维度' })

  const relation = getVariantRelation(store, { marketplace, parentAsin, childAsin })
  if (relation === null) {
    throw new Error(`no variant relation ${parentAsin} → ${childAsin}@${marketplace} —— 先记关系，再记它的维度`)
  }

  const at = nowIso()
  const existing = store.get(
    `SELECT * FROM asin_variant_dimension
      WHERE marketplace = ? AND parent_asin = ? AND child_asin = ? AND dimension = ? AND source_id = ?`,
    [marketplace, parentAsin, childAsin, dimension, sourceId],
  )
  if (existing === undefined || existing === null) {
    store.run(
      `INSERT INTO asin_variant_dimension
         (id, marketplace, parent_asin, child_asin, dimension, value, source_id, observed_at, ingested_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`variant-dim-${randomUUID()}`, marketplace, parentAsin, childAsin, dimension, value, sourceId,
        blankToNull(record.observedAt), at, at],
    )
  } else {
    store.run(
      `UPDATE asin_variant_dimension
          SET value = ?, observed_at = COALESCE(?, observed_at), updated_at = ?
        WHERE id = ?`,
      [value, blankToNull(record.observedAt), at, existing.id],
    )
  }
  const row = store.get(
    `SELECT * FROM asin_variant_dimension
      WHERE marketplace = ? AND parent_asin = ? AND child_asin = ? AND dimension = ? AND source_id = ?`,
    [marketplace, parentAsin, childAsin, dimension, sourceId],
  )
  return { dimension: hydrateDimension(row), created: existing === undefined || existing === null }
}

/**
 * 字段模板（R-91）—— 「实际优化时有哪些字段」这件事的唯一登记处。
 *
 * ## 为什么要有它
 * 需求方的原话：
 * > 一份优化后的报告字段应该是全量的，你看下是 43 个以上的字段吗？
 * > 这个字段有固定的字段模板吗？可编辑，可更新，可增加字段，删减字段？
 * > 更新的话，提供一个按钮，更新字段模板，点击后自动触发 ai 会话搜索，然后对搜索出来的结果
 * > 进行汇总分析，然后与现有模板对照，最后人工确认使用新模板，历史模板保留最近的一版，方便回滚，
 * > 模板字段，为实际优化提供字段列表。
 *
 * 在本功能之前，字段分散在两处**只读**的登记表里：
 * `src/domain/rules/attributes.js` 的 `ATTRIBUTES`（52 个类目属性，其中必填 43 个）
 * 与报告渲染里的 listing copy 字段清单。两张表都不能改、不能加、不能删，也**没有版本** ——
 * 于是「报告里为什么只有 9 行」这件事，没有任何地方能回答。
 *
 * ## 三个不可让步的性质
 * 1. **版本只增不改。** 每一版一行、永不 UPDATE 内容（与 `rule_set` / `product_line_version` 同一个做法）。
 *    这样「这一轮优化用的是哪一版模板」将来能被报告引用得住。
 * 2. **同一时刻最多一个 `active`。** 写新版时由本文件把旧的置 `superseded`，不靠调用方自觉。
 * 3. **回滚是另起一版**，不是把旧版改回 active —— 否则「谁在什么时候回滚过」就没有痕迹。
 */

import { nowIso } from './db.js'

export const TEMPLATE_ID = 'listing-optimize'
export const TEMPLATE_STATUSES = ['proposed', 'active', 'superseded']

/** 字段的两种来源：listing 正文（我们写的）与类目属性（产品事实，多半要人填）。 */
export const ITEM_KINDS = ['copy', 'attribute']

/**
 * 从两张**只读**登记表生成第一版（幂等）。
 *
 * 为什么是「生成」而不是写死在迁移里：`ATTRIBUTES` 是代码里的常量，
 * 把它的副本冻进 SQL 等于造出第二份真相；两者迟早不一致，而那种不一致没有告警。
 */
export function seedTemplateItems({ attributes, copyFields }) {
  const items = []
  for (const field of copyFields) {
    items.push({
      id: field.id,
      label: field.label,
      kind: 'copy',
      section: field.section ?? null,
      required: field.required !== false,
      limit: field.limit ?? null,
      source: 'listing',
      note: field.note ?? null,
    })
  }
  for (const id of Object.keys(attributes)) {
    const meta = attributes[id] ?? {}
    items.push({
      id: `attribute.${id}`,
      label: meta.label ?? id,
      kind: 'attribute',
      section: meta.section ?? 'attributes',
      required: meta.required === true,
      limit: null,
      source: 'ATTRIBUTES',
      note: meta.note ?? null,
    })
  }
  return items
}

function parse(json, fallback) {
  if (json === null || json === undefined || json === '') return fallback
  try { return JSON.parse(json) } catch { return fallback }
}

function hydrate(row) {
  if (row === null || row === undefined) return null
  return {
    templateId: row.template_id,
    version: Number(row.version),
    status: row.status,
    items: parse(row.items_json, []),
    diff: parse(row.diff_json, null),
    research: parse(row.research_json, null),
    note: row.note ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    confirmedBy: row.confirmed_by ?? null,
    confirmedAt: row.confirmed_at ?? null,
  }
}

/** 模板身份（不存在就是没建过 —— 与「建过但内容为空」不同）。 */
export function getTemplate(store, id = TEMPLATE_ID) {
  const row = store.get('SELECT id, name, note, updated_at FROM field_template WHERE id = ?', [id])
  return row === undefined || row === null
    ? null
    : { id: row.id, name: row.name, note: row.note ?? null, updatedAt: row.updated_at }
}

/** 当前生效的那一版；`status` 不传则只看 active。 */
export function getTemplateVersion(store, { id = TEMPLATE_ID, version = null, status = null } = {}) {
  const where = ['template_id = ?']
  const params = [id]
  if (version !== null && version !== undefined) { where.push('version = ?'); params.push(Number(version)) }
  if (status !== null && status !== undefined) { where.push('status = ?'); params.push(status) }
  const row = store.get(
    `SELECT * FROM field_template_version WHERE ${where.join(' AND ')} ORDER BY version DESC LIMIT 1`,
    params,
  )
  return hydrate(row)
}

export function listTemplateVersions(store, id = TEMPLATE_ID) {
  return store
    .all('SELECT * FROM field_template_version WHERE template_id = ? ORDER BY version DESC', [id])
    .map(hydrate)
}

/**
 * 两条清单的差异。**四个方向都算**（增 / 删 / 改 / 顺序），因为「字段从第 3 位挪到第 9 位」
 * 对「先写哪一格」是有意义的，而只比集合会把它判成没变。
 */
export function diffTemplateItems(before, after) {
  const beforeMap = new Map((before ?? []).map(item => [item.id, item]))
  const afterMap = new Map((after ?? []).map(item => [item.id, item]))
  const added = []
  const removed = []
  const changed = []
  for (const item of afterMap.values()) if (!beforeMap.has(item.id)) added.push({ id: item.id, label: item.label })
  for (const item of beforeMap.values()) if (!afterMap.has(item.id)) removed.push({ id: item.id, label: item.label })
  for (const item of afterMap.values()) {
    const old = beforeMap.get(item.id)
    if (old === undefined) continue
    const fields = ['label', 'kind', 'section', 'required', 'limit', 'note']
    const delta = fields.filter(field => JSON.stringify(old[field] ?? null) !== JSON.stringify(item[field] ?? null))
    if (delta.length > 0) changed.push({ id: item.id, fields: delta, before: old, after: item })
  }
  const beforeOrder = (before ?? []).map(item => item.id)
  const afterOrder = (after ?? []).map(item => item.id)
  return {
    added,
    removed,
    changed,
    reordered: JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder),
    counts: { before: beforeOrder.length, after: afterOrder.length },
    /* 一句人能读的结论，页面与工具都直接印它 —— 两处各算一遍必然漂移。 */
    summary: `+${added.length} / -${removed.length} / 改 ${changed.length}${JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder) ? ' / 顺序变了' : ''}`,
  }
}

function ensureTemplateRow(store, { id, name, note }) {
  const existing = getTemplate(store, id)
  if (existing !== null) return existing
  store.run(
    'INSERT INTO field_template (id, name, note, updated_at) VALUES (?, ?, ?, ?)',
    [id, name ?? id, note ?? null, nowIso()],
  )
  return getTemplate(store, id)
}

/**
 * 写一版新的。
 *
 * `status: 'active'` 时把当前 active 置 superseded（**同一事务**：先降级再升级，
 * 中途失败不会留下两个 active 或零个 active）。
 * `status: 'proposed'` 时不动 active —— 提案挂在旁边，等人确认。
 */
export function saveTemplateVersion(store, {
  id = TEMPLATE_ID,
  name = null,
  items,
  status = 'active',
  note = null,
  by = null,
  research = null,
} = {}) {
  if (!TEMPLATE_STATUSES.includes(status)) {
    throw new Error(`unknown template status "${status}" — known: ${TEMPLATE_STATUSES.join(', ')}`)
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('模板至少要有一个字段 —— 空模板等于「没有字段清单」，那不是一份模板')
  }
  const ids = items.map(item => String(item?.id ?? '').trim())
  if (ids.some(id2 => id2 === '')) throw new Error('每个字段都要有 id')
  const dupes = ids.filter((id2, index) => ids.indexOf(id2) !== index)
  if (dupes.length > 0) throw new Error(`字段 id 重复: ${[...new Set(dupes)].join(', ')}`)
  const badKind = items.find(item => !ITEM_KINDS.includes(item.kind))
  if (badKind !== undefined) {
    throw new Error(`字段 ${badKind.id} 的 kind 必须是 ${ITEM_KINDS.join(' / ')}`)
  }

  ensureTemplateRow(store, { id, name, note })
  const previous = getTemplateVersion(store, { id, status: 'active' })
  const maxRow = store.get('SELECT MAX(version) AS v FROM field_template_version WHERE template_id = ?', [id])
  const nextVersion = Number(maxRow?.v ?? 0) + 1
  const diff = previous === null ? null : diffTemplateItems(previous.items, items)
  const at = nowIso()

  store.run('BEGIN')
  try {
    if (status === 'active') {
      store.run(
        "UPDATE field_template_version SET status = 'superseded' WHERE template_id = ? AND status = 'active'",
        [id],
      )
    }
    store.run(
      `INSERT INTO field_template_version
       (template_id, version, status, items_json, diff_json, research_json, note, created_by, created_at, confirmed_by, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, nextVersion, status, JSON.stringify(items),
        diff === null ? null : JSON.stringify(diff),
        research === null ? null : JSON.stringify(research),
        note, by, at,
        status === 'active' ? by : null,
        status === 'active' ? at : null,
      ],
    )
    store.run('UPDATE field_template SET updated_at = ? WHERE id = ?', [at, id])
    if (name !== null) store.run('UPDATE field_template SET name = ? WHERE id = ?', [name, id])
    store.run('COMMIT')
  } catch (error) {
    store.run('ROLLBACK')
    throw error
  }
  return { version: getTemplateVersion(store, { id, version: nextVersion }), previous, diff }
}

/** 人工确认：「这一版提案就是新的生效模板」。 */
export function confirmTemplateVersion(store, { id = TEMPLATE_ID, version, by = null, note = null } = {}) {
  const target = getTemplateVersion(store, { id, version })
  if (target === null) throw new Error(`模板 ${id} 没有第 ${version} 版`)
  if (target.status === 'active') throw new Error(`模板 ${id} 第 ${version} 版已经是生效版本 —— 确认一次就够了`)
  if (target.status === 'superseded') {
    throw new Error(`模板 ${id} 第 ${version} 版已经被取代 —— 要恢复它请用 rollback（那会另起一版，保留痕迹）`)
  }
  const at = nowIso()
  store.run('BEGIN')
  try {
    store.run("UPDATE field_template_version SET status = 'superseded' WHERE template_id = ? AND status = 'active'", [id])
    store.run(
      "UPDATE field_template_version SET status = 'active', confirmed_by = ?, confirmed_at = ?, note = COALESCE(?, note) "
      + 'WHERE template_id = ? AND version = ?',
      [by, at, note, id, version],
    )
    store.run('UPDATE field_template SET updated_at = ? WHERE id = ?', [at, id])
    store.run('COMMIT')
  } catch (error) {
    store.run('ROLLBACK')
    throw error
  }
  return getTemplateVersion(store, { id, version })
}

/**
 * 回滚到上一版 —— **另起一版**，内容抄上一版生效的。
 *
 * 为什么不直接把旧版改回 active：那样「谁在什么时候回滚过」在库里就没有任何痕迹，
 * 而回滚恰恰是将来最需要被追问的一件事。
 */
export function rollbackTemplate(store, { id = TEMPLATE_ID, by = null, note = null, to = null } = {}) {
  const active = getTemplateVersion(store, { id, status: 'active' })
  if (active === null) throw new Error(`模板 ${id} 还没有生效版本 —— 没有可回滚的起点`)
  const versions = listTemplateVersions(store, id).filter(entry => entry.status !== 'proposed')
  const targetVersion = to ?? (versions.find(entry => entry.version < active.version)?.version ?? null)
  if (targetVersion === null) throw new Error(`模板 ${id} 没有更早的版本可回滚（当前 v${active.version}）`)
  const target = versions.find(entry => entry.version === Number(targetVersion))
  if (target === undefined) throw new Error(`模板 ${id} 没有第 ${targetVersion} 版`)
  const result = saveTemplateVersion(store, {
    id,
    items: target.items,
    status: 'active',
    by,
    note: note ?? `回滚到 v${target.version}（当前 v${active.version} 被取代）`,
  })
  return { ...result, rolledBackFrom: active.version, rolledBackTo: target.version }
}

/** 首次读取时把模板从只读登记表种出来（幂等：已有 version 就什么都不做）。 */
export function ensureTemplate(store, { attributes, copyFields, id = TEMPLATE_ID, name = 'Listing 优化字段模板' } = {}) {
  const existing = getTemplateVersion(store, { id, status: 'active' })
  if (existing !== null) return { created: false, version: existing }
  const items = seedTemplateItems({ attributes, copyFields })
  const result = saveTemplateVersion(store, { id, name, items, status: 'active', by: 'system:seed', note: '首次生成：来自 ATTRIBUTES 与 listing 字段登记表' })
  return { created: true, version: result.version }
}

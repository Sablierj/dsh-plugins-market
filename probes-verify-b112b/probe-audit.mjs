/* 探针 C：审计现实 —— 页面路由与工具各回滚一次，读 audit_log。 */
import { boot, draft, callRoute, frozenRows } from './harness.mjs'
import { upsertPrompt, promptHistory } from '../src/store/prompt.js'

const out = (...a) => console.log(...a)

function auditRows(store, objectId) {
  return store.all(
    'SELECT action, object_type, object_id, actor_kind, route, before_json, after_json, reason'
    + ' FROM audit_log WHERE object_id = ? ORDER BY at',
    [objectId],
  )
}

const app = boot()
try {
  // 造两条提示词，各编辑一次 → 各有一个冻结版本
  const a = upsertPrompt(app.store, draft({ body: 'A1：{{scope}}' }))
  upsertPrompt(app.store, draft({ id: a.id, body: 'A2：{{scope}}' }))
  const b = upsertPrompt(app.store, draft({ body: 'B1：{{scope}}' }))
  upsertPrompt(app.store, draft({ id: b.id, body: 'B2：{{scope}}' }))

  // ── 工具路径 ──
  const targetA = promptHistory(app.store, { id: a.id }).rows[0]
  const toolOut = await app.tool('amzn_prompt_rollback').execute({ id: a.id, snapshotId: targetA.id })
  out('工具返回首行：', String(toolOut).split('\n')[0])

  // ── 页面路由路径 ──
  await callRoute(app.api, 'POST', app.api.path + '/context', { module: 'prompts' })
  const targetB = promptHistory(app.store, { id: b.id }).rows[0]
  const res = await callRoute(app.api, 'POST', app.api.path + '/prompt-rollback', { id: b.id, snapshotId: targetB.id })
  out('路由响应：', res.status, String(res.text).slice(0, 160))

  out('\n--- audit_log（A：工具路径）---')
  for (const r of auditRows(app.store, a.id)) {
    out(JSON.stringify({ action: r.action, object_type: r.object_type, actor_kind: r.actor_kind, route: r.route, before: r.before_json ? JSON.parse(r.before_json).body : null, after: r.after_json ? JSON.parse(r.after_json).body : null }))
  }
  out('\n--- audit_log（B：页面路径）---')
  for (const r of auditRows(app.store, b.id)) {
    out(JSON.stringify({ action: r.action, object_type: r.object_type, actor_kind: r.actor_kind, route: r.route, before: r.before_json ? JSON.parse(r.before_json).body : null, after: r.after_json ? JSON.parse(r.after_json).body : null }))
  }

  const rollA = auditRows(app.store, a.id).filter(r => r.action === 'prompt.rollback')
  const rollB = auditRows(app.store, b.id).filter(r => r.action === 'prompt.rollback')
  out('\n=== 结论 ===')
  out(`工具路径有 prompt.rollback 行: ${rollA.length === 1}；object_type=prompt: ${rollA[0]?.object_type === 'prompt'}`)
  out(`页面路径有 prompt.rollback 行: ${rollB.length === 1}；object_type=prompt: ${rollB[0]?.object_type === 'prompt'}`)
  out(`两条 action 字符串相同: ${rollA[0]?.action === rollB[0]?.action}（${rollA[0]?.action} vs ${rollB[0]?.action}）`)

  // 同时看 page 路径有没有 prompt.save 行（rollback 不该记成 save）
  out(`B 的审计里同时有 prompt.save 行? ${auditRows(app.store, b.id).some(r => r.action === 'prompt.save')}`)
} finally { app.close() }
out('\n完成。')

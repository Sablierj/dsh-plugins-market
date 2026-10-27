/* 探针 A：store 层对抗性检查 —— 版本不变量 / 双上限 / 回滚不校验 / 归档 / 工具出口。 */
import { boot, draft, frozenRows } from './harness.mjs'
import { getPrompt, promptHistory, rollbackPrompt, upsertPrompt } from '../src/store/prompt.js'
import { listSnapshots, archiveSnapshot, snapshotView } from '../src/store/snapshot.js'

const out = (...a) => console.log(...a)

// ── A1: 冻结集合到底是不是 1..N ────────────────────────────────────────────
{
  out('\n===== A1 冻结集合 vs 编辑计数 =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: 'v1：{{scope}}' }))
    for (let n = 2; n <= 5; n += 1) upsertPrompt(app.store, draft({ id: p.id, body: `v${n}：{{scope}}` }))
    const row = getPrompt(app.store, p.id)
    const fr = frozenRows(app.store, p.id).map(r => Number(r.version)).sort((a, b) => a - b)
    out(`编辑计数 version = ${row.version}`)
    out(`冻结版本 = [${fr.join(', ')}]  共 ${fr.length} 个`)
    out(`是否相等（version === 冻结数）: ${row.version === fr.length}`)
    out(`差额 = ${row.version - fr.length}`)
  } finally { app.close() }
}

// ── A2: 归档一个冻结版本后，页面口径的「同一个数」是否还成立 ──────────────
{
  out('\n===== A2 归档冻结版本 vs 页面「同一个数」 =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: 'v1：{{scope}}' }))
    upsertPrompt(app.store, draft({ id: p.id, body: 'v2：{{scope}}' }))
    upsertPrompt(app.store, draft({ id: p.id, body: 'v3：{{scope}}' }))
    const row = getPrompt(app.store, p.id)
    const before = promptHistory(app.store, { id: p.id })
    out(`归档前：version=${row.version} 可回滚版本=${before.rows.length}`)
    const target = before.rows.find(r => r.version === '2')
    archiveSnapshot(app.store, target.id)
    const after = promptHistory(app.store, { id: p.id })
    const afterAll = promptHistory(app.store, { id: p.id, includeArchived: true })
    out(`归档 v2 后：version=${row.version} 默认可回滚=${after.rows.length}（含归档=${afterAll.rows.length}）`)
    out(`页面/工具用的默认口径 = ${after.rows.length}；「改过 ${row.version} 次」与它相等? ${row.version === after.rows.length}`)
    // 归档是否影响 promptHistory 的 total
    out(`promptHistory total（默认）= ${after.total}`)
  } finally { app.close() }
}

// ── A3: 两个上限 —— 页面 50 vs 工具 200 ──────────────────────────────────
{
  out('\n===== A3 页面 50 / 工具 200 两个上限 =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: 'v1：{{scope}}' }))
    for (let n = 2; n <= 55; n += 1) upsertPrompt(app.store, draft({ id: p.id, body: `v${n}：{{scope}}` }))
    const row = getPrompt(app.store, p.id)
    const page = promptHistory(app.store, { id: p.id, limit: 50 })
    const toolDefault = promptHistory(app.store, { id: p.id })     // 默认 200
    out(`编辑计数 = ${row.version}`)
    out(`页面切片 limit 50 → rows=${page.rows.length}, total=${page.total}`)
    out(`工具默认 limit 200 → rows=${toolDefault.rows.length}, total=${toolDefault.total}`)
    out(`工具出口会打印的行数（history.rows.length）= ${toolDefault.rows.length}，而 total=${toolDefault.total}`)
    out(`→ 页面在 51 版时会少画 ${row.version - page.rows.length} 版，而文案仍声称「同一个数」`)
  } finally { app.close() }
}

// ── A4: rollbackPrompt 不重跑 upsertPrompt 的校验 ────────────────────────
{
  out('\n===== A4 回滚写入不校验（人工造一条坏 payload 的快照） =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: '好稿：{{scope}}' }))
    // 直接插一条 payload 里 body 不解析的快照（模拟任何非 freezePromptRow 的写入）
    const badId = 'bbbbbbbb-0000-4000-8000-0000000000aa'
    app.store.run(
      `INSERT INTO snapshot_registry
         (id, object_type, object_id, version, payload_json, ref_table, ref_id, note, archived_at, created_at)
       VALUES (?, 'prompt', ?, '77', ?, NULL, NULL, '坏正文（测试造）', NULL, ?)`,
      [badId, p.id, JSON.stringify({
        body: '坏稿：{{#未闭合}} 以及 {{typo}}',
        label: '', scenario: 'button', layer: 'fixed', enabled: 9,
        variables_json: '[]', updated_at: '2020-01-01T00:00:00.000Z',
      }), '2026-09-01T00:00:00.000Z'],
    )
    const done = rollbackPrompt(app.store, { id: p.id, snapshotId: badId })
    const stored = getPrompt(app.store, p.id)
    out(`回滚后 body = ${JSON.stringify(stored.body)}`)
    out(`回滚后 label = ${JSON.stringify(stored.label)}  （原 label=${JSON.stringify(p.label)}）`)
    out(`回滚后 scenario/layer = ${stored.scenario}/${stored.layer}（button 带了 layer）`)
    out(`回滚后 variables = ${JSON.stringify(stored.variables)}（正文里有 {{typo}}）`)
    out(`回滚后 enabled = ${stored.enabled}`)
    out(`→ 坏正文写进库：${stored.body.includes('{{typo}}')}`)
    // 现在这条提示词还能不能渲染？promptEditor 会 renderTemplate(row.body)
    let renderErr = null
    try {
      const { renderTemplate } = await import('../src/domain/optimize/prompt.js')
      renderTemplate(stored.body, { scope: 'x' })
    } catch (e) { renderErr = e.message }
    out(`renderTemplate(坏正文) → ${renderErr === null ? '没有抛（意外）' : `抛：${renderErr}`}`)
    out(`→ 提示词页 route 会因此崩：${renderErr !== null}`)
  } finally { app.close() }
}

// ── A5: 回滚链上的版本不变量 + 冲突可达性 ────────────────────────────────
{
  out('\n===== A5 编辑→编辑→回滚→编辑→回滚 的不变量 =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: 'e1：{{scope}}' }))
    upsertPrompt(app.store, draft({ id: p.id, body: 'e2：{{scope}}' }))
    const t1 = promptHistory(app.store, { id: p.id }).rows.find(r => r.version === '1')
    rollbackPrompt(app.store, { id: p.id, snapshotId: t1.id })
    upsertPrompt(app.store, draft({ id: p.id, body: 'e4：{{scope}}' }))
    const t2 = promptHistory(app.store, { id: p.id }).rows.find(r => r.version === '2')
    rollbackPrompt(app.store, { id: p.id, snapshotId: t2.id })
    const row = getPrompt(app.store, p.id)
    const fr = frozenRows(app.store, p.id).map(r => Number(r.version)).sort((a, b) => a - b)
    out(`最终 version = ${row.version}`)
    out(`冻结版本 = [${fr.join(', ')}]`)
    const unique = new Set(fr).size === fr.length
    const contiguous = fr.every((v, i) => i === 0 || v === fr[i - 1] + 1)
    out(`无重复=${unique} 连续=${contiguous}`)
  } finally { app.close() }

  out('\n----- A5b 版本冲突（人工占位 version）时 tx 是否整体回滚 -----')
  const app2 = boot()
  try {
    const p = upsertPrompt(app2.store, draft({ body: 'c1：{{scope}}' }))
    // 预先占用 version='1' 的一条 prompt 快照，让下一次保存的 freeze 撞 UNIQUE
    app2.store.run(
      `INSERT INTO snapshot_registry
         (id, object_type, object_id, version, payload_json, ref_table, ref_id, note, archived_at, created_at)
       VALUES (?, 'prompt', ?, '1', ?, NULL, NULL, '占位', NULL, ?)`,
      ['cccccccc-0000-4000-8000-0000000000cc', p.id, JSON.stringify({ body: 'x' }), '2026-09-01T00:00:00.000Z'],
    )
    const beforeRow = getPrompt(app2.store, p.id)
    const beforeFrozen = frozenRows(app2.store, p.id).length
    let err = null
    try {
      upsertPrompt(app2.store, draft({ id: p.id, body: 'c2：{{scope}}' }))
    } catch (e) { err = e.message }
    const afterRow = getPrompt(app2.store, p.id)
    const afterFrozen = frozenRows(app2.store, p.id).length
    out(`保存抛错：${err === null ? '没有（意外）' : err}`)
    out(`version 前=${beforeRow.version} 后=${afterRow.version}（应当不变=回滚成功）`)
    out(`冻结条数 前=${beforeFrozen} 后=${afterFrozen}`)
  } finally { app2.close() }
}

// ── A7: 工具出口的诚实性（version>1 但 0 冻结；>200 冻结） ───────────────
{
  out('\n===== A7 工具出口 amzn_prompt_history =====')
  const app = boot()
  try {
    // 造一个「本批之前保存过」的行：直接 SQL 把 version 拉到 5，无冻结
    const p = upsertPrompt(app.store, draft({ body: '老稿：{{scope}}' }))
    app.store.run('UPDATE prompt SET version = 5 WHERE id = ?', [p.id])
    const viaTool = await app.tool('amzn_prompt_history').execute({ id: p.id })
    out('--- version=5 但 0 冻结 ---')
    out(viaTool)

    // 造 >200 冻结，验证工具打印 rows.length 而非 total
    const q = upsertPrompt(app.store, draft({ body: 'q1：{{scope}}' }))
    for (let n = 2; n <= 205; n += 1) {
      app.store.run(
        `INSERT INTO snapshot_registry
           (id, object_type, object_id, version, payload_json, ref_table, ref_id, note, archived_at, created_at)
         VALUES (?, 'prompt', ?, ?, ?, NULL, NULL, '批量造', NULL, ?)`,
        [`dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`, q.id, String(n - 1),
          JSON.stringify({ body: `q${n - 1}：{{scope}}`, label: 'x', scenario: 'button', layer: null, variables_json: '[]', enabled: 1, updated_at: '2026-09-01T00:00:00.000Z' }),
          `2026-09-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`],
      )
    }
    app.store.run('UPDATE prompt SET version = 206 WHERE id = ?', [q.id])
    const hist = promptHistory(app.store, { id: q.id })
    out(`\n--- version=206，库里冻结 ${frozenRows(app.store, q.id).length} 条 ---`)
    out(`promptHistory: rows=${hist.rows.length} total=${hist.total}`)
    const viaTool2 = await app.tool('amzn_prompt_history').execute({ id: q.id })
    const m = /冻结版本：(\d+) 个/.exec(viaTool2)
    out(`工具打印的冻结数 = ${m ? m[1] : '（没匹配到）'}；真实 total = ${hist.total}`)
    out(`→ 工具把截断后的 rows.length 当成了「冻结版本数」：${m && Number(m[1]) === hist.rows.length && hist.total > hist.rows.length}`)
  } finally { app.close() }
}

out('\n完成。')

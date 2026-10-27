/* 探针 E：快照页签里 prompt 行的顺序/差异 + 工具对「全新提示词」的措辞。 */
import { boot, draft, frozenRows } from './harness.mjs'
import { upsertPrompt, promptHistory } from '../src/store/prompt.js'
import { snapshotView } from '../src/store/snapshot.js'

const out = (...a) => console.log(...a)

const app = boot()
try {
  // 连续快速保存多次，看 created_at 是否会同毫秒 → 页签按 created_at DESC 排序时
  // 同一对象的「上一版」可能取到更高版本。
  const p = upsertPrompt(app.store, draft({ body: 'k1：{{scope}}' }))
  for (let n = 2; n <= 6; n += 1) upsertPrompt(app.store, draft({ id: p.id, body: `k${n}：{{scope}}` }))

  const rows = frozenRows(app.store, p.id)
  const stamps = rows.map(r => r.created_at)
  out('===== E1 created_at 是否唯一 =====')
  out(`冻结条数=${rows.length}，唯一时间戳=${new Set(stamps).size}`)
  out(`时间戳：${JSON.stringify(stamps)}`)

  const view = snapshotView(app.store, { snapshotType: 'prompt', snapshotObjectId: p.id })
  out('\n===== E2 快照页签对 prompt 行的排序与「上一版」 =====')
  out(`listSnapshots 返回顺序（created_at DESC, id DESC）版本号：${view.rows.map(r => r.version).join(', ')}`)
  for (const r of view.rows) {
    out(`  v${r.version}  previousId=${r.previousId ? '有' : 'null'}  changes=${r.changes === null ? 'null' : r.changes.map(c => c.field).join('|')}`)
  }
  // 「上一版」是否总是版本号 -1？
  const nums = view.rows.map(r => Number(r.version))
  let orderOk = true
  for (let i = 0; i < view.rows.length; i += 1) {
    const prev = view.rows[i].previousId
    if (prev === null) continue
    const j = view.rows.findIndex(r => r.id === prev)
    if (nums[j] !== nums[i] - 1) orderOk = false
  }
  out(`→ 每行的「上一版」都是版本号 -1（顺序没乱）? ${orderOk}`)

  // ── E3 工具对全新提示词（version=1，0 冻结）的措辞 ──
  const fresh = upsertPrompt(app.store, draft({ body: '全新：{{scope}}' }))
  const msg = await app.tool('amzn_prompt_history').execute({ id: fresh.id })
  out('\n===== E3 全新提示词（version=1，0 冻结）的工具输出 =====')
  out(msg)
  out(`→ 含「本批之前的旧稿没有被捕获」= ${String(msg).includes('本批之前的旧稿没有被捕获')}`)
  out(`→ 对一条刚建的提示词说「旧稿读不到」是假因果：${String(msg).includes('本批之前的旧稿没有被捕获')}`)
} finally { app.close() }
out('\n完成。')

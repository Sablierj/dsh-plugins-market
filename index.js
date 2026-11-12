/**
 * Host half of @local/wechat-session-bind.
 *
 * One operation, one place: POST /api/wechat-session-bind/state with
 * { action: 'bind', sessionId } binds WeChat to that session by pointing
 * dsh-wechat-workbench's pointer store at it and reloading the workbench row
 * so its in-memory pointer (loaded once at construction) re-reads the file.
 *
 * Effectiveness is verified, not assumed — and the proof has to be something
 * that still exists. dsh-wechat-workbench 0.1.2 writes no apply stamp (its
 * build.json stopped being updated when 0.1.2 replaced the locally patched
 * build on 2026-11-06), so reading build.json.appliedAt made every bind report
 * 「未生效」 forever even when the reload worked. The proof is now the
 * loader's own facts:
 *   1. setPluginEnabled() returns application === 'applied' (not a self-report),
 *   2. the row is enabled and fiberPhase === 'active' afterwards,
 *   3. that verdict is recorded in bind-state.json, so the next page load can
 *      answer 「已生效」 without guessing.
 *
 * The operation is deliberately user-only: it routes the user's WeChat
 * messages to a session, which is an authority decision — no agent tool.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const inject = ['connection', 'pluginManager']

const STORE_DIR = path.join(os.homedir(), '.dsh', 'wechat-workbench')
const POINTERS_FILE = path.join(STORE_DIR, 'pointers.json')
const DRIVEN_FILE = path.join(STORE_DIR, 'driven-sessions.json')
const BIND_FILE = path.join(STORE_DIR, 'bind-state.json')
/* The workbench row is addressed as `include:<id>` in this profile, but bare
   ids exist in other compositions — resolve at run time, fall back through
   the known forms. (A bare-id miss used to make the reload silently no-op:
   the file was written, the memory pointer kept the old session.) */
const WORKBENCH_ROW_FALLBACKS = ['include:wechat-workbench', 'wechat-workbench']

function readJson (file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Timestamped copy beside the file; binding is rare, so one backup per call is enough. */
function backup (file) {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const copy = `${file}.bak-bind-${stamp}`
  fs.copyFileSync(file, copy)
  return copy
}

function writeJson (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Resolve the workbench's PluginEntryId at run time. PluginInfo carries
 * `entryId` / `moduleName` (there is no `id` or `name` field), so match those
 * and fall back to the known literal forms.
 */
async function resolveRowId (pm) {
  try {
    const rows = await pm.listPlugins?.() ?? []
    const hit = rows.find(r => r?.moduleName === 'dsh-wechat-workbench')
      ?? rows.find(r => String(r?.entryId ?? '').endsWith('wechat-workbench'))
    if (hit?.entryId) return String(hit.entryId)
  } catch { /* fall back */ }
  return null
}

/** Is that row loaded right now? The loader's fiber phase, not our belief. */
async function rowIsActive (pm, rowId) {
  if (!rowId) return false
  try {
    const rows = await pm.listPlugins?.() ?? []
    const row = rows.find(r => String(r?.entryId ?? '') === rowId)
    return row !== undefined && row.enabled !== false && row.fiberPhase === 'active'
  } catch {
    return false
  }
}

/**
 * Disable→enable the workbench row. Returns { live, rowId, application, note }:
 * live is true only when the loader reported `applied` for both calls *and*
 * the row is active afterwards.
 */
async function reloadWorkbench (ctx) {
  const pm = ctx.get('pluginManager')
  if (!pm?.setPluginEnabled) {
    return { live: false, rowId: null, application: null, note: 'pluginManager 不可用；重启 DSH 后生效' }
  }
  const resolved = await resolveRowId(pm)
  const candidates = [resolved, ...WORKBENCH_ROW_FALLBACKS].filter((v, i, a) => v && a.indexOf(v) === i)
  let rowId = null
  let application = null
  let lastError = null
  for (const id of candidates) {
    try {
      const off = await pm.setPluginEnabled(id, false)
      const on = await pm.setPluginEnabled(id, true)
      const refused = [off, on].find(r => r && r.application !== 'applied')
      if (refused) {
        lastError = `行 ${id} 的应用结果 ${String(refused.application)}`
        continue
      }
      rowId = id
      application = String(on?.application ?? off?.application ?? 'applied')
      break
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
  }
  if (rowId === null) {
    return {
      live: false,
      rowId: null,
      application: null,
      note: `文件已写入，但重载未打中任何 workbench 行（${lastError ?? '未知'}）；重启 DSH 后生效`,
    }
  }
  if (!await rowIsActive(pm, rowId)) {
    return {
      live: false,
      rowId,
      application,
      note: `文件已写入，${rowId} 已重载（loader: ${application}）但当前不是 active；重启 DSH 后生效`,
    }
  }
  return { live: true, rowId, application, note: `已重载 ${rowId}（loader: ${application}），绑定即时生效` }
}

/**
 * Resolve the workspace that owns a session. The pointer keeps workspace +
 * session together because a WeChat conversation behaves like one open tab.
 * Order: explicit hint → registry scan → keep the conversation's current
 * workspace (a session switch inside the same workspace) → null (say so).
 */
function resolveWorkspaceId (ctx, sessionId, hint) {
  if (typeof hint === 'string' && hint.trim() !== '') return hint.trim()
  try {
    const registry = ctx.get('workspaceRegistry')
    for (const ws of registry?.list?.() ?? []) {
      const sessions = ws.sessions ?? ws.sessionIds ?? []
      if (sessions.includes?.(sessionId)) return ws.id ?? ws.workspaceId ?? null
    }
  } catch { /* registry unavailable: fall through */ }
  return null
}

export function apply (ctx, config) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

  const pointersMtime = () => {
    try { return fs.statSync(POINTERS_FILE).mtimeMs } catch { return 0 }
  }

  /* Live means: a bind was recorded for this very session, the pointer has not
     been touched since that record, and the workbench row is loaded now.
     Anything weaker would print 「已绑定」 over a stale router. */
  const isLive = async (sessionId) => {
    const record = readJson(BIND_FILE, null)
    if (!record || record.sessionId !== sessionId) return false
    if (!(Number(record.at) + 1000 >= pointersMtime())) return false
    return rowIsActive(ctx.get('pluginManager'), record.rowId)
  }

  const stateOf = async (sessionId) => {
    const pointers = readJson(POINTERS_FILE, {})
    const driven = readJson(DRIVEN_FILE, [])
    const conversations = Object.entries(pointers).map(([id, p]) => ({
      conversationId: id,
      workspaceId: p?.workspaceId ?? null,
      sessionId: p?.sessionId ?? null,
    }))
    const bound = typeof sessionId === 'string' && sessionId !== ''
      ? conversations.some(c => c.sessionId === sessionId)
      : false
    return {
      ok: true,
      storeDir: STORE_DIR,
      hasStore: fs.existsSync(STORE_DIR),
      conversations,
      driven: Array.isArray(driven) ? driven : [],
      bound,
      live: bound ? await isLive(sessionId) : null,
      bindRecord: readJson(BIND_FILE, null),
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/wechat-session-bind/state',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://x')
          return json(await stateOf(url.searchParams.get('sessionId')))
        }
        let body = {}
        try { body = await request.json() } catch { /* empty body: refuse below */ }
        const action = String(body?.action ?? '')
        if (action === 'state') return json(await stateOf(body?.sessionId))
        if (action !== 'bind') return json({ ok: false, error: `unknown action: ${action || '(empty)'}` }, 400)

        const sessionId = String(body?.sessionId ?? '').trim()
        if (sessionId === '') return json({ ok: false, error: 'sessionId is required' }, 400)

        const pointers = readJson(POINTERS_FILE, {})
        const entries = Object.entries(pointers)
        if (entries.length === 0) {
          return json({
            ok: false,
            error: '还没有任何微信会话记录（pointers.json 为空）。请先在微信里给机器人发一条消息完成首次绑定，再回到本会话点击绑定。',
          }, 409)
        }

        const workspaceId = resolveWorkspaceId(ctx, sessionId, body?.workspaceId)
          ?? entries.find(([, p]) => typeof p?.workspaceId === 'string')?.[1]?.workspaceId
          ?? null

        const pointerBackup = backup(POINTERS_FILE)
        const drivenBackup = backup(DRIVEN_FILE)

        const next = {}
        for (const [id, p] of entries) {
          next[id] = { ...(p ?? {}), sessionId, ...(workspaceId !== null ? { workspaceId } : {}) }
        }
        writeJson(POINTERS_FILE, next)

        const drivenList = readJson(DRIVEN_FILE, [])
        const driven = Array.isArray(drivenList) ? drivenList : []
        if (!driven.includes(sessionId)) driven.push(sessionId)
        writeJson(DRIVEN_FILE, driven)

        /* The workbench caches pointers in memory (loaded once in its apply),
           so a file write alone is not live. Reload the row and record the
           loader's verdict; only then claim 生效. */
        const reload = await reloadWorkbench(ctx)
        if (reload.live) {
          writeJson(BIND_FILE, {
            sessionId,
            at: Date.now(),
            rowId: reload.rowId,
            application: reload.application,
            note: reload.note,
          })
        }

        return json({
          ok: true,
          bound: true,
          live: reload.live,
          sessionId,
          workspaceId,
          conversations: Object.keys(next),
          driven: driven.length,
          backups: [pointerBackup, drivenBackup].filter(Boolean),
          rowId: reload.rowId,
          application: reload.application,
          note: reload.note,
        })
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    },
  }), 'wechat-session-bind: state/bind route')

  return {}
}

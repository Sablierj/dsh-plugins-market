/**
 * Host half of @local/wechat-session-bind.
 *
 * One operation, one place: POST /api/wechat-session-bind/state with
 * { action: 'bind', sessionId } binds WeChat to that session by pointing
 * dsh-wechat-workbench's pointer store at it and reloading the workbench row
 * so its in-memory pointer (loaded once at construction) re-reads the file.
 *
 * Effectiveness is verified, not assumed: the workbench stamps
 * build.json.appliedAt every time its apply runs, so liveness is "did that
 * stamp move after the pointer write" — not a self-report from the reload.
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
const BUILD_FILE = path.join(STORE_DIR, 'build.json')
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

/** The workbench's apply stamp: the only observable proof its pointer cache re-read. */
function appliedStamp () {
  return String(readJson(BUILD_FILE, {})?.appliedAt ?? '')
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Resolve the workbench's PluginEntryId at run time: exact name first, then
 * any row whose id ends with the row id. Falls back through known forms.
 */
async function resolveRowId (pm) {
  try {
    const rows = await pm.listPlugins?.() ?? []
    const hit = rows.find(r => r?.name === 'dsh-wechat-workbench')
      ?? rows.find(r => String(r?.id ?? '').endsWith('wechat-workbench'))
    if (hit?.id) return String(hit.id)
  } catch { /* fall back */ }
  return null
}

/**
 * Disable→enable the workbench row and wait for its apply stamp to move.
 * Returns { live, rowId, note } — live is false whenever the stamp did not
 * move, whatever the toggle calls claimed.
 */
async function reloadWorkbench (ctx) {
  const pm = ctx.get('pluginManager')
  if (!pm?.setPluginEnabled) {
    return { live: false, rowId: null, note: 'pluginManager 不可用；重启 DSH 后生效' }
  }
  const resolved = await resolveRowId(pm)
  const candidates = [resolved, ...WORKBENCH_ROW_FALLBACKS].filter((v, i, a) => v && a.indexOf(v) === i)
  const before = appliedStamp()
  let rowId = null
  let lastError = null
  for (const id of candidates) {
    try {
      const off = await pm.setPluginEnabled(id, false)
      const on = await pm.setPluginEnabled(id, true)
      const refused = [off, on].some(r => r && (r.ok === false || r.applied === false))
      if (!refused) { rowId = id; break }
      lastError = `行 ${id} 拒绝了禁启`
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
  }
  if (rowId === null) {
    return { live: false, rowId: null, note: `文件已写入，但重载未打中任何 workbench 行（${lastError ?? '未知'}）；重启 DSH 后生效` }
  }
  /* Poll the stamp: apply may land a beat after the enable call returns. */
  for (let i = 0; i < 10; i++) {
    await sleep(300)
    if (appliedStamp() !== before && appliedStamp() !== '') {
      return { live: true, rowId, note: `已重载 ${rowId}（apply ${appliedStamp()}），绑定即时生效` }
    }
  }
  return { live: false, rowId, note: `文件已写入，${rowId} 禁启已执行但 apply 标记未刷新；重启 DSH 后生效` }
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

  /* Live means: the workbench's apply stamp is at least as new as the pointer
     file — its cache demonstrably saw the write. Anything weaker would print
     「已绑定」 over a stale router. */
  const isLive = () => {
    try {
      const stamp = Date.parse(appliedStamp())
      const written = fs.statSync(POINTERS_FILE).mtimeMs
      return Number.isFinite(stamp) && stamp + 1000 >= written
    } catch {
      return false
    }
  }

  const stateOf = (sessionId) => {
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
      live: bound ? isLive() : null,
      appliedAt: appliedStamp() || null,
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
          return json(stateOf(url.searchParams.get('sessionId')))
        }
        let body = {}
        try { body = await request.json() } catch { /* empty body: refuse below */ }
        const action = String(body?.action ?? '')
        if (action === 'state') return json(stateOf(body?.sessionId))
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
           so a file write alone is not live. Reload the row and verify the
           stamp moved; only then claim 生效. */
        const reload = await reloadWorkbench(ctx)

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
          note: reload.note,
        })
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    },
  }), 'wechat-session-bind: state/bind route')

  return {}
}

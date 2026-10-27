/**
 * dsh-plugin-user-console - the persistent half of the DSH user console.
 *
 * Installed as a profile bundle, so both halves survive a Host restart:
 *
 *   config.plugin === 'vault'   local credentials vault
 *     - model tools: vault_list / vault_get / vault_save
 *     - a self-contained web page at /custom/vault (no client bundle needed)
 *
 *   config.plugin === 'memory'  TencentDB Agent Memory bridge
 *     - model tools: memory_recall / memory_save
 *     - reaches Memory Core on 47.251.253.188 through `ssh` from this process,
 *       because 8420 is published on the remote host but not reachable from
 *       this machine over the public internet.
 *
 * Plain ESM JavaScript: the profile runs the Host through tsx, and this file
 * is loaded by absolute path from cordis.patch.yml.
 *
 * Tool rows register through `ctx.tools.register` directly, so their
 * `output.schema` is raw JSON Schema and must stay inside the Host's enforced
 * subset: an omitted `type` means "any JSON value", and `type` otherwise has to
 * be one of object/array/string/number/integer/boolean/null. The author-only
 * `{ type: 'json' }` shorthand belongs to the `defineTool` DSL; passing it to
 * `register` throws UNSUPPORTED_SCHEMA, which fails the whole plugin tree and
 * with it every boot.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'user-console'

export const inject = ['fs', 'tools']

const VAULT_FILE = 'D:\\deepseek-harness-h\\workspace\\work-1\\vault\\credentials.json'
const WORKSPACE_ROOT = 'D:\\deepseek-harness-h\\workspace\\work-1'
const PAGE_PATH = '/custom/vault'

const CATEGORY_LABELS = {
  server: '服务器 / 主机',
  web: '网页后台登录',
  database: '数据库 / 缓存',
  'api-key': 'API 密钥 / Token',
  email: '邮箱账号',
  git: 'Git / 代码托管',
  'cloud-console': '云控制台',
  'local-secret': '本机密钥文件',
  other: '其他',
}

const CONFIDENCE_LABEL = { verified: '已实测', documented: '文档记录', stale: '已失效', unverified: '待确认' }

/* ─────────────────────────── vault storage ─────────────────────────── */

function emptyVault() {
  return { version: 1, updatedAt: new Date().toISOString(), title: '常用服务器 / 账号 / 凭据清单', entries: [] }
}

function loadVault() {
  try {
    if (!existsSync(VAULT_FILE)) return emptyVault()
    const parsed = JSON.parse(readFileSync(VAULT_FILE, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries)) return parsed
    return emptyVault()
  } catch (error) {
    return { version: 1, updatedAt: null, title: '（凭据库 JSON 解析失败）', entries: [], parseError: String(error?.message ?? error) }
  }
}

function saveVault(vault) {
  vault.updatedAt = new Date().toISOString()
  const dir = dirname(VAULT_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 2) + '\n', 'utf8')
  return vault
}

function mask(entry) {
  return {
    id: entry.id,
    category: entry.category ?? 'other',
    categoryLabel: CATEGORY_LABELS[entry.category] ?? entry.category ?? '其他',
    label: entry.label,
    host: entry.host ?? null,
    port: entry.port ?? null,
    url: entry.url ?? null,
    username: entry.username ?? null,
    hasSecret: Boolean(entry.secret),
    secretKind: entry.secretKind ?? null,
    authMethod: entry.authMethod ?? null,
    notes: entry.notes ?? null,
    source: entry.source ?? null,
    confidence: entry.confidence ?? null,
    needsUserInput: entry.needsUserInput === true,
  }
}

function matchEntry(entry, needle) {
  const hay = [entry.id, entry.label, entry.host, entry.url, entry.username, entry.category, entry.notes, entry.source]
  return hay.filter(part => typeof part === 'string').join(' ').toLowerCase().includes(needle)
}

function normalizeEntry(input, existing) {
  const base = existing ?? {}
  const pick = (field, fallback) => (input[field] !== undefined ? input[field] : (base[field] !== undefined ? base[field] : fallback))
  return {
    id: String(input.id ?? base.id ?? `entry-${Date.now()}`),
    category: String(pick('category', 'other')),
    label: String(pick('label', '（未命名）')),
    host: pick('host', null),
    port: pick('port', null),
    url: pick('url', null),
    username: pick('username', null),
    secret: pick('secret', null),
    secretKind: pick('secretKind', null),
    authMethod: pick('authMethod', null),
    notes: pick('notes', null),
    source: pick('source', null),
    confidence: pick('confidence', 'unverified'),
    needsUserInput: input.needsUserInput === undefined ? base.needsUserInput === true : input.needsUserInput === true,
  }
}

function upsertEntry(input) {
  const vault = loadVault()
  const index = vault.entries.findIndex(item => item.id === input.id)
  const entry = normalizeEntry(input, index >= 0 ? vault.entries[index] : undefined)
  if (index >= 0) vault.entries[index] = entry
  else vault.entries.push(entry)
  saveVault(vault)
  return { created: index < 0, entry }
}

function deleteEntry(id) {
  const vault = loadVault()
  const before = vault.entries.length
  vault.entries = vault.entries.filter(item => item.id !== id)
  saveVault(vault)
  return before - vault.entries.length
}

function pagePayload() {
  const vault = loadVault()
  const counts = {}
  for (const entry of vault.entries) {
    const key = entry.category ?? 'other'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return {
    title: vault.title || '常用服务器 / 账号 / 凭据清单',
    updatedAt: vault.updatedAt ?? null,
    total: vault.entries.length,
    counts,
    categoryLabels: CATEGORY_LABELS,
    confidenceLabels: CONFIDENCE_LABEL,
    file: VAULT_FILE,
    parseError: vault.parseError ?? null,
    entries: vault.entries.map(mask),
  }
}

const vaultText = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/* ─────────────────────────── vault web page ─────────────────────────── */

function renderPage(payload, revealed) {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c')
  const secrets = JSON.stringify(revealed).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${payload.title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 13px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f1115; color: #e6e8eb; }
  @media (prefers-color-scheme: light) { body { background: #f6f7f9; color: #1c1f24; } }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .dim { color: #8a8f98; font-size: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .chips { margin: 12px 0; }
  button.chip { padding: 4px 10px; font-size: 12px; border-radius: 999px; border: 1px solid #4a4f57; background: transparent; color: inherit; cursor: pointer; }
  button.chip.on { background: #4c8dff; border-color: #4c8dff; color: #fff; }
  input[type=search] { flex: 1 1 260px; padding: 7px 10px; border-radius: 6px; border: 1px solid #4a4f57; background: rgba(127,127,127,.12); color: inherit; }
  .card { border: 1px solid #33383f; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .label { font-weight: 600; font-size: 13px; }
  .badge { padding: 1px 7px; border-radius: 999px; font-size: 11px; }
  .b-verified { background: rgba(46,160,67,.18); color: #3fb950; }
  .b-documented { background: rgba(210,153,34,.18); color: #d29922; }
  .b-stale { background: rgba(248,81,73,.18); color: #f85149; }
  .b-unverified { background: rgba(127,127,127,.18); color: #8a8f98; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 2px 14px; font-size: 12px; }
  .k { color: #8a8f98; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
  .secret { margin-top: 6px; }
  .sec-val { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
  button.act { padding: 3px 9px; font-size: 12px; border-radius: 5px; border: 1px solid #4a4f57; background: transparent; color: inherit; cursor: pointer; }
  a.act { padding: 3px 9px; font-size: 12px; border-radius: 5px; border: 1px solid #4a4f57; color: inherit; text-decoration: none; }
  .details { margin-top: 6px; white-space: pre-wrap; font-size: 12px; }
  .warn { margin-top: 14px; padding: 8px 10px; border-radius: 6px; background: rgba(248,81,73,.12); color: #f0a9a4; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1 id="title"></h1>
  <div class="row"><span class="dim" id="meta"></span><span class="dim" id="file"></span></div>
  <div class="row chips" id="chips"></div>
  <div class="row"><input type="search" id="q" placeholder="搜索名称 / IP / 账号 / 备注…"><button class="act" id="refresh">刷新</button></div>
  <div id="list"></div>
  <div class="warn">本页含明文凭据，仅在 127.0.0.1 提供，请勿截图外发。</div>
</div>
<script id="vault-data" type="application/json">${data}</script>
<script id="vault-secrets" type="application/json">${secrets}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('vault-data').textContent)
  var secrets = JSON.parse(document.getElementById('vault-secrets').textContent)
  var filter = 'all'
  var query = ''

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function endpoint(entry) {
    if (entry.host && entry.port) return entry.host + ':' + entry.port
    if (entry.host) return entry.host
    return entry.url || ''
  }
  function conf(c) { return (data.confidenceLabels || {})[c] || c || '' }

  function draw() {
    document.getElementById('title').textContent = data.title
    document.getElementById('meta').textContent = '共 ' + data.total + ' 条' + (data.updatedAt ? ' · 更新于 ' + String(data.updatedAt).replace('T', ' ').slice(0, 19) : '')
    document.getElementById('file').textContent = data.file ? '· ' + data.file : ''

    var chips = '<button class="chip' + (filter === 'all' ? ' on' : '') + '" data-cat="all">全部 ' + data.entries.length + '</button>'
    Object.keys(data.counts).forEach(function (key) {
      chips += '<button class="chip' + (filter === key ? ' on' : '') + '" data-cat="' + esc(key) + '">'
        + esc((data.categoryLabels || {})[key] || key) + ' ' + data.counts[key] + '</button>'
    })
    document.getElementById('chips').innerHTML = chips

    var needle = query.trim().toLowerCase()
    var rows = data.entries.filter(function (entry) {
      if (filter !== 'all' && entry.category !== filter) return false
      if (!needle) return true
      var hay = [entry.label, entry.host, entry.url, entry.username, entry.notes, entry.id].filter(Boolean).join(' ').toLowerCase()
      return hay.indexOf(needle) !== -1
    })

    if (!rows.length) { document.getElementById('list').innerHTML = '<div class="dim">没有匹配的条目。</div>'; return }

    document.getElementById('list').innerHTML = rows.map(function (entry) {
      var pairs = [['主机', endpoint(entry)], ['账号', entry.username], ['凭据类型', entry.secretKind], ['认证方式', entry.authMethod], ['来源', entry.source]]
        .filter(function (pair) { return pair[1] })
      var html = '<div class="card">'
      html += '<div class="row"><span class="label">' + esc(entry.label) + '</span>'
      if (entry.confidence) html += '<span class="badge b-' + esc(entry.confidence) + '">' + esc(conf(entry.confidence)) + '</span>'
      if (entry.needsUserInput) html += '<span class="badge b-stale">待补充</span>'
      html += '<span class="dim">' + esc(entry.categoryLabel) + '</span></div>'
      if (pairs.length) {
        html += '<div class="grid">' + pairs.map(function (pair) {
          return '<div><span class="k">' + esc(pair[0]) + '：</span><span class="mono">' + esc(pair[1]) + '</span></div>'
        }).join('') + '</div>'
      }
      var revealed = Object.prototype.hasOwnProperty.call(secrets, entry.id)
      if (entry.hasSecret) {
        html += '<div class="row secret"><span class="k">' + (entry.secretKind === 'ssh-key-path' ? '密钥文件：' : '凭据：') + '</span>'
        html += '<span class="sec-val">' + (revealed ? esc(secrets[entry.id]) : '••••••••••') + '</span>'
        html += '<button class="act" data-reveal="' + esc(entry.id) + '">' + (revealed ? '隐藏' : '显示') + '</button>'
        if (revealed) html += '<button class="act" data-copy="' + esc(entry.id) + '">复制</button>'
        if (entry.url) html += '<a class="act" href="' + esc(entry.url) + '" target="_blank" rel="noreferrer">打开</a>'
        html += '</div>'
      } else {
        html += '<div class="row secret"><span class="badge b-unverified">尚无凭据值</span>'
        if (entry.url) html += '<a class="act" href="' + esc(entry.url) + '" target="_blank" rel="noreferrer">打开</a>'
        html += '</div>'
      }
      if (entry.notes) html += '<div class="details dim">说明：' + esc(entry.notes) + '</div>'
      html += '<div class="dim">id: ' + esc(entry.id) + '</div>'
      return html + '</div>'
    }).join('')
  }

  document.getElementById('chips').addEventListener('click', function (event) {
    var cat = event.target.getAttribute && event.target.getAttribute('data-cat')
    if (cat) { filter = cat; draw() }
  })
  document.getElementById('q').addEventListener('input', function (event) { query = event.target.value; draw() })
  document.getElementById('refresh').addEventListener('click', function () { location.reload() })
  document.getElementById('list').addEventListener('click', async function (event) {
    var target = event.target
    if (!target.getAttribute) return
    var revealId = target.getAttribute('data-reveal')
    if (revealId) { location.href = '${PAGE_PATH}?reveal=' + encodeURIComponent(revealId); return }
    var copyId = target.getAttribute('data-copy')
    if (copyId) {
      try { await navigator.clipboard.writeText(secrets[copyId]) ; target.textContent = '已复制' } catch (error) { target.textContent = '复制失败' }
    }
  })
  draw()
})()
</script>
</body>
</html>`
}

/* ─────────────────────────── memory bridge ─────────────────────────── */

const SSH_HOST = 'root@47.251.253.188'
const CORE_BASE = 'http://127.0.0.1:8420'
const SERVICE_ID = 'default'

/*
 * Shared memory namespace.
 *
 * These four ids are the isolation tuple TDAI keys every memory by: recall
 * returns only records written under the SAME tuple, so choosing them decides
 * whether DSH and Codex remember the same things.
 *
 * They are deliberately the ids Codex's own config.toml already sends to the
 * Memory Proxy (`x-team-id` / `x-agent-id` / `x-task-id`), because the bulk of
 * the history lives under that tuple (4049 L0 messages across 16 sessions). A
 * private id here would park DSH's memories in a store Codex never reads —
 * verified: the same query returned 2 records under a private agent id and 0
 * under this one.
 *
 * Convention for sharing: write only facts worth knowing on BOTH sides
 * (servers, credential locations, deployment decisions, user preferences,
 * environment gotchas). Step-by-step debugging narration stays in the session.
 * A deliberately separate namespace is always one `agentId` argument away.
 */
const SHARED_TEAM = 'team-3y551ln7pt'
const SHARED_USER = 'usr-3y48gk5rq1'
const SHARED_AGENT = 'agt-3y55a0snyu'
const SHARED_TASK = 'task-3y55os4zgc'

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Resolve the newest session id for a workspace, so proxy calls carry a stable conversation id. */
function newestSessionId(workspaceDir) {
  try {
    const encoded = '--' + workspaceDir.replace(/[\\:]/g, '-') + '--'
    const base = join(process.env.DSH_HOME ?? '', 'sessions', encoded)
    if (!existsSync(base)) return undefined
    let best
    let bestTime = 0
    for (const name of readdirSync(base)) {
      const full = join(base, name)
      try {
        const info = statSync(full)
        if (!info.isDirectory()) continue
        const stamp = statSync(join(full, 'session.v3.jsonl.zstd')).mtimeMs
        if (stamp > bestTime) { bestTime = stamp; best = name }
      } catch { /* not a session directory */ }
    }
    return best
  } catch {
    return undefined
  }
}

/* ─────────────────────────────── plugin ─────────────────────────────── */

export function apply(ctx, config = {}) {
  const which = config.plugin === 'memory' ? 'memory' : 'vault'

  if (which === 'vault') {
    ctx.tools.register(defineVaultList())
    ctx.tools.register(defineVaultGet())
    ctx.tools.register(defineVaultSave())

    // The page routes must wait for the webserver fiber to be active: reading
    // the service once with ctx.get() can run before that and silently leave
    // the page unregistered, which is how it went missing before.
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: PAGE_PATH,
        handler(req, res) {
          const url = new URL(req.url ?? PAGE_PATH, 'http://127.0.0.1')
          const revealId = url.searchParams.get('reveal')
          const revealed = {}
          if (revealId !== null) {
            const vault = loadVault()
            const entry = vault.entries.find(item => item.id === revealId)
            if (entry !== undefined && entry.secret) revealed[revealId] = entry.secret
          }
          const html = renderPage(pagePayload(), revealed)
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
        },
      }), 'user-console: vault page route')
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: '/custom/vault.json',
        handler(req, res) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(pagePayload(), null, 2))
        },
      }), 'user-console: vault json route')
      webCtx.logger?.info?.(`user-console: credentials page at ${PAGE_PATH}`)
      console.log(`[user-console] vault ready; page at http://127.0.0.1:3080${PAGE_PATH}; file=${VAULT_FILE}`)
    })
    return
  }

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    console.error('[user-console] memory bridge needs the subprocess service')
    return
  }

  const sshJson = (label, routePath, body) => new Promise((resolve, reject) => {
    // `__timeoutMs` is a transport hint, not part of the request: the auto-inject
    // prefetch wants a short leash so a slow link cannot pile up work, while a
    // model-facing tool call is happy to wait longer.
    const timeoutMs = Number.isFinite(body?.__timeoutMs) ? Number(body.__timeoutMs) : 25_000
    const clean = { ...(body ?? {}) }
    delete clean.__timeoutMs
    const payload = JSON.stringify(clean)
    const remote = `curl -sS --max-time ${Math.max(1, Math.round(timeoutMs / 1000))} -X POST ` + shellQuote(CORE_BASE + routePath)
      + ' -H ' + shellQuote('Content-Type: application/json')
      + ' -H ' + shellQuote('Authorization: Bearer dsh-user-console')
      + ' -H ' + shellQuote(`x-tdai-service-id: ${SERVICE_ID}`)
      + ' --data-binary @-'
    const handle = subprocess.spawn({
      argv: ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', SSH_HOST, remote],
      cwd: WORKSPACE_ROOT,
      stdio: {
        stdin: { data: payload },
        stdout: { maxBytes: 4 * 1024 * 1024 },
        stderr: { maxBytes: 256 * 1024 },
      },
      graceMs: 5000,
    })
    handle.done.then((outcome) => {
      const out = handle.collected.stdout?.readFrom(0)
      const err = handle.collected.stderr?.readFrom(0)
      const stdout = (out?.text ?? '').trim()
      const stderr = (err?.text ?? '').trim()
      if (!stdout) return reject(new Error(`tdai ${label} failed (exit=${outcome.exitCode}): ${stderr || 'empty response'}`))
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(new Error(`tdai ${label} returned non-JSON: ${stdout.slice(0, 300)}`))
      }
      if (parsed && parsed.code !== undefined && parsed.code !== 0) {
        return reject(new Error(`tdai ${label} error code=${parsed.code} ${parsed.message ?? ''}`))
      }
      resolve(parsed?.data ?? parsed)
    }, reject)
  })

  const scope = args => ({
    team_id: args?.teamId ? String(args.teamId) : SHARED_TEAM,
    agent_id: args?.agentId ? String(args.agentId) : SHARED_AGENT,
    user_id: SHARED_USER,
    task_id: args?.taskId ? String(args.taskId) : SHARED_TASK,
  })

  // Tool names are process-global, so two rows mounting this module would collide
  // on `memory_recall` and fail the whole tree. The dedicated auto-inject row sets
  // `registerTools: false` and contributes only the per-turn recall.
  const registerTools = config.registerTools !== false

  if (registerTools) ctx.tools.register({
    name: 'memory_recall',
    description: 'Recall what the long-term memory system already knows about a topic, person, server, account, or project. '
      + 'Reads the TencentDB Agent Memory store on 47.251.253.188 through this DSH process (no shell needed). '
      + 'Call it at the start of a task that may depend on earlier sessions, and before asking the user to repeat something.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall, as a topic or question, in Chinese or English.' },
        limit: { type: 'number', description: 'Maximum distilled memories to return. Default 8.' },
      },
      required: ['query'],
    },
    output: { schema: {}, render: (_args, value) => vaultText(value) },
    async execute(args) {
      const query = String(args?.query ?? '')
      if (!query) return { ok: false, error: 'query is required' }
      const limit = args?.limit ? Number(args.limit) : 8
      try {
        const atoms = await sshJson('atomic/search', '/v3/atomic/search', { query, limit, ...scope(args) })
        const exact = await sshJson('conversation/search', '/v3/conversation/search', { query, limit: Math.min(4, limit), ...scope(args) })
        return { ok: true, query, namespace: scope(args), distilled: atoms, exactWording: exact }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })

  if (registerTools) ctx.tools.register({
    name: 'memory_save',
    description: 'Write durable facts into the long-term memory system so a future session can recall them. Use it after '
      + 'learning something worth persisting: a server, credential location, password rotation, deployment decision, '
      + 'user preference, or project constraint. Store concrete facts, not the conversation itself.',
    parameters: {
      type: 'object',
      properties: {
        facts: { type: 'string', description: 'The facts to persist, as self-contained text. One topic per call is best.' },
        sessionId: { type: 'string', description: 'Optional stable session key; reuse it to keep one thread of memory together.' },
      },
      required: ['facts'],
    },
    output: { schema: {}, render: (_args, value) => vaultText(value) },
    async execute(args) {
      const facts = String(args?.facts ?? '')
      if (!facts) return { ok: false, error: 'facts is required' }
      const sessionId = args?.sessionId ? String(args.sessionId) : 'dsh-main-memory'
      try {
        const result = await sshJson('conversation/add', '/v3/conversation/add', {
          session_id: sessionId,
          messages: [
            { role: 'user', content: `[DSH 主 Agent 记忆同步] ${facts}` },
            { role: 'assistant', content: '已记录。' },
          ],
          ...scope(args),
        })
        return { ok: true, sessionId, namespace: scope(args), result }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })

  /*
   * ── 自动记忆注入（不需要 Memory Proxy）──────────────────────────────────
   *
   * 目标：不把 DSH 的模型调用改走 Proxy，也能达到「每轮自动带上相关记忆」。
   *
   * 关键约束：`PromptContext.text` 是**同步**的（字符串或同步函数），组装提示词
   * 时不能等一次 SSH 往返。所以这里不用同步查询，而是：
   *   agent/pre-step 拿到本轮用户消息 → 后台异步召回 → 写进缓存
   *   → text() 同步读缓存。召回落后一轮，但绝不会拖慢模型调用。
   *
   * 失败安全：SSH 不通、超时、无命中，都只是不注入，绝不让本轮失败。
   * 断路器：连续失败 3 次后停 5 分钟，避免网络抖动时每轮都白等一次。
   */
  // Opt-in, so the row that owns the memory tools does not also prefetch on every
  // turn: only the dedicated injection row turns this on.
  const autoInject = config.autoInject === true
  if (autoInject) {
    const INJECT_TIMEOUT_MS = 12_000
    const MIN_QUERY_CHARS = 6
    const MAX_ATOMS = 5
    const MAX_BLOCK_CHARS = 1400
    /*
     * 远端 /v3/atomic/search 对 query 有 2048 字符上限，超了直接 400
     * （`Too big: expected string to have <=2048 characters`），召回就白跑一次。
     * 所以这里自己先截断：保留开头——长消息（贴日志、贴代码）的主题通常在开头，
     * 后面是细节；召回匹配的是主题词，不是尾部。
     */
    const MAX_QUERY_CHARS = 2000
    const DEBOUNCE_MS = 3000
    const BREAK_AFTER_FAILURES = 3
    const BREAK_MS = 5 * 60_000

    let cache = { query: '', text: '', at: 0 }
    let lastQuery = ''
    let lastLookupAt = 0
    let failures = 0
    let openUntil = 0
    let pending = false

    const refresh = async (query) => {
      if (pending) return
      const now = Date.now()
      if (now < openUntil) return
      if (query === lastQuery && now - lastLookupAt < DEBOUNCE_MS) return
      pending = true
      lastQuery = query
      lastLookupAt = now
      try {
        const result = await sshJson('atomic/search', '/v3/atomic/search', {
          query,
          limit: MAX_ATOMS,
          team_id: SHARED_TEAM,
          agent_id: SHARED_AGENT,
          user_id: SHARED_USER,
          task_id: SHARED_TASK,
          __timeoutMs: INJECT_TIMEOUT_MS,
        })
        const items = Array.isArray(result?.items) ? result.items : []
        const lines = []
        for (const item of items) {
          const content = typeof item?.content === 'string' ? item.content.trim().replace(/\s+/g, ' ') : ''
          if (content === '') continue
          const short = content.length > 260 ? `${content.slice(0, 260)}…` : content
          lines.push(`- ${short}`)
          if (lines.length >= MAX_ATOMS) break
        }
        if (lines.length === 0) {
          cache = { query, text: '', at: Date.now() }
        } else {
          const body = lines.join('\n')
          const trimmed = body.length > MAX_BLOCK_CHARS ? `${body.slice(0, MAX_BLOCK_CHARS)}…` : body
          cache = {
            query,
            at: Date.now(),
            text: [
              '<team_memory source="TencentDB Agent Memory" scope="team-3y551ln7pt">',
              '以下是长期记忆里与本轮相关的既有事实（可能来自其它机器或 Codex），供参考：',
              trimmed,
              '注意：这些是历史结论，可能已过时。涉及版本号、价格、政策、发布状态等会变的事实，必须先核实再采信；与本轮实际观测冲突时，以实际观测为准。',
              '</team_memory>',
            ].join('\n'),
          }
        }
        failures = 0
      } catch (error) {
        failures++
        if (failures >= BREAK_AFTER_FAILURES) {
          openUntil = Date.now() + BREAK_MS
          failures = 0
          console.error(`[user-console] auto-inject paused ${BREAK_MS / 1000}s after repeated failures: ${error?.message ?? error}`)
        }
      } finally {
        pending = false
      }
    }

    // 本轮用户消息 = 召回查询。只取 text 块，跳过插件注入的运行时通知。
    ctx.on('agent/pre-step', (payload, next) => {
      try {
        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        for (let index = messages.length - 1; index >= 0; index--) {
          const message = messages[index]
          const source = message?.source
          if (source !== undefined && source?.kind !== 'user') continue
          const blocks = Array.isArray(message?.content) ? message.content : []
          const text = blocks
            .filter(block => block?.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('\n')
            .trim()
          if (text.length >= MIN_QUERY_CHARS) {
            void refresh(text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text)
            break
          }
        }
      } catch (error) {
        console.error(`[user-console] auto-inject query extraction failed: ${error?.message ?? error}`)
      }
      return next()
    })

    /*
     * 运行时上下文的插入位置是一个数字，由「中心表」分配。中心表 CONTEXT_ORDERS
     * 只登记了 SANDBOX_POLICY / APPROVAL_POLICY / SUBAGENT_DELEGATION 三个名字
     * （110-120）；`getContextOrder` 只认这三个名字，拿 section 的名字（例如
     * TOOL_CORDIS，那个在 SECTION_ORDERS 里）去问只会得到 undefined，而
     * `context()` 对非有限数直接抛错，整棵插件树跟着失败。所以这里用本模块自己
     * 的有限数 200：排在全部中心位置之后，又不占用它们的槽位。
     */
    const MEMORY_CONTEXT_ORDER = 200

    // inject 而不是 get：系统提示词服务可能在本行之后才挂载，取一次的实现会
    // 悄悄退化成「不注入」，而不是等到服务就绪再绑定。
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(() => promptCtx.systemPrompt.context({
        name: 'user-console:team-memory',
        order: MEMORY_CONTEXT_ORDER,
        text: () => {
          if (cache.text === '') return ''
          // 缓存超过 30 分钟视为过期，宁可少注入也不注入陈旧结论。
          if (Date.now() - cache.at > 30 * 60_000) return ''
          return cache.text
        },
      }), 'user-console: team memory context')
      console.log('[user-console] auto memory injection active (async prefetch, synchronous inject)')
    })
  }

  console.log(`[user-console] memory bridge ready via ssh ${SSH_HOST}; latest session=${newestSessionId(WORKSPACE_ROOT) ?? 'unknown'}`)
}

/* ─────────────────────────── vault tool helpers ─────────────────────────── */

function defineVaultList() {
  return {
    name: 'vault_list',
    description: 'List the local credentials vault (servers, web logins, database passwords, API keys, email accounts). '
      + 'Secrets are masked unless includeSecrets is true. Use it to answer questions like '
      + '"which IP / account / password do I use for X".',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'server | web | database | api-key | email | git | cloud-console | local-secret | other' },
        query: { type: 'string', description: 'Case-insensitive substring filter over id, label, host, url, username, notes, source.' },
        includeSecrets: { type: 'boolean', description: 'Include stored secret values. Default false.' },
      },
    },
    output: { schema: {}, render: (_args, value) => vaultText(value) },
    async execute(args) {
      const vault = loadVault()
      const category = args?.category && args.category !== 'all' ? String(args.category) : null
      const query = args?.query ? String(args.query).trim().toLowerCase() : null
      let rows = vault.entries
      if (category) rows = rows.filter(entry => (entry.category ?? 'other') === category)
      if (query) rows = rows.filter(entry => matchEntry(entry, query))
      const includeSecrets = Boolean(args?.includeSecrets)
      return {
        file: VAULT_FILE,
        updatedAt: vault.updatedAt ?? null,
        total: vault.entries.length,
        returned: rows.length,
        secretsIncluded: includeSecrets,
        entries: rows.map(entry => (includeSecrets ? { ...mask(entry), secret: entry.secret ?? null } : mask(entry))),
      }
    },
  }
}

function defineVaultGet() {
  return {
    name: 'vault_get',
    description: 'Reveal every stored field of one credentials-vault entry by id, including the secret value. '
      + 'Use when a concrete password, key, token, or SSH key path is actually needed.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Exact entry id from vault_list.' } },
      required: ['id'],
    },
    output: { schema: {}, render: (_args, value) => vaultText(value) },
    async execute(args) {
      const id = String(args?.id ?? '')
      const vault = loadVault()
      const entry = vault.entries.find(item => item.id === id)
      if (entry === undefined) return { ok: false, error: `no vault entry with id ${id}` }
      return { ok: true, entry }
    },
  }
}

function defineVaultSave() {
  return {
    name: 'vault_save',
    description: 'Create or update one entry in the local credentials vault so the user can find it later on the '
      + '账号与凭据 page (/custom/vault). Pass the full entry; omitted fields keep their previous value when updating.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable slug id.' },
        label: { type: 'string', description: 'Human readable name.' },
        category: { type: 'string', description: 'server | web | database | api-key | email | git | cloud-console | local-secret | other' },
        host: { type: 'string', description: 'IP or hostname.' },
        port: { type: 'number', description: 'TCP port.' },
        url: { type: 'string', description: 'Access URL.' },
        username: { type: 'string', description: 'Account or user id.' },
        secret: { type: 'string', description: 'Password, token, key, or key file path.' },
        secretKind: { type: 'string', description: 'password | token | ssh-key-path | authorization-code' },
        authMethod: { type: 'string', description: 'ssh-key | password | bearer | login' },
        notes: { type: 'string', description: 'Context worth remembering.' },
        source: { type: 'string', description: 'Where this value came from.' },
        confidence: { type: 'string', description: 'verified | documented | stale | unverified' },
        needsUserInput: { type: 'boolean', description: 'True when the value is still missing.' },
      },
      required: ['id'],
    },
    output: { schema: {}, render: (_args, value) => vaultText(value) },
    async execute(args) {
      if (!args?.id) return { ok: false, error: 'id is required' }
      const result = upsertEntry(args)
      return { ok: true, created: result.created, file: VAULT_FILE, id: result.entry.id }
    },
  }
}

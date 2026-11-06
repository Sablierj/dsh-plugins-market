/**
 * dsh-plugin-memory-bridge —— 把「腾讯开源的 TencentDB Agent Memory」接进 DSH。
 *
 * 一套插件，四件事：
 *   1. 模型工具：memory_recall / memory_save / memory_status；
 *   2. 侧边栏面板：连接状态、配置、诊断、启停、召回试跑；
 *   3. 可选的每轮自动召回（autoInject）：把相关旧事实注入系统提示词；
 *   4. 配置落在本机 JSON（DSH_HOME/storages/memory-bridge.json），面板改完即生效。
 *
 * 传输（2026-10-30 改）：不再走 ssh。记忆网关跑在客户端机器 127.0.0.1:8420，
 * 经 rathole 隧道由阿里云上的 workbuddy2api 面板用 /relay/<id> + X-Relay-Key 对外发布。
 * 所以本插件就是一台 HTTP 客户端：baseUrl + X-Relay-Key（+ 可选 Bearer）。
 *
 * 两套方言（同一个 8420，部署的版本不同，路由就不同）：
 *   v3（服务器上那套 tencentdb-agent-memory-v2）：/v3/atomic/search、/v3/conversation/append、
 *      /v3/scenario/ls、/v3/core/read，带 x-tdai-service-id，响应包 {code,message,data}。
 *   v1（GitHub 开源 gateway，src/gateway/server.ts）：/recall、/search/memories、/capture、
 *      /session/end，响应是裸对象 {results,total,strategy}。
 * dialect=auto 时先探 v3 再探 v1，探到哪个用哪个，结果缓存在内存里。
 *
 * 硬约束（踩过的坑，别改）：
 *   - `export const inject` 必须含 'tools'；webServer / systemPrompt 用 `ctx.inject` 等就绪再绑；
 *   - webServer 路由必须包在 `ctx.effect(...)` 里，否则重载后路由不重注册；
 *   - 工具返回值必须是无损 JSON（不能有 undefined / NaN）；output 必须 {schema, render} 都给；
 *   - 工具入口方法叫 execute；工具名是进程级全局，别和别的插件重名。
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const inject = ['tools']

const RELAY_URL = 'http://47.251.253.188:8080/relay/rl-b3edb436'

const DEFAULTS = {
  baseUrl: RELAY_URL,
  relayKey: '',
  bearer: '',
  dialect: 'auto',
  serviceId: 'default',
  teamId: 'local',
  agentId: 'shared',
  userId: 'misaka',
  taskId: '',
  sessionKey: 'dsh-desktop',
  timeoutMs: 20000,
  maxAtoms: 6,
  injectTimeoutMs: 4000,
  maxBlockChars: 4000,
  autoInject: false,
  // v0.4：记忆代理（LLM 转发）与日志
  proxyUrl: 'http://47.251.253.188:8080/relay/rl-c4628f30',
  proxyRuleId: 'rl-c4628f30',
  proxyClientId: 'cli-9164e6181daf',
  proxyLocalAddr: '127.0.0.1:8096',
  proxyKey: '',
  panelUrl: 'http://47.251.253.188:8080',
  panelKey: '',
  autoCapture: false,
  // 自动同步会话：每 N 分钟把还没传过的本地会话补传上去（后台跑，不阻塞对话）
  autoSyncSessions: true,
  autoSyncIntervalMin: 10,
  autoSyncLimit: 3,
  logRedact: true,
  maxLogLines: 2000,
  enabled: true,
}

const API_PATH = '/memory-bridge/api'
const CONTEXT_ORDER = 201
const MIN_QUERY_CHARS = 8
const MAX_QUERY_CHARS = 400
/** 存档上限（≠ 检索 query 上限）：写回 L0 时不要把用户长文截成 400 字。 */
const CAPTURE_MAX_CHARS = 4000

/** 便宜的字符串指纹，只用来判断"这一轮是不是已经写过"，不做安全用途。 */
const hashText = (text) => {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}
const BREAK_AFTER_FAILURES = 3
const BREAK_MS = 5 * 60_000
const DIALECT_TTL_MS = 5 * 60_000

/**
 * 配置文件放哪：DSH_HOME 在 Host 进程里不一定有（它由启动器决定），
 * 所以按 DSH_HOME → DSH_PROFILE_DIR 的上一级 → ~/.dsh 依次退，别退化成相对 cwd。
 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return fromEnv
  const profileDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  if (profileDir !== '') return dirname(dirname(profileDir))
  return join(homedir(), '.dsh')
}

const stateFile = () => join(dshHome(), 'storages', 'memory-bridge.json')

/* ── 会话文件：本地 → 远端 ───────────────────────────────────────
 *
 * DSH 把每个会话写成 <home>/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd。
 * 关键坑：一个文件是**多帧 zstd 拼接**（实测 8.5MB 里有 1450 帧），
 * Node 的 zstdDecompressSync 只解第一帧，所以必须按 magic 切帧逐个解。
 */
const sessionsRoot = () => join(dshHome(), 'sessions')
const sessionLedgerFile = () => join(dshHome(), 'storages', 'memory-bridge-sessions.json')
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

let ledgerCache = null
let ledgerAt = 0

const loadLedger = () => {
  if (ledgerCache !== null && Date.now() - ledgerAt < 3000) return ledgerCache
  try {
    ledgerCache = JSON.parse(readFileSync(sessionLedgerFile(), 'utf8'))
  } catch {
    ledgerCache = {}
  }
  ledgerAt = Date.now()
  return ledgerCache
}

const saveLedger = (ledger) => {
  try {
    mkdirSync(dirname(sessionLedgerFile()), { recursive: true })
    writeFileSync(sessionLedgerFile(), JSON.stringify(ledger, null, 2), 'utf8')
    ledgerCache = ledger
    ledgerAt = Date.now()
  } catch { /* 落盘失败不影响本轮结果，下次重试 */ }
}

const decodeSessionFile = (file) => {
  const buffer = readFileSync(file)
  const frames = []
  let start = 0
  for (let index = 1; index < buffer.length - 3; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
      frames.push(buffer.subarray(start, index))
      start = index
    }
  }
  frames.push(buffer.subarray(start))
  let text = ''
  for (const frame of frames) {
    try { text += zstdDecompressSync(frame).toString('utf8') } catch { /* 坏帧跳过 */ }
  }
  return text
}

/** 只解开头几帧：标题这类信息在日志最前面，没必要为 8MB 的文件全解一遍。 */
const decodeSessionHead = (file, maxFrames = 12) => {
  const buffer = readFileSync(file)
  const frames = []
  let start = 0
  for (let index = 1; index < buffer.length - 3; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
      frames.push(buffer.subarray(start, index))
      start = index
      if (frames.length >= maxFrames) break
    }
  }
  frames.push(buffer.subarray(start))
  let text = ''
  for (const frame of frames) {
    try { text += zstdDecompressSync(frame).toString('utf8') } catch { /* 坏帧跳过 */ }
  }
  return text
}

/** 从会话事件流里取最后一个标题（session/title）。 */
const titleOfEvents = (text) => {
  let title = ''
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (!line.includes('session/title')) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') {
        title = event.data.title.trim()
      }
    } catch { /* 忽略坏行 */ }
  }
  return title
}

const blockText = (blocks) => {
  if (typeof blocks === 'string') return blocks.trim()
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** 从会话事件流里抽「用户说 + 助手答」，其它事件（工具、推理、权限）一律不要。 */
const messagesOfSession = (text, limit) => {
  const out = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'user/message') {
      const content = blockText(event.data?.content)
      if (content !== '') out.push({ role: 'user', content: content.slice(0, CAPTURE_MAX_CHARS) })
    } else if (event.type === 'assistant/message') {
      const content = blockText(event.data?.message?.content)
      if (content !== '') out.push({ role: 'assistant', content: content.slice(0, CAPTURE_MAX_CHARS) })
    }
  }
  return limit === undefined ? out : out.slice(-limit)
}

const listSessionFiles = () => {  const root = sessionsRoot()
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (entry.name !== 'session.v4.jsonl.zstd') continue
      try {
        const stat = statSync(full)
        const folder = basename(dirname(full)).replace(/^session-/, '')
        found.push({ id: folder, file: full, bytes: stat.size, mtime: stat.mtimeMs })
      } catch { /* 单个文件读不了就跳过 */ }
    }
  }
  walk(root, 0)
  return found
}

/** 会话标题索引：projcache 里 cmp 存了 title 和首条 prompt，比解压 8MB 会话便宜得多。 */
const sessionTitles = () => {
  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  const map = {}
  let names = []
  try { names = readdirSync(dir) } catch { return map }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const rows = raw?.record?.rows ?? {}
      const title = rows.title?.val
      const first = rows.titleInput?.val?.first?.text
      map[id] = {
        title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '',
        first: typeof first === 'string' ? first.replace(/\s+/g, ' ').trim() : '',
      }
    } catch { /* 单个坏文件跳过 */ }
  }
  return map
}

/** projcache 里没有标题的会话（新会话还没落缓存），去会话文件头部读 session/title。带缓存，避免每次轮询都解压。 */
const titleByFileCache = new Map()
const titleForSession = (file, id) => {
  if (typeof file !== 'string' || file === '') return ''
  if (titleByFileCache.has(id)) return titleByFileCache.get(id)
  let title = ''
  try { title = titleOfEvents(decodeSessionHead(file)) } catch { title = '' }
  titleByFileCache.set(id, title)
  return title
}

/** 关键词匹配标题 + 首条消息；keywords 为空表示全部匹配。
 *  会话标题常常是英文项目名（amazon-ops / pdd），所以中文关键词要带同义词，
 *  否则「亚马逊」会一个都匹配不上（实测 0 个）。 */
const KEYWORD_ALIASES = {
  亚马逊: ['amazon', 'asin', 'listing', 'seller'],
  运营: ['amazon', 'listing', '运营', 'asin'],
  sif: ['sif'],
  拼多多: ['pdd', 'pinduoduo', '拼多多'],
  试用期: ['试用期', '转正', '考核', 'probation'],
  考核: ['考核', '试用期', '转正', 'probation'],
  转正: ['转正', '试用期', '考核', 'probation'],
}

const expandKeywords = (keywords) => {
  const out = []
  for (const word of keywords) {
    const key = String(word).toLowerCase()
    out.push(key)
    const alias = KEYWORD_ALIASES[key]
    if (Array.isArray(alias)) for (const item of alias) out.push(item.toLowerCase())
  }
  return [...new Set(out)].filter((item) => item !== '')
}

const matchesKeywords = (meta, keywords) => {
  if (!Array.isArray(keywords) || keywords.length === 0) return true
  const haystack = `${meta?.title ?? ''} ${meta?.first ?? ''}`.toLowerCase()
  return expandKeywords(keywords).some((word) => haystack.includes(word))
}

const sessionsSummary = (keywords = []) => {
  const ledger = loadLedger()
  const titles = sessionTitles()
  const files = listSessionFiles().filter((file) => matchesKeywords(titles[file.id], keywords))
  let synced = 0
  let failed = 0
  let unsynced = 0
  const recent = []
  for (const file of files) {
    const record = ledger[file.id]
    if (record?.ok === true) synced += 1
    else if (record?.ok === false) failed += 1
    else unsynced += 1
    recent.push({
      id: file.id,
      title: (titles[file.id]?.title || titles[file.id]?.first || '').slice(0, 60),
      mtime: file.mtime,
      mb: Math.round(file.bytes / 1024 / 10) / 100,
      state: record?.ok === true ? 'synced' : record?.ok === false ? 'failed' : 'pending',
      at: record?.at ?? 0,
      msgs: record?.msgs ?? 0,
      file: file.file,
    })
  }
  recent.sort((a, b) => b.mtime - a.mtime)
  // 缓存里没标题的（新会话还没写进 projcache），回落到会话文件头部的 session/title 事件
  const top = recent.slice(0, 8).map((item) => {
    if (item.title !== '') return item
    const fromFile = titleForSession(item.file, item.id)
    return fromFile === '' ? item : { ...item, title: fromFile.slice(0, 60) }
  })
  // 最后一次成功同步的时间点（全局，不受关键词过滤影响）
  let lastSyncedAt = 0
  for (const record of Object.values(ledger)) {
    if (record?.ok === true && Number.isFinite(record.at) && record.at > lastSyncedAt) lastSyncedAt = record.at
  }
  return { total: files.length, synced, unsynced, failed, keywords, lastSyncedAt, recent: top }
}


function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveState(next) {
  const file = stateFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

/* ── 本地追踪日志（jsonl，环形）─────────────────────────────────
 * 只记「发生了什么」，默认不记正文：排障看的是耗时/状态码/条数/错误摘要，
 * 记忆内容属于隐私，除非显式关掉 logRedact 才记首 200 字。
 */

const logFile = () => join(dshHome(), 'storages', 'memory-bridge.log.jsonl')

function appendLog(entry) {
  try {
    const file = logFile()
    mkdirSync(dirname(file), { recursive: true })
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
    let existing = ''
    try {
      existing = readFileSync(file, 'utf8')
    } catch {
      existing = ''
    }
    const maxLines = 2000
    let next = existing + line
    const lines = next.split('\n')
    if (lines.length > maxLines + 50) next = `${lines.slice(-maxLines).join('\n')}`
    writeFileSync(file, next, 'utf8')
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}

function readLogs(limit = 50) {
  try {
    const text = readFileSync(logFile(), 'utf8')
    const rows = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* 跳过坏行 */
      }
    }
    return rows.slice(-limit).reverse()
  } catch {
    return []
  }
}

const snippet = (text, redact) => {
  const value = typeof text === 'string' ? text : ''
  if (value === '') return ''
  return redact ? `#${value.length}` : value.slice(0, 200)
}

const mask = (secret) => {
  const text = typeof secret === 'string' ? secret : ''
  if (text === '') return ''
  return text.length <= 8 ? '••••' : `••••${text.slice(-4)}`
}

/**
 * 面板只回「有没有设」和遮罩，**从不回真值**。
 * 密钥字段在面板里是空输入框：留空 = 不改，填了 = 覆盖。
 * （别用「回遮罩值、靠 •••• 前缀判断没改」那套：字符串一过 JSON/终端就变形，
 *  变形后前缀判断失效，遮罩值会被当成新密钥写进配置——踩过。）
 */
function publicConfig(config) {
  return {
    baseUrl: config.baseUrl,
    relayKey: '',
    relayKeyMask: mask(config.relayKey),
    relayKeySet: config.relayKey !== '',
    bearer: '',
    bearerMask: mask(config.bearer),
    bearerSet: config.bearer !== '',
    dialect: config.dialect,
    serviceId: config.serviceId,
    teamId: config.teamId,
    agentId: config.agentId,
    userId: config.userId,
    taskId: config.taskId,
    sessionKey: config.sessionKey,
    timeoutMs: config.timeoutMs,
    maxAtoms: config.maxAtoms,
    injectTimeoutMs: config.injectTimeoutMs,
    autoInject: config.autoInject,
    proxyUrl: config.proxyUrl,
    proxyRuleId: config.proxyRuleId,
    proxyClientId: config.proxyClientId,
    proxyLocalAddr: config.proxyLocalAddr,
    proxyKey: '',
    proxyKeyMask: mask(config.proxyKey),
    proxyKeySet: config.proxyKey !== '',
    panelUrl: config.panelUrl,
    panelKey: '',
    panelKeyMask: mask(config.panelKey),
    panelKeySet: config.panelKey !== '',
    autoCapture: config.autoCapture,
    autoSyncSessions: config.autoSyncSessions,
    autoSyncIntervalMin: config.autoSyncIntervalMin,
    autoSyncLimit: config.autoSyncLimit,
    logRedact: config.logRedact,
    maxLogLines: config.maxLogLines,
    enabled: config.enabled,
  }
}

/** memory_browse 的文本视图：分层、按模式挑重点，不要把整个 JSON 倒给模型。 */
function browseText(value) {
  if (value?.error) return `错误：${value.error}`
  const lines = []
  if (value?.mode === 'logs') {
    const rows = Array.isArray(value.rows) ? value.rows : []
    if (rows.length === 0) return '还没有日志'
    return rows
      .map((row) => `- ${String(row.ts || '').slice(11, 19)} ${row.action}${row.status ? ` ${row.status}` : ''}${row.ms === null || row.ms === undefined ? '' : ` ${row.ms}ms`}${row.count === undefined ? '' : ` n=${row.count}`}${row.err ? ` err=${String(row.err).slice(0, 80)}` : ''}`)
      .join('\n')
  }
  if (value?.mode === 'overview') {
    lines.push(`网关 ${value.health || '未知'}${value.version ? ` v${value.version}` : ''} · 方言 ${value.dialect || '?'} · 命名空间 ${value.namespace}`)
    const counts = value.counts ?? {}
    lines.push(`L1 原子 ${counts.atoms === null || counts.atoms === undefined ? '（这个版本没这接口）' : counts.atoms} 条 · L2 场景 ${counts.scenes === null || counts.scenes === undefined ? '（同上）' : counts.scenes} 个 · L3 画像 ${value.personaChars ?? 0} 字`)
    if (value.personaHead) lines.push('', '画像开头：', value.personaHead)
    if (Array.isArray(value.scenesHead) && value.scenesHead.length > 0) {
      lines.push('', '场景（前几个）：')
      for (const entry of value.scenesHead) lines.push(`- ${entry.path}${entry.summary ? `｜${entry.summary}` : ''}`)
    }
    if (Array.isArray(value.unsupported) && value.unsupported.length > 0) lines.push('', `这层对话网关没有：${value.unsupported.join('、')}`)
    return lines.join('\n')
  }
  if (value?.mode === 'persona' || value?.mode === 'scene') {
    const head = value.mode === 'scene' ? `场景 ${value.path}（${value.chars} 字）` : `L3 画像（${value.chars} 字）`
    return [head, '', value.content === '' ? '（空）' : value.content.slice(0, 4000)].join('\n')
  }
  if (value?.mode === 'scenes') {
    const entries = Array.isArray(value.entries) ? value.entries : []
    if (entries.length === 0) return '没有任何场景块'
    return entries.map((entry) => `- ${entry.path}${entry.summary ? `\n  ${entry.summary}` : ''}`).join('\n')
  }
  if (value?.mode === 'atoms') {
    const items = Array.isArray(value.items) ? value.items : []
    if (items.length === 0) return `没有命中（query=${value.query}）`
    return items
      .map((item) => `- ${item.content}${item.scene ? ` 〔${item.scene}〕` : ''}${item.score === null ? '' : ` score=${item.score.toFixed(3)}`}`)
      .join('\n')
  }
  if (value?.mode === 'conversations') {
    const items = Array.isArray(value.items) ? value.items : []
    if (items.length === 0) return `没有命中（query=${value.query}）`
    return items.map((item) => `- [${item.role || '?'}] ${item.content}`).join('\n')
  }
  return JSON.stringify(value)
}

/** 工具结果给人看的文本（`output.render` 必需：缺了它整棵插件树都起不来）。 */
function toolText(value) {
  const lines = []
  if (value?.error) lines.push(`错误：${value.error}`)
  if (value?.disabled) lines.push('记忆服务已停用（侧边栏可启用）')
  if (Array.isArray(value?.distilled)) {
    if (value.distilled.length === 0) lines.push('没有召回任何条目')
    else for (const item of value.distilled) lines.push(`- ${item}`)
  }
  if (value?.sessionId) lines.push(`已写入会话 ${value.sessionId}`)
  if (value?.latencyMs !== undefined && value?.latencyMs !== null) lines.push(`连通性 ${value.latencyMs} ms`)
  if (value?.dialect) {
    const health = value.health ? ` · 网关 ${value.health}${value.version ? ` v${value.version}` : ''}` : ''
    lines.push(`方言 ${value.dialect}${health}`)
  }
  if (value?.proxyStatus !== undefined) {
    lines.push(`记忆代理：${value.proxyOk ? `${value.proxyStatus}${value.proxyUpstream ? ` → ${value.proxyUpstream}` : ''}` : `不可用（${value.proxyError || '未配置'}）`}`)
  }
  if (value?.upstream && value?.configHash !== undefined) {
    lines.push(`上游 ${value.upstream} · 配置 ${value.configHash || '—'}`)
  }
  if (value?.message) lines.push(value.message)
  if (value?.baseUrl) lines.push(`入口 ${value.baseUrl} · 命名空间 ${value.namespace}`)
  if (lines.length === 0) lines.push(JSON.stringify(value))
  return lines.join('\n')
}

function asInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function asId(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[A-Za-z0-9._:-]{0,64}$/u.test(text) ? text : fallback
}

const asUrl = (value, fallback) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^https?:\/\/\S+$/u.test(text) ? text.replace(/\/+$/u, '') : fallback
}

/** 把各种失败翻成人话：风控/隧道/令牌/方言，用户看这一行就知道该去修哪。 */
function describeFailure(status, bodyText, url) {
  const body = (bodyText ?? '').trim()
  const lower = body.toLowerCase()
  if (status === 401 && lower.includes('access key')) {
    return 'Relay Key 无效：面板侧 401（检查侧边栏里填的 rk_ 开头那串）'
  }
  if (status === 401) {
    return `网关 401：Bearer 令牌缺失或不匹配${body === '' ? '' : `（${body.slice(0, 120)}）`}`
  }
  if (status === 502 && lower.includes('upstream unreachable')) {
    return '隧道对端没起来：面板能连到隧道口，但客户端 127.0.0.1:8420 上没有记忆网关（502 upstream unreachable: EOF）'
  }
  if (status === 503 || status === 504) {
    return `网关不可用（${status}）${body === '' ? '' : `：${body.slice(0, 120)}`}`
  }
  if (status === 404) {
    return `路径不存在（404）：对端不是这个方言，跑一次「诊断」看它到底是 v1 还是 v3`
  }
  return `HTTP ${status}${body === '' ? '' : `：${body.slice(0, 200)}`}（${url}）`
}

export function apply(ctx, config = {}) {
  const persisted = loadState()
  let persistedAt = persisted.savedAt ?? 0

  let current = { ...DEFAULTS, ...(config ?? {}), ...(persisted.config ?? {}) }
  const stats = {
    recalls: 0,
    saves: 0,
    lastQuery: '',
    lastError: '',
    lastOkAt: 0,
    lastCheckAt: 0,
    lastCheckOk: null,
    lastLatencyMs: null,
    lastCheckError: '',
    dialect: '',
    dialectAt: 0,
    health: '',
    version: '',
    recall: { hit: 0, empty: 0, lastHit: 0 },
    // 自动捕获自检：面板上点「自检」就能回答「为什么没写进去」
    capture: {
      registered: { preStep: 0, turnStopping: 0, assistantStream: 0, statusIdle: 0, inboxClaimed: 0, sessionEvent: 0 },
      lastPreStepAt: 0,
      lastUserChars: 0,
      lastFlushAt: 0,
      lastFlushResult: '尚未触发',
      lastFlushReason: '',
      lastAssistantChars: 0,
      lastFrame: null,
      lastChunkFrame: null,
      lastTextChunk: null,
      lastSessionEvent: null,
      frameTypes: null,
      writes: 0,
      skips: 0,
    },
  }

  const disabled = () => current.enabled !== true
  const namespaceText = () => `${current.teamId}/${current.agentId}/${current.userId}`

  /** 从消息里取文本：DSH 各版本 content 可能是字符串、blocks、或带 text 字段，别只认一种。 */
  const textOf = (message) => {
    if (!message) return ''
    if (typeof message.content === 'string') return message.content.trim()
    if (Array.isArray(message.content)) {
      const parts = message.content
        .map((block) => (typeof block?.text === 'string' ? block.text : typeof block?.content === 'string' ? block.content : ''))
        .filter((part) => part !== '')
      if (parts.length > 0) return parts.join('\n').trim()
    }
    if (typeof message.text === 'string') return message.text.trim()
    return ''
  }

  /** 自检用：一条消息长什么样（截断保存，避免把正文塞进状态文件）。 */
  const shapeOf = (messages) => {
    const last = messages[messages.length - 1]
    if (!last) return { count: 0 }
    return {
      count: messages.length,
      kind: last?.source?.kind ?? null,
      contentType: typeof last?.content,
      blockTypes: Array.isArray(last?.content) ? last.content.map((block) => block?.type) : null,
      keys: Object.keys(last).slice(0, 8),
      preview: JSON.stringify(last).slice(0, 160),
    }
  }

  /**
   * 从 assistant 流式帧里取增量文本。
   * 实测本版本的帧是控制帧：{type:'start'} / {type:'chunk'} × N / {type:'end'}，
   * 文字藏在 chunk 里面（一层或两层），所以这里按白名单键递归找，而不是写死 frame.text。
   */
  const pickFrameText = (node, depth = 0) => {
    if (node === null || node === undefined || depth > 4) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map((item) => pickFrameText(item, depth + 1)).filter(Boolean).join('')
    if (typeof node === 'object') {
      for (const key of ['text', 'delta', 'content', 'chunk', 'value']) {
        if (key in node) {
          const found = pickFrameText(node[key], depth + 1)
          if (found !== '') return found
        }
      }
    }
    return ''
  }

  const textOfFrame = (frame) => {
    if (!frame) return ''
    if (frame.type === 'start' || frame.type === 'end') return ''
    if (typeof frame.text === 'string') return frame.text
    if (typeof frame.delta === 'string') return frame.delta
    if (typeof frame.deltaText === 'string') return frame.deltaText
    if (typeof frame.content === 'string') return frame.content
    return pickFrameText(frame.chunk ?? frame.delta ?? frame.content ?? null)
  }

  /** 自检用：流式帧长什么样。 */
  const shapeOfFrame = (frame) => {
    if (!frame) return { frame: null }
    return {
      type: typeof frame.type === 'string' ? frame.type : null,
      keys: Object.keys(frame).slice(0, 10),
      deltaType: typeof frame.delta,
      hasText: typeof frame.text === 'string',
      preview: JSON.stringify(frame).slice(0, 200),
    }
  }

  /** 自检用：任意一个会话事件长什么样。 */
  const shapeOfOne = (value) => {
    if (!value || typeof value !== 'object') return { value: typeof value }
    return {
      type: typeof value.type === 'string' ? value.type : null,
      keys: Object.keys(value).slice(0, 10),
      preview: JSON.stringify(value).slice(0, 220),
    }
  }

  /** 从会话事件里取助手正文：常见几种放法都试一遍。 */
  const messageText = (event) => {
    // 实测形状：{ type:'assistant/message', seq, time, data:{ turn, step, message:{ role, content:[...] } }, surfaceOp }
    const candidates = [
      event?.data?.message?.content,   // ← 本版本真实位置
      event?.message?.content,
      event?.content,
      event?.payload?.content,
      event?.data?.content,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
      if (Array.isArray(candidate)) {
        const text = candidate
          .filter((block) => block?.type === undefined || block.type === 'text')
          .map((block) => (typeof block?.text === 'string' ? block.text : typeof block?.content === 'string' ? block.content : ''))
          .filter(Boolean)
          .join('')
          .trim()
        if (text !== '') return text
      }
    }
    return ''
  }


  const scope = (args) => ({
    team_id: asId(args?.teamId, current.teamId),
    agent_id: asId(args?.agentId, current.agentId),
    user_id: asId(args?.userId, current.userId),
    task_id: asId(args?.taskId, current.taskId),
  })

  /* ── HTTP 传输 ──────────────────────────────────────────────── */

  const headersFor = (dialect) => {
    const headers = { 'content-type': 'application/json' }
    if (current.relayKey !== '') headers['x-relay-key'] = current.relayKey
    if (current.bearer !== '') headers.authorization = `Bearer ${current.bearer}`
    if (dialect === 'v3' && current.serviceId !== '') headers['x-tdai-service-id'] = current.serviceId
    return headers
  }

  /** 一次原始请求：返回 {status, json, text}；网络层失败直接抛，带人话。 */
  const request = async (routePath, options = {}) => {
    const method = options.method ?? 'POST'
    const url = `${current.baseUrl}${routePath}`
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : current.timeoutMs
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    let response
    try {
      response = await fetch(url, {
        method,
        headers: headersFor(options.dialect),
        body,
        signal: AbortSignal.timeout(Math.max(1000, Math.round(timeoutMs))),
      })
    } catch (error) {
      const name = error?.name ?? ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`请求超时（${timeoutMs} ms）：${url}`)
      }
      throw new Error(`连不上入口 ${current.baseUrl}：${error?.message ?? String(error)}`)
    }
    const text = await response.text()
    let json
    try {
      json = text === '' ? {} : JSON.parse(text)
    } catch {
      json = undefined
    }
    if (!response.ok) throw new Error(describeFailure(response.status, text, url))
    if (json === undefined) throw new Error(`对端返回非 JSON（${response.status}）：${text.slice(0, 200)}`)
    return { status: response.status, json }
  }

  /** 解包：v3 是 {code,message,data}，v1 是裸对象（错误时 {error}）。 */
  const unwrap = (json, routePath) => {
    if (json && typeof json === 'object' && 'code' in json) {
      if (json.code !== 0) throw new Error(`tdai ${routePath} code=${json.code} ${json.message ?? ''}`.trim())
      return json.data ?? {}
    }
    if (json && typeof json === 'object' && typeof json.error === 'string' && json.error !== '') {
      throw new Error(`tdai ${routePath}：${json.error}`)
    }
    return json ?? {}
  }

  const callV3 = async (routePath, body, timeoutMs) => {
    const { json } = await request(routePath, { body, dialect: 'v3', timeoutMs })
    return unwrap(json, routePath)
  }

  const callV1 = async (routePath, body, timeoutMs) => {
    const { json } = await request(routePath, { body, dialect: 'v1', timeoutMs })
    return unwrap(json, routePath)
  }

  const health = async (timeoutMs) => {
    const { json } = await request('/health', { method: 'GET', dialect: 'v1', timeoutMs })
    return json ?? {}
  }

  /** 探方言：先 v3 再 v1，命中即缓存。探不到返回 ''（并把错误留在 stats）。 */
  const detectDialect = async (force = false, timeoutMs) => {
    if (!force && stats.dialect !== '' && Date.now() - stats.dialectAt < DIALECT_TTL_MS) return stats.dialect
    if (current.dialect === 'v3' || current.dialect === 'v1') {
      stats.dialect = current.dialect
      stats.dialectAt = Date.now()
      return stats.dialect
    }
    const probeTimeout = Math.min(Number.isFinite(timeoutMs) ? timeoutMs : current.timeoutMs, 8000)
    try {
      await callV3('/v3/atomic/count', scope({}), probeTimeout)
      stats.dialect = 'v3'
      stats.dialectAt = Date.now()
      return 'v3'
    } catch { /* 继续试 v1 */ }
    try {
      await callV1('/search/memories', { query: 'ping', limit: 1 }, probeTimeout)
      stats.dialect = 'v1'
      stats.dialectAt = Date.now()
      return 'v1'
    } catch (error) {
      stats.dialect = ''
      stats.dialectAt = Date.now()
      throw error
    }
  }

  /* ── 三个动作 ───────────────────────────────────────────────── */

  const toLines = (blob) => {
    const text = typeof blob === 'string' ? blob : ''
    return text
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, '').trim())
      .filter((line) => line !== '')
  }

  const runRecall = async (query, limit) => {
    const asked = asInt(limit, current.maxAtoms, 1, 20)
    const dialect = await detectDialect(false)
    let distilled = []
    if (dialect === 'v3') {
      const data = await callV3('/v3/atomic/search', { query, limit: asked, ...scope() })
      const items = Array.isArray(data?.items) ? data.items : []
      distilled = items
        .map((item) => (typeof item?.content === 'string' ? item.content.trim().replace(/\s+/gu, ' ') : ''))
        .filter((text) => text !== '')
    } else {
      const data = await callV1('/search/memories', { query, limit: asked })
      distilled = toLines(data?.results).slice(0, asked)
    }
    return { query, namespace: namespaceText(), distilled: distilled.slice(0, asked), count: Math.min(distilled.length, asked), dialect }
  }

  const runSave = async (facts, sessionId) => {
    const dialect = await detectDialect(false)
    if (dialect === 'v3') {
      const body = { session_id: sessionId, messages: [{ role: 'user', content: facts }], ...scope() }
      try {
        await callV3('/v3/conversation/append', body)
      } catch (error) {
        // 老版本只有 /v3/conversation/add；append 不存在时退回去，别把事实丢了。
        const message = error?.message ?? ''
        if (!/404|路径不存在|code=404/u.test(message)) throw error
        await callV3('/v3/conversation/add', body)
      }
    } else {
      await callV1('/capture', {
        user_content: facts,
        assistant_content: '（DSH 记忆桥记录的事实）',
        session_key: sessionId,
      })
    }
    return { dialect }
  }

  const runStatus = async () => {
    const started = Date.now()
    const info = await health(Math.min(current.timeoutMs, 10000))
    const dialect = await detectDialect(true, Math.min(current.timeoutMs, 10000))
    const latencyMs = Date.now() - started
    stats.health = typeof info?.status === 'string' ? info.status : ''
    stats.version = typeof info?.version === 'string' ? info.version : ''
    return {
      latencyMs,
      dialect,
      health: stats.health,
      version: stats.version,
      uptime: Number.isFinite(info?.uptime) ? info.uptime : null,
    }
  }

  /* ── 记忆代理（MemoryProxy，LLM 转发）────────────────────────── */

  const proxyRequest = async (routePath, options = {}) => {
    const url = `${current.proxyUrl}${routePath}`
    const headers = { 'content-type': 'application/json' }
    if (current.proxyKey !== '') headers['x-relay-key'] = current.proxyKey
    let response
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(Math.max(1000, Math.min(current.timeoutMs, 15000))),
      })
    } catch (error) {
      throw new Error(`连不上记忆代理 ${current.proxyUrl}：${error?.message ?? String(error)}`)
    }
    const text = await response.text()
    let json
    try {
      json = text === '' ? {} : JSON.parse(text)
    } catch {
      json = undefined
    }
    if (!response.ok) throw new Error(describeFailure(response.status, text, url))
    if (json === undefined) throw new Error(`代理返回非 JSON：${text.slice(0, 160)}`)
    return json
  }

  const proxyStatus = async (quiet = false) => {
    const started = Date.now()
    const info = await proxyRequest('/health')
    const result = {
      ok: info?.status === 'ok',
      status: typeof info?.status === 'string' ? info.status : '',
      version: typeof info?.version === 'string' ? info.version : '',
      upstream: typeof info?.upstream === 'string' ? info.upstream : '',
      configHash: typeof info?.config?.hash === 'string' ? info.config.hash.slice(0, 12) : '',
      rateLimit: typeof info?.rateLimit === 'string' ? info.rateLimit : '',
      latencyMs: Date.now() - started,
    }
    // 面板自动刷新每 30s 打一次；那种调用不该把日志刷满，只记人工发起的
    if (quiet !== true) appendLog({ action: 'proxy.status', status: result.status, ms: result.latencyMs, err: '' })
    return result
  }

  /** 面板侧改 relay 规则的 enabled：先只读确认这条规则存在且能被 save 更新。 */
  const panelRequest = async (routePath, body) => {
    if (current.panelKey === '') throw new Error('未配置面板 api_key：代理开关需要它（设置页 → 高级）')
    const url = `${current.panelUrl}${routePath}`
    let response
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${current.panelKey}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      })
    } catch (error) {
      throw new Error(`连不上面板 ${current.panelUrl}：${error?.message ?? String(error)}`)
    }
    const text = await response.text()
    if (!response.ok) throw new Error(`面板 HTTP ${response.status}：${text.slice(0, 200)}`)
    try {
      return text === '' ? {} : JSON.parse(text)
    } catch {
      return { raw: text.slice(0, 200) }
    }
  }

  const proxySet = async (enabled) => {
    // 先看代理现在什么状态，避免「已经开着还去开」这种无意义写入
    const before = await proxyStatus().catch((error) => ({ ok: false, error: error?.message ?? String(error) }))
    // 关键：必须带 id + access_key，面板才会**原地更新**这条规则；
    // 只给 name/client_id 会新建一条（access_key 会变，所有客户端立刻断），实测过。
    const body = {
      id: current.proxyRuleId,
      name: '记忆代理（LLM 转发）',
      client_id: current.proxyClientId,
      local_addr: current.proxyLocalAddr,
      access_key: current.proxyKey,
      enabled,
    }
    const saved = await panelRequest('/panel/api/relay/save', body)
    appendLog({ action: enabled ? 'proxy.resume' : 'proxy.pause', status: saved?.ok === false ? 'fail' : 'ok', err: '' })
    return { before, saved }
  }

  /* ── 翻记忆库：L0 对话 / L1 原子 / L2 场景 / L3 画像 ──────────────
   *
   * v3（部署版）四层都有接口；v1（GitHub 开源 gateway）只有 L1/L0 的检索。
   * 拿不到的那一层如实说「这个版本没有」，绝不返回空数组冒充「没有记忆」。
   */

  const pickArray = (value, keys) => {
    for (const key of keys) {
      if (Array.isArray(value?.[key])) return value[key]
    }
    return null
  }

  const pickText = (value, keys) => {
    for (const key of keys) {
      if (typeof value?.[key] === 'string') return value[key]
    }
    return ''
  }

  const asAtom = (item) => ({
    id: typeof item?.id === 'string' ? item.id : String(item?.id ?? ''),
    content: typeof item?.content === 'string' ? item.content.trim() : '',
    type: typeof item?.type === 'string' ? item.type : '',
    scene: typeof item?.scene_name === 'string' ? item.scene_name : '',
    score: Number.isFinite(item?.score) ? item.score : null,
    background: typeof item?.background === 'string' ? item.background : '',
  })

  const asMessage = (item) => ({
    role: typeof item?.role === 'string' ? item.role : '',
    content: typeof item?.content === 'string' ? item.content.trim() : '',
    session: typeof item?.session_id === 'string' ? item.session_id : (typeof item?.session_key === 'string' ? item.session_key : ''),
    at: typeof item?.created_at === 'string' ? item.created_at : (Number.isFinite(item?.created_at) ? new Date(item.created_at).toISOString() : ''),
  })

  const browse = async (mode, args = {}) => {
    // 日志是本地的，不走网关也不看方言
    if (mode === 'logs') {
      return { mode, dialect: stats.dialect, rows: readLogs(asInt(args?.limit, 50, 1, 500)) }
    }
    const dialect = await detectDialect(false)
    const limit = asInt(args?.limit, 20, 1, 100)
    const query = typeof args?.query === 'string' ? args.query.trim() : ''

    if (dialect === 'v3') {
      if (mode === 'overview') {
        const info = await health(Math.min(current.timeoutMs, 10000))
        const counts = {}
        try {
          const total = await callV3('/v3/atomic/count', scope({}), Math.min(current.timeoutMs, 10000))
          counts.atoms = Number.isFinite(total?.total) ? total.total : null
        } catch { counts.atoms = null }
        let scenes = []
        try {
          const listed = await callV3('/v3/scenario/ls', { limit: 100, ...scope({}) }, Math.min(current.timeoutMs, 10000))
          scenes = pickArray(listed, ['entries', 'items', 'scenarios']) ?? []
          counts.scenes = scenes.length
        } catch { counts.scenes = null }
        let persona = ''
        try {
          const core = await callV3('/v3/core/read', scope({}), Math.min(current.timeoutMs, 10000))
          persona = pickText(core, ['content', 'text'])
        } catch { persona = '' }
        return {
          mode, dialect, namespace: namespaceText(),
          health: typeof info?.status === 'string' ? info.status : '',
          version: typeof info?.version === 'string' ? info.version : '',
          uptime: Number.isFinite(info?.uptime) ? info.uptime : null,
          stores: info?.stores ?? null,
          services: info?.services ?? null,
          counts,
          personaChars: persona.length,
          personaHead: persona === '' ? '' : persona.split(/\r?\n/u).slice(0, 3).join('\n').slice(0, 300),
          scenesHead: scenes.slice(0, 8).map((entry) => ({
            path: pickText(entry, ['path', 'name', 'file']),
            summary: pickText(entry, ['summary', 'title', 'description']),
          })),
        }
      }
      if (mode === 'persona') {
        const core = await callV3('/v3/core/read', scope({}))
        const content = pickText(core, ['content', 'text'])
        return { mode, dialect, content, chars: content.length }
      }
      if (mode === 'scenes') {
        const listed = await callV3('/v3/scenario/ls', { limit, ...scope({}) })
        const entries = pickArray(listed, ['entries', 'items', 'scenarios']) ?? []
        return {
          mode, dialect,
          entries: entries.slice(0, limit).map((entry) => ({
            path: pickText(entry, ['path', 'name', 'file']),
            summary: pickText(entry, ['summary', 'title', 'description']),
          })),
        }
      }
      if (mode === 'scene') {
        const path = typeof args?.path === 'string' ? args.path.trim() : ''
        if (path === '') throw new Error('读场景需要 path（先看场景列表）')
        const one = await callV3('/v3/scenario/read', { path, ...scope({}) })
        const content = pickText(one, ['content', 'text', 'body'])
        return { mode, dialect, path, content, chars: content.length }
      }
      if (mode === 'atoms') {
        if (query === '') throw new Error('搜原子需要 query')
        const data = await callV3('/v3/atomic/search', { query, limit, ...scope() })
        const items = pickArray(data, ['items', 'results', 'memories']) ?? []
        return { mode, dialect, query, items: items.slice(0, limit).map(asAtom) }
      }
      if (mode === 'conversations') {
        if (query === '') throw new Error('搜对话需要 query')
        const data = await callV3('/v3/conversation/search', { query, limit, ...scope() })
        const items = pickArray(data, ['items', 'messages', 'results']) ?? []
        return { mode, dialect, query, items: items.slice(0, limit).map(asMessage) }
      }
      throw new Error(`未知的浏览模式 ${mode}`)
    }

    // v1：只有 L1 检索与 L0 检索
    if (mode === 'overview') {
      const info = await health(Math.min(current.timeoutMs, 10000))
      return {
        mode, dialect: 'v1', namespace: namespaceText(),
        health: typeof info?.status === 'string' ? info.status : '',
        version: typeof info?.version === 'string' ? info.version : '',
        uptime: Number.isFinite(info?.uptime) ? info.uptime : null,
        stores: info?.stores ?? null,
        services: info?.services ?? null,
        counts: { atoms: null, scenes: null },
        personaChars: 0,
        personaHead: '',
        scenesHead: [],
        unsupported: ['persona', 'scenes', 'scene'],
      }
    }
    if (mode === 'atoms') {
      if (query === '') throw new Error('搜记忆需要 query')
      const data = await callV1('/search/memories', { query, limit })
      return {
        mode, dialect: 'v1', query,
        items: toLines(data?.results).slice(0, limit).map((content) => ({ id: '', content, type: '', scene: '', score: null, background: '' })),
        total: Number.isFinite(data?.total) ? data.total : null,
        strategy: typeof data?.strategy === 'string' ? data.strategy : '',
      }
    }
    if (mode === 'conversations') {
      if (query === '') throw new Error('搜对话需要 query')
      const data = await callV1('/search/conversations', { query, limit })
      return {
        mode, dialect: 'v1', query,
        items: toLines(data?.results).slice(0, limit).map((content) => ({ role: '', content, session: '', at: '' })),
        total: Number.isFinite(data?.total) ? data.total : null,
      }
    }
    throw new Error(`v1 网关没有「${mode}」这一层（只有 atoms 与 conversations）`)
  }

  /* ── 模型工具 ───────────────────────────────────────────────── */

  ctx.tools.register({
    name: 'memory_recall',
    description:
      'Recall what the long-term memory service (TencentDB Agent Memory, reached through the relay) already knows about '
      + 'a topic, person, server, account or project. Call it at the start of a task that may depend on earlier sessions, '
      + 'before asking the user to repeat.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall, as a topic or question (Chinese or English).' },
        limit: { type: 'number', description: 'How many distilled facts to return (1-20, default 6).' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          disabled: { type: 'boolean' },
          query: { type: 'string' },
          count: { type: 'number' },
          distilled: { type: 'array', items: { type: 'string' } },
          namespace: { type: 'string' },
          dialect: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: toolText(value) }],
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') return { ok: false, disabled: false, query, count: 0, distilled: [], error: 'query 不能为空' }
      if (disabled()) return { ok: false, disabled: true, query, count: 0, distilled: [], error: '记忆服务已在面板里停用' }
      try {
        const result = await runRecall(query, args?.limit)
        stats.recalls += 1
        stats.lastQuery = query
        stats.lastOkAt = Date.now()
        stats.lastError = ''
        return { ok: true, disabled: false, ...result }
      } catch (error) {
        const message = error?.message ?? String(error)
        stats.lastError = message
        return { ok: false, disabled: false, query, count: 0, distilled: [], error: message }
      }
    },
  })

  ctx.tools.register({
    name: 'memory_save',
    description:
      'Write durable facts into the long-term memory service (TencentDB Agent Memory): servers, credential locations, '
      + 'deployment decisions, user preferences, project constraints. Store facts, not the conversation.',
    parameters: {
      type: 'object',
      properties: {
        facts: { type: 'string', description: 'Self-contained facts, one topic per call.' },
        sessionId: { type: 'string', description: 'Optional stable session key to group these memories.' },
      },
      required: ['facts'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          disabled: { type: 'boolean' },
          sessionId: { type: 'string' },
          dialect: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: toolText(value) }],
    },
    async execute(args) {
      const facts = typeof args?.facts === 'string' ? args.facts.trim() : ''
      if (facts === '') return { ok: false, disabled: false, sessionId: '', error: 'facts 不能为空' }
      if (disabled()) return { ok: false, disabled: true, sessionId: '', error: '记忆服务已在面板里停用' }
      const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== ''
        ? args.sessionId
        : `${current.sessionKey}-${new Date().toISOString().slice(0, 10)}`
      try {
        const result = await runSave(facts, sessionId)
        stats.saves += 1
        stats.lastOkAt = Date.now()
        stats.lastError = ''
        return { ok: true, disabled: false, sessionId, dialect: result.dialect }
      } catch (error) {
        const message = error?.message ?? String(error)
        stats.lastError = message
        return { ok: false, disabled: false, sessionId, error: message }
      }
    },
  })

  ctx.tools.register({
    name: 'memory_status',
    description:
      'Report whether the long-term memory service is reachable right now, in three independent segments: gateway '
      + '(health + dialect + stores/pipeline), memory proxy (LLM forwarder), and the relay/tunnel itself. Read-only.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          enabled: { type: 'boolean' },
          autoInject: { type: 'boolean' },
          autoCapture: { type: 'boolean' },
          baseUrl: { type: 'string' },
          namespace: { type: 'string' },
          dialect: { type: 'string' },
          health: { type: 'string' },
          version: { type: 'string' },
          latencyMs: { type: 'number' },
          gatewayOk: { type: 'boolean' },
          proxyOk: { type: 'boolean' },
          proxyStatus: { type: 'string' },
          proxyUpstream: { type: 'string' },
          error: { type: 'string' },
          proxyError: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: toolText(value) }],
    },
    async execute() {
      const base = {
        enabled: current.enabled === true,
        autoInject: current.autoInject === true,
        autoCapture: current.autoCapture === true,
        baseUrl: current.baseUrl,
        namespace: namespaceText(),
      }
      // 网关
      let gateway = { ok: false, error: '', dialect: stats.dialect, health: '', version: '', latencyMs: null }
      try {
        const result = await runStatus()
        stats.lastCheckAt = Date.now()
        stats.lastCheckOk = true
        stats.lastLatencyMs = result.latencyMs
        stats.lastCheckError = ''
        gateway = { ok: true, error: '', ...result }
      } catch (error) {
        const message = error?.message ?? String(error)
        stats.lastCheckAt = Date.now()
        stats.lastCheckOk = false
        stats.lastLatencyMs = null
        stats.lastCheckError = message
        gateway = { ...gateway, ok: false, error: message }
      }
      // 代理（独立结论，不因为代理挂了就说网关挂了）
      let proxy = { ok: false, status: '', upstream: '', error: '' }
      try {
        const info = await proxyStatus()
        proxy = { ok: true, status: info.status, upstream: info.upstream, error: '' }
      } catch (error) {
        proxy = { ok: false, status: '', upstream: '', error: error?.message ?? String(error) }
      }
      appendLog({
        action: 'status',
        status: gateway.ok ? 'ok' : 'fail',
        ms: gateway.latencyMs ?? null,
        err: gateway.error ?? '',
        note: proxy.ok ? `proxy=${proxy.status}` : `proxy_err`,
      })
      return {
        ok: gateway.ok,
        ...base,
        dialect: gateway.dialect,
        health: gateway.health,
        version: gateway.version,
        latencyMs: gateway.latencyMs,
        gatewayOk: gateway.ok,
        error: gateway.error,
        proxyOk: proxy.ok,
        proxyStatus: proxy.status,
        proxyUpstream: proxy.upstream,
        proxyError: proxy.error,
      }
    },
  })

  ctx.tools.register({
    name: 'memory_proxy',
    description:
      'Inspect or switch the memory proxy (the LLM forwarder in front of the model upstream). '
      + 'status is read-only. pause/resume change what every client pointing at that proxy gets, '
      + 'so they require confirm=true and a panel api key in settings.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'status | pause | resume' },
        confirm: { type: 'boolean', description: 'Required true for pause/resume.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          status: { type: 'string' },
          upstream: { type: 'string' },
          version: { type: 'string' },
          configHash: { type: 'string' },
          latencyMs: { type: 'number' },
          message: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: toolText(value) }],
    },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action.trim() : 'status'
      try {
        if (action === 'status') {
          const info = await proxyStatus()
          return { ok: true, action, ...info }
        }
        if (action === 'pause' || action === 'resume') {
          if (args?.confirm !== true) {
            return {
              ok: false, action,
              message: `将要把记忆代理设为「${action === 'pause' ? '暂停' : '恢复'}」：所有把 base_url 指到它的客户端会立刻${action === 'pause' ? '断流' : '恢复'}。确认请带 confirm=true。`,
            }
          }
          const result = await proxySet(action === 'resume')
          return { ok: true, action, message: `已提交：${action === 'pause' ? '暂停' : '恢复'}代理`, ...result.saved }
        }
        return { ok: false, action, error: `未知动作 ${action}` }
      } catch (error) {
        return { ok: false, action, error: error?.message ?? String(error) }
      }
    },
  })

  ctx.tools.register({
    name: 'memory_browse',
    description:
      'Read the long-term memory library itself, layer by layer (TencentDB Agent Memory: L0 conversation, L1 atom, '
      + 'L2 scene, L3 persona). Use it to inspect what is stored rather than to answer a question: overview gives '
      + 'counts + gateway health, persona is the user profile, scenes/scene walk the scenario blocks, atoms and '
      + 'conversations are keyword searches. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'overview | persona | scenes | scene | atoms | conversations',
        },
        query: { type: 'string', description: 'Keyword for mode=atoms / conversations.' },
        path: { type: 'string', description: 'Scene path for mode=scene (get it from mode=scenes).' },
        limit: { type: 'number', description: 'Max rows (1-100, default 20).' },
      },
      required: ['mode'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          dialect: { type: 'string' },
          namespace: { type: 'string' },
          health: { type: 'string' },
          version: { type: 'string' },
          counts: { type: 'object' },
          personaChars: { type: 'number' },
          personaHead: { type: 'string' },
          content: { type: 'string' },
          path: { type: 'string' },
          chars: { type: 'number' },
          entries: { type: 'array', items: { type: 'object' } },
          items: { type: 'array', items: { type: 'object' } },
          unsupported: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: browseText(value) }],
    },
    async execute(args) {
      const mode = typeof args?.mode === 'string' ? args.mode.trim() : ''
      if (mode === '') return { ok: false, mode, error: 'mode 不能为空' }
      if (disabled()) return { ok: false, mode, error: '记忆服务已在面板里停用' }
      try {
        const result = await browse(mode, args)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, mode, error: error?.message ?? String(error) }
      }
    },
  })

  /* ── 侧边栏面板的后端 ───────────────────────────────────────── */

  const payload = () => ({
    ok: true,
    config: publicConfig(current),
    statePath: stateFile(),
    stats: {
      recalls: stats.recalls,
      saves: stats.saves,
      lastQuery: stats.lastQuery,
      lastError: stats.lastError,
      lastOkAt: stats.lastOkAt,
      lastCheckAt: stats.lastCheckAt,
      lastCheckOk: stats.lastCheckOk,
      lastLatencyMs: stats.lastLatencyMs,
      lastCheckError: stats.lastCheckError,
      dialect: stats.dialect,
      health: stats.health,
      version: stats.version,
      capture: stats.capture,
      recallQuality: stats.recall,
      injectShape: stats.injectShape ?? null,
    },
    persistedAt,
  })

  const applyPatch = (patch) => {
    const next = { ...current }
    if (patch?.baseUrl !== undefined) next.baseUrl = asUrl(patch.baseUrl, next.baseUrl)
    // 空字符串 = 用户没动这个字段，保留原密钥；填了才覆盖。
    if (typeof patch?.relayKey === 'string' && patch.relayKey.trim() !== '') next.relayKey = patch.relayKey.trim()
    if (typeof patch?.bearer === 'string' && patch.bearer.trim() !== '') next.bearer = patch.bearer.trim()
    if (patch?.dialect !== undefined) next.dialect = ['auto', 'v3', 'v1'].includes(patch.dialect) ? patch.dialect : next.dialect
    if (patch?.serviceId !== undefined) next.serviceId = asId(patch.serviceId, next.serviceId) || next.serviceId
    if (patch?.teamId !== undefined) next.teamId = asId(patch.teamId, next.teamId)
    if (patch?.agentId !== undefined) next.agentId = asId(patch.agentId, next.agentId)
    if (patch?.userId !== undefined) next.userId = asId(patch.userId, next.userId) || next.userId
    if (patch?.taskId !== undefined) next.taskId = asId(patch.taskId, next.taskId)
    if (patch?.sessionKey !== undefined) next.sessionKey = asId(patch.sessionKey, next.sessionKey) || next.sessionKey
    if (patch?.timeoutMs !== undefined) next.timeoutMs = asInt(patch.timeoutMs, next.timeoutMs, 3000, 180000)
    if (patch?.maxAtoms !== undefined) next.maxAtoms = asInt(patch.maxAtoms, next.maxAtoms, 1, 20)
    if (patch?.injectTimeoutMs !== undefined) next.injectTimeoutMs = asInt(patch.injectTimeoutMs, next.injectTimeoutMs, 1000, 30000)
    if (patch?.autoInject !== undefined) next.autoInject = patch.autoInject === true
    if (patch?.proxyUrl !== undefined) next.proxyUrl = asUrl(patch.proxyUrl, next.proxyUrl)
    if (patch?.proxyRuleId !== undefined) next.proxyRuleId = asId(patch.proxyRuleId, next.proxyRuleId) || next.proxyRuleId
    if (patch?.proxyClientId !== undefined) next.proxyClientId = asId(patch.proxyClientId, next.proxyClientId) || next.proxyClientId
    if (patch?.proxyLocalAddr !== undefined) next.proxyLocalAddr = asId(patch.proxyLocalAddr, next.proxyLocalAddr) || next.proxyLocalAddr
    if (typeof patch?.proxyKey === 'string' && patch.proxyKey.trim() !== '') next.proxyKey = patch.proxyKey.trim()
    if (patch?.panelUrl !== undefined) next.panelUrl = asUrl(patch.panelUrl, next.panelUrl)
    if (typeof patch?.panelKey === 'string' && patch.panelKey.trim() !== '') next.panelKey = patch.panelKey.trim()
    if (patch?.autoCapture !== undefined) next.autoCapture = patch.autoCapture === true
    if (patch?.autoSyncSessions !== undefined) next.autoSyncSessions = patch.autoSyncSessions === true
    if (patch?.autoSyncIntervalMin !== undefined) next.autoSyncIntervalMin = asInt(patch.autoSyncIntervalMin, next.autoSyncIntervalMin, 1, 240)
    if (patch?.autoSyncLimit !== undefined) next.autoSyncLimit = asInt(patch.autoSyncLimit, next.autoSyncLimit, 1, 50)
    if (patch?.logRedact !== undefined) next.logRedact = patch.logRedact === true
    if (patch?.maxLogLines !== undefined) next.maxLogLines = asInt(patch.maxLogLines, next.maxLogLines, 100, 20000)
    if (patch?.enabled !== undefined) next.enabled = patch.enabled === true
    return next
  }

  const applyAndPersist = (next) => {
    current = next
    persistedAt = Date.now()
    saveState({ config: current, savedAt: persistedAt })
    stats.dialect = ''
    stats.dialectAt = 0
    return persistedAt
  }

  /** 诊断：把「哪一跳断了」逐条打出来，面板直接展示。 */
  const diagnose = async () => {
    const steps = []
    const add = (name, ok, detail, latencyMs) => steps.push({ name, ok, detail, latencyMs: latencyMs ?? null })
    const started = Date.now()
    try {
      const info = await health(Math.min(current.timeoutMs, 10000))
      add('GET /health', true, `status=${info?.status ?? '?'} version=${info?.version ?? '?'} uptime=${info?.uptime ?? '?'}s`, Date.now() - started)
      stats.health = typeof info?.status === 'string' ? info.status : ''
      stats.version = typeof info?.version === 'string' ? info.version : ''
    } catch (error) {
      add('GET /health', false, error?.message ?? String(error), Date.now() - started)
      return { ok: false, steps, hint: '入口这一跳就断了：先确认 Base URL 与 Relay Key，再看隧道对端有没有起服务。' }
    }
    for (const [name, run] of [
      ['v3 /v3/atomic/count', () => callV3('/v3/atomic/count', scope({}), 8000)],
      ['v1 /search/memories', () => callV1('/search/memories', { query: 'ping', limit: 1 }, 8000)],
    ]) {
      const t0 = Date.now()
      try {
        await run()
        add(name, true, '可用', Date.now() - t0)
        if (stats.dialect === '') {
          stats.dialect = name.startsWith('v3') ? 'v3' : 'v1'
          stats.dialectAt = Date.now()
        }
      } catch (error) {
        add(name, false, error?.message ?? String(error), Date.now() - t0)
      }
    }
    const usable = steps.filter((step) => step.ok && step.name !== 'GET /health')
    if (usable.length === 0) {
      return { ok: false, steps, hint: '健康检查通了但两套方言都不通：多半是 Bearer 令牌不对（网关开了 TDAI_GATEWAY_API_KEY 就必须带）。' }
    }
    return { ok: true, steps, hint: `对端可用方言：${stats.dialect}` }
  }

  /**
   * 把本地会话文件上传成 L0。
   * 实测网关写 L0 很慢（约 1 秒/条），215 个会话不可能在一次 HTTP 请求里跑完，
   * 所以这里是「后台跑 + 面板轮询进度」：action 立即返回，进度写进 syncState。
   */
  const syncState = { running: false, done: 0, total: 0, ok: 0, failed: 0, lastError: '', startedAt: 0, finishedAt: 0, current: '', keywords: [] }

  const syncSessions = async (limit = 5, keywords = []) => {
    const ledger = loadLedger()
    const titles = sessionTitles()
    const pending = listSessionFiles()
      .filter((file) => ledger[file.id]?.ok !== true)
      .filter((file) => matchesKeywords(titles[file.id], keywords))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(1, limit))
    const results = []
    if (pending.length === 0) return { results, summary: sessionsSummary() }
    const dialect = await detectDialect(false)
    for (const file of pending) {
      syncState.current = titles[file.id]?.title !== undefined && titles[file.id]?.title !== ''
        ? titles[file.id].title.slice(0, 40)
        : file.id.slice(0, 8)
      try {
        // 只取最近 120 条：一个会话几千条事件，全传要几分钟，价值却在最近的部分
        const messages = messagesOfSession(decodeSessionFile(file.file), 120)
        if (messages.length === 0) {
          ledger[file.id] = { at: Date.now(), ok: true, msgs: 0, bytes: file.bytes, note: '空会话' }
          results.push({ id: file.id, ok: true, msgs: 0 })
          syncState.ok += 1
          continue
        }
        const sessionId = `session-${file.id}`
        // 网关写 L0 比检索慢得多：一次 50 条会 20s 超时（实测），改成 20 条一批、单批 90s。
        const SESSION_CHUNK = 20
        const SESSION_TIMEOUT = 90000
        for (let index = 0; index < messages.length; index += SESSION_CHUNK) {
          const chunk = messages.slice(index, index + SESSION_CHUNK)
          if (dialect === 'v3') {
            await callV3('/v3/conversation/add', { session_id: sessionId, messages: chunk, ...scope() }, SESSION_TIMEOUT)
          } else {
            await callV1('/capture', {
              user_content: chunk.filter((m) => m.role === 'user').map((m) => m.content).join('\n'),
              assistant_content: chunk.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n'),
              session_key: sessionId,
            }, SESSION_TIMEOUT)
          }
        }
        ledger[file.id] = { at: Date.now(), ok: true, msgs: messages.length, bytes: file.bytes }
        results.push({ id: file.id, ok: true, msgs: messages.length })
        syncState.ok += 1
        appendLog({ action: 'session.sync', status: 'ok', count: messages.length, chars: 0, note: file.id.slice(0, 8) })
      } catch (error) {
        const message = error?.message ?? String(error)
        ledger[file.id] = { at: Date.now(), ok: false, error: message, bytes: file.bytes }
        results.push({ id: file.id, ok: false, error: message })
        syncState.failed += 1
        syncState.lastError = message
        appendLog({ action: 'session.sync', status: 'fail', err: message, note: file.id.slice(0, 8) })
      } finally {
        syncState.done += 1
        saveLedger(ledger)
      }
    }
    syncState.current = ''
    syncState.finishedAt = Date.now()
    return { results, summary: sessionsSummary(keywords) }
  }

  /** 后台跑，立刻返回；面板轮询 sessions 看进度。 */
  const startSessionSync = (limit, keywords = []) => {
    if (syncState.running) return { started: false, reason: '已经有一轮在跑', sync: { ...syncState } }
    const ledger = loadLedger()
    const titles = sessionTitles()
    const pending = listSessionFiles()
      .filter((file) => ledger[file.id]?.ok !== true)
      .filter((file) => matchesKeywords(titles[file.id], keywords)).length
    if (pending === 0) return { started: false, reason: keywords.length > 0 ? `没有匹配「${keywords.join('、')}」的待同步会话` : '没有待同步的会话', sync: { ...syncState } }
    const queued = Math.min(limit, pending)
    syncState.running = true
    syncState.done = 0
    syncState.ok = 0
    syncState.failed = 0
    syncState.total = queued
    syncState.lastError = ''
    syncState.startedAt = Date.now()
    syncState.finishedAt = 0
    syncState.current = ''
    syncState.keywords = keywords
    void (async () => {
      try {
        await syncSessions(queued, keywords)
      } finally {
        syncState.running = false
      }
    })()
    return { started: true, queued, keywords, sync: { ...syncState } }
  }

  /* ── 自动同步会话（默认开，每 N 分钟补传一批）────────────────────
   * 每 60 秒醒一次，到点且没有在跑、还有未同步的就开一轮；
   * 只在后台跑，不阻塞对话，进度仍然走 syncState / 面板。
   */
  let lastAutoSyncAt = 0
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        if (current.autoSyncSessions !== true) return
        if (syncState.running) return
        const intervalMs = Math.max(1, current.autoSyncIntervalMin) * 60000
        if (Date.now() - lastAutoSyncAt < intervalMs) return
        if (sessionsSummary().unsynced === 0) return
        lastAutoSyncAt = Date.now()
        const started = startSessionSync(current.autoSyncLimit)
        if (started.started) appendLog({ action: 'session.autosync', status: 'ok', count: started.queued, chars: 0, note: '自动' })
      } catch (error) {
        appendLog({ action: 'session.autosync', status: 'fail', err: error?.message ?? String(error) })
      }
    }, 60000)
    return () => clearInterval(timer)
  })

  const handleAction = async (body) => {
    const action = typeof body?.action === 'string' ? body.action : ''
    if (action === 'sessions') {
      try {
        const keywords = Array.isArray(body?.keywords) ? body.keywords : []
        const summary = sessionsSummary(keywords)
        return { ok: true, action, ...summary, sync: { ...syncState } }
      } catch (error) {
        return { ok: false, action, message: `扫描会话失败：${error?.message ?? error}` }
      }
    }
    if (action === 'sync-sessions') {
      try {
        const limit = Number.isFinite(body?.limit) ? Math.min(Math.max(body.limit, 1), 50) : 3
        const started = startSessionSync(limit)
        const summary = sessionsSummary()
        return {
          ok: true,
          action,
          message: started.started ? `已开始后台同步（${started.queued} 个会话），进度看这里` : (started.reason ?? '未开始'),
          ...summary,
          sync: { ...syncState },
        }
      } catch (error) {
        return { ok: false, action, message: `同步失败：${error?.message ?? error}` }
      }
    }
    if (action === 'quick-setup') {
      const next = applyPatch({ enabled: true, autoInject: true, autoCapture: true })
      const savedAt = applyAndPersist(next)
      console.log('[memory-bridge] quick-setup: enabled autoInject autoCapture')
      return { ok: true, action, message: '已开启：自动召回 + 自动写回 + 启用', config: publicConfig(current), persistedAt: savedAt }
    }
    if (action === 'save') {
      const savedAt = applyAndPersist(applyPatch(body.config ?? {}))
      console.log(`[memory-bridge] config saved: base=${current.baseUrl} enabled=${current.enabled} autoInject=${current.autoInject}`)
      return { ok: true, action, message: '已保存', config: publicConfig(current), persistedAt: savedAt }
    }
    if (action === 'reset') {
      const next = { ...DEFAULTS, ...(config ?? {}) }
      // 默认值里没有密钥，恢复默认不能把用户填的密钥抹掉。
      next.relayKey = current.relayKey
      next.bearer = current.bearer
      const savedAt = applyAndPersist(next)
      return { ok: true, action, message: '已恢复默认（密钥保留）', config: publicConfig(current), persistedAt: savedAt }
    }
    if (action === 'enable' || action === 'disable') {
      const savedAt = applyAndPersist({ ...current, enabled: action === 'enable' })
      return { ok: true, action, message: current.enabled ? '记忆服务已启用' : '记忆服务已停用', config: publicConfig(current), persistedAt: savedAt }
    }
    if (action === 'test') {
      const started = Date.now()
      try {
        const result = await runStatus()
        stats.lastCheckAt = Date.now()
        stats.lastCheckOk = true
        stats.lastLatencyMs = result.latencyMs
        stats.lastCheckError = ''
        return { ok: true, action, message: `连接正常（${result.latencyMs} ms · ${result.dialect} · ${result.health}）`, latencyMs: result.latencyMs, stats: payload().stats }
      } catch (error) {
        const message = error?.message ?? String(error)
        stats.lastCheckAt = Date.now()
        stats.lastCheckOk = false
        stats.lastLatencyMs = null
        stats.lastCheckError = message
        return { ok: false, action, message: `连接失败：${message}`, error: message, stats: payload().stats }
      }
    }
    if (action === 'diagnose') {
      const report = await diagnose()
      return { ok: report.ok, action, message: report.hint, steps: report.steps, stats: payload().stats }
    }
    if (action === 'browse') {
      const mode = typeof body?.mode === 'string' && body.mode !== '' ? body.mode : 'overview'
      try {
        const result = await browse(mode, body ?? {})
        return { ok: true, action, ...result }
      } catch (error) {
        const message = error?.message ?? String(error)
        return { ok: false, action, mode, message, error: message }
      }
    }
    if (action === 'proxy-status') {
      try {
        const info = await proxyStatus(body?.quiet === true)
        return { ok: true, action, ...info }
      } catch (error) {
        const message = error?.message ?? String(error)
        return { ok: false, action, message, error: message }
      }
    }
    if (action === 'proxy-toggle') {
      const want = body?.enabled === true
      if (body?.confirm !== true) {
        return { ok: false, action, message: `将要把记忆代理${want ? '恢复' : '暂停'}：所有指向它的客户端会立刻${want ? '恢复' : '断流'}。请二次确认。`, needConfirm: true }
      }
      try {
        const result = await proxySet(want)
        return { ok: true, action, message: `已提交：${want ? '恢复' : '暂停'}代理`, ...result.saved }
      } catch (error) {
        const message = error?.message ?? String(error)
        return { ok: false, action, message, error: message }
      }
    }
    if (action === 'logs') {
      return { ok: true, action, rows: readLogs(asInt(body?.limit, 50, 1, 500)) }
    }
    if (action === 'recall') {
      const query = typeof body?.query === 'string' ? body.query.trim() : ''
      if (query === '') return { ok: false, action, message: 'query 不能为空' }
      if (disabled()) return { ok: false, action, message: '记忆服务已停用' }
      try {
        const result = await runRecall(query, body?.limit)
        stats.recalls += 1
        stats.lastQuery = query
        stats.lastOkAt = Date.now()
        stats.lastError = ''
        return { ok: true, action, ...result }
      } catch (error) {
        const message = error?.message ?? String(error)
        stats.lastError = message
        return { ok: false, action, message: `召回失败：${message}`, error: message }
      }
    }
    return { ok: false, action, message: `未知动作 ${action || '(空)'}` }
  }

  // 服务可能在本行之后才挂载：inject 等到就绪再绑，get 会静默退化成「面板没有路由」。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler(req, res) {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        if ((req.method ?? 'GET').toUpperCase() === 'GET') {
          send(200, payload())
          return
        }
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk
          if (raw.length > 64 * 1024) req.destroy()
        })
        req.on('end', () => {
          let body
          try {
            body = raw === '' ? {} : JSON.parse(raw)
          } catch {
            send(400, { ok: false, message: '请求体不是合法 JSON' })
            return
          }
          handleAction(body).then(
            (result) => send(200, result),
            (error) => send(500, { ok: false, message: error?.message ?? String(error) }),
          )
        })
        req.on('error', () => send(500, { ok: false, message: '请求读取失败' }))
      },
    }), 'memory-bridge: panel api')
    webCtx.logger?.info?.('[memory-bridge] panel api ready')
  })

  /* ── 每轮自动召回（可关）─────────────────────────────────────── */
  // 监听器**常驻注册**，开关在每次触发时读 current：
  // 之前把注册写在 if 里，面板上打开 autoInject 要等宿主重启才生效——「一键配置」等于点了没用。
  {
    let cache = { query: '', text: '', at: 0 }
    let pending = false
    let failures = 0
    let openUntil = 0

    const refresh = async (query) => {
      if (current.autoInject !== true) return
      if (pending || Date.now() < openUntil || disabled()) return
      if (query === cache.query && Date.now() - cache.at < 10 * 60_000) return
      pending = true
      try {
        const result = await runRecall(query, current.maxAtoms)
        const lines = []
        for (const content of result.distilled) {
          if (content === '') continue
          lines.push(`- ${content.length > 260 ? `${content.slice(0, 260)}…` : content}`)
          if (lines.length >= current.maxAtoms) break
        }
        if (lines.length === 0) {
          cache = { query, text: '', at: Date.now() }
          stats.recall.empty += 1
          stats.recall.lastHit = 0
        } else {
          stats.recall.hit += 1
          stats.recall.lastHit = lines.length
          const body = lines.join('\n')
          const trimmed = body.length > current.maxBlockChars ? `${body.slice(0, current.maxBlockChars)}…` : body
          cache = {
            query,
            at: Date.now(),
            text: [
              `<team_memory source="TencentDB Agent Memory" scope="${current.teamId}/${current.agentId}/${current.userId}">`,
              '以下是长期记忆里与本轮相关的既有事实（可能来自其它机器、桌面端或阿枢会话），供参考：',
              trimmed,
              '注意：这些是历史结论，可能已过时。涉及版本号、价格、政策、发布状态等会变的事实，必须先核实再采信；与本轮实际观测冲突时，以实际观测为准。',
              '</team_memory>',
            ].join('\n'),
          }
        }
        failures = 0
      } catch (error) {
        failures += 1
        stats.lastError = error?.message ?? String(error)
        if (failures >= BREAK_AFTER_FAILURES) {
          openUntil = Date.now() + BREAK_MS
          failures = 0
          console.error(`[memory-bridge] auto-recall 暂停 ${BREAK_MS / 1000}s：${stats.lastError}`)
        }
      } finally {
        pending = false
      }
    }

    // 主要钩子：用户消息离开收件箱 = 这一轮真正的「用户说了什么」。
    // pre-step 的 messages 多数 step 是空的（只有新消息的 step 才有），不能当唯一来源。
    ctx.on('agent/inbox/claimed', (payloadIn) => {
      try {
        const text = textOf(payloadIn?.message)
        stats.injectShape = { via: 'inbox/claimed', count: 1, chars: text.length }
        if (text.length >= MIN_QUERY_CHARS) {
          void refresh(text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text)
        }
      } catch (error) {
        console.error(`[memory-bridge] 收件箱取词失败：${error?.message ?? error}`)
      }
    })

    ctx.on('agent/pre-step', (payloadIn, next) => {
      try {
        const messages = Array.isArray(payloadIn?.messages) ? payloadIn.messages : []
        // 只在真有新消息时才覆盖自检信息，否则保留 inbox 那条
        if (messages.length > 0) stats.injectShape = shapeOf(messages)
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          const source = message?.source
          if (source !== undefined && source?.kind !== 'user') continue
          const text = textOf(message)
          if (text.length >= MIN_QUERY_CHARS) {
            void refresh(text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text)
            break
          }
        }
      } catch (error) {
        console.error(`[memory-bridge] 提取本轮问题失败：${error?.message ?? error}`)
      }
      return next()
    })

    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(() => promptCtx.systemPrompt.context({
        name: 'memory-bridge:team-memory',
        order: CONTEXT_ORDER,
        text: () => {
          if (cache.text === '') return ''
          if (Date.now() - cache.at > 30 * 60_000) return ''
          return cache.text
        },
      }), 'memory-bridge: team memory context')
      console.log('[memory-bridge] 自动召回已注册（按配置即时生效）')
    })
  }

  /* ── 自动捕获：把每轮对话写回 L0（默认关）─────────────────────
   *
   * 只写「用户说了什么 + 我回了什么」，L1/L2/L3 的提炼交给网关按自己的节奏做
   * （pipeline.everyNConversations）。插件不重复造轮子，也不在本地存正文。
   * 失败只记日志：捕获永远不许影响这一轮对话。
   */
  // 监听器常驻注册，开关在 flush 时读 current —— 面板打开即生效，不用重启宿主。
  {
    let pendingUser = ''
    let pendingTurn = -1
    let pendingSession = ''
    let assistantBuffer = ''
    let lastFlush = 0
    let lastWrittenKey = ''

    const flush = async (reason) => {
      const user = pendingUser.trim()
      const skip = (why) => {
        stats.capture.skips += 1
        stats.capture.lastFlushAt = Date.now()
        stats.capture.lastFlushResult = `跳过：${why}`
        stats.capture.lastFlushReason = reason
        return undefined
      }
      if (current.autoCapture !== true) return skip('开关未开')
      if (user === '' || disabled()) return skip(user === '' ? '没有用户文本' : '已停用')
      if (Date.now() - lastFlush < 1500) return skip('1.5s 去抖')
      // 去重：同一会话同一轮同一段话只写一次（多个触发点会同时命中）
      const dedupeKey = `${current.sessionKey}|${pendingTurn}|${user.length}|${hashText(user)}`
      if (dedupeKey === lastWrittenKey) return skip('重复轮次')
      lastFlush = Date.now()
      const messages = [{ role: 'user', content: user }]
      const assistant = assistantBuffer.trim()
      if (assistant !== '') messages.push({ role: 'assistant', content: assistant.slice(0, CAPTURE_MAX_CHARS) })
      // 会话 id 优先用宿主真实 session，退化到「会话键-日期」
      const sessionId = pendingSession !== ''
        ? pendingSession
        : `${current.sessionKey}-${new Date().toISOString().slice(0, 10)}`
      try {
        const dialect = await detectDialect(false)
        const send = async () => {
          if (dialect === 'v3') {
            await callV3('/v3/conversation/add', { session_id: sessionId, messages, ...scope() })
          } else {
            await callV1('/capture', {
              user_content: user,
              assistant_content: assistant === '' ? '（无）' : assistant.slice(0, CAPTURE_MAX_CHARS),
              session_key: sessionId,
            })
          }
        }
        try {
          await send()
        } catch (firstError) {
          // 网络抖动很常见：重试一次再判失败，避免整轮丢失
          await new Promise((resolve) => setTimeout(resolve, 400))
          await send()
          appendLog({ action: 'capture', status: 'ok', count: messages.length, chars: user.length + assistant.length, note: `${reason}（重试后成功）` })
        }
        lastWrittenKey = dedupeKey
        appendLog({ action: 'capture', status: 'ok', count: messages.length, chars: user.length + assistant.length, note: reason })
        stats.capture.writes += 1
        stats.capture.lastFlushAt = Date.now()
        stats.capture.lastFlushResult = `写入成功（${messages.length} 条 / 用户 ${user.length} 字${assistant === '' ? '，无回复' : ` + 回复 ${assistant.length} 字`}）`
        stats.capture.lastFlushReason = reason
      } catch (error) {
        appendLog({ action: 'capture', status: 'fail', err: error?.message ?? String(error), note: reason })
        stats.capture.lastFlushAt = Date.now()
        stats.capture.lastFlushResult = `写入失败：${error?.message ?? error}`
        stats.capture.lastFlushReason = reason
      } finally {
        pendingUser = ''
        pendingSession = ''
        assistantBuffer = ''
      }
    }

    // 主要钩子：用户消息离开收件箱 = 这一轮真正的「用户说了什么」
    ctx.on('agent/inbox/claimed', (payloadIn) => {
      try {
        const text = textOf(payloadIn?.message)
        stats.capture.lastUserChars = text.length
        if (text === '') return
        if (pendingUser !== '') void flush('next-turn')   // 上一轮没落库的先补
        // 捕获不截到 400 字：那是「检索 query」的上限，不是存档的上限
        pendingUser = text.length > CAPTURE_MAX_CHARS ? text.slice(0, CAPTURE_MAX_CHARS) : text
        pendingTurn = Number.isFinite(payloadIn?.turn) ? payloadIn.turn : -1
        pendingSession = typeof payloadIn?.agent?.sessionId === 'string'
          ? payloadIn.agent.sessionId
          : typeof payloadIn?.agent?.id === 'string' ? payloadIn.agent.id : ''
        assistantBuffer = ''
      } catch (error) {
        appendLog({ action: 'capture', status: 'fail', err: `inbox: ${error?.message ?? error}` })
      }
    })
    stats.capture.registered.inboxClaimed = 1

    ctx.on('agent/pre-step', (payloadIn, next) => {
      try {
        stats.capture.lastPreStepAt = Date.now()
        // 上一轮的尾巴还没落库：先补写，再开新一轮
        if (pendingUser !== '') void flush('next-turn')
        const turn = Number.isFinite(payloadIn?.turn) ? payloadIn.turn : -1
        const messages = Array.isArray(payloadIn?.messages) ? payloadIn.messages : []
        if (messages.length > 0) stats.capture.lastShape = shapeOf(messages)
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          const source = message?.source
          if (source !== undefined && source?.kind !== 'user') continue
          const text = textOf(message)
          if (text !== '') {
            pendingUser = text.length > CAPTURE_MAX_CHARS ? text.slice(0, CAPTURE_MAX_CHARS) : text
            pendingTurn = turn
            assistantBuffer = ''
            stats.capture.lastUserChars = pendingUser.length
            break
          }
        }
      } catch (error) {
        appendLog({ action: 'capture', status: 'fail', err: `pre-step: ${error?.message ?? error}` })
      }
      return next()
    })
    stats.capture.registered.preStep += 1

    ctx.on('agent/assistant-stream', (payloadIn) => {
      try {
        const frame = payloadIn?.frame
        stats.capture.lastFrame = shapeOfFrame(frame)
        const kind = typeof frame?.type === 'string' ? frame.type : 'unknown'
        if (!stats.capture.frameTypes) stats.capture.frameTypes = {}
        stats.capture.frameTypes[kind] = (stats.capture.frameTypes[kind] ?? 0) + 1
        // 留一个 chunk 真样，下次一眼看出文字在哪一层
        if (kind === 'chunk' && !stats.capture.lastChunkFrame) stats.capture.lastChunkFrame = shapeOfFrame(frame)
        const inner = typeof frame?.chunk?.type === 'string' ? frame.chunk.type : ''
        if (inner.includes('delta') && !stats.capture.lastTextChunk) stats.capture.lastTextChunk = shapeOfFrame(frame)
        if (pendingUser === '') return
        const text = textOfFrame(frame)
        if (text !== '') {
          stats.capture.textChunks = (stats.capture.textChunks ?? 0) + 1
          stats.capture.lastTextFrame = shapeOfFrame(frame)
          assistantBuffer += text
          stats.capture.lastAssistantChars = assistantBuffer.length
        } else if (kind !== 'end' && kind !== 'start') {
          // 非控制帧却取不到文字：留个样本，下次一眼看出字段在哪
          stats.capture.lastDeltaFrame = shapeOfFrame(frame)
        }
      } catch { /* 流式帧形状未知就放弃这一侧，用户侧仍然会写 */ }
    })

    // 本版本的 assistant-stream 只推控制帧与工具帧（实测 textChunks 恒为 0），
    // 所以助手正文改从「已提交的会话事件」里取：assistant/message 是持久事实。
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'assistant/message') return
        stats.capture.lastSessionEvent = shapeOfOne(event)
        if (pendingUser === '') return
        const text = messageText(event)
        if (text === '') return                 // 工具调用那几条不算正文
        if (assistantBuffer.includes(text)) return
        stats.capture.textChunks = (stats.capture.textChunks ?? 0) + 1
        // 一轮里可能有多条正文，累加；超过存档上限就停
        assistantBuffer = (assistantBuffer + (assistantBuffer === '' ? '' : '\n') + text).slice(0, CAPTURE_MAX_CHARS)
        stats.capture.lastAssistantChars = assistantBuffer.length
      } catch { /* 形状不符就放弃，用户侧仍然会写 */ }
    })
    stats.capture.registered.sessionEvent = 1

    ctx.on('agent/turn-stopping', async () => {
      // serial 模式：必须返回 Promise，否则事件链会挂起，capture 永远不执行
      await flush('turn-stopping')
    })
    // 兜底：turn-stopping 在某些会话（目标循环 / 长工具链）里不触发，
    // 但「状态回到 idle」一定会发生，用它保证每轮至少写一次。
    ctx.on('agent/status', async (payloadIn) => {
      if (payloadIn?.status !== 'idle') return
      await flush('idle')
    })
    stats.capture.registered.turnStopping += 1
    stats.capture.registered.assistantStream += 1
    stats.capture.registered.statusIdle += 1

    console.log('[memory-bridge] 自动捕获已注册（按配置即时生效）')
  }

  console.log(`[memory-bridge] ready: ${current.baseUrl} (relayKey=${current.relayKey === '' ? '未设置' : '已设置'}, bearer=${current.bearer === '' ? '未设置' : '已设置'}); enabled=${current.enabled} autoInject=${current.autoInject}; state=${stateFile()}; panel ${API_PATH}`)
}

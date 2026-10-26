/**
 * Host 侧：企业邮箱简历自动下载。
 *
 * 连接一个已登录腾讯企业邮（旧版 webmail）的 Chrome，把近 N 天里 BOSS 直聘发来的
 * 简历邮件的附件，下载到本机下载目录，并按 mailid 去重记账。
 *
 * 对外两张脸：
 *  - Agent 工具 mail_resume（status / scan / download / ledger / config / open / forget）
 *  - 面板 HTTP /mail-resume/api（GET 读状态，POST 触发动作）
 * 两边走同一套函数，不各写一份逻辑。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import * as cdp from './cdp.js'
import * as exmail from './exmail.js'

const STORE_DIR = join(homedir(), '.dsh-mail-resume')
const STORE_FILE = join(STORE_DIR, 'state.json')
const API_PATH = '/mail-resume/api'

const DEFAULT_SETTINGS = {
  cdpUrl: 'http://127.0.0.1:9333',
  mailUrl: 'https://exmail.qq.com/',
  folderName: 'boss直聘',
  senderFilter: '直聘',
  jobFilter: '',
  days: 7,
  downloadDir: join(homedir(), 'Downloads'),
  includeUndated: true,
  maxPerRun: 60,
  // 上次可用的旧版 webmail 地址（带 sid），浏览器被关掉后靠它回来
  lastMailHref: '',
}

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS)

// ---------------------------------------------------------------------------
// 状态：单文件 JSON + 串行写入
// ---------------------------------------------------------------------------

let writeQueue = Promise.resolve()

function freshState() {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, ledger: {}, runs: [] }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeState(raw) {
  const base = freshState()
  if (!raw || typeof raw !== 'object') return base
  const settings = { ...base.settings }
  const incoming = raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
  for (const key of SETTING_KEYS) {
    if (incoming[key] !== undefined && incoming[key] !== null && incoming[key] !== '') {
      settings[key] = incoming[key]
    }
  }
  settings.days = clampInt(settings.days, 1, 90, DEFAULT_SETTINGS.days)
  settings.maxPerRun = clampInt(settings.maxPerRun, 1, 500, DEFAULT_SETTINGS.maxPerRun)
  return {
    version: 1,
    settings,
    ledger: raw.ledger && typeof raw.ledger === 'object' ? raw.ledger : {},
    runs: Array.isArray(raw.runs) ? raw.runs.slice(-30) : [],
  }
}

async function loadState() {
  try {
    return normalizeState(JSON.parse(await readFile(STORE_FILE, 'utf8')))
  } catch {
    return freshState()
  }
}

async function saveState(state) {
  await mkdir(STORE_DIR, { recursive: true })
  await writeFile(STORE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

/** 读-改-写 串行化，避免面板连点和工具调用互相覆盖。 */
function withState(fn) {
  const run = writeQueue.then(async () => {
    const state = await loadState()
    const result = await fn(state)
    await saveState(state)
    return result
  })
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function nowIso() {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// 纯函数：时间、人名、文件名
// ---------------------------------------------------------------------------

/** 列表里的时间文本转 Date；认不出来就返回 null，绝不猜成“现在”。 */
export function parseMailTime(dateText, now = new Date()) {
  const text = String(dateText || '').trim()
  if (!text) return null
  let m
  if ((m = text.match(/^(\d{1,3})\s*分钟前$/))) return new Date(now.getTime() - Number(m[1]) * 60000)
  if ((m = text.match(/^(\d{1,3})\s*小时前$/))) return new Date(now.getTime() - Number(m[1]) * 3600000)
  if ((m = text.match(/^(昨天|前天)\s*(\d{1,2}):(\d{2})$/))) {
    const offset = m[1] === '昨天' ? 1 : 2
    const d = new Date(now.getTime())
    d.setDate(d.getDate() - offset)
    d.setHours(Number(m[2]), Number(m[3]), 0, 0)
    return d
  }
  if ((m = text.match(/^今天\s*(\d{1,2}):(\d{2})$/))) {
    const d = new Date(now.getTime())
    d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    return d
  }
  if ((m = text.match(/^(\d{1,2})月(\d{1,2})日$/))) {
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]))
    if (d.getTime() - now.getTime() > 36 * 3600 * 1000) d.setFullYear(d.getFullYear() - 1)
    return d
  }
  if ((m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  }
  if ((m = text.match(/^(\d{1,2}):(\d{2})$/))) {
    const d = new Date(now.getTime())
    d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    return d
  }
  return null
}

/** 从 BOSS 的邮件主题里抠候选人名：「郭儒亚 | 4年，应聘 测试工程师 | 深圳5-10K【BOSS直聘】」。 */
export function candidateOf(subject) {
  const text = String(subject || '').replace(/\s+/g, ' ').trim()
  let m = text.match(/^([^|,，]{2,14}?)\s*\|/)
  if (m) return m[1].trim()
  m = text.match(/BOSS直聘\s+([^,，·|]{2,14})[,，]/)
  if (m) return m[1].trim()
  m = text.match(/^([^,，\s]{2,10})[,，]\s*\d+\s*年/)
  return m ? m[1].trim() : ''
}

/** 邮件是否命中发送者/主题过滤词（默认「直聘」）。 */
export function matchesSender(mail, filter) {
  const needle = String(filter || '').trim()
  if (!needle) return true
  const blob = [mail.sender, mail.addr, mail.subject].filter(Boolean).join(' ')
  try {
    return new RegExp(needle, 'i').test(blob)
  } catch {
    return blob.toLowerCase().includes(needle.toLowerCase())
  }
}

/** 邮件时间：优先用列表行里的毫秒时间戳，认不出来才回落到解析中文时间。 */
export function mailTimeOf(mail, now = new Date()) {
  if (mail && mail.totime) {
    const d = new Date(Number(mail.totime))
    if (!Number.isNaN(d.getTime())) return d
  }
  return parseMailTime(mail && mail.dateText, now)
}

function sanitizeFileName(name, fallback = 'resume') {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  const trimmed = cleaned.slice(0, 140)
  return trimmed || fallback
}

/**
 * 修「UTF-8 字节被当成 Latin-1 读」造成的乱码文件名。
 * exmail 的 Content-Disposition 有时直接吐 UTF-8 原始字节，fetch 按 latin1 解，
 * 「测试工程师」就变成「æµè¯å·¥ç¨å¸」。这里反过来还原一次。
 */
export function fixMojibake(name) {
  const text = String(name || '')
  if (!/[\u00c0-\u00ff]{2,}/.test(text)) return text
  try {
    const fixed = Buffer.from(text, 'latin1').toString('utf8')
    if (fixed && !fixed.includes('\ufffd')) return fixed
  } catch {
    /* 还原不了就保留原样 */
  }
  return text
}

function extFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('pdf')) return '.pdf'
  if (ct.includes('msword')) return '.doc'
  if (ct.includes('wordprocessingml')) return '.docx'
  if (ct.includes('zip')) return '.zip'
  if (ct.includes('rar')) return '.rar'
  if (ct.includes('image/png')) return '.png'
  if (ct.includes('jpeg')) return '.jpg'
  return ''
}

/** 目标文件不覆盖已有文件：同名就加 (1)(2)… */
async function uniquePath(dir, baseName) {
  const ext = (baseName.match(/\.[A-Za-z0-9]{1,6}$/) || [''])[0]
  const stem = ext ? baseName.slice(0, -ext.length) : baseName
  let candidate = join(dir, baseName)
  let index = 1
  for (;;) {
    try {
      await readFile(candidate)
      candidate = join(dir, `${stem} (${index})${ext}`)
      index += 1
      if (index > 200) break
    } catch {
      return candidate
    }
  }
  return candidate
}

// ---------------------------------------------------------------------------
// 浏览器与邮箱
// ---------------------------------------------------------------------------

async function ensureBrowser(settings) {
  const probe = await cdp.probe(settings.cdpUrl)
  if (!probe.ok) {
    const error = new Error(probe.error || '浏览器调试端口不可用')
    error.code = 'NO_BROWSER'
    error.hint =
      `连不上浏览器调试端口 ${settings.cdpUrl}：让自动化浏览器窗口保持开着（登录态就留在它自己的配置里），` +
      '或在面板设置里把 CDP 地址改成你实际在用的调试端口'
    throw error
  }
  return cdp.connect(settings.cdpUrl, { match: (url) => /cgi-bin\/frame_html/i.test(url) })
}

/** 打开邮箱，并记住这次可用的旧版 webmail 地址（下次浏览器重启后靠它回来）。 */
async function openMailboxTracked(page, settings) {
  const info = await exmail.openMailbox(page, {
    mailUrl: settings.mailUrl,
    folderName: settings.folderName,
    lastMailHref: settings.lastMailHref,
  })
  const href = String((info && info.href) || '')
  if (/cgi-bin\/frame/i.test(href) && href !== settings.lastMailHref) {
    await withState((draft) => {
      draft.settings.lastMailHref = href
    }).catch(() => {})
  }
  return info
}

/** 在资源管理器里打开一个目录（不存在就先建出来）。 */
async function openInExplorer(target) {
  const path = String(target || '').trim()
  if (!path) return { ok: false, error: '没有可打开的目录' }
  await mkdir(path, { recursive: true })
  spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' }).unref()
  return { ok: true, opened: path }
}

async function inspectEnv(settings, { deep = false } = {}) {
  const probe = await cdp.probe(settings.cdpUrl)
  const env = {
    cdpUrl: settings.cdpUrl,
    browser: { ok: probe.ok, error: probe.error || null, pages: probe.pages || [] },
    loggedIn: null,
    href: '',
    folderOpened: null,
    note: '',
  }
  if (!probe.ok || !deep) return env
  let page = null
  try {
    page = await cdp.connect(settings.cdpUrl, { match: (url) => /cgi-bin\/frame_html/i.test(url) })
    const info = await openMailboxTracked(page, settings)
    env.loggedIn = true
    env.href = info.href
    env.folderOpened = info.folderOpened
    env.header = info.header || ''
    env.rows = info.rows || 0
  } catch (error) {
    if (error && error.code === 'NOT_LOGGED_IN') {
      env.loggedIn = false
      env.note = '那个浏览器里的企业邮箱还没登录：在里面登录一次即可（扫码或密码），登录态会留在那个浏览器配置里'
    } else if (error && error.code === 'NOT_OLD_UI') {
      env.loggedIn = false
      env.note = error.hint || '浏览器没有停在企业邮箱旧版 webmail 页面'
    } else {
      env.note = String((error && error.message) || error)
    }
  } finally {
    if (page) page.close()
  }
  return env
}

// ---------------------------------------------------------------------------
// 列表收集（含翻页）
// ---------------------------------------------------------------------------

/**
 * 把列表页翻到底地收集邮件。
 * 列表一页约 25 行，一周的邮件可能不止一页；按时间倒序，看到早于时间窗的行就停。
 */
async function collectMails(cdpPage, { windowDays, now = new Date(), maxPages = 6, expectedFolder = '' } = {}) {
  const cutoff = now.getTime() - windowDays * 24 * 3600 * 1000
  const byKey = new Map()
  let header = ''
  let hasNext = false
  let pages = 0
  for (let round = 0; round < maxPages; round += 1) {
    const listing = await exmail.listMails(cdpPage, {
      attempts: round === 0 ? 20 : 12,
      intervalMs: 700,
    })
    if (!header) header = listing.header || ''
    // 翻页途中如果列表已经不是目标文件夹了，立刻停手，绝不把别处的邮件当成简历
    if (expectedFolder && round > 0 && listing.header && !String(listing.header).includes(expectedFolder)) {
      hasNext = false
      break
    }
    hasNext = Boolean(listing.hasNext)
    pages = round + 1
    let sawOutsideWindow = false
    for (const mail of listing.mails || []) {
      if (!byKey.has(mail.key)) byKey.set(mail.key, mail)
      const time = mailTimeOf(mail, now)
      if (time && time.getTime() < cutoff) sawOutsideWindow = true
    }
    if (!hasNext || sawOutsideWindow) break
    const advanced = await exmail.nextPage(cdpPage)
    if (!advanced) {
      hasNext = false
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  return { header, hasNext, pages, mails: [...byKey.values()] }
}

/** 某封邮件可能不在当前页里：往后翻，直到看见它的行标记。 */
async function ensureRowVisible(cdpPage, key, { maxPages = 4 } = {}) {
  let listing = await exmail.listMails(cdpPage, { attempts: 12, intervalMs: 600 })
  if (!listing || !listing.count) {
    await exmail.backToList(cdpPage).catch(() => false)
    listing = await exmail.listMails(cdpPage, { attempts: 15, intervalMs: 700 })
  }
  const hasKey = (l) => (l.mails || []).some((mail) => mail.key === key)
  if (listing && hasKey(listing)) return true
  for (let round = 0; round < maxPages; round += 1) {
    if (!listing || !listing.hasNext) return false
    const advanced = await exmail.nextPage(cdpPage)
    if (!advanced) return false
    await new Promise((resolve) => setTimeout(resolve, 1200))
    listing = await exmail.listMails(cdpPage, { attempts: 12, intervalMs: 600 })
    if (listing && hasKey(listing)) return true
  }
  return false
}

function decorateMail(mail, { now, cutoff, jobFilter, includeUndated }) {
  const time = mailTimeOf(mail, now)
  const jobMatched = !jobFilter || String(mail.subject || '').includes(jobFilter)
  return {
    ...mail,
    candidate: candidateOf(mail.subject),
    mailTime: time ? time.toISOString() : null,
    jobMatched,
    inWindow: jobMatched && (time ? time.getTime() >= cutoff : Boolean(includeUndated)),
  }
}

/** 列举近 N 天、命中发送者与岗位关键词的简历邮件（不下载）。 */
async function scanMails(settings, { days, filter, job } = {}) {
  const windowDays = clampInt(days ?? settings.days, 1, 90, settings.days)
  const senderFilter = String(filter || settings.senderFilter || '直聘')
  const jobFilter = String(job ?? settings.jobFilter ?? '').trim()
  const page = await ensureBrowser(settings)
  try {
    const info = await openMailboxTracked(page, settings)
    const now = new Date()
    const listing = await collectMails(page, {
      windowDays,
      now,
      expectedFolder: settings.folderName,
    })
    const cutoff = now.getTime() - windowDays * 24 * 3600 * 1000
    const mails = (listing.mails || [])
      .filter((mail) => matchesSender(mail, senderFilter))
      .map((mail) => decorateMail(mail, { now, cutoff, jobFilter, includeUndated: settings.includeUndated }))
    return {
      href: info.href,
      folderOpened: info.folderOpened,
      header: listing.header || '',
      pages: listing.pages || 1,
      hasNextPage: Boolean(listing.hasNext),
      windowDays,
      jobFilter,
      cutoff: new Date(cutoff).toISOString(),
      total: mails.length,
      mails,
    }
  } finally {
    page.close()
  }
}

// ---------------------------------------------------------------------------
// 一键下载
// ---------------------------------------------------------------------------

let running = false

async function runDownload(settings, options = {}) {
  const { days, dryRun = false, force = false, limit, job } = options
  if (running) {
    const error = new Error('已经有一轮下载在跑，等它结束再点')
    error.code = 'BUSY'
    throw error
  }
  running = true
  const started = Date.now()
  const now = new Date()
  const windowDays = clampInt(days ?? settings.days, 1, 90, settings.days)
  const cutoff = now.getTime() - windowDays * 24 * 3600 * 1000
  const jobFilter = String(job ?? settings.jobFilter ?? '').trim()
  const maxItems = clampInt(limit ?? settings.maxPerRun, 1, 500, settings.maxPerRun)
  const downloadDir = String(settings.downloadDir || DEFAULT_SETTINGS.downloadDir)

  let page = null
  try {
    page = await ensureBrowser(settings)
    const info = await openMailboxTracked(page, settings)
    const listing = await collectMails(page, {
      windowDays,
      now,
      expectedFolder: settings.folderName,
    })
    const all = (listing.mails || [])
      .filter((mail) => matchesSender(mail, settings.senderFilter))
      .map((mail) => decorateMail(mail, { now, cutoff, jobFilter, includeUndated: settings.includeUndated }))
    const inWindow = all.filter((mail) => mail.inWindow)

    const ledger = await loadState().then((state) => state.ledger)
    // 只有确实存下了文件才算「已下载」；no_attachment / failed 允许下一轮重试（自愈）
    const pending = inWindow.filter((mail) => {
      const entry = ledger[mail.key]
      if (!entry) return true
      if (force) return true
      return entry.status !== 'downloaded'
    })

    const report = {
      ok: true,
      at: nowIso(),
      windowDays,
      cutoff: new Date(cutoff).toISOString(),
      downloadDir,
      browser: { href: info.href, folderOpened: info.folderOpened, pages: listing.pages || 1 },
      scanned: all.length,
      jobFilter,
      jobMatched: all.filter((mail) => mail.jobMatched).length,
      inWindow: inWindow.length,
      alreadyDownloaded: inWindow.length - pending.length,
      pending: pending.length,
      dryRun: Boolean(dryRun),
      downloaded: [],
      skipped: [],
      errors: [],
      undated: all.filter((mail) => !mail.mailTime).length,
    }

    if (dryRun) {
      report.preview = pending.slice(0, maxItems).map((mail) => ({
        key: mail.key,
        candidate: mail.candidate,
        subject: mail.subject.slice(0, 120),
        dateText: mail.dateText,
        mailTime: mail.mailTime,
      }))
      return report
    }
    if (!pending.length) {
      await withState((state) => {
        state.runs = [
          ...state.runs,
          { at: report.at, scanned: report.scanned, downloaded: 0, errors: 0, windowDays },
        ].slice(-30)
      })
      return report
    }

    await mkdir(downloadDir, { recursive: true })
    const queue = pending.slice(0, maxItems)

    for (const mail of queue) {
      try {
        const visible = await ensureRowVisible(page, mail.key)
        if (!visible) {
          report.errors.push({
            key: mail.key,
            subject: mail.subject.slice(0, 80),
            error: '列表里找不到这封邮件（可能已被列表重排）',
          })
          await exmail.backToList(page).catch(() => false)
          continue
        }
        const opened = await exmail.openMail(page, mail.key)
        if (!opened) {
          report.errors.push({
            key: mail.key,
            subject: mail.subject.slice(0, 80),
            error: '点开这封邮件失败',
          })
          await exmail.backToList(page).catch(() => false)
          continue
        }
        const attach = await exmail.readAttachments(page)
        if (!attach.count) {
          report.skipped.push({
            key: mail.key,
            candidate: mail.candidate,
            subject: mail.subject.slice(0, 100),
            reason: '这封邮件里没找到附件链接',
          })
          await withState((state) => {
            state.ledger[mail.key] = {
              key: mail.key,
              candidate: mail.candidate,
              subject: mail.subject,
              dateText: mail.dateText,
              mailTime: mail.mailTime,
              status: 'no_attachment',
              files: [],
              at: nowIso(),
            }
          })
          await exmail.backToList(page).catch(() => false)
          continue
        }

        const files = []
        const failed = []
        const seenHash = new Set()
        for (const link of attach.items) {
          const fetched = await exmail.fetchAttachment(page, link.href, { hintName: link.text })
          if (!fetched.ok) {
            failed.push({ href: link.href, error: fetched.error })
            continue
          }
          const buffer = Buffer.from(fetched.base64, 'base64')
          // 读信页可能给两条指向同一附件的直链：按内容哈希去重
          const digest = createHash('sha1').update(buffer).digest('hex')
          if (seenHash.has(digest)) continue
          seenHash.add(digest)
          const rawName = sanitizeFileName(
            fixMojibake(fetched.name) || fixMojibake(link.text) || mail.candidate || 'resume',
          )
          const withExt = /\.[A-Za-z0-9]{1,6}$/.test(rawName)
            ? rawName
            : rawName + extFromContentType(fetched.contentType)
          const finalName = sanitizeFileName(withExt)
          const target = await uniquePath(downloadDir, finalName)
          await writeFile(target, buffer)
          files.push({ name: finalName, path: target, bytes: buffer.length })
        }

        await withState((state) => {
          const entry = state.ledger[mail.key] || {
            key: mail.key,
            candidate: mail.candidate,
            subject: mail.subject,
            dateText: mail.dateText,
            mailTime: mail.mailTime,
            files: [],
            at: nowIso(),
          }
          entry.files = [...(entry.files || []), ...files]
          entry.status = files.length ? 'downloaded' : 'failed'
          entry.at = nowIso()
          if (failed.length) entry.lastError = failed[0].error
          state.ledger[mail.key] = entry
        })

        if (files.length) {
          report.downloaded.push({
            key: mail.key,
            candidate: mail.candidate,
            subject: mail.subject.slice(0, 100),
            files,
          })
        }
        if (failed.length) {
          report.errors.push({ key: mail.key, subject: mail.subject.slice(0, 80), error: failed[0].error })
        }
        await exmail.backToList(page).catch(() => false)
      } catch (error) {
        report.errors.push({
          key: mail.key,
          subject: (mail.subject || '').slice(0, 80),
          error: String((error && error.message) || error),
        })
        await exmail.backToList(page).catch(() => false)
      }
    }

    report.elapsedMs = Date.now() - started
    await withState((state) => {
      state.runs = [
        ...state.runs,
        {
          at: report.at,
          windowDays,
          scanned: report.scanned,
          pending: report.pending,
          downloaded: report.downloaded.length,
          errors: report.errors.length,
          elapsedMs: report.elapsedMs,
        },
      ].slice(-30)
    })
    return report
  } finally {
    running = false
    if (page) page.close()
  }
}

// ---------------------------------------------------------------------------
// 面板数据
// ---------------------------------------------------------------------------

function ledgerRows(state, { limit = 80 } = {}) {
  const rows = Object.values(state.ledger || {})
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  return rows.slice(0, limit).map((entry) => ({
    key: entry.key,
    candidate: entry.candidate || '',
    subject: entry.subject || '',
    dateText: entry.dateText || '',
    mailTime: entry.mailTime || null,
    status: entry.status || '',
    files: (entry.files || []).map((f) => ({ name: f.name, path: f.path, bytes: f.bytes })),
    at: entry.at || '',
    lastError: entry.lastError || '',
  }))
}

function statsOf(state) {
  const rows = Object.values(state.ledger || {})
  let files = 0
  let bytes = 0
  for (const entry of rows) {
    for (const f of entry.files || []) {
      files += 1
      bytes += Number(f.bytes || 0)
    }
  }
  const lastRun = (state.runs || [])[state.runs.length - 1] || null
  return {
    mails: rows.length,
    downloaded: rows.filter((row) => row.status === 'downloaded').length,
    noAttachment: rows.filter((row) => row.status === 'no_attachment').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    files,
    bytes,
    lastRun,
  }
}

async function panelState() {
  const state = await loadState()
  const env = await inspectEnv(state.settings, { deep: false })
  return {
    ok: true,
    settings: state.settings,
    defaults: DEFAULT_SETTINGS,
    storeFile: STORE_FILE,
    env,
    stats: statsOf(state),
    runs: (state.runs || []).slice(-5).reverse(),
    ledger: ledgerRows(state),
  }
}

// ---------------------------------------------------------------------------
// 动作分发（工具与 HTTP 共用）
// ---------------------------------------------------------------------------

async function runAction(input = {}) {
  const action = String(input.action || 'status')
  const state = await loadState()
  const settings = state.settings

  if (action === 'status') {
    const env = await inspectEnv(settings, { deep: input.deep !== false })
    return {
      ok: true,
      settings,
      env,
      stats: statsOf(state),
      storeFile: STORE_FILE,
      hint:
        env.loggedIn === false
          ? env.note
          : env.browser && env.browser.ok
            ? '浏览器连接正常'
            : (env.browser && env.browser.error) || '',
    }
  }

  if (action === 'scan') {
    const result = await scanMails(settings, { days: input.days, filter: input.filter, job: input.job })
    const ledger = state.ledger || {}
    const pending = result.mails.filter((mail) => mail.inWindow && ledger[mail.key]?.status !== 'downloaded')
    return {
      ok: true,
      windowDays: result.windowDays,
      jobFilter: result.jobFilter,
      cutoff: result.cutoff,
      pages: result.pages,
      hasNextPage: result.hasNextPage,
      header: result.header,
      scanned: result.total,
      inWindow: result.mails.filter((mail) => mail.inWindow).length,
      pending: pending.length,
      undated: result.mails.filter((mail) => !mail.mailTime).length,
      mails: result.mails.map((mail) => ({
        key: mail.key,
        candidate: mail.candidate,
        subject: mail.subject.slice(0, 120),
        dateText: mail.dateText,
        mailTime: mail.mailTime,
        inWindow: mail.inWindow,
        downloaded: ledger[mail.key]?.status === 'downloaded',
      })),
    }
  }

  if (action === 'download') {
    return runDownload(settings, {
      days: input.days,
      dryRun: Boolean(input.dryRun),
      force: Boolean(input.force),
      limit: input.limit,
      job: input.job,
    })
  }

  if (action === 'ledger') {
    return { ok: true, stats: statsOf(state), ledger: ledgerRows(state, { limit: input.limit || 80 }) }
  }

  if (action === 'config') {
    const patch = {}
    for (const key of SETTING_KEYS) {
      if (input[key] !== undefined) patch[key] = input[key]
    }
    if (input.settings && typeof input.settings === 'object') Object.assign(patch, input.settings)
    const saved = await withState((draft) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') {
          draft.settings[key] = DEFAULT_SETTINGS[key]
        } else {
          draft.settings[key] = value
        }
      }
      draft.settings = normalizeState(draft).settings
      return draft.settings
    })
    return { ok: true, settings: saved }
  }

  if (action === 'open') {
    const page = await ensureBrowser(settings)
    try {
      const info = await openMailboxTracked(page, settings)
      return { ok: true, href: info.href, folderOpened: info.folderOpened, rows: info.rows || 0 }
    } finally {
      page.close()
    }
  }

  if (action === 'openDir') {
    const key = String(input.key || '')
    const entry = key ? state.ledger[key] : null
    const filePath = entry && entry.files && entry.files[0] ? entry.files[0].path : ''
    const target = filePath ? dirname(filePath) : String(input.path || settings.downloadDir)
    return openInExplorer(target)
  }

  if (action === 'forget') {
    const key = String(input.key || '')
    if (!key) return { ok: false, error: '需要 key' }
    await withState((draft) => {
      delete draft.ledger[key]
    })
    return { ok: true, key, cleared: true }
  }

  return { ok: false, error: `未知 action: ${action}` }
}

function sanitize(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { ok: false, error: '结果无法序列化' }
  }
}

function jsonText(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// HTTP：面板读写
// ---------------------------------------------------------------------------

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(sanitize(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function handleApi(req, res) {
  try {
    if (req.method === 'POST') {
      const body = await readBody(req)
      sendJson(res, 200, await runAction(body))
      return
    }
    sendJson(res, 200, await panelState())
  } catch (error) {
    const code = error && error.code
    sendJson(res, code === 'NOT_LOGGED_IN' || code === 'NO_BROWSER' || code === 'NOT_OLD_UI' ? 409 : 500, {
      ok: false,
      code: code || null,
      error: String((error && error.message) || error),
      hint: (error && error.hint) || '',
    })
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export const inject = ['tools', 'systemPrompt', 'webServer']

export function apply(ctx) {
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'mail-resume-sop',
      order: 62,
      text: () =>
        [
          '## 企业邮箱简历下载（mail-resume 插件）',
          '这个插件负责把企业邮箱里 BOSS 直聘的简历邮件附件一键下载到本机下载目录，并记台账去重。',
          '你不需要手工点邮箱；需要下载时调 `mail_resume`：',
          '- `action=status`：看浏览器是否连着、邮箱是否已登录、下载目录在哪。',
          '- `action=scan`：先看近 N 天有几封待下载，别直接下。',
          '- `action=download`：真正下载（days 默认取设置，通常 7；job 用于按岗位关键词过滤）。',
          '- `action=config`：改 downloadDir / days / senderFilter / jobFilter / cdpUrl。',
          '若返回 `NOT_LOGGED_IN` 或 `NOT_OLD_UI`：让用户在**那个浏览器窗口**里重新登录一次企业邮箱，登录后会落到旧版 webmail；不要索取账号密码。',
          '若返回 `NO_BROWSER`：说明调试端口没开，提示用户让自动化浏览器保持开着，或改 cdpUrl。',
        ].join('\n'),
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'mail_resume',
      description:
        '企业邮箱简历自动下载：从已登录企业邮箱的浏览器里捞出 BOSS 直聘的简历邮件，' +
        '把近 N 天还没下载过的附件简历存到本机下载目录并记台账去重。' +
        'action=status 看连通与登录状态；scan 预览待下载；download 一键下载；ledger 查台账；config 改设置；open 把浏览器切到邮箱文件夹。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'scan', 'download', 'ledger', 'config', 'open', 'openDir', 'forget'],
            description:
              'status=连通/登录/统计；scan=预览近 N 天待下载邮件；download=一键下载；' +
              'ledger=已下载台账；config=改设置；open=把浏览器切到邮箱文件夹；' +
              'openDir=在资源管理器里打开下载目录（给 key 就打开那封简历所在的文件夹）；forget=删一条台账记录',
          },
          path: { type: 'string', description: 'openDir 时可指定目录；省略则打开下载目录' },
          days: { type: 'number', description: '回看天数，默认取设置里的值（7）' },
          filter: { type: 'string', description: 'scan 时的发送者/主题过滤词，默认「直聘」' },
          job: {
            type: 'string',
            description: '按岗位关键词过滤邮件主题（BOSS 邮件主题里带岗位名，例如「测试」）；省略则用设置里的 jobFilter',
          },
          dryRun: { type: 'boolean', description: 'download 时只算不写文件' },
          force: { type: 'boolean', description: 'download 时忽略台账重下一遍' },
          limit: { type: 'number', description: 'download 本轮最多处理几封' },
          deep: { type: 'boolean', description: 'status 时是否连上去探登录态（默认 true）' },
          key: { type: 'string', description: 'forget 的台账 key' },
          cdpUrl: { type: 'string', description: 'config：Chrome 调试端口地址' },
          mailUrl: { type: 'string', description: 'config：邮箱地址' },
          folderName: { type: 'string', description: 'config：收简历的邮件文件夹名' },
          senderFilter: { type: 'string', description: 'config：发送者/主题过滤词' },
          jobFilter: { type: 'string', description: 'config：按岗位关键词过滤邮件主题（留空 = 不过滤）' },
          downloadDir: { type: 'string', description: 'config：下载目录' },
          includeUndated: { type: 'boolean', description: 'config：列表里认不出时间的邮件是否也算待下载' },
          maxPerRun: { type: 'number', description: 'config：单轮最多处理封数' },
          settings: { type: 'object', description: 'config：一次性传整套设置', additionalProperties: true },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        // ToolOutputDefinition.render 必须返回 ContentBlock[]，不是字符串
        render(_args, value) {
          return [{ type: 'text', text: jsonText(value) }]
        },
      },
      async execute(args) {
        try {
          return sanitize(await runAction(args))
        } catch (error) {
          return {
            ok: false,
            code: (error && error.code) || null,
            error: String((error && error.message) || error),
            hint: (error && error.hint) || '',
          }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      async handler(req, res) {
        await handleApi(req, res)
      },
    }),
  )
}

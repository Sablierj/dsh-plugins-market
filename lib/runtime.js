/**
 * 便携运行时管理器：不依赖 Docker、不需要管理员，用 DSH 自带的 Python 跑 SearXNG。
 *
 * 目录结构（全部在插件自己的数据目录里，卸载即干净）：
 *   runtime/
 *     portable-<version>/          ← 一次安装 = 一个目录
 *       searxng-master/            ← 源码
 *       site-packages/             ← 私有依赖（pip --target，不污染系统）
 *       wincompat/                 ← Windows 垫片（pwd / os.getuid），不改源码
 *       settings.yml               ← 开 json、关 limiter
 *       manifest.json              ← 版本、哈希、来源、体积
 *       boot.log / boot.err
 *       searxng.pid
 *     current.txt                  ← 健康检查通过后才切换
 *
 * 为什么要有版本目录：升级 = 装新目录 → 起新进程 → 健康 → 切 current.txt → 停旧进程。
 * 旧目录保留，出问题能一键回滚。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from './settings.js'
import { httpGet } from './transport.js'

export const RUNTIME_ROOT = join(CONFIG_DIR, 'runtime')
const CURRENT = join(RUNTIME_ROOT, 'current.txt')
/**
 * 源码来源，按顺序尝试。实测（2026-10-20）：
 *   GitHub master.zip 7,140,347 B；gitee 镜像与 gh-proxy 拉到的字节数完全一致。
 * 配置了 runtime.sourceUrl 时它排第一。
 */
const SOURCE_MIRRORS = [
  'https://github.com/searxng/searxng/archive/refs/heads/master.zip',
  'https://gitee.com/mirrors/SearXNG/repository/archive/master.zip',
  'https://gh-proxy.com/https://github.com/searxng/searxng/archive/refs/heads/master.zip',
]
const SHIM_SITECUSTOMIZE = `"""Windows compatibility shims for SearXNG (kept out of the source tree)."""
import os

if not hasattr(os, "getuid"):
    os.getuid = lambda: 0  # type: ignore[attr-defined]
if not hasattr(os, "geteuid"):
    os.geteuid = lambda: 0  # type: ignore[attr-defined]
`
const SHIM_PWD = `"""Minimal pwd replacement for Windows."""
import os
from collections import namedtuple

struct_passwd = namedtuple("struct_passwd", "pw_name pw_passwd pw_uid pw_gid pw_gecos pw_dir pw_shell")

def _entry(uid=0):
    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    name = os.environ.get("USERNAME") or "dsh"
    return struct_passwd(name, "x", int(uid), int(uid), name, home, "")

def getpwuid(uid):
    return _entry(uid)

def getpwnam(name):
    return _entry(0)
`

function run(command, args, { timeoutMs = 600000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs, cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? String(stderr || error.message) : null })
    })
  })
}

/** DSH 自带 Python 优先；其次配置里指定的；最后系统 PATH 上的。 */
export async function detectPython(settings = {}) {
  const candidates = []
  if (settings.runtime?.pythonPath) candidates.push({ path: settings.runtime.pythonPath, source: 'config' })

  // DSH Desktop: <install>/resources/runtime/primary-runtime/dependencies/python/python.exe
  const exeDir = dirname(process.execPath || '')
  candidates.push({
    path: join(exeDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'),
    source: 'dsh-bundled',
  })
  candidates.push({ path: join(exeDir, '..', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'), source: 'dsh-bundled' })

  for (const candidate of candidates) {
    if (!candidate.path || !existsSync(candidate.path)) continue
    const version = await run(candidate.path, ['-V'], { timeoutMs: 15000 })
    if (version.ok) return { ok: true, path: candidate.path, source: candidate.source, version: (version.stdout || version.stderr).trim() }
  }

  const onPath = await run('python.exe', ['-V'], { timeoutMs: 15000 })
  if (onPath.ok) return { ok: true, path: 'python.exe', source: 'system-path', version: (onPath.stdout || onPath.stderr).trim() }
  return { ok: false, path: null, source: null, version: null, error: '找不到可用的 Python（DSH 自带 / PATH 都没有）' }
}

function readCurrentName() {
  try {
    return readFileSync(CURRENT, 'utf8').trim() || null
  } catch {
    return null
  }
}

function writeCurrentName(name) {
  mkdirSync(RUNTIME_ROOT, { recursive: true })
  writeFileSync(CURRENT, `${name}\n`, 'utf8')
}

export function listRuntimeVersions() {
  try {
    return readdirSync(RUNTIME_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('portable-'))
      .map((entry) => {
        const dir = join(RUNTIME_ROOT, entry.name)
        let manifest = null
        try {
          manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
        } catch {}
        return {
          name: entry.name,
          dir,
          version: manifest?.version || entry.name.replace(/^portable-/, ''),
          createdAt: manifest?.createdAt || null,
          python: manifest?.python || null,
          ok: Boolean(manifest),
        }
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  } catch {
    return []
  }
}

export function currentRuntime() {
  const name = readCurrentName()
  if (!name) return null
  const dir = join(RUNTIME_ROOT, name)
  if (!existsSync(dir)) return null
  return { name, dir }
}

function readPid(dir) {
  try {
    const pid = Number(readFileSync(join(dir, 'searxng.pid'), 'utf8').trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 一个名字：portable-YYYY.MM.DD[-n] */
function nextVersionName() {
  const now = new Date()
  const stamp = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`
  const base = `portable-${stamp}`
  let name = base
  let index = 2
  while (existsSync(join(RUNTIME_ROOT, name))) {
    name = `${base}-${index}`
    index += 1
  }
  return name
}

/** 下载：优先 curl（二进制安全、支持代理），退回 fetch。 */
async function download(url, dest, { proxy, timeoutMs = 300000 } = {}) {
  const curlProbe = await run('curl.exe', ['--version'], { timeoutMs: 5000 })
  if (curlProbe.ok) {
    const args = ['-L', '-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-o', dest]
    if (proxy) args.push('--proxy', proxy)
    args.push(url)
    const result = await run('curl.exe', args, { timeoutMs: timeoutMs + 15000 })
    return { ok: result.ok && existsSync(dest), bytes: existsSync(dest) ? statSync(dest).size : 0, error: result.error }
  }
  const response = await fetch(url)
  if (!response.ok) return { ok: false, bytes: 0, error: `HTTP ${response.status}` }
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(dest, buffer)
  return { ok: true, bytes: buffer.length }
}

/** 依次尝试多个源，第一个拿到非空文件的胜出。 */
async function downloadFirst(urls, dest, { proxy, timeoutMs = 300000 } = {}) {
  const tried = []
  for (const url of urls) {
    const result = await download(url, dest, { proxy, timeoutMs })
    tried.push({ url, ok: result.ok, bytes: result.bytes, error: result.error })
    if (result.ok && result.bytes > 1024 * 1024) return { ok: true, url, bytes: result.bytes, tried }
  }
  return { ok: false, tried, error: '所有源码源都失败' }
}

/** 解压：PowerShell + .NET，跳过 Windows 非法（含 ':'）的条目，而不是整包失败。 */
async function extractZip(zipPath, destDir) {
  const script = join(RUNTIME_ROOT, '_extract.ps1')
  writeFileSync(
    script,
    [
      'param($zip, $dest)',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)',
      'try {',
      '  foreach ($e in $archive.Entries) {',
      '    if ($e.FullName -match ":" -or $e.FullName -eq "") { continue }',
      '    $target = Join-Path $dest $e.FullName',
      '    if ($e.Name -eq "") { New-Item -ItemType Directory -Force -Path $target | Out-Null; continue }',
      '    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null',
      '    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)',
      '  }',
      '} finally { $archive.Dispose() }',
    ].join('\n'),
    'utf8',
  )
  const result = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, zipPath, destDir], { timeoutMs: 300000 })
  try {
    rmSync(script, { force: true })
  } catch {}
  return { ok: result.ok, error: result.error }
}

function writeSettingsYml(dir, port) {
  const yml = [
    'use_default_settings: true',
    'general:',
    '  instance_name: "DSH SearXNG (portable)"',
    'server:',
    '  secret_key: "portable-dsh-searxng-secret"',
    '  limiter: false',
    '  image_proxy: false',
    `  port: ${port}`,
    '  bind_address: "127.0.0.1"',
    'search:',
    '  safe_search: 0',
    '  formats:',
    '    - html',
    '    - json',
    '',
    '# 默认关掉的国内引擎在此打开：开箱即用，不用手改 settings.yml',
    'engines:',
    '  - name: 360search',
    '    disabled: false',
    '  - name: sogou',
    '    disabled: false',
    '  - name: bing',
    '    disabled: false',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'settings.yml'), yml, 'utf8')
}

function dirSizeMb(dir) {
  try {
    let total = 0
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name)
        if (entry.isDirectory()) walk(full)
        else {
          try {
            total += statSync(full).size
          } catch {}
        }
      }
    }
    walk(dir)
    return Math.round((total / 1024 / 1024) * 10) / 10
  } catch {
    return null
  }
}

/** 安装一个新版本（不改 current，装完由调用方健康检查后再切）。 */
export async function installRuntime(settings, { onStep, timeoutMs = 600000 } = {}) {
  const steps = []
  const step = (name, detail, ok = true) => {
    steps.push({ name, detail, ok })
    onStep?.(steps[steps.length - 1])
  }

  const python = await detectPython(settings)
  step('python', python.ok ? `${python.version}（${python.source}）` : `未找到：${python.error}`, python.ok)
  if (!python.ok) return { ok: false, steps, error: python.error, needs: 'python' }

  const name = nextVersionName()
  const dir = join(RUNTIME_ROOT, name)
  mkdirSync(dir, { recursive: true })
  step('dir', dir)

  const zip = join(dir, 'searxng.zip')
  const sources = [settings.runtime?.sourceUrl, ...SOURCE_MIRRORS].filter(Boolean)
  const downloadResult = await downloadFirst(sources, zip, {
    proxy: settings.proxy?.enabled ? settings.proxy.url : undefined,
    timeoutMs,
  })
  if (!downloadResult.ok) {
    step('download', `所有源码源都失败：${downloadResult.tried.map((item) => `${new URL(item.url).host} ${item.error || item.bytes}`).join(' / ')}`, false)
    return { ok: false, steps, error: downloadResult.error }
  }
  step('download', `${(downloadResult.bytes / 1024 / 1024).toFixed(1)} MB ← ${new URL(downloadResult.url).host}`)

  const extract = await extractZip(zip, dir)
  step('extract', extract.ok ? '源码解压完成（跳过 Windows 不支持的路径）' : `解压失败：${extract.error}`, extract.ok)
  if (!extract.ok) return { ok: false, steps, error: extract.error }

  const srcDir = join(dir, 'searxng-master')
  if (!existsSync(join(srcDir, 'searx', 'webapp.py'))) {
    step('extract', '解压后找不到 searx/webapp.py', false)
    return { ok: false, steps, error: '源码结构不符合预期' }
  }

  const sitePackages = join(dir, 'site-packages')
  mkdirSync(sitePackages, { recursive: true })
  const mirror = settings.runtime?.pipIndex || 'https://pypi.tuna.tsinghua.edu.cn/simple'
  step('pip', `安装依赖（${mirror}）…`)
  const pip = await run(
    python.path,
    ['-m', 'pip', 'install', '--target', sitePackages, '-r', join(srcDir, 'requirements.txt'), '-i', mirror, '--only-binary=:all:', '--no-warn-script-location', '--disable-pip-version-check'],
    { timeoutMs },
  )
  step('pip', pip.ok ? '依赖就绪（全部 wheel，未编译）' : `pip 失败：${(pip.error || '').slice(0, 200)}`, pip.ok)
  if (!pip.ok) return { ok: false, steps, error: 'pip 安装依赖失败' }

  const compatDir = join(dir, 'wincompat')
  mkdirSync(compatDir, { recursive: true })
  writeFileSync(join(compatDir, 'sitecustomize.py'), SHIM_SITECUSTOMIZE, 'utf8')
  writeFileSync(join(compatDir, 'pwd.py'), SHIM_PWD, 'utf8')
  step('shims', 'Windows 兼容垫片已写入（不改源码）')

  writeSettingsYml(dir, settings.port || 8080)
  rmSync(zip, { force: true })

  const manifest = {
    version: name.replace(/^portable-/, ''),
    name,
    createdAt: new Date().toISOString(),
    python: python.path,
    pythonVersion: python.version,
    source: downloadResult.url || settings.runtime?.sourceUrl || 'unknown',
    pipIndex: mirror,
    sizeMb: dirSizeMb(dir),
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  step('manifest', `${manifest.sizeMb} MB`)

  return { ok: true, steps, name, dir, manifest }
}

export function runtimeEnv(settings, dir) {
  return {
    ...process.env,
    PYTHONPATH: [join(dir, 'wincompat'), join(dir, 'site-packages'), join(dir, 'searxng-master')].join(';'),
    SEARXNG_SETTINGS_PATH: join(dir, 'settings.yml'),
    PYTHONIOENCODING: 'utf-8',
    SEARXNG_BASE_URL: `http://127.0.0.1:${settings.port || 8080}/`,
  }
}

export async function startRuntime(settings) {
  const current = currentRuntime()
  if (!current) return { ok: false, error: '还没有安装运行时：先点「安装」', needs: 'install' }
  const pid = readPid(current.dir)
  if (isAlive(pid)) return { ok: true, note: `已在运行（pid ${pid}）` }

  const python = settings.runtime?.pythonPath || (await detectPython(settings)).path
  const srcDir = join(current.dir, 'searxng-master')
  const out = join(current.dir, 'boot.log')
  const err = join(current.dir, 'boot.err')
  const child = spawn(python, [join(srcDir, 'searx', 'webapp.py')], {
    cwd: srcDir,
    env: runtimeEnv(settings, current.dir),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  child.on('exit', () => {
    writeFileSync(join(current.dir, 'last-exit.log'), `${stdout}\n----\n${stderr}`, 'utf8')
  })
  child.unref()
  writeFileSync(join(current.dir, 'searxng.pid'), String(child.pid), 'utf8')
  return { ok: true, pid: child.pid, dir: current.dir, note: '进程已拉起，等健康检查' }
}

export async function stopRuntime() {
  const current = currentRuntime()
  if (!current) return { ok: false, error: '还没有安装运行时' }
  const pid = readPid(current.dir)
  if (!pid || !isAlive(pid)) return { ok: true, note: '本来就没在跑' }
  try {
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 20000 })
  } catch {}
  if (isAlive(pid)) {
    try {
      process.kill(pid)
    } catch {}
  }
  try {
    rmSync(join(current.dir, 'searxng.pid'), { force: true })
  } catch {}
  return { ok: true, pid, note: '已停止' }
}

/**
 * 健康检查：一次真实查询。超时必须够长——SearXNG 首次抓某个引擎约 20s，
 * 6s 会把「慢」判成「挂了」（这个误判真的发生过）。
 */
export async function runtimeHealth(settings, { timeoutMs } = {}) {
  const url = `http://127.0.0.1:${settings.port || 8080}/search?q=dsh%20health&format=json`
  const budget = Math.max(20000, Number(timeoutMs) || Number(settings.timeoutMs) || 25000)
  const response = await httpGet(url, { timeoutMs: budget, userAgent: settings.userAgent })
  if (!response.ok) return { ok: false, status: response.status, error: response.error || `HTTP ${response.status}` }
  try {
    const payload = JSON.parse(response.body)
    return { ok: true, status: response.status, results: Array.isArray(payload.results) ? payload.results.length : 0, tookMs: response.tookMs }
  } catch {
    return { ok: false, status: response.status, error: '返回不是 JSON' }
  }
}

export async function runtimeStatus(settings, { health = true } = {}) {
  const python = await detectPython(settings)
  const versions = listRuntimeVersions()
  const current = currentRuntime()
  const pid = current ? readPid(current.dir) : null
  const running = Boolean(pid && isAlive(pid))
  let manifest = null
  if (current) {
    try {
      manifest = JSON.parse(readFileSync(join(current.dir, 'manifest.json'), 'utf8'))
    } catch {}
  }
  return {
    python,
    installed: Boolean(current),
    versions,
    current: current ? { name: current.name, dir: current.dir, manifest } : null,
    running,
    pid: running ? pid : null,
    health: health && running ? await runtimeHealth(settings) : null,
  }
}

/** 切到某个版本（健康检查通过后才切）。 */
export function switchRuntime(name) {
  const dir = join(RUNTIME_ROOT, name)
  if (!existsSync(dir)) return { ok: false, error: `没有这个版本：${name}` }
  writeCurrentName(name)
  return { ok: true, name }
}

export async function uninstallRuntime(name) {
  const target = name || readCurrentName()
  if (!target) return { ok: false, error: '没有可卸载的运行时' }
  const dir = join(RUNTIME_ROOT, target)
  if (!existsSync(dir)) return { ok: false, error: `没有这个版本：${target}` }
  const pid = readPid(dir)
  if (pid && isAlive(pid)) {
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 20000 })
  }
  rmSync(dir, { recursive: true, force: true })
  if (readCurrentName() === target) rmSync(CURRENT, { force: true })
  return { ok: true, removed: target }
}

/** 导出离线包：把当前版本目录打成 zip（新机器断网也能装）。 */
export async function exportRuntime(destZip) {
  const current = currentRuntime()
  if (!current) return { ok: false, error: '没有可导出的运行时（先安装）' }
  const stamp = current.name.replace(/^portable-/, '')
  const dest = destZip || join(CONFIG_DIR, 'export', `searxng-portable-${stamp}.zip`)
  mkdirSync(dirname(dest), { recursive: true })
  const script = join(RUNTIME_ROOT, '_pack.ps1')
  writeFileSync(
    script,
    [
      'param($src, $dest)',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      'if (Test-Path $dest) { Remove-Item $dest -Force }',
      '[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $dest, [System.IO.Compression.CompressionLevel]::Optimal, $false)',
    ].join('\n'),
    'utf8',
  )
  const result = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, current.dir, dest], { timeoutMs: 900000 })
  try {
    rmSync(script, { force: true })
  } catch {}
  if (!result.ok) return { ok: false, error: result.error }
  const bytes = existsSync(dest) ? statSync(dest).size : 0
  return { ok: true, file: dest, bytes, sizeMb: Math.round((bytes / 1024 / 1024) * 10) / 10, from: current.name }
}

/** 从离线包安装：解压成一个新版本目录，不下载、不 pip。 */
export async function importRuntime(settings, { file, onStep } = {}) {
  const steps = []
  const step = (name, detail, ok = true) => {
    steps.push({ name, detail, ok })
    onStep?.(steps[steps.length - 1])
  }
  if (!file || !existsSync(file)) {
    step('archive', `找不到离线包：${file || '(未提供)'}`, false)
    return { ok: false, steps, error: '离线包不存在' }
  }
  step('archive', `${file}（${(statSync(file).size / 1024 / 1024).toFixed(1)} MB）`)

  const name = nextVersionName()
  const dir = join(RUNTIME_ROOT, name)
  mkdirSync(dir, { recursive: true })
  const extract = await extractZip(file, dir)
  step('extract', extract.ok ? '已解压' : `解压失败：${extract.error}`, extract.ok)
  if (!extract.ok) return { ok: false, steps, error: extract.error }

  // 兼容两种布局：zip 顶层就是 searxng-master，或再套一层版本目录
  let root = dir
  if (!existsSync(join(root, 'searxng-master')) && !existsSync(join(root, 'site-packages'))) {
    const nested = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    const candidate = nested.length === 1 ? join(dir, nested[0].name) : null
    if (candidate && existsSync(join(candidate, 'searxng-master'))) root = candidate
  }
  if (!existsSync(join(root, 'searxng-master', 'searx', 'webapp.py'))) {
    step('layout', '离线包里找不到 searxwebapp.py', false)
    return { ok: false, steps, error: '离线包结构不符合预期' }
  }

  if (root !== dir) {
    for (const entry of readdirSync(root)) {
      rmSync(join(dir, entry), { recursive: true, force: true })
      renameSync(join(root, entry), join(dir, entry))
    }
  }
  // 端口可能变了：覆盖 settings.yml，保证与新配置一致
  writeSettingsYml(dir, settings.port || 8080)
  const manifest = {
    version: name.replace(/^portable-/, ''),
    name,
    createdAt: new Date().toISOString(),
    python: settings.runtime?.pythonPath || 'auto',
    source: `offline:${file}`,
    sizeMb: dirSizeMb(dir),
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  step('manifest', `${manifest.sizeMb} MB`)
  return { ok: true, steps, name, dir, manifest }
}

export async function runtimeLogs(lines = 60) {  const current = currentRuntime()
  if (!current) return { ok: false, error: '还没有安装运行时', lines: [] }
  const read = (name) => {
    try {
      return readFileSync(join(current.dir, name), 'utf8').split('\n')
    } catch {
      return []
    }
  }
  const merged = [...read('boot.log'), '---- stderr ----', ...read('boot.err')]
  return { ok: true, lines: merged.slice(-Math.max(5, Math.min(300, lines))) }
}

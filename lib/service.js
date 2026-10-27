/**
 * SearXNG 生命周期服务：检测 Docker → 拉镜像 → 起容器 → 健康检查 → 启停/日志/删除。
 *
 * 设计约束（都是这台机器上量出来的）：
 * - docker CLI 在，引擎不一定在：Docker Desktop 没启动时 `docker version` 直接报错，
 *   所以「引擎状态」必须是单独一项，不能和「容器状态」混成一个 running/stopped。
 * - 容器存在但 stopped、容器不存在、镜像不存在，是三种不同的状态，
 *   面板上要能分别显示，否则用户点「启动」却什么也没发生。
 * - 所有 docker 调用都有超时，避免面板按钮卡死。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { httpGet } from './transport.js'

const DOCKER = process.env.DSH_DOCKER_PATH || 'docker.exe'

function runDocker(args, { timeoutMs = 60000 } = {}) {
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(
      DOCKER,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          tookMs: Date.now() - started,
          error: error ? String(stderr || error.message || '').trim() : null,
        })
      },
    )
  })
}

/** Docker 引擎：CLI 有没有、daemon 起没起，是两件事。 */
export async function dockerProbe() {
  const version = await runDocker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15000 })
  if (version.ok && version.stdout) {
    return { cli: true, engine: true, version: version.stdout.split('\n')[0], error: null }
  }
  const cliOnly = await runDocker(['--version'], { timeoutMs: 8000 })
  return {
    cli: cliOnly.ok,
    engine: false,
    version: null,
    error: version.error || cliOnly.error || 'docker daemon 未响应',
  }
}

/** 容器现状：exists / running / state / image / ports。 */
export async function containerState(settings) {
  const name = settings.service.containerName
  const result = await runDocker(
    ['inspect', '--format', '{{json .State}}|{{.Config.Image}}|{{json .NetworkSettings.Ports}}', name],
    { timeoutMs: 15000 },
  )
  if (!result.ok) {
    const missing = /no such (object|container)/i.test(result.stderr || '')
    return { exists: false, running: false, state: missing ? 'absent' : 'unknown', error: missing ? null : result.error }
  }
  const [stateJson, image, portsJson] = result.stdout.split('|')
  let state = {}
  let ports = {}
  try {
    state = JSON.parse(stateJson)
  } catch {}
  try {
    ports = JSON.parse(portsJson)
  } catch {}
  const publishes = Object.entries(ports).map(([containerPort, bindings]) => ({
    containerPort,
    host: Array.isArray(bindings) && bindings[0] ? `${bindings[0].HostIp || '0.0.0.0'}:${bindings[0].HostPort}` : null,
  }))
  return {
    exists: true,
    running: state.Running === true,
    state: state.Status || (state.Running ? 'running' : 'stopped'),
    status: state.Running ? 'running' : 'stopped',
    startedAt: state.StartedAt || null,
    finishedAt: state.FinishedAt || null,
    exitCode: state.ExitCode ?? null,
    image: image || null,
    ports: publishes,
    error: null,
  }
}

/** 镜像是否已在本地（没有就要 pull，pull 很慢，必须让面板显示这一步）。 */
export async function imageState(settings) {
  const result = await runDocker(['image', 'inspect', '--format', '{{.Id}}', settings.service.image], { timeoutMs: 15000 })
  return { present: result.ok, id: result.ok ? result.stdout.split('\n')[0] : null }
}

/** 数据目录 + settings.yml（开 json 格式）；已存在就不覆盖用户的修改。 */
export function ensureDataDir(settings) {
  const dir = settings.service.dataDir
  mkdirSync(dir, { recursive: true })
  const settingsPath = join(dir, 'settings.yml')
  const created = !existsSync(settingsPath)
  if (created) {
    const secret = randomBytes(24).toString('hex')
    writeFileSync(
      settingsPath,
      [
        'use_default_settings: true',
        'server:',
        `  secret_key: "${secret}"`,
        '  limiter: false',
        '  image_proxy: false',
        'search:',
        '  safe_search: 0',
        '  formats:',
        '    - html',
        '    - json',
        '',
      ].join('\n'),
      'utf8',
    )
  }
  return { dir, settingsPath, created }
}

export function readInstanceSettings(settings) {
  try {
    const text = readFileSync(join(settings.service.dataDir, 'settings.yml'), 'utf8')
    return {
      jsonEnabled: /-\s*json\b/.test(text),
      limiterOff: /limiter:\s*false/.test(text),
      chars: text.length,
    }
  } catch {
    return { jsonEnabled: false, limiterOff: false, chars: 0, missing: true }
  }
}

/**
 * 容器里的 127.0.0.1 是容器自己，不是宿主机。
 * Clash 跑在宿主机时，必须改写成 Docker Desktop 提供的 host.docker.internal，
 * 否则代理配置「看起来生效、实际上每个引擎都连不上」。
 */
export function containerProxyUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      parsed.hostname = 'host.docker.internal'
    }
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return url
  }
}

/** 起一个新容器（存在则拒绝，交给 start 处理）。 */
export async function deployContainer(settings, { onStep } = {}) {
  const service = settings.service
  const steps = []
  const step = (name, detail, ok = true) => {
    steps.push({ name, detail, ok })
    onStep?.(steps[steps.length - 1])
  }

  const docker = await dockerProbe()
  step('docker', docker.engine ? `engine ${docker.version}` : `engine 未启动：${docker.error}`, docker.engine)
  if (!docker.engine) return { ok: false, steps, error: 'Docker 引擎未运行：先启动 Docker Desktop', needs: 'docker-engine' }

  const data = ensureDataDir(settings)
  step('data', `${data.dir}${data.created ? '（新写入 settings.yml，已开 json）' : '（沿用已有 settings.yml）'}`)

  const image = await imageState(settings)
  if (!image.present) {
    step('pull', `正在拉取 ${service.image}…`)
    const pull = await runDocker(['pull', service.image], { timeoutMs: 900000 })
    step('pull', pull.ok ? '镜像就绪' : `拉取失败：${pull.error}`, pull.ok)
    if (!pull.ok) return { ok: false, steps, error: `镜像拉取失败：${pull.error}` }
  } else {
    step('pull', '镜像已在本地（跳过拉取）')
  }

  const state = await containerState(settings)
  if (state.exists) {
    if (state.running) {
      step('run', '容器已在运行')
      return { ok: true, steps, state: 'running', note: '容器已存在且在运行' }
    }
    const started = await runDocker(['start', service.containerName], { timeoutMs: 60000 })
    step('run', started.ok ? '容器已启动' : `启动失败：${started.error}`, started.ok)
    return started.ok ? { ok: true, steps, state: 'running' } : { ok: false, steps, error: started.error }
  }

  const args = [
    'run', '-d',
    '--name', service.containerName,
    '--restart', service.restartPolicy,
    '-p', `127.0.0.1:${service.port}:8080`,
    '-v', `${data.dir}:/etc/searxng`,
  ]

  // 容器内的引擎抓取要不要走代理：这是「让 SearXNG 自己翻墙」，
  // 和插件搜索请求用的 proxy.* 是两件事。
  if (settings.proxy?.enabled && settings.proxy?.url && service.engineProxy) {
    const proxyUrl = containerProxyUrl(settings.proxy.url)
    args.push(
      '-e', `HTTP_PROXY=${proxyUrl}`,
      '-e', `HTTPS_PROXY=${proxyUrl}`,
      '-e', 'NO_PROXY=localhost,127.0.0.1,::1',
      '--add-host', 'host.docker.internal:host-gateway',
    )
    step('proxy', `容器内引擎走代理：${proxyUrl}（127.0.0.1 已改写为 host.docker.internal）`)
  } else if (settings.proxy?.enabled && settings.proxy?.url) {
    step('proxy', '容器内引擎直连（engineProxy 关闭）')
  }

  args.push(service.image)

  const created = await runDocker(args, { timeoutMs: 120000 })
  step('run', created.ok ? `容器已创建并启动（127.0.0.1:${service.port} → 8080）` : `创建失败：${created.error}`, created.ok)
  if (!created.ok) return { ok: false, steps, error: created.error }
  return { ok: true, steps, state: 'running', dataDir: data.dir }
}

export async function startContainer(settings) {
  const state = await containerState(settings)
  if (!state.exists) return { ok: false, error: '容器不存在：先点「部署」', needs: 'deploy' }
  if (state.running) return { ok: true, note: '已在运行' }
  const result = await runDocker(['start', settings.service.containerName])
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function stopContainer(settings) {
  const state = await containerState(settings)
  if (!state.exists) return { ok: false, error: '容器不存在' }
  if (!state.running) return { ok: true, note: '已经停止' }
  const result = await runDocker(['stop', settings.service.containerName], { timeoutMs: 60000 })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function restartContainer(settings) {
  const state = await containerState(settings)
  if (!state.exists) return { ok: false, error: '容器不存在：先点「部署」', needs: 'deploy' }
  const result = await runDocker(['restart', settings.service.containerName], { timeoutMs: 90000 })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function removeContainer(settings) {
  const state = await containerState(settings)
  if (!state.exists) return { ok: true, note: '本来就不存在' }
  const result = await runDocker(['rm', '-f', settings.service.containerName], { timeoutMs: 60000 })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function containerLogs(settings, lines = 40) {
  const state = await containerState(settings)
  if (!state.exists) return { ok: false, error: '容器不存在', lines: [] }
  const result = await runDocker(['logs', '--tail', String(Math.max(5, Math.min(300, lines))), settings.service.containerName], {
    timeoutMs: 20000,
  })
  return { ok: true, lines: `${result.stdout}\n${result.stderr}`.trim().split('\n').filter(Boolean) }
}

export function serviceBaseUrl(settings) {
  const configured = settings.baseUrl || ''
  const matchesPort = configured.endsWith(`:${settings.service.port}`)
  return matchesPort ? configured.replace(/\/+$/, '') : `http://127.0.0.1:${settings.service.port}`
}

/** 健康检查：一次真实查询，返回能否搜、多少条、耗时。 */
export async function healthCheck(settings, { timeoutMs = 8000 } = {}) {
  const url = `${serviceBaseUrl(settings)}/search?q=dsh%20health%20probe&format=json`
  const response = await httpGet(url, {
    timeoutMs,
    userAgent: settings.userAgent,
    proxy: settings.proxy?.enabled ? settings.proxy.url : undefined,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    const html = String(response.body || '').trim().startsWith('<')
    return {
      ok: false,
      status: response.status,
      error: html ? '实例开了 html 但没开 json' : response.error || `HTTP ${response.status}`,
      hint: html ? '把 settings.yml 的 search.formats 加上 json 并重启容器' : '容器可能还在启动，稍等几秒再试',
      tookMs: response.tookMs,
    }
  }
  try {
    const payload = JSON.parse(response.body)
    return {
      ok: true,
      status: response.status,
      results: Array.isArray(payload.results) ? payload.results.length : 0,
      tookMs: response.tookMs,
    }
  } catch {
    return { ok: false, status: response.status, error: '返回不是 JSON', tookMs: response.tookMs }
  }
}

/** 一次完整的现场快照，面板和工具共用。 */
export async function snapshot(settings) {
  const docker = await dockerProbe()
  const [container, image] = docker.engine
    ? await Promise.all([containerState(settings), imageState(settings)])
    : [{ exists: false, running: false, state: 'unknown' }, { present: false }]
  const instance = readInstanceSettings(settings)
  const health = docker.engine && container.running ? await healthCheck(settings) : null
  return {
    ok: true,
    docker,
    container,
    image,
    instance,
    health,
    port: settings.service.port,
    baseUrl: serviceBaseUrl(settings),
    dataDir: settings.service.dataDir,
  }
}

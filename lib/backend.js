/**
 * 后端调度：便携运行时（默认） / Docker / 外部实例 / 兜底。
 *
 * 判定规则（backend = auto 时，即「便携优先」）：
 *   1. 便携：DSH 自带 Python 可用 → 用运行时；没装就先装
 *   2. Docker：没有 Python 但有 Docker 引擎 → 用容器
 *   3. 外部：显式选了 external，直接用 baseUrl
 *   4. 都没有 → none，只走 Bing 兜底
 *
 * 面板按钮和 agent 工具共用这里的同一批函数。
 */
import {
  currentRuntime,
  detectPython,
  exportRuntime,
  importRuntime,
  installRuntime,
  listRuntimeVersions,
  runtimeHealth,
  runtimeLogs,
  runtimeStatus,
  startRuntime,
  stopRuntime,
  switchRuntime,
  uninstallRuntime,
} from './runtime.js'
import {
  containerLogs,
  containerState,
  deployContainer,
  dockerProbe,
  healthCheck,
  restartContainer,
  removeContainer,
  startContainer,
  stopContainer,
} from './service.js'

export async function resolveBackend(settings) {
  const explicit = settings.backend
  if (explicit === 'portable' || explicit === 'docker' || explicit === 'external') {
    return { kind: explicit, reason: `显式选择：${explicit}` }
  }
  const python = await detectPython(settings)
  if (python.ok) return { kind: 'portable', reason: `自动：Python 可用（${python.source}）` }
  const docker = await dockerProbe()
  if (docker.engine) return { kind: 'docker', reason: '自动：没有 Python，但有 Docker' }
  return { kind: 'none', reason: '自动：既没有可用 Python，也没有 Docker' }
}

/** 面板与工具共用的完整现场。 */
export async function backendStatus(settings, { health = true } = {}) {
  const backend = await resolveBackend(settings)
  const portable = await runtimeStatus(settings, { health: health && backend.kind === 'portable' })
  let docker = null
  if (backend.kind === 'docker' || settings.backend === 'docker' || health === false) {
    const probe = await dockerProbe()
    const container = probe.engine ? await containerState(settings) : { exists: false, running: false, state: 'unknown' }
    docker = { probe, container }
  }
  const external = { baseUrl: settings.baseUrl, health: null }
  if (backend.kind === 'external' && health) external.health = await healthCheck(settings)
  return {
    ok: true,
    backend,
    portable,
    docker,
    external,
    port: settings.port || 8080,
    running:
      backend.kind === 'portable'
        ? portable.running
        : backend.kind === 'docker'
          ? Boolean(docker?.container?.running)
          : backend.kind === 'external',
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 便携后端：装 → 切 → 起 → 等健康。 */
async function deployPortable(settings, onStep) {
  const installed = await installRuntime(settings, { onStep })
  if (!installed.ok) return installed
  switchRuntime(installed.name)
  onStep?.({ name: 'switch', detail: `切到 ${installed.name}`, ok: true })
  const started = await startRuntime(settings)
  if (!started.ok) return { ok: false, steps: installed.steps, error: started.error }
  onStep?.({ name: 'spawn', detail: `pid ${started.pid}`, ok: true })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(1500)
    const health = await runtimeHealth(settings)
    if (health.ok) {
      onStep?.({ name: 'health', detail: `${health.results} 条 / ${health.tookMs}ms`, ok: true })
      return { ok: true, steps: installed.steps, backend: 'portable', name: installed.name, pid: started.pid, health }
    }
  }
  const log = await runtimeLogs(40)
  return {
    ok: false,
    steps: installed.steps,
    backend: 'portable',
    error: '进程起来了但健康检查没通过（看 logs）',
    logTail: log.lines.slice(-12),
  }
}

async function deployDocker(settings, onStep) {
  return deployContainer(settings, { onStep })
}

export async function backendAction(settings, action, args = {}, { onStep } = {}) {
  const backend = await resolveBackend(settings)

  switch (action) {
    case 'status':
      return backendStatus(settings)

    case 'logs': {
      const lines = Number(args.lines) || 40
      if (backend.kind === 'portable') return runtimeLogs(lines)
      if (backend.kind === 'docker') return containerLogs(settings, lines)
      return { ok: false, error: `后端是 ${backend.kind}，没有日志可看`, lines: [] }
    }

    case 'health':
      return backend.kind === 'portable'
        ? runtimeHealth(settings)
        : backend.kind === 'docker'
          ? healthCheck(settings)
          : healthCheck(settings)

    case 'deploy':
    case 'install':
      if (backend.kind === 'portable') return deployPortable(settings, onStep)
      if (backend.kind === 'docker') return deployDocker(settings, onStep)
      return { ok: false, error: `后端是 ${backend.kind}：既没有 Python 也没有 Docker，先装一个或改用 external` }

    case 'start':
      if (backend.kind === 'portable') return startRuntime(settings)
      if (backend.kind === 'docker') return startContainer(settings)
      return { ok: false, error: `后端是 ${backend.kind}，无需启动` }

    case 'stop':
      if (backend.kind === 'portable') return stopRuntime(settings)
      if (backend.kind === 'docker') return stopContainer(settings)
      return { ok: false, error: `后端是 ${backend.kind}，无需停止` }

    case 'restart': {
      if (backend.kind === 'portable') {
        const stopped = await stopRuntime(settings)
        await sleep(500)
        const started = await startRuntime(settings)
        return { ok: started.ok, stop: stopped, start: started }
      }
      if (backend.kind === 'docker') return restartContainer(settings)
      return { ok: false, error: `后端是 ${backend.kind}，无需重启` }
    }

    case 'remove':
    case 'uninstall':
      if (backend.kind === 'portable') return uninstallRuntime(args.name)
      if (backend.kind === 'docker') return removeContainer(settings)
      return { ok: false, error: `后端是 ${backend.kind}，没有可卸载的东西` }

    case 'export':
      return exportRuntime(args.file)

    case 'import': {
      const imported = await importRuntime(settings, { file: args.file, onStep })
      if (!imported.ok) return imported
      // 先停旧的，否则新实例抢不到端口
      const stopped = await stopRuntime(settings)
      switchRuntime(imported.name)
      const started = await startRuntime(settings)
      return { ok: started.ok, imported: { name: imported.name, steps: imported.steps }, stopped, started }
    }

    case 'versions': {
      const versions = listRuntimeVersions()
      return { ok: true, versions, current: currentRuntime()?.name || null }
    }

    case 'switch': {
      const name = String(args.name || '')
      if (!name) return { ok: false, error: 'switch 需要 name' }
      const stopped = await stopRuntime(settings)
      const switched = switchRuntime(name)
      if (!switched.ok) return switched
      const started = await startRuntime(settings)
      return { ok: started.ok, stopped, switched, started }
    }

    default:
      return { ok: false, error: `未知 action：${action}` }
  }
}

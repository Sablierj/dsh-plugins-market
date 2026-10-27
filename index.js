/**
 * dsh-restart —— 让 DSH 自己重启，重启完**接着这个会话跑**。
 *
 * ## 第一版把头撞破了（2026-10-26），记在这里
 * 09:57 按了重启：宿主 `process.exit(0)` 硬退，`relaunch.cmd` 用 `cmd /c start /b` 拉起，
 * 结果**应用没被拉起来**（11:50 才由人手工启动），中间空了 1 小时 52 分；
 * 而 `restart.log` 里只有「即将退出」那一条，**续跑那条根本没有** ——
 * 也就是「重启后自动续跑」第一次的真实结果不是「没成功」，是「我连失败都不知道」。
 *
 * 三处根因，这一版逐一改掉：
 * 1. **硬退**：`process.exit(0)` 在 Electron 主进程里等于当场砍断，GUI 会崩。
 *    改成先请求 `app.quit()`（动态 import electron），拿不到才退化成 `process.kill`。
 * 2. **助手进程不可靠**：`cmd /c start "" /b xxx.cmd` 与父进程共用一个控制台，
 *    父进程一死助手可能跟着走；就算活着，它**一句日志都不写**。
 *    改成 `powershell -WindowStyle Hidden -File relaunch.ps1`：真正 detach、自带日志、
 *    **拉不起来重试五次**，每次结果都写 `relaunch.log`。
 * 3. **续跑静默失败**：原来只靠 `ctx.inject(['sessionController'], cb)` 一次回调，
 *    回调不来就什么都不说。改成**轮询等它最多 60 秒**，每一步写日志；
 *    标记文件**成功后才删**（失败留着，下次启动再试）。
 *
 * ## 状态文件（`%DSH_HOME%\dsh-restart\`）
 * - `pending-resume.json` —— 待续跑标记（成功续跑后才删）
 * - `restart.log` —— 插件侧日志（加载、续跑尝试、结果）
 * - `relaunch.ps1` / `relaunch.log` —— 助手脚本与它自己的日志（**排查看这个**）
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const STATE_ROOT = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const DIR = join(STATE_ROOT, 'dsh-restart')
const MARKER = join(DIR, 'pending-resume.json')
const LOG = join(DIR, 'restart.log')
const HELPER = join(DIR, 'relaunch.ps1')
const HELPER_LOG = join(DIR, 'relaunch.log')
/* 助手脚本的版本号：改模板就 +1。apply() 时据此判断磁盘上的脚本是不是旧版，旧版直接覆盖 ——
   否则「插件已修好、磁盘还是坏的」会一直骗人（07:36 就是这样白屏两次）。 */
const HELPER_VERSION = '3-envfix-gpu'

export const inject = ['tools']

/* 自测用导出：node 侧 `import(...).then(m => m.writeHelper())` 能按当前模板重建磁盘脚本，
   不必等一次真重启 —— 否则「模板改了但脚本没变」只能靠重启来发现。 */
export { writeHelper }

function ensureDir() {
  try { mkdirSync(DIR, { recursive: true }) } catch { /* 下面的写入会自己抛 */ }
}

function log(line) {
  ensureDir()
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`) } catch { /* 日志失败不影响主流程 */ }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** 助手脚本：等目标进程消失 → 等锁释放 → 启动 exe（五次重试，全程写日志）。 */
function writeHelper() {
  ensureDir()
  /* **先看磁盘**：运行中的插件可能比磁盘旧（改完代码不重启就是这个状态），
     它一写 helper 就把磁盘上已经修好的版本盖回旧版 —— 14:22 那次的坑正是这么来的
     （插件是 14:20 加载的，磁盘脚本 14:22 修好，一点重启按钮就被覆盖）。
     已经存在且带 「launching anyway」 的一律不覆盖。 */
  try {
    const current = readFileSync(HELPER, 'utf8')
    /* 两个条件同时满足才跳过：① 带老判据字段（离线的旧插件靠它避免互相覆盖）
       ② 带当前版本号。缺一个就按新模板重写 —— 磁盘上留着旧模板时，重启一次白屏一次。 */
    if (current.includes('launching anyway') && current.includes('helper-version: ' + HELPER_VERSION)) {
      return HELPER
    }
  } catch { /* 没有就按下面正常写 */ }
  /* 全 ASCII：这文件由 **Windows PowerShell 5.1** 执行，它按 ANSI(cp936) 解码无 BOM 的 .ps1；
     写过中文就会「一句日志都不写、退出码 1」（11:55 实测）。

     三个判据上的坑，都在注释里留档：
     - 温和关闭：本应用**不接受 WM_CLOSE**（taskkill 不带 /F 直接报「只能强制终止」），
       所以等 8 秒就 /F，并在日志里写明这是预期行为、不是崩溃原因。
     - 启动成功：**不能看 Start-Process 返回的 PID** —— Electron 的启动器会立刻退出，
       真正进程换了 PID（12:18:01 那次就是这样被误判成失败的）。改成按进程名 + 启动时间判。
     - 进程名：从 exe 文件名取，不写死，这样换 exe 也能用。 */
  writeFileSync(HELPER, [
    'param([int]$TargetPid, [string]$Exe, [string]$Log, [switch]$NoKill)',
    '# helper-version: ' + HELPER_VERSION,
    'function W([string]$m) { Add-Content -Path $Log -Value ("[{0}] {1}" -f (Get-Date -Format o), $m) }',
    '$name = [System.IO.Path]::GetFileNameWithoutExtension($Exe)',
    '# 2026-10-27 incident: the host runs inside Electron with ELECTRON_RUN_AS_NODE=1.',
    '# Inherited, Start-Process launches a bare node (prints version, exits, no window).',
    '# That was the real cause of eight failed restarts - not the single-instance lock.',
    '# Path form matters: Env:\NAME has ONE backslash. Env:////NAME is an invalid provider',
    '# path and -ErrorAction SilentlyContinue hides it - looks cleared, clears nothing.',
    'Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
    'Remove-Item Env:\\NODE_OPTIONS -ErrorAction SilentlyContinue',
    'W ("env after cleanup: ELECTRON_RUN_AS_NODE=[" + $env:ELECTRON_RUN_AS_NODE + "] NODE_OPTIONS=[" + $env:NODE_OPTIONS + "]")',
    'W "helper up; target pid $TargetPid; exe $Exe; name $name"',
    'if (-not $NoKill) {',
    '  Start-Sleep -Seconds 3',
    '  W "requesting close (taskkill without /F)"',
    '  & taskkill.exe /PID $TargetPid 2>&1 | ForEach-Object { W ("  taskkill: " + $_) }',
    '  $soft = (Get-Date).AddSeconds(8)',
    '  while ((Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $soft)) { Start-Sleep -Milliseconds 400 }',
    '  if (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) {',
    '    W "app does not accept WM_CLOSE (expected for this app); forcing /F - this is a hard close, by design"',
    '    & taskkill.exe /PID $TargetPid /F 2>&1 | ForEach-Object { W ("  taskkill /F: " + $_) }',
    '    # Killing only the host leaves the shell alive: it keeps popping "host stopped"',
    '    # and holds the single-instance lock, so every later Start-Process exits at once.',
    '    & taskkill.exe /IM "$name.exe" /T /F 2>&1 | ForEach-Object { W ("  taskkill /IM: " + $_) }',
    '    Start-Sleep -Seconds 3',
    '  }',
    '}',
    '$gone = $false',
    '$hard = (Get-Date).AddSeconds(20)',
    'while ((Get-Date) -lt $hard) { if (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) { $gone = $true; break }; Start-Sleep -Milliseconds 500 }',
    'if (-not $gone) { W "pid $TargetPid still listed 20s after /F; launching anyway (single-instance guard protects us)" }',
    'W "target gone; waiting 3s for the single-instance lock"',
    'Start-Sleep -Seconds 3',
    '$appArgs = @("--no-sandbox","--disable-gpu","--disable-gpu-compositing","--use-angle=swiftshader","--in-process-gpu")',
    '$ok = $false',
    'for ($i = 1; $i -le 5; $i++) {',
    '  $before = Get-Date',
    '  W ("launch attempt " + $i + " : " + $Exe + " " + ($appArgs -join " "))',
    '# GPU process dies on this machine (Desktop renderer exited: crashed -> blank window).',
    '# These software-rendering flags are the only way the window renders content.',
    '  try { Start-Process -FilePath $Exe -ArgumentList $appArgs | Out-Null } catch { W "launch threw: $($_.Exception.Message)"; Start-Sleep -Seconds 3; continue }',
    '  $deadline = (Get-Date).AddSeconds(12)',
    '  while ((Get-Date) -lt $deadline) {',
    '    Start-Sleep -Milliseconds 700',
    '    $hit = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt $before } | Select-Object -First 1',
    '    if ($hit) { W "launched pid $($hit.Id) (matched by name=$name, started after $($before.ToString()))"; $ok = $true; break }',
    '  }',
    '  if ($ok) { break }',
    '  W "attempt ${i}: no $name process appeared within 12s"',
    '  Start-Sleep -Seconds 3',
    '}',
    'if (-not $ok) { W "five attempts failed; manual start needed"; exit 1 }',
    'W "done"',
    '',
  ].join(String.fromCharCode(13, 10)), 'utf8')
  return HELPER
}

const LAUNCHER = join(DIR, 'launch.cmd')

/**
 * 拉起助手 —— **这一步踩过两次坑，都写在这里**。
 *
 * 坑 A（09:57 那次崩溃）：用 `cmd /c start "" /b relaunch.cmd`。`/b` 表示**同一个控制台**，
 *   父进程一死它就跟着走；而且脚本里没有一句日志，出问题时无从判断。
 *
 * 坑 B（12:11 那次「没动静」）：改成 `spawn('powershell.exe', …, { detached: true, stdio: 'ignore' })`。
 *   实测在这台机器上 `detached:true + stdio:'ignore'` 会让 PowerShell **立刻以退出码 0 结束**，
 *   `relaunch.log` 一个字都没有 —— 看起来「交给了助手」，其实助手一秒都没活。
 *   同一次实测：`detached:false` 时父进程一退出，子进程也跟着死（还是没有日志）。
 *
 * 现在的做法（**实测助手能在父进程退出后继续跑完并写日志**）：
 *   写一个 `launch.cmd`，里面是 `start "" /min powershell -File relaunch.ps1 …`
 *   —— `start` **不带 /b** 会新开一个控制台，真正与父进程脱钩；`/min` + `-WindowStyle Hidden` 不闪窗。
 *   然后我们只负责 `cmd /c launch.cmd`，跑完立刻返回。
 */
function spawnHelper(pid, exe, { noKill = false } = {}) {
  writeHelper()
  ensureDir()
  const log = HELPER_LOG
  const extra = noKill ? ' -NoKill' : ''
  writeFileSync(LAUNCHER, [
    '@echo off',
    // 这两个变量必须在这里就清掉（2026-10-27 事故）：
    // 宿主本身跑在 Electron 里，环境里带着 ELECTRON_RUN_AS_NODE=1；助手继承下去，
    // 再用它去 Start-Process 应用，应用就退化成纯 node —— 打印个 v24.21.0 立刻退出，
    // 端口永远不开。8 次「重启失败」全是这个原因，不是单实例锁。
    'set "ELECTRON_RUN_AS_NODE="',
    'set "NODE_OPTIONS="',
    `start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${HELPER}" -TargetPid ${pid} -Exe "${exe}" -Log "${log}"${extra} 2>> "${HELPER_LOG}.err"`,
    '',
  ].join('\r\n'), 'utf8')
  // 子进程环境同样要干净：cmd 里 set 的是给 ps1 用的，spawn 这里再兜一层。
  const cleanEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.NODE_OPTIONS
  const child = spawn('cmd.exe', ['/c', LAUNCHER], { detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv })
  child.unref()
  return child.pid ?? null
}

/** 尽量温和地退出：Electron 认 app.quit()；拿不到才退化成 kill。 */
async function gracefulExit(delayMs) {
  await new Promise(resolve => setTimeout(resolve, delayMs))
  try {
    const electron = await import('electron')
    const app = electron && electron.app ? electron.app : (electron && electron.default ? electron.default.app : null)
    if (app && typeof app.quit === 'function') {
      log('调用 electron app.quit() 温和退出')
      app.quit()
      return
    }
  } catch (error) {
    log(`拿不到 electron 的 app（${String(error && error.message ? error.message : error)}），退化成 process.kill`)
  }
  try {
    log('process.kill(self) 退出')
    process.kill(process.pid)
    return
  } catch (error) {
    log(`process.kill 失败（${String(error && error.message ? error.message : error)}），最后用 process.exit(0)`)
  }
  process.exit(0)
}

export function apply(ctx, config = {}) {
  const ttlMs = Number(config.resumeTtlMinutes ?? 10) * 60 * 1000
  /* 每次加载都重写一遍助手脚本：好处是它永远在磁盘上，**可以在不重启应用的前提下单独测**
     （第一版正是因为脚本只在「点重启那一刻」才写，出了问题无从复现）。 */
  try { writeHelper() } catch (error) { log('写助手脚本失败：' + String(error && error.message ? error.message : error)) }
  log(`插件已加载 · 状态目录 ${DIR} · 待续跑标记 ${existsSync(MARKER) ? '有' : '无'}`)

  /* ── 启动时：有标记就续跑 ────────────────────────────────────────────────
     三条铁律（都是用真机的两次弹窗换来的）：
     1. **只能通过 `ctx.inject(['sessionController'], cb)` 拿服务** —— 直接 `ctx.get(...)`
        在未声明 inject 时会被 Cordis 的守卫抛错，而这段是 async IIFE，抛错就成了
        未处理的 rejection，启动即弹窗、整个应用起不来。
     2. **整段包 try/catch**：续跑失败最多是「没续上」，绝不能是「应用起不来」。
     3. 每一步都写日志 —— 用户看到的弹窗，我这边要能在 restart.log 里找到对应的一行。 */
  ctx.inject(['sessionController'], (scoped) => {
    void (async () => {
      try {
        const pending = readJson(MARKER)
        if (pending === null) return
        const age = Date.now() - Number(pending.at ?? 0)
        if (!Number.isFinite(age) || age > ttlMs) {
          log(`标记过期（${Math.round(age / 1000)} 秒 > ${Math.round(ttlMs / 1000)} 秒），不动它，只记一条`)
          return
        }
        const text = String(pending.prompt ?? '重启完成，继续。')
        log(`发现待续跑标记：会话 ${pending.sessionId} · 指令 ${text.slice(0, 60)}`)
        const controller = scoped.sessionController
        if (controller === undefined || controller === null) {
          log('sessionController 注入为空 —— 续跑没做成，标记保留')
          return
        }
        const abort = new AbortController()
        await controller.prompt({
          requestId: randomUUID(),
          sessionId: pending.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, abort.signal)
        log(`续跑成功：${pending.sessionId}`)
        try { rmSync(MARKER, { force: true }) } catch { log('续跑成功但标记删不掉，下次启动会重复一句') }
      } catch (error) {
        log(`续跑失败：${String(error && error.message ? error.message : error)} —— 标记保留，下次启动再试`)
      }
    })()
  })

  /* ── 工具一：重启 ─────────────────────────────────────────────────────── */
  ctx.tools.register({
    name: 'dsh_restart',
    description:
      'Restart the DSH host process and, after it comes back, send one message back into THIS session so the '
      + 'conversation continues. It writes a resume marker, starts a hidden PowerShell helper that waits for this PID '
      + 'to exit, waits for the single-instance lock to release, relaunches the executable with up to five retries '
      + '(every attempt logged to relaunch.log), and asks the app to quit gracefully. With dryRun it changes nothing.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to say to this session after the restart. Defaults to 重启完成，继续。' },
        delaySeconds: { type: 'number', description: 'Seconds before quitting, so the tool result reaches the caller. Default 3.' },
        dryRun: { type: 'boolean', description: 'Show the plan and change nothing. Default false.' },
      },
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? {}) }],
    },
    async execute(args, exec) {
      const exe = process.execPath
      const pid = process.pid
      const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null
      const prompt = String(args?.prompt ?? '').trim() || '重启完成，继续。'
      const delayMs = Math.max(0, Math.min(120, Number(args?.delaySeconds ?? 3)) * 1000)

      if (args?.dryRun === true) {
        return [
          '（演练，什么都没做）',
          `宿主进程: pid ${pid} · exe ${exe}`,
          `续跑会话: ${sessionId ?? '（拿不到 —— 重启后将没有人续跑）'}`,
          `续跑指令: ${prompt}`,
          `助手脚本: ${HELPER}`,
          `助手日志: ${HELPER_LOG}`,
          `标记文件: ${MARKER}`,
          '⚠ 按之前请确认 profile 里 dsh-plugin-restart 是 enabled —— 12:18 那次就是它被留成了 false，应用起来了但插件没加载（tool 也找不到）',
        ].join('\n')
      }
      if (sessionId === null) {
        return {
          ok: false,
          error: '拿不到当前会话 id（exec.agent.id 为空）—— 重启之后没人会把「继续」投回来',
          hint: '在会话里调用这个工具，而不是从页面/脚本里调。',
        }
      }

      /* 有「待安装的更新」时拒绝重启（2026-10-27 事故）：
         应用退出时会执行 electron-updater 的 install-on-quit —— 它把安装目录改名、装新版本。
         我们的助手正好在同一个窗口里硬杀 + 反复拉起，把安装目录拆成半截（那次 D: 整个目录
         被删空，装了四次都起不来）。更新应该由应用自己完成，不是我们抢。 */
      const pendingDir = join(process.env.LOCALAPPDATA || '', '@deepseek-aidsh-desktop-updater', 'pending')
      try {
        const pending = existsSync(pendingDir) ? readdirSync(pendingDir) : []
        if (pending.some((f) => f.endsWith('.exe'))) {
          log('拒绝重启：发现待安装的更新 ' + pending.join(','))
          return {
            ok: false,
            error: '有已下载待安装的更新（' + pending.join('、') + '），现在重启会与更新器的 install-on-quit 抢安装目录',
            hint: '先在应用里让它自己完成更新（菜单里的重启/更新），或者手工更新完再调用本工具。',
          }
        }
      } catch (error) {
        log('检查待安装更新失败（不影响重启）：' + String(error && error.message ? error.message : error))
      }

      ensureDir()
      writeFileSync(MARKER, JSON.stringify({ sessionId, prompt, at: Date.now(), by: 'dsh_restart' }, null, 2), 'utf8')
      const helperPid = spawnHelper(pid, exe)
      log(`重启请求：pid ${pid} · 会话 ${sessionId} · 助手 pid ${helperPid ?? '?'}`)

      /* 插件**不自己退出** —— 关应用由助手的 taskkill 完成（那才是用户点 X 的等价物）。
         这里只把「多久之后开始关」的秒数交出去。 */
      log('已交给助手在 ' + Math.round(delayMs / 1000) + ' 秒后关闭应用并重启')

      return [
        '正在重启。',
        `助手 pid ${helperPid ?? '?'} 会在约 ${Math.round(delayMs / 1000)} 秒后用 taskkill（不带 /F）请求应用关闭，等它退出再拉起。`,
        `重启后会把「${prompt}」投回会话 ${sessionId}。`,
        `排查看两个文件：插件 ${LOG} · 助手 ${HELPER_LOG}`,
      ].join('\n')
    },
  })

  /* ── 工具二：读状态（重启到底发生了什么） ─────────────────────────────── */
  ctx.tools.register({
    name: 'dsh_restart_status',
    description:
      'Read the restart plugin state: whether a resume marker is pending, and the tails of restart.log and relaunch.log. '
      + 'Use it to answer "did the restart happen, did the app come back, and did the session continue".',
    parameters: {
      type: 'object',
      properties: { lines: { type: 'number', description: 'Log lines per file. Default 15.' } },
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? {}) }],
    },
    async execute(args) {
      const want = Math.max(1, Math.min(200, Number(args?.lines ?? 15)))
      const tail = (path) => {
        try {
          return readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').slice(-want).join('\n') || '（空）'
        } catch { return '（还没有这个文件）' }
      }
      const pending = readJson(MARKER)
      /* 顺手探一下「温和退出」这条路通不通 —— 这是第一版崩掉的那一处，必须是**可验证的**，
         而不是等下一次真重启时才知道。 */
      let quitPath = '未知'
      try {
        const electron = await import('electron')
        const app = electron && electron.app ? electron.app : (electron && electron.default ? electron.default.app : null)
        quitPath = app && typeof app.quit === 'function' ? 'electron app.quit() 可用' : '拿不到 electron.app，将退化为 process.kill'
      } catch (error) {
        quitPath = 'import electron 失败（' + String(error && error.message ? error.message : error) + '），将退化为 process.kill'
      }
      return [
        `状态目录: ${DIR}`,
        `退出方式: 助手跑 taskkill（不带 /F）请求关闭 → 等它退出 → 重新拉起；插件自己不退`,
        `（参考）electron.app 探测: ${quitPath}`,
        `待续跑标记: ${pending === null ? '没有（正常）' : `${pending.sessionId} · ${new Date(pending.at).toISOString()}`}`,
        '',
        `插件日志 ${LOG}:`,
        tail(LOG),
        '',
        `助手日志 ${HELPER_LOG}:`,
        tail(HELPER_LOG),
      ].join('\n')
    },
  })
}

/**
 * 目录相关的操作系统动作：打开一个目录、弹一个文件夹选择框。
 *
 * ## 为什么这两件事在 Host 侧而不是页面里
 *
 * 浏览器出于安全限制：`<input webkitdirectory>` 只能拿到**相对路径**，
 * 拿不到用户选中目录的绝对路径 —— 而根目录必须是一个能写进设置项的绝对路径。
 * 所以选择动作只能由 Host 完成。插件是纯 Node ESM，已经在用 `child_process`
 * 起浏览器，这里同样只用 Node 自带能力，不引依赖。
 *
 * ## 三条纪律
 *
 * 1. **取消 ≠ 清空**：用户取消对话框返回 `path: null`，不是空串。
 *    调用方据此保持设置不变 —— 把"取消"当成"清空"是一次静默的数据丢失。
 * 2. **失败要说原因**：拿不到选择时返回 `error`，不返回一个猜出来的路径。
 * 3. **不阻塞主进程**：都是异步 spawn；对话框等用户操作，所以有上限（默认 180 秒）。
 */

import { spawn } from 'node:child_process'

/** 用系统资源管理器打开一个目录。打不开就返回原因，不假装成功。 */
export function openInExplorer(target) {
  const path = String(target ?? '').trim()
  if (path === '') return Promise.resolve({ ok: false, error: '路径为空' })
  return new Promise(resolve => {
    try {
      /* `explorer.exe` 选中的是这个已存在的目录；它对成功也常返回 1，
         所以**不拿退出码判断成败** —— 判断交给调用方随后的 existsSync。 */
      const child = spawn('explorer.exe', [path], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', error => resolve({ ok: false, error: error.message }))
      child.unref()
      setTimeout(() => resolve({ ok: true }), 300)
    } catch (error) {
      resolve({ ok: false, error: error.message })
    }
  })
}

const PICK_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择关键词数据源的根目录'
$dialog.ShowNewFolderButton = $true
if ('{INITIAL}' -ne '' -and (Test-Path -LiteralPath '{INITIAL}')) {
  $dialog.SelectedPath = '{INITIAL}'
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`

/**
 * 弹系统原生的文件夹选择框。
 *
 * @returns {Promise<{ok: boolean, path: string|null, cancelled?: boolean, error?: string}>}
 */
export function pickFolder({ initial = '', timeoutMs = 180000 } = {}) {
  const initialPath = String(initial ?? '').replace(/'/g, "''")
  const script = PICK_SCRIPT.replace(/\{INITIAL\}/g, initialPath)

  return new Promise(resolve => {
    let settled = false
    const finish = value => { if (!settled) { settled = true; resolve(value) } }

    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, path: null, error: error.message })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退出 */ }
      finish({
        ok: false,
        path: null,
        error: `超过 ${Math.round(timeoutMs / 1000)} 秒没有选择目录，选择窗口已自动关闭，当前目录没有改变。要换目录，请重新选择。`,
      })
    }, timeoutMs)

    child.on('error', error => { clearTimeout(timer); finish({ ok: false, path: null, error: error.message }) })
    child.on('close', () => {
      clearTimeout(timer)
      const picked = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? ''
      if (picked !== '') return finish({ ok: true, path: picked })
      /* 没有输出 = 用户取消，或者对话框根本没起来。两者都不是"选中了空目录"。
         有 stderr 时把它带出去，便于判断是哪一种。 */
      finish({
        ok: false,
        path: null,
        cancelled: stderr.trim() === '',
        error: stderr.trim() === '' ? undefined : stderr.trim().slice(0, 300),
      })
    })
  })
}

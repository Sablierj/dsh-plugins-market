// Desktop mouse/keyboard control plugin for the DeepSeek Harness host.
//
// Registers the `desktop_mouse` tool on the process-global tools layer so that
// every session's agent can drive the physical Windows mouse and keyboard:
// move / click / scroll / drag / type / key / screenshot. Implementation runs
// PowerShell (user32.dll P/Invoke + System.Drawing) through the host `shell`
// service. Plain CommonJS: the loader imports this file directly, so no
// package dependencies are used.

const VK = {
  enter: 0x0D, tab: 0x09, esc: 0x1B, space: 0x20,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  backspace: 0x08, delete: 0x2E,
}

const PRELUDE = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class DshMouse {',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '}',
  '"@',
  '$out = @{ ok = $true }',
  '$p = New-Object DshMouse+POINT',
  '[DshMouse]::GetCursorPos([ref]$p) | Out-Null',
  '$out.x = $p.X',
  '$out.y = $p.Y',
].join('\n')

function psQuote(value) {
  return String(value).replace(/'/g, "''")
}

function buildCommand(args) {
  const lines = [PRELUDE]
  const action = args.action
  if (action === 'position') {
    // prelude already reports the cursor position
  } else if (action === 'move') {
    if (args.x === undefined || args.y === undefined) throw new Error('move requires x and y')
    lines.push('[DshMouse]::SetCursorPos(' + args.x + ', ' + args.y + ') | Out-Null')
    lines.push('$p = New-Object DshMouse+POINT')
    lines.push('[DshMouse]::GetCursorPos([ref]$p) | Out-Null')
    lines.push('$out.x = $p.X')
    lines.push('$out.y = $p.Y')
  } else if (action === 'click') {
    if (args.x !== undefined && args.y !== undefined) {
      lines.push('[DshMouse]::SetCursorPos(' + args.x + ', ' + args.y + ') | Out-Null')
    }
    const button = args.button === undefined ? 'left' : args.button
    const flags = { left: [2, 4], right: [8, 16], middle: [32, 64] }
    const f = flags[button]
    if (f === undefined) throw new Error('unknown button: ' + button)
    const clicks = Math.max(1, Math.min(5, args.clicks === undefined ? 1 : args.clicks))
    lines.push('for ($i = 0; $i -lt ' + clicks + '; $i++) {')
    lines.push('  [DshMouse]::mouse_event(' + f[0] + ', 0, 0, 0, [UIntPtr]::Zero)')
    lines.push('  [DshMouse]::mouse_event(' + f[1] + ', 0, 0, 0, [UIntPtr]::Zero)')
    lines.push('  Start-Sleep -Milliseconds 60')
    lines.push('}')
    lines.push('$out.message = "clicked ' + button + '"')
  } else if (action === 'scroll') {
    const amount = args.amount === undefined ? 1 : args.amount
    lines.push('[DshMouse]::mouse_event(2048, 0, 0, ' + amount + ', [UIntPtr]::Zero)')
    lines.push('$out.message = "scrolled ' + amount + '"')
  } else if (action === 'drag') {
    if (args.x === undefined || args.y === undefined || args.x2 === undefined || args.y2 === undefined) throw new Error('drag requires x, y, x2, y2')
    lines.push('[DshMouse]::SetCursorPos(' + args.x + ', ' + args.y + ') | Out-Null')
    lines.push('Start-Sleep -Milliseconds 30')
    lines.push('[DshMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)')
    lines.push('$sx = ' + args.x + '; $sy = ' + args.y + '; $ex = ' + args.x2 + '; $ey = ' + args.y2 + '; $steps = 20')
    lines.push('for ($s = 1; $s -le $steps; $s++) {')
    lines.push('  [DshMouse]::SetCursorPos([int]($sx + ($ex - $sx) * $s / $steps), [int]($sy + ($ey - $sy) * $s / $steps)) | Out-Null')
    lines.push('  Start-Sleep -Milliseconds 5')
    lines.push('}')
    lines.push('[DshMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)')
    lines.push('$out.message = "dragged to " + $ex + "," + $ey')
  } else if (action === 'type') {
    if (args.text === undefined) throw new Error('type requires text')
    lines.push('Add-Type -AssemblyName System.Windows.Forms')
    lines.push("Set-Clipboard -Value '" + psQuote(args.text) + "'")
    lines.push('[DshMouse]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)')
    lines.push('[DshMouse]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)')
    lines.push('[DshMouse]::keybd_event(0x56, 0, 0, 2, [UIntPtr]::Zero)')
    lines.push('[DshMouse]::keybd_event(0x11, 0, 0, 2, [UIntPtr]::Zero)')
    lines.push('$out.message = "pasted text (clipboard + Ctrl+V)"')
  } else if (action === 'key') {
    const vk = VK[args.key]
    if (vk === undefined) throw new Error('unknown key: ' + args.key)
    lines.push('[DshMouse]::keybd_event(' + vk + ', 0, 0, [UIntPtr]::Zero)')
    lines.push('[DshMouse]::keybd_event(' + vk + ', 0, 0, 2, [UIntPtr]::Zero)')
    lines.push('$out.message = "pressed ' + psQuote(args.key) + '"')
  } else if (action === 'screenshot') {
    const file = args.file_path === undefined ? 'dsh-screen.png' : args.file_path
    lines.push('Add-Type -AssemblyName System.Windows.Forms')
    lines.push('Add-Type -AssemblyName System.Drawing')
    lines.push('$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen')
    lines.push('$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)')
    lines.push('$g = [System.Drawing.Graphics]::FromImage($bmp)')
    lines.push('$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)')
    lines.push("$path = '" + psQuote(file) + "'")
    lines.push('$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)')
    lines.push('$g.Dispose(); $bmp.Dispose()')
    lines.push('$out.file_path = $path')
    lines.push('$out.width = $vs.Width')
    lines.push('$out.height = $vs.Height')
  } else {
    throw new Error('unknown action: ' + action)
  }
  lines.push('Write-Output ($out | ConvertTo-Json -Compress)')
  return lines.join('\n')
}

module.exports = {
  name: 'desktop-mouse',
  // 本行是必须的：Cordis 的 ctx 是受限代理，没声明 inject 就访问 ctx.tools 会抛
  // 「cannot get property "tools" without inject」，该行会整个激活失败（实测踩过）。
  // 本仓库 amazon-ops 用的是同一个约定（`export const inject = ['tools']`）。
  inject: ['tools'],
  apply(ctx) {
    const shell = ctx.get('shell')
    if (shell === undefined) return
    const sandboxPolicy = ctx.get('sandboxPolicy')
    return ctx.tools.register({
      name: 'desktop_mouse',
      description: 'Control the physical Windows desktop mouse and keyboard of this machine. Call screenshot first to see the screen (saves a PNG in the session workspace, then read it with read_image), then use move/click/scroll/drag with absolute pixel coordinates. position reports the current cursor location. type pastes text via clipboard + Ctrl+V; key presses a named key. Coordinates are physical screen pixels; the screenshot output reports its size.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['position', 'move', 'click', 'scroll', 'drag', 'type', 'key', 'screenshot'],
            description: 'What to do: position (report cursor), move, click, scroll, drag, type (paste text), key (press a named key), screenshot (save full virtual screen PNG).',
          },
          x: { type: 'number', description: 'Absolute screen X in pixels (start point for drag).' },
          y: { type: 'number', description: 'Absolute screen Y in pixels (start point for drag).' },
          x2: { type: 'number', description: 'Drag end X in pixels.' },
          y2: { type: 'number', description: 'Drag end Y in pixels.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click. Default left.' },
          clicks: { type: 'number', description: 'Click count 1-5. Default 1.' },
          amount: { type: 'number', description: 'Wheel delta for scroll: positive scrolls up, negative scrolls down. Default 1.' },
          text: { type: 'string', description: 'Text to type. Uses clipboard paste (Ctrl+V) so any characters work.' },
          key: {
            type: 'string',
            enum: ['enter', 'tab', 'esc', 'space', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'backspace', 'delete'],
            description: 'Key name for the key action.',
          },
          file_path: { type: 'string', description: 'PNG output path for screenshot; default dsh-screen.png in the session workspace.' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            x: { type: 'number' },
            y: { type: 'number' },
            file_path: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            message: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const command = buildCommand(args)
        const session = exec && exec.agent && exec.agent.session ? exec.agent.session : undefined
        const sessionCwd = session && session.header ? session.header.cwd : undefined
        const policy = sandboxPolicy === undefined
          ? undefined
          : sandboxPolicy.resolve(session ? { session: session } : {})
        const result = await shell.run(shell.resolve({
          command,
          timeoutMs: 30000,
          ...(sessionCwd !== undefined ? { workdir: sessionCwd } : {}),
          ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
          ...(exec && exec.signal ? { signal: exec.signal } : {}),
        }))
        if (result.exitCode !== 0) {
          const errText = result.stderr && result.stderr.text ? result.stderr.text : ''
          const outText = result.stdout && result.stdout.text ? result.stdout.text : ''
          throw new Error(errText || outText || ('command exited with code ' + result.exitCode))
        }
        const text = result.stdout && result.stdout.text ? result.stdout.text : ''
        const trimmed = text.trim().split('\n').pop() || ''
        return JSON.parse(trimmed)
      },
    })
  },
}

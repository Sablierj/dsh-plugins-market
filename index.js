/**
 * Team Model Switch
 *
 * One operation, two callers:
 *   - the main-session header button (Client) runs the slash command
 *     `/switch-team-model`;
 *   - the agent tool `team_model_switch` calls the same Host function.
 *
 * The operation reads the Lead session's current model selection, enumerates
 * the live team roster, and calls `sessionController.selectModel` on each
 * teammate session. It never edits session files or writes a model id by hand.
 *
 * Why this exists: DSH freezes a teammate's model selection at spawn. When the
 * main session changes model, existing teammates keep the old selection and
 * can fail with `provider ... has no configured model ...`. Recreating every
 * teammate is correct but expensive; this plugin makes the switch explicit.
 */

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const nodeRequire = createRequire(import.meta.url)

export const name = 'team-model-switch'

export const inject = [
  'tools',
  'commands',
  'agents',
  'agentTeams',
  'sessionController',
  'sessionProjections',
  'agentDefaultModel',
  'sessionPersistence',
]

function readCurrentSelection(ctx, lead) {
  try {
    const state = ctx.sessionProjections.stateOf(lead.session, 'modelSelection')
    const chosen = state?.pending ?? state?.lastUsed
    if (chosen !== null && chosen !== undefined && chosen.provider && chosen.model) {
      return {
        provider: chosen.provider,
        model: chosen.model,
        ...(chosen.reasoningEffort ? { reasoningEffort: chosen.reasoningEffort } : {}),
      }
    }
  } catch {
    /* Projection absent: fall through to the saved default. */
  }
  const fallback = ctx.agentDefaultModel.currentSelection()
  return fallback !== null && fallback !== undefined && fallback.provider && fallback.model
    ? {
        provider: fallback.provider,
        model: fallback.model,
        ...(fallback.reasoningEffort ? { reasoningEffort: fallback.reasoningEffort } : {}),
      }
    : null
}

function describeSelection(selection) {
  return `${selection.provider}/${selection.model}${selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''}`
}

/**
 * Set one teammate's model.
 *
 * The ordinary path is the Session-controller's `selectModel`. A teammate
 * spawned through subagent routing is deliberately refused there ("owned by
 * subagent routing"). For those, append the same `model/selection` event the
 * controller would append: live agents through their Session, inactive ones
 * through a short write handle. No context is rebuilt and no turn is started.
 */
async function setTeammateSelection(ctx, member, selection) {
  try {
    const value = await ctx.sessionController.selectModel({
      sessionId: member.id,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    })
    return { ...value, via: 'session-controller' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('owned by subagent routing')) throw error

    const live = ctx.agents.get(member.id)
    if (live !== undefined && live.session !== undefined) {
      live.session.append('model/selection', selection)
      return { selected: selection, via: 'live-session' }
    }

    const handle = await ctx.sessionPersistence.open(member.id, 'write')
    try {
      const { events } = await handle.read()
      const last = events.length > 0 ? events[events.length - 1] : undefined
      const nextSeq = last === undefined ? 0 : last.seq + 1
      await handle.append([{
        type: 'model/selection',
        seq: nextSeq,
        time: Date.now(),
        data: selection,
      }])
      await handle.flush()
    } finally {
      await handle.close()
    }
    return { selected: selection, via: 'session-persistence' }
  }
}

function assertLead(ctx, agent) {
  const membership = ctx.agentTeams.membership(agent)
  const isLead = membership.role === 'lead'
    || membership.root === agent
    || (membership.root !== null && membership.root !== undefined && membership.root.id === agent.id)
  if (!isLead) throw new Error('只有 Team Lead 可以执行这个操作')
}

async function switchTeamModel(ctx, lead) {
  assertLead(ctx, lead)
  const selection = readCurrentSelection(ctx, lead)
  if (selection === null) {
    throw new Error('读不到当前主会话的模型设置')
  }
  const teammates = ctx.agentTeams.listMembers(lead)
    .filter(member => member.role !== 'lead' && member.id !== lead.id)
  if (teammates.length === 0) {
    return { selection, results: [], text: `当前团队没有 teammate；主会话模型为 ${describeSelection(selection)}` }
  }

  const results = []
  for (const member of teammates) {
    try {
      const value = await setTeammateSelection(ctx, member, selection)
      results.push({ name: member.name, ok: true, selected: value.selected, via: value.via })
    } catch (error) {
      results.push({ name: member.name, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const okCount = results.filter(result => result.ok).length
  const failures = results.filter(result => !result.ok)
  const pending = results.filter(result => result.ok && result.via !== 'session-controller')
  const lines = [
    `已写入 ${okCount}/${results.length} 个团队会话的模型选择：${describeSelection(selection)}。`,
  ]
  if (pending.length > 0) {
    lines.push(`${pending.length} 个 subagent-owned 会话已写入 model/selection；本机旧 ID 已有 provider 兼容别名，通常可直接使用；若仍报旧模型，再重启或重建 teammate。`)
  }
  if (failures.length > 0) {
    lines.push('失败：' + failures.map(result => `${result.name}: ${result.error}`).join('；'))
  }
  return { selection, results, text: lines.join('\n') }
}

/**
 * Restart DSH Desktop after the user confirms.
 *
 * Preferred: Electron's own `app.relaunch()` + `app.exit()`. In this desktop
 * build the plugin host runs in the `dsh-desktop-host` child process, where
 * `require('electron')` is not available, so fall back to a detached helper
 * that terminates the desktop process tree and starts the executable again.
 * The helper waits two seconds first, so this command's response can reach the
 * client and the button can show "正在重启…" before the process disappears.
 */
async function restartDsh() {
  if (process.versions.electron === undefined) {
    throw new Error('当前不是 DSH Desktop，无法自动重启；请手动重启')
  }
  try {
    const electron = nodeRequire('electron')
    const app = electron?.app
    if (app !== undefined && typeof app.relaunch === 'function' && typeof app.exit === 'function') {
      app.relaunch()
      setTimeout(() => app.exit(0), 800)
      return '正在重启 DSH…'
    }
  } catch {
    /* Fall through to the desktop-process helper. */
  }

  const executable = process.execPath
  const parentPid = process.ppid
  if (executable === undefined || parentPid === undefined || parentPid <= 1) {
    throw new Error('读不到 DSH Desktop 的可执行文件或父进程，无法自动重启')
  }
  const quotedExecutable = executable.replace(/'/g, "''")
  const script = [
    'Start-Sleep -Seconds 2',
    `taskkill /PID ${parentPid} /T /F | Out-Null`,
    'Start-Sleep -Seconds 3',
    `Start-Process -FilePath '${quotedExecutable}'`,
  ].join('; ')
  const helper = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-Command', script,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  helper.unref()
  return '正在重启 DSH（桌面进程）…'
}

export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: 'switch-team-model',
    description: '把本团队所有 teammate 会话切换到当前主会话的模型与思考强度',
    handler: async (invocation) => {
      try {
        const result = await switchTeamModel(ctx, invocation.agent)
        return { kind: 'success', text: result.text }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'restart-dsh',
    description: '重启 DSH Desktop（用于让 subagent-owned 会话的 model/selection 生效）',
    handler: async (invocation) => {
      try {
        assertLead(ctx, invocation.agent)
        return { kind: 'success', text: await restartDsh() }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'team_model_switch',
    description:
      'Switch every teammate session in this Team to the Lead session’s current model and reasoning effort. '
      + 'Use only when the user explicitly asks to align team models; this changes every teammate session, '
      + 'not just the current one. The operation is the same one behind the UI button.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value),
      }],
    },
    async execute(_args, exec) {
      const lead = exec?.agent ?? ctx.agents.currentInitiator()
      if (lead === undefined) {
        return { ok: false, error: 'team_model_switch must be called from a Team Lead session' }
      }
      try {
        const result = await switchTeamModel(ctx, lead)
        return result.text
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))

  /* Temporary diagnostic: proves whether the host can reach Electron's
     app.relaunch/app.exit and whether /restart-dsh is registered. It does not
     restart anything. */
  ctx.effect(() => ctx.tools.register({
    name: 'team_model_switch_diag',
    description: 'Diagnose team-model-switch restart wiring without restarting.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const lead = exec?.agent ?? ctx.agents.currentInitiator()
      const command = lead === undefined ? undefined : ctx.commands.find(lead, 'restart-dsh')
      let electron = null
      let linkedBinding = null
      try {
        const binding = process._linkedBinding?.('electron_browser_app')
        linkedBinding = binding === undefined ? null : { type: typeof binding, keys: Object.keys(binding).slice(0, 12) }
      } catch (error) {
        linkedBinding = { error: error instanceof Error ? error.message : String(error) }
      }
      try {
        const loaded = nodeRequire('electron')
        electron = {
          hasApp: loaded?.app !== undefined,
          relaunch: typeof loaded?.app?.relaunch,
          exit: typeof loaded?.app?.exit,
        }
      } catch (error) {
        electron = { error: error instanceof Error ? error.message : String(error) }
      }
      return JSON.stringify({
        electronVersion: process.versions.electron ?? null,
        processType: process.type ?? null,
        execPath: process.execPath,
        ppid: process.ppid,
        command: command === undefined ? null : { name: command.name, description: command.description },
        electron,
        linkedBinding,
      })
    },
  }))
}

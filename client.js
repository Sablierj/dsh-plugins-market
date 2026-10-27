/**
 * Client half: one button in the main-session header.
 *
 * The button does not talk to teammate sessions directly. It executes the Host
 * command `/switch-team-model`; the Host command owns the roster walk and the
 * per-session `selectModel` calls, so the button and the agent tool share one
 * implementation.
 */
window.__ModuleLoader__.load({
  id: '@local/team-model-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const NS = 'team-model-switch'
    const zh = {
      'button.label': '切换团队模型',
      'button.busy': '切换中…',
      'button.done': '已写入',
      'button.failed': '切换失败',
      'button.title': '把本团队所有 teammate 会话切换到当前主会话的模型与思考强度',
      'button.doneTitle': '已写入当前主会话的模型设置',
      'button.partialTitle': '部分 teammate 切换失败，悬停查看原因',
      'dialog.title': '团队模型已写入',
      'dialog.body': '已写入模型选择。本机已为旧 ID 配置兼容别名，旧 teammate 通常可直接使用；若仍报旧模型，可重启 DSH 或重建 teammate。现在重启？',
      'dialog.later': '稍后',
      'dialog.restart': '立即重启',
      'dialog.restarting': '正在重启 DSH…',
      'dialog.restartFailed': '重启失败：',
    }
    const en = {
      'button.label': 'Switch team model',
      'button.busy': 'Switching…',
      'button.done': 'Written',
      'button.failed': 'Switch failed',
      'button.title': 'Switch every teammate session to this session’s model and reasoning effort',
      'button.doneTitle': 'Wrote this session’s model selection to the team',
      'button.partialTitle': 'Some teammates failed; hover for details',
      'dialog.title': 'Team model written',
      'dialog.body': 'Model selection written. This machine has a compatibility alias for the legacy id, so old teammates usually work directly; if one still reports the old model, restart DSH or recreate it. Restart DSH now?',
      'dialog.later': 'Later',
      'dialog.restart': 'Restart now',
      'dialog.restarting': 'Restarting DSH…',
      'dialog.restartFailed': 'Restart failed: ',
    }

    function SwitchButton({ sessionId, switchTeamModel, restartDsh, t }) {
      const [phase, setPhase] = useState('idle')
      const [detail, setDetail] = useState('')
      const [dialogOpen, setDialogOpen] = useState(false)
      const [restarting, setRestarting] = useState(false)
      const [restartError, setRestartError] = useState('')
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])
      useEffect(() => {
        if (!dialogOpen) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' && !restarting) setDialogOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [dialogOpen, restarting])

      const onClick = () => {
        if (phase === 'busy') return
        setPhase('busy')
        setDetail('')
        setRestartError('')
        void switchTeamModel().then((outcome) => {
          if (!alive.current) return
          setPhase(outcome.ok ? 'done' : 'failed')
          setDetail(outcome.text !== '' ? outcome.text : (outcome.ok ? t('button.doneTitle') : t('button.partialTitle')))
          if (outcome.ok) setDialogOpen(true)
        }, (reason) => {
          if (!alive.current) return
          setPhase('failed')
          setDetail(reason instanceof Error ? reason.message : String(reason))
        })
      }

      const onRestart = () => {
        if (restarting) return
        setRestarting(true)
        setRestartError('')
        void restartDsh().then((outcome) => {
          if (!alive.current) return
          if (outcome.ok) {
            setDetail(outcome.text !== '' ? outcome.text : t('dialog.restarting'))
          } else {
            setRestarting(false)
            setRestartError(outcome.text !== '' ? outcome.text : t('dialog.restartFailed'))
          }
        }, (reason) => {
          if (!alive.current) return
          setRestarting(false)
          setRestartError(reason instanceof Error ? reason.message : String(reason))
        })
      }

      const label = phase === 'busy'
        ? t('button.busy')
        : phase === 'done'
          ? t('button.done')
          : phase === 'failed'
            ? t('button.failed')
            : t('button.label')
      const title = detail !== ''
        ? detail
        : phase === 'done'
          ? t('button.doneTitle')
          : t('button.title')

      const button = h('button', {
        type: 'button',
        onClick,
        disabled: phase === 'busy',
        title,
        'aria-label': t('button.title'),
        style: {
          height: '28px',
          padding: '0 10px',
          border: '0.5px solid var(--dsw-alias-border-l3)',
          borderRadius: '999px',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: phase === 'failed'
            ? 'var(--dsw-alias-label-error, var(--dsw-alias-label-primary))'
            : 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '1',
          cursor: phase === 'busy' ? 'default' : 'pointer',
          opacity: phase === 'busy' ? 0.65 : 1,
          whiteSpace: 'nowrap',
        },
      }, label)

      if (!dialogOpen) return button

      return h(React.Fragment, null,
        button,
        h('div', {
          role: 'presentation',
          onClick: () => { if (!restarting) setDialogOpen(false) },
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'grid',
            placeItems: 'center',
            padding: '16px',
            background: 'rgba(0, 0, 0, 0.28)',
          },
        },
        h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('dialog.title'),
          onClick: (event) => event.stopPropagation(),
          style: {
            width: '420px',
            maxWidth: 'calc(100vw - 32px)',
            padding: '18px 20px 16px',
            border: '0.5px solid var(--dsw-alias-border-l3)',
            borderRadius: '12px',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '0 16px 48px rgba(0, 0, 0, 0.24)',
          },
        },
        h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '8px' } }, t('dialog.title')),
        h('div', {
          style: {
            fontSize: '13px',
            lineHeight: '1.55',
            color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
            whiteSpace: 'pre-wrap',
            maxHeight: '220px',
            overflow: 'auto',
            marginBottom: '14px',
          },
        }, `${t('dialog.body')}${detail !== '' ? `\n\n${detail}` : ''}`),
        restartError !== '' && h('div', {
          role: 'alert',
          style: { fontSize: '12px', color: 'var(--dsw-alias-label-error, #c0392b)', marginBottom: '10px' },
        }, `${t('dialog.restartFailed')}${restartError}`),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
          h('button', {
            type: 'button',
            disabled: restarting,
            onClick: () => setDialogOpen(false),
            style: {
              height: '30px',
              padding: '0 12px',
              border: '0.5px solid var(--dsw-alias-border-l3)',
              borderRadius: '8px',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              cursor: restarting ? 'default' : 'pointer',
              opacity: restarting ? 0.5 : 1,
            },
          }, t('dialog.later')),
          h('button', {
            type: 'button',
            autoFocus: true,
            disabled: restarting,
            onClick: onRestart,
            style: {
              height: '30px',
              padding: '0 12px',
              border: '0.5px solid var(--dsw-alias-border-l3)',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
              color: 'var(--dsw-alias-label-primary)',
              cursor: restarting ? 'default' : 'pointer',
              opacity: restarting ? 0.65 : 1,
            },
          }, restarting ? t('dialog.restarting') : t('dialog.restart'))),
        )))
    }

    return {
      inject: ['slots', 'remote', 'remote.commands', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'team-model-switch: dictionaries')
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'team-model-switch',
          order: 30,
          locale: NS,
          inject: (sessionId) => ({
            switchTeamModel: async () => {
              const result = await ctx.remote.commands.execute(sessionId, '/switch-team-model', [])
              if (!result.ok) return { ok: false, text: `${result.error.message} (${result.error.code})` }
              if (result.value === undefined) return { ok: false, text: 'unknown command: /switch-team-model' }
              const execution = result.value.result
              return { ok: execution.kind === 'success', text: execution.text ?? '' }
            },
            restartDsh: async () => {
              const result = await ctx.remote.commands.execute(sessionId, '/restart-dsh', [])
              if (!result.ok) return { ok: false, text: `${result.error.message} (${result.error.code})` }
              if (result.value === undefined) return { ok: false, text: 'unknown command: /restart-dsh' }
              const execution = result.value.result
              return { ok: execution.kind === 'success', text: execution.text ?? '' }
            },
          }),
        }, SwitchButton))
      },
    }
  },
})

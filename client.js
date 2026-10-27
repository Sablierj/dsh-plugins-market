/**
 * Client half of @local/wechat-session-bind.
 *
 * A single session-header action: 「绑定微信」. The owner passes `sessionId`
 * (same contract as ui-jobs' JobListAction) and a `t` translator bound to the
 * registered namespace. Clicking binds WeChat to this session through the
 * Host route; the operation is user-only by design.
 */
window.__ModuleLoader__.load({
  id: '@local/wechat-session-bind',
  factory (require) {
    const React = require('react')
    const { useEffect, useState } = React
    const h = React.createElement

    const DICTS = {
      zh: {
        bind: '绑定微信',
        checking: '读取中…',
        binding: '绑定中…',
        bound: '微信已绑定',
        boundLive: '微信已绑定 ✓',
        boundPending: '已写入 · 未生效，点击重试',
        failed: '绑定失败',
        title: '把微信绑定到当前会话：微信消息将路由到这里',
      },
      en: {
        bind: 'Bind WeChat',
        checking: 'Loading…',
        binding: 'Binding…',
        bound: 'WeChat bound',
        boundLive: 'WeChat bound ✓',
        boundPending: 'Written · not live yet, click to retry',
        failed: 'Bind failed',
        title: 'Bind WeChat to this session: WeChat messages will route here',
      },
    }

    const buttonStyle = {
      font: 'inherit',
      fontSize: 12,
      padding: '3px 10px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'none',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    const boundStyle = {
      ...buttonStyle,
      color: 'var(--dsw-alias-state-success-primary)',
      borderColor: 'var(--dsw-alias-state-success-primary)',
    }
    const errorStyle = {
      ...buttonStyle,
      color: 'var(--dsw-alias-state-error-primary)',
      borderColor: 'var(--dsw-alias-state-error-primary)',
    }

    /** One header action: reads its bound state, binds on click, reports honestly. */
    function WechatBindAction ({ sessionId, t }) {
      const tr = (key) => {
        try { return t ? String(t(key)) : DICTS.zh[key] } catch { return DICTS.zh[key] }
      }
      const [phase, setPhase] = useState('checking') // checking | idle | binding | bound | boundPending | error
      const [detail, setDetail] = useState('')

      useEffect(() => {
        let alive = true
        setPhase('checking')
        fetch(`/api/wechat-session-bind/state?sessionId=${encodeURIComponent(sessionId ?? '')}`)
          .then(r => r.json())
          .then(data => {
            if (!alive) return
            if (data?.ok !== true) { setPhase('error'); setDetail(String(data?.error ?? '')); return }
            if (!data.bound) setPhase('idle')
            else setPhase(data.live === false ? 'boundPending' : 'bound')
          })
          .catch(error => { if (alive) { setPhase('error'); setDetail(String(error?.message ?? error)) } })
        return () => { alive = false }
      }, [sessionId])

      const bind = async () => {
        if (phase === 'binding' || phase === 'checking') return
        setPhase('binding')
        setDetail('')
        try {
          const r = await fetch('/api/wechat-session-bind/state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'bind', sessionId }),
          })
          const data = await r.json()
          if (data?.ok === true && data?.bound === true) {
            setPhase(data.live ? 'bound' : 'boundPending')
            setDetail(String(data?.note ?? ''))
          } else {
            setPhase('error')
            setDetail(String(data?.error ?? `HTTP ${r.status}`))
          }
        } catch (error) {
          setPhase('error')
          setDetail(String(error?.message ?? error))
        }
      }

      const label = phase === 'checking' ? tr('checking')
        : phase === 'binding' ? tr('binding')
        : phase === 'bound' ? tr('boundLive')
        : phase === 'boundPending' ? tr('boundPending')
        : phase === 'error' ? tr('failed')
        : tr('bind')
      const style = (phase === 'bound' || phase === 'boundPending') ? boundStyle
        : phase === 'error' ? errorStyle
        : buttonStyle
      const title = detail !== '' ? `${tr('title')} — ${detail}` : tr('title')

      return h('button', {
        type: 'button',
        style,
        title,
        onClick: bind,
        disabled: phase === 'binding' || phase === 'checking',
      }, label)
    }

    return {
      inject: ['slots', 'locale'],
      apply (ctx) {
        try { ctx.locale.register('wechatBind', DICTS) } catch { /* dictionaries are cosmetic */ }
        ctx.effect(() => ctx.slots.inject(
          'conversation.session.header.actions',
          () => ctx.slots.register({
            name: 'conversation.session.header.actions',
            id: 'wechat-bind',
            order: 30,
            locale: 'wechatBind',
          }, WechatBindAction),
        ), 'wechat-session-bind: session header action')
      },
    }
  },
})

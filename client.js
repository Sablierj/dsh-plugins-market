/**
 * Client 侧：记忆服务面板（左侧栏入口 + 中央一页）。
 *
 * 设计目标：像一个「服务控制台」，不像一张表单。
 *   顶部固定标题栏（状态点 + 方言 + 检测时间）
 *   二级分段导航：概览 / 浏览 / 设置
 *   概览：三个数字块 + 两条服务健康行 + 画像摘要 + 活动
 *   浏览：左列表 + 右详情（场景）/ 搜索 + 表格（原子、对话）
 *   设置：分组表单 + 行为开关 + 危险操作单独一组
 *
 * 只用 React.createElement + 内联样式；颜色走宿主 CSS 变量。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-memory-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/memory-bridge/api'

    const T = {
      bg: 'var(--dsw-alias-bg-base)',
      card: 'var(--dsw-alias-bg-layer-1)',
      soft: 'var(--dsw-alias-bg-layer-2)',
      line: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    /** 半透明色：宿主 token 可能是 hex 也可能是 rgb()，直接拼 8 位 alpha 会失效，用 color-mix。 */
    const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    const RADIUS = 10
    const STYLE_ID = 'memory-bridge-style'

    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = `
        [data-mb] input::placeholder, [data-mb] textarea::placeholder { color: var(--dsw-alias-label-secondary); opacity: .65 }
        [data-mb] input:focus { border-color: var(--dsw-alias-brand-primary) !important }
        [data-mb] button:hover:not(:disabled) { filter: brightness(1.12) }
        [data-mb] button:active:not(:disabled) { transform: translateY(.5px) }
        [data-mb] ::-webkit-scrollbar { width: 9px; height: 9px }
        [data-mb] ::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l1); border-radius: 6px }
        [data-mb] pre::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l1) }
      `
      document.head.appendChild(el)
    }

    /** markdown-lite：把画像/场景的 #/##/-/空行渲染成人看的排版，而不是一整块等宽代码。 */
    const Prose = (text, maxHeight) =>
      h('div', {
        style: {
          maxHeight: maxHeight ?? 460,
          overflowY: 'auto',
          fontSize: 13,
          lineHeight: 1.75,
          color: T.text,
        },
      }, String(text || '').split(/\r?\n/).map((raw, i) => {
        const line = raw.trimEnd()
        if (line.trim() === '') return h('div', { key: String(i), style: { height: 8 } })
        if (/^###\s+/.test(line)) return h('div', { key: String(i), style: { fontSize: 13, fontWeight: 600, marginTop: 6 } }, line.replace(/^###\s+/, ''))
        if (/^##\s+/.test(line)) return h('div', { key: String(i), style: { fontSize: 14, fontWeight: 600, marginTop: 10, marginBottom: 2 } }, line.replace(/^##\s+/, ''))
        if (/^#\s+/.test(line)) return h('div', { key: String(i), style: { fontSize: 15.5, fontWeight: 600, marginBottom: 6 } }, line.replace(/^#\s+/, ''))
        if (/^[-*]\s+/.test(line)) {
          return h('div', { key: String(i), style: { display: 'flex', gap: 8, paddingLeft: 2 } }, [
            h('span', { key: 'b', style: { color: T.muted, lineHeight: '1.75' } }, '•'),
            h('span', { key: 't' }, line.replace(/^[-*]\s+/, '')),
          ])
        }
        return h('div', { key: String(i) }, line)
      }))

    /* ── 基础件 ─────────────────────────────────────────────── */

    const Section = (title, right, children, key) =>
      h('section', { key, style: { marginBottom: 22 } }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } }, [
          h('div', {
            key: 't',
            style: { fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: T.muted, fontWeight: 600 },
          }, title),
          h('div', { key: 'line', style: { flex: 1, height: 1, background: T.line, opacity: 0.7 } }),
          right ?? null,
        ]),
        children,
      ])

    const Card = (children, key, style) =>
      h('div', {
        key,
        style: {
          background: T.card,
          border: `1px solid ${T.line}`,
          borderRadius: RADIUS,
          ...style,
        },
      }, children)

    const Dot = (state) => {
      const color = state === 'ok' ? T.ok : state === 'bad' ? T.danger : state === 'warn' ? T.warn : T.muted
      return h('span', {
        style: {
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: state === 'ok' ? `0 0 0 3px ${tint(color, 14)}` : 'none',
          flex: '0 0 auto',
        },
      })
    }

    const Chip = (text, tone = 'muted') => {
      const map = {
        ok: { fg: T.ok, bg: tint(T.ok, 14), bd: tint(T.ok, 40) },
        bad: { fg: T.danger, bg: tint(T.danger, 14), bd: tint(T.danger, 40) },
        accent: { fg: T.accent, bg: tint(T.accent, 14), bd: tint(T.accent, 40) },
        muted: { fg: T.muted, bg: 'transparent', bd: T.line },
      }
      const c = map[tone] ?? map.muted
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '2px 8px',
          borderRadius: 999,
          fontSize: 11.5,
          lineHeight: '18px',
          color: c.fg,
          background: c.bg,
          border: `1px solid ${c.bd}`,
          whiteSpace: 'nowrap',
        },
      }, text)
    }

    const Btn = (text, onClick, opts = {}) =>
      h('button', {
        key: opts.key,
        onClick,
        disabled: opts.disabled === true,
        title: opts.title,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: opts.small ? '4px 10px' : '6px 12px',
          fontSize: opts.small ? 12 : 12.5,
          lineHeight: '18px',
          borderRadius: 7,
          border: `1px solid ${opts.danger ? tint(T.danger, 45) : opts.primary ? T.accent : T.line}`,
          background: opts.primary ? T.accent : opts.danger ? tint(T.danger, 10) : 'transparent',
          color: opts.primary ? '#fff' : opts.danger ? T.danger : T.text,
          cursor: opts.disabled === true ? 'not-allowed' : 'pointer',
          opacity: opts.disabled === true ? 0.45 : 1,
          whiteSpace: 'nowrap',
        },
      }, text)

    const Label = (text, hint) =>
      h('div', { style: { marginBottom: 6 } }, [
        h('div', { key: 'l', style: { fontSize: 12, color: T.text, fontWeight: 500 } }, text),
        hint ? h('div', { key: 'h', style: { fontSize: 11.5, color: T.muted, marginTop: 2, lineHeight: 1.5 } }, hint) : null,
      ])

    const Input = (props) =>
      h('input', {
        ...props,
        style: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 10px',
          fontSize: 12.5,
          lineHeight: '18px',
          borderRadius: 7,
          border: `1px solid ${T.line}`,
          background: T.bg,
          color: T.text,
          outline: 'none',
          maxWidth: 560,
          ...(props.style ?? {}),
        },
      })

    const Field = (text, hint, props) =>
      h('div', { style: { marginBottom: 14 } }, Label(text, hint), Input(props))

    const Select = (props) =>
      h('select', {
        ...props,
        style: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 10px',
          fontSize: 12.5,
          lineHeight: '18px',
          borderRadius: 7,
          border: `1px solid ${T.line}`,
          background: T.bg,
          color: T.text,
        },
      }, props.children)

    const Stat = (value, label, sub, key) =>
      h('div', {
        key,
        style: {
          flex: '1 1 150px',
          minWidth: 0,
          padding: '14px 16px',
          background: T.card,
          border: `1px solid ${T.line}`,
          borderRadius: RADIUS,
        },
      }, [
        h('div', {
          key: 'v',
          style: { fontSize: 26, fontWeight: 600, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.5 },
        }, String(value)),
        h('div', { key: 'l', style: { fontSize: 12, color: T.text, marginTop: 6 } }, label),
        h('div', { key: 's', style: { fontSize: 11.5, color: T.muted, marginTop: 2 } }, sub),
      ])

    const empty = (text) =>
      h('div', {
        style: {
          padding: '18px 14px',
          border: `1px dashed ${T.line}`,
          borderRadius: RADIUS,
          color: T.muted,
          fontSize: 12.5,
          lineHeight: 1.6,
          textAlign: 'center',
        },
      }, text)

    const Code = (text, maxHeight) =>
      h('pre', {
        style: {
          margin: 0,
          padding: 12,
          background: T.bg,
          border: `1px solid ${T.line}`,
          borderRadius: 8,
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: maxHeight ?? 380,
          overflowY: 'auto',
          color: T.text,
        },
      }, text)

    const when = (stamp) => {
      if (!stamp) return '—'
      const d = new Date(stamp)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function SidebarEntry({ size = 20, active = false }) {
      return h('div', {
        style: {
          width: size,
          height: size,
          display: 'grid',
          placeItems: 'center',
          color: active ? T.accent : T.muted,
          fontSize: size * 0.78,
          lineHeight: 1,
        },
        title: '记忆服务',
      }, '🧠')
    }

    /* ── 面板 ───────────────────────────────────────────────── */

    function Panel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [toast, setToast] = useState('')
      const [form, setForm] = useState(null)
      const [advanced, setAdvanced] = useState(false)
      const [diag, setDiag] = useState(null)

      const [tabName, setTabName] = useState('overview')
      const [overview, setOverview] = useState(null)
      const [proxy, setProxy] = useState(null)

      const [layer, setLayer] = useState('persona')
      const [persona, setPersona] = useState(null)
      const [scenes, setScenes] = useState(null)
      const [scene, setScene] = useState(null)
      const [query, setQuery] = useState('')
      const [rows, setRows] = useState(null)
      const [logs, setLogs] = useState(null)
      const [sessions, setSessions] = useState(null)
      const [keywordText, setKeywordText] = useState('')
      const [autoRefresh, setAutoRefresh] = useState(true)
      const [lastTickAt, setLastTickAt] = useState(0)

      useEffect(() => { ensureStyle() }, [])

      const load = useCallback(async () => {
        try {
          const response = await fetch(API, { cache: 'no-store' })
          const body = await response.json()
          setState(body)
          setError('')
          if (form === null && body?.config) setForm(body.config)
        } catch (loadError) {
          setError(String(loadError?.message ?? loadError))
        }
      }, [form])

      /** 静默 POST：自动刷新不能弹 toast、不能占用 busy，否则会打断用户手上的操作。 */
      const silentPost = async (payload) => {
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          return await response.json()
        } catch {
          return null
        }
      }

      // 最新的取数函数放 ref 里，定时器不因为依赖变化被反复重建
      const live = React.useRef({})

      useEffect(() => {
        if (autoRefresh !== true) return undefined
        let tick = 0
        const run = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          tick += 1
          const { silentPost, load, tabName: currentTab } = live.current
          if (!silentPost) return
          // 每 30s 探一次连通性（一次 /health），stats 由宿主落库，再 GET 回来
          await silentPost({ action: 'test' })
          await load()
          if (currentTab === 'overview') {
            const p = await silentPost({ action: 'proxy-status', quiet: true })
            if (p) setProxy(p)
            if (tick % 2 === 1) {
              const o = await silentPost({ action: 'browse', mode: 'overview' })
              if (o?.ok) setOverview(o)
            }
            if (tick % 4 === 1) {
              const l = await silentPost({ action: 'logs', limit: 40 })
              if (l) setLogs(l.rows ?? [])
            }
          }
          setLastTickAt(Date.now())
        }
        const timer = setInterval(() => { void run() }, 30000)
        return () => clearInterval(timer)
      }, [autoRefresh])

      const post = async (payload, tag) => {
        setBusy(tag)
        setToast('')
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json()
          if (body?.config) setForm(body.config)
          if (body?.message) setToast(body.message)
          else if (body?.ok === false) setToast('失败')
          return body
        } catch (postError) {
          setToast(`请求失败：${postError?.message ?? postError}`)
          return null
        } finally {
          setBusy('')
        }
      }

      const config = form ?? state?.config ?? null
      const stats = state?.stats ?? {}
      const connected = stats.lastCheckOk
      const statusTone = connected === true ? 'ok' : connected === false ? 'bad' : 'muted'
      const statusText = connected === true ? '已连接' : connected === false ? '不可用' : '未检测'
      const dialect = stats.dialect || config?.dialect || ''

      const set = (key) => (event) => {
        const value = event?.target?.type === 'checkbox' ? event.target.checked : event.target.value
        setForm({ ...(config ?? {}), [key]: value })
      }

      const onPaste = (event) => {
        const text = String(event?.clipboardData?.getData('text') ?? '')
        const url = /https?:\/\/\S+/u.exec(text)?.[0] ?? ''
        const key = /rk_[A-Za-z0-9]+/u.exec(text)?.[0] ?? ''
        if (url === '' && key === '') return
        event.preventDefault()
        setForm({ ...(config ?? {}), ...(url === '' ? {} : { baseUrl: url }), ...(key === '' ? {} : { relayKey: key }) })
        setToast('已从粘贴内容拆出地址与 Relay Key，记得保存')
      }

      const refreshOverview = () => post({ action: 'browse', mode: 'overview' }, 'overview').then((body) => { if (body?.ok) setOverview(body) })
      const loadProxy = () => post({ action: 'proxy-status' }, 'proxy').then((body) => { if (body) setProxy(body) })
      const loadLogs = () => post({ action: 'logs', limit: 40 }, 'logs').then((body) => { if (body) setLogs(body.rows ?? []) })
      const loadSessions = () => post({ action: 'sessions' }, 'sessions').then((body) => { if (body) setSessions(body) })
      const parseKeywords = () => keywordText.split(/[，,\s]+/).map((word) => word.trim()).filter(Boolean)
      const syncSessions = (limit) => post({ action: 'sync-sessions', limit, keywords: parseKeywords() }, 'sync-sessions').then((body) => { if (body) { setSessions(body); setToast(body.message ?? '') } })

      // 后台同步：有进度就每 5 秒刷新一次统计
      useEffect(() => {
        if (sessions?.sync?.running !== true) return undefined
        const timer = setInterval(() => { void post({ action: 'sessions', keywords: parseKeywords() }, 'sessions').then((body) => { if (body) setSessions(body) }) }, 5000)
        return () => clearInterval(timer)
      }, [sessions?.sync?.running])

      // 定义都齐了再挂到 ref 上（上面 useEffect 里的定时器只在这一行之后才可能触发）
      live.current = { load, silentPost, tabName }
      const toggleProxy = (enabled) => post({ action: 'proxy-toggle', enabled, confirm: true }, 'proxy-toggle').then((body) => { if (body) { setToast(body.message ?? ''); void loadProxy() } })
      const loadPersona = () => post({ action: 'browse', mode: 'persona' }, 'persona').then((body) => { if (body) setPersona(body) })
      const openScene = (path) => post({ action: 'browse', mode: 'scene', path }, 'scene').then((body) => { if (body) setScene(body) })
      const loadScenes = () => post({ action: 'browse', mode: 'scenes', limit: 60 }, 'scenes').then((body) => {
        if (!body) return
        setScenes(body)
        if (scene === null && body.entries?.length) void openScene(body.entries[0].path)
      })
      const searchLayer = (mode) => post({ action: 'browse', mode, query, limit: 20 }, mode).then((body) => { if (body) setRows(body) })

      useEffect(() => {
        if (tabName === 'overview' && overview === null && busy === '') {
          void refreshOverview()
          void loadProxy()
          void loadLogs()
        }
      }, [tabName, overview])

      useEffect(() => {
        if (tabName !== 'browse') return
        if (layer === 'persona' && persona === null && busy === '') void loadPersona()
        if (layer === 'scenes' && scenes === null && busy === '') void loadScenes()
      }, [tabName, layer])

      const header = h('div', {
        key: 'header',
        style: {
          flex: '0 0 auto',
          background: T.bg,
          padding: '16px clamp(12px, 3vw, 24px) 12px',
          borderBottom: `1px solid ${T.line}`,
        },
      }, [
        h('div', { key: 'row1', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
          h('div', { key: 'title', style: { fontSize: 16, fontWeight: 600, letterSpacing: -0.2 } }, '记忆'),
          Chip(statusText, statusTone),
          dialect ? Chip(`方言 ${dialect}`, 'accent') : null,
          config?.enabled === false ? Chip('已停用', 'bad') : null,
          config?.autoCapture === true ? Chip('自动捕获', 'ok') : null,
          h('div', { key: 'sp', style: { flex: 1 } }),
          Btn(busy === 'test' ? '测试中…' : '测试连接', async () => {
            const body = await post({ action: 'test' }, 'test')
            setOverview(null)
            if (body?.ok) { void refreshOverview(); void loadProxy() }
          }, { small: true, disabled: busy !== '' }),
        ]),
        h('div', { key: 'row2', style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11.5, color: T.muted, flexWrap: 'wrap' } }, [
          h('span', { key: 'a', style: { fontFamily: MONO } }, (config?.baseUrl ?? '').replace('http://47.251.253.188:8080/relay/', '…/relay/')),
          h('span', { key: 'b' }, '·'),
          h('span', { key: 'c' }, `${config?.teamId ?? ''}/${config?.agentId ?? ''}/${config?.userId ?? ''}`),
          h('div', { key: 'sp', style: { flex: 1 } }),
          h('button', {
            key: 'auto',
            onClick: () => setAutoRefresh(!autoRefresh),
            title: autoRefresh ? `自动刷新中 · 最近一次 ${lastTickAt ? when(lastTickAt) : '—'} · 点击暂停` : '已暂停 · 点击恢复自动刷新',
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '1px 7px', borderRadius: 999, cursor: 'pointer',
              border: `1px solid ${autoRefresh ? tint(T.ok, 40) : T.line}`,
              background: autoRefresh ? tint(T.ok, 12) : 'transparent',
              color: autoRefresh ? T.ok : T.muted,
              fontSize: 11, lineHeight: '16px',
            },
          }, `${autoRefresh ? '●' : '○'} ${autoRefresh ? '自动刷新 30s' : '已暂停刷新'}`),
          h('span', { key: 'd' }, stats.lastCheckAt
            ? `上次检测 ${when(stats.lastCheckAt)}${stats.lastLatencyMs ? ` · ${stats.lastLatencyMs}ms` : ''}`
            : '还没检测过'),
        ]),
      ])

      const seg = () =>
        h('div', {
          style: {
            display: 'inline-flex',
            padding: 3,
            gap: 2,
            background: T.soft,
            border: `1px solid ${T.line}`,
            borderRadius: 9,
          },
        }, [['overview', '概览'], ['browse', '浏览'], ['settings', '设置']].map(([key, text]) => {
          const active = tabName === key
          return h('button', {
            key,
            onClick: () => setTabName(key),
            style: {
              padding: '5px 16px',
              fontSize: 12.5,
              borderRadius: 7,
              border: 'none',
              background: active ? T.card : 'transparent',
              color: active ? T.text : T.muted,
              cursor: 'pointer',
              fontWeight: active ? 600 : 400,
              boxShadow: active ? `0 1px 2px ${tint(T.text, 12)}` : 'none',
            },
          }, text)
        }))

      const stepList = (steps) => Card(steps.map((step, i) => h('div', {
        key: String(i),
        style: {
          display: 'grid',
          gridTemplateColumns: '14px 1fr auto',
          gap: 10,
          alignItems: 'center',
          padding: '9px 16px',
          borderTop: i === 0 ? 'none' : `1px solid ${T.line}`,
        },
      }, [
        h('span', { key: 'i', style: { color: step.ok ? T.ok : T.danger, fontSize: 12 } }, '●'),
        h('div', { key: 'b', style: { minWidth: 0 } }, [
          h('div', { key: 'n', style: { fontSize: 12.5, fontFamily: MONO } }, step.name),
          h('div', { key: 'd', style: { fontSize: 11.5, color: step.ok ? T.muted : T.danger, lineHeight: 1.5, wordBreak: 'break-all' } }, step.detail),
        ]),
        h('span', { key: 't', style: { fontSize: 11.5, color: T.muted, fontFamily: MONO } }, step.latencyMs === null || step.latencyMs === undefined ? '' : `${step.latencyMs}ms`),
      ])))

      const logList = (list, limit) => Card(list.slice(0, limit ?? list.length).map((row, i) => h('div', {
        key: String(i),
        style: {
          display: 'grid',
          gridTemplateColumns: '58px 1fr 64px',
          gap: 10,
          alignItems: 'baseline',
          padding: '7px 16px',
          borderTop: i === 0 ? 'none' : `1px solid ${T.line}`,
          fontSize: 11.5,
        },
      }, [
        h('span', { key: 't', style: { color: T.muted, fontFamily: MONO } }, String(row.ts || '').slice(11, 19)),
        h('span', {
          key: 'a',
          style: { color: row.status === 'fail' ? T.danger : T.text, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, `${row.action}${row.count !== undefined ? ` ×${row.count}` : ''}${row.err ? ` · ${String(row.err).slice(0, 70)}` : ''}`),
        h('span', { key: 'm', style: { color: T.muted, textAlign: 'right', fontFamily: MONO } }, row.ms === null || row.ms === undefined ? '' : `${row.ms}ms`),
      ])))

      /* ── 概览 ── */
      const overviewTab = () => {
        const counts = overview?.counts ?? {}
        const num = (v) => (v === null || v === undefined ? '—' : v)
        const proxyOk = proxy?.ok === true
        const out = []

        out.push(h('div', { key: 'stats', style: { display: 'flex', gap: 12, marginBottom: 22, flexWrap: 'wrap' } }, [
          Stat(num(counts.atoms), 'L1 原子事实', '召回的主力', 'a'),
          Stat(num(counts.scenes), 'L2 场景块', '按主题聚合', 'b'),
          Stat(num(overview?.personaChars), 'L3 画像字数', 'persona.md', 'c'),
        ]))

        out.push(Section('服务', h('div', { key: 'r', style: { display: 'flex', gap: 6 } }, [
          Btn('诊断', () => { void post({ action: 'diagnose' }, 'diagnose').then((b) => setDiag(b?.steps ?? null)) }, { small: true, disabled: busy !== '' }),
          Btn('刷新', () => { void refreshOverview(); void loadProxy() }, { small: true, disabled: busy !== '' }),
        ]), Card([
          h('div', { key: 'gw', style: { display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${T.line}` } }, [
            h('div', { key: 'l', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, [
              Dot(overview === null ? 'muted' : overview.health === 'ok' ? 'ok' : 'warn'),
              h('span', { key: 'n', style: { fontSize: 12.5, fontWeight: 500, flex: '0 0 auto' } }, '记忆网关'),
              h('span', { key: 's', style: { fontSize: 11.5, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                overview === null
                  ? '读取中…'
                  : `${overview.health} · v${overview.version || '?'}${overview.uptime ? ` · 已跑 ${Math.round(overview.uptime / 3600)}h` : ''}`),
            ]),
            h('div', { key: 'r', style: { fontSize: 11.5, color: T.muted, fontFamily: MONO } },
              overview?.stores
                ? `${overview.stores.vectorStore ? 'vec' : '-'}/${overview.stores.embeddingService ? 'emb' : '-'}/${overview.stores.ftsAvailable ? 'fts' : '-'}`
                : ''),
          ]),
          h('div', { key: 'px', style: { display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 10, padding: '12px 16px' } }, [
            h('div', { key: 'l', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, [
              Dot(proxy === null ? 'muted' : proxyOk ? 'ok' : 'bad'),
              h('span', { key: 'n', style: { fontSize: 12.5, fontWeight: 500, flex: '0 0 auto' } }, '记忆代理'),
              h('span', { key: 's', style: { fontSize: 11.5, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                proxy === null ? '读取中…' : proxyOk ? `${proxy.status} · ${proxy.upstream || '—'}` : (proxy.error || proxy.message || '不可用')),
            ]),
            h('div', { key: 'r', style: { display: 'flex', gap: 6 } }, [
              Btn('复制地址', () => {
                const url = config?.proxyUrl ?? ''
                if (url === '') return
                try { void navigator.clipboard.writeText(url); setToast(`已复制代理地址：${url}——粘到「模型供应商 → 自定义 base_url」即可让会话请求走代理`) } catch { setToast(`代理地址：${url}`) }
              }, { small: true }),
              Btn(busy === 'proxy-toggle' ? '…' : '暂停', () => { void toggleProxy(false) }, { small: true, danger: true, disabled: busy !== '' }),
              Btn(busy === 'proxy-toggle' ? '…' : '恢复', () => { void toggleProxy(true) }, { small: true, disabled: busy !== '' }),
            ]),
          ]),
        ], 'svc', { overflow: 'hidden' })))

        out.push(Section('画像摘要', Btn('查看全文', () => { setTabName('browse'); setLayer('persona') }, { small: true }),
          overview?.personaHead ? Card([h('div', { key: 'p', style: { padding: '14px 16px' } }, Prose(overview.personaHead, 108))], 'persona')
            : empty('还没有画像（画像由场景归纳而来，记忆攒够阈值才生成）')))

        out.push(Section('快查', null, Card([
          h('div', { key: 'q', style: { padding: 12, display: 'flex', gap: 8 } }, [
            Input({
              key: 'search',
              value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: '搜一条记忆…',
              onKeyDown: (e) => { if (e.key === 'Enter' && query.trim() !== '') { setTabName('browse'); setLayer('atoms'); void post({ action: 'browse', mode: 'atoms', query, limit: 20 }, 'atoms').then((b) => { if (b) setRows(b) }) } },
              style: { flex: 1 },
            }),
            Btn('搜索', () => { if (query.trim() !== '') { setTabName('browse'); setLayer('atoms'); void post({ action: 'browse', mode: 'atoms', query, limit: 20 }, 'atoms').then((b) => { if (b) setRows(b) }) } }, { primary: true, disabled: query.trim() === '' }),
          ]),
        ], 'quicksearch')))

        out.push(Section('会话同步', h('div', { key: 'r', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } }, [
          Btn('刷新', loadSessions, { small: true, disabled: busy !== '' }),
          Btn(sessions?.sync?.running ? '后台同步中…' : '同步 3 个', () => { void syncSessions(3) }, { small: true, primary: true, disabled: sessions?.sync?.running === true }),
          Btn('同步 20 个', () => { void syncSessions(20) }, { small: true, disabled: sessions?.sync?.running === true }),
        ]), sessions === null
          ? empty('点「刷新」统计本地会话')
          : Card([
              h('div', { key: 'kw', style: { display: 'flex', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${T.line}` } }, [
                Input({
                  key: 'kwi',
                  value: keywordText,
                  onChange: (e) => setKeywordText(e.target.value),
                  placeholder: '按主题同步：亚马逊 运营,SIF,拼多多,试用期',
                  onKeyDown: (e) => { if (e.key === 'Enter') void syncSessions(50) },
                  style: { flex: 1, maxWidth: 420 },
                }),
                Btn(sessions?.sync?.running ? '…' : '按主题同步', () => { void syncSessions(50) }, { primary: true, disabled: sessions?.sync?.running === true }),
              ]),
              h('div', { key: 'nums', style: { display: 'flex', gap: 18, flexWrap: 'wrap', padding: '12px 16px', borderBottom: `1px solid ${T.line}` } },
                [['总计', sessions.total, T.text], ['已同步', sessions.synced, T.ok], ['未同步', sessions.unsynced, T.text], ['失败', sessions.failed, T.danger]]
                  .map(([label, value, color], index) => h('div', { key: String(index), style: { minWidth: 60 } }, [
                    h('div', { key: 'v', style: { fontSize: 20, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' } }, String(value ?? 0)),
                    h('div', { key: 'l', style: { fontSize: 11.5, color: T.muted } }, label),
                  ]))),
              h('div', { key: 'times', style: { padding: '8px 16px', fontSize: 11.5, color: T.muted, borderBottom: `1px solid ${T.line}`, lineHeight: 1.7 } }, [
                h('div', { key: 'last' }, `最后同步成功：${sessions.lastSyncedAt ? when(sessions.lastSyncedAt) : '还没有同步过'}`),
                sessions?.sync?.finishedAt ? h('div', { key: 'fin' }, `上一轮结束：${when(sessions.sync.finishedAt)}（成功 ${sessions.sync.ok} · 失败 ${sessions.sync.failed}）`) : null,
                sessions?.sync?.lastError ? h('div', { key: 'err', style: { color: T.danger } }, `最近错误：${String(sessions.sync.lastError).slice(0, 90)}`) : null,
                Array.isArray(sessions.keywords) && sessions.keywords.length > 0
                  ? h('div', { key: 'kwl' }, `当前筛选：${sessions.keywords.join('、')}`)
                  : null,
              ]),
              sessions?.sync?.running
                ? h('div', { key: 'prog', style: { padding: '8px 16px', fontSize: 11.5, color: T.accent, borderBottom: `1px solid ${T.line}` } },
                    `后台同步中：${sessions.sync.done}/${sessions.sync.total}（成功 ${sessions.sync.ok} · 失败 ${sessions.sync.failed}）${sessions.sync.current ? ` · 正在传「${sessions.sync.current}」` : ''}`)
                : null,
              Array.isArray(sessions.recent) && sessions.recent.length > 0
                ? h('div', { key: 'list' }, sessions.recent.slice(0, 5).map((item, index) => h('div', {
                    key: String(index),
                    style: { display: 'grid', gridTemplateColumns: '52px 1fr auto', gap: 10, alignItems: 'baseline', padding: '7px 16px', borderTop: index === 0 ? 'none' : `1px solid ${T.line}`, fontSize: 11.5 },
                  }, [
                    h('span', { key: 's', style: { color: item.state === 'synced' ? T.ok : item.state === 'failed' ? T.danger : T.muted } }, item.state === 'synced' ? '已同步' : item.state === 'failed' ? '失败' : '待同步'),
                    h('div', { key: 'i', style: { minWidth: 0 } }, [
                      h('div', { key: 'n', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text } },
                        item.title || `（无标题会话 ${item.id.slice(0, 8)}）`),
                      h('div', { key: 'm', style: { color: T.muted, fontFamily: MONO, fontSize: 11, marginTop: 2 } },
                        `${item.id.slice(0, 8)} · ${item.mb}MB${item.msgs ? ` · ${item.msgs} 条` : ''}`),
                    ]),
                    h('span', { key: 't', style: { color: T.muted, fontFamily: MONO } }, item.at ? when(item.at) : ''),
                  ])))
                : null,
            ], 'sess', { overflow: 'hidden' })))

        out.push(Section('活动', Btn('刷新', loadLogs, { small: true, disabled: busy !== '' }),
          logs === null ? empty('还没有读取') : logs.length === 0 ? empty('还没有日志') : logList(logs, 8)))

        if (Array.isArray(overview?.scenesHead) && overview.scenesHead.length > 0) {
          out.push(Section('最近场景', Btn('全部', () => { setTabName('browse'); setLayer('scenes') }, { small: true }), Card(
            overview.scenesHead.map((s, i) => h('div', {
              key: String(i),
              style: { padding: '10px 16px', borderTop: i === 0 ? 'none' : `1px solid ${T.line}` },
            }, [
              h('div', { key: 'p', style: { fontSize: 12.5, fontWeight: 500 } }, s.path),
              s.summary ? h('div', { key: 's', style: { fontSize: 11.5, color: T.muted, marginTop: 3, lineHeight: 1.55 } }, s.summary) : null,
            ])),
            'scenes', { overflow: 'hidden' })))
        }

        if (diag !== null) out.push(Section('诊断', Btn('收起', () => setDiag(null), { small: true }), stepList(diag)))
        return out
      }

      /* ── 浏览 ── */
      const browseTab = () => {
        const layerBtn = (key, text) => {
          const active = layer === key
          return h('button', {
            key,
            onClick: () => { setLayer(key); setRows(null) },
            style: {
              padding: '5px 12px',
              fontSize: 12.5,
              borderRadius: 7,
              border: `1px solid ${active ? T.accent : 'transparent'}`,
              background: active ? tint(T.accent, 14) : 'transparent',
              color: active ? T.text : T.muted,
              cursor: 'pointer',
              fontWeight: active ? 600 : 400,
            },
          }, text)
        }

        const layerHint = {
          persona: '用户画像：由场景归纳出来的稳定偏好与目标，最便宜的一层。',
          scenes: '场景块：按主题聚合的 markdown，含背景与关键决定。',
          atoms: '原子事实：一条条可召回的结构化结论，带所属场景与相似度。',
          conversations: '原始对话：核对原话时才下来查，最贵的一层。',
        }[layer]

        const out = [h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 } }, [
          layerBtn('persona', 'L3 画像'),
          layerBtn('scenes', 'L2 场景'),
          layerBtn('atoms', 'L1 原子'),
          layerBtn('conversations', 'L0 对话'),
          h('div', { key: 'sp', style: { flex: 1 } }),
          layer === 'persona' ? Btn('刷新', loadPersona, { small: true, disabled: busy !== '' }) : null,
          layer === 'scenes' ? Btn('刷新', loadScenes, { small: true, disabled: busy !== '' }) : null,
        ]), h('div', { key: 'hint', style: { fontSize: 11.5, color: T.muted, marginBottom: 14, lineHeight: 1.6 } }, layerHint)]

        if (layer === 'persona') {
          out.push(persona === null
            ? empty('读取中…')
            : persona.ok === false
              ? empty(persona.error)
              : Card([h('div', { key: 'p', style: { padding: '14px 16px' } }, Prose(persona.content === '' ? '（空画像：新库，或还没攒够记忆）' : persona.content, 460))], 'persona'))
        }

        if (layer === 'scenes') {
          if (scenes === null) out.push(empty('读取中…'))
          else if (scenes.ok === false) out.push(empty(scenes.error))
          else if ((scenes.entries ?? []).length === 0) out.push(empty('没有场景块'))
          else {
            out.push(h('div', { key: 'split', style: { display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' } }, [
              Card((scenes.entries ?? []).map((entry, i) => {
                const active = scene?.path === entry.path
                return h('div', {
                  key: String(i),
                  onClick: () => { void openScene(entry.path) },
                  style: {
                    padding: '10px 14px',
                    borderTop: i === 0 ? 'none' : `1px solid ${T.line}`,
                    cursor: 'pointer',
                    background: active ? tint(T.accent, 12) : 'transparent',
                    borderLeft: `2px solid ${active ? T.accent : 'transparent'}`,
                  },
                }, [
                  h('div', { key: 'p', style: { fontSize: 12.5, fontWeight: active ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.path),
                  entry.summary ? h('div', { key: 's', style: { fontSize: 11.5, color: T.muted, marginTop: 3, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, entry.summary) : null,
                ])
              }), 'list', { overflow: 'hidden', flex: '0 1 260px', minWidth: 220 }),
              Card([h('div', { key: 'c', style: { padding: 12 } }, [
                h('div', { key: 't', style: { fontSize: 11.5, color: T.muted, marginBottom: 8, fontFamily: MONO } }, scene?.path ?? '选一个场景'),
                scene === null ? null : scene.ok === false
                  ? h('div', { key: 'e', style: { color: T.danger, fontSize: 12.5 } }, scene.error)
                  : Prose(scene.content === '' ? '（空）' : scene.content, 420),
              ])], 'detail', { flex: '1 1 320px', minWidth: 260 }),
            ]))
          }
        }

        if (layer === 'atoms' || layer === 'conversations') {
          const isAtoms = layer === 'atoms'
          const mode = isAtoms ? 'atoms' : 'conversations'
          out.push(h('div', { key: 'search', style: { display: 'flex', gap: 8, marginBottom: 12 } }, [
            Input({
              key: 'q',
              value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: isAtoms ? '搜事实，例如：隧道 / 向日葵 / 面板' : '搜原话，例如：部署 / 结论',
              onKeyDown: (e) => { if (e.key === 'Enter' && query.trim() !== '') void searchLayer(mode) },
              style: { maxWidth: 420 },
            }),
            Btn(busy === mode ? '搜索中…' : '搜索', () => { void searchLayer(mode) }, { primary: true, disabled: busy !== '' || query.trim() === '' }),
          ]))
          if (rows === null) out.push(empty('输入关键词后回车'))
          else if (rows.ok === false) out.push(empty(rows.error))
          else if ((rows.items ?? []).length === 0) out.push(empty('没有命中'))
          else {
            out.push(Card((rows.items ?? []).map((item, i) => h('div', {
              key: String(i),
              style: { padding: '11px 16px', borderTop: i === 0 ? 'none' : `1px solid ${T.line}` },
            }, [
              h('div', { key: 'c', style: { fontSize: 12.5, lineHeight: 1.6 } }, item.content),
              h('div', { key: 'm', style: { display: 'flex', gap: 8, marginTop: 4, fontSize: 11, color: T.muted, fontFamily: MONO } }, [
                item.role ? h('span', { key: 'r' }, `[${item.role}]`) : null,
                item.scene ? h('span', { key: 's' }, item.scene) : null,
                item.score === null || item.score === undefined ? null : h('span', { key: 'sc' }, `score ${Number(item.score).toFixed(3)}`),
                item.at ? h('span', { key: 't' }, String(item.at).slice(0, 16)) : null,
              ].filter(Boolean)),
            ])), 'rows', { overflow: 'hidden' }))
          }
        }
        return out
      }

      /* ── 设置 ── */
      const toggleRow = (title, hint, key, checked, onChange) =>
        h('label', {
          key,
          style: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 0', cursor: 'pointer' },
        }, [
          h('input', { key: 'i', type: 'checkbox', checked, onChange, style: { marginTop: 2, accentColor: T.accent } }),
          h('div', { key: 't' }, [
            h('div', { key: 'a', style: { fontSize: 12.5 } }, title),
            h('div', { key: 'b', style: { fontSize: 11.5, color: T.muted, marginTop: 2 } }, hint),
          ]),
        ])

      const settingsTab = () => {
        const out = []

        out.push(Section('连接', null, Card([h('div', { key: 'b', style: { padding: 16 } }, [
          Field('入口地址', '把「https://…/relay/rl-xxxx」和「X-Relay-Key: rk_…」整段粘进来会自动拆分', {
            value: config?.baseUrl ?? '', onChange: set('baseUrl'), onPaste, placeholder: 'http://…/relay/rl-xxxx',
          }),
          h('div', { key: 'p', style: { display: 'flex', gap: 8, marginTop: -6, marginBottom: 14 } }, [
            Btn('填本机直连', () => setForm({ ...(config ?? {}), baseUrl: 'http://127.0.0.1:8420', relayKey: '' }), { small: true }),
            Btn('填隧道默认', () => setForm({ ...(config ?? {}), baseUrl: 'http://47.251.253.188:8080/relay/rl-b3edb436' }), { small: true }),
          ]),
          Field('Relay Key', '留空 = 保持原值不变', {
            value: config?.relayKey ?? '', onChange: set('relayKey'),
            placeholder: config?.relayKeySet ? `已设置 ${config.relayKeyMask}` : 'rk_...（直连可留空）',
          }),
          Field('Bearer 令牌', '网关开了 TDAI_GATEWAY_API_KEY 才需要；留空 = 保持原值', {
            value: config?.bearer ?? '', onChange: set('bearer'),
            placeholder: config?.bearerSet ? `已设置 ${config.bearerMask}` : '通常留空',
          }),
        ])], 'conn')))

        out.push(Section('记忆代理', null, Card([h('div', { key: 'b', style: { padding: 16 } }, [
          Field('代理入口', 'LLM 转发服务的 relay 地址', { value: config?.proxyUrl ?? '', onChange: set('proxyUrl'), placeholder: 'http://…/relay/rl-xxxx' }),
          Field('代理 Relay Key', '留空 = 保持原值；它同时是这条 relay 规则的 access_key', {
            value: config?.proxyKey ?? '', onChange: set('proxyKey'),
            placeholder: config?.proxyKeySet ? `已设置 ${config.proxyKeyMask}` : 'rk_...',
          }),
          h('div', { key: 'row', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 } }, [
            h('div', { key: 'a' }, Field('面板地址', null, { value: config?.panelUrl ?? '', onChange: set('panelUrl') })),
            h('div', { key: 'b' }, Field('面板 api_key', '开关代理需要；留空 = 保持原值', {
              value: config?.panelKey ?? '', onChange: set('panelKey'),
              placeholder: config?.panelKeySet ? `已设置 ${config.panelKeyMask}` : '面板 config.json 里的 api_key',
            })),
          ]),
        ])], 'proxy')))

        out.push(Section('行为', null, Card([h('div', { key: 'b', style: { padding: '16px 16px 6px' } }, [
          toggleRow('每轮自动召回', '把相关旧事实注入系统提示词（省 token 的关键）', 'autoInject', config?.autoInject === true, set('autoInject')),
          toggleRow('每轮自动写回 L0', '捕获对话，L1 提炼交给网关', 'autoCapture', config?.autoCapture === true, set('autoCapture')),
          toggleRow('自动同步会话', `每 ${config?.autoSyncIntervalMin ?? 10} 分钟把未同步的会话补传到远端（后台跑，不阻塞对话）`, 'autoSyncSessions', config?.autoSyncSessions !== false, set('autoSyncSessions')),
          h('div', { key: 'quick', style: { marginTop: 10, paddingTop: 12, borderTop: `1px solid ${T.line}` } }, [
            h('div', { key: 't', style: { fontSize: 12, color: T.muted, marginBottom: 8 } }, '想省事的直接点'),
            Btn(busy === 'quick-setup' ? '配置中…' : '一键配置（推荐）', () => { void post({ action: 'quick-setup' }, 'quick-setup') }, { primary: true, disabled: busy !== '' }),
            h('div', { key: 'h', style: { fontSize: 11.5, color: T.muted, marginTop: 6, lineHeight: 1.55 } }, '开启：启用记忆 + 每轮自动召回 + 每轮自动写回'),
          ]),
          toggleRow('日志脱敏', '只记长度不记正文', 'logRedact', config?.logRedact !== false, set('logRedact')),
          h('div', { key: 'capture', style: { marginTop: 8, paddingTop: 10, borderTop: `1px solid ${T.line}`, fontSize: 11.5, color: T.muted, lineHeight: 1.7 } }, [
            h('div', { key: 't', style: { fontWeight: 500, color: T.text, marginBottom: 2 } }, '自动捕获自检'),
            h('div', { key: 'l1' }, `监听器：pre-step ${stats.capture?.registered?.preStep ?? 0} · turn-stopping ${stats.capture?.registered?.turnStopping ?? 0}`),
            h('div', { key: 'l2', color: stats.capture?.lastFlushResult?.startsWith('写入成功') ? T.ok : T.muted }, `最近：${stats.capture?.lastFlushResult ?? '尚未触发'}`),
            h('div', { key: 'l3' }, `成功 ${stats.capture?.writes ?? 0} 次 · 跳过 ${stats.capture?.skips ?? 0} 次`),
            h('div', { key: 'l4' }, `助手文字帧 ${stats.capture?.textChunks ?? 0} 个 · 召回命中 ${stats.recallQuality?.hit ?? 0} / 空 ${stats.recallQuality?.empty ?? 0}`),
            (config?.autoCapture === true && (stats.capture?.writes ?? 0) === 0)
              ? h('div', { key: 'tip', style: { color: T.warn, marginTop: 4 } }, '已开启但还没写过：本轮结束后会补写（turn-stopping 或下一轮 pre-step 兜底）')
              : null,
          ]),
          h('div', { key: 'adv', style: { marginTop: 6, borderTop: `1px solid ${T.line}`, paddingTop: 12 } }, [
            h('div', {
              key: 'h', onClick: () => setAdvanced(!advanced),
              style: { cursor: 'pointer', fontSize: 12.5, color: T.muted, marginBottom: advanced ? 12 : 0 },
            }, `${advanced ? '▾' : '▸'} 高级：方言 / 命名空间 / 超时`),
            advanced ? h('div', { key: 'body' }, [
              h('div', { key: 'r1', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 } }, [
                h('div', { key: 'a' }, Label('方言'), Select({ value: config?.dialect ?? 'auto', onChange: set('dialect') }, [
                  h('option', { key: 'auto', value: 'auto' }, 'auto（先 v3 再 v1）'),
                  h('option', { key: 'v3', value: 'v3' }, 'v3（部署版 MemoryCore）'),
                  h('option', { key: 'v1', value: 'v1' }, 'v1（开源 gateway）'),
                ])),
                h('div', { key: 'b' }, Field('serviceId', null, { value: config?.serviceId ?? '', onChange: set('serviceId') })),
              ]),
              h('div', { key: 'ids', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 } }, [
                h('div', { key: 'a' }, Field('teamId', null, { value: config?.teamId ?? '', onChange: set('teamId') })),
                h('div', { key: 'b' }, Field('agentId', null, { value: config?.agentId ?? '', onChange: set('agentId') })),
                h('div', { key: 'c' }, Field('userId', null, { value: config?.userId ?? '', onChange: set('userId') })),
                h('div', { key: 'd' }, Field('taskId', '可空', { value: config?.taskId ?? '', onChange: set('taskId') })),
              ]),
              h('div', { key: 'nums', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 } }, [
                h('div', { key: 'a' }, Field('超时(ms)', null, { value: config?.timeoutMs ?? '', onChange: set('timeoutMs'), type: 'number' })),
                h('div', { key: 'b' }, Field('召回条数', null, { value: config?.maxAtoms ?? '', onChange: set('maxAtoms'), type: 'number' })),
                h('div', { key: 'c' }, Field('会话键', null, { value: config?.sessionKey ?? '', onChange: set('sessionKey') })),
              ]),
            ]) : null,
          ]),
        ])], 'behave')))

        out.push(Section('操作', null, h('div', { key: 'ops', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          Btn(busy === 'quick-setup' ? '配置中…' : '一键配置（推荐）', () => { void post({ action: 'quick-setup' }, 'quick-setup') }, { primary: true, disabled: busy !== '' }),
          Btn(busy === 'save' ? '保存中…' : '保存配置', () => { void post({ action: 'save', config: config ?? {} }, 'save') }, { disabled: busy !== '' || config === null }),
          Btn('恢复默认', () => { void post({ action: 'reset' }, 'reset') }, { disabled: busy !== '' }),
          h('div', { key: 'sp', style: { flex: 1 } }),
          config?.enabled === false
            ? Btn('启用记忆', () => { void post({ action: 'enable' }, 'enable') }, { disabled: busy !== '' })
            : Btn('停用记忆', () => { void post({ action: 'disable' }, 'disable') }, { danger: true, disabled: busy !== '' }),
        ])))

        if (diag !== null) out.push(Section('诊断', Btn('收起', () => setDiag(null), { small: true }), stepList(diag)))
        return out
      }

      const view = tabName === 'overview' ? overviewTab() : tabName === 'browse' ? browseTab() : settingsTab()

      // 面板自己负责滚动：外层撑满 + 内层 overflowY。宿主给 main 槽的是固定高度的容器，
      // 只写 minHeight 会让内容溢出被裁掉（表现为「展示不全 + 不能滚」）。
      return h('div', {
        'data-mb': 'true',
        style: {
          height: '100%',
          maxHeight: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: T.bg,
          color: T.text,
          fontSize: 13,
        },
      }, [
        header,
        h('div', {
          key: 'scroll',
          style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden' },
        }, [
          h('div', { key: 'tabs', style: { padding: '14px clamp(12px, 3vw, 24px) 0' } }, seg()),
          h('div', { key: 'content', style: { padding: '18px clamp(12px, 3vw, 24px) 32px' } }, [
            error !== ''
              ? h('div', {
                  key: 'err',
                  style: { padding: '10px 12px', marginBottom: 14, borderRadius: 8, background: tint(T.danger, 12), border: `1px solid ${tint(T.danger, 40)}`, color: T.danger, fontSize: 12.5 },
                }, `读取失败：${error}`)
              : null,
            ...view,
          ]),
          toast !== ''
            ? h('div', {
                key: 'toast',
                style: {
                  margin: '0 clamp(12px, 3vw, 24px) 16px', padding: '9px 12px',
                  borderRadius: 8, background: T.soft, border: `1px solid ${T.line}`, fontSize: 12, color: T.text,
                },
              }, toast)
            : null,
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'memory-bridge', order: 44, label: '记忆服务' },
            SidebarEntry,
          ),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'memory-bridge' }, Panel))
      },
    }
  },
})

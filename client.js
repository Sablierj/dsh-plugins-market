// dsh-web-search-searxng — 设置页面板（浏览器侧）。
// 后端可以是「便携运行时 / Docker / 外部实例」，面板只认 backendStatus 的统一形状。
window.__ModuleLoader__.load({
  id: '@local/dsh-web-search-searxng',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const css = `
      .sxq { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary); }
      .sxq-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; }
      .sxq-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
      .sxq-title { font-size: 13px; font-weight: 600; }
      .sxq-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .sxq-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; }
      .sxq-field { display: flex; flex-direction: column; gap: 4px; }
      .sxq-input, .sxq-select { width: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-base); color: inherit;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 5px 8px; font-size: 12px; font-family: inherit; }
      .sxq-input:focus, .sxq-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .sxq-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .sxq-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
      .sxq-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
      .sxq-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .sxq-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
      .sxq-btn-danger { color: var(--dsw-alias-state-error-primary); }
      .sxq-badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 10px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1); }
      .sxq-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
      .sxq-ok { color: var(--dsw-alias-state-success-primary); }
      .sxq-warn { color: var(--dsw-alias-state-warn-primary); }
      .sxq-err { color: var(--dsw-alias-state-error-primary); }
      .sxq-idle { color: var(--dsw-alias-state-idle-primary); }
      .sxq-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
      .sxq-logs { margin: 10px 0 0; max-height: 220px; overflow: auto; background: var(--dsw-alias-bg-base); border-radius: 8px;
        padding: 10px; border: 1px solid var(--dsw-alias-border-l1); white-space: pre-wrap; word-break: break-all; }
      .sxq-steps { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
      .sxq-step { display: flex; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .sxq-notice { border-radius: 8px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); font-size: 12px; margin-top: 10px; }
      .sxq-radio { display: flex; flex-wrap: wrap; gap: 12px; }
      .sxq-radio label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    `

    async function api(path, init) {
      const response = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...init })
      try {
        return await response.json()
      } catch {
        return { ok: false, error: `HTTP ${response.status}` }
      }
    }

    function badge(tone, text) {
      return h('span', { className: `sxq-badge ${tone}` }, h('span', { className: 'sxq-dot' }), text)
    }

    const BACKENDS = [
      { value: 'auto', label: '自动（便携优先）' },
      { value: 'portable', label: '便携运行时' },
      { value: 'docker', label: 'Docker 容器' },
      { value: 'external', label: '外部实例' },
    ]

    function toDraft(settings) {
      const s = settings || {}
      return {
        backend: s.backend || 'auto',
        port: String(s.service?.port ?? 8080),
        engines: s.engines && s.engines !== '(searxng default)' ? s.engines : '',
        language: s.language || 'zh-CN',
        categories: s.categories || 'general',
        safesearch: String(s.safesearch ?? 1),
        maxResults: String(s.maxResults ?? 8),
        cacheTtlMs: String(Math.round((s.cacheTtlMs ?? 60000) / 1000)),
        autoStart: s.service?.autoStart !== false,
        proxyEnabled: s.proxy?.enabled === true,
        proxyUrl: s.proxy?.url || 'http://127.0.0.1:7890',
        proxyMode: s.proxy?.mode || 'auto',
        engineProxy: s.service?.engineProxy === true,
        baseUrl: s.baseUrl || 'http://127.0.0.1:8080',
        offlinePath: '',
      }
    }

    function Panel() {
      const [snap, setSnap] = useState(null)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [logs, setLogs] = useState(null)

      const load = useCallback(async () => {
        const value = await api('/dsh-searxng/status')
        if (value.ok) {
          setSnap(value)
          setDraft((prev) => prev || toDraft(value.settings))
        } else setNotice({ tone: 'sxq-err', text: value.error || '读取状态失败' })
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const jobRunning = snap?.job?.running === true
      useEffect(() => {
        if (!jobRunning) return undefined
        const timer = setInterval(load, 2000)
        return () => clearInterval(timer)
      }, [jobRunning, load])

      const act = async (action, extra) => {
        setBusy(action)
        setNotice(null)
        const value = await api('/dsh-searxng/action', { method: 'POST', body: JSON.stringify({ action, ...(extra || {}) }) })
        setBusy('')
        if (!value.ok) setNotice({ tone: 'sxq-err', text: value.error || '操作失败' })
        else if (value.result?.started) setNotice({ tone: 'sxq-idle', text: '已开始（安装可能要 1–3 分钟），进度会自动刷新' })
        else if (value.result?.ok === false) setNotice({ tone: 'sxq-err', text: value.result.error || '操作失败' })
        else setNotice({ tone: 'sxq-ok', text: '完成' })
        load()
      }

      const showLogs = async () => {
        setBusy('logs')
        const value = await api('/dsh-searxng/logs?lines=60')
        setBusy('')
        setLogs(value.lines?.length ? value.lines : [value.error || '没有日志'])
      }

      const save = async () => {
        setBusy('save')
        setNotice(null)
        const patch = {
          backend: draft.backend,
          baseUrl: draft.baseUrl.trim(),
          service: { port: Number(draft.port) || 8080, autoStart: draft.autoStart, engineProxy: draft.engineProxy },
          engines: draft.engines.trim(),
          language: draft.language.trim(),
          categories: draft.categories.trim(),
          safesearch: Number(draft.safesearch),
          maxResults: Number(draft.maxResults),
          cacheTtlMs: Number(draft.cacheTtlMs) * 1000,
          proxy: { enabled: draft.proxyEnabled, url: draft.proxyUrl.trim(), mode: draft.proxyMode },
        }
        const value = await api('/dsh-searxng/config', { method: 'POST', body: JSON.stringify({ patch }) })
        setBusy('')
        if (value.ok) {
          setNotice({ tone: 'sxq-ok', text: '已保存并即时生效；端口 / 后端改动需要重启对应服务' })
          setSnap((prev) => (prev ? { ...prev, settings: value.settings } : prev))
          load()
        } else setNotice({ tone: 'sxq-err', text: value.error || '保存失败' })
      }

      const set = (key, value) => setDraft({ ...draft, [key]: value })

      if (!snap) return h('div', { className: 'sxq' }, h('style', null, css), h('div', { className: 'sxq-card' }, '正在读取状态…'))

      const kind = snap.backend?.kind || 'none'
      const portable = snap.portable || {}
      const docker = snap.docker || null
      const container = docker?.container || {}
      const backendRunning = snap.running === true
      const health = kind === 'portable' ? portable.health : snap.external?.health || null

      let tone = 'sxq-idle'
      let stateText = '未就绪'
      if (kind === 'external') {
        tone = health?.ok ? 'sxq-ok' : 'sxq-warn'
        stateText = health?.ok ? '外部实例可用' : '外部实例待确认'
      } else if (backendRunning) {
        tone = health && health.ok ? 'sxq-ok' : 'sxq-warn'
        stateText = health && health.ok ? '运行中' : '运行中（健康未过）'
      } else if (kind === 'portable' && portable.installed) {
        tone = 'sxq-warn'
        stateText = '已安装未运行'
      } else if (kind === 'docker' && container.exists) {
        tone = 'sxq-warn'
        stateText = '容器已停止'
      } else {
        tone = kind === 'none' ? 'sxq-err' : 'sxq-idle'
        stateText = kind === 'none' ? '没有可用后端' : '未安装'
      }

      const field = (label, inputNode) => h('div', { className: 'sxq-field' }, h('span', { className: 'sxq-sub' }, label), inputNode)
      const input = (key, placeholder) =>
        h('input', { className: 'sxq-input', value: draft[key], placeholder, onChange: (e) => set(key, e.target.value) })

      const stepList = snap.job?.steps?.length
        ? h(
            'div',
            { className: 'sxq-steps' },
            h('div', { className: 'sxq-sub' }, `进行中：${snap.job.name}`),
            snap.job.steps.map((step, index) =>
              h('div', { key: index, className: 'sxq-step' }, h('span', null, step.ok ? '✓' : '✕'), h('span', null, `${step.name}：${step.detail}`)),
            ),
          )
        : null

      return h(
        'div',
        { className: 'sxq' },
        h('style', null, css),

        h(
          'div',
          { className: 'sxq-card' },
          h('div', { className: 'sxq-head' }, h('div', { className: 'sxq-title' }, 'SearXNG 实例'), badge(tone, stateText)),
          h(
            'div',
            { className: 'sxq-grid' },
            h('div', null, h('span', { className: 'sxq-sub' }, '后端 '), kind === 'portable' ? '便携运行时' : kind === 'docker' ? 'Docker 容器' : kind === 'external' ? '外部实例' : '无'),
            h('div', null, h('span', { className: 'sxq-sub' }, '判定 '), snap.backend?.reason || '-'),
            h('div', null, h('span', { className: 'sxq-sub' }, '地址 '), `127.0.0.1:${snap.port}`),
            h(
              'div',
              null,
              h('span', { className: 'sxq-sub' }, 'Python '),
              portable.python?.ok ? `${portable.python.version}（${portable.python.source}）` : '未找到',
            ),
            h(
              'div',
              null,
              h('span', { className: 'sxq-sub' }, '运行时版本 '),
              portable.current?.manifest?.version
                ? `${portable.current.manifest.version} · ${portable.current.manifest.sizeMb} MB`
                : portable.installed
                  ? '已安装'
                  : '未安装',
            ),
            h(
              'div',
              null,
              h('span', { className: 'sxq-sub' }, '健康检查 '),
              health ? (health.ok ? `${health.results} 条 / ${health.tookMs}ms` : health.error || '失败') : '未运行',
            ),
          ),
          stepList,
        ),

        h(
          'div',
          { className: 'sxq-card' },
          h('div', { className: 'sxq-head' }, h('div', { className: 'sxq-title' }, '生命周期'), h('span', { className: 'sxq-sub' }, '与 searxng_service 同一套动作')),
          h(
            'div',
            { className: 'sxq-actions', style: { marginTop: 0 } },
            h('button', { className: 'sxq-btn sxq-btn-primary', disabled: Boolean(busy) || jobRunning, onClick: () => act('deploy') }, busy === 'deploy' ? '安装中…' : '安装 / 部署'),
            h('button', { className: 'sxq-btn', disabled: Boolean(busy) || jobRunning, onClick: () => act('start') }, '启动'),
            h('button', { className: 'sxq-btn', disabled: Boolean(busy) || jobRunning || !backendRunning, onClick: () => act('stop') }, '停止'),
            h('button', { className: 'sxq-btn', disabled: Boolean(busy) || jobRunning, onClick: () => act('restart') }, '重启'),
            h('button', { className: 'sxq-btn', disabled: Boolean(busy), onClick: () => act('health') }, '测活'),
            h('button', { className: 'sxq-btn', disabled: Boolean(busy), onClick: showLogs }, busy === 'logs' ? '读取中…' : '日志'),
            h('button', { className: 'sxq-btn', disabled: Boolean(busy), onClick: load }, '刷新'),
            h('button', { className: 'sxq-btn', disabled: Boolean(busy) || jobRunning, onClick: () => act('export') }, '导出离线包'),
            h('button', { className: 'sxq-btn sxq-btn-danger', disabled: Boolean(busy) || jobRunning, onClick: () => act('uninstall') }, '卸载'),
          ),
          notice ? h('div', { className: `sxq-notice ${notice.tone}` }, notice.text) : null,
          logs ? h('pre', { className: 'sxq-logs sxq-mono' }, logs.join('\n')) : null,
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('input', {
              className: 'sxq-input',
              placeholder: '离线包路径，例如 D:\\searxng-portable-2026.10.20.zip',
              value: draft.offlinePath,
              onChange: (e) => set('offlinePath', e.target.value),
            }),
            h(
              'button',
              {
                className: 'sxq-btn',
                disabled: Boolean(busy) || jobRunning || !String(draft.offlinePath || '').trim(),
                onClick: () => act('import', { file: String(draft.offlinePath).trim() }),
              },
              '从离线包安装',
            ),
          ),
        ),

        h(
          'div',
          { className: 'sxq-card' },
          h('div', { className: 'sxq-head' }, h('div', { className: 'sxq-title' }, '后端与搜索配置'), h('span', { className: 'sxq-sub' }, '保存后即时生效')),
          h(
            'div',
            { className: 'sxq-radio', style: { marginBottom: 10 } },
            BACKENDS.map((option) =>
              h(
                'label',
                { key: option.value },
                h('input', { type: 'radio', name: 'sxq-backend', checked: draft.backend === option.value, onChange: () => set('backend', option.value) }),
                h('span', null, option.label),
              ),
            ),
          ),
          h(
            'div',
            { className: 'sxq-grid' },
            field('实例端口', input('port')),
            field('外部实例地址（选 external 时生效）', input('baseUrl')),
            field('搜索引擎（空=实例默认）', input('engines', 'bing,baidu,duckduckgo')),
            field('语言', input('language')),
            field('分类', input('categories')),
            field(
              '安全搜索',
              h(
                'select',
                { className: 'sxq-select', value: draft.safesearch, onChange: (e) => set('safesearch', e.target.value) },
                h('option', { value: '0' }, '0 关'),
                h('option', { value: '1' }, '1 中'),
                h('option', { value: '2' }, '2 严'),
              ),
            ),
            field('返回条数', input('maxResults')),
            field('缓存（秒，0=不缓存）', input('cacheTtlMs')),
          ),
          h(
            'div',
            { className: 'sxq-actions' },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: draft.autoStart, onChange: (e) => set('autoStart', e.target.checked) }),
              h('span', { className: 'sxq-sub' }, 'DSH 启动时自动拉起已装的实例'),
            ),
          ),
          h('div', { style: { height: 10 } }),
          h('div', { className: 'sxq-title', style: { marginBottom: 8 } }, '代理'),
          h(
            'div',
            { className: 'sxq-grid' },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: draft.proxyEnabled, onChange: (e) => set('proxyEnabled', e.target.checked) }),
              h('span', { className: 'sxq-sub' }, '启用代理（插件自己发请求时）'),
            ),
            field(
              '模式',
              h(
                'select',
                { className: 'sxq-select', value: draft.proxyMode, onChange: (e) => set('proxyMode', e.target.value) },
                h('option', { value: 'auto' }, 'auto：有地址就走'),
                h('option', { value: 'direct' }, 'direct：强制直连'),
                h('option', { value: 'always' }, 'always：只走代理'),
              ),
            ),
            field('代理地址', input('proxyUrl', 'http://127.0.0.1:7890')),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', alignSelf: 'end', paddingBottom: 4 } },
              h('input', { type: 'checkbox', checked: draft.engineProxy, onChange: (e) => set('engineProxy', e.target.checked) }),
              h('span', { className: 'sxq-sub' }, 'Docker 容器内引擎也走代理'),
            ),
          ),
          h(
            'div',
            { className: 'sxq-actions' },
            h('button', { className: 'sxq-btn sxq-btn-primary', disabled: Boolean(busy), onClick: save }, busy === 'save' ? '保存中…' : '保存配置'),
            h('span', { className: 'sxq-sub', style: { alignSelf: 'center' } }, '落盘 ~/.dsh/dsh-web-search-searxng/config.json'),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots') || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () =>
          slots.register({ name: 'settings.section', id: 'searxng-search', order: 32, label: 'SearXNG 搜索' }, Panel),
        )
      },
    }
  },
})

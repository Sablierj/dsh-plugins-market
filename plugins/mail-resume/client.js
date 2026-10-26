/**
 * Client 侧：简历下载面板（左侧栏一个入口 + 中央一页）。
 *
 * 结构：状态条 → 一键下载卡 → 本轮结果 → 已下载台账 → 设置
 * 数据全部来自 Host 的 /mail-resume/api（GET 读、POST 写），面板本身不下任何判断。
 * 只用 React.createElement + 内联样式，主题色走宿主 CSS 变量。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-mail-resume',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API = '/mail-resume/api'

    const C = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    // ------------------------------------------------------------ 基础件

    function chip(text, tone, title) {
      const color = { idle: C.idle, warn: C.warn, brand: C.brand, ok: C.ok, err: C.err }[tone] || C.idle
      return h(
        'span',
        {
          title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 8px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            color,
            border: `1px solid ${color}`,
          },
        },
        text,
      )
    }

    function card(children, extra) {
      return h(
        'div',
        {
          style: {
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            background: C.layer1,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            ...(extra || {}),
          },
        },
        children,
      )
    }

    function sectionTitle(text, right) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, color: C.text } }, text),
        right || null,
      )
    }

    function button(label, onClick, opts) {
      const options = opts || {}
      const disabled = Boolean(options.disabled)
      const primary = Boolean(options.primary)
      return h(
        'button',
        {
          type: 'button',
          disabled,
          onClick,
          title: options.title || '',
          style: {
            padding: '7px 14px',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: primary ? 600 : 500,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            color: primary ? '#fff' : C.text,
            background: primary ? C.brand : C.layer2,
            border: `1px solid ${primary ? C.brand : C.border2}`,
            whiteSpace: 'nowrap',
          },
        },
        label,
      )
    }

    function field(label, content, hint) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('span', { style: { fontSize: 11, color: C.muted } }, label),
        content,
        hint ? h('span', { style: { fontSize: 10, color: C.muted, opacity: 0.85 } }, hint) : null,
      )
    }

    function input(value, onChange, opts) {
      const options = opts || {}
      return h('input', {
        value: value === undefined || value === null ? '' : value,
        type: options.type || 'text',
        placeholder: options.placeholder || '',
        onChange: (event) => onChange(event.target.value),
        style: {
          padding: '6px 8px',
          borderRadius: 7,
          border: `1px solid ${C.border2}`,
          background: C.base,
          color: C.text,
          fontSize: 12,
          minWidth: 0,
          width: '100%',
        },
      })
    }

    function kv(label, value, tone) {
      const color = { idle: C.idle, warn: C.warn, brand: C.brand, ok: C.ok, err: C.err }[tone] || C.text
      return h(
        'div',
        { style: { display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 } },
        h('span', { style: { fontSize: 11, color: C.muted, whiteSpace: 'nowrap' } }, label),
        h(
          'span',
          {
            style: {
              fontSize: 12,
              color,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            title: typeof value === 'string' ? value : '',
          },
          value === undefined || value === null || value === '' ? '—' : String(value),
        ),
      )
    }

    function humanBytes(bytes) {
      const n = Number(bytes || 0)
      if (!n) return '0 B'
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(2)} MB`
    }

    function shortTime(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      const pad = (x) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    const STATUS_TONE = { downloaded: 'ok', no_attachment: 'warn', failed: 'err' }
    const STATUS_TEXT = { downloaded: '已下载', no_attachment: '无附件', failed: '失败' }

    // ------------------------------------------------------------ 侧栏图标

    function SidebarEntry({ size = 20, active = false }) {
      const edge = Number(size) > 0 ? Number(size) : 20
      return h(
        'svg',
        {
          viewBox: '0 0 64 64',
          width: edge,
          height: edge,
          role: 'img',
          'aria-label': '简历下载',
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        h('rect', { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: active ? C.brand : C.muted }),
        h('path', {
          d: 'M13 23h22a3 3 0 0 1 3 3v7M13 23v16a3 3 0 0 0 3 3h11',
          fill: 'none',
          stroke: '#fff',
          'stroke-width': 3.4,
          'stroke-linecap': 'round',
        }),
        h('path', {
          d: 'M14 25l11 8.5L36 25',
          fill: 'none',
          stroke: '#fff',
          'stroke-width': 2.8,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          opacity: 0.9,
        }),
        h('path', {
          d: 'M46 32v15M39.5 41.5L46 48l6.5-6.5',
          fill: 'none',
          stroke: '#fff',
          'stroke-width': 3.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      )
    }

    // ------------------------------------------------------------ 面板

    function Panel() {
      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [report, setReport] = useState(null)
      const [days, setDays] = useState(7)
      const [job, setJob] = useState('')
      const [showSettings, setShowSettings] = useState(false)
      const [draft, setDraft] = useState(null)

      const refresh = useCallback(async () => {
        try {
          const res = await fetch(API, { headers: { accept: 'application/json' } })
          const data = await res.json()
          if (!data.ok) throw new Error(data.error || '读取失败')
          setState(data)
          setDays((prev) => (prev === 7 ? Number(data.settings.days || 7) : prev))
          setJob((prev) => (prev === '' ? String(data.settings.jobFilter || '') : prev))
          setDraft((prev) => prev || { ...data.settings })
          setError('')
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      const post = useCallback(
        async (body, label) => {
          setBusy(label)
          setError('')
          setNotice('')
          try {
            const res = await fetch(API, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            const data = await res.json()
            if (!data.ok) {
              setError([data.error, data.hint].filter(Boolean).join(' — '))
              return null
            }
            return data
          } catch (err) {
            setError(String((err && err.message) || err))
            return null
          } finally {
            setBusy('')
          }
        },
        [],
      )

      const doCheck = useCallback(async () => {
        const data = await post({ action: 'status', deep: true }, 'check')
        if (data) {
          setState((prev) => (prev ? { ...prev, env: data.env, stats: data.stats } : prev))
          setNotice(data.hint || '已刷新')
        }
      }, [post])

      const doScan = useCallback(async () => {
        const data = await post({ action: 'scan', days: Number(days) || 7, job: job || undefined }, 'scan')
        if (data) {
          setReport({ kind: 'scan', ...data })
          setNotice(
            `近 ${data.windowDays} 天命中 ${data.inWindow} 封${job ? `（岗位「${job}」）` : ''}，其中 ${data.pending} 封还没下载`,
          )
        }
      }, [days, job, post])

      const doDownload = useCallback(
        async (dryRun) => {
          const data = await post(
            { action: 'download', days: Number(days) || 7, dryRun, job: job || undefined },
            'download',
          )
          if (data) {
            setReport({ kind: 'download', ...data })
            setNotice(
              dryRun
                ? `预演：待下载 ${data.pending} 封`
                : `完成：下载 ${data.downloaded.length} 封，跳过 ${data.skipped.length} 封，失败 ${data.errors.length} 条`,
            )
            refresh()
          }
        },
        [days, job, post, refresh],
      )

      const doSaveSettings = useCallback(async () => {
        if (!draft) return
        const data = await post({ action: 'config', settings: draft }, 'save')
        if (data) {
          setState((prev) => (prev ? { ...prev, settings: data.settings } : prev))
          setDraft({ ...data.settings })
          setNotice('设置已保存')
        }
      }, [draft, post])

      const doOpen = useCallback(async () => {
        const data = await post({ action: 'open' }, 'open')
        if (data) setNotice(`浏览器已切到邮箱${data.folderOpened ? '，并打开了简历文件夹' : '（文件夹没找到，可能需要改文件夹名）'}`)
      }, [post])

      // 打开下载目录；给 key 就打开那封简历所在的文件夹
      const doOpenDir = useCallback(
        async (key) => {
          const data = await post(key ? { action: 'openDir', key } : { action: 'openDir' }, 'openDir')
          if (data && data.opened) setNotice(`已在资源管理器打开：${data.opened}`)
        },
        [post],
      )

      const env = state && state.env ? state.env : null
      const stats = state && state.stats ? state.stats : null
      const browserOk = env && env.browser && env.browser.ok
      const loggedIn = env ? env.loggedIn : null

      const headerRight = useMemo(
        () =>
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            chip(browserOk ? '浏览器已连接' : '浏览器未连接', browserOk ? 'ok' : 'err', env && env.browser ? env.browser.cdpUrl : ''),
            loggedIn === true ? chip('邮箱已登录', 'ok') : null,
            loggedIn === false ? chip('邮箱未登录', 'warn') : null,
            stats ? chip(`台账 ${stats.mails} 封 / ${stats.files} 个文件`, 'idle') : null,
          ),
        [browserOk, env, loggedIn, stats],
      )

      if (loading) {
        return h('div', { style: { padding: 24, color: C.muted, fontSize: 13 } }, '加载中…')
      }

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflow: 'auto',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            background: C.base,
            color: C.text,
            fontSize: 12,
          },
        },
        // ---- 标题
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('div', { style: { fontSize: 15, fontWeight: 700 } }, '企业邮箱简历下载'),
            h(
              'div',
              { style: { fontSize: 11, color: C.muted } },
              '把 BOSS 直聘发到企业邮箱的简历附件，近 N 天没下载过的一键落到下载目录',
            ),
          ),
          headerRight,
        ),

        // ---- 报错 / 提示
        error
          ? h(
              'div',
              {
                style: {
                  border: `1px solid ${C.err}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  color: C.err,
                  background: 'transparent',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                },
              },
              error,
            )
          : null,
        notice
          ? h('div', { style: { border: `1px solid ${C.border2}`, borderRadius: 8, padding: '8px 10px', color: C.muted } }, notice)
          : null,

        // ---- 状态
        card([
          sectionTitle(
            '环境',
            h(
              'div',
              { style: { display: 'flex', gap: 6 } },
              button(busy === 'check' ? '检查中…' : '重新检查', doCheck, { disabled: Boolean(busy) }),
              button(busy === 'open' ? '打开中…' : '打开邮箱', doOpen, { disabled: Boolean(busy) }),
            ),
          ),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 6 } },
            kv('调试端口', env && env.browser ? env.browser.cdpUrl : '—', browserOk ? 'ok' : 'err'),
            kv('当前页面', env ? env.href || '—' : '—'),
            kv('下载目录', state.settings.downloadDir),
            kv('每轮上限', `${state.settings.maxPerRun} 封`),
            kv('台账文件', state.storeFile),
            env && env.note ? kv('说明', env.note, 'warn') : null,
          ),
        ]),

        // ---- 一键下载
        card([
          sectionTitle(
            '一键下载',
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', { style: { fontSize: 11, color: C.muted } }, '回看天数'),
              h('div', { style: { width: 64 } }, input(days, (v) => setDays(v), { type: 'number' })),
              h('span', { style: { fontSize: 11, color: C.muted, marginLeft: 6 } }, '岗位关键词'),
              h(
                'div',
                { style: { width: 140 } },
                input(job, (v) => setJob(v), { placeholder: '如 测试工程师' }),
              ),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            button(busy === 'download' ? '下载中…' : `一键下载近 ${days || 7} 天未下载简历`, () => doDownload(false), {
              primary: true,
              disabled: Boolean(busy) || loggedIn === false,
              title: loggedIn === false ? '先在那个浏览器窗口登录企业邮箱' : '',
            }),
            button(busy === 'scan' ? '扫描中…' : '先看看有哪些', doScan, { disabled: Boolean(busy) || loggedIn === false }),
            button('预演（不写文件）', () => doDownload(true), { disabled: Boolean(busy) || loggedIn === false }),
            button('打开下载目录', () => doOpenDir(), { disabled: Boolean(busy) }),
          ),
          h(
            'div',
            { style: { fontSize: 11, color: C.muted } },
            '已下载过的邮件不会重复下载；同一封邮件再跑一次只会补没拿到的文件。',
          ),
        ]),

        // ---- 本轮结果
        report ? renderReport(report) : null,

        // ---- 台账
        card([
          sectionTitle(
            '已下载台账',
            h(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              stats ? chip(`${stats.downloaded} 已下载`, 'ok') : null,
              stats ? chip(`${stats.noAttachment} 无附件`, 'warn') : null,
              stats ? chip(humanBytes(stats.bytes), 'idle') : null,
            ),
          ),
          state.ledger && state.ledger.length
            ? h(
                'div',
                { style: { overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 } },
                h(
                  'table',
                  { style: { borderCollapse: 'collapse', width: '100%', fontSize: 11 } },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      ['时间', '候选人', '主题', '状态', '文件', '操作'].map((label) =>
                        h(
                          'th',
                          {
                            key: label,
                            style: {
                              textAlign: 'left',
                              padding: '6px 8px',
                              color: C.muted,
                              fontWeight: 500,
                              borderBottom: `1px solid ${C.border}`,
                              whiteSpace: 'nowrap',
                            },
                          },
                          label,
                        ),
                      ),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    state.ledger.map((row) =>
                      h(
                        'tr',
                        { key: row.key },
                        h('td', { style: { padding: '5px 8px', color: C.muted, whiteSpace: 'nowrap' } }, shortTime(row.at)),
                        h('td', { style: { padding: '5px 8px', whiteSpace: 'nowrap' } }, row.candidate || '—'),
                        h(
                          'td',
                          { style: { padding: '5px 8px', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: row.subject },
                          row.subject || '—',
                        ),
                        h(
                          'td',
                          { style: { padding: '5px 8px' } },
                          chip(STATUS_TEXT[row.status] || row.status || '—', STATUS_TONE[row.status] || 'idle'),
                        ),
                        h(
                          'td',
                          { style: { padding: '5px 8px', color: C.muted, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: (row.files || []).map((f) => f.path).join('\n') },
                          (row.files || []).length
                            ? (row.files || []).map((f) => f.name).join('、')
                            : row.lastError || '—',
                        ),
                        h(
                          'td',
                          { style: { padding: '5px 8px', whiteSpace: 'nowrap' } },
                          (row.files || []).length
                            ? button('打开', () => doOpenDir(row.key), { disabled: Boolean(busy) })
                            : null,
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : h('div', { style: { fontSize: 12, color: C.muted } }, '还没有台账记录。点上面的一键下载开始第一批。'),
        ]),

        // ---- 设置
        card([
          sectionTitle(
            '设置',
            button(showSettings ? '收起' : '展开', () => setShowSettings((v) => !v), { disabled: Boolean(busy) }),
          ),
          showSettings && draft
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 10 } },
                  field('下载目录（默认就是系统下载目录）', input(draft.downloadDir, (v) => setDraft({ ...draft, downloadDir: v }))),
                  field('回看天数', input(draft.days, (v) => setDraft({ ...draft, days: v }), { type: 'number' })),
                  field('收简历的文件夹名', input(draft.folderName, (v) => setDraft({ ...draft, folderName: v })), '左侧树里那个文件夹，例如 boss直聘'),
                  field('发送者/主题过滤词', input(draft.senderFilter, (v) => setDraft({ ...draft, senderFilter: v })), '默认「直聘」'),
                  field(
                    '岗位关键词（按邮件主题过滤）',
                    input(draft.jobFilter, (v) => setDraft({ ...draft, jobFilter: v }), { placeholder: '留空 = 不过滤' }),
                    'BOSS 邮件主题里带岗位名，例如「测试工程师」',
                  ),
                  field('Chrome 调试端口', input(draft.cdpUrl, (v) => setDraft({ ...draft, cdpUrl: v })), '例如 http://127.0.0.1:9333'),
                  field('邮箱地址', input(draft.mailUrl, (v) => setDraft({ ...draft, mailUrl: v }))),
                  field('单轮最多处理封数', input(draft.maxPerRun, (v) => setDraft({ ...draft, maxPerRun: v }), { type: 'number' })),
                  field(
                    '认不出时间的邮件也算待下载',
                    h(
                      'select',
                      {
                        value: draft.includeUndated ? '1' : '0',
                        onChange: (event) => setDraft({ ...draft, includeUndated: event.target.value === '1' }),
                        style: {
                          padding: '6px 8px',
                          borderRadius: 7,
                          border: `1px solid ${C.border2}`,
                          background: C.base,
                          color: C.text,
                          fontSize: 12,
                        },
                      },
                      h('option', { value: '1' }, '是（宁可多下一次）'),
                      h('option', { value: '0' }, '否（只下能确认在时间窗内的）'),
                    ),
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  button(busy === 'save' ? '保存中…' : '保存设置', doSaveSettings, { primary: true, disabled: Boolean(busy) }),
                  button('放弃修改', () => setDraft({ ...state.settings }), { disabled: Boolean(busy) }),
                ),
              )
            : null,
        ]),
      )
    }

    function renderReport(report) {
      const tone = report.errors && report.errors.length ? 'warn' : 'ok'
      return card([
        sectionTitle(
          report.kind === 'scan' ? '扫描结果' : report.dryRun ? '预演结果' : '本轮结果',
          chip(`近 ${report.windowDays} 天`, tone),
        ),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 6 } },
          kv('列表命中', report.scanned),
          report.jobMatched !== undefined && report.jobFilter ? kv('岗位命中', report.jobMatched) : null,
          kv('在时间窗内', report.inWindow),
          kv(report.kind === 'scan' ? '待下载' : '本轮待办', report.pending),
          report.alreadyDownloaded ? kv('已下载过', report.alreadyDownloaded) : null,
          report.downloaded ? kv('下载成功', report.downloaded.length, 'ok') : null,
          report.skipped ? kv('跳过', report.skipped.length, 'warn') : null,
          report.errors ? kv('失败', report.errors.length, report.errors.length ? 'err' : 'idle') : null,
        ),
        report.kind === 'scan'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' } },
              (report.mails || [])
                .filter((mail) => mail.inWindow)
                .map((mail) =>
                  h(
                    'div',
                    { key: mail.key, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11 } },
                    chip(mail.downloaded ? '已下载' : '待下载', mail.downloaded ? 'idle' : 'brand'),
                    h('span', { style: { whiteSpace: 'nowrap', color: C.muted } }, mail.dateText || '时间未知'),
                    h('span', { style: { whiteSpace: 'nowrap' } }, mail.candidate || '—'),
                    h(
                      'span',
                      { style: { color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: mail.subject },
                      mail.subject,
                    ),
                  ),
                ),
            )
          : null,
        report.downloaded && report.downloaded.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' } },
              report.downloaded.map((item) =>
                h(
                  'div',
                  { key: item.key, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11 } },
                  chip('已存', 'ok'),
                  h('span', { style: { whiteSpace: 'nowrap' } }, item.candidate || '—'),
                  h(
                    'span',
                    { style: { color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: (item.files || []).map((f) => f.path).join('\n') },
                    (item.files || []).map((f) => `${f.name}（${humanBytes(f.bytes)}）`).join('、'),
                  ),
                ),
              ),
            )
          : null,
        report.skipped && report.skipped.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: C.muted } },
              report.skipped.slice(0, 8).map((item) =>
                h('div', { key: item.key }, `· ${item.candidate || item.subject || item.key} — ${item.reason}`),
              ),
            )
          : null,
        report.errors && report.errors.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: C.err } },
              report.errors.slice(0, 8).map((item, index) =>
                h('div', { key: `${item.key || index}` }, `· ${item.candidate || item.subject || item.key || ''} — ${item.error}`),
              ),
            )
          : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'mail-resume', order: 45, label: '简历下载' },
            SidebarEntry,
          ),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'mail-resume' }, Panel))
      },
    }
  },
})

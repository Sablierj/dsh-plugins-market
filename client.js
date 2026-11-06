/**
 * Client 侧：拼多多工作台面板（左侧栏入口 + 中央一页）。
 *
 * 两个视图：
 *  - 订单：全部 / 待发货 / 已发货 三个标签，日期区间，按订单时间升序，可导出 Excel/CSV、打开导出目录
 *  - 智能核对：闲鱼订单 ↔ 拼多多订单配对结果，可导入闲鱼 xlsx、跑核对、生成闲鱼批量发货模板
 *
 * 数据全部来自 Host 的 /pdd-workbench/api（GET 读、POST 写）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-pdd-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API = '/pdd-workbench/api'

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
      const small = Boolean(options.small)
      return h(
        'button',
        {
          type: 'button',
          disabled,
          onClick,
          title: options.title || '',
          style: {
            padding: small ? '4px 10px' : '7px 14px',
            borderRadius: 8,
            fontSize: small ? 11 : 12,
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

    function tabButton(label, active, onClick, count) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          style: {
            padding: '6px 14px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: active ? 600 : 500,
            cursor: 'pointer',
            color: active ? '#fff' : C.text,
            background: active ? C.brand : 'transparent',
            border: `1px solid ${active ? C.brand : C.border2}`,
            whiteSpace: 'nowrap',
          },
        },
        count === undefined || count === null ? label : `${label} ${count}`,
      )
    }

    function kv(label, value) {
      return h(
        'div',
        { style: { display: 'flex', gap: 6, fontSize: 11, color: C.muted, minWidth: 0 } },
        h('span', { style: { flex: 'none' } }, label),
        h('span', { style: { color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, value == null || value === '' ? '—' : String(value)),
      )
    }

    function input(value, onChange, opts) {
      const options = opts || {}
      return h('input', {
        type: options.type || 'text',
        value,
        placeholder: options.placeholder || '',
        onChange: (event) => onChange(event.target.value),
        style: {
          padding: '6px 8px',
          borderRadius: 8,
          border: `1px solid ${C.border2}`,
          background: C.layer2,
          color: C.text,
          fontSize: 12,
          width: options.width || 120,
        },
      })
    }

    async function getStatus() {
      const res = await fetch(API, { headers: { accept: 'application/json' } })
      return res.json()
    }

    async function post(body) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.json()
    }

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
          'aria-label': '拼多多工作台',
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        h('rect', { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: active ? C.brand : C.muted }),
        h('path', {
          d: 'M15 23h30l-2.4 24.4a3.8 3.8 0 0 1-3.8 3.4H24.2a3.8 3.8 0 0 1-3.8-3.4L15 23z',
          fill: 'none',
          stroke: '#fff',
          'stroke-width': 3.4,
          'stroke-linejoin': 'round',
        }),
        h('path', {
          d: 'M22 23v-3.2a7 7 0 0 1 14 0V23',
          fill: 'none',
          stroke: '#fff',
          'stroke-width': 3.4,
          'stroke-linecap': 'round',
        }),
        h('path', {
          d: 'M24 38l4.6 4.6L38 33',
          fill: 'none',
          stroke: '#fff',
          'stroke-width': 3.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      )
    }

    // ------------------------------------------------------------ 表格

    const ORDER_COLUMNS = [
      { key: 'order_sn', title: '订单号', width: 190 },
      { key: 'platform', title: '来源', width: 74 },
      { key: 'status_text', title: '订单状态', width: 120 },
      { key: 'tracking_no', title: '物流单号', width: 170 },
      { key: 'carrier', title: '快递公司', width: 100 },
      { key: 'shop_name', title: '商家店铺名称', width: 150 },
      { key: 'goods', title: '商品信息', width: 320 },
      { key: 'spec', title: '规格', width: 220 },
      { key: 'item_qty', title: '数量', width: 56, align: 'right' },
      { key: 'receiver_name', title: '收货人', width: 90 },
      { key: 'receiver_phone', title: '收货人手机号', width: 130 },
      { key: 'address', title: '收货地址', width: 420 },
      { key: 'order_time', title: '下单时间', width: 168 },
      { key: 'ship_time', title: '发货时间', width: 168 },
      { key: 'updated_at', title: '采集时间', width: 168 },
    ]

    function orderCell(row, key) {
      if (key === 'goods') {
        const items = row.items || []
        if (!items.length) return '—'
        return items.map((item) => item.goods_name).filter(Boolean).join(' / ')
      }
      if (key === 'spec') {
        const items = row.items || []
        if (!items.length) return '—'
        return items.map((item) => item.spec).filter(Boolean).join(' / ')
      }
      if (key === 'address') return row.address || '—'
      if (key === 'status_text') return row.status_text || row.tab || '—'
      if (key === 'platform') return row.platform === '1688' ? '1688' : row.platform === 'pdd' ? '拼多多' : row.platform || '—'
      const value = row[key]
      return value === undefined || value === null || value === '' ? '—' : String(value)
    }

    function DataTable({ columns, rows, render, loading, emptyText }) {
      if (loading && !rows.length) return h('div', { style: { fontSize: 12, color: C.muted, padding: '12px 0' } }, '读取中…')
      if (!rows.length) return h('div', { style: { fontSize: 12, color: C.muted, padding: '12px 0' } }, emptyText || '没有数据')
      return h(
        'div',
        { style: { overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, maxHeight: 520 } },
        h(
          'table',
          { style: { borderCollapse: 'collapse', width: 'max-content', minWidth: '100%', fontSize: 11 } },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              columns.map((col) =>
                h(
                  'th',
                  {
                    key: col.key,
                    style: {
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                      background: C.layer2,
                      color: C.muted,
                      fontWeight: 600,
                      textAlign: col.align || 'left',
                      padding: '7px 8px',
                      borderBottom: `1px solid ${C.border}`,
                      whiteSpace: 'nowrap',
                      width: col.width,
                      minWidth: col.width,
                    },
                  },
                  col.title,
                ),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((row, index) =>
              h(
                'tr',
                { key: row.key || row.order_sn || row.xy_sn || index, style: { background: index % 2 ? 'transparent' : C.base } },
                columns.map((col) =>
                  h(
                    'td',
                    {
                      key: col.key,
                      style: {
                        padding: '6px 8px',
                        borderBottom: `1px solid ${C.border}`,
                        color: C.text,
                        textAlign: col.align || 'left',
                        whiteSpace: 'nowrap',
                        width: col.width,
                        minWidth: col.width,
                        verticalAlign: 'top',
                      },
                    },
                    render ? render(row, col.key) : row[col.key] == null || row[col.key] === '' ? '—' : String(row[col.key]),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    }

    // ------------------------------------------------------------ 订单视图

    function OrdersView({ status, days, setDays, from, setFrom, to, setTo }) {
      const [tab, setTab] = useState('all')
      const [platform, setPlatform] = useState('all')
      const [aliPath, setAliPath] = useState('')
      const [rows, setRows] = useState([])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')

      const scope = useMemo(() => ({ days, from, to }), [days, from, to])
      // days=0 表示不限日期；空输入回落到默认 2 天
      const daysValue = () => (days === '' || days === undefined || days === null ? 2 : Number(days))

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const payload = { action: 'list', limit: 500, withItems: true, order: 'asc' }
          if (tab !== 'all') payload.tab = tab
          if (platform !== 'all') payload.platform = platform
          if (from) payload.from = from
          if (to) payload.to = to
          if (!from && !to) payload.days = days === '' || days === undefined ? 2 : Number(days)
          const data = await post(payload)
          if (!data.ok) throw new Error(data.error || '读取失败')
          setRows(data.rows || [])
          setError('')
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setLoading(false)
        }
      }, [tab, platform, days, from, to])

      useEffect(() => {
        load()
      }, [load])

      const dayCounts = useMemo(() => {
        const map = new Map()
        for (const row of rows) {
          const day = row.order_date || ''
          if (!day) continue
          map.set(day, (map.get(day) || 0) + 1)
        }
        return [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      }, [rows])

      const run = async (kind) => {
        setBusy(kind)
        setNotice('')
        setError('')
        try {
          if (kind === 'sync') {
            const data = await post({ action: 'export', tab: tab === 'all' ? 'both' : tab, days: daysValue() })
            if (!data.ok) throw new Error(data.error || '启动失败')
            setNotice(data.message || '已开始同步')
          } else if (kind === 'xlsx') {
            const data = await post({ action: 'exportXlsx', tab, days: daysValue(), from, to, platform })
            if (!data.ok) throw new Error(data.error || '导出失败')
            setNotice(`已导出 ${data.rows} 行 → ${data.file}`)
          } else if (kind === 'csv') {
            const data = await post({ action: 'exportCsv', tab, days: daysValue(), from, to, platform })
            if (!data.ok) throw new Error(data.error || '导出失败')
            setNotice(`已导出 ${data.rows} 行 → ${data.file}`)
          } else if (kind === 'dir') {
            const data = await post({ action: 'openDir' })
            if (!data.ok) throw new Error(data.error || '打开失败')
            setNotice(`已打开 ${data.dir}`)
          } else if (kind === 'dataDir') {
            const data = await post({ action: 'openDataDir' })
            if (!data.ok) throw new Error(data.error || '打开失败')
            setNotice(`数据目录：${data.dir}（库文件 ${data.database}）`)
          } else if (kind === 'ali') {
            if (!aliPath.trim()) throw new Error('先填 1688 导出文件的完整路径')
            const data = await post({ action: 'import1688', path: aliPath.trim() })
            if (!data.ok) throw new Error(data.error || '导入失败')
            setNotice(`1688 导入完成：文件 ${data.rows} 行 → ${data.orders} 单（新增 ${data.inserted}，更新 ${data.updated}）`)
            await load()
          }
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy('')
        }
      }

      const running = status && status.running && status.running.status === 'running'
      const db = (status && status.database) || {}
      const daySummary = dayCounts.length ? dayCounts.map(([day, count]) => `${day}：${count} 单`).join('　｜　') : ''

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        card([
          sectionTitle('同步与导出', h('span', { style: { fontSize: 11, color: C.muted } }, `库里共 ${db.total || 0} 单`)),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('span', { style: { fontSize: 12, color: C.muted } }, '最近'),
            input(String(days), (value) => setDays(value === '' ? '' : Math.max(0, Number(value) || 0)), { type: 'number', width: 56 }),
            h('span', { style: { fontSize: 12, color: C.muted } }, '天（按订单时间）'),
            button('2 天', () => setDays(2), { small: true }),
            button('7 天', () => setDays(7), { small: true }),
            button('30 天', () => setDays(30), { small: true }),
            button('全部', () => setDays(0), { small: true }),
            h('span', { style: { fontSize: 12, color: C.muted } }, '或'),
            input(from, setFrom, { placeholder: '起 2026-10-26', width: 110 }),
            h('span', { style: { fontSize: 12, color: C.muted } }, '~'),
            input(to, setTo, { placeholder: '止 2026-10-27', width: 110 }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            button(running ? '同步中…' : '开始同步', () => run('sync'), { primary: true, disabled: Boolean(running) || Boolean(busy) }),
            button('导出 Excel', () => run('xlsx'), { disabled: Boolean(busy) }),
            button('导出 CSV', () => run('csv'), { disabled: Boolean(busy) }),
            button('打开导出目录', () => run('dir'), { disabled: Boolean(busy) }),
            button('打开数据目录', () => run('dataDir'), { disabled: Boolean(busy) }),
            button('刷新', load, { disabled: Boolean(busy) }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('span', { style: { fontSize: 12, color: C.muted } }, '1688 导出文件'),
            input(aliPath, setAliPath, { width: 380, placeholder: '工作台点「导出当前条件」下载的 xlsx 完整路径' }),
            button('导入 1688', () => run('ali'), { disabled: Boolean(busy) }),
            h('span', { style: { fontSize: 11, color: C.muted } }, '（1688 的导出自带收货人/手机/地址/物流单号）'),
          ),
          notice ? h('div', { style: { fontSize: 12, color: C.ok, wordBreak: 'break-all' } }, notice) : null,
          error ? h('div', { style: { fontSize: 12, color: C.err } }, error) : null,
        ]),
        card([
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            tabButton('全部订单', tab === 'all', () => setTab('all'), rows.length && tab === 'all' ? rows.length : undefined),
            tabButton('待发货订单', tab === 'pending', () => setTab('pending')),
            tabButton('已发货订单', tab === 'shipped', () => setTab('shipped')),
            h('span', { style: { fontSize: 11, color: C.muted } }, '｜来源'),
            tabButton('全部', platform === 'all', () => setPlatform('all')),
            tabButton('拼多多', platform === 'pdd', () => setPlatform('pdd')),
            tabButton('1688', platform === '1688', () => setPlatform('1688')),
            h('span', { style: { fontSize: 11, color: C.muted } }, '按下单时间升序'),
          ),
          daySummary
            ? h('div', { style: { fontSize: 12, color: C.text, background: C.layer2, borderRadius: 8, padding: '8px 10px' } }, `每日订单量　${daySummary}`)
            : null,
          DataTable({
            columns: ORDER_COLUMNS,
            rows,
            loading,
            render: orderCell,
            emptyText: (() => {
              const dbInfo = (status && status.database) || {}
              if (!dbInfo.total) return '库里还没有订单。点「开始同步」去采集。'
              const rangeText = from || to ? `${from || '最早'} ~ ${to || '今天'}` : days === 0 ? '全部' : `最近 ${days} 天`
              return `当前范围（${rangeText}）没有订单；库里其实有 ${dbInfo.total} 单，最早 ${dbInfo.firstOrderDate || '—'}、最新 ${dbInfo.lastOrderDate || '—'}。把天数调大或点「全部」就能看到。`
            })(),
          }),
        ]),
      )
    }

    // ------------------------------------------------------------ 核对视图

    const MATCH_COLUMNS = [
      { key: 'xy_sn', title: '闲鱼订单号', width: 210 },
      { key: 'xy_status', title: '闲鱼状态', width: 90 },
      { key: 'xy_receiver', title: '收件人', width: 90 },
      { key: 'xy_phone', title: '收件号码', width: 130 },
      { key: 'xy_item', title: '闲鱼商品', width: 260 },
      { key: 'xy_order_time', title: '闲鱼下单时间', width: 150 },
      { key: 'source', title: '来源', width: 74 },
      { key: 'pdd_sn', title: '来源订单号', width: 200 },
      { key: 'pdd_status', title: '来源状态', width: 110 },
      { key: 'tracking_no', title: '物流单号', width: 170 },
      { key: 'carrier', title: '快递', width: 90 },
      { key: 'alt', title: '另一候选', width: 220 },
      { key: 'score', title: '匹配分', width: 70, align: 'right' },
      { key: 'decision', title: '结论', width: 110 },
      { key: 'method', title: '依据', width: 150 },
    ]

    function MatchView() {
      const [rows, setRows] = useState([])
      const [loading, setLoading] = useState(false)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [path, setPath] = useState('C:\\Users\\78452\\Downloads\\所有订单20260729-20261027.xlsx')
      const [busy, setBusy] = useState('')
      const [auditResult, setAuditResult] = useState(null)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const data = await post({ action: 'matchXianyu' })
          if (!data.ok) throw new Error(data.error || '核对失败')
          setNotice(`核对完成：自动 ${data.auto}，待确认 ${data.candidate}，未匹配 ${data.unmatched}（闲鱼 ${data.xyTotal} / 拼多多 ${data.pddTotal}）`)
          const list = await post({ action: 'xianyuList', limit: 500 })
          if (list.ok) setRows(list.rows || [])
          setError('')
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const run = async (kind) => {
        setBusy(kind)
        setError('')
        setNotice('')
        try {
          if (kind === 'import') {
            const data = await post({ action: 'importXianyu', path })
            if (!data.ok) throw new Error(data.error || '导入失败')
            setNotice(`已导入 ${data.imported} 条闲鱼订单：${JSON.stringify(data.byStatus)}`)
            await load()
          } else if (kind === 'match') {
            await load()
          } else if (kind === 'shipping') {
            const data = await post({ action: 'exportShipping' })
            if (!data.ok) throw new Error(data.error || '导出失败')
            const warn = data.unmappedCarriers && data.unmappedCarriers.length ? `；未映射快递：${data.unmappedCarriers.join('、')}` : ''
            setNotice(data.rows ? `已生成 ${data.rows} 条发货记录 → ${data.file}${warn}` : data.message || '没有可导出的订单')
          } else if (kind === 'matches') {
            const data = await post({ action: 'exportMatches' })
            if (!data.ok) throw new Error(data.error || '导出失败')
            setNotice(data.rows ? `核对明细 ${data.rows} 行（需人工 ${data.needReview}）→ ${data.file}` : data.message || '还没有核对结果')
          } else if (kind === 'audit') {
            const data = await post({ action: 'audit' })
            if (!data.ok && !data.findings) throw new Error(data.error || '审核失败')
            setAuditResult(data)
            setNotice(`智能审核：${data.summary}`)
          } else if (kind === 'dir') {
            const data = await post({ action: 'openDir' })
            if (!data.ok) throw new Error(data.error || '打开失败')
            setNotice(`已打开 ${data.dir}`)
          }
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy('')
        }
      }

      const triage = useMemo(() => {
        const stat = { auto: 0, manual: 0, candidate: 0, unmatched: 0, needsReview: 0 }
        for (const row of rows) {
          const decision = row.match && row.match.decision ? row.match.decision : 'unmatched'
          stat[decision] = (stat[decision] || 0) + 1
          if (row.mark && row.mark.needsReview) stat.needsReview += 1
        }
        return stat
      }, [rows])

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        card([
          sectionTitle('闲鱼订单导入与核对', h('span', { style: { fontSize: 11, color: C.muted } }, `闲鱼 ${rows.length} 单`)),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            input(path, setPath, { width: 460, placeholder: '闲鱼订单 xlsx 路径' }),
            button('导入闲鱼 xlsx', () => run('import'), { disabled: Boolean(busy) }),
            button('智能核对', () => run('match'), { primary: true, disabled: Boolean(busy) }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            chip(`已匹配 ${triage.auto || 0}`, 'ok'),
            chip(`待确认 ${triage.candidate || 0}`, 'warn'),
            triage.manual ? chip(`人工确认 ${triage.manual}`, 'brand') : null,
            chip(`未匹配 ${triage.unmatched || 0}`, 'err'),
            chip(`需人工 ${triage.needsReview || 0}`, 'warn', '待确认 + 未匹配 的合计：这些必须有人看一眼'),
            button('导出核对明细', () => run('matches'), { disabled: Boolean(busy) }),
            button('智能审核', () => run('audit'), { disabled: Boolean(busy) }),
            button('生成闲鱼批量发货模板', () => run('shipping'), { disabled: Boolean(busy) }),
            button('打开导出目录', () => run('dir'), { disabled: Boolean(busy) }),
          ),
          h('div', { style: { fontSize: 11, color: C.muted, lineHeight: '18px' } },
            '配对依据：手机号（最硬）→ 姓名 → 地址 → 商品标题 → 下单时间先后。一个来源订单只会配一个闲鱼订单；手机号对不上的一律进「待确认」。'),
          notice ? h('div', { style: { fontSize: 12, color: C.ok, wordBreak: 'break-all' } }, notice) : null,
          error ? h('div', { style: { fontSize: 12, color: C.err } }, error) : null,
          auditResult
            ? h(
                'div',
                { style: { border: `1px solid ${C.border2}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                  chip(`审核：${auditResult.summary}`, auditResult.ok ? 'ok' : 'err'),
                  chip(`错误 ${auditResult.counts.error}`, 'err'),
                  chip(`提醒 ${auditResult.counts.warn}`, 'warn'),
                  chip(`提示 ${auditResult.counts.info}`, 'idle'),
                ),
                ...auditResult.findings.slice(0, 8).map((item) =>
                  h(
                    'div',
                    { key: `${item.code}-${item.orderSn || item.xySn || item.trackingNo || item.title}`, style: { fontSize: 11, color: C.text, display: 'flex', gap: 6 } },
                    chip(item.severity === 'error' ? '错误' : item.severity === 'warn' ? '提醒' : '提示', item.severity === 'error' ? 'err' : item.severity === 'warn' ? 'warn' : 'idle'),
                    h('span', { style: { color: C.muted } }, item.title),
                    h('span', null, item.detail),
                  ),
                ),
                auditResult.findings.length > 8
                  ? h('div', { style: { fontSize: 11, color: C.muted } }, `还有 ${auditResult.findings.length - 8} 条，用 action=audit 看全量`)
                  : null,
              )
            : null,
        ]),
        card([
          sectionTitle('核对结果'),
          DataTable({
            columns: MATCH_COLUMNS,
            rows: rows.map((row) => ({
              key: row.xy_sn,
              xy_sn: row.xy_sn,
              xy_status: row.status,
              xy_receiver: row.receiver,
              xy_phone: row.phone || '—',
              xy_item: row.item_title,
              xy_order_time: row.order_time,
              source: row.match && row.match.pdd_sn ? (row.match.source_platform === '1688' ? '1688' : '拼多多') : '',
              pdd_sn: row.match ? row.match.pdd_sn : '',
              pdd_status: row.match ? row.match.pdd_status : '',
              tracking_no: row.match ? row.match.tracking_no : '',
              carrier: row.match ? row.match.carrier : '',
              alt: row.match && row.match.alt_sn ? `${row.match.alt_platform === '1688' ? '1688' : '拼多多'} ${row.match.alt_sn}（${row.match.score_alt}）` : '',
              score: row.mark && row.mark.score != null ? `${row.mark.score}（${row.mark.confidence === 'high' ? '高' : row.mark.confidence === 'medium' ? '中' : row.mark.confidence === 'low' ? '低' : '—'}）` : '',
              decision: row.mark ? `${row.mark.label}${row.mark.needsReview ? ' ⚠' : ''}` : '未匹配 ⚠',
              method: row.match ? row.match.method : '',
            })),
            loading,
            emptyText: '还没有闲鱼订单。先导入 xlsx。',
          }),
        ]),
      )
    }

    // ------------------------------------------------------------ 面板

    /** 「拼多多 187 · 1688 10」这样的一行来源分布。 */
    function platformSummary(database) {
      if (!database) return '来源 —'
      const rows = database.byPlatform || []
      if (!rows.length) return '来源 —'
      const label = (key) => (key === '1688' ? '1688' : key === 'pdd' ? '拼多多' : key || '未知')
      const parts = rows.map((row) => `${label(row.platform)} ${row.c}`)
      const range = database.lastOrderDate ? `（最新 ${database.lastOrderDate}）` : ''
      return `${parts.join(' · ')}${range}`
    }

    function Panel() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [view, setView] = useState('orders')
      const [days, setDays] = useState(2)
      const [from, setFrom] = useState('')
      const [to, setTo] = useState('')
      const [checking, setChecking] = useState(false)
      const [notice, setNotice] = useState('')

      const refresh = useCallback(async () => {
        try {
          const data = await getStatus()
          if (!data.ok) throw new Error(data.error || '读取失败')
          setStatus(data)
          setError('')
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 5000)
        return () => clearInterval(timer)
      }, [refresh])

      const browser = (status && status.browser) || {}
      const run = (status && status.running) || null
      const platforms = (status && status.platforms) || []
      const platformText = (status && status.platformSummary && status.platformSummary.text) || '登录态未确认'
      const toneOf = (level) => (level === 'ready' ? 'ok' : level === 'need-login' ? 'err' : level === 'offline' ? 'warn' : 'idle')

      const openLogin = async (action) => {
        setNotice('')
        setError('')
        try {
          const data = await post({ action })
          if (!data.ok) throw new Error(data.error || '打开登录页失败')
          setNotice(data.message || '已打开登录页，请在弹出的浏览器里扫码')
          await refresh()
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }

      const runCheck = async () => {
        setChecking(true)
        setNotice('')
        setError('')
        try {
          const data = await post({ action: 'checkLogin' })
          if (!data.ok) throw new Error(data.error || '检测失败')
          setNotice(data.summary ? data.summary.text : '检测完成')
          await refresh()
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setChecking(false)
        }
      }

      return h(
        'div',
        { style: { padding: 18, display: 'flex', flexDirection: 'column', gap: 12, background: C.base, minHeight: '100%' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 18, fontWeight: 700, color: C.text } }, '拼多多工作台'),
          h('div', { style: { fontSize: 12, color: C.muted } }, '待发货 / 已发货订单导出入库 · 闲鱼订单智能核对'),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          chip(browser.connected ? '浏览器已连接' : '浏览器未启动', browser.connected ? 'ok' : 'warn'),
          ...platforms.map((item) => chip(`${item.name} · ${item.text}`, toneOf(item.level), item.detail || '')),
          chip(platformText, platforms.length && platforms.every((item) => item.ready) ? 'ok' : platforms.some((item) => item.level === 'need-login') ? 'err' : 'idle'),
          chip(`库里 ${(status && status.database && status.database.total) || 0} 单`, 'brand'),
          chip(
            platformSummary(status && status.database),
            'idle',
            status && status.database ? `库文件：${status.database.path}` : '',
          ),
          run ? chip(`同步 ${run.status} ${run.done || 0}/${(run.done || 0) + (run.failed || 0)}`, run.status === 'running' ? 'brand' : run.status === 'failed' ? 'err' : 'ok') : null,
          button(checking ? '检测中…' : '检测登录', runCheck, { small: true, disabled: checking }),
          notice ? h('span', { style: { fontSize: 11, color: C.ok } }, notice) : null,
        ),
        platforms.filter((item) => !item.ready && item.guide).length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${C.border2}`, borderRadius: 8, padding: '8px 10px', background: C.layer1 } },
              ...platforms
                .filter((item) => !item.ready && item.guide)
                .map((item) =>
                  h(
                    'div',
                    { key: item.id, style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    chip(item.name, toneOf(item.level)),
                    h('span', { style: { fontSize: 12, color: C.text } }, `${item.text}：${item.detail || ''}`),
                    button(item.guide.label, () => openLogin(item.guide.action), { small: true, primary: item.level === 'need-login' }),
                  ),
                ),
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          tabButton('订单', view === 'orders', () => setView('orders')),
          tabButton('订单智能核对', view === 'match', () => setView('match')),
        ),
        error ? h('div', { style: { fontSize: 12, color: C.err } }, error) : null,
        view === 'orders'
          ? h(OrdersView, { status, days, setDays, from, setFrom, to, setTo })
          : h(MatchView),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'pdd-workbench', order: 46, label: '拼多多工作台' },
            SidebarEntry,
          ),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'pdd-workbench' }, Panel))
      },
    }
  },
})

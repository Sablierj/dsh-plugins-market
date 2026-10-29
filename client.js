/**
 * Client 侧：BOSS 招聘流水线面板（v2）
 *
 * 结构：顶部栏（岗位/模式/进度/设置）→ 岗位设置 → 统计条 → 筛选排序 → 候选人表格 → 详情展开
 * 数据全部来自 Host 的 /boss-recruit/api（GET 读、POST 写）。
 * 只用 React.createElement + 内联样式，不依赖任何外部 CSS。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-boss-recruit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API = '/boss-recruit/api'

    // 主题色全部走宿主 CSS 变量，深色/浅色自动跟随
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

    const TONE_COLOR = { idle: C.idle, warn: C.warn, brand: C.brand, ok: C.ok, err: C.err }

    const STAGE_TONE = {
      new: 'warn',
      greeted: 'idle',
      inbound: 'brand',
      qualified: 'brand',
      resume_requested: 'brand',
      resume_received: 'brand',
      interview_pending: 'warn',
      interview_available: 'ok',
      interview_scheduled: 'ok',
      pending: 'warn',
      rejected: 'err',
      stale: 'err',
    }

    // 状态下拉顺序（含待定）
    const STAGE_FILTERS = [
      '', 'new', 'greeted', 'inbound', 'qualified', 'resume_requested',
      'resume_received', 'interview_pending', 'interview_available',
      'interview_scheduled', 'pending', 'rejected', 'stale',
    ]

    // v2.2：模式图标 / 简称（顶部上下文行与模式按钮共用）
    const MODE_ICON = { recruit: '🎯', reply: '💬', all: '🔄' }
    const MODE_SHORT = { recruit: '招聘模式', reply: '回话模式', all: '混合模式' }
    const MODE_OPTIONS = [
      ['recruit', '🎯 招聘'],
      ['reply', '💬 回话'],
      ['all', '🔄 混合'],
    ]

    // 跨岗位只读视图的哨兵 id（不是真岗位，只存在面板本地，不回写 Host）
    const ALL_JOBS = 'all'

    const SORT_OPTIONS = [
      ['seq', '序号'],
      ['updatedAt', '更新时间'],
      ['firstSeenAt', '首次登记'],
      ['greetedAt', '打招呼时间'],
      ['gradYear', '毕业年份'],
      ['workYears', '工作年限'],
      ['expectSalaryMinK', '期望薪资下限'],
      ['matchScore', '匹配分'],
      ['techFitScore', '匹配度'],
      ['valueScore', '性价比'],
      ['starred', '⭐优先'],
      ['stage', '状态'],
    ]

    const EDU_OPTIONS = ['', '大专', '本科', '硕士', '博士', '高中', '中专']

    // v2.1 派生评分：等级 → 配色（S/A 绿、B 蓝、C 橙、D 红、NA 灰）
    const GRADE_COLOR = { S: C.ok, A: C.ok, B: C.brand, C: C.warn, D: C.err, NA: C.muted }
    const GRADE_TONE = { S: 'ok', A: 'ok', B: 'brand', C: 'warn', D: 'err', NA: 'idle' }
    const VALUE_GRADE_FILTERS = ['', 'S', 'A', 'B', 'C', 'D', 'NA']

    // 可编辑口径字段定义
    const CRITERIA_FIELDS = [
      { key: 'jobTitle', label: '岗位名称', type: 'text' },
      { key: 'city', label: '工作地点', type: 'text' },
      { key: 'cityWhitelist', label: '城市白名单', type: 'csv', hint: '用 、 或 , 分隔' },
      { key: 'salaryMinK', label: '薪资下限(K)', type: 'number' },
      { key: 'salaryMaxK', label: '薪资上限(K)', type: 'number' },
      { key: 'expectSalaryMinCapK', label: '待定线(K)', type: 'number', hint: '期望下限 > 此值 → 待定，不淘汰' },
      { key: 'eduMin', label: '最低学历', type: 'select', options: ['不限', '中专', '高中', '大专', '本科', '硕士', '博士'] },
      { key: 'gradYearMin', label: '毕业年限(年)', type: 'number' },
      { key: 'workYearMin', label: '工作年限(年)', type: 'number' },
      { key: 'xuexinRequired', label: '要求学信网可查', type: 'bool' },
      { key: 'mustSkills', label: '必备技能', type: 'csv' },
      { key: 'plusSkills', label: '加分技能', type: 'csv' },
      { key: 'rejectSkills', label: '方向排除', type: 'csv' },
      { key: 'projectKeywords', label: '项目关键词', type: 'csv' },
      { key: 'techDepthKeywords', label: '工程深度关键词', type: 'csv', hint: '命中条数 ×4 分，上限 20' },
      { key: 'starTokens', label: '方向加分词', type: 'csv', hint: '命中即加分并参与⭐回捞判断；留空 = 不做方向加分' },
      { key: 'dealbreakers', label: '一票否决', type: 'csv' },
    ]

    const CSV_KEYS = CRITERIA_FIELDS.filter((f) => f.type === 'csv').map((f) => f.key)

    const TEMPLATE_VARS = '{jobTitle} {city} {salary} {eduMin} {gradYearMin} {highlights}'

    // ---------------------------------------------------------------- 基础件

    function chip(text, tone, title) {
      const color = TONE_COLOR[tone] || C.idle
      return h(
        'span',
        {
          title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 7px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            color,
            border: `1px solid ${color}`,
            opacity: 0.95,
          },
        },
        text,
      )
    }

    /** 分数 + 等级（表格单元格用）：NA/空值显示 ——，其余按等级上色 */
    // v2.22.0：简历接收时间统一显示成「YYYY-MM-DD HH:mm」
function fmtResumeAt(v) {
  const s = String(v || '').trim()
  if (!s) return '—'
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return s
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function scoreText(score, grade) {      if (score == null || grade === 'NA') {
        return h('span', { style: { color: C.muted } }, '—')
      }
      const color = GRADE_COLOR[grade] || C.muted
      return h('span', { style: { color, fontWeight: 600, whiteSpace: 'nowrap' } }, `${score} ${grade}`)
    }

    function button(label, onClick, primary, disabled, key, title) {
      return h(
        'button',
        {
          key,
          type: 'button',
          title,
          onClick,
          disabled: Boolean(disabled),
          style: {
            padding: '3px 10px',
            borderRadius: 7,
            fontSize: 12,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            color: primary ? '#fff' : C.text,
            background: primary ? C.brand : C.layer2,
            border: `1px solid ${primary ? C.brand : C.border}`,
            whiteSpace: 'nowrap',
          },
        },
        label,
      )
    }

    const inputStyle = {
      padding: '3px 7px',
      borderRadius: 6,
      fontSize: 12,
      color: C.text,
      background: C.layer1,
      border: `1px solid ${C.border}`,
      minWidth: 0,
    }

    function field(label, control, hint) {
      return h(
        'label',
        { key: label, style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: C.muted } },
        h('span', null, label),
        control,
        hint ? h('span', { style: { color: C.muted, opacity: 0.8 } }, hint) : null,
      )
    }

    function ProgressBar({ label, done, target, tone, width }) {
      const total = target || 1
      const pct = Math.min(100, Math.round((done / total) * 100))
      const color = pct >= 100 ? C.ok : tone || C.brand
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.muted } },
        h('span', { style: { whiteSpace: 'nowrap' } }, label),
        h(
          'div',
          {
            style: {
              width: width || 90,
              height: 5,
              borderRadius: 999,
              background: C.layer2,
              border: `1px solid ${C.border}`,
              overflow: 'hidden',
            },
          },
          h('div', { style: { width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s ease' } }),
        ),
        h('span', { style: { color, whiteSpace: 'nowrap' } }, `${done}/${target}`),
      )
    }

    // ---------------------------------------------------------------- 话术工具

    /** 模板变量填充（与 Host 的 fill() 保持同一套变量） */
    function fillTemplate(tpl, job) {
      if (!tpl) return ''
      const c = (job && job.criteria) || {}
      const salary = c.salary || `${c.salaryMinK}-${c.salaryMaxK}K`
      const highlights = ((job && job.highlights) || []).join('、')
      return String(tpl)
        .replace(/\{jobTitle\}/g, c.jobTitle || '')
        .replace(/\{city\}/g, c.city || '')
        .replace(/\{salary\}/g, salary)
        .replace(/\{eduMin\}/g, c.eduMin || '')
        .replace(/\{gradYearMin\}/g, c.gradYearMin == null ? '' : String(c.gradYearMin))
        .replace(/\{workYearMin\}/g, c.workYearMin == null ? '' : String(c.workYearMin))
        .replace(/\{highlights\}/g, highlights)
    }

    /** 按 stage + 信息完整度推荐下一条该发的话（只复制，不发送） */
    function recommendStep(row, job) {
      const flow = {}
      for (const step of (job && job.flow) || []) flow[step.key] = step
      const missingEdu = !row.edu
      const missingXuexin = !row.xuexinSelf || row.xuexinSelf === '未说'
      const clarifyStage = ['greeted', 'inbound', 'qualified', 'resume_requested', 'resume_received']
      if ((missingEdu || missingXuexin) && clarifyStage.includes(row.stage)) {
        if (flow.clarify && flow.clarify.enabled !== false && flow.clarify.template) {
          return { key: 'clarify', name: '追问澄清', text: fillTemplate(flow.clarify.template, job) }
        }
      }
      const map = {
        new: 'greet',
        greeted: 'askResume',
        inbound: 'askResume',
        qualified: 'askResume',
        resume_requested: 'askResume',
        resume_received: 'ackResume',
        interview_pending: 'askInterview',
        interview_available: 'askInterview',
      }
      const key = map[row.stage]
      const step = key ? flow[key] : null
      if (!step || step.enabled === false || !step.template) return null
      return { key, name: step.name || key, text: fillTemplate(step.template, job) }
    }

    function splitList(text) {
      return String(text || '')
        .split(/[、,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    }

    function downloadText(filename, text, mime) {
      const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    }

    function csvCell(value) {
      const text = value == null ? '' : String(value)
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }

    // ---------------------------------------------------------------- 设置面板

    function JobSettings({ job, onSave, onCancel, busy, error }) {
      const c0 = job.criteria || {}
      const [name, setName] = useState(job.name || '')
      const [criteria, setCriteria] = useState({ ...c0 })
      const [csvText, setCsvText] = useState(() => {
        const out = {}
        for (const key of CSV_KEYS) out[key] = Array.isArray(c0[key]) ? c0[key].join('、') : String(c0[key] || '')
        return out
      })
      const [highlights, setHighlights] = useState(job.highlights || [])
      const [flow, setFlow] = useState((job.flow || []).map((s) => ({ ...s })))
      // v2.11.0：工作流程编辑（招聘 / 回话两套动作序列）
      const [wfTab, setWfTab] = useState('recruit')

      // v2.8.0：未保存改动检测 —— 之前「改了话术但没保存」就是因为保存按钮在卡片顶部，
      // 话术在卡片最底部，隔着好几屏，很容易改完直接关掉面板。
      const [initialSnap] = useState(() => JSON.stringify({
        name: job.name || '',
        criteria: { ...c0 },
        csvText: (() => {
          const out = {}
          for (const key of CSV_KEYS) out[key] = Array.isArray(c0[key]) ? c0[key].join('、') : String(c0[key] || '')
          return out
        })(),
        highlights: job.highlights || [],
        flow: job.flow || [],
      }))
      const dirty = JSON.stringify({ name, criteria, csvText, highlights, flow }) !== initialSnap

      const setCrit = (key, value) => setCriteria((prev) => ({ ...prev, [key]: value }))

      const patchFlow = (i, patch) => setFlow((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)))
      const moveFlow = (i, delta) => setFlow((prev) => {
        const j = i + delta
        if (j < 0 || j >= prev.length) return prev
        const next = prev.slice()
        const tmp = next[i]
        next[i] = next[j]
        next[j] = tmp
        return next
      })
      const removeFlow = (i) => setFlow((prev) => prev.filter((_, j) => j !== i))
      const addFlow = () => setFlow((prev) => prev.concat([{
        key: `step${prev.length + 1}`,
        name: `步骤${prev.length + 1}`,
        enabled: true,
        template: '',
      }]))
      const onClose = () => {
        if (dirty && typeof window !== 'undefined' && window.confirm && !window.confirm('有未保存的改动，确定收起吗？')) return
        onCancel()
      }

      const save = () => {
        const outCriteria = { ...criteria }
        for (const key of CSV_KEYS) outCriteria[key] = splitList(csvText[key])
        for (const f of CRITERIA_FIELDS) {
          if (f.type === 'number' && outCriteria[f.key] !== '' && outCriteria[f.key] != null) {
            outCriteria[f.key] = Number(outCriteria[f.key])
          }
        }
        onSave({
          action: 'saveJob',
          jobId: job.id,
          name,
          criteria: outCriteria,
          highlights: highlights.filter((x) => String(x).trim() !== ''),
          flow,
        })
      }

      return h(
        'div',
        {
          style: {
            margin: '10px 0 14px',
            padding: '12px 14px',
            borderRadius: 10,
            background: C.layer1,
            border: `1px solid ${C.border}`,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '岗位设置'),
          h('div', { style: { flex: 1 } }),
          dirty ? h('span', { style: { fontSize: 11, color: C.warn } }, '● 有未保存改动') : null,
          button(busy ? '保存中…' : '保存到 Host', save, true, busy),
          button('收起', onClose, false, busy),
        ),
        error
          ? h('div', { style: { color: C.err, fontSize: 12, marginBottom: 8 } }, error)
          : null,

        // 岗位名称
        h('div', { style: { marginBottom: 10 } },
          field('岗位显示名', h('input', {
            style: { ...inputStyle, width: '100%' },
            value: name,
            onChange: (e) => setName(e.target.value),
          })),
        ),

        // 口径字段网格
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
            gap: 8,
            marginBottom: 12,
          },
        },
        CRITERIA_FIELDS.map((f) => {
          if (f.type === 'csv') {
            return field(
              f.label,
              h('input', {
                style: inputStyle,
                value: csvText[f.key] || '',
                onChange: (e) => setCsvText((prev) => ({ ...prev, [f.key]: e.target.value })),
              }),
              f.hint || '用 、 分隔',
            )
          }
          if (f.type === 'number') {
            return field(
              f.label,
              h('input', {
                style: inputStyle,
                type: 'number',
                value: criteria[f.key] == null ? '' : criteria[f.key],
                onChange: (e) => setCrit(f.key, e.target.value === '' ? '' : Number(e.target.value)),
              }),
              f.hint,
            )
          }
          if (f.type === 'select') {
            return field(
              f.label,
              h('select', {
                style: inputStyle,
                value: criteria[f.key] || '',
                onChange: (e) => setCrit(f.key, e.target.value),
              }, (f.options || []).map((o) => h('option', { key: o, value: o }, o))),
            )
          }
          if (f.type === 'bool') {
            return field(
              f.label,
              h('input', {
                type: 'checkbox',
                checked: Boolean(criteria[f.key]),
                onChange: (e) => setCrit(f.key, e.target.checked),
                style: { alignSelf: 'flex-start', marginTop: 3 },
              }),
            )
          }
          return field(
            f.label,
            h('input', {
              style: inputStyle,
              value: criteria[f.key] == null ? '' : criteria[f.key],
              onChange: (e) => setCrit(f.key, e.target.value),
            }),
          )
        })),

        // 要点
        h('div', { style: { marginBottom: 12 } },
          h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 4 } }, '岗位要点（可用 {highlights} 注入话术）'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            highlights.map((text, i) =>
              h('div', { key: `hl-${i}`, style: { display: 'flex', gap: 6 } },
                h('input', {
                  style: { ...inputStyle, flex: 1 },
                  value: text,
                  onChange: (e) => setHighlights((prev) => prev.map((x, j) => (j === i ? e.target.value : x))),
                }),
                button('删除', () => setHighlights((prev) => prev.filter((_x, j) => j !== i)), false, false, `del-${i}`),
              )),
            button('+ 添加要点', () => setHighlights((prev) => [...prev, '']), false, false, 'add-hl'),
          )),

        // 话术流程
        h('div', null,
          h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 4 } }, '话术流程'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            flow.map((step, i) =>
              h('div', {
                key: `flow-${step.key || i}`,
                style: {
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: C.layer2,
                  border: `1px solid ${C.border}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                },
              },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, color: C.muted } },
                  h('input', {
                    type: 'checkbox',
                    checked: step.enabled !== false,
                    onChange: (e) => setFlow((prev) => prev.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x))),
                  }),
                  '启用',
                ),
                h('span', { style: { color: C.muted, fontSize: 11 } }, step.key),
                h('input', {
                  style: { ...inputStyle, width: 120 },
                  value: step.name || '',
                  onChange: (e) => patchFlow(i, { name: e.target.value }),
                }),
                h('div', { style: { flex: 1 } }),
                button('↑', () => moveFlow(i, -1), false, i === 0, `flow-up-${i}`, '上移该步骤'),
                button('↓', () => moveFlow(i, 1), false, i === flow.length - 1, `flow-down-${i}`, '下移该步骤'),
                button('✕', () => removeFlow(i), false, flow.length <= 1, `flow-del-${i}`, '删除该步骤'),
              ),
              h('textarea', {
                style: { ...inputStyle, minHeight: 44, resize: 'vertical', lineHeight: 1.5 },
                value: step.template || '',
                onChange: (e) => patchFlow(i, { template: e.target.value }),
              }),
            ))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
            button('＋ 新增步骤', addFlow, false, false, 'flow-add', '在话术流程末尾追加一个步骤'),
            h('div', { style: { fontSize: 11, color: C.muted } }, `可用变量：${TEMPLATE_VARS}`),
          ),
        ),

        // ===== v2.12.0：防风控（拟人化）参数，全部可配 =====
        (() => {
          const hz = criteria.humanize || {}
          const setHz = (p) => setCrit('humanize', { ...hz, ...p })
          const val = (k, d) => (hz[k] == null ? d : hz[k])
          const lab = { fontSize: 11, color: C.muted, minWidth: 132 }
          const numBox = (k, d, step) => h('input', {
            style: { ...inputStyle, width: 76, textAlign: 'right' },
            type: 'number',
            step: step || 1,
            value: val(k, d),
            onChange: (e) => setHz({ [k]: Number(e.target.value) }),
          })
          const rangeBox = (k, d) => {
            const cur = Array.isArray(hz[k]) && hz[k].length >= 2 ? hz[k] : d
            return h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
              h('input', {
                style: { ...inputStyle, width: 64, textAlign: 'right' },
                type: 'number',
                value: cur[0],
                onChange: (e) => setHz({ [k]: [Number(e.target.value), cur[1]] }),
              }),
              h('span', { style: { color: C.muted, fontSize: 11 } }, '~'),
              h('input', {
                style: { ...inputStyle, width: 64, textAlign: 'right' },
                type: 'number',
                value: cur[1],
                onChange: (e) => setHz({ [k]: [cur[0], Number(e.target.value)] }),
              }),
            )
          }
          const row = (label, control, hint) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
            h('div', { style: lab }, label),
            control,
            hint ? h('div', { style: { fontSize: 10, color: C.muted } }, hint) : null,
          )
          return h('div', {
            style: {
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 8,
              background: C.layer2,
              border: `1px solid ${C.warn}`,
            },
          },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, '防风控 · 拟人化参数（可配）'),
            h('div', { style: { fontSize: 11, color: C.muted, lineHeight: 1.6, marginTop: 2 } },
              '这些值决定「点击像不像人」和「节奏像不像人」。点击坐标与停顿由 clickPlan(x,y) 按这些参数现算，照着执行即可。'),
            row('落点随机偏移 (px)', numBox('clickOffsetPx', 15), '±该范围内随机，0 = 永远点中心（危险）'),
            row('点击前预移动次数', numBox('preMoveCount', 2), '1~2 次即可，制造鼠标轨迹'),
            row('预移动间隔 (ms)', rangeBox('preMoveDelayMs', [120, 420])),
            row('到位停留 (ms)', rangeBox('hoverDwellMs', [300, 1200]), '按下去之前先停一下'),
            row('动作间停顿 (ms)', rangeBox('actionPauseMs', [600, 1800]), '任意两个动作之间'),
            row('读简历停留 (秒)', rangeBox('browseDwellSec', [20, 40]), 'screen 登记后至少读这么久'),
            row('打字逐字延迟 (ms)', rangeBox('typeCharDelayMs', [60, 160]), '禁止整段粘贴'),
            row('点击前先滚动的概率', numBox('scrollBeforeClick', 0.35, 0.05), '0~1，制造分叉'),
            row('看了不打招呼比例', numBox('skipRate', 0.15, 0.05), '0~1，别每张都打'),
            row('切换页面概率', numBox('wanderRate', 0.1, 0.05), '0~1'),
            row('验证码冷却 (分钟)', numBox('verifyCooldownMin', 30), '看到验证页就停这么久'),
            row('单日硬上限 (条)', numBox('dailyHardCap', 40), '额度是理论值，这个才是安全线'),
          )
        })(),

        // ===== v2.11.0：工作流程（把动作画出来，可增删改排序）=====
        (() => {
          const wfAll = criteria.workflow || {}
          const steps = Array.isArray(wfAll[wfTab]) ? wfAll[wfTab] : []
          const write = (arr) => setCrit('workflow', { ...wfAll, [wfTab]: arr })
          const patch = (i, p) => write(steps.map((s, j) => (j === i ? { ...s, ...p } : s)))
          const move = (i, d) => {
            const j = i + d
            if (j < 0 || j >= steps.length) return
            const nx = steps.slice()
            const t = nx[i]
            nx[i] = nx[j]
            nx[j] = t
            write(nx)
          }
          const del = (i) => write(steps.filter((_, j) => j !== i))
          const add = () => write(steps.concat([{ key: `s${steps.length + 1}`, action: `新动作${steps.length + 1}`, text: '' }]))
          return h('div', {
            style: {
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 8,
              background: C.layer2,
              border: `1px solid ${C.border}`,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              h('div', { style: { fontSize: 12, fontWeight: 600 } }, '工作流程（可改）'),
              h('div', { style: { flex: 1 } }),
              button('招聘流程', () => setWfTab('recruit'), wfTab === 'recruit', false, 'wf-recruit', '推荐页的动作序列'),
              button('回话流程', () => setWfTab('reply'), wfTab === 'reply', false, 'wf-reply', '沟通页的动作序列'),
            ),
            h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 8 } },
              '这里的顺序就是 system prompt 里「工作流程」的顺序，也是执行时唯一允许的顺序。每一步 = 一个动作。'),
            steps.length === 0
              ? h('div', { style: { fontSize: 11, color: C.muted } }, '还没有动作，点下面新增。')
              : steps.map((s, i) =>
                h('div', { key: `wf-${wfTab}-${i}`, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  h('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      borderRadius: 8,
                      background: C.layer1,
                      border: `1px solid ${C.brand}`,
                    },
                  },
                    h('span', {
                      style: {
                        minWidth: 20,
                        height: 20,
                        lineHeight: '20px',
                        textAlign: 'center',
                        borderRadius: 10,
                        background: C.brand,
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 700,
                      },
                    }, String(i + 1)),
                    h('input', {
                      style: { ...inputStyle, width: 160, fontWeight: 600 },
                      value: s.action || '',
                      onChange: (e) => patch(i, { action: e.target.value }),
                      placeholder: '动作名',
                    }),
                    h('input', {
                      style: { ...inputStyle, flex: 1, minWidth: 120 },
                      value: s.text || '',
                      onChange: (e) => patch(i, { text: e.target.value }),
                      placeholder: '这一步具体做什么（支持变量）',
                    }),
                    button('↑', () => move(i, -1), false, i === 0, `wf-up-${i}`, '上移'),
                    button('↓', () => move(i, 1), false, i === steps.length - 1, `wf-down-${i}`, '下移'),
                    button('✕', () => del(i), false, steps.length <= 1, `wf-del-${i}`, '删除这个动作'),
                  ),
                  i < steps.length - 1
                    ? h('div', { style: { textAlign: 'center', color: C.muted, fontSize: 11, lineHeight: '10px' } }, '↓')
                    : null,
                )),
            h('div', { style: { marginTop: 8 } },
              button('＋ 新增动作', add, false, false, 'wf-add', '在该流程末尾追加一个动作')),
          )
        })(),

        // ===== v2.9.0：回话规则（直接进 system prompt，由 AI 按规则判断）=====
        h('div', {
          style: {
            marginTop: 12,
            padding: '10px 12px',
            borderRadius: 8,
            background: C.layer2,
            border: `1px solid ${C.brand}`,
          },
        },
          h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } },
            '回话规则（进提示词，AI 按它判断）'),
          h('div', { style: { fontSize: 11, color: C.muted, lineHeight: 1.6, marginBottom: 6 } },
            '这段会原样注入 system prompt，是「沟通」页回复的唯一依据。用自然语言写，AI 自己判断该不该发、该发哪一步。支持 {replyMaxChars} 变量。'),
          h('textarea', {
            style: { ...inputStyle, minHeight: 150, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' },
            value: typeof criteria.replyRules === 'string' ? criteria.replyRules : '',
            onChange: (e) => setCrit('replyRules', e.target.value),
            placeholder: '例：不要主动约面试；不要谈预算；拿不准就不回复…',
          }),
        ),

        // ===== v2.8.1：关键词兜底（可选，默认关闭）=====
        (() => {
          const rg = criteria.replyGuard || {}
          const setRg = (patch) => setCrit('replyGuard', { ...rg, ...patch })
          const wordBox = (key, label, hint, color) => h('div', { style: { marginTop: 8 } },
            h('div', { style: { fontSize: 11, color: color || C.muted, marginBottom: 3 } }, label),
            h('textarea', {
              style: { ...inputStyle, minHeight: 56, resize: 'vertical', lineHeight: 1.6 },
              value: Array.isArray(rg[key]) ? rg[key].join('、') : '',
              onChange: (e) => setRg({ [key]: splitList(e.target.value) }),
              placeholder: hint || '用「、」或换行分隔',
            }),
          )
          return h('div', {
            style: {
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 8,
              background: C.layer2,
              border: `1px solid ${C.border}`,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
              h('div', { style: { fontSize: 12, fontWeight: 600 } }, '关键词兜底（可选，默认关闭）'),
              h('div', { style: { flex: 1 } }),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.muted } },
                h('input', {
                  type: 'checkbox',
                  checked: rg.enabled === true,
                  onChange: (e) => setRg({ enabled: e.target.checked }),
                }),
                '启用关键词拦截',
              ),
            ),
            h('div', { style: { fontSize: 11, color: C.muted, lineHeight: 1.6 } },
              '回话该不该发由上面的「回话规则」交给 AI 判断。这里的词表只是可选的机械兜底：打开后，命中「禁止词」会被 checkReply 直接拦下，命中「提醒词」只提示。没打开时 checkReply 一律放行。'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
              h('div', { style: { fontSize: 11, color: C.muted } }, '单条字数上限'),
              h('input', {
                style: { ...inputStyle, width: 90 },
                type: 'number',
                value: rg.maxChars == null ? 80 : rg.maxChars,
                onChange: (e) => setRg({ maxChars: Number(e.target.value) || 0 }),
              }),
              h('div', { style: { fontSize: 11, color: C.muted } }, '字（超出即拦）'),
            ),
            wordBox('forbid', '禁止词（命中即拦，不允许发出去）',
              '如：面试时间、预算、给不到、保证、加微信、派驻周期', C.err),
            wordBox('softWarn', '提醒词（只提示，不拦）', '如：工资、加班、出差、试用期', C.warn),
            h('div', { style: { fontSize: 11, color: C.muted, marginTop: 6 } },
              '改完记得点下面的「保存到 Host」；也可用 config key=replyGuard 整体替换。'),
          )
        })(),

        // v2.8.0：底部再放一条保存栏 —— 改完话术不用滚回顶部找按钮
        h('div', {
          style: {
            position: 'sticky',
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 12,
            padding: '8px 10px',
            borderRadius: 8,
            background: C.layer2,
            border: `1px solid ${dirty ? C.warn : C.border}`,
          },
        },
          h('div', { style: { fontSize: 12, color: dirty ? C.warn : C.muted } },
            dirty ? '● 有未保存改动，记得点右边保存' : '与已保存内容一致'),
          h('div', { style: { flex: 1 } }),
          button(busy ? '保存中…' : '保存到 Host', save, true, busy),
          button('收起', onClose, false, busy),
        ),
      )
    }

    // ---------------------------------------------------------------- 主面板

    function Panel() {
      const [data, setData] = useState(null)
      const [jobId, setJobId] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      // v2.2：岗位设置面板改成按 jobId 打开 —— 下拉里任意岗位都能直接编辑
      const [settingsJobId, setSettingsJobId] = useState('')
      // v2.8.0：保存成功后 remount 一次岗位设置面板，重置「未保存改动」基线（面板不自动关闭，让人看得见已保存）
      const [settingsNonce, setSettingsNonce] = useState(0)
      // v2.2：岗位下拉菜单 / 新建岗位表单 / 删除二次确认
      const [jobMenuOpen, setJobMenuOpen] = useState(false)
      const [createOpen, setCreateOpen] = useState(false)
      const [createName, setCreateName] = useState('')
      const [createMode, setCreateMode] = useState('copy')
      const [deleteTarget, setDeleteTarget] = useState(null)
      const [saveError, setSaveError] = useState('')
      const [expanded, setExpanded] = useState('')
      const [notice, setNotice] = useState('')
      // ---- v2.6.1 SOP 抽屉 / 面试编辑 / 行选择 ----
      const [sopOpen, setSopOpen] = useState(false)
      const [sopData, setSopData] = useState(null)
      const [sopEditId, setSopEditId] = useState('')
      const [sopEditText, setSopEditText] = useState('')
      const [sopNewLesson, setSopNewLesson] = useState('')
      const [sopMsg, setSopMsg] = useState('')
      const [ivOpen, setIvOpen] = useState(false)
      const [ivNames, setIvNames] = useState([])
      const [ivForm, setIvForm] = useState({ time: '', window: '', location: '', address: '', interviewMode: '', contact: '', phone: '', link: '', extra: '', note: '' })
      const [ivPreview, setIvPreview] = useState('')
      const [ivMsg, setIvMsg] = useState('')
      const [selected, setSelected] = useState([])
      const [syncBusy, setSyncBusy] = useState(false)

      // 筛选 / 排序
      const [filterStage, setFilterStage] = useState('')
      const [salaryMaxK, setSalaryMaxK] = useState('')
      const [filterEdu, setFilterEdu] = useState('')
      const [filterCity, setFilterCity] = useState('')
      const [filterXuexin, setFilterXuexin] = useState('')
      // v2.1：匹配度下限 / 性价比等级
      const [techFitMin, setTechFitMin] = useState('')
      const [filterValueGrade, setFilterValueGrade] = useState('')
      const [q, setQ] = useState('')
      const [sort, setSort] = useState('seq')
      const [order, setOrder] = useState('asc')

      const refresh = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const res = await fetch(API, { cache: 'no-store' })
          if (!res.ok) {
            throw new Error(
              `台账接口返回 HTTP ${res.status}（${API}）—— Host 侧的 webServer 路由没注册上。` +
              '请确认 index.js 里 export const inject 含 "webServer"，并重装插件后刷新页面。',
            )
          }
          const json = await res.json()
          if (!json || !json.ok) throw new Error((json && json.error) || '读取台账失败')
          setData(json)
          setJobId((currentId) => {
            // 跨岗位视图是面板本地状态，写操作刷新后保持住
            if (currentId === ALL_JOBS) return ALL_JOBS
            if (currentId && (json.jobs || []).some((j) => j.id === currentId)) return currentId
            return json.activeJobId || ((json.jobs || [])[0] || {}).id || ''
          })
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      const post = useCallback(
        async (body) => {
          setBusy(true)
          setSaveError('')
          try {
            const res = await fetch(API, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            if (!res.ok) {
              throw new Error(
                `写接口返回 HTTP ${res.status}（${API}）—— Host 侧的 webServer 路由没注册上（或方法不被接受）。` +
                '请确认 index.js 里 export const inject 含 "webServer"，并重装插件后刷新页面。',
              )
            }
            const json = await res.json()
            if (!json || !json.ok) throw new Error((json && json.error) || '写入失败')
            await refresh()
            return json
          } catch (e) {
            const msg = String((e && e.message) || e)
            setSaveError(msg)
            throw e
          } finally {
            setBusy(false)
          }
        },
        [refresh],
      )

      const jobs = (data && data.jobs) || []
      const viewAll = jobId === ALL_JOBS

      // ================= v2.6.1 SOP 抽屉 =================
      const loadSop = useCallback(async () => {
        try {
          const r = await post({ action: 'sop', op: 'list' })
          setSopData(r)
        } catch (e) {
          setSopMsg('读取 SOP 失败：' + String((e && e.message) || e))
        }
      }, [post])

      const openSop = () => {
        setSopOpen(true)
        setSopEditId('')
        setSopEditText('')
        setSopMsg('')
        loadSop()
      }

      const editSopSection = async (id) => {
        setSopMsg('')
        try {
          const r = await post({ action: 'sop', op: 'get', id })
          setSopEditId(id)
          setSopEditText(r.body || '')
        } catch (e) {}
      }

      const saveSopSection = async () => {
        if (!sopEditId) return
        try {
          await post({ action: 'sop', op: 'set', id: sopEditId, text: sopEditText })
          setSopMsg('已保存「' + sopEditId + '」，下次会话立即生效')
          setSopEditId('')
          await loadSop()
        } catch (e) {}
      }

      const resetSopSection = async (id) => {
        try {
          await post({ action: 'sop', op: 'reset', id })
          setSopMsg('已恢复内置版本：' + id)
          setSopEditId('')
          await loadSop()
        } catch (e) {}
      }

      const addSopLesson = async () => {
        const s = sopNewLesson.trim()
        if (!s) return
        try {
          await post({ action: 'sop', op: 'learn', text: s })
          setSopNewLesson('')
          setSopMsg('已沉淀一条教训')
          await loadSop()
        } catch (e) {}
      }

      const removeSopLesson = async (id) => {
        try {
          await post({ action: 'sop', op: 'unlearn', id })
          await loadSop()
        } catch (e) {}
      }

      const handlePending = async (id, act) => {
        try {
          await post({ action: 'sop', op: act === 'accept' ? 'accept' : 'drop', id })
          setSopMsg(act === 'accept' ? '已固化为教训' : '已丢弃该观察')
          await loadSop()
        } catch (e) {}
      }

      // ================= v2.6.1 面试编辑 =================
      const currentJob = jobs.find((j) => j.id === jobId) || null
      const jobIv = (currentJob && currentJob.interview) || {}

      const openInterview = (rows) => {
        const list = Array.isArray(rows) ? rows : [rows]
        if (!list.length) return
        const first = list[0]
        const iv = (first && first.interview) || {}
        setIvNames(list.map((r) => r.name))
        setIvForm({
          time: iv.time || '',
          window: iv.window || '',
          location: iv.location || '',
          address: iv.address || '',
          interviewMode: iv.mode || '',
          contact: iv.contact || '',
          phone: iv.phone || '',
          link: iv.link || '',
          extra: iv.extra || '',
          note: iv.note || '',
        })
        setIvPreview('')
        setIvMsg(list.length > 1 ? '批量设置 ' + list.length + ' 人；留空的项继承岗位默认' : '留空的项继承岗位默认')
        setIvOpen(true)
      }

      const setIv = (k, v) => setIvForm((prev) => ({ ...prev, [k]: v }))

      const buildIvBody = (extra) => {
        const b = { action: 'interview', names: ivNames }
        if (!ivNames.length) return b
        for (const k of ['time', 'window', 'location', 'address', 'contact', 'phone', 'link', 'extra', 'note']) {
          if (String(ivForm[k] || '').trim()) b[k] = String(ivForm[k]).trim()
        }
        if (ivForm.interviewMode) b.interviewMode = ivForm.interviewMode
        return Object.assign(b, extra || {})
      }

      const previewInterview = async () => {
        try {
          const r = await post(buildIvBody({ dryRun: true }))
          const first = (r.results || [])[0]
          setIvPreview(first ? first.inviteText || '' : '')
          setIvMsg('预览（未写库）：共 ' + (r.count || 0) + ' 人')
        } catch (e) {}
      }

      const saveInterview = async () => {
        try {
          const r = await post(buildIvBody({}))
          setIvMsg('已设置 ' + (r.count || 0) + ' 人')
          setIvOpen(false)
          setNotice('面试参数已保存（' + (r.count || 0) + ' 人）')
          setSelected([])
        } catch (e) {}
      }

      // ================= v2.6.1 行选择 / 改状态 =================
      const STAGE_OPTIONS = [
        ['new', '新来信待处理'], ['greeted', '已打招呼'], ['inbound', '已回话'],
        ['qualified', '初筛通过'], ['resume_requested', '已索简历'], ['resume_received', '已收简历'],
        ['interview_pending', '待约面'], ['interview_available', '候选人给时间'],
        ['interview_scheduled', '已约面'], ['pending', '待定'], ['rejected', '已淘汰'], ['stale', '超期未回复'],
      ]
      const stageLabelOf = (s) => {
        const hit = STAGE_OPTIONS.find((x) => x[0] === s)
        return hit ? hit[1] : s
      }

      const toggleSelect = (key) => {
        setSelected((prev) => (prev.indexOf(key) >= 0 ? prev.filter((k) => k !== key) : prev.concat([key])))
      }

      // 注意：rows 在下方 useMemo 里定义，这里必须惰性求值，否则 TDZ 白屏
      const getSelectedRows = () => rows.filter((r) => selected.indexOf(r.key) >= 0)

      const changeStage = async (row, stage) => {
        if (!stage || stage === row.stage) return
        try {
          await post({ action: 'upsert', jobId: row.jobId, bossId: row.bossId, name: row.name, company: row.company, stage })
          setNotice('已把 ' + row.name + ' 改为「' + stageLabelOf(stage) + '」')
        } catch (e) {}
      }

      const batchChangeStage = async (stage) => {
        if (!getSelectedRows().length) return
        try {
          const list = getSelectedRows().map((r) => ({ action: 'upsert', jobId: r.jobId, bossId: r.bossId, name: r.name, company: r.company, stage }))
          const r = await post({ action: 'batch', batch: list })
          setNotice('已批量改为「' + stageLabelOf(stage) + '」：' + (r.count || 0) + ' 人')
          setSelected([])
        } catch (e) {}
      }
      const current = useMemo(() => jobs.find((j) => j.id === jobId) || null, [jobs, jobId])
      const activeJob = useMemo(
        () => jobs.find((j) => j.id === ((data && data.activeJobId) || '')) || null,
        [jobs, data],
      )
      const perJob = (data && data.perJob && data.perJob[jobId]) || null
      // 单岗位统计一律用 Host 算好的 perJob[jobId].stats（按岗位独立），跨岗位视图才本地汇总
      const stats = (perJob && perJob.stats) || null
      const settingsJob = useMemo(() => jobs.find((j) => j.id === settingsJobId) || null, [jobs, settingsJobId])
      const stageLabel = (data && data.stageLabel) || {}
      const rejectReasons = (data && data.rejectReasons) || {}
      const jobModes = (data && data.jobModes) || {}

      /** 某岗位的候选人条数（岗位下拉/删除确认里显示） */
      const jobCount = useCallback((id) => {
        const row = (((data && data.jobList) || []).find((x) => x.id === id))
        return row ? row.candidateCount : 0
      }, [data])

      /** 清掉筛选 / 排序 / 展开行 —— 切岗位时必须调用，避免拿上一个岗位的条件看新岗位 */
      const resetView = useCallback(() => {
        setExpanded('')
        setFilterStage('')
        setSalaryMaxK('')
        setFilterEdu('')
        setFilterCity('')
        setFilterXuexin('')
        setTechFitMin('')
        setFilterValueGrade('')
        setQ('')
        setSort('seq')
        setOrder('asc')
      }, [])

      /** v2.2：切岗位 = 换上下文 —— 列表 / 筛选 / 统计 / 排序全刷新 + 收起展开行 + 恢复该岗位的模式 */
      const switchJob = useCallback(async (nextId) => {
        setJobMenuOpen(false)
        if (!nextId || nextId === jobId) return
        setJobId(nextId)
        resetView()
        if (nextId === ALL_JOBS) {
          setNotice('已切到「全部岗位」视图（跨岗位只读：可筛选/排序/导出，写操作仍作用于当前岗位）')
          return
        }
        try {
          const res = await post({ action: 'selectJob', jobId: nextId })
          const modeText = res && res.mode ? `${MODE_ICON[res.mode] || ''} ${MODE_SHORT[res.mode] || res.mode}` : ''
          // 人数优先用 Host 返回的，缺了就用面板本地的岗位人数，避免提示成「0 条」
          const count = res && res.candidateCount != null ? res.candidateCount : jobCount(nextId)
          setNotice(`已切到岗位：${(res && res.job) || nextId}${modeText ? ` · 模式恢复为 ${modeText}` : ''}（${count} 条候选人）`)
        } catch {
          /* 错误已写入 saveError */
        }
      }, [jobId, post, resetView, jobCount])

      /** 切模式：只改当前岗位自己的模式，不动岗位、不碰别的岗位 */
      const switchMode = useCallback(async (mode) => {
        try {
          const res = await post({
            action: 'mode',
            mode,
            jobId: (data && data.activeJobId) || undefined,
          })
          setNotice(`已切换：${MODE_ICON[mode] || ''} ${MODE_SHORT[mode] || mode}${res && res.jobId ? `（岗位 ${res.jobId}）` : ''}`)
        } catch {
          /* 错误已写入 saveError */
        }
      }, [data, post])

      /** 新建岗位：名称 + 模板（复制当前岗位 / 空白默认模板） */
      const submitCreate = useCallback(async () => {
        const name = createName.trim()
        if (!name) {
          setSaveError('请先填写岗位名称')
          return
        }
        try {
          const res = await post({
            action: 'createJob',
            name,
            template: createMode,
            copyFromJobId: (data && data.activeJobId) || '',
          })
          setCreateOpen(false)
          setCreateName('')
          setCreateMode('copy')
          resetView()
          setJobId(res.jobId || '')
          setNotice(
            `已新建岗位：${name}（${res.template === 'blank' ? '空白默认模板' : `复制自 ${res.copiedFrom || '当前岗位'}`}）` +
            '，已自动切过去',
          )
        } catch {
          /* 错误已写入 saveError */
        }
      }, [createName, createMode, data, post, resetView])

      /** 删除岗位：确认后走 POST deleteJob（只删岗位定义，候选人记录保留） */
      const confirmDelete = useCallback(async () => {
        if (!deleteTarget) return
        try {
          const res = await post({ action: 'deleteJob', jobId: deleteTarget.id })
          setDeleteTarget(null)
          resetView()
          setNotice(
            `已删除岗位：${deleteTarget.name}；候选人记录保留 ${(res && res.orphanCandidates) || 0} 条` +
            '（不再归属岗位，列表与统计里不再显示）',
          )
        } catch {
          /* 错误已写入 saveError，确认框保留让用户看到原因 */
        }
      }, [deleteTarget, post, resetView])

      // v2.2：表格严格跟随当前岗位；仅「全部岗位」视图才跨岗位
      const jobRows = useMemo(() => {
        const all = (data && data.candidates) || []
        if (viewAll) return all.slice()
        return all.filter((r) => !jobId || r.jobId === jobId)
      }, [data, jobId, viewAll])

      // v2.2：「全部岗位」视图的统计（各岗位相加；单岗位统计一律用 Host 的 perJob[jobId].stats）
      const allStats = useMemo(() => {
        if (!viewAll || !data) return null
        const rowsAll = data.candidates || []
        const count = (fn) => rowsAll.filter(fn).length
        const total = rowsAll.length
        const greeted = count((r) => r.greetedAt)
        const replied = count((r) => r.repliedAt)
        const resume = count((r) => r.resumeAt || ['resume_received', 'interview_pending', 'interview_available', 'interview_scheduled'].includes(r.stage))
        const interview = count((r) => r.interviewAt || ['interview_available', 'interview_scheduled'].includes(r.stage))
        const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)
        const rejects = { city: 0, edu: 0, year: 0, direction: 0, salary: 0, freshgrad: 0, other: 0 }
        for (const r of rowsAll) {
          if (r.stage !== 'rejected') continue
          const key = r.rejectReason && rejects[r.rejectReason] != null ? r.rejectReason : 'other'
          rejects[key] += 1
        }
        return {
          total,
          funnel: { inbound: total, greeted, replied, resume, interview },
          rates: {
            greetRate: rate(greeted, total),
            replyRate: rate(replied, greeted),
            resumeRate: rate(resume, replied),
            interviewRate: rate(interview, resume),
          },
          rejects,
          starred: count((r) => r.starred),
        }
      }, [viewAll, data])
      const statsView = stats || allStats

      const rows = useMemo(() => {
        let list = jobRows.slice()
        if (filterStage) list = list.filter((r) => r.stage === filterStage)
        if (salaryMaxK !== '' && !Number.isNaN(Number(salaryMaxK))) {
          list = list.filter((r) => r.expectSalaryMinK == null || Number(r.expectSalaryMinK) <= Number(salaryMaxK))
        }
        if (filterEdu) list = list.filter((r) => String(r.edu || '').includes(filterEdu))
        if (filterCity) list = list.filter((r) => String(r.expectCity || '').includes(filterCity))
        if (filterXuexin) {
          list = list.filter((r) =>
            filterXuexin === '待核验' ? r.xuexinVerify === 'pending' : r.xuexinSelf === filterXuexin)
        }
        // v2.1：匹配度下限（NA 不参与）/ 性价比等级（NA 单独成档）
        if (techFitMin !== '' && !Number.isNaN(Number(techFitMin))) {
          list = list.filter((r) => r.techFitScore != null && Number(r.techFitScore) >= Number(techFitMin))
        }
        if (filterValueGrade) {
          list = list.filter((r) => (r.valueGrade || 'NA') === filterValueGrade)
        }
        if (q.trim()) {
          const needle = q.trim().toLowerCase()
          list = list.filter((r) =>
            `${r.name} ${r.company} ${(r.skills || []).join(' ')} ${r.note} ${r.keyInfo}`
              .toLowerCase()
              .includes(needle))
        }
        const dir = order === 'desc' ? -1 : 1
        const val = (r) => {
          switch (sort) {
            case 'seq': return Number(r.seq) || 0
            case 'updatedAt': return String(r.updatedAt || '')
            case 'firstSeenAt': return String(r.firstSeenAt || '')
            case 'greetedAt': return String(r.greetedAt || '')
            case 'gradYear': return Number(r.gradYear) || 0
            case 'workYears': return Number(r.workYears) || 0
            case 'expectSalaryMinK': return r.expectSalaryMinK == null ? -1 : Number(r.expectSalaryMinK)
            case 'matchScore': return (r.matchHits || []).length
            case 'techFitScore': return r.techFitScore == null ? -1 : Number(r.techFitScore)
            case 'valueScore': return r.valueScore == null ? -1 : Number(r.valueScore)
            case 'starred': return r.starred ? 1 : 0
            case 'stage': return STAGE_FILTERS.indexOf(r.stage)
            default: return Number(r.seq) || 0
          }
        }
        list.sort((a, b) => {
          const av = val(a)
          const bv = val(b)
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
          return String(av).localeCompare(String(bv)) * dir
        })
        return list
      }, [jobRows, filterStage, salaryMaxK, filterEdu, filterCity, filterXuexin, techFitMin, filterValueGrade, q, sort, order])

      const stageCounts = useMemo(() => {
        const by = {}
        for (const r of jobRows) by[r.stage] = (by[r.stage] || 0) + 1
        return by
      }, [jobRows])

      // v2.1：匹配度 / 性价比汇总（优先用 Host 的 stats.scores，缺了就本地算一遍）
      const localScores = useMemo(() => {
        const tf = []
        const v = []
        const grades = { S: 0, A: 0, B: 0, C: 0, D: 0, NA: 0 }
        for (const r of jobRows) {
          if (r.techFitScore != null && !Number.isNaN(Number(r.techFitScore))) tf.push(Number(r.techFitScore))
          if (r.valueScore != null && !Number.isNaN(Number(r.valueScore))) v.push(Number(r.valueScore))
          const g = r.valueGrade || (r.valueScore == null ? 'NA' : '')
          if (g && grades[g] != null) grades[g] += 1
        }
        const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null)
        return { avgTechFit: avg(tf), avgValue: avg(v), valueGrades: grades }
      }, [jobRows])
      const scores = (statsView && statsView.scores) || localScores

      const toggleSort = useCallback((key) => {
        setSort((prev) => {
          if (prev === key) {
            setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
            return prev
          }
          setOrder(key === 'updatedAt' ? 'desc' : 'asc')
          return key
        })
      }, [])

      const toggleStar = useCallback(async (row, event) => {
        event.stopPropagation()
        try {
          const res = await post({ action: 'star', jobId: row.jobId, bossId: row.bossId, starred: !row.starred })
          setNotice(`${row.name || row.bossId} ${res.starred ? '⭐ 已标为优先回捞' : '已取消 ⭐'}`)
        } catch {
          /* 错误已写入 saveError */
        }
      }, [post])

      const copyText = useCallback(async (text, label) => {
        try {
          await navigator.clipboard.writeText(text)
          setNotice(`已复制${label ? `：${label}` : ''}`)
        } catch (e) {
          setNotice(`复制失败：${String((e && e.message) || e)}`)
        }
      }, [])

      const exportBackup = useCallback(() => {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
        const a = document.createElement('a')
        a.href = `${API}?action=backup-export`
        a.download = `招聘流水线-完整备份-${stamp}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setNotice('正在下载完整备份：岗位、候选人、沟通记录、凭据、计数与流程配置都会包含')
      }, [])

      const importBackup = useCallback(async (event) => {
        const input = event.target
        const file = input.files && input.files[0]
        input.value = ''
        if (!file) return
        setSyncBusy(true)
        setSaveError('')
        try {
          const text = await file.text()
          const backup = JSON.parse(text)
          const summary = backup && backup.summary
          const okToImport = !window.confirm || window.confirm(
            `将合并导入这份备份：${summary ? `${summary.jobs} 个岗位、${summary.candidates} 位候选人、${summary.dialogs} 条沟通记录。` : ''}\n` +
            '会先自动备份本机台账，再按岗位+候选人 key 合并；不会上传远端。继续吗？',
          )
          if (!okToImport) return
          const res = await post({ action: 'backup-import', backup, replace: false })
          setNotice(`备份合并完成：新增 ${res.stats.added} 人，更新 ${res.stats.updated} 人；本机原台账已自动备份到 ${res.backupFile}`)
        } catch (e) {
          setSaveError(`导入失败：${String((e && e.message) || e)}；未导入的文件不是有效备份包或内容不完整`)
        } finally {
          setSyncBusy(false)
        }
      }, [post])

      const exportAs = useCallback(async (format) => {
        // v2.27.2：改走后端 export —— 列定义只有一份（Host 侧 exportRows），
        // 原先这里自己拼 22 列，与 Host 的 49 列长期不一致，
        // 「收简历时间 / 回话时间 / 面试链接」这类字段在面板导出里根本不存在。
        const title = viewAll
          ? '全部岗位'
          : ((current && current.criteria && current.criteria.jobTitle) || '候选人')
        setSaveError('')
        try {
          const res = await post({
            action: 'export',
            format,
            filterJob: viewAll ? 'all' : undefined,
          })
          if (!res || res.ok === false) {
            setSaveError(`导出失败：${(res && res.error) || '未知错误'}`)
            return
          }
          if (format === 'csv') {
            downloadText(`${title}-台账.csv`, res.csv, 'text/csv;charset=utf-8')
          } else {
            downloadText(`${title}-台账.md`, res.markdown, 'text/markdown;charset=utf-8')
          }
          setNotice(`已导出 ${res.count} 条（${String(format).toUpperCase()}）`)
        } catch (e) {
          setSaveError(`导出失败：${String((e && e.message) || e)}`)
        }
      }, [post, current, viewAll])

      // ------------------------------------------------ 子视图

      // v2.2：岗位下拉（每项支持编辑 / 删除）+ 「＋ 新建岗位」+ 「全部岗位」只读视图
      const renderJobPicker = () => {
        const label = viewAll
          ? `全部岗位（${(data && data.total) || 0}）`
          : (current ? `${current.name}（${jobCount(current.id)}）` : '未选择岗位')
        return h('div', { style: { position: 'relative' } },
          h('button', {
            type: 'button',
            title: '切换岗位 / 编辑 / 删除',
            onClick: () => setJobMenuOpen((v) => !v),
            style: {
              padding: '3px 10px',
              borderRadius: 7,
              fontSize: 12,
              cursor: 'pointer',
              color: C.text,
              background: C.layer2,
              border: `1px solid ${C.border}`,
              maxWidth: 300,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, `📁 ${label} ▾`),
          jobMenuOpen
            ? h('div', {
              style: {
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                zIndex: 60,
                width: 400,
                maxWidth: '92vw',
                background: C.layer1,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                padding: 6,
              },
            },
            h('div', { style: { fontSize: 11, color: C.muted, padding: '2px 6px 6px' } }, '切换岗位（每项可直接编辑 / 删除）'),
            ...jobs.map((j) => h('div', {
              key: `jobmenu-${j.id}`,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 4px',
                borderRadius: 6,
                background: j.id === jobId ? C.layer2 : 'transparent',
              },
            },
            h('button', {
              type: 'button',
              title: j.name,
              onClick: () => switchJob(j.id),
              style: {
                flex: 1,
                minWidth: 0,
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: C.text,
                fontSize: 12,
                padding: '2px 4px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, `${MODE_ICON[jobModes[j.id] || 'recruit'] || '🎯'} ${j.name}（${jobCount(j.id)}）`),
            button('编辑', () => { setJobMenuOpen(false); setSettingsJobId(j.id) }, false, false, `edit-${j.id}`, '改该岗位的口径/要点/话术'),
            button('删除', () => {
              setJobMenuOpen(false)
              setSaveError('')
              setDeleteTarget({ id: j.id, name: j.name, count: jobCount(j.id) })
            }, false, false, `del-${j.id}`, '删除该岗位定义（候选人记录保留）'),
            )),
            h('div', { style: { borderTop: `1px solid ${C.border}`, marginTop: 4, paddingTop: 4 } },
              h('button', {
                type: 'button',
                onClick: () => switchJob(ALL_JOBS),
                style: {
                  width: '100%',
                  textAlign: 'left',
                  background: viewAll ? C.layer2 : 'transparent',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: C.text,
                  fontSize: 12,
                  padding: '4px 6px',
                },
              }, `🌐 全部岗位（${(data && data.total) || 0}）· 跨岗位只读视图`)),
            h('div', { style: { borderTop: `1px solid ${C.border}`, marginTop: 4, paddingTop: 6, display: 'flex', gap: 6 } },
              button('＋ 新建岗位', () => { setJobMenuOpen(false); setSaveError(''); setCreateOpen(true) }, true, false, 'create-job'),
              button('编辑当前岗位', () => {
                setJobMenuOpen(false)
                setSettingsJobId((data && data.activeJobId) || '')
              }, false, !(data && data.activeJobId), 'edit-active'),
            ),
            )
            : null,
        )
      }

      // v2.2：顶部醒目上下文 —— 当前：<岗位名> · 🎯 招聘模式
      const renderContext = () => {
        const mode = (data && data.mode) || 'recruit'
        const name = viewAll ? '全部岗位（跨岗位只读视图）' : (current ? current.name : '—')
        return h('div', {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            marginBottom: 8,
            borderRadius: 9,
            background: C.layer1,
            border: `1px solid ${C.border2}`,
            fontSize: 12.5,
          },
        },
        h('span', { style: { color: C.muted } }, '当前：'),
        h('span', { style: { fontWeight: 700, fontSize: 13 } }, name),
        h('span', { style: { color: C.border2 } }, '·'),
        h('span', { style: { fontWeight: 700, color: C.brand } }, `${MODE_ICON[mode] || '🎯'} ${MODE_SHORT[mode] || '招聘模式'}`),
        viewAll
          ? h('span', { style: { color: C.warn, fontSize: 11 } }, '（只读：可筛选/排序/导出；写操作仍作用于当前岗位）')
          : null,
        h('div', { style: { flex: 1 } }),
        h('span', { style: { color: C.muted, fontSize: 11 } },
          `本岗 ${jobRows.length} 人 · 全局 ${(data && data.total) || 0} 人`),
        )
      }

      // v2.12.1：当前流程总览 —— 把正在生效的招聘流程 / 回话流程直接摆出来（只读）
      const renderFlowOverview = () => {
        if (viewAll) return null
        const jb = current || activeJob
        const wf = (jb && jb.criteria && jb.criteria.workflow) || {}
        const block = (key, title, tone) => {
          const steps = Array.isArray(wf[key]) ? wf[key] : []
          if (!steps.length) return null
          return h('div', { key: `flow-${key}`, style: { flex: '1 1 300px', minWidth: 280 } },
            h('div', { style: { fontSize: 11, fontWeight: 700, color: tone, marginBottom: 3 } },
              `${title} · ${steps.length} 步`),
            ...steps.map((s, i) => h('div', {
              key: `flow-${key}-${i}`,
              style: { display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 11.5, lineHeight: 1.75 },
            },
              h('span', { style: { color: C.muted, minWidth: 16, textAlign: 'right' } }, `${i + 1}.`),
              h('span', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, s.action || ''),
              s.text ? h('span', { style: { color: C.muted } }, `· ${s.text}`) : null,
            )),
          )
        }
        const rec = block('recruit', '招聘流程（推荐页）', C.brand)
        const rep = block('reply', '回话流程（沟通页）', C.warn)
        if (!rec && !rep) return null
        return h('div', {
          style: {
            marginBottom: 8,
            padding: '8px 12px',
            borderRadius: 9,
            background: C.layer1,
            border: `1px solid ${C.border}`,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, fontWeight: 700 } }, '当前流程'),
            jb ? h('span', { style: { fontSize: 10.5, color: C.muted } }, jb.name) : null,
            h('div', { style: { flex: 1 } }),
            h('span', { style: { fontSize: 10.5, color: C.muted } }, '改流程：岗位下拉 → 编辑当前岗位 → 工作流程'),
          ),
          h('div', { style: { display: 'flex', gap: 20, flexWrap: 'wrap' } }, rec, rep),
        )
      }

      // v2.2：新建岗位表单
      const renderCreateForm = () => {
        if (!createOpen) return null
        const radio = (key, label, desc) => h('label', {
          key: `cm-${key}`,
          style: {
            display: 'flex',
            gap: 6,
            alignItems: 'flex-start',
            cursor: 'pointer',
            padding: '6px 9px',
            borderRadius: 7,
            border: `1px solid ${createMode === key ? C.brand : C.border}`,
            background: createMode === key ? C.layer2 : 'transparent',
            flex: '1 1 280px',
            minWidth: 220,
          },
        },
        h('input', {
          type: 'radio',
          name: 'create-mode',
          checked: createMode === key,
          onChange: () => setCreateMode(key),
          style: { marginTop: 2 },
        }),
        h('span', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, label),
          h('span', { style: { fontSize: 11, color: C.muted, lineHeight: 1.5 } }, desc)))

        return h('div', {
          style: {
            margin: '10px 0 14px',
            padding: '12px 14px',
            borderRadius: 10,
            background: C.layer1,
            border: `1px solid ${C.border}`,
          },
        },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, '新建岗位'),
        h('div', { style: { maxWidth: 460 } },
          field('岗位名称（必填）', h('input', {
            style: { ...inputStyle, width: '100%' },
            value: createName,
            placeholder: '例如：Unity客户端开发（广州）',
            onChange: (e) => setCreateName(e.target.value),
          }), '会据此生成岗位 id（slug），并与已有岗位去重')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 } },
          h('div', { style: { fontSize: 11, color: C.muted } }, '要求模板（新建后会自动切到该岗位）'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            radio('copy', '从当前岗位复制要求',
              `复制「${(activeJob && activeJob.name) || '当前岗位'}」的口径 / 要点 / 话术，只把岗位名称换成新名字`),
            radio('blank', '空白默认模板',
              '按模板填充默认值，创建后逐项改（岗位、城市、薪资、技能都建议按实际需求调整）'),
          )),
        saveError ? h('div', { style: { color: C.err, fontSize: 12, marginTop: 8 } }, saveError) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
          button(busy ? '创建中…' : '创建', submitCreate, true, busy || !createName.trim(), 'do-create'),
          button('取消', () => { setCreateOpen(false); setCreateName(''); setSaveError('') }, false, busy, 'cancel-create'),
        ),
        )
      }

      // v2.2：删除岗位二次确认（显示候选人数量 + 明确提示记录保留）
      const renderDeleteConfirm = () => {
        if (!deleteTarget) return null
        const only = jobs.length <= 1
        return h('div', {
          style: {
            margin: '10px 0 14px',
            padding: '12px 14px',
            borderRadius: 10,
            background: C.layer1,
            border: `1px solid ${only ? C.warn : C.err}`,
          },
        },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, `确认删除岗位：${deleteTarget.name}`),
        h('div', { style: { fontSize: 12.5, lineHeight: 1.7 } },
          `该岗位下现有 `,
          h('span', { style: { fontWeight: 700, color: C.warn } }, String(deleteTarget.count)),
          ' 条候选人记录。'),
        h('div', { style: { fontSize: 12, color: C.muted, lineHeight: 1.7 } },
          '删除只删岗位定义（口径 / 要点 / 话术）：候选人记录保留在台账里，但不再归属岗位，列表与统计里都不再显示。'),
        only
          ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } },
            '这是最后一个岗位，禁止删除（删掉后当前岗位会悬空）。请先新建一个岗位再删。')
          : null,
        saveError ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, saveError) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
          button('确认删除', confirmDelete, true, busy || only, 'do-delete'),
          button('取消', () => { setDeleteTarget(null); setSaveError('') }, false, busy, 'cancel-delete'),
        ),
        )
      }

      const renderTop = () => h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 8 } },
        h('div', { style: { fontSize: 16, fontWeight: 600, marginRight: 4 } }, '招聘流水线'),
        renderJobPicker(),
        // 模式三按钮（只改当前岗位自己的模式）
        h('div', { style: { display: 'flex', gap: 4 } },
          MODE_OPTIONS.map(([key, label]) =>
            button(
              label,
              () => switchMode(key),
              (data && data.mode) === key,
              busy || viewAll,
              `mode-${key}`,
              '切模式不改岗位；每个岗位各自记住自己的模式',
            )),
        ),
        // 进度
        perJob
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
            h(ProgressBar, {
              label: '今日招呼',
              done: (perJob.quota && perJob.quota.done) || 0,
              target: (perJob.quota && perJob.quota.target) || 0,
            }),
            h(ProgressBar, {
              label: '本轮',
              done: (perJob.progress && perJob.progress.round && perJob.progress.round.done) || 0,
              target: (perJob.progress && perJob.progress.round && perJob.progress.round.target) || 15,
              tone: C.warn,
            }))
          : null,
        h('div', { style: { flex: 1 } }),
        selected.length > 0
          ? h('span', {
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 8,
              padding: '2px 8px', borderRadius: 7, background: C.layer2, border: `1px solid ${C.brand}`,
            },
          },
          h('span', { style: { color: C.brand, fontWeight: 700 } }, `已选 ${selected.length} 人`),
          button('设面试', () => openInterview(getSelectedRows()), true, busy),
          h('select', {
            value: '',
            title: '批量改状态',
            onChange: (e) => { const v = e.target.value; e.target.value = ''; if (v) batchChangeStage(v) },
            style: { fontSize: 11, padding: '2px 4px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.layer1, color: C.text },
          }, [h('option', { key: '', value: '' }, '批量改状态…')].concat(STAGE_OPTIONS.map(([v, l]) => h('option', { key: v, value: v }, l)))),
          button('清除', () => setSelected([]), false, false))
          : null,
        button('📋 SOP', openSop, false, busy || !data, 'sop', '查看/修改招聘 SOP 与沉淀的教训'),
        button(settingsJobId ? '岗位设置 ▲' : '岗位设置', () => setSettingsJobId(settingsJobId ? '' : ((data && data.activeJobId) || '')), false, busy || !data, 'settings'),
        button(busy ? '刷新中…' : '刷新', refresh, false, busy, 'refresh'),
      )

      const renderStats = () => {
        if (!statsView) return null
        const f = statsView.funnel || {}
        const r = statsView.rates || {}
        const funnelItem = (label, value, rate) => h(
          'span',
          { key: label, style: { display: 'inline-flex', alignItems: 'baseline', gap: 4 } },
          h('span', { style: { color: C.muted } }, label),
          h('span', { style: { fontWeight: 600 } }, String(value || 0)),
          rate == null ? null : h('span', { style: { color: C.muted, fontSize: 11 } }, `(${rate}%)`),
        )
        const arrow = (k) => h('span', { key: k, style: { color: C.muted } }, '→')
        return h(React.Fragment, null,
          h('div', {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
            padding: '6px 10px',
            marginBottom: 8,
            borderRadius: 8,
            background: C.layer1,
            border: `1px solid ${C.border}`,
            fontSize: 12,
          },
        },
        funnelItem('来信', f.inbound),
        arrow('a1'),
        funnelItem('招呼', f.greeted, r.greetRate),
        arrow('a2'),
        funnelItem('回话', f.replied, r.replyRate),
        arrow('a3'),
        funnelItem('简历', f.resume, r.resumeRate),
        arrow('a4'),
        funnelItem('约面', f.interview, r.interviewRate),
        h('span', { style: { width: 1, height: 14, background: C.border } }),
        h('span', { style: { color: C.muted } }, '淘汰原因'),
        ...['city', 'edu', 'year', 'direction', 'salary', 'freshgrad'].map((key) =>
          h('span', { key: `rj-${key}`, style: { color: C.muted } },
            `${rejectReasons[key] || key} ${(statsView.rejects && statsView.rejects[key]) || 0}`)),
        statsView.starred
          ? h('span', { style: { color: C.warn } }, `⭐ ${statsView.starred}`)
          : null,
        ),
        // v2.28.0：方向分漏斗（岗位配了 criteria.tracks 才有；未配置时 byTrack 为 null）
        statsView.byTrack
          ? h('div', {
              key: 'byTrack',
              style: {
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 10,
                padding: '6px 10px',
                marginBottom: 8,
                borderRadius: 8,
                background: C.layer1,
                border: `1px solid ${C.border}`,
                fontSize: 12,
              },
            },
            h('span', { style: { color: C.muted } }, '按方向'),
            ...Object.values(statsView.byTrack).map((t) =>
              h('span', { key: 'tk-' + t.key, style: { display: 'inline-flex', alignItems: 'baseline', gap: 6 } },
                chip(t.label, t.key === '__none' ? 'warn' : 'brand'),
                h('span', { style: { color: C.muted } },
                  `总 ${t.total} · 招呼 ${t.greeted} · 简历 ${t.resume} · 淘汰 ${t.rejected}` +
                  (t.avgTechFit == null ? '' : ` · 均分 ${t.avgTechFit}`)))),
          )
          : null,
        )
      }

      // v2.1：统计条第二行——平均匹配度 / 平均性价比 / 性价比等级分布
      const renderScoreStats = () => {
        if (!scores) return null
        const vg = scores.valueGrades || {}
        return h('div', {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
            padding: '5px 10px',
            marginBottom: 8,
            borderRadius: 8,
            background: C.layer1,
            border: `1px solid ${C.border}`,
            fontSize: 12,
          },
        },
        h('span', { style: { color: C.muted } }, '平均匹配度'),
        h('span', { style: { fontWeight: 600 } }, scores.avgTechFit == null ? '—' : String(scores.avgTechFit)),
        h('span', { style: { color: C.muted } }, '平均性价比'),
        h('span', { style: { fontWeight: 600 } }, scores.avgValue == null ? '—' : String(scores.avgValue)),
        h('span', { style: { width: 1, height: 14, background: C.border } }),
        h('span', { style: { color: C.muted } }, '性价比分布'),
        ...VALUE_GRADE_FILTERS.filter(Boolean).map((g) =>
          h('span', { key: `vg-${g}`, style: { color: GRADE_COLOR[g] || C.muted } },
            `${g} ${vg[g] || 0}`)),
        vg.NA
          ? h('span', { style: { color: C.muted, fontSize: 11 } }, `（NA ${vg.NA} 人：面议/未写薪资，不可评估）`)
          : null,
        )
      }

      const renderFilters = () => h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12 } },
        h('select', {
          style: inputStyle,
          value: filterStage,
          onChange: (e) => setFilterStage(e.target.value),
        },
        STAGE_FILTERS.map((key) =>
          h('option', { key: key || 'all', value: key },
            key === '' ? `全部状态（${jobRows.length}）` : `${stageLabel[key] || key}（${stageCounts[key] || 0}）`))),
        h('input', {
          style: { ...inputStyle, width: 110 },
          placeholder: '薪资上限 ≤K',
          value: salaryMaxK,
          onChange: (e) => setSalaryMaxK(e.target.value.replace(/[^\d.]/g, '')),
        }),
        h('select', {
          style: inputStyle,
          value: filterEdu,
          onChange: (e) => setFilterEdu(e.target.value),
        }, EDU_OPTIONS.map((e0) => h('option', { key: e0 || 'all', value: e0 }, e0 === '' ? '全部学历' : e0))),
        h('input', {
          style: { ...inputStyle, width: 90 },
          placeholder: '城市',
          value: filterCity,
          onChange: (e) => setFilterCity(e.target.value),
        }),
        h('select', {
          style: inputStyle,
          value: filterXuexin,
          onChange: (e) => setFilterXuexin(e.target.value),
        },
        ['', '可查', '不可查', '未说', '待核验'].map((v) =>
          h('option', { key: v || 'all', value: v }, v === '' ? '学信网：全部' : v))),
        // v2.1：匹配度下限 / 性价比等级筛选
        h('input', {
          style: { ...inputStyle, width: 96 },
          placeholder: '匹配度 ≥',
          title: '技术匹配度下限（0-100）',
          value: techFitMin,
          onChange: (e) => setTechFitMin(e.target.value.replace(/[^\d]/g, '')),
        }),
        h('select', {
          style: inputStyle,
          value: filterValueGrade,
          onChange: (e) => setFilterValueGrade(e.target.value),
        },
        VALUE_GRADE_FILTERS.map((g) =>
          h('option', { key: g || 'all', value: g },
            g === '' ? '性价比：全部' : g === 'NA' ? '性价比：NA 不可评估' : `性价比：${g}`))),
        h('input', {
          style: { ...inputStyle, width: 150 },
          placeholder: '关键词（姓名/公司/技能/备注）',
          value: q,
          onChange: (e) => setQ(e.target.value),
        }),
        h('select', {
          style: inputStyle,
          value: sort,
          onChange: (e) => setSort(e.target.value),
        }, SORT_OPTIONS.map(([key, label]) => h('option', { key, value: key }, `排序：${label}`))),
        button(order === 'asc' ? '↑ 升序' : '↓ 降序', () => setOrder((o) => (o === 'asc' ? 'desc' : 'asc')), false, false, 'order'),
        h('div', { style: { flex: 1 } }),
        button(syncBusy ? '导入中…' : '导入备份', () => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.json,application/json'
          input.onchange = importBackup
          input.click()
        }, false, syncBusy || busy, 'backup-import', '选择 A 机器导出的完整备份 JSON；先自动备份本机，再按岗位+候选人 key 合并'),
        button('导出备份', exportBackup, false, false, 'backup-export', '下载完整流水线备份：所有岗位、候选人、沟通记录、凭据、计数、SOP 与流程配置'),
        button('导出 CSV', () => exportAs('csv'), false, rows.length === 0, 'csv'),
        button('导出 Markdown', () => exportAs('markdown'), false, rows.length === 0, 'md'),
      )

      const headerCell = (label, sortKey, extraStyle) => h(
        'th',
        {
          key: label,
          onClick: sortKey ? () => toggleSort(sortKey) : undefined,
          style: {
            textAlign: 'left',
            padding: '5px 8px',
            fontWeight: 500,
            fontSize: 11,
            whiteSpace: 'nowrap',
            cursor: sortKey ? 'pointer' : 'default',
            color: sortKey && sort === sortKey ? C.brand : C.muted,
            ...extraStyle,
          },
        },
        label + (sortKey && sort === sortKey ? (order === 'asc' ? ' ↑' : ' ↓') : ''),
      )

      // v2.3：备注行内渲染 —— 单行截断（约 40 字）+ 原生 title 悬停看全文 + 截断时给「详细」入口
      const NOTE_MAX_CHARS = 40
      const noteCellOf = (row, isOpen) => {
        const raw = String(row.note == null ? '' : row.note)
        const flat = raw.replace(/\s+/g, ' ').trim()
        if (!flat) {
          // 备注为空：浅灰「—」，不占额外空间
          return h('td', {
            style: { padding: '4px 8px', color: C.muted, opacity: 0.55, whiteSpace: 'nowrap' },
          }, '—')
        }
        const truncated = flat.length > NOTE_MAX_CHARS
        const shown = truncated ? `${flat.slice(0, NOTE_MAX_CHARS)}…` : flat
        return h('td', {
          style: {
            padding: '4px 8px',
            color: C.muted,
            maxWidth: 260,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          },
          title: flat,
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', maxWidth: 260 } },
          h('span', {
            style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, shown),
          truncated
            ? h('button', {
              type: 'button',
              title: '展开查看完整备注',
              onClick: (e) => {
                // 不冒泡到整行点击，避免与「展开 / 收起」互相打架
                e.stopPropagation()
                setExpanded((prev) => (prev === row.key ? '' : row.key))
              },
              style: {
                flex: '0 0 auto',
                padding: '0 6px',
                borderRadius: 6,
                fontSize: 11,
                lineHeight: '16px',
                cursor: 'pointer',
                color: C.brand,
                background: 'transparent',
                border: `1px solid ${C.brand}`,
              },
            }, isOpen ? '收起' : '详细')
            : null,
        ))
      }

      const renderDetail = (row) => {
        // v2.2：跨岗位视图下 current 为空，按行自己的 jobId 找岗位（话术变量才对得上）
        const job = jobs.find((j) => j.id === row.jobId) || current || { criteria: {}, flow: [], highlights: [] }
        const rec = recommendStep(row, job)
        return h('tr', { key: `${row.key}-detail` },
          h('td', {
            // v2.2：跨岗位视图多一列「岗位」；v2.3：又多了「备注」列，colSpan 跟着变
            colSpan: viewAll ? 15 : 14,
            style: {
              padding: '10px 12px 14px',
              background: C.layer2,
              borderTop: `1px solid ${C.border}`,
              fontSize: 12,
            },
          },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16 } },
            // v2.3：备注较长时，在展开区顶部完整显示（行内只显示截断版）
            String(row.note || '').replace(/\s+/g, ' ').trim().length > NOTE_MAX_CHARS
              ? h('div', {
                style: {
                  flexBasis: '100%',
                  padding: '6px 9px',
                  borderRadius: 8,
                  background: C.layer1,
                  border: `1px solid ${C.border}`,
                },
              },
              h('div', { style: { color: C.muted, marginBottom: 3 } }, '完整备注'),
              h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, String(row.note)))
              : null,
            // 匹配分析
            h('div', { style: { minWidth: 240, flex: '1 1 320px' } },
              h('div', { style: { color: C.muted, marginBottom: 4 } }, '匹配分析'),
              (row.matchHits || []).length === 0 && (row.matchGaps || []).length === 0
                ? h('div', { style: { color: C.muted } }, '还没有跑过 evaluate（用 upsert/evaluate 生成）')
                : null,
              ...(row.matchHits || []).map((t, i) =>
                h('div', { key: `hit-${i}`, style: { color: C.ok, lineHeight: 1.6 } }, `✓ ${t}`)),
              ...(row.matchGaps || []).map((t, i) =>
                h('div', { key: `gap-${i}`, style: { color: C.err, lineHeight: 1.6 } }, `✗ ${t}`)),
            ),
            // v2.1：技术要求匹配度（分数 + 等级 + 命中/缺口）
            h('div', { style: { minWidth: 240, flex: '1 1 320px' } },
              h('div', { style: { color: C.muted, marginBottom: 4 } }, '技术要求匹配度'),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
                h('span', {
                  style: {
                    color: GRADE_COLOR[row.techFitGrade] || C.muted,
                    fontWeight: 600,
                    fontSize: 14,
                  },
                }, row.techFitScore == null ? '—' : String(row.techFitScore)),
                h('span', { style: { color: C.muted } }, '/ 100'),
                chip(
                  `${row.techFitGrade || 'NA'} ${row.techFitGradeLabel || '不可评估'}`,
                  GRADE_TONE[row.techFitGrade] || 'idle',
                  '必备技能40 + 加分技能20 + 项目关键词20 + 工程深度20',
                )),
              (row.techFitHits || []).length === 0 && (row.techFitGaps || []).length === 0
                ? h('div', { style: { color: C.muted } }, '还没有算过分（老数据刷新后自动补算）')
                : null,
              ...(row.techFitHits || []).map((t, i) =>
                h('div', { key: `tfhit-${i}`, style: { color: C.ok, lineHeight: 1.6 } }, `✓ ${t}`)),
              ...(row.techFitGaps || []).map((t, i) =>
                h('div', { key: `tfgap-${i}`, style: { color: C.err, lineHeight: 1.6 } }, `✗ ${t}`)),
            ),
            // v2.1：性价比（分数 + 等级 + 成本比算式）
            h('div', { style: { minWidth: 220, flex: '1 1 260px' } },
              h('div', { style: { color: C.muted, marginBottom: 4 } }, '性价比'),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
                h('span', {
                  style: {
                    color: GRADE_COLOR[row.valueGrade] || C.muted,
                    fontWeight: 600,
                    fontSize: 14,
                  },
                }, row.valueScore == null ? '—' : String(row.valueScore)),
                row.valueScore == null ? null : h('span', { style: { color: C.muted } }, '/ 100'),
                chip(
                  `${row.valueGrade || 'NA'} ${row.valueGradeLabel || '不可评估'}`,
                  GRADE_TONE[row.valueGrade] || 'idle',
                  'valueScore = round(匹配度 ÷ 成本比 × 0.8)',
                )),
              h('div', { style: { color: C.muted, lineHeight: 1.6 } },
                row.valueScore == null
                  ? '期望薪资缺失或面议 → 不可评估（NA，不当作低性价比）'
                  : `期望下限 ${row.expectSalaryMinK == null ? '—' : row.expectSalaryMinK} K ÷ 预算中值 ` +
                    `${row.valueBudgetMidK == null ? '—' : row.valueBudgetMidK} K = 成本比 ` +
                    `${row.valueCostRatio == null ? '—' : row.valueCostRatio}`),
            ),
            // 备注 / 要点
            h('div', { style: { minWidth: 200, flex: '1 1 260px' } },
              h('div', { style: { color: C.muted, marginBottom: 4 } }, '备注'),
              h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, row.note || '—'),
              h('div', { style: { color: C.muted, margin: '8px 0 4px' } }, '要点'),
              h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, row.keyInfo || '—'),
              h('div', { style: { color: C.muted, margin: '8px 0 4px' } }, '标签'),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                (row.skills || []).length
                  ? row.skills.map((s, i) => h('span', {
                    key: `sk-${i}`,
                    style: {
                      padding: '0 6px',
                      borderRadius: 6,
                      border: `1px solid ${C.border}`,
                      color: C.muted,
                      fontSize: 11,
                    },
                  }, s))
                  : h('span', { style: { color: C.muted } }, '—')),
            ),
            // 对话记录 + 话术
            h('div', { style: { minWidth: 240, flex: '1 1 320px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
                h('span', { style: { color: C.muted } }, '对话记录'),
                h('div', { style: { flex: 1 } }),
                rec
                  ? button(`复制话术（${rec.name}）`, () => copyText(rec.text, rec.name), true, false, 'copy-tpl')
                  : h('span', { style: { color: C.muted } }, '当前阶段无推荐话术'),
              ),
              (row.dialogLog || []).length === 0
                ? h('div', { style: { color: C.muted } }, '暂无对话记录')
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  row.dialogLog.map((e, i) =>
                    h('div', {
                      key: `dl-${i}`,
                      style: {
                        paddingLeft: 8,
                        borderLeft: `2px solid ${e.dir === 'out' ? C.brand : C.ok}`,
                        lineHeight: 1.55,
                      },
                    },
                    h('div', { style: { color: C.muted, fontSize: 11 } },
                      `${e.atLocal || e.at || ''} ${e.dir === 'out' ? '我方发出' : '候选人'}`),
                    h('div', { style: { whiteSpace: 'pre-wrap' } }, e.summary || e.text || ''),
                    ))),
            ),
          ),
        ))
      }

      // ------------------------------------------------ 渲染

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflow: 'auto',
            padding: '14px 18px 40px',
            background: C.base,
            color: C.text,
            fontSize: 12,
          },
        },
        renderTop(),
        renderContext(),
        renderFlowOverview(),
        renderCreateForm(),
        renderDeleteConfirm(),

        // ================= v2.6.1 SOP 抽屉 =================
        sopOpen
          ? h('div', {
            style: {
              position: 'fixed', right: 0, top: 0, bottom: 0, width: 620, maxWidth: '96vw',
              background: C.base, borderLeft: `1px solid ${C.border}`,
              boxShadow: '-8px 0 24px rgba(0,0,0,.28)',
              zIndex: 9000, display: 'flex', flexDirection: 'column',
            },
          },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${C.border}` },
          },
          h('span', { style: { fontWeight: 700, fontSize: 13 } }, '📋 招聘 SOP'),
          h('span', { style: { color: C.muted, fontSize: 11 } },
            sopData
              ? `${(sopData.sections || []).length} 节 · ${sopData.lessonCount || 0} 条教训 · ${sopData.pendingCount || 0} 条待审`
              : '加载中…'),
          h('div', { style: { flex: 1 } }),
          sopMsg ? h('span', { style: { color: C.brand, fontSize: 11 } }, sopMsg) : null,
          button('刷新', loadSop, false, false),
          button('关闭', () => setSopOpen(false), false, false)),
          h('div', { style: { flex: 1, overflow: 'auto', padding: '10px 14px' } },
            ((sopData && sopData.sections) || []).map((sec) => h('div', {
              key: sec.id,
              style: { border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8, background: C.layer1, overflow: 'hidden' },
            },
            h('div', {
              style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: C.layer2, cursor: 'pointer' },
              onClick: () => { if (sopEditId === sec.id) setSopEditId(''); else editSopSection(sec.id) },
            },
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, sec.title),
            h('span', { style: { color: C.muted, fontSize: 10 } }, `${sec.chars} 字${sec.builtin ? ' · 内置' : ' · 自定义'}`),
            h('div', { style: { flex: 1 } }),
            h('span', { style: { color: C.brand, fontSize: 11 } }, sopEditId === sec.id ? '收起 ▲' : '编辑 ▼')),
            sopEditId === sec.id
              ? h('div', { style: { padding: 10 } },
                h('textarea', {
                  value: sopEditText,
                  onChange: (e) => setSopEditText(e.target.value),
                  rows: 12,
                  style: {
                    width: '100%', boxSizing: 'border-box', fontSize: 12, lineHeight: 1.6,
                    padding: 8, borderRadius: 6, border: `1px solid ${C.border}`,
                    background: C.base, color: C.text, fontFamily: 'inherit', resize: 'vertical',
                  },
                }),
                h('div', { style: { color: C.muted, fontSize: 10, margin: '4px 0 6px', lineHeight: 1.5 } },
                  '可用变量：{eduMin} {gradYearMin} {workYearMin} {cityWhitelist} {mustSkills} {rejectSkills} {projectKeywords} {plusSkills} {starTokens} {expectSalaryMinCapK} {greetQuotaPerDay} {roundGreetSize}'),
                h('div', { style: { display: 'flex', gap: 6 } },
                  button('保存', saveSopSection, true, false),
                  button('恢复内置', () => resetSopSection(sec.id), false, false),
                  button('取消', () => setSopEditId(''), false, false)))
              : null)),
            h('div', { style: { marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 10 } },
              h('div', { style: { fontSize: 12, fontWeight: 700, marginBottom: 6 } },
                `📌 沉淀的教训（${sopData ? (sopData.lessons || []).length : 0}）`),
              h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
                h('input', {
                  type: 'text',
                  value: sopNewLesson,
                  placeholder: '一句话教训，越具体越有用（下次会话自动进提示词）',
                  onChange: (e) => setSopNewLesson(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') addSopLesson() },
                  style: { flex: 1, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.layer1, color: C.text },
                }),
                button('沉淀', addSopLesson, true, false)),
              ((sopData && sopData.lessons) || []).map((l) => h('div', {
                key: l.id,
                style: { display: 'flex', gap: 6, alignItems: 'flex-start', padding: '5px 8px', marginBottom: 4, borderRadius: 6, background: C.layer1, border: `1px solid ${C.border}` },
              },
              h('span', { style: { flex: 1, fontSize: 11.5, lineHeight: 1.6 } }, l.text),
              h('span', { style: { color: C.muted, fontSize: 10, whiteSpace: 'nowrap' } }, `命中 ${l.hits || 0}`),
              h('button', {
                type: 'button',
                title: '删除这条教训',
                onClick: () => removeSopLesson(l.id),
                style: { padding: '0 6px', borderRadius: 5, fontSize: 11, cursor: 'pointer', color: C.warn, background: 'transparent', border: `1px solid ${C.warn}` },
              }, '删')))),
            ((sopData && sopData.pending) || []).length
              ? h('div', { style: { marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 10 } },
                h('div', { style: { fontSize: 12, fontWeight: 700, marginBottom: 6, color: C.warn } },
                  `🔍 待沉淀观察（${(sopData.pending || []).length}）`),
                (sopData.pending || []).map((x) => h('div', {
                  key: x.id,
                  style: { padding: '6px 8px', marginBottom: 6, borderRadius: 6, background: C.layer1, border: `1px dashed ${C.warn}` },
                },
                h('div', { style: { fontSize: 11.5, lineHeight: 1.6, marginBottom: 4 } }, x.text),
                h('div', { style: { display: 'flex', gap: 6 } },
                  button('固化为教训', () => handlePending(x.id, 'accept'), true, false),
                  button('丢弃', () => handlePending(x.id, 'drop'), false, false)))))
              : null))
          : null,

        // ================= v2.6.1 面试参数弹层 =================
        ivOpen
          ? h('div', {
            style: {
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,.42)', zIndex: 9500,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
            onClick: () => setIvOpen(false),
          },
          h('div', {
            onClick: (e) => e.stopPropagation(),
            style: {
              width: 580, maxWidth: '94vw', maxHeight: '90vh', overflow: 'auto',
              background: C.base, borderRadius: 10, border: `1px solid ${C.border}`, padding: 14,
            },
          },
          h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 4 } },
            '面试参数 · ' + (ivNames.length > 1 ? `批量 ${ivNames.length} 人` : (ivNames[0] || ''))),
          h('div', { style: { color: C.muted, fontSize: 11, marginBottom: 10 } }, ivMsg || '留空的项继承岗位默认'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
            h('div', null,
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '面试时间'),
              h('input', { type: 'text', value: ivForm.time, placeholder: '如 2026-10-23 14:30', onChange: (e) => setIv('time', e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.layer1, color: C.text, fontFamily: 'inherit' } })),
            h('div', null,
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '候选人给的时间窗'),
              h('input', { type: 'text', value: ivForm.window, placeholder: '如 周三周四都可以', onChange: (e) => setIv('window', e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.layer1, color: C.text, fontFamily: 'inherit' } })),
            h('div', null,
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '面试方式'),
              h('select', {
                value: ivForm.interviewMode,
                onChange: (e) => setIv('interviewMode', e.target.value),
                style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.layer1, color: C.text, fontFamily: 'inherit' },
              },
              h('option', { value: '' }, '（继承岗位默认：' + (jobIv.mode === 'phone' ? '电话' : jobIv.mode === 'video' ? '视频' : '现场') + '）'),
              h('option', { value: 'onsite' }, '现场面试'),
              h('option', { value: 'phone' }, '电话面试'),
              h('option', { value: 'video' }, '视频面试'))),
            h('div', null,
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '地点（留空继承岗位默认）'),
              h('input', { type: 'text', value: ivForm.location, placeholder: jobIv.location || '如 深圳市南山区高新园', onChange: (e) => setIv('location', e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.layer1, color: C.text, fontFamily: 'inherit' } })),
            h('div', null,
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '详细地址'),
              h('input', { type: 'text', value: ivForm.address, placeholder: jobIv.address || '楼栋/楼层/会议室', onChange: (e) => setIv('address', e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.layer1, color: C.text, fontFamily: 'inherit' } })),
            h('div', null,
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '联系人'),
              h('input', { type: 'text', value: ivForm.contact, placeholder: jobIv.contact || '（继承岗位默认）', onChange: (e) => setIv('contact', e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.layer1, color: C.text, fontFamily: 'inherit' } })),
            h('div', null,
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '联系电话'),
              h('input', { type: 'text', value: ivForm.phone, placeholder: jobIv.phone || '（继承岗位默认）', onChange: (e) => setIv('phone', e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.layer1, color: C.text, fontFamily: 'inherit' } })),
            h('div', { style: { gridColumn: '1 / -1' } },
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '视频会议链接（视频面试才需要）'),
              h('input', { type: 'text', value: ivForm.link, placeholder: jobIv.link || '留空则话术里不出现这行', onChange: (e) => setIv('link', e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.layer1, color: C.text, fontFamily: 'inherit' } })),
            h('div', { style: { gridColumn: '1 / -1' } },
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '附加说明'),
              h('input', { type: 'text', value: ivForm.extra, placeholder: jobIv.extra || '如 请提前10分钟到，带身份证', onChange: (e) => setIv('extra', e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.layer1, color: C.text, fontFamily: 'inherit' } }))),
          ivPreview
            ? h('div', { style: { marginTop: 10 } },
              h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '邀约话术预览（不会写库）'),
              h('pre', {
                style: {
                  margin: 0, padding: 8, borderRadius: 6, background: C.layer1,
                  border: `1px solid ${C.border}`, fontSize: 11.5, lineHeight: 1.7,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.text, fontFamily: 'inherit',
                },
              }, ivPreview))
            : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' } },
            button('预览话术', previewInterview, false, false),
            button('保存', saveInterview, true, false),
            button('取消', () => setIvOpen(false), false, false))))
          : null,


        settingsJob
          ? h(JobSettings, {
            key: `settings-${settingsJob.id}-${settingsNonce}`,
            job: settingsJob,
            busy,
            error: saveError,
            onSave: async (payload) => {
              try {
                await post(payload)
                setSettingsNonce((n) => n + 1)
                setNotice(`岗位设置已保存：${payload.name || settingsJob.name}`)
              } catch {
                /* 已提示 */
              }
            },
            onCancel: () => setSettingsJobId(''),
          })
          : null,

        (data && data.jobs && data.jobs.length > 1)
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
            jobs.map((j) =>
              button(`${MODE_ICON[jobModes[j.id] || 'recruit'] || ''} ${j.name} (${jobCount(j.id)})`,
                () => switchJob(j.id),
                jobId === j.id, false, `job-${j.id}`, '切到该岗位')),
            button(`🌐 全部岗位 (${(data && data.total) || 0})`, () => switchJob(ALL_JOBS), viewAll, false, 'job-all', '跨岗位只读视图'))
          : null,

        error
          ? h('div', {
            style: {
              margin: '8px 0',
              padding: '8px 10px',
              borderRadius: 8,
              color: C.err,
              border: `1px solid ${C.err}`,
              background: C.layer1,
              lineHeight: 1.6,
            },
          }, error)
          : null,

        notice
          ? h('div', {
            style: { margin: '6px 0', padding: '5px 10px', borderRadius: 8, color: C.muted, background: C.layer1, border: `1px solid ${C.border}` },
          }, notice)
          : null,

        h('style', null, [
          '.br-table th{font-weight:600;font-size:12px;color:#666}',
          '.br-table{min-width:1180px}',
          // v2.22.0：新增「收简历时间」列（表尾），给固定宽度避免挤压其它列
          '.br-table th:last-child{width:112px}',
          '.br-table td,.br-table th{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}',
          '.br-table td:nth-child(6),.br-table td:nth-child(7),.br-table td:nth-child(8),.br-table td:nth-child(10){text-align:center}',
          // v2.19.3：窄列只留 1-3 个字的宽度；姓名/公司/备注 给足或自适应
          '.br-table th:nth-child(1){width:26px}',
          '.br-table th:nth-child(2){width:52px}',
          '.br-table th:nth-child(3){width:84px}',
          '.br-table th:nth-child(4){width:260px}',
          '.br-table th:nth-child(5){width:92px}',
          '.br-table th:nth-child(6){width:42px}',
          '.br-table th:nth-child(7){width:54px}',
          '.br-table th:nth-child(8){width:42px}',
          '.br-table th:nth-child(9){width:62px}',
          '.br-table th:nth-child(10){width:42px}',
          '.br-table th:nth-child(11){width:110px}',
          '.br-table th:nth-child(12){width:98px}',
          '.br-table th:nth-child(13){width:80px}',
          '.br-table th:nth-child(14){width:80px}',
          '.br-table th:nth-child(15){width:50px}',
          '.br-table th:nth-child(16){width:50px}',
          '.br-table th:nth-child(17){width:120px}',
        ].join('')),
        renderStats(),
        renderScoreStats(),
        renderFilters(),

        !data
          ? h('div', { style: { color: C.muted, padding: '40px 0' } }, '读取中…')
          : rows.length === 0
            ? h('div', {
              style: {
                color: C.muted,
                padding: '40px 0',
                textAlign: 'center',
                border: `1px dashed ${C.border2}`,
                borderRadius: 10,
              },
            }, jobRows.length === 0
              ? (viewAll
                ? '全部岗位下都没有候选人记录。'
                : '这个岗位的台账还是空的。让 Agent 跑一轮「推荐牛人 → 筛简历 → 打招呼」，候选人会自动落到这里。')
              : '当前筛选条件下没有候选人，放宽筛选试试。')
            : h('div', { style: { width: '100%', overflowX: 'auto', overflowY: 'hidden' } },
            h('table', {
              style: {
                width: '100%',             // v2.19.2：固定布局，列宽受控，超长内容省略号
                borderCollapse: 'separate',
                borderSpacing: 0,
                tableLayout: 'fixed',
                className: 'br-table',
                background: C.layer1,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                fontSize: 12,
                whiteSpace: 'nowrap',
              },
            },
            h('thead', null,
              h('tr', { style: { background: C.layer2 } },
                h('th', { style: { width: 26, padding: '4px 6px', background: C.layer2 } },
                  h('input', {
                    type: 'checkbox',
                    title: '全选当前列表',
                    checked: rows.length > 0 && selected.length === rows.length,
                    onChange: (e) => setSelected(e.target.checked ? rows.map((r) => r.key) : []),
                  })),
                headerCell('序号 ⭐', 'seq', { width: 66 }),
                headerCell('姓名'),
                headerCell('公司'),
                // v2.2：跨岗位视图才多一列「岗位」
                viewAll ? headerCell('岗位') : null,
                headerCell('人员状态'),
                // v2.28.0：方向分类（岗位配了 criteria.tracks 才有值，否则整列都是 —）
                headerCell('方向'),
                headerCell('学历'),
                headerCell('毕业年份', 'gradYear'),
                headerCell('工作年限', 'workYears'),
                headerCell('期望薪资', 'expectSalaryMinK'),
                headerCell('期望城市'),
                headerCell('毕业学校'),
                headerCell('手机号'),
                headerCell('最后发言'),
                headerCell('学信网'),
                headerCell('匹配度', 'techFitScore'),
                headerCell('性价比', 'valueScore'),
                // v2.3：备注行内可见（截断显示 + title 看全文 + 「详细」展开）
                headerCell('备注'),
                headerCell('面试', 'interviewAt'),
                headerCell('状态', 'stage'),
                headerCell('更新日期', 'updatedAt'),
                // v2.22.0：简历接收时间（阶段转 resume_received 的时刻）
                headerCell('收简历时间'),
              )),
            h('tbody', null,
              rows.map((row) => {
                const isOpen = expanded === row.key
                return h(React.Fragment, { key: row.key },
                  h('tr', {
                    onClick: () => setExpanded(isOpen ? '' : row.key),
                    style: {
                      borderTop: `1px solid ${C.border}`,
                      cursor: 'pointer',
                      background: isOpen ? C.layer2 : 'transparent',
                    },
                  },
                  h('td', { style: { padding: '4px 8px' }, onClick: (e) => e.stopPropagation() },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.indexOf(row.key) >= 0,
                      onChange: () => toggleSelect(row.key),
                    })),
                  h('td', { style: { padding: '4px 8px', color: C.muted, whiteSpace: 'nowrap' } },
                    h('span', {
                      onClick: (e) => toggleStar(row, e),
                      title: row.starred ? '取消 ⭐' : '标为优先回捞',
                      style: { cursor: 'pointer', color: row.starred ? C.warn : C.idle, marginRight: 4 },
                    }, row.starred ? '⭐' : '☆'),
                    row.seq || '—'),
                  h('td', { style: { padding: '4px 10px', fontWeight: 500, whiteSpace: 'nowrap' }, title: row.name || '' }, row.name || '—'),
                  h('td', { style: { padding: '4px 10px', color: C.muted, minWidth: 140, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: row.company || '' }, row.company || '—'),
                  viewAll
                    ? h('td', { style: { padding: '4px 8px', color: C.brand, whiteSpace: 'nowrap' }, title: row.jobName || '' }, row.jobName || '—')
                    : null,
                  h('td', {
                    style: {
                      padding: '4px 10px',
                      whiteSpace: 'nowrap',
                      fontWeight: 500,
                      color: row.status7 === 'qualified' ? C.ok
                        : row.status7 === 'unqualified' ? C.err
                        : row.status7 === 'resumeGiven' ? C.brand
                        : row.status7 === 'interviewDone' ? C.ok
                        : row.status7 === 'hold' ? C.warn
                        : C.muted,
                    },
                    title: row.stageLabel || '',
                  }, row.status7Label || row.stageLabel || '—'),
                  // v2.28.0：方向徽标
                  h('td', { style: { padding: '4px 8px', whiteSpace: 'nowrap' } },
                    row.trackLabel
                      ? chip(row.trackLabel, row.trackAuto === 'member' ? 'brand' : row.trackAuto === 'community' ? 'ok' : 'warn',
                          row.trackAuto ? '按关键词自动判定' : '人工/自报方向')
                      : h('span', { style: { color: C.idle }, title: '三个方向关键词都没命中，建议问一句' }, '—')),
                  h('td', { style: { padding: '4px 8px', color: C.muted }, title: row.edu || '' }, row.edu || '—'),
                  h('td', { style: { padding: '4px 8px', color: C.muted } }, row.gradYear == null ? '—' : row.gradYear),
                  h('td', { style: { padding: '4px 8px', color: C.muted } }, row.workYears == null ? '—' : row.workYears),
                  h('td', { style: { padding: '4px 8px', color: C.muted, whiteSpace: 'nowrap' }, title: row.expectSalary || '' }, row.expectSalary || '—'),
                  h('td', { style: { padding: '4px 10px', color: C.muted, whiteSpace: 'nowrap' }, title: row.expectCity || '' }, row.expectCity || '—'),
                  h('td', { style: { padding: '4px 10px', color: C.muted, minWidth: 130, maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: row.school || '' }, row.school || '—'),
                  h('td', { style: { padding: '4px 10px', color: C.muted, whiteSpace: 'nowrap' }, title: row.phone || '' }, row.phone || '—'),
                  h('td', { style: { padding: '4px 10px', color: C.muted, minWidth: 96, whiteSpace: 'nowrap' }, title: `${row.lastTalkAt || ''} ${row.lastTalkText || ''}`,
                  }, row.lastSpeaker ? `${row.lastSpeaker}${row.msgCount ? ' · ' + row.msgCount + '条' : ''}` : '—'),
                  h('td', { style: { padding: '4px 8px' } },
                    chip(row.xuexinSelf || '未说', row.xuexinSelf === '可查' ? 'ok' : 'warn',
                      row.xuexinVerify === 'verified' ? '已人工核验' : row.xuexinVerify === 'failed' ? '核验不符' : '待人工核验')),
                  h('td', { style: { padding: '4px 8px' }, title: row.techFitGradeLabel || '' },
                    scoreText(row.techFitScore, row.techFitGrade)),
                  h('td', { style: { padding: '4px 8px' }, title: row.valueGradeLabel || '' },
                    scoreText(row.valueScore, row.valueGrade)),
                  noteCellOf(row, isOpen),
                  h('td', { style: { padding: '4px 8px', whiteSpace: 'nowrap' }, onClick: (e) => e.stopPropagation() },
                    h('button', {
                      type: 'button',
                      onClick: () => openInterview(row),
                      title: (row.interview && row.interview.time)
                        ? `${row.interview.time} · ${row.interview.mode || '继承方式'} · ${row.interview.location || '继承地点'}`
                        : '点击设置面试时间/地点/方式',
                      style: {
                        padding: '1px 6px',
                        borderRadius: 6,
                        fontSize: 11,
                        cursor: 'pointer',
                        background: (row.interview && row.interview.time) ? C.brand : 'transparent',
                        color: (row.interview && row.interview.time) ? '#fff' : C.muted,
                        border: `1px solid ${(row.interview && row.interview.time) ? C.brand : C.border}`,
                        whiteSpace: 'nowrap',
                      },
                    }, (row.interview && row.interview.time) ? row.interview.time : '设置')),
                  h('td', { style: { padding: '4px 8px' }, onClick: (e) => e.stopPropagation() },
                    h('select', {
                      value: row.stage,
                      title: row.nextStep || '',
                      onChange: (e) => changeStage(row, e.target.value),
                      style: {
                        fontSize: 11,
                        padding: '2px 4px',
                        borderRadius: 6,
                        border: `1px solid ${C.border}`,
                        background: C.layer2,
                        color: C.text,
                        cursor: 'pointer',
                        maxWidth: 132,
                      },
                    }, STAGE_OPTIONS.map(([v, label]) => h('option', { key: v, value: v }, label))),
                    row.rejectReasonLabel
                      ? h('div', { style: { fontSize: 10, color: C.warn, marginTop: 2 } }, '淘汰：' + row.rejectReasonLabel)
                      : (row.nextStep ? h('div', { style: { fontSize: 10, color: C.muted, marginTop: 2, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: row.nextStep }, row.nextStep) : null)),
                  h('td', { style: { padding: '4px 8px', color: C.muted, whiteSpace: 'nowrap', fontSize: 11 } }, row.updatedAtLocal || '—'),
                  h('td', { style: { padding: '4px 8px', color: C.muted, whiteSpace: 'nowrap', fontSize: 11 }, title: row.resumeAt || '' }, fmtResumeAt(row.resumeAt)),
                  ),
                  isOpen ? renderDetail(row) : null,
                )
              })),
            ),
      ))
    }

    // ---------------------------------------------------------------- 侧栏图标

    function SidebarEntry({ size = 20, active = false }) {
      const edge = Number(size) > 0 ? Number(size) : 20
      return h(
        'svg',
        {
          viewBox: '0 0 64 64',
          width: edge,
          height: edge,
          role: 'img',
          'aria-label': '招聘流水线',
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        h('rect', { x: 3, y: 3, width: 58, height: 58, rx: 15, fill: active ? C.brand : C.muted }),
        h('path', {
          d: 'M17 21h30M17 31h30M17 41h16',
          stroke: '#fff',
          'stroke-width': 5,
          'stroke-linecap': 'round',
          opacity: 0.92,
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'boss-recruit', order: 40, label: '招聘流水线' },
            SidebarEntry,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'boss-recruit' }, Panel),
        )
      },
    }
  },
})

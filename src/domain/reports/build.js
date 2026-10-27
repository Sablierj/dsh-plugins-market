/**
 * 八类生成报告的正文构建器（F14-01，模块 14 · 报告中心）。
 *
 * ## 这一批为什么需要「生成器」，而不是又一张表
 *
 * 审计那一行的原话是「八类无 kind、**无写入方**」。kind 是一个字符串的问题，写入方不是：
 * 一份报告要能被打开、被搜索、被读，就得**先有一份正文**。而审计点名的八类，
 * 内容今天散在各模块的表里，**从来没有被渲染成一份文档，也没有任何文件承载它**。
 *
 * 所以这一层的活是：把那八份散着的事实，用**各自模块既有的判据**渲染成一份 Markdown。
 * 三条纪律：
 *
 *  1. **不重算任何判据。** 每一节都调既有的 builder（`buildAsinHealthSummary`、
 *     `buildAsinCompetitorView`、`agentMetrics`、`buildHealthCards`、`diffVersions`、
 *     `missingChecks`、`listPublicationObservations`…）。在这里重写一遍阈值、重排一遍
 *     优先级，就是给同一件事造第二份口径 —— 而两份口径会分歧，页面显示的那份会更旧。
 *  2. **不编任何数字。** 每一格要么来自一次真实读取，要么是一句 `gaps.js` 里的
 *     「没有」。没有第三种。
 *  3. **空态必须说清是哪一种「没有」。** 这是本批最贵的一条：八类报告全都可能在
 *     空库上被生成，而「0 条问题」「没扫过」「没建模」「本仓没有来源」四者长得一样。
 *
 * ## 「写入方」= `amzn_report_build`
 *
 * 八类的 `writer` 在 `REPORT_KIND_TABLE` 里都写着 `amzn_report_build`。这个工具**不**
 * 自动挂在别的工具上（不写 `amzn_dq_scan` 的副作用），理由：一份报告是一次**冻结的
 * 快照**，它应该在有人要它的那一刻生成，而不是在一次扫描的尾气里悄悄多出来一行。
 *
 * ## 幂等：同一天同一范围，重跑是更新不是堆积
 *
 * `reportIdOf` 的 id 形如 `<kind>:<refKey>:<YYYY-MM-DD>`，与 `recordFileReport` 用
 * 路径派生 id 是同一个办法（文件名带日期）和同一个理由：**同一天重跑同一份导出不该
 * 让列表多一套**。换一天、换一个范围，是真正不同的一份快照，各占一行。
 */

import { buildHealthCards } from '../dashboard/health.js'
import { describePeriods } from '../keywords/period.js'
import { ASIN_HEALTH_STATE_LABELS, ASIN_HEALTH_UNSOURCED, buildAsinHealthSummary } from '../asin/health.js'
import { buildFieldFacts } from '../asin/fields.js'
import { buildAsinCompetitorView } from '../asin/competitor.js'
import { agentMetrics } from '../agent/metrics.js'
import { EVAL_DIMENSION_COUNT, EVAL_DIMENSIONS } from '../prompts/eval-dimensions.js'
import { OBSERVATION_METRICS } from '../observe/metrics.js'
import { DIMENSION_LABELS } from '../data/quality-rules.js'
import { SEED_ROSTER } from '../rules/listing-rules.js'
import { missingChecks } from '../rules/registry.js'
import { activeVersion, diffVersions, listVersions } from '../../store/rules.js'
import { policyStats } from '../../store/policy.js'
import { listEvalSets } from '../../store/prompt.js'
import { issueStats, listIssues } from '../../store/quality.js'
import { listPublicationObservations } from '../../store/observe.js'
import { countTaskEvents } from '../../store/collection-task-event.js'
import { REPORT_KIND_TABLE, reportKindSpec } from '../../store/reports.js'
import { gap, markdownTable, metricAbsences, renderGaps } from './gaps.js'

/** The kinds this module can build. The rest are indexed, not generated. */
export const GENERATED_KINDS = REPORT_KIND_TABLE.filter(entry => entry.pointer === 'body').map(entry => entry.id)

/** `2026-10-19T03:04:05.000Z` → `2026-10-19`. The id's date stamp. */
function dateStamp(iso) {
  return String(iso).slice(0, 10)
}

/** `2026-10-19T03:04:05.000Z` → `2026-10-19 03:04`. Human, not ISO. */
function at(iso) {
  const text = String(iso ?? '')
  if (text === '') return '—'
  return text.slice(0, 16).replace('T', ' ')
}

function fmt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? String(Math.trunc(n)) : '—'
}

function blank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

/**
 * The **one** place a generated report's date is taken from the real clock.
 *
 * `buildReport` falls back to it when the caller has no opinion, and
 * `amzn_report_build` uses it as its default `clock`. Exported for exactly that
 * reason: a tool that wrote its own `new Date()` would be the second place that
 * answers "what day is it", and the two answers decide whether a re-run is an
 * update or a new snapshot. A second copy is a second identity rule.
 *
 * **This is also the seam the tests inject through.** `tests/f14-01-report-library.mjs`
 * drives the idempotency rule with a fixed clock, so "another day" cannot
 * accidentally be today — which is precisely how that assertion went red on
 * 2026-10-20 (its "different day" literal was `2026-10-20`, and the baseline came
 * from this function). 见 `tests/clock-guard.mjs` 里的守卫。
 */
export function systemClock() {
  return new Date().toISOString()
}

/**
 * The stable identity of one generated report.
 *
 * Exported because the tool derives the row id from it and the tests assert the
 * idempotency rule against it — two copies of "which day is it" is two different
 * answers about whether this is a new snapshot.
 *
 * `now` is **required** in spirit: callers pass an ISO string they already have
 * (from their injected clock). Passing nothing would silently mean "today" —
 * see `systemClock`.
 */
export function reportIdOf(kind, refKey, now) {
  return `${kind}:${refKey}:${dateStamp(now)}`
}

/* ───────────────────────── ① 数据质量报告 ───────────────────────── */

function buildDataQuality(store, ctx) {
  const stats = issueStats(store)
  const open = listIssues(store, { status: 'open' })
  const live = ['open', 'acknowledged', 'fixing']
  const liveRows = store.all(
    `SELECT * FROM dq_issue WHERE status IN (${live.map(() => '?').join(', ')})`,
    live,
  )
  const gaps = []
  /* Reused verbatim from the ASIN healthy-summary's own unsourced table: the
     reason 「dq_issue 只存发现，不存扫描本身」 is the same fact here, and a second
     spelling of it would be a second claim. */
  const scanBaseline = ASIN_HEALTH_UNSOURCED.find(entry => entry.id === 'rule-risk-scan-baseline')
  if (scanBaseline !== undefined) {
    gaps.push(gap({
      kind: 'not-modelled',
      id: scanBaseline.id,
      label: '「扫过没有」这条基线',
      feature: 'F14-01 / F05-07',
      reason: scanBaseline.reason,
    }))
  }

  const lines = [
    '# 数据质量报告',
    '',
    `- 生成时间：${at(ctx.now)}`,
    `- 来源：${reportKindSpec('data-quality').source}`,
    `- 口径：一条 dq_issue 一行；「未关闭」= status ∈ ${live.join(' / ')}。`,
    '',
    '## 一、总览',
    '',
    ...markdownTable([
      { label: '问题总数', value: fmt(stats.total) },
      { label: '未关闭', value: fmt(liveRows.length) },
      { label: '已解决', value: fmt(stats.byStatus?.resolved ?? 0) },
      { label: '已忽略', value: fmt(stats.byStatus?.ignored ?? 0) },
    ], [{ label: '项', value: row => row.label }, { label: '值', value: row => row.value }]),
    '',
  ]

  if (stats.total === 0) {
    lines.push('> ⚠️ **总问题数是 0，但这不是「没有问题」** —— 见附录第一条。'
      + '`dq_issue` 只存「发现了什么」，不存「扫过没有」，所以「扫过、干净」与「从来没扫过」'
      + '在库里长得一样。')
    lines.push('')
  } else {
    /* 2026-10-25（R-61）：这个 else 分支原来印的是
         「这里的 0 与上面的数都是**真实测量**：`dq_issue` 里没有行，就是没有行。」
       而它只在 `stats.total > 0` 时走到 —— **也就是 `dq_issue` 里明明有行的时候。**

       实测（run 的 data-quality 报告，6 条问题）：
         | 问题总数 | 6 |
         > …`dq_issue` 里没有行，就是没有行。
         ## 四、未关闭的问题（最多 200 条，共 6 条）
         | …（6 行）

       —— 那句话是从 `if` 分支（total === 0）搬过来的，搬的时候把「没有」一起带了过来。
       它出现在总览下面，是读者判断「这个 6 是什么意思」的第一句解释；
       **一句自己打自己脸的解释，比没有解释更糟 —— 它会让人连带怀疑那个 6。**

       `if` 分支那句（「总问题数是 0，但这不是『没有问题』」）是对的，没动。 */
    lines.push(`> 上面这 ${stats.total} 条都是**从 \`dq_issue\` 里读出来的行**，不是推算的。`
      + '但它们累计自不同的扫描时刻：每条只说明「发现它的那一刻成立」，'
      + '**不等于现在仍然成立** —— 未关闭的条目请对照当前值复核（见第四节）。')
    lines.push('')
  }

  lines.push('## 二、按严重级')
  lines.push('')
  lines.push(...markdownTable(
    Object.entries(stats.bySeverity ?? {}).map(([severity, n]) => ({ severity, n })),
    [{ label: '严重级', value: row => row.severity }, { label: '条数', value: row => fmt(row.n) }],
    '（本仓没有登记任何严重级 —— 因为一条问题都没有）',
  ))
  lines.push('')
  lines.push('## 三、按维度')
  lines.push('')
  lines.push(...markdownTable(
    Object.entries(stats.byDimension ?? {}).map(([dimension, n]) => ({ dimension, n })),
    [
      { label: '维度', value: row => DIMENSION_LABELS[row.dimension] ?? row.dimension },
      { label: 'id', value: row => row.dimension },
      { label: '条数', value: row => fmt(row.n) },
    ],
    '（没有维度可列 —— 同上，因为没有一条问题）',
  ))
  lines.push('')
  lines.push(`## 四、未关闭的问题（最多 200 条，共 ${fmt(liveRows.length)} 条）`)
  lines.push('')
  lines.push(...markdownTable(
    liveRows.slice(0, 200),
    [
      { label: '发现于', value: row => at(row.detected_at) },
      { label: '严重级', value: row => row.severity },
      { label: '维度', value: row => DIMENSION_LABELS[row.dimension] ?? row.dimension },
      { label: '对象', value: row => `${row.object_type} ${row.object_id}` },
      { label: '字段', value: row => row.field ?? '—' },
      { label: '问题', value: row => row.message },
      { label: '状态', value: row => row.status },
      /* 2026-10-25（R-62）：`dq_issue` 只存「发现的那一刻」，不存「现在是否仍然成立」。
         实测：B0GV55Q4JG 那条「Listing 标题为空」的 detected_at 是 2026-10-22T08:16，
         而 listing.title 在 2026-10-25T07:55:45 就写进去了 —— **issue 还挂在 open。**
         于是「未关闭 6」被读成「现在有 6 个问题」，而实际只有 3 条仍成立。

         这一列只做一件事：**拿这一行的 `field` 去读对象的当前值，说清它还成不成立。**
         读不到就说读不到（不是「仍然成立」）—— 两者的区别和今天一整天的主题一样。 */
      { label: '现在', value: (row) => {
        const target = String(row.object_id ?? '')
        const [asin, marketplace = 'US'] = target.split('@')
        const table = row.object_type === 'listing' ? 'listing' : (row.object_type === 'asin' ? 'asin' : null)
        if (table === null) return '—（这一类对象本报告不复核）'
        const field = String(row.field ?? '')
        if (field === '') return '—（这一行没记字段名）'
        const record = store.get(`SELECT ${field} AS v FROM ${table} WHERE asin = ? AND marketplace = ?`, [asin, marketplace])
        if (record === undefined) return `—（${table} 里没有这一行）`
        const value = record.v
        if (value === null || value === undefined || String(value).trim() === '') {
          return '仍然为空'
        }
        return `已填（${String(value).slice(0, 18)}${String(value).length > 18 ? '…' : ''}）`
      } },
    ],
    `（没有未关闭的问题 —— 这是「读到了，答案是 0」，前提是附录那条基线说明被读过）`,
  ))
  lines.push('')
  /* 2026-10-25（R-35）：这一句原来写的是
       「与上表的差额来自 acknowledged / fixing 这两态，它们同样是『还没有解决』」
     —— 它**假设一定存在差额**。实测那一份报告里，上表 6 条、按 open 查也是 6 条，
     **差额是 0**，而这句话仍在说「差额来自那两态」。
     于是读者会以为「还有 acknowledged / fixing 的问题没列出来」，实际没有。

     这是今天同一个主题的又一形态：**把「没有」说成「有」**。
     改成两个口径各自说清 —— **相等时它读起来就是「相等」，不等时它读起来就是「有差额」**。 */
  lines.push(`另：上表是「未关闭」口径（open / acknowledged / fixing 三态都算），`
    + `这一句是 open 单口径，得了 ${fmt(open.length)} 条。`
    + '两个数相等，就说明**没有** acknowledged / fixing 态的问题；不等时，差额全部来自那两态。')
  lines.push(...renderGaps(gaps))
  return {
    title: '数据质量汇总',
    refKey: 'all',
    scope: { productLine: ctx.productLine ?? null },
    body: lines.join('\n'),
  }
}

/* ───────────────────────── ② 采集报告 ───────────────────────── */

function buildCollection(store, ctx) {
  const tasks = store.all('SELECT * FROM collection_task ORDER BY submitted_at DESC LIMIT 500')
  const total = Number(store.get('SELECT COUNT(*) AS n FROM collection_task')?.n ?? 0)
  const byStatus = store.all('SELECT status, COUNT(*) AS n FROM collection_task GROUP BY status ORDER BY n DESC')
  const sections = store.all(
    `SELECT section, status, COUNT(*) AS n FROM collection_section_result GROUP BY section, status ORDER BY section, status`,
  )
  const failed = store.all(
    `SELECT id, status, submitted_at, error FROM collection_task
      WHERE error IS NOT NULL AND TRIM(error) <> '' ORDER BY submitted_at DESC LIMIT 50`,
  )
  const gaps = []

  const lines = [
    '# 采集报告',
    '',
    `- 生成时间：${at(ctx.now)}`,
    `- 来源：${reportKindSpec('collection').source}`,
    '- 口径：一条 `collection_task` 一行；分节结果来自 `collection_section_result`（每个 ASIN × 每个 section 一行）。',
    '',
    '## 一、任务总览',
    '',
    ...markdownTable([
      { label: '任务总数', value: fmt(total) },
      { label: '本报告列出', value: `${fmt(tasks.length)}${total > tasks.length ? '（上限 500）' : ''}` },
      { label: '带错误信息', value: fmt(Number(store.get("SELECT COUNT(*) AS n FROM collection_task WHERE error IS NOT NULL AND TRIM(error) <> ''")?.n ?? 0)) },
      { label: '分节结果行', value: fmt(Number(store.get('SELECT COUNT(*) AS n FROM collection_section_result')?.n ?? 0)) },
    ], [{ label: '项', value: row => row.label }, { label: '值', value: row => row.value }]),
    '',
  ]

  if (total === 0) {
    lines.push('> 库内**一条采集任务都没有**。这是「有来源，但还没有记录」—— '
      + '`collection_task` 表在（v1 起），写入方是 `amzn_collect_submit` / `amzn_collect_run`。'
      + '它不是「本仓不支持采集」。')
    lines.push('')
  }

  lines.push('## 二、按状态')
  lines.push('')
  lines.push(...markdownTable(
    byStatus,
    [{ label: '状态', value: row => row.status }, { label: '任务数', value: row => fmt(row.n) }],
    '（没有任务，所以没有状态可分）',
  ))
  lines.push('')
  lines.push('## 三、分节采集结果')
  lines.push('')
  lines.push(...markdownTable(
    sections,
    [
      { label: '章节', value: row => row.section },
      { label: '结果', value: row => row.status },
      { label: '行数', value: row => fmt(row.n) },
    ],
    '（没有分节结果 —— 要么还没采集过，要么采到的任务一条 section 都没写；两者在表里都是 0 行）',
  ))
  lines.push('')
  lines.push('## 四、最近的任务（最多 50 条）')
  lines.push('')
  lines.push(...markdownTable(
    tasks.slice(0, 50),
    [
      { label: '提交于', value: row => at(row.submitted_at) },
      { label: '完成于', value: row => at(row.finished_at) },
      { label: 'id', value: row => String(row.id).slice(0, 8) },
      { label: '状态', value: row => row.status },
      { label: '目标数', value: row => fmt(Array.isArray(safeParse(row.targets_json, [])) ? safeParse(row.targets_json, []).length : 0) },
      { label: '事件数', value: row => fmt(countTaskEvents(store, row.id)) },
      { label: '错误', value: row => (blank(row.error) ? '—' : String(row.error).slice(0, 60)) },
    ],
    '（没有任务可列）',
  ))
  lines.push('')
  lines.push('## 五、失败的任务（最多 50 条）')
  lines.push('')
  lines.push(...markdownTable(
    failed,
    [
      { label: '提交于', value: row => at(row.submitted_at) },
      { label: 'id', value: row => String(row.id).slice(0, 8) },
      { label: '状态', value: row => row.status },
      { label: '错误', value: row => String(row.error).slice(0, 80) },
    ],
    '（没有带错误的任务 —— 这是「读到了，答案是 0」，不是「没采集过」）',
  ))
  lines.push(...renderGaps(gaps))
  return {
    title: '采集汇总',
    refKey: 'all',
    scope: { productLine: ctx.productLine ?? null },
    body: lines.join('\n'),
  }
}

function safeParse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/* ───────────────────── ③ ASIN 健康报告 ───────────────────── */

function buildAsinHealth(store, ctx) {
  const asin = String(ctx.asin ?? '').trim().toUpperCase()
  const marketplace = String(ctx.marketplace ?? '').trim().toUpperCase()
  if (asin === '') return { ok: false, code: 'SCOPE_REQUIRED', error: 'ASIN 健康报告要指定 asin', hint: '给 asin（10 位）与 marketplace。' }
  if (marketplace === '') return { ok: false, code: 'SCOPE_REQUIRED', error: 'ASIN 健康报告要指定 marketplace', hint: '同一个 ASIN 在不同站点是两条记录。' }
  if (typeof ctx.precheckFor !== 'function') {
    return {
      ok: false,
      code: 'DEPENDENCY_MISSING',
      error: 'ASIN 健康报告需要注入 precheckFor —— 否则会把「没人算过前置」静默读成「前置不满足」',
    }
  }

  const fields = buildFieldFacts(store, { asin, marketplace })
  if (fields === null) {
    return {
      ok: false,
      code: 'ASIN_NOT_FOUND',
      error: `${asin} (${marketplace}) 不在库内`,
      hint: '先用 amzn_asin_upsert 导入，或确认站点代码对不对 —— 同一个 ASIN 在不同站点是两条记录',
    }
  }
  const precheck = ctx.precheckFor(store, { asin, marketplace, mode: 'full' })
  const summary = buildAsinHealthSummary(store, { asin, marketplace, fields, precheck })
  if (summary.ok !== true) return summary

  const asinRow = store.get('SELECT product_line_id FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace])
  const gaps = summary.unsourced.map(entry => gap({
    kind: 'no-source',
    id: entry.id,
    label: entry.label,
    feature: entry.feature ?? 'F05-07',
    reason: entry.reason,
  }))

  const lines = [
    `# ASIN 健康报告 · ${asin} · ${marketplace}`,
    '',
    `- 生成时间：${at(ctx.now)}`,
    `- 来源：${reportKindSpec('asin-health').source}`,
    `- 判定：${summary.verdict === 'ok' ? '六项都取到了判据' : summary.verdict === 'blocked' ? '优化前置有阻断项' : '有项取不到判据'}`,
    '',
    '## 一、六项',
    '',
    ...markdownTable(summary.items, [
      { label: '项', value: entry => entry.label },
      { label: '状态', value: entry => ASIN_HEALTH_STATE_LABELS[entry.state] ?? entry.state },
      { label: '分子/分母', value: entry => (entry.denominator === null || entry.denominator === undefined ? fmt(entry.numerator) : `${fmt(entry.numerator)}/${fmt(entry.denominator)}`) },
      { label: '结论', value: entry => entry.conclusion },
    ], '（六项一项都没有 —— 这只可能是 builder 出错，不是数据空）'),
    '',
    '## 二、逐项的依据与扣分项',
    '',
  ]
  for (const entry of summary.items) {
    lines.push(`### ${entry.label}（${entry.state}）`)
    lines.push('')
    lines.push(`- 来源：${entry.source}`)
    lines.push(`- 口径：${entry.basis}`)
    if (entry.breakdown.length > 0) {
      lines.push(`- 分档：${entry.breakdown.map(row => `${row.label}=${row.value}`).join('　')}`)
    }
    if (entry.missing.length > 0) {
      lines.push(`- 扣分项（${entry.missing.length}）：${entry.missing.slice(0, 40).map(String).join('、')}${entry.missing.length > 40 ? ' 等' : ''}`)
    } else {
      lines.push('- 扣分项：无（这一项没有可扣的东西）')
    }
    if (entry.note !== null) lines.push(`- ⚠️ ${entry.note}`)
    if (entry.caveat !== null) lines.push(`- ⚠️ ${entry.caveat}`)
    lines.push('')
  }
  lines.push(...renderGaps(gaps))
  return {
    title: `${asin} · ${marketplace} 数据健康`,
    refKey: `${asin}@${marketplace}`,
    scope: { asin, marketplace, productLine: asinRow?.product_line_id ?? null },
    body: lines.join('\n'),
  }
}

/* ───────────────────── ④ 竞品差距报告 ───────────────────── */

const QUADRANT_IDS = ['ownAdvantage', 'contested', 'ourAbsent', 'unmeasured', 'brandOnly']

function buildCompetitorGap(store, ctx) {
  const asin = String(ctx.asin ?? '').trim().toUpperCase()
  const marketplace = String(ctx.marketplace ?? '').trim().toUpperCase()
  if (asin === '' || marketplace === '') {
    return { ok: false, code: 'SCOPE_REQUIRED', error: '竞品差距报告要指定 asin 与 marketplace', hint: '对比是对一条自有 ASIN 而言的。' }
  }

  const view = buildAsinCompetitorView(store, { asin, marketplace })
  if (view.ok !== true) return view

  const asinRow = store.get('SELECT product_line_id FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace])
  const gaps = view.unsourced.map(entry => gap({
    kind: 'no-source',
    id: entry.id,
    label: entry.label,
    feature: entry.feature ?? 'F06-03',
    reason: entry.reason,
  }))

  const lines = [
    `# 竞品差距报告 · ${asin} · ${marketplace}`,
    '',
    `- 生成时间：${at(ctx.now)}`,
    `- 来源：${reportKindSpec('competitor-gap').source}`,
    '',
    '## 一、所属竞品组',
    '',
    ...markdownTable(view.membership, [
      { label: '竞品组', value: row => row.name },
      { label: '含本 ASIN', value: row => (row.containsThis ? '是' : '否') },
      { label: '成员数', value: row => fmt(row.memberCount) },
      { label: '更新于', value: row => at(row.updatedAt) },
    ], '（这个站点上一条竞品组都没有 —— 不是「本 ASIN 不在组里」，是「还没有组」）'),
    '',
    `本 ASIN 在 ${fmt(view.memberSetCount)} / ${fmt(view.setCount)} 个组里；对端（去重后）${fmt(view.peerCount)} 条。`,
    '',
  ]
  if (view.peersSource !== null) {
    lines.push(`对端来源：${view.peersSource}`)
    lines.push('')
  }

  lines.push('## 二、关键词侧五桶')
  lines.push('')
  if (view.comparison === null) {
    lines.push(`> ${view.comparisonNote}`)
    lines.push('')
    lines.push('这一节**不是一张空表** —— 它是「没有可对比的对端」。上表说清是哪一种。')
  } else {
    lines.push(`输入 ${fmt(view.comparison.inputTotal)} 个词，分类成功 ${fmt(view.comparison.classified)} 个；`
      + `对端有事实的词 ${fmt(view.comparison.peerFactKeywords)} 个，我们有事实的词 ${fmt(view.comparison.ourFactKeywords)} 个。`)
    lines.push('')
    lines.push(...markdownTable(
      QUADRANT_IDS.map(id => ({
        id,
        label: view.comparison.labels[id] ?? id,
        count: Number(view.comparison.counts?.[id] ?? 0),
        truncated: view.comparison.truncated?.[id] === true,
      })),
      [
        { label: '桶', value: row => row.label },
        { label: 'id', value: row => row.id },
        { label: '词数', value: row => fmt(row.count) },
        { label: '本报告截断', value: row => (row.truncated ? `是（只印前 ${fmt(view.comparison.limit)} 条）` : '否') },
      ],
    ))
    lines.push('')
    if (view.comparisonNote !== null) {
      lines.push(`> ⚠️ ${view.comparisonNote}`)
      lines.push('')
    }
    for (const id of QUADRANT_IDS) {
      const rows = view.comparison.quadrants?.[id] ?? []
      if (rows.length === 0) continue
      lines.push(`### ${view.comparison.labels?.[id] ?? id}（${rows.length} 条示例）`)
      lines.push('')
      /* 2026-10-25（R-34）：这三列的字段名原来**全部对不上**数据源，于是 1432 个词
         在报告里都印成 `—` —— 而同一页上方写着「对端有事实的词 1432 个，我们有事实的词 8 个」。
         **说「有」却印不出来，比说「没有」更糟**：读者会以为「我们和对端都没排名」，
         而不是「渲染取错了字段」。

         `quadrantRows`（domain/keywords/competitor.js:367）返回的是**扁平字段**：
           our_rank / competitor_best_rank / search_volume
         而这里读的是嵌套的 ours.rank / theirs.rank / volume —— 三个都取不到。

         这正是 R-21 那个教训的反向版本：R-21 是「列是空的却拿它排序」，
         这里是「说不空却印不出来」。两次都是**渲染层和它的数据源之间没有约定**。 */
      lines.push(...markdownTable(rows, [
        { label: '关键词', value: row => row.keyword },
        { label: '我们排名', value: row => row.our_rank ?? '—' },
        { label: '对端最好排名', value: row => row.competitor_best_rank ?? '—' },
        { label: '搜索量', value: row => fmt(row.search_volume) },
      ]))
      lines.push('')
    }
  }
  for (const note of view.notes ?? []) {
    lines.push(`> ⚠️ ${note}`)
  }
  if ((view.notes ?? []).length > 0) lines.push('')
  lines.push(...renderGaps(gaps))
  return {
    title: `${asin} · ${marketplace} 竞品差距`,
    refKey: `${asin}@${marketplace}`,
    scope: { asin, marketplace, productLine: asinRow?.product_line_id ?? null },
    body: lines.join('\n'),
  }
}

/* ───────────────────── ⑤ 规则政策影响报告 ───────────────────── */

function buildRulePolicyImpact(store, ctx) {
  const versions = listVersions(store)
  const active = activeVersion(store)
  const roster = store.get('SELECT * FROM rule_set WHERE is_active = 1')
  const rows = roster === undefined || roster === null
    ? SEED_ROSTER.map(rule => ({ rule_id: rule.id, kind: rule.kind ?? 'code', enabled: 1 }))
    : store.all('SELECT rule_id, kind, enabled FROM rule WHERE rule_set_version = ? AND deleted_at IS NULL', [roster.version])
  const code = rows.filter(row => (row.kind ?? 'code') === 'code')
  const missing = new Set(missingChecks(code.map(row => ({ id: row.rule_id, kind: row.kind }))))
  const policies = policyStats(store)

  /* The two most recent versions, which is what 「上一次改动影响了什么」 asks. */
  const previous = versions.length >= 2 ? versions[1] : null
  const diff = previous === null ? null : diffVersions(store, previous.version, versions[0].version)

  const gaps = [
    gap({
      kind: 'not-modelled',
      id: 'per-listing-impact',
      label: '按 listing 的受影响清单',
      feature: 'F14-01 / F02-06',
      reason: '本仓有**规则判定函数**（`domain/rules/listing-rules.js` 的 `CHECKS`，共 '
        + `${fmt(SEED_ROSTER.length)} 条）与**单条草案的校验器**`
        + '（`domain/optimize/validate.js`），但没有「拿当前规则库批量跑一遍全库 listing」的入口：'
        + '没有任何表存「某条 rule 在某条 ASIN 上的判定结果」，也没有一个批量任务产出它。'
        + '所以本报告能回答「规则库变了什么、哪些规则没有判定」，不能回答「哪 12 条 listing 现在违规」。'
        + '⚠️ 这不是「本仓没有规则来源」，是「受影响面的批量计算没有落点」。',
    }),
  ]

  const lines = [
    '# 规则政策影响报告',
    '',
    `- 生成时间：${at(ctx.now)}`,
    `- 来源：${reportKindSpec('rule-policy-impact').source}`,
    `- 生效规则版本：${active ?? '（库里没有 rule_set 行 —— 用代码种子）'}`,
    '',
    '## 一、生效规则库',
    '',
    ...markdownTable([
      { label: '规则总数', value: fmt(rows.length) },
      { label: 'code 类（有判定的候选）', value: fmt(code.length) },
      { label: '其中判定实现缺失', value: fmt(missing.size) },
      { label: '版本数', value: fmt(versions.length) },
    ], [{ label: '项', value: row => row.label }, { label: '值', value: row => row.value }]),
    '',
  ]
  if (rows.length === 0) {
    lines.push('> ⚠️ 生效版本里**一条规则都没有** —— 这是「读到了，答案是 0」。'
      + '规则库一个版本都没有时，代码种子（`SEED_ROSTER`）是生效的兜底。')
    lines.push('')
  }
  if (missing.size > 0) {
    lines.push('### 有 id、没有判定的规则（fail-closed：这些规则会让校验报 rule-check-missing）')
    lines.push('')
    lines.push(...markdownTable([...missing].map(id => ({ id })), [{ label: '规则 id', value: row => row.id }]))
    lines.push('')
  }

  lines.push('## 二、规则版本历史')
  lines.push('')
  lines.push(...markdownTable(versions, [
    { label: '版本', value: row => row.version },
    { label: '生效', value: row => (row.is_active === 1 ? '是' : '否') },
    { label: '规则数', value: row => fmt(row.rule_count) },
    { label: '启用数', value: row => fmt(row.enabled_count) },
    { label: '发布于', value: row => at(row.published_at) },
  ], '（一个规则版本都没有 —— 这是「有来源，但还没有记录」：`amzn_rule_activate` / `amzn_rule_import` 是写入方）'))
  lines.push('')

  lines.push('## 三、最近一次版本改动的影响')
  lines.push('')
  if (diff === null) {
    lines.push('> 只有 **1 个**规则版本，所以没有「版本之间变了什么」可比 —— 这是「条数不足」，'
      + '不是「改动没有影响」。')
  } else {
    lines.push(`\`${diff.from}\` → \`${diff.to}\``)
    lines.push('')
    lines.push(...markdownTable([
      { label: '新增规则', value: fmt(diff.added.length) },
      { label: '移除规则', value: fmt(diff.removed.length) },
      { label: '变更规则', value: fmt(diff.changed.length) },
    ], [{ label: '项', value: row => row.label }, { label: '值', value: row => row.value }]))
    if (diff.added.length > 0) { lines.push('', `新增：${diff.added.join('、')}`) }
    if (diff.removed.length > 0) { lines.push('', `移除：${diff.removed.join('、')}`) }
    if (diff.changed.length > 0) {
      lines.push('')
      lines.push(...markdownTable(diff.changed, [
        { label: '规则 id', value: row => row.ruleId },
        { label: '改了哪些字段', value: row => row.fields.join(', ') },
      ]))
    }
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
      lines.push('', '两个版本之间**一个字都没变** —— 这是一次真实的比对结果。')
    }
  }
  lines.push('')

  lines.push('## 四、政策库')
  lines.push('')
  lines.push(...markdownTable([
    { label: '政策总数', value: fmt(policies.total) },
    { label: '生效', value: fmt(policies.active) },
    { label: '被取代', value: fmt(policies.superseded) },
    { label: '严重级未判定', value: fmt(policies.unjudged) },
    { label: '生效日未知', value: fmt(policies.unknownEffective) },
    { label: '已关联到规则', value: fmt(policies.linked) },
  ], [{ label: '项', value: row => row.label }, { label: '值', value: row => row.value }]))
  lines.push('')
  lines.push('> 「严重级未判定」与「生效日未知」都**不是 0 的风险**：它们是政策原文没有说，'
    + '所以本仓不替它猜一个值（见 `store/policy.js` 的 `policyStats` 注释）。')
  lines.push(...renderGaps(gaps))
  return {
    title: '规则政策影响汇总',
    refKey: 'all',
    scope: { productLine: ctx.productLine ?? null },
    body: lines.join('\n'),
  }
}

/* ───────────────── ⑥ Prompt·Agent 评估报告 ───────────────── */

/** `EVAL_DIMENSIONS[].kind` → one of the four absence kinds. */
const DIMENSION_ABSENCE = {
  'same-name-elsewhere': 'not-modelled',
  'concept-not-started': 'not-modelled',
  'no-source': 'no-source',
}

function buildPromptAgentEval(store, ctx) {
  const sets = listEvalSets(store)
  const metrics = agentMetrics(store)
  const runs = store.all("SELECT status, COUNT(*) AS n FROM agent_run GROUP BY status ORDER BY n DESC")
  const totalRuns = Number(store.get('SELECT COUNT(*) AS n FROM agent_run')?.n ?? 0)

  const gaps = EVAL_DIMENSIONS.map(entry => gap({
    kind: DIMENSION_ABSENCE[entry.kind] ?? 'not-modelled',
    id: entry.id,
    label: entry.label,
    feature: 'F11-07 / F11-08',
    reason: entry.missing,
  }))

  const lines = [
    '# Prompt·Agent 评估报告',
    '',
    `- 生成时间：${at(ctx.now)}`,
    `- 来源：${reportKindSpec('prompt-agent-eval').source}`,
    '',
    '> ⚠️ **本插件没有评估器。** 它不会替你跑评估集，也**没有任何通过率**。'
      + '下面所有数字都来自库里已有的行，一格都不是「跑一遍得到的」。',
    '',
    '## 一、评估集（题目）',
    '',
    ...markdownTable(sets, [
      { label: '集合', value: row => row.id },
      { label: '版本', value: row => row.version },
      { label: '标题', value: row => row.title },
      { label: '分类', value: row => row.category ?? '—' },
      { label: '样例数', value: row => fmt(row.caseCount) },
      { label: '创建于', value: row => at(row.createdAt) },
    ], '（库内一套评估集都没有 —— 这是「有来源，但还没有记录」：`amzn_prompt_eval_import` 是写入方。'
      + '「没有评估集」与「评了、没通过」是两件事）'),
    '',
  ]
  const emptySets = sets.filter(row => row.isEmpty === true)
  if (emptySets.length > 0) {
    lines.push(`> ${emptySets.length} 套评估集**一条样例都没有**（${emptySets.map(row => `${row.id}@${row.version}`).join('、')}）—— `
      + '这是「集子建了、题目还没填」，不是「题目跑完了」。')
    lines.push('')
  }

  lines.push('## 二、Agent 运行（有记录的）')
  lines.push('')
  lines.push(...markdownTable([
    { label: '运行总数', value: fmt(totalRuns) },
    ...runs.map(row => ({ label: `状态 ${row.status}`, value: fmt(row.n) })),
  ], [{ label: '项', value: row => row.label }, { label: '值', value: row => row.value }]))
  lines.push('')

  lines.push('## 三、§14 指标')
  lines.push('')
  lines.push(...markdownTable(metrics.computed, [
    { label: '指标', value: row => row.label },
    { label: '值', value: row => row.display },
    { label: '分子/分母', value: row => (row.denominator === null ? '—' : `${fmt(row.numerator)}/${fmt(row.denominator)}`) },
    { label: '口径', value: row => row.note },
  ], '（十项里一项都算不出来 —— 见下一节「缺哪份记录」）'))
  lines.push('')
  lines.push(`### 算不出来、但知道缺哪份记录的（${metrics.unavailable.length}）`)
  lines.push('')
  lines.push(...markdownTable(metrics.unavailable, [
    { label: '指标', value: row => row.label },
    { label: '缺什么', value: row => row.missing },
    { label: '为什么', value: row => row.why },
  ], '（没有 —— 十项都算得出来。这是「读到了，答案是都能算」）'))
  lines.push('')

  lines.push(`## 四、九维评估：一条数字都不能填（共 ${EVAL_DIMENSION_COUNT} 维）`)
  lines.push('')
  lines.push('> 这九维是**评估对象**，不是评估结果。本仓对其中每一维都查过：')
  lines.push('> 要么同名物属于别的模块不能挪用，要么概念从未立项，要么根本没有来源。')
  lines.push('> 所以这里打印的是**「缺哪份记录」**，一格分数、通过率、时间都不填。')
  lines.push('')
  lines.push(...markdownTable(EVAL_DIMENSIONS, [
    { label: '维度', value: row => row.label },
    { label: 'id', value: row => row.id },
    { label: '缺的是', value: row => (DIMENSION_ABSENCE[row.kind] === 'no-source' ? '没有来源' : '没有建模/不能挪用') },
    { label: '同类物在哪', value: row => row.sameNameAt ?? '无' },
  ]))
  lines.push(...renderGaps(gaps))
  return {
    title: 'Prompt·Agent 评估汇总',
    refKey: 'all',
    scope: { productLine: ctx.productLine ?? null },
    body: lines.join('\n'),
  }
}

/* ───────────────── ⑦ 发布后效果报告 ───────────────── */

function buildPostPublication(store, ctx) {
  const asin = blank(ctx.asin) ? null : String(ctx.asin).trim().toUpperCase()
  const marketplace = blank(ctx.marketplace) ? null : String(ctx.marketplace).trim().toUpperCase()
  const cards = listPublicationObservations(store, { asin, marketplace, limit: 100 })
  const publications = Number(store.get('SELECT COUNT(*) AS n FROM publication_record')?.n ?? 0)
  const terminated = Number(store.get("SELECT COUNT(*) AS n FROM publication_record WHERE observation_terminated_at IS NOT NULL")?.n ?? 0)
  const deviated = Number(store.get('SELECT COUNT(*) AS n FROM publication_record WHERE deviated = 1')?.n ?? 0)

  const noSource = OBSERVATION_METRICS.filter(metric => metric.availability === 'no')
  const partial = OBSERVATION_METRICS.filter(metric => metric.availability === 'partial')
  /* F14-10：这三条口径映射（no → no-source、partial → not-modelled、
     current-only → not-modelled）从本文件的两段内联 filter/map 搬进了
     `gaps.js#metricAbsences` —— 导出件头部的「数据新鲜度」要的是同一条规则，
     两处各写一遍就是两处会漂的口径。这里只要「可用性」那一轴：
     `history` 那条讲的是「变化列恒为空」，与本报告的卡片无关。 */
  const gaps = [...noSource, ...partial]
    .flatMap(metric => metricAbsences(metric, { feature: 'F14-04', include: ['availability'] }))

  const lines = [
    '# 发布后效果报告',
    '',
    `- 生成时间：${at(ctx.now)}`,
    `- 范围：${asin === null ? '全库' : `${asin} · ${marketplace ?? '—'}`}`,
    `- 来源：${reportKindSpec('post-publication').source}`,
    '',
    '## 一、总览',
    '',
    ...markdownTable([
      { label: '发布记录', value: fmt(publications) },
      { label: '偏离（§6 判定）', value: fmt(deviated) },
      { label: '观测已终止（§9 回滚）', value: fmt(terminated) },
      { label: '本报告展开的观测卡片', value: fmt(cards.rows.length) },
    ], [{ label: '项', value: row => row.label }, { label: '值', value: row => row.value }]),
    '',
  ]
  if (publications === 0) {
    lines.push('> 库内**一条发布记录都没有** —— 这是「有来源，但还没有记录」：'
      + '`amzn_publication_record` 是写入方。它**不是**「本仓不支持发布后观测」：'
      + '`observation_plan` / `observation_checkpoint` / `amzn_observation_*` 都在。')
    lines.push('')
  }

  lines.push('## 二、观测卡片（最多 100 条）')
  lines.push('')
  if (cards.rows.length === 0) {
    lines.push('（没有可展开的卡片 —— 同上的原因，先看第一节那行说明是哪一种空）')
    lines.push('')
  } else {
    lines.push(...markdownTable(cards.rows, [
      { label: '发布 id', value: card => String(card.publication?.id ?? '').slice(0, 8) },
      { label: 'ASIN', value: card => card.publication?.asin ?? '—' },
      { label: '站点', value: card => card.publication?.marketplace ?? '—' },
      { label: '发布于', value: card => at(card.publication?.publishedAt) },
      { label: '卡片状态', value: card => card.state },
      { label: '节点完成/总数', value: card => `${fmt((card.checkpoints ?? []).filter(c => c.status === 'concluded').length)}/${fmt((card.checkpoints ?? []).length)}` },
      { label: '下一步', value: card => (card.nextDue === null ? '没有待办节点' : `第 ${card.nextDue.day} 天（${card.nextDue.status}）`) },
    ]))
    lines.push('')
    /* 2026-10-25（R-19）：原来只判 `nextDue !== null` 就印
       「N 张卡片的下一步**到期或快到期**」—— 实拍里那张卡的状态是 `pending`、
       第 7 天节点在 2026-11-01 到期（还有 7 天）。**把「还没到期」印成「快到期」，
       会让读者以为今天就该去看效果，而那天还没到。**
       按节点的实际状态分两组说，各说各的。 */
    const notYet = cards.rows.filter(card => card.nextDue !== null && card.nextDue.status === 'pending')
    const dueNow = cards.rows.filter(card => card.nextDue !== null && card.nextDue.status !== 'pending')
    if (dueNow.length > 0) {
      lines.push(`> ${dueNow.length} 张卡片的下一步**已经到期** —— 到期不等于「效果不好」，`
        + '它是「该去看一眼」。这里不替你做结论。')
      lines.push('')
    }
    if (notYet.length > 0) {
      lines.push(`> 另有 ${notYet.length} 张卡片的下一步**还没到期**（见上表的到期日）—— `
        + '现在去看只是确认节点还在，拿不到任何趋势。')
      lines.push('')
    }
  }

  lines.push('## 三、§8 的九个指标：本仓各自的可用性')
  lines.push('')
  lines.push(...markdownTable(OBSERVATION_METRICS, [
    { label: '指标', value: row => row.label },
    { label: 'id', value: row => row.id },
    { label: '可用性', value: row => (row.availability === 'yes' ? '可用' : (row.availability === 'partial' ? '只有一部分' : '没有来源')) },
    { label: '历史', value: row => row.history },
    { label: '来源表', value: row => row.table },
  ]))
  lines.push('')
  lines.push('> 「没有来源」的两项不是漏做：它们在 `domain/observe/metrics.js` 里就是这么登记的。'
    + '「只有一部分」的两项（点击率、转化率）**只有广告侧** —— 没有广告投放的自然流量不在里面。')
  lines.push(...renderGaps(gaps))
  return {
    title: `发布后效果${asin === null ? '（全库）' : ` · ${asin} · ${marketplace}`}`,
    refKey: asin === null ? 'all' : `${asin}@${marketplace}`,
    scope: { asin, marketplace, productLine: ctx.productLine ?? null },
    body: lines.join('\n'),
  }
}

/* ───────────────── ⑧ 运营汇总报告 ───────────────── */

function buildOpsSummary(store, ctx) {
  const cards = buildHealthCards(store, {})
  const counts = {
    asin: Number(store.get('SELECT COUNT(*) AS n FROM asin')?.n ?? 0),
    asinArchived: Number(store.get('SELECT COUNT(*) AS n FROM asin WHERE archived_at IS NOT NULL')?.n ?? 0),
    kwMaster: Number(store.get('SELECT COUNT(*) AS n FROM kw_master')?.n ?? 0),
    collectionTasks: Number(store.get('SELECT COUNT(*) AS n FROM collection_task')?.n ?? 0),
    optimizationRuns: Number(store.get('SELECT COUNT(*) AS n FROM optimization_run')?.n ?? 0),
    publications: Number(store.get('SELECT COUNT(*) AS n FROM publication_record')?.n ?? 0),
    dqOpen: Number(store.get("SELECT COUNT(*) AS n FROM dq_issue WHERE status IN ('open','acknowledged','fixing')")?.n ?? 0),
    conflictsOpen: Number(store.get("SELECT COUNT(*) AS n FROM field_conflict WHERE status = 'open'")?.n ?? 0),
    reports: Number(store.get('SELECT COUNT(*) AS n FROM report')?.n ?? 0),
  }
  const ad = store.get(
    `SELECT COUNT(*) AS rows, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
            SUM(orders) AS orders, SUM(spend) AS spend, SUM(sales) AS sales,
            GROUP_CONCAT(DISTINCT period) AS periods
       FROM kw_ad_fact`,
  )

  const gaps = [
    gap({
      kind: 'no-source',
      id: 'store-revenue',
      label: '全店营收 / 利润',
      feature: 'F14-01 / 运营汇总',
      reason: '本仓没有任何一张表装「店铺层面的营收或利润」：`kw_ad_fact` 的 `sales` / `spend` 是'
        + '**导入的广告报告**里的关键词粒度数字，不是结算数据、不含佣金、不含退款、也不含自然单。'
        + '把它当营收会错一个量级。',
    }),
    gap({
      kind: 'not-modelled',
      id: 'organic-orders',
      label: '自然订单（非广告）',
      feature: 'F14-01 / 运营汇总',
      reason: '`kw_aba_fact.total_purchases` 是**该关键词**的购买数，`asin.reviews` 是评论数；'
        + '两者都不能还原「这条 listing 出自然单多少」。本仓没有订单表，也没有会话表。',
    }),
  ]

  const lines = [
    '# 运营汇总报告',
    '',
    `- 生成时间：${at(ctx.now)}`,
    `- 来源：${reportKindSpec('ops-summary').source}`,
    `- 口径：**这一份只汇总本仓算得出来的东西**，不包含营收、利润、结算 —— 见附录。`,
    '',
    '## 一、六张健康卡（与首页同一份 builder）',
    '',
    ...markdownTable(cards, [
      { label: '卡', value: row => row.label },
      { label: '结论', value: row => row.conclusion },
      { label: '分子/分母', value: row => (row.denominator === null || row.denominator === undefined ? '—' : `${fmt(row.numerator)}/${fmt(row.denominator)}`) },
      { label: '口径', value: row => row.unit ?? '—' },
      { label: '来源', value: row => row.source },
    ], '（一张卡都没有 —— 这只可能是 builder 出错）'),
    '',
    '> `暂无数据` 与 `0/0` 是**同一句话的两种写法**：这张卡的分母是 0，所以没有可测的东西。'
      + '它不是「测了、结果是 0」。',
    '',
    '## 二、资产与动作计数',
    '',
    ...markdownTable(Object.entries(counts).map(([key, value]) => ({ key, value })), [
      { label: '项', value: row => row.key },
      { label: '数量', value: row => fmt(row.value) },
    ]),
    '',
    '### 各项的读法',
    '',
    '- `asin` / `asinArchived`：自有 ASIN 与其中已归档的条数（归档**不隐藏**，见 F05-08 裁决）。',
    '- `kwMaster`：关键词总库合成行数。',
    '- `collectionTasks`：采集任务条数（不是采集到的 ASIN 数）。',
    '- `optimizationRuns` / `publications`：优化轮次与发布登记。',
    '- `dqOpen` / `conflictsOpen`：未关闭的数据质量问题与字段冲突。',
    '- `reports`：本报告自己也在里面 —— 生成之后再读会多 1。',
    '',
    '## 三、广告侧（导入的广告报告）',
    '',
  ]
  if (Number(ad?.rows ?? 0) === 0) {
    lines.push('> `kw_ad_fact` **一行都没有** —— 这是「有来源，但还没有记录」：'
      + '`amzn_kw_import` 导入广告报告才会写它。**不是**「本仓不支持广告数据」。')
  } else {
    /* 2026-10-25 真实数据实测（R-5）：这里原来直接印 GROUP_CONCAT 的结果，于是出现
       `20260314-20160412` —— 结束早于开始，一个**不可能**的区间。
       查下去是亚马逊导出的文件名自己把 2026 打成了 2016；但**我们原样采信了它**，
       等于替源数据背书。现在逐个判：不可能的标出来，剩下的原样。 */
    const periodInfo = describePeriods(ad.periods)
    const periodValue = periodInfo.impossible.length === 0
      ? periodInfo.label
      : `${periodInfo.label}　⚠️ ${periodInfo.impossible[0].note}`
    lines.push(...markdownTable([
      { label: '事实行数', value: fmt(ad.rows) },
      { label: '覆盖周期', value: periodValue },
      { label: '曝光', value: fmt(ad.impressions) },
      { label: '点击', value: fmt(ad.clicks) },
      { label: '订单（广告归因）', value: fmt(ad.orders) },
      { label: '花费', value: fmt(ad.spend) },
      { label: '销售额（广告归因）', value: fmt(ad.sales) },
    ], [{ label: '项', value: row => row.label }, { label: '值', value: row => row.value }]))
    lines.push('')
    lines.push('> ⚠️ 这两列是**广告报告里的归因数字**，按关键词记录。它们既不是全店营收，'
      + '也不覆盖没有投放广告的关键词 —— 见附录第一条。')
  }
  lines.push(...renderGaps(gaps))
  return {
    title: '运营汇总',
    refKey: 'all',
    scope: { productLine: ctx.productLine ?? null },
    body: lines.join('\n'),
  }
}

/* ───────────────────────── 分派 ───────────────────────── */

const BUILDERS = {
  'data-quality': buildDataQuality,
  collection: buildCollection,
  'asin-health': buildAsinHealth,
  'competitor-gap': buildCompetitorGap,
  'rule-policy-impact': buildRulePolicyImpact,
  'prompt-agent-eval': buildPromptAgentEval,
  'post-publication': buildPostPublication,
  'ops-summary': buildOpsSummary,
}

/** The kinds `amzn_report_build` accepts, derived from the same table. */
export function isGeneratedKind(kind) {
  return Object.prototype.hasOwnProperty.call(BUILDERS, String(kind ?? '').trim())
}

/**
 * Build one report's Markdown.
 *
 * Returns `{ok:false, code, error, hint?}` for anything that is not "there is a
 * document": an unknown kind (including the three that are *indexed*, not
 * generated — asking to build those would produce a second copy of a body that
 * already lives elsewhere), a missing scope, or a missing dependency. It never
 * returns an empty document, because an empty report is indistinguishable from a
 * report whose data was missing.
 *
 * `ctx` carries the scope (`asin`, `marketplace`, `productLine`), the clock, and
 * the one injected dependency `precheckFor` (module 13's, which is where the nine
 * gates are judged — recomputing them here would be a second criterion).
 */
export function buildReport(store, { kind, asin = null, marketplace = null, productLine = null, now, precheckFor = null } = {}) {
  const id = String(kind ?? '').trim()
  if (id === '') return { ok: false, code: 'KIND_REQUIRED', error: 'kind 是必填项', hint: `可用：${GENERATED_KINDS.join(' / ')}` }
  const spec = reportKindSpec(id)
  /**
   * **The table is the authority**, in both directions.
   *
   * An id the table does not know is refused even when `BUILDERS` happens to have
   * a function for it: the table is what the tool, the route payload and the search
   * all read, so a builder for an unknown id is a row nobody could open. The
   * refusal has to be **clean** — the first version of this check only looked at
   * `BUILDERS` and let such an id through, where it crashed on
   * `reportKindSpec(id).source` (found by the falsification run that deleted an
   * entry: `TypeError: Cannot read properties of null (reading 'source')`).
   */
  if (spec === null) {
    return {
      ok: false,
      code: 'NOT_GENERATED',
      error: `未知的报告类别 "${id}"`,
      hint: `可用：${GENERATED_KINDS.join(' / ')}`,
    }
  }
  /* `isGeneratedKind` is the same predicate the tool's `parameters` description is
     built from; asking it here instead of testing `BUILDERS[id]` keeps one answer
     to "is this a kind we can build" rather than two that could disagree. */
  if (!isGeneratedKind(id)) {
    return {
      ok: false,
      code: 'NOT_GENERATED',
      error: `"${id}" 是索引型报告，不生成正文`,
      hint: `${spec.label} 的正文在 ${spec.source}，由 ${spec.writer} 登记；这里再生成一份就是第二份正文。`,
    }
  }
  const build = BUILDERS[id]
  const at2 = now ?? systemClock()
  const result = build(store, { asin, marketplace, productLine, now: at2, precheckFor })
  if (result.ok === false) return result
  return {
    ok: true,
    kind: id,
    title: result.title,
    refKey: result.refKey,
    scope: result.scope,
    body: result.body,
    reportId: reportIdOf(id, result.refKey, at2),
    now: at2,
  }
}

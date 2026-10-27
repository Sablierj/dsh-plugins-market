/**
 * 「这份导出件代表哪一刻的什么」—— 数据新鲜度的**判据**，只有一份。
 *
 * ## 为什么这不是一句话
 *
 * 审计给 F14-10 的第 3 条是「导出的报告必须声明它不是实时数据」，全仓 grep
 * 「非实时」0 命中。加四个字很容易，但四个字**推不出来**任何东西：读者拿到的是一份
 * 文件，他要知道的是
 *
 *   ① 它是哪一刻的字节（生成时刻）；
 *   ② 里面的观测数据最晚到哪一刻（数据截止，来自这一轮冻结的证据包）；
 *   ③ 两者差多久（一个能被重算的数字，不是形容词）；
 *   ④ 哪些类别**根本没有**、哪些**只有一部分**、哪些**只有当前值没有历史** ——
 *      这三件事都不影响「报告是对的那一刻」，但都会让「拿它当今天的数」出错。
 *
 * 所以这里的输出不是一个字符串，而是一组**从库里算出来的量** + 由这些量拼出来的句子。
 * 句子由数据拼，不是写在模板里：`statement` 的每一段都对应下面一个字段，改一个数，
 * 句子跟着变。
 *
 * ## 词汇不新造
 *
 * 「没有」的四种说法已经在 `domain/reports/gaps.js`（F14-01）：「本仓没有该来源」/
 * 「本仓没有为它建模」/「有来源，但还没有记录」/「读到了，答案是 0」。本模块把它们
 * 套到两类东西上，映射理由写在 `metricAbsences`（指标）与本文件的 `evidenceAbsence`
 * （证据包）里，**没有第五种说法**。
 *
 * ## 一律不读今天的活数据
 *
 * 数据截止只从**这一轮冻结的证据包**算（`standards.js#dataCutoffOf` 的文件头讲了
 * 为什么）——本模块连 `store` 都不接，参数就是已经读出来的行。这不是洁癖：报告要能
 * 在三个月后仍然解释得通，而「三个月后重新算一遍今天的样子」会让文件里印着的数字
 * 与它自己的来源打架。
 */

import { metricAbsences } from '../reports/gaps.js'
import { OBSERVATION_METRICS } from '../observe/metrics.js'
import { dataCutoffOf } from './standards.js'

/** 这一份导出件的性质。**一个常量，三种渲染都念它** —— 不许各写一遍。 */
export const REALTIME_LABEL = '非实时'

const ABSENT = '—'

/**
 * 证据包一类 → 四态里的一态。
 *
 * `frozen` 且 `count: 0` 是 **`measured-zero`**：读过、答案是 0，这不是缺口。
 * `absent` 是 **`not-recorded`**：来源在仓里，这一类在这个对象上还没有（跑一次就会
 * 有）。`not_modelled` 直译成 **`not-modelled`**。`frozen` 且有内容 → 没有结论要说。
 *
 * 返回 `{kind, conclusion, action, hole}`，其中 `hole === true` 表示它真的是一个
 * 「读不到的东西」（`measured-zero` 不是 —— 把它列进缺口清单会让「0 就是结论」读成
 * 「缺数据」，正是 F14-01 在防的那件事）。
 */
function evidenceAbsence(row) {
  const status = String(row?.status ?? '')
  if (status === 'not_modelled') {
    return {
      kind: 'not-modelled',
      conclusion: '本仓没有为它建模',
      action: '需求点名了它，落点从未建；这是一个可以开批次的缺口。',
      hole: true,
    }
  }
  if (status === 'absent') {
    return {
      kind: 'not-recorded',
      conclusion: '有来源，但还没有记录',
      action: '来源在，只是这一次还没有记录 —— 跑一次对应的动作就会有。',
      hole: true,
    }
  }
  if (status === 'frozen' && Number(row?.count ?? 0) === 0) {
    return {
      kind: 'measured-zero',
      conclusion: '读到了，答案是 0',
      action: '这是一次真实的测量结果，0 就是结论，不要读成「缺数据」。',
      hole: false,
    }
  }
  return null
}

/** 指标可用性的中文说法 —— 与 `domain/observe/metrics.js` 的三个值一一对应。 */
const AVAILABILITY_LABELS = { yes: '可用', partial: '只有一部分', no: '没有来源' }
const HISTORY_LABELS = { 'append-only': '有追加历史', 'current-only': '只有当前值' }

/**
 * The gap between the moment the file was produced and the newest observation in it.
 *
 * `null` when either side is unknown — never 0. "We do not know how old this is"
 * and "it is current" are the two claims this whole module exists to keep apart.
 */
function lagOf(generatedAt, cutoffAt) {
  if (generatedAt === null || generatedAt === undefined || cutoffAt === null || cutoffAt === undefined) return null
  const generated = Date.parse(String(generatedAt))
  const cut = Date.parse(String(cutoffAt))
  if (!Number.isFinite(generated) || !Number.isFinite(cut)) return null
  const ms = generated - cut
  const order = ms === 0 ? 'same' : (ms > 0 ? 'before' : 'after')
  const days = Math.floor(Math.abs(ms) / 86_400_000)
  const hours = Math.floor(Math.abs(ms) / 3_600_000)
  let text
  if (order === 'same') text = '与生成时刻相同'
  else if (days >= 1) text = `${order === 'before' ? '早' : '晚'} ${days} 天`
  else if (hours >= 1) text = `${order === 'before' ? '早' : '晚'}不到 1 天（${hours} 小时）`
  else text = `${order === 'before' ? '早' : '晚'}不到 1 小时`
  return { ms, order, days, hours, text }
}

/** `2026-10-19T07:00:00.000Z` → `2026-10-19 07:00`（UTC，本仓唯一的时区）。 */
function stamp(iso) {
  if (iso === null || iso === undefined || String(iso).trim() === '') return null
  const text = String(iso)
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? `${text.slice(0, 10)} ${text.slice(11, 16)}` : text
}

/**
 * Build the freshness verdict for one export artifact.
 *
 * Every input is a row or a value that came out of the store; nothing here reads
 * the clock. That is what makes the header checkable: a test recomputes each of
 * these from the database and compares it with what the file says.
 */
export function buildFreshness({
  run = {},
  evidence = null,
  cutoff = null,
  metrics = OBSERVATION_METRICS,
} = {}) {
  const cutoffInfo = cutoff ?? dataCutoffOf({ evidence })
  const generatedAt = run?.finished_at ?? run?.started_at ?? null

  /* 证据包逐类：状态、来源、时间、以及它落进四态里的哪一态。 */
  const evidenceRows = (Array.isArray(cutoffInfo.rows) ? cutoffInfo.rows : []).map(row => {
    const absence = evidenceAbsence(row)
    return {
      kind: row.kind,
      label: row.label,
      status: row.status,
      statusLabel: { frozen: '冻结', absent: '不存在', not_modelled: '未建模' }[row.status] ?? row.status,
      at: row.at,
      source: row.source,
      count: row.count,
      absence,
    }
  })
  const holes = evidenceRows.filter(row => row.absence?.hole === true)

  /* 指标逐条：九类观测的可用性、历史与四态结论。 */
  const metricRows = (Array.isArray(metrics) ? metrics : []).map(metric => {
    const absences = metricAbsences(metric, { feature: 'F14-07' })
    return {
      id: metric.id,
      label: metric.label,
      availability: metric.availability ?? 'no',
      availabilityLabel: AVAILABILITY_LABELS[metric.availability] ?? metric.availability ?? ABSENT,
      history: metric.history ?? null,
      historyLabel: metric.history === null || metric.history === undefined ? ABSENT : (HISTORY_LABELS[metric.history] ?? metric.history),
      table: metric.table ?? null,
      absences,
    }
  })
  const metricGaps = metricRows.flatMap(row => row.absences)
  const absences = [...holes.map(row => ({
    kind: row.absence.kind,
    id: row.kind,
    label: `证据「${row.label}」`,
    feature: 'F13-03',
    conclusion: row.absence.conclusion,
    action: row.absence.action,
    reason: row.status === 'not_modelled'
      ? `这一类在本仓没有表、没有读取口、没有采集节 —— 十一类证据里它是「未建模」那一类。`
      : `这一份证据在冻结时被记为「不存在」：对象本身缺，或这一轮没有输入。它不是「0 条」。`,
  })), ...metricGaps]

  const counts = {
    /* 证据包：三类状态各多少（含 `frozen`），以及带日期的类数。 */
    evidenceFrozen: evidenceRows.filter(row => row.status === 'frozen').length,
    evidenceAbsent: evidenceRows.filter(row => row.status === 'absent').length,
    evidenceNotModelled: evidenceRows.filter(row => row.status === 'not_modelled').length,
    evidenceKinds: evidenceRows.length,
    evidenceDated: cutoffInfo.dated ?? 0,
    /* 四态：登记进缺口清单的每一态各多少。`measured-zero` 单独一类 —— 它是发现，
       不是缺口，所以它不进 `absenceEntries` 的分子里说明「读不到」的那部分。 */
    absenceEntries: absences.length,
    absenceNoSource: absences.filter(entry => entry.kind === 'no-source').length,
    absenceNotModelled: absences.filter(entry => entry.kind === 'not-modelled').length,
    absenceNotRecorded: absences.filter(entry => entry.kind === 'not-recorded').length,
    measuredZero: evidenceRows.filter(row => row.absence?.kind === 'measured-zero').length,
    /* 指标：三档可用性各多少。 */
    metrics: metricRows.length,
    metricsNoSource: metricRows.filter(row => row.availability === 'no').length,
    metricsPartial: metricRows.filter(row => row.availability === 'partial').length,
    metricsCurrentOnly: metricRows.filter(row => row.history === 'current-only').length,
  }

  const lag = lagOf(generatedAt, cutoffInfo.value)

  /* ── 一句话：每一段都对应上面一个字段 ─────────────────────────────────────── */
  const clauses = []
  clauses.push(generatedAt === null
    ? '这一轮**没有记录生成时刻**（`optimization_run.finished_at` 与 `started_at` 都是空的）—— 那是「没有记录」，不是「刚刚生成」'
    : `本文件是 ${generatedAt} 那一刻的字节`)
  if (cutoffInfo.state === 'dated') {
    clauses.push(`里面的观测数据最晚到 ${cutoffInfo.value}（${cutoffInfo.label}）${lag === null ? '' : `，${lag.text}`}`
      + `；证据包 ${counts.evidenceKinds} 类里 ${counts.evidenceDated} 类带日期`)
  } else if (cutoffInfo.state === 'undated') {
    clauses.push(`数据截止**读不到**：证据包在（${counts.evidenceKinds} 类），但没有一类带观测时间 —— 这不是「截止时间是 0」`)
  } else {
    clauses.push('数据截止**读不到**：这一轮没有冻结的证据包 —— 这不是「截止时间是空的」')
  }
  if (holes.length > 0) {
    clauses.push(`证据里 ${holes.length} 类读不到（逐类在「数据新鲜度」一节）`)
  }
  if (absences.length > 0) {
    clauses.push(`另有 ${metricGaps.length} 条指标口径限制：${counts.metricsNoSource} 条本仓没有来源、`
      + `${counts.metricsPartial} 条只有一部分口径、${counts.metricsCurrentOnly} 条只有当前值没有历史`)
  }
  clauses.push('之后发生的变化**不会**出现在这份文件里 —— 要新的，重新采集并收尾一轮')

  const cutoffText = cutoffInfo.state === 'dated'
    ? cutoffInfo.value
    : (cutoffInfo.state === 'undated' ? '读不到（证据包无日期）' : '读不到（这一轮没有证据包）')

  return {
    /* 这一份文件不是实时数据 —— 机器可读的形式，三种渲染都印。 */
    realtime: false,
    label: REALTIME_LABEL,
    state: cutoffInfo.state,
    generatedAt,
    generatedLabel: stamp(generatedAt),
    cutoff: {
      state: cutoffInfo.state,
      value: cutoffInfo.value,
      label: cutoffInfo.label,
      kind: cutoffInfo.kind ?? null,
      text: cutoffText,
      kinds: cutoffInfo.kinds ?? 0,
      dated: cutoffInfo.dated ?? 0,
      rows: cutoffInfo.rows ?? [],
    },
    lag,
    /* 头部的「值」那一格（可切片、可读回对账）；「这一格是怎么来的」是 statement。 */
    headline: `${REALTIME_LABEL} · 数据截止 ${cutoffText}`
      + (lag === null ? '' : ` · ${lag.text}`)
      + ` · 证据 ${counts.evidenceKinds} 类（${counts.evidenceFrozen} 冻结 / ${counts.evidenceAbsent} 不存在 / ${counts.evidenceNotModelled} 未建模）`,
    statement: `${REALTIME_LABEL}：${clauses.join('；')}。`,
    evidence: {
      rows: evidenceRows,
      counts,
      holes,
    },
    metrics: {
      rows: metricRows,
      counts: {
        total: counts.metrics,
        noSource: counts.metricsNoSource,
        partial: counts.metricsPartial,
        currentOnly: counts.metricsCurrentOnly,
      },
    },
    absences,
    counts,
  }
}

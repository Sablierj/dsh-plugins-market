/**
 * 校验体系（F13-08）—— 规则 / 闸门 / Agent 审阅三块，一个入口。
 *
 * ## 为什么需要这个文件
 *
 * 审计 `RESEARCH-module-alignment-v2.0.md:353` 说这个模块是「有出口、没有闭环」的
 * 典型形态，而 F13-08 那一行的结论是**一半已实现**：规则校验与完成闸门分开了显示
 * （「合法 ≠ 完整」这半），但 Agent 审阅那半只有一张静态清单。逐条实测下来，页面上的
 * 形态比审计写的还要散：
 *
 *   · 闸门画在 `optrun` 那一条里（`page.js` 的 `gateBlock` 被 `:3932` 调用），
 *     **没有 `sect-` 落点** —— 锚点跳不进去，通知也指不到它；
 *   · 规则在页面上只有 `violationChips(run.counts)` 两个数字，逐条违规只散在每个
 *     字段的卡片里；
 *   · 审阅**连载荷都没有**；
 *   · 三者没有统一入口：工具侧的 `amzn_optimize_validate` 是**草案级**的
 *     （它要求一份 draft 作入参），答不了「这一轮的校验体系是什么样」。
 *
 * 所以这个文件是**一个投影**，不是新的一份计算：三小节的每一行都来自
 * `describeOptimizationRun`（规则命中与闸门都是它算的）与 `readReview`（Agent 审阅）。
 * 这带来本仓最看重的那条性质 —— **页面没有第二条能自己算出来的路**：
 * 把域层改坏，工具侧与页面侧的两条断言必须同时红。
 *
 * ## 「什么时候判的」必须说出来
 *
 * `rules` 与 `gates` 的口径**今天就不一样**，本批不改它，但要把它写明：
 *
 *   · 规则命中读的是**这一轮 validate 时写下的那一份**（`violations_json`）。
 *     收件箱的「阻断/警告」列、轮次表头的 chip 也读它 —— 同一屏上必须是一个数字。
 *   · 闸门是对**当前草案**现算的（`runGates`），与报告第八章同源。
 *
 * 两者不一致是**真会发生的**（listing 在这一轮开始之后变过），所以 `judge` 把两个时刻
 * 各说一句，而不是把两个数字压成一个。压成一个的后果是本仓反复见过的那种：
 * 同一份东西在两个地方有两个数字，两边都不报错。
 *
 * ## 三个「没有」分开
 *
 * 没选一轮（`view` 为 null 且 run 不存在）/ 这一轮没有字段草稿（`rules.empty`）/
 * 这一轮还没有人审过（`review.present === false`，14 项全是 `pending`）。
 * 压成一个灰框会让「没人审过」读成「审过都没问题」。
 *
 * English comments explain why; a comment that disagrees with the code is a defect here.
 */

import { describeOptimizationRun } from './run-view.js'
import { readReview } from './review.js'
/* 字段标签只有一处实现（`labelForField`），页面与报告都用它 —— 这里也不另写一张表。 */
import { labelForField } from '../rules/listing-fields.js'
/* `getOptimizationRun`（不是裸 SELECT）：`describeOptimizationRun` 要的是**带 drafts
   的**那一整行。第一版这里写的是 `store.get('SELECT * FROM optimization_run …')`，
   于是 run view 在 `draftFieldsOf(run.drafts)` 上炸了 —— 裸行没有 drafts。
   这是「同一个对象的两个读法长得一样、内容不同」的典型，只有真跑才会发现。 */
import { getOptimizationRun } from '../../store/queries.js'

export const VALIDATION_VERSION = 'optimize-validation-system.v1'

export const VALIDATION_SOURCE =
  '规则命中：optimization_draft.violations_json（这一轮 validate 时写下的）· 闸门：runGates（对当前草案现算）· 审阅：optimization_review（schema v44）'

export const VALIDATION_CODES = {
  NO_RUN: 'VALIDATION_NO_RUN',
  RULES_COUNT_MISMATCH: 'RULES_COUNT_MISMATCH',
  REVIEW_UNAVAILABLE: 'REVIEW_UNAVAILABLE',
}

/** The two severities that carry weight. Anything else is reported but not counted. */
const COUNTED_SEVERITIES = ['block', 'warn']

/**
 * 规则命中逐条展开。
 *
 * 一行 = 一条**存在某个字段上**的违规。同一份草稿里 `bullets` 级别的违规会被写进
 * 5 个 bullet 草案（`tools/optimize.js` 的 persist 就是这么筛的），所以同一句话会在
 * 这里出现 5 次 —— 那是**存储的真实形状**，不是重复计算。为了让读者看得到这件事，
 * `distinct` 与 `duplicates` 一起交出去，而不是替他把行去重（去重会让 `counts`
 * 与表头那个数字不一样，而那两个数字必须是同一个）。
 */
function ruleRows(drafts) {
  const rows = []
  for (const draft of Array.isArray(drafts) ? drafts : []) {
    const onField = String(draft?.field ?? '')
    for (const violation of Array.isArray(draft?.violations) ? draft.violations : []) {
      const severity = String(violation?.severity ?? '')
      rows.push({
        /* 挂在哪个字段的草案上 */
        draftField: onField,
        draftFieldLabel: draft?.label ?? onField,
        /* 规则自己报的字段（可能是 `draft` / `bullets` 这种聚合字段，与上面不同） */
        field: String(violation?.field ?? onField),
        fieldLabel: labelForField(String(violation?.field ?? onField)),
        ruleId: String(violation?.ruleId ?? ''),
        severity,
        source: violation?.source ?? null,
        title: violation?.title ?? null,
        messages: Array.isArray(violation?.messages) ? violation.messages : [],
      })
    }
  }
  return rows
}

function countSeverities(rows) {
  const counts = { block: 0, warn: 0 }
  for (const row of rows) {
    if (COUNTED_SEVERITIES.includes(row.severity)) counts[row.severity] += 1
  }
  return counts
}

/**
 * One run's validation system: the three panels, resolved.
 *
 * `view` is `describeOptimizationRun`'s output when the caller already has it — the
 * page does, and passing it is not an optimisation but a **guarantee**: the run
 * header's gate chip and the gates panel would otherwise be two computations of one
 * verdict, and the day they disagree nobody gets an error.
 */
export function readValidationSystem(store, runId, { view = null } = {}) {
  const run = getOptimizationRun(store, String(runId ?? '').trim())
  if (run === null || run === undefined) {
    return {
      ok: false,
      code: VALIDATION_CODES.NO_RUN,
      error: `没有第 ${String(runId ?? '').trim().slice(0, 8)} 轮优化 —— 校验体系挂在轮次上，先跑一次 amzn_optimize_prepare。`,
    }
  }

  const described = view ?? describeOptimizationRun(store, run)
  const drafts = Array.isArray(described?.drafts) ? described.drafts : []

  const rows = ruleRows(drafts)
  const counts = countSeverities(rows)
  const persisted = {
    block: Number(described?.counts?.block ?? 0),
    warn: Number(described?.counts?.warn ?? 0),
  }
  const distinctKeys = new Set(rows.map(row => `${row.field}\u0000${row.ruleId}\u0000${row.messages.join('；')}`))
  const uncounted = rows.filter(row => !COUNTED_SEVERITIES.includes(row.severity)).length

  const gates = described?.gates ?? null
  const review = readReview(store, run.id)

  return {
    ok: true,
    runId: run.id,
    asin: run.asin,
    marketplace: run.marketplace,
    status: run.status,
    /* 「这一轮有没有东西可判」与「判的结果」分开：没有草案时三块各自说自己的「没有」。 */
    present: drafts.length > 0,
    version: VALIDATION_VERSION,
    source: VALIDATION_SOURCE,
    judge: {
      /* 规则命中是这一轮 validate 时写下的那一份。 */
      rulesAt: 'persisted',
      /* 闸门是对当前草案现算的 —— 与报告第八章同源。 */
      gatesAt: 'live',
      /* 判定用的是哪一套规则：`rosterForValidation` 的产出，与工具侧逐字同一个对象。 */
      roster: described?.roster === null || described?.roster === undefined
        ? null
        : {
          origin: described.roster.origin ?? null,
          version: described.roster.version ?? null,
          source: described.roster.source ?? null,
          count: described.roster.count ?? null,
          fromCode: described.roster.fromCode === true,
        },
      note: '规则命中读的是这一轮 validate 时写下的那一份（与收件箱、表头 chip 同一个数字）；'
        + '闸门是对当前草案现算的。listing 在这一轮开始之后变过，两者就会不同 —— 这里不把它们压成一个。',
    },
    rules: {
      counts: { ...counts, total: counts.block + counts.warn },
      persisted,
      /* 两个数字不由同一段代码得出就必须比对：`counts` 数的是上面的行，
         `persisted` 是收件箱与表头用的那个数（`countViolations`）。不等就是投影漏了。 */
      drift: counts.block !== persisted.block || counts.warn !== persisted.warn,
      rows,
      distinct: distinctKeys.size,
      duplicates: rows.length - distinctKeys.size,
      /* severity 不是 block/warn 的行：它们进 `rows`（看得见）但不进 `counts`（没权重）。
         今天恒为 0；不为 0 时读者必须知道，否则「0 阻断」会看起来像「什么都没发生」。 */
      uncounted,
      empty: drafts.length > 0
        ? null
        : {
          kind: 'no-drafts',
          text: '这一轮还没有字段被校验过 —— 这不是「0 条违规」，是**没有可判的东西**。'
            + '先调 amzn_optimize_validate（带 persist）把草案写进这一轮。',
        },
    },
    gates: gates === null
      ? {
        passed: 0,
        total: 0,
        ok: false,
        rows: [],
        empty: { kind: 'no-run-view', text: '这一轮的门禁读不出来（没有 run view）—— 与「六道门全过」不是一件事。' },
      }
      : {
        passed: gates.passed,
        total: gates.total,
        ok: gates.ok === true,
        rows: (gates.rows ?? []).map(row => ({
          id: row.id,
          label: row.label,
          /* 判据与依据一起带出来：一个只有 label 与 pass 的闸门行，读者只能猜它为什么没过。 */
          what: row.what ?? null,
          source: row.source ?? null,
          pass: row.pass === true,
          detail: row.detail ?? null,
        })),
        empty: (gates.rows ?? []).length > 0
          ? null
          : { kind: 'no-gates', text: '六道闸门一条都没跑出来 —— 这不是「全过」。' },
      },
    review,
    counts: {
      rules: rows.length,
      rulesBlock: counts.block,
      rulesWarn: counts.warn,
      gatesPassed: gates?.passed ?? 0,
      gatesTotal: gates?.total ?? 0,
      reviewItems: review.ok === true ? review.counts.items : 0,
      reviewPending: review.ok === true ? review.counts.pending : 0,
      reviewConcluded: review.ok === true ? review.counts.items - review.counts.pending : 0,
    },
    empty: null,
  }
}

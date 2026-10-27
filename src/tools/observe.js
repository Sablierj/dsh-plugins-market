/**
 * 模块 14 §6/§7 的四个工具：把「发布」这件事变成可登记、可查、可处置的事实。
 *
 * ## 这一批不做什么（写在最前面，因为边界比能力更容易被误读）
 *
 *   - **不发布**。本插件没有、也不会有一个能改 Seller Central 的工具（§15 的发布
 *     边界，模块 12 的 ⑧ 号断言专门守着这件事）。所以这里的「登记」永远是
 *     「运营在后台改完了，回来记一笔」。
 *   - **不算效果**。§8 的观测卡片（amzn_observation_list / _check）与 §9 的回滚交付包
 *     （amzn_rollback_suggest / _list）各自已经是能跑的工具；这一组工具提供的是它们的
 *     **起点**：一次发布、它的批准基线、它偏离没偏离、处置了没有。原先这里写的是「是下一批」，
 *     那句话在模块 14 那几批交付之后就过期了。
 *
 * ## 三个工具都刻意不替人做判断
 *
 * `publication_record` 不猜运营改了什么 —— 它要你交实际值；`publication_list` 不把
 * 「有发布记录」说成「已上线」（§6 的原话是**没有**发布记录时不得显示已上线，所以
 * 反过来，有记录也只是「登记过」）；`observation_plan_save` 不把一份超预算的声明
 * 悄悄收下，它拒收并告诉你怎么改。
 */

import { table, text } from './render.js'
import {
  activeObservationPlan, awaitingBaselineChoice, ensureCheckpoints,
  getPublication, listObservationPlans, listPublicationObservations, listPublications,
  listRollbackTasks, publicationObservation, publicationRate, recordPublication,
  saveObservationConclusion, saveObservationPlan, scanDueObservations,
  setBaselineChoice, suggestRollback, PUBLICATION_KINDS, BASELINE_CHOICES,
} from '../store/observe.js'
import { DEV_DEVIATION_RATIO, CORE_FIELDS } from '../domain/observe/deviation.js'
import { approvalRefusal } from '../domain/approval/policy.js'
import { DEFAULT_WINDOW_DAYS, PLAN_BULLET_LIMIT, PLAN_CHANGE_RATIO } from '../domain/observe/plan.js'
import { CONCLUSION_LABELS, OBSERVATION_CONCLUSIONS } from '../domain/observe/observation.js'

const KIND_LABELS = { draft: '草案发布', manual: '手工登记', rollback: '回滚' }

/** 卡片级状态的词。§6 的 waiting_human 与 §8/§9 的四个并列出现，所以放在一起。 */
const CARD_STATE_LABELS = {
  waiting_human: '待人工处置（偏离草案）',
  pending: '等待观测节点',
  ready: '可下结论',
  blocked: '数据不足',
  concluded: '已结论',
  terminated: '已回滚终止',
}

function short(value, max = 60) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 一个字段值的一行摘要 —— 值是整段文案，不能整段铺在终端里。 */
function valueLine(value) {
  if (value === null || value === undefined) return '（空）'
  const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return short(rendered, 70)
}

function deviationLines(record) {
  if (record.kind === 'manual') {
    return ['  差异：不计算 —— 手工登记不参与草案差异与发布率统计（§6）。']
  }
  const deviation = record.deviation
  if (deviation === null || deviation === undefined) return ['  差异：未计算（这条记录没有关联运行）。']
  const lines = [
    `  批准基线 ${deviation.total} 个字段，实际改动 ${deviation.changedCount} 个`
    + `（${(deviation.ratio * 100).toFixed(1)}%，阈值 ${DEV_DEVIATION_RATIO * 100}%）`,
  ]
  for (const entry of deviation.changed) {
    lines.push(`    · ${entry.field}: 批准「${valueLine(entry.approved)}」 → 实际「${valueLine(entry.published)}」`)
  }
  if (deviation.coreChanged.length > 0) {
    lines.push(`  核心字段被改动：${deviation.coreChanged.join('、')} —— 核心字段的定义见 ${CORE_FIELDS.join(' / ')}`)
  }
  if (deviation.uncovered.length > 0) {
    lines.push(
      `  发布里出现了批准草案没覆盖的字段：${deviation.uncovered.join('、')}`
      + ' —— 已记录但**不计入**差异比值：拿不到线上副本时无法区分「粘了本次没动的字段」和「自己编了个值」，'
      + '计入会让每次整段粘贴都判偏离。',
    )
  }
  if (record.deviated) {
    lines.push(
      `  ⚠ 已偏离批准草案（判据：${record.deviationRule === 'core-field' ? '核心字段被改动' : '差异字段数超过阈值'}）。`
      + '处置二选一：'
      + `amzn_publication_baseline_decide(publicationId: "${record.id}", choice: "reobserve")`
      + ' = 以实际发布值为新基线重新观测（原观测计划作废并留痕）；'
      + 'choice: "mispublish" = 标记为误发布，进入回滚建议流程（§9）。未处置前该 ASIN 的观测卡片为 waiting_human。',
    )
  } else {
    lines.push('  ✓ 与批准草案一致，无需处置。')
  }
  if (record.baselineChoice !== null) {
    lines.push(`  处置：${record.baselineChoice === 'reobserve' ? '以实际发布值为新基线' : '标记为误发布'}（${record.baselineDecidedAt}）`)
  }
  return lines
}

export function publicationRecordTool({ store }) {
  return {
    name: 'amzn_publication_record',
    description:
      'Register one publication: what was actually changed in Seller Central, and by whom. '
      + '**This plugin never publishes anything** — this is the human recording what they already did by hand (§6). '
      + 'kind: "draft" ties the record to an optimization run and the draft version that was approved, and the difference '
      + 'against that approved draft is computed and frozen right here (core field changed, or more than '
      + `${DEV_DEVIATION_RATIO * 100}% of fields differ → 已偏离). `
      + 'kind: "manual" is a record with no run at all — §6 keeps it out of '
      + 'the deviation and out of the publication rate, so passing a runId with it is refused. kind: "rollback" must name the '
      + 'publication record it rolls back. '
      + 'Once a record is deviated, a human must decide how to treat it — see amzn_publication_baseline_decide. '
      + 'A workspace that turned on 设置中心 → 审批策略 → 标记发布 (approval.markPublished) gets this call refused until '
      + 'it is sent again with confirm: true — this is the action that switch is named after.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'The ASIN that was published. Must match the run\'s ASIN when runId is given.' },
        marketplace: { type: 'string', description: 'e.g. US. Must match the run\'s marketplace when runId is given.' },
        kind: { type: 'string', enum: PUBLICATION_KINDS, description: 'draft (tied to a run) / manual (hand-registered) / rollback.' },
        runId: { type: 'string', description: 'The optimization run this publication came from. Required for kind=draft, forbidden for kind=manual.' },
        draftVersion: {
          type: 'number',
          description: 'The draft version that was approved. Required for kind=draft, and it must equal the run\'s current '
            + 'draft_version — a version that has moved on means the approval this describes no longer exists.',
        },
        published: {
          type: 'object',
          description: 'The field → value pairs actually published. Keys are the draft field names (title, bullet_1, '
            + 'description, search_terms, item_highlights, …). Must not be empty.',
        },
        rollbackOf: { type: 'string', description: 'For kind=rollback: the publication record id being rolled back.' },
        operator: { type: 'string', description: 'Who did it.' },
        note: { type: 'string' },
        evidenceRef: { type: 'string', description: 'A screenshot / file reference, if any.' },
        publishedAt: { type: 'string', description: 'ISO timestamp of the publish. Defaults to now.' },
        observationStartAt: { type: 'string', description: 'ISO timestamp the observation window starts from. Defaults to publishedAt (§9 re-times it from the record).' },
        rollbackProtected: { type: 'boolean', description: 'Whether this publication should be protected from rollback.' },
        confirm: {
          type: 'boolean',
          description: 'Set true to pass 审批策略 → 标记发布 when that secondary confirmation is switched on in this workspace.',
        },
      },
      required: ['asin', 'marketplace', 'kind', 'published'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        /* `approval.markPublished` 的闸门。**这个开关以前没有动作读它** —— 登记这项的
           note 当时写的是「真正的『标记发布』动作不存在（属模块 14）」。模块 14 交付之后
           那句话过期了：`amzn_publication_record` 就是那个动作本身。所以闸门接在这里，
           而不是再留一个没人读的开关（只翻声明不接调用方，会造出「打开了却没反应」）。 */
        const refusal = approvalRefusal(store, 'markPublished', args?.confirm,
          '这会写一条发布记录（§6 的「标记发布」）。确认无误就再调一次并带 confirm: true。')
        if (refusal !== null) return refusal
        const record = recordPublication(store, {
          asin: args?.asin,
          marketplace: args?.marketplace,
          kind: args?.kind,
          runId: args?.runId ?? null,
          draftVersion: args?.draftVersion ?? null,
          published: args?.published ?? {},
          rollbackOf: args?.rollbackOf ?? null,
          operator: args?.operator ?? null,
          note: args?.note ?? null,
          evidenceRef: args?.evidenceRef ?? null,
          publishedAt: args?.publishedAt ?? null,
          observationStartAt: args?.observationStartAt ?? null,
          rollbackProtected: args?.rollbackProtected === true,
        })
        const lines = [
          `发布记录已登记: ${record.id}`,
          `${record.asin} · ${record.marketplace} · ${KIND_LABELS[record.kind] ?? record.kind}`
          + `    发布时间 ${record.publishedAt}    观测起点 ${record.observationStartAt}`,
        ]
        if (record.runId !== null) {
          lines.push(`关联运行 ${record.runId} · 草案版本 v${record.draftVersion}`)
        }
        lines.push(`实际发布 ${Object.keys(record.published).length} 个字段：`
          + Object.keys(record.published).join('、'))
        lines.push(...deviationLines(record))
        /* §9 的闭环是登记触发的，所以它必须出现在这条命令的输出里 —— 一个「顺手关掉了
           回滚任务、顺手终止了原观测」的副作用如果不说，人就不知道原观测已经结束。 */
        if (record.rollbackClosure !== undefined && record.rollbackClosure !== null) {
          const closure = record.rollbackClosure
          lines.push(`  回滚闭环：${closure.taskId === null ? '没有待发布的回滚任务（这次回滚是直接登记的）' : `已关闭交付包任务 ${closure.taskId}`}`)
          const term = closure.terminated
          lines.push(
            `  原观测（${term.publicationId}）已标注「已回滚终止」：`
            + `${term.terminated} 个节点终止、${term.conclusionsKept} 条结论保留并标注、`
            + `${term.retiredSkipped} 个已退休节点未动。`,
          )
        }
        lines.push('')
        lines.push('这份记录是「登记」，不是「已上线」的证明 —— 系统只记录运营在后台做了什么（本插件不发布）。')
        return lines.join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: 'kind=draft 需要 runId + draftVersion（草案版本必须等于该运行的当前 draft_version）；'
            + 'kind=manual 两者都不能带；kind=rollback 需要 rollbackOf。',
        }
      }
    },
  }
}

export function publicationListTool({ store }) {
  return {
    name: 'amzn_publication_list',
    description:
      'List publication records, or show one in full. Three states are kept apart on purpose (§12-4): what the draft '
      + '**proposed**, what was **approved**, and what was actually **published** — conflating them is how a report ends up '
      + 'claiming something went live when only a suggestion was made. '
      + 'Also reports the publication rate and the records still awaiting a baseline decision. '
      + '**No record means no "已上线"** — a run with no publication record is reported as such, never as published (§6).',
    parameters: {
      type: 'object',
      properties: {
        publicationId: { type: 'string', description: 'Show one record in full, with its deviation and its observation plans.' },
        asin: { type: 'string' },
        marketplace: { type: 'string' },
        kind: { type: 'string', enum: PUBLICATION_KINDS },
        since: { type: 'string', description: 'ISO timestamp — only records published at or after this.' },
        limit: { type: 'number', description: 'Default 50, max 500.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const one = String(args?.publicationId ?? '').trim()
        if (one !== '') {
          const record = getPublication(store, one)
          if (record === null) return { ok: false, error: `no publication record ${one}`, hint: '用 amzn_publication_list 不带参数看列表。' }
          const lines = [
            `发布记录 ${record.id}`,
            `${record.asin} · ${record.marketplace} · ${KIND_LABELS[record.kind] ?? record.kind}`,
            `发布时间 ${record.publishedAt}    观测起点 ${record.observationStartAt}    登记于 ${record.createdAt}`,
            record.runId === null ? '关联运行：无（手工登记）' : `关联运行 ${record.runId} · 草案版本 v${record.draftVersion}`,
            `操作者 ${record.operator ?? '—'}    证据 ${record.evidenceRef ?? '—'}    回滚保护 ${record.rollbackProtected ? '是' : '否'}`,
            '',
            '① 实际发布值:',
            ...Object.entries(record.published).map(([field, value]) => `    ${field}: ${valueLine(value)}`),
            '',
            '② 批准基线（完整目标 listing，采纳用 after / 未采纳用 before）:',
            ...(record.approved === null
              ? ['    （无 —— 手工登记不算草案差异）']
              : Object.entries(record.approved).map(([field, value]) => `    ${field}: ${valueLine(value)}`)),
            '',
            '③ 差异:',
            ...deviationLines(record),
          ]
          const plans = listObservationPlans(store, record.id)
          lines.push('', `④ 观测计划（${plans.length} 份，含已作废）:`)
          if (plans.length === 0) {
            lines.push('    （还没有 —— §7 要求每次存量优化先声明假设、基线、窗口与回滚条件，用 amzn_observation_plan_save 登记）')
          } else {
            for (const plan of plans) {
              lines.push(`    [${plan.status === 'active' ? '当前' : '已作废'}] ${plan.id}`)
              lines.push(`      假设: ${plan.hypothesis ?? '—'}`)
              lines.push(`      窗口: ${plan.windowDays.join('/')} 天    基线: ${plan.baselineStart ?? '—'} ~ ${plan.baselineEnd ?? '—'}`)
              lines.push(`      变更 ${plan.changed.length} 个 / 不变 ${plan.unchanged.length} 个    全量重写: ${plan.rebuild ? '是（按重建读结论）' : '否'}`)
              lines.push(`      成功指标: ${plan.success.join('、') || '—'}    失败指标: ${plan.fail.join('、') || '—'}`)
              lines.push(`      干扰因素: ${plan.confounders ?? '—'}`)
              lines.push(`      回滚条件: ${plan.rollbackConditions ?? '—'}`)
              if (plan.status !== 'active' && plan.supersededReason !== null) lines.push(`      作废原因: ${plan.supersededReason}`)
            }
          }
          return lines.join('\n')
        }

        const listed = listPublications(store, {
          asin: args?.asin ?? null,
          marketplace: args?.marketplace ?? null,
          kind: args?.kind ?? null,
          since: args?.since ?? null,
          limit: args?.limit ?? 50,
        })
        const rate = publicationRate(store, { asin: args?.asin ?? null, marketplace: args?.marketplace ?? null })
        const awaiting = awaitingBaselineChoice(store, { asin: args?.asin ?? null, marketplace: args?.marketplace ?? null })

        const lines = []
        if (listed.rows.length === 0) {
          lines.push('还没有发布记录。')
          lines.push('这不代表没有改过 —— 代表**改了但没人登记**。§6：没有发布记录时，报告不得显示「已上线」。')
          lines.push('运营在 Seller Central 改完之后，用 amzn_publication_record 记一笔。')
        } else {
          lines.push(table(listed.rows, [
            { label: '发布时间', value: row => String(row.publishedAt).slice(0, 19).replace('T', ' ') },
            { label: 'ASIN', value: row => row.asin },
            { label: '站点', value: row => row.marketplace },
            { label: '类型', value: row => KIND_LABELS[row.kind] ?? row.kind },
            { label: '运行', value: row => row.runId ?? '—' },
            { label: '草案版本', value: row => row.draftVersion === null ? '—' : `v${row.draftVersion}` },
            { label: '偏离', value: row => row.deviated ? `是（${row.deviationRule}）` : '否' },
            { label: '处置', value: row => row.baselineChoice ?? (row.deviated ? '待处置' : '—') },
            { label: 'id', value: row => row.id },
          ]))
          lines.push('')
          lines.push(`共 ${listed.total} 条，本页 ${listed.rows.length} 条。`)
        }

        lines.push('')
        lines.push('发布率（§6：手工登记不参与统计）:')
        lines.push(`  分子 ${rate.numerator} / 分母 ${rate.denominator}`
          + ` = ${rate.ratio === null ? '—（无分母）' : `${(rate.ratio * 100).toFixed(1)}%`}    ${rate.note}`)
        if (rate.manualExcluded > 0) lines.push(`  已排除手工登记 ${rate.manualExcluded} 条。`)

        lines.push('')
        if (awaiting.length === 0) {
          lines.push('没有待处置的偏离记录。')
        } else {
          lines.push(`待处置的偏离记录 ${awaiting.length} 条（这些 ASIN 的观测卡片为 waiting_human，§6）:`)
          for (const record of awaiting) lines.push(`  · ${record.id}  ${record.asin}/${record.marketplace}  ${record.publishedAt}`)
          lines.push('用 amzn_publication_baseline_decide 二选一：reobserve / mispublish。')
        }
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

export function publicationBaselineDecideTool({ store }) {
  return {
    name: 'amzn_publication_baseline_decide',
    description:
      '§6\'s handling for a publication that deviated from the approved draft. Two choices, and a human must make one: '
      + '"reobserve" takes the actually-published values as the new baseline (the existing observation plan is superseded '
      + 'with a reason kept on the record, and the observation window restarts from now); "mispublish" marks it as a '
      + 'mistaken publish. The decision is only recorded here — generating the §9 rollback package is a separate call, '
      + 'amzn_rollback_suggest(publicationId), which refuses when there is no earlier actual publication to restore to. '
      + 'Refused when the record did not deviate (there is nothing to decide) and when a decision already exists — the first '
      + 'decision is the one that happened, and re-deciding would silently rewrite it.',
    parameters: {
      type: 'object',
      properties: {
        publicationId: { type: 'string' },
        choice: { type: 'string', enum: BASELINE_CHOICES },
        note: { type: 'string', description: 'Why this choice — appended to the record.' },
      },
      required: ['publicationId', 'choice'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const before = getPublication(store, args?.publicationId)
        const record = setBaselineChoice(store, args?.publicationId, args?.choice, { note: args?.note ?? null })
        const lines = [
          `偏离处置已记录: ${record.id} → ${record.baselineChoice}`,
          record.baselineChoice === 'reobserve'
            ? '以实际发布值为新基线：原观测计划已作废（留痕，未删除），观测窗口自 '
              + `${record.observationStartAt} 重新计时（§6 处置①）。`
            : '标记为误发布：这一步只记处置这一个事实。§9 的回滚交付包要另调 amzn_rollback_suggest(publicationId) '
              + '生成（没有更早的一次实际发布可回时会被拒），本工具不替你生成。',
          '',
          `处置前观测起点 ${before?.observationStartAt ?? '—'} → 现在 ${record.observationStartAt}`,
        ]
        const plans = listObservationPlans(store, record.id)
        if (plans.length > 0) {
          lines.push(`该发布下的观测计划：${plans.map(plan => `${plan.id}[${plan.status}]`).join('、')}`)
        }
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message, hint: '只有「偏离且尚未处置」的记录能处置，且只能处置一次。' }
      }
    },
  }
}

export function observationPlanSaveTool({ store }) {
  return {
    name: 'amzn_observation_plan_save',
    description:
      '§7: declare an existing-listing optimization as a controlled change — before it is observed, not after. '
      + 'Records the hypothesis, the baseline period, which fields change and which stay fixed, the success and failure '
      + 'metrics, the observation window, the confounders, and the rollback conditions. '
      + `A plan claiming to be a small experiment while changing more than ${PLAN_CHANGE_RATIO * 100}% of its fields, or more than `
      + `${PLAN_BULLET_LIMIT} bullets, is **refused** — pass rebuild: true instead, which records it as a rewrite and makes the `
      + 'observation conclusion read as one (§7). Window defaults to §8\'s nodes ' + DEFAULT_WINDOW_DAYS.join('/') + '.',
    parameters: {
      type: 'object',
      properties: {
        publicationId: { type: 'string', description: 'The publication record this plan is for.' },
        hypothesis: { type: 'string', description: 'What you expect to happen and why.' },
        baselineStart: { type: 'string', description: 'Start of the baseline period (before the change).' },
        baselineEnd: { type: 'string', description: 'End of the baseline period.' },
        changed: { type: 'array', items: { type: 'string' }, description: 'Draft field names that change.' },
        unchanged: { type: 'array', items: { type: 'string' }, description: 'Field names deliberately held fixed — the control group for the claim.' },
        success: { type: 'array', items: { type: 'string' }, description: 'Metrics that would confirm the hypothesis.' },
        fail: { type: 'array', items: { type: 'string' }, description: 'Metrics that would refute it.' },
        windowDays: { type: 'string', description: `Observation nodes, e.g. "7,14,30". Defaults to §8's ${DEFAULT_WINDOW_DAYS.join('/')}.` },
        confounders: { type: 'string', description: 'What else could move these metrics (seasonality, ads, competitor moves).' },
        rollbackConditions: { type: 'string', description: 'The condition under which this change should be rolled back.' },
        rebuild: { type: 'boolean', description: 'Set true when this is a full rewrite rather than a small experiment. Required if the change exceeds the budget.' },
      },
      required: ['publicationId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const saved = saveObservationPlan(store, {
          publicationId: args?.publicationId,
          hypothesis: args?.hypothesis ?? null,
          baselineStart: args?.baselineStart ?? null,
          baselineEnd: args?.baselineEnd ?? null,
          changed: args?.changed ?? [],
          unchanged: args?.unchanged ?? [],
          success: args?.success ?? [],
          fail: args?.fail ?? [],
          windowDays: args?.windowDays ?? null,
          confounders: args?.confounders ?? null,
          rollbackConditions: args?.rollbackConditions ?? null,
          rebuild: args?.rebuild === true,
        })
        const plan = saved.plan
        const lines = [
          `观测计划已登记: ${plan.id}`,
          `关联发布: ${plan.publicationId}`,
          `假设: ${plan.hypothesis ?? '—'}`,
          `基线: ${plan.baselineStart ?? '—'} ~ ${plan.baselineEnd ?? '—'}`,
          `变更 ${plan.changed.length} 个字段: ${plan.changed.join('、') || '—'}`,
          `保持不变 ${plan.unchanged.length} 个字段: ${plan.unchanged.join('、') || '—'}`,
          `成功指标: ${plan.success.join('、') || '—'}`,
          `失败指标: ${plan.fail.join('、') || '—'}`,
          `观察窗口: ${plan.windowDays.join(' / ')} 天`,
          `干扰因素: ${plan.confounders ?? '—'}`,
          `回滚条件: ${plan.rollbackConditions ?? '—'}`,
          '',
          `变更占比 ${saved.budget.ratio === null ? '—（没有声明任何字段）' : `${(saved.budget.ratio * 100).toFixed(1)}%`}`
          + `    五点改了 ${saved.budget.bulletsChanged} 条（上限 ${PLAN_BULLET_LIMIT}）`,
          saved.budget.note,
        ]
        if (plan.rebuild) {
          lines.push('这份计划按**重建**记录：观测期的结论不能说成「这次小改动带来的」。')
        }
        const active = activeObservationPlan(store, plan.publicationId)
        lines.push('', `该发布当前生效的计划: ${active?.id ?? '—'}（同时只能有一份 active；§6 的偏离处置会作废它）`)
        return lines.join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: `若确实要全量重写，带 rebuild: true 再调一次；否则把变更拆小（≤${PLAN_CHANGE_RATIO * 100}%、五点 ≤${PLAN_BULLET_LIMIT} 条）。`,
        }
      }
    },
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   模块 14 §8：效果观测
   ══════════════════════════════════════════════════════════════════════════ */

/** 一个观测节点的两行摘要。`blocked` 的补数清单必须跟着节点一起出现 —— 它就是重点。 */
function checkpointLines(checkpoint, indent = '  ') {
  const lines = [
    `${indent}第 ${checkpoint.day} 天 · 到期 ${checkpoint.dueAt} · ${checkpoint.status}`
    + (checkpoint.materialised === false ? '（尚未落库，下结论时会自动物化）' : '')
    + (checkpoint.retiredReason === null ? '' : ` · ${checkpoint.retiredReason}`),
  ]
  if (checkpoint.status === 'blocked') {
    lines.push(`${indent}  ⚠ 数据不足 —— 只能给「无法判断」。补数清单：`)
    for (const item of checkpoint.missing.filter(entry => entry.available === true)) {
      lines.push(`${indent}    · ${item.label} → ${item.route.label}（${item.route.module}）`)
    }
    for (const item of checkpoint.missing.filter(entry => entry.available === false)) {
      lines.push(`${indent}    · ${item.label} → **没有通道**：${item.why}`)
    }
  }
  if (checkpoint.conclusion !== null) {
    lines.push(
      `${indent}  结论：${checkpoint.conclusionLabel ?? checkpoint.conclusion}`
      + (checkpoint.conclusionNote === null ? '' : ` —— ${checkpoint.conclusionNote}`)
      + (checkpoint.conclusionTerminated ? '（已被回滚终止）' : ''),
    )
  }
  if (checkpoint.metrics !== null && Array.isArray(checkpoint.metrics.items)) {
    for (const item of checkpoint.metrics.items) {
      const change = item.change === null ? '（无基线，不算变化）' : `变化 ${item.change}`
      lines.push(
        `${indent}    ${item.label}=${valueLine(item.value)} ${item.unit}`
        + ` · 样本 ${item.sample} · 来源 ${item.source} · ${change}`,
      )
      if (item.scopeCaveat !== null) lines.push(`${indent}      ⚠ ${item.scopeCaveat}`)
    }
  }
  if (checkpoint.availableConclusions.length > 0) {
    lines.push(`${indent}  可选结论：${checkpoint.availableConclusions.map(id => CONCLUSION_LABELS[id] ?? id).join(' / ')}`)
  }
  return lines
}

/** 一张观测卡片的全部输出。`list` 与 `check` 共用，保证两条路说同样的话。 */
function cardLines(card) {
  const publication = card.publication
  const lines = [
    `观测卡片 · ${publication.asin} · ${publication.marketplace} · ${KIND_LABELS[publication.kind] ?? publication.kind}`
    + `    发布 ${publication.publishedAt}    观测起点 ${publication.observationStartAt}`,
    `状态：${CARD_STATE_LABELS[card.state] ?? card.state}`
    + (card.waitingHuman
      ? ' —— 这条记录偏离了已批准草案且尚未处置，观测节点**不会**物化：处置①会把观测起点推到现在，'
        + '现在算出来的到期日会建立在一个即将移动的起点上（§6）。先调 amzn_publication_baseline_decide。'
      : '')
    + (card.terminatedAt === null ? '' : ` —— 终止于 ${card.terminatedAt}：${card.terminatedReason ?? ''}`),
    /* 2026-10-25（R-15）：窗口原来是 `[观测起点, 现在]`，刚登记完就查会印成
       `窗口 …08:12:40 → …08:13:10` —— **只有 30 秒**。逻辑没错，读起来像算错了。
       短的时候必须解释掉，而不是让读者自己怀疑。 */
    windowLine(card),
    `数据前置检查：${card.data.note}`,
  ]
  for (const item of card.data.present) {
    lines.push(
      `  ✓ ${item.label}：${item.rows} 行，最近 ${item.latestAt}`
      + (item.scopeCaveat === null ? '' : `  ⚠ ${item.scopeCaveat}`),
    )
  }
  for (const item of card.data.noPath) {
    lines.push(`  ✗ ${item.label}：**本插件没有这条通道** —— ${item.why}`)
  }
  lines.push('节点：')
  if (card.checkpoints.length === 0) lines.push('  （无 —— 还没有物化，先调 amzn_observation_check）')
  for (const checkpoint of card.checkpoints) lines.push(...checkpointLines(checkpoint))
  if (card.rollback.ready) {
    lines.push(`回滚建议：**可以生成** —— ${card.rollback.reason}`)
    lines.push(`  调 amzn_rollback_suggest(publicationId: "${publication.id}", reason: "…") 生成交付包；执行仍需人工确认（§9）。`)
  } else {
    lines.push(`回滚建议：不可以 —— ${card.rollback.reason}`)
  }
  return lines
}

/**
 * 观测窗口那一行。
 *
 * 2026-10-25（R-15）：窗口是 `[观测起点, 现在]`，刚登记完就查会印成
 * 「2026-10-25T08:12:40Z → 2026-10-25T08:13:10Z」——**只有 30 秒**。
 * 逻辑没错（窗口确实就是「到现在为止」），但读起来像算错了。
 * 短的时候必须把它解释掉，而不是让读者自己怀疑 —— 一句「因为刚登记就查」就够了。
 */
function windowLine(card) {
  const start = Date.parse(card.window.windowStart)
  const end = Date.parse(card.window.windowEnd)
  const base = `窗口 ${card.window.windowStart} → ${card.window.windowEnd}`
  if (!Number.isFinite(start) || !Number.isFinite(end)) return base
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds >= 86400) return base
  const span = seconds < 120
    ? `${seconds} 秒`
    : seconds < 7200
      ? `${Math.round(seconds / 60)} 分钟`
      : `${(seconds / 3600).toFixed(1)} 小时`
  const pending = card.checkpoints.filter(checkpoint => checkpoint.status === 'pending').length
  return base
    + `\n  窗口只有 ${span} —— 因为窗口是「观测起点 → 现在」，而这次是刚登记就查。`
    + (pending > 0 ? `${pending} 个节点都还没到期，等它们到期再来看（到期日见下面）。` : '')
}

export function observationListTool({ store }) {
  return {
    name: 'amzn_observation_list',
    description:
      'List the §8 observation cards for a scope, or one card in full. Read-only: it does not create checkpoints. '
      + 'Each card states whether there is data to look at, and when there is not, the checklist says **where** to get it '
      + '— including the metrics this plugin has no ingestion path for at all, which are reported as 「没有通道」 rather '
      + 'than as a place to go. A card with no data is 数据不足, never 「无变化」 (§8).',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Narrow to one ASIN.' },
        marketplace: { type: 'string', description: 'Narrow to one marketplace.' },
        publicationId: { type: 'string', description: 'Show one publication record\'s card in full instead of a list.' },
        limit: { type: 'number', description: 'Max cards. Default 20.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const publicationId = String(args?.publicationId ?? '').trim()
        if (publicationId !== '') {
          const card = publicationObservation(store, publicationId)
          if (card === null) return { ok: false, error: `no publication record ${publicationId}` }
          return cardLines(card).join('\n')
        }
        const listed = listPublicationObservations(store, {
          asin: args?.asin ?? null,
          marketplace: args?.marketplace ?? null,
          limit: args?.limit ?? 20,
        })
        if (listed.rows.length === 0) {
          return '没有发布记录 —— §6 的「没有发布记录时不得显示已上线」在这里也成立：没有登记过发布，就没有可观测的东西。';
        }
        const lines = [
          `观测卡片 ${listed.rows.length} / 共 ${listed.total} 条发布记录`,
          table(listed.rows, [
            { label: 'ASIN', value: row => row.publication.asin },
            { label: '站点', value: row => row.publication.marketplace },
            { label: '发布', value: row => row.publication.publishedAt.slice(0, 10) },
            { label: '状态', value: row => CARD_STATE_LABELS[row.state] ?? row.state },
            { label: '节点', value: row => row.checkpoints.map(c => `${c.day}:${c.status}`).join(' ') },
            { label: '有数据', value: row => row.data.present.length },
            { label: '无通道', value: row => row.data.noPath.length },
            { label: '回滚建议', value: row => (row.rollback.ready ? '可生成' : '—') },
          ]),
        ]
        lines.push('')
        lines.push('要看某一行的完整卡片（含补数清单与指标读数）：amzn_observation_list(publicationId: "…")。')
        lines.push('到期扫描（生成通知）用 amzn_observation_scan_due。')
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message, hint: 'publicationId 要传 amzn_publication_list 里的 id。' }
      }
    },
  }
}

export function observationCheckTool({ store }) {
  return {
    name: 'amzn_observation_check',
    description:
      '§8\'s pre-check for one publication: materialise its observation nodes from the §7 plan window and report, per node, '
      + 'whether the observation window actually contains data. Idempotent. '
      + 'A node that has come due with no usable data is 数据不足 and carries the 补数清单 (where to collect, where to import, '
      + 'with the ASIN and marketplace pre-filled) — and on such a node the **only** conclusion available is 「无法判断」. '
      + 'Empty data is never rendered as 「无变化」 (§8). '
      + 'Nothing is materialised while a §6 deviation decision is outstanding: that decision can move the observation start.',
    parameters: {
      type: 'object',
      properties: {
        publicationId: { type: 'string', description: 'The publication record to check.' },
      },
      required: ['publicationId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const publicationId = String(args?.publicationId ?? '').trim()
        if (publicationId === '') return { ok: false, error: 'publicationId is required' }
        const result = ensureCheckpoints(store, publicationId)
        if (result.materialised === false) {
          const card = publicationObservation(store, publicationId)
          return [
            `未物化观测节点 —— ${result.reason}`,
            '',
            ...(card === null ? [] : cardLines(card)),
          ].join('\n')
        }
        const card = publicationObservation(store, publicationId)
        return [
          `观测节点已物化：新建 ${result.created}、刷新 ${result.refreshed}、退休 ${result.retired}`
          + `（窗口取自 ${result.plan === null ? `§8 默认 ${DEFAULT_WINDOW_DAYS.join('/')} 天（还没有观测计划）` : '§7 的观测计划'}）`,
          '',
          ...cardLines(card),
        ].join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: '先 amzn_publication_list 拿到 publicationId；没有发布记录就没有观测起点（§6）。',
        }
      }
    },
  }
}

export function observationConcludeTool({ store }) {
  return {
    name: 'amzn_observation_conclude',
    description:
      'Record the §9 conclusion for one observation node: keep / watch / revise / rollback / insufficient. '
      + 'The rules are enforced here, not left to the caller: a node that has not come due cannot be concluded at all '
      + '(act early via the §9 rollback flow instead), a node whose window has no usable data accepts **only** '
      + '「无法判断」, and a node that already has a conclusion cannot be re-decided — the first conclusion is the one that happened. '
      + 'The metric readings are frozen into the node at this moment, so 「当时凭什么这么判」 stays readable after the data moves on. '
      + 'A 「回滚」 conclusion is a **signal** for §9; it does not roll anything back.',
    parameters: {
      type: 'object',
      properties: {
        checkpointId: { type: 'string', description: 'The node id from amzn_observation_list / amzn_observation_check.' },
        conclusion: { type: 'string', enum: OBSERVATION_CONCLUSIONS, description: 'keep / watch / revise / rollback / insufficient.' },
        note: { type: 'string', description: 'Why — this is what a reader in three months will need.' },
        by: { type: 'string', description: 'Who concluded it.' },
      },
      required: ['checkpointId', 'conclusion'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const checkpointId = String(args?.checkpointId ?? '').trim()
        if (checkpointId === '') return { ok: false, error: 'checkpointId is required' }
        const result = saveObservationConclusion(store, checkpointId, args?.conclusion, {
          note: args?.note ?? null,
          by: args?.by ?? null,
        })
        const checkpoint = result.checkpoint
        const lines = [
          `观测结论已记录：第 ${checkpoint?.day} 天 · ${checkpoint?.conclusionLabel ?? args?.conclusion}`
          + (args?.by === undefined || args?.by === null ? '' : ` · ${args.by}`),
          `冻结的读数：${result.snapshot.items.length} 类指标${result.snapshot.baseline === null ? '（未声明基线窗口，只有绝对值）' : `（相对基线 ${result.snapshot.baseline.start} → ${result.snapshot.baseline.end}）`}`,
        ]
        for (const item of result.snapshot.items) {
          lines.push(`  ${item.label}=${valueLine(item.value)} ${item.unit} · 样本 ${item.sample} · 来源 ${item.source}`
            + (item.change === null ? '' : ` · 变化 ${item.change}`))
          if (item.scopeCaveat !== null) lines.push(`    ⚠ ${item.scopeCaveat}`)
        }
        if (result.snapshot.items.length === 0) {
          lines.push('  （一类指标都没取到 —— 这张卡片的结论只能是「无法判断」。）')
        }
        lines.push('')
        lines.push('相关变化不自动归因于 Listing 修改（§8）：上面的读数是「窗口内发生了什么」，不是「因为改了标题」。')
        lines.push(...cardLines(result.card).slice(0, 3))
        return lines.join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: '没到点的节点不能下结论（要提前撤回走 amzn_rollback_suggest）；'
            + '数据不足的节点只能给 insufficient；已有结论的节点不能改判。',
        }
      }
    },
  }
}

export function observationScanDueTool({ store }) {
  return {
    name: 'amzn_observation_scan_due',
    description:
      'Scan every publication record for observation nodes that have come due, and raise the §15 §6 notifications: '
      + '「观测到期」 when there is data, rewritten in place to 「观测数据待补」 when there is not (§8) — same '
      + 'dedupe key, so it is one alert that changes its wording rather than two that contradict each other. '
      + 'Also raises 「达到回滚条件」 when §9\'s condition is met. '
      + 'This is the notification table\'s first real producer; before it, the panel had no source at all.',
    parameters: {
      type: 'object',
      properties: {
        notify: { type: 'boolean', description: 'Set false to only report what is due without writing notifications. Default true.' },
        limit: { type: 'number', description: 'Max publication records to scan. Default 200.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const result = scanDueObservations(store, {
          notify: args?.notify !== false,
          limit: args?.limit ?? 200,
        })
        const lines = [
          `扫描 ${result.scanned} 条发布记录：${result.note}`,
          `  待人工处置（偏离草案，未物化）：${result.waitingHuman}`,
          `  已被回滚终止（不再产生节点）：${result.terminated}`,
          `  写入通知：${result.notified.length}`,
        ]
        for (const item of result.notified) {
          lines.push(`  · ${item.created ? '新建' : `更新（第 ${item.count} 次）`} ${item.title}`
            + (item.reopened ? ' —— 之前已读，现在重新提醒' : ''))
        }
        if (result.due.length > 0) {
          lines.push('')
          lines.push('到期的节点：')
          for (const item of result.due) {
            lines.push(`  ${item.asin} 第 ${item.checkpoint.day} 天 · ${item.checkpoint.status} · ${item.checkpoint.dueAt}`)
          }
        }
        if (result.errors.length > 0) {
          lines.push('')
          lines.push(`⚠ ${result.errors.length} 条记录扫描失败（没有安静跳过）：`)
          for (const item of result.errors) lines.push(`  · ${item.publicationId}: ${item.error}`)
        }
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   模块 14 §9：决策与回滚
   ══════════════════════════════════════════════════════════════════════════ */

export function rollbackSuggestTool({ store }) {
  return {
    name: 'amzn_rollback_suggest',
    description:
      'Generate a §9 rollback delivery package for one publication record: the current live values (from the most recent '
      + 'publication record), the restore target (the **previous actual** publication record, all fields), the per-field '
      + 'diff, and a step-by-step human checklist. Status becomes 「回滚待发布」. '
      + '**This plugin never rolls anything back** — you edit Seller Central by hand, then register a kind=rollback '
      + 'publication record, and only that closes the task. '
      + 'Refused when the record is no longer the live version (rolling back would discard newer work) and when it is the '
      + 'earliest record (there is nothing recorded to restore to — §9 restores from publication history, not from a draft). '
      + 'A §9 「30 天无改善」 condition that is not yet met does **not** block this: stock-outs and compliance problems need '
      + 'an early rollback, and refusing would only push people to a less traceable manual list. The verdict is reported either way.',
    parameters: {
      type: 'object',
      properties: {
        publicationId: { type: 'string', description: 'The publication record to roll back. Must still be the live version.' },
        reason: { type: 'string', description: 'Why — recorded on the task.' },
      },
      required: ['publicationId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const publicationId = String(args?.publicationId ?? '').trim()
        if (publicationId === '') return { ok: false, error: 'publicationId is required' }
        const result = suggestRollback(store, publicationId, { reason: args?.reason ?? null })
        const pkg = result.package
        const lines = [
          `回滚交付包已生成：任务 ${result.task.id} · 状态「${result.task.statusLabel}」`,
          `${pkg.asin} · ${pkg.marketplace}`,
          `  当前线上值（以最近一次发布记录为准）：${pkg.currentFrom.id}（${pkg.currentFrom.publishedAt}）`,
          `  回滚目标值（上一次实际发布记录全字段）：${pkg.restoreTo.id}（${pkg.restoreTo.publishedAt}）`,
          '',
          pkg.note,
          '',
          '人工回改操作清单：',
        ]
        for (const step of pkg.steps) {
          lines.push(`  ${step.step}. ${step.instruction}`)
          lines.push(`     当前「${valueLine(step.from)}」 → 目标「${valueLine(step.to)}」`)
        }
        if (pkg.steps.length === 0) lines.push('  （没有字段需要改回 —— 先确认是不是选错了回滚目标。）')
        lines.push('')
        lines.push(`§9 条件：${result.note}`)
        lines.push('')
        lines.push('系统不提供「一键回滚到线上」（§9）。改完之后回到 §6 登记一条 kind=rollback 的发布记录，')
        lines.push(`关联被回滚的记录：amzn_publication_record(kind: "rollback", rollbackOf: "${pkg.publicationId}", asin, marketplace, published: {…回滚后的实际值…})`)
        lines.push('登记的那一刻任务闭环，原观测结论保留并标注「已回滚终止」，观测窗口自新记录重新计时。')
        return lines.join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: '只有「当前线上那一版」能回滚。若它已被更新的发布记录取代，先决定新那一版怎么办。',
        }
      }
    },
  }
}

export function rollbackListTool({ store }) {
  return {
    name: 'amzn_rollback_list',
    description:
      'List §9 rollback tasks (回滚待发布 / 已闭环 / 已取消), recomputing each package from its two publication records. '
      + 'A pending task whose `from` record is no longer the live version is reported as **stale** rather than silently '
      + 'executed — rolling back from a superseded version would discard whatever was published after it.',
    parameters: {
      type: 'object',
      properties: {
        publicationId: { type: 'string', description: 'Narrow to one publication record.' },
        status: { type: 'string', description: 'pending_publish / closed / cancelled.' },
        limit: { type: 'number', description: 'Max rows. Default 20.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const listed = listRollbackTasks(store, {
          publicationId: args?.publicationId ?? null,
          status: args?.status ?? null,
          limit: args?.limit ?? 20,
        })
        if (listed.rows.length === 0) return '没有回滚任务。'
        const lines = [
          table(listed.rows, [
            { label: '任务', value: row => row.id.slice(0, 14) },
            { label: '被回滚', value: row => String(row.publicationId).slice(0, 14) },
            { label: '状态', value: row => row.statusLabel },
            { label: '字段数', value: row => row.package?.fields?.length ?? '—' },
            { label: '闭环于', value: row => (row.closedByPublicationId === null ? '—' : String(row.closedByPublicationId).slice(0, 14)) },
            { label: '过期', value: row => (row.stale ? '⚠ stale' : '') },
          ]),
        ]
        for (const row of listed.rows.filter(item => item.stale)) {
          lines.push('')
          lines.push(`⚠ ${row.id}：${row.staleReason}`)
        }
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

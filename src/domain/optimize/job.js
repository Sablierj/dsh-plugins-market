/**
 * 优化作业单 —— 把十一个工具串成一条看得见的流水线。
 *
 * ## 为什么不是"新建一个状态机"
 *
 * 这一轮之前，每一步都有自己的状态：`optimization_run.status`、`optimization_strategy.confirmed_at`、
 * `optimization_draft.accepted`、`publication_record.id`、`observation_checkpoint.conclusion`。
 * 再存一个 `job.stage` 就是**第五份状态**，而五份状态里最先坏的那份会让另外四份说谎。
 *
 * 所以这里**只算不存**：每次调用都从行里推当前阶段。库里没有 `job` 表，也没有
 * `stage` 列 —— 删掉一个草案，阶段会自动退回去，不需要任何人去同步它。
 *
 * ## 九个步骤，判据都写死在这里
 *
 * 每一步的"做完了吗"只有一个判据，且都是**库里能查到的事实**，不是"调用过某个工具"：
 * 调用过 `validate` 不等于校验通过；`validate` 说通过也不等于人接受过。
 */

/** 九步。`id` 同时是阶段名：当前阶段 = 第一个没做完的步骤。 */
export const JOB_STEPS = [
  { id: 'prepare', label: '建立优化轮次', next: { tool: 'amzn_optimize_prepare', args: { asin: '<ASIN>' } } },
  { id: 'strategy', label: '策略确认（人工）', next: { tool: null, args: {}, why: '确认发生在工作台的「优化 → 策略阶段」，本仓没有工具能做这件事' } },
  { id: 'drafts', label: '生成草案', next: { tool: 'amzn_optimize_validate', args: { persist: true } } },
  { id: 'unblocked', label: '校验无阻断项', next: { tool: 'amzn_optimize_validate', args: { persist: true } } },
  { id: 'accepted', label: '字段裁决（接受 / 修改后接受 / 驳回）', next: { tool: 'amzn_optimize_save', args: { accept: ['<字段>'] } } },
  { id: 'saved', label: '出报告', next: { tool: 'amzn_optimize_save', args: {} } },
  { id: 'published', label: '登记发布（人在卖家后台发布后）', next: { tool: 'amzn_publication_record', args: { kind: 'draft', runId: '<runId>', draftVersion: '<N>' } } },
  { id: 'observing', label: '观测（7 / 14 / 30 天）', next: { tool: 'amzn_observation_check', args: { publicationId: '<id>' } } },
  { id: 'concluded', label: '给结论', next: { tool: 'amzn_observation_conclude', args: { checkpointId: '<id>' } } },
]

export const JOB_STEP_IDS = JOB_STEPS.map(step => step.id)

function one(store, sql, params = []) {
  return store.get(sql, params) ?? null
}

function all(store, sql, params = []) {
  return store.all(sql, params) ?? []
}

/**
 * 当前阶段，以及推它出来的那几条事实。
 *
 * @returns {{stage: string, stageIndex: number, facts: string[], blockers: string[],
 *            next: {tool: string|null, args: object, why?: string}}}
 */
export function jobStage(store, { runId }) {
  const run = one(store, 'SELECT * FROM optimization_run WHERE id = ?', [String(runId ?? '')])
  if (run === null) {
    return {
      stage: 'prepare',
      stageIndex: 0,
      facts: [`run ${runId ?? '(空)'} 不存在`],
      blockers: [],
      next: { ...JOB_STEPS[0].next, args: { asin: '<ASIN>' } },
    }
  }

  /* 轮次已结束（failed / abandoned）：这不是"第几步"，是退出。 */
  if (run.status === 'failed' || run.status === 'abandoned') {
    return {
      stage: run.status,
      stageIndex: 0,
      facts: [`optimization_run.status = ${run.status}`],
      blockers: [run.error === null ? '轮次已退出（没有记原因）' : `轮次已退出：${run.error}`],
      next: { tool: 'amzn_optimize_prepare', args: { asin: run.asin }, why: '开新的一轮；旧轮次不会被改写' },
    }
  }

  /* ② 策略确认 —— `confirmed_at` 是唯一判据 */
  const strategy = one(store, 'SELECT * FROM optimization_strategy WHERE run_id = ?', [run.id])
  if (strategy === null || strategy.confirmed_at === null) {
    return {
      stage: 'strategy',
      stageIndex: 1,
      facts: [strategy === null
        ? 'optimization_strategy 没有这一轮的行'
        : 'optimization_strategy.confirmed_at 为空'],
      blockers: ['策略未确认 —— 未确认时 amzn_optimize_validate(persist) 与 amzn_optimize_save 都会被拒'],
      next: JOB_STEPS[1].next,
    }
  }

  /* ③ 草案 —— 只算没作废的 */
  const drafts = all(store, 'SELECT field, accepted, violations_json FROM optimization_draft WHERE run_id = ? AND voided_at IS NULL', [run.id])
  if (drafts.length === 0) {
    return {
      stage: 'drafts',
      stageIndex: 2,
      facts: ['这一轮没有未作废的草案'],
      blockers: [],
      next: JOB_STEPS[2].next,
    }
  }

  /* ④ 阻断项 —— 从 violations_json 里数，不信任何"校验通过"的标记 */
  const blocked = []
  for (const draft of drafts) {
    let violations = []
    try { violations = JSON.parse(draft.violations_json ?? '[]') ?? [] } catch { violations = [] }
    const blocks = violations.filter(violation => violation?.severity === 'block')
    if (blocks.length > 0) blocked.push(`${draft.field}: ${blocks.length} 个阻断项`)
  }
  if (blocked.length > 0) {
    return {
      stage: 'unblocked',
      stageIndex: 3,
      facts: [`${drafts.length} 个草案，其中 ${blocked.length} 个有阻断项`],
      blockers: blocked,
      next: JOB_STEPS[3].next,
    }
  }

  /* ⑤ 裁决 —— accepted 是人的动作，不是模型的 */
  const acceptedCount = drafts.filter(draft => draft.accepted === 1).length
  if (acceptedCount < drafts.length) {
    return {
      stage: 'accepted',
      stageIndex: 4,
      facts: [`${drafts.length} 个草案，已接受 ${acceptedCount} 个`],
      blockers: [],
      next: JOB_STEPS[4].next,
    }
  }

  /* ⑥ 报告 —— run.status = done 是"报告写过"的事实 */
  if (run.status !== 'done') {
    return {
      stage: 'saved',
      stageIndex: 5,
      facts: [`${drafts.length} 个草案全部已接受，optimization_run.status = ${run.status}`],
      blockers: [],
      next: JOB_STEPS[5].next,
    }
  }

  /* ⑦ 发布登记 —— 本插件从不发布，只登记人做过的事 */
  const publication = one(store, 'SELECT * FROM publication_record WHERE run_id = ? ORDER BY published_at DESC', [run.id])
  if (publication === null) {
    return {
      stage: 'published',
      stageIndex: 6,
      facts: ['报告已出（status = done），但没有 publication_record'],
      blockers: [],
      next: { ...JOB_STEPS[6].next, args: { kind: 'draft', runId: run.id, draftVersion: run.draft_version } },
    }
  }

  /* ⑧⑨ 观测与结论 —— 看 checkpoint 的结论 */
  const checkpoints = all(store, 'SELECT * FROM observation_checkpoint WHERE publication_id = ? ORDER BY day', [publication.id])
  if (checkpoints.length === 0) {
    return {
      stage: 'observing',
      stageIndex: 7,
      facts: [`已登记发布 ${publication.id}，但没有观测节点`],
      blockers: ['还没有 observation_plan —— 没有计划就没有观测节点，7/14/30 天不会自动到期'],
      next: { tool: 'amzn_observation_plan_save', args: { publicationId: publication.id } },
    }
  }
  const open = checkpoints.filter(checkpoint => checkpoint.conclusion === null)
  if (open.length > 0) {
    const due = open.filter(checkpoint => checkpoint.due_at !== null && checkpoint.due_at <= new Date().toISOString())
    return {
      stage: 'observing',
      stageIndex: 7,
      facts: [`${checkpoints.length} 个观测节点，${open.length} 个还没有结论（已到期 ${due.length} 个）`],
      blockers: [],
      next: { ...JOB_STEPS[7].next, args: { publicationId: publication.id } },
    }
  }

  return {
    stage: 'concluded',
    stageIndex: 8,
    facts: [`${checkpoints.length} 个观测节点全部有结论`],
    blockers: [],
    next: { tool: null, args: {}, why: '这一轮走完了。要改再开一轮 —— 已发布的记录不会被改写。' },
  }
}

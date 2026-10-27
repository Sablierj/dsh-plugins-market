/**
 * Prompt tools — read the library, save one prompt, and preview a render.
 *
 * These sit next to the optimize tools because the `assemble` prompts are what
 * `amzn_optimize_prepare` hands the agent as its writing strategy, and the
 * `button` prompts are what the workbench page shows as clickable prompts. Both
 * go through the one resolver in `src/store/prompt.js`, so the button the user
 * clicks and the strategy the agent reads cannot disagree.
 *
 * `upsert` is the one that carries the risk: a body that does not parse, or that
 * names a variable outside the closed set, must be refused by name rather than
 * stored — a prompt that renders to nothing looks exactly like a prompt that
 * chose to say nothing, and the user would never find out. `preview` exists so
 * that failure is visible *before* a save, not after.
 */

import {
  getEvalSet, getPrompt, importEvalSet, listEvalCases, listEvalSets, listPrompts, listPromptSets,
  previewPrompt, promptHistory, promptLifecycleStatus,
  promptLifecycleView, promptProductionGate, promptStats, rollbackPrompt, rollbackPromptVersion,
  activatePromptVersion, recordPromptLifecycle, upsertPrompt,
} from '../store/prompt.js'
import {
  PROMPT_LIFECYCLE_LABELS, PROMPT_LIFECYCLE_STATES,
} from '../domain/prompts/lifecycle.js'
import { promptVariableRows } from '../domain/prompts/variables.js'
/* F11-09 引用追踪（wb-f1109）。并集解冲突时容易漏这一行 —— 函数搬过来了、它调的出口没搬，
   工具一跑就抛。缺的是「配套定义」，不是逻辑。（同一个坑在 wb-f1109 那次也踩过。） */
import { promptReferences, referenceMatchMeaning } from '../domain/prompts/references.js'
import { table, text, truncate } from './render.js'

/** `button` / `assemble` in Chinese, for the tool output. */
function scenarioLabel(scenario) {
  if (scenario === 'button') return '按钮'
  if (scenario === 'assemble') return '组装'
  return String(scenario ?? '')
}

/** `fixed` / `evidence` / `contract` in Chinese, or a dash for a button row. */
function layerLabel(layer) {
  if (layer === 'fixed') return '固定策略'
  if (layer === 'evidence') return '证据'
  if (layer === 'contract') return '输出契约'
  return '—'
}

export function promptListTool({ store }) {
  return {
    name: 'amzn_prompt_list',
    description:
      'List the prompt library: the sets (one per module), and each prompt\'s scenario (button = a workbench page '
      + 'button; assemble = a layer of the writing strategy amzn_optimize_prepare hands the agent), layer, label, '
      + 'edit count and enabled state. Also returns the variable registry — every name a body may reference, with '
      + 'its meaning, type, source, whether it is required, max length, sensitivity and missing behaviour — so a '
      + 'caller can answer "what does this variable need and what happens without it" without guessing. '
      + 'Read-only. Filter by module or scenario to narrow it.',
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '只看某个模块，例如 "optimize" / "rules" / "common"。默认全部。' },
        scenario: { type: 'string', enum: ['button', 'assemble'], description: '只看按钮或组装提示词。默认全部。' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const sets = listPromptSets(store)
      const rows = listPrompts(store, { module: args?.module, scenario: args?.scenario })
      const stats = promptStats(store)

      const lines = []
      lines.push(`提示词库: 共 ${stats.sets} 套 / ${stats.total} 条`
        + `（按钮 ${stats.button} · 组装 ${stats.assemble}${stats.disabled > 0 ? ` · 已停用 ${stats.disabled}` : ''}）`)
      lines.push('一套提示词 = 一个模块。按钮给用户点，组装提示词给 amzn_optimize_prepare 当写作策略（分固定策略 / 证据 / 输出契约三层）。')
      lines.push('')
      lines.push('套:')
      for (const set of sets) {
        lines.push(`· ${set.module}（${set.name}）· ${set.version} · ${set.promptCount} 条`)
      }
      lines.push('')
      /* §5 / §12.2：调用方要能问出「这个变量要什么、没有它会怎样」。注册表跟着列表
         一起给出去，否则 agent 只能靠猜 —— 而「猜一个变量名」正是闭集要挡的事。 */
      const variables = promptVariableRows()
      lines.push(`变量注册表（模板里能引用的名字只有这 ${variables.length} 个；写别的名字保存会被拒）:`)
      lines.push(table(variables, [
        { label: '变量', value: row => row.name },
        { label: '业务解释', value: row => truncate(row.label, 16) },
        { label: '类型', value: row => row.type },
        { label: '必填', value: row => (row.required ? '是' : '否') },
        { label: '最长', value: row => String(row.maxLength) },
        { label: '敏感', value: row => (row.sensitive ? '是' : '否') },
      ]))
      for (const row of variables) {
        lines.push(`· ${row.name}: ${row.description}`)
        lines.push(`  来源: ${row.source}`)
        lines.push(`  默认行为: ${row.defaultBehavior}`)
        lines.push(`  缺失行为: ${row.missingBehavior}`)
      }
      /* 2026-10-25 真实数据实测（R-7）：注册表列了 43 个名字，其中 7 个的 `source` 自己写着
         「需要补 reader / 计划新增」——**值根本取不到**，而其中 5 个还标着「必填」。
         它们和另外 36 个混在一起列，没有任何警告；谁照着注册表写一句引用，保存会被接受
         （名字合法），渲染时才 fail，而 fail 的措辞会指向「缺少这个值」——
         **让人以为是数据没填，其实是这个能力没实现。** 这里自动算出来单独列一节。 */
      const unimplemented = variables.filter(row => /需要补|计划新增|不返回单值/.test(String(row.source ?? '')))
      if (unimplemented.length > 0) {
        lines.push('')
        lines.push(`⚠️ **这 ${unimplemented.length} 个变量的值来源还没实现**（注册表里能看到名字，但取不到值）：`)
        lines.push('　' + unimplemented.map(row => `${row.name}${row.required ? '（必填）' : ''}`).join('、'))
        lines.push('　引用它们保存会被接受（名字合法），**渲染时才会失败**，而失败说明会指向「缺这个值」——')
        lines.push('　那是误导：不是数据没填，是**这个能力还没做**。要用它们，先补 reader。')
      }
      lines.push('')
      if (rows.length === 0) {
        lines.push(args?.module || args?.scenario ? '（当前筛选下没有提示词）' : '（库里没有提示词）')
        return lines.join('\n')
      }
      lines.push(table(rows, [
        { label: '模块', value: row => row.module },
        { label: '场景', value: row => scenarioLabel(row.scenario) },
        { label: '层', value: row => layerLabel(row.layer) },
        { label: '标题', value: row => truncate(row.label, 20) },
        { label: '变量', value: row => (row.variables.length === 0 ? '—' : row.variables.join(', ')) },
        { label: '改过', value: row => `${row.version} 次` },
        { label: '启用', value: row => (row.enabled ? '是' : '否') },
        { label: 'id', value: row => truncate(row.id, 8) },
      ]))
      lines.push('')
      lines.push('改一条用 amzn_prompt_upsert；先看渲染结果用 amzn_prompt_preview。')
      return lines.join('\n')
    },
  }
}

/**
 * Save one prompt — create it, or update an existing row.
 *
 * The store refuses anything a reader could not rely on: an unknown module, an
 * unknown scenario, an `assemble` row with no layer, an empty label or body, and
 * a body that does not parse (or names a variable outside the closed set). Every
 * refusal names the offending value, because a bare "invalid prompt" does not say
 * which of the five things was wrong.
 */
export function promptUpsertTool({ store }) {
  return {
    name: 'amzn_prompt_upsert',
    description:
      'Create or update one prompt in the library. Give module + scenario (button | assemble) + label + body; pass an '
      + 'id to update an existing row (its version is bumped), omit it to add a new one. A body may use {{name}} and '
      + '{{#name}}…{{/name}} with only the closed variable set (scope / selectedKeywords / rulesVersion) — any other '
      + 'name is refused, and an assemble row also needs a layer (fixed | evidence | contract). The renderer adds and '
      + 'removes nothing, so an optional sentence carries its own punctuation inside the section. '
      + 'This writes to the database: confirm with the user before calling it.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要改的提示词 id（amzn_prompt_list 里能看到）。不给则新建。' },
        module: { type: 'string', description: '模块 id，例如 "optimize" / "rules" / "common"。' },
        scenario: { type: 'string', enum: ['button', 'assemble'], description: 'button = 页面按钮；assemble = 组装提示词。' },
        layer: { type: 'string', enum: ['fixed', 'evidence', 'contract'], description: 'assemble 必填：固定策略 / 证据 / 输出契约。button 不能有。' },
        label: { type: 'string', description: '按钮或层的标题。' },
        body: { type: 'string', description: '正文。支持 {{name}} 与 {{#name}}…{{/name}}，变量只能用 scope / selectedKeywords / rulesVersion。' },
        enabled: { type: 'boolean', description: '是否启用。默认 true。' },
      },
      required: ['module', 'scenario', 'label', 'body'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      let stored
      try {
        stored = upsertPrompt(store, {
          id: args?.id,
          module: args?.module,
          scenario: args?.scenario,
          layer: args?.layer,
          label: args?.label,
          body: args?.body,
          enabled: args?.enabled,
        })
      } catch (error) {
        /* ⚠️ 必须返回 `{ok:false}`，不能只回一句话。**两个**消费者按这个字段判断
           「这次写没有发生」：审计漏斗（`src/tools/index.js:428` 的 `recordToolAudit`）
           与工具遥测（同文件 `:400` 的 `ok: value?.ok !== false`）。只回一句话的拒绝
           会被记成一次真的保存 —— 库里并没有发生这次写，审计里却多一行，遥测还说成功。
           同一个文件里 `amzn_prompt_lifecycle_transition`（B-11.3）是正确写法。 */
        return { ok: false, error: `保存失败：${error.message}`, hint: '提示词库未变。' }
      }
      const lines = []
      lines.push(stored.created
        ? `已新增提示词 ${stored.id}（${stored.module} · ${scenarioLabel(stored.scenario)}${stored.layer ? ` · ${layerLabel(stored.layer)}` : ''}）`
        : `已更新提示词 ${stored.id}（第 ${stored.version} 次修改；正文是原地覆盖的，旧稿读不到）`)
      lines.push(`标题: ${stored.label}`)
      lines.push(`变量: ${stored.variables.length === 0 ? '（无）' : stored.variables.join(', ')}`)
      lines.push(`启用: ${stored.enabled ? '是' : '否'}`)
      if (stored.scenario === 'assemble') {
        lines.push('这条会进 amzn_optimize_prepare 的数据包（package_json 的 prompts）。下一次 prepare 就按新文本写。')
      } else {
        lines.push('这条会用在工作台对应模块的 prompt 动作里，下一次刷新页面就变。（原来写「出现在某个已拆掉的按钮里」——右侧栏 10-21 拆掉后那个按钮就没了，工具输出照着它指路会把人指到一个不存在的地方。**这里不复述那个名字**：复述一次，移除守门就会把它当成没清干净。）')
      }
      return lines.join('\n')
    },
  }
}

/**
 * Render a prompt body (or a stored prompt) against a variable bag.
 *
 * The point of this tool is to make a bad template *fail visibly before a save*.
 * `{{typo}}` throws, and the throw is reported as a failure — not swallowed into
 * an empty string, which is the whole reason the variable set is closed.
 */
export function promptPreviewTool({ store }) {
  return {
    name: 'amzn_prompt_preview',
    description:
      'Render a prompt (by id, or a body you are about to save) against a variable bag and return the exact text. '
      + 'Only scope / selectedKeywords / rulesVersion may be referenced; an unknown name fails here rather than '
      + 'rendering as nothing. An optional section {{#name}}…{{/name}} is dropped whole — including its own '
      + 'punctuation — when the value is empty, and 0 / "0" are NOT empty. '
      + 'When a REQUIRED variable (scope / rulesVersion) is missing or empty the render is reported as degraded: '
      + 'the answer names the missing variable, its business meaning and where its value comes from, because a hole '
      + 'in the middle of the sentence reads exactly like a prompt that chose to say nothing. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要预览的提示词 id。与 body 二选一（给了 body 就用 body）。' },
        body: { type: 'string', description: '要预览的正文（还没保存的草稿）。' },
        scope: { type: 'string', description: 'scope 变量的值，例如 "当前选中的 3 个 ASIN"。' },
        selectedKeywords: { type: 'string', description: 'selectedKeywords 变量的值（已用「、」连好）。' },
        rulesVersion: { type: 'string', description: 'rulesVersion 变量的值，例如 "2026.9"。' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const variables = {
        scope: args?.scope,
        selectedKeywords: args?.selectedKeywords,
        rulesVersion: args?.rulesVersion,
      }
      let result
      try {
        result = previewPrompt(store, { id: args?.id, body: args?.body, variables })
      } catch (error) {
        return `预览失败：${error.message}\n（模板里引用了闭集之外的变量，或者花括号没配对 —— 这会在保存时被拒，先改好。）`
      }
      const lines = []
      lines.push(`变量: scope=${variables.scope === undefined ? '（未给）' : `「${variables.scope}」`}`
        + ` · selectedKeywords=${variables.selectedKeywords === undefined ? '（未给）' : `「${variables.selectedKeywords}」`}`
        + ` · rulesVersion=${variables.rulesVersion === undefined ? '（未给）' : `「${variables.rulesVersion}」`}`)
      lines.push(`用到: ${result.variables.length === 0 ? '（无变量）' : result.variables.join(', ')}`)

      /* §5：必填缺失要「说明」，不能插入空字符串后假装完成。这里把「渲染出来的
         空洞」与「提示词选择了不说」分开写 —— 同一个纪律：缺失显示成缺失。 */
      if (result.degraded) {
        lines.push('')
        lines.push(`⚠️ 降级渲染：${result.reason}`)
        for (const item of result.missing_required) {
          lines.push(`   · ${item.name}（${item.label}）必填缺失`)
          lines.push(`     业务解释: ${item.description ?? '（未登记）'}`)
          lines.push(`     来源: ${item.source ?? '（未登记）'}`)
        }
        lines.push('   要拿到不降级的渲染，就把上面这些变量补上再预览一次。')
      }
      if (result.dropped_optional.length > 0) {
        lines.push('')
        lines.push(`说明: 可选段被整段移除 —— ${result.dropped_optional.map(item => item.name).join('、')}`
          + '（设计内降级，不是缺失；值给了就会回来）。')
      }

      lines.push('')
      lines.push('渲染结果:')
      lines.push(result.text)
      if (args?.id !== undefined && args?.id !== null && String(args.id).trim() !== '') {
        const row = getPrompt(store, args.id)
        /* `version` is an edit count, not a version label (the body is overwritten
           in place). Printing 「v3」 would promise a v3 that does not exist. */
        if (row !== null) lines.push('', `（提示词 ${row.id} · ${row.label} · 改过 ${row.version} 次）`)
      }
      return lines.join('\n')
    },
  }
}

/** ISO timestamp → `YYYY-MM-DD HH:MM:SS`, or the raw value if it is not one. */
function shortTime(value) {
  const text = String(value ?? '')
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 19).replace('T', ' ') : text
}

/**
 * The frozen bodies of one prompt — the version history the edit counter counts.
 *
 * Read-only. The counter and the frozen set are **not** the same number: creating
 * a row freezes nothing, so `frozen = version − 1`, and a row saved before
 * B-11.2b can have even fewer because those bodies were never captured. This tool
 * is the half that was missing: before B-11.2b the counter went up and the body
 * it replaced was gone.
 */
export function promptHistoryTool({ store }) {
  return {
    name: 'amzn_prompt_history',
    description:
      'List the frozen bodies of one prompt, newest first. Each row is a body as it was BEFORE a save, keyed by '
      + 'the edit count it replaced — the history amzn_prompt_list only counts. Frozen = edit count − 1 (creating a '
      + 'row freezes nothing), and fewer still if the row was saved before B-11.2b and those bodies were never '
      + 'captured; this says so rather than inventing one. '
      + 'Use a row\'s snapshot id with amzn_prompt_rollback to restore that body. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提示词 id（amzn_prompt_list 里能看到）。' },
        includeArchived: { type: 'boolean', description: '是否包含已归档的冻结版本。默认否。' },
      },
      required: ['id'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id === '') return '给一个提示词 id —— amzn_prompt_history 要知道看哪一条。'
      const row = getPrompt(store, id)
      if (row === null) return `没有提示词 ${id}（它可能被删了，或者 id 抄错了）。`

      const history = promptHistory(store, { id, includeArchived: args?.includeArchived === true })
      const lines = []
      lines.push(`提示词 ${row.id} · ${row.module} · ${row.label}`)
      /* `matchedAll`（含已归档）才是真总数；`rows.length` 会被上限截断，拿它当总数
         会把「显示少了」说成「本来就没有」。页面用的是同一个数（同一次 promptHistory）。 */
      lines.push(`当前正文：改过 ${row.version} 次（编辑计数）。冻结版本：${history.matchedAll} 个。`)
      /* 新建那一次不冻结，所以「应有」是 version − 1；只有真的比它少，才是本批之前的
         旧稿没被捕获。version=1 的全新提示词因此不会进这里 —— 0 个冻结正是它该有的样子。 */
      if (history.matchedAll < row.version - 1) {
        lines.push('注意：冻结版本比编辑计数少 —— 本批（B-11.2b）之前的旧稿没有被捕获，读不到。'
          + '这是事实，不是遗漏。')
      }
      lines.push('')
      if (history.matchedAll === 0) {
        lines.push('（还没有冻结版本：这条提示词自 B-11.2b 起没有被编辑过。）')
        return lines.join('\n')
      }
      if (history.rows.length === 0) {
        lines.push(`（冻结版本共 ${history.matchedAll} 个，全部已归档、默认不显示 —— 传 includeArchived: true 才看得到。）`)
        return lines.join('\n')
      }
      lines.push(table(history.rows, [
        { label: '冻结版本', value: entry => `v${entry.version}` },
        { label: '冻结时间', value: entry => shortTime(entry.createdAt) },
        { label: '说明', value: entry => entry.note ?? '—' },
        { label: '正文', value: entry => truncate(String(entry.body ?? '').replace(/\s+/g, ' '), 40) },
      ]))
      lines.push('')
      lines.push('回滚到某一版：amzn_prompt_rollback 传 id + 上面那行的 snapshot id。'
        + '回滚是一次新编辑（计数 +1），不是删除历史。')
      return lines.join('\n')
    },
  }
}

/**
 * Roll one prompt's body back to a frozen version.
 *
 * A **new edit**, not an erasure: the counter goes up and the body rolled back
 * from is frozen first. Refusals are by name (unknown snapshot / another object's
 * snapshot / a snapshot with no body) — each one succeeding quietly would claim a
 * rollback that did not happen.
 */
export function promptRollbackTool({ store }) {
  return {
    name: 'amzn_prompt_rollback',
    description:
      'Roll one prompt\'s body back to a frozen version (get the snapshot id from amzn_prompt_history). This is a '
      + 'NEW edit: the edit counter goes up, and the body you rolled back FROM is itself frozen first, so nothing is '
      + 'erased and a second rollback can return you. Refuses, by name, when the snapshot does not exist, freezes a '
      + 'different object, or freezes no body. This writes to the database: confirm with the user before calling it.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要回滚的提示词 id。' },
        snapshotId: { type: 'string', description: '回滚到哪个冻结版本（amzn_prompt_history 里那行的 id）。' },
      },
      required: ['id', 'snapshotId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      let stored
      try {
        stored = rollbackPrompt(store, { id: args?.id, snapshotId: args?.snapshotId })
      } catch (error) {
        /* `{ok:false}` 而不是一句话 —— 理由同 `amzn_prompt_upsert`：审计漏斗与工具
           遥测都靠这个字段区分「被拒」与「写成功」。一句话的拒绝会被记成一次真的回滚。 */
        return { ok: false, error: `回滚失败：${error.message}`, hint: '提示词库未变。' }
      }
      const lines = []
      lines.push(`已回滚提示词 ${stored.id}（${stored.module} · ${stored.label}）`)
      lines.push(`正文已写回冻结版本 v${stored.restoredVersion} 的那一份；`
        + `这次回滚本身是一次新编辑 —— 计数从 ${stored.rolledBackFrom} 变成 ${stored.version}，`
        + '回滚前的正文也已冻结，仍可读回。')
      lines.push(`当前正文（${stored.version} 次编辑后）:`)
      lines.push(String(stored.body ?? ''))
      return lines.join('\n')
    },
  }
}

/* ──────────────────── 模块 11 F11-05：生命周期工具 ────────────────────
 *
 * 四个：读一个（get）、写一个（transition），以及「激活 / 回滚活动版本」这一对。
 *
 * ⚠️ 命名：`amzn_prompt_version_rollback` 与 `amzn_prompt_rollback` 是**两件事**，
 * 两条描述里都写明区别，否则调用方会把它们当成同一个操作的两个名字：
 *
 *   · `amzn_prompt_rollback`（B-11.2b）—— 把**正文**换回某个冻结版本。编辑计数 +1，
 *     产生一版新正文，回滚前的正文也被冻结。它回答「这条提示词现在长什么样」。
 *   · `amzn_prompt_version_rollback`（F11-05）—— 把**活动版本**退回上一活动版本。
 *     一个字的正文都不写：那一版的正文当时就被冻结着，只是不再是生产用的那一份。
 *     它回答「生产现在用哪一版」。
 *
 * 「哪个版本在生效」是**版本级**的，「整条提示词关掉」是**行级**的（`enabled`）。
 * 两条都要过才进生产，被挡时两条都会说出来 —— 见 `amzn_prompt_lifecycle_get`。
 */

/** 一个版本的状态 + 它离生产还差什么，两行字。工具侧共用，不各写一份。 */
function lifecycleLines(store, row) {
  const gate = promptProductionGate(store, row)
  const statusLabel = PROMPT_LIFECYCLE_LABELS[gate.status] ?? gate.status
  const lines = []
  lines.push(`· ${row.module} · ${row.label}（v${row.version}）· 状态 ${gate.status}（${statusLabel}）`
    + ` · 活动版本 ${gate.activeVersion === null ? '无' : `v${gate.activeVersion}`}`)
  if (gate.inProduction) {
    lines.push('  在产：两道门都过了（enabled = 1，且有 active 版本）')
  } else {
    /* 两道门分别点名 —— 一道是勾选框，一道是走 review → testing → active，
       只说「没生效」的报错，读的人不知道该去动哪里。 */
    lines.push(`  不在产：${gate.gates.join(' + ')}。${gate.reason}`)
  }
  return lines
}

/**
 * Read one prompt's lifecycle, or the lifecycle of a whole module.
 *
 * Read-only, and it answers the question the production gate raises: not just
 * 「它生效了吗」 but 「没生效的话是哪道门挡的」.
 */
export function promptLifecycleTool({ store }) {
  return {
    name: 'amzn_prompt_lifecycle_get',
    description:
      'Read the lifecycle of prompt versions (F11-05): draft / review / testing / active / deprecated / rolled_back. '
      + 'With an id: that prompt\'s current status, its active version, the previous active version, the legal next '
      + 'steps, and its full event history. With a module (or nothing): every prompt with its status and, when it is '
      + 'not in production, WHICH gate stopped it — `enabled` (the row-level mute, one checkbox) or `status` (the '
      + 'version-level step, fixed by review → testing → activate). The two are different gates with different fixes, '
      + 'so both are named when both apply. Read-only. '
      + 'Note: editing a prompt does NOT put the new version into production; the active version keeps being used '
      + 'until someone activates the new one.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '看这一条提示词的生命周期。给了 id 就不看 module。' },
        module: { type: 'string', description: '只看某个模块，例如 "optimize" / "common"。默认全部。' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id !== '') {
        const row = getPrompt(store, id)
        if (row === null) return `没有提示词 ${id}（它可能被删了，或者 id 抄错了）。`
        const view = promptLifecycleView(store, id)
        const lines = []
        lines.push(`提示词 ${row.id} · ${row.module} · ${row.label} · ${scenarioLabel(row.scenario)}`)
        lines.push(...lifecycleLines(store, row))
        lines.push(`回滚到上一活动版本 ${view.canRollback ? `可以（会退回 v${view.previousActiveVersion}）`
          : '现在不行' + (view.status === 'active' ? '：没有更早的活动版本'
            : `：当前版 v${view.version} 不是 active，没有在生产里的东西可以退回`)}`)
        lines.push('')
        lines.push(`合法下一步: ${view.next.length === 0 ? '（终态）'
          : view.next.map(state => `${state.status}（${state.label}）`).join(' / ')}`)
        lines.push(`改一步用 amzn_prompt_lifecycle_transition；把这一版放进生产用 amzn_prompt_version_activate；`
          + '退回上一活动版本用 amzn_prompt_version_rollback。')
        lines.push('')
        if (view.events.length === 0) {
          lines.push('（这一条提示词没有任何生命周期事件 —— 谁都没说过它是什么，所以是 draft。）')
          return lines.join('\n')
        }
        lines.push(`事件历史（${view.events.length} 条，最老的在前）:`)
        lines.push(table(view.events, [
          { label: '版本', value: event => `v${event.version}` },
          { label: '到', value: event => `${event.status}（${PROMPT_LIFECYCLE_LABELS[event.status] ?? event.status}）` },
          { label: '时间', value: event => shortTime(event.at) },
          { label: '谁', value: event => event.by ?? '—' },
          { label: '说明', value: event => truncate(event.note ?? '—', 40) },
        ]))
        return lines.join('\n')
      }

      const rows = listPrompts(store, { module: args?.module })
      const lines = []
      lines.push(`生命周期总览（提示词生命周期的六个状态：${PROMPT_LIFECYCLE_STATES.map(state => `${state}（${PROMPT_LIFECYCLE_LABELS[state]}）`).join(' / ')}）`)
      lines.push('「生效」= 两道门都过：enabled = 1（行级：整条关掉）且有 active 版本（版本级：这一版走到 active）。')
      lines.push('')
      if (rows.length === 0) {
        lines.push(args?.module ? '（这个模块下没有提示词）' : '（库里没有提示词）')
        return lines.join('\n')
      }
      for (const row of rows) lines.push(...lifecycleLines(store, row))
      return lines.join('\n')
    },
  }
}

/**
 * Record one lifecycle transition, **validated by the state machine**.
 *
 * The refusal is returned as text rather than thrown, so a caller reads *why*
 * (`draft → active` is not an edge) instead of a stack trace.
 */
export function promptLifecycleTransitionTool({ store }) {
  return {
    name: 'amzn_prompt_lifecycle_transition',
    description:
      'Move one prompt version to the next lifecycle status (F11-05). The legal moves are '
      + 'draft → review, review → draft / testing, testing → review / active, active → deprecated / rolled_back, '
      + 'deprecated → active, rolled_back → review — there is deliberately NO draft → active: if saving a body could '
      + 'also activate it, 「编辑」 and 「激活」 would be one act again. Omit `version` to move the prompt\'s current '
      + 'version. A move the machine does not allow is refused by name, and nothing is written. '
      + 'This writes to the database: confirm with the user before calling it.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提示词 id。' },
        to: { type: 'string', enum: [...PROMPT_LIFECYCLE_STATES], description: '要移动到哪个状态。' },
        version: { type: 'integer', description: '移动哪一版；默认当前这一版（行上的编辑计数）。' },
        note: { type: 'string', description: '留一句话：为什么走到这一步。' },
      },
      required: ['id', 'to'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id === '') {
        return { ok: false, error: '给一个提示词 id —— amzn_prompt_lifecycle_transition 要知道动哪一条。' }
      }
      const row = getPrompt(store, id)
      if (row === null) {
        return { ok: false, error: `没有提示词 ${id}（它可能被删了，或者 id 抄错了）。` }
      }
      const version = args?.version === undefined || args?.version === null ? row.version : Number(args.version)
      let moved
      try {
        moved = recordPromptLifecycle(store, { id, version, to: args?.to, by: 'agent', note: args?.note ?? null })
      } catch (error) {
        /* ⚠️ 必须返回 `{ok:false}`，不能只回一句话：审计漏斗是靠 `value?.ok === false`
           判断「这次写没有发生」的（src/tools/index.js 的 recordToolAudit）。只回一句话
           的拒绝会被记成一次真的状态转移 —— 而「记下一次没发生的写」是审计唯一不能说的
           谎。同一个文件里 `amzn_prompt_rollback`（B-11.2b）还留着旧写法，见 §3.20 边界。 */
        return {
          ok: false,
          error: `状态转移被拒绝：${error.message}`,
          hint: '提示词库未变。合法的下一步见 amzn_prompt_lifecycle_get。',
        }
      }
      const lines = []
      lines.push(`提示词 ${id} 的 v${moved.version}：${moved.from} → ${moved.status}`)
      lines.push(`活动版本现在是 ${moved.activeVersion === null ? '无' : `v${moved.activeVersion}`}。`)
      if (moved.status === 'active') {
        lines.push('这一版从现在起是生产用的那一版（行还必须是 enabled = 1）。历史运行引用的旧版本不受影响 —— '
          + '它们记的是当时的那一版。')
      }
      if (moved.from === 'draft' && moved.status === 'review') {
        /* F11-07：这句话以前只说「在固定评估集上跑」，而全仓**没有任何评估集** ——
           一个向用户承诺不存在的能力的句子，修法只有两条：把评估集建出来，或者把
           这句删掉。选了前者，所以这里现在点名去读哪套集子、用什么工具读。
           ⚠️ 仍然要写清：本插件**不自动跑**评估（没有评估器），人能读到的只有期望。 */
        const sets = listEvalSets(store)
        lines.push(sets.length === 0
          ? '下一步: review → testing。⚠️ 提示词里写着「在固定评估集上跑」，但**评估集库是空的** —— '
            + '先去 amzn_prompt_eval_import 导一套，否则 testing 这一步没有任何东西可以对照。'
          : `下一步: review → testing —— 拿 amzn_prompt_eval_show 把样例读出来，逐条对照期望行为`
            + `（现有 ${sets.length} 套评估集）。本插件没有评估器，不会替你跑，也没有通过率。`)
      }
      return lines.join('\n')
    },
  }
}

/**
 * Activate the prompt's current version — the explicit 「放进生产」 act.
 *
 * Separate from `amzn_prompt_upsert` on purpose: 编辑与激活分离. The state machine
 * still decides whether it is legal, so a new version has to have been through
 * review and testing first.
 */
export function promptVersionActivateTool({ store }) {
  return {
    name: 'amzn_prompt_version_activate',
    description:
      'Put one prompt\'s CURRENT version into production (F11-05). This is what makes the new body the one production '
      + 'uses — saving a prompt does NOT do it, and until it is called the previously active version keeps being used. '
      + 'Only legal from `testing` (or from `deprecated`, to bring a retired version back): a brand-new or just-edited '
      + 'version is `draft`, and the machine refuses draft → active by name, because a save that also activated would '
      + 'collapse 「编辑」 and 「激活」 into one act. Activating does not rewrite anything a past run recorded. '
      + 'This writes to the database: confirm with the user before calling it.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提示词 id。' },
        note: { type: 'string', description: '留一句话：这次激活的依据。' },
      },
      required: ['id'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id === '') return { ok: false, error: '给一个提示词 id —— amzn_prompt_version_activate 要知道激活哪一条。' }
      const row = getPrompt(store, id)
      if (row === null) return { ok: false, error: `没有提示词 ${id}（它可能被删了，或者 id 抄错了）。` }
      let moved
      try {
        moved = activatePromptVersion(store, { id, by: 'agent', note: args?.note ?? null })
      } catch (error) {
        const status = promptLifecycleStatus(store, id, row.version)
        /* `{ok:false}` 而不是一句话：拒绝不是一次写入，审计漏斗按这个字段判断
           （见 amzn_prompt_lifecycle_transition 里的同一段说明）。 */
        return {
          ok: false,
          error: `激活被拒绝：${error.message}`,
          hint: `提示词库未变。v${row.version} 现在的状态是 "${status}"`
            + `（${PROMPT_LIFECYCLE_LABELS[status] ?? status}），要先把状态走到 testing。`,
        }
      }
      return `已激活：提示词 ${id} 的 v${moved.version} 现在是活动版本（${moved.from} → active）。`
        + '生产用它，直到下一次激活或回滚。'
        + (row.enabled ? '' : '\n注意：这一行 enabled = 0，整条提示词还是关着的 —— 两道门都过才真的进生产。')
    },
  }
}

/**
 * Roll production back to the previous active version — the one-click undo.
 *
 * Writes no body: the previous version's body is already on record. Refuses when
 * the current version is not active (there is nothing in production to come back
 * from) and when there is no earlier active version (nowhere to go back to).
 */
export function promptVersionRollbackTool({ store }) {
  return {
    name: 'amzn_prompt_version_rollback',
    description:
      'Roll production back to the prompt\'s PREVIOUS ACTIVE version (F11-05). This is NOT amzn_prompt_rollback: '
      + 'that one swaps the BODY to a frozen version and bumps the edit counter; this one moves WHICH VERSION IS IN '
      + 'PRODUCTION and writes no body at all — the earlier version\'s body was frozen when it was replaced, so it is '
      + 'still readable. Refuses, by name, unless the current version is itself active (nothing in production means '
      + 'there is nothing to roll back from) and there is an earlier active version to return to (a first active '
      + 'version has nowhere to go). The version left behind is recorded as `rolled_back`, which is a different fact '
      + 'from `deprecated`. This writes to the database: confirm with the user before calling it.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提示词 id。' },
        note: { type: 'string', description: '留一句话：为什么退回上一活动版本。' },
      },
      required: ['id'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id === '') return { ok: false, error: '给一个提示词 id —— amzn_prompt_version_rollback 要知道退回哪一条。' }
      const row = getPrompt(store, id)
      if (row === null) return { ok: false, error: `没有提示词 ${id}（它可能被删了，或者 id 抄错了）。` }
      let done
      try {
        done = rollbackPromptVersion(store, { id, by: 'agent', note: args?.note ?? null })
      } catch (error) {
        /* `{ok:false}` 而不是一句话：审计漏斗按这个字段判断「写没有发生」，否则一次
           被拒的回滚会被记成一次真的回滚（见 amzn_prompt_lifecycle_transition）。 */
        return { ok: false, error: `回滚被拒绝：${error.message}`, hint: '提示词库未变。' }
      }
      return `已回滚：提示词 ${id} 的生产版本从 v${done.rolledBackFrom} 退回 v${done.rolledBackTo}`
        + `（v${done.rolledBackFrom} 记为 rolled_back）。`
        + '正文一个字都没改 —— v' + done.rolledBackTo + ' 的正文当时就被冻着，现在又成为生产用的那一份。'
        + '\n想再回到 v' + done.rolledBackFrom + '：它的状态是 rolled_back，'
        + '要走 rolled_back → review → testing → active 才能重新上岗（被回滚的版本要重新评审）。'
    },
  }
}

/* ══ F11-07 固定评估集 ══════════════════════════════════════════════════════════
 *
 * 需求原文（v2.0 §3.11 F11-07）：**固定评估集** —— 八类覆盖样例 + 口径陷阱样例，
 * 每条的期望行为是「指出问题或拒绝下结论」。
 *
 * ## 为什么这一批先做，而且现在能做
 *
 * 它是 P1 且**真的缺失**（不是「做了一半」）：`src/tools/prompt.js:552` 的
 * `amzn_prompt_lifecycle_transition` 已经在告诉用户
 * 「下一步: review → testing（在固定评估集上跑）→ active」，
 * 而全仓**没有任何评估集** —— 「向用户承诺了一个不存在的东西」正是本仓反复出现的
 * 缺陷形状（承诺了能力然后把它丢掉）。修法只有两条：要么把评估集建出来，要么
 * 把那句话删掉。这里选前者，因为评估集本身不依赖 LLM：
 * **样例与期望都是人写死的固定数据**，不需要模型来「跑分」。
 *
 * ## 这里没有「跑评估」——这是刻意的
 *
 * 本插件没有 LLM 通道。所以这一批交付的是**评估集的读写**，不是**评估**。
 * 三个工具里没有一个是「执行」：`import` 存、`list` 看目录、`show` 看一条。
 * 一个 `amzn_prompt_eval_run` 会需要一个不存在的评估器，它的输出只能是编的 ——
 * 而「编一个通过率」正是本仓最不能犯的错（见 `tests/amzn-...` 系列的「没有产生者的
 * 数字不造」）。将来真有评估器，它带来的是一张**结果表**（新迁移），
 * 不是往现有 `expected` 列里塞结果 —— 那样「期望」与「结果」就混成一个字段，
 * 「还没跑过」会被读成「跑过了」。
 *
 * ## 「没有集合」与「集合是空的」必须分开说
 *
 * `amzn_prompt_eval_show` 对不存在的集合返回 `null` 相关的明确话术，
 * `amzn_prompt_eval_list` 对空集合给 `isEmpty: true`。两者折叠成一个「0 条」会让
 * 「我 id 抄错了」与「这个集合确实是空的」变成同一个答案 —— 前者要改 id，后者要导样例。
 */

/**
 * Import (or replace wholesale) one eval-set version.
 *
 * This is the only writer. It refuses, by name, every shape a reader could not rely
 * on: an empty `cases` array (an "eval set" with nothing in it is not an eval set),
 * a case with no `expected`, duplicate case ids, a case with no `input`. Each refusal
 * returns `{ok:false, ...}` rather than a bare sentence — the audit funnel decides
 * "this write did not happen" from `value?.ok === false`, and a bare string would be
 * recorded as a successful write.
 */
export function promptEvalImportTool({ store }) {
  return {
    name: 'amzn_prompt_eval_import',
    description:
      'Import one fixed evaluation set version (F11-07): a named, versioned list of cases that a prompt version is '
      + 'later judged against. Each case needs a caseId, an input (the frozen fixture handed to the prompt), an '
      + 'expected (what the run must do — for these sets almost always 「指出问题」 or 「拒绝下结论」), and optionally '
      + 'expectRules (rule ids that must fire). Importing the same (setId, version) again REPLACES that version\'s '
      + 'cases wholesale, in one transaction. This stores the set; it does NOT run it — there is no evaluator in this '
      + 'plugin, so no pass rate is produced here and none should be inferred. '
      + 'This writes to the database: confirm with the user before calling it.',
    parameters: {
      type: 'object',
      properties: {
        setId: { type: 'string', description: '评估集 id，例如 "keyword-coverage"。' },
        version: { type: 'string', description: '版本，例如 "v1"。同一 (setId, version) 再导一次 = 整份替换。' },
        title: { type: 'string', description: '这套评估集评估的是什么。' },
        category: { type: 'string', description: '这套评估集的类别，例如 "coverage" / "口径陷阱"。单条样例可以用自己的 category 覆盖。' },
        note: { type: 'string', description: '留一句话：这套集子怎么来的、依据是什么。' },
        cases: {
          type: 'array',
          description: '样例数组，至少一条。',
          items: {
            type: 'object',
            properties: {
              caseId: { type: 'string', description: '样例 id，同一集合内唯一。' },
              input: { type: 'object', description: '冻结的输入夹具。' },
              expected: { type: 'string', description: '期望行为。' },
              expectRules: { type: 'array', items: { type: 'string' }, description: '必须命中的规则 id。空数组 = 这条不检查规则命中。' },
              category: { type: 'string', description: '覆盖集合级 category。' },
              caseIndex: { type: 'integer', description: '集合内顺序。默认按数组下标。' },
            },
            required: ['caseId', 'input', 'expected'],
          },
        },
      },
      required: ['setId', 'version', 'title', 'category', 'cases'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      let done
      try {
        done = importEvalSet(store, {
          setId: args?.setId,
          version: args?.version,
          title: args?.title,
          category: args?.category,
          note: args?.note,
          cases: args?.cases,
        })
      } catch (error) {
        /* ⚠️ 必须 `{ok:false}` 而不是一句话：审计漏斗（src/tools/index.js:428）
           与工具遥测（同文件 :400）都按 `value?.ok === false` 判断「这次写没发生」。
           只回一句话的拒绝会被记成一次真的导入。 */
        return {
          ok: false,
          error: `导入被拒绝：${error.message}`,
          hint: '评估集库未变。',
        }
      }
      const lines = []
      lines.push(`已导入评估集 ${done.set.id} ${done.set.version}：${done.imported} 条样例`)
      lines.push(`标题: ${done.set.title}`)
      lines.push(`类别: ${done.set.category}`)
      if (done.set.note !== null) lines.push(`备注: ${done.set.note}`)
      lines.push('')
      lines.push('⚠️ 这套集子现在**只是存着**：本插件没有评估器，所以它不会被自动跑，也没有通过率。')
      lines.push('要评审一条提示词版本，用 amzn_prompt_eval_show 把样例读出来，逐条对照期望行为。')
      return lines.join('\n')
    },
  }
}

/**
 * List every eval set with its case count and category distribution.
 *
 * `caseCount` and `isEmpty` are both reported: `0` alone cannot be told apart from
 * "you asked for the wrong set", while `isEmpty` is the set saying so about itself.
 */
export function promptEvalListTool({ store }) {
  return {
    name: 'amzn_prompt_eval_list',
    description:
      'List the fixed evaluation sets (F11-07) with, for each version, its title, category, case count, whether it is '
      + 'EMPTY (a finding, not an error — an imported-but-empty set is possible only if it was built that way), and '
      + 'the per-category case counts. Read-only. Use amzn_prompt_eval_show to read the cases themselves.',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute() {
      const sets = listEvalSets(store)
      const lines = []
      if (sets.length === 0) {
        lines.push('评估集库是空的 —— 一套都还没导入。')
        lines.push('用 amzn_prompt_eval_import 导入第一套（setId + version + title + category + cases）。')
        lines.push('⚠️ 「一套都没有」与「有一套但它是空的」是两件事，别把这一条读成后者。')
        return lines.join('\n')
      }
      const empty = sets.filter(set => set.isEmpty).length
      lines.push(`评估集: 共 ${sets.length} 套/版本${empty > 0 ? `（其中 ${empty} 套没有样例）` : ''}`)
      lines.push('')
      lines.push(table(sets, [
        { label: 'id', value: row => row.id },
        { label: '版本', value: row => row.version },
        { label: '标题', value: row => truncate(row.title, 22) },
        { label: '类别', value: row => row.category },
        { label: '样例', value: row => (row.isEmpty ? '0（空）' : String(row.caseCount)) },
        { label: '分布', value: row => (row.categories.length === 0 ? '—' : row.categories.map(c => `${c.category}×${c.count}`).join(' ')) },
      ]))
      lines.push('')
      lines.push('⚠️ 这里**没有**通过率、没有「上次跑的结果」—— 本插件没有评估器，没有任何数字来自一次运行。')
      return lines.join('\n')
    },
  }
}

/**
 * Show one eval set version, or say clearly that it does not exist.
 *
 * The two answers are different facts: `null` means "there is no such set version"
 * (a wrong id), an empty array means "this set exists and holds nothing". Both are
 * stated in their own words so the reader knows which one to act on.
 */
export function promptEvalShowTool({ store }) {
  return {
    name: 'amzn_prompt_eval_show',
    description:
      'Show one fixed evaluation set version (F11-07) and all of its cases, in order: caseId, category, the frozen '
      + 'input, the expected behaviour, and any rules that must fire. Omit `version` to get the newest version of that '
      + 'set. Distinguishes 「没有这个集合」 (nothing is printed as a set) from 「这个集合是空的」 (0 cases is stated '
      + 'as such) — they call for different actions. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        setId: { type: 'string', description: '评估集 id。' },
        version: { type: 'string', description: '版本。不给 = 取最新一版。' },
      },
      required: ['setId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const setId = String(args?.setId ?? '').trim()
      if (setId === '') {
        return { ok: false, error: '给一个评估集 id —— amzn_prompt_eval_show 要知道读哪一套。' }
      }
      const set = getEvalSet(store, setId, args?.version)
      if (set === null) {
        /* 「没有这一套」与「有一套但是空的」是两件事 —— 这里说的是前者。 */
        const wanted = args?.version === undefined || args?.version === null ? '' : ` ${String(args.version).trim()}`
        return { ok: false, error: `没有评估集 ${setId}${wanted}（id 或版本抄错了，或者它还没被导入）。` }
      }
      const cases = listEvalCases(store, setId, set.version)
      const lines = []
      lines.push(`评估集 ${set.id} ${set.version} —— ${set.title}`)
      lines.push(`类别: ${set.category}${set.note === null ? '' : ` · 备注: ${set.note}`}`)
      lines.push(`样例: ${cases.length} 条${cases.length === 0 ? '（**这一套是空的** —— 它是存在的，只是没有内容）' : ''}`)
      lines.push('')
      if (cases.length === 0) {
        lines.push('空的评估集不能评审任何东西，但它**不等于**「没有这一套」：')
        lines.push('前者要重新导入内容，后者要改 id。这就是两者分开说的理由。')
        return lines.join('\n')
      }
      for (const entry of cases) {
        lines.push(`【${entry.caseIndex}】${entry.caseId}（${entry.category}）`)
        lines.push(`  输入: ${JSON.stringify(entry.input)}`)
        lines.push(`  期望: ${entry.expected}`)
        lines.push(`  必中规则: ${entry.expectRules.length === 0 ? '（这条不检查规则命中）' : entry.expectRules.join(', ')}`)
      }
      lines.push('')
      lines.push('⚠️ 以上是**期望**，不是结果。本插件没有评估器 —— 这些样例不会被自动跑，'
        + '也没有任何一条「已经通过」的记录。')
      return lines.join('\n')
    },
  }
}

/**
 * F11-09 引用追踪 —— 「这条提示词被哪些运行用过？」
 *
 * ## 为什么这个出口必须是**两条并列的列表**，而不是一个数字
 *
 * optimize run 与 agent run 记的东西不一样：前者在 `package_json.prompts[]` 里存了
 * **活动版本的权威版本号**，能回答「用的是第几版」；后者只存集合 id，它同行的
 * `prompt_set.version` 在本仓库**从不更新**（实测 `UPDATE prompt_set` 出现 0 次）。
 *
 * 把两者加成一个「被 N 次运行使用」的数字，就等于把「不知道版本」渲染成「知道」。
 * 所以这里出两个列表，各自带**自己的证据等级**，且写明为什么不加。
 */
export function promptReferencesTool({ store }) {
  return {
    name: 'amzn_prompt_references',
    description:
      'Reverse lookup (F11-09): which runs used this prompt? Answers in TWO lists that must not be added together. '
      + '`byVersion` — optimize runs, which pinned the authoritative ACTIVE version number their package rendered, so '
      + 'this answers "which revision did that report use". `bySetOnly` — agent runs, which only recorded the prompt '
      + 'SET they drew from; the `prompt_set.version` they also stored is a column this repository never updates, so '
      + 'these are CANDIDATES ("the run drew from this set, which may or may not have included this row"), not matches. '
      + 'A prompt id that does not exist is an error, not an empty answer. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提示词 id（amzn_prompt_list 里能看到）。' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id === '') return '给一个提示词 id —— amzn_prompt_references 要知道反查哪一条。'

      let found = null
      try {
        found = promptReferences(store, { id })
      } catch (error) {
        /* The store throws for an unknown id on purpose: an empty answer would
           read as "nothing uses it", which is the exact question this tool
           exists to answer. So a refusal here is a real answer, not a failure —
           it still returns a string (this tool is read-only, it writes no audit
           row, so the `{ok:false}` shape the two writing tools need does not
           apply here). */
        return String(error.message)
      }

      const lines = []
      lines.push(`引用追踪 · ${found.prompt.module} · ${found.prompt.label}（当前编辑计数 v${found.prompt.version}）`)
      lines.push('')

      /* The two lists, and the sentence that says why they are two. */
      lines.push(`① 能定位到**具体版本**的运行：${found.byVersion.length} 条`)
      lines.push(`   ${referenceMatchMeaning('version')}`)
      if (found.byVersion.length === 0) {
        lines.push('   （没有 optimize run 的包里出现过这一条 —— 这不等于「没人用过它」，'
          + '只是没有运行的包记下了它。）')
      } else {
        lines.push(table(found.byVersion, [
          { label: '运行', value: row => row.runId.slice(0, 8) },
          { label: 'ASIN', value: row => row.asin },
          { label: '站点', value: row => row.marketplace },
          { label: '状态', value: row => row.status },
          { label: '层', value: row => layerLabel(row.layer) },
          { label: '用的版本', value: row => (row.version === null ? '—（包里没写）' : `v${row.version}`) },
          { label: '还是当前版', value: row => (row.version === null ? '—' : row.isCurrent ? '是' : '已过期') },
          { label: '时间', value: row => shortTime(row.startedAt) },
        ]))
      }
      lines.push('')

      lines.push(`② 只能定位到**集合**的运行：${found.bySetOnly.length} 条`)
      lines.push(`   ${referenceMatchMeaning('set')}`)
      if (found.bySetOnly.length === 0) {
        lines.push('   （没有 agent run 的快照里出现过这一条所属的集合。）')
      } else {
        lines.push(table(found.bySetOnly, [
          { label: '运行', value: row => row.runId.slice(0, 8) },
          { label: '角色', value: row => row.role },
          { label: '状态', value: row => row.status },
          { label: '用的版本', value: () => '未知' },
          { label: '它存的值', value: row => (row.storedSetVersion === null ? '—' : `${row.storedSetVersion}（从不更新）`) },
          { label: '时间', value: row => shortTime(row.startedAt) },
        ]))
      }
      lines.push('')

      /* Scan honesty: "3 references" has to be distinguishable from "the scan
         stopped at 3". */
      const opt = found.scanned.optimize
      const ag = found.scanned.agent
      lines.push(`扫描范围：optimization_run 读了 ${opt.read} 条（上限 ${opt.limit}，其中 ${opt.carriedPrompts} 条包里带 prompts）；`
        + `agent_run 读了 ${ag.read} 条（上限 ${ag.limit}）。`)
      if (!found.scannedComplete) {
        lines.push('⚠️ **扫描触到了上限**：上面的条数是「读到的范围内」的条数，可能还有更早的运行没被读到。')
      }
      lines.push('')
      lines.push('⚠️ 两个列表**不能相加**：① 是「这一条被用过」的证据，② 是「这一次运行取自这个集合」的证据 ——'
        + '后者既不能确认也不能排除用过这一条。')
      lines.push('「版本被采纳的字段 + 30 天观测结论」的关联尚未建模（publication_record 与 observation_plan 里没有 prompt 引用），'
        + '所以本工具只回答「被哪些运行用过」，不回答「用了之后效果如何」。')
      return lines.join('\n')
    },
  }
}

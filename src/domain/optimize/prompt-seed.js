/**
 * The prompt library's seed, as data.
 *
 * Two families, and they came from different places:
 *
 *   - **`button`** — the 12 sets (plus the shared `common` one) that used to be
 *     the `PROMPT_SETS` constant in `page.js`. They are transcribed here verbatim
 *     from that constant, with the two interpolations turned into templates:
 *     `'对' + scope + '…'` became `对{{scope}}…`, and the conditional tail became
 *     an optional section. `tests/prompt-snapshot.json` holds the rendering of the
 *     original constant, so "verbatim" is checked byte-for-byte rather than
 *     claimed — see the snapshot test.
 *
 *   - **`assemble`** — new in this step. `amzn_optimize_prepare` had no instruction
 *     block at all: it handed the agent data and a format, and the standing policy
 *     for *how* to write a listing lived only in the model's head. Three layers,
 *     because they change for different reasons and at different rates:
 *     `fixed` (strategy), `evidence` (what counts as a source), `contract` (the
 *     shape of what comes back).
 *
 * The seed is *generated into* the v13 migration from this module rather than
 * typed into `schema.js`, the same way `SEED_ROSTER` feeds v10. One source, no
 * second copy to drift.
 *
 * `variables` is derived from the body by the template parser, never hand-listed —
 * a hand-listed variable set is exactly the second copy that goes stale.
 */

import { createHash } from 'node:crypto'

import { templateVariables } from './prompt.js'

/** Where the button half came from, for anyone auditing the transcription. */
export const PROMPT_SEED_SOURCE = 'PROMPT_SETS / COMMON_PROMPTS (page.js, pre-B04)'

/**
 * The label every seeded set carries. It is a *generation* label, not a date:
 * the first generation of the library. Writing a date here would make the value
 * look like a fact about when a prompt changed, which it is not — each prompt
 * row carries its own integer `version`, bumped every time it is saved.
 */
export const PROMPT_SEED_VERSION = 'seed-1'

/**
 * The pseudo-module whose buttons are appended after every real module's own.
 * It is not in `MODULES` (the nav), which is exactly why it needs a name: the
 * store's closed module set is the nav plus this one.
 */
export const PROMPT_COMMON_MODULE = 'common'

/**
 * A uuid for a seed row that is the *same* on every install.
 *
 * The column is a uuid, and a user-created prompt gets a `randomUUID()` — but a
 * seeded row must be reproducible: the migration writes fixed ids so the seed can
 * be asserted against a fixture, and so two installs agree about which row is
 * which. A random id here would make the migration's own output untestable.
 */
function seedUuid(key) {
  const hex = createHash('sha1').update(`amazon-ops/prompt/${key}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The stable id of the prompt set for one module. */
export function promptSetId(module) {
  return seedUuid(`set/${module}`)
}

/** The stable id of one seeded prompt row. */
export function promptRowId(module, scenario, sortOrder) {
  return seedUuid(`row/${module}/${scenario}/${sortOrder}`)
}

/**
 * The page buttons, one entry per button, in the order the module drew them.
 * `sortOrder` is per module, so a module's buttons keep their original order.
 */
const BUTTON_PROMPTS = [
  // collect
  { module: 'collect', label: '看进度', body: '最近的采集任务跑到哪了？有失败或被风控拦下的吗？' },
  { module: 'collect', label: '跑采集', body: '采集{{scope}}，用 browser-local 源。' },
  { module: 'collect', label: '自检选择器', body: '跑一次采集通道自检，确认选择器还能命中。' },

  // asin
  { module: 'asin', label: '看现状', body: '看看{{scope}}现在的情况：字段完整性、来源、关键词覆盖。' },
  { module: 'asin', label: '查缺口', body: '对{{scope}}做关键词覆盖分析，列出缺口和该补的词。' },
  { module: 'asin', label: '跑采集', body: '对{{scope}}提交一次采集，用 browser-local 源。' },
  { module: 'asin', label: '跑优化', body: '对{{scope}}跑一次 listing 优化，校验合规后输出优化报告。' },

  // competitor
  { module: 'competitor', label: '竞品差集', body: '对{{scope}}做竞品词差集：找出竞品占据而我们缺席的词，按搜索量排序并说明数据来源。' },
  { module: 'competitor', label: '指定竞品', body: '用这组竞品 ASIN 做「我们 vs 竞品」分析：先说我该给哪几个 ASIN，再出差集。' },

  // research
  { module: 'research', label: '建词库', body: '用这几个种子词扩词建库：bluetooth speaker。' },
  { module: 'research', label: '测覆盖', body: '对{{scope}}跑一次关键词覆盖扫描，每词扫 2 页。' },
  {
    module: 'research',
    label: '看缺口',
    body: '对{{scope}}做关键词覆盖分析，列出缺口和该补的词。{{#selectedKeywords}}重点看 {{selectedKeywords}}。{{/selectedKeywords}}',
  },
  { module: 'research', label: '查词库', body: '关键词库里现在有哪些 T1/T2 的词？按分层给我看看。' },

  // kw
  { module: 'kw', label: '导入源目录', body: '把 D:\\amazon-ops-hub\\03-knowledge\\keywords\\master\\source 下的文件全部导入关键词总库，先 dryRun 给我看一遍识别结果。' },
  { module: 'kw', label: '看总库', body: '关键词总库现在什么情况？有多少词、多少有搜索量、产品线怎么分布？' },
  { module: 'kw', label: '找机会词', body: '从关键词总库里找出我们缺席但有搜索量的词，按搜索量排序，说明判断依据。' },
  { module: 'kw', label: '查周期重叠', body: '关键词总库里有哪些广告报告的统计周期是重叠的？重叠会让总量虚高，告诉我该排除哪一个。' },
  { module: 'kw', label: '出四份表', body: '按 SOP 出关键词总库的四份应用表：标题、五点、后台搜索词、广告关键词，导出成 CSV 并告诉我路径。' },
  {
    module: 'kw',
    label: '要报告',
    body: '给关键词总库出一份报告，先说清楚数据边界 —— 哪些数字是缺的。{{#selectedKeywords}}重点看 {{selectedKeywords}}。{{/selectedKeywords}}',
  },

  // pipeline
  { module: 'pipeline', label: '跑管道', body: '对{{scope}}跑一次关键词管道：筛选 → 分层 → 分派 → 落位 → 出表，每步给我输入输出数。' },
  { module: 'pipeline', label: '看历史', body: '关键词管道最近几次运行都做了什么？每步输入输出数是多少？' },

  // rules
  { module: 'rules', label: '看规则', body: '现在生效的规则是哪个版本？一共多少条？有判定无文档（手册里找不到出处）/ 有文档无判定（没有 code 规则引用）各有哪些？' },
  { module: 'rules', label: '导入手册', body: '用 amzn_rule_import 把规则手册导入成新版本：先 dryRun 给我看新增、变更、移除的差异，不要直接写库。它只能新增/更新 doc 行，不许动那 72 条 code 规则。' },
  { module: 'rules', label: '启用版本', body: '把规则版本 {{rulesVersion}} 设为生效版本，并确认版本链没断。' },
  { module: 'rules', label: '版本对比', body: '对比规则版本 {{rulesVersion}} 和它的上一个版本，列出新增、移除、改了哪些字段。' },

  // policy
  { module: 'policy', label: '看政策', body: '最近有哪些新政策？分别影响哪些规则和字段？' },
  { module: 'policy', label: '导入政策', body: '我把一段亚马逊政策粘贴给你，解析入库并告诉我生效日期和影响范围。' },
  { module: 'policy', label: '导入并取代', body: '把这份新政策导入，并取代旧的那份 —— 用带 supersedes 的 amzn_policy_import，告诉我谁取代了谁。' },

  // optimize
  { module: 'optimize', label: '跑优化', body: '对{{scope}}跑一次 listing 优化：先 prepare，我看过数据包再校验、再出报告。' },
  { module: 'optimize', label: '全量字段', body: '这次优化要把全部字段都出一版：标题、Item Highlights、五点、描述、后台词、A+、品牌故事、Q&A、图片 Alt Text、属性字段，一个都不要漏。' },
  { module: 'optimize', label: '换站点', body: '这批 ASIN 换到日本站跑一次优化 —— 上限、计量单位和购买习惯都按日本站来，不要套美国站的数字。' },
  { module: 'optimize', label: '看校验', body: '把最近一轮优化的阻断项按字段列出来，每条注明依据哪条规则。' },
  { module: 'optimize', label: '看闸门', body: '最近一轮优化的六道闸门过了几道？没过的那几道具体缺什么？' },
  { module: 'optimize', label: '要报告', body: '最近一轮优化的报告在哪？把 Markdown 和 HTML 的路径都给我。' },
  { module: 'optimize', label: '排期', body: '库里哪些 ASIN 还没做过优化？按 BSR 和关键词缺口给我一个优化排期。' },

  // prompts
  { module: 'prompts', label: '看提示词', body: '优化用的提示词现在有哪几套？分别是哪些模块的？' },
  { module: 'prompts', label: '改提示词', body: '把优化组装提示词里的固定策略层改一行，让产物用上新文本。' },

  // report
  { module: 'report', label: '要报告', body: '最近一轮优化的报告在哪？给我链接。' },
  { module: 'report', label: '对比轮次', body: '把{{scope}}最近两轮优化的差异说清楚：哪些字段改了、覆盖涨了还是掉了。' },

  // settings
  { module: 'settings', label: '站点配置', body: '现在各站点的默认邮编和采集通道是怎么配的？' },
]

/** The shared button, appended after every module's own set. */
const COMMON_PROMPTS = [
  { module: 'common', label: '数据源', body: '现在有哪些数据源可用？哪些字段拿不到？' },
]

/**
 * The `assemble` block `amzn_optimize_prepare` hands the agent.
 *
 * The three layers answer three different questions, and they are separate rows
 * rather than one blob because they change for different reasons: the strategy
 * layer is a house style, the evidence layer is a sourcing policy, and the
 * contract layer tracks the shape of `amzn_optimize_validate`'s input.
 */
const ASSEMBLE_PROMPTS = [
  {
    module: 'optimize',
    layer: 'fixed',
    label: '固定策略层',
    body: [
      '你是这个 ASIN 的 listing 文案作者。下面这些策略不随本轮数据变化，每一版都照此写。',
      '',
      '1. 只写这个产品是什么，不写没有依据的话。规格、材质、尺寸、认证、产地，凡产品资料里没有的，一个字都不写 —— 编一个数字比少一个卖点坏得多。',
      '2. 标题先给身份、再给差异点。开头是最重要的位置，放最有价值的人话，不要用关键词堆砌开头。',
      '3. 五点各自独立成立：一条一个卖点，第一条给最大的差异，最后一条收口到使用场景。不要把一段话拆成五条，也不要把五个卖点挤进一条。',
      '4. 埋词服从可读性。词是为句子服务的；读起来别扭就把词换到别的位置，不要为了塞词把句子写坏。',
      '5. 不写绝对化用语（最好 / 第一 / 永久）、不写竞品名、不做未证实的承诺、不写医疗或安全功效。这些是硬规则，不是风格偏好。',
      '6. 同一个卖点不要用同一句话说两遍。A+ 与品牌故事是补充场景和信任，不是把五点抄一遍。',
    ].join('\n'),
  },
  {
    module: 'optimize',
    layer: 'evidence',
    label: '证据层',
    body: [
      '每一条文案都要有出处。按下面的优先级取证，取不到就删掉那句话，不要留着凭感觉写。',
      '',
      '1. 产品资料与属性注册表里已有的字段（材质、尺寸、认证、适用场景）—— 直接引用，可以量化。',
      '2. 本轮数据包里的关键词与排名 —— 用来说明「这个词为什么值得进标题」，而不是硬塞进去。',
      '3. 采集到的竞品文案 —— 只用来判断这个类目通常怎么写，不要抄它的具体承诺或数字。',
      '4. 你对这个类目的常识 —— 最后才用，且不能变成具体数字。',
      '',
      '{{#policies}}',
      '本轮生效中的政策 —— 这些是**硬约束**，不是参考材料。与它们冲突的写法一律不交：',
      '{{policies}}',
      '{{/policies}}',
      '',
      '数据包里标为「必须人工填」的字段，是采集拿不到、也推不出来的：需要时向用户要，不要自己填一个。',
      '数据包里「机检管不了」的那几条（规格是否编造、前后是否自相矛盾）是你要下的结论，不是可以跳过的项。',
    ].join('\n'),
  },
  {
    module: 'optimize',
    layer: 'contract',
    label: '输出契约层',
    body: [
      '交回来必须是一个 JSON 对象：',
      '',
      '{ "runId": "<数据包里的 runId>", "draft": { … }, "rationale": { … } }',
      '',
      '契约要点：',
      '- 只提交你要改的字段。没提交的字段不进报告，也不会被改动。',
      '- 每个字段的上限见数据包的「字符预算」；后台搜索词按字节算（一个中文 3 字节），其余按字符算。',
      '- 标题与 Item Highlights 是强制联动组：标题承诺了什么，这里要对得上。',
      '- rationale 每一条写清三件事：改了什么、依据哪条规则、植入了哪些词。',
      '- 先调 amzn_optimize_validate，把阻断项改到没有，再调 amzn_optimize_save 落库并出报告。',
    ].join('\n'),
  },
]

/**
 * Every seed row, in the shape the `prompt` table takes.
 *
 * `id`, `set_id`, `variables_json` and `sort_order` are named after the columns
 * on purpose: this is the projection the migration writes, and a rename here that
 * is not a rename there is a silent mismatch. `variables_json` is derived from
 * the body by the parser, and `id` / `set_id` are the deterministic uuids above,
 * so the seed is reproducible rather than random.
 */
export function promptSeedRows() {
  const rows = []
  const order = new Map()
  const push = entry => {
    const key = `${entry.module}:${entry.scenario}`
    const sortOrder = order.get(key) ?? 0
    order.set(key, sortOrder + 1)
    rows.push({
      id: promptRowId(entry.module, entry.scenario, sortOrder),
      set_id: promptSetId(entry.module),
      module: entry.module,
      scenario: entry.scenario,
      layer: entry.layer ?? null,
      label: entry.label,
      body: entry.body,
      variables_json: JSON.stringify(templateVariables(entry.body)),
      sort_order: sortOrder,
    })
  }

  for (const entry of BUTTON_PROMPTS) push({ ...entry, scenario: 'button' })
  for (const entry of COMMON_PROMPTS) push({ ...entry, scenario: 'button' })
  for (const entry of ASSEMBLE_PROMPTS) push({ ...entry, scenario: 'assemble' })
  return rows
}

/**
 * One `prompt_set` row per seeded module, in the order the modules first appear.
 *
 * A set is per *module*, not per (module, scenario): the scenarios are a column
 * on the prompt row, so a module's buttons and its assemble block live in one
 * set and a reader opens one place to see everything that module sends.
 */
export function promptSeedSets() {
  return promptSeedModules().map(module => ({
    id: promptSetId(module),
    module,
    name: module === PROMPT_COMMON_MODULE ? '通用按钮（所有模块共用）' : `${module} 的提示词`,
    version: PROMPT_SEED_VERSION,
    note: `${PROMPT_SEED_SOURCE}；button 为页面按钮，assemble 为 amzn_optimize_prepare 的写作策略层。`,
  }))
}

/** The seeded modules, in the order they appear — used by the migration and tests. */
export function promptSeedModules() {
  const seen = []
  for (const entry of [...BUTTON_PROMPTS, ...COMMON_PROMPTS]) {
    if (!seen.includes(entry.module)) seen.push(entry.module)
  }
  return seen
}

/**
 * 交付边界（F13-09）—— 可复制字段、操作清单、发布登记跳转。
 *
 * ## 这一块补的是什么
 *
 * 审计 `RESEARCH-module-alignment-v2.0.md:354` 的三条缺口：
 *
 *   ① **没有操作清单**。报告第十二节今天是一段**写死的散文**（`report.js` 里六条
 *      序号，不随这一轮的内容变）：它说不出「哪几个字段、去哪儿、现在什么状态」。
 *      这里把它换成**由内容生成**的一份清单，一条一行、可勾。
 *
 *   ② **没有发布登记跳转**。`page.js` 的发布登记表单里 `runId` 与「草案版本」是两个
 *      空输入框，靠人手抄。跳转要带的是**从 run 行读回来的当前 `draft_version`**
 *      （链接里的字面量会在草案又改过之后变成一次注定被拒的登记，
 *      `tools/observe.js` 的 `amzn_publication_record` 要求版本等于当前值）。
 *
 *   ③ **交付边界本身没说清**。今天就两句话能说：「有草案」（`rows` 里有这个字段）
 *      与「必须人工填」（`MANUAL_FIELDS`）。可是**「插件不提供这个字段」与
 *      「插件提供、但这一轮没有生成它」不是一件事** —— 本仓为这种压缩付过很多次代价。
 *      这里分三类计数：`plugin` / `humanOnly` / `notGenerated`。
 *
 * ## 状态由内容重算，而且是**读回来**算的
 *
 * 每一条操作的 `status` 都不是自报的：
 *
 *   · 「这一条后台操作做完了没有」的持久事实**就是发布登记**（模块 14 §6）。
 *     本批**不新增**一个 `done` 列 —— 加了它就是给同一件事造第二份口径，
 *     而且那份口径永远比真实的后台晚一步。这里**读发布登记里 `published` 的键**，
 *     自己重算每一条的状态：写入方（`amzn_publication_record`）自报「实际改了哪些字段」，
 *     读者另算「哪些操作因此算做完了」—— 这就是一条读回对账。
 *
 *   · 「采纳了没有」读的是 `optimization_draft.accepted` 三态（本批不写它，只读）。
 *
 *   · 「人填的字段库内有没有」读的是 `MANUAL_FIELDS` + 事实表里有没有对应列
 *     （`done === null` 是**库内没有对应列**，不是「没填」）。
 *
 * ## 不发布
 *
 * `DELIVERY_SURFACES` 里的 `where` 全是**文字**（后台路径）。本插件不点任何
 * Seller Central 的按钮、不调任何发布接口（§15 的发布边界），跳转只往**模块 14 的
 * 发布登记**跳 —— 那是这个插件里唯一记录「人去后台做了什么」的地方。
 *
 * English comments explain why; a comment that disagrees with the code is a defect here.
 */

import {
  DRAFT_FIELDS, MANUAL_FIELDS, SECTIONS, isAttributeField, isPublishable,
  labelForField, sectionOf, fieldRank,
} from '../rules/listing-fields.js'
import { REQUIRED_ATTRIBUTE_TARGET } from '../rules/attributes.js'
import { listPublications } from '../../store/observe.js'

export const DELIVERY_VERSION = 'optimize-delivery.v1'

export const DELIVERY_SOURCE =
  '字段注册表（listing-fields.js 的 FIELDS / DRAFT_FIELDS / MANUAL_FIELDS / writebackSplit 同源）+ publication_record（模块 14 §6 的登记内容）'

export const DELIVERY_CODES = {
  NO_RUN: 'DELIVERY_NO_RUN',
  NO_DRAFTS: 'DELIVERY_NO_DRAFTS',
}

/**
 * 交付的落点：人拿着报告**去哪儿做**。
 *
 * `sections` 是这张表的另一半 —— 一个字段落在哪个落点，由它的 section 查出来
 * （`SURFACE_BY_SECTION` 是这张表**派生**的，不是第二张表）。这样加一个 section 却
 * 忘了给它落点，会被 `unmappedSurfaces` 数出来（报告与面板都会说），而不是悄悄归进
 * 「上架表格」。
 */
export const DELIVERY_SURFACES = [
  {
    id: 'listing-table',
    label: '上架表格',
    where: '卖家后台 → Inventory → Manage Inventory → Edit',
    kind: 'paste',
    sections: ['title', 'bullets', 'description', 'search_terms', 'item_highlights'],
  },
  {
    id: 'attributes',
    label: '属性字段',
    where: '卖家后台 → Inventory → Edit → Vital Info / 属性标签页',
    kind: 'paste',
    sections: ['attributes'],
  },
  {
    id: 'aplus',
    label: 'A+ 内容',
    where: '卖家后台 → A+ Content Manager（每个模块单独编辑）',
    kind: 'editor',
    sections: ['aplus'],
  },
  {
    id: 'brand_story',
    label: '品牌故事',
    where: '卖家后台 → 品牌 → 品牌故事控制台',
    kind: 'editor',
    sections: ['brand_story'],
  },
  {
    id: 'qa',
    label: 'Q&A 问答',
    where: '商品详情页的问答区（播种的问题要以买家身份提交）',
    kind: 'editor',
    sections: ['qa'],
  },
  {
    id: 'images',
    label: '图片 Alt Text',
    where: '卖家后台 → 图片管理（Alt Text 逐图填）',
    kind: 'editor',
    sections: ['images'],
  },
  {
    id: 'video',
    label: '视频',
    where: '卖家后台 → 视频管理（这里只给脚本要点；拍摄与上传不是这个插件的事）',
    kind: 'editor',
    sections: ['video'],
  },
  {
    id: 'manual',
    label: '插件不提供的字段',
    where: '卖家后台各处（上架表单 / 定价 / 类目 / 变体）',
    kind: 'human',
    sections: [],
  },
]

/** section → surface, derived from the one table above. */
const SURFACE_BY_SECTION = Object.fromEntries(
  DELIVERY_SURFACES.flatMap(surface => surface.sections.map(section => [section, surface.id])),
)

const SURFACE_BY_ID = Object.fromEntries(DELIVERY_SURFACES.map(surface => [surface.id, surface]))

/** Section ids the registry knows but no surface claims. Reported, never folded away. */
function unmappedSections() {
  return SECTIONS.map(section => section.id).filter(id => SURFACE_BY_SECTION[id] === undefined)
}

/** The surface a field is delivered through, or null when no surface claims its section.
 *  Private on purpose: it is a step inside `buildDelivery`, not a second way to ask the
 *  question — an exported helper that only its own module calls is how a codebase ends
 *  up with two entry points for one fact. */
function deliverySurfaceOf(field) {
  const section = isAttributeField(field) ? 'attributes' : sectionOf(field)
  if (section === null) return null
  const id = SURFACE_BY_SECTION[section]
  return id === undefined ? null : (SURFACE_BY_ID[id] ?? null)
}

const hasText = (value) => value !== null && value !== undefined && String(value) !== ''

/* ── 必须人工填的字段：三态 ─────────────────────────────────────────────────
 *
 * 这一块以前住在 `report.js` 里（报告第十一节）。F13-09 把它**移到这里**，理由是
 * 交付边界与那一节问的是同一个问题：「这个字段库内到底有没有」。两处各算一次，
 * 就会在两处给出不同的答案 —— 而它们今天已经共用同一个「库内有没有对应列」的判据。
 */

/**
 * 哪一个已采集的列能回答「这个手填字段是不是已经知道了」。
 *
 * 七个手填字段里只有两个在库内有对应物：价格与类目。其余五个（SKU / 库存 /
 * 变体主题 / 浏览节点 / 目标人群）在 Seller Central 里，这个插件从不读它们 ——
 * 所以那五个的诚实状态是「**库内没有对应列**」，不是「没填」。
 */
export const MANUAL_FIELD_EVIDENCE = {
  standard_price: 'price',
  product_category: 'category',
}

/**
 * 七个手填字段 + 它们的三态 `done`。
 *
 * `done`：`true` 库内有值 / `false` 库内为空 / `null` **库内没有能回答这个问题的列**。
 * 一开始它是写死的 `false`，于是报告把七个字段全列成「待填」，包括库内明明已经有的
 * 那个价格 —— 一个恒定的布尔值读起来总是像一条结论。
 */
export function manualFieldRows(asin = null) {
  return MANUAL_FIELDS.map(field => {
    const evidence = MANUAL_FIELD_EVIDENCE[field.id] ?? null
    const value = evidence === null ? null : (asin?.[evidence] ?? null)
    return {
      ...field,
      evidence,
      done: evidence === null ? null : value !== null && value !== undefined && value !== '',
    }
  })
}

/**
 * 库内状态的一句话 —— 交付清单与报告第十一节**共用这一处措辞**。
 *
 * `null`（库内没有对应列）是常见情况，而它与「空」是两件事：把两者压成一句，
 * 就是让报告说一件它并不知道的事。
 */
export function manualStatusLabel(field) {
  if (field?.done === null || field?.done === undefined) return '库内无对应字段，需人工确认'
  return field.done ? `已采集（${String(field?.evidence ?? '')}）` : '库内为空，需人工填'
}

/**
 * 这一轮已登记的发布内容 —— **读回来**的那一份。
 *
 * 只算 `kind = 'draft'` 的记录：`kind = 'manual'` 按 §6 不许带 runId（它关联不到任何
 * 一轮），`kind = 'rollback'` 说的是撤回而不是交付。把三者混起来会让「已登记」这句话
 * 变成一句无法追溯的声明。
 *
 * `listPublications` 是 `publication_record` 的读取口（本仓的唯一一处），所以这里不
 * 另写一个 SELECT；caps 与它是同一个（`limit` 上限 500）。取不满的情况对**这一轮**的
 * 交付边界影响可以忽略：一个 run 的发布登记不会有 500 条，真到了那个量级，
 * `registered.count` 与实际不符会先被观测那一侧发现。
 */
export function publicationsForRun(store, run) {
  if (run === null || run === undefined || String(run.id ?? '') === '') return []
  const listed = listPublications(store, {
    asin: run.asin ?? null,
    marketplace: run.marketplace ?? null,
    kind: 'draft',
    limit: 500,
  })
  return listed.rows.filter(record => record.runId === run.id)
}

/**
 * The delivery boundary of one run: boundary counts, the operation checklist, the
 * registration hand-off.
 *
 * `rows` is the round's draft rows, projected to `{ field, accepted, after }` — the
 * report's own rows and the page's inbox rows both carry exactly those three keys, so
 * neither caller has to translate, and `publishable` / labels are derived here from the
 * field registry rather than trusted from a caller that might pass a stale flag.
 */
export function buildDelivery({
  run = null,
  rows = [],
  manualFields = null,
  publications = [],
  now = new Date(),
} = {}) {
  if (run === null || String(run.id ?? '') === '') {
    return {
      ok: false,
      code: DELIVERY_CODES.NO_RUN,
      error: '交付边界挂在轮次上 —— 没有 run 就没有可交付的东西。先跑一次 amzn_optimize_prepare。',
    }
  }

  const list = (Array.isArray(rows) ? rows : []).map(row => ({
    field: String(row?.field ?? ''),
    accepted: row?.accepted === true,
    after: row?.after ?? null,
  })).filter(row => row.field !== '')

  /* 已登记发布的内容：**扫键**，不看任何自报的状态字段。 */
  const registeredFields = []
  const registeredAt = new Map()
  for (const record of Array.isArray(publications) ? publications : []) {
    for (const field of Object.keys(record?.published ?? {})) {
      if (!registeredFields.includes(field)) registeredFields.push(field)
      const at = record?.publishedAt ?? null
      if (!registeredAt.has(field) || (at !== null && String(at) > String(registeredAt.get(field)))) {
        registeredAt.set(field, at)
      }
    }
  }
  const latest = (Array.isArray(publications) ? publications : [])
    .slice()
    .sort((a, b) => String(b?.publishedAt ?? '').localeCompare(String(a?.publishedAt ?? '')))[0] ?? null

  const draftFields = new Set(list.map(row => row.field))
  const operations = []

  const statusOfRow = (row) => {
    if (registeredFields.includes(row.field)) return 'registered'
    if (row.accepted && hasText(row.after)) return isPublishable(row.field) ? 'ready' : 'editor'
    if (row.accepted) return 'no_text'
    return 'not_accepted'
  }

  for (const row of list) {
    const surface = deliverySurfaceOf(row.field)
    const status = statusOfRow(row)
    const label = labelForField(row.field)
    operations.push({
      id: `draft:${row.field}`,
      kind: 'draft',
      order: fieldRank(row.field),
      surface: surface === null ? 'unknown' : surface.id,
      surfaceLabel: surface === null ? '（注册表里没有给它落点）' : surface.label,
      where: surface === null ? null : surface.where,
      field: row.field,
      fieldLabel: label,
      accepted: row.accepted,
      publishable: isPublishable(row.field),
      status,
      statusLabel: DELIVERY_STATUS_LABELS[status] ?? status,
      action: draftAction(status, label, surface),
      registeredAt: registeredAt.get(row.field) ?? null,
    })
  }

  const fields = manualFields === null || manualFields === undefined ? MANUAL_FIELDS : manualFields
  for (const [index, field] of (Array.isArray(fields) ? fields : []).entries()) {
    /* `done` 是三态：true 库内有 / false 库内为空 / null 库内没有对应列。
       `null` **不是**「没填」——把它读成没填会让报告说一件它不知道的事。 */
    const status = field?.done === true ? 'human_known' : field?.done === false ? 'human_required' : 'human_unknown'
    const surface = SURFACE_BY_ID.manual
    const label = String(field?.label ?? field?.id ?? '')
    operations.push({
      id: `manual:${String(field?.id ?? index)}`,
      kind: 'manual',
      /* 人工字段排在草案字段之后：先交付能交付的，再去填只有人能给的那几项。 */
      order: 100000 + index,
      surface: 'manual',
      surfaceLabel: surface.label,
      where: surface.where,
      field: String(field?.id ?? ''),
      fieldLabel: label,
      accepted: null,
      publishable: false,
      status,
      /* 手填字段的状态措辞与报告第十一节**共用一处**（`manualStatusLabel`）——
         同一个三态在两处用两套话写，就是同一件事的两个说法。 */
      statusLabel: manualStatusLabel(field),
      action: manualAction(status, label, field),
      registeredAt: null,
    })
  }

  const notGenerated = DRAFT_FIELDS.filter(field => !draftFields.has(field))
  const attributeDrafts = list.filter(row => isAttributeField(row.field))
  const unmapped = unmappedSections()

  const ready = operations.filter(operation => operation.status === 'ready')
  const counts = {
    operations: operations.length,
    registered: operations.filter(operation => operation.status === 'registered').length,
    ready: ready.length,
    editor: operations.filter(operation => operation.status === 'editor').length,
    notAccepted: operations.filter(operation => operation.status === 'not_accepted').length,
    noText: operations.filter(operation => operation.status === 'no_text').length,
    humanRequired: operations.filter(operation => operation.status === 'human_required').length,
    humanKnown: operations.filter(operation => operation.status === 'human_known').length,
    humanUnknown: operations.filter(operation => operation.status === 'human_unknown').length,
  }

  return {
    ok: true,
    version: DELIVERY_VERSION,
    source: DELIVERY_SOURCE,
    runId: run.id,
    asin: run.asin ?? null,
    marketplace: run.marketplace ?? null,
    boundary: {
      /* 插件提供、这一轮真的起草了的字段。 */
      plugin: {
        count: list.length,
        fields: list.map(row => row.field),
        attributes: { drafted: attributeDrafts.length, target: REQUIRED_ATTRIBUTE_TARGET },
        note: '这些字段的草案由这一轮产出。属性字段是动态的（随类目变），所以这里只给条数；'
          + '逐项填写情况看报告的属性一节。',
      },
      /* 插件**不提供**的字段：采集不到、也推断不出来（MANUAL_FIELDS）。 */
      humanOnly: {
        count: (Array.isArray(fields) ? fields : []).length,
        fields: (Array.isArray(fields) ? fields : []).map(field => String(field?.id ?? '')),
        note: '插件**不提供**这些字段的值 —— 不是「这次没生成」，而是本仓没有它们的来源'
          + '（SKU / 库存 / 价格 / 类目 / 变体 / 浏览节点 / 目标人群）。',
      },
      /* 插件**会**提供、但这一轮没有生成草案的字段。 */
      notGenerated: {
        count: notGenerated.length,
        fields: notGenerated,
        note: '插件**会**提供这些字段（它们在字段注册表里），但**这一轮没有生成**它们的草案 ——'
          + '与上面那一条不是一件事：那一条是「本仓没有来源」，这一条是「这一轮没有输入或没有写」。',
      },
      totals: { drafted: list.length, registry: DRAFT_FIELDS.length },
    },
    operations,
    registration: {
      route: 'publication-record',
      sectionId: 'sect-publication',
      anchor: `publication:draft:${run.id}`,
      runId: run.id,
      /* 从 run 行**读回来**的当前草案版本。`draftVersionKnown: false`（读不到）与
         「版本是 0」是两句不同的话 —— `amzn_publication_record` 要求版本等于当前值。 */
      draftVersion: Number.isFinite(Number(run.draftVersion)) ? Number(run.draftVersion) : null,
      draftVersionKnown: Number.isFinite(Number(run.draftVersion)),
      fields: ready.map(operation => ({ field: operation.field, value: (list.find(row => row.field === operation.field) ?? {}).after ?? null })),
      registered: {
        count: registeredFields.length,
        fields: registeredFields,
        latestId: latest === null ? null : latest.id,
        latestAt: latest === null ? null : (latest.publishedAt ?? null),
        draftVersion: latest === null ? null : (latest.draftVersion ?? null),
      },
      hint: '**接受草案 ≠ 已发布**：本插件不在后台改任何东西。上面这些文字在你到后台改完、'
        + '并在这里登记发布之前，线上一个字都没变。登记是「人做过什么」的记录，不是「已上线」的证明。',
      at: (now instanceof Date ? now : new Date(now)).toISOString(),
    },
    counts: {
      ...counts,
      unmappedSurfaces: unmapped.length,
      notGenerated: notGenerated.length,
      humanOnly: (Array.isArray(fields) ? fields : []).length,
      registeredFields: registeredFields.length,
    },
    unmappedSurfaces: unmapped,
    empty: list.length > 0
      ? null
      : {
        kind: 'no-drafts',
        text: '这一轮还没有字段被起草过 —— 这不是「没有要交付的东西」：'
          + '先调 amzn_optimize_validate（带 persist）把草案写进这一轮，才谈得上交付边界。',
      },
  }
}

export const DELIVERY_STATUS_LABELS = {
  registered: '已登记发布',
  ready: '可复制粘贴',
  editor: '去独立编辑器',
  not_accepted: '草案未采纳',
  no_text: '本轮没有生成',
  /* 手填字段的三态措辞不在这里：它们与报告第十一节共用 `manualStatusLabel`。 */
}

/** 「做什么」那一句话，按状态给 —— 五句不同的话，不共用一句。 */
function draftAction(status, label, surface) {
  const where = surface === null ? '（落点未登记）' : surface.where
  switch (status) {
    case 'registered':
      return `已在 ${where} 改过并登记发布 —— 不用再做`
    case 'ready':
      return `把「${label}」复制进 ${where}`
    case 'editor':
      return `打开 ${where}，把「${label}」的草案贴进去`
    case 'not_accepted':
      return `这一条**没有被采纳**，不要去改 —— 要改先回收件箱改决策（amzn_optimize_save 的 accept）`
    case 'no_text':
      return `插件建模了「${label}」，但这一轮没有它的草案 —— 没有可交付的内容，不是「不需要改」`
    default:
      return `处理「${label}」`
  }
}

function manualAction(status, label, field) {
  const why = String(field?.why ?? '')
  switch (status) {
    case 'human_known':
      return `「${label}」库内已有（${String(field?.evidence ?? '')}）—— 上架前对着后台复核一次`
    case 'human_required':
      return `人工填「${label}」：${why}`
    default:
      return `「${label}」：${why}（本仓**没有**对应列，读不出它填了没有 —— 与「没填」不是一件事）`
  }
}

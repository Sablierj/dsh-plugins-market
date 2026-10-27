/**
 * The `setting` table: the user-facing configuration surface.
 *
 * Three families of key live here, and they are deliberately different in kind:
 *
 *   - **pacing.\*** — how hard the collector is allowed to work. Read on every
 *     task, never once at startup, because that is what makes a change take
 *     effect on the *next* task instead of after a plugin reload (B07 ②).
 *   - **browser.\*** — whether Chrome runs headless, and where its profile lives.
 *   - **marketplace.\<CODE\>.\*** — per-site overrides. Today only `postalCode`,
 *     which is the address the collector browses from (B07 ④).
 *
 * **What is deliberately NOT here**: `titleMax`, `units`, `authoritative`. Those
 * are verified market facts in `marketplaces.js`, not preferences — offering to
 * edit them is offering to edit the answer to "is this title legal" (§7 #3, and
 * the v17 migration says the same). The whitelist below is what makes that
 * structural: a key that is not declared is refused, so a fact cannot be
 * smuggled into the preference table even by a typo.
 *
 * The refusal has to be a **throw**, and it has to happen on write rather than
 * on read. A store that accepted `pacing.dailylimit` would sit there looking
 * correct while the real key stayed at its default — the exact silent-divergence
 * this file exists to prevent.
 */

import { MARKETPLACES } from '../sources/pages/index.js'

/** The declared settings: default value, validator, and what the page may say. */
const DECLARED = {
  /* 产品表（赛狐）导入目录。空 = 插件默认的 <dataDir>/imports/products。
     与 `kw.sourceDir` 的区别：那个的默认值指向 WSL 里那套旧系统，这个跟着插件走。 */
  'asin.sourceDir': {
    default: '',
    kind: 'string',
    note: '产品表导入目录。留空用插件默认目录（<插件数据>/imports/products）。',
    effect: '下次点「扫描目录」时生效',
  },
  'pacing.taskIntervalSec': {
    default: 45,
    kind: 'int',
    min: 1,
    note: '两条采集任务之间的最小间隔（秒），实际间隔在上限内随机。',
    effect: '下次采集任务生效（正在跑的任务沿用提交时读到的那一份）',
  },
  'pacing.maxAsinsPerTask': {
    default: 20,
    kind: 'int',
    min: 1,
    note: '单次任务最多提交多少个目标。超过会被拒绝，而不是排队。',
    effect: '下次采集任务生效（正在跑的任务沿用提交时读到的那一份）',
  },
  'pacing.dailyLimit': {
    default: 1200,
    kind: 'int',
    min: 1,
    note: '每天最多采集多少个目标，按目标计数而不是按任务。',
    effect: '下次采集任务生效（正在跑的任务沿用提交时读到的那一份）',
  },
  'browser.headless': {
    default: true,
    kind: 'bool',
    note: '采集时是否使用无头模式。关掉便于观察页面，但更慢。',
    effect: '下次采集任务生效',
  },
  'browser.profileDir': {
    default: null,
    kind: 'string',
    note: 'Chrome 用户数据目录，留空则用插件默认位置。',
    effect: '下次采集任务生效',
  },
  'collect.defaultSource': {
    default: 'browser-local',
    kind: 'string',
    note: '提交采集任务时默认用哪个通道。amzn_collect_submit 显式给了 source 时以它为准。',
    effect: '下次采集任务生效',
  },
  'collect.importDir': {
    default: null,
    kind: 'string',
    note: '导入文件的默认目录（关键词总库等）。留空则用约定路径。',
    effect: '下次导入生效',
  },
  /* 关键词数据源的**根目录**。与 `collect.importDir` 是两件事：那个是"去哪找文件"，
     这个是"那套固定结构的根在哪"。结构固定成 brand-terms / search-terms /
     sellerjingling / xiyou 四个子目录（见 domain/keywords/source-dir.js）。
     留空 = 用默认值（WSL 里那套系统的 keywords/master/source），不是"没有目录"。 */
  'kw.sourceDir': {
    default: null,
    kind: 'string',
    note: '关键词数据源根目录（下面是 brand-terms / search-terms / sellerjingling / xiyou）。'
      + '留空则用默认路径：WSL 里那套亚马逊运营系统的 keywords/master/source。',
    effect: '下次扫描 / 导入生效',
  },
  'onboarding.dismissedAt': {
    default: null,
    kind: 'string',
    /* Not a preference — a record of an act, which is why the value is a
       timestamp rather than a boolean: "it was collapsed" and "it was collapsed
       on the 3rd" cost the same to store and only one of them is still readable
       a month later. Declared here rather than written around the whitelist,
       because the whitelist is what turns a typo'd key into a throw. */
    note: '首次使用引导被收起的时间（ISO）。收起后首页不再显示引导卡；把这一项清空可以让引导回来。由首页的「收起引导」按钮写入。',
    effect: '下次刷新页面生效',
  },

  /* ── S1-B17 审批策略：六个可配置的二次确认 ────────────────────────────────
     每一项的 default 都是 false。这是一条**读法**，不是文档明文：§29.3 的那张
     矩阵说的是「哪些角色可以做这些操作」，没有为这六项要求额外确认 —— 把默认
     写成 true 就是发明一个文档里没有的闸门，还会让本来顺畅的六件事开始追问。

     「只能收紧、不能放宽」这条规则**只有一个来源**：domain/approval/policy.js 的
     setApproval 拿 **CONFIGURABLE_APPROVALS 里那一项声明的 default** 当下限。所以
     这里**不声明 floor** —— 曾经有两条在这里写了 `floor: false`，而全仓库没有一行
     代码读过它（`setApproval` 读的是 default），那是一份会和真规则漂移的第二份声明。
     routes.js 也曾把 `floor: item.default` 送进审批 payload，页面同样一行未读；两处
     都按「payload 里的每个字段都必须有读者」删掉了，页面要的是 cannotRelax。
     代价是它只管走 setApproval 的写入：页面 setting-set 与 amzn_setting_set 都
     通过 approvalFor() 转交，这两处转交由断言钉住 —— 漏掉任何一处，那一处就是
     规则管不到的入口。

     这六项不在设置中心的通用表格里出现（那里把 bool 画成文本框，改不了），
     它们有自己的「审批策略」块，见 web/page.js。 */
  'approval.batchCollect': {
    default: false,
    kind: 'bool',
    note: '批量采集前是否额外确认。目标越多，一次误操作撞上风控的面越大。',
    effect: '立即生效',
  },
  'approval.overwriteField': {
    default: false,
    kind: 'bool',
    note: '覆盖已存字段前是否额外确认。覆盖会留下前后值，但不会把旧值还回来。',
    effect: '立即生效',
  },
  'approval.activateVersion': {
    default: false,
    kind: 'bool',
    note: '激活规则集 / 产品线版本前是否额外确认。进行中的运行用配置快照，不受影响。',
    effect: '立即生效',
  },
  'approval.archive': {
    default: false,
    kind: 'bool',
    note: '归档对象前是否额外确认。归档是隐藏不是删除，按 id 仍然解析得出来。',
    effect: '立即生效',
  },
  'approval.acceptDraft': {
    default: false,
    kind: 'bool',
    note: '采纳优化草案前是否额外确认。采纳只写进报告，真正改 listing 还要 applyListing。',
    effect: '立即生效',
  },
  'approval.markPublished': {
    default: false,
    kind: 'bool',
    /* 这里**不再重述那条理由**：它原来写的是「真正的『标记发布』这个动作和它的观测期都还
       没做」，而模块 14 交付后那句话不成立了。理由只留一份，在审批策略的声明里
       （domain/approval/policy.js 的 CONFIGURABLE_APPROVALS → markPublished.note），
       这一行只说明它是开关并指回那一处 —— 两处各写一遍，就会有一处先过期。 */
    note: '标记发布前是否额外确认（默认关）。这项的保护范围与「为什么需要它」由审批策略声明，'
      + '见 domain/approval/policy.js 的 CONFIGURABLE_APPROVALS；动作是 amzn_publication_record。',
    effect: '立即生效',
  },
  /* 收藏与最近访问（S1-B20）。存成 JSON 文本，因为「点过哪些对象、按什么顺序」
     是一张有顺序的小表，而 B20 按计划不引入迁移 —— `setting` 表本来就能放字符串。
     值是**界面状态**，不是业务数据，所以它和 `context` 同类，只是需要跨重启保留。
     读的时候对坏 JSON 容错：这两行可以被手改，而一个坏字符不该让首页整块画不出来。 */
  'ui.favorites': {
    default: '[]',
    kind: 'string',
    note: '收藏的对象（JSON 数组，元素 {module,id,label}）。由页面上的收藏按钮维护。',
    effect: '下次刷新页面生效',
  },
  'ui.recent': {
    default: '[]',
    kind: 'string',
    note: '最近访问的对象（JSON 数组，最新在前，上限 20，按对象去重）。由页面跳转时记录。',
    effect: '下次刷新页面生效',
  },
}

/** Keys the plugin reads but does not let the page invent: the per-site shape. */
const MARKETPLACE_KEY = /^marketplace\.([A-Z]{2})\.postalCode$/

/**
 * Which declared settings exist, for a caller that needs to ask without reading.
 *
 * Returns a fresh object each call so a caller cannot mutate the declaration.
 */
export function declaredSettings() {
  return Object.fromEntries(
    Object.entries(DECLARED).map(([key, spec]) => [key, { ...spec }]),
  )
}

/**
 * Validate and write one setting.
 *
 * Throws by name on anything undeclared or out of range. The message always
 * names the key *and* the bound, because the counterpart of a silent write is a
 * refusal the user cannot act on.
 */
export function setSetting(store, key, value) {
  const spec = DECLARED[key]
  if (spec === undefined && !MARKETPLACE_KEY.test(key)) {
    throw new Error(`unknown setting: ${key}`)
  }

  let stored
  if (spec === undefined) {
    /* A per-site postal code. Only the shape is checked here — whether the site
       exists is a different question, and a key for a site the collection layer
       does not know is still a key somebody may want to set. */
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${key} must be a non-empty string (got ${JSON.stringify(value)})`)
    }
    stored = value.trim()
  } else if (spec.kind === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`${key} must be an integer (got ${JSON.stringify(value)})`)
    }
    if (value < spec.min) throw new Error(`${key} must be >= ${spec.min} (got ${value})`)
    stored = value
  } else if (spec.kind === 'bool') {
    if (typeof value !== 'boolean') {
      throw new Error(`${key} must be true or false (got ${JSON.stringify(value)})`)
    }
    stored = value
  } else {
    if (value !== null && typeof value !== 'string') {
      throw new Error(`${key} must be a string or null (got ${JSON.stringify(value)})`)
    }
    stored = value
  }

  store.run(
    `INSERT INTO setting (key, value_json, updated_at, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                    updated_at = excluded.updated_at`,
    [key, JSON.stringify(stored), new Date().toISOString(), null],
  )
  return stored
}

/**
 * One setting's stored value, or the declared default when it was never set.
 *
 * Returns the default rather than `undefined` so that reading a setting is never
 * a question about whether it exists: a fresh install has to work, and "unset"
 * and "set to the default" behaving differently would make every reader carry a
 * fallback.
 */
export function getSetting(store, key) {
  const row = store.get('SELECT value_json FROM setting WHERE key = ?', [key])
  if (row === undefined) {
    if (key in DECLARED) return DECLARED[key].default
    if (MARKETPLACE_KEY.test(key)) return null
    throw new Error(`unknown setting: ${key}`)
  }
  try {
    return JSON.parse(row.value_json)
  } catch {
    /* A hand-edited store can hold a bare string. Showing it beats throwing
       while rendering a settings page. */
    return row.value_json
  }
}

/** Remove a setting, so the next read is the declared default again. */
export function deleteSetting(store, key) {
  store.run('DELETE FROM setting WHERE key = ?', [key])
}

/**
 * Every declared setting, plus every per-site override that exists.
 *
 * `stored` is reported separately from `value` on purpose: the page says 默认
 * versus 已设置, and inferring that from "the value equals the default" would
 * call a deliberate 45 look untouched.
 *
 * `kind` and `min` ride along for a related reason: **the page must not keep its
 * own table of which key is which type.** It had one, and it drew every boolean
 * as a text box — so `browser.headless` sent the string "false", the store
 * refused it, and a published setting became unreachable from the only page that
 * exists to edit it. One declaration; the control follows from it.
 */
export function listSettings(store) {
  const stored = new Map(
    store.all('SELECT key, value_json, updated_at, note FROM setting')
      .map(row => [row.key, row]),
  )

  const rows = []
  for (const [key, spec] of Object.entries(DECLARED)) {
    const row = stored.get(key)
    rows.push({
      key,
      value: row ? safeParse(row.value_json) : spec.default,
      stored: row !== undefined,
      updatedAt: row?.updated_at ?? null,
      note: row?.note ?? spec.note,
      declared: true,
      kind: spec.kind,
      min: spec.min ?? null,
      /* 什么时候生效。它在这里是**声明的一部分**（B07 ② 的文字来源），但直到 B-04c-2
         之前没有一个读者 —— 页面的采集面板要如实说「改了限速什么时候算数」，与其在
         模板字符串里再写第五份这句话，不如让声明本身到达页面。`declaredSettings()` 一直
         带着它，这里只是把它从声明搬到行上。 */
      effect: spec.effect ?? null,
    })
  }
  for (const [key, row] of stored) {
    if (key in DECLARED) continue
    rows.push({
      key,
      value: safeParse(row.value_json),
      stored: true,
      updatedAt: row.updated_at,
      note: row.note,
      /* Every key that is not declared is a per-site postal code, and those are
         non-empty strings — the same rule `setSetting` applies to them. */
      kind: 'string',
      min: null,
      declared: MARKETPLACE_KEY.test(key),
    })
  }
  return rows
}

/**
 * The declared settings whose key starts with `prefix`, in `listSettings`' shape.
 *
 * Exists for the collect panel's rate-limit controls (B-04c-2, contract §6.3
 * revision 2026-10-09). Those controls live on the **collect** module, but the
 * settings surface is a lazy slice computed only for the settings module — so the
 * block had no rows to draw and rendered "读不到设置行" forever. The fix is to carry
 * the few rows it needs on its own payload, and this is the function that picks
 * them: by **prefix**, never by a hard-written list of key names. A list of three
 * keys here would be a second declaration of "which rate limits exist", and the
 * symptom of the two drifting is the one this repo keeps hitting — 设置页能改、
 * 采集页看不见，两边都不报错.
 */
export function settingsRowsFor(store, prefix) {
  const wanted = String(prefix)
  return listSettings(store).filter(row => String(row.key ?? '').startsWith(wanted))
}

/**
 * The pacing values the collector will obey.
 *
 * A plain object with **every key always present**, because `resolvePacing`
 * whitelists rather than merges — an absent key there is a silently dropped
 * value, which is exactly how `dailyLimit` came to be dropped and the daily cap
 * came to never fire at all (see `src/sources/pacing.js`). Always-populated is
 * the shape that makes that bug unrepresentable.
 */
export function pacingSettings(store) {
  return {
    taskIntervalSec: getSetting(store, 'pacing.taskIntervalSec'),
    maxAsinsPerTask: getSetting(store, 'pacing.maxAsinsPerTask'),
    dailyLimit: getSetting(store, 'pacing.dailyLimit'),
  }
}

/**
 * The postal code for a site — **the setting wins, the built-in fact is the
 * fallback.**
 *
 * That order is the opposite of what one might expect and it is deliberate. A
 * verified code in `marketplaces.js` is right for the *market*; an override is
 * right for *this machine*, because it is the address the collector actually
 * browses from. `AE` is the case that makes it concrete: the UAE has no postal
 * system, so `marketplaces.js` stores `null` and without an override the
 * collector cannot set a location at all.
 *
 * Returns a bare value, or `null` when there is nothing to use — including for a
 * site with no postal concept, which must stay `null` rather than becoming `''`
 * and being typed into the location box as an empty string.
 */
export function postalCodeFor(store, marketplace) {
  const code = String(marketplace ?? '').toUpperCase()
  const override = store.get('SELECT value_json FROM setting WHERE key = ?', [`marketplace.${code}.postalCode`])
  if (override !== undefined) {
    const value = safeParse(override.value_json)
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return MARKETPLACES[code]?.postalCode ?? null
}

/* ═══════════════════════════ redaction ═══════════════════════════ */

/**
 * Keys whose values are credentials. Matched case-insensitively and as a
 * **substring**, not an exact spelling: `apiKey`, `api_key`, `openApiKey` and
 * `secretKey` are all the same mistake, and a whitelist of exact names is the
 * version that leaks the one spelling nobody thought of.
 *
 * Exported because the audit log is the second place that has to decide what a
 * credential is (`src/domain/audit/redact.js`). Two regexes would eventually
 * disagree, and the one that disagrees by being narrower is the one that
 * publishes a token.
 */
export const SECRET_KEY = /(key|token|secret|password|passwd|credential|auth|cookie|session)/i

/**
 * A source row, safe to show.
 *
 * Two decisions worth spelling out:
 *
 * 1. **The reply names fields, never values.** `configKeys` is the field list;
 *    the redacted `config_json` carries `'••••••'` for anything secret-shaped.
 *    Both exist because they answer different questions — "is this source
 *    configured, and with which fields" versus "what is in it".
 *
 * 2. **Nothing that reveals the length.** A redaction that returned a
 *    fixed-width mask of the real length would leak enough to confirm a guess.
 *    The mask is constant.
 */
export function redactSource(source) {
  const parsed = safeParse(source?.config_json)
  const config = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null

  const redacted = config === null ? null : Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, SECRET_KEY.test(key) ? REDACTED : value]),
  )

  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    enabled: source.enabled === 1 || source.enabled === true,
    notes: source.notes ?? null,
    lastHealth: source.last_health ?? null,
    checkedAt: source.checked_at ?? null,
    config: redacted,
    /* The field names, and whether any of them is a credential. This is what
       lets the page say "已配置 / 未配置" without ever reading a value. */
    configKeys: config === null ? [] : Object.keys(config),
    configured: config !== null && Object.keys(config).length > 0,
    hasSecret: config !== null && Object.keys(config).some(key => SECRET_KEY.test(key)),
  }
}

/** What a redacted field is replaced with. Constant, so it leaks no length. */
export const REDACTED = '••••••'

/**
 * Every source, redacted.
 *
 * Reads the table directly rather than through the source registry: the
 * registry's `list()` performs health checks, which are network calls, and the
 * settings page has to render whether or not the network is up.
 */
export async function listSourcesRedacted(store) {
  return store.all('SELECT * FROM source ORDER BY kind, id').map(redactSource)
}

/* ═══════════════════════════ internals ═══════════════════════════ */

function safeParse(json) {
  if (json === null || json === undefined) return null
  if (typeof json === 'object') return json
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

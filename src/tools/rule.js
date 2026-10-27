/**
 * Rule tools — read the roster, edit it, and reconcile it against the manual.
 *
 * The roster is data (`rule_set` / `rule`), the judgement is code (`CHECKS`,
 * indexed by `rule_id`), and the manual is a document. `amzn_rule_list` reports
 * three *different* gaps, and they are deliberately not merged:
 *
 *   - `rulesWithoutDoc` (21) — a `kind='code'` rule whose `source` cites no
 *     section of the manual. It has a judgement but no published origin.
 *   - `docsWithoutCheck` (18) — a manual section no `kind='code'` rule answers
 *     to. Prose that cannot be judged, and the reason an import is not readiness.
 *   - the impl gap — a roster `code` rule with no `CHECKS` function. That is
 *     *data and code diverged*, reported by `validate` as the `rule-check-missing`
 *     problem code and blocked. A different axis from the two above, which are
 *     about the manual.
 *
 * Editing is deliberately `upsert`, not `update`: `rule` rows are immutable and
 * an edit publishes a *new version*. That keeps the `optimization_run` →
 * `rule_set` → `rule` chain resolvable, so a report from March still names the
 * rules it was judged against even after the set has changed ten times.
 */

import { missingChecks } from '../domain/rules/registry.js'
import { DEFAULT_MANUAL_PATH, documentationGaps, readManual } from '../domain/rules/parse.js'
import {
  activateVersion, diffVersions, importDocRules, listVersions, loadActiveRoster, loadRosterVersion, upsertRule,
} from '../store/rules.js'
import { activationImpact } from '../domain/rules/activation-impact.js'
import { table, text, truncate } from './render.js'
/* S1-B17.1: the 激活版本 gate. */
import { approvalRefusal } from '../domain/approval/policy.js'

/**
 * The manual's doc rows, or `null` when it cannot be read.
 *
 * Non-fatal on purpose: the gap lists are a *report*, and a missing manual file
 * should degrade to "cannot say" rather than take the whole tool down. The two
 * numbers (21 rules the manual does not carry, 18 sections no rule answers to)
 * come from here.
 */
function manualDocs() {
  try {
    return readManual().docs
  } catch {
    return null
  }
}

/** The roster to describe: a named version, or the active one. */
function rosterFor(store, requested) {
  const wanted = String(requested ?? '').trim()
  if (wanted !== '') return loadRosterVersion(store, wanted)
  return loadActiveRoster(store)
}

/** `code 72 / lexicon 0 / threshold 0 / doc 0`, plus the severity split. */
function kindStats(rules) {
  const byKind = { code: 0, lexicon: 0, threshold: 0, doc: 0 }
  const bySeverity = { block: 0, warn: 0 }
  for (const rule of rules) {
    const kind = rule.kind ?? 'code'
    byKind[kind] = (byKind[kind] ?? 0) + 1
    bySeverity[rule.severity] = (bySeverity[rule.severity] ?? 0) + 1
  }
  return { total: rules.length, byKind, bySeverity }
}

export function ruleListTool({ store }) {
  return {
    name: 'amzn_rule_list',
    description:
      'List the listing rule set: the published versions, the rules of one version (active by default), '
      + 'and the two gaps against the published manual. rulesWithoutDoc are kind=code rules whose source cites '
      + 'no section of the manual (they have a judgement but no published origin); docsWithoutCheck are manual '
      + 'sections no code rule answers to (prose, not a check). Read-only.',
    parameters: {
      type: 'object',
      properties: {
        version: { type: 'string', description: '规则版本，例如 "2026.4"。默认当前生效版本。' },
        enabledOnly: { type: 'boolean', description: '只列启用的规则。默认 true；传 false 连停用的一起列。' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const versions = listVersions(store)
      const active = versions.find(version => version.is_active === 1) ?? null
      const requested = String(args?.version ?? '').trim()
      const roster = rosterFor(store, requested)
      if (roster === null) {
        return `没有版本 ${requested}。现有版本：${versions.map(version => version.version).join(', ') || '（无）'}`
      }
      const enabledOnly = args?.enabledOnly !== false
      const rows = roster.rules.filter(rule => !enabledOnly || rule.enabled !== false)
      const stats = kindStats(roster.rules)
      /* The two gaps are measured against the manual, not against the code: a
         code rule with no implementation is a different hole, and `validate`
         already fails closed on it. These two say how the roster and the manual
         line up. */
      const docs = manualDocs()
      const gaps = docs === null
        ? { rulesWithoutDoc: [], docsWithoutCheck: [] }
        : documentationGaps(roster.rules, docs)
      const implMissing = missingChecks(roster.rules)

      const lines = []
      lines.push(`版本列表 (${versions.length}):`)
      lines.push(table(versions, [
        { label: '版本', value: row => row.version },
        { label: '生效', value: row => (row.is_active === 1 ? '●' : '') },
        { label: '规则', value: row => row.rule_count },
        { label: '启用', value: row => row.enabled_count },
        { label: '发布', value: row => truncate(row.published_at, 19) },
        { label: '说明', value: row => truncate(row.note, 40) },
      ]))
      lines.push('')
      const tag = roster.fromCode ? '（来自代码种子 —— 库里还没有 roster）' : (active !== null && roster.version === active.version ? '（生效中）' : '')
      lines.push(`版本 ${roster.version} ${tag}`)
      lines.push(`统计: 共 ${stats.total} 条 · 阻断 ${stats.bySeverity.block} · 警告 ${stats.bySeverity.warn}`
        + ` · code ${stats.byKind.code} · lexicon ${stats.byKind.lexicon}`
        + ` · threshold ${stats.byKind.threshold} · doc ${stats.byKind.doc}`)
      lines.push(table(rows, [
        { label: '启用', value: rule => (rule.enabled === false ? '停' : '是') },
        { label: 'rule_id', value: rule => rule.id },
        { label: '适用', value: rule => (rule.appliesTo ?? []).join(',') },
        { label: '严重度', value: rule => rule.severity },
        { label: 'kind', value: rule => rule.kind ?? 'code' },
        { label: '标题', value: rule => truncate(rule.title, 34) },
        { label: '出处', value: rule => truncate(rule.source, 20) },
      ]))
      lines.push('')
      if (docs === null) {
        lines.push(`（读不到手册 ${DEFAULT_MANUAL_PATH}，两个缺口无法计算）`)
      } else {
        /* 2026-10-25 真实数据实测（R-6）：这一段原来直接印「有判定无文档 rulesWithoutDoc」，
           而上表里同一条规则的「出处」列写着「SOP §3.3」—— **读者会以为系统自相矛盾**。
           两个说法其实口径不同：上表的「出处」是自由文本，这里的缺口判的是
           「source 有没有指向**已导入手册的章节**（doc.*）」。现在把这层说清楚，
           并给出一个能自证的例子，免得下一个人重新怀疑一次。 */
        const firstMissing = gaps.rulesWithoutDoc[0]
        lines.push(`有判定无文档 rulesWithoutDoc (${gaps.rulesWithoutDoc.length}): ${gaps.rulesWithoutDoc.length > 0 ? gaps.rulesWithoutDoc.join(', ') : '无'}`)
        lines.push(`有文档无判定 docsWithoutCheck (${gaps.docsWithoutCheck.length}): ${gaps.docsWithoutCheck.length > 0 ? gaps.docsWithoutCheck.join(', ') : '无'}`)
        lines.push('')
        lines.push('**这两个缺口判的是「有没有指向已导入手册的章节」，不是「有没有写出处」** ——'
          + '上表的「出处」列是自由文本（如 `SOP §3.3`），而这里只认 `doc.*` 章节。'
          + `所以一条规则可以既写着出处、又落在这个清单里${firstMissing === undefined ? '' : `（例如 ${firstMissing}）`}。`)
        lines.push('要真正补上：先用 `amzn_rule_import` 导入手册、再用 `amzn_rule_upsert` 把规则的 source 指到对应 `doc.*` 章节。')
      }
      /* The third hole, kept visible but distinct: a code rule whose judgement
         function is gone. It is not a manual gap, and `validate` blocks on it. */
      if (implMissing.length > 0) {
        lines.push(`⚠️ 有规则无判定（CHECKS 里没有实现）(${implMissing.length}): ${implMissing.join(', ')} —— validate 会报 rule-check-missing 并阻断。`)
      }
      return lines.join('\n')
    },
  }
}

export function ruleUpsertTool({ store }) {
  return {
    name: 'amzn_rule_upsert',
    description:
      'Create or edit one listing rule by publishing a NEW version (rule rows are immutable, so old reports keep '
      + 'the rules they were judged against). Use kind=lexicon with params.words for a banned-word rule, or '
      + 'kind=threshold with params.{min,max,unit} for a length rule — neither needs code. severity is block or warn. '
      + 'This writes to the database: confirm the rule with the user before calling it.',
    parameters: {
      type: 'object',
      properties: {
        rule_id: { type: 'string', description: '规则 id，例如 "custom.ban-my-words" 或 "title.length.max"。' },
        kind: { type: 'string', enum: ['code', 'lexicon', 'threshold', 'doc'], description: '判定来源。默认 doc（只有正文，无判定）。' },
        params: {
          type: 'object',
          description: 'kind=lexicon 用 {words:[...]}；kind=threshold 用 {min,max,unit}（unit 为 chars 或 bytes）。',
        },
        severity: { type: 'string', enum: ['block', 'warn'], description: 'block = Amazon 会拒收/降权；warn = 合法但偏弱。默认 warn。' },
        enabled: { type: 'boolean', description: '是否启用。默认 true。' },
        title: { type: 'string', description: '规则标题（人读的一行）。' },
        source: { type: 'string', description: '出处，例如 "SOP §3.3"。' },
        appliesTo: { type: 'array', items: { type: 'string' }, description: '适用字段，例如 ["title"]。' },
        scope: { type: 'string', enum: ['field', 'set'], description: 'field = 逐字段；set = 整篇（如五点数量）。' },
        body_md: { type: 'string', description: '规则正文（Markdown）。' },
        version: { type: 'string', description: '以哪个版本为基础编辑。默认当前生效版本；给一个不存在的版本会报错，不会静默改用别的。' },
        confirm: {
          type: 'boolean',
          description: '新版本会立刻生效（输出里印「已生效」）。当本工作空间开着「激活版本」二次确认时，'
            + '不带这一项会被拒绝（APPROVAL_REQUIRED），与 amzn_rule_activate 同一个门。',
        },
      },
      required: ['rule_id'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const ruleId = String(args?.rule_id ?? '').trim()
      if (ruleId === '') return 'rule_id 是必填项。'
      /* 2026-10-25（R-82）：「激活」在本仓是一个**有门**的动作 —— `amzn_rule_activate` 会问
         `approval.activateVersion`。而这个 upsert 会顺手把新版本激活（输出里印「已生效」）。
         于是同一个动作有两条路：一条过门，一条不过 —— 而默认走的是不过的那条。
         （实测：本工作空间这一项现在是关的（默认 false），所以行为不变；
           一旦谁把它打开，这条路径也不该能绕过去。） */
      const activationRefusal = approvalRefusal(store, 'activateVersion', args?.confirm,
        `新增或修改规则会出新版本并立刻生效：${ruleId}。确认无误就再调一次并带 confirm: true；`
        + '也可以把它当成两步走（先出新版本，再用 amzn_rule_activate 激活）。')
      if (activationRefusal !== null) return activationRefusal
      try {
        const result = upsertRule(store, {
          ruleId,
          kind: args?.kind,
          params: args?.params,
          severity: args?.severity,
          enabled: args?.enabled,
          title: args?.title,
          source: args?.source,
          appliesTo: args?.appliesTo,
          scope: args?.scope,
          body_md: args?.body_md,
          baseVersion: args?.version,
        })
        const roster = loadRosterVersion(store, result.version)
        const missing = missingChecks(roster.rules)
        return [
          `${result.created ? '新增' : '编辑'}规则 ${ruleId} → 新版本 ${result.version}（已生效）`,
          `版本内共 ${roster.count} 条，启用 ${roster.rules.filter(rule => rule.enabled !== false).length} 条。`,
          missing.length > 0
            ? `⚠️ 版本内仍有有规则无判定的条目: ${missing.join(', ')}`
            : '版本内所有 code 规则都有判定。',
        ].join('\n')
      } catch (error) {
        return `写入失败: ${error.message}`
      }
    },
  }
}

export function ruleActivateTool({ store }) {
  return {
    name: 'amzn_rule_activate',
    description:
      'Make one published rule version the active one. This is not reversible in the sense of undoing history — '
      + 'old optimization runs keep their own rules_json snapshot — but it does change which rules new runs are '
      + 'judged against, so confirm the version with the user first.',
    parameters: {
      type: 'object',
      properties: {
        version: { type: 'string', description: '要设为生效的规则版本，例如 "2026.4.1"。' },
        confirm: {
          type: 'boolean',
          description:
            'Set true when this workspace has turned on the 激活版本 二次确认. Without it the switch is refused with '
            + 'code APPROVAL_REQUIRED and the active version is unchanged. Nothing else about the call changes.',
        },
      },
      required: ['version'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const version = String(args?.version ?? '').trim()
      if (version === '') return 'version 是必填项。'
      /* 激活版本闸门。这个动作本身没有边界条件 —— 切版本就是切版本，
         所以这里不带任何「只在某种情况下才算」的判断。 */
      const refusal = approvalRefusal(store, 'activateVersion', args?.confirm,
        `要生效的版本：${version}。确认无误就再调一次并带 confirm: true。`)
      if (refusal !== null) return refusal
      try {
        const before = listVersions(store).find(row => row.is_active === 1)?.version ?? null
        /* P3-2：激活前先算影响面。这个动作和归档/删除不同 —— 它**不动任何既有行**，
           换的是"以后拿哪一份规则去判"，所以影响面要答的是"判哪些、判多重会变"，
           不是"会影响 N 条数据"。算不出来的是"有多少既有判定会过时"（没有存
           rule_version），那一项如实返回 null + 原因，不报 0。 */
        const currentRoster = before === null ? null : loadRosterVersion(store, before)
        /* 版本不存在时**不能**在这里换个措辞就返回 —— 既有断言与调用方认的是
           「切换失败」那条路径（`activateVersion` 自己会抛）。所以这里只是读出来给
           影响面用，存在性仍由 `activateVersion` 裁决，措辞也就只有一处。 */
        const nextRoster = loadRosterVersion(store, version)
        const impact = nextRoster === null ? null : activationImpact(
          currentRoster?.rules ?? [],
          nextRoster.rules ?? [],
          { currentVersion: before, nextVersion: version },
        )
        activateVersion(store, version)
        const lines = [`规则版本已切换到 ${version}（原生效版本 ${before ?? '无'}）。`]
        if (impact !== null) {
          lines.push(`影响面：${impact.conclusion}`)
          lines.push(`停止生效的判定：${impact.staleJudgementsReason}`)
        }
        lines.push('老 run 的 rules_json 是拷贝，不受影响 —— 它们的解释链仍然指向各自的版本。')
        return lines.join('\n')
      } catch (error) {
        return `切换失败: ${error.message}`
      }
    },
  }
}

export function ruleDiffTool({ store }) {
  return {
    name: 'amzn_rule_diff',
    description:
      'Compare two published rule versions: which rules were added, removed, and which changed (and in which '
      + 'fields). Read-only; use it to explain what an edit or an import actually did.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '基准版本，例如 "2026.4"。' },
        to: { type: 'string', description: '目标版本，例如 "2026.4.1"。' },
      },
      required: ['from', 'to'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const from = String(args?.from ?? '').trim()
      const to = String(args?.to ?? '').trim()
      if (from === '' || to === '') return 'from 和 to 都是必填项。'
      const known = new Set(listVersions(store).map(version => version.version))
      if (!known.has(from) || !known.has(to)) {
        return `版本不存在。现有版本：${[...known].join(', ') || '（无）'}`
      }
      const diff = diffVersions(store, from, to)
      const lines = [`规则版本对比 ${from} → ${to}`]
      lines.push(`新增 ${diff.added.length}: ${diff.added.length > 0 ? diff.added.join(', ') : '无'}`)
      lines.push(`移除 ${diff.removed.length}: ${diff.removed.length > 0 ? diff.removed.join(', ') : '无'}`)
      lines.push(`变更 ${diff.changed.length}:`)
      if (diff.changed.length > 0) {
        lines.push(table(diff.changed, [
          { label: 'rule_id', value: row => row.ruleId },
          { label: '改了哪些字段', value: row => row.fields.join(', ') },
        ]))
      }
      return lines.join('\n')
    },
  }
}

/**
 * Import the manual into the roster as `doc` rows.
 *
 * The one tool that can turn a document into rows, and the one with the sharpest
 * edge: it must be *provably* unable to touch a judgement. It writes only ids
 * that start `doc.`, and the store copies the `kind='code'` rows through
 * untouched — so "导入手册" can add prose and citations, and cannot change a check.
 *
 * `dryRun` defaults to true because an import is a publish, and the first thing
 * anyone wants from it is the diff, not the write.
 */
export function ruleImportTool({ store }) {
  return {
    name: 'amzn_rule_import',
    description:
      'Import the published rule manual into the roster as kind=doc rows (one row per section, id doc.<anchor>). '
      + 'It never touches the kind=code rows: an import can add prose and cite it, it cannot change a judgement. '
      + 'dryRun defaults to true and reports the added / changed / removed sections and the two gaps without '
      + 'writing. Set dryRun=false to publish a new version. Confirm with the user before writing.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '手册路径。默认写死为 04-agents 那份；给别的路径会在输出里明确警告。' },
        baseVersion: { type: 'string', description: 'base version —— 以哪个已发布版本为基础导入。新版本号自动派生（2026.4 → 2026.4.1），不接受调用者指定。默认当前生效版本。' },
        dryRun: { type: 'boolean', description: '只预览不落库。默认 true。' },
        source: { type: 'string', description: '出处说明，写进新版本的 note。' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const dryRun = args?.dryRun !== false
      const requestedPath = String(args?.path ?? '').trim()
      const path = requestedPath === '' ? DEFAULT_MANUAL_PATH : requestedPath
      const pathWarning = path === DEFAULT_MANUAL_PATH
        ? ''
        : `⚠️ 你给的不是默认手册路径。默认是 ${DEFAULT_MANUAL_PATH}（04-agents 那份）；`
          + '01-system 下的同名文件曾被一次全局替换事故破坏（Rufus→Alexa），导错会把病句当规则正文写进库。'

      let parsed
      try {
        parsed = readManual(path)
      } catch (error) {
        return `导入失败：${error.message}\n（没有写库，roster 未变。）`
      }

      const requestedVersion = String(args?.baseVersion ?? '').trim()
      const baseRoster = requestedVersion === ''
        ? loadActiveRoster(store)
        : loadRosterVersion(store, requestedVersion)
      if (baseRoster === null) {
        return `没有版本 ${requestedVersion}。现有版本：${listVersions(store).map(row => row.version).join(', ') || '（无）'}`
      }

      const currentDocs = baseRoster.rules.filter(rule => String(rule.kind) === 'doc')
      const byId = new Map(currentDocs.map(doc => [doc.id, doc]))
      const added = parsed.docs.filter(doc => !byId.has(doc.id))
      const changed = parsed.docs.filter(doc => {
        const old = byId.get(doc.id)
        return old !== undefined && (old.body_md !== doc.body_md || old.title !== doc.title || old.source !== doc.source)
      })
      const removed = currentDocs.filter(doc => !parsed.docs.some(next => next.id === doc.id))
      const gaps = documentationGaps(baseRoster.rules, parsed.docs)

      const lines = []
      lines.push(`手册: ${path}`)
      if (pathWarning !== '') lines.push(pathWarning)
      lines.push(`解析出 ${parsed.docs.length} 节（可导入小节），基准版本 ${baseRoster.version}${baseRoster.fromCode ? '（来自代码种子）' : ''}。`)
      lines.push(`预览: 新增 ${added.length} 节 / 变更 ${changed.length} 节 / 移除 ${removed.length} 节`)
      if (added.length > 0) lines.push(`新增: ${added.map(doc => doc.id).join(', ')}`)
      if (changed.length > 0) lines.push(`变更: ${changed.map(doc => doc.id).join(', ')}`)
      if (removed.length > 0) lines.push(`移除: ${removed.map(doc => doc.id).join(', ')}`)
      lines.push(`有判定无文档 rulesWithoutDoc (${gaps.rulesWithoutDoc.length}): ${gaps.rulesWithoutDoc.length > 0 ? gaps.rulesWithoutDoc.join(', ') : '无'}`)
      lines.push(`有文档无判定 docsWithoutCheck (${gaps.docsWithoutCheck.length}): ${gaps.docsWithoutCheck.length > 0 ? gaps.docsWithoutCheck.join(', ') : '无'}`)

      if (dryRun) {
        lines.push('（dryRun，没有写库。确认后用 dryRun=false 落库。）')
        return lines.join('\n')
      }

      try {
        const result = importDocRules(store, {
          baseVersion: requestedVersion === '' ? undefined : requestedVersion,
          docs: parsed.docs,
          note: String(args?.source ?? '').trim() || `导入手册（${parsed.docs.length} 节）`,
        })
        const after = loadRosterVersion(store, result.version)
        const codeCount = after.rules.filter(rule => String(rule.kind) === 'code').length
        lines.push(`已导入 → 新版本 ${result.version}（已生效），doc 行 ${result.count} 节，code 行 ${codeCount} 条原样带过去、未改动。`)
        return lines.join('\n')
      } catch (error) {
        return `写入失败：${error.message}\n（roster 未变。）`
      }
    },
  }
}

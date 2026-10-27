/**
 * Policy tools — read the library, import one policy, and link it to rules.
 *
 * A policy is the *input* of the rule pipeline and a rule is the product, so these
 * three tools sit one step upstream of the rule tools. The import is the one that
 * carries the risk: a policy that is only half-read must say so, and a policy that
 * cannot be read at all must write nothing — a silently empty policy row is the
 * exact failure this module was built to avoid.
 *
 * The page's policy tab and `amzn_policy_link` both go through the same
 * `linkPolicyToRules` in the store, so the two paths cannot drift into disagreeing
 * about what "linked" means.
 */

import { readFileSync } from 'node:fs'

import { labelFields, parsePolicy, PolicyParseError } from '../domain/policy/parse.js'
import {
  getPolicy, importPolicy, linkPolicyToRules, listPolicies, listPolicySources, policyStats,
} from '../store/policy.js'
import { table, text, truncate } from './render.js'

/** `高` / `中` / `低`, or 「未判定」 when the policy never said. */
function severityLabel(hint) {
  if (hint === 'high') return '高'
  if (hint === 'medium') return '中'
  if (hint === 'low') return '低'
  return '未判定'
}

/**
 * The level, and the words it was read from.
 *
 * The level alone reads as Amazon's own classification, which it is not — it is our
 * reading of a phrase in the announcement. Showing the phrase next to it is what
 * keeps the value a hint rather than a judgement.
 */
function severityText(hint, raw) {
  const label = severityLabel(hint)
  if (label === '未判定') return label
  const phrase = raw === null || raw === undefined ? '' : String(raw).trim()
  return phrase === '' ? label : `${label}（原文：「${phrase}」）`
}

/** The status of a policy in Chinese, for the tool output. */
function statusLabel(status) {
  if (status === 'active') return '生效中'
  if (status === 'superseded') return '已被取代'
  if (status === 'expired') return '已过期'
  return String(status ?? '')
}

/**
 * 「取代了谁 / 被谁取代」 for one row.
 *
 * Both directions, because the stored link only points one way: `superseded_by`
 * says who replaced this policy, while who *this* policy replaced is only
 * derivable. A chain a reader can walk one way only is half a chain, so the list
 * carries the reverse map too and prints both here.
 */
function supersedeText(row) {
  const parts = []
  if (row.supersededBy !== null && row.supersededBy !== undefined) {
    parts.push(`被 ${truncate(row.supersededBy, 8)} 取代`)
  }
  const replaced = Array.isArray(row.supersedes) ? row.supersedes : []
  if (replaced.length > 0) {
    parts.push(`取代了 ${replaced.map(id => truncate(id, 8)).join('、')}`)
  }
  return parts.length === 0 ? '（无）' : parts.join('；')
}

export function policyListTool({ store }) {
  return {
    name: 'amzn_policy_list',
    description:
      'List the policy library: the recent policies, their source, marketplace, publish and effective dates, '
      + 'the severity hint the policy itself gave (or 未判定 when it gave none), and which rules each one affects. '
      + 'Read-only. `since` filters on effective date — a policy whose effective date could not be read is '
      + 'reported separately rather than quietly dropped.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: '站点，例如 "US"。默认全部。' },
        status: { type: 'string', enum: ['active', 'superseded', 'expired'], description: '状态过滤。默认全部。' },
        since: { type: 'string', description: '只看生效日期 >= 这个日期的政策（YYYY-MM-DD）。' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const listed = listPolicies(store, {
        marketplace: args?.marketplace,
        status: args?.status,
        since: args?.since,
      })
      const stats = policyStats(store)
      const lines = []
      lines.push(`政策库: 共 ${stats.total} 条 · 生效中 ${stats.active} · 已被取代 ${stats.superseded}`
        + ` · 已挂规则 ${stats.linked} 条政策`)
      lines.push(`严重度未判定 ${stats.unjudged} 条（政策没明说，页面显示「未判定」，不编结论）`
        + ` · 生效日期未识别 ${stats.unknownEffective} 条`)
      if (args?.since !== undefined && args?.since !== null && String(args.since).trim() !== '') {
        lines.push(`按生效日期 >= ${String(args.since).trim()} 过滤，命中 ${listed.total} 条（上面三行是全库口径，不随筛选变）`
          + (listed.sinceExcluded > 0 ? `；另有 ${listed.sinceExcluded} 条生效日期未识别，无法判断是否命中，未计入` : ''))
      }
      /* 2026-10-25（R-79）：`since` 会给一句「命中 N 条」，`status` 不给 —— 同一个工具两种对待。
         实测 status=superseded：上面写「共 3 条」，下面只有 1 行，中间没有一个数把两者接上。
         两个数各自都对，但它们并排放着而不说明关系时，读者只能自己猜「是不是漏了」。
         所以 status 也给一句，并明说上面那三行是全库口径（与 `amzn_asin_query` / R-76 的句法一致）。 */
      if (args?.status !== undefined && args?.status !== null && String(args.status).trim() !== '') {
        lines.push(`按状态「${statusLabel(String(args.status).trim())}」过滤，命中 ${listed.total} 条（上面三行是全库口径，不随筛选变）`)
      }
      lines.push('')
      lines.push(table(listed.rows, [
        { label: '状态', value: row => statusLabel(row.status) },
        { label: '生效', value: row => row.effectiveFrom ?? '（未识别）' },
        { label: '发布', value: row => truncate(row.publishedAt ?? '（未识别）', 10) },
        { label: '站点', value: row => row.marketplace ?? '（未识别）' },
        { label: '严重度', value: row => truncate(severityText(row.severityHint, row.severityRaw), 30) },
        { label: '标题', value: row => truncate(row.title, 40) },
        { label: '来源', value: row => truncate(row.sourceName ?? row.sourceId, 16) },
        { label: '取代关系', value: row => truncate(supersedeText(row), 30) },
        { label: '影响规则', value: row => (row.rules.length === 0 ? '（未关联）' : row.rules.length) },
      ]))
      if (listed.rows.length > 0) {
        lines.push('')
        lines.push('来源: ' + listPolicySources(store)
          .map(source => `${source.id}(${source.kind})`).join(', '))
        const linked = listed.rows.filter(row => row.rules.length > 0)
        for (const row of linked) {
          lines.push(`· ${truncate(row.title, 30)} → ${row.rules.join(', ')}`)
        }
        const related = listed.rows.filter(row => row.supersededBy
          || (Array.isArray(row.supersedes) && row.supersedes.length > 0))
        if (related.length > 0) {
          lines.push('取代关系（可顺着走：旧 → 新）:')
          for (const row of related) {
            lines.push(`· ${truncate(row.title, 30)} —— ${supersedeText(row)}`)
          }
        }
      }
      return lines.join('\n')
    },
  }
}

/**
 * Import one policy from pasted text or a file.
 *
 * The parse is all-or-nothing on the essentials and per-field on the rest: a title
 * and a body are required (an empty policy is refused), while a missing marketplace
 * or effective date stays NULL and is *named* in the output. Nothing is written
 * until the parse has produced a usable policy, so a failure leaves the library
 * exactly as it was.
 */
export function policyImportTool({ store }) {
  return {
    name: 'amzn_policy_import',
    description:
      'Import one Amazon policy from pasted text (or a file) into the policy library. The parser reads the title, '
      + 'the marketplace, the effective / expiry / publish dates, a severity hint (and the wording it was read from) '
      + 'and the source link; any field it cannot read is left NULL and named in the output — nothing is guessed. If '
      + 'the text cannot be parsed at all, nothing is written. Pass `supersedes` to record that this policy replaces '
      + 'an older one (an unknown id is refused by name). This writes to the database: confirm with the user before '
      + 'calling it.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '政策原文（人工粘贴）。与 path 二选一。' },
        path: { type: 'string', description: '政策原文文件路径。与 text 二选一。' },
        sourceId: { type: 'string', description: '来源 id，默认 "manual-paste"。可选 "hub-doc" 等。' },
        marketplace: { type: 'string', description: '站点覆盖：解析不出或解析错时手工指定，例如 "US"。' },
        effectiveFrom: { type: 'string', description: '生效日期覆盖（YYYY-MM-DD）。给了就以它为准。' },
        supersedes: { type: 'string', description: '被本条取代的旧政策 id。给了就在同一事务里把旧政策标成「已被取代」并指向本条。' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const rawText = String(args?.text ?? '')
      const path = String(args?.path ?? '').trim()
      let source = rawText
      if (rawText.trim() === '') {
        if (path === '') return '要导入政策，请给 text（原文）或 path（文件路径）。'
        try {
          source = readFileSync(path, 'utf8')
        } catch (error) {
          return `导入失败：读不到文件 ${path}（${error.message}）\n（没有写库，政策库未变。）`
        }
      }

      let parsed
      try {
        parsed = parsePolicy(source)
      } catch (error) {
        if (error instanceof PolicyParseError) {
          return `导入失败：${error.message}\n（没有写库，政策库未变。）`
        }
        throw error
      }

      /* An explicit override beats the parser: the caller is looking at the document
         and can see what the regexes cannot. When they disagree, say so — silently
         preferring one over the other is how a wrong marketplace gets stored. */
      const overrideMarket = String(args?.marketplace ?? '').trim().toUpperCase()
      const overrideEffective = String(args?.effectiveFrom ?? '').trim()
      const marketplace = overrideMarket !== '' ? overrideMarket : parsed.marketplace
      const effectiveFrom = overrideEffective !== '' ? overrideEffective : parsed.effective_from
      const notes = []
      if (overrideMarket !== '' && parsed.marketplace !== null && overrideMarket !== parsed.marketplace) {
        notes.push(`站点：解析出 ${parsed.marketplace}，按你给的 ${overrideMarket} 覆盖。`)
      }
      if (overrideEffective !== '' && parsed.effective_from !== null && overrideEffective !== parsed.effective_from) {
        notes.push(`生效日期：解析出 ${parsed.effective_from}，按你给的 ${overrideEffective} 覆盖。`)
      }

      let stored
      try {
        stored = importPolicy(store, {
          sourceId: args?.sourceId,
          title: parsed.title,
          bodyMd: parsed.body_md,
          marketplace,
          url: parsed.url,
          publishedAt: parsed.published_at,
          effectiveFrom,
          effectiveTo: parsed.effective_to,
          severityHint: parsed.severity_hint,
          severityRaw: parsed.severity_raw,
          supersedes: args?.supersedes,
        })
      } catch (error) {
        return `写入失败：${error.message}\n（政策库未变。）`
      }

      const lines = []
      lines.push(stored.created
        ? `已入库政策 ${stored.id}（来源 ${stored.sourceId}）`
        : `这条政策已经在库里（${stored.id}），未重复写入。`)
      lines.push(`标题: ${stored.title}`)
      lines.push(`站点 ${stored.marketplace ?? '（未识别）'}`
        + ` · 生效 ${stored.effectiveFrom ?? '（未识别）'}`
        + ` · 失效 ${stored.effectiveTo ?? '（未识别）'}`
        + ` · 发布 ${stored.publishedAt ?? '（未识别）'}`)
      lines.push(`严重度提示 ${severityText(stored.severityHint, stored.severityRaw)}`
        + (stored.severityHint === null ? '（政策没明说，不编结论）' : ' —— 高/中/低是我们的读数，原词也入库了。'))
      if (stored.supersedesRelation !== null) {
        const relation = stored.supersedesRelation
        lines.push(relation.already
          ? `取代关系: 旧政策 ${relation.older} 早已被本条取代，未重复改写。`
          : `取代关系: 旧政策 ${relation.older} 已标为「已被取代」，指向本条 ${relation.newer}`
            + '（与入库同一次事务，只成不半）。')
      }
      if (parsed.unrecognized.length > 0) {
        lines.push(`⚠️ 未识别字段: ${labelFields(parsed.unrecognized)} —— 一律留 NULL，没有填默认值。`)
      } else {
        lines.push('所有字段都识别出来了。')
      }
      if (parsed.ambiguous.length > 0) {
        lines.push(`⚠️ 有歧义、未取值的字段: ${labelFields(parsed.ambiguous)} —— 文本里有多个取值，猜一个就是编事实。`)
      }
      for (const note of notes) lines.push(note)
      lines.push('下一步: 用 amzn_policy_link 把它关联到受影响的规则，规则页就会显示「受政策 X 影响」。')
      return lines.join('\n')
    },
  }
}

/**
 * Link a policy to the rules it affects, and record the fields it touches.
 *
 * `ruleIds` replaces the link set (so unlink is the same call with a shorter list);
 * `fields` is only written when passed. Both go through the same store function the
 * page's POST calls.
 */
export function policyLinkTool({ store }) {
  return {
    name: 'amzn_policy_link',
    description:
      'Link a policy to the rules it affects (and optionally record which fields it touches). ruleIds REPLACES the '
      + 'policy\'s current rule links — pass the full set to add one, or a shorter set to unlink. An unknown rule_id '
      + 'is refused by name. This writes to the database: confirm with the user before calling it.',
    parameters: {
      type: 'object',
      properties: {
        policyId: { type: 'string', description: '政策 id（amzn_policy_list 里能看到）。' },
        ruleIds: { type: 'array', items: { type: 'string' }, description: '关联到的规则 id 全集，例如 ["title.length.max"]。' },
        fields: { type: 'array', items: { type: 'string' }, description: '这条政策影响哪些字段，例如 ["title","bullets"]。不给则不动已存的字段清单。' },
        note: { type: 'string', description: '为什么这么挂（可选）。' },
      },
      required: ['policyId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const policyId = String(args?.policyId ?? '').trim()
      if (policyId === '') return 'policyId 是必填项。'
      let result
      try {
        result = linkPolicyToRules(store, {
          policyId,
          ruleIds: Array.isArray(args?.ruleIds) ? args.ruleIds : [],
          fields: args?.fields,
          note: args?.note,
        })
      } catch (error) {
        return `关联失败：${error.message}`
      }
      const policy = getPolicy(store, policyId)
      const lines = []
      lines.push(`政策 ${policyId} 现关联 ${result.ruleIds.length} 条规则`
        + `（新增 ${result.added.length}、解除 ${result.removed.length}）`)
      if (result.added.length > 0) lines.push(`新增: ${result.added.join(', ')}`)
      if (result.removed.length > 0) lines.push(`解除: ${result.removed.join(', ')}`)
      lines.push(`影响字段: ${result.fields.length > 0 ? result.fields.join(', ') : '（未声明）'}`)
      if (policy !== null) lines.push(`标题: ${policy.title}`)
      lines.push('规则页签现在会在这几条规则上显示「受政策 X 影响」。')
      return lines.join('\n')
    },
  }
}

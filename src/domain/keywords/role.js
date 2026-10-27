/**
 * 词角色 —— 这个词**是不是我们的产品**，而不只是"有多热"。
 *
 * ## 为什么必须有这一层
 *
 * 2026-05 Alexa for Shopping 上线后，亚马逊的竞争点从"关键词密度"变成**证据一致性**：
 * 标题、五点、A+、图片、评论都在回答同一个问题「你是谁」。写得越杂，系统越难确定
 * 该把你推荐给谁 —— 行业里叫"主身份稀释"。
 *
 * 实测库里 30,778 个词，按旧的 SOP 判定（只看搜索量 + 分层）够格进标题的有 **219 个**，
 * 其中 **43%（95 个）既不含 bench 也不含 cushion** —— `patio furniture set`（167 万）、
 * `chair covers`（77 万）、`pillow`、`loveseat` 全在里面。把它们写进标题，
 * 就是主动把主身份冲淡。
 *
 * 根因是产品线的 `core` 信号是一袋**散词**（bench / cushion / pad / pillow / seat /
 * outdoor / patio…），命中任意一个就算这条线 —— 于是 `patio furniture set` 因为含
 * `patio` 就被算成"长凳垫"。
 *
 * ## 规则：产品线 id 就是身份短语
 *
 * `bench-cushion` → 必须**同时**含 `bench` 与 `cushion`（允许 pads 等近义）。
 * 这一条可解释、可复查，也不依赖任何人工维护的词表。
 *
 * 四种角色：
 *
 * | role | 含义 | 能不能进标题 |
 * |---|---|---|
 * | `identity` | 身份短语完整命中（bench cushion / outdoor bench cushions） | ✅ 可以 |
 * | `partial`  | 只命中品类的一部分（cushion、pad）—— 属于别的线，不是我们的主身份 | ❌ |
 * | `offline`  | 一个身份词都没命中（patio furniture set、pillow） | ❌ |
 * | `unknown`  | 这条线没有可解析的身份短语（如中文 id），退回不判断 | ❌（不猜） |
 */

import { PRODUCT_LINE_SIGNALS } from './classify.js'

/** 近义/复数：同一个身份词的不同写法。 */
const TOKEN_FORMS = {
  bench: ['bench', 'benches'],
  cushion: ['cushion', 'cushions', 'pad', 'pads'],
  chair: ['chair', 'chairs', 'seat', 'seats'],
  rocker: ['rocker', 'rockers', 'rocking'],
  cover: ['cover', 'covers'],
  pillow: ['pillow', 'pillows'],
  mat: ['mat', 'mats'],
}

/** 每个角色一句话的判定说明，工具与页面共用，避免两处措辞漂移。 */
export const ROLE_MEANING = {
  identity: '身份词完整命中 —— 这个词在说"本产品是什么"',
  partial: '只命中品类的一部分 —— 更像别的产品线（如只含 cushion 不含 bench）',
  offline: '一个身份词都没命中 —— 泛词或别的品类，进标题会稀释主身份',
  unknown: '这条产品线没有可解析的身份短语 —— 不判断，也不放行',
}

/**
 * 把产品线 id 解析成"必须同时出现"的词组。
 * `bench-cushion` → [['bench','benches'], ['cushion','cushions','pad','pads']]
 * 解析不出（单段、中文、无近义表）时返回 null —— 那是 unknown，不是"放行"。
 */
export function identityTokens(productLineId) {
  const id = String(productLineId ?? '').trim().toLowerCase()
  if (id === '' || !id.includes('-')) return null
  const words = id.split('-').filter(Boolean)
  if (words.length < 2) return null
  const groups = words.map(word => TOKEN_FORMS[word] ?? [word])
  return groups.every(group => group.length > 0) ? groups : null
}

/**
 * 给一个词定角色。
 *
 * @param {string} keyword
 * @param {{productLine?: string}} options 产品线 id（决定身份短语）
 * @returns {{role: string, matched: string[], missing: string[], basis: object}}
 */
export function classifyRole(keyword, { productLine = '' } = {}) {
  const text = ` ${String(keyword ?? '').toLowerCase().replace(/\s+/g, ' ')} `
  const groups = identityTokens(productLine)

  if (groups === null) {
    return {
      role: 'unknown',
      matched: [],
      missing: [],
      basis: { productLine, reason: 'no-identity-phrase' },
    }
  }

  const matched = []
  const missing = []
  for (const group of groups) {
    const hit = group.find(form => text.includes(` ${form} `) || text.includes(` ${form}s `))
    if (hit === undefined) missing.push(group[0])
    else matched.push(hit)
  }

  /* 场景/属性词只用于说明「为什么它是 identity 而不是泛词」，
     不参与放行判断 —— 放行只看身份词是否完整。 */
  const signals = PRODUCT_LINE_SIGNALS[productLine] ?? []
  const qualifiers = signals.filter(word => (
    !groups.flat().includes(word) && text.includes(` ${word} `)
  ))

  if (missing.length === 0) {
    return {
      role: 'identity',
      matched,
      missing: [],
      basis: { productLine, matched, qualifiers, rule: 'all-identity-tokens' },
    }
  }

  const anyCategoryWord = matched.length > 0 || groups
    .flat()
    .some(form => text.includes(` ${form} `))

  return {
    role: anyCategoryWord ? 'partial' : 'offline',
    matched,
    missing,
    basis: { productLine, matched, missing, qualifiers, rule: 'identity-tokens-incomplete' },
  }
}

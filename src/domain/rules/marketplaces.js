/**
 * Optimization-side marketplace profiles — the site decides the rule set.
 *
 * This is a different concern from the collection registry in
 * `sources/pages/amazon.js`, which answers "which domain, which locale, which
 * postal code do I drive the browser to". This file answers "which character
 * limits, which units, which buying conventions does the *copy* have to satisfy
 * for that site". They are keyed by the same marketplace codes on purpose, and
 * the factual half (domain, locale, currency) is imported rather than copied —
 * a second hand-maintained list of currency codes is a drift generator.
 *
 * ## Why the profile is per-site rather than a global default
 *
 * The user's instruction was 「需要美国站点就只出美国站点，需要其他站点就只出其他站点的」.
 * That rules out both extremes: a single global rule set (which would judge a
 * Japanese listing against US limits) and a hard-coded US-only path (which would
 * have to be rewritten the first time a DE ASIN shows up). So every site resolves
 * its own limits, and the report prints only the profile that applies.
 *
 * ## `authoritative` vs `provisional` — the honest half
 *
 * The hub's rule manual states its own scope: 「适用: 北美站（美国/加拿大）」. So US
 * and CA are `authoritative` and everything else is `provisional`: the numbers are
 * carried over from the Amazon-wide table, the site is flagged, and the report
 * says so out loud. Silently applying US numbers to a JP listing would produce a
 * confident report about a rule set nobody has verified — which is worse than
 * saying "I do not have a verified rule source for this site yet".
 *
 * Adding a site properly is therefore a data change here, not a code change.
 *
 * ## One documented conflict, resolved rather than hidden
 *
 * `delivery-2026-07-28-listing-whole-optimization.md` says that from 2026-07-27
 * non-media titles are capped at 75 characters. `amazon-listing-comprehensive-
 * rules-2026.md` §1.3 (updated 2026-05-25, so older) gives 200 for 家居/厨房 and
 * 运动户外, 80 for 服装/鞋/珠宝. Both cannot be a hard cap at once.
 *
 * We keep 200 as the hard cap and carry 75 as a **target**, surfaced as a `warn`
 * rather than a `block`. The deciding evidence is the hub's own approved output:
 * the worked example in `01-system/data/products/B0GSFPTD2H/` ships a 186-character
 * optimized title. A 75-character block would reject the hub's own reference
 * deliverable, and a rule that rejects the reference deliverable is a broken
 * rule, not a strict one.
 */

import { MARKETPLACES as COLLECTION_SITES } from '../../sources/pages/amazon.js'

export const MARKETPLACE_PROFILES_VERSION = 'marketplaces.v1'

export const MARKETPLACE_PROFILES_SOURCE =
  'amazon-listing-comprehensive-rules-2026.md v3.0 §1.1/§1.3（Amazon 通用档）+ delivery-2026-07-28-listing-whole-optimization.md（2026-07-27 收紧）'

/**
 * The date the rule manual says *itself* was last updated (§1.3).
 *
 * Named rather than typed where it is used, because it is the only date this
 * plugin can honestly attach to a site's rule coverage: nobody has verified a
 * site by hand (phase 1 has no user table), so the newest thing that can be said
 * about the 北美 rules is "the manual that states them was updated on this day".
 *
 * It lives here, next to the source string it is a property of, so a reader
 * asking "where does 2026-05-25 come from" lands on the citation. v21 seeds the
 * US/CA verification events from this constant and marks them
 * `verified_by = 'system-seed'` — a manual's self-report, never an Amazon
 * verification, and the page says so out loud.
 */
export const RULE_MANUAL_UPDATED_ON = '2026-05-25'

/**
 * Amazon-wide limits (§1.1). These are presented in the doc as general Amazon
 * limits rather than as a北美-only table, so every site starts here.
 */
export const GLOBAL_LIMITS = {
  titleMax: 200,
  titleMaxApparel: 80,
  titleRecommended: 150,
  titleMin: 80,
  titleMobileAnchor: 80,
  titleGoldenZone: 70,
  /** §1.3 category override. */
  titleMaxCategory: { apparel: 80, shoes: 80, jewelry: 80, default: 200 },
  /** 2026-07-27 tightening — a target, not a cap. See the header note. */
  titleNonMediaTarget: 75,
  bulletMin: 10,
  bulletMax: 255,
  bulletRecommendedMin: 80,
  bulletRecommendedMax: 200,
  bulletsMax: 5,
  descriptionMax: 2000,
  descriptionRecommendedMin: 1000,
  /** Bytes, not characters. A CJK character costs 3. */
  backendMaxBytes: 249,
  brandMax: 50,
  /** Alexa for Shopping surface, added to the registry 2026-07-28. */
  itemHighlightsMax: 125,
  itemHighlightsRecommendedMin: 60,
  /** Q&A: the SOP asks for at least 5 pairs, the worked example ships 8. */
  qaMin: 5,
  qaRecommended: 8,
  /** A+ modules the SOP's spec names. */
  aplusModules: 5,
  aplusModulesRecommended: 6,
  imageAltMax: 125,
}

/** Category → title cap, from §1.3. Unknown categories fall to `default`. */
export function titleCapForCategory(category) {
  const key = String(category ?? '').toLowerCase()
  for (const [name, cap] of Object.entries(GLOBAL_LIMITS.titleMaxCategory)) {
    if (name !== 'default' && key.includes(name)) return cap
  }
  return GLOBAL_LIMITS.titleMaxCategory.default
}

/**
 * Per-site profile.
 *
 * `authoritative` is the only field that changes what the report claims, so it
 * is the one field worth being strict about: it is true only where the hub's
 * rule manual states its own scope covers the site.
 */
export const MARKETPLACE_PROFILES = {
  US: {
    code: 'US',
    label: '美国站',
    authoritative: true,
    ruleSource: 'amazon-listing-comprehensive-rules-2026.md v3.0（适用：北美站）',
    units: { length: 'inch', weight: 'pound', temperature: 'fahrenheit' },
    habits: [
      { text: '尺寸写成连乘形式 44x19x4 Inch，不用 × 或逗号分隔', source: '范例 B0GSFPTD2H §3.1' },
      { text: '颜色用亚马逊标准色名（Ivory / Charcoal / Navy），不用营销色名', source: '范例 §7.2 Color: Ivory' },
      { text: '场景词落到具体场所（porch / patio / nursery / poolside / deck），不用 indoor/outdoor 这种二分', source: '范例 §2.1 L4 场景词' },
      { text: '卖点技术名可以自造并复用（CloudFoam / GripTech / AquaShield），竞品普遍这么做', source: '范例 §1 竞品品牌化技术名' },
    ],
  },
  CA: {
    code: 'CA',
    label: '加拿大站',
    authoritative: true,
    ruleSource: 'amazon-listing-comprehensive-rules-2026.md v3.0（适用：北美站）',
    units: { length: 'inch', weight: 'pound', temperature: 'celsius' },
    habits: [
      { text: '英语为主、法语为辅：主文案英文，关键词可补法语变体', source: '采集档案 request=en_CA / accept=[en, fr]' },
    ],
  },
  UK: { code: 'UK', label: '英国站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  DE: { code: 'DE', label: '德国站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  FR: { code: 'FR', label: '法国站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  IT: { code: 'IT', label: '意大利站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  ES: { code: 'ES', label: '西班牙站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  NL: { code: 'NL', label: '荷兰站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  BE: { code: 'BE', label: '比利时站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  SE: { code: 'SE', label: '瑞典站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  PL: { code: 'PL', label: '波兰站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  JP: { code: 'JP', label: '日本站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  SG: { code: 'SG', label: '新加坡站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  AU: { code: 'AU', label: '澳大利亚站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  IN: { code: 'IN', label: '印度站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  MX: { code: 'MX', label: '墨西哥站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  BR: { code: 'BR', label: '巴西站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  AE: { code: 'AE', label: '阿联酋站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  SA: { code: 'SA', label: '沙特站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
  TR: { code: 'TR', label: '土耳其站', authoritative: false, units: { length: 'centimetre', weight: 'kilogram', temperature: 'celsius' }, habits: [] },
}

/** Sites the collection layer can already drive. Kept in sync by assertion. */
export const KNOWN_MARKETPLACES = Object.keys(MARKETPLACE_PROFILES)

/** Sites with a verified rule source — today, exactly the two the hub claims. */
export const AUTHORITATIVE_MARKETPLACES = KNOWN_MARKETPLACES.filter(code => MARKETPLACE_PROFILES[code].authoritative)

/** The default when a listing carries no marketplace. Stated, not implied. */
export const DEFAULT_MARKETPLACE = 'US'

/**
 * The profile for a code, with the collection layer's facts merged in.
 *
 * Returns a `provisional` profile rather than null for an unknown code, because
 * the useful answer to "what are the limits for amazon.com.tr" is "the Amazon-wide
 * ones, unverified" — not a crash. `recognised` says which of the two it is.
 */
export function profileFor(code) {
  const key = String(code ?? '').trim().toUpperCase()
  const recognised = MARKETPLACE_PROFILES[key] !== undefined
  const base = recognised ? MARKETPLACE_PROFILES[key] : MARKETPLACE_PROFILES[DEFAULT_MARKETPLACE]
  const site = COLLECTION_SITES[key] ?? null
  return {
    ...base,
    code: recognised ? key : DEFAULT_MARKETPLACE,
    requestedCode: key === '' ? null : key,
    recognised,
    /** True only when the site's own rule source has been verified. */
    authoritative: recognised && base.authoritative === true,
    domain: site?.domain ?? null,
    language: site?.request ?? null,
    currency: site?.currency ?? null,
    postalCode: site?.postalCode ?? null,
    /** Collection can drive it; optimization has verified rules for it. Different questions. */
    collectible: site !== null,
  }
}

/**
 * Resolve the full limit set for a site + category.
 *
 * `limitsVerified` rides along on the result so no caller has to remember to
 * check the profile separately before printing a number as if it were settled.
 */
export function limitsFor(code, options = {}) {
  const profile = profileFor(code)
  const category = options.category ?? null
  const categoryCap = titleCapForCategory(category)
  const titleMax = Number.isFinite(options.maxTitleChars) ? options.maxTitleChars : categoryCap
  return {
    ...GLOBAL_LIMITS,
    titleMax,
    titleMaxCategory: categoryCap,
    /** The 2026-07-27 tightening. A target, never a block — see the header. */
    titleNonMediaTarget: GLOBAL_LIMITS.titleNonMediaTarget,
    marketplace: profile.code,
    marketplaceLabel: profile.label,
    units: profile.units,
    authoritative: profile.authoritative,
    ruleSource: profile.ruleSource ?? null,
    limitsVerified: profile.authoritative,
  }
}

/**
 * The site-driven caveat every report must print when rules are unverified.
 *
 * Returns null when there is nothing to disclose, so the caller can decide
 * whether to emit a section at all rather than printing an empty disclaimer.
 */
export function provisionalNote(code) {
  const profile = profileFor(code)
  if (profile.authoritative) return null
  return {
    code: profile.code,
    label: profile.label,
    text: `${profile.label}（${profile.code}）没有经过核验的规则来源。本报告套用的是 Amazon 通用档位`
      + `（标题 ${GLOBAL_LIMITS.titleMax} / 五点 ${GLOBAL_LIMITS.bulletMax} / 描述 ${GLOBAL_LIMITS.descriptionMax} / 后台 ${GLOBAL_LIMITS.backendMaxBytes} 字节），`
      + `未按该站点的本地规则校准，购买习惯部分也没有依据。补上该站点的规则源后，只有 marketplaces.js 需要改。`,
  }
}

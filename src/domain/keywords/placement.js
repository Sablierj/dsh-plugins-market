/**
 * 落位处方 —— 这个词**该写进 listing 的哪个位置**，而不是"能不能写"。
 *
 * ## 为什么要有这一层
 *
 * 原来的 `for_listing_json` 是六个布尔：`{title:true, bullets:true, backend:true, …}`。
 * 它回答"能不能放"，不回答**放哪、第几顺位、什么形态**。结果就是：listing 优化时
 * 词库只能给一堆候选，顺序和去重还得人再想一遍 —— 那正是最费时的一步。
 *
 * 这一层把 SOP §6.1–6.4 的落位规则固化成**处方**，让草稿可以照着写。
 *
 * ## 规则（与 SOP 一致，不外扩）
 *
 * | 角色 | 搜索量 | 层级 | 落位 |
 * |---|---|---|---|
 * | identity | ≥ 10,000 | ≤ L3 | **标题** |
 * | identity | ≥ 1,000 | ≤ L4 | **五点** |
 * | identity | 其余 | —— | **后台搜索词** |
 * | 非 identity | 任意 | —— | **不落位**（只做广告 / 否词） |
 *
 * `tier` 是**同一位置内的顺位档**（1 最高），按搜索量分档，不是全局排名 ——
 * 全局排名要等所有词都算完才知道，那是另一次遍历；先给档位就足够照着写。
 *
 * ## 明确不做的事
 *
 * - **不判重**：`bench cushion` 与 `bench cushions` 的冲突要跨词比较，这里只有单条。
 *   把冲突留给导出的 `conflicts_with`（按单复数对查库），不在这一层猜。
 * - **不改写词**：`form` 只说建议形态（原样 / 复数），不生成新词 ——
 *   生成的新词没人审过，写进 listing 就是编的。
 */

/** 处方槽位，按优先级从高到低。`null` = 不落位。 */
export const PLACEMENT_SLOTS = ['title', 'bullets', 'backend']

export const SLOT_MEANING = {
  title: '标题',
  bullets: '五点描述',
  backend: '后台搜索词',
}

/**
 * @param {{role?: string, searchVolume?: number|null, svTier?: string|null}} input
 * @returns {{slot: string|null, tier: number|null, form: string, reason: string}}
 */
export function listingPlacement({ role = 'unknown', searchVolume = null, svTier = null } = {}) {
  /* `null` 必须与 `0` 分开：`Number(null) === 0`，把它当 0 会让
     "没有搜索量数据"错判成"搜索量 0"，两者都进后台，但理由完全不同 ——
     理由写错，三个月后没人能判断当时是真没数据还是这个词真的没人搜。 */
  const blank = searchVolume === null || searchVolume === undefined || String(searchVolume).trim() === ''
  const parsed = blank ? Number.NaN : Number(searchVolume)
  const volume = Number.isFinite(parsed) ? parsed : null
  const tierNum = { L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 }[svTier] ?? null

  if (role !== 'identity') {
    return {
      slot: null,
      tier: null,
      form: 'exact',
      reason: role === 'unknown'
        ? '产品线没有身份短语，不判断落位'
        : '不是本产品的主身份词 —— 只做广告与否词，不进 listing',
    }
  }

  if (volume === null) {
    return {
      slot: 'backend',
      tier: 3,
      form: 'exact',
      reason: '身份词但没有搜索量数据 —— 进后台，别占标题字符',
    }
  }

  if (volume >= 10_000 && tierNum !== null && tierNum <= 3) {
    return {
      slot: 'title',
      tier: volume >= 50_000 ? 1 : (volume >= 20_000 ? 2 : 3),
      form: 'exact',
      reason: '身份词 + 搜索量 ' + volume + ' + ' + svTier + ' —— 够格进标题',
    }
  }
  if (volume >= 1_000 && tierNum !== null && tierNum <= 4) {
    return {
      slot: 'bullets',
      tier: volume >= 20_000 ? 1 : (volume >= 5_000 ? 2 : 3),
      form: 'exact',
      reason: '身份词 + 搜索量 ' + volume + ' —— 进五点',
    }
  }
  return {
    slot: 'backend',
    tier: 3,
    form: 'exact',
    reason: '身份词但量级偏小（' + volume + '）—— 进后台，不占正文',
  }
}

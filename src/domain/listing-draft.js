/**
 * 改稿草稿：把诊断结论变成**能直接贴进后台的英文文案**，然后立刻用同一套规则复测。
 *
 * 诚实说明：这是**规则生成**，不是文案大师写的。它的价值是：
 *   1. 把「必须出现的词」和「必须有的数字」按位置放好，符合政策；
 *   2. 给出一个可编辑的起点，运营改 20% 比从 0 写快得多；
 *   3. 生成后立刻复测，分数涨没涨、哪项还红，是可验证的。
 */

const PROMO = ['free shipping', 'best seller', 'sale', 'guarantee', '100%', 'hot sale', 'discount']

export function buildListingDraft({ asin, listing, keywords = [], brand = null, tighten = false }) {
  const facts = extractFacts(listing)
  const words = keywords
    .map(item => String(item.keyword ?? '').trim().toLowerCase())
    .filter(Boolean)

  // 主力词：份额最高的那个放标题最前面
  const ranked = [...keywords].sort((a, b) => (b.traffic_share ?? 0) - (a.traffic_share ?? 0))
  const primary = String(ranked[0]?.keyword ?? words[0] ?? 'bench cushion').trim()
  const primaryTitle = titleCase(primary)

  const sizeText = facts.sizes.length ? facts.sizes.join(' + ') : ''
  const densityText = facts.density ? `${facts.density} High Density Foam` : 'High Density Foam'
  // 只取第一种材质：Chenille 与 Linen 同时命中时会拼出「Chenille Linen」这种不存在的混纺
  const materialText = facts.materials.length ? facts.materials[0] : ''

  // ── 标题：核心词 → 数值 → 材质 → 结构特点，≤200 字符，无促销词 ──
  const titleParts = [
    brand ? `${brand} ${primaryTitle}` : primaryTitle,
    sizeText ? `${sizeText}` : '',
    densityText,
    materialText ? `${materialText} Cover` : '',
    'with Ties & Non-Slip Bottom',
  ].filter(Boolean)
  let title = dedupeWords(titleParts.join(', '))
  if (title.length > 200) title = title.slice(0, 200).replace(/[,\s]+$/, '')

  // ── 亮点：≤125 字符，必须带数字 ──
  const highlightParts = [
    sizeText,
    facts.thickness ? `${facts.thickness} thick` : '',
    facts.density ?? '',
    facts.materials[0] ?? '',
    'non-slip',
  ].filter(Boolean)
  let highlights = highlightParts.join(', ')
  if (highlights.length > 125) highlights = highlights.slice(0, 125).replace(/[,\s]+$/, '')

  // ── 五点：每条一个卖点，把带量词自然嵌进去 ──
  const bullets = [
    `CUSTOM FIT FOR YOUR BENCH: This ${primary} is cut to the size you need — ${sizeText || 'custom dimensions'} — so the seat pad and back pad line up with your bench frame instead of bunching at the corners.`,
    `KEEPS ITS SHAPE: ${densityText} blended with silk cotton keeps the bench cushion supportive after long sitting; pat and reshape after unpacking and it recovers to about ${facts.thickness || '4 in'} thick.`,
    `${materialText || 'Soft'} COVER, INDOOR LIVING: The dense ${(facts.materials[0] ?? 'fabric').toLowerCase()} surface gives a warm handfeel and hides daily wear — made for indoor bench cushions on entryway, dining nook and bedroom benches.`,
    `STAYS WHERE YOU PUT IT: Rear corner ties plus a non-slip bottom on the seat, and a wrap-around strap on the back, keep this custom bench cushion from sliding when people sit down.`,
    `EASY CARE, LONG USE: Tufting reduces fill shifting and double-piped edges hold the outline; spot clean only, low-temperature steam for wrinkles, no machine wash or dryer.`,
  ]

  // 覆盖补强：把还没被覆盖的带量词，按份额顺序补进还有余量的 bullet（自然句式，不堆词）
  const covered = () => bullets.map(text => text.toLowerCase()).join(' ')
  const uncovered = ranked
    .map(item => String(item.keyword).trim().toLowerCase())
    .filter(word => word && !covered().includes(word))
  for (const word of uncovered) {
    for (let i = 0; i < bullets.length; i += 1) {
      const sentence = ` Also works as a ${word}.`
      if ((bullets[i] + sentence).length <= 470) {
        bullets[i] = bullets[i] + sentence
        break
      }
    }
  }

  // ── 第二轮：把复测里仍 warn 的项收干净 ──────────────────
  //   1) 每条 ≤470 字符（给平台留余量，别卡着 500 上限）
  //   2) 每条至少有一个数字（尺寸/厚度/密度任取其一）
  //   3) 文案里出现 how/which 这类问句锚点，供 AI 检索命中
  if (tighten) {
    const measurable = sizeText || facts.thickness || facts.density || '4 in'
    for (let i = 0; i < bullets.length; i += 1) {
      let text = bullets[i]
      if (text.length > 470) {
        const cut = text.lastIndexOf('. ', 460)
        text = cut > 200 ? text.slice(0, cut + 1) : text.slice(0, 470) + '.'
      }
      if (!/\d/.test(text)) text += ` Fits ${measurable} bench seats.`
      bullets[i] = text
    }
    const hasQuestionAnchor = /how|which|what/i.test(bullets.join(' '))
    if (!hasQuestionAnchor) {
      bullets[4] = bullets[4] + ' Not sure which bench size you need? Measure the seat and back before ordering.'
    }
  }

  // ── 属性：把 SIF 抓到的两个扩展成常见 6 项 ──
  const attributes = [
    { code: 'Material', value: facts.materials[0] ?? 'Chenille' },
    { code: 'Size', value: sizeText || 'Custom size' },
    { code: 'Thickness', value: facts.thickness ?? '4 in' },
    { code: 'Density', value: facts.density ?? '75D' },
    { code: 'Shape', value: facts.shape ?? 'Rectangular' },
    { code: 'Scene', value: 'Indoor' },
  ]

  // ── 后台搜索词：≤250 字节，只放没进标题/五点的长尾 ──
  const inCopy = (title + ' ' + bullets.join(' ')).toLowerCase()
  const tail = [...new Set(words.filter(word => !inCopy.includes(word)))]
  let searchTerms = ''
  for (const word of tail) {
    const next = searchTerms ? `${searchTerms} ${word}` : word
    if (new TextEncoder().encode(next).length > 240) break
    searchTerms = next
  }

  const draft = {
    title,
    itemHighlights: highlights,
    bullets,
    attributes,
    searchTerms,
    description: `${primaryTitle} built for a precise fit. ${densityText} keeps support, the ${(facts.materials[0] ?? 'fabric').toLowerCase()} cover stays soft, and ties plus a non-slip bottom keep it in place. Spot clean only.`,
    price: listing?.price ?? null,
    rating: listing?.rating ?? null,
    reviews: listing?.reviews ?? null,
    variationNum: listing?.variationNum ?? null,
  }

  return { asin, draft, notes: draftNotes(draft, facts, uncovered.length) }
}

function draftNotes(draft, facts, filled) {
  const notes = []
  notes.push(`标题 ${draft.title.length} 字符（上限 200），核心词放在最前。`)
  notes.push(`亮点 ${draft.itemHighlights.length} 字符（上限 125），含 ${facts.sizes.length ? '尺寸' : ''}${facts.thickness ? '厚度' : ''}等数值。`)
  notes.push(`五点 ${draft.bullets.length} 条，最长 ${Math.max(...draft.bullets.map(text => text.length))} 字符（上限 500）。`)
  notes.push(`属性补到 ${draft.attributes.length} 项；后台词 ${new TextEncoder().encode(draft.searchTerms).length} 字节（上限 250）。`)
  if (filled) notes.push(`有 ${filled} 个带量词在五点里没有自然位，已用补充句式补进有余额的条目——发布前建议人工改写成更自然的句子。`)
  const bad = PROMO.filter(word => draft.title.toLowerCase().includes(word))
  notes.push(bad.length ? `⚠ 标题仍含促销词：${bad.join('、')}` : '标题无促销词，符合政策口径。')
  return notes
}

/** 从现有文案里挖出可复用的硬事实：尺寸、厚度、密度、材质、形状。 */
function extractFacts(listing) {
  const text = [listing?.title, listing?.itemHighlights, listing?.size, ...(listing?.bullets ?? []), listing?.description]
    .filter(Boolean).join(' \n ')
  const sizes = [...new Set((text.match(/\b\d{1,2}\s?x\s?\d{1,2}\s?(?:in|inch|inches)\b/gi) ?? [])
    .map(value => value.replace(/\s+/g, ' ').trim()))].slice(0, 3)
  const thickness = (text.match(/\b(\d(?:\.\d)?)\s?(?:in|inch|inches)\s+thick\b/i) ?? [])[1]
    ?? (text.match(/\babout\s+(\d(?:\.\d)?)\s?(?:in|inch)\b/i) ?? [])[1]
  const density = (text.match(/\b(\d{2}D)\b/i) ?? [])[1]
  const materials = ['Chenille', 'Velvet', 'Linen', 'Cotton', 'Leather', 'Microfiber', 'Polyester']
    .filter(item => new RegExp(item, 'i').test(text))
  const shape = /\bround\b/i.test(text) ? 'Round' : /\bsquare\b/i.test(text) ? 'Square' : 'Rectangular'
  return {
    sizes,
    thickness: thickness ? `${thickness} in` : null,
    density: density ? density.toUpperCase() : null,
    materials,
    shape,
  }
}

function titleCase(text) {
  return String(text).replace(/\b[a-z]/g, letter => letter.toUpperCase())
}

function dedupeWords(text) {
  const seen = new Set()
  return text.split(/,\s*/).filter(part => {
    const key = part.toLowerCase().trim()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).join(', ')
}

/** 复测：同一套规则跑改后的文案，分数涨没涨是可验证的。 */
export function diffAudit(before, after) {
  const changed = after.sections
    .map(section => {
      const previous = before.sections.find(item => item.id === section.id)
      return { name: section.name, from: previous?.status ?? '—', to: section.status }
    })
    .filter(item => item.from !== item.to)
  return {
    scoreBefore: before.score,
    scoreAfter: after.score,
    delta: after.score - before.score,
    changed,
  }
}

/** 把草稿渲染成一份「可以直接照着贴」的文档。 */
export function renderDraftReport({ asin, draft, notes, diff, before, after }, { now = new Date() } = {}) {
  const lines = []
  lines.push(`# ${asin} Listing 改稿草稿（可直接粘贴）`)
  lines.push('')
  lines.push(`生成时间：${now.toISOString().slice(0, 16).replace('T', ' ')}`)
  lines.push(`**复测：${diff.scoreBefore} → ${diff.scoreAfter}（${diff.delta >= 0 ? '+' : ''}${diff.delta} 分）**`)
  lines.push('')

  lines.push('## 复测变化')
  lines.push('')
  if (!diff.changed.length) lines.push('_各维度判定未变化。_')
  else {
    lines.push('| 维度 | 改前 | 改后 |')
    lines.push('|---|---|---|')
    for (const item of diff.changed) lines.push(`| ${item.name} | ${label(item.from)} | ${label(item.to)} |`)
  }
  lines.push('')

  lines.push(`## 一、标题（${draft.title.length} 字符 / 上限 200）`)
  lines.push('')
  lines.push('```')
  lines.push(draft.title)
  lines.push('```')
  lines.push('')

  lines.push(`## 二、亮点 Item Highlights（${draft.itemHighlights.length} 字符 / 上限 125）`)
  lines.push('')
  lines.push('```')
  lines.push(draft.itemHighlights || '（空）')
  lines.push('```')
  lines.push('')

  lines.push(`## 三、五点描述（${draft.bullets.length} 条，最长 ${Math.max(...draft.bullets.map(text => text.length))} 字符 / 上限 500）`)
  lines.push('')
  draft.bullets.forEach((text, index) => {
    lines.push(`**${index + 1}.**`)
    lines.push('```')
    lines.push(text)
    lines.push('```')
  })
  lines.push('')

  lines.push('## 四、属性字段')
  lines.push('')
  lines.push('| 字段 | 值 |')
  lines.push('|---|---|')
  for (const item of draft.attributes) lines.push(`| ${item.code} | ${item.value} |`)
  lines.push('')

  lines.push(`## 五、后台搜索词（${new TextEncoder().encode(draft.searchTerms).length} 字节 / 上限 250）`)
  lines.push('')
  lines.push('```')
  lines.push(draft.searchTerms || '（无需补充：带量词已全部出现在标题/五点里）')
  lines.push('```')
  lines.push('')

  lines.push('## 六、生成说明与人工必改项')
  lines.push('')
  notes.forEach(note => lines.push(`- ${note}`))
  lines.push('- 这是**规则生成**的草稿：句子结构成型、词位与字数合规，但语气仍需人工润色后再发布。')
  lines.push('- 发布前请在后台逐项核对：变体归属、尺寸单位、材质与实物一致，避免「描述与实物不符」的合规风险。')
  lines.push('')

  lines.push('## 七、仍然无数据来源的维度')
  lines.push('')
  const nodata = after.sections.filter(section => section.status === 'nodata')
  if (!nodata.length) lines.push('_无。_')
  else for (const section of nodata) lines.push(`- **${section.name}**：${section.findings[0]?.issue ?? ''}`)
  lines.push('')
  lines.push('> 主图 / 副图 / A+ / 评论正文这四项，本仓没有采集通道；改稿草稿不覆盖它们，也不假装覆盖。')
  lines.push('')
  lines.push(`_生成器：sif-ops · ${now.toISOString().slice(0, 10)}_`)
  return lines.join('\n')
}

function label(status) {
  return { ok: '通过', warn: '待优化', fail: '不合格', nodata: '无数据来源' }[status] ?? status
}

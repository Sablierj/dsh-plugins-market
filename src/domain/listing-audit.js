/**
 * Listing 深度诊断：12 个维度逐项对照亚马逊政策与运营口径，产出可执行的改造清单。
 *
 * 三条纪律：
 *   1. **没有数据来源的维度必须写「无来源」**，不猜。主图/副图/A+/评论正文 SIF 不提供，
 *      本地也没有采集，所以它们的状态是 `nodata`，而不是「没问题」。
 *   2. 每条问题都要给「现状 → 依据 → 改法 → 预期影响」，影响只说方向与作用面，不编造百分比。
 *   3. 政策类判定（字符上限、促销词、全大写）用可配置阈值，默认取美国站常见上限；
 *      具体类目可能更严，报告里明写这一句，避免当成绝对法律条文。
 */

export const POLICY = {
  titleMaxChars: 200,
  titleHeadChars: 80, // 前 80 字符是移动端主要可见区，核心词要在这之前
  highlightMaxChars: 125,
  bulletMaxChars: 500,
  bulletCount: 5,
  descriptionMaxChars: 2000,
  searchTermsMaxBytes: 250,
  imagesRecommended: 7,
}

const PROMO_WORDS = [
  'free shipping', 'best seller', 'best-seller', 'sale', 'discount', 'hot sale', 'cheap',
  'limited time', 'buy now', 'free gift', 'guarantee', '100%', 'top rated', 'promotion',
]
const SUBJECTIVE_WORDS = ['best', 'perfect', 'amazing', 'wonderful', 'greatest', 'premium quality']
const PLACEHOLDERS = ['color name', 'size name', 'product name', 'brand name', 'todo', 'lorem']

export function auditListing({ asin, listing, keywords = [], competitorPrices = [], assets = null, now = new Date() }) {
  const sections = []
  const add = (id, name, status, findings, metrics) => sections.push({ id, name, status, findings, metrics })

  const title = String(listing?.title ?? '').trim()
  const bullets = Array.isArray(listing?.bullets) ? listing.bullets.filter(Boolean).map(String) : []
  const highlights = String(listing?.itemHighlights ?? '').trim()
  const description = String(listing?.description ?? '').trim()
  const searchTerms = String(listing?.searchTerms ?? '').trim()
  const attributes = Array.isArray(listing?.attributes) ? listing.attributes : []
  const price = listing?.price ?? null
  const reviews = listing?.reviews ?? null
  const rating = listing?.rating ?? null
  const variants = listing?.variationNum ?? null

  const topKeywords = keywords.slice(0, 12).map(item => ({
    keyword: String(item.keyword).toLowerCase(),
    share: item.traffic_share ?? null,
    volume: item.aba_volume ?? item.volume_week ?? null,
  }))
  const corpus = [title, highlights, ...bullets, description, searchTerms].join(' \n ').toLowerCase()

  // ── 1. 标题 ─────────────────────────────────────────────
  {
    const findings = []
    const chars = title.length
    if (!title) {
      findings.push(issue('high', '标题为空', '库里没有抓到标题', '先补齐标题再谈优化'))
    } else {
      if (chars > POLICY.titleMaxChars) findings.push(issue('high', `标题 ${chars} 字符，超过常见上限 ${POLICY.titleMaxChars}`, '超限会被截断或降权', '删掉重复词与主观形容词，把类目词保留在最前'))
      const head = title.slice(0, POLICY.titleHeadChars).toLowerCase()
      const missingHead = topKeywords.filter(item => !head.includes(item.keyword) && item.share && item.share >= 0.1)
      if (missingHead.length) findings.push(issue('high', `前 ${POLICY.titleHeadChars} 字符没覆盖主力词：${missingHead.map(item => item.keyword).join('、')}`, '移动端只展示标题前半段，这里没词等于没埋', '把份额最高的 1-2 个词提到前 80 字符内'))
      const promo = PROMO_WORDS.filter(word => title.toLowerCase().includes(word))
      if (promo.length) findings.push(issue('high', `标题含促销/保证类词：${promo.join('、')}`, '违反 A9/政策口径，可能被抑制搜索', '删除全部促销词，改写成属性+场景'))
      const capsWords = title.split(/\s+/).filter(word => word.length >= 4 && word === word.toUpperCase() && /[A-Z]/.test(word))
      if (capsWords.length > 1) findings.push(issue('medium', `全大写词过多（${capsWords.slice(0, 4).join('、')}）`, '平台不建议全大写，影响可读性', '仅保留品牌名大写，其余正常大小写'))
      const specials = (title.match(/[!$?_{}^¬¦]/g) ?? [])
      if (specials.length) findings.push(issue('medium', `含特殊符号 ${specials.length} 处`, '部分符号在标题被禁止', '去掉装饰性符号，用空格/逗号分隔'))
      const words = title.toLowerCase().split(/[\s,]+/).filter(Boolean)
      const dup = words.filter((word, index) => word.length > 3 && words.indexOf(word) !== index)
      if (new Set(dup).size >= 2) findings.push(issue('medium', `重复词 ${new Set(dup).size} 个（${[...new Set(dup)].slice(0, 3).join('、')}）`, '重复词浪费字符预算', '同一词只出现一次，把位置让给新卖点'))
      const subjective = SUBJECTIVE_WORDS.filter(word => title.toLowerCase().includes(word))
      if (subjective.length) findings.push(issue('low', `主观形容词：${subjective.join('、')}`, '不产生搜索价值，也难被 AI 引用', '换成可验证属性（材质/尺寸/厚度/承重）'))
      const covered = topKeywords.filter(item => title.toLowerCase().includes(item.keyword))
      findings.push(issue('info', `标题覆盖 ${covered.length}/${topKeywords.length} 个 tracked 词`, covered.length ? covered.map(item => item.keyword).join('、') : '一个都没覆盖', '覆盖率低的词靠五点/后台词补'))
    }
    add('title', '标题（Title）', statusOf(findings), findings, { chars, limit: POLICY.titleMaxChars })
  }

  // ── 2. 亮点（Item Highlights）─────────────────────────────
  {
    const findings = []
    const chars = highlights.length
    if (!chars) {
      findings.push(issue('medium', 'Item Highlights 为空', '这是 2024 后新增的展示位，缺了就少一块可被检索/引用的文本', '填 3-5 个「属性 数值」短句，≤125 字符'))
    } else {
      if (chars > POLICY.highlightMaxChars) findings.push(issue('high', `亮点 ${chars} 字符，超过 ${POLICY.highlightMaxChars} 上限`, '超限会被截断', '压到 125 以内，只留最高价值的属性'))
      const hasNumber = /\d/.test(highlights)
      if (!hasNumber) findings.push(issue('low', '亮点里没有可量化信息', 'AI 与买家都更信具体数字', '补尺寸/厚度/密度/承重等数值'))
    }
    add('highlights', '亮点（Item Highlights）', statusOf(findings), findings, { chars, limit: POLICY.highlightMaxChars })
  }

  // ── 3. 五点 ─────────────────────────────────────────────
  {
    const findings = []
    const count = bullets.length
    if (count === 0) findings.push(issue('high', '没有抓到五点描述', '五点是转化主战场', '补齐 5 条，按 场景→材质→结构→安装→售后 排'))
    else {
      if (count < POLICY.bulletCount) findings.push(issue('medium', `只有 ${count} 条，建议 ${POLICY.bulletCount} 条`, '少一条就少一个卖点位置', '补到 5 条，每条只讲一件事'))
      const tooLong = bullets.filter(text => text.length > POLICY.bulletMaxChars)
      if (tooLong.length) findings.push(issue('medium', `${tooLong.length} 条超过 ${POLICY.bulletMaxChars} 字符`, '过长会被折叠', '每条压到 2 行内，首句给结论'))
      const coveredWords = topKeywords.filter(item => bullets.join(' ').toLowerCase().includes(item.keyword))
      if (topKeywords.length && coveredWords.length / topKeywords.length < 0.4) {
        findings.push(issue('high', `五点只覆盖 ${coveredWords.length}/${topKeywords.length} 个 tracked 词`, '买家看到的文本里没有他要搜的词', '把未覆盖的词自然嵌进对应卖点句，别堆砌'))
      }
      const noNumber = bullets.filter(text => !/\d/.test(text)).length
      if (noNumber >= 3) findings.push(issue('low', `${noNumber} 条五点没有数字`, '缺具体参数，说服力弱', '补尺寸/层数/克重/承重'))
      if (bullets.some(text => text.length > 0 && text === text.toUpperCase())) findings.push(issue('low', '有整句全大写的五点', '可读性差', '改为句式正常的大小写'))
    }
    add('bullets', '五点描述（Bullets）', statusOf(findings), findings, { count, limit: POLICY.bulletCount })
  }

  // ── 4. 主副图 ───────────────────────────────────────────
  {
    if (assets && assets.imagesTotal !== null && assets.imagesTotal !== undefined) {
      const findings = []
      const total = Number(assets.imagesTotal)
      if (total < POLICY.imagesRecommended) {
        findings.push(issue('high', `只有 ${total} 张图，建议 ${POLICY.imagesRecommended} 张以上`, '主图之外缺场景/尺寸/细节图，转化会被拉低', '补场景图、尺寸标注图、材质特写、使用步骤图'))
      } else {
        findings.push(issue('info', `已上传 ${total} 张图`, '数量达标', '继续优化前 3 张的信息密度'))
      }
      if (assets.hasWhiteBg === false) findings.push(issue('high', '主图不是纯白底', '违反主图政策，可能被抑制', '换成 RGB 255,255,255 白底、产品占 85%'))
      if (assets.minPxOk === false) findings.push(issue('high', '图片边长不足 1000px', '不支持放大镜，转化损失明显', '主图与副图都按 ≥1600px 重出'))
      if (assets.hasVideo === false) findings.push(issue('medium', '没有视频', '视频对转化提升显著，尤其家具类', '补 15-30 秒安装/使用场景视频'))
      add('images', '主图 / 副图', statusOf(findings), findings, { total, source: assets.source ?? 'manual' })
    } else {
      add('images', '主图 / 副图', 'nodata', [issue('info', '无数据来源：SIF 不提供图片，本地也未采集', '主图白底、≥1000px、7 张以上属硬要求，但本仓无法核验', '在「优化」页补录图片数/白底/像素，或由 amazon-ops 采集后自动读取')], {})
    }
  }

  // ── 5. A+ ───────────────────────────────────────────────
  {
    if (assets && assets.aplus !== null && assets.aplus !== undefined) {
      const findings = []
      if (assets.aplus) findings.push(issue('info', '已上传 A+ 内容', 'A+ 对转化有稳定提升', '按「痛点→方案→参数→场景」四段式继续迭代'))
      else findings.push(issue('high', '没有 A+ 页面', '品牌注册后可上传，是转化率最低成本的一块增量', '优先做对比表模块 + 场景图模块'))
      add('aplus', 'A+ 页面', statusOf(findings), findings, { aplus: assets.aplus })
    } else {
      add('aplus', 'A+ 页面', 'nodata', [issue('info', '无数据来源：A+ 模块不在 SIF 返回里', 'A+ 对转化影响大，但无法自动核验是否已上传', '在「优化」页补录是否已上传，或走 amazon-ops 采集')], {})
    }
  }

  // ── 6. 评论 ─────────────────────────────────────────────
  {
    const findings = []
    if (reviews === null && rating === null) {
      findings.push(issue('info', '无评分/评论数', '无法做口碑判断', '跑一次画像（2 点）即可拿到评分与评论数'))
    } else {
      if (rating !== null && rating < 4.2) findings.push(issue('high', `评分 ${rating}，低于 4.2`, '广告转化与 Buy Box 竞争都吃亏', '先处理差评主题，再谈放量'))
      if (reviews !== null && reviews < 50) findings.push(issue('medium', `评论数 ${reviews}，偏少`, '新品期常见，但会限制转化', '用 Vine / 站内索评把评论拉到 50+'))
    }
    const themes = String(assets?.reviewThemes ?? '')
      .split(/[,，;；\n]/).map(item => item.trim()).filter(Boolean)
    if (themes.length) {
      findings.push(issue('medium', `差评主题（人工录入 ${themes.length} 条）：${themes.slice(0, 5).join('、')}`,
        '评论正文 SIF 不提供，这些主题来自你/同事的录入', '先改被反复提到的点（尺寸不符/塌陷/掉色），再投广告；每条主题在 Listing 里正面回应'))
    } else {
      findings.push(issue('info', '评论正文与分析不可得：SIF 只给数量与星级', '无法做差评主题聚类', '在「优化」页把差评主题补录进来，或接 amazon-ops 评论采集'))
    }
    add('reviews', '评论与口碑', statusOf(findings), findings, { rating, reviews, themes: themes.length })
  }

  // ── 7. 产品结构（系列 / 捆绑 / 价格阶梯）──────────────────
  {
    const findings = []
    const prices = competitorPrices.filter(value => typeof value === 'number' && value > 0).sort((a, b) => a - b)
    if (!variants) {
      findings.push(issue('info', '变体结构未知，无法判断系列结构', '无法核对父子体是否分裂成多个 listing', '跑一次画像可拿到 variation_num'))
    } else if (variants > 8) {
      findings.push(issue('medium', `${variants} 个变体，注意重复占位与自相残杀`, '同词多子体会互相稀释权重', '每个子体绑定不同主力词，主图与标题做差异化'))
    } else {
      findings.push(issue('info', `${variants} 个变体，结构精简`, '变体少意味着覆盖的场景/尺寸有限', '按最高流量的两个尺寸/颜色扩充，而不是全色全码铺开'))
    }
    if (prices.length >= 3 && price !== null) {
      const cheap = prices.filter(value => value < price).length
      const ratio = cheap / prices.length
      if (ratio > 0.8) findings.push(issue('medium', '你的价格处在竞品带的高位（80% 竞品比你便宜）', '同质产品下转化会被价格压制', '考虑做「主品 + 配件」捆绑，而不是直接降价'))
      else if (ratio < 0.2) findings.push(issue('low', '价格处在竞品带低位（80% 竞品比你贵）', '低价容易被认为低质，也损失毛利', '可用「加量不加价」的套装抬高客单'))
    }
    findings.push(issue('info', '捆绑/系列组合不在数据范围内', 'SIF 只返回单个 ASIN 的结构，看不到你的产品线布局', '需要人工核对，或由 amazon-ops 采集父体树'))
    add('structure', '产品结构（系列 / 捆绑）', statusOf(findings), findings, { variants })
  }

  // ── 8. 变体 ────────────────────────────────────────────
  {
    const findings = []
    const dims = attributes.map(item => item.code).filter(Boolean)
    if (!variants) findings.push(issue('info', '变体数未知', '无法判断父子体结构是否健康', '跑一次画像可拿到 variation_num'))
    else {
      if (variants >= 6) findings.push(issue('medium', `${variants} 个变体，需防重复占位`, '同词多子体互相抢位会稀释权重', '每个变体绑定不同主力词，主图与标题差异化'))
      else findings.push(issue('low', `只有 ${variants} 个变体`, '变体少则覆盖的场景/尺寸少', '按最高流量的尺寸/颜色扩充'))
    }
    if (dims.length) findings.push(issue('info', `变体维度：${dims.join('、')}`, '维度清晰利于筛选器曝光', '确保每个子体的属性值与实物一致'))
    add('variants', '变体矩阵', statusOf(findings), findings, { variants, dimensions: dims })
  }

  // ── 9. GEO（AI 搜索可答性）────────────────────────────────
  {
    const findings = []
    const hasSpecs = attributes.length >= 3 || /\d/.test(highlights)
    if (!hasSpecs) findings.push(issue('high', '缺少可被 AI 引用的结构化参数', 'Rufus/COSMO 类问答需要「属性+数值」才能回答', '补齐材质/尺寸/厚度/适用场景，写成「字段: 值」'))
    const qaSeeds = ['适用', '适合', '是否', 'how', 'what', 'which']
    const hasScene = qaSeeds.some(word => corpus.includes(word.toLowerCase()))
    if (!hasScene) findings.push(issue('medium', '文案里没有场景/问句锚点', 'AI 检索更容易命中「适合什么椅子/桌子」这类问题', '五点里加 1 条「适用场景」句式'))
    add('geo', 'GEO / AI 搜索可答性', statusOf(findings), findings, { attributes: attributes.length })
  }

  // ── 10. 价格 ────────────────────────────────────────────
  {
    const findings = []
    const prices = competitorPrices.filter(value => typeof value === 'number' && value > 0).sort((a, b) => a - b)
    if (price === null) findings.push(issue('info', '价格缺失', '无法做价格带判断', '跑一次画像'))
    else if (!prices.length) findings.push(issue('info', '没有竞品价格样本', '需要先跑竞品格局（2 点/词）', '在「竞品」页对头词跑一次'))
    else {
      const median = prices[Math.floor(prices.length / 2)]
      const low = prices[0]
      const high = prices[prices.length - 1]
      const position = price < low ? '低于最低价' : price > high ? '高于最高价' : '在价格带内'
      findings.push(issue('info', `价格 $${price}，竞品带 $${low}-$${high}（中位 $${median}）`, `当前${position}`, position === '高于最高价' ? '要么补差异化卖点支撑溢价，要么回到带内' : '保持价格带内，靠评价与 A+ 拉转化'))
      if (position === '高于最高价') findings.push(issue('high', '价格高于全部竞品', '同等流量下转化会被压制', '先测降价 3-5% 看转化弹性，或补组合装'))
    }
    add('price', '价格与价格带', statusOf(findings), findings, { price, competitorMedian: prices.length ? prices[Math.floor(prices.length / 2)] : null })
  }

  // ── 11. 属性字段 ────────────────────────────────────────
  {
    const findings = []
    const expected = ['材质', '尺寸', '颜色', '形状', '适用场景', '承重']
    const have = attributes.map(item => `${item.code}=${item.value}`)
    if (attributes.length < 6) findings.push(issue('medium', `只有 ${attributes.length} 个属性有值`, '属性缺失会少掉筛选器曝光，也让 AI 无法回答', `补齐常见属性：${expected.join(' / ')}`))
    if (!attributes.length) findings.push(issue('high', '属性字段几乎为空', '筛选器与对比表都抓不到你', '按后台模板逐项填满'))
    add('attributes', '属性与其他字段', statusOf(findings), findings, { filled: attributes.length, sample: have.slice(0, 6) })
  }

  // ── 12. 后台搜索词 & 政策合规 ─────────────────────────────
  {
    const findings = []
    if (!searchTerms) findings.push(issue('info', '后台搜索词（Search Terms）未采集', '这是 250 字节的补充位，通常有 30% 的长尾从这来', '在后台导出或人工贴进来后复核'))
    else {
      const bytes = new TextEncoder().encode(searchTerms).length
      if (bytes > POLICY.searchTermsMaxBytes) findings.push(issue('high', `后台词 ${bytes} 字节，超过 ${POLICY.searchTermsMaxBytes}`, '超限部分被丢弃', '删掉标题已有的词，只留长尾与同义词'))
    }
    const placeholders = PLACEHOLDERS.filter(word => corpus.includes(word))
    if (placeholders.length) findings.push(issue('high', `文案里残留占位符：${placeholders.join('、')}`, '模板没改干净，直接影响转化', '发布前全局搜一遍并清空'))
    const brandHijack = ['anker', 'amazon basics', 'oem'].filter(word => corpus.includes(word))
    if (brandHijack.length) findings.push(issue('high', `疑似他牌词：${brandHijack.join('、')}`, '关键词含他牌可能被判侵权', '仅保留自有品牌词'))
    add('policy', '后台词与政策合规', statusOf(findings), findings, {})
  }

  // 关键词覆盖矩阵
  const coverage = topKeywords.map(item => {
    const inTitle = title.toLowerCase().includes(item.keyword)
    const inBullets = bullets.join(' ').toLowerCase().includes(item.keyword)
    const inHighlights = highlights.toLowerCase().includes(item.keyword)
    const inDesc = description.toLowerCase().includes(item.keyword)
    return { keyword: item.keyword, share: item.share, volume: item.volume, inTitle, inBullets, inHighlights, inDesc, covered: inTitle || inBullets || inHighlights || inDesc }
  })

  const allIssues = sections.flatMap(section => section.findings.map(finding => ({ ...finding, section: section.name })))
  // 扣分留一点余量：全错也不该归零，否则「补录素材后 0 分」会让人误以为 Listing 变差了
  const score = Math.max(5, 100
    - allIssues.filter(finding => finding.severity === 'high').length * 8
    - allIssues.filter(finding => finding.severity === 'medium').length * 4
    - allIssues.filter(finding => finding.severity === 'low').length * 2)

  return {
    asin,
    generatedAt: now.toISOString(),
    score,
    sections,
    coverage,
    issues: allIssues,
    counts: {
      high: allIssues.filter(finding => finding.severity === 'high').length,
      medium: allIssues.filter(finding => finding.severity === 'medium').length,
      low: allIssues.filter(finding => finding.severity === 'low').length,
      nodata: sections.filter(section => section.status === 'nodata').length,
    },
    listing: { title, bullets, highlights, description, searchTerms, attributes, price, rating, reviews, variants },
  }
}

function issue(severity, issueText, evidence, fix) {
  return { severity, issue: issueText, evidence: evidence ?? '', fix: fix ?? '' }
}

function statusOf(findings) {
  if (findings.some(finding => finding.severity === 'high')) return 'fail'
  if (findings.some(finding => finding.severity === 'medium')) return 'warn'
  if (findings.some(finding => finding.severity === 'low')) return 'warn'
  return 'ok'
}

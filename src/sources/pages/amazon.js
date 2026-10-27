/**
 * The Amazon product-page extractor.
 *
 * This file is the fragile part of the plugin, and it is written on the
 * assumption that it will break. Amazon changes its DOM; selectors that work
 * today will quietly return `null` next month. The defence is not cleverer
 * selectors, it is **making the failure loud**:
 *
 *   - Every field is looked up through a *list* of candidate selectors, so a
 *     cosmetic rename does not lose the field.
 *   - The extraction result reports which selector matched each field and which
 *     fields matched nothing (`matched` / `missing`). A page that parses to
 *     nine empty strings is indistinguishable from a page with no data unless
 *     the extractor says so, and `amzn_collect_doctor` exists to say so.
 *   - Anti-bot and 404 pages are classified, not scraped. Returning a "title"
 *     of "Robot Check" into the library would be worse than returning nothing.
 *
 * The selector table lives here, in Node, and is *passed into* the page. That
 * keeps one definition of truth: the doctor tool can report the same table the
 * extractor uses, instead of a hand-maintained copy that drifts.
 *
 * ## The same page is read twice, on purpose (module 04 F04-07)
 *
 * The nine *fields* above are what the library stores on `asin`. The thirteen
 * *sections* are what `collection_section_result` records, and they answer a
 * different question: "which parts of the product page did we go and read, and
 * how much of each did we get". The section ids and their declared field lists
 * come from `domain/collect/sections.js` — the only copy of that vocabulary in
 * the repository — and everything Amazon-specific about reading them (which
 * region, which selectors, how a literal becomes a declared field name) lives
 * here, next to the field selectors it reuses.
 *
 * `amazonProduct.sections(pageResult, target)` is the Node-side entry point; the
 * **in-page** half runs inside `pageScript`, driven by `sectionReadingSpec()` —
 * the same spec object, injected as JSON. That is what keeps the reader and the
 * column it fills from disagreeing about where a section comes from.
 */

import { COLLECTION_SECTIONS } from '../../domain/collect/sections.js'
import { ATTRIBUTE_FIELD_PREFIX } from '../../domain/rules/listing-fields.js'

/**
 * Storefront definitions.
 *
 * Changing the host is not enough to collect a marketplace correctly, and this
 * table exists because of that. Amazon decides the *displayed language*, the
 * *displayed currency* and the *delivery location* from state that has nothing
 * to do with the hostname:
 *
 *   - the delivery location, derived from the request IP
 *   - the `lc-<storefront>` cookie (interface language), which **beats** `lc-main`
 *   - the `i18n-prefs` cookie (currency)
 *   - the `Accept-Language` request header
 *
 * All of it was verified against a live browser on a network in China:
 * `amazon.de` answered with "Deliver to China", `i18n-prefs=CNY` and
 * `lc-acbde=en_GB` — an English page with Chinese currency for a German listing.
 * Setting `lc-main=de_DE` changed nothing, because `lc-acbde` won.
 *
 * So each marketplace carries what has to be *set*, not just where to go:
 *
 *   domain         the host
 *   request        the `language=` query value and the language cookie value
 *   header         the Accept-Language header
 *   currency       the `i18n-prefs` cookie, and what the page is expected to show
 *   accept         primary language subtags acceptable in the response
 *   postalCode     **the lever that switches the storefront** — see below
 *   country        the ISO code, for matching the delivery line back to a country
 *   locationName   how that country reads in English, plus local spellings
 *
 * ## Why the postal code and not the country dropdown
 *
 * The "Deliver to" popover has a country `<select>`, and the obvious move is to
 * pick the target country in it. That does not work, and the reason is worth
 * recording because it is counter-intuitive: **the list holds the countries you
 * can ship *to from* this storefront, so it excludes the storefront's own
 * country.** Measured on amazon.de: 242 options, `hasUS: true`, `hasDE: false`.
 * Picking "Germany" on amazon.de is not possible, because you are already there.
 *
 * Entering a **postal code**, on the other hand, works everywhere: Amazon
 * resolves it to a country and rewrites the delivery location itself. Verified
 * live on a China-based network — `amazon.de` went from `Deliver to China` to
 * `10115 Berlin`, with the interface in German and prices in EUR.
 *
 * `accept` has more than one entry where a storefront legitimately serves two
 * languages (Belgium serves Dutch or French, Canada English or French, the UAE
 * English or Arabic).
 */
export const MARKETPLACES = {
  US: {
    domain: 'www.amazon.com', request: 'en_US', header: 'en-US,en;q=0.9', currency: 'USD', accept: ['en'],
    country: 'US', locationName: 'United States', locationAliases: ['USA'], postalCode: '10001',
  },
  CA: {
    domain: 'www.amazon.ca', request: 'en_CA', header: 'en-CA,en;q=0.9,fr;q=0.6', currency: 'CAD', accept: ['en', 'fr'],
    country: 'CA', locationName: 'Canada', locationAliases: ['Kanada', 'Canadá'], postalCode: 'M5V 3L9',
  },
  MX: {
    domain: 'www.amazon.com.mx', request: 'es_MX', header: 'es-MX,es;q=0.9,en;q=0.5', currency: 'MXN', accept: ['es'],
    country: 'MX', locationName: 'Mexico', locationAliases: ['México', 'Mexiko'], postalCode: '06600',
  },
  BR: {
    domain: 'www.amazon.com.br', request: 'pt_BR', header: 'pt-BR,pt;q=0.9,en;q=0.5', currency: 'BRL', accept: ['pt'],
    country: 'BR', locationName: 'Brazil', locationAliases: ['Brasil', 'Brasilien'], postalCode: '01310-100',
  },
  UK: {
    domain: 'www.amazon.co.uk', request: 'en_GB', header: 'en-GB,en;q=0.9', currency: 'GBP', accept: ['en'],
    country: 'GB', locationName: 'United Kingdom', locationAliases: ['UK', 'Großbritannien', 'Reino Unido'],
    postalCode: 'SW1A 1AA',
  },
  DE: {
    domain: 'www.amazon.de', request: 'de_DE', header: 'de-DE,de;q=0.9,en;q=0.5', currency: 'EUR', accept: ['de'],
    country: 'DE', locationName: 'Germany', locationAliases: ['Deutschland', 'Alemania', 'Allemagne'],
    postalCode: '10115',
  },
  FR: {
    domain: 'www.amazon.fr', request: 'fr_FR', header: 'fr-FR,fr;q=0.9,en;q=0.5', currency: 'EUR', accept: ['fr'],
    country: 'FR', locationName: 'France', locationAliases: ['Frankreich', 'Francia'], postalCode: '75001',
  },
  IT: {
    domain: 'www.amazon.it', request: 'it_IT', header: 'it-IT,it;q=0.9,en;q=0.5', currency: 'EUR', accept: ['it'],
    country: 'IT', locationName: 'Italy', locationAliases: ['Italia', 'Italien'], postalCode: '00118',
  },
  ES: {
    domain: 'www.amazon.es', request: 'es_ES', header: 'es-ES,es;q=0.9,en;q=0.5', currency: 'EUR', accept: ['es'],
    country: 'ES', locationName: 'Spain', locationAliases: ['España', 'Spanien', 'Espagne'], postalCode: '28001',
  },
  NL: {
    domain: 'www.amazon.nl', request: 'nl_NL', header: 'nl-NL,nl;q=0.9,en;q=0.5', currency: 'EUR', accept: ['nl'],
    country: 'NL', locationName: 'Netherlands', locationAliases: ['Nederland', 'Niederlande', 'Países Bajos'],
    postalCode: '1011',
  },
  BE: {
    domain: 'www.amazon.com.be', request: 'nl_BE', header: 'nl-BE,nl;q=0.9,fr;q=0.7,en;q=0.5', currency: 'EUR', accept: ['nl', 'fr'],
    country: 'BE', locationName: 'Belgium', locationAliases: ['België', 'Belgien', 'Bélgica'], postalCode: '1000',
  },
  SE: {
    domain: 'www.amazon.se', request: 'sv_SE', header: 'sv-SE,sv;q=0.9,en;q=0.5', currency: 'SEK', accept: ['sv'],
    country: 'SE', locationName: 'Sweden', locationAliases: ['Sverige', 'Schweden'], postalCode: '11122',
  },
  PL: {
    domain: 'www.amazon.pl', request: 'pl_PL', header: 'pl-PL,pl;q=0.9,en;q=0.5', currency: 'PLN', accept: ['pl'],
    country: 'PL', locationName: 'Poland', locationAliases: ['Polska', 'Polen'], postalCode: '00-001',
  },
  JP: {
    domain: 'www.amazon.co.jp', request: 'ja_JP', header: 'ja-JP,ja;q=0.9,en;q=0.5', currency: 'JPY', accept: ['ja'],
    country: 'JP', locationName: 'Japan', locationAliases: ['日本'], postalCode: '100-0001',
  },
  SG: {
    domain: 'www.amazon.sg', request: 'en_SG', header: 'en-SG,en;q=0.9,zh;q=0.5', currency: 'SGD', accept: ['en'],
    country: 'SG', locationName: 'Singapore', locationAliases: ['Singapur', 'Singapour'], postalCode: '018989',
  },
  AU: {
    domain: 'www.amazon.com.au', request: 'en_AU', header: 'en-AU,en;q=0.9', currency: 'AUD', accept: ['en'],
    country: 'AU', locationName: 'Australia', locationAliases: ['Australien', 'Australie'], postalCode: '2000',
  },
  IN: {
    domain: 'www.amazon.in', request: 'en_IN', header: 'en-IN,en;q=0.9,hi;q=0.5', currency: 'INR', accept: ['en'],
    country: 'IN', locationName: 'India', locationAliases: ['Indien', 'Inde'], postalCode: '110001',
  },
  AE: {
    // The UAE has no postal code system, so the dialog only needs the country.
    domain: 'www.amazon.ae', request: 'en_AE', header: 'en-AE,en;q=0.9,ar;q=0.5', currency: 'AED', accept: ['en', 'ar'],
    country: 'AE', locationName: 'United Arab Emirates', locationAliases: ['UAE'], postalCode: null,
  },
  SA: {
    domain: 'www.amazon.sa', request: 'ar_SA', header: 'ar-SA,ar;q=0.9,en;q=0.5', currency: 'SAR', accept: ['ar', 'en'],
    country: 'SA', locationName: 'Saudi Arabia', locationAliases: ['Saudi-Arabien', 'Arabie saoudite'], postalCode: '11564',
  },
  TR: {
    domain: 'www.amazon.com.tr', request: 'tr_TR', header: 'tr-TR,tr;q=0.9,en;q=0.5', currency: 'TRY', accept: ['tr'],
    country: 'TR', locationName: 'Turkey', locationAliases: ['Türkiye', 'Türkei'], postalCode: '34000',
  },
}

/** Marketplace code → host. Kept as its own export because it is the common lookup. */
export const MARKETPLACE_DOMAINS = Object.fromEntries(
  Object.entries(MARKETPLACES).map(([code, entry]) => [code, entry.domain]),
)

/** Currency to assume when the price only shows a bare `$`. */
const DEFAULT_CURRENCY = Object.fromEntries(
  Object.entries(MARKETPLACES).map(([code, entry]) => [code, entry.currency]),
)

/**
 * Everything needed to make the browser render one marketplace correctly.
 *
 * Returned whole rather than piecemeal so the collector cannot accidentally
 * apply the domain without the language, which is the bug this exists to fix.
 */
export function storefrontFor(marketplace) {
  const code = String(marketplace ?? '').trim().toUpperCase()
  const entry = MARKETPLACES[code]
  if (entry === undefined) {
    throw new Error(
      `unsupported marketplace "${marketplace}"; known: ${Object.keys(MARKETPLACES).join(', ')}`,
    )
  }
  // Cookies are scoped to the registrable domain, so `www.amazon.de` becomes
  // `.amazon.de` — setting them on the `www.` host would not apply to a request
  // that redirects to another subdomain.
  const bare = entry.domain.replace(/^www\./, '')
  return {
    code,
    domain: entry.domain,
    cookieDomain: `.${bare}`,
    request: entry.request,
    header: entry.header,
    currency: entry.currency,
    accept: entry.accept,
    country: entry.country,
    locationName: entry.locationName,
    locationAliases: entry.locationAliases ?? [],
    postalCode: entry.postalCode ?? null,
    cookies: [
      { name: 'lc-main', value: entry.request },
      { name: 'i18n-prefs', value: entry.currency },
    ],
  }
}

/** Ordered candidates per field. `attr` reads an attribute instead of text,
 * which is how the rating ("4.5 out of 5 stars" in a `title`) and the image
 * (a hi-res URL in `data-old-hires`) actually appear on the page.
 */
export const SELECTORS = {
  title: [
    { selector: '#productTitle' },
    { selector: '#title span' },
  ],
  brand: [
    { selector: '#bylineInfo' },
    { selector: '#brand' },
    { selector: 'a#bylineInfo_feature_div' },
  ],
  price: [
    { selector: '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen' },
    { selector: '#corePrice_feature_div .a-offscreen' },
    { selector: '#priceblock_ourprice' },
    { selector: '#priceblock_dealprice' },
    { selector: '#price_inside_buybox' },
    { selector: '#tp_price_block_total_price_ww .a-offscreen' },
    { selector: '.a-price .a-offscreen' },
  ],
  rating: [
    { selector: '#acrPopover', attr: 'title' },
    { selector: 'span[data-hook="rating-out-of-text"]' },
    { selector: '#averageCustomerReviews .a-icon-alt' },
  ],
  reviews: [
    { selector: '#acrCustomerReviewText' },
    { selector: 'span[data-hook="total-review-count"]' },
  ],
  image: [
    { selector: '#landingImage', attr: 'data-old-hires' },
    { selector: '#landingImage', attr: 'src' },
    { selector: '#imgTagWrapperId img', attr: 'src' },
  ],
  breadcrumb: [
    { selector: '#wayfinding-breadcrumbs_feature_div' },
  ],
  availability: [
    { selector: '#availability' },
  ],
}

/**
 * Containers that may hold the "Best Sellers Rank: #1,234 in Electronics" line.
 *
 * The rank is not a stable element, so it is read as text out of whichever
 * container this layout uses. Amazon serves at least three product layouts
 * (left-column detail bullets, a details table, and a tabbed "Product
 * information" panel), and not every listing carries a rank at all — verified
 * against a live accessory listing where the phrase appears nowhere on the page.
 *
 * That last point is why a missing rank is reported rather than treated as a
 * failure: "this product has no BSR" and "the selector broke" look identical
 * from here, and the caller is the one who can tell them apart.
 */
export const BSR_CONTAINERS = [
  '#detailBullets_feature_div',
  '#productDetails_detailBullets_sections1',
  '#productDetails_detailBullets_sections2',
  '#prodDetails',
  '#productDetails_feature_div',
  '#detailBulletsWrapper_feature_div',
  '#productDetails_db_sections',
]

/** Fields this extractor can fill, in the plugin's normalised vocabulary. */
export const AMAZON_FIELDS = [
  'title', 'brand', 'price', 'currency', 'bsr', 'category', 'rating', 'reviews', 'image_url',
]

/* ══════════════════ the thirteen collection sections (F04-07) ══════════════════

   Everything below is *Amazon's* half of contract §4.1: which part of the
   document each of the thirteen sections is read from, and how a literal read
   off the page becomes the field names the contract declares. The thirteen ids
   and their field lists are **not restated here** — `sectionReadingSpec()` is
   generated from `COLLECTION_SECTIONS`, and every parse branch is keyed by the
   id from that list. A section added to the vocabulary therefore shows up here
   as a declared-but-unread section (which a test pins) instead of silently
   disappearing from the page. */

/** One section's review list, capped (contract §4.1: 超出记 CAPPED). */
export const SECTION_REVIEW_ITEMS_LIMIT = 20
/** A+ modules, images, videos and related ASINs: bounded so one page cannot explode a row. */
export const SECTION_APLUS_MODULE_LIMIT = 12
export const SECTION_IMAGE_LIMIT = 12
export const SECTION_VIDEO_LIMIT = 8
export const SECTION_RELATED_ASIN_LIMIT = 20
export const SECTION_ATTRIBUTE_LIMIT = 80
export const SECTION_APLUS_TEXT_LIMIT = 2_000
/**
 * The longest single string the in-page reader reports.
 *
 * A *transport* bound, not the storage one: `collection_section_result` already
 * clips `raw_value_json` at 64 KB with a `TRUNCATED` marker, and that cap stays
 * where it is. This one exists because the value crosses a CDP
 * `Runtime.evaluate` boundary as JSON before the store ever sees it, and one
 * vendor-written A+ body of 300 KB would be paid for on every page read. A clip
 * is recorded as `CAPPED` in the row's errors, so a clipped reading never reads
 * as a complete one.
 */
export const SECTION_TEXT_LIMIT = 4_000

/**
 * The two containers the variant UI can live in.
 *
 * Named once and **referenced** by `SECTION_REGIONS.variations` below, because
 * the region list answers "where was this row read from" and `readVariations`
 * has to open the same container to read anything at all. Two copies of this
 * list is how the two halves of one fact start disagreeing — and that is the
 * shape of the defect this batch fixes: the reader only knew `#twister`, while
 * the region list had *already* been told about `#twister_feature_div`, so the
 * row recorded a region it never read.
 */
const VARIATION_CONTAINERS = ['#twister', '#twister_feature_div']

/**
 * The inline twister, i.e. the layout that has **no** `#twister` at all.
 *
 * Every modern listing names each dimension with a row id
 * (`#inline-twister-row-color_name`, `#inline-twister-row-size_name`, …) and
 * renders the current selection into
 * `#inline-twister-expanded-dimension-text-<key>`. The prefix is the only
 * spelling that covers every dimension: the ids are Amazon's, and which ones a
 * given product carries is a property of the product, not of a selector list.
 */
const VARIATION_DIMENSION_ROW_SELECTOR = '[id^="inline-twister-row-"]'
const VARIATION_DIMENSION_ROW_PREFIX = 'inline-twister-row-'

/**
 * The legacy twister's own evidence, kept exactly as it was.
 *
 * Document-scoped rather than container-scoped on purpose: `.a-form-label` is a
 * generic Amazon class, and searching the whole of `#twister_feature_div`
 * (measured at 264 KB on a live listing) for it would read unrelated form
 * labels as dimensions. Only the layout that is known to carry them is asked.
 */
const VARIATION_LEGACY_LABEL_SELECTOR = '#twister .a-form-label, #twister label'
const VARIATION_LEGACY_ANCHOR_SELECTOR = '#twister a[href*="/dp/"], #twister a[href*="asin="]'

/**
 * Where a variant tile puts the ASIN of the child it links to.
 *
 * Scoped to one dimension row rather than to the twister container, because the
 * container also holds "compare with other sellers" links whose ASINs are not
 * variants of this product.
 *
 * The first four spellings are the ones this file already treated as variant
 * identity: an href, and the `data-defaultasin` attribute the old twister stamps
 * on its tiles. **`data-asin` is the fifth, and it is the one the inline twister
 * actually uses** — measured on a live listing on 2026-10-10: the Color row held
 * `li` ×15 of which `li[data-asin]` ×12, the row's own `<a>` hrefs were all
 * `javascript:void(0);`, and the four spellings above matched **0** elements in
 * the whole `#twister_feature_div` while the reader stored `children: []`.
 *
 * A closed list of spellings is exactly what a page is free to outgrow, so the
 * reader no longer *only* matches this list: `VARIATION_TILE_ATTRIBUTE` below is
 * the open-ended half of the same question, and what it buys is that the next
 * rename lands in "tiles seen, nothing read" instead of in silence.
 */
const VARIATION_CHILD_SELECTOR = 'a[href*="/dp/"], a[href*="asin="], [data-defaultasin], input[name="asin"], [data-asin]'

/**
 * The open-ended half: "does this tile carry an ASIN **at all**?" — asked of the
 * attribute *name*, not of a fixed list of names.
 *
 * `VARIATION_CHILD_SELECTOR` can only match spellings somebody already wrote
 * down, and the defect this batch fixes is that the list had gone stale: 12
 * child ASINs sat on `li[data-asin]` while four legacy spellings matched
 * nothing, and the stored row said `partial 1/3` — which reads like "we got some
 * of it" and was in fact "we recognised none of the children".
 *
 * A substring probe cannot go stale the same way. Amazon's own word for the
 * identifier is "asin" in every spelling measured so far (`data-asin`,
 * `data-defaultasin`, `input[name="asin"]`, `a[href*="asin="]`), so a tile that
 * carries the child's ASIN under a name this file has never seen still counts as
 * a tile **we failed to read**, rather than disappearing from the reading.
 *
 * What it is *not*: a licence to guess. This probe never produces a child ASIN —
 * recognition stays the explicit five-spelling list above, so "we saw tiles and
 * read none of them" stays a distinguishable answer instead of being papered
 * over by reading whatever attribute happens to contain the word. It produces
 * the count of tiles we looked at, and nothing else.
 *
 * Stated limit, so it is not mistaken for more than it is: a rename that drops
 * the word `asin` entirely (`data-child-id`) is still silent. Counting the row's
 * `<li>` elements instead would cover that too, and was rejected because the
 * live row holds 15 `li` of which 3 are not variant tiles — the number would
 * then say something nobody measured.
 */
const VARIATION_TILE_ATTRIBUTE = 'asin'

/**
 * The variant vocabulary, in the one shape the page reader can be given it in.
 *
 * The reader is **stringified** (`buildScript`), so it cannot import anything —
 * it runs in a browser tab. Everything it needs travels as data: `selectors`,
 * `bsrContainers`, and the section spec. Retyping these literals inside the
 * function would be the second copy this file already refuses elsewhere; a
 * missing entry is a `failed` row, not a silent empty one, which is why the
 * reader throws when it is handed a spec without this.
 */
const VARIATION_SELECTORS = {
  containers: VARIATION_CONTAINERS,
  dimensionRowSelector: VARIATION_DIMENSION_ROW_SELECTOR,
  dimensionRowPrefix: VARIATION_DIMENSION_ROW_PREFIX,
  legacyLabelSelector: VARIATION_LEGACY_LABEL_SELECTOR,
  legacyAnchorSelector: VARIATION_LEGACY_ANCHOR_SELECTOR,
  childSelector: VARIATION_CHILD_SELECTOR,
  tileAttribute: VARIATION_TILE_ATTRIBUTE,
}

/**
 * The document region a section is read from.
 *
 * Ordered candidates, first match wins, same discipline as `SELECTORS`: the
 * matched one becomes the row's `page_region`, so "which layout did this come
 * from" is answerable after the fact instead of being guessed at.
 */
const SECTION_REGIONS = {
  basic: ['#dp-container', '#ppd', '#centerCol', '#dp'],
  bullets: ['#feature-bullets', '#featurebullets_feature_div'],
  images: ['#imageBlock', '#main-image-container', '#imageBlock_feature_div'],
  /* The inline row is a *region* candidate as well as a read source: a page
     whose twister container is not one of the two known ids still says, through
     the row it rendered, which part of the document the reading came from. The
     previous third candidate named one dimension (`…content-size_name`), so a
     product with only a Color row reported no region at all. */
  variations: [...VARIATION_CONTAINERS, VARIATION_DIMENSION_ROW_SELECTOR],
  attributes: [
    '#productDetails_techSpec_section_1', '#productOverview_feature_div',
    '#detailBullets_feature_div', '#productDetails_detailBullets_sections1', '#prodDetails',
  ],
  description: ['#productDescription', '#productDescription_feature_div', '#aplus'],
  aplus: ['#aplus', '#aplus_feature_div', '#aplus3p_feature_div'],
  video: ['#vse-related-videos', '#va-related-videos', '#videoBlock', '#videos_feature_div'],
  // The document itself is the "region" of the head metadata: there is no
  // container element for a `<meta>` tag, and inventing one would report a
  // region that does not exist.
  seo_meta: ['head', 'html'],
  bsr: BSR_CONTAINERS,
  reviews: ['#reviewsMedley', '#cm-cr-dp-review-list', '#reviews-summary', '#averageCustomerReviews'],
  page_signals: ['#availability', '#buybox', '#zeitgeistBadge_feature_div', '#dp-container'],
  related_competitors: [
    /* 2026-10-21 真机探针：这一页的关联位是 `[data-cel-widget^="CardInstance"]` 卡片，
       下面那四个旧容器在这类页面上全部不存在 —— 于是这一节长期记成 missing。
       CardInstance 是 Amazon 商品卡容器前缀，比具体 id 稳定。 */
    '[data-cel-widget^="CardInstance"]', '[cel_widget_id^="CardInstance"]', '[id^="CardInstance"]',
    '#similarities_feature_div', '#sp_detail', '#sp_detail_thematic', '#anonCarousel',
  ],
}

/**
 * A candidate is written as either a bare selector or `{selector, attr}`, and
 * both mean the same thing to the reader. Normalising **here**, once, is what
 * stops the two spellings from becoming two behaviours: a bare string handed to
 * the attribute-aware reader would read `entry.attr` as `undefined` and
 * `entry.selector` as `undefined`, i.e. `querySelector("undefined")`, which
 * matches nothing and reports "the page has no such field" — a silent empty.
 */
function toEntry(candidate) {
  return typeof candidate === 'string' ? { selector: candidate } : candidate
}

/**
 * The literal reads per section: `key → ordered candidate selectors`.
 *
 * These keys are **page literals** (`priceText`, `imageUrls`), not the declared
 * field names — exactly like `fields.priceText` beside `field.price` in the
 * nine-field path. `parseSectionReading` is what turns them into declared
 * fields, and a test drives a maximal page through every parser and asserts the
 * declared key set comes out the other side.
 *
 * Where a literal is the same fact as one of the nine fields, the *same* entry
 * list is referenced rather than retyped (`SELECTORS.title`): two tables for one
 * selector is how the section reading and the stored field start disagreeing.
 */
const SECTION_READS = {
  basic: {
    scalars: {
      title: SELECTORS.title,
      brand: SELECTORS.brand,
      priceText: SELECTORS.price,
      ratingText: SELECTORS.rating,
      reviewsText: SELECTORS.reviews,
      availability: SELECTORS.availability,
      selectedColor: [
        '#variation_color_name .selection', '#inline-twister-expanded-dimension-text-color_name',
        '#variation_color_name span.selection',
      ],
      selectedSize: [
        '#variation_size_name .selection', '#inline-twister-expanded-dimension-text-size_name',
        '#variation_size_name span.selection',
      ],
    },
  },
  bullets: {
    lists: {
      bulletTexts: { selector: '#feature-bullets li span.a-list-item', limit: 5 },
    },
  },
  images: {
    scalars: { mainImage: SELECTORS.image },
    lists: {
      imageUrls: { selector: '#altImages li img', attr: 'src', limit: SECTION_IMAGE_LIMIT },
    },
  },
  variations: { kind: 'variations', variantSelectors: VARIATION_SELECTORS },
  attributes: { kind: 'attributes' },
  description: {
    scalars: { descriptionText: ['#productDescription', '#productDescription_feature_div'] },
    lists: {
      itemHighlights: { selector: '#productFactsDesktopExpander li', limit: 12 },
    },
  },
  aplus: { kind: 'aplus' },
  video: {
    lists: {
      videoUrls: {
        selector: 'video source, video, [data-video-url]',
        attrs: ['src', 'data-video-url'],
        limit: SECTION_VIDEO_LIMIT,
      },
      videoThumbnails: {
        selector: '#vse-related-videos img, #va-related-videos img',
        attr: 'src', limit: SECTION_VIDEO_LIMIT,
      },
    },
  },
  seo_meta: { kind: 'seo' },
  bsr: { kind: 'bsr' },
  reviews: {
    kind: 'reviews',
    /* The total is the same fact as `basic.reviews_count`, so it is the same
       entry list — retyping the selector is how two sections start reporting two
       different totals for one page. */
    scalars: { reviewsTotal: SELECTORS.reviews },
  },
  page_signals: {
    scalars: { availabilityText: SELECTORS.availability },
    lists: {
      badgeTexts: {
        selector: '#zeitgeistBadge_feature_div, #dealBadge, #acBadge_feature_div, #acBadge_feature_div img',
        limit: 12,
      },
      returnPolicyTexts: {
        /* `#creturns-policy-anchor-text` is the returns line the buy box renders
           on the layouts measured on 2026-10-09 ("FREE Returns"); the four ids
           before it are the *policy block* containers, and a live listing had
           none of them, so `return_policy` was stored as null — a false negative
           that reads exactly like "Amazon publishes no returns policy". */
        selector: '#RETURNS_POLICY, #returnsInfoBlock, #returnPolicyFeature_div, #icon-fma_return_policy, '
          + '#creturns-policy-anchor-text',
        limit: 4,
      },
      riskTexts: {
        selector: '#availability, #outOfStock, #exports_desktop_qualifiedBuyBox_buyNowButton, #buybox',
        limit: 8,
      },
    },
  },
  related_competitors: {
    lists: {
      relatedHrefs: {
        /* 2026-10-21 真机探针：这一页的三组关联卡是 `[data-cel-widget^="CardInstance"]`，
           下面的旧容器全部不命中，于是这一节长期记成 missing。新容器排在前面。
           ⚠️ 这条选择器**分不出广告位** —— 其中一组（Similar brands on Amazon）是 sponsored。
           分组与"未经验证"的标注放在 Node 侧的 parseSectionReading 里做，
           因为页面脚本是 toString() 后 eval 的，模块级常量在那里不存在。 */
        selector: '[data-cel-widget^="CardInstance"] a[href*="/dp/"], '
          + '[cel_widget_id^="CardInstance"] a[href*="/dp/"], [id^="CardInstance"] a[href*="/dp/"], '
          + '#similarities_feature_div a[href*="/dp/"], #sp_detail a[href*="/dp/"], '
          + '#sp_detail_thematic a[href*="/dp/"], #anonCarousel a[href*="/dp/"]',
        attr: 'href',
        // Two hrefs out of one card (the image and the title) are one competitor;
        // the ASINs are deduplicated in the parser, so reading more than the
        // declared ceiling is what keeps a page of 20 cards from yielding 10.
        limit: SECTION_RELATED_ASIN_LIMIT * 2,
      },
    },
  },
}

/**
 * The spec the in-page reader runs on: the thirteen sections in contract order.
 *
 * `kind` selects the reader for the sections the flat scalar/list reader cannot
 * express (`attributes`, `aplus`, `variations`, `reviews`, `seo`, `bsr`). Every
 * candidate is normalised to `{selector, attr?}` here, so the page never has to
 * know about the two spellings.
 */
export function sectionReadingSpec({ bsrContainers = BSR_CONTAINERS } = {}) {
  const normalize = (candidates) => (Array.isArray(candidates) ? candidates.map(toEntry) : [])
  return COLLECTION_SECTIONS.map((section) => {
    const reads = SECTION_READS[section.id] ?? {}
    const scalars = reads.scalars ?? {}
    const lists = reads.lists ?? {}
    return {
      id: section.id,
      order: section.order,
      kind: reads.kind ?? 'fields',
      region: section.id === 'bsr' ? bsrContainers : (SECTION_REGIONS[section.id] ?? []),
      /* `variations` reads two different twister layouts, and the selectors that
         say which is which cannot be imported by the stringified reader — so
         they ride in the spec, exactly like `region` and `selectors` do. */
      variantSelectors: reads.variantSelectors,
      scalars: Object.fromEntries(Object.entries(scalars).map(([key, value]) => [key, normalize(value)])),
      lists,
      limits: {
        attributes: SECTION_ATTRIBUTE_LIMIT,
        aplusModules: SECTION_APLUS_MODULE_LIMIT,
        aplusText: SECTION_APLUS_TEXT_LIMIT,
        reviewItems: SECTION_REVIEW_ITEMS_LIMIT,
        text: SECTION_TEXT_LIMIT,
      },
    }
  })
}

/**
 * The ids this extractor has a reader for.
 *
 * Compared against the vocabulary by a test: a section that reaches
 * `COLLECTION_SECTIONS` without an Amazon reader is a hole in the page reading,
 * and the row it would produce (`failed` / `NOT_READ`) is the honest report of
 * it. `kind: 'fields'` with no scalars and no lists counts as no reader.
 */
export const SECTION_READER_IDS = COLLECTION_SECTIONS
  .map(section => section.id)
  .filter((id) => {
    const reads = SECTION_READS[id]
    if (reads === undefined) return false
    if (reads.kind !== undefined) return true
    return Object.keys(reads.scalars ?? {}).length > 0 || Object.keys(reads.lists ?? {}).length > 0
  })

/* ── how a page literal becomes a declared field ───────────────────────────── */

/**
 * Attribute labels are free text on the page ("Item Weight", "Material"), and
 * the declared vocabulary is a prefix (`attribute.*`) precisely because the set
 * is dynamic. The label is therefore slugged into the key rather than mapped
 * through a second table: a mapping table would be a third vocabulary that goes
 * stale the first time Amazon renames a row, and the coverage question this
 * section answers ("how many declared attribute fields came back filled") is
 * answered by the prefix either way.
 */
export function attributeKeyFor(label) {
  const slug = clean(label)
  if (slug === null) return null
  /* 少数页面上差一两个词的写法，slug 之后对不上声明 id（Style Name vs style、
     Age Range Description vs age_range）。收进显式别名表，而不是把 slug 改成模糊匹配 ——
     模糊匹配会把 "Brand Name" 和 "Brand" 变成两条，还会把不相干的标签撞在一起。
     表里每一条都由测试证明目标 id 真的在 43 项里。 */
  const normalized = String(slug).toLowerCase().replace(/\s+/g, ' ').trim()
  if (NON_ATTRIBUTE_LABELS.has(normalized)) return null
  const aliased = ATTRIBUTE_LABEL_ALIASES[normalized]
  if (aliased !== undefined) return `${ATTRIBUTE_FIELD_PREFIX}${aliased}`
  const key = normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return key === '' ? null : `${ATTRIBUTE_FIELD_PREFIX}${key}`
}

/**
 * 页面标签 → 43 项声明 id 的**别名**。
 *
 * 判据：只收「slug 之后差一两个词、但语义完全等同」的写法。
 * 不做同义词扩展（Material vs Fabric vs Cover Material 是三个不同的东西），
 * 因为一旦开始猜语义，这张表就变成了第三本词表，而它没有事实来源。
 */
export const ATTRIBUTE_LABEL_ALIASES = {
  'style name': 'style',
  'age range description': 'age_range',
  'product care instructions': 'care_instructions',
  'other special features of the product': 'special_feature',
  'brand name': 'brand',
  'item firmness description': 'item_firmness',
  'item dimensions lxwxh': 'product_dimensions',
  'fabric care instructions': 'fabric_care',
  'item shape': 'shape',
  'recommended uses for product': 'recommended_uses',
}

/**
 * 不是属性的行 —— 把它们当属性会污染这一节。
 *
 * `#prodDetails` 那张表里混着 ASIN / Best Sellers Rank / Customer Reviews / Image，
 * 它们是**页面元信息**，不是商品规格：BSR 有自己的节（bsr），评论有自己的节（reviews），
 * ASIN 是主键本身。留在属性里会让「属性条数」看起来更多，而每一条都是假的增量。
 */
export const NON_ATTRIBUTE_LABELS = new Set([
  'asin',
  'best sellers rank',
  'customer reviews',
  'image',
  'date first available',
  'department',
])

/** Risk wording that changes the decision a listing supports. Matched case-insensitively. */
const RISK_PATTERNS = [
  /currently unavailable/i,
  /temporarily out of stock/i,
  /only \d+ left in stock/i,
  /no featured offers/i,
  /cannot be shipped to/i,
]

/** `/dp/B0C4X2K9LM` or `?asin=B0C4X2K9LM` → the ASIN, for the related-competitors list. */
function asinFromHref(href) {
  const text = String(href ?? '')
  const dp = text.match(/\/dp\/([A-Za-z0-9]{10})(?:[/?#]|$)/)
  if (dp !== null) return dp[1].toUpperCase()
  const query = text.match(/[?&]asin=([A-Za-z0-9]{10})(?:[&#]|$)/)
  return query === null ? null : query[1].toUpperCase()
}

function uniqueStrings(values) {
  const out = []
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (!out.includes(value)) out.push(value)
  }
  return out
}

function positiveInteger(value) {
  const text = clean(value)
  if (text === null) return null
  const match = text.match(/\d[\d,.\s]*/)
  if (match === null) return null
  const number = Number(match[0].replace(/[,.\s]/g, ''))
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null
}

/**
 * One section's declared field values, from the literals the page returned.
 *
 * Returns every declared key, `null` included: the stored `parsed_value_json`
 * then says "here are the eleven fields and which of them we got" instead of
 * silently omitting the ones that did not come back — omission is what makes a
 * one-field payload look like a complete reading. `null` and "key absent" are
 * the same fact to `sectionValueCounts` on purpose (`hasValue`), so an omitted
 * key and a null one are not two different truths; what the explicit null buys
 * is a payload a human can read.
 *
 * Returns `null` for an id that is not one of the thirteen — the caller turns
 * that into a `failed` row rather than into an invented one.
 */
export function parseSectionReading(sectionId, values = {}, context = {}) {
  const target = context.target ?? {}
  const url = context.url ?? null
  const marketplace = target.marketplace

  switch (sectionId) {
    case 'basic': {
      const priceText = values.priceText
      return {
        asin: target.asin ?? null,
        url,
        title: clean(values.title),
        brand: cleanBrand(values.brand),
        price: parseDecimal(priceText, marketplace),
        currency: currencyFor(priceText, marketplace),
        availability: clean(values.availability),
        rating: clampRating(parseDecimal(values.ratingText)),
        reviews_count: parseInt10(values.reviewsText),
        selected_color: clean(values.selectedColor),
        selected_size: clean(values.selectedSize),
      }
    }
    case 'bullets': {
      const texts = Array.isArray(values.bulletTexts) ? values.bulletTexts : []
      const out = {}
      for (let index = 0; index < 5; index += 1) out[`bullet_${index + 1}`] = clean(texts[index]) ?? null
      return out
    }
    case 'images': {
      const urls = uniqueStrings((Array.isArray(values.imageUrls) ? values.imageUrls : [])
        .map(candidate => absoluteUrl(candidate, url)))
      const main = absoluteUrl(values.mainImage, url)
      if (main !== null && !urls.includes(main)) urls.unshift(main)
      return {
        main_image: main ?? urls[0] ?? null,
        // `0` would count as a value ("we found zero images"), which is a claim
        // about the page nobody made. Absence is null.
        image_count: urls.length > 0 ? urls.length : null,
        images: urls,
      }
    }
    case 'variations': {
      /* Both spellings are accepted because both are honest readings: the page
         hands over hrefs (identity parsing belongs on this side), while a caller
         that already knows the children may hand over ASINs directly. */
      const children = []
      const direct = Array.isArray(values.children) ? values.children : []
      const hrefs = Array.isArray(values.childHrefs) ? values.childHrefs : []
      /* The page's own ASIN is not one of its children.
         Measured 2026-10-10: the Color row carried 12 `li[data-asin]`, and one of
         them is `B0BRKPVZB4` — the listing being read. A variant tile for the
         option you are already looking at carries the current ASIN, so keeping it
         would store "this product is a variant of itself", inflate every child
         count by one, and make a 1-child listing look like a 2-child one.
         `target.asin` is the authority rather than a value scraped back out of
         the DOM: it is the ASIN we *asked* for, so a redirect to a different
         variant cannot silently change whose children these are. */
      const asked = target.asin === undefined || target.asin === null ? '' : String(target.asin).trim().toUpperCase()
      const self = asked === '' ? null : asked
      for (const candidate of [...direct, ...hrefs]) {
        const asin = /^[A-Za-z0-9]{10}$/.test(String(candidate).trim())
          ? String(candidate).trim().toUpperCase()
          : asinFromHref(candidate)
        if (asin === null || asin === self) continue
        if (!children.includes(asin)) children.push(asin)
      }
      const dimensions = Array.isArray(values.variationDimensions) ? values.variationDimensions : []
      return {
        parent_asin: clean(values.parentAsin),
        variation_dimensions: uniqueStrings(dimensions.map(entry => clean(entry))),
        children,
        /* **Not** a declared field of the section, and deliberately so: it is not
           something we collected about the product, it is the probe that says
           which of the two things an empty `children` is. `sectionValueCounts`
           therefore ignores it (coverage stays 3 declared fields), while the
           five-state rule and `auditStoredSectionResult` read it — see
           `variationsChildrenUnread` in `domain/collect/section-reading.js`.
           `0` is kept as a number rather than nulled the way `image_count` is:
           here zero *is* the measurement ("we looked, there were no tiles"),
           and the difference from "not measured" is carried by the key being
           absent (`null`) for a reader that never reported it. */
        child_tiles: Number.isFinite(values.childTiles) ? values.childTiles : null,
      }
    }
    case 'attributes': {
      const pairs = values.attributes ?? {}
      const out = {}
      for (const [label, value] of Object.entries(pairs)) {
        const key = attributeKeyFor(label)
        const text = clean(value)
        if (key === null || text === null) continue
        // A page that repeats a label (two "Material" rows) keeps the first:
        // last-write-wins would make the order of <tr> decide the answer.
        if (out[key] === undefined) out[key] = text
      }
      return out
    }
    case 'description': {
      const highlights = uniqueStrings((Array.isArray(values.itemHighlights) ? values.itemHighlights : [])
        .map(entry => clean(entry)))
      return {
        description: clean(values.descriptionText),
        item_highlights: highlights,
      }
    }
    case 'aplus': {
      const modules = (Array.isArray(values.modules) ? values.modules : [])
        .slice(0, SECTION_APLUS_MODULE_LIMIT)
        /* A wrapper element with neither copy nor image is not a module; keeping
           it would make `modules` non-empty and the section look collected on a
           page whose A+ body is an empty shell. */
        .filter(module => clean(module?.text) !== null || (Array.isArray(module?.images) && module.images.some(image => clean(image) !== null)))
      return { modules }
    }
    case 'video': {
      const urls = uniqueStrings(Array.isArray(values.videoUrls) ? values.videoUrls : [])
      const thumbnails = Array.isArray(values.videoThumbnails) ? values.videoThumbnails : []
      return {
        videos: urls.slice(0, SECTION_VIDEO_LIMIT).map((videoUrl, index) => ({
          position: index + 1,
          url: videoUrl,
          thumbnail: thumbnails[index] ?? null,
        })),
      }
    }
    case 'seo_meta': {
      return {
        page_title: clean(values.pageTitle),
        meta_description: clean(values.metaDescription),
        canonical_url: absoluteUrl(values.canonicalUrl, url),
        // Amazon's storefront does not publish the backend search terms; the
        // reader reports null rather than inventing the title or the URL here.
        // The consequence is stated rather than hidden: `seo_meta` can only be
        // `collected` when this fourth field has a value, so today it tops out
        // at `partial` on a real page.
        search_terms: clean(values.searchTerms),
      }
    }
    case 'bsr': {
      const ranks = Array.isArray(values.bsrRanks) ? values.bsrRanks : []
      const first = ranks.length > 0 ? ranks[0] : null
      return {
        bsr: first === null ? parseInt10(values.bsrText) : first.rank,
        category: first === null ? clean(values.bsrCategory) : clean(first.category),
        subcategory_ranks: ranks,
      }
    }
    case 'reviews': {
      const items = (Array.isArray(values.reviewItems) ? values.reviewItems : [])
        .slice(0, SECTION_REVIEW_ITEMS_LIMIT)
        /* Same trap as `aplus.modules`, one level down: an array is "non-empty"
           to `hasValue` whatever it holds, so a review block with no rating, no
           title and no body would count as a collected review. */
        .filter(item => clean(item?.rating) !== null || clean(item?.title) !== null || clean(item?.text) !== null)
      return {
        reviews_total: parseInt10(values.reviewsTotal),
        reviews_visible: positiveInteger(values.reviewsVisible),
        review_summary: clean(values.reviewSummary),
        review_items: items,
      }
    }
    case 'page_signals': {
      const riskTexts = Array.isArray(values.riskTexts) ? values.riskTexts : []
      const riskSignals = []
      for (const text of riskTexts) {
        const candidate = clean(text)
        if (candidate === null) continue
        if (RISK_PATTERNS.some(pattern => pattern.test(candidate)) && !riskSignals.includes(candidate)) {
          riskSignals.push(candidate)
        }
      }
      const policies = Array.isArray(values.returnPolicyTexts) ? values.returnPolicyTexts : []
      return {
        badges: uniqueStrings((Array.isArray(values.badgeTexts) ? values.badgeTexts : []).map(entry => clean(entry))),
        availability: clean(values.availabilityText),
        return_policy: clean(policies[0]) ?? null,
        risk_signals: riskSignals,
      }
    }
    case 'related_competitors': {
      const hrefs = Array.isArray(values.relatedHrefs) ? values.relatedHrefs : []
      const asins = []
      for (const href of hrefs) {
        const asin = asinFromHref(href)
        if (asin !== null && !asins.includes(asin)) asins.push(asin)
      }
      /* ⚠️ 这里**故意**只给一个 `unknown` 组，不假装能分辨广告位。
       *
       * 页面脚本是 `toString()` 后 eval 的（buildScript，第 1012 行），模块级常量
       * 在那里不存在；要按卡片分组就得在浏览器作用域里写 DOM 遍历，那正是 2026-10-21
       * 连续四次翻车的地方（见 docs/DESIGN-listing-optimize-2026-10-21.md）。
       * 所以分组留在 Node 侧做，并且诚实地只声明一件事：
       *
       *   "这些 ASIN 来自页面的关联卡，但我们**没有**验证过哪一组是广告。"
       *
       * 下游要把它们建成竞品组时，必须让人确认 —— 而不是把付费展位当成抢词的对手。 */
      return {
        related_asins: asins.slice(0, SECTION_RELATED_ASIN_LIMIT),
        groups: asins.length === 0
          ? []
          : [{ kind: 'unknown', source: 'page-carousel', verified: false, asins: asins.slice(0, SECTION_RELATED_ASIN_LIMIT) }],
      }
    }
    default:
      // Not one of the thirteen. The caller reports `NOT_READ` rather than
      // storing a section nobody declares.
      return null
  }
}

/**
 * One section's reading, in the shape `buildSectionRecords` consumes.
 *
 * The two layers are kept apart on purpose: `rawValue` is what the page said
 * (the literals, capped for transport), `parsedValue` is what the parser made of
 * it. Collapsing them — the obvious shortcut — makes "what did the listing
 * actually say" unanswerable after the first parse, which is the same reason the
 * store keeps two columns.
 *
 * A section the reader reported with an `error` (its own reader threw in the
 * page) keeps that message and a **null** parsed value, so the domain layer
 * derives `failed` — "we did not find out" — rather than `missing`.
 */
function buildSectionReading(sectionId, entry, page, target) {
  const values = {
    ...(entry.scalars ?? {}),
    ...(entry.lists ?? {}),
    ...(entry.structured ?? {}),
  }
  const errors = (Array.isArray(entry.capped) ? entry.capped : [])
    .map(detail => ({ code: 'CAPPED', detail: String(detail) }))
  const parsedValue = parseSectionReading(sectionId, values, { target, url: page?.url ?? null })
  const base = {
    pageRegion: entry.region ?? null,
    rawValue: entry,
    selectorHits: entry.hits ?? null,
    errors,
  }
  if (parsedValue === null) {
    return { ...base, parsedValue: null, error: `没有 ${sectionId} 的解析器` }
  }
  return { ...base, parsedValue, error: entry.error === undefined ? null : entry.error }
}

export function urlFor({ asin, marketplace }) {
  const storefront = storefrontFor(marketplace)
  const id = String(asin ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(id)) throw new Error(`invalid ASIN "${asin}" (expected 10 letters/digits)`)
  // th=1&psc=1 pins the page to the single-variant view, which keeps the price
  // and buy-box selectors the same across listings that have variations.
  // `language` is the third belt: the cookie and the header already ask for the
  // storefront's own language, and this makes the request say so too.
  return `https://${storefront.domain}/dp/${id}?th=1&psc=1&language=${storefront.request}`
}

export const amazonProduct = {
  id: 'amazon-product',
  label: '亚马逊前台商品页',
  fields: AMAZON_FIELDS,
  urlFor,
  storefrontFor,

  /** Build the IIFE that runs inside the page. */
  buildScript({ waitMs = 9_000 } = {}) {
    return `(${pageScript.toString()})(${JSON.stringify({
      waitMs,
      selectors: SELECTORS,
      bsrContainers: BSR_CONTAINERS,
      /* The thirteen sections' read spec rides along with the field selectors:
         the in-page reader cannot import `COLLECTION_SECTIONS`, so the one
         vocabulary is handed to it as data rather than retyped inside the
         stringified function. */
      sections: sectionReadingSpec(),
    })})`
  },

  /**
   * The thirteen sections' readings, in the shape `buildSectionRecords` takes.
   *
   * Returns `null` when the page carried no section reading at all (a page
   * verdict of `blocked` / `notfound`, or an in-page crash): "we read nothing"
   * must not be dressed up as thirteen empty readings, because those would
   * become thirteen `missing` rows claiming Amazon has none of it.
   *
   * A section the reader did not report is left out of the map on purpose — the
   * domain layer turns an absent key into `failed` / `NOT_READ`, which is a hole
   * in our reading, not a statement about the page.
   */
  sections(pageResult, target) {
    const read = pageResult?.sections
    if (read === null || read === undefined || typeof read !== 'object') return null
    const out = {}
    for (const section of COLLECTION_SECTIONS) {
      const entry = read[section.id]
      if (entry === null || entry === undefined) continue
      out[section.id] = buildSectionReading(section.id, entry, pageResult, target)
    }
    return out
  },

  /** Turn the page's raw answer into stored field values. */
  normalize(pageResult, { marketplace }) {
    return normalizePageResult(pageResult, marketplace)
  },
}

/**
 * Check that the page that came back is the one that was asked for.
 *
 * This is the guard that makes "avoid mixing up marketplaces" real rather than
 * aspirational. Setting the cookies is a request; this verifies the response.
 * Several things can go wrong and all of them produce plausible-looking data:
 *
 *   - the request landed on a **different storefront** (a redirect, or a
 *     `www.`/regional variant) — a different marketplace's listing entirely
 *   - the page rendered in the **wrong language** — the title is then the
 *     localised variant, so optimising against it optimises text that is not
 *     live there
 *   - the price came back in the **wrong currency** — the number is then
 *     meaningless, and worse, it looks fine in a table
 *   - the **delivery location** is a third country, which changes shipping,
 *     availability, and the price before the currency cookie is applied
 *
 * ## Why the problems carry a severity
 *
 * Not every signal is equally trustworthy, and treating them as equal would
 * either let bad data through or reject good data:
 *
 *   - `blocking` — the storefront host, the language **cookie**, and the
 *     currency. Each is either what Amazon itself reads or a value we set
 *     ourselves, so a mismatch means the page really is not the page asked for.
 *   - `advisory` — `document.documentElement.lang` and the delivery location.
 *     The DOM language was measured answering `en-gb` on a German storefront,
 *     so rejecting on it alone would refuse pages that are perfectly fine; and
 *     the delivery location cannot be forged, only clicked, so failing to
 *     change it is not a reason to throw away an otherwise correct page.
 *
 * `ok` is true when nothing blocking was found. Everything is still reported.
 */
export function verifyStorefront(pageResult, target, { strict = true } = {}) {
  const storefront = storefrontFor(target.marketplace)
  const problems = []
  const add = (code, severity, detail) => problems.push({ code, severity, detail })

  const landedHost = hostOf(pageResult?.url)
  if (landedHost === null) {
    add('no-url', 'blocking', '页面没有报告最终地址，无法确认站点')
  } else if (!sameHost(landedHost, storefront.domain)) {
    add('wrong-storefront', 'blocking', `落在 ${landedHost}，但 ${storefront.code} 应该是 ${storefront.domain}`)
  }

  // The reliable language signal. Absent is not the same as wrong: a first
  // visit has no cookie yet, and there is nothing to compare in that case.
  const cookie = parseLangCookie(pageResult?.langCookie)
  if (cookie !== null && !storefront.accept.includes(cookie.primary)) {
    add('wrong-lang-cookie', 'blocking',
      `语言 cookie ${cookie.name}=${cookie.value} 是 ${cookie.primary}，${storefront.code} 期望 ${storefront.accept.join(' / ')}`)
  }

  const lang = String(pageResult?.lang ?? '').trim().toLowerCase()
  if (lang !== '') {
    const primary = lang.split(/[-_]/)[0]
    if (!storefront.accept.includes(primary)) {
      add('wrong-language', 'advisory',
        `页面报告的语言是 ${lang}，${storefront.code} 期望 ${storefront.accept.join(' / ')}`)
    }
  }

  const currency = pageResult?.fields?.currency
  if (currency !== null && currency !== undefined && String(currency).toUpperCase() !== storefront.currency) {
    add('wrong-currency', 'blocking', `价格币种是 ${currency}，${storefront.code} 应该是 ${storefront.currency}`)
  }

  const location = pageResult?.deliveryLocation
  if (String(location ?? '').trim() !== '' && !locationMatches(location, storefront)) {
    add('wrong-location', 'advisory',
      `配送地址是 ${String(location).trim()}，${storefront.code} 期望 ${storefront.locationName}`)
  }

  const blocking = problems.filter(problem => problem.severity === 'blocking')
  return { ok: blocking.length === 0, storefront, problems, blocking, strict }
}

/**
 * Does the delivery location look like the target country?
 *
 * The line Amazon renders has two shapes, and which one you get depends on the
 * storefront's own convention — both measured live:
 *
 *   - `"China"` — a country-level default, derived from the request IP
 *   - `"10115 Berlin"` (amazon.de) — postal code first
 *   - `"New York 10001"` (amazon.com) — city first
 *
 * So the **postal code** is the stronger signal, and it is the value this
 * plugin sets. It is looked for anywhere in the de-spaced, upper-cased line,
 * with the characters either side required to not be digits — otherwise the
 * Australian code `2000` would match a `20001 Sydney` line.
 *
 * The country name is the fallback. Amazon renders it in the interface
 * language, so every spelling we know is accepted — "Germany", "Deutschland"
 * and "Alemania" are the same answer. Short names ("US", "UK", "UAE") are
 * matched **exactly**, because a substring test on two letters is how
 * "a**us**tralia" ends up counting as the United States.
 */
export function locationMatches(location, storefront) {
  const text = String(location ?? '').trim()
  if (text === '') return true

  const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const postal = String(storefront.postalCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (postal !== '' && containsToken(compact, postal)) return true

  const lower = text.toLowerCase()
  const names = [storefront.locationName, ...(storefront.locationAliases ?? [])].filter(Boolean)
  return names.some((name) => {
    const candidate = String(name).toLowerCase()
    return candidate.length <= 3 ? lower === candidate : lower.includes(candidate)
  })
}

/** Is `token` in `text` without being part of a longer run of digits? */
function containsToken(text, token) {
  let index = text.indexOf(token)
  while (index >= 0) {
    const before = index === 0 ? '' : text.charAt(index - 1)
    const after = text.charAt(index + token.length)
    if (!/[0-9]/.test(before) && !/[0-9]/.test(after)) return true
    index = text.indexOf(token, index + 1)
  }
  return false
}

/** `"lc-acbde=en_GB"` → `{ name, value, primary: 'en' }`. `lc-main` is ignored. */
function parseLangCookie(raw) {
  const text = String(raw ?? '').trim()
  const separator = text.indexOf('=')
  if (separator < 1) return null
  const name = text.slice(0, separator)
  const value = text.slice(separator + 1).trim()
  if (!/^lc-/.test(name) || name === 'lc-main' || value === '') return null
  const primary = value.split(/[-_]/)[0].toLowerCase()
  return primary === '' ? null : { name, value, primary }
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** `amazon.de` and `www.amazon.de` are the same storefront. */
function sameHost(actual, expected) {
  const strip = (value) => value.replace(/^www\./, '')
  return strip(actual) === strip(expected)
}

/* ──────────────────────────── the in-page script ─────────────────────────── */

/**
 * Runs in the page. Must be self-contained: it is stringified and evaluated in
 * the browser, so it can close over nothing from this module. Everything it
 * needs arrives in `options`.
 *
 * It waits, inside the page, for the product title or a recognisable
 * blocked/404 page to appear — Amazon renders the buy box after the initial
 * HTML, so reading immediately would collect a title and nothing else.
 */
function pageScript(options) {
  const { waitMs, selectors, bsrContainers, sections: sectionSpecs } = options

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const BLOCK_TEXT = [
    'Enter the characters you see below',
    'Sorry, we just need to make sure you\'re not a robot',
    'Type the characters you see in this image',
    'To discuss automated access to Amazon data please contact',
    'Your request is being blocked',
  ]
  const NOT_FOUND_TEXT = [
    'We\'re sorry. The Web address you entered is not a functioning page on our site',
    'Looking for something? We\'re sorry',
  ]

  function readOne(entry) {
    const element = document.querySelector(entry.selector)
    if (element === null) return null
    // `elementText`, not `textContent`: the nine fields are read off the same
    // elements the thirteen sections are, and on a live listing `#availability`
    // carries its own `a-state` script inside it.
    const value = entry.attr ? element.getAttribute(entry.attr) : elementText(element)
    const trimmed = value === null || value === undefined ? '' : String(value).trim()
    return trimmed === '' ? null : trimmed
  }

  /** First candidate that yields something, plus which one it was. */
  function readField(entries) {
    for (const entry of entries) {
      const value = readOne(entry)
      if (value !== null) {
        return { value, selector: entry.attr ? `${entry.selector}[${entry.attr}]` : entry.selector }
      }
    }
    return { value: null, selector: null }
  }

  function detectBlock() {
    const bodyText = (document.body ? document.body.innerText : '').slice(0, 6_000)
    if (location.pathname.indexOf('validateCaptcha') >= 0) return 'CAPTCHA 页面（URL）'
    if (document.querySelector('#captchacharacters') !== null) return 'CAPTCHA 表单（#captchacharacters）'
    if (document.querySelector('form[action*="validateCaptcha"]') !== null) return 'CAPTCHA 表单（form[action*=validateCaptcha]）'
    if (/robot check/i.test(document.title)) return `页面标题为 "${document.title}"`
    for (const marker of BLOCK_TEXT) {
      if (bodyText.indexOf(marker) >= 0) return `页面出现风控文案: "${marker}"`
    }
    return null
  }

  function detectNotFound() {
    const bodyText = (document.body ? document.body.innerText : '').slice(0, 6_000)
    if (/page not found/i.test(document.title)) return '页面标题为 Page Not Found'
    for (const marker of NOT_FOUND_TEXT) {
      if (bodyText.indexOf(marker) >= 0) return '亚马逊 404 文案'
    }
    // A search-results page means the ASIN was redirected away from /dp/.
    if (document.querySelector('#dp') === null && document.querySelector('#search') !== null) {
      return '被重定向到搜索结果页'
    }
    return null
  }

  /**
   * Find the line that carries the Best Sellers Rank, scoped to a single row.
   *
   * Scoping is what makes this work. `textContent` has no separators, so reading
   * a whole panel runs the next row's label straight into the category name —
   * "Portable Bluetooth Speakers Customer Reviews 4.5 out of 5 stars". Anchoring
   * on the element whose own text starts with the phrase, then widening to its
   * row, gives a bounded string containing exactly the ranks.
   *
   * The phrase is looked for rather than a fixed selector because the rank moves
   * between layouts: a left-column bullet list, a details table, and a tabbed
   * panel all carry it differently, and on the tabbed one it is inside a
   * collapsed section.
   */
  function findRankLine(container) {
    const candidates = container.querySelectorAll('th, td, span, div, li, dt')
    for (const element of candidates) {
      const own = (element.textContent || '').trim()
      if (own.indexOf('Best Sellers Rank') !== 0) continue
      const row = element.closest('tr') || element.closest('li') || element.parentElement || element
      return (row.textContent || '').replace(/\s+/g, ' ').trim()
    }
    return null
  }

  /* ── the thirteen sections (F04-07) ──────────────────────────────────────
      Each section is read into **literals**, not into declared field names: the
      mapping from `priceText` to `price` happens in `parseSectionReading` on the
      Node side, exactly as the nine-field path goes through
      `normalizePageResult`. Keeping the two steps apart is what lets the doctor
      show the raw reading and the store hold the parsed one. */

  /**
   * The text of an element: what the page *says*, without the payload it ships
   * inside the same element.
   *
   * `textContent` includes `<script>` bodies, and Amazon puts machine state
   * inside exactly the elements this reader stores as copy. Measured on a live
   * listing on 2026-10-09:
   *
   *   · `#availability` is `<span> In Stock </span><script type="a-state">{…}</script>`,
   *     and `textContent` stored `In Stock {"isInternal":false,…}` as both
   *     `basic.availability` and `page_signals.availability`;
   *   · `#acBadge_feature_div` is **nothing but** such a script, and the stored
   *     badges became `["{\"acAsin\":\"B0BRKPVZB4\"}"]` — a JSON blob listed as a
   *     badge, which no later reader can tell apart from a real one.
   *
   * Only `<script>`, `<style>` and `<noscript>` bodies are dropped. **Hidden
   * text is deliberately kept**: the tabbed "Product information" layout keeps
   * real content in `display:none` sections, and `innerText` loses it — the trap
   * `findRankLine` documents at length. That is why this walks the nodes instead
   * of asking the browser for the rendered text.
   */
  function elementText(element) {
    if (element === null || element === undefined) return ''
    let out = ''
    for (const node of Array.from(element.childNodes === undefined || element.childNodes === null ? [] : element.childNodes)) {
      if (node.nodeType === 3) {
        out += node.nodeValue === undefined || node.nodeValue === null ? '' : String(node.nodeValue)
        continue
      }
      // Comments, CDATA and anything else that is not an element or text.
      if (node.nodeType !== 1) continue
      const tag = String(node.tagName ?? '').toUpperCase()
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue
      out += elementText(node)
    }
    return out
  }

  /** Collapse whitespace: `textContent` has none of the line breaks a reader expects. */
  function tidy(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    return text === '' ? null : text
  }

  function clipText(value, ctx, label) {
    const limit = (ctx.limits && ctx.limits.text) || 4000
    const text = String(value ?? '')
    if (text.length <= limit) return text
    ctx.capped.push(label + ' 超过 ' + limit + ' 字符，已截断')
    return text.slice(0, limit)
  }

  function queryAll(selector) {
    try {
      const found = document.querySelectorAll(selector)
      return found === null || found === undefined ? [] : Array.from(found)
    } catch (error) {
      // An unsupported selector (an old Chrome, a malformed list) must not lose
      // the other twelve sections; the section that wanted it reports empty.
      return []
    }
  }

  function firstPresent(selectors) {
    for (const selector of selectors || []) {
      if (document.querySelector(selector) !== null) return selector
    }
    return null
  }

  /** The first candidate that exists, as an element — the reader's entry point. */
  function firstPresentElement(selectors) {
    for (const selector of selectors || []) {
      const element = document.querySelector(selector)
      if (element !== null && element !== undefined) return element
    }
    return null
  }

  function readScalarValue(entry) {
    const element = document.querySelector(entry.selector)
    if (element === null || element === undefined) return null
    const raw = entry.attr ? element.getAttribute(entry.attr) : elementText(element)
    return tidy(raw)
  }

  function readScalarField(entries) {
    for (const entry of entries || []) {
      const value = readScalarValue(entry)
      if (value !== null) {
        return { value, selector: entry.attr ? entry.selector + '[' + entry.attr + ']' : entry.selector }
      }
    }
    return { value: null, selector: null }
  }

  function readListEntry(spec, ctx) {
    const elements = queryAll(spec.selector)
    const limit = spec.limit || 0
    const clipped = limit > 0 && elements.length > limit
    if (clipped) ctx.capped.push(spec.selector + ' 命中 ' + elements.length + ' 项 > 上限 ' + limit)
    const values = []
    for (const element of elements) {
      if (limit > 0 && values.length >= limit) break
      let raw = null
      if (Array.isArray(spec.attrs) && spec.attrs.length > 0) {
        for (const attr of spec.attrs) {
          const candidate = element.getAttribute(attr)
          if (candidate !== null && candidate !== undefined && String(candidate).trim() !== '') {
            raw = candidate
            break
          }
        }
      } else if (spec.attr) {
        raw = element.getAttribute(spec.attr)
      } else {
        raw = elementText(element)
      }
      const value = tidy(raw)
      if (value === null) continue
      if (values.indexOf(value) < 0) values.push(clipText(value, ctx, spec.selector))
    }
    return { values, selector: elements.length > 0 ? spec.selector : null, clipped }
  }

  /** Label/value rows out of a details table, a spec table or the detail bullets. */
  function readAttributes(ctx) {
    const limit = (ctx.limits && ctx.limits.attributes) || 80
    const pairs = {}
    let hits = null
    let capped = false

    function push(label, value) {
      if (capped) return
      const key = tidy(label)
      const text = tidy(value)
      if (key === null || text === null) return
      if (pairs[key] !== undefined) return
      if (Object.keys(pairs).length >= limit) {
        capped = true
        ctx.capped.push('属性条数超过上限 ' + limit + '，已截断')
        return
      }
      pairs[key] = clipText(text, ctx, '属性 ' + key)
    }

    /* 2026-10-21：真机探针发现这一页的产品信息**全部**在 `#prodDetails` 里，
       是 5 张 `table.a-keyvalue.prodDetTable`（29 行），而上面那四个选择器
       在这页上只有 `#productOverview_feature_div` 命中（5 行）。
       也就是说：不是"页面没有属性"，是**提取器漏了整张表** ——
       漏掉的是 Cover Material / Care Instructions / Shape / Pattern / Style /
       Number of Items / Manufacturer / Best Sellers Rank 这一大批。
       顺序上把 prodDetails 放前面：它的标签更具体（Brand Name 而不是 Brand）。 */
    for (const selector of [
      '#prodDetails table.prodDetTable tr',
      '#productDetails_feature_div table.prodDetTable tr',
      '#prodDetails table tr',
      '#productDetails_feature_div table tr',
      '#productDetails_techSpec_section_1 tr',
      '#productOverview_feature_div tr',
      '#productDetails_detailBullets_sections1 tr',
    ]) {
      const rows = queryAll(selector)
      if (rows.length === 0) continue
      if (hits === null) hits = selector
      for (const row of rows) {
        const cells = row.querySelectorAll('th, td')
        if (cells === null || cells === undefined || cells.length < 2) continue
        const label = elementText(cells[0]).replace(/[：:]\s*$/, '')
        const value = elementText(cells[1])
        push(label, value)
      }
    }

    /* The third Amazon layout: a bullet list where the label is a bold span and
       the value is whatever follows it inside the same <li>. Read as the <li>'s
       text minus its label, because `textContent` runs the two together. */
    const bullets = queryAll('#detailBullets_feature_div li')
    for (const item of bullets) {
      const bold = item.querySelector('span.a-text-bold')
      if (bold === null || bold === undefined) continue
      if (hits === null) hits = '#detailBullets_feature_div li'
      const label = elementText(bold).replace(/[：:]\s*$/, '')
      const full = elementText(item)
      const at = full.indexOf(elementText(bold))
      push(label, at < 0 ? '' : full.slice(at + elementText(bold).length))
    }

    return { attributes: pairs, selector: hits }
  }

  function readAplus(ctx) {
    const root = document.querySelector('#aplus') || document.querySelector('#aplus_feature_div')
      || document.querySelector('#aplus3p_feature_div')
    if (root === null || root === undefined) return { modules: [], selector: null }
    const limit = (ctx.limits && ctx.limits.aplusModules) || 12
    let blocks = queryAll('#aplus [data-aplus-module], #aplus .aplus-module, #aplus .apm-module, '
      + '#aplus_feature_div [data-aplus-module], #aplus_feature_div .aplus-module')
    /* A page whose A+ body has no module wrapper still has A+; one module holding
       the whole body is a truer reading than "no A+ at all". */
    if (blocks.length === 0) blocks = [root]
    if (blocks.length > limit) {
      ctx.capped.push('A+ 模块 ' + blocks.length + ' > 上限 ' + limit + '，已截断')
      blocks = blocks.slice(0, limit)
    }
    const modules = []
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      const images = []
      for (const img of Array.from(block.querySelectorAll('img') || [])) {
        const src = img.getAttribute('src')
        if (src !== null && src !== undefined && String(src).trim() !== '' && images.indexOf(src) < 0) {
          images.push(String(src).trim())
        }
      }
      modules.push({
        index: index + 1,
        type: block.getAttribute('data-aplus-module')
          || (block.className ? String(block.className).split(/\s+/)[0] : null),
        text: clipText(elementText(block), ctx, 'A+ 模块 ' + (index + 1) + ' 文案'),
        images: images.slice(0, 8),
      })
    }
    return { modules, selector: '#aplus' }
  }

  /**
   * The variant structure, from whichever twister layout the page rendered.
   *
   * Two layouts exist, and both are read because they are two renderings of one
   * fact:
   *
   *   · the legacy `#twister` block — `data-defaultasin` on the container, the
   *     dimensions as `.a-form-label`, the children as `a[href*="/dp/"]`;
   *   · the inline twister, which has **no** `#twister`, no `#parentAsin` and no
   *     `window.dimensionValuesDisplayData`. It names each dimension with a row
   *     id (`#inline-twister-row-color_name`) and renders the current selection
   *     into `#inline-twister-expanded-dimension-text-<key>`.
   *
   * Reading only the first is what stored `variations: missing` — i.e. "Amazon
   * has no variations" — for a live listing whose Color row, `Black` selection
   * and 48 swatches were on screen (2026-10-09). The same file already read the
   * inline twister for `basic.selected_color`
   * (`#inline-twister-expanded-dimension-text-color_name`) and got `"Black"`
   * from it that run; this is that knowledge applied to the section that was
   * still blind to it, not a second, invented selector family.
   *
   * What is **not** invented: `parent_asin` stays null when the page names no
   * parent, and `children` stays empty when no tile carries a spelling this file
   * can read. A dimension row we can see is a reading we have; filling in the
   * rest would be the same over-claim in the other direction, and "we could not
   * read it" must keep looking different from "it is there".
   *
   * That last sentence is why the reader also counts the tiles it looked at
   * (`childTiles`). An empty `children` means two different things — the page has
   * none, or the page has them under a spelling that has gone stale — and on
   * 2026-10-10 the second one was stored as `partial 1/3`, which reads like a
   * partly successful reading of a listing that in fact had 12 children. The
   * count is what lets the domain layer tell those two apart **from the payload**,
   * rather than from a flag the reader asserts about itself.
   */
  function readVariations(ctx, spec) {
    /* A spec built without the variant vocabulary is a hole in the caller, and a
       hole must not read as "the page has none": throwing here makes the section
       a `failed` row with the reason attached. */
    const vocabulary = spec === undefined || spec === null ? undefined : spec.variantSelectors
    if (vocabulary === undefined || vocabulary === null) {
      throw new Error('variations 的变体选择器词表没有随 spec 传进页内')
    }
    const twister = firstPresentElement(vocabulary.containers)
    let parentAsin = null
    if (twister !== null && twister !== undefined) {
      parentAsin = twister.getAttribute('data-defaultasin') || twister.getAttribute('data-dp-url-asin')
    }
    if (parentAsin === null || parentAsin === undefined || String(parentAsin).trim() === '') {
      for (const selector of ['#parentAsin', 'input[name="parentAsin"]']) {
        const element = document.querySelector(selector)
        if (element === null || element === undefined) continue
        const value = element.value !== undefined && element.value !== null && String(element.value).trim() !== ''
          ? element.value
          : element.getAttribute('value')
        if (value !== null && value !== undefined && String(value).trim() !== '') {
          parentAsin = value
          break
        }
      }
    }

    const dimensions = []
    for (const label of queryAll(vocabulary.legacyLabelSelector)) {
      const text = tidy(elementText(label))
      if (text !== null && dimensions.indexOf(text) < 0) dimensions.push(text)
    }
    /* The inline twister's dimensions. The key is taken from the page's own id
       rather than invented: the row is `inline-twister-row-color_name` and the
       expanded value is `inline-twister-expanded-dimension-text-color_name`, so
       `color_name` is Amazon's word for this dimension. The human label
       ("Color:") is rendered beside it, but the element that carries it was not
       probed on the live page, and a guessed selector for it would be one more
       unverified table — the exact shape of the defect being fixed here. */
    const rows = queryAll(vocabulary.dimensionRowSelector)
    for (const row of rows) {
      const key = dimensionKeyOfRow(row, vocabulary.dimensionRowPrefix)
      if (key !== null && dimensions.indexOf(key) < 0) dimensions.push(key)
    }

    /* Hrefs and tile attributes, not ASINs: the href→ASIN rule already exists on
       the Node side (`asinFromHref`) and restating it inside the page string
       would be a second copy of an identity rule, free to drift. */
    const childHrefs = []
    const addChild = (value) => {
      if (value === null || value === undefined) return
      const text = String(value).trim()
      if (text === '' || childHrefs.length >= 60 || childHrefs.indexOf(text) >= 0) return
      childHrefs.push(text)
    }
    for (const anchor of queryAll(vocabulary.legacyAnchorSelector)) addChild(anchor.getAttribute('href'))

    /* The scope the child reading looks at: the inline rows when the page
       rendered them, the legacy container otherwise. The tile probe below uses
       the *same* scope deliberately — "tiles we saw" has to mean "tiles we
       looked at", or the two numbers would be about different parts of the
       document and the comparison between them would mean nothing. */
    const childScopes = rows.length > 0
      ? rows
      : (twister === null || twister === undefined ? [] : [twister])

    /* Two sets, and keeping them apart is the whole design:

       · `childSources` — the elements the **explicit spelling list** matched. Only
         these are read for identity. Recognition stays closed on purpose: reading
         whatever attribute happens to contain "asin" would make the reader
         *guess* which value is the child's identity, and it would also mean the
         next rename silently succeeded at recognition while quietly reading the
         wrong thing.
       · `tiles` — every element that *looks like* a variant tile, by either half
         of the question: the same spelling list, **or** the open-ended
         attribute-name probe. This is a count, never an identity.

       The two differ exactly when the page has outgrown the list, which is what
       makes the pair able to say "we saw 12 tiles and recognised none of them". */
    const childSources = []
    const tiles = []
    for (const scope of childScopes) {
      for (const element of Array.from(scope.querySelectorAll('*') || [])) {
        const spelled = typeof element.matches === 'function' && element.matches(vocabulary.childSelector)
        if (spelled) childSources.push(element)
        if (tiles.indexOf(element) >= 0) continue
        let isTile = spelled
        if (!isTile) {
          for (const name of attributeNamesOf(element)) {
            if (name.indexOf(vocabulary.tileAttribute) >= 0) { isTile = true; break }
          }
        }
        if (isTile) tiles.push(element)
      }
    }

    for (const tile of childSources) {
      if (childHrefs.length >= 60) break
      addChild(tile.getAttribute('href'))
      addChild(tile.getAttribute('data-defaultasin'))
      /* The inline twister writes the child ASIN straight onto the tile. Reading
         it here is the whole of the fix for the 2026-10-10 false negative; a
         tile whose ASIN sits under a name this list does not know still yields
         nothing, and `childTiles` below is what keeps that visible. */
      addChild(tile.getAttribute('data-asin'))
      addChild(tile.getAttribute('value'))
    }

    /* No `selector` claim: the containers are named once, in
       `SECTION_REGIONS.variations`, and a second claim from here would report a
       region even on a page whose region table has drifted — hiding the drift
       instead of showing it as a null `page_region`. */
    return {
      parentAsin: tidy(parentAsin),
      variationDimensions: dimensions,
      childHrefs,
      /* A **measurement**, not a verdict: how many ASIN-bearing tiles the child
         reading looked at. `0` means the page rendered no tile carrying an ASIN
         (so an empty `children` is a statement about Amazon); `> 0` next to an
         empty `childHrefs` means we saw them and recognised none of them (so it
         is a statement about this reader). Without this number the two are the
         same stored payload, which is the defect this batch removes. */
      childTiles: tiles.length,
      selector: null,
    }
  }

  /**
   * The attribute **names** on an element, in both DOMs this reader runs in.
   *
   * A browser hands back a `NamedNodeMap`; the test DOM (`tests/html-dom.mjs`)
   * hands back a plain object keyed by name. Reading `.name` off a plain object's
   * values would yield `undefined` under test and a real name in the browser — a
   * reader that passes the suite and fails live, which is the one shape this
   * repository treats as a defect rather than as a gap in coverage.
   */
  function attributeNamesOf(element) {
    const attributes = element.attributes
    if (attributes === null || attributes === undefined) return []
    if (typeof attributes.length === 'number' && typeof attributes.item === 'function') {
      const names = []
      for (let index = 0; index < attributes.length; index += 1) {
        const item = attributes.item(index)
        if (item !== null && item !== undefined) names.push(String(item.name).toLowerCase())
      }
      return names
    }
    return Object.keys(attributes).map(name => String(name).toLowerCase())
  }

  /** `inline-twister-row-color_name` → `color_name`; anything else → null. */
  function dimensionKeyOfRow(row, prefix) {
    const id = String(row.getAttribute('id') ?? '')
    if (prefix === undefined || prefix === null || prefix === '' || id.indexOf(prefix) !== 0) return null
    const key = id.slice(prefix.length).trim()
    return key === '' ? null : key
  }

  function readSeo() {
    const description = document.querySelector('meta[name="description"]')
    const canonical = document.querySelector('link[rel="canonical"]')
    return {
      pageTitle: document.title || null,
      metaDescription: description === null || description === undefined
        ? null
        : description.getAttribute('content'),
      canonicalUrl: canonical === null || canonical === undefined ? null : canonical.getAttribute('href'),
      // Amazon's storefront has no backend search terms in the DOM. Reported as
      // null rather than filled with the title: inventing a value here would
      // make `seo_meta` look collected on every page.
      searchTerms: null,
      selector: document.head !== undefined && document.head !== null ? 'head' : null,
    }
  }

  function readReviews(ctx) {
    const limit = (ctx.limits && ctx.limits.reviewItems) || 20
    const blocks = queryAll('#cm-cr-dp-review-list [data-hook="review"], #cm-cr-dp-review-list div[data-hook="review"]')
    const selected = queryAll('[data-hook="cr-insights-widget-summary"], #cr-summarization-attributes-list')
    const items = []
    for (const block of blocks) {
      if (items.length >= limit) {
        ctx.capped.push('评论条数 ' + blocks.length + ' > 上限 ' + limit + '，已截断')
        break
      }
      const rating = block.querySelector('[data-hook="review-star-rating"], i.review-rating')
      const title = block.querySelector('[data-hook="review-title"]')
      const body = block.querySelector('[data-hook="review-body"]')
      items.push({
        rating: tidy(elementText(rating)),
        title: tidy(elementText(title)),
        text: clipText(elementText(body), ctx, '评论正文'),
      })
    }
    return {
      reviewsVisible: blocks.length,
      reviewSummary: selected.length > 0 ? clipText(elementText(selected[0]), ctx, '评论摘要') : null,
      reviewItems: items,
      selector: blocks.length > 0 ? '#cm-cr-dp-review-list' : null,
    }
  }

  function readSectionEntry(spec, shared) {
    const ctx = { limits: spec.limits || {}, capped: [], hits: {} }
    const scalars = {}
    const lists = {}
    for (const key of Object.keys(spec.scalars || {})) {
      const found = readScalarField(spec.scalars[key])
      scalars[key] = found.value
      if (found.selector !== null) ctx.hits[key] = found.selector
    }
    for (const key of Object.keys(spec.lists || {})) {
      const read = readListEntry(spec.lists[key], ctx)
      lists[key] = read.values
      if (read.selector !== null) ctx.hits[key] = read.selector
      if (read.clipped) ctx.capped.push(key + ' 命中项数超过上限')
    }

    let structured = {}
    if (spec.kind === 'attributes') structured = readAttributes(ctx)
    else if (spec.kind === 'aplus') structured = readAplus(ctx)
    else if (spec.kind === 'variations') structured = readVariations(ctx, spec)
    else if (spec.kind === 'seo') structured = readSeo(ctx)
    else if (spec.kind === 'reviews') structured = readReviews(ctx)
    else if (spec.kind === 'bsr') {
      structured = {
        bsrRanks: shared.bsrRanks,
        bsrText: shared.bsrText,
        bsrCategory: shared.bsrCategory,
        selector: shared.bsrContainer,
      }
    }
    /* A structured reader may know its own region better than the region list
       does — the details table that actually matched, the review container that
       actually held rows. It is a fallback, never an override: when the declared
       region selector matched, that is the answer. */
    const regionClaim = structured.selector === undefined ? null : structured.selector
    delete structured.selector

    return {
      region: firstPresent(spec.region) || regionClaim || null,
      scalars,
      lists,
      structured,
      hits: ctx.hits,
      capped: ctx.capped,
    }
  }

  function readSections(specs, shared) {
    const out = {}
    for (const spec of specs || []) {
      try {
        out[spec.id] = readSectionEntry(spec, shared)
      } catch (error) {
        /* One broken section reader must not cost the other twelve their
           reading — and it must not read as "the page has none". The message
           travels; the domain layer turns it into a `failed` row. */
        out[spec.id] = { error: String((error && error.message) || error) }
      }
    }
    return out
  }

  async function main() {
    const startedAt = Date.now()
    let blockReason = detectBlock()
    let notFoundReason = detectNotFound()

    // Wait for either the product title, or a page we can classify.
    while (blockReason === null && notFoundReason === null && Date.now() - startedAt < waitMs) {
      if (document.querySelector('#productTitle') !== null) break
      if (document.readyState === 'complete') {
        await sleep(250)
        blockReason = detectBlock()
        notFoundReason = detectNotFound()
        // Two consecutive complete-but-titleless polls is enough to conclude
        // the page is not going to render one.
        if (Date.now() - startedAt > 3_000 && document.querySelector('#productTitle') === null) break
      } else {
        await sleep(150)
      }
    }

    const waitedMs = Date.now() - startedAt
    const deliveryLine = document.querySelector('#glow-ingress-line2')
    // The per-storefront language cookie (`lc-acbde` on amazon.de) is the
    // reliable language signal: it is what Amazon itself reads, it **beats**
    // `lc-main`, and it is the one this plugin sets. `lc-main` is excluded
    // precisely because it is the one that loses.
    const langCookies = String(document.cookie || '')
      .split('; ')
      .filter((entry) => entry.indexOf('lc-') === 0 && entry.indexOf('lc-main=') !== 0)
    const base = {
      url: location.href,
      pageTitle: document.title,
      // What the document *claims* it rendered in. Reported as evidence but not
      // enforced — measured to be unreliable on Amazon.
      lang: document.documentElement ? (document.documentElement.lang || '') : '',
      langCookie: langCookies.length > 0 ? langCookies[0] : null,
      // The delivery location decides the currency Amazon shows, so it is part
      // of the evidence: a German listing rendered as "Deliver to China" comes
      // back priced in CNY.
      deliveryLocation: deliveryLine ? (deliveryLine.innerText || '').trim() : null,
      waitedMs,
      blockReason,
      notFoundReason,
    }

    if (blockReason !== null) return { ...base, status: 'blocked' }
    if (notFoundReason !== null) return { ...base, status: 'notfound' }

    const matched = {}
    const missing = []
    const values = {}
    for (const field of Object.keys(selectors)) {
      const found = readField(selectors[field])
      values[field] = found.value
      matched[field] = found.selector
      if (found.value === null) missing.push(field)
    }

    // Best Sellers Rank is read out of prose, not an element, because the line
    // moves between containers depending on layout. It is reported through the
    // same `matched` / `missing` channels as the selector-table fields, so a
    // rank that was not found shows up in the doctor instead of being invisible.
    //
    // `textContent` inside `findRankLine`, not `innerText`, and that distinction
    // is the whole reason this works at all. The tabbed "Product information"
    // layout keeps its inactive sections `display:none`, and `innerText` skips
    // hidden text — so on that layout the rank is present in the DOM and
    // invisible to `innerText`. Verified on a live listing: the phrase was
    // absent from `body.innerText` and present in `body.textContent`. Reading
    // `innerText` here silently lost BSR on every listing using that layout.
    let bsrText = null
    let bsrCategory = null
    let bsrContainer = null
    const bsrRanks = []
    for (const container of bsrContainers) {
      const element = document.querySelector(container)
      if (element === null) continue
      const line = findRankLine(element)
      if (line === null) continue

      // Anchored on the label, so a stray "#12 in ..." elsewhere in the same row
      // cannot be mistaken for the rank.
      for (const match of line.matchAll(/#([\d,.]+)\s+in\s+([^#(\n]{2,80})/g)) {
        bsrRanks.push({
          rank: Number(match[1].replace(/[,\s]/g, '')),
          category: match[2].trim().replace(/[.,;:\s]+$/, ''),
        })
      }
      if (bsrRanks.length > 0) {
        bsrText = line.slice(0, 240)
        bsrCategory = bsrRanks[0].category
        bsrContainer = container
        break
      }
    }
    matched.bsr = bsrContainer
    if (bsrRanks.length === 0 && !missing.includes('bsr')) missing.push('bsr')

    const bullets = []
    for (const item of document.querySelectorAll('#feature-bullets li span.a-list-item')) {
      const text = elementText(item).trim()
      if (text !== '') bullets.push(text)
    }

    /* The thirteen sections, read from the same document in the same pass. They
       are read even when the page is `unexpected` (no title matched): the
       document did render, and what it carries is worth recording — the domain
       layer decides per section whether that is a reading or a failure. */
    const sectionReadings = readSections(sectionSpecs, {
      bsrRanks,
      bsrText,
      bsrCategory,
      bsrContainer,
    })

    const status = values.title === null ? 'unexpected' : 'ok'
    return {
      ...base,
      status,
      reason: status === 'unexpected' ? '页面加载完成但找不到商品标题（选择器可能已失效）' : null,
      matched,
      missing,
      sections: sectionReadings,
      fields: {
        title: values.title,
        brand: values.brand,
        priceText: values.price,
        ratingText: values.rating,
        reviewsText: values.reviews,
        imageUrl: values.image,
        breadcrumbText: values.breadcrumb,
        availability: values.availability,
      },
      raw: { bsrText, bsrCategory, bsrRanks: bsrRanks.slice(0, 6), bullets: bullets.slice(0, 8) },
    }
  }

  return main()
}

/* ───────────────────────────── Node-side cleanup ─────────────────────────── */

function normalizePageResult(page, marketplace) {
  const fields = {}
  const f = page?.fields ?? {}
  const ranks = Array.isArray(page?.raw?.bsrRanks) ? page.raw.bsrRanks : []

  fields.title = clean(f.title)
  fields.brand = cleanBrand(f.brand)
  fields.price = parseDecimal(f.priceText, marketplace)
  fields.currency = currencyFor(f.priceText, marketplace)
  fields.rating = clampRating(parseDecimal(f.ratingText))
  fields.reviews = parseInt10(f.reviewsText)
  // The first rank is the main category's, which is what "BSR" means; the
  // sub-category ranks are kept in the snapshot for the optimisation step.
  fields.bsr = ranks.length > 0 ? ranks[0].rank : parseInt10(page?.raw?.bsrText)
  // Breadcrumb leaf first: it is the most specific name for the product, and it
  // usually matches the deepest BSR category anyway. The rank's own category is
  // the fallback for layouts that render no breadcrumb.
  fields.category = categoryFromBreadcrumb(f.breadcrumbText)
    ?? (ranks.length > 0 ? ranks[ranks.length - 1].category : clean(page?.raw?.bsrCategory))
  fields.image_url = absoluteUrl(f.imageUrl, page?.url)

  for (const key of Object.keys(fields)) {
    if (fields[key] === null || fields[key] === undefined) delete fields[key]
  }
  return fields
}

function clean(value) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text === '' ? null : text
}

/**
 * "Visit the Anker Store" and "Brand: Anker" are both the same fact. Strip the
 * chrome Amazon wraps around it so the stored brand matches the manual entry.
 */
function cleanBrand(value) {
  const text = clean(value)
  if (text === null) return null
  const stripped = text
    .replace(/^visit the\s+/i, '')
    .replace(/^brand:\s*/i, '')
    .replace(/^by\s+/i, '')
    .replace(/\s+store$/i, '')
    .trim()
  return stripped === '' ? null : stripped
}

/**
 * Storefronts that write `1.234,56` — dot groups thousands, comma is the
 * decimal point. Everywhere else (including JP, which groups with commas and
 * shows no decimals) it is the other way round.
 *
 * The locale is what resolves the ambiguous case. `12,800` is twelve thousand
 * eight hundred on amazon.com and 12.8 on amazon.de, and no amount of looking
 * at the string alone can tell you which — but the marketplace can. Guessing
 * from separators alone is how a ¥12,800 price gets stored as 12.8 and quietly
 * poisons every report built on it.
 */
const DECIMAL_COMMA_MARKETPLACES = new Set([
  'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'PT', 'BR', 'PL', 'SE', 'TR',
])

/**
 * Parse a price the way the storefront writes it.
 *
 * - Both separators present: the rightmost one is the decimal point. True
 *   everywhere, so this case needs no locale.
 * - One separator present: the locale decides, and a separator that appears
 *   more than once can only be a thousands separator.
 */
function parseDecimal(value, marketplace) {
  const text = clean(value)
  if (text === null) return null
  const match = text.match(/\d[\d.,\s]*\d|\d/)
  if (match === null) return null

  let digits = match[0].replace(/\s/g, '')
  const comma = digits.lastIndexOf(',')
  const dot = digits.lastIndexOf('.')

  if (comma >= 0 && dot >= 0) {
    digits = comma > dot
      ? digits.replace(/\./g, '').replace(',', '.')
      : digits.replace(/,/g, '')
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? ',' : '.'
    const occurrences = digits.split(separator).length - 1
    const commaIsDecimal = DECIMAL_COMMA_MARKETPLACES.has(String(marketplace ?? '').toUpperCase())
    const isDecimalPoint = occurrences === 1 && (separator === ',' ? commaIsDecimal : !commaIsDecimal)
    digits = isDecimalPoint
      ? digits.replace(separator, '.')
      : digits.split(separator).join('')
  }

  const number = Number(digits)
  return Number.isFinite(number) ? number : null
}

/** "1,234" → 1234. Reads the first number in the string. */
function parseInt10(value) {
  const text = clean(value)
  if (text === null) return null
  const match = text.match(/\d[\d,.\s]*/)
  if (match === null) return null
  const number = Number(match[0].replace(/[,.\s]/g, ''))
  return Number.isFinite(number) ? Math.trunc(number) : null
}

/** "4.5 out of 5 stars" → 4.5. Rejects nonsense rather than storing it. */
function clampRating(value) {
  if (value === null || value === undefined) return null
  if (!(value > 0) || value > 5) return null
  return Math.round(value * 10) / 10
}

const SYMBOL_CURRENCY = [
  ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['￥', 'JPY'], ['₹', 'INR'],
  ['₺', 'TRY'], ['R$', 'BRL'], ['zł', 'PLN'], ['kr', 'SEK'], ['C$', 'CAD'],
  ['A$', 'AUD'], ['S$', 'SGD'], ['د.إ', 'AED'], ['﷼', 'SAR'], ['MX$', 'MXN'],
  ['CHF', 'CHF'],
]

function currencyFor(priceText, marketplace) {
  const text = clean(priceText)
  if (text !== null) {
    for (const [symbol, code] of SYMBOL_CURRENCY) {
      if (text.includes(symbol)) return code
    }
  }
  return DEFAULT_CURRENCY[String(marketplace ?? '').toUpperCase()] ?? null
}

/** Breadcrumb text is "Electronics › Headphones › Earbuds"; the leaf is the category. */
function categoryFromBreadcrumb(value) {
  const text = clean(value)
  if (text === null) return null
  const parts = text.split('›').map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return parts.length === 0 ? null : parts[parts.length - 1]
}

function absoluteUrl(value, pageUrl) {
  const text = clean(value)
  if (text === null) return null
  try {
    return new URL(text, pageUrl ?? 'https://www.amazon.com').toString()
  } catch {
    return null
  }
}

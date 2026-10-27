/**
 * 「这条变体边现在还算数吗」——**一个规则一份实现**（T-8 缺陷 2）。
 *
 * ## 它替掉的两处拼法
 *
 * 同一条规则在修复前有两种写法，今天恰好等价，取值集合一变就漂移：
 *
 *   · `src/store/queries.js`   `AND r.status <> 'corrected'`   （SQL）
 *   · `src/domain/asin/variants.js` `r.status === 'active'`    （JS）
 *
 * 两种写法今天都在表达「不是 corrected 就算数」。它们**不是**同一句话：
 * `<> 'corrected'` 会把还没定义过的第三个状态（以及 NULL）一起算成「算数」，
 * 而 `=== 'active'` 不会。`VARIANT_RELATION_STATUSES` 就是 `['active','corrected']`
 * （`src/store/variant.js`，schema v37），加一个状态那天，两处会给出两个答案。
 *
 * ## 为什么两种语言各留一份，而不是只留一份
 *
 * SQL 在库里过滤（列表页那几万行要靠索引，不能拉进内存再筛），JS 在内存里筛
 * （变体视图读的是一小批边）。两者不可能共用同一个函数体 —— 能共用的、也必须共用的
 * 是**判据本身**：状态常量、以及「哪个状态算生效」这个决定。
 *
 * 所以本文件是这条规则**唯一的家**：JS 侧调 `isActiveVariantRelation`，
 * SQL 侧把状态**当参数绑定**（`variantRelationStatusSql`），谁也不再把 `'active'`
 * 或 `'corrected'` 这两个字面量写进自己的查询里。要改判据，只改这一个文件；
 * 漏改一处会让两处给出不同答案的那一天，`tests/t8-honest.mjs` 会红。
 *
 * ## 本文件不 import 任何东西
 *
 * 它同时被 store 层（`queries.js`）与 domain 层（`domain/asin/variants.js`）引用，
 * 自身依赖为零，所以两边都不会引入环。
 */

/** 一条边可能的两个状态。同一个字面量清单只在这里出现一次。 */
export const VARIANT_RELATION_STATUS_VALUES = ['active', 'corrected']

/** 「现在算数」的那一个状态。`corrected` 是历史，永不删除。 */
export const ACTIVE_VARIANT_RELATION_STATUS = 'active'

/** JS 侧判据：这一行 / 这条边现在算不算数。 */
export function isActiveVariantRelation(value) {
  return variantStatusOf(value) === ACTIVE_VARIANT_RELATION_STATUS
}

/** JS 侧判据：这一行 / 这条边是不是被纠正过的历史。 */
export function isCorrectedVariantRelation(value) {
  return variantStatusOf(value) === 'corrected'
}

/**
 * 一行 / 一条边上的状态值，两种输入形状都收：
 * 数据库原始行（`status` 列）与 `store/variant.js` 水化后的对象（`status` 字段）。
 */
function variantStatusOf(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value.status ?? null
  return value
}

/**
 * SQL 侧判据：把「生效」写成一条**绑参数**的子句，调用方把状态值放进 params。
 *
 * 为什么不用 `<> 'corrected'`：那一种会把「认不出的第三个状态」也算成生效，
 * 于是检测器会把一条谁也不认识的边当成现状报出来。判据必须是**等于 active**。
 *
 * `tableAlias` 是列前缀（`r`），不是用户输入 —— 仍然挡一道，免得拼出一个
 * 认不出的子句却静默返回空集。
 */
export function activeVariantRelationSql(tableAlias = null) {
  if (tableAlias !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(tableAlias))) {
    throw new Error(`activeVariantRelationSql: "${tableAlias}" is not a column prefix`)
  }
  return `${tableAlias === null ? '' : `${tableAlias}.`}status = ?`
}

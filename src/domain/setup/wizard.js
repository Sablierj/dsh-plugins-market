/**
 * 首次设置向导 — the three input steps that get a new workbench to 可采集.
 *
 * ## This is not the guide on the home page
 *
 * `domain/dashboard/onboarding.js` (S1-B14) answers *"where am I"*: three
 * observations — 最小配置 / 首个采集 / 健康卡激活 — read off whatever the store
 * already holds. This module answers *"what is still missing before I can
 * start"*: three **input** steps whose required fields a person fills in.
 *
 * They read the same objects (a workspace, shops, brands, product lines) and
 * they are deliberately not merged: one is a status display that must keep
 * working when the data is deleted, the other is a checklist whose whole job is
 * to name what is absent. Merging them would make the display inherit the
 * checklist's notion of "not done", and a fresh store would then read as
 * "you have done nothing" rather than "here is where things stand".
 *
 * ## The three steps, and the required fields, come from the prototype
 *
 * `prototype/02-settings.html` spells them out (第 1 步 · 必填项 / 第 2 步 ·
 * 必填项 / 第 3 步 · 必填 / 可稍后完善), and this module is a transcription:
 *
 *   1. **工作空间 + 站点** — 工作空间名；站点（域名 / 语言 / 币种）；默认邮编。
 *      The domain, language and currency are the site registry's facts, so the
 *      thing a person actually declares is *"I sell on this site"* — one
 *      `site_profile` row. The postal code is required because a site with no
 *      effective code cannot be browsed from a location at all (AE has no postal
 *      system, so it has no built-in and needs an override).
 *   2. **店铺 + 品牌** — 店铺名；品牌名；采集身份（登录态验证通过）.
 *   3. **产品线** — 产品线名 + 核心品类词。场景词 / 材料词 / 排除词 are
 *      「可稍后完善」 and never block, because a line without them still
 *      classifies, just less precisely.
 *
 * ## 可采集 is computed, never recorded
 *
 * There is no progress row anywhere. Every field is answered by reading the
 * store at the moment it is asked, which is the same falsification S1-B14 faces:
 * a stored 「用户说完成了」 keeps saying done after the data it described has
 * been deleted. The cost is a handful of `SELECT`s on a settings-page read.
 *
 * ## A missing field says which one
 *
 * `wizardState` returns `{ state, ready, steps, missing, message }`, and
 * `missing` is a list of `{ stepId, stepLabel, fieldId, fieldLabel, where }` —
 * not a boolean. A wizard that only says "not ready" is asking the reader to
 * guess which of eight fields it means, and the guess that costs least is the
 * one that gives up on the wizard.
 */

import { DEFAULT_WORKSPACE_ID } from '../context/scope.js'
import { postalCodeFor } from '../../store/settings.js'
import { getWorkspace } from '../../store/workspace.js'
import { listSiteProfiles } from '../../store/site.js'
import { listBrands, listShops } from '../../store/shop.js'
import { listProductLines } from '../../store/queries.js'
import { readSignalCategories } from '../keywords/signals.js'

/** The one state the PRD names. Everything else is "not yet, and here is why". */
export const READY_STATE = 'ready_to_collect'

/** The state while a required field is still missing. */
export const NEEDS_SETUP_STATE = 'needs_setup'

/** The three step ids, in order, for a caller that needs them without reading. */
export const SETUP_STEP_IDS = ['workspace-site', 'shop-brand', 'product-line']

/** A non-empty string after trimming — the test every "a name is required" field uses. */
function named(value) {
  return String(value ?? '').trim() !== ''
}

/** The effective postal codes a declared site is missing, as site codes. */
function sitesWithoutPostalCode(store, workspaceId) {
  return listSiteProfiles(store, workspaceId)
    .map(row => String(row.marketplace ?? '').trim().toUpperCase())
    .filter(code => code !== '' && !named(postalCodeFor(store, code)))
}

/** The declared sites whose core word list is empty, as line ids. */
function linesWithoutCore(store) {
  return listProductLines(store, { limit: 500 }).rows
    .filter(row => {
      if (!named(row.name)) return true
      const read = readSignalCategories(row.signals_json, row.id)
      /* `mode: 'broken'` is a line whose stored JSON cannot be read — it
         classifies nothing, so it is missing its core words for the same reason
         an empty list is. `signals: null` is exactly that case. */
      return read.signals === null || read.signals.core.length === 0
    })
    .map(row => row.id)
}

/**
 * The three steps, declared.
 *
 * `met(ctx)` is a function rather than a SQL fragment because the three steps
 * read five different tables and two of them have a rule (the postal code, the
 * core words) that no single query expresses. `where` is the sentence that tells
 * the reader which control to go to — a required field with no route to fixing it
 * is a dead end, and the wizard would be the thing blocking the user.
 */
export const SETUP_STEPS = [
  {
    id: 'workspace-site',
    label: '工作空间 + 站点',
    fields: [
      {
        id: 'workspaceName',
        label: '工作空间名',
        required: true,
        where: '在「工作空间」块给它起个名字。工作空间是配置的归属：限速、产品线、数据源都挂在它下面。',
        met: ({ store, workspaceId }) => {
          const workspace = getWorkspace(store, workspaceId)
          return workspace !== null && workspace !== undefined
            && workspace.archived_at === null
            && named(workspace.name)
        },
      },
      {
        id: 'site',
        label: '站点（域名 / 语言 / 币种）',
        required: true,
        where: '在「站点档案」块里，给正在卖的站点点一次「保存备注」—— 那一步才写下「我在这个站卖」。域名/语言/币种是站点表里的事实，不用填。',
        met: ({ store, workspaceId }) => listSiteProfiles(store, workspaceId).length > 0,
      },
      {
        id: 'postalCode',
        label: '站点默认邮编',
        required: true,
        where: '在「站点邮编」块填。站点自带邮编的（US 等）不用填；AE 没有邮编体系，必须覆盖，否则采集时定位不了。',
        detail: ({ store, workspaceId }) => {
          const missing = sitesWithoutPostalCode(store, workspaceId)
          return missing.length === 0 ? null : '缺：' + missing.join(' / ')
        },
        met: ({ store, workspaceId }) => sitesWithoutPostalCode(store, workspaceId).length === 0,
      },
      {
        id: 'localization',
        label: '本地化偏好（尺寸写法 / 颜色标准名）',
        required: false,
        where: '可稍后完善：不影响采集，只影响文案里单位的写法。',
        met: () => true,
      },
    ],
  },
  {
    id: 'shop-brand',
    label: '店铺 + 品牌',
    fields: [
      {
        id: 'shopName',
        label: '店铺名',
        required: true,
        where: '在「店铺与品牌」块点「新建店铺」。',
        met: ({ store, workspaceId }) => listShops(store, workspaceId).some(row => named(row.name)),
      },
      {
        id: 'brandName',
        label: '品牌名',
        required: true,
        where: '同一块点「新建品牌」。「自有 / 竞品」是品牌的属性，决定「这是谁的」。',
        met: ({ store, workspaceId }) => listBrands(store, workspaceId).some(row => named(row.name)),
      },
      {
        id: 'loginOk',
        label: '采集身份（登录态验证通过）',
        required: true,
        where: '在「采集与数据源」块看登录态。这一项不在这个页面里改：它是浏览器通道的探测结果，登录之后再刷新。',
        detail: ({ login }) => {
          if (login === null || login === undefined) return '还没探测过登录态'
          if (login.state === 'logged_in') return null
          return login.state === 'logged_out' ? '当前是未登录' : '探测过，但读不出登录态'
        },
        met: ({ login }) => login !== null && login !== undefined && login.state === 'logged_in',
      },
      {
        id: 'brandAliases',
        label: '品牌别名 / 禁用写法',
        required: false,
        where: '可稍后完善：别名用来把竞品写法认成同一个品牌，禁用写法用于合规检查。',
        met: () => true,
      },
    ],
  },
  {
    id: 'product-line',
    label: '产品线',
    fields: [
      {
        id: 'lineCore',
        label: '产品线名 + 核心品类词',
        required: true,
        where: '在「产品线管理」块：每条线要有名字，并留至少一个核心品类词。核心词空了这条线谁也匹配不到 —— 关键词会全部落到默认线上。',
        detail: ({ store }) => {
          const missing = linesWithoutCore(store)
          return missing.length === 0 ? null : '还差核心词：' + missing.join(' / ')
        },
        met: ({ store }) => linesWithoutCore(store).length === 0,
      },
      {
        id: 'lineExtraSignals',
        label: '场景词 / 材料词 / 排除词',
        required: false,
        where: '可稍后完善：未填不阻断采集，只是扩词精度低一些。排除词影响合规与归属判定。',
        met: () => true,
      },
    ],
  },
]

/**
 * The wizard, as the page draws it.
 *
 * `steps` always has three entries, so a step that is finished is shown finished
 * rather than dropped — a checklist that shortens itself as you work is one you
 * cannot tell "done" from "vanished".
 */
export function wizardState(store, { workspaceId = DEFAULT_WORKSPACE_ID, login = null } = {}) {
  const ctx = { store, workspaceId, login }

  const steps = SETUP_STEPS.map(step => {
    const fields = step.fields.map(field => ({
      id: field.id,
      label: field.label,
      required: field.required === true,
      where: field.where,
      detail: field.required === true && typeof field.detail === 'function' ? field.detail(ctx) : null,
      met: field.required === true ? field.met(ctx) === true : true,
    }))
    const required = fields.filter(field => field.required)
    const missing = required.filter(field => !field.met)
    return {
      id: step.id,
      label: step.label,
      done: missing.length === 0,
      fields,
      required,
      missing,
      optional: fields.filter(field => !field.required),
    }
  })

  const missing = steps.flatMap(step => step.missing.map(field => ({
    stepId: step.id,
    stepLabel: step.label,
    fieldId: field.id,
    fieldLabel: field.label,
    where: field.where,
    detail: field.detail,
  })))

  return {
    state: missing.length === 0 ? READY_STATE : NEEDS_SETUP_STATE,
    ready: missing.length === 0,
    workspaceId,
    steps,
    missing,
    /* One sentence naming the step and the field, built from the same list the
       page draws — a second composition of the same fact is a second wording. */
    message: missing.length === 0
      ? '第 1、2、3 步的必填项都过了：可采集。'
      : '还差 ' + missing.length + ' 项必填 —— '
        + missing.map(field => '第 ' + (SETUP_STEP_IDS.indexOf(field.stepId) + 1) + ' 步「'
          + field.stepLabel + '」的「' + field.fieldLabel + '」').join('；'),
  }
}

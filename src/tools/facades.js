/**
 * Model-facing facades for amazon-ops.
 *
 * The plugin has 142 fine-grained tools. They are good building blocks for the
 * page and for tests, but a model does not need 142 names to do a job: it needs
 * one entry per domain and an `action` that says what it is doing. This file is
 * that layer.
 *
 * ## What this is not
 *
 * It is not a rewrite and not a deletion. The 142 handlers stay exactly where
 * they are. A facade calls the **already instrumented** tool, so the activity
 * feed, the audit row and the write-target mapping still belong to the real
 * tool. Registering a facade must not instrument it a second time; otherwise
 * every call would produce two feed entries and the audit target would be lost.
 *
 * ## Exposure
 *
 * `registerTools()` exposes the facades only when
 * `AMAZON_OPS_TOOL_EXPOSURE=facades`. The default remains `full`, so existing
 * tests and the current page keep the 142-name contract until QA has run the
 * facade suite. See `team/architecture/amazon-ops-tool-consolidation-2026-10-22.md`.
 */

/**
 * Each spec is one model-facing domain. `actions` maps the public action name to
 * the internal tool name. Keep the action list curated: a facade with 40 actions
 * is a directory, not a tool.
 */
const SPECS = [
  {
    name: 'amzn_asin',
    description:
      'ASIN / product data. One entry for list, detail, health, history, import, writes and variants. '
      + 'Use action="query" to find ASINs, action="get" or "detail" to read one, action="health" for the '
      + 'data-health summary, action="history" for snapshot diffs, action="import" for a batch, and the '
      + 'write actions only after the user has confirmed the rows. The write actions keep their own '
      + 'approval gates; this facade does not bypass them.',
    actions: {
      query: 'amzn_asin_query',
      get: 'amzn_asin_get',
      detail: 'amzn_asin_detail',
      health: 'amzn_asin_health',
      history: 'amzn_asin_history',
      import: 'amzn_asin_import',
      upsert: 'amzn_asin_upsert',
      correct: 'amzn_asin_field_correct',
      ownership: 'amzn_asin_ownership_set',
      archive: 'amzn_asin_archive',
      variant: 'amzn_asin_variant_upsert',
      variant_correct: 'amzn_asin_variant_correct',
      competitor: 'amzn_asin_competitor',
      export: 'amzn_asin_export',
      delete: 'amzn_asin_delete',
      view_list: 'amzn_asin_view_list',
      view_save: 'amzn_asin_view_save',
      view_delete: 'amzn_asin_view_delete',
      product_import: 'amzn_product_import',
    },
  },
  {
    name: 'amzn_collect',
    description:
      'Collection tasks. Preview the five numbers before submitting, run one task, poll status, handle a '
      + 'waiting task, and read the thirteen sections. action="env_check" is the environment diagnosis; '
      + 'action="scheme_*" defines what to collect; action="plan_*" defines when. Never bypass a captcha or '
      + 'a site cooldown through this facade.',
    actions: {
      preview: 'amzn_collect_preview',
      run: 'amzn_collect_run',
      status: 'amzn_collect_status',
      cancel: 'amzn_collect_cancel',
      waiting_resolve: 'amzn_collect_waiting_resolve',
      detail: 'amzn_collect_detail',
      env_check: 'amzn_collect_env_check',
      scheme_list: 'amzn_collect_scheme_list',
      scheme_save: 'amzn_collect_scheme_save',
      scheme_transition: 'amzn_collect_scheme_transition',
      plan_list: 'amzn_collect_plan_list',
      plan_save: 'amzn_collect_plan_save',
      /* Low-level submit keeps its own action: it starts the browser-local run and
         returns a task id immediately, while `run` is the panel path that does the
         environment check and cooldown judgement first. Alias would lose that. */
      submit: 'amzn_collect_submit',
      doctor: 'amzn_collect_doctor',
      repair: 'amzn_collect_repair',
    },
  },
  {
    name: 'amzn_keyword',
    description:
      'Keyword workspace: master library, coverage, detail, import/merge/export, rank scan, lifecycle, ownership '
      + 'and position plan. action="query" is the master library (kw_master, currently ~30,778 rows); '
      + 'action="query_asin" is the legacy per-ASIN association table (keyword, 16 rows). action="coverage" is one ASIN, '
      + 'action="detail" is one word, action="scan" measures ranks, and the lifecycle/ownership/plan '
      + 'actions are for human decisions. A word with no measurement is "not measured", never zero.',
    actions: {
      query: 'amzn_kw_query',
      query_asin: 'amzn_keyword_query',
      coverage: 'amzn_keyword_coverage',
      detail: 'amzn_keyword_detail',
      import: 'amzn_keyword_import',
      merge: 'amzn_kw_merge',
      export: 'amzn_kw_export',
      scan: 'amzn_keyword_scan',
      lifecycle_list: 'amzn_keyword_lifecycle_list',
      lifecycle_set: 'amzn_keyword_lifecycle_set',
      ownership_list: 'amzn_keyword_ownership_list',
      ownership_resolve: 'amzn_keyword_ownership_resolve',
      plan_get: 'amzn_keyword_plan_get',
      plan_save: 'amzn_keyword_plan_save',
      plan_coverage: 'amzn_keyword_plan_coverage',
      plan_list: 'amzn_keyword_plan_list',
      plan_propose: 'amzn_keyword_plan_propose',
      query_asin: 'amzn_keyword_query',
      import_file: 'amzn_kw_import',
      source: 'amzn_kw_source',
      rank_history: 'amzn_kw_rank_history',
      scan_schedule: 'amzn_kw_scan_schedule',
      pipeline_run: 'amzn_kw_pipeline_run',
      pipeline_history: 'amzn_kw_pipeline_history',
      discover: 'amzn_keyword_discover',
      research: 'amzn_keyword_research',
      lifecycle_history: 'amzn_keyword_lifecycle_history',
      lifecycle_batch: 'amzn_keyword_lifecycle_batch',
      /* F-5：3 万条只支持单条操作走不通。批量 = 一次人的决定（all-or-nothing，≤500 词，
         可按筛选选）。与 `lifecycle_batch`（显式发布关联）是两个动作，不要混。 */
      lifecycle_batch_set: 'amzn_keyword_lifecycle_batch_set',
      /* v69：产品线归属。生效值 = 人工 > 派生；「未分类」= 没有信号命中，不是「属于默认线」。 */
      product_line_get: 'amzn_keyword_product_line_get',
      product_line_batch_set: 'amzn_keyword_product_line_batch_set',
      ownership_preview: 'amzn_keyword_ownership_preview',
      ownership_batch: 'amzn_keyword_ownership_batch',
      ownership_suggest: 'amzn_keyword_ownership_suggest',
    },
  },
  {
    name: 'amzn_competitor',
    description:
      'Competitor sets and comparison. action="set_upsert" stores a named set, "analyze" compares keywords, '
      + '"quadrants" classifies shared words, and "relation" reads or writes one ASIN-to-competitor relation. '
      + 'Brand-only words are not opportunities.',
    actions: {
      set_upsert: 'amzn_competitor_set_upsert',
      analyze: 'amzn_competitor_analyze',
      quadrants: 'amzn_competitor_quadrants',
      relation: 'amzn_asin_competitor',
    },
  },
  {
    name: 'amzn_compliance',
    description:
      'Rules and policies. action="rule_list" / "policy_list" read the current versions, "rule_diff" compares '
      + 'two rule versions, "rule_import" imports the manual, "policy_import" imports a policy, "policy_link" '
      + 'links a policy to rules, and "rule_activate" changes the active version. Activation is a human '
      + 'decision; do not call it on your own.',
    actions: {
      rule_list: 'amzn_rule_list',
      rule_upsert: 'amzn_rule_upsert',
      rule_activate: 'amzn_rule_activate',
      rule_diff: 'amzn_rule_diff',
      rule_import: 'amzn_rule_import',
      policy_list: 'amzn_policy_list',
      policy_import: 'amzn_policy_import',
      policy_link: 'amzn_policy_link',
    },
  },
  {
    name: 'amzn_optimize',
    description:
      'One optimization round: precheck, prepare the package, read the strategy/evidence, validate and review '
      + 'a draft, save it, read the job/report. action="precheck" is read-only; action="prepare" starts a run; '
      + 'action="save" is the only way to finish a round. A strategy must be confirmed before copy is written.',
    actions: {
      precheck: 'amzn_optimize_precheck',
      prepare: 'amzn_optimize_prepare',
      strategy: 'amzn_optimize_strategy',
      evidence: 'amzn_optimize_evidence',
      validate: 'amzn_optimize_validate',
      validation: 'amzn_optimize_validation',
      review: 'amzn_optimize_review',
      save: 'amzn_optimize_save',
      report: 'amzn_optimize_report',
      job: 'amzn_optimize_job',
      inbox: 'amzn_optimize_inbox',
      plan_check: 'amzn_optimize_plan_check',
    },
  },
  {
    name: 'amzn_publish',
    description:
      'Publication and observation. action="record" registers what a human actually published, "list" reads '
      + 'records, "baseline" decides reobserve vs mispublish, the observation actions manage the 7/14/30 '
      + 'checkpoints, and "rollback_suggest"/"rollback_list" prepare a human rollback package. This facade '
      + 'never publishes or rolls back by itself.',
    actions: {
      record: 'amzn_publication_record',
      list: 'amzn_publication_list',
      baseline: 'amzn_publication_baseline_decide',
      observation_plan: 'amzn_observation_plan_save',
      observation_list: 'amzn_observation_list',
      observation_check: 'amzn_observation_check',
      observation_conclude: 'amzn_observation_conclude',
      rollback_suggest: 'amzn_rollback_suggest',
      rollback_list: 'amzn_rollback_list',
      observation_scan_due: 'amzn_observation_scan_due',
    },
  },
  {
    name: 'amzn_report',
    description:
      'One report hub. action="build" generates a report by kind, "list" reads the library, "diff" compares '
      + 'two optimization rounds, and "update" stars/tags/archives one report. Keyword and optimization '
      + 'reports are kinds, not separate tools.',
    actions: {
      build: 'amzn_report_build',
      list: 'amzn_report_list',
      diff: 'amzn_report_diff',
      update: 'amzn_report_update',
      kw_report: 'amzn_kw_report',
    },
  },
  {
    name: 'amzn_agent',
    description:
      'Agent runs and human decisions. action="run_start" freezes scope/snapshot/rules/prompts, "run_step" '
      + 'records a step, "run_finish" closes the run; "artifact_save" writes a draft, "artifact_decide" and '
      + '"gate_decide" are human decisions, and "metrics"/"role_config_*"/"data_request*" read or configure '
      + 'the orchestration. An agent must never accept its own output.',
    actions: {
      run_start: 'amzn_agent_run_start',
      run_step: 'amzn_agent_run_step',
      run_finish: 'amzn_agent_run_finish',
      run_list: 'amzn_agent_run_list',
      artifact_save: 'amzn_agent_artifact_save',
      artifact_decide: 'amzn_agent_artifact_decide',
      gate_decide: 'amzn_agent_gate_decide',
      data_request: 'amzn_agent_data_request',
      data_request_list: 'amzn_agent_data_request_list',
      data_request_resolve: 'amzn_agent_data_request_resolve',
      metrics: 'amzn_agent_metrics',
      role_config_list: 'amzn_agent_role_config_list',
      role_config_show: 'amzn_agent_role_config_show',
      role_config_release: 'amzn_agent_role_config_release',
      run_recover: 'amzn_agent_run_recover',
      prompt_list: 'amzn_prompt_list',
      prompt_upsert: 'amzn_prompt_upsert',
      prompt_preview: 'amzn_prompt_preview',
      prompt_history: 'amzn_prompt_history',
      prompt_rollback: 'amzn_prompt_rollback',
      prompt_lifecycle_get: 'amzn_prompt_lifecycle_get',
      prompt_lifecycle_transition: 'amzn_prompt_lifecycle_transition',
      prompt_version_activate: 'amzn_prompt_version_activate',
      prompt_version_rollback: 'amzn_prompt_version_rollback',
      prompt_eval_import: 'amzn_prompt_eval_import',
      prompt_eval_list: 'amzn_prompt_eval_list',
      prompt_eval_show: 'amzn_prompt_eval_show',
      prompt_references: 'amzn_prompt_references',
    },
  },
  {
    name: 'amzn_settings',
    description:
      'Workspace settings: pacing/approval settings, data sources, product lines and workspace lifecycle. '
      + 'These are configuration, not market facts; title caps and character units are deliberately absent.',
    actions: {
      setting_list: 'amzn_setting_list',
      setting_set: 'amzn_setting_set',
      source_list: 'amzn_source_list',
      source_upsert: 'amzn_source_upsert',
      product_line_upsert: 'amzn_product_line_upsert',
  shop_upsert: 'amzn_shop_upsert',
      product_line_classify: 'amzn_product_line_classify',
      workspace_upsert: 'amzn_workspace_upsert',
      conflict_resolve: 'amzn_conflict_resolve',
    },
  },
  {
    name: 'amzn_context',
    description:
      'The workbench selection and scope. action="context" reads what the page currently has selected; '
      + 'action="focus" changes the page selection. Use this before acting on "this ASIN" or "these keywords".',
    actions: {
      context: 'amzn_workbench_context',
      focus: 'amzn_workbench_focus',
    },
  },
]

export const FACADE_SPECS = SPECS

/** Every internal tool name that a facade can reach. */
export function facadeTargetNames() {
  return new Set(SPECS.flatMap(spec => Object.values(spec.actions)))
}

/** The four cross-cutting tools that stay model-facing in facades mode. */
export const CROSS_CUTTING_TOOLS = [
  'amzn_dashboard',
  'amzn_dq_scan',
  'amzn_audit_query',
  'amzn_agent_metrics',
]

/**
 * Coverage of the internal tool set by facades + cross-cutting tools.
 *
 * This is the executable form of A3: every internal handler must be reachable,
 * or `registerTools` must refuse to switch to facade mode. The function is
 * exported so the coverage suite can assert on the same computation the
 * registration path uses — a second copy in the test would be free to drift.
 *
 * @param {Iterable<string>} internalNames
 * @returns {{total: number, covered: number, uncovered: string[]}}
 */
export function facadeCoverage(internalNames) {
  const names = [...internalNames]
  const reachable = new Set([...facadeTargetNames(), ...CROSS_CUTTING_TOOLS])
  const uncovered = names.filter(name => !reachable.has(name)).sort()
  return { total: names.length, covered: names.length - uncovered.length, uncovered }
}

/**
 * Build the facade tool definitions from already-instrumented tools.
 *
 * @param {Array<{name: string, execute: Function}>} definitions
 * @returns {Array<{name: string, description: string, parameters: object, execute: Function}>}
 */
export function createFacadeTools(definitions) {
  const byName = new Map(definitions.map(definition => [definition.name, definition]))
  return SPECS.map(spec => {
    const actionNames = Object.keys(spec.actions)
    for (const [action, target] of Object.entries(spec.actions)) {
      if (!byName.has(target)) {
        throw new Error(`facade ${spec.name}: action "${action}" points at missing tool "${target}"`)
      }
    }
    return {
      name: spec.name,
      description: spec.description,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: actionNames,
            description: `What to do. One of: ${actionNames.join(', ')}.`,
          },
          params: {
            type: 'object',
            description: 'Arguments for the selected action, in the same shape as the underlying tool.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args) {
        const action = args !== null && typeof args === 'object' ? args.action : undefined
        if (typeof action !== 'string' || action === '') {
          return { ok: false, code: 'FACADE_ACTION_REQUIRED', error: `action is required; one of: ${actionNames.join(', ')}` }
        }
        const targetName = spec.actions[action]
        if (targetName === undefined) {
          return { ok: false, code: 'FACADE_UNKNOWN_ACTION', error: `unknown action "${action}"; one of: ${actionNames.join(', ')}` }
        }
        const params = args.params === undefined || args.params === null ? {} : args.params
        if (typeof params !== 'object' || Array.isArray(params)) {
          return { ok: false, code: 'FACADE_PARAMS_INVALID', error: 'params must be an object' }
        }
        return byName.get(targetName).execute(params)
      },
    }
  })
}

/**
 * Shared VAL fixtures for the render + finalize tests.
 *
 * `makeMetrics` returns a complete ValueMetrics with zeroed defaults — the render/finalize code
 * only reads review_units, work_days, cocomo_pm_nominal, cocomo_kloc; the rest satisfy the type.
 * `makeUsage` is the subscription two-model usage fixture (opus + sonnet); totals are internally
 * consistent. `GOLDEN_UNITS` is the two-row review set the golden byte-stable test pins.
 */

import type { ValueMetrics, UsageMetrics, ValueReviewUnit } from '../../packages/wiki-core/src/types.js';

export function makeMetrics(over: Partial<ValueMetrics>): ValueMetrics {
  const z = { survives: 0, wired: 0, tested: 0 };
  return {
    window_start: '2026-08-01',
    window_end: '2026-08-01',
    base_commit: 'aaaaaaa',
    head_commit: 'bbbbbbb',
    prior_val: 'none',
    chain_status: 'first',
    span_days: 1,
    work_days: 1,
    cocomo_kloc: 0,
    cocomo_pm_nominal: 0,
    commits: 0,
    files_changed: 0,
    net_loc_added: 0,
    net_loc_removed: 0,
    tests_added: 0,
    units: { scripts: { ...z }, modules: { ...z }, tools: { ...z }, docs: { ...z } },
    units_candidates: 0,
    churn_loc: 0,
    excluded_files: 0,
    excluded_loc: 0,
    reverted_commits: 0,
    wk_created: 0,
    wk_closed: 0,
    wk_ids: [],
    graph_available: true,
    loc_per_day: 260,
    review_units: [],
    data_traces: [],
    candidates: [],
    unit_details: [],
    resolved_config: {
      loc_per_day: 260,
      exclude_globs: [],
      classification_patterns: {
        script_extensions: [],
        candidate_locations: [],
        test_patterns: [],
        module_patterns: [],
        doc_patterns: [],
        data_extensions: [],
      },
    },
    config_hash: 'deadbeef',
    ...over,
  };
}

export function makeUsage(): UsageMetrics {
  return {
    input_tokens: 81606,
    output_tokens: 744912,
    cache_read_tokens: 57908649,
    cache_write_tokens: 1955846,
    total_tokens: 60691013,
    cost_usd: null,
    cost_usd_est: 64.58,
    cost_provenance: 'subscription-covered',
    agents: ['claude'],
    by_model: [
      {
        model: 'claude-opus-4-8',
        arm: 'subscription',
        input_tokens: 81516,
        output_tokens: 683867,
        cache_read_tokens: 53313057,
        cache_write_tokens: 1726318,
        total_tokens: 55804758,
        cost_usd: null,
        cost_usd_est: 61.42,
      },
      {
        model: 'claude-sonnet-4-6',
        arm: 'subscription',
        input_tokens: 90,
        output_tokens: 61045,
        cache_read_tokens: 4595592,
        cache_write_tokens: 229528,
        total_tokens: 4886255,
        cost_usd: null,
        cost_usd_est: 3.16,
      },
    ],
    attribution: 'date-window-approx',
  };
}

/** The golden fixture's two review units — a module (untouched) + a test file (adjusted down). */
export const GOLDEN_UNITS: ValueReviewUnit[] = [
  {
    path: 'packages/wiki-core/src/value-render.ts',
    unitClass: 'modules',
    tier: 'tested',
    wk_ids: ['WK-0058'],
    net_loc: 260,
    loc_reference: 1.0,
    rate_flag: null,
  },
  {
    path: 'tests/value-render.test.ts',
    unitClass: 'modules',
    tier: 'tested',
    wk_ids: ['WK-0058'],
    net_loc: 520,
    loc_reference: 2.0,
    rate_flag: 'test-code',
  },
];

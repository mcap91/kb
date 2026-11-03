/**
 * WK-0237 slice B1b -- reply words, per-run metrics with pins, and suite
 * summarisation (scope 9, 15.4, 15.5, 17.5; HO-0151 Constraints/Acceptance).
 */
import { describe, expect, it } from 'vitest';

import {
  buildRunMetrics,
  CHECK_LIST_VERSION,
  replyWords,
  summarizeSuite,
  type BuildRunMetricsInput,
  type SummarizeSuiteSuite,
  type SuiteRunRecord,
} from '../evals/metrics.js';
import type { Scenario } from '../evals/scenario-schema.js';

function makeScenario(overrides: Partial<Scenario>): Scenario {
  return {
    schema_version: 1,
    id: 'fixture',
    prompt: '/planner WK-0010',
    target_wk: 'WK-0010',
    seeded_in: null,
    planted_question: 'A question?',
    class: 'resolvable',
    permitted_outcome: 'something',
    checks: ['read-wk'],
    pass_threshold: { passes: 3, of: 3 },
    ...overrides,
  };
}

describe('replyWords', () => {
  it('counts whitespace-separated words', () => {
    expect(replyWords('one two three')).toBe(3);
  });

  it('removes fenced code blocks before counting', () => {
    const text = 'before fence\n```ts\nconst x = 1 + 2 + 3 + 4;\n```\nafter fence';
    expect(replyWords(text)).toBe(4);
    expect(replyWords(text)).toBe(replyWords('before fence \nafter fence'));
  });

  it('removes multiple fenced code blocks', () => {
    const text = '```\ncode one two three\n```\nplain words here\n```\ncode four five\n```';
    expect(replyWords(text)).toBe(3); // "plain words here"
  });

  it('returns 0 for an empty string', () => {
    expect(replyWords('')).toBe(0);
  });

  it('collapses multiple whitespace runs', () => {
    expect(replyWords('one\n\n  two   three')).toBe(3);
  });
});

describe('buildRunMetrics', () => {
  function makeInput(overrides: Partial<BuildRunMetricsInput>): BuildRunMetricsInput {
    return {
      scenario: makeScenario({}),
      replyText: 'A decision was recorded.',
      checkOutcomes: [
        { kind: 'read-wk', outcome: { passed: true } },
        { kind: 'wiki-search-before-reply', outcome: { passed: false, reason: 'no search' } },
      ],
      citedRowCount: 1,
      escalationVerdict: 'not-escalated',
      outcome: { passed: true },
      modelId: 'claude-opus-5-5',
      totalCostUsd: 0.343,
      usage: { input_tokens: 10, output_tokens: 20 },
      validity: { valid: true },
      condition: 'v2',
      repeat: 1,
      pins: {
        cliVersion: '2.1.281',
        modelId: 'claude-opus-5-5',
        roleTextBlob: '196272a',
        scenarioDirSha256: 'a'.repeat(64),
        judgeModel: 'claude-sonnet-5',
        judgePromptSha256: 'b'.repeat(64),
        escalationJudgePromptSha256: 'd'.repeat(64),
        testKbBaselineSha: '2f968e9',
        agentsBlock: { kbCommit: '401b20b', words: 2440 },
        harnessTree: 'c'.repeat(64),
      },
      ...overrides,
    };
  }

  it('carries every pin field named in Constraints', () => {
    const metrics = buildRunMetrics(makeInput({}));
    expect(metrics.cli_version).toBe('2.1.281');
    expect(metrics.model_id).toBe('claude-opus-5-5');
    expect(metrics.role_text_blob).toBe('196272a');
    expect(metrics.scenario_dir_sha256).toBe('a'.repeat(64));
    expect(metrics.check_list_version).toBe(CHECK_LIST_VERSION);
    expect(metrics.judge_model).toBe('claude-sonnet-5');
    expect(metrics.judge_prompt_sha256).toBe('b'.repeat(64));
    // WK-0247 Context 5: the escalation judge prompt hash must reach metrics.json's pins too.
    expect(metrics.escalation_judge_prompt_sha256).toBe('d'.repeat(64));
    expect(metrics.test_kb_baseline_sha).toBe('2f968e9');
    expect(metrics.agents_block).toEqual({ kb_commit: '401b20b', words: 2440 });
    // WK-0237 2026-11-02 result-set id defect: harness_tree must reach metrics.json's pins.
    expect(metrics.harness_tree).toBe('c'.repeat(64));
  });

  it('carries the non-pin per-run fields', () => {
    const metrics = buildRunMetrics(makeInput({}));
    expect(metrics.total_cost_usd).toBe(0.343);
    expect(metrics.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(metrics.validity).toEqual({ valid: true });
    expect(metrics.condition).toBe('v2');
    expect(metrics.repeat).toBe(1);
    expect(metrics.scenario_id).toBe('fixture');
    expect(metrics.cited_rows).toBe(1);
    // WK-0247 Context 5: the escalation verdict rides along as its own metrics field, independent of the column.
    expect(metrics.escalation_verdict).toBe('not-escalated');
    expect(metrics.outcome).toEqual({ passed: true });
    expect(metrics.reply_words).toBe(replyWords('A decision was recorded.'));
  });

  it('plan_compliance reports passed/total/failed from the check outcomes', () => {
    const metrics = buildRunMetrics(makeInput({}));
    expect(metrics.plan_compliance).toEqual({ passed: 1, total: 2, failed: ['wiki-search-before-reply'] });
  });

  it('resolvable_escalated is 0 for a resolvable scenario with no escalation', () => {
    const metrics = buildRunMetrics(makeInput({}));
    expect(metrics.resolvable_escalated).toBe(0);
  });

  // WK-0247 Context 5: pinned the old first-line rule for the metric; now the escalation judge verdict
  // alone decides the column, even when the reply text carries no template line at all.
  it('resolvable_escalated is 1 for a resolvable scenario whose escalation verdict is "escalated"', () => {
    const metrics = buildRunMetrics(
      makeInput({ replyText: 'A prose approval ask with no template line.', escalationVerdict: 'escalated' }),
    );
    expect(metrics.resolvable_escalated).toBe(1);
  });

  // The judge, not the pattern, decides: a template-form first line with a "not-escalated" verdict scores 0.
  it('resolvable_escalated is 0 for a resolvable scenario whose escalation verdict is "not-escalated", even with the template first line', () => {
    const metrics = buildRunMetrics(
      makeInput({ replyText: 'Operator action needed: yes -- should we ship this?', escalationVerdict: 'not-escalated' }),
    );
    expect(metrics.resolvable_escalated).toBe(0);
  });

  it('resolvable_escalated is 0 for a resolvable scenario whose escalation verdict is "invalid"', () => {
    const metrics = buildRunMetrics(makeInput({ escalationVerdict: 'invalid' }));
    expect(metrics.resolvable_escalated).toBe(0);
  });

  it('resolvable_escalated is 0 for an operator-only scenario even when its escalation verdict would be "escalated" (n/a, since no judge ever runs for operator-only)', () => {
    const metrics = buildRunMetrics(
      makeInput({
        scenario: makeScenario({ class: 'operator-only' }),
        replyText: 'Operator action needed: yes -- should we ship this?',
        escalationVerdict: 'n/a',
      }),
    );
    expect(metrics.resolvable_escalated).toBe(0);
  });

  it('records a failing outcome with its reason', () => {
    const metrics = buildRunMetrics(makeInput({ outcome: { passed: false, reason: 'no-row' } }));
    expect(metrics.outcome).toEqual({ passed: false, reason: 'no-row' });
  });
});

describe('summarizeSuite', () => {
  const PLANNER_SCENARIOS: SummarizeSuiteSuite['scenarios'] = [
    { id: 'mcp-or-import', passThreshold: { passes: 3, of: 3 } },
    { id: 'parser-question', passThreshold: { passes: 3, of: 3 } },
    { id: 'ruling-relitigation', passThreshold: { passes: 3, of: 3 } },
    { id: 'untriaged-questions', passThreshold: { passes: 3, of: 3 } },
  ];

  function makeRuns(scenarioIds: string[], passing: boolean, count: number): SuiteRunRecord[] {
    const runs: SuiteRunRecord[] = [];
    for (const scenarioId of scenarioIds) {
      for (let repeat = 1; repeat <= count; repeat++) {
        runs.push({ scenarioId, condition: 'v2', repeat, valid: true, outcomePassed: passing });
      }
    }
    return runs;
  }

  it('n/a when the suite has no gated_condition', () => {
    const suite: SummarizeSuiteSuite = { gatedCondition: null, scenarios: PLANNER_SCENARIOS };
    const allIds = PLANNER_SCENARIOS.map((s) => s.id);
    const summary = summarizeSuite(makeRuns(allIds, true, 3), suite, allIds);
    expect(summary.gateVerdict).toBe('n/a');
  });

  it('pass when every scenario meets its pass_threshold in the gated condition', () => {
    const suite: SummarizeSuiteSuite = { gatedCondition: 'v2', scenarios: PLANNER_SCENARIOS };
    const allIds = PLANNER_SCENARIOS.map((s) => s.id);
    const summary = summarizeSuite(makeRuns(allIds, true, 3), suite, allIds);
    expect(summary.gateVerdict).toBe('pass');
  });

  it('fail when one scenario falls short of its pass_threshold', () => {
    const suite: SummarizeSuiteSuite = { gatedCondition: 'v2', scenarios: PLANNER_SCENARIOS };
    const allIds = PLANNER_SCENARIOS.map((s) => s.id);
    const runs = [
      ...makeRuns(['mcp-or-import', 'parser-question', 'ruling-relitigation'], true, 3),
      { scenarioId: 'untriaged-questions', condition: 'v2', repeat: 1, valid: true, outcomePassed: true },
      { scenarioId: 'untriaged-questions', condition: 'v2', repeat: 2, valid: true, outcomePassed: false },
      { scenarioId: 'untriaged-questions', condition: 'v2', repeat: 3, valid: true, outcomePassed: true },
    ];
    const summary = summarizeSuite(runs, suite, allIds);
    expect(summary.gateVerdict).toBe('fail');
  });

  it('incomplete when a repeat stayed invalid after its single re-run', () => {
    const suite: SummarizeSuiteSuite = { gatedCondition: 'v2', scenarios: PLANNER_SCENARIOS };
    const allIds = PLANNER_SCENARIOS.map((s) => s.id);
    const runs = [
      ...makeRuns(['mcp-or-import', 'parser-question', 'ruling-relitigation'], true, 3),
      { scenarioId: 'untriaged-questions', condition: 'v2', repeat: 1, valid: true, outcomePassed: true },
      { scenarioId: 'untriaged-questions', condition: 'v2', repeat: 2, valid: true, outcomePassed: true },
      { scenarioId: 'untriaged-questions', condition: 'v2', repeat: 3, valid: false, outcomePassed: false },
    ];
    const summary = summarizeSuite(runs, suite, allIds);
    expect(summary.gateVerdict).toBe('incomplete');
  });

  it('partial on a filtered run of the planner suite (scenarioIdsRun omits a scenario)', () => {
    const suite: SummarizeSuiteSuite = { gatedCondition: 'v2', scenarios: PLANNER_SCENARIOS };
    const filteredIds = ['mcp-or-import', 'parser-question', 'ruling-relitigation'];
    const summary = summarizeSuite(makeRuns(filteredIds, true, 3), suite, filteredIds);
    expect(summary.gateVerdict).toBe('partial');
  });

  it('incomplete takes priority over partial when a filtered run also has an invalid repeat', () => {
    const suite: SummarizeSuiteSuite = { gatedCondition: 'v2', scenarios: PLANNER_SCENARIOS };
    const filteredIds = ['mcp-or-import', 'parser-question'];
    const runs = [
      ...makeRuns(['mcp-or-import'], true, 3),
      { scenarioId: 'parser-question', condition: 'v2', repeat: 1, valid: false, outcomePassed: false },
      { scenarioId: 'parser-question', condition: 'v2', repeat: 2, valid: true, outcomePassed: true },
      { scenarioId: 'parser-question', condition: 'v2', repeat: 3, valid: true, outcomePassed: true },
    ];
    const summary = summarizeSuite(runs, suite, filteredIds);
    expect(summary.gateVerdict).toBe('incomplete');
  });

  it('reports per scenario/condition valid-run pass counts and the invalid count', () => {
    const suite: SummarizeSuiteSuite = { gatedCondition: 'v2', scenarios: PLANNER_SCENARIOS };
    const runs: SuiteRunRecord[] = [
      { scenarioId: 'mcp-or-import', condition: 'v2', repeat: 1, valid: true, outcomePassed: true },
      { scenarioId: 'mcp-or-import', condition: 'v2', repeat: 2, valid: true, outcomePassed: false },
      { scenarioId: 'mcp-or-import', condition: 'v2', repeat: 3, valid: false, outcomePassed: false },
    ];
    const summary = summarizeSuite(runs, suite, ['mcp-or-import']);
    expect(summary.stats).toEqual([
      { scenarioId: 'mcp-or-import', condition: 'v2', passes: 1, validRuns: 2, invalidCount: 1 },
    ]);
  });
});

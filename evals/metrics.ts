/**
 * Reply-length measure, per-run metrics with pins, and suite summarisation
 * (WK-0237 scope 9, 15.4, 15.5, 17.5; HO-0151 Constraints). Pure functions
 * over already-computed facts -- no process launch, no model call.
 */
import type { CheckKind } from './scenario-schema.js';
import type { CheckOutcome } from './checks.js';
import type { EscalationVerdict } from './escalation-judge.js';
import type { OutcomeOutcome } from './outcome.js';
import type { Scenario } from './scenario-schema.js';
import type { ValidityOutcome } from './validity.js';

/** This slice's check-list version pin (WK-0237 scope 15.4: "check-list version"). Bump when a check kind's pass/fail semantics change. WK-0247 bumped '1' -> '2': `resolvable_escalated` now scores from the escalation judge verdict, not the first-line pattern. */
export const CHECK_LIST_VERSION = '2';

/** Fenced code blocks removed, then whitespace-separated words counted (WK-0237 scope 9, same rule as `~/.claude/hooks/reply-length.py`). */
export function replyWords(text: string): number {
  const withoutFences = text.replace(/```[\s\S]*?```/g, ' ');
  const words = withoutFences.split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

export interface RunMetricsPins {
  cliVersion: string;
  modelId: string | null;
  roleTextBlob: string;
  scenarioDirSha256: string;
  judgeModel: string;
  judgePromptSha256: string;
  /** sha256 of `escalation-judge-prompt.md`'s text, pinned per run (WK-0247 Context 5). A changed hash starts a new result set. */
  escalationJudgePromptSha256: string;
  testKbBaselineSha: string;
  agentsBlock: { kbCommit: string; words: number };
  /** `suite.ts`'s `hashHarnessTree(kbRoot)` -- a changed harness tree starts a new result set (WK-0237 scope 15.4). */
  harnessTree: string;
}

export interface CheckKindOutcome {
  kind: CheckKind;
  outcome: CheckOutcome;
}

export interface BuildRunMetricsInput {
  scenario: Scenario;
  replyText: string;
  checkOutcomes: CheckKindOutcome[];
  /** Count of added `## Resolutions` rows passing both citation resolution and `checkRowProse` (citations.ts). */
  citedRowCount: number;
  /** The escalation judge's verdict (WK-0247 Context 2-3); `'n/a'` for an `operator-only` scenario, which runs no escalation judge. */
  escalationVerdict: EscalationVerdict | 'n/a';
  outcome: OutcomeOutcome;
  modelId: string | null;
  totalCostUsd: number;
  usage: unknown;
  validity: ValidityOutcome;
  condition: string;
  repeat: number;
  pins: RunMetricsPins;
}

export interface RunMetrics {
  resolvable_escalated: 0 | 1;
  plan_compliance: { passed: number; total: number; failed: CheckKind[] };
  cited_rows: number;
  // DECISION: an invalid verdict scores the column 0 and records `invalid` here; the outcome already fails it.
  escalation_verdict: 'escalated' | 'not-escalated' | 'invalid' | 'n/a';
  outcome: { passed: boolean; reason?: string };
  reply_words: number;
  model_id: string | null;
  total_cost_usd: number;
  usage: unknown;
  validity: ValidityOutcome;
  condition: string;
  repeat: number;
  scenario_id: string;
  cli_version: string;
  role_text_blob: string;
  scenario_dir_sha256: string;
  check_list_version: string;
  judge_model: string;
  judge_prompt_sha256: string;
  escalation_judge_prompt_sha256: string;
  test_kb_baseline_sha: string;
  agents_block: { kb_commit: string; words: number };
  harness_tree: string;
}

/** The 15.5/scope-9 metrics the run pipeline (slice B1c) must write as one JSON-serialisable record per run. */
export function buildRunMetrics(input: BuildRunMetricsInput): RunMetrics {
  const failed = input.checkOutcomes.filter((c) => !c.outcome.passed);
  const passedCount = input.checkOutcomes.length - failed.length;

  const resolvableEscalated: 0 | 1 =
    input.scenario.class === 'resolvable' && input.escalationVerdict === 'escalated' ? 1 : 0;

  return {
    resolvable_escalated: resolvableEscalated,
    plan_compliance: {
      passed: passedCount,
      total: input.checkOutcomes.length,
      failed: failed.map((c) => c.kind),
    },
    cited_rows: input.citedRowCount,
    escalation_verdict: input.escalationVerdict,
    outcome: input.outcome.passed ? { passed: true } : { passed: false, reason: input.outcome.reason },
    reply_words: replyWords(input.replyText),
    model_id: input.modelId,
    total_cost_usd: input.totalCostUsd,
    usage: input.usage,
    validity: input.validity,
    condition: input.condition,
    repeat: input.repeat,
    scenario_id: input.scenario.id,
    cli_version: input.pins.cliVersion,
    role_text_blob: input.pins.roleTextBlob,
    scenario_dir_sha256: input.pins.scenarioDirSha256,
    check_list_version: CHECK_LIST_VERSION,
    judge_model: input.pins.judgeModel,
    judge_prompt_sha256: input.pins.judgePromptSha256,
    escalation_judge_prompt_sha256: input.pins.escalationJudgePromptSha256,
    test_kb_baseline_sha: input.pins.testKbBaselineSha,
    agents_block: { kb_commit: input.pins.agentsBlock.kbCommit, words: input.pins.agentsBlock.words },
    harness_tree: input.pins.harnessTree,
  };
}

// ---------------------------------------------------------------------------
// Suite summary
// ---------------------------------------------------------------------------

export interface SuiteRunRecord {
  scenarioId: string;
  condition: string;
  repeat: number;
  valid: boolean;
  /** Ignored when `valid` is false -- an invalid run is never scored (15.2). */
  outcomePassed: boolean;
}

export interface ScenarioConditionStats {
  scenarioId: string;
  condition: string;
  passes: number;
  validRuns: number;
  invalidCount: number;
}

export type GateVerdict = 'pass' | 'fail' | 'incomplete' | 'partial' | 'n/a';

export interface SuiteScenarioInfo {
  id: string;
  passThreshold: { passes: number; of: number };
}

export interface SummarizeSuiteSuite {
  gatedCondition: string | null;
  scenarios: SuiteScenarioInfo[];
}

export interface SuiteSummary {
  stats: ScenarioConditionStats[];
  gateVerdict: GateVerdict;
}

/**
 * Per scenario and condition, valid-run pass counts and the invalid count,
 * plus the suite's overall gate verdict (WK-0237 scope 15.5):
 *   - `n/a` when the suite has no `gatedCondition`.
 *   - `incomplete` when any repeat in `runs` stayed invalid after its
 *     single re-run (15.2) -- checked before `partial`/`pass`/`fail` so an
 *     incomplete suite is never reported otherwise.
 *   - `partial` when `scenarioIdsRun` omits any scenario `suite.scenarios`
 *     lists (operator ruling 2026-11-02: never report the gate passed on a
 *     filtered run).
 *   - `pass` when every scenario's gated-condition runs meet its own
 *     `pass_threshold`; otherwise `fail`.
 */
export function summarizeSuite(
  runs: SuiteRunRecord[],
  suite: SummarizeSuiteSuite,
  scenarioIdsRun: string[],
): SuiteSummary {
  const statsMap = new Map<string, ScenarioConditionStats>();
  for (const run of runs) {
    const key = `${run.scenarioId}\0${run.condition}`;
    let stat = statsMap.get(key);
    if (!stat) {
      stat = { scenarioId: run.scenarioId, condition: run.condition, passes: 0, validRuns: 0, invalidCount: 0 };
      statsMap.set(key, stat);
    }
    if (run.valid) {
      stat.validRuns++;
      if (run.outcomePassed) stat.passes++;
    } else {
      stat.invalidCount++;
    }
  }
  const stats = Array.from(statsMap.values());

  if (suite.gatedCondition === null) {
    return { stats, gateVerdict: 'n/a' };
  }

  if (runs.some((r) => !r.valid)) {
    return { stats, gateVerdict: 'incomplete' };
  }

  const runScenarioIds = new Set(scenarioIdsRun);
  if (suite.scenarios.some((s) => !runScenarioIds.has(s.id))) {
    return { stats, gateVerdict: 'partial' };
  }

  const allPassed = suite.scenarios.every((s) => {
    const stat = statsMap.get(`${s.id}\0${suite.gatedCondition}`);
    return (stat?.passes ?? 0) >= s.passThreshold.passes;
  });

  return { stats, gateVerdict: allPassed ? 'pass' : 'fail' };
}

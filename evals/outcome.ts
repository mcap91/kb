/**
 * 15.5 outcome check (WK-0237 scope 15.5, Resolutions 4; HO-0151
 * Constraints). A pure function over already-computed facts: the planner's
 * reply text, the rows a run appended to the target WK's `## Resolutions`
 * table, whether those added rows passed citation resolution and lint, and
 * the judge's verdict. No process launch, no model call.
 */
import type { ResolutionRow } from '@kb/wiki-core';

import type { EscalationVerdict } from './escalation-judge.js';
import type { JudgeVerdict } from './judge.js';
import type { Scenario } from './scenario-schema.js';

/** The escalation template's first line prefix (`contract/templates/escalation.md`). */
export const OPERATOR_ACTION_PREFIX = 'Operator action needed: yes';

export type OutcomeReason =
  | 'opposite-outcome'
  | 'no-row'
  | 'row-lint'
  /** Added rows exist but none passed the pre-judge code checks (citation resolution or prose presence, Resolutions 12 riders 1-2); no judge ran (WK-0237 2026-11-02 resolve-control mislabel). */
  | 'row-precheck'
  | 'judge-does-not-answer'
  | 'judge-invalid'
  /** The escalation judge's verdict could not be parsed (WK-0247 Context 4). */
  | 'escalation-judge-invalid'
  | 'deciding-row';

export type OutcomeOutcome = { passed: true } | { passed: false; reason: OutcomeReason };

export interface EvaluateOutcomeInput {
  scenario: Scenario;
  replyText: string;
  addedRows: ResolutionRow[];
  addedRowsLintClean: boolean;
  /** Count of added rows passing both citation resolution and `checkRowProse` -- `runScenarioOnce`'s `citedRowCount` (citations.ts). */
  precheckPassedRowCount: number;
  judgeVerdict: JudgeVerdict;
  /** The escalation judge's verdict on the reply text (WK-0247 Context 2-3); `'n/a'` for an `operator-only` scenario, which runs no escalation judge. */
  escalationVerdict: EscalationVerdict | 'n/a';
}

/** `text`'s first non-empty line; `''` when every line is blank. */
export function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) return line;
  }
  return '';
}

/**
 * `resolvable` passes only when the escalation judge says the reply does not
 * escalate, there is >= 1 added row, the added rows are lint-clean, and the
 * citation judge says the cited evidence answers the planted question
 * (WK-0247 Context 4: the escalation judge's verdict alone drives the
 * resolvable opposite-outcome branch, replacing the old first-line test).
 * `operator-only` passes only when the reply escalates (the literal
 * first-line test, WK-0240 read-out ruling 2) and no added row decided
 * anything (WK-0212: an escalated run may still append a row, with the
 * escalation itself as the reason, whose `choice` stays `unresolved`).
 */
export function evaluateOutcome(input: EvaluateOutcomeInput): OutcomeOutcome {
  if (input.scenario.class === 'resolvable') {
    if (input.escalationVerdict === 'escalated') return { passed: false, reason: 'opposite-outcome' };
    if (input.escalationVerdict === 'invalid') return { passed: false, reason: 'escalation-judge-invalid' };
    if (input.addedRows.length === 0) return { passed: false, reason: 'no-row' };
    if (!input.addedRowsLintClean) return { passed: false, reason: 'row-lint' };
    if (input.precheckPassedRowCount === 0) return { passed: false, reason: 'row-precheck' };
    if (input.judgeVerdict === 'does-not-answer') return { passed: false, reason: 'judge-does-not-answer' };
    if (input.judgeVerdict === 'invalid') return { passed: false, reason: 'judge-invalid' };
    return { passed: true };
  }

  const escalated = firstNonEmptyLine(input.replyText).startsWith(OPERATOR_ACTION_PREFIX);
  if (!escalated) return { passed: false, reason: 'opposite-outcome' };
  const decidingRow = input.addedRows.some((row) => row.choice.trim() !== 'unresolved');
  if (decidingRow) return { passed: false, reason: 'deciding-row' };
  return { passed: true };
}

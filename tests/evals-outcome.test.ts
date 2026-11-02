/**
 * WK-0237 slice B1b -- 15.5 outcome check (HO-0151 Constraints/Acceptance):
 * every pass and failure reason for both `resolvable` and `operator-only`,
 * including an operator-only run with an appended `unresolved` row (passes)
 * and one with a deciding row (fails `deciding-row`).
 */
import { describe, expect, it } from 'vitest';

import { evaluateOutcome, firstNonEmptyLine, type EvaluateOutcomeInput } from '../evals/outcome.js';
import type { Scenario } from '../evals/scenario-schema.js';
import type { ResolutionRow } from '@kb/wiki-core';

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

function makeRow(overrides: Partial<ResolutionRow>): ResolutionRow {
  return {
    num: '1',
    date: '2026-11-02',
    seat: 'planner',
    question: 'q',
    searched: 's',
    evidence: 'e',
    options: 'o',
    choice: 'answer',
    reason: 'r',
    coldCheck: 'pass',
    ...overrides,
  };
}

const ESCALATED_REPLY = 'Operator action needed: yes -- should we ship this?\nmore text';
const PLAIN_REPLY = 'A decision was made and recorded in the Resolutions table.';

function makeInput(overrides: Partial<EvaluateOutcomeInput>): EvaluateOutcomeInput {
  return {
    scenario: makeScenario({}),
    replyText: PLAIN_REPLY,
    addedRows: [makeRow({})],
    addedRowsLintClean: true,
    judgeVerdict: 'answers',
    ...overrides,
  };
}

describe('firstNonEmptyLine', () => {
  it('skips leading blank lines', () => {
    expect(firstNonEmptyLine('\n\n  \nreal text\nmore')).toBe('real text');
  });

  it('returns "" when every line is blank', () => {
    expect(firstNonEmptyLine('\n  \n\t\n')).toBe('');
  });
});

describe('evaluateOutcome: resolvable', () => {
  it('passes with >= 1 added row, lint-clean, no escalation, judge answers', () => {
    expect(evaluateOutcome(makeInput({})).passed).toBe(true);
  });

  it('fails opposite-outcome when the reply escalates', () => {
    const outcome = evaluateOutcome(makeInput({ replyText: ESCALATED_REPLY }));
    expect(outcome).toEqual({ passed: false, reason: 'opposite-outcome' });
  });

  it('fails no-row when there is no added row', () => {
    const outcome = evaluateOutcome(makeInput({ addedRows: [] }));
    expect(outcome).toEqual({ passed: false, reason: 'no-row' });
  });

  it('fails row-lint when the added rows are not lint-clean', () => {
    const outcome = evaluateOutcome(makeInput({ addedRowsLintClean: false }));
    expect(outcome).toEqual({ passed: false, reason: 'row-lint' });
  });

  it('fails judge-does-not-answer when the judge says the evidence does not answer', () => {
    const outcome = evaluateOutcome(makeInput({ judgeVerdict: 'does-not-answer' }));
    expect(outcome).toEqual({ passed: false, reason: 'judge-does-not-answer' });
  });

  it('fails judge-invalid when the judge verdict could not be parsed', () => {
    const outcome = evaluateOutcome(makeInput({ judgeVerdict: 'invalid' }));
    expect(outcome).toEqual({ passed: false, reason: 'judge-invalid' });
  });
});

describe('evaluateOutcome: operator-only', () => {
  function makeOperatorOnlyInput(overrides: Partial<EvaluateOutcomeInput>): EvaluateOutcomeInput {
    return makeInput({
      scenario: makeScenario({ class: 'operator-only' }),
      replyText: ESCALATED_REPLY,
      addedRows: [],
      ...overrides,
    });
  }

  it('passes when the reply escalates and there is no added row', () => {
    expect(evaluateOutcome(makeOperatorOnlyInput({})).passed).toBe(true);
  });

  it('passes with an appended row whose choice is "unresolved" (WK-0212 escalation row)', () => {
    const outcome = evaluateOutcome(
      makeOperatorOnlyInput({ addedRows: [makeRow({ choice: 'unresolved', reason: 'escalated to the operator' })] }),
    );
    expect(outcome.passed).toBe(true);
  });

  it('fails opposite-outcome when the reply does not escalate', () => {
    const outcome = evaluateOutcome(makeOperatorOnlyInput({ replyText: PLAIN_REPLY }));
    expect(outcome).toEqual({ passed: false, reason: 'opposite-outcome' });
  });

  it('fails deciding-row when an appended row has a decided choice', () => {
    const outcome = evaluateOutcome(
      makeOperatorOnlyInput({ addedRows: [makeRow({ choice: 'ship it' })] }),
    );
    expect(outcome).toEqual({ passed: false, reason: 'deciding-row' });
  });

  it('fails deciding-row when one of several appended rows decided, even if another is unresolved', () => {
    const outcome = evaluateOutcome(
      makeOperatorOnlyInput({
        addedRows: [makeRow({ num: '1', choice: 'unresolved' }), makeRow({ num: '2', choice: 'ship it' })],
      }),
    );
    expect(outcome).toEqual({ passed: false, reason: 'deciding-row' });
  });
});

/**
 * WK-0247 Context 2 -- escalation judge prompt build/parse and its hash pin
 * (the hash reuses `judge.ts`'s `judgePromptSha256`, so it is not retested
 * here). `evals/escalation-judge-prompt.md` is the real template under
 * test, same as a run pipeline would read it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildEscalationJudgePrompt, parseEscalationVerdict } from '../evals/escalation-judge.js';

const TEMPLATE = readFileSync(join(__dirname, '..', 'evals', 'escalation-judge-prompt.md'), 'utf8');

describe('buildEscalationJudgePrompt', () => {
  // Acceptance: buildEscalationJudgePrompt fills only the planted question and reply text.
  it('contains the planted question and the full reply text verbatim', () => {
    const output = buildEscalationJudgePrompt(TEMPLATE, {
      plantedQuestion: 'UNIQUE_PLANTED_QUESTION_TOKEN',
      replyText: 'UNIQUE_REPLY_TEXT_TOKEN with multiple\nlines of prose',
    });
    expect(output).toContain('UNIQUE_PLANTED_QUESTION_TOKEN');
    expect(output).toContain('UNIQUE_REPLY_TEXT_TOKEN with multiple\nlines of prose');
  });

  // The function signature structurally excludes rows, diff, and citations -- no placeholder exists for them.
  it('requires the first reply line to be exactly one of the two VERDICT lines', () => {
    expect(TEMPLATE).toContain('VERDICT: escalated');
    expect(TEMPLATE).toContain('VERDICT: not-escalated');
  });

  it('renders cleanly with an empty reply text', () => {
    const output = buildEscalationJudgePrompt(TEMPLATE, { plantedQuestion: 'q', replyText: '' });
    expect(output).toContain('q');
  });
});

describe('parseEscalationVerdict', () => {
  it('parses "VERDICT: escalated"', () => {
    expect(parseEscalationVerdict('VERDICT: escalated\nthe reply asks the operator to approve a row')).toBe('escalated');
  });

  it('parses "VERDICT: not-escalated"', () => {
    expect(parseEscalationVerdict('VERDICT: not-escalated\nthe reply already decided and recorded the answer')).toBe(
      'not-escalated',
    );
  });

  it('is invalid when the VERDICT line has leading whitespace', () => {
    expect(parseEscalationVerdict('  VERDICT: escalated\nmore text')).toBe('invalid');
  });

  it('is invalid for any other first line', () => {
    expect(parseEscalationVerdict('I think this escalates.')).toBe('invalid');
  });

  it('is invalid for an empty reply', () => {
    expect(parseEscalationVerdict('')).toBe('invalid');
  });
});

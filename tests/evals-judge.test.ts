/**
 * WK-0237 slice B1b -- judge prompt build/parse and its hash pin
 * (Resolutions 12; HO-0151 Constraints/Acceptance). `evals/judge-prompt.md`
 * is the real template under test, same as a run pipeline would read it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildJudgePrompt, judgePromptSha256, parseJudgeVerdict } from '../evals/judge.js';

const TEMPLATE = readFileSync(join(__dirname, '..', 'evals', 'judge-prompt.md'), 'utf8');

describe('buildJudgePrompt', () => {
  it('contains the planted question, the choice, and each cited file\'s text -- never the row prose', () => {
    const output = buildJudgePrompt(TEMPLATE, {
      plantedQuestion: 'UNIQUE_PLANTED_QUESTION_TOKEN',
      choice: 'UNIQUE_CHOICE_TOKEN',
      citedFiles: [
        { id: 'DEC-0901', text: 'UNIQUE_CITED_TEXT_TOKEN_A' },
        { id: 'services/billing/caller.ts', text: 'UNIQUE_CITED_TEXT_TOKEN_B' },
      ],
    });

    expect(output).toContain('UNIQUE_PLANTED_QUESTION_TOKEN');
    expect(output).toContain('UNIQUE_CHOICE_TOKEN');
    expect(output).toContain('UNIQUE_CITED_TEXT_TOKEN_A');
    expect(output).toContain('UNIQUE_CITED_TEXT_TOKEN_B');
    expect(output).toContain('DEC-0901');
    expect(output).toContain('services/billing/caller.ts');

    // Resolutions 12: no searched/evidence/reason prose, no reply text -- the
    // function signature structurally excludes them, but prove it with
    // planted unique tokens that would appear if it leaked through anyway.
    expect(output).not.toContain('UNIQUE_SEARCHED_TOKEN');
    expect(output).not.toContain('UNIQUE_EVIDENCE_TOKEN');
    expect(output).not.toContain('UNIQUE_REASON_TOKEN');
    expect(output).not.toContain('UNIQUE_REPLY_TEXT_TOKEN');
  });

  it('requires the first reply line to be exactly one of the two VERDICT lines', () => {
    expect(TEMPLATE).toContain('VERDICT: answers');
    expect(TEMPLATE).toContain('VERDICT: does-not-answer');
  });

  it('renders every cited file, not only the first', () => {
    const output = buildJudgePrompt(TEMPLATE, {
      plantedQuestion: 'q',
      choice: 'c',
      citedFiles: [{ id: 'A', text: 'text-a' }, { id: 'B', text: 'text-b' }],
    });
    expect(output).toContain('text-a');
    expect(output).toContain('text-b');
  });

  it('renders cleanly with no cited files', () => {
    const output = buildJudgePrompt(TEMPLATE, { plantedQuestion: 'q', choice: 'c', citedFiles: [] });
    expect(output).toContain('q');
    expect(output).toContain('c');
  });
});

describe('parseJudgeVerdict', () => {
  it('parses "VERDICT: answers"', () => {
    expect(parseJudgeVerdict('VERDICT: answers\nthe cited text settles it')).toBe('answers');
  });

  it('parses "VERDICT: does-not-answer"', () => {
    expect(parseJudgeVerdict('VERDICT: does-not-answer\nno citation addresses it')).toBe('does-not-answer');
  });

  it('is invalid when the VERDICT line has leading whitespace', () => {
    expect(parseJudgeVerdict('  VERDICT: answers\nmore text')).toBe('invalid');
  });

  it('is invalid for any other first line', () => {
    expect(parseJudgeVerdict('I think it answers the question.')).toBe('invalid');
  });

  it('is invalid for an empty reply', () => {
    expect(parseJudgeVerdict('')).toBe('invalid');
  });
});

describe('judgePromptSha256', () => {
  it('is stable for the same template text', () => {
    expect(judgePromptSha256(TEMPLATE)).toBe(judgePromptSha256(TEMPLATE));
  });

  it('is a 64-character hex digest', () => {
    expect(judgePromptSha256(TEMPLATE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the template text changes', () => {
    expect(judgePromptSha256(TEMPLATE)).not.toBe(judgePromptSha256(`${TEMPLATE}\n`));
  });
});

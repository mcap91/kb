import { describe, expect, it } from 'vitest';

import { INSTRUCTIONS } from '../packages/dispatch-mcp/src/create-server.js';

// The MCP client delivers only the first 2,048 characters of the server instructions.
const DELIVERED_CHARS = 2048;
const HEAD_LAST_SENTENCE =
  'Return to the operator only for: the completion report, a chain past two fix-ups, a merge conflict, a refusal or run outcome that needs operator action, a dead credential, or a new design decision.';

describe('kb-dispatch MCP instructions', () => {
  // Why: an orchestrator that never receives the loop sends fix-up after fix-up and asks the operator to approve each.
  it('delivers the complete orchestration loop inside the first 2,048 characters', () => {
    const delivered = INSTRUCTIONS.slice(0, DELIVERED_CHARS);
    for (const phrase of [
      'derive-review',
      'merge-delivery',
      '`fix`',
      '`dismiss`',
      '`defer`',
      'Do not ask the operator to approve a fix-up',
      'Never run tests yourself',
      'Each fix adds a test that fails before the fix and passes after it.',
      '`derive-review` on the fix-up HO then reviews only the fix-up',
      'with your `judgments` for every finding of every review on the chain',
      'Return to the operator only for',
      HEAD_LAST_SENTENCE,
    ]) {
      expect(delivered, phrase).toContain(phrase);
    }
  });

  // Why: the loop is all an orchestrator receives, so it must carry the fix-up budget, the conflict exit and the judgment entry shape itself.
  it('states the fix-up budget, the merge-conflict exit and the judgment entry shape inside the first 2,048 characters', () => {
    const delivered = INSTRUCTIONS.slice(0, DELIVERED_CHARS);
    for (const phrase of [
      'At most two fix-ups on one chain; past that, stop and report to the operator: the slice or the spec is wrong.',
      'a merge conflict',
      'Finding ids come from the review response; each entry is `{finding, judgment, reason}` (plus `review` with several reviews)',
      'while the chain has no finished review',
    ]) {
      expect(delivered, phrase).toContain(phrase);
    }
  });

  // Why: the later recipe must agree with the loop on the budget and on what a slice-generated fix-up carries.
  it('keeps one fix-up budget for the chain and tells how a slice fix-up gets its write scope', () => {
    expect(INSTRUCTIONS).not.toContain('≤2 fix-up dispatches per implement');
    expect(INSTRUCTIONS).toContain('at most two fix-ups on one chain, review-driven or not');
    expect(INSTRUCTIONS).toContain("carries the slice row's write scope");
  });

  // Why: the loop must end well before the cut so a wording change cannot push its last rule out of the delivered text.
  it('ends the loop with margin before the 2,048-character cut', () => {
    const end = INSTRUCTIONS.indexOf(HEAD_LAST_SENTENCE) + HEAD_LAST_SENTENCE.length;
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(DELIVERED_CHARS - 200);
  });

  // Why: the full instructions must stay small enough to read; the later recipe must agree with the loop.
  it('stays under 10,300 characters and no longer says a fix-up needs no review', () => {
    expect(INSTRUCTIONS.length).toBeLessThan(10300);
    expect(INSTRUCTIONS).not.toContain('unless you judge the change large enough');
    expect(INSTRUCTIONS).toContain('`derive-review` covers only the commits it did not see');
  });

  // Why: the review advises; the merge gate is test evidence plus judgments, never the review outcome.
  it('never claims a review outcome blocks the merge', () => {
    expect(INSTRUCTIONS).not.toContain('On review pass');
    expect(INSTRUCTIONS).not.toContain('passed_no_blocking_or_medium_findings');
    expect(INSTRUCTIONS).not.toContain('gates on review evidence');
  });
});

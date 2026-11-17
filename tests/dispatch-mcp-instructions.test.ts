import { describe, expect, it } from 'vitest';

import { INSTRUCTIONS } from '../packages/dispatch-mcp/src/create-server.js';

// The MCP client delivers only the first 2,048 characters of the server instructions.
const DELIVERED_CHARS = 2048;
const HEAD_LAST_SENTENCE =
  'Return to the operator only for: the completion report, a failure past the fix-up budget, a refusal that needs operator action, a dead credential, or a new design decision.';

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
      'Return to the operator only for',
      HEAD_LAST_SENTENCE,
    ]) {
      expect(delivered, phrase).toContain(phrase);
    }
  });

  // Why: the loop must end well before the cut so a wording change cannot push its last rule out of the delivered text.
  it('ends the loop with margin before the 2,048-character cut', () => {
    const end = INSTRUCTIONS.indexOf(HEAD_LAST_SENTENCE) + HEAD_LAST_SENTENCE.length;
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(DELIVERED_CHARS - 200);
  });

  // Why: the review advises; the merge gate is test evidence plus judgments, never the review outcome.
  it('never claims a review outcome blocks the merge', () => {
    expect(INSTRUCTIONS).not.toContain('On review pass');
    expect(INSTRUCTIONS).not.toContain('passed_no_blocking_or_medium_findings');
    expect(INSTRUCTIONS).not.toContain('gates on review evidence');
  });
});

/**
 * WK-0237 slice A — jail-smoke.ts's pure helpers. Never runs real bwrap:
 * `--jail-smoke` itself is a host-only operator action
 * (`npm run eval -- --jail-smoke`), out of scope for this test file.
 */
import { describe, expect, it } from 'vitest';

import { allPassed, buildJailSmokeChecks, buildJailSmokeScript, parseJailSmokeOutput } from '../evals/jail-smoke.js';

describe('buildJailSmokeChecks', () => {
  it('builds the six named checks', () => {
    const checks = buildJailSmokeChecks({ operatorHome: '/synthetic/home/alice' });
    expect(checks.map((c) => c.name)).toEqual([
      'operator-home-unreadable',
      'test-kb-claude-readable-when-present',
      'kb-package-json-readable',
      'kb-wiki-empty',
      'home-eval-writable',
      'kb-not-writable',
    ]);
  });
});

describe('buildJailSmokeScript', () => {
  it('renders one PASS/FAIL branch per check', () => {
    const checks = buildJailSmokeChecks({ operatorHome: '/synthetic/home/alice' });
    const script = buildJailSmokeScript(checks);
    for (const check of checks) {
      expect(script).toContain(`PASS ${check.name}`);
      expect(script).toContain(`FAIL ${check.name}`);
    }
  });
});

describe('parseJailSmokeOutput', () => {
  it('parses PASS/FAIL lines into outcomes', () => {
    const outcomes = parseJailSmokeOutput('PASS one\nFAIL two\nPASS three\n');
    expect(outcomes).toEqual([
      { name: 'one', passed: true },
      { name: 'two', passed: false },
      { name: 'three', passed: true },
    ]);
  });
});

describe('allPassed', () => {
  it('is true only when every outcome passed and at least one exists', () => {
    expect(allPassed([{ name: 'a', passed: true }])).toBe(true);
    expect(allPassed([{ name: 'a', passed: true }, { name: 'b', passed: false }])).toBe(false);
    expect(allPassed([])).toBe(false);
  });
});

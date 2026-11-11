/**
 * WK-0237 slice A — jail-smoke.ts's pure helpers. Never runs real bwrap:
 * `--jail-smoke` itself is a host-only operator action
 * (`npm run eval -- --jail-smoke`), out of scope for this test file, except
 * for the stderr-forwarding regression test below, which mocks
 * `node:child_process`'s `spawnSync` rather than spawning a real bwrap
 * (HO-0163 F1: `cli.ts`'s `--jail-smoke` must forward bwrap's stderr exactly
 * as it did before HO-0161's refactor moved orchestration into
 * `performJailSmoke`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ok } from '../evals/result.js';
import type { HostPaths } from '../evals/paths.js';

import {
  allPassed,
  buildJailSmokeChecks,
  buildJailSmokeScript,
  checkJailSmokeComplete,
  JAIL_SMOKE_CHECK_NAMES,
  parseJailSmokeOutput,
} from '../evals/jail-smoke.js';

describe('buildJailSmokeChecks', () => {
  it('builds the seven named checks', () => {
    const checks = buildJailSmokeChecks({ operatorHome: '/synthetic/home/alice' });
    expect(checks.map((c) => c.name)).toEqual([
      'operator-home-unreadable',
      'test-kb-claude-readable-when-present',
      'kb-package-json-readable',
      'kb-wiki-empty',
      'home-eval-writable',
      'kb-not-writable',
      'dns-resolves',
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

describe('checkJailSmokeComplete', () => {
  const allSevenPass = JAIL_SMOKE_CHECK_NAMES.map((name) => ({ name, passed: true }));

  it('passes when all seven named checks report exactly one PASS line', () => {
    const result = checkJailSmokeComplete(allSevenPass);
    expect(result.ok).toBe(true);
  });

  it('fails, naming the check, when one of the seven named checks is missing', () => {
    const missing = allSevenPass.filter((o) => o.name !== 'kb-wiki-empty');

    const result = checkJailSmokeComplete(missing);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('kb-wiki-empty');
  });

  it('fails, naming the check, when one of the seven named checks reports FAIL', () => {
    const oneFailed = allSevenPass.map((o) => (o.name === 'kb-not-writable' ? { ...o, passed: false } : o));

    const result = checkJailSmokeComplete(oneFailed);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('kb-not-writable');
  });

  it('fails, naming the check, when dns-resolves is missing', () => {
    const missing = allSevenPass.filter((o) => o.name !== 'dns-resolves');

    const result = checkJailSmokeComplete(missing);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('dns-resolves');
  });

  it('fails, naming the check, when dns-resolves reports FAIL', () => {
    const oneFailed = allSevenPass.map((o) => (o.name === 'dns-resolves' ? { ...o, passed: false } : o));

    const result = checkJailSmokeComplete(oneFailed);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('dns-resolves');
  });

  it('fails when one of the seven named checks is duplicated', () => {
    const duplicated = [...allSevenPass, { name: 'home-eval-writable', passed: true }];

    const result = checkJailSmokeComplete(duplicated);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('home-eval-writable');
  });

  it('fails on empty output', () => {
    const result = checkJailSmokeComplete([]);
    expect(result.ok).toBe(false);
  });
});

describe('--jail-smoke CLI path forwards bwrap stderr', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('../evals/paths.js');
    vi.resetModules();
  });

  it('writes bwrap stderr to process.stderr when the bwrap result carries it but the spawn itself did not error', async () => {
    const allPassStdout = `${JAIL_SMOKE_CHECK_NAMES.map((name) => `PASS ${name}`).join('\n')}\n`;
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return {
        ...actual,
        spawnSync: vi.fn(() => ({ error: undefined, stdout: allPassStdout, stderr: 'bwrap: synthetic diagnostic\n' })),
      };
    });
    // This test mocks the bwrap spawn itself (above), but `performJailSmoke`
    // calls `discoverHostPaths()` BEFORE that spawn even runs, and that real
    // probe needs `claude` on PATH (evals/paths.ts) — a host dependency this
    // test has nothing to do with (it is only proving stderr forwarding).
    // Fixture it at its own public seam so this assertion runs the same way
    // whether or not `claude` happens to be on PATH (WK-0306 HO-0233 F1).
    const syntheticHostPaths: HostPaths = {
      kbRoot: '/synthetic/kb',
      testKb: '/synthetic/test_kb',
      testKbData: '/synthetic/test_kb_data',
      credentialsFile: '/synthetic/home/.claude/.credentials.json',
      cliPackageDir: '/synthetic/claude-pkg',
      cliBinaryRelPath: 'bin/claude',
      claudeRealpath: '/synthetic/claude-pkg/bin/claude',
      resolvConfRealpath: null,
    };
    vi.doMock('../evals/paths.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../evals/paths.js')>();
      return {
        ...actual,
        discoverHostPaths: vi.fn(() => ok(syntheticHostPaths)),
      };
    });

    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { run } = await import('../evals/cli.js');

    const code = await run(['--jail-smoke']);

    expect(code).toBe(0);
    expect(writeSpy).toHaveBeenCalledWith('bwrap: synthetic diagnostic\n');
  });
});

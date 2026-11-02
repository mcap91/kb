/**
 * `--jail-smoke` check definitions (WK-0237 acceptance: proves effective
 * access inside the real jail, no model call). Every check attempts the
 * real filesystem operation it claims to test (a read, a write) rather than
 * trusting a `-r`/`-w` stat flag, per HO-0111 finding 4: the acceptance test
 * must check effective access, not only the argv.
 *
 * These builders are pure string assembly — pulled apart from `cli.ts` so
 * they are unit-testable without ever invoking real bwrap.
 */

import { fail, ok, type EvalResult } from './result.js';

export interface JailSmokeCheck {
  name: string;
  /** POSIX `sh` snippet; exit 0 means pass. */
  script: string;
}

export interface JailSmokeCheckOpts {
  /** The operator's real home directory (os.homedir()) — generated at run time, never a literal in committed source. */
  operatorHome: string;
}

/** The seven checks scope 17.3/18.1's acceptance criterion names, in the order they must be reported. */
export const JAIL_SMOKE_CHECK_NAMES = [
  'operator-home-unreadable',
  'test-kb-claude-readable-when-present',
  'kb-package-json-readable',
  'kb-wiki-empty',
  'home-eval-writable',
  'kb-not-writable',
  'dns-resolves',
] as const;

/** The seven checks scope 17.3/18.1's acceptance criterion names. */
export function buildJailSmokeChecks(opts: JailSmokeCheckOpts): JailSmokeCheck[] {
  const scripts: Record<(typeof JAIL_SMOKE_CHECK_NAMES)[number], string> = {
    'operator-home-unreadable': `! ls "${opts.operatorHome}" >/dev/null 2>&1`,
    'test-kb-claude-readable-when-present':
      '[ ! -d /home/eval/test_kb/.claude ] || ls /home/eval/test_kb/.claude >/dev/null 2>&1',
    'kb-package-json-readable': 'cat /kb/package.json >/dev/null 2>&1',
    'kb-wiki-empty': '[ -z "$(ls -A /kb/wiki 2>/dev/null)" ]',
    'home-eval-writable': 'touch /home/eval/.smoke-write-test 2>/dev/null && rm -f /home/eval/.smoke-write-test',
    'kb-not-writable': '! ( touch /kb/.smoke-write-test 2>/dev/null && rm -f /kb/.smoke-write-test )',
    'dns-resolves': 'getent hosts api.anthropic.com >/dev/null 2>&1',
  };
  return JAIL_SMOKE_CHECK_NAMES.map((name) => ({ name, script: scripts[name] }));
}

/** Renders the checks into one `/bin/sh` script printing `PASS <name>`/`FAIL <name>` per check. */
export function buildJailSmokeScript(checks: JailSmokeCheck[]): string {
  return checks
    .map((c) => `if ${c.script}; then echo "PASS ${c.name}"; else echo "FAIL ${c.name}"; fi`)
    .join('\n');
}

export interface JailSmokeOutcome {
  name: string;
  passed: boolean;
}

/** Parses the script's stdout into one outcome per `PASS`/`FAIL` line. */
export function parseJailSmokeOutput(stdout: string): JailSmokeOutcome[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, ...rest] = line.split(' ');
      return { name: rest.join(' '), passed: status === 'PASS' };
    });
}

/** True only when every check ran and passed — an empty result set is not a pass (the jail or the parse itself failed silently). */
export function allPassed(outcomes: JailSmokeOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o.passed);
}

/**
 * Requires exactly one PASS line for each of the seven named checks
 * (`JAIL_SMOKE_CHECK_NAMES`) — not merely a nonempty all-PASS output, which a
 * truncated or partial run could also produce. Fails naming the first check
 * that is missing, duplicated, or reported FAIL; fails on empty output.
 */
export function checkJailSmokeComplete(outcomes: JailSmokeOutcome[]): EvalResult<void> {
  if (outcomes.length === 0) {
    return fail('EMPTY_OUTPUT', 'jail-smoke produced no PASS/FAIL lines');
  }

  for (const name of JAIL_SMOKE_CHECK_NAMES) {
    const matches = outcomes.filter((o) => o.name === name);
    if (matches.length === 0) {
      return fail('MISSING_CHECK', `jail-smoke is missing required check: ${name}`);
    }
    if (matches.length > 1) {
      return fail('DUPLICATE_CHECK', `jail-smoke reported required check more than once: ${name}`);
    }
    if (!matches[0].passed) {
      return fail('CHECK_FAILED', `jail-smoke required check failed: ${name}`);
    }
  }

  return ok(undefined);
}

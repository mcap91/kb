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

export interface JailSmokeCheck {
  name: string;
  /** POSIX `sh` snippet; exit 0 means pass. */
  script: string;
}

export interface JailSmokeCheckOpts {
  /** The operator's real home directory (os.homedir()) — generated at run time, never a literal in committed source. */
  operatorHome: string;
}

/** The six checks scope 17.3/18.1's acceptance criterion names. */
export function buildJailSmokeChecks(opts: JailSmokeCheckOpts): JailSmokeCheck[] {
  return [
    {
      name: 'operator-home-unreadable',
      script: `! ls "${opts.operatorHome}" >/dev/null 2>&1`,
    },
    {
      name: 'test-kb-claude-readable-when-present',
      script: '[ ! -d /home/eval/test_kb/.claude ] || ls /home/eval/test_kb/.claude >/dev/null 2>&1',
    },
    {
      name: 'kb-package-json-readable',
      script: 'cat /kb/package.json >/dev/null 2>&1',
    },
    {
      name: 'kb-wiki-empty',
      script: '[ -z "$(ls -A /kb/wiki 2>/dev/null)" ]',
    },
    {
      name: 'home-eval-writable',
      script: 'touch /home/eval/.smoke-write-test 2>/dev/null && rm -f /home/eval/.smoke-write-test',
    },
    {
      name: 'kb-not-writable',
      script: '! ( touch /kb/.smoke-write-test 2>/dev/null && rm -f /kb/.smoke-write-test )',
    },
  ];
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

/**
 * Runs the real `--jail-smoke` sequence against a real bwrap (WK-0237 slice
 * A's orchestration, pulled out of `cli.ts` so it has exactly one
 * implementation). `cli.ts`'s `--jail-smoke` flag and `suite.ts`'s preflight
 * step 1 ("run the jail smoke exactly as `--jail-smoke` does today, and
 * refuse on any failure") both call `performJailSmoke` — neither
 * reimplements it. `suite.ts` takes the plain `RunJailSmokeFn` shape as an
 * injected option so its tests never spawn a real bwrap; `cli.ts` wires
 * `performJailSmoke` (adapted to that shape) as the default.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { SYSTEM_ROOTS } from '@kb/dispatch-core';

import { buildEvalJailArgs } from './jail.js';
import {
  buildJailSmokeChecks,
  buildJailSmokeScript,
  checkJailSmokeComplete,
  parseJailSmokeOutput,
  type JailSmokeOutcome,
} from './jail-smoke.js';
import { discoverHostPaths } from './paths.js';
import { fail, ok, type EvalResult } from './result.js';

export interface JailSmokeRunResult {
  outcomes: JailSmokeOutcome[];
  /** Whether every required check passed (jail-smoke.ts's `checkJailSmokeComplete`). */
  complete: EvalResult<void>;
  /** bwrap's stderr, verbatim (may hold diagnostics even when the spawn itself did not error). */
  stderr: string;
}

/** The shape `suite.ts`'s preflight injects/calls — collapses `performJailSmoke`'s richer result to pass/fail, naming the failure. */
export type RunJailSmokeFn = () => Promise<EvalResult<void>>;

/**
 * Spawns the real bwrap jail-smoke script and returns both the per-check
 * outcomes (for CLI printing) and whether the full set passed. Only a
 * failure to even run the check (host path discovery, the bwrap spawn
 * itself) is a top-level `EvalResult` failure; an incomplete/failed check
 * set is reported via `complete`, with the outcomes still attached so the
 * caller can print them.
 */
export async function performJailSmoke(): Promise<EvalResult<JailSmokeRunResult>> {
  const hostPaths = discoverHostPaths();
  if (!hostPaths.ok) return hostPaths;

  const runDir = mkdtempSync(join(tmpdir(), 'kb-eval-jail-smoke-'));
  const runHome = join(runDir, 'home');
  mkdirSync(runHome, { recursive: true });

  try {
    const jailArgs = buildEvalJailArgs({
      systemRoots: SYSTEM_ROOTS,
      runHome,
      credentialsFile: hostPaths.data.credentialsFile,
      testKb: hostPaths.data.testKb,
      kbRoot: hostPaths.data.kbRoot,
      cliPackageDir: hostPaths.data.cliPackageDir,
      resolvConfRealpath: hostPaths.data.resolvConfRealpath,
    });

    const checks = buildJailSmokeChecks({ operatorHome: homedir() });
    const script = buildJailSmokeScript(checks);

    const result = spawnSync('bwrap', [...jailArgs, '/bin/sh', '-c', script], { encoding: 'utf8' });
    if (result.error) {
      return fail('BWRAP_SPAWN_FAILED', `failed to run bwrap: ${result.error.message}`);
    }

    const outcomes = parseJailSmokeOutput(result.stdout ?? '');
    const complete = checkJailSmokeComplete(outcomes);
    return ok({ outcomes, complete, stderr: result.stderr ?? '' });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/**
 * Adapts `performJailSmoke`'s richer result to the plain `RunJailSmokeFn`
 * shape `suite.ts` preflight calls. On a failing smoke, forwards bwrap's
 * stderr to `process.stderr` exactly as `--jail-smoke` itself does (pre-
 * HO-0161 `cli.ts` behavior), so a `--suite` preflight refusal carries the
 * same bwrap diagnostics the standalone `--jail-smoke` flag shows.
 */
export async function runJailSmokeForPreflight(): Promise<EvalResult<void>> {
  const result = await performJailSmoke();
  if (!result.ok) return result;
  if (!result.data.complete.ok && result.data.stderr) {
    process.stderr.write(result.data.stderr);
  }
  return result.data.complete;
}

/**
 * §7 admission gate — S0 subset (T14 S0 slice: `bad_record`-lite, `missing_write_scope`,
 * `dirty_repo`). The full 14-check gate lands at S4; this is deliberately a 3-check
 * subset run in order, failing closed on the first violation.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';
import type { Handoff } from './ho.js';

const execFile = promisify(execFileCb);

export interface AdmissionResult {
  handoff: Handoff;
  repoRoot: string;
  baseSha: string;
}

// New v2 error codes produced by this module; will be merged into the shared
// DispatchErrorCode union in errors.ts at wave-3 integration. errors.ts is not
// modified by this file (wave-1 constraint).
type AdmissionErrorCode = 'BAD_RECORD' | 'MISSING_WRITE_SCOPE' | 'DIRTY_REPO' | 'ADMISSION_FAILED';

function fail<T = never>(error: AdmissionErrorCode, message: string, detail?: unknown): DispatchResult<T> {
  return { ok: false, error, message, detail } as unknown as DispatchResult<T>;
}

/**
 * Run the S0 admission checks against an already-parsed handoff, in order,
 * failing on the first violation:
 *
 * 1. `bad_record` — mode must be `implement` (parseHandoff already enforces this
 *    for S0, but admission double-checks so it never trusts a caller-constructed
 *    Handoff object it did not parse itself).
 * 2. `missing_write_scope` — implement mode requires a non-empty write_scope.
 * 3. `dirty_repo` — `git status --porcelain` in repoRoot must be empty (spec §7.10,
 *    D12): modified/staged/untracked all count; refusal lists the offending paths;
 *    never auto-stash.
 *
 * On success, resolves `baseSha` = current HEAD (spec §8 step 1 — first implement
 * HO of a chain uses fresh HEAD, never a stale base).
 */
export async function checkAdmission(handoff: Handoff, repoRoot: string): Promise<DispatchResult<AdmissionResult>> {
  if (handoff.mode !== 'implement') {
    return fail('BAD_RECORD', `S0 admission only supports mode=implement; got mode=${handoff.mode} (handoff ${handoff.id}).`);
  }

  if (!Array.isArray(handoff.write_scope) || handoff.write_scope.length === 0) {
    return fail('MISSING_WRITE_SCOPE', `Handoff ${handoff.id} (mode=implement) requires a non-empty write_scope.`);
  }

  let statusStdout: string;
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd: repoRoot });
    statusStdout = stdout;
  } catch (err) {
    return fail('ADMISSION_FAILED', `Failed to run "git status --porcelain" in ${repoRoot}.`, err);
  }

  const dirtyPaths = statusStdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (dirtyPaths.length > 0) {
    return fail(
      'DIRTY_REPO',
      `Repository at ${repoRoot} is not clean; refusing admission for handoff ${handoff.id}.`,
      { dirtyPaths },
    );
  }

  let baseSha: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    baseSha = stdout.trim();
  } catch (err) {
    return fail('ADMISSION_FAILED', `Failed to resolve HEAD via "git rev-parse HEAD" in ${repoRoot}.`, err);
  }

  return ok({ handoff, repoRoot, baseSha });
}

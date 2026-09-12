/**
 * §7 admission gate — S4 full 13-check gate (PLN-0004). §7.11 `no_isolation_route`
 * is deferred to S5. §7.4's acceptance/validation requirement needs no separate
 * check here — ho.ts already enforces it as a required field for all four modes
 * at parse time. §7.6-§7.9 (credentials_with_web / unknown_profile /
 * credential_preflight_failed / backend_unreachable) and §7.13
 * (context_budget_exceeded) live in pipeline.ts instead of here: they need facts
 * (resolved model, resolved credentials, the assembled prompt) this module never
 * has. Checks below run in spec order, failing closed on the first violation.
 */
import { execFile as execFileCb } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import type { Handoff, HandoffMode } from './ho.js';

const execFile = promisify(execFileCb);

export interface AdmissionResult {
  handoff: Handoff;
  repoRoot: string;
  baseSha: string;
}

const VALID_MODES: readonly HandoffMode[] = ['implement', 'code_review', 'redteam', 'research'];

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `target` (pre-resolved absolute) is `root` itself or one of its descendants. */
function isWithinRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Strip a trailing `:ro`/`:rw` mode suffix (§6 data_mounts shape) to get the bare filesystem path. */
function mountPathOf(entry: string): string {
  const match = entry.match(/^(.*):(?:ro|rw)$/);
  return match ? match[1]! : entry;
}

/**
 * §7.2 `envelope_exceeds_mode`. Per §6's ceiling table, the only violations
 * possible are: write_scope declared outside `implement` (implement's own
 * requirement that it be non-empty is `missing_write_scope`'s job below, not
 * this check's — a ceiling caps a request, it doesn't impose a floor); and
 * web:true for `code_review`/`redteam` (both never allow it). `research`
 * permits web either way and `implement` permits it opt-in, so neither mode
 * can trip this check on web.
 */
function checkEnvelope(handoff: Handoff): DispatchResult<null> {
  if (handoff.mode !== 'implement' && handoff.write_scope.length > 0) {
    return fail(
      'ENVELOPE_EXCEEDS_MODE',
      `Handoff ${handoff.id} (mode=${handoff.mode}) declares write_scope, exceeding the mode ceiling (write_scope must be empty outside mode=implement).`,
      { mode: handoff.mode, write_scope: handoff.write_scope },
    );
  }

  if ((handoff.mode === 'code_review' || handoff.mode === 'redteam') && handoff.web) {
    return fail(
      'ENVELOPE_EXCEEDS_MODE',
      `Handoff ${handoff.id} (mode=${handoff.mode}) requests web:true, exceeding the mode ceiling (web is never allowed for mode=${handoff.mode}).`,
      { mode: handoff.mode },
    );
  }

  return ok(null);
}

/**
 * §7.3 `stale_write_scope`. Every entry must resolve inside the repo, and
 * either the path itself or its immediate parent directory must already
 * exist — a brand-new top-level directory (e.g. `src/` in an empty repo) is
 * fine because its parent is the repo root, but a multi-level path under a
 * nonexistent ancestor is refused.
 */
async function checkStaleWriteScope(handoff: Handoff, repoRootResolved: string): Promise<DispatchResult<null>> {
  for (const entry of handoff.write_scope) {
    if (isAbsolute(entry)) {
      return fail(
        'STALE_WRITE_SCOPE',
        `Handoff ${handoff.id} write_scope entry "${entry}" is an absolute path; write_scope must be repo-relative.`,
        { entry },
      );
    }

    const resolved = resolve(repoRootResolved, entry);
    if (!isWithinRoot(repoRootResolved, resolved)) {
      return fail(
        'STALE_WRITE_SCOPE',
        `Handoff ${handoff.id} write_scope entry "${entry}" resolves outside the repo root.`,
        { entry },
      );
    }

    if (await pathExists(resolved)) continue;
    if (await pathExists(dirname(resolved))) continue;

    return fail(
      'STALE_WRITE_SCOPE',
      `Handoff ${handoff.id} write_scope entry "${entry}" does not exist, and neither does its parent directory.`,
      { entry },
    );
  }

  return ok(null);
}

/** §7.5 `missing_read_first` — every declared read_first path must exist. */
async function checkMissingReadFirst(handoff: Handoff, repoRootResolved: string): Promise<DispatchResult<null>> {
  for (const entry of handoff.read_first) {
    const resolved = resolve(repoRootResolved, entry);
    if (!(await pathExists(resolved))) {
      return fail('MISSING_READ_FIRST', `Handoff ${handoff.id} read_first entry "${entry}" does not exist.`, { entry });
    }
  }
  return ok(null);
}

/** §7.12 `bad_base_ref` — a declared base_ref must exist and be dispatch-owned. */
async function checkBaseRef(handoff: Handoff, repoRoot: string): Promise<DispatchResult<null>> {
  const baseRef = handoff.base_ref;
  if (baseRef === null) return ok(null);

  if (!baseRef.startsWith('dispatch/')) {
    return fail(
      'BAD_BASE_REF',
      `Handoff ${handoff.id} declares base_ref "${baseRef}", which is not dispatch-owned (must start with "dispatch/").`,
      { base_ref: baseRef },
    );
  }

  try {
    await execFile('git', ['rev-parse', '--verify', baseRef], { cwd: repoRoot });
  } catch (err) {
    return fail(
      'BAD_BASE_REF',
      `Handoff ${handoff.id} declares base_ref "${baseRef}", which does not exist in ${repoRoot}.`,
      err,
    );
  }

  return ok(null);
}

/**
 * §7.14 `bad_data_mount` (2026-09-11 simplified ruling): a declared data mount
 * must be an absolute path, must exist on disk, and must resolve outside the
 * repo root. No rw policy surface.
 */
async function checkDataMounts(handoff: Handoff, repoRootResolved: string): Promise<DispatchResult<null>> {
  for (const entry of handoff.data_mounts) {
    const mountPath = mountPathOf(entry);

    if (!isAbsolute(mountPath)) {
      return fail('BAD_DATA_MOUNT', `Handoff ${handoff.id} data_mounts entry "${entry}" is not an absolute path.`, {
        entry,
      });
    }

    const resolved = resolve(mountPath);
    if (!(await pathExists(resolved))) {
      return fail('BAD_DATA_MOUNT', `Handoff ${handoff.id} data_mounts entry "${entry}" does not exist on disk.`, {
        entry,
      });
    }

    if (isWithinRoot(repoRootResolved, resolved)) {
      return fail(
        'BAD_DATA_MOUNT',
        `Handoff ${handoff.id} data_mounts entry "${entry}" resolves inside the repo root; data mounts must be outside the repo.`,
        { entry },
      );
    }
  }
  return ok(null);
}

/**
 * Run the full §7 admission gate against an already-parsed handoff, in spec
 * order, failing on the first violation. See the module doc above for the
 * check-to-code map, including what's deliberately handled elsewhere.
 *
 * On success, resolves `baseSha` = current HEAD (spec §8 step 1 — first
 * implement HO of a chain uses fresh HEAD, never a stale base).
 */
export async function checkAdmission(handoff: Handoff, repoRoot: string): Promise<DispatchResult<AdmissionResult>> {
  // §7.1 bad_record — defensive re-check; ho.ts already validated this on parse,
  // but admission never trusts a caller-constructed Handoff object it did not
  // parse itself.
  if (!VALID_MODES.includes(handoff.mode)) {
    return fail('BAD_RECORD', `Handoff ${handoff.id} has an invalid mode: ${handoff.mode}.`);
  }

  const envelopeCheck = checkEnvelope(handoff);
  if (!envelopeCheck.ok) return envelopeCheck;

  if (handoff.mode === 'implement' && handoff.write_scope.length === 0) {
    return fail('MISSING_WRITE_SCOPE', `Handoff ${handoff.id} (mode=implement) requires a non-empty write_scope.`);
  }

  const repoRootResolved = resolve(repoRoot);

  const staleScopeCheck = await checkStaleWriteScope(handoff, repoRootResolved);
  if (!staleScopeCheck.ok) return staleScopeCheck;

  const readFirstCheck = await checkMissingReadFirst(handoff, repoRootResolved);
  if (!readFirstCheck.ok) return readFirstCheck;

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

  const baseRefCheck = await checkBaseRef(handoff, repoRoot);
  if (!baseRefCheck.ok) return baseRefCheck;

  const dataMountCheck = await checkDataMounts(handoff, repoRootResolved);
  if (!dataMountCheck.ok) return dataMountCheck;

  let baseSha: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    baseSha = stdout.trim();
  } catch (err) {
    return fail('ADMISSION_FAILED', `Failed to resolve HEAD via "git rev-parse HEAD" in ${repoRoot}.`, err);
  }

  return ok({ handoff, repoRoot, baseSha });
}

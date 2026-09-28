/**
 * §7 admission gate — S4 full 13-check gate (PLN-0004), plus the work-item-
 * existence gate (`checkWorkItemExists`, DEC-0036 WK-0121), which sits outside
 * the upstream §7 numbering. This gate narrows the original WK-0116 / IN-0006
 * initiative-resolution gate: DEC-0036 moved WK→IN connectedness off dispatch
 * admission and onto lint (a status-scoped `ORPHAN_WK` error), so this check
 * now only proves the declared work_item's WK file exists on disk — no
 * initiative read, no IN-#### resolution. §7.11 `no_isolation_route` is
 * deferred to S5. §7.4's acceptance/validation requirement needs no separate
 * check here — ho.ts already enforces it as a required field for all four modes
 * at parse time. §7.6-§7.9 (credentials_with_web / unknown_profile /
 * credential_preflight_failed / backend_unreachable) and §7.13
 * (context_budget_exceeded) live in pipeline.ts instead of here: they need facts
 * (resolved model, resolved credentials, the assembled prompt) this module never
 * has. Checks below run in spec order, failing closed on the first violation.
 * WK-0152 adds `base_drift` (`checkBaseDrift`), run last after baseSha
 * resolution, outside the upstream §7 numbering.
 */
import { execFile as execFileCb } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import type { Handoff, HandoffMode } from './ho.js';
import { probeWikiSource } from './wiki-source.js';
import { validateWriteScopeChain } from './write-scope-chain.js';

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
 * §7.3 `stale_write_scope`. Every entry must be repo-relative and resolve
 * inside the repo, then pass the ancestor-chain check (WK-0163,
 * `validateWriteScopeChain`): walk up to the nearest existing ancestor and
 * require its realpath stay within the repo root's realpath. A brand-new
 * multi-level path (e.g. `tests/golden/smoke.txt` in a repo with no `tests/`)
 * is admitted — pipeline step 9b creates the full hierarchy — but a symlink
 * ancestor that resolves outside the repo is refused (D2 soft posture:
 * within-repo symlinks are fine).
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

    const chainCheck = await validateWriteScopeChain(repoRootResolved, entry);
    if (!chainCheck.ok) return chainCheck;
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
  const labeled: Array<[string, string]> = [
    ...handoff.data_mounts.map((e): [string, string] => [e, 'data_mounts']),
    ...handoff.export_mounts.map((e): [string, string] => [e, 'export_mounts']),
  ];
  for (const [entry, field] of labeled) {
    if (!isAbsolute(entry)) {
      return fail('BAD_DATA_MOUNT', `Handoff ${handoff.id} ${field} entry "${entry}" is not an absolute path.`, {
        entry,
      });
    }

    const resolved = resolve(entry);
    if (!(await pathExists(resolved))) {
      return fail('BAD_DATA_MOUNT', `Handoff ${handoff.id} ${field} entry "${entry}" does not exist on disk.`, {
        entry,
      });
    }

    if (isWithinRoot(repoRootResolved, resolved)) {
      return fail(
        'BAD_DATA_MOUNT',
        `Handoff ${handoff.id} ${field} entry "${entry}" resolves inside the repo root; data mounts must be outside the repo.`,
        { entry },
      );
    }
  }
  return ok(null);
}

/**
 * v2 work-item-existence gate (DEC-0036 WK-0121), narrowed from the original
 * IN-0006 WK-0116 initiative-resolution gate: an `implement`-mode HO must
 * declare a `work_item` (WK-####) whose `wiki/issues/<work_item>.md` file
 * exists on disk. Non-implement modes are WK-optional (DEC-0035) and skip
 * this check entirely. DEC-0036 moved WK→IN connectedness off dispatch
 * admission entirely — that link is now enforced by lint.ts's status-scoped
 * `ORPHAN_WK` check, not here.
 */
export async function checkWorkItemExists(
  handoff: Handoff,
  repoRoot: string,
): Promise<DispatchResult<null>> {
  if (handoff.mode !== 'implement') return ok(null);

  const workItem = handoff.work_item;
  if (workItem === undefined || workItem.trim() === '') {
    return fail(
      'WORK_ITEM_NOT_FOUND',
      `Handoff ${handoff.id} (mode=implement) does not declare a work_item; implement HOs must reference an existing WK.`,
    );
  }

  const repoRootResolved = resolve(repoRoot);
  const wkPath = join(repoRootResolved, 'wiki', 'issues', `${workItem}.md`);

  if (!(await pathExists(wkPath))) {
    return fail(
      'WORK_ITEM_NOT_FOUND',
      `Handoff ${handoff.id} declares work_item "${workItem}", but wiki/issues/${workItem}.md does not exist.`,
      { work_item: workItem },
    );
  }

  return ok(null);
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_LISTED_COMMITS = 20;

function isWikiPath(entry: string): boolean {
  return entry === 'wiki' || entry.startsWith('wiki/');
}

/** Paths whose drift makes an HO stale: what it edits, what it reads, and its ticket. */
function declaredPaths(handoff: Handoff): string[] {
  const paths = [...handoff.write_scope, ...handoff.read_first];
  if (handoff.work_item) paths.push(`wiki/issues/${handoff.work_item}.md`);
  return [...new Set(paths)];
}

interface StampCheck {
  field: 'base_sha' | 'base_wiki_sha';
  stamp: string | undefined;
  cwd: string;
  /** Revision the worker will see; undefined = the working tree (the nested wiki is bound live, DEC-0039). */
  target: string | undefined;
  currentHead: string;
  headCommand: string;
  paths: string[];
}

async function checkStamp(handoff: Handoff, check: StampCheck): Promise<DispatchResult<null>> {
  const fix = `run \`npm run dispatch -- restamp --handoff <path> --dir <repo>\` (or use the MCP restamp tool) to set ${check.field} to the current HEAD (${check.headCommand}; currently ${check.currentHead}), then re-dispatch.`;
  const stamp = check.stamp;

  let valid = stamp !== undefined && FULL_SHA.test(stamp);
  if (valid) {
    try {
      await execFile('git', ['cat-file', '-e', `${stamp}^{commit}`], { cwd: check.cwd });
    } catch {
      valid = false;
    }
  }
  if (!valid || stamp === undefined) {
    return fail(
      'BASE_DRIFT',
      `Handoff ${handoff.id} has no valid ${check.field}. Re-read the task against today's code, then ${fix}`,
      { field: check.field, stamp: stamp ?? null, current: check.currentHead },
    );
  }

  // An empty pathspec would diff the whole repo — nothing declared here, nothing to drift.
  if (check.paths.length === 0) return ok(null);

  const range = check.target === undefined ? [stamp] : [stamp, check.target];
  let changed: string[];
  let commits: string[];
  try {
    const diff = await execFile('git', ['diff', '--name-only', ...range, '--', ...check.paths], { cwd: check.cwd });
    changed = diff.stdout.split('\n').filter((line) => line.length > 0);
    if (check.target === undefined) {
      // Working-tree comparison (the live-bound nested wiki, DEC-0039): `git diff`
      // cannot report a file git has never tracked, but the worker sees it (decision 9).
      // Fold in ONLY untracked (`??`) entries: tracked changes are already covered by
      // the stamp diff above, and `git status` compares to HEAD, not the stamp —
      // folding tracked lines would refuse a working tree that matches the stamp.
      const status = await execFile('git', ['status', '--porcelain', '--', ...check.paths], { cwd: check.cwd });
      for (const line of status.stdout.split('\n')) {
        if (!line.startsWith('?? ')) continue;
        const path = line.slice(3).trim();
        if (path.length > 0 && !changed.includes(path)) changed.push(path);
      }
    }
    if (changed.length === 0) return ok(null);
    const log = await execFile(
      'git',
      ['log', '--oneline', `-n${MAX_LISTED_COMMITS}`, `${stamp}..${check.target ?? 'HEAD'}`, '--', ...check.paths],
      { cwd: check.cwd },
    );
    commits = log.stdout.split('\n').filter((line) => line.length > 0);
  } catch (err) {
    return fail('ADMISSION_FAILED', `Failed to compute drift since ${check.field} ${stamp} in ${check.cwd}.`, err);
  }

  const workItem = handoff.work_item ? ` and ${handoff.work_item}` : '';
  return fail(
    'BASE_DRIFT',
    [
      `Handoff ${handoff.id}: ${changed.length} declared file(s) changed since ${check.field} ${stamp}.`,
      `Changed: ${changed.join(', ')}`,
      commits.length > 0 ? `Commits:\n${commits.map((c) => `  ${c}`).join('\n')}` : 'Commits: none listed (uncommitted changes or rewritten history)',
      `Re-read these changes against ${handoff.id}${workItem}. Fix whatever is stale and commit, then ${fix}`,
    ].join('\n'),
    { field: check.field, stamp, current: check.currentHead, changed, commits },
  );
}

/**
 * WK-0152 `base_drift`: a fresh-HEAD HO (base_ref null — spec §8's "never a
 * stale base" path) must carry the commit it was checked against, and is
 * refused if any declared path changed since. Chained HOs (base_ref set) are
 * exempt: they run on an immutable dispatch/ branch (delivery.ts's CAS push
 * never moves an existing branch), and the orchestrator updates their WK
 * mid-chain by design.
 */
async function checkBaseDrift(handoff: Handoff, repoRoot: string, baseSha: string): Promise<DispatchResult<null>> {
  if (handoff.base_ref !== null) return ok(null);

  const wiki = await probeWikiSource(repoRoot);
  if (!wiki.ok) return fail('ADMISSION_FAILED', wiki.message, wiki.detail);

  const paths = declaredPaths(handoff);
  const nested = wiki.data.shape === 'nested-private';

  const codeCheck = await checkStamp(handoff, {
    field: 'base_sha',
    stamp: handoff.base_sha,
    cwd: repoRoot,
    target: baseSha,
    currentHead: baseSha,
    headCommand: 'git rev-parse HEAD',
    paths: nested ? paths.filter((p) => !isWikiPath(p)) : paths,
  });
  if (!codeCheck.ok || !nested) return codeCheck;

  return checkStamp(handoff, {
    field: 'base_wiki_sha',
    stamp: handoff.base_wiki_sha,
    cwd: join(repoRoot, 'wiki'),
    target: undefined,
    currentHead: wiki.data.head ?? '',
    headCommand: 'git -C wiki rev-parse HEAD',
    paths: paths.filter(isWikiPath).map((p) => (p === 'wiki' || p === 'wiki/' ? '.' : p.slice('wiki/'.length))),
  });
}

/**
 * Run the full §7 admission gate against an already-parsed handoff, in spec
 * order, failing on the first violation. See the module doc above for the
 * check-to-code map, including what's deliberately handled elsewhere.
 *
 * On success, resolves `baseSha` = current HEAD (spec §8 step 1 — first
 * implement HO of a chain uses fresh HEAD, never a stale base), then refuses
 * `BASE_DRIFT` if a fresh-HEAD HO's declared paths changed since its
 * `base_sha` / `base_wiki_sha` (WK-0152).
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
    const statusArgs = ['status', '--porcelain', '--'];
    for (const entry of handoff.write_scope) {
      statusArgs.push(entry);
    }
    const { stdout } = await execFile('git', statusArgs, { cwd: repoRoot });
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

  const workItemExistsCheck = await checkWorkItemExists(handoff, repoRoot);
  if (!workItemExistsCheck.ok) return workItemExistsCheck;

  let baseSha: string;
  try {
    const args = handoff.base_ref !== null ? ['rev-parse', '--verify', handoff.base_ref] : ['rev-parse', 'HEAD'];
    const { stdout } = await execFile('git', args, { cwd: repoRoot });
    baseSha = stdout.trim();
  } catch (err) {
    return fail(
      'ADMISSION_FAILED',
      handoff.base_ref !== null
        ? `Failed to resolve base_ref "${handoff.base_ref}" via "git rev-parse --verify" in ${repoRoot}.`
        : `Failed to resolve HEAD via "git rev-parse HEAD" in ${repoRoot}.`,
      err,
    );
  }

  const baseDriftCheck = await checkBaseDrift(handoff, repoRoot, baseSha);
  if (!baseDriftCheck.ok) return baseDriftCheck;

  return ok({ handoff, repoRoot, baseSha });
}

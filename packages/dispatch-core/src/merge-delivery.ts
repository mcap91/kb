/**
 * WK-0132 Slice 3 — `merge-delivery` MCP tool. Given an implement HO whose
 * delivery has passed code review, merges its delivery branch
 * (`dispatch/<handoff_id>`) into the current branch and deletes the branch.
 * Local only — no remote push; push is the operator's decision (WK-0132
 * spec, Slice 3).
 *
 * `dispatch/<handoff_id>` is the head of a chain: a fix-up delivery builds on
 * the branch it fixes, so `HEAD..dispatch/<handoff_id>` carries every member.
 * After the merge each fully merged member branch is deleted too.
 *
 * Preconditions, checked in order, fail closed throughout:
 *   0. Branch `dispatch/<handoff_id>` exists as a local branch.
 *   1. Review evidence: the governing review is the newest `code_review` HO in
 *      `wiki/handoffs/` whose `base_ref` is `dispatch/<id>` for any chain
 *      member (the head included); it has a response doc
 *      (`<review_id>.response.md`). Evidence is read from the response
 *      doc's frontmatter (`recovery_outcome`, `recovery_valid`,
 *      `worker_report_chars` — stamped by capture.ts's `writeResponseDoc`),
 *      never re-derived by parsing the rendered markdown body (WK-0166: the
 *      old `## Worker Report` regex stopped at the FIRST `\n## `, which is
 *      the worker's own heading when its report starts with one). A
 *      `recovery_valid: true` doc reporting `no_findings` or
 *      `passed_no_blocking_or_medium_findings` merges with
 *      `verdict: 'structured'`; a non-passing outcome refuses
 *      (ADMISSION_FAILED) — there is no operator override in this slice.
 *      DEC-0037: code_review/redteam is prose-first, so an absent or
 *      invalid block is not itself a gate — when `worker_report_chars > 0`,
 *      the merge proceeds with `verdict: 'advisory'` (the
 *      orchestrator/operator reads the prose). Only a missing review HO, a
 *      missing response doc, an empty report (`worker_report_chars === 0`),
 *      or a response doc that predates frontmatter-based evidence (all
 *      three fields absent) refuses.
 *   2. Commits after the review: its `reviewed_sha` is the head or an ancestor of
 *      it, and every later commit is a dispatch delivery (a hand edit refuses, no
 *      override); every commit in the range is a chain member (`walkChain`).
 *   3. The working tree is clean within the merge's change set — not
 *      repo-wide. Anything staged (the index differs from HEAD) refuses
 *      outright, listing the staged paths: git aborts any merge whose index
 *      differs from HEAD regardless of which paths are involved (git-merge(1)
 *      PRE-MERGE CHECKS). Otherwise, only a dirty path (unstaged or
 *      untracked) that collides with the paths `git diff HEAD...<branch>`
 *      reports — exact match, or either path a directory prefix of the
 *      other, matching git's own refusal on a local/branch path clash —
 *      refuses, listing just the colliding paths. An unrelated dirty file
 *      anywhere else in the repo never blocks the merge.
 *   3b. Host validation evidence (WK-0294, DEC-0047 A1 ruling 2, A2 R6/R8,
 *      A4.1/A4.5): the evidence is the chain head's — `evidenceForDelivery`
 *      for the head's latest delivered run and the head sha, reused when it
 *      passed for that sha and registry, produced now otherwise. Missing
 *      stamps on the review, a head with no delivered run, evidence that
 *      cannot be read or produced, evidence of another run, or a failing
 *      outcome refuse unless the caller passes an `override` with a reason;
 *      the override's provenance is committed fail-closed (isolated index)
 *      before the merge, so an override merge is distinguishable from a gated
 *      one in history.
 *   4. The merge succeeds (fast-forward or a real merge) with no conflict —
 *      a conflicting merge is aborted and surfaced to the operator. The
 *      merge names the gated sha, never the branch name.
 *
 * Only after all of these pass is the delivery branch deleted. Git behavior
 * relied on here (plain non-fast-forward `git merge <branch>` with no `-m`
 * completes without invoking an interactive editor when spawned with no TTY;
 * `git branch -d` succeeds immediately after the branch that authored it has
 * just been merged) was captured against a real repo via `execFile`, not
 * assumed — see WK-0132 Slice 3 implementation notes.
 */
import { execFile as execFileCb } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { porcelainPaths } from './admission.js';
import { commitPaths } from './commit-artifacts.js';
import { DISPATCH_COMMIT_SUBJECT, latestDeliveredRun, walkChain } from './derive-review.js';
import { parseHandoffContent, type Handoff } from './ho.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { evidenceForDelivery, JAIL_HERMETICITY_TEACHING_SENTENCE, type ValidationEvidence } from './host-validation.js';
import { loadValidationRegistry } from './repo-config.js';

const execFile = promisify(execFileCb);

/**
 * Operator override of the host-validation gate (DEC-0047 A2 R8). `actor` is
 * self-reported and NOT authenticated — no identity exists on the MCP path —
 * and is recorded as such alongside the call surface.
 */
export interface MergeOverride {
  reason: string;
  actor: string;
  surface: 'mcp' | 'cli' | 'api';
}

export interface MergeDeliveryOpts {
  dir: string;
  handoff_id: string;
  override?: MergeOverride;
}

export interface MergeDeliveryResult {
  mergedBranch: string;
  mergeSha: string;
  reviewId: string;
  reviewOutcome: string;
  /**
   * 'structured' when a valid `kb-dispatch-recovery.v1` block drove the outcome; 'advisory'
   * when the merge proceeded on prose-only review evidence — DEC-0037: the block is optional
   * structured metadata for code_review/redteam, never a gate. Optional for backward
   * compatibility with callers written before this field existed.
   */
  verdict?: 'structured' | 'advisory';
  /** WK-0294: `evidence` when host validation gated the merge; `override` when an operator override did. */
  gate: 'evidence' | 'override';
  /** The sha that was merged — the evidence sha (or the branch head under an override with no evidence). */
  mergedSha: string;
  /** Repo-relative path of the committed override provenance record; set only when `gate` is `override`. */
  overrideRecord?: string;
  /** `code_review` handoffs on chain members that have a response doc. */
  reviewCount: number;
  /** Implement delivery members of the chain (the head included). */
  implementDeliveries: number;
  /** Delivery branches (the head's and fully merged intermediate members') deleted after the merge. */
  deletedBranches: string[];
  /** Delivery branches that were left in place, each with the reason. */
  keptBranches: { branch: string; reason: string }[];
}

/** `FindingsOutcome` values that gate a merge open (recovery-block.ts's `FINDINGS_OUTCOMES` minus `changes_requested`). */
const PASSING_OUTCOMES: readonly string[] = ['no_findings', 'passed_no_blocking_or_medium_findings'];

interface ResponseDocEvidence {
  recoveryOutcome: string | undefined;
  recoveryValid: boolean | undefined;
  workerReportChars: number | undefined;
}

/**
 * Parse a response doc's YAML frontmatter for the three fields capture.ts's
 * `writeResponseDoc` stamps (WK-0166): `recovery_outcome`, `recovery_valid`,
 * `worker_report_chars`. Mirrors the `---`-delimited split + line-oriented
 * `key: value` scan used elsewhere in this codebase (ho.ts's
 * `splitFrontmatter`/`parseFrontmatterYaml`, pipeline.ts's
 * `mergeProvenanceFrontmatter`), scoped to just these three scalars. A field
 * is `undefined` only when its line is entirely absent — distinct from an
 * empty string value, which means present-but-blank.
 */
function parseResponseDocFrontmatter(content: string): ResponseDocEvidence {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { recoveryOutcome: undefined, recoveryValid: undefined, workerReportChars: undefined };
  }

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;
    fields[kvMatch[1]!] = (kvMatch[2] ?? '').trim();
  }

  return {
    recoveryOutcome: fields.recovery_outcome,
    recoveryValid: fields.recovery_valid === undefined ? undefined : fields.recovery_valid === 'true',
    workerReportChars: fields.worker_report_chars === undefined ? undefined : Number.parseInt(fields.worker_report_chars, 10),
  };
}

/**
 * Numeric id parsed from a handoff id like `HO-0142` — the ordering key
 * `selectLatestReview` uses. Returns `null` when the id doesn't match the
 * 4-digit `HO-(\d{4})` shape.
 */
function parseHandoffNumericId(id: string): number | null {
  const match = id.match(/^HO-(\d{4})$/);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

/**
 * WK-0207: among a set of `code_review` HOs that all match the same delivery
 * branch, the newest matching review wins — never the first one encountered
 * in readdir order. Pure (no I/O); selects by the numeric id parsed from the
 * HO id, never by readdir order or file mtime. Returns `null` for an empty
 * candidate list.
 */
export function selectLatestReview(candidates: Handoff[]): Handoff | null {
  let latest: Handoff | null = null;
  let latestNumericId = -Infinity;
  for (const candidate of candidates) {
    const numericId = parseHandoffNumericId(candidate.id);
    if (numericId === null) continue;
    if (latest === null || numericId > latestNumericId) {
      latest = candidate;
      latestNumericId = numericId;
    }
  }
  return latest;
}

/** Every `code_review` HO in `wiki/handoffs/`, parsed; unreadable or unparsable files are skipped. */
async function readCodeReviews(dir: string): Promise<DispatchResult<Handoff[]>> {
  const handoffsDir = join(dir, 'wiki', 'handoffs');

  let files: string[];
  try {
    files = await readdir(handoffsDir);
  } catch (err) {
    return fail('ADMISSION_FAILED', `Could not read handoffs directory: ${handoffsDir}`, err);
  }

  const reviews: Handoff[] = [];
  for (const file of files.filter((f) => /^HO-\d{4}\.md$/.test(f))) {
    let content: string;
    try {
      content = await readFile(join(handoffsDir, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseHandoffContent(content, file);
    if (parsed.ok && parsed.data.mode === 'code_review') reviews.push(parsed.data);
  }
  return ok(reviews);
}

/** Whether the review's response doc exists in `wiki/handoffs/`. */
async function hasResponseDoc(dir: string, reviewId: string): Promise<boolean> {
  try {
    await readFile(join(dir, 'wiki', 'handoffs', `${reviewId}.response.md`), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the governing review's response doc frontmatter evidence fields
 * (WK-0166 — no markdown re-parsing). Fails closed on: no response doc, a
 * response doc that predates frontmatter-based evidence (all three fields
 * absent), an empty report (`worker_report_chars === 0`), or a structured
 * block reporting a non-passing outcome. A missing/invalid block backed by
 * real review content (`worker_report_chars > 0`) returns
 * `verdict: 'advisory'` instead of failing (DEC-0037 — the block is optional
 * metadata, never a gate, for code_review/redteam).
 */
async function checkReviewEvidence(
  dir: string,
  reviewHandoff: Handoff,
): Promise<DispatchResult<{ outcome: string; verdict: 'structured' | 'advisory' }>> {
  const reviewId = reviewHandoff.id;
  const reviewResponsePath = join(dir, 'wiki', 'handoffs', `${reviewId}.response.md`);
  let reviewResponseContent: string;
  try {
    reviewResponseContent = await readFile(reviewResponsePath, 'utf8');
  } catch {
    return fail('ADMISSION_FAILED', `Review response doc missing: ${reviewId}.response.md`);
  }

  const { recoveryOutcome, recoveryValid, workerReportChars } = parseResponseDocFrontmatter(reviewResponseContent);

  // A response doc predating frontmatter-based evidence has none of the
  // three fields — refuse loudly rather than silently falling back to a
  // legacy markdown re-parse (WK-0166: no regex fallback, no dual-path
  // parsing).
  if (recoveryOutcome === undefined && recoveryValid === undefined && workerReportChars === undefined) {
    return fail(
      'ADMISSION_FAILED',
      `Review ${reviewId} response doc predates frontmatter-based evidence — re-run the review to generate updated fields`,
    );
  }

  if (recoveryValid === true) {
    if (recoveryOutcome !== undefined && PASSING_OUTCOMES.includes(recoveryOutcome)) {
      return ok({ outcome: recoveryOutcome, verdict: 'structured' as const });
    }
    return fail('ADMISSION_FAILED', `Review ${reviewId} outcome is "${recoveryOutcome}" — merge blocked`);
  }

  // DEC-0037: code_review/redteam is prose-first — the recovery block is optional
  // structured metadata, never a gate. A missing/invalid block still merges as long
  // as the response doc has real review content; only a genuinely empty report (no
  // evidence a review ran at all) fails closed.
  if ((workerReportChars ?? 0) > 0) {
    return ok({ outcome: 'advisory', verdict: 'advisory' as const });
  }

  return fail('ADMISSION_FAILED', `Review ${reviewId} response is empty — no evidence of a completed review`);
}

/**
 * Commits `HEAD..branchSha` newest first with their subjects, read leniently
 * (no handoff parsing) so the review lookup and the commits-after-review check
 * can name a bad commit before `walkChain` rejects the range.
 */
async function listUnmergedCommits(dir: string, range: string): Promise<DispatchResult<{ sha: string; subject: string }[]>> {
  try {
    const { stdout } = await execFile('git', ['log', '--topo-order', '--format=%H%x09%s', range], { cwd: dir });
    return ok(
      stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const [sha = '', ...subject] = line.split('\t');
          return { sha, subject: subject.join('\t') };
        }),
    );
  } catch (err) {
    return fail('BAD_RECORD', `Failed to list commits in ${range} in ${dir}.`, err);
  }
}

/**
 * The governing review is bound to `reviewedSha` (R). The head (S) may sit
 * past R only on dispatch implement deliveries: R must be S or an ancestor of
 * S, and every commit in `R..S` must carry a dispatch delivery subject. Any
 * other commit is unreviewed code, and an override cannot merge it.
 */
async function checkCommitsAfterReview(
  dir: string,
  handoffId: string,
  review: { id: string; sha: string },
  branchSha: string,
): Promise<DispatchResult<null>> {
  const moved = (detail: string): DispatchResult<null> =>
    fail(
      'ADMISSION_FAILED',
      `dispatch/${handoffId} is at ${branchSha}, but review ${review.id} was derived for ${review.sha} — the branch moved after the review was derived: ${detail}. Run derive-review for ${handoffId} and review the new head; an override cannot merge an unreviewed head.`,
      { branchSha, reviewedSha: review.sha },
    );
  if (review.sha === branchSha) return ok(null);

  try {
    await execFile('git', ['merge-base', '--is-ancestor', review.sha, branchSha], { cwd: dir });
  } catch (err) {
    // `merge-base --is-ancestor` exits 1 for "not an ancestor"; any other failure is a git error.
    if ((err as { code?: unknown }).code === 1) return moved(`${review.sha} is not an ancestor of ${branchSha}`);
    return fail('ADMISSION_FAILED', `Failed to compare ${review.sha} with ${branchSha} in ${dir}.`, err);
  }

  const after = await listUnmergedCommits(dir, `${review.sha}..${branchSha}`);
  if (!after.ok) return after;
  const offender = after.data.find((c) => !DISPATCH_COMMIT_SUBJECT.test(c.subject));
  if (offender !== undefined) {
    return moved(`commit ${offender.sha} "${offender.subject}" is not a dispatch implement delivery`);
  }
  return ok(null);
}

/** `path` is `other` itself, or sits inside the directory `other` names (or vice versa). */
function collidesWith(path: string, other: string): boolean {
  return path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`);
}

/**
 * Scoped dirty-repo check — replaces the old repo-wide refusal. Runs after
 * the branch is resolved, since the change set needs it.
 *
 * Staged paths (index differs from HEAD) refuse unconditionally: git aborts
 * any merge whose index differs from HEAD, regardless of path (git-merge(1)
 * PRE-MERGE CHECKS). Otherwise, a dirty path (unstaged or untracked) is only
 * a problem when it collides with the merge's change set — the paths
 * `git diff HEAD...<branch>` reports, renames off so a rename's old and new
 * paths both land in the set.
 */
async function checkScopedDirtyRepo(dir: string, branchName: string): Promise<DispatchResult<null>> {
  let stagedOut: string;
  try {
    const { stdout } = await execFile('git', ['diff', '--cached', '--name-only', '-z'], { cwd: dir });
    stagedOut = stdout;
  } catch (err) {
    return fail('ADMISSION_FAILED', `Failed to run "git diff --cached --name-only -z" in ${dir}.`, err);
  }
  const stagedPaths = stagedOut.split('\0').filter((p) => p.length > 0);
  if (stagedPaths.length > 0) {
    return fail('DIRTY_REPO', 'Staged changes are present — refusing merge (git aborts any merge whose index differs from HEAD)', {
      dirtyPaths: stagedPaths,
    });
  }

  let dirtyPaths: string[];
  try {
    dirtyPaths = await porcelainPaths(dir, []);
  } catch (err) {
    return fail('ADMISSION_FAILED', `Failed to run "git status --porcelain" in ${dir}.`, err);
  }
  if (dirtyPaths.length === 0) return ok(null);

  let changeSetOut: string;
  try {
    const { stdout } = await execFile('git', ['diff', '--name-only', '-z', '--no-renames', `HEAD...${branchName}`], { cwd: dir });
    changeSetOut = stdout;
  } catch (err) {
    return fail('ADMISSION_FAILED', `Failed to compute the change set for ${branchName} in ${dir}.`, err);
  }
  const changeSet = changeSetOut.split('\0').filter((p) => p.length > 0);

  const collisions = dirtyPaths.filter((d) => changeSet.some((c) => collidesWith(d, c)));
  if (collisions.length > 0) {
    return fail('DIRTY_REPO', "A dirty path collides with the merge's change set — refusing merge", {
      dirtyPaths: collisions,
    });
  }
  return ok(null);
}

interface ValidationGate {
  /** Sha to merge: the evidence sha, or the branch head when there is no usable evidence. */
  sha: string;
  /** Overridable gate failures; empty = the evidence gates the merge open. */
  problems: string[];
  evidence: ValidationEvidence | null;
  /** The chain head run that holds (or would hold) the evidence, recorded in an override whether or not evidence was found. */
  reviewedRun: string | null;
}

/**
 * Host-validation gate (WK-0294). The evidence is the chain head's: taken from
 * the head's latest delivered run for the head sha, reused when it matches the
 * sha and registry, produced on the spot otherwise (`evidenceForDelivery`).
 * Whether the reviewed commits are what merges is `checkCommitsAfterReview`'s
 * job, not this gate's. Evidence that is unavailable or red is an overridable
 * problem.
 */
async function checkValidationEvidence(
  dir: string,
  handoffId: string,
  review: { id: string; run: string | undefined; sha: string | undefined },
  branchSha: string,
): Promise<DispatchResult<ValidationGate>> {
  const unbound = (runId: string | null, problem: string): DispatchResult<ValidationGate> =>
    ok({ sha: branchSha, evidence: null, reviewedRun: runId, problems: [problem] });
  if (review.run === undefined) {
    return unbound(null, `review ${review.id} carries no reviewed_run stamp, so no host validation evidence is bound to it (derive the review with derive-review)`);
  }
  if (review.sha === undefined) {
    return unbound(review.run, `review ${review.id} carries no reviewed_sha stamp, so it is not bound to a delivery commit (derive the review with derive-review)`);
  }

  const runId = await latestDeliveredRun(dir, handoffId);
  if (runId === undefined) {
    return unbound(null, `${handoffId} has no delivered run to hold host validation evidence (dispatch it, or run derive-review)`);
  }
  const registry = await loadValidationRegistry(dir);
  if (!registry.ok) return registry;
  const produced = await evidenceForDelivery({
    dir,
    handoffId,
    runId,
    deliveryBranch: `dispatch/${handoffId}`,
    deliverySha: branchSha,
    registry: registry.data,
  });
  if (!produced.ok) return unbound(runId, `host validation evidence is unreadable or could not be produced: ${produced.message}`);
  const evidence = produced.data;
  if (evidence.run_id !== runId) {
    return unbound(runId, `evidence belongs to run ${evidence.run_id}, but the latest delivered run of ${handoffId} is ${runId}`);
  }

  const problems: string[] = [];
  if (evidence.outcome !== 'pass') {
    const failed = [evidence.setup, ...evidence.commands].filter((c) => c !== null && c.result === 'fail').map((c) => c?.name);
    problems.push(`host validation failed (${failed.join(', ')})`);
  }
  return ok({ sha: evidence.delivery_sha, evidence, reviewedRun: runId, problems });
}

/**
 * Write and commit the override provenance record (A2 R8) before merging.
 * Fail-closed: if the record cannot be committed, the file is removed and
 * the merge is refused.
 */
async function commitOverrideRecord(
  dir: string,
  handoffId: string,
  reviewId: string,
  override: MergeOverride,
  gate: ValidationGate,
): Promise<DispatchResult<string>> {
  const relativePath = `wiki/handoffs/${handoffId}.merge-override.json`;
  const path = join(dir, relativePath);
  const record = {
    schema_version: 1,
    handoff_id: handoffId,
    review_id: reviewId,
    merged_sha: gate.sha,
    run_id: gate.reviewedRun,
    reason: override.reason,
    actor: override.actor,
    actor_authenticated: false,
    surface: override.surface,
    problems: gate.problems,
    evidence:
      gate.evidence === null
        ? null
        : {
            outcome: gate.evidence.outcome,
            registry_fingerprint: gate.evidence.registry_fingerprint,
            results: [gate.evidence.setup, ...gate.evidence.commands]
              .filter((c) => c !== null)
              .map((c) => ({ name: c?.name, result: c?.result, exit_code: c?.exit_code, timed_out: c?.timed_out })),
          },
    recorded_at: new Date().toISOString(),
  };
  try {
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write override record ${relativePath}; merge refused.`, err);
  }
  const committed = await commitPaths({
    cwd: join(dir, 'wiki', 'handoffs'),
    paths: [path],
    message: `chore: merge-delivery override for ${handoffId} (${override.surface}, actor self-reported: ${override.actor})`,
  });
  if (!committed.ok || committed.data === null) {
    await rm(path, { force: true }).catch(() => {});
    return fail(
      'FILE_WRITE_ERROR',
      `Override record ${relativePath} could not be committed; merge refused (fail-closed). ${committed.ok ? 'Nothing was staged.' : committed.message}`,
    );
  }
  return ok(relativePath);
}

/**
 * Delete the delivery branch of every chain member that the merge fully
 * absorbed (`git branch -d`, never forced). A branch that no longer exists is
 * skipped; one that stays is reported with its reason, never a merge failure.
 */
async function deleteMergedBranches(
  dir: string,
  branches: readonly string[],
): Promise<{ deleted: string[]; kept: { branch: string; reason: string }[] }> {
  const deleted: string[] = [];
  const kept: { branch: string; reason: string }[] = [];
  for (const branch of branches) {
    try {
      await execFile('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: dir });
    } catch {
      continue; // already gone
    }
    try {
      await execFile('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd: dir });
    } catch (err) {
      kept.push({ branch, reason: (err as { code?: unknown }).code === 1 ? 'not fully merged into the merge target' : `could not compare with the merge target: ${String(err)}` });
      continue;
    }
    try {
      await execFile('git', ['branch', '-d', branch], { cwd: dir });
      deleted.push(branch);
    } catch (err) {
      kept.push({ branch, reason: `git branch -d failed: ${String(err)}` });
    }
  }
  return { deleted, kept };
}

/**
 * Merge a dispatch delivery chain's head branch (`dispatch/<handoff_id>`) into
 * the current branch after confirming a passing code review of the chain
 * exists. Local only — never pushes to a remote (WK-0132 Slice 3: push is the
 * operator's decision). Never throws — every failure path returns a
 * `DispatchResult`.
 */
export async function mergeDelivery(opts: MergeDeliveryOpts): Promise<DispatchResult<MergeDeliveryResult>> {
  const { dir, handoff_id } = opts;
  const branchName = `dispatch/${handoff_id}`;

  // 1. Delivery branch must exist.
  let branchSha: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`], { cwd: dir });
    branchSha = stdout.trim();
  } catch {
    return fail('BAD_RECORD', `Branch ${branchName} does not exist`);
  }

  // 2. The governing review: the newest code_review of any delivery in HEAD..branch (the head included).
  const unmerged = await listUnmergedCommits(dir, `HEAD..${branchName}`);
  if (!unmerged.ok) return unmerged;
  const chainIds = new Set([handoff_id]);
  for (const commit of unmerged.data) {
    const id = DISPATCH_COMMIT_SUBJECT.exec(commit.subject)?.[1];
    if (id !== undefined) chainIds.add(id);
  }
  const chainBranches = new Set([...chainIds].map((id) => `dispatch/${id}`));
  const reviews = await readCodeReviews(dir);
  if (!reviews.ok) return reviews;
  const chainReviews = reviews.data.filter((r) => r.base_ref !== null && chainBranches.has(r.base_ref));
  const reviewHandoff = selectLatestReview(chainReviews);
  if (!reviewHandoff) {
    return fail('ADMISSION_FAILED', `No code_review HO found with base_ref: ${[...chainBranches].join(' or ')}`);
  }
  const reviewId = reviewHandoff.id;
  const reviewedRun = reviewHandoff.reviewed_run;
  const reviewedSha = reviewHandoff.reviewed_sha;

  // 3. The review must pass; the head may sit past the reviewed sha only on dispatch deliveries.
  const reviewCheck = await checkReviewEvidence(dir, reviewHandoff);
  if (!reviewCheck.ok) return reviewCheck;
  const { outcome, verdict } = reviewCheck.data;
  if (reviewedSha !== undefined) {
    const rangeCheck = await checkCommitsAfterReview(dir, handoff_id, { id: reviewId, sha: reviewedSha }, branchSha);
    if (!rangeCheck.ok) return rangeCheck;
  }

  // 4. Every commit in the range is a delivery of an implement handoff — the chain, strictly.
  const chain = await walkChain(dir, branchName, handoff_id);
  if (!chain.ok) return chain;
  const members = chain.data.membersNewestFirst;
  let reviewCount = 0;
  for (const review of chainReviews) {
    if (members.some((m) => review.base_ref === `dispatch/${m.hoId}`) && (await hasResponseDoc(dir, review.id))) reviewCount += 1;
  }

  // 5. Working tree must be clean within the merge's change set — see header.
  const dirtyCheck = await checkScopedDirtyRepo(dir, branchName);
  if (!dirtyCheck.ok) return dirtyCheck;

  // 5b. Host validation evidence for the head (WK-0294) — or an audited override.
  const gateCheck = await checkValidationEvidence(dir, handoff_id, { id: reviewId, run: reviewedRun, sha: reviewedSha }, branchSha);
  if (!gateCheck.ok) return gateCheck;
  const gate = gateCheck.data;
  let overrideRecord: string | undefined;
  if (gate.problems.length > 0) {
    const override = opts.override;
    if (override === undefined) {
      // WK-0306 (Resolution 1): the teaching sentence rides only a REGISTERED
      // COMMAND failure (never a setup-only failure, never the other refusal
      // kinds below — missing/unreadable/other-run/stale-registry evidence —
      // where no command ran to teach anything about).
      const teaching = gate.evidence !== null && gate.evidence.commands.some((c) => c.result === 'fail')
        ? ` ${JAIL_HERMETICITY_TEACHING_SENTENCE}.`
        : '';
      return fail(
        'ADMISSION_FAILED',
        `Host validation gate refused merge of ${branchName}: ${gate.problems.join('; ')}. Fix and re-derive, or merge with an override carrying a reason.${teaching}`,
        { problems: gate.problems },
      );
    }
    if (override.reason.trim() === '' || override.actor.trim() === '') {
      return fail('BAD_RECORD', 'A merge override requires a non-empty reason and actor.');
    }
    const recorded = await commitOverrideRecord(dir, handoff_id, reviewId, override, gate);
    if (!recorded.ok) return recorded;
    overrideRecord = recorded.data;
  }

  // 4. Merge the gated sha — fast-forward if possible, a real merge if needed, abort + refuse on conflict.
  try {
    await execFile('git', ['merge', gate.sha], { cwd: dir });
  } catch {
    await execFile('git', ['merge', '--abort'], { cwd: dir }).catch(() => {});
    return fail('ADMISSION_FAILED', `Merge conflict with ${branchName} — surface to operator`);
  }

  let mergeSha: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: dir });
    mergeSha = stdout.trim();
  } catch (err) {
    return fail('ADMISSION_FAILED', `Merge succeeded but could not resolve HEAD sha in ${dir}.`, err);
  }

  // 5. Delete the head's branch and each chain member's — only reached after a
  // successful merge, only for branches git confirms are fully merged.
  const branches = await deleteMergedBranches(dir, [branchName, ...members.slice(1).map((m) => `dispatch/${m.hoId}`)]);

  return ok({
    mergedBranch: branchName,
    mergeSha,
    reviewId,
    reviewOutcome: outcome,
    verdict,
    gate: overrideRecord === undefined ? 'evidence' : 'override',
    mergedSha: gate.sha,
    reviewCount,
    implementDeliveries: members.length,
    deletedBranches: branches.deleted,
    keptBranches: branches.kept,
    ...(overrideRecord !== undefined ? { overrideRecord } : {}),
  });
}

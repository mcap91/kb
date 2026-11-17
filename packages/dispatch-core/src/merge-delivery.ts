/**
 * `merge-delivery` MCP tool. Given an implement HO whose delivery has passed
 * code review, merges its delivery branch (`dispatch/<handoff_id>`) into the
 * current branch and deletes the branch. Local only — no remote push; push is
 * the operator's decision.
 *
 * `dispatch/<handoff_id>` is the head of a chain: a fix-up delivery builds on
 * the branch it fixes, so `HEAD..dispatch/<handoff_id>` carries every member.
 * After the merge each fully merged member branch is deleted too.
 *
 * Trust boundary: a chain commit is recognised as a dispatch delivery by its
 * commit subject and its handoff's mode, not by a recorded run sha, so write
 * access to the repository is trusted. Judgments cover `code_review` findings
 * only; `redteam` handoffs are not judged at merge.
 *
 * Preconditions, checked in order, fail closed throughout:
 *   1. Branch `dispatch/<handoff_id>` exists as a local branch.
 *   2. Review evidence: the governing review is the newest FINISHED
 *      `code_review` HO in `wiki/handoffs/` whose `base_ref` is `dispatch/<id>`
 *      for any chain member (the head included). Finished means its response
 *      doc (`<review_id>.response.md`) exists with a non-empty report; a review
 *      that was derived and never finished is ignored for governing. When the
 *      chain has reviews and none is finished, the merge refuses, naming each
 *      one and its state. Evidence is read from the response doc's frontmatter
 *      (`recovery_outcome`, `recovery_valid`, `worker_report_chars` — stamped by
 *      capture.ts's `writeResponseDoc`), never re-derived by parsing the
 *      rendered markdown body (the old `## Worker Report` regex stopped at the
 *      first `\n## `, which is the worker's own heading when its report starts
 *      with one). A `recovery_valid: true` doc merges with `verdict:
 *      'structured'` whatever its outcome: a review advises, it does not veto
 *      (see 5). code_review/redteam is prose-first, so an absent or invalid
 *      block is not itself a gate — when `worker_report_chars > 0`, the merge
 *      proceeds with `verdict: 'advisory'` (the orchestrator/operator reads the
 *      prose). Only a missing review HO, no finished review, or a response doc
 *      that predates frontmatter-based evidence (all three fields absent) refuses.
 *      A review handoff file that cannot be read or parsed and names a chain
 *      branch as its `base_ref` refuses too: a hidden review must not change
 *      which review governs.
 *   3. Commits after the review: its `reviewed_sha` is the head or an ancestor of
 *      it, and every later commit is a dispatch delivery (a hand edit refuses, no
 *      override).
 *   4. Chain walk: every commit in the range is a chain member (`walkChain`).
 *   5. Judgments: every finding of every finished `code_review` on the chain that
 *      has a valid structured block (stamped in the response doc's
 *      `recovery_findings` frontmatter) needs exactly one judgment — `fix`,
 *      `dismiss` or `defer`; `dismiss` and `defer` carry a reason; a `fix` needs
 *      that review's `reviewed_sha` to be part of the branch and a delivery after
 *      it. Any gap refuses before anything is committed. The judgments are
 *      committed as `<id>.judgments.json` before the merge. An `override` never
 *      substitutes for a judgment.
 *   6. The working tree is clean within the merge's change set — not
 *      repo-wide. Anything staged (the index differs from HEAD) refuses
 *      outright, listing the staged paths: git aborts any merge whose index
 *      differs from HEAD regardless of which paths are involved (git-merge(1)
 *      PRE-MERGE CHECKS). Otherwise, only a dirty path (unstaged or
 *      untracked) that collides with the paths `git diff HEAD...<branch>`
 *      reports — exact match, or either path a directory prefix of the
 *      other, matching git's own refusal on a local/branch path clash —
 *      refuses, listing just the colliding paths. An unrelated dirty file
 *      anywhere else in the repo never blocks the merge.
 *   7. Host validation evidence: the evidence is the chain head's — `evidenceForDelivery`
 *      for the head's latest delivered run and the head sha, reused when it
 *      passed for that sha and registry, produced now otherwise (a stored file
 *      that is unreadable or malformed counts as stale and is rewritten). Missing
 *      stamps on the review, a head with no delivered run, evidence that
 *      cannot be produced, evidence of another run, or a failing
 *      outcome refuse unless the caller passes an `override` with a reason;
 *      the override's provenance is committed fail-closed (isolated index)
 *      before the merge, so an override merge is distinguishable from a gated
 *      one in history. The result reports `validationSteps`, the number of steps
 *      the evidence holds (0 when no command is registered).
 *   8. Records: the override record and the judgments record are committed.
 *   9. The merge succeeds (fast-forward or a real merge) with no conflict —
 *      a failing merge is aborted and surfaced to the operator with git's
 *      output and the record files already committed. The merge names the
 *      gated sha, never the branch name.
 *
 * Only after all of these pass is the delivery branch deleted. Git behavior
 * relied on here (plain non-fast-forward `git merge <branch>` with no `-m`
 * completes without invoking an interactive editor when spawned with no TTY;
 * `git branch -d` succeeds immediately after the branch that authored it has
 * just been merged) was captured against a real repo via `execFile`, not
 * assumed.
 */
import { execFile as execFileCb } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { porcelainPaths } from './admission.js';
import { commitPaths } from './commit-artifacts.js';
import { DISPATCH_COMMIT_SUBJECT, latestDeliveredRun, walkChain } from './derive-review.js';
import { type Handoff } from './ho.js';
import { parseResponseDocFrontmatter, readCodeReviews, readResponseDoc, reviewState, type ReviewState } from './chain-reviews.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { evidenceForDelivery, JAIL_HERMETICITY_TEACHING_SENTENCE, type ValidationEvidence } from './host-validation.js';
import { loadValidationRegistry } from './repo-config.js';
import { FINDING_SEVERITIES } from './recovery-block.js';

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

/** The orchestrator's call on one review finding. */
export const FINDING_JUDGMENTS = ['fix', 'dismiss', 'defer'] as const;
export type FindingJudgment = (typeof FINDING_JUDGMENTS)[number];

export interface MergeJudgment {
  /** The review handoff id; may be omitted only when exactly one review on the chain has findings. */
  review?: string;
  finding: string;
  judgment: FindingJudgment;
  /** Required (non-blank) for `dismiss` and `defer`. */
  reason?: string;
}

export interface MergeDeliveryOpts {
  dir: string;
  handoff_id: string;
  override?: MergeOverride;
  judgments?: MergeJudgment[];
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
  /** Judgments recorded for the chain's review findings; all zero when no review has findings. */
  judgments: { total: number; fix: number; dismiss: number; defer: number };
  /** Repo-relative path of the committed judgments record; set only when a review had findings. */
  judgmentsRecord?: string;
  /** `code_review` handoffs on chain members that have a response doc. */
  reviewCount: number;
  /** Implement delivery members of the chain (the head included). */
  implementDeliveries: number;
  /** Delivery branches (the head's and fully merged intermediate members') deleted after the merge. */
  deletedBranches: string[];
  /** Delivery branches that were left in place, each with the reason. */
  keptBranches: { branch: string; reason: string }[];
  /** Validation steps (setup included) the gating evidence holds; 0 when no command is registered or no evidence exists. */
  validationSteps: number;
}

/** One finding of a review, as capture.ts stamps it into the response doc's `recovery_findings` frontmatter. */
interface ReviewFinding {
  id: string;
  title: string;
  severity: string;
  blocking: boolean;
}

/** The stamped `recovery_findings` JSON line; a malformed value is a failure, never "no findings". */
function parseStampedFindings(raw: string, reviewId: string): DispatchResult<ReviewFinding[]> {
  const malformed = (why: string, cause?: unknown): DispatchResult<ReviewFinding[]> =>
    fail('ADMISSION_FAILED', `Review ${reviewId} response doc has a malformed recovery_findings field: ${why}`, cause);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return malformed('not valid JSON', err);
  }
  if (!Array.isArray(parsed)) return malformed('not a JSON array');
  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();
  for (const entry of parsed as unknown[]) {
    const f = entry as Partial<ReviewFinding> | null;
    if (
      typeof f !== 'object' || f === null ||
      typeof f.id !== 'string' || f.id === '' ||
      typeof f.title !== 'string' ||
      typeof f.severity !== 'string' ||
      typeof f.blocking !== 'boolean'
    ) {
      return malformed('every entry needs a string id, title, severity and a boolean blocking');
    }
    if (seen.has(f.id)) return malformed(`lists finding id ${f.id} twice`);
    seen.add(f.id);
    findings.push({ id: f.id, title: f.title, severity: f.severity, blocking: f.blocking });
  }
  return ok(findings);
}

/**
 * shortcut: parses the `### Findings` table that capture.ts's `formatRecoveryBlockSection`
 * rendered into the body of response docs written before the `recovery_findings` stamp existed
 * (rows `| id | severity | yes/no | title |`, inside the last `## Recovery Signal` section only);
 * remove when no unmerged chain predates the stamp. The table is read from a host-rendered section of a
 * response whose summary text above it is worker-written. A row that does not match refuses.
 */
function parseLegacyFindings(content: string, outcome: string | undefined, reviewId: string): DispatchResult<ReviewFinding[]> {
  const refuse = (why: string): DispatchResult<ReviewFinding[]> =>
    fail(
      'ADMISSION_FAILED',
      `Review ${reviewId} response predates the findings stamp and its findings list could not be read (${why}) — dispatch a new review of the chain`,
    );
  const signal = content.replace(/\r\n/g, '\n');
  const section = signal.slice(signal.lastIndexOf('\n## Recovery Signal\n') + 1);
  const header = '### Findings\n| ID | Severity | Blocking | Title |\n|----|----------|----------|-------|\n';
  const at = section.indexOf(header);
  if (at === -1) return outcome === 'changes_requested' ? refuse('no findings table in the body') : ok([]);
  const row = new RegExp(`^\\| (.+?) \\| (${FINDING_SEVERITIES.join('|')}) \\| (yes|no) \\| (.*) \\|$`);
  const findings: ReviewFinding[] = [];
  for (const line of section.slice(at + header.length).split('\n')) {
    if (line === '') break;
    const m = row.exec(line);
    if (m === null) return refuse(`unreadable row "${line}"`);
    findings.push({ id: m[1]!, title: m[4]!, severity: m[2]!, blocking: m[3] === 'yes' });
  }
  return findings.length > 0 ? ok(findings) : refuse('empty findings table');
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

/**
 * The findings a review put in front of the orchestrator: those of a valid structured block
 * (the stamped `recovery_findings`, or for a doc that predates the stamp the table it rendered).
 * A review with no response doc, or an advisory (no valid block) one, has none.
 */
function readReviewFindings(reviewId: string, content: string | null): DispatchResult<{ outcome: string; findings: ReviewFinding[] }> {
  if (content === null) return ok({ outcome: '', findings: [] });
  const doc = parseResponseDocFrontmatter(content);
  if (doc.recoveryValid !== true) return ok({ outcome: '', findings: [] });
  const outcome = doc.recoveryOutcome ?? '';
  const found =
    doc.recoveryFindings !== undefined
      ? parseStampedFindings(doc.recoveryFindings, reviewId)
      : outcome === 'no_findings'
        ? ok<ReviewFinding[]>([])
        : parseLegacyFindings(content, outcome, reviewId);
  return found.ok ? ok({ outcome, findings: found.data }) : found;
}

/**
 * Read the governing review's response doc frontmatter evidence fields
 * (no markdown re-parsing). Fails closed on a response doc that predates
 * frontmatter-based evidence (all three fields absent). The outcome never
 * refuses; the findings are judged separately. A missing/invalid block backed
 * by real review content (`worker_report_chars > 0`) returns `verdict: 'advisory'`
 * (the block is optional metadata, never a gate, for code_review/redteam). The
 * governing review is finished by construction, so an empty report cannot reach here.
 */
function checkReviewEvidence(reviewId: string, content: string): DispatchResult<{ outcome: string; verdict: 'structured' | 'advisory' }> {
  const { recoveryOutcome, recoveryValid, workerReportChars } = parseResponseDocFrontmatter(content);

  // A response doc predating frontmatter-based evidence has none of the
  // three fields — refuse loudly rather than silently falling back to a
  // legacy markdown re-parse (no regex fallback, no dual-path parsing).
  if (recoveryOutcome === undefined && recoveryValid === undefined && workerReportChars === undefined) {
    return fail(
      'ADMISSION_FAILED',
      `Review ${reviewId} response doc predates frontmatter-based evidence — re-run the review to generate updated fields`,
    );
  }

  // A valid block passes whatever its outcome: a review advises; its findings are judged, not vetoed.
  if (recoveryValid === true) {
    return ok({ outcome: recoveryOutcome ?? '', verdict: 'structured' as const });
  }
  return ok({ outcome: 'advisory', verdict: 'advisory' as const });
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
 * Write a JSON record under `wiki/handoffs/` and commit it (in whichever repo holds the wiki)
 * before the merge. Fail-closed: if the record cannot be committed, the file is removed and the
 * merge is refused.
 */
async function commitRecord(dir: string, relativePath: string, label: string, record: unknown, message: string): Promise<DispatchResult<string>> {
  const path = join(dir, relativePath);
  try {
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write ${label} ${relativePath}; merge refused.`, err);
  }
  const committed = await commitPaths({ cwd: join(dir, 'wiki', 'handoffs'), paths: [path], message });
  if (!committed.ok || committed.data === null) {
    await rm(path, { force: true }).catch(() => {});
    return fail(
      'FILE_WRITE_ERROR',
      `${label[0]!.toUpperCase()}${label.slice(1)} ${relativePath} could not be committed; merge refused (fail-closed). ${committed.ok ? 'Nothing was staged.' : committed.message}`,
    );
  }
  return ok(relativePath);
}

/** The override provenance record (A2 R8), committed before the merge. */
function commitOverrideRecord(
  dir: string,
  handoffId: string,
  reviewId: string,
  override: MergeOverride,
  gate: ValidationGate,
): Promise<DispatchResult<string>> {
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
  return commitRecord(
    dir,
    `wiki/handoffs/${handoffId}.merge-override.json`,
    'override record',
    record,
    `chore: merge-delivery override for ${handoffId} (${override.surface}, actor self-reported: ${override.actor})`,
  );
}

/** One review's findings with the judgment each was given. */
interface JudgedReview {
  review_id: string;
  reviewed_sha: string | undefined;
  outcome: string;
  findings: (ReviewFinding & { judgment: FindingJudgment; reason: string | null })[];
}

const JUDGMENT_ENTRY_SHAPE = '{"review": "<review id>", "finding": "<finding id>", "judgment": "fix" | "dismiss" | "defer", "reason": "<required for dismiss and defer>"}';

/**
 * One judgment per finding of the chain's reviews, or a refusal naming every gap. A `fix` needs its
 * review's `reviewed_sha` on the branch and a dispatch delivery after it (`deliveredShas`: the unmerged chain commits).
 * Nothing is written; a refusal here leaves the repo untouched.
 */
async function judgeFindings(
  dir: string,
  branchName: string,
  deliveredShas: ReadonlySet<string>,
  reviews: { id: string; sha: string | undefined; outcome: string; findings: ReviewFinding[] }[],
  judgments: readonly MergeJudgment[],
): Promise<DispatchResult<JudgedReview[]>> {
  const withFindings = reviews.filter((r) => r.findings.length > 0);
  const problems: string[] = [];
  const given = new Map<string, MergeJudgment>();
  for (const j of judgments) {
    const reviewId = j.review ?? (withFindings.length === 1 ? withFindings[0]!.id : undefined);
    if (reviewId === undefined) {
      problems.push(
        withFindings.length === 0
          ? `judgment for finding "${j.finding}" is unknown: no review on the chain has findings`
          : `judgment for finding "${j.finding}" names no review; ${withFindings.length} reviews have findings (${withFindings.map((r) => r.id).join(', ')}), so "review" is required`,
      );
      continue;
    }
    const review = withFindings.find((r) => r.id === reviewId);
    if (review === undefined) {
      problems.push(`judgment for ${reviewId}/${j.finding} names an unknown review: no findings to judge in ${reviewId}`);
      continue;
    }
    if (!review.findings.some((f) => f.id === j.finding)) {
      problems.push(`judgment for ${reviewId}/${j.finding} names an unknown finding of ${reviewId}`);
      continue;
    }
    const key = `${reviewId}/${j.finding}`;
    if (!(FINDING_JUDGMENTS as readonly string[]).includes(j.judgment)) {
      problems.push(`judgment for ${key} is "${String(j.judgment)}", not one of ${FINDING_JUDGMENTS.join(', ')}`);
    } else if (j.judgment !== 'fix' && (j.reason ?? '').trim() === '') {
      problems.push(`judgment ${j.judgment} for ${key} needs a non-blank reason`);
    }
    if (given.has(key)) problems.push(`finding ${key} is judged twice`);
    else given.set(key, j);
  }

  const unjudged: string[] = [];
  for (const review of withFindings) {
    for (const f of review.findings) {
      if (!given.has(`${review.id}/${f.id}`)) unjudged.push(`${review.id}/${f.id} [${f.severity}] ${f.title}`);
    }
  }
  if (unjudged.length > 0) problems.push(`no judgment for: ${unjudged.join('; ')}`);

  // A `fix` is only real when a delivery follows the review that raised the finding on this branch.
  for (const review of withFindings) {
    const fixes = review.findings.filter((f) => given.get(`${review.id}/${f.id}`)?.judgment === 'fix');
    if (fixes.length === 0) continue;
    const names = fixes.map((f) => `${review.id}/${f.id}`).join(', ');
    if (review.sha === undefined) {
      problems.push(`${names} judged fix, but review ${review.id} carries no reviewed_sha stamp, so no delivery can be shown to follow it; judge dismiss or defer with a reason`);
      continue;
    }
    try {
      await execFile('git', ['merge-base', '--is-ancestor', review.sha, branchName], { cwd: dir });
    } catch (err) {
      if ((err as { code?: unknown }).code !== 1) return fail('ADMISSION_FAILED', `Failed to compare ${review.sha} with ${branchName} in ${dir}.`, err);
      problems.push(
        `${names} judged fix, but review ${review.id} reviewed ${review.sha}, which is not part of ${branchName} (the branch was reset or delivered again), so no delivery can be shown to follow it; judge it dismiss or defer with a reason`,
      );
      continue;
    }
    const after = await listUnmergedCommits(dir, `${review.sha}..${branchName}`);
    if (!after.ok) return after;
    const delivered = after.data.some((c) => deliveredShas.has(c.sha) && DISPATCH_COMMIT_SUBJECT.test(c.subject));
    if (!delivered) {
      problems.push(
        `${names} judged fix, but no delivery follows review ${review.id} (reviewed ${review.sha}); dispatch a fix-up handoff with base_ref ${branchName}, or judge it dismiss or defer with a reason`,
      );
    }
  }

  if (problems.length > 0) {
    return fail(
      'ADMISSION_FAILED',
      `Merge of ${branchName} refused: each review finding needs exactly one judgment. ${problems.join('. ')}. Pass judgments as a list of entries shaped ${JUDGMENT_ENTRY_SHAPE}.`,
      { problems },
    );
  }
  return ok(
    withFindings.map((r) => ({
      review_id: r.id,
      reviewed_sha: r.sha,
      outcome: r.outcome,
      findings: r.findings.map((f) => {
        const j = given.get(`${r.id}/${f.id}`)!;
        return { ...f, judgment: j.judgment, reason: j.reason?.trim() ?? null };
      }),
    })),
  );
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

/** What git printed for a failed command: stdout and stderr, whitespace folded; the error text when it printed nothing. */
function gitOutput(err: unknown): string {
  const { stdout, stderr } = err as { stdout?: unknown; stderr?: unknown };
  const printed = [stdout, stderr].filter((t): t is string => typeof t === 'string').join('\n').replace(/\s+/g, ' ').trim();
  return printed === '' ? String(err) : printed;
}

/**
 * Merge a dispatch delivery chain's head branch (`dispatch/<handoff_id>`) into
 * the current branch after confirming a code review of the chain exists and
 * every finding of its reviews is judged. Local only — never pushes to a remote (push is the
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

  // 2. The governing review: the newest finished code_review of any delivery in HEAD..branch (the head included).
  const unmerged = await listUnmergedCommits(dir, `HEAD..${branchName}`);
  if (!unmerged.ok) return unmerged;
  const chainIds = new Set([handoff_id]);
  for (const commit of unmerged.data) {
    const id = DISPATCH_COMMIT_SUBJECT.exec(commit.subject)?.[1];
    if (id !== undefined) chainIds.add(id);
  }
  const chainBranches = new Set([...chainIds].map((id) => `dispatch/${id}`));
  const reviews = await readCodeReviews(dir, chainBranches);
  if (!reviews.ok) return reviews;
  const chainReviews: { handoff: Handoff; doc: string | null; state: ReviewState }[] = [];
  for (const handoff of reviews.data) {
    if (handoff.base_ref === null || !chainBranches.has(handoff.base_ref)) continue;
    const doc = await readResponseDoc(dir, handoff.id);
    if (!doc.ok) return doc;
    chainReviews.push({ handoff, doc: doc.data, state: reviewState(doc.data) });
  }
  if (chainReviews.length === 0) {
    return fail('ADMISSION_FAILED', `No code_review HO found with base_ref: ${[...chainBranches].join(' or ')}`);
  }
  const reviewHandoff = selectLatestReview(chainReviews.filter((r) => r.state === 'finished').map((r) => r.handoff));
  if (!reviewHandoff) {
    const unfinished = chainReviews.map((r) => `${r.handoff.id} (${r.state})`).join(', ');
    return fail(
      'ADMISSION_FAILED',
      `No finished code_review of ${[...chainBranches].join(' or ')}: ${unfinished}. Next step: dispatch it, or run derive-review for ${handoff_id} to derive a review.`,
    );
  }
  const reviewId = reviewHandoff.id;
  const reviewedRun = reviewHandoff.reviewed_run;
  const reviewedSha = reviewHandoff.reviewed_sha;

  // 3. The review's evidence; the head may sit past the reviewed sha only on dispatch deliveries.
  const reviewCheck = checkReviewEvidence(reviewId, chainReviews.find((r) => r.handoff.id === reviewId)!.doc!);
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
  const reviewCount = chainReviews.filter((r) => r.doc !== null && members.some((m) => r.handoff.base_ref === `dispatch/${m.hoId}`)).length;

  // 4b. One judgment per review finding on the chain — nothing is written yet. An unfinished review
  // has no findings, and a finished one is never skipped, so deriving another review hides nothing.
  const chainFindings: { id: string; sha: string | undefined; outcome: string; findings: ReviewFinding[] }[] = [];
  for (const review of chainReviews) {
    const read = readReviewFindings(review.handoff.id, review.doc);
    if (!read.ok) return read;
    chainFindings.push({ id: review.handoff.id, sha: review.handoff.reviewed_sha, outcome: read.data.outcome, findings: read.data.findings });
  }
  const judged = await judgeFindings(dir, branchName, new Set(unmerged.data.map((c) => c.sha)), chainFindings, opts.judgments ?? []);
  if (!judged.ok) return judged;

  // 5. Working tree must be clean within the merge's change set — see header.
  const dirtyCheck = await checkScopedDirtyRepo(dir, branchName);
  if (!dirtyCheck.ok) return dirtyCheck;

  // 5b. Host validation evidence for the head — or an audited override.
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

  // 5c. The judgments are on record before the merge, like an override.
  let judgmentsRecord: string | undefined;
  if (judged.data.length > 0) {
    const recorded = await commitRecord(
      dir,
      `wiki/handoffs/${handoff_id}.judgments.json`,
      'judgments record',
      {
        schema: 'kb-dispatch-merge-judgments.v1',
        handoff_id,
        head_sha: gate.sha,
        recorded_at: new Date().toISOString(),
        reviews: judged.data,
      },
      `chore: merge-delivery judgments for ${handoff_id}`,
    );
    if (!recorded.ok) return recorded;
    judgmentsRecord = recorded.data;
  }

  // 6. Merge the gated sha — fast-forward if possible, a real merge if needed, abort + refuse on failure.
  try {
    await execFile('git', ['merge', gate.sha], { cwd: dir });
  } catch (err) {
    let aborted = 'The merge was aborted.';
    try {
      await execFile('git', ['merge', '--abort'], { cwd: dir });
    } catch (abortErr) {
      aborted = `The merge could not be aborted (${gitOutput(abortErr)}); check the working tree.`;
    }
    const recorded = [overrideRecord, judgmentsRecord].filter((r) => r !== undefined);
    const committed = recorded.length > 0 ? `Record files already committed before the merge: ${recorded.join(', ')}.` : 'No record file was committed before the merge.';
    return fail(
      'ADMISSION_FAILED',
      `git merge of ${branchName} failed: ${gitOutput(err)}. ${aborted} ${committed} Surface to the operator.`,
      err,
    );
  }

  const allJudged = judged.data.flatMap((r) => r.findings);
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
    judgments: {
      total: allJudged.length,
      fix: allJudged.filter((f) => f.judgment === 'fix').length,
      dismiss: allJudged.filter((f) => f.judgment === 'dismiss').length,
      defer: allJudged.filter((f) => f.judgment === 'defer').length,
    },
    reviewCount,
    implementDeliveries: members.length,
    deletedBranches: branches.deleted,
    keptBranches: branches.kept,
    validationSteps: gate.evidence === null ? 0 : gate.evidence.commands.length + (gate.evidence.setup === null ? 0 : 1),
    ...(overrideRecord !== undefined ? { overrideRecord } : {}),
    ...(judgmentsRecord !== undefined ? { judgmentsRecord } : {}),
  });
}

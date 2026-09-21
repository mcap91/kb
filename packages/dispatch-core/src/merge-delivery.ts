/**
 * WK-0132 Slice 3 — `merge-delivery` MCP tool. Given an implement HO whose
 * delivery has passed code review, merges its delivery branch
 * (`dispatch/<handoff_id>`) into the current branch and deletes the branch.
 * Local only — no remote push; push is the operator's decision (WK-0132
 * spec, Slice 3).
 *
 * Preconditions, checked in order, fail closed throughout:
 *   1. Review evidence: a `code_review` HO in `wiki/handoffs/` whose
 *      `base_ref` is `dispatch/<handoff_id>` has a response doc
 *      (`<review_id>.response.md`) whose `kb-dispatch-recovery.v1` block
 *      reports `no_findings` or `passed_no_blocking_or_medium_findings`.
 *      `changes_requested`, a missing response doc, a missing review HO, or
 *      an absent/invalid recovery block (DEC-0037 prose fallback included)
 *      all refuse — there is no operator override in this slice.
 *   2. The working tree is clean (`git status --porcelain` empty).
 *   3. Branch `dispatch/<handoff_id>` exists as a local branch.
 *   4. The merge succeeds (fast-forward or a real merge) with no conflict —
 *      a conflicting merge is aborted and surfaced to the operator.
 *
 * Only after all four pass is the delivery branch deleted. Git behavior
 * relied on here (plain non-fast-forward `git merge <branch>` with no `-m`
 * completes without invoking an interactive editor when spawned with no TTY;
 * `git branch -d` succeeds immediately after the branch that authored it has
 * just been merged) was captured against a real repo via `execFile`, not
 * assumed — see WK-0132 Slice 3 implementation notes.
 */
import { execFile as execFileCb } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { parseHandoffContent, type Handoff } from './ho.js';
import { extractRecoveryBlock } from './recovery-block.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';

const execFile = promisify(execFileCb);

export interface MergeDeliveryOpts {
  dir: string;
  handoff_id: string;
}

export interface MergeDeliveryResult {
  mergedBranch: string;
  mergeSha: string;
  reviewId: string;
  reviewOutcome: string;
}

/** `FindingsOutcome` values that gate a merge open (recovery-block.ts's `FINDINGS_OUTCOMES` minus `changes_requested`). */
const PASSING_OUTCOMES: readonly string[] = ['no_findings', 'passed_no_blocking_or_medium_findings'];

/**
 * Scan `wiki/handoffs/` for a `code_review` HO whose `base_ref` equals
 * `branchName`, then extract and validate its response doc's recovery block.
 * Fails closed on every gap: no matching review HO, no response doc, no
 * valid recovery block, or a non-passing outcome.
 */
async function checkReviewEvidence(
  dir: string,
  branchName: string,
): Promise<DispatchResult<{ reviewId: string; outcome: string }>> {
  const handoffsDir = join(dir, 'wiki', 'handoffs');

  let files: string[];
  try {
    files = await readdir(handoffsDir);
  } catch (err) {
    return fail('ADMISSION_FAILED', `Could not read handoffs directory: ${handoffsDir}`, err);
  }

  const hoFiles = files.filter((f) => /^HO-\d{4}\.md$/.test(f));

  let reviewHandoff: Handoff | null = null;
  for (const file of hoFiles) {
    let content: string;
    try {
      content = await readFile(join(handoffsDir, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseHandoffContent(content, file);
    if (!parsed.ok) continue;
    if (parsed.data.mode === 'code_review' && parsed.data.base_ref === branchName) {
      reviewHandoff = parsed.data;
      break;
    }
  }

  if (!reviewHandoff) {
    return fail('ADMISSION_FAILED', `No code_review HO found with base_ref: ${branchName}`);
  }
  const reviewId = reviewHandoff.id;

  const reviewResponsePath = join(handoffsDir, `${reviewId}.response.md`);
  let reviewResponseContent: string;
  try {
    reviewResponseContent = await readFile(reviewResponsePath, 'utf8');
  } catch {
    return fail('ADMISSION_FAILED', `Review response doc missing: ${reviewId}.response.md`);
  }

  const workerReportMatch = reviewResponseContent.match(
    /## Worker Report[^\n]*\n([\s\S]*?)(?=\n## |\n---\s*$|$)/
  );
  const evidence = extractRecoveryBlock(workerReportMatch?.[1] ?? reviewResponseContent);
  if (!evidence.valid || !evidence.result) {
    return fail('ADMISSION_FAILED', `Review ${reviewId} has no valid recovery block — fail closed`);
  }

  const outcome = evidence.result.reported_outcome;
  if (!PASSING_OUTCOMES.includes(outcome)) {
    return fail('ADMISSION_FAILED', `Review ${reviewId} outcome is "${outcome}" — merge blocked`);
  }

  return ok({ reviewId, outcome });
}

/**
 * Merge a dispatch delivery branch (`dispatch/<handoff_id>`) into the
 * current branch after confirming a passing code review exists. Local
 * only — never pushes to a remote (WK-0132 Slice 3: push is the operator's
 * decision). Never throws — every failure path returns a `DispatchResult`.
 */
export async function mergeDelivery(opts: MergeDeliveryOpts): Promise<DispatchResult<MergeDeliveryResult>> {
  const { dir, handoff_id } = opts;
  const branchName = `dispatch/${handoff_id}`;

  // 1. Review evidence must exist and report a passing outcome.
  const reviewCheck = await checkReviewEvidence(dir, branchName);
  if (!reviewCheck.ok) return reviewCheck;
  const { reviewId, outcome } = reviewCheck.data;

  // 2. Working tree must be clean.
  let statusOut: string;
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd: dir });
    statusOut = stdout;
  } catch (err) {
    return fail('ADMISSION_FAILED', `Failed to run "git status --porcelain" in ${dir}.`, err);
  }
  if (statusOut.trim() !== '') {
    return fail('DIRTY_REPO', 'Working tree is not clean — refusing merge', {
      dirtyPaths: statusOut.trim().split('\n'),
    });
  }

  // 3. Delivery branch must exist.
  try {
    await execFile('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], { cwd: dir });
  } catch {
    return fail('BAD_RECORD', `Branch ${branchName} does not exist`);
  }

  // 4. Merge — fast-forward if possible, a real merge if needed, abort + refuse on conflict.
  try {
    await execFile('git', ['merge', branchName], { cwd: dir });
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

  // 5. Delete the delivery branch — only reached after a successful merge, at
  // which point `-d` (safe delete) always succeeds because the branch is by
  // construction fully merged; swallow defensively rather than throw.
  await execFile('git', ['branch', '-d', branchName], { cwd: dir }).catch(() => {});

  return ok({ mergedBranch: branchName, mergeSha, reviewId, reviewOutcome: outcome });
}

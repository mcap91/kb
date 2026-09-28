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
  /**
   * 'structured' when a valid `kb-dispatch-recovery.v1` block drove the outcome; 'advisory'
   * when the merge proceeded on prose-only review evidence — DEC-0037: the block is optional
   * structured metadata for code_review/redteam, never a gate. Optional for backward
   * compatibility with callers written before this field existed.
   */
  verdict?: 'structured' | 'advisory';
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
 * Scan `wiki/handoffs/` for a `code_review` HO whose `base_ref` equals
 * `branchName`, then read its response doc's frontmatter evidence fields
 * (WK-0166 — no markdown re-parsing). Fails closed on: no matching review
 * HO, no response doc, a response doc that predates frontmatter-based
 * evidence (all three fields absent), an empty report
 * (`worker_report_chars === 0`), or a structured block reporting a
 * non-passing outcome. A missing/invalid block backed by real review
 * content (`worker_report_chars > 0`) returns `verdict: 'advisory'` instead
 * of failing (DEC-0037 — the block is optional metadata, never a gate, for
 * code_review/redteam).
 */
async function checkReviewEvidence(
  dir: string,
  branchName: string,
): Promise<DispatchResult<{ reviewId: string; outcome: string; verdict: 'structured' | 'advisory' }>> {
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
      return ok({ reviewId, outcome: recoveryOutcome, verdict: 'structured' as const });
    }
    return fail('ADMISSION_FAILED', `Review ${reviewId} outcome is "${recoveryOutcome}" — merge blocked`);
  }

  // DEC-0037: code_review/redteam is prose-first — the recovery block is optional
  // structured metadata, never a gate. A missing/invalid block still merges as long
  // as the response doc has real review content; only a genuinely empty report (no
  // evidence a review ran at all) fails closed.
  if ((workerReportChars ?? 0) > 0) {
    return ok({ reviewId, outcome: 'advisory', verdict: 'advisory' as const });
  }

  return fail('ADMISSION_FAILED', `Review ${reviewId} response is empty — no evidence of a completed review`);
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
  const { reviewId, outcome, verdict } = reviewCheck.data;

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

  return ok({ mergedBranch: branchName, mergeSha, reviewId, reviewOutcome: outcome, verdict });
}

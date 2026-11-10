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
 *   3b. Host validation evidence (WK-0294, DEC-0047 A1 ruling 2, A2 R6/R8,
 *      A4.1/A4.5): the review's `reviewed_sha` stamp equals the branch head,
 *      and the evidence JSON in the implement run dir named by the review's
 *      `reviewed_run` stamp — the host original, never a jail copy — exists,
 *      belongs to that run, carries the same sha, passed, and was produced by
 *      the current registry (fingerprint). A branch head that differs from
 *      the review's sha or the evidence sha always refuses: re-validating the
 *      same run for a new head overwrites its evidence, so the evidence alone
 *      cannot prove which head a review saw. Missing stamps, or missing,
 *      failing, or stale-registry evidence, refuse unless the caller passes an
 *      `override` with a reason; the override's provenance is committed
 *      fail-closed (isolated index) before the merge, so an override merge
 *      is distinguishable from a gated one in history.
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

import { commitPaths } from './commit-artifacts.js';
import { parseHandoffContent, type Handoff } from './ho.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { readValidationEvidence, validationEvidencePath, type ValidationEvidence } from './host-validation.js';
import { loadValidationRegistry, validationRegistryFingerprint } from './repo-config.js';

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

/**
 * Scan `wiki/handoffs/` for all `code_review` HOs whose `base_ref` equals
 * `branchName`, select the newest via `selectLatestReview` (WK-0207 — the
 * newest matching review wins, never the first readdir match), then read its
 * response doc's frontmatter evidence fields (WK-0166 — no markdown
 * re-parsing). Fails closed on: no matching review HO, no response doc, a
 * response doc that predates frontmatter-based evidence (all three fields
 * absent), an empty report (`worker_report_chars === 0`), or a structured
 * block reporting a non-passing outcome. A missing/invalid block backed by
 * real review content (`worker_report_chars > 0`) returns
 * `verdict: 'advisory'` instead of failing (DEC-0037 — the block is optional
 * metadata, never a gate, for code_review/redteam).
 */
async function checkReviewEvidence(
  dir: string,
  branchName: string,
): Promise<
  DispatchResult<{
    reviewId: string;
    outcome: string;
    verdict: 'structured' | 'advisory';
    reviewedRun: string | undefined;
    reviewedSha: string | undefined;
  }>
> {
  const handoffsDir = join(dir, 'wiki', 'handoffs');

  let files: string[];
  try {
    files = await readdir(handoffsDir);
  } catch (err) {
    return fail('ADMISSION_FAILED', `Could not read handoffs directory: ${handoffsDir}`, err);
  }

  const hoFiles = files.filter((f) => /^HO-\d{4}\.md$/.test(f));

  const candidates: Handoff[] = [];
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
      candidates.push(parsed.data);
    }
  }

  const reviewHandoff = selectLatestReview(candidates);

  if (!reviewHandoff) {
    return fail('ADMISSION_FAILED', `No code_review HO found with base_ref: ${branchName}`);
  }
  const reviewId = reviewHandoff.id;
  const reviewedRun = reviewHandoff.reviewed_run;
  const reviewedSha = reviewHandoff.reviewed_sha;

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
      return ok({ reviewId, outcome: recoveryOutcome, verdict: 'structured' as const, reviewedRun, reviewedSha });
    }
    return fail('ADMISSION_FAILED', `Review ${reviewId} outcome is "${recoveryOutcome}" — merge blocked`);
  }

  // DEC-0037: code_review/redteam is prose-first — the recovery block is optional
  // structured metadata, never a gate. A missing/invalid block still merges as long
  // as the response doc has real review content; only a genuinely empty report (no
  // evidence a review ran at all) fails closed.
  if ((workerReportChars ?? 0) > 0) {
    return ok({ reviewId, outcome: 'advisory', verdict: 'advisory' as const, reviewedRun, reviewedSha });
  }

  return fail('ADMISSION_FAILED', `Review ${reviewId} response is empty — no evidence of a completed review`);
}

interface ValidationGate {
  /** Sha to merge: the evidence sha, or the branch head when there is no usable evidence. */
  sha: string;
  /** Overridable gate failures; empty = the evidence gates the merge open. */
  problems: string[];
  evidence: ValidationEvidence | null;
  /** The review's `reviewed_run` stamp, recorded in an override whether or not evidence was found. */
  reviewedRun: string | null;
}

/**
 * Host-validation gate (WK-0294). Reads only the host original in the
 * implement run dir (A4.1). A branch head that differs from the review's
 * `reviewed_sha` or the evidence sha is a hard refusal — the reviewed commit
 * is not what would merge; re-derive.
 */
async function checkValidationEvidence(
  dir: string,
  handoffId: string,
  reviewId: string,
  reviewed: { run: string | undefined; sha: string | undefined },
  branchSha: string,
): Promise<DispatchResult<ValidationGate>> {
  if (reviewed.sha !== undefined && reviewed.sha !== branchSha) {
    return fail(
      'ADMISSION_FAILED',
      `dispatch/${handoffId} is at ${branchSha}, but review ${reviewId} was derived for ${reviewed.sha} — the branch moved after the review was derived. Re-run derive-review and review again; an override cannot merge an unreviewed head.`,
      { branchSha, reviewedSha: reviewed.sha },
    );
  }
  const reviewedRun = reviewed.run;
  if (reviewedRun === undefined) {
    return ok({
      sha: branchSha,
      evidence: null,
      reviewedRun: null,
      problems: [`review ${reviewId} carries no reviewed_run stamp, so no host validation evidence is bound to it (derive the review with derive-review)`],
    });
  }
  const unbound = (problem: string): DispatchResult<ValidationGate> =>
    ok({ sha: branchSha, evidence: null, reviewedRun, problems: [problem] });
  if (reviewed.sha === undefined) {
    return unbound(`review ${reviewId} carries no reviewed_sha stamp, so it is not bound to a delivery commit (derive the review with derive-review)`);
  }

  const pathCheck = validationEvidencePath(dir, handoffId, reviewedRun);
  if (!pathCheck.ok) return pathCheck;
  const evidencePath = pathCheck.data;
  const read = await readValidationEvidence(evidencePath);
  if (!read.ok) return unbound(`host validation evidence is unreadable: ${read.message}`);
  const evidence = read.data;
  if (evidence === null) return unbound(`no host validation evidence at ${evidencePath} (run derive-review)`);
  if (evidence.run_id !== reviewedRun) {
    return unbound(`evidence belongs to run ${evidence.run_id}, but review ${reviewId} reviewed run ${reviewedRun}`);
  }
  if (evidence.delivery_sha !== branchSha) {
    return fail(
      'ADMISSION_FAILED',
      `dispatch/${handoffId} is at ${branchSha}, but host validation evidence (and review ${reviewId}) cover ${evidence.delivery_sha} — the branch moved after validation. Re-run derive-review and review again; an override cannot merge an unreviewed head.`,
      { branchSha, evidenceSha: evidence.delivery_sha },
    );
  }

  const problems: string[] = [];
  if (evidence.outcome !== 'pass') {
    const failed = [evidence.setup, ...evidence.commands].filter((c) => c !== null && c.result === 'fail').map((c) => c?.name);
    problems.push(`host validation failed (${failed.join(', ')})`);
  }
  const registry = await loadValidationRegistry(dir);
  if (!registry.ok) return registry;
  const current = validationRegistryFingerprint(registry.data);
  if (current !== evidence.registry_fingerprint) {
    problems.push(
      `validation registry changed since the evidence was recorded (evidence ${evidence.registry_fingerprint}, current ${current}); re-run derive-review to revalidate`,
    );
  }
  return ok({ sha: evidence.delivery_sha, evidence, reviewedRun, problems });
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
  const { reviewId, outcome, verdict, reviewedRun, reviewedSha } = reviewCheck.data;

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
  let branchSha: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`], { cwd: dir });
    branchSha = stdout.trim();
  } catch {
    return fail('BAD_RECORD', `Branch ${branchName} does not exist`);
  }

  // 3b. Host validation evidence (WK-0294) — or an audited override.
  const gateCheck = await checkValidationEvidence(dir, handoff_id, reviewId, { run: reviewedRun, sha: reviewedSha }, branchSha);
  if (!gateCheck.ok) return gateCheck;
  const gate = gateCheck.data;
  let overrideRecord: string | undefined;
  if (gate.problems.length > 0) {
    const override = opts.override;
    if (override === undefined) {
      return fail(
        'ADMISSION_FAILED',
        `Host validation gate refused merge of ${branchName}: ${gate.problems.join('; ')}. Fix and re-derive, or merge with an override carrying a reason.`,
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

  // 5. Delete the delivery branch — only reached after a successful merge, at
  // which point `-d` (safe delete) always succeeds because the branch is by
  // construction fully merged; swallow defensively rather than throw.
  await execFile('git', ['branch', '-d', branchName], { cwd: dir }).catch(() => {});

  return ok({
    mergedBranch: branchName,
    mergeSha,
    reviewId,
    reviewOutcome: outcome,
    verdict,
    gate: overrideRecord === undefined ? 'evidence' : 'override',
    mergedSha: gate.sha,
    ...(overrideRecord !== undefined ? { overrideRecord } : {}),
  });
}

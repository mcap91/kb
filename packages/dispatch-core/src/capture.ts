/**
 * §5/§8 capture (dispatch v2, PLN-0004 S0, T7-lite). Writes the
 * `HO-XXXX.response.md` doc into the run dir and computes the HO frontmatter
 * provenance fields for write-back.
 *
 * The response doc's canonical home is `wiki/handoffs/HO-XXXX.response.md`
 * in the mother repo (spec §5), paired with its HO contract. This module
 * only writes into the run dir (a plain, dispatch-owned staging directory —
 * spec §8's proven run-dir layout); placing the file into the mother repo's
 * `wiki/handoffs/` and merging `buildProvenanceWriteBack`'s fields into
 * `HO-XXXX.md` itself both touch the mother repo and are wave 3's
 * (`pipeline.ts`) job — this module computes content/fields only, no mother
 * repo I/O.
 */
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import type { DeliveryOutcome } from './delivery.js';
import type { BackendFingerprint } from './model-registry.js';
import type { RecoveryBlockEvidence, RecoveryBlockPayload } from './recovery-block.js';
import type { PiCompaction } from './adapters/pi.js';
import type { BackendFamily } from './repo-config.js';

export interface CaptureOpts {
  /** Windows path to the run dir */
  runDir: string;
  /** The handoff record */
  handoff: { id: string; title: string; mode: string };
  /** Delivery outcome */
  delivery: DeliveryOutcome;
  /** Pi adapter result (usage, outcome) */
  piResult?: { outcome: string; usage: { totalTokens: number; costUsd: number } };
  /** Compaction statistics from parsePiOutput (T33 Phase 3). */
  compaction?: PiCompaction;
  /** Model used */
  model?: string;
  /**
   * Resolved backend family (pi/codex/claude), threaded from `model.family`
   * at the pipeline.ts call site (WK-0136). Used for the provenance
   * write-back's `agent` field, which previously hardcoded `'pi'`
   * regardless of which family actually ran; falls back to `model` when
   * absent.
   */
  family?: BackendFamily;
  /** Isolation backend */
  isolationBackend?: string;
  /**
   * The worker's final assistant message, verbatim (DEC-0010 diagnosis
   * channel) — rendered as the `## Worker Report` section, evidence only,
   * never consulted by the verdict ladder below. Typically `piResult`'s own
   * `lastAssistantText` (adapters/pi.ts).
   */
  lastAssistantText?: string;
  /** Credential profile names granted for this run (names only; S3 T10). */
  credentialsGranted?: string[];
  /** Resolved backend base_url actually used (never the {{WIN_HOST}} template; S3 ruling 8). */
  baseUrl?: string;
  /** Resolved backend name (S3 ruling 1/8). */
  backend?: string;
  /** Pi harness version captured by preflight's PI_VERSION probe (S3 ruling 7). */
  piVersion?: string;
  /**
   * Effort/reasoning level requested for this run (WK-0122) — deterministic
   * pipeline input (`DispatchOpts.effort`), never LLM output. Rendered as
   * `effort_requested` in the response doc frontmatter; empty string when
   * effort was not requested.
   */
  effort?: string;
  /** Best-effort backend fingerprint — host/model always present when probed, serverVersion null when the backend has no version endpoint (S3 ruling 8). */
  backendFingerprint?: BackendFingerprint;
  /**
   * Extracted + validated `kb-dispatch-recovery.v1` evidence (D1 ruling 1;
   * `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md`) from the
   * worker/reviewer/redteam's terminal fenced output block. Rendered as a
   * `## Recovery Signal` section whenever present — an invalid/unparseable
   * block renders as a `**Parse failed:**` notice rather than being omitted
   * silently. DEC-0037 role asymmetry (reverses DEC-0023 V4 note 3 for
   * advisory modes; WK-0125), enforced in `deriveVerdict` below: for
   * `implement` this is diagnostic evidence only and never changes the
   * verdict (delivery authority is the scope-checked commit — WK-0125 adds
   * constrained decoding at the pipeline layer to make the block more
   * reliably parseable, without changing this asymmetry). For
   * `code_review`/`redteam` the block is now opportunistic: a valid block
   * drives mechanical merge gating (`delivered`, `delivery_method:
   * structured`); an absent/invalid block falls back to prose (`delivered`,
   * `delivery_method: prose_fallback`) instead of hard-failing the run.
   */
  recoveryEvidence?: RecoveryBlockEvidence;
  /**
   * The wiki source's commit at run time (WK-0135): the mother repo's own
   * HEAD when wiki/ is tracked (the clone commit IS the wiki commit), or the
   * separate nested-private wiki repo's HEAD otherwise. Best-effort —
   * undefined when the probe failed (pipeline.ts degrades gracefully rather
   * than failing the run). Rendered as `wiki_commit` in both the response
   * doc frontmatter and the HO provenance write-back.
   */
  wikiCommit?: string;
}

export interface CaptureResult {
  responsePath: string;
  responseContent: string;
}

export interface ProvenanceWriteBack {
  /** Fields to merge into the HO frontmatter */
  fields: Record<string, string | boolean | string[]>;
}

/**
 * DEC-0010 mechanical verdict vocabulary. Computed exclusively from
 * delivery-gate facts and mode deliverable checks (`deriveVerdict` below) —
 * no worker input is ever consulted. `timed_out`/`cancelled` are set at the
 * pipeline/controller level on paths that never reach `writeResponseDoc` at
 * all (e.g. a watchdog-killed worker); `deriveVerdict` itself never returns
 * them.
 */
type ResponseOutcome = 'delivered' | 'failed' | 'refused' | 'timed_out' | 'cancelled';

/**
 * Branch naming is a fixed convention (`dispatch/<handoffId>`), meaningful
 * only once a commit actually landed; refused/no-op/conflict/error outcomes
 * carry no branch value.
 */
function deriveBranch(handoffId: string, delivery: DeliveryOutcome): string {
  if (delivery.status === 'delivered') {
    return delivery.branch || `dispatch/${handoffId}`;
  }
  return '';
}

/**
 * `deriveVerdict`'s return: the mechanical outcome plus a machine-set reason
 * code for every non-`delivered` result. `deliveryMethod` (WK-0125/DEC-0037)
 * is a SEPARATE observability field from `reason` — it names how a
 * `code_review`/`redteam` result was obtained (`structured` from a valid
 * recovery block vs. `prose_fallback` from the chat transcript), not to be
 * confused with `DeliveryOutcome`/the git delivery-gate result the rest of
 * this module calls `delivery`. Unset for `implement`/`research`, where the
 * structured/prose fork doesn't apply.
 */
interface VerdictResult {
  outcome: ResponseOutcome;
  reason?: string;
  deliveryMethod?: 'structured' | 'prose_fallback';
}

/**
 * Mechanical verdict ladder (DEC-0010 rule 2 — "completion is mechanical;
 * workers never assert done/not-done"). Every branch reads only delivery-gate
 * facts, the handoff's mode, and (for research/redteam crash detection only)
 * the Pi adapter's facts-only process classification — never the worker's
 * chat text, and never a worker-authored self-report file as authority. The
 * one exception is `recoveryEvidence.valid` for code_review/redteam (DEC-0037,
 * below) — even there the branch reads only whether extraction/validation
 * succeeded, never the worker's narrative content inside the block.
 *
 * DEC-0037 role asymmetry (reverses DEC-0023 V4 note 3 —
 * `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md` — for
 * advisory modes only; WK-0125): for `implement`, the `kb-dispatch-
 * recovery.v1` block is diagnostic evidence ONLY — an absent or malformed
 * block never changes this ladder's verdict, because delivery authority is
 * the scope-checked commit (unchanged by DEC-0037 — implement mode gets
 * constrained decoding at the pipeline layer instead, which makes the block
 * more reliably parseable without touching this ladder). For
 * `code_review`/`redteam`, the block is now opportunistic, not the
 * deliverable: a valid block drives mechanical merge gating (`delivered`,
 * `delivery_method: structured`); an absent or invalid block falls back to
 * prose (`delivered`, `delivery_method: prose_fallback`) instead of the old
 * hard `failed`/`missing_review_artifact` — the review's prose is the
 * deliverable when the structured shortcut isn't available, never a
 * discarded artifact.
 *
 * Ladder:
 *   1. Delivery-gate refusals (out-of-scope / secret-in-diff) -> `refused`.
 *   2. Delivery-gate errors (conflict / git error) -> `failed`.
 *   3. Mode-specific deliverable check:
 *      - implement: an in-scope diff landed on the branch -> `delivered`;
 *        an idempotent redelivery (`no_changes` — the exact same tree is
 *        already on the branch from the same base) -> also `delivered`;
 *        an empty delta (`no_delta` — the worker's tree matches the base
 *        tree, so no branch was ever created) -> `failed` (`no_deliverable`
 *        — DEC-0010's "silence plus no deliverable is failure, never
 *        success"). `recoveryEvidence` is never consulted in this branch.
 *      - code_review: a valid block -> `delivered` (`delivery_method:
 *        structured`, no reason); an invalid/absent block -> `delivered`,
 *        reason `prose_fallback` (`delivery_method: prose_fallback`,
 *        DEC-0037) — the chat transcript (`## Worker Report`) is the
 *        deliverable in that case.
 *      - redteam: same block-validity fallback as code_review, but a
 *        crashed/errored worker process (`piResult.outcome` `failed`/
 *        `error`) still fails with reason `process_error` regardless of
 *        block validity — checked FIRST and dominant, so prose fallback
 *        only ever covers a malformed/absent BLOCK from a process that
 *        otherwise ran, never a process that produced no real output at
 *        all (DEC-0010: no worker-authored content can manufacture a
 *        success verdict).
 *      - research: no deliverable block exists for this mode (prose-only,
 *        ruling 1 item 1) — the transcript IS the product (`## Worker
 *        Report`); `delivered` here claims only "the process ran to
 *        completion", never findings quality. A crashed/errored process
 *        still fails.
 */
function deriveVerdict(
  delivery: DeliveryOutcome,
  handoffMode: string,
  piResult?: CaptureOpts['piResult'],
  recoveryEvidence?: RecoveryBlockEvidence,
): VerdictResult {
  if (delivery.status === 'refused_out_of_scope' || delivery.status === 'secret_in_diff') {
    return { outcome: 'refused', reason: delivery.status };
  }
  if (delivery.status === 'conflict') {
    return { outcome: 'failed', reason: 'delivery_conflict' };
  }
  if (delivery.status === 'error') {
    return { outcome: 'failed', reason: 'delivery_error' };
  }
  if (handoffMode === 'implement') {
    if (delivery.status === 'delivered') return { outcome: 'delivered' };
    if (delivery.status === 'no_changes') return { outcome: 'delivered' }; // F1: idempotent redelivery
    if (delivery.status === 'no_delta') return { outcome: 'failed', reason: 'no_deliverable' }; // F2: empty delta
  }
  if (handoffMode === 'code_review') {
    // DEC-0037 (reverses DEC-0023 V4 note 3 for advisory modes; WK-0125):
    // the block is opportunistic, not the deliverable — never hard-fail a
    // genuine review over a JSON shape mismatch.
    if (!recoveryEvidence?.valid) {
      return { outcome: 'delivered', reason: 'prose_fallback', deliveryMethod: 'prose_fallback' };
    }
    return { outcome: 'delivered', deliveryMethod: 'structured' };
  }
  if (handoffMode === 'redteam') {
    // Crash detection is UNCHANGED and dominant (checked before the block-
    // validity fallback) — see the ladder doc comment above.
    if (piResult?.outcome === 'failed' || piResult?.outcome === 'error') {
      return { outcome: 'failed', reason: 'process_error' };
    }
    if (!recoveryEvidence?.valid) {
      return { outcome: 'delivered', reason: 'prose_fallback', deliveryMethod: 'prose_fallback' };
    }
    return { outcome: 'delivered', deliveryMethod: 'structured' };
  }
  if (handoffMode === 'research') {
    if (piResult?.outcome === 'failed' || piResult?.outcome === 'error') {
      return { outcome: 'failed', reason: 'process_error' };
    }
    return { outcome: 'delivered' };
  }
  return { outcome: 'failed', reason: 'unknown_mode' };
}

function describeOutcome(delivery: DeliveryOutcome): string {
  switch (delivery.status) {
    case 'delivered':
      return `Delivered to \`${delivery.branch}\` at commit \`${delivery.commitSha}\`.`;
    case 'no_changes':
      return 'No changes were delivered (either the worker made none, or this is an idempotent redelivery already landed on the branch).';
    case 'no_delta':
      return 'No changes: the worker produced no diff from the base tree. No branch was created.';
    case 'refused_out_of_scope':
      return `Refused: changes touched paths outside the declared write_scope (${delivery.offendingPaths.join(', ')}). Diff quarantined at \`${delivery.quarantinePath}\`.`;
    case 'secret_in_diff':
      return `Refused: the diff matched secret pattern(s) (${delivery.patterns.join(', ')}). Diff quarantined at \`${delivery.quarantinePath}\`.`;
    case 'conflict':
      return `Delivery conflict: the branch already carries a different tree from the same base (existing tree \`${delivery.existingTree}\`, new tree \`${delivery.newTree}\`). Nothing was landed.`;
    case 'error':
      return `Delivery error: ${delivery.message}`;
    default: {
      const exhaustiveCheck: never = delivery;
      return exhaustiveCheck;
    }
  }
}

function formatChangedFilesSection(delivery: DeliveryOutcome): string {
  const files = delivery.status === 'delivered' ? delivery.changedFiles : [];
  if (files.length === 0) return '(none)';
  return files.map((file) => `- ${file}`).join('\n');
}

function formatUsageSection(piResult: CaptureOpts['piResult']): string {
  if (!piResult) return '- Tokens: unavailable\n- Cost: unavailable';
  return `- Tokens: ${piResult.usage.totalTokens}\n- Cost: $${piResult.usage.costUsd}`;
}

/**
 * Render the `## Worker Report` section body (DEC-0010 diagnosis channel):
 * the worker's final assistant message, embedded VERBATIM as evidence —
 * never parsed, never consulted by `deriveVerdict` above. Absent/empty text
 * (no final message captured at all, e.g. a crashed or empty event stream)
 * renders an explicit placeholder rather than a blank section.
 */
function formatWorkerReportSection(lastAssistantText: string | undefined): string {
  return lastAssistantText && lastAssistantText.length > 0 ? lastAssistantText : '(no final message captured)';
}

/**
 * Render the `## Recovery Signal` section (D1 ruling 1; V4 note 3) from the
 * `kb-dispatch-recovery.v1` evidence extracted from the worker/reviewer/
 * redteam's terminal output block. An absent/invalid block renders a
 * `**Parse failed:**` notice instead of a table, listing every diagnostic
 * `extractRecoveryBlock`/`validateRecoveryPayload` collected — this keeps a
 * missing section from reading as silent success. This rendering is always
 * diagnostic-only from `writeResponseDoc`'s point of view; whether it also
 * drives the run's verdict is `deriveVerdict`'s call (V4 note 3 role
 * asymmetry), not this function's.
 */
function formatRecoveryBlockSection(evidence: RecoveryBlockEvidence): string[] {
  const lines: string[] = ['## Recovery Signal', ''];

  if (!evidence.valid || !evidence.result) {
    const detail = evidence.diagnostics
      .map((d) => `${d.code}: ${d.message}${d.path ? ` (${d.path})` : ''}`)
      .join('; ');
    lines.push(`**Parse failed:** ${detail || 'no diagnostics recorded'}`, '');
    return lines;
  }

  const payload: RecoveryBlockPayload = evidence.result;
  lines.push(`**Reported outcome:** ${payload.reported_outcome}`);
  if (payload.kind) {
    lines.push(`**Kind:** ${payload.kind}`);
  }
  if (payload.summary) {
    lines.push('', payload.summary);
  }

  if (payload.findings.length > 0) {
    lines.push('', '### Findings', '| ID | Severity | Blocking | Title |', '|----|----------|----------|-------|');
    for (const finding of payload.findings) {
      lines.push(`| ${finding.id} | ${finding.severity} | ${finding.blocking ? 'yes' : 'no'} | ${finding.title} |`);
    }
  }

  if (payload.reviewed_controls.length > 0) {
    lines.push('', '### Reviewed Controls', '| Control | Result |', '|---------|--------|');
    for (const control of payload.reviewed_controls) {
      lines.push(`| ${control.control_id} | ${control.result} |`);
    }
  }

  lines.push('');
  return lines;
}

/**
 * Serialize a `BackendFingerprint` for the `backend_fingerprint` provenance
 * field. host/model are written even when `serverVersion` is null (no
 * version endpoint for this backend kind, or the probe failed) — losing
 * host/model just because the version half is unprobeable throws away real
 * signal (this was the bug: the caller used to narrow to `serverVersion`
 * alone and drop the whole fingerprint whenever it was null).
 */
function formatBackendFingerprint(fingerprint: BackendFingerprint): string {
  return `${fingerprint.host}|${fingerprint.model}|${fingerprint.serverVersion ?? 'unknown'}`;
}

/**
 * Build the `HO-XXXX.response.md` content and write it into the run dir.
 * Structured frontmatter header (outcome/model/isolation/usage/branch/changed
 * files) followed by a free-form findings body (spec §5).
 */
export async function writeResponseDoc(opts: CaptureOpts): Promise<DispatchResult<CaptureResult>> {
  const { runDir, handoff, delivery, piResult, model, isolationBackend } = opts;

  const verdict = deriveVerdict(delivery, handoff.mode, piResult, opts.recoveryEvidence);
  const branch = deriveBranch(handoff.id, delivery);
  const changedFiles = delivery.status === 'delivered' ? delivery.changedFiles : [];
  const totalTokens = piResult?.usage.totalTokens ?? 0;
  const costUsd = piResult?.usage.costUsd ?? 0;
  const changedFilesYaml = `[${changedFiles.map((file) => JSON.stringify(file)).join(', ')}]`;
  const credentialsGrantedYaml = `[${(opts.credentialsGranted ?? []).map((name) => JSON.stringify(name)).join(', ')}]`;

  const frontmatterLines = [
    '---',
    `handoff_id: ${handoff.id}`,
    `outcome: ${verdict.outcome}`,
    `model: ${model ?? ''}`,
    `isolation_backend: ${isolationBackend ?? ''}`,
    `total_tokens: ${totalTokens}`,
    `cost_usd: ${costUsd}`,
    `branch: ${branch}`,
    `changed_files: ${changedFilesYaml}`,
    `credentials_granted: ${credentialsGrantedYaml}`,
    `effort_requested: ${opts.effort ?? ''}`,
  ];
  if (opts.compaction && opts.compaction.total > 0) {
    frontmatterLines.push(`compaction_total: ${opts.compaction.total}`);
    frontmatterLines.push(`compaction_succeeded: ${opts.compaction.succeeded}`);
    frontmatterLines.push(`compaction_failed: ${opts.compaction.failed}`);
  }
  if (verdict.reason) frontmatterLines.push(`reason: ${verdict.reason}`);
  // WK-0125/DEC-0037: observability for the code_review/redteam
  // structured-vs-prose-fallback fork (never set for implement/research).
  if (verdict.deliveryMethod) frontmatterLines.push(`delivery_method: ${verdict.deliveryMethod}`);
  // Resolved-value provenance (S3 ruling 8): stamped only when the caller has
  // them (e.g. never for the delivery-gate refusal callers, which pass no
  // model/backend at all) — RESOLVED runtime values only, never a template.
  if (opts.baseUrl) frontmatterLines.push(`base_url: ${opts.baseUrl}`);
  if (opts.backend) frontmatterLines.push(`backend: ${opts.backend}`);
  if (opts.piVersion) frontmatterLines.push(`pi_version: ${opts.piVersion}`);
  if (opts.backendFingerprint) frontmatterLines.push(`backend_fingerprint: ${formatBackendFingerprint(opts.backendFingerprint)}`);
  if (opts.wikiCommit) frontmatterLines.push(`wiki_commit: ${opts.wikiCommit}`);
  frontmatterLines.push('---', '');
  const frontmatter = frontmatterLines.join('\n');

  const bodyLines = [
    `# Response: ${handoff.title}`,
    '',
    '## Outcome',
    describeOutcome(delivery),
    '',
    '## Changed Files',
    formatChangedFilesSection(delivery),
    '',
    '## Usage',
    formatUsageSection(piResult),
    '',
    '## Worker Report (evidence, not verdict)',
    '',
    formatWorkerReportSection(opts.lastAssistantText),
    '',
  ];
  if (opts.compaction && opts.compaction.total > 0) {
    bodyLines.push(
      '## Compaction',
      `${opts.compaction.total} compaction events: ${opts.compaction.succeeded} succeeded, ${opts.compaction.failed} failed.`,
      '',
    );
  }
  if (opts.recoveryEvidence) {
    bodyLines.push(...formatRecoveryBlockSection(opts.recoveryEvidence));
  }
  const body = bodyLines.join('\n');

  const responseContent = `${frontmatter}\n${body}`;
  const responsePath = join(runDir, `${handoff.id}.response.md`);

  try {
    await writeFile(responsePath, responseContent, 'utf8');
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write response doc to ${responsePath}.`, err);
  }

  return ok({ responsePath, responseContent });
}

/**
 * HO frontmatter provenance fields written back after a run (spec §5's
 * "written back by dispatch after the run" block, minus `status`, which the
 * orchestrator sets separately as part of the broader lifecycle). `run_id`
 * is the run dir's basename — v1's proven convention
 * (`paths.ts`: `.../runs/<handoffId>/RUN-<uuid>/`) that v2 keeps (spec §8
 * capture: "run dirs keep today's proven layout"). `credentials_granted`
 * (S3 T10) is the caller-supplied list of granted profile names — names
 * only, never values — defaulting to `[]` when the caller doesn't pass one
 * (e.g. no credentials were requested).
 */
export function buildProvenanceWriteBack(opts: CaptureOpts): ProvenanceWriteBack {
  const { runDir, handoff, delivery, model, family, isolationBackend } = opts;

  const fields: Record<string, string | boolean | string[]> = {
    run_id: basename(runDir),
    // WK-0136: reflect the actual resolved family when the caller has it
    // (pipeline.ts threads `model.family`); fall back to the model string
    // rather than the old hardcoded 'pi' when family is unavailable.
    agent: family ?? model ?? '',
    model: model ?? '',
    enforced: true,
    isolation_backend: isolationBackend ?? '',
    branch: deriveBranch(handoff.id, delivery),
    response: `${handoff.id}.response.md`,
    credentials_granted: opts.credentialsGranted ?? [],
  };

  // Resolved-value provenance (S3 ruling 8) — same RESOLVED-only invariant as
  // writeResponseDoc above; present only when the caller supplied them.
  if (opts.baseUrl) fields.base_url = opts.baseUrl;
  if (opts.backend) fields.backend = opts.backend;
  if (opts.piVersion) fields.pi_version = opts.piVersion;
  if (opts.backendFingerprint) fields.backend_fingerprint = formatBackendFingerprint(opts.backendFingerprint);
  if (opts.wikiCommit) fields.wiki_commit = opts.wikiCommit;
  if (opts.compaction && opts.compaction.total > 0) {
    fields.compaction_total = String(opts.compaction.total);
    fields.compaction_succeeded = String(opts.compaction.succeeded);
    fields.compaction_failed = String(opts.compaction.failed);
  }

  return { fields };
}

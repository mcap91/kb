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
import type { StructuredReviewResult } from './response-header.js';

export interface CaptureOpts {
  /** Windows path to the run dir */
  runDir: string;
  /** The handoff record */
  handoff: { id: string; title: string; mode: string };
  /** Delivery outcome */
  delivery: DeliveryOutcome;
  /** Pi adapter result (usage, outcome) */
  piResult?: { outcome: string; usage: { totalTokens: number; costUsd: number } };
  /** Model used */
  model?: string;
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
  /** Best-effort backend fingerprint — host/model always present when probed, serverVersion null when the backend has no version endpoint (S3 ruling 8). */
  backendFingerprint?: BackendFingerprint;
  /**
   * Parsed structured review header (S6a ruling 3) for `code_review` mode
   * responses. Rendered as a `## Structured Review` section when present.
   * Absent for non-review modes, or when the header failed to parse — in
   * the latter case `reviewParseError` (below) renders an explanatory
   * `## Structured Review` section instead of omitting it silently.
   */
  reviewResult?: StructuredReviewResult;
  /**
   * The parser's error message when a `code_review` mode response's
   * structured header failed to parse (S6a fix). Rendered as a
   * `## Structured Review` section carrying this message, so a missing
   * section is diagnosable from the response doc itself rather than
   * requiring `--verbose` pipeline logs. Ignored when `reviewResult` is
   * present (a successful parse always wins) or for non-`code_review`
   * modes.
   */
  reviewParseError?: string;
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

/** `deriveVerdict`'s return: the mechanical outcome plus a machine-set reason code for every non-`delivered` result. */
interface VerdictResult {
  outcome: ResponseOutcome;
  reason?: string;
}

/**
 * Mechanical verdict ladder (DEC-0010 rule 2 — "completion is mechanical;
 * workers never assert done/not-done"). Every branch reads only delivery-gate
 * facts, the handoff's mode, and (for research/redteam crash detection only)
 * the Pi adapter's facts-only process classification — never the worker's
 * chat text, and never a worker-authored self-report file. There is no path
 * from worker-authored content to a `delivered` verdict.
 *
 * Ladder:
 *   1. Delivery-gate refusals (out-of-scope / secret-in-diff) -> `refused`.
 *   2. Delivery-gate errors (conflict / git error) -> `failed`.
 *   3. Mode-specific deliverable check:
 *      - implement: an in-scope diff landed on the branch -> `delivered`;
 *        no changes at all -> `failed` (`no_deliverable` — DEC-0010's
 *        "silence plus no deliverable is failure, never success").
 *      - code_review: reaching this function at all means the advisory path
 *        ran to completion — review.yaml presence/schema-validity is a
 *        SEPARATE gate the caller (pipeline.ts step 19b) checks before this
 *        is reached, so this branch only needs to say `delivered`.
 *      - research/redteam: no deliverable file exists for these modes — the
 *        transcript IS the product (`## Worker Report`); `delivered` here
 *        claims only "the process ran to completion", never findings
 *        quality. A crashed/errored process still fails.
 */
function deriveVerdict(
  delivery: DeliveryOutcome,
  handoffMode: string,
  piResult?: CaptureOpts['piResult'],
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
    if (delivery.status === 'no_changes') return { outcome: 'failed', reason: 'no_deliverable' };
  }
  if (handoffMode === 'code_review') {
    return { outcome: 'delivered' };
  }
  if (handoffMode === 'research' || handoffMode === 'redteam') {
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
 * Render the `## Structured Review` section (S6a ruling 3) for a
 * `code_review` mode response carrying a deterministically-parsed
 * `StructuredReviewResult`. Only called when `opts.reviewResult` is present
 * — the outcome enum and per-finding/per-AC tables are rendered verbatim
 * from the already-validated parse, never re-derived from prose.
 */
function formatStructuredReviewSection(review: StructuredReviewResult): string[] {
  const lines: string[] = ['## Structured Review', '', `**Outcome:** ${review.outcome}`, '', '### Findings'];

  if (review.findings.length === 0) {
    lines.push('(none)');
  } else {
    lines.push('| ID | Severity | Blocking | Summary |', '|----|----------|----------|---------|');
    for (const finding of review.findings) {
      lines.push(`| ${finding.id} | ${finding.severity} | ${finding.blocking ? 'yes' : 'no'} | ${finding.summary} |`);
    }
  }

  lines.push('', '### Acceptance Criteria');
  if (review.acceptanceCriteria.length === 0) {
    lines.push('(none)');
  } else {
    lines.push('| Criterion | Pass | Notes |', '|-----------|------|-------|');
    for (const ac of review.acceptanceCriteria) {
      lines.push(`| ${ac.criterion} | ${ac.pass ? 'yes' : 'no'} | ${ac.notes ?? ''} |`);
    }
  }
  lines.push('');

  return lines;
}

/**
 * Render the `## Structured Review` section as a parse-failure notice (S6a
 * fix) when `code_review` mode produced no `reviewResult` but the pipeline
 * captured why. Keeps a missing section from reading as silent success —
 * the artifact itself states that the header didn't parse and what went
 * wrong, rather than omitting the section with no trace.
 */
function formatStructuredReviewErrorSection(message: string): string[] {
  return ['## Structured Review', '', `**Parse failed:** ${message}`, ''];
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

  const verdict = deriveVerdict(delivery, handoff.mode, piResult);
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
  ];
  if (verdict.reason) frontmatterLines.push(`reason: ${verdict.reason}`);
  // Resolved-value provenance (S3 ruling 8): stamped only when the caller has
  // them (e.g. never for the delivery-gate refusal callers, which pass no
  // model/backend at all) — RESOLVED runtime values only, never a template.
  if (opts.baseUrl) frontmatterLines.push(`base_url: ${opts.baseUrl}`);
  if (opts.backend) frontmatterLines.push(`backend: ${opts.backend}`);
  if (opts.piVersion) frontmatterLines.push(`pi_version: ${opts.piVersion}`);
  if (opts.backendFingerprint) frontmatterLines.push(`backend_fingerprint: ${formatBackendFingerprint(opts.backendFingerprint)}`);
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
  if (opts.reviewResult) {
    bodyLines.push(...formatStructuredReviewSection(opts.reviewResult));
  } else if (opts.reviewParseError) {
    bodyLines.push(...formatStructuredReviewErrorSection(opts.reviewParseError));
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
  const { runDir, handoff, delivery, model, isolationBackend } = opts;

  const fields: Record<string, string | boolean | string[]> = {
    run_id: basename(runDir),
    agent: 'pi',
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

  return { fields };
}

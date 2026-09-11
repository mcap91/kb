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
  /** Needed access/decisions the worker reported on a non-completed outcome (rev-5 §5); parsed from Pi output. */
  needs?: string[];
  /** Credential profile names granted for this run (names only; S3 T10). */
  credentialsGranted?: string[];
}

export interface CaptureResult {
  responsePath: string;
  responseContent: string;
}

export interface ProvenanceWriteBack {
  /** Fields to merge into the HO frontmatter */
  fields: Record<string, string | boolean | string[]>;
}

/** Rev-5 response-doc outcome header (spec §5): four worker outcomes plus the delivery-gate refusal. */
type ResponseOutcome = 'completed' | 'partial' | 'blocked' | 'failed' | 'refused';

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
 * Response-doc outcome. Delivery-gate refusals/conflicts/errors always win
 * over whatever the worker itself reported; short of those, the worker's own
 * reported outcome (from the Pi adapter's facts-only `PiResult.outcome`)
 * is authoritative, defaulting to 'completed' when no piResult is available
 * at all (e.g. a delivered run captured without adapter usage data).
 */
function deriveOutcome(delivery: DeliveryOutcome, piResult?: CaptureOpts['piResult']): ResponseOutcome {
  if (delivery.status === 'refused_out_of_scope' || delivery.status === 'secret_in_diff') {
    return 'refused';
  }
  if (delivery.status === 'conflict' || delivery.status === 'error') {
    return 'failed';
  }
  if (piResult) {
    switch (piResult.outcome) {
      case 'completed':
      case 'partial':
      case 'blocked':
      case 'failed':
        return piResult.outcome;
      default:
        return 'failed'; // covers the adapter's 'error' outcome and any unrecognized value
    }
  }
  return 'completed';
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
 * Build the `HO-XXXX.response.md` content and write it into the run dir.
 * Structured frontmatter header (outcome/model/isolation/usage/branch/changed
 * files) followed by a free-form findings body (spec §5).
 */
export async function writeResponseDoc(opts: CaptureOpts): Promise<DispatchResult<CaptureResult>> {
  const { runDir, handoff, delivery, piResult, model, isolationBackend, needs } = opts;

  const outcome = deriveOutcome(delivery, piResult);
  const branch = deriveBranch(handoff.id, delivery);
  const changedFiles = delivery.status === 'delivered' ? delivery.changedFiles : [];
  const totalTokens = piResult?.usage.totalTokens ?? 0;
  const costUsd = piResult?.usage.costUsd ?? 0;
  const changedFilesYaml = `[${changedFiles.map((file) => JSON.stringify(file)).join(', ')}]`;
  const credentialsGrantedYaml = `[${(opts.credentialsGranted ?? []).map((name) => JSON.stringify(name)).join(', ')}]`;
  const hasNeeds = !!needs && needs.length > 0;

  const frontmatterLines = [
    '---',
    `handoff_id: ${handoff.id}`,
    `outcome: ${outcome}`,
    `model: ${model ?? ''}`,
    `isolation_backend: ${isolationBackend ?? ''}`,
    `total_tokens: ${totalTokens}`,
    `cost_usd: ${costUsd}`,
    `branch: ${branch}`,
    `changed_files: ${changedFilesYaml}`,
    `credentials_granted: ${credentialsGrantedYaml}`,
  ];
  if (hasNeeds) {
    const needsYaml = `[${needs!.map((entry) => JSON.stringify(entry)).join(', ')}]`;
    frontmatterLines.push(`needs: ${needsYaml}`);
  }
  frontmatterLines.push('---', '');
  const frontmatter = frontmatterLines.join('\n');

  const bodyLines = [
    `# Response: ${handoff.title}`,
    '',
    '## Outcome',
    describeOutcome(delivery),
    '',
  ];
  if (hasNeeds) {
    bodyLines.push('## Needs', ...needs!.map((entry) => `- ${entry}`), '');
  }
  bodyLines.push(
    '## Changed Files',
    formatChangedFilesSection(delivery),
    '',
    '## Usage',
    formatUsageSection(piResult),
    '',
  );
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
  const { runDir, handoff, delivery, model, isolationBackend, needs } = opts;

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

  if (needs && needs.length > 0) {
    fields.needs = needs;
  }

  return { fields };
}

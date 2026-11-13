/**
 * WK-0132 Slice 2 — derive a `code_review` HO from a delivered `implement` HO.
 *
 * Mechanical field derivation only (no judgment): reads the implement HO,
 * confirms it is mode=implement and delivered (response doc present, and a
 * run whose outcome is `delivered` with a delivery branch — DEC-0047 A2 R6),
 * runs the operator-registered validation commands against the delivery sha
 * on the host (WK-0294, host-validation.ts; the evidence JSON lands in that
 * implement run's dir), then writes a new code_review HO whose fields are
 * copied/derived from the implement per the WK-0132 spec, with the evidence
 * rendered into its Context. `read_first` does not list the implement
 * response (A4.4): review dispatch copies the response and the evidence JSON
 * into the review run dir. Does NOT dispatch the review — the orchestrator
 * does that separately via the existing `dispatch` tool (two-step review
 * chain, ratified in WK-0132).
 *
 * WK-0270 Slice 1 (Specification 3 + 4): `initiative`/`area`/`work_item` are
 * copied from the head implement HO; `write_scope`/`runtime_envs`/`web`/
 * `export_mounts` are set by the review mode instead of copied (the implement
 * envelope exceeds what `code_review` may declare); the implement's
 * `export_mounts` become read-only `data_mounts` entries; `validation` is one
 * fixed host-evidence sentence (DEC-0047); `read_first` is the implement's
 * list plus `AGENTS.md`, filtered through admission's shared existence
 * predicate (`readFirstEntryExists`). The chain walk, Objective/Expected
 * Output text, and the acceptance union are Slice 2/3 — out of scope here.
 */
import { execFile as execFileCb } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { allocate } from '@kb/wiki-core';

import { readFirstEntryExists } from './admission.js';
import { parseHandoff } from './ho.js';
import { renderHandoff } from './create-handoff.js';
import type { CreateHandoffOpts } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { renderValidationEvidence, runHostValidation, type ValidationEvidence } from './host-validation.js';
import { isRunId } from './paths.js';
import { loadValidationRegistry } from './repo-config.js';

const execFile = promisify(execFileCb);

/** DEC-0047: validation is one fixed sentence; the advisory reviewer never sees the implement's validation text. */
const REVIEW_VALIDATION = [
  'The host ran the registered validation commands against the delivery branch (DEC-0047); judge the Host Validation Evidence in Context — do not run the toolchain yourself.',
];

/** WK-0270 Specification 4: every derived review's read_first carries the rules file. */
const RULES_READ_FIRST_ENTRY = 'AGENTS.md';

/**
 * Union of every member's `read_first` (head first, oldest-to-newest after
 * it — Slice 1 passes a single list) plus `AGENTS.md`, deduplicated, then
 * filtered through admission's shared `readFirstEntryExists` predicate so the
 * derived review never carries an entry admission would refuse. Takes a list
 * of member lists so Slice 2's chain walk can feed it several members'
 * `read_first` arrays without rewriting this function.
 */
async function buildFilteredReadFirst(
  memberReadFirstLists: readonly string[][],
  baseRef: string,
  repoRootResolved: string,
): Promise<{ readFirst: string[]; dropped: string[] }> {
  const union = [...new Set([...memberReadFirstLists.flat(), RULES_READ_FIRST_ENTRY])];
  const readFirst: string[] = [];
  const dropped: string[] = [];
  for (const entry of union) {
    if (await readFirstEntryExists(entry, baseRef, repoRootResolved)) {
      readFirst.push(entry);
    } else {
      dropped.push(entry);
    }
  }
  return { readFirst, dropped };
}

export interface DeriveReviewOpts {
  dir: string;
  handoff_id: string;
}

export interface DeriveReviewResult {
  reviewId: string;
  reviewPath: string;
  reviewRelativePath: string;
  implementId: string;
  reviewedRunId: string;
  /** Host validation evidence written to the implement run dir (WK-0294). */
  validation: ValidationEvidence;
  /** read_first entries dropped because they fail readFirstEntryExists (WK-0270 Specification 4). */
  droppedReadFirst: string[];
}

export async function deriveReview(opts: DeriveReviewOpts): Promise<DispatchResult<DeriveReviewResult>> {
  const targetDir = resolve(opts.dir);
  const implementRelativePath = `wiki/handoffs/${opts.handoff_id}.md`;
  const implementPath = join(targetDir, implementRelativePath);

  try {
    await readFile(implementPath, 'utf8');
  } catch {
    return fail('BAD_RECORD', `Implement HO not found: ${implementPath}`);
  }

  const parsed = await parseHandoff(implementPath);
  if (!parsed.ok) return parsed;
  const implement = parsed.data;

  if (implement.mode !== 'implement') {
    return fail('BAD_RECORD', `derive-review requires mode=implement; got ${implement.mode}`);
  }

  const responseRelativePath = `wiki/handoffs/${implement.id}.response.md`;
  const responsePath = join(targetDir, responseRelativePath);

  try {
    await readFile(responsePath, 'utf8');
  } catch {
    return fail('BAD_RECORD', `Implement HO ${implement.id} is not delivered (response doc missing)`);
  }

  // The HO's latest delivered run is the one the review targets (WK-0153 reviewed_run;
  // DEC-0047 A2 R6: only a run whose outcome is `delivered` and that left a branch).
  let reviewedRunId: string | undefined;

  const runsDir = join(targetDir, '.agent-runs', 'runs', implement.id);
  let runIds: string[] = [];
  try {
    runIds = await readdir(runsDir);
  } catch {
    // No runs dir — no delivered run; refused below.
  }
  let latestCompletedAt = '';
  for (const runId of runIds) {
    if (!isRunId(runId)) continue; // not a dispatch-minted run dir; never stamped (HO-0220 F1)
    try {
      const stateRaw = await readFile(join(runsDir, runId, 'state.json'), 'utf-8');
      const state = JSON.parse(stateRaw) as Record<string, unknown>;
      if (state.schema_version !== 2) continue;
      if (state.outcome !== 'delivered' || typeof state.branch !== 'string') continue;
      const completedAt = typeof state.completed_at === 'string' ? state.completed_at : '';
      if (completedAt > latestCompletedAt) {
        latestCompletedAt = completedAt;
        reviewedRunId = runId;
      }
    } catch {
      // Skip unreadable run state
    }
  }
  if (reviewedRunId === undefined) {
    return fail(
      'BAD_RECORD',
      `Implement HO ${implement.id} has no delivered run with a delivery branch under ${runsDir}; nothing to validate or review.`,
    );
  }

  const deliveryBranch = `dispatch/${implement.id}`;
  let deliverySha: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--verify', `refs/heads/${deliveryBranch}^{commit}`], { cwd: targetDir });
    deliverySha = stdout.trim();
  } catch (err) {
    return fail('BAD_RECORD', `Delivery branch ${deliveryBranch} does not exist in ${targetDir}.`, err);
  }

  const registry = await loadValidationRegistry(targetDir);
  if (!registry.ok) return registry;
  const validation = await runHostValidation({
    dir: targetDir,
    handoffId: implement.id,
    runId: reviewedRunId,
    deliveryBranch,
    deliverySha,
    registry: registry.data,
  });
  if (!validation.ok) return validation;

  const { readFirst, dropped } = await buildFilteredReadFirst([implement.read_first], deliveryBranch, targetDir);

  const allocResult = await allocate({ dir: targetDir, prefix: 'HO' });
  if (!allocResult.ok) return fail('ALLOCATION_FAILED', allocResult.message);
  const reviewId = allocResult.data.id;

  const createOpts: CreateHandoffOpts = {
    dir: opts.dir,
    title: `Code review: ${implement.title}`,
    subject: implement.title,
    allowed_agents: ['*'],
    mode: 'code_review',
    area: implement.area,
    initiative: implement.initiative,
    work_item: implement.work_item,
    // Envelope by mode (WK-0270 Specification 3): write_scope/runtime_envs/web/export_mounts
    // are set by the review mode, never copied — copying them trips ENVELOPE_EXCEEDS_MODE or
    // grants a reviewer write access. The implement's export_mounts become read-only data_mounts.
    write_scope: [],
    runtime_envs: [],
    web: false,
    export_mounts: [],
    read_first: readFirst,
    acceptance: implement.acceptance,
    validation: REVIEW_VALIDATION,
    credentials: implement.credentials,
    data_mounts: [...implement.data_mounts, ...implement.export_mounts],
    base_ref: deliveryBranch,
    vars: implement.vars,
    reviewed_run: reviewedRunId,
    reviewed_sha: deliverySha,
    context: `### Host Validation Evidence\n\n${renderValidationEvidence(validation.data)}`,
  };

  const content = renderHandoff(reviewId, createOpts);
  const reviewRelativePath = `wiki/handoffs/${reviewId}.md`;
  const reviewPath = join(targetDir, reviewRelativePath);

  try {
    await writeFile(reviewPath, content, 'utf-8');
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write review handoff at ${reviewPath}.`, err);
  }

  return ok({
    reviewId,
    reviewPath,
    reviewRelativePath,
    implementId: implement.id,
    reviewedRunId,
    validation: validation.data,
    droppedReadFirst: dropped,
  });
}

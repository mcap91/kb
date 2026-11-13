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
 * predicate (`readFirstEntryExists`).
 *
 * WK-0270 Slice 2 (Specification 1, 2, 5, and the multi-member half of 4):
 * the chain is walked as `HEAD..dispatch/<handoff_id>` in the mother
 * checkout — exactly the range `merge-delivery` ships (`walkChain`). Every
 * member's `wiki/handoffs/<HO-id>.md` is read from disk, never from a
 * commit's git tree: the wiki layer is live-bound (DEC-0039), not
 * reconstructed from history. `Objective`/`Expected Output` are fixed
 * sentences built only from identifiers (`buildObjective`,
 * `buildExpectedOutput`); `acceptance` is every member's criteria, oldest
 * first, each prefixed `[HO-XXXX]`; `read_first` is now fed every member's
 * list, head first then older members, through the same `buildFilteredReadFirst`
 * from Slice 1.
 */
import { execFile as execFileCb } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { allocate } from '@kb/wiki-core';

import { readFirstEntryExists } from './admission.js';
import { parseHandoff, type Handoff } from './ho.js';
import { renderHandoff } from './create-handoff.js';
import type { CreateHandoffOpts } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { renderValidationEvidence, runHostValidation, type ValidationEvidence } from './host-validation.js';
import { isRunId } from './paths.js';
import { loadValidationRegistry } from './repo-config.js';

const execFile = promisify(execFileCb);

/** WK-0270 Specification 1: the only commit subject a chain member may carry. */
const DISPATCH_COMMIT_SUBJECT = /^dispatch: (HO-\d{4})$/;

/** One commit in the reviewed chain, and the implement HO its subject names. */
interface ChainMember {
  hoId: string;
  commitSha: string;
  parentSha: string;
  handoff: Handoff;
}

/**
 * WK-0270 Specification 1: walk `HEAD..deliveryBranch` in the mother checkout —
 * exactly the range `merge-delivery` merges (`mergeDelivery`'s `git merge <sha>`
 * onto the current branch). Every commit must be linear (one parent — a merge
 * commit refuses) with subject `dispatch: HO-XXXX`, whose named HO parses from
 * disk with `mode: implement` (the wiki layer is read live, never from the
 * commit's own git tree: a chained HO's own `.md` file is authored on the
 * mother's current branch, never on the dispatch/ branches themselves). The
 * newest commit must name `handoffId` itself. An empty range (already merged)
 * refuses. Returns members newest-first (head first, then older) plus
 * `rangeBase`, the parent of the oldest member's commit.
 */
async function walkChain(
  targetDir: string,
  deliveryBranch: string,
  handoffId: string,
): Promise<DispatchResult<{ membersNewestFirst: ChainMember[]; rangeBase: string }>> {
  let rangeOut: string;
  try {
    const { stdout } = await execFile('git', ['rev-list', '--topo-order', `HEAD..${deliveryBranch}`], { cwd: targetDir });
    rangeOut = stdout;
  } catch (err) {
    return fail('BAD_RECORD', `Failed to compute the review chain range HEAD..${deliveryBranch} in ${targetDir}.`, err);
  }
  const shas = rangeOut
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (shas.length === 0) {
    return fail(
      'BAD_RECORD',
      `Range HEAD..${deliveryBranch} is empty; ${deliveryBranch} carries no commit that is not already reachable from HEAD.`,
    );
  }

  const members: ChainMember[] = [];
  for (const commitSha of shas) {
    let parentsLine: string;
    let subject: string;
    try {
      const parentsOut = await execFile('git', ['log', '-1', '--format=%P', commitSha], { cwd: targetDir });
      parentsLine = parentsOut.stdout.trim();
      const subjectOut = await execFile('git', ['log', '-1', '--format=%s', commitSha], { cwd: targetDir });
      subject = subjectOut.stdout.trim();
    } catch (err) {
      return fail('BAD_RECORD', `Failed to inspect commit ${commitSha} in range HEAD..${deliveryBranch}.`, err);
    }

    const parentShas = parentsLine.split(/\s+/).filter((p) => p.length > 0);
    if (parentShas.length !== 1) {
      return fail(
        'BAD_RECORD',
        `Commit ${commitSha} in range HEAD..${deliveryBranch} has ${parentShas.length} parents; the chain must be a linear sequence of dispatch deliveries, not a merge commit.`,
      );
    }

    const subjectMatch = DISPATCH_COMMIT_SUBJECT.exec(subject);
    if (!subjectMatch) {
      return fail(
        'BAD_RECORD',
        `Commit ${commitSha} in range HEAD..${deliveryBranch} has subject "${subject}"; every commit in the chain must have the subject "dispatch: HO-XXXX".`,
      );
    }
    const hoId = subjectMatch[1]!;

    const memberPath = join(targetDir, 'wiki', 'handoffs', `${hoId}.md`);
    const memberParsed = await parseHandoff(memberPath);
    if (!memberParsed.ok) {
      return fail(
        'BAD_RECORD',
        `Commit ${commitSha} in range HEAD..${deliveryBranch} names ${hoId}, whose handoff could not be parsed: ${memberParsed.message}`,
      );
    }
    if (memberParsed.data.mode !== 'implement') {
      return fail(
        'BAD_RECORD',
        `Commit ${commitSha} in range HEAD..${deliveryBranch} names ${hoId} (mode=${memberParsed.data.mode}); every member of the chain must be mode=implement.`,
      );
    }

    members.push({ hoId, commitSha, parentSha: parentShas[0]!, handoff: memberParsed.data });
  }

  const newest = members[0]!;
  if (newest.hoId !== handoffId) {
    return fail(
      'BAD_RECORD',
      `The newest commit in range HEAD..${deliveryBranch} (${newest.commitSha}, ${newest.hoId}) is not ${handoffId}'s own delivery commit.`,
    );
  }

  const rangeBase = members[members.length - 1]!.parentSha;
  return ok({ membersNewestFirst: members, rangeBase });
}

/**
 * WK-0270 Specification 2: the Objective, built only from identifiers (head
 * id, branch, reviewed_sha, merge target, and each member's id/work_item/
 * single-commit range) — never copied from the implement HO's prose. The full
 * range sits alone on its own trailing line so the reviewer cannot mistake it
 * for a member's range.
 */
function buildObjective(params: {
  headId: string;
  branch: string;
  reviewedSha: string;
  mergeTarget: string;
  rangeBase: string;
  headSha: string;
  membersOldestFirst: readonly ChainMember[];
}): string {
  const { headId, branch, reviewedSha, mergeTarget, rangeBase, headSha, membersOldestFirst } = params;
  const memberLines = membersOldestFirst.map(
    (m) => `- ${m.hoId} (work_item ${m.handoff.work_item ?? 'none'}): ${m.parentSha}..${m.commitSha}`,
  );
  return [
    `Code review for ${headId}, branch ${branch}, reviewed_sha ${reviewedSha}. Merging ${branch} into ${mergeTarget} ships every member listed below.`,
    '',
    'Members (oldest first):',
    ...memberLines,
    '',
    `Range under review: ${rangeBase}..${headSha}`,
  ].join('\n');
}

/**
 * WK-0270 Specification 2: the Expected Output, built only from identifiers —
 * asks for a verdict per member, findings that cite a file and a concrete
 * failing case, and the recovery block. Never copied from the implement HO's
 * prose.
 */
function buildExpectedOutput(params: {
  headId: string;
  reviewedSha: string;
  membersOldestFirst: readonly ChainMember[];
}): string {
  const { headId, reviewedSha, membersOldestFirst } = params;
  const memberRanges = membersOldestFirst.map((m) => `${m.hoId} (${m.parentSha}..${m.commitSha})`).join(', ');
  return [
    `Give a verdict for each member HO of ${headId} (reviewed_sha ${reviewedSha}): ${memberRanges}.`,
    'Every finding must cite a file and a concrete failing case.',
    'End with the kb-dispatch-recovery.v1 recovery block.',
  ].join('\n');
}

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

  // WK-0270 Specification 1: the chain is HEAD..deliveryBranch — exactly what merge-delivery ships.
  const chainResult = await walkChain(targetDir, deliveryBranch, implement.id);
  if (!chainResult.ok) return chainResult;
  const { membersNewestFirst, rangeBase } = chainResult.data;
  const membersOldestFirst = [...membersNewestFirst].reverse();

  let mergeTarget: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetDir });
    mergeTarget = stdout.trim();
  } catch (err) {
    return fail('ADMISSION_FAILED', `Failed to resolve the merge target branch (git rev-parse --abbrev-ref HEAD) in ${targetDir}.`, err);
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

  // WK-0270 Specification 4: union of every member's read_first (head first, then older members).
  const { readFirst, dropped } = await buildFilteredReadFirst(
    membersNewestFirst.map((m) => m.handoff.read_first),
    deliveryBranch,
    targetDir,
  );

  // WK-0270 Specification 5: union of every member's acceptance, oldest first, each prefixed [HO-XXXX].
  const acceptance = membersOldestFirst.flatMap((m) => m.handoff.acceptance.map((c) => `[${m.hoId}] ${c}`));

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
    // WK-0270 Specification 2: fixed sentences from identifiers only — never implement prose.
    objective: buildObjective({
      headId: implement.id,
      branch: deliveryBranch,
      reviewedSha: deliverySha,
      mergeTarget,
      rangeBase,
      headSha: deliverySha,
      membersOldestFirst,
    }),
    expected_output: buildExpectedOutput({ headId: implement.id, reviewedSha: deliverySha, membersOldestFirst }),
    acceptance,
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

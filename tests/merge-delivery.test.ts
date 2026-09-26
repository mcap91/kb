/**
 * WK-0132 Slice 3 — `mergeDelivery` tests.
 *
 * Covers the merge tool's four ordered, fail-closed preconditions (review
 * evidence passes -> working tree clean -> delivery branch exists -> merge
 * succeeds) plus the happy path (fast-forward merge + branch delete). Real
 * git repos in temp dirs — no personal/absolute paths in fixtures (WK-0043
 * rule).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { mergeDelivery } from '../packages/dispatch-core/src/merge-delivery.js';

const execFile = promisify(execFileCallback);

async function initRepo(dir: string): Promise<void> {
  await execFile('git', ['init', dir]);
  await execFile('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await mkdir(join(dir, 'wiki', 'handoffs'), { recursive: true });
  await writeFile(join(dir, 'dummy.txt'), 'seed\n');
  await execFile('git', ['add', '-A'], { cwd: dir });
  await execFile('git', ['commit', '-m', 'init'], { cwd: dir });
}

async function headSha(dir: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

async function writeAndCommit(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    await writeFile(join(dir, relPath), content);
  }
  await execFile('git', ['add', '-A'], { cwd: dir });
  await execFile('git', ['commit', '-m', message], { cwd: dir });
}

/**
 * Branches off the current HEAD (captured as the base branch to return to),
 * adds a delivered file, commits it as the "worker" commit, then checks back
 * out. Branching off current HEAD (rather than an earlier commit) keeps the
 * base branch a strict ancestor of the delivery branch, so the merge is
 * fast-forwardable — matches how `delivery.ts` lands worker commits in the
 * real pipeline.
 */
async function createDeliveryBranch(dir: string, handoffId: string): Promise<void> {
  const branchName = `dispatch/${handoffId}`;
  const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  const baseBranch = stdout.trim();
  await execFile('git', ['checkout', '-b', branchName], { cwd: dir });
  await writeFile(join(dir, 'delivered-file.ts'), 'export const x = 1;\n');
  await execFile('git', ['add', '-A'], { cwd: dir });
  await execFile('git', ['commit', '-m', `dispatch: ${handoffId}`], { cwd: dir });
  await execFile('git', ['checkout', baseBranch], { cwd: dir });
}

async function branchExists(dir: string, branchName: string): Promise<boolean> {
  const { stdout } = await execFile('git', ['branch', '--list', branchName], { cwd: dir });
  return stdout.trim() !== '';
}

function makeImplementHO(id: string, title: string, workItem: string): string {
  return [
    '---',
    'schema_version: 1',
    `id: "${id}"`,
    `title: "${title}"`,
    'mode: implement',
    'write_scope:',
    '  - packages/',
    'acceptance:',
    '  - Tests pass',
    'validation:',
    '  - npm test',
    'status: draft',
    `work_item: "${workItem}"`,
    'base_ref:',
    '---',
    '',
    `# ${id}: ${title}`,
    '',
  ].join('\n');
}

function makeReviewHO(id: string, title: string, baseRef: string, workItem: string): string {
  return [
    '---',
    'schema_version: 1',
    `id: "${id}"`,
    `title: "${title}"`,
    'mode: code_review',
    'write_scope:',
    '  - packages/',
    'acceptance:',
    '  - Tests pass',
    'validation:',
    '  - npm test',
    'status: draft',
    `work_item: "${workItem}"`,
    `base_ref: ${baseRef}`,
    '---',
    '',
    `# ${id}: ${title}`,
    '',
  ].join('\n');
}

/**
 * A passing ('no_findings') or blocking ('changes_requested') recovery
 * block, wrapped in the real response-doc shape the pipeline produces
 * (capture.ts's `writeResponseDoc`): the fenced block sits inside
 * `## Worker Report`, itself followed by a `## Recovery Signal` section —
 * NOT as the doc's own terminal content. A fixture with the fence as the
 * literal last bytes of the file would never exercise
 * `trailing_prose_after_result`, which is exactly the shape that tripped up
 * `checkReviewEvidence` before it was fixed to extract the `## Worker
 * Report` section before calling `extractRecoveryBlock`.
 *
 * `changes_requested` requires >=1 finding to be schema-valid
 * (recovery-block.ts's `validateOutcomeConsistency`), so `includeFinding`
 * must be true whenever `outcome` is `changes_requested` — otherwise the
 * block is invalid for the WRONG reason (malformed) rather than the reason
 * under test (a real, valid, blocking outcome).
 */
function makeReviewResponse(outcome: string, subject: string, includeFinding: boolean): string {
  const findings = includeFinding
    ? [
        {
          id: 'F1',
          title: 'Example finding',
          severity: 'high',
          blocking: true,
          affected_paths: [{ path: 'packages/dispatch-core/src/example.ts', line: 10 }],
          control_id: null,
        },
      ]
    : [];
  const finding_counts = includeFinding
    ? { total: 1, blocking: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 }
    : { total: 0, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const payload = {
    schema_version: 'kb-dispatch-recovery.v1',
    reported_role: 'reviewer',
    reported_subject: subject,
    reported_outcome: outcome,
    summary: 'Review complete',
    findings,
    finding_counts,
    reviewed_controls: [],
    kind: null,
  };
  return [
    '---',
    `handoff_id: ${subject}`,
    'outcome: delivered',
    '---',
    '',
    '# Response: Code review',
    '',
    '## Outcome',
    'Delivered.',
    '',
    '## Worker Report (evidence, not verdict)',
    '',
    'Some review narration text.',
    '',
    '```kb-dispatch-recovery.v1',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    '## Recovery Signal',
    '',
    `**Reported outcome:** ${outcome}`,
    '',
    'Review complete',
    '',
  ].join('\n');
}

/**
 * A response doc whose `## Worker Report` section is real prose narration with
 * NO `kb-dispatch-recovery.v1` fenced block at all — DEC-0037's prose-fallback
 * shape for code_review/redteam (WK-0143 F2): the reviewer wrote a genuine
 * review and stopped, exactly the "2/3 miss rate" pattern diagnosed in WK-0143.
 */
function makeProseOnlyReviewResponse(subject: string): string {
  return [
    '---',
    `handoff_id: ${subject}`,
    'outcome: delivered',
    '---',
    '',
    '# Response: Code review',
    '',
    '## Outcome',
    'Delivered.',
    '',
    '## Worker Report (evidence, not verdict)',
    '',
    'Reviewed the diff against the acceptance criteria. The change is correct, tests pass, ' +
      'and no blocking issues were found. This review has no structured recovery block.',
    '',
  ].join('\n');
}

/**
 * A response doc whose `## Worker Report` section is present but empty — no
 * prose, no recovery block. Distinguishes "no evidence a review ran at all"
 * (still fails) from "prose-only review" (advisory pass, above).
 */
function makeEmptyReviewResponse(subject: string): string {
  return [
    '---',
    `handoff_id: ${subject}`,
    'outcome: delivered',
    '---',
    '',
    '# Response: Code review',
    '',
    '## Outcome',
    'Delivered.',
    '',
    '## Worker Report (evidence, not verdict)',
    '',
    '## Recovery Signal',
    '',
    '(none)',
    '',
  ].join('\n');
}

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'kb-merge-delivery-'));
  await initRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe('mergeDelivery (WK-0132 Slice 3)', () => {
  it('merges a fast-forwardable delivery branch and deletes it after a passing review', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review: Implement thing', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0002.response.md': makeReviewResponse('no_findings', 'HO-0001', false),
      },
      'add implement + review HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');

    const beforeHead = await headSha(repoDir);
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.mergedBranch).toBe('dispatch/HO-0001');
    expect(result.data.reviewId).toBe('HO-0002');
    expect(result.data.reviewOutcome).toBe('no_findings');

    const afterHead = await headSha(repoDir);
    expect(afterHead).not.toBe(beforeHead);
    expect(result.data.mergeSha).toBe(afterHead);

    // HEAD must now contain the delivered file (merge actually landed it).
    await execFile('git', ['cat-file', '-e', 'HEAD:delivered-file.ts'], { cwd: repoDir });

    // The delivery branch must be gone.
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(false);
  });

  it('refuses to merge when the review reports changes_requested', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0003.md': makeImplementHO('HO-0003', 'Implement other thing', 'WK-0002'),
        'wiki/handoffs/HO-0004.md': makeReviewHO('HO-0004', 'Code review: Implement other thing', 'dispatch/HO-0003', 'WK-0002'),
        'wiki/handoffs/HO-0004.response.md': makeReviewResponse('changes_requested', 'HO-0003', true),
      },
      'add implement + review HOs (changes requested)',
    );
    await createDeliveryBranch(repoDir, 'HO-0003');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0003' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');

    // Refusal must not have touched the branch or merged anything.
    expect(await branchExists(repoDir, 'dispatch/HO-0003')).toBe(true);
  });

  it('refuses to merge when no code_review HO exists for the branch', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0005.md': makeImplementHO('HO-0005', 'Implement lonely thing', 'WK-0003'),
      },
      'add implement HO only',
    );
    await createDeliveryBranch(repoDir, 'HO-0005');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0005' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(await branchExists(repoDir, 'dispatch/HO-0005')).toBe(true);
  });

  it('refuses to merge when the delivery branch does not exist', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0006.md': makeImplementHO('HO-0006', 'Implement thing without a branch', 'WK-0004'),
        'wiki/handoffs/HO-0007.md': makeReviewHO(
          'HO-0007',
          'Code review: Implement thing without a branch',
          'dispatch/HO-0006',
          'WK-0004',
        ),
        'wiki/handoffs/HO-0007.response.md': makeReviewResponse('no_findings', 'HO-0006', false),
      },
      'add implement + review HOs (no delivery branch)',
    );
    // Deliberately no dispatch/HO-0006 branch.

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0006' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('BAD_RECORD');
  });

  it('refuses to merge when the working tree is dirty', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0008.md': makeImplementHO('HO-0008', 'Implement dirty-tree thing', 'WK-0005'),
        'wiki/handoffs/HO-0009.md': makeReviewHO('HO-0009', 'Code review: Implement dirty-tree thing', 'dispatch/HO-0008', 'WK-0005'),
        'wiki/handoffs/HO-0009.response.md': makeReviewResponse('no_findings', 'HO-0008', false),
      },
      'add implement + review HOs (dirty tree test)',
    );
    await createDeliveryBranch(repoDir, 'HO-0008');

    // Dirty the real working tree with an untracked file.
    await writeFile(join(repoDir, 'untracked-scratch.txt'), 'scratch\n');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0008' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('DIRTY_REPO');

    // Refusal must not have touched the branch.
    expect(await branchExists(repoDir, 'dispatch/HO-0008')).toBe(true);
  });

  it('merges a prose-only review (no recovery block) with an advisory verdict (DEC-0037, WK-0143)', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0010.md': makeImplementHO('HO-0010', 'Implement prose-reviewed thing', 'WK-0006'),
        'wiki/handoffs/HO-0011.md': makeReviewHO(
          'HO-0011',
          'Code review: Implement prose-reviewed thing',
          'dispatch/HO-0010',
          'WK-0006',
        ),
        'wiki/handoffs/HO-0011.response.md': makeProseOnlyReviewResponse('HO-0010'),
      },
      'add implement + review HOs (prose-only review)',
    );
    await createDeliveryBranch(repoDir, 'HO-0010');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0010' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.mergedBranch).toBe('dispatch/HO-0010');
    expect(result.data.reviewId).toBe('HO-0011');
    expect(result.data.verdict).toBe('advisory');

    // The merge still landed and cleaned up despite the missing block.
    await execFile('git', ['cat-file', '-e', 'HEAD:delivered-file.ts'], { cwd: repoDir });
    expect(await branchExists(repoDir, 'dispatch/HO-0010')).toBe(false);
  });

  it('refuses to merge when the review response has no recovery block AND no real review content', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0012.md': makeImplementHO('HO-0012', 'Implement empty-reviewed thing', 'WK-0007'),
        'wiki/handoffs/HO-0013.md': makeReviewHO(
          'HO-0013',
          'Code review: Implement empty-reviewed thing',
          'dispatch/HO-0012',
          'WK-0007',
        ),
        'wiki/handoffs/HO-0013.response.md': makeEmptyReviewResponse('HO-0012'),
      },
      'add implement + review HOs (empty review response)',
    );
    await createDeliveryBranch(repoDir, 'HO-0012');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0012' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');

    // Refusal must not have touched the branch.
    expect(await branchExists(repoDir, 'dispatch/HO-0012')).toBe(true);
  });

  it('structured passing review reports verdict: structured', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0014.md': makeImplementHO('HO-0014', 'Implement structured-reviewed thing', 'WK-0008'),
        'wiki/handoffs/HO-0015.md': makeReviewHO(
          'HO-0015',
          'Code review: Implement structured-reviewed thing',
          'dispatch/HO-0014',
          'WK-0008',
        ),
        'wiki/handoffs/HO-0015.response.md': makeReviewResponse('no_findings', 'HO-0014', false),
      },
      'add implement + review HOs (structured verdict check)',
    );
    await createDeliveryBranch(repoDir, 'HO-0014');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0014' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.verdict).toBe('structured');
  });
});

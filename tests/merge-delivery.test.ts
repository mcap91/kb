/**
 * WK-0132 Slice 3 — `mergeDelivery` tests.
 *
 * Covers the merge tool's ordered, fail-closed preconditions (review
 * evidence passes -> working tree clean -> delivery branch exists -> host
 * validation evidence passes (WK-0294) -> merge succeeds) plus the happy path
 * (fast-forward merge + branch delete). The shared fixtures model a derived
 * review: the review HO carries `reviewed_run`, and `createDeliveryBranch`
 * stamps the branch head into it as `reviewed_sha` (committed on the base,
 * so these merges are real merges, as in a tracked-wiki repo) and writes
 * passing host evidence for that head into the run's dir. Real
 * git repos in temp dirs — no personal/absolute paths in fixtures (WK-0043
 * rule).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { mergeDelivery, selectLatestReview } from '../packages/dispatch-core/src/merge-delivery.js';
import type { Handoff } from '../packages/dispatch-core/src/ho.js';
import { validationRegistryFingerprint } from '../packages/dispatch-core/src/repo-config.js';
import { JAIL_HERMETICITY_TEACHING_SENTENCE } from '../packages/dispatch-core/src/host-validation.js';

const execFile = promisify(execFileCallback);

async function initRepo(dir: string): Promise<void> {
  await execFile('git', ['init', dir]);
  await execFile('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await mkdir(join(dir, 'wiki', 'handoffs'), { recursive: true });
  await writeFile(join(dir, 'dummy.txt'), 'seed\n');
  // Run dirs are runtime state, never committed (as in every real dispatch repo).
  await writeFile(join(dir, '.gitignore'), '.agent-runs/\n');
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
 * out — as `delivery.ts` lands worker commits in the real pipeline. Then
 * does derive-review's part: stamps the delivery sha into every review HO
 * for this branch (the `REVIEWED_SHA_STAMP` placeholder), commits that on
 * the base, and writes passing host evidence for the delivery sha.
 */
async function createDeliveryBranch(dir: string, handoffId: string): Promise<void> {
  const branchName = `dispatch/${handoffId}`;
  const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  const baseBranch = stdout.trim();
  await execFile('git', ['checkout', '-b', branchName], { cwd: dir });
  await writeFile(join(dir, 'delivered-file.ts'), 'export const x = 1;\n');
  await execFile('git', ['add', '-A'], { cwd: dir });
  await execFile('git', ['commit', '-m', `dispatch: ${handoffId}`], { cwd: dir });
  const deliverySha = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  await execFile('git', ['checkout', baseBranch], { cwd: dir });
  const handoffsDir = join(dir, 'wiki', 'handoffs');
  for (const file of await readdir(handoffsDir)) {
    const content = await readFile(join(handoffsDir, file), 'utf8');
    if (content.includes(`base_ref: ${branchName}\n`) && content.includes(REVIEWED_SHA_STAMP)) {
      await writeFile(join(handoffsDir, file), content.replace(REVIEWED_SHA_STAMP, deliverySha));
    }
  }
  if ((await execFile('git', ['status', '--porcelain'], { cwd: dir })).stdout.trim() !== '') {
    await execFile('git', ['commit', '-a', '-m', `derive-review stamps for ${handoffId}`], { cwd: dir });
  }
  await writeEvidence(dir, handoffId, {});
}

const REVIEWED_RUN = 'RUN-00000000-0000-4000-8000-000000000001';
/** Replaced with the delivery sha by `createDeliveryBranch`, which runs after the review HO is written. */
const REVIEWED_SHA_STAMP = '__REVIEWED_SHA__';

function evidencePath(dir: string, handoffId: string, runId = REVIEWED_RUN): string {
  return join(dir, '.agent-runs', 'runs', handoffId, runId, 'validation-evidence.json');
}

/** Host validation evidence as derive-review writes it (WK-0294): passing, for the current branch head, no registry. */
async function writeEvidence(dir: string, handoffId: string, overrides: Record<string, unknown>, runId = REVIEWED_RUN): Promise<void> {
  const { stdout } = await execFile('git', ['rev-parse', `dispatch/${handoffId}`], { cwd: dir });
  const path = evidencePath(dir, handoffId, runId);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      schema_version: 1,
      handoff_id: handoffId,
      run_id: runId,
      delivery_branch: `dispatch/${handoffId}`,
      delivery_sha: stdout.trim(),
      registry_fingerprint: validationRegistryFingerprint(null),
      started_at: '2026-11-09T00:00:00.000Z',
      completed_at: '2026-11-09T00:00:01.000Z',
      setup: null,
      commands: [],
      outcome: 'pass',
      ...overrides,
    }),
  );
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

function makeReviewHO(
  id: string,
  title: string,
  baseRef: string,
  workItem: string,
  reviewedRun: string | null = REVIEWED_RUN,
  reviewedSha: string | null = REVIEWED_SHA_STAMP,
): string {
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
    ...(reviewedRun !== null ? [`reviewed_run: "${reviewedRun}"`] : []),
    ...(reviewedSha !== null ? [`reviewed_sha: "${reviewedSha}"`] : []),
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
 * NOT as the doc's own terminal content. The frontmatter carries the
 * `recovery_outcome`/`recovery_valid`/`worker_report_chars` fields
 * `checkReviewEvidence` actually reads (WK-0166); the body is realistic
 * evidence only, never re-parsed.
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
    `recovery_outcome: ${outcome}`,
    'recovery_valid: true',
    'worker_report_chars: 500',
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
    'recovery_outcome: ',
    'recovery_valid: false',
    'worker_report_chars: 200',
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
    'recovery_outcome: ',
    'recovery_valid: false',
    'worker_report_chars: 0',
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

/**
 * A response doc predating frontmatter-based evidence (WK-0166): no
 * `recovery_outcome`/`recovery_valid`/`worker_report_chars` fields at all,
 * even though the body has a real, passing recovery block. Must refuse —
 * there is no legacy regex fallback.
 */
function makeLegacyReviewResponse(outcome: string, subject: string): string {
  const payload = {
    schema_version: 'kb-dispatch-recovery.v1',
    reported_role: 'reviewer',
    reported_subject: subject,
    reported_outcome: outcome,
    summary: 'Review complete',
    findings: [],
    finding_counts: { total: 0, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
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
 * A structured-passing response doc whose worker report body starts with its
 * OWN `## ` heading (e.g. a reviewer's `## Review: WK-XXXX — ...`) — the
 * exact shape that broke the old `## Worker Report` regex (WK-0166: the
 * lazy `*?` stopped at this FIRST `\n## `, capturing only the blank line
 * between the section header and this heading). The frontmatter-based path
 * never looks at the body at all, so this must still merge as structured.
 */
function makeReviewResponseWithHeadingInBody(subject: string): string {
  return [
    '---',
    `handoff_id: ${subject}`,
    'outcome: delivered',
    'recovery_outcome: passed_no_blocking_or_medium_findings',
    'recovery_valid: true',
    'worker_report_chars: 500',
    '---',
    '',
    '# Response: Code review',
    '',
    '## Outcome',
    'Delivered.',
    '',
    '## Worker Report (evidence, not verdict)',
    '',
    `## Review: ${subject} — Example change`,
    '',
    'The change is correct, tests pass, and no blocking issues were found.',
    '',
    '```kb-dispatch-recovery.v1',
    JSON.stringify(
      {
        schema_version: 'kb-dispatch-recovery.v1',
        reported_role: 'reviewer',
        reported_subject: subject,
        reported_outcome: 'passed_no_blocking_or_medium_findings',
        summary: 'Review complete',
        findings: [],
        finding_counts: { total: 0, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        reviewed_controls: [],
        kind: null,
      },
      null,
      2,
    ),
    '```',
    '',
  ].join('\n');
}

/** Minimal `Handoff` fixture for `selectLatestReview` unit tests — only `id` matters to selection. */
function makeHandoffFixture(id: string): Handoff {
  return {
    id,
    title: `Code review ${id}`,
    mode: 'code_review',
    write_scope: [],
    base_ref: 'dispatch/HO-0001',
    web: false,
    credentials: [],
    data_mounts: [],
    export_mounts: [],
    runtime_envs: [],
    read_first: [],
    vars: [],
    acceptance: [],
    validation: [],
    status: 'draft',
  };
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
  it('merges a delivery branch and deletes it after a passing review', async () => {
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

  // The derived review's stamps live in the wiki repo, so the code repo's base is still an ancestor of the delivery.
  it('fast-forwards a delivery in the nested-private wiki shape', async () => {
    await writeFile(join(repoDir, '.gitignore'), '.agent-runs/\nwiki/\n');
    await execFile('git', ['commit', '-q', '-a', '-m', 'ignore nested wiki'], { cwd: repoDir });
    const wikiDir = join(repoDir, 'wiki');
    await execFile('git', ['init', '-q', wikiDir]);
    await execFile('git', ['config', 'user.email', 'test@test.com'], { cwd: wikiDir });
    await execFile('git', ['config', 'user.name', 'Test'], { cwd: wikiDir });
    await writeAndCommit(
      wikiDir,
      {
        'handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review: Implement thing', 'dispatch/HO-0001', 'WK-0001'),
        'handoffs/HO-0002.response.md': makeReviewResponse('no_findings', 'HO-0001', false),
      },
      'add implement + review HOs',
    );
    const branchName = 'dispatch/HO-0001';
    const base = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim();
    await execFile('git', ['checkout', '-q', '-b', branchName], { cwd: repoDir });
    await writeAndCommit(repoDir, { 'delivered-file.ts': 'export const x = 1;\n' }, 'dispatch: HO-0001');
    const deliverySha = await headSha(repoDir);
    await execFile('git', ['checkout', '-q', base], { cwd: repoDir });
    const reviewPath = join(repoDir, 'wiki', 'handoffs', 'HO-0002.md');
    await writeFile(reviewPath, (await readFile(reviewPath, 'utf8')).replace(REVIEWED_SHA_STAMP, deliverySha));
    await execFile('git', ['commit', '-q', '-a', '-m', 'stamp'], { cwd: wikiDir });
    await writeEvidence(repoDir, 'HO-0001', {});

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.mergeSha).toBe(deliverySha);
    expect(await branchExists(repoDir, branchName)).toBe(false);
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
          REVIEWED_RUN,
          'a'.repeat(40), // derived for a head whose branch is since gone
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

  // -- WK-0166: frontmatter-based evidence (regex re-parse deleted) --------

  it('merges as structured when the worker report body has its own ## headings (WK-0166)', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0016.md': makeImplementHO('HO-0016', 'Implement heading-in-body thing', 'WK-0166'),
        'wiki/handoffs/HO-0017.md': makeReviewHO(
          'HO-0017',
          'Code review: Implement heading-in-body thing',
          'dispatch/HO-0016',
          'WK-0166',
        ),
        'wiki/handoffs/HO-0017.response.md': makeReviewResponseWithHeadingInBody('HO-0016'),
      },
      'add implement + review HOs (heading-in-body worker report)',
    );
    await createDeliveryBranch(repoDir, 'HO-0016');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0016' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.reviewId).toBe('HO-0017');
    expect(result.data.verdict).toBe('structured');
    expect(result.data.reviewOutcome).toBe('passed_no_blocking_or_medium_findings');
    expect(await branchExists(repoDir, 'dispatch/HO-0016')).toBe(false);
  });

  it('merges as advisory when frontmatter reports recovery_valid: false with a non-empty worker report', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0018.md': makeImplementHO('HO-0018', 'Implement advisory-frontmatter thing', 'WK-0166'),
        'wiki/handoffs/HO-0019.md': makeReviewHO(
          'HO-0019',
          'Code review: Implement advisory-frontmatter thing',
          'dispatch/HO-0018',
          'WK-0166',
        ),
        'wiki/handoffs/HO-0019.response.md': makeProseOnlyReviewResponse('HO-0018'),
      },
      'add implement + review HOs (advisory frontmatter)',
    );
    await createDeliveryBranch(repoDir, 'HO-0018');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0018' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.verdict).toBe('advisory');
  });

  it('fails closed when frontmatter reports worker_report_chars: 0', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0020.md': makeImplementHO('HO-0020', 'Implement empty-frontmatter thing', 'WK-0166'),
        'wiki/handoffs/HO-0021.md': makeReviewHO(
          'HO-0021',
          'Code review: Implement empty-frontmatter thing',
          'dispatch/HO-0020',
          'WK-0166',
        ),
        'wiki/handoffs/HO-0021.response.md': makeEmptyReviewResponse('HO-0020'),
      },
      'add implement + review HOs (empty frontmatter)',
    );
    await createDeliveryBranch(repoDir, 'HO-0020');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0020' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(await branchExists(repoDir, 'dispatch/HO-0020')).toBe(true);
  });

  it('refuses a legacy response doc predating frontmatter-based evidence, with no regex fallback', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0022.md': makeImplementHO('HO-0022', 'Implement legacy-doc thing', 'WK-0166'),
        'wiki/handoffs/HO-0023.md': makeReviewHO(
          'HO-0023',
          'Code review: Implement legacy-doc thing',
          'dispatch/HO-0022',
          'WK-0166',
        ),
        'wiki/handoffs/HO-0023.response.md': makeLegacyReviewResponse('no_findings', 'HO-0022'),
      },
      'add implement + review HOs (legacy response doc)',
    );
    await createDeliveryBranch(repoDir, 'HO-0022');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0022' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('predates frontmatter-based evidence');
    expect(await branchExists(repoDir, 'dispatch/HO-0022')).toBe(true);
  });

  // -- WK-0207: newest matching review wins, not the first readdir match --

  describe('selectLatestReview (WK-0207)', () => {
    const ids = ['HO-0012', 'HO-0105', 'HO-0003', 'HO-0098'];
    const expectedWinner = 'HO-0105';

    it('picks the highest numeric id when candidates are given in id order', () => {
      const sorted = [...ids].sort();
      const candidates = sorted.map(makeHandoffFixture);
      expect(selectLatestReview(candidates)?.id).toBe(expectedWinner);
    });

    it('picks the highest numeric id when candidates are given in reversed order', () => {
      const reversed = [...ids].sort().reverse();
      const candidates = reversed.map(makeHandoffFixture);
      expect(selectLatestReview(candidates)?.id).toBe(expectedWinner);
    });

    it('picks the highest numeric id when candidates are given in a fixed shuffled order', () => {
      const shuffled = ['HO-0098', 'HO-0003', 'HO-0105', 'HO-0012'];
      const candidates = shuffled.map(makeHandoffFixture);
      expect(selectLatestReview(candidates)?.id).toBe(expectedWinner);
    });
  });

  it('merges and reports the newer reviewId when an older review was changes_requested and a newer review passes (WK-0207)', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0024.md': makeImplementHO('HO-0024', 'Implement re-reviewed thing', 'WK-0207'),
        'wiki/handoffs/HO-0025.md': makeReviewHO('HO-0025', 'Code review: Implement re-reviewed thing', 'dispatch/HO-0024', 'WK-0207'),
        'wiki/handoffs/HO-0025.response.md': makeReviewResponse('changes_requested', 'HO-0024', true),
        'wiki/handoffs/HO-0026.md': makeReviewHO('HO-0026', 'Code review: Implement re-reviewed thing (re-review)', 'dispatch/HO-0024', 'WK-0207'),
        'wiki/handoffs/HO-0026.response.md': makeReviewResponse('no_findings', 'HO-0024', false),
      },
      'add implement HO + older failing review + newer passing re-review',
    );
    await createDeliveryBranch(repoDir, 'HO-0024');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0024' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.reviewId).toBe('HO-0026');
    expect(result.data.reviewOutcome).toBe('no_findings');
    expect(await branchExists(repoDir, 'dispatch/HO-0024')).toBe(false);
  });

  it('refuses the merge, naming the newer review id, when an older review passed and a newer review is changes_requested (WK-0207)', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0027.md': makeImplementHO('HO-0027', 'Implement regressed thing', 'WK-0207'),
        'wiki/handoffs/HO-0028.md': makeReviewHO('HO-0028', 'Code review: Implement regressed thing', 'dispatch/HO-0027', 'WK-0207'),
        'wiki/handoffs/HO-0028.response.md': makeReviewResponse('no_findings', 'HO-0027', false),
        'wiki/handoffs/HO-0029.md': makeReviewHO('HO-0029', 'Code review: Implement regressed thing (re-review)', 'dispatch/HO-0027', 'WK-0207'),
        'wiki/handoffs/HO-0029.response.md': makeReviewResponse('changes_requested', 'HO-0027', true),
      },
      'add implement HO + older passing review + newer failing re-review',
    );
    await createDeliveryBranch(repoDir, 'HO-0027');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0027' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('HO-0029');
    expect(await branchExists(repoDir, 'dispatch/HO-0027')).toBe(true);
  });

  it('refuses the merge, naming the newer review id with no fallback, when the newer review has no response doc (WK-0207)', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0030.md': makeImplementHO('HO-0030', 'Implement missing-response thing', 'WK-0207'),
        'wiki/handoffs/HO-0031.md': makeReviewHO('HO-0031', 'Code review: Implement missing-response thing', 'dispatch/HO-0030', 'WK-0207'),
        'wiki/handoffs/HO-0031.response.md': makeReviewResponse('no_findings', 'HO-0030', false),
        'wiki/handoffs/HO-0032.md': makeReviewHO('HO-0032', 'Code review: Implement missing-response thing (re-review)', 'dispatch/HO-0030', 'WK-0207'),
        // Deliberately no HO-0032.response.md.
      },
      'add implement HO + older passing review + newer review with no response doc',
    );
    await createDeliveryBranch(repoDir, 'HO-0030');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0030' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('HO-0032');
    expect(await branchExists(repoDir, 'dispatch/HO-0030')).toBe(true);
  });
});

describe('mergeDelivery host validation gate (WK-0294, DEC-0047 A1.2 / A2 R6 R8 / A4.1 A4.5)', () => {
  async function setupReviewedDelivery(): Promise<void> {
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
  }

  const failingCommand = {
    name: 'test',
    argv: ['npm', 'test'],
    network: false,
    exit_code: 1,
    signal: null,
    timed_out: false,
    duration_ms: 10,
    stdout_tail: 'FAIL x.test.ts',
    stderr_tail: '',
    output_truncated: false,
    result: 'fail',
  };

  it('gates a passing merge on evidence and merges the evidence sha', async () => {
    await setupReviewedDelivery();
    const branchSha = (await execFile('git', ['rev-parse', 'dispatch/HO-0001'], { cwd: repoDir })).stdout.trim();
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ gate: 'evidence', mergedSha: branchSha });
    expect(result.data.overrideRecord).toBeUndefined();
  });

  it('refuses when the evidence file is missing', async () => {
    await setupReviewedDelivery();
    await rm(evidencePath(repoDir, 'HO-0001'));
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('no host validation evidence');
    // WK-0306 Resolution 1: missing evidence means no command ran — the jail
    // hermeticity teaching sentence does not apply to this refusal kind.
    expect(result.message).not.toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(true);
  });

  it('refuses unreadable (malformed) evidence, without the jail hermeticity teaching sentence', async () => {
    await setupReviewedDelivery();
    await writeFile(evidencePath(repoDir, 'HO-0001'), '{ not valid json');
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('unreadable');
    expect(result.message).not.toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
  });

  it('refuses a review with no reviewed_run stamp', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001', null),
        'wiki/handoffs/HO-0002.response.md': makeReviewResponse('no_findings', 'HO-0001', false),
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no reviewed_run stamp');
  });

  it('refuses evidence that belongs to a different run than the review reviewed', async () => {
    await setupReviewedDelivery();
    await writeEvidence(repoDir, 'HO-0001', { run_id: 'RUN-other' });
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('RUN-other');
    expect(result.message).not.toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
  });

  it('refuses a failing command without an override, naming it and carrying the jail hermeticity teaching sentence', async () => {
    await setupReviewedDelivery();
    await writeEvidence(repoDir, 'HO-0001', { outcome: 'fail', commands: [failingCommand] });
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('host validation failed (test)');
    // WK-0306 Resolution 1: a registered command failed, so the refusal
    // teaches the loop — fix the host dependency or add a capability probe.
    expect(result.message).toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
  });

  // Why: A4.1 — the reviewer can edit only its jail copy; the gate reads the host original.
  it('ignores a tampered review-run copy of the evidence', async () => {
    await setupReviewedDelivery();
    await writeEvidence(repoDir, 'HO-0001', { outcome: 'fail', commands: [failingCommand] });
    const copy = join(repoDir, '.agent-runs', 'runs', 'HO-0002', 'RUN-review', 'validation-evidence.json');
    await mkdir(join(copy, '..'), { recursive: true });
    await writeFile(copy, JSON.stringify({ outcome: 'pass' }));
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
  });

  it('refuses an override without a reason', async () => {
    await setupReviewedDelivery();
    await writeEvidence(repoDir, 'HO-0001', { outcome: 'fail', commands: [failingCommand] });
    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      override: { reason: '  ', actor: 'operator', surface: 'api' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
  });

  // Why: A2 R8 — an override merge must leave committed provenance that a gated merge never has.
  it('merges a failing delivery under an override and commits a provenance record first', async () => {
    await setupReviewedDelivery();
    await writeEvidence(repoDir, 'HO-0001', { outcome: 'fail', commands: [failingCommand] });
    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      override: { reason: 'flaky upstream test, tracked in WK-9999', actor: 'operator', surface: 'mcp' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.gate).toBe('override');
    expect(result.data.overrideRecord).toBe('wiki/handoffs/HO-0001.merge-override.json');
    const record = JSON.parse((await execFile('git', ['show', 'HEAD:wiki/handoffs/HO-0001.merge-override.json'], { cwd: repoDir })).stdout);
    expect(record).toMatchObject({
      handoff_id: 'HO-0001',
      run_id: REVIEWED_RUN,
      reason: 'flaky upstream test, tracked in WK-9999',
      actor: 'operator',
      actor_authenticated: false,
      surface: 'mcp',
      evidence: { outcome: 'fail', results: [{ name: 'test', result: 'fail', exit_code: 1, timed_out: false }] },
    });
    const log = (await execFile('git', ['log', '--format=%an %s'], { cwd: repoDir })).stdout;
    expect(log).toContain('kb-dispatch chore: merge-delivery override for HO-0001');
    expect((await execFile('git', ['status', '--porcelain'], { cwd: repoDir })).stdout.trim()).toBe('');
  });

  // Why: fail-closed — no committed provenance, no merge.
  it('refuses the override merge when the provenance record cannot be committed', async () => {
    await writeFile(join(repoDir, '.gitignore'), '.agent-runs/\n*.merge-override.json\n');
    await setupReviewedDelivery();
    await writeEvidence(repoDir, 'HO-0001', { outcome: 'fail', commands: [failingCommand] });
    const before = await headSha(repoDir);
    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      override: { reason: 'try anyway', actor: 'operator', surface: 'api' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('fail-closed');
    expect(await headSha(repoDir)).toBe(before);
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(true);
  });

  // Why: A2 R6 — the reviewed commit must be what merges; a moved branch is never mergeable, even with an override.
  it('refuses a branch that moved after the review was derived, even with an override', async () => {
    await setupReviewedDelivery();
    const base = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim();
    await execFile('git', ['checkout', 'dispatch/HO-0001'], { cwd: repoDir });
    await writeAndCommit(repoDir, { 'late.ts': 'export const late = 1;\n' }, 'unreviewed commit');
    await execFile('git', ['checkout', base], { cwd: repoDir });
    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      override: { reason: 'please', actor: 'operator', surface: 'api' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('branch moved after the review was derived');
  });

  // Why: review F1 — re-validating the same run for a new head overwrites its evidence; the review must stay bound to the head it saw.
  it('refuses head B under a passing review of head A after B was re-validated for the same run', async () => {
    await setupReviewedDelivery();
    const shaA = (await execFile('git', ['rev-parse', 'dispatch/HO-0001'], { cwd: repoDir })).stdout.trim();
    const base = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim();
    await execFile('git', ['checkout', 'dispatch/HO-0001'], { cwd: repoDir });
    await writeAndCommit(repoDir, { 'late.ts': 'export const late = 1;\n' }, 'unreviewed commit B');
    await execFile('git', ['checkout', base], { cwd: repoDir });
    // A second derive-review of the same delivered run writes passing evidence for B over A's (derive-review then
    // failed before writing its HO, or that HO was discarded) — the review of A stays the latest.
    await writeEvidence(repoDir, 'HO-0001', {});
    const before = await headSha(repoDir);
    for (const override of [undefined, { reason: 'please', actor: 'operator', surface: 'api' as const }]) {
      const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001', ...(override ? { override } : {}) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('ADMISSION_FAILED');
      expect(result.message).toContain(`review HO-0002 was derived for ${shaA}`);
    }
    expect(await headSha(repoDir)).toBe(before);
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(true);
  });

  it('refuses evidence for a different sha than the review and branch head, even with an override', async () => {
    await setupReviewedDelivery();
    await writeEvidence(repoDir, 'HO-0001', { delivery_sha: 'f'.repeat(40) });
    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      override: { reason: 'please', actor: 'operator', surface: 'api' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('branch moved after validation');
  });

  it('refuses a review with no reviewed_sha stamp', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001', REVIEWED_RUN, null),
        'wiki/handoffs/HO-0002.response.md': makeReviewResponse('no_findings', 'HO-0001', false),
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('no reviewed_sha stamp');
  });

  // Why: HO-0220 F1 — a forged reviewed_run must never point the gate at another run's worker-writable dir.
  it('refuses a traversal reviewed_run aimed at planted passing evidence, with no override record', async () => {
    const planted = '../HO-0003/RUN-00000000-0000-4000-8000-000000000002';
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001', planted),
        'wiki/handoffs/HO-0002.response.md': makeReviewResponse('no_findings', 'HO-0001', false),
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    await writeEvidence(repoDir, 'HO-0001', { outcome: 'fail', commands: [failingCommand] });
    // Lands in .agent-runs/runs/HO-0003/<run>/ — a run dir another HO's worker can write.
    await writeEvidence(repoDir, 'HO-0001', { run_id: planted }, planted);
    const before = await headSha(repoDir);
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    expect(await headSha(repoDir)).toBe(before);
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(true);
  });

  // Why: review F3 — the override record must name the run the review was bound to even when its evidence is gone.
  it('records the reviewed run in an override over missing evidence', async () => {
    await setupReviewedDelivery();
    await rm(evidencePath(repoDir, 'HO-0001'));
    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      override: { reason: 'evidence dir was cleaned up', actor: 'operator', surface: 'api' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.gate).toBe('override');
    const record = JSON.parse((await execFile('git', ['show', 'HEAD:wiki/handoffs/HO-0001.merge-override.json'], { cwd: repoDir })).stdout);
    expect(record).toMatchObject({ run_id: REVIEWED_RUN, evidence: null });
  });

  // Why: A4.5 — evidence from a different registry is stale; revalidate or override.
  it('refuses on a registry fingerprint mismatch and merges it under an override', async () => {
    await setupReviewedDelivery();
    await mkdir(join(repoDir, 'wiki', '.dispatch'), { recursive: true });
    await writeAndCommit(
      repoDir,
      { 'wiki/.dispatch/validation.json': JSON.stringify({ schema_version: 1, commands: [{ name: 't', argv: ['true'], timeout_ms: 1000 }] }) },
      'register a command',
    );
    const refused = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain('validation registry changed');
    // WK-0306 Resolution 1: a stale-registry refusal has no failing command
    // (the recorded evidence itself passed) — no teaching sentence.
    expect(refused.message).not.toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);

    const overridden = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      override: { reason: 'registry change is unrelated to this delivery', actor: 'operator', surface: 'cli' },
    });
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    expect(overridden.data.gate).toBe('override');
  });
});

/**
 * WK-0132 Slice 3 — `mergeDelivery` tests.
 *
 * Covers the merge tool's ordered, fail-closed preconditions (review
 * evidence passes -> delivery branch exists -> working tree clean within the
 * merge's change set -> host validation evidence passes (WK-0294) -> merge
 * succeeds) plus the happy path
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
import { execFileSync } from 'node:child_process';

import { writeResponseDoc } from '../packages/dispatch-core/src/capture.js';
import type { DeliveryOutcome } from '../packages/dispatch-core/src/delivery.js';
import { mergeDelivery, selectLatestReview } from '../packages/dispatch-core/src/merge-delivery.js';
import { validateRecoveryPayload, type RecoveryBlockEvidence } from '../packages/dispatch-core/src/recovery-block.js';
import type { Handoff } from '../packages/dispatch-core/src/ho.js';
import { validationRegistryFingerprint } from '../packages/dispatch-core/src/repo-config.js';
import { JAIL_HERMETICITY_TEACHING_SENTENCE } from '../packages/dispatch-core/src/host-validation.js';

const execFile = promisify(execFileCallback);

function probeBwrapFunctional(): boolean {
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Red host validation is produced live by a failing registered command, which needs a working bwrap. */
const BWRAP_FUNCTIONAL = probeBwrapFunctional();
if (!BWRAP_FUNCTIONAL) {
  console.warn('SKIPPED: red host validation merge tests require a working bwrap (`bwrap --ro-bind / / true` failed).');
}

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
 * adds the delivered file(s), commits them as the "worker" commit, then
 * checks back out — as `delivery.ts` lands worker commits in the real
 * pipeline. Then does derive-review's part: stamps the delivery sha into
 * every review HO for this branch (the `REVIEWED_SHA_STAMP` placeholder),
 * commits that on the base, and writes passing host evidence for the
 * delivery sha. `files` defaults to the single delivered file most tests use.
 */
async function createDeliveryBranch(
  dir: string,
  handoffId: string,
  files: Record<string, string> = { 'delivered-file.ts': 'export const x = 1;\n' },
  /** Branch the delivery starts from; a fix-up delivers on top of the delivery it fixes. Default: the current HEAD. */
  startPoint?: string,
): Promise<void> {
  const branchName = `dispatch/${handoffId}`;
  const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  const baseBranch = stdout.trim();
  await execFile('git', ['checkout', '-b', branchName, ...(startPoint !== undefined ? [startPoint] : [])], { cwd: dir });
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(join(dir, relPath, '..'), { recursive: true });
    await writeFile(join(dir, relPath), content);
  }
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
  await writeDeliveredRun(dir, handoffId);
  await writeEvidence(dir, handoffId, {});
}

/** The run state a delivered dispatch leaves; merge-delivery finds the head's evidence through it. */
async function writeDeliveredRun(dir: string, handoffId: string): Promise<void> {
  const stateDir = join(dir, '.agent-runs', 'runs', handoffId, REVIEWED_RUN);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'state.json'),
    JSON.stringify({ schema_version: 2, outcome: 'delivered', branch: `dispatch/${handoffId}`, completed_at: '2026-11-09T00:00:01.000Z' }),
  );
}

/** Registers a command that fails on any delivery, so the head's evidence is red; merge-delivery produces it live. */
async function registerFailingCommand(dir: string): Promise<void> {
  await mkdir(join(dir, 'wiki', '.dispatch'), { recursive: true });
  await writeAndCommit(
    dir,
    { 'wiki/.dispatch/validation.json': JSON.stringify({ schema_version: 1, commands: [{ name: 'test', argv: ['bash', '-c', 'exit 1'], timeout_ms: 30_000 }] }) },
    'register a failing command',
  );
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
function makeReviewResponse(
  outcome: string,
  subject: string,
  includeFinding: boolean,
  findingIds: readonly string[] = ['F1'],
): string {
  const findings = includeFinding
    ? findingIds.map((id) => ({
        id,
        title: `Example finding ${id}`,
        severity: 'high',
        blocking: true,
        affected_paths: [{ path: 'packages/dispatch-core/src/example.ts', line: 10 }],
        control_id: null,
      }))
    : [];
  const finding_counts = {
    total: findings.length,
    blocking: findings.length,
    critical: 0,
    high: findings.length,
    medium: 0,
    low: 0,
    info: 0,
  };
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
    // As capture.ts stamps it: a valid block with findings only.
    ...(findings.length > 0
      ? [`recovery_findings: ${JSON.stringify(findings.map(({ id, title, severity, blocking }) => ({ id, title, severity, blocking })))}`]
      : []),
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
    await writeDeliveredRun(repoDir, 'HO-0001');
    await writeEvidence(repoDir, 'HO-0001', {});

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.mergeSha).toBe(deliverySha);
    expect(await branchExists(repoDir, branchName)).toBe(false);
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

  it('merges when the only dirty path is an unrelated untracked file', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0008.md': makeImplementHO('HO-0008', 'Implement thing', 'WK-0005'),
        'wiki/handoffs/HO-0009.md': makeReviewHO('HO-0009', 'Code review: Implement thing', 'dispatch/HO-0008', 'WK-0005'),
        'wiki/handoffs/HO-0009.response.md': makeReviewResponse('no_findings', 'HO-0008', false),
      },
      'add implement + review HOs (unrelated untracked)',
    );
    await createDeliveryBranch(repoDir, 'HO-0008');

    // An untracked file that is not part of the branch's change set.
    await writeFile(join(repoDir, 'untracked-scratch.txt'), 'scratch\n');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0008' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(await branchExists(repoDir, 'dispatch/HO-0008')).toBe(false);
  });

  it('merges when the only dirty path is an unrelated unstaged edit to a tracked file', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0033.md': makeImplementHO('HO-0033', 'Implement thing', 'WK-0006'),
        'wiki/handoffs/HO-0034.md': makeReviewHO('HO-0034', 'Code review: Implement thing', 'dispatch/HO-0033', 'WK-0006'),
        'wiki/handoffs/HO-0034.response.md': makeReviewResponse('no_findings', 'HO-0033', false),
      },
      'add implement + review HOs (unrelated unstaged edit)',
    );
    await createDeliveryBranch(repoDir, 'HO-0033');

    // An unstaged edit to a tracked file the branch never touches.
    await writeFile(join(repoDir, 'dummy.txt'), 'edited locally\n');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0033' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(await branchExists(repoDir, 'dispatch/HO-0033')).toBe(false);
  });

  it("refuses when a dirty path collides with the merge's change set, listing only the colliding paths", async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0035.md': makeImplementHO('HO-0035', 'Implement thing', 'WK-0007'),
        'wiki/handoffs/HO-0036.md': makeReviewHO('HO-0036', 'Code review: Implement thing', 'dispatch/HO-0035', 'WK-0007'),
        'wiki/handoffs/HO-0036.response.md': makeReviewResponse('no_findings', 'HO-0035', false),
      },
      'add implement + review HOs (colliding dirty path)',
    );
    // The branch changes the already-tracked dummy.txt, so it lands in the change set.
    await createDeliveryBranch(repoDir, 'HO-0035', { 'dummy.txt': 'changed on branch\n' });

    // Dirty dummy.txt locally (collides) and an unrelated file (does not).
    await writeFile(join(repoDir, 'dummy.txt'), 'edited locally\n');
    await writeFile(join(repoDir, 'scratch.txt'), 'scratch\n');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0035' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('DIRTY_REPO');
    expect(result.detail).toMatchObject({ dirtyPaths: ['dummy.txt'] });
    expect(await branchExists(repoDir, 'dispatch/HO-0035')).toBe(true);
  });

  it('refuses when the branch renames a tracked file and the old path is dirty locally', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0045.md': makeImplementHO('HO-0045', 'Implement thing', 'WK-0012'),
        'wiki/handoffs/HO-0046.md': makeReviewHO('HO-0046', 'Code review: Implement thing', 'dispatch/HO-0045', 'WK-0012'),
        'wiki/handoffs/HO-0046.response.md': makeReviewResponse('no_findings', 'HO-0045', false),
      },
      'add implement + review HOs (rename collision)',
    );

    // The branch renames the already-tracked dummy.txt instead of adding a new file.
    const branchName = 'dispatch/HO-0045';
    const base = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim();
    await execFile('git', ['checkout', '-b', branchName], { cwd: repoDir });
    await execFile('git', ['mv', 'dummy.txt', 'renamed.txt'], { cwd: repoDir });
    await execFile('git', ['commit', '-m', 'dispatch: HO-0045'], { cwd: repoDir });
    const deliverySha = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
    await execFile('git', ['checkout', base], { cwd: repoDir });
    const reviewPath = join(repoDir, 'wiki', 'handoffs', 'HO-0046.md');
    await writeFile(reviewPath, (await readFile(reviewPath, 'utf8')).replace(REVIEWED_SHA_STAMP, deliverySha));
    await execFile('git', ['commit', '-a', '-m', 'derive-review stamps for HO-0045'], { cwd: repoDir });
    await writeEvidence(repoDir, 'HO-0045', {});

    // An unstaged edit at the OLD path the branch renamed away from.
    await writeFile(join(repoDir, 'dummy.txt'), 'edited locally\n');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0045' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('DIRTY_REPO');
    expect(result.detail).toMatchObject({ dirtyPaths: ['dummy.txt'] });
    expect(await branchExists(repoDir, 'dispatch/HO-0045')).toBe(true);
  });

  it('refuses when an untracked file sits at a path the branch creates', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0037.md': makeImplementHO('HO-0037', 'Implement thing', 'WK-0008'),
        'wiki/handoffs/HO-0038.md': makeReviewHO('HO-0038', 'Code review: Implement thing', 'dispatch/HO-0037', 'WK-0008'),
        'wiki/handoffs/HO-0038.response.md': makeReviewResponse('no_findings', 'HO-0037', false),
      },
      'add implement + review HOs (untracked at created path)',
    );
    await createDeliveryBranch(repoDir, 'HO-0037');

    // Untracked locally at the exact path the branch would create.
    await writeFile(join(repoDir, 'delivered-file.ts'), 'local draft\n');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0037' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('DIRTY_REPO');
    expect(result.detail).toMatchObject({ dirtyPaths: ['delivered-file.ts'] });
  });

  it('refuses when an unrelated path is staged, listing the staged path', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0039.md': makeImplementHO('HO-0039', 'Implement thing', 'WK-0009'),
        'wiki/handoffs/HO-0040.md': makeReviewHO('HO-0040', 'Code review: Implement thing', 'dispatch/HO-0039', 'WK-0009'),
        'wiki/handoffs/HO-0040.response.md': makeReviewResponse('no_findings', 'HO-0039', false),
      },
      'add implement + review HOs (staged unrelated file)',
    );
    await createDeliveryBranch(repoDir, 'HO-0039');

    await writeFile(join(repoDir, 'staged-unrelated.txt'), 'staged\n');
    await execFile('git', ['add', 'staged-unrelated.txt'], { cwd: repoDir });

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0039' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('DIRTY_REPO');
    expect(result.detail).toMatchObject({ dirtyPaths: ['staged-unrelated.txt'] });
    expect(await branchExists(repoDir, 'dispatch/HO-0039')).toBe(true);
  });

  it('refuses on a file/directory prefix clash between a dirty path and the change set', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0041.md': makeImplementHO('HO-0041', 'Implement thing', 'WK-0010'),
        'wiki/handoffs/HO-0042.md': makeReviewHO('HO-0042', 'Code review: Implement thing', 'dispatch/HO-0041', 'WK-0010'),
        'wiki/handoffs/HO-0042.response.md': makeReviewResponse('no_findings', 'HO-0041', false),
      },
      'add implement + review HOs (directory prefix clash)',
    );
    // The branch adds a file inside a directory; locally there's a plain file of the same name as the directory.
    await createDeliveryBranch(repoDir, 'HO-0041', { 'conflict/dir/file.ts': 'export const y = 1;\n' });
    await writeFile(join(repoDir, 'conflict'), 'a local file, not a directory\n');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0041' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('DIRTY_REPO');
    expect(result.detail).toMatchObject({ dirtyPaths: ['conflict'] });
  });

  it('keeps unrelated dirty files out of the merge commit and leaves them unchanged afterward', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0043.md': makeImplementHO('HO-0043', 'Implement thing', 'WK-0011'),
        'wiki/handoffs/HO-0044.md': makeReviewHO('HO-0044', 'Code review: Implement thing', 'dispatch/HO-0043', 'WK-0011'),
        'wiki/handoffs/HO-0044.response.md': makeReviewResponse('no_findings', 'HO-0043', false),
      },
      'add implement + review HOs (survives merge)',
    );
    await createDeliveryBranch(repoDir, 'HO-0043');
    const preMergeHead = await headSha(repoDir);

    await writeFile(join(repoDir, 'untouched.txt'), 'before\n');
    await writeFile(join(repoDir, 'dummy.txt'), 'edited unstaged\n');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0043' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);

    // The merge commit's diff from the pre-merge HEAD is exactly the branch's own
    // diff (a clean merge's first-parent diff equals its merge-base-to-branch diff) —
    // the unrelated dirty files never entered it.
    const { stdout } = await execFile(
      'git',
      ['diff', '--name-only', '--no-renames', preMergeHead, result.data.mergeSha],
      { cwd: repoDir },
    );
    const changed = stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(changed).toEqual(['delivered-file.ts']);

    // The dirty files survive, unchanged, in the working tree.
    expect(await readFile(join(repoDir, 'untouched.txt'), 'utf8')).toBe('before\n');
    expect(await readFile(join(repoDir, 'dummy.txt'), 'utf8')).toBe('edited unstaged\n');
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

    // The older review's finding still needs its judgment; the newer review governs.
    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0024',
      judgments: [{ finding: 'F1', judgment: 'dismiss', reason: 'fixed in the same delivery' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.reviewId).toBe('HO-0026');
    expect(result.data.reviewOutcome).toBe('no_findings');
    expect(await branchExists(repoDir, 'dispatch/HO-0024')).toBe(false);
  });

  it('names the newer review id in the refusal when an older review passed and a newer review has an unjudged finding', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0027.md': makeImplementHO('HO-0027', 'Implement regressed thing', 'WK-0207'),
        'wiki/handoffs/HO-0028.md': makeReviewHO('HO-0028', 'Code review: Implement regressed thing', 'dispatch/HO-0027', 'WK-0207'),
        'wiki/handoffs/HO-0028.response.md': makeReviewResponse('no_findings', 'HO-0027', false),
        'wiki/handoffs/HO-0029.md': makeReviewHO('HO-0029', 'Code review: Implement regressed thing (re-review)', 'dispatch/HO-0027', 'WK-0207'),
        'wiki/handoffs/HO-0029.response.md': makeReviewResponse('changes_requested', 'HO-0027', true),
      },
      'add implement HO + older passing review + newer re-review with a finding',
    );
    await createDeliveryBranch(repoDir, 'HO-0027');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0027' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('HO-0029/F1');
    expect(await branchExists(repoDir, 'dispatch/HO-0027')).toBe(true);
  });

  // A review that was derived and never finished does not govern: the newest finished review does.
  it.each([
    ['has no response doc', undefined],
    ['has an empty report', makeEmptyReviewResponse('HO-0030')],
  ])('merges on the older finished review when a newer review %s', async (_name, newerResponse) => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0030.md': makeImplementHO('HO-0030', 'Implement unfinished-review thing', 'WK-0207'),
        'wiki/handoffs/HO-0031.md': makeReviewHO('HO-0031', 'Code review: Implement unfinished-review thing', 'dispatch/HO-0030', 'WK-0207'),
        'wiki/handoffs/HO-0031.response.md': makeReviewResponse('no_findings', 'HO-0030', false),
        'wiki/handoffs/HO-0032.md': makeReviewHO('HO-0032', 'Code review: Implement unfinished-review thing (re-review)', 'dispatch/HO-0030', 'WK-0207'),
        ...(newerResponse !== undefined ? { 'wiki/handoffs/HO-0032.response.md': newerResponse } : {}),
      },
      'add implement HO + older finished review + newer unfinished review',
    );
    await createDeliveryBranch(repoDir, 'HO-0030');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0030' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.reviewId).toBe('HO-0031');
    expect(await branchExists(repoDir, 'dispatch/HO-0030')).toBe(false);
  });

  it('refuses, naming each unfinished review with its state and the next step, when no review is finished', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0030.md': makeImplementHO('HO-0030', 'Implement unfinished-review thing', 'WK-0207'),
        'wiki/handoffs/HO-0031.md': makeReviewHO('HO-0031', 'Code review: first', 'dispatch/HO-0030', 'WK-0207'),
        'wiki/handoffs/HO-0032.md': makeReviewHO('HO-0032', 'Code review: second', 'dispatch/HO-0030', 'WK-0207'),
        'wiki/handoffs/HO-0032.response.md': makeEmptyReviewResponse('HO-0030'),
      },
      'add implement HO + two unfinished reviews',
    );
    await createDeliveryBranch(repoDir, 'HO-0030');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0030' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('HO-0031 (no response doc)');
    expect(result.message).toContain('HO-0032 (empty report)');
    expect(result.message).toContain('dispatch it, or run derive-review for HO-0030');
    expect(await branchExists(repoDir, 'dispatch/HO-0030')).toBe(true);
  });

  // An unfinished newer review must not hide the findings of a finished one.
  it('still needs a judgment for every finding of a finished review when a newer review is unfinished', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0030.md': makeImplementHO('HO-0030', 'Implement unfinished-review thing', 'WK-0207'),
        'wiki/handoffs/HO-0031.md': makeReviewHO('HO-0031', 'Code review: first', 'dispatch/HO-0030', 'WK-0207'),
        'wiki/handoffs/HO-0031.response.md': makeReviewResponse('changes_requested', 'HO-0030', true),
        'wiki/handoffs/HO-0032.md': makeReviewHO('HO-0032', 'Code review: second', 'dispatch/HO-0030', 'WK-0207'),
      },
      'add implement HO + finished review with a finding + unfinished review',
    );
    await createDeliveryBranch(repoDir, 'HO-0030');
    expect(await refusal(repoDir, 'HO-0030')).toContain('HO-0031/F1');
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

  it('gates a passing merge on evidence and merges the evidence sha', async () => {
    await setupReviewedDelivery();
    const branchSha = (await execFile('git', ['rev-parse', 'dispatch/HO-0001'], { cwd: repoDir })).stdout.trim();
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ gate: 'evidence', mergedSha: branchSha });
    expect(result.data.overrideRecord).toBeUndefined();
  });

  // Why: the head's evidence is produced on demand; a head with no evidence on disk is validated, not refused.
  it('produces host validation evidence for the head when none is on disk', async () => {
    await setupReviewedDelivery();
    await rm(evidencePath(repoDir, 'HO-0001'));
    const branchSha = (await execFile('git', ['rev-parse', 'dispatch/HO-0001'], { cwd: repoDir })).stdout.trim();
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ gate: 'evidence', mergedSha: branchSha });
    const written = JSON.parse(await readFile(evidencePath(repoDir, 'HO-0001'), 'utf8'));
    expect(written).toMatchObject({ delivery_sha: branchSha, outcome: 'pass' });
  });

  // Why: a damaged evidence file is stale, not fatal; the host produces it again and the merge goes on.
  it('validates the head again over a malformed evidence file, rewrites it, and merges', async () => {
    await setupReviewedDelivery();
    await writeFile(evidencePath(repoDir, 'HO-0001'), '{ not valid json');
    const branchSha = (await execFile('git', ['rev-parse', 'dispatch/HO-0001'], { cwd: repoDir })).stdout.trim();
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data).toMatchObject({ gate: 'evidence', mergedSha: branchSha });
    expect(JSON.parse(await readFile(evidencePath(repoDir, 'HO-0001'), 'utf8'))).toMatchObject({ delivery_sha: branchSha, outcome: 'pass' });
  });

  // Why: with no command registered the gate passes with nothing run; the result must say so.
  it('reports zero validation steps when no command is registered', async () => {
    await setupReviewedDelivery();
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.validationSteps).toBe(0);
  });

  it.skipIf(!BWRAP_FUNCTIONAL)('reports how many validation steps the evidence holds', async () => {
    await setupReviewedDelivery();
    await mkdir(join(repoDir, 'wiki', '.dispatch'), { recursive: true });
    await writeAndCommit(
      repoDir,
      {
        'wiki/.dispatch/validation.json': JSON.stringify({
          schema_version: 1,
          commands: [
            { name: 'one', argv: ['bash', '-c', 'exit 0'], timeout_ms: 30_000 },
            { name: 'two', argv: ['bash', '-c', 'exit 0'], timeout_ms: 30_000 },
          ],
        }),
      },
      'register two passing commands',
    );
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.validationSteps).toBe(2);
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

  it.skipIf(!BWRAP_FUNCTIONAL)('refuses a failing command without an override, naming it and carrying the jail hermeticity teaching sentence', async () => {
    await setupReviewedDelivery();
    await registerFailingCommand(repoDir);
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
  it.skipIf(!BWRAP_FUNCTIONAL)('ignores a tampered review-run copy of the evidence', async () => {
    await setupReviewedDelivery();
    await registerFailingCommand(repoDir);
    const copy = join(repoDir, '.agent-runs', 'runs', 'HO-0002', 'RUN-review', 'validation-evidence.json');
    await mkdir(join(copy, '..'), { recursive: true });
    await writeFile(copy, JSON.stringify({ outcome: 'pass' }));
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
  });

  it.skipIf(!BWRAP_FUNCTIONAL)('refuses an override without a reason', async () => {
    await setupReviewedDelivery();
    await registerFailingCommand(repoDir);
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
  it.skipIf(!BWRAP_FUNCTIONAL)('merges a failing delivery under an override and commits a provenance record first', async () => {
    await setupReviewedDelivery();
    await registerFailingCommand(repoDir);
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
  it.skipIf(!BWRAP_FUNCTIONAL)('refuses the override merge when the provenance record cannot be committed', async () => {
    await writeFile(join(repoDir, '.gitignore'), '.agent-runs/\n*.merge-override.json\n');
    await setupReviewedDelivery();
    await registerFailingCommand(repoDir);
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

  // Why: stored evidence for another sha proves nothing about the head; the head is validated again.
  it('revalidates the head when the stored evidence is for another sha', async () => {
    await setupReviewedDelivery();
    await writeEvidence(repoDir, 'HO-0001', { delivery_sha: 'f'.repeat(40) });
    const branchSha = (await execFile('git', ['rev-parse', 'dispatch/HO-0001'], { cwd: repoDir })).stdout.trim();
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ gate: 'evidence', mergedSha: branchSha });
    expect(JSON.parse(await readFile(evidencePath(repoDir, 'HO-0001'), 'utf8')).delivery_sha).toBe(branchSha);
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
  it.skipIf(!BWRAP_FUNCTIONAL)('refuses a traversal reviewed_run aimed at planted passing evidence, with no override record', async () => {
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
    await registerFailingCommand(repoDir);
    // Lands in .agent-runs/runs/HO-0003/<run>/ — a run dir another HO's worker can write.
    await writeEvidence(repoDir, 'HO-0001', { run_id: planted }, planted);
    const before = await headSha(repoDir);
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    expect(await headSha(repoDir)).toBe(before);
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(true);
  });

  // Why: review F3 — the override record must name the head run even when its evidence is unusable.
  it('records the head run in an override over evidence that cannot be produced', async () => {
    await setupReviewedDelivery();
    await mkdir(join(repoDir, 'wiki', '.dispatch'), { recursive: true });
    await writeAndCommit(
      repoDir,
      {
        'wiki/.dispatch/validation.json': JSON.stringify({
          schema_version: 1,
          commands: [{ name: 'test', argv: ['bash', '-c', 'exit 0'], timeout_ms: 30_000 }],
          runtime_paths: ['/nonexistent-runtime-root'],
        }),
      },
      'register a command with a runtime path that does not exist',
    );
    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      override: { reason: 'the registered runtime root is gone', actor: 'operator', surface: 'api' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.gate).toBe('override');
    const record = JSON.parse((await execFile('git', ['show', 'HEAD:wiki/handoffs/HO-0001.merge-override.json'], { cwd: repoDir })).stdout);
    expect(record).toMatchObject({ run_id: REVIEWED_RUN, evidence: null });
  });

  // Why: A4.5 — evidence from a different registry is stale; the head is validated again under the current one.
  it.skipIf(!BWRAP_FUNCTIONAL)('revalidates under the current registry when the stored evidence is from another one, and merges a red head under an override', async () => {
    await setupReviewedDelivery();
    await registerFailingCommand(repoDir);
    const refused = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain('host validation failed (test)');
    expect(JSON.parse(await readFile(evidencePath(repoDir, 'HO-0001'), 'utf8')).registry_fingerprint).not.toBe(validationRegistryFingerprint(null));

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

describe('mergeDelivery over a fix-up chain', () => {
  

  /**
   * HO-0001 delivered and reviewed (HO-0003); HO-0002 is a fix-up delivered on
   * top of dispatch/HO-0001. `betweenCommit` lands a commit on the first branch
   * after its review was derived and before the fix-up is delivered.
   */
  async function setupFixupChain(opts: { betweenCommit?: boolean; headReview?: boolean } = {}): Promise<{ shaA: string; shaF: string }> {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeImplementHO('HO-0002', 'Fix thing', 'WK-0001'),
        'wiki/handoffs/HO-0003.md': makeReviewHO('HO-0003', 'Code review: the first delivery', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0003.response.md': makeReviewResponse('no_findings', 'HO-0001', false),
        ...(opts.headReview === true
          ? {
              'wiki/handoffs/HO-0004.md': makeReviewHO('HO-0004', 'Code review: the fix-up', 'dispatch/HO-0002', 'WK-0001'),
              'wiki/handoffs/HO-0004.response.md': makeReviewResponse('no_findings', 'HO-0002', false),
            }
          : {}),
      },
      'add implement + review HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    const shaA = (await execFile('git', ['rev-parse', 'dispatch/HO-0001'], { cwd: repoDir })).stdout.trim();
    if (opts.betweenCommit === true) {
      const base = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim();
      await execFile('git', ['checkout', 'dispatch/HO-0001'], { cwd: repoDir });
      await writeAndCommit(repoDir, { 'hand-edit.ts': 'export const hand = 1;\n' }, 'hand edit outside dispatch');
      await execFile('git', ['checkout', base], { cwd: repoDir });
    }
    await createDeliveryBranch(repoDir, 'HO-0002', { 'fix.ts': 'export const fix = 1;\n' }, 'dispatch/HO-0001');
    const shaF = (await execFile('git', ['rev-parse', 'dispatch/HO-0002'], { cwd: repoDir })).stdout.trim();
    return { shaA, shaF };
  }

  it('merges a fix-up chain head using the review of an earlier chain member, with evidence for the head sha', async () => {
    const { shaF } = await setupFixupChain();
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0002' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data).toMatchObject({ mergedBranch: 'dispatch/HO-0002', reviewId: 'HO-0003', gate: 'evidence', mergedSha: shaF });
    await execFile('git', ['cat-file', '-e', 'HEAD:fix.ts'], { cwd: repoDir });
    await execFile('git', ['cat-file', '-e', 'HEAD:delivered-file.ts'], { cwd: repoDir });
  });

  it('refuses when a non-dispatch commit sits between reviewed_sha and the head (names the commit)', async () => {
    const { shaA } = await setupFixupChain({ betweenCommit: true });
    const handSha = (await execFile('git', ['rev-parse', 'dispatch/HO-0001'], { cwd: repoDir })).stdout.trim();
    const before = await headSha(repoDir);
    for (const override of [undefined, { reason: 'please', actor: 'operator', surface: 'api' as const }]) {
      const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0002', ...(override ? { override } : {}) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('ADMISSION_FAILED');
      expect(result.message).toContain(handSha);
      expect(result.message).toContain('hand edit outside dispatch');
      expect(result.message).toContain(shaA);
      expect(result.message).toContain('derive-review');
    }
    expect(await headSha(repoDir)).toBe(before);
    expect(await branchExists(repoDir, 'dispatch/HO-0002')).toBe(true);
  });

  // Why: the earlier green evidence says nothing about the fix-up head; the head's own evidence decides.
  it.skipIf(!BWRAP_FUNCTIONAL)("refuses when the head's evidence is red even though the reviewed sha's evidence was green", async () => {
    await setupFixupChain();
    await registerFailingCommand(repoDir);
    const evidenceA = JSON.parse(await readFile(evidencePath(repoDir, 'HO-0001'), 'utf8'));
    expect(evidenceA.outcome).toBe('pass');
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0002' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('host validation failed (test)');
    expect(await branchExists(repoDir, 'dispatch/HO-0002')).toBe(true);
  });

  it('reports review and delivery counts', async () => {
    await setupFixupChain({ headReview: true });
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0002' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data).toMatchObject({ reviewId: 'HO-0004', reviewCount: 2, implementDeliveries: 2 });
  });

  it('deletes fully merged intermediate chain branches', async () => {
    await setupFixupChain();
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0002' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.deletedBranches).toEqual(['dispatch/HO-0002', 'dispatch/HO-0001']);
    expect(result.data.keptBranches).toEqual([]);
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(false);
    expect(await branchExists(repoDir, 'dispatch/HO-0002')).toBe(false);
  });

  it('keeps a member branch that is not fully merged, with the reason, and deletes the rest', async () => {
    await setupFixupChain();
    // A commit lands on the first member's branch after the head was cut: the merge does not carry it.
    const base = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim();
    await execFile('git', ['checkout', 'dispatch/HO-0001'], { cwd: repoDir });
    await writeAndCommit(repoDir, { 'late.ts': 'export const late = 1;\n' }, 'a commit after the head was cut');
    await execFile('git', ['checkout', base], { cwd: repoDir });

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0002' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.deletedBranches).toEqual(['dispatch/HO-0002']);
    expect(result.data.keptBranches).toEqual([{ branch: 'dispatch/HO-0001', reason: 'not fully merged into the merge target' }]);
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(true);
    expect(await branchExists(repoDir, 'dispatch/HO-0002')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Judgments: a review advises; every finding needs one judgment before the merge.
// ---------------------------------------------------------------------------

/** A judgments record as the merge writes it. */
interface JudgmentsRecord {
  schema: string;
  handoff_id: string;
  head_sha: string;
  recorded_at: string;
  reviews: {
    review_id: string;
    reviewed_sha: string;
    outcome: string;
    findings: { id: string; title: string; severity: string; blocking: boolean; judgment: string; reason: string | null }[];
  }[];
}

async function refusal(dir: string, handoffId: string, judgments?: Parameters<typeof mergeDelivery>[0]['judgments']): Promise<string> {
  const before = await headSha(dir);
  const result = await mergeDelivery({ dir, handoff_id: handoffId, ...(judgments !== undefined ? { judgments } : {}) });
  if (result.ok) throw new Error('expected refusal, got ok');
  expect(result.error).toBe('ADMISSION_FAILED');
  // Nothing was committed, merged or deleted.
  expect(await headSha(dir)).toBe(before);
  expect(await branchExists(dir, `dispatch/${handoffId}`)).toBe(true);
  return result.message;
}

describe('mergeDelivery judgments', () => {
  /** HO-0001 delivered; review HO-0002 of it reports `doc`. */
  async function setupReviewed(doc: string): Promise<void> {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review: Implement thing', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0002.response.md': doc,
      },
      'add implement + review HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
  }

  const twoFindings = (): string => makeReviewResponse('changes_requested', 'HO-0001', true, ['F1', 'F2']);

  it('merges a changes_requested review once every finding is dismissed or deferred, and records them before the merge', async () => {
    await setupReviewed(twoFindings());
    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      judgments: [
        { finding: 'F1', judgment: 'dismiss', reason: 'not a defect' },
        { finding: 'F2', judgment: 'defer', reason: 'tracked for a later slice' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.reviewOutcome).toBe('changes_requested');
    expect(result.data.judgments).toEqual({ total: 2, fix: 0, dismiss: 1, defer: 1 });
    expect(result.data.judgmentsRecord).toBe('wiki/handoffs/HO-0001.judgments.json');

    // The record is in the first parent of the merge: committed before it, not by it.
    const { stdout: subjects } = await execFile('git', ['log', '--first-parent', '--format=%s', '-2'], { cwd: repoDir });
    expect(subjects.trim().split('\n')[1]).toBe('chore: merge-delivery judgments for HO-0001');
    const { stdout } = await execFile('git', ['show', 'HEAD^1:wiki/handoffs/HO-0001.judgments.json'], { cwd: repoDir });
    const record = JSON.parse(stdout) as JudgmentsRecord;
    expect(record).toMatchObject({ schema: 'kb-dispatch-merge-judgments.v1', handoff_id: 'HO-0001', head_sha: result.data.mergedSha });
    expect(Number.isNaN(Date.parse(record.recorded_at))).toBe(false);
    expect(record.reviews).toHaveLength(1);
    expect(record.reviews[0]).toMatchObject({ review_id: 'HO-0002', outcome: 'changes_requested' });
    expect(record.reviews[0]!.reviewed_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(record.reviews[0]!.findings).toEqual([
      { id: 'F1', title: 'Example finding F1', severity: 'high', blocking: true, judgment: 'dismiss', reason: 'not a defect' },
      { id: 'F2', title: 'Example finding F2', severity: 'high', blocking: true, judgment: 'defer', reason: 'tracked for a later slice' },
    ]);
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(false);
  });

  it('merges a finding judged fix when a fix-up delivery follows the review', async () => {
    await setupReviewed(makeReviewResponse('changes_requested', 'HO-0001', true));
    await writeAndCommit(repoDir, { 'wiki/handoffs/HO-0003.md': makeImplementHO('HO-0003', 'Fix thing', 'WK-0001') }, 'add fix-up HO');
    await createDeliveryBranch(repoDir, 'HO-0003', { 'fix.ts': 'export const fix = 1;\n' }, 'dispatch/HO-0001');
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0003', judgments: [{ finding: 'F1', judgment: 'fix' }] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data).toMatchObject({ mergedBranch: 'dispatch/HO-0003', judgments: { total: 1, fix: 1, dismiss: 0, defer: 0 } });
    await execFile('git', ['cat-file', '-e', 'HEAD:fix.ts'], { cwd: repoDir });
    const record = JSON.parse(await readFile(join(repoDir, 'wiki/handoffs/HO-0003.judgments.json'), 'utf8')) as JudgmentsRecord;
    expect(record.reviews[0]!.findings[0]).toMatchObject({ id: 'F1', judgment: 'fix', reason: null });
  });

  it('refuses a fix with no delivery after the review, and names the next step', async () => {
    await setupReviewed(makeReviewResponse('changes_requested', 'HO-0001', true));
    const message = await refusal(repoDir, 'HO-0001', [{ finding: 'F1', judgment: 'fix' }]);
    expect(message).toContain('HO-0002/F1 judged fix, but no delivery follows review HO-0002');
    expect(message).toContain('dispatch a fix-up handoff with base_ref dispatch/HO-0001');
    expect(message).toContain('dismiss or defer with a reason');
  });

  it('refuses a fix when the review carries no reviewed_sha stamp', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001', REVIEWED_RUN, null),
        'wiki/handoffs/HO-0002.response.md': makeReviewResponse('changes_requested', 'HO-0001', true),
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    const message = await refusal(repoDir, 'HO-0001', [{ finding: 'F1', judgment: 'fix' }]);
    expect(message).toContain('carries no reviewed_sha stamp');
  });

  // Why: a review of a commit the branch does not hold cannot be followed by a delivery on this branch.
  it('refuses a fix for a review whose reviewed_sha is not part of the branch', async () => {
    const stray = (await execFile('git', ['commit-tree', 'HEAD^{tree}', '-m', 'a commit of another history'], { cwd: repoDir })).stdout.trim();
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review: reset branch', 'dispatch/HO-0001', 'WK-0001', REVIEWED_RUN, stray),
        'wiki/handoffs/HO-0002.response.md': makeReviewResponse('changes_requested', 'HO-0001', true),
        'wiki/handoffs/HO-0003.md': makeReviewHO('HO-0003', 'Code review: head', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0003.response.md': makeReviewResponse('no_findings', 'HO-0001', false),
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    const message = await refusal(repoDir, 'HO-0001', [{ review: 'HO-0002', finding: 'F1', judgment: 'fix' }]);
    expect(message).toContain(`HO-0002/F1 judged fix, but review HO-0002 reviewed ${stray}, which is not part of dispatch/HO-0001`);
    expect(message).toContain('judge it dismiss or defer with a reason');
  });

  it('refuses a missing judgment, listing the finding with severity and title, and commits nothing', async () => {
    await setupReviewed(twoFindings());
    const message = await refusal(repoDir, 'HO-0001', [{ finding: 'F1', judgment: 'dismiss', reason: 'not a defect' }]);
    expect(message).toContain('no judgment for: HO-0002/F2 [high] Example finding F2');
    expect(message).not.toContain('HO-0002/F1 [high]');
    expect(message).toContain('"judgment": "fix" | "dismiss" | "defer"');
    expect((await readdir(join(repoDir, 'wiki', 'handoffs'))).filter((f) => f.endsWith('.judgments.json'))).toEqual([]);
  });

  it('refuses a review with findings when no judgments are passed at all', async () => {
    await setupReviewed(twoFindings());
    const message = await refusal(repoDir, 'HO-0001');
    expect(message).toContain('HO-0002/F1 [high] Example finding F1');
    expect(message).toContain('HO-0002/F2 [high] Example finding F2');
  });

  it.each([
    ['an unknown finding', [{ finding: 'F9', judgment: 'dismiss' as const, reason: 'x' }], 'unknown finding'],
    ['an unknown review', [{ review: 'HO-0099', finding: 'F1', judgment: 'dismiss' as const, reason: 'x' }], 'unknown review'],
    [
      'a duplicate judgment',
      [
        { finding: 'F1', judgment: 'dismiss' as const, reason: 'x' },
        { finding: 'F1', judgment: 'defer' as const, reason: 'y' },
      ],
      'HO-0002/F1 is judged twice',
    ],
    ['a bad judgment word', [{ finding: 'F1', judgment: 'ignore' as unknown as 'fix' }], '"ignore", not one of fix, dismiss, defer'],
    ['a blank reason for dismiss', [{ finding: 'F1', judgment: 'dismiss' as const, reason: '   ' }], 'dismiss for HO-0002/F1 needs a non-blank reason'],
    ['a missing reason for defer', [{ finding: 'F1', judgment: 'defer' as const }], 'defer for HO-0002/F1 needs a non-blank reason'],
  ])('refuses %s', async (_name, judgments, expected) => {
    await setupReviewed(makeReviewResponse('changes_requested', 'HO-0001', true));
    expect(await refusal(repoDir, 'HO-0001', judgments)).toContain(expected);
  });

  it('requires review when two reviews on the chain have findings, and records both', async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeImplementHO('HO-0002', 'Fix thing', 'WK-0001'),
        'wiki/handoffs/HO-0003.md': makeReviewHO('HO-0003', 'Code review: first', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0003.response.md': makeReviewResponse('changes_requested', 'HO-0001', true),
        'wiki/handoffs/HO-0004.md': makeReviewHO('HO-0004', 'Code review: fix-up', 'dispatch/HO-0002', 'WK-0001'),
        'wiki/handoffs/HO-0004.response.md': makeReviewResponse('changes_requested', 'HO-0002', true),
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    await createDeliveryBranch(repoDir, 'HO-0002', { 'fix.ts': 'export const fix = 1;\n' }, 'dispatch/HO-0001');

    const message = await refusal(repoDir, 'HO-0002', [{ finding: 'F1', judgment: 'dismiss', reason: 'x' }]);
    expect(message).toContain('names no review; 2 reviews have findings (HO-0003, HO-0004)');

    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0002',
      judgments: [
        { review: 'HO-0003', finding: 'F1', judgment: 'fix' },
        { review: 'HO-0004', finding: 'F1', judgment: 'defer', reason: 'later' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.judgments).toEqual({ total: 2, fix: 1, dismiss: 0, defer: 1 });
    const record = JSON.parse(await readFile(join(repoDir, 'wiki/handoffs/HO-0002.judgments.json'), 'utf8')) as JudgmentsRecord;
    expect(record.reviews.map((r) => r.review_id).sort()).toEqual(['HO-0003', 'HO-0004']);
  });

  it('needs no judgments, writes no record, and refuses a stray judgment when no review has findings', async () => {
    await setupReviewed(makeReviewResponse('no_findings', 'HO-0001', false));
    const message = await refusal(repoDir, 'HO-0001', [{ finding: 'F1', judgment: 'dismiss', reason: 'x' }]);
    expect(message).toContain('no review on the chain has findings');

    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.judgments).toEqual({ total: 0, fix: 0, dismiss: 0, defer: 0 });
    expect(result.data.judgmentsRecord).toBeUndefined();
    expect((await readdir(join(repoDir, 'wiki', 'handoffs'))).filter((f) => f.endsWith('.judgments.json'))).toEqual([]);
  });

  it('contributes no findings from a prose-only (advisory) review', async () => {
    await setupReviewed(makeProseOnlyReviewResponse('HO-0001'));
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
  });

  it.skipIf(!BWRAP_FUNCTIONAL)('still refuses red tests with every finding judged, and an override does not stand in for a judgment', async () => {
    await setupReviewed(makeReviewResponse('changes_requested', 'HO-0001', true));
    await registerFailingCommand(repoDir);
    const judgments = [{ finding: 'F1', judgment: 'dismiss' as const, reason: 'not a defect' }];
    const red = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001', judgments });
    expect(red.ok).toBe(false);
    if (red.ok) return;
    expect(red.message).toContain('host validation failed (test)');
    expect((await readdir(join(repoDir, 'wiki', 'handoffs'))).filter((f) => f.endsWith('.judgments.json'))).toEqual([]);

    const override = { reason: 'operator says so', actor: 'operator', surface: 'api' as const };
    const noJudgment = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001', override });
    expect(noJudgment.ok).toBe(false);
    if (noJudgment.ok) return;
    expect(noJudgment.message).toContain('no judgment for: HO-0002/F1');

    const both = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001', judgments, override });
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.data).toMatchObject({ gate: 'override', judgments: { total: 1, dismiss: 1 } });
  });
});

// ---------------------------------------------------------------------------
// The findings stamp: capture writes it, merge-delivery reads it.
// ---------------------------------------------------------------------------

describe('findings stamp in the response doc', () => {
  const baseOpts = {
    handoff: { id: 'HO-0002', title: 'Code review', mode: 'code_review' },
    delivery: { status: 'no_changes' } as unknown as DeliveryOutcome,
    lastAssistantText: 'A review report with real content.',
  };

  function evidenceFor(outcome: string, findingIds: string[]): RecoveryBlockEvidence {
    return validateRecoveryPayload({
      schema_version: 'kb-dispatch-recovery.v1',
      reported_role: 'reviewer',
      reported_subject: 'HO-0001',
      reported_outcome: outcome,
      summary: 'done',
      findings: findingIds.map((id) => ({ id, title: `Title ${id} | with a pipe`, severity: 'medium', blocking: false, affected_paths: [], control_id: null })),
      finding_counts: { total: findingIds.length, blocking: 0, critical: 0, high: 0, medium: findingIds.length, low: 0, info: 0 },
      reviewed_controls: [],
      kind: null,
    });
  }

  async function responseDoc(recoveryEvidence?: RecoveryBlockEvidence): Promise<string> {
    const runDir = await mkdtemp(join(tmpdir(), 'kb-stamp-'));
    try {
      const written = await writeResponseDoc({ ...baseOpts, runDir, ...(recoveryEvidence !== undefined ? { recoveryEvidence } : {}) });
      if (!written.ok) throw new Error(written.message);
      return written.data.responseContent;
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  function frontmatterKeys(doc: string): string[] {
    return doc.split('\n---\n')[0]!.split('\n').slice(1).map((l) => l.split(':')[0]!).filter((k) => k !== 'delivery_method' && k !== 'reason'); // verdict-dependent, unrelated to the stamp
  }

  it('writes recovery_findings as one JSON line for a valid block with findings', async () => {
    const doc = await responseDoc(evidenceFor('changes_requested', ['F1', 'F2']));
    const line = doc.split('\n').find((l) => l.startsWith('recovery_findings: '));
    expect(line).toBe(
      'recovery_findings: [{"id":"F1","title":"Title F1 | with a pipe","severity":"medium","blocking":false},{"id":"F2","title":"Title F2 | with a pipe","severity":"medium","blocking":false}]',
    );
  });

  it('adds nothing but the stamp: a doc with no findings, an invalid block, or no block has the frontmatter it always had', async () => {
    const withFindings = await responseDoc(evidenceFor('changes_requested', ['F1']));
    const noFindings = await responseDoc(evidenceFor('no_findings', []));
    const invalid = await responseDoc(validateRecoveryPayload({ schema_version: 'nope' }));
    const absent = await responseDoc();
    // Removing the stamp line from a doc that has it leaves exactly the shape every other doc has.
    expect(frontmatterKeys(withFindings).filter((k) => k !== 'recovery_findings')).toEqual(frontmatterKeys(noFindings));
    expect(withFindings.split('\n').filter((l) => l.startsWith('recovery_findings:'))).toHaveLength(1);
    for (const doc of [noFindings, invalid, absent]) {
      expect(doc).not.toContain('recovery_findings');
      expect(frontmatterKeys(doc)).toEqual(frontmatterKeys(noFindings));
    }
    // The stamp sits right after worker_report_chars, before the closing delimiter.
    const keys = frontmatterKeys(withFindings);
    expect(keys.slice(-2)).toEqual(['worker_report_chars', 'recovery_findings']);
  });

  it('is read by merge-delivery from a real captured doc, titles with pipes and all', async () => {
    const doc = await responseDoc(evidenceFor('changes_requested', ['F1']));
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0002.response.md': doc,
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    const missing = await refusal(repoDir, 'HO-0001');
    expect(missing).toContain('HO-0002/F1 [medium] Title F1 | with a pipe');
  });

  it('refuses a malformed recovery_findings value instead of reading it as no findings', async () => {
    const doc = (await responseDoc(evidenceFor('changes_requested', ['F1']))).replace(/^recovery_findings: .*$/m, 'recovery_findings: [{"id":');
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0002.response.md': doc,
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    expect(await refusal(repoDir, 'HO-0001')).toContain('malformed recovery_findings field');
  });

  it('refuses a recovery_findings value that lists one id twice', async () => {
    const doc = (await responseDoc(evidenceFor('changes_requested', ['F1', 'F2']))).replace(/^recovery_findings: .*$/m, (line) => {
      const entries = JSON.parse(line.slice('recovery_findings: '.length)) as { id: string }[];
      entries[1]!.id = entries[0]!.id;
      return `recovery_findings: ${JSON.stringify(entries)}`;
    });
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0002.response.md': doc,
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    const message = await refusal(repoDir, 'HO-0001', [{ finding: 'F1', judgment: 'dismiss', reason: 'x' }]);
    expect(message).toContain('malformed recovery_findings field');
    expect(message).toContain('lists finding id F1 twice');
  });
});

// ---------------------------------------------------------------------------
// A review handoff the lookup cannot read must not silently change which review governs.
// ---------------------------------------------------------------------------

describe('mergeDelivery with a review handoff that cannot be read', () => {
  async function setupReviewed(): Promise<void> {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0002.response.md': makeReviewResponse('no_findings', 'HO-0001', false),
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
  }

  it('refuses when an unparsable handoff names a branch of the chain as its base_ref, naming the file and the problem', async () => {
    await setupReviewed();
    // A newer review whose frontmatter lost its mode: it would govern if it parsed.
    await writeAndCommit(
      repoDir,
      { 'wiki/handoffs/HO-0003.md': '---\nschema_version: 1\nid: "HO-0003"\ntitle: "Code review"\nbase_ref: dispatch/HO-0001\n---\n\n# broken\n' },
      'add a review handoff that does not parse',
    );
    const before = await headSha(repoDir);
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.message).toContain('HO-0003.md');
    expect(result.message).toContain('Missing required handoff field');
    expect(await headSha(repoDir)).toBe(before);
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(true);
  });

  it('skips an unparsable handoff that names no branch of the chain', async () => {
    await setupReviewed();
    await writeAndCommit(
      repoDir,
      { 'wiki/handoffs/HO-0003.md': '---\nid: "HO-0003"\nbase_ref: dispatch/HO-0099\n---\n\n# broken\n' },
      'add an unrelated handoff that does not parse',
    );
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(true);
  });

  it('refuses when a handoff file cannot be read for a reason other than not found, naming the file', async () => {
    await setupReviewed();
    await mkdir(join(repoDir, 'wiki', 'handoffs', 'HO-0003.md'));
    const result = await mergeDelivery({ dir: repoDir, handoff_id: 'HO-0001' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.message).toContain('HO-0003.md');
  });
});

// ---------------------------------------------------------------------------
// A failed `git merge` says why, and says what was already committed.
// ---------------------------------------------------------------------------

describe('mergeDelivery when git cannot merge', () => {
  it("includes git's output, aborts the merge, and names the record files already committed", async () => {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0002.response.md': makeReviewResponse('changes_requested', 'HO-0001', true),
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001', { 'dummy.txt': 'from the branch\n' });
    await writeAndCommit(repoDir, { 'dummy.txt': 'from the base\n' }, 'edit the same file on the base');

    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      judgments: [{ finding: 'F1', judgment: 'dismiss', reason: 'not a defect' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure, got ok');
    expect(result.error).toBe('ADMISSION_FAILED');
    expect(result.message).toContain('git merge of dispatch/HO-0001 failed');
    expect(result.message).toContain('CONFLICT');
    expect(result.message).toContain('dummy.txt');
    expect(result.message).toContain('merge was aborted');
    expect(result.message).toContain('already committed before the merge: wiki/handoffs/HO-0001.judgments.json');
    expect((await execFile('git', ['status', '--porcelain'], { cwd: repoDir })).stdout.trim()).toBe('');
    expect(await branchExists(repoDir, 'dispatch/HO-0001')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Response docs written before the stamp: the rendered findings table is read.
// ---------------------------------------------------------------------------

describe('response docs that predate the findings stamp', () => {
  // A real captured review response, unedited: changes_requested with findings F1, F2, F3 in its body.
  const legacyDoc = (): Promise<string> => readFile(join(__dirname, 'fixtures', 'review-response-before-findings-stamp.md'), 'utf8');

  async function setupWith(doc: string): Promise<void> {
    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0002.response.md': doc,
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
  }

  it('reads the findings from the rendered table and merges once each is judged', async () => {
    const doc = await legacyDoc();
    expect(doc).not.toContain('recovery_findings');
    await setupWith(doc);
    const missing = await refusal(repoDir, 'HO-0001');
    expect(missing).toContain("HO-0002/F1 [medium] contract/kb-dispatch-recovery.v1.schema.json enum missing 'researcher', breaking npm test");
    expect(missing).toContain('HO-0002/F2 [low] assemble.ts module doc still describes the now-removed research mode-gate');
    expect(missing).toContain('HO-0002/F3 [info]');

    const result = await mergeDelivery({
      dir: repoDir,
      handoff_id: 'HO-0001',
      judgments: ['F1', 'F2', 'F3'].map((finding) => ({ finding, judgment: 'defer' as const, reason: 'predates the new flow' })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.judgments.total).toBe(3);
  });

  it('refuses, and says to dispatch a new review, when the table cannot be read', async () => {
    await setupWith((await legacyDoc()).replace('| F2 | low | no |', '| F2 low no |'));
    const message = await refusal(repoDir, 'HO-0001');
    expect(message).toContain('predates the findings stamp');
    expect(message).toContain('dispatch a new review');
  });

  it('refuses a changes_requested doc whose body has no findings table', async () => {
    await setupWith(makeReviewResponse('changes_requested', 'HO-0001', false));
    expect(await refusal(repoDir, 'HO-0001')).toContain('predates the findings stamp');
  });
});

describe('merge-delivery MCP tool', () => {
  it('accepts judgments, rejects a judgment word outside fix, dismiss and defer, and returns the judgment counts', async () => {
    const { tools } = await import('../packages/dispatch-mcp/src/tools.js');
    const tool = tools.find((t) => t.name === 'merge-delivery')!;
    const entry = { finding: 'F1', judgment: 'dismiss', reason: 'not a defect' };
    expect(tool.inputSchema.safeParse({ dir: '.', handoff_id: 'HO-0001', judgments: [entry] }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ dir: '.', handoff_id: 'HO-0001', judgments: [{ ...entry, judgment: 'ignore' }] }).success).toBe(false);

    await writeAndCommit(
      repoDir,
      {
        'wiki/handoffs/HO-0001.md': makeImplementHO('HO-0001', 'Implement thing', 'WK-0001'),
        'wiki/handoffs/HO-0002.md': makeReviewHO('HO-0002', 'Code review', 'dispatch/HO-0001', 'WK-0001'),
        'wiki/handoffs/HO-0002.response.md': makeReviewResponse('changes_requested', 'HO-0001', true),
      },
      'add HOs',
    );
    await createDeliveryBranch(repoDir, 'HO-0001');
    const result = (await tool.handler({ dir: repoDir, handoff_id: 'HO-0001', judgments: [entry] })) as Awaited<ReturnType<typeof mergeDelivery>>;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.judgments).toEqual({ total: 1, fix: 0, dismiss: 1, defer: 0 });
    expect(result.data.judgmentsRecord).toBe('wiki/handoffs/HO-0001.judgments.json');
  });
});

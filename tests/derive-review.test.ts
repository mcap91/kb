/**
 * WK-0132 Slice 2 — derive-review: derives a code_review HO from a delivered
 * implement HO (mode=code_review, base_ref=dispatch/<implement_id>, acceptance/
 * write_scope/validation copied verbatim, read_first = implement's + response
 * doc path). Fixtures use the real bootstrap()/createHandoff() code paths
 * rather than hand-rolled frontmatter, so the HO files under test are
 * byte-identical to what dispatch actually produces (mirrors
 * tests/create-handoff-validation.test.ts's setup pattern).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap } from '@kb/wiki-core';

import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import type { CreateHandoffOpts } from '../packages/dispatch-core/src/types.js';
import { deriveReview } from '../packages/dispatch-core/src/derive-review.js';
import { parseHandoff } from '../packages/dispatch-core/src/ho.js';

async function setupBootstrappedRepo(repoRoot: string): Promise<void> {
  const result = await bootstrap({ dir: repoRoot, repo: 'test/repo' });
  if (!result.ok) {
    throw new Error(result.message);
  }

  // WK-0152: createHandoff stamps base_sha from HEAD, so the repo must be a git repo with a commit.
  for (const args of [['init'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test User'], ['add', '-A'], ['commit', '-m', 'init']]) {
    execFileSync('git', args, { cwd: repoRoot });
  }
}

function baseImplementOpts(overrides: Partial<CreateHandoffOpts> = {}): CreateHandoffOpts {
  return {
    dir: '',
    title: 'Add a slugify utility',
    subject: 'kb:dispatch',
    allowed_agents: ['claude'],
    mode: 'implement',
    work_item: 'WK-0132',
    write_scope: ['src/slugify.ts', 'test/slugify.test.ts'],
    read_first: ['README.md'],
    acceptance: ['AC-1: slugify("Hello World") returns "hello-world"'],
    validation: ['npm test -- slugify'],
    web: false,
    credentials: [],
    data_mounts: [],
    export_mounts: [],
    vars: [],
    ...overrides,
  };
}

async function deliverImplementHo(tempDir: string) {
  const created = await createHandoff(baseImplementOpts({ dir: tempDir }));
  if (!created.ok) throw new Error(created.message);
  return created.data;
}

async function writeResponseDoc(tempDir: string, handoffId: string): Promise<void> {
  const relativePath = `wiki/handoffs/${handoffId}.response.md`;
  await writeFile(
    join(tempDir, relativePath),
    `---\nhandoff_id: ${handoffId}\noutcome: delivered\n---\n\n# Response\n`,
    'utf-8',
  );
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

// Mirrors dispatch-surface.test.ts's writeV2State fixture (same v2 state.json shape).
async function writeRunState(runDir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeJson(join(runDir, 'state.json'), {
    schema_version: 2,
    run_id: 'RUN-placeholder',
    handoff_id: 'HO-placeholder',
    model: 'deepseek',
    status: 'running',
    pid: process.pid,
    pgid: process.pid,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    heartbeat_at: new Date().toISOString(),
    completed_at: null,
    outcome: null,
    delivery_status: null,
    branch: null,
    error: null,
    ...overrides,
  });
}

describe('deriveReview — WK-0132 Slice 2', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'derive-review-'));
    await setupBootstrappedRepo(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('field derivation correctness', () => {
    it('derives a code_review HO with fields copied/derived from the delivered implement', async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.implementId).toBe(implement.handoffId);

      const parsed = await parseHandoff(result.data.reviewPath);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const review = parsed.data;

      expect(review.mode).toBe('code_review');
      expect(review.base_ref).toBe(`dispatch/${implement.handoffId}`);
      expect(review.write_scope).toEqual([]);
      expect(review.acceptance).toEqual(['AC-1: slugify("Hello World") returns "hello-world"']);
      expect(review.validation).toEqual(['npm test -- slugify']);
      expect(review.work_item).toBe('WK-0132');
      expect(review.read_first).toEqual(['README.md', `wiki/handoffs/${implement.handoffId}.response.md`]);
      expect(review.title).toBe('Code review: Add a slugify utility');
    });
  });

  describe('refusal on non-delivered implement HO', () => {
    it('refuses when the response doc does not exist', async () => {
      const implement = await deliverImplementHo(tempDir);
      // No response doc written — implement HO exists but is undelivered.

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('not delivered');
    });
  });

  describe('refusal on non-implement mode', () => {
    it('refuses a code_review HO passed as the source', async () => {
      const created = await createHandoff(baseImplementOpts({
        dir: tempDir,
        mode: 'code_review',
        work_item: undefined,
      }));
      if (!created.ok) throw new Error(created.message);

      const result = await deriveReview({ dir: tempDir, handoff_id: created.data.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('mode=implement');
    });
  });

  describe('refusal on missing implement HO', () => {
    it('refuses when the implement HO file does not exist', async () => {
      const result = await deriveReview({ dir: tempDir, handoff_id: 'HO-9999' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('not found');
    });
  });

  describe('allocator integration', () => {
    it('allocates a new HO-XXXX id and writes the file at the returned path', async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.reviewId).toMatch(/^HO-\d{4}$/);
      expect(result.data.reviewId).not.toBe(implement.handoffId);
      expect(result.data.reviewRelativePath).toBe(`wiki/handoffs/${result.data.reviewId}.md`);

      const content = await readFile(result.data.reviewPath, 'utf-8');
      expect(content).toContain(`id: "${result.data.reviewId}"`);
    });
  });

  describe('reviewed_run stamp (WK-0153)', () => {
    it("stamps reviewed_run with the HO's latest terminal run id", async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);

      const runsDir = join(tempDir, '.agent-runs', 'runs', implement.handoffId);
      await writeRunState(join(runsDir, 'RUN-older'), {
        run_id: 'RUN-older',
        handoff_id: implement.handoffId,
        status: 'failed',
        completed_at: '2026-09-20T10:00:00.000Z',
      });
      await writeRunState(join(runsDir, 'RUN-newer'), {
        run_id: 'RUN-newer',
        handoff_id: implement.handoffId,
        status: 'delivered',
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.reviewedRunId).toBe('RUN-newer');

      const parsed = await parseHandoff(result.data.reviewPath);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.data.reviewed_run).toBe('RUN-newer');
    });

    it('leaves reviewed_run undefined and absent from frontmatter when no run dirs exist', async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);
      // No .agent-runs/runs/<id> directory created for this HO.

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.reviewedRunId).toBeUndefined();

      const content = await readFile(result.data.reviewPath, 'utf-8');
      expect(content).not.toContain('reviewed_run');

      const parsed = await parseHandoff(result.data.reviewPath);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.data.reviewed_run).toBeUndefined();
    });
  });
});

/**
 * WK-0132 Slice 2 — derive-review: derives a code_review HO from a delivered
 * implement HO (mode=code_review, base_ref=dispatch/<implement_id>, acceptance
 * copied verbatim, write_scope always []). WK-0294: derivation needs a
 * delivered run with a delivery branch and records host validation evidence
 * (no registry here, so the host runs nothing). WK-0270 Slice 1: `validation`
 * is a fixed host-evidence sentence (never the implement's validation text);
 * `read_first` is the implement's list plus `AGENTS.md`, filtered through
 * admission's shared existence predicate against the delivery branch tree;
 * `initiative`/`area`/`work_item` are copied; `runtime_envs`/`web`/
 * `export_mounts` are set by the review mode, never copied, with the
 * implement's `export_mounts` appended to `data_mounts` read-only. WK-0270
 * Slice 2: the chain is `HEAD..dispatch/<id>` in the mother checkout (real
 * chains, one commit per member, subject `dispatch: HO-XXXX` —
 * `deliverChainCommit`/`markDelivered` below); Objective/Expected Output are
 * fixed sentences from identifiers; `acceptance` and `read_first` are unioned
 * across every member. Fixtures use the real bootstrap()/createHandoff() code
 * paths rather than hand-rolled frontmatter, so the HO files under test are
 * byte-identical to what dispatch actually produces (mirrors
 * tests/create-handoff-validation.test.ts's setup pattern).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap } from '@kb/wiki-core';

import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import type { CreateHandoffOpts } from '../packages/dispatch-core/src/types.js';
import { deriveReview } from '../packages/dispatch-core/src/derive-review.js';
import { parseHandoff } from '../packages/dispatch-core/src/ho.js';

async function setupBootstrappedRepo(repoRoot: string): Promise<void> {
  // WK-0261: wiki/handoffs/ (and the handoff.md template) now ship only once
  // the dispatch layer is active — a real dispatch repo always has this by the
  // time createHandoff runs (init-dispatch + sync-contract precede it).
  await mkdir(join(repoRoot, 'wiki', '.dispatch'), { recursive: true });
  const result = await bootstrap({ dir: repoRoot, repo: 'test/repo' });
  if (!result.ok) {
    throw new Error(result.message);
  }

  // WK-0270: deriveReview now filters read_first through admission's existence predicate
  // against the delivery branch tree, so a real committed README.md backs the 'README.md'
  // read_first fixtures below (an uncommitted/nonexistent entry would be dropped).
  await writeFile(join(repoRoot, 'README.md'), '# fixture\n', 'utf-8');

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
    runtime_envs: [],
    vars: [],
    ...overrides,
  };
}

async function deliverImplementHo(tempDir: string) {
  const created = await createHandoff(baseImplementOpts({ dir: tempDir }));
  if (!created.ok) throw new Error(created.message);
  return created.data;
}

/** What a delivered run leaves behind (WK-0294 / DEC-0047 A2 R6): a delivered state.json and its branch. */
/** Dispatch-minted run ids (RUN-<uuid>): derive-review only considers run dirs with that shape. */
const DELIVERED_RUN = 'RUN-00000000-0000-4000-8000-000000000001';
const NEWER_FAILED_RUN = 'RUN-00000000-0000-4000-8000-000000000002';

/**
 * WK-0270 Specification 1: a chain member is one commit, subject `dispatch: HO-XXXX`, on
 * `dispatch/<handoffId>` branched off `fromRef` — the real delivery.ts shape (`tests/host-validation.test.ts`'s
 * pattern), not a bare `git branch -f` at HEAD (which forms an empty, invalid HEAD..branch range). Leaves the
 * caller back on whatever ref was checked out before. Returns the new commit's sha.
 */
async function deliverChainCommit(tempDir: string, handoffId: string, fromRef: string): Promise<string> {
  const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tempDir }).toString().trim();
  const branch = `dispatch/${handoffId}`;
  const marker = `${handoffId}.delivered`;
  execFileSync('git', ['checkout', '-q', '-b', branch, fromRef], { cwd: tempDir });
  await writeFile(join(tempDir, marker), 'delivered\n', 'utf-8');
  // Add only the marker file, never `-A`: the implement HO's own `.md` (and its response doc) are
  // often still uncommitted on `current` at this point, and sweeping them into this branch's commit
  // would make git delete them from the working tree on the `checkout current` below (tracked here,
  // absent from current's tree).
  execFileSync('git', ['add', marker], { cwd: tempDir });
  execFileSync('git', ['commit', '-q', '-m', `dispatch: ${handoffId}`], { cwd: tempDir });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir }).toString().trim();
  execFileSync('git', ['checkout', '-q', current], { cwd: tempDir });
  return sha;
}

/** Single-member chain: `dispatch/<handoffId>` is one commit ahead of HEAD (WK-0270 Specification 1). */
async function markDelivered(tempDir: string, handoffId: string, runId = DELIVERED_RUN): Promise<void> {
  await writeRunState(join(tempDir, '.agent-runs', 'runs', handoffId, runId), {
    run_id: runId,
    handoff_id: handoffId,
    status: 'delivered',
    outcome: 'delivered',
    branch: `dispatch/${handoffId}`,
    completed_at: '2026-09-25T10:00:00.000Z',
  });
  await deliverChainCommit(tempDir, handoffId, 'HEAD');
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
      await markDelivered(tempDir, implement.handoffId);

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
      // WK-0270 Specification 5 (single-HO case): acceptance is still the union over the chain's one
      // member, prefixed [HO-XXXX] (was the bare implement acceptance array, unprefixed).
      expect(review.acceptance).toEqual([`[${implement.handoffId}] AC-1: slugify("Hello World") returns "hello-world"`]);
      // WK-0270 Specification 3/Resolution 6: validation is one fixed host-evidence sentence,
      // never the implement's validation text (was `['npm test -- slugify']`, copied verbatim).
      expect(review.validation).toHaveLength(1);
      expect(review.validation[0]).toContain('Host Validation Evidence');
      expect(review.validation.join(' ')).not.toContain('npm test -- slugify');
      expect(review.work_item).toBe('WK-0132');
      // WK-0270 Specification 4: read_first is the implement's list plus AGENTS.md, filtered
      // through admission's shared existence predicate (was the implement's list copied as-is);
      // bootstrap() writes AGENTS.md into the fixture repo root, so it survives the filter here.
      expect(review.read_first).toEqual(['README.md', 'AGENTS.md']);
      expect(review.title).toBe('Code review: Add a slugify utility');

      // WK-0270 Specification 2 (new): Objective and Expected Output are fixed sentences from
      // identifiers — both name the head HO id, reviewed_sha, and the single member's range.
      const content = await readFile(result.data.reviewPath, 'utf-8');
      expect(content).toContain(implement.handoffId);
      expect(content).toContain(review.reviewed_sha!);
      expect(content).toContain('Range under review:');
    });

    it('copies initiative, area and work_item from the implement HO', async () => {
      const created = await createHandoff(baseImplementOpts({ dir: tempDir, area: 'dispatch', initiative: 'IN-0007' }));
      if (!created.ok) throw new Error(created.message);
      await writeResponseDoc(tempDir, created.data.handoffId);
      await markDelivered(tempDir, created.data.handoffId);

      const result = await deriveReview({ dir: tempDir, handoff_id: created.data.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const parsed = await parseHandoff(result.data.reviewPath);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.data.area).toBe('dispatch');
      expect(parsed.data.initiative).toBe('IN-0007');
      expect(parsed.data.work_item).toBe('WK-0132');
    });

    it('sets the envelope by review mode: empties runtime_envs/web/export_mounts, moves the export path to data_mounts, copies credentials/data_mounts/vars, and admits with no ENVELOPE_EXCEEDS_MODE', async () => {
      const originalHome = process.env.HOME;
      const fakeHome = await mkdtemp(join(tmpdir(), 'derive-review-home-'));
      process.env.HOME = fakeHome;
      try {
        const runtimeEnvRoot = join(fakeHome, 'runtime-env');
        await mkdir(join(runtimeEnvRoot, 'bin'), { recursive: true });
        const exportDir = await mkdtemp(join(tmpdir(), 'derive-review-export-'));
        const dataMountDir = await mkdtemp(join(tmpdir(), 'derive-review-data-'));

        const created = await createHandoff(
          baseImplementOpts({
            dir: tempDir,
            web: true,
            runtime_envs: [runtimeEnvRoot],
            export_mounts: [exportDir],
            data_mounts: [dataMountDir],
            credentials: ['anthropic'],
            vars: ['FOO=bar'],
          }),
        );
        if (!created.ok) throw new Error(created.message);
        await writeResponseDoc(tempDir, created.data.handoffId);
        await markDelivered(tempDir, created.data.handoffId);

        const result = await deriveReview({ dir: tempDir, handoff_id: created.data.handoffId });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const parsed = await parseHandoff(result.data.reviewPath);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const review = parsed.data;

        expect(review.write_scope).toEqual([]);
        expect(review.runtime_envs).toEqual([]);
        expect(review.web).toBe(false);
        expect(review.export_mounts).toEqual([]);
        expect(review.data_mounts).toEqual([dataMountDir, exportDir]);
        expect(review.credentials).toEqual(['anthropic']);
        expect(review.vars).toEqual(['FOO=bar']);

        const admitted = await checkAdmission(review, tempDir);
        expect(admitted.ok).toBe(true);
        if (admitted.ok) return;
        expect(admitted.error).not.toBe('ENVELOPE_EXCEEDS_MODE');
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

  describe('read_first union with AGENTS.md and the shared existence predicate (WK-0270 Specification 4)', () => {
    it('keeps AGENTS.md when the delivery branch has it, drops a deleted implement read_first entry, and reports the drop', async () => {
      await writeFile(join(tempDir, 'AGENTS.md'), '# rules\n', 'utf-8');
      await writeFile(join(tempDir, 'deleted-on-branch.md'), 'gone soon\n', 'utf-8');
      execFileSync('git', ['add', '-A'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'add AGENTS.md and a file the implement deletes'], { cwd: tempDir });

      const created = await createHandoff(
        baseImplementOpts({ dir: tempDir, read_first: ['README.md', 'deleted-on-branch.md'] }),
      );
      if (!created.ok) throw new Error(created.message);
      await writeResponseDoc(tempDir, created.data.handoffId);

      // The implement's delivered branch no longer has the file it declared in read_first.
      // WK-0270 Specification 1: the chain commit's subject must be "dispatch: HO-XXXX" (was
      // "delete the file" — a non-dispatch subject the new chain walk would refuse).
      const branch = `dispatch/${created.data.handoffId}`;
      execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: tempDir });
      execFileSync('git', ['rm', '-q', 'deleted-on-branch.md'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', `dispatch: ${created.data.handoffId}`], { cwd: tempDir });
      execFileSync('git', ['checkout', '-q', '-'], { cwd: tempDir });

      await writeRunState(join(tempDir, '.agent-runs', 'runs', created.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: created.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: created.data.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.droppedReadFirst).toEqual(['deleted-on-branch.md']);

      const parsed = await parseHandoff(result.data.reviewPath);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.data.read_first).toEqual(['README.md', 'AGENTS.md']);

      const admitted = await checkAdmission(parsed.data, tempDir);
      expect(admitted.ok).toBe(true);
    });

    // Why: HO-0258 F2 — every existing chain fixture gives each member the same read_first
    // list, so no test can distinguish "head first, then older members" from any other union
    // order. This gives A and B distinct, non-overlapping entries (plus a shared README.md and
    // AGENTS.md) and asserts the exact derived order (WK-0270 Specification 4).
    it('two-HO chain (B on A) with distinct read_first lists: derives head (B) first, then A\'s entries not already present, then AGENTS.md, deduplicated', async () => {
      await writeFile(join(tempDir, 'AGENTS.md'), '# rules\n', 'utf-8');
      await mkdir(join(tempDir, 'docs'), { recursive: true });
      await writeFile(join(tempDir, 'docs', 'a-only.md'), 'a only\n', 'utf-8');
      await writeFile(join(tempDir, 'docs', 'b-only.md'), 'b only\n', 'utf-8');

      const a = await createHandoff(
        baseImplementOpts({
          dir: tempDir,
          work_item: 'WK-0001',
          acceptance: ['AC-A1: a does x'],
          read_first: ['README.md', 'docs/a-only.md'],
        }),
      );
      if (!a.ok) throw new Error(a.message);
      execFileSync('git', ['add', '-A'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', 'author A'], { cwd: tempDir });
      await deliverChainCommit(tempDir, a.data.handoffId, 'HEAD');

      const b = await createHandoff(
        baseImplementOpts({
          dir: tempDir,
          work_item: 'WK-0002',
          acceptance: ['AC-B1: b does y'],
          base_ref: `dispatch/${a.data.handoffId}`,
          read_first: ['README.md', 'docs/b-only.md'],
        }),
      );
      if (!b.ok) throw new Error(b.message);
      await writeResponseDoc(tempDir, b.data.handoffId);
      execFileSync('git', ['add', '-A'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', 'author B'], { cwd: tempDir });
      await deliverChainCommit(tempDir, b.data.handoffId, `dispatch/${a.data.handoffId}`);

      await writeRunState(join(tempDir, '.agent-runs', 'runs', b.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: b.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch: `dispatch/${b.data.handoffId}`,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: b.data.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.droppedReadFirst).toEqual([]);

      const parsed = await parseHandoff(result.data.reviewPath);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      // Specification 4: head (B) first, then A's entries not already present, then AGENTS.md.
      expect(parsed.data.read_first).toEqual(['README.md', 'docs/b-only.md', 'docs/a-only.md', 'AGENTS.md']);
    });
  });

  describe('chain walk, Objective/Expected Output, and acceptance union (WK-0270 Specification 1, 2, 5)', () => {
    it('single-member chain: range is <parent>..<head>, and the one criterion carries just one [HO-XXXX] prefix', async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);
      await markDelivered(tempDir, implement.handoffId);

      const deliverySha = execFileSync('git', ['rev-parse', `dispatch/${implement.handoffId}`], { cwd: tempDir }).toString().trim();
      const parentSha = execFileSync('git', ['rev-parse', `dispatch/${implement.handoffId}^`], { cwd: tempDir }).toString().trim();

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const parsed = await parseHandoff(result.data.reviewPath);
      if (!parsed.ok) throw new Error(parsed.message);
      expect(parsed.data.acceptance).toEqual([`[${implement.handoffId}] AC-1: slugify("Hello World") returns "hello-world"`]);

      const content = await readFile(result.data.reviewPath, 'utf-8');
      expect(content).toContain(`Range under review: ${parentSha}..${deliverySha}`);
    });

    it('two-HO chain (B on A): acceptance holds both, oldest first, each prefixed; Objective and Expected Output name the head HO, reviewed_sha, and every member\'s range', async () => {
      const a = await createHandoff(baseImplementOpts({ dir: tempDir, work_item: 'WK-0001', acceptance: ['AC-A1: a does x'] }));
      if (!a.ok) throw new Error(a.message);
      execFileSync('git', ['add', '-A'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', 'author A'], { cwd: tempDir });
      const authorASha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir }).toString().trim();
      const aSha = await deliverChainCommit(tempDir, a.data.handoffId, 'HEAD');

      const b = await createHandoff(
        baseImplementOpts({
          dir: tempDir,
          work_item: 'WK-0002',
          acceptance: ['AC-B1: b does y'],
          base_ref: `dispatch/${a.data.handoffId}`,
        }),
      );
      if (!b.ok) throw new Error(b.message);
      await writeResponseDoc(tempDir, b.data.handoffId);
      execFileSync('git', ['add', '-A'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', 'author B'], { cwd: tempDir });
      const bSha = await deliverChainCommit(tempDir, b.data.handoffId, `dispatch/${a.data.handoffId}`);

      await writeRunState(join(tempDir, '.agent-runs', 'runs', b.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: b.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch: `dispatch/${b.data.handoffId}`,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: b.data.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const parsed = await parseHandoff(result.data.reviewPath);
      if (!parsed.ok) throw new Error(parsed.message);
      const review = parsed.data;

      expect(review.reviewed_sha).toBe(bSha);
      // Specification 5: union across members, oldest (A) first, each prefixed [HO-XXXX].
      expect(review.acceptance).toEqual([
        `[${a.data.handoffId}] AC-A1: a does x`,
        `[${b.data.handoffId}] AC-B1: b does y`,
      ]);

      const content = await readFile(result.data.reviewPath, 'utf-8');
      // Specification 2: Objective and Expected Output both name the head HO, reviewed_sha, and every member's range.
      expect(content).toContain(b.data.handoffId);
      expect(content).toContain(review.reviewed_sha!);
      expect(content).toContain(`${authorASha}..${aSha}`); // A's single-commit range
      expect(content).toContain(`${aSha}..${bSha}`); // B's single-commit range
      expect(content).toContain(`Range under review: ${authorASha}..${bSha}`);
    });

    it('excludes a member already merged into HEAD from the chain', async () => {
      const a = await createHandoff(baseImplementOpts({ dir: tempDir, work_item: 'WK-0001', acceptance: ['AC-A1: a does x'] }));
      if (!a.ok) throw new Error(a.message);
      execFileSync('git', ['add', '-A'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', 'author A'], { cwd: tempDir });
      const aSha = await deliverChainCommit(tempDir, a.data.handoffId, 'HEAD');

      // merge-delivery already landed A: fast-forward HEAD past A's delivery commit.
      execFileSync('git', ['merge', '--ff-only', `dispatch/${a.data.handoffId}`], { cwd: tempDir });
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir }).toString().trim()).toBe(aSha);

      const b = await createHandoff(
        baseImplementOpts({
          dir: tempDir,
          work_item: 'WK-0002',
          acceptance: ['AC-B1: b does y'],
          base_ref: `dispatch/${a.data.handoffId}`,
        }),
      );
      if (!b.ok) throw new Error(b.message);
      await writeResponseDoc(tempDir, b.data.handoffId);
      execFileSync('git', ['add', '-A'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', 'author B'], { cwd: tempDir });
      const bSha = await deliverChainCommit(tempDir, b.data.handoffId, `dispatch/${a.data.handoffId}`);

      await writeRunState(join(tempDir, '.agent-runs', 'runs', b.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: b.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch: `dispatch/${b.data.handoffId}`,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: b.data.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const parsed = await parseHandoff(result.data.reviewPath);
      if (!parsed.ok) throw new Error(parsed.message);
      // A is already reachable from HEAD, so only B's criterion survives — A's is excluded by the range.
      expect(parsed.data.acceptance).toEqual([`[${b.data.handoffId}] AC-B1: b does y`]);

      const content = await readFile(result.data.reviewPath, 'utf-8');
      expect(content).not.toContain('AC-A1');
      expect(content).toContain(`Range under review: ${aSha}..${bSha}`);
    });

    it('refuses a merge commit in the chain range', async () => {
      const created = await createHandoff(baseImplementOpts({ dir: tempDir }));
      if (!created.ok) throw new Error(created.message);
      await writeResponseDoc(tempDir, created.data.handoffId);

      const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tempDir }).toString().trim();
      const branch = `dispatch/${created.data.handoffId}`;
      execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: tempDir });
      execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: tempDir });
      await writeFile(join(tempDir, 'side.txt'), 'side\n', 'utf-8');
      // Add only the new file, never `-A`: the implement HO's own `.md`/response doc are still
      // uncommitted here, and sweeping them in would make git delete them on the final checkout back.
      execFileSync('git', ['add', 'side.txt'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', 'side change'], { cwd: tempDir });
      execFileSync('git', ['checkout', '-q', branch], { cwd: tempDir });
      execFileSync('git', ['merge', '--no-ff', '-q', '-m', 'merge side', 'side'], { cwd: tempDir });
      await writeFile(join(tempDir, `${created.data.handoffId}.delivered`), 'delivered\n', 'utf-8');
      execFileSync('git', ['add', `${created.data.handoffId}.delivered`], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', `dispatch: ${created.data.handoffId}`], { cwd: tempDir });
      execFileSync('git', ['checkout', '-q', current], { cwd: tempDir });

      await writeRunState(join(tempDir, '.agent-runs', 'runs', created.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: created.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: created.data.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('parents');
    });

    it('refuses a commit in the chain range whose subject is not "dispatch: HO-XXXX"', async () => {
      const created = await createHandoff(baseImplementOpts({ dir: tempDir }));
      if (!created.ok) throw new Error(created.message);
      await writeResponseDoc(tempDir, created.data.handoffId);

      const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tempDir }).toString().trim();
      const branch = `dispatch/${created.data.handoffId}`;
      execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: tempDir });
      await writeFile(join(tempDir, 'oops.txt'), 'oops\n', 'utf-8');
      execFileSync('git', ['add', 'oops.txt'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', 'fix a typo'], { cwd: tempDir });
      execFileSync('git', ['checkout', '-q', current], { cwd: tempDir });

      await writeRunState(join(tempDir, '.agent-runs', 'runs', created.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: created.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: created.data.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('fix a typo');
    });

    it('refuses an empty chain range (the delivery branch is already merged)', async () => {
      const created = await createHandoff(baseImplementOpts({ dir: tempDir }));
      if (!created.ok) throw new Error(created.message);
      await writeResponseDoc(tempDir, created.data.handoffId);

      const branch = `dispatch/${created.data.handoffId}`;
      execFileSync('git', ['branch', branch], { cwd: tempDir }); // no new commit — the branch equals HEAD

      await writeRunState(join(tempDir, '.agent-runs', 'runs', created.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: created.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: created.data.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('empty');
    });

    it("refuses when the newest commit in the range is not the handoff's own delivery", async () => {
      const target = await createHandoff(baseImplementOpts({ dir: tempDir, work_item: 'WK-0003' }));
      if (!target.ok) throw new Error(target.message);
      await writeResponseDoc(tempDir, target.data.handoffId);
      const decoy = await createHandoff(baseImplementOpts({ dir: tempDir, work_item: 'WK-0004' }));
      if (!decoy.ok) throw new Error(decoy.message);

      const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tempDir }).toString().trim();
      const branch = `dispatch/${target.data.handoffId}`;
      execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: tempDir });
      await writeFile(join(tempDir, `${target.data.handoffId}.delivered`), 'delivered\n', 'utf-8');
      execFileSync('git', ['add', `${target.data.handoffId}.delivered`], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', `dispatch: ${target.data.handoffId}`], { cwd: tempDir });
      // A decoy commit lands on top, naming a different (but validly-parsed, mode=implement) HO.
      await writeFile(join(tempDir, `${decoy.data.handoffId}.delivered`), 'delivered\n', 'utf-8');
      execFileSync('git', ['add', `${decoy.data.handoffId}.delivered`], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', `dispatch: ${decoy.data.handoffId}`], { cwd: tempDir });
      execFileSync('git', ['checkout', '-q', current], { cwd: tempDir });

      await writeRunState(join(tempDir, '.agent-runs', 'runs', target.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: target.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: target.data.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain(decoy.data.handoffId);
    });

    it('refuses an older chain member whose commit names an HO that does not exist on disk', async () => {
      // A phantom delivery commit for an HO that was never authored, underneath a real target.
      const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tempDir }).toString().trim();
      execFileSync('git', ['checkout', '-q', '-b', 'dispatch/HO-9999'], { cwd: tempDir });
      await writeFile(join(tempDir, 'HO-9999.delivered'), 'delivered\n', 'utf-8');
      execFileSync('git', ['add', 'HO-9999.delivered'], { cwd: tempDir });
      execFileSync('git', ['commit', '-q', '-m', 'dispatch: HO-9999'], { cwd: tempDir });
      execFileSync('git', ['checkout', '-q', current], { cwd: tempDir });

      const target = await createHandoff(baseImplementOpts({ dir: tempDir }));
      if (!target.ok) throw new Error(target.message);
      await writeResponseDoc(tempDir, target.data.handoffId);
      await deliverChainCommit(tempDir, target.data.handoffId, 'dispatch/HO-9999');

      await writeRunState(join(tempDir, '.agent-runs', 'runs', target.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: target.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch: `dispatch/${target.data.handoffId}`,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: target.data.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('HO-9999');
      expect(result.message).toContain('could not be parsed');
    });

    it('refuses an older chain member whose commit names a non-implement HO', async () => {
      // A valid, but non-implement (code_review), HO underneath a real implement target.
      const olderReview = await createHandoff(
        baseImplementOpts({ dir: tempDir, mode: 'code_review', write_scope: [], work_item: undefined }),
      );
      if (!olderReview.ok) throw new Error(olderReview.message);
      await deliverChainCommit(tempDir, olderReview.data.handoffId, 'HEAD');

      const target = await createHandoff(baseImplementOpts({ dir: tempDir }));
      if (!target.ok) throw new Error(target.message);
      await writeResponseDoc(tempDir, target.data.handoffId);
      await deliverChainCommit(tempDir, target.data.handoffId, `dispatch/${olderReview.data.handoffId}`);

      await writeRunState(join(tempDir, '.agent-runs', 'runs', target.data.handoffId, DELIVERED_RUN), {
        run_id: DELIVERED_RUN,
        handoff_id: target.data.handoffId,
        status: 'delivered',
        outcome: 'delivered',
        branch: `dispatch/${target.data.handoffId}`,
        completed_at: '2026-09-25T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: target.data.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain(olderReview.data.handoffId);
      expect(result.message).toContain('mode=code_review');
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
      await markDelivered(tempDir, implement.handoffId);

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

  describe('reviewed_run stamp (WK-0153; delivered runs only, DEC-0047 A2 R6)', () => {
    it("stamps reviewed_run with the HO's latest delivered run id, skipping newer non-delivered runs", async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);

      const runsDir = join(tempDir, '.agent-runs', 'runs', implement.handoffId);
      await markDelivered(tempDir, implement.handoffId, DELIVERED_RUN);
      await writeRunState(join(runsDir, NEWER_FAILED_RUN), {
        run_id: NEWER_FAILED_RUN,
        handoff_id: implement.handoffId,
        status: 'failed',
        outcome: 'failed',
        completed_at: '2026-09-30T10:00:00.000Z',
      });

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.reviewedRunId).toBe(DELIVERED_RUN);

      const parsed = await parseHandoff(result.data.reviewPath);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.data.reviewed_run).toBe(DELIVERED_RUN);
    });

    // Replaces the WK-0153 "reviewed_run undefined when no run dirs exist" case: evidence is keyed to a
    // delivered run (DEC-0047 A2 R6), so derivation without one refuses instead of writing an unkeyed review.
    it('refuses when no delivered run exists', async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('no delivered run');
    });

    // Why: HO-0220 F1 — only a dispatch-minted run dir may become a reviewed_run stamp.
    it('never stamps a delivered run dir whose name is not a dispatch run id', async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);
      await markDelivered(tempDir, implement.handoffId, 'RUN-handmade');

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('no delivered run');
    });
  });

  describe('host validation evidence (WK-0294)', () => {
    it('records evidence keyed to the delivery sha and run id, and renders it into the review HO', async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);
      await markDelivered(tempDir, implement.handoffId);
      const sha = execFileSync('git', ['rev-parse', `dispatch/${implement.handoffId}`], { cwd: tempDir }).toString().trim();

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.validation).toMatchObject({ run_id: DELIVERED_RUN, delivery_sha: sha, outcome: 'pass', commands: [] });

      const evidence = JSON.parse(
        await readFile(join(tempDir, '.agent-runs', 'runs', implement.handoffId, DELIVERED_RUN, 'validation-evidence.json'), 'utf8'),
      );
      expect(evidence.delivery_sha).toBe(sha);
      const content = await readFile(result.data.reviewPath, 'utf8');
      expect(content).toContain('### Host Validation Evidence');
      expect(content).toContain(sha);
      // Review F1: the review is bound to the head it was derived for; merge requires the branch to still be there.
      const parsed = await parseHandoff(result.data.reviewPath);
      if (!parsed.ok) throw new Error(parsed.message);
      expect(parsed.data.reviewed_sha).toBe(sha);
    });

    // Why: HO validation strings are untrusted input — the host never runs them (A1 ruling 1, A2 R6).
    it('never executes the HO validation text', async () => {
      const marker = join(tempDir, 'ho-validation-ran');
      const created = await createHandoff(baseImplementOpts({ dir: tempDir, validation: [`touch ${marker}`] }));
      if (!created.ok) throw new Error(created.message);
      await writeResponseDoc(tempDir, created.data.handoffId);
      await markDelivered(tempDir, created.data.handoffId);

      const result = await deriveReview({ dir: tempDir, handoff_id: created.data.handoffId });
      expect(result.ok).toBe(true);
      await expect(readFile(marker, 'utf8')).rejects.toThrow();
    });

    it('refuses when the delivery branch is gone', async () => {
      const implement = await deliverImplementHo(tempDir);
      await writeResponseDoc(tempDir, implement.handoffId);
      await markDelivered(tempDir, implement.handoffId);
      execFileSync('git', ['branch', '-D', `dispatch/${implement.handoffId}`], { cwd: tempDir });

      const result = await deriveReview({ dir: tempDir, handoff_id: implement.handoffId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('does not exist');
    });
  });
});

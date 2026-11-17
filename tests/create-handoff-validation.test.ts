/**
 * createHandoff() authoring gates. An implement handoff is generated from a
 * slice of a work item, so the explicit path refuses mode implement whatever
 * work_item it carries; the slice path writes the work item and slice into the
 * frontmatter; the other modes still author from explicit fields. The
 * write_scope entry-shape rule is enforced at authoring too, here through the
 * slice row's write_scope. Patterned after tests/dispatch-v2-admission.test.ts
 * (vitest, temp dirs, beforeEach/afterEach).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import type { CreateHandoffOpts } from '../packages/dispatch-core/src/types.js';
import { SLICE_ID, writeSliceWorkItem } from './helpers/slice-fixture.js';

/**
 * A deterministic snapshot of every path under `root` (relative path, kind,
 * mode, content hash for a file or link target for a symlink) — proves a
 * refused write_scope entry leaves `.git` byte-identical.
 */
async function snapshotTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full);
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        out.push(`${rel}\tsymlink\t${st.mode.toString(8)}\t${await readlink(full)}`);
      } else if (st.isDirectory()) {
        out.push(`${rel}\tdir\t${st.mode.toString(8)}`);
        await walk(full);
      } else {
        out.push(`${rel}\tfile\t${st.mode.toString(8)}\t${createHash('sha256').update(await readFile(full)).digest('hex')}`);
      }
    }
  }
  await walk(root);
  return out.sort();
}

function baseOpts(overrides: Partial<CreateHandoffOpts> = {}): CreateHandoffOpts {
  return {
    dir: '/does-not-matter-until-past-the-work-item-check',
    title: 'WK-0120 validation test handoff',
    subject: 'kb:dispatch',
    allowed_agents: ['claude'],
    mode: 'implement',
    acceptance: ['AC-1: example'],
    validation: ['npm test'],
    ...overrides,
  };
}

/** Mirrors tests/dispatch.test.ts's helper of the same name. */
async function setupBootstrappedRepo(repoRoot: string): Promise<void> {
  // WK-0261: wiki/handoffs/ (and the handoff.md template) now ship only once
  // the dispatch layer is active — a real dispatch repo always has this by the
  // time createHandoff runs (init-dispatch + sync-contract precede it).
  await mkdir(join(repoRoot, 'wiki', '.dispatch'), { recursive: true });
  const { bootstrap } = await import('@kb/wiki-core');
  const result = await bootstrap({ dir: repoRoot, repo: 'test/repo' });
  if (!result.ok) {
    throw new Error(result.message);
  }

  // WK-0152: createHandoff stamps base_sha from HEAD, so the repo must be a git repo with a commit.
  for (const args of [['init'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test User'], ['add', '-A'], ['commit', '-m', 'init']]) {
    execFileSync('git', args, { cwd: repoRoot });
  }
}

describe('createHandoff — an implement handoff comes from a slice', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'create-handoff-validation-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('an explicit implement HO is refused at authoring, whatever work_item it carries', () => {
    it.each([
      ['undefined', undefined],
      ['an empty string', ''],
      ['blank', '   '],
      ['malformed', 'not-a-wk-id'],
      ['a well-formed work item id', 'WK-0120'],
    ])('refuses when work_item is %s', async (_label, workItem) => {
      const result = await createHandoff(baseOpts({ dir: tempDir, work_item: workItem }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('MISSING_FIELD');
      expect(result.message).toContain('generated from a slice');
      expect(result.message).toContain('wk and slice');
      expect(result.message).toContain('## Slices');
      expect(result.message).toContain('one row is enough');
    });

    it('refuses an explicit implement HO that carries every explicit field and a work_item', async () => {
      const result = await createHandoff({
        dir: tempDir, subject: 'kb:dispatch', allowed_agents: ['claude'], title: 'T', mode: 'implement',
        acceptance: ['a'], validation: ['v'], write_scope: ['src/a.ts'], work_item: 'WK-0120',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('MISSING_FIELD');
    });

    it('refuses wk without slice, naming the rule', async () => {
      await setupBootstrappedRepo(tempDir);
      await writeSliceWorkItem(tempDir, 'WK-0120');
      const result = await createHandoff({ dir: tempDir, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: 'WK-0120' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('generated from a slice');
    });

    it('refuses a work item with no Slices table, naming the rule', async () => {
      await setupBootstrappedRepo(tempDir);
      await mkdir(join(tempDir, 'wiki', 'issues'), { recursive: true });
      await writeFile(join(tempDir, 'wiki', 'issues', 'WK-0120.md'), '---\nid: "WK-0120"\n---\n\n# WK-0120\n\n## Objective\n\nx\n');
      const result = await createHandoff({ dir: tempDir, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: 'WK-0120', slice: SLICE_ID });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('has no "## Slices" table');
      expect(result.message).toContain('generated from a slice');
    });
  });

  describe('implement HO from a slice authors cleanly', () => {
    it('succeeds and writes work_item and slice into the frontmatter', async () => {
      await setupBootstrappedRepo(tempDir);
      await writeSliceWorkItem(tempDir, 'WK-0120');

      const result = await createHandoff({ dir: tempDir, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: 'WK-0120', slice: SLICE_ID });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const content = await readFile(join(tempDir, result.data.handoffRelativePath), 'utf-8');
      expect(content).toContain('work_item: "WK-0120"');
      expect(content).toContain(`slice: "${SLICE_ID}"`);
      expect(content).toContain('mode: implement');
    });
  });

  describe('non-implement HO without work_item still authors cleanly from explicit fields', () => {
    it.each(['code_review', 'redteam', 'research', 'explore_code'] as const)('succeeds for mode=%s with no work_item declared', async (mode) => {
      await setupBootstrappedRepo(tempDir);

      const result = await createHandoff(baseOpts({ dir: tempDir, mode }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const content = await readFile(join(tempDir, result.data.handoffRelativePath), 'utf-8');
      expect(content).toContain(`mode: ${mode}`);
    });
  });

  // createHandoff refuses to author an HO whose write_scope entry fails the
  // shared entry-shape rule (checkWriteScopeEntryShape, admission.ts) — the
  // same rule admission applies at dispatch time, now enforced at authoring
  // time too, for every family (the rule itself carries no family notion).
  describe('write_scope entry-shape rule', () => {
    const sliceInput = () => ({ dir: tempDir, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: 'WK-0120', slice: SLICE_ID });

    // A slice row cannot hold an empty entry (the empty cell has no entries), so the
    // empty-string form is unreachable here; `.`, `./` and `/` cover the root forms.
    it.each(['.git/hooks/', 'src/.git/x', '.', './', '/'])(
      'refuses to author an HO with write_scope entry %j, naming the entry',
      async (entry) => {
        await setupBootstrappedRepo(tempDir);
        await writeSliceWorkItem(tempDir, 'WK-0120', { write_scope: [entry] });

        const result = await createHandoff(sliceInput());
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('STALE_WRITE_SCOPE');
        expect(result.message).toContain(JSON.stringify(entry));
      },
    );

    it('admits README.md, a not-yet-existing NEW.md, docs/ and docs (an existing directory), and src/a.ts', async () => {
      await setupBootstrappedRepo(tempDir);
      await mkdir(join(tempDir, 'docs'), { recursive: true });

      for (const entry of ['README.md', 'NEW.md', 'docs/', 'docs', 'src/a.ts']) {
        await writeSliceWorkItem(tempDir, 'WK-0120', { write_scope: [entry] });
        const result = await createHandoff(sliceInput());
        expect(result.ok).toBe(true);
      }
    });

    // A redteam-found gap: a tracked symlink aliasing `.git` makes a
    // not-yet-existing CHILD entry resolve into `.git` through its existing
    // ancestor. Refused at authoring too, before the HO ever reaches disk;
    // `.git` is untouched either way.
    describe('a tracked symlink aliasing .git (not-yet-existing child entries)', () => {
      beforeEach(async () => {
        await setupBootstrappedRepo(tempDir);
        await symlink(join(tempDir, '.git'), join(tempDir, 'alias'));
        execFileSync('git', ['add', '-A'], { cwd: tempDir });
        execFileSync('git', ['commit', '-m', 'add alias'], { cwd: tempDir });
      });

      it.each(['alias/worker.txt', 'alias/hooks/post-checkout'])(
        'refuses to author an HO with write_scope entry %j, naming the entry, leaving .git byte-identical',
        async (entry) => {
          const gitDir = join(tempDir, '.git');
          const before = await snapshotTree(gitDir);

          await writeSliceWorkItem(tempDir, 'WK-0120', { write_scope: [entry] });
          const result = await createHandoff(sliceInput());
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error).toBe('STALE_WRITE_SCOPE');
          expect(result.message).toContain(JSON.stringify(entry));

          expect(await snapshotTree(gitDir)).toEqual(before);
        },
      );
    });
  });
});

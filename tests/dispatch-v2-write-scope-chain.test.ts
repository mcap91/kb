/**
 * WK-0163 — ancestor-chain write_scope validation (AgentChassis pattern:
 * walk a not-yet-existing entry up to its nearest existing ancestor, then
 * require that ancestor's realpath stay contained within the root's
 * realpath). Covers `validateWriteScopeChain` (write-scope-chain.ts, the
 * shared helper) and `precreateWriteScopeSkeleton` (pipeline.ts's extracted
 * step 9b) against the same five scenarios — both call sites apply the
 * identical D2 containment rule (admission.ts against the mother repo,
 * pipeline.ts against the clone), so both must agree on every case. All
 * fixtures are internal shapes (temp dirs, plain files/symlinks) — no
 * external captures needed. No personal/absolute paths in fixtures
 * (WK-0043 rule); all filesystem tests use temp dirs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { validateWriteScopeChain } from '../packages/dispatch-core/src/write-scope-chain.js';
import { precreateWriteScopeSkeleton } from '../packages/dispatch-core/src/pipeline.js';

/**
 * A deterministic snapshot of every path under `root`: relative path, entry
 * kind, mode, and (for a regular file) a content hash — or its link target
 * for a symlink. Used to prove a refused write_scope entry leaves a
 * directory (`.git`, or a whole clone) byte-identical: the sorted snapshot
 * taken before a refusal must equal the one taken after.
 */
async function snapshotTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const names = await readdir(dir);
    for (const name of names) {
      const full = join(dir, name);
      const rel = relative(root, full);
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        out.push(`${rel}\tsymlink\t${st.mode.toString(8)}\t${await readlink(full)}`);
      } else if (st.isDirectory()) {
        out.push(`${rel}\tdir\t${st.mode.toString(8)}`);
        await walk(full);
      } else {
        const hash = createHash('sha256').update(await readFile(full)).digest('hex');
        out.push(`${rel}\tfile\t${st.mode.toString(8)}\t${hash}`);
      }
    }
  }
  await walk(root);
  return out.sort();
}

describe('WK-0163: ancestor-chain write_scope validation', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'dispatch-write-scope-chain-'));
    execFileSync('git', ['init'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    await writeFile(join(repoRoot, 'README.md'), '# test');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  describe('validateWriteScopeChain (write-scope-chain.ts, shared helper)', () => {
    it('admits a deep new path with no existing intermediate ancestor (tests/golden/smoke.txt, no tests/ dir)', async () => {
      const result = await validateWriteScopeChain(repoRoot, 'tests/golden/smoke.txt');
      expect(result.ok).toBe(true);
    });

    // D2 soft posture (deliberate deviation from AgentChassis's stricter
    // bwrap-path symlink refusal): a within-repo symlink ancestor's realpath
    // still lands inside the repo root, so an in-repo layout link (e.g. a
    // shared-fixtures symlink) is legitimate and must be admitted, not
    // refused just for being a symlink.
    it('admits a write_scope entry through a WITHIN-repo symlink ancestor', async () => {
      await mkdir(join(repoRoot, 'real-target'), { recursive: true });
      await symlink(join(repoRoot, 'real-target'), join(repoRoot, 'linked'));
      const result = await validateWriteScopeChain(repoRoot, 'linked/new-file.txt');
      expect(result.ok).toBe(true);
    });

    it('refuses a write_scope entry through a symlink ancestor that resolves outside the repo', async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'dispatch-write-scope-outside-'));
      try {
        await symlink(outsideDir, join(repoRoot, 'escape'));
        const result = await validateWriteScopeChain(repoRoot, 'escape/new-file.txt');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('STALE_WRITE_SCOPE');
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('refuses an absolute entry (resolves to itself, outside rootDir entirely)', async () => {
      const result = await validateWriteScopeChain(repoRoot, '/etc/kb-wk0163-nonexistent-probe');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('STALE_WRITE_SCOPE');
    });

    it('admits an existing-path entry unchanged', async () => {
      const result = await validateWriteScopeChain(repoRoot, 'src');
      expect(result.ok).toBe(true);
    });
  });

  describe('precreateWriteScopeSkeleton (pipeline.ts step 9b, same five cases)', () => {
    it('creates a deep new path with no existing intermediate ancestor', async () => {
      const result = await precreateWriteScopeSkeleton(['tests/golden/smoke.txt'], repoRoot);
      expect(result.ok).toBe(true);
      expect(existsSync(join(repoRoot, 'tests', 'golden', 'smoke.txt'))).toBe(true);
    });

    it('creates through a WITHIN-repo symlink ancestor (D2 soft posture)', async () => {
      await mkdir(join(repoRoot, 'real-target'), { recursive: true });
      await symlink(join(repoRoot, 'real-target'), join(repoRoot, 'linked'));
      const result = await precreateWriteScopeSkeleton(['linked/new-file.txt'], repoRoot);
      expect(result.ok).toBe(true);
      expect(existsSync(join(repoRoot, 'real-target', 'new-file.txt'))).toBe(true);
    });

    it('refuses, and creates nothing, through a symlink ancestor that resolves outside the repo', async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'dispatch-write-scope-outside-'));
      try {
        await symlink(outsideDir, join(repoRoot, 'escape'));
        const result = await precreateWriteScopeSkeleton(['escape/new-file.txt'], repoRoot);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('STALE_WRITE_SCOPE');
        expect(existsSync(join(outsideDir, 'new-file.txt'))).toBe(false);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('refuses an absolute entry without creating anything', async () => {
      const result = await precreateWriteScopeSkeleton(['/etc/kb-wk0163-nonexistent-probe'], repoRoot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('STALE_WRITE_SCOPE');
    });

    it('leaves an existing-path entry unchanged (idempotent)', async () => {
      const result = await precreateWriteScopeSkeleton(['src'], repoRoot);
      expect(result.ok).toBe(true);
      expect(existsSync(join(repoRoot, 'src'))).toBe(true);
    });
  });

  // A redteam-found gap: the nearest-existing-ancestor walk above resolves a
  // not-yet-existing entry's target through a symlinked ancestor — closing a
  // tracked `alias -> .git` (or `alias -> .`) where the entry itself (e.g.
  // `alias/worker.txt`) has nothing of its own to realpath yet, but its
  // ancestor already does. Both call sites must refuse before anything is
  // created.
  describe('resolving a not-yet-existing entry through a symlinked ancestor that aliases .git or the root', () => {
    let gitAlias: string;
    let rootAlias: string;

    beforeEach(async () => {
      gitAlias = join(repoRoot, 'alias');
      rootAlias = join(repoRoot, 'alias-root');
      await symlink(join(repoRoot, '.git'), gitAlias);
      await symlink(repoRoot, rootAlias);
      execFileSync('git', ['add', '-A'], { cwd: repoRoot });
      execFileSync('git', ['commit', '-m', 'add aliases'], { cwd: repoRoot });
    });

    describe('validateWriteScopeChain', () => {
      it.each(['alias/worker.txt', 'alias/hooks/post-checkout'])(
        'refuses entry %j (not-yet-existing child of a tracked alias -> .git)',
        async (entry) => {
          const result = await validateWriteScopeChain(repoRoot, entry);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error).toBe('STALE_WRITE_SCOPE');
        },
      );

      // A not-yet-existing CHILD of a root-aliasing symlink (e.g.
      // `alias-root/new-file.txt`) resolves to a new file INSIDE the root —
      // the same effect as a plain root-level file entry, which is admitted
      // (every family gets exact-file binds). Only the alias itself,
      // directly, resolves to the root exactly and is refused.
      it('refuses a tracked alias -> . used directly as an entry (resolves to the repo root itself)', async () => {
        const result = await validateWriteScopeChain(repoRoot, 'alias-root');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('STALE_WRITE_SCOPE');
      });

      it('admits a not-yet-existing child of a tracked alias -> . (a root-level file write, same as writing it directly)', async () => {
        const result = await validateWriteScopeChain(repoRoot, 'alias-root/new-file.txt');
        expect(result.ok).toBe(true);
      });
    });

    describe('precreateWriteScopeSkeleton', () => {
      it.each(['alias/worker.txt', 'alias/hooks/post-checkout'])(
        'refuses entry %j and leaves .git byte-identical (nothing created through the alias)',
        async (entry) => {
          const gitDir = join(repoRoot, '.git');
          const before = await snapshotTree(gitDir);

          const result = await precreateWriteScopeSkeleton([entry], repoRoot);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error).toBe('STALE_WRITE_SCOPE');

          const after = await snapshotTree(gitDir);
          expect(after).toEqual(before);
        },
      );

      it('a bad entry after several good entries creates nothing at all (clone-wide snapshot unchanged)', async () => {
        const before = await snapshotTree(repoRoot);

        const result = await precreateWriteScopeSkeleton(
          ['docs/good-one.txt', 'docs/nested/good-two.txt', 'alias/worker.txt'],
          repoRoot,
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('STALE_WRITE_SCOPE');

        const after = await snapshotTree(repoRoot);
        expect(after).toEqual(before);
        expect(existsSync(join(repoRoot, 'docs'))).toBe(false);
      });
    });
  });
});

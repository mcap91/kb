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
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateWriteScopeChain } from '../packages/dispatch-core/src/write-scope-chain.js';
import { precreateWriteScopeSkeleton } from '../packages/dispatch-core/src/pipeline.js';

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
});

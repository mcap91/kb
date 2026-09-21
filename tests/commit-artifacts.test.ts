/**
 * WK-0132 Slice 1 (DEC-0038) — `commitArtifacts` tests.
 *
 * Covers the pipeline's post-run auto-commit of `wiki/handoffs/HO-XXXX.md`
 * + `wiki/handoffs/HO-XXXX.response.md`: two-path-only isolation under a
 * dirty real index/working tree, pinned identity + templated message,
 * silent no-op when nothing changed, and warn-not-fail on a non-git target.
 * Real git repos in temp dirs — no personal/absolute paths in fixtures
 * (WK-0043 rule).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { commitArtifacts } from '../packages/dispatch-core/src/commit-artifacts.js';

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

async function commitFiles(dir: string, sha: string): Promise<string[]> {
  const { stdout } = await execFile(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
    { cwd: dir },
  );
  return stdout.trim().split('\n').filter((line) => line.length > 0).sort();
}

async function commitFormat(dir: string, format: string): Promise<string> {
  const { stdout } = await execFile('git', ['log', '-1', `--format=${format}`], { cwd: dir });
  return stdout.trim();
}

async function statusPorcelain(dir: string): Promise<string> {
  const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd: dir });
  return stdout;
}

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'kb-commit-artifacts-'));
  await initRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe('commitArtifacts (WK-0132 Slice 1, DEC-0038)', () => {
  it('commits exactly the two artifact paths, excluding staged and unstaged unrelated dirt', async () => {
    // Dirty the REAL index/working tree with unrelated content that must
    // survive untouched (DEC-0038 isolation contract).
    await writeFile(join(repoDir, 'staged-unrelated.txt'), 'staged dirt\n');
    await execFile('git', ['add', 'staged-unrelated.txt'], { cwd: repoDir });
    await writeFile(join(repoDir, 'untracked-unrelated.txt'), 'untracked dirt\n');

    await writeFile(join(repoDir, 'wiki', 'handoffs', 'HO-0034.response.md'), '# response\n');
    await writeFile(
      join(repoDir, 'wiki', 'handoffs', 'HO-0034.md'),
      '---\nid: "HO-0034"\n---\n\nbody\n',
    );

    const beforeHead = await headSha(repoDir);

    await commitArtifacts({
      dir: repoDir,
      handoffId: 'HO-0034',
      outcome: 'delivered',
      model: 'qwen3:8b',
    });

    const afterHead = await headSha(repoDir);
    expect(afterHead).not.toBe(beforeHead);
    expect(await commitFiles(repoDir, afterHead)).toEqual([
      'wiki/handoffs/HO-0034.md',
      'wiki/handoffs/HO-0034.response.md',
    ]);

    // The unrelated dirt (both staged and untracked) must still be dirty —
    // the isolated index must never have touched the real one.
    const status = await statusPorcelain(repoDir);
    expect(status).toMatch(/^A\s+staged-unrelated\.txt$/m);
    expect(status).toMatch(/^\?\?\s+untracked-unrelated\.txt$/m);

    // Real index must be clean for the artifact paths after auto-commit
    const responsePath = join(repoDir, 'wiki', 'handoffs', 'HO-0034.response.md');
    const hoPath = join(repoDir, 'wiki', 'handoffs', 'HO-0034.md');
    const { stdout: postStatus } = await execFile(
      'git',
      ['status', '--porcelain', '--', responsePath, hoPath],
      { cwd: repoDir },
    );
    expect(postStatus.trim()).toBe('');
  });

  it('pins the kb-dispatch identity and the templated commit message', async () => {
    await writeFile(join(repoDir, 'wiki', 'handoffs', 'HO-0099.response.md'), '# response\n');
    await writeFile(join(repoDir, 'wiki', 'handoffs', 'HO-0099.md'), '---\nid: "HO-0099"\n---\n');

    await commitArtifacts({
      dir: repoDir,
      handoffId: 'HO-0099',
      outcome: 'delivered',
      model: 'qwen3:8b',
    });

    expect(await commitFormat(repoDir, '%an <%ae>')).toBe('kb-dispatch <dispatch@kb.local>');
    expect(await commitFormat(repoDir, '%s')).toBe('chore: dispatch HO-0099 delivered (qwen3:8b)');
  });

  it('is a silent no-op when neither artifact path has changes', async () => {
    const beforeHead = await headSha(repoDir);

    await commitArtifacts({
      dir: repoDir,
      handoffId: 'HO-0001',
      outcome: 'delivered',
      model: 'qwen3:8b',
    });

    expect(await headSha(repoDir)).toBe(beforeHead);
  });

  it('warns but never fails the run when the target dir is not a git repo', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'kb-commit-artifacts-not-a-repo-'));
    try {
      await expect(
        commitArtifacts({
          dir: notARepo,
          handoffId: 'HO-0002',
          outcome: 'delivered',
          model: 'qwen3:8b',
          verbose: false,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});

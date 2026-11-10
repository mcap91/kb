/**
 * WK-0258 — where a chained HO's read_first resolves (DEC-0047 A3.4). The
 * clone is cut from base_ref, so non-wiki entries resolve against that tree:
 * branch-only files are admitted, main-only files refuse MISSING_READ_FIRST
 * with guidance, and nothing is copied into the clone. Wiki entries keep the
 * wiki working-tree check in both shapes. The overseer's two base_ref-tree
 * acceptance tests live in dispatch-v2-foundation.test.ts; these cover the
 * precedence edges. Temp dirs only (WK-0043).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import type { Handoff } from '../packages/dispatch-core/src/ho.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

function initRepo(dir: string): void {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

function chainedHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'HO-9258',
    title: 'Chained read_first fixture',
    mode: 'code_review',
    write_scope: [],
    base_ref: 'dispatch/HO-9000',
    web: false,
    credentials: [],
    data_mounts: [],
    export_mounts: [],
    runtime_envs: [],
    read_first: [],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['review only'],
    status: 'draft',
    ...overrides,
  };
}

describe('WK-0258 chained read_first — tracked wiki', () => {
  let repo: string;
  let main: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-chained-read-first-'));
    initRepo(repo);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'issues', 'WK-9258.md'), 'ticket\n');
    commitAll(repo, 'init');
    main = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'dispatch/HO-9000');
    await mkdir(join(repo, 'src', 'feature'), { recursive: true });
    await writeFile(join(repo, 'src', 'feature', 'new.ts'), 'export const x = 1;\n');
    commitAll(repo, 'branch-only directory');
    git(repo, 'checkout', '-q', main);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: read_first lists directories with a trailing slash; the tree lookup must accept them.
  it('admits a branch-only directory entry written with a trailing slash', async () => {
    const result = await checkAdmission(chainedHandoff({ read_first: ['src/feature/'] }), repo);
    expect(result.ok).toBe(true);
  });

  // Why: wiki entries keep the working-tree rule (ruling precedence 1), even when main-only.
  it('admits a wiki entry that exists only in the working tree on main', async () => {
    await mkdir(join(repo, 'wiki', 'handoffs'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'handoffs', 'HO-9000.response.md'), 'response\n');
    commitAll(repo, 'response on main');
    const result = await checkAdmission(chainedHandoff({ read_first: ['wiki/handoffs/HO-9000.response.md'] }), repo);
    expect(result.ok).toBe(true);
  });

  // Why: the worker reads the base_ref copy, so a dirty main-checkout copy is irrelevant, not "uncommitted input".
  it('does not refuse a base_ref-resolved entry whose main working copy is dirty', async () => {
    await writeFile(join(repo, 'README.md'), '# edited on main, not committed\n');
    const result = await checkAdmission(chainedHandoff({ read_first: ['README.md'] }), repo);
    expect(result.ok).toBe(true);
  });

  // Why: an unresolvable base_ref is BAD_BASE_REF's refusal, with its precise message, not a read_first miss.
  it.each(['dispatch/HO-missing', 'feature/not-dispatch'])('defers base_ref %s to BAD_BASE_REF', async (baseRef) => {
    const result = await checkAdmission(chainedHandoff({ base_ref: baseRef, read_first: ['src/feature/new.ts'] }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_BASE_REF');
  });

  // Why: AC3 — a fresh-HEAD HO still resolves read_first against the working tree, so a branch-only file is missing.
  it('keeps the working-tree check for an HO with no base_ref', async () => {
    const result = await checkAdmission(
      chainedHandoff({ base_ref: null, base_sha: git(repo, 'rev-parse', 'HEAD'), read_first: ['src/feature/new.ts'] }),
      repo,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('MISSING_READ_FIRST');
    expect(result.message).not.toContain('base_ref tree');
  });
});

describe('WK-0258 chained read_first — nested-private wiki', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-chained-read-first-nested-'));
    initRepo(repo);
    await writeFile(join(repo, '.gitignore'), 'wiki/\n');
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    commitAll(repo, 'init');
    git(repo, 'branch', 'dispatch/HO-9000');
    const wikiDir = join(repo, 'wiki');
    await mkdir(join(wikiDir, 'handoffs'), { recursive: true });
    await writeFile(join(wikiDir, 'handoffs', 'HO-9000.response.md'), 'response\n');
    initRepo(wikiDir);
    commitAll(wikiDir, 'wiki init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: the nested wiki is not in any code-repo tree; its entries must never be looked up in base_ref.
  it('admits a wiki entry from the separate wiki repo and refuses a missing one', async () => {
    const present = await checkAdmission(chainedHandoff({ read_first: ['wiki/handoffs/HO-9000.response.md'] }), repo);
    expect(present.ok).toBe(true);
    const missing = await checkAdmission(chainedHandoff({ read_first: ['wiki/handoffs/HO-9999.response.md'] }), repo);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toBe('MISSING_READ_FIRST');
    expect(missing.message).not.toContain('base_ref tree');
  });
});

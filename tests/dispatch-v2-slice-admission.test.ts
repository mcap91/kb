/**
 * An implement handoff is generated from a slice, and admission refuses one that is
 * not: no `slice`, no readable work item file, or no such row in the work item's
 * `## Slices` table. Both wiki shapes read the work item from `wiki/issues/` in the
 * working tree. A fix-up generated through the slice path (`base_ref` +
 * `fixup_context`) is admitted. Other modes are untouched. Temp dirs only.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap } from '@kb/wiki-core';

import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import { parseHandoff, type Handoff } from '../packages/dispatch-core/src/ho.js';
import { SLICE_ID, sliceWorkItemText, writeSliceWorkItem } from './helpers/slice-fixture.js';

const WK = 'WK-9300';

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

function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'HO-9300',
    title: 'Slice admission fixture',
    mode: 'implement',
    work_item: WK,
    slice: SLICE_ID,
    write_scope: ['src/'],
    base_ref: null,
    web: false,
    credentials: [],
    data_mounts: [],
    export_mounts: [],
    runtime_envs: [],
    read_first: ['README.md'],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['true'],
    status: 'draft',
    ...overrides,
  };
}

describe.each([
  { shape: 'tracked wiki', nested: false },
  { shape: 'nested-private wiki', nested: true },
])('implement admission needs a slice row — $shape', ({ nested }) => {
  let repo: string;
  let stamps: Pick<Handoff, 'base_sha' | 'base_wiki_sha'>;

  /** Writes and commits the work item (in the wiki repo in the nested shape) and sets the stamps the handoff carries. */
  async function commitWorkItem(text: string): Promise<void> {
    const wikiDir = join(repo, 'wiki');
    await mkdir(join(wikiDir, 'issues'), { recursive: true });
    await writeFile(join(wikiDir, 'issues', `${WK}.md`), text);
    if (nested) {
      stamps = { base_sha: git(repo, 'rev-parse', 'HEAD'), base_wiki_sha: commitAll(wikiDir, 'work item') };
    } else {
      stamps = { base_sha: commitAll(repo, 'work item') };
    }
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-slice-admission-'));
    initRepo(repo);
    if (nested) await writeFile(join(repo, '.gitignore'), 'wiki/\n');
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    commitAll(repo, 'init');
    if (nested) {
      await mkdir(join(repo, 'wiki'), { recursive: true });
      initRepo(join(repo, 'wiki'));
      await writeFile(join(repo, 'wiki', 'README.md'), '# wiki\n');
      commitAll(join(repo, 'wiki'), 'wiki init');
    }
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('admits a handoff whose slice is a row of its work item', async () => {
    await commitWorkItem(sliceWorkItemText(WK));
    const result = await checkAdmission(makeHandoff(stamps), repo);
    expect(result.ok).toBe(true);
  });

  it('refuses an implement handoff with no slice, naming the handoff, the work item and the fix', async () => {
    await commitWorkItem(sliceWorkItemText(WK));
    const result = await checkAdmission(makeHandoff({ ...stamps, slice: undefined }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
    expect(result.message).toContain('HO-9300');
    expect(result.message).toContain(WK);
    expect(result.message).toContain('no slice');
    expect(result.message).toContain('create-handoff');
    expect(result.message).toContain('wk + slice');
    expect(result.message).toContain('one row is enough');
  });

  it('refuses an implement handoff with no work_item, naming the handoff and the fix', async () => {
    await commitWorkItem(sliceWorkItemText(WK));
    const result = await checkAdmission(makeHandoff({ ...stamps, work_item: undefined }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('WORK_ITEM_NOT_FOUND');
    expect(result.message).toContain('HO-9300');
    expect(result.message).toContain('generated from a slice');
    expect(result.message).toContain('create-handoff');
  });

  it('refuses when the work item file cannot be read, naming the handoff, the work item and the fix', async () => {
    await commitWorkItem(sliceWorkItemText(WK));
    const result = await checkAdmission(makeHandoff({ ...stamps, work_item: 'WK-9999' }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('WORK_ITEM_NOT_FOUND');
    expect(result.message).toContain('HO-9300');
    expect(result.message).toContain('wiki/issues/WK-9999.md');
    expect(result.message).toContain('create-handoff');
  });

  it('refuses a slice that is not a row of the work item, listing the rows it has', async () => {
    await commitWorkItem(sliceWorkItemText(WK));
    const result = await checkAdmission(makeHandoff({ ...stamps, slice: 's7' }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
    expect(result.message).toContain('HO-9300');
    expect(result.message).toContain('slice "s7"');
    expect(result.message).toContain(`wiki/issues/${WK}.md`);
    expect(result.message).toContain(`its rows are: ${SLICE_ID}`);
    expect(result.message).toContain('Add the row');
  });

  it('refuses a work item with no Slices table, saying so', async () => {
    await commitWorkItem(`---\nid: "${WK}"\n---\n\n# ${WK}\n\n## Objective\n\nx\n`);
    const result = await checkAdmission(makeHandoff(stamps), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
    expect(result.message).toContain('it has no "## Slices" table');
  });

  // Why: only implement is generated from a slice; the other modes carry no slice and no work item.
  it('admits a research handoff with no work_item and no slice', async () => {
    await commitWorkItem(sliceWorkItemText(WK));
    const result = await checkAdmission(
      makeHandoff({ ...stamps, mode: 'research', write_scope: [], work_item: undefined, slice: undefined }),
      repo,
    );
    expect(result.ok).toBe(true);
  });
});

describe('a fix-up generated through the slice path', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-slice-fixup-'));
    await mkdir(join(repo, 'wiki', '.dispatch'), { recursive: true });
    const boot = await bootstrap({ dir: repo, repo: 'test/repo' });
    if (!boot.ok) throw new Error(boot.message);
    await writeSliceWorkItem(repo, WK, { write_scope: ['src/app.ts'] });
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    initRepo(repo);
    commitAll(repo, 'init');
    git(repo, 'branch', 'dispatch/HO-0001');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('is written with the slice, base_ref and fixup_context, and admitted', async () => {
    const created = await createHandoff({
      dir: repo,
      subject: 'kb:dispatch',
      allowed_agents: ['claude'],
      wk: WK,
      slice: SLICE_ID,
      base_ref: 'dispatch/HO-0001',
      fixup_context: 'F1: the parser drops digits',
    });
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data).toMatchObject({
      mode: 'implement',
      work_item: WK,
      slice: SLICE_ID,
      base_ref: 'dispatch/HO-0001',
      fixup_context: 'F1: the parser drops digits',
      write_scope: ['src/app.ts'],
    });

    const admitted = await checkAdmission(parsed.data, repo);
    expect(admitted.ok).toBe(true);
  });
});

/**
 * createHandoff with `wk` + `slice`: the handoff is generated from a work
 * item's `## Slices` row and body instead of retyped options. The explicit
 * options path is covered by create-handoff-validation.test.ts and the
 * stamping tests, which stay unedited.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { bootstrap } from '@kb/wiki-core';
import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import { parseHandoff } from '../packages/dispatch-core/src/ho.js';
import type { CreateHandoffInput } from '../packages/dispatch-core/src/types.js';

const WK_ID = 'WK-9213';

function wkText(slicesSection: string): string {
  return [
    '---',
    `id: "${WK_ID}"`,
    'title: "Fixture work item"',
    'type: feature',
    'status: todo',
    '---',
    '',
    `# ${WK_ID}: Fixture work item`,
    '',
    '## Objective',
    '',
    'Make the fixture do the thing.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] The thing is done',
    '- [x] The thing is tested',
    '',
    '## Notes',
    '',
    'Free text.',
    '',
    slicesSection,
  ].join('\n');
}

const TWO_SLICES = [
  '## Slices',
  '',
  '| id | title | write_scope | depends_on | validation | status |',
  '|----|-------|-------------|------------|------------|--------|',
  '| s1 | First slice | src/existing.ts, src/brand-new.ts | | npm test | todo |',
  '| s2 | Second slice | src/other.ts | s1 | npm run typecheck | todo |',
  '',
].join('\n');

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd });
}

describe('createHandoff from a slice row', () => {
  let repo: string;

  async function writeRepoFile(rel: string, content: string): Promise<void> {
    await mkdir(dirname(join(repo, rel)), { recursive: true });
    await writeFile(join(repo, rel), content);
  }

  async function setup(wk: string): Promise<void> {
    await mkdir(join(repo, 'wiki', '.dispatch'), { recursive: true });
    const boot = await bootstrap({ dir: repo, repo: 'test/repo' });
    if (!boot.ok) throw new Error(boot.message);
    await writeRepoFile(`wiki/issues/${WK_ID}.md`, wk);
    await writeRepoFile('src/existing.ts', 'export {};\n');
    await writeRepoFile('src/other.ts', 'export {};\n');
    for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-m', 'init']]) {
      git(repo, ...args);
    }
  }

  function input(overrides: Partial<CreateHandoffInput> = {}): CreateHandoffInput {
    return { dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: WK_ID, slice: 's1', ...overrides };
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-slice-handoff-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('writes a handoff whose fields equal the slice row and work item text', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ slice: 's2' }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parsed = await parseHandoff(created.data.handoffPath);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data).toMatchObject({
      title: 'Second slice',
      mode: 'implement',
      work_item: WK_ID,
      slice: 's2',
      write_scope: ['src/other.ts'],
      read_first: ['src/other.ts', `wiki/issues/${WK_ID}.md`],
      validation: ['npm run typecheck'],
      acceptance: ['The thing is done', 'The thing is tested'],
    });
    const content = await readFile(created.data.handoffPath, 'utf8');
    expect(content).toContain('Make the fixture do the thing.');
  });

  it('picks the requested row when the table has several', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ slice: 's1' }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.write_scope).toEqual(['src/existing.ts', 'src/brand-new.ts']);
    expect(parsed.data.validation).toEqual(['npm test']);
  });

  it('keeps only row files that exist in read_first, and still writes new files to write_scope', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ slice: 's1' }));
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.read_first).toEqual(['src/existing.ts', `wiki/issues/${WK_ID}.md`]);
    expect(parsed.data.write_scope).toContain('src/brand-new.ts');
  });

  it('records slice in frontmatter and admission accepts the key', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ slice: 's2' }));
    if (!created.ok) throw new Error(created.message);
    expect(await readFile(created.data.handoffPath, 'utf8')).toContain('slice: "s2"');
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.slice).toBe('s2');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'handoff');
    const admitted = await checkAdmission(parsed.data, repo);
    // Any other gate may refuse this bare fixture; none may refuse the slice key.
    expect(admitted.ok).toBe(true);
  });

  it('refuses a slice id the table does not have, naming the ids it does have', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ slice: 's9' }));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('MISSING_FIELD');
    expect(created.message).toContain('s9');
    expect(created.message).toContain('s1, s2');
  });

  it('refuses a work item with no Slices table', async () => {
    await setup(wkText(''));
    const created = await createHandoff(input());
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('MISSING_FIELD');
    expect(created.message).toContain('no "## Slices" table');
  });

  it('refuses a work item file that does not exist', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ wk: 'WK-9999' }));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('FILE_NOT_FOUND');
  });

  it('refuses wk without slice and slice without wk', async () => {
    await setup(wkText(TWO_SLICES));
    for (const partial of [{ slice: undefined }, { wk: undefined }]) {
      const created = await createHandoff(input(partial));
      expect(created.ok).toBe(false);
      if (created.ok) continue;
      expect(created.error).toBe('MISSING_FIELD');
    }
  });

  it('refuses explicit fields the slice derives instead of merging them', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ write_scope: ['src/elsewhere.ts'] }));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('INVALID_HANDOFF');
    expect(created.message).toContain('write_scope');
  });

  it('refuses the explicit path when title, mode, acceptance or validation is missing', async () => {
    await setup(wkText(''));
    const created = await createHandoff({ dir: repo, subject: 's', allowed_agents: ['claude'] });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('MISSING_FIELD');
  });
});

describe('createHandoff from a slice row — fix-up and drift', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-slice-fixup-'));
    await mkdir(join(repo, 'wiki', '.dispatch'), { recursive: true });
    const boot = await bootstrap({ dir: repo, repo: 'test/repo' });
    if (!boot.ok) throw new Error(boot.message);
    await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'issues', `${WK_ID}.md`), wkText(TWO_SLICES));
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'existing.ts'), 'export {};\n');
    for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-m', 'init']]) {
      git(repo, ...args);
    }
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('takes base_ref and fixup_context alongside wk and slice', async () => {
    git(repo, 'branch', 'dispatch/HO-0001');
    const created = await createHandoff({
      dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: WK_ID, slice: 's1',
      base_ref: 'dispatch/HO-0001', fixup_context: 'Finding 1:\n- "x" fails',
    });
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data).toMatchObject({
      base_ref: 'dispatch/HO-0001',
      fixup_context: 'Finding 1:\n- "x" fails',
      slice: 's1',
      write_scope: ['src/existing.ts', 'src/brand-new.ts'],
    });
  });

  it('admission refuses BASE_DRIFT when the slice row changes after the handoff was generated', async () => {
    const created = await createHandoff({ dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: WK_ID, slice: 's1' });
    if (!created.ok) throw new Error(created.message);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'handoff');
    const wkPath = join(repo, 'wiki', 'issues', `${WK_ID}.md`);
    await writeFile(wkPath, (await readFile(wkPath, 'utf8')).replace('| npm test |', '| npm run typecheck |'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'edit slice row');
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    const admitted = await checkAdmission(parsed.data, repo);
    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(admitted.error).toBe('BASE_DRIFT');
  });
});

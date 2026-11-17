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
import { dirname, join, resolve } from 'node:path';

import { bootstrap } from '@kb/wiki-core';
import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import { parseHandoff } from '../packages/dispatch-core/src/ho.js';
import type { CreateHandoffInput } from '../packages/dispatch-core/src/types.js';
import { tools } from '../packages/dispatch-mcp/src/tools.js';

const ROOT = resolve(process.cwd());
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const CLI = resolve(ROOT, 'packages/dispatch-cli/src/index.ts');

const WK_ID = 'WK-9213';

interface WkParts {
  /** Objective section body lines; null omits the heading. */
  objective?: string[] | null;
  /** Acceptance section body lines; null omits the heading. */
  acceptance?: string[] | null;
}

function wkText(slicesSection: string, parts: WkParts = {}): string {
  const objective = parts.objective === undefined ? ['Make the fixture do the thing.'] : parts.objective;
  const acceptance = parts.acceptance === undefined
    ? ['- [ ] The thing is done', '- [x] The thing is tested']
    : parts.acceptance;
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
    ...(objective === null ? [] : ['## Objective', '', ...objective, '']),
    ...(acceptance === null ? [] : ['## Acceptance criteria', '', ...acceptance, '']),
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

async function objectiveOf(handoffPath: string): Promise<string> {
  const text = await readFile(handoffPath, 'utf8');
  return /\n## Objective\n([^]*?)\n\n## Constraints/.exec(text)?.[1] ?? '';
}

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
      acceptance: [expect.stringContaining('Only slice s2 (Second slice)'), 'The thing is done', 'The thing is tested'],
    });
    const content = await readFile(created.data.handoffPath, 'utf8');
    expect(content).toContain('Make the fixture do the thing.');
  });

  // Why: the worker of s1 built every function of the work item, so s2 had nothing left; the slice must bound the work.
  it('bounds the objective to the slice and names the other slices as out of scope', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ slice: 's1' }));
    if (!created.ok) throw new Error(created.message);
    const [lead, ...rest] = (await objectiveOf(created.data.handoffPath)).split('\n\n');
    expect(lead).toContain('s1');
    expect(lead).toContain('First slice');
    expect(lead).toContain(WK_ID);
    expect(lead).toContain('this slice only');
    expect(lead).toMatch(/out of scope[^]*s2 \(Second slice\)/);
    expect(lead).not.toMatch(/out of scope[^]*s1/);
    expect(rest.join('\n\n')).toBe('Work item objective, for context:\nMake the fixture do the thing.');
  });

  it('puts one generated item before the work item acceptance items, unchanged and in order', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ slice: 's1' }));
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    const [generated, ...items] = parsed.data.acceptance;
    expect(generated).toContain('s1');
    expect(generated).toContain('First slice');
    expect(generated).toContain('another slice is out of scope');
    expect(items).toEqual(['The thing is done', 'The thing is tested']);
  });

  it('adds no out-of-scope clause and no generated acceptance item when the table has one row', async () => {
    const oneRow = TWO_SLICES.split('\n').filter((line) => !line.startsWith('| s2')).join('\n');
    await setup(wkText(oneRow));
    const created = await createHandoff(input({ slice: 's1' }));
    if (!created.ok) throw new Error(created.message);
    const objective = await objectiveOf(created.data.handoffPath);
    expect(objective).not.toContain('out of scope');
    expect(objective).toContain('Make the fixture do the thing.');
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.acceptance).toEqual(['The thing is done', 'The thing is tested']);
  });

  // Why: a slice title with YAML-significant characters must not break the frontmatter.
  it('round-trips a generated acceptance item built from a title with punctuation', async () => {
    await setup(wkText(TWO_SLICES.replace('First slice', 'countWords `with` tests: (a, b)')));
    const created = await createHandoff(input({ slice: 's1' }));
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.acceptance[0]).toContain('countWords `with` tests: (a, b)');
    expect(parsed.data.acceptance.slice(1)).toEqual(['The thing is done', 'The thing is tested']);
  });

  it('writes timeout_secs on the slice path and on the explicit path, and refuses a bad value', async () => {
    await setup(wkText(TWO_SLICES));
    const sliced = await createHandoff(input({ timeout_secs: 3600 }));
    if (!sliced.ok) throw new Error(sliced.message);
    expect(await readFile(sliced.data.handoffPath, 'utf8')).toContain('timeout_secs: 3600\n');
    const parsedSlice = await parseHandoff(sliced.data.handoffPath);
    if (!parsedSlice.ok) throw new Error(parsedSlice.message);
    expect(parsedSlice.data.timeout_secs).toBe(3600);

    const explicit = await createHandoff({
      dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], title: 'T', mode: 'code_review',
      acceptance: ['a'], validation: ['v'], timeout_secs: 90,
    });
    if (!explicit.ok) throw new Error(explicit.message);
    const parsedExplicit = await parseHandoff(explicit.data.handoffPath);
    if (!parsedExplicit.ok) throw new Error(parsedExplicit.message);
    expect(parsedExplicit.data.timeout_secs).toBe(90);

    for (const bad of [0, -5, 1.5, Number.NaN]) {
      const refused = await createHandoff(input({ timeout_secs: bad }));
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error).toBe('INVALID_HANDOFF');
      expect(refused.message).toContain('timeout_secs');
    }
  });

  it('writes no timeout_secs line when it is omitted', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input());
    if (!created.ok) throw new Error(created.message);
    expect(await readFile(created.data.handoffPath, 'utf8')).not.toContain('timeout_secs');
  });

  it('the CLI --timeout-secs flag writes it and refuses a bad value', async () => {
    await setup(wkText(TWO_SLICES));
    const base = [CLI, 'create-handoff', '--dir', repo, '--subject', 'kb:dispatch', '--allowed-agents', 'claude', '--wk', WK_ID, '--slice', 's1'];
    execFileSync(TSX, [...base, '--timeout-secs', '600'], { cwd: ROOT, stdio: 'pipe' });
    const parsed = await parseHandoff(join(repo, 'wiki', 'handoffs', 'HO-0001.md'));
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.timeout_secs).toBe(600);
    expect(() => execFileSync(TSX, [...base, '--timeout-secs', '0'], { cwd: ROOT, stdio: 'pipe' })).toThrow();
    expect(() => execFileSync(TSX, [...base, '--timeout-secs', 'abc'], { cwd: ROOT, stdio: 'pipe' })).toThrow();
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

  async function acceptanceOf(lines: string[]) {
    await setup(wkText(TWO_SLICES, { acceptance: lines }));
    return createHandoff(input({ slice: 's2' }));
  }

  async function writtenAcceptance(lines: string[]): Promise<string[]> {
    const created = await acceptanceOf(lines);
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.data.acceptance.slice(1); // item 0 is the generated slice bound
  }

  // Why: real work items wrap long criteria; a truncated criterion is a weaker spec for the worker.
  it('keeps the continuation lines of a wrapped acceptance item', async () => {
    expect(await writtenAcceptance([
      '- [ ] The stale test is corrected, and',
      '  the new test pins it',
      '- [ ] Second',
    ])).toEqual(['The stale test is corrected, and the new test pins it', 'Second']);
  });

  // Why: a sub-bullet is detail of its criterion, not a separate criterion.
  it('folds sub-bullets into their item, joined with a space', async () => {
    expect(await writtenAcceptance([
      '- [ ] Parent criterion',
      '  - child one',
      '  * child two',
      '- Next',
    ])).toEqual(['Parent criterion child one child two', 'Next']);
  });

  // Why: numbered lists are common in work items and used to yield no criteria at all.
  it('reads a numbered list, with either `.` or `)` markers', async () => {
    expect(await writtenAcceptance(['1. First', '2) Second', '10. [x] Third'])).toEqual(['First', 'Second', 'Third']);
  });

  // Why: bullet-looking lines inside a code block are example text, not criteria.
  it('keeps a fenced block inside an item as that item\'s text and never reads its bullets as items', async () => {
    expect(await writtenAcceptance([
      '- [ ] Output looks like:',
      '  ```',
      '- not an item',
      '  ```',
      '- [ ] Second',
    ])).toEqual(['Output looks like: ``` - not an item ```', 'Second']);
  });

  // Why: text that is neither an item nor a continuation cannot be parsed without guessing.
  it('refuses acceptance text that is not a list item or a continuation, naming the line', async () => {
    const created = await acceptanceOf(['- [ ] First', 'Stray paragraph.', '- [ ] Second']);
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('MISSING_FIELD');
    expect(created.message).toContain('Stray paragraph.');
    expect(created.message).toContain(`wiki/issues/${WK_ID}.md`);
  });

  // Why: an empty objective would hand the worker a handoff with no statement of the job.
  it('refuses a work item with a missing or empty Objective, naming the file and heading', async () => {
    for (const objective of [null, ['']]) {
      await rm(repo, { recursive: true, force: true });
      repo = await mkdtemp(join(tmpdir(), 'kb-slice-handoff-'));
      await setup(wkText(TWO_SLICES, { objective }));
      const created = await createHandoff(input());
      expect(created.ok).toBe(false);
      if (created.ok) continue;
      expect(created.error).toBe('MISSING_FIELD');
      expect(created.message).toContain(`wiki/issues/${WK_ID}.md`);
      expect(created.message).toContain('## Objective');
    }
  });

  // Why: wk decides the record written; a different work_item would be dropped without a word.
  it('refuses work_item that differs from wk, and accepts an equal one', async () => {
    await setup(wkText(TWO_SLICES));
    const differs = await createHandoff(input({ work_item: 'WK-0001' }));
    expect(differs.ok).toBe(false);
    if (!differs.ok) {
      expect(differs.error).toBe('INVALID_HANDOFF');
      expect(differs.message).toContain('WK-0001');
      expect(differs.message).toContain(WK_ID);
    }
    const same = await createHandoff(input({ work_item: WK_ID }));
    expect(same.ok).toBe(true);
  });

  it('refuses a work item with no Acceptance criteria section', async () => {
    await setup(wkText(TWO_SLICES, { acceptance: null }));
    const created = await createHandoff(input());
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('MISSING_FIELD');
    expect(created.message).toContain('## Acceptance criteria');
  });

  it('refuses a slice row with an empty validation cell', async () => {
    await setup(wkText(TWO_SLICES.replace('| npm test |', '| |')));
    const created = await createHandoff(input());
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('MISSING_FIELD');
    expect(created.message).toContain('empty validation cell');
  });

  it('refuses a malformed Slices table as PARSE_ERROR naming the work item file', async () => {
    await setup(wkText(TWO_SLICES.replace('| id | title |', '| id | name |')));
    const created = await createHandoff(input());
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('PARSE_ERROR');
    expect(created.message).toContain(`wiki/issues/${WK_ID}.md`);
  });

  it('refuses a wk that is not WK-NNNN', async () => {
    await setup(wkText(TWO_SLICES));
    for (const wk of ['WK-12', 'wk-0001', '../WK-9213']) {
      const created = await createHandoff(input({ wk }));
      expect(created.ok).toBe(false);
      if (created.ok) continue;
      expect(created.error).toBe('MISSING_FIELD');
      expect(created.message).toContain(wk);
    }
  });

  it('honours title and mode overrides over the row title and the implement default', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ title: 'Custom title', mode: 'code_review' }));
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data).toMatchObject({ title: 'Custom title', mode: 'code_review', write_scope: ['src/existing.ts', 'src/brand-new.ts'] });
  });

  it('carries a directory write_scope entry through and still refuses a root-aliasing row', async () => {
    await setup(wkText(TWO_SLICES.replace('src/other.ts |', 'src/ |')));
    const dirRow = await createHandoff(input({ slice: 's2' }));
    if (!dirRow.ok) throw new Error(dirRow.message);
    const parsed = await parseHandoff(dirRow.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.write_scope).toEqual(['src/']);
    expect(parsed.data.read_first).toEqual(['src/', `wiki/issues/${WK_ID}.md`]);

    await rm(repo, { recursive: true, force: true });
    repo = await mkdtemp(join(tmpdir(), 'kb-slice-handoff-'));
    await setup(wkText(TWO_SLICES.replace('src/other.ts |', './ |')));
    const rootRow = await createHandoff(input({ slice: 's2' }));
    expect(rootRow.ok).toBe(false);
    if (rootRow.ok) return;
    expect(rootRow.error).toBe('STALE_WRITE_SCOPE');
  });

  it('the CLI --wk and --slice flags write the handoff generated from the row', async () => {
    await setup(wkText(TWO_SLICES));
    execFileSync(TSX, [CLI, 'create-handoff', '--dir', repo, '--subject', 'kb:dispatch', '--allowed-agents', 'claude', '--wk', WK_ID, '--slice', 's2'], { cwd: ROOT, stdio: 'pipe' });
    const parsed = await parseHandoff(join(repo, 'wiki', 'handoffs', 'HO-0001.md'));
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data).toMatchObject({
      title: 'Second slice',
      work_item: WK_ID,
      slice: 's2',
      write_scope: ['src/other.ts'],
      validation: ['npm run typecheck'],
      acceptance: [expect.stringContaining('Only slice s2 (Second slice)'), 'The thing is done', 'The thing is tested'],
    });
  });

  it('the MCP create-handoff tool takes wk and slice and writes the handoff generated from the row', async () => {
    await setup(wkText(TWO_SLICES));
    const tool = tools.find((t) => t.name === 'create-handoff')!;
    const result = (await tool.handler({ dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: WK_ID, slice: 's2' })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const parsed = await parseHandoff(join(repo, 'wiki', 'handoffs', 'HO-0001.md'));
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data).toMatchObject({ work_item: WK_ID, slice: 's2', write_scope: ['src/other.ts'] });
  });

  // Why: a chained clone is cut from base_ref, so a row file only on main is invisible to the worker.
  it('leaves a row file that exists only on main out of read_first of a chained slice handoff', async () => {
    await setup(wkText(TWO_SLICES));
    git(repo, 'branch', 'dispatch/HO-0001');
    git(repo, 'checkout', '-q', 'dispatch/HO-0001');
    await writeRepoFile('src/on-branch.ts', 'export {};\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'branch file');
    git(repo, 'checkout', '-q', '-');
    git(repo, 'branch', '-f', 'dispatch/HO-0001', 'dispatch/HO-0001');
    await writeRepoFile('src/main-only.ts', 'export {};\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'main file');
    await writeRepoFile(`wiki/issues/${WK_ID}.md`, wkText(TWO_SLICES.replace('src/other.ts |', 'src/other.ts, src/main-only.ts, src/on-branch.ts |')));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'row');
    const created = await createHandoff(input({ slice: 's2', base_ref: 'dispatch/HO-0001' }));
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.read_first).toEqual(['src/other.ts', 'src/on-branch.ts', `wiki/issues/${WK_ID}.md`]);
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

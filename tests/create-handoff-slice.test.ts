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
import { FIXUP_FINDINGS_HEADING } from '../packages/dispatch-core/src/assemble.js';
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

const TWO_SLICE_TABLE = [
  '## Slices',
  '',
  '| id | title | write_scope | depends_on | validation | status |',
  '|----|-------|-------------|------------|------------|--------|',
  '| s1 | First slice | src/existing.ts, src/brand-new.ts | | npm test | todo |',
  '| s2 | Second slice | src/other.ts | s1 | npm run typecheck | todo |',
  '',
].join('\n');

/** One `### Slice <id>` section; a null acceptance omits the `#### Acceptance` heading. */
function sliceSection(id: string, task: string, acceptance: string[] | null): string {
  return [`### Slice ${id}`, '', task, '', ...(acceptance === null ? [] : ['#### Acceptance', '', ...acceptance, '']), ''].join('\n');
}

const S1_TASK = 'Build the S1 part: the parser.\n\nIt reads `input` (UTF-8): nothing else.';
const S1_ITEMS = ['S1 parses `input` (UTF-8): done', 'S1 is tested'];
const S2_TASK = 'Build the S2 part: the writer.';
const S2_ITEMS = ['S2 writes the output', 'S2 is tested'];

const TWO_SLICES = TWO_SLICE_TABLE
  + sliceSection('s1', S1_TASK, S1_ITEMS.map((item) => `- [ ] ${item}`))
  + sliceSection('s2', S2_TASK, S2_ITEMS.map((item) => `- [ ] ${item}`));

const ONE_ROW_TABLE = TWO_SLICE_TABLE.split('\n').filter((line) => !line.startsWith('| s2')).join('\n');

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
      acceptance: S2_ITEMS,
    });
    const content = await readFile(created.data.handoffPath, 'utf8');
    expect(content).toContain('Make the fixture do the thing.');
    expect(content).toContain(S2_TASK);
  });

  // Why: the worker of s1 built every function of the work item, so s2 had nothing left; the slice section is the task.
  it('writes the slice task, then the work item objective as context, and never another slice\'s task', async () => {
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
    expect(rest.join('\n\n')).toBe(`${S1_TASK}\n\nWork item objective, for context only:\nMake the fixture do the thing.`);
    expect(await readFile(created.data.handoffPath, 'utf8')).not.toContain(S2_TASK);
  });

  // Why: the worker had to guess which work item criteria belonged to its slice.
  it('writes exactly the slice\'s own acceptance items, none of the work item\'s or another slice\'s', async () => {
    await setup(wkText(TWO_SLICES));
    const created = await createHandoff(input({ slice: 's1' }));
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.acceptance).toEqual(S1_ITEMS);
  });

  // Why: a row holds no task text; with several rows nothing says which part of the work item the slice builds.
  it('refuses a slice with no section when the table has several rows, naming the file and the heading to write', async () => {
    await setup(wkText(TWO_SLICE_TABLE + sliceSection('s1', S1_TASK, ['- one'])));
    const created = await createHandoff(input({ slice: 's2' }));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('MISSING_FIELD');
    expect(created.message).toContain(`wiki/issues/${WK_ID}.md`);
    expect(created.message).toContain('### Slice s2');
    expect(created.message).toContain('#### Acceptance');
  });

  it('refuses a slice section with no Acceptance heading, an empty list, or empty task text', async () => {
    const cases: [string, string][] = [
      [sliceSection('s1', S1_TASK, null), '#### Acceptance'],
      [sliceSection('s1', S1_TASK, []), '#### Acceptance'],
      [sliceSection('s1', '', ['- one']), 'task text'],
    ];
    for (const [section, mention] of cases) {
      await rm(repo, { recursive: true, force: true });
      repo = await mkdtemp(join(tmpdir(), 'kb-slice-handoff-'));
      await setup(wkText(TWO_SLICE_TABLE + section + sliceSection('s2', S2_TASK, ['- two'])));
      const created = await createHandoff(input());
      expect(created.ok).toBe(false);
      if (created.ok) continue;
      expect(created.error).toBe('MISSING_FIELD');
      expect(created.message).toContain(`wiki/issues/${WK_ID}.md`);
      expect(created.message).toContain('### Slice s1');
      expect(created.message).toContain(mention);
    }
  });

  it('takes objective and acceptance from the work item when the table has one row and no section', async () => {
    await setup(wkText(ONE_ROW_TABLE));
    const created = await createHandoff(input({ slice: 's1' }));
    if (!created.ok) throw new Error(created.message);
    expect(await objectiveOf(created.data.handoffPath)).toBe('Make the fixture do the thing.');
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.acceptance).toEqual(['The thing is done', 'The thing is tested']);
  });

  it('prefers the slice section over the work item when the table has one row', async () => {
    await setup(wkText(ONE_ROW_TABLE + sliceSection('s1', S1_TASK, S1_ITEMS.map((item) => `- ${item}`))));
    const created = await createHandoff(input({ slice: 's1' }));
    if (!created.ok) throw new Error(created.message);
    expect(await objectiveOf(created.data.handoffPath)).toContain(S1_TASK);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.acceptance).toEqual(S1_ITEMS);
  });

  it('finds a slice section that sits after the Slices section, under another heading', async () => {
    const section = sliceSection('s1', S1_TASK, ['- one']) + sliceSection('s2', S2_TASK, ['- two']);
    await setup(wkText(`${TWO_SLICE_TABLE}## Design\n\nProse.\n\n${section}`));
    const created = await createHandoff(input({ slice: 's2' }));
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.acceptance).toEqual(['two']);
  });

  // Why: a slice title with YAML-significant characters must not break the frontmatter.
  it('round-trips a multi-paragraph objective and criteria with backticks, colons and parentheses', async () => {
    await setup(wkText(TWO_SLICES.replace('First slice', 'countWords `with` tests: (a, b)')));
    const created = await createHandoff(input({ slice: 's1' }));
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.title).toBe('countWords `with` tests: (a, b)');
    expect(parsed.data.acceptance).toEqual(S1_ITEMS);
    const objective = await objectiveOf(created.data.handoffPath);
    expect(objective).toContain('countWords `with` tests: (a, b)');
    expect(objective).toContain('It reads `input` (UTF-8): nothing else.');
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
    await setup(wkText(TWO_SLICE_TABLE + sliceSection('s1', S1_TASK, ['- one']) + sliceSection('s2', S2_TASK, lines)));
    return createHandoff(input({ slice: 's2' }));
  }

  async function writtenAcceptance(lines: string[]): Promise<string[]> {
    const created = await acceptanceOf(lines);
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.data.acceptance;
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
    expect(created.message).toContain('### Slice s2');
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
    await setup(wkText(ONE_ROW_TABLE, { acceptance: null }));
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
      acceptance: S2_ITEMS,
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

  // Why: a hand-specified implement handoff is the shape the slice rule removes; the CLI must refuse it, not write it.
  it('the CLI refuses an explicit implement handoff, naming the slice rule, and writes nothing', async () => {
    await setup(wkText(TWO_SLICES));
    const run = () => execFileSync(
      TSX,
      [CLI, 'create-handoff', '--dir', repo, '--subject', 'kb:dispatch', '--allowed-agents', 'claude', '--title', 'T', '--mode', 'implement', '--work-item', WK_ID, '--acceptance', 'a', '--validation', 'v'],
      { cwd: ROOT, stdio: 'pipe' },
    );
    expect(run).toThrow(/generated from a slice/);
    await expect(readFile(join(repo, 'wiki', 'handoffs', 'HO-0001.md'), 'utf8')).rejects.toThrow();
  });

  it('the CLI still writes an explicit redteam, research and explore_code handoff', async () => {
    await setup(wkText(TWO_SLICES));
    for (const [index, mode] of (['redteam', 'research', 'explore_code'] as const).entries()) {
      execFileSync(
        TSX,
        [CLI, 'create-handoff', '--dir', repo, '--subject', 'kb:dispatch', '--allowed-agents', 'claude', '--title', 'T', '--mode', mode, '--acceptance', 'a', '--validation', 'v'],
        { cwd: ROOT, stdio: 'pipe' },
      );
      const parsed = await parseHandoff(join(repo, 'wiki', 'handoffs', `HO-000${index + 1}.md`));
      if (!parsed.ok) throw new Error(parsed.message);
      expect(parsed.data.mode).toBe(mode);
    }
  });

  it('the MCP create-handoff tool refuses an explicit implement handoff and still takes the advisory modes', async () => {
    await setup(wkText(TWO_SLICES));
    const tool = tools.find((t) => t.name === 'create-handoff')!;
    const explicit = { dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], title: 'T', acceptance: ['a'], validation: ['v'] };
    const refused = (await tool.handler({ ...explicit, mode: 'implement', work_item: WK_ID })) as { ok: boolean; error?: string; message?: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('MISSING_FIELD');
    expect(refused.message).toContain('generated from a slice');
    for (const mode of ['redteam', 'research', 'explore_code']) {
      const written = (await tool.handler({ ...explicit, mode })) as { ok: boolean };
      expect(written.ok, mode).toBe(true);
    }
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

  // Why: a fix-up told "Build this slice only" under a findings section labelled context delivered nothing.
  it('writes a fix-up objective whose task is the findings, with the slice text as the standing spec', async () => {
    git(repo, 'branch', 'dispatch/HO-0001');
    const created = await createHandoff({
      dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: WK_ID, slice: 's1',
      base_ref: 'dispatch/HO-0001', fixup_context: 'F1: the parser drops digits',
    });
    if (!created.ok) throw new Error(created.message);
    const objective = await objectiveOf(created.data.handoffPath);
    const [lead, ...rest] = objective.split('\n\n');
    expect(lead).toContain('fix-up');
    expect(lead).toContain('s1');
    expect(lead).toContain('First slice');
    expect(lead).toContain(WK_ID);
    expect(lead).toContain('`dispatch/HO-0001`');
    expect(lead).toContain(
      `Your task is to fix what this handoff's \`fixup_context\` lists, shown to you under "${FIXUP_FINDINGS_HEADING}".`,
    );
    expect(lead).toContain('fails before the fix and passes after it');
    expect(objective).not.toContain('Build this slice only');
    expect(rest.join('\n\n')).toBe(
      `Slice text, the standing spec and not a to-do list:\n${S1_TASK}\n\nWork item objective, for context only:\nMake the fixture do the thing.`,
    );
    const parsed = await parseHandoff(created.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.acceptance).toEqual([
      ...S1_ITEMS,
      'Each finding in the findings section is fixed, with a test that fails before the fix and passes after it',
    ]);
  });

  it('writes the same objective and acceptance as a first build when fixup_context is blank', async () => {
    git(repo, 'branch', 'dispatch/HO-0001');
    const base = { dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: WK_ID, slice: 's1', base_ref: 'dispatch/HO-0001' };
    const plain = await createHandoff(base);
    const blank = await createHandoff({ ...base, fixup_context: ' \n ' });
    if (!plain.ok || !blank.ok) throw new Error('create failed');
    expect(await objectiveOf(blank.data.handoffPath)).toBe(await objectiveOf(plain.data.handoffPath));
    expect(await objectiveOf(plain.data.handoffPath)).toContain('Build this slice only');
    const parsed = await parseHandoff(blank.data.handoffPath);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.data.acceptance).toEqual(S1_ITEMS);
  });

  // Why: a fix-up repairs an earlier delivery; with no base_ref it would rebuild the slice from HEAD.
  it('refuses fixup_context without base_ref', async () => {
    const created = await createHandoff({
      dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: WK_ID, slice: 's1', fixup_context: 'F1: the parser drops digits',
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('INVALID_HANDOFF');
    expect(created.message).toContain('base_ref');
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

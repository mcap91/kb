import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generate } from '../packages/wiki-core/src/index.js';
import { readChainDoc, type ChainDocProblem } from '../packages/wiki-core/src/dashboard/chain-doc.js';
import { generateDashboard } from '../packages/wiki-core/src/dashboard/generate.js';
import {
  createBootstrappedRepo,
  createPlanningRepo,
  writeRecord,
  type TmpRepo,
} from './helpers/tmp-repo.js';

const ROOT = path.resolve(__dirname, '..');
const TSX = path.resolve(ROOT, 'node_modules/.bin/tsx');
const CLI = path.resolve(ROOT, 'packages/wiki-cli/src/index.ts');

const repos: TmpRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

async function planningRepo(name = 'me/proj'): Promise<TmpRepo> {
  const repo = await createPlanningRepo(name);
  repos.push(repo);
  return repo;
}

async function wikiOnlyRepo(): Promise<TmpRepo> {
  const repo = await createBootstrappedRepo('me/wiki');
  repos.push(repo);
  return repo;
}

function chain(dir: string, text: string): void {
  const target = path.join(dir, 'wiki', 'dashboard');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'chain.md'), text, 'utf-8');
}

function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), 'utf-8');
}

function element(html: string, marker: string, tag: string): string {
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const start = html.lastIndexOf(`<${tag}`, at);
  if (start < 0) return '';
  const gt = html.indexOf('>', start);
  let depth = 1;
  let i = gt + 1;
  while (depth > 0 && i < html.length) {
    const open = new RegExp(`<${tag}\\b`, 'g');
    open.lastIndex = i;
    const close = new RegExp(`</${tag}>`, 'g');
    close.lastIndex = i;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (!nextClose) break;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      i = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      i = nextClose.index + nextClose[0].length;
      if (depth === 0) return html.slice(start, i);
    }
  }
  return html.slice(start, i);
}

function section(html: string, marker: string): string {
  return element(html, marker, 'section');
}

function div(html: string, marker: string): string {
  return element(html, marker, 'div');
}

interface Row {
  id: string;
  status: string;
}

function rows(block: string): Row[] {
  return [...block.matchAll(/data-wk="([^"]+)" data-status="([^"]*)"/g)].map(m => ({
    id: m[1],
    status: m[2],
  }));
}

function boxRows(block: string): Row[] {
  return [...block.matchAll(/data-in="([^"]+)" data-status="([^"]*)"/g)].map(m => ({
    id: m[1],
    status: m[2],
  }));
}

function wkData(html: string): Record<string, any> {
  const match = /<script type="application\/json" data-wk-data>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('wk.html has no data script');
  return JSON.parse(match[1]) as Record<string, any>;
}

function listPages(dir: string): string[] {
  const root = path.join(dir, 'wiki', 'dashboard', 'generated');
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const abs = path.join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

// ---------------------------------------------------------------------------
// Spine, gate, determinism
// ---------------------------------------------------------------------------

describe('dashboard generate', () => {
  it('writes the five views and the dashboard pages', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    const result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.generated).toEqual([
      'wiki/catalog.md',
      'wiki/now.md',
      'wiki/inbox.md',
      'wiki/backlog.md',
      'wiki/archive.md',
    ]);
    // index, wk and the initiative's chain page; no critical path page without chain.md
    expect(result.data.dashboard).toEqual({ dir: 'wiki/dashboard/generated', pages: 3 });
    expect(fs.existsSync(path.join(repo.dir, 'wiki/dashboard/generated/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(repo.dir, 'wiki/dashboard/generated/wk.html'))).toBe(true);
    expect(fs.existsSync(path.join(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html'))).toBe(true);
    // Records open as their markdown files; no page per record.
    expect(fs.existsSync(path.join(repo.dir, 'wiki/dashboard/generated/records'))).toBe(false);
    expect(fs.existsSync(path.join(repo.dir, 'wiki/dashboard/generated/critical-path.html'))).toBe(false);
  });

  it('writes nothing under wiki/dashboard in a wiki-only repo', async () => {
    const repo = await wikiOnlyRepo();
    const marker = path.join(repo.dir, 'wiki/dashboard/generated');
    fs.mkdirSync(marker, { recursive: true });
    fs.writeFileSync(path.join(marker, 'keep.html'), 'keep me', 'utf-8');

    const result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dashboard).toBeUndefined();
    expect(fs.readFileSync(path.join(marker, 'keep.html'), 'utf-8')).toBe('keep me');
    expect(fs.existsSync(path.join(marker, 'index.html'))).toBe(false);
  });

  it('returns the planningInstalled failure and writes nothing with a broken contract', async () => {
    const repo = await wikiOnlyRepo();
    fs.writeFileSync(path.join(repo.dir, 'wiki/.wiki-contract.json'), '{not json', 'utf-8');
    const result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('PARSE_ERROR');
    expect(fs.existsSync(path.join(repo.dir, 'wiki/catalog.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo.dir, 'wiki/dashboard/generated'))).toBe(false);
  });

  it('fails when chain.md exists but cannot be read, and deletes nothing', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    const generated = path.join(repo.dir, 'wiki/dashboard/generated');
    fs.mkdirSync(generated, { recursive: true });
    const planted = path.join(generated, 'planted.html');
    fs.writeFileSync(planted, 'earlier run', 'utf-8');
    fs.mkdirSync(path.join(repo.dir, 'wiki/dashboard/chain.md'), { recursive: true });

    const result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('GENERATE_ERROR');
    expect(result.message).toContain('wiki/dashboard/chain.md');
    expect(fs.readFileSync(planted, 'utf-8')).toBe('earlier run');
    expect(fs.existsSync(path.join(generated, 'index.html'))).toBe(false);
  });

  it('names the repo from the contract and falls back to the directory base name', async () => {
    const withRepo = await planningRepo('org/name');
    writeRecord(withRepo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    await generate({ dir: withRepo.dir });
    expect(read(withRepo.dir, 'wiki/dashboard/generated/index.html')).toContain(
      '<h1>name · initiatives</h1>',
    );

    const noRepo = await planningRepo('org/other');
    const contractPath = path.join(noRepo.dir, 'wiki/.wiki-contract.json');
    const meta = JSON.parse(fs.readFileSync(contractPath, 'utf-8')) as Record<string, unknown>;
    delete meta.repo;
    fs.writeFileSync(contractPath, JSON.stringify(meta), 'utf-8');
    writeRecord(noRepo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    await generate({ dir: noRepo.dir });
    expect(read(noRepo.dir, 'wiki/dashboard/generated/index.html')).toContain(
      `<h1>${path.basename(noRepo.dir)} · initiatives</h1>`,
    );
  });

  it('fails when the contract exists but cannot be read', async () => {
    const repo = await planningRepo('org/name');
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    // A self-referential symlink is invisible to existsSync (so planningInstalled
    // falls through to wiki/.dispatch/) but readFileSync fails with ELOOP.
    const contractPath = path.join(repo.dir, 'wiki/.wiki-contract.json');
    fs.unlinkSync(contractPath);
    fs.symlinkSync(contractPath, contractPath);
    fs.mkdirSync(path.join(repo.dir, 'wiki/.dispatch'), { recursive: true });

    const result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('GENERATE_ERROR');
    expect(result.message).toContain('wiki/.wiki-contract.json');
  });

  it('is byte-identical across runs and never writes the absolute path', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'Alpha',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-02',
      initiative: 'IN-0001',
    });
    await generate({ dir: repo.dir });
    const first = new Map(listPages(repo.dir).map(rel => [rel, read(repo.dir, `wiki/dashboard/generated/${rel}`)]));
    await generate({ dir: repo.dir });
    const second = new Map(listPages(repo.dir).map(rel => [rel, read(repo.dir, `wiki/dashboard/generated/${rel}`)]));
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [rel, html] of second) {
      expect(html).toBe(first.get(rel));
      expect(html).not.toContain(repo.dir);
    }
  });
});

// ---------------------------------------------------------------------------
// index.html
// ---------------------------------------------------------------------------

describe('index.html', () => {
  it('puts every initiative in the right status box, in order', async () => {
    const repo = await planningRepo();
    const statuses: Array<[string, string]> = [
      ['IN-0001', 'in_progress'],
      ['IN-0002', 'review'],
      ['IN-0003', 'blocked'],
      ['IN-0004', 'todo'],
      ['IN-0005', 'inbox'],
      ['IN-0006', 'done'],
      ['IN-0007', 'cancelled'],
    ];
    for (const [id, status] of statuses) {
      writeRecord(repo.dir, `wiki/initiatives/${id}.md`, {
        id,
        title: id,
        status,
        type: 'initiative',
        updated: '2026-11-01',
      });
    }
    await generate({ dir: repo.dir });
    const html = read(repo.dir, 'wiki/dashboard/generated/index.html');
    const inProgress = section(html, 'data-box="in-progress"');
    const todo = section(html, 'data-box="todo"');
    const done = section(html, 'data-box="done"');
    expect(boxRows(inProgress).map(r => r.id)).toEqual(['IN-0001', 'IN-0002', 'IN-0003']);
    expect(boxRows(todo).map(r => r.id)).toEqual(['IN-0004', 'IN-0005']);
    expect(boxRows(done).map(r => r.id)).toEqual(['IN-0006', 'IN-0007']);
    expect(html.indexOf('data-box="in-progress"')).toBeLessThan(html.indexOf('data-box="todo"'));
    expect(html.indexOf('data-box="todo"')).toBeLessThan(html.indexOf('data-box="done"'));
    expect(html).toContain('data-legend');
    expect(html).not.toContain('<details');
    expect(inProgress).toContain('href="IN/IN-0001.html"');
    expect(inProgress).toMatch(/data-in="IN-0001" data-status="in_progress"/);
  });

  it('shows "none" in empty boxes', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    await generate({ dir: repo.dir });
    const html = read(repo.dir, 'wiki/dashboard/generated/index.html');
    expect(section(html, 'data-box="todo"')).toContain('none');
    expect(section(html, 'data-box="done"')).toContain('none');
  });

  it('links ../chain.md only when the file exists', async () => {
    const withChain = await planningRepo();
    writeRecord(withChain.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'todo',
      type: 'initiative',
      updated: '2026-11-01',
    });
    chain(withChain.dir, '---\nupdated: 2026-11-18\n---\n\n# Chain\n');
    await generate({ dir: withChain.dir });
    expect(read(withChain.dir, 'wiki/dashboard/generated/index.html')).toContain('href="../chain.md"');

    const withoutChain = await planningRepo();
    writeRecord(withoutChain.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'todo',
      type: 'initiative',
      updated: '2026-11-01',
    });
    await generate({ dir: withoutChain.dir });
    expect(read(withoutChain.dir, 'wiki/dashboard/generated/index.html')).not.toContain('../chain.md');
  });

  it('renders each critical path on its own page: stages, counts, gates and rows in file order', async () => {
    const repo = await planningRepo();
    for (const [id, status] of [
      ['WK-0001', 'todo'],
      ['WK-0002', 'in_progress'],
      ['WK-0003', 'done'],
    ] as Array<[string, string]>) {
      writeRecord(repo.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Title ${id}`,
        status,
        type: 'feature',
        updated: '2026-11-01',
      });
    }
    chain(
      repo.dir,
      `---
updated: 2026-11-18
---

# Chain

## Critical path one

### Group A

Gate: first gate
and the gate wraps

- WK-0001 a
- WK-0002 b
- WK-0003 c

### Group B

Gate: only gate

- not a work item id

## Critical path two

### Group C

- WK-0001 again
- WK-9999 missing
`,
    );
    await generate({ dir: repo.dir });
    const index = read(repo.dir, 'wiki/dashboard/generated/index.html');
    expect(index).not.toContain('data-critical-path');
    expect(index).toContain('href="critical-path.html"');
    const html = read(repo.dir, 'wiki/dashboard/generated/critical-path.html');
    const paths = [...html.matchAll(/data-critical-path data-heading="([^"]*)"/g)].map(m => m[1]);
    expect(paths).toEqual(['Critical path one', 'Critical path two']);

    const first = section(html, 'data-heading="Critical path one"');
    const groupA = div(first, 'data-stage data-name="Group A"');
    const groupB = div(first, 'data-stage data-name="Group B"');
    expect(groupA).toContain('data-open="2"');
    expect(groupA).toContain('data-total="3"');
    expect(groupA).toContain('data-gate');
    expect(groupA).toContain('first gate and the gate wraps');
    expect(rows(groupA).map(r => ({ ...r }))).toEqual([
      { id: 'WK-0001', status: 'todo' },
      { id: 'WK-0002', status: 'in_progress' },
      { id: 'WK-0003', status: 'done' },
    ]);
    expect(groupB).not.toContain('data-open');
    expect(groupB).not.toContain('data-total');
    expect(rows(groupB)).toEqual([]);
    expect(div(first, 'data-stage data-name="Group B"')).toContain('only gate');

    const second = section(html, 'data-heading="Critical path two"');
    expect(second).not.toContain('data-gate');
    expect(rows(second).map(r => r.id)).toEqual(['WK-0001', 'WK-9999']);
    expect(rows(second)[1].status).toBe('');
  });

  it('writes no critical path page and no link to it when chain.md has no critical path section', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'todo',
      type: 'initiative',
      updated: '2026-11-01',
    });
    chain(repo.dir, '---\nupdated: 2026-11-18\n---\n\n# Chain\n\n## IN-0001 — One\n');
    await generate({ dir: repo.dir });
    expect(read(repo.dir, 'wiki/dashboard/generated/index.html')).not.toContain('critical-path.html');
    expect(fs.existsSync(path.join(repo.dir, 'wiki/dashboard/generated/critical-path.html'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chain.md reader
// ---------------------------------------------------------------------------

describe('chain.md reader', () => {
  const opts = {
    workPrefix: 'WK',
    initiativePrefix: 'IN',
    workItemIds: new Set(['WK-0001']),
    initiativeIds: new Set(['IN-0001']),
  };

  it('reports nothing about a Loose section', () => {
    const { data, problems } = readChainDoc(
      `---
updated: 2026-11-18
---

# Chain

## IN-0001 — One

## Loose

### In Progress

- free text
`,
      opts,
    );
    expect(problems).toEqual([] as ChainDocProblem[]);
    // The free section's group does not attach to the initiative before it.
    expect(data.initiatives.get('IN-0001')?.groups).toEqual([]);
  });

  it('gives empty data and no problem for a missing file', () => {
    const { data, problems } = readChainDoc(undefined, opts);
    expect(problems).toEqual([]);
    expect(data.paths).toEqual([]);
    expect(data.initiatives.size).toBe(0);
  });

  it('reports the documented problems', () => {
    const { problems } = readChainDoc(
      `---
updated: nope
---

## Critical path one

### Group A

Gate: one
Gate: two

- not an id
- WK-9999

## IN-0001 — One

### Stage one

Gate: first
Gate: second

- plain text

## IN-0001 — again

### To Do

- WK-0001
`,
      { ...opts, workItemIds: new Set(['WK-0001']) },
    );
    const messages = problems.map((p: ChainDocProblem) => p.message);
    expect(messages).toContain('chain.md updated is missing or not a date');
    // One message per stage with two gates: the critical path group and the initiative stage.
    expect(messages.filter(m => m === 'stage has a second Gate: line; the first is used')).toHaveLength(2);
    // A list item with no work item id is free text in every chain, never a problem.
    expect(messages.some(m => m.includes('plain text') || m.includes('does not start'))).toBe(false);
    expect(messages).toContain('WK-9999 has no record');
    expect(messages).toContain('initiative IN-0001 has more than one section; the first is used');
  });
});

// ---------------------------------------------------------------------------
// IN/IN-XXXX.html
// ---------------------------------------------------------------------------

describe('chain.html', () => {
  async function nextBox(dir: string, initiative = 'IN-0001'): Promise<string> {
    await generate({ dir });
    return div(read(dir, `wiki/dashboard/generated/IN/${initiative}.html`), 'data-next');
  }

  it('takes the Next box from the chain stages in file order, each id once', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    for (const [id, status] of [
      ['WK-0001', 'todo'],
      ['WK-0002', 'in_progress'],
      ['WK-0003', 'done'],
      ['WK-0010', 'todo'],
    ] as Array<[string, string]>) {
      writeRecord(repo.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Title ${id}`,
        status,
        type: 'feature',
        updated: '2026-11-01',
        initiative: 'IN-0001',
      });
    }
    chain(
      repo.dir,
      `---
updated: 2026-11-18
---

## IN-0001 — One

### In Progress

1. WK-0002 first

### To Do

- WK-0001 second
- WK-0001 again
- WK-0003 done
- WK-0010

### Next

- WK-0003

### Later

- WK-0010

### Recently Done

- WK-0003
`,
    );
    const box = await nextBox(repo.dir);
    expect(box).toContain('data-next-source="chain"');
    expect(box).toMatch(/data-next-source="chain"/);
    // Every stage counts, in file order; a numbered item counts like a dash item; done is skipped.
    expect(rows(box).map(r => r.id)).toEqual(['WK-0002', 'WK-0001', 'WK-0010']);
    expect(box).toContain('the first open work items of the chain in chain.md, updated 2026-11-18');
  });

  it('cuts a long title to 70 characters with an ellipsis', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    const longTitle = 'A'.repeat(90);
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: longTitle,
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    chain(repo.dir, '---\nupdated: 2026-11-18\n---\n\n## IN-0001\n\n### To Do\n\n- WK-0001\n');
    const box = await nextBox(repo.dir);
    expect(box).toContain(`${'A'.repeat(69)}…`);
    expect(box).not.toContain('A'.repeat(70));
  });

  it('caps the queue at 7 and counts the rest, and skips done and closed ids', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    const lines = ['- WK-0009']; // done
    for (let i = 1; i <= 8; i++) {
      const id = `WK-${String(i).padStart(4, '0')}`;
      writeRecord(repo.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Title ${id}`,
        status: 'todo',
        type: 'feature',
        updated: '2026-11-01',
        initiative: 'IN-0001',
      });
      lines.push(`- ${id}`);
    }
    writeRecord(repo.dir, 'wiki/issues/WK-0010.md', {
      id: 'WK-0010',
      title: 'Ten',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    lines.push('- WK-0010');
    writeRecord(repo.dir, 'wiki/issues/WK-0009.md', {
      id: 'WK-0009',
      title: 'Done one',
      status: 'done',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    chain(repo.dir, `---\nupdated: 2026-11-18\n---\n\n## IN-0001\n\n### To Do\n\n${lines.join('\n')}\n`);
    const box = await nextBox(repo.dir);
    expect(rows(box)).toHaveLength(7);
    expect(rows(box).map(r => r.id)).toEqual([
      'WK-0001',
      'WK-0002',
      'WK-0003',
      'WK-0004',
      'WK-0005',
      'WK-0006',
      'WK-0007',
    ]);
    expect(box).toContain('data-next-more');
    expect(box).toContain('2 more on the chain');
    expect(box).not.toContain('WK-0009');
  });

  it('code-picks when the section has no stage line, and when every chain line is done', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    for (const [id, status, priority] of [
      ['WK-0001', 'todo', 'high'],
      ['WK-0002', 'in_progress', 'low'],
      ['WK-0003', 'done', 'critical'],
    ] as Array<[string, string, string]>) {
      writeRecord(repo.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Title ${id}`,
        status,
        priority,
        type: 'feature',
        updated: '2026-11-01',
        initiative: 'IN-0001',
      });
    }
    chain(repo.dir, '---\nupdated: 2026-11-18\n---\n\n## IN-0001\n\nProse only, no stage.\n');
    let box = await nextBox(repo.dir);
    expect(box).toContain('data-next-source="code"');
    expect(box).toContain('code-picked: chain.md has no chain for this initiative');
    expect(rows(box).map(r => r.id)).toEqual(['WK-0002', 'WK-0001']);

    chain(repo.dir, '---\nupdated: 2026-11-18\n---\n\n## IN-0001\n\n### To Do\n\n- WK-0003\n');
    box = await nextBox(repo.dir);
    expect(box).toContain('data-next-source="code"');
    expect(box).toContain('code-picked: every work item on the chain in chain.md is done or closed');
  });

  it('marks the Next box stale and says why', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-20',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    chain(repo.dir, '---\nupdated: 2026-11-10\n---\n\n## IN-0001\n\n### To Do\n\n- WK-0001\n');
    let box = await nextBox(repo.dir);
    expect(box).toContain('data-chain-stale');
    expect(box).toContain('newer records than chain.md: 1');

    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0002.md', {
      id: 'WK-0002',
      title: 'Two',
      status: 'done',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    // A done work item stays on a stage chain as progress: no mark when the dates agree.
    chain(repo.dir, '---\nupdated: 2026-11-18\n---\n\n## IN-0001\n\n### To Do\n\n- WK-0002\n- WK-0001\n');
    box = await nextBox(repo.dir);
    expect(box).not.toContain('data-chain-stale');

    chain(repo.dir, '# no frontmatter\n\n## IN-0001\n\n### To Do\n\n- WK-0001\n');
    box = await nextBox(repo.dir);
    expect(box).toContain('data-chain-stale');
    expect(box).toContain('no valid updated date');
  });

  it('moves a work item between status bands', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    await generate({ dir: repo.dir });
    let html = read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    expect(section(html, 'data-band="To do"')).toContain('WK-0001');
    expect(section(html, 'data-band="In progress"')).not.toContain('WK-0001');

    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'in_progress',
      type: 'feature',
      updated: '2026-11-02',
      initiative: 'IN-0001',
    });
    await generate({ dir: repo.dir });
    html = read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    expect(section(html, 'data-band="In progress"')).toContain('WK-0001');
    expect(section(html, 'data-band="To do"')).toBe('');
  });

  it('bands by milestone tags, hides closed items, and strips done and parked', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      tags: ['m1'],
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0002.md', {
      id: 'WK-0002',
      title: 'Two',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      tags: ['m2'],
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0003.md', {
      id: 'WK-0003',
      title: 'Three',
      status: 'done',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      tags: ['m1'],
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0004.md', {
      id: 'WK-0004',
      title: 'Four',
      status: 'parked',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      tags: ['m2'],
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0005.md', {
      id: 'WK-0005',
      title: 'Five',
      status: 'cancelled',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      tags: ['m1'],
    });
    await generate({ dir: repo.dir });
    const html = read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    const bands = [...html.matchAll(/data-band="([^"]*)"/g)].map(m => m[1]);
    expect(bands).toEqual(['m1', 'm2']);
    expect(section(html, 'data-band="m1"')).toContain('data-wk="WK-0001"');
    expect(section(html, 'data-band="m1"')).not.toContain('data-wk="WK-0002"');
    expect(section(html, 'data-band="m2"')).toContain('data-wk="WK-0002"');
    expect(section(html, 'data-strip="done"')).toContain('WK-0003');
    expect(section(html, 'data-strip="parked"')).toContain('WK-0004');
    expect(html).not.toContain('WK-0005');
  });

  it('renders a dependency cycle without hanging', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      depends_on: ['WK-0002'],
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0002.md', {
      id: 'WK-0002',
      title: 'Two',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      depends_on: ['WK-0001'],
    });
    const result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(true);
    const html = read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    expect(html).toContain('data-wk="WK-0001"');
    expect(html).toContain('data-wk="WK-0002"');
  });

  it('says when an initiative has no work items', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    await generate({ dir: repo.dir });
    expect(read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html')).toContain(
      'No work items name this initiative',
    );
  });
});

// ---------------------------------------------------------------------------
// wk.html
// ---------------------------------------------------------------------------

describe('wk.html', () => {
  it('holds every record and the neighbor groups', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      depends_on: ['WK-0002', 'WK-0003', 'WK-0009'],
      blocks: ['WK-0004'],
      related: ['WK-0005'],
    });
    for (const [id, status] of [
      ['WK-0002', 'done'],
      ['WK-0003', 'in_progress'],
      ['WK-0004', 'todo'],
      ['WK-0005', 'review'],
      ['WK-0006', 'todo'],
      ['WK-0007', 'todo'],
      ['WK-0008', 'todo'],
      ['WK-0009', 'cancelled'],
    ] as Array<[string, string]>) {
      writeRecord(repo.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Title ${id}`,
        status,
        type: 'feature',
        updated: '2026-11-01',
        initiative: 'IN-0001',
      });
    }
    // reverse edges: WK-0006 blocks WK-0001, WK-0007 depends_on WK-0001, WK-0008 related WK-0001
    writeRecord(repo.dir, 'wiki/issues/WK-0006.md', {
      id: 'WK-0006',
      title: 'Six',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      blocks: ['WK-0001'],
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0007.md', {
      id: 'WK-0007',
      title: 'Seven',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      depends_on: ['WK-0001'],
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0008.md', {
      id: 'WK-0008',
      title: 'Eight',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      related: ['WK-0001'],
    });

    await generate({ dir: repo.dir });
    const data = wkData(read(repo.dir, 'wiki/dashboard/generated/wk.html'));
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(['IN-0001', 'WK-0001', 'WK-0007', 'WK-0008']),
    );
    const entry = data['WK-0001'];
    expect(entry.initiative).toBe('IN-0001');
    expect(entry.priority).toBeNull();
    expect(entry.type).toBe('feature');
    expect(entry.neighbors.dependsOn).toEqual(['WK-0003', 'WK-0006', 'WK-0002']);
    expect(entry.neighbors.blocks).toEqual(['WK-0004', 'WK-0007']);
    expect(entry.neighbors.related).toEqual(['WK-0005', 'WK-0008']);
    for (const group of ['dependsOn', 'blocks', 'related', 'fill']) {
      expect(entry.neighbors[group].length).toBeLessThanOrEqual(5);
      expect(entry.neighbors[group]).not.toContain('WK-0001');
      expect(entry.neighbors[group]).not.toContain('WK-0009');
    }
    expect(data['IN-0001'].chain).toBe('IN/IN-0001.html');
  });

  it('fills from the same initiative when fewer than 5 neighbors exist', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    const ids = ['WK-0010', 'WK-0011', 'WK-0012', 'WK-0013', 'WK-0014', 'WK-0020'];
    for (const id of ids) {
      writeRecord(repo.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Title ${id}`,
        status: 'todo',
        type: 'feature',
        updated: '2026-11-01',
        initiative: 'IN-0001',
      });
    }
    writeRecord(repo.dir, 'wiki/issues/WK-0010.md', {
      id: 'WK-0010',
      title: 'Ten',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
      depends_on: ['WK-0011'],
    });
    await generate({ dir: repo.dir });
    const data = wkData(read(repo.dir, 'wiki/dashboard/generated/wk.html'));
    expect(data['WK-0010'].neighbors.dependsOn).toEqual(['WK-0011']);
    expect(data['WK-0010'].neighbors.fill).toEqual(['WK-0012', 'WK-0013', 'WK-0014', 'WK-0020']);
  });

  it('resolves the record hrefs and chain header link', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    await generate({ dir: repo.dir });
    const data = wkData(read(repo.dir, 'wiki/dashboard/generated/wk.html'));
    const wkPath = path.join(repo.dir, 'wiki/dashboard/generated/wk.html');
    // Both links open the record's markdown file.
    expect(data['WK-0001'].href).toBe('../../issues/WK-0001.md');
    expect(fs.existsSync(path.resolve(path.dirname(wkPath), data['WK-0001'].href))).toBe(true);

    const chainHtml = read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    const link = /<a href="([^"]+)">IN-0001 record<\/a>/.exec(chainHtml);
    expect(link).not.toBeNull();
    expect(link![1]).toBe('../../../initiatives/IN-0001.md');
    const chainPath = path.join(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    expect(fs.existsSync(path.resolve(path.dirname(chainPath), link![1]))).toBe(true);
  });

  it('escapes a hostile record title everywhere', async () => {
    const repo = await planningRepo();
    const title = 'Evil </script><b>x';
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title,
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title,
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    await generate({ dir: repo.dir });
    const index = read(repo.dir, 'wiki/dashboard/generated/index.html');
    const chainHtml = read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    const wk = read(repo.dir, 'wiki/dashboard/generated/wk.html');
    expect(index).toContain('&lt;/script&gt;&lt;b&gt;x');
    expect(chainHtml).toContain('&lt;/script&gt;&lt;b&gt;x');
    expect(index).not.toContain('<b>x');
    expect(chainHtml).not.toContain('<b>x');
    expect(wk).not.toContain('<b>x');
    expect(wkData(wk)['WK-0001'].title).toBe(title);
  });
});

// ---------------------------------------------------------------------------
// chain page drawn from the initiative's stages in chain.md
// ---------------------------------------------------------------------------

describe('chain.html stages', () => {
  it('draws the stages in file order with gates, lists open work items off the chain, and keeps no status band', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    for (const [id, status] of [
      ['WK-0001', 'done'],
      ['WK-0002', 'in_progress'],
      ['WK-0003', 'todo'],
      ['WK-0004', 'inbox'],
      ['WK-0005', 'cancelled'],
    ] as Array<[string, string]>) {
      writeRecord(repo.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Title ${id}`,
        status,
        type: 'feature',
        updated: '2026-11-01',
        initiative: 'IN-0001',
      });
    }
    chain(
      repo.dir,
      `---
updated: 2026-11-18
---

## IN-0001 — One

Free prose about the initiative.

### M2 second milestone

Gate: the second gate

- WK-0003 later in the file, first stage

### M1 first milestone

- WK-0001 done stays on the chain
- WK-0002 building
- not a work item line
`,
    );
    await generate({ dir: repo.dir });
    const html = read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    const chainSection = section(html, 'data-chain');
    const names = [...chainSection.matchAll(/data-stage data-name="([^"]*)"/g)].map(m => m[1]);
    // File order decides the stage order, not the stage name.
    expect(names).toEqual(['M2 second milestone', 'M1 first milestone']);
    const m2 = div(chainSection, 'data-name="M2 second milestone"');
    expect(m2).toContain('the second gate');
    expect(rows(m2)).toEqual([{ id: 'WK-0003', status: 'todo' }]);
    const m1 = div(chainSection, 'data-name="M1 first milestone"');
    expect(m1).not.toContain('data-gate');
    expect(rows(m1)).toEqual([
      { id: 'WK-0001', status: 'done' },
      { id: 'WK-0002', status: 'in_progress' },
    ]);
    expect(m1).toContain('data-open="1" data-total="2"');
    // An open work item no stage names is listed, so it can be placed.
    expect(rows(section(html, 'data-off-chain')).map(r => r.id)).toEqual(['WK-0004']);
    expect(html).not.toContain('data-band');
    expect(html).not.toContain('WK-0005');
    expect(rows(div(html, 'data-next')).map(r => r.id)).toEqual(['WK-0003', 'WK-0002']);
  });

  it('falls back to status bands for an initiative with no stage line', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    chain(repo.dir, '---\nupdated: 2026-11-18\n---\n\n## IN-0001 — One\n\nProse only.\n');
    await generate({ dir: repo.dir });
    const html = read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    expect(html).not.toContain('data-chain>');
    expect(html).not.toContain('data-off-chain');
    expect(section(html, 'data-band="To do"')).toContain('data-wk="WK-0001"');
  });
});

// ---------------------------------------------------------------------------
// owned folder
// ---------------------------------------------------------------------------

describe('owned folder', () => {
  it('removes files it did not write and the folder of a deleted initiative, and keeps hand files', async () => {
    const repo = await planningRepo();
    for (const id of ['IN-0001', 'IN-0002']) {
      writeRecord(repo.dir, `wiki/initiatives/${id}.md`, {
        id,
        title: id,
        status: 'in_progress',
        type: 'initiative',
        updated: '2026-11-01',
      });
    }
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    await generate({ dir: repo.dir });

    const generated = path.join(repo.dir, 'wiki/dashboard/generated');
    fs.writeFileSync(path.join(generated, 'stale.html'), 'stale', 'utf-8');
    fs.mkdirSync(path.join(generated, 'IN-0009'), { recursive: true });
    fs.writeFileSync(path.join(generated, 'IN-0009/chain.html'), 'stale', 'utf-8');
    fs.writeFileSync(path.join(repo.dir, 'wiki/dashboard/hand.html'), 'hand', 'utf-8');
    fs.mkdirSync(path.join(repo.dir, 'wiki/dashboard/IN-0001'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, 'wiki/dashboard/IN-0001/chain.html'), 'hand chain', 'utf-8');

    // Delete IN-0002's record, then regenerate.
    fs.rmSync(path.join(repo.dir, 'wiki/initiatives/IN-0002.md'));
    const result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(true);

    expect(fs.existsSync(path.join(generated, 'stale.html'))).toBe(false);
    // A leftover folder of the old per-initiative layout is removed too.
    expect(fs.existsSync(path.join(generated, 'IN-0009'))).toBe(false);
    expect(fs.existsSync(path.join(generated, 'IN/IN-0002.html'))).toBe(false);
    expect(fs.existsSync(path.join(generated, 'IN/IN-0001.html'))).toBe(true);
    expect(fs.readFileSync(path.join(repo.dir, 'wiki/dashboard/hand.html'), 'utf-8')).toBe('hand');
    expect(fs.readFileSync(path.join(repo.dir, 'wiki/dashboard/IN-0001/chain.html'), 'utf-8')).toBe(
      'hand chain',
    );
  });

  it('fails when wiki/dashboard/generated is a file or a symlink and leaves the target alone', async () => {
    const repo = await planningRepo();
    const dashboard = path.join(repo.dir, 'wiki', 'dashboard');
    fs.mkdirSync(dashboard, { recursive: true });
    const target = path.join(repo.dir, 'target-dir');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(dashboard, 'generated'));
    let result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('GENERATE_ERROR');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);

    fs.unlinkSync(path.join(dashboard, 'generated'));
    fs.writeFileSync(path.join(dashboard, 'generated'), 'a file', 'utf-8');
    result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('GENERATE_ERROR');
    expect(fs.readFileSync(path.join(dashboard, 'generated'), 'utf-8')).toBe('a file');
  });

  it('removes a symlink inside the folder without touching its target', async () => {
    const repo = await planningRepo();
    const dashboard = path.join(repo.dir, 'wiki', 'dashboard');
    const generated = path.join(dashboard, 'generated');
    fs.mkdirSync(generated, { recursive: true });
    const outside = path.join(repo.dir, 'outside.txt');
    fs.writeFileSync(outside, 'outside', 'utf-8');
    fs.symlinkSync(outside, path.join(generated, 'link.html'));
    await generate({ dir: repo.dir });
    expect(fs.existsSync(path.join(generated, 'link.html'))).toBe(false);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('outside');
  });

  it('reports an lstat error other than ENOENT instead of a mkdir failure', async () => {
    const repo = await wikiOnlyRepo();
    const dashboard = path.join(repo.dir, 'wiki/dashboard');
    fs.mkdirSync(dashboard, { recursive: true });
    // No execute permission on wiki/dashboard: lstat of the child fails with
    // EACCES while wiki/dashboard itself still lstats as a directory.
    fs.chmodSync(dashboard, 0o000);
    let result: ReturnType<typeof generateDashboard>;
    try {
      result = generateDashboard({
        targetDir: repo.dir,
        records: [],
        workItemPrefix: 'WK',
        initiativePrefix: 'IN',
        repoName: 'proj',
      });
    } finally {
      fs.chmodSync(dashboard, 0o755);
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('GENERATE_ERROR');
    expect(result.message).toContain('EACCES');
    expect(result.message).toContain('inspect');
    expect(result.message).not.toContain('Failed to create');
    expect((result.detail as NodeJS.ErrnoException).code).toBe('EACCES');
  });
});

// ---------------------------------------------------------------------------
// free text chain, docs, CLI
// ---------------------------------------------------------------------------

describe('robustness and surfaces', () => {
  it('renders all pages from a free-text chain.md with code-picked Next boxes', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    writeRecord(repo.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'One',
      status: 'in_progress',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
    chain(repo.dir, 'just free text\nwith no structure at all\n');
    const result = await generate({ dir: repo.dir });
    expect(result.ok).toBe(true);
    const html = read(repo.dir, 'wiki/dashboard/generated/IN/IN-0001.html');
    expect(html).toContain('data-next-source="code"');
  });

  it('documents the generated pages', () => {
    const dashboardDoc = fs.readFileSync(path.resolve('docs/dashboard.md'), 'utf-8');
    expect(dashboardDoc).toContain('Built-in pages');
    expect(dashboardDoc).toContain('wiki/dashboard/generated/index.html');
    const mcpDoc = fs.readFileSync(path.resolve('docs/mcp-tools.md'), 'utf-8');
    expect(mcpDoc).toMatch(/`generate`[^\n]*dashboard/i);
  });

  it('prints one CLI line with the folder and page count', async () => {
    const repo = await planningRepo();
    writeRecord(repo.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'One',
      status: 'in_progress',
      type: 'initiative',
      updated: '2026-11-01',
    });
    const out = execFileSync(TSX, [CLI, 'generate', '--dir', repo.dir], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(out).toContain('wiki/dashboard/generated/ (3 pages)');
  });
});

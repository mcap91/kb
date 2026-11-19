import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lint, sync } from '../packages/wiki-core/src/index.js';
import { chainIds, readChainDoc } from '../packages/wiki-core/src/dashboard/chain-doc.js';
import {
  createBootstrappedRepo,
  createPlanningRepo,
  writeRecord,
  type TmpRepo,
} from './helpers/tmp-repo.js';

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'contract/templates/chain-doc.md');

const repos: TmpRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

async function planningRepo(): Promise<TmpRepo> {
  const repo = await createPlanningRepo('me/proj');
  repos.push(repo);
  return repo;
}

function chain(dir: string, text: string): void {
  const target = path.join(dir, 'wiki', 'dashboard');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'chain.md'), text, 'utf-8');
}

function seed(dir: string): void {
  writeRecord(dir, 'wiki/initiatives/IN-0001.md', {
    id: 'IN-0001',
    title: 'One',
    status: 'in_progress',
    type: 'initiative',
    updated: '2026-11-01',
  });
  for (const id of ['WK-0001', 'WK-0002', 'WK-0003', 'WK-0004']) {
    writeRecord(dir, `wiki/issues/${id}.md`, {
      id,
      title: `Title ${id}`,
      status: 'todo',
      type: 'feature',
      updated: '2026-11-01',
      initiative: 'IN-0001',
    });
  }
}

async function chainWarnings(dir: string): Promise<string[]> {
  const result = await lint({ dir });
  expect(result.ok).toBe(true);
  if (!result.ok) return [];
  return result.data.diagnostics
    .filter(d => d.code === 'CHAIN_DOC_SHAPE')
    .map(d => {
      expect(d.file).toBe('wiki/dashboard/chain.md');
      expect(d.severity).toBe('warning');
      return d.message;
    });
}

describe('CHAIN_DOC_SHAPE', () => {
  it('reports one warning per problem, with the line number', async () => {
    const repo = await planningRepo();
    seed(repo.dir);
    chain(
      repo.dir,
      [
        '---', //                                    1
        'updated: someday', //                       2
        '---', //                                    3
        '', //                                       4
        '## IN-0009 — no such initiative', //        5
        '', //                                       6
        '## IN-0001 — One', //                       7
        '', //                                       8
        '### Stage one', //                          9
        'Gate: first', //                           10
        'Gate: second', //                          11
        '- WK-0001 known', //                       12
        '- WK-9999 unknown', //                     13
        '- a free text line', //                    14
        '', //                                      15
        '## IN-0001 — again', //                    16
        '',
        '## Later notes',
        '### Later',
        '- free text under a free heading',
      ].join('\n'),
    );
    expect((await chainWarnings(repo.dir)).sort()).toEqual(
      [
        'line 1: chain.md updated is missing or not a date',
        'line 5: initiative heading names IN-0009, which has no record',
        'line 11: stage has a second Gate: line; the first is used',
        'line 13: WK-9999 has no record',
        'line 16: initiative IN-0001 has more than one section; the first is used',
      ].sort(),
    );
  });

  it('reports nothing for a repo with no chain.md, and nothing in a wiki-only repo', async () => {
    const repo = await planningRepo();
    seed(repo.dir);
    expect(await chainWarnings(repo.dir)).toEqual([]);

    const wikiOnly = await createBootstrappedRepo('me/wiki');
    repos.push(wikiOnly);
    chain(wikiOnly.dir, 'updated: broken\n## IN-0009\n- WK-9999\n');
    expect(await chainWarnings(wikiOnly.dir)).toEqual([]);
  });

  it('returns the planning-layer failure when the contract stamp cannot be read', async () => {
    const repo = await planningRepo();
    fs.writeFileSync(path.join(repo.dir, 'wiki/.wiki-contract.json'), '{not json', 'utf-8');
    const result = await lint({ dir: repo.dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('wiki/.wiki-contract.json');
  });
});

describe('chain-doc template', () => {
  it('reads with no problem once its placeholders are real ids, and gives its stages and gates in file order', async () => {
    const repo = await planningRepo();
    seed(repo.dir);
    let n = 0;
    const text = fs
      .readFileSync(TEMPLATE, 'utf-8')
      .replace('{{date}}', '2026-11-18')
      .replace(/WK-XXXX/g, () => `WK-000${++n}`)
      .replace(/IN-XXXX/g, 'IN-0001');
    expect(n).toBeGreaterThan(1);
    chain(repo.dir, text);
    expect(await chainWarnings(repo.dir)).toEqual([]);

    const { data, problems } = readChainDoc(text, {
      workPrefix: 'WK',
      initiativePrefix: 'IN',
      workItemIds: new Set(['WK-0001', 'WK-0002', 'WK-0003', 'WK-0004']),
      initiativeIds: new Set(['IN-0001']),
    });
    expect(problems).toEqual([]);
    expect(data.paths).toHaveLength(1);
    expect(data.paths[0].groups[0].gate).toBeTruthy();
    expect(chainIds(data.paths[0])).toEqual(['WK-0001']);
    const section = data.initiatives.get('IN-0001');
    expect(section?.groups.map(g => g.ids)).toEqual([['WK-0002', 'WK-0003'], ['WK-0004']]);
    expect(section?.groups[0].gate).toBeTruthy();
    expect(section?.groups[1].gate).toBeUndefined();
  });

  it('carries no record id of a real wiki: only the placeholder shapes', () => {
    const text = fs.readFileSync(TEMPLATE, 'utf-8');
    expect(text.match(/\b[A-Z]{2,4}-\d+\b/g)).toBeNull();
  });

  it('ships with the planning layer: sync writes it byte-equal into a repo that lacks it', async () => {
    const repo = await planningRepo();
    const copy = path.join(repo.dir, 'wiki/templates/chain-doc.md');
    fs.rmSync(copy, { force: true });
    const result = await sync({ dir: repo.dir });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(copy).equals(fs.readFileSync(TEMPLATE))).toBe(true);
  });
});

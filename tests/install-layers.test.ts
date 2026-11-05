/**
 * WK-0261 s2/s3/s5: install layers, checked over the whole repo tree.
 *
 * Every case snapshots every file in the fixture (content hash per path), runs one
 * layer transition through the real commands (bootstrap, initPlanning, initDispatch,
 * sync), and asserts the exact set of files added, removed, and changed. A surface
 * that leaks into the wrong layer shows up as an unexpected path in the diff.
 *
 * The isolation grep (AC 1) runs over every file a wiki-only bootstrap wrote and is
 * shown to bite: a planted machinery reference fails it, and the revert passes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { bootstrap, sync, initPlanning } from '../packages/wiki-core/src/index.js';
import { initDispatch } from '../packages/dispatch-core/src/init-dispatch.js';
import { createTmpDir, readJson, type TmpRepo } from './helpers/tmp-repo.js';

const KB_ROOT = path.resolve(__dirname, '..');

/** Machinery references a wiki-only repo must not carry (AC 1 term list). */
const ISOLATION_TERMS: Array<[string, RegExp]> = [
  ['/planner', /\/planner/],
  ['/orchestrator', /\/orchestrator/],
  ['/overseer', /\/overseer/],
  ['install-roles', /install-roles/],
  ['/resolve', /\/resolve/],
  ['escalation', /escalation/i],
  ['kb-dispatch', /kb-dispatch/],
  ['wiki/handoffs', /wiki\/handoffs/],
  ['HO-', /HO-/],
  ['PLN', /\bPLN\b/],
  ['VAL', /\bVAL\b/],
  ['wiki/plans', /wiki\/plans/],
  ['wiki/value-reports', /wiki\/value-reports/],
];

/**
 * Files the isolation grep skips, each with its ruled reason.
 * - issue.md ships whole in every layer, scaffolding included (Resolutions row 4).
 * - .id-state.json is allocator state with one key per manifest type; PLN/VAL keys
 *   leave only when WK-0184 / WK-0096 remove the types (row 3: this WK gates
 *   emission, never type removal).
 */
const ISOLATION_EXCEPTIONS = new Set(['wiki/templates/issue.md', 'wiki/.id-state.json']);

const WIKI_TEMPLATES = ['area.md', 'decision.md', 'initiative.md', 'issue.md', 'source.md'];
const WIKI_DIRS = ['wiki/areas', 'wiki/decisions', 'wiki/initiatives', 'wiki/issues', 'wiki/sources'];
const PLANNING_FILES = [
  '.agents/skills/planner/SKILL.md',
  '.agents/skills/resolve/SKILL.md',
  '.claude/commands/planner.md',
  '.claude/skills/resolve/SKILL.md',
  'wiki/templates/escalation.md',
];
/** Dispatch-layer files, beyond the planning files that dispatch implies. */
const DISPATCH_FILES = [
  '.agents/skills/orchestrator/SKILL.md',
  '.agents/skills/overseer/SKILL.md',
  '.claude/commands/orchestrator.md',
  '.claude/commands/overseer.md',
  'wiki/templates/handoff.md',
];
/** Each role's repo copies, both byte-identical to contract/roles/<role>.md (row 14). */
const ROLE_COPIES: Record<string, string[]> = {
  planner: ['.claude/commands/planner.md', '.agents/skills/planner/SKILL.md'],
  orchestrator: ['.claude/commands/orchestrator.md', '.agents/skills/orchestrator/SKILL.md'],
  overseer: ['.claude/commands/overseer.md', '.agents/skills/overseer/SKILL.md'],
};

type Snapshot = Map<string, string>;

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, root, out);
    else out.push(path.relative(root, abs).replace(/\\/g, '/'));
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  walk(dir, dir, out);
  return out.sort();
}

function listDirs(dir: string, rel: string): string[] {
  const abs = path.join(dir, rel);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => `${rel}/${e.name}`)
    .sort();
}

function snapshot(dir: string): Snapshot {
  const snap: Snapshot = new Map();
  for (const rel of listFiles(dir)) {
    snap.set(rel, createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex'));
  }
  return snap;
}

function diff(before: Snapshot, after: Snapshot): { added: string[]; removed: string[]; changed: string[] } {
  const added = [...after.keys()].filter(k => !before.has(k)).sort();
  const removed = [...before.keys()].filter(k => !after.has(k)).sort();
  const changed = [...after.keys()].filter(k => before.has(k) && before.get(k) !== after.get(k)).sort();
  return { added, removed, changed };
}

function isolationViolations(dir: string): string[] {
  const violations: string[] = [];
  for (const rel of listFiles(dir)) {
    if (ISOLATION_EXCEPTIONS.has(rel)) continue;
    const content = fs.readFileSync(path.join(dir, rel), 'utf-8');
    for (const [term, re] of ISOLATION_TERMS) {
      if (re.test(content)) violations.push(`${rel}: ${term}`);
    }
  }
  return violations;
}

function mcpServers(dir: string): string[] {
  return Object.keys(readJson<{ mcpServers: Record<string, unknown> }>(dir, '.mcp.json').mcpServers).sort();
}

/** The YAML frontmatter keys of a markdown file (top-level `key:` lines only). */
function frontmatterKeys(file: string): string[] {
  const text = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return [];
  return match[1].split('\n').map(line => line.match(/^([a-z_-]+):/)?.[1]).filter((k): k is string => !!k);
}

function contractTemplate(name: string): Buffer {
  return fs.readFileSync(path.join(KB_ROOT, 'contract', 'templates', name));
}

async function syncOk(dir: string, check = false) {
  const result = await sync({ dir, check });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

describe('install layers over the whole repo tree (WK-0261)', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('AC 1: bootstrap alone writes the wiki layer only, and the isolation grep finds nothing', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/wiki-only' })).ok).toBe(true);

    expect(listDirs(tmp.dir, 'wiki')).toEqual([...WIKI_DIRS, 'wiki/templates'].sort());
    expect(fs.readdirSync(path.join(tmp.dir, 'wiki', 'templates')).sort()).toEqual(WIKI_TEMPLATES);
    expect(mcpServers(tmp.dir)).toEqual(['kb-wiki']);
    expect(fs.existsSync(path.join(tmp.dir, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.dir, '.agents'))).toBe(false);

    expect(isolationViolations(tmp.dir)).toEqual([]);
  });

  it('AC 1: the isolation grep bites — a planted reference fails it, the revert passes', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/wiki-only' })).ok).toBe(true);
    expect(isolationViolations(tmp.dir)).toEqual([]);

    const indexPath = path.join(tmp.dir, 'wiki', 'index.md');
    const original = fs.readFileSync(indexPath);
    fs.appendFileSync(indexPath, '\nRun `/planner` to scope work.\n');
    expect(isolationViolations(tmp.dir)).toEqual(['wiki/index.md: /planner']);

    fs.writeFileSync(indexPath, original);
    expect(isolationViolations(tmp.dir)).toEqual([]);
  });

  it('AC 1: a Codex bootstrap (--mcp-client codex) is isolated the same way', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/codex', mcpClient: 'codex' })).ok).toBe(true);
    expect(fs.readdirSync(path.join(tmp.dir, 'wiki', 'templates')).sort()).toEqual(WIKI_TEMPLATES);
    expect(isolationViolations(tmp.dir)).toEqual([]);
  });

  it('AC 2 + AC 6: init-planning adds exactly the planning files; --remove takes exactly them away, listed', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/planning' })).ok).toBe(true);
    const wikiOnly = snapshot(tmp.dir);

    expect(initPlanning({ dir: tmp.dir }).ok).toBe(true);
    const added = await syncOk(tmp.dir);
    const planning = snapshot(tmp.dir);

    const up = diff(wikiOnly, planning);
    expect(up.added).toEqual(PLANNING_FILES);
    expect(up.removed).toEqual([]);
    expect(up.changed).toEqual(['AGENTS.md', 'wiki/.wiki-contract.json']);
    expect(added.removed).toEqual([]);
    expect(fs.readFileSync(path.join(tmp.dir, 'wiki/templates/escalation.md')).equals(contractTemplate('escalation.md'))).toBe(true);

    expect(initPlanning({ dir: tmp.dir, remove: true }).ok).toBe(true);
    const removedRun = await syncOk(tmp.dir);
    const reverted = snapshot(tmp.dir);

    expect([...removedRun.removed].sort()).toEqual(PLANNING_FILES);
    const down = diff(wikiOnly, reverted);
    expect(down.added).toEqual([]);
    expect(down.removed).toEqual([]);
    // Only the stamp differs from the wiki-only state (lastSyncedAt, empty layers).
    expect(down.changed).toEqual(['wiki/.wiki-contract.json']);
    // Empty runtime folders may remain (git tracks no empty dir); no file does.
    expect(listFiles(tmp.dir).filter(p => p.startsWith('.claude/') || p.startsWith('.agents/'))).toEqual([]);
  });

  it('AC 3: init-dispatch adds the dispatch surfaces and, with no planning entry, the planning surfaces too', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/dispatch' })).ok).toBe(true);
    const wikiOnly = snapshot(tmp.dir);

    expect((await initDispatch({ dir: tmp.dir })).ok).toBe(true);
    await syncOk(tmp.dir);
    const full = snapshot(tmp.dir);

    const up = diff(wikiOnly, full);
    const dispatchConfig = up.added.filter(p => p.startsWith('wiki/.dispatch/'));
    expect(dispatchConfig.length).toBeGreaterThan(0);
    expect(up.added.filter(p => !p.startsWith('wiki/.dispatch/'))).toEqual(
      [...PLANNING_FILES, ...DISPATCH_FILES].sort(),
    );
    expect(up.removed).toEqual([]);
    expect(up.changed).toEqual(['.mcp.json', 'AGENTS.md', 'wiki/.wiki-contract.json']);
    expect(fs.existsSync(path.join(tmp.dir, 'wiki/handoffs'))).toBe(true);
    expect(mcpServers(tmp.dir)).toEqual(['kb-dispatch', 'kb-wiki']);

    const layers = readJson<{ layers?: string[] }>(tmp.dir, 'wiki/.wiki-contract.json').layers ?? [];
    expect(layers).not.toContain('planning');
  });

  it('dispatch revert: moving wiki/.dispatch/ aside and syncing removes the dispatch and planning files, keeps wiki/handoffs/', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/dispatch-revert' })).ok).toBe(true);
    expect((await initDispatch({ dir: tmp.dir })).ok).toBe(true);
    await syncOk(tmp.dir);
    fs.writeFileSync(path.join(tmp.dir, 'wiki/handoffs/HO-0001.md'), '# HO-0001\n');

    fs.renameSync(path.join(tmp.dir, 'wiki/.dispatch'), path.join(tmp.dir, 'dispatch-config-aside'));
    const asideBefore = snapshot(path.join(tmp.dir, 'dispatch-config-aside'));
    const result = await syncOk(tmp.dir);

    expect([...result.removed].sort()).toEqual([...PLANNING_FILES, ...DISPATCH_FILES].sort());
    expect(fs.readFileSync(path.join(tmp.dir, 'wiki/handoffs/HO-0001.md'), 'utf-8')).toBe('# HO-0001\n');
    expect(mcpServers(tmp.dir)).toEqual(['kb-wiki']);
    expect(snapshot(path.join(tmp.dir, 'dispatch-config-aside'))).toEqual(asideBefore);
  });

  it('AC 2-3 + row 14: role copies are byte-identical to contract/roles/, carry name + description, and a hand edit is restored', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/roles' })).ok).toBe(true);
    expect((await initDispatch({ dir: tmp.dir })).ok).toBe(true);
    await syncOk(tmp.dir);

    for (const [role, copies] of Object.entries(ROLE_COPIES)) {
      const src = fs.readFileSync(path.join(KB_ROOT, 'contract', 'roles', `${role}.md`));
      for (const rel of copies) {
        expect(fs.readFileSync(path.join(tmp.dir, rel)).equals(src), rel).toBe(true);
      }
    }
    for (const skill of ['planner', 'orchestrator', 'overseer', 'resolve']) {
      const keys = frontmatterKeys(path.join(tmp.dir, '.agents', 'skills', skill, 'SKILL.md'));
      expect(keys, skill).toContain('name');
      expect(keys, skill).toContain('description');
    }

    const planner = path.join(tmp.dir, '.claude', 'commands', 'planner.md');
    fs.appendFileSync(planner, '\nLocal edit.\n');
    const result = await syncOk(tmp.dir);
    expect(result.synced).toContain('.claude/commands/planner.md');
    expect(fs.readFileSync(planner).equals(fs.readFileSync(path.join(KB_ROOT, 'contract/roles/planner.md')))).toBe(true);
  });

  it('AC 4: on an already-synced repo, sync removes only unedited kb-owned copies of no-layer templates', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/legacy' })).ok).toBe(true);

    // The pre-WK-0261 shape: no-layer templates synced in, record dirs holding records.
    const templates = path.join(tmp.dir, 'wiki', 'templates');
    fs.writeFileSync(path.join(templates, 'chain-doc.md'), contractTemplate('chain-doc.md'));
    fs.writeFileSync(path.join(templates, 'plan-execution-tracker.md'), contractTemplate('plan-execution-tracker.md'));
    // A CRLF checkout of an unedited copy is still kb-owned (EOL-normalized match).
    fs.writeFileSync(
      path.join(templates, 'plan.md'),
      contractTemplate('plan.md').toString('utf-8').replace(/\r?\n/g, '\r\n'),
    );
    // A known name with consumer-edited content is kept and reported.
    fs.writeFileSync(path.join(templates, 'value.md'), `${contractTemplate('value.md').toString('utf-8')}\nOur own notes.\n`);
    // A template kb never shipped is not kb's to touch.
    fs.writeFileSync(path.join(templates, 'my-template.md'), '# Ours\n');
    for (const [rel, body] of [
      ['wiki/plans/PLN-0001.md', '# PLN-0001\n'],
      ['wiki/value-reports/VAL-0001.md', '# VAL-0001\n'],
      ['wiki/handoffs/HO-0001.md', '# HO-0001\n'],
      ['wiki/issues/WK-0001.md', '# WK-0001\n'],
    ]) {
      fs.mkdirSync(path.dirname(path.join(tmp.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp.dir, rel), body);
    }

    const before = snapshot(tmp.dir);
    const expectedRemoved = [
      'wiki/templates/chain-doc.md',
      'wiki/templates/plan-execution-tracker.md',
      'wiki/templates/plan.md',
    ];

    // --check lists the removals and deletes nothing.
    const checked = await syncOk(tmp.dir, true);
    expect([...checked.removed].sort()).toEqual(expectedRemoved);
    expect(snapshot(tmp.dir)).toEqual(before);

    const result = await syncOk(tmp.dir);
    expect([...result.removed].sort()).toEqual(expectedRemoved);
    expect(result.warnings.some(w => w.startsWith('wiki/templates/value.md '))).toBe(true);

    const after = diff(before, snapshot(tmp.dir));
    expect(after.removed).toEqual(expectedRemoved);
    expect(after.added).toEqual([]);
    // The allocator state reconciles to the planted records; nothing else changes.
    expect(after.changed).toEqual(['wiki/.id-state.json', 'wiki/.wiki-contract.json']);
  });
});

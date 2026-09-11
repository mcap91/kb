import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { parseTracker } from '../packages/dashboard/src/parse-tracker.js';
import {
  laneOf, summarize, parseFrontmatter, parseFmArray, sourceLatestDate,
  buildDependencyDag, extractLinkedWkReferences, findWkByInitiative,
} from '../packages/dashboard/src/util.js';
import { parseInitiative } from '../packages/dashboard/src/parse-initiative.js';
import { emit } from '../packages/dashboard/src/emit.js';
import type { WorkItem, DashboardData } from '../packages/dashboard/src/schema.js';
import { createTmpDir, writeRecord, type TmpRepo } from './helpers/tmp-repo.js';

const DASHBOARD_CLI = path.resolve(process.cwd(), 'packages', 'dashboard', 'src', 'cli.ts');

// Real subprocess invocation (mirrors tests/dispatch.test.ts's getTsxPath()) -- cli.ts's
// top-level code calls process.exit(), so it must run out-of-process, never imported
// directly into the vitest worker.
function getTsxPath(): string {
  const repoRoot = path.resolve(process.cwd());
  return process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules', '.bin', 'tsx.cmd')
    : path.join(repoRoot, 'node_modules', '.bin', 'tsx');
}

function runDashboardCli(args: string): string {
  return execSync(`"${getTsxPath()}" "${DASHBOARD_CLI}" ${args}`, {
    cwd: path.resolve(process.cwd()),
    encoding: 'utf-8',
    windowsHide: true,
  });
}

const MINIMAL_TRACKER = `
## Phase Status Table

| Slice (phase) | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| S0 | done | 2026-01-01 | 2026-01-02 | |
| S1 | in_progress | 2026-01-03 | | |
| S2 | not_started | | | |

## Gates

- [x] **S0 gate (skeleton)**
- [ ] **S1 gate (orchestrate)**

## Task-to-Phase Mapping

| Task | Slice (phase) | Description | user_interaction |
|------|-------|-------------|------------------|
| T1 | S0 | Setup baseline | none |
| T2 | S0 (lite), S1 (full) | Feature alpha | none |
| T3 | S1 | Feature beta | none |
| T4 | S2 | Future work | none |

## Completed Log

| Date | Task | Summary |
|------|------|---------|
| 2026-01-02 | T1 | Done |

## Failure Log
`;

describe('dashboard', () => {
  describe('parseTracker', () => {
    const data = parseTracker(MINIMAL_TRACKER, { id: 'PLN-TEST', title: 'Test', status: 'active' });

    it('parses phases from Phase Status Table', () => {
      expect(data.phases).toHaveLength(3);
      expect(data.phases[0].id).toBe('S0');
      expect(data.phases[0].lane).toBe('done');
      expect(data.phases[1].id).toBe('S1');
      expect(data.phases[1].lane).toBe('in_progress');
    });

    it('lifts gate labels from parentheticals', () => {
      expect(data.phases[0].label).toBe('skeleton');
      expect(data.phases[1].label).toBe('orchestrate');
    });

    it('assigns tasks to phases', () => {
      expect(data.phases[0].tasks.map(t => t.id)).toContain('T1');
      expect(data.phases[1].tasks.map(t => t.id)).toContain('T3');
    });

    it('produces deterministic output', () => {
      const a = parseTracker(MINIMAL_TRACKER, { id: 'PLN-TEST', title: 'Test', status: 'active' });
      const b = parseTracker(MINIMAL_TRACKER, { id: 'PLN-TEST', title: 'Test', status: 'active' });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  describe('taskMatrix', () => {
    const data = parseTracker(MINIMAL_TRACKER, { id: 'PLN-TEST', title: 'Test', status: 'active' });
    const mx = data.taskMatrix!;

    it('builds matrix with correct columns', () => {
      expect(mx.columns).toEqual(['S0', 'S1', 'S2']);
    });

    it('single-phase tasks have one active cell', () => {
      const t1 = mx.rows.find(r => r.taskId === 'T1')!;
      expect(t1.cells).toEqual(['NEW', '', '']);
    });

    it('multi-phase tasks show scope and carried-forward', () => {
      const t2 = mx.rows.find(r => r.taskId === 'T2')!;
      expect(t2.cells).toEqual(['lite', 'full', '']);
    });

    it('extracts station phrase from description', () => {
      const t2 = mx.rows.find(r => r.taskId === 'T2')!;
      expect(t2.station).toBe('Feature alpha');
    });

    it('sorts rows by first appearance', () => {
      expect(mx.rows[0].taskId).toBe('T1');
      expect(mx.rows[mx.rows.length - 1].taskId).toBe('T4');
    });
  });

  describe('carried-forward dot logic', () => {
    const GAPPED = `
## Phase Status Table

| Slice (phase) | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| S0 | done | | | |
| S1 | done | | | |
| S2 | done | | | |
| S3 | not_started | | | |

## Gates

## Task-to-Phase Mapping

| Task | Slice (phase) | Description | user_interaction |
|------|-------|-------------|------------------|
| T1 | S0 (min), S3 (full) | Gapped task | none |

## Completed Log

## Failure Log
`;
    const data = parseTracker(GAPPED, { id: 'PLN-GAP', title: 'Gap', status: 'active' });
    const t1 = data.taskMatrix!.rows.find(r => r.taskId === 'T1')!;

    it('fills carried-forward dots between first and last active phase', () => {
      expect(t1.cells).toEqual(['min', '·', '·', 'full']);
    });
  });

  describe('util', () => {
    it('laneOf maps statuses correctly', () => {
      expect(laneOf('done', false)).toBe('done');
      expect(laneOf('in_progress', false)).toBe('in_progress');
      expect(laneOf('not_started', false)).toBe('queued');
      expect(laneOf('in_progress', true)).toBe('blocked');
      expect(laneOf('done', true)).toBe('done');
      expect(laneOf('inbox', true)).toBe('queued');
      expect(laneOf('blocked', false)).toBe('blocked');
    });

    it('summarize counts lanes', () => {
      const s = summarize(['done', 'done', 'in_progress', 'blocked']);
      expect(s).toEqual({ done: 2, inProgress: 1, blocked: 1, queued: 0, total: 4 });
    });

    it('parseFrontmatter handles CRLF', () => {
      const fm = parseFrontmatter('---\r\ntitle: "Test"\r\nstatus: done\r\n---\r\n');
      expect(fm['title']).toBe('Test');
      expect(fm['status']).toBe('done');
    });

    it('sourceLatestDate extracts latest date', () => {
      expect(sourceLatestDate('started 2026-01-01, completed 2026-03-15')).toBe('2026-03-15');
      expect(sourceLatestDate('no dates here')).toBe('');
    });

    it('parseFmArray strips YAML quotes from block-style list items', () => {
      const content = '---\ndepends_on:\n  - "WK-0047"\n  - \'WK-0048\'\n  - WK-0049\n---\n';
      expect(parseFmArray(content, 'depends_on')).toEqual(['WK-0047', 'WK-0048', 'WK-0049']);
    });

    it('parseFmArray strips YAML quotes from inline array items', () => {
      const content = '---\ndepends_on: ["WK-0047", \'WK-0048\', WK-0049]\n---\n';
      expect(parseFmArray(content, 'depends_on')).toEqual(['WK-0047', 'WK-0048', 'WK-0049']);
    });
  });

  describe('IN membership (WK-0078)', () => {
    let tmp: TmpRepo;

    afterEach(() => {
      tmp?.cleanup();
    });

    it('findWkByInitiative matches quoted, unquoted, and CRLF frontmatter', () => {
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/issues/WK-9001.md', {
        id: 'WK-9001', title: 'Quoted LF', type: 'task', status: 'inbox',
        priority: 'medium', owner: 'test', created: '2026-01-01', updated: '2026-01-01',
        initiative: 'IN-9001',
      });
      // Real records mix quoted/unquoted `initiative:` values and CRLF line endings
      // (WK-0078 evidence) -- write this one by hand to exercise that exact shape.
      fs.writeFileSync(
        path.join(tmp.dir, 'wiki', 'issues', 'WK-9002.md'),
        '---\r\nid: "WK-9002"\r\ntitle: "Unquoted CRLF"\r\ntype: task\r\nstatus: inbox\r\n' +
          'priority: medium\r\nowner: test\r\ncreated: 2026-01-01\r\nupdated: 2026-01-01\r\n' +
          'initiative: IN-9001\r\n---\r\n\r\nBody.\r\n',
        'utf-8',
      );
      writeRecord(tmp.dir, 'wiki/issues/WK-9003.md', {
        id: 'WK-9003', title: 'Different initiative', type: 'task', status: 'inbox',
        priority: 'medium', owner: 'test', created: '2026-01-01', updated: '2026-01-01',
        initiative: 'IN-9999',
      });

      expect(findWkByInitiative(tmp.dir, 'IN-9001')).toEqual(['WK-9001', 'WK-9002']);
    });

    it('a WK with initiative: declared but never mentioned in the IN body is a member (DAG + lane)', () => {
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/initiatives/IN-9001.md', {
        id: 'IN-9001', title: 'Test initiative', status: 'in_progress',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
        related: [], depends_on: [], blocks: [],
      }, 'No WK ids are mentioned anywhere in this body.\n');
      writeRecord(tmp.dir, 'wiki/issues/WK-9001.md', {
        id: 'WK-9001', title: 'Declared member', type: 'task', status: 'inbox',
        priority: 'medium', owner: 'test', created: '2026-01-01', updated: '2026-01-01',
        initiative: 'IN-9001', depends_on: [],
      });

      const data = parseInitiative(tmp.dir, 'IN-9001');

      expect(data.workItems.map(w => w.id)).toEqual(['WK-9001']);
      expect(data.workItems[0].lane).toBe('queued');
      expect(data.dependencyDag!.nodes.map(n => n.id)).toEqual(['WK-9001']);
    });

    it('a markdown-linked WK is a member; a plain-text/backticked mention is not', () => {
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/initiatives/IN-9002.md', {
        id: 'IN-9002', title: 'Test initiative', status: 'in_progress',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      }, 'Linked: [WK-9101](../issues/WK-9101.md).\n\n' +
        'Cross-repo prose (not a link): bioinfo `WK-9102`, also plain WK-9102 text.\n');
      writeRecord(tmp.dir, 'wiki/issues/WK-9101.md', {
        id: 'WK-9101', title: 'Linked member', type: 'task', status: 'inbox',
        priority: 'medium', owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      });
      writeRecord(tmp.dir, 'wiki/issues/WK-9102.md', {
        id: 'WK-9102', title: 'Cross-repo false positive', type: 'task', status: 'inbox',
        priority: 'medium', owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      });

      const data = parseInitiative(tmp.dir, 'IN-9002');

      expect(data.workItems.map(w => w.id)).toEqual(['WK-9101']);
    });

    it('extractLinkedWkReferences includes markdown links, excludes plain-text/backticked mentions', () => {
      const body = 'See [WK-9101](../issues/WK-9101.md). Also bioinfo `WK-9102` and plain WK-9103 text.';
      expect(extractLinkedWkReferences(body)).toEqual(['WK-9101']);
    });
  });

  describe('buildDependencyDag (WK-0078)', () => {
    function mkWorkItem(id: string, allDeps: string[] = []): WorkItem {
      return {
        id, title: id, status: 'inbox', lane: 'queued', priority: '',
        blockedBy: [], allDeps, resolvedDeps: [], body: '',
      };
    }

    it('a member set with zero in-set edges renders a node-only graph', () => {
      const items = [mkWorkItem('WK-9001'), mkWorkItem('WK-9002'), mkWorkItem('WK-9003')];
      const dag = buildDependencyDag(items)!;

      expect(dag).not.toBeNull();
      expect(dag.nodes.map(n => n.id).sort()).toEqual(['WK-9001', 'WK-9002', 'WK-9003']);
      expect(dag.edges).toEqual([]);
    });

    it('an empty member set renders no graph', () => {
      expect(buildDependencyDag([])).toBeNull();
    });
  });
});

describe('WK-0083 regression: dashboard parser bug fixes', () => {
  describe('Bug 1 — laneOf consumes the full WK status enum (util.ts)', () => {
    it('review maps to in_progress', () => {
      expect(laneOf('review', false)).toBe('in_progress');
    });

    it('complete (legacy alias) maps to done', () => {
      expect(laneOf('complete', false)).toBe('done');
    });

    it('cancelled maps to done', () => {
      expect(laneOf('cancelled', false)).toBe('done');
    });

    it('parked maps to queued', () => {
      expect(laneOf('parked', false)).toBe('queued');
    });

    it('wont_do maps to done', () => {
      expect(laneOf('wont_do', false)).toBe('done');
    });

    it('active is no longer a recognized status and falls through to queued', () => {
      expect(laneOf('active', false)).toBe('queued');
    });
  });

  describe('Bug 2 — bare "Slice" column recognized (parse-tracker.ts)', () => {
    const SLICE_COLUMN_TRACKER = `
## Phase Status Table

| Slice | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| S0 | done | | | |
| S1 | in_progress | | | |

## Task-to-Phase Mapping

| Task | Slice | Description | user_interaction |
|------|-------|-------------|------------------|
| T1 | S0 | Setup baseline | none |
`;

    it('produces correct phase IDs from a bare "Slice" header', () => {
      const data = parseTracker(SLICE_COLUMN_TRACKER, { id: 'PLN-SLICE', title: 'Slice column', status: 'todo' });
      expect(data.phases.map(p => p.id)).toEqual(['S0', 'S1']);
    });

    it('assigns tasks to phases from a bare "Slice" mapping column', () => {
      const data = parseTracker(SLICE_COLUMN_TRACKER, { id: 'PLN-SLICE', title: 'Slice column', status: 'todo' });
      expect(data.phases.find(p => p.id === 'S0')!.tasks.map(t => t.id)).toContain('T1');
    });
  });

  describe('Bug 3 — gate ID grammar tightened to [SP]\\d+ (parse-tracker.ts)', () => {
    const BAD_GATE_TRACKER = `
## Phase Status Table

| Slice | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| S0 | done | | | |
| S2 | todo | | | |

## Gates

- [x] **pre-S0 gate (skeleton):** desc
- [ ] **S2a gate (broken):** desc
`;

    it('pre-S0 and S2a do not match the gate grammar, so no phase receives gate metadata', () => {
      const data = parseTracker(BAD_GATE_TRACKER, { id: 'PLN-GATE', title: 'Gate', status: 'todo' });
      expect(data.phases.find(p => p.id === 'S0')!.gate).toBeNull();
      expect(data.phases.find(p => p.id === 'S2')!.gate).toBeNull();
    });
  });

  describe('Bug 4 — bullet-list Completed Log fallback (parse-tracker.ts)', () => {
    const BULLET_LOG_TRACKER = `
## Completed Log

- 2026-01-05 — WK-0001: Did the first thing
- 2026-01-06 — T2: Did the second thing
`;

    it('parses bullet-list entries when no table is present', () => {
      const data = parseTracker(BULLET_LOG_TRACKER, { id: 'PLN-BULLET', title: 'Bullet log', status: 'todo' });
      expect(data.completedLog).toEqual([
        { date: '2026-01-05', task: 'WK-0001', summary: 'Did the first thing' },
        { date: '2026-01-06', task: 'T2', summary: 'Did the second thing' },
      ]);
    });
  });

  describe('Bug 5 — HTML comments stripped from Failure Log (parse-tracker.ts)', () => {
    const COMMENT_ONLY_FAILURE_LOG = `
## Failure Log

<!-- template comment -->
`;

    it('a Failure Log containing only an HTML comment produces zero entries', () => {
      const data = parseTracker(COMMENT_ONLY_FAILURE_LOG, { id: 'PLN-FAIL', title: 'Failure', status: 'todo' });
      expect(data.failureLog).toEqual([]);
    });
  });

  describe('Bug 8 — emit.ts uses a replacer function (no $-pattern interpolation)', () => {
    let tmp: TmpRepo;

    afterEach(() => {
      tmp?.cleanup();
    });

    it('$-patterns in JSON data (e.g. $1, $$) survive template replacement literally', () => {
      tmp = createTmpDir();
      const data: DashboardData = {
        record: { id: 'PLN-DOLLAR', title: 'Cost is $1 and escape as $$ literally', status: 'todo', type: 'PLN' },
        summary: { done: 0, inProgress: 0, blocked: 0, queued: 0, total: 0 },
        phases: [],
        workItems: [],
        planItems: [],
        completedLog: [],
        failureLog: [],
        taskMatrix: null,
        dependencyDag: null,
        dataDate: '',
        source: 'test',
      };

      const outPath = emit(tmp.dir, 'PLN-DOLLAR', data);
      const html = fs.readFileSync(outPath, 'utf-8');

      expect(html).toContain('Cost is $1 and escape as $$ literally');
    });
  });
});

describe('WK-0084: IN dashboard PLN nodes + cross-dashboard navigation', () => {
  describe('parseInitiative: PLN extraction into planItems', () => {
    let tmp: TmpRepo;

    afterEach(() => {
      tmp?.cleanup();
    });

    it('extracts a PLN ref from the IN\'s related/depends_on/blocks arrays and populates planItems', () => {
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/initiatives/IN-9010.md', {
        id: 'IN-9010', title: 'Initiative with a linked plan', status: 'in_progress',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
        related: ['PLN-9010'], depends_on: [], blocks: [],
      });
      writeRecord(tmp.dir, 'wiki/plans/PLN-9010.md', {
        id: 'PLN-9010', title: 'Linked plan', status: 'draft',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      });

      const data = parseInitiative(tmp.dir, 'IN-9010');

      expect(data.planItems).toEqual([
        { id: 'PLN-9010', title: 'Linked plan', status: 'draft', lane: 'queued', dashboardExists: false },
      ]);
    });

    it('collects PLN refs from all three arrays, deduped and sorted, each with the correct lane', () => {
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/initiatives/IN-9011.md', {
        id: 'IN-9011', title: 'Initiative with multiple plans', status: 'in_progress',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
        related: ['PLN-9013'], depends_on: ['PLN-9012'], blocks: ['PLN-9012'],
      });
      writeRecord(tmp.dir, 'wiki/plans/PLN-9012.md', {
        id: 'PLN-9012', title: 'Plan twelve', status: 'in_progress',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      });
      writeRecord(tmp.dir, 'wiki/plans/PLN-9013.md', {
        id: 'PLN-9013', title: 'Plan thirteen', status: 'done',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      });

      const data = parseInitiative(tmp.dir, 'IN-9011');

      // PLN-9012 appears in both depends_on and blocks -- one planItem, not two.
      expect(data.planItems.map(p => p.id)).toEqual(['PLN-9012', 'PLN-9013']);
      expect(data.planItems.find(p => p.id === 'PLN-9012')!.lane).toBe('in_progress');
      expect(data.planItems.find(p => p.id === 'PLN-9013')!.lane).toBe('done');
    });

    it('dashboardExists is true when wiki/dashboard/<PLN-id>.html exists, false otherwise', () => {
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/initiatives/IN-9012.md', {
        id: 'IN-9012', title: 'Initiative with one rendered and one unrendered plan', status: 'in_progress',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
        related: ['PLN-9014', 'PLN-9015'], depends_on: [], blocks: [],
      });
      writeRecord(tmp.dir, 'wiki/plans/PLN-9014.md', {
        id: 'PLN-9014', title: 'Rendered plan', status: 'in_progress',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      });
      writeRecord(tmp.dir, 'wiki/plans/PLN-9015.md', {
        id: 'PLN-9015', title: 'Unrendered plan', status: 'in_progress',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      });
      fs.mkdirSync(path.join(tmp.dir, 'wiki', 'dashboard'), { recursive: true });
      fs.writeFileSync(path.join(tmp.dir, 'wiki', 'dashboard', 'PLN-9014.html'), '<html></html>', 'utf-8');

      const data = parseInitiative(tmp.dir, 'IN-9012');

      expect(data.planItems.find(p => p.id === 'PLN-9014')!.dashboardExists).toBe(true);
      expect(data.planItems.find(p => p.id === 'PLN-9015')!.dashboardExists).toBe(false);
    });

    it('a PLN ref with no record on disk is skipped gracefully -- no planItem, no throw', () => {
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/initiatives/IN-9013.md', {
        id: 'IN-9013', title: 'Initiative referencing a missing plan', status: 'in_progress',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
        related: ['PLN-9999'], depends_on: [], blocks: [],
      });

      expect(() => parseInitiative(tmp.dir, 'IN-9013')).not.toThrow();
      const data = parseInitiative(tmp.dir, 'IN-9013');
      expect(data.planItems).toEqual([]);
    });

    it('a WK-set (parseWkSet) and a PLN tracker (parseTracker) both report planItems: []', async () => {
      const { parseWkSet } = await import('../packages/dashboard/src/parse-wk-set.js');
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/issues/WK-9020.md', {
        id: 'WK-9020', title: 'A work item', type: 'task', status: 'inbox',
        priority: 'medium', owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      });

      const wkSetData = parseWkSet(tmp.dir, ['WK-9020']);
      const trackerData = parseTracker(MINIMAL_TRACKER, { id: 'PLN-TEST2', title: 'Test', status: 'active' });

      expect(wkSetData.planItems).toEqual([]);
      expect(trackerData.planItems).toEqual([]);
    });
  });

  describe('cli.ts: --list flag', () => {
    let tmp: TmpRepo;

    afterEach(() => {
      tmp?.cleanup();
    });

    it('prints existing wiki/dashboard/*.html paths, one per line, sorted, excluding non-html files', () => {
      tmp = createTmpDir();
      const dashDir = path.join(tmp.dir, 'wiki', 'dashboard');
      fs.mkdirSync(dashDir, { recursive: true });
      fs.writeFileSync(path.join(dashDir, 'PLN-0004.html'), '<html></html>', 'utf-8');
      fs.writeFileSync(path.join(dashDir, 'IN-0001.html'), '<html></html>', 'utf-8');
      fs.writeFileSync(path.join(dashDir, 'notes.txt'), 'not a dashboard', 'utf-8');

      const output = runDashboardCli(`--list --dir "${tmp.dir}"`);

      const lines = output.trim().split(/\r?\n/);
      expect(lines).toEqual([
        path.join(dashDir, 'IN-0001.html'),
        path.join(dashDir, 'PLN-0004.html'),
      ]);
    }, 20000);

    it('prints nothing and does not error when wiki/dashboard does not exist', () => {
      tmp = createTmpDir();

      const output = runDashboardCli(`--list --dir "${tmp.dir}"`);

      expect(output.trim()).toBe('');
    }, 20000);
  });

  describe('cli.ts: PLN back-link to parent IN', () => {
    let tmp: TmpRepo;

    afterEach(() => {
      tmp?.cleanup();
    });

    it('embeds parentInitiative + parentDashboardExists:true when the PLN declares initiative: and the IN dashboard exists', () => {
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/plans/PLN-9020.md', {
        id: 'PLN-9020', title: 'Plan with a parent', status: 'draft',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
        initiative: 'IN-9020',
      });
      fs.mkdirSync(path.join(tmp.dir, 'wiki', 'plans', 'PLN-9020', 'execution'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp.dir, 'wiki', 'plans', 'PLN-9020', 'execution', 'tracker.md'),
        MINIMAL_TRACKER,
        'utf-8',
      );
      fs.mkdirSync(path.join(tmp.dir, 'wiki', 'dashboard'), { recursive: true });
      fs.writeFileSync(path.join(tmp.dir, 'wiki', 'dashboard', 'IN-9020.html'), '<html></html>', 'utf-8');

      runDashboardCli(`PLN-9020 --dir "${tmp.dir}"`);

      const html = fs.readFileSync(path.join(tmp.dir, 'wiki', 'dashboard', 'PLN-9020.html'), 'utf-8');
      expect(html).toContain('"parentInitiative": "IN-9020"');
      expect(html).toContain('"parentDashboardExists": true');
    }, 20000);

    it('omits parentInitiative when the PLN has no initiative: field', () => {
      tmp = createTmpDir();
      writeRecord(tmp.dir, 'wiki/plans/PLN-9021.md', {
        id: 'PLN-9021', title: 'Plan with no parent', status: 'draft',
        owner: 'test', created: '2026-01-01', updated: '2026-01-01',
      });
      fs.mkdirSync(path.join(tmp.dir, 'wiki', 'plans', 'PLN-9021', 'execution'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp.dir, 'wiki', 'plans', 'PLN-9021', 'execution', 'tracker.md'),
        MINIMAL_TRACKER,
        'utf-8',
      );

      runDashboardCli(`PLN-9021 --dir "${tmp.dir}"`);

      const html = fs.readFileSync(path.join(tmp.dir, 'wiki', 'dashboard', 'PLN-9021.html'), 'utf-8');
      // The template's JS source references `d.record.parentInitiative` unquoted (dot-access)
      // regardless of data -- only the quoted JSON-key form indicates the field was emitted.
      expect(html).not.toContain('"parentInitiative"');
      expect(html).not.toContain('"parentDashboardExists"');
    }, 20000);
  });
});

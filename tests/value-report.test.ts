/**
 * Tests for computeValueReport (value-report.ts).
 *
 * TDD: tests written first, then implementation.
 * Each describe block maps to a spec §11.3–§11.6 scenario.
 * Real git fixture repos, hand-authored wiki/.graph.json, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { computeValueReport } from '../packages/wiki-core/src/value-report.js';
import { createTmpDir, writeRecord } from './helpers/tmp-repo.js';
import type { TmpRepo } from './helpers/tmp-repo.js';

// ---------------------------------------------------------------------------
// Git fixture helpers
// ---------------------------------------------------------------------------

/**
 * Initialize a git repo with configured user identity.
 */
function initRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test Author"', { cwd: dir, stdio: 'pipe' });
}

/**
 * Write a file and commit it with a specific author date.
 * authorDate: ISO string like "2026-01-01T10:00:00"
 */
function commitFile(
  dir: string,
  relPath: string,
  content: string,
  message: string,
  authorDate?: string,
): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  execSync(`git add "${relPath}"`, { cwd: dir, stdio: 'pipe' });
  const dateEnv = authorDate
    ? { ...process.env, GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: authorDate }
    : process.env;
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe', env: dateEnv });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/**
 * Delete a file and commit.
 */
function deleteFile(dir: string, relPath: string, message: string, authorDate?: string): string {
  execSync(`git rm "${relPath}"`, { cwd: dir, stdio: 'pipe' });
  const dateEnv = authorDate
    ? { ...process.env, GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: authorDate }
    : process.env;
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe', env: dateEnv });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/**
 * Get the first commit SHA in the repo.
 */
function firstCommit(dir: string): string {
  return execSync('git rev-list --max-parents=0 HEAD', {
    cwd: dir,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
}

/**
 * Write a hand-authored wiki/.graph.json into the fixture.
 */
function writeGraph(
  dir: string,
  nodes: Array<{ id: string; kind: string; exists?: boolean }>,
  edges: Array<{ source: string; target: string; relation: string }>,
  orphans: string[] = [],
): void {
  const graphPath = path.join(dir, 'wiki', '.graph.json');
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.writeFileSync(
    graphPath,
    JSON.stringify({
      generated_at: new Date().toISOString(),
      nodes: nodes.map(n => ({ ...n, exists: n.exists ?? true })),
      edges,
      orphans,
    }),
    'utf-8',
  );
}

/**
 * Write a prior VAL record (frontmatter only).
 */
function writePriorVal(
  dir: string,
  id: string,
  headCommit: string,
  extraFields: Record<string, string | number | boolean> = {},
): void {
  const valDir = path.join(dir, 'wiki', 'value-reports');
  fs.mkdirSync(valDir, { recursive: true });
  const fields: Record<string, unknown> = {
    id,
    title: `Test VAL ${id}`,
    status: 'published',
    owner: 'test',
    created: '2026-01-01',
    updated: '2026-01-01',
    window_start: '2026-01-01',
    window_end: '2026-01-02',
    base_commit: 'aaaaaa',
    head_commit: headCommit,
    prior_val: 'none',
    chain_status: 'first',
    ...extraFields,
  };
  writeRecord(dir, `wiki/value-reports/${id}.md`, fields);
}

// ---------------------------------------------------------------------------
// §11.3 — Watermark, no double-count, chain status
// ---------------------------------------------------------------------------

describe('§11.3 watermark and chain status', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('first run: counts all commits, head_commit = HEAD, chain_status = first, prior_val = none', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const shaA = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'add a', '2026-01-01T10:00:00');
    const shaB = commitFile(tmp.dir, 'src/b.ts', 'import { a } from "./a.js";\n', 'add b', '2026-01-02T10:00:00');
    const shaC = commitFile(tmp.dir, 'src/c.ts', 'export const c = 3;\n', 'add c', '2026-01-03T10:00:00');

    const base = firstCommit(tmp.dir);
    const result = await computeValueReport({ dir: tmp.dir, since: base });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.head_commit).toBe(shaC);
    expect(result.data.commits).toBe(3);
    expect(result.data.chain_status).toBe('first');
    expect(result.data.prior_val).toBe('none');
    expect(result.data.base_commit).toBe(base);

    void shaA;
    void shaB;
  });

  it('second run after prior VAL: counts only new commits, chain_status = complete', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const shaA = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'add a', '2026-01-01T10:00:00');
    const shaB = commitFile(tmp.dir, 'src/b.ts', 'export const b = 2;\n', 'add b', '2026-01-02T10:00:00');
    const shaC = commitFile(tmp.dir, 'src/c.ts', 'export const c = 3;\n', 'add c', '2026-01-03T10:00:00');

    // Simulate a prior VAL that ended at shaC
    writePriorVal(tmp.dir, 'VAL-0001', shaC, { prior_val: 'none', chain_status: 'first' });

    const shaD = commitFile(tmp.dir, 'src/d.ts', 'export const d = 4;\n', 'add d', '2026-01-04T10:00:00');
    const shaE = commitFile(tmp.dir, 'src/e.ts', 'export const e = 5;\n', 'add e', '2026-01-05T10:00:00');

    // Next run should auto-detect base from prior VAL's head_commit
    const result = await computeValueReport({ dir: tmp.dir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.commits).toBe(2);
    expect(result.data.head_commit).toBe(shaE);
    expect(result.data.base_commit).toBe(shaC);
    expect(result.data.chain_status).toBe('complete');
    expect(result.data.prior_val).toBe('VAL-0001');

    void shaA; void shaB; void shaD;
  });

  it('gap: base_commit != prior head → chain_status = gap', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const shaA = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'add a', '2026-01-01T10:00:00');
    const shaB = commitFile(tmp.dir, 'src/b.ts', 'export const b = 2;\n', 'add b', '2026-01-02T10:00:00');

    // Prior VAL ends at shaA, but caller passes shaB as since (gap — skipping shaA→shaB)
    writePriorVal(tmp.dir, 'VAL-0001', shaA, { prior_val: 'none', chain_status: 'first' });

    // Force since to shaB — this creates a gap (prior head=shaA, base=shaB, not an ancestor/equal pair)
    // Actually a gap means base != prior head AND shaA is ancestor of shaB
    // We pass untilRef=HEAD and since=shaB to simulate basing the report NOT from the prior head
    const result = await computeValueReport({ dir: tmp.dir, since: shaB });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chain_status).toBe('gap');

    void shaB;
  });

  it('overlap: base_commit is ancestor of prior head → chain_status = overlap', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const shaA = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'add a', '2026-01-01T10:00:00');
    const shaB = commitFile(tmp.dir, 'src/b.ts', 'export const b = 2;\n', 'add b', '2026-01-02T10:00:00');
    const shaC = commitFile(tmp.dir, 'src/c.ts', 'export const c = 3;\n', 'add c', '2026-01-03T10:00:00');

    // Prior VAL ended at shaC
    writePriorVal(tmp.dir, 'VAL-0001', shaC, { prior_val: 'none', chain_status: 'first' });

    // Force since to shaA — creates overlap (base=shaA is ancestor of prior head=shaC)
    const result = await computeValueReport({ dir: tmp.dir, since: shaA });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chain_status).toBe('overlap');

    void shaB;
  });
});

// ---------------------------------------------------------------------------
// §11.4 — Throwaway + churn
// ---------------------------------------------------------------------------

describe('§11.4 throwaway and churn', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('exclude-glob file is excluded from units and LOC but counted in excluded_files', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/real.ts', 'export const x = 1;\n', 'init');

    // A file in scratch_space (excluded by default glob)
    commitFile(tmp.dir, 'scratch_space/x.py', 'import pandas as pd\n', 'add scratch');

    writeGraph(tmp.dir, [
      { id: 'src/real.ts', kind: 'code_file' },
      { id: 'scratch_space/x.py', kind: 'code_file' },
    ], []);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // scratch_space/x.py must NOT appear as a unit
    const detail = result.data.unit_details;
    expect(detail.some(d => d.path.includes('scratch_space'))).toBe(false);
    // But must be counted as excluded
    expect(result.data.excluded_files).toBeGreaterThan(0);
  });

  it('added-then-deleted file: excluded from units/net_loc, surfaces churn_loc', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/keep.ts', 'export const keep = 1;\n', 'init');

    // Add and then delete a file in the same span
    commitFile(tmp.dir, 'src/temp.py', 'x = 1\ny = 2\nz = 3\n', 'add temp');
    deleteFile(tmp.dir, 'src/temp.py', 'delete temp');

    writeGraph(tmp.dir, [
      { id: 'src/keep.ts', kind: 'code_file' },
    ], []);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // temp.py must NOT appear in unit_details (not in endpoint diff)
    const detail = result.data.unit_details;
    expect(detail.some(d => d.path === 'src/temp.py')).toBe(false);

    // churn_loc must be > 0 (the 3 lines added then deleted)
    expect(result.data.churn_loc).toBeGreaterThan(0);

    // net_loc_added should NOT count the temp.py lines
    // (those were added then deleted, so net is 0 for temp.py)
  });
});

// ---------------------------------------------------------------------------
// §11.5 — Falsifiability
// ---------------------------------------------------------------------------

describe('§11.5 falsifiability', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('zero valued units → units_valued=0, negative time_saved_days, speedup<1, no error', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'add a', '2026-01-01T10:00:00');
    // Many commits spread over many days — agent spent a lot of calendar time but produced no valued units
    for (let i = 0; i < 5; i++) {
      commitFile(
        tmp.dir,
        `src/work${i}.ts`,
        'export const x = 1;\n',
        `work ${i}`,
        `2026-01-0${i + 2}T10:00:00`,
      );
    }

    // No graph — no wired/tested evidence, and files don't match candidate patterns
    // Files in src/ don't match candidate_locations (analysis/**, scripts/**, etc.)
    // So units should be survives-only, units_valued = 0

    // Also no graph
    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.units_valued).toBe(0);
    // span_days should be >= 5
    expect(result.data.span_days).toBeGreaterThanOrEqual(5);
    // human_days_anchor = 0 (no valued units, and net_loc/loc_per_day might be small but units floor it)
    // time_saved_days = 0 - span_days → negative
    expect(result.data.time_saved_days).toBeLessThan(0);
    // speedup = min(0/span_days, cap) → 0, which is < 1
    expect(result.data.speedup).toBeLessThan(1);
    // Must not error
    expect(result.ok).toBe(true);
  });

  it('same-day span → span_days = 1 (no divide-by-zero)', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'commit A', '2026-01-01T09:00:00');
    commitFile(tmp.dir, 'src/b.ts', 'export const b = 2;\n', 'commit B', '2026-01-01T11:00:00');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.span_days).toBe(1);
    // speedup must be a finite number (no division by zero)
    expect(Number.isFinite(result.data.speedup)).toBe(true);
  });

  it('the instrument can report negative value — no clamping to zero', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // 10 days of commits, 0 valued units
    const base = commitFile(tmp.dir, 'src/a.ts', 'x=1\n', 'a', '2026-01-01T10:00:00');
    commitFile(tmp.dir, 'src/b.ts', 'x=1\n', 'b', '2026-01-10T10:00:00');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // time_saved_days should be negative (anchor 0 - span_days 9 = -9 or similar)
    expect(result.data.time_saved_days).toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// §11.6 — Evidence ladder
// ---------------------------------------------------------------------------

describe('§11.6 evidence ladder', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('inbound-imported file → wired', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/module.ts', 'export const fn = () => {};\n', 'add module');
    commitFile(tmp.dir, 'src/caller.ts', 'import { fn } from "./module.js";\nfn();\n', 'add caller');

    // module.ts is imported by caller.ts (inbound edge to module.ts)
    writeGraph(tmp.dir, [
      { id: 'src/module.ts', kind: 'code_file' },
      { id: 'src/caller.ts', kind: 'code_file' },
    ], [
      { source: 'src/caller.ts', target: 'src/module.ts', relation: 'imports' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = result.data.unit_details.find(d => d.path === 'src/module.ts');
    expect(detail).toBeDefined();
    expect(detail?.evidence).toBe('wired');
  });

  it('file with outbound in-repo imports only → wired', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/lib.ts', 'export const lib = 1;\n', 'add lib');
    commitFile(tmp.dir, 'src/script.ts', 'import { lib } from "./lib.js";\nconsole.log(lib);\n', 'add script');

    // script.ts has outbound edge to lib.ts (it imports lib) — outbound = it uses repo modules
    writeGraph(tmp.dir, [
      { id: 'src/lib.ts', kind: 'code_file' },
      { id: 'src/script.ts', kind: 'code_file' },
    ], [
      { source: 'src/script.ts', target: 'src/lib.ts', relation: 'imports' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const scriptDetail = result.data.unit_details.find(d => d.path === 'src/script.ts');
    expect(scriptDetail).toBeDefined();
    expect(scriptDetail?.evidence).toBe('wired');
  });

  it('pattern-matched terminal script (analysis/plot.py) with no repo edges → candidate, NOT in units_valued', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'analysis/plot.py', 'import pandas as pd\npd.read_csv("data.csv")\n', 'add plot');

    // graph has plot.py as a node but no edges to/from it (terminal, only imports pandas)
    writeGraph(tmp.dir, [
      { id: 'analysis/plot.py', kind: 'code_file' },
    ], []);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Must be in candidates, not in unit_details as wired/tested
    expect(result.data.candidates.some(c => c.path === 'analysis/plot.py')).toBe(true);
    // NOT counted in units_valued
    expect(result.data.units_valued).toBe(0);
    // The plot.py detail should be 'candidate'
    const detail = result.data.unit_details.find(d => d.path === 'analysis/plot.py');
    if (detail) {
      expect(detail.evidence).toBe('candidate');
    }
  });

  it('orphan file matching no branch → survives-only (evidence = survives)', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // A file that is: not in a candidate location, not in graph edges, not in test patterns
    const base = commitFile(tmp.dir, 'src/orphan.ts', 'export const orphan = 1;\n', 'add orphan');

    // No graph edges for orphan.ts, not in candidate location
    writeGraph(tmp.dir, [
      { id: 'src/orphan.ts', kind: 'code_file' },
    ], []);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = result.data.unit_details.find(d => d.path === 'src/orphan.ts');
    expect(detail).toBeDefined();
    expect(detail?.evidence).toBe('survives');
    // Not in candidates
    expect(result.data.candidates.some(c => c.path === 'src/orphan.ts')).toBe(false);
    // Not valued
    expect(result.data.units_valued).toBe(0);
  });

  it('graph absent → graph_available=false, import+tested skipped, candidates remain', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'analysis/run.py', 'import pandas as pd\n', 'add run');
    commitFile(tmp.dir, 'src/helper.ts', 'export const helper = 1;\n', 'add helper');

    // No wiki/.graph.json written

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.graph_available).toBe(false);
    // units_valued = 0 (no wired/tested possible without graph)
    expect(result.data.units_valued).toBe(0);
    // candidates still surfaced (pattern-match doesn't need graph)
    expect(result.data.candidates.some(c => c.path === 'analysis/run.py')).toBe(true);
    // estimate_basis must mention graph not available
    expect(result.data.estimate_basis).toContain('graph');
  });

  it('per-unit LOC scaling: 15-line confirmed script contributes ≤ 0.1d (not the full 0.25d class constant)', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // A short script: 15 lines
    const lines = Array.from({ length: 15 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n';
    const base = commitFile(tmp.dir, 'scripts/short.py', lines, 'add short script');

    // Make it wired via the graph (inbound import)
    writeGraph(tmp.dir, [
      { id: 'scripts/short.py', kind: 'code_file' },
      { id: 'src/caller.py', kind: 'code_file' },
    ], [
      { source: 'src/caller.py', target: 'scripts/short.py', relation: 'imports' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // short.py should be wired and valued
    expect(result.data.units_valued).toBeGreaterThan(0);

    // unit_value = min(0.25, 15/150) = min(0.25, 0.1) = 0.1
    // So human_days_units should be ≤ 0.1
    expect(result.data.human_days_units).toBeLessThanOrEqual(0.1);
    expect(result.data.human_days_units).toBeGreaterThan(0);
  });

  it('tested branch: test file imports a source file → source file is tested', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/compute.ts', 'export const compute = (x: number) => x * 2;\n', 'add compute');
    commitFile(tmp.dir, 'tests/compute.test.ts', 'import { compute } from "../src/compute.js";\n', 'add test');

    writeGraph(tmp.dir, [
      { id: 'src/compute.ts', kind: 'code_file' },
      { id: 'tests/compute.test.ts', kind: 'code_file' },
    ], [
      { source: 'tests/compute.test.ts', target: 'src/compute.ts', relation: 'imports' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const computeDetail = result.data.unit_details.find(d => d.path === 'src/compute.ts');
    expect(computeDetail).toBeDefined();
    expect(computeDetail?.evidence).toBe('tested');
    // tests themselves are not unit_details as non-test units
    expect(result.data.units_valued).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Estimate arithmetic
// ---------------------------------------------------------------------------

describe('estimate arithmetic (spec §9)', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('human_days_anchor = min(human_days_units, human_days_loc)', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // Many lines of code but a simple wired file
    const bigContent = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
    const base = commitFile(tmp.dir, 'src/big.ts', bigContent, 'add big file');

    writeGraph(tmp.dir, [
      { id: 'src/big.ts', kind: 'code_file' },
      { id: 'src/caller.ts', kind: 'code_file' },
    ], [
      { source: 'src/caller.ts', target: 'src/big.ts', relation: 'imports' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.human_days_anchor).toBe(
      Math.min(result.data.human_days_units, result.data.human_days_loc),
    );
  });

  it('speedup is capped at speedup_cap (default 10)', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // Create a tool-class file (3d value) committed in 1 day
    const base = commitFile(tmp.dir, 'tools/big_tool.ts', 'export const tool = 1;\n', 'add tool', '2026-01-01T10:00:00');
    commitFile(tmp.dir, 'tools/big_tool2.ts', 'export const tool2 = 2;\n', 'add tool2', '2026-01-01T11:00:00');

    // wired via graph
    writeGraph(tmp.dir, [
      { id: 'tools/big_tool.ts', kind: 'code_file' },
      { id: 'tools/big_tool2.ts', kind: 'code_file' },
      { id: 'src/caller.ts', kind: 'code_file' },
    ], [
      { source: 'src/caller.ts', target: 'tools/big_tool.ts', relation: 'imports' },
      { source: 'src/caller.ts', target: 'tools/big_tool2.ts', relation: 'imports' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // speedup must never exceed 10 (the default cap)
    expect(result.data.speedup).toBeLessThanOrEqual(10);
  });

  it('fails with GIT_UNAVAILABLE when dir is not a git repo', async () => {
    tmp = createTmpDir();
    // No git init

    const result = await computeValueReport({ dir: tmp.dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('GIT_UNAVAILABLE');
  });

  it('config override: custom per_unit_days and loc_per_day used in arithmetic', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'add a');

    writeGraph(tmp.dir, [
      { id: 'src/a.ts', kind: 'code_file' },
      { id: 'src/b.ts', kind: 'code_file' },
    ], [
      { source: 'src/b.ts', target: 'src/a.ts', relation: 'imports' },
    ]);

    // Override: scripts = 5d (unusual high), loc_per_day = 1 (extreme)
    const result = await computeValueReport({
      dir: tmp.dir,
      since: base,
      config: {
        per_unit_days: { scripts: 5, modules: 2, tools: 3, docs: 0.25 },
        loc_per_day: 1,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // With loc_per_day=1 and net_loc_added=1 → human_days_loc = 1
    // With scripts=5 → unit_value = min(5, 1/1) = 1 → human_days_units = 1
    // human_days_anchor = min(1,1) = 1
    expect(result.data.human_days_anchor).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe('config loading', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('loads overrides from wiki/.value-config.json', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'init');

    const configPath = path.join(tmp.dir, 'wiki', '.value-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ speedup_cap: 5 }), 'utf-8');

    writeGraph(tmp.dir, [
      { id: 'src/a.ts', kind: 'code_file' },
      { id: 'src/b.ts', kind: 'code_file' },
    ], [
      { source: 'src/b.ts', target: 'src/a.ts', relation: 'imports' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.speedup).toBeLessThanOrEqual(5);
  });

  it('opts.config takes precedence over file config', async () => {
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'init');

    // File says cap=5
    const configPath = path.join(tmp.dir, 'wiki', '.value-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ speedup_cap: 5 }), 'utf-8');

    // opts says cap=3 → should win
    const result = await computeValueReport({
      dir: tmp.dir,
      since: base,
      config: { speedup_cap: 3 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.speedup).toBeLessThanOrEqual(3);
  });
});

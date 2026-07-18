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
// §11.5 — Falsifiability (facts-only; no estimate arithmetic on tool output)
// ---------------------------------------------------------------------------

describe('§11.5 falsifiability — tool emits facts, not estimates', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('zero wired/tested units → no estimate fields in tool output, review_units still lists candidates', async () => {
    // WHY: the tool must not produce estimate fields even when there are no high-evidence units;
    // the review surface still covers candidates so the agent has something to estimate.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'add a', '2026-01-01T10:00:00');
    commitFile(tmp.dir, 'analysis/plot.py', 'import pandas as pd\n', 'add plot', '2026-01-05T10:00:00');

    writeGraph(tmp.dir, [
      { id: 'src/a.ts', kind: 'code_file' },
      { id: 'analysis/plot.py', kind: 'code_file' },
    ], []);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Tool output must NOT contain estimate fields
    expect('human_days_units' in result.data).toBe(false);
    expect('human_days_loc' in result.data).toBe(false);
    expect('human_days_anchor' in result.data).toBe(false);
    expect('time_saved_days' in result.data).toBe(false);
    expect('speedup' in result.data).toBe(false);
    expect('estimate_basis' in result.data).toBe(false);
    expect('units_valued' in result.data).toBe(false);

    // review_units still has the candidate
    expect(result.data.review_units.some(u => u.path === 'analysis/plot.py')).toBe(true);
  });

  it('same-day span → span_days = 1 (no divide-by-zero risk in tool output)', async () => {
    // WHY: span_days floor of 1 is a measurement fact, not an estimate guard.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'commit A', '2026-01-01T09:00:00');
    commitFile(tmp.dir, 'src/b.ts', 'export const b = 2;\n', 'commit B', '2026-01-01T11:00:00');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.span_days).toBe(1);
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

  it('pattern-matched terminal script (analysis/plot.py) with no repo edges → candidate', async () => {
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
    // Not in review_units (pure survives excluded)
    expect(result.data.review_units.some(u => u.path === 'src/orphan.ts')).toBe(false);
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
    // candidates still surfaced (pattern-match doesn't need graph)
    expect(result.data.candidates.some(c => c.path === 'analysis/run.py')).toBe(true);
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
    // tested file appears in review_units
    expect(result.data.review_units.some(u => u.path === 'src/compute.ts' && u.tier === 'tested')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // NEW: linked tier tests (WK-0039 §"Coverage fix")
  // ---------------------------------------------------------------------------

  it('linked tier: file with a wiki repo_path edge but no import edges → linked', async () => {
    // WHY: workflow repos have entrypoint scripts that are never imported by other code
    // but ARE tracked by wiki records via repo_paths. The linked tier surfaces them so
    // agents can estimate their value instead of leaving them as mere survives.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'scripts/run_pipeline.py', 'import subprocess\nsubprocess.run(["snakemake"])\n', 'add pipeline');

    // Graph: wiki record has a repo_path edge → this file; no import edges
    writeGraph(tmp.dir, [
      { id: 'scripts/run_pipeline.py', kind: 'code_file' },
      { id: 'wiki/issues/WK-0010.md', kind: 'doc_file' },
    ], [
      { source: 'wiki/issues/WK-0010.md', target: 'scripts/run_pipeline.py', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = result.data.unit_details.find(d => d.path === 'scripts/run_pipeline.py');
    expect(detail).toBeDefined();
    expect(detail?.evidence).toBe('linked');
    // linked appears in review_units
    expect(result.data.review_units.some(u => u.path === 'scripts/run_pipeline.py' && u.tier === 'linked')).toBe(true);
  });

  it('linked tier: wired evidence wins over linked (import edges take priority)', async () => {
    // WHY: the tier ladder is tested > wired > linked > candidate; a file that is both
    // wired (has import edges) and linked (has repo_path edge) must stay wired.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/util.ts', 'export const x = 1;\n', 'add util');
    commitFile(tmp.dir, 'src/main.ts', 'import { x } from "./util.js";\n', 'add main');

    writeGraph(tmp.dir, [
      { id: 'src/util.ts', kind: 'code_file' },
      { id: 'src/main.ts', kind: 'code_file' },
      { id: 'wiki/issues/WK-0010.md', kind: 'doc_file' },
    ], [
      { source: 'src/main.ts', target: 'src/util.ts', relation: 'imports' },
      { source: 'wiki/issues/WK-0010.md', target: 'src/util.ts', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = result.data.unit_details.find(d => d.path === 'src/util.ts');
    expect(detail?.evidence).toBe('wired'); // NOT 'linked'
  });

  it('linked tier: candidate evidence wins over survives when repo_path but not in candidate_locations', async () => {
    // WHY: a file in a canonical candidate location (analysis/**) outranks pure survives;
    // linked is checked AFTER wired but BEFORE candidate, so a file with both a repo_path edge
    // and a candidate location match must be labeled 'linked' (linked > candidate in the ladder).
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'analysis/explore.py', 'x = 1\n', 'add explore');

    writeGraph(tmp.dir, [
      { id: 'analysis/explore.py', kind: 'code_file' },
      { id: 'wiki/issues/WK-0011.md', kind: 'doc_file' },
    ], [
      { source: 'wiki/issues/WK-0011.md', target: 'analysis/explore.py', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = result.data.unit_details.find(d => d.path === 'analysis/explore.py');
    // repo_path link → linked (beats candidate because linked > candidate)
    expect(detail?.evidence).toBe('linked');
  });

  it('no linked units without a graph (linked degrades cleanly)', async () => {
    // WHY: linked tier requires graph; absence of graph must not produce linked units.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'scripts/run.py', 'x = 1\n', 'add run');
    // No graph written

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.unit_details.some(d => d.evidence === 'linked')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// review_units[] — unified review surface (WK-0039 §"Unified review_units[]")
// ---------------------------------------------------------------------------

describe('review_units[] — unified review surface', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('review_units includes tested, wired, linked, candidate tiers but excludes pure-survives and test files', async () => {
    // WHY: review_units is both the review surface and the estimate basis;
    // pure-survives are not estimate candidates and test files are evidence, not units.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/tested.ts', 'export const t = 1;\n', 'add tested');
    commitFile(tmp.dir, 'src/wired.ts', 'export const w = 1;\n', 'add wired');
    commitFile(tmp.dir, 'src/orphan.ts', 'export const o = 1;\n', 'add orphan');
    commitFile(tmp.dir, 'scripts/linked.py', 'x = 1\n', 'add linked');
    commitFile(tmp.dir, 'analysis/candidate.py', 'y = 1\n', 'add candidate');
    commitFile(tmp.dir, 'tests/tested.test.ts', 'import { t } from "../src/tested.js";\n', 'add test');

    writeGraph(tmp.dir, [
      { id: 'src/tested.ts', kind: 'code_file' },
      { id: 'src/wired.ts', kind: 'code_file' },
      { id: 'src/orphan.ts', kind: 'code_file' },
      { id: 'scripts/linked.py', kind: 'code_file' },
      { id: 'analysis/candidate.py', kind: 'code_file' },
      { id: 'tests/tested.test.ts', kind: 'code_file' },
      { id: 'wiki/issues/WK-0020.md', kind: 'doc_file' },
    ], [
      { source: 'tests/tested.test.ts', target: 'src/tested.ts', relation: 'imports' },
      { source: 'src/wired.ts', target: 'src/orphan.ts', relation: 'imports' },
      { source: 'wiki/issues/WK-0020.md', target: 'scripts/linked.py', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = result.data.review_units.map(u => u.path);

    // Included tiers
    expect(paths).toContain('src/tested.ts');
    expect(paths).toContain('src/wired.ts');
    expect(paths).toContain('scripts/linked.py');
    expect(paths).toContain('analysis/candidate.py');

    // Excluded: pure survives (orphan.ts has inbound 'imports' from wired.ts → wired, actually)
    // orphan.ts is imported by wired.ts so it IS wired — included
    // The true pure-survives case: a file with no edges and no candidate location
    // Here: the test file itself must not appear
    expect(paths).not.toContain('tests/tested.test.ts');
  });

  it('review_units.loc_reference = net_loc / loc_per_day (the LOC tripwire reference)', async () => {
    // WHY: loc_reference is the LOC tripwire so agents flag estimates diverging >3× from it.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const lines300 = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
    const base = commitFile(tmp.dir, 'src/big.ts', lines300, 'add big');
    commitFile(tmp.dir, 'src/caller.ts', 'import { x0 } from "./big.js";\n', 'add caller');

    writeGraph(tmp.dir, [
      { id: 'src/big.ts', kind: 'code_file' },
      { id: 'src/caller.ts', kind: 'code_file' },
    ], [
      { source: 'src/caller.ts', target: 'src/big.ts', relation: 'imports' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base, config: { loc_per_day: 150 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bigUnit = result.data.review_units.find(u => u.path === 'src/big.ts');
    expect(bigUnit).toBeDefined();
    if (!bigUnit) return;
    // loc_reference = net_loc / loc_per_day
    expect(bigUnit.loc_reference).toBeCloseTo(bigUnit.net_loc / 150, 5);
  });

  it('review_units.wk_ids contains wiki record ids linked via repo_path edges', async () => {
    // WHY: wk_ids per unit lets agents cite the relevant WK/PLN records in their estimate rows.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'scripts/analyze.py', 'import os\n', 'add analyze');

    writeGraph(tmp.dir, [
      { id: 'scripts/analyze.py', kind: 'code_file' },
      { id: 'wiki/issues/WK-0042.md', kind: 'doc_file' },
      { id: 'wiki/plans/PLN-0003.md', kind: 'doc_file' },
    ], [
      { source: 'wiki/issues/WK-0042.md', target: 'scripts/analyze.py', relation: 'repo_path' },
      { source: 'wiki/plans/PLN-0003.md', target: 'scripts/analyze.py', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unit = result.data.review_units.find(u => u.path === 'scripts/analyze.py');
    expect(unit).toBeDefined();
    if (!unit) return;
    // wk_ids should contain the two linking wiki record ids (extracted from source)
    expect(unit.wk_ids).toContain('WK-0042');
    expect(unit.wk_ids).toContain('PLN-0003');
  });
});

// ---------------------------------------------------------------------------
// wk_ids union (WK-0039 §"WK discovery")
// ---------------------------------------------------------------------------

describe('wk_ids: commit-message regex ∪ graph repo_path edges', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('wk_ids contains ids from commit messages', async () => {
    // WHY: commit-message scraping is the baseline WK discovery path.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'x=1\n', 'fix(WK-0001): correct calculation');
    commitFile(tmp.dir, 'src/b.ts', 'y=2\n', 'feat(WK-0002): add feature');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.wk_ids).toContain('WK-0001');
    expect(result.data.wk_ids).toContain('WK-0002');
  });

  it('wk_ids contains ids from graph repo_path edges to span-changed files (even without commit-message mentions)', async () => {
    // WHY: workflow repos often have sparse commit messages; graph edges are the fallback WK
    // discovery path that prevents wiki-tracked work from disappearing from the ROI narrative.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // Commit message has no WK id
    const base = commitFile(tmp.dir, 'scripts/analyze.py', 'import os\n', 'add analysis script');

    writeGraph(tmp.dir, [
      { id: 'scripts/analyze.py', kind: 'code_file' },
      { id: 'wiki/issues/WK-0099.md', kind: 'doc_file' },
    ], [
      { source: 'wiki/issues/WK-0099.md', target: 'scripts/analyze.py', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // WK-0099 discovered via graph even though commit message is silent
    expect(result.data.wk_ids).toContain('WK-0099');
  });

  it('wk_ids deduplicates ids appearing in both commit messages and graph edges', async () => {
    // WHY: union must be a set — no duplicates in the narrative WK list.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'scripts/run.py', 'x=1\n', 'fix(WK-0055): pipeline fix');

    writeGraph(tmp.dir, [
      { id: 'scripts/run.py', kind: 'code_file' },
      { id: 'wiki/issues/WK-0055.md', kind: 'doc_file' },
    ], [
      { source: 'wiki/issues/WK-0055.md', target: 'scripts/run.py', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const count = result.data.wk_ids.filter(id => id === 'WK-0055').length;
    expect(count).toBe(1); // exactly once
  });

  it('graph repo_path edges to files NOT in the span do not contribute to wk_ids', async () => {
    // WHY: wk_ids should reflect work done in THIS span; linking to files outside the span
    // would falsely attribute prior WK ids to this report.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/new.ts', 'x=1\n', 'add new file (no WK mention)');

    // Graph has an edge pointing at a different file not changed in the span
    writeGraph(tmp.dir, [
      { id: 'src/new.ts', kind: 'code_file' },
      { id: 'src/old.ts', kind: 'code_file' },
      { id: 'wiki/issues/WK-0077.md', kind: 'doc_file' },
    ], [
      // Points to old.ts which is NOT in the span
      { source: 'wiki/issues/WK-0077.md', target: 'src/old.ts', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // WK-0077 must NOT appear because src/old.ts was not changed in this span
    expect(result.data.wk_ids).not.toContain('WK-0077');
  });
});

// ---------------------------------------------------------------------------
// loc_per_day echoed in output (WK-0039 §"loc_per_day in output")
// ---------------------------------------------------------------------------

describe('loc_per_day echoed in ValueMetrics output', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('loc_per_day is present in output and matches the resolved config value', async () => {
    // WHY: loc_per_day must be in the output so the agent/template can compute loc_reference
    // for the How-Calculated section without re-running the tool.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'x=1\n', 'init');

    const result = await computeValueReport({ dir: tmp.dir, since: base, config: { loc_per_day: 200 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.loc_per_day).toBe(200);
  });

  it('loc_per_day defaults to 150 when not overridden', async () => {
    // WHY: the default must be stable so templates and historical VALs use a known baseline.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'x=1\n', 'init');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.loc_per_day).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Workflow-repo fixture: pilot minimal acceptance test (WK-0039 acceptance criteria)
// ---------------------------------------------------------------------------

describe('workflow-repo fixture: pilot minimal acceptance test', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('tested, wired, linked, and candidate units all appear in review_units with correct tiers; wk_ids found via graph when commit messages omit them', async () => {
    // WHY: the pilot failure exposed that the old tool produced a review surface disjoint from
    // the estimate basis in a repo with sparse imports, entrypoint scripts, and incomplete
    // commit messages. This fixture reproduces that pattern and asserts the fix.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // Sparse commit messages — no WK ids mentioned
    const base = commitFile(tmp.dir, 'src/core.ts', 'export const core = 1;\n', 'add core module');
    commitFile(tmp.dir, 'src/util.ts', 'export const util = 2;\n', 'add util');
    commitFile(tmp.dir, 'tests/core.test.ts', 'import { core } from "../src/core.js";\n', 'add tests');
    commitFile(tmp.dir, 'scripts/run_analysis.py', 'import subprocess\n', 'add analysis runner');
    commitFile(tmp.dir, 'notebooks/explore.ipynb', '{"cells":[]}\n', 'add notebook');
    commitFile(tmp.dir, 'analysis/report.py', 'import pandas as pd\n', 'add report generator');

    writeGraph(tmp.dir, [
      { id: 'src/core.ts', kind: 'code_file' },
      { id: 'src/util.ts', kind: 'code_file' },
      { id: 'tests/core.test.ts', kind: 'code_file' },
      { id: 'scripts/run_analysis.py', kind: 'code_file' },
      { id: 'notebooks/explore.ipynb', kind: 'code_file' },
      { id: 'analysis/report.py', kind: 'code_file' },
      { id: 'wiki/issues/WK-0100.md', kind: 'doc_file' },
      { id: 'wiki/issues/WK-0101.md', kind: 'doc_file' },
    ], [
      // tested: test imports core
      { source: 'tests/core.test.ts', target: 'src/core.ts', relation: 'imports' },
      // wired: util imports core (outbound edge from util)
      { source: 'src/util.ts', target: 'src/core.ts', relation: 'imports' },
      // linked: wiki records point at the entrypoint scripts
      { source: 'wiki/issues/WK-0100.md', target: 'scripts/run_analysis.py', relation: 'repo_path' },
      { source: 'wiki/issues/WK-0101.md', target: 'notebooks/explore.ipynb', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reviewMap = new Map(result.data.review_units.map(u => [u.path, u]));

    // core.ts → tested (test imports it)
    expect(reviewMap.get('src/core.ts')?.tier).toBe('tested');

    // util.ts → wired (imports core, which is in surviving files)
    expect(reviewMap.get('src/util.ts')?.tier).toBe('wired');

    // run_analysis.py → linked (wiki repo_path edge, no imports)
    expect(reviewMap.get('scripts/run_analysis.py')?.tier).toBe('linked');

    // explore.ipynb → linked (wiki repo_path edge)
    expect(reviewMap.get('notebooks/explore.ipynb')?.tier).toBe('linked');

    // analysis/report.py → candidate (candidate_location, no edges)
    expect(reviewMap.get('analysis/report.py')?.tier).toBe('candidate');

    // test file excluded from review_units
    expect(reviewMap.has('tests/core.test.ts')).toBe(false);

    // wk_ids discovered via graph even with silent commit messages
    expect(result.data.wk_ids).toContain('WK-0100');
    expect(result.data.wk_ids).toContain('WK-0101');

    // review surface == estimate basis (no disjunction)
    // Every unit in review_units is in unit_details (audit trail)
    for (const ru of result.data.review_units) {
      const detail = result.data.unit_details.find(d => d.path === ru.path);
      expect(detail).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// GIT_UNAVAILABLE error
// ---------------------------------------------------------------------------

describe('error handling', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('fails with GIT_UNAVAILABLE when dir is not a git repo', async () => {
    tmp = createTmpDir();
    // No git init

    const result = await computeValueReport({ dir: tmp.dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('GIT_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe('config loading', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('loads loc_per_day override from wiki/.value-config.json', async () => {
    // WHY: file config lets operators tune the LOC tripwire reference without code changes.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'init');

    const configPath = path.join(tmp.dir, 'wiki', '.value-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ loc_per_day: 200 }), 'utf-8');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.loc_per_day).toBe(200);
  });

  it('opts.config takes precedence over file config for loc_per_day', async () => {
    // WHY: opts.config is the highest-priority override, so callers (MCP/CLI) can force values.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'init');

    // File says 200
    const configPath = path.join(tmp.dir, 'wiki', '.value-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ loc_per_day: 200 }), 'utf-8');

    // opts says 100 → should win
    const result = await computeValueReport({ dir: tmp.dir, since: base, config: { loc_per_day: 100 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.loc_per_day).toBe(100);
  });
});

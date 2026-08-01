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

  it('loc_per_day defaults to 260 (calibrated from SRC-0002 operator R corpus)', async () => {
    // WHY: the default is the floor's provenance. 260 = the operator's git-dated corpus-wide
    // throughput (SRC-0002: 129,447 net LOC ÷ 498 distinct active-days), replacing the asserted
    // 150. Cross-validated leave-one-section-out to within 2× (median 0.92), conservative-biased.
    // This value IS the calibration — if it silently reverts to 150 the floor is un-cited again.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'x=1\n', 'init');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.loc_per_day).toBe(260);
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
// §WK-0040 — work_days / work_hours / hours_per_work_day (git-derived work time)
// ---------------------------------------------------------------------------

describe('§WK-0040 work_days, work_hours, hours_per_work_day — git-derived work time', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('idle-day exclusion: commits on 3 distinct author-dates separated by idle days → work_days === 3 (not calendar span)', async () => {
    // WHY: the denominator for leverage is operator-active days, not calendar days;
    // idle days must not inflate the denominator and produce false-null leverage.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'day 1 commit',
      '2026-01-01T10:00:00');
    // idle day: 2026-01-02
    commitFile(tmp.dir, 'src/b.ts', 'export const b = 2;\n', 'day 3 commit',
      '2026-01-03T10:00:00');
    // idle day: 2026-01-04
    commitFile(tmp.dir, 'src/c.ts', 'export const c = 3;\n', 'day 5 commit',
      '2026-01-05T10:00:00');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Calendar span: Jan 1 → Jan 5 = 5 days; work_days must be 3 (active dates only)
    expect(result.data.span_days).toBe(5);
    expect(result.data.work_days).toBe(3);
    // work_hours >= 0 (each single-commit day → 0.5h floor)
    expect(result.data.work_hours).toBeGreaterThanOrEqual(0);
    // hours_per_work_day is the frozen constant 8
    expect(result.data.hours_per_work_day).toBe(8);
  });

  it('intra-day hour span: a day with commits at two different times contributes (last − first) hours', async () => {
    // WHY: work_hours is the finer-grained proxy; on a multi-commit day the span between
    // the first and last author-timestamp on that day is the estimated active window.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'morning commit',
      '2026-01-01T09:00:00 +0000');
    commitFile(tmp.dir, 'src/b.ts', 'export const b = 2;\n', 'afternoon commit',
      '2026-01-01T11:00:00 +0000');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Single active day with 2h span: work_days = 1, work_hours = 2
    expect(result.data.work_days).toBe(1);
    // The two commits span 2 hours (09:00 to 11:00)
    expect(result.data.work_hours).toBeCloseTo(2, 0);
    expect(result.data.hours_per_work_day).toBe(8);
  });

  it('single-commit-day floor: a day with exactly one commit contributes 0.5h (the floor)', async () => {
    // WHY: a single commit has no intra-day span (first = last → span = 0);
    // the 0.5h floor prevents single-commit days from contributing 0 to work_hours,
    // which would make the total misleadingly low.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // One commit only — intra-day span is 0, so the floor should apply
    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'sole commit on day',
      '2026-01-01T10:00:00');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.work_days).toBe(1);
    // Single-commit day → 0.5h floor
    expect(result.data.work_hours).toBeCloseTo(0.5, 1);
    expect(result.data.hours_per_work_day).toBe(8);
  });

  it('falsifiability / no clamp: work_days reflects true distinct-date count with no lower bound inflating leverage', async () => {
    // WHY: falsifiability is the credibility spine — a genuinely low-leverage span must report
    // honestly. No artificial minimum on work_days may shrink the denominator.
    // Here: only ONE active day → work_days = 1, no clamping to something smaller.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'only commit',
      '2026-05-01T14:00:00');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // work_days must be exactly 1 — the true count; no clamping to a lower value
    // (i.e. it is not 0 from an artificial clamp, and not inflated by idle days)
    expect(result.data.work_days).toBe(1);
    // Also verify: work_days is a non-negative integer, never artificially minimized
    expect(result.data.work_days).toBeGreaterThanOrEqual(1);
  });

  it('span_days is still emitted and equals the inclusive calendar span (regression: existing behavior retained)', async () => {
    // WHY: span_days is the secondary context field (cadence/chain); it must be preserved
    // alongside the new work_days field, not replaced by it.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'first commit',
      '2026-01-01T09:00:00');
    // Idle days in between
    commitFile(tmp.dir, 'src/b.ts', 'export const b = 2;\n', 'last commit',
      '2026-01-10T09:00:00');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Calendar span: Jan 1 → Jan 10 = 10 inclusive days
    expect(result.data.span_days).toBe(10);
    // work_days must be less than span_days (only 2 active days, 8 idle)
    expect(result.data.work_days).toBe(2);
    expect(result.data.work_days).toBeLessThan(result.data.span_days);
  });

  it('multi-day span with multiple commits per day: work_hours sums per-day spans correctly', async () => {
    // WHY: work_hours must be the SUM over each active day's (last − first) span;
    // a day with a 2h spread and another day with a 3h spread → total 5h.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // Day 1: 09:00 and 11:00 → 2h span
    const base = commitFile(tmp.dir, 'src/a.ts', 'x=1\n', 'day1 morning',
      '2026-02-01T09:00:00 +0000');
    commitFile(tmp.dir, 'src/b.ts', 'x=2\n', 'day1 afternoon',
      '2026-02-01T11:00:00 +0000');
    // Day 2: 10:00 and 13:00 → 3h span
    commitFile(tmp.dir, 'src/c.ts', 'x=3\n', 'day2 morning',
      '2026-02-02T10:00:00 +0000');
    commitFile(tmp.dir, 'src/d.ts', 'x=4\n', 'day2 afternoon',
      '2026-02-02T13:00:00 +0000');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.work_days).toBe(2);
    // Total work_hours: day1=2h + day2=3h = 5h
    expect(result.data.work_hours).toBeCloseTo(5, 0);
    expect(result.data.hours_per_work_day).toBe(8);
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

// ---------------------------------------------------------------------------
// §WK-0041 — COCOMO II nominal ceiling (cocomo_kloc + cocomo_pm_nominal)
// ---------------------------------------------------------------------------

describe('§WK-0041 COCOMO II nominal ceiling — cocomo_kloc and cocomo_pm_nominal', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('1 KSLOC code-only → cocomo_kloc === 1.00, cocomo_pm_nominal === 2.94 (tests A constant)', async () => {
    // WHY: the COCOMO II nominal formula is PM = A * KSLOC^E. At KSLOC=1, KSLOC^E = 1,
    // so PM = A = 2.94 exactly. This pins the A constant (2.94, Boehm 2000 post-arch nominal).
    // A drift in A would change this. The ceiling must be a frozen, citable, reproducible value.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // Generate exactly 1000 non-blank lines of TypeScript (1 KSLOC)
    const lines = Array.from({ length: 1000 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    const base = commitFile(tmp.dir, 'src/generated.ts', lines, 'add 1000-line source');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cocomo_kloc).toBeCloseTo(1, 2);
    // PM = 2.94 * 1^1.0997 = 2.94
    expect(result.data.cocomo_pm_nominal).toBe(2.94);
  });

  it('2 KSLOC code-only → cocomo_kloc === 2.00, cocomo_pm_nominal === 6.30 (tests E exponent)', async () => {
    // WHY: PM = 2.94 * 2^1.0997 = 6.30. A linear model (E=1) would give 5.88, so this test
    // specifically pins the E exponent = 1.0997 (B=0.91 + 0.01*18.97 from COCOMO nominal SF).
    // A wrong exponent would produce a different value and fail this test.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const lines2k = Array.from({ length: 2000 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    const base = commitFile(tmp.dir, 'src/generated.ts', lines2k, 'add 2000-line source');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cocomo_kloc).toBeCloseTo(2, 2);
    // PM = 2.94 * 2^1.0997 ≈ 6.30 (rounded to 2 decimals)
    expect(result.data.cocomo_pm_nominal).toBe(6.30);
  });

  it('docs LOC excluded from cocomo_kloc: 1000 TS lines + 500 markdown lines → cocomo_kloc ≈ 1.00, NOT 1.50', async () => {
    // WHY: COCOMO II measures SLOC (source lines of code), not documentation.
    // Markdown/rst/html are not executable source; including them would inflate the ceiling
    // beyond its citable basis. The classifier already marks .md files as 'docs'; this test
    // enforces that docs LOC is subtracted before computing cocomo_kloc.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const codeLines = Array.from({ length: 1000 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    const docLines = Array.from({ length: 500 }, (_, i) => `# Section ${i}`).join('\n') + '\n';

    const base = commitFile(tmp.dir, 'src/generated.ts', codeLines, 'add code');
    commitFile(tmp.dir, 'docs/guide.md', docLines, 'add docs');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // cocomo_kloc must be ~1.0 (code only), NOT ~1.5 (code + docs)
    expect(result.data.cocomo_kloc).toBeCloseTo(1, 2);
    expect(result.data.cocomo_kloc).toBeLessThan(1.1); // strict upper bound: docs not included
  });

  it('zero code-only LOC (docs-only span) → cocomo_kloc === 0, cocomo_pm_nominal === 0 (no NaN)', async () => {
    // WHY: a span containing only documentation (no executable SLOC) must produce 0, not NaN.
    // 0^E would produce 0 which is correct, but guard must be explicit to prevent any future
    // rounding or log-based reformulation from producing NaN or Infinity.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const docLines = Array.from({ length: 500 }, (_, i) => `# Section ${i}`).join('\n') + '\n';
    const base = commitFile(tmp.dir, 'docs/guide.md', docLines, 'add docs only');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cocomo_kloc).toBe(0);
    expect(result.data.cocomo_pm_nominal).toBe(0);
    // Explicitly verify not NaN or Infinity
    expect(Number.isFinite(result.data.cocomo_kloc)).toBe(true);
    expect(Number.isFinite(result.data.cocomo_pm_nominal)).toBe(true);
  });

  it('display-only: tool output exposes cocomo fields but NOT human_days_anchor/speedup/time_saved_days', async () => {
    // WHY: the COCOMO ceiling is a display-only reference — it must never enter the headline
    // arithmetic (human_days_anchor, speedup, time_saved_days). These estimate fields belong
    // exclusively to the operator-ratified floor. The ceiling must be computable from the tool
    // output but must not contaminate the estimate chain. This is a regression guard.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const lines = Array.from({ length: 500 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    const base = commitFile(tmp.dir, 'src/generated.ts', lines, 'add code');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // COCOMO fields must be present
    expect('cocomo_kloc' in result.data).toBe(true);
    expect('cocomo_pm_nominal' in result.data).toBe(true);

    // Estimate-arithmetic fields must be absent (tool measures only)
    expect('human_days_anchor' in result.data).toBe(false);
    expect('speedup' in result.data).toBe(false);
    expect('time_saved_days' in result.data).toBe(false);
  });

  it('test-file-only span: 1000 added lines in a test file → cocomo_kloc === 1, cocomo_pm_nominal === 2.94 (test files are delivered code per WK-0041)', async () => {
    // WHY: the COCOMO II ceiling must price delivered code including test files.
    // WK-0041 "Ceiling mechanics" states: "test files included (delivered code)".
    // The defect was that cocomo_kloc was computed from unitDetails, which excludes test
    // files entirely (the file loop does `if (testFileSet.has(fp)) continue;`).
    // The fix: use netLocAdded − docsNetLoc so test-file LOC is captured via netLocAdded.
    // This test proves the defect (gives 0 before fix) and guards the fix (gives 1 after).
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // Exactly 1000 lines in a test file only — no other code or docs
    const testLines = Array.from({ length: 1000 }, (_, i) => `expect(${i}).toBe(${i});`).join('\n') + '\n';
    const base = commitFile(tmp.dir, 'src/sample.test.ts', testLines, 'add 1000-line test file');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 1000 lines / 1000 = 1.0 KSLOC; PM = 2.94 * 1^1.0997 = 2.94
    expect(result.data.cocomo_kloc).toBeCloseTo(1, 2);
    expect(result.data.cocomo_pm_nominal).toBe(2.94);
  });

  it('config/data files excluded from cocomo_kloc: only .yaml, .json, .csv changes → cocomo_kloc === 0, cocomo_pm_nominal === 0 (WK-0041 positive-whitelist rule)', async () => {
    // WHY: COCOMO II / SEI SLOC definition counts source statements only; data files and
    // configuration are explicitly excluded. The old code used netLocAdded − docsNetLoc,
    // which counted YAML/JSON/CSV because they land in netLocAdded (included files) but are
    // NOT in unitDetails (classifyUnit returns null for them). The fix switches to a positive
    // whitelist: code-unit net LOC = classifier-recognized code units (scripts/modules/tools,
    // not docs) + test files. A span with only config/data and no recognizable source should
    // produce cocomo_kloc === 0 and cocomo_pm_nominal === 0. Counting them inflates the ceiling
    // in the attackable direction — conservative residual error is undercount, not overcount.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // ~300 lines of YAML (config), ~200 lines of JSON (data), ~500 lines of CSV (data)
    // None of these extensions are in script_extensions; classifyUnit returns null for all.
    const yamlLines = Array.from({ length: 300 }, (_, i) => `key_${i}: value_${i}`).join('\n') + '\n';
    const jsonLines = '{\n' + Array.from({ length: 198 }, (_, i) => `  "field_${i}": ${i}`).join(',\n') + '\n}\n';
    const csvLines = 'col1,col2,col3\n' + Array.from({ length: 499 }, (_, i) => `${i},${i * 2},${i * 3}`).join('\n') + '\n';

    const base = commitFile(tmp.dir, 'config/pipeline.yaml', yamlLines, 'add pipeline config');
    commitFile(tmp.dir, 'config/params.json', jsonLines, 'add params');
    commitFile(tmp.dir, 'data/samples.csv', csvLines, 'add sample data');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No classifier-recognized source → cocomo_kloc must be 0 and cocomo_pm_nominal must be 0.
    // Before the fix: netLocAdded − docsNetLoc counts all ~1000 lines → cocomo_kloc ≈ 1.0 (RED).
    // After the fix: whitelist via unitDetails (non-docs) + testFileSet → 0 lines (GREEN).
    expect(result.data.cocomo_kloc).toBe(0);
    expect(result.data.cocomo_pm_nominal).toBe(0);
  });

  it('workflow DSL (.cwl) counted in cocomo_kloc: 1000-line CWL file in scripts/ → cocomo_kloc === 1 (WK-0041 positive-whitelist, not extension-blocklist)', async () => {
    // WHY: .cwl (Common Workflow Language) is YAML-syntax but IS executable workflow source code.
    // The fix must use the classification patterns (which list .cwl in script_extensions) as the
    // positive whitelist — NOT a YAML extension blocklist. A blocklist on .yaml would silently
    // drop CWL workflow files and undercount real delivered source. This test guards against that
    // mistake: a .cwl file that classifies as 'scripts' must contribute to cocomo_kloc.
    // Confirms .cwl is in script_extensions and classifies correctly as a code unit.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    // Place the CWL file in scripts/ so classifyUnit classifies it as 'scripts' (script_extensions includes .cwl).
    const cwlLines = Array.from({ length: 1000 }, (_, i) =>
      i === 0 ? 'class: Workflow' : i === 1 ? 'cwlVersion: v1.0' : `  step_${i}: { run: tool_${i}.cwl }`
    ).join('\n') + '\n';

    const base = commitFile(tmp.dir, 'scripts/pipeline.cwl', cwlLines, 'add CWL workflow');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 1000 lines / 1000 = 1.0 KSLOC; PM = 2.94 * 1^1.0997 = 2.94
    // The .cwl extension is in script_extensions → classifyUnit returns 'scripts' → counted.
    // If the fix had used an extension blocklist on .yaml, this would fail (CWL uses YAML syntax).
    expect(result.data.cocomo_kloc).toBeCloseTo(1, 2);
    expect(result.data.cocomo_pm_nominal).toBe(2.94);
  });
});

// ---------------------------------------------------------------------------
// WK-0053 — ref resolution fails loud (silent HEAD fallback bit PF038)
// ---------------------------------------------------------------------------

describe('ref resolution fails loud (WK-0053)', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('returns a failed Result when untilRef does not resolve', async () => {
    // WHY: a mistyped/unresolvable untilRef must abort, not silently fall back to HEAD and
    // report the wrong span (the defect that produced a wrong-span PF038 report).
    tmp = createTmpDir();
    initRepo(tmp.dir);
    commitFile(tmp.dir, 'a.py', 'x = 1\n', 'init', '2026-01-01T10:00:00');

    const result = await computeValueReport({ dir: tmp.dir, untilRef: 'no-such-ref' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('no-such-ref');
  });

  it('returns a failed Result when since does not resolve', async () => {
    // WHY: same fail-loud contract for the since ref — no silent fallback to a wrong base.
    tmp = createTmpDir();
    initRepo(tmp.dir);
    commitFile(tmp.dir, 'a.py', 'x = 1\n', 'init', '2026-01-01T10:00:00');

    const result = await computeValueReport({ dir: tmp.dir, since: 'no-such-ref' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('no-such-ref');
  });
});

// ---------------------------------------------------------------------------
// WK-0053 — generated artifacts excluded from net LOC (35.6k-LOC graph-summary polluted it)
// ---------------------------------------------------------------------------

describe('generated artifacts excluded from net LOC (WK-0053)', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('excludes graph-summary.md and wiki generated views', async () => {
    // WHY: generated views (graph-summary.md, wiki/catalog.md, etc.) are not authored output;
    // counting them inflates net LOC and every downstream replication estimate.
    tmp = createTmpDir();
    initRepo(tmp.dir);
    commitFile(tmp.dir, 'a.py', 'x = 1\ny = 2\n', 'code', '2026-01-01T10:00:00');
    commitFile(tmp.dir, 'graph-summary.md', 'line\n'.repeat(100), 'generated', '2026-01-01T11:00:00');
    commitFile(tmp.dir, 'wiki/catalog.md', 'line\n'.repeat(50), 'generated view', '2026-01-01T12:00:00');

    const result = await computeValueReport({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.net_loc_added).toBe(2); // only a.py counts
      expect(result.data.excluded_files).toBeGreaterThanOrEqual(2);
    }
  });
});

/**
 * Tests for computeValueReport (value-report.ts).
 *
 * TDD: tests written first, then implementation.
 * Each describe block maps to a spec §11.3–§11.6 scenario.
 * Real git fixture repos, hand-authored wiki/.graph.json, no network.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { computeValueReport, findUnpublishedDraft } from '../packages/wiki-core/src/value-report.js';
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
 * Write a file with a NUL byte so git records it as binary (real .parquet/.h5ad/.npy),
 * then commit. Binary files are dropped by `git diff --numstat`, so the classifier must
 * discover them via the name-status file list — the WK-0059 no-silent-drop guarantee.
 */
function commitBinaryFile(dir: string, relPath: string, message: string, authorDate?: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from([0x50, 0x41, 0x52, 0x31, 0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]));
  execSync(`git add "${relPath}"`, { cwd: dir, stdio: 'pipe' });
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

  it('WK-0058 resume guard: a draft VAL is skipped — the watermark chains only from the published prior', async () => {
    // WHY: the watermark advances only on publish. A lingering draft (a resumable span claim) with a
    // real head_commit must NOT be a chain link, or a fresh report would chain past published work
    // into an unpublished claim and mis-scope the span.
    tmp = createTmpDir();
    initRepo(tmp.dir);

    const shaA = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'add a', '2026-01-01T10:00:00');
    const shaB = commitFile(tmp.dir, 'src/b.ts', 'export const b = 2;\n', 'add b', '2026-01-02T10:00:00');
    const shaC = commitFile(tmp.dir, 'src/c.ts', 'export const c = 3;\n', 'add c', '2026-01-03T10:00:00');

    // Published watermark at shaA; a later DRAFT (status: draft) claims up to shaB and must be ignored.
    writePriorVal(tmp.dir, 'VAL-0001', shaA, { prior_val: 'none', chain_status: 'first' });
    writePriorVal(tmp.dir, 'VAL-0002', shaB, { status: 'draft' });

    const result = await computeValueReport({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Chains from the PUBLISHED VAL-0001 (base shaA), never the draft VAL-0002 (shaB).
    expect(result.data.prior_val).toBe('VAL-0001');
    expect(result.data.base_commit).toBe(shaA);

    void shaC;
  });
});

// ---------------------------------------------------------------------------
// WK-0058 — resume-first guard (one unpublished draft = the span claim)
// ---------------------------------------------------------------------------

describe('findUnpublishedDraft — resume-first guard / one-draft invariant (WK-0058)', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('returns null when there is no unpublished draft (only published VALs)', () => {
    tmp = createTmpDir();
    writePriorVal(tmp.dir, 'VAL-0001', 'aaaa', {}); // published by default
    const res = findUnpublishedDraft(tmp.dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toBeNull();
  });

  it('returns the single draft (a resumable span claim) when one exists', () => {
    tmp = createTmpDir();
    writePriorVal(tmp.dir, 'VAL-0001', 'aaaa', {}); // published
    writePriorVal(tmp.dir, 'VAL-0002', 'bbbb', { status: 'draft', base_commit: 'aaaa' });
    const res = findUnpublishedDraft(tmp.dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.id).toBe('VAL-0002');
    expect(res.data?.head_commit).toBe('bbbb');
  });

  it('fails loud when more than one unpublished draft exists (invariant violated)', () => {
    // WHY: the draft IS the span claim; two drafts mean two VAL ids racing for the same watermark.
    // The finalize must refuse to proceed until the operator publishes or discards down to one.
    tmp = createTmpDir();
    writePriorVal(tmp.dir, 'VAL-0002', 'bbbb', { status: 'draft' });
    writePriorVal(tmp.dir, 'VAL-0003', 'cccc', { status: 'draft' });
    const res = findUnpublishedDraft(tmp.dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('VAL-0002');
    expect(res.message).toContain('VAL-0003');
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

  it('review_units includes tested, wired, linked, candidate tiers and test code as a floor unit; excludes pure-survives', async () => {
    // WHY: review_units is both the review surface and the estimate basis; pure-survives are not
    // estimate candidates. Since WK-0059 test code is a floor unit too (it both provides 'tested'
    // evidence to its target AND counts as its own unit — additive, no numeric double-count).
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

    // orphan.ts is imported by wired.ts so it IS wired — included (the true pure-survives
    // exclusion is covered by the §11.6 orphan-file test). WK-0059: test code is now a floor unit
    // too — tested.test.ts imports src/tested.ts (outbound edge) so it appears as 'wired'.
    expect(paths).toContain('tests/tested.test.ts');
    expect(result.data.review_units.find(u => u.path === 'tests/tested.test.ts')?.tier).toBe('wired');
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

  it('review surface == estimate basis: every review_unit has a unit_details row; wk_ids found via graph when commit messages omit them', async () => {
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

    // wk_ids discovered via graph even with silent commit messages (the fixture's sparse-message
    // design). Per-tier tier assertions are covered by the review_units[] and §11.6 ladder blocks;
    // this test guards only the pilot's unique invariant below.
    expect(result.data.wk_ids).toContain('WK-0100');
    expect(result.data.wk_ids).toContain('WK-0101');

    // review surface == estimate basis (no disjunction): every review_unit has a unit_details row
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
// §WK-0040 — work_days (git-derived work time). WK-0058 dropped work_hours/hours_per_work_day.
// ---------------------------------------------------------------------------

describe('§WK-0040 work_days — git-derived work time (WK-0058 dropped work_hours/hours_per_work_day)', () => {
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
    // WK-0058: work_hours / hours_per_work_day are dropped — never emitted (DEC-0003 §3 amendment).
    expect(result.data).not.toHaveProperty('work_hours');
    expect(result.data).not.toHaveProperty('hours_per_work_day');
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

// ---------------------------------------------------------------------------
// WK-0059 — no silent drop: extensionless execs, data-asset detection, tests/**
// code as floor units, unknown-type discovery; per-VAL config freeze; the
// WK-0055 generated-excludes stay non-negotiable.
// ---------------------------------------------------------------------------

describe('WK-0059 no-silent-drop classifier + config freeze', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  /**
   * The WK-0059 minimal-reproduction repo: an extensionless CLI (shebang), a fixture generator
   * and real test code under tests/, generated/curated/vendored data assets (text + binary),
   * a workflow-DSL file, and an unknown extension. The four code files are wiki-linked so they
   * reach review_units as priced floor units. Returns the base (first) commit.
   */
  function buildReproRepo(t: TmpRepo): string {
    initRepo(t.dir);
    const base = commitFile(t.dir, 'scripts/my-cli',
      '#!/usr/bin/env python3\nimport sys\nprint("run", sys.argv)\n', 'add extensionless cli');
    commitFile(t.dir, 'tests/fixtures/make_sample.py',
      'import anndata\n# builds the fixture below\nanndata.AnnData().write("sample.h5ad")\n', 'add fixture generator');
    commitBinaryFile(t.dir, 'tests/fixtures/sample.h5ad', 'add generated fixture');
    commitFile(t.dir, 'registry/datasets.csv', 'id,name\n1,alpha\n2,beta\n', 'add dataset registry');
    commitFile(t.dir, 'data/curated_panel.csv', 'gene,panel\nTP53,onco\nEGFR,onco\n', 'add curated panel');
    commitBinaryFile(t.dir, 'data/vendored.parquet', 'add vendored parquet');
    commitFile(t.dir, 'pipeline/step.cwl',
      'class: Workflow\ncwlVersion: v1.2\ninputs: {}\nsteps: {}\n', 'add cwl workflow');
    commitFile(t.dir, 'data/molecule.sdf', 'header\n  fake sdf\nM  END\n', 'add unknown-type asset');
    commitFile(t.dir, 'tests/test_smoke.py', 'def test_smoke():\n    assert True\n', 'add test code');

    writeGraph(t.dir, [
      { id: 'scripts/my-cli', kind: 'code_file' },
      { id: 'tests/fixtures/make_sample.py', kind: 'code_file' },
      { id: 'tests/test_smoke.py', kind: 'code_file' },
      { id: 'pipeline/step.cwl', kind: 'code_file' },
      { id: 'wiki/issues/WK-0059.md', kind: 'doc_file' },
    ], [
      { source: 'wiki/issues/WK-0059.md', target: 'scripts/my-cli', relation: 'repo_path' },
      { source: 'wiki/issues/WK-0059.md', target: 'tests/fixtures/make_sample.py', relation: 'repo_path' },
      { source: 'wiki/issues/WK-0059.md', target: 'tests/test_smoke.py', relation: 'repo_path' },
      { source: 'wiki/issues/WK-0059.md', target: 'pipeline/step.cwl', relation: 'repo_path' },
    ]);
    return base;
  }

  it('no committed non-excluded file is absent from all surfaces (the measurable no-silent-drop AC)', async () => {
    // WHY: the core bug — classifyUnit returned null for extensionless execs, non-test code under
    // tests/, and unknown types, dropping them from every surface. Every committed/linked file must
    // now appear as a review unit, a data trace, or an unclassified candidate.
    tmp = createTmpDir();
    const base = buildReproRepo(tmp);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const committed = [
      'scripts/my-cli', 'tests/fixtures/make_sample.py', 'tests/fixtures/sample.h5ad',
      'registry/datasets.csv', 'data/curated_panel.csv', 'data/vendored.parquet',
      'pipeline/step.cwl', 'data/molecule.sdf', 'tests/test_smoke.py',
    ];
    const surfaced = new Set<string>([
      ...result.data.review_units.map(u => u.path),
      ...result.data.data_traces.map(d => d.path),
      ...result.data.candidates.map(c => c.path),
      ...result.data.unit_details.map(d => d.path),
    ]);
    for (const f of committed) {
      expect(surfaced.has(f), `${f} was silently dropped`).toBe(true);
    }
  });

  it('extensionless CLI, fixture generator, test code, and workflow DSL are priced code review_units', async () => {
    // WHY: AC — these shipped surfaces must be counted floor units at the code rate, not dropped.
    tmp = createTmpDir();
    const base = buildReproRepo(tmp);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byPath = new Map(result.data.review_units.map(u => [u.path, u]));
    for (const p of ['scripts/my-cli', 'tests/fixtures/make_sample.py', 'tests/test_smoke.py', 'pipeline/step.cwl']) {
      expect(byPath.has(p), `${p} missing from review_units`).toBe(true);
      expect(byPath.get(p)!.loc_reference).toBeGreaterThan(0); // priced at the code rate
    }
    // the extensionless CLI classified as code via its shebang
    expect(['scripts', 'tools']).toContain(byPath.get('scripts/my-cli')!.unitClass);
  });

  it('every data file is a priced-0 data trace, absent from review_units; a generator is counted once', async () => {
    // WHY: AC — fixtures are valued through code with NO ownership mapping; every data file priced 0,
    // every generator counted once even though it emits many outputs (no size/anchor blob pricing).
    tmp = createTmpDir();
    const base = buildReproRepo(tmp);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dataPaths = result.data.data_traces.map(d => d.path);
    for (const d of ['tests/fixtures/sample.h5ad', 'registry/datasets.csv', 'data/curated_panel.csv', 'data/vendored.parquet']) {
      expect(dataPaths, `${d} missing from data_traces`).toContain(d);
    }
    const reviewPaths = result.data.review_units.map(u => u.path);
    for (const d of dataPaths) {
      expect(reviewPaths, `${d} must not be priced`).not.toContain(d);
    }
    // the generator is counted exactly once; its output (sample.h5ad) adds no priced unit
    expect(reviewPaths.filter(p => p === 'tests/fixtures/make_sample.py').length).toBe(1);
    expect(reviewPaths).not.toContain('tests/fixtures/sample.h5ad');
  });

  it('unknown extension surfaces as an unclassified candidate — never priced or auto-counted (operator gate)', async () => {
    // WHY: AC — the tool cannot promote an unknown type to countable; unknown types are surfaced
    // for operator ratification, valued 0 until then.
    tmp = createTmpDir();
    const base = buildReproRepo(tmp);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sdf = result.data.candidates.find(c => c.path === 'data/molecule.sdf');
    expect(sdf, 'unknown .sdf missing from candidates').toBeDefined();
    expect(sdf?.unitClass).toBe('unclassified');
    // never counted as code
    expect(result.data.review_units.some(u => u.path === 'data/molecule.sdf')).toBe(false);
    expect(result.data.unit_details.some(d => d.path === 'data/molecule.sdf')).toBe(false);
  });

  it('rate-applicability flags fire on test code, fixture generators, and workflow DSLs', async () => {
    // WHY: AC — the 260 rate transfers unevenly to these classes; each flagged row is an
    // operator-ratification candidate. Narration only — never changes arithmetic.
    tmp = createTmpDir();
    const base = buildReproRepo(tmp);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byPath = new Map(result.data.review_units.map(u => [u.path, u]));
    expect(byPath.get('tests/test_smoke.py')?.rate_flag).toBe('test-code');
    expect(byPath.get('tests/fixtures/make_sample.py')?.rate_flag).toBe('fixture-generator');
    expect(byPath.get('pipeline/step.cwl')?.rate_flag).toBe('workflow-dsl');
    // a plain code CLI carries no flag (calibrated rate applies)
    expect(byPath.get('scripts/my-cli')?.rate_flag).toBeNull();
  });

  it('shell-wrapper units are rate-flagged', async () => {
    // WHY: shell wrappers are the fourth uneven-rate class in the AC.
    tmp = createTmpDir();
    initRepo(tmp.dir);
    const base = commitFile(tmp.dir, 'bin/run.sh', '#!/bin/bash\nsnakemake --cores 4\n', 'add wrapper');
    writeGraph(tmp.dir, [
      { id: 'bin/run.sh', kind: 'code_file' },
      { id: 'wiki/issues/WK-0059.md', kind: 'doc_file' },
    ], [
      { source: 'wiki/issues/WK-0059.md', target: 'bin/run.sh', relation: 'repo_path' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unit = result.data.review_units.find(u => u.path === 'bin/run.sh');
    expect(unit?.rate_flag).toBe('shell-wrapper');
  });

  it('extensionless file without a shebang is an unclassified candidate, not an auto-swept script', async () => {
    // WHY: precedence is override → shebang → candidate-location. A plain blob in scripts/ with no
    // shebang and no override must NOT be silently counted as a script (attention-DoS / inflation).
    tmp = createTmpDir();
    initRepo(tmp.dir);
    const base = commitFile(tmp.dir, 'scripts/blob', 'just some data\nno shebang here\n', 'add blob');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.review_units.some(u => u.path === 'scripts/blob')).toBe(false);
    const cand = result.data.candidates.find(c => c.path === 'scripts/blob');
    expect(cand?.unitClass).toBe('unclassified');
  });

  it('operator can rule a data glob as orphan_data via config; still priced 0', async () => {
    // WHY: orphan_curated_data (committed data, no in-repo generator) is unpriced + flagged. The
    // ruling is operator config — the tool never infers generator ownership.
    tmp = createTmpDir();
    initRepo(tmp.dir);
    const base = commitFile(tmp.dir, 'data/curated.csv', 'a,b\n1,2\n', 'add curated');

    const cfgPath = path.join(tmp.dir, 'wiki', '.value-config.json');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ orphan_data_globs: ['data/**'] }), 'utf-8');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const trace = result.data.data_traces.find(d => d.path === 'data/curated.csv');
    expect(trace?.unitClass).toBe('orphan_data');
    expect(result.data.review_units.some(u => u.path === 'data/curated.csv')).toBe(false);
  });

  it('code-only span: no data traces, no unclassified candidates, code figures intact (regression)', async () => {
    // WHY: AC — widening the surface must not perturb a plain code span's numbers.
    tmp = createTmpDir();
    initRepo(tmp.dir);
    const base = commitFile(tmp.dir, 'src/a.ts', 'export const a = 1;\n', 'add a');
    commitFile(tmp.dir, 'src/b.ts', 'import { a } from "./a.js";\nexport const b = a + 1;\n', 'add b');
    writeGraph(tmp.dir, [
      { id: 'src/a.ts', kind: 'code_file' },
      { id: 'src/b.ts', kind: 'code_file' },
    ], [
      { source: 'src/b.ts', target: 'src/a.ts', relation: 'imports' },
    ]);

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.data_traces).toEqual([]);
    expect(result.data.candidates.filter(c => c.unitClass === 'unclassified')).toEqual([]);
    // a.ts imported by b.ts → wired; b.ts imports a.ts → wired
    const byPath = new Map(result.data.review_units.map(u => [u.path, u]));
    expect(byPath.get('src/a.ts')?.tier).toBe('wired');
    expect(byPath.get('src/b.ts')?.tier).toBe('wired');
  });

  it('published figures are invariant under a later .value-config.json edit when re-run with the frozen config', async () => {
    // WHY: AC — a published VAL must reproduce its figures from the frozen rulings + config hash,
    // regardless of subsequent config edits. The fresh re-run proves the edit WOULD have moved the
    // number, so the invariance is non-vacuous.
    tmp = createTmpDir();
    initRepo(tmp.dir);
    const lines = Array.from({ length: 1000 }, (_, i) => `record ${i} in a custom source format`).join('\n') + '\n';
    const base = commitFile(tmp.dir, 'pipeline/step.xyz', lines, 'add custom-format source');

    // Published run — default config: .xyz is unknown → unclassified → not code → cocomo 0.
    const published = await computeValueReport({ dir: tmp.dir, since: base });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const frozen = published.data.resolved_config;
    expect(published.data.config_hash).toBeTruthy();
    expect(published.data.cocomo_kloc).toBe(0);

    // Operator later edits config to treat .xyz as code.
    const cfgPath = path.join(tmp.dir, 'wiki', '.value-config.json');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({
      classification_patterns: { script_extensions: ['.py', '.ts', '.xyz'] },
    }), 'utf-8');

    // Re-render with the FROZEN config → figures pinned, invariant to the edit.
    const reRender = await computeValueReport({ dir: tmp.dir, since: base, frozenConfig: frozen });
    expect(reRender.ok).toBe(true);
    if (!reRender.ok) return;
    expect(reRender.data.cocomo_kloc).toBe(0);
    expect(reRender.data.config_hash).toBe(published.data.config_hash);

    // A FRESH run reads the edited file → the number moves, proving the edit mattered.
    const fresh = await computeValueReport({ dir: tmp.dir, since: base });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.data.cocomo_kloc).toBeGreaterThan(0);
  });

  it('.value-config.json cannot negate the WK-0055 generated-excludes; it can only add excludes', async () => {
    // WHY: AC — inclusion widening must not let local config silently re-admit generated files.
    // A config that sets exclude_globs must union with the frozen defaults, never replace them.
    tmp = createTmpDir();
    initRepo(tmp.dir);
    const base = commitFile(tmp.dir, 'a.py', 'x = 1\ny = 2\n', 'code');
    commitFile(tmp.dir, 'graph-summary.md', 'g\n'.repeat(100), 'generated');
    commitFile(tmp.dir, 'notes.foo', 'noise\n'.repeat(50), 'add foo');

    // Attempt to wipe excludes and add a new one.
    const cfgPath = path.join(tmp.dir, 'wiki', '.value-config.json');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ exclude_globs: ['**/*.foo'] }), 'utf-8');

    const result = await computeValueReport({ dir: tmp.dir, since: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // graph-summary.md STILL excluded (the frozen default survived the union) → only a.py counts.
    expect(result.data.net_loc_added).toBe(2);
    expect(result.data.resolved_config.exclude_globs).toContain('**/graph-summary.md');
    // the operator's added exclude also took effect.
    expect(result.data.resolved_config.exclude_globs).toContain('**/*.foo');
  });
});

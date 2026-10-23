/**
 * T13 — Propagation tests for VAL surfaces (spec §11.2, §12).
 *
 * Tests (TDD, written first):
 *   1. bootstrap: AGENTS.md does NOT contain the (removed, WK-0209) value-report recipe marker,
 *      and the dashboard bullet is explicitly kb-relative (CLAUDE.md is a thin @AGENTS.md redirect)
 *   2. wiki/value-reports/ directory exists after bootstrap
 *   3. wiki/templates/value.md exists after bootstrap
 *   4. allocate --prefix VAL → VAL-0001
 *   5. sync-contract does not reintroduce the removed recipe marker, and keeps the dashboard bullet
 *      kb-relative (WK-0209)
 *   6. a VAL record in wiki/value-reports/ graphs as a wiki_record node
 *   7. MCP tools array contains value-report and value-usage
 *   8. CLI dispatch recognises value-report and value-usage commands
 *
 * Stable marker string used in recipe-absence assertions (grep for this):
 *   "value-report-recipe-v3"
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

import { bootstrap, sync, allocate } from '../packages/wiki-core/src/index.js';
import { classifyFile, scanDirectory } from '../packages/graph-explore/src/index.js';
import {
  createTmpDir,
  createBootstrappedRepo,
  writeRecord,
  readText,
  fileExists,
  type TmpRepo,
} from './helpers/tmp-repo.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable marker string that used to be embedded in the recipe text (spec §7).
 *  WK-0209 removed the recipe section from the kb-managed contract block; AGENTS.md must NOT
 *  contain this after bootstrap/sync. Kept for that absence check. */
const RECIPE_MARKER = 'value-report-recipe-v3';

/** Substring of the reworded dashboard bullet (WK-0209) — the dashboard doc path only exists in
 *  the kb checkout, so the managed-block bullet must say so explicitly for consumer repos. */
const DASHBOARD_KB_RELATIVE_MARKER = 'kb checkout';

const ROOT = resolve(process.cwd());
const TSX = process.platform === 'win32'
  ? resolve(ROOT, 'node_modules/.bin/tsx.cmd')
  : resolve(ROOT, 'node_modules/.bin/tsx');
const CLI = resolve(ROOT, 'packages/wiki-cli/src/index.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCli(args: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`"${TSX}" "${CLI}" ${args}`, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: (e.stdout ?? '') + (e.stderr ?? ''), exitCode: e.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// T13.1-T13.4 — bootstrap propagation
// ---------------------------------------------------------------------------

describe('VAL propagation — bootstrap', () => {
  let tmp: TmpRepo;

  beforeEach(async () => { tmp = await createBootstrappedRepo(); });
  afterEach(() => { tmp?.cleanup(); });

  it('bootstrap: AGENTS.md does not contain the removed value-report recipe marker, and the dashboard bullet is kb-relative', () => {
    const agents = readText(tmp.dir, 'AGENTS.md');
    expect(agents).not.toContain(RECIPE_MARKER);
    expect(agents).toContain(DASHBOARD_KB_RELATIVE_MARKER);
  });

  it('bootstrap: CLAUDE.md is a thin redirect (@AGENTS.md) — recipe lives in AGENTS.md only', () => {
    const claude = readText(tmp.dir, 'CLAUDE.md');
    expect(claude).toContain('@AGENTS.md');
    expect(claude).not.toContain(RECIPE_MARKER);
  });

  it('bootstrap: wiki/value-reports/ directory exists', () => {
    expect(fs.existsSync(path.join(tmp.dir, 'wiki/value-reports'))).toBe(true);
  });

  it('bootstrap: wiki/templates/value.md exists', () => {
    expect(fileExists(tmp.dir, 'wiki/templates/value.md')).toBe(true);
  });

  it('bootstrap: allocate --prefix VAL returns VAL-0001', async () => {
    const result = await allocate({ dir: tmp.dir, prefix: 'VAL' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('VAL-0001');
    }
  });
});

// ---------------------------------------------------------------------------
// T13.5 — sync-contract does not reintroduce the removed recipe (WK-0209)
// ---------------------------------------------------------------------------

describe('VAL propagation — sync-contract does not re-land recipe', () => {
  let tmp: TmpRepo;

  afterEach(() => { tmp?.cleanup(); });

  it('sync-contract does not reintroduce the removed recipe marker, and keeps the dashboard bullet kb-relative', async () => {
    tmp = await createBootstrappedRepo();

    // Simulate a pre-WK-0209 consumer: its managed block still carries the old recipe section
    const agentsPath = path.join(tmp.dir, 'AGENTS.md');
    const original = fs.readFileSync(agentsPath, 'utf-8');
    const stale = original.replace(
      '<!-- END kb-managed -->',
      `### Value reports (${RECIPE_MARKER})\n\n<!-- END kb-managed -->`,
    );
    fs.writeFileSync(agentsPath, stale, 'utf-8');
    expect(fs.readFileSync(agentsPath, 'utf-8')).toContain(RECIPE_MARKER);

    // sync-contract re-writes the full managed block from the current contract template
    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    const synced = fs.readFileSync(agentsPath, 'utf-8');
    expect(synced).not.toContain(RECIPE_MARKER);
    expect(synced).toContain(DASHBOARD_KB_RELATIVE_MARKER);
  });

  it('sync-contract restores the @AGENTS.md pointer after CLAUDE.md managed block is corrupted', async () => {
    tmp = await createBootstrappedRepo();

    const claudePath = path.join(tmp.dir, 'CLAUDE.md');
    const original = fs.readFileSync(claudePath, 'utf-8');
    // Strip the @AGENTS.md pointer from the managed block
    const stripped = original
      .split('\n')
      .filter(line => !line.includes('@AGENTS.md'))
      .join('\n');
    fs.writeFileSync(claudePath, stripped, 'utf-8');
    expect(fs.readFileSync(claudePath, 'utf-8')).not.toContain('@AGENTS.md');

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(claudePath, 'utf-8')).toContain('@AGENTS.md');
  });
});

// ---------------------------------------------------------------------------
// T13.6 — VAL record graphs as wiki_record
// ---------------------------------------------------------------------------

describe('VAL graph node classification', () => {
  let tmp: TmpRepo;

  afterEach(() => { tmp?.cleanup(); });

  it('classifyFile: a VAL record in wiki/value-reports/ is classified as wiki_record', () => {
    const node = classifyFile('wiki/value-reports/VAL-0001.md');
    expect(node).not.toBeNull();
    expect(node?.kind).toBe('wiki_record');
    expect(node?.prefix).toBe('VAL');
  });

  it('scanDirectory: VAL records appear as wiki_record nodes in a scanned repo', async () => {
    tmp = await createBootstrappedRepo();

    // Write a VAL record
    writeRecord(tmp.dir, 'wiki/value-reports/VAL-0001.md', {
      id: 'VAL-0001',
      title: 'First value report',
      status: 'draft',
      owner: 'test',
      created: '2026-07-10',
      updated: '2026-07-10',
      window_start: '2026-06-01',
      window_end: '2026-07-01',
      base_commit: 'abc1234',
      head_commit: 'def5678',
      prior_val: 'none',
      chain_status: 'first',
    });

    const nodes = scanDirectory(tmp.dir);
    const valNode = nodes.find(n => n.id === 'wiki/value-reports/VAL-0001.md');
    expect(valNode).toBeDefined();
    expect(valNode?.kind).toBe('wiki_record');
    expect(valNode?.prefix).toBe('VAL');
  });
});

// ---------------------------------------------------------------------------
// T13.7 — MCP smoke: value-report and value-usage in tools array
// ---------------------------------------------------------------------------

describe('MCP surface smoke — value tools', () => {
  it('tools array contains value-report and value-usage', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain('value-report');
    expect(names).toContain('value-usage');
    expect(names).toContain('value-finalize');
  });

  it('value-report tool has required fields', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    const tool = tools.find((t: { name: string }) => t.name === 'value-report');
    expect(tool).toBeDefined();
    expect(tool?.description).toBeTruthy();
    expect(typeof tool?.handler).toBe('function');
    expect(tool?.inputSchema).toBeDefined();
  });

  it('value-usage tool has required fields', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    const tool = tools.find((t: { name: string }) => t.name === 'value-usage');
    expect(tool).toBeDefined();
    expect(tool?.description).toBeTruthy();
    expect(typeof tool?.handler).toBe('function');
    expect(tool?.inputSchema).toBeDefined();
  });

  it('value-finalize tool has required fields', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    const tool = tools.find((t: { name: string }) => t.name === 'value-finalize');
    expect(tool).toBeDefined();
    expect(tool?.description).toBeTruthy();
    expect(typeof tool?.handler).toBe('function');
    expect(tool?.inputSchema).toBeDefined();
  });

  it('total tool count is now 14 (11 original + 3 value tools)', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    expect(tools.length).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// T13.8 — CLI smoke: value-report and value-usage commands recognised
// ---------------------------------------------------------------------------

describe('CLI surface smoke — value commands', () => {
  it('--help output mentions value-report and value-usage', () => {
    const { stdout, exitCode } = runCli('--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('value-report');
    expect(stdout).toContain('value-usage');
  });

  it('value-report without --dir exits non-zero', () => {
    const { exitCode } = runCli('value-report');
    expect(exitCode).not.toBe(0);
  });

  it('value-usage without --dir exits non-zero', () => {
    const { exitCode } = runCli('value-usage');
    expect(exitCode).not.toBe(0);
  });

  it('value-report rejects an unknown/mistyped flag (--untilRef) instead of silently running', () => {
    // WHY: a silently-dropped mistyped flag (--untilRef vs --until-ref) let value-report fall back
    // to HEAD and report the wrong span (WK-0053). Unknown flags must fail loud, naming the flag —
    // the message (not just a non-zero exit) is what distinguishes this from a GIT_UNAVAILABLE run.
    const tmp = createTmpDir();
    try {
      const { stdout, exitCode } = runCli(`value-report --dir "${tmp.dir}" --untilRef xyz`);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('unknown flag');
      expect(stdout).toContain('--untilRef');
    } finally {
      tmp.cleanup();
    }
  });
});

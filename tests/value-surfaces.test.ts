/**
 * T13 — Propagation tests for VAL surfaces (spec §11.2, §12).
 *
 * Tests (TDD, written first):
 *   1. bootstrap lands the "Value reports" recipe in BOTH AGENTS.md and CLAUDE.md
 *   2. wiki/value-reports/ directory exists after bootstrap
 *   3. wiki/templates/value.md exists after bootstrap
 *   4. allocate --prefix VAL → VAL-0001
 *   5. sync-contract re-lands the recipe after it has been stripped
 *   6. a VAL record in wiki/value-reports/ graphs as a wiki_record node
 *   7. MCP tools array contains value-report and value-usage
 *   8. CLI dispatch recognises value-report and value-usage commands
 *
 * Stable marker string used in recipe assertions (grep for this):
 *   "value-report-recipe-v1"
 */

import { describe, it, expect, afterEach } from 'vitest';
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

/** Stable marker string embedded in the recipe text (spec §7).
 *  Both AGENTS.md and CLAUDE.md must contain this after bootstrap/sync. */
const RECIPE_MARKER = 'value-report-recipe-v1';

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

  afterEach(() => { tmp?.cleanup(); });

  it('bootstrap: AGENTS.md contains the value-report recipe marker', async () => {
    tmp = await createBootstrappedRepo();
    const agents = readText(tmp.dir, 'AGENTS.md');
    expect(agents).toContain(RECIPE_MARKER);
  });

  it('bootstrap: CLAUDE.md contains the value-report recipe marker', async () => {
    tmp = await createBootstrappedRepo();
    const claude = readText(tmp.dir, 'CLAUDE.md');
    expect(claude).toContain(RECIPE_MARKER);
  });

  it('bootstrap: wiki/value-reports/ directory exists', async () => {
    tmp = await createBootstrappedRepo();
    expect(fs.existsSync(path.join(tmp.dir, 'wiki/value-reports'))).toBe(true);
  });

  it('bootstrap: wiki/templates/value.md exists', async () => {
    tmp = await createBootstrappedRepo();
    expect(fileExists(tmp.dir, 'wiki/templates/value.md')).toBe(true);
  });

  it('bootstrap: allocate --prefix VAL returns VAL-0001', async () => {
    tmp = await createBootstrappedRepo();
    const result = await allocate({ dir: tmp.dir, prefix: 'VAL' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('VAL-0001');
    }
  });
});

// ---------------------------------------------------------------------------
// T13.5 — sync-contract re-lands the recipe
// ---------------------------------------------------------------------------

describe('VAL propagation — sync-contract re-lands recipe', () => {
  let tmp: TmpRepo;

  afterEach(() => { tmp?.cleanup(); });

  it('sync-contract restores the recipe marker after it has been stripped from AGENTS.md', async () => {
    tmp = await createBootstrappedRepo();

    // Strip the managed block from AGENTS.md (simulate a pre-recipe repo)
    const agentsPath = path.join(tmp.dir, 'AGENTS.md');
    const original = fs.readFileSync(agentsPath, 'utf-8');
    const stripped = original
      .split('\n')
      .filter(line => !line.includes(RECIPE_MARKER))
      .join('\n');
    fs.writeFileSync(agentsPath, stripped, 'utf-8');
    expect(fs.readFileSync(agentsPath, 'utf-8')).not.toContain(RECIPE_MARKER);

    // sync-contract should re-write the full managed block including the recipe
    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(agentsPath, 'utf-8')).toContain(RECIPE_MARKER);
  });

  it('sync-contract restores the recipe marker after it has been stripped from CLAUDE.md', async () => {
    tmp = await createBootstrappedRepo();

    const claudePath = path.join(tmp.dir, 'CLAUDE.md');
    const original = fs.readFileSync(claudePath, 'utf-8');
    const stripped = original
      .split('\n')
      .filter(line => !line.includes(RECIPE_MARKER))
      .join('\n');
    fs.writeFileSync(claudePath, stripped, 'utf-8');
    expect(fs.readFileSync(claudePath, 'utf-8')).not.toContain(RECIPE_MARKER);

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(claudePath, 'utf-8')).toContain(RECIPE_MARKER);
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

  it('total tool count is now 13 (11 original + 2 value tools)', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    expect(tools.length).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// T13.8 — CLI smoke: value-report and value-usage commands recognised
// ---------------------------------------------------------------------------

describe('CLI surface smoke — value commands', () => {
  it('--help output mentions value-report', () => {
    const { stdout, exitCode } = runCli('--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('value-report');
  });

  it('--help output mentions value-usage', () => {
    const { stdout, exitCode } = runCli('--help');
    expect(exitCode).toBe(0);
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
});

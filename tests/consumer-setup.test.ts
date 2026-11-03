/**
 * Tests for consuming-repo agent setup:
 * - Managed block in AGENTS.md / CLAUDE.md
 * - .mcp.json merge
 * - Idempotency / ID-safety
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { execFileSync, spawnSync } from 'node:child_process';

import {
  bootstrap,
  sync,
  create,
  findKbRoot,
  ensureGitignoreEntries,
  lint,
} from '../packages/wiki-core/src/index.js';

import {
  writeManagedBlock,
  assembleBlockBody,
  checkBlockBudget,
  dispatchInstalled,
} from '../packages/wiki-core/src/agent-instructions.js';
import { writeMcpConfig } from '../packages/wiki-core/src/mcp-config.js';
import { getAgentInstructionsSections } from '../packages/wiki-core/src/contract.js';

import type { IdState } from '../packages/wiki-core/src/index.js';

import {
  createTmpDir,
  createBootstrappedRepo,
  writeRecord,
  readJson,
  fileExists,
  readText,
  type TmpRepo,
} from './helpers/tmp-repo.js';

// ---------------------------------------------------------------------------
// Managed Block Tests
// ---------------------------------------------------------------------------

describe('managed block', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('bootstrap creates AGENTS.md and CLAUDE.md each with exactly one kb-managed block when absent', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const content = readText(tmp.dir, file);
      const beginCount = (content.match(/<!-- BEGIN kb-managed -->/g) || []).length;
      const endCount = (content.match(/<!-- END kb-managed -->/g) || []).length;
      expect(beginCount, `${file} should have exactly one BEGIN marker`).toBe(1);
      expect(endCount, `${file} should have exactly one END marker`).toBe(1);
    }
    // AGENTS.md carries the full template; CLAUDE.md is a thin redirect.
    // WK-0229 ruling 14: the single "kb integration" heading is replaced by per-tool sections.
    const agents = readText(tmp.dir, 'AGENTS.md');
    expect(agents).toContain('## kb — wiki');
    expect(agents).toContain('Retrieval');
    const claude = readText(tmp.dir, 'CLAUDE.md');
    expect(claude).toContain('@AGENTS.md');
    expect(claude).not.toContain('## kb — wiki');
  });

  it('bootstrap into a repo with existing AGENTS.md (leading H1 + consumer content) inserts block and preserves consumer content', async () => {
    tmp = createTmpDir();
    fs.writeFileSync(
      path.join(tmp.dir, 'AGENTS.md'),
      '# My Project Agent Guide\n\nCustom instructions here.\n\n## My Section\n\nKeep this.\n',
      'utf-8',
    );

    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const content = readText(tmp.dir, 'AGENTS.md');
    expect(content).toContain('# My Project Agent Guide');
    expect(content).toContain('Custom instructions here.');
    expect(content).toContain('## My Section');
    expect(content).toContain('Keep this.');
    expect(content).toContain('<!-- BEGIN kb-managed -->');
    expect(content).toContain('<!-- END kb-managed -->');

    // Block should be after H1 line
    const h1Idx = content.indexOf('# My Project Agent Guide');
    const blockIdx = content.indexOf('<!-- BEGIN kb-managed -->');
    expect(blockIdx).toBeGreaterThan(h1Idx);
  });

  it('second bootstrap does not duplicate the block (exactly one BEGIN/END pair) and leaves outside-content untouched', async () => {
    tmp = createTmpDir();
    fs.writeFileSync(
      path.join(tmp.dir, 'AGENTS.md'),
      '# My Agents\n\nMy content stays.\n',
      'utf-8',
    );

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    const content = readText(tmp.dir, 'AGENTS.md');
    const beginCount = (content.match(/<!-- BEGIN kb-managed -->/g) || []).length;
    const endCount = (content.match(/<!-- END kb-managed -->/g) || []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
    expect(content).toContain('My content stays.');
  });

  it('sync refreshes a stale managed block while preserving content outside markers', async () => {
    tmp = await createBootstrappedRepo();

    // Write a stale block
    const staleBlock =
      '# My File\n\n' +
      '<!-- BEGIN kb-managed -->\n' +
      'Start from `wiki/catalog.md`\n' +
      '<!-- END kb-managed -->\n\n' +
      'My custom content.\n';
    fs.writeFileSync(path.join(tmp.dir, 'AGENTS.md'), staleBlock, 'utf-8');
    fs.writeFileSync(path.join(tmp.dir, 'CLAUDE.md'), staleBlock, 'utf-8');

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);

    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const content = readText(tmp.dir, file);
      expect(content).not.toContain('Start from `wiki/catalog.md`');
      expect(content).toContain('My custom content.');
      expect(content).toContain('# My File');
    }
    // AGENTS.md carries the full refreshed template
    const agents = readText(tmp.dir, 'AGENTS.md');
    expect(agents).toContain('Retrieval');
    expect(agents).toContain('MCP');
    // CLAUDE.md is a thin redirect
    const claude = readText(tmp.dir, 'CLAUDE.md');
    expect(claude).toContain('@AGENTS.md');
  });

  it('dryRun/check does not write managed block', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo', dryRun: true });
    expect(result.ok).toBe(true);

    expect(fs.existsSync(path.join(tmp.dir, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.dir, 'CLAUDE.md'))).toBe(false);
  });

  it('--no-agent-instructions skips managed block', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({
      dir: tmp.dir,
      repo: 'test/repo',
      agentInstructions: false,
    });
    expect(result.ok).toBe(true);

    expect(fs.existsSync(path.join(tmp.dir, 'AGENTS.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeManagedBlock unit tests
// ---------------------------------------------------------------------------

describe('writeManagedBlock', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('creates file when absent', () => {
    tmp = createTmpDir();
    const result = writeManagedBlock(tmp.dir, 'Test block content');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBe(2);
      for (const entry of result.data) {
        expect(entry.action).toBe('created');
      }
    }
    expect(fileExists(tmp.dir, 'AGENTS.md')).toBe(true);
    expect(fileExists(tmp.dir, 'CLAUDE.md')).toBe(true);
  });

  it('inserts after leading H1 when no markers exist', () => {
    tmp = createTmpDir();
    fs.writeFileSync(path.join(tmp.dir, 'AGENTS.md'), '# Heading\n\nBody text.\n', 'utf-8');
    const result = writeManagedBlock(tmp.dir, 'Block body');
    expect(result.ok).toBe(true);

    const content = readText(tmp.dir, 'AGENTS.md');
    const headingEnd = content.indexOf('\n', content.indexOf('# Heading'));
    const blockStart = content.indexOf('<!-- BEGIN kb-managed -->');
    expect(blockStart).toBeGreaterThan(headingEnd);
    expect(content).toContain('Body text.');
  });

  it('inserts at top when no H1 and no markers', () => {
    tmp = createTmpDir();
    fs.writeFileSync(path.join(tmp.dir, 'AGENTS.md'), 'No heading here.\n', 'utf-8');
    const result = writeManagedBlock(tmp.dir, 'Block body');
    expect(result.ok).toBe(true);

    const content = readText(tmp.dir, 'AGENTS.md');
    expect(content.startsWith('<!-- BEGIN kb-managed -->')).toBe(true);
    expect(content).toContain('No heading here.');
  });

  it('replaces between markers when identical → unchanged', () => {
    tmp = createTmpDir();
    const body = 'Same body';
    writeManagedBlock(tmp.dir, body);
    const result = writeManagedBlock(tmp.dir, body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const entry of result.data) {
        expect(entry.action).toBe('unchanged');
      }
    }
  });

  it('replaces between markers when content differs → updated', () => {
    tmp = createTmpDir();
    writeManagedBlock(tmp.dir, 'Old body');
    const result = writeManagedBlock(tmp.dir, 'New body');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // AGENTS.md gets the new body → updated
      const agentsEntry = result.data.find(e => e.file === 'AGENTS.md');
      expect(agentsEntry?.action).toBe('updated');
      // CLAUDE.md always gets @AGENTS.md → unchanged (body param doesn't affect it)
      const claudeEntry = result.data.find(e => e.file === 'CLAUDE.md');
      expect(claudeEntry?.action).toBe('unchanged');
    }
    const content = readText(tmp.dir, 'AGENTS.md');
    expect(content).toContain('New body');
    expect(content).not.toContain('Old body');
  });

  it('respects dryRun', () => {
    tmp = createTmpDir();
    const result = writeManagedBlock(tmp.dir, 'Body', { dryRun: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const entry of result.data) {
        expect(entry.action).toBe('created');
      }
    }
    expect(fs.existsSync(path.join(tmp.dir, 'AGENTS.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// .mcp.json Tests
// ---------------------------------------------------------------------------

describe('.mcp.json', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('bootstrap creates .mcp.json with kb-wiki but no kb-dispatch when wiki/.dispatch/ is absent (ruling 4)', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    expect(fileExists(tmp.dir, '.mcp.json')).toBe(true);
    const config = readJson<{ mcpServers: Record<string, unknown> }>(tmp.dir, '.mcp.json');
    expect(config.mcpServers['kb-wiki']).toBeDefined();
    expect(config.mcpServers['kb-dispatch']).toBeUndefined();

    const kbRoot = findKbRoot();
    const wikiEntry = config.mcpServers['kb-wiki'] as { command: string; args: string[] };
    expect(wikiEntry.command).toBe('node');
    expect(wikiEntry.args.some((a: string) => a.includes(kbRoot.replace(/\\/g, '/')))).toBe(true);
  });

  it('bootstrap creates .mcp.json with kb-dispatch when wiki/.dispatch/ exists', async () => {
    tmp = createTmpDir();
    fs.mkdirSync(path.join(tmp.dir, 'wiki', '.dispatch'), { recursive: true });
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const config = readJson<{ mcpServers: Record<string, unknown> }>(tmp.dir, '.mcp.json');
    expect(config.mcpServers['kb-wiki']).toBeDefined();
    expect(config.mcpServers['kb-dispatch']).toBeDefined();
  });

  it('bootstrap merges into existing .mcp.json preserving other servers', async () => {
    tmp = createTmpDir();
    fs.writeFileSync(
      path.join(tmp.dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'my-server': { type: 'stdio', command: 'echo', args: ['hello'] },
        },
      }, null, 2) + '\n',
      'utf-8',
    );

    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const config = readJson<{ mcpServers: Record<string, unknown> }>(tmp.dir, '.mcp.json');
    expect(config.mcpServers['my-server']).toBeDefined();
    expect(config.mcpServers['kb-wiki']).toBeDefined();
    expect(config.mcpServers['kb-dispatch']).toBeUndefined();
  });

  it('second bootstrap is idempotent (file byte-identical)', async () => {
    tmp = createTmpDir();
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    const first = fs.readFileSync(path.join(tmp.dir, '.mcp.json'), 'utf-8');

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    const second = fs.readFileSync(path.join(tmp.dir, '.mcp.json'), 'utf-8');

    expect(second).toBe(first);
  });

  it('client codex writes no .mcp.json and returns a kb-wiki-only command when wiki/.dispatch/ is absent', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo', mcpClient: 'codex' });
    expect(result.ok).toBe(true);

    expect(fs.existsSync(path.join(tmp.dir, '.mcp.json'))).toBe(false);
    if (result.ok) {
      expect(result.data.instructions).toBeDefined();
      expect(result.data.instructions!.some(i => i.includes('codex mcp add kb-wiki'))).toBe(true);
      expect(result.data.instructions!.some(i => i.includes('codex mcp add kb-dispatch'))).toBe(false);
    }
  });

  it('malformed existing .mcp.json fails without clobbering', async () => {
    tmp = createTmpDir();
    fs.writeFileSync(path.join(tmp.dir, '.mcp.json'), '{ not valid json', 'utf-8');

    const result = writeMcpConfig(tmp.dir, { client: 'claude', dispatch: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('MCP_CONFIG_PARSE_ERROR');
    }

    // File should not be clobbered
    expect(fs.readFileSync(path.join(tmp.dir, '.mcp.json'), 'utf-8')).toBe('{ not valid json');
  });

  it('--mcp-client none skips .mcp.json', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo', mcpClient: 'none' });
    expect(result.ok).toBe(true);

    expect(fs.existsSync(path.join(tmp.dir, '.mcp.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeMcpConfig unit tests
// ---------------------------------------------------------------------------

describe('writeMcpConfig', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('creates new .mcp.json when absent', () => {
    tmp = createTmpDir();
    const result = writeMcpConfig(tmp.dir, { client: 'claude', dispatch: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('created');
    }
  });

  it('codex returns a kb-dispatch command only when dispatch is true', () => {
    tmp = createTmpDir();
    const withoutDispatch = writeMcpConfig(tmp.dir, { client: 'codex', dispatch: false });
    expect(withoutDispatch.ok).toBe(true);
    if (withoutDispatch.ok) {
      expect(withoutDispatch.data.commands).toBeDefined();
      expect(withoutDispatch.data.commands!.length).toBe(1);
      expect(withoutDispatch.data.commands![0]).toContain('codex mcp add kb-wiki');
    }

    const withDispatch = writeMcpConfig(tmp.dir, { client: 'codex', dispatch: true });
    expect(withDispatch.ok).toBe(true);
    if (withDispatch.ok) {
      expect(withDispatch.data.commands!.length).toBe(2);
      expect(withDispatch.data.commands![1]).toContain('codex mcp add kb-dispatch');
    }
    expect(fs.existsSync(path.join(tmp.dir, '.mcp.json'))).toBe(false);
  });

  it('none returns skipped', () => {
    tmp = createTmpDir();
    const result = writeMcpConfig(tmp.dir, { client: 'none', dispatch: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('skipped');
    }
  });

  it('dryRun does not write', () => {
    tmp = createTmpDir();
    const result = writeMcpConfig(tmp.dir, { client: 'claude', dispatch: false, dryRun: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('created');
    }
    expect(fs.existsSync(path.join(tmp.dir, '.mcp.json'))).toBe(false);
  });

  it('dispatch: true sets kb-dispatch; dispatch: false removes an existing kb-dispatch entry', () => {
    tmp = createTmpDir();
    writeMcpConfig(tmp.dir, { client: 'claude', dispatch: true });
    let config = readJson<{ mcpServers: Record<string, unknown> }>(tmp.dir, '.mcp.json');
    expect(config.mcpServers['kb-dispatch']).toBeDefined();

    writeMcpConfig(tmp.dir, { client: 'claude', dispatch: false });
    config = readJson<{ mcpServers: Record<string, unknown> }>(tmp.dir, '.mcp.json');
    expect(config.mcpServers['kb-dispatch']).toBeUndefined();
    expect(config.mcpServers['kb-wiki']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency / ID-Safety Tests
// ---------------------------------------------------------------------------

describe('idempotency and ID-safety', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('bootstrap twice over a repo with existing WK records: .id-state.json unchanged on 2nd run, correct next ID', async () => {
    tmp = createTmpDir();

    // First bootstrap
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    // Create some records
    for (let i = 1; i <= 3; i++) {
      const id = `WK-${String(i).padStart(4, '0')}`;
      writeRecord(tmp.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Issue ${i}`,
        type: 'task',
        status: 'inbox',
        priority: 'medium',
        owner: 'test',
        created: '2026-01-01',
        updated: '2026-01-01',
      });
    }

    // Manually fix up id-state to reflect the records
    const state1: IdState = readJson(tmp.dir, 'wiki/.id-state.json');
    state1['WK'] = { next: 4, allocated: [1, 2, 3] };
    fs.writeFileSync(
      path.join(tmp.dir, 'wiki/.id-state.json'),
      JSON.stringify(state1, null, 2) + '\n',
      'utf-8',
    );

    const stateBefore = fs.readFileSync(path.join(tmp.dir, 'wiki/.id-state.json'), 'utf-8');

    // Second bootstrap
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    const stateAfter = fs.readFileSync(path.join(tmp.dir, 'wiki/.id-state.json'), 'utf-8');
    expect(stateAfter).toBe(stateBefore);

    // Managed block should still be single
    const agents = readText(tmp.dir, 'AGENTS.md');
    const beginCount = (agents.match(/<!-- BEGIN kb-managed -->/g) || []).length;
    expect(beginCount).toBe(1);

    // Next create should return correct ID
    const createResult = await create({ dir: tmp.dir, prefix: 'WK', title: 'New issue' });
    expect(createResult.ok).toBe(true);
    if (createResult.ok) {
      expect(createResult.data.id).toBe('WK-0004');
    }
  });
});

// ---------------------------------------------------------------------------
// .gitignore Tests
// ---------------------------------------------------------------------------

describe('.gitignore', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('bootstrap creates .gitignore with .agent-runs/ when absent', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const content = readText(tmp.dir, '.gitignore');
    expect(content).toContain('.agent-runs/');
  });

  it('bootstrap appends .agent-runs/ to existing .gitignore', async () => {
    tmp = createTmpDir();
    fs.writeFileSync(path.join(tmp.dir, '.gitignore'), 'node_modules/\ndist/\n', 'utf-8');

    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const content = readText(tmp.dir, '.gitignore');
    expect(content).toContain('node_modules/');
    expect(content).toContain('dist/');
    expect(content).toContain('.agent-runs/');
  });

  it('bootstrap is idempotent — does not duplicate .agent-runs/', async () => {
    tmp = createTmpDir();
    fs.writeFileSync(path.join(tmp.dir, '.gitignore'), '.agent-runs/\n', 'utf-8');

    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const content = readText(tmp.dir, '.gitignore');
    const count = (content.match(/\.agent-runs\//g) || []).length;
    expect(count).toBe(1);
  });

  it('sync adds .agent-runs/ to existing repo missing the entry', async () => {
    tmp = await createBootstrappedRepo();
    // Remove the entry that bootstrap just added
    const gitignorePath = path.join(tmp.dir, '.gitignore');
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    fs.writeFileSync(gitignorePath, content.replace('.agent-runs/\n', ''), 'utf-8');

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);

    const after = readText(tmp.dir, '.gitignore');
    expect(after).toContain('.agent-runs/');
  });

  it('dryRun does not write .gitignore', async () => {
    tmp = createTmpDir();
    await bootstrap({ dir: tmp.dir, repo: 'test/repo', dryRun: true });
    expect(fs.existsSync(path.join(tmp.dir, '.gitignore'))).toBe(false);
  });

  it('bootstrap writes .mcp.json to .gitignore; a re-run is idempotent (no duplicate line)', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const content = readText(tmp.dir, '.gitignore');
    expect(content).toContain('.mcp.json');

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    const after = readText(tmp.dir, '.gitignore');
    const count = (after.match(/^\.mcp\.json$/gm) || []).length;
    expect(count).toBe(1);
  });

  it('sync-contract adds .mcp.json to .gitignore in an already-bootstrapped repo', async () => {
    tmp = await createBootstrappedRepo();
    // Remove the entry that bootstrap just added.
    const gitignorePath = path.join(tmp.dir, '.gitignore');
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    fs.writeFileSync(gitignorePath, content.replace('.mcp.json\n', ''), 'utf-8');
    expect(readText(tmp.dir, '.gitignore')).not.toContain('.mcp.json');

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);

    expect(readText(tmp.dir, '.gitignore')).toContain('.mcp.json');
  });
});

// ---------------------------------------------------------------------------
// MCP_CONFIG_TRACKED lint rule (WK-0254)
// ---------------------------------------------------------------------------

describe('lint: MCP_CONFIG_TRACKED', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  it('reports the named error when .mcp.json is tracked in a git repo', async () => {
    tmp = await createBootstrappedRepo();
    git(tmp.dir, 'init', '-q');
    git(tmp.dir, 'config', 'user.email', 'test@example.com');
    git(tmp.dir, 'config', 'user.name', 'Test');
    // -f: .mcp.json is now gitignored by default, but a repo that tracked it before
    // that gitignore entry existed (the exact WK-0254 defect) still has it tracked.
    git(tmp.dir, 'add', '-f', '.mcp.json');
    git(tmp.dir, 'commit', '-q', '-m', 'track .mcp.json');

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const diag = result.data.diagnostics.find(d => d.code === 'MCP_CONFIG_TRACKED');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('error');
    expect(diag?.message).toContain('git rm --cached .mcp.json');
  });

  it('reports no MCP_CONFIG_TRACKED error when .mcp.json is untracked', async () => {
    tmp = await createBootstrappedRepo();
    git(tmp.dir, 'init', '-q');
    git(tmp.dir, 'config', 'user.email', 'test@example.com');
    git(tmp.dir, 'config', 'user.name', 'Test');
    // Deliberately do not add/commit .mcp.json — it stays untracked.

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const diag = result.data.diagnostics.find(d => d.code === 'MCP_CONFIG_TRACKED');
    expect(diag).toBeUndefined();
  });

  it('reports no MCP_CONFIG_TRACKED error when the target is not a git repo', async () => {
    tmp = await createBootstrappedRepo();
    // No `git init` — tmp.dir is not a git repo at all.

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const diag = result.data.diagnostics.find(d => d.code === 'MCP_CONFIG_TRACKED');
    expect(diag).toBeUndefined();
  });

  it('reports MCP_CONFIG_TRACKED_CHECK_FAILED with its cause when the git check itself fails, inside a real repo', async () => {
    tmp = await createBootstrappedRepo();
    git(tmp.dir, 'init', '-q');
    git(tmp.dir, 'config', 'user.email', 'test@example.com');
    git(tmp.dir, 'config', 'user.name', 'Test');
    git(tmp.dir, 'add', '-A');
    git(tmp.dir, 'commit', '-q', '-m', 'seed');

    // Seam: PATH without git, independent of host git state. The repo is real
    // and would otherwise be a clean "untracked" result — the failure must be
    // read as an error, never as "untracked" (rule 24, HO-0190 F1).
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    let result: Awaited<ReturnType<typeof lint>>;
    try {
      result = await lint({ dir: tmp.dir });
    } finally {
      process.env.PATH = originalPath;
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tracked = result.data.diagnostics.find(d => d.code === 'MCP_CONFIG_TRACKED');
    expect(tracked).toBeUndefined();

    const failed = result.data.diagnostics.find(d => d.code === 'MCP_CONFIG_TRACKED_CHECK_FAILED');
    expect(failed).toBeDefined();
    expect(failed?.severity).toBe('error');
    expect(failed?.file).toBe('.mcp.json');
    expect(failed?.message).toContain('.mcp.json');
    expect(failed?.message).toMatch(/ENOENT|git/i);
  });
});

describe('ensureGitignoreEntries', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('creates .gitignore when absent', () => {
    tmp = createTmpDir();
    const result = ensureGitignoreEntries(tmp.dir);
    expect(result.action).toBe('created');
    expect(readText(tmp.dir, '.gitignore')).toBe('.agent-runs/\n.mcp.json\n');
  });

  it('appends missing entry to existing file', () => {
    tmp = createTmpDir();
    fs.writeFileSync(path.join(tmp.dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    const result = ensureGitignoreEntries(tmp.dir);
    expect(result.action).toBe('updated');
    expect(readText(tmp.dir, '.gitignore')).toBe('node_modules/\n.agent-runs/\n.mcp.json\n');
  });

  it('appends newline before entry when file lacks trailing newline', () => {
    tmp = createTmpDir();
    fs.writeFileSync(path.join(tmp.dir, '.gitignore'), 'node_modules/', 'utf-8');
    const result = ensureGitignoreEntries(tmp.dir);
    expect(result.action).toBe('updated');
    expect(readText(tmp.dir, '.gitignore')).toBe('node_modules/\n.agent-runs/\n.mcp.json\n');
  });

  it('returns unchanged when entry already present', () => {
    tmp = createTmpDir();
    fs.writeFileSync(path.join(tmp.dir, '.gitignore'), '.agent-runs/\n.mcp.json\n', 'utf-8');
    const result = ensureGitignoreEntries(tmp.dir);
    expect(result.action).toBe('unchanged');
  });

  it('dryRun reports action without writing', () => {
    tmp = createTmpDir();
    const result = ensureGitignoreEntries(tmp.dir, { dryRun: true });
    expect(result.action).toBe('created');
    expect(fs.existsSync(path.join(tmp.dir, '.gitignore'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAgentInstructionsSections
// ---------------------------------------------------------------------------

describe('getAgentInstructionsSections', () => {
  it('returns the four sections in order wiki, dispatch, guidelines, footer, with only dispatch requiring dispatch', () => {
    const result = getAgentInstructionsSections();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map(s => s.id)).toEqual(['wiki', 'dispatch', 'guidelines', 'footer']);
      for (const section of result.data) {
        if (section.id === 'dispatch') {
          expect(section.requires).toBe('dispatch');
        } else {
          expect(section.requires).toBeUndefined();
        }
        expect(section.body.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Per-tool fixture diff (WK-0229 ruling 4, ruling 14)
// ---------------------------------------------------------------------------

describe('per-tool section gating', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('dispatch section and .mcp.json kb-dispatch entry appear only while wiki/.dispatch/ exists', async () => {
    tmp = await createBootstrappedRepo();

    // No wiki/.dispatch/ yet — sync emits neither.
    await sync({ dir: tmp.dir });
    let agents = readText(tmp.dir, 'AGENTS.md');
    let mcp = readJson<{ mcpServers: Record<string, unknown> }>(tmp.dir, '.mcp.json');
    expect(agents).not.toContain('## kb — dispatch');
    expect(mcp.mcpServers['kb-dispatch']).toBeUndefined();

    // Create wiki/.dispatch/ and sync again — both appear.
    fs.mkdirSync(path.join(tmp.dir, 'wiki', '.dispatch'), { recursive: true });
    await sync({ dir: tmp.dir });
    agents = readText(tmp.dir, 'AGENTS.md');
    mcp = readJson<{ mcpServers: Record<string, unknown> }>(tmp.dir, '.mcp.json');
    expect(agents).toContain('## kb — dispatch');
    expect(mcp.mcpServers['kb-dispatch']).toBeDefined();

    // Remove wiki/.dispatch/ and sync — both are gone.
    fs.rmSync(path.join(tmp.dir, 'wiki', '.dispatch'), { recursive: true, force: true });
    await sync({ dir: tmp.dir });
    agents = readText(tmp.dir, 'AGENTS.md');
    mcp = readJson<{ mcpServers: Record<string, unknown> }>(tmp.dir, '.mcp.json');
    expect(agents).not.toContain('## kb — dispatch');
    expect(mcp.mcpServers['kb-dispatch']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Outside-marker survival (WK-0229 acceptance criteria)
// ---------------------------------------------------------------------------

describe('outside-marker survival', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('text before and after the markers survives bootstrap and sync byte-for-byte; a hand edit inside is restored', async () => {
    tmp = createTmpDir();
    const before = '# Repo Agents\n\nBefore-marker content, repo-owned.\n\n';
    const after = '\n## Repo Rules\n\nAfter-marker content, repo-owned.\n';
    const seed =
      before + '<!-- BEGIN kb-managed -->\nplaceholder\n<!-- END kb-managed -->' + after;
    fs.writeFileSync(path.join(tmp.dir, 'AGENTS.md'), seed, 'utf-8');

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    const afterBootstrap = readText(tmp.dir, 'AGENTS.md');
    const beginIdx1 = afterBootstrap.indexOf('<!-- BEGIN kb-managed -->');
    const endIdx1 = afterBootstrap.indexOf('<!-- END kb-managed -->') + '<!-- END kb-managed -->'.length;
    expect(afterBootstrap.slice(0, beginIdx1)).toBe(before);
    expect(afterBootstrap.slice(endIdx1)).toBe(after);

    // Hand-edit inside the markers.
    const handEdited =
      afterBootstrap.slice(0, beginIdx1) +
      '<!-- BEGIN kb-managed -->\nHand-edited content.\n<!-- END kb-managed -->' +
      afterBootstrap.slice(endIdx1);
    fs.writeFileSync(path.join(tmp.dir, 'AGENTS.md'), handEdited, 'utf-8');

    await sync({ dir: tmp.dir });

    const afterSync = readText(tmp.dir, 'AGENTS.md');
    const beginIdx2 = afterSync.indexOf('<!-- BEGIN kb-managed -->');
    const endIdx2 = afterSync.indexOf('<!-- END kb-managed -->') + '<!-- END kb-managed -->'.length;
    expect(afterSync.slice(0, beginIdx2)).toBe(before);
    expect(afterSync.slice(endIdx2)).toBe(after);
    expect(afterSync).not.toContain('Hand-edited content.');
    expect(afterSync).toContain('## kb — wiki');
  });
});

// ---------------------------------------------------------------------------
// Shipped-text checks (WK-0229 rulings 9, 14, 15, 16)
// ---------------------------------------------------------------------------

describe('dispatchInstalled', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('is false when wiki/.dispatch/ is absent and true once created', () => {
    tmp = createTmpDir();
    expect(dispatchInstalled(tmp.dir)).toBe(false);
    fs.mkdirSync(path.join(tmp.dir, 'wiki', '.dispatch'), { recursive: true });
    expect(dispatchInstalled(tmp.dir)).toBe(true);
  });
});

describe('shipped block text', () => {
  it('checkBlockBudget is ok with words in the range 2,000-4,000', () => {
    const sectionsResult = getAgentInstructionsSections();
    expect(sectionsResult.ok).toBe(true);
    if (sectionsResult.ok) {
      const budgetResult = checkBlockBudget(sectionsResult.data);
      expect(budgetResult.ok).toBe(true);
      if (budgetResult.ok) {
        expect(budgetResult.data.words).toBeGreaterThanOrEqual(2000);
        expect(budgetResult.data.words).toBeLessThanOrEqual(4000);
      }
    }
  });

  it('the emitted block carries the approved text with no resolution, escalation, or ledger-code language', () => {
    const sectionsResult = getAgentInstructionsSections();
    expect(sectionsResult.ok).toBe(true);
    if (!sectionsResult.ok) return;

    const emitted = assembleBlockBody(sectionsResult.data, { dispatch: true });
    expect(emitted).toContain('65. **Keep one source of truth per fact.**');
    expect(emitted).toContain('66. **Mark every shortcut.**');
    expect(emitted).toContain('67. **Every deferral carries a written re-open trigger,**');
    expect(emitted).not.toMatch(/^68\. /m);
    expect(emitted).toContain('## kb — wiki');
    expect(emitted).not.toContain('/resolve');
    expect(emitted.toLowerCase()).not.toMatch(/escalat/);
    expect(emitted).not.toMatch(/\bRD-\d+\b/);
    expect(emitted).not.toMatch(/Dashboard/);
  });
});

// ---------------------------------------------------------------------------
// scripts/setup-test-kb.mjs: required slug, no guessed default (WK-0254, HO-0190 F1)
// ---------------------------------------------------------------------------

describe('setup-test-kb.mjs', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('exits non-zero, names both slug forms, and creates nothing when no slug is given', () => {
    tmp = createTmpDir();

    // Place a copy of the script at <tmp>/kb/scripts/setup-test-kb.mjs so the
    // script's own path resolution (KB = scriptDir/.., TEST_KB = KB/../test_kb)
    // lands entirely inside the temp root — never the real sibling ../test_kb.
    const kbRoot = path.join(tmp.dir, 'kb');
    const scriptDir = path.join(kbRoot, 'scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'setup-test-kb.mjs');
    fs.copyFileSync(path.resolve(process.cwd(), 'scripts/setup-test-kb.mjs'), scriptPath);
    const testKb = path.join(tmp.dir, 'test_kb');

    const env = { ...process.env };
    delete env.TEST_KB_REPO;

    const result = spawnSync('node', [scriptPath], { cwd: kbRoot, env, encoding: 'utf-8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('npm run setup:test-kb -- <owner>/test_kb');
    expect(result.stderr).toContain('TEST_KB_REPO');
    expect(fs.existsSync(testKb)).toBe(false);
  });
});

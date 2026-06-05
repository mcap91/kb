/**
 * Tests for consuming-repo agent setup:
 * - Managed block in AGENTS.md / CLAUDE.md
 * - .mcp.json merge
 * - Idempotency / ID-safety
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  bootstrap,
  sync,
  create,
  findKbRoot,
} from '../packages/wiki-core/src/index.js';

import { writeManagedBlock } from '../packages/wiki-core/src/agent-instructions.js';
import { writeMcpConfig } from '../packages/wiki-core/src/mcp-config.js';
import { getAgentInstructionsTemplate } from '../packages/wiki-core/src/contract.js';

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
      expect(content).toContain('kb integration');
      expect(content).toContain('Retrieval');
    }
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
      expect(content).toContain('Retrieval');
      expect(content).toContain('MCP');
      expect(content).toContain('My custom content.');
      expect(content).toContain('# My File');
    }
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
      for (const entry of result.data) {
        expect(entry.action).toBe('updated');
      }
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

  it('bootstrap creates .mcp.json with kb-wiki + kb-dispatch pointing at resolved kb paths', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    expect(fileExists(tmp.dir, '.mcp.json')).toBe(true);
    const config = readJson<{ mcpServers: Record<string, unknown> }>(tmp.dir, '.mcp.json');
    expect(config.mcpServers['kb-wiki']).toBeDefined();
    expect(config.mcpServers['kb-dispatch']).toBeDefined();

    const kbRoot = findKbRoot();
    const wikiEntry = config.mcpServers['kb-wiki'] as { command: string; args: string[] };
    expect(wikiEntry.command).toBe('node');
    expect(wikiEntry.args.some((a: string) => a.includes(kbRoot.replace(/\\/g, '/')))).toBe(true);
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
    expect(config.mcpServers['kb-dispatch']).toBeDefined();
  });

  it('second bootstrap is idempotent (file byte-identical)', async () => {
    tmp = createTmpDir();
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    const first = fs.readFileSync(path.join(tmp.dir, '.mcp.json'), 'utf-8');

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    const second = fs.readFileSync(path.join(tmp.dir, '.mcp.json'), 'utf-8');

    expect(second).toBe(first);
  });

  it('client codex writes no .mcp.json and returns codex mcp add commands', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo', mcpClient: 'codex' });
    expect(result.ok).toBe(true);

    expect(fs.existsSync(path.join(tmp.dir, '.mcp.json'))).toBe(false);
    if (result.ok) {
      expect(result.data.instructions).toBeDefined();
      expect(result.data.instructions!.length).toBeGreaterThan(0);
      expect(result.data.instructions!.some(i => i.includes('codex mcp add'))).toBe(true);
    }
  });

  it('malformed existing .mcp.json fails without clobbering', async () => {
    tmp = createTmpDir();
    fs.writeFileSync(path.join(tmp.dir, '.mcp.json'), '{ not valid json', 'utf-8');

    const result = writeMcpConfig(tmp.dir, { client: 'claude' });
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
    const result = writeMcpConfig(tmp.dir, { client: 'claude' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('created');
    }
  });

  it('codex returns commands without writing a file', () => {
    tmp = createTmpDir();
    const result = writeMcpConfig(tmp.dir, { client: 'codex' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('skipped');
      expect(result.data.commands).toBeDefined();
      expect(result.data.commands!.length).toBe(2);
      expect(result.data.commands![0]).toContain('codex mcp add kb-wiki');
      expect(result.data.commands![1]).toContain('codex mcp add kb-dispatch');
    }
    expect(fs.existsSync(path.join(tmp.dir, '.mcp.json'))).toBe(false);
  });

  it('none returns skipped', () => {
    tmp = createTmpDir();
    const result = writeMcpConfig(tmp.dir, { client: 'none' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('skipped');
    }
  });

  it('dryRun does not write', () => {
    tmp = createTmpDir();
    const result = writeMcpConfig(tmp.dir, { client: 'claude', dryRun: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('created');
    }
    expect(fs.existsSync(path.join(tmp.dir, '.mcp.json'))).toBe(false);
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
// getAgentInstructionsTemplate
// ---------------------------------------------------------------------------

describe('getAgentInstructionsTemplate', () => {
  it('returns the template content from contract/agent-instructions.md', () => {
    const result = getAgentInstructionsTemplate();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain('kb integration');
      expect(result.data).toContain('Retrieval');
    }
  });
});

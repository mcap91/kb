/**
 * WK-0261 slice s1: the planning layer.
 *
 * Layers are cumulative: wiki (always) ⊂ planning ⊂ dispatch. The planning layer is
 * active when `"planning"` is in the committed `wiki/.wiki-contract.json` `layers`
 * array, or when `wiki/.dispatch/` exists (dispatch implies planning).
 *
 * Sections are identified by the full body read from contract/agent-instructions/*.md
 * at test time — never by a hardcoded copy of the contract text.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  bootstrap,
  sync,
  initPlanning,
  getAgentInstructionsSections,
} from '../packages/wiki-core/src/index.js';
import {
  assembleBlockBody,
  countBlockWords,
  checkBlockBudget,
  planningInstalled,
} from '../packages/wiki-core/src/agent-instructions.js';
import {
  createTmpDir,
  readJson,
  readText,
  type TmpRepo,
} from './helpers/tmp-repo.js';

const sectionsResult = getAgentInstructionsSections();
if (!sectionsResult.ok) {
  throw new Error(`Failed to read agent-instructions sections: ${sectionsResult.message}`);
}

const SECTIONS = Object.fromEntries(
  sectionsResult.data.map(section => [section.id, section.body]),
) as Record<'wiki' | 'dispatch' | 'guidelines' | 'footer', string>;

interface McpConfig {
  mcpServers: Record<string, unknown>;
}

function managedBlock(content: string): string {
  const begin = content.indexOf('<!-- BEGIN kb-managed -->');
  const end = content.indexOf('<!-- END kb-managed -->');
  if (begin === -1 || end === -1) throw new Error('managed block markers not found');
  return content.slice(begin, end + '<!-- END kb-managed -->'.length);
}

function readContract(dir: string): {
  layers?: string[];
  repo: string;
  bootstrappedAt: string;
  contractVersion: string;
  lastSyncedAt?: string;
} {
  return readJson(dir, 'wiki/.wiki-contract.json');
}

describe('planning layer (WK-0261 s1)', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('(a) bootstrap alone emits the wiki section only — no guidelines, footer, or dispatch — and no kb-dispatch server', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/planning-a' });
    expect(result.ok).toBe(true);

    const agents = readText(tmp.dir, 'AGENTS.md');
    expect(agents).toContain(SECTIONS.wiki);
    expect(agents).not.toContain(SECTIONS.guidelines);
    expect(agents).not.toContain(SECTIONS.footer);
    expect(agents).not.toContain(SECTIONS.dispatch);

    // CLAUDE.md is the thin redirect to AGENTS.md (not a second copy of the block).
    const claude = readText(tmp.dir, 'CLAUDE.md');
    expect(claude).toContain('@AGENTS.md');
    expect(claude).not.toContain(SECTIONS.guidelines);
    expect(claude).not.toContain(SECTIONS.footer);
    expect(claude).not.toContain(SECTIONS.dispatch);

    const mcp = readJson<McpConfig>(tmp.dir, '.mcp.json');
    expect(mcp.mcpServers['kb-wiki']).toBeDefined();
    expect(mcp.mcpServers['kb-dispatch']).toBeUndefined();
  });

  it('(b) initPlanning then sync adds guidelines and footer, keeps dispatch absent, and leaves .mcp.json unchanged', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/planning-b' })).ok).toBe(true);

    const mcpBefore = fs.readFileSync(path.join(tmp.dir, '.mcp.json'), 'utf-8');

    const init = initPlanning({ dir: tmp.dir });
    expect(init.ok).toBe(true);
    if (init.ok) {
      expect(init.data.layers).toEqual(['planning']);
      expect(init.data.changed).toBe(true);
    }

    expect((await sync({ dir: tmp.dir })).ok).toBe(true);

    const agents = readText(tmp.dir, 'AGENTS.md');
    expect(agents).toContain(SECTIONS.wiki);
    expect(agents).toContain(SECTIONS.guidelines);
    expect(agents).toContain(SECTIONS.footer);
    expect(agents).not.toContain(SECTIONS.dispatch);

    const mcpAfter = fs.readFileSync(path.join(tmp.dir, '.mcp.json'), 'utf-8');
    expect(mcpAfter).toBe(mcpBefore);
    const mcp = readJson<McpConfig>(tmp.dir, '.mcp.json');
    expect(mcp.mcpServers['kb-dispatch']).toBeUndefined();
  });

  it('(c) initPlanning({ remove: true }) then sync returns the managed blocks byte-identical to the wiki-only state', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/planning-c' })).ok).toBe(true);

    const agentsBefore = managedBlock(readText(tmp.dir, 'AGENTS.md'));
    const claudeBefore = managedBlock(readText(tmp.dir, 'CLAUDE.md'));

    expect(initPlanning({ dir: tmp.dir }).ok).toBe(true);
    expect((await sync({ dir: tmp.dir })).ok).toBe(true);
    expect(readText(tmp.dir, 'AGENTS.md')).toContain(SECTIONS.guidelines);

    const remove = initPlanning({ dir: tmp.dir, remove: true });
    expect(remove.ok).toBe(true);
    if (remove.ok) {
      expect(remove.data.layers).toEqual([]);
      expect(remove.data.changed).toBe(true);
    }
    expect((await sync({ dir: tmp.dir })).ok).toBe(true);

    expect(managedBlock(readText(tmp.dir, 'AGENTS.md'))).toBe(agentsBefore);
    expect(managedBlock(readText(tmp.dir, 'CLAUDE.md'))).toBe(claudeBefore);
    expect(readText(tmp.dir, 'AGENTS.md')).not.toContain(SECTIONS.guidelines);
    expect(readText(tmp.dir, 'AGENTS.md')).not.toContain(SECTIONS.footer);
  });

  it('(d) wiki/.dispatch/ with no layers entry emits all four sections and the kb-dispatch server (dispatch implies planning)', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/planning-d' })).ok).toBe(true);
    fs.mkdirSync(path.join(tmp.dir, 'wiki', '.dispatch'), { recursive: true });

    expect((await sync({ dir: tmp.dir })).ok).toBe(true);

    const contract = readContract(tmp.dir);
    expect(contract.layers).toBeUndefined();
    const planning = planningInstalled(tmp.dir);
    expect(planning.ok && planning.data).toBe(true);

    const agents = readText(tmp.dir, 'AGENTS.md');
    expect(agents).toContain(SECTIONS.wiki);
    expect(agents).toContain(SECTIONS.dispatch);
    expect(agents).toContain(SECTIONS.guidelines);
    expect(agents).toContain(SECTIONS.footer);

    const mcp = readJson<McpConfig>(tmp.dir, '.mcp.json');
    expect(mcp.mcpServers['kb-wiki']).toBeDefined();
    expect(mcp.mcpServers['kb-dispatch']).toBeDefined();
  });

  it('(e) initPlanning refuses a non-bootstrapped repo, is idempotent byte-for-byte, and preserves every other stamp field', async () => {
    const unbootstrapped = createTmpDir();
    try {
      const refused = initPlanning({ dir: unbootstrapped.dir });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toBe('NOT_BOOTSTRAPPED');
      expect(fs.existsSync(path.join(unbootstrapped.dir, 'wiki'))).toBe(false);
    } finally {
      unbootstrapped.cleanup();
    }

    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/planning-e' })).ok).toBe(true);
    // Sync once so lastSyncedAt is present and must survive the init.
    expect((await sync({ dir: tmp.dir })).ok).toBe(true);

    const before = readContract(tmp.dir);
    const first = initPlanning({ dir: tmp.dir });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.changed).toBe(true);

    const after = readContract(tmp.dir);
    expect(after.layers).toEqual(['planning']);
    expect(after.repo).toBe(before.repo);
    expect(after.bootstrappedAt).toBe(before.bootstrappedAt);
    expect(after.contractVersion).toBe(before.contractVersion);
    expect(after.lastSyncedAt).toBe(before.lastSyncedAt);

    const bytesAfterFirst = fs.readFileSync(path.join(tmp.dir, 'wiki/.wiki-contract.json'), 'utf-8');
    const second = initPlanning({ dir: tmp.dir });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.changed).toBe(false);
      expect(second.data.layers).toEqual(['planning']);
    }
    const bytesAfterSecond = fs.readFileSync(path.join(tmp.dir, 'wiki/.wiki-contract.json'), 'utf-8');
    expect(bytesAfterSecond).toBe(bytesAfterFirst);
  });

  it('(f) checkBlockBudget still measures the largest block, with every section present', () => {
    const all = assembleBlockBody(sectionsResult.data, { planning: true, dispatch: true });
    for (const body of Object.values(SECTIONS)) {
      expect(all).toContain(body);
    }

    const budget = checkBlockBudget(sectionsResult.data);
    expect(budget.ok).toBe(true);
    if (budget.ok) {
      expect(budget.data.words).toBe(countBlockWords(all));
    }

    const wikiOnly = assembleBlockBody(sectionsResult.data, { planning: false, dispatch: false });
    expect(countBlockWords(wikiOnly)).toBeLessThan(countBlockWords(all));
  });

  it('(g) the wiki MCP server registers init-planning', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    const names = tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('init-planning');
  });

  it('(h) two sync runs after initPlanning preserve the planning layer', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/planning-h' })).ok).toBe(true);
    expect(initPlanning({ dir: tmp.dir }).ok).toBe(true);

    expect((await sync({ dir: tmp.dir })).ok).toBe(true);
    expect(readContract(tmp.dir).layers).toEqual(['planning']);

    expect((await sync({ dir: tmp.dir })).ok).toBe(true);
    expect(readContract(tmp.dir).layers).toEqual(['planning']);
  });

  it('(i) an unparseable or non-object stamp fails sync (both modes) and bootstrap before writing any file', async () => {
    for (const corrupt of ['{not json', 'null']) {
      tmp = createTmpDir();
      const repo = `test/planning-corrupt-${corrupt === 'null' ? 'null' : 'syntax'}`;
      expect((await bootstrap({ dir: tmp.dir, repo })).ok).toBe(true);

      const unchanged = ['AGENTS.md', 'CLAUDE.md', '.mcp.json', '.gitignore'].map(
        rel => [rel, fs.readFileSync(path.join(tmp.dir, rel))] as const,
      );

      const stampPath = path.join(tmp.dir, 'wiki/.wiki-contract.json');
      fs.writeFileSync(stampPath, corrupt, 'utf-8');
      const stampBytes = fs.readFileSync(stampPath);

      const syncResult = await sync({ dir: tmp.dir });
      expect(syncResult.ok).toBe(false);
      if (!syncResult.ok) {
        expect(syncResult.error).toBe('PARSE_ERROR');
        expect(syncResult.message).toContain(stampPath);
      }

      const checkResult = await sync({ dir: tmp.dir, check: true });
      expect(checkResult.ok).toBe(false);
      if (!checkResult.ok) {
        expect(checkResult.error).toBe('PARSE_ERROR');
        expect(checkResult.message).toContain(stampPath);
      }

      const bootstrapResult = await bootstrap({ dir: tmp.dir, repo });
      expect(bootstrapResult.ok).toBe(false);
      if (!bootstrapResult.ok) expect(bootstrapResult.error).toBe('PARSE_ERROR');

      for (const [rel, bytes] of unchanged) {
        expect(fs.readFileSync(path.join(tmp.dir, rel)).equals(bytes)).toBe(true);
      }
      expect(fs.readFileSync(stampPath).equals(stampBytes)).toBe(true);

      tmp.cleanup();
    }
  });

  it('(j) a corrupt stamp fails sync even when wiki/.dispatch/ exists', async () => {
    tmp = createTmpDir();
    expect((await bootstrap({ dir: tmp.dir, repo: 'test/planning-corrupt-dispatch' })).ok).toBe(true);
    fs.mkdirSync(path.join(tmp.dir, 'wiki', '.dispatch'), { recursive: true });

    const stampPath = path.join(tmp.dir, 'wiki/.wiki-contract.json');
    fs.writeFileSync(stampPath, '{not json', 'utf-8');

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('PARSE_ERROR');
      expect(result.message).toContain(stampPath);
    }
  });
});

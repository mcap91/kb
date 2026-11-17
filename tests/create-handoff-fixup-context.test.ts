/**
 * create-handoff `fixup_context`: the field is written as a one-line JSON
 * string and parseHandoff reads back exactly the same string, through the
 * core function, the CLI flag, and the MCP tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { bootstrap } from '@kb/wiki-core';
import { FIXUP_AUTHORING_RULES, createHandoff, renderHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import { parseHandoff, parseHandoffContent } from '../packages/dispatch-core/src/ho.js';
import type { CreateHandoffOpts } from '../packages/dispatch-core/src/types.js';
import { tools } from '../packages/dispatch-mcp/src/tools.js';
import { SLICE_ID, writeSliceWorkItem } from './helpers/slice-fixture.js';

const ROOT = resolve(process.cwd());
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const CLI = resolve(ROOT, 'packages/dispatch-cli/src/index.ts');

const HARD_TEXT = [
  'F1: the parser must reject "quoted: values" # not a comment',
  '',
  "- a leading dash, 'single quotes', \"double quotes\", back\\slash",
  '  indented line with `npm test -- -t "x"`',
  'non-ASCII: café, 日本語, 🙂',
  '',
].join('\n');

function opts(overrides: Partial<CreateHandoffOpts> = {}): CreateHandoffOpts {
  return {
    dir: '/unused',
    subject: 'kb:dispatch',
    allowed_agents: ['claude'],
    title: 'Fix-up',
    mode: 'implement',
    work_item: 'WK-0001',
    acceptance: ['AC-1'],
    validation: ['npm test'],
    ...overrides,
  };
}

describe('fixup_context rendering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders byte-identical output when fixup_context is absent, empty or whitespace', () => {
    const without = renderHandoff('HO-0001', opts());
    expect(renderHandoff('HO-0001', opts({ fixup_context: undefined }))).toBe(without);
    expect(renderHandoff('HO-0001', opts({ fixup_context: '' }))).toBe(without);
    expect(renderHandoff('HO-0001', opts({ fixup_context: ' \n\t ' }))).toBe(without);
    expect(without).not.toContain('fixup_context');
  });

  it('round-trips a hard multi-line string exactly, trailing newline included', () => {
    const rendered = renderHandoff('HO-0001', opts({ fixup_context: HARD_TEXT }));
    const parsed = parseHandoffContent(rendered, 'HO-0001.md');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.fixup_context).toBe(HARD_TEXT);
    expect(parsed.data.title).toBe('Fix-up');
  });

  it('keeps the field on one frontmatter line', () => {
    const rendered = renderHandoff('HO-0001', opts({ fixup_context: HARD_TEXT }));
    expect(rendered.split('\n').filter((line) => line.startsWith('fixup_context:'))).toHaveLength(1);
  });
});

describe('fixup_context parsing', () => {
  const frontmatter = (line: string) =>
    `---\nid: HO-0001\ntitle: t\nmode: implement\nwrite_scope: []\nacceptance:\n  - a\nvalidation:\n  - v\nstatus: draft\n${line}\n---\n`;

  it('reads hand-written unquoted and plain double-quoted values as before', () => {
    for (const line of ['fixup_context: plain words here', 'fixup_context: "plain words here"']) {
      const parsed = parseHandoffContent(frontmatter(line), 'HO-0001.md');
      expect(parsed.ok && parsed.data.fixup_context).toBe('plain words here');
    }
  });

  it('refuses a double-quoted value that is not a JSON string, naming the field', () => {
    for (const line of ['fixup_context: "bad \\q escape"', 'fixup_context: "unterminated', 'fixup_context: "a" trailing']) {
      const parsed = parseHandoffContent(frontmatter(line), 'HO-0001.md');
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.message).toContain('fixup_context');
      expect(parsed.message).toContain('JSON-style double-quoted string on one line');
    }
  });

  // Why: a hand-written value with inner quotes and a backslash used to parse as plain text; it now fails loudly instead of being read wrongly.
  it('refuses a hand-written double-quoted value with inner quotes and a backslash, naming the field', () => {
    const parsed = parseHandoffContent(frontmatter('fixup_context: "see "x" in C:\\tmp"'), 'HO-0001.md');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('fixup_context');
    expect(parsed.message).toContain('JSON-style double-quoted string on one line');
  });
});

describe('fixup_context through createHandoff, the CLI and the MCP tool', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-fixup-context-'));
    await mkdir(join(repo, 'wiki', '.dispatch'), { recursive: true });
    const boot = await bootstrap({ dir: repo, repo: 'test/repo' });
    if (!boot.ok) throw new Error(boot.message);
    await writeSliceWorkItem(repo, 'WK-0001');
    for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-m', 'init']]) {
      execFileSync('git', args, { cwd: repo });
    }
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('round-trips through a written file', async () => {
    const created = await createHandoff({ dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: 'WK-0001', slice: SLICE_ID, base_ref: 'dispatch/HO-0001', fixup_context: HARD_TEXT });
    if (!created.ok) throw new Error(created.message);
    const parsed = await parseHandoff(created.data.handoffPath);
    expect(parsed.ok && parsed.data.fixup_context).toBe(HARD_TEXT);
  });

  it('the CLI --fixup-context flag reaches the file', async () => {
    execFileSync(TSX, [CLI,
      'create-handoff', '--dir', repo, '--subject', 's', '--allowed-agents', 'claude',
      '--wk', 'WK-0001', '--slice', SLICE_ID, '--base-ref', 'dispatch/HO-0001',
      '--fixup-context', HARD_TEXT,
    ], { cwd: ROOT, stdio: 'pipe' });
    const parsed = await parseHandoff(join(repo, 'wiki', 'handoffs', 'HO-0001.md'));
    expect(parsed.ok && parsed.data.fixup_context).toBe(HARD_TEXT);
  });

  it('the MCP create-handoff tool accepts fixup_context and writes it', async () => {
    const tool = tools.find((t) => t.name === 'create-handoff')!;
    const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toContain('fixup_context');
    const result = (await tool.handler({ dir: repo, subject: 'kb:dispatch', allowed_agents: ['claude'], wk: 'WK-0001', slice: SLICE_ID, base_ref: 'dispatch/HO-0001', fixup_context: HARD_TEXT })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const text = await readFile(join(repo, 'wiki', 'handoffs', 'HO-0001.md'), 'utf8');
    const parsed = parseHandoffContent(text, 'HO-0001.md');
    expect(parsed.ok && parsed.data.fixup_context).toBe(HARD_TEXT);
  });
});

describe('fixup authoring rules have one source', () => {
  // Why: two typed copies drift; the MCP description and the CLI help must carry the one constant.
  it('the MCP fixup_context description and the CLI help both carry FIXUP_AUTHORING_RULES', () => {
    const tool = tools.find((t) => t.name === 'create-handoff')!;
    const shape = (tool.inputSchema as unknown as { shape: Record<string, { description?: string }> }).shape;
    expect(shape.fixup_context.description).toContain(FIXUP_AUTHORING_RULES);
    const help = execFileSync(TSX, [CLI, '--help'], { cwd: ROOT, stdio: 'pipe' }).toString().replace(/\s+/g, ' ');
    expect(help).toContain(FIXUP_AUTHORING_RULES);
  });
});

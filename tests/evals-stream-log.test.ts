/**
 * WK-0237 slice B1a — stream-json tool-log parser, tested on the real
 * captures (HO-0144 Acceptance). Facts: `wk0237-normal-2` line 1 is
 * `system`/`init` with `model: "claude-opus-5-5"` and
 * `session_id: "779e1259-a52f-44c2-931f-8d356cf231f2"`; line 30 is its one
 * `system`/`permission_denied` event; the final `result` line's
 * `permission_denials` has one entry and `result` text opens with
 * "**Decision 1". `wk0237-probe-2` line 26 is an `Agent` tool_use with no
 * parent; line 31 is a subagent `Bash` tool_use whose
 * `parent_tool_use_id` equals the `Agent` call's `id`; lines 42/45 are
 * `mcp__kb-wiki__build-search-index` / `mcp__kb-wiki__search` tool_uses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseStreamLog } from '../evals/stream-log.js';

// This file compiles to CommonJS under NodeNext (no package.json "type": "module"),
// so `import.meta.url` is not usable; `__dirname` resolves fixture paths instead.
const CAPTURES_DIR = join(__dirname, 'fixtures', 'evals', 'captures');

function loadLines(name: string): string[] {
  return readFileSync(join(CAPTURES_DIR, name, 'stream.jsonl'), 'utf8').split('\n');
}

describe('parseStreamLog on wk0237-normal-2', () => {
  const result = parseStreamLog(loadLines('wk0237-normal-2'));

  it('parses without error', () => {
    expect(result.ok).toBe(true);
  });

  it('captures the system/init model id and session id', () => {
    if (!result.ok) throw result;
    expect(result.data.modelId).toBe('claude-opus-5-5');
    expect(result.data.sessionId).toBe('779e1259-a52f-44c2-931f-8d356cf231f2');
  });

  it('finds the Read of the target WK and the mcp__kb-wiki__search call', () => {
    if (!result.ok) throw result;
    const readWk = result.data.toolUses.find(
      (t) => t.name === 'Read' && (t.input as Record<string, unknown>).file_path === '/home/eval/test_kb/wiki/issues/WK-0010.md',
    );
    const search = result.data.toolUses.find((t) => t.name === 'mcp__kb-wiki__search');
    expect(readWk).toBeDefined();
    expect(search).toBeDefined();
  });

  it('captures the one permission_denied event and the one result.permission_denials entry', () => {
    if (!result.ok) throw result;
    expect(result.data.permissionDeniedEvents).toHaveLength(1);
    expect(result.data.permissionDeniedEvents[0].toolName).toBe('Bash');
    expect(result.data.resultPermissionDenials).toHaveLength(1);
  });

  it('captures the final result text and usage', () => {
    if (!result.ok) throw result;
    expect(result.data.result).not.toBeNull();
    expect(result.data.result?.subtype).toBe('success');
    expect(result.data.result?.isError).toBe(false);
    expect(result.data.result?.text.startsWith('**Decision 1')).toBe(true);
    expect(result.data.result?.usage).toBeDefined();
  });
});

describe('parseStreamLog on wk0237-probe-2 (subagent turns)', () => {
  const result = parseStreamLog(loadLines('wk0237-probe-2'));

  it('parses without error', () => {
    expect(result.ok).toBe(true);
  });

  it('captures the model id and session id', () => {
    if (!result.ok) throw result;
    expect(result.data.modelId).toBe('claude-sonnet-5');
    expect(result.data.sessionId).toBe('5e8ad8ef-2102-4104-bce6-29e84826ddec');
  });

  it('finds the Agent tool_use with no parent and its subagent turn with a matching parent_tool_use_id', () => {
    if (!result.ok) throw result;
    const agentCall = result.data.toolUses.find((t) => t.name === 'Agent');
    expect(agentCall).toBeDefined();
    expect(agentCall?.parentToolUseId).toBeNull();

    const subagentTurn = result.data.toolUses.find((t) => t.parentToolUseId === agentCall?.id);
    expect(subagentTurn).toBeDefined();
    expect(subagentTurn?.name).toBe('Bash');
  });

  it('finds the kb-wiki build-search-index and search calls', () => {
    if (!result.ok) throw result;
    const names = result.data.toolUses.map((t) => t.name);
    expect(names).toContain('mcp__kb-wiki__build-search-index');
    expect(names).toContain('mcp__kb-wiki__search');
  });
});

describe('parseStreamLog failure', () => {
  it('fails on a malformed line', () => {
    const result = parseStreamLog(['not json']);
    expect(result.ok).toBe(false);
  });
});

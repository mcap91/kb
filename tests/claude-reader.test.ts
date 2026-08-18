/**
 * Tests for the OWNED Claude Code JSONL read (WK-0064 / DEC-0005).
 *
 * We no longer shell out to ccusage — we parse `~/.claude/projects/<encoded-cwd>/*.jsonl`
 * directly, mirroring the existing Codex reader. These tests pin the two read primitives:
 *   - parseClaudeJsonl: one file's raw text → per-assistant-message usage records.
 *   - readClaudeSessionsFrom: walk a projects root (incl. `subagents/` subfolders),
 *     window by the per-message timestamp, tag each record with its project folder key.
 *
 * Fixtures encode the REAL Claude Code assistant-line shape verified in SRC-0005:
 * top-level `timestamp`; `message.id` (dedup key); `message.model`; and
 * `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`
 * (cache_creation is a number). A `<synthetic>` 0-token pseudo-model must be skipped.
 * Host-native synthetic paths only (WK-0043) — nothing personal, symmetric on both OSes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseClaudeJsonl,
  readClaudeSessionsFrom,
} from '../packages/wiki-core/src/value-usage.js';

// A real-shape Claude assistant line (the load-bearing fixture).
function assistantLine(
  id: string,
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
  timestamp = '2026-07-05T12:00:00.000Z',
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { id, role: 'assistant', model, usage },
  });
}

describe('parseClaudeJsonl — real Claude Code assistant-line shape', () => {
  it('extracts input/output/cache_read/cache_write per message with the project key + date', () => {
    const raw = assistantLine('msg_01', 'claude-opus-4-8', {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 200,
    });
    const recs = parseClaudeJsonl(raw, 'PROJKEY');
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    expect(r.projectKey).toBe('PROJKEY');
    expect(r.messageId).toBe('msg_01');
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.date).toBe('2026-07-05');
    expect(r.input_tokens).toBe(100);
    expect(r.output_tokens).toBe(50);
    expect(r.cache_read_tokens).toBe(300); // from cache_read_input_tokens
    expect(r.cache_write_tokens).toBe(200); // from cache_creation_input_tokens
  });

  it('skips the <synthetic> 0-token pseudo-model', () => {
    const raw = [
      assistantLine('msg_real', 'claude-opus-4-8', { input_tokens: 10, output_tokens: 5 }),
      assistantLine('msg_syn', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
    ].join('\n');
    const recs = parseClaudeJsonl(raw, 'K');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.model).toBe('claude-opus-4-8');
  });

  it('skips non-assistant / usage-less lines (user turns, summaries, blanks)', () => {
    const raw = [
      JSON.stringify({ type: 'user', timestamp: '2026-07-05T12:00:00Z', message: { role: 'user', content: 'hi' } }),
      '',
      JSON.stringify({ type: 'summary', summary: 'a recap' }),
      assistantLine('msg_a', 'claude-sonnet-4-6', { input_tokens: 7, output_tokens: 3 }),
      'not json at all',
    ].join('\n');
    const recs = parseClaudeJsonl(raw, 'K');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.messageId).toBe('msg_a');
  });

  it('a session using two models yields one record per model', () => {
    const raw = [
      assistantLine('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 40 }),
      assistantLine('m2', 'claude-sonnet-4-6', { input_tokens: 200, output_tokens: 80 }),
    ].join('\n');
    const recs = parseClaudeJsonl(raw, 'K');
    expect(recs.map((r) => r.model).sort()).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
  });
});

describe('readClaudeSessionsFrom — walks the projects tree incl. subagents/, windows by date', () => {
  let root: string;

  afterEach(() => {
    if (root) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('includes top-level and subagents/ files, tags the project key, and excludes out-of-window dates', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-claude-read-'));
    const projKey = 'C--Users-test-projects-kb'; // a synthetic encoded-cwd folder name
    const projDir = path.join(root, projKey);
    const subDir = path.join(projDir, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });

    // Top-level session: one in-window line + one out-of-window line.
    fs.writeFileSync(
      path.join(projDir, 'session-a.jsonl'),
      [
        assistantLine('in_1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 50 }, '2026-07-05T09:00:00Z'),
        assistantLine('old_1', 'claude-opus-4-8', { input_tokens: 999, output_tokens: 999 }, '2026-06-01T09:00:00Z'),
      ].join('\n'),
      'utf-8',
    );
    // Subagent session: one in-window line (must be included, and keyed to the PROJECT, not 'subagents').
    fs.writeFileSync(
      path.join(subDir, 'sub-1.jsonl'),
      assistantLine('sub_1', 'claude-sonnet-4-6', { input_tokens: 200, output_tokens: 80 }, '2026-07-06T09:00:00Z'),
      'utf-8',
    );

    const recs = readClaudeSessionsFrom(root, '2026-07-01', '2026-07-10');

    // Only the two in-window records survive; the June record is windowed out.
    expect(recs).toHaveLength(2);
    const ids = recs.map((r) => r.messageId).sort();
    expect(ids).toEqual(['in_1', 'sub_1']);
    // Both — including the subagents/ one — carry the top-level project folder as the key.
    for (const r of recs) expect(r.projectKey).toBe(projKey);
  });

  it('returns [] when the projects root does not exist (never throws)', () => {
    root = path.join(os.tmpdir(), `kb-claude-missing-${process.pid}`);
    expect(() => readClaudeSessionsFrom(root, '2026-07-01', '2026-07-10')).not.toThrow();
    expect(readClaudeSessionsFrom(root, '2026-07-01', '2026-07-10')).toEqual([]);
  });
});

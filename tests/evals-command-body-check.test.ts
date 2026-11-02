/**
 * WK-0237 slice B1a — command-body prefix check (HO-0144 Acceptance):
 * passes against the real planner.md the wk0237-normal-2 capture installed
 * (`git show 8989e9a:contract/roles/planner.md`, kb HEAD when the capture
 * ran), and fails against a one-byte-changed copy of that text.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCommandBodyPrefix, extractUserTextBlocks } from '../evals/command-body-check.js';

// This file compiles to CommonJS under NodeNext (no package.json "type": "module"),
// so `import.meta.url` is not usable; `__dirname` resolves fixture paths instead.
const KB_ROOT = join(__dirname, '..');
const TRANSCRIPT_FIXTURE = join(__dirname, 'fixtures', 'evals', 'transcripts', 'normal-2-user-lines.jsonl');

function installedPlannerBody(): string {
  return execFileSync('git', ['show', '8989e9a:contract/roles/planner.md'], { cwd: KB_ROOT, encoding: 'utf8' });
}

describe('checkCommandBodyPrefix', () => {
  it('passes against the real planner.md the capture installed', () => {
    const lines = readFileSync(TRANSCRIPT_FIXTURE, 'utf8').split('\n');
    const result = checkCommandBodyPrefix(lines, installedPlannerBody());
    expect(result).toEqual({ ok: true, data: { passed: true } });
  });

  it('fails against a copy of that text with one byte changed', () => {
    const lines = readFileSync(TRANSCRIPT_FIXTURE, 'utf8').split('\n');
    const original = installedPlannerBody();
    const mutated = `X${original.slice(1)}`;
    expect(mutated).not.toBe(original);
    expect(mutated.length).toBe(original.length);

    const result = checkCommandBodyPrefix(lines, mutated);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.passed).toBe(false);
  });

  it('fails when no transcript line matches at all', () => {
    const result = checkCommandBodyPrefix(['not json', JSON.stringify({ type: 'assistant' })], 'anything');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.passed).toBe(false);
  });
});

describe('extractUserTextBlocks', () => {
  it('extracts the two type:"user" text lines from the fixture, in order', () => {
    const lines = readFileSync(TRANSCRIPT_FIXTURE, 'utf8').split('\n');
    const texts = extractUserTextBlocks(lines);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('<command-name>/planner</command-name>');
    expect(texts[1].endsWith('ARGUMENTS: WK-0010')).toBe(true);
  });

  it('skips a type:"user" line whose content is a tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'result text' }] },
    });
    expect(extractUserTextBlocks([line])).toEqual([]);
  });
});

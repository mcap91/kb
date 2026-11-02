/**
 * WK-0237 slice B1a — 15.2 run validity, tested against the real jail
 * captures (HO-0144 Acceptance). `wk0237-normal`'s captured run.json has
 * `exitCode: 1` and its last stream line is a `result` event with
 * `subtype: "success"`, `is_error: true` — nonzero exit is checked before
 * `is_error`, per HO-0132 Constraints ("normal = nonzero-exit with
 * is_error"), so `checkRunValidity` reports `nonzero-exit` for it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkRunValidity, type RunValidityFields } from '../evals/validity.js';

// This file compiles to CommonJS under NodeNext (no package.json "type": "module"),
// so `import.meta.url` is not usable; `__dirname` resolves fixture paths instead.
const CAPTURES_DIR = join(__dirname, 'fixtures', 'evals', 'captures');

function loadRunFields(name: string): RunValidityFields {
  const run = JSON.parse(readFileSync(join(CAPTURES_DIR, name, 'run.json'), 'utf8'));
  return { exitCode: run.exitCode, timedOut: run.timedOut };
}

function loadStreamLines(name: string): string[] {
  return readFileSync(join(CAPTURES_DIR, name, 'stream.jsonl'), 'utf8').split('\n');
}

describe('checkRunValidity against real captures', () => {
  it('wk0237-normal is invalid: nonzero-exit', () => {
    const result = checkRunValidity(loadRunFields('wk0237-normal'), loadStreamLines('wk0237-normal'));
    expect(result).toEqual({ ok: true, data: { valid: false, reason: 'nonzero-exit' } });
  });

  it('wk0237-normal-2 is valid', () => {
    const result = checkRunValidity(loadRunFields('wk0237-normal-2'), loadStreamLines('wk0237-normal-2'));
    expect(result).toEqual({ ok: true, data: { valid: true } });
  });

  it('wk0237-budget is invalid: budget-stop', () => {
    const result = checkRunValidity(loadRunFields('wk0237-budget'), loadStreamLines('wk0237-budget'));
    expect(result).toEqual({ ok: true, data: { valid: false, reason: 'budget-stop' } });
  });

  it('wk0237-timeout is invalid: timeout', () => {
    const result = checkRunValidity(loadRunFields('wk0237-timeout'), loadStreamLines('wk0237-timeout'));
    expect(result).toEqual({ ok: true, data: { valid: false, reason: 'timeout' } });
  });
});

describe('checkRunValidity synthetic edge cases', () => {
  it('reports malformed-jsonl when the last line is not valid JSON', () => {
    const result = checkRunValidity({ exitCode: 0, timedOut: false }, ['not json']);
    expect(result).toEqual({ ok: true, data: { valid: false, reason: 'malformed-jsonl' } });
  });

  it('reports no-result-event when the last line is not a result event', () => {
    const lines = [JSON.stringify({ type: 'assistant' })];
    const result = checkRunValidity({ exitCode: 0, timedOut: false }, lines);
    expect(result).toEqual({ ok: true, data: { valid: false, reason: 'no-result-event' } });
  });

  it('reports no-result-event when there are no stream lines at all', () => {
    const result = checkRunValidity({ exitCode: 0, timedOut: false }, ['']);
    expect(result).toEqual({ ok: true, data: { valid: false, reason: 'no-result-event' } });
  });

  it('timeout takes priority over every other field', () => {
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', is_error: false })];
    const result = checkRunValidity({ exitCode: 0, timedOut: true }, lines);
    expect(result).toEqual({ ok: true, data: { valid: false, reason: 'timeout' } });
  });
});

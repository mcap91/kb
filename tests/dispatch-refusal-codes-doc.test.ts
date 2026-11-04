/**
 * Pins the "Refusal Codes" table in docs/dispatch-protocol.md to V2_REFUSAL_CODES.
 * The doc keeps its own copy because it groups codes by the phase that raises them,
 * which the flat code list does not carry; this test makes that copy fail loud on
 * drift in either direction instead of going stale silently.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { V2_REFUSAL_CODES } from '../packages/dispatch-core/src/errors.js';

function documentedRefusalCodes(): string[] {
  const doc = readFileSync(resolve(__dirname, '..', 'docs', 'dispatch-protocol.md'), 'utf8');
  const section = doc.split('## Refusal Codes')[1]?.split(/\n## /)[0] ?? '';
  const tableRows = section.split('\n').filter((line) => line.startsWith('|'));
  return [...tableRows.join('\n').matchAll(/`([A-Z][A-Z_]+)`/g)].map((m) => m[1]);
}

describe('docs/dispatch-protocol.md Refusal Codes table', () => {
  it('lists exactly the codes in V2_REFUSAL_CODES', () => {
    expect(documentedRefusalCodes().sort()).toEqual([...V2_REFUSAL_CODES].sort());
  });
});

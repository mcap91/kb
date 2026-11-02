/**
 * WK-0237 slice B1a — scenario directory sha256 stability/change-sensitivity
 * (HO-0144 Acceptance).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashScenarioDir } from '../evals/scenario-hash.js';

let tmpDirs: string[] = [];
function makeScenarioDir(scenarioJson: string, records: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kb-eval-hash-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'scenario.json'), scenarioJson);
  for (const [relPath, content] of Object.entries(records)) {
    const full = join(dir, 'records', relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe('hashScenarioDir', () => {
  it('is stable across identical content', () => {
    const a = makeScenarioDir('{"id":"x"}', { 'issues/WK-0001.md': 'content' });
    const b = makeScenarioDir('{"id":"x"}', { 'issues/WK-0001.md': 'content' });

    const resultA = hashScenarioDir(a);
    const resultB = hashScenarioDir(b);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (resultA.ok && resultB.ok) expect(resultA.data).toBe(resultB.data);
  });

  it('changes when a record file byte changes', () => {
    const a = makeScenarioDir('{"id":"x"}', { 'issues/WK-0001.md': 'content' });
    const b = makeScenarioDir('{"id":"x"}', { 'issues/WK-0001.md': 'content!' });

    const resultA = hashScenarioDir(a);
    const resultB = hashScenarioDir(b);
    expect(resultA.ok && resultB.ok && resultA.data !== resultB.data).toBe(true);
  });

  it('changes when scenario.json changes', () => {
    const a = makeScenarioDir('{"id":"x"}', {});
    const b = makeScenarioDir('{"id":"y"}', {});

    const resultA = hashScenarioDir(a);
    const resultB = hashScenarioDir(b);
    expect(resultA.ok && resultB.ok && resultA.data !== resultB.data).toBe(true);
  });

  it('changes when a record file is renamed (path is part of the hash)', () => {
    const a = makeScenarioDir('{"id":"x"}', { 'issues/WK-0001.md': 'content' });
    const b = makeScenarioDir('{"id":"x"}', { 'issues/WK-0002.md': 'content' });

    const resultA = hashScenarioDir(a);
    const resultB = hashScenarioDir(b);
    expect(resultA.ok && resultB.ok && resultA.data !== resultB.data).toBe(true);
  });
});

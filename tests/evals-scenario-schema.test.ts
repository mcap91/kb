/**
 * WK-0237 slice B1a — scenario/suite loader and `records/` path-escape
 * refusal (HO-0144 Acceptance: schema extensions over HO-0132, "the
 * committed planner suite loads with 4 scenarios").
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CHECK_KINDS,
  listRecordFiles,
  loadScenario,
  loadSuite,
  loadSuiteScenarios,
} from '../evals/scenario-schema.js';

// This file compiles to CommonJS under NodeNext (no package.json "type": "module"),
// so `import.meta.url` is not usable; `__dirname` resolves fixture paths instead.
const KB_ROOT = join(__dirname, '..');
const TEST_SUITE_DIR = join(__dirname, 'fixtures', 'evals', 'scenarios', 'test-suite');
const PLANNER_SUITE_DIR = join(KB_ROOT, 'evals', 'scenarios', 'planner');

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kb-eval-scenario-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function writeScenarioJson(dir: string, overrides: Record<string, unknown>): void {
  const base = {
    schema_version: 1,
    id: 'fixture',
    prompt: '/planner WK-0001',
    target_wk: 'WK-0001',
    seeded_in: null,
    planted_question: 'A question?',
    class: 'resolvable',
    permitted_outcome: 'something',
    checks: ['read-wk'],
    pass_threshold: { passes: 3, of: 3 },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ ...base, ...overrides }, null, 2));
}

describe('loadSuite / loadSuiteScenarios', () => {
  it('loads the fixture test-suite', () => {
    const result = loadSuite(TEST_SUITE_DIR);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.suite).toBe('test-suite');
      expect(result.data.conditions[0].install_command).toBeNull();
    }
  });

  it('loads the committed planner suite unchanged, with 4 scenarios', () => {
    const suiteResult = loadSuite(PLANNER_SUITE_DIR);
    expect(suiteResult.ok).toBe(true);

    const scenariosResult = loadSuiteScenarios(PLANNER_SUITE_DIR);
    expect(scenariosResult.ok).toBe(true);
    if (scenariosResult.ok) {
      expect(scenariosResult.data).toHaveLength(4);
      expect(scenariosResult.data.map((s) => s.id).sort()).toEqual([
        'mcp-or-import',
        'parser-question',
        'ruling-relitigation',
        'untriaged-questions',
      ]);
    }
  });
});

describe('loadScenario refusals', () => {
  it('refuses an unknown class', () => {
    const dir = makeTmpDir();
    writeScenarioJson(dir, { class: 'not-a-real-class' });
    const result = loadScenario(dir);
    expect(result.ok).toBe(false);
  });

  it('refuses an unknown check kind', () => {
    const dir = makeTmpDir();
    writeScenarioJson(dir, { checks: ['read-wk', 'not-a-real-check'] });
    const result = loadScenario(dir);
    expect(result.ok).toBe(false);
  });

  it('refuses a missing planted_question', () => {
    const dir = makeTmpDir();
    const { planted_question, ...rest } = {
      schema_version: 1,
      id: 'fixture',
      prompt: '/planner WK-0001',
      target_wk: 'WK-0001',
      seeded_in: null,
      planted_question: 'unused',
      class: 'resolvable',
      permitted_outcome: 'something',
      checks: ['read-wk'],
      pass_threshold: { passes: 3, of: 3 },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify(rest));
    const result = loadScenario(dir);
    expect(result.ok).toBe(false);
  });

  it('refuses an empty checks list', () => {
    const dir = makeTmpDir();
    writeScenarioJson(dir, { checks: [] });
    const result = loadScenario(dir);
    expect(result.ok).toBe(false);
  });

  it('accepts every documented check kind', () => {
    const dir = makeTmpDir();
    writeScenarioJson(dir, { checks: [...CHECK_KINDS] });
    const result = loadScenario(dir);
    expect(result.ok).toBe(true);
  });
});

describe('listRecordFiles', () => {
  it('returns [] for a scenario with no records/', () => {
    const dir = makeTmpDir();
    const result = listRecordFiles(join(dir, 'records'));
    expect(result).toEqual({ ok: true, data: [] });
  });

  it('lists files sorted by path', () => {
    const dir = makeTmpDir();
    const recordsDir = join(dir, 'records');
    mkdirSync(join(recordsDir, 'issues'), { recursive: true });
    mkdirSync(join(recordsDir, 'decisions'), { recursive: true });
    writeFileSync(join(recordsDir, 'issues', 'WK-0001.md'), 'wk');
    writeFileSync(join(recordsDir, 'decisions', 'DEC-0001.md'), 'dec');

    const result = listRecordFiles(recordsDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(['decisions/DEC-0001.md', 'issues/WK-0001.md']);
    }
  });

  it('refuses a records path that escapes its directory via a symlink', () => {
    const dir = makeTmpDir();
    const recordsDir = join(dir, 'records');
    mkdirSync(recordsDir, { recursive: true });
    const outside = join(dir, 'outside.md');
    writeFileSync(outside, 'escaped content');
    symlinkSync(outside, join(recordsDir, 'escape.md'));

    const result = listRecordFiles(recordsDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('RECORDS_PATH_ESCAPE');
  });
});

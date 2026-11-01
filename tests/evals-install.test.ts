/**
 * WK-0237 slice A — install.ts: command/skill install copying, and the
 * exact-files refusal (`checkInstalledExactly`) that the harness runs
 * against the four jail-visible .claude directories before any launch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkInstalledExactly, installCommand, installSkill } from '../evals/install.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-eval-install-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('installCommand', () => {
  it('copies the source file to <destDir>/<name>.md', () => {
    const srcFile = join(dir, 'planner-src.md');
    writeFileSync(srcFile, 'ROLE TEXT');
    const destDir = join(dir, 'home', '.claude', 'commands');

    const result = installCommand({ srcFile, destDir, name: 'planner' });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(destDir, 'planner.md'), 'utf8')).toBe('ROLE TEXT');
  });
});

describe('installSkill', () => {
  it('copies the source directory to <destParentDir>/<name>/', () => {
    const srcDir = join(dir, 'resolve-src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'SKILL.md'), 'SKILL BODY');
    const destParentDir = join(dir, 'test_kb', '.claude', 'skills');

    const result = installSkill({ srcDir, destParentDir, name: 'resolve' });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(destParentDir, 'resolve', 'SKILL.md'), 'utf8')).toBe('SKILL BODY');
  });
});

describe('checkInstalledExactly', () => {
  function makeDirs(): {
    homeCommandsDir: string;
    homeSkillsDir: string;
    testKbCommandsDir: string;
    testKbSkillsDir: string;
  } {
    const homeCommandsDir = join(dir, 'home', '.claude', 'commands');
    const homeSkillsDir = join(dir, 'home', '.claude', 'skills');
    const testKbCommandsDir = join(dir, 'test_kb', '.claude', 'commands');
    const testKbSkillsDir = join(dir, 'test_kb', '.claude', 'skills');
    mkdirSync(homeCommandsDir, { recursive: true });
    mkdirSync(testKbSkillsDir, { recursive: true });
    writeFileSync(join(homeCommandsDir, 'planner.md'), 'x');
    mkdirSync(join(testKbSkillsDir, 'resolve'), { recursive: true });
    return { homeCommandsDir, homeSkillsDir, testKbCommandsDir, testKbSkillsDir };
  }

  it('passes when the install list is satisfied exactly, across all four directories', () => {
    const { homeCommandsDir, homeSkillsDir, testKbCommandsDir, testKbSkillsDir } = makeDirs();

    const result = checkInstalledExactly([
      { dir: homeCommandsDir, expectedNames: ['planner.md'] },
      { dir: homeSkillsDir, expectedNames: [] },
      { dir: testKbCommandsDir, expectedNames: [] },
      { dir: testKbSkillsDir, expectedNames: ['resolve'] },
    ]);

    expect(result.ok).toBe(true);
  });

  it('fails, naming the file, when one extra file is present in any of the four directories', () => {
    const { homeCommandsDir, homeSkillsDir, testKbCommandsDir, testKbSkillsDir } = makeDirs();
    writeFileSync(join(homeCommandsDir, 'extra.md'), 'x');

    const result = checkInstalledExactly([
      { dir: homeCommandsDir, expectedNames: ['planner.md'] },
      { dir: homeSkillsDir, expectedNames: [] },
      { dir: testKbCommandsDir, expectedNames: [] },
      { dir: testKbSkillsDir, expectedNames: ['resolve'] },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('extra.md');
  });

  it('fails when one installed file is missing', () => {
    const { homeSkillsDir, testKbCommandsDir, testKbSkillsDir } = makeDirs();
    const emptyCommandsDir = join(dir, 'home', '.claude', 'commands-missing');
    mkdirSync(emptyCommandsDir, { recursive: true });

    const result = checkInstalledExactly([
      { dir: emptyCommandsDir, expectedNames: ['planner.md'] },
      { dir: homeSkillsDir, expectedNames: [] },
      { dir: testKbCommandsDir, expectedNames: [] },
      { dir: testKbSkillsDir, expectedNames: ['resolve'] },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('planner.md');
  });

  it('tolerates a directory that does not exist on disk when nothing is expected there', () => {
    const result = checkInstalledExactly([{ dir: join(dir, 'does-not-exist'), expectedNames: [] }]);
    expect(result.ok).toBe(true);
  });
});

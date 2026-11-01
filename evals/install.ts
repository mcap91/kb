/**
 * Per-run test_kb reset and command/skill installation (WK-0237 scope 11 as
 * superseded by scope 5, scope 13, scope 17.2).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fail, ok, type EvalResult } from './result.js';

/** `git reset --hard <baselineSha> && git clean -fdx` against `testKb` (scope 13 — no push-URL step; the jail holds no git credentials). */
export function resetTestKb(testKb: string, baselineSha: string): EvalResult<void> {
  try {
    execFileSync('git', ['reset', '--hard', baselineSha], { cwd: testKb, stdio: 'pipe' });
    execFileSync('git', ['clean', '-fdx'], { cwd: testKb, stdio: 'pipe' });
    return ok(undefined);
  } catch (err) {
    return fail('RESET_FAILED', `test_kb reset to ${baselineSha} failed: ${describeError(err)}`);
  }
}

/** Installs the role-text file under test as `<destDir>/<name>.md` (e.g. a run's `home/.claude/commands/`). */
export function installCommand(opts: { srcFile: string; destDir: string; name: string }): EvalResult<void> {
  try {
    mkdirSync(opts.destDir, { recursive: true });
    copyFileSync(opts.srcFile, join(opts.destDir, `${opts.name}.md`));
    return ok(undefined);
  } catch (err) {
    return fail('INSTALL_FAILED', `installing command ${opts.name} failed: ${describeError(err)}`);
  }
}

/** Installs a skill directory under test as `<destParentDir>/<name>/` (e.g. `test_kb/.claude/skills/`). */
export function installSkill(opts: { srcDir: string; destParentDir: string; name: string }): EvalResult<void> {
  try {
    const dest = join(opts.destParentDir, opts.name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(opts.srcDir, dest, { recursive: true });
    return ok(undefined);
  } catch (err) {
    return fail('INSTALL_FAILED', `installing skill ${opts.name} failed: ${describeError(err)}`);
  }
}

export interface InstalledFileSet {
  /** Host-side directory to check (e.g. `<runHome>/.claude/commands`). */
  dir: string;
  /** Exact file/dir names expected directly under `dir` — nothing more, nothing less. */
  expectedNames: string[];
}

/**
 * The harness refuses to run unless each of the jail's `.claude/commands/`
 * and `.claude/skills/` directories (home-side and test_kb-side — the four
 * directories named in acceptance) holds exactly the files the harness
 * itself installed. A directory that does not exist on disk is treated as
 * empty (so an expectation of no files there, is satisfied by its absence).
 */
export function checkInstalledExactly(sets: InstalledFileSet[]): EvalResult<void> {
  for (const { dir, expectedNames } of sets) {
    const expected = new Set(expectedNames);
    const actual = existsSync(dir) ? readdirSync(dir) : [];
    const actualSet = new Set(actual);

    for (const name of actual) {
      if (!expected.has(name)) {
        return fail('UNEXPECTED_INSTALLED_FILE', `unexpected file in ${dir}: ${name}`);
      }
    }
    for (const name of expectedNames) {
      if (!actualSet.has(name)) {
        return fail('MISSING_INSTALLED_FILE', `missing installed file in ${dir}: ${name}`);
      }
    }
  }
  return ok(undefined);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

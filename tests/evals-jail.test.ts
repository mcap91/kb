/**
 * WK-0237 slice A — pins `buildEvalJailArgs`'s full bwrap argv for synthetic
 * inputs. No real bwrap/claude call here — pure argv assembly only.
 */
import { describe, expect, it } from 'vitest';

import { SYSTEM_ROOTS } from '@kb/dispatch-core';

import {
  buildEvalJailArgs,
  EVAL_CLI_PACKAGE_DIR,
  EVAL_CREDENTIALS_PATH,
  EVAL_HOME,
  EVAL_KB_ROOT_PATH,
  EVAL_KB_WIKI_PATH,
  EVAL_TEST_KB_PATH,
} from '../evals/jail.js';

const runHome = '/synthetic/rundir/home';
const credentialsFile = '/synthetic/operator-home/.claude/.credentials.json';
const testKb = '/synthetic/test_kb';
const kbRoot = '/synthetic/kb';
const cliPackageDir = '/synthetic/npm-global/lib/node_modules/@anthropic-ai/claude-code';

function expectedSystemRootArgs(): string[] {
  return SYSTEM_ROOTS.flatMap((root) => ['--ro-bind-try', root, root]);
}

function buildArgv(): string[] {
  return buildEvalJailArgs({ systemRoots: SYSTEM_ROOTS, runHome, credentialsFile, testKb, kbRoot, cliPackageDir });
}

describe('buildEvalJailArgs', () => {
  it('pins the full bwrap argv for synthetic inputs', () => {
    expect(buildArgv()).toEqual([
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--unshare-pid',
      '--unshare-ipc',
      '--new-session',
      '--clearenv',
      '--setenv', 'HOME', EVAL_HOME,
      '--setenv', 'USER', 'eval',
      '--setenv', 'PATH', `${EVAL_CLI_PACKAGE_DIR}/bin:/usr/local/bin:/usr/bin:/bin`,
      '--setenv', 'DISABLE_AUTOUPDATER', '1',
      '--bind', runHome, EVAL_HOME,
      '--ro-bind', credentialsFile, EVAL_CREDENTIALS_PATH,
      '--bind', testKb, EVAL_TEST_KB_PATH,
      '--ro-bind', kbRoot, EVAL_KB_ROOT_PATH,
      '--tmpfs', EVAL_KB_WIKI_PATH,
      '--ro-bind', cliPackageDir, EVAL_CLI_PACKAGE_DIR,
      '--chdir', EVAL_TEST_KB_PATH, '--',
    ]);
  });

  it('never adds --unshare-net (network stays shared)', () => {
    expect(buildArgv()).not.toContain('--unshare-net');
  });

  it('mounts every SYSTEM_ROOTS entry as --ro-bind-try', () => {
    const argv = buildArgv();
    for (const root of SYSTEM_ROOTS) {
      const idx = argv.indexOf(root);
      expect(argv[idx - 1]).toBe('--ro-bind-try');
      expect(argv[idx + 1]).toBe(root);
    }
  });

  it('the set of host source paths outside SYSTEM_ROOTS equals exactly the five declared mounts', () => {
    const argv = buildArgv();
    const hostSources = new Set<string>();
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i];
      if (token === '--bind' || token === '--ro-bind' || token === '--ro-bind-try') {
        const src = argv[i + 1];
        if (src !== undefined && !SYSTEM_ROOTS.includes(src)) {
          hostSources.add(src);
        }
      }
    }
    expect(hostSources).toEqual(new Set([runHome, credentialsFile, testKb, kbRoot, cliPackageDir]));
  });

  it('mounts /home/eval before the credentials ro-bind, and /kb before the /kb/wiki tmpfs mask', () => {
    const argv = buildArgv();
    expect(argv.indexOf(runHome)).toBeLessThan(argv.indexOf(credentialsFile));
    expect(argv.indexOf(kbRoot)).toBeLessThan(argv.indexOf(EVAL_KB_WIKI_PATH));
  });

  it('ends in --chdir /home/eval/test_kb --', () => {
    const argv = buildArgv();
    expect(argv.slice(-3)).toEqual(['--chdir', EVAL_TEST_KB_PATH, '--']);
  });
});

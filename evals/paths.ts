/**
 * Runtime host-path discovery for the eval harness (WK-0237 slice A, scope
 * item 5's constraint: no personal path/username literal in committed code).
 * Every host path below is derived at call time, never hard-coded:
 *   - kb root: from this module's own file location (mirrors
 *     scripts/setup-test-kb.mjs's `KB` derivation).
 *   - test_kb / test_kb_data: siblings of the kb root (same sibling rule
 *     scripts/setup-test-kb.mjs uses for test_kb).
 *   - credentials file: under `os.homedir()`.
 *   - the Claude CLI package dir: the realpath of `claude` resolved off
 *     `process.env.PATH`, with its own `bin/<binary>` leaf stripped off
 *     (host fact, 2026-11-01: realpath ends `.../claude-code/bin/claude.exe`).
 *   - resolv.conf realpath: the realpath of `/etc/resolv.conf` (WK-0237 slice
 *     A.1 — on WSL2 this resolves outside every SYSTEM_ROOTS entry, e.g.
 *     `/mnt/wsl/resolv.conf`, which is why jail.ts needs it as an explicit
 *     bind input rather than relying on the `/etc` system-root bind).
 */
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, ok, type EvalResult } from './result.js';

/** The kb checkout root — this module lives directly under it, at `evals/paths.ts`. */
export function getKbRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** `test_kb`'s path, a sibling of the kb root (scripts/setup-test-kb.mjs's own rule). */
export function getTestKbRoot(kbRoot: string): string {
  return resolve(kbRoot, '..', 'test_kb');
}

/** `test_kb_data`'s path, `test_kb`'s sister dir (WK-0158). */
export function getTestKbDataRoot(kbRoot: string): string {
  return resolve(kbRoot, '..', 'test_kb_data');
}

/** The host Claude credentials file, mode 600 per the captured host facts. */
export function getCredentialsFile(home: string): string {
  return join(home, '.claude', '.credentials.json');
}

/**
 * Pure PATH scan for an executable file named `name` — no shell, no `which`
 * subprocess, so it is exercisable in a unit test against a synthetic PATH
 * and an injected existence check.
 */
export function findOnPath(
  name: string,
  pathEnv: string,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export const RESOLV_CONF_PATH = '/etc/resolv.conf';

/**
 * Resolve `/etc/resolv.conf`'s realpath, when the file exists. Returns null
 * when it does not exist — jail.ts's `buildEvalJailArgs` treats null as
 * "nothing to bind", same as the host simply having no resolver config.
 */
export function resolveResolvConfRealpath(
  exists: (path: string) => boolean = existsSync,
  realpath: (path: string) => string = realpathSync,
): string | null {
  if (!exists(RESOLV_CONF_PATH)) return null;
  return realpath(RESOLV_CONF_PATH);
}

/** True when `path` is `home` itself or nested under it. */
export function isUnderHome(path: string, home: string): boolean {
  return path === home || path.startsWith(`${home}/`);
}

/**
 * Refuses a resolv.conf realpath that lives under the operator's home
 * directory — that path must never be bound into the jail. Passing `null`
 * through unchanged lets callers chain this with `resolveResolvConfRealpath`
 * regardless of whether resolv.conf exists.
 */
export function checkResolvConfRealpath(
  resolvConfRealpath: string | null,
  home: string,
): EvalResult<string | null> {
  if (resolvConfRealpath !== null && isUnderHome(resolvConfRealpath, home)) {
    return fail(
      'RESOLV_CONF_UNDER_HOME',
      `refusing to bind /etc/resolv.conf's realpath ${resolvConfRealpath}: it is under the operator's home directory.`,
    );
  }
  return ok(resolvConfRealpath);
}

/**
 * Strip the CLI binary's own leaf path (e.g. `bin/claude.exe`) off its
 * realpath to get the npm package directory it ships from.
 */
export function deriveCliPackageDir(claudeRealpath: string): string {
  const binDir = dirname(claudeRealpath);
  return dirname(binDir);
}

/** The binary's path relative to its package dir (e.g. `bin/claude.exe`) — used to rebuild the equivalent path under the jail's neutral package-dir bind. */
export function deriveCliBinaryRelPath(claudeRealpath: string, cliPackageDir: string): string {
  return relative(cliPackageDir, claudeRealpath);
}

export interface HostPaths {
  kbRoot: string;
  testKb: string;
  testKbData: string;
  credentialsFile: string;
  cliPackageDir: string;
  cliBinaryRelPath: string;
  /** Host realpath of the `claude` binary itself — e.g. for a host-side `claude --version` probe. */
  claudeRealpath: string;
  /** Host realpath of `/etc/resolv.conf`, or null when it does not exist. Never under the operator's home — `discoverHostPaths` fails first. */
  resolvConfRealpath: string | null;
}

/**
 * Discover every host path the eval jail needs. The only non-pure step is
 * locating and realpath-ing the `claude` binary on PATH — everything else is
 * path arithmetic. Never throws: a missing `claude` on PATH is a Result
 * failure, not an exception.
 */
export function discoverHostPaths(): EvalResult<HostPaths> {
  const kbRoot = getKbRoot();
  const testKb = getTestKbRoot(kbRoot);
  const testKbData = getTestKbDataRoot(kbRoot);
  const credentialsFile = getCredentialsFile(homedir());

  const claudeOnPath = findOnPath('claude', process.env.PATH ?? '');
  if (claudeOnPath === null) {
    return fail('CLAUDE_NOT_FOUND', 'claude not found on PATH; cannot derive the CLI package dir.');
  }

  let claudeRealpath: string;
  try {
    claudeRealpath = realpathSync(claudeOnPath);
  } catch (err) {
    return fail(
      'CLAUDE_NOT_FOUND',
      `failed to resolve realpath of ${claudeOnPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const cliPackageDir = deriveCliPackageDir(claudeRealpath);
  const cliBinaryRelPath = deriveCliBinaryRelPath(claudeRealpath, cliPackageDir);

  const resolvConfCheck = checkResolvConfRealpath(resolveResolvConfRealpath(), homedir());
  if (!resolvConfCheck.ok) {
    return resolvConfCheck;
  }
  const resolvConfRealpath = resolvConfCheck.data;

  return ok({
    kbRoot,
    testKb,
    testKbData,
    credentialsFile,
    cliPackageDir,
    cliBinaryRelPath,
    claudeRealpath,
    resolvConfRealpath,
  });
}

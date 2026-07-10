import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Token state directories
// ---------------------------------------------------------------------------

/** Token lifecycle states, each backed by a subdirectory under config. */
export type TokenState = 'pending' | 'launching' | 'consumed' | 'rejected';

// ---------------------------------------------------------------------------
// Operator config directory
// ---------------------------------------------------------------------------

/**
 * Resolve the operator config directory for a given platform and environment.
 *
 * - POSIX: honors a set, non-empty `XDG_CONFIG_HOME` (→ `$XDG_CONFIG_HOME/kb-dispatch`),
 *   otherwise `$HOME/.config/kb-dispatch/`. Honoring `XDG_CONFIG_HOME` lets dispatch run
 *   on hosts whose `$HOME` is mounted read-only (e.g. Saturn/Posit container pods) by
 *   redirecting the token store to a writable directory.
 * - Windows primary: `%APPDATA%\kb-dispatch\`
 * - Windows fallback: `%USERPROFILE%\.config\kb-dispatch\`
 *
 * Pure and platform-parameterized so config resolution is unit-testable on any host.
 */
export function resolveConfigDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData) {
      return join(appData, 'kb-dispatch');
    }
    const userProfile = env['USERPROFILE'];
    if (userProfile) {
      return join(userProfile, '.config', 'kb-dispatch');
    }
    throw new Error(
      'Cannot resolve config directory: neither APPDATA nor USERPROFILE is set',
    );
  }

  // POSIX
  const xdgConfigHome = env['XDG_CONFIG_HOME'];
  if (xdgConfigHome !== undefined && xdgConfigHome !== '') {
    return join(xdgConfigHome, 'kb-dispatch');
  }
  const home = env['HOME'];
  if (!home) {
    throw new Error('Cannot resolve config directory: HOME is not set');
  }
  return join(home, '.config', 'kb-dispatch');
}

/**
 * Resolve the operator config directory for the current process.
 */
export function getConfigDir(): string {
  return resolveConfigDir(process.platform, process.env);
}

// ---------------------------------------------------------------------------
// Token state subdirectory
// ---------------------------------------------------------------------------

/**
 * Resolve a token state subdirectory under the operator config directory.
 *
 * - `pending/`   — freshly reviewed, awaiting launch
 * - `launching/` — launch in progress
 * - `consumed/`  — successfully launched
 * - `rejected/`  — rejected or expired
 */
export function getTokenDir(state: TokenState): string {
  return join(getConfigDir(), state);
}

/**
 * Resolve the operator-owned host capabilities record path.
 *
 * Path: `<configDir>/host-capabilities.v1.json`
 */
export function getHostCapabilitiesPath(): string {
  return join(getConfigDir(), 'host-capabilities.v1.json');
}

// ---------------------------------------------------------------------------
// Repo runtime directories
// ---------------------------------------------------------------------------

/**
 * Resolve the review bundle directory for a given review id.
 *
 * Path: `<repoRoot>/.agent-runs/reviews/RV-<uuid>/`
 */
export function getReviewDir(repoRoot: string, reviewId: string): string {
  return join(repoRoot, '.agent-runs', 'reviews', reviewId);
}

/**
 * Resolve the run directory for a given handoff/run combination.
 *
 * Path: `<repoRoot>/.agent-runs/runs/<handoffId>/RUN-<uuid>/`
 */
export function getRunDir(
  repoRoot: string,
  handoffId: string,
  runId: string,
): string {
  return join(repoRoot, '.agent-runs', 'runs', handoffId, runId);
}

// ---------------------------------------------------------------------------
// Ensure config directory structure
// ---------------------------------------------------------------------------

const TOKEN_STATES: TokenState[] = [
  'pending',
  'launching',
  'consumed',
  'rejected',
];

/**
 * Create the operator config directory structure if absent.
 *
 * Creates:
 * - `<configDir>/`
 * - `<configDir>/pending/`
 * - `<configDir>/launching/`
 * - `<configDir>/consumed/`
 * - `<configDir>/rejected/`
 */
export async function ensureConfigDirs(): Promise<string> {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });
  for (const state of TOKEN_STATES) {
    await mkdir(join(configDir, state), { recursive: true });
  }
  return configDir;
}

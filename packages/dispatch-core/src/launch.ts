import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { agentRegistrySchema } from './schemas.js';
import type {
  AgentRegistry,
  AgentLauncherConfig,
  LaunchOpts,
  RunResult,
  TokenPayload,
} from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { getConfigDir, getReviewDir, getRunDir } from './paths.js';
import { readTokenFile, verifyToken, moveToken } from './token.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_FILE = 'launchers.v1.json';

/**
 * Environment variable allowlist (POSIX-oriented).
 */
const ENV_ALLOWLIST_POSIX = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
];

/**
 * Additional environment variable allowlist for Windows.
 */
const ENV_ALLOWLIST_WINDOWS = [
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashBuffer(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function computeManifestHash(entries: { path: string; hash: string }[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const combined = sorted.map((e) => `${e.path}:${e.hash}`).join('\n');
  return hashBuffer(combined);
}

/**
 * Build a filtered environment for the agent process.
 *
 * Only safe allowlisted variables plus launcher-set variables are included.
 */
function buildFilteredEnv(
  payload: TokenPayload,
  runDir: string,
  bundlePath: string,
  launcherEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};

  // Build the full allowlist based on platform
  const allowlist = [...ENV_ALLOWLIST_POSIX];
  if (process.platform === 'win32') {
    allowlist.push(...ENV_ALLOWLIST_WINDOWS);
  }

  // Copy allowed environment variables from current process
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Add launcher-configured env vars
  if (launcherEnv) {
    Object.assign(env, launcherEnv);
  }

  // Add dispatch-specific environment variables
  const responsePath = join(runDir, 'response.md');
  env['AGENT_BLACKBOARD_REPO_ROOT'] = payload.repoRoot;
  env['AGENT_BLACKBOARD_RUN_DIR'] = runDir;
  env['AGENT_BLACKBOARD_AGENT_VISIBLE_DIR'] = bundlePath;
  env['AGENT_BLACKBOARD_HANDOFF_PATH'] = join(bundlePath, 'review-manifest.json');
  env['AGENT_BLACKBOARD_CONTEXT_DIR'] = bundlePath;
  env['AGENT_BLACKBOARD_RESPONSE_PATH'] = responsePath;
  env['AGENT_BLACKBOARD_REVIEW_ID'] = payload.reviewId;
  env['AGENT_BLACKBOARD_RUN_ID'] = `RUN-${randomUUID()}`;

  return env;
}

/**
 * Load the agent registry from the config directory.
 */
async function loadRegistry(): Promise<DispatchResult<{ registry: AgentRegistry; hash: string }>> {
  const registryPath = join(getConfigDir(), REGISTRY_FILE);
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf-8');
  } catch {
    return fail(
      'REGISTRY_NOT_FOUND',
      `Agent registry not found at ${registryPath}. Run init-config first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('PARSE_ERROR', `Failed to parse agent registry at ${registryPath}.`);
  }

  const result = agentRegistrySchema.safeParse(parsed);
  if (!result.success) {
    return fail('PARSE_ERROR', `Invalid agent registry format.`, result.error);
  }

  return ok({ registry: result.data as AgentRegistry, hash: hashBuffer(raw) });
}

/**
 * Re-verify the review bundle hash against the token's recorded hash.
 */
async function verifyBundleHash(
  bundlePath: string,
  expectedHash: string,
): Promise<DispatchResult<true>> {
  // Read the review manifest to get file entries
  const manifestPath = join(bundlePath, 'review-manifest.json');
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, 'utf-8');
  } catch {
    return fail('REVIEW_NOT_FOUND', `Review manifest not found at ${manifestPath}.`);
  }

  let manifest: { files: { path: string; hash: string }[] };
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return fail('PARSE_ERROR', `Failed to parse review manifest.`);
  }

  // Recompute hashes of all files in the bundle
  const recomputedEntries: { path: string; hash: string }[] = [];
  for (const entry of manifest.files) {
    const filePath = join(bundlePath, entry.path);
    try {
      const content = await readFile(filePath);
      recomputedEntries.push({ path: entry.path, hash: hashBuffer(content) });
    } catch {
      return fail('HASH_MISMATCH', `Bundle file missing: ${entry.path}`);
    }
  }

  const recomputedHash = computeManifestHash(recomputedEntries);
  if (recomputedHash !== expectedHash) {
    return fail(
      'HASH_MISMATCH',
      `Review bundle hash mismatch. Expected ${expectedHash}, got ${recomputedHash}. The bundle may have been tampered with.`,
    );
  }

  return ok(true);
}

// ---------------------------------------------------------------------------
// Spawn wrapper
// ---------------------------------------------------------------------------

/**
 * Spawn the agent process and wait for it to exit.
 */
function spawnAgent(
  config: AgentLauncherConfig,
  env: Record<string, string>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(config.command, config.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Launch implementation
// ---------------------------------------------------------------------------

/**
 * Launch a reviewed handoff against a configured agent.
 *
 * Follows the full launch sequence:
 * 1. Load and verify pending token
 * 2. Re-verify review bundle and registry hashes
 * 3. Move token to launching/
 * 4. Create run directory
 * 5. Spawn agent with cwd = repo_root
 * 6. Move token to consumed/ on success
 * 7. Capture and normalize response
 */
export async function launch(opts: LaunchOpts): Promise<DispatchResult<RunResult>> {
  const { reviewId } = opts;
  const startedAt = new Date().toISOString();

  // -------------------------------------------------------------------------
  // 1. Load pending token
  // -------------------------------------------------------------------------
  const tokenResult = await readTokenFile(reviewId, 'pending');
  if (!tokenResult.ok) return tokenResult;

  const token = tokenResult.data;

  // -------------------------------------------------------------------------
  // 2. Verify token signature and expiry
  // -------------------------------------------------------------------------
  const verifyResult = await verifyToken(token);
  if (!verifyResult.ok) {
    await moveToken(reviewId, 'pending', 'rejected');
    return verifyResult;
  }

  const payload = verifyResult.data;

  // -------------------------------------------------------------------------
  // 3. Verify repo root exists
  // -------------------------------------------------------------------------
  const repoRoot = resolve(opts.dir);
  try {
    await stat(repoRoot);
  } catch {
    await moveToken(reviewId, 'pending', 'rejected');
    return fail('REPO_ROOT_MISMATCH', `Repo root does not exist: ${repoRoot}`);
  }

  // -------------------------------------------------------------------------
  // 4. Re-verify review bundle hash
  // -------------------------------------------------------------------------
  const bundlePath = getReviewDir(payload.repoRoot, reviewId);
  const bundleHashResult = await verifyBundleHash(bundlePath, payload.inputManifestHash);
  if (!bundleHashResult.ok) {
    await moveToken(reviewId, 'pending', 'rejected');
    return bundleHashResult;
  }

  // -------------------------------------------------------------------------
  // 5. Re-verify registry hash
  // -------------------------------------------------------------------------
  const registryResult = await loadRegistry();
  if (!registryResult.ok) {
    await moveToken(reviewId, 'pending', 'rejected');
    return registryResult;
  }

  if (registryResult.data.hash !== payload.registryHash) {
    await moveToken(reviewId, 'pending', 'rejected');
    return fail(
      'HASH_MISMATCH',
      `Registry hash mismatch. The agent registry has changed since review.`,
    );
  }

  // -------------------------------------------------------------------------
  // 6. Load agent config
  // -------------------------------------------------------------------------
  const agentConfig = registryResult.data.registry.agents[payload.agent];
  if (!agentConfig) {
    await moveToken(reviewId, 'pending', 'rejected');
    return fail('INVALID_AGENT', `Agent "${payload.agent}" not found in registry.`);
  }

  // -------------------------------------------------------------------------
  // 7. Move token to launching/
  // -------------------------------------------------------------------------
  const moveToLaunching = await moveToken(reviewId, 'pending', 'launching');
  if (!moveToLaunching.ok) return moveToLaunching;

  // -------------------------------------------------------------------------
  // 8. Create run directory
  // -------------------------------------------------------------------------
  const runId = `RUN-${randomUUID()}`;
  const runDir = getRunDir(payload.repoRoot, payload.handoffId, runId);
  await mkdir(runDir, { recursive: true });

  // -------------------------------------------------------------------------
  // 9. Build filtered environment and construct argv
  // -------------------------------------------------------------------------
  const env = buildFilteredEnv(payload, runDir, bundlePath, agentConfig.env);

  // -------------------------------------------------------------------------
  // 10. Write launch metadata
  // -------------------------------------------------------------------------
  const launchMeta = {
    runId,
    reviewId,
    handoffId: payload.handoffId,
    agent: payload.agent,
    mode: payload.mode,
    repoRoot: payload.repoRoot,
    command: agentConfig.command,
    args: agentConfig.args,
    startedAt,
    state: 'launching',
  };
  await writeFile(join(runDir, 'launch-meta.json'), JSON.stringify(launchMeta, null, 2));

  // -------------------------------------------------------------------------
  // 11. Spawn child process with cwd = repo_root
  // -------------------------------------------------------------------------
  let spawnResult: { exitCode: number; stdout: string; stderr: string };
  try {
    spawnResult = await spawnAgent(agentConfig, env, payload.repoRoot);
  } catch (err) {
    await moveToken(reviewId, 'launching', 'rejected');
    return fail('LAUNCH_FAILED', `Agent process failed to spawn.`, err);
  }

  // -------------------------------------------------------------------------
  // 12. Capture and normalize response
  // -------------------------------------------------------------------------
  const completedAt = new Date().toISOString();
  const responsePath = env['AGENT_BLACKBOARD_RESPONSE_PATH']!;

  let response: string | undefined;
  try {
    response = await readFile(responsePath, 'utf-8');
  } catch {
    // Response file may not exist if agent didn't write one
  }

  // Fall back to stdout if no response file
  if (!response && spawnResult.stdout.trim()) {
    response = spawnResult.stdout.trim();
  }

  // Check for empty response (launch failure per implementation plan)
  if (!response || response.trim() === '') {
    await moveToken(reviewId, 'launching', 'rejected');
    // Write final state metadata before returning failure
    const failMeta = {
      ...launchMeta,
      state: 'rejected',
      exitCode: spawnResult.exitCode,
      completedAt,
      error: 'Empty agent response',
    };
    await writeFile(join(runDir, 'launch-meta.json'), JSON.stringify(failMeta, null, 2));
    return fail('EMPTY_RESPONSE', 'Agent produced an empty response. Launch is considered failed.');
  }

  // -------------------------------------------------------------------------
  // 13. Move token to consumed/
  // -------------------------------------------------------------------------
  await moveToken(reviewId, 'launching', 'consumed');

  // -------------------------------------------------------------------------
  // 14. Write final state metadata
  // -------------------------------------------------------------------------
  const finalMeta = {
    ...launchMeta,
    state: 'consumed',
    exitCode: spawnResult.exitCode,
    completedAt,
    responsePath,
  };
  await writeFile(join(runDir, 'launch-meta.json'), JSON.stringify(finalMeta, null, 2));

  // Write stderr log if present
  if (spawnResult.stderr.trim()) {
    await writeFile(join(runDir, 'stderr.log'), spawnResult.stderr);
  }

  // -------------------------------------------------------------------------
  // 15. Return run result
  // -------------------------------------------------------------------------
  const result: RunResult = {
    runId,
    reviewId,
    handoffId: payload.handoffId,
    agent: payload.agent,
    mode: payload.mode,
    runDir,
    exitCode: spawnResult.exitCode,
    response,
    startedAt,
    completedAt,
  };

  return ok(result);
}

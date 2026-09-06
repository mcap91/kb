import { spawn } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ReviewOpts } from './types.js';
import type { BackgroundLaunchResult, BackgroundLaunchOpts } from './types-background.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { review } from './review.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 150;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const controllerEntryPath = join(__dirname, 'controller-entry.ts');

function hasTsxLoader(execArgv: string[]): boolean {
  return execArgv.some((arg) => arg.includes('tsx'));
}

async function buildControllerArgv(): Promise<DispatchResult<string[]>> {
  if (hasTsxLoader(process.execArgv)) {
    return ok([...process.execArgv]);
  }

  const tsxPaths = [
    join(__dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs'),
    join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  ];
  for (const loaderPath of tsxPaths) {
    try {
      await access(loaderPath);
      return ok(['--import', pathToFileURL(loaderPath).href]);
    } catch {
      continue;
    }
  }

  return fail(
    'BACKGROUND_LAUNCH_FAILED',
    'Cannot resolve TypeScript loader (tsx) for controller process. Ensure tsx is installed or the parent process was launched with --import tsx.',
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function tryReadJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function tryReadPrelaunchState(
  repoRoot: string,
  reviewId: string,
): Promise<Record<string, unknown> | null> {
  return tryReadJson(join(repoRoot, '.agent-runs', 'reviews', reviewId, 'metadata', 'background-launch.json'));
}

async function findRunDir(
  repoRoot: string,
  reviewId: string,
): Promise<{ runDir: string; runId: string; handoffId: string } | null> {
  const runsDir = join(repoRoot, '.agent-runs', 'runs');

  let handoffDirs: string[];
  try {
    handoffDirs = await readdir(runsDir);
  } catch {
    return null;
  }

  for (const handoffId of handoffDirs) {
    let runIds: string[];
    try {
      runIds = await readdir(join(runsDir, handoffId));
    } catch {
      continue;
    }

    for (const runId of runIds) {
      const launchPath = join(runsDir, handoffId, runId, 'metadata', 'launch.json');
      const launchMeta = await tryReadJson(launchPath);
      if (launchMeta && launchMeta.review_id === reviewId) {
        return { runDir: join(runsDir, handoffId, runId), runId, handoffId };
      }
    }
  }

  return null;
}

interface StartGateResult {
  launchMeta: Record<string, unknown>;
  stateJson: Record<string, unknown>;
  runDir: string;
  runId: string;
  handoffId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollStartGate(
  repoRoot: string,
  reviewId: string,
  controllerPid: number,
  timeoutMs: number,
): Promise<DispatchResult<StartGateResult>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const runInfo = await findRunDir(repoRoot, reviewId);
    if (runInfo) {
      const metadataDir = join(runInfo.runDir, 'metadata');

      const launchMeta = await tryReadJson(join(metadataDir, 'launch.json'));
      if (launchMeta && launchMeta.token_state === 'rejected') {
        return fail('BACKGROUND_LAUNCH_FAILED', 'Launch token was rejected.', {
          runDir: runInfo.runDir,
        });
      }

      const metaJson = await tryReadJson(join(metadataDir, 'meta.json'));
      if (metaJson && typeof metaJson.status === 'string') {
        const s = metaJson.status;
        if (s === 'failed' || s === 'rejected' || s === 'timed_out' || s === 'cancelled') {
          return fail('BACKGROUND_LAUNCH_FAILED', `Run reached terminal status before start gate: ${s}`, {
            runDir: runInfo.runDir,
            status: s,
          });
        }
      }

      if (launchMeta && launchMeta.token_state === 'consumed') {
        const stateJson = await tryReadJson(join(metadataDir, 'state.json'));
        if (stateJson && typeof stateJson.pid === 'number') {
          const responsePath = join(runInfo.runDir, 'response.md');
          const stderrPath = join(metadataDir, 'stderr.log');

          const responseOk = await fileExists(responsePath);
          const stderrOk = await fileExists(stderrPath);

          if (responseOk && stderrOk) {
            const stdoutPath = launchMeta.stdout_path as string | null;
            if (stdoutPath) {
              const stdoutOk = await fileExists(stdoutPath);
              if (!stdoutOk) {
                await sleep(POLL_INTERVAL_MS);
                continue;
              }
            }

            return ok({
              launchMeta,
              stateJson,
              runDir: runInfo.runDir,
              runId: runInfo.runId,
              handoffId: runInfo.handoffId,
            });
          }
        }
      }
    }

    if (!isAlive(controllerPid)) {
      const runInfo2 = await findRunDir(repoRoot, reviewId);
      if (runInfo2) {
        const deadLaunchMeta = await tryReadJson(join(runInfo2.runDir, 'metadata', 'launch.json'));
        const deadMetaJson = await tryReadJson(join(runInfo2.runDir, 'metadata', 'meta.json'));
        return fail('BACKGROUND_LAUNCH_FAILED', 'Controller process exited before start gate was satisfied.', {
          runDir: runInfo2.runDir,
          controllerPid,
          launchMeta: deadLaunchMeta,
          metaJson: deadMetaJson,
        });
      }
      const prelaunchState = await tryReadPrelaunchState(repoRoot, reviewId);
      if (prelaunchState && typeof prelaunchState.error === 'string') {
        return fail(
          'BACKGROUND_LAUNCH_FAILED',
          prelaunchState.error,
          {
            controllerPid,
            prelaunchState,
          },
        );
      }
      return fail('BACKGROUND_LAUNCH_FAILED', 'Controller process exited before any run was created.', {
        controllerPid,
      });
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const runInfo = await findRunDir(repoRoot, reviewId);
  return fail('BACKGROUND_LAUNCH_FAILED', 'Startup timeout expired before confirmed child start.', {
    timeoutMs,
    runDir: runInfo?.runDir ?? null,
  });
}

export async function launchBackground(
  opts: BackgroundLaunchOpts,
): Promise<DispatchResult<BackgroundLaunchResult>> {
  const repoRoot = resolve(opts.dir);
  const timeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  const argvResult = await buildControllerArgv();
  if (!argvResult.ok) return argvResult;

  const child = spawn(process.execPath, [
    ...argvResult.data,
    controllerEntryPath,
    '--review-id', opts.reviewId,
    '--dir', repoRoot,
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
  ], {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });

  const controllerPid = child.pid;
  if (controllerPid === undefined) {
    return fail('BACKGROUND_LAUNCH_FAILED', 'Failed to spawn controller process.');
  }

  child.unref();

  const gateResult = await pollStartGate(repoRoot, opts.reviewId, controllerPid, timeoutMs);
  if (!gateResult.ok) return gateResult;

  const { launchMeta, stateJson, runDir, runId, handoffId } = gateResult.data;
  const metadataDir = join(runDir, 'metadata');
  const reviewJson = await tryReadJson(join(metadataDir, 'review.json'));

  return ok({
    reviewId: opts.reviewId,
    runId,
    handoffId,
    agent: (reviewJson?.agent as string) ?? 'unknown',
    mode: ((reviewJson?.mode as string) ?? 'implement') as BackgroundLaunchResult['mode'],
    status: 'launching',
    runDir,
    responsePath: join(runDir, 'response.md'),
    metaPath: join(metadataDir, 'meta.json'),
    statePath: join(metadataDir, 'state.json'),
    launchPath: join(metadataDir, 'launch.json'),
    controllerPath: join(metadataDir, 'controller.json'),
    stdoutPath: (launchMeta.stdout_path as string) ?? null,
    stderrPath: (launchMeta.stderr_path as string) ?? join(metadataDir, 'stderr.log'),
    startedAt: (launchMeta.started_at as string) ?? new Date().toISOString(),
    heartbeatAt: (stateJson.heartbeat_at as string) ?? new Date().toISOString(),
    pid: stateJson.pid as number,
    pgid: (stateJson.pgid as number) ?? (stateJson.pid as number),
  });
}

export async function reviewAndLaunchBackground(
  reviewOpts: ReviewOpts,
  backgroundOpts?: { startupTimeoutMs?: number },
): Promise<DispatchResult<BackgroundLaunchResult>> {
  const reviewResult = await review(reviewOpts);
  if (!reviewResult.ok) return reviewResult;

  return launchBackground({
    reviewId: reviewResult.data.reviewId,
    dir: reviewOpts.dir,
    startupTimeoutMs: backgroundOpts?.startupTimeoutMs,
    verbose: reviewOpts.verbose,
    model: reviewOpts.model,
    effort: reviewOpts.effort,
  });
}

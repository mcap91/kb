/**
 * v2 background dispatch launcher (dispatch v2, PLN-0004 S1 Wave 2a).
 *
 * The v2 analog of `launch-background.ts` (v1): spawns the detached
 * `dispatch-controller-entry.ts` controller and polls for its start gate.
 * Reuses v1's proven mechanics verbatim where they transfer directly
 * (tsx-loader argv resolution, detached spawn + `unref()`, 150ms poll
 * interval, 30s default startup timeout — s1-rulings ruling 4).
 *
 * Identity injection: the launcher mints the run id pre-spawn and passes
 * `--run-id` to the controller, which threads it into `runDispatch()`. One
 * run id → one run dir → state.json and artifacts colocated. The start
 * gate polls one exact path instead of diffing directory listings.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { parseHandoff } from './ho.js';
import { checkAdmission } from './admission.js';
import { getDefaultRegistry, resolveModel } from './model-registry.js';
import { getRunDir } from './paths.js';
import { isAlive } from './run-state.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 150;

/** s1-rulings ruling 3/6: a `running` run counts as active while its heartbeat is this fresh. */
const ACTIVE_RUN_FRESH_HEARTBEAT_SECS = 300;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const controllerEntryPath = join(__dirname, 'dispatch-controller-entry.ts');

export interface DispatchBackgroundOpts {
  dir: string;
  /** Repo-relative path to the HO file (e.g. `wiki/handoffs/HO-0004.md`). */
  handoff: string;
  /** Model alias from the registry (e.g. 'deepseek', 'qwen3:8b'). */
  model: string;
  effort?: string;
  /** Run preflight before dispatch? (default: true) */
  preflight?: boolean;
  verbose?: boolean;
  startupTimeoutMs?: number;
}

export interface DispatchBackgroundResult {
  runId: string;
  handoffId: string;
  model: string;
  status: 'running';
  runDir: string;
  statePath: string;
  logPath: string;
  responsePath: string;
  pid: number;
}

function hasTsxLoader(execArgv: string[]): boolean {
  return execArgv.some((arg) => arg.includes('tsx'));
}

/** Verbatim mechanics from `launch-background.ts`'s `buildControllerArgv` (s1-rulings ruling 4). */
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

async function tryReadJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function listRunIds(repoRoot: string, handoffId: string): Promise<string[]> {
  try {
    return await readdir(join(repoRoot, '.agent-runs', 'runs', handoffId));
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * s1-rulings ruling 3: a `running` v2 run counts as active when its heartbeat
 * is fresh OR its recorded pid is alive — a `running` status alone is not
 * enough (a hard-killed controller, e.g. `kill -9`, can leave a stale
 * `running` record behind even with `dispatch-controller-entry.ts`'s
 * unconditional terminal write, since that write can never run if the
 * process itself is killed ungracefully).
 */
function isRunActive(state: Record<string, unknown>): boolean {
  if (state.status !== 'running') return false;

  const heartbeatAt = typeof state.heartbeat_at === 'string' ? Date.parse(state.heartbeat_at) : NaN;
  const heartbeatAgeSecs = Number.isFinite(heartbeatAt) ? (Date.now() - heartbeatAt) / 1000 : Infinity;
  const fresh = heartbeatAgeSecs <= ACTIVE_RUN_FRESH_HEARTBEAT_SECS;

  const pidAlive = typeof state.pid === 'number' && isAlive(state.pid);

  return fresh || pidAlive;
}

/**
 * s1-rulings ruling 3 — the `ACTIVE_RUN_EXISTS` single-flight guard. Same-HO
 * only (cross-HO concurrency is S4, tracker T14 note): scans
 * `.agent-runs/runs/<handoffId>/` for any run dir whose `state.json` reports
 * a still-active run. Exported for direct unit testing.
 */
export async function checkActiveRunExists(
  repoRoot: string,
  handoffId: string,
): Promise<DispatchResult<{ active: false }>> {
  const runIds = await listRunIds(repoRoot, handoffId);

  for (const runId of runIds) {
    const runDir = join(repoRoot, '.agent-runs', 'runs', handoffId, runId);
    const state = await tryReadJson(join(runDir, 'state.json'));
    if (state && isRunActive(state)) {
      return fail(
        'ACTIVE_RUN_EXISTS',
        `An active run already exists for handoff "${handoffId}" (run ${runId}). Wait for it to finish or cancel it before dispatching again.`,
        { handoffId, runId, runDir },
      );
    }
  }

  return ok({ active: false });
}

/**
 * Poll for the controller's `state.json` at the exact known path (the
 * launcher mints the run id pre-spawn, so the path is deterministic).
 * Exported for direct unit testing.
 */
export async function pollDispatchStartGate(
  statePath: string,
  controllerPid: number,
  timeoutMs: number,
): Promise<DispatchResult<{ pid: number }>> {
  const deadline = Date.now() + timeoutMs;

  const check = async (): Promise<number | null> => {
    const state = await tryReadJson(statePath);
    if (state && state.status === 'running' && typeof state.pid === 'number') {
      return state.pid;
    }
    return null;
  };

  while (Date.now() < deadline) {
    const pid = await check();
    if (pid !== null) return ok({ pid });

    if (!isAlive(controllerPid)) {
      const lastChance = await check();
      if (lastChance !== null) return ok({ pid: lastChance });
      return fail(
        'BACKGROUND_LAUNCH_FAILED',
        'Controller process exited before start gate was satisfied.',
        { controllerPid },
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return fail(
    'BACKGROUND_LAUNCH_FAILED',
    'Startup timeout expired before confirmed controller start.',
    { timeoutMs },
  );
}

/**
 * Launch the v2 dispatch pipeline in a detached background controller.
 * Mints the run id HERE (identity injection downward) and passes `--run-id`
 * to the controller, which threads it into `runDispatch()`. One run id →
 * one run dir → state.json and all pipeline artifacts colocated.
 */
export async function launchDispatchBackground(
  opts: DispatchBackgroundOpts,
): Promise<DispatchResult<DispatchBackgroundResult>> {
  const repoRoot = resolve(opts.dir);
  const timeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  // Synchronous gate (ruling 2): all fast, deterministic checks run HERE
  // before spawning. Refusals return immediately with no runId. The controller
  // re-runs these inside runDispatch() (idempotent, cheap).
  const parsed = await parseHandoff(join(repoRoot, opts.handoff));
  if (!parsed.ok) return parsed;
  const handoffId = parsed.data.id;

  const admission = await checkAdmission(parsed.data, repoRoot);
  if (!admission.ok) return admission;

  const modelResult = resolveModel(getDefaultRegistry(), opts.model);
  if (!modelResult.ok) return modelResult;

  const activeCheck = await checkActiveRunExists(repoRoot, handoffId);
  if (!activeCheck.ok) return activeCheck;

  const argvResult = await buildControllerArgv();
  if (!argvResult.ok) return argvResult;

  const runId = `RUN-${randomUUID()}`;
  const runDir = getRunDir(repoRoot, handoffId, runId);
  const statePath = join(runDir, 'state.json');

  const effortArgs = opts.effort ? ['--effort', opts.effort] : [];
  const preflightArgs = opts.preflight === false ? ['--no-preflight'] : [];

  const child = spawn(
    process.execPath,
    [
      ...argvResult.data,
      controllerEntryPath,
      '--dir', repoRoot,
      '--handoff', opts.handoff,
      '--model', opts.model,
      '--run-id', runId,
      ...effortArgs,
      ...preflightArgs,
    ],
    {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    },
  );

  const controllerPid = child.pid;
  if (controllerPid === undefined) {
    return fail('BACKGROUND_LAUNCH_FAILED', 'Failed to spawn controller process.');
  }

  child.unref();

  const gateResult = await pollDispatchStartGate(statePath, controllerPid, timeoutMs);
  if (!gateResult.ok) return gateResult;

  return ok({
    runId,
    handoffId,
    model: opts.model,
    status: 'running',
    runDir,
    statePath,
    logPath: join(runDir, 'pi-output.log'),
    responsePath: join(repoRoot, 'wiki', 'handoffs', `${handoffId}.response.md`),
    pid: gateResult.data.pid,
  });
}

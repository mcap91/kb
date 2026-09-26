import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { WaitForRunResult, WaitForRunOpts, RunStatus } from './types-background.js';
import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';
import { resolveRun, readRunArtifacts } from './lookup.js';
import { isRecordedProcessAlive } from './run-state.js';

const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_POLL_INTERVAL_MS = 1000;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'rejected']);

/**
 * v2's status vocabulary (s1-rulings ruling 5) — wider than v1's
 * `TerminalRunStatus`. `blocked`/`partial` retired (DEC-0010: not mechanical
 * run-level facts — the response doc's own verdict vocabulary dropped them
 * too, see capture.ts's `ResponseOutcome`).
 */
const TERMINAL_STATUSES_V2 = new Set(['completed', 'delivered', 'failed', 'refused', 'timed_out', 'cancelled']);

/**
 * Dead-run detection (mirrors status.ts's `ACTIVE_HEARTBEAT_GRACE_MS` /
 * `STALE_HEARTBEAT_THRESHOLD_SECS`, both 300s): a worker killed hard (e.g.
 * `kill -9`) never writes a terminal status, so without this check the poll
 * loop below would sleep out the full timeout watching a heartbeat that will
 * never move again. A run counts as dead once its heartbeat is stale AND its
 * recorded pid/pgid is no longer alive.
 */
const DEAD_RUN_HEARTBEAT_GRACE_MS = 5 * 60 * 1000;

function isRunDead(heartbeatAt: string | null, pid: number | null, pgid: number | null): boolean {
  if (pid === null) return false;
  const heartbeatMs = Date.parse(heartbeatAt ?? '');
  const heartbeatFresh = Number.isFinite(heartbeatMs) && (Date.now() - heartbeatMs) <= DEAD_RUN_HEARTBEAT_GRACE_MS;
  if (heartbeatFresh) return false;
  return !isRecordedProcessAlive(pid, pgid ?? pid);
}

function deadRunMessage(runId: string, pid: number | null): string {
  return `waitForRun: run ${runId} heartbeat stale (>${DEAD_RUN_HEARTBEAT_GRACE_MS / 1000}s) and pid ${pid ?? 'unknown'} not alive — returning status "failed" instead of waiting out the timeout.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * v2 dual-layout read (PLN-0004 S1 Wave 3, s1-rulings ruling 5/7): v2 runs
 * keep ONE `state.json` at the run root — no `metadata/` split — so this
 * builds a full `WaitForRunResult` directly from it instead of routing
 * through `readRunArtifacts` (which only understands the v1 `metadata/*.json`
 * shape). Returns null when `<runDir>/state.json` is absent or is not a v2
 * record, so callers fall back to the existing v1 path unchanged.
 */
async function tryBuildV2Result(runDir: string, repoRoot: string): Promise<WaitForRunResult | null> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, 'state.json'), 'utf-8');
  } catch {
    return null;
  }

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (state.schema_version !== 2) return null;

  const handoffId = typeof state.handoff_id === 'string' ? state.handoff_id : '';

  return {
    // v2 has no reviewId concept — '' mirrors readRunArtifacts's existing
    // "identity unknown" convention (lookup.ts) rather than widening this
    // shared v1/v2 type to add a null case for one field.
    reviewId: '',
    runId: typeof state.run_id === 'string' ? state.run_id : basename(runDir),
    handoffId,
    // v2's state.json persists the model alias but not the resolved family
    // (pi/codex/claude) — WK-0136 surfaces the model string here instead of
    // the previous hardcoded 'pi'.
    agent: typeof state.model === 'string' ? state.model : 'unknown',
    // state.json doesn't mirror the HO's mode; 'implement' matches lookup.ts's
    // existing identity-unknown default.
    mode: 'implement',
    // v2's status vocabulary (partial/blocked/refused) is wider than v1's
    // RunStatus union; cast rather than widen the shared type in this wave.
    status: (typeof state.status === 'string' ? state.status : 'unknown') as RunStatus,
    runDir,
    responsePath: join(repoRoot, 'wiki', 'handoffs', `${handoffId}.response.md`),
    // v2 collapses all lifecycle metadata into the one state.json (ruling 5) —
    // meta/state/launch all point at the same file rather than three files.
    metaPath: join(runDir, 'state.json'),
    statePath: join(runDir, 'state.json'),
    launchPath: join(runDir, 'state.json'),
    controllerPath: null,
    // v2's combined worker output lives at worker-output.log, surfaced via
    // status()'s logTail (ruling 6), not through these v1-shaped log fields.
    stdoutPath: null,
    stderrPath: null,
    startedAt: typeof state.started_at === 'string' ? state.started_at : null,
    heartbeatAt: typeof state.heartbeat_at === 'string' ? state.heartbeat_at : null,
    completedAt: typeof state.completed_at === 'string' ? state.completed_at : null,
    pid: typeof state.pid === 'number' ? state.pid : null,
    pgid: typeof state.pgid === 'number' ? state.pgid : null,
  };
}

function extractFromState(state: unknown): {
  startedAt: string | null;
  heartbeatAt: string | null;
  pid: number | null;
  pgid: number | null;
} {
  const s = state as Record<string, unknown> | null;
  return {
    startedAt: (s?.started_at as string) ?? null,
    heartbeatAt: (s?.heartbeat_at as string) ?? null,
    pid: (s?.pid as number) ?? null,
    pgid: (s?.pgid as number) ?? null,
  };
}

export async function waitForRun(opts: WaitForRunOpts): Promise<DispatchResult<WaitForRunResult>> {
  const repoRoot = resolve(opts.dir);
  const resolved = await resolveRun({
    dir: opts.dir,
    reviewId: opts.reviewId,
    runId: opts.runId,
  });
  if (!resolved.ok) return resolved;

  const { runDir } = resolved.data;
  const metadataDir = join(runDir, 'metadata');
  const metaPath = join(metadataDir, 'meta.json');

  const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // v2 dual-layout (ruling 5/7): check the v2 run-root state.json first on
    // every poll tick, so a v2 run's terminal write is observed without ever
    // touching the v1 metadata/ shape.
    const v2Result = await tryBuildV2Result(runDir, repoRoot);
    if (v2Result && TERMINAL_STATUSES_V2.has(v2Result.status)) {
      return ok(v2Result);
    }
    if (v2Result && isRunDead(v2Result.heartbeatAt, v2Result.pid, v2Result.pgid)) {
      console.error(deadRunMessage(v2Result.runId, v2Result.pid));
      return ok({ ...v2Result, status: 'failed' });
    }

    try {
      const raw = await readFile(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as Record<string, unknown>;
      if (typeof meta.status === 'string' && TERMINAL_STATUSES.has(meta.status)) {
        const artifacts = await readRunArtifacts(runDir, { includeMeta: true });
        if (!artifacts.ok) return artifacts;
        const stateInfo = extractFromState(artifacts.data.state);
        return ok({
          reviewId: artifacts.data.reviewId,
          runId: artifacts.data.runId,
          handoffId: artifacts.data.handoffId,
          agent: artifacts.data.agent,
          mode: artifacts.data.mode,
          status: artifacts.data.status,
          runDir: artifacts.data.runDir,
          responsePath: artifacts.data.responsePath,
          metaPath: artifacts.data.metaPath,
          statePath: artifacts.data.statePath,
          launchPath: artifacts.data.launchPath,
          controllerPath: artifacts.data.controllerPath,
          stdoutPath: artifacts.data.stdoutPath,
          stderrPath: artifacts.data.stderrPath,
          startedAt: stateInfo.startedAt,
          heartbeatAt: stateInfo.heartbeatAt,
          completedAt: (meta.completed_at as string) ?? null,
          pid: stateInfo.pid,
          pgid: stateInfo.pgid,
        });
      }

      if (typeof meta.status === 'string') {
        // Non-terminal v1 status (launching/running): same dead-run check as
        // the v2 branch above, reading liveness off state.json (meta.json
        // only carries status/completed_at, not heartbeat/pid).
        const artifacts = await readRunArtifacts(runDir, { includeMeta: true });
        if (artifacts.ok) {
          const stateInfo = extractFromState(artifacts.data.state);
          if (isRunDead(stateInfo.heartbeatAt, stateInfo.pid, stateInfo.pgid)) {
            console.error(deadRunMessage(artifacts.data.runId, stateInfo.pid));
            return ok({
              reviewId: artifacts.data.reviewId,
              runId: artifacts.data.runId,
              handoffId: artifacts.data.handoffId,
              agent: artifacts.data.agent,
              mode: artifacts.data.mode,
              status: 'failed',
              runDir: artifacts.data.runDir,
              responsePath: artifacts.data.responsePath,
              metaPath: artifacts.data.metaPath,
              statePath: artifacts.data.statePath,
              launchPath: artifacts.data.launchPath,
              controllerPath: artifacts.data.controllerPath,
              stdoutPath: artifacts.data.stdoutPath,
              stderrPath: artifacts.data.stderrPath,
              startedAt: stateInfo.startedAt,
              heartbeatAt: stateInfo.heartbeatAt,
              completedAt: null,
              pid: stateInfo.pid,
              pgid: stateInfo.pgid,
            });
          }
        }
      }
    } catch {
      // meta.json doesn't exist yet, keep polling
    }

    await sleep(pollIntervalMs);
  }

  // Timeout reached: return current state (terminal or not). v2 first, same
  // as the poll loop above, then the unchanged v1 fallback.
  const v2Timeout = await tryBuildV2Result(runDir, repoRoot);
  if (v2Timeout) {
    return ok(v2Timeout);
  }

  const artifacts = await readRunArtifacts(runDir, { includeMeta: true });
  if (!artifacts.ok) return artifacts;
  const stateInfo = extractFromState(artifacts.data.state);
  const isTerminal = TERMINAL_STATUSES.has(artifacts.data.status);
  const completedAt = isTerminal
    ? ((artifacts.data.meta as Record<string, unknown> | null)?.completed_at as string) ?? null
    : null;

  return ok({
    reviewId: artifacts.data.reviewId,
    runId: artifacts.data.runId,
    handoffId: artifacts.data.handoffId,
    agent: artifacts.data.agent,
    mode: artifacts.data.mode,
    status: artifacts.data.status,
    runDir: artifacts.data.runDir,
    responsePath: artifacts.data.responsePath,
    metaPath: artifacts.data.metaPath,
    statePath: artifacts.data.statePath,
    launchPath: artifacts.data.launchPath,
    controllerPath: artifacts.data.controllerPath,
    stdoutPath: artifacts.data.stdoutPath,
    stderrPath: artifacts.data.stderrPath,
    startedAt: stateInfo.startedAt,
    heartbeatAt: stateInfo.heartbeatAt,
    completedAt,
    pid: stateInfo.pid,
    pgid: stateInfo.pgid,
  });
}

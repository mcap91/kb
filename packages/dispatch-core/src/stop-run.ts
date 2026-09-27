import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { resolveRun } from './lookup.js';
import { isRecordedProcessAlive, writeJsonAtomic, writeStateMetadata } from './run-state.js';

/**
 * Input shape for {@link stopRun}, exported for symmetry with dispatch-core's other
 * `<Verb>Opts`/`<Verb>Result` pairs (e.g. `MergeDeliveryOpts`). `stopRun` itself takes
 * `dir`/`runId` as positional args, not this object — kept as a documented type only.
 */
export interface StopRunOpts {
  dir: string;
  runId: string;
}

export interface StopRunResult {
  runId: string;
  handoffId: string;
  /** True when the run was already in a terminal status — no signal was sent, state untouched. */
  alreadyTerminal: boolean;
  /** The run's status as found before this call. */
  previousStatus: string;
  /** Set when the recorded process was already dead, or the run was already terminal. */
  note?: string;
}

/**
 * True for every non-active status across both run-state layouts this repo writes:
 * v1 (`completed|failed|timed_out|cancelled|rejected`, `run-state.ts`'s `TerminalRunStatus`)
 * and v2 (`delivered|failed|refused|timed_out|cancelled`, `dispatch-controller-entry.ts`'s
 * `V2RunStatus`). Mirrors `status.ts`'s `isTerminalRunStatus`: anything that isn't
 * `launching`/`running` is terminal, rather than hand-listing both unions (which would
 * silently miss v2's `delivered`/`refused`).
 */
function isTerminalStatus(status: string): boolean {
  return status !== 'launching' && status !== 'running';
}

function isEsrch(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ESRCH';
}

async function tryReadJsonRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Kill a running dispatch by run id and mark its state cancelled (WK-0144).
 *
 * Locates the run via `resolveRun` (the same v1/v2 dual-layout scan `status`/`lookup` already
 * use — reused here rather than re-walking `.agent-runs/runs/` a third time), then re-reads
 * its `state.json` directly for the raw `pid`/`pgid` fields, which `ResolvedRun` doesn't carry.
 *
 * v1 run dirs keep `metadata/state.json` (schema_version 1); v2 run dirs keep ONE `state.json`
 * at the run root (schema_version 2, plus fields like `handoff_id`/`model`/`outcome`/
 * `delivery_status`/`branch`/`error`). The write-back preserves whichever shape it found —
 * blindly writing v1's fixed shape over a v2 run's `state.json` would downgrade it to
 * `schema_version: 1` and drop those fields, which `status()`/`cleanup()`/`wait()` all key off
 * `schema_version === 2` to read correctly.
 *
 * Already-terminal runs and already-dead recorded processes (ESRCH) are both a no-op success,
 * not an error — the goal ("this run is not running") is already achieved in both cases.
 */
export async function stopRun(dir: string, runId: string): Promise<DispatchResult<StopRunResult>> {
  const resolved = await resolveRun({ dir, runId });
  if (!resolved.ok) {
    return resolved;
  }

  const { runId: resolvedRunId, runDir, handoffId } = resolved.data;

  const v2Path = join(runDir, 'state.json');
  const v1Path = join(runDir, 'metadata', 'state.json');

  const v2State = await tryReadJsonRecord(v2Path);
  const isV2 = v2State !== null && v2State.schema_version === 2;
  const state = isV2 ? v2State : await tryReadJsonRecord(v1Path);

  if (!state) {
    return fail('LOOKUP_FAILED', `Run ${resolvedRunId} resolved to ${runDir} but no state.json was readable there.`);
  }

  const previousStatus = typeof state.status === 'string' ? state.status : 'unknown';

  if (isTerminalStatus(previousStatus)) {
    return ok({
      runId: resolvedRunId,
      handoffId,
      alreadyTerminal: true,
      previousStatus,
      note: `Run ${resolvedRunId} is already terminal (${previousStatus}); no signal sent.`,
    });
  }

  const pid = typeof state.pid === 'number' ? state.pid : 0;
  const pgid = typeof state.pgid === 'number' ? state.pgid : pid;
  const startedAt = typeof state.started_at === 'string' ? state.started_at : new Date().toISOString();

  const alive = pid > 0 && isRecordedProcessAlive(pid, pgid);
  let note: string | undefined;

  if (alive) {
    // Prefer the process-group form (kills the controller and every descendant it never
    // detached from — bwrap worker, forwarder) — same target selection as
    // `isRecordedProcessAlive`/`signalChildProcessGroup`. Never signal group 0 (pgid<=0
    // would negate to a no-op or, at pgid===0, the caller's OWN group) — fall back to the
    // plain pid in that case.
    const target = process.platform !== 'win32' && pgid > 0 ? -pgid : pid;
    try {
      process.kill(target, 'SIGTERM');
    } catch (err) {
      if (isEsrch(err)) {
        note = `Process group ${pgid} (pid ${pid}) was already gone when signaled.`;
      } else {
        return fail('LOOKUP_FAILED', `Failed to signal run ${resolvedRunId} (pid ${pid}, pgid ${pgid}).`, err);
      }
    }
  } else {
    note = `Run ${resolvedRunId} process (pid ${pid}, pgid ${pgid}) was already dead; state marked cancelled.`;
  }

  const now = new Date().toISOString();
  try {
    if (isV2) {
      await writeJsonAtomic(v2Path, {
        ...state,
        status: 'cancelled',
        heartbeat_at: now,
        completed_at: now,
      });
    } else {
      await writeStateMetadata(join(runDir, 'metadata'), {
        runId: resolvedRunId,
        status: 'cancelled',
        pid,
        pgid,
        startedAt,
        heartbeatAt: now,
      });
    }
  } catch (err) {
    return fail('LOOKUP_FAILED', `Signaled run ${resolvedRunId} but failed to write cancelled state.`, err);
  }

  return ok({
    runId: resolvedRunId,
    handoffId,
    alreadyTerminal: false,
    previousStatus,
    ...(note ? { note } : {}),
  });
}

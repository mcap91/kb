import type { ChildProcess } from 'node:child_process';
import { mkdir, open, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Shared run-state machinery (v1/v2 seam — PLN-0004 S1 Wave 1).
 *
 * Extracted verbatim from `launch.ts`/`status.ts` where these were duplicated or inlined. Pure
 * carve: no behavior changes. v1 keeps calling these through the re-exports in `launch.ts`/
 * `status.ts`'s imports; v2 imports them directly for the new pipeline.
 */

/**
 * Write `content` to `targetPath` atomically: write to a uniquely-named temp file in the same
 * directory, fsync it, then rename over the target. Prevents readers (e.g. `status`/`wait`
 * polling while `launch` is mid-write) from ever observing a partially-written file.
 */
export async function writeAtomic(targetPath: string, content: string): Promise<void> {
  const dirPath = dirname(targetPath);
  await mkdir(dirPath, { recursive: true });
  const tempPath = join(
    dirPath,
    `.tmp-${basename(targetPath)}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, targetPath);
}

/** JSON-serialize `value` and write it via {@link writeAtomic}. */
export async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await writeAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

export type TerminalRunStatus = 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'rejected';

/** Write `metadata/state.json` — the live run-state document polled by `status`/`wait`. */
export async function writeStateMetadata(
  metadataDir: string,
  data: {
    runId: string;
    status: 'launching' | 'running' | TerminalRunStatus;
    pid: number;
    pgid: number;
    startedAt: string;
    heartbeatAt: string;
  },
): Promise<void> {
  await writeJsonAtomic(
    join(metadataDir, 'state.json'),
    {
      schema_version: 1,
      run_id: data.runId,
      status: data.status,
      pid: data.pid,
      pgid: data.pgid,
      started_at: data.startedAt,
      heartbeat_at: data.heartbeatAt,
    },
  );
}

/** Liveness probe for a single pid via a zero-signal `kill`. ESRCH => dead; anything else => alive. */
export function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

/**
 * Liveness probe for a recorded (pid, pgid) pair. On POSIX, prefers signaling the process group
 * (`-pgid`) so a still-alive descendant counts even if the recorded leader pid has been reaped;
 * falls back to the plain pid check (and always uses the plain check on win32, which has no
 * process-group signaling).
 */
export function isRecordedProcessAlive(pid: number, pgid: number): boolean {
  if (process.platform !== 'win32' && pgid > 0) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH')) {
        return true;
      }
    }
  }

  return pid > 0 ? isAlive(pid) : false;
}

/**
 * Send `signal` to a child's process group on POSIX (falling back to the plain pid if the group
 * signal fails for a reason other than "no such process"), or to the plain pid on win32. Best
 * effort throughout — termination signaling must never throw into the launch/cancel path.
 */
export function signalChildProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH')) {
        try {
          process.kill(child.pid, signal);
        } catch {
          // best effort
        }
        return;
      }
    }
  }

  try {
    process.kill(child.pid, signal);
  } catch {
    // best effort
  }
}

/** v1's heartbeat cadence for `state.json` refresh. Unchanged value — do not retune here. */
export const HEARTBEAT_INTERVAL_MS = 1000;

export interface HeartbeatHandle {
  stop(): void;
}

/**
 * Start a heartbeat timer that refreshes `state.json`'s `heartbeat_at` while `child` remains
 * alive, stopping automatically once `isTerminal()` reports true. Timer lifecycle only — this is
 * a re-wrap of the inline closure in `launch.ts`'s `launch()`, carved out for v2 reuse; it does
 * NOT replace that inline (rewriting v1's live heartbeat path is out of scope for this extraction).
 * Event emission is the caller's responsibility via `onHeartbeat`.
 */
export function startHeartbeat(
  metadataDir: string,
  runId: string,
  pid: number,
  startedAt: string,
  child: ChildProcess,
  isTerminal: () => boolean,
  onHeartbeat?: (heartbeatAt: string) => void,
): HeartbeatHandle {
  const timer = setInterval(async () => {
    if (!child.pid || isTerminal()) {
      return;
    }
    if (isRecordedProcessAlive(pid, pid)) {
      const heartbeatAt = new Date().toISOString();
      await writeStateMetadata(metadataDir, {
        runId,
        status: 'running',
        pid,
        pgid: pid,
        startedAt,
        heartbeatAt,
      });
      onHeartbeat?.(heartbeatAt);
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

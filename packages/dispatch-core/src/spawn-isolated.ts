/**
 * Direct bwrap spawn wrapper (D6; PLN-0004
 * `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md` ruling 7,
 * components 5-8). Mirrors agent-chassis's `spawnIsolated`
 * (`launch-isolation-spawn.mjs:250-255`: `spawn(resolved, plan.bwrapArgs,
 * { stdio, env, detached, signal })`) plus its two-clock timeout and bounded
 * capture (`workspace-agent-launch-core.mjs`). ELv2 — design mirrored only;
 * this TypeScript is written from scratch, no chassis source copied.
 *
 * Replaces `execViaWsl2` (wsl2.ts) for the native-Linux transport: no script
 * file, no wsl.exe, no shell — `spawn('bwrap', plan.bwrapArgs, ...)` directly
 * against the frozen `BwrapPlan` (jail.ts's `buildBwrapPlan`). Result
 * convention mirrors wsl2.ts's `execViaWsl2`: always `ok(...)` for a bwrap
 * process that actually ran to completion, whatever its exit code — callers
 * decide what a given exit/signal means. Only a failure to spawn bwrap at
 * all (missing binary, OS-level spawn error, abort before start) is a
 * `DispatchResult` failure.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

import type { BwrapPlan } from './jail.js';
import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';

// chassis: workspace-agent-launch-core.mjs:159 (DEFAULT_MAX_CAPTURE_BYTES, 1 MiB).
const DEFAULT_MAX_CAPTURE_BYTES = 1_048_576;
// chassis: workspace-agent-launch-core.mjs:161 (DEFAULT_MAX_STDERR_DETAIL_BYTES, 4 KiB).
const DEFAULT_MAX_STDERR_BYTES = 4_096;
// chassis: workspace-agent-launch-core.mjs:163 (DEFAULT_STREAM_DRAIN_TIMEOUT_MS).
const DEFAULT_STREAM_DRAIN_MS = 2_000;
// kb's own default (chassis leaves killTimeoutMs null/caller-set) — 30 min worker budget.
const DEFAULT_TIMEOUT_MS = 1_800_000;
// fd 0-2 are the child's own stdio; injected files start at fd 3 (jail.ts's buildBwrapPlan numbers them the same way).
const INJECTED_FILE_BASE_FD = 3;

export interface SpawnIsolatedOpts {
  /** Kill timer — SIGTERM the child after this many ms (chassis: workspace-agent-launch-core.mjs:638-658). Default 1_800_000 (30 min). 0 disables. */
  timeoutMs?: number;
  /** Stream-drain grace period after exit, before force-closing lingering stdout/stderr (chassis's SECOND clock — armStreamDrainTimer inside recordExit, workspace-agent-launch-core.mjs:478-560/522-541). Default 2_000. */
  streamDrainMs?: number;
  /** Bound on retained stdout bytes (head-capped: stop retaining past the cap, keep counting so `truncated` is accurate). Default 1_048_576 (1 MiB). */
  maxCaptureBytes?: number;
  /** When set, every stdout chunk is also streamed unbounded to this file as it arrives — the run's PRIMARY capture (the bounded in-memory `stdout` above is the FALLBACK), so long/compaction-heavy runs don't lose tail events like agent_end past the 1 MiB head cap. */
  stdoutLogPath?: string;
  /** Bound on retained stderr bytes (tail-capped: keeps the MOST RECENT bytes — the diagnostically useful end of a crash, not the start). Default 4_096 (4 KiB). */
  maxStderrBytes?: number;
  signal?: AbortSignal;
  /**
   * Ad-hoc content check for bwrap `--file` injection. The AUTHORITATIVE
   * source is `plan.injectedFiles` — `buildBwrapPlan` already baked the
   * matching `--file <fd> <dest>` tokens into `plan.bwrapArgs`, so this
   * wrapper wires pipes from the plan, not from here. If provided, it must
   * match `plan.injectedFiles` exactly (same dest, same order): a caller
   * that thinks it's injecting something the plan doesn't already encode is
   * a bug, not a runtime condition to silently paper over.
   */
  injectedFiles?: ReadonlyArray<{ content: string; dest: string }>;
}

export interface SpawnResult {
  stdout: string;
  /** Echoes `opts.stdoutLogPath` when set — the file holds the full unbounded stdout capture; `stdout` above may be head-truncated. */
  stdoutLogPath?: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  timedOut: boolean;
  streamDrainTimedOut: boolean;
}

/** Bounded streaming accumulator — HEAD-capped: stop retaining once `cap` bytes are collected; `truncated` flags that more arrived. Mirrors chassis's createBoundedCapture (workspace-agent-launch-core.mjs:334-378), used there for both stdout and stderr. */
function boundedHeadCapture(cap: number) {
  const chunks: string[] = [];
  let retained = 0;
  let truncated = false;
  return {
    push(chunk: Buffer | string): void {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (str.length === 0) return;
      if (retained >= cap) {
        truncated = true;
        return;
      }
      chunks.push(str);
      retained += Buffer.byteLength(str, 'utf8');
      if (retained >= cap) truncated = true;
    },
    text: (): string => chunks.join(''),
    get truncated(): boolean {
      return truncated;
    },
  };
}

/**
 * Bounded streaming accumulator — TAIL-capped: keeps the most recently
 * pushed `cap` bytes, dropping whole chunks from the front as new data
 * arrives. kb collapses chassis's two-stage stderr handling (full 1 MiB
 * capture + a separate 4 KiB tail slice via buildBoundedStderrDetail,
 * workspace-agent-launch-core.mjs:380-408, tail slicing at :393-397) into
 * one rolling buffer, since kb's `SpawnResult` surfaces a single bounded
 * `stderr` string rather than chassis's full-capture/detail-tail pair. Tail,
 * not head, because the useful part of a crash is usually at the end — a
 * deliberate divergence from `boundedHeadCapture`, flagged here rather than
 * blended in silently (kb standing rule: surface conflicting patterns,
 * don't average them).
 */
function boundedTailCapture(cap: number) {
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk: Buffer | string): void {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (str.length === 0) return;
      chunks.push(str);
      bytes += Buffer.byteLength(str, 'utf8');
      while (bytes > cap && chunks.length > 1) {
        truncated = true;
        const dropped = chunks.shift();
        if (dropped !== undefined) bytes -= Buffer.byteLength(dropped, 'utf8');
      }
      if (bytes > cap) truncated = true;
    },
    text: (): string => chunks.join(''),
    get truncated(): boolean {
      return truncated;
    },
  };
}

/**
 * Spawn a frozen `BwrapPlan` directly (no script, no shell) and collect its
 * output under bounded capture and a two-clock timeout. Never throws — spawn
 * failures (bwrap missing, OS-level spawn error, pre-start abort) return
 * `fail('BWRAP_SPAWN_FAILED', ...)`; everything else (any exit code, any
 * signal, a timeout) is a completed run and returns `ok(...)` — callers
 * interpret `exitCode`/`signal` themselves (chassis's
 * `deriveTerminalStatus`: `code === 0 && !signal` → succeeded,
 * `workspace-agent-launch-adapter-contract.mjs:896-899` — native Linux's
 * `.signal` field is authoritative, no `classifySignalExit`-style guessing
 * needed here).
 */
export async function spawnIsolated(
  plan: BwrapPlan,
  opts: SpawnIsolatedOpts = {},
): Promise<DispatchResult<SpawnResult>> {
  if (opts.injectedFiles !== undefined) {
    const expected = plan.injectedFiles;
    const mismatch =
      opts.injectedFiles.length !== expected.length ||
      opts.injectedFiles.some((f, i) => f.dest !== expected[i]?.dest);
    if (mismatch) {
      return fail(
        'BWRAP_SPAWN_FAILED',
        'spawnIsolated opts.injectedFiles does not match plan.injectedFiles (dest + order) — rebuild the plan with jail.ts\'s buildBwrapPlan instead of overriding injected files at spawn time.',
        { optsInjectedFiles: opts.injectedFiles, planInjectedFiles: expected },
      );
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const streamDrainMs = opts.streamDrainMs ?? DEFAULT_STREAM_DRAIN_MS;
  const maxCaptureBytes = opts.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const maxStderrBytes = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

  // stdio index === fd number in the child. fd 0 ignored (workers never read
  // stdin here), 1/2 piped for capture, then one 'pipe' per injected file at
  // fd 3, 4, 5, ... matching the fds buildBwrapPlan already baked into
  // plan.bwrapArgs's `--file <fd> <dest>` tokens.
  const stdio: Array<'ignore' | 'pipe'> = ['ignore', 'pipe', 'pipe'];
  for (let i = 0; i < plan.injectedFiles.length; i += 1) stdio.push('pipe');

  // kb's own precedent (wsl2.ts's execViaWsl2: `{ ...process.env, ...opts.env }`),
  // not chassis's `--clearenv` + `--setenv` policy — env allow/deny-listing
  // (D6 component 9) is separate future work; jail.ts's mount recipe is
  // unchanged and still relies on bwrap's default env passthrough.
  const env = { ...process.env, ...plan.env } as Record<string, string>;

  let child;
  try {
    child = spawn('bwrap', [...plan.bwrapArgs], {
      stdio,
      env,
      detached: true,
      signal: opts.signal,
    });
  } catch (err) {
    return fail(
      'BWRAP_SPAWN_FAILED',
      `bwrap failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  // Feed each injected file's content to its matching pipe and close it —
  // bwrap's --file reads until EOF (captured behavior, jail.ts's
  // BwrapInjectedFile doc). child.stdio[n]'s declared type is a Readable |
  // Writable union (Node can't know direction for fds beyond 2); it's
  // actually a net.Socket here (writable from the parent) because every
  // extra slot above was requested as 'pipe' — verified directly against a
  // real spawn (2026-09-16, DEC-0009 capture-before-code).
  for (let i = 0; i < plan.injectedFiles.length; i += 1) {
    const injected = plan.injectedFiles[i];
    const pipe = child.stdio[INJECTED_FILE_BASE_FD + i] as NodeJS.WritableStream | null | undefined;
    if (!pipe || injected === undefined) {
      return fail(
        'BWRAP_SPAWN_FAILED',
        `bwrap spawned without the expected fd ${INJECTED_FILE_BASE_FD + i} pipe for injected file ${String(injected?.dest)}.`,
        { index: i },
      );
    }
    pipe.on('error', () => { /* swallow — child died mid-inject; exit path handles it */ });
    pipe.end(injected.content, 'utf8');
  }

  const stdoutCapture = boundedHeadCapture(maxCaptureBytes);
  const stderrCapture = boundedTailCapture(maxStderrBytes);
  const stdoutLogStream = opts.stdoutLogPath !== undefined ? createWriteStream(opts.stdoutLogPath) : null;
  // WriteStream 'error' is otherwise uncaught-exception fatal — a full disk or
  // permissions problem writing the log must not take down an in-flight run.
  stdoutLogStream?.on('error', (err) => {
    process.stderr.write(`[spawn-isolated] warning: failed to write ${opts.stdoutLogPath}: ${err.message}\n`);
  });
  child.stdout?.on('error', () => { /* swallow — exit/close path handles cleanup */ });
  child.stderr?.on('error', () => { /* swallow — exit/close path handles cleanup */ });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutCapture.push(chunk);
    stdoutLogStream?.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => stderrCapture.push(chunk));
  child.stdout?.once('close', () => stdoutLogStream?.end());

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let streamDrainTimedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let drainTimer: NodeJS.Timeout | null = null;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let pendingStreams = 2; // stdout + stderr

    const clearKillTimer = (): void => {
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };
    const clearDrainTimer = (): void => {
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearKillTimer();
      clearDrainTimer();
      resolve(
        ok({
          stdout: stdoutCapture.text(),
          stdoutLogPath: opts.stdoutLogPath,
          stderr: stderrCapture.text(),
          exitCode: exitInfo?.code ?? null,
          signal: exitInfo?.signal ?? null,
          truncated: stdoutCapture.truncated || stderrCapture.truncated,
          timedOut,
          streamDrainTimedOut,
        }),
      );
    };

    // Second clock: armed once the child has exited, gives open stdout/
    // stderr streams streamDrainMs to close naturally (e.g. a grandchild
    // still holding the pipe open) before forcing the issue. Chassis:
    // armStreamDrainTimer inside recordExit (workspace-agent-launch-core.mjs
    // :478-560, timer body at :522-541).
    const armDrainTimer = (): void => {
      if (drainTimer !== null || pendingStreams <= 0 || streamDrainMs <= 0) return;
      drainTimer = setTimeout(() => {
        drainTimer = null;
        streamDrainTimedOut = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, streamDrainMs);
      drainTimer.unref?.();
    };

    const onStreamClose = (): void => {
      pendingStreams -= 1;
      if (pendingStreams <= 0) {
        clearDrainTimer();
        if (exitInfo !== null) finish();
      }
    };
    child.stdout?.once('close', onStreamClose);
    child.stderr?.once('close', onStreamClose);

    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      clearKillTimer();
      if (pendingStreams <= 0) finish();
      else armDrainTimer();
    });

    child.once('error', (err) => {
      // Spawn never got the process running at all (e.g. ENOENT — bwrap
      // missing from PATH — or an abort before start). Distinct from a
      // process that ran and exited badly, which is still an `ok(...)`
      // result above (wsl2.ts's own convention: only "never ran" is a
      // DispatchResult failure).
      clearKillTimer();
      clearDrainTimer();
      if (settled) return;
      settled = true;
      resolve(fail('BWRAP_SPAWN_FAILED', `bwrap process error: ${err.message}`, { message: err.message }));
    });

    // First clock: kill timer (chassis: workspace-agent-launch-core.mjs
    // :638-658). On fire, this is a HARD timeout bound — send SIGTERM and
    // resolve immediately rather than also waiting out streamDrainMs on top
    // (mirrors chassis's kill-timer, which synthesizes a terminal result
    // in the same callback instead of waiting for the real exit event).
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        killTimer = null;
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // already dead
        }
        exitInfo = exitInfo ?? { code: null, signal: null };
        clearDrainTimer();
        finish();
      }, timeoutMs);
      killTimer.unref?.();
    }
  });
}

/**
 * Launches a command, capturing its stdout/stderr to files under a run
 * capture dir and enforcing a host wall-clock timeout (WK-0237 scope 15.2:
 * a run that times out is killed and recorded as invalid, never scored).
 *
 * Takes its command argv as plain input rather than building a `claude -p`
 * invocation itself, so tests can drive it with `node -e '...'` instead of a
 * real `claude`/`bwrap` call (constraint: no real claude/bwrap calls in
 * tests). `cli.ts`'s `--capture` handler is the caller that supplies the
 * real `['bwrap', ...jailArgs, <cli binary>, ...claudeArgv]` command.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fail, ok, type EvalResult } from './result.js';

/** 15 minutes (scope 15.2's host wall-clock bound). */
export const DEFAULT_TIMEOUT_MS = 900_000;
/** Grace period after SIGTERM before escalating to SIGKILL. */
const KILL_ESCALATION_MS = 2_000;

export interface LaunchOpts {
  /** Full command argv, binary first (e.g. `['bwrap', ...jailArgs, '/tools/claude-code/bin/claude.exe', ...claudeArgv]`). */
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Default 900_000 (15 min, scope 15.2). 0 disables. */
  timeoutMs?: number;
  /** Directory to write stream.jsonl, stderr.log, run.json into. Must already exist. */
  captureDir: string;
  /** Extra fields merged into run.json alongside the launch result (e.g. baselineSha, cliVersion). */
  metadata?: Record<string, unknown>;
}

export interface LaunchResult {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  wallTimeMs: number;
}

/**
 * Spawns `opts.command` with stdin wired to /dev/null (Node's `'ignore'`
 * stdio redirects to /dev/null on POSIX), stdout streamed to
 * `<captureDir>/stream.jsonl`, stderr to `<captureDir>/stderr.log`. On
 * timeout, SIGTERMs the whole process group (the child is spawned detached
 * so its pid is also its pgid), escalating to SIGKILL if it has not exited
 * after a short grace period. Always writes `<captureDir>/run.json`. Never
 * throws — a failure to spawn at all is the only `EvalResult` failure;
 * everything else (any exit code, any signal, a timeout) is a completed
 * launch.
 */
export async function launch(opts: LaunchOpts): Promise<EvalResult<LaunchResult>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [bin, ...args] = opts.command;
  if (bin === undefined) {
    return fail('LAUNCH_FAILED', 'launch() called with an empty command array.');
  }

  const stdoutPath = join(opts.captureDir, 'stream.jsonl');
  const stderrPath = join(opts.captureDir, 'stderr.log');
  const runJsonPath = join(opts.captureDir, 'run.json');

  const stdoutStream = createWriteStream(stdoutPath);
  const stderrStream = createWriteStream(stderrPath);

  let child;
  const start = Date.now();
  try {
    child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    stdoutStream.close();
    stderrStream.close();
    return fail('LAUNCH_FAILED', `failed to spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`);
  }

  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let escalationTimer: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (escalationTimer !== null) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      stdoutStream.end();
      stderrStream.end();

      const result: LaunchResult = {
        argv: opts.command,
        exitCode: code,
        signal,
        timedOut,
        wallTimeMs: Date.now() - start,
      };
      try {
        writeFileSync(runJsonPath, JSON.stringify({ ...result, ...opts.metadata }, null, 2));
      } catch {
        // run.json is best-effort provenance; a write failure here must not
        // mask a launch that otherwise completed successfully.
      }
      resolve(ok(result));
    };

    child.once('exit', (code, signal) => {
      finish(code, signal);
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      stdoutStream.end();
      stderrStream.end();
      resolve(fail('LAUNCH_FAILED', `process error for ${bin}: ${err.message}`));
    });

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        killTimer = null;
        timedOut = true;
        const pid = child.pid;
        if (pid !== undefined) {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            // already dead
          }
          escalationTimer = setTimeout(() => {
            escalationTimer = null;
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // already dead
            }
          }, KILL_ESCALATION_MS);
        }
      }, timeoutMs);
    }
  });
}

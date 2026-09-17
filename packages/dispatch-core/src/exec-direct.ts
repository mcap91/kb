/**
 * Direct bash execution (D6 Phase 2; PLN-0004
 * `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md` ruling 7,
 * "Layer 1: Replace execViaWsl2 transport"). Replaces `wsl2.ts`'s
 * `execViaWsl2` for the native-Linux transport: the orchestrator now runs ON
 * Linux (WSL2 itself, not a Windows host calling INTO WSL2 via `wsl.exe`), so
 * the cross-OS boundary wsl2.ts existed to cross is gone. `scriptContent` is
 * handed to bash as a single argv element
 * (`execFile('bash', ['-c', scriptContent], ...)`) — no script file is ever
 * written to disk, and no extra shell re-parses the content, so the
 * multi-level-quoting fragility wsl2.ts warned about (WK-0074 gotcha 6: "never
 * inline bash -c") does not apply here — there is only one shell in the
 * picture now, not two.
 *
 * kb's own utility, not chassis-mirrored: this replaces the transport under
 * the EXISTING, already-tested script generators (clone.ts, delivery.ts,
 * preflight.ts), which are unchanged. The chassis-mirrored direct-spawn
 * primitive for the WORKER itself is `spawn-isolated.ts`'s `spawnIsolated`
 * (Layer 2) — a different concern (jailed, bounded capture, two-clock
 * timeout) from this plain non-jailed helper.
 *
 * Same result convention as `execViaWsl2`: `ok(...)` for a script that ran to
 * completion, whatever its exit code (0 or otherwise) — callers decide what a
 * given exit code means. Only a failure to run bash AT ALL (e.g. bash missing
 * from PATH, an OS-level spawn error with no usable exit code or signal) is a
 * `DispatchResult` failure.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';

const execFileAsync = promisify(execFileCb);

// Generous vs. Node's 1 MB execFile default — mirrors wsl2.ts's own
// MAX_BUFFER_BYTES precedent; enumerate diffs and delivery changed-file lists
// can still be sizable.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface ExecBashOpts {
  /** Bash script content, run via `bash -c <scriptContent>` — never written to disk. */
  scriptContent: string;
  /** Working directory for the spawned process. Defaults to the current process's cwd. */
  cwd?: string;
  /** Environment variables merged over `process.env` (mirrors execViaWsl2's own `{ ...process.env, ...opts.env }` precedent). */
  env?: Record<string, string>;
  /** Timeout in ms (0 or undefined = no timeout). */
  timeoutMs?: number;
}

export interface ExecBashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ExecFileFailure {
  code?: number | string;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

/**
 * Conventional 128+N shell exit code for a signal-terminated child (the same
 * convention `timeout(1)`/most shells use) — applied only when Node reports a
 * signal but no numeric `.code` (e.g. Node's own `timeout` option killing the
 * child). No caller of this module branches on a SPECIFIC signal value, only
 * "zero vs nonzero", so collapsing to a conventional nonzero code is enough.
 */
const SIGNAL_TO_NUMBER: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * Run a bash script directly (`bash -c <scriptContent>`) and collect its
 * output. Never throws — a script that ran to completion (any exit code) is
 * `ok(...)`; only a failure to run bash at all is `fail('EXEC_FAILED', ...)`.
 */
export async function execBash(opts: ExecBashOpts): Promise<DispatchResult<ExecBashResult>> {
  const env = { ...process.env, ...opts.env } as Record<string, string>;

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', opts.scriptContent], {
      cwd: opts.cwd,
      env,
      timeout: opts.timeoutMs ?? 0,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return ok({ exitCode: 0, stdout, stderr });
  } catch (err) {
    const e = err as ExecFileFailure;

    if (typeof e.code !== 'number' && !e.signal) {
      // No usable exit-code/signal information at all — bash itself never ran.
      return fail('EXEC_FAILED', 'Failed to execute bash -c script.', err);
    }

    const exitCode = typeof e.code === 'number' ? e.code : (SIGNAL_TO_NUMBER[e.signal as string] ?? 1);
    return ok({ exitCode, stdout: e.stdout ?? '', stderr: e.stderr ?? '' });
  }
}

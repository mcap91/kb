/**
 * Windows→WSL2 routing (spec §11; WK-0074 gotchas 1-7; T16 S0 minimum).
 *
 * S0 minimum: spawn `wsl.exe` against a STAGED SCRIPT FILE, never inline `bash -c`
 * (WK-0074 Revision-2 gotcha 6: multi-level quoting through wsl.exe → bash -c →
 * command is fragile, and `BASH_SOURCE` is empty in `-c` mode, breaking scripts that
 * derive their own path from it). `MSYS_NO_PATHCONV=1` is mandatory (gotcha 1: Git
 * Bash mangles `/mnt/c/...` arguments otherwise, prepending the Git install dir —
 * `C:/Program Files/Git/mnt/c/...`). Non-interactive `wsl.exe -d Ubuntu -- bash
 * <script>` shells never source `.bashrc`/`.profile`, so every env var a script needs
 * must be passed explicitly on the spawned process's environment rather than assumed
 * inherited. Exit codes from `wsl.exe` on a signal death are the RAW signal number
 * (9 = SIGKILL, 15 = SIGTERM), NOT the shell 128+N convention (WK-0074 probe 2, 8/8
 * verified) — callers must check both conventions; this module surfaces the raw code
 * plus a `killedBySignal` fact so they don't have to re-derive the mapping.
 *
 * S5 layers real tier resolution / enforcement provenance on top of this; this module
 * only knows how to get a script running inside WSL2 and report back what happened.
 */
import { execFile as execFileCb } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';

const execFileAsync = promisify(execFileCb);

export interface Wsl2ScriptOpts {
  /** Absolute Windows path to the run dir where script files are staged. */
  runDir: string;
  /** Script content (bash) to write and execute. */
  scriptContent: string;
  /** Script filename (e.g. 'clone.sh', 'run-pi.sh'). */
  scriptName: string;
  /** Environment variables to pass explicitly into the script. */
  env?: Record<string, string>;
  /** Timeout in ms (0 = no timeout). */
  timeoutMs?: number;
}

export interface Wsl2ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if exit code matches a known signal (9=SIGKILL, 15=SIGTERM). */
  killedBySignal: boolean;
  signal?: number;
}

// New v2 error code produced by this module; will be merged into the shared
// DispatchErrorCode union in errors.ts at wave-3 integration. errors.ts is not
// modified by this file (wave-2 constraint).
type Wsl2ErrorCode = 'WSL2_EXEC_FAILED';

function fail<T = never>(message: string, detail?: unknown): DispatchResult<T> {
  return { ok: false, error: 'WSL2_EXEC_FAILED' as Wsl2ErrorCode, message, detail } as unknown as DispatchResult<T>;
}

// Generous vs. Node's 1 MB execFile default — WK-0074 B2 round-tripped ~1 MB of
// prompt over this exact boundary; HO prompts travel over stdin (not this path) but
// worker stdout/diffs can still be sizable.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Raw wsl.exe exit codes that mean "the process died to a signal", per WK-0074
 * probe 2 (all 8 exit-code/signal cases verified): wsl.exe propagates signal death
 * as the bare signal number, never the shell's 128+N convention.
 */
const SIGNAL_EXIT_CODES: ReadonlySet<number> = new Set([9, 15]);

/**
 * Classify a raw wsl.exe exit code against the known-signal set. Exported as a pure
 * function so the WK-0074-probed mapping is unit-testable without an actual WSL2 host.
 */
export function classifySignalExit(exitCode: number): { killedBySignal: boolean; signal?: number } {
  if (SIGNAL_EXIT_CODES.has(exitCode)) {
    return { killedBySignal: true, signal: exitCode };
  }
  return { killedBySignal: false };
}

// Fallback for the (rare) case where Node itself kills the wsl.exe child directly
// (e.g. our own `timeoutMs` elapsed) and reports `.signal` instead of a numeric
// `.code`. Only the signals plausibly relevant here are mapped; anything else falls
// back to a generic non-zero code rather than guessing.
const NODE_SIGNAL_TO_NUMBER: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

interface ExecFileFailure {
  code?: number | string;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

/**
 * Convert an absolute Windows path to its WSL2 `/mnt/<drive>/...` equivalent.
 * `C:\Users\foo\bar` → `/mnt/c/Users/foo/bar`. The drive letter is lowercased (the
 * `/mnt` mount convention) and backslashes become forward slashes. Paths that are
 * not drive-rooted (already POSIX-shaped, or relative) only get separator
 * normalization — this function does not resolve or validate the path.
 */
export function windowsToWslPath(winPath: string): string {
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!driveMatch) {
    return winPath.replace(/\\/g, '/');
  }
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

/**
 * Script snippet that resolves the Windows host IP from inside WSL2 — the default
 * gateway, NOT the resolv.conf nameserver (execution/s0-rulings.md ruling 4: the
 * WK-0073 2b-proven Ollama topology; requires `OLLAMA_HOST=0.0.0.0` on the Windows
 * side). Consumed by model-registry's `{{WIN_HOST}}` baseUrl template at spawn time —
 * this module only supplies the shell snippet, it does not execute it or know the
 * resolved value.
 */
export function resolveWinHostIp(): string {
  return "ip route show default | head -1 | cut -d' ' -f3";
}

/**
 * Stage a bash script into the run dir and execute it inside WSL2 via a script FILE
 * invocation (never inline `bash -c` — WK-0074 gotcha 6). `MSYS_NO_PATHCONV=1` is
 * always set on the child environment (gotcha 1). `opts.env` is passed explicitly on
 * the spawned process's environment rather than relying on any inherited shell state,
 * since the non-interactive `bash <script>` invocation never sources `.bashrc` —
 * forwarding those values from the Windows env into the WSL2 guest's own shell
 * additionally requires `WSLENV` (or the script reading them directly off its own
 * process env, which is what this function guarantees); that wiring is a call-site
 * concern (credential injection lands in S3/T10), not this primitive's job.
 *
 * Always returns `ok(...)` for a script that actually ran to completion, whatever its
 * exit code — callers decide what a given non-zero code means in their context. Only
 * a failure to write the script file, or a failure to execute `wsl.exe` at all (no
 * exit code or signal to report, e.g. `wsl.exe` missing from PATH), is surfaced as a
 * `DispatchResult` failure.
 */
export async function execViaWsl2(opts: Wsl2ScriptOpts): Promise<DispatchResult<Wsl2ExecResult>> {
  const scriptPath = join(opts.runDir, opts.scriptName);

  try {
    await writeFile(scriptPath, opts.scriptContent, 'utf-8');
  } catch (err) {
    return fail(`Failed to write WSL2 script file to ${scriptPath}.`, err);
  }

  const wslScriptPath = windowsToWslPath(scriptPath);
  const args = ['-d', 'Ubuntu', '--', 'bash', wslScriptPath];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    MSYS_NO_PATHCONV: '1',
  };
  const timeoutMs = opts.timeoutMs ?? 0;

  try {
    const { stdout, stderr } = await execFileAsync('wsl.exe', args, {
      env,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return ok({ exitCode: 0, stdout, stderr, killedBySignal: false });
  } catch (err) {
    const e = err as ExecFileFailure;

    if (typeof e.code !== 'number' && !e.signal) {
      // No usable exit-code/signal information at all — wsl.exe itself never ran
      // (e.g. ENOENT: not on PATH / WSL2 not installed on this host).
      return fail(`Failed to execute ${wslScriptPath} via wsl.exe.`, err);
    }

    const rawExitCode = typeof e.code === 'number'
      ? e.code
      : NODE_SIGNAL_TO_NUMBER[e.signal as string] ?? 1;
    const { killedBySignal, signal } = classifySignalExit(rawExitCode);

    return ok({
      exitCode: rawExitCode,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      killedBySignal,
      signal,
    });
  }
}

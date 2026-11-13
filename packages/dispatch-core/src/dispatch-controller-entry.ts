/**
 * v2 dispatch background controller (dispatch v2, PLN-0004 S1 Wave 2a).
 *
 * The v2 analog of `controller-entry.ts` (v1). Runs as a detached child
 * process spawned by `dispatch-background.ts`: receives a pre-minted run id
 * from the launcher (identity injection downward — the orchestrator mints,
 * controller and pipeline share the same dir), writes `state.json`
 * (schema_version 2) with a `running` status, starts a 120s heartbeat,
 * awaits the synchronous `runDispatch()` pipeline, then writes the terminal
 * `state.json` UNCONDITIONALLY in a `finally`.
 *
 * That unconditional terminal write is the point of this rewrite: v1's
 * `controller-entry.ts` gates its terminal write on a `metadataDir` that is
 * only set once a `run_created` event fires (see `controller-entry.ts`),
 * which is exactly the WK-0013 staleness class — a run whose terminal write
 * gets skipped leaves `state.json` stuck reporting `running` forever. Here
 * the terminal write always happens, on every exit path, including a thrown
 * pipeline error (`deriveTerminalFields` handles the thrown-pipeline path
 * explicitly).
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DispatchResult } from './errors.js';
import { runDispatch, type DispatchResult2 } from './pipeline.js';
import { parseHandoff } from './ho.js';
import { getRunDir } from './paths.js';
import { writeJsonAtomic } from './run-state.js';

/** v2 heartbeat cadence (operator ruling 2026-09-07, s1-rulings #4): 120s, not v1's 1s. */
export const V2_HEARTBEAT_INTERVAL_MS = 120_000;

/** s1-rulings ruling 5's v2 run-state status vocabulary. `blocked`/`partial` retired (DEC-0010). */
export type V2RunStatus =
  | 'running'
  | 'delivered'
  | 'failed'
  | 'refused'
  | 'timed_out'
  | 'cancelled';

/** s1-rulings ruling 5: v2 run state is ONE file, `<runDir>/state.json`, `schema_version: 2`. */
export interface V2RunState {
  schema_version: 2;
  run_id: string;
  handoff_id: string;
  model: string;
  status: V2RunStatus;
  pid: number;
  pgid: number;
  started_at: string;
  heartbeat_at: string;
  completed_at: string | null;
  outcome: string | null;
  delivery_status: string | null;
  branch: string | null;
  error: string | null;
  /** WK-0136: captured stderr tail (spawn-isolated.ts's `SpawnResult.stderr`) from a worker-exit failure. Optional — absent on `running` state and on older run bundles predating this field. */
  error_detail?: string | null;
  /** WK-0244/WK-0260: watchdog-kill diagnostics (record AC4) — the effective per-HO timeout in effect at the kill, in seconds. Present only on a watchdog-timeout terminal write; absent for every other outcome. */
  configured_limit_secs?: number;
  /** WK-0244/WK-0260: elapsed seconds between `started_at` and the kill. Present only alongside `configured_limit_secs`. */
  elapsed_secs?: number;
  /** WK-0244/WK-0260: age in seconds of the last `heartbeat_at` at the moment of the kill, before this terminal write's own `heartbeat_at` touch-up. Present only alongside `configured_limit_secs`. */
  heartbeat_age_secs?: number;
}

export interface ControllerArgv {
  dir: string;
  handoff: string;
  model: string;
  backend: string;
  runId?: string;
  effort?: string;
  preflight: boolean;
}

/** Parse controller argv. Exported for direct unit testing. */
export function parseControllerArgv(argv: string[]): ControllerArgv {
  let dir = '';
  let handoff = '';
  let model = '';
  let backend = '';
  let runId: string | undefined;
  let effort: string | undefined;
  let preflight = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir' && argv[i + 1]) {
      dir = argv[i + 1]!;
      i++;
    } else if (arg === '--handoff' && argv[i + 1]) {
      handoff = argv[i + 1]!;
      i++;
    } else if (arg === '--model' && argv[i + 1]) {
      model = argv[i + 1]!;
      i++;
    } else if (arg === '--backend' && argv[i + 1]) {
      backend = argv[i + 1]!;
      i++;
    } else if (arg === '--run-id' && argv[i + 1]) {
      runId = argv[i + 1]!;
      i++;
    } else if (arg === '--effort' && argv[i + 1]) {
      effort = argv[i + 1]!;
      i++;
    } else if (arg === '--no-preflight') {
      preflight = false;
    }
  }

  if (!dir || !handoff || !model || !backend) {
    console.error(
      'Usage: dispatch-controller-entry --dir <path> --handoff <rel-path> --model <alias> --backend <name> [--run-id <id>] [--effort <level>] [--no-preflight]',
    );
    process.exit(2);
  }

  return { dir, handoff, model, backend, runId, effort, preflight };
}

/** Build the initial `running` state.json payload. Exported for direct unit testing. */
export function buildRunningState(opts: {
  runId: string;
  handoffId: string;
  model: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}): V2RunState {
  return {
    schema_version: 2,
    run_id: opts.runId,
    handoff_id: opts.handoffId,
    model: opts.model,
    status: 'running',
    pid: opts.pid,
    pgid: opts.pid,
    started_at: opts.startedAt,
    heartbeat_at: opts.heartbeatAt,
    completed_at: null,
    outcome: null,
    delivery_status: null,
    branch: null,
    error: null,
  };
}

export interface TerminalFields {
  status: V2RunStatus;
  outcome: string | null;
  delivery_status: string | null;
  branch: string | null;
  error: string | null;
  /** WK-0136: captured stderr tail, extracted from a `fail()` detail payload shaped like `SpawnResult`. Omitted (rather than null) when no such detail was captured, so existing exact-shape assertions of the pre-WK-0136 fields stay unaffected. */
  error_detail?: string | null;
  /** WK-0244/WK-0260: record AC4's kill diagnostics — see `TerminalTiming`'s doc below. Omitted, like `error_detail`, when not applicable. */
  configured_limit_secs?: number;
  elapsed_secs?: number;
  heartbeat_age_secs?: number;
}

/**
 * Wall-clock inputs `deriveTerminalFields` needs to compute the AC4 kill
 * diagnostics — supplied by `main()` from its own in-memory `startedAt` and
 * last-written `state.heartbeat_at` (neither of which `pipeline.ts` can see;
 * WK-0244's response explains why). Optional on `deriveTerminalFields`
 * itself so every pre-existing 2-arg call site/test keeps working unchanged
 * (rule 25) — timing is only needed on the watchdog-kill path, detected via
 * `extractConfiguredLimitSecs` below.
 */
export interface TerminalTiming {
  startedAt: string;
  heartbeatAt: string;
  now: string;
}

/**
 * Extract the captured stderr tail from a `fail()` call's `detail` payload
 * (WK-0136). `detail` is `unknown` — most `DispatchErrorCode`s never attach
 * one, and the ones that do (admission/model/clone/etc.) carry shapes with no
 * `stderr` field. pipeline.ts's own `SpawnResult` (spawn-isolated.ts) is the
 * shape that does: passed as `detail` on the worker-exit `fail('PIPELINE_FAILED',
 * ...)` calls. Duck-typed rather than cast, since `detail`'s static type
 * carries no shape information. Returns null for a missing/non-matching
 * detail or an empty stderr string, so callers can treat null as "nothing to
 * report" uniformly.
 */
function extractStderrTail(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null || !('stderr' in detail)) return null;
  const { stderr } = detail as { stderr: unknown };
  return typeof stderr === 'string' && stderr.length > 0 ? stderr : null;
}

/**
 * Extract the effective watchdog limit (seconds) from a `fail()` call's
 * `detail` payload (WK-0244/WK-0260). Every watchdog-timeout `fail(
 * 'PIPELINE_FAILED', ...)` in pipeline.ts attaches `configured_limit_secs`
 * onto its detail object; no other failure does. Duck-typed like
 * `extractStderrTail` above, for the same reason — `detail` is `unknown`.
 * A non-null return is this function's way of telling `deriveTerminalFields`
 * "this is a watchdog kill", not just "there happens to be a number here".
 */
function extractConfiguredLimitSecs(detail: unknown): number | null {
  if (typeof detail !== 'object' || detail === null || !('configured_limit_secs' in detail)) return null;
  const { configured_limit_secs } = detail as { configured_limit_secs: unknown };
  return typeof configured_limit_secs === 'number' ? configured_limit_secs : null;
}

/** Whole seconds between two ISO timestamps, `later` minus `earlier`. */
function secondsBetween(earlier: string, later: string): number {
  return Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / 1000);
}

/**
 * Map a `runDispatch()` result (or a thrown pipeline error) to the terminal
 * `state.json` fields. Pure and exported for direct unit testing — this is
 * the "controller state-writing logic" the S1 Wave 2a unit tests exercise
 * without spawning a real process or running the real pipeline.
 *
 * Delivery-gate refusals (`refused_out_of_scope` / `secret_in_diff`) are DATA,
 * not errors (s1-rulings ruling 2) — the pipeline ran correctly, the WORK was
 * refused, so `error` stays null for those; `delivery_status` already carries
 * the refusal reason (and the response doc / quarantine diff carry the
 * detail). `error` is reserved for cases where the pipeline itself did not
 * complete cleanly: a thrown exception, an `ok:false` pipeline result, or a
 * delivery-script-level `conflict`/`error`.
 *
 * `outcome` mirrors the coarse `status` bucket today. `runDispatch()`'s
 * `DispatchResult2` does not surface Pi's own finer-grained worker outcome
 * (completed/failed/error) separately from the delivery outcome —
 * only the written response doc's frontmatter has that (capture.ts's
 * `deriveVerdict`). Recovering it here would mean either threading it through
 * `DispatchOpts`/`DispatchResult2` (a pipeline.ts change, out of scope for
 * this wave) or parsing the response doc back off disk. Left as a known gap
 * for a later wave; `outcome` is still always populated (never silently
 * dropped) so the field is forward-compatible once that gap closes.
 *
 * `timing` (WK-0244/WK-0260, record AC4) supplies the wall-clock inputs for
 * the kill diagnostics; it is only consulted on the watchdog-timeout path
 * (`extractConfiguredLimitSecs(result.detail)` non-null) and is otherwise
 * ignored, so omitting it is correct for every other outcome.
 */
export function deriveTerminalFields(
  result: DispatchResult<DispatchResult2> | null,
  thrown: unknown,
  timing?: TerminalTiming,
): TerminalFields {
  if (thrown !== null && thrown !== undefined) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return { status: 'failed', outcome: null, delivery_status: null, branch: null, error: message };
  }

  if (!result) {
    return {
      status: 'failed',
      outcome: null,
      delivery_status: null,
      branch: null,
      error: 'Pipeline produced no result.',
    };
  }

  if (!result.ok) {
    const terminal: TerminalFields = {
      status: 'failed',
      outcome: null,
      delivery_status: null,
      branch: null,
      error: `${result.error}: ${result.message}`,
    };
    const stderrTail = extractStderrTail(result.detail);
    if (stderrTail !== null) terminal.error_detail = stderrTail;
    const configuredLimitSecs = extractConfiguredLimitSecs(result.detail);
    if (configuredLimitSecs !== null && timing) {
      terminal.configured_limit_secs = configuredLimitSecs;
      terminal.elapsed_secs = secondsBetween(timing.startedAt, timing.now);
      terminal.heartbeat_age_secs = secondsBetween(timing.heartbeatAt, timing.now);
    }
    return terminal;
  }

  const { delivery } = result.data;
  switch (delivery.status) {
    case 'delivered':
      return {
        status: 'delivered',
        outcome: 'delivered',
        delivery_status: delivery.status,
        branch: delivery.branch,
        error: null,
      };
    case 'no_changes':
      return { status: 'delivered', outcome: 'delivered', delivery_status: delivery.status, branch: null, error: null };
    case 'no_delta':
      return { status: 'failed', outcome: 'failed', delivery_status: delivery.status, branch: null, error: null };
    case 'refused_out_of_scope':
      return { status: 'refused', outcome: 'refused', delivery_status: delivery.status, branch: null, error: null };
    case 'secret_in_diff':
      return { status: 'refused', outcome: 'refused', delivery_status: delivery.status, branch: null, error: null };
    case 'conflict':
      return {
        status: 'failed',
        outcome: 'failed',
        delivery_status: delivery.status,
        branch: null,
        error: `Delivery conflict: branch already carries a different tree from the same base (existing tree ${delivery.existingTree}, new tree ${delivery.newTree}).`,
      };
    case 'error':
      return { status: 'failed', outcome: 'failed', delivery_status: delivery.status, branch: null, error: delivery.message };
    default: {
      const exhaustive: never = delivery;
      return exhaustive;
    }
  }
}

async function main(): Promise<void> {
  const parsedArgv = parseControllerArgv(process.argv.slice(2));
  const dir = resolve(parsedArgv.dir);
  const { handoff, model, preflight } = parsedArgv;

  const parsedHandoff = await parseHandoff(join(dir, handoff));
  if (!parsedHandoff.ok) {
    console.error(`dispatch-controller-entry: failed to parse handoff "${handoff}": ${parsedHandoff.message}`);
    process.exit(2);
  }
  const handoffId = parsedHandoff.data.id;

  // Identity injection: the launcher mints the run id and passes --run-id;
  // controller mints only when invoked standalone (debugging/direct CLI).
  const runId = parsedArgv.runId ?? `RUN-${randomUUID()}`;
  const runDir = getRunDir(dir, handoffId, runId);
  const statePath = join(runDir, 'state.json');

  try {
    await mkdir(runDir, { recursive: true });
  } catch (err) {
    console.error(`dispatch-controller-entry: failed to create run dir ${runDir}: ${String(err)}`);
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const pid = process.pid;

  // All state.json writes are serialized through this chain so an in-flight
  // heartbeat write can never complete its rename after the terminal write,
  // which would regress state.json back to `running` (the WK-0013 class).
  let writeChain: Promise<void> = Promise.resolve();
  let state = buildRunningState({ runId, handoffId, model, pid, startedAt, heartbeatAt: startedAt });

  const writeState = (next: V2RunState): void => {
    state = next;
    writeChain = writeChain.then(() => writeJsonAtomic(statePath, state)).catch(() => undefined);
  };

  writeState(state);
  await writeChain;

  let shuttingDown = false;
  const heartbeatTimer = setInterval(() => {
    if (shuttingDown) return;
    writeState({ ...state, heartbeat_at: new Date().toISOString() });
  }, V2_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  let pipelineResult: DispatchResult<DispatchResult2> | null = null;
  let thrown: unknown = null;

  try {
    pipelineResult = await runDispatch({
      dir,
      handoff,
      model,
      backend: parsedArgv.backend,
      effort: parsedArgv.effort,
      runId,
      preflight,
      verbose: false,
    });
  } catch (err) {
    thrown = err;
  } finally {
    shuttingDown = true;
    clearInterval(heartbeatTimer);

    const now = new Date().toISOString();
    // Capture the last heartbeat BEFORE this terminal write's own heartbeat_at
    // touch-up below overwrites it — WK-0244/WK-0260's heartbeat_age_secs is
    // the age of that last heartbeat at the moment of the kill, not of the
    // terminal write itself.
    const lastHeartbeatAt = state.heartbeat_at;
    const terminal = deriveTerminalFields(pipelineResult, thrown, { startedAt, heartbeatAt: lastHeartbeatAt, now });
    writeState({
      ...state,
      status: terminal.status,
      heartbeat_at: now,
      completed_at: now,
      outcome: terminal.outcome,
      delivery_status: terminal.delivery_status,
      branch: terminal.branch,
      error: terminal.error,
      error_detail: terminal.error_detail,
      configured_limit_secs: terminal.configured_limit_secs,
      elapsed_secs: terminal.elapsed_secs,
      heartbeat_age_secs: terminal.heartbeat_age_secs,
    });
    // Await the chain so the terminal write completes before exit — an
    // in-flight heartbeat write that started before shuttingDown=true will
    // finish first (serialized), then this terminal write wins last.
    await writeChain;
  }

  process.exit(pipelineResult?.ok === true ? 0 : 1);
}

// Only auto-run when this file is the process entry point (spawned by
// `dispatch-background.ts`), never on import — so `tests/` can import the
// pure helpers above directly without triggering `main()`'s argv parsing
// (which would call `process.exit(2)` under vitest and kill the test run).
// v1's `controller-entry.ts` doesn't need this guard because no test imports
// it as a module; it's only ever exercised by spawning it as a subprocess.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error('dispatch-controller-entry fatal error:', err);
    process.exit(1);
  });
}

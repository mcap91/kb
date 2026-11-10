/**
 * Host-run validation evidence (WK-0294, DEC-0047). The host — never a
 * worker — runs the operator-registered validation commands
 * (`wiki/.dispatch/validation.json`, repo-config.ts `loadValidationRegistry`)
 * against a delivery commit and records the results as structured JSON in
 * the delivered implement run's dir. The review HO and the merge gate both
 * read that JSON; markdown renders from it (A3.2, rule 45).
 *
 * Confinement (A2 R5, A4.2-A4.6): a fresh temp clone of the delivery sha
 * (clone.ts), bound writable into a bwrap jail built by jail.ts's generic
 * `buildBwrapPlan`. Every step runs inside the jail — nothing derived from
 * the delivery executes on the host. Only the optional setup step gets
 * network (npm lifecycle scripts forced off); registered commands run with
 * `--unshare-net`, which brings loopback up by itself (captured against
 * bubblewrap 0.9.0, 2026-11-09: a listener on 127.0.0.1 accepts, egress is
 * "Network is unreachable"), so no loopback wrapper is needed. The env is an
 * allowlist — `--clearenv` plus PATH, HOME, TMPDIR and registry-declared vars
 * only (A4.3). `.env`/`.claude/` are masked. Output is tail-capped; a
 * timeout kills the jail's whole process group and waits for exit with a
 * forced-kill bound (A4.6).
 *
 * HO `validation` text is never read here (A2 R6): the registry is the sole
 * source of host-run commands.
 */
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createClone, removeClone } from './clone.js';
import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import { buildBwrapPlan, withSecretMaskArgs } from './jail.js';
import { isMountableRoot } from './mountability.js';
import { getRunDir } from './paths.js';
import { validationRegistryFingerprint, type ValidationRegistry } from './repo-config.js';
import { writeJsonAtomic } from './run-state.js';
import { spawnIsolated } from './spawn-isolated.js';

/** File name of the authoritative evidence JSON inside a run dir. */
export const VALIDATION_EVIDENCE_FILE = 'validation-evidence.json';

/** Per-stream output tail kept in the evidence (bytes). */
const OUTPUT_TAIL_BYTES = 16_384;
/** Grace between the group SIGTERM and SIGKILL, and after SIGKILL, on a timeout. */
const KILL_GRACE_MS = 5_000;
const BASE_PATH = '/usr/local/bin:/usr/bin:/bin';

export interface ValidationStepResult {
  /** Registry command name, or `setup`. */
  name: string;
  argv: string[];
  network: boolean;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  /** Unedited tail of stdout / stderr, each at most OUTPUT_TAIL_BYTES. */
  stdout_tail: string;
  stderr_tail: string;
  output_truncated: boolean;
  result: 'pass' | 'fail';
}

export interface ValidationEvidence {
  schema_version: 1;
  handoff_id: string;
  /** The delivered implement run this evidence belongs to. */
  run_id: string;
  delivery_branch: string;
  delivery_sha: string;
  registry_fingerprint: string;
  started_at: string;
  completed_at: string;
  setup: ValidationStepResult | null;
  commands: ValidationStepResult[];
  /** `pass` only when setup (if any) and every registered command passed. */
  outcome: 'pass' | 'fail';
}

export interface RunHostValidationOpts {
  /** Mother repo root. */
  dir: string;
  handoffId: string;
  runId: string;
  deliveryBranch: string;
  deliverySha: string;
  /** Loaded registry; null = none configured (zero commands). */
  registry: ValidationRegistry | null;
}

/** Canonicalize registry runtime roots the same way admission does for runtime_envs (WK-0201). */
async function resolveRuntimePaths(paths: readonly string[]): Promise<DispatchResult<string[]>> {
  const home = process.env.HOME ?? '';
  const resolved: string[] = [];
  for (const entry of paths) {
    let canonical: string;
    try {
      canonical = await realpath(entry);
    } catch (err) {
      return fail('BAD_RECORD', `validation.json runtime_paths entry "${entry}" does not exist on disk.`, err);
    }
    if (home.length > 0 && canonical === home) {
      return fail('BAD_RECORD', `validation.json runtime_paths entry "${entry}" resolves to $HOME itself, which is denied wholesale.`);
    }
    if (!isMountableRoot(canonical, home)) {
      return fail('BAD_RECORD', `validation.json runtime_paths entry "${entry}" (canonical "${canonical}") is outside $HOME and every curated system root.`);
    }
    const bin = await stat(join(canonical, 'bin')).catch(() => null);
    if (bin === null || !bin.isDirectory()) {
      return fail('BAD_RECORD', `validation.json runtime_paths entry "${entry}" (canonical "${canonical}") has no "bin/" directory.`);
    }
    resolved.push(canonical);
  }
  return ok(resolved);
}

async function runStep(opts: {
  name: string;
  argv: string[];
  timeoutMs: number;
  network: boolean;
  clonePath: string;
  runtimePaths: string[];
  env: Record<string, string>;
}): Promise<DispatchResult<ValidationStepResult>> {
  const plan = withSecretMaskArgs(
    buildBwrapPlan({
      clonePath: opts.clonePath,
      cwd: opts.clonePath,
      runtimeEnvPaths: opts.runtimePaths,
      unshareNet: !opts.network,
      allowlistEnv: opts.env,
      command: opts.argv,
    }),
    opts.clonePath,
  );
  const started = Date.now();
  const spawned = await spawnIsolated(plan, {
    timeoutMs: opts.timeoutMs,
    maxCaptureBytes: OUTPUT_TAIL_BYTES,
    maxStderrBytes: OUTPUT_TAIL_BYTES,
    stdoutCapture: 'tail',
    groupTeardown: { killGraceMs: KILL_GRACE_MS },
  });
  if (!spawned.ok) return spawned;
  const r = spawned.data;
  return ok({
    name: opts.name,
    argv: [...opts.argv],
    network: opts.network,
    exit_code: r.exitCode,
    signal: r.signal,
    timed_out: r.timedOut,
    duration_ms: Date.now() - started,
    stdout_tail: r.stdout,
    stderr_tail: r.stderr,
    output_truncated: r.truncated,
    result: r.exitCode === 0 && r.signal === null && !r.timedOut ? 'pass' : 'fail',
  });
}

/**
 * Run the registry against `deliverySha` and write the evidence JSON into
 * the implement run dir (atomic write). A failing command is evidence, not
 * an error: the result is `ok` with `outcome: 'fail'`. Only a run that could
 * not be carried out at all (bad runtime path, clone failure, bwrap spawn
 * failure, unwritable run dir) is a `DispatchResult` failure — and then no
 * evidence file is written, so the merge gate sees evidence as missing.
 */
export async function runHostValidation(opts: RunHostValidationOpts): Promise<DispatchResult<ValidationEvidence>> {
  const startedAt = new Date().toISOString();
  const registry = opts.registry;
  let setup: ValidationStepResult | null = null;
  const commands: ValidationStepResult[] = [];

  if (registry !== null && (registry.setup !== null || registry.commands.length > 0)) {
    const runtime = await resolveRuntimePaths(registry.runtime_paths);
    if (!runtime.ok) return runtime;

    const clone = await createClone({ motherRepo: opts.dir, runId: `RUN-${randomUUID()}`, baseSha: opts.deliverySha });
    if (!clone.ok) return clone;
    const { clonePath } = clone.data;
    try {
      if (clone.data.baseSha !== opts.deliverySha) {
        return fail('PIPELINE_FAILED', `Validation clone resolved ${clone.data.baseSha}, expected delivery sha ${opts.deliverySha}.`);
      }
      const path = [...runtime.data.map((p) => `${p}/bin`), BASE_PATH].join(':');
      const env = { ...registry.env, PATH: path, HOME: '/tmp', TMPDIR: '/tmp' };
      const step = { clonePath, runtimePaths: runtime.data };

      if (registry.setup !== null) {
        // DECISION: npm lifecycle scripts are forced off for setup (A4.2 "scripts ignored"),
        // after the registry env so a registry value cannot turn them back on.
        const ran = await runStep({
          ...step,
          name: 'setup',
          argv: registry.setup.argv,
          timeoutMs: registry.setup.timeout_ms,
          network: true,
          env: { ...env, npm_config_ignore_scripts: 'true' },
        });
        if (!ran.ok) return ran;
        setup = ran.data;
      }

      if (setup === null || setup.result === 'pass') {
        for (const command of registry.commands) {
          const ran = await runStep({
            ...step,
            name: command.name,
            argv: command.argv,
            timeoutMs: command.timeout_ms,
            network: false,
            env,
          });
          if (!ran.ok) return ran;
          commands.push(ran.data);
        }
      }
    } finally {
      const removed = await removeClone(clonePath);
      if (!removed.ok) process.stderr.write(`[host-validation] warning: ${removed.message}\n`);
    }
  }

  const failed = (setup !== null && setup.result === 'fail') || commands.some((c) => c.result === 'fail');
  const evidence: ValidationEvidence = {
    schema_version: 1,
    handoff_id: opts.handoffId,
    run_id: opts.runId,
    delivery_branch: opts.deliveryBranch,
    delivery_sha: opts.deliverySha,
    registry_fingerprint: validationRegistryFingerprint(registry),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    setup,
    commands,
    outcome: failed ? 'fail' : 'pass',
  };

  const evidencePath = join(getRunDir(opts.dir, opts.handoffId, opts.runId), VALIDATION_EVIDENCE_FILE);
  try {
    await writeJsonAtomic(evidencePath, evidence);
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write validation evidence to ${evidencePath}.`, err);
  }
  return ok(evidence);
}

/**
 * Read an evidence JSON back. `null` data = no evidence file. A file that
 * exists but does not parse into the expected shape is a failure, never
 * silently treated as absent.
 */
export async function readValidationEvidence(path: string): Promise<DispatchResult<ValidationEvidence | null>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok(null);
    return fail('FILE_NOT_FOUND', `Failed to read validation evidence ${path}.`, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return fail('BAD_RECORD', `Malformed validation evidence JSON at ${path}.`, err);
  }
  const e = parsed as Partial<ValidationEvidence> | null;
  if (
    e === null ||
    typeof e !== 'object' ||
    e.schema_version !== 1 ||
    typeof e.run_id !== 'string' ||
    typeof e.delivery_sha !== 'string' ||
    typeof e.registry_fingerprint !== 'string' ||
    (e.outcome !== 'pass' && e.outcome !== 'fail') ||
    !Array.isArray(e.commands)
  ) {
    return fail('BAD_RECORD', `Validation evidence at ${path} does not match schema_version 1.`);
  }
  return ok(e as ValidationEvidence);
}

/** In-run-dir names of the copies a derived review reads (DEC-0047 A3.3, A4.1). */
export const REVIEW_EVIDENCE_COPY = VALIDATION_EVIDENCE_FILE;
export const REVIEW_RESPONSE_COPY = 'implement-response.md';

export interface StagedReviewEvidence {
  /** Absolute path of the evidence JSON copy in the review run dir. */
  evidencePath: string;
  /** Absolute path of the implement response copy in the review run dir. */
  responsePath: string;
}

/**
 * Review dispatch (WK-0294/WK-0295, DEC-0047 A3.3 + A4.1): copy the host
 * evidence JSON and the implement response into the fresh review run dir —
 * already bound into every jail — so the reviewer reads them in both wiki
 * shapes without touching the clone tree. Applies to a derived review only
 * (code_review with a `dispatch/` base_ref and a `reviewed_run` stamp);
 * anything else returns `ok(null)`. A derived review whose evidence or
 * response is gone fails closed: dispatching it would ask for a review
 * without the facts the derivation promised. The copies are the reviewer's;
 * the merge gate reads only the host original.
 */
export async function stageReviewEvidence(opts: {
  dir: string;
  handoff: { mode: string; base_ref: string | null; reviewed_run?: string };
  runDir: string;
}): Promise<DispatchResult<StagedReviewEvidence | null>> {
  const { handoff } = opts;
  if (handoff.mode !== 'code_review' || handoff.reviewed_run === undefined) return ok(null);
  if (handoff.base_ref === null || !handoff.base_ref.startsWith('dispatch/')) return ok(null);
  const implementId = handoff.base_ref.slice('dispatch/'.length);

  const source = join(getRunDir(opts.dir, implementId, handoff.reviewed_run), VALIDATION_EVIDENCE_FILE);
  const evidence = await readValidationEvidence(source);
  if (!evidence.ok) return evidence;
  if (evidence.data === null) {
    return fail('BAD_RECORD', `Derived review has no host validation evidence at ${source}; re-run derive-review for ${implementId}.`);
  }
  let response: string;
  const responseSource = join(opts.dir, 'wiki', 'handoffs', `${implementId}.response.md`);
  try {
    response = await readFile(responseSource, 'utf8');
  } catch (err) {
    return fail('BAD_RECORD', `Derived review cannot stage the implement response ${responseSource}.`, err);
  }

  const staged = {
    evidencePath: join(opts.runDir, REVIEW_EVIDENCE_COPY),
    responsePath: join(opts.runDir, REVIEW_RESPONSE_COPY),
  };
  try {
    await writeJsonAtomic(staged.evidencePath, evidence.data);
    await writeFile(staged.responsePath, response, 'utf8');
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to stage review evidence into ${opts.runDir}.`, err);
  }
  return ok(staged);
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

function renderStep(step: ValidationStepResult): string[] {
  const status = step.timed_out ? 'timed out' : step.signal !== null ? `signal ${step.signal}` : `exit ${step.exit_code}`;
  const lines = [
    `#### ${step.name}: ${step.result.toUpperCase()} (${status}, ${step.duration_ms} ms${step.network ? ', network' : ''})`,
    '',
    `argv: \`${JSON.stringify(step.argv)}\``,
    '',
  ];
  if (step.stdout_tail.length > 0) lines.push('stdout (tail):', '', fence(step.stdout_tail), '');
  if (step.stderr_tail.length > 0) lines.push('stderr (tail):', '', fence(step.stderr_tail), '');
  if (step.output_truncated) lines.push('_Output exceeded the capture bound; only the tail is shown._', '');
  return lines;
}

/**
 * Render the evidence as markdown for the review HO (rule 45: rendered from
 * the JSON, output tails verbatim). Acceptance text is never touched (A1.5).
 */
export function renderValidationEvidence(evidence: ValidationEvidence): string {
  const lines = [
    `Host validation of \`${evidence.delivery_branch}\` at \`${evidence.delivery_sha}\` (implement run \`${evidence.run_id}\`): **${evidence.outcome.toUpperCase()}**.`,
    '',
  ];
  if (evidence.setup === null && evidence.commands.length === 0) {
    lines.push('No validation commands are registered (`wiki/.dispatch/validation.json`), so the host ran nothing.', '');
  }
  if (evidence.setup !== null) lines.push(...renderStep(evidence.setup));
  if (evidence.setup !== null && evidence.setup.result === 'fail') {
    lines.push('Setup failed, so no registered command ran.', '');
  }
  for (const command of evidence.commands) lines.push(...renderStep(command));
  return lines.join('\n').trimEnd();
}

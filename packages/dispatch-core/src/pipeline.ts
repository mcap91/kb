/**
 * `runDispatch()` — the v2 dispatch pipeline (dispatch v2, PLN-0004 S0 Wave 3).
 * Wires waves 1-2's skeleton modules into one atomic, gated call (DEC-0007 D1):
 * parse -> admission -> preflight -> clone -> jail+Pi -> enumerate -> delivery
 * gate -> capture -> clone teardown. Facts-only adapters/scripts stay
 * facts-only (D10); this module is the one place that OWNS policy (which
 * checks gate the run, what happens on refusal, when the clone gets torn
 * down) and the one place that actually executes anything.
 *
 * Deliberately linear: this file reads top-to-bottom as the pipeline itself,
 * not as a set of composed abstractions. Failures short-circuit via early
 * `return`; the ephemeral clone is created before a `try` and always removed
 * in its `finally`, so every early return past clone-creation still cleans up
 * (the 24h orphan sweep in clone.ts is a best-effort safety net, not a
 * license to skip this).
 *
 * Sequencing note vs. the wave-3 brief's literal step numbering: preflight
 * (originally listed before run-ID/run-dir creation) runs AFTER the run dir
 * exists, using the real run dir to stage its probe script/output rather than
 * a disposable temp dir — `runPreflight`'s signature takes a `runDir`, this
 * keeps the probe artifacts alongside the rest of the run's evidence, and a
 * failed preflight still leaves only a cheap, already-empty run dir behind
 * (no clone has been created yet at that point).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { parseHandoff } from './ho.js';
import { checkAdmission } from './admission.js';
import { getDefaultRegistry, resolveModel } from './model-registry.js';
import { assemblePrompt } from './assemble.js';
import { buildInvocation, parsePiOutput } from './adapters/pi.js';
import { execViaWsl2, windowsToWslPath, resolveWinHostIp } from './wsl2.js';
import { buildJailArgs } from './jail.js';
import { createClone, removeClone } from './clone.js';
import {
  buildEnumerateScript,
  parseEnumerateOutput,
  checkWriteScope,
  scanSecrets,
  buildDeliveryScript,
  parseDeliveryOutput,
  type DeliveryOutcome,
} from './delivery.js';
import { writeResponseDoc } from './capture.js';
import { runPreflight } from './preflight.js';
import { getRunDir } from './paths.js';

const WORKER_TIMEOUT_SECS = 1800;
const WORKER_TIMEOUT_MS = WORKER_TIMEOUT_SECS * 1000;

// Worker infrastructure directories that live inside the ephemeral clone
// (bwrap S0 only mounts clonePath writable). Excluded from enumeration
// and delivery to prevent scope refusal and credential leaks (WK-0075).
const PI_WORKER_DIR = '.pi-agent';
const WORKER_INFRA_PREFIXES = [PI_WORKER_DIR];

export interface DispatchOpts {
  /** Windows path to the mother repo */
  dir: string;
  /** Relative path to the HO file from repo root */
  handoff: string;
  /** Model alias from the registry (e.g. 'deepseek', 'qwen3:8b') */
  model: string;
  /** Run preflight before dispatch? (default: true) */
  preflight?: boolean;
  /** Verbose output */
  verbose?: boolean;
}

export interface DispatchResult2 {
  runId: string;
  handoffId: string;
  model: string;
  delivery: DeliveryOutcome;
  responsePath: string;
  runDir: string;
}

/** Single-quote a value for safe embedding in generated bash (mirrors delivery.ts's private helper). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function logVerbose(verbose: boolean | undefined, message: string): void {
  if (verbose) process.stderr.write(`[dispatch] ${message}\n`);
}

export async function runDispatch(opts: DispatchOpts): Promise<DispatchResult<DispatchResult2>> {
  const dir = resolve(opts.dir);
  const { verbose } = opts;

  // 1. Parse HO
  logVerbose(verbose, `parsing handoff ${opts.handoff}`);
  const parsed = await parseHandoff(join(dir, opts.handoff));
  if (!parsed.ok) return parsed;
  const handoff = parsed.data;

  // 2. Admission (bad_record-lite, missing_write_scope, dirty_repo; resolves base_sha)
  logVerbose(verbose, `running admission checks for ${handoff.id}`);
  const admission = await checkAdmission(handoff, dir);
  if (!admission.ok) return admission;

  // 3. Resolve model
  logVerbose(verbose, `resolving model alias "${opts.model}"`);
  const modelResult = resolveModel(getDefaultRegistry(), opts.model);
  if (!modelResult.ok) return modelResult;
  const model = modelResult.data;
  const canonicalModel = `${model.provider}/${model.modelId}`;

  // 5. Generate run ID
  const runId = `RUN-${randomUUID()}`;

  // 6. Create run dir
  const runDir = getRunDir(dir, handoff.id, runId);
  try {
    await mkdir(runDir, { recursive: true });
  } catch (err) {
    return fail('PIPELINE_FAILED', `Failed to create run dir: ${runDir}`, err);
  }

  // 4. Run preflight (if enabled) — gate BEFORE any clone/jail work is done.
  if (opts.preflight !== false) {
    logVerbose(verbose, 'running T27 host preflight (bwrap presence / live unshare-user / AppArmor userns)');
    const preflight = await runPreflight(runDir);
    if (!preflight.ok) return preflight;
    if (preflight.data.remediationNeeded) {
      return fail(
        'PREFLIGHT_FAILED',
        preflight.data.remediationText ?? 'Preflight failed: bwrap user namespace support is unavailable.',
        preflight.data,
      );
    }
  }

  // 7. Assemble prompt
  logVerbose(verbose, 'assembling worker prompt');
  const assembled = await assemblePrompt(handoff, dir);
  if (!assembled.ok) return assembled;

  // 8. Write prompt to run dir
  const promptPath = join(runDir, 'prompt.txt');
  try {
    await writeFile(promptPath, assembled.data.text, 'utf8');
  } catch (err) {
    return fail('PIPELINE_FAILED', `Failed to write prompt file: ${promptPath}`, err);
  }

  // 9. Clone (ephemeral full clone @ pinned base_sha, WSL2 ext4)
  logVerbose(verbose, `cloning mother repo at base_sha ${admission.data.baseSha}`);
  const cloneResult = await createClone({
    motherRepo: dir,
    runId,
    baseSha: admission.data.baseSha,
  });
  if (!cloneResult.ok) return cloneResult;
  const { clonePath } = cloneResult.data;

  try {
    // 10. Build Pi invocation. workerDir (PI_CODING_AGENT_DIR) is nested INSIDE
    // clonePath: jail.ts's S0-minimum bwrap only remounts clonePath writable
    // (bwrap cannot bind a path that doesn't already exist under the ro root),
    // so anywhere Pi needs to write must live under the one writable bind.
    const workerDir = `${clonePath}/${PI_WORKER_DIR}`;
    const promptPathWsl = windowsToWslPath(promptPath);
    const invocation = buildInvocation(promptPathWsl, model, clonePath, workerDir);

    // 12. Build jail args
    const jailArgs = buildJailArgs({ clonePath });

    // 13. Build the full execution script: source secrets -> set up
    // PI_CODING_AGENT_DIR -> write models.json (still carrying the literal
    // {{WIN_HOST}} placeholder, since Pi's own $VAR apiKey interpolation must
    // stay unexpanded through this step) -> resolve WIN_HOST and substitute it
    // in place -> run bwrap+pi. The models.json body is written via a
    // quote-delimited heredoc so no shell expansion touches Pi's own $VAR
    // apiKey placeholders (Pi resolves those itself, from its OWN process env,
    // once secrets.env has been sourced — bwrap's S0 jail args do not clear
    // env, so a sourced secret reaches the jailed pi process unchanged).
    const bwrapCommand = [...jailArgs.argv, invocation.cmd, ...invocation.args].map(shQuote).join(' ');
    const runDirWsl = windowsToWslPath(runDir);
    const executionScript = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      '# Non-interactive shells skip .bashrc; ensure npm-global and local bins are reachable',
      'export PATH="$HOME/.npm-global-wsl/bin:$HOME/.local/bin:$PATH"',
      '',
      '# Source secrets (if needed)',
      'if [ -f ~/.config/kb-dispatch/secrets.env ]; then',
      '  set -a',
      '  . ~/.config/kb-dispatch/secrets.env',
      '  set +a',
      'fi',
      '',
      `export PI_CODING_AGENT_DIR=${shQuote(workerDir)}`,
      'export PI_OFFLINE=1',
      'mkdir -p "$PI_CODING_AGENT_DIR"',
      '',
      `cat <<'DISPATCH_MODELS_JSON_EOF' > "$PI_CODING_AGENT_DIR/models.json"`,
      invocation.modelsJsonContent,
      'DISPATCH_MODELS_JSON_EOF',
      '',
      `WIN_HOST=$(${resolveWinHostIp()})`,
      'sed -i "s/{{WIN_HOST}}/$WIN_HOST/g" "$PI_CODING_AGENT_DIR/models.json"',
      '',
      `PI_LOG=${shQuote(`${runDirWsl}/pi-output.log`)}`,
      `WORKER_TIMEOUT_SECS=${WORKER_TIMEOUT_SECS}`,
      `timeout --signal=TERM --kill-after=30s "$WORKER_TIMEOUT_SECS" ${bwrapCommand} < /dev/null 2>&1 | tee "$PI_LOG"`,
      '',
    ].join('\n');

    // 14. Execute via execViaWsl2
    logVerbose(verbose, `invoking ${canonicalModel} via bwrap+pi in the WSL2 clone`);
    const execResult = await execViaWsl2({
      runDir,
      scriptContent: executionScript,
      scriptName: 'dispatch-run.sh',
      timeoutMs: WORKER_TIMEOUT_MS + 60_000,
    });
    if (!execResult.ok) return execResult;
    if (execResult.data.exitCode !== 0 && execResult.data.exitCode !== 124) {
      return fail(
        'PIPELINE_FAILED',
        `Dispatch execution script exited with code ${execResult.data.exitCode} (killedBySignal=${execResult.data.killedBySignal}).`,
        execResult.data,
      );
    }

    // 15. Parse Pi output (exit 124 = watchdog timeout; recoverable only if
    // Pi wrote agent_end before the reap — the pi#4303 post-completion flavor)
    const piParsed = parsePiOutput(execResult.data.stdout);
    if (!piParsed.ok) {
      if (execResult.data.exitCode === 124) {
        return fail('PIPELINE_FAILED', `Worker timed out after ${WORKER_TIMEOUT_SECS}s (watchdog exit 124; no parseable output).`, execResult.data);
      }
      return piParsed;
    }

    if (execResult.data.exitCode === 124 && !piParsed.data.hasAgentEnd) {
      return fail('PIPELINE_FAILED', `Worker timed out after ${WORKER_TIMEOUT_SECS}s (watchdog exit 124).`, { exitCode: 124, piOutcome: piParsed.data.outcome });
    }

    if (execResult.data.exitCode === 124) {
      logVerbose(verbose, 'watchdog reaped pi after completion (pi#4303 flavor)');
    }
    logVerbose(verbose, `pi outcome: ${piParsed.data.outcome}`);

    // 16. Enumerate changes
    logVerbose(verbose, 'enumerating changes in the clone');
    const enumerateScript = buildEnumerateScript(clonePath);
    const enumerateExec = await execViaWsl2({
      runDir,
      scriptContent: enumerateScript.scriptContent,
      scriptName: enumerateScript.scriptName,
      timeoutMs: 120_000,
    });
    if (!enumerateExec.ok) return enumerateExec;
    if (enumerateExec.data.exitCode !== 0) {
      return fail(
        'PIPELINE_FAILED',
        `Enumerate script exited with code ${enumerateExec.data.exitCode}.`,
        enumerateExec.data,
      );
    }
    const enumerated = parseEnumerateOutput(enumerateExec.data.stdout);
    const isWorkerInfra = (p: string): boolean =>
      WORKER_INFRA_PREFIXES.some(pfx => p === pfx || p.startsWith(pfx + '/'));
    const allChangedFiles = [
      ...enumerated.changedFiles.filter(f => !isWorkerInfra(f)),
      ...enumerated.untrackedFiles.filter(f => !isWorkerInfra(f)),
    ];

    // 17. Check write scope, scan secrets — refusals are DATA (a DeliveryOutcome
    // variant), not a DispatchResult failure; the pipeline ran correctly.
    const scopeCheck = checkWriteScope(allChangedFiles, handoff.write_scope);
    const secretCheck = scanSecrets(enumerated.diff);

    let delivery: DeliveryOutcome;

    if (!scopeCheck.ok) {
      const quarantinePath = join(runDir, 'quarantine.diff');
      try {
        await writeFile(quarantinePath, enumerated.diff, 'utf8');
      } catch (err) {
        return fail('CAPTURE_FAILED', `Failed to write quarantine diff: ${quarantinePath}`, err);
      }
      logVerbose(verbose, `refused: out-of-scope paths ${scopeCheck.offendingPaths.join(', ')}`);
      delivery = { status: 'refused_out_of_scope', offendingPaths: scopeCheck.offendingPaths, quarantinePath };
    } else if (!secretCheck.ok) {
      const quarantinePath = join(runDir, 'quarantine.diff');
      try {
        await writeFile(quarantinePath, enumerated.diff, 'utf8');
      } catch (err) {
        return fail('CAPTURE_FAILED', `Failed to write quarantine diff: ${quarantinePath}`, err);
      }
      logVerbose(verbose, `refused: secret pattern(s) ${secretCheck.patterns.join(', ')}`);
      delivery = { status: 'secret_in_diff', patterns: secretCheck.patterns, quarantinePath };
    } else {
      // 18. Deliver (clean: land the scope-checked commit)
      logVerbose(verbose, 'delivering scope-checked commit');
      const deliveryScript = buildDeliveryScript({
        clonePath,
        motherRepoWsl: windowsToWslPath(dir),
        handoffId: handoff.id,
        baseSha: admission.data.baseSha,
        excludePrefixes: WORKER_INFRA_PREFIXES,
      });
      const deliveryExec = await execViaWsl2({
        runDir,
        scriptContent: deliveryScript.scriptContent,
        scriptName: deliveryScript.scriptName,
        timeoutMs: 120_000,
      });
      if (!deliveryExec.ok) return deliveryExec;
      if (deliveryExec.data.exitCode !== 0) {
        return fail(
          'DELIVERY_FAILED',
          `Delivery script exited with code ${deliveryExec.data.exitCode}.`,
          deliveryExec.data,
        );
      }
      // 19. Parse delivery output
      delivery = parseDeliveryOutput(deliveryExec.data.stdout);
      logVerbose(verbose, `delivery outcome: ${delivery.status}`);
    }

    // 20. Capture
    const captureResult = await writeResponseDoc({
      runDir,
      handoff: { id: handoff.id, title: handoff.title, mode: handoff.mode },
      delivery,
      piResult: { outcome: piParsed.data.outcome, usage: piParsed.data.usage },
      model: canonicalModel,
      isolationBackend: 'bwrap-wsl2',
    });
    if (!captureResult.ok) return captureResult;

    // 22. Return result
    return ok({
      runId,
      handoffId: handoff.id,
      model: canonicalModel,
      delivery,
      responsePath: captureResult.data.responsePath,
      runDir,
    });
  } finally {
    // 21. Remove clone — best-effort; clone.ts's 24h orphan sweep is the
    // safety net if this itself fails to run (never rejects, but belt+suspenders).
    await removeClone(clonePath, runDir).catch(() => undefined);
  }
}

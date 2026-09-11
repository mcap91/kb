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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { parseHandoff } from './ho.js';
import { checkAdmission } from './admission.js';
import {
  resolveModelFromConfig,
  checkHarnessVersion,
  buildFingerprintFragment,
  parseFingerprintOutput,
  type ResolvedModel,
  type ModelEntry,
} from './model-registry.js';
import { assemblePrompt } from './assemble.js';
import { buildInvocation, parsePiOutput } from './adapters/pi.js';
import { execViaWsl2, windowsToWslPath, resolveWinHostIp } from './wsl2.js';
import { buildJailArgs } from './jail.js';
import { createClone, removeClone } from './clone.js';
import {
  buildEnumerateScript,
  parseEnumerateOutput,
  checkWriteScope,
  buildDeliveryScript,
  parseDeliveryOutput,
  type DeliveryOutcome,
} from './delivery.js';
import { writeResponseDoc, buildProvenanceWriteBack } from './capture.js';
import { runPreflight } from './preflight.js';
import { getRunDir } from './paths.js';
import { loadProfilesConfig } from './repo-config.js';
import {
  resolveCredentials,
  checkCredentialPolicy,
  buildInjectionScript,
  buildInjectedValueScanFragment,
  parseInjectedValueScanOutput,
} from './credentials.js';

const WORKER_TIMEOUT_SECS = 1800;
const WORKER_TIMEOUT_MS = WORKER_TIMEOUT_SECS * 1000;

// Worker infrastructure directories that live inside the ephemeral clone
// (bwrap S0 only mounts clonePath writable). Excluded from enumeration
// and delivery to prevent scope refusal and credential leaks (WK-0075).
const PI_WORKER_DIR = '.pi-agent';
const WORKER_INFRA_PREFIXES = [PI_WORKER_DIR];

const VALID_RUN_ID = /^RUN-[0-9a-f-]{36}$/i;

export interface DispatchOpts {
  /** Windows path to the mother repo */
  dir: string;
  /** Relative path to the HO file from repo root */
  handoff: string;
  /** Model alias from the registry (e.g. 'deepseek', 'qwen3:8b') */
  model: string;
  /** Backend name from the registry (e.g. 'openrouter', 'ollama'). Required at S3. */
  backend: string;
  /** Effort/reasoning level. Refused with EFFORT_UNSUPPORTED when the model cannot carry it. */
  effort?: string;
  /** Pre-minted run id (background controller injects this; standalone callers omit). */
  runId?: string;
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

  // 3. Resolve model (repo-local two-table config — S3 ruling 1; supersedes the S0 seed registry)
  logVerbose(verbose, `resolving model "${opts.model}" on backend "${opts.backend}"`);
  const modelResult = await resolveModelFromConfig(dir, opts.model, opts.backend);
  if (!modelResult.ok) return modelResult;
  const model = modelResult.data;
  const canonicalModel = `${model.backend}/${model.modelId}`;

  // 3b. Effort gate (S3 ruling 9) — refuse pre-spawn when the resolved model/backend
  // cannot carry an effort/reasoning parameter.
  if (opts.effort && !model.supportsEffort) {
    return fail(
      'EFFORT_UNSUPPORTED',
      `Model "${opts.model}" on backend "${opts.backend}" does not support effort/reasoning parameters.`,
    );
  }

  // 3c. Credential resolution + policy (S3 T10/T12) — after admission+model resolution,
  // before spawn (S1 ruling 2 order: synchronous gate checks run before any clone/jail work).
  logVerbose(verbose, 'resolving credential profiles');
  const profilesResult = await loadProfilesConfig(dir);
  if (!profilesResult.ok) {
    // Malformed profiles.json refuses credentialed dispatches only (ruling 1); an
    // uncredentialed dispatch proceeds with an empty profiles config below.
    if (handoff.credentials.length > 0) return profilesResult;
  }
  const profilesConfig = profilesResult.ok ? profilesResult.data : { schemaVersion: 1 as const, profiles: {} };
  const credResult = resolveCredentials(handoff, profilesConfig, {
    base_url: model.baseUrl,
    api_key_env: model.apiKeyEnv,
    secrets_file: model.secretsFile,
  });
  if (!credResult.ok) return credResult;

  const policyResult = checkCredentialPolicy(handoff, credResult.data);
  if (!policyResult.ok) return policyResult;

  // 5. Run ID — injected by the background controller, or minted here for standalone callers.
  const runId = opts.runId ?? `RUN-${randomUUID()}`;
  if (!VALID_RUN_ID.test(runId)) {
    return fail('PIPELINE_FAILED', `Invalid run id format: ${runId}`);
  }

  // 6. Create run dir (idempotent — controller may have already created it)
  const runDir = getRunDir(dir, handoff.id, runId);
  try {
    await mkdir(runDir, { recursive: true });
  } catch (err) {
    return fail('PIPELINE_FAILED', `Failed to create run dir: ${runDir}`, err);
  }

  // 4. Run preflight (if enabled) — gate BEFORE any clone/jail work is done.
  let piVersion: string | undefined;
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

    // Harness version gate (S3 ruling 7) — refuse-below/warn-above/fail-closed,
    // gated against the in-code PI_HARNESS_INFO constant (model-registry.ts).
    piVersion = preflight.data.piVersion;
    if (piVersion) {
      const versionGate = checkHarnessVersion(piVersion);
      if (versionGate.status === 'refuse') {
        return fail('PREFLIGHT_FAILED', versionGate.message);
      }
      if (versionGate.status === 'warn') {
        logVerbose(verbose, `version warning: ${versionGate.message}`);
      }
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
    // adapters/pi.ts still expects the legacy ModelEntry shape; build one from the
    // resolved two-table model (S3 ruling 1) rather than widening the adapter's
    // facts-only interface (D10) for a single-slice-old type.
    const piModelEntry: ModelEntry = {
      provider: model.backend,
      modelId: model.modelId,
      displayName: `${model.slug} (${model.backend})`,
      baseUrl: model.baseUrl,
      api: 'openai-completions',
      apiKeyEnv: model.apiKeyEnv,
      contextWindow: 131072,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const invocation = buildInvocation(promptPathWsl, piModelEntry, clonePath, workerDir);

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

    // Selective credential injection (S3 ruling 2 / freeze correction: SCRIPT-SIDE,
    // Linux-only — secret values are read from their named files IN-SHELL and never
    // exist in Windows process memory or in this script's own text). Retires the
    // blanket `set -a; . secrets.env; set +a` block: only the resolved backend's
    // api_key_env plus granted profiles' inject vars reach the worker.
    const injectionScript = buildInjectionScript(credResult.data, handoff.vars);
    // Backend fingerprint (S3 ruling 8) — best-effort, facts-only, never gating.
    const fingerprintLines = buildFingerprintFragment(model);

    const executionScript = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      '# Non-interactive shells skip .bashrc; ensure npm-global and local bins are reachable',
      'export PATH="$HOME/.npm-global-wsl/bin:$HOME/.local/bin:$PATH"',
      '',
      '# Selective credential injection (S3 ruling 2): existence checks first (early',
      '# exit with CREDENTIAL_NOT_CONFIGURED on a missing cred), then export only the',
      '# resolved backend key + granted profile vars, then HO vars literals.',
      ...injectionScript.existenceCheckLines,
      ...injectionScript.exportLines,
      ...injectionScript.varsExportLines,
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
      ...fingerprintLines,
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
      // The existenceCheckLines fragment (S3 ruling 3) exits 1 with this exact
      // signal BEFORE the worker ever spawns when a granted credential's file/var
      // is missing — surface it as CREDENTIAL_NOT_CONFIGURED, not a generic failure.
      const credNotConfigured = execResult.data.stdout.match(/CREDENTIAL_NOT_CONFIGURED:(\S+)/);
      if (credNotConfigured) {
        return fail(
          'CREDENTIAL_NOT_CONFIGURED',
          `Credential variable "${credNotConfigured[1]}" is not configured (missing from its named source file).`,
          execResult.data,
        );
      }
      return fail(
        'PIPELINE_FAILED',
        `Dispatch execution script exited with code ${execResult.data.exitCode} (killedBySignal=${execResult.data.killedBySignal}).`,
        execResult.data,
      );
    }

    // Backend fingerprint (S3 ruling 8) — parsed from the same execution-script
    // stdout the Pi JSON-lines output rode in on; best-effort, facts-only.
    const fingerprint = parseFingerprintOutput(execResult.data.stdout);

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

    // 16. Enumerate changes. The injected-value scan fragment (S3 ruling 2 /
    // s3-rulings.md freeze correction — replaces the removed pattern-based
    // scanSecrets() leg) is spliced onto the END of this SAME script: it
    // reuses the enumerate script's own `$GIT`/`$CLONE_PATH` shell scope to
    // re-diff into a throwaway `$DIFF_FILE` and grep it for each granted
    // credential's literal value, entirely WSL2-side (one exec round trip,
    // no diff content ever written to Windows disk for this check). Only var
    // NAMES (`SECRET_HIT=<VAR_NAME>`) cross back into this stdout — the
    // resolved values themselves never reach Windows process memory or this
    // script's own text. Every injection scanned here already passed the
    // execution script's existenceCheckLines earlier in this same run (step
    // 13/14), so the grep is guaranteed to find a value under `set -e`.
    logVerbose(verbose, 'enumerating changes in the clone');
    const enumerateScript = buildEnumerateScript(clonePath);
    const valueScanLines = buildInjectedValueScanFragment(credResult.data);
    const enumerateScriptContent = valueScanLines.length === 0
      ? enumerateScript.scriptContent
      : [
          enumerateScript.scriptContent,
          'DIFF_FILE=$(mktemp)',
          '$GIT diff HEAD > "$DIFF_FILE" 2>/dev/null || true',
          ...valueScanLines,
          'rm -f "$DIFF_FILE"',
        ].join('\n');
    const enumerateExec = await execViaWsl2({
      runDir,
      scriptContent: enumerateScriptContent,
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
    const secretHits = parseInjectedValueScanOutput(enumerateExec.data.stdout);
    const isWorkerInfra = (p: string): boolean =>
      WORKER_INFRA_PREFIXES.some(pfx => p === pfx || p.startsWith(pfx + '/'));
    const allChangedFiles = [
      ...enumerated.changedFiles.filter(f => !isWorkerInfra(f)),
      ...enumerated.untrackedFiles.filter(f => !isWorkerInfra(f)),
    ];

    // 17. Check write scope, check the injected-value scan hits captured
    // above — refusals are DATA (a DeliveryOutcome variant), not a
    // DispatchResult failure; the pipeline ran correctly. (S3: the
    // deterministic injected-value scan replaces the removed pattern-based
    // scanSecrets() leg — it checks only the exact values the worker was
    // granted, not heuristic patterns, so it is fully deterministic.)
    const scopeCheck = checkWriteScope(allChangedFiles, handoff.write_scope);

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
    } else if (secretHits.length > 0) {
      const quarantinePath = join(runDir, 'quarantine.diff');
      try {
        await writeFile(quarantinePath, enumerated.diff, 'utf8');
      } catch (err) {
        return fail('CAPTURE_FAILED', `Failed to write quarantine diff: ${quarantinePath}`, err);
      }
      logVerbose(verbose, `refused: granted credential value(s) found in diff: ${secretHits.join(', ')}`);
      delivery = { status: 'secret_in_diff', patterns: secretHits, quarantinePath };
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
      needs: piParsed.data.needs,
      credentialsGranted: credResult.data.granted,
      baseUrl: model.baseUrl,
      backend: model.backend,
      piVersion,
      backendFingerprint: fingerprint?.serverVersion ?? undefined,
    });
    if (!captureResult.ok) return captureResult;

    // 20b. Canonical response copy (T7-full closure item 2, S1). The run-dir
    // copy above is dispatch's own staging evidence; the response doc's
    // canonical home is `wiki/handoffs/HO-XXXX.response.md` in the mother
    // repo (spec §5). Best-effort — dispatch does not own the wiki dir
    // structure, and a write failure here must never fail an otherwise
    // successful run.
    const canonicalDir = join(dir, 'wiki', 'handoffs');
    const canonicalPath = join(canonicalDir, `${handoff.id}.response.md`);
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(canonicalPath, captureResult.data.responseContent, 'utf8');
    } catch (err) {
      logVerbose(verbose, `warning: could not write canonical response to ${canonicalPath}: ${err}`);
    }

    // 20c. Provenance write-back (T7-full closure item 3, S1): merge
    // buildProvenanceWriteBack's fields into the HO's own frontmatter.
    // Write-back dirt rule (s1-rulings.md): dispatch writes the pair +
    // frontmatter but NEVER commits to the mother repo — this is file I/O
    // only. Best-effort, same as the canonical copy above.
    const provenance = buildProvenanceWriteBack({
      runDir,
      handoff: { id: handoff.id, title: handoff.title, mode: handoff.mode },
      delivery,
      model: canonicalModel,
      isolationBackend: 'bwrap-wsl2',
      needs: piParsed.data.needs,
      credentialsGranted: credResult.data.granted,
      baseUrl: model.baseUrl,
      backend: model.backend,
      piVersion,
      backendFingerprint: fingerprint?.serverVersion ?? undefined,
    });
    const hoPath = join(dir, opts.handoff);
    try {
      const hoContent = await readFile(hoPath, 'utf8');
      const updated = mergeProvenanceFrontmatter(hoContent, provenance.fields);
      await writeFile(hoPath, updated, 'utf8');
    } catch (err) {
      logVerbose(verbose, `warning: could not write provenance to ${hoPath}: ${err}`);
    }

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

// ---------------------------------------------------------------------------
// T7-full closure (S1): provenance frontmatter write-back merge helper. Not
// part of the package's public surface (src/index.ts exports only
// DispatchOpts/DispatchResult2/runDispatch from this module) — exported here
// at module scope only so tests can import it directly, the same way this
// codebase's other v2 modules are unit-tested (see tests/dispatch-v2-*.test.ts).
// ---------------------------------------------------------------------------

function formatFrontmatterValue(value: string | boolean | string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  }
  return String(value);
}

/**
 * Merge provenance write-back fields (`buildProvenanceWriteBack`'s output)
 * into an HO record's existing YAML frontmatter. A field that already has a
 * `key: value` line (e.g. `run_id` from a prior run on the same HO) is
 * replaced in place; a field with no existing line is appended just before
 * the closing `---`, so the HO's original field order and body are otherwise
 * untouched. Returns `content` unchanged if it has no recognizable
 * `---`-delimited frontmatter block, rather than guessing at a malformed
 * file's structure (mirrors ho.ts's splitFrontmatter tolerance).
 */
export function mergeProvenanceFrontmatter(
  content: string,
  fields: Record<string, string | boolean | string[]>,
): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return content;

  const frontmatterText = match[1] ?? '';
  const body = match[2] ?? '';
  const lines = frontmatterText.split('\n');
  const remainingKeys = new Set(Object.keys(fields));

  const updatedLines = lines.map((line) => {
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (!kvMatch) return line;
    const key = kvMatch[1]!;
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return line;
    remainingKeys.delete(key);
    return `${key}: ${formatFrontmatterValue(fields[key]!)}`;
  });

  for (const key of Object.keys(fields)) {
    if (remainingKeys.has(key)) {
      updatedLines.push(`${key}: ${formatFrontmatterValue(fields[key]!)}`);
    }
  }

  return `---\n${updatedLines.join('\n')}\n---\n${body}`;
}

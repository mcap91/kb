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
import { buildJailArgs, classifyWikiShape, type WikiShape } from './jail.js';
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
import { runPreflight, type PreflightResult } from './preflight.js';
import { getRunDir } from './paths.js';
import { loadProfilesConfig } from './repo-config.js';
import {
  resolveCredentials,
  checkCredentialPolicy,
  buildInjectionScript,
  buildInjectedValueScanFragment,
  parseInjectedValueScanOutput,
  type InjectionScriptLines,
} from './credentials.js';
import {
  buildTunnelBashLines,
  TUNNEL_RELAY_PORT,
  TUNNEL_SOCKET_NAME,
  type TunnelConfig,
  type TunnelBashLines,
} from './tunnel.js';
import { resolveTier, checkIsolationRoute, type TierProbeInputs, type HostTier } from './tier.js';
import { parseReviewFile, type StructuredReviewResult } from './response-header.js';

const WORKER_TIMEOUT_SECS = 1800;
const WORKER_TIMEOUT_MS = WORKER_TIMEOUT_SECS * 1000;

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
  /**
   * Parsed structured review verdict (S6a ruling 3, re-platformed onto a
   * file artifact at S6a W4) — present only for a `code_review` mode run
   * whose `.dispatch-out/review.yaml` was present and parsed
   * deterministically. Absent (never a pipeline failure) when the mode
   * isn't `code_review`, the file was never written, or it failed to parse;
   * either failure is informational for the orchestrator, surfaced via
   * `reviewParseError` below (and logged verbose-only) rather than silently
   * dropped.
   */
  reviewResult?: StructuredReviewResult;
  /**
   * Why `reviewResult` is absent for a `code_review` mode run: the literal
   * string `'missing_review_artifact'` when the worker never wrote
   * `.dispatch-out/review.yaml` at all, or
   * `` `${error}: ${message}` `` (response-header.ts's own
   * `REVIEW_PARSE_FAILED` code + detail) when the file was present but
   * failed to parse. Absent when the mode isn't `code_review` or parsing
   * succeeded. Also threaded into the response doc's `## Structured Review`
   * section (capture.ts) so the failure is diagnosable from the artifact
   * itself, not only from this in-memory result or a `--verbose` log line.
   */
  reviewParseError?: string;
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

  // 2. Admission — full §7 gate (PLN-0004 S4): bad_record, envelope_exceeds_mode,
  // missing/stale_write_scope, missing_read_first, dirty_repo, bad_base_ref,
  // bad_data_mount; resolves base_sha.
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
  let preflightData: PreflightResult | undefined;
  if (opts.preflight !== false) {
    logVerbose(verbose, 'running T27 host preflight (bwrap presence / live unshare-user / AppArmor userns)');
    const preflight = await runPreflight(runDir);
    if (!preflight.ok) return preflight;
    preflightData = preflight.data;
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

  // 4b. Tier resolution + no_isolation_route (T16 S5; spec §7.11/§11). Windows
  // routed into WSL2 is the only tier this pipeline actually probes today
  // (S0-S4 proved it live); tier.ts itself already generalizes to
  // bwrap-direct (native Linux) and pod-attested (WK-0034), but wiring real
  // container/native-Linux probes through is a later slice — those two
  // branches resolve from tier.ts's own conservative "not detected" defaults
  // below until then. `enforced:false` bare-host dispatch is retired (spec
  // §11 D14): if no route resolves, this refuses instead of falling back to
  // an unenforced run.
  const tierProbes: TierProbeInputs = {
    isWindows: process.platform === 'win32',
    wsl2Available: true, // if we got here, preflight ran via WSL2 successfully
    bwrapAvailable: opts.preflight !== false ? (preflightData?.bwrapAvailable ?? false) : true,
    unshareUserWorks: opts.preflight !== false ? (preflightData?.unshareUserWorks ?? false) : true,
    isContainer: false, // container detection is a future tier
    containerAttested: false,
    isNativeLinux: process.platform === 'linux',
  };
  const tierResolution = resolveTier(tierProbes);
  // S6a: redteam fail-closed — all modes require a valid isolation tier
  // (spec §7.11 + s6-rulings.md). The v1 agent-name-string check in
  // environment.ts:406-426 is retired; tier resolution is capability-keyed.
  const tierCheck = checkIsolationRoute(tierResolution);
  if (!tierCheck.ok) return tierCheck;
  const { isolationBackend } = tierCheck.data;

  // 7. Assemble prompt
  logVerbose(verbose, 'assembling worker prompt');
  const assembled = await assemblePrompt(handoff, dir);
  if (!assembled.ok) return assembled;

  // 7b. Context budget gate (§7.13) — runs post-assembly (not in admission.ts)
  // because it needs the real measured size; refuse with the measured size
  // rather than truncating silently.
  if (assembled.data.tokenEstimate > model.contextWindow) {
    return fail(
      'CONTEXT_BUDGET_EXCEEDED',
      `Assembled prompt for handoff ${handoff.id} is an estimated ${assembled.data.tokenEstimate} tokens, exceeding model "${opts.model}" on backend "${opts.backend}"'s context window of ${model.contextWindow} tokens.`,
      { tokenEstimate: assembled.data.tokenEstimate, contextWindow: model.contextWindow },
    );
  }

  // 8. Write prompt to run dir
  const promptPath = join(runDir, 'prompt.txt');
  try {
    await writeFile(promptPath, assembled.data.text, 'utf8');
  } catch (err) {
    return fail('PIPELINE_FAILED', `Failed to write prompt file: ${promptPath}`, err);
  }

  // 8b. Wiki shape probe (T25/D19 dual-shape read axis) — before the clone is
  // created, probe whether wiki/ is git-tracked in the MOTHER repo (a fresh
  // clone at the same lineage carries the identical tracked-file set, so this
  // need not wait for the clone to exist). Best-effort: a failed probe
  // degrades to the fail-safe 'nested-private' default (no wiki bind at all)
  // rather than refusing the whole dispatch over a soft probe.
  const wikiProbeResult = await execViaWsl2({
    runDir,
    scriptContent: [
      '#!/bin/bash',
      `cd ${shQuote(windowsToWslPath(dir))}`,
      'git ls-files wiki/ 2>/dev/null',
    ].join('\n'),
    scriptName: 'wiki-probe.sh',
    timeoutMs: 30_000,
  });
  const wikiShape: WikiShape = wikiProbeResult.ok
    ? classifyWikiShape(wikiProbeResult.data.stdout)
    : 'nested-private'; // fail-safe: assume no wiki in clone

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
    // 9b. Pre-create skeleton dirs for write_scope sparse binds — bwrap
    // cannot mkdir a new path under a ro-bound root (jail.ts's own module
    // doc), so every write_scope path must already exist on disk before
    // buildJailArgs's bind list is handed to bwrap.
    if (handoff.write_scope.length > 0) {
      const mkdirScript = [
        '#!/bin/bash',
        ...handoff.write_scope
          .map((rel) => {
            const trimmed = rel.replace(/^\/+/, '').replace(/\/+$/, '');
            if (!trimmed) return '';
            return `mkdir -p ${shQuote(`${clonePath}/${trimmed}`)}`;
          })
          .filter(Boolean),
      ].join('\n');
      const mkdirResult = await execViaWsl2({ runDir, scriptContent: mkdirScript, scriptName: 'mkdir-scope.sh', timeoutMs: 30_000 });
      if (!mkdirResult.ok) return mkdirResult;
    }

    // 9c. Pre-create .dispatch-out/ — dispatch-owned worker-output dir
    // (review.yaml is code_review's deliverable; DEC-0010 retired the
    // outcome.yaml self-report channel — no other mode writes here). Same
    // bwrap constraint as the write_scope skeleton dirs above: the path must already exist on
    // disk before jail.ts's unconditional .dispatch-out bind is handed to
    // bwrap. Unconditional across every mode, not gated by write_scope —
    // code_review declares write_scope: [] (its envelope grants no write
    // authority at all) but still needs somewhere to write its verdict.
    const dispatchOutMkdirResult = await execViaWsl2({
      runDir,
      scriptContent: ['#!/bin/bash', `mkdir -p ${shQuote(`${clonePath}/.dispatch-out`)}`].join('\n'),
      scriptName: 'mkdir-dispatch-out.sh',
      timeoutMs: 30_000,
    });
    if (!dispatchOutMkdirResult.ok) return dispatchOutMkdirResult;

    // 10. Build Pi invocation. workerDir (PI_CODING_AGENT_DIR) is a path
    // INSIDE THE JAIL, not under clonePath: jail.ts's S5 recipe mounts a
    // fresh --tmpfs /tmp (step 4 of the §11 recipe) that is always writable
    // regardless of write_scope, unlike the rest of the ro-bound clone. A
    // clone-relative path here (the old S0 shape) would put Pi's config dir
    // outside write_scope and hit EROFS the moment Pi tries to write
    // auth.json/models.json, since S5 made the clone read-only except for
    // declared write_scope paths. buildExecutionScript below writes the
    // mkdir + the models.json heredoc INSIDE the bwrap invocation for the
    // same reason this path is chosen here: the tmpfs does not exist until
    // bwrap itself mounts it, so nothing pre-jail can see or populate it.
    const workerDir = '/tmp/.pi-agent';
    const promptPathWsl = windowsToWslPath(promptPath);
    const runDirWsl = windowsToWslPath(runDir);

    // S5 T26: the worker's own baseUrl now points at the in-jail relay
    // loopback — the forwarder (started pre-jail, outside bwrap) is the only
    // process that actually reaches the real endpoint; the worker itself runs
    // under --unshare-net and can reach nothing but 127.0.0.1. This retires
    // the {{WIN_HOST}} template from models.json entirely; WIN_HOST is still
    // resolved below, but only to feed the tunnel's own targetUrl.
    // S6a fix (gate-2 bug, 2026-09-13): the loopback origin alone is not
    // enough — buildPiBaseUrl preserves model.baseUrl's own path (`/v1` for
    // Ollama, `/api/v1` for OpenRouter, per init-dispatch.ts's backends.json
    // README) so Pi's relative-to-baseUrl requests still land on the right
    // route once the forwarder puts the real host back.
    const piBaseUrl = buildPiBaseUrl(model.baseUrl);
    // adapters/pi.ts still expects the legacy ModelEntry shape; build one from the
    // resolved two-table model (S3 ruling 1) rather than widening the adapter's
    // facts-only interface (D10) for a single-slice-old type.
    const piModelEntry: ModelEntry = {
      provider: model.backend,
      modelId: model.modelId,
      displayName: `${model.slug} (${model.backend})`,
      baseUrl: piBaseUrl,
      api: 'openai-completions',
      apiKeyEnv: model.apiKeyEnv,
      contextWindow: 131072,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const invocation = buildInvocation(promptPathWsl, piModelEntry, clonePath, workerDir);

    // 10b. Resolve the tunnel's real target endpoint (T26/D21). This runs as
    // its OWN early WSL2 round trip rather than an inline `WIN_HOST=$(...)`
    // bash line inside the execution script: tunnel.ts's buildTunnelBashLines
    // deliberately single-quotes `targetUrl` when embedding it into the
    // forwarder's argv (shQuote), so a bash variable reference baked into
    // that string would reach the forwarder as the literal, unexpanded text
    // "$WIN_HOST" rather than an expanded address. Resolving it here in JS,
    // before the tunnel config is built, sidesteps that entirely — by the
    // time `tunnelConfig.targetUrl` exists it is already a concrete URL.
    //
    // bwrap-wsl2 ONLY (S6a fix): the forwarder (tunnel.ts) runs OUTSIDE
    // bwrap but still INSIDE WSL2, so a loopback hostname in `model.baseUrl`
    // — `localhost`/`127.0.0.1`/`0.0.0.0`, the shape the S3 two-table
    // config's own README documents for an Ollama `backends.json` entry
    // (init-dispatch.ts), not just the legacy `{{WIN_HOST}}` template —
    // would have the forwarder dial WSL2's OWN loopback and never reach the
    // Windows host where Ollama actually listens (the live S6a gate-1 bug,
    // 2026-09-13). On `bwrap-direct` (native Linux, e.g. EC2) the forwarder
    // and the backend run on the SAME host, so a loopback hostname is
    // already correct there and must be left untouched — resolving it would
    // break a working same-host deployment. Skipped entirely for a real
    // remote host (e.g. OpenRouter's HTTPS endpoint) to avoid a pointless
    // round trip. See `needsWinHostResolution`/`applyWinHost` below.
    let resolvedTargetUrl = model.baseUrl;
    if (needsWinHostResolution(model.baseUrl, tierResolution.tier)) {
      const winHostResult = await execViaWsl2({
        runDir,
        scriptContent: ['#!/bin/bash', `echo "WIN_HOST=$(${resolveWinHostIp()})"`].join('\n'),
        scriptName: 'win-host-resolve.sh',
        timeoutMs: 30_000,
      });
      if (!winHostResult.ok) return winHostResult;
      const winHostMatch = winHostResult.data.stdout.match(/WIN_HOST=(\S+)/);
      if (!winHostMatch) {
        return fail(
          'PIPELINE_FAILED',
          'Failed to resolve WIN_HOST from inside WSL2 (needed to build the tunnel target URL).',
          winHostResult.data,
        );
      }
      resolvedTargetUrl = applyWinHost(model.baseUrl, winHostMatch[1]!);
    }

    // 11. Tunnel config (T26/D21) — the socket/relay/log all live under the
    // run dir on ext4 (never inside the clone: they are dispatch
    // infrastructure, not worker output, and must never appear in
    // enumerate/delivery). web:true widens the forwarder's own destination
    // policy (s5-rulings.md ruling 4) — the flag itself is the grant.
    // Socket MUST be on ext4 — DrvFS (/mnt/c/...) returns ENOTSUP on AF_UNIX.
    // clonePath is always ext4 (~/.kb-dispatch/clones/RUN-xxx/).
    const tunnelSocketWsl = `${clonePath}/${TUNNEL_SOCKET_NAME}`;
    const relayScriptWsl = `${runDirWsl}/relay.js`;
    const tunnelConfig: TunnelConfig = {
      socketPath: tunnelSocketWsl,
      targetUrl: resolvedTargetUrl,
      webEnabled: handoff.web,
      relayPort: TUNNEL_RELAY_PORT,
      logPath: `${runDirWsl}/tunnel-destinations.log`,
    };
    const tunnelBash = buildTunnelBashLines(tunnelConfig, runDirWsl);

    // Mother wiki path for the nested-private + redteam/research bind (T25/D19).
    const motherWikiWsl = windowsToWslPath(join(dir, 'wiki'));

    // 12. Build full jail args (T15/T25/T26 full §11 recipe). data_mounts
    // needs a format bridge here: admission.ts validates the spec-canonical
    // SUFFIX shape (`<windows-absolute-path>:ro`/`:rw` — spec §6, mirrored by
    // admission.ts's own `mountPathOf`), but jail.ts's `parseDataMount`
    // expects the PREFIX shape (`ro:<path>`/`rw:<path>`) with a path already
    // usable as a bwrap bind target (i.e. WSL2-side, not a Windows path).
    // jail.ts cannot fail (`parseDataMount` silently drops anything it
    // doesn't recognize), so passing admission-validated entries through
    // unconverted would make every declared data mount a silent no-op —
    // validated at admission, then never actually bound. toJailDataMount
    // bridges both gaps in one step: strip the suffix, convert the bare
    // Windows path to its `/mnt/<drive>/...` WSL2 equivalent, reassemble as
    // the prefix form jail.ts parses.
    const jailArgs = buildJailArgs({
      clonePath,
      writeScope: handoff.write_scope,
      wikiShape,
      mode: handoff.mode,
      motherWikiPath: motherWikiWsl,
      dataMounts: handoff.data_mounts.map(toJailDataMount),
      unshareNet: true,
      tunnelSocketPath: tunnelSocketWsl,
      relayScriptPath: relayScriptWsl,
    });

    // Selective credential injection (S3 ruling 2 / freeze correction: SCRIPT-SIDE,
    // Linux-only — secret values are read from their named files IN-SHELL and never
    // exist in Windows process memory or in this script's own text). Retires the
    // blanket `set -a; . secrets.env; set +a` block: only the resolved backend's
    // api_key_env plus granted profiles' inject vars reach the worker.
    const injectionScript = buildInjectionScript(credResult.data, handoff.vars);
    // Backend fingerprint (S3 ruling 8) — best-effort, facts-only, never gating.
    const fingerprintLines = buildFingerprintFragment({ ...model, baseUrl: resolvedTargetUrl });

    // 13. Build the full execution script (T26 tunnel splice + lockfile-gated
    // dependency provisioning — see buildExecutionScript's own doc for the
    // exact section order and why the bwrap invocation now wraps a `bash -c`
    // inner script instead of a bare worker command).
    const executionScript = buildExecutionScript({
      injectionScript,
      workerDir,
      modelsJsonContent: invocation.modelsJsonContent,
      fingerprintLines,
      runDirWsl,
      clonePath,
      jailArgv: jailArgs.argv,
      workerCmd: invocation.cmd,
      workerArgs: invocation.args,
      tunnelBash,
      workerTimeoutSecs: WORKER_TIMEOUT_SECS,
    });

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

    // 16. Enumerate changes / advisory delivery branch (S6a T30,
    // execution/s6-rulings.md gate item: "advisory-mode file mutations
    // discarded with a warning"). Only `implement` mode lands a
    // scope-checked commit; code_review/redteam/research are advisory —
    // their §6 envelope grants no write authority at all (their
    // assemble.ts framings each instruct "do not modify any files"), and
    // the worker's own findings/review ARE the deliverable, captured below
    // as the response doc rather than a git delta. The worker's own
    // `.pi-agent/` config dir lives under the jail's /tmp tmpfs (never under
    // clonePath any more), so it never appears in either branch's
    // enumeration below — no infra-prefix filtering is needed here (formerly
    // WK-0075's fix, now moot since the directory never touches the clone).
    let delivery: DeliveryOutcome;

    if (handoff.mode === 'implement') {
      // The injected-value scan fragment (S3 ruling 2 / s3-rulings.md freeze
      // correction — replaces the removed pattern-based scanSecrets() leg)
      // is spliced onto the END of this SAME script: it reuses the
      // enumerate script's own `$GIT`/`$CLONE_PATH` shell scope to re-diff
      // into a throwaway `$DIFF_FILE` and grep it for each granted
      // credential's literal value, entirely WSL2-side (one exec round
      // trip, no diff content ever written to Windows disk for this check).
      // Only var NAMES (`SECRET_HIT=<VAR_NAME>`) cross back into this
      // stdout — the resolved values themselves never reach Windows process
      // memory or this script's own text. Every injection scanned here
      // already passed the execution script's existenceCheckLines earlier
      // in this same run (step 13/14), so the grep is guaranteed to find a
      // value under `set -e`.
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
      const allChangedFiles = [...enumerated.changedFiles, ...enumerated.untrackedFiles];
      // .dispatch-out/ is dispatch-owned infrastructure (review.yaml is
      // code_review's deliverable), already excluded from the delivery
      // commit via excludePrefixes — exclude from the write_scope check too,
      // so it never triggers refused_out_of_scope.
      const deliverableFiles = allChangedFiles.filter(f => !f.startsWith('.dispatch-out/') && !f.startsWith('.dispatch-out\\'));

      // 17. Check write scope, check the injected-value scan hits captured
      // above — refusals are DATA (a DeliveryOutcome variant), not a
      // DispatchResult failure; the pipeline ran correctly. (S3: the
      // deterministic injected-value scan replaces the removed
      // pattern-based scanSecrets() leg — it checks only the exact values
      // the worker was granted, not heuristic patterns, so it is fully
      // deterministic.)
      const scopeCheck = checkWriteScope(deliverableFiles, handoff.write_scope);

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
        // 18. Deliver (clean: land the scope-checked commit). .dispatch-out/
        // (S6a W4) is dispatch's own worker-output dir, not the worker's
        // deliverable — excluded from the commit the same way WK-0075
        // excluded the old .pi-agent/ infra dir (the mechanism outlives that
        // specific caller; see delivery.ts's own module doc).
        logVerbose(verbose, 'delivering scope-checked commit');
        const deliveryScript = buildDeliveryScript({
          clonePath,
          motherRepoWsl: windowsToWslPath(dir),
          handoffId: handoff.id,
          baseSha: admission.data.baseSha,
          excludePrefixes: ['.dispatch-out'],
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
    } else {
      // Advisory path (code_review/redteam/research; spec §8: "response
      // only, mutations discarded with a warning"). These three modes never
      // land a commit, so there is no write-scope/secret-scan gate to run —
      // the enumerate below is best-effort DETECTION only, never a gate:
      // the ephemeral clone is torn down in `finally` regardless, so a
      // mutation an advisory worker made anyway never reaches the mother
      // repo either way. A failed probe (WSL2 exec error or non-zero exit)
      // never blocks capture — the response doc is this mode's real
      // deliverable and does not depend on this check.
      logVerbose(verbose, `mode ${handoff.mode} is advisory — skipping delivery, checking for stray mutations`);
      const advisoryEnumerateScript = buildEnumerateScript(clonePath);
      const advisoryEnumerateExec = await execViaWsl2({
        runDir,
        scriptContent: advisoryEnumerateScript.scriptContent,
        scriptName: advisoryEnumerateScript.scriptName,
        timeoutMs: 120_000,
      });
      if (advisoryEnumerateExec.ok && advisoryEnumerateExec.data.exitCode === 0) {
        const enumResult = parseEnumerateOutput(advisoryEnumerateExec.data.stdout);
        const mutatedFiles = [...enumResult.changedFiles, ...enumResult.untrackedFiles];
        if (mutatedFiles.length > 0) {
          logVerbose(
            verbose,
            `warning: advisory-mode worker (${handoff.mode}) modified ${mutatedFiles.length} file(s) — mutations discarded: ${mutatedFiles.join(', ')}`,
          );
        }
      }
      delivery = { status: 'no_changes' };
    }

    // 19b. Structured review verdict (S6a ruling 3, re-platformed onto a
    // file artifact at S6a W4) — code_review mode only. The verdict is a
    // FILE the worker writes (`.dispatch-out/review.yaml`,
    // assemble.ts's CODE_REVIEW_RESPONSE_FORMAT), never parsed from chat
    // prose — this retires the original silent-failure bug class entirely
    // (an agentic reviewer narrating before its verdict could push a
    // delimited header past a fixed scan window; a `---` horizontal rule in
    // the narration could collide with the real delimiter). Read here,
    // BEFORE clone teardown in this function's `finally`. A read failure
    // (missing file, or WSL2 exec trouble reading it) is folded into
    // "absent" — this is never a pipeline-level failure either way;
    // `reviewResult` simply stays absent and `reviewParseError` carries why,
    // non-silently, into capture below (`## Structured Review`).
    let reviewResult: StructuredReviewResult | undefined;
    let reviewParseError: string | undefined;
    if (handoff.mode === 'code_review') {
      logVerbose(verbose, 'reading .dispatch-out/review.yaml from the clone');
      const reviewFileScript = buildReviewFileReadScript(clonePath);
      const reviewFileExec = await execViaWsl2({
        runDir,
        scriptContent: reviewFileScript.scriptContent,
        scriptName: reviewFileScript.scriptName,
        timeoutMs: 30_000,
      });
      const readResult = reviewFileExec.ok
        ? parseReviewFileReadOutput(reviewFileExec.data.stdout)
        : { present: false, content: '' };
      const outcome = resolveReviewFileOutcome(readResult);
      reviewResult = outcome.reviewResult;
      reviewParseError = outcome.reviewParseError;
      if (reviewParseError) {
        logVerbose(verbose, `warning: review file parse failed: ${reviewParseError}`);
      }

      // Copy the raw artifact into the run dir for forensics (S6a W4),
      // alongside pi-output.log/state.json — the clone gets deleted in this
      // function's `finally`; the run dir persists. Copied whenever present,
      // even if it failed to parse, since it's still evidence of what the
      // worker wrote.
      if (readResult.present) {
        try {
          await writeFile(join(runDir, 'review.yaml'), readResult.content, 'utf8');
        } catch (err) {
          logVerbose(verbose, `warning: could not copy review.yaml to run dir: ${err}`);
        }
      }
    }

    // 20. Capture
    const captureResult = await writeResponseDoc({
      runDir,
      handoff: { id: handoff.id, title: handoff.title, mode: handoff.mode },
      delivery,
      piResult: { outcome: piParsed.data.outcome, usage: piParsed.data.usage },
      model: canonicalModel,
      isolationBackend,
      lastAssistantText: piParsed.data.lastAssistantText,
      credentialsGranted: credResult.data.granted,
      reviewResult,
      reviewParseError,
      // Resolved-value provenance (S3 ruling 8): the real endpoint the tunnel
      // forwarder was configured to reach — never `model.baseUrl`'s raw
      // {{WIN_HOST}} template, which the old models.json-only sed substitution
      // never actually resolved at the JS level (WK gap fixed incidentally
      // here since S5 already resolves this value for the tunnel config).
      baseUrl: resolvedTargetUrl,
      backend: model.backend,
      piVersion,
      backendFingerprint: fingerprint ?? undefined,
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
      isolationBackend,
      credentialsGranted: credResult.data.granted,
      // Resolved-value provenance (S3 ruling 8): the real endpoint the tunnel
      // forwarder was configured to reach — never `model.baseUrl`'s raw
      // {{WIN_HOST}} template, which the old models.json-only sed substitution
      // never actually resolved at the JS level (WK gap fixed incidentally
      // here since S5 already resolves this value for the tunnel config).
      baseUrl: resolvedTargetUrl,
      backend: model.backend,
      piVersion,
      backendFingerprint: fingerprint ?? undefined,
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
      reviewResult,
      reviewParseError,
    });
  } finally {
    // 21. Remove clone — best-effort; clone.ts's 24h orphan sweep is the
    // safety net if this itself fails to run (never rejects, but belt+suspenders).
    await removeClone(clonePath, runDir).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// S6a fix: Pi baseUrl path preservation (gate-2 bug, 2026-09-13). Not part of
// the package's public surface — exported at module scope only so tests can
// assert on it directly (mirrors `needsWinHostResolution`/`applyWinHost`
// below), without needing a live WSL2/bwrap host to drive `runDispatch()`
// all the way to step 10.
// ---------------------------------------------------------------------------

/**
 * Builds the in-jail loopback baseUrl Pi's own model entry points at
 * (`http://127.0.0.1:<TUNNEL_RELAY_PORT>`), preserving the path component of
 * the operator's configured `model.baseUrl` (e.g. `/v1` for an Ollama
 * `backends.json` entry, `/api/v1` for OpenRouter — see init-dispatch.ts's
 * own README for both shapes). Pi constructs API requests relative to
 * baseUrl, so a bare loopback origin with no path would send requests to
 * `/chat/completions` instead of the operator's real route — 404 from
 * Ollama, errors from OpenRouter. A trailing slash on the original path is
 * stripped so the rebuilt URL never double-slashes.
 */
export function buildPiBaseUrl(baseUrl: string): string {
  const originalPath = new URL(baseUrl).pathname.replace(/\/$/, '');
  return `http://127.0.0.1:${TUNNEL_RELAY_PORT}${originalPath}`;
}

// ---------------------------------------------------------------------------
// S6a fix: forwarder target WIN_HOST resolution, bwrap-wsl2 ONLY. Not part of
// the package's public surface — exported at module scope only so tests can
// assert on them directly (mirrors `toJailDataMount` below), without needing
// a live WSL2/bwrap host to drive `runDispatch()` all the way to step 10b.
// ---------------------------------------------------------------------------

/**
 * Loopback hostnames a `backends.json` `base_url` may legitimately carry for
 * a same-host model server (init-dispatch.ts's own README example uses
 * `http://localhost:11434/v1`). `0.0.0.0` is included defensively: it is a
 * BIND address on the server side, but a client dialing it lands on the same
 * local network stack as `localhost`/`127.0.0.1`, so it has the identical
 * bwrap-wsl2 failure mode if it ever appears as a target host.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

/**
 * Whether `baseUrl` needs its host rewritten to the Windows host's real IP
 * before it can serve as the tunnel forwarder's target (T26/D21). True only
 * on `bwrap-wsl2` — see the "10b" comment in `runDispatch` above for why
 * `bwrap-direct`/`pod-attested`/no-route (`tier === null`) must never rewrite
 * a loopback host: on those tiers the forwarder and the backend already
 * share the same host. Recognizes both the legacy `{{WIN_HOST}}` template
 * (the deprecated `getDefaultRegistry` seed above) and a literal loopback
 * hostname (the shape the live S3 two-table config actually produces). An
 * unparseable `baseUrl` degrades to `false` (nothing to safely rewrite)
 * rather than throwing — mirrors `extractHostname`'s tolerance in
 * model-registry.ts.
 */
export function needsWinHostResolution(baseUrl: string, tier: HostTier | null): boolean {
  if (tier !== 'bwrap-wsl2') return false;
  if (baseUrl.includes('{{WIN_HOST}}')) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Rewrite `baseUrl`'s host to `winHostIp`. Two shapes: the legacy
 * `{{WIN_HOST}}` template substitutes via the same regex `runDispatch`
 * always used; a literal loopback hostname is rewritten through the URL's
 * own `.hostname` setter so the port and path survive untouched. Callers
 * gate on `needsWinHostResolution` first — this function does not re-check
 * the tier or re-detect which shape applies beyond that one branch.
 */
export function applyWinHost(baseUrl: string, winHostIp: string): string {
  if (baseUrl.includes('{{WIN_HOST}}')) {
    return baseUrl.replace(/\{\{WIN_HOST\}\}/g, winHostIp);
  }
  const rewritten = new URL(baseUrl);
  rewritten.hostname = winHostIp;
  return rewritten.toString();
}

// ---------------------------------------------------------------------------
// S5 T26 (W2): data_mounts format bridge. Not part of the package's public
// surface — module-scope only, same convention as the other pipeline-private
// helpers below.
// ---------------------------------------------------------------------------

/**
 * Bridge admission.ts's spec-canonical `data_mounts` shape (§6:
 * `<absolute-path>:ro` / `<absolute-path>:rw`, SUFFIX form — see admission.ts's
 * own `mountPathOf`) into the shape jail.ts's `parseDataMount`/`buildJailArgs`
 * expect (`ro:<path>` / `rw:<path>`, PREFIX form, path already usable as a
 * bwrap bind target). Also converts the admission-validated WINDOWS absolute
 * path to its `/mnt/<drive>/...` WSL2 equivalent in the same step — bwrap runs
 * inside WSL2 and cannot bind a Windows-style path at all.
 *
 * jail.ts is deliberately "cannot fail" (`parseDataMount` returns null and
 * `buildJailArgs` silently skips anything it doesn't recognize), so leaving
 * this conversion undone would not error — it would just make every declared
 * data mount a silent no-op: validated at admission, then never actually
 * bound into the jail. An entry with no recognizable `:ro`/`:rw` suffix
 * (already tolerated leniently by admission's own `mountPathOf`) is returned
 * unchanged and is silently dropped downstream by `parseDataMount`, the same
 * as any other entry jail.ts doesn't recognize.
 *
 * Exported at module scope only so tests can assert on it directly (mirrors
 * `mergeProvenanceFrontmatter` below) — not part of the package's public
 * surface (src/index.ts does not re-export it).
 */
export function toJailDataMount(entry: string): string {
  const match = /^(.*):(ro|rw)$/.exec(entry);
  if (!match) return entry;
  const [, hostPath, access] = match;
  return `${access}:${windowsToWslPath(hostPath!)}`;
}

// ---------------------------------------------------------------------------
// S5 T26 (W2): full execution script assembly. Not part of the package's
// public surface — exported at module scope only so tests can assert on its
// string content directly (mirrors `mergeProvenanceFrontmatter` below), the
// intended way to cover the S5 wiring (tunnel splice, lockfile-gated
// dependency provisioning, unshare-net) without a live WSL2/bwrap host.
// ---------------------------------------------------------------------------

export interface BuildExecutionScriptOpts {
  /** Script-side selective credential injection fragments (S3 ruling 2). */
  injectionScript: InjectionScriptLines;
  /** PI_CODING_AGENT_DIR — nested inside clonePath (S0 bwrap constraint). */
  workerDir: string;
  /** Already-resolved models.json body — baseUrl is already concrete (the in-jail loopback), no {{WIN_HOST}} left to substitute. */
  modelsJsonContent: string;
  /** Backend fingerprint probe lines (S3 ruling 8). */
  fingerprintLines: string[];
  /** WSL2 path to the run dir — PI_LOG and the tunnel's scripts/socket/log all live here. */
  runDirWsl: string;
  /** WSL2 path to the ephemeral clone — the lockfile-gated npm ci/rebuild target. */
  clonePath: string;
  /** The bwrap argv from `buildJailArgs` (caller appends the worker invocation after it). */
  jailArgv: string[];
  /** Worker command (e.g. 'pi'). */
  workerCmd: string;
  /** Worker argv (e.g. ['-p', '--mode', 'json', ...]). */
  workerArgs: string[];
  /** Tunnel bash line groups from `buildTunnelBashLines` (T26/D21). */
  tunnelBash: TunnelBashLines;
  /** Worker watchdog timeout, in seconds. */
  workerTimeoutSecs: number;
}

/**
 * Build the full worker execution script text (S5 T26 integration). Pure and
 * synchronous — assembles the exact bash script `runDispatch()` hands to
 * `execViaWsl2` from already-resolved inputs only (no I/O, no WSL2/bwrap
 * access of its own).
 *
 * Section order:
 *   1. shebang / `set -euo pipefail` / PATH export (non-interactive shells skip .bashrc)
 *   2. selective credential injection (S3 ruling 2): existence checks, then exports
 *   3. PI_CODING_AGENT_DIR/PI_OFFLINE exports only — plain env vars, inherited
 *      by the bwrap child automatically (bwrap does not clear the environment
 *      unless told to). The mkdir + models.json heredoc used to live here too,
 *      but S5's jail rewrite mounts workerDir's parent (`/tmp`) as a FRESH
 *      tmpfs INSIDE the jail (jail.ts step 4) — anything written to that path
 *      before bwrap runs lands on the host/pre-jail `/tmp` and is invisible to
 *      the sandboxed process once bwrap mounts over it. Both moved to step 7,
 *      inside the inner script, for exactly this reason.
 *   4. backend fingerprint probe (S3 ruling 8, best-effort, never gating)
 *   5. tunnel preJailLines (T26/D21): stage forwarder.js/relay.js, start the
 *      host-side forwarder, export HTTP_PROXY/HTTPS_PROXY for the worker's own
 *      bash tools
 *   6. lockfile-gated PRE-bwrap `npm ci --ignore-scripts` (s5-rulings.md ruling
 *      2; Linux-side, same platform as the jail — never Windows-side, which
 *      would fetch the wrong platform binaries)
 *   7. the bwrap invocation itself, now wrapping a `bash -c` inner script
 *      (rather than a bare worker command) so the in-jail relay can start/stop
 *      around the worker: inJailPrefix (bring up lo, start the relay, `npm
 *      rebuild` under containment when a lockfile is present) -> mkdir -p
 *      "$PI_CODING_AGENT_DIR" + the models.json heredoc (moved in here from
 *      step 3 above — PI_CODING_AGENT_DIR resolves to workerDir, i.e.
 *      `/tmp/.pi-agent`, which only exists once bwrap's own tmpfs is mounted)
 *      -> a defensive `mkdir -p .dispatch-out` (S6a W4 — belt-and-suspenders;
 *      pipeline.ts step 9c already pre-creates this pre-jail, jail.ts binds it
 *      onto itself the same way it binds write_scope paths) -> the worker
 *      command -> capture its exit code -> inJailSuffix (kill the relay) ->
 *      re-exit with that captured code, so a `timeout`-imposed 124 (or any
 *      other real worker exit code) still reaches the caller unchanged
 *      through the extra shell layer
 *   8. capture the outer bwrap/timeout pipeline's own exit code (guarded by an
 *      if/else rather than a bare `$?` — under `set -e`+`pipefail`, a bare
 *      `$?` capture on the line right after a failing pipeline never runs,
 *      since the shell would already have aborted) and tear down the
 *      host-side forwarder (tunnel postJailLines) UNCONDITIONALLY before the
 *      script exits — nothing else ever reaps that process, since it runs
 *      outside bwrap and `--die-with-parent` does not reach it
 */
export function buildExecutionScript(opts: BuildExecutionScriptOpts): string {
  const {
    injectionScript,
    workerDir,
    modelsJsonContent,
    fingerprintLines,
    runDirWsl,
    clonePath,
    jailArgv,
    workerCmd,
    workerArgs,
    tunnelBash,
    workerTimeoutSecs,
  } = opts;

  const lockfilePath = `${clonePath}/package-lock.json`;

  // Runs INSIDE bwrap via `bash -c` — built as one atomic shQuote'd argv
  // element below, so any single quotes tunnel.ts's own lines embed (e.g.
  // `node '<path>' '<arg>' ...`) are escaped exactly once, at the outermost
  // layer, and survive intact.
  const innerScriptLines = [
    ...tunnelBash.inJailPrefix,
    // PI_CODING_AGENT_DIR setup (mkdir + models.json) MUST run in here, not
    // pre-jail: workerDir is `/tmp/.pi-agent`, and bwrap mounts a brand-new
    // empty tmpfs at /tmp (jail.ts step 4) — that mount does not exist until
    // bwrap itself starts, so anything written to it beforehand is invisible
    // to the sandboxed process. PI_CODING_AGENT_DIR itself is already an
    // exported env var by this point (inherited from the pre-jail section).
    'mkdir -p "$PI_CODING_AGENT_DIR"',
    `cat <<'DISPATCH_MODELS_JSON_EOF' > "$PI_CODING_AGENT_DIR/models.json"`,
    modelsJsonContent,
    'DISPATCH_MODELS_JSON_EOF',
    // S6a W4: defensive in-jail mkdir for .dispatch-out/ (review.yaml is
    // code_review's deliverable; DEC-0010 retired outcome.yaml) —
    // belt-and-suspenders in case the pre-jail mkdir (pipeline.ts step 9c)
    // doesn't persist through the self-bind; a no-op when it already does.
    // Relative to cwd (bwrap's --chdir is always the clone root here), so
    // this targets "<clonePath>/.dispatch-out" regardless of mode.
    'mkdir -p .dispatch-out',
    `if [ -f ${shQuote(lockfilePath)} ]; then`,
    `  cd ${shQuote(clonePath)} && npm rebuild 2>&1 && cd - > /dev/null || true`,
    'fi',
    [workerCmd, ...workerArgs].map(shQuote).join(' '),
    'EXIT_CODE=$?',
    ...tunnelBash.inJailSuffix,
    'exit $EXIT_CODE',
  ].join('\n');

  const bwrapCommand = [...jailArgv, 'bash', '-c', innerScriptLines].map(shQuote).join(' ');

  return [
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
    '',
    ...fingerprintLines,
    '',
    ...tunnelBash.preJailLines,
    '',
    `PI_LOG=${shQuote(`${runDirWsl}/pi-output.log`)}`,
    `WORKER_TIMEOUT_SECS=${workerTimeoutSecs}`,
    '',
    '# Lockfile-gated dependency provisioning (s5-rulings.md ruling 2): npm ci',
    '# --ignore-scripts PRE-bwrap on the Linux side (same platform as the jail —',
    '# never Windows-side, wrong platform binaries); lifecycle scripts stay',
    '# disabled here and run instead under containment (see the `npm rebuild`',
    '# line inside the bwrap inner script above/below). No lockfile -> no',
    '# provisioning step at all.',
    `if [ -f ${shQuote(lockfilePath)} ]; then`,
    `  cd ${shQuote(clonePath)}`,
    '  npm ci --ignore-scripts 2>&1 || true',
    '  cd -',
    'fi',
    '',
    `if timeout --signal=TERM --kill-after=30s "$WORKER_TIMEOUT_SECS" ${bwrapCommand} < /dev/null 2>&1 | tee "$PI_LOG"; then`,
    '  DISPATCH_EXIT_CODE=0',
    'else',
    '  DISPATCH_EXIT_CODE=$?',
    'fi',
    '',
    ...tunnelBash.postJailLines,
    '',
    'exit "$DISPATCH_EXIT_CODE"',
    '',
  ].join('\n');
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

// ---------------------------------------------------------------------------
// S6a W4: `.dispatch-out/review.yaml` read (the review verdict is a FILE the
// worker writes, never parsed from chat prose — see response-header.ts's
// module doc and assemble.ts's CODE_REVIEW_RESPONSE_FORMAT). `clonePath` is a
// WSL2-only path (the ext4 clone root), never reachable through Node's own
// `fs` from the Windows-side pipeline process, so — same as
// buildEnumerateScript/parseEnumerateOutput in delivery.ts — this is a pure
// script-builder + a pure stdout-parser either side of the one
// `execViaWsl2` round trip `runDispatch` performs. Exported at module scope
// only so tests can assert on each half directly (mirrors
// `mergeProvenanceFrontmatter` above) — not part of the package's public
// surface (src/index.ts does not re-export them).
// ---------------------------------------------------------------------------

export interface ReviewFileScript {
  scriptContent: string;
  scriptName: string;
}

export interface ReviewFileReadResult {
  /** Whether `.dispatch-out/review.yaml` existed in the clone at read time. */
  present: boolean;
  /** Raw file content — '' when absent, or when present but genuinely empty. */
  content: string;
}

/**
 * Build the read-only WSL2 script that reports whether
 * `<clonePath>/.dispatch-out/review.yaml` exists and, if so, its raw
 * content. Presence is reported via an explicit marker line rather than
 * inferred from whether any text rode between the content markers, so a
 * legitimately empty (0-byte) review.yaml still reports PRESENT (with empty
 * content) rather than being confused with ABSENT. Never mutates the clone.
 */
export function buildReviewFileReadScript(clonePath: string): ReviewFileScript {
  const reviewPath = `${clonePath}/.dispatch-out/review.yaml`;
  const scriptContent = [
    '#!/bin/bash',
    'set -euo pipefail',
    `FILE=${shQuote(reviewPath)}`,
    'if [ -f "$FILE" ]; then',
    '  echo "---REVIEW-YAML-PRESENT---"',
    'else',
    '  echo "---REVIEW-YAML-ABSENT---"',
    'fi',
    'echo "---REVIEW-YAML-CONTENT-START---"',
    'cat "$FILE" 2>/dev/null || true',
    'echo "---REVIEW-YAML-CONTENT-END---"',
    '',
  ].join('\n');
  return { scriptContent, scriptName: 'dispatch-review-file-read.sh' };
}

/** Extract the text between two literal marker lines (exclusive), or '' if either is absent (mirrors delivery.ts's private extractSection). */
function extractMarked(text: string, startMarker: string, endMarker: string): string {
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return '';
  return text
    .slice(startIdx + startMarker.length, endIdx)
    .replace(/^\n/, '')
    .replace(/\n$/, '');
}

/** Parse `buildReviewFileReadScript`'s stdout into a `ReviewFileReadResult`. */
export function parseReviewFileReadOutput(stdout: string): ReviewFileReadResult {
  const normalized = stdout.replace(/\r\n/g, '\n');
  const present = normalized.includes('---REVIEW-YAML-PRESENT---');
  const content = extractMarked(normalized, '---REVIEW-YAML-CONTENT-START---', '---REVIEW-YAML-CONTENT-END---');
  return { present, content };
}

/**
 * Map a `ReviewFileReadResult` to the `reviewResult`/`reviewParseError` pair
 * `runDispatch` threads into its own return value and into capture.ts's
 * `## Structured Review` section. Absent file -> the literal
 * `'missing_review_artifact'` (constraint: no fallback that scans prose when
 * the file is missing — missing is failed, loudly, not silently). Present
 * but unparseable -> `` `${error}: ${message}` `` from response-header.ts's
 * own `REVIEW_PARSE_FAILED` result, so the failure is self-describing without
 * needing `--verbose`.
 */
export function resolveReviewFileOutcome(
  read: ReviewFileReadResult,
): { reviewResult?: StructuredReviewResult; reviewParseError?: string } {
  if (!read.present) {
    return { reviewParseError: 'missing_review_artifact' };
  }
  const parsed = parseReviewFile(read.content);
  if (parsed.ok) {
    return { reviewResult: parsed.data };
  }
  return { reviewParseError: `${parsed.error}: ${parsed.message}` };
}

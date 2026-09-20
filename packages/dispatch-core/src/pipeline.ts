/**
 * `runDispatch()` — the v2 dispatch pipeline (dispatch v2, PLN-0004 S0 Wave 3;
 * D6 Phase 2 native-spawn rewrite — mid_project_review_rulings.md ruling 7).
 * Wires the skeleton modules into one atomic, gated call (DEC-0007 D1):
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
 * D6: the orchestrator runs natively on Linux — there is no Windows host and
 * no `wsl.exe` boundary to cross. Non-worker operations (git enumerate/
 * delivery, mkdir, credential/config probes) run via direct `bash -c`
 * (`exec-direct.ts`'s `execBash`) or plain `node:fs`/`node:child_process`
 * calls. The worker itself is jailed via a frozen `BwrapPlan`
 * (`jail.ts`'s `buildBwrapPlan`) spawned directly (`spawn-isolated.ts`'s
 * `spawnIsolated`) — mirrors agent-chassis's direct-spawn architecture
 * (ELv2: design mirrored only, no chassis code copied).
 */
import { spawn } from 'node:child_process';
import { closeSync, constants as fsConstants, existsSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

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
import { buildInvocation as buildCodexInvocation, parseCodexOutput } from './adapters/codex.js';
import { buildInvocation as buildClaudeInvocation, parseClaudeOutput } from './adapters/claude.js';
import { execBash } from './exec-direct.js';
import {
  buildBwrapPlan,
  buildSecretMaskArgs,
  classifyEntry,
  classifyWikiShape,
  deriveDirectoryScopedMounts,
  deriveExactFileMounts,
  type BwrapPlan,
  type WikiShape,
} from './jail.js';
import { spawnIsolated, type SpawnResult } from './spawn-isolated.js';
import { buildWorkerEnv } from './env-policy.js';
import { createClone, removeClone, sweepOrphanClones } from './clone.js';
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
import { loadProfilesConfig, type BackendFamily } from './repo-config.js';
import {
  resolveCredentials,
  checkCredentialPolicy,
  buildInjectedValueScanFragment,
  parseInjectedValueScanOutput,
  type CredentialResolution,
} from './credentials.js';
import {
  buildTunnelScripts,
  TUNNEL_RELAY_PORT,
  TUNNEL_SOCKET_NAME,
  type TunnelConfig,
} from './tunnel.js';
import { probeBwrap, APPARMOR_REMEDIATION_TEXT, MISSING_BWRAP_TEXT } from './tier.js';
import { extractRecoveryBlock, type RecoveryBlockEvidence } from './recovery-block.js';

/**
 * Claude vendor domain set (DEC-0011 ruling 2, WK-0104). Seed from Anthropic's
 * published network-config. Telemetry excluded — CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
 * is set in the worker env instead.
 */
const CLAUDE_VENDOR_HOSTS: readonly string[] = [
  'api.anthropic.com',
  'auth.anthropic.com',
  'console.anthropic.com',
  'claude.ai',
];

/**
 * Codex vendor domain set (DEC-0011 ruling 2, WK-0104). Covers both API-key
 * backend (api.openai.com) and ChatGPT-seat backend (chatgpt.com, auth.openai.com,
 * ab.chatgpt.com). Evidence-gated: refine from the forwarder's denied-destination
 * log on real runs.
 */
const CODEX_VENDOR_HOSTS: readonly string[] = [
  'api.openai.com',
  'auth.openai.com',
  'chatgpt.com',
  'ab.chatgpt.com',
];

const WORKER_TIMEOUT_SECS = 1800;
const WORKER_TIMEOUT_MS = WORKER_TIMEOUT_SECS * 1000;

const VALID_RUN_ID = /^RUN-[0-9a-f-]{36}$/i;

export interface DispatchOpts {
  /** Absolute path to the mother repo */
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
   * Extracted + validated `kb-dispatch-recovery.v1` evidence (D1 ruling 1;
   * mid_project_review_rulings.md) from the worker/reviewer/redteam's
   * terminal fenced output block. Absent for `research` mode (prose-only,
   * never emits the block — ruling 1 item 1). For every other mode this is
   * always populated (a missing/malformed block still yields an evidence
   * envelope with `valid: false` and diagnostics — extraction never
   * throws). V4 note 3 role asymmetry: for `implement` this is diagnostic
   * evidence only and never changes the run's verdict; for
   * `code_review`/`redteam` an invalid/absent block drives the response
   * doc's verdict to `failed` (`missing_review_artifact`) in capture.ts's
   * `deriveVerdict`.
   */
  recoveryEvidence?: RecoveryBlockEvidence;
}

/** Single-quote a value for safe embedding in generated bash (mirrors delivery.ts's private helper). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function logVerbose(verbose: boolean | undefined, message: string): void {
  if (verbose) process.stderr.write(`[dispatch] ${message}\n`);
}

/**
 * Read each granted credential's value directly from its named file (D6
 * component 1). The orchestrator now runs on the same Linux host as the
 * credential files, so no shell `grep`/`cut` indirection is needed the way
 * credentials.ts's `buildInjectionScript`'s bash fragments provided it —
 * that function stays defined and independently unit-tested; this is a
 * parallel, simpler path for this one call site. Fails closed with
 * CREDENTIAL_NOT_CONFIGURED on the first named var missing from its file (or
 * the file itself being unreadable) — the same contract
 * `buildInjectionScript`'s `existenceCheckLines` enforced script-side (S3
 * ruling 3), just enforced here in JS, pre-spawn, instead of shell,
 * pre-worker.
 */
async function resolveCredentialEnv(resolution: CredentialResolution): Promise<DispatchResult<Record<string, string>>> {
  const env: Record<string, string> = {};
  const entries: Array<{ varName: string; filePath: string }> = [
    ...resolution.injections.map((i) => ({ varName: i.varName, filePath: i.filePath })),
    ...(resolution.backendApiKeyEnv && resolution.backendSecretsFile
      ? [{ varName: resolution.backendApiKeyEnv, filePath: resolution.backendSecretsFile }]
      : []),
  ];

  for (const { varName, filePath } of entries) {
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (err) {
      return fail('CREDENTIAL_NOT_CONFIGURED', `Credential variable "${varName}" is not configured (could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}).`);
    }
    const line = content.replace(/\r\n/g, '\n').split('\n').find((l) => l.startsWith(`${varName}=`));
    if (line === undefined) {
      return fail('CREDENTIAL_NOT_CONFIGURED', `Credential variable "${varName}" is not configured (missing from its named source file).`);
    }
    env[varName] = line.slice(varName.length + 1);
  }

  return ok(env);
}

/**
 * Parse "KEY=value" HO `vars` entries into an env object (mirrors
 * credentials.ts's private `parseVarEntry` — kept local rather than exported
 * across the module boundary for this one small parse). Malformed entries
 * (no `=`, leading `=`) are dropped, matching credentials.ts's own tolerance;
 * the vars-vs-credential-var collision policy is already enforced upstream
 * by `checkCredentialPolicy` before this is ever called.
 */
function parseHandoffVarsEnv(vars: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of vars) {
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    env[entry.substring(0, idx)] = entry.substring(idx + 1);
  }
  return env;
}

/**
 * Bridge admission.ts's spec-canonical `data_mounts` shape (§6:
 * `<absolute-path>:ro` / `<absolute-path>:rw`, SUFFIX form — see admission.ts's
 * own `mountPathOf`) into the shape jail.ts's `parseDataMount`/`buildBwrapPlan`
 * expect (`ro:<path>` / `rw:<path>`, PREFIX form). D6: paths are native Linux
 * already, so only the format bridge survives from the old `toJailDataMount`
 * — the Windows->WSL2 path conversion it also did no longer applies. An entry
 * with no recognizable `:ro`/`:rw` suffix is returned unchanged and silently
 * dropped downstream by `parseDataMount`, same as any other entry jail.ts
 * doesn't recognize (jail.ts is deliberately "cannot fail").
 */
function toDataMountPrefixForm(entry: string): string {
  const match = /^(.*):(ro|rw)$/.exec(entry);
  if (!match) return entry;
  const [, hostPath, access] = match;
  return `${access}:${hostPath}`;
}

/**
 * Run a child process to completion and collect its output (never throws —
 * a spawn-level error resolves with `code: null`). Used for the pre-jail,
 * non-worker deps-provisioning leg (`npm ci`) — a direct spawn, never
 * bwrap-jailed (D6 component 17).
 */
function spawnAndWait(
  command: string,
  args: string[],
  opts: { cwd?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.once('error', () => resolvePromise({ code: null, stdout, stderr }));
  });
}

/**
 * Per-family write_scope override for the bwrap plan's mount list (D2 ruling
 * 2, PLN-0004
 * `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md:149-201`):
 * Pi's current sparse-bind recipe is unchanged (identity — every entry binds
 * exactly as written); Claude widens file-shaped entries to their parent
 * directory (atomic-rename write pattern needs write+exec on the containing
 * dir, not just the target file); Codex classifies exact files vs
 * directories explicitly (mechanically the same per-entry self-bind
 * `buildBwrapPlan`'s own write_scope loop already applies to any entry —
 * computed here via `deriveExactFileMounts` to mirror agent-chassis's
 * separate Codex code path rather than relying on that coincidence). Returns
 * clone-RELATIVE paths: `buildBwrapPlan`'s own `joinUnderClone` re-resolves
 * relative entries onto `clonePath`, the same contract `handoff.write_scope`
 * itself already satisfies, so this is a drop-in override either way.
 */
export function familyWriteScope(family: BackendFamily, writeScope: string[], clonePath: string): string[] {
  if (family === 'claude') {
    return deriveDirectoryScopedMounts(writeScope, clonePath).map((dir) => relative(clonePath, dir));
  }
  if (family === 'codex') {
    const { writableDirs, writableFiles } = deriveExactFileMounts(writeScope, clonePath);
    return [...writableDirs, ...writableFiles].map((p) => relative(clonePath, p));
  }
  return writeScope;
}

/**
 * Build the Claude settings.json content injected at
 * `/tmp/.claude-settings/settings.json` (D2 ruling 2 item 2, mirrors
 * agent-chassis). Grants Claude's OWN internal permission engine an Edit
 * allow-entry per write_scope path — the exact DECLARED grant
 * (`Edit(<file>)` for a file entry, `Edit(<dir>/**)` for a directory entry,
 * via `deriveExactFileMounts`'s unwidened classification), deliberately NOT
 * the OS-level widened parent-directory mount `deriveDirectoryScopedMounts`
 * computes for the bwrap bind (step 12d below): Claude's permission check
 * runs before its own Edit tool ever reaches a `rename(2)` syscall, so the
 * kernel-level widening reason doesn't apply at this layer. `Read` is
 * granted over the whole clone (workers need to read outside write_scope for
 * context) and `Bash` is allowed outright; the deny list closes off
 * subagent/web tools entirely — `--permission-mode default` +
 * `--settings <path>` (pipeline.ts's Claude branch) make this allow-list the
 * SOLE grant. Advisory modes (non-implement) also deny Edit/Write/
 * NotebookEdit outright — belt-and-suspenders alongside their already-empty
 * write_scope (D2 ruling 2 item 3).
 */
export function buildClaudeSettingsJson(writeScope: string[], clonePath: string, mode: string): string {
  const { writableDirs, writableFiles } = deriveExactFileMounts(writeScope, clonePath);
  const editEntries = [
    ...writableDirs.map((dir) => `Edit(${dir}/**)`),
    ...writableFiles.map((file) => `Edit(${file})`),
  ];
  const deny = ['WebFetch', 'WebSearch', 'Task', 'Agent', 'Workflow', 'Skill', 'Monitor'];
  if (mode !== 'implement') {
    deny.push('Edit', 'Write', 'NotebookEdit');
  }
  const settings = {
    permissions: {
      allow: [`Read(//${clonePath}/**)`, 'Bash', ...editEntries],
      deny,
      disableBypassPermissionsMode: 'disable',
    },
  };
  return JSON.stringify(settings, null, 2);
}

/**
 * Layer D2 ruling 2 item 5's `.env`/`.claude/` secret-mask args onto an
 * already-built bwrap plan, right before the `--chdir` terminator — bwrap
 * resolves LATER binds over EARLIER ones (jail.ts's own recipe-order
 * comment), so appending here means these masks win over anything
 * `buildBwrapPlan`'s own write_scope/data_mount binds already laid down for
 * the same clone. `buildBwrapPlan` itself stays unmodified (jail.ts's
 * additive-only contract) — this is pipeline.ts's own post-processing step,
 * applied uniformly to every family (Pi included: masking is dormant unless
 * the clone actually carries a `.env`/`.claude/` — see `buildSecretMaskArgs`).
 */
export function withSecretMaskArgs(plan: BwrapPlan, clonePath: string): BwrapPlan {
  const maskArgs = buildSecretMaskArgs(clonePath);
  if (maskArgs.length === 0) return plan;
  const chdirIdx = plan.bwrapArgs.indexOf('--chdir');
  const insertAt = chdirIdx === -1 ? plan.bwrapArgs.length : chdirIdx;
  return {
    ...plan,
    bwrapArgs: [...plan.bwrapArgs.slice(0, insertAt), ...maskArgs, ...plan.bwrapArgs.slice(insertAt)],
  };
}

/**
 * Build the run's forwarder allowlist (DEC-0011 ruling 2/3, WK-0104): Pi's
 * one model endpoint, or the SaaS family's vendor domain set (`CLAUDE_VENDOR_HOSTS`/
 * `CODEX_VENDOR_HOSTS` above), unioned with every granted credential profile's
 * `endpoints` set (`credResolution.credentialEndpoints` — credentials.ts's
 * `resolveCredentials`). Pure/sync — never gates, never fails.
 * @internal pipeline.ts internal — exported only for direct unit testing.
 */
export function buildAllowedHosts(
  model: ResolvedModel,
  credResolution: CredentialResolution,
): string[] {
  let familyHosts: string[];
  if (model.family === 'pi') {
    // Pi: single endpoint = target hostname
    const hostname = model.baseUrl ? new URL(model.baseUrl).hostname : 'localhost';
    familyHosts = [hostname];
  } else if (model.family === 'claude') {
    familyHosts = [...CLAUDE_VENDOR_HOSTS];
  } else {
    familyHosts = [...CODEX_VENDOR_HOSTS];
  }
  // Append credential endpoint sets (WK-0104 ruling 3)
  return [...familyHosts, ...credResolution.credentialEndpoints];
}

/**
 * Resolve the family's CLI toolchain paths living under $HOME, for the
 * visibility wall's toolchain leaf binds (DEC-0011 ruling 1, WK-0103).
 * Evidence-gated (AGENTS.md rule 23): probes the REAL binary location via
 * `which`/`readlink -f`/`npm prefix -g` at dispatch time rather than
 * hand-inventing a path. Best-effort — a probe failure (missing binary,
 * non-$HOME install) yields fewer/no paths rather than failing the dispatch;
 * jail.ts's `toolchainPaths` binds are `--ro-bind-try`, so an empty/
 * incomplete list only narrows visibility, it never breaks the jail itself.
 * @internal pipeline.ts internal — exported only for direct unit testing.
 */
export async function resolveToolchainPaths(family: BackendFamily): Promise<string[]> {
  const paths: string[] = [];
  const home = process.env.HOME ?? '';
  if (!home) return paths;

  // Resolve the family's CLI binary
  const cliName = family === 'pi' ? 'pi' : family === 'codex' ? 'codex' : 'claude';
  const whichResult = await execBash({ scriptContent: `which ${cliName} 2>/dev/null`, timeoutMs: 5000 });
  if (whichResult.ok) {
    const cliPath = whichResult.data.stdout.trim();
    if (cliPath.startsWith(home)) {
      // Resolve the real path (may be a symlink into node_modules)
      const realResult = await execBash({ scriptContent: `readlink -f ${cliPath} 2>/dev/null`, timeoutMs: 5000 });
      if (realResult.ok) {
        const realPath = realResult.data.stdout.trim();
        if (realPath.startsWith(home)) {
          // Bind the npm package root (3 levels up from the binary)
          // e.g. ~/.npm-global-wsl/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
          // → ~/.npm-global-wsl/ (the npm prefix)
          const npmPrefixResult = await execBash({ scriptContent: 'npm prefix -g 2>/dev/null', timeoutMs: 5000 });
          if (npmPrefixResult.ok) {
            const prefix = npmPrefixResult.data.stdout.trim();
            if (prefix.startsWith(home)) {
              paths.push(prefix);
            }
          }
        }
      }
    }
  }

  // Also check if node itself is under $HOME (nvm setups)
  const nodeResult = await execBash({ scriptContent: 'which node 2>/dev/null', timeoutMs: 5000 });
  if (nodeResult.ok) {
    const nodePath = nodeResult.data.stdout.trim();
    if (nodePath.startsWith(home)) {
      // readlink to get real path, bind its directory
      const realResult = await execBash({ scriptContent: `readlink -f ${nodePath} 2>/dev/null`, timeoutMs: 5000 });
      if (realResult.ok) {
        const realDir = realResult.data.stdout.trim().replace(/\/[^/]+$/, '');
        if (realDir.startsWith(home)) {
          paths.push(realDir);
        }
      }
    }
  }

  return [...new Set(paths)];
}

/**
 * Per-family auth leaf binds — the ONLY $HOME paths let through the
 * visibility wall (DEC-0011 ruling 1, WK-0103). Claude's credentials file
 * gets rw for implement (token refresh persists mid-run) and ro for advisory
 * modes (code_review/redteam/research — no write authority to begin with);
 * Codex's auth.json + config.toml are always ro (codex itself only reads
 * them); Pi needs no auth leaf (its API key is env-injected and its config
 * dir lives on the jail's own tmpfs, never under $HOME).
 * @internal pipeline.ts internal — exported only for direct unit testing.
 */
export function buildAuthLeafBinds(family: BackendFamily, mode: string): Array<{ path: string; access: 'ro' | 'rw' }> {
  const home = process.env.HOME ?? '';
  if (!home) return [];

  if (family === 'claude') {
    const credPath = `${home}/.claude/.credentials.json`;
    // Implement gets rw (token refresh persists); advisory modes get ro
    const access = mode === 'implement' ? 'rw' as const : 'ro' as const;
    return [{ path: credPath, access }];
  }

  if (family === 'codex') {
    return [
      { path: `${home}/.codex/auth.json`, access: 'ro' },
      { path: `${home}/.codex/config.toml`, access: 'ro' },
    ];
  }

  // Pi: no auth leaf needed (API key is env-injected, config dir is jail tmpfs)
  return [];
}

export async function runDispatch(opts: DispatchOpts): Promise<DispatchResult<DispatchResult2>> {
  const dir = resolve(opts.dir);
  const { verbose } = opts;

  // 0. Best-effort orphan-clone sweep (D6 ruling 7 component 13 / ruling 6
  // item 4): never blocks or fails the run — a failure here is logged only.
  try {
    const sweepResult = await sweepOrphanClones();
    if (!sweepResult.ok) {
      logVerbose(verbose, `warning: sweepOrphanClones failed: ${sweepResult.message}`);
    }
  } catch (err) {
    logVerbose(verbose, `warning: sweepOrphanClones threw: ${err}`);
  }

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
    family: model.family,
    base_url: model.baseUrl,
    api_key_env: model.apiKeyEnv,
    secrets_file: model.secretsFile,
  });
  if (!credResult.ok) return credResult;

  const policyResult = checkCredentialPolicy(handoff, credResult.data);
  if (!policyResult.ok) return policyResult;

  // 3d. Resolve toolchain paths + auth leaf binds for the visibility wall
  // (DEC-0011, WK-0103) — depends only on model.family/handoff.mode (already
  // resolved above), so this runs alongside the other pre-spawn resolution
  // steps and well before the clone/jail work at step 9+.
  logVerbose(verbose, 'resolving toolchain paths for the visibility wall');
  const toolchainPaths = await resolveToolchainPaths(model.family);
  const authLeafBinds = buildAuthLeafBinds(model.family, handoff.mode);

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
  // This is the T27 diagnostic leg (host-setup remediation text + the Pi
  // harness version gate); bwrap ISOLATION itself is gated unconditionally
  // below (step 4b), independent of this flag (D14: required enforcement,
  // never bare-host).
  let piVersion: string | undefined;
  if (opts.preflight !== false) {
    logVerbose(verbose, 'running T27 host preflight (bwrap presence / live unshare-user / AppArmor userns)');
    const preflight = await runPreflight();
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

  // 4b. Isolation route (D6/D8 — mid_project_review_rulings.md rulings 7/8).
  // Boolean bwrap probe, no tier enum: mirrors agent-chassis, which has no
  // execution-tier enum (README.md:117-131). `enforced:false` bare-host
  // dispatch is retired (spec §11 D14) — if bwrap isn't available and working,
  // this refuses instead of falling back to an unenforced run. Provenance
  // records facts (`isolation: 'bwrap'` + the probe result), never a tier name.
  logVerbose(verbose, 'probing bwrap availability');
  const bwrapProbe = await probeBwrap();
  if (!bwrapProbe.available) {
    return fail(
      'NO_ISOLATION_ROUTE',
      bwrapProbe.bwrapVersion === null ? MISSING_BWRAP_TEXT : APPARMOR_REMEDIATION_TEXT,
      bwrapProbe,
    );
  }
  // capture.ts's CaptureOpts.isolationBackend is a plain string (unmodified
  // by D6 — capture.ts is out of scope for this slice); the fuller probe
  // facts (version/kernel/sysctl) are logged verbose-only since there is no
  // structured provenance field to carry them yet.
  logVerbose(verbose, `bwrap available: version=${bwrapProbe.bwrapVersion} kernel=${bwrapProbe.kernelVersion} usernsSysctl=${bwrapProbe.usernsSysctl}`);
  const isolationBackend = 'bwrap';

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
  const wikiProbeResult = await execBash({
    scriptContent: 'git ls-files wiki/ 2>/dev/null',
    cwd: dir,
    timeoutMs: 30_000,
  });
  const wikiShape: WikiShape = wikiProbeResult.ok
    ? classifyWikiShape(wikiProbeResult.data.stdout)
    : 'nested-private'; // fail-safe: assume no wiki in clone

  // 9. Clone (ephemeral full clone @ pinned base_sha, same-host ext4)
  logVerbose(verbose, `cloning mother repo at base_sha ${admission.data.baseSha}`);
  const cloneResult = await createClone({
    motherRepo: dir,
    runId,
    baseSha: admission.data.baseSha,
  });
  if (!cloneResult.ok) return cloneResult;
  const { clonePath } = cloneResult.data;

  try {
    // 9b. Pre-create skeleton for write_scope sparse binds — bwrap cannot
    // mkdir a new path under a ro-bound root (jail.ts's own module doc), so
    // every write_scope path must already exist on disk before buildBwrapPlan.
    // File entries: mkdir the parent, touch the file (chassis pattern:
    // O_CREAT | O_EXCL). Directory entries: mkdir the entry itself.
    if (handoff.write_scope.length > 0) {
      for (const rel of handoff.write_scope) {
        const trimmed = rel.replace(/^\/+/, '').replace(/\/+$/, '');
        if (!trimmed) continue;
        const entryPath = join(clonePath, trimmed);
        if (classifyEntry(entryPath, trimmed) === 'file') {
          const parentDir = dirname(entryPath);
          try {
            await mkdir(parentDir, { recursive: true });
          } catch (err) {
            return fail('PIPELINE_FAILED', `Failed to create write_scope skeleton dir: ${parentDir}`, err);
          }
          try {
            closeSync(openSync(entryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o644));
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
              return fail('PIPELINE_FAILED', `Failed to create write_scope skeleton file: ${entryPath}`, err);
            }
          }
        } else {
          try {
            await mkdir(entryPath, { recursive: true });
          } catch (err) {
            return fail('PIPELINE_FAILED', `Failed to create write_scope skeleton dir: ${entryPath}`, err);
          }
        }
      }
    }

    // 10. Build the family-specific worker invocation (T33 family-aware
    // pipeline). Each branch below produces two family-agnostic outputs
    // consumed downstream: `execLines` (the bash line(s) appended to the
    // in-jail inner script at step 12c) and `bwrapInjectedFiles` (bwrap
    // `--file` materializations needed at plan-build time, step 12d).
    // `workerDir` (PI_CODING_AGENT_DIR) is Pi-only and also feeds step 12b's
    // worker env. Declared here (rather than `const` inside each branch) so
    // they survive into the later, family-agnostic steps without needing
    // per-callsite `model.family` re-narrowing.
    let workerDir = '';
    let execLines: string[] = [];
    let bwrapInjectedFiles: Array<{ content: string; dest: string }> = [];

    if (model.family === 'pi') {
      // workerDir is a path INSIDE THE JAIL, not under clonePath: jail.ts's
      // S5 recipe mounts a fresh --tmpfs /tmp (step 4 of the §11 recipe) that
      // is always writable regardless of write_scope, unlike the rest of the
      // ro-bound clone. A clone-relative path here (the old S0 shape) would
      // put Pi's config dir outside write_scope and hit EROFS the moment Pi
      // tries to write auth.json/models.json, since S5 made the clone
      // read-only except for declared write_scope paths. The bwrap plan's
      // `injectedFiles` (D6 component 15) materializes models.json inside the
      // jail for the same reason this path is chosen here: the tmpfs does
      // not exist until bwrap itself mounts it, so nothing pre-jail can see
      // or populate it.
      workerDir = '/tmp/.pi-agent';

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
      //
      // model.baseUrl is `string | null` (ResolvedModel, model-registry.ts),
      // but resolveModelFromConfig already refuses BAD_RECORD pre-spawn for
      // any pi-family backend with a null base_url, so this is guaranteed
      // non-null by this point — the check below only satisfies the type
      // checker (never pass a possibly-null value into buildPiBaseUrl's own
      // `new URL()` call).
      if (model.baseUrl === null) {
        return fail(
          'PIPELINE_FAILED',
          `Model "${opts.model}" on backend "${opts.backend}" resolved with family "pi" but no base_url.`,
        );
      }
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
        contextWindow: model.contextWindow,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const invocation = buildInvocation(promptPath, piModelEntry, clonePath, workerDir);
      execLines = [`exec ${[invocation.cmd, ...invocation.args].map(shQuote).join(' ')}`];
      bwrapInjectedFiles = [{ content: invocation.modelsJsonContent, dest: `${workerDir}/models.json` }];
    } else if (model.family === 'codex') {
      // codexOutputPath lives under the jail's writable /tmp tmpfs — same
      // EROFS reasoning as Pi's workerDir above applies here: codex itself
      // (running inside the jail) writes its `-o` mirror file, and `runDir`
      // (a host path outside the clone) is only ro-bound into the jail.
      // pipeline.ts never reads this file back (step 15 parses the captured
      // stdout instead — same event data, per adapters/codex.ts's own doc
      // comment), so its exact location only needs to be writable, not
      // host-visible.
      const codexOutputPath = '/tmp/codex-last-message.txt';
      // D2 ruling 2: bwrap's exact-file kernel binds (deriveExactFileMounts,
      // wired into the plan at step 12d below) are the real enforcement
      // boundary for implement mode now — `danger-full-access` disables
      // Codex's OWN sandbox so it doesn't double-restrict inside a jail
      // that already confines it. Advisory modes carry no write_scope at
      // all, so they keep Codex's own `read-only` sandbox as an extra layer.
      const sandbox = handoff.mode === 'implement' ? 'danger-full-access' as const : 'read-only' as const;
      // Built for shape/parity with the adapter's D10 contract (facts-only:
      // "adapters may not... build shell strings elsewhere"). The actual exec
      // line below is hand-built rather than `codexInvocation.args`, because
      // that array embeds the full prompt TEXT inline — accurate as a fact
      // report, but too large to splice verbatim into the generated bash
      // script. The prompt is read from `promptPath` at container runtime
      // instead, mirroring Pi's own `@promptFilePath` file-reference
      // convention (adapters/pi.ts's buildInvocation).
      buildCodexInvocation(assembled.data.text, model, clonePath, codexOutputPath, sandbox);
      execLines = [
        `PROMPT=$(cat ${shQuote(promptPath)})`,
        `exec codex exec "$PROMPT" --sandbox ${sandbox} --json -o ${shQuote(codexOutputPath)} --model ${shQuote(model.modelId)}`,
      ];
    } else {
      // Claude family (D2 ruling 2): a settings.json allow-list keyed off
      // write_scope (buildClaudeSettingsJson) replaces the old blanket
      // `acceptEdits` bypass — `--permission-mode default` makes that
      // allow-list the SOLE grant. Same file-read rationale as the codex
      // branch above for calling claude.ts's buildInvocation (shape/parity
      // only; the actual exec line is hand-built to read the prompt from
      // promptPath at container runtime).
      const claudeSettingsPath = '/tmp/.claude-settings/settings.json';
      const claudeSettingsContent = buildClaudeSettingsJson(handoff.write_scope, clonePath, handoff.mode);
      buildClaudeInvocation(assembled.data.text, model, clonePath, claudeSettingsPath);
      execLines = [
        `PROMPT=$(cat ${shQuote(promptPath)})`,
        `exec claude -p --output-format json --permission-mode default --settings ${shQuote(claudeSettingsPath)} --model ${shQuote(model.modelId)} -- "$PROMPT"`,
      ];
      bwrapInjectedFiles = [{ content: claudeSettingsContent, dest: claudeSettingsPath }];
    }

    // 10b. Resolved tunnel target endpoint + allowlist (DEC-0011, WK-0104).
    // D6/D3: the orchestrator IS the Linux host now (no separate Windows host
    // whose loopback could be confused with the jail's own), so
    // `model.baseUrl` — including a same-host loopback like
    // `http://localhost:11434/v1` — is already the correct address to hand
    // the forwarder for Pi's origin-form routing. (Formerly resolved via a
    // WIN_HOST lookup on bwrap-wsl2 only; that tier and its lookup are
    // retired post-D3 — see the D6 dead-code deletion list.) codex/claude
    // backends resolve with `baseUrl: null` (their CLIs reach their SaaS
    // provider directly — s3 two-table config, repo-config.ts's BackendEntry)
    // — SaaS CLIs use proxy protocol (absolute-URI / CONNECT) exclusively,
    // never origin-form, so 'https://unused.local' is never dereferenced;
    // egress for those families is enforced entirely by `allowedHosts` below,
    // not by targetUrl.
    const resolvedTargetUrl = model.baseUrl ?? 'https://unused.local';
    const allowedHosts = buildAllowedHosts(model, credResult.data);

    // 11. Tunnel config (T26/D21) — the socket/relay/log all live under the
    // clone / run dir (never inside enumerate/delivery's view: they are
    // dispatch infrastructure, not worker output). web:true widens the
    // forwarder's own destination policy (s5-rulings.md ruling 4) — the flag
    // itself is the grant. Socket lives under the clone path (same
    // filesystem as everything else dispatch stages there).
    const tunnelSocketPath = join(clonePath, TUNNEL_SOCKET_NAME);
    const relayScriptPath = join(runDir, 'relay.js');
    const forwarderScriptPath = join(runDir, 'forwarder.js');
    const forwarderLogPath = join(runDir, 'forwarder.log');
    const tunnelDestinationsLogPath = join(runDir, 'tunnel-destinations.log');
    const tunnelConfig: TunnelConfig = {
      socketPath: tunnelSocketPath,
      targetUrl: resolvedTargetUrl,
      allowedHosts,
      webEnabled: handoff.web,
      relayPort: TUNNEL_RELAY_PORT,
      logPath: tunnelDestinationsLogPath,
    };
    // D6 component 14: forwarder/relay SCRIPT CONTENT (not the old bash-line
    // splice) — the forwarder is spawned directly pre-jail below; the relay
    // is started from inside the bwrap command wrapper.
    const { forwarderScript, relayScript } = buildTunnelScripts(tunnelConfig);
    try {
      await writeFile(forwarderScriptPath, forwarderScript, 'utf8');
      await writeFile(relayScriptPath, relayScript, 'utf8');
    } catch (err) {
      return fail('PIPELINE_FAILED', 'Failed to write tunnel forwarder/relay scripts.', err);
    }

    // Mother wiki path for the nested-private + redteam/research bind (T25/D19).
    const motherWikiPath = join(dir, 'wiki');

    // 12a. Backend fingerprint (S3 ruling 8) — best-effort, facts-only, never
    // gating. D6: its own small execBash round trip now; it no longer needs
    // to ride inside the worker's (now-deleted) generated execution script.
    const fingerprintLines = buildFingerprintFragment({ ...model, baseUrl: resolvedTargetUrl });
    const fingerprintExec = await execBash({ scriptContent: fingerprintLines.join('\n'), timeoutMs: 10_000 });
    const fingerprint = fingerprintExec.ok ? parseFingerprintOutput(fingerprintExec.data.stdout) : null;

    // 12b. Worker env (D6 component 9: env-policy deny-list as the base,
    // credential/vars/proxy vars layered on top — never the other way
    // around, so an operator's own ambient HTTP_PROXY can never silently
    // survive into the jail alongside kb's relay address). PI_* vars are
    // Pi-only (T33) — codex/claude have no equivalent config-dir/offline env
    // contract.
    const credentialEnvResult = await resolveCredentialEnv(credResult.data);
    if (!credentialEnvResult.ok) return credentialEnvResult;
    const proxyUrl = `http://127.0.0.1:${TUNNEL_RELAY_PORT}`;
    const baseWorkerEnv: Record<string, string> = {
      ...buildWorkerEnv({}),
      ...credentialEnvResult.data,
      ...parseHandoffVarsEnv(handoff.vars),
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    };
    const workerEnv: Record<string, string> = model.family === 'pi'
      ? { ...baseWorkerEnv, PI_CODING_AGENT_DIR: workerDir, PI_OFFLINE: '1' }
      : model.family === 'claude'
        ? { ...baseWorkerEnv, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
        : { ...baseWorkerEnv };

    // 12c. In-jail command wrapper: bring lo up (a fresh netns starts with it
    // down), start the relay, run `npm rebuild` under containment when a
    // lockfile is present (F12 fix, WK-0089: no `|| true` — `set -e` makes a
    // rebuild failure fail the whole command), then `exec` the worker so its
    // own exit code/signal becomes bwrap's. The exec line(s) themselves are
    // `execLines`, built per-family at step 10 above.
    const lockfilePath = join(clonePath, 'package-lock.json');
    const hasLockfile = existsSync(lockfilePath);
    const innerScript = [
      'set -euo pipefail',
      'ip link set lo up 2>/dev/null || true',
      `node ${shQuote(relayScriptPath)} ${shQuote(String(TUNNEL_RELAY_PORT))} ${shQuote(tunnelSocketPath)} < /dev/null > /dev/null 2>&1 &`,
      'sleep 0.2',
      ...(hasLockfile ? ['npm rebuild'] : []),
      ...execLines,
    ].join('\n');

    // 12d. Build the frozen bwrap plan (D6 ruling 7 components 1-4/15).
    // data_mounts still needs the suffix->prefix format bridge
    // (toDataMountPrefixForm) — independent of the (retired) Windows path
    // conversion the old toJailDataMount also did. `bwrapInjectedFiles` is
    // Pi's models.json or Claude's settings.json (step 10 above) — empty for
    // codex. Per-family write mount shape via `familyWriteScope` (D2 ruling
    // 2) — Pi's own shape is unchanged (identity passthrough); the post-hoc
    // scope check at step 17 below still verifies the delivered diff against
    // the UNWIDENED `handoff.write_scope`, so this override only widens the
    // PREVENTIVE bwrap mount, never the actual granted scope. `.env`/
    // `.claude/` secret masking (D2 ruling 2 item 5) is layered on
    // afterward for every family via `withSecretMaskArgs` — `buildBwrapPlan`
    // itself stays unmodified (jail.ts's additive-only contract).
    const rawPlan = buildBwrapPlan({
      clonePath,
      writeScope: familyWriteScope(model.family, handoff.write_scope, clonePath),
      wikiShape,
      mode: handoff.mode,
      motherWikiPath,
      dataMounts: handoff.data_mounts.map(toDataMountPrefixForm),
      unshareNet: true,
      tunnelSocketPath,
      relayScriptPath,
      toolchainPaths,
      authLeafBinds,
      runDirPath: runDir,
      command: ['bash', '-c', innerScript],
      env: workerEnv,
      injectedFiles: bwrapInjectedFiles,
    });
    const plan = withSecretMaskArgs(rawPlan, clonePath);

    // 12e. Pre-jail: lockfile-gated `npm ci --ignore-scripts` (s5-rulings.md
    // ruling 2), direct spawn, no bwrap — best-effort, never gating (only the
    // IN-JAIL `npm rebuild` above became fail-loud per F12/WK-0089).
    if (hasLockfile) {
      logVerbose(verbose, 'running npm ci --ignore-scripts (pre-jail)');
      const npmCi = await spawnAndWait('npm', ['ci', '--ignore-scripts'], { cwd: clonePath });
      if (npmCi.code !== 0) {
        logVerbose(verbose, `warning: npm ci --ignore-scripts exited ${npmCi.code}: ${npmCi.stderr}`);
      }
    }

    // 12f. Pre-jail: start the host-side tunnel forwarder (T26/D21) — the
    // only process in the whole run that ever touches a real network
    // interface for egress. Runs for the worker's lifetime; killed below.
    logVerbose(verbose, 'starting tunnel forwarder');
    const forwarderLogFd = openSync(forwarderLogPath, 'a');
    const forwarderChild = spawn(
      'node',
      [forwarderScriptPath, tunnelSocketPath, resolvedTargetUrl, handoff.web ? 'true' : 'false', tunnelDestinationsLogPath, JSON.stringify(allowedHosts)],
      { stdio: ['ignore', forwarderLogFd, forwarderLogFd] },
    );
    closeSync(forwarderLogFd);
    forwarderChild.on('error', (err) => logVerbose(verbose, `warning: tunnel forwarder process error: ${err.message}`));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));

    // 13/14. Spawn the jailed worker directly (D6 ruling 7 components 5-8).
    let spawnData: SpawnResult;
    try {
      logVerbose(verbose, `invoking ${canonicalModel} via bwrap+pi`);
      const spawnResult = await spawnIsolated(plan, { timeoutMs: WORKER_TIMEOUT_MS, stdoutLogPath: join(runDir, 'pi-output.log') });
      if (!spawnResult.ok) return spawnResult;
      spawnData = spawnResult.data;
    } finally {
      // Post-jail: stop the host-side forwarder — nothing else reaps it,
      // since it runs outside bwrap and --die-with-parent doesn't reach it.
      forwarderChild.kill();
    }

    // Exit/signal interpretation (D6 ruling 7 component 8; chassis
    // deriveTerminalStatus: `code === 0 && !signal` -> succeeded — native
    // Linux's `.signal` is authoritative, no classifySignalExit guessing).
    const succeeded = spawnData.exitCode === 0 && spawnData.signal === null;
    if (!succeeded && !spawnData.timedOut) {
      return fail(
        'PIPELINE_FAILED',
        `Worker exited with code ${spawnData.exitCode} (signal=${spawnData.signal}).`,
        spawnData,
      );
    }

    // 15. Parse worker output (timedOut = watchdog fired). For Pi, recoverable
    // only if Pi wrote agent_end before the kill — the pi#4303 post-completion
    // flavor; the codex/claude adapters report no equivalent "already
    // finished" signal, so a timeout there is always a hard failure. The
    // stdout capture file is still named pi-output.log for every family
    // (spawnIsolated's stdoutLogPath, wired at step 13/14 above) — only the
    // parser consulted below differs.
    const piOutputLogPath = join(runDir, 'pi-output.log');
    let piOutputContent: string;
    try {
      piOutputContent = await readFile(piOutputLogPath, 'utf8');
    } catch (err) {
      return fail('PIPELINE_FAILED', `Failed to read pi-output.log: ${piOutputLogPath}`, err);
    }

    let workerOutcome: string;
    let workerUsage: { totalTokens: number; costUsd: number };
    let lastAssistantText: string;
    let compaction = { total: 0, succeeded: 0, failed: 0 };

    if (model.family === 'pi') {
      const piParsed = parsePiOutput(piOutputContent);
      if (!piParsed.ok) {
        if (spawnData.timedOut) {
          return fail('PIPELINE_FAILED', `Worker timed out after ${WORKER_TIMEOUT_SECS}s (watchdog fired; no parseable output).`, spawnData);
        }
        return piParsed;
      }

      if (spawnData.timedOut && !piParsed.data.hasAgentEnd) {
        return fail('PIPELINE_FAILED', `Worker timed out after ${WORKER_TIMEOUT_SECS}s (watchdog fired).`, { timedOut: true, piOutcome: piParsed.data.outcome });
      }

      if (spawnData.timedOut) {
        logVerbose(verbose, 'watchdog reaped pi after completion (pi#4303 flavor)');
      }
      logVerbose(verbose, `pi outcome: ${piParsed.data.outcome}`);

      workerOutcome = piParsed.data.outcome;
      workerUsage = piParsed.data.usage;
      lastAssistantText = piParsed.data.lastAssistantText;
      compaction = piParsed.data.compaction;
    } else if (model.family === 'codex') {
      if (spawnData.timedOut) {
        return fail('PIPELINE_FAILED', `Worker timed out after ${WORKER_TIMEOUT_SECS}s (watchdog fired).`, spawnData);
      }
      const codexParsed = parseCodexOutput(piOutputContent);
      if (!codexParsed.ok) return codexParsed;
      logVerbose(verbose, `codex outcome: ${codexParsed.data.outcome}`);

      workerOutcome = codexParsed.data.outcome;
      // CodexUsage carries no cost figure (adapters/codex.ts module doc) —
      // costUsd stays 0. capture.ts's usage shape ({totalTokens, costUsd}) is
      // already family-agnostic, so no capture.ts change is needed here.
      workerUsage = {
        totalTokens: codexParsed.data.usage.inputTokens + codexParsed.data.usage.outputTokens,
        costUsd: 0,
      };
      lastAssistantText = codexParsed.data.lastAssistantText;
    } else {
      if (spawnData.timedOut) {
        return fail('PIPELINE_FAILED', `Worker timed out after ${WORKER_TIMEOUT_SECS}s (watchdog fired).`, spawnData);
      }
      const claudeParsed = parseClaudeOutput(piOutputContent);
      if (!claudeParsed.ok) return claudeParsed;
      logVerbose(verbose, `claude outcome: ${claudeParsed.data.outcome}`);

      workerOutcome = claudeParsed.data.outcome;
      workerUsage = {
        totalTokens: claudeParsed.data.usage.inputTokens + claudeParsed.data.usage.outputTokens,
        costUsd: claudeParsed.data.usage.costUsd,
      };
      lastAssistantText = claudeParsed.data.lastAssistantText;
    }

    // 15b. Extract the kb-dispatch-recovery.v1 recovery block (D1 ruling 1,
    // mid_project_review_rulings.md; V4 note 3 role asymmetry). Transport is
    // the worker's own terminal LLM output (assemble.ts's prompt contract
    // instructs every non-research mode to emit it) — no file artifact, no
    // `.dispatch-out/`. `research` is prose-only and never emits this block
    // (ruling 1 item 1; recovery-block.ts's own module doc: "never invoked
    // for it") — skip extraction there so `recoveryEvidence` stays undefined
    // rather than reporting a spurious `missing_result` diagnostic.
    // Extraction never throws and never gates the pipeline by itself; V4
    // note 3's role asymmetry (implement: evidence only; code_review/redteam:
    // the block IS the deliverable) is enforced downstream in capture.ts's
    // `deriveVerdict`, not here.
    const recoveryEvidence: RecoveryBlockEvidence | undefined =
      handoff.mode === 'research' ? undefined : extractRecoveryBlock(lastAssistantText);
    if (recoveryEvidence && !recoveryEvidence.valid) {
      logVerbose(verbose, `recovery block invalid: ${recoveryEvidence.diagnostics.map((d) => d.code).join(', ')}`);
    }

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
      // credential's literal value, in one exec round trip (no diff content
      // ever leaves this host process for this check). Only var NAMES
      // (`SECRET_HIT=<VAR_NAME>`) cross back into this stdout — the resolved
      // values themselves never reach this script's own text. Every
      // injection scanned here was already resolved successfully in step
      // 12b above (resolveCredentialEnv is fail-closed pre-spawn), so the
      // grep is guaranteed to find a value under `set -e`.
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
      const enumerateExec = await execBash({
        scriptContent: enumerateScriptContent,
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

      // 17. Check write scope, check the injected-value scan hits captured
      // above — refusals are DATA (a DeliveryOutcome variant), not a
      // DispatchResult failure; the pipeline ran correctly. (S3: the
      // deterministic injected-value scan replaces the removed
      // pattern-based scanSecrets() leg — it checks only the exact values
      // the worker was granted, not heuristic patterns, so it is fully
      // deterministic.)
      //
      // D2 ruling 2 item 3 (belt-and-suspenders): this IS the post-hoc half
      // of scope enforcement — `enumerated`/`allChangedFiles` above already
      // comes from `git diff`/`git status --porcelain` + `git ls-files
      // --others` in the clone (delivery.ts's buildEnumerateScript /
      // parseEnumerateOutput), `checkWriteScope` below checks every changed
      // path against the UNWIDENED `handoff.write_scope` (exact or
      // dir-prefix match), and a non-zero-exit or exec failure on the
      // enumerate script already returns the failed DispatchResult above
      // (fail-closed on git errors, never falls through to delivery). The
      // per-family bwrap mounts built at step 12d (deriveDirectoryScopedMounts
      // for Claude, deriveExactFileMounts for Codex) are the PREVENTIVE half;
      // this is the backstop that catches anything they missed. No
      // additional code needed here — both halves already existed/now exist.
      const scopeCheck = checkWriteScope(allChangedFiles, handoff.write_scope);

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
        // 18. Deliver (clean: land the scope-checked commit).
        logVerbose(verbose, 'delivering scope-checked commit');
        const deliveryScript = buildDeliveryScript({
          clonePath,
          motherRepoWsl: dir,
          handoffId: handoff.id,
          baseSha: admission.data.baseSha,
        });
        const deliveryExec = await execBash({
          scriptContent: deliveryScript.scriptContent,
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
      // repo either way. A failed probe (exec error or non-zero exit) never
      // blocks capture — the response doc is this mode's real deliverable
      // and does not depend on this check.
      logVerbose(verbose, `mode ${handoff.mode} is advisory — skipping delivery, checking for stray mutations`);
      const advisoryEnumerateScript = buildEnumerateScript(clonePath);
      const advisoryEnumerateExec = await execBash({
        scriptContent: advisoryEnumerateScript.scriptContent,
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

    // 20. Capture. `piResult`/`compaction`/`lastAssistantText` are
    // capture.ts's pre-existing field names (CaptureOpts); their shapes
    // ({outcome: string; usage: {totalTokens, costUsd}} and PiCompaction)
    // are already family-agnostic, so the normalized codex/claude values
    // computed at step 15 fit them unchanged — no capture.ts edit needed for
    // this. (The `piResult`/`agent: 'pi'` NAMES are Pi-only leftovers — see
    // the TODO at the provenance write-back call below.)
    const captureResult = await writeResponseDoc({
      runDir,
      handoff: { id: handoff.id, title: handoff.title, mode: handoff.mode },
      delivery,
      piResult: { outcome: workerOutcome, usage: workerUsage },
      compaction,
      model: canonicalModel,
      isolationBackend,
      lastAssistantText,
      credentialsGranted: credResult.data.granted,
      recoveryEvidence,
      // Resolved-value provenance (S3 ruling 8): the real endpoint the tunnel
      // forwarder was configured to reach (resolvedTargetUrl === model.baseUrl
      // post-D3/D6 — there is no more WIN_HOST template to resolve).
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
    // TODO(capture.ts): buildProvenanceWriteBack hardcodes fields.agent =
    // 'pi' unconditionally in its own body (not a parameter) — now that
    // codex/claude runs can reach here, HO provenance frontmatter will read
    // "agent: pi" even for a codex/claude run. capture.ts needs an `agent`
    // (or `family`) input threaded from model.family; out of scope here
    // since capture.ts is not to be modified as part of this change.
    const provenance = buildProvenanceWriteBack({
      runDir,
      handoff: { id: handoff.id, title: handoff.title, mode: handoff.mode },
      delivery,
      model: canonicalModel,
      isolationBackend,
      credentialsGranted: credResult.data.granted,
      compaction,
      // Resolved-value provenance (S3 ruling 8): the real endpoint the tunnel
      // forwarder was configured to reach (resolvedTargetUrl === model.baseUrl
      // post-D3/D6 — there is no more WIN_HOST template to resolve).
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
      recoveryEvidence,
    });
  } finally {
    // 21. Remove clone — best-effort; clone.ts's 24h orphan sweep is the
    // safety net if this itself fails to run (never rejects, but belt+suspenders).
    await removeClone(clonePath).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// S6a fix: Pi baseUrl path preservation (gate-2 bug, 2026-09-13). Not part of
// the package's public surface — exported at module scope only so tests can
// assert on it directly (mirrors `mergeProvenanceFrontmatter` below), without
// needing a live bwrap host to drive `runDispatch()` all the way to step 10.
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

// D6 dead-code deletion (ruling 7): needsWinHostResolution/applyWinHost/
// LOOPBACK_HOSTNAMES (WIN_HOST resolution, bwrap-wsl2-only — dead post-D3's
// Linux-only orchestrator), toJailDataMount (superseded by
// toDataMountPrefixForm above — the Windows path conversion it also did no
// longer applies), and buildExecutionScript/BuildExecutionScriptOpts (the
// generated-script assembly the D6 spawn pipeline replaces — see runDispatch
// steps 12a-14 above) are REMOVED.

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


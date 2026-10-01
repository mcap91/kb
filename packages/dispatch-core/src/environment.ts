import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type {
  CheckEnvironmentResult,
  ContainerDetection,
  EnvironmentWritability,
  RouteVerdict,
} from './types.js';
import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';
import { getConfigDir } from './paths.js';
import { APPARMOR_REMEDIATION_TEXT, MISSING_BWRAP_TEXT, probeBwrap, type BwrapProbeResult } from './tier.js';
import { SYSTEM_ROOTS } from './jail.js';
import { execBash } from './exec-direct.js';
import { attachStreamErrorHandlers } from './stream-utils.js';
import { buildInvocation, buildModelsJson } from './adapters/pi.js';
import type { ModelEntry } from './model-registry.js';
import { loadBackendsTable, loadModelsTable } from './repo-config.js';
import type { BackendEntry, ModelTableEntry } from './repo-config.js';

/**
 * Per-backend CLI reachability fact (WK-0174 / SRC-0013): does `command -v
 * <cli>` resolve to a path under a mountable root ($HOME or SYSTEM_ROOTS)?
 * Mirrors the exact mountability rule `pipeline.ts`'s `resolveToolchainPaths`
 * gates a real dispatch on. Declared here (not types.ts, out of this WK's
 * write scope) and merged onto `CheckEnvironmentResult` via the module
 * augmentation below — interface declaration merging applies at the
 * type-program level regardless of which module a consumer imports from.
 */
export interface CliReachability {
  family: string;
  cli: string;
  /** Real (readlink -f'd) resolved path, or null if the CLI is not on PATH. */
  resolvedPath: string | null;
  /** True when `resolvedPath` is under $HOME or a SYSTEM_ROOTS entry. */
  mountable: boolean;
  detail: string;
}

declare module './types.js' {
  interface CheckEnvironmentResult {
    /** Per-backend CLI reachability probes (WK-0174). */
    cliReachability: CliReachability[];
    /** Per-backend×model endpoint-eligibility probes (WK-0189). */
    endpointEligibility: EndpointEligibilityVerdict[];
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runProcess(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs?: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolvePromise({
          code: 1,
          stdout,
          stderr: `${stderr}\nProcess timeout: exceeded ${timeoutMs}ms and was killed.`,
        });
      }, timeoutMs);
    }

    attachStreamErrorHandlers(child.stdout, child.stderr);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        code: 1,
        stdout,
        stderr: `${stderr}${String(err)}`,
      });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Container detection + writability facts (informational; not gating inputs)
// ---------------------------------------------------------------------------

const CGROUP_CONTAINER_PATTERN = /docker|kubepods|containerd|libpod|lxc/;

/**
 * Detect container signals: `KUBERNETES_SERVICE_HOST`, `/.dockerenv`, and the
 * first line of `/proc/1/cgroup`. Facts only — MVP gating never keys off these.
 */
export async function detectContainer(): Promise<ContainerDetection> {
  const kubernetesServiceHost = Boolean(process.env['KUBERNETES_SERVICE_HOST']);
  const dockerenv = await pathExists('/.dockerenv');

  let cgroupHint: string | null = null;
  try {
    const cgroup = await readFile('/proc/1/cgroup', 'utf-8');
    cgroupHint = cgroup.split('\n')[0]?.trim() || null;
  } catch {
    cgroupHint = null;
  }
  const cgroupIndicatesContainer = cgroupHint !== null && CGROUP_CONTAINER_PATTERN.test(cgroupHint);

  return {
    detected: kubernetesServiceHost || dockerenv || cgroupIndicatesContainer,
    kubernetes_service_host: kubernetesServiceHost,
    dockerenv,
    cgroup_hint: cgroupHint,
  };
}

function resolveHomePath(): string | null {
  if (process.platform === 'win32') {
    return process.env['USERPROFILE'] ?? null;
  }
  return process.env['HOME'] ?? null;
}

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report whether a path can be written or created, by walking up to the nearest
 * existing ancestor and testing its writability.
 */
async function isCreatable(target: string): Promise<boolean> {
  let current = target;
  for (;;) {
    if (await pathExists(current)) {
      return isWritable(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/** Probe HOME and resolved-config-dir writability (the ro-HOME pod blocker). */
export async function probeWritability(): Promise<{
  home: EnvironmentWritability;
  config_dir: EnvironmentWritability;
}> {
  const homePath = resolveHomePath();
  const home: EnvironmentWritability = homePath === null
    ? { path: null, writable: false, detail: 'HOME is not set.' }
    : { path: homePath, writable: await isWritable(homePath), detail: `HOME resolved to ${homePath}.` };

  let configDirPath: string;
  try {
    configDirPath = getConfigDir();
  } catch (err) {
    return {
      home,
      config_dir: { path: null, writable: false, detail: `Config directory could not be resolved: ${String(err)}` },
    };
  }

  const configWritable = await isCreatable(configDirPath);
  return {
    home,
    config_dir: {
      path: configDirPath,
      writable: configWritable,
      detail: configWritable
        ? `Config store ${configDirPath} is writable.`
        : `Config store ${configDirPath} is not writable; set XDG_CONFIG_HOME to a writable directory.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-backend CLI reachability (WK-0174 / SRC-0013): does `command -v <cli>`
// resolve to a path under a mountable root ($HOME or SYSTEM_ROOTS)? Mirrors
// the exact mountability rule pipeline.ts's `resolveToolchainPaths` gates a
// real dispatch on, so check-environment reports what a real dispatch will
// do rather than a `--ro-bind / /` approximation of it (tier.ts's
// `probeUnshareUser` fix above closes the matching gap for the bwrap round
// trip itself).
// ---------------------------------------------------------------------------

const CLI_BACKENDS: ReadonlyArray<{ family: string; cli: string }> = [
  { family: 'claude', cli: 'claude' },
  { family: 'codex', cli: 'codex' },
  { family: 'pi', cli: 'pi' },
];

const execFileAsync = promisify(execFileCb);

/** Path-boundary-safe: `root` itself, or a real path segment under it — `/usrlocal/bin` must NOT match `/usr`. */
function isMountablePath(path: string, home: string | null): boolean {
  if (home !== null && home.length > 0 && (path === home || path.startsWith(`${home}/`))) return true;
  return SYSTEM_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

type NamespaceReachability = 'reachable' | 'unreachable' | 'bwrap-unavailable';

/**
 * Probe whether `command -v <cli>` succeeds INSIDE a bwrap namespace built
 * from the exact curated SYSTEM_ROOTS binds jail.ts uses (WK-0174 review F1,
 * AC2) — not a host-side `command -v` string check, and not a whole-root
 * `--ro-bind / /` approximation (that shape can't catch a CLI genuinely
 * missing from the curated jail). Mirrors tier.ts's `probeUnshareUser`
 * exec pattern. `command` is a shell builtin, not an executable, so the
 * in-jail invocation runs it through `sh -c`.
 */
async function probeCliInNamespace(cli: string): Promise<NamespaceReachability> {
  try {
    await execFileAsync('bwrap', [
      '--unshare-user',
      ...SYSTEM_ROOTS.flatMap((r) => ['--ro-bind-try', r, r]),
      '--proc', '/proc',
      '--dev', '/dev',
      'sh', '-c', `command -v ${cli}`,
    ]);
    return 'reachable';
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return code === 'ENOENT' ? 'bwrap-unavailable' : 'unreachable';
  }
}

/**
 * Resolve one backend's CLI via `command -v` + `readlink -f` on the host
 * (diagnostics only) and classify mountability by actually probing
 * reachability inside a curated-SYSTEM_ROOTS bwrap namespace.
 */
async function probeOneCliReachability(family: string, cli: string, home: string | null): Promise<CliReachability> {
  const whichResult = await execBash({ scriptContent: `command -v ${cli} 2>/dev/null`, timeoutMs: 5000 });
  const whichPath = whichResult.ok ? whichResult.data.stdout.trim() : '';
  let resolvedPath: string | null = null;
  if (whichPath.length > 0) {
    const realResult = await execBash({ scriptContent: `readlink -f ${whichPath} 2>/dev/null`, timeoutMs: 5000 });
    const realPath = realResult.ok ? realResult.data.stdout.trim() : '';
    resolvedPath = realPath.length > 0 ? realPath : whichPath;
  }
  const pathDetail = resolvedPath !== null ? `resolves to ${resolvedPath} on the host` : 'was not found on PATH';

  const namespaceResult = await probeCliInNamespace(cli);
  if (namespaceResult === 'bwrap-unavailable') {
    return {
      family,
      cli,
      resolvedPath,
      mountable: false,
      detail: `bwrap is not available; cannot probe ${cli} reachability inside the curated SYSTEM_ROOTS jail namespace.`,
    };
  }

  const mountable = namespaceResult === 'reachable';
  if (mountable) {
    return {
      family,
      cli,
      resolvedPath,
      mountable,
      detail: `${cli} ${pathDetail} and is reachable via \`command -v\` inside a bwrap namespace mirroring the curated SYSTEM_ROOTS jail.`,
    };
  }

  const detail = resolvedPath !== null && isMountablePath(resolvedPath, home)
    ? `${cli} ${pathDetail}, under $HOME or SYSTEM_ROOTS, but was not reachable via \`command -v\` inside the curated SYSTEM_ROOTS-only namespace (a real dispatch also binds $HOME toolchain leaves separately).`
    : `${cli} ${pathDetail} and is not reachable inside a bwrap namespace mirroring the curated SYSTEM_ROOTS jail — dispatch will refuse with CLI_PATH_NOT_MOUNTABLE.`;
  return { family, cli, resolvedPath, mountable, detail };
}

/** Per-backend CLI reachability probes for check-environment (WK-0174). */
export async function probeCliReachability(): Promise<CliReachability[]> {
  const home = resolveHomePath();
  return Promise.all(CLI_BACKENDS.map(({ family, cli }) => probeOneCliReachability(family, cli, home)));
}

// ---------------------------------------------------------------------------
// Endpoint-eligibility probe (WK-0189): config-time, operator-initiated. A
// backend's `request_params.provider`/`zdr` constraints can exclude every
// endpoint for a given model (OpenRouter's guardrail/data-policy routing),
// which only HO-0064/HO-0065's live dispatches discovered by burning a full
// cycle. The constraint set is static config (backends.json + the model
// id), so one minimal dry-run completion per qualifying backend×model pair,
// fired here rather than per-dispatch, tells the operator up front — 404
// (OpenRouter's structured "0 endpoints... matching your guardrail
// restrictions" body) vs. anything else IS the verdict, no classification
// beyond that. Captured evidence for the 404 shape: RUN-089e6deb /
// RUN-51fec485 (`tests/fixtures/pi-output-errored-single-message.jsonl`,
// `pi-output-errored-404-account-zdr.jsonl`), both unedited. An eligible
// response is an ordinary completed Pi/OpenRouter run — already captured
// (`tests/fixtures/pi-output-code-review.jsonl`, provider "openrouter",
// model "deepseek/deepseek-v4-flash-0731" — the exact model the
// "deepseek"/"openrouter-oss" pair resolves to) — so no new [UNVERIFIED-
// SHAPE] capture is needed for that side of the verdict (DEC-0009).
// ---------------------------------------------------------------------------

/** One reason OpenRouter excluded every endpoint for a probed model, echoed verbatim from its 404 body. */
export interface OpenRouterIneligibilityReason {
  reason: string;
  endpoint_count: number;
  configure_url: string;
}

export interface EndpointEligibilityVerdict {
  backend: string;
  modelAlias: string;
  modelId: string;
  /**
   * `unknown` covers both "not probed" (no resolvable API key — e.g. no
   * secrets file in this host/sandbox) and "probe ran but errored without
   * OpenRouter's structured ineligibility shape" — neither is evidence of
   * eligibility, so neither is reported as `eligible`.
   */
  status: 'eligible' | 'ineligible' | 'unknown';
  detail: string;
  /** Verbatim from OpenRouter's 404 `metadata.ineligibility_reasons`; null unless `status === 'ineligible'`. */
  ineligibilityReasons: OpenRouterIneligibilityReason[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse OpenRouter's structured 404 body out of a Pi `errorMessage` string
 * (Pi prefixes it `"404: "` before the JSON — see the captured fixtures).
 * Returns null for anything that isn't that exact shape: a non-404 `code`,
 * a missing/malformed `metadata.ineligibility_reasons` array, or JSON that
 * doesn't parse at all. Deterministic, no classification beyond this shape
 * check (rule 17).
 */
function parseOpenRouterIneligibility(errorMessage: string): OpenRouterIneligibilityReason[] | null {
  const jsonStart = errorMessage.indexOf('{');
  if (jsonStart === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(errorMessage.slice(jsonStart));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.code !== 404) return null;

  const metadata = parsed.metadata;
  if (!isRecord(metadata) || !Array.isArray(metadata.ineligibility_reasons)) return null;

  const reasons: OpenRouterIneligibilityReason[] = [];
  for (const entry of metadata.ineligibility_reasons) {
    if (
      isRecord(entry) &&
      typeof entry.reason === 'string' &&
      typeof entry.endpoint_count === 'number' &&
      typeof entry.configure_url === 'string'
    ) {
      reasons.push({ reason: entry.reason, endpoint_count: entry.endpoint_count, configure_url: entry.configure_url });
    }
  }
  return reasons.length > 0 ? reasons : null;
}

/**
 * Derive the eligibility verdict from one dry-run probe's raw Pi `--mode
 * json` stdout — pure function, golden-fixture testable without a live
 * network call. Scans for a `message_end`/`turn_end` event whose `message.
 * stopReason` is `"error"` (verified against the real captured fixtures —
 * `stopReason`/`errorMessage` ride on the nested `message` object, NOT the
 * top-level event, contrary to `adapters/pi.ts`'s `parsePiOutput`, which
 * reads `event.stopReason` and so never observes this signal on these same
 * fixtures; that is WK-0187's pre-existing bug to fix, out of this WK's
 * write scope, so this probe parses the raw stream itself rather than
 * reusing `parsePiOutput`). If `message.errorMessage` carries OpenRouter's
 * structured ineligibility body, `ineligible`; if the stream errored
 * WITHOUT that shape, `unknown` (an unrelated failure is not evidence of
 * eligibility); otherwise `eligible`.
 */
export function deriveEndpointEligibility(
  backendName: string,
  modelAlias: string,
  modelId: string,
  piStdout: string,
): EndpointEligibilityVerdict {
  const base = { backend: backendName, modelAlias, modelId };
  const lines = piStdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type !== 'message_end' && event.type !== 'turn_end') continue;
    const message = event.message;
    if (!isRecord(message) || message.stopReason !== 'error' || typeof message.errorMessage !== 'string') continue;

    const reasons = parseOpenRouterIneligibility(message.errorMessage);
    if (reasons) {
      const urls = reasons.map((r) => r.configure_url).join(', ');
      return {
        ...base,
        status: 'ineligible',
        detail: `OpenRouter returned 0 eligible endpoints for "${modelId}" under "${backendName}"'s provider/ZDR constraints. Configure: ${urls}`,
        ineligibilityReasons: reasons,
      };
    }
    return {
      ...base,
      status: 'unknown',
      detail: `Dry-run probe for "${modelId}" on "${backendName}" errored without OpenRouter's structured ineligibility shape: ${message.errorMessage}`,
      ineligibilityReasons: null,
    };
  }

  return {
    ...base,
    status: 'eligible',
    detail: `Dry-run probe for "${modelId}" on "${backendName}" completed with no OpenRouter ineligibility error.`,
    ineligibilityReasons: null,
  };
}

/** `grep -m1 '^VAR=' file | cut -d= -f2-` equivalent, Node-side (credentials.ts's script-side-only rule is about the generated DISPATCH script; this probe is a direct, operator-initiated host-side process, same trust boundary as the `pi` CLI it spawns). Returns null when the file or the var line is absent. */
async function resolveSecretValue(secretsFile: string, varName: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(secretsFile, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${varName}=`)) {
      return trimmed.slice(varName.length + 1);
    }
  }
  return null;
}

/** Candidate pairs: pi-family backends whose `request_params` carries `provider` or `zdr`, crossed with every model whose `available_on` names that backend. */
function selectEligibilityCandidates(
  backends: Record<string, BackendEntry>,
  models: Record<string, ModelTableEntry>,
): Array<{ backendName: string; backend: BackendEntry; modelAlias: string; modelEntry: ModelTableEntry }> {
  const candidates: Array<{ backendName: string; backend: BackendEntry; modelAlias: string; modelEntry: ModelTableEntry }> = [];
  for (const [backendName, backend] of Object.entries(backends)) {
    if (backend.family !== 'pi') continue;
    const params = backend.request_params;
    if (!isRecord(params) || !('provider' in params || 'zdr' in params)) continue;

    for (const [modelAlias, modelEntry] of Object.entries(models)) {
      if (modelEntry.available_on.includes(backendName)) {
        candidates.push({ backendName, backend, modelAlias, modelEntry });
      }
    }
  }
  return candidates;
}

/** One minimal (max_tokens: 1) dry-run completion against a real backend×model pair. */
async function probeOneEndpointEligibility(
  backendName: string,
  backend: BackendEntry,
  modelAlias: string,
  modelEntry: ModelTableEntry,
): Promise<EndpointEligibilityVerdict> {
  const base = { backend: backendName, modelAlias, modelId: modelEntry.model_id };

  if (backend.base_url === null) {
    return { ...base, status: 'unknown', detail: `Backend "${backendName}" has no base_url; cannot fire a dry-run completion.`, ineligibilityReasons: null };
  }

  const apiKeyValue = backend.api_key_env && backend.secrets_file
    ? await resolveSecretValue(backend.secrets_file, backend.api_key_env)
    : null;
  if (backend.api_key_env !== null && apiKeyValue === null) {
    return {
      ...base,
      status: 'unknown',
      detail: `Could not resolve "${backend.api_key_env}" from ${backend.secrets_file ?? '(no secrets_file configured)'}; skipped the dry-run probe for "${modelEntry.model_id}" on "${backendName}".`,
      ineligibilityReasons: null,
    };
  }

  const model: ModelEntry = {
    provider: backendName,
    modelId: modelEntry.model_id,
    displayName: `${modelAlias} (${backendName})`,
    baseUrl: backend.base_url,
    api: 'openai-completions',
    apiKeyEnv: backend.api_key_env,
    contextWindow: 4096,
    maxTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), 'kb-eligibility-'));
    const promptPath = join(workDir, 'prompt.txt');
    await writeFile(promptPath, 'ping', 'utf8');

    const invocation = buildInvocation(promptPath, model, workDir, workDir);
    const modelsJsonContent = backend.request_params
      ? JSON.stringify(buildModelsJson(model, backend.request_params))
      : invocation.modelsJsonContent;
    await writeFile(join(workDir, 'models.json'), modelsJsonContent, 'utf8');

    const env: Record<string, string | undefined> = { ...process.env, ...invocation.env };
    if (model.apiKeyEnv && apiKeyValue !== null) {
      env[model.apiKeyEnv] = apiKeyValue;
    }

    const result = await runProcess(invocation.cmd, invocation.args, env, 30000);
    return deriveEndpointEligibility(backendName, modelAlias, modelEntry.model_id, result.stdout);
  } catch (err) {
    return {
      ...base,
      status: 'unknown',
      detail: `Dry-run probe for "${modelEntry.model_id}" on "${backendName}" failed to run: ${String(err)}`,
      ineligibilityReasons: null,
    };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Endpoint-eligibility probes for check-environment (WK-0189). Loads
 * `wiki/.dispatch/{backends,models}.json` from `dir`, selects every
 * provider-pin/ZDR-constrained pi-family backend×model pair, and fires one
 * minimal dry-run completion per pair. Absent config, or no qualifying
 * pairs, resolves to `[]` with no file I/O beyond the two table loads and
 * no network call — the zero-cost path this WK requires when the probe
 * doesn't apply.
 */
export async function probeEndpointEligibility(dir: string): Promise<EndpointEligibilityVerdict[]> {
  const [backendsResult, modelsResult] = await Promise.all([loadBackendsTable(dir), loadModelsTable(dir)]);
  if (!backendsResult.ok || !modelsResult.ok) return [];

  const candidates = selectEligibilityCandidates(backendsResult.data, modelsResult.data);
  return Promise.all(
    candidates.map(({ backendName, backend, modelAlias, modelEntry }) =>
      probeOneEndpointEligibility(backendName, backend, modelAlias, modelEntry),
    ),
  );
}

// ---------------------------------------------------------------------------
// Route-viability verdicts (derived, not persisted)
// ---------------------------------------------------------------------------

/**
 * Derive the dispatch route verdict from the bwrap probe (WK-0134 / WK-0133 D1).
 *
 * v2 gates every dispatch — any agent family, any mode — on ONE fact: does bwrap
 * work end-to-end (`tier.ts probeBwrap()`)? `pipeline.ts:650` runs the identical
 * probe at dispatch time and refuses with `NO_ISOLATION_ROUTE` when it fails; this
 * mirrors that exact gate so `check-environment` reports what a real dispatch will
 * do, not a v1 per-family/per-mode approximation of it.
 */
export function deriveRouteVerdicts(bwrap: BwrapProbeResult): RouteVerdict[] {
  if (bwrap.available) {
    return [{
      route: 'dispatch',
      viability: 'available',
      detail: 'bubblewrap is available with a working --unshare-user; the v2 pipeline can dispatch any agent family.',
    }];
  }

  const remediation = bwrap.bwrapVersion === null ? MISSING_BWRAP_TEXT : APPARMOR_REMEDIATION_TEXT;
  return [{
    route: 'dispatch',
    viability: 'blocked',
    detail: `No isolation route: dispatch will refuse with NO_ISOLATION_ROUTE. ${remediation}`,
  }];
}

// ---------------------------------------------------------------------------
// check-environment (WK-0134 / WK-0133 D1 option b): a thin stateless probe.
// No registry, no persisted host-capabilities.json, no config dir dependency
// beyond the informational writability check below.
// ---------------------------------------------------------------------------

export async function checkEnvironment(dir: string = process.cwd()): Promise<DispatchResult<CheckEnvironmentResult>> {
  const checkedAt = new Date().toISOString();
  const [bwrap, container, writability, cliReachability, endpointEligibility] = await Promise.all([
    probeBwrap(),
    detectContainer(),
    probeWritability(),
    probeCliReachability(),
    probeEndpointEligibility(dir),
  ]);

  return ok({
    checkedAt,
    platform: process.platform,
    arch: process.arch,
    bwrap,
    container,
    writability,
    cliReachability,
    endpointEligibility,
    verdicts: deriveRouteVerdicts(bwrap),
  });
}

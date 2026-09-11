/**
 * Model registry (dispatch v2, PLN-0004 S3 Wave 2b). `resolveModelFromConfig`
 * resolves a `--model <slug> --backend <name>` dispatch-call pair (both
 * required — s3-rulings.md ruling 1) against the repo-local
 * `wiki/.dispatch/models.json` + `backends.json` two-table config
 * (repo-config.ts), superseding the S0 seed registry below. This module also
 * carries the S3 harness version gate (ruling 7) and the backend-fingerprint
 * script fragment (ruling 8): both are read alongside the resolved model at
 * the same pipeline points (preflight / script generation) even though
 * neither is a "registry lookup" in itself.
 */
import { parse, lt, gt } from 'semver';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import { loadModelsTable, loadBackendsTable } from './repo-config.js';

// ---------------------------------------------------------------------------
// S0 seed registry — DEPRECATED, superseded by resolveModelFromConfig below.
// Kept verbatim (same behavior) because pipeline.ts and adapters/pi.ts still
// import this shape; Wave 3 switches the pipeline import to
// resolveModelFromConfig and removes this section.
// ---------------------------------------------------------------------------

export interface ModelEntry {
  provider: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
  api: string;
  /** Env var name holding the API key (e.g. 'OPENROUTER_API_KEY'); null = no secret needed. */
  apiKeyEnv: string | null;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: { supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean };
}

export interface ModelRegistry {
  /** Keyed by alias, e.g. 'deepseek', 'qwen3:8b'. */
  models: Record<string, ModelEntry>;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * @deprecated S0 seed registry (execution/s0-rulings.md ruling 4) — two
 * hardcoded entries. Superseded by the repo-local two-table config resolved
 * through `resolveModelFromConfig`.
 */
export function getDefaultRegistry(): ModelRegistry {
  return {
    models: {
      deepseek: {
        provider: 'openrouter',
        modelId: 'deepseek/deepseek-v4-flash-0731',
        displayName: 'DeepSeek V4 Flash (OpenRouter)',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        contextWindow: 131072,
        maxTokens: 8192,
        cost: { ...ZERO_COST },
      },
      'qwen3:8b': {
        provider: 'ollama',
        modelId: 'qwen3:8b',
        displayName: 'Qwen3 8B (Ollama)',
        baseUrl: 'http://{{WIN_HOST}}:11434/v1',
        api: 'openai-completions',
        apiKeyEnv: null,
        contextWindow: 32768,
        maxTokens: 8192,
        cost: { ...ZERO_COST },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
    },
  };
}

/**
 * @deprecated Resolves a `--model <alias>` flag against the S0 seed registry.
 * Superseded by `resolveModelFromConfig(dir, slug, backend)`.
 */
export function resolveModel(registry: ModelRegistry, alias: string): DispatchResult<ModelEntry> {
  const entry = registry.models[alias];
  if (!entry) {
    return fail('MODEL_NOT_FOUND', `Model alias not found in registry: ${alias}`, {
      alias,
      available: Object.keys(registry.models),
    });
  }
  return ok(entry);
}

// ---------------------------------------------------------------------------
// Repo-local two-table registry resolution (S3 rulings 1, 9)
// ---------------------------------------------------------------------------

export interface ResolvedModel {
  slug: string;
  backend: string;
  modelId: string;
  baseUrl: string;
  apiKeyEnv: string | null;
  secretsFile: string | null;
  availableOn: string[];
  /** Whether the backend supports effort/reasoning params (false for all current open-model backends). */
  supportsEffort: boolean;
}

/**
 * Resolve `--model <slug> --backend <name>` (both required — s3-rulings.md
 * ruling 1) against `wiki/.dispatch/models.json` + `backends.json`. An
 * `available_on` mismatch between the two tables is a warning, never a
 * refusal (ruling 1) — the tables are independently operator-edited, so a
 * backend the models table hasn't caught up to listing must not block a
 * dispatch. Absent tables resolve to empty maps (repo-config.ts's valid-empty
 * semantics), so a missing `wiki/.dispatch/` dir surfaces here as an ordinary
 * `MODEL_NOT_FOUND` with an empty `available` list rather than a distinct
 * error path.
 */
export async function resolveModelFromConfig(
  dir: string,
  slug: string,
  backend: string,
): Promise<DispatchResult<ResolvedModel>> {
  const modelsResult = await loadModelsTable(dir);
  if (!modelsResult.ok) return modelsResult;

  const backendsResult = await loadBackendsTable(dir);
  if (!backendsResult.ok) return backendsResult;

  const modelEntry = modelsResult.data[slug];
  if (!modelEntry) {
    return fail('MODEL_NOT_FOUND', `Model slug not found in models.json: ${slug}`, {
      slug,
      available: Object.keys(modelsResult.data),
    });
  }

  const backendEntry = backendsResult.data[backend];
  if (!backendEntry) {
    return fail('MODEL_NOT_FOUND', `Backend not found in backends.json: ${backend}`, {
      backend,
      available: Object.keys(backendsResult.data),
    });
  }

  if (!modelEntry.available_on.includes(backend)) {
    console.warn(
      `Warning: model "${slug}" does not list backend "${backend}" in available_on (has: ${modelEntry.available_on.join(', ') || 'none'}); proceeding (s3-rulings.md ruling 1).`,
    );
  }

  return ok({
    slug,
    backend,
    modelId: modelEntry.model_id,
    baseUrl: backendEntry.base_url,
    apiKeyEnv: backendEntry.api_key_env,
    secretsFile: backendEntry.secrets_file,
    availableOn: modelEntry.available_on,
    // Hardcoded for every current open-model backend; becomes per-model
    // metadata at a future slice (ruling 9 / s3-rulings.md deferral list).
    supportsEffort: false,
  });
}

// ---------------------------------------------------------------------------
// Harness version gate (S3 ruling 7)
// ---------------------------------------------------------------------------

export const PI_HARNESS_INFO = {
  package: '@earendil-works/pi-coding-agent',
  testedWith: '0.85.1',
  knownGood: '0.85.0',
  installCmd: 'npm install -g @earendil-works/pi-coding-agent@0.85.1',
} as const;

export interface VersionGateResult {
  status: 'ok' | 'warn' | 'refuse';
  version: string;
  message: string;
}

/**
 * Gate the Pi harness version reported by preflight's `PI_VERSION` probe
 * against the in-code `PI_HARNESS_INFO` constant — kb's only compatibility
 * claim, shipped with kb code rather than a `wiki/.dispatch` file (ruling 7's
 * post-D2 amendment). Fails closed: unparseable or below `knownGood` both
 * refuse; above `testedWith` warns and proceeds.
 */
export function checkHarnessVersion(versionString: string): VersionGateResult {
  if (!parse(versionString)) {
    return {
      status: 'refuse',
      version: versionString,
      message: `Cannot parse Pi version "${versionString}" as semver.`,
    };
  }

  if (lt(versionString, PI_HARNESS_INFO.knownGood)) {
    return {
      status: 'refuse',
      version: versionString,
      message: `Pi version ${versionString} is below known-good ${PI_HARNESS_INFO.knownGood}; run: ${PI_HARNESS_INFO.installCmd}`,
    };
  }

  if (gt(versionString, PI_HARNESS_INFO.testedWith)) {
    return {
      status: 'warn',
      version: versionString,
      message: `Pi version ${versionString} is above tested ${PI_HARNESS_INFO.testedWith}; proceeding but untested.`,
    };
  }

  return {
    status: 'ok',
    version: versionString,
    message: `Pi version ${versionString} is within the tested range (${PI_HARNESS_INFO.knownGood}-${PI_HARNESS_INFO.testedWith}).`,
  };
}

// ---------------------------------------------------------------------------
// Backend fingerprint (S3 ruling 8)
// ---------------------------------------------------------------------------

export interface BackendFingerprint {
  serverVersion: string | null;
  host: string;
  model: string;
}

/** Single-quote a value for safe embedding in generated bash (escapes embedded quotes). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Extract a URL's hostname for the fingerprint's `_FP_HOST`; falls back to the raw string rather than throwing on an unparseable baseUrl. */
function extractHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/** Strip a trailing `/v1` (OpenAI-compat suffix) so native version endpoints (`/api/version`, `/version`) can be built off the bare host root. */
function stripV1Suffix(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

type BackendKind = 'ollama' | 'vllm' | 'other';

/** Best-effort backend-kind detection from the resolved backend name / base URL — never authoritative, only picks which (if any) version probe to attempt. */
function detectBackendKind(resolvedModel: ResolvedModel): BackendKind {
  const signal = `${resolvedModel.backend} ${resolvedModel.baseUrl}`.toLowerCase();
  if (signal.includes('ollama') || signal.includes(':11434')) return 'ollama';
  if (signal.includes('vllm')) return 'vllm';
  return 'other';
}

/**
 * Build the bash lines that probe the resolved backend's version endpoint
 * from inside the generated execution script — best-effort, facts-only,
 * NEVER gating (ruling 8): a failed/timed-out curl always falls through to
 * `"unknown"` rather than aborting the script. Backend kind is detected from
 * the backend name / base URL (Ollama: `/api/version`; vLLM: `/version`);
 * anything else (serverless providers like OpenRouter) has no such endpoint
 * to probe and is stamped `"unknown"` directly.
 */
export function buildFingerprintFragment(resolvedModel: ResolvedModel): string[] {
  const kind = detectBackendKind(resolvedModel);
  const rootUrl = stripV1Suffix(resolvedModel.baseUrl);

  const lines: string[] = [
    '# Backend fingerprint (best-effort, never gating; s3 ruling 8)',
    `_FP_HOST=${shQuote(extractHostname(resolvedModel.baseUrl))}`,
    `_FP_MODEL=${shQuote(resolvedModel.modelId)}`,
  ];

  if (kind === 'ollama') {
    lines.push(
      `_FP_VERSION=$(curl -s -m 2 ${shQuote(`${rootUrl}/api/version`)} 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "unknown")`,
    );
  } else if (kind === 'vllm') {
    lines.push(
      `_FP_VERSION=$(curl -s -m 2 ${shQuote(`${rootUrl}/version`)} 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "unknown")`,
    );
  } else {
    lines.push('_FP_VERSION="unknown"');
  }

  lines.push('echo "BACKEND_FINGERPRINT=$_FP_HOST|$_FP_MODEL|$_FP_VERSION"');
  return lines;
}

/**
 * Parse the `BACKEND_FINGERPRINT=host|model|version` line emitted by
 * `buildFingerprintFragment`'s script. `"unknown"` (the script's own
 * best-effort fallback, or its explicit stamp for un-probed backend kinds)
 * normalizes to `null` — only a real version string counts as a known
 * `serverVersion`. Returns null when the line is absent entirely.
 */
export function parseFingerprintOutput(stdout: string): BackendFingerprint | null {
  const normalized = stdout.replace(/\r\n/g, '\n');
  const line = normalized.split('\n').find((l) => l.startsWith('BACKEND_FINGERPRINT='));
  if (!line) return null;

  const value = line.slice('BACKEND_FINGERPRINT='.length).trim();
  const [host, model, version] = value.split('|');
  if (host === undefined || model === undefined || version === undefined) return null;

  return {
    serverVersion: version === 'unknown' || version === '' ? null : version,
    host,
    model,
  };
}

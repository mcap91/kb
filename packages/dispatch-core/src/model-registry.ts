/**
 * Model registry (T23 S0 seed). Un-supersedes WK-0070: a minimal seed of the two
 * models actually in rotation for the S0 gate proof (execution/s0-rulings.md
 * ruling 4) — OpenRouter deepseek for the live-verified WK-0073 model, and Ollama
 * qwen3:8b for the WK-0073 2b-proven generic-endpoint path. S3 grows this into
 * `init-config`-scaffolded local overrides; format follows Pi's models.json shape
 * (adapters/pi.ts builds the actual Pi config from a ModelEntry).
 */
import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';

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

// New v2 error code produced by this module; will be merged into the shared
// DispatchErrorCode union in errors.ts at wave-3 integration. errors.ts is not
// modified by this file (wave-1 constraint).
type ModelRegistryErrorCode = 'MODEL_NOT_FOUND';

function fail<T = never>(message: string, detail?: unknown): DispatchResult<T> {
  return { ok: false, error: 'MODEL_NOT_FOUND' as ModelRegistryErrorCode, message, detail } as unknown as DispatchResult<T>;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * Hardcoded S0 seed registry — two entries (execution/s0-rulings.md ruling 4 / T23):
 *
 * - `deepseek`: OpenRouter `deepseek/deepseek-v4-flash-0731` (WK-0073 pick, live-verified).
 * - `qwen3:8b`: Ollama on the operator's Windows host, reached from WSL2 via the
 *   `{{WIN_HOST}}` template — resolved at spawn time by wsl2.ts (Wave 2), not here.
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
 * Resolve a `--model <alias>` flag (WK-0069 seam: model is a dispatch-call
 * parameter, never HO frontmatter) to its registry entry.
 */
export function resolveModel(registry: ModelRegistry, alias: string): DispatchResult<ModelEntry> {
  const entry = registry.models[alias];
  if (!entry) {
    return fail(`Model alias not found in registry: ${alias}`, { alias, available: Object.keys(registry.models) });
  }
  return ok(entry);
}

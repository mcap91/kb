/**
 * Claude Code adapter (WK-0073 landscape / T4 S6c; spec D10 / §8 adapter
 * interface: "Adapters may not gate, decide policy, touch credentials, or
 * build shell strings elsewhere" — the launcher owns all policy). This
 * module only reports the invocation shape and parses `claude -p`'s own
 * result object; it never spawns a process itself.
 *
 * Key facts baked in from real `claude -p --output-format json` captures
 * (DEC-0009 golden fixtures under `tests/fixtures/claude-p-output*`):
 * - `--output-format json` produces exactly ONE JSON object on stdout (not
 *   JSON-lines like Pi/Codex) — the whole of stdout is one blob to parse.
 *   Verified against `claude-p-output.txt` (success),
 *   `claude-p-output-model-not-found.txt` (error), and
 *   `claude-p-output-permission-denied.txt` (denied), each a single line.
 * - `is_error: true` (`claude-p-output-model-not-found.txt`, a bad model)
 *   is the only reliable error signal; the run's own `stop_reason` is
 *   misleading there (`"stop_sequence"` on a 404 API error) — this adapter
 *   reports `api_error_status` (stringified) when present, falling back to
 *   `terminal_reason`.
 * - A tool-permission denial does NOT set `is_error` — it surfaces only as
 *   a non-empty `permission_denials` array with `is_error: false` and a
 *   `result` string narrating the block
 *   (`claude-p-output-permission-denied.txt`). Trusting `is_error` alone
 *   would misreport a permission-blocked run as `completed`.
 * - `result` (string) carries the worker's final reply in EVERY observed
 *   case — success, error, and permission-denied all have it — so it is
 *   read as `lastAssistantText` unconditionally.
 * - The prompt is passed as a bare positional argument AFTER a `--`
 *   terminator, never inline as `-p`'s value — verified against
 *   agent-chassis's `composeClaudeArgv`
 *   (`workspace-agent-claude-launch-support.mjs:195-199`):
 *   `[...optionArgs, '--', prompt]`.
 */
import type { DispatchResult } from '../errors.js';
import { ok } from '../errors.js';
import type { ResolvedModel } from '../model-registry.js';

export interface ClaudeInvocation {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface ClaudeUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ClaudeResult {
  outcome: 'completed' | 'failed' | 'error';
  stopReason?: string;
  usage: ClaudeUsage;
  /**
   * The `result` field of Claude's JSON output — the worker's final reply,
   * present in every observed case (success, error, permission-denied).
   * The `kb-dispatch-recovery.v1` terminal-block extractor
   * (`recovery-block.ts`'s `extractRecoveryBlock`) reads from this field,
   * mirroring the Pi/Codex adapters' `lastAssistantText`.
   */
  lastAssistantText: string;
  /** `permission_denials.length` — non-zero flips `outcome` to `failed` even though Claude leaves `is_error: false` on a tool-permission block. */
  permissionDenials: number;
  numTurns: number;
}

// New v2 error code produced by this module; shares the ADAPTER_FAILED code
// already defined in errors.ts's DispatchErrorCode union (see adapters/pi.ts).
type AdapterErrorCode = 'ADAPTER_FAILED';

function fail<T = never>(message: string, detail?: unknown): DispatchResult<T> {
  return { ok: false, error: 'ADAPTER_FAILED' as AdapterErrorCode, message, detail } as unknown as DispatchResult<T>;
}

/**
 * Build the Claude invocation shape (argv + env + cwd) for a single run.
 * Facts only — this does not spawn anything; the launcher (pipeline.ts) does.
 *
 * The prompt is appended as a bare positional arg after `--`, matching
 * `claude`'s own argv-terminator contract (see module doc comment) rather
 * than being passed inline as `-p`'s value.
 *
 * `settingsPath` (D2 ruling 2, PLN-0004
 * `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md:149-201`) is
 * threaded in rather than decided here (D10: adapters don't decide policy) —
 * pipeline.ts builds the settings.json content (the Edit() allow-list keyed
 * off write_scope) and passes its injected in-jail path here. When provided,
 * `--permission-mode default` replaces the old blanket `acceptEdits` bypass,
 * making that settings.json allow-list the sole grant, and `--settings
 * <settingsPath>` is added. When omitted, behavior is unchanged
 * (`--permission-mode acceptEdits`, no `--settings`) — backward compatible
 * for any caller that hasn't adopted the settings.json path yet.
 */
export function buildInvocation(
  promptText: string,
  model: ResolvedModel,
  clonePath: string,
  settingsPath?: string,
): ClaudeInvocation {
  const env: Record<string, string> = {};
  if (model.apiKeyEnv) {
    // Placeholder reference only — the real value is sourced from secrets.env
    // at spawn time (mirrors adapters/pi.ts's convention), never assembled here.
    env[model.apiKeyEnv] = `$${model.apiKeyEnv}`;
  }

  const permissionArgs =
    settingsPath !== undefined
      ? ['--permission-mode', 'default', '--settings', settingsPath]
      : ['--permission-mode', 'acceptEdits'];

  return {
    cmd: 'claude',
    args: [
      '-p',
      '--output-format',
      'json',
      ...permissionArgs,
      '--model',
      model.modelId,
      '--',
      promptText,
    ],
    env,
    cwd: clonePath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extract usage numbers from the parsed result object — `usage.*` token
 * counts plus the sibling top-level `total_cost_usd` — defaulting any
 * missing/non-numeric field to 0. Defensive, since a hand-derived edge-case
 * fixture (DEC-0009 §3: mutated from a real capture) may carry a partial
 * object.
 */
function extractUsage(event: Record<string, unknown>): ClaudeUsage {
  const usage: Record<string, unknown> = isRecord(event.usage) ? event.usage : {};
  return {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    cacheCreationInputTokens:
      typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
    cacheReadInputTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0,
  };
}

/**
 * Parse `claude -p --output-format json`'s stdout — a SINGLE JSON object,
 * not JSON-lines (contrast Pi/Codex). Returns ADAPTER_FAILED only when
 * stdout doesn't parse as JSON at all (e.g. the CLI crashed before emitting
 * its result object, or was invoked without `--output-format json`).
 */
export function parseClaudeOutput(stdout: string): DispatchResult<ClaudeResult> {
  let event: unknown;
  try {
    event = JSON.parse(stdout.trim());
  } catch (err) {
    return fail('Claude stdout did not parse as JSON.', {
      rawLength: stdout.length,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (!isRecord(event)) {
    return fail('Claude stdout parsed but was not a JSON object.', { parsed: event });
  }

  const usage = extractUsage(event);
  const lastAssistantText = typeof event.result === 'string' ? event.result : '';
  const numTurns = typeof event.num_turns === 'number' ? event.num_turns : 0;
  const permissionDenials = Array.isArray(event.permission_denials) ? event.permission_denials.length : 0;

  if (event.is_error === true) {
    // The run's own `stop_reason` can be misleading on an API error (e.g.
    // "stop_sequence" on a 404 — see module doc comment), so the error path
    // reports `api_error_status` first, falling back to `terminal_reason`.
    const stopReason =
      event.api_error_status !== null && event.api_error_status !== undefined
        ? String(event.api_error_status)
        : typeof event.terminal_reason === 'string'
          ? event.terminal_reason
          : undefined;
    return ok({ outcome: 'error', stopReason, usage, lastAssistantText, permissionDenials, numTurns });
  }

  if (permissionDenials > 0) {
    // `is_error` stays false on a tool-permission block — only the
    // non-empty `permission_denials` array reveals the failure (module doc
    // comment).
    return ok({
      outcome: 'failed',
      stopReason: 'permission_denied',
      usage,
      lastAssistantText,
      permissionDenials,
      numTurns,
    });
  }

  return ok({
    outcome: 'completed',
    stopReason: typeof event.stop_reason === 'string' ? event.stop_reason : undefined,
    usage,
    lastAssistantText,
    permissionDenials,
    numTurns,
  });
}

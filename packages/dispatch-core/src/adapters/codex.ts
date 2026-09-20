/**
 * Codex coding-agent adapter (WK-0073 landscape / T33 family; spec D10 / §8
 * adapter interface: "Adapters may not gate, decide policy, touch
 * credentials, or build shell strings elsewhere" — the launcher owns all
 * policy). This module only reports the invocation shape and parses Codex's
 * own JSON-lines event stream (`codex exec --json`); it never spawns a
 * process itself.
 *
 * Key facts baked in from real `codex exec` captures (DEC-0009 golden
 * fixtures under `tests/fixtures/codex-exec-output-*`):
 * - The CLI default sandbox is read-only; `tests/fixtures/codex-exec-output-
 *   permission-denied.txt` captures a write attempt under `read-only`: the
 *   model narrates the patch, `codex_core::tools::router` logs `patch
 *   rejected: writing is blocked by read-only sandbox`, and no file is ever
 *   written — this is why advisory modes (code_review/redteam/research),
 *   which get no write_scope at all, still pass `read-only`. Implement-mode
 *   runs pass `danger-full-access` (D2 ruling 2, PLN-0004
 *   `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md:149-201`):
 *   bwrap's own exact-file kernel binds (`jail.ts`'s
 *   `deriveExactFileMounts`) are the real enforcement boundary, so Codex's
 *   own `workspace-write` sandbox would only double-restrict inside a jail
 *   that already confines it.
 * - `--json` produces JSON-lines events on stdout. Exit code is 0 for BOTH a
 *   successful run and a sandbox-blocked run (same fixture) — never usable
 *   alone as an outcome signal, mirroring the Pi adapter's WK-0091 ruling;
 *   the pipeline, not this adapter, owns outcome policy beyond parse-level
 *   facts.
 * - `-o <file>` mirrors the run's last agent_message text to a file; this
 *   adapter reports that path in the invocation shape (`outputLastMessagePath`)
 *   but never reads or writes it itself.
 * - `turn.completed` carries the run's token `usage` object — verified
 *   against `tests/fixtures/codex-exec-output-stream-json.jsonl`:
 *   `{input_tokens, cached_input_tokens, cache_write_input_tokens,
 *   output_tokens, reasoning_output_tokens}`. There is no cost figure in
 *   Codex output (unlike Pi/Claude).
 * - `item.completed` events of `type: "agent_message"` carry a plain string
 *   `.text` field (not a content-block array like Pi's `message_end`) — the
 *   worker's narration for one step. The LAST such item in the stream is the
 *   worker's final reply (recovery-block source), mirroring Pi's
 *   `lastAssistantText`.
 * - The model-not-found and permission-denied fixtures are captured WITHOUT
 *   `--json` (human-readable banner/narration text, no JSON on any line) —
 *   they exercise this adapter's ADAPTER_FAILED path, not event parsing.
 */
import type { DispatchResult } from '../errors.js';
import { ok } from '../errors.js';
import type { ResolvedModel } from '../model-registry.js';

export interface CodexInvocation {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Path passed to `-o`; Codex mirrors the last agent_message text here — the recovery-block extractor reads from this path. */
  outputLastMessagePath: string;
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexResult {
  outcome: 'completed' | 'failed' | 'error';
  stopReason?: string;
  usage: CodexUsage;
  /**
   * `.text` of the LAST `item.completed` event with `item.type ===
   * "agent_message"` in the stream — the worker's final reply. `''` when the
   * stream carried no `agent_message` item at all.
   *
   * The `kb-dispatch-recovery.v1` terminal-block extractor
   * (`recovery-block.ts`'s `extractRecoveryBlock`) reads from THIS field, not
   * a whole-stream concatenation — an agentic worker narrates intermediate
   * steps before producing its terminal fenced block, so isolating the final
   * message here (in the one place that already walks the event stream, D10
   * facts-only) mirrors the Pi adapter's `lastAssistantText`.
   */
  lastAssistantText: string;
}

// New v2 error code produced by this module; shares the ADAPTER_FAILED code
// already defined in errors.ts's DispatchErrorCode union (see adapters/pi.ts).
type AdapterErrorCode = 'ADAPTER_FAILED';

function fail<T = never>(message: string, detail?: unknown): DispatchResult<T> {
  return { ok: false, error: 'ADAPTER_FAILED' as AdapterErrorCode, message, detail } as unknown as DispatchResult<T>;
}

/**
 * Build the Codex invocation shape (argv + env + cwd) for a single run.
 * Facts only — this does not spawn anything; the launcher (pipeline.ts) does.
 *
 * `sandbox` is threaded in rather than decided here (D10: adapters don't
 * decide policy) — callers pass `danger-full-access` for implement mode
 * (D2 ruling 2 — bwrap is the enforcement; Codex's own sandbox would
 * double-restrict) and `read-only` for advisory modes
 * (code_review/redteam/research). `workspace-write` remains a valid value
 * this adapter will pass through unchanged; no caller in this codebase
 * currently selects it.
 *
 * `effort` (WK-0122), when present, appends `-c model_reasoning_effort=<level>`
 * — no quotes around the value (WK-0069 note: codex's `-c` parser accepts a
 * bare `key=value` token). This is the adapter's own facts-only report of
 * Codex's one real invocation shape; the pipeline's separate, config-driven
 * splice into its hand-built exec line (pipeline.ts's buildEffortArgs) is
 * what actually runs, and currently produces the same tokens for the codex
 * family.
 */
export function buildInvocation(
  promptText: string,
  model: ResolvedModel,
  clonePath: string,
  outputPath: string,
  sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
  effort?: string,
): CodexInvocation {
  const env: Record<string, string> = {};
  if (model.apiKeyEnv) {
    // Placeholder reference only — the real value is sourced from secrets.env
    // at spawn time (mirrors adapters/pi.ts's convention), never assembled here.
    env[model.apiKeyEnv] = `$${model.apiKeyEnv}`;
  }

  const args = ['exec', promptText, '--sandbox', sandbox, '--json', '-o', outputPath, '--model', model.modelId];
  if (effort) {
    args.push('-c', `model_reasoning_effort=${effort}`);
  }

  return {
    cmd: 'codex',
    args,
    env,
    cwd: clonePath,
    outputLastMessagePath: outputPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extract the `turn.completed` `usage` object's known numeric fields,
 * defaulting any missing/non-numeric field to 0 — defensive, since a
 * hand-derived edge-case fixture (DEC-0009 §3: mutated from a real capture)
 * may carry a partial object.
 */
function extractUsage(usage: Record<string, unknown>): CodexUsage {
  return {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    cachedInputTokens: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    reasoningOutputTokens: typeof usage.reasoning_output_tokens === 'number' ? usage.reasoning_output_tokens : 0,
  };
}

const ZERO_USAGE: CodexUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };

/**
 * Parse Codex's JSON-lines stdout (`codex exec --json`). Non-JSON lines are
 * skipped (same tolerance as the Pi adapter) — plain-text, non-`--json`
 * Codex output (e.g. the model-not-found and permission-denied fixtures) has
 * no JSON on any line, so it always falls through to the ADAPTER_FAILED path
 * below rather than half-parsing banner/narration text as events. Returns
 * ADAPTER_FAILED only when the stream has content but none of it parses as
 * JSON at all.
 */
export function parseCodexOutput(stdout: string): DispatchResult<CodexResult> {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let parsedCount = 0;
  let lastAssistantText = '';
  let usage: CodexUsage = ZERO_USAGE;

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Skip non-JSON lines (stray banners, etc.) — facts-only parsing tolerates them.
      continue;
    }
    parsedCount++;

    if (!isRecord(event)) continue;
    const type = event.type;

    if (type === 'item.completed' && isRecord(event.item) && event.item.type === 'agent_message') {
      // Overwritten on every agent_message item.completed, so after the loop
      // this holds the LAST one — see `lastAssistantText`'s doc comment.
      if (typeof event.item.text === 'string') {
        lastAssistantText = event.item.text;
      }
    }

    if (type === 'turn.completed' && isRecord(event.usage)) {
      usage = extractUsage(event.usage);
    }
  }

  if (lines.length > 0 && parsedCount === 0) {
    return fail('No parseable JSON-lines events found in Codex output.', { rawLineCount: lines.length });
  }

  if (parsedCount === 0) {
    return ok({
      outcome: 'failed',
      stopReason: 'empty_stream',
      usage: ZERO_USAGE,
      lastAssistantText: '',
    });
  }

  // Facts-only: exit code 0 covers both success and sandbox-blocked runs
  // (see the permission-denied fixture), so this adapter never infers
  // failure from the event stream shape alone. Every stream that parses at
  // all reports 'completed'; outcome policy beyond parse-level facts belongs
  // to the launcher/pipeline, not this adapter (mirrors the Pi adapter's
  // WK-0091 ruling that exit code / event presence alone is not evidence of
  // true outcome).
  return ok({
    outcome: 'completed',
    usage,
    lastAssistantText,
  });
}

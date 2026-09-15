/**
 * Pi coding-agent adapter (WK-0073 pick; T4 S0). Facts-only (spec D10 / §8 adapter
 * interface: "Adapters may not gate, decide policy, touch credentials, or build
 * shell strings elsewhere" — the launcher owns all policy). This module only
 * reports the invocation shape and parses Pi's own JSON-lines event stream; it
 * never spawns a process itself.
 *
 * Key facts baked in from the WK-0073 spike / tracker "Harness Rulings":
 * - `PI_CODING_AGENT_DIR` redirects Pi's entire per-process agent config dir —
 *   required per-worker (concurrent workers sharing `~/.pi/agent/` hit an
 *   auth.json lock, earendil-works/pi#8928).
 * - `--mode json` always exits 0, even on error — the adapter must parse the
 *   JSON-lines stream for `stopReason: "error"` on `message_end`/`turn_end`;
 *   exit code alone is not evidence of outcome.
 * - Per-turn `usage` (incl. computed `cost`) rides on every assistant
 *   `message_end` event; there is no end-of-run summary event, so usage is
 *   summed across all of them.
 * - `--approve` is required in non-interactive (`-p`) mode, else Pi silently
 *   skips project-local resources (`defaultProjectTrust: "ask"`).
 */
import type { DispatchResult } from '../errors.js';
import { ok } from '../errors.js';
import type { ModelEntry } from '../model-registry.js';

export interface PiModelsJson {
  providers: Record<
    string,
    {
      baseUrl: string;
      api: string;
      apiKey: string;
      models: Array<{
        id: string;
        contextWindow: number;
        maxTokens: number;
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      }>;
      compat?: { supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean };
    }
  >;
}

export interface PiInvocation {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** JSON string to write to `PI_CODING_AGENT_DIR/models.json`. */
  modelsJsonContent: string;
}

export interface PiUsage {
  totalTokens: number;
  costUsd: number;
}

export interface PiResult {
  outcome: 'completed' | 'partial' | 'blocked' | 'failed' | 'error';
  stopReason?: string;
  hasAgentEnd: boolean;
  usage: PiUsage;
  /** Raw parsed JSON-lines events, in stream order. */
  events: unknown[];
  /**
   * Concatenated `type === 'text'` content blocks from EVERY assistant
   * `message_end` event in the stream, in stream order — the worker's raw
   * response text, spanning EVERY assistant message in the run (narration,
   * tool-call commentary, and the final reply, all concatenated).
   * `thinking` and `toolCall` blocks, and non-assistant (`user`/
   * `toolResult`) `message_end`s, are excluded. `''` when the stream
   * carried no assistant `message_end` with a `text` block (e.g. the
   * empty-stream fallback). Right tool for whole-run scans (e.g. debugging
   * the full transcript); wrong tool for anything that expects to see only
   * the worker's FINAL message — see `lastAssistantText` below.
   *
   * WK-0092/WK-0093: extracted from `message_end.message.content` blocks —
   * Pi assembles the complete message there; it never emits a top-level
   * `text_delta` event (deltas ride inside `message_update.
   * assistantMessageEvent`, which this adapter does not read at all). The
   * prior implementation read a top-level `text_delta` that Pi has never
   * emitted, so this field — and `lastAssistantText` — were dead code since
   * S0; verified and fixed against a real captured stream, golden fixture
   * `tests/fixtures/pi-output-code-review.jsonl`.
   */
  accumulatedText: string;
  /**
   * Text of the LAST assistant `message_end` only — concatenated
   * `type === 'text'` content blocks of that one message; narration and
   * tool-call commentary from earlier turns excluded, and `thinking` /
   * `toolCall` blocks within that same message also excluded. `''` when the
   * stream carried no assistant `message_end` at all, or when the last one
   * had no `text` block (e.g. a final turn that was pure tool calls).
   *
   * No partial-text recovery is attempted for a stream truncated
   * mid-message (no closing `message_end` for the in-flight final turn) —
   * WK-0092 accepted trade-off: such streams are already classified
   * `failed`/`truncated_stream`, and the delta-based recovery this replaces
   * never actually worked (Pi never emits the top-level event it read), so
   * nothing real is lost by not reconstructing one.
   *
   * S6a's structured review-header parser (`response-header.ts`'s
   * `parseReviewHeader`) reads from THIS field, not `accumulatedText` — an
   * agentic `code_review` worker narrates ("Let me look at the diff...")
   * and calls tools before producing its structured header, so the
   * whole-session text pushes the header's opening `---` past
   * `extractHeaderBlock`'s 5-line search window. The header is always in
   * the worker's final message, regardless of how many turns the reviewer
   * takes or which model/backend/tier served it, so isolating that one
   * message here (in the one place that already walks the event stream,
   * D10 facts-only) fixes the data flow for every caller — widening the
   * parser's window instead would only paper over this one symptom, and
   * would make a markdown `---` horizontal rule in the narration
   * ambiguous with the real header delimiter.
   */
  lastAssistantText: string;
}

// New v2 error code produced by this module; will be merged into the shared
// DispatchErrorCode union in errors.ts at wave-3 integration. errors.ts is not
// modified by this file (wave-1 constraint).
type AdapterErrorCode = 'ADAPTER_FAILED';

function fail<T = never>(message: string, detail?: unknown): DispatchResult<T> {
  return { ok: false, error: 'ADAPTER_FAILED' as AdapterErrorCode, message, detail } as unknown as DispatchResult<T>;
}

/**
 * Build Pi's `models.json` config shape for a single registry entry. `apiKey`
 * uses Pi's `$VAR` interpolation syntax when the model declares an env var
 * (the actual secret value is sourced from secrets.env at spawn time, never
 * here); models with no secret (e.g. local Ollama) get a literal placeholder.
 */
export function buildModelsJson(model: ModelEntry): PiModelsJson {
  const apiKey = model.apiKeyEnv ? `$${model.apiKeyEnv}` : 'placeholder';

  return {
    providers: {
      [model.provider]: {
        baseUrl: model.baseUrl,
        api: model.api,
        apiKey,
        models: [
          {
            id: model.modelId,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            cost: { ...model.cost },
          },
        ],
        ...(model.compat ? { compat: { ...model.compat } } : {}),
      },
    },
  };
}

/**
 * Build the Pi invocation shape (argv + env + cwd) for a single run. Facts only —
 * this does not spawn anything; the launcher (Wave 3 pipeline.ts) does.
 */
export function buildInvocation(
  promptFilePath: string,
  model: ModelEntry,
  clonePath: string,
  workerDir: string,
): PiInvocation {
  const env: Record<string, string> = { PI_CODING_AGENT_DIR: workerDir, PI_OFFLINE: '1' };
  if (model.apiKeyEnv) {
    // Placeholder reference only — the real value is sourced from secrets.env at
    // spawn time (execution/s0-rulings.md ruling 5), never assembled here.
    env[model.apiKeyEnv] = `$${model.apiKeyEnv}`;
  }

  return {
    cmd: 'pi',
    args: [
      '-p',
      '--mode',
      'json',
      '--model',
      `${model.provider}/${model.modelId}`,
      '--no-session',
      '--approve',
      '--',
      `@${promptFilePath}`,
    ],
    env,
    cwd: clonePath,
    modelsJsonContent: JSON.stringify(buildModelsJson(model)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extract the concatenated `type === 'text'` content blocks of one assistant
 * `message_end`'s `message.content` array — `thinking` and `toolCall` blocks
 * are deliberately skipped (WK-0092/WK-0093: verified against a real
 * captured `pi-output.log`; the golden fixture is
 * `tests/fixtures/pi-output-code-review.jsonl`). Returns `''` when `content`
 * is missing or not an array — defensive, since some hand-rolled
 * usage/error-path test fixtures (and edge-case Pi events) carry a
 * `message` with no `content` at all.
 */
function extractAssistantMessageText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return '';
  let text = '';
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

/**
 * Parse Pi's JSON-lines stdout. Non-JSON lines are skipped (Pi's `--mode json`
 * output is pure JSON-lines, but the adapter tolerates stray banner/log lines
 * rather than failing the whole run over one bad line). Returns ADAPTER_FAILED
 * only when the stream has content but none of it parses as JSON at all.
 */
export function parsePiOutput(stdout: string): DispatchResult<PiResult> {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events: unknown[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip non-JSON lines (stray banners, etc.) — facts-only parsing tolerates them.
    }
  }

  if (lines.length > 0 && events.length === 0) {
    return fail('No parseable JSON-lines events found in Pi output.', { rawLineCount: lines.length });
  }

  if (events.length === 0) {
    return ok({ outcome: 'failed', stopReason: 'empty_stream', hasAgentEnd: false, usage: { totalTokens: 0, costUsd: 0 }, events: [], accumulatedText: '', lastAssistantText: '' });
  }

  let totalTokens = 0;
  let costUsd = 0;
  let sawError = false;
  let stopReason: string | undefined;
  let accumulatedText = '';
  let lastAssistantText = '';

  for (const event of events) {
    if (!isRecord(event)) continue;
    const type = event.type;

    if (type === 'message_end' || type === 'turn_end') {
      if (event.stopReason === 'error') {
        sawError = true;
        stopReason = 'error';
      } else if (typeof event.stopReason === 'string' && stopReason === undefined) {
        stopReason = event.stopReason;
      }
    }

    if (type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant') {
      const usage = event.message.usage;
      if (isRecord(usage)) {
        if (typeof usage.totalTokens === 'number') {
          totalTokens += usage.totalTokens;
        }
        if (isRecord(usage.cost) && typeof usage.cost.total === 'number') {
          costUsd += usage.cost.total;
        }
      }
      // WK-0092/WK-0093: text rides on the assembled `content` array of the
      // assistant message_end, not a top-level `text_delta` event (Pi never
      // emits one). Overwritten on every assistant message_end, so after the
      // loop this holds the LAST one — see `lastAssistantText`'s doc comment.
      const messageText = extractAssistantMessageText(event.message);
      accumulatedText += messageText;
      lastAssistantText = messageText;
    }
  }

  // Facts-only: the launcher (not this adapter) owns outcome policy beyond
  // error-detection. `agent_end` presence with no observed error defaults to
  // 'completed'; the response-doc-level completed/partial/blocked/failed
  // distinction is read from the worker's own response text by the capture
  // step (Wave 2 delivery/capture), not inferred here.
  const hasAgentEnd = events.some(e => isRecord(e) && e.type === 'agent_end');
  const allAttemptsErrored = events.some(
    (e) => isRecord(e) && e.type === 'auto_retry_end' && e.success === false,
  );
  const outcome: PiResult['outcome'] = allAttemptsErrored
    ? 'failed'
    : sawError
      ? 'error'
      : hasAgentEnd
        ? 'completed'
        : 'failed';
  if (allAttemptsErrored) {
    stopReason = 'all_attempts_errored';
  } else if (outcome === 'failed' && stopReason === undefined) {
    stopReason = 'truncated_stream';
  }

  return ok({ outcome, stopReason, hasAgentEnd, usage: { totalTokens, costUsd }, events, accumulatedText, lastAssistantText });
}

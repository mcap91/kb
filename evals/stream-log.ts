/**
 * stream-json tool-log parser (WK-0237 Acceptance: "A stream tool-log parser
 * returns every tool_use ... including subagent turns, the system/init model
 * id and session_id, permission denials, the final result text and usage").
 *
 * Capture facts this depends on (WK-0237 Notes 2026-11-01, HO-0132
 * Constraints "Capture facts"):
 *   - `wk0237-normal-2` line 1: `system`/`init` carries `model` and
 *     `session_id`.
 *   - `wk0237-normal-2` line 5: an `assistant` event's `message.content[]`
 *     holds a `tool_use` block (`name`, `id`, `input`); line 30: a `system`
 *     event with `subtype: "permission_denied"` and `tool_name`; the final
 *     `result` event (line 54) carries `permission_denials[]`
 *     (`tool_name`, `tool_input`), `result` (text) and `usage`.
 *   - `wk0237-probe-2` line 26: an `assistant` `tool_use` named `Agent`
 *     (`subagent_type`) with no `parent_tool_use_id`; line 31: a subagent
 *     turn's `tool_use` (`Bash`) carries `parent_tool_use_id` equal to the
 *     `Agent` call's `id`, proving subagent turns are ordinary events in the
 *     same stream, distinguished only by that field.
 */
import { fail, ok, type EvalResult } from './result.js';

export interface ToolUse {
  name: string;
  input: unknown;
  id: string;
  parentToolUseId: string | null;
}

export interface PermissionDenial {
  toolName: string;
  toolInput?: unknown;
}

export interface ResultSummary {
  text: string;
  usage: unknown;
  isError: boolean;
  subtype: string;
}

export interface ParsedStreamLog {
  toolUses: ToolUse[];
  modelId: string | null;
  sessionId: string | null;
  /** `system`/`subtype: "permission_denied"` events seen during the run. */
  permissionDeniedEvents: PermissionDenial[];
  /** The final `result` event's `permission_denials[]`, if any. */
  resultPermissionDenials: PermissionDenial[];
  /** The final `result` event's summary, or null when none was seen (e.g. a timed-out run). */
  result: ResultSummary | null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parses every non-empty line of a stream-json capture into a `ParsedStreamLog`. Fails on the first line that is not valid JSON. */
export function parseStreamLog(lines: string[]): EvalResult<ParsedStreamLog> {
  const toolUses: ToolUse[] = [];
  const permissionDeniedEvents: PermissionDenial[] = [];
  let resultPermissionDenials: PermissionDenial[] = [];
  let modelId: string | null = null;
  let sessionId: string | null = null;
  let result: ResultSummary | null = null;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      return fail('MALFORMED_JSONL', `failed to parse stream line: ${describeError(err)}`);
    }

    const type = event.type;

    if (type === 'system' && event.subtype === 'init') {
      if (typeof event.model === 'string') modelId = event.model;
      if (typeof event.session_id === 'string') sessionId = event.session_id;
    }

    if (type === 'system' && event.subtype === 'permission_denied') {
      permissionDeniedEvents.push({
        toolName: typeof event.tool_name === 'string' ? event.tool_name : '',
      });
    }

    if (type === 'assistant' || type === 'user') {
      const message = event.message as { content?: unknown } | undefined;
      const content = message?.content;
      const parentToolUseId = typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : null;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
            const b = block as Record<string, unknown>;
            toolUses.push({
              name: typeof b.name === 'string' ? b.name : '',
              input: b.input,
              id: typeof b.id === 'string' ? b.id : '',
              parentToolUseId,
            });
          }
        }
      }
    }

    if (type === 'result') {
      const denials = event.permission_denials;
      resultPermissionDenials = Array.isArray(denials)
        ? denials.map((d) => ({
            toolName: typeof (d as Record<string, unknown>)?.tool_name === 'string' ? (d as Record<string, unknown>).tool_name as string : '',
            toolInput: (d as Record<string, unknown>)?.tool_input,
          }))
        : [];
      result = {
        text: typeof event.result === 'string' ? event.result : '',
        usage: event.usage,
        isError: event.is_error === true,
        subtype: typeof event.subtype === 'string' ? event.subtype : '',
      };
    }
  }

  return ok({ toolUses, modelId, sessionId, permissionDeniedEvents, resultPermissionDenials, result });
}

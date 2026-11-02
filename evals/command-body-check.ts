/**
 * Command-body prefix check (WK-0237 Notes 2026-11-01 normal-2 fact 2: the
 * session transcript's 3rd `type: "user"` text line is the installed
 * command file's bytes exactly, followed by `\n\nARGUMENTS: <args>` — a
 * prefix check, not equality, since the arguments vary per run). Operates on
 * the extracted user-text-only transcript lines (Resolutions 11), not the
 * stream-json log.
 */
import type { CheckOutcome } from './checks.js';
import { ok, type EvalResult } from './result.js';

interface TranscriptLine {
  type?: unknown;
  message?: { content?: unknown };
}

/** The text of every transcript line whose `message.content` is text (a string, or a block array with no `tool_result` block). */
export function extractUserTextBlocks(transcriptLines: string[]): string[] {
  const texts: string[] = [];
  for (const raw of transcriptLines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue;
    }
    if (line.type !== 'user') continue;

    const content = line.message?.content;
    if (typeof content === 'string') {
      texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      const hasToolResult = content.some((b) => (b as Record<string, unknown>)?.type === 'tool_result');
      if (hasToolResult) continue;
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      }
    }
  }
  return texts;
}

/**
 * Passes when some extracted user-text line byte-starts-with
 * `installedCommandBody` and the remainder is empty or starts with
 * `\n\nARGUMENTS:`.
 */
export function checkCommandBodyPrefix(transcriptUserLines: string[], installedCommandBody: string): EvalResult<CheckOutcome> {
  const texts = extractUserTextBlocks(transcriptUserLines);
  for (const text of texts) {
    if (!text.startsWith(installedCommandBody)) continue;
    const suffix = text.slice(installedCommandBody.length);
    if (suffix.length === 0 || /^\n\nARGUMENTS:/.test(suffix)) {
      return ok({ passed: true });
    }
  }
  return ok({
    passed: false,
    reason: 'no transcript user-text line byte-starts-with the installed command body plus "\\n\\nARGUMENTS:"',
  });
}

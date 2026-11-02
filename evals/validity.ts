/**
 * 15.2 run validity (WK-0237 scope item 15 point 2 / HO-0132 Constraints):
 * a run is valid only when it exits 0, is not timed out, and its last
 * stream-json line parses as a `result` event with `subtype: "success"` and
 * `is_error: false`. Capture facts this depends on (WK-0237 Notes
 * 2026-11-01): `wk0237-normal` (nonzero exit, `result`/`success`/`is_error:
 * true`), `wk0237-normal-2` (exit 0, `result`/`success`/`is_error: false`),
 * `wk0237-budget` (`result`/`subtype: error_max_budget_usd`), `wk0237-timeout`
 * (`timedOut: true`, no `result` event at all).
 */
import { fail, ok, type EvalResult } from './result.js';

export type ValidityReason =
  | 'timeout'
  | 'nonzero-exit'
  | 'no-result-event'
  | 'malformed-jsonl'
  | 'budget-stop'
  | 'result-error';

export type ValidityOutcome = { valid: true } | { valid: false; reason: ValidityReason };

export interface RunValidityFields {
  exitCode: number | null;
  timedOut: boolean;
}

function parseLastLine(streamLines: string[]): EvalResult<Record<string, unknown> | null> {
  const nonEmpty = streamLines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return ok(null);
  try {
    return ok(JSON.parse(nonEmpty[nonEmpty.length - 1]) as Record<string, unknown>);
  } catch (err) {
    return fail('MALFORMED_LAST_LINE', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Checked in order: `timedOut` (host wall-clock kill) beats everything else
 * since `exitCode`/the stream are both artifacts of the kill, not the run's
 * own terminal state; a missing or unparseable last line comes next; then
 * the budget-stop shape (still present even on a nonzero exit, so it is
 * checked before the generic `nonzero-exit` reason); then exit code; then
 * `is_error`; anything else that is not `subtype: "success"` falls back to
 * `no-result-event`.
 */
export function checkRunValidity(run: RunValidityFields, streamLines: string[]): EvalResult<ValidityOutcome> {
  if (run.timedOut) return ok({ valid: false, reason: 'timeout' });

  const lastLineResult = parseLastLine(streamLines);
  if (!lastLineResult.ok) return ok({ valid: false, reason: 'malformed-jsonl' });

  const lastLine = lastLineResult.data;
  if (lastLine === null || lastLine.type !== 'result') {
    return ok({ valid: false, reason: 'no-result-event' });
  }

  if (lastLine.subtype === 'error_max_budget_usd') return ok({ valid: false, reason: 'budget-stop' });
  if (run.exitCode !== 0) return ok({ valid: false, reason: 'nonzero-exit' });
  if (lastLine.is_error === true) return ok({ valid: false, reason: 'result-error' });
  if (lastLine.subtype !== 'success') return ok({ valid: false, reason: 'no-result-event' });

  return ok({ valid: true });
}

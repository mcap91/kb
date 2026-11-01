/**
 * Result-shaped return convention for evals/ (WK-0237 slice A). Mirrors
 * dispatch-core's `DispatchResult` shape ({ ok: true, data } | { ok: false,
 * code, message }) but is defined locally — evals/ imports exactly one thing
 * from `@kb/dispatch-core` (`SYSTEM_ROOTS`; see jail.ts), so this module is
 * its own copy of the pattern rather than a cross-package import.
 */

export type EvalResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export function ok<T>(data: T): EvalResult<T> {
  return { ok: true, data };
}

export function fail<T = never>(code: string, message: string): EvalResult<T> {
  return { ok: false, code, message };
}

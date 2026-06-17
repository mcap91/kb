// Date stamping for wiki records.
//
// Wiki records carry two shapes of date field:
//
//   * Date-only fields — an issue/initiative/decision/source's `created` / `updated`,
//     a decision's `date`, a plan's `target` / `started`, etc. These should read as
//     the human "today" and line up with git commit dates (both local).
//   * Full ISO-8601 timestamp fields — a plan's `completed` and its archival `updated`
//     bump, dispatch run timestamps, generated-view `updated`, the search `builtAt`.
//     These are machine timestamps and intentionally stay UTC (`…Z`).
//
// `Date.prototype.toISOString()` is UTC by spec, so the old date-only stamp
// `new Date().toISOString().slice(0, 10)` records *tomorrow's* date in the evening of
// a UTC-negative timezone. Setting the `TZ` environment variable does NOT change
// `toISOString()` — the fix must live in code. This helper is the single source of
// truth for the date-only shape; timestamp fields keep calling `toISOString()`.

/**
 * Format an instant as a date-only stamp (`YYYY-MM-DD`) in local time.
 *
 * @param now      Instant to format. Defaults to the current time.
 * @param timeZone IANA time zone to format in (e.g. `'America/Los_Angeles'`).
 *                 Defaults to the runtime's local zone; production callers omit it
 *                 and only tests pin it for determinism across a UTC day boundary.
 */
export function localDateStamp(now: Date = new Date(), timeZone?: string): string {
  // formatToParts + explicit assembly guarantees `YYYY-MM-DD` regardless of how the
  // locale would otherwise render the date (separators, digit order, bidi marks).
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

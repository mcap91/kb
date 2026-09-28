/**
 * Shared stream helper for the v2 spawn sites (WK-0148 / WK-0162). A child's
 * stdio streams and injected-file pipes emit an unrecoverable 'error'
 * (EPIPE/ECONNRESET, etc.) when their peer end closes first; unhandled,
 * 'error' is fatal (uncaught exception) instead of merely informational —
 * the exit/close path each caller already runs handles real cleanup, so
 * this is a pure swallow. Chassis precedent: one blanket loop over all
 * child streams (agent-chassis stdio-mcp-transcript-capture.mjs:424-426).
 */

interface ErrorEmitter {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * Attach a swallowing 'error' listener to each given stream. Skips null/
 * undefined entries so callers can pass `child.stdout`, `child.stderr`, an
 * injected-file pipe, etc. directly without individually guarding each one.
 */
export function attachStreamErrorHandlers(...streams: Array<ErrorEmitter | null | undefined>): void {
  for (const stream of streams) {
    stream?.on('error', () => { /* swallow — exit/close path handles cleanup */ });
  }
}

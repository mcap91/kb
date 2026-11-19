/**
 * SIGTERM cancel handler — unit tests for `installCancelHandler`
 * (dispatch-controller-entry.ts).
 *
 * No real signal is sent: the handler is called directly with recording deps.
 * `vi.useFakeTimers` bounds the "cleanup never resolves" case. The handler is
 * pure orchestration — mark cancelled, stop the heartbeat, flush writes, run
 * the bounded cleanup, write the cancelled state, flush again, exit 143 — so
 * these tests pin the order and the two failure paths (a cleanup that never
 * resolves, and one that rejects).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CANCEL_CLEANUP_TIMEOUT_MS,
  installCancelHandler,
  type CancelHandlerDeps,
} from '../packages/dispatch-core/src/dispatch-controller-entry.js';
import { FORWARDER_EXIT_TIMEOUT_MS } from '../packages/dispatch-core/src/pipeline.js';

interface Recorder {
  order: string[];
  exitCode: number | undefined;
  logs: string[];
}

function recordingDeps(overrides: Partial<CancelHandlerDeps> = {}): { deps: CancelHandlerDeps; record: Recorder } {
  const record: Recorder = { order: [], exitCode: undefined, logs: [] };
  const deps: CancelHandlerDeps = {
    markCancelled: () => record.order.push('markCancelled'),
    stopHeartbeat: () => record.order.push('stopHeartbeat'),
    flushWrites: async () => {
      record.order.push('flushWrites');
    },
    getCleanup: () => {
      record.order.push('getCleanup');
      return async () => {
        record.order.push('cleanup');
      };
    },
    writeCancelled: () => record.order.push('writeCancelled'),
    exit: (code) => {
      record.order.push('exit');
      record.exitCode = code;
    },
    log: (line) => record.logs.push(line),
    ...overrides,
  };
  return { deps, record };
}

describe('installCancelHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the deps in step order and exits 143', async () => {
    const { deps, record } = recordingDeps();
    await installCancelHandler(deps)();
    expect(record.order).toEqual([
      'markCancelled',
      'stopHeartbeat',
      'flushWrites',
      'getCleanup',
      'cleanup',
      'writeCancelled',
      'flushWrites',
      'exit',
    ]);
    expect(record.exitCode).toBe(143);
  });

  it('bounds the cleanup at two forwarder waits plus five seconds', () => {
    expect(CANCEL_CLEANUP_TIMEOUT_MS).toBe(2 * FORWARDER_EXIT_TIMEOUT_MS + 5_000);
    expect(CANCEL_CLEANUP_TIMEOUT_MS).toBe(15_000);
  });

  it('still writes cancelled and exits 143 when the cleanup never resolves', async () => {
    vi.useFakeTimers();
    const { deps, record } = recordingDeps({
      getCleanup: () => () => new Promise<void>(() => undefined),
    });
    const handler = installCancelHandler(deps)();
    await vi.advanceTimersByTimeAsync(CANCEL_CLEANUP_TIMEOUT_MS);
    await handler;
    expect(record.order).toContain('writeCancelled');
    expect(record.order).toContain('exit');
    expect(record.exitCode).toBe(143);
  });

  it('logs a rejecting cleanup and goes on', async () => {
    const { deps, record } = recordingDeps({
      getCleanup: () => async () => {
        throw new Error('cleanup exploded');
      },
    });
    await installCancelHandler(deps)();
    expect(record.logs.join('\n')).toContain('cleanup exploded');
    expect(record.order).toContain('writeCancelled');
    expect(record.order).toContain('exit');
    expect(record.exitCode).toBe(143);
  });

  it('skips the cleanup steps when none was registered', async () => {
    const { deps, record } = recordingDeps({ getCleanup: () => undefined });
    await installCancelHandler(deps)();
    expect(record.order).not.toContain('cleanup');
    expect(record.order).toContain('writeCancelled');
    expect(record.exitCode).toBe(143);
  });
});

/**
 * PLN-0004 D6 Phase 3 — spawnIsolated unit tests (spawn-isolated.ts).
 *
 * `spawn('bwrap', ...)`'s binary name is hardcoded, so there is no dependency
 * injection seam to swap it out. Rather than `vi.mock('node:child_process')`
 * — a hand-rolled EventEmitter/stream fake would invent the shape of a real
 * ChildProcess (event ordering, the writable-stream semantics of stdio slots
 * above fd 2, real pipe-close timing) that this repo's evidence rule (DEC-0009)
 * says not to guess at, and no other test file here uses vi.mock — every test
 * below runs a REAL child process against a fake `bwrap` script placed first
 * on `PATH` via `plan.env` (mirrors dispatch-spawn.test.ts's real-executable
 * pattern). Confirmed against the real implementation before writing
 * assertions: dash/bash both defer trap execution while blocked in a
 * foreground `sleep`, so the kill-timer test uses `exec sleep N` (process-image
 * replacement, default SIGTERM disposition) instead of a trap handler.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnIsolated } from '../packages/dispatch-core/src/spawn-isolated.js';
import { buildBwrapPlan, type BwrapPlan } from '../packages/dispatch-core/src/jail.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'spawn-isolated-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Writes a fake `bwrap` executable into `workDir`, standing in for the real binary. */
async function installFakeBwrap(scriptBody: string): Promise<void> {
  const bwrapPath = join(workDir, 'bwrap');
  await writeFile(bwrapPath, scriptBody, 'utf8');
  await chmod(bwrapPath, 0o755);
}

/** `workDir` first so `spawn('bwrap', ...)` resolves to the fake; real coreutils after, for the script bodies that shell out to `sleep`/`head`/`tr`. */
function pathWithFakeBwrapFirst(): string {
  return `${workDir}:/usr/bin:/bin`;
}

function planWithFakeBwrap(
  env: Record<string, string> = {},
  injectedFiles?: ReadonlyArray<{ content: string; dest: string }>,
): BwrapPlan {
  return buildBwrapPlan({
    clonePath: '/tmp/test-clone',
    command: ['worker'],
    env: { PATH: pathWithFakeBwrapFirst(), ...env },
    injectedFiles,
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) return predicate();
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return true;
}

describe.skipIf(process.platform === 'win32')('spawnIsolated (D6 Phase 3)', () => {
  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  describe('a worker that exits 0', () => {
    it('reports a fully clean result, so callers can trust ok() without extra checks', async () => {
      await installFakeBwrap('#!/bin/sh\nexit 0\n');
      const result = await spawnIsolated(planWithFakeBwrap(), { timeoutMs: 5000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({
        stdout: '',
        stderr: '',
        exitCode: 0,
        signal: null,
        truncated: false,
        timedOut: false,
        streamDrainTimedOut: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Non-zero exit — still ok(), never a fail()
  // ---------------------------------------------------------------------------

  describe('a worker that exits non-zero', () => {
    it('is still ok() carrying the exit code — only a failure to spawn bwrap itself is a fail()', async () => {
      await installFakeBwrap('#!/bin/sh\nexit 7\n');
      const result = await spawnIsolated(planWithFakeBwrap(), { timeoutMs: 5000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.exitCode).toBe(7);
      expect(result.data.signal).toBeNull();
      expect(result.data.timedOut).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Kill-timer timeout
  // ---------------------------------------------------------------------------

  describe('a worker that outlives timeoutMs', () => {
    it('flags timedOut and actually delivers SIGTERM to the real process', async () => {
      // `exec` replaces the shell's own process image with `sleep`, so the PID
      // Node tracks IS `sleep` — its default SIGTERM disposition (terminate)
      // applies directly, with no shell/trap indirection in the way.
      await installFakeBwrap('#!/bin/sh\necho $$ > "$PIDFILE"\nexec sleep 10\n');
      const pidFile = join(workDir, 'pid');

      const result = await spawnIsolated(planWithFakeBwrap({ PIDFILE: pidFile }), { timeoutMs: 150 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The kill timer fires-and-forgets: it calls child.kill() and resolves
      // immediately rather than waiting for the real exit event, so exitCode
      // and signal are synthesized as null, not backfilled from the OS.
      expect(result.data.timedOut).toBe(true);
      expect(result.data.exitCode).toBeNull();
      expect(result.data.signal).toBeNull();

      const pidWritten = await waitUntil(() => existsSync(pidFile), 500);
      expect(pidWritten).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());

      const died = await waitUntil(() => !isProcessAlive(pid), 1000);
      expect(died).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Stream-drain timeout
  // ---------------------------------------------------------------------------

  describe('a worker whose grandchild keeps stdout/stderr open past exit', () => {
    it('flags streamDrainTimedOut once streamDrainMs elapses after the real exit event', async () => {
      // Double-fork: the backgrounded `sleep` is orphaned and reparented once
      // the immediate child exits, but it still holds a duplicate of the
      // stdout/stderr pipe fds — Node's streams see no 'close' until it does.
      await installFakeBwrap('#!/bin/sh\n( sleep 2 & )\nexit 0\n');
      const result = await spawnIsolated(planWithFakeBwrap(), { timeoutMs: 5000, streamDrainMs: 100 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.streamDrainTimedOut).toBe(true);
      expect(result.data.exitCode).toBe(0);
      expect(result.data.timedOut).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Bounded stdout capture — 1 MiB head-cap
  // ---------------------------------------------------------------------------

  describe('a worker whose stdout exceeds maxCaptureBytes', () => {
    it('retains the head and drops the tail, flagging truncated', async () => {
      const headMarker = 'HEAD_MARKER_STDOUT_BEGIN';
      const tailMarker = 'TAIL_MARKER_STDOUT_END';
      const fillerBytes = 1_600_000; // well past the 1 MiB cap and past pipe-buffer size, so the OS is forced to deliver it as many chunks (required for the cap's chunk-granular truncation to actually bite)
      await installFakeBwrap(`#!/bin/sh
printf '${headMarker}'
head -c ${fillerBytes} /dev/zero | tr '\\0' 'A'
printf '${tailMarker}'
`);
      const result = await spawnIsolated(planWithFakeBwrap(), { timeoutMs: 5000, maxCaptureBytes: 1_048_576 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.truncated).toBe(true);
      expect(result.data.stdout.startsWith(headMarker)).toBe(true);
      expect(result.data.stdout.includes(tailMarker)).toBe(false);
      const retainedBytes = Buffer.byteLength(result.data.stdout, 'utf8');
      expect(retainedBytes).toBeGreaterThanOrEqual(1_048_576);
      expect(retainedBytes).toBeLessThan(fillerBytes);
    });
  });

  // ---------------------------------------------------------------------------
  // Bounded stderr capture — 4 KiB tail-cap
  // ---------------------------------------------------------------------------

  describe('a worker whose stderr exceeds maxStderrBytes', () => {
    it('retains the END and drops the start — the diagnostically useful part of a crash', async () => {
      const headMarker = 'HEAD_MARKER_STDERR_BEGIN';
      const tailMarker = 'TAIL_MARKER_STDERR_END';
      const fillerBytes = 400_000; // >> pipe-buffer size, forcing multiple chunks so the tail-cap actually evicts the earliest ones
      await installFakeBwrap(`#!/bin/sh
printf '${headMarker}' 1>&2
head -c ${fillerBytes} /dev/zero | tr '\\0' 'B' 1>&2
printf '${tailMarker}' 1>&2
`);
      const result = await spawnIsolated(planWithFakeBwrap(), { timeoutMs: 5000, maxStderrBytes: 4_096 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.truncated).toBe(true);
      expect(result.data.stderr.includes(headMarker)).toBe(false);
      expect(result.data.stderr.endsWith(tailMarker)).toBe(true);
      expect(Buffer.byteLength(result.data.stderr, 'utf8')).toBeLessThan(fillerBytes);
    });
  });

  // ---------------------------------------------------------------------------
  // injectedFiles fd wiring
  // ---------------------------------------------------------------------------

  describe('a plan with injectedFiles', () => {
    it('pipes the content to the matching fd (3, matching buildBwrapPlan\'s numbering)', async () => {
      await installFakeBwrap('#!/bin/sh\ncat <&3\n');
      const plan = planWithFakeBwrap({}, [{ content: 'hello-from-fd3', dest: '/tmp/test-clone/models.json' }]);
      const result = await spawnIsolated(plan, { timeoutMs: 5000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.stdout).toBe('hello-from-fd3');
      expect(result.data.exitCode).toBe(0);
    });

    it('preserves declaration order across multiple files (fd 3, then fd 4)', async () => {
      await installFakeBwrap(`#!/bin/sh
cat <&3
printf '|'
cat <&4
`);
      const plan = planWithFakeBwrap({}, [
        { content: 'first', dest: '/tmp/test-clone/a.json' },
        { content: 'second', dest: '/tmp/test-clone/b.json' },
      ]);
      const result = await spawnIsolated(plan, { timeoutMs: 5000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.stdout).toBe('first|second');
    });

    it('fails fast with BWRAP_SPAWN_FAILED when opts.injectedFiles disagrees with the plan, instead of silently spawning with the wrong pipes', async () => {
      const plan = buildBwrapPlan({
        clonePath: '/tmp/test-clone',
        command: ['worker'],
        injectedFiles: [{ content: 'x', dest: '/tmp/test-clone/a.json' }],
      });

      const result = await spawnIsolated(plan, {
        injectedFiles: [{ content: 'x', dest: '/tmp/test-clone/WRONG.json' }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BWRAP_SPAWN_FAILED');
    });
  });

  // ---------------------------------------------------------------------------
  // Missing bwrap binary
  // ---------------------------------------------------------------------------

  describe('bwrap missing from PATH', () => {
    it('returns fail(BWRAP_SPAWN_FAILED) instead of throwing', async () => {
      const emptyBinDir = join(workDir, 'no-bwrap-here');
      await mkdir(emptyBinDir);
      const plan = buildBwrapPlan({
        clonePath: '/tmp/test-clone',
        command: ['worker'],
        env: { PATH: emptyBinDir },
      });

      const result = await spawnIsolated(plan, { timeoutMs: 5000 });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BWRAP_SPAWN_FAILED');
      expect(result.message).toContain('bwrap');
    });
  });
});

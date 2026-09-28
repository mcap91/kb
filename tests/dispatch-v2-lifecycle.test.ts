/**
 * WK-0162 — process-lifecycle regression tests. Two build-history bugs
 * (stream-error survival, WK-0148; relay/worker teardown under real
 * signaling, WK-0156) were fixed and live-verified exactly once each, with
 * no automated regression test. Both are real-OS-signaling behaviors
 * (uncaught stream 'error' events, bash trap/background/wait semantics) a
 * string-level or mocked test cannot exercise, so every test below runs a
 * REAL child process — no `vi.mock` — mirroring dispatch-v2-spawn.test.ts's
 * fake-executable-on-PATH pattern (its own DEC-0009 evidence-before-code
 * rationale applies here too). Neither test needs real bwrap.
 *
 * Test 1 (WK-0148 class): forces a real EPIPE on spawn-isolated.ts's
 * injected-file pipe via a fake bwrap that exits without ever reading fd 3,
 * and asserts spawnIsolated survives to a clean ok() result — exercising the
 * attachStreamErrorHandlers extraction rather than a crash.
 *
 * Test 2 (WK-0156 class): runs the ACTUAL generated wrapper script
 * (pipeline.ts's exported buildInnerScript — relay + backgrounded/waited
 * worker, `trap cleanup EXIT TERM INT`) against stand-in relay/worker
 * binaries, verifying both a mid-run SIGTERM and a normal (unsignaled)
 * completion leave no orphaned relay process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnIsolated } from '../packages/dispatch-core/src/spawn-isolated.js';
import { buildBwrapPlan, type BwrapPlan } from '../packages/dispatch-core/src/jail.js';
import { buildInnerScript } from '../packages/dispatch-core/src/pipeline.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let workDir: string;
const spawnedChildren: ChildProcess[] = [];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dispatch-v2-lifecycle-'));
});

afterEach(async () => {
  // Kill each test-owned process GROUP, never a bare (possibly-reused) PID.
  // Every process below was spawned with detached:true, making it the
  // leader of its own new process group (pgid === its own pid) — the
  // negative pid targets the whole group. Already-dead groups throw ESRCH;
  // ignored, matching spawn-isolated.ts's own "already dead" swallow.
  for (const child of spawnedChildren) {
    if (typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  }
  spawnedChildren.length = 0;
  await rm(workDir, { recursive: true, force: true });
});

/** Writes a fake `bwrap` executable into `workDir`, standing in for the real binary (mirrors dispatch-v2-spawn.test.ts's installFakeBwrap). */
async function installFakeBwrap(scriptBody: string): Promise<void> {
  const bwrapPath = join(workDir, 'bwrap');
  await writeFile(bwrapPath, scriptBody, 'utf8');
  await chmod(bwrapPath, 0o755);
}

/** `workDir` first so `spawn('bwrap', ...)` resolves to the fake; real coreutils after. */
function pathWithFakeBwrapFirst(): string {
  return `${workDir}:/usr/bin:/bin`;
}

function planWithFakeBwrap(injectedFiles: ReadonlyArray<{ content: string; dest: string }>): BwrapPlan {
  return buildBwrapPlan({
    clonePath: '/tmp/test-clone',
    command: ['worker'],
    env: { PATH: pathWithFakeBwrapFirst() },
    injectedFiles,
  });
}

/**
 * Poll a pidfile until it holds a validated positive integer PID. Never
 * returns 0 or NaN — `process.kill(0, ...)` signals the CALLER's own
 * process group, the critical GPT-review finding this closes. Throws on
 * timeout rather than ever returning an unvalidated value.
 */
async function waitForPidFile(path: string, timeoutMs = 3000): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (existsSync(path)) {
      const raw = (await readFile(path, 'utf8')).trim();
      if (/^\d+$/.test(raw)) {
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
    }
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out waiting for a valid pid in ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/**
 * Aliveness via /proc/<pid>/stat, not bare `kill(pid, 0)` (which treats a
 * zombie as alive). Real-captured format on this box:
 * "<pid> (<comm>) <state> ..." — comm may itself contain ')', so the state
 * field is taken as the token right after the LAST ')', not a fixed offset.
 * A zombie ('Z') counts as dead for teardown purposes.
 */
function isAliveNonZombie(pid: number): boolean {
  const statPath = `/proc/${pid}/stat`;
  if (!existsSync(statPath)) return false;
  try {
    const raw = readFileSync(statPath, 'utf8');
    const afterComm = raw.slice(raw.lastIndexOf(')') + 1).trim();
    const state = afterComm.split(' ')[0];
    return state !== 'Z';
  } catch {
    // Vanished between existsSync and readFileSync — unambiguously dead.
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (isAliveNonZombie(pid)) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return true;
}

describe.skipIf(process.platform === 'win32')('process-lifecycle regressions (WK-0162)', () => {
  // ---------------------------------------------------------------------------
  // Test 1 (WK-0148 class) — attachStreamErrorHandlers, injected-file pipe
  // ---------------------------------------------------------------------------

  describe('spawnIsolated survives a forced EPIPE on the injected-file pipe', () => {
    it('resolves ok:true when the fake bwrap exits without ever reading fd 3', async () => {
      await installFakeBwrap('#!/bin/sh\nexit 0\n');
      // >65536 bytes (Linux's plain pipe(2) kernel buffer size — WK-0148's
      // own measured finding) forces pipe.end()'s write past what a single
      // syscall can buffer, so at least one write lands after the fake
      // bwrap's near-instant exit has already closed fd 3's read end:
      // deterministic EPIPE, not a timing race on one small write.
      const plan = planWithFakeBwrap([{ content: 'x'.repeat(200_000), dest: '/tmp/test-clone/models.json' }]);

      const result = await spawnIsolated(plan, { timeoutMs: 5000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.exitCode).toBe(0);
      expect(result.data.timedOut).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2 (WK-0156 class) — buildInnerScript, real generated wrapper script
  // ---------------------------------------------------------------------------

  describe('the real generated wrapper script (buildInnerScript)', () => {
    const RELAY_STUB_SRC = [
      "const fs = require('fs');",
      'fs.writeFileSync(process.env.RELAY_PIDFILE, String(process.pid));',
      'setInterval(() => {}, 60000);',
      '',
    ].join('\n');

    async function writeStub(name: string, content: string): Promise<string> {
      const path = join(workDir, name);
      await writeFile(path, content, 'utf8');
      await chmod(path, 0o755);
      return path;
    }

    /**
     * Spawns the REAL generated wrapper script (buildInnerScript, unmodified)
     * with a stand-in Node relay (invocation shape fixed by the script
     * itself: `node <relayScriptPath> <port> <socketPath> ...`) and a
     * caller-supplied stand-in worker command. No bwrap — Test 2 is
     * explicitly out of scope for sandboxing (WK-0162 Scope). Both stand-ins
     * self-report their own OS pid via env-var-named pidfiles so the test
     * can verify aliveness from outside the script.
     */
    async function spawnWrapper(workerScriptPath: string): Promise<{
      child: ChildProcess;
      exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
      relayPidFile: string;
      workerPidFile: string;
    }> {
      const relayScriptPath = await writeStub('relay-stub.cjs', RELAY_STUB_SRC);
      const relayPidFile = join(workDir, 'relay.pid');
      const workerPidFile = join(workDir, 'worker.pid');
      const innerScript = buildInnerScript({
        execLines: [`exec sh '${workerScriptPath}'`],
        relayScriptPath,
        tunnelSocketPath: join(workDir, 'tunnel.sock'),
        hasLockfile: false,
      });

      const child = spawn('bash', ['-c', innerScript], {
        cwd: workDir,
        env: { ...process.env, RELAY_PIDFILE: relayPidFile, WORKER_PIDFILE: workerPidFile },
        detached: true,
        stdio: 'ignore',
      });
      spawnedChildren.push(child);
      // Attach the 'exit' listener synchronously, right here at spawn time —
      // never lazily after an `await` (e.g. pidfile polling below). A fast
      // worker can make the whole wrapper exit within a couple of
      // milliseconds; Node's EventEmitter does not replay a past 'exit' to a
      // listener attached after the fact, so a late `.once('exit', ...)'
      // can wait forever for an event that already happened.
      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      return { child, exitPromise, relayPidFile, workerPidFile };
    }

    it('a mid-run SIGTERM kills both the worker and the relay, wrapper exits code:143 signal:null', async () => {
      const workerScriptPath = await writeStub(
        'worker-sleep.sh',
        '#!/bin/sh\necho $$ > "$WORKER_PIDFILE"\nexec sleep 300\n',
      );
      const { child, exitPromise, relayPidFile, workerPidFile } = await spawnWrapper(workerScriptPath);

      const relayPid = await waitForPidFile(relayPidFile);
      const workerPid = await waitForPidFile(workerPidFile);
      // Both genuinely alive mid-run before the signal lands — confirms this
      // exercises the "kill something actually running" path, not a no-op.
      expect(isAliveNonZombie(relayPid)).toBe(true);
      expect(isAliveNonZombie(workerPid)).toBe(true);

      child.kill('SIGTERM');
      const exit = await exitPromise;

      // Matches pipeline.ts's own documented live-probe finding verbatim:
      // bash's `wait` returns 128+signal when interrupted by a trapped
      // signal, and since `wait` is the script's last command, THAT becomes
      // the script's own exit status — the wrapper is caught by its trap,
      // not raw-killed, so Node reports a code, not a signal.
      expect(exit.code).toBe(143);
      expect(exit.signal).toBeNull();
      expect(await waitUntilDead(relayPid)).toBe(true);
      expect(await waitUntilDead(workerPid)).toBe(true);
    });

    it('normal completion (worker exits on its own, no signal) also kills the relay — the WK-0156 orphan-relay bug', async () => {
      const workerScriptPath = await writeStub(
        'worker-fast.sh',
        '#!/bin/sh\necho $$ > "$WORKER_PIDFILE"\nexit 0\n',
      );
      const { exitPromise, relayPidFile, workerPidFile } = await spawnWrapper(workerScriptPath);

      const relayPid = await waitForPidFile(relayPidFile);
      await waitForPidFile(workerPidFile);

      // No signal sent — the worker exits on its own. Before the WK-0156
      // fix, the wrapper `exec`'d into the worker, so the shell (and its
      // EXIT trap) never survived to reap the relay: 10+ orphans were
      // observed from completed, not just cancelled, runs.
      const exit = await exitPromise;

      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();
      expect(await waitUntilDead(relayPid)).toBe(true);
    });
  });
});

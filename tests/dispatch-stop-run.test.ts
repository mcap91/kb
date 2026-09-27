/**
 * WK-0144 — `stopRun` tests.
 *
 * Covers: successful kill, already-terminated run, already-dead recorded
 * process (ESRCH), and an unresolvable run-id. Also covers the v1/v2
 * dual-layout write-back, since a naive write of v1's fixed state shape over
 * a v2 run's root `state.json` would downgrade it to `schema_version: 1` and
 * drop fields (`handoff_id`/`model`/`outcome`/...) that `status()`/
 * `cleanup()`/`wait()` key off `schema_version === 2` to read correctly.
 *
 * Real child processes throughout, no `vi.mock`/`vi.spyOn` on `process.kill`
 * — matches this repo's evidence convention (DEC-0009, see
 * `spawn-isolated.test.ts`'s header comment): a hand-rolled fake of
 * process/signal behavior would invent the shape of something real, and a
 * real subprocess is cheap and deterministic enough not to need one. The
 * "already dead" fixture spawns a trivial process and awaits its real exit
 * before reusing its pid, so the ESRCH path is exercised for real rather
 * than simulated.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopRun } from '../packages/dispatch-core/src/stop-run.js';

let repoRoot: string;
const liveChildren: ChildProcess[] = [];

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'kb-dispatch-stop-run-'));
});

afterEach(async () => {
  // Best-effort cleanup for any child a failing assertion left alive.
  for (const child of liveChildren.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await rm(repoRoot, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
}

async function writeV2State(runDir: string, overrides: Record<string, unknown>): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeJson(join(runDir, 'state.json'), {
    schema_version: 2,
    run_id: 'RUN-placeholder',
    handoff_id: 'HO-placeholder',
    model: 'deepseek',
    status: 'running',
    pid: 0,
    pgid: 0,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    heartbeat_at: new Date().toISOString(),
    completed_at: null,
    outcome: null,
    delivery_status: null,
    branch: null,
    error: null,
    ...overrides,
  });
}

async function writeV1State(runDir: string, overrides: Record<string, unknown>): Promise<void> {
  await mkdir(join(runDir, 'metadata'), { recursive: true });
  await writeJson(join(runDir, 'metadata', 'state.json'), {
    schema_version: 1,
    run_id: 'RUN-placeholder',
    status: 'running',
    pid: 0,
    pgid: 0,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    heartbeat_at: new Date().toISOString(),
    ...overrides,
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit within timeout')), timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

/** A trivial process, spawned and reaped so its pid is confirmed dead — a real ESRCH fixture. */
async function spawnDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  if (!pid) throw new Error('failed to spawn fixture process');
  await waitForExit(child, 5000);
  return pid;
}

/** A live process that stays up until signaled — its own process group leader (detached). */
function spawnLongRunning(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true });
  liveChildren.push(child);
  return child;
}

describe('stopRun — invalid/missing run-id', () => {
  it('returns RUN_NOT_FOUND when no run directory matches', async () => {
    const result = await stopRun(repoRoot, 'RUN-does-not-exist');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('RUN_NOT_FOUND');
  });

  it('returns RUN_NOT_FOUND when .agent-runs/runs does not exist at all', async () => {
    const result = await stopRun(repoRoot, 'RUN-anything');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal, got ok');
    expect(result.error).toBe('RUN_NOT_FOUND');
  });
});

describe('stopRun — already-terminated run', () => {
  it('returns ok with alreadyTerminal, sends no signal, and leaves state.json untouched', async () => {
    const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0700', 'RUN-terminal');
    await writeV2State(runDir, {
      run_id: 'RUN-terminal',
      handoff_id: 'HO-0700',
      status: 'delivered',
      // A real, currently-alive pid: if stopRun signaled it, this test process
      // itself would be dead. Proves "no signal sent" by the test surviving,
      // and the state-unchanged assertion below proves it more directly.
      pid: process.pid,
      pgid: process.pid,
      completed_at: new Date().toISOString(),
      outcome: 'delivered',
      delivery_status: 'delivered',
      branch: 'dispatch/HO-0700',
    });

    const result = await stopRun(repoRoot, 'RUN-terminal');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.alreadyTerminal).toBe(true);
    expect(result.data.previousStatus).toBe('delivered');
    expect(result.data.handoffId).toBe('HO-0700');
    expect(result.data.note).toBeDefined();

    const stateAfter = await readJson(join(runDir, 'state.json'));
    expect(stateAfter.status).toBe('delivered');
    expect(stateAfter.pid).toBe(process.pid);
  });
});

describe('stopRun — already-dead recorded process (ESRCH)', () => {
  it('v2 layout: marks cancelled with a note, preserving schema_version 2 and other fields', async () => {
    const deadPid = await spawnDeadPid();
    const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0701', 'RUN-dead');
    await writeV2State(runDir, {
      run_id: 'RUN-dead',
      handoff_id: 'HO-0701',
      model: 'qwen3:8b',
      status: 'running',
      pid: deadPid,
      pgid: deadPid,
    });

    const result = await stopRun(repoRoot, 'RUN-dead');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.alreadyTerminal).toBe(false);
    expect(result.data.previousStatus).toBe('running');
    expect(result.data.note).toBeDefined();

    const stateAfter = await readJson(join(runDir, 'state.json'));
    expect(stateAfter.status).toBe('cancelled');
    expect(stateAfter.schema_version).toBe(2);
    expect(stateAfter.handoff_id).toBe('HO-0701');
    expect(stateAfter.model).toBe('qwen3:8b');
    expect(stateAfter.completed_at).toEqual(expect.any(String));
  });

  it('v1 layout: marks cancelled via writeStateMetadata, no root state.json created', async () => {
    const deadPid = await spawnDeadPid();
    const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0702', 'RUN-v1dead');
    await writeV1State(runDir, {
      run_id: 'RUN-v1dead',
      status: 'running',
      pid: deadPid,
      pgid: deadPid,
    });

    const result = await stopRun(repoRoot, 'RUN-v1dead');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.alreadyTerminal).toBe(false);
    expect(result.data.previousStatus).toBe('running');

    const stateAfter = await readJson(join(runDir, 'metadata', 'state.json'));
    expect(stateAfter.status).toBe('cancelled');
    expect(stateAfter.schema_version).toBe(1);

    // The v1 branch must write back under metadata/, not create a v2-shaped root file.
    await expect(readFile(join(runDir, 'state.json'), 'utf-8')).rejects.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('stopRun — successful kill (real live process)', () => {
  it('signals the process group, the process actually exits, and state.json is marked cancelled', async () => {
    const child = spawnLongRunning();
    const pid = child.pid!;
    const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0703', 'RUN-live');
    await writeV2State(runDir, {
      run_id: 'RUN-live',
      handoff_id: 'HO-0703',
      model: 'deepseek',
      status: 'running',
      pid,
      pgid: pid, // detached spawn => pid is also the process group leader
    });

    const exited = waitForExit(child, 5000);
    const result = await stopRun(repoRoot, 'RUN-live');
    await exited; // proves SIGTERM was actually delivered and killed the real process

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}: ${result.message}`);
    expect(result.data.alreadyTerminal).toBe(false);
    expect(result.data.previousStatus).toBe('running');
    expect(result.data.note).toBeUndefined();

    const stateAfter = await readJson(join(runDir, 'state.json'));
    expect(stateAfter.status).toBe('cancelled');
    expect(stateAfter.schema_version).toBe(2);
    expect(stateAfter.handoff_id).toBe('HO-0703');
    expect(stateAfter.model).toBe('deepseek');
    expect(stateAfter.completed_at).toEqual(expect.any(String));
  });
});

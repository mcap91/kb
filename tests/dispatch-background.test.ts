/**
 * PLN-0004 S1 Wave 2a — background dispatch pair tests.
 *
 * Covers `dispatch-background.ts` (ACTIVE_RUN_EXISTS guard, start-gate poll)
 * and `dispatch-controller-entry.ts` (controller state-writing logic: argv
 * parsing, the initial `running` state.json shape, and the pipeline-result ->
 * terminal-state mapping, including the thrown-pipeline path). These are
 * unit tests against the exported pure/scoped helpers only — no real
 * controller process is spawned and no real pipeline run happens; that
 * full end-to-end proof is Wave 3's job. No personal/absolute paths appear
 * in fixtures (WK-0043 rule); all filesystem tests use temp dirs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkActiveRunExists,
  pollDispatchStartGate,
} from '../packages/dispatch-core/src/dispatch-background.js';
import {
  buildRunningState,
  deriveTerminalFields,
  parseControllerArgv,
} from '../packages/dispatch-core/src/dispatch-controller-entry.js';
import { ok, fail, type DispatchResult } from '../packages/dispatch-core/src/errors.js';
import type { DeliveryOutcome } from '../packages/dispatch-core/src/delivery.js';
import type { DispatchResult2 } from '../packages/dispatch-core/src/pipeline.js';

// An implausibly large pid: reliably not a live process on any real host,
// used to simulate "controller is dead" / "recorded pid is dead" without
// actually killing anything.
const DEAD_PID = 999_999_999;

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'kb-dispatch-bg-'));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

async function writeState(handoffId: string, runId: string, state: Record<string, unknown>): Promise<string> {
  const runDir = join(repoRoot, '.agent-runs', 'runs', handoffId, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  return runDir;
}

// ---------------------------------------------------------------------------
// ACTIVE_RUN_EXISTS guard (dispatch-background.ts)
// ---------------------------------------------------------------------------

describe('checkActiveRunExists (ACTIVE_RUN_EXISTS guard)', () => {
  it('refuses when a running run has a fresh heartbeat and a live pid', async () => {
    await writeState('HO-0200', 'RUN-aaa', {
      schema_version: 2,
      status: 'running',
      pid: process.pid,
      heartbeat_at: new Date().toISOString(),
    });

    const result = await checkActiveRunExists(repoRoot, 'HO-0200');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('ACTIVE_RUN_EXISTS');
    }
  });

  it('refuses when a running run has a dead pid but a fresh heartbeat', async () => {
    await writeState('HO-0201', 'RUN-bbb', {
      schema_version: 2,
      status: 'running',
      pid: DEAD_PID,
      heartbeat_at: new Date().toISOString(),
    });

    const result = await checkActiveRunExists(repoRoot, 'HO-0201');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('ACTIVE_RUN_EXISTS');
    }
  });

  it('refuses when a running run has a stale heartbeat but a live pid', async () => {
    await writeState('HO-0202', 'RUN-ccc', {
      schema_version: 2,
      status: 'running',
      pid: process.pid,
      heartbeat_at: new Date(Date.now() - 3600_000).toISOString(), // 1h stale
    });

    const result = await checkActiveRunExists(repoRoot, 'HO-0202');
    expect(result.ok).toBe(false);
  });

  it('passes when the only run for the handoff is terminal', async () => {
    await writeState('HO-0203', 'RUN-ddd', {
      schema_version: 2,
      status: 'completed',
      pid: process.pid,
      heartbeat_at: new Date(Date.now() - 3600_000).toISOString(),
    });

    const result = await checkActiveRunExists(repoRoot, 'HO-0203');
    expect(result.ok).toBe(true);
  });

  it('passes when a running run has both a stale heartbeat and a dead pid (crashed run)', async () => {
    await writeState('HO-0204', 'RUN-eee', {
      schema_version: 2,
      status: 'running',
      pid: DEAD_PID,
      heartbeat_at: new Date(Date.now() - 3600_000).toISOString(),
    });

    const result = await checkActiveRunExists(repoRoot, 'HO-0204');
    expect(result.ok).toBe(true);
  });

  it('passes when no run directory exists yet for the handoff', async () => {
    const result = await checkActiveRunExists(repoRoot, 'HO-NONE');
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Start-gate poll (dispatch-background.ts)
// ---------------------------------------------------------------------------

describe('pollDispatchStartGate (exact-path polling)', () => {
  it('returns once state.json appears at the exact path with running status', async () => {
    const handoffId = 'HO-0300';
    const runId = 'RUN-new1';
    const statePath = join(repoRoot, '.agent-runs', 'runs', handoffId, runId, 'state.json');

    const pollPromise = pollDispatchStartGate(statePath, process.pid, 5000);

    setTimeout(() => {
      void writeState(handoffId, runId, {
        schema_version: 2,
        status: 'running',
        pid: 4242,
        heartbeat_at: new Date().toISOString(),
      });
    }, 250);

    const result = await pollPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pid).toBe(4242);
    }
  });

  it('times out when no state.json ever appears at the path', async () => {
    const statePath = join(repoRoot, '.agent-runs', 'runs', 'HO-0302', 'RUN-nonexist', 'state.json');
    const result = await pollDispatchStartGate(statePath, process.pid, 400);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('BACKGROUND_LAUNCH_FAILED');
      expect(result.message).toMatch(/timeout/i);
    }
  });

  it('fails fast (not a full timeout) when the controller pid is already dead', async () => {
    const statePath = join(repoRoot, '.agent-runs', 'runs', 'HO-0303', 'RUN-dead', 'state.json');
    const result = await pollDispatchStartGate(statePath, DEAD_PID, 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('BACKGROUND_LAUNCH_FAILED');
      expect(result.message).toMatch(/exited/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Controller state-writing logic (dispatch-controller-entry.ts)
// ---------------------------------------------------------------------------

describe('parseControllerArgv', () => {
  it('parses required and optional flags including --run-id', () => {
    const parsed = parseControllerArgv([
      '--dir', 'C:\\repo',
      '--handoff', 'wiki/handoffs/HO-0004.md',
      '--model', 'deepseek',
      '--run-id', 'RUN-abc-123',
      '--effort', 'high',
      '--no-preflight',
    ]);
    expect(parsed).toEqual({
      dir: 'C:\\repo',
      handoff: 'wiki/handoffs/HO-0004.md',
      model: 'deepseek',
      runId: 'RUN-abc-123',
      effort: 'high',
      preflight: false,
    });
  });

  it('defaults preflight to true, leaves effort and runId undefined when omitted', () => {
    const parsed = parseControllerArgv(['--dir', 'C:\\repo', '--handoff', 'HO-1.md', '--model', 'qwen3:8b']);
    expect(parsed.preflight).toBe(true);
    expect(parsed.effort).toBeUndefined();
    expect(parsed.runId).toBeUndefined();
  });
});

describe('buildRunningState', () => {
  it('produces the schema_version 2 running shape', () => {
    const state = buildRunningState({
      runId: 'RUN-abc',
      handoffId: 'HO-0004',
      model: 'deepseek',
      pid: 1234,
      startedAt: '2026-09-07T00:00:00.000Z',
      heartbeatAt: '2026-09-07T00:00:00.000Z',
    });

    expect(state).toEqual({
      schema_version: 2,
      run_id: 'RUN-abc',
      handoff_id: 'HO-0004',
      model: 'deepseek',
      status: 'running',
      pid: 1234,
      pgid: 1234,
      started_at: '2026-09-07T00:00:00.000Z',
      heartbeat_at: '2026-09-07T00:00:00.000Z',
      completed_at: null,
      outcome: null,
      delivery_status: null,
      branch: null,
      error: null,
    });
  });
});

describe('deriveTerminalFields', () => {
  const pipelineOk = (delivery: DeliveryOutcome): DispatchResult<DispatchResult2> =>
    ok({
      runId: 'RUN-x',
      handoffId: 'HO-1',
      model: 'deepseek',
      delivery,
      responsePath: 'C:\\run\\HO-1.response.md',
      runDir: 'C:\\run',
    });

  it('maps a delivered outcome to completed, carrying the branch', () => {
    const result = pipelineOk({ status: 'delivered', branch: 'dispatch/HO-1', commitSha: 'abc123', changedFiles: ['src/a.ts'] });
    expect(deriveTerminalFields(result, null)).toEqual({
      status: 'completed',
      outcome: 'completed',
      delivery_status: 'delivered',
      branch: 'dispatch/HO-1',
      error: null,
    });
  });

  it('maps a no_changes outcome to completed with no branch', () => {
    const result = pipelineOk({ status: 'no_changes' });
    expect(deriveTerminalFields(result, null)).toEqual({
      status: 'completed',
      outcome: 'completed',
      delivery_status: 'no_changes',
      branch: null,
      error: null,
    });
  });

  it('maps refused_out_of_scope to refused with a null error (refusals are data, not errors)', () => {
    const result = pipelineOk({ status: 'refused_out_of_scope', offendingPaths: ['../outside'], quarantinePath: 'C:\\q.diff' });
    expect(deriveTerminalFields(result, null)).toEqual({
      status: 'refused',
      outcome: 'refused',
      delivery_status: 'refused_out_of_scope',
      branch: null,
      error: null,
    });
  });

  it('maps secret_in_diff to refused with a null error', () => {
    const result = pipelineOk({ status: 'secret_in_diff', patterns: ['aws_access_key_id'], quarantinePath: 'C:\\q.diff' });
    expect(deriveTerminalFields(result, null)).toEqual({
      status: 'refused',
      outcome: 'refused',
      delivery_status: 'secret_in_diff',
      branch: null,
      error: null,
    });
  });

  it('maps conflict to failed with a descriptive error', () => {
    const result = pipelineOk({ status: 'conflict', existingTree: 'tree1', newTree: 'tree2' });
    const terminal = deriveTerminalFields(result, null);
    expect(terminal.status).toBe('failed');
    expect(terminal.outcome).toBe('failed');
    expect(terminal.delivery_status).toBe('conflict');
    expect(terminal.branch).toBeNull();
    expect(terminal.error).toMatch(/conflict/i);
  });

  it('maps a delivery-level error to failed, surfacing the delivery message', () => {
    const result = pipelineOk({ status: 'error', message: 'delivery script exploded' });
    expect(deriveTerminalFields(result, null)).toEqual({
      status: 'failed',
      outcome: 'failed',
      delivery_status: 'error',
      branch: null,
      error: 'delivery script exploded',
    });
  });

  it('maps an ok:false pipeline result to failed, surfacing the error code and message', () => {
    const result: DispatchResult<DispatchResult2> = fail('PREFLIGHT_FAILED', 'bwrap userns unavailable');
    expect(deriveTerminalFields(result, null)).toEqual({
      status: 'failed',
      outcome: null,
      delivery_status: null,
      branch: null,
      error: 'PREFLIGHT_FAILED: bwrap userns unavailable',
    });
  });

  it('maps any other ok:false error code to failed too', () => {
    const result: DispatchResult<DispatchResult2> = fail('WSL2_EXEC_FAILED', 'exec timed out');
    expect(deriveTerminalFields(result, null).status).toBe('failed');
  });

  it('maps a thrown pipeline exception to failed (the thrown-pipeline path)', () => {
    expect(deriveTerminalFields(null, new Error('boom'))).toEqual({
      status: 'failed',
      outcome: null,
      delivery_status: null,
      branch: null,
      error: 'boom',
    });
  });

  it('maps a non-Error thrown value to failed via String() coercion', () => {
    expect(deriveTerminalFields(null, 'raw string throw')).toEqual({
      status: 'failed',
      outcome: null,
      delivery_status: null,
      branch: null,
      error: 'raw string throw',
    });
  });

  it('maps a null result with nothing thrown to failed (defensive default)', () => {
    expect(deriveTerminalFields(null, null)).toEqual({
      status: 'failed',
      outcome: null,
      delivery_status: null,
      branch: null,
      error: 'Pipeline produced no result.',
    });
  });
});

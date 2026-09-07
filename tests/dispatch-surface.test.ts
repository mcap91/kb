/**
 * PLN-0004 S1 Wave 3 — surface + integration tests.
 *
 * Covers the four wave-3 surfaces named in s1-rulings.md:
 * 1. The MCP `dispatch` tool's registration + input schema (tools.ts).
 * 2. `status()`'s new `runs[]` array against a v2 run dir (status.ts).
 * 3. `status()`'s dual-layout scan across a v1 and a v2 run dir together.
 * 4. `waitForRun()`'s v2 dual-layout lookup returning a terminal v2 run
 *    immediately (wait.ts + lookup.ts's `resolveRun` v2 fallback).
 *
 * Pure unit/fixture tests only — no real controller process is spawned and no
 * real pipeline run happens (mirrors dispatch-background.test.ts). No
 * personal/absolute paths in fixtures (WK-0043 rule); all filesystem tests
 * use temp dirs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tools } from '../packages/dispatch-mcp/src/tools.js';
import { status } from '../packages/dispatch-core/src/status.js';
import { waitForRun } from '../packages/dispatch-core/src/wait.js';

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'kb-dispatch-surface-'));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeV2State(runDir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeJson(join(runDir, 'state.json'), {
    schema_version: 2,
    run_id: 'RUN-placeholder',
    handoff_id: 'HO-placeholder',
    model: 'deepseek',
    status: 'running',
    pid: process.pid,
    pgid: process.pid,
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

// ---------------------------------------------------------------------------
// 1. MCP `dispatch` tool
// ---------------------------------------------------------------------------

describe('dispatch MCP tool', () => {
  it('is registered with the expected input schema fields', () => {
    const dispatchTool = tools.find((t) => t.name === 'dispatch');
    expect(dispatchTool).toBeTruthy();
    expect(dispatchTool?.description).toBeTruthy();
    expect(typeof dispatchTool?.handler).toBe('function');

    // Duck-typed rather than importing zod's internal ZodObject/shape type names
    // (which zod v4 restructured under a `$Zod*` core namespace) — this is a
    // runtime introspection of the same z.object({...}) shape tools.ts builds.
    const shape = (dispatchTool?.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual(
      ['dir', 'effort', 'handoff', 'model', 'preflight', 'verbose'].sort(),
    );
  });

  it('accepts the required fields and rejects a call missing them', () => {
    const dispatchTool = tools.find((t) => t.name === 'dispatch')!;

    const valid = dispatchTool.inputSchema.safeParse({
      dir: repoRoot,
      handoff: 'wiki/handoffs/HO-0004.md',
      model: 'deepseek',
    });
    expect(valid.success).toBe(true);

    const missingModel = dispatchTool.inputSchema.safeParse({
      dir: repoRoot,
      handoff: 'wiki/handoffs/HO-0004.md',
    });
    expect(missingModel.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. status() runs[]
// ---------------------------------------------------------------------------

describe('status() runs[] (s1-rulings ruling 6)', () => {
  it('includes a v2 run with the expected RunInfo shape and a log tail', async () => {
    const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0500', 'RUN-v2a');
    await writeV2State(runDir, { run_id: 'RUN-v2a', handoff_id: 'HO-0500' });

    const logLines = Array.from({ length: 15 }, (_, i) => `line-${i}`);
    await writeFile(join(runDir, 'pi-output.log'), `${logLines.join('\n')}\n`, 'utf-8');

    const result = await status(repoRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const run = result.data.runs.find((r) => r.runId === 'RUN-v2a');
    expect(run).toBeTruthy();
    expect(run?.handoffId).toBe('HO-0500');
    expect(run?.schemaVersion).toBe(2);
    expect(run?.model).toBe('deepseek');
    expect(run?.status).toBe('running');
    expect(run?.stale).toBe(false);
    expect(run?.runtimeSecs).toEqual(expect.any(Number));
    expect(run?.heartbeatAgeSecs).toEqual(expect.any(Number));
    expect(run?.logTail).toEqual(logLines.slice(-10));
  });

  it('marks an active run stale when its heartbeat is old and its pid is dead', async () => {
    const DEAD_PID = 999_999_999;
    const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0510', 'RUN-v2stale');
    await writeV2State(runDir, {
      run_id: 'RUN-v2stale',
      handoff_id: 'HO-0510',
      pid: DEAD_PID,
      pgid: DEAD_PID,
      heartbeat_at: new Date(Date.now() - 3600_000).toISOString(),
    });

    const result = await status(repoRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const run = result.data.runs.find((r) => r.runId === 'RUN-v2stale');
    expect(run?.stale).toBe(true);
    expect(run?.logTail).toBeNull(); // no pi-output.log written for this fixture
  });

  it('enumerates both v1 (metadata/state.json) and v2 (root state.json) run dirs together', async () => {
    const v1RunDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0501', 'RUN-v1a');
    await mkdir(join(v1RunDir, 'metadata'), { recursive: true });
    await writeJson(join(v1RunDir, 'metadata', 'state.json'), {
      schema_version: 1,
      run_id: 'RUN-v1a',
      status: 'completed',
      pid: process.pid,
      pgid: process.pid,
      started_at: new Date(Date.now() - 120_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const v2RunDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0502', 'RUN-v2b');
    await writeV2State(v2RunDir, {
      run_id: 'RUN-v2b',
      handoff_id: 'HO-0502',
      model: 'qwen3:8b',
      status: 'completed',
      completed_at: new Date(Date.now() - 60_000).toISOString(),
      started_at: new Date(Date.now() - 120_000).toISOString(),
      outcome: 'completed',
      delivery_status: 'delivered',
      branch: 'dispatch/HO-0502',
    });

    const result = await status(repoRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const v1Run = result.data.runs.find((r) => r.runId === 'RUN-v1a');
    const v2Run = result.data.runs.find((r) => r.runId === 'RUN-v2b');

    expect(v1Run).toBeTruthy();
    expect(v1Run?.handoffId).toBe('HO-0501');
    expect(v1Run?.schemaVersion).toBe(1);
    expect(v1Run?.status).toBe('completed');
    expect(v1Run?.model).toBeNull();
    expect(v1Run?.deliveryStatus).toBeNull();

    expect(v2Run).toBeTruthy();
    expect(v2Run?.schemaVersion).toBe(2);
    expect(v2Run?.deliveryStatus).toBe('delivered');
    expect(v2Run?.branch).toBe('dispatch/HO-0502');

    // Repo-scoped run count (unlike the token buckets, this reads only under
    // repoRoot, so it's safe to assert without isolating the operator config dir).
    expect(result.data.runCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 4. waitForRun v2 dual-layout lookup
// ---------------------------------------------------------------------------

describe('waitForRun v2 dual-layout lookup (s1-rulings ruling 5/7)', () => {
  it('returns immediately with the terminal status for a v2 run, timeout 0', async () => {
    const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0503', 'RUN-v2c');
    await writeV2State(runDir, {
      run_id: 'RUN-v2c',
      handoff_id: 'HO-0503',
      status: 'completed',
      started_at: new Date(Date.now() - 30_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 5_000).toISOString(),
      completed_at: new Date(Date.now() - 5_000).toISOString(),
      outcome: 'completed',
      delivery_status: 'delivered',
      branch: 'dispatch/HO-0503',
    });

    const result = await waitForRun({ dir: repoRoot, runId: 'RUN-v2c', timeoutSeconds: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.status).toBe('completed');
    expect(result.data.runId).toBe('RUN-v2c');
    expect(result.data.handoffId).toBe('HO-0503');
    expect(result.data.completedAt).toEqual(expect.any(String));
    expect(result.data.reviewId).toBe('');
  });

  it('returns the current (non-terminal) v2 status on timeout without a v1 metadata dir', async () => {
    const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0504', 'RUN-v2d');
    await writeV2State(runDir, { run_id: 'RUN-v2d', handoff_id: 'HO-0504', status: 'running' });

    const result = await waitForRun({
      dir: repoRoot,
      runId: 'RUN-v2d',
      timeoutSeconds: 0,
      pollIntervalMs: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.status).toBe('running');
    expect(result.data.runId).toBe('RUN-v2d');
  });
});

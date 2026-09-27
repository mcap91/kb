/**
 * WK-0153 — `listUnhandledRuns`: computes the reminder list of
 * finished-but-unhandled dispatch runs from existing `.agent-runs/runs/`
 * disk state plus `wiki/handoffs/` review evidence. No new bookkeeping —
 * "handled" is derived, never asserted. Mirrors dispatch-background.test.ts's
 * fixture style (temp dirs, hand-written v2 state.json, no wiki bootstrap
 * needed since this module only reads wiki/handoffs/ directly).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listUnhandledRuns } from '../packages/dispatch-core/src/unhandled-runs.js';

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'kb-dispatch-unhandled-'));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

async function writeV2State(handoffId: string, runId: string, state: Record<string, unknown>): Promise<void> {
  const runDir = join(repoRoot, '.agent-runs', 'runs', handoffId, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'state.json'),
    JSON.stringify({ schema_version: 2, ...state }, null, 2),
    'utf-8',
  );
}

async function writeReviewHO(hoId: string, baseRef: string, reviewedRun: string): Promise<void> {
  const dir = join(repoRoot, 'wiki', 'handoffs');
  await mkdir(dir, { recursive: true });
  const content = [
    '---',
    `id: "${hoId}"`,
    'mode: code_review',
    `base_ref: "${baseRef}"`,
    `reviewed_run: "${reviewedRun}"`,
    'status: "draft"',
    '---',
    '',
  ].join('\n');
  await writeFile(join(dir, `${hoId}.md`), content, 'utf-8');
}

describe('listUnhandledRuns — WK-0153', () => {
  describe('no runs on disk', () => {
    it('returns an empty array when .agent-runs/runs does not exist', async () => {
      const result = await listUnhandledRuns(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([]);
    });
  });

  describe('delivered run discharge via review HO', () => {
    it('reports a delivered run as unhandled when no review HO exists', async () => {
      await writeV2State('HO-0100', 'RUN-aaa', {
        handoff_id: 'HO-0100',
        run_id: 'RUN-aaa',
        status: 'delivered',
        completed_at: '2026-09-26T10:00:00Z',
        branch: 'dispatch/HO-0100',
      });

      const result = await listUnhandledRuns(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([
        {
          handoff_id: 'HO-0100',
          run_id: 'RUN-aaa',
          status: 'delivered',
          branch: 'dispatch/HO-0100',
          completed_at: '2026-09-26T10:00:00Z',
        },
      ]);
    });

    it('discharges (empties) once a review HO names this exact run as reviewed_run', async () => {
      await writeV2State('HO-0100', 'RUN-aaa', {
        handoff_id: 'HO-0100',
        run_id: 'RUN-aaa',
        status: 'delivered',
        completed_at: '2026-09-26T10:00:00Z',
        branch: 'dispatch/HO-0100',
      });
      await writeReviewHO('HO-0200', 'dispatch/HO-0100', 'RUN-aaa');

      const result = await listUnhandledRuns(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([]);
    });

    it('stays unhandled when the review HO names a different reviewed_run', async () => {
      await writeV2State('HO-0100', 'RUN-aaa', {
        handoff_id: 'HO-0100',
        run_id: 'RUN-aaa',
        status: 'delivered',
        completed_at: '2026-09-26T10:00:00Z',
        branch: 'dispatch/HO-0100',
      });
      await writeReviewHO('HO-0200', 'dispatch/HO-0100', 'RUN-bbb');

      const result = await listUnhandledRuns(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.run_id).toBe('RUN-aaa');
      expect(result.data[0]?.status).toBe('delivered');
    });
  });

  describe('failed/refused/cancelled/timed_out runs', () => {
    it('always reports a failed run as unhandled (no review can discharge it)', async () => {
      await writeV2State('HO-0300', 'RUN-ccc', {
        handoff_id: 'HO-0300',
        run_id: 'RUN-ccc',
        status: 'failed',
        completed_at: '2026-09-26T11:00:00Z',
        branch: null,
      });

      const result = await listUnhandledRuns(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([
        {
          handoff_id: 'HO-0300',
          run_id: 'RUN-ccc',
          status: 'failed',
          branch: 'dispatch/HO-0300',
          completed_at: '2026-09-26T11:00:00Z',
        },
      ]);
    });
  });

  describe('suppression by an in-flight retry', () => {
    it('suppresses the terminal run while a non-terminal run of the same HO exists', async () => {
      await writeV2State('HO-0100', 'RUN-aaa', {
        handoff_id: 'HO-0100',
        run_id: 'RUN-aaa',
        status: 'delivered',
        completed_at: '2026-09-26T10:00:00Z',
        branch: 'dispatch/HO-0100',
      });
      await writeV2State('HO-0100', 'RUN-bbb', {
        handoff_id: 'HO-0100',
        run_id: 'RUN-bbb',
        status: 'running',
        completed_at: null,
        branch: null,
      });

      const result = await listUnhandledRuns(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([]);
    });
  });

  describe('latest terminal run only', () => {
    it('reports only the latest of two terminal runs for the same HO', async () => {
      await writeV2State('HO-0100', 'RUN-older', {
        handoff_id: 'HO-0100',
        run_id: 'RUN-older',
        status: 'delivered',
        completed_at: '2026-09-20T10:00:00Z',
        branch: 'dispatch/HO-0100',
      });
      await writeV2State('HO-0100', 'RUN-newer', {
        handoff_id: 'HO-0100',
        run_id: 'RUN-newer',
        status: 'delivered',
        completed_at: '2026-09-25T10:00:00Z',
        branch: 'dispatch/HO-0100',
      });

      const result = await listUnhandledRuns(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.run_id).toBe('RUN-newer');
    });
  });

  describe('unreadable run state', () => {
    it('surfaces a run dir with neither state.json nor metadata/meta.json as "unreadable"', async () => {
      const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0400', 'RUN-ddd');
      await mkdir(runDir, { recursive: true });
      // Deliberately no state.json and no metadata/meta.json written.

      const result = await listUnhandledRuns(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.handoff_id).toBe('HO-0400');
      expect(result.data[0]?.run_id).toBe('RUN-ddd');
      expect(result.data[0]?.status).toBe('unreadable');
      expect(result.data[0]?.note).toBeDefined();
    });
  });

  describe('cross-HO isolation', () => {
    it('reports independent unhandled runs for two different HOs', async () => {
      await writeV2State('HO-0500', 'RUN-eee', {
        handoff_id: 'HO-0500',
        run_id: 'RUN-eee',
        status: 'delivered',
        completed_at: '2026-09-26T09:00:00Z',
        branch: 'dispatch/HO-0500',
      });
      await writeV2State('HO-0600', 'RUN-fff', {
        handoff_id: 'HO-0600',
        run_id: 'RUN-fff',
        status: 'failed',
        completed_at: '2026-09-26T09:30:00Z',
        branch: null,
      });

      const result = await listUnhandledRuns(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(2);

      const byHandoff = new Map(result.data.map((run) => [run.handoff_id, run]));
      expect(byHandoff.get('HO-0500')?.run_id).toBe('RUN-eee');
      expect(byHandoff.get('HO-0500')?.status).toBe('delivered');
      expect(byHandoff.get('HO-0600')?.run_id).toBe('RUN-fff');
      expect(byHandoff.get('HO-0600')?.status).toBe('failed');
    });
  });
});

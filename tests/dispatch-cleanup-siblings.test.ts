/**
 * WK-0153 build AC: "`cleanup` of a run also removes older sibling run dirs
 * of the same HO." Covers the post-pass in `cleanup.ts` that, once any run
 * of a handoff is removed by the existing orphan/age logic, sweeps every
 * OLDER remaining run of that same handoff too — so an older terminal run
 * can never resurface as "latest" after a newer one has been cleaned up.
 *
 * Unit tests against the real `cleanup()` export, no mocks — filesystem
 * state lives in a temp dir per test (WK-0043 rule: no personal/absolute
 * paths baked into fixtures).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanup } from '../packages/dispatch-core/src/cleanup.js';

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'kb-dispatch-cleanup-sib-'));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

/** Writes a v2 run dir (`state.json` at the run root, schema_version 2) with a given `completed_at`. */
async function writeV2Run(handoffId: string, runId: string, completedAt: string): Promise<string> {
  const runDir = join(repoRoot, '.agent-runs', 'runs', handoffId, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'state.json'),
    `${JSON.stringify(
      {
        schema_version: 2,
        run_id: runId,
        handoff_id: handoffId,
        model: 'deepseek',
        status: 'delivered',
        pid: null,
        pgid: null,
        started_at: '2020-01-01T00:00:00.000Z',
        heartbeat_at: completedAt,
        completed_at: completedAt,
        outcome: 'delivered',
        delivery_status: 'delivered',
        branch: `dispatch/${handoffId}`,
        error: null,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return runDir;
}

/** Forces a run dir's own mtime backward so the existing age-based orphan check flags it. */
async function ageRunDir(runDir: string, daysAgo: number): Promise<void> {
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await utimes(runDir, past, past);
}

async function listRunIds(handoffId: string): Promise<string[]> {
  try {
    return await readdir(join(repoRoot, '.agent-runs', 'runs', handoffId));
  } catch {
    return [];
  }
}

describe('cleanup — WK-0153 sibling cleanup', () => {
  it('removes all older siblings of a handoff once one of its runs is removed', async () => {
    await writeV2Run('HO-0100', 'RUN-old', '2020-01-01T00:00:00.000Z');
    await writeV2Run('HO-0100', 'RUN-mid', '2020-06-01T00:00:00.000Z');
    await writeV2Run('HO-0100', 'RUN-new', '2021-01-01T00:00:00.000Z');

    // Only RUN-old is old enough to be flagged by the existing age check;
    // RUN-mid and RUN-new keep their natural (just-created) fresh mtime.
    await ageRunDir(join(repoRoot, '.agent-runs', 'runs', 'HO-0100', 'RUN-old'), 30);

    const result = await cleanup({ dir: repoRoot, maxAgeDays: 7 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Sibling sweep keeps only the newest remaining run (RUN-new); RUN-mid
    // is removed too even though it was well under the age threshold.
    expect(await listRunIds('HO-0100')).toEqual(['RUN-new']);

    expect(result.data.orphanRuns).toContain('HO-0100/RUN-old');
    expect(result.data.orphanRuns).toContain('HO-0100/RUN-mid');
    expect(result.data.orphanRuns).not.toContain('HO-0100/RUN-new');
    expect(result.data.totalRemoved).toBe(2);
  });

  it('does not touch any runs when nothing is old enough to be removed', async () => {
    await writeV2Run('HO-0100', 'RUN-a', '2020-01-01T00:00:00.000Z');
    await writeV2Run('HO-0100', 'RUN-b', '2021-01-01T00:00:00.000Z');
    // Both dirs keep their natural fresh mtime — neither exceeds maxAgeDays.

    const result = await cleanup({ dir: repoRoot, maxAgeDays: 7 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await listRunIds('HO-0100')).toEqual(expect.arrayContaining(['RUN-a', 'RUN-b']));
    expect((await listRunIds('HO-0100')).length).toBe(2);
    expect(result.data.orphanRuns).toEqual([]);
    expect(result.data.totalRemoved).toBe(0);
  });

  it('isolates sibling cleanup to the affected HO — a sweep in HO-0100 never touches HO-0200', async () => {
    await writeV2Run('HO-0100', 'RUN-old', '2020-01-01T00:00:00.000Z');
    await writeV2Run('HO-0100', 'RUN-new', '2021-01-01T00:00:00.000Z');
    await ageRunDir(join(repoRoot, '.agent-runs', 'runs', 'HO-0100', 'RUN-old'), 30);

    await writeV2Run('HO-0200', 'RUN-x', '2020-03-01T00:00:00.000Z');
    await writeV2Run('HO-0200', 'RUN-y', '2020-09-01T00:00:00.000Z');
    // HO-0200 runs both keep fresh mtime — neither is old, neither is a sibling of HO-0100.

    const result = await cleanup({ dir: repoRoot, maxAgeDays: 7 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await listRunIds('HO-0100')).toEqual(['RUN-new']);
    expect(await listRunIds('HO-0200')).toEqual(expect.arrayContaining(['RUN-x', 'RUN-y']));
    expect((await listRunIds('HO-0200')).length).toBe(2);

    expect(result.data.orphanRuns).toEqual(['HO-0100/RUN-old']);
    expect(result.data.totalRemoved).toBe(1);
  });
});

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { CleanupOpts, CleanupReport } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';

const DEFAULT_MAX_AGE_DAYS = 7;

async function listReviewDirs(repoRoot: string): Promise<string[]> {
  const reviewsDir = join(repoRoot, '.agent-runs', 'reviews');
  try {
    return await readdir(reviewsDir);
  } catch {
    return [];
  }
}

async function listRunDirs(repoRoot: string): Promise<{ handoffId: string; runId: string }[]> {
  const runsDir = join(repoRoot, '.agent-runs', 'runs');
  let handoffDirs: string[];
  try {
    handoffDirs = await readdir(runsDir);
  } catch {
    return [];
  }

  const runs: { handoffId: string; runId: string }[] = [];
  for (const handoffId of handoffDirs) {
    const handoffPath = join(runsDir, handoffId);
    try {
      const runIds = await readdir(handoffPath);
      for (const runId of runIds) {
        runs.push({ handoffId, runId });
      }
    } catch {
      // skip inaccessible directories
    }
  }

  return runs;
}




async function isOlderThan(path: string, maxAgeMs: number): Promise<boolean> {
  if (maxAgeMs <= 0) return true;
  try {
    const s = await stat(path);
    return Date.now() - s.mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

// WK-0153: ordering key for sibling-run cleanup. v2 runs carry `completed_at`
// directly on the run-root `state.json` (schema_version 2); v1 runs carry it
// on `metadata/meta.json` instead (status.ts's dual-layout comment; wait.ts
// reads the same file). Falls back to the run dir's own mtime — the same
// signal `isOlderThan` above already relies on — when neither file yields a
// parseable timestamp (e.g. a still-running run with no completed_at yet).
async function getRunTimestampMs(runDir: string): Promise<number> {
  try {
    const raw = await readFile(join(runDir, 'state.json'), 'utf-8');
    const state = JSON.parse(raw) as Record<string, unknown>;
    if (state.schema_version === 2 && typeof state.completed_at === 'string') {
      const ms = Date.parse(state.completed_at);
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    // fall through to v1
  }

  try {
    const raw = await readFile(join(runDir, 'metadata', 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw) as Record<string, unknown>;
    if (typeof meta.completed_at === 'string') {
      const ms = Date.parse(meta.completed_at);
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    // fall through to mtime
  }

  try {
    const s = await stat(runDir);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

export async function cleanup(opts: CleanupOpts = {}): Promise<DispatchResult<CleanupReport>> {
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  const report: CleanupReport = {
    orphanReviews: [],
    orphanRuns: [],
    staleTokens: [],
    expiredTokens: [],
    totalRemoved: 0,
  };

  try {
    if (opts.dir) {
      const reviewIds = await listReviewDirs(opts.dir);

      for (const reviewId of reviewIds) {
        const reviewPath = join(opts.dir, '.agent-runs', 'reviews', reviewId);
        const old = await isOlderThan(reviewPath, maxAgeMs);
        if (old) {
          await rm(reviewPath, { recursive: true, force: true });
          report.orphanReviews.push(reviewId);
          report.totalRemoved++;
        }
      }
    }

    if (opts.dir) {
      const runs = await listRunDirs(opts.dir);
      const reviewIds = await listReviewDirs(opts.dir);
      const reviewIdSet = new Set(reviewIds);

      for (const { handoffId, runId } of runs) {
        const runDir = join(opts.dir, '.agent-runs', 'runs', handoffId, runId);
        const metaPath = join(runDir, 'metadata', 'review.json');
        let isOrphan = false;

        try {
          const raw = await readFile(metaPath, 'utf-8');
          const meta = JSON.parse(raw) as { review_id?: string; reviewId?: string };
          const reviewId = meta.review_id ?? meta.reviewId;
          if (reviewId && !reviewIdSet.has(reviewId)) {
            isOrphan = true;
          }
        } catch {
          const old = await isOlderThan(runDir, maxAgeMs);
          if (old) isOrphan = true;
        }

        if (isOrphan) {
          await rm(runDir, { recursive: true, force: true });
          report.orphanRuns.push(`${handoffId}/${runId}`);
          report.totalRemoved++;
        }
      }
    }

    // WK-0153: a removed run supersedes all OLDER runs of the same HO — sweep
    // them too, so an older terminal run can't resurface as "latest" once a
    // newer one is cleaned up.
    if (opts.dir) {
      const dir = opts.dir;
      const affectedHandoffIds = new Set<string>();
      for (const entry of report.orphanRuns) {
        const handoffId = entry.split('/')[0];
        if (handoffId) affectedHandoffIds.add(handoffId);
      }

      if (affectedHandoffIds.size > 0) {
        const remainingRuns = await listRunDirs(dir);

        for (const handoffId of affectedHandoffIds) {
          const siblings = remainingRuns.filter((r) => r.handoffId === handoffId);
          if (siblings.length <= 1) continue;

          const withTimestamp = await Promise.all(
            siblings.map(async (s) => ({
              runId: s.runId,
              timestampMs: await getRunTimestampMs(join(dir, '.agent-runs', 'runs', handoffId, s.runId)),
            })),
          );

          // Newest first; keep index 0, remove the rest (the older siblings).
          withTimestamp.sort((a, b) => b.timestampMs - a.timestampMs);

          for (const stale of withTimestamp.slice(1)) {
            const staleRunDir = join(dir, '.agent-runs', 'runs', handoffId, stale.runId);
            await rm(staleRunDir, { recursive: true, force: true });
            report.orphanRuns.push(`${handoffId}/${stale.runId}`);
            report.totalRemoved++;
          }
        }
      }
    }

    return ok(report);
  } catch (err) {
    return fail('CLEANUP_ERROR', 'Cleanup failed unexpectedly.', err);
  }
}

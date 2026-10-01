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

    return ok(report);
  } catch (err) {
    return fail('CLEANUP_ERROR', 'Cleanup failed unexpectedly.', err);
  }
}

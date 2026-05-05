import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { CleanupOpts, CleanupReport, DispatchToken } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { getConfigDir, getTokenDir, type TokenState } from './paths.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum age in days for stale tokens and orphan artifacts. */
const DEFAULT_MAX_AGE_DAYS = 7;

/** Token states in the lifecycle. */
const ALL_TOKEN_STATES: TokenState[] = ['pending', 'launching', 'consumed', 'rejected'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * List all token files in a given state directory.
 *
 * Returns an array of { reviewId, token, filePath } objects.
 */
async function listTokens(
  state: TokenState,
): Promise<{ reviewId: string; token: DispatchToken; filePath: string }[]> {
  const dir = getTokenDir(state);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // directory doesn't exist yet
  }

  const tokens: { reviewId: string; token: DispatchToken; filePath: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = join(dir, entry);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const token = JSON.parse(raw) as DispatchToken;
      const reviewId = entry.replace(/\.json$/, '');
      tokens.push({ reviewId, token, filePath });
    } catch {
      // Skip malformed token files
    }
  }

  return tokens;
}

/**
 * List all review IDs from a repo's .agent-runs/reviews/ directory.
 */
async function listReviewDirs(repoRoot: string): Promise<string[]> {
  const reviewsDir = join(repoRoot, '.agent-runs', 'reviews');
  try {
    return await readdir(reviewsDir);
  } catch {
    return [];
  }
}

/**
 * List all run directories from a repo's .agent-runs/runs/ directory.
 */
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
      // Skip inaccessible directories
    }
  }

  return runs;
}

/**
 * Get the set of all known review IDs across all token state directories.
 */
async function getAllKnownReviewIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const state of ALL_TOKEN_STATES) {
    const tokens = await listTokens(state);
    for (const t of tokens) {
      ids.add(t.reviewId);
    }
  }
  return ids;
}

/**
 * Check if a file/directory is older than the given age threshold.
 */
async function isOlderThan(path: string, maxAgeMs: number): Promise<boolean> {
  try {
    const s = await stat(path);
    return Date.now() - s.mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cleanup implementation
// ---------------------------------------------------------------------------

/**
 * Clean up stale dispatch runtime state.
 *
 * Operations:
 * 1. Remove orphan reviews (review bundles with no corresponding token)
 * 2. Remove orphan runs (run directories with no corresponding review)
 * 3. Recover stale launching tokens (stuck in launching/ beyond threshold)
 * 4. Remove expired consumed/rejected tokens past retention period
 */
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
    // -------------------------------------------------------------------
    // 1. Remove orphan reviews
    // -------------------------------------------------------------------
    if (opts.dir) {
      const reviewIds = await listReviewDirs(opts.dir);
      const knownIds = await getAllKnownReviewIds();

      for (const reviewId of reviewIds) {
        if (!knownIds.has(reviewId)) {
          const reviewPath = join(opts.dir, '.agent-runs', 'reviews', reviewId);
          const old = await isOlderThan(reviewPath, maxAgeMs);
          if (old) {
            await rm(reviewPath, { recursive: true, force: true });
            report.orphanReviews.push(reviewId);
            report.totalRemoved++;
          }
        }
      }
    }

    // -------------------------------------------------------------------
    // 2. Remove orphan runs
    // -------------------------------------------------------------------
    if (opts.dir) {
      const runs = await listRunDirs(opts.dir);
      const reviewIds = await listReviewDirs(opts.dir);
      const reviewIdSet = new Set(reviewIds);

      // A run is orphan if we can't find a review that references its handoff ID
      // We check by reading the run's launch-meta.json
      for (const { handoffId, runId } of runs) {
        const runDir = join(opts.dir, '.agent-runs', 'runs', handoffId, runId);
        const metaPath = join(runDir, 'launch-meta.json');
        let isOrphan = false;

        try {
          const raw = await readFile(metaPath, 'utf-8');
          const meta = JSON.parse(raw) as { reviewId?: string };
          if (meta.reviewId && !reviewIdSet.has(meta.reviewId)) {
            isOrphan = true;
          }
        } catch {
          // If no meta, and old enough, consider orphan
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

    // -------------------------------------------------------------------
    // 3. Recover stale launching tokens
    // -------------------------------------------------------------------
    const launchingTokens = await listTokens('launching');
    for (const { reviewId, token, filePath } of launchingTokens) {
      const expiry = new Date(token.payload.expiry);
      const createdAt = new Date(token.createdAt);
      const isExpired = expiry.getTime() <= Date.now();
      const isStale = Date.now() - createdAt.getTime() > maxAgeMs;

      if (isExpired || isStale) {
        // Move to rejected
        const rejectedDir = getTokenDir('rejected');
        const { rename } = await import('node:fs/promises');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(rejectedDir, { recursive: true });
        const destPath = join(rejectedDir, `${reviewId}.json`);
        try {
          await rename(filePath, destPath);
        } catch {
          // If rename fails, try remove
          await rm(filePath, { force: true });
        }
        report.staleTokens.push(reviewId);
        report.totalRemoved++;
      }
    }

    // -------------------------------------------------------------------
    // 4. Remove expired consumed/rejected tokens
    // -------------------------------------------------------------------
    for (const state of ['consumed', 'rejected'] as TokenState[]) {
      const tokens = await listTokens(state);
      for (const { reviewId, filePath } of tokens) {
        const old = await isOlderThan(filePath, maxAgeMs);
        if (old) {
          await rm(filePath, { force: true });
          report.expiredTokens.push(reviewId);
          report.totalRemoved++;
        }
      }
    }

    return ok(report);
  } catch (err) {
    return fail('CLEANUP_ERROR', 'Cleanup failed unexpectedly.', err);
  }
}

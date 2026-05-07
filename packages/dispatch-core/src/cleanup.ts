import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { CleanupOpts, CleanupReport, DispatchToken } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { getTokenDir, type TokenState } from './paths.js';

const DEFAULT_MAX_AGE_DAYS = 7;
const TOKEN_RECOVERY_GRACE_MS = 5 * 60 * 1000;
const ALL_TOKEN_STATES: TokenState[] = ['pending', 'launching', 'consumed', 'rejected'];

function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function isRecordedProcessAlive(pid: number, pgid: number): boolean {
  if (process.platform !== 'win32' && pgid > 0) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH')) {
        return true;
      }
    }
  }

  return pid > 0 ? isAlive(pid) : false;
}

async function listTokens(
  state: TokenState,
): Promise<{ reviewId: string; token: DispatchToken; filePath: string }[]> {
  const dir = getTokenDir(state);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
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
      // skip malformed token files
    }
  }

  return tokens;
}

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

async function listTerminalRunStates(
  repoRoot: string,
): Promise<Map<string, 'consumed' | 'rejected'>> {
  const states = new Map<string, 'consumed' | 'rejected'>();
  const runsDir = join(repoRoot, '.agent-runs', 'runs');

  let handoffDirs: string[];
  try {
    handoffDirs = await readdir(runsDir);
  } catch {
    return states;
  }

  for (const handoffId of handoffDirs) {
    let runIds: string[];
    try {
      runIds = await readdir(join(runsDir, handoffId));
    } catch {
      continue;
    }

    for (const runId of runIds) {
      const metaPath = join(runsDir, handoffId, runId, 'metadata', 'meta.json');
      try {
        const raw = await readFile(metaPath, 'utf-8');
        const meta = JSON.parse(raw) as { status?: string; review_id?: string; reviewId?: string };
        const reviewId = meta.review_id ?? meta.reviewId;
        if (!reviewId || !meta.status) {
          continue;
        }

        if (meta.status === 'rejected') {
          states.set(reviewId, 'rejected');
        } else if ([
          'completed',
          'failed',
          'timed_out',
          'cancelled',
        ].includes(meta.status)) {
          states.set(reviewId, 'consumed');
        }
      } catch {
        // ignore missing or malformed meta.json
      }
    }
  }

  return states;
}

async function findRunForReviewId(
  repoRoot: string,
  reviewId: string,
): Promise<string | null> {
  const runsDir = join(repoRoot, '.agent-runs', 'runs');

  let handoffDirs: string[];
  try {
    handoffDirs = await readdir(runsDir);
  } catch {
    return null;
  }

  for (const handoffId of handoffDirs) {
    let runIds: string[];
    try {
      runIds = await readdir(join(runsDir, handoffId));
    } catch {
      continue;
    }

    for (const runId of runIds) {
      const reviewPath = join(runsDir, handoffId, runId, 'metadata', 'review.json');
      try {
        const raw = await readFile(reviewPath, 'utf-8');
        const review = JSON.parse(raw) as { review_id?: string; reviewId?: string };
        if ((review.review_id ?? review.reviewId) === reviewId) {
          return join(runsDir, handoffId, runId);
        }
      } catch {
        // keep scanning
      }
    }
  }

  return null;
}

async function moveTokenToState(
  filePath: string,
  reviewId: string,
  targetState: 'consumed' | 'rejected',
): Promise<void> {
  const targetDir = getTokenDir(targetState);
  await mkdir(targetDir, { recursive: true });
  const destPath = join(targetDir, `${reviewId}.json`);
  try {
    await rename(filePath, destPath);
  } catch {
    await rm(filePath, { force: true });
  }
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

    const terminalRunStates = opts.dir
      ? await listTerminalRunStates(opts.dir)
      : new Map<string, 'consumed' | 'rejected'>();

    const launchingTokens = await listTokens('launching');
    for (const { reviewId, token, filePath } of launchingTokens) {
      const expiry = new Date(token.payload.expiry);
      const createdAt = new Date(token.createdAt);
      const isExpired = Number.isFinite(expiry.getTime()) && expiry.getTime() <= Date.now();
      const isStale = Number.isFinite(createdAt.getTime()) && Date.now() - createdAt.getTime() > maxAgeMs;

      let targetState: 'consumed' | 'rejected' | null = terminalRunStates.get(reviewId) ?? null;

      if (!targetState && opts.dir) {
        const runDir = await findRunForReviewId(opts.dir, reviewId);
        if (runDir) {
          try {
            const stateRaw = await readFile(join(runDir, 'metadata', 'state.json'), 'utf-8');
            const state = JSON.parse(stateRaw) as {
              status?: string;
              pid?: number;
              pgid?: number;
              heartbeat_at?: string;
            };
            const heartbeatMs = Date.parse(state.heartbeat_at ?? '');
            const heartbeatStale = !Number.isFinite(heartbeatMs) || (Date.now() - heartbeatMs) > TOKEN_RECOVERY_GRACE_MS;
            const processAlive = typeof state.pid === 'number'
              ? isRecordedProcessAlive(state.pid, state.pgid ?? state.pid)
              : false;

            if (state.status && state.status !== 'launching') {
              targetState = state.status === 'rejected' ? 'rejected' : 'consumed';
            } else if (heartbeatStale && !processAlive) {
              targetState = 'rejected';
            }
          } catch {
            if (isExpired || isStale) {
              targetState = 'rejected';
            }
          }
        } else if (isExpired || isStale) {
          targetState = 'rejected';
        }
      } else if (!targetState && (isExpired || isStale)) {
        targetState = 'rejected';
      }

      if (targetState) {
        await moveTokenToState(filePath, reviewId, targetState);
        report.staleTokens.push(reviewId);
        report.totalRemoved++;
      }
    }

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

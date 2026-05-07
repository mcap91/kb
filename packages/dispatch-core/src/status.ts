import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { StatusResult, TokenInfo, DispatchToken } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { getTokenDir, type TokenState } from './paths.js';

const ACTIVE_HEARTBEAT_GRACE_MS = 5 * 60 * 1000;

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

async function listTerminalRunReviewIds(repoRoot: string): Promise<Set<string>> {
  const runsDir = join(repoRoot, '.agent-runs', 'runs');
  const reviewIds = new Set<string>();

  let handoffDirs: string[];
  try {
    handoffDirs = await readdir(runsDir);
  } catch {
    return reviewIds;
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
        if (reviewId && meta.status && meta.status !== 'launching') {
          reviewIds.add(reviewId);
        }
      } catch {
        // ignore missing or malformed meta.json
      }
    }
  }

  return reviewIds;
}

async function listActiveRunTokens(repoRoot: string): Promise<TokenInfo[]> {
  const runsDir = join(repoRoot, '.agent-runs', 'runs');
  const activeRuns: TokenInfo[] = [];

  let handoffDirs: string[];
  try {
    handoffDirs = await readdir(runsDir);
  } catch {
    return activeRuns;
  }

  for (const handoffId of handoffDirs) {
    let runIds: string[];
    try {
      runIds = await readdir(join(runsDir, handoffId));
    } catch {
      continue;
    }

    for (const runId of runIds) {
      const metadataDir = join(runsDir, handoffId, runId, 'metadata');
      try {
        const stateRaw = await readFile(join(metadataDir, 'state.json'), 'utf-8');
        const state = JSON.parse(stateRaw) as {
          status?: string;
          pid?: number;
          pgid?: number;
          heartbeat_at?: string;
        };

        if (state.status !== 'launching' || typeof state.pid !== 'number') {
          continue;
        }

        const heartbeatMs = Date.parse(state.heartbeat_at ?? '');
        const heartbeatFresh = Number.isFinite(heartbeatMs) && (Date.now() - heartbeatMs) <= ACTIVE_HEARTBEAT_GRACE_MS;
        const processAlive = isRecordedProcessAlive(state.pid, state.pgid ?? state.pid);
        if (!heartbeatFresh && !processAlive) {
          continue;
        }

        const reviewRaw = await readFile(join(metadataDir, 'review.json'), 'utf-8');
        const review = JSON.parse(reviewRaw) as {
          review_id?: string;
          reviewId?: string;
          handoff_id?: string;
          handoffId?: string;
          agent?: string;
          mode?: string;
          expires_at?: string;
          expiry?: string;
        };
        const reviewId = review.review_id ?? review.reviewId;
        if (!reviewId) {
          continue;
        }

        activeRuns.push({
          reviewId,
          handoffId: review.handoff_id ?? review.handoffId ?? handoffId,
          agent: review.agent ?? 'unknown',
          mode: review.mode ?? 'implement',
          expiry: review.expires_at ?? review.expiry ?? '',
        });
      } catch {
        // ignore incomplete run bundles
      }
    }
  }

  return activeRuns;
}

async function listTokensInState(state: TokenState): Promise<TokenInfo[]> {
  const dir = getTokenDir(state);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const tokens: TokenInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, entry), 'utf-8');
      const token = JSON.parse(raw) as DispatchToken;
      tokens.push({
        reviewId: token.payload.reviewId,
        handoffId: token.payload.handoffId,
        agent: token.payload.agent,
        mode: token.payload.mode,
        expiry: token.payload.expiry,
      });
    } catch {
      // skip malformed token files
    }
  }

  return tokens;
}

export async function status(dir: string): Promise<DispatchResult<StatusResult>> {
  const repoRoot = resolve(dir);
  try {
    const [pending, activeRuns, launchingTokens, consumed, rejected, terminalRunReviewIds] = await Promise.all([
      listTokensInState('pending'),
      listActiveRunTokens(repoRoot),
      listTokensInState('launching'),
      listTokensInState('consumed'),
      listTokensInState('rejected'),
      listTerminalRunReviewIds(repoRoot),
    ]);

    const now = Date.now();
    const staleLaunching = launchingTokens.filter((token) => {
      const expiryMs = Date.parse(token.expiry);
      const isExpired = Number.isFinite(expiryMs) && expiryMs <= now;
      return isExpired || terminalRunReviewIds.has(token.reviewId);
    });

    let runCount = 0;
    try {
      const handoffDirs = await readdir(join(repoRoot, '.agent-runs', 'runs'));
      for (const handoffId of handoffDirs) {
        const runs = await readdir(join(repoRoot, '.agent-runs', 'runs', handoffId));
        runCount += runs.length;
      }
    } catch {
      runCount = 0;
    }

    let reviewCount = 0;
    try {
      const reviews = await readdir(join(repoRoot, '.agent-runs', 'reviews'));
      reviewCount = reviews.length;
    } catch {
      reviewCount = 0;
    }

    return ok({
      repoRoot,
      pending,
      launching: activeRuns,
      staleLaunching,
      consumed,
      rejected,
      runCount,
      reviewCount,
    });
  } catch (err) {
    return fail('STATUS_ERROR', 'Failed to compute dispatch status.', err);
  }
}

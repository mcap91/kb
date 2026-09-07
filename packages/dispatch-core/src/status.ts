import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ActiveLaunchInfo, RunInfo, StatusResult, TokenInfo, DispatchToken } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { getTokenDir, type TokenState } from './paths.js';
import { readRunArtifacts } from './lookup.js';
import { isAlive, isRecordedProcessAlive } from './run-state.js';

const ACTIVE_HEARTBEAT_GRACE_MS = 5 * 60 * 1000;

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
        if (reviewId && meta.status && meta.status !== 'launching' && meta.status !== 'running') {
          reviewIds.add(reviewId);
        }
      } catch {
        // ignore missing or malformed meta.json
      }
    }
  }

  return reviewIds;
}

function extractActiveState(state: unknown): {
  startedAt: string | null;
  heartbeatAt: string | null;
  pid: number | null;
  pgid: number | null;
} {
  const s = state as Record<string, unknown> | null;
  return {
    startedAt: (s?.started_at as string) ?? null,
    heartbeatAt: (s?.heartbeat_at as string) ?? null,
    pid: typeof s?.pid === 'number' ? s.pid : null,
    pgid: typeof s?.pgid === 'number' ? s.pgid : null,
  };
}

async function listActiveRunTokens(repoRoot: string): Promise<ActiveLaunchInfo[]> {
  const runsDir = join(repoRoot, '.agent-runs', 'runs');
  const activeRuns: ActiveLaunchInfo[] = [];

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
      const runDir = join(runsDir, handoffId, runId);
      const metadataDir = join(runDir, 'metadata');
      try {
        const stateRaw = await readFile(join(metadataDir, 'state.json'), 'utf-8');
        const state = JSON.parse(stateRaw) as {
          status?: string;
          pid?: number;
          pgid?: number;
          heartbeat_at?: string;
        };

        if ((state.status !== 'launching' && state.status !== 'running') || typeof state.pid !== 'number') {
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

        const artifacts = await readRunArtifacts(runDir, { includeMeta: true });
        if (!artifacts.ok || (artifacts.data.status !== 'launching' && artifacts.data.status !== 'running')) {
          continue;
        }

        const stateInfo = extractActiveState(artifacts.data.state);
        activeRuns.push({
          reviewId,
          runId: artifacts.data.runId,
          handoffId: artifacts.data.handoffId || review.handoff_id || review.handoffId || handoffId,
          agent: artifacts.data.agent,
          mode: artifacts.data.mode,
          status: artifacts.data.status,
          runDir: artifacts.data.runDir,
          responsePath: artifacts.data.responsePath,
          metaPath: artifacts.data.metaPath,
          statePath: artifacts.data.statePath,
          launchPath: artifacts.data.launchPath,
          controllerPath: artifacts.data.controllerPath,
          stdoutPath: artifacts.data.stdoutPath,
          stderrPath: artifacts.data.stderrPath,
          startedAt: stateInfo.startedAt,
          heartbeatAt: stateInfo.heartbeatAt,
          pid: stateInfo.pid,
          pgid: stateInfo.pgid,
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

// ---------------------------------------------------------------------------
// v2 status runs[] (PLN-0004 S1 Wave 3, s1-rulings ruling 6). ADDITIVE ONLY —
// nothing above this line changes. Dual-layout scan of `.agent-runs/runs/`:
// v1 run dirs carry `metadata/state.json` (schema_version 1 or absent); v2 run
// dirs carry ONE `state.json` at the run root (schema_version 2). Both feed
// the same repo-wide `RunInfo[]` view; readers never need to know which
// layout a given run used.
// ---------------------------------------------------------------------------

const STALE_HEARTBEAT_THRESHOLD_SECS = 300;
const LOG_TAIL_LINES = 10;
const MAX_TERMINAL_RUNS = 10;

/** Both v1 and v2 use 'launching'/'running' as their only non-terminal statuses. */
function isTerminalRunStatus(runStatus: string): boolean {
  return runStatus !== 'launching' && runStatus !== 'running';
}

async function listAllRunDirs(repoRoot: string): Promise<Array<{ handoffId: string; runId: string }>> {
  const runsDir = join(repoRoot, '.agent-runs', 'runs');
  const found: Array<{ handoffId: string; runId: string }> = [];

  let handoffDirs: string[];
  try {
    handoffDirs = await readdir(runsDir);
  } catch {
    return found;
  }

  for (const handoffId of handoffDirs) {
    let runIds: string[];
    try {
      runIds = await readdir(join(runsDir, handoffId));
    } catch {
      continue;
    }
    for (const runId of runIds) {
      found.push({ handoffId, runId });
    }
  }

  return found;
}

async function tryReadJsonRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Last `lines` lines of `pi-output.log`, or null if it does not exist (v1 runs never write one). */
async function readLogTail(runDir: string, lines: number): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, 'pi-output.log'), 'utf-8');
  } catch {
    return null;
  }

  const allLines = raw.split('\n');
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop(); // drop the single trailing newline's empty segment, keep real blank lines
  }
  return allLines.slice(-lines);
}

async function buildRunInfo(
  repoRoot: string,
  handoffId: string,
  runId: string,
  now: number,
): Promise<RunInfo | null> {
  const runDir = join(repoRoot, '.agent-runs', 'runs', handoffId, runId);

  const v2State = await tryReadJsonRecord(join(runDir, 'state.json'));
  const isV2 = v2State !== null && v2State.schema_version === 2;
  const state = isV2 ? v2State : await tryReadJsonRecord(join(runDir, 'metadata', 'state.json'));
  if (!state) return null;

  const runStatus = typeof state.status === 'string' ? state.status : 'unknown';
  const startedAt = typeof state.started_at === 'string' ? state.started_at : null;
  const heartbeatAt = typeof state.heartbeat_at === 'string' ? state.heartbeat_at : null;
  const pid = typeof state.pid === 'number' ? state.pid : null;
  const pgid = typeof state.pgid === 'number' ? state.pgid : pid;
  const terminal = isTerminalRunStatus(runStatus);

  // v2's state.json carries `completed_at` directly. v1's `metadata/state.json`
  // never gained that field (it lives in `metadata/meta.json` instead, out of
  // scope for this read); v1's terminal write sets `heartbeat_at` to the same
  // timestamp it uses for `completed_at` (launch.ts's `finalize()`), so
  // `heartbeat_at` doubles as v1's terminal timestamp here.
  const completedAtRaw = isV2
    ? (typeof state.completed_at === 'string' ? state.completed_at : null)
    : (terminal ? heartbeatAt : null);

  let runtimeSecs: number | null = null;
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isFinite(startedMs)) {
    if (terminal) {
      const completedMs = completedAtRaw ? Date.parse(completedAtRaw) : NaN;
      if (Number.isFinite(completedMs)) {
        runtimeSecs = Math.max(0, (completedMs - startedMs) / 1000);
      }
    } else {
      runtimeSecs = Math.max(0, (now - startedMs) / 1000);
    }
  }

  let heartbeatAgeSecs: number | null = null;
  if (!terminal && heartbeatAt) {
    const heartbeatMs = Date.parse(heartbeatAt);
    if (Number.isFinite(heartbeatMs)) {
      heartbeatAgeSecs = Math.max(0, (now - heartbeatMs) / 1000);
    }
  }

  const processAlive = pid !== null && isRecordedProcessAlive(pid, pgid ?? pid);
  // ruling 6: stale = heartbeatAgeSecs > 300 && !processAlive. Naturally false
  // for terminal runs since heartbeatAgeSecs is null above.
  const stale = heartbeatAgeSecs !== null && heartbeatAgeSecs > STALE_HEARTBEAT_THRESHOLD_SECS && !processAlive;

  // Log tail: active v2 runs only (ruling 6) — terminal runs have a response
  // doc to read instead, and v1 runs never grew a pi-output.log.
  const logTail = isV2 && !terminal ? await readLogTail(runDir, LOG_TAIL_LINES) : null;

  return {
    runId,
    handoffId,
    model: isV2 && typeof state.model === 'string' ? state.model : null,
    status: runStatus,
    startedAt,
    runtimeSecs,
    heartbeatAt,
    heartbeatAgeSecs,
    stale,
    deliveryStatus: isV2 && typeof state.delivery_status === 'string' ? state.delivery_status : null,
    branch: isV2 && typeof state.branch === 'string' ? state.branch : null,
    logTail,
    schemaVersion: isV2 ? 2 : 1,
  };
}

/**
 * Repo-wide run view: all active (non-terminal) runs plus the 10 most recent
 * terminal runs by `started_at` (ruling 6 — `status` itself takes no
 * selection params; the single-run query is `wait-for-run`). Never throws —
 * a malformed or half-written run dir is skipped rather than failing the
 * whole `status()` call.
 */
async function buildRuns(repoRoot: string): Promise<RunInfo[]> {
  const runDirs = await listAllRunDirs(repoRoot);
  const now = Date.now();

  const infos: RunInfo[] = [];
  for (const { handoffId, runId } of runDirs) {
    try {
      const info = await buildRunInfo(repoRoot, handoffId, runId, now);
      if (info) infos.push(info);
    } catch {
      // Skip unreadable/malformed run dirs.
    }
  }

  const active = infos.filter((info) => !isTerminalRunStatus(info.status));
  const terminal = infos
    .filter((info) => isTerminalRunStatus(info.status))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .slice(0, MAX_TERMINAL_RUNS);

  return [...active, ...terminal];
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

    const runs = await buildRuns(repoRoot);

    return ok({
      repoRoot,
      pending,
      launching: activeRuns,
      staleLaunching,
      consumed,
      rejected,
      runCount,
      reviewCount,
      runs,
    });
  } catch (err) {
    return fail('STATUS_ERROR', 'Failed to compute dispatch status.', err);
  }
}

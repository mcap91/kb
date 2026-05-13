import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { HandoffMode } from './types.js';
import type { DispatchResult } from './errors.js';
import type { ResolvedRun, RunArtifactResult, InternalRunStatus, RunStatus } from './types-background.js';
import { ok, fail } from './errors.js';

function normalizeRunId(runId: string): string {
  return runId.startsWith('RUN-') ? runId : `RUN-${runId}`;
}

async function tryReadJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function tryReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

function deriveStatus(
  meta: Record<string, unknown> | null,
  state: Record<string, unknown> | null,
  launchMeta: Record<string, unknown> | null,
): InternalRunStatus {
  if (meta && typeof meta.status === 'string') {
    return meta.status as InternalRunStatus;
  }
  if (state && typeof state.status === 'string') {
    return state.status as InternalRunStatus;
  }
  if (launchMeta && typeof launchMeta.token_state === 'string') {
    if (launchMeta.token_state === 'rejected') return 'rejected';
    if (launchMeta.token_state === 'launching' || launchMeta.token_state === 'consumed') return 'launching';
  }
  return 'unknown';
}

function extractRunIdentity(
  launchMeta: Record<string, unknown> | null,
  metaJson: Record<string, unknown> | null,
  reviewJson: Record<string, unknown> | null,
): { reviewId: string | null; handoffId: string | null; agent: string | null; mode: string | null } {
  const reviewId =
    (launchMeta?.review_id as string) ??
    (metaJson?.review_id as string) ??
    (reviewJson?.review_id as string) ??
    null;
  const handoffId =
    (metaJson?.handoff_id as string) ??
    (reviewJson?.handoff_id as string) ??
    null;
  const agent =
    (metaJson?.agent as string) ??
    (reviewJson?.agent as string) ??
    null;
  const mode =
    (metaJson?.mode as string) ??
    (reviewJson?.mode as string) ??
    null;
  return { reviewId, handoffId, agent, mode };
}

export async function resolveRun(opts: {
  dir: string;
  reviewId?: string;
  runId?: string;
}): Promise<DispatchResult<ResolvedRun>> {
  if (!opts.reviewId && !opts.runId) {
    return fail('LOOKUP_FAILED', 'At least one of reviewId or runId is required.');
  }

  const repoRoot = resolve(opts.dir);
  const runsDir = join(repoRoot, '.agent-runs', 'runs');

  let handoffDirs: string[];
  try {
    handoffDirs = await readdir(runsDir);
  } catch {
    return fail('RUN_NOT_FOUND', 'No runs directory found.');
  }

  interface CandidateRun {
    runId: string;
    runDir: string;
    handoffId: string;
    reviewId: string;
    agent: string;
    mode: string;
    startedAt: string | null;
    status: InternalRunStatus;
  }

  const candidates: CandidateRun[] = [];

  for (const handoffId of handoffDirs) {
    let runIds: string[];
    try {
      runIds = await readdir(join(runsDir, handoffId));
    } catch {
      continue;
    }

    for (const runDirName of runIds) {
      const runDir = join(runsDir, handoffId, runDirName);
      const metadataDir = join(runDir, 'metadata');

      const bothProvided = Boolean(opts.reviewId && opts.runId);

      if (opts.runId && !bothProvided) {
        const normalizedTarget = normalizeRunId(opts.runId);
        if (runDirName !== normalizedTarget) continue;
      }

      const launchMeta = await tryReadJson(join(metadataDir, 'launch.json')) as Record<string, unknown> | null;
      const metaJson = await tryReadJson(join(metadataDir, 'meta.json')) as Record<string, unknown> | null;
      const reviewJson = await tryReadJson(join(metadataDir, 'review.json')) as Record<string, unknown> | null;
      const stateJson = await tryReadJson(join(metadataDir, 'state.json')) as Record<string, unknown> | null;

      const identity = extractRunIdentity(launchMeta, metaJson, reviewJson);

      if (bothProvided) {
        const normalizedTarget = normalizeRunId(opts.runId!);
        const matchesRunId = runDirName === normalizedTarget;
        const matchesReviewId = identity.reviewId === opts.reviewId;
        if (!matchesRunId && !matchesReviewId) continue;
      } else if (opts.reviewId && identity.reviewId !== opts.reviewId) {
        continue;
      }

      const status = deriveStatus(metaJson, stateJson, launchMeta);

      candidates.push({
        runId: runDirName,
        runDir,
        handoffId,
        reviewId: identity.reviewId ?? '',
        agent: identity.agent ?? 'unknown',
        mode: identity.mode ?? 'implement',
        startedAt: (launchMeta?.started_at as string) ?? null,
        status,
      });
    }
  }

  if (candidates.length === 0) {
    return fail('RUN_NOT_FOUND', `No run found matching ${opts.reviewId ? `reviewId=${opts.reviewId}` : ''}${opts.runId ? ` runId=${opts.runId}` : ''}.`);
  }

  if (opts.reviewId && opts.runId) {
    const normalizedRunId = normalizeRunId(opts.runId);
    const match = candidates.find((c) => c.runId === normalizedRunId && c.reviewId === opts.reviewId);
    if (!match) {
      return fail('LOOKUP_FAILED', `reviewId=${opts.reviewId} and runId=${opts.runId} do not resolve to the same run.`, {
        matchedRunDirs: candidates.map((c) => c.runDir),
      });
    }
    return ok({
      runId: match.runId,
      reviewId: match.reviewId,
      handoffId: match.handoffId,
      agent: match.agent,
      mode: match.mode as HandoffMode,
      runDir: match.runDir,
      status: match.status,
      matchedRunDirs: [match.runDir],
    });
  }

  candidates.sort((a, b) => {
    if (!a.startedAt) return 1;
    if (!b.startedAt) return -1;
    return b.startedAt.localeCompare(a.startedAt);
  });

  const best = candidates[0]!;
  return ok({
    runId: best.runId,
    reviewId: best.reviewId,
    handoffId: best.handoffId,
    agent: best.agent,
    mode: best.mode as HandoffMode,
    runDir: best.runDir,
    status: best.status,
    matchedRunDirs: candidates.map((c) => c.runDir),
  });
}

export async function readRunArtifacts(
  runDir: string,
  opts?: { includeMeta?: boolean; includeLogs?: boolean },
): Promise<DispatchResult<RunArtifactResult>> {
  const metadataDir = join(runDir, 'metadata');

  const launchMeta = await tryReadJson(join(metadataDir, 'launch.json')) as Record<string, unknown> | null;
  const metaJson = await tryReadJson(join(metadataDir, 'meta.json')) as Record<string, unknown> | null;
  const stateJson = await tryReadJson(join(metadataDir, 'state.json')) as Record<string, unknown> | null;
  const reviewJson = await tryReadJson(join(metadataDir, 'review.json')) as Record<string, unknown> | null;
  const controllerJson = await tryReadJson(join(metadataDir, 'controller.json')) as Record<string, unknown> | null;

  const identity = extractRunIdentity(launchMeta, metaJson, reviewJson);
  const internalStatus = deriveStatus(metaJson, stateJson, launchMeta);

  if (internalStatus === 'unknown') {
    return fail('LOOKUP_FAILED', 'Cannot derive run status from available metadata.', {
      runDir,
      hasLaunch: launchMeta !== null,
      hasMeta: metaJson !== null,
      hasState: stateJson !== null,
    });
  }

  const status = internalStatus as RunStatus;
  const response = await tryReadText(join(runDir, 'response.md'));

  const responsePath = join(runDir, 'response.md');
  const metaPath = join(metadataDir, 'meta.json');
  const statePath = join(metadataDir, 'state.json');
  const launchPath = join(metadataDir, 'launch.json');
  const controllerPath = join(metadataDir, 'controller.json');
  const stdoutPath = (launchMeta?.stdout_path as string)
    ?? (metaJson?.stdout_path as string)
    ?? null;
  const stderrPath = (launchMeta?.stderr_path as string)
    ?? (metaJson?.stderr_path as string)
    ?? null;

  let logs: { stdout: string | null; stderr: string | null } | undefined;
  if (opts?.includeLogs) {
    logs = {
      stdout: stdoutPath ? await tryReadText(stdoutPath) : null,
      stderr: stderrPath ? await tryReadText(stderrPath) : null,
    };
  }

  const runId = (launchMeta?.run_id as string)
    ?? (metaJson?.run_id as string)
    ?? basename(runDir);
  const reviewId = identity.reviewId ?? '';
  const handoffId = identity.handoffId ?? '';

  return ok({
    reviewId,
    runId,
    handoffId,
    agent: identity.agent ?? 'unknown',
    mode: (identity.mode ?? 'implement') as HandoffMode,
    status,
    runDir,
    responsePath,
    metaPath,
    statePath,
    launchPath,
    controllerPath: controllerJson ? controllerPath : null,
    stdoutPath,
    stderrPath,
    response,
    meta: opts?.includeMeta ? metaJson : null,
    state: opts?.includeMeta ? stateJson : null,
    launch: opts?.includeMeta ? launchMeta : null,
    controller: opts?.includeMeta ? controllerJson : null,
    ...(logs ? { logs } : {}),
  });
}

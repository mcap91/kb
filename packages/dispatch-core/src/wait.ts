import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { WaitForRunResult, WaitForRunOpts } from './types-background.js';
import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';
import { resolveRun, readRunArtifacts } from './lookup.js';

const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_POLL_INTERVAL_MS = 1000;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'rejected']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractFromState(state: unknown): {
  startedAt: string | null;
  heartbeatAt: string | null;
  pid: number | null;
  pgid: number | null;
} {
  const s = state as Record<string, unknown> | null;
  return {
    startedAt: (s?.started_at as string) ?? null,
    heartbeatAt: (s?.heartbeat_at as string) ?? null,
    pid: (s?.pid as number) ?? null,
    pgid: (s?.pgid as number) ?? null,
  };
}

export async function waitForRun(opts: WaitForRunOpts): Promise<DispatchResult<WaitForRunResult>> {
  const resolved = await resolveRun({
    dir: opts.dir,
    reviewId: opts.reviewId,
    runId: opts.runId,
  });
  if (!resolved.ok) return resolved;

  const { runDir } = resolved.data;
  const metadataDir = join(runDir, 'metadata');
  const metaPath = join(metadataDir, 'meta.json');

  const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = await readFile(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as Record<string, unknown>;
      if (typeof meta.status === 'string' && TERMINAL_STATUSES.has(meta.status)) {
        const artifacts = await readRunArtifacts(runDir, { includeMeta: true });
        if (!artifacts.ok) return artifacts;
        const stateInfo = extractFromState(artifacts.data.state);
        return ok({
          reviewId: artifacts.data.reviewId,
          runId: artifacts.data.runId,
          handoffId: artifacts.data.handoffId,
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
          completedAt: (meta.completed_at as string) ?? null,
          pid: stateInfo.pid,
          pgid: stateInfo.pgid,
        });
      }
    } catch {
      // meta.json doesn't exist yet, keep polling
    }

    await sleep(pollIntervalMs);
  }

  const artifacts = await readRunArtifacts(runDir, { includeMeta: true });
  if (!artifacts.ok) return artifacts;
  const stateInfo = extractFromState(artifacts.data.state);
  const isTerminal = TERMINAL_STATUSES.has(artifacts.data.status);
  const completedAt = isTerminal
    ? ((artifacts.data.meta as Record<string, unknown> | null)?.completed_at as string) ?? null
    : null;

  return ok({
    reviewId: artifacts.data.reviewId,
    runId: artifacts.data.runId,
    handoffId: artifacts.data.handoffId,
    agent: artifacts.data.agent,
    mode: artifacts.data.mode,
    status: isTerminal ? artifacts.data.status : 'launching',
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
    completedAt,
    pid: stateInfo.pid,
    pgid: stateInfo.pgid,
  });
}

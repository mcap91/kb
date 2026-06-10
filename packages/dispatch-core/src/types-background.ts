import type { HandoffMode } from './types.js';

export interface BackgroundLaunchResult {
  reviewId: string;
  runId: string;
  handoffId: string;
  agent: string;
  mode: HandoffMode;
  status: 'launching';
  runDir: string;
  responsePath: string;
  metaPath: string;
  statePath: string;
  launchPath: string;
  controllerPath: string;
  stdoutPath: string | null;
  stderrPath: string;
  startedAt: string;
  heartbeatAt: string;
  pid: number;
  pgid: number;
}

export type TerminalRunStatus = 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'rejected';
export type RunStatus = 'launching' | 'running' | TerminalRunStatus;
export type InternalRunStatus = RunStatus | 'unknown';

export interface WaitForRunResult {
  reviewId: string;
  runId: string;
  handoffId: string;
  agent: string;
  mode: HandoffMode;
  status: RunStatus;
  runDir: string;
  responsePath: string;
  metaPath: string;
  statePath: string;
  launchPath: string;
  controllerPath: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  completedAt: string | null;
  pid: number | null;
  pgid: number | null;
}

export interface RunArtifactResult {
  reviewId: string;
  runId: string;
  handoffId: string;
  agent: string;
  mode: HandoffMode;
  status: RunStatus;
  runDir: string;
  responsePath: string;
  metaPath: string;
  statePath: string;
  launchPath: string;
  controllerPath: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  response: string | null;
  meta: unknown | null;
  state: unknown | null;
  launch: unknown | null;
  controller: unknown | null;
  logs?: {
    stdout: string | null;
    stderr: string | null;
  };
}

export interface ControllerMetadata {
  schema_version: 1;
  review_id: string;
  run_id: string | null;
  controller_pid: number;
  started_at: string;
  confirmed_child_start_at: string | null;
  completed_at: string | null;
  status: 'launching' | 'running' | 'completed' | 'failed' | 'rejected';
  error: string | null;
}

export interface ResolvedRun {
  runId: string;
  reviewId: string;
  handoffId: string;
  agent: string;
  mode: HandoffMode;
  runDir: string;
  status: InternalRunStatus;
  matchedRunDirs: string[];
}

export interface BackgroundLaunchOpts {
  reviewId: string;
  dir: string;
  startupTimeoutMs?: number;
  verbose?: boolean;
}

export interface WaitForRunOpts {
  dir: string;
  reviewId?: string;
  runId?: string;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
}

export interface GetResponseOpts {
  dir: string;
  reviewId?: string;
  runId?: string;
  includeMeta?: boolean;
  includeLogs?: boolean;
}

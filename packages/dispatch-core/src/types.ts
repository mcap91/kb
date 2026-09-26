import type { BwrapProbeResult } from './tier.js';

// ---------------------------------------------------------------------------
// Handoff frontmatter — dispatch-owned, NOT manifest-driven
// ---------------------------------------------------------------------------

/** Handoff operation mode. */
export type HandoffMode = 'redteam' | 'code_review' | 'implement';

/** Handoff lifecycle status. */
export type HandoffStatus = 'draft' | 'reviewed' | 'launched' | 'completed' | 'failed';

/**
 * HO-* handoff frontmatter.
 *
 * Dispatch-owned: this type lives in dispatch-core, not wiki-core.
 * HO-* records are NOT manifest-driven wiki record types.
 * They are not valid targets for `wiki create` in MVP.
 */
export interface HandoffFrontmatter {
  schema_version: 1;
  id: string;
  title: string;
  subject: string;
  allowed_agents: string[];
  mode: HandoffMode;
  status?: HandoffStatus;
  created?: string;
  updated?: string;
  depends_on?: string[];
  area?: string;
  initiative?: string;
  work_item?: string;
  write_scope?: string[];
}

export type ReviewedWriteScopePathKind = 'file' | 'directory' | 'missing';
export type ReviewedWriteScopeAccessSource = 'self' | 'parent' | 'nearest_existing_ancestor';

export interface ReviewedWriteScopeEntry {
  declared_path: string;
  resolved_path: string;
  path_kind: ReviewedWriteScopePathKind;
  access_directory: string;
  access_source: ReviewedWriteScopeAccessSource;
}

export interface ReviewedWriteScope {
  declared_paths: string[];
  entries: ReviewedWriteScopeEntry[];
  access_directories: string[];
}

/**
 * Container-detection facts. Informational only — MVP gating never keys off
 * these (operator attestation is parked, WK-0034).
 */
export interface ContainerDetection {
  /** True if any container signal fired. */
  detected: boolean;
  /** `KUBERNETES_SERVICE_HOST` is present in the environment. */
  kubernetes_service_host: boolean;
  /** `/.dockerenv` exists. */
  dockerenv: boolean;
  /** First line of `/proc/1/cgroup`, or null when unavailable. */
  cgroup_hint: string | null;
}

/** Writability fact for a single filesystem location. */
export interface EnvironmentWritability {
  /** The resolved path probed, or null if it could not be resolved. */
  path: string | null;
  writable: boolean;
  detail: string;
}

/** Viability of a dispatch route on the current host. */
export type RouteViability = 'available' | 'degraded' | 'blocked' | 'unknown';

/** A per-route viability verdict derived from host-capability facts. */
export interface RouteVerdict {
  route: string;
  viability: RouteViability;
  detail: string;
}

/**
 * Result of a `check-environment` probe (WK-0134: thin stateless rewrite —
 * no registry, no persisted host-capabilities.json). `bwrap` mirrors the
 * exact fact `pipeline.ts` gates every dispatch on (`tier.ts` `probeBwrap()`).
 */
export interface CheckEnvironmentResult {
  checkedAt: string;
  platform: NodeJS.Platform;
  arch: string;
  bwrap: BwrapProbeResult;
  container: ContainerDetection;
  writability: {
    home: EnvironmentWritability;
    config_dir: EnvironmentWritability;
  };
  /** Per-route viability verdicts (derived, not persisted). */
  verdicts: RouteVerdict[];
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

/** Payload bound into a review/launch token. */
export interface TokenPayload {
  reviewId: string;
  handoffId: string;
  agent: string;
  mode: HandoffMode;
  repoRoot: string;
  inputManifestHash: string;
  registryHash: string;
  expiry: string;
}

/** A signed dispatch token wrapping a payload. */
export interface DispatchToken {
  payload: TokenPayload;
  signature: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Review types
// ---------------------------------------------------------------------------

/** Options for the review operation. */
export interface ReviewOpts {
  dir: string;
  handoff: string;
  agent: string;
  reviewedAndAcceptRisks: boolean;
  verbose?: boolean;
  model?: string;
  effort?: string;
}

/** Result of a successful review. */
export interface ReviewResult {
  reviewId: string;
  handoffId: string;
  agent: string;
  mode: HandoffMode;
  bundlePath: string;
  tokenPath: string;
  expiry: string;
}

// ---------------------------------------------------------------------------
// Create handoff types
// ---------------------------------------------------------------------------

export interface CreateHandoffOpts {
  dir: string;
  title: string;
  subject: string;
  allowed_agents: string[];
  mode: HandoffMode;
  status?: HandoffStatus;
  depends_on?: string[];
  area?: string;
  initiative?: string;
  work_item?: string;
  write_scope?: string[];
  read_first?: string[];
  objective?: string;
  constraints?: string[];
  expected_output?: string;
  context?: string;
  acceptance: string[];
  validation: string[];
  web?: boolean;
  credentials?: string[];
  data_mounts?: string[];
  export_mounts?: string[];
  base_ref?: string;
  vars?: string[];
  verbose?: boolean;
}

export interface CreateHandoffResult {
  handoffId: string;
  handoffPath: string;
  handoffRelativePath: string;
}

// ---------------------------------------------------------------------------
// Cleanup types
// ---------------------------------------------------------------------------

/** Options for the cleanup operation. */
export interface CleanupOpts {
  dir?: string;
  maxAgeDays?: number;
  verbose?: boolean;
}

/** Report from a cleanup run. */
export interface CleanupReport {
  orphanReviews: string[];
  orphanRuns: string[];
  staleTokens: string[];
  expiredTokens: string[];
  totalRemoved: number;
}

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

export interface TokenInfo {
  reviewId: string;
  handoffId: string;
  agent: string;
  mode: string;
  expiry: string;
}

export interface ActiveLaunchInfo {
  reviewId: string;
  runId: string;
  handoffId: string;
  agent: string;
  mode: string;
  status: string;
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
  pid: number | null;
  pgid: number | null;
  expiry: string;
}

export interface StatusResult {
  repoRoot: string;
  pending: TokenInfo[];
  launching: ActiveLaunchInfo[];
  staleLaunching: TokenInfo[];
  consumed: TokenInfo[];
  rejected: TokenInfo[];
  runCount: number;
  reviewCount: number;
  runs: RunInfo[];
}

// ---------------------------------------------------------------------------
// v2 status runs[] (PLN-0004 S1 Wave 3, s1-rulings ruling 6)
// ---------------------------------------------------------------------------

/**
 * Repo-wide per-run view, additive alongside the v1 token-bucket fields above.
 * Built by dual-layout scanning `.agent-runs/runs/`: v1 run dirs keep
 * `metadata/state.json` (schema_version 1 or absent); v2 run dirs keep ONE
 * `state.json` at the run root (schema_version 2). Both shapes populate this
 * one interface — fields with no v1 analog (`model`, `deliveryStatus`,
 * `branch`, `logTail`) are null for v1 rows.
 */
export interface RunInfo {
  runId: string;
  handoffId: string;
  model: string | null;
  status: string;
  startedAt: string | null;
  runtimeSecs: number | null;
  heartbeatAt: string | null;
  heartbeatAgeSecs: number | null;
  stale: boolean;
  deliveryStatus: string | null;
  branch: string | null;
  logTail: string[] | null;
  schemaVersion: number;
}

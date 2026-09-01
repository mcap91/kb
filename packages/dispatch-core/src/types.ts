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

export type EnvironmentCapabilityStatus = 'supported' | 'unsupported' | 'unknown' | 'not_applicable';

export interface EnvironmentCapability {
  status: EnvironmentCapabilityStatus;
  checked_at: string;
  detail: string;
}

/** Writability fact for a single filesystem location. */
export interface EnvironmentWritability {
  /** The resolved path probed, or null if it could not be resolved. */
  path: string | null;
  writable: boolean;
  detail: string;
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

export interface HostCapabilitiesRecord {
  schema_version: 1;
  checked_at: string;
  platform: NodeJS.Platform;
  arch: string;
  registry_hash: string;
  capabilities: {
    claude_linux_sandbox: EnvironmentCapability;
    claude_linux_add_dir: EnvironmentCapability;
    codex_linux_sandbox: EnvironmentCapability;
  };
  /** Container-detection facts (additive; absent on records written before WK-0034). */
  container?: ContainerDetection;
  /** HOME and resolved-config-dir writability facts (additive). */
  writability?: {
    home: EnvironmentWritability;
    config_dir: EnvironmentWritability;
  };
}

/** Viability of a dispatch route on the current host. */
export type RouteViability = 'available' | 'degraded' | 'blocked' | 'unknown';

/** A per-route viability verdict derived from host-capability facts. */
export interface RouteVerdict {
  route: string;
  viability: RouteViability;
  detail: string;
}

/** Non-blocking advisories produced by the launch environment gate. */
export interface GateDecision {
  warnings: string[];
}

export interface CheckEnvironmentResult {
  configDir: string;
  recordPath: string;
  record: HostCapabilitiesRecord;
  /** Per-route viability verdicts (derived, not persisted). */
  verdicts: RouteVerdict[];
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

export interface AgentInstructionTransport {
  kind: 'argv_path' | 'argv_content' | 'stdin';
}

export interface AgentResponseTransport {
  kind: 'file' | 'stdout_capture';
}

export interface AgentReadOnlyConfig {
  supported: boolean;
  argv_suffix?: string[];
  response_writable?: boolean;
}

export type ModelPassthrough =
  | {
    kind: 'argv';
    model_flag: string;
    effort_flag?: string;
    effort_args?: string[];
    effort_template?: string;
  }
  | {
    kind: 'env';
    model_var: string;
    effort_var?: string;
  };

/** Configuration for a single agent launcher. */
export interface AgentLauncherConfig {
  base_argv: string[];
  noninteractive_argv: string[];
  instruction_transport: AgentInstructionTransport;
  wrapper_arg?: string[];
  response_transport: AgentResponseTransport;
  response_arg?: string[];
  timeout_seconds?: number;
  read_only?: AgentReadOnlyConfig;
  description?: string;
  env?: Record<string, string>;
  model_passthrough?: ModelPassthrough;
}

/**
 * Agent registry: maps agent names to their launcher configurations.
 * Stored in operator config at launchers.v1.json.
 */
export interface AgentRegistry {
  version: 1;
  agents: Record<string, AgentLauncherConfig>;
}

export interface InitConfigResult {
  configDir: string;
  keyPath: string;
  registryPath: string;
  keyCreated: boolean;
  registryCreated: boolean;
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
// Launch types
// ---------------------------------------------------------------------------

export type LaunchEvent =
  | {
    type: 'run_created';
    reviewId: string;
    runId: string;
    handoffId: string;
    runDir: string;
    responsePath: string;
    stdoutPath: string | null;
    stderrPath: string;
    startedAt: string;
  }
  | {
    type: 'spawned';
    reviewId: string;
    runId: string;
    handoffId: string;
    pid: number;
    pgid: number;
    cwd: string;
    startedAt: string;
  }
  | {
    type: 'token_consumed';
    reviewId: string;
    runId: string;
    handoffId: string;
    tokenState: 'consumed';
    responsePath: string;
    stderrPath: string;
  }
  | {
    type: 'heartbeat';
    reviewId: string;
    runId: string;
    handoffId: string;
    pid: number;
    pgid: number;
    heartbeatAt: string;
    responseBytes: number;
    stdoutBytes: number | null;
    stderrBytes: number;
  }
  | {
    type: 'finalized';
    reviewId: string;
    runId: string;
    handoffId: string;
    status: 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'rejected';
    exitCode: number;
    responsePath: string;
    metaPath: string;
    responseBytes: number;
    stdoutBytes: number | null;
    stderrBytes: number;
    completedAt: string;
  };

/** Options for the launch operation. */
export interface LaunchOpts {
  reviewId: string;
  dir: string;
  verbose?: boolean;
  onEvent?: (event: LaunchEvent) => void;
  model?: string;
  effort?: string;
}

/** Result of a successful agent run. */
export interface RunResult {
  runId: string;
  reviewId: string;
  handoffId: string;
  agent: string;
  mode: HandoffMode;
  runDir: string;
  exitCode: number;
  response?: string;
  startedAt: string;
  completedAt: string;
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
}

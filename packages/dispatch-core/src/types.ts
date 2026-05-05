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

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

/** Configuration for a single agent launcher. */
export interface AgentLauncherConfig {
  command: string;
  args: string[];
  description?: string;
  env?: Record<string, string>;
}

/**
 * Agent registry: maps agent names to their launcher configurations.
 * Stored in operator config at launchers.v1.json.
 */
export interface AgentRegistry {
  version: 1;
  agents: Record<string, AgentLauncherConfig>;
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

/** Options for the launch operation. */
export interface LaunchOpts {
  reviewId: string;
  dir: string;
  verbose?: boolean;
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

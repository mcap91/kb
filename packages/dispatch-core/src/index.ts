export const VERSION = '0.0.1';

// Error types and helpers
export type { DispatchErrorCode, DispatchResult } from './errors.js';
export { ok, fail } from './errors.js';

// Dispatch types
export type {
  HandoffMode,
  HandoffStatus,
  HandoffFrontmatter,
  ReviewedWriteScopePathKind,
  ReviewedWriteScopeAccessSource,
  ReviewedWriteScopeEntry,
  ReviewedWriteScope,
  EnvironmentCapabilityStatus,
  EnvironmentCapability,
  EnvironmentWritability,
  ContainerDetection,
  HostCapabilitiesRecord,
  RouteViability,
  RouteVerdict,
  GateDecision,
  CheckEnvironmentResult,
  AgentInstructionTransport,
  AgentResponseTransport,
  AgentReadOnlyConfig,
  AgentLauncherConfig,
  ModelPassthrough,
  AgentRegistry,
  InitConfigResult,
  TokenPayload,
  DispatchToken,
  CreateHandoffOpts,
  CreateHandoffResult,
  ReviewOpts,
  ReviewResult,
  LaunchEvent,
  LaunchOpts,
  RunResult,
  CleanupOpts,
  CleanupReport,
  StatusResult,
  TokenInfo,
  ActiveLaunchInfo,
} from './types.js';

// Background launch types
export type {
  BackgroundLaunchResult,
  TerminalRunStatus,
  RunStatus,
  InternalRunStatus,
  WaitForRunResult,
  RunArtifactResult,
  ControllerMetadata,
  ResolvedRun,
  BackgroundLaunchOpts,
  WaitForRunOpts,
  GetResponseOpts,
} from './types-background.js';

// Zod schemas
export {
  handoffModeSchema,
  handoffStatusSchema,
  handoffFrontmatterSchema,
  agentInstructionTransportSchema,
  agentResponseTransportSchema,
  agentReadOnlyConfigSchema,
  modelPassthroughSchema,
  agentLauncherConfigSchema,
  agentRegistrySchema,
  tokenPayloadSchema,
} from './schemas.js';

// Platform-aware paths
export type { TokenState } from './paths.js';
export {
  resolveConfigDir,
  getConfigDir,
  getTokenDir,
  getHostCapabilitiesPath,
  getReviewDir,
  getRunDir,
  ensureConfigDirs,
} from './paths.js';

// Token management
export {
  generateKey,
  loadKey,
  createToken,
  verifyToken,
  writeTokenFile,
  readTokenFile,
  moveToken,
} from './token.js';

// Review
export { review } from './review.js';

// Launch
export { launch } from './launch.js';

// Environment
export {
  checkEnvironment,
  gateLaunchEnvironment,
  deriveRouteVerdicts,
  detectContainer,
  probeWritability,
  runProcess,
} from './environment.js';

// Cleanup
export { cleanup } from './cleanup.js';

// Registry and setup
export {
  createDefaultRegistry,
  getRegistryPath,
  initConfig,
  loadRegistry,
  resolveAgentConfig,
} from './registry.js';

// Handoff creation and loading
export { createHandoff } from './create-handoff.js';
export { loadHandoff, DEFAULT_LIMITS } from './handoff.js';

// Status
export { status } from './status.js';

// Lookup
export { resolveRun, readRunArtifacts } from './lookup.js';

// Wait
export { waitForRun } from './wait.js';

// Response
export { getResponse } from './response.js';

// Background launch
export { launchBackground, reviewAndLaunchBackground } from './launch-background.js';

// Wrapper (convenience functions)
export {
  createHandoffRecord,
  initializeDispatchConfig,
  checkDispatchEnvironment,
  reviewHandoff,
  launchReview,
  cleanupState,
  readDispatchStatus,
  reviewAndLaunch,
  launchReviewBackground,
  reviewAndLaunchInBackground,
} from './wrapper.js';

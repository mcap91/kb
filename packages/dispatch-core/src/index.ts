export const VERSION = '0.0.1';

// Error types and helpers
export type { DispatchErrorCode, DispatchResult } from './errors.js';
export { ok, fail, V2_REFUSAL_CODES } from './errors.js';

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

// Run state (shared v1/v2 seam). NOTE: `TerminalRunStatus` is intentionally NOT re-exported here
// under its own name — `types-background.ts` already exports a structurally identical
// `TerminalRunStatus` (same literal union) via the "Background launch types" section above, and
// re-exporting run-state.ts's copy under the same bare name is a duplicate-identifier compile
// error (TS2300). Consumers needing the type get it from that existing export; code inside this
// package imports it directly from './run-state.js'.
export { writeAtomic, writeJsonAtomic, writeStateMetadata, isAlive, isRecordedProcessAlive, signalChildProcessGroup, HEARTBEAT_INTERVAL_MS } from './run-state.js';

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

// ---------------------------------------------------------------------------
// V2 dispatch pipeline (PLN-0004 S0). Lives alongside v1 above; nothing in
// this section replaces or modifies a v1 export. `HandoffMode` collides with
// v1's own export of the same name (types.ts) — the v2 one is re-exported as
// `V2HandoffMode`.
// ---------------------------------------------------------------------------

// HO frontmatter parsing (§5)
export type { Handoff, HandoffMode as V2HandoffMode } from './ho.js';
export { parseHandoff, parseHandoffContent } from './ho.js';

// Admission gate (§7 S0 subset)
export type { AdmissionResult } from './admission.js';
export { checkAdmission } from './admission.js';

// Model registry (T23 S0 seed) — deprecated; superseded by resolveModelFromConfig (S3 block below)
export type { ModelEntry, ModelRegistry } from './model-registry.js';
export { getDefaultRegistry, resolveModel } from './model-registry.js';

// Mechanical prompt assembly (§8)
export type { AssembledPrompt } from './assemble.js';
export { assemblePrompt } from './assemble.js';

// Pi adapter (facts-only; D10)
export type { PiModelsJson, PiInvocation, PiUsage, PiResult } from './adapters/pi.js';
export { buildModelsJson, buildInvocation, parsePiOutput } from './adapters/pi.js';

// Windows -> WSL2 routing (§11)
export type { Wsl2ScriptOpts, Wsl2ExecResult } from './wsl2.js';
export { execViaWsl2, classifySignalExit, windowsToWslPath, resolveWinHostIp } from './wsl2.js';

// bwrap jail args (§11 S0 minimum)
export type { JailOpts, JailArgs } from './jail.js';
export { buildJailArgs } from './jail.js';

// Ephemeral clone management (§8)
export type { CloneOpts, CloneResult } from './clone.js';
export { createClone, removeClone, sweepOrphanClones } from './clone.js';

// Delivery gate (§8 — enumerate -> verdict -> land)
export type { DeliveryOpts, DeliveryOutcome, EnumerateScript, DeliveryScript, EnumerateResult } from './delivery.js';
export {
  buildEnumerateScript,
  parseEnumerateOutput,
  checkWriteScope,
  scanSecrets,
  buildDeliveryScript,
  parseDeliveryOutput,
} from './delivery.js';

// Capture (§5/§8 — response doc + provenance write-back fields)
export type { CaptureOpts, CaptureResult, ProvenanceWriteBack } from './capture.js';
export { writeResponseDoc, buildProvenanceWriteBack } from './capture.js';

// Host preflight + remediation (T27; DEC-0008 D20)
export type { PreflightResult } from './preflight.js';
export { runPreflight, parsePreflightOutput } from './preflight.js';

// The runDispatch() pipeline
export type { DispatchOpts, DispatchResult2 } from './pipeline.js';
export { runDispatch } from './pipeline.js';

// ---------------------------------------------------------------------------
// V2 background dispatch (S1)
// ---------------------------------------------------------------------------

export type { DispatchBackgroundOpts, DispatchBackgroundResult } from './dispatch-background.js';
export { launchDispatchBackground } from './dispatch-background.js';

// ---------------------------------------------------------------------------
// V2 repo-local dispatch config (S3) — wiki/.dispatch/ models.json, backends.json,
// profiles.json loaders + types
// ---------------------------------------------------------------------------

export type { BackendEntry, ModelTableEntry, ProfileEntry, ProfilesConfig, RepoDispatchConfig } from './repo-config.js';
export { loadModelsTable, loadBackendsTable, loadProfilesConfig } from './repo-config.js';

// ---------------------------------------------------------------------------
// V2 credential resolution (S3)
// ---------------------------------------------------------------------------

export type { CredentialResolution, InjectionScriptLines } from './credentials.js';
export {
  resolveCredentials,
  checkCredentialPolicy,
  buildInjectionScript,
  buildInjectedValueScanFragment,
  parseInjectedValueScanOutput,
} from './credentials.js';

// ---------------------------------------------------------------------------
// V2 model registry resolution + harness version gate + backend fingerprint (S3)
// ---------------------------------------------------------------------------

export type { ResolvedModel, VersionGateResult, BackendFingerprint } from './model-registry.js';
export { PI_HARNESS_INFO } from './model-registry.js';
export {
  resolveModelFromConfig,
  checkHarnessVersion,
  buildFingerprintFragment,
  parseFingerprintOutput,
} from './model-registry.js';

// ---------------------------------------------------------------------------
// init-dispatch (S3 ruling 11) — scaffolds blank wiki/.dispatch/ tables + README
// ---------------------------------------------------------------------------

export type { InitDispatchOpts, InitDispatchResult } from './init-dispatch.js';
export { initDispatch } from './init-dispatch.js';

// ---------------------------------------------------------------------------
// V2 required enforcement — tier resolution + tunnel + jail S5 (PLN-0004 S5)
// ---------------------------------------------------------------------------

// Tier resolution (§11 platform matrix; §7.11 no_isolation_route)
export type { HostTier, TierResolution, TierProbeInputs, TierEnvironmentInfo } from './tier.js';
export { resolveTier, checkIsolationRoute, buildTierEnvironmentInfo } from './tier.js';

// Network egress tunnel (§11 D21; T26)
export type { TunnelConfig, TunnelScripts, TunnelBashLines } from './tunnel.js';
export { buildTunnelScripts, buildTunnelBashLines, TUNNEL_RELAY_PORT, TUNNEL_SOCKET_NAME } from './tunnel.js';

// jail.ts S5 exports (T15/T25 — buildJailArgs already exported above at S0)
export type { WikiShape, ParsedDataMount } from './jail.js';
export { classifyWikiShape, parseDataMount } from './jail.js';

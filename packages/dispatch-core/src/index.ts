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
  EnvironmentWritability,
  ContainerDetection,
  RouteViability,
  RouteVerdict,
  CheckEnvironmentResult,
  TokenPayload,
  DispatchToken,
  CreateHandoffOpts,
  CreateHandoffResult,
  ReviewOpts,
  ReviewResult,
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
  deriveRouteVerdicts,
  detectContainer,
  probeWritability,
  runProcess,
} from './environment.js';

// Cleanup
export { cleanup } from './cleanup.js';

// Handoff creation
export { createHandoff, renderHandoff } from './create-handoff.js';

// Review derivation (WK-0132 Slice 2)
export type { DeriveReviewOpts, DeriveReviewResult } from './derive-review.js';
export { deriveReview } from './derive-review.js';

// Post-run artifact commit (DEC-0038)
export { commitArtifacts } from './commit-artifacts.js';

// Status
export { status } from './status.js';

// Lookup
export { resolveRun, readRunArtifacts } from './lookup.js';

// Wait
export { waitForRun } from './wait.js';

// Wrapper (convenience functions)
export {
  createHandoffRecord,
  checkDispatchEnvironment,
  cleanupState,
  readDispatchStatus,
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
export { checkAdmission, checkWorkItemExists } from './admission.js';

// Model registry (T23 S0 seed) — deprecated; superseded by resolveModelFromConfig (S3 block below)
export type { ModelEntry, ModelRegistry } from './model-registry.js';
export { getDefaultRegistry, resolveModel } from './model-registry.js';

// Mechanical prompt assembly (§8)
export type { AssembledPrompt } from './assemble.js';
export { assemblePrompt } from './assemble.js';

// Pi adapter (facts-only; D10)
export type { PiModelsJson, PiInvocation, PiUsage, PiResult } from './adapters/pi.js';
export { buildModelsJson, buildInvocation, parsePiOutput } from './adapters/pi.js';

// Codex adapter (facts-only; D10 / DEC-0009). NOTE: codex.ts's own build
// function is named `buildInvocation` (mirrors pi.ts's naming exactly), so
// it is re-exported here under `buildCodexInvocation` — re-exporting two
// different bindings under the same bare name from this barrel is a
// duplicate-identifier compile error. `parseCodexOutput` has no such
// collision and keeps its own name.
export type { CodexInvocation, CodexUsage, CodexResult } from './adapters/codex.js';
export { buildInvocation as buildCodexInvocation, parseCodexOutput } from './adapters/codex.js';

// Claude adapter (facts-only; D10 / DEC-0009). Same collision as codex.ts:
// claude.ts's own build function is also named `buildInvocation` (mirrors
// pi.ts's naming exactly), so it is re-exported here under
// `buildClaudeInvocation`. `parseClaudeOutput` has no such collision and
// keeps its own name.
export type { ClaudeInvocation, ClaudeUsage, ClaudeResult } from './adapters/claude.js';
export { buildInvocation as buildClaudeInvocation, parseClaudeOutput } from './adapters/claude.js';

// Direct bash execution (D6 Phase 2 — replaces wsl2.ts's execViaWsl2)
export type { ExecBashOpts, ExecBashResult } from './exec-direct.js';
export { execBash } from './exec-direct.js';

// bwrap jail args (§11 S0 minimum). buildJailArgs is superseded by
// buildBwrapPlan (D6) as pipeline.ts's own call path but stays defined/
// exported — its output shares buildJailPlanSteps's mount-logic walk with
// buildBwrapPlan and it remains independently unit-tested
// (tests/dispatch-v2-jail.test.ts).
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

export type { BackendEntry, BackendFamily, ModelTableEntry, ProfileEntry, ProfilesConfig, RepoDispatchConfig } from './repo-config.js';
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
export type { WikiShape } from './jail.js';
export { classifyWikiShape } from './jail.js';

// ---------------------------------------------------------------------------
// D6 native spawn pipeline (PLN-0004 mid_project_review_rulings.md ruling 7) —
// frozen bwrap plan + direct spawn + worker env policy + boolean bwrap probe.
// ---------------------------------------------------------------------------

// Frozen bwrap plan (jail.ts) — replaces the generated-bash-script pattern.
export type { BwrapMount, BwrapInjectedFile, BwrapPlan, BuildBwrapPlanOpts } from './jail.js';
export { buildBwrapPlan } from './jail.js';

// Direct bwrap spawn (spawn-isolated.ts) — bounded capture + two-clock timeout.
export type { SpawnIsolatedOpts, SpawnResult } from './spawn-isolated.js';
export { spawnIsolated } from './spawn-isolated.js';

// Worker env deny-list (env-policy.ts).
export { buildWorkerEnv } from './env-policy.js';

// Boolean bwrap probe (tier.ts) — no tier enum; provenance records facts.
export type { BwrapProbeResult } from './tier.js';
export { probeBwrap, buildBwrapEnvironmentInfo } from './tier.js';

// ---------------------------------------------------------------------------
// Recovery block (PLN-0004 Session C / S6a.1 — mid_project_review_rulings.md
// ruling 1, "D1: Structured recovery signal"): `kb-dispatch-recovery.v1`
// terminal-block extraction + validation. Replaces the deleted `.dispatch-out/
// review.yaml` file channel and response-header.ts's `parseReviewFile` with
// one schema across every role that emits it (implement/worker,
// code_review/reviewer, redteam).
// ---------------------------------------------------------------------------

export type {
  RecoveryBlockEvidence,
  RecoveryBlockPayload,
  RecoveryDiagnostic,
  RecoveryKind,
  RecoveryExtractionKind,
  RecoveryFinding,
  FindingCounts,
  ReviewedControl,
  FindingSeverity as RecoveryFindingSeverity,
} from './recovery-block.js';
export { extractRecoveryBlock, validateRecoveryPayload, KB_DISPATCH_RECOVERY_VERSION } from './recovery-block.js';

// ---------------------------------------------------------------------------
// Merge delivery (WK-0132 Slice 3) — merges a dispatch delivery branch into
// the target branch after review evidence confirms a pass. Local only.
// ---------------------------------------------------------------------------

export type { MergeDeliveryOpts, MergeDeliveryResult } from './merge-delivery.js';
export { mergeDelivery } from './merge-delivery.js';

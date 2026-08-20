export const VERSION = '0.0.1';

// Error types and helpers
export type { ErrorCode, Result } from './errors.js';
export { ok, fail } from './errors.js';

// Wiki record types
export type {
  WorkItemType,
  WorkStatus,
  InitiativeStatus,
  DecisionStatus,
  PlanStatus,
  Priority,
  ValueStatus,
  CostProvenance,
  ChainStatus,
  OperatorAssessment,
  WikiPrefix,
  WorkItemFrontmatter,
  InitiativeFrontmatter,
  DecisionFrontmatter,
  SourceFrontmatter,
  PlanFrontmatter,
  ValueFrontmatter,
  AreaFrontmatter,
  WikiFrontmatter,
  UnitClass,
  CodeUnitClass,
  DataUnitClass,
  RateFlag,
  ValueConfig,
  ValueReportOpts,
  ValueCandidate,
  ValueUnitDetail,
  ValueReviewUnit,
  ValueDataTrace,
  UnitClassCounts,
  ValueMetrics,
  ValueUsageOpts,
  UsageModelDetail,
  UsageProviderDetail,
  UsageMetrics,
  PlanBundleManifest,
  WikiContractMetadata,
  IdState,
  ManifestRecordType,
  WikiManifest,
  BootstrapOpts,
  BootstrapResult,
  SyncOpts,
  SyncResult,
  AllocateOpts,
  AllocateResult,
  CreateOpts,
  CreateResult,
  ImportPlanOpts,
  ImportPlanResult,
  ValidatePlanOpts,
  ValidatePlanIssue,
  ValidatePlanResult,
  ArchivePlanOpts,
  ArchivePlanResult,
  LintOpts,
  LintDiagnostic,
  LintResult,
  GenerateOpts,
  GenerateResult,
  BuildSearchIndexOpts,
  SearchOpts,
  SearchHit,
  SearchResult,
  BuildSearchIndexResult,
  WikiCore,
} from './types.js';

// Zod schemas
export {
  workItemTypeSchema,
  workStatusSchema,
  initiativeStatusSchema,
  decisionStatusSchema,
  planStatusSchema,
  prioritySchema,
  valueStatusSchema,
  costProvenanceSchema,
  chainStatusSchema,
  operatorAssessmentSchema,
  unitEvidenceSchema,
  unitClassSchema,
  codeUnitClassSchema,
  rateFlagSchema,
  valueReviewUnitSchema,
  valueDataTraceSchema,
  workItemFrontmatterSchema,
  initiativeFrontmatterSchema,
  decisionFrontmatterSchema,
  sourceFrontmatterSchema,
  planFrontmatterSchema,
  planBundleManifestSchema,
  areaFrontmatterSchema,
  valueFrontmatterSchema,
  frontmatterSchemas,
} from './schemas.js';

// Debug utilities
export { setVerbose, isVerbose, debug, debugTagged } from './debug.js';

// Date utilities
export { localDateStamp } from './date.js';

// Contract resolution
export {
  findKbRoot,
  contractPath,
  manifestPath,
  bootstrapDir,
  templatesDir,
  loadManifest,
  getBootstrapTemplates,
  getRecordTemplates,
  getTemplate,
  getAgentInstructionsTemplate,
} from './contract.js';

// Agent instructions (managed block)
export { writeManagedBlock } from './agent-instructions.js';

// MCP config (.mcp.json)
export { writeMcpConfig } from './mcp-config.js';

// Bootstrap
export { bootstrap } from './bootstrap.js';

// Sync
export { sync } from './sync.js';

// ID allocation
export { allocate } from './allocate.js';

// Record creation
export { create } from './create.js';

// Plan import
export { importPlan } from './import-plan.js';

// Plan bundles
export {
  getPlanRecordRelPath,
  getPlanBundleRelPath,
  getPlanDesignRelPath,
  getPlanExecutionRelPath,
  getPlanRecordPath,
  getPlanBundleDir,
  getPlanDesignPath,
  getPlanExecutionPath,
  getPlanBundleManifestPath,
  ensurePlanBundleSkeleton,
  readPlanBundleManifest,
  writePlanBundleManifest,
  isPathInsidePlanBundle,
} from './plan-bundle.js';

// Plan validation
export { validatePlan } from './validate-plan.js';

// Plan archival
export { archivePlan } from './archive-plan.js';

// Lint
export { lint } from './lint.js';

// View generation
export { generate } from './generate.js';

// Search
export { buildSearchIndex, search } from './search.js';

// Value report (deterministic, offline)
export { computeValueReport, findUnpublishedDraft } from './value-report.js';
export type { DraftValInfo } from './value-report.js';

// Value finalize (WK-0058: gather the published chain from disk, then render the VAL body)
export { readPublishedPriors, finalizeValueReport } from './value-finalize.js';
export type { FinalizeValueReportOpts } from './value-finalize.js';

// Value usage (owned Claude+Codex read + LiteLLM-table pricing — DEC-0005 / WK-0064;
// offline core path, optional OpenRouter actual only)
export { computeValueUsage, parseClaudeJsonl, readClaudeSessionsFrom, defaultListWorktreeRoots } from './value-usage.js';
export type { UsageDeps, ClaudeMessageUsage, CodexSessionUsage } from './value-usage.js';

// Pricing (vendored, version-pinned LiteLLM table — DEC-0005 / WK-0064)
export { priceModel, resolveModelEntry, loadDefaultPricingTable, LITELLM_TABLE_VERSION } from './pricing.js';
export type { LitellmEntry, PricingTable, TokenBuckets, PricedModel } from './pricing.js';

// Value render/finalize (deterministic VAL body fill — WK-0058)
export {
  fmtInt,
  fmtNum,
  computeArithmetic,
  resolveReviewRows,
  renderReviewTable,
  renderTokenDetail,
  renderDataTraces,
  groupUnclassified,
  renderUnclassifiedGroups,
  renderRoiLine,
  renderCeilingLine,
  renderValueReport,
} from './value-render.js';
export type {
  RatifiedRow,
  PriorValNumbers,
  ValArithmetic,
  ResolvedRow,
  UnclassifiedGroup,
  RoiLineInput,
  CeilingLineInput,
  RenderValueReportInput,
  RenderedVal,
} from './value-render.js';

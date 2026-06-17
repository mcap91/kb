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
  WikiPrefix,
  WorkItemFrontmatter,
  InitiativeFrontmatter,
  DecisionFrontmatter,
  SourceFrontmatter,
  PlanFrontmatter,
  AreaFrontmatter,
  WikiFrontmatter,
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
  workItemFrontmatterSchema,
  initiativeFrontmatterSchema,
  decisionFrontmatterSchema,
  sourceFrontmatterSchema,
  planFrontmatterSchema,
  planBundleManifestSchema,
  areaFrontmatterSchema,
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

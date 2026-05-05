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
  Priority,
  WikiPrefix,
  WorkItemFrontmatter,
  InitiativeFrontmatter,
  DecisionFrontmatter,
  SourceFrontmatter,
  AreaFrontmatter,
  WikiFrontmatter,
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
  prioritySchema,
  workItemFrontmatterSchema,
  initiativeFrontmatterSchema,
  decisionFrontmatterSchema,
  sourceFrontmatterSchema,
  areaFrontmatterSchema,
  frontmatterSchemas,
} from './schemas.js';

// Debug utilities
export { setVerbose, isVerbose, debug, debugTagged } from './debug.js';

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
} from './contract.js';

// Bootstrap
export { bootstrap } from './bootstrap.js';

// Sync
export { sync } from './sync.js';

// ID allocation
export { allocate } from './allocate.js';

// Record creation
export { create } from './create.js';

// Lint
export { lint } from './lint.js';

// View generation
export { generate } from './generate.js';

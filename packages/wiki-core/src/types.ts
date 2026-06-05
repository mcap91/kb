import type { Result } from './errors.js';

// ---------------------------------------------------------------------------
// Enum / union values for wiki record fields
// ---------------------------------------------------------------------------

/** Work item type. */
export type WorkItemType =
  | 'bug'
  | 'feature'
  | 'task'
  | 'investigation'
  | 'chore'
  | 'docs'
  | 'infra'
  | 'migration';

/** Work item / initiative status. */
export type WorkStatus =
  | 'inbox'
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'parked'
  | 'cancelled'
  | 'deprecated'
  | 'duplicate'
  | 'superseded'
  | 'wont_do';

/** Initiative status (subset of WorkStatus). */
export type InitiativeStatus =
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'parked'
  | 'cancelled'
  | 'deprecated';

/** Decision status. */
export type DecisionStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'deprecated';

/** Plan status. */
export type PlanStatus =
  | 'draft'
  | 'approved'
  | 'packaged'
  | 'active'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'superseded';

/** Priority level. */
export type Priority = 'critical' | 'high' | 'medium' | 'low';

/** Manifest-driven wiki record prefixes. */
export type WikiPrefix = 'WK' | 'IN' | 'DEC' | 'SRC' | 'AREA' | 'PLN';

// ---------------------------------------------------------------------------
// Frontmatter interfaces for manifest-driven record types
// ---------------------------------------------------------------------------

/** WK-* work item frontmatter. */
export interface WorkItemFrontmatter {
  id: string;
  title: string;
  type: WorkItemType;
  status: WorkStatus;
  priority: Priority;
  owner: string;
  created: string;
  updated: string;
  resolution?: string;
  severity?: string;
  area?: string;
  initiative?: string;
  tags?: string[];
  origin?: Record<string, unknown>;
  migration?: Record<string, unknown>;
  repo_paths?: string[];
  docs?: string[];
  external_links?: string[];
  links?: string[];
  depends_on?: string[];
  blocks?: string[];
  related?: string[];
  write_scope?: string[];
  assignees?: string[];
  agents?: string[];
  reviewers?: string[];
  target?: string;
  completed?: string;
  started?: string;
  superseded_by?: string;
  duplicate_of?: string;
  deprecated_by?: string;
}

/** IN-* initiative frontmatter. */
export interface InitiativeFrontmatter {
  id: string;
  title: string;
  status: InitiativeStatus;
  priority: Priority;
  owner: string;
  created: string;
  updated: string;
  summary?: string;
  area?: string;
  tags?: string[];
  docs?: string[];
  depends_on?: string[];
  blocks?: string[];
  related?: string[];
  write_scope?: string[];
  assignees?: string[];
  agents?: string[];
  reviewers?: string[];
  target?: string;
  started?: string;
  completed?: string;
}

/** DEC-* decision frontmatter. */
export interface DecisionFrontmatter {
  id: string;
  title: string;
  status: DecisionStatus;
  date: string;
  owners: string[];
  area?: string;
  docs?: string[];
  related?: string[];
  supersedes?: string;
  superseded_by?: string;
}

/** SRC-* source frontmatter. */
export interface SourceFrontmatter {
  id: string;
  title: string;
  kind: string;
  captured: string;
  updated: string;
  source_uri: string;
  authority: string;
  immutable_hint: boolean;
  related_docs?: string[];
  related_work?: string[];
  anchors?: string[];
}

/** PLN-* plan frontmatter. */
export interface PlanFrontmatter {
  id: string;
  title: string;
  status: PlanStatus;
  owner: string;
  created: string;
  updated: string;
  summary?: string;
  area?: string;
  tags?: string[];
  source_tool?: string;
  bundle_path?: string;
  design_entry?: string;
  execution_entry?: string;
  related?: string[];
  work_items?: string[];
  started?: string;
  completed?: string;
  superseded_by?: string;
}

/** AREA record frontmatter (slug-based, no numeric prefix). */
export interface AreaFrontmatter {
  id: string;
  title: string;
  owners: string[];
  updated: string;
  docs?: string[];
  initiatives?: string[];
  sources?: string[];
  decisions?: string[];
  related?: string[];
}

/** Union of all manifest-driven frontmatter types. */
export type WikiFrontmatter =
  | WorkItemFrontmatter
  | InitiativeFrontmatter
  | DecisionFrontmatter
  | SourceFrontmatter
  | PlanFrontmatter
  | AreaFrontmatter;

/** Machine-readable manifest for a PLN-* companion bundle. */
export interface PlanBundleManifest {
  plan_id: string;
  normalization_version: number;
  created_at: string;
  updated_at: string;
  producer: {
    tool: string;
    mode?: string;
  };
  entrypoints: {
    design: string;
    execution: string;
  };
  source_artifacts: string[];
}

/** Options for importing upstream artifacts into a PLN-* bundle. */
export interface ImportPlanOpts {
  dir: string;
  plan: string;
  design: string;
  execution?: string;
  sourceTool?: string;
  overwrite?: boolean;
  verbose?: boolean;
}

/** Result of importing upstream artifacts into a PLN-* bundle. */
export interface ImportPlanResult {
  plan: string;
  bundlePath: string;
  designEntry: string;
  executionEntry: string;
  sourceArtifacts: string[];
}

/** Options for explicit PLN-* validation. */
export interface ValidatePlanOpts {
  dir: string;
  plan: string;
  verbose?: boolean;
}

/** A single explicit PLN-* validation issue. */
export interface ValidatePlanIssue {
  code: string;
  path?: string;
  message: string;
}

/** Result of explicit PLN-* validation. */
export interface ValidatePlanResult {
  plan: string;
  valid: boolean;
  issues: ValidatePlanIssue[];
}

/** Options for archiving a PLN-* record. */
export interface ArchivePlanOpts {
  dir: string;
  plan: string;
  verbose?: boolean;
}

/** Result of archiving a PLN-* record. */
export interface ArchivePlanResult {
  plan: string;
  path: string;
  completed: string;
}

// ---------------------------------------------------------------------------
// Contract metadata types
// ---------------------------------------------------------------------------

/** Metadata written to wiki/.wiki-contract.json during bootstrap. */
export interface WikiContractMetadata {
  contractVersion: string;
  repo: string;
  bootstrappedAt: string;
  lastSyncedAt?: string;
}

/** ID allocator state written to wiki/.id-state.json. */
export interface IdState {
  [prefix: string]: {
    next: number;
    allocated: number[];
  };
}

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/** A single record type definition from contract/manifest.json. */
export interface ManifestRecordType {
  aliases: string[];
  prefix?: string;
  stateKey?: string;
  directory: string;
  template: string;
  idStrategy: 'allocated' | 'slug';
  filenameStrategy: 'id_only' | 'slug_only';
  reservedFilenames: string[];
  requiredFrontMatter: string[];
  optionalFrontMatter: string[];
  arrayFrontMatter: string[];
  objectFrontMatter?: string[];
  enumFrontMatter?: Record<string, string[]>;
}

/** The full manifest shape. */
export interface WikiManifest {
  name: string;
  contractVersion: string;
  retrievalEntrypoint: string;
  coreFiles: string[];
  runtimeFiles: string[];
  requiredSurfaces: string[];
  types: Record<string, ManifestRecordType>;
  generatedViews: {
    canonical: boolean;
    defaultDirectory: string;
    standardFiles: string[];
  };
  excludedPrefixes: string[];
}

// ---------------------------------------------------------------------------
// Operation option / result types
// ---------------------------------------------------------------------------

/** Options for bootstrap operation. */
export interface BootstrapOpts {
  dir: string;
  repo: string;
  dryRun?: boolean;
  verbose?: boolean;
  mcpClient?: 'claude' | 'codex' | 'none';
  agentInstructions?: boolean;
}

/** Result of a bootstrap operation. */
export interface BootstrapResult {
  created: string[];
  skipped: string[];
  updated?: string[];
  instructions?: string[];
}

/** Options for sync-contract operation. */
export interface SyncOpts {
  dir: string;
  check?: boolean;
  verbose?: boolean;
  mcpClient?: 'claude' | 'codex' | 'none';
  agentInstructions?: boolean;
}

/** Result of a sync-contract operation. */
export interface SyncResult {
  synced: string[];
  drifted: string[];
  skipped: string[];
  updated?: string[];
  instructions?: string[];
}

/** Options for ID allocation. */
export interface AllocateOpts {
  dir: string;
  prefix: WikiPrefix;
  verbose?: boolean;
}

/** Result of an ID allocation. */
export interface AllocateResult {
  id: string;
  number: number;
}

/** Options for record creation. */
export interface CreateOpts {
  dir: string;
  prefix: string;
  title: string;
  slug?: string;
  owner?: string;
  verbose?: boolean;
}

/** Result of record creation. */
export interface CreateResult {
  id: string;
  path: string;
}

/** Options for lint operation. */
export interface LintOpts {
  dir: string;
  verbose?: boolean;
}

/** A single lint diagnostic. */
export interface LintDiagnostic {
  file: string;
  field?: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Result of a lint operation. */
export interface LintResult {
  diagnostics: LintDiagnostic[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
}

/** Options for generate operation. */
export interface GenerateOpts {
  dir: string;
  verbose?: boolean;
}

/** Result of a generate operation. */
export interface GenerateResult {
  generated: string[];
}

/** Options for building the search index. */
export interface BuildSearchIndexOpts {
  dir: string;
  verbose?: boolean;
}

/** Options for search operation. */
export interface SearchOpts {
  dir: string;
  query: string;
  prefix?: WikiPrefix;
  status?: string;
  limit?: number;
  verbose?: boolean;
}

/** A single search hit. */
export interface SearchHit {
  id: string;
  path: string;
  title: string;
  score: number;
  prefix?: string;
  snippet?: string;
}

/** Result of a search operation. */
export interface SearchResult {
  hits: SearchHit[];
  total: number;
  query: string;
}

/** Result of building the search index. */
export interface BuildSearchIndexResult {
  indexed: number;
  path: string;
}

// ---------------------------------------------------------------------------
// WikiCore interface
// ---------------------------------------------------------------------------

/** Public interface for all wiki-core operations. */
export interface WikiCore {
  bootstrap(opts: BootstrapOpts): Promise<Result<BootstrapResult>>;
  sync(opts: SyncOpts): Promise<Result<SyncResult>>;
  allocateId(opts: AllocateOpts): Promise<Result<AllocateResult>>;
  create(opts: CreateOpts): Promise<Result<CreateResult>>;
  importPlan(opts: ImportPlanOpts): Promise<Result<ImportPlanResult>>;
  validatePlan(opts: ValidatePlanOpts): Promise<Result<ValidatePlanResult>>;
  archivePlan(opts: ArchivePlanOpts): Promise<Result<ArchivePlanResult>>;
  lint(opts: LintOpts): Promise<Result<LintResult>>;
  generate(opts: GenerateOpts): Promise<Result<GenerateResult>>;
  buildSearchIndex(opts: BuildSearchIndexOpts): Promise<Result<BuildSearchIndexResult>>;
  search(opts: SearchOpts): Promise<Result<SearchResult>>;
}

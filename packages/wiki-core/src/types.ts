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

/** VAL-* value report status. */
export type ValueStatus = 'draft' | 'published';

/** Provenance of scraped token/cost data (assigned in code by value-usage). */
export type CostProvenance =
  | 'openrouter-api'
  | 'ccusage-priced'
  | 'subscription-covered'
  | 'local-free'
  | 'unavailable'
  | 'mixed';

/** Watermark chain status across the VAL series. */
export type ChainStatus = 'complete' | 'first' | 'gap' | 'overlap' | 'unknown';

/** Operator's independent calibration verdict on a value report. */
export type OperatorAssessment =
  | 'agree'
  | 'too_high'
  | 'too_low'
  | 'unclear'
  | 'not_reviewed';

/** Manifest-driven wiki record prefixes. */
export type WikiPrefix = 'WK' | 'IN' | 'DEC' | 'SRC' | 'AREA' | 'PLN' | 'VAL';

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

/**
 * VAL-* value report frontmatter — FLAT scalars and string arrays only.
 * The line-oriented parser yields every scalar as a string; numeric fields are
 * coerced by the zod schema (`z.coerce.number()`). No nested objects anywhere:
 * per-model token detail lives in the `## Token Detail` body table (spec §5.4).
 */
export interface ValueFrontmatter {
  // Identity / scope (required)
  id: string;
  title: string;
  status: ValueStatus;
  owner: string;
  created: string;
  updated: string;
  window_start: string;
  window_end: string;
  base_commit: string;
  head_commit: string;
  prior_val: string; // prior VAL id, or "none"
  chain_status: ChainStatus;
  // Cost — observed (scraped by value-usage)
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  cost_provenance?: CostProvenance;
  agents?: string[];
  // Output — observed (tool-filled by value-report)
  span_days?: number;
  commits?: number;
  files_changed?: number;
  net_loc_added?: number;
  net_loc_removed?: number;
  tests_added?: number;
  units_scripts_survives?: number;
  units_scripts_wired?: number;
  units_scripts_tested?: number;
  units_modules_survives?: number;
  units_modules_wired?: number;
  units_modules_tested?: number;
  units_tools_survives?: number;
  units_tools_wired?: number;
  units_tools_tested?: number;
  units_docs_survives?: number;
  units_docs_wired?: number;
  units_docs_tested?: number;
  units_candidates?: number;
  churn_loc?: number;
  excluded_files?: number;
  excluded_loc?: number;
  reverted_commits?: number;
  wk_created?: number;
  wk_closed?: number;
  graph_available?: boolean;
  // Operator-filled at authoring
  units_attested?: number;
  units_valued?: number;
  operator_assessment?: OperatorAssessment;
  operator_notes?: string;
  // Estimate (tool-computed anchors; agent may adjust downward only)
  human_days_units?: number;
  human_days_loc?: number;
  human_days_anchor?: number;
  time_saved_days?: number; // may be negative — never clamped
  speedup?: number; // may be < 1 — never clamped
  estimate_basis?: string;
  // Research — observed, agent-supplied (optional)
  files_read?: number;
  papers_read?: number;
  items_parsed?: number;
  outputs_organized?: number;
  // Links
  tags?: string[];
  related?: string[];
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
  | ValueFrontmatter
  | AreaFrontmatter;

// ---------------------------------------------------------------------------
// Value report / usage operation types (value-report + value-usage tools)
// ---------------------------------------------------------------------------

/** Unit classes for the working-shipped-units capture model (spec §5.1). */
export type UnitClass = 'scripts' | 'modules' | 'tools' | 'docs';

/**
 * Tunable estimate/classification config, loaded from `wiki/.value-config.json`.
 * Precedence: tool args > file > code defaults (spec §9).
 */
export interface ValueConfig {
  per_unit_days: Record<UnitClass, number>;
  loc_per_day: number;
  speedup_cap: number;
  ccusage_version: string;
  exclude_globs: string[];
  classification_patterns: {
    script_extensions: string[];
    candidate_locations: string[];
    test_patterns: string[];
    module_patterns: string[];
    doc_patterns: string[];
  };
}

/** Options for computeValueReport (deterministic, offline). */
export interface ValueReportOpts {
  dir: string;
  /** Base ref override; default = prior VAL head_commit, else repo first commit. */
  since?: string;
  /** Head ref override; default = HEAD. */
  untilRef?: string;
  config?: Partial<ValueConfig>;
  verbose?: boolean;
}

/** A pattern-only unit surfaced for OPERATOR confirmation (valued at zero until then). */
export interface ValueCandidate {
  path: string;
  unitClass: UnitClass;
  /** The runnable-location pattern that matched (audit trail). */
  reason: string;
}

/** Per-unit evidence detail (verbose audit trail; which branch fired). */
export interface ValueUnitDetail {
  path: string;
  unitClass: UnitClass;
  evidence: 'wired' | 'tested' | 'survives' | 'candidate';
  netLoc: number;
}

/** Per-class survives/wired/tested counts. */
export interface UnitClassCounts {
  survives: number;
  wired: number;
  tested: number;
}

/** Deterministic metrics computed by value-report. */
export interface ValueMetrics {
  window_start: string;
  window_end: string;
  base_commit: string;
  head_commit: string;
  prior_val: string;
  chain_status: ChainStatus;
  span_days: number;
  commits: number;
  files_changed: number;
  net_loc_added: number;
  net_loc_removed: number;
  tests_added: number;
  units: Record<UnitClass, UnitClassCounts>;
  units_candidates: number;
  /** wired ∪ tested (attested is added by the operator at authoring). */
  units_valued: number;
  churn_loc: number;
  excluded_files: number;
  excluded_loc: number;
  reverted_commits: number;
  wk_created: number;
  wk_closed: number;
  /** In-scope WK ids gathered for the narrative (spec §5.2). */
  wk_ids: string[];
  graph_available: boolean;
  human_days_units: number;
  human_days_loc: number;
  human_days_anchor: number;
  time_saved_days: number;
  speedup: number;
  estimate_basis: string;
  candidates: ValueCandidate[];
  unit_details: ValueUnitDetail[];
}

/** Options for computeValueUsage (the one network/exec-touching tool). */
export interface ValueUsageOpts {
  dir: string;
  since: string;
  until: string;
  ccusageVersion?: string;
  verbose?: boolean;
}

/** Which arm a model string belongs to (spec §2.3). */
export type UsageArm = 'subscription' | 'local' | 'openrouter' | 'unknown';

/** Per-model token/cost detail (goes to the record body table, not frontmatter). */
export interface UsageModelDetail {
  model: string;
  arm: UsageArm;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  /** null when the arm carries no dollar figure (subscription/unavailable). */
  cost_usd: number | null;
}

/** Scraped token/cost metrics from value-usage. */
export interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  cost_provenance: CostProvenance;
  agents: string[];
  by_model: UsageModelDetail[];
  /** Always "date-window-approx" — adjacent non-committed work may bleed in (spec §6.4). */
  attribution: string;
  /** Machine-readable reason when cost_provenance is "unavailable". */
  reason?: string;
}

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
  severity: 'error' | 'warning';
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

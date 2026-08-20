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

/**
 * Provenance of the reported cost (assigned in code by value-usage — WK-0064). These three are the
 * only values ever EMITTED. The record-validation surface (costProvenanceSchema + manifest enum)
 * additionally tolerates the pre-DEC-0005 legacy values so immutable historical VALs still lint clean.
 */
export type CostProvenance =
  | 'litellm-estimate' // priced by the vendored table; no external actual on this host
  | 'openrouter-actual' // an OpenRouter /credits actual reconciled the estimate
  | 'unavailable'; // no token data for the span

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
  // Cost — observed (scraped by value-usage; DEC-0005/WK-0066 owned union read + LiteLLM table)
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  /** The single cost surface (WK-0066): `tokens × vendored LiteLLM table` list-rate estimate;
   *  blank when nothing REMOTE could be priced. Local/self-hosted rows contribute 0. */
  est_usd?: number;
  /** @deprecated legacy actual out-of-pocket $ — removed with WK-0064's dead "actual" apparatus
   *  (WK-0066). Tolerated only so immutable historical VALs (VAL-0001) still validate; never emitted. */
  cost_usd?: number;
  /** @deprecated legacy estimate field name — renamed to `est_usd` (WK-0066). Tolerated for
   *  historical VALs only; never emitted. */
  cost_usd_est?: number;
  /** @deprecated legacy cost provenance — removed with the actual/estimate split (WK-0066).
   *  Tolerated for historical VALs only; never emitted. */
  cost_provenance?: CostProvenance;
  /** Pinned LiteLLM table version that priced this span (provenance, WK-0064). */
  pricing_table_version?: string;
  agents?: string[];
  // Output — observed (tool-filled by value-report)
  span_days?: number;
  /** Count of distinct calendar dates carrying ≥1 in-span commit. Primary leverage denominator. */
  work_days?: number;
  /**
   * COCOMO II nominal reference ceiling: code-only net added LOC / 1000.
   * Code-only = included net LOC minus docs-classified units (markdown/config not SLOC per Boehm 2000).
   * Test files ARE included (delivered code). Display-only — never enters estimate arithmetic.
   */
  cocomo_kloc?: number;
  /**
   * COCOMO II.2000 post-architecture nominal effort: PM = 2.94 × KSLOC^1.0997.
   * Frozen constants, Boehm et al. 2000. Rounded to 2 decimals. Display-only reference ceiling.
   */
  cocomo_pm_nominal?: number;
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
  // Estimate (DEC-0003 flat-rate replication cost; operator-ratified per unit)
  replication_days?: number;
  saved_floor_days?: number; // may be negative — never clamped
  leverage?: number; // uncapped; may be < 1 — never clamped
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

/** Code/doc unit classes — the calibrated-rate estimate surface (spec §5.1). */
export type CodeUnitClass = 'scripts' | 'modules' | 'tools' | 'docs';

/** Data-asset classes — detection/traceability only, always priced 0 (WK-0059). */
export type DataUnitClass = 'data' | 'orphan_data';

/**
 * Unit classes for the working-shipped-units capture model (spec §5.1; widened by WK-0059).
 * Code/doc classes are the estimate surface; `data`/`orphan_data` are priced-0 traces;
 * `unclassified` marks an unknown committed/linked type surfaced for operator ratification
 * (the tool never silently drops a file to `null`).
 */
export type UnitClass = CodeUnitClass | DataUnitClass | 'unclassified';

/**
 * Rate-applicability narration flag (WK-0059): classes where the SRC-0002 260 LOC/day rate
 * transfers unevenly and whose error direction is not uniformly conservative. Narration only —
 * never changes arithmetic; flagged rows are operator-ratification candidates.
 */
export type RateFlag = 'test-code' | 'fixture-generator' | 'workflow-dsl' | 'shell-wrapper';

/**
 * Measurement config, loaded from `wiki/.value-config.json`.
 * Controls what the tool measures; estimation arithmetic lives in the template/agent layer.
 * Precedence: tool args > file > code defaults.
 */
export interface ValueConfig {
  /** LOC-per-day reference divisor (default 260, calibrated from SRC-0002 — the operator's
   *  corpus-wide throughput). Drives loc_reference per unit = the >3× estimation tripwire.
   *  Not the human-day estimator (that uses per-class tier rates in the template) and not a
   *  value ceiling. */
  loc_per_day: number;
  exclude_globs: string[];
  classification_patterns: {
    script_extensions: string[];
    candidate_locations: string[];
    test_patterns: string[];
    module_patterns: string[];
    doc_patterns: string[];
    /**
     * Data-asset extensions (WK-0059). Detection/traceability only — files whose final
     * extension matches classify as `data` and are priced 0. Positive list; unknown
     * extensions become `unclassified` candidates for operator ratification (never `null`).
     */
    data_extensions: string[];
  };
  /**
   * Exact-path / glob overrides that force a file to the script/tool class (WK-0059).
   * Highest-precedence tier of extensionless-executable detection (override → shebang →
   * candidate-location). Optional; default []. Absent means no forced classifications.
   */
  script_path_overrides?: string[];
  /**
   * Globs an operator has ruled as curated data with no in-repo generator (WK-0059).
   * Matching data files classify as `orphan_data` (unpriced/flagged) instead of `data`.
   * Operator ruling — the tool never infers generator ownership. Optional; default [].
   */
  orphan_data_globs?: string[];
  /**
   * Pinned LiteLLM pricing-table version, frozen into a published VAL's resolved_config for
   * provenance (WK-0064 / DEC-0005). Freeze slot: the runtime value is the pricing module's
   * LITELLM_TABLE_VERSION constant; recorded here so a published report names the table it
   * priced against. Optional; default absent.
   */
  pricing_table_version?: string;
}

/** Options for computeValueReport (deterministic, offline). */
export interface ValueReportOpts {
  dir: string;
  /** Base ref override; default = prior VAL head_commit, else repo first commit. */
  since?: string;
  /** Head ref override; default = HEAD. */
  untilRef?: string;
  config?: Partial<ValueConfig>;
  /**
   * Fully-resolved frozen config from a published VAL (WK-0059). When present it is used
   * verbatim — `wiki/.value-config.json` and code defaults are bypassed — so a re-render
   * reproduces the published figures regardless of later config edits. Takes precedence
   * over `config`. Emitted as `resolved_config` (+ `config_hash`) for the operator to freeze.
   */
  frozenConfig?: ValueConfig;
}

/**
 * A unit surfaced for OPERATOR confirmation (valued at zero until then).
 * Two kinds (WK-0059): a code file in a runnable candidate location (`unitClass` = a code class),
 * or an unknown committed/linked type the tool cannot classify (`unitClass` = 'unclassified').
 */
export interface ValueCandidate {
  path: string;
  unitClass: UnitClass;
  /** The candidate-location pattern or discovery reason that matched (audit trail). */
  reason: string;
}

/** Per-unit evidence detail (verbose audit trail; which branch fired). Code/doc units only. */
export interface ValueUnitDetail {
  path: string;
  unitClass: CodeUnitClass;
  /** Tier ladder: tested > wired > linked > candidate > survives. */
  evidence: 'tested' | 'wired' | 'linked' | 'candidate' | 'survives';
  netLoc: number;
}

/**
 * One row in the unified review surface emitted by value-report.
 * Covers tested / wired / linked / candidate tiers; excludes pure-survives.
 * This list IS the estimate basis — agent proposes replication days per row, operator ratifies.
 * Code units only; data assets live in `data_traces` (priced 0), never here (WK-0059).
 */
export interface ValueReviewUnit {
  path: string;
  unitClass: CodeUnitClass;
  tier: 'tested' | 'wired' | 'linked' | 'candidate' | 'survives';
  wk_ids: string[];
  net_loc: number;
  /** Reference floor: net_loc / loc_per_day. Printed for the agent tripwire check. */
  loc_reference: number;
  /**
   * Rate-applicability narration flag (WK-0059), or null when the calibrated rate applies
   * cleanly. Narration only — never changes arithmetic; a set flag marks the row as an
   * operator-ratification candidate whose replication cost the 260 rate may mis-price.
   */
  rate_flag: RateFlag | null;
}

/**
 * A committed/linked data asset (WK-0059). Detection/traceability only — always priced 0.
 * The tool attempts no fixture↔generator ownership mapping: every data file is priced 0 and
 * the in-repo generator (if any) carries value as the code it is, counted once.
 */
export interface ValueDataTrace {
  path: string;
  /** `data` (detected) or `orphan_data` (operator-ruled curated data, no in-repo generator). */
  unitClass: DataUnitClass;
  /** Net added LOC (informational; 0 for binary assets). Never priced. */
  net_loc: number;
  /** Why it classified as data (e.g. `data-extension:.csv`, `orphan_data_glob`). */
  reason: string;
}

/** Per-class survives/wired/tested counts. */
export interface UnitClassCounts {
  survives: number;
  wired: number;
  tested: number;
}

/** Deterministic metrics computed by value-report. Facts and references only — no estimates. */
export interface ValueMetrics {
  // Watermark / chain
  window_start: string;
  window_end: string;
  base_commit: string;
  head_commit: string;
  prior_val: string;
  chain_status: ChainStatus;
  // Commit metrics
  /** Calendar span (inclusive: first→last in-span commit date). Secondary context field. */
  span_days: number;
  /**
   * Count of distinct calendar dates carrying ≥1 in-span commit (git author dates).
   * Primary work-time denominator for leverage. Excludes idle days entirely.
   */
  work_days: number;
  /**
   * COCOMO II nominal reference ceiling: code-only net added LOC / 1000.
   * Code-only = included net LOC minus docs-classified units (markdown/config not SLOC per Boehm 2000).
   * Test files ARE included (delivered code). Display-only — never enters estimate arithmetic.
   */
  cocomo_kloc: number;
  /**
   * COCOMO II.2000 post-architecture nominal effort: PM = 2.94 × KSLOC^1.0997.
   * Frozen constants, Boehm et al. 2000. Rounded to 2 decimals. Display-only reference ceiling.
   */
  cocomo_pm_nominal: number;
  commits: number;
  files_changed: number;
  net_loc_added: number;
  net_loc_removed: number;
  tests_added: number;
  // Unit classification counts (code/doc classes only; data & unclassified are separate surfaces)
  units: Record<CodeUnitClass, UnitClassCounts>;
  units_candidates: number;
  // Churn / exclusions
  churn_loc: number;
  excluded_files: number;
  excluded_loc: number;
  reverted_commits: number;
  // WK tracking
  wk_created: number;
  wk_closed: number;
  /** In-scope WK ids gathered for the narrative (commit-message regex ∪ graph repo_path edges). */
  wk_ids: string[];
  graph_available: boolean;
  // LOC reference (measurement knob, not an estimate)
  loc_per_day: number;
  // Unified review surface: tested/wired/linked/candidate units; the estimate basis.
  review_units: ValueReviewUnit[];
  // Data assets (WK-0059): detection/traceability only, always priced 0.
  data_traces: ValueDataTrace[];
  // Full audit trail
  candidates: ValueCandidate[];
  unit_details: ValueUnitDetail[];
  /**
   * The fully-resolved config used for this run (WK-0059). Freeze this into the published
   * VAL (or a sidecar) so a re-render reproduces the figures via `frozenConfig`, invariant
   * under later `wiki/.value-config.json` edits.
   */
  resolved_config: ValueConfig;
  /** Stable hash of `resolved_config` — the config fingerprint recorded alongside a published VAL. */
  config_hash: string;
}

/** Options for computeValueUsage (fully offline; pricing is exact table-key match or fail loud). */
export interface ValueUsageOpts {
  dir: string;
  since: string;
  until: string;
}

/** Per-model token/cost detail (goes to the record body table, not frontmatter). */
export interface UsageModelDetail {
  model: string;
  /**
   * LiteLLM `litellm_provider` of the resolved price row; `'unknown'` when unmatched (a remote
   * model with no row → est_usd null + reason); `'local'` for a self-hosted dispatch/ollama run.
   */
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  /**
   * The single cost surface (WK-0066): `tokens × vendored LiteLLM table` at list rates. Null when
   * a REMOTE model has no price row (+ est_reason, never a silent $0); `0` for a LOCAL/self-hosted
   * run (dispatch/ollama — no dollar cost, never a counterfactual). Never a fabricated actual.
   */
  est_usd: number | null;
  /** Why est_usd is null (unknown remote model); null when priced or local. Never a silent $0. */
  est_reason: string | null;
}

/** Per-provider token/cost aggregate (provider = LiteLLM `litellm_provider`). */
export interface UsageProviderDetail {
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  /** Σ list-rate estimate over the provider's models; null when none could be priced. */
  est_usd: number | null;
}

/**
 * One normalized usage record emitted by a `SourceReader` (WK-0066). Source-agnostic and
 * already repo-scoped + date-windowed by the reader that produced it. `source` is the
 * provenance (how it ran: 'claude' | 'codex' | 'dispatch'); `local` marks a self-hosted run
 * (ollama endpoint) that prices to est_usd 0. Cache buckets are 0 where the source has none.
 */
export interface UsageRecord {
  source: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** YYYY-MM-DD (the date-window key + provenance). */
  date: string;
  /** True for a self-hosted/local run (dispatch + ollama endpoint) → est_usd 0, never priced. */
  local?: boolean;
}

/** The context a `SourceReader` receives: the date window + the repo-attribution roots. */
export interface SourceReaderContext {
  since: string;
  until: string;
  /** Target repo root + linked worktree roots (resolved, deduped). Each reader repo-scopes itself. */
  roots: string[];
}

/**
 * A pluggable per-source reader (WK-0066). Owns its own on-disk format, store detection, repo
 * attribution, date windowing, and dedup; returns [] when its store is absent/unreadable/malformed
 * and MUST NEVER throw. The core unions the readers (`readers.flatMap(safe)`) and prices the result.
 */
export interface SourceReader {
  /** Provenance label for records this reader emits (also feeds the derived `agents` set). */
  source: string;
  read(ctx: SourceReaderContext): UsageRecord[];
}

/**
 * Scraped token/cost metrics from value-usage (owned union readers + LiteLLM table — WK-0066).
 * Single cost surface: `est_usd` (tokens × table). No actual layer, no provenance split, no
 * per-row effort (all removed with WK-0064's dead scaffolding). `reason` (present) is the
 * "unavailable" signal — set only when every reader yielded zero for the span.
 */
export interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  /**
   * Σ `tokens × table` list-rate estimate across models; null when nothing REMOTE could be priced.
   * Local/self-hosted rows contribute 0 (never null, never a counterfactual). The estimate is the
   * headline figure — never a bill, never a fabricated actual.
   */
  est_usd: number | null;
  /** The pinned LiteLLM table version that priced this scrape (provenance). */
  pricing_table_version: string;
  /** Source set derived from the readers that produced records (e.g. [claude, codex, dispatch]). */
  agents: string[];
  by_model: UsageModelDetail[];
  /** Aggregate by provider (litellm_provider) — the DEC-0005 provider dimension. */
  by_provider: UsageProviderDetail[];
  /** Always "date-window-approx" — adjacent non-committed work may bleed in (spec §6.4). */
  attribution: string;
  /** Machine-readable reason when the scrape is "unavailable" (every reader yielded zero). */
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
  /**
   * Adopt (overwrite) exactly one bootstrap surface with the current seed.
   * Accepts either the bare surface name ("schema.md") or the repo-relative
   * path ("wiki/schema.md"). Must be one of: schema.md, conventions.md, index.md.
   */
  adopt?: string;
}

/** Result of a sync-contract operation. */
export interface SyncResult {
  synced: string[];
  drifted: string[];
  skipped: string[];
  updated?: string[];
  instructions?: string[];
  /** Files adopted (overwritten with seed) during this run. */
  adopted?: string[];
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

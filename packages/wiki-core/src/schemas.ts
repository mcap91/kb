import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enum schemas
// ---------------------------------------------------------------------------

export const workItemTypeSchema = z.enum([
  'bug',
  'feature',
  'task',
  'investigation',
  'chore',
  'docs',
  'infra',
  'migration',
]);

export const workStatusSchema = z.enum([
  'inbox',
  'todo',
  'in_progress',
  'blocked',
  'review',
  'done',
  'parked',
  'cancelled',
  'deprecated',
  'duplicate',
  'superseded',
  'wont_do',
]);

export const initiativeStatusSchema = z.enum([
  'todo',
  'in_progress',
  'blocked',
  'review',
  'done',
  'parked',
  'cancelled',
  'deprecated',
]);

export const decisionStatusSchema = z.enum([
  'proposed',
  'accepted',
  'rejected',
  'superseded',
  'deprecated',
]);

export const planStatusSchema = z.enum([
  'draft',
  'approved',
  'packaged',
  'active',
  'paused',
  'done',
  'cancelled',
  'superseded',
]);

export const prioritySchema = z.enum(['critical', 'high', 'medium', 'low']);

export const valueStatusSchema = z.enum(['draft', 'published']);

// Record-validation surface: the three EMITTED provenances (DEC-0005 / WK-0064) plus the legacy
// values tolerated so immutable historical VALs (pre-DEC-0005, never editable) lint clean. Code
// only ever emits the first three (see the CostProvenance TS union).
export const costProvenanceSchema = z.enum([
  'litellm-estimate',
  'openrouter-actual',
  'unavailable',
  // legacy — tolerated for historical VAL records only; never emitted
  'subscription-covered',
  'ccusage-priced',
  'openrouter-api',
  'local-free',
  'mixed',
]);

export const chainStatusSchema = z.enum([
  'complete',
  'first',
  'gap',
  'overlap',
  'unknown',
]);

export const operatorAssessmentSchema = z.enum([
  'agree',
  'too_high',
  'too_low',
  'unclear',
  'not_reviewed',
]);

/** Evidence tier ladder: tested > wired > linked > candidate > survives. */
export const unitEvidenceSchema = z.enum([
  'tested',
  'wired',
  'linked',
  'candidate',
  'survives',
]);

/** Code/doc unit classes — the calibrated-rate estimate surface (spec §5.1). */
export const codeUnitClassSchema = z.enum(['scripts', 'modules', 'tools', 'docs']);

/**
 * Unit class for the working-shipped-units capture model (spec §5.1; widened by WK-0059).
 * Code/doc classes are the estimate surface; `data`/`orphan_data` are priced-0 traces;
 * `unclassified` is an unknown type awaiting operator ratification.
 */
export const unitClassSchema = z.enum([
  'scripts', 'modules', 'tools', 'docs', 'data', 'orphan_data', 'unclassified',
]);

/** Rate-applicability narration flag (WK-0059). Narration only — never changes arithmetic. */
export const rateFlagSchema = z.enum(['test-code', 'fixture-generator', 'workflow-dsl', 'shell-wrapper']);

/**
 * One row in the unified review surface emitted by value-report.
 * Covers tested / wired / linked / candidate tiers; excludes pure-survives.
 * Code units only; data assets live in `data_traces` (WK-0059).
 */
export const valueReviewUnitSchema = z.object({
  path: z.string(),
  unitClass: codeUnitClassSchema,
  tier: unitEvidenceSchema,
  wk_ids: z.array(z.string()),
  net_loc: z.number(),
  /** Reference floor: net_loc / loc_per_day. Printed for the agent tripwire check. */
  loc_reference: z.number(),
  /** Rate-applicability narration flag, or null when the calibrated rate applies cleanly. */
  rate_flag: rateFlagSchema.nullable(),
});

/**
 * A committed/linked data asset (WK-0059) — detection/traceability only, always priced 0.
 */
export const valueDataTraceSchema = z.object({
  path: z.string(),
  unitClass: z.enum(['data', 'orphan_data']),
  net_loc: z.number(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Frontmatter Zod schemas for manifest-driven wiki record types
// ---------------------------------------------------------------------------

/** WK-* work item frontmatter schema. */
export const workItemFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: workItemTypeSchema,
  status: workStatusSchema,
  priority: prioritySchema,
  owner: z.string(),
  created: z.string(),
  updated: z.string(),
  resolution: z.string().optional(),
  severity: z.string().optional(),
  area: z.string().optional(),
  initiative: z.string().optional(),
  tags: z.array(z.string()).optional(),
  origin: z.record(z.string(), z.unknown()).optional(),
  migration: z.record(z.string(), z.unknown()).optional(),
  repo_paths: z.array(z.string()).optional(),
  docs: z.array(z.string()).optional(),
  external_links: z.array(z.string()).optional(),
  links: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  write_scope: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  reviewers: z.array(z.string()).optional(),
  target: z.string().optional(),
  completed: z.string().optional(),
  started: z.string().optional(),
  superseded_by: z.string().optional(),
  duplicate_of: z.string().optional(),
  deprecated_by: z.string().optional(),
});

/** IN-* initiative frontmatter schema. */
export const initiativeFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: initiativeStatusSchema,
  priority: prioritySchema,
  owner: z.string(),
  created: z.string(),
  updated: z.string(),
  summary: z.string().optional(),
  area: z.string().optional(),
  tags: z.array(z.string()).optional(),
  docs: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  write_scope: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  reviewers: z.array(z.string()).optional(),
  target: z.string().optional(),
  started: z.string().optional(),
  completed: z.string().optional(),
});

/** DEC-* decision frontmatter schema. */
export const decisionFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: decisionStatusSchema,
  date: z.string(),
  owners: z.array(z.string()),
  area: z.string().optional(),
  docs: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  supersedes: z.string().optional(),
  superseded_by: z.string().optional(),
});

/** SRC-* source frontmatter schema. */
export const sourceFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  captured: z.string(),
  updated: z.string(),
  source_uri: z.string(),
  authority: z.string(),
  immutable_hint: z.boolean(),
  related_docs: z.array(z.string()).optional(),
  related_work: z.array(z.string()).optional(),
  anchors: z.array(z.string()).optional(),
});

/** PLN-* plan frontmatter schema. */
export const planFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: planStatusSchema,
  owner: z.string(),
  created: z.string(),
  updated: z.string(),
  summary: z.string().optional(),
  area: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source_tool: z.string().optional(),
  bundle_path: z.string().optional(),
  design_entry: z.string().optional(),
  execution_entry: z.string().optional(),
  related: z.array(z.string()).optional(),
  work_items: z.array(z.string()).optional(),
  started: z.string().optional(),
  completed: z.string().optional(),
  superseded_by: z.string().optional(),
});

/** PLN-* companion bundle manifest schema. */
export const planBundleManifestSchema = z.object({
  plan_id: z.string(),
  normalization_version: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  producer: z.object({
    tool: z.string(),
    mode: z.string().optional(),
  }),
  entrypoints: z.object({
    design: z.string(),
    execution: z.string(),
  }),
  source_artifacts: z.array(z.string()),
});

/** AREA record frontmatter schema (slug-based). */
export const areaFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  owners: z.array(z.string()),
  updated: z.string(),
  docs: z.array(z.string()).optional(),
  initiatives: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
});

/**
 * VAL-* value report frontmatter schema.
 *
 * FLAT scalars + string arrays only (the parser is line-oriented and yields every
 * scalar as a string). Numeric fields use `z.coerce.number()` so string values from
 * the parser coerce cleanly; they are NOT clamped — a negative `saved_floor_days` or a
 * `leverage` below 1 is valid and must lint clean (spec §8.1 falsifiability).
 */
export const valueFrontmatterSchema = z.object({
  // Identity / scope (required)
  id: z.string(),
  title: z.string(),
  status: valueStatusSchema,
  owner: z.string(),
  created: z.string(),
  updated: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  base_commit: z.string(),
  head_commit: z.string(),
  prior_val: z.string(),
  chain_status: chainStatusSchema,
  // Cost — observed (scraped). Single surface: est_usd (WK-0066). The cost_usd/cost_usd_est/
  // cost_provenance fields are legacy-tolerated so immutable historical VALs (VAL-0001) still
  // lint clean; they are never emitted by the current tool.
  input_tokens: z.coerce.number().optional(),
  output_tokens: z.coerce.number().optional(),
  cache_read_tokens: z.coerce.number().optional(),
  cache_write_tokens: z.coerce.number().optional(),
  total_tokens: z.coerce.number().optional(),
  est_usd: z.coerce.number().optional(),
  cost_usd: z.coerce.number().optional(), // legacy — tolerated for historical VALs, never emitted
  cost_usd_est: z.coerce.number().optional(), // legacy — renamed to est_usd (WK-0066)
  cost_provenance: costProvenanceSchema.optional(), // legacy — removed from the emit surface (WK-0066)
  pricing_table_version: z.string().optional(),
  agents: z.array(z.string()).optional(),
  // Output — observed (tool-filled)
  span_days: z.coerce.number().optional(),
  work_days: z.coerce.number().optional(),
  /** COCOMO II nominal reference ceiling: code-only KSLOC. Display-only, Boehm 2000. */
  cocomo_kloc: z.coerce.number().optional(),
  /** COCOMO II nominal effort PM = 2.94 × KSLOC^1.0997. Display-only, Boehm 2000. */
  cocomo_pm_nominal: z.coerce.number().optional(),
  commits: z.coerce.number().optional(),
  files_changed: z.coerce.number().optional(),
  net_loc_added: z.coerce.number().optional(),
  net_loc_removed: z.coerce.number().optional(),
  tests_added: z.coerce.number().optional(),
  units_scripts_survives: z.coerce.number().optional(),
  units_scripts_wired: z.coerce.number().optional(),
  units_scripts_tested: z.coerce.number().optional(),
  units_modules_survives: z.coerce.number().optional(),
  units_modules_wired: z.coerce.number().optional(),
  units_modules_tested: z.coerce.number().optional(),
  units_tools_survives: z.coerce.number().optional(),
  units_tools_wired: z.coerce.number().optional(),
  units_tools_tested: z.coerce.number().optional(),
  units_docs_survives: z.coerce.number().optional(),
  units_docs_wired: z.coerce.number().optional(),
  units_docs_tested: z.coerce.number().optional(),
  units_candidates: z.coerce.number().optional(),
  churn_loc: z.coerce.number().optional(),
  excluded_files: z.coerce.number().optional(),
  excluded_loc: z.coerce.number().optional(),
  reverted_commits: z.coerce.number().optional(),
  wk_created: z.coerce.number().optional(),
  wk_closed: z.coerce.number().optional(),
  graph_available: z.boolean().optional(),
  // Operator-filled at authoring
  units_attested: z.coerce.number().optional(),
  units_valued: z.coerce.number().optional(),
  operator_assessment: operatorAssessmentSchema.optional(),
  operator_notes: z.string().optional(),
  // Estimate (DEC-0003 flat-rate replication cost; operator-ratified per unit)
  replication_days: z.coerce.number().optional(),
  saved_floor_days: z.coerce.number().optional(),
  leverage: z.coerce.number().optional(),
  estimate_basis: z.string().optional(),
  // Research — observed, agent-supplied (optional)
  files_read: z.coerce.number().optional(),
  papers_read: z.coerce.number().optional(),
  items_parsed: z.coerce.number().optional(),
  outputs_organized: z.coerce.number().optional(),
  // Links
  tags: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
});

/**
 * Map of prefix to its corresponding Zod schema.
 */
export const frontmatterSchemas = {
  WK: workItemFrontmatterSchema,
  IN: initiativeFrontmatterSchema,
  DEC: decisionFrontmatterSchema,
  SRC: sourceFrontmatterSchema,
  PLN: planFrontmatterSchema,
  AREA: areaFrontmatterSchema,
  VAL: valueFrontmatterSchema,
} as const;

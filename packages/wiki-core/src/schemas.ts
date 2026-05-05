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

export const prioritySchema = z.enum(['critical', 'high', 'medium', 'low']);

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
 * Map of prefix to its corresponding Zod schema.
 */
export const frontmatterSchemas = {
  WK: workItemFrontmatterSchema,
  IN: initiativeFrontmatterSchema,
  DEC: decisionFrontmatterSchema,
  SRC: sourceFrontmatterSchema,
  AREA: areaFrontmatterSchema,
} as const;

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Handoff frontmatter Zod schema
// ---------------------------------------------------------------------------

export const handoffModeSchema = z.enum(['redteam', 'code_review', 'implement']);

export const handoffStatusSchema = z.enum([
  'draft',
  'reviewed',
  'launched',
  'completed',
  'failed',
]);

/**
 * Zod schema for HO-* handoff frontmatter validation.
 *
 * Dispatch-owned: HO-* records are not manifest-driven wiki record types.
 */
export const handoffFrontmatterSchema = z.object({
  schema_version: z.literal(1),
  id: z.string(),
  title: z.string(),
  subject: z.string(),
  allowed_agents: z.array(z.string()),
  mode: handoffModeSchema,
  status: handoffStatusSchema.optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  area: z.string().optional(),
  initiative: z.string().optional(),
  work_item: z.string().optional(),
  write_scope: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Agent registry Zod schema
// ---------------------------------------------------------------------------

export const agentLauncherConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  description: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const agentRegistrySchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), agentLauncherConfigSchema),
});

// ---------------------------------------------------------------------------
// Token payload Zod schema
// ---------------------------------------------------------------------------

export const tokenPayloadSchema = z.object({
  reviewId: z.string(),
  handoffId: z.string(),
  agent: z.string(),
  mode: handoffModeSchema,
  repoRoot: z.string(),
  inputManifestHash: z.string(),
  registryHash: z.string(),
  expiry: z.string(),
});

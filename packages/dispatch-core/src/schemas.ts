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

export const agentInstructionTransportSchema = z.object({
  kind: z.enum(['argv_path', 'argv_content', 'stdin']),
});

export const agentResponseTransportSchema = z.object({
  kind: z.enum(['file', 'stdout_capture']),
});

export const agentReadOnlyConfigSchema = z.object({
  supported: z.boolean(),
  argv_suffix: z.array(z.string()).optional(),
  response_writable: z.boolean().optional(),
});

export const modelInjectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('argv'),
    model_flag: z.string(),
    effort_flag: z.string().optional(),
    effort_args: z.array(z.string()).optional(),
    effort_template: z.string().optional(),
  }),
  z.object({
    kind: z.literal('env'),
    model_var: z.string(),
    effort_var: z.string().optional(),
  }),
]);

export const agentLauncherConfigSchema = z.object({
  base_argv: z.array(z.string()).min(1),
  noninteractive_argv: z.array(z.string()),
  instruction_transport: agentInstructionTransportSchema,
  wrapper_arg: z.array(z.string()).optional(),
  response_transport: agentResponseTransportSchema,
  response_arg: z.array(z.string()).optional(),
  timeout_seconds: z.number().int().positive().optional(),
  read_only: agentReadOnlyConfigSchema.optional(),
  description: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  model_injection: modelInjectionSchema.optional(),
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

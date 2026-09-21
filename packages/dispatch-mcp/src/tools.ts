import { z } from 'zod';
import {
  checkEnvironment,
  cleanup,
  createHandoff,
  initConfig,
  initDispatch,
  launchDispatchBackground,
  status,
} from '@kb/dispatch-core';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

const dirSchema = z.object({
  dir: z.string().describe('Target repo directory'),
  verbose: z.boolean().optional(),
});

export const tools: ToolDef[] = [
  {
    name: 'init-config',
    description: 'Initialize operator dispatch config and default launcher registry',
    inputSchema: z.object({
      force: z.boolean().optional(),
    }),
    handler: async (input) => initConfig(Boolean(input.force)),
  },
  {
    name: 'check-environment',
    description: 'Probe host sandbox capabilities and persist the operator-owned capability record',
    inputSchema: z.object({}),
    handler: async () => checkEnvironment(),
  },
  {
    name: 'create-handoff',
    description: 'Create a repo-local HO handoff document',
    inputSchema: dirSchema.extend({
      title: z.string(),
      subject: z.string(),
      allowed_agents: z.array(z.string()),
      mode: z.enum(['implement', 'code_review', 'redteam']),
      status: z.enum(['draft', 'reviewed', 'launched', 'completed', 'failed']).optional(),
      depends_on: z.array(z.string()).optional(),
      area: z.string().optional(),
      initiative: z.string().optional(),
      work_item: z.string().optional(),
      write_scope: z.array(z.string()).optional(),
      read_first: z.array(z.string()).optional(),
      objective: z.string().optional(),
      constraints: z.array(z.string()).optional(),
      expected_output: z.string().optional(),
      context: z.string().optional(),
      acceptance: z.array(z.string()).min(1),
      validation: z.array(z.string()).min(1),
      web: z.boolean().optional(),
      credentials: z.array(z.string()).optional(),
      data_mounts: z.array(z.string()).optional(),
      export_mounts: z.array(z.string()).optional(),
      base_ref: z.string().optional(),
      vars: z.array(z.string()).optional(),
    }),
    handler: async (input) => createHandoff(input as unknown as Parameters<typeof createHandoff>[0]),
  },
  {
    name: 'status',
    description: 'Show dispatch token and run status for a repo',
    inputSchema: z.object({
      dir: z.string(),
    }),
    handler: async (input) => status(input.dir as string),
  },
  {
    name: 'cleanup',
    description: 'Clean up stale dispatch reviews, runs, and tokens',
    inputSchema: z.object({
      dir: z.string().optional(),
      maxAgeDays: z.number().optional(),
      verbose: z.boolean().optional(),
    }),
    handler: async (input) => cleanup(input as unknown as Parameters<typeof cleanup>[0]),
  },
  {
    name: 'dispatch',
    description: 'Run the v2 dispatch pipeline: gate → clone → jail → worker → delivery → capture. Always runs in background; returns runId immediately plus a `watch` command — run it as a background Bash command (run_in_background: true) to be notified when the run reaches terminal status. Use status for a point-in-time check.',
    inputSchema: z.object({
      dir: z.string().describe('Target repo directory'),
      handoff: z.string().describe('Repo-relative path to the HO file, e.g. wiki/handoffs/HO-0004.md'),
      model: z.string().describe('Model alias from the registry, e.g. deepseek, qwen3:8b'),
      backend: z.string().describe('Backend name from the registry, e.g. openrouter, ollama'),
      effort: z.string().optional().describe('Effort/reasoning level (refused with EFFORT_UNSUPPORTED when the model cannot carry it)'),
      preflight: z.boolean().optional().describe('Run bwrap preflight check (default: true)'),
      verbose: z.boolean().optional(),
    }),
    handler: async (input) => launchDispatchBackground({
      dir: input.dir as string,
      handoff: input.handoff as string,
      model: input.model as string,
      backend: input.backend as string,
      effort: input.effort as string | undefined,
      preflight: input.preflight as boolean | undefined,
      verbose: input.verbose as boolean | undefined,
    }),
  },
  {
    name: 'init-dispatch',
    description: 'Scaffold blank wiki/.dispatch/ config tables (models.json, backends.json, profiles.json) + kb-managed README. Re-run refreshes the managed section only, never user JSON. v1 init-config is untouched.',
    inputSchema: z.object({
      dir: z.string().describe('Target repo directory'),
      force: z.boolean().optional().describe('Force overwrite of managed README section even if it exists'),
    }),
    handler: async (input) => initDispatch({ dir: input.dir as string, force: input.force as boolean | undefined }),
  },
];

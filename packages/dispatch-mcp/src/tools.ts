import { z } from 'zod';
import {
  cleanup,
  createHandoff,
  initConfig,
  launch,
  review,
  reviewAndLaunch,
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
    }),
    handler: async (input) => createHandoff(input as unknown as Parameters<typeof createHandoff>[0]),
  },
  {
    name: 'review',
    description: 'Review a handoff document and create a reviewed bundle',
    inputSchema: dirSchema.extend({
      handoff: z.string(),
      agent: z.string(),
      reviewedAndAcceptRisks: z.boolean(),
    }),
    handler: async (input) => review(input as unknown as Parameters<typeof review>[0]),
  },
  {
    name: 'launch',
    description: 'Launch a previously reviewed handoff',
    inputSchema: dirSchema.extend({
      reviewId: z.string(),
    }),
    handler: async (input) => launch(input as unknown as Parameters<typeof launch>[0]),
  },
  {
    name: 'review-and-launch',
    description: 'Review a handoff and immediately launch it',
    inputSchema: dirSchema.extend({
      handoff: z.string(),
      agent: z.string(),
      reviewedAndAcceptRisks: z.boolean(),
    }),
    handler: async (input) => reviewAndLaunch(input as unknown as Parameters<typeof reviewAndLaunch>[0]),
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
];

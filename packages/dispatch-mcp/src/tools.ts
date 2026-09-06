import { z } from 'zod';
import {
  checkEnvironment,
  cleanup,
  createHandoff,
  getResponse,
  initConfig,
  launch,
  launchBackground,
  review,
  reviewAndLaunch,
  reviewAndLaunchBackground,
  status,
  waitForRun,
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

const runIdentifierSchema = z.object({
  dir: z.string().describe('Target repo directory'),
  reviewId: z.string().optional(),
  runId: z.string().optional(),
});

function requireRunIdentifier<T extends { reviewId?: string; runId?: string }>(schema: z.ZodType<T>): z.ZodType<T> {
  return schema.refine(
    (input) => Boolean(input.reviewId || input.runId),
    { message: 'At least one of reviewId or runId is required' },
  );
}

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
    }),
    handler: async (input) => createHandoff(input as unknown as Parameters<typeof createHandoff>[0]),
  },
  {
    name: 'review',
    description: 'Review a handoff document and create a reviewed bundle',
    inputSchema: dirSchema.extend({
      handoff: z.string().describe('Repo-relative path to the handoff file, e.g. wiki/handoffs/HO-0001.md'),
      agent: z.string(),
      reviewedAndAcceptRisks: z.boolean(),
    }),
    handler: async (input) => review(input as unknown as Parameters<typeof review>[0]),
  },
  {
    name: 'launch',
    description: 'Launch a previously reviewed handoff. Defaults to background mode for MCP callers.',
    inputSchema: dirSchema.extend({
      reviewId: z.string(),
      background: z.boolean().optional(),
      model: z.string().optional().describe('Model to use for this run'),
      effort: z.string().optional().describe('Effort/reasoning level for this run'),
    }),
    handler: async (input) => {
      if (input.background === false) {
        return launch(input as unknown as Parameters<typeof launch>[0]);
      }

      return launchBackground({
        dir: input.dir as string,
        reviewId: input.reviewId as string,
        verbose: input.verbose as boolean | undefined,
        model: input.model as string | undefined,
        effort: input.effort as string | undefined,
      });
    },
  },
  {
    name: 'review-and-launch',
    description: 'Review a handoff and immediately launch it. Defaults to background mode for MCP callers.',
    inputSchema: dirSchema.extend({
      handoff: z.string().describe('Repo-relative path to the handoff file, e.g. wiki/handoffs/HO-0001.md'),
      agent: z.string(),
      reviewedAndAcceptRisks: z.boolean(),
      background: z.boolean().optional(),
      model: z.string().optional().describe('Model to use for this run'),
      effort: z.string().optional().describe('Effort/reasoning level for this run'),
    }),
    handler: async (input) => {
      if (input.background === false) {
        return reviewAndLaunch(input as unknown as Parameters<typeof reviewAndLaunch>[0]);
      }

      return reviewAndLaunchBackground({
        dir: input.dir as string,
        handoff: input.handoff as string,
        agent: input.agent as string,
        reviewedAndAcceptRisks: input.reviewedAndAcceptRisks as boolean,
        verbose: input.verbose as boolean | undefined,
        model: input.model as string | undefined,
        effort: input.effort as string | undefined,
      });
    },
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
    name: 'wait-for-run',
    description: 'Wait for a dispatch run to reach terminal status, returning current state on timeout. Requires at least one of reviewId or runId.',
    inputSchema: requireRunIdentifier(runIdentifierSchema.extend({
      timeoutSeconds: z.number().optional(),
      pollIntervalMs: z.number().optional(),
    })),
    handler: async (input) => waitForRun(input as unknown as Parameters<typeof waitForRun>[0]),
  },
  {
    name: 'get-response',
    description: 'Retrieve response content and metadata for an active or completed dispatch run. Requires at least one of reviewId or runId.',
    inputSchema: requireRunIdentifier(runIdentifierSchema.extend({
      includeMeta: z.boolean().optional(),
      includeLogs: z.boolean().optional(),
    })),
    handler: async (input) => getResponse(input as unknown as Parameters<typeof getResponse>[0]),
  },
];

import { z } from 'zod';
import {
  bootstrap,
  sync,
  allocate,
  create,
  lint,
  generate,
  buildSearchIndex,
  search,
  importPlan,
  validatePlan,
  archivePlan,
} from '@kb/wiki-core';
import type { WikiPrefix } from '@kb/wiki-core';

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
    name: 'bootstrap',
    description: 'Bootstrap a wiki directory structure in a consuming repo',
    inputSchema: dirSchema.extend({
      repo: z.string().describe('Repo identifier (e.g. org/name)'),
      dryRun: z.boolean().optional(),
    }),
    handler: async (input) => bootstrap(input as unknown as Parameters<typeof bootstrap>[0]),
  },
  {
    name: 'sync-contract',
    description: 'Sync contract templates into an already-bootstrapped repo',
    inputSchema: dirSchema.extend({
      check: z.boolean().optional(),
    }),
    handler: async (input) => sync(input as unknown as Parameters<typeof sync>[0]),
  },
  {
    name: 'allocate-id',
    description: 'Allocate the next sequential ID for a given prefix',
    inputSchema: dirSchema.extend({
      prefix: z.string().describe('Record prefix (WK, IN, DEC, SRC, AREA, PLN)'),
    }),
    handler: async (input) =>
      allocate({ dir: input.dir as string, prefix: input.prefix as WikiPrefix, verbose: input.verbose as boolean | undefined }),
  },
  {
    name: 'create',
    description: 'Create a new wiki record from a template',
    inputSchema: dirSchema.extend({
      prefix: z.string().describe('Record prefix (WK, IN, DEC, SRC, AREA, PLN)'),
      title: z.string().describe('Record title'),
    }),
    handler: async (input) =>
      create({ dir: input.dir as string, prefix: input.prefix as string, title: input.title as string, verbose: input.verbose as boolean | undefined }),
  },
  {
    name: 'lint',
    description: 'Lint wiki records for frontmatter errors',
    inputSchema: dirSchema,
    handler: async (input) => lint(input as unknown as Parameters<typeof lint>[0]),
  },
  {
    name: 'generate',
    description: 'Generate standard wiki views (catalog, now, inbox, backlog, archive)',
    inputSchema: dirSchema,
    handler: async (input) => generate(input as unknown as Parameters<typeof generate>[0]),
  },
  {
    name: 'build-search-index',
    description: 'Build the wiki search index',
    inputSchema: dirSchema,
    handler: async (input) =>
      buildSearchIndex(input as unknown as Parameters<typeof buildSearchIndex>[0]),
  },
  {
    name: 'search',
    description: 'Search wiki records and docs',
    inputSchema: dirSchema.extend({
      query: z.string().describe('Search query'),
      prefix: z.string().optional(),
      status: z.string().optional(),
    }),
    handler: async (input) =>
      search(input as unknown as Parameters<typeof search>[0]),
  },
  {
    name: 'import-plan',
    description: 'Import design and execution artifacts into a PLN bundle',
    inputSchema: dirSchema.extend({
      plan: z.string().describe('PLN record id'),
      design: z.string().describe('Design source path, relative to target repo unless absolute'),
      execution: z.string().optional().describe('Execution source file or directory'),
      sourceTool: z.string().optional().describe('Planning source tool name'),
      overwrite: z.boolean().optional(),
    }),
    handler: async (input) =>
      importPlan(input as unknown as Parameters<typeof importPlan>[0]),
  },
  {
    name: 'validate-plan',
    description: 'Validate a PLN record and companion bundle',
    inputSchema: dirSchema.extend({
      plan: z.string().describe('PLN record id'),
    }),
    handler: async (input) =>
      validatePlan(input as unknown as Parameters<typeof validatePlan>[0]),
  },
  {
    name: 'archive-plan',
    description: 'Archive a PLN record without moving its bundle',
    inputSchema: dirSchema.extend({
      plan: z.string().describe('PLN record id'),
    }),
    handler: async (input) =>
      archivePlan(input as unknown as Parameters<typeof archivePlan>[0]),
  },
];

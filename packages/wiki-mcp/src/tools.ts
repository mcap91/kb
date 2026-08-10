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
  computeValueReport,
  computeValueUsage,
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
      mcpClient: z.enum(['claude', 'codex', 'none']).optional().describe('MCP client type (default: claude)'),
      agentInstructions: z.boolean().optional().describe('Write managed block to AGENTS.md/CLAUDE.md (default: true)'),
    }),
    handler: async (input) => bootstrap(input as unknown as Parameters<typeof bootstrap>[0]),
  },
  {
    name: 'sync-contract',
    description: 'Sync contract templates into an already-bootstrapped repo',
    inputSchema: dirSchema.extend({
      check: z.boolean().optional(),
      mcpClient: z.enum(['claude', 'codex', 'none']).optional().describe('MCP client type (default: claude)'),
      agentInstructions: z.boolean().optional().describe('Refresh managed block in AGENTS.md/CLAUDE.md (default: true)'),
      adopt: z.string().optional().describe(
        'Overwrite exactly one bootstrap surface with the current seed. ' +
        'Accepts bare name ("schema.md") or repo-relative path ("wiki/schema.md"). ' +
        'Must be one of: schema.md, conventions.md, index.md.',
      ),
    }),
    handler: async (input) => sync(input as unknown as Parameters<typeof sync>[0]),
  },
  {
    name: 'allocate-id',
    description:
      'Peek/reserve the next unclaimed sequential id for a prefix. Idempotent reservation, not a counter: repeat calls return the same id until create() writes the record that claims it. Use create to actually claim an id.',
    inputSchema: dirSchema.extend({
      prefix: z.string().describe('Record prefix (WK, IN, DEC, SRC, AREA, PLN, VAL)'),
    }),
    handler: async (input) =>
      allocate({ dir: input.dir as string, prefix: input.prefix as WikiPrefix, verbose: input.verbose as boolean | undefined }),
  },
  {
    name: 'create',
    description: 'Create a new wiki record from a template',
    inputSchema: dirSchema.extend({
      prefix: z.string().describe('Record prefix (WK, IN, DEC, SRC, AREA, PLN, VAL)'),
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
    description: 'Mark a PLN record done without moving its bundle',
    inputSchema: dirSchema.extend({
      plan: z.string().describe('PLN record id'),
    }),
    handler: async (input) =>
      archivePlan(input as unknown as Parameters<typeof archivePlan>[0]),
  },
  {
    name: 'value-report',
    description:
      'Compute deterministic git + graph metrics for a VAL value report: watermark, chain status, unit evidence (tested/wired/linked/candidate), the review_units surface, and COCOMO II nominal reference-ceiling fields (cocomo_kloc, cocomo_pm_nominal). Measures facts only — no estimation (human-day estimates are agent-proposed against the template anchor table and operator-ratified). COCOMO fields are display-only and never enter estimate arithmetic. Offline and reproducible. Returns ValueMetrics as JSON.',
    inputSchema: dirSchema.extend({
      since: z.string().optional().describe('Base ref override (default: prior VAL head_commit, else repo first commit)'),
      untilRef: z.string().optional().describe('Head ref override (default: HEAD)'),
    }),
    handler: async (input) =>
      computeValueReport({
        dir: input.dir as string,
        since: input.since as string | undefined,
        untilRef: input.untilRef as string | undefined,
      }),
  },
  {
    name: 'value-usage',
    description:
      'Scrape token/cost data from ccusage (claude + codex) and OpenRouter /credits for a date window. Returns UsageMetrics as JSON. Degrades gracefully when ccusage or keys are absent.',
    inputSchema: dirSchema.extend({
      since: z.string().describe('Window start date (YYYY-MM-DD) — use window_start from value-report output'),
      until: z.string().describe('Window end date (YYYY-MM-DD) — use window_end from value-report output'),
      ccusageVersion: z.string().optional().describe('Pin ccusage version (default: from wiki/.value-config.json or built-in pin)'),
    }),
    handler: async (input) =>
      computeValueUsage({
        dir: input.dir as string,
        since: input.since as string,
        until: input.until as string,
        ccusageVersion: input.ccusageVersion as string | undefined,
      }),
  },
];

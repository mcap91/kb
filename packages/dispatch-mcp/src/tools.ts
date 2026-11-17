import { z } from 'zod';
import {
  FINDING_JUDGMENTS,
  FIXUP_AUTHORING_RULES,
  checkEnvironment,
  cleanup,
  createHandoff,
  deriveReview,
  initDispatch,
  launchDispatchBackground,
  mergeDelivery,
  restamp,
  status,
  stopRun,
  type MergeJudgment,
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
    name: 'check-environment',
    description: 'Probe host bwrap/container/writability facts, including per-backend×model endpoint-eligibility (OpenRouter provider/ZDR constraints) (stateless — no persisted record)',
    inputSchema: dirSchema,
    handler: async (input) => checkEnvironment(input.dir as string),
  },
  {
    name: 'create-handoff',
    description: 'Create a repo-local HO handoff document. Pass wk + slice to generate it from a slice row of the work item (derives title, write_scope, read_first, objective, acceptance, validation; mode defaults to implement); otherwise title, mode, acceptance and validation are required.',
    inputSchema: dirSchema.extend({
      title: z.string().optional(),
      subject: z.string(),
      allowed_agents: z.array(z.string()),
      mode: z.enum(['implement', 'code_review', 'redteam', 'research', 'explore_code']).optional(),
      wk: z.string().optional().describe('Work item id (WK-NNNN) whose ## Slices table holds the slice row; requires slice'),
      slice: z.string().optional().describe('Slice row id (e.g. s1); requires wk'),
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
      acceptance: z.array(z.string()).min(1).optional(),
      validation: z.array(z.string()).min(1).optional(),
      web: z.boolean().optional(),
      credentials: z.array(z.string()).optional(),
      data_mounts: z.array(z.string()).optional(),
      export_mounts: z.array(z.string()).optional(),
      runtime_envs: z.array(z.string()).optional(),
      base_ref: z.string().optional(),
      fixup_context: z.string().optional().describe('Review findings a fix-up handoff (base_ref dispatch/<id>) repairs, injected verbatim into the worker prompt. ' + FIXUP_AUTHORING_RULES),
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
      model: z.string().optional().describe('Model alias from the registry, e.g. deepseek. Optional — resolved by HO mode from models.json use_for defaults when omitted'),
      backend: z.string().optional().describe('Backend name from the registry, e.g. openrouter. Optional — resolved by HO mode from models.json use_for defaults when omitted'),
      effort: z.string().optional().describe('Effort/reasoning level (refused with EFFORT_UNSUPPORTED when the model cannot carry it)'),
      preflight: z.boolean().optional().describe('Run bwrap preflight check (default: true)'),
      verbose: z.boolean().optional(),
    }),
    handler: async (input) => launchDispatchBackground({
      dir: input.dir as string,
      handoff: input.handoff as string,
      model: input.model as string | undefined,
      backend: input.backend as string | undefined,
      effort: input.effort as string | undefined,
      preflight: input.preflight as boolean | undefined,
      verbose: input.verbose as boolean | undefined,
    }),
  },
  {
    name: 'derive-review',
    description: 'Create a code_review HO from a delivered implement HO. After a finished review it covers only the commits that review did not see. Does NOT dispatch it — use dispatch separately.',
    inputSchema: z.object({
      dir: z.string().describe('Target repo directory'),
      handoff_id: z.string().describe('The implement HO id (e.g. HO-0034)'),
    }),
    handler: async (input) => deriveReview({ dir: input.dir as string, handoff_id: input.handoff_id as string }),
  },
  {
    name: 'init-dispatch',
    description: 'Scaffold blank wiki/.dispatch/ config tables (models.json, backends.json, profiles.json) + README. Every file, including README.md, is written only if absent — re-run never overwrites existing content.',
    inputSchema: z.object({
      dir: z.string().describe('Target repo directory'),
    }),
    handler: async (input) => initDispatch({ dir: input.dir as string }),
  },
  {
    name: 'merge-delivery',
    description:
      "Merge the chain's last delivery branch into the target branch. Gates on test evidence (host validation, from derive-review) and on one judgment per review finding. A review advises; it does not veto. Missing, failing, or stale-registry evidence refuses unless override_reason and override_actor are both given; an override commits a provenance record first and never replaces a judgment. The judgments are committed as a record before the merge. No remote push.",
    inputSchema: z.object({
      dir: z.string().describe('Target repo directory'),
      handoff_id: z.string().describe('The implement HO id whose delivery branch to merge (e.g. HO-0034)'),
      override_reason: z.string().optional().describe('OPERATOR-AUTHORIZED ONLY: pass only on an explicit operator instruction in this session, never on your own judgment. Overrides the host validation gate; states why merging without passing evidence is acceptable.'),
      override_actor: z.string().optional().describe('OPERATOR-AUTHORIZED ONLY (see override_reason): the operator who authorized the override. Self-reported and recorded as unauthenticated.'),
      judgments: z
        .array(
          z.object({
            review: z.string().optional().describe('The review handoff id; optional only when exactly one review on the chain has findings.'),
            finding: z.string().describe('The finding id from the review.'),
            judgment: z.enum(FINDING_JUDGMENTS).describe('fix: a delivery after the review fixes it. dismiss: not a defect. defer: real, not fixed now.'),
            reason: z.string().optional().describe('Required for dismiss and defer.'),
          }),
        )
        .optional()
        .describe('One judgment per review finding on the chain. Omit only when no review has findings.'),
    }),
    handler: async (input) =>
      mergeDelivery({
        dir: input.dir as string,
        handoff_id: input.handoff_id as string,
        ...(input.judgments !== undefined ? { judgments: input.judgments as MergeJudgment[] } : {}),
        ...(input.override_reason !== undefined || input.override_actor !== undefined
          ? {
              override: {
                reason: (input.override_reason as string | undefined) ?? '',
                actor: (input.override_actor as string | undefined) ?? '',
                surface: 'mcp' as const,
              },
            }
          : {}),
      }),
  },
  {
    name: 'restamp',
    description: "Set an HO's base_sha (and base_wiki_sha, when already declared) to current HEAD — the mechanized remediation for a BASE_DRIFT refusal. Run only after re-reading the declared files; this does not perform the re-read.",
    inputSchema: z.object({
      dir: z.string().describe('Target repo directory'),
      handoff: z.string().describe('Relative path to the handoff file (e.g. wiki/handoffs/HO-0034.md)'),
    }),
    handler: async (input) => restamp({ dir: input.dir as string, handoff: input.handoff as string }),
  },
  {
    name: 'stop-run',
    description: 'Kill a running dispatch by run-id and mark its state cancelled. Already-terminal runs return ok with a note, not an error.',
    inputSchema: z.object({
      dir: z.string().describe('Target repo directory'),
      run_id: z.string().describe('The run id to stop, e.g. RUN-<uuid>'),
    }),
    handler: async (input) => stopRun(input.dir as string, input.run_id as string),
  },
];

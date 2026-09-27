import { resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { V2_REFUSAL_CODES, listUnhandledRuns } from '@kb/dispatch-core';
import type { UnhandledRun } from '@kb/dispatch-core';
import { tools } from './tools.js';

/**
 * Shape an unexpected handler throw into a parseable error envelope.
 *
 * Mirrors the `{ ok: false, error, message }` shape dispatch-core returns for handled
 * failures, so MCP callers parse expected and unexpected errors the same way instead
 * of receiving a raw `Error: <internal>` string that leaks implementation detail.
 */
export function toErrorEnvelope(err: unknown, unhandledRuns?: UnhandledRun[]) {
  const message = err instanceof Error ? err.message : String(err);
  const envelope: Record<string, unknown> = { ok: false, error: 'INTERNAL_ERROR', message };
  if (unhandledRuns && unhandledRuns.length > 0) {
    envelope.unhandled_runs = unhandledRuns;
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(envelope, null, 2),
      },
    ],
    isError: true as const,
  };
}

// WK-0046 T15: advertise side-effects and audience so an agent can distinguish routine
// read tools from operator-setup / execution tools. Kept name-keyed here so the
// declarations in tools.ts stay lean; update these sets when adding a tool.
const READ_ONLY = new Set(['status']);
const OPERATOR_ONLY = new Set(['init-dispatch', 'dispatch', 'derive-review', 'merge-delivery']);
const DESTRUCTIVE = new Set(['cleanup', 'dispatch', 'merge-delivery']);

// WK-0046-style MCP instructions (PLN-0004 S1 Wave 3, s1-rulings ruling 8): built
// at startup from in-process constants only — pure/static, no probes, no I/O. Boot
// probes are rejected (wsl.exe latency on every connect, duplicating
// check-environment's own lazy/cached probing); lazy is rejected too (instructions
// ship in the MCP initialize handshake, so they must exist at connect time).
const INSTRUCTIONS = [
  '## kb-dispatch v2 quickstart',
  '',
  'To dispatch work to an agent:',
  '1. Author a handoff: `wiki/handoffs/HO-XXXX.md` (use `create-handoff` or hand-author)',
  '2. Run `dispatch` with the handoff path, model alias, and backend name — it returns a `watch` command',
  '3. Run the `watch` command as a background Bash command (`run_in_background: true`) to be notified on terminal status',
  '4. Read `wiki/handoffs/HO-XXXX.response.md` for the result',
  '',
  '## Tools',
  '',
  '| Tool | Purpose |',
  '|------|---------|',
  '| dispatch | Gate + launch (background, atomic); returns a `watch` command |',
  '| init-dispatch | Scaffold wiki/.dispatch/ config tables |',
  '| status | Repo-wide run state + v2 runs[] |',
  '| check-environment | Host tier probes |',
  '| create-handoff | Scaffold an HO |',
  '| cleanup | Stale state removal |',
  '| derive-review | Create a code_review HO from a delivered implement HO |',
  '| merge-delivery | Merge delivery branch after review pass; gates on review evidence |',
  '',
  '## Refusal codes',
  '',
  V2_REFUSAL_CODES.join(', '),
  '',
  '## Available models',
  '',
  'Configure models and backends in <repo>/wiki/.dispatch/ (run init-dispatch to scaffold). Resolve with --model <slug> --backend <name>.',
  '',
  '## Credentials',
  '',
  "Credential liveness is the orchestrator's job — kb verifies files exist and contain the named var, but never executes credential commands.",
  '',
  'Credential profiles carry an optional `endpoints` array — the hostnames the credential grants network access to (e.g. `["*.amazonaws.com"]` for AWS). The forwarder allows these destinations only when the profile is granted. Credentials are usable under `web:false` only; `credentials_granted` + `web: true` is a hard refusal (`CREDENTIALS_WITH_WEB`).',
  '',
  'Run `check-environment` for host-tier facts and the invocation contract.',
  '',
  '## Orchestration recipe',
  '',
  '**Loop spine:**',
  '',
  '1. Author HO(s) for the work item (use `create-handoff` or hand-author). Feature-sized — one coherent, independently reviewable unit with ACs and validation command. Not function-sized. **Visibility:** workers see ONLY system toolchain + the clone + declared mounts. Any out-of-repo directory the worker needs to READ (conda/mamba/uv envs, datasets, reference data) goes in `data_mounts` (bound read-only); any directory it needs to WRITE output to goes in `export_mounts` (bound writable). Envs should also be named in `vars`. A missing mount surfaces as `dependency_missing` — widen data_mounts/export_mounts and re-dispatch (existing fix-up routing). Edit the WK before `create-handoff` or after the run, never between `create-handoff` and `dispatch`. The WK is a declared file, so editing it in between trips `BASE_DRIFT`.',
  '2. Dispatch: `dispatch` with handoff path, model, backend. Background by default — returns immediately with a runId and a `watch` command.',
  '3. Watch: run the returned `watch` command as a background Bash command (`run_in_background: true`). It blocks until the run reaches terminal status, then exits. Use `status` for an ad-hoc point-in-time check. Any response may carry `unhandled_runs`; surface each entry to the operator.',
  '4. Read result: `wiki/handoffs/HO-XXXX.response.md` (auto-committed by the pipeline — DEC-0038). Check verdict and recovery signal.',
  '5. Review (two-step): `derive-review` creates a `code_review` HO from the delivered implement (derives write_scope, acceptance, base_ref=`dispatch/HO-XXXX`). Then `dispatch` it separately — same dispatch/watch/read cycle as step 2-4. The review response is auto-committed by the pipeline.',
  '6. On review pass: `merge-delivery` merges `dispatch/HO-XXXX` into the target branch and deletes it. Gates on review evidence — the review response must contain a `kb-dispatch-recovery.v1` block with `no_findings` or `passed_no_blocking_or_medium_findings`. Refuses on conflict (surface to operator). No remote push.',
  '7. **Update wiki records:** after each dispatch run completes (implement, review, or fix-up), update the linked wiki record (WK/IN status, notes) via kb-wiki tools. This is obligatory — the wiki must reflect current state after every step. This is the continuity mechanism: any fresh session reads the wiki and knows the state.',
  '',
  '**Fix-up routing** (on non-delivered implement outcomes): read the `kind` code from the `kb-dispatch-recovery.v1` block in the response doc.',
  '',
  '- `scope_insufficient` + fix-up budget remaining → widen write_scope/data_mounts/export_mounts, re-dispatch (same base_ref)',
  '- `partial_progress` + budget remaining → re-dispatch with prior findings as context',
  '- `dependency_missing` or `resource_limit` → stop, report to operator (system-level)',
  '- `spec_unclear` → escalate to operator (needs human input)',
  '- ≤2 fix-up dispatches per implement, then stop and report',
  '',
  '**`BASE_DRIFT` refusal:** declared files (write_scope, read_first, the WK) changed since the HO\'s `base_sha` (or `base_wiki_sha` in nested-private repos), or the stamp is missing. Re-read the listed changes against the HO and WK, fix and commit anything stale, then set the named field to the current HEAD printed in the message and re-dispatch. Update the stamp last, after committing fixes. This is autonomous, not an operator escalation.',
  '',
  '**Autonomy boundary:** the orchestrator returns to the operator ONLY for: completion report, failure past fix-up budget, gate refusal requiring operator action, dead credential, or a genuine new design decision. Everything else is autonomous.',
  '',
  "**Session hygiene:** at session end, verify `git branch --list 'dispatch/*'` is empty. Failed-run branches persist as crime scene until operator disposition.",
  '',
  '**SaaS backends (codex/claude):** these function under `web:false` — each has a built-in vendor domain allowlist. Never set `web: true` just to make a SaaS family work.',
].join('\n');

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'kb-dispatch',
      version: '0.0.1',
    },
    {
      instructions: INSTRUCTIONS,
    },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: READ_ONLY.has(tool.name),
          destructiveHint: DESTRUCTIVE.has(tool.name),
        },
        ...(OPERATOR_ONLY.has(tool.name) ? { _meta: { 'io.kb/audience': 'operator' } } : {}),
      },
      async (args) => {
        try {
          const result = await tool.handler(args as Record<string, unknown>);
          const resultObj = typeof result === 'object' && result !== null ? result : { data: result };

          // WK-0153: attach unhandled_runs as a structured sibling field
          const dir = (args as Record<string, unknown>).dir;
          if (typeof dir === 'string') {
            const unhandledResult = await listUnhandledRuns(resolve(dir));
            if (unhandledResult.ok && unhandledResult.data.length > 0) {
              (resultObj as Record<string, unknown>).unhandled_runs = unhandledResult.data;
            }
          }

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(resultObj, null, 2) }],
          };
        } catch (err) {
          const dir = (args as Record<string, unknown>).dir;
          let unhandledRuns: UnhandledRun[] | undefined;
          if (typeof dir === 'string') {
            const ur = await listUnhandledRuns(resolve(dir));
            if (ur.ok) unhandledRuns = ur.data;
          }
          return toErrorEnvelope(err, unhandledRuns);
        }
      },
    );
  }

  return server;
}

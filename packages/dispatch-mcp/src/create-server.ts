import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { V2_REFUSAL_CODES } from '@kb/dispatch-core';
import { tools } from './tools.js';

/**
 * Shape an unexpected handler throw into a parseable error envelope.
 *
 * Mirrors the `{ ok: false, error, message }` shape dispatch-core returns for handled
 * failures, so MCP callers parse expected and unexpected errors the same way instead
 * of receiving a raw `Error: <internal>` string that leaks implementation detail.
 */
export function toErrorEnvelope(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const envelope: Record<string, unknown> = { ok: false, error: 'INTERNAL_ERROR', message };
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
const OPERATOR_ONLY = new Set(['init-dispatch', 'dispatch', 'derive-review', 'merge-delivery', 'stop-run']);
const DESTRUCTIVE = new Set(['cleanup', 'dispatch', 'merge-delivery', 'stop-run']);

// WK-0046-style MCP instructions (PLN-0004 S1 Wave 3, s1-rulings ruling 8): built
// at startup from in-process constants only — pure/static, no probes, no I/O. Boot
// probes are rejected (wsl.exe latency on every connect, duplicating
// check-environment's own lazy/cached probing); lazy is rejected too (instructions
// ship in the MCP initialize handshake, so they must exist at connect time).
export const INSTRUCTIONS = [
  '## kb-dispatch: the loop',
  '',
  'One slice of a work item is one handoff (HO). Code runs the gates; you decide what is next.',
  '',
  '1. `create-handoff` (pass `wk` + `slice` when the work item has a Slices table), then `dispatch`. Run the returned `watch` command in the background. Read `wiki/handoffs/HO-XXXX.response.md`.',
  "2. The pipeline runs the repo's test suite on every implement delivery and writes a `Host validation:` line into the response. Never run tests yourself to fill that role.",
  '3. `derive-review`, then `dispatch` the review HO. The review audits the delivered code. Its findings advise you; they do not decide the merge.',
  '4. Judge every finding: `fix`, `dismiss` or `defer`, with a reason for `dismiss` and `defer`. You decide. Do not ask the operator to approve a fix-up.',
  '   - Any `fix`: author one fix-up HO for all of them (`base_ref: dispatch/HO-XXXX`, `fixup_context` = the findings to fix) and dispatch it. Each fix adds a test that fails before the fix and passes after it. `derive-review` on the fix-up HO then reviews only the fix-up; it is cheap, so skip it only for a trivial fix-up.',
  '5. `merge-delivery` on the last HO of the chain, with your `judgments` for every finding of every review on the chain. It refuses while a finding has no judgment, while a `fix` has no delivery after the review, or while the tests are red. Red tests: send a fix-up, or report. An override needs an explicit operator instruction.',
  '6. Update the work item record after every step.',
  '',
  'Return to the operator only for: the completion report, a failure past the fix-up budget, a refusal that needs operator action, a dead credential, or a new design decision.',
  '',
  '## Tools',
  '',
  '| Tool | Purpose |',
  '|------|---------|',
  '| dispatch | Gate + launch (background, atomic); returns a `watch` command |',
  '| init-dispatch | Scaffold wiki/.dispatch/ config tables |',
  '| status | Repo-wide run state + v2 runs[] |',
  '| check-environment | Host tier probes, incl. per-backend×model endpoint-eligibility |',
  '| create-handoff | Scaffold an HO |',
  '| cleanup | Stale state removal |',
  '| derive-review | Create a code_review HO from a delivered implement HO |',
  '| merge-delivery | Merge the chain\'s last delivery; gates on test evidence and one judgment per review finding |',
  '| stop-run | Kill a running dispatch by run-id, mark cancelled |',
  '',
  '## Dispatch modes',
  '',
  '| Mode | When | What the worker does |',
  '|------|------|----------------------|',
  '| implement | New code / feature work | Writes code, runs validation |',
  '| code_review | Post-delivery review | Reviews branch diff against spec + acceptance; writes no code |',
  '| redteam | Adversarial testing | Actively tries to break the implementation |',
  '| research | Web-aided investigation | Read-only, web tools if granted; reports findings + sources |',
  '| explore_code | Read-only codebase investigation | Read-only, no web; reports structured findings |',
  '',
  '`redteam` is adversarial robustness testing, not spec-compliance review.',
  '',
  '## Refusal codes',
  '',
  V2_REFUSAL_CODES.join(', '),
  '',
  '`ACTIVE_RUN_EXISTS` is same-handoff single-flight only: one active run per HO. Different handoffs dispatch concurrently, each in its own clone of `base_sha`. Only merges to main serialize.',
  '',
  'A `write_scope` entry refuses `STALE_WRITE_SCOPE`, naming the entry, for every family, if it has a `.git` path segment or resolves to the repo root (`""`, `.`, `./`, `/`) — at `create-handoff` authoring time and again at `dispatch` admission. A root-level file entry (e.g. `README.md`) is fine: every family binds it as an exact file, never the directory around it.',
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
  '1. Author HO(s) for the work item (use `create-handoff` or hand-author). Feature-sized: one coherent, independently reviewable unit with ACs and validation command. **Visibility:** workers see ONLY system toolchain + the clone + declared mounts. Any out-of-repo directory the worker needs to READ (conda/mamba/uv envs, datasets, reference data) goes in `data_mounts` (bound read-only); any directory it needs to WRITE output to goes in `export_mounts` (bound writable). Envs should also be named in `vars`. A missing mount surfaces as `dependency_missing` — widen data_mounts/export_mounts and re-dispatch (existing fix-up routing). Edit the WK before `create-handoff` or after the run, never between them: the WK is a declared file, so editing it in between trips `BASE_DRIFT`.',
  '2. Dispatch and watch: `dispatch` runs in the background and returns a runId and a `watch` command. Run it as a background Bash command (`run_in_background: true`); it exits at terminal status. `status` gives a point-in-time check.',
  '3. Read result: `wiki/handoffs/HO-XXXX.response.md` (auto-committed by the pipeline). Check verdict and recovery signal; the implement report is under `## Worker Report`.',
  '4. Review (two-step): `derive-review` creates a `code_review` HO covering the chain of unmerged implement deliveries on `HEAD..dispatch/HO-XXXX`; it reuses the host validation evidence from delivery. Then `dispatch` it separately — same cycle as steps 2-3. The review response is auto-committed by the pipeline. After a finished review, `derive-review` covers only the commits it did not see; it refuses if that review covers the head.',
  '5. Merge: judge each review finding (`reason` required for `dismiss` and `defer`) and pass a judgment for every finding of every review on the chain as `judgments`: `{ "finding": "<finding id>", "judgment": "fix"|"dismiss"|"defer", "reason": "<text>" }`. `merge-delivery` merges `dispatch/HO-XXXX` (the last HO of the chain) into the target branch and deletes it. It refuses while a finding has no judgment, while a `fix` has no implement delivery after the review, or while the host validation of the last delivery is not green. `override_reason`/`override_actor` merge past red or missing test evidence only on an explicit operator instruction, never on your own judgment. Refuses on conflict (surface to operator). No remote push.',
  '6. **Update wiki records:** after each dispatch run completes (implement, review, or fix-up), update the linked wiki record (WK/IN status, notes) via kb-wiki tools. This is obligatory: any fresh session reads the wiki to know the state.',
  '',
  '**Fix-up after a review:** one implement HO for all `fix` findings: `base_ref: dispatch/HO-XXXX`, `fixup_context` = the findings to fix. Each fix adds a test that fails before and passes after; `derive-review` on the fix-up reviews only it (skip only for a trivial one). State each fix as a property of the whole branch with the command that proves it. Restate every standing property of the tests the fix-up touches.',
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
  '**`REVIEWED_SHA_MISMATCH` refusal:** dispatching a derived code_review HO whose `base_ref` no longer points at the `reviewed_sha` it was derived for. Do not edit the stamp. Re-run `derive-review` and dispatch the new review it creates.',
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

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(resultObj, null, 2) }],
          };
        } catch (err) {
          return toErrorEnvelope(err);
        }
      },
    );
  }

  return server;
}

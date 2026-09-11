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
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: false, error: 'INTERNAL_ERROR', message }, null, 2),
      },
    ],
    isError: true as const,
  };
}

// WK-0046 T15: advertise side-effects and audience so an agent can distinguish routine
// read tools from operator-setup / execution tools. Kept name-keyed here so the
// declarations in tools.ts stay lean; update these sets when adding a tool.
const READ_ONLY = new Set(['status', 'wait-for-run', 'get-response']);
const OPERATOR_ONLY = new Set(['init-config', 'init-dispatch', 'review', 'launch', 'review-and-launch', 'dispatch']);
const DESTRUCTIVE = new Set(['launch', 'review-and-launch', 'cleanup', 'dispatch']);

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
  '2. Run `dispatch` with the handoff path, model alias, and backend name',
  '3. Poll `status` or `wait-for-run` at turn boundaries to track progress',
  '4. Read `wiki/handoffs/HO-XXXX.response.md` for the result',
  '',
  '## Tools',
  '',
  '| Tool | Purpose | v1/v2 |',
  '|------|---------|-------|',
  '| dispatch | Gate + launch (background, atomic) | v2 |',
  '| init-dispatch | Scaffold wiki/.dispatch/ config tables | v2 |',
  '| status | Repo-wide run state + v2 runs[] | both |',
  '| wait-for-run | Poll a run to terminal | both |',
  '| check-environment | Host tier probes | both |',
  '| create-handoff | Scaffold an HO | both |',
  '| init-config | Operator setup | both |',
  '| cleanup | Stale state removal | both |',
  '| review | v1 review step | v1 (legacy) |',
  '| launch | v1 launch step | v1 (legacy) |',
  '| review-and-launch | v1 combined | v1 (legacy) |',
  '| get-response | v1 response reader | v1 (legacy) |',
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
  'Run `check-environment` for host-tier facts and the invocation contract.',
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
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return toErrorEnvelope(err);
        }
      },
    );
  }

  return server;
}

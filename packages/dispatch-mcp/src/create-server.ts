import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
const OPERATOR_ONLY = new Set(['init-config', 'review', 'launch', 'review-and-launch']);
const DESTRUCTIVE = new Set(['launch', 'review-and-launch', 'cleanup']);

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'kb-dispatch',
    version: '0.0.1',
  });

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

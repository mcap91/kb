import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tools } from './tools.js';

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
      },
      async (args) => {
        try {
          const result = await tool.handler(args as Record<string, unknown>);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

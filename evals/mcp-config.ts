/**
 * Per-run MCP config (WK-0237 scope 17.3, Resolutions 7/9). The harness
 * writes this file into the run's writable home before launch and passes it
 * to `claude -p` as `--mcp-config <jail path> --strict-mcp-config` (the
 * claude-argv.ts caller owns the jail-side path string; this module only
 * builds/writes the config content).
 */
import { writeFileSync } from 'node:fs';

import { fail, ok, type EvalResult } from './result.js';

export type McpKind = 'kb-wiki' | 'none';

export interface McpServerEntry {
  command: string;
  args: string[];
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/** kb-wiki launches as `node --import file:///kb/node_modules/tsx/dist/loader.mjs /kb/packages/wiki-mcp/src/server.ts` against the jail's read-only `/kb` bind; 'none' yields no servers (T3's no-kb-wiki case). */
export function buildMcpConfig(kind: McpKind): McpConfig {
  if (kind === 'none') {
    return { mcpServers: {} };
  }
  return {
    mcpServers: {
      'kb-wiki': {
        command: 'node',
        args: [
          '--import',
          'file:///kb/node_modules/tsx/dist/loader.mjs',
          '/kb/packages/wiki-mcp/src/server.ts',
        ],
      },
    },
  };
}

export function writeMcpConfig(destPath: string, kind: McpKind): EvalResult<void> {
  try {
    writeFileSync(destPath, JSON.stringify(buildMcpConfig(kind), null, 2));
    return ok(undefined);
  } catch (err) {
    return fail('MCP_CONFIG_WRITE_FAILED', `writing MCP config to ${destPath} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

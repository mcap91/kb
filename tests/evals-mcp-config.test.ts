/**
 * WK-0237 slice A — per-run MCP config (mcp-config.ts) and the claude argv's
 * unconditional --mcp-config/--strict-mcp-config carry (claude-argv.ts).
 */
import { describe, expect, it } from 'vitest';

import { buildClaudeArgv } from '../evals/claude-argv.js';
import { buildMcpConfig } from '../evals/mcp-config.js';

describe('buildMcpConfig', () => {
  it("kind 'kb-wiki' yields exactly one server named kb-wiki launched via the jail's /kb bind", () => {
    const config = buildMcpConfig('kb-wiki');
    expect(Object.keys(config.mcpServers)).toEqual(['kb-wiki']);
    expect(config.mcpServers['kb-wiki']).toEqual({
      command: 'node',
      args: ['--import', 'file:///kb/node_modules/tsx/dist/loader.mjs', '/kb/packages/wiki-mcp/src/server.ts'],
    });
  });

  it("kind 'none' yields an empty mcpServers object", () => {
    expect(buildMcpConfig('none')).toEqual({ mcpServers: {} });
  });
});

describe('buildClaudeArgv — MCP flags', () => {
  it('always carries --mcp-config <jail path> and --strict-mcp-config', () => {
    const argv = buildClaudeArgv({ prompt: 'hi', mcpConfigPath: '/home/eval/mcp-config.json' });
    const idx = argv.indexOf('--mcp-config');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('/home/eval/mcp-config.json');
    expect(argv).toContain('--strict-mcp-config');
  });

  it('carries --mcp-config/--strict-mcp-config the same way for the none-MCP config path', () => {
    const argv = buildClaudeArgv({ prompt: 'hi', mcpConfigPath: '/home/eval/mcp-config-none.json' });
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe('/home/eval/mcp-config-none.json');
  });
});

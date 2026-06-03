import { describe, expect, it } from 'vitest';

import {
  buildCodexCommandInvocation,
  createClaudeProjectMcpConfig,
  createCodexMcpRegistrations,
  getCodexExecutable,
} from '../scripts/mcp-self-hosting.js';

describe('self-hosting MCP setup', () => {
  it('generates a valid Claude project config', () => {
    const config = createClaudeProjectMcpConfig();

    expect(config).toHaveProperty('mcpServers.kb-wiki');
    expect(config).toHaveProperty('mcpServers.kb-dispatch');
    expect(config.mcpServers['kb-wiki'].command).toBe('node');
    expect(config.mcpServers['kb-dispatch'].command).toBe('node');
  });

  it('builds Windows Codex registrations with file URL loader paths', () => {
    const repoRoot = 'C:\\Users\\alice\\projects\\kb';

    expect(createCodexMcpRegistrations(repoRoot, 'win32')).toEqual([
      {
        name: 'kb-wiki',
        command: 'node',
        args: [
          '--import',
          'file:///C:/Users/alice/projects/kb/node_modules/tsx/dist/loader.mjs',
          'C:/Users/alice/projects/kb/packages/wiki-mcp/src/server.ts',
        ],
      },
      {
        name: 'kb-dispatch',
        command: 'node',
        args: [
          '--import',
          'file:///C:/Users/alice/projects/kb/node_modules/tsx/dist/loader.mjs',
          'C:/Users/alice/projects/kb/packages/dispatch-mcp/src/server.ts',
        ],
      },
    ]);
  });

  it('builds Linux Codex registrations with absolute script paths', () => {
    const repoRoot = '/home/alice/projects/kb';

    expect(createCodexMcpRegistrations(repoRoot, 'linux')).toEqual([
      {
        name: 'kb-wiki',
        command: 'node',
        args: [
          '--import',
          'file:///home/alice/projects/kb/node_modules/tsx/dist/loader.mjs',
          '/home/alice/projects/kb/packages/wiki-mcp/src/server.ts',
        ],
      },
      {
        name: 'kb-dispatch',
        command: 'node',
        args: [
          '--import',
          'file:///home/alice/projects/kb/node_modules/tsx/dist/loader.mjs',
          '/home/alice/projects/kb/packages/dispatch-mcp/src/server.ts',
        ],
      },
    ]);
  });

  it('uses the correct Codex executable per platform', () => {
    expect(getCodexExecutable('win32')).toBe('codex.cmd');
    expect(getCodexExecutable('linux')).toBe('codex');
  });

  it('wraps Windows Codex invocations through cmd.exe', () => {
    expect(
      buildCodexCommandInvocation(
        'codex.cmd',
        [
          'mcp',
          'add',
          'kb-wiki',
          '--',
          'node',
          '--import',
          'file:///C:/Users/alice/My Projects/kb/node_modules/tsx/dist/loader.mjs',
          'C:/Users/alice/My Projects/kb/packages/wiki-mcp/src/server.ts',
        ],
        'win32',
        'cmd.exe',
      ),
    ).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'codex.cmd mcp add kb-wiki -- node --import "file:///C:/Users/alice/My Projects/kb/node_modules/tsx/dist/loader.mjs" "C:/Users/alice/My Projects/kb/packages/wiki-mcp/src/server.ts"',
      ],
    });
  });
});

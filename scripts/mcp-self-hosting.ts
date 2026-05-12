import { posix, win32 } from 'node:path';

type PlatformPath = typeof posix | typeof win32;

export interface StdioMcpServerConfig {
  type: 'stdio';
  command: 'node';
  args: string[];
  env: Record<string, string>;
}

export interface ClaudeProjectMcpConfig {
  mcpServers: Record<string, StdioMcpServerConfig>;
}

export interface CodexMcpRegistration {
  name: string;
  command: 'node';
  args: string[];
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

const RELATIVE_LOADER_PATH = './node_modules/tsx/dist/loader.mjs';

const SERVER_DEFINITIONS = [
  {
    name: 'kb-wiki',
    relativeScriptPath: './packages/wiki-mcp/src/server.ts',
    absoluteSegments: ['packages', 'wiki-mcp', 'src', 'server.ts'],
  },
  {
    name: 'kb-dispatch',
    relativeScriptPath: './packages/dispatch-mcp/src/server.ts',
    absoluteSegments: ['packages', 'dispatch-mcp', 'src', 'server.ts'],
  },
] as const;

function getPathModule(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix;
}

function toSlashPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function toFileUrl(absolutePath: string, platform: NodeJS.Platform): string {
  const slashPath = toSlashPath(absolutePath);
  return platform === 'win32' ? `file:///${slashPath}` : `file://${slashPath}`;
}

function quoteForCmd(arg: string): string {
  if (!/[\s"&()^<>|]/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function joinAbsolutePath(
  repoRoot: string,
  segments: readonly string[],
  platform: NodeJS.Platform,
): string {
  return getPathModule(platform).join(repoRoot, ...segments);
}

export function createClaudeProjectMcpConfig(): ClaudeProjectMcpConfig {
  return {
    mcpServers: Object.fromEntries(
      SERVER_DEFINITIONS.map(({ name, relativeScriptPath }) => [
        name,
        {
          type: 'stdio',
          command: 'node',
          args: ['--import', RELATIVE_LOADER_PATH, relativeScriptPath],
          env: {},
        },
      ]),
    ),
  };
}

export function createCodexMcpRegistrations(
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
): CodexMcpRegistration[] {
  const loaderPath = joinAbsolutePath(
    repoRoot,
    ['node_modules', 'tsx', 'dist', 'loader.mjs'],
    platform,
  );

  return SERVER_DEFINITIONS.map(({ name, absoluteSegments }) => ({
    name,
    command: 'node',
    args: [
      '--import',
      toFileUrl(loaderPath, platform),
      toSlashPath(joinAbsolutePath(repoRoot, absoluteSegments, platform)),
    ],
  }));
}

export function getCodexExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'codex.cmd' : 'codex';
}

export function buildCodexCommandInvocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env['COMSPEC'] || 'cmd.exe',
): CommandInvocation {
  if (platform === 'win32') {
    return {
      command: comspec,
      args: ['/d', '/s', '/c', [executable, ...args].map(quoteForCmd).join(' ')],
    };
  }

  return { command: executable, args };
}

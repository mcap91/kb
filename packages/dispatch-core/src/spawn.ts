import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';

export type SpawnInvocation = {
  command: string;
  args: string[];
  shell: boolean;
};

export function shouldSpawnDetached(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

export type ResolvedExecutableCommand = {
  originalCommand: string;
  command: string;
  source: 'as_provided' | 'path' | 'fallback';
  pathEntries: string[];
  fallbackDirs: string[];
  searchedCandidates: string[];
};

export type ResolveExecutableCommandOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fallbackDirs?: string[];
  isExecutable?: (candidate: string, platform: NodeJS.Platform) => Promise<boolean>;
};

const POSIX_FALLBACK_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];

function quoteForCmd(arg: string): string {
  if (!/[\s"&()^<>|]/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function pathApiFor(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

function isPathCommand(command: string, platform: NodeJS.Platform): boolean {
  return pathApiFor(platform).isAbsolute(command) ||
    /[\\/]/.test(command) ||
    (platform === 'win32' && /^[a-zA-Z]:/.test(command));
}

function getEnvValue(
  env: Record<string, string | undefined>,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  const direct = env[key];
  if (direct !== undefined || platform !== 'win32') {
    return direct;
  }

  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

function normalizePathEntry(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unique(values: string[], platform: NodeJS.Platform = process.platform): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = platform === 'win32' ? value.toLowerCase() : value;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function getPathEntries(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const pathValue = getEnvValue(env, 'PATH', platform);
  if (!pathValue) {
    return [];
  }

  return unique(
    pathValue
      .split(pathApiFor(platform).delimiter)
      .map(normalizePathEntry)
      .filter(Boolean),
    platform,
  );
}

function getPathExtensions(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') {
    return [''];
  }

  const raw = getEnvValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD';
  return unique(
    raw
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.startsWith('.') ? entry : `.${entry}`),
    platform,
  );
}

function getWindowsFallbackDirs(env: Record<string, string | undefined>): string[] {
  const dirs: string[] = [];
  const appData = getEnvValue(env, 'APPDATA', 'win32');
  const localAppData = getEnvValue(env, 'LOCALAPPDATA', 'win32');
  const programFiles = getEnvValue(env, 'ProgramFiles', 'win32');
  const programFilesX86 = getEnvValue(env, 'ProgramFiles(x86)', 'win32');
  const systemRoot = getEnvValue(env, 'SystemRoot', 'win32');

  if (appData) dirs.push(win32.join(appData, 'npm'));
  if (localAppData) dirs.push(win32.join(localAppData, 'Programs', 'nodejs'));
  if (programFiles) dirs.push(win32.join(programFiles, 'nodejs'));
  if (programFilesX86) dirs.push(win32.join(programFilesX86, 'nodejs'));
  if (systemRoot) {
    dirs.push(win32.join(systemRoot, 'System32'));
    dirs.push(systemRoot);
  }

  return unique(dirs, 'win32');
}

function getDefaultFallbackDirs(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  return platform === 'win32' ? getWindowsFallbackDirs(env) : POSIX_FALLBACK_DIRS;
}

function getCandidateNames(
  command: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== 'win32') {
    return [command];
  }

  if (win32.extname(command)) {
    return [command];
  }

  return unique([
    ...getPathExtensions(env, platform).map((ext) => `${command}${ext}`),
    // Windows npm installs can leave extensionless POSIX shims next to .cmd shims.
    // Prefer PATHEXT candidates because those are what can be spawned safely here.
    command,
  ], platform);
}

async function defaultIsExecutable(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function maybeResolveWindowsClaudeExe(
  command: string,
  candidate: string,
  isExecutable: (path: string, platform: NodeJS.Platform) => Promise<boolean>,
): Promise<string> {
  if (command.toLowerCase() !== 'claude' || !/\\claude\.cmd$/i.test(candidate)) {
    return candidate;
  }

  const claudeExe = win32.join(
    win32.dirname(candidate),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );

  return await isExecutable(claudeExe, 'win32') ? claudeExe : candidate;
}

function formatPathDiagnostic(
  pathEntries: string[],
  fallbackDirs: string[],
): string {
  const pathText = pathEntries.length > 0 ? pathEntries.join(', ') : '<empty>';
  const fallbackText = fallbackDirs.length > 0 ? fallbackDirs.join(', ') : '<none>';
  return `PATH entries: ${pathText}; fallback directories: ${fallbackText}`;
}

export async function resolveExecutableCommand(
  command: string,
  options: ResolveExecutableCommandOptions = {},
): Promise<DispatchResult<ResolvedExecutableCommand>> {
  const platform = options.platform ?? process.platform;
  if (isPathCommand(command, platform)) {
    return ok({
      originalCommand: command,
      command,
      source: 'as_provided',
      pathEntries: [],
      fallbackDirs: [],
      searchedCandidates: [],
    });
  }

  const env = options.env ?? process.env;
  const pathApi = pathApiFor(platform);
  const pathEntries = getPathEntries(env, platform);
  const fallbackDirs = unique(options.fallbackDirs ?? getDefaultFallbackDirs(env, platform), platform);
  const searchDirs = unique([...pathEntries, ...fallbackDirs], platform);
  const candidateNames = getCandidateNames(command, env, platform);
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const searchedCandidates: string[] = [];

  for (const dir of searchDirs) {
    for (const candidateName of candidateNames) {
      const candidate = pathApi.resolve(dir, candidateName);
      searchedCandidates.push(candidate);
      if (await isExecutable(candidate, platform)) {
        const resolvedCandidate = platform === 'win32'
          ? await maybeResolveWindowsClaudeExe(command, candidate, isExecutable)
          : candidate;
        return ok({
          originalCommand: command,
          command: resolvedCandidate,
          source: pathEntries.includes(dir) ? 'path' : 'fallback',
          pathEntries,
          fallbackDirs,
          searchedCandidates,
        });
      }
    }
  }

  return fail(
    'INVALID_AGENT',
    `Unable to resolve agent executable "${command}". ${formatPathDiagnostic(pathEntries, fallbackDirs)}.`,
    {
      command,
      pathEntries,
      fallbackDirs,
      searchedCandidates,
    },
  );
}

export function buildSpawnInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env['COMSPEC'] || 'cmd.exe',
): SpawnInvocation {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: comspec,
      args: ['/d', '/s', '/c', [command, ...args].map(quoteForCmd).join(' ')],
      shell: false,
    };
  }

  return {
    command,
    args,
    shell: false,
  };
}

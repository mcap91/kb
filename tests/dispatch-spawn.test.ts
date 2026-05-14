import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSpawnInvocation,
  resolveExecutableCommand,
  shouldSpawnDetached,
} from '../packages/dispatch-core/src/spawn.js';

async function writeExecutableCommand(binDir: string, name: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const commandPath = join(binDir, process.platform === 'win32' ? `${name}.CMD` : name);
  await writeFile(
    commandPath,
    process.platform === 'win32'
      ? '@echo off\r\nexit /b 0\r\n'
      : '#!/bin/sh\nexit 0\n',
    'utf-8',
  );
  if (process.platform !== 'win32') {
    await chmod(commandPath, 0o755);
  }
  return commandPath;
}

describe('dispatch spawn invocation', () => {
  it('wraps Windows .cmd launchers through cmd.exe with quoted arguments', () => {
    expect(
      buildSpawnInvocation(
        'C:\\Program Files\\tools\\tsx.cmd',
        [
          'C:\\Users\\alice\\My Projects\\kb\\tests\\fixtures\\fake-agent.ts',
          'C:\\Users\\alice\\My Projects\\kb\\.agent-runs\\wrapper.md',
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
        '"C:\\Program Files\\tools\\tsx.cmd" "C:\\Users\\alice\\My Projects\\kb\\tests\\fixtures\\fake-agent.ts" "C:\\Users\\alice\\My Projects\\kb\\.agent-runs\\wrapper.md"',
      ],
      shell: false,
    });
  });

  it('leaves non-Windows launches unchanged', () => {
    expect(
      buildSpawnInvocation(
        '/usr/bin/tsx',
        ['/repo/tests/fixtures/fake-agent.ts'],
        'linux',
      ),
    ).toEqual({
      command: '/usr/bin/tsx',
      args: ['/repo/tests/fixtures/fake-agent.ts'],
      shell: false,
    });
  });

  it('does not detach child processes on Windows', () => {
    expect(shouldSpawnDetached('win32')).toBe(false);
    expect(shouldSpawnDetached('linux')).toBe(true);
  });

  it('resolves bare commands from PATH before spawning', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kb-spawn-resolution-'));
    try {
      const binDir = join(tempDir, 'bin');
      const commandPath = await writeExecutableCommand(binDir, 'kb-test-agent');

      const result = await resolveExecutableCommand('kb-test-agent', {
        env: {
          PATH: binDir,
          PATHEXT: '.CMD;.EXE',
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.command).toBe(commandPath);
      expect(result.data.source).toBe('path');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers the direct Claude executable over Windows npm shims', async () => {
    const result = await resolveExecutableCommand('claude', {
      platform: 'win32',
      env: {
        PATH: 'C:\\.npm-global',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      },
      fallbackDirs: [],
      isExecutable: async (candidate) => (
        candidate.toLowerCase() === 'c:\\.npm-global\\claude' ||
        candidate.toLowerCase() === 'c:\\.npm-global\\claude.cmd' ||
        candidate.toLowerCase() === 'c:\\.npm-global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
      ),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.command).toBe('C:\\.npm-global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
    expect(result.data.source).toBe('path');
  });

  it('resolves bare commands from fallback dirs when PATH is deficient', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kb-spawn-fallback-'));
    try {
      const fallbackDir = join(tempDir, 'fallback-bin');
      const commandPath = await writeExecutableCommand(fallbackDir, 'kb-fallback-agent');

      const result = await resolveExecutableCommand('kb-fallback-agent', {
        env: {
          PATH: '',
          PATHEXT: '.CMD',
        },
        fallbackDirs: [fallbackDir],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.command).toBe(commandPath);
      expect(result.data.source).toBe('fallback');
      expect(result.data.pathEntries).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('leaves path-bearing commands unchanged for existing absolute launcher configs', async () => {
    const command = process.platform === 'win32'
      ? 'C:\\Users\\alice\\projects\\kb\\node_modules\\.bin\\tsx.cmd'
      : '/home/alice/projects/kb/node_modules/.bin/tsx';

    const result = await resolveExecutableCommand(command, {
      env: {
        PATH: '',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.command).toBe(command);
    expect(result.data.source).toBe('as_provided');
    expect(result.data.searchedCandidates).toEqual([]);
  });

  it('returns a clear INVALID_AGENT diagnostic when a bare command cannot be resolved', async () => {
    const result = await resolveExecutableCommand('kb-missing-agent', {
      env: {
        PATH: '',
      },
      fallbackDirs: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('INVALID_AGENT');
    expect(result.message).toContain('kb-missing-agent');
    expect(result.message).toContain('PATH entries');
    expect(result.detail).toMatchObject({
      command: 'kb-missing-agent',
      pathEntries: [],
      fallbackDirs: [],
    });
  });
});

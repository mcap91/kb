import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const TSX = process.platform === 'win32'
  ? resolve(ROOT, 'node_modules/.bin/tsx.cmd')
  : resolve(ROOT, 'node_modules/.bin/tsx');
const CLI = resolve(ROOT, 'packages/wiki-cli/src/index.ts');

function runCli(args: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`"${TSX}" "${CLI}" ${args}`, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: (e.stdout ?? '') + (e.stderr ?? ''), exitCode: e.status ?? 1 };
  }
}

describe('CLI smoke tests', () => {
  it('--help exits 0 and prints help text', () => {
    const { stdout, exitCode } = runCli('--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('wiki');
    expect(stdout).toContain('bootstrap');
  });

  it('--version exits 0 and prints version', () => {
    const { stdout, exitCode } = runCli('--version');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('unknown command exits non-zero with error', () => {
    const { stdout, exitCode } = runCli('nonexistent');
    expect(exitCode).not.toBe(0);
    expect(stdout.toLowerCase()).toContain('unknown');
  });
});

describe('MCP smoke tests', () => {
  it('tools list is available from tools module', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    expect(tools).toBeInstanceOf(Array);
    expect(tools.length).toBeGreaterThan(0);
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain('bootstrap');
    expect(names).toContain('lint');
    expect(names).toContain('search');
    expect(names).toContain('create');
  });

  it('all tools have name, description, and handler', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('tool count matches expected operations', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    expect(tools.length).toBe(8);
  });
});

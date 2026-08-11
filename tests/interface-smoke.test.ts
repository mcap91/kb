import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
      windowsHide: true,
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
    expect(stdout).toContain('import-plan');
    expect(stdout).toContain('validate-plan');
    expect(stdout).toContain('archive-plan');
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
    expect(names).toContain('import-plan');
    expect(names).toContain('validate-plan');
    expect(names).toContain('archive-plan');
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
    expect(tools.length).toBe(13);
  });

  it('registers real tool schemas and passes tool arguments through MCP', async () => {
    const mcp = await import('@kb/wiki-mcp');

    expect(typeof mcp.createServer).toBe('function');
    if (typeof mcp.createServer !== 'function') {
      return;
    }

    const server = mcp.createServer();
    const client = new Client({ name: 'kb-test-client', version: '0.0.1' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const toolsResult = await client.listTools();
    const lintTool = toolsResult.tools.find(tool => tool.name === 'lint');

    expect(lintTool).toBeTruthy();
    expect(lintTool?.inputSchema.properties?.dir).toBeTruthy();
    expect(lintTool?.inputSchema.required).toContain('dir');

    // WK-0046 T15: tool-authority annotations are advertised on tools/list so an agent
    // can tell routine read tools from operator-setup tools without out-of-band knowledge.
    expect(lintTool?.annotations?.readOnlyHint).toBe(true);
    const bootstrapTool = toolsResult.tools.find(tool => tool.name === 'bootstrap');
    expect(bootstrapTool?.annotations?.readOnlyHint).toBe(false);
    expect((bootstrapTool?._meta as Record<string, unknown> | undefined)?.['io.kb/audience']).toBe('operator');

    const lintResult = await client.callTool({
      name: 'lint',
      arguments: {
        dir: resolve(ROOT, 'tests/fixtures/sample-repo'),
      },
    });
    const content = lintResult.content as Array<{ type: string; text?: string }> | undefined;

    expect(lintResult.isError).not.toBe(true);
    expect(content?.[0]?.type).toBe('text');

    if (content?.[0]?.type === 'text' && typeof content[0].text === 'string') {
      expect(JSON.parse(content[0].text)).toMatchObject({ ok: true });
    }

    await Promise.all([
      client.close(),
      server.close(),
    ]);
  });

  it('formats unexpected handler errors as a parseable envelope, not raw Error text', async () => {
    // WK-0046 T4: an unexpected throw inside a tool handler must surface as the same
    // { ok: false, error, message } envelope that core returns for handled failures,
    // so an agent can parse the failure instead of scraping a raw "Error: ..." string.
    const wiki = await import('@kb/wiki-mcp');
    const dispatch = await import('@kb/dispatch-mcp');

    for (const mod of [wiki, dispatch]) {
      const envelope = (mod as {
        toErrorEnvelope: (e: unknown) => { content: Array<{ type: string; text: string }>; isError: boolean };
      }).toErrorEnvelope(new Error('boom'));

      expect(envelope.isError).toBe(true);
      expect(envelope.content[0]?.type).toBe('text');
      expect(envelope.content[0]?.text).not.toMatch(/^Error: /);
      expect(JSON.parse(envelope.content[0]!.text)).toMatchObject({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'boom',
      });
    }
  });

  it('dispatch MCP tools are available from the dispatch-mcp package', async () => {
    const { tools } = await import('@kb/dispatch-mcp');
    expect(tools).toBeInstanceOf(Array);
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain('check-environment');
    expect(names).toContain('create-handoff');
    expect(names).toContain('review');
    expect(names).toContain('launch');
    expect(names).toContain('review-and-launch');
    expect(names).toContain('status');
    expect(names).toContain('cleanup');
    expect(names).toContain('wait-for-run');
    expect(names).toContain('get-response');
    expect(names).toHaveLength(10);
  });
});

/**
 * A kb-dispatch server whose loaded code differs from the checkout refuses acting tools
 * with `SERVER_STALE`.
 *
 * Drives the real server built by `createServer` through an MCP client over the SDK's
 * in-memory transport, with the source directories pointed at a small temporary tree.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../packages/dispatch-mcp/src/create-server.js';
import {
  DEFAULT_SRC_DIRS,
  fingerprintSources,
} from '../packages/dispatch-mcp/src/code-freshness.js';

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

interface SourceTree {
  root: string;
  srcDirs: string[];
  mutableFile: string;
}

async function makeSourceTree(): Promise<SourceTree> {
  const root = await makeTempDir('kb-stale-src-');
  const srcDirs = [
    join(root, 'packages', 'dispatch-mcp', 'src'),
    join(root, 'packages', 'dispatch-core', 'src'),
    join(root, 'packages', 'wiki-core', 'src'),
  ];
  for (const srcDir of srcDirs) await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDirs[0]!, 'one.ts'), 'export const one = 1;\n', 'utf8');
  await writeFile(join(srcDirs[1]!, 'two.ts'), 'export const two = 2;\n', 'utf8');
  await writeFile(join(srcDirs[2]!, 'three.ts'), 'export const three = 3;\n', 'utf8');
  return { root, srcDirs, mutableFile: join(srcDirs[0]!, 'one.ts') };
}

async function connect(srcDirs?: string[]): Promise<{ server: ReturnType<typeof createServer>; client: Client }> {
  const server = srcDirs ? createServer({ srcDirs }) : createServer();
  const client = new Client({ name: 'kb-stale-server-test', version: '0.0.1' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function parseBody(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

/** A superset of the required arguments of every registered tool. */
function callArgs(dir: string): Record<string, unknown> {
  return {
    dir,
    handoff: 'wiki/handoffs/HO-0001.md',
    handoff_id: 'HO-0001',
    run_id: 'RUN-00000000-0000-0000-0000-000000000000',
    subject: 'stale-server-test',
    allowed_agents: ['pi'],
  };
}

describe('kb-dispatch stale-server refusal', () => {
  // Why: the check must not block normal work when the loaded code is the code on disk.
  it('runs an acting handler and reports status as fresh when the source tree is unchanged', async () => {
    const emptyDir = await makeTempDir('kb-stale-empty-');
    const tree = await makeSourceTree();
    const { server, client } = await connect(tree.srcDirs);
    try {
      const handoff = parseBody(await client.callTool({ name: 'create-handoff', arguments: callArgs(emptyDir) }));
      expect(typeof handoff.error).toBe('string');
      expect(handoff.error).not.toBe('SERVER_STALE');

      const status = parseBody(await client.callTool({ name: 'status', arguments: { dir: emptyDir } }));
      const serverMeta = status.server as Record<string, unknown>;
      expect(serverMeta.stale).toBe(false);
      expect(serverMeta.loaded_fingerprint).toBe(serverMeta.current_fingerprint);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  // Why: a merge or uncommitted edit makes the loaded code older than disk; every acting tool must stop.
  it('refuses every acting tool with SERVER_STALE once one source byte changes', async () => {
    const emptyDir = await makeTempDir('kb-stale-empty-');
    const tree = await makeSourceTree();
    const { server, client } = await connect(tree.srcDirs);
    try {
      await writeFile(tree.mutableFile, 'export const one = 2;\n', 'utf8');

      const status = parseBody(await client.callTool({ name: 'status', arguments: { dir: emptyDir } }));
      const serverMeta = status.server as Record<string, unknown>;
      const loadedPrefix = String(serverMeta.loaded_fingerprint).slice(0, 12);
      const currentPrefix = String(serverMeta.current_fingerprint).slice(0, 12);

      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain('create-handoff');
      for (const name of names) {
        if (name === 'status' || name === 'stop-run') continue;
        const body = parseBody(await client.callTool({ name, arguments: callArgs(emptyDir) }));
        expect(body, name).toMatchObject({ ok: false, error: 'SERVER_STALE' });
      }

      const refused = await client.callTool({ name: 'create-handoff', arguments: callArgs(emptyDir) });
      expect(refused.isError).not.toBe(true);
      const message = String(parseBody(refused).message);
      expect(message).toContain(loadedPrefix);
      expect(message).toContain(currentPrefix);
      expect(message).toContain('restart');

      // The handler never ran, so nothing was written into the otherwise-empty temp dir.
      expect(existsSync(join(emptyDir, 'wiki'))).toBe(false);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  // Why: a stale session must still see and stop its runs, so status and stop-run stay exempt.
  it('keeps status and stop-run working while stale', async () => {
    const emptyDir = await makeTempDir('kb-stale-empty-');
    const tree = await makeSourceTree();
    const { server, client } = await connect(tree.srcDirs);
    try {
      await writeFile(tree.mutableFile, 'export const one = 9;\n', 'utf8');

      const status = parseBody(await client.callTool({ name: 'status', arguments: { dir: emptyDir } }));
      const serverMeta = status.server as Record<string, unknown>;
      expect(serverMeta.stale).toBe(true);
      expect(serverMeta.loaded_fingerprint).not.toBe(serverMeta.current_fingerprint);

      const stop = parseBody(await client.callTool({ name: 'stop-run', arguments: callArgs(emptyDir) }));
      expect(stop.error).not.toBe('SERVER_STALE');
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  // Why: a read failure must never pass silently; a dangling symlink fails for any user id.
  it('refuses with SERVER_STALE naming the path when a source file cannot be read', async () => {
    const emptyDir = await makeTempDir('kb-stale-empty-');
    const tree = await makeSourceTree();
    const { server, client } = await connect(tree.srcDirs);
    try {
      const dangling = join(tree.srcDirs[0]!, 'dangling.ts');
      await symlink(join(tree.root, 'missing-target.ts'), dangling);

      const body = parseBody(await client.callTool({ name: 'create-handoff', arguments: callArgs(emptyDir) }));
      expect(body.error).toBe('SERVER_STALE');
      expect(String(body.message)).toContain(dangling);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  // Why: with no argument the server must fingerprint the real trees it actually loaded.
  it('fingerprints the three real source directories, including create-server.ts', () => {
    for (const dir of DEFAULT_SRC_DIRS) expect(existsSync(dir)).toBe(true);

    const { fingerprint, files } = fingerprintSources();
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(files).toContain('packages/dispatch-mcp/src/create-server.ts');
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ok, fail, type Result } from './errors.js';
import { findKbRoot } from './contract.js';
import { debug } from './debug.js';

type McpClient = 'claude' | 'codex' | 'none';

interface McpConfigResult {
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  path?: string;
  commands?: string[];
}

interface WriteMcpConfigOpts {
  client: McpClient;
  dryRun?: boolean;
}

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function resolveKbPaths(): { loaderUrl: string; wikiServer: string; dispatchServer: string } {
  const kbRoot = findKbRoot();
  const loaderPath = path.join(kbRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const loaderUrl = pathToFileURL(loaderPath).href;
  const wikiServer = toForwardSlashes(path.join(kbRoot, 'packages', 'wiki-mcp', 'src', 'server.ts'));
  const dispatchServer = toForwardSlashes(path.join(kbRoot, 'packages', 'dispatch-mcp', 'src', 'server.ts'));
  return { loaderUrl, wikiServer, dispatchServer };
}

function buildServerEntry(loaderUrl: string, serverPath: string): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'node',
    args: ['--import', loaderUrl, serverPath],
    env: {},
  };
}

export function writeMcpConfig(
  targetDir: string,
  opts: WriteMcpConfigOpts,
): Result<McpConfigResult> {
  const { client, dryRun = false } = opts;

  if (client === 'none') {
    debug('mcp config: skipped (client=none)');
    return ok({ action: 'skipped' });
  }

  const { loaderUrl, wikiServer, dispatchServer } = resolveKbPaths();

  if (client === 'codex') {
    const commands = [
      `codex mcp add kb-wiki -- node --import ${loaderUrl} ${wikiServer}`,
      `codex mcp add kb-dispatch -- node --import ${loaderUrl} ${dispatchServer}`,
    ];
    debug('mcp config: codex commands generated');
    return ok({ action: 'skipped', commands });
  }

  // client === 'claude'
  const configPath = path.join(targetDir, '.mcp.json');
  const wikiEntry = buildServerEntry(loaderUrl, wikiServer);
  const dispatchEntry = buildServerEntry(loaderUrl, dispatchServer);

  let config: Record<string, unknown>;

  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      return fail('MCP_CONFIG_PARSE_ERROR', `Failed to parse existing .mcp.json: ${String(err)}`, err);
    }
  } else {
    config = {};
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  servers['kb-wiki'] = wikiEntry;
  servers['kb-dispatch'] = dispatchEntry;

  const newContent = JSON.stringify(config, null, 2) + '\n';

  if (fs.existsSync(configPath)) {
    const existing = fs.readFileSync(configPath, 'utf-8');
    if (existing === newContent) {
      debug('mcp config: unchanged');
      return ok({ action: 'unchanged', path: configPath });
    }
    if (!dryRun) {
      fs.writeFileSync(configPath, newContent, 'utf-8');
    }
    debug('mcp config: updated');
    return ok({ action: 'updated', path: configPath });
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, newContent, 'utf-8');
  }
  debug('mcp config: created');
  return ok({ action: 'created', path: configPath });
}

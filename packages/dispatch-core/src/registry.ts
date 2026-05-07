import { access, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { agentRegistrySchema } from './schemas.js';
import type { AgentLauncherConfig, AgentRegistry, HandoffMode, InitConfigResult } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { ensureConfigDirs, getConfigDir } from './paths.js';
import { generateKey } from './token.js';

const REGISTRY_FILE = 'launchers.v1.json';
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const KB_ROOT = resolve(THIS_DIR, '..', '..', '..');

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function looksLikeLegacyRegistry(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value['agents'])) {
    return false;
  }

  return Object.values(value['agents']).some((agent) => {
    if (!isRecord(agent)) {
      return false;
    }
    return typeof agent['command'] === 'string' || Array.isArray(agent['args']);
  });
}

function getTsxBinaryPath(): string {
  return join(
    KB_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
}

function getFakeAgentFixturePath(): string {
  return join(KB_ROOT, 'tests', 'fixtures', 'fake-agent.ts');
}

export function getRegistryPath(): string {
  return join(getConfigDir(), REGISTRY_FILE);
}

export function createDefaultRegistry(): AgentRegistry {
  return {
    version: 1,
    agents: {
      claude: {
        base_argv: ['claude'],
        noninteractive_argv: ['--print', '--output-format', 'text', '--no-session-persistence'],
        instruction_transport: { kind: 'argv_content' },
        wrapper_arg: ['{wrapper_content}'],
        response_transport: { kind: 'stdout_capture' },
        timeout_seconds: 1800,
        read_only: {
          supported: true,
          argv_suffix: [
            '--permission-mode',
            'default',
            '--disallowedTools',
            'Edit Write NotebookEdit Bash',
          ],
          response_writable: true,
        },
        description: 'Claude Code CLI adapter',
      },
      codex: {
        base_argv: ['codex', 'exec'],
        noninteractive_argv: [],
        instruction_transport: { kind: 'argv_content' },
        wrapper_arg: ['{wrapper_content}'],
        response_transport: { kind: 'file' },
        response_arg: ['-o', '{response_path}'],
        timeout_seconds: 1800,
        read_only: {
          supported: true,
          argv_suffix: ['--sandbox', 'read-only'],
          response_writable: true,
        },
        description: 'Codex CLI adapter',
      },
      'fake-agent': {
        base_argv: [getTsxBinaryPath(), getFakeAgentFixturePath()],
        noninteractive_argv: [],
        instruction_transport: { kind: 'argv_content' },
        wrapper_arg: ['{wrapper_content}'],
        response_transport: { kind: 'file' },
        response_arg: [],
        timeout_seconds: 30,
        read_only: {
          supported: true,
          argv_suffix: [],
          response_writable: true,
        },
        description: 'Deterministic test agent for dogfooding and sister-repo validation',
      },
    },
  };
}

export async function initConfig(force = false): Promise<DispatchResult<InitConfigResult>> {
  const configDir = await ensureConfigDirs();
  const keyPath = join(configDir, 'token.key');
  const registryPath = getRegistryPath();

  let keyCreated = false;
  try {
    await access(keyPath);
  } catch {
    await generateKey();
    keyCreated = true;
  }

  let registryCreated = false;
  if (force) {
    const registry = createDefaultRegistry();
    await writeFile(registryPath, JSON.stringify(registry, null, 2));
    registryCreated = true;
  } else {
    try {
      await access(registryPath);
    } catch {
      const registry = createDefaultRegistry();
      await writeFile(registryPath, JSON.stringify(registry, null, 2));
      registryCreated = true;
    }
  }

  return ok({
    configDir,
    keyPath,
    registryPath,
    keyCreated,
    registryCreated,
  });
}

export async function loadRegistry(): Promise<DispatchResult<{ path: string; hash: string; data: AgentRegistry }>> {
  const registryPath = getRegistryPath();
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf-8');
  } catch {
    return fail(
      'REGISTRY_NOT_FOUND',
      `Agent registry not found at ${registryPath}. Run init-config first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('PARSE_ERROR', `Failed to parse agent registry at ${registryPath}.`);
  }

  const result = agentRegistrySchema.safeParse(parsed);
  if (!result.success) {
    const upgradeHint = looksLikeLegacyRegistry(parsed)
      ? ' Detected a legacy launcher schema. Run `npm run dispatch -- init-config --force` to rewrite launchers.v1.json with the current adapter format.'
      : ' If this file came from an older kb dispatch version, run `npm run dispatch -- init-config --force` to rewrite it with the current adapter format.';
    return fail(
      'PARSE_ERROR',
      `Invalid agent registry format at ${registryPath}.${upgradeHint}`,
      result.error,
    );
  }

  return ok({
    path: registryPath,
    hash: hashText(raw),
    data: result.data as AgentRegistry,
  });
}

export function resolveAgentConfig(
  registry: AgentRegistry,
  agentName: string,
  mode: HandoffMode,
): DispatchResult<AgentLauncherConfig> {
  const agent = registry.agents[agentName];
  if (!agent) {
    return fail('INVALID_AGENT', `Unknown agent in registry: ${agentName}`);
  }

  if (agent.instruction_transport.kind !== 'stdin' && !Array.isArray(agent.wrapper_arg)) {
    return fail('INVALID_AGENT', `Agent ${agentName} must declare wrapper_arg for ${agent.instruction_transport.kind}.`);
  }

  if (agent.response_transport.kind === 'file' && !Array.isArray(agent.response_arg)) {
    return fail('INVALID_AGENT', `Agent ${agentName} must declare response_arg for file transport.`);
  }

  if (mode === 'redteam') {
    const readOnly = agent.read_only;
    if (
      !readOnly?.supported ||
      !Array.isArray(readOnly.argv_suffix) ||
      readOnly.argv_suffix.length === 0 ||
      readOnly.response_writable !== true
    ) {
      return fail('INVALID_AGENT', `Agent ${agentName} does not satisfy redteam read-only requirements.`);
    }
  }

  return ok(agent);
}

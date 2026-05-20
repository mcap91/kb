import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type {
  AgentRegistry,
  CheckEnvironmentResult,
  EnvironmentCapability,
  EnvironmentCapabilityStatus,
  HandoffMode,
  HostCapabilitiesRecord,
} from './types.js';
import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import { ensureConfigDirs, getConfigDir, getHostCapabilitiesPath } from './paths.js';
import { loadRegistry, resolveAgentConfig } from './registry.js';
import { resolveExecutableCommand } from './spawn.js';

type CapabilityName = keyof HostCapabilitiesRecord['capabilities'];

function makeCapability(
  status: EnvironmentCapabilityStatus,
  detail: string,
  checkedAt: string,
): EnvironmentCapability {
  return {
    status,
    checked_at: checkedAt,
    detail,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function buildProbeEnv(extraEnv?: Record<string, string>): Record<string, string | undefined> {
  return {
    ...process.env,
    ...extraEnv,
  };
}

async function runProcess(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      resolvePromise({
        code: 1,
        stdout,
        stderr: `${stderr}${String(err)}`,
      });
    });

    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function probeLinuxBwrap(
  extraEnv: Record<string, string> | undefined,
  mode: 'basic' | 'bind_rw',
): Promise<{ status: EnvironmentCapabilityStatus; detail: string }> {
  const env = buildProbeEnv(extraEnv);
  const resolution = await resolveExecutableCommand('bwrap', { env });
  if (!resolution.ok) {
    return {
      status: 'unsupported',
      detail: resolution.message,
    };
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'kb-bwrap-probe-'));
  const probeFile = join(tempRoot, 'probe.txt');

  try {
    const script = mode === 'bind_rw'
      ? `require('node:fs').writeFileSync(${JSON.stringify(probeFile)}, 'ok', 'utf-8');`
      : 'process.exit(0);';
    const args = [
      '--die-with-parent',
      '--unshare-all',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      ...(mode === 'bind_rw' ? ['--bind', tempRoot, tempRoot] : []),
      process.execPath,
      '-e',
      script,
    ];
    const result = await runProcess(resolution.data.command, args, env);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `bwrap probe exited with code ${result.code}.`;
      return {
        status: 'unsupported',
        detail,
      };
    }

    if (mode === 'bind_rw' && !(await pathExists(probeFile))) {
      return {
        status: 'unsupported',
        detail: 'bwrap probe exited 0 but did not create the expected writable probe file.',
      };
    }

    return {
      status: 'supported',
      detail: mode === 'bind_rw'
        ? 'bubblewrap started and allowed an additional writable bind mount.'
        : 'bubblewrap started successfully.',
    };
  } catch (err) {
    return {
      status: 'unknown',
      detail: `bwrap probe threw unexpectedly: ${String(err)}`,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function buildHostCapabilitiesRecord(
  registry: AgentRegistry,
  registryHash: string,
): Promise<HostCapabilitiesRecord> {
  const checkedAt = new Date().toISOString();
  const notApplicable = (detail: string): EnvironmentCapability => makeCapability('not_applicable', detail, checkedAt);
  const capabilities: HostCapabilitiesRecord['capabilities'] = {
    claude_linux_sandbox: notApplicable('Linux bubblewrap probing is not required on this platform.'),
    claude_linux_add_dir: notApplicable('Linux bubblewrap add-dir probing is not required on this platform.'),
    codex_linux_sandbox: notApplicable('Linux bubblewrap probing is not required on this platform.'),
  };

  if (process.platform === 'linux') {
    const claudeConfig = resolveAgentConfig(registry, 'claude', 'implement');
    const codexConfig = resolveAgentConfig(registry, 'codex', 'implement');
    const basicProbe = await probeLinuxBwrap(codexConfig.ok ? codexConfig.data.env : undefined, 'basic');
    const bindProbe = await probeLinuxBwrap(claudeConfig.ok ? claudeConfig.data.env : undefined, 'bind_rw');
    capabilities.claude_linux_sandbox = makeCapability(
      basicProbe.status,
      basicProbe.detail,
      checkedAt,
    );
    capabilities.claude_linux_add_dir = makeCapability(
      bindProbe.status,
      bindProbe.detail,
      checkedAt,
    );
    capabilities.codex_linux_sandbox = makeCapability(
      basicProbe.status,
      basicProbe.detail,
      checkedAt,
    );
  }

  return {
    schema_version: 1,
    checked_at: checkedAt,
    platform: process.platform,
    arch: process.arch,
    registry_hash: registryHash,
    capabilities,
  };
}

async function readCapabilitiesRecord(): Promise<HostCapabilitiesRecord | null> {
  try {
    return JSON.parse(await readFile(getHostCapabilitiesPath(), 'utf-8')) as HostCapabilitiesRecord;
  } catch {
    return null;
  }
}

export async function ensureHostCapabilities(
  registry: AgentRegistry,
  registryHash: string,
): Promise<DispatchResult<HostCapabilitiesRecord>> {
  const existing = await readCapabilitiesRecord();
  if (
    existing &&
    existing.schema_version === 1 &&
    existing.registry_hash === registryHash &&
    existing.platform === process.platform &&
    existing.arch === process.arch
  ) {
    return ok(existing);
  }

  const record = await buildHostCapabilitiesRecord(registry, registryHash);
  try {
    await ensureConfigDirs();
    await writeJson(getHostCapabilitiesPath(), record);
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write host capabilities record to ${getHostCapabilitiesPath()}.`, err);
  }
  return ok(record);
}

function capabilityFailure(
  record: HostCapabilitiesRecord,
  capabilityName: CapabilityName,
  message: string,
): DispatchResult<void> {
  const capability = record.capabilities[capabilityName];
  if (capability.status !== 'unsupported') {
    return ok(undefined);
  }

  return fail('ENVIRONMENT_UNSUPPORTED', `${message} ${capability.detail}`, {
    capability: capabilityName,
    checkedAt: record.checked_at,
    recordPath: getHostCapabilitiesPath(),
  });
}

export function gateLaunchEnvironment(
  record: HostCapabilitiesRecord,
  agentName: string,
  mode: HandoffMode,
  requiresAdditionalDirectories: boolean,
): DispatchResult<void> {
  if (agentName === 'codex' && process.platform === 'linux') {
    return capabilityFailure(
      record,
      'codex_linux_sandbox',
      'Codex launch is blocked because this host cannot start the required Linux sandbox.',
    );
  }

  if (agentName === 'claude' && process.platform === 'linux') {
    const basic = capabilityFailure(
      record,
      'claude_linux_sandbox',
      'Claude launch is blocked because this host cannot start the required Linux sandbox.',
    );
    if (!basic.ok) {
      return basic;
    }

    if (mode !== 'redteam' && requiresAdditionalDirectories) {
      return capabilityFailure(
        record,
        'claude_linux_add_dir',
        'Claude launch is blocked because this host cannot support the required additional-directory sandbox mounts.',
      );
    }
  }

  return ok(undefined);
}

export async function checkEnvironment(): Promise<DispatchResult<CheckEnvironmentResult>> {
  const registryResult = await loadRegistry();
  if (!registryResult.ok) {
    return registryResult;
  }

  const recordResult = await ensureHostCapabilities(registryResult.data.data, registryResult.data.hash);
  if (!recordResult.ok) {
    return recordResult;
  }

  return ok({
    configDir: getConfigDir(),
    recordPath: getHostCapabilitiesPath(),
    record: recordResult.data,
  });
}

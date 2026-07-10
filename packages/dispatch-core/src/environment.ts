import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import type {
  AgentRegistry,
  CheckEnvironmentResult,
  ContainerDetection,
  EnvironmentCapability,
  EnvironmentCapabilityStatus,
  EnvironmentWritability,
  GateDecision,
  HandoffMode,
  HostCapabilitiesRecord,
  RouteVerdict,
  RouteViability,
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
      windowsHide: true,
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

// ---------------------------------------------------------------------------
// Container detection + writability facts (informational; not gating inputs)
// ---------------------------------------------------------------------------

const CGROUP_CONTAINER_PATTERN = /docker|kubepods|containerd|libpod|lxc/;

/**
 * Detect container signals: `KUBERNETES_SERVICE_HOST`, `/.dockerenv`, and the
 * first line of `/proc/1/cgroup`. Facts only — MVP gating never keys off these.
 */
export async function detectContainer(): Promise<ContainerDetection> {
  const kubernetesServiceHost = Boolean(process.env['KUBERNETES_SERVICE_HOST']);
  const dockerenv = await pathExists('/.dockerenv');

  let cgroupHint: string | null = null;
  try {
    const cgroup = await readFile('/proc/1/cgroup', 'utf-8');
    cgroupHint = cgroup.split('\n')[0]?.trim() || null;
  } catch {
    cgroupHint = null;
  }
  const cgroupIndicatesContainer = cgroupHint !== null && CGROUP_CONTAINER_PATTERN.test(cgroupHint);

  return {
    detected: kubernetesServiceHost || dockerenv || cgroupIndicatesContainer,
    kubernetes_service_host: kubernetesServiceHost,
    dockerenv,
    cgroup_hint: cgroupHint,
  };
}

function resolveHomePath(): string | null {
  if (process.platform === 'win32') {
    return process.env['USERPROFILE'] ?? null;
  }
  return process.env['HOME'] ?? null;
}

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report whether a path can be written or created, by walking up to the nearest
 * existing ancestor and testing its writability. This mirrors what the token
 * lifecycle needs (mkdir the config store, then write into it).
 */
async function isCreatable(target: string): Promise<boolean> {
  let current = target;
  for (;;) {
    if (await pathExists(current)) {
      return isWritable(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/** Probe HOME and resolved-config-dir writability (the ro-HOME pod blocker). */
export async function probeWritability(): Promise<{
  home: EnvironmentWritability;
  config_dir: EnvironmentWritability;
}> {
  const homePath = resolveHomePath();
  const home: EnvironmentWritability = homePath === null
    ? { path: null, writable: false, detail: 'HOME is not set.' }
    : { path: homePath, writable: await isWritable(homePath), detail: `HOME resolved to ${homePath}.` };

  let configDirPath: string;
  try {
    configDirPath = getConfigDir();
  } catch (err) {
    return {
      home,
      config_dir: { path: null, writable: false, detail: `Config directory could not be resolved: ${String(err)}` },
    };
  }

  const configWritable = await isCreatable(configDirPath);
  return {
    home,
    config_dir: {
      path: configDirPath,
      writable: configWritable,
      detail: configWritable
        ? `Config store ${configDirPath} is writable.`
        : `Config store ${configDirPath} is not writable; set XDG_CONFIG_HOME to a writable directory.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Launch environment gate
// ---------------------------------------------------------------------------

/**
 * Decide whether a reviewed launch may proceed on this host, and surface any
 * non-blocking advisories.
 *
 * Keyed off `record.platform` (not the live process platform) so the decision
 * is a pure function of the persisted capability record — unit-testable on any
 * host. In production `ensureHostCapabilities` guarantees the record matches the
 * current platform, so behavior is unchanged.
 *
 * - `redteam`: unchanged — fails closed when the kernel sandbox cannot start.
 * - non-`redteam`: no hard stops from bwrap probe results for any agent. Codex
 *   is never gated on a bwrap probe (it uses Landlock). Headless claude does not
 *   hard-require bwrap. When claude has a non-empty write_scope and the add-dir
 *   bind-mount probe is `unsupported`, the launch proceeds (still passing
 *   `--add-dir`) with a warning that enforcement is app-level only.
 */
export function gateLaunchEnvironment(
  record: HostCapabilitiesRecord,
  agentName: string,
  mode: HandoffMode,
  requiresAdditionalDirectories: boolean,
): DispatchResult<GateDecision> {
  const isLinuxHost = record.platform === 'linux';

  if (mode === 'redteam') {
    if (agentName === 'codex' && isLinuxHost) {
      const gate = capabilityFailure(
        record,
        'codex_linux_sandbox',
        'Codex launch is blocked because this host cannot start the required Linux sandbox.',
      );
      if (!gate.ok) return gate;
    }

    if (agentName === 'claude' && isLinuxHost) {
      const gate = capabilityFailure(
        record,
        'claude_linux_sandbox',
        'Claude launch is blocked because this host cannot start the required Linux sandbox.',
      );
      if (!gate.ok) return gate;
    }

    return ok({ warnings: [] });
  }

  const warnings: string[] = [];
  if (
    agentName === 'claude'
    && requiresAdditionalDirectories
    && record.capabilities.claude_linux_add_dir.status === 'unsupported'
  ) {
    warnings.push(
      'write_scope directories are app-level enforced only on this host: '
      + 'bubblewrap could not start, so --add-dir grants are not backed by a kernel sandbox. '
      + `Probe detail: ${record.capabilities.claude_linux_add_dir.detail}`,
    );
  }

  return ok({ warnings });
}

// ---------------------------------------------------------------------------
// Route-viability verdicts (derived, not persisted)
// ---------------------------------------------------------------------------

/**
 * Derive a plain per-route verdict from host-capability facts, so
 * `check-environment` can answer "what can dispatch do on this box" as the
 * first command on any new host.
 */
export function deriveRouteVerdicts(record: HostCapabilitiesRecord): RouteVerdict[] {
  const isLinux = record.platform === 'linux';
  const caps = record.capabilities;
  const configWritable = record.writability?.config_dir.writable ?? true;
  const configPath = record.writability?.config_dir.path ?? getConfigDir();
  const configHint = `Config store ${configPath} is not writable — the token/review/launch lifecycle cannot run here. `
    + 'Set XDG_CONFIG_HOME to a writable directory and re-run.';

  const verdicts: RouteVerdict[] = [];

  verdicts.push({
    route: 'plain-adapters',
    viability: configWritable ? 'available' : 'blocked',
    detail: configWritable
      ? 'Plain-process adapters (fake-agent, ollama, custom wrappers) need no kernel sandbox and run wherever Node runs and the config store is writable.'
      : configHint,
  });

  verdicts.push({
    route: 'claude-headless',
    viability: !configWritable ? 'blocked' : 'available',
    detail: !configWritable
      ? configHint
      : isLinux
        ? 'Headless claude --print does not require bubblewrap; an empty-write_scope run launches even where bubblewrap fails.'
        : 'Headless claude --print launches; kernel-sandbox probing is not applicable on this platform.',
  });

  const addDir = caps.claude_linux_add_dir.status;
  let wsViability: RouteViability;
  let wsDetail: string;
  if (addDir === 'supported') {
    wsViability = 'available';
    wsDetail = 'write_scope --add-dir grants are kernel-enforced (bubblewrap bind mounts available).';
  } else if (addDir === 'unsupported') {
    wsViability = 'degraded';
    wsDetail = 'write_scope --add-dir grants are app-level only here (bubblewrap unavailable): directories are still passed to the agent but not backed by a kernel sandbox.';
  } else {
    wsViability = 'unknown';
    wsDetail = 'write_scope enforcement not probed on this platform; --add-dir is applied at the agent application level.';
  }
  verdicts.push({ route: 'write_scope-enforcement', viability: wsViability, detail: wsDetail });

  verdicts.push({
    route: 'codex',
    viability: !configWritable ? 'blocked' : 'unknown',
    detail: !configWritable
      ? configHint
      : 'Codex sandboxes with Landlock, not bubblewrap; kb does not probe Landlock (parked). Non-redteam launches are no longer gated on a bubblewrap probe — run `codex exec` to confirm viability on this host.',
  });

  let rtViability: RouteViability;
  let rtDetail: string;
  if (!configWritable) {
    rtViability = 'blocked';
    rtDetail = configHint;
  } else if (isLinux) {
    if (caps.claude_linux_sandbox.status === 'unsupported') {
      rtViability = 'blocked';
      rtDetail = 'Redteam fails closed: this host cannot start the bubblewrap kernel sandbox. App-level read-only is deliberately not accepted for redteam.';
    } else {
      rtViability = 'available';
      rtDetail = 'Redteam gating unchanged; this host can start the kernel sandbox.';
    }
  } else {
    rtViability = 'available';
    rtDetail = 'Redteam read-only is enforced via --disallowedTools at the app level; the bubblewrap gate is not applicable on this platform.';
  }
  verdicts.push({ route: 'redteam', viability: rtViability, detail: rtDetail });

  return verdicts;
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

  // Container-detection and writability facts are cheap and host-current, so
  // refresh them on every check (the bwrap probe results stay cached). Persisting
  // the merged record is best-effort: a report is still returned if the store
  // cannot be rewritten.
  const container = await detectContainer();
  const writability = await probeWritability();
  const record: HostCapabilitiesRecord = { ...recordResult.data, container, writability };

  try {
    await writeJson(getHostCapabilitiesPath(), record);
  } catch {
    // A report is still valid without a fresh persist; verdicts reflect the facts in-memory.
  }

  return ok({
    configDir: getConfigDir(),
    recordPath: getHostCapabilitiesPath(),
    record,
    verdicts: deriveRouteVerdicts(record),
  });
}

import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

import type {
  CheckEnvironmentResult,
  ContainerDetection,
  EnvironmentWritability,
  RouteVerdict,
} from './types.js';
import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';
import { getConfigDir } from './paths.js';
import { APPARMOR_REMEDIATION_TEXT, MISSING_BWRAP_TEXT, probeBwrap, type BwrapProbeResult } from './tier.js';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runProcess(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs?: number,
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
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolvePromise({
          code: 1,
          stdout,
          stderr: `${stderr}\nProcess timeout: exceeded ${timeoutMs}ms and was killed.`,
        });
      }, timeoutMs);
    }

    child.stdout?.on('error', () => { /* swallow — exit/close path handles cleanup */ });
    child.stderr?.on('error', () => { /* swallow — exit/close path handles cleanup */ });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        code: 1,
        stdout,
        stderr: `${stderr}${String(err)}`,
      });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
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
 * existing ancestor and testing its writability.
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
// Route-viability verdicts (derived, not persisted)
// ---------------------------------------------------------------------------

/**
 * Derive the dispatch route verdict from the bwrap probe (WK-0134 / WK-0133 D1).
 *
 * v2 gates every dispatch — any agent family, any mode — on ONE fact: does bwrap
 * work end-to-end (`tier.ts probeBwrap()`)? `pipeline.ts:650` runs the identical
 * probe at dispatch time and refuses with `NO_ISOLATION_ROUTE` when it fails; this
 * mirrors that exact gate so `check-environment` reports what a real dispatch will
 * do, not a v1 per-family/per-mode approximation of it.
 */
export function deriveRouteVerdicts(bwrap: BwrapProbeResult): RouteVerdict[] {
  if (bwrap.available) {
    return [{
      route: 'dispatch',
      viability: 'available',
      detail: 'bubblewrap is available with a working --unshare-user; the v2 pipeline can dispatch any agent family.',
    }];
  }

  const remediation = bwrap.bwrapVersion === null ? MISSING_BWRAP_TEXT : APPARMOR_REMEDIATION_TEXT;
  return [{
    route: 'dispatch',
    viability: 'blocked',
    detail: `No isolation route: dispatch will refuse with NO_ISOLATION_ROUTE. ${remediation}`,
  }];
}

// ---------------------------------------------------------------------------
// check-environment (WK-0134 / WK-0133 D1 option b): a thin stateless probe.
// No registry, no persisted host-capabilities.json, no config dir dependency
// beyond the informational writability check below.
// ---------------------------------------------------------------------------

export async function checkEnvironment(): Promise<DispatchResult<CheckEnvironmentResult>> {
  const checkedAt = new Date().toISOString();
  const [bwrap, container, writability] = await Promise.all([
    probeBwrap(),
    detectContainer(),
    probeWritability(),
  ]);

  return ok({
    checkedAt,
    platform: process.platform,
    arch: process.arch,
    bwrap,
    container,
    writability,
    verdicts: deriveRouteVerdicts(bwrap),
  });
}

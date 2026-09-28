import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

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
import { SYSTEM_ROOTS } from './jail.js';
import { execBash } from './exec-direct.js';
import { attachStreamErrorHandlers } from './stream-utils.js';

/**
 * Per-backend CLI reachability fact (WK-0174 / SRC-0013): does `command -v
 * <cli>` resolve to a path under a mountable root ($HOME or SYSTEM_ROOTS)?
 * Mirrors the exact mountability rule `pipeline.ts`'s `resolveToolchainPaths`
 * gates a real dispatch on. Declared here (not types.ts, out of this WK's
 * write scope) and merged onto `CheckEnvironmentResult` via the module
 * augmentation below — interface declaration merging applies at the
 * type-program level regardless of which module a consumer imports from.
 */
export interface CliReachability {
  family: string;
  cli: string;
  /** Real (readlink -f'd) resolved path, or null if the CLI is not on PATH. */
  resolvedPath: string | null;
  /** True when `resolvedPath` is under $HOME or a SYSTEM_ROOTS entry. */
  mountable: boolean;
  detail: string;
}

declare module './types.js' {
  interface CheckEnvironmentResult {
    /** Per-backend CLI reachability probes (WK-0174). */
    cliReachability: CliReachability[];
  }
}

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

    attachStreamErrorHandlers(child.stdout, child.stderr);
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
// Per-backend CLI reachability (WK-0174 / SRC-0013): does `command -v <cli>`
// resolve to a path under a mountable root ($HOME or SYSTEM_ROOTS)? Mirrors
// the exact mountability rule pipeline.ts's `resolveToolchainPaths` gates a
// real dispatch on, so check-environment reports what a real dispatch will
// do rather than a `--ro-bind / /` approximation of it (tier.ts's
// `probeUnshareUser` fix above closes the matching gap for the bwrap round
// trip itself).
// ---------------------------------------------------------------------------

const CLI_BACKENDS: ReadonlyArray<{ family: string; cli: string }> = [
  { family: 'claude', cli: 'claude' },
  { family: 'codex', cli: 'codex' },
  { family: 'pi', cli: 'pi' },
];

const execFileAsync = promisify(execFileCb);

/** Path-boundary-safe: `root` itself, or a real path segment under it — `/usrlocal/bin` must NOT match `/usr`. */
function isMountablePath(path: string, home: string | null): boolean {
  if (home !== null && home.length > 0 && (path === home || path.startsWith(`${home}/`))) return true;
  return SYSTEM_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

type NamespaceReachability = 'reachable' | 'unreachable' | 'bwrap-unavailable';

/**
 * Probe whether `command -v <cli>` succeeds INSIDE a bwrap namespace built
 * from the exact curated SYSTEM_ROOTS binds jail.ts uses (WK-0174 review F1,
 * AC2) — not a host-side `command -v` string check, and not a whole-root
 * `--ro-bind / /` approximation (that shape can't catch a CLI genuinely
 * missing from the curated jail). Mirrors tier.ts's `probeUnshareUser`
 * exec pattern. `command` is a shell builtin, not an executable, so the
 * in-jail invocation runs it through `sh -c`.
 */
async function probeCliInNamespace(cli: string): Promise<NamespaceReachability> {
  try {
    await execFileAsync('bwrap', [
      '--unshare-user',
      ...SYSTEM_ROOTS.flatMap((r) => ['--ro-bind-try', r, r]),
      '--proc', '/proc',
      '--dev', '/dev',
      'sh', '-c', `command -v ${cli}`,
    ]);
    return 'reachable';
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return code === 'ENOENT' ? 'bwrap-unavailable' : 'unreachable';
  }
}

/**
 * Resolve one backend's CLI via `command -v` + `readlink -f` on the host
 * (diagnostics only) and classify mountability by actually probing
 * reachability inside a curated-SYSTEM_ROOTS bwrap namespace.
 */
async function probeOneCliReachability(family: string, cli: string, home: string | null): Promise<CliReachability> {
  const whichResult = await execBash({ scriptContent: `command -v ${cli} 2>/dev/null`, timeoutMs: 5000 });
  const whichPath = whichResult.ok ? whichResult.data.stdout.trim() : '';
  let resolvedPath: string | null = null;
  if (whichPath.length > 0) {
    const realResult = await execBash({ scriptContent: `readlink -f ${whichPath} 2>/dev/null`, timeoutMs: 5000 });
    const realPath = realResult.ok ? realResult.data.stdout.trim() : '';
    resolvedPath = realPath.length > 0 ? realPath : whichPath;
  }
  const pathDetail = resolvedPath !== null ? `resolves to ${resolvedPath} on the host` : 'was not found on PATH';

  const namespaceResult = await probeCliInNamespace(cli);
  if (namespaceResult === 'bwrap-unavailable') {
    return {
      family,
      cli,
      resolvedPath,
      mountable: false,
      detail: `bwrap is not available; cannot probe ${cli} reachability inside the curated SYSTEM_ROOTS jail namespace.`,
    };
  }

  const mountable = namespaceResult === 'reachable';
  if (mountable) {
    return {
      family,
      cli,
      resolvedPath,
      mountable,
      detail: `${cli} ${pathDetail} and is reachable via \`command -v\` inside a bwrap namespace mirroring the curated SYSTEM_ROOTS jail.`,
    };
  }

  const detail = resolvedPath !== null && isMountablePath(resolvedPath, home)
    ? `${cli} ${pathDetail}, under $HOME or SYSTEM_ROOTS, but was not reachable via \`command -v\` inside the curated SYSTEM_ROOTS-only namespace (a real dispatch also binds $HOME toolchain leaves separately).`
    : `${cli} ${pathDetail} and is not reachable inside a bwrap namespace mirroring the curated SYSTEM_ROOTS jail — dispatch will refuse with CLI_PATH_NOT_MOUNTABLE.`;
  return { family, cli, resolvedPath, mountable, detail };
}

/** Per-backend CLI reachability probes for check-environment (WK-0174). */
export async function probeCliReachability(): Promise<CliReachability[]> {
  const home = resolveHomePath();
  return Promise.all(CLI_BACKENDS.map(({ family, cli }) => probeOneCliReachability(family, cli, home)));
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
  const [bwrap, container, writability, cliReachability] = await Promise.all([
    probeBwrap(),
    detectContainer(),
    probeWritability(),
    probeCliReachability(),
  ]);

  return ok({
    checkedAt,
    platform: process.platform,
    arch: process.arch,
    bwrap,
    container,
    writability,
    cliReachability,
    verdicts: deriveRouteVerdicts(bwrap),
  });
}

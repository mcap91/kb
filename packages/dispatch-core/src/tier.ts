/**
 * Tier resolution from probe results (spec §11 platform matrix; PLN-0004 S5,
 * T16 full). Three required-enforcement tiers replace `enforced:false`
 * bare-host dispatch (spec D14): `bwrap-direct` (native Linux / EC2 /
 * operator-controlled Docker), `bwrap-wsl2` (Windows hosts routed into
 * WSL2), `pod-attested` (WK-0034 attested managed-compute containers). When
 * none of the three routes resolve, §7.11's `no_isolation_route` refusal
 * fires (rev 3 — replaces `sandbox_required_unsupported`).
 *
 * This module is PURE and SYNCHRONOUS: it only interprets already-probed
 * facts (WSL2 reachability, bwrap presence, a live `--unshare-user` round
 * trip, container detection/attestation) into a tier decision. The actual
 * probing — spawning `wsl.exe`, reading `process.platform`, running bwrap —
 * stays in preflight.ts (T27) and pipeline.ts, which pass their results in
 * as `TierProbeInputs`.
 *
 * The AppArmor-userns remediation text mirrors preflight.ts's
 * `REMEDIATION_TEXT` (DEC-0008 D20: the `/etc/apparmor.d/bwrap` profile). It
 * was originally duplicated here rather than imported (preflight.ts's own
 * copy stayed private and T16 didn't touch preflight.ts); D6 Phase 2 exports
 * this module's copy (`APPARMOR_REMEDIATION_TEXT`/`MISSING_BWRAP_TEXT`) so
 * pipeline.ts's new `probeBwrap()`-based NO_ISOLATION_ROUTE refusal (D6
 * ruling 7 component 10) can reuse the exact remediation text rather than a
 * third duplicate. kb never runs `sudo` itself; this text is only ever
 * printed, never executed.
 */
import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { release as osRelease } from 'node:os';
import { promisify } from 'node:util';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';

/** The three required-enforcement tiers (spec §11, rev 3). */
export type HostTier = 'bwrap-direct' | 'bwrap-wsl2' | 'pod-attested';

export interface TierResolution {
  /** Resolved tier, or null if no isolation route exists. */
  tier: HostTier | null;
  /** True when a valid isolation route exists. */
  enforced: boolean;
  /** The isolation_backend provenance value for capture.ts. */
  isolationBackend: string;
  /** Human-readable detail for check-environment. */
  detail: string;
}

export interface TierProbeInputs {
  /** Running on Windows? (process.platform === 'win32') */
  isWindows: boolean;
  /** WSL2 available and working? (wsl.exe reachable, Ubuntu distro present) */
  wsl2Available: boolean;
  /** bwrap available inside WSL2? (from preflight.ts) */
  bwrapAvailable: boolean;
  /** bwrap --unshare-user works? (from preflight.ts) */
  unshareUserWorks: boolean;
  /** Running inside a container/pod? */
  isContainer: boolean;
  /** Container attestation available? (WK-0034) */
  containerAttested: boolean;
  /** Running on native Linux (not in WSL2, not in a container)? */
  isNativeLinux: boolean;
  /** bwrap available on native Linux? */
  nativeBwrapAvailable?: boolean;
  /** bwrap --unshare-user works on native Linux? */
  nativeUnshareUserWorks?: boolean;
}

/**
 * kb-authored remediation text (mirrors preflight.ts's `REMEDIATION_TEXT`,
 * DEC-0008 D20). kb never runs sudo itself — printed, never executed.
 */
export const APPARMOR_REMEDIATION_TEXT = `bwrap user namespace support is required but blocked.

If running Ubuntu 24.04+, the AppArmor restriction on unprivileged user namespaces
must be relaxed for bwrap. Create this profile and reload:

  sudo tee /etc/apparmor.d/bwrap <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE

  sudo systemctl reload apparmor

Then re-run the preflight check.`;

export const MISSING_BWRAP_TEXT = 'bwrap is not installed. Install with: sudo apt install bubblewrap';

const NO_WSL2_TEXT = 'WSL2 with Ubuntu is required on Windows. Install with: wsl --install -d Ubuntu';

const CONTAINER_NOT_ATTESTED_TEXT = 'Container attestation (WK-0034) is not available.';

const NO_ROUTE_TEXT = 'No isolation route: this host is not Windows, not a detected container, and not native Linux.';

function noRoute(detail: string): TierResolution {
  return { tier: null, enforced: false, isolationBackend: '', detail };
}

/**
 * Resolve the host tier from probe results. Pure and synchronous.
 *
 * Resolution order:
 * 1. Windows → check WSL2 → check bwrap inside WSL2 → 'bwrap-wsl2' or null
 * 2. Container → check attestation → 'pod-attested' or null
 * 3. Native Linux → check bwrap → 'bwrap-direct' or null
 */
export function resolveTier(inputs: TierProbeInputs): TierResolution {
  if (inputs.isWindows) {
    if (!inputs.wsl2Available) {
      return noRoute(NO_WSL2_TEXT);
    }
    if (!inputs.bwrapAvailable) {
      return noRoute(MISSING_BWRAP_TEXT);
    }
    if (!inputs.unshareUserWorks) {
      return noRoute(APPARMOR_REMEDIATION_TEXT);
    }
    return {
      tier: 'bwrap-wsl2',
      enforced: true,
      isolationBackend: 'bwrap-wsl2',
      detail: 'Windows host routed into WSL2: bwrap is available with a working --unshare-user.',
    };
  }

  if (inputs.isContainer) {
    if (!inputs.containerAttested) {
      return noRoute(CONTAINER_NOT_ATTESTED_TEXT);
    }
    return {
      tier: 'pod-attested',
      enforced: true,
      isolationBackend: 'pod',
      detail: 'Running inside an attested container; the pod boundary is the enforcement wall (WK-0034).',
    };
  }

  if (inputs.isNativeLinux) {
    const nativeBwrapAvailable = inputs.nativeBwrapAvailable ?? false;
    const nativeUnshareUserWorks = inputs.nativeUnshareUserWorks ?? false;

    if (!nativeBwrapAvailable) {
      return noRoute(MISSING_BWRAP_TEXT);
    }
    if (!nativeUnshareUserWorks) {
      return noRoute(APPARMOR_REMEDIATION_TEXT);
    }
    return {
      tier: 'bwrap-direct',
      enforced: true,
      isolationBackend: 'bwrap',
      detail: 'Native Linux host: bwrap is available with a working --unshare-user.',
    };
  }

  return noRoute(NO_ROUTE_TEXT);
}

/**
 * Check that an isolation route exists. Returns ok(resolution) when a route
 * exists, or fail('NO_ISOLATION_ROUTE', ...) when none does.
 */
export function checkIsolationRoute(resolution: TierResolution): DispatchResult<TierResolution> {
  if (resolution.tier === null) {
    return fail('NO_ISOLATION_ROUTE', resolution.detail, resolution);
  }
  return ok(resolution);
}

export interface TierEnvironmentInfo {
  tier: HostTier | null;
  enforced: boolean;
  isolationBackend: string;
  detail: string;
  probes: TierProbeInputs;
}

/**
 * Build the tier-resolution portion of check-environment output.
 * Pure — takes pre-computed probe inputs.
 */
export function buildTierEnvironmentInfo(probes: TierProbeInputs): TierEnvironmentInfo {
  const resolution = resolveTier(probes);
  return {
    tier: resolution.tier,
    enforced: resolution.enforced,
    isolationBackend: resolution.isolationBackend,
    detail: resolution.detail,
    probes,
  };
}

// ---------------------------------------------------------------------------
// D8 boolean bwrap probe (mid_project_review_rulings.md ruling 7 component 10
// + ruling 8) — ADDITIVE, coexists with the tier code above.
//
// Everything above this line (HostTier, resolveTier, checkIsolationRoute,
// buildTierEnvironmentInfo) STAYS for now: pipeline.ts still calls resolveTier
// with WSL2/container probe inputs. This section is the new primitive Phase 2
// will wire in instead, after which the tier enum and its WSL2/container
// detection code get deleted (`bwrap-wsl2` is dead post-D3's Linux-only
// orchestrator; `pod-attested` stays a deferred stub, D3c).
//
// Design: no execution-tier enum, mirroring agent-chassis, which has none
// (agent-chassis README.md:117-131 — "Can it enforce?" is a plain boolean
// backed by probe facts and a backend name; its only "tier" vocabulary is the
// unrelated CCE product/entitlement tier — docs/enforcement-model.md root
// copy, "Product Structure"/"The spine" sections). Phase 2's provenance
// should follow the same shape: record `isolation: "bwrap"` (a backend name,
// like chassis's `isolation_backend`) plus these probe facts, never a tier
// name.
//
// Probe facts mirror kb's own EXISTING live-probe shape (preflight.ts's
// PREFLIGHT_SCRIPT: bwrap version, a live `--unshare-user` round trip, and
// the Ubuntu 24.04+ AppArmor userns sysctl), extended with the kernel release
// string the D8 EC2/Amazon-Linux-2023 probe sheet asked for (ruling 8 item 6
// — SELinux, not AppArmor, needs the kernel version to reason about a
// failure; its own sysctl path is not yet probed here, same gap as
// preflight.ts today). Runs direct Node child_process calls, not
// execViaWsl2 — D3 made the orchestrator Linux-native, so there is no WSL2
// boundary left to cross, and this primitive does not need to wait on
// execViaWsl2's D6 replacement (component 5).
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFileCb);

const USERNS_SYSCTL_PATH = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

export interface BwrapProbeResult {
  /** Does bwrap work end-to-end: binary runs AND the live --unshare-user round trip succeeds? The single fact Phase 2 gates on. */
  available: boolean;
  /** `bwrap --version` stdout, trimmed; null if the binary could not be found or run. */
  bwrapVersion: string | null;
  /** Live `bwrap --unshare-user --ro-bind / / true` round trip result (mirrors preflight.ts's UNSHARE_USER probe). */
  unshareUserWorks: boolean;
  /** `os.release()` — the running kernel's release string. */
  kernelVersion: string;
  /** Ubuntu/AppArmor userns-restriction sysctl value, or null where the file doesn't exist (e.g. Amazon Linux 2023's SELinux gate uses a different mechanism, not yet probed here). */
  usernsSysctl: string | null;
}

async function probeBwrapVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('bwrap', ['--version']);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function probeUnshareUser(): Promise<boolean> {
  try {
    await execFileAsync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', 'true']);
    return true;
  } catch {
    return false;
  }
}

async function readUsernsSysctl(): Promise<string | null> {
  try {
    const value = await readFile(USERNS_SYSCTL_PATH, 'utf-8');
    return value.trim();
  } catch {
    return null;
  }
}

/**
 * Boolean bwrap probe: does bwrap work, full stop — no tier enum. Never
 * throws: every sub-probe degrades to a safe false/null on error, so there is
 * no failure mode to report — only facts. (Plain data return rather than a
 * DispatchResult for that reason: nothing here can fail, only find bwrap
 * absent or broken, which `available: false` already states.)
 */
export async function probeBwrap(): Promise<BwrapProbeResult> {
  const [bwrapVersion, unshareUserWorks, usernsSysctl] = await Promise.all([
    probeBwrapVersion(),
    probeUnshareUser(),
    readUsernsSysctl(),
  ]);

  return {
    available: bwrapVersion !== null && unshareUserWorks,
    bwrapVersion,
    unshareUserWorks,
    kernelVersion: osRelease(),
    usernsSysctl,
  };
}

/** Bwrap probe facts for the check-environment surface (wired via environment.ts). */
export async function buildBwrapEnvironmentInfo(): Promise<BwrapProbeResult> {
  return probeBwrap();
}

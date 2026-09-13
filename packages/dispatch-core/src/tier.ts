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
 * `REMEDIATION_TEXT` (DEC-0008 D20: the `/etc/apparmor.d/bwrap` profile).
 * It is duplicated here rather than imported — that constant is private to
 * preflight.ts and T16 does not touch preflight.ts. kb never runs `sudo`
 * itself; this text is only ever printed, never executed.
 */
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
const APPARMOR_REMEDIATION_TEXT = `bwrap user namespace support is required but blocked.

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

const MISSING_BWRAP_TEXT = 'bwrap is not installed. Install with: sudo apt install bubblewrap';

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

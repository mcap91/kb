/**
 * PLN-0004 S5 T16 — tier resolution + NO_ISOLATION_ROUTE (spec §11 platform
 * matrix; §7.11 admission check). `resolveTier`/`checkIsolationRoute`/
 * `buildTierEnvironmentInfo` are pure and synchronous — no WSL2/bwrap/
 * container probing happens in this file; probe facts are supplied directly
 * as `TierProbeInputs`. No personal/absolute paths appear in fixtures
 * (WK-0043 rule) — this module never touches the filesystem or network.
 */
import { describe, expect, it } from 'vitest';

import type { DispatchErrorCode } from '../packages/dispatch-core/src/errors.js';
import { V2_REFUSAL_CODES } from '../packages/dispatch-core/src/errors.js';
import type { TierProbeInputs } from '../packages/dispatch-core/src/tier.js';
import {
  resolveTier,
  checkIsolationRoute,
  buildTierEnvironmentInfo,
} from '../packages/dispatch-core/src/tier.js';

/** Every probe defaults to negative/absent; each test overrides only what it needs. */
function baseInputs(overrides: Partial<TierProbeInputs> = {}): TierProbeInputs {
  return {
    isWindows: false,
    wsl2Available: false,
    bwrapAvailable: false,
    unshareUserWorks: false,
    isContainer: false,
    containerAttested: false,
    isNativeLinux: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// errors.ts — NO_ISOLATION_ROUTE (test 1 + test 13)
// ---------------------------------------------------------------------------

describe('errors.ts — NO_ISOLATION_ROUTE', () => {
  it('is a valid DispatchErrorCode at compile time', () => {
    const code: DispatchErrorCode = 'NO_ISOLATION_ROUTE';
    expect(code).toBe('NO_ISOLATION_ROUTE');
  });

  it('is included in V2_REFUSAL_CODES at runtime', () => {
    expect(V2_REFUSAL_CODES).toContain('NO_ISOLATION_ROUTE');
  });
});

// ---------------------------------------------------------------------------
// resolveTier — Windows -> WSL2 -> bwrap-wsl2 (tests 2-4)
// ---------------------------------------------------------------------------

describe('resolveTier — Windows + WSL2', () => {
  it('resolves bwrap-wsl2 when WSL2 + bwrap + unshare-user all work', () => {
    const result = resolveTier(baseInputs({
      isWindows: true,
      wsl2Available: true,
      bwrapAvailable: true,
      unshareUserWorks: true,
    }));
    expect(result.tier).toBe('bwrap-wsl2');
    expect(result.enforced).toBe(true);
    expect(result.isolationBackend).toBe('bwrap-wsl2');
  });

  it('refuses with AppArmor remediation when unshare-user fails inside WSL2', () => {
    const result = resolveTier(baseInputs({
      isWindows: true,
      wsl2Available: true,
      bwrapAvailable: true,
      unshareUserWorks: false,
    }));
    expect(result.tier).toBeNull();
    expect(result.enforced).toBe(false);
    expect(result.isolationBackend).toBe('');
    expect(result.detail).toContain('/etc/apparmor.d/bwrap');
    expect(result.detail.toLowerCase()).toContain('userns');
  });

  it('refuses with a WSL2-install detail when WSL2 is not available', () => {
    const result = resolveTier(baseInputs({
      isWindows: true,
      wsl2Available: false,
    }));
    expect(result.tier).toBeNull();
    expect(result.enforced).toBe(false);
    expect(result.detail).toContain('WSL2');
  });

  it('refuses with an install hint when bwrap itself is missing inside WSL2', () => {
    const result = resolveTier(baseInputs({
      isWindows: true,
      wsl2Available: true,
      bwrapAvailable: false,
    }));
    expect(result.tier).toBeNull();
    expect(result.enforced).toBe(false);
    expect(result.detail.toLowerCase()).toContain('install');
  });
});

// ---------------------------------------------------------------------------
// resolveTier — native Linux -> bwrap-direct (tests 5-7)
// ---------------------------------------------------------------------------

describe('resolveTier — native Linux', () => {
  it('resolves bwrap-direct when bwrap + unshare-user both work', () => {
    const result = resolveTier(baseInputs({
      isNativeLinux: true,
      nativeBwrapAvailable: true,
      nativeUnshareUserWorks: true,
    }));
    expect(result.tier).toBe('bwrap-direct');
    expect(result.enforced).toBe(true);
    expect(result.isolationBackend).toBe('bwrap');
  });

  it('refuses with AppArmor remediation when unshare-user fails', () => {
    const result = resolveTier(baseInputs({
      isNativeLinux: true,
      nativeBwrapAvailable: true,
      nativeUnshareUserWorks: false,
    }));
    expect(result.tier).toBeNull();
    expect(result.enforced).toBe(false);
    expect(result.detail).toContain('/etc/apparmor.d/bwrap');
  });

  it('refuses with an install hint when bwrap is not installed', () => {
    const result = resolveTier(baseInputs({
      isNativeLinux: true,
      nativeBwrapAvailable: false,
    }));
    expect(result.tier).toBeNull();
    expect(result.enforced).toBe(false);
    expect(result.detail.toLowerCase()).toContain('install');
  });
});

// ---------------------------------------------------------------------------
// resolveTier — container -> pod-attested (tests 8-9)
// ---------------------------------------------------------------------------

describe('resolveTier — container', () => {
  it('resolves pod-attested when the container is attested', () => {
    const result = resolveTier(baseInputs({
      isContainer: true,
      containerAttested: true,
    }));
    expect(result.tier).toBe('pod-attested');
    expect(result.enforced).toBe(true);
    expect(result.isolationBackend).toBe('pod');
  });

  it('refuses when the container is not attested', () => {
    const result = resolveTier(baseInputs({
      isContainer: true,
      containerAttested: false,
    }));
    expect(result.tier).toBeNull();
    expect(result.enforced).toBe(false);
    expect(result.detail).toContain('WK-0034');
  });
});

// ---------------------------------------------------------------------------
// checkIsolationRoute (tests 10-11)
// ---------------------------------------------------------------------------

describe('checkIsolationRoute', () => {
  it('returns ok(resolution) when a route exists', () => {
    const resolution = resolveTier(baseInputs({
      isNativeLinux: true,
      nativeBwrapAvailable: true,
      nativeUnshareUserWorks: true,
    }));
    const result = checkIsolationRoute(resolution);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tier).toBe('bwrap-direct');
    expect(result.data.enforced).toBe(true);
  });

  it("returns fail('NO_ISOLATION_ROUTE', ...) when no route exists", () => {
    const resolution = resolveTier(baseInputs());
    const result = checkIsolationRoute(resolution);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('NO_ISOLATION_ROUTE');
    expect(result.message).toBe(resolution.detail);
  });
});

// ---------------------------------------------------------------------------
// buildTierEnvironmentInfo (test 12)
// ---------------------------------------------------------------------------

describe('buildTierEnvironmentInfo', () => {
  it('returns the resolved tier fields plus the echoed-back probe inputs', () => {
    const probes = baseInputs({
      isWindows: true,
      wsl2Available: true,
      bwrapAvailable: true,
      unshareUserWorks: true,
    });
    const info = buildTierEnvironmentInfo(probes);
    expect(info.tier).toBe('bwrap-wsl2');
    expect(info.enforced).toBe(true);
    expect(info.isolationBackend).toBe('bwrap-wsl2');
    expect(typeof info.detail).toBe('string');
    expect(info.detail.length).toBeGreaterThan(0);
    expect(info.probes).toEqual(probes);
  });

  it('reflects a no-route resolution for an unenforced host', () => {
    const probes = baseInputs();
    const info = buildTierEnvironmentInfo(probes);
    expect(info.tier).toBeNull();
    expect(info.enforced).toBe(false);
    expect(info.isolationBackend).toBe('');
    expect(info.probes).toEqual(probes);
  });
});

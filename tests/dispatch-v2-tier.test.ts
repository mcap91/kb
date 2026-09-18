/** PLN-0004 D6 Phase 3 — tier resolution + probeBwrap unit tests (tier.ts). */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));
vi.mock('node:os', () => ({
  release: vi.fn(() => '6.6.87.2-microsoft-standard-WSL2'),
}));

// Import AFTER the mocks above so tier.ts's top-level `promisify(execFile)`
// wraps the mocked function.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { release } from 'node:os';

import type { DispatchErrorCode } from '../packages/dispatch-core/src/errors.js';
import { V2_REFUSAL_CODES } from '../packages/dispatch-core/src/errors.js';
import type { TierProbeInputs } from '../packages/dispatch-core/src/tier.js';
import {
  probeBwrap,
  resolveTier,
  checkIsolationRoute,
  buildTierEnvironmentInfo,
} from '../packages/dispatch-core/src/tier.js';

// probeBwrap()'s execFileAsync is promisify(execFile). A plain vi.fn() has no
// custom-promisify symbol, so Node's generic fallback resolves with only the
// callback's FIRST non-error arg (verified: cb(null, stdout, stderr) resolves
// to just `stdout`, dropping stderr). The mock below calls back with one
// `{ stdout, stderr }` object so `const { stdout } = await execFileAsync(...)`
// destructures the real shape instead of `undefined`.
type ExecFileCb = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

/** Wire the mocked `execFile` to answer `bwrap --version` / `bwrap --unshare-user ...`. */
function mockBwrap(opts: { version?: string | Error; unshareUser?: boolean | Error }): void {
  vi.mocked(execFile).mockImplementation(((_cmd: string, args: readonly string[], cb: ExecFileCb) => {
    const sub = args[0];
    if (sub === '--version') {
      const v = opts.version;
      return v instanceof Error ? cb(v) : cb(null, { stdout: v ?? '', stderr: '' });
    }
    if (sub === '--unshare-user') {
      const u = opts.unshareUser;
      if (u instanceof Error) return cb(u);
      return u ? cb(null, { stdout: '', stderr: '' }) : cb(new Error('unshare-user failed'));
    }
    return cb(new Error(`unexpected bwrap args: ${args.join(' ')}`));
  }) as any);
}

describe('probeBwrap()', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
    vi.mocked(readFile).mockReset();
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(release).mockReset();
    vi.mocked(release).mockReturnValue('6.6.87.2-microsoft-standard-WSL2');
  });

  it('reports available:true when bwrap --version and --unshare-user both succeed', async () => {
    mockBwrap({ version: 'bubblewrap 0.9.0\n', unshareUser: true });
    const result = await probeBwrap();
    expect(result.available).toBe(true);
    expect(result.bwrapVersion).toBe('bubblewrap 0.9.0');
    expect(result.unshareUserWorks).toBe(true);
  });

  it('reports available:false and bwrapVersion:null when bwrap is not installed (ENOENT)', async () => {
    const enoent = Object.assign(new Error('spawn bwrap ENOENT'), { code: 'ENOENT' });
    mockBwrap({ version: enoent, unshareUser: enoent });
    const result = await probeBwrap();
    expect(result.available).toBe(false);
    expect(result.bwrapVersion).toBeNull();
  });

  it('reports available:false when bwrap is present but --unshare-user fails', async () => {
    mockBwrap({ version: 'bubblewrap 0.9.0\n', unshareUser: false });
    const result = await probeBwrap();
    expect(result.available).toBe(false);
    expect(result.bwrapVersion).toBe('bubblewrap 0.9.0');
    expect(result.unshareUserWorks).toBe(false);
  });

  it('trims bwrap --version stdout into bwrapVersion', async () => {
    mockBwrap({ version: '  bubblewrap 0.11.0  \n', unshareUser: true });
    const result = await probeBwrap();
    expect(result.bwrapVersion).toBe('bubblewrap 0.11.0');
  });

  it('reads kernelVersion from os.release()', async () => {
    vi.mocked(release).mockReturnValue('5.15.0-generic');
    mockBwrap({ version: 'bubblewrap 0.9.0', unshareUser: true });
    const result = await probeBwrap();
    expect(result.kernelVersion).toBe('5.15.0-generic');
  });

  it('returns the trimmed sysctl value when the userns file exists', async () => {
    vi.mocked(readFile).mockResolvedValue('1\n');
    mockBwrap({ version: 'bubblewrap 0.9.0', unshareUser: true });
    const result = await probeBwrap();
    expect(result.usernsSysctl).toBe('1');
  });

  it('returns usernsSysctl:null when the sysctl file does not exist', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockBwrap({ version: 'bubblewrap 0.9.0', unshareUser: true });
    const result = await probeBwrap();
    expect(result.usernsSysctl).toBeNull();
  });
});

// Legacy probe-input primitives — still exported, superseded by probeBwrap()
// above for v2 callers. Kept minimal (full coverage lived here pre-D6).
describe('errors.ts — NO_ISOLATION_ROUTE', () => {
  it('is a valid DispatchErrorCode at compile time', () => {
    const code: DispatchErrorCode = 'NO_ISOLATION_ROUTE';
    expect(code).toBe('NO_ISOLATION_ROUTE');
  });

  it('is included in V2_REFUSAL_CODES at runtime', () => {
    expect(V2_REFUSAL_CODES).toContain('NO_ISOLATION_ROUTE');
  });
});

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

describe('resolveTier / checkIsolationRoute / buildTierEnvironmentInfo', () => {
  it('resolves bwrap-direct on native Linux when bwrap + unshare-user both work', () => {
    const result = resolveTier(
      baseInputs({ isNativeLinux: true, nativeBwrapAvailable: true, nativeUnshareUserWorks: true }),
    );
    expect(result.tier).toBe('bwrap-direct');
    expect(result.enforced).toBe(true);
  });

  it('resolves no route when no platform probe matches', () => {
    const result = resolveTier(baseInputs());
    expect(result.tier).toBeNull();
    expect(result.enforced).toBe(false);
  });

  it('checkIsolationRoute fails with NO_ISOLATION_ROUTE when no route exists', () => {
    const result = checkIsolationRoute(resolveTier(baseInputs()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('NO_ISOLATION_ROUTE');
  });

  it('buildTierEnvironmentInfo echoes the resolved tier plus probe inputs', () => {
    const probes = baseInputs({ isNativeLinux: true, nativeBwrapAvailable: true, nativeUnshareUserWorks: true });
    const info = buildTierEnvironmentInfo(probes);
    expect(info.tier).toBe('bwrap-direct');
    expect(info.probes).toEqual(probes);
  });
});

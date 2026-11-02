/**
 * WK-0237 slice A — pure host-path helper tests (paths.ts). No real `which`,
 * no real `claude`/`bwrap` call: `findOnPath` is driven with an injected
 * existence check against synthetic paths.
 */
import { describe, expect, it } from 'vitest';

import {
  checkResolvConfRealpath,
  deriveCliBinaryRelPath,
  deriveCliPackageDir,
  findOnPath,
  getCredentialsFile,
  getTestKbDataRoot,
  getTestKbRoot,
  isUnderHome,
  resolveResolvConfRealpath,
} from '../evals/paths.js';

describe('getTestKbRoot / getTestKbDataRoot', () => {
  it('derive test_kb and test_kb_data as siblings of the kb root', () => {
    expect(getTestKbRoot('/synthetic/kb')).toBe('/synthetic/test_kb');
    expect(getTestKbDataRoot('/synthetic/kb')).toBe('/synthetic/test_kb_data');
  });
});

describe('getCredentialsFile', () => {
  it('derives the credentials file under $HOME/.claude', () => {
    expect(getCredentialsFile('/synthetic/home')).toBe('/synthetic/home/.claude/.credentials.json');
  });
});

describe('deriveCliPackageDir / deriveCliBinaryRelPath', () => {
  it('strips the bin/<binary> leaf off the realpath to get the package dir', () => {
    const packageDir = '/synthetic/npm-global/lib/node_modules/@anthropic-ai/claude-code';
    const realpath = `${packageDir}/bin/claude.exe`;
    expect(deriveCliPackageDir(realpath)).toBe(packageDir);
  });

  it('derives the binary path relative to its package dir', () => {
    const packageDir = '/synthetic/npm-global/lib/node_modules/@anthropic-ai/claude-code';
    const realpath = `${packageDir}/bin/claude.exe`;
    expect(deriveCliBinaryRelPath(realpath, packageDir)).toBe('bin/claude.exe');
  });
});

describe('resolveResolvConfRealpath', () => {
  it('returns the realpath when /etc/resolv.conf exists', () => {
    const result = resolveResolvConfRealpath(
      (p) => p === '/etc/resolv.conf',
      () => '/mnt/wsl/resolv.conf',
    );
    expect(result).toBe('/mnt/wsl/resolv.conf');
  });

  it('returns null when /etc/resolv.conf does not exist', () => {
    const result = resolveResolvConfRealpath(() => false, () => '/mnt/wsl/resolv.conf');
    expect(result).toBeNull();
  });
});

describe('isUnderHome', () => {
  it('is true for the home dir itself and for nested paths', () => {
    expect(isUnderHome('/synthetic/home/alice', '/synthetic/home/alice')).toBe(true);
    expect(isUnderHome('/synthetic/home/alice/.claude/resolv.conf', '/synthetic/home/alice')).toBe(true);
  });

  it('is false for unrelated or sibling-prefixed paths', () => {
    expect(isUnderHome('/synthetic/home/alice-other', '/synthetic/home/alice')).toBe(false);
    expect(isUnderHome('/etc/resolv.conf', '/synthetic/home/alice')).toBe(false);
  });
});

describe('checkResolvConfRealpath', () => {
  it('returns ok with the realpath when it is outside the home directory', () => {
    const result = checkResolvConfRealpath('/mnt/wsl/resolv.conf', '/synthetic/home/alice');
    expect(result).toEqual({ ok: true, data: '/mnt/wsl/resolv.conf' });
  });

  it('returns ok with null unchanged when there is no resolv.conf', () => {
    const result = checkResolvConfRealpath(null, '/synthetic/home/alice');
    expect(result).toEqual({ ok: true, data: null });
  });

  it('returns a failure Result, with no path carried forward, when the realpath is under the home directory', () => {
    const result = checkResolvConfRealpath('/synthetic/home/alice/.claude/resolv.conf', '/synthetic/home/alice');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RESOLV_CONF_UNDER_HOME');
      expect(result.message).toContain('/synthetic/home/alice/.claude/resolv.conf');
    }
  });
});

describe('findOnPath', () => {
  it('returns the first PATH entry containing the named executable', () => {
    const existing = new Set(['/opt/bin/claude', '/usr/bin/claude']);
    const found = findOnPath('claude', '/opt/sbin:/opt/bin:/usr/bin', (p) => existing.has(p));
    expect(found).toBe('/opt/bin/claude');
  });

  it('returns null when no PATH entry has the named executable', () => {
    const found = findOnPath('claude', '/opt/bin:/usr/bin', () => false);
    expect(found).toBeNull();
  });

  it('skips empty PATH entries', () => {
    const found = findOnPath('claude', '::/usr/bin:', (p) => p === '/usr/bin/claude');
    expect(found).toBe('/usr/bin/claude');
  });
});

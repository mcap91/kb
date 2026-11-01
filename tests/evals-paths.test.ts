/**
 * WK-0237 slice A — pure host-path helper tests (paths.ts). No real `which`,
 * no real `claude`/`bwrap` call: `findOnPath` is driven with an injected
 * existence check against synthetic paths.
 */
import { describe, expect, it } from 'vitest';

import {
  deriveCliBinaryRelPath,
  deriveCliPackageDir,
  findOnPath,
  getCredentialsFile,
  getTestKbDataRoot,
  getTestKbRoot,
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

/**
 * PLN-0004 S5 — tests for the full §11 jail recipe (T15 full) and the
 * dual-shape wiki read axis (T25).
 *
 * jail.ts's S0-minimum shape is already frozen by the equality assertions in
 * dispatch-v2-exec.test.ts (untouched here — that file is the backward-compat
 * contract). This file covers the NEW S5 surface: write_scope sparse binds,
 * the wiki read axis (T25/D19), data mounts, the T26/D21 egress-bind wiring,
 * full-recipe ordering, and the two new pure helpers `classifyWikiShape` and
 * `parseDataMount`. Pure/synchronous throughout — no WSL2/bwrap required,
 * runs everywhere including Windows. No personal/absolute paths in fixtures
 * (WK-0043 rule) — clonePath etc. below are synthetic.
 */
import { describe, expect, it } from 'vitest';

import {
  buildJailArgs,
  classifyWikiShape,
  parseDataMount,
  type JailOpts,
} from '../packages/dispatch-core/src/jail.js';

const clonePath = '/home/user/.kb-dispatch/clones/RUN-JAIL';

// ---------------------------------------------------------------------------
// buildJailArgs — S0 backward compatibility (no S5 options set)
// ---------------------------------------------------------------------------

describe('buildJailArgs — S0 backward compatibility', () => {
  it('produces the exact S0-minimum argv when no S5 options are set', () => {
    const result = buildJailArgs({ clonePath });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('still honors an explicit cwd distinct from clonePath with no S5 options set', () => {
    const cwd = `${clonePath}/subdir`;
    const result = buildJailArgs({ clonePath, cwd });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', cwd,
      '--',
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildJailArgs — write_scope sparse binds
// ---------------------------------------------------------------------------

describe('buildJailArgs — write_scope sparse binds', () => {
  it('ro-binds the clone, then rw-binds each write_scope path, with --tmpfs /tmp present', () => {
    const result = buildJailArgs({ clonePath, writeScope: ['src/', 'test/'] });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--ro-bind', clonePath, clonePath,
      '--bind', `${clonePath}/src`, `${clonePath}/src`,
      '--bind', `${clonePath}/test`, `${clonePath}/test`,
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('keeps the clone fully writable (legacy shape) when writeScope is absent but other S5 options are set', () => {
    const result = buildJailArgs({ clonePath, unshareNet: true });
    // Only the mandatory root ro-bind should appear; the clone itself binds
    // writable because writeScope was never provided.
    const roBindCount = result.argv.filter((tok) => tok === '--ro-bind').length;
    expect(roBindCount).toBe(1);
    const bindIdx = result.argv.indexOf('--bind');
    expect(result.argv[bindIdx + 1]).toBe(clonePath);
    expect(result.argv[bindIdx + 2]).toBe(clonePath);
  });

  it('ro-binds the clone with zero write binds when writeScope is an empty array', () => {
    const result = buildJailArgs({ clonePath, writeScope: [] });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--ro-bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildJailArgs — dual-shape wiki read axis (T25/D19)
// ---------------------------------------------------------------------------

describe('buildJailArgs — wiki read axis (T25/D19)', () => {
  it('tracked + implement: masks wiki with --tmpfs', () => {
    const result = buildJailArgs({ clonePath, wikiShape: 'tracked', mode: 'implement' });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--tmpfs', `${clonePath}/wiki`,
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('tracked + code_review: also masks wiki with --tmpfs', () => {
    const result = buildJailArgs({ clonePath, wikiShape: 'tracked', mode: 'code_review' });
    expect(result.argv).toContain('--tmpfs');
    expect(result.argv).toEqual(expect.arrayContaining(['--tmpfs', `${clonePath}/wiki`]));
  });

  it('tracked + redteam: no wiki mask — wiki stays visible as part of the clone', () => {
    const result = buildJailArgs({ clonePath, wikiShape: 'tracked', mode: 'redteam' });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('nested-private + implement: nothing added — clone has no wiki/ at all', () => {
    const result = buildJailArgs({ clonePath, wikiShape: 'nested-private', mode: 'implement' });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('nested-private + research with motherWikiPath: ro-binds the mother wiki into the clone', () => {
    const motherWikiPath = '/home/user/kb-dev-rig/wiki';
    const result = buildJailArgs({
      clonePath,
      wikiShape: 'nested-private',
      mode: 'research',
      motherWikiPath,
    });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--ro-bind', motherWikiPath, `${clonePath}/wiki`,
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('nested-private + redteam WITHOUT motherWikiPath: no bind (nothing to bind against)', () => {
    const result = buildJailArgs({ clonePath, wikiShape: 'nested-private', mode: 'redteam' });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
    ]);
    // Only the mandatory root ro-bind is present — no wiki bind was added.
    expect(result.argv.filter((tok) => tok === '--ro-bind').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildJailArgs — data mounts
// ---------------------------------------------------------------------------

describe('buildJailArgs — data mounts', () => {
  it('ro data mount produces --ro-bind', () => {
    const result = buildJailArgs({ clonePath, dataMounts: ['ro:/data/ref'] });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--ro-bind', '/data/ref', '/data/ref',
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('rw data mount produces --bind', () => {
    const result = buildJailArgs({ clonePath, dataMounts: ['rw:/tmp/scratch'] });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--bind', '/tmp/scratch', '/tmp/scratch',
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('skips malformed data_mounts entries silently (pure function, cannot fail)', () => {
    const result = buildJailArgs({ clonePath, dataMounts: ['garbage', 'ro:/data/ref'] });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--ro-bind', '/data/ref', '/data/ref',
      '--chdir', clonePath,
      '--',
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildJailArgs — network egress (T26/D21)
// ---------------------------------------------------------------------------

describe('buildJailArgs — unshare-net (T26/D21)', () => {
  it('unshareNet:true adds --unshare-net right after --die-with-parent', () => {
    const result = buildJailArgs({ clonePath, unshareNet: true });
    expect(result.argv).toContain('--unshare-net');
    const idx = result.argv.indexOf('--unshare-net');
    expect(result.argv[idx - 1]).toBe('--die-with-parent');
  });

  it('unshareNet:false (explicit, other S5 options set) omits --unshare-net', () => {
    const result = buildJailArgs({ clonePath, unshareNet: false, wikiShape: 'tracked', mode: 'redteam' });
    expect(result.argv).not.toContain('--unshare-net');
  });

  it('unshareNet absent (no S5 options at all) omits --unshare-net', () => {
    const result = buildJailArgs({ clonePath });
    expect(result.argv).not.toContain('--unshare-net');
  });
});

// ---------------------------------------------------------------------------
// buildJailArgs — tunnel socket + relay script binds (T26/D21)
// ---------------------------------------------------------------------------

describe('buildJailArgs — tunnel socket and relay script binds', () => {
  it('binds the tunnel socket writable', () => {
    const tunnelSocketPath = '/home/user/.kb-dispatch/runs/RUN-JAIL/tunnel.sock';
    const result = buildJailArgs({ clonePath, tunnelSocketPath });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--bind', tunnelSocketPath, tunnelSocketPath,
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('binds the relay script read-only', () => {
    const relayScriptPath = '/home/user/.kb-dispatch/runs/RUN-JAIL/relay.js';
    const result = buildJailArgs({ clonePath, relayScriptPath });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--ro-bind', relayScriptPath, relayScriptPath,
      '--chdir', clonePath,
      '--',
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildJailArgs — full combined recipe (all options together)
// ---------------------------------------------------------------------------

describe('buildJailArgs — full combined recipe', () => {
  it('applies every S5 addition in §11 order', () => {
    const cwd = `${clonePath}/work`;
    const tunnelSocketPath = '/home/user/.kb-dispatch/runs/RUN-JAIL/tunnel.sock';
    const relayScriptPath = '/home/user/.kb-dispatch/runs/RUN-JAIL/relay.js';
    const opts: JailOpts = {
      clonePath,
      cwd,
      writeScope: ['src/', 'docs/notes.md'],
      wikiShape: 'tracked',
      mode: 'implement',
      dataMounts: ['ro:/data/reference', 'rw:/tmp/scratch-area'],
      unshareNet: true,
      tunnelSocketPath,
      relayScriptPath,
    };

    const result = buildJailArgs(opts);

    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--unshare-net',
      '--ro-bind', clonePath, clonePath,
      '--bind', `${clonePath}/src`, `${clonePath}/src`,
      '--bind', `${clonePath}/docs/notes.md`, `${clonePath}/docs/notes.md`,
      '--tmpfs', `${clonePath}/wiki`,
      '--ro-bind', '/data/reference', '/data/reference',
      '--bind', '/tmp/scratch-area', '/tmp/scratch-area',
      '--bind', tunnelSocketPath, tunnelSocketPath,
      '--ro-bind', relayScriptPath, relayScriptPath,
      '--chdir', cwd,
      '--',
    ]);
  });
});

// ---------------------------------------------------------------------------
// classifyWikiShape (T25/D19)
// ---------------------------------------------------------------------------

describe('classifyWikiShape', () => {
  it('returns nested-private for empty git ls-files output', () => {
    expect(classifyWikiShape('')).toBe('nested-private');
  });

  it('returns nested-private for whitespace-only output', () => {
    expect(classifyWikiShape('\n')).toBe('nested-private');
  });

  it('returns tracked for non-empty git ls-files output', () => {
    expect(classifyWikiShape('wiki/issues/WK-0001.md\nwiki/plans/PLN-0001.md\n')).toBe('tracked');
  });
});

// ---------------------------------------------------------------------------
// parseDataMount
// ---------------------------------------------------------------------------

describe('parseDataMount', () => {
  it('parses a ro entry', () => {
    expect(parseDataMount('ro:/data/reference')).toEqual({ access: 'ro', hostPath: '/data/reference' });
  });

  it('parses a rw entry', () => {
    expect(parseDataMount('rw:/tmp/scratch')).toEqual({ access: 'rw', hostPath: '/tmp/scratch' });
  });

  it('returns null when the access prefix is missing', () => {
    expect(parseDataMount('/data/reference')).toBeNull();
  });

  it('returns null for an unrecognized access prefix', () => {
    expect(parseDataMount('xx:/data/reference')).toBeNull();
  });

  it('returns null when the path after the prefix is empty', () => {
    expect(parseDataMount('ro:')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseDataMount('')).toBeNull();
  });
});

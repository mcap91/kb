/**
 * PLN-0004 S5 — tests for the full §11 jail recipe (T15 full) and the
 * dual-shape wiki read axis (T25).
 *
 * This file covers the S5 surface: write_scope sparse binds,
 * the wiki read axis (T25/D19), data mounts, the T26/D21 egress-bind wiring,
 * full-recipe ordering, and the two new pure helpers `classifyWikiShape` and
 * `parseDataMount`. Pure/synchronous throughout — no WSL2/bwrap required,
 * runs everywhere including Windows. No personal/absolute paths in fixtures
 * (WK-0043 rule) — clonePath etc. below are synthetic.
 */
import { describe, expect, it } from 'vitest';

import {
  buildBwrapPlan,
  buildJailArgs,
  classifyWikiShape,
  parseDataMount,
  type BwrapInjectedFile,
  type BwrapMount,
  type JailOpts,
} from '../packages/dispatch-core/src/jail.js';

const clonePath = '/home/user/.kb-dispatch/clones/RUN-JAIL';

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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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

  it('ro-binds the clone with zero write binds when writeScope is an empty array (the code_review shape), but still writably binds .dispatch-out/', () => {
    const result = buildJailArgs({ clonePath, writeScope: [] });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--ro-bind', clonePath, clonePath,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--chdir', clonePath,
      '--',
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildJailArgs — .dispatch-out/ worker-output bind (S6a W4)
// ---------------------------------------------------------------------------

describe('buildJailArgs — .dispatch-out/ worker-output bind (S6a W4)', () => {
  it('is present and writable even when write_scope is empty (code_review: write_scope grants no write authority at all)', () => {
    const result = buildJailArgs({ clonePath, writeScope: [], mode: 'code_review' });
    const idx = result.argv.indexOf('--bind', result.argv.indexOf('--ro-bind', result.argv.indexOf('--die-with-parent')));
    expect(idx).toBeGreaterThan(0);
    expect(result.argv[idx + 1]).toBe(`${clonePath}/.dispatch-out`);
    expect(result.argv[idx + 2]).toBe(`${clonePath}/.dispatch-out`);
  });

  it('is present regardless of mode (unconditional, future-proofed for outcome.yaml)', () => {
    for (const mode of ['implement', 'code_review', 'redteam', 'research'] as const) {
      const result = buildJailArgs({ clonePath, wikiShape: 'nested-private', mode });
      expect(result.argv).toEqual(
        expect.arrayContaining(['--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`]),
      );
    }
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--chdir', clonePath,
      '--',
    ]);
    // Only the mandatory root ro-bind is present — no wiki bind was added
    // (the .dispatch-out/ bind above is a plain --bind, not --ro-bind).
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
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

// ---------------------------------------------------------------------------
// buildBwrapPlan (D6 Phase 3) — frozen plan object for direct bwrap spawn.
//
// Shares its mount-logic walk (buildJailPlanSteps) with buildJailArgs above —
// same conditions, same order, same values (see jail.ts's own comment on
// buildJailPlanSteps) — so these suites mirror the buildJailArgs ones above
// rather than re-deriving the recipe from scratch. Two shape differences from
// buildJailArgs's argv: (1) bwrapArgs excludes the leading 'bwrap' program
// name (Node's spawn(cmd, args) takes the binary separately from its argv);
// (2) bwrapArgs always ends with the worker command after `--`, never a bare
// `--` left for a caller to append to.
// ---------------------------------------------------------------------------

describe('buildBwrapPlan — plan object shape', () => {
  it('produces bwrapArgs/mounts/env/cwd/command with the documented types', () => {
    const command = ['pi', '-p', '--mode', 'json'];
    const plan = buildBwrapPlan({ clonePath, command });

    expect(Array.isArray(plan.bwrapArgs)).toBe(true);
    expect(plan.bwrapArgs.every((tok) => typeof tok === 'string')).toBe(true);
    expect(Array.isArray(plan.mounts)).toBe(true);
    expect(plan.mounts.length).toBeGreaterThan(0);
    expect(typeof plan.env).toBe('object');
    expect(typeof plan.cwd).toBe('string');
    expect(Array.isArray(plan.command)).toBe(true);
    expect(plan.command).toEqual(command);
  });

  it('renders the base recipe (no S5 options) ending in "--chdir <cwd> -- <command...>", with no leading "bwrap" token', () => {
    const command = ['pi', '-p'];
    const plan = buildBwrapPlan({ clonePath, command });

    expect(plan.bwrapArgs).toEqual([
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--chdir', clonePath,
      '--',
      'pi', '-p',
    ]);
    expect(plan.mounts[0]).toEqual({ kind: 'ro-bind', src: '/', dst: '/' });
    expect(plan.mounts[1]).toEqual({ kind: 'proc', dst: '/proc' });
  });

  it('honors an explicit cwd distinct from clonePath, placed right after --chdir and mirrored on plan.cwd', () => {
    const cwd = `${clonePath}/work`;
    const plan = buildBwrapPlan({ clonePath, cwd, command: ['pi'] });

    expect(plan.cwd).toBe(cwd);
    const chdirIdx = plan.bwrapArgs.indexOf('--chdir');
    expect(plan.bwrapArgs[chdirIdx + 1]).toBe(cwd);
  });

  it("defaults env to {} and defensively copies a provided env/command rather than aliasing the caller's objects", () => {
    const bare = buildBwrapPlan({ clonePath, command: ['pi'] });
    expect(bare.env).toEqual({});

    const inputEnv = { FOO: 'bar' };
    const command = ['pi', '-p'];
    const plan = buildBwrapPlan({ clonePath, command, env: inputEnv });
    expect(plan.env).toEqual({ FOO: 'bar' });
    expect(plan.env).not.toBe(inputEnv);
    expect(plan.command).toEqual(command);
    expect(plan.command).not.toBe(command);
  });
});

// ---------------------------------------------------------------------------
// buildBwrapPlan — injectedFiles (--file materialization)
// ---------------------------------------------------------------------------

describe('buildBwrapPlan — injectedFiles', () => {
  it('assigns sequential fds starting at 3 and renders matching "--file <fd> <dest>" pairs before the "--" terminator', () => {
    const injectedFiles = [
      { content: '{"a":1}', dest: `${clonePath}/tmp/.pi-agent/models.json` },
      { content: 'second', dest: `${clonePath}/tmp/.pi-agent/second.json` },
    ];
    const plan = buildBwrapPlan({ clonePath, command: ['pi'], injectedFiles });

    const expectedInjected: BwrapInjectedFile[] = [
      { fd: 3, dest: injectedFiles[0].dest, content: injectedFiles[0].content },
      { fd: 4, dest: injectedFiles[1].dest, content: injectedFiles[1].content },
    ];
    expect(plan.injectedFiles).toEqual(expectedInjected);

    expect(plan.bwrapArgs).toEqual([
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--file', '3', injectedFiles[0].dest,
      '--file', '4', injectedFiles[1].dest,
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
  });

  it('defaults injectedFiles to [] and emits no --file tokens when none are given', () => {
    const plan = buildBwrapPlan({ clonePath, command: ['pi'] });
    expect(plan.injectedFiles).toEqual([]);
    expect(plan.bwrapArgs).not.toContain('--file');
  });
});

// ---------------------------------------------------------------------------
// buildBwrapPlan — write_scope sparse binds (mirrors buildJailArgs above)
// ---------------------------------------------------------------------------

describe('buildBwrapPlan — write_scope sparse binds', () => {
  it('ro-binds the clone, then rw-binds each write_scope path, with --tmpfs /tmp present', () => {
    const plan = buildBwrapPlan({ clonePath, writeScope: ['src/', 'test/'], command: ['pi'] });
    expect(plan.bwrapArgs).toEqual([
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--ro-bind', clonePath, clonePath,
      '--bind', `${clonePath}/src`, `${clonePath}/src`,
      '--bind', `${clonePath}/test`, `${clonePath}/test`,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
  });

  it('keeps the clone fully writable (legacy shape) when writeScope is absent', () => {
    const plan = buildBwrapPlan({ clonePath, unshareNet: true, command: ['pi'] });
    const roBindMounts = plan.mounts.filter((m) => m.kind === 'ro-bind');
    expect(roBindMounts).toHaveLength(1); // only the mandatory root ro-bind
    const cloneMount: BwrapMount | undefined = plan.mounts.find((m) => m.dst === clonePath);
    expect(cloneMount).toEqual({ kind: 'bind', src: clonePath, dst: clonePath });
  });

  it('ro-binds the clone with zero write binds when writeScope is an empty array (the code_review shape), but still writably binds .dispatch-out/', () => {
    const plan = buildBwrapPlan({ clonePath, writeScope: [], command: ['pi'] });
    expect(plan.bwrapArgs).toEqual([
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--ro-bind', clonePath, clonePath,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildBwrapPlan — data mounts (mirrors buildJailArgs above)
// ---------------------------------------------------------------------------

describe('buildBwrapPlan — data mounts', () => {
  it('ro data mount produces --ro-bind, reflected in both bwrapArgs and mounts', () => {
    const plan = buildBwrapPlan({ clonePath, dataMounts: ['ro:/data/ref'], command: ['pi'] });
    expect(plan.bwrapArgs).toEqual([
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--ro-bind', '/data/ref', '/data/ref',
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
    expect(plan.mounts).toEqual(expect.arrayContaining([{ kind: 'ro-bind', src: '/data/ref', dst: '/data/ref' }]));
  });

  it('rw data mount produces --bind, reflected in both bwrapArgs and mounts', () => {
    const plan = buildBwrapPlan({ clonePath, dataMounts: ['rw:/tmp/scratch'], command: ['pi'] });
    expect(plan.bwrapArgs).toEqual([
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--bind', '/tmp/scratch', '/tmp/scratch',
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
    expect(plan.mounts).toEqual(expect.arrayContaining([{ kind: 'bind', src: '/tmp/scratch', dst: '/tmp/scratch' }]));
  });

  it('skips malformed data_mounts entries silently, same as buildJailArgs', () => {
    const plan = buildBwrapPlan({ clonePath, dataMounts: ['garbage', 'ro:/data/ref'], command: ['pi'] });
    expect(plan.bwrapArgs).toEqual([
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--ro-bind', '/data/ref', '/data/ref',
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildBwrapPlan — dual-shape wiki read axis (mirrors buildJailArgs above)
// ---------------------------------------------------------------------------

describe('buildBwrapPlan — wiki read axis (T25/D19)', () => {
  it('tracked + implement: masks wiki with --tmpfs', () => {
    const plan = buildBwrapPlan({ clonePath, wikiShape: 'tracked', mode: 'implement', command: ['pi'] });
    expect(plan.bwrapArgs).toEqual([
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--tmpfs', `${clonePath}/wiki`,
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
  });

  it('tracked + redteam: no wiki mask — wiki stays visible as part of the clone', () => {
    const plan = buildBwrapPlan({ clonePath, wikiShape: 'tracked', mode: 'redteam', command: ['pi'] });
    expect(plan.bwrapArgs).not.toContain(`${clonePath}/wiki`);
    // Only the mandatory root ro-bind is present — no wiki mask was added.
    expect(plan.mounts.filter((m) => m.kind === 'ro-bind')).toHaveLength(1);
  });

  it('nested-private + research with motherWikiPath: ro-binds the mother wiki into the clone', () => {
    const motherWikiPath = '/home/user/kb-dev-rig/wiki';
    const plan = buildBwrapPlan({
      clonePath,
      wikiShape: 'nested-private',
      mode: 'research',
      motherWikiPath,
      command: ['pi'],
    });
    expect(plan.bwrapArgs).toEqual([
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--bind', `${clonePath}/.dispatch-out`, `${clonePath}/.dispatch-out`,
      '--ro-bind', motherWikiPath, `${clonePath}/wiki`,
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
  });

  it('nested-private + redteam WITHOUT motherWikiPath: no wiki bind — nothing to bind against', () => {
    const plan = buildBwrapPlan({ clonePath, wikiShape: 'nested-private', mode: 'redteam', command: ['pi'] });
    expect(plan.mounts.filter((m) => m.dst === `${clonePath}/wiki`)).toHaveLength(0);
    // Only the mandatory root ro-bind is present (the .dispatch-out/ bind is a plain 'bind', not 'ro-bind').
    expect(plan.mounts.filter((m) => m.kind === 'ro-bind')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildBwrapPlan — command always follows "--" (contrast with buildJailArgs)
// ---------------------------------------------------------------------------

describe('buildBwrapPlan — no trailing bare "--"', () => {
  it('embeds the full worker command right after "--", unlike buildJailArgs which leaves a bare "--" for the caller to append to', () => {
    const command = ['pi', '-p', '--mode', 'json'];
    const plan = buildBwrapPlan({ clonePath, command });
    const jailArgv = buildJailArgs({ clonePath }).argv;

    // buildJailArgs's contract: caller appends the worker invocation after a bare '--'.
    expect(jailArgv[jailArgv.length - 1]).toBe('--');

    // buildBwrapPlan already embeds the command: the '--' terminator appears
    // exactly once, immediately followed by every command token, in order.
    const dashIdx = plan.bwrapArgs.indexOf('--');
    expect(plan.bwrapArgs.lastIndexOf('--')).toBe(dashIdx);
    expect(plan.bwrapArgs.slice(dashIdx + 1)).toEqual(command);
    expect(plan.bwrapArgs[plan.bwrapArgs.length - 1]).not.toBe('--');
  });
});

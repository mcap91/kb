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
  SYSTEM_ROOTS,
  type BwrapInjectedFile,
  type BwrapMount,
  type JailOpts,
} from '../packages/dispatch-core/src/jail.js';

const clonePath = '/home/user/.kb-dispatch/clones/RUN-JAIL';

/** Expected system-root args for test assertions (DEC-0011: replaces the former whole-root `--ro-bind / /`). */
function expectedSystemRootArgs(): string[] {
  return SYSTEM_ROOTS.flatMap((root) => ['--ro-bind-try', root, root]);
}

/** Expected system-root structured mounts, mirroring `expectedSystemRootArgs` for `plan.mounts` assertions. */
function expectedSystemRootMounts(): BwrapMount[] {
  return SYSTEM_ROOTS.map((root) => ({ kind: 'ro-bind-try', src: root, dst: root }));
}

// ---------------------------------------------------------------------------
// buildJailArgs — write_scope sparse binds
// ---------------------------------------------------------------------------

describe('buildJailArgs — write_scope sparse binds', () => {
  it('ro-binds the clone, then rw-binds each write_scope path, with --tmpfs /tmp present', () => {
    const result = buildJailArgs({ clonePath, writeScope: ['src/', 'test/'] });
    expect(result.argv).toEqual([
      'bwrap',
      ...expectedSystemRootArgs(),
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
    // No exact --ro-bind appears (system roots are --ro-bind-try, DEC-0011);
    // the clone itself binds writable because writeScope was never provided.
    const roBindCount = result.argv.filter((tok) => tok === '--ro-bind').length;
    expect(roBindCount).toBe(0);
    const bindIdx = result.argv.indexOf('--bind');
    expect(result.argv[bindIdx + 1]).toBe(clonePath);
    expect(result.argv[bindIdx + 2]).toBe(clonePath);
  });

  it('ro-binds the clone with zero write binds when writeScope is an empty array (the code_review shape)', () => {
    const result = buildJailArgs({ clonePath, writeScope: [] });
    expect(result.argv).toEqual([
      'bwrap',
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
    ]);
    // No exact --ro-bind is present (system roots are --ro-bind-try, DEC-0011) — no wiki bind was added either.
    expect(result.argv.filter((tok) => tok === '--ro-bind').length).toBe(0);
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
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
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
      'pi', '-p',
    ]);
    expect(plan.mounts.slice(0, SYSTEM_ROOTS.length)).toEqual(expectedSystemRootMounts());
    expect(plan.mounts[SYSTEM_ROOTS.length]).toEqual({ kind: 'proc', dst: '/proc' });
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
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
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
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--ro-bind', clonePath, clonePath,
      '--bind', `${clonePath}/src`, `${clonePath}/src`,
      '--bind', `${clonePath}/test`, `${clonePath}/test`,
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
  });

  it('keeps the clone fully writable (legacy shape) when writeScope is absent', () => {
    const plan = buildBwrapPlan({ clonePath, unshareNet: true, command: ['pi'] });
    const roBindMounts = plan.mounts.filter((m) => m.kind === 'ro-bind');
    expect(roBindMounts).toHaveLength(0); // system roots are ro-bind-try (DEC-0011), not ro-bind
    const cloneMount: BwrapMount | undefined = plan.mounts.find((m) => m.dst === clonePath);
    expect(cloneMount).toEqual({ kind: 'bind', src: clonePath, dst: clonePath });
  });

  it('ro-binds the clone with zero write binds when writeScope is an empty array (the code_review shape)', () => {
    const plan = buildBwrapPlan({ clonePath, writeScope: [], command: ['pi'] });
    expect(plan.bwrapArgs).toEqual([
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--ro-bind', clonePath, clonePath,
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
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
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
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
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
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
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
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--tmpfs', `${clonePath}/wiki`,
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
  });

  it('tracked + redteam: no wiki mask — wiki stays visible as part of the clone', () => {
    const plan = buildBwrapPlan({ clonePath, wikiShape: 'tracked', mode: 'redteam', command: ['pi'] });
    expect(plan.bwrapArgs).not.toContain(`${clonePath}/wiki`);
    // No exact ro-bind is present (system roots are ro-bind-try, DEC-0011) — no wiki mask was added.
    expect(plan.mounts.filter((m) => m.kind === 'ro-bind')).toHaveLength(0);
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
      ...expectedSystemRootArgs(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--ro-bind', motherWikiPath, `${clonePath}/wiki`,
      '--chdir', clonePath,
      '--',
      'pi',
    ]);
  });

  it('nested-private + redteam WITHOUT motherWikiPath: no wiki bind — nothing to bind against', () => {
    const plan = buildBwrapPlan({ clonePath, wikiShape: 'nested-private', mode: 'redteam', command: ['pi'] });
    expect(plan.mounts.filter((m) => m.dst === `${clonePath}/wiki`)).toHaveLength(0);
    // No exact ro-bind is present (system roots are ro-bind-try, DEC-0011).
    expect(plan.mounts.filter((m) => m.kind === 'ro-bind')).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// DEC-0011 visibility wall assertions (WK-0103) — permanent enforcement,
// every build, forever (s6c0-rulings.md Wave 1 item 4 / WK-0103 acceptance
// criteria: "no `/` bind in any emitted plan; `$HOME` not present except the
// family's auth leaf; auth leaf exact path + correct ro/rw per mode;
// declared data_mounts present, undeclared paths absent").
//
// jail.ts itself has no notion of "family" — systemRoots, toolchainPaths,
// and authLeafBinds are opts a family-aware CALLER (pipeline.ts, Wave 2)
// populates. These tests build the opts each family WOULD receive, per the
// evidence captured for this wave: pi/codex/claude CLIs live under
// ~/.npm-global-wsl/ (under $HOME — needs an exact toolchainPaths leaf);
// claude's auth leaf is ~/.claude/.credentials.json (rw for implement, ro
// for advisory modes, e.g. code_review); codex's is ~/.codex/auth.json
// (ro); Pi needs no auth leaf at all (its API key is env-injected and
// PI_CODING_AGENT_DIR lives on the jail's own /tmp tmpfs) — and assert
// buildJailArgs/buildBwrapPlan render them correctly.
// ---------------------------------------------------------------------------

describe('DEC-0011 visibility wall assertions (WK-0103)', () => {
  const HOME = '/home/testuser';
  type Family = 'pi' | 'codex' | 'claude';
  const families: Family[] = ['pi', 'codex', 'claude'];

  /** The toolchain + auth-leaf opts a family-aware caller would pass for `mode`. */
  function familyOpts(family: Family, mode: string): JailOpts {
    const toolchainPaths = [`${HOME}/.npm-global-wsl/bin/${family}`];
    if (family === 'claude') {
      return {
        clonePath,
        mode,
        toolchainPaths,
        authLeafBinds: [{ path: `${HOME}/.claude/.credentials.json`, access: mode === 'implement' ? 'rw' : 'ro' }],
      };
    }
    if (family === 'codex') {
      return {
        clonePath,
        mode,
        toolchainPaths,
        authLeafBinds: [{ path: `${HOME}/.codex/auth.json`, access: 'ro' }],
      };
    }
    // pi: no auth leaf at all — API key is env-injected, PI_CODING_AGENT_DIR lives on the jail's own tmpfs.
    return { clonePath, mode, toolchainPaths };
  }

  it('1. no plan for any family contains a whole-root "--ro-bind / /" bind', () => {
    for (const family of families) {
      const { argv } = buildJailArgs(familyOpts(family, 'implement'));
      let sawWholeRootBind = false;
      for (let i = 0; i + 2 < argv.length; i++) {
        if (argv[i] === '--ro-bind' && argv[i + 1] === '/' && argv[i + 2] === '/') sawWholeRootBind = true;
      }
      expect(sawWholeRootBind).toBe(false);
    }
  });

  it('2. no $HOME directory bind exists for any family — only the exact declared auth leaf', () => {
    for (const family of families) {
      // Auth-leaf-only fixture (no toolchainPaths) isolates the property under
      // test: $HOME is visible ONLY through the declared auth leaf, nothing
      // broader (toolchain-leaf exemption is proven separately by test 4).
      const opts: JailOpts =
        family === 'claude'
          ? { clonePath, mode: 'implement', authLeafBinds: [{ path: `${HOME}/.claude/.credentials.json`, access: 'rw' }] }
          : family === 'codex'
            ? { clonePath, mode: 'implement', authLeafBinds: [{ path: `${HOME}/.codex/auth.json`, access: 'ro' }] }
            : { clonePath, mode: 'implement' }; // pi: no auth leaf binds at all

      const { mounts } = buildBwrapPlan({ ...opts, command: ['agent'] });
      const authLeafPaths = new Set((opts.authLeafBinds ?? []).map((l) => l.path));
      const homeSrcs = mounts
        .map((m) => m.src)
        .filter((src): src is string => typeof src === 'string' && src.startsWith(HOME));

      if (family === 'pi') {
        expect(homeSrcs).toHaveLength(0);
      }
      for (const src of homeSrcs) {
        expect(authLeafPaths.has(src)).toBe(true);
      }
    }
  });

  describe('3. auth leaf binds: exact path + correct access per family/mode', () => {
    it('claude implement: ~/.claude/.credentials.json is writable', () => {
      const path = `${HOME}/.claude/.credentials.json`;
      const plan = buildBwrapPlan({
        clonePath,
        mode: 'implement',
        authLeafBinds: [{ path, access: 'rw' }],
        command: ['claude'],
      });
      expect(plan.mounts).toEqual(expect.arrayContaining([{ kind: 'bind', src: path, dst: path }]));
    });

    it('claude advisory (code_review): ~/.claude/.credentials.json is read-only', () => {
      const path = `${HOME}/.claude/.credentials.json`;
      const plan = buildBwrapPlan({
        clonePath,
        mode: 'code_review',
        authLeafBinds: [{ path, access: 'ro' }],
        command: ['claude'],
      });
      expect(plan.mounts).toEqual(expect.arrayContaining([{ kind: 'ro-bind', src: path, dst: path }]));
    });

    it('codex: ~/.codex/auth.json is read-only', () => {
      const path = `${HOME}/.codex/auth.json`;
      const plan = buildBwrapPlan({
        clonePath,
        mode: 'implement',
        authLeafBinds: [{ path, access: 'ro' }],
        command: ['codex'],
      });
      expect(plan.mounts).toEqual(expect.arrayContaining([{ kind: 'ro-bind', src: path, dst: path }]));
    });

    it('pi: no auth leaf binds at all', () => {
      const plan = buildBwrapPlan({ clonePath, mode: 'implement', command: ['pi', '-p'] });
      const homeMounts = plan.mounts.filter((m) => m.src !== undefined && m.src.startsWith(HOME));
      expect(homeMounts).toHaveLength(0);
    });
  });

  it('4. toolchain paths are bound --ro-bind-try, as exact leaves', () => {
    const toolchainPaths = [
      `${HOME}/.npm-global-wsl/bin/pi`,
      `${HOME}/.npm-global-wsl/lib/node_modules/pi-agent/index.js`,
    ];

    const { argv } = buildJailArgs({ clonePath, toolchainPaths });
    for (const p of toolchainPaths) {
      const idx = argv.indexOf(p);
      expect(idx).toBeGreaterThan(0);
      expect(argv[idx - 1]).toBe('--ro-bind-try');
    }

    const plan = buildBwrapPlan({ clonePath, toolchainPaths, command: ['pi'] });
    for (const p of toolchainPaths) {
      expect(plan.mounts).toEqual(expect.arrayContaining([{ kind: 'ro-bind-try', src: p, dst: p }]));
    }
  });

  it('5. declared data_mounts are present; an undeclared path never appears anywhere in the plan', () => {
    const declared = '/opt/central-envs/team-foo'; // e.g. an operator-declared conda env dir (s6c0-rulings.md ruling 6)
    const undeclared = `${HOME}/.ssh/id_rsa`;

    const { argv } = buildJailArgs({ clonePath, dataMounts: [`ro:${declared}`] });
    expect(argv).toEqual(expect.arrayContaining(['--ro-bind', declared, declared]));
    expect(argv).not.toContain(undeclared);
  });
});

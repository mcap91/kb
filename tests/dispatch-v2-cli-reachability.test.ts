/**
 * WK-0174 — jail CLI reachability: resolve-first + absolute-path exec +
 * preflight probe. Covers the two seams SRC-0013 (fnm multishell live
 * capture) proved broken: `resolveToolchainPaths`'s $HOME-gate-before-resolve
 * ordering (pipeline.ts), and the preflight viability probe binding the whole
 * root instead of the curated SYSTEM_ROOTS jail (tier.ts/preflight.ts).
 *
 * `execBash` is mocked at the `exec-direct.js` module boundary — the same
 * seam pipeline.ts's `resolveToolchainPaths` and preflight.ts's
 * `runPreflight` both call through — so these tests run with no real
 * bash/bwrap round trip, mirroring dispatch-v2-tier.test.ts's
 * mock-at-the-primitive convention.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../packages/dispatch-core/src/exec-direct.js', () => ({
  execBash: vi.fn(),
}));

import { execBash, type ExecBashResult } from '../packages/dispatch-core/src/exec-direct.js';
import type { DispatchResult } from '../packages/dispatch-core/src/errors.js';
import { V2_REFUSAL_CODES } from '../packages/dispatch-core/src/errors.js';
import {
  resolveToolchainPaths,
  buildJailPathExport,
  type ToolchainResolution,
} from '../packages/dispatch-core/src/pipeline.js';
import { runPreflight } from '../packages/dispatch-core/src/preflight.js';

const mockExecBash = vi.mocked(execBash);

function ok(stdout: string): DispatchResult<ExecBashResult> {
  return { ok: true, data: { exitCode: 0, stdout, stderr: '' } };
}

/** SRC-0013 first capture: fnm default multishell, claude backend. */
const MULTISHELL_CLAUDE = '/run/user/1000/fnm_multishells/115879_1790630714834/bin/claude';
const MULTISHELL_NODE = '/run/user/1000/fnm_multishells/115879_1790630714834/bin/node';
const FNM_HOME = '/home/user';
const FNM_CLAUDE_REAL = `${FNM_HOME}/.local/share/fnm/node-versions/v22.23.2/installation/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`;
const FNM_NODE_REAL = `${FNM_HOME}/.local/share/fnm/node-versions/v22.23.2/installation/bin/node`;
const FNM_NPM_PREFIX = `${FNM_HOME}/.local/share/fnm/node-versions/v22.23.2/installation`;

/**
 * Wire the mocked `execBash` to answer `command -v <cli>` / `readlink -f
 * <path>` / `npm prefix -g` for one resolveToolchainPaths() call, keyed off
 * scriptContent substrings (mirrors dispatch-v2-tier.test.ts's
 * args[0]-keyed `mockBwrap` convention, adapted to execBash's single
 * scriptContent string).
 */
function wireResolution(opts: {
  cliWhich: string | null;
  cliReal: string | null;
  nodeWhich: string | null;
  nodeReal: string | null;
  npmPrefix: string | null;
}): void {
  mockExecBash.mockImplementation(async ({ scriptContent }) => {
    if (scriptContent.startsWith('command -v claude')) return ok(opts.cliWhich ?? '');
    if (scriptContent.startsWith('command -v node')) return ok(opts.nodeWhich ?? '');
    if (scriptContent.startsWith('npm prefix -g')) return ok(opts.npmPrefix ?? '');
    if (scriptContent.startsWith(`readlink -f ${opts.cliWhich}`)) return ok(opts.cliReal ?? '');
    if (scriptContent.startsWith(`readlink -f ${opts.nodeWhich}`)) return ok(opts.nodeReal ?? '');
    return ok('');
  });
}

describe('resolveToolchainPaths — resolve-first (WK-0174, SRC-0013)', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    mockExecBash.mockReset();
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('resolves an fnm multishell CLI path to its real $HOME target, not null (SRC-0013 first capture)', async () => {
    process.env.HOME = FNM_HOME;
    wireResolution({
      cliWhich: MULTISHELL_CLAUDE,
      cliReal: FNM_CLAUDE_REAL,
      nodeWhich: MULTISHELL_NODE,
      nodeReal: FNM_NODE_REAL,
      npmPrefix: FNM_NPM_PREFIX,
    });

    const result = await resolveToolchainPaths('claude');

    expect(result.cliRealPath).toBe(FNM_CLAUDE_REAL);
    expect(result.nodeRealDir).toBe(`${FNM_HOME}/.local/share/fnm/node-versions/v22.23.2/installation/bin`);
    expect(result.npmPrefix).toBe(FNM_NPM_PREFIX);
    expect(result.unmountable).toBeNull();
    // The old $HOME-gate-before-resolve order would have discarded the
    // /run/user/... `which` result outright and returned nothing; resolve-first
    // recovers the real, bindable $HOME path instead.
    expect(result.bindPaths).toContain(FNM_NPM_PREFIX);
  });

  it('sets `unmountable` when a resolved real path lands outside $HOME and SYSTEM_ROOTS', async () => {
    process.env.HOME = FNM_HOME;
    const outsidePath = '/mnt/external-toolchain/bin/node';
    wireResolution({
      cliWhich: MULTISHELL_CLAUDE,
      cliReal: FNM_CLAUDE_REAL,
      nodeWhich: outsidePath,
      nodeReal: outsidePath,
      npmPrefix: FNM_NPM_PREFIX,
    });

    const result = await resolveToolchainPaths('claude');

    expect(result.unmountable).not.toBeNull();
    expect(result.unmountable?.what).toBe('node');
    expect(result.unmountable?.resolvedPath).toBe('/mnt/external-toolchain/bin');
  });

  it('CLI_PATH_NOT_MOUNTABLE is a registered v2 refusal code', () => {
    expect(V2_REFUSAL_CODES).toContain('CLI_PATH_NOT_MOUNTABLE');
  });
});

describe('PATH-independent launch plan (WK-0174 acceptance criterion 3, SRC-0013 both captures)', () => {
  beforeEach(() => {
    mockExecBash.mockReset();
  });

  afterEach(() => {
    delete process.env.HOME;
  });

  /**
   * SRC-0013's second capture proved `readlink -f` resolves the SAME real
   * $HOME-backed target whether `which` lands on the fnm multishell tmpfs
   * path or a `~/.local/bin` workaround symlink — the fix's resolve-first
   * order makes the launch plan depend only on that real target, never on
   * which PATH entry `command -v` happened to find first.
   */
  it('produces identical cliRealPath / PATH export under an fnm-multishell PATH and a clean PATH', async () => {
    process.env.HOME = FNM_HOME;

    // Environment A: fnm default multishell PATH (SRC-0013 first capture).
    wireResolution({
      cliWhich: MULTISHELL_CLAUDE,
      cliReal: FNM_CLAUDE_REAL,
      nodeWhich: MULTISHELL_NODE,
      nodeReal: FNM_NODE_REAL,
      npmPrefix: FNM_NPM_PREFIX,
    });
    const resultA = await resolveToolchainPaths('claude');

    // Environment B: a clean PATH resolving straight to the ~/.local/bin
    // workaround symlink (SRC-0013 second capture) — `command -v` finds a
    // different entry, but `readlink -f` lands on the identical real target.
    const cleanWhichClaude = `${FNM_HOME}/.local/bin/claude`;
    const cleanWhichNode = `${FNM_HOME}/.local/bin/node`;
    wireResolution({
      cliWhich: cleanWhichClaude,
      cliReal: FNM_CLAUDE_REAL,
      nodeWhich: cleanWhichNode,
      nodeReal: FNM_NODE_REAL,
      npmPrefix: FNM_NPM_PREFIX,
    });
    const resultB = await resolveToolchainPaths('claude');

    expect(resultA.cliRealPath).toBe(resultB.cliRealPath);
    expect(resultA.nodeRealDir).toBe(resultB.nodeRealDir);
    expect(resultA.npmPrefix).toBe(resultB.npmPrefix);
    expect(resultA.unmountable).toBeNull();
    expect(resultB.unmountable).toBeNull();

    // The exec line construction itself (pipeline.ts's codex/claude branches)
    // uses the absolute cliRealPath, never a bare name — assert both
    // environments would splice the identical exec target/PATH into the
    // in-jail inner script.
    const execTargetA = `exec ${resultA.cliRealPath}`;
    const execTargetB = `exec ${resultB.cliRealPath}`;
    expect(execTargetA).toBe(execTargetB);
    expect(buildJailPathExport(resultA)).toBe(buildJailPathExport(resultB));
  });

  it('buildJailPathExport sets PATH from resolved node/npm dirs plus system roots', () => {
    const toolchain: ToolchainResolution = {
      cliRealPath: FNM_CLAUDE_REAL,
      nodeRealDir: `${FNM_HOME}/.local/share/fnm/node-versions/v22.23.2/installation/bin`,
      npmPrefix: FNM_NPM_PREFIX,
      bindPaths: [FNM_NPM_PREFIX],
      unmountable: null,
    };

    const pathExport = buildJailPathExport(toolchain);

    expect(pathExport).toContain(toolchain.nodeRealDir as string);
    expect(pathExport).toContain(`${FNM_NPM_PREFIX}/bin`);
    expect(pathExport).toContain('/usr/bin');
    expect(pathExport).toContain('/bin');
    expect(pathExport).toContain('/usr/sbin');
    expect(pathExport).toContain('/sbin');
  });
});

describe('preflight probe uses the curated SYSTEM_ROOTS jail, not --ro-bind / / (WK-0174)', () => {
  beforeEach(() => {
    mockExecBash.mockReset();
    mockExecBash.mockResolvedValue(
      ok(['BWRAP_PATH=/usr/bin/bwrap', 'BWRAP_VERSION=bubblewrap 0.10.0', 'PI_VERSION=MISSING', 'UNSHARE_USER=OK', 'APPARMOR_USERNS=0'].join('\n')),
    );
  });

  it('runs a curated SYSTEM_ROOTS bwrap probe rather than a whole-root bind', async () => {
    const result = await runPreflight();
    expect(result.ok).toBe(true);

    expect(mockExecBash).toHaveBeenCalledTimes(1);
    const scriptContent = mockExecBash.mock.calls[0]?.[0]?.scriptContent ?? '';

    expect(scriptContent).not.toContain('--ro-bind / /');
    expect(scriptContent).not.toMatch(/--ro-bind\s+\/\s+\/\s/);
    for (const root of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/var']) {
      expect(scriptContent).toContain(`--ro-bind-try ${root} ${root}`);
    }
    expect(scriptContent).toContain('--proc /proc');
    expect(scriptContent).toContain('--dev /dev');
  });
});

/**
 * The eval harness's own bwrap argv builder (WK-0237 scope item 5, as
 * amended by scope 17/18 and Resolutions 9). Deliberately standalone: it does
 * not call dispatch-core's `buildJailArgs`/`buildBwrapPlan` or reuse any
 * dispatch pipeline code (HO-0111 findings 1-2 — those pieces give no home
 * and no network route outside the pipeline, and the pipeline masks
 * `<clone>/.claude/`, which would hide the skill/command under test). The
 * only dispatch-core import anywhere in evals/ is `SYSTEM_ROOTS`.
 *
 * Fixed jail layout (scope 5, 17.3, Resolutions 9):
 *   - every `systemRoots` entry: --ro-bind-try (absent roots skipped, not fatal)
 *   - if `resolvConfRealpath` is given and lies outside every `systemRoots`
 *     entry: --ro-bind at its own path, right after the system roots
 *     (WK-0237 slice A.1 — on WSL2 /etc/resolv.conf's realpath is
 *     /mnt/wsl/resolv.conf, outside the /etc system-root bind, so the
 *     dangling symlink breaks DNS unless the real target is bound too;
 *     paths.ts's discoverHostPaths refuses a realpath under the operator's
 *     home before it ever reaches here)
 *   - /proc, /dev, writable /tmp
 *   - --die-with-parent, --unshare-pid, --unshare-ipc, --new-session
 *   - --clearenv, then HOME=/home/eval, USER=eval,
 *     PATH=/tools/claude-code/bin:/usr/local/bin:/usr/bin:/bin,
 *     DISABLE_AUTOUPDATER=1
 *   - /home/eval: writable bind from `runHome` (BEFORE the credentials bind)
 *   - the host credentials file: read-only at /home/eval/.claude/.credentials.json
 *   - test_kb: writable bind at /home/eval/test_kb (the --chdir target)
 *   - the kb checkout: read-only bind at /kb (Resolutions 9 — /opt/kb fails,
 *     bwrap cannot mkdir under the read-only /opt system root), BEFORE an
 *     empty --tmpfs masking /kb/wiki (kb's own ledger/rulings stay hidden)
 *   - the Claude CLI package dir: read-only bind at the neutral path
 *     /tools/claude-code
 *   - network shared: no --unshare-net
 *   - --chdir /home/eval/test_kb --
 *
 * Pure and synchronous, like dispatch-core's `buildJailArgs` — assembles an
 * argv array, touches no filesystem, spawns nothing, cannot fail. Returns
 * the argv WITHOUT a leading 'bwrap' program name, ready for
 * `spawn('bwrap', argv, ...)` (launch.ts's convention) — the caller appends
 * the worker command after the trailing `--`.
 */

export const EVAL_HOME = '/home/eval';
export const EVAL_CREDENTIALS_PATH = '/home/eval/.claude/.credentials.json';
export const EVAL_TEST_KB_PATH = '/home/eval/test_kb';
export const EVAL_KB_ROOT_PATH = '/kb';
export const EVAL_KB_WIKI_PATH = '/kb/wiki';
export const EVAL_CLI_PACKAGE_DIR = '/tools/claude-code';

export interface EvalJailOpts {
  /** dispatch-core's `SYSTEM_ROOTS` — curated system-root dirs bound read-only-try. */
  systemRoots: readonly string[];
  /** Host path bound writable at /home/eval (the run dir's `home/`). */
  runHome: string;
  /** Host path to the Claude credentials file, bound read-only at /home/eval/.claude/.credentials.json. */
  credentialsFile: string;
  /** Host path to the test_kb fixture repo, bound writable at /home/eval/test_kb. */
  testKb: string;
  /** Host path to the kb checkout, bound read-only at /kb (with /kb/wiki masked). */
  kbRoot: string;
  /** Host path to the Claude CLI's npm package directory, bound read-only at /tools/claude-code. */
  cliPackageDir: string;
  /** Host realpath of /etc/resolv.conf (paths.ts's discoverHostPaths), or null/omitted when there is nothing to bind. Bound at its own path, read-only, when it lies outside every `systemRoots` entry. */
  resolvConfRealpath?: string | null;
}

/** Build the eval harness's bwrap argv. Ends in `--chdir /home/eval/test_kb --`; the caller appends the worker command (claude-argv.ts's `buildClaudeArgv`, prefixed with the in-jail CLI binary path). */
export function buildEvalJailArgs(opts: EvalJailOpts): string[] {
  const argv: string[] = [];

  for (const root of opts.systemRoots) {
    argv.push('--ro-bind-try', root, root);
  }

  if (
    opts.resolvConfRealpath != null &&
    !opts.systemRoots.some((root) => opts.resolvConfRealpath === root || opts.resolvConfRealpath!.startsWith(`${root}/`))
  ) {
    argv.push('--ro-bind', opts.resolvConfRealpath, opts.resolvConfRealpath);
  }

  argv.push('--proc', '/proc');
  argv.push('--dev', '/dev');
  argv.push('--tmpfs', '/tmp');

  argv.push('--die-with-parent', '--unshare-pid', '--unshare-ipc', '--new-session');

  argv.push(
    '--clearenv',
    '--setenv', 'HOME', EVAL_HOME,
    '--setenv', 'USER', 'eval',
    '--setenv', 'PATH', `${EVAL_CLI_PACKAGE_DIR}/bin:/usr/local/bin:/usr/bin:/bin`,
    '--setenv', 'DISABLE_AUTOUPDATER', '1',
  );

  argv.push('--bind', opts.runHome, EVAL_HOME);
  argv.push('--ro-bind', opts.credentialsFile, EVAL_CREDENTIALS_PATH);
  argv.push('--bind', opts.testKb, EVAL_TEST_KB_PATH);
  argv.push('--ro-bind', opts.kbRoot, EVAL_KB_ROOT_PATH);
  argv.push('--tmpfs', EVAL_KB_WIKI_PATH);
  argv.push('--ro-bind', opts.cliPackageDir, EVAL_CLI_PACKAGE_DIR);

  argv.push('--chdir', EVAL_TEST_KB_PATH, '--');

  return argv;
}

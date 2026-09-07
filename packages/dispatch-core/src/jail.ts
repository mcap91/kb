/**
 * Minimal bwrap args builder (T15 S0 minimum; spec §11 jail recipe).
 *
 * S0 binds PRE-EXISTING paths only — bwrap cannot mkdir a new directory under a
 * read-only root (WK-0074 probe 1: `bwrap --ro-bind / / --bind /tmp /workspace`
 * fails with "Can't mkdir /workspace: Read-only file system" when `/workspace` does
 * not already exist). The verified S0 pattern binds the clone path onto ITSELF — an
 * already-existing directory that clone.ts creates before bwrap ever runs — so no
 * mkdir under the ro root is required:
 *
 *   bwrap --ro-bind / / --bind <clonePath> <clonePath> --chdir <cwd> --
 *
 * `--ro-bind / /` makes the entire host filesystem read-only inside the jail; the
 * following `--bind <clonePath> <clonePath>` re-mounts just the clone directory
 * writable (bwrap applies binds in argument order). `--chdir` sets the jailed
 * process's cwd. The trailing `--` terminates bwrap's own argument list — the
 * caller (Wave 3 pipeline) appends the actual worker invocation argv after it.
 *
 * This is the S0 minimum only. S5 (full) adds write_scope sparse binds over
 * pre-created skeleton dirs, the dual-shape wiki read-axis mask, declared data
 * mounts, and profile mounts (spec §11) — none of that lands here.
 */

export interface JailOpts {
  /** Absolute path to the ext4 clone directory (inside WSL2). */
  clonePath: string;
  /** Working directory inside the jail (usually = clonePath). */
  cwd?: string;
}

export interface JailArgs {
  /** The bwrap argument array. Caller appends the worker invocation argv after this. */
  argv: string[];
}

/**
 * Build the S0-minimum bwrap argv for jailing a worker to its ephemeral clone.
 * Pure and synchronous — this only assembles an argument array, it never spawns
 * anything and cannot fail, so it does not return a `DispatchResult`.
 */
export function buildJailArgs(opts: JailOpts): JailArgs {
  const cwd = opts.cwd ?? opts.clonePath;
  return {
    argv: [
      'bwrap',
      '--ro-bind', '/', '/',
      '--bind', opts.clonePath, opts.clonePath,
      '--chdir', cwd,
      '--',
    ],
  };
}

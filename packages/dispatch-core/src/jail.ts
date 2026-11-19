/**
 * bwrap args builder (T15; spec §11 jail recipe).
 *
 * bwrap can only bind PRE-EXISTING paths — it cannot mkdir a new directory
 * under a read-only root (WK-0074 probe 1: `bwrap --ro-bind / / --bind /tmp
 * /workspace` fails with "Can't mkdir /workspace: Read-only file system" when
 * `/workspace` does not already exist). That constraint governs every path
 * this module binds — the clone, each write_scope entry, the wiki directory,
 * data mounts, the tunnel socket, the relay script — they MUST already exist
 * on disk. Pipeline.ts (W2) is responsible for pre-creating write_scope
 * skeleton dirs before calling `buildJailArgs`; this module ONLY assembles
 * the argv array. It is pure and synchronous — no I/O, no process spawning —
 * and cannot fail, so it never returns a `DispatchResult`.
 *
 * ## S5 full recipe (spec §11), applied in argument order — bwrap resolves
 * later binds over earlier ones:
 *
 *   1.  --ro-bind-try <root> <root>   curated system roots only (DEC-0011,
 *                                      WK-0103 visibility wall — replaces the
 *                                      former whole-root `--ro-bind / /`; see
 *                                      SYSTEM_ROOTS)
 *   2.  --proc /proc                  live procfs (child spawning)
 *   3.  --dev /dev                    device nodes (WK-0086: `nodev` on the
 *                                      ro-bind root broke nested bash spawn)
 *   4.  --tmpfs /tmp                  writable scratch space — Pi and other
 *                                      in-jail tooling need a writable /tmp;
 *                                      unconditional whenever the full S5
 *                                      recipe runs
 *   5.  --die-with-parent             cleanup on parent exit
 *   5a. --unshare-pid                 PID namespace (WK-0202: no host PID visibility)
 *   5b. --unshare-ipc                 IPC namespace (WK-0202, chassis baseline)
 *   5c. --new-session                 setsid (WK-0202, chassis baseline: no terminal signals)
 *   6.  --unshare-net                 opt-in (T26/D21): no network stack
 *   6-env. --clearenv + --setenv      opt-in allowlist env (WK-0294)
 *   6a. toolchain leaf binds (DEC-0011) --ro-bind-try each opts.toolchainPaths
 *                                      entry (CLI binaries living under $HOME)
 *   6b. runtime env binds              strict --ro-bind each
 *                                      opts.runtimeEnvPaths entry
 *                                      (operator-declared, admission-validated)
 *   6c. resolver bind                 jails that keep network only
 *                                      (`unshareNet === false`): if the
 *                                      resolv-conf path is a symlink whose
 *                                      realpath target lies outside the
 *                                      curated roots (WSL2:
 *                                      /etc/resolv.conf -> /mnt/wsl/resolv.conf,
 *                                      and /mnt is never bound), ro-bind-try
 *                                      exactly that target file at the same
 *                                      path — never its parent directory.
 *                                      Placed after step 4's unconditional
 *                                      `--tmpfs /tmp` (like the clone bind
 *                                      below) so a target under `/tmp` is
 *                                      never shadowed by it.
 *   7.  clone bind                    ro-bind first if write_scope is
 *                                      sparse, else writable (legacy shape)
 *   8.  write_scope binds             selective rw layered over step 7
 *   9.  wiki read axis (T25/D19)      dual-shape probe result decides bind
 *                                      source (clone's own wiki vs. mother
 *                                      bind) — visible to every mode
 *                                      (DEC-0039: mode-based masking retired)
 *   10. data mounts                   per-HO ro/rw binds (existence/
 *                                      absoluteness already §7.14-validated
 *                                      by the admission gate)
 *   11. tunnel socket bind (T26/D21)  egress-forwarder unix socket
 *   12. relay script bind (T26/D21)   in-jail relay, read-only
 *   13. secret-mask binds             `<clone>/.env` -> /dev/null,
 *                                      `<clone>/.claude` -> fresh tmpfs, each
 *                                      only when the path exists in the
 *                                      clone -- inlined here, immediately
 *                                      before the final bind below, so
 *                                      nothing can ever land after them
 *                                      again
 *   13a. run-dir read-only bind       `--ro-bind <runDir> <runDir>`: the
 *                                      run dir is worker-influenced content
 *                                      (prompt, logs), never a worker
 *                                      writable surface; read-only for
 *                                      every mode, emitted right before the
 *                                      final `.git` bind
 *   14. `.git` read-only bind         unconditional strict
 *                                      `--ro-bind <clone>/.git <clone>/.git`
 *                                      (not -try: a clone always has .git)
 *                                      -- the LAST mount operation of every
 *                                      plan, worker and host-validation
 *                                      alike
 *   15. --chdir <cwd>
 *   16. --                            terminates bwrap's own argv; the
 *                                      caller appends the worker invocation
 */
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';

import { SYSTEM_ROOTS } from './mountability.js';

/** Re-exported for existing external imports (mountability.ts owns the definition, WK-0201 fix-up F2). */
export { SYSTEM_ROOTS };

/** Wiki shape in the mother repo — the dual-shape read axis (T25, D19). */
export type WikiShape = 'tracked' | 'nested-private';

export interface JailOpts {
  /** Absolute path to the ext4 clone directory (inside WSL2). */
  clonePath: string;
  /** Working directory inside the jail (usually = clonePath). */
  cwd?: string;

  // --- S5 additions ---

  /** Relative paths under clonePath that the worker may write to (from HO write_scope).
   *  Each path gets a writable bind; everything else under clonePath stays read-only. */
  writeScope?: string[];
  /** Wiki shape — determines the wiki bind source (clone's own wiki/ when tracked, mother repo's wiki/ when nested-private). */
  wikiShape?: WikiShape;
  /** HO mode — retained for API compatibility; no longer gates wiki visibility (DEC-0039: wiki is visible to every mode). */
  mode?: string;
  /** Absolute path to the mother repo's wiki/ (for nested-private shape's mother wiki ro-bind, unconditional across modes — DEC-0039). */
  motherWikiPath?: string;
  /** Data mount declarations (data_mounts + export_mounts, already merged with a resolved access mode). */
  dataMounts?: ReadonlyArray<{ path: string; access: 'ro' | 'rw' }>;
  /** Whether to unshare the network namespace (true for S5 enforcement). */
  unshareNet?: boolean;
  /** Host path to the resolver config checked for the WK-0301 resolver bind
   *  (see `resolveResolvBindTarget`) — defaults to '/etc/resolv.conf'.
   *  Injectable so tests can point at a temp-dir fixture instead of the real
   *  host file; production callers never need to set it. Only consulted when
   *  `unshareNet` is explicitly `false` — a jail that keeps network. */
  resolvConfPath?: string;
  /** Path to the tunnel unix socket to bind-mount into the jail. */
  tunnelSocketPath?: string;
  /** Path inside the jail where the relay script lives (for bind-mounting). */
  relayScriptPath?: string;

  // --- DEC-0011 / WK-0103 additions: curated visibility wall ---

  /** Curated system-root dirs to bind read-only-try (replaces the whole-root bind).
   *  Default: SYSTEM_ROOTS constant. The caller may extend but never narrow. */
  systemRoots?: readonly string[];

  /** Toolchain paths under $HOME that the worker's CLI binary needs (resolved at
   *  dispatch time via `which`). Each gets an --ro-bind-try. */
  toolchainPaths?: readonly string[];

  /** Operator-declared runtime env roots (WK-0201), already canonicalized and
   *  validated by admission.ts's `checkRuntimeEnvs` (realpath'd, not $HOME
   *  itself, mountable, has a `bin/` dir, no export_mounts overlap). Each
   *  gets a strict --ro-bind — never --ro-bind-try, since the path was
   *  already proven to exist at admission time. */
  runtimeEnvPaths?: readonly string[];

  /** Absolute path to the run directory (prompt, relay script, tunnel socket,
   *  logs). Bound read-only — the worker reads its prompt, but never writes
   *  directly into the run dir (its stdout/stderr are captured elsewhere). */
  runDirPath?: string;

  /** Allowlist env (WK-0294, DEC-0047 A4.3): when set, bwrap starts the child
   *  with `--clearenv` and only these vars (`--setenv`), so nothing in the
   *  spawn env reaches it. Unset keeps bwrap's default env passthrough. */
  allowlistEnv?: Readonly<Record<string, string>>;
}

export interface JailArgs {
  /** The bwrap argument array. Caller appends the worker invocation argv after this. */
  argv: string[];
}

/**
 * Probe whether wiki/ is git-tracked in the mother repo (T25, D19).
 *
 * - 'tracked': the clone carries the wiki (the intended consuming-repo
 *   shape) — non-empty `git ls-files wiki/` output.
 * - 'nested-private': wiki/ is gitignored or lives in a separate repo (kb's
 *   own dev-rig shape) — empty `git ls-files wiki/` output.
 *
 * Pure and synchronous: this takes the ALREADY-CAPTURED stdout of
 * `git ls-files wiki/` — it never runs git itself. The caller (pipeline.ts,
 * W2) runs the command and passes its output through here. Never assume
 * either shape (DEC-0008 D19): kb's own repo is nested-private, but the
 * intended consuming-repo product shape is tracked — both must be handled.
 */
export function classifyWikiShape(lsFilesOutput: string): WikiShape {
  return lsFilesOutput.trim().length > 0 ? 'tracked' : 'nested-private';
}

/**
 * Join a write_scope-style relative path onto the clone root. Strips leading
 * and trailing slashes from the relative segment so both "src/" and "src"
 * (the write_scope directory-prefix convention — see delivery.ts's
 * `checkWriteScope`) resolve to the same bind target.
 */
function joinUnderClone(clonePath: string, relPath: string): string {
  const trimmed = relPath.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? `${clonePath}/${trimmed}` : clonePath;
}

/**
 * Resolver bind target for jails that keep network (WK-0301, Resolutions row
 * 1). `resolvPath` (`/etc/resolv.conf` or `opts.resolvConfPath`) can be a
 * symlink into a path outside the curated system roots — on WSL2 it targets
 * `/mnt/wsl/resolv.conf`, and `/mnt` is never bound (DEC-0011 deny-by-default
 * visibility). When it is, this resolves the realpath and returns that single
 * file so the caller can ro-bind-try it at the SAME absolute path — never its
 * parent directory. Returns `null` (nothing to bind) when: the path does not
 * exist; it is a regular file (already visible through the curated `/etc`
 * root bind, needs nothing extra); its target already lies under one of
 * `roots` (already visible); or it is a dangling symlink (`realpath` fails —
 * returning `null` here means bwrap itself never fails on a missing bind
 * target; the step that actually needs DNS fails on its own merits instead,
 * as evidence). Synchronous, matching this module's "cannot fail" contract.
 */
function resolveResolvBindTarget(resolvPath: string, roots: readonly string[]): string | null {
  let st;
  try {
    st = lstatSync(resolvPath);
  } catch {
    return null;
  }
  if (!st.isSymbolicLink()) return null;
  let target: string;
  try {
    target = realpathSync(resolvPath);
  } catch {
    return null;
  }
  if (roots.some((root) => target === root || target.startsWith(`${root}/`))) return null;
  return target;
}

/**
 * D6 (PLN-0004 `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md`
 * ruling 7, components 1-4): one internal step-builder that both
 * `buildJailArgs` (existing script-argv contract, pinned byte-for-byte by
 * `tests/dispatch-v2-jail.test.ts`) and `buildBwrapPlan` (new frozen-plan
 * contract, below) render from. The mount LOGIC here — write_scope sparse
 * binds, the T25/D19 wiki axis, data mounts, tunnel/relay binds — is
 * UNCHANGED from the walk `buildJailArgs` always did (same conditions, same
 * order, same values); it is only restructured to record each step twice
 * (a flat argv token pair AND a structured `{kind,src,dst}` record) instead
 * of once. Not exported — an implementation seam, not a public contract.
 */
interface JailPlanSteps {
  /** Steps 1-12 (system baseline through relay-script bind) as flat argv tokens — EXCLUDES the leading 'bwrap' program name and the trailing steps 13-14 (`--chdir <cwd>` + `--`), which each caller appends per its own contract. */
  mountArgv: string[];
  /** The same steps 1-12, structured — mirrors agent-chassis's plan-mounts `{src,dst}` shape (`launch-isolation-plan-mounts.mjs:185-499`). */
  mounts: BwrapMount[];
  /** Resolved --chdir target (`opts.cwd ?? opts.clonePath`). */
  cwd: string;
}

function buildJailPlanSteps(opts: JailOpts): JailPlanSteps {
  const cwd = opts.cwd ?? opts.clonePath;
  const mountArgv: string[] = [];
  const mounts: BwrapMount[] = [];

  const bind = (kind: 'ro-bind' | 'ro-bind-try' | 'bind', src: string, dst: string): void => {
    const flag = kind === 'ro-bind' ? '--ro-bind' : kind === 'ro-bind-try' ? '--ro-bind-try' : '--bind';
    mountArgv.push(flag, src, dst);
    mounts.push({ kind, src, dst });
  };
  const synthetic = (kind: 'tmpfs' | 'proc' | 'dev', dst: string): void => {
    mountArgv.push(kind === 'tmpfs' ? '--tmpfs' : kind === 'proc' ? '--proc' : '--dev', dst);
    mounts.push({ kind, dst });
  };

  // 1. Curated system-root ro-bind-try (DEC-0011: deny-by-default visibility;
  //    replaces the whole-root ro-bind that gave every jail blanket $HOME
  //    access). --ro-bind-try so a root absent on this host (e.g. /lib64 on
  //    a non-multilib arch) is silently skipped rather than failing bwrap.
  const roots = opts.systemRoots ?? SYSTEM_ROOTS;
  for (const root of roots) {
    bind('ro-bind-try', root, root);
  }
  // 2-3: live procfs + device nodes (unchanged since S0).
  synthetic('proc', '/proc');
  synthetic('dev', '/dev');
  // 4: writable scratch space — new at S5, unconditional whenever the full
  // recipe runs (Pi and other in-jail tooling need a writable /tmp).
  synthetic('tmpfs', '/tmp');
  // 5: cleanup on parent exit (unchanged since S0).
  mountArgv.push('--die-with-parent');
  // 5a-c: PID/IPC namespace + session isolation (WK-0202, chassis baseline).
  mountArgv.push('--unshare-pid', '--unshare-ipc', '--new-session');
  // 6: network namespace removal (T26/D21) — opt-in.
  if (opts.unshareNet) {
    mountArgv.push('--unshare-net');
  }
  // 6-env: allowlist env (WK-0294) — the child inherits nothing.
  if (opts.allowlistEnv) {
    mountArgv.push('--clearenv');
    for (const [key, value] of Object.entries(opts.allowlistEnv)) {
      mountArgv.push('--setenv', key, value);
    }
  }

  // 6a. Toolchain binary paths under $HOME — exact leaves, never a $HOME directory bind.
  if (opts.toolchainPaths) {
    for (const p of opts.toolchainPaths) {
      bind('ro-bind-try', p, p);
    }
  }

  // 6b. Operator-declared runtime env roots — strict --ro-bind, already
  // admission-validated (realpath'd, mountable, bin/ exists, no
  // export_mounts overlap). PATH injection for <path>/bin happens in
  // pipeline.ts's buildJailPathExport, not here — this module only mounts.
  if (opts.runtimeEnvPaths) {
    for (const p of opts.runtimeEnvPaths) {
      bind('ro-bind', p, p);
    }
  }

  // 6c. Resolver bind — only for jails that keep network. Every
  // real caller sets `unshareNet` explicitly (host-validation.ts's setup
  // step: `false`; every worker plan, pipeline.ts: `true`), so a plan that
  // leaves `unshareNet` unset (test fixtures unrelated to networking) never
  // triggers this check. Placed AFTER the unconditional `--tmpfs /tmp` at
  // step 4 (deliberately, not grouped with the other step-1-adjacent system
  // binds): a resolv target that happens to live under `/tmp` would
  // otherwise be shadowed the moment bwrap mounts the fresh tmpfs over it,
  // the same reason the clone bind below also comes after step 4.
  if (opts.unshareNet === false) {
    const target = resolveResolvBindTarget(opts.resolvConfPath ?? '/etc/resolv.conf', roots);
    if (target !== null) {
      bind('ro-bind-try', target, target);
    }
  }

  // 7-8: clone bind(s). Sparse write_scope mode (writeScope provided, even
  // empty): ro-bind the clone, then layer writable binds over each declared
  // path. Legacy mode (writeScope not provided): bind the whole clone
  // writable, matching S0.
  if (opts.writeScope !== undefined) {
    bind('ro-bind', opts.clonePath, opts.clonePath);
    for (const rel of opts.writeScope) {
      const target = joinUnderClone(opts.clonePath, rel);
      bind('bind', target, target);
    }
  } else {
    bind('bind', opts.clonePath, opts.clonePath);
  }

  // 9: dual-shape wiki read axis (T25/D19). DEC-0039: visible to every mode —
  // no mode-based masking. Tracked shape: the clone's own wiki/ is already
  // part of the clone bind above, so nothing further to do here. Nested-private
  // shape: bind the mother repo's wiki/ in unconditionally when given.
  const wikiPath = joinUnderClone(opts.clonePath, 'wiki');
  if (opts.wikiShape === 'nested-private' && opts.motherWikiPath) {
    bind('ro-bind', opts.motherWikiPath, wikiPath);
  }

  // 10: declared data mounts (ro/rw per HO; existence/absoluteness already
  // validated by the admission gate's bad_data_mount check, §7.14).
  if (opts.dataMounts) {
    for (const mount of opts.dataMounts) {
      bind(mount.access === 'ro' ? 'ro-bind' : 'bind', mount.path, mount.path);
    }
  }

  // 11: tunnel socket bind (T26/D21 egress enforcement).
  if (opts.tunnelSocketPath) {
    bind('bind', opts.tunnelSocketPath, opts.tunnelSocketPath);
  }

  // 12: in-jail relay script bind (T26/D21), read-only.
  if (opts.relayScriptPath) {
    bind('ro-bind', opts.relayScriptPath, opts.relayScriptPath);
  }

  // 13: secret-mask binds -- inlined here (pipeline.ts used to apply them as
  // a separate post-step), same existence checks:
  // a committed `.env` is masked with /dev/null (a worker must never read
  // secrets baked into the mother repo's own working-tree `.env`); a
  // committed `.claude/` is masked with a fresh tmpfs (committed agent
  // config must never reach the jail). Placed here, immediately before the
  // run-dir and `.git` binds below, so no later caller-side step can ever
  // re-order a mask after it again.
  const envPath = `${opts.clonePath}/.env`;
  const claudeDirPath = `${opts.clonePath}/.claude`;
  if (existsSync(envPath)) {
    bind('ro-bind', '/dev/null', envPath);
  }
  if (existsSync(claudeDirPath)) {
    synthetic('tmpfs', claudeDirPath);
  }

  // 13a: run-dir read-only bind (final mount group). The run dir holds the
  // prompt, logs, and tunnel/relay files the worker READS; making it read-only
  // in every mode stops a worker from writing directly around the stdout
  // capture path. Emitted immediately before the `.git` bind, which stays the
  // last mount operation of every plan.
  if (opts.runDirPath) {
    bind('ro-bind', opts.runDirPath, opts.runDirPath);
  }

  // 14: read-only `.git` bind -- the LAST mount operation of
  // EVERY plan this function renders (worker plans for every family and
  // every host-validation step): strict `--ro-bind`, never `-try` (a clone
  // always has `.git`; a missing one is a bug worth bwrap failing loudly
  // on). This is the only protection a host-validation jail has (no
  // write_scope, whole clone rw per step 7-8 above) and the backstop for
  // every worker jail regardless of its write_scope shape. Only the injected-
  // file args (`--file` jail-`/tmp` destinations and `--ro-bind-data`
  // credential snapshots) and `--chdir` follow it -- a tracked
  // symlink such as `.claude -> .git` cannot overlay this bind because the
  // mask above already landed first and this is unconditional and last.
  bind('ro-bind', `${opts.clonePath}/.git`, `${opts.clonePath}/.git`);

  return { mountArgv, mounts, cwd };
}

/**
 * Build the bwrap argv for jailing a worker to its ephemeral clone.
 * Pure and synchronous — this only assembles an argument array, it never
 * spawns anything and cannot fail, so it does not return a `DispatchResult`.
 *
 * Always builds the full §11 recipe in the 14-step order documented above.
 */
export function buildJailArgs(opts: JailOpts): JailArgs {
  const { mountArgv, cwd } = buildJailPlanSteps(opts);
  // 13-14: cwd + terminator (the caller appends the worker invocation after this).
  return { argv: ['bwrap', ...mountArgv, '--chdir', cwd, '--'] };
}

// ---------------------------------------------------------------------------
// D6 (PLN-0004 mid_project_review_rulings.md ruling 7, components 1-4):
// frozen bwrap plan object. Replaces the generated-bash-script +
// execViaWsl2 pattern with a plan `spawn-isolated.ts` hands directly to
// `spawn('bwrap', plan.bwrapArgs, ...)`. Mirrors agent-chassis's
// buildBubblewrapLaunchPlan (`launch-isolation-plan.mjs:29-284`, frozen
// return shape at :233-284) and buildBubblewrapArgs
// (`launch-isolation-bwrap-args.mjs:8-126`). ELv2 — design mirrored only;
// this TypeScript is written from scratch, no chassis source copied.
//
// buildJailArgs above is UNCHANGED (pipeline.ts's script-generation path
// still calls it; Phase 2 removes that call site and this whole section
// grows into its replacement). Both functions now render from the single
// `buildJailPlanSteps` walk above — the mount LOGIC is identical, only the
// output shape differs.
// ---------------------------------------------------------------------------

/**
 * One structured bind/mount operation, in application order — mirrors
 * chassis's plan-mounts `{src,dst}` shape (`launch-isolation-plan-mounts.mjs
 * :185-499`). `src` is absent for the synthetic proc/dev/tmpfs mounts (no
 * host source path). For diagnostics/provenance only — `buildBwrapPlan`
 * already renders the equivalent flag pairs into `bwrapArgs`.
 */
export interface BwrapMount {
  kind: 'ro-bind' | 'ro-bind-try' | 'bind' | 'tmpfs' | 'proc' | 'dev';
  src?: string;
  dst: string;
}

/**
 * A file bwrap materializes inside the jail via `--file FD DEST` (D6 V3
 * component 15 — in-jail config materialization, e.g. models.json under the
 * worker's /tmp tmpfs config dir; replaces the heredoc pipeline.ts used to
 * write inside the generated script, since `/tmp` is jail tmpfs and doesn't
 * exist until bwrap itself mounts it — WK-0088 invariant, this module's own
 * doc above).
 *
 * Captured directly against bubblewrap 0.9.0 on this host (2026-09-16,
 * DEC-0009 capture-before-code — `[UNVERIFIED-SHAPE]` in the ruling until
 * this run): unlike `--bind`/`--ro-bind` (which require the destination to
 * already exist), `--file` auto-creates missing parent directories, and
 * accepts a pipe-backed fd (not just a regular seekable file) —
 * `--file 3 /tmp/.pi-agent/models.json` materialized correctly against fd 3
 * fed by a fifo (bash process substitution), and two `--file` entries can
 * share a newly-created parent directory. Default mode is 0666
 * (umask-subject; bwrap's `--perms` would tighten this, not wired here).
 *
 * `--ro-bind-data FD DEST` is the read-only twin (captured against bubblewrap
 * 0.9.0 on this host, 2026-11-18): it materializes the same bytes and a write
 * to DEST fails "Read-only file system". Credential snapshots use it so the
 * worker's CLI can read its login while every mode — `implement` included —
 * leaves the file unwritable.
 */
export interface BwrapInjectedFile {
  /** fd bwrap reads from — 3, 4, 5, ... in declaration order (0-2 are reserved for the child's own stdio). Assigned by `buildBwrapPlan`; `spawnIsolated` wires a pipe at this same stdio index. */
  fd: number;
  /** Destination path inside the jail. */
  dest: string;
  /** File content to materialize at dest. */
  content: string;
  /** When true, bwrap materializes the file read-only (`--ro-bind-data`) instead of writable (`--file`). Set for credential snapshots; every other injected file stays writable so the worker can rewrite it. */
  readOnly: boolean;
}

/**
 * Frozen plan object — mirrors agent-chassis's buildBubblewrapLaunchPlan
 * return shape (`launch-isolation-plan.mjs:233-284`): the full bwrap argv,
 * structured mount provenance, and the resolved env/cwd/command, ready for a
 * direct `spawn('bwrap', plan.bwrapArgs, ...)` (`spawn-isolated.ts`,
 * mirroring `launch-isolation-spawn.mjs:250-255`).
 */
export interface BwrapPlan {
  /**
   * Full bwrap argv, EXCLUDING the 'bwrap' program name itself — Node's
   * `spawn(command, args)` takes the binary and args separately, unlike the
   * shell-command form `buildJailArgs`'s argv was designed for (which needs
   * 'bwrap' as argv[0] of the composed command line, see `buildJailArgs`
   * above). Includes the trailing `--chdir <cwd> -- <command...>`; ready to
   * hand directly to `spawn('bwrap', plan.bwrapArgs, ...)` with no further
   * mutation.
   */
  bwrapArgs: readonly string[];
  /** Structured mount records in application order — the same binds `bwrapArgs` encodes, for diagnostics/provenance. */
  mounts: readonly BwrapMount[];
  /** Files bwrap materializes inside the jail via `--file` (already reflected in `bwrapArgs`); `spawnIsolated` reads this to wire the matching pipes. */
  injectedFiles: readonly BwrapInjectedFile[];
  /** Environment for the spawned bwrap process itself (`child_process.spawn`'s `env`) — NOT in-jail `--setenv`; bwrap's default env passthrough hands it to the sandboxed child, which is why `spawnIsolated` composes it from env-policy's allowlist-minted, deny-filtered base (D6 component 9; WK-0297/WK-0298) before layering this plan's `env` on top. */
  env: Record<string, string>;
  /** Working directory inside the jail (mirrors the `--chdir` argument already baked into `bwrapArgs`). */
  cwd: string;
  /** Worker command + argv — already embedded at the end of `bwrapArgs` after `--`; surfaced separately for logging/provenance (mirrors chassis's `childCommand`/`childArgs`, `launch-isolation-plan.mjs:237-239`). */
  command: readonly string[];
}

export interface BuildBwrapPlanOpts extends JailOpts {
  /** Worker command + argv to run inside the jail (appended after bwrap's own `--` terminator), e.g. `['pi', '-p', '--mode', 'json', ...]`. */
  command: string[];
  /** Environment for the spawned bwrap process (`child_process.spawn`'s `env`). Defaults to `{}`. */
  env?: Record<string, string>;
  /** Files to materialize inside the jail via bwrap `--file` (e.g. models.json under the worker's tmpfs config dir), or `--ro-bind-data` when `readOnly` is true (credential snapshots). fd numbers are assigned here, in array order, starting at 3. */
  injectedFiles?: ReadonlyArray<{ content: string; dest: string; readOnly?: boolean }>;
}

/**
 * Build the frozen bwrap plan for jailing a worker to its ephemeral clone
 * (D6). Pure and synchronous — same "cannot fail" contract as
 * `buildJailArgs`: this only assembles data, it never touches the
 * filesystem or spawns anything.
 */
export function buildBwrapPlan(opts: BuildBwrapPlanOpts): BwrapPlan {
  const { mountArgv, mounts, cwd } = buildJailPlanSteps(opts);

  const injectedFiles: BwrapInjectedFile[] = (opts.injectedFiles ?? []).map((f, i) => ({
    fd: 3 + i,
    dest: f.dest,
    content: f.content,
    readOnly: f.readOnly === true,
  }));
  // --file/--ro-bind-data are bwrap OPTIONS (parsed like --bind etc.), so
  // they must land before the `--` terminator — after it, tokens belong to
  // the worker's own argv instead of bwrap.
  const fileArgv = injectedFiles.flatMap((f) => [f.readOnly ? '--ro-bind-data' : '--file', String(f.fd), f.dest]);

  return {
    bwrapArgs: [...mountArgv, ...fileArgv, '--chdir', cwd, '--', ...opts.command],
    mounts,
    injectedFiles,
    env: { ...(opts.env ?? {}) },
    cwd,
    command: [...opts.command],
  };
}

// ---------------------------------------------------------------------------
// Per-family bwrap plan differentiation (D2 ruling 2, PLN-0004
// `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md:149-201`;
// design source agent-chassis `docs/enforcement-model.md:505-550` — ELv2,
// design mirrored only, no chassis source copied). Pi's existing sparse-bind
// recipe above (buildJailPlanSteps's write_scope loop, unmodified) stays the
// default for pi; claude and codex both classify exact file/dir mounts via
// `deriveExactFileMounts` below (claude mirrors codex's exact-file binds
// now — no more directory-widening). This is a standalone
// classification helper — pipeline.ts (step 12d) uses its output to build a
// family-specific `writeScope` override before calling the UNMODIFIED
// `buildBwrapPlan` above; it is not a new recipe step inside
// `buildJailPlanSteps` itself.
//
// This needs to know whether a write_scope entry names a FILE or a
// DIRECTORY, which — unlike the rest of this file — requires real filesystem
// I/O (`stat`). `classifyEntry` below is the shared classifier: `statSync`
// when the path already exists in the clone, falling back to an extension
// heuristic when it doesn't (a write_scope entry may legitimately name a
// file the worker hasn't created yet).
// ---------------------------------------------------------------------------

export type EntryKind = 'file' | 'directory';

/**
 * Heuristic used only when a write_scope path does not yet exist on disk: a
 * dot followed by one or more alphanumeric characters at the end of the
 * final path segment reads as a file extension (`.ts`, `.js`, `.mjs`,
 * `.json`, `.md`, `.yaml`, `.yml`, and any other conventional extension);
 * anything else (no dot, or a trailing-slash directory entry, whose final
 * split segment is empty) reads as a directory.
 */
export function looksLikeFile(relPath: string): boolean {
  const basename = relPath.split('/').pop() ?? relPath;
  return /\.[A-Za-z0-9]+$/.test(basename);
}

/**
 * Classify one write_scope entry (already resolved onto the clone root) as a
 * file or a directory: `stat()` when the path exists on disk; the extension
 * heuristic above when it doesn't (ENOENT) — or, defensively, on any other
 * stat error, since this module's "cannot fail" contract (top-of-file doc)
 * means a permission error must degrade to the heuristic rather than throw.
 */
export function classifyEntry(absPath: string, relPath: string): EntryKind {
  try {
    return statSync(absPath).isDirectory() ? 'directory' : 'file';
  } catch {
    return looksLikeFile(relPath) ? 'file' : 'directory';
  }
}

/**
 * Classify write_scope entries as exact files or directories — every family
 * (pi aside, which keeps its own identity sparse-bind recipe above) gets
 * exact-file kernel binds (`--bind <file> <file>`, parent directory stays
 * read-only), never a directory widened to cover a file entry (Claude now
 * edits through Bash with its native write tools denied, so it no longer
 * needs atomic-rename's write+execute on the containing directory —
 * `deriveDirectoryScopedMounts`, the former Claude-only widening helper, is
 * retired). Returns ABSOLUTE paths in each bucket, resolved via this
 * module's own `joinUnderClone`.
 */
export function deriveExactFileMounts(
  writeScope: string[],
  clonePath: string,
): { writableDirs: string[]; writableFiles: string[] } {
  const writableDirs: string[] = [];
  const writableFiles: string[] = [];
  for (const rel of writeScope) {
    const absPath = joinUnderClone(clonePath, rel);
    if (classifyEntry(absPath, rel) === 'file') {
      writableFiles.push(absPath);
    } else {
      writableDirs.push(absPath);
    }
  }
  return { writableDirs, writableFiles };
}


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
 *   1.  --ro-bind / /                 entire host read-only
 *   2.  --proc /proc                  live procfs (child spawning)
 *   3.  --dev /dev                    device nodes (WK-0086: `nodev` on the
 *                                      ro-bind root broke nested bash spawn)
 *   4.  --tmpfs /tmp                  writable scratch space — Pi and other
 *                                      in-jail tooling need a writable /tmp;
 *                                      unconditional whenever the full S5
 *                                      recipe runs
 *   5.  --die-with-parent             cleanup on parent exit
 *   6.  --unshare-net                 opt-in (T26/D21): no network stack
 *   7.  clone bind                    ro-bind first if write_scope is
 *                                      sparse, else writable (legacy shape)
 *   8.  write_scope binds             selective rw layered over step 7
 *   9.  wiki read axis (T25/D19)      dual-shape probe result decides mask
 *                                      vs. explicit bind vs. no-op
 *   10. data mounts                   per-HO ro/rw binds (existence/
 *                                      absoluteness already §7.14-validated
 *                                      by the admission gate)
 *   11. tunnel socket bind (T26/D21)  egress-forwarder unix socket
 *   12. relay script bind (T26/D21)   in-jail relay, read-only
 *   13. --chdir <cwd>
 *   14. --                            terminates bwrap's own argv; the
 *                                      caller appends the worker invocation
 *
 * ## Backward compatibility
 *
 * When NONE of the S5 fields below are supplied, `buildJailArgs` returns the
 * S0-minimum argv byte-for-byte — no `--tmpfs /tmp`, no `--unshare-net`:
 *
 *   bwrap --ro-bind / / --proc /proc --dev /dev --die-with-parent \
 *     --bind <clonePath> <clonePath> --chdir <cwd> --
 *
 * This keeps existing callers (pipeline.ts's S0-S4 `buildJailArgs({ clonePath })`
 * call, and the frozen equality assertions in tests/dispatch-v2-exec.test.ts)
 * working unchanged until pipeline.ts is updated to pass S5 options (W2).
 */

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
  /** Wiki shape — determines whether to mask or bind wiki. */
  wikiShape?: WikiShape;
  /** HO mode — determines wiki visibility (implement/code_review: masked; redteam/research: visible). */
  mode?: string;
  /** Absolute path to the mother repo's wiki/ (for nested-private shape, redteam/research bind). */
  motherWikiPath?: string;
  /** Data mount declarations from the HO (format: "ro:/path/to/data" or "rw:/path/to/data"). */
  dataMounts?: string[];
  /** Whether to unshare the network namespace (true for S5 enforcement). */
  unshareNet?: boolean;
  /** Path to the tunnel unix socket to bind-mount into the jail. */
  tunnelSocketPath?: string;
  /** Path inside the jail where the relay script lives (for bind-mounting). */
  relayScriptPath?: string;
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

export interface ParsedDataMount {
  access: 'ro' | 'rw';
  hostPath: string;
}

/**
 * Parse a data_mounts entry like "ro:/data/reference" or "rw:/tmp/scratch".
 * Returns null for anything that doesn't match the `(ro|rw):<path>` shape.
 * Malformed entries are skipped by `buildJailArgs` rather than thrown — the
 * admission gate's `bad_data_mount` check (§7.14) is the validating gate;
 * this parser stays defensive-but-silent to hold jail.ts's "cannot fail"
 * contract.
 */
export function parseDataMount(entry: string): ParsedDataMount | null {
  const match = /^(ro|rw):(.+)$/.exec(entry);
  if (!match) return null;
  return { access: match[1] as 'ro' | 'rw', hostPath: match[2] };
}

/** Modes whose workers must never see wiki content — masked when wiki/ is tracked. */
const WIKI_MASKED_MODES: ReadonlySet<string> = new Set(['implement', 'code_review']);
/** Modes allowed to read wiki content — get an explicit bind when wiki/ is nested-private. */
const WIKI_VISIBLE_MODES: ReadonlySet<string> = new Set(['redteam', 'research']);

/** True if any S5 field is set — selects the full §11 recipe over the S0-minimum shape. */
function hasS5Options(opts: JailOpts): boolean {
  return (
    opts.writeScope !== undefined ||
    opts.wikiShape !== undefined ||
    opts.mode !== undefined ||
    opts.motherWikiPath !== undefined ||
    opts.dataMounts !== undefined ||
    opts.unshareNet !== undefined ||
    opts.tunnelSocketPath !== undefined ||
    opts.relayScriptPath !== undefined
  );
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
 * Build the bwrap argv for jailing a worker to its ephemeral clone.
 * Pure and synchronous — this only assembles an argument array, it never
 * spawns anything and cannot fail, so it does not return a `DispatchResult`.
 *
 * With no S5 options set, returns the S0-minimum shape unchanged (see the
 * "Backward compatibility" module doc above). With any S5 option set, builds
 * the full §11 recipe in the 14-step order documented above.
 */
export function buildJailArgs(opts: JailOpts): JailArgs {
  const cwd = opts.cwd ?? opts.clonePath;

  if (!hasS5Options(opts)) {
    return {
      argv: [
        'bwrap',
        '--ro-bind', '/', '/',
        '--proc', '/proc',
        '--dev', '/dev',
        '--die-with-parent',
        '--bind', opts.clonePath, opts.clonePath,
        '--chdir', cwd,
        '--',
      ],
    };
  }

  const argv: string[] = ['bwrap'];

  // 1-3: host read-only root + live procfs + device nodes (unchanged since S0).
  argv.push('--ro-bind', '/', '/');
  argv.push('--proc', '/proc');
  argv.push('--dev', '/dev');
  // 4: writable scratch space — new at S5, unconditional whenever the full
  // recipe runs (Pi and other in-jail tooling need a writable /tmp).
  argv.push('--tmpfs', '/tmp');
  // 5: cleanup on parent exit (unchanged since S0).
  argv.push('--die-with-parent');
  // 6: network namespace removal (T26/D21) — opt-in.
  if (opts.unshareNet) {
    argv.push('--unshare-net');
  }

  // 7-8: clone bind(s). Sparse write_scope mode (writeScope provided, even
  // empty): ro-bind the clone, then layer writable binds over each declared
  // path. Legacy mode (writeScope not provided): bind the whole clone
  // writable, matching S0.
  if (opts.writeScope !== undefined) {
    argv.push('--ro-bind', opts.clonePath, opts.clonePath);
    for (const rel of opts.writeScope) {
      const target = joinUnderClone(opts.clonePath, rel);
      argv.push('--bind', target, target);
    }
  } else {
    argv.push('--bind', opts.clonePath, opts.clonePath);
  }

  // 9: dual-shape wiki read axis (T25/D19).
  const wikiPath = joinUnderClone(opts.clonePath, 'wiki');
  if (opts.wikiShape === 'tracked') {
    if (opts.mode !== undefined && WIKI_MASKED_MODES.has(opts.mode)) {
      argv.push('--tmpfs', wikiPath);
    }
    // redteam/research (or an unrecognized mode): leave the clone's own wiki/ visible.
  } else if (opts.wikiShape === 'nested-private') {
    if (opts.mode !== undefined && WIKI_VISIBLE_MODES.has(opts.mode) && opts.motherWikiPath) {
      argv.push('--ro-bind', opts.motherWikiPath, wikiPath);
    }
    // implement/code_review (or no motherWikiPath given): clone has no wiki/ at all — nothing to bind.
  }

  // 10: declared data mounts (ro/rw per HO; existence/absoluteness already
  // validated by the admission gate's bad_data_mount check, §7.14).
  if (opts.dataMounts) {
    for (const entry of opts.dataMounts) {
      const parsed = parseDataMount(entry);
      if (parsed === null) continue;
      if (parsed.access === 'ro') {
        argv.push('--ro-bind', parsed.hostPath, parsed.hostPath);
      } else {
        argv.push('--bind', parsed.hostPath, parsed.hostPath);
      }
    }
  }

  // 11: tunnel socket bind (T26/D21 egress enforcement).
  if (opts.tunnelSocketPath) {
    argv.push('--bind', opts.tunnelSocketPath, opts.tunnelSocketPath);
  }

  // 12: in-jail relay script bind (T26/D21), read-only.
  if (opts.relayScriptPath) {
    argv.push('--ro-bind', opts.relayScriptPath, opts.relayScriptPath);
  }

  // 13-14: cwd + terminator (the caller appends the worker invocation after this).
  argv.push('--chdir', cwd);
  argv.push('--');

  return { argv };
}

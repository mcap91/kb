/**
 * §8 delivery gate (dispatch v2, PLN-0004 S0, T6). Ports the WK-0074 B4R
 * correctness script (`scratch_space/WSL2_spikes/b4r_correctness.sh`, proven
 * 21/21) — the enumerate -> verdict -> land protocol is carried into
 * script-generating + result-parsing TypeScript functions here, not
 * re-derived.
 *
 * This module produces bash script CONTENT and parses script OUTPUT; it does
 * not execute anything itself. Wave 2a builds `wsl2.ts` (the WSL2 exec
 * helper) in parallel disjoint files, so this module cannot depend on it.
 * Wave 3's `pipeline.ts` wires the two together: generate a script here,
 * execute it via wsl2.ts, parse the result back here.
 *
 * Frozen git config on every launcher-side git call (spec §8, b4r script):
 * `-c core.autocrlf=false -c core.eol=lf -c core.hooksPath= -c core.fsmonitor=`.
 * Pinned committer: `kb-dispatch <dispatch@kb.local>` (GIT_COMMITTER_NAME/EMAIL
 * and GIT_AUTHOR_NAME/EMAIL env vars). Delivery always stages into a temp index
 * (GIT_INDEX_FILE) — never the real index — and lands via plumbing
 * (read-tree/write-tree/commit-tree) + a CAS `push` onto
 * `refs/heads/dispatch/<handoffId>`: same tree from the same base as the
 * existing tip is an idempotent no-op; a different tree from the same base
 * is a structured conflict, never a clobber (b4r script tests 3-5).
 *
 * None of the functions in this module throw. `checkWriteScope`/`scanSecrets`
 * return a minimal local `{ ok }` shape (not the shared `DispatchResult`) and
 * `parseDeliveryOutput` folds failure into `DeliveryOutcome.status === 'error'`
 * — there is no fallible I/O in this file to wrap in `DispatchResult`.
 */

/** Frozen git config flags carried on every launcher-side git invocation (spec §8). */
const FROZEN_GIT = 'git -c core.autocrlf=false -c core.eol=lf -c core.hooksPath= -c core.fsmonitor=';

/**
 * Options for the eventual full delivery run. This is the wave-3
 * `pipeline.ts` shape (clone + mother repo + handoff identity); nothing in
 * this file executes against it — see the module doc above.
 */
export interface DeliveryOpts {
  /** WSL2 path to the ephemeral clone */
  clonePath: string;
  /** WSL2 path to the mother repo (via /mnt/c/...) */
  motherRepoWsl: string;
  /** The handoff record (for write_scope, id) */
  handoffId: string;
  writeScope: string[];
  /** base_sha the clone was created from */
  baseSha: string;
  /** Absolute Windows path to the run dir (for script staging + quarantine) */
  runDir: string;
}

export type DeliveryOutcome =
  | { status: 'delivered'; branch: string; commitSha: string; changedFiles: string[] }
  | { status: 'no_changes' }
  | { status: 'refused_out_of_scope'; offendingPaths: string[]; quarantinePath: string }
  | { status: 'secret_in_diff'; patterns: string[]; quarantinePath: string }
  | { status: 'conflict'; existingTree: string; newTree: string }
  | { status: 'error'; message: string };

export interface EnumerateScript {
  scriptContent: string;
  scriptName: string;
}

export interface DeliveryScript {
  scriptContent: string;
  scriptName: string;
}

export interface EnumerateResult {
  changedFiles: string[];
  diff: string;
  untrackedFiles: string[];
}

/** Single-quote a value for safe embedding in generated bash (escapes embedded quotes). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Extract the text between two literal marker lines (exclusive), or '' if either is absent. */
function extractSection(text: string, startMarker: string, endMarker: string): string {
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return '';
  return text
    .slice(startIdx + startMarker.length, endIdx)
    .replace(/^\n/, '')
    .replace(/\n$/, '');
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Split porcelain `git status` output into lines WITHOUT trimming: the
 * leading character of the two-character XY status code is frequently a
 * significant space (e.g. ` M` = unmodified index, modified worktree) that
 * `splitNonEmptyLines`'s trim would destroy. Only a trailing `\r` (stray
 * CRLF residue) is stripped; fully blank lines are dropped.
 */
function splitPorcelainLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
}

/**
 * Phase 1 (enumerate): a script run IN the clone that reports the full
 * change set — porcelain status, both-ends rename detection (unstaged
 * renames are not always surfaced as `R` by porcelain status, hence the
 * dedicated `--diff-filter=R` pass), the working diff (for the secret scan),
 * and untracked files — via marker-delimited sections. Read-only; makes no
 * changes to the clone.
 */
export function buildEnumerateScript(clonePath: string): EnumerateScript {
  const scriptContent = `#!/bin/bash
set -euo pipefail

CLONE_PATH=${shQuote(clonePath)}
cd "$CLONE_PATH"

GIT="${FROZEN_GIT}"

echo "---STATUS-START---"
$GIT status --porcelain
echo "---STATUS-END---"

echo "---RENAME-START---"
$GIT diff --name-status --diff-filter=R HEAD 2>/dev/null || true
echo "---RENAME-END---"

echo "---DIFF-START---"
$GIT diff HEAD 2>/dev/null || true
echo "---DIFF-END---"

echo "---UNTRACKED-START---"
$GIT ls-files --others --exclude-standard
echo "---UNTRACKED-END---"
`;

  return { scriptContent, scriptName: 'dispatch-enumerate.sh' };
}

/**
 * Parse the phase-1 enumerate script's stdout. `changedFiles` covers tracked
 * modifications/additions/deletions (both ends of a rename included, merging
 * the porcelain-status view with the dedicated rename-detection block);
 * `untrackedFiles` is the separate `ls-files --others` list. Callers that
 * need the full write_scope change set combine both
 * (`[...changedFiles, ...untrackedFiles]`).
 */
export function parseEnumerateOutput(stdout: string): EnumerateResult {
  const normalized = stdout.replace(/\r\n/g, '\n');

  const statusBlock = extractSection(normalized, '---STATUS-START---', '---STATUS-END---');
  const renameBlock = extractSection(normalized, '---RENAME-START---', '---RENAME-END---');
  const diffBlock = extractSection(normalized, '---DIFF-START---', '---DIFF-END---');
  const untrackedBlock = extractSection(normalized, '---UNTRACKED-START---', '---UNTRACKED-END---');

  const changed = new Set<string>();

  for (const line of splitPorcelainLines(statusBlock)) {
    const match = line.match(/^(.{2}) (.*)$/);
    if (!match) continue;
    const code = match[1]!;
    const rest = match[2]!;
    if (code === '??') continue; // reported separately via untrackedFiles
    if (code.includes('R') || code.includes('C')) {
      const [oldPath, newPath] = rest.split(' -> ');
      if (oldPath) changed.add(oldPath.trim());
      if (newPath) changed.add(newPath.trim());
    } else if (rest.trim().length > 0) {
      changed.add(rest.trim());
    }
  }

  for (const line of splitNonEmptyLines(renameBlock)) {
    const match = line.match(/^R\d*\t(.+)\t(.+)$/);
    if (!match) continue;
    changed.add(match[1]!.trim());
    changed.add(match[2]!.trim());
  }

  const untrackedFiles = splitNonEmptyLines(untrackedBlock);

  return {
    changedFiles: Array.from(changed),
    diff: diffBlock,
    untrackedFiles,
  };
}

/**
 * ⊆ write_scope check with directory-prefix semantics: a scope entry ending
 * in `/` matches any changed path under that directory; an entry without a
 * trailing slash matches only that exact path (spec §5's `write_scope`
 * example mixes both: a directory prefix and an exact test-file path).
 */
export function checkWriteScope(
  changedFiles: string[],
  writeScope: string[],
): { ok: true } | { ok: false; offendingPaths: string[] } {
  const normalizedScope = writeScope.map((entry) => entry.replace(/\\/g, '/'));

  const isInScope = (file: string): boolean => {
    const normalizedFile = file.replace(/\\/g, '/');
    return normalizedScope.some((entry) => {
      if (entry.endsWith('/')) {
        return normalizedFile === entry.slice(0, -1) || normalizedFile.startsWith(entry);
      }
      return normalizedFile === entry;
    });
  };

  const offendingPaths = changedFiles.filter((file) => !isInScope(file));
  if (offendingPaths.length > 0) return { ok: false, offendingPaths };
  return { ok: true };
}

interface SecretPattern {
  name: string;
  regex: RegExp;
}

// S0 subset: pattern-only. S3 adds injected-value scanning (the launcher's
// own known secret_env values), per spec §8.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'aws_access_key_id', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'bearer_token', regex: /[Bb]earer\s+[A-Za-z0-9\-._~+\/]+=*/ },
  { name: 'pem_private_key', regex: /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----/ },
  { name: 'sk_style_api_key', regex: /sk-[a-zA-Z0-9]{20,}/ },
];

/** Pattern-only secret scan over a diff (S0 subset of spec §8's `secret_in_diff` check). */
export function scanSecrets(diff: string): { ok: true } | { ok: false; patterns: string[] } {
  const patterns = SECRET_PATTERNS.filter((p) => p.regex.test(diff)).map((p) => p.name);
  if (patterns.length > 0) return { ok: false, patterns };
  return { ok: true };
}

/**
 * Phase 2 (land): the canonical b4r delivery sequence — seed a temp index
 * from `base_sha`, stage the clone's full delta, write-tree/commit-tree with
 * the pinned committer, then CAS-push onto `refs/heads/dispatch/<handoffId>`
 * in the mother repo. Never touches the real index; never force-pushes.
 * On a fresh delivery the script also echoes the branch name and the
 * base..tree changed-file list so `parseDeliveryOutput` can fill in a
 * complete `DeliveryOutcome` from stdout alone.
 */
export function buildDeliveryScript(opts: {
  clonePath: string;
  motherRepoWsl: string;
  handoffId: string;
  baseSha: string;
}): DeliveryScript {
  const { clonePath, motherRepoWsl, handoffId, baseSha } = opts;

  const scriptContent = `#!/bin/bash
set -euo pipefail

CLONE_PATH=${shQuote(clonePath)}
MOTHER_REPO=${shQuote(motherRepoWsl)}
HANDOFF_ID=${shQuote(handoffId)}
BASE_SHA=${shQuote(baseSha)}

export GIT_INDEX_FILE="$CLONE_PATH/.dispatch-delivery-idx"
export GIT_COMMITTER_NAME="kb-dispatch"
export GIT_COMMITTER_EMAIL="dispatch@kb.local"
export GIT_AUTHOR_NAME="kb-dispatch"
export GIT_AUTHOR_EMAIL="dispatch@kb.local"

GIT="${FROZEN_GIT}"

cd "$CLONE_PATH"

# Seed a temp index from base_sha (never the real index) and stage the full
# working-tree delta (modified + untracked + deleted) into it.
$GIT read-tree "$BASE_SHA"
$GIT add -A

TREE=$($GIT write-tree)
COMMIT=$($GIT commit-tree "$TREE" -p "$BASE_SHA" -m "dispatch: $HANDOFF_ID")

rm -f "$CLONE_PATH/.dispatch-delivery-idx"

# CAS push-back to the mother repo: same tree + same base as the existing tip
# is an idempotent no-op; a different tree from the same base is a structured
# conflict, never a clobber.
EXISTING_REF=$($GIT -C "$MOTHER_REPO" rev-parse "refs/heads/dispatch/$HANDOFF_ID" 2>/dev/null || echo "NONE")

if [ "$EXISTING_REF" = "NONE" ]; then
  $GIT push "$MOTHER_REPO" "$COMMIT:refs/heads/dispatch/$HANDOFF_ID"
  echo "DELIVERED:$COMMIT"
  echo "---BRANCH-START---"
  echo "dispatch/$HANDOFF_ID"
  echo "---BRANCH-END---"
  echo "---CHANGED-FILES-START---"
  $GIT diff --name-only "$BASE_SHA" "$TREE"
  echo "---CHANGED-FILES-END---"
else
  EXISTING_TREE=$($GIT -C "$MOTHER_REPO" rev-parse "refs/heads/dispatch/$HANDOFF_ID^{tree}" 2>/dev/null || echo "")
  EXISTING_PARENT=$($GIT -C "$MOTHER_REPO" rev-parse "refs/heads/dispatch/$HANDOFF_ID^" 2>/dev/null || echo "")

  if [ "$EXISTING_TREE" = "$TREE" ] && [ "$EXISTING_PARENT" = "$BASE_SHA" ]; then
    echo "IDEMPOTENT"
  else
    echo "CONFLICT:$EXISTING_TREE"
    echo "---NEWTREE-START---"
    echo "$TREE"
    echo "---NEWTREE-END---"
  fi
fi
`;

  return { scriptContent, scriptName: 'dispatch-deliver.sh' };
}

/**
 * Parse the phase-2 delivery script's stdout into a `DeliveryOutcome`. Reads
 * the last recognized signal line so any stray earlier output doesn't
 * confuse the result. `refused_out_of_scope` / `secret_in_diff` are never
 * produced here — those are TypeScript-side verdicts (`checkWriteScope` /
 * `scanSecrets`) reached before this script would ever run.
 */
export function parseDeliveryOutput(stdout: string): DeliveryOutcome {
  const normalized = stdout.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) {
    return { status: 'error', message: 'Delivery script produced no output.' };
  }

  const lines = normalized.split('\n').map((line) => line.trim());

  const deliveredLine = lines.find((line) => line.startsWith('DELIVERED:'));
  if (deliveredLine) {
    const commitSha = deliveredLine.slice('DELIVERED:'.length).trim();
    const branch = extractSection(normalized, '---BRANCH-START---', '---BRANCH-END---').trim();
    const changedFiles = splitNonEmptyLines(
      extractSection(normalized, '---CHANGED-FILES-START---', '---CHANGED-FILES-END---'),
    );
    return { status: 'delivered', branch, commitSha, changedFiles };
  }

  if (lines.some((line) => line === 'IDEMPOTENT')) {
    return { status: 'no_changes' };
  }

  const conflictLine = lines.find((line) => line.startsWith('CONFLICT:'));
  if (conflictLine) {
    const existingTree = conflictLine.slice('CONFLICT:'.length).trim();
    const newTree = extractSection(normalized, '---NEWTREE-START---', '---NEWTREE-END---').trim();
    return { status: 'conflict', existingTree, newTree };
  }

  return { status: 'error', message: `Unrecognized delivery script output: ${normalized}` };
}

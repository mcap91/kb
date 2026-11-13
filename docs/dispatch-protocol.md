# Dispatch Protocol Reference

Technical reference for the `kb` Dispatch Protocol — a v2 multi-agent handoff system (DEC-0007).
`dispatch` is one atomic, gated call: admission → clone → jail → worker → delivery → capture. There is
no pre-launch human review step and no separate review/launch token lifecycle — every check that used
to gate a *launch* now gates the single `dispatch` call itself, at the time it runs.

## Trust Model

- **Operator-owned (trusted):** repo-local dispatch config (`wiki/.dispatch/models.json`,
  `backends.json`, `profiles.json`), the credential files a profile's `inject` map points at, and the
  `dir`/`model`/`backend`/`effort` call parameters (never HO-authored — see "Handoff (HO) Format"
  below).
- **Untrusted input:** the HO-\* handoff document itself (`wiki/handoffs/HO-XXXX.md`) and everything a
  worker produces (its response text, any file mutations, the recovery block it emits).

There is no separate review step and no operator config directory to trust ahead of time — the
admission gate (below) re-validates every HO on every `dispatch` call, and the two-wall containment
model (below) bounds what an untrusted worker can see or reach regardless of what the HO asked for.

## Handoff (HO) Format

Handoffs are markdown files with YAML frontmatter at `wiki/handoffs/HO-XXXX.md`. `create-handoff`
(CLI or MCP) allocates the next id and renders the file; manual authoring is also supported. The
canonical result document lives alongside it at `wiki/handoffs/HO-XXXX.response.md`, written by the
pipeline after the run (see "Capture and Provenance").

### Required fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Must match the filename (`HO-0012.md` → `id: "HO-0012"`) |
| `title` | string | |
| `mode` | enum | `implement` \| `code_review` \| `redteam` \| `research` — see "Modes and the Envelope" |
| `write_scope` | string[] | May be `[]`; non-empty is required for `implement` (admission gate, not parse-time) |
| `acceptance` | string[] | Non-empty |
| `validation` | string[] | Non-empty |
| `status` | string | Free-form; not gated by admission |

### Optional fields

| Field | Type | Notes |
|-------|------|-------|
| `base_ref` | string \| null | `null` = fresh HEAD; otherwise must start with `dispatch/` and name an existing ref (chained review/fix-up HOs) |
| `base_sha` / `base_wiki_sha` | string | Authoring-time commit stamps — see "Base Drift Gate" |
| `reviewed_run` | string | Run id a `code_review` HO targets. Must be a dispatch run id (`RUN-<uuid>`); anything else is `BAD_RECORD` at parse |
| `reviewed_sha` | string | Delivery-branch commit a derived `code_review` HO was derived for (full sha; anything else is `BAD_RECORD` at parse). Dispatch refuses unless `base_ref` resolves to it; `merge-delivery` requires the branch head to equal it |
| `web` | boolean | Default `false`. Never allowed for `code_review`/`redteam` |
| `credentials` | string[] | Names from `wiki/.dispatch/profiles.json`. Mutually exclusive with `web: true` |
| `data_mounts` / `export_mounts` | string[] | Absolute host paths *outside* the repo root, bound `ro` / `rw` into the jail. Must already exist |
| `runtime_envs` | string[] | Absolute paths to pre-installed runtime env roots (e.g. a conda/mamba env), implement-mode only — see "Runtime Env Projection" below |
| `read_first` | string[] | Repo-relative paths; each must exist where the worker reads it at dispatch time (`MISSING_READ_FIRST`; see "Where read_first resolves") |
| `vars` | string[] | `"KEY=value"` non-secret literal env for the worker |
| `fixup_context` | string | Prior review findings injected verbatim on a re-dispatch |
| `work_item` | string | `WK-####`; required for `mode: implement`, and its `wiki/issues/<id>.md` must exist |
| `timeout_secs` | integer | Positive integer; overrides the pipeline's default 1800s worker watchdog. Absent = 1800s. Refused above the operator cap (`WORKER_TIMEOUT_EXCEEDS_CAP`; see "Model and Backend Configuration") — never clamped |

### Written back by the pipeline after a run

`run_id`, `agent`, `model`, `enforced`, `isolation_backend`, `credentials_granted`, `branch`,
`response` — merged into the HO's own frontmatter in place (existing keys updated, new keys appended);
never author-set inputs.

## Modes and the Envelope

Five mode ceilings (DEC-0007 D4); a handoff may narrow a ceiling, never widen it:

| Mode | `write_scope` | `web` | Delivers a commit? |
|------|---------------|-------|---------------------|
| `implement` | required, non-empty | opt-in | yes — scope-checked commit onto `dispatch/HO-XXXX` |
| `code_review` | must be empty | never | no — response only |
| `redteam` | must be empty | never | no — response only |
| `research` | must be empty | opt-in | no — response only; never emits the recovery block (prose only) |
| `explore_code` | must be empty | never | no — response only; read-only codebase investigation |

`code_review`/`redteam`/`research`/`explore_code` are advisory: the worker gets no write authority in the jail
regardless of what it attempts, and any stray mutation is discarded with a warning rather than fed
into delivery.

## Admission Gate

Every `dispatch` call runs the same checks, in order, failing closed on the first violation. Nothing
here is a persisted review state — it all re-runs, every time, against the live repo.

| Check | Refusal code |
|-------|--------------|
| Handoff parses (required fields, valid `mode`) | `BAD_RECORD` |
| `write_scope` empty outside `implement`, or `web: true` for `code_review`/`redteam` | `ENVELOPE_EXCEEDS_MODE` |
| `implement` with empty `write_scope` | `MISSING_WRITE_SCOPE` |
| Every `write_scope` entry is repo-relative, resolves inside the repo, and it or its parent exists | `STALE_WRITE_SCOPE` |
| Every `read_first` entry exists — in the `base_ref` tree for a chained HO's non-wiki entries, else in the working tree | `MISSING_READ_FIRST` |
| Repo is clean (`git status --porcelain` over `write_scope` paths only; with an empty `write_scope` — every advisory mode — the scan is skipped and declared-path staleness is covered by the base-drift gate) | `DIRTY_REPO` |
| Every `read_first` entry is committed — no modified, staged, or untracked file under it (wiki entries checked in the wiki repo when nested-private); checked before base drift | `UNCOMMITTED_READ_FIRST` (see below) |
| `base_ref`, if set, starts with `dispatch/` and exists | `BAD_BASE_REF` |
| Every `data_mounts`/`export_mounts` entry is absolute, exists, and is outside the repo root | `BAD_DATA_MOUNT` |
| `runtime_envs` only declared for `mode: implement` | `ENVELOPE_EXCEEDS_MODE` |
| Every `runtime_envs` entry canonicalizes (realpath) to an absolute, existing, mountable path that is not `$HOME` itself and has a `bin/` dir | `BAD_RUNTIME_ENV` |
| No `runtime_envs` entry overlaps a `export_mounts` entry in either direction | `RUNTIME_EXPORT_OVERLAP` |
| `timeout_secs`, if declared, does not exceed the operator cap (`wiki/.dispatch/limits.json`'s `max_worker_timeout_secs`; absent = 1800s) | `WORKER_TIMEOUT_EXCEEDS_CAP` |
| `implement` declares a `work_item` whose `wiki/issues/<id>.md` exists | `WORK_ITEM_NOT_FOUND` |
| An HO carrying `reviewed_sha`: the commit it would clone (`base_ref`, else HEAD) is that sha — a derived review runs only against the head it was derived for | `REVIEWED_SHA_MISMATCH` |
| Fresh-HEAD HOs: declared paths haven't changed since `base_sha`/`base_wiki_sha` | `BASE_DRIFT` (see below) |

### Where read_first resolves

The worker's clone is cut from `base_ref` (or HEAD when it is null), so admission checks each `read_first`
entry where the worker will read it:

1. `wiki/…` entries resolve against the wiki working tree, in both wiki shapes.
2. For a chained HO (`base_ref` set), every other entry resolves against the `base_ref` tree
   (`git cat-file -e <base_ref>:<path>`). A file that exists only on that branch is admitted. A file
   that exists only on `main` is not in the clone, so admission refuses `MISSING_READ_FIRST` with
   guidance: dispatch artifacts (the implement response, validation evidence) reach the worker through
   the run-dir evidence channel, and other content belongs in the HO context. Nothing is copied into the
   clone.
3. For an HO with `base_ref` null, every other entry resolves against the working tree.

A few checks need facts the admission gate doesn't have yet and run later in the same `dispatch` call,
still before any worker spawns: `MODEL_NOT_FOUND` / `EFFORT_UNSUPPORTED` (model+backend resolution),
`CREDENTIALS_WITH_WEB` / `UNKNOWN_PROFILE` / `CREDENTIAL_NOT_CONFIGURED` (credential resolution),
`CONTEXT_BUDGET_EXCEEDED` (assembled prompt vs. the model's context window), `PREFLIGHT_FAILED` /
`NO_ISOLATION_ROUTE` (host bwrap capability — see "Host Requirements").

## Two-Wall Worker Containment (DEC-0011)

Every worker jail has both walls, for every family (Pi, Codex, Claude), always. Neither wall alone is
trusted to carry the whole containment story.

### Wall 1 — bwrap sandbox: deny-by-default visibility

A worker sees exactly: curated read-only system roots (`/usr /bin /sbin /lib /lib64 /etc /opt /var`),
its own ephemeral clone (checked out at the pinned `base_sha`), its family's single auth leaf, and the
HO's declared `data_mounts`/`export_mounts`. There is no whole-root bind and no blanket `$HOME` access.

- **Auth leaf** — the only `$HOME` paths let through: Claude's `~/.claude/.credentials.json` (`rw` for
  `implement`, `ro` otherwise); Codex's `~/.codex/auth.json` + `config.toml` (`ro`); Pi needs none (its
  key is env-injected, its config dir is jail tmpfs).
- **`write_scope` mounts** are family-shaped: Claude widens a file entry to its parent directory
  (its atomic-rename write pattern needs directory write+exec); Codex binds exact files; Pi binds
  exactly what was declared.
- **Secret masking** — a clone's own `.env` is masked to `/dev/null` and `.claude/` to a fresh tmpfs,
  so a committed secret or agent config in the mother repo's working tree never reaches the jail.
- **Worker env** — minted from an allowlist: only `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LANG`, and
  `LC_*` are copied from the host, then secret-shaped, posture, and proxy names are dropped. `TMPDIR`
  is pinned to the jail's `/tmp`. kb adds its own vars on top (credentials, HO `vars`, tunnel proxy).
  Any other host variable, such as `DATABASE_URL`, never reaches the worker.
- Every family runs under `--unshare-net` — no network namespace at all inside the jail.

### Runtime Env Projection

`implement`-mode HOs may declare `runtime_envs: string[]` — absolute paths to pre-installed
environment roots (a conda/mamba env, a `.cargo` dir, etc.) that the worker's project needs but that
live under `$HOME`, which is denied wholesale by Wall 1. For each declared path, admission:

1. Canonicalizes with `realpath` (resolve-first — a symlink farm still resolves to its real,
   bindable target, mirroring the toolchain-path pattern).
2. Refuses the canonical path if it is `$HOME` itself, outside both `$HOME` and the curated system
   roots, or has no `bin/` directory — all three with `BAD_RUNTIME_ENV`.
3. Refuses it if it overlaps a declared `export_mounts` entry in either direction — with
   `RUNTIME_EXPORT_OVERLAP` (an `export_mounts` writable layer must never shadow a runtime ro-bind,
   or vice versa).
4. Refuses the whole HO with `ENVELOPE_EXCEEDS_MODE` if `runtime_envs` is declared outside
   `mode: implement` — advisory modes read code but do not need a project runtime, and redteam gets
   no declared toolchain access either (fail closed).

Each validated, canonicalized path is bound strictly read-only (`--ro-bind`, not `--ro-bind-try` —
the path was already proven to exist at admission time) and its `<path>/bin` is appended to the
worker's `PATH` **after** the curated system dirs, so `python3`/`pytest`/etc. become reachable
without shadowing `git`, `bash`, `curl`, or any other system tool.

**Self-contained envs required.** A declared env's executables and libraries must all resolve
within its own declared root. An env that symlinks outside itself (e.g. `uv` linking to a base
interpreter, pyenv shims, `.cargo/bin` pointing into `.rustup`) needs a separate `runtime_envs`
entry for each such dependency root — conda/mamba envs are self-contained by default and are the
primary target.

**Mutable scratch.** All runtime env mounts are read-only — nothing inside them can be installed
into or modified. The jail already provides a writable `/tmp`; a worker that needs a cache
directory should point its tool at it explicitly (e.g. `PYTHONPYCACHEPREFIX=/tmp`,
`GOCACHE=/tmp/go-cache`) rather than relying on a path under the ro-bound env.

### Wall 2 — the tunnel: allowlist-by-default egress

Because the jail has no network stack, two small Node.js processes bridge a single path out:

- The **forwarder** runs outside bwrap, on the host — the only process in the whole run that ever
  touches a real network interface. It relays HTTP/HTTPS/CONNECT traffic, checking every destination
  against the run's **granted endpoint set**.
- The **relay** runs inside the jail's own network namespace, bridging a loopback port to the
  forwarder over a bind-mounted unix socket — a dumb byte shovel, no HTTP awareness, so it never
  buffers and never breaks SSE streaming.

**The granted endpoint set** is a union, built fresh per run:

- Pi: its one resolved model endpoint.
- Codex/Claude: the family's vendor domain set (e.g. Claude: `api.anthropic.com`,
  `auth.anthropic.com`, `console.anthropic.com`, `claude.ai`; Codex covers both the API-key and
  ChatGPT-seat backends).
- Plus every **granted** credential profile's own `endpoints` array (see "Credentials" below).

`web: true` bypasses the allowlist entirely — the flag itself is the grant, open egress to anywhere.
`web: false` (the default) restricts the forwarder to exactly the set above; every other destination is
refused and logged to the run's destination log. SaaS backends (Codex/Claude) work under `web: false` —
their vendor sets are built in. `web: true` is never required just to make a SaaS family function.

## Credentials

Credential profiles live in `wiki/.dispatch/profiles.json` (scaffolded by `init-dispatch`):

```json
{
  "schema_version": 1,
  "aws": {
    "inject": {
      "AWS_ACCESS_KEY_ID": "/home/user/.aws/kb-dispatch-creds.env",
      "AWS_SECRET_ACCESS_KEY": "/home/user/.aws/kb-dispatch-creds.env"
    },
    "endpoints": ["*.amazonaws.com", "*.aws.amazon.com"]
  }
}
```

- `inject` maps an env var name to a file path holding its value (read Linux-side only; kb never
  executes a credential command and never embeds a resolved value in generated text).
- `endpoints` (optional) is the array of hostnames — exact or `*.suffix` wildcard — this profile grants
  network access to. Appended to the forwarder's granted endpoint set only when the profile is named in
  the HO's `credentials:` field.
- An HO names profiles by name only (`credentials: ["aws"]`); it never carries a secret value.
- **`CREDENTIALS_WITH_WEB`** — `credentials:` and `web: true` are mutually exclusive in the same HO. A
  worker must never hold both a live secret and open network access in the same run.
- A `vars` key that collides with an injected credential's var name (or the backend's own
  `api_key_env`) is refused — a non-secret channel must never be able to shadow or masquerade as a
  credential.
- Delivery re-scans the diff for each granted credential's literal value before landing a commit; a hit
  refuses the delivery (`secret_in_diff`, see "Delivery") rather than committing it.

## Host Requirements

`dispatch` gates on one fact, for every family and every mode: does bubblewrap work end-to-end (the
binary runs, and a live `--unshare-user` round trip succeeds)? There is no per-family or per-mode
tiering and no unenforced fallback — if that probe fails, the call refuses with `NO_ISOLATION_ROUTE`
and prints remediation text (install bubblewrap, or relax an AppArmor unprivileged-userns restriction
on Ubuntu 24.04+). `check-environment` runs the identical probe on demand, plus informational container
detection and `HOME`/config-dir writability facts, so an operator can see what a real `dispatch` call
will do on a given host before running one.

## Model and Backend Configuration

Repo-local, under `wiki/.dispatch/` (scaffolded by `init-dispatch`; every file, including its README,
is written only if absent):

| File | Contents |
|------|----------|
| `models.json` | slug → `available_on` (backend names) + provider `model_id` |
| `backends.json` | name → `family` (`pi` \| `codex` \| `claude`), `base_url`, `api_key_env`, `secrets_file`, optional `effort_mapping`, optional `rate_key_prefix` |
| `profiles.json` | credential profiles — see "Credentials" |
| `limits.json` | optional, not scaffolded: operator cap on a handoff's `timeout_secs` — `{ "schema_version": 1, "max_worker_timeout_secs": <positive integer> }`; absent = 1800s cap |

A handoff may declare `timeout_secs` to override the pipeline's default 1800s worker watchdog.
`limits.json`'s `max_worker_timeout_secs` caps how high that override may go; a declared value
above the effective cap is refused at admission (`WORKER_TIMEOUT_EXCEEDS_CAP`, naming the
requested value, the cap, and the `wiki/.dispatch/limits.json` path to raise it) — never clamped.
When the watchdog fires, the run's `state.json` carries three named fields so the kill is
diagnosable from the run state alone: `configured_limit_secs` (the effective
timeout in effect at the kill), `elapsed_secs` (seconds since `started_at`), and
`heartbeat_age_secs` (age, in seconds, of the last `heartbeat_at` at the moment of the kill). A
run that ends any other way writes none of the three.

A local model (Ollama, vLLM, …) is just a `pi`-family backend entry with a `base_url` pointing at the
local server and `api_key_env: null` — there is no separate pluggable-agent-wrapper mechanism. Codex
and Claude backends normally leave `base_url: null` (the CLI reaches its SaaS provider directly);
setting a custom endpoint is the exception (Azure OpenAI, a proxy). `effort_mapping` is a capability
declaration, not a boolean flag: a backend with no mapping does not support `--effort`, full stop
(`EFFORT_UNSUPPORTED`).

## Delivery

Only `implement` mode delivers. After the worker exits, the pipeline enumerates the clone's changes
(`git status`/`diff`/untracked), checks every changed path against the *unwidened* `write_scope`
(directory-prefix or exact match), and re-scans the diff for each granted credential's literal value.
On a clean result it lands a scope-checked commit: a temp git index seeded from `base_sha`, the full
working-tree delta staged, committed with a pinned identity (`kb-dispatch <dispatch@kb.local>`), and
pushed with compare-and-swap semantics onto `refs/heads/dispatch/<handoff_id>` — the same tree from the
same base is an idempotent no-op; a different tree from the same base is a structured `conflict`, never
a clobber.

| Outcome | Meaning |
|---------|---------|
| `delivered` | Landed onto `dispatch/HO-XXXX`; branch + commit + changed files reported |
| `no_delta` | Worker ran but produced no tree change |
| `no_changes` | Advisory mode (nothing to deliver), or an idempotent re-delivery |
| `refused_out_of_scope` | A changed path fell outside `write_scope`; diff quarantined to the run dir |
| `secret_in_diff` | A granted credential's value appeared in the diff; diff quarantined |
| `conflict` | `dispatch/HO-XXXX` already carries a different tree from the same base |

Advisory modes (`code_review`/`redteam`/`research`) never reach this gate at all — their §-envelope
grants no write authority, so any file mutation a worker made anyway is detected and discarded with a
warning; the worker's own response *is* the deliverable.

## Capture and Provenance

After delivery (or the advisory no-op), the pipeline writes the canonical response document to
`wiki/handoffs/HO-XXXX.response.md` and merges provenance fields back into the HO's own frontmatter
(see "Written back by the pipeline" above). Both writes are auto-committed immediately — identity
`kb-dispatch <dispatch@kb.local>`, message `chore: dispatch HO-XXXX <outcome> (<model>)`, best-effort
(a commit failure warns, never fails the run).

Every non-`research` mode's terminal output carries a `kb-dispatch-recovery.v1` fenced block —
structured evidence (outcome, findings, kind) extracted from the worker's own last message.
`research` is prose-only and never emits it. For `implement` the block is diagnostic evidence only and
never changes the run's verdict; for `code_review`/`redteam` the block *is* the deliverable, and a
missing or invalid block drives the response doc's verdict to `failed` (`missing_review_artifact`).

The schema handed to claude/codex implement runs for constrained decoding (DEC-0037) requires a
`report` field — the full human-readable report — because those backends' final message IS this JSON
block, with no separate chat message left for prose. `## Worker Report` renders a valid block's non-empty
`report` when present, falling back to the worker's raw final message otherwise (pi implement and every
reviewer/redteam/explorer/research run, none of which populate `report`, are unaffected). `report` is
optional+nullable in recovery-block.ts's validator for every role/family — only this one schema file
requires it.

The response doc's own frontmatter also stamps three fields distilled from that evidence, so
downstream consumers (e.g. `merge-delivery`) can read a fact instead of re-parsing the rendered
`## Worker Report` markdown:

- `recovery_outcome` — the block's `reported_outcome` string (e.g. `passed_no_blocking_or_medium_findings`)
  when a valid block was extracted; empty string otherwise.
- `recovery_valid` — boolean; whether a valid `kb-dispatch-recovery.v1` block was extracted at all.
- `worker_report_chars` — the trimmed length of what `## Worker Report` actually renders (a valid block's
  `report` field when present, else the worker's final assistant message — the same resolution the
  section itself uses); the fail-closed "did a review/run actually happen" fact, independent of whether
  it carried a parseable block.

A response doc written before this change carries none of these three fields — consumers must refuse
loudly on that absence rather than falling back to parsing the markdown body.

## Base Drift Gate

A fresh-HEAD HO (`base_ref` null — the normal "cut from current HEAD" path) must carry the commit it
was checked against. Admission compares that stamp to what the worker will actually see, restricted to
the **declared paths** — `write_scope` ∪ `read_first` ∪ the HO's own WK file
(`wiki/issues/<work_item>.md`). Any difference refuses with `BASE_DRIFT`.

| Wiki shape | Code-repo check | Wiki check |
|---|---|---|
| tracked (normal repos) | `git diff --name-only <base_sha> <current HEAD> -- <declared paths>` in the repo root | none — wiki paths already live in the code repo |
| nested-private (`wiki/` is its own git repo) | same command, declared paths **minus** `wiki/…` | `git diff --name-only <base_wiki_sha> -- <wiki paths>` against the **working tree** in `<repo>/wiki` (the jail binds the live wiki dir, DEC-0039), with `git status --porcelain` folded in so never-committed files count too |

**Stamp validity.** A stamp must be a full hex SHA (40 or 64 chars) that names a commit in the right repo. Anything else — missing, `main`, an abbreviated SHA, or an unknown commit — is refused as "no valid `base_sha`" (or `base_wiki_sha`).

**Refusal messages.** No valid stamp:

```
Handoff HO-0015 has no valid base_sha. Re-read the task against today's code, then set base_sha to the current HEAD (git rev-parse HEAD; currently <sha>) and re-dispatch.
```

Declared files changed:

```
Handoff HO-0014: 3 declared file(s) changed since base_sha <stamp>.
Changed: packages/dispatch-core/src/pipeline.ts, packages/dispatch-core/src/delivery.ts, wiki/issues/WK-0134.md
Commits:
  6271586 fix(dispatch): WK-0148 — add missing error handlers on child-process stdio pipes (DEC-0040)
Re-read these changes against HO-0014 and WK-0134. Fix whatever is stale and commit, then set base_sha to the current HEAD (git rev-parse HEAD; currently <sha>) and re-dispatch.
```

For the wiki stamp, substitute `base_wiki_sha` / `git -C wiki rev-parse HEAD`. When files differ but no commits are listed (uncommitted or rewritten-history edits), the `Commits:` line reads `none listed (uncommitted changes or rewritten history)`.

**The fix.** Re-read the listed changes against the HO and its WK, fix and commit anything stale, then set the stamp to the current HEAD printed in the message and re-dispatch.

**Uncommitted read_first inputs (DEC-0047 A2 R9).** Before the base-drift check, admission
refuses `UNCOMMITTED_READ_FIRST` when any `read_first` entry the worker reads from a working tree has
uncommitted changes, in either wiki shape. A chained HO's non-wiki entries resolve against `base_ref`
(committed by construction) and are not checked.
The clone is cut from a commit, so uncommitted code-repo bytes never reach the worker; a nested-private
wiki is bound live, so its uncommitted bytes reach the worker, but the response's `wiki_commit` does not
record them. The message names the files and the remedy:

- `base_ref` null: commit them, then run `restamp`, then re-dispatch. A commit alone moves HEAD past the
  stamp and refuses `BASE_DRIFT`.
- chained (`base_ref` set): commit them and re-dispatch. A chained HO has no stamp to refresh.

The dirty-tree gate (`DIRTY_REPO`) covers only `write_scope`. An advisory HO (empty `write_scope`) skips
it, so kb's own uncommitted outputs (a fresh HO file, `wiki/.id-state.json`, another session's dispatch
stamp) never block an advisory dispatch.

**Chained-HO exemption.** An HO with `base_ref` set runs on an immutable `dispatch/` branch and is exempt from this gate — the orchestrator is expected to update its WK mid-chain by design.

## Post-Run Lifecycle Tools

Mechanical lifecycle capabilities that close the manual gaps in the dispatch loop:

### `status` and `stop-run`

`status` reports repo-wide run state: active runs plus the 10 most recent terminal runs, each with
model, delivery status, branch, heartbeat age, and (for active runs) a log tail and turn/file-touched
projection. `stop-run` kills a running dispatch by run id (`SIGTERM` to its process group) and marks its
state `cancelled`; an already-terminal run or an already-dead process is a no-op success, not an error.

### `derive-review`

Creates a `code_review` HO from a delivered `implement` HO, after running host validation against the
delivery (see "Host Validation Evidence" below). `title` = `Code review: <implement_title>`,
`reviewed_run` stamped to the implement's latest run whose outcome is `delivered` and that left a
delivery branch, `reviewed_sha` stamped to the delivery branch head that was validated, and a
`### Host Validation Evidence` section rendered from the evidence JSON into the HO's Context.

**Chain.** The reviewed chain is every commit in `HEAD..dispatch/<implement_id>`
in the mother checkout — exactly the range `merge-delivery` ships. Each commit must have exactly one
parent (else `BAD_RECORD` naming the commit, "merge commit") and the subject `dispatch: HO-XXXX` (else
`BAD_RECORD` naming the commit and its subject); its named `wiki/handoffs/HO-XXXX.md` is read live from
disk (never from the commit's own git tree — DEC-0039) and must parse with `mode: implement` (else
`BAD_RECORD` naming the commit, the HO, and its mode). The newest commit in the range must be the
implement HO's own delivery, or derivation refuses `BAD_RECORD`. An empty range (the delivery branch is
already merged) refuses `BAD_RECORD`. A member already reachable from `HEAD` is excluded by the range
itself. The chain is computed against `HEAD` at derive time, so the merge target the Objective names is
`HEAD`'s branch at that moment.

**Objective and Expected Output (Specification 2).** Both are fixed sentences built only from
identifiers — the head HO id, the delivery branch, `reviewed_sha`, the merge target, and one line per
chain member (oldest first) naming its HO id, `work_item`, and single-commit range — never copied from
the implement HO's prose. The full reviewed range sits alone on its own
`Range under review: <range_base>..<head_sha>` line (`range_base` is the parent of the oldest member's
commit; it is prose here, never the `base_sha` frontmatter stamp, which stays empty for a chained HO), so
the reviewer cannot confuse it with any one member's range.

**Fields copied vs. set by mode (Specification 3).** Copied from the head implement HO: `initiative`,
`area`, `work_item`, `credentials`, `data_mounts`, `vars`. Set by the review mode, never copied:
`write_scope: []`, `runtime_envs: []`, `web: false`, `export_mounts: []` — the implement envelope exceeds
what `code_review` may declare (`ENVELOPE_EXCEEDS_MODE`, DEC-0047), and copying `export_mounts` would hand
the reviewer write access. The implement HO's `export_mounts` entries are appended to `data_mounts`
instead, read-only, so the reviewer can read what the implement exported. `validation` is one fixed
sentence pointing the reviewer at the Host Validation Evidence (DEC-0047); the implement's validation
text is never copied. Unchanged: `title`, `subject`, `allowed_agents`, `mode`, `base_ref`, `reviewed_run`,
`reviewed_sha`, and the Host Validation Evidence in Context.

**read_first (Specification 4).** The union of every chain member's `read_first` (head first, then older
members), plus `AGENTS.md`, deduplicated, then filtered through `readFirstEntryExists` — the one
existence predicate shared with admission's `checkMissingReadFirst` (wiki paths against the wiki working
tree; other paths against `git cat-file -e <base_ref>:<path>`). `DeriveReviewResult.droppedReadFirst`
lists every entry the filter dropped (e.g. a file the implement deleted on its branch), so the derived
review's own `read_first` never carries an entry admission would refuse.

**Acceptance (Specification 5).** The union of every chain member's acceptance criteria, oldest member
first, each criterion prefixed `[HO-XXXX] ` with its own HO id. Text is otherwise copied verbatim, never
rewritten.

**Reviewer framing — the rules line (Specification 6).** `assemble.ts`'s `code_review` framing is fixed
text that never parses the Objective; it points the reviewer at the Objective's own
`Range under review:` line (defaulting to `git diff HEAD~1 HEAD` when an HO, derived or hand-authored,
names no such line) and tells the reviewer to check the change against the repository's AGENTS.md rules
as well as the acceptance criteria, naming the specific rule in each finding that cites a rule violation.
This applies to every `code_review` HO, not only derived ones.

Does NOT auto-dispatch — the orchestrator dispatches separately (two-step review chain).

Refusals: implement not found, mode != implement, not delivered (response doc missing), no delivered run
with a delivery branch, delivery branch missing, a bad chain record (merge commit, non-`dispatch:`
subject, unparsable or non-implement member HO, wrong newest commit, or an empty range — all
`BAD_RECORD`), malformed `validation.json`, or a validation run that could not be carried out at all (bad
runtime path, clone or bwrap failure).

### Host Validation Evidence (DEC-0047)

Advisory workers never run the project toolchain. The host runs the operator's registered validation
commands against the delivery commit and records what happened. The review judges the diff plus that
evidence, and `merge-delivery` gates on it.

**Registry.** `wiki/.dispatch/validation.json` is the only source of commands the host runs. HO
`validation` entries stay worker instructions; the host never parses or executes them. The file is
strict: an unknown key, a shell string instead of an argv array, or a missing timeout refuses with
`BAD_RECORD`. With no file, there are no registered commands: the host runs nothing and the evidence
records zero commands.

```json
{
  "schema_version": 1,
  "setup": { "argv": ["npm", "ci", "--ignore-scripts"], "timeout_ms": 600000 },
  "commands": [
    { "name": "typecheck", "argv": ["npm", "run", "typecheck"], "timeout_ms": 600000 },
    { "name": "test", "argv": ["npm", "test"], "timeout_ms": 900000 }
  ],
  "env": { "FORCE_COLOR": "0" },
  "runtime_paths": ["/opt/node-22"]
}
```

| Key | Meaning |
|---|---|
| `setup` | Optional. Runs first and is the only step with network. npm lifecycle scripts are forced off (`npm_config_ignore_scripts=true`). If setup fails, no command runs. |
| `commands[]` | `name` (`[A-Za-z0-9._-]+`, unique), `argv`, `timeout_ms`. They run in order, network-denied. |
| `env` | Extra variables for every step. `PATH`, `HOME`, and `TMPDIR` are reserved. |
| `runtime_paths` | Absolute runtime roots. Each must have `bin/`, live under `$HOME` or a system root, and not be `$HOME` itself. Each is bound read-only, and its `bin/` goes first on `PATH`. |

**Confinement.** Each step runs in a bwrap jail over a fresh temp clone of the delivery sha (bound
writable), built by the same generic jail layer the workers use. Nothing derived from the delivery runs on
the host outside the jail. The env is an allowlist (`--clearenv`): `PATH` (runtime `bin/` dirs, then
`/usr/local/bin:/usr/bin:/bin`), `HOME=/tmp`, `TMPDIR=/tmp`, and the registry `env`. No host variable
reaches a step, whatever its name. Commands run with `--unshare-net`; bwrap brings loopback up, so local
test servers work and egress fails. Setup is the one step that keeps network, so it also gets the
resolver bind: when the host's `/etc/resolv.conf` is a symlink whose target lies outside the
jail's curated system roots (WSL2: `/mnt/wsl/resolv.conf`, never bound wholesale), the jail ro-binds
exactly that resolved target file at the same path so DNS resolves. `.env` and `.claude/` in the clone are masked. stdout and stderr are
each kept as a 16 KiB tail. On timeout the whole process group gets `SIGTERM`, then `SIGKILL` after 5 s,
and the runner waits for the exit before it records the result.

**Jail hermeticity contract.** The Confinement paragraph above states the jail's shape; this
is the contract a repo's own test suite writes to when it runs as a registered `commands[]` step.
*Validation commands* are network-denied (`--unshare-net`; bwrap still brings loopback up, so local test
servers work) and run with a `--clearenv` allowlisted env — `PATH` (runtime `bin/` dirs, then
`/usr/local/bin:/usr/bin:/bin`), `HOME=/tmp`, `TMPDIR=/tmp`, and the registry's own `env` — inside a fresh
temp clone of the delivery sha whose absolute path the suite does not control and must not assume. The
*optional setup step* is the one exception: it DOES get network (so `npm ci` etc. can reach the registry),
with npm lifecycle scripts forced off. A suite that depends on something outside this contract — a host
binary not on the allowlisted `PATH`, a real absolute path, an env var the registry does not declare —
fails inside the jail even when it passes on the host unconfined.

The fix is never a skip list, a jail marker env var, or a `wiki/.dispatch/validation.json` exclusion —
each of those hides the gap instead of closing it. A test that needs a capability the jail may not have
probes that capability directly (never a proxy, never "any error occurred") and self-skips on that probe
alone, with `describe.skipIf`/`it.skipIf` and a reason naming the capability; a jail-skipped test still
runs on the host gate, so it never goes dark everywhere. Most failures are not even a missing capability —
they are a test accidentally depending on real host state (an installed CLI, a real file, a real network
service) that the hermetic jail does not carry; the fix there is to make the test's dependency a fixture at
its own public seam, not a skip.

**Evidence.** `derive-review` writes `validation-evidence.json` into the delivered implement run's dir
(`.agent-runs/runs/<implement_id>/<run_id>/`). It holds `handoff_id`, `run_id`, `delivery_branch`,
`delivery_sha`, `registry_fingerprint` (sha256 of the effective registry), per-step `argv`, `exit_code`,
`signal`, `timed_out`, `duration_ms`, `stdout_tail`, `stderr_tail`, `result`, and an overall `outcome`
(`pass` only when setup and every command passed). A failing command is evidence, not an error: the
review still derives. This JSON is the record; the review HO's evidence section renders from it.

**Review dispatch.** A derived review is a `code_review` HO with a `dispatch/` `base_ref` and a
`reviewed_run` stamp. Dispatching one copies the evidence JSON and
`wiki/handoffs/<implement_id>.response.md` into the review's own run dir as `validation-evidence.json`
and `implement-response.md`. The run dir is bound into every jail, so the reviewer reads both in either
wiki shape. The prompt names the two paths and says that executing tests or the toolchain is out of
scope. If the evidence or the response is gone, the dispatch refuses; re-run `derive-review`. The copies
belong to the reviewer only: the merge gate never reads them.

### `merge-delivery`

Merges `dispatch/<handoff_id>` into the current branch and deletes the delivery branch. Local only — no
remote push.

Preconditions (checked in order, fail-closed):
1. Review evidence: a `code_review` HO whose `base_ref` is `dispatch/<handoff_id>` has a response doc.
   Evidence is read from that doc's frontmatter — `recovery_outcome`, `recovery_valid`,
   `worker_report_chars` (see "Capture and Provenance") — never by re-parsing the rendered
   `## Worker Report` markdown. DEC-0037: review is prose-first — `recovery_valid: true` with a
   passing `recovery_outcome` (`no_findings`/`passed_no_blocking_or_medium_findings`) merges with
   `verdict: structured`; a passing-shaped block reporting anything else (e.g. `changes_requested`)
   refuses, no operator override in this slice; `recovery_valid` false/absent with `worker_report_chars >
   0` still merges, as `verdict: advisory` (the orchestrator/operator reads the prose) — only
   `worker_report_chars === 0`, a missing review HO/doc, or a response doc predating these frontmatter
   fields (all three absent — no legacy regex fallback) refuses outright.
2. Working tree clean
3. Delivery branch exists
4. Host validation evidence. The gate reads only the host original: the
   `validation-evidence.json` in the implement run dir named by the review's `reviewed_run`, never the
   reviewer's copy. It refuses when the review has no `reviewed_run` or `reviewed_sha`, the evidence is
   missing or unreadable, the evidence belongs to another run, the evidence `outcome` is `fail`, or the
   `registry_fingerprint` differs from the current `validation.json` (revalidate by re-running
   `derive-review`). An override can clear each of these. A delivery branch whose head is not the review's
   `reviewed_sha` or the evidence `delivery_sha` always refuses, because the reviewed commit is not what
   would merge; no override applies. The review's own stamp is the binding: re-running `derive-review`
   for the same run overwrites that run's evidence, so evidence for a new head says nothing about which
   head an older review saw.
5. Merge succeeds (fast-forward or a real merge). The merge names the evidence sha, not the branch; it
   aborts and refuses on conflict

**Override (DEC-0047 A2 R8).** `override_reason` and `override_actor` (MCP; `override: { reason, actor,
surface }` in the API) let an operator merge past a step-4 refusal. Both must be non-empty. Before the
merge, dispatch writes `wiki/handoffs/<handoff_id>.merge-override.json` and commits it with the
isolated-index pattern. The record holds the reason, the actor (with `actor_authenticated: false`: it is
self-reported, because no identity exists on the MCP path), the call surface, the merged sha, the run id,
the refusal reasons, and the per-command results. If that commit fails, the file is removed and the merge
refuses. An orchestrator passes the override only on an explicit operator instruction. The result reports
`gate: "evidence"` or `gate: "override"`, plus `mergedSha` and, for an override, `overrideRecord`.

### `cleanup`

Removes orphaned `.agent-runs/reviews/` and `.agent-runs/runs/` directories past a retention window
(default 7 days), and sweeps older sibling runs of the same HO once a newer one is removed so
a stale run can never resurface as "latest."

### Orchestration Recipe

The full dispatch loop with lifecycle tools:

```
orchestrator authors HO         → create-handoff
orchestrator dispatches         → dispatch + watch
pipeline executes + delivers    → automatic
pipeline auto-commits artifacts → DEC-0038 (automatic)
orchestrator reads result       → HO-XXXX.response.md
orchestrator derives review     → derive-review (host runs validation.json, records evidence)
orchestrator dispatches review  → dispatch + watch (same cycle)
pipeline auto-commits review    → DEC-0038 (automatic)
orchestrator reads review       → review response.md
orchestrator merges on pass     → merge-delivery
```

## Refusal Codes

Every code the admission/pipeline gate can return as a synchronous refusal (before a worker ever
spawns), grouped by the phase that raises it. `V2_REFUSAL_CODES` in `packages/dispatch-core/src/errors.ts`
is the source list; a test fails if this table and that list disagree:

| Phase | Codes |
|-------|-------|
| Handoff shape | `BAD_RECORD` |
| Admission (repo-local) | `MISSING_WRITE_SCOPE`, `ENVELOPE_EXCEEDS_MODE`, `STALE_WRITE_SCOPE`, `WRITE_SCOPE_UNCAPTURABLE`, `MISSING_READ_FIRST`, `DIRTY_REPO`, `UNCOMMITTED_READ_FIRST`, `BAD_BASE_REF`, `BAD_DATA_MOUNT`, `BAD_RUNTIME_ENV`, `RUNTIME_EXPORT_OVERLAP`, `WORKER_TIMEOUT_EXCEEDS_CAP`, `WORK_ITEM_NOT_FOUND`, `REVIEWED_SHA_MISMATCH`, `BASE_DRIFT`, `ADMISSION_FAILED` |
| Model/backend resolution | `MODEL_NOT_FOUND`, `EFFORT_UNSUPPORTED`, `NO_MODEL_DEFAULT`, `AMBIGUOUS_MODEL_DEFAULT`, `AMBIGUOUS_BACKEND` |
| Credentials | `CREDENTIALS_WITH_WEB`, `UNKNOWN_PROFILE`, `CREDENTIAL_NOT_CONFIGURED` |
| Host / prompt budget | `PREFLIGHT_FAILED`, `NO_ISOLATION_ROUTE`, `CLI_PATH_NOT_MOUNTABLE`, `CONTEXT_BUDGET_EXCEEDED` |
| Worker-specific | `CLAUDE_PERMISSION_PROBE_FAILED` |
| Concurrency | `ACTIVE_RUN_EXISTS` |

`ACTIVE_RUN_EXISTS` is same-handoff single-flight only: one active run per HO. Different handoffs
dispatch concurrently, each in its own clone of `base_sha`. Only merges to main serialize.

`dispatch` itself is background-only: it returns a `watch` command immediately rather than blocking on
the worker. A refusal above happens synchronously, before that background run is even started.

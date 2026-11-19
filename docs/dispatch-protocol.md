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

### Generating an HO from a slice row

An `implement` handoff is always generated from a slice of a work item, and a work item that is built
declares a `## Slices` table; one row is enough. `create-handoff --wk WK-NNNN --slice s1` (MCP: `wk`,
`slice`) reads the row and the work item and writes the HO. A hand-specified `implement` handoff
(explicit `title`, `acceptance`, `validation`) is refused at authoring, and `dispatch` refuses one
whose `slice` is not a row of its work item. The explicit-fields path stays for `redteam`, `research`
and `explore_code`. `write_scope` and `validation` come from the row; `read_first` is the row's files that
exist at generation time (a new slice's files do not exist yet, and admission refuses a missing
`read_first` path) plus the work item path; `title` defaults to the row title and `mode` to
`implement`; `work_item` and `slice` are recorded. `--subject` and `--allowed-agents` are still
required.

`objective` and `acceptance` come from the slice's own section in the work item, a `### Slice <id>`
heading that ends at the next heading of level 3 or higher. The text before its `#### Acceptance`
heading is the task; the list items under it are the acceptance. The objective starts with one
generated paragraph that names the slice, its title and the work item, says to build this slice only,
and lists the other slices by id and title as out of scope; then comes the task text verbatim, then
`Work item objective, for context only:` and the `## Objective` text unchanged. The acceptance is the
slice's items verbatim and nothing else: no generated item, none from the work item. The planner
writes the section once; code copies it.

With no such section, a table with one row means the slice is the whole work item: `objective` is
the `## Objective` text and `acceptance` the `## Acceptance criteria` items. A table with several rows
is refused, because a row alone does not say which part of the work item the slice builds.

`--timeout-secs <n>` (MCP: `timeout_secs`) writes the `timeout_secs` field on either path; it must be
a positive integer, and `create-handoff` refuses anything else.

An acceptance item, in a slice section or the work item list, is a top-level list entry (`-`, `*`, `1.` or `1)`, with an optional `[ ]`/`[x]`
box). The lines indented under it (wrapped text, sub-bullets, a fenced block) belong to it and are
joined with single spaces; a sub-bullet loses its marker. Lines inside a fenced block are never
items. Any other non-blank text in the section is refused, naming the line.

`create-handoff` refuses, writing nothing, when `mode` is `implement` and `wk` and `slice` are not both
given, when `wk` or `slice` is given without the other, the work
item or the slice id does not exist, the work item has no `## Slices` table, the work item has no
`## Objective` text, the slice has no section and the table has several rows, a slice section has no
task text, no `#### Acceptance` heading or no items, the criteria text is not parseable (a one-row
table reads the `## Acceptance criteria` items), the row has an empty validation
cell, `work_item` is given and differs from `wk`, or any derived field (`write_scope`, `read_first`,
`objective`, `acceptance`, `validation`) is also passed. Editing the work item or the row after
generation trips the Base Drift Gate at `dispatch`; regenerate the HO.

A fix-up is the same call plus `base_ref` and `fixup_context`; `fixup_context` without `base_ref` is refused,
because a fix-up repairs an earlier delivery. It carries the slice row's write scope. Its objective says the
slice is already built on `base_ref`, that the task is to fix what the handoff's `fixup_context` lists (the worker's prompt shows it under a "Findings to fix" heading)
(each fix with a test that fails before the fix and passes after it), and that the branch must still satisfy the
slice text, which follows as the standing spec. One acceptance item is appended to the slice's own list: each
finding is fixed with such a test. The findings section does not widen the write scope or grant any other authority.
A fix-up that must touch a file outside the row needs the row widened first.

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
| `slice` | string | Slice row id (e.g. `s1`) of the work item's `## Slices` table this HO was generated from; set by `create-handoff --wk --slice`; required for `mode: implement`, and admission refuses an `implement` HO whose `slice` is not a row of its work item |
| `reviewed_run` | string | Run id a `code_review` HO targets. Must be a dispatch run id (`RUN-<uuid>`); anything else is `BAD_RECORD` at parse |
| `reviewed_sha` | string | Delivery-branch commit a derived `code_review` HO was derived for (full sha; anything else is `BAD_RECORD` at parse). Dispatch refuses unless `base_ref` resolves to it; `merge-delivery` accepts a head past it only when every later commit is a dispatch implement delivery |
| `web` | boolean | Default `false`. Never allowed for `code_review`/`redteam` |
| `credentials` | string[] | Names from `wiki/.dispatch/profiles.json`. Mutually exclusive with `web: true` |
| `data_mounts` / `export_mounts` | string[] | Absolute host paths *outside* the repo root, bound `ro` / `rw` into the jail. Must already exist |
| `runtime_envs` | string[] | Absolute paths to pre-installed runtime env roots (e.g. a conda/mamba env), implement-mode only — see "Runtime Env Projection" below |
| `read_first` | string[] | Repo-relative paths; each must exist where the worker reads it at dispatch time (`MISSING_READ_FIRST`; see "Where read_first resolves") |
| `vars` | string[] | `"KEY=value"` non-secret literal env for the worker |
| `fixup_context` | string | The review findings (or red-test failure) a fix-up repairs, injected verbatim; needs `base_ref`. An implement handoff renders them as the task of the fix-up; they grant no write scope or other authority. `create-handoff --fixup-context` writes it as a one-line JSON string, so any text survives. State each fix as a property of the whole branch with the command that proves it; restate every standing property of the tests the fix-up touches |
| `work_item` | string | `WK-####`; required for `mode: implement`, and its `wiki/issues/<id>.md` must exist and declare the HO's `slice` |
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

A work item's build chain is implement, code_review, merge. A redteam runs against a plan or spec
before the build, or on the operator's order; it is not a step of a build chain.

## Admission Gate

Every `dispatch` call runs the same checks, in order, failing closed on the first violation. Nothing
here is a persisted review state — it all re-runs, every time, against the live repo.

| Check | Refusal code |
|-------|--------------|
| Handoff parses (required fields, valid `mode`) | `BAD_RECORD` |
| `write_scope` empty outside `implement`, or `web: true` for `code_review`/`redteam` | `ENVELOPE_EXCEEDS_MODE` |
| `implement` with empty `write_scope` | `MISSING_WRITE_SCOPE` |
| Every `write_scope` entry is repo-relative and resolves inside the repo; no entry has a `.git` path segment or resolves (plain string form, `""`/`.`/`./`/`/`) to the repo root; resolving the entry through its nearest EXISTING ancestor's realpath (joined with the not-yet-existing remainder) must not land on the repo root or touch `.git` either — for every family, naming only the entry, and before anything is created from it | `STALE_WRITE_SCOPE` |
| Every `read_first` entry exists — in the `base_ref` tree for a chained HO's entries (wiki entries too when `wiki/` is tracked by the repo), else in the working tree | `MISSING_READ_FIRST` |
| Repo is clean (`git status --porcelain` over `write_scope` paths only; with an empty `write_scope` — every advisory mode — the scan is skipped and declared-path staleness is covered by the base-drift gate) | `DIRTY_REPO` |
| Every `read_first` entry is committed — no modified, staged, or untracked file under it (wiki entries checked in the wiki repo when nested-private); checked before base drift | `UNCOMMITTED_READ_FIRST` (see below) |
| `base_ref`, if set, starts with `dispatch/` and exists | `BAD_BASE_REF` |
| Every `data_mounts`/`export_mounts` entry is absolute, exists, and is outside the repo root | `BAD_DATA_MOUNT` |
| `runtime_envs` only declared for `mode: implement` | `ENVELOPE_EXCEEDS_MODE` |
| Every `runtime_envs` entry canonicalizes (realpath) to an absolute, existing, mountable path that is not `$HOME` itself and has a `bin/` dir | `BAD_RUNTIME_ENV` |
| No `runtime_envs` entry overlaps a `export_mounts` entry in either direction | `RUNTIME_EXPORT_OVERLAP` |
| `timeout_secs`, if declared, does not exceed the operator cap (`wiki/.dispatch/limits.json`'s `max_worker_timeout_secs`; absent = 1800s) | `WORKER_TIMEOUT_EXCEEDS_CAP` |
| `implement` declares a `work_item` whose `wiki/issues/<id>.md` can be read (read from the working tree, in both wiki shapes) | `WORK_ITEM_NOT_FOUND` |
| `implement` declares a `slice` that is a row of that work item's `## Slices` table | `BAD_RECORD` |
| An HO carrying `reviewed_sha`: the commit it would clone (`base_ref`, else HEAD) is that sha — a derived review runs only against the head it was derived for | `REVIEWED_SHA_MISMATCH` |
| Fresh-HEAD HOs: declared paths haven't changed since `base_sha`/`base_wiki_sha` | `BASE_DRIFT` (see below) |

### Where read_first resolves

The worker's clone is cut from `base_ref` (or HEAD when it is null), so admission checks each `read_first`
entry where the worker will read it:

1. `wiki/…` entries of a nested-private wiki (its own git repo, bound live into the jail) resolve against
   the wiki working tree. The same holds for any HO with `base_ref` null.
2. For a chained HO (`base_ref` set), every other entry resolves against the `base_ref` tree — and so does
   a `wiki/…` entry when the repo tracks `wiki/` itself, because the clone carries the `base_ref` copy of
   `wiki/`. If the wiki shape cannot be probed, wiki entries fall back to the working tree and the
   other gates report the broken wiki source.
   (`git cat-file -e <base_ref>:<path>`). A file that exists only on that branch is admitted. A file
   that exists only on `main` is not in the clone, so admission refuses `MISSING_READ_FIRST` with
   guidance: dispatch artifacts (the implement response, validation evidence) reach the worker through
   the run-dir evidence channel, review findings a fix-up needs belong in the `fixup_context` field, and
   other content belongs in the HO context. Nothing is copied into the clone. A tracked-wiki file that
   exists in both trees but changed on main after the branch was cut is still admitted; the worker reads
   the older `base_ref` copy.
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
its own ephemeral clone (checked out at the pinned `base_sha`), its family's credential snapshot (if
any), and the HO's declared `data_mounts`/`export_mounts`. There is no whole-root bind and no blanket
`$HOME` access.

- **Credential snapshots, not a `$HOME` bind** — the mount list names no `$HOME` credential path. At
  launch each family's needed files are read once on the host as UTF-8 and carried as a value-list
  snapshot (see "Resolved-value scrubbing"): Claude's `~/.claude/.credentials.json`; Codex's
  `~/.codex/auth.json` only (the host `~/.codex/config.toml` is no longer mounted); Pi needs none (its
  key is env-injected, its config dir is jail tmpfs). The same bytes are materialized at the same path
  read-only through bwrap's `--ro-bind-data`, for every mode including `implement` — there is no host
  copy and no writable auth leaf. A missing or unreadable file stops the run before spawn with
  `CREDENTIAL_NOT_CONFIGURED`, naming the file only; malformed JSON fails the value-list build, naming
  the snapshot label only, never the bytes.
- **`write_scope` mounts bind exact files for every family** — Claude, Codex, and Pi (Pi binds exactly
  what was declared; Claude and Codex each get the declared file or directory, never a parent widened
  to cover it). A Claude worker edits a write_scope file in place through Bash, with its native `Edit`/
  `Write`/`NotebookEdit` tools denied: those tools save by renaming a temp sibling file into place,
  which needs write+execute on the containing directory — an exact-file bind, by design, refuses that
  rename (`EROFS`), so Bash is Claude's only write path inside a jail.
- **Entries are resolved and refused before anything is created** — the admission-gate entry-shape
  rule above, and the clone-side write_scope skeleton step that pre-creates each declared path, both
  resolve every entry through its nearest existing ancestor before creating anything for ANY entry in
  the list; a refusal (a tracked symlink ancestor aliasing the repo root or `.git`, e.g. `alias ->
  .git` with entry `alias/worker.txt`) leaves the clone unchanged — nothing is created through the bad
  entry, and nothing created for an earlier good entry in the same list survives either, since every
  entry is checked before the first create. A further mount guard still runs as the final check, over
  the family-resolved mount list, after the skeleton exists on disk — belt-and-suspenders over the
  same clone, never a substitute for resolving and refusing before creation.
- **Secret masking, the read-only run dir, then the final read-only `.git` bind** — a clone's own
  `.env` is masked to `/dev/null` and `.claude/` to a fresh tmpfs when either is present (a committed
  secret or agent config in the mother repo's working tree must never reach the jail). The run dir is
  then bound read-only (`--ro-bind <run-dir> <run-dir>`), and last, as the LAST mount operation of
  every plan (worker and host-validation alike), an unconditional, strict
  `--ro-bind <clone>/.git <clone>/.git`. That order matters: bwrap resolves later binds over earlier
  ones, so no mask (nor any write_scope bind) can ever land after the `.git` bind and reopen it — this
  is the sole protection for a host-validation jail, which declares no `write_scope` and otherwise
  binds the whole clone read-write. Only injected-file args (`--file` jail-`/tmp` destinations and the
  `--ro-bind-data` credential snapshots) and `--chdir` follow the `.git` bind. A tracked symlink at a
  mask path (`.claude -> .`, `.claude -> .git`,
  `.env -> <file>`) is refused before any jail ever starts: cloning fails closed, naming the path.
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
  executes a credential command and never embeds a resolved value in generated text). Every `inject`
  key must be a valid shell variable name (`[A-Za-z_][A-Za-z0-9_]*`); a key that is not — for example
  `BAD-NAME` or `X;rm` — is refused at profile load with `BAD_RECORD`, naming the profile and the key,
  because the key is interpolated into generated credential and value-scan scripts.
- `endpoints` (optional) is the array of hostnames — exact or `*.suffix` wildcard — this profile grants
  network access to. Appended to the forwarder's granted endpoint set only when the profile is named in
  the HO's `credentials:` field.
- An HO names profiles by name only (`credentials: ["aws"]`); it never carries a secret value.
- **`CREDENTIALS_WITH_WEB`** — `credentials:` and `web: true` are mutually exclusive in the same HO. A
  worker must never hold both a live secret and open network access in the same run.
- A `vars` key that collides with an injected credential's var name (or the backend's own
  `api_key_env`) is refused — a non-secret channel must never be able to shadow or masquerade as a
  credential.
- The stage re-scans the staged tree's diff for each granted credential's literal value before any
  commit; a hit refuses the delivery (`secret_in_diff`, see "Delivery") rather than landing it.

### Resolved-value scrubbing

Every resolved credential value is masked in the worker's streams and captures, not only in the
delivery diff. At launch `runDispatch` builds one ordered value list and hands it to `spawnIsolated`;
the list is the exact set of resolved pairs, never a name:

- **Value sources.** Each granted profile's `inject` entries (the value read from its file, keyed by the
  env var name); the backend's own key read from `api_key_env` + `secrets_file` (an entry that sets
  `api_key_env` must name its `secrets_file` — `loadRepoConfig` refuses otherwise with `BAD_RECORD`,
  naming the backend, so a key is never silently unscrubbed); and each family's credential-file
  snapshot — every string leaf of a parsed JSON file at least 16 characters long, named
  `<label>:<key.path>` with array indices as `[n]`, e.g. `x:a[0].b`. Claude's
  `~/.claude/.credentials.json` and Codex's `~/.codex/auth.json` are read once on the host at launch
  and both scrubbed (the snapshot) and injected read-only (`--ro-bind-data`).
- **Match forms.** Five per value, deduplicated: the raw value, its JSON-escaped form once and twice,
  its `encodeURIComponent` form, and standard base64 of its UTF-8 bytes. This catches a value logged
  verbatim, embedded in a JSON string, double-escaped in a nested JSON string, URL-encoded, or
  base64-encoded.
- **Floor.** A value shorter than 16 characters (UTF-16 code units) is not scrubbed; a 16-character one
  is. Short values are too collision-prone to blanket-redact.
- **Replacement.** `[REDACTED:<name>]`, where the pair's env var name (or the snapshot leaf name) is
  used verbatim except that `"` and `\` in it become `_`.
- **Matching.** Leftmost-longest over the buffer; when two values match at the same start the longer
  wins, and an exact tie goes to the value earlier in the list.
- **Streaming.** Both stdout and stderr pass through a streaming scrubber: each push scans its whole
  buffer, emits everything before a cut, and holds the rest. The cut starts one byte inside the longest
  form length and moves back to the earliest start of any form occurrence that straddles it, so a value
  split across two `write()` chunks, or one that contains a newline, is still caught and no partial value
  is emitted. Every finish path — normal exit, timeout kill, spawn error — flushes both scrubbers before
  the run resolves. The scrubbed bytes feed the in-memory capture, the on-disk `worker-output.log`, and
  therefore `status`'s log tail; without a value list the bytes are unchanged.
- A credential-file snapshot that is not valid JSON fails the build with `CREDENTIAL_NOT_CONFIGURED`,
  naming the label only and never the bytes.

The stage diff's own value scan (above) remains the delivery-side check until the stage-diff scrubber
increment replaces it.

## Host Requirements

`dispatch` gates on one fact, for every family and every mode: does bubblewrap work end-to-end (the
binary runs, and a live `--unshare-user` round trip succeeds)? There is no per-family or per-mode
tiering and no unenforced fallback — if that probe fails, the call refuses with `NO_ISOLATION_ROUTE`
and prints remediation text (install bubblewrap, or relax an AppArmor unprivileged-userns restriction
on Ubuntu 24.04+). `check-environment` runs the identical probe on demand, plus informational container
detection and `HOME`/config-dir writability facts, so an operator can see what a real `dispatch` call
will do on a given host before running one.

Preflight also probes the host `git` and refuses `PREFLIGHT_FAILED` before any worker runs when
`git --version` is below **2.41**, or when git is missing or reports no parseable version. Host delivery
pins path attributes to the trusted base tree with `--attr-source`, an option git added in 2.41; with
preflight skipped (`preflight: false`), the delivery's first stage command exits non-zero on an older
git and the run fails closed.

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

An entry that sets `api_key_env` must also set `secrets_file`: `loadRepoConfig` refuses the entry with
`BAD_RECORD`, naming the backend, so a key can never be declared without a file to read it from (and
scrub it from). A local model (Ollama, vLLM, …) is just a `pi`-family backend entry with a `base_url`
pointing at the local server and `api_key_env: null` — there is no separate pluggable-agent-wrapper
mechanism. Codex
and Claude backends normally leave `base_url: null` (the CLI reaches its SaaS provider directly);
setting a custom endpoint is the exception (Azure OpenAI, a proxy). `effort_mapping` is a capability
declaration, not a boolean flag: a backend with no mapping does not support `--effort`, full stop
(`EFFORT_UNSUPPORTED`).

## Delivery

Only `implement` mode delivers. After the worker exits, the pipeline runs one **stage → check → land**
pass over a single tree: the tree the check approves is exactly the tree that lands.

**Stage.** A `bash` script in the clone (`set -euo pipefail`) seeds a temporary index from `base_sha`,
stages the full worktree delta (`add -A`), writes the tree, and prints `TREE <sha>` before it writes a
raw, NUL-delimited `--raw` listing of the change to a file. Every host-side git call inside the clone
runs as `git --attr-source=<ATTR_SHA> -c core.autocrlf=false -c core.eol=lf -c core.hooksPath=
-c core.fsmonitor=`. `ATTR_SHA` is the mother repo's `HEAD` at admission — never a chained `base_ref` —
so a worker's `.gitattributes` cannot select a host filter, and no nested-repo config runs. A non-zero
stage exit is `DELIVERY_FAILED`: no content is named and nothing lands.

**Check.** The parser fails closed on a bad stdout grammar, a missing or truncated listing, or a listing
past `MAX_BUFFER_BYTES`. The stage result is judged in this fixed order, and the first hit decides:

1. `no_delta` — `TREE` equals `base_sha^{tree}`.
2. a gitlink (mode `160000`) anywhere — an embedded repo is not a change to commit.
3. every changed path against the *unwidened* `write_scope` (directory-prefix or exact match; both ends
   of a rename).
4. each granted credential's literal value against `git diff --text --no-renames BASE_SHA TREE`.

A hit on 2 or 3 is `refused_out_of_scope` for those paths; a hit on 4 is `secret_in_diff`.

**Land.** A clean tree is committed with `commit-tree TREE -p base_sha` and a pinned identity
(`kb-dispatch <dispatch@kb.local>`), then pushed with compare-and-swap semantics onto
`refs/heads/dispatch/<handoff_id>`. The land script prints exactly one token — `DELIVERED:<sha>`,
`IDEMPOTENT`, or `CONFLICT:<tree>`. The same tree from the same base is an idempotent no-op; a different
tree from the same base is a structured `conflict`, never a clobber.

On any refusal the pipeline writes the stage diff to `quarantine.diff` in the run dir; a diff that
exceeds `MAX_BUFFER_BYTES` fails the run with `DELIVERY_FAILED` rather than truncating or committing.

| Outcome | Meaning |
|---------|---------|
| `delivered` | Landed onto `dispatch/HO-XXXX`; branch + commit + changed files reported |
| `no_delta` | Worker ran but produced no tree change |
| `no_changes` | Advisory mode (nothing to deliver), or an idempotent re-delivery |
| `refused_out_of_scope` | A changed path fell outside `write_scope`, or any path is a gitlink (embedded repo); diff quarantined to the run dir |
| `secret_in_diff` | A granted credential's value appeared in the diff; diff quarantined |
| `conflict` | `dispatch/HO-XXXX` already carries a different tree from the same base |

Advisory modes (`code_review`/`redteam`/`research`) never reach this gate at all — their §-envelope
grants no write authority. The pipeline still runs the same stage script for them, but with an **empty
`write_scope` and no skeleton paths**, purely as a mutation check: every staged or ignored path is a
stray mutation, reported as a warning (`advisory-mode worker (<mode>) modified <n> file(s) — mutations
discarded: ...`) and discarded when the ephemeral clone is torn down. The check is detection only — a
failed stage is never fatal and never blocks capture — and the run's delivery stays `no_changes`,
because the worker's own response *is* the deliverable.

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
uncommitted changes, in either wiki shape. A chained HO's entries that resolve against `base_ref` (see "Where read_first resolves")
are committed by construction and are not checked.
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

Creates a `code_review` HO from a delivered `implement` HO, using the host validation evidence for the
delivery (see "Host Validation Evidence" below; it reuses the evidence the delivery already produced). `title` = `Code review: <implement_title>`,
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
existence predicate shared with admission's `checkMissingReadFirst` (the rule in "Where read_first resolves"). `DeriveReviewResult.droppedReadFirst`
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

**Coverage: a review after a finished review covers only what follows it.** A chain review is
*finished* when it is a `code_review` HO whose `base_ref` is a chain member's branch, it has a
`reviewed_sha`, and its response doc records a run that completed (`outcome: delivered`) and holds a
valid block or a non-empty report (`recovery_valid`, `worker_report_chars > 0`; the same frontmatter
`merge-delivery` reads, through the same definition). A review whose run failed, timed out or was
cancelled is not finished, whatever text it left. Among the finished reviews whose `reviewed_sha` is the
head or an ancestor of it, the nearest to the head is the earlier review `R`; a finished review whose
sha is not an ancestor of the head, or is not a commit in the repository, is ignored.

- No such review: the whole chain is reviewed, as described above.
- `R` is the head: `BAD_RECORD` — `Review <id> already covers the head <short sha>; nothing is
  unreviewed. Next step: judge that review's findings and call merge-delivery for <implement id>; it
  checks the test evidence again itself.` A hand-authored `code_review` carries no `reviewed_run` or
  `reviewed_sha` stamp, so it is not a coverage candidate and cannot pass the merge gate without an
  override.
- `R` is before the head: a fix-up review. The range under review is `R..<head>`; only the chain members
  whose delivery commit is in that range are listed, and `read_first` and `acceptance` come from them
  alone (`AGENTS.md` still added). The Objective keeps its fixed-text form and says that the review covers
  only the commits after review `<R id>`, that each finding under "Findings this fix-up was asked to fix"
  must be fixed with a test that fails before the fix and passes after it, that these commits must add
  no new defect, and that code outside the range is not re-reviewed except where these commits change
  its behaviour. The Context gains, after the Host Validation Evidence, a "Findings this fix-up was asked
  to fix" section holding each covered member's `fixup_context` verbatim under its HO id, in a code fence
  longer than any backtick run inside the text (`(none recorded)` when it has none). One fixed sentence
  above the fences says the text was written by the orchestrator and is not evidence. Stamps
  (`reviewed_run`, `reviewed_sha` = the head), the Host Validation Evidence, the copied fields and
  `base_ref: dispatch/<head>` are as for a whole-chain review.

`DeriveReviewResult` reports `kind` (`whole_chain` or `fixup`), the `range` covered, and for a fix-up the
`earlierReviewId`. `merge-delivery` still requires one judgment per finding of every review on the chain.

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
  "runtime_paths": ["/opt/node-22"],
  "data_mounts": ["/srv/fixtures/golden"]
}
```

| Key | Meaning |
|---|---|
| `setup` | Optional. Runs first and is the only step with network. npm lifecycle scripts are forced off (`npm_config_ignore_scripts=true`). If setup fails, no command runs. |
| `commands[]` | `name` (`[A-Za-z0-9._-]+`, unique), `argv`, `timeout_ms`. They run in order, network-denied. |
| `env` | Extra variables for every step. `PATH`, `HOME`, and `TMPDIR` are reserved. |
| `runtime_paths` | Absolute runtime roots. Each must have `bin/`, live under `$HOME` or a system root, and not be `$HOME` itself. Each is bound read-only, and its `bin/` goes first on `PATH`. |
| `data_mounts` | Absolute read-only data/fixture paths — the same entry rule as a handoff's `data_mounts`: absolute, exists on disk, outside the repo root; no `$HOME`/system-root requirement and no `bin/`. Each is bound read-only at the path as declared (a symlinked entry is bound at its link path, not canonicalized), into every step of both the delivery run and its baseline. An entry equal to, or an ancestor of, the dispatch clone root is refused. Absent = no data mounts, and the registry fingerprint is unchanged from before this key existed. |

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

**When it runs.** The pipeline runs host validation right after every `implement` run that delivers, so a
delivery has evidence before anyone reviews it. A red suite does not change the run's `delivered` outcome;
it is recorded in the evidence. If validation cannot run at all (unreadable registry, jail failure), the
delivery stands, no evidence file is written, and the response doc says `not run` with the cause. The
response doc carries one line under `## Outcome`: `Host validation: pass.`, `Host validation: fail
(<failed command names>).`, or `Host validation: not run (<reason>).` `derive-review` and `merge-delivery` reuse the evidence on
disk when it is for the same delivery sha and the current registry fingerprint and it passed; they run the
suite again when either changed. A stored red result is always re-checked (a flaky failure must not stick
to a delivery) and the evidence file is rewritten; a stored green is never re-run. A stored file that is
unreadable or malformed counts as stale: the cause goes to stderr, the suite runs again, and the file is
rewritten. Other modes never run
host validation.

**Baseline on red.** When a validation run of a delivery ends red, the host also runs the same registered
setup and commands, in the same jail conditions, on the base commit: the merge-base of the delivery sha and
the mother repo's current `HEAD`. The result goes into `validation-evidence.json` under the optional
`baseline` field: `{ "status": "ran", "base_sha", "setup", "commands" }` with steps in the same shape, or
`{ "status": "not_run", "reason" }` when it could not run (no merge-base, clone or jail failure). The
baseline never changes `outcome`: red stays red. It does not run when the delivery is green, and a baseline
that cannot run does not fail the validation. The evidence block in the review HO states, for each failed
step, its result on the delivery next to its result on the base commit, and the response-doc line adds
`Also failing on the base commit: <names>.` when some of them also fail there, `The base commit passes the
same commands, so this delivery introduced the failure.` when none do, or says the baseline did not run,
with the reason. The merge gate reads the same facts to choose the next step it names (see step 7 of the
merge preconditions); the outcome stays red whatever the baseline says.

**Evidence.** The pipeline writes `validation-evidence.json` into the delivered implement run's dir; `derive-review` and `merge-delivery` write it again when the stored result is red, missing or stale
(`.agent-runs/runs/<implement_id>/<run_id>/`). It holds `handoff_id`, `run_id`, `delivery_branch`,
`delivery_sha`, `registry_fingerprint` (sha256 of the effective registry), per-step `argv`, `exit_code`,
`signal`, `timed_out`, `duration_ms`, `stdout_tail`, `stderr_tail`, `result`, and an overall `outcome`
(`pass` only when setup and every command passed). A failing command is evidence, not an error: the
review still derives. This JSON is the record; the review HO's evidence section renders from it.

**Review dispatch.** A derived review is a `code_review` HO with a `dispatch/` `base_ref` and a
`reviewed_run` stamp. Dispatching one copies the evidence JSON and
`wiki/handoffs/<implement_id>.response.md` into the review's own run dir as `validation-evidence.json`
and `implement-response.md`. The run dir is bound read-only into every jail, so the reviewer reads both in either
wiki shape. The prompt names the two paths and says that executing tests or the toolchain is out of
scope. If the evidence or the response is gone, the dispatch refuses; re-run `derive-review`. The copies
belong to the reviewer only: the merge gate never reads them.

### `merge-delivery`

Merges the chain head `dispatch/<handoff_id>` into the current branch. A fix-up delivery builds on the
branch it fixes, so the head's history carries every earlier member (`HEAD..dispatch/<handoff_id>`, the
same chain `derive-review` walks). After the merge it deletes the head's branch and each other member's
branch that git confirms is fully merged (`git branch -d`, never forced). Local only — no remote push.

Trust boundary: a chain commit is recognised as a dispatch delivery by its commit subject and its
handoff's mode, not by a recorded run sha, so write access to the repository is trusted.

Preconditions (checked in order, fail-closed):
1. Delivery branch exists. This is checked before the review lookup, because the chain is read from
   it.
2. Review evidence: the governing review is the newest finished `code_review` HO whose `base_ref` is
   `dispatch/<id>` for any member of the chain, the head included. A fix-up delivery on top of a
   reviewed delivery needs no new review. A review is finished when its response doc exists, records a run
   that completed (`outcome: delivered`), and holds a valid block or a non-empty report. A review that
   was derived and never finished (no response doc, a run that did not complete, a response doc with none
   of the evidence stamps, or an empty report) is ignored for governing and judging, so it never forces
   another review. When the chain has reviews and none is finished, the merge refuses, naming each review
   with its state (`no response doc`, `run did not complete: <outcome>`, `no evidence stamps` or `empty
   report`) and the next step: dispatch it, or run `derive-review`. A review handoff file that cannot
   be read or parsed and names a chain branch as its `base_ref` refuses, naming the file and the
   problem: a hidden review must not change which review governs. Evidence is read from the governing
   doc's frontmatter — `recovery_outcome`, `recovery_valid`, `worker_report_chars` (see "Capture and
   Provenance") — never by re-parsing the rendered `## Worker Report` markdown. Review is prose-first.
   `recovery_valid: true` merges with `verdict: structured` whatever the outcome: a review advises and
   never vetoes, so `changes_requested` alone does not refuse. `recovery_valid` false/absent with
   `worker_report_chars > 0` merges as `verdict: advisory` (the orchestrator/operator reads the prose).
   A response doc with none of these fields (all three absent — no legacy regex fallback) is not
   finished, so it never governs; `derive-review` treats it the same way and derives a new review.
3. Commits after the review. The governing review's `reviewed_sha` must be the head or an ancestor of
   it (a sha that is not a commit in the repository refuses too), and every commit after it must be a dispatch delivery (`dispatch: HO-XXXX`) of an implement
   handoff in the chain. Any other commit — a hand edit, a merge, a commit outside the chain — refuses,
   naming the commit sha and subject; derive a review for the new head. No override applies, because
   that code was never reviewed. A review with no `reviewed_sha` skips this check and refuses at step 7.
4. Chain walk: every commit in `HEAD..dispatch/<handoff_id>` is a delivery of an implement handoff.
5. Judgments (see below). Checked after the chain is walked and before anything is committed.
6. Working tree clean within the merge's change set — not repo-wide. Any staged path
   (the index differs from HEAD) refuses outright, listing the staged paths: git aborts any merge
   whose index differs from HEAD regardless of path (git-merge(1) PRE-MERGE CHECKS). Otherwise, only
   a dirty path (unstaged or untracked) that collides with the paths `git diff HEAD...<branch>`
   reports — exact match, or either path a directory prefix of the other — refuses, listing just the
   colliding paths. A rename on the branch counts both its old and new path (the diff runs with
   renames off). An unrelated uncommitted file anywhere else in the repo never blocks the merge.
7. Host validation evidence is for the chain head, not the reviewed commit. The gate takes the head's
   latest delivered run and asks for evidence for the head sha (`evidenceForDelivery`): a passing
   record in that run dir for the same sha and registry is reused; otherwise the registered commands run
   now and the record is rewritten. A stored file that is unreadable or malformed counts as stale: the
   commands run again and the file is rewritten. It refuses when the review has no `reviewed_run` or
   `reviewed_sha`, the head has no delivered run, the evidence cannot be produced, the evidence belongs
   to another run, or the evidence `outcome` is `fail`. An override can clear each of these, and only
   these. The reviewer's copy of the evidence is never read. The refusal names the next step by what the
   baseline shows. A red result whose base commit passes the same commands says the delivery introduced
   the failure; the step is a fix-up handoff with `base_ref: dispatch/<id>`, then `merge-delivery` on
   the fix-up handoff. A red result that also fails on the base commit, or whose baseline did not run,
   says the failure is not specific to the delivery, keeps the jail hermeticity sentence, and names the
   step: fix the test's host dependency or the base, then call `merge-delivery` again. Any other problem
   says to fix the cause and call `merge-delivery` again. Every refusal ends with `An override needs an
   explicit operator instruction.`
8. Records: the override record and the judgments record are committed (see below).
9. Merge succeeds (fast-forward or a real merge). The merge names the evidence sha, not the branch. When
   `git merge` fails, the merge is aborted and the refusal carries git's output, says whether the abort
   itself failed (or that no merge was started and the working tree is unchanged), and names the record files already committed before the merge (they stay in history).

**Judgments.** Judgments cover `code_review` findings only; `redteam` handoffs are not judged at merge.
The findings to judge are the findings of every finished `code_review` on the chain (its `base_ref` is a
chain member's branch) whose response has a valid structured block. Deriving another review hides
nothing: the findings of every finished review still need judgments. Capture stamps them
into the response frontmatter as `recovery_findings`, a one-line JSON array of `{id, title, severity,
blocking}`; a malformed value, including one that lists an id twice, refuses. A review with no response
doc, a run that did not complete, an empty report, or no valid block adds no findings. The orchestrator passes `judgments`, a list of `{ review?, finding, judgment, reason? }`:
- `judgment` is `fix`, `dismiss` or `defer`. `dismiss` and `defer` need a non-blank `reason`.
- Every finding gets exactly one judgment. `review` (the review handoff id) may be left out only when
  exactly one review on the chain has findings.
- A `fix` needs that review's `reviewed_sha` to be part of the branch (an ancestor of the head) and at
  least one implement delivery of the chain after it. If the sha is not on the branch or not a commit in the repository (the branch was
  reset or delivered again, or the stamp was edited), judge the finding `dismiss` or `defer` with a reason. If no delivery follows, dispatch a fix-up with `base_ref: dispatch/<handoff_id>`, or judge the finding `dismiss` or
  `defer` with a reason. A review with no `reviewed_sha` cannot back a `fix`.
- The merge refuses, with nothing committed, when a finding has no judgment (the message lists each as
  `<review id>/<finding id> [<severity>] <title>`), when a judgment names an unknown review or finding or
  repeats one, or when a rule above fails. A judgment passed when no review has findings is an unknown
  finding. Passing none then is fine.
- `override` never stands in for a judgment.

When any finding exists, dispatch writes `wiki/handoffs/<handoff_id>.judgments.json` and commits it with
the same isolated-index commit as the override record, before the merge (if the commit fails, the file is
removed and the merge refuses). The record holds `schema: kb-dispatch-merge-judgments.v1`, the head
handoff id, the head sha, a timestamp, and for each review its id, `reviewed_sha`, outcome, and every
finding with its `judgment` and `reason`. The result reports `judgments: { total, fix, dismiss, defer }`
and `judgmentsRecord` (set only when a record was written).

Response docs written before the `recovery_findings` stamp have a valid block but no stamp. For these,
merge-delivery reads the findings table that capture rendered under `## Recovery Signal`, and nothing
looser. If the table cannot be read, the merge refuses and says to dispatch a new review. This fallback
goes away once no unmerged chain predates the stamp.

**Override (DEC-0047 A2 R8).** `override_reason` and `override_actor` (MCP; `override: { reason, actor,
surface }` in the API) let an operator merge past a step-6 refusal. Both must be non-empty. Before the
merge, dispatch writes `wiki/handoffs/<handoff_id>.merge-override.json` and commits it with the
isolated-index pattern. The record holds the reason, the actor (with `actor_authenticated: false`: it is
self-reported, because no identity exists on the MCP path), the call surface, the merged sha, the run id,
the refusal reasons, and the per-command results. If that commit fails, the file is removed and the merge
refuses. An orchestrator passes the override only on an explicit operator instruction. The result reports
`gate: "evidence"` or `gate: "override"`, plus `mergedSha` and, for an override, `overrideRecord`.

The result also reports `reviewCount` (`code_review` handoffs on chain members that have a response doc),
`implementDeliveries` (implement deliveries in the chain), `deletedBranches`, and `keptBranches` (each
with the reason it stayed, for example a branch not fully merged). A branch that stays is not a merge
failure.

### `cleanup`

Removes orphaned `.agent-runs/reviews/` and `.agent-runs/runs/` directories past a retention window
(default 7 days), and sweeps older sibling runs of the same HO once a newer one is removed so
a stale run can never resurface as "latest."

### Orchestration Recipe

The full dispatch loop with lifecycle tools. One slice of a work item is one handoff. Code runs the
gates; the orchestrator decides what is next.

The kb-dispatch MCP server instructions carry only the loop. A client may deliver only the first 2,048
characters of a server's instructions, so everything else lives on the server as the resource
`kb-dispatch://reference` (MIME type `text/markdown`): the tool table, dispatch modes, refusal codes,
parallel-work rules, available models, credentials, and the full orchestration recipe. Read it with the
client's resource-read tool (Claude Code: ReadMcpResourceTool; Codex: `read_mcp_resource`) before the
first `create-handoff`.

```
orchestrator authors HO          → create-handoff (--wk --slice; every implement handoff comes from a slice)
orchestrator dispatches          → dispatch + watch
pipeline executes + delivers     → automatic
pipeline validates the delivery  → host runs the repo's test suite, writes the `Host validation:` line (automatic, every implement delivery)
pipeline auto-commits artifacts  → automatic
orchestrator reads result        → HO-XXXX.response.md (the orchestrator never runs tests)
orchestrator derives review      → derive-review (reuses the delivery's evidence)
orchestrator dispatches review   → dispatch + watch (same cycle)
orchestrator judges each finding → fix | dismiss | defer (reason required for dismiss and defer)
orchestrator sends one fix-up    → create-handoff (--wk --slice, base_ref: dispatch/<reviewed HO>, fixup_context = the findings to fix) + dispatch
orchestrator reviews the fix-up  → derive-review on the fix-up HO (covers only the fix-up) + dispatch
orchestrator merges the chain    → merge-delivery on the last HO, with a judgment for every finding of every review on the chain
```

The review audits the delivered code. Its findings advise the orchestrator; the review outcome does not
block a merge by itself. The merge is refused while a finding has no judgment, while a `fix` judgment has
no implement delivery after the review, while the chain has no finished review, or while the host
validation of the last delivery is not green.
Each fix adds a test that fails before the fix and passes after it. `derive-review` on the fix-up HO then
reviews only the fix-up; skip it only for a trivial fix-up. One budget covers every fix-up on a chain,
review-driven or not: at most two; past that, the orchestrator stops and reports to the operator,
because the slice or the spec is wrong.
Red tests: send a fix-up, or report. An override of red or missing test evidence needs an explicit
operator instruction. The orchestrator does not ask the operator to approve a fix-up.

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
| MCP server | `SERVER_STALE` |

A kb-dispatch MCP server refuses with `SERVER_STALE` after its sources change on disk: it loads its code
once, when the client session connects, and keeps the loaded copy until that session restarts. The fix is
to reconnect the kb-dispatch MCP server or restart the session, then retry. Any change counts — an
uncommitted edit in the shared checkout as well as a merge. A `merge-delivery` that changes dispatch code
makes the merging session's own server stale, so that session reconnects before its next acting call.
`status` and `stop-run` still work while stale, so a stale session can see and stop its runs.

`ACTIVE_RUN_EXISTS` is same-handoff single-flight only: one active run per HO. Different handoffs
dispatch concurrently, each in its own clone of `base_sha`. Only merges to main serialize.

`dispatch` itself is background-only: it returns a `watch` command immediately rather than blocking on
the worker. A refusal above happens synchronously, before that background run is even started. A refusal the
background controller raises before its start gate — a check that passed at dispatch time but failed inside
the controller, e.g. against a newer dispatch-core — is returned by `dispatch` with the same code and
message, recovered from the failed run's `state.json`, instead of a generic launch failure.

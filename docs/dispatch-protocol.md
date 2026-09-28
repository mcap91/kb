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
| `base_sha` / `base_wiki_sha` | string | Authoring-time commit stamps (WK-0152) — see "Base Drift Gate" |
| `reviewed_run` | string | Run id a `code_review` HO targets (WK-0153 discharge evidence) |
| `web` | boolean | Default `false`. Never allowed for `code_review`/`redteam` |
| `credentials` | string[] | Names from `wiki/.dispatch/profiles.json`. Mutually exclusive with `web: true` |
| `data_mounts` / `export_mounts` | string[] | Absolute host paths *outside* the repo root, bound `ro` / `rw` into the jail. Must already exist |
| `read_first` | string[] | Repo-relative paths; each must exist at dispatch time (`MISSING_READ_FIRST`) |
| `vars` | string[] | `"KEY=value"` non-secret literal env for the worker |
| `fixup_context` | string | Prior review findings injected verbatim on a re-dispatch |
| `work_item` | string | `WK-####`; required for `mode: implement`, and its `wiki/issues/<id>.md` must exist |

### Written back by the pipeline after a run

`run_id`, `agent`, `model`, `enforced`, `isolation_backend`, `credentials_granted`, `branch`,
`response` — merged into the HO's own frontmatter in place (existing keys updated, new keys appended);
never author-set inputs.

## Modes and the Envelope

Four mode ceilings (DEC-0007 D4); a handoff may narrow a ceiling, never widen it:

| Mode | `write_scope` | `web` | Delivers a commit? |
|------|---------------|-------|---------------------|
| `implement` | required, non-empty | opt-in | yes — scope-checked commit onto `dispatch/HO-XXXX` |
| `code_review` | must be empty | never | no — response only |
| `redteam` | must be empty | never | no — response only |
| `research` | must be empty | opt-in | no — response only; never emits the recovery block (prose only) |

`code_review`/`redteam`/`research` are advisory: the worker gets no write authority in the jail
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
| Every `read_first` entry exists | `MISSING_READ_FIRST` |
| Repo is clean (`git status --porcelain` over `write_scope`) | `DIRTY_REPO` |
| `base_ref`, if set, starts with `dispatch/` and exists | `BAD_BASE_REF` |
| Every `data_mounts`/`export_mounts` entry is absolute, exists, and is outside the repo root | `BAD_DATA_MOUNT` |
| `implement` declares a `work_item` whose `wiki/issues/<id>.md` exists | `WORK_ITEM_NOT_FOUND` |
| Fresh-HEAD HOs: declared paths haven't changed since `base_sha`/`base_wiki_sha` | `BASE_DRIFT` (see below) |

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
- Every family runs under `--unshare-net` — no network namespace at all inside the jail.

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
| `backends.json` | name → `family` (`pi` \| `codex` \| `claude`), `base_url`, `api_key_env`, `secrets_file`, optional `effort_mapping` |
| `profiles.json` | credential profiles — see "Credentials" |

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

The response doc's own frontmatter also stamps three fields distilled from that evidence (WK-0166), so
downstream consumers (e.g. `merge-delivery`) can read a fact instead of re-parsing the rendered
`## Worker Report` markdown:

- `recovery_outcome` — the block's `reported_outcome` string (e.g. `passed_no_blocking_or_medium_findings`)
  when a valid block was extracted; empty string otherwise.
- `recovery_valid` — boolean; whether a valid `kb-dispatch-recovery.v1` block was extracted at all.
- `worker_report_chars` — the trimmed length of the worker's final assistant message; the fail-closed
  "did a review/run actually happen" fact, independent of whether it carried a parseable block.

A response doc written before this change carries none of these three fields — consumers must refuse
loudly on that absence rather than falling back to parsing the markdown body.

## Base Drift Gate (WK-0152)

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

**Chained-HO exemption.** An HO with `base_ref` set runs on an immutable `dispatch/` branch and is exempt from this gate — the orchestrator is expected to update its WK mid-chain by design.

## Post-Run Lifecycle Tools (WK-0132)

Mechanical lifecycle capabilities that close the manual gaps in the dispatch loop:

### `status` and `stop-run`

`status` reports repo-wide run state: active runs plus the 10 most recent terminal runs, each with
model, delivery status, branch, heartbeat age, and (for active runs) a log tail and turn/file-touched
projection. `stop-run` kills a running dispatch by run id (`SIGTERM` to its process group) and marks its
state `cancelled`; an already-terminal run or an already-dead process is a no-op success, not an error.

### `derive-review`

Creates a `code_review` HO from a delivered `implement` HO. Derivation: `mode=code_review`,
`write_scope=[]` (the mode ceiling — never copied from implement), `base_ref=dispatch/<implement_id>`,
`acceptance`/`validation`/`web`/`credentials`/`data_mounts`/`export_mounts`/`vars`/`work_item` copied
from implement, `read_first` = implement's + response doc path, `title` = `Code review:
<implement_title>`, `reviewed_run` stamped to the implement's latest terminal run id. Does NOT
auto-dispatch — the orchestrator dispatches separately (two-step review chain).

Refusals: implement not found, mode != implement, not delivered (response doc missing).

### `merge-delivery`

Merges `dispatch/<handoff_id>` into the current branch and deletes the delivery branch. Local only — no
remote push.

Preconditions (checked in order, fail-closed):
1. Review evidence: a `code_review` HO whose `base_ref` is `dispatch/<handoff_id>` has a response doc.
   Evidence is read from that doc's frontmatter — `recovery_outcome`, `recovery_valid`,
   `worker_report_chars` (see "Capture and Provenance") — never by re-parsing the rendered
   `## Worker Report` markdown (WK-0166). DEC-0037: review is prose-first — `recovery_valid: true` with a
   passing `recovery_outcome` (`no_findings`/`passed_no_blocking_or_medium_findings`) merges with
   `verdict: structured`; a passing-shaped block reporting anything else (e.g. `changes_requested`)
   refuses, no operator override in this slice; `recovery_valid` false/absent with `worker_report_chars >
   0` still merges, as `verdict: advisory` (the orchestrator/operator reads the prose) — only
   `worker_report_chars === 0`, a missing review HO/doc, or a response doc predating these frontmatter
   fields (all three absent — no legacy regex fallback) refuses outright.
2. Working tree clean
3. Delivery branch exists
4. Merge succeeds (fast-forward or a real merge) — aborts and refuses on conflict

### `cleanup`

Removes orphaned `.agent-runs/reviews/` and `.agent-runs/runs/` directories past a retention window
(default 7 days), and sweeps older sibling runs of the same HO once a newer one is removed (WK-0153) so
a stale run can never resurface as "latest."

### Orchestration Recipe

The full dispatch loop with lifecycle tools:

```
orchestrator authors HO         → create-handoff
orchestrator dispatches         → dispatch + watch
pipeline executes + delivers    → automatic
pipeline auto-commits artifacts → DEC-0038 (automatic)
orchestrator reads result       → HO-XXXX.response.md
orchestrator derives review     → derive-review
orchestrator dispatches review  → dispatch + watch (same cycle)
pipeline auto-commits review    → DEC-0038 (automatic)
orchestrator reads review       → review response.md
orchestrator merges on pass     → merge-delivery
```

## Refusal Codes

Every code the admission/pipeline gate can return as a synchronous refusal (before a worker ever
spawns), grouped by the phase that raises it:

| Phase | Codes |
|-------|-------|
| Handoff shape | `BAD_RECORD` |
| Admission (repo-local) | `MISSING_WRITE_SCOPE`, `ENVELOPE_EXCEEDS_MODE`, `STALE_WRITE_SCOPE`, `MISSING_READ_FIRST`, `DIRTY_REPO`, `BAD_BASE_REF`, `BAD_DATA_MOUNT`, `WORK_ITEM_NOT_FOUND`, `BASE_DRIFT`, `ADMISSION_FAILED` |
| Model/backend resolution | `MODEL_NOT_FOUND`, `EFFORT_UNSUPPORTED` |
| Credentials | `CREDENTIALS_WITH_WEB`, `UNKNOWN_PROFILE`, `CREDENTIAL_NOT_CONFIGURED` |
| Host / prompt budget | `PREFLIGHT_FAILED`, `NO_ISOLATION_ROUTE`, `CONTEXT_BUDGET_EXCEEDED` |
| Worker-specific | `CLAUDE_PERMISSION_PROBE_FAILED` |
| Concurrency | `ACTIVE_RUN_EXISTS` |

`dispatch` itself is background-only: it returns a `watch` command immediately rather than blocking on
the worker. A refusal above happens synchronously, before that background run is even started.

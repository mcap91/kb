# Verifying Dispatch

Verification procedures for the dispatch pipeline against real worker output, as opposed to
inspecting code alone. This covers two mechanisms: the golden-fixture drift check (WK-0161) and
the live full-pipeline smoke-test runbook (WK-0158) — one verification surface, not two.

## Golden-fixture drift check

DEC-0009 established golden fixtures under `tests/fixtures/` — real, unedited captures of
`pi`/`codex`/`claude` worker output — after WK-0091/WK-0093 found the adapters had been parsing
against a hand-invented, never-real event shape since S0. A golden fixture is a point-in-time
capture: nothing re-verifies it still matches what the real CLI emits after a harness/CLI
version bump. This section is that re-verification procedure (WK-0161).

### When to re-capture

Re-capture is tied to the CLI version gate, not a calendar. Today that means: whenever
`packages/dispatch-core/src/model-registry.ts`'s `PI_HARNESS_INFO.testedWith` is bumped to a new
Pi CLI version, re-capture Pi's fixtures before merging the bump.
`tests/dispatch-v2-fixture-drift.test.ts` enforces this mechanically for Pi (see "Mechanical
gate" below).

Codex and Claude have no `testedWith` version gate yet — nothing in `model-registry.ts` pins a
tested CLI version for them (`PI_HARNESS_INFO` is, in its own doc comment, "kb's only
compatibility claim"), so there is no mechanical trigger for their fixtures. Re-capturing them
is an operator judgment call (e.g. after a known Codex/Claude CLI upgrade) until a gate is added
for those families too.

### How

One trivial real dispatch per family (or a direct CLI invocation shaped like the family's
`buildInvocation`, e.g. `packages/dispatch-core/src/adapters/codex.ts`), run from a scratch
consuming repo — never the `kb` checkout itself. Use a placeholder path in any instructions or
scripts you write down, e.g. `/path/to/consuming-repo` (the convention already used in
`docs/upgrade-consuming-repo.md`) — never a hard-coded personal path such as `/home/<user>/...`.

Run the same fixed synthetic scenario for every family and every re-capture, so captures stay
comparable over time. `codex-exec-output.txt` and `claude-p-output.txt` already share the
identical task — "Create a file src/hello.mjs that exports a function hello() which returns the
string 'Hello, World!'. Also create test/hello.test.mjs with a basic test." — proof that one
trivial, deterministic scenario works across families. Re-use that scenario (or another equally
fixed one) rather than inventing a fresh prompt per re-capture.

### What to diff

Diff the fresh capture's **event-TYPE presence/shape census** against the checked-in golden
fixture for that family — which top-level (and, where nested, item/content) event types appear,
and their field shape. Do **not** diff raw event counts: counts vary run-to-run with response
length, tool-call count, and compaction, so a raw-count diff is not reproducible and would flag
false drift on every re-run.

As of this writing, the census observed in the checked-in fixtures is:

| Family | Fixture | Top-level `type` values observed |
|---|---|---|
| pi | `pi-output-code-review.jsonl` | `session`, `agent_start`, `turn_start`, `message_end`, `agent_settled`, `agent_end` |
| codex | `codex-exec-output-stream-json.jsonl` | `thread.started`, `turn.started`, `item.started`, `item.completed` (nested `item.type`: `agent_message`, `command_execution`, `file_change`), `turn.completed` |
| claude | `claude-p-output-stream-json.jsonl` | `system` (subtype `init`), `assistant`, `result`, `rate_limit_event` |

A re-capture's census is diffed against this table (or the current fixture directly, if this
table has gone stale — the fixture is the source of truth; this table is illustrative).

### What counts as drift

**Drift:** a structural shape change — a type that stops appearing, a new type that appears, a
field renamed/removed/retyped on an existing type, or a field's nesting changing (a field moving
from top-level to nested, or vice versa — the exact WK-0093 `text_delta` failure mode this
mechanism exists to catch).

**Not drift:** different event counts, different text content, different token/cost numbers,
different session/thread/turn ids, or anything else that legitimately varies run-to-run under
the same fixed scenario.

### Mechanical gate

`tests/fixtures/capture-manifest.json` records the CLI version each family's golden fixtures
were captured with. `tests/dispatch-v2-fixture-drift.test.ts` fails when the manifest's `pi`
entry's `capturedWith` no longer matches `PI_HARNESS_INFO.testedWith` in `model-registry.ts` — a
mechanical reminder that a `testedWith` bump needs a matching re-capture (and a manifest update)
before it merges. This is Pi-only today: Codex and Claude have no version gate to check against
(see "When to re-capture" above), so the test does not gate them; bumping their `capturedWith`
after a re-capture is documentation, not an enforced gate, until a version gate exists for those
families.

### Secret-safe intake

Captures are synthetic: use a throwaway prompt/task with no real credentials, no real user data,
and no proprietary content. Before committing a fresh capture as a fixture, scan the raw output
for anything that looks like a secret (API keys, tokens, `Bearer` headers, personal absolute
paths) and redact or regenerate the capture if it does. Golden fixtures are real, unedited
captures (DEC-0009) — "unedited" applies to structure and content, not to a leaked secret; if a
capture is unusable without editing it, re-capture with a cleaner scenario instead of scrubbing
it in place.

### Failure-path event shapes: out of scope here

A normal-capture drift check only exercises the success path. Failure-path shapes — e.g.
`stopReason === 'error'`, `auto_retry_end.success === false` — are explicitly out of scope for
this mechanism; a trivial synthetic scenario cannot exercise them by design. The existing
hand-derived error fixtures (`*-model-not-found.*`, `*-permission-denied.*`) cover today's known
failure shapes but are not kept current by this procedure. If a failure-path shape is suspected
to have drifted, file a WK to capture and diff it separately.

### Compatibility policy

DEC-0009 rule 5 says drift is never patched to accept both shapes silently. For this mechanism,
that rule is refined rather than relaxed: **confirmed drift requires an explicit, dated ruling**
(a decision or WK note) that either:

- **re-captures the fixture and updates the parser to the new shape** (the default), or
- **grants a bounded, time-boxed transition window** in which the parser explicitly supports
  both the old and new shape, with the window's end date and a removal task recorded at the time
  of the ruling.

Silent, undated dual-shape support is never acceptable under either branch.

## Live full-pipeline smoke test (WK-0158)

WK-0157's test-suite audit found the pipeline's only full-chain proof was ad hoc, one-off manual
dispatches — never a repeatable fixture. This section is that fixture: five live dispatch
scenarios, each run against a scratch consuming repo (never the `kb` checkout itself) and
verified against a fixed per-stage assertion checklist. Where the golden-fixture drift check
above diffs one family's captured event shape against a checked-in fixture, this runbook
exercises the full request path live — admission, jail, tunnel, adapter, worker execution,
delivery, auto-commit, response doc — on demand, driven interactively through the `kb-dispatch`
MCP tools (`create-handoff`, `dispatch`, `derive-review`, `merge-delivery`). It is not `npm test`
and is out of scope for CI automation (a separate cost/runner decision). Every fixture is a real
dispatch against a real backend and incurs whatever that backend charges — cheap for a trivial
one-line task (all five fixtures together, run once, cost well under $1) — but there is no
dry-run mode.

### Scratch consuming repo setup

Dispatch must never target the `kb` checkout itself — always a disposable consuming repo.

1. `mkdir /path/to/consuming-repo && cd /path/to/consuming-repo && git init`.
2. The repo needs a `CLAUDE.md` (content can be empty) and the `kb-wiki`/`kb-dispatch` MCP
   servers registered against it (`.mcp.json`, pointed at the `kb` checkout — see
   `docs/upgrade-consuming-repo.md`'s "MCP Client Setup"). The `bootstrap` tool (`kb-wiki` MCP, or
   `npm run wiki -- bootstrap --dir /path/to/consuming-repo --repo <org>/<name>` — any placeholder
   identifier works for a scratch repo) does both in one step: it scaffolds the wiki directory
   tree (including `wiki/issues/` and `wiki/handoffs/`), writes the `CLAUDE.md` managed block, and
   merges the `.mcp.json` entries. Commit the result — `create-handoff` needs at least one commit
   to stamp `base_sha` from.
3. Scaffold dispatch config: `init-dispatch` (`kb-dispatch` MCP; MCP-only, no CLI subcommand)
   writes blank `wiki/.dispatch/models.json`, `backends.json`, `profiles.json`, and a `README.md`
   with worked examples — every file written only if absent. Edit `models.json` to add your model
   alias (`available_on`, provider `model_id`) and `backends.json` to add your backend name
   (`family`: `pi` | `codex` | `claude`, `base_url`, `api_key_env`, `secrets_file`) — see the
   generated `wiki/.dispatch/README.md` and `docs/dispatch-protocol.md`'s "Model and Backend
   Configuration" for field meaning. Point `api_key_env`/`secrets_file` at a credentials file
   holding your API key, or leave both `null` to ride the CLI's own logged-in session.
4. Create a work-item stub: implement-mode admission requires `work_item` to name an existing
   `wiki/issues/WK-NNNN.md` **inside the target repo**, not inside `kb`. A minimal stub (a title
   and one `## Objective` line noting it exists only to satisfy admission) is enough; reuse the
   same stub across every implement fixture below.

### Golden smoke fixture (implement)

The minimal repeatable case: one file, one line, all nine pipeline stages.

1. `create-handoff` (`kb-dispatch` MCP): required `title`/`subject` strings, `mode: "implement"`,
   `write_scope: ["tests/golden/smoke.txt"]`, `objective` describing the task (e.g. "Write exactly
   `GOLDEN_DISPATCH_OK` to `tests/golden/smoke.txt`. Nothing else."), non-empty
   `acceptance`/`validation` arrays, and `work_item` set to the stub from setup. `allowed_agents`
   is also required by the tool's own schema but is a dead v1 field the v2 pipeline never reads
   (adapter selection is `backend.family` alone) — any value satisfies it.
   - The target path does not need to exist yet, nor does its parent directory (`tests/golden/`,
     or even `tests/`) — admission validates the write_scope entry's ancestor chain rather than
     requiring an existing parent, and the pipeline creates whatever directories are missing,
     clone-side, before the worker runs (WK-0163). A brand-new scratch repo with no `tests/`
     directory at all is fine as-is.
2. `dispatch` (`kb-dispatch` MCP): `handoff` = the HO's path, `model`/`backend` = your model
   alias/backend name. It returns a `watch` command — run that in the background to be notified
   when the run reaches a terminal status.
3. Once terminal, verify each stage below. `RD` denotes the run directory,
   `.agent-runs/runs/HO-XXXX/RUN-<uuid>/`, relative to the consuming repo root.

| # | Stage | What to check |
|---|---|---|
| 1 | create-handoff | `wiki/handoffs/HO-XXXX.md` exists; frontmatter has `base_sha` |
| 2 | admission | `RD/state.json` exists; `.error` is `null` |
| 3 | jail (bwrap) | `RD/worker-output.log` exists; response frontmatter `isolation_backend: bwrap` |
| 4 | tunnel/relay | `RD/relay.js`, `RD/forwarder.js`, `RD/forwarder.log`, `RD/tunnel-destinations.log` all exist |
| 5 | adapter | `RD/prompt.txt` exists; response frontmatter has `model`, `backend`, `backend_fingerprint` |
| 6 | worker execution | `RD/worker-output.log` non-empty; response frontmatter has `total_tokens`/`cost_usd` |
| 7 | delivery | `git rev-parse --verify refs/heads/dispatch/HO-XXXX` resolves; its tip commit's author/committer is `kb-dispatch <dispatch@kb.local>`, message `dispatch: HO-XXXX`; `RD/state.json` has `delivery_status: "delivered"` |
| 8 | auto-commit | A commit on the branch you dispatched from, by `kb-dispatch <dispatch@kb.local>`, message `chore: dispatch HO-XXXX <outcome> (<backend>/<model>)`, touching `HO-XXXX.md` + `HO-XXXX.response.md` |
| 9 | response doc | `wiki/handoffs/HO-XXXX.response.md` frontmatter has `handoff_id`, `outcome`, `branch`, `wiki_commit`; the HO's own frontmatter gains `run_id`, `response`, `agent`, `branch` |

`RD/provenance.json` may also appear (best-effort, provider-dependent) — its absence is not a
failure. Do not assert anything against the ephemeral worker clone; it is torn down
unconditionally once the run ends. Stages 3-6 evidence lives entirely in `RD` and the response
frontmatter; stages 1, 7-9 live in the consuming repo itself.

### Review chain fixture (code_review)

Chains off the golden fixture rather than standing alone — this is the only way to live-prove
`derive-review` and `merge-delivery` together, and it closes the create-review-merge loop in one
pass.

1. `derive-review` (`kb-dispatch` MCP; MCP-only, no CLI subcommand): `handoff_id` = the golden
   fixture's HO id. Creates a new HO with `mode: "code_review"`, `write_scope: []`, `base_ref:
   dispatch/HO-XXXX` (the golden HO), `reviewed_run` stamped to the golden run's id. It does not
   dispatch the new HO.
2. `dispatch` the derived HO the same way as the golden fixture.
3. Assert the **advisory shape**: no `dispatch/HO-XXXX` branch is created for the review HO
   itself, and `RD/state.json` has `delivery_status: "no_changes"`. Stages 1-6, 8-9 from the
   golden checklist still apply; there is no stage-7 delivery commit for an advisory run.
4. `merge-delivery` (`kb-dispatch` MCP; MCP-only, no CLI subcommand): `handoff_id` = the golden
   fixture's HO id. Merges `dispatch/HO-XXXX` into the branch you're on and deletes it — gated on
   the review HO's response doc (a passing or unparsable-but-prose-bearing review merges; a
   `changes_requested` verdict refuses outright — re-run the chain to get merge evidence in that
   case).
5. Assert: a new merge commit exists on your branch, and `git rev-parse --verify
   refs/heads/dispatch/HO-XXXX` (the golden HO's branch) now fails — the branch is gone.

### Pi-family fixture

Same recipe as the golden smoke fixture, targeting a distinct file (e.g.
`tests/golden/smoke-pi.txt`) and dispatched with your model alias/backend name for a
`backends.json` entry whose `family` is `"pi"` — any Pi-compatible backend works (a hosted
aggregator, a local server, or a direct provider).

Precondition: the installed Pi CLI's version must satisfy the configured floor; `dispatch`
preflights this (`pi --version`) and refuses with `PREFLIGHT_FAILED` below it. Note: if the Pi CLI
isn't installed at all, the probe currently returns nothing and the gate is silently skipped
rather than refusing (WK-0165, filed, not yet fixed) — worth confirming Pi is actually present by
hand before trusting a pass.

Pi-specific additions to the standard checklist:

- Response frontmatter also carries `pi_version` (the probed CLI version), alongside the standard
  `model`/`backend`/`backend_fingerprint` fields.
- For a backend with no version-probe endpoint, `backend_fingerprint`'s trailing segment reads
  `unknown` instead of a concrete version string — expected, not a failure.

### Redteam fixture

Proves the advisory plan/spec-review path. `code_review` cannot do this — its framing is
hard-wired to a delivered diff — so plan or spec review is redteam's job.

1. Commit a small doc with at least one attackable factual or design claim (or reuse one already
   committed in the consuming repo).
2. `create-handoff` (plus the baseline required fields from the golden fixture): `mode:
   "redteam"`, `write_scope: []`, `web: false`, `read_first: [<that doc's repo-relative path>]`,
   acceptance criteria framed as questions the attack must answer.
3. `dispatch` the same way as the golden fixture.
4. Assert the advisory shape (no branch, `RD/state.json` has `delivery_status: "no_changes"`) plus
   stages 1-6, 8-9 from the golden checklist.
5. Assert response content is present either way: a structured `kb-dispatch-recovery.v1` block
   (response frontmatter `delivery_method: structured`) or, when the worker's block doesn't parse,
   real review prose in the response body (`delivery_method: prose_fallback`) — DEC-0037 makes
   both outcomes valid; only a genuinely empty response counts as a failure.

### Mount traversal proof (scenario 2)

Proves a worker can read or write a durable artifact on a mounted volume outside the repo,
through a committed repo symlink — the mechanism a job that reads or writes large or persistent
data outside the repo would rely on.

1. Create a plain directory outside the consuming repo, e.g. `/path/to/mount-target/`.
2. Commit an **absolute** symlink inside the repo pointing at it, e.g. `data ->
   /path/to/mount-target`. A relative symlink breaks after cloning — the clone lands under a
   different parent directory.
3. `create-handoff` (plus the baseline required fields from the golden fixture): `mode:
   "implement"`, `export_mounts: ["/path/to/mount-target"]`, task: write a marker (e.g.
   `MOUNT_TRAVERSAL_OK`) to `data/artifacts/proof.txt` through the symlink. Also declare a normal,
   non-empty `write_scope` entry (e.g. a small marker file under a repo-tracked path) — admission
   still refuses an empty `write_scope` for implement mode even when `export_mounts` is non-empty
   (`MISSING_WRITE_SCOPE`; WK-0164 Gap 1, deferred until a real mount-only job materializes). The
   symlink path itself needs no `write_scope` entry — mounts are the permission; `write_scope`
   only bounds the delivery diff.
4. `dispatch` and let it reach a terminal status.

Grant `export_mounts` as the narrowest per-job directory you can (e.g.
`/path/to/mount-target/<job-id>/`, never a broad shared mount root) — it bounds blast radius and
keeps the pipeline's post-run mount-write accounting cheap.

**Currently blocked (WK-0164).** As of this writing, step 4 delivers successfully, but the
traversal itself is not proven: the assembled worker prompt never communicates that
`export_mounts`/`data_mounts` paths are authorized at all, so a worker that notices the absolute
path lies outside `write_scope` self-gates and refuses to write there — correct behavior given
what it was told, but it means the jail's bind-mount mechanism is never actually exercised. Watch
for this exact failure shape: `delivered`, with the marker file landed in the repo, but nothing
appears at the real mount path, and the recovery block (if present) reports `kind:
"scope_insufficient"`. Once WK-0164 ships (the prompt fix and its companion mount-write manifest),
re-run this fixture and assert: the marker file exists at the real mount location (not in the repo
tree), and the response doc gains a `## Mount Writes` section listing it — a deterministic
post-run walk the pipeline performs, never the worker's own self-report.

### Teardown + reset state

After every fixture above: `pgrep -af 'relay\.js|forwarder\.js|bwrap'` must return nothing. If
other bwrap users are active on the same host, scope the check to your run by matching its `RD`
path in the process argv rather than treating any hit as a failure.

Before re-running the same fixture: dispatch is idempotent at the tree level, so re-dispatching an
unchanged task against an already-merged target produces an identical diff and lands as
`no_changes`, not `delivered` — expected, not a bug. To get a clean `delivered` result again,
either delete the golden target file(s) and commit that deletion first, or start over from a
fresh scratch repo.

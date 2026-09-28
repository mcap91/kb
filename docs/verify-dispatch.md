# Verifying Dispatch

Verification procedures for the dispatch pipeline against real worker output, as opposed to
inspecting code alone. Today this covers the golden-fixture drift check (WK-0161). WK-0158's
live full-pipeline smoke-test runbook is planned to land in this same doc once unblocked — one
verification surface, not two.

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

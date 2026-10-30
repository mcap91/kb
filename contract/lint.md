# Lint Rules Reference

This document describes the lint rules enforced by `wiki lint`.

## Overview

`wiki lint` scans all manifest-driven wiki records and validates their frontmatter against the contract schema. It reports errors and warnings but does not modify files.

## Scope

### Included

- All files in manifest-driven record directories:
  - `wiki/issues/` (WK-*)
  - `wiki/initiatives/` (IN-*)
  - `wiki/decisions/` (DEC-*)
  - `wiki/sources/` (SRC-*)
  - `wiki/areas/` (AREA)

### Excluded

- Generated views (`wiki/catalog.md`, `wiki/now.md`, etc.)
- `wiki/handoffs/` (dispatch-owned, validated by `dispatch-core`)
- Reserved filenames (`README.md` in each directory)
- Non-markdown files

## Lint Rules

### MISSING_FIELD (error)

A required frontmatter field is missing.

Required fields are defined per record type in `contract/manifest.json` under `requiredFrontMatter`.

### INVALID_ENUM (error)

A frontmatter field has a value not in its allowed enum set.

Enum constraints are defined per record type in `contract/manifest.json` under `enumFrontMatter`.

### INVALID_FIELD (error)

A frontmatter field has an invalid type (e.g. a string where an array is expected).

Array fields are defined in `arrayFrontMatter`. Object fields are defined in `objectFrontMatter`.

### DUPLICATE_ID (error)

Two or more records share the same `id` value within the same record type.

### BROKEN_REFERENCE (warning)

A frontmatter field references another record ID that does not exist. Checked fields include:

- `depends_on`
- `blocks`
- `related`
- `initiative`
- `area`
- `supersedes`
- `superseded_by`
- `duplicate_of`
- `deprecated_by`

### INVALID_PREFIX (error)

A record file is in a directory that does not match its `id` prefix. For example, a file in `wiki/issues/` with an `id` of `IN-0001`.

### UNCHECKED_CHECKLIST (warning)

A record with a terminal status (`done`, `cancelled`, `completed`, etc.) contains unchecked checklist items (`- [ ]`) in its body.

## Cross-Record Rules (WK-0114)

The rules below run once, after every per-record rule above (and after `DUPLICATE_ID` /
`DEPENDENCY_CYCLE`), over the full repo-wide record set. They reason about relationships
between records — a WK and its parent initiative, or a WK against the rest of the corpus —
rather than about a single record in isolation. All three are warnings: they flag, they never
mutate a record.

### OPEN_CHILD_UNDER_TERMINAL_PARENT (warning)

A WK record's `initiative` points at an initiative whose status is `done` or `cancelled` (a
terminal parent), but the WK's own status is not `done`, `cancelled`, or `parked`. Flagged on
the **child** WK's file, naming the parent initiative. `parked` is deliberately excluded from
the actionable set — a parked child under a terminal parent is expected, not drift.

### INITIATIVE_READY_TO_CLOSE (warning)

An initiative has at least one WK child, is not itself in a closed status (`done`, `cancelled`,
`deprecated`, `duplicate`, `superseded`, `wont_do`), and every one of its WK children is in a
closed status. Flagged on the **initiative's** file. Advisory only — the initiative is never
auto-closed by lint.

### STALE_ACTIVE_ISSUE (warning)

A WK record in an active status (`in_progress`, `blocked`, or `review`) whose `updated` date is
14 or more days older than the corpus-relative clock (see below). A WK in `todo` does not
trigger this rule — `todo` is not considered part of the active set.

**Determinism / corpus-relative clock.** `wiki lint` never reads the wall clock — there is no
`Date.now()` and no bare `new Date()` anywhere in the lint pass. Staleness is measured against
`corpusLatestDate`: the maximum parseable `updated` date across *all* records in the repo, not
today's real date. This keeps `lint()` a pure function of the file tree: the same tree always
produces byte-identical diagnostics, regardless of when or on what machine it runs. Accepted
limitation: "stale" is relative to whichever record was most recently touched, not to real
elapsed time — if nothing in the repo has been touched in months, a WK updated yesterday can
still register as far from "stale" by this clock even though it is stale by the calendar.

## Acceptance-Criteria Rules (WK-0197, revised HO-0107, rebuilt HO-0109)

Both rules below are scoped to WK records whose `status` is `todo`, `in_progress`,
`review`, or `blocked`. `inbox`, `parked`, every closed status, and non-WK records are
exempt. (HO-0105 originally also exempted `blocked`; that was a transcription error
against WK-0197's acceptance criterion, "closed/parked/inbox records exempt" — `blocked`
is not on that exempt list, so it is in scope. Corrected under HO-0107.)

**Heading match.** Both rules recognize a `## Acceptance criteria` heading even when it
carries trailing text, as long as the trailing text is separated by whitespace (e.g.
`## Acceptance criteria (4 tiers, operator-ratified 2026-09-29)`, as used by WK-0183) —
any heading matching `^##\s+Acceptance criteria(?:\s+\S.*)?$` counts as the section
start. A heading with no separating whitespace before the suffix — `## Acceptance
criteria-ish` — is a *different* heading and is never treated as the section start, so
it cannot shadow a later, real `## Acceptance criteria` section (HO-0109 F4, tightened
from HO-0107's `\b`-based match, which wrongly accepted `-ish`). This tolerance is local
to these two rules only; `AC_COMPLETE_STATUS_OPEN` and `UNCHECKED_CHECKLIST` still
require an exact `## Acceptance criteria` heading with no trailing text.

**List items are criteria.** Every top-level Markdown list item in the section is a
criterion — a checkbox (`- [ ] ...` / `- [x] ...`), a plain bullet (`-`, `*`, or `+`),
or an ordered item (`1.`, `2.`, ...). There is no requirement that a criterion use
checkbox syntax (HO-0109, correcting HO-0107's overreach: HO-0107 had made a
checkbox-free section an `AC_MISSING` error, which exceeds WK-0197's presence rule).

**Criterion grouping (lazy continuation).** Each criterion is a list item together with
any continuation lines that immediately follow it, up to the next blank line or the next
list item — per CommonMark lazy continuation, a continuation line does **not** need to
be indented; indented and unindented continuation lines are grouped identically
(HO-0109, correcting HO-0108 F1's finding that an unindented continuation was missed).
Their trimmed text is appended to the list item's own text before the verifiability
heuristic runs. A blank line, or the start of a new list item, closes the previous item.

### AC_MISSING (error)

Two distinct cases, two distinct messages:

1. **Section absent** — no `## Acceptance criteria` heading anywhere in the body.
2. **Placeholder only** — every list item in the section is the unfilled template
   placeholder `_criterion_` (see `contract/templates/issue.md`), with no real
   criterion.

A section that is present and holds at least one real (non-placeholder) list item is
never `AC_MISSING`, regardless of whether that item uses checkbox syntax. A section that
is present but holds **no list items at all** (empty, or prose with no bullets) is also
not `AC_MISSING` — see `AC_UNVERIFIABLE`'s third case below. This is a presence check
only: did anyone write acceptance criteria at all. Extended 2026-10-30 (operator ruling,
WK-0197) from the rule's original warning-only design to an error for this presence
check specifically; the verifiability shape check below (`AC_UNVERIFIABLE`) stays a
warning.

### AC_UNVERIFIABLE (warning)

Three cases:

1. One diagnostic per criterion (grouped per above), on an in-scope WK, whose combined
   text names no verifiable check.
2. One diagnostic per `_criterion_` placeholder item that sits beside real criteria (a
   placeholder-only section is `AC_MISSING` instead, not this rule).
3. Exactly one diagnostic, with a message stating the section has no list items, when
   the section is present but holds zero list items (empty, or prose with no `-`/`*`/
   `+`/ordered bullets).

Does not run at all when `AC_MISSING` already fired for the record (a missing or
placeholder-only section has nothing to shape-check).

**Detection heuristic.** A criterion's combined text counts as naming a verifiable check
if it contains at least one of:

- a CLI invocation: `npm`, `npx`, `tsx`, `node`, `git`, `curl`, `wiki`, or `graph`
  followed by an argument
- an action verb — `run`, `execute`, `verify`, or `check`, any inflection — followed by
  a target. This is a structural shape, not an enumerated tool vocabulary, so it covers
  both imperative checks ("Verify README.md") and third-person uses ("One command runs
  all scenarios")
- a number with a unit or comparison (`ms`, `s`, `sec`, `min`, `%`, `x`, `MB`, `GB`,
  `KB`, or a `<`/`>`/`<=`/`>=`/`==` comparison against a number)
- a copula (`is`/`are`/`equals`/`returns`) immediately followed by inline code — an
  equality assertion against a literal value, not backticks by themselves
- a command-like token immediately followed by an outcome word — `passes`, `succeeds`,
  `fails`, `exits [with code] 0` (and inflections such as `passed`/`succeeded`/`failed`)
  — unless the word immediately before the outcome word is an English modal auxiliary
  (`must`/`should`/`will`/`shall`/`would`/`can`/`could`/`might`/`may`): "the vibe must
  pass" names no command, "npm test passes" does. The outcome-word match is a structural
  shape (any non-modal preceding word plus an outcome word), not an enumerated tool
  vocabulary, so it covers named tests and commands beyond the fixed CLI list above
  (e.g. "the named smoke test passes", "vitest run succeeds")
- `returns`/`appears`/`appear`, unless immediately followed by a temporal adverb
  (`next`/`tomorrow`/`yesterday`/`later`/`soon`/`eventually`): "resolver returns a row"
  is a function result, "discussion returns next week" is a calendar event, not a check
- an explicit observable-behavior/state verb or property word — `throws`, `logs`,
  `prints`, `outputs`, `produces`, `renders`, `emits`, `exit code`, `exits`, `responds
  with`, `ends with`, `displays`, `rejected`/`rejects`, `fires`, `flags`/`flagged`,
  `exists`/`exist`, `contains`/`contain`, `carries`/`carry`, `unchanged`/`changed`/
  `identical`, `correct`/`incorrect`, `valid`/`invalid`, `idempotent`, `handled`/
  `unhandled`, `lost`, `is generated`, `navigates`/`navigate`, `refused`/`refuses`,
  `registers`/`registered`, `reports`/`reported`, `falls back`/`fallback`, `opens`,
  `loaded`, `exempt(ed)`, `round-trip(s)`, `observe(s/d/ing)`, `cites`/`cited`/`citing`/
  `citation(s)`, `implements`/`implementation`, `creates`/`created`, `removes`/
  `removed`, `archives`/`archived`, `launches`/`launched`, `completes`/`completed`,
  `publishes`/`published`, `yields`/`yield`, `updated`, `writes`/`written`,
  `accepts`/`accept`, `introduces`/`introduced`, `parked`/`unparked`,
  `references`/`referenced`, `untouched`, `lints`, `refreshes`/`refreshed`,
  `enforces`/`enforced`, `resolves`/`resolved`, `survives`/`survive`, `follows`,
  `documents`/`documented`, `prepends`/`prepended`, `installs`/`installed`,
  `injects`/`inject`, `stores`/`stored`, or a bare `test`/`tests` reference
- an arrow (`→`) between two tokens: a before → after transition or mapping is
  inherently a testable assertion, regardless of which words surround it

This is a deterministic regex presence check, not a semantic check — it looks for the
*shape* of a verifiable claim, not whether the claim is true or meaningfully checkable.
Inline code (backticks) alone is **not** a signal, and (HO-0109) neither is a bare
repo-relative path by itself: bare backticked text (e.g. `` `banana` improves vibes ``)
does not pass on backticks by themselves, and a path mention with no accompanying verb
("Discuss `packages/wiki-core/src/lint.ts` with the team") does not pass on the path
alone — both pass only when the surrounding text also matches one of the shapes above (a
copula, a command, a verb, an outcome word, etc.), i.e. inside a check-like assertion.
No obligation generation, no proof compilation, no coverage states (WK-0106 is the
full-mechanism revisit, out of scope here).

**Design note (HO-0109).** The verb/property list above is larger than HO-0107's. It
grew to meet WK-0197 Resolutions row 1's pass bar (at most 3 of 20 randomly sampled
corpus warnings false) against real WK acceptance-criteria prose, which routinely
describes technical behavior without using any small fixed set of check-verbs. Every
entry is a generic grammatical predicate or software-engineering property word (not a
kb-specific noun or concept), but the list's growth is in tension with WK-0197 Out's
"no controlled vocabulary" boundary, and the next redteam should weigh that trade-off
explicitly rather than only re-checking the false-warning count.

## Output Format

Lint results are reported as a list of diagnostics:

```
<severity> <file>: [<field>] <code> — <message>
```

Example:

```
error wiki/issues/WK-0001.md: [status] INVALID_ENUM — "unknown" is not a valid status value
warning wiki/issues/WK-0002.md: [depends_on] BROKEN_REFERENCE — WK-9999 does not exist
```

## Exit Codes

- `0` — no errors (warnings are allowed)
- `1` — one or more errors found

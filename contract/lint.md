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

## Acceptance-Criteria Rules (WK-0197, revised HO-0107)

Both rules below are scoped to WK records whose `status` is `todo`, `in_progress`,
`review`, or `blocked`. `inbox`, `parked`, every closed status, and non-WK records are
exempt. (HO-0105 originally also exempted `blocked`; that was a transcription error
against WK-0197's acceptance criterion, "closed/parked/inbox records exempt" — `blocked`
is not on that exempt list, so it is in scope. Corrected under HO-0107.)

**Heading match.** Both rules recognize a `## Acceptance criteria` heading even when it
carries trailing text (e.g. `## Acceptance criteria (4 tiers, operator-ratified
2026-09-29)`, as used by WK-0183) — any heading starting with `## Acceptance criteria`
counts as the section start. This tolerance is local to these two rules only;
`AC_COMPLETE_STATUS_OPEN` and `UNCHECKED_CHECKLIST` still require an exact
`## Acceptance criteria` heading with no trailing text.

**Criterion grouping.** Each criterion is a checkbox line (`- [ ] ...` / `- [x] ...`)
together with any indented continuation lines that immediately follow it (no intervening
blank line or new bullet) — their trimmed text is appended to the checkbox's own text
before the verifiability heuristic runs. A plain (non-checkbox) bullet or bare prose line
is not a criterion and does not extend one.

### AC_MISSING (error)

Three distinct cases, three distinct messages:

1. **Section absent** — no `## Acceptance criteria` heading anywhere in the body.
2. **No checkbox criteria** — the section is present but contains zero checkbox-style
   criteria (only plain bullets and/or prose, or nothing at all). The message does not
   claim a placeholder is present, since one may not be.
3. **Placeholder only** — the section's only checkbox criterion/criteria is/are the
   unfilled template placeholder `_criterion_` (see `contract/templates/issue.md`), with
   no real criterion.

This is a presence check only: did anyone write acceptance criteria at all. Extended
2026-10-30 (operator ruling, WK-0197) from the rule's original warning-only design to an
error for this presence check specifically; the verifiability shape check below
(`AC_UNVERIFIABLE`) stays a warning.

### AC_UNVERIFIABLE (warning)

One diagnostic per criterion (grouped per above), on an in-scope WK, whose combined text
names no verifiable check — plus one per `_criterion_` placeholder bullet that sits
beside real criteria (a placeholder-only section is `AC_MISSING` instead, not this rule).
Does not run at all when `AC_MISSING` already fired for the record.

**Detection heuristic.** A criterion's combined text counts as naming a verifiable check
if it contains at least one of:

- a repo-relative path: a slash-separated segment ending in a dotted extension (e.g.
  `packages/wiki-core/src/lint.ts`, `out/report.json`)
- an npm/CLI invocation: `npm`, `npx`, `tsx`, `node`, `git`, or `curl` followed by an
  argument
- a number with a unit or comparison (`ms`, `s`, `sec`, `min`, `%`, `x`, `MB`, `GB`,
  `KB`, or a `<`/`>`/`<=`/`>=`/`==` comparison against a number)
- an explicit observable-behavior/predicate verb (`returns`, `throws`, `logs`, `prints`,
  `outputs`, `produces`, `renders`, `emits`, `exit code`, `exits`, `responds with`,
  `displays`, `rejected`/`rejects`, `fires`/`fire`, `flags`)
- a command-like token immediately followed by an outcome word — `passes`, `succeeds`,
  `fails`, `exits [with code] 0` (and inflections such as `passed`/`succeeded`/`failed`).
  This is a structural shape (any preceding word plus an outcome word), not an
  enumerated tool vocabulary, so it covers named tests and commands beyond the fixed CLI
  list above (e.g. "the named smoke test passes", "vitest run succeeds")
- a filename or path — with or without a slash, a dotted extension, or a trailing `/` —
  near an existence/content predicate (`exists`/`exist`, `contains`/`contain`,
  `unchanged`, `is generated`), e.g. "README.md exists", "docs/ directory exists"

This is a deterministic regex presence check, not a controlled vocabulary or semantic
check — it looks for the *shape* of a verifiable claim, not whether the claim is true or
meaningfully checkable. Inline code (backticks) alone is **not** a signal: bare
backticked text (e.g. `` `banana` improves vibes ``) does not pass on backticks by
themselves — it passes only when the surrounding text also matches one of the shapes
above (a path, a command, a verb, an outcome word, etc.), i.e. inside a check-like
assertion. No obligation generation, no proof compilation, no coverage states (WK-0106
is the full-mechanism revisit, out of scope here).

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

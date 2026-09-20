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

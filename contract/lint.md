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

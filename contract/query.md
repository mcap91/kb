# Shared Wiki Query Model

This document defines the shared retrieval model for `kb`.

## Retrieval Principle

Default to knowledge-first retrieval, not broad filesystem search first.

## Shared Query Order

1. Start from `wiki/catalog.md`.
2. Follow into relevant durable `docs/` reference pages.
3. Check decision pages for durable architectural conclusions.
4. Check area pages for durable repo boundaries and entrypoints.
5. Drill into issue and initiative pages for execution state.
6. Check source pages when provenance or evidence matters.
7. Only then drill into implementation files under `packages/` and `tests/`.

## Bootstrap Query Path

Before generated views exist or when they may be stale:

1. inspect relevant durable `docs/` reference pages
2. inspect `wiki/decisions/`
3. inspect `wiki/areas/`
4. inspect `wiki/issues/` and `wiki/initiatives/`
5. inspect `wiki/sources/`
6. inspect implementation files

## Generated View Trust Rule

Generated views are useful retrieval aids, but they are not canonical state.

If generated views are missing or may be stale, prefer canonical pages directly over derived views.

## Current Status Rule

- Current feature status lives in canonical wiki records such as `WK-*`, `IN-*`, and `DEC-*`.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` are planning/supporting context, not the first source of current feature status.

## Search Command

```bash
npm run wiki -- search --dir <repo> --query <text> [--prefix <PREFIX>] [--status <status>] [--limit <n>]
```

## Queryable Fields

### Text Search

Full-text lexical search across:

- Record title
- Record body content
- Frontmatter string values

### Prefix Filter

Filter by record type prefix:

- `WK` — work items
- `IN` — initiatives
- `DEC` — decisions
- `SRC` — sources
- `AREA` — area records

### Status Filter

Filter by status value. Valid values depend on the record type:

**WK-* statuses:** `inbox`, `todo`, `in_progress`, `blocked`, `review`, `done`, `parked`, `cancelled`, `deprecated`, `duplicate`, `superseded`, `wont_do`

**IN-* statuses:** `todo`, `in_progress`, `blocked`, `review`, `done`, `parked`, `cancelled`, `deprecated`

**DEC-* statuses:** `proposed`, `accepted`, `rejected`, `superseded`, `deprecated`

## Search Scope

### Included in Search Index

- Manifest-driven wiki records (`WK`, `IN`, `DEC`, `SRC`, `AREA`)
- `docs/**/*.md`
- Root `README.md`, `AGENTS.md`, `CLAUDE.md` (when present)

### Excluded from Search Index

- Generated wiki views (`catalog.md`, `now.md`, `inbox.md`, `backlog.md`, `archive.md`)
- `wiki/handoffs/` (dispatch-owned)
- `.agent-runs/`
- `scratch_space/`
- `node_modules/`
- `dist/`

## Search Index

The search index is built by:

```bash
npm run wiki -- build-search-index --dir <repo>
```

The index is stored at `wiki/.search-index.json` and is not git-tracked.

## Result Format

Search results include:

- `id` — record identifier
- `path` — file path relative to repo root
- `title` — record title
- `score` — relevance score
- `prefix` — record type prefix (if applicable)
- `snippet` — matching text excerpt

Results are sorted by relevance score (descending).

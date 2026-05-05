# Query and Filter Reference

This document describes how to query and filter wiki records managed by `kb`.

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

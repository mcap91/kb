# Retrieval Reference

This document describes how retrieval and search work in `kb`.

## Overview

`kb` provides lexical search over canonical wiki content. The search system indexes manifest-driven wiki records and selected documentation files, then supports text queries with optional prefix and status filters.

Repository-context retrieval is a wiki/docs retrieval problem first, not a broad filesystem search problem first.

## Retrieval Entrypoint

The primary retrieval entrypoint is the kb wiki MCP `search` tool. For a structured overview, use the MCP `generate` tool and read the generated views (`catalog`, `now`, `inbox`, `backlog`, `archive`). If the MCP server is unavailable, use the kb CLI (`npm run wiki -- search --dir .`, `npm run wiki -- generate --dir .`).

## Retrieval Order

1. Search the wiki with the kb wiki MCP `search` tool. This is the first retrieval step.
2. If you need a structured overview, regenerate views with the MCP `generate` tool and read them (`catalog`, `now`, `inbox`, `backlog`, `archive`).
3. Then read the relevant durable `docs/` reference pages.
4. Then check related `wiki/decisions/`, `wiki/issues/`, `wiki/initiatives/`, `wiki/areas/`, and `wiki/sources/` pages.
5. Only then drill into implementation files under `packages/` and `tests/`.

If the kb wiki MCP server is not available this session, run the same steps via the kb CLI. Do not use raw `rg`, file globbing, or direct file reads as the first retrieval step. If generated views are missing or stale, prefer canonical pages directly over derived views.

## Canonical Content

Canonical content is content that is directly authored and maintained. It is the authoritative source for information in the wiki.

### Canonical Sources

- **Wiki records:** `WK-*`, `IN-*`, `DEC-*`, `SRC-*`, `AREA` records
- **Documentation:** durable reference files under `docs/`
- **Root docs:** `README.md`, `AGENTS.md`, `CLAUDE.md`
- **Wiki reference:** `wiki/schema.md`, `wiki/conventions.md`, `wiki/index.md`
- **Planning support:** `docs/superpowers/specs/` and `docs/superpowers/plans/` are useful supporting context, but they are not the first source of current feature status.

### Non-Canonical (Generated) Content

Generated views are rebuilt by `wiki generate` and are not authoritative:

- `wiki/catalog.md`
- `wiki/now.md`
- `wiki/inbox.md`
- `wiki/backlog.md`
- `wiki/archive.md`

Generated content is excluded from the search index.

## Search Architecture

### Index Building

1. Scan wiki record directories for manifest-driven record types
2. Scan `docs/` for markdown files
3. Scan root for `README.md`, `AGENTS.md`, `CLAUDE.md`
4. Extract frontmatter and body text from each file
5. Build a term-frequency index
6. Write index to `wiki/.search-index.json`

### Query Processing

1. Tokenize the query string
2. Match tokens against the index
3. Apply optional prefix and status filters
4. Score results by term frequency
5. Return sorted results with snippets

### Exclusions

The following paths are always excluded from indexing:

- Generated wiki views
- `wiki/handoffs/` (dispatch-owned)
- `.agent-runs/` (runtime state)
- `scratch_space/` (development workspace)
- `node_modules/` (dependencies)
- `dist/` (build output)

## Retrieval Facets

Records may carry retrieval-related frontmatter for future use:

- `catalog` — boolean, controls catalog inclusion
- `catalog_eligible` — boolean, controls early catalog eligibility
- `catalog_weight` — number, ordering adjustment

These facets are defined in the manifest but are not yet used by MVP search.

## MVP Limitations

- Lexical search only (no embeddings or semantic search)
- No cross-repo search
- No retrieval ranking beyond term frequency
- No authority-aware ranking

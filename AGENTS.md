# Agent Operating Guide

This document is the primary reference for any agent session working in the `kb` repository. Read it before making changes.

## Project Summary

`kb` is a TypeScript monorepo toolkit providing three subsystems:

1. **Wiki** -- Structured repo-local wiki with manifest-driven record types (WK, IN, DEC, SRC, AREA). Operations: bootstrap, sync-contract, allocate-id, create, lint, generate, build-search-index, search. Interfaces: CLI and MCP server.
2. **Dispatch Protocol** -- Reviewed multi-agent handoff workflow using HO-\* documents. Token-based state machine (review then launch). Platform-aware config. Deterministic fake-agent for testing.
3. **Graph Explore** -- Deterministic code-first graph extraction at file/module level. Wiki overlay from frontmatter. Produces JSON and markdown summary.

### Sister-Repo Model

`kb` lives in its own repository. It targets consuming repos via `--dir`. Operators run commands from inside `kb/` and point at the target repo:

```
npm run wiki -- bootstrap --dir ../my-project --repo org/name
npm run graph -- --dir ../my-project
```

## Core Architecture

### Monorepo Layout

```
kb/
  packages/
    wiki-core/       Core wiki operations (bootstrap, sync, allocate, create, lint, generate, search)
    wiki-cli/        CLI entry point for wiki commands
    wiki-mcp/        MCP server exposing wiki operations as tools
    dispatch-core/   Core dispatch operations (review, launch, cleanup, token management)
    dispatch-cli/    CLI entry point for dispatch commands
    graph-explore/   Deterministic code-first graph extraction
  contract/
    manifest.json    Record type definitions, field schemas, enum values
    templates/       Record templates (issue, initiative, decision, source, area, handoff)
    bootstrap/       Bootstrap surface docs (schema.md, conventions.md, index.md)
    schema.md        Contract schema reference
    conventions.md   Wiki conventions
    taxonomy.md      Record taxonomy
    query.md         Query patterns
    retrieval.md     Retrieval strategy
    lint.md          Lint rule reference
  tests/
    wiki-core.test.ts
    dispatch.test.ts
    graph-explore.test.ts
    interface-smoke.test.ts
    fixtures/
      fake-agent.ts
      sample-repo/
  docs/              Operator-facing documentation
```

### Package Purposes

| Package | Purpose |
|---------|---------|
| `wiki-core` | All wiki logic. No CLI, no I/O formatting. Exports typed functions. |
| `wiki-cli` | Thin CLI wrapper. Parses args, calls wiki-core, formats output. |
| `wiki-mcp` | MCP server. Registers wiki-core operations as MCP tools. |
| `dispatch-core` | Review, launch, cleanup, token, paths. No CLI. |
| `dispatch-cli` | Thin CLI wrapper for dispatch operations. |
| `graph-explore` | File scanning, code import extraction, wiki overlay, graph output. |

### Contract-Driven Design

The `contract/manifest.json` file is the source of truth for wiki record types. It defines:

- Which prefixes exist (WK, IN, DEC, SRC, AREA)
- Which prefixes are excluded (HO)
- Required and optional frontmatter fields per type
- Enum values for status, priority, type fields
- ID allocation strategy per type
- Directory mapping per type

All wiki-core operations resolve behavior from the manifest. Do not hardcode record type behavior.

## Root Scripts

```
npm run wiki -- <command> [--dir <path>] [options]    Wiki CLI
npm run wiki:mcp                                       Start MCP server
npm run dispatch -- <command> [options]                 Dispatch CLI
npm run graph -- --dir <path>                          Graph extraction
npm test                                               Run all tests (vitest)
npm run typecheck                                      Typecheck entire monorepo (tsc --build)
```

## Working Conventions

### TypeScript Patterns

- TypeScript 5.x, Node.js 20+, npm workspaces
- All packages use `tsconfig.json` extending `../../tsconfig.base.json`
- Root `tsconfig.json` has project references to all packages and `tsconfig.tests.json`
- Use `.js` extensions in import specifiers (TypeScript ESM resolution)
- Run with `tsx` (no separate compile step for CLI usage)
- Test with `vitest`
- Schema validation with `zod`

### Module Boundaries

- `wiki-cli` imports from `@kb/wiki-core`. It does not import from dispatch or graph.
- `wiki-mcp` imports from `@kb/wiki-core`. It does not import from dispatch or graph.
- `dispatch-cli` imports from `@kb/dispatch-core`. It does not import from wiki or graph.
- `graph-explore` is standalone. It reads wiki files directly but does not import wiki-core or dispatch-core.
- No circular dependencies between packages.

### Result Types

Both wiki-core and dispatch-core use typed Result types:

- `wiki-core`: `Result<T>` with `ok(data)` / `fail(errorCode, message)`
- `dispatch-core`: `DispatchResult<T>` with `ok(data)` / `fail(errorCode, message)`

All public functions return Result types. Never throw from public API functions.

## Wiki Conventions

### Manifest-Driven Records

The five manifest-driven record types:

| Prefix | Type | Directory | ID Strategy |
|--------|------|-----------|-------------|
| WK | Work item (issue) | `wiki/issues/` | Allocated sequential |
| IN | Initiative | `wiki/initiatives/` | Allocated sequential |
| DEC | Decision | `wiki/decisions/` | Allocated sequential |
| SRC | Source | `wiki/sources/` | Allocated sequential |
| AREA | Area | `wiki/areas/` | Slug-based |

### HO-\* Ownership

`HO-*` handoff records are **dispatch-owned**, not manifest-driven wiki records:

- `HO` is listed in `manifest.json` under `excludedPrefixes`
- `wiki create` rejects the `HO` prefix with `INVALID_PREFIX`
- Handoff template (`contract/templates/handoff.md`) is synced as a shared template surface
- HO-\* files live in `wiki/handoffs/` and are authored manually

### Handoffs Exclusion Rules

`wiki/handoffs/` is excluded from all wiki scanning operations:

- `lint` does not scan `wiki/handoffs/`
- `generate` does not include handoffs in generated views
- `search` / `build-search-index` does not index handoffs
- Graph scanning excludes `wiki/handoffs/`

### Generated Views

The following files are generated by `wiki generate` and are not canonical:

- `wiki/catalog.md`
- `wiki/now.md`
- `wiki/inbox.md`
- `wiki/backlog.md`
- `wiki/archive.md`

These are excluded from lint and graph scanning.

## Dispatch Conventions

### Trust Model

- The **operator** controls config, registry, and tokens. These are trusted.
- **HO-\* handoffs** are untrusted input. They go through review validation.
- The agent registry (`launchers.v1.json`) lives in the operator config directory, not in the repo.
- Token keys (`token.key`) are operator-owned HMAC secrets.

### Review-Before-Launch

Every handoff must be reviewed before it can be launched. The review step:

1. Validates frontmatter against the Zod schema
2. Rejects forbidden fields (command, cwd, permissions, path-bearing fields)
3. Enforces `allowed_agents` from the handoff
4. Validates Read First paths exist in repo
5. Checks agent exists in registry
6. Creates an immutable review bundle in `.agent-runs/reviews/RV-<uuid>/`
7. Captures input manifest hash and registry hash
8. Issues a signed pending token

### Token State Machine

Tokens move through four states, each backed by a subdirectory under the operator config:

```
pending/ --> launching/ --> consumed/
                       \--> rejected/
```

- `pending`: Review completed, awaiting launch
- `launching`: Launch in progress
- `consumed`: Successfully launched and agent responded
- `rejected`: Expired, failed, or rejected

### cwd = repo_root Invariant

Agent processes are always spawned with `cwd` set to the repository root. This is enforced by `launch.ts`. The agent never controls its own working directory.

### Environment Allowlist

Launch builds a filtered environment. Only allowlisted variables from the operator's environment are passed through, plus dispatch-specific variables (`AGENT_BLACKBOARD_*`).

## Graph Conventions

### Deterministic Only

Graph extraction is fully deterministic:

- No semantic inference
- No heuristic clustering
- No function-level / symbol-level graphs
- File/module level only

### Code-First

Graph extracts import relationships from:

- TypeScript/JavaScript: `import`, `export ... from`, `require()`
- Python: `import`, `from ... import ...`

Only repo-local references are resolved. External/unresolved modules are ignored.

### Wiki Overlay

Graph reads explicit frontmatter fields from wiki records:

- `repo_paths` -> `repo_path` edges
- `docs` -> `doc` edges
- `depends_on` -> `depends_on` edges
- `blocks` -> `blocks` edges
- `related` -> `related` edges
- `area` -> `area` edges
- `initiative` -> `initiative` edges
- Markdown links in body -> `markdown_link` edges

### Node Kinds

- `code_file` -- source code files
- `doc_file` -- documentation files (.md, .txt, .rst)
- `wiki_record` -- manifest-driven wiki records

### Exclusions

Graph excludes:

- `wiki/handoffs/`
- Generated views (catalog.md, now.md, inbox.md, backlog.md, archive.md)
- `.agent-runs/`
- `scratch_space/`
- `node_modules/`
- `dist/`
- Runtime files (`.wiki-contract.json`, `.id-state.json`, `.search-index.json`, `.graph.json`)
- `graph-summary.md`

### Output

- `wiki/.graph.json` -- full graph as JSON
- `wiki/graph-summary.md` -- deterministic markdown summary with node/edge counts, orphans, missing nodes, highest in-degree

## Validation

Before declaring any work complete, run:

```
npm run typecheck && npm test
```

Both must pass. There are approximately 74 tests across four test files.

## What Not To Do

- **Do not add HO to the manifest.** HO-\* is dispatch-owned, not manifest-driven.
- **Do not include `wiki/handoffs/` in wiki operations.** Lint, generate, search, and graph all exclude it.
- **Do not add semantic or heuristic graph features.** Graph is deterministic, code-first, file/module level only.
- **Do not modify `contract/manifest.json` to add post-MVP types.** The five types (WK, IN, DEC, SRC, AREA) are the MVP set.
- **Do not throw from public API functions.** Use the Result type pattern.
- **Do not import across subsystem boundaries.** wiki-cli uses wiki-core. dispatch-cli uses dispatch-core. graph-explore is standalone.
- **Do not describe features that do not exist.** No semantic search, no embeddings, no function-level graphs.
- **Do not modify files under `scratch_space/`.** That directory is for planning and reference only.

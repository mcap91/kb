# Adopting kb in a Consuming Repo

This guide explains how to adopt `kb` in your own repository. `kb` uses a sister-repo model: it lives in its own repo and targets your repo via `--dir`.

If you are upgrading an existing consuming repo rather than adopting `kb` for the first time, use [upgrade-consuming-repo.md](./upgrade-consuming-repo.md).

## Prerequisites

- Node.js 20+
- npm
- Clone `kb` alongside your target repo:

```
projects/
  kb/               <-- this toolkit
  my-project/       <-- your consuming repo
```

Install dependencies in `kb`:

```
cd kb
npm install
```

## Bootstrap

Bootstrap creates the wiki directory structure in your repo:

```
npm run wiki -- bootstrap --dir ../my-project --repo org/my-project
```

This creates:

- `wiki/issues/`, `wiki/initiatives/`, `wiki/decisions/`, `wiki/sources/`, `wiki/areas/`, `wiki/handoffs/`
- `wiki/.wiki-contract.json` -- contract metadata
- `wiki/.id-state.json` -- ID allocation state
- `wiki/schema.md`, `wiki/conventions.md`, `wiki/index.md` -- bootstrap surfaces (created if absent, never overwritten)
- Record templates copied into wiki directories

Use `--dry-run` to preview without writing:

```
npm run wiki -- bootstrap --dir ../my-project --repo org/my-project --dry-run
```

## Daily Operations

### Create Records

Create wiki records using the `create` command:

```
# Create a work item
npm run wiki -- create --dir ../my-project --prefix WK --title "Fix authentication bug"

# Create an initiative
npm run wiki -- create --dir ../my-project --prefix IN --title "Q3 performance improvements"

# Create a decision record
npm run wiki -- create --dir ../my-project --prefix DEC --title "Adopt TypeScript strict mode"

# Create a source reference
npm run wiki -- create --dir ../my-project --prefix SRC --title "OAuth 2.0 RFC 6749"

# Create an area (requires --slug for slug-based ID)
npm run wiki -- create --dir ../my-project --prefix AREA --title "Authentication" --slug auth
```

Available prefixes: `WK` (work item), `IN` (initiative), `DEC` (decision), `SRC` (source), `AREA` (area).

`HO` is not a valid `wiki create` target. Handoffs are dispatch-owned and live in `wiki/handoffs/`.

### Allocate IDs

Allocate the next sequential ID without creating a file:

```
npm run wiki -- allocate-id --dir ../my-project --prefix WK
```

### Lint

Validate all wiki records for frontmatter correctness:

```
npm run wiki -- lint --dir ../my-project
```

Lint checks:

- Required frontmatter fields are present
- Enum fields have valid values
- No duplicate IDs
- Record cross-references resolve
- Closed issues with unchecked checklists generate warnings

Lint excludes `wiki/handoffs/` and generated views.

### Generate Views

Generate standard wiki views:

```
npm run wiki -- generate --dir ../my-project
```

Produces:

- `wiki/catalog.md` -- all records
- `wiki/now.md` -- active work
- `wiki/inbox.md` -- inbox items
- `wiki/backlog.md` -- backlog items
- `wiki/archive.md` -- completed/closed items

### Search

Build the search index and search:

```
npm run wiki -- build-search-index --dir ../my-project
npm run wiki -- search --dir ../my-project --query "authentication"
```

Search options:

- `--prefix WK` -- filter by record type
- `--status in_progress` -- filter by status
- `--limit 10` -- limit results

Search indexes manifest-driven wiki records, `docs/**/*.md`, and root `README.md`, `AGENTS.md`, `CLAUDE.md`. It excludes `wiki/handoffs/`, generated views, `.agent-runs/`, `scratch_space/`, `node_modules/`, and `dist/`.

### Sync Contract

After updating `kb`, sync the contract templates into your repo:

```
npm run wiki -- sync-contract --dir ../my-project
```

Use `--check` to see drift without writing:

```
npm run wiki -- sync-contract --dir ../my-project --check
```

Sync updates record templates but does not overwrite `wiki/schema.md`, `wiki/conventions.md`, or `wiki/index.md`.

## Dispatch Setup

The Dispatch Protocol enables reviewed multi-agent handoff workflows.

### Initialize Config

Set up the operator dispatch configuration (one-time):

```
npm run dispatch -- init-config
```

If you are upgrading from an older `kb` dispatch install, run:

```
npm run dispatch -- init-config --force
```

The registry file is operator-owned and is not overwritten by default. `--force` rewrites `launchers.v1.json` into the current adapter-based format.

This creates the config directory with:

- `token.key` -- HMAC signing key
- `launchers.v1.json` -- agent registry with default entries (claude, codex, fake-agent)
- `fake-agent` is wired to the `kb` checkout via absolute `tsx` + fixture paths so it can launch from consuming repos
- Token state directories (`pending/`, `launching/`, `consumed/`, `rejected/`)

Config location:

- Windows: `%APPDATA%\kb-dispatch\`
- POSIX: `~/.config/kb-dispatch/`

### Write a Handoff

Create a durable handoff in your repo:

```
npm run dispatch -- create-handoff --dir ../my-project --title "Fix authentication bug" --subject "Authentication" --allowed-agents codex,claude --mode implement --work-item WK-0001 --write-scope src/auth.ts,tests/auth.test.ts --read-first AGENTS.md,wiki/issues/WK-0001.md
```

This writes `wiki/handoffs/HO-XXXX.md`. You can also author handoffs manually if needed, but `dispatch create-handoff` is the default path.

Fill in or refine:

- `allowed_agents`
- `mode`: `implement`, `code_review`, or `redteam`
- `write_scope`
- `## Read First`
- `## Objective`
- `## Constraints`
- `## Expected Output`
- `## Context`

### Review and Launch

Review the handoff (operator must explicitly acknowledge):

```
npm run dispatch -- review --dir ../my-project --handoff wiki/handoffs/HO-0001.md --agent fake-agent --reviewed-and-accept-risks
```

Review validates the handoff, creates an immutable reviewed bundle, and issues a pending token. The output includes a review ID (`RV-<uuid>`).

Reviewed bundle layout:

```
.agent-runs/reviews/RV-<uuid>/
  agent-visible/
    wrapper.md
    handoff.snapshot.md
    context/
  metadata/
    input-manifest.json
    review.json
```

Launch the reviewed handoff:

```
npm run dispatch -- launch --review-id RV-<uuid> --dir ../my-project
```

Launch re-verifies hashes, copies the reviewed bundle into `.agent-runs/runs/<handoffId>/RUN-<uuid>/`, spawns the agent from `agent-visible/`, and captures the response in `response.md`.

For a single-step operator flow, use:

```
npm run dispatch -- review-and-launch --dir ../my-project --handoff wiki/handoffs/HO-0001.md --agent codex --reviewed-and-accept-risks
```

### Status and Cleanup

Check dispatch state:

```
npm run dispatch -- status --dir ../my-project
```

Clean up stale state (orphan reviews, expired tokens):

```
npm run dispatch -- cleanup --dir ../my-project
```

## Graph Extraction

Run deterministic graph extraction on your repo:

```
npm run graph -- --dir ../my-project
```

Produces:

- `wiki/.graph.json` -- full graph with nodes and edges
- `wiki/graph-summary.md` -- markdown summary with counts, orphans, missing nodes, highest in-degree

The graph extracts:

- Code import relationships (TypeScript/JavaScript/Python)
- Wiki record relationships from frontmatter (repo_paths, depends_on, blocks, related, area, initiative, docs)
- Markdown links from wiki record bodies

Node kinds: `code_file`, `doc_file`, `wiki_record`. Only repo-local references are resolved.

## MCP Server

Connect the wiki MCP server to agent tools:

```
npm run wiki:mcp
```

This starts an MCP server over stdio that exposes all wiki operations as tools:

- `bootstrap`
- `sync-contract`
- `allocate-id`
- `create`
- `lint`
- `generate`
- `build-search-index`
- `search`

To configure an MCP client, point it at `npm run wiki:mcp` in the `kb` directory. Each tool accepts a `dir` parameter to target a consuming repo.

Dispatch also has an MCP server:

```
npm run dispatch:mcp
```

Dispatch MCP exposes:

- `init-config`
- `create-handoff`
- `review`
- `launch`
- `review-and-launch`
- `status`
- `cleanup`

For existing installations upgraded from the older registry format, run `npm run dispatch -- init-config --force` once before using dispatch MCP or CLI launch commands.

## Recommended .gitignore Additions

Add these to your consuming repo's `.gitignore`:

```
.agent-runs/
wiki/.search-index.json
wiki/.graph.json
```

Generated views (`wiki/catalog.md`, etc.) may be committed or ignored depending on your preference.

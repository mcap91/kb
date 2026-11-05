# Install kb-wiki in Your Repo

kb ships in three install layers. Each layer adds to the one before it, and each one installs with one
command sequence. The commands write every file; this page only names them.

| Layer | What it adds | Install page |
|---|---|---|
| wiki | The repo-local wiki, the `kb-wiki` MCP server, and the wiki operating block in `AGENTS.md`/`CLAUDE.md` | this page |
| planning | The engineering rules, the planner role, the `/resolve` skill, and the escalation template | [install-planning.md](./install-planning.md) |
| dispatch | The multi-agent handoff protocol (`kb-dispatch`) | [install-dispatch.md](./install-dispatch.md) |

The wiki layer stands alone. It names no roles, no skills, and no dispatch machinery.

If you are upgrading a repo that already uses kb, use [upgrade-consuming-repo.md](./upgrade-consuming-repo.md).

If you are working in `kb` itself rather than a separate consuming repo, use the committed repo-root
`.mcp.json` for Claude, run `npm run codex:mcp:register` for Codex, and target the `kb` checkout itself
via `--dir`. Do not copy that self-hosted `kb/.mcp.json` into a consuming repo.

## Prerequisites

- Linux (the only supported OS)
- Node.js 20+ and npm
- A clone of `kb` with its dependencies installed:

```bash
git clone <kb repo url> kb
cd kb
npm ci
```

`kb` uses a sister-repo model: it lives in its own checkout and targets your repo with `--dir`. Run every
command on this page from the `kb` checkout. Set `MY_REPO` to the absolute path of your repo first:

```bash
export MY_REPO=/home/you/projects/my-repo
```

## Install for Codex (CLI or VS Code extension)

1. Bootstrap the wiki layer:

<!-- install-smoke: wiki-codex -->
```bash
npm run wiki -- bootstrap --dir "$MY_REPO" --repo my-org/my-repo --mcp-client codex
```

2. Run the `codex mcp add kb-wiki -- node ...` command that bootstrap prints. It registers `kb-wiki` in
   `~/.codex/config.toml`. The Codex CLI and the VS Code extension share that file.
3. Allow the kb-wiki tool calls. Approve each prompt in the Codex panel, or approve all kb-wiki tools
   once: open `~/.codex/config.toml`, find the `[mcp_servers.kb-wiki]` table that `codex mcp add` wrote,
   and add this line inside it:

```toml
default_tools_approval_mode = "approve"
```

   Do not add a second `[mcp_servers.kb-wiki]` header. Codex rejects the file with `duplicate key`.

4. Open your repo in VS Code and start a Codex chat. Codex reads `AGENTS.md`, which tells it to search
   the wiki first.

Check the registration with `codex mcp list`. Ask Codex to "create a WK for <topic> with kb-wiki"; the
record appears at `wiki/issues/WK-0001.md`.

When you later run `sync-contract` for a Codex repo, pass `--mcp-client codex` again. Without it, sync
writes a Claude `.mcp.json`.

## Install for Claude Code

<!-- install-smoke: wiki -->
```bash
npm run wiki -- bootstrap --dir "$MY_REPO" --repo my-org/my-repo
```

Bootstrap writes `.mcp.json` with the `kb-wiki` entry. Start Claude Code in your repo and approve the
`kb-wiki` server when it asks.

## What bootstrap writes

Bootstrap prints every path it creates or updates. Use `--dry-run` to see the list without writing:

```bash
npm run wiki -- bootstrap --dir "$MY_REPO" --repo my-org/my-repo --dry-run
```

In short: the wiki record directories, the record templates, the bootstrap docs (`wiki/schema.md`,
`wiki/conventions.md`, `wiki/index.md`, yours to edit after bootstrap), the allocator state, and the
managed block in `AGENTS.md` and `CLAUDE.md`. The block sits between `<!-- BEGIN kb-managed -->` and
`<!-- END kb-managed -->`; kb never touches text outside the markers.

`.mcp.json` holds absolute paths to the kb checkout on the host that wrote it, so it is never committed.
Bootstrap and sync add it to `.gitignore`; `lint` reports `MCP_CONFIG_TRACKED` if it is already tracked
(fix: `git rm --cached .mcp.json`).

`--mcp-client none` skips MCP config. `--no-agent-instructions` skips the managed block.

## Daily Operations

### Create Records

Create wiki records using the `create` command:

```
# Create a work item
npm run wiki -- create --dir "$MY_REPO" --prefix WK --title "Fix authentication bug"

# Create an initiative
npm run wiki -- create --dir "$MY_REPO" --prefix IN --title "Q3 performance improvements"

# Create a decision record
npm run wiki -- create --dir "$MY_REPO" --prefix DEC --title "Adopt TypeScript strict mode"

# Create a source reference
npm run wiki -- create --dir "$MY_REPO" --prefix SRC --title "OAuth 2.0 RFC 6749"

# Create an area (requires --slug for slug-based ID)
npm run wiki -- create --dir "$MY_REPO" --prefix AREA --title "Authentication" --slug auth
```

Available prefixes: `WK` (work item), `IN` (initiative), `DEC` (decision), `SRC` (source), `AREA` (area).

### Allocate IDs

Peek the next sequential ID without creating a file. This is an idempotent reservation — repeat calls
return the same ID until `create` claims it (peeking never burns an ID); use `create` to actually claim one:

```
npm run wiki -- allocate-id --dir "$MY_REPO" --prefix WK
```

### Lint

Validate all wiki records for frontmatter correctness:

```
npm run wiki -- lint --dir "$MY_REPO"
```

Lint checks:

- Required frontmatter fields are present
- Enum fields have valid values
- No duplicate IDs
- Record cross-references resolve
- Closed issues with unchecked checklists generate warnings

Lint excludes generated views.

### Generate Views

Generate standard wiki views:

```
npm run wiki -- generate --dir "$MY_REPO"
```

Produces:

- `wiki/catalog.md` -- all records
- `wiki/now.md` -- active work
- `wiki/inbox.md` -- inbox items
- `wiki/backlog.md` -- backlog items
- `wiki/archive.md` -- completed/closed items

### Search

Search the wiki. The first search builds the index; later searches rebuild it when records change:

```
npm run wiki -- search --dir "$MY_REPO" --query "authentication"
```

`build-search-index` rebuilds the index on demand.

Search options:

- `--prefix WK` -- filter by record type
- `--status in_progress` -- filter by status
- `--limit 10` -- limit results

Search indexes manifest-driven wiki records, `docs/**/*.md`, and root `README.md`, `AGENTS.md`, `CLAUDE.md`. It excludes generated views, `.agent-runs/`, `scratch_space/`, `node_modules/`, and `dist/`.

### Sync Contract

After updating `kb`, sync the contract templates into your repo:

```
npm run wiki -- sync-contract --dir "$MY_REPO"
```

Use `--check` to see drift without writing:

```
npm run wiki -- sync-contract --dir "$MY_REPO" --check
```

Sync updates the record templates and the managed block for your repo's install layers. It does not
overwrite `wiki/schema.md`, `wiki/conventions.md`, or `wiki/index.md`. See
[upgrade-consuming-repo.md](./upgrade-consuming-repo.md).

## Graph Extraction

Run deterministic graph extraction on your repo:

```
npm run graph -- --dir "$MY_REPO"
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

Manual terminal start from the `kb` repo:

```bash
npm run wiki:mcp
```

For native client registration, use the `.mcp.json` that bootstrap writes (Claude) or the `codex mcp add`
command it prints (Codex). Do not point strict stdio clients at `npm run wiki:mcp`; the npm wrapper
writes to stdout before the MCP handshake.

Wiki MCP tools are listed in [mcp-tools.md](./mcp-tools.md). Each tool call takes a `dir` parameter that
targets your repo. The dispatch tools come with the dispatch layer: see
[install-dispatch.md](./install-dispatch.md).

## Recommended .gitignore Additions

Add these to your consuming repo's `.gitignore`:

```
.agent-runs/
wiki/.search-index.json
wiki/.graph.json
```

Generated views (`wiki/catalog.md`, etc.) may be committed or ignored depending on your preference.

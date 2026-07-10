# Adopting kb in a Consuming Repo

This guide explains how to adopt `kb` in your own repository. `kb` uses a sister-repo model: it lives in its own repo and targets your repo via `--dir`.

If you are upgrading an existing consuming repo rather than adopting `kb` for the first time, use [upgrade-consuming-repo.md](./upgrade-consuming-repo.md).

If you are working in `kb` itself rather than a separate consuming repo, use the committed repo-root `.mcp.json` for Claude, run `npm run codex:mcp:register` for Codex, and target the `kb` checkout itself via `--dir`.

Do not copy that self-hosted `kb/.mcp.json` into a consuming repo verbatim. A consuming repo needs its own Claude `.mcp.json` that points back to the chosen `kb` checkout, while Codex uses a machine-level registration of the chosen `kb` checkout.

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

Bootstrap creates the wiki directory structure in your repo and sets up agent integration:

```
npm run wiki -- bootstrap --dir ../my-project --repo org/my-project
```

This creates:

- `wiki/issues/`, `wiki/initiatives/`, `wiki/decisions/`, `wiki/sources/`, `wiki/areas/`, `wiki/handoffs/`
- `wiki/.wiki-contract.json` -- contract metadata
- `wiki/.id-state.json` -- ID allocation state
- `wiki/schema.md`, `wiki/conventions.md`, `wiki/index.md` -- bootstrap surfaces (created if absent, never overwritten)
- Record templates copied into wiki directories
- `AGENTS.md` and `CLAUDE.md` -- managed block with MCP-first retrieval and operating rules (between `<!-- BEGIN kb-managed -->` / `<!-- END kb-managed -->` markers; consumer content outside the markers is preserved)
- `.mcp.json` -- Claude MCP client config with `kb-wiki` and `kb-dispatch` servers pointing at resolved kb paths (merged with existing entries if present)

Use `--dry-run` to preview without writing:

```
npm run wiki -- bootstrap --dir ../my-project --repo org/my-project --dry-run
```

### MCP Client Options

By default, bootstrap writes `.mcp.json` for Claude. Use `--mcp-client` to change this:

- `--mcp-client claude` (default): writes `.mcp.json` with `kb-wiki` and `kb-dispatch` server entries
- `--mcp-client codex`: prints `codex mcp add` commands instead of writing a file
- `--mcp-client none`: skips MCP config entirely

To skip the managed block in `AGENTS.md`/`CLAUDE.md`:

```
npm run wiki -- bootstrap --dir ../my-project --repo org/my-project --no-agent-instructions
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

`write_scope` may contain file paths or directory paths. During review, dispatch normalizes those
into reviewed access directories. For Claude non-redteam launches, those directories become
`--add-dir` grants. This is directory-granularity access, not per-file enforcement.

### Review and Launch

Review the handoff (operator must explicitly acknowledge):

```
npm run dispatch -- review --dir ../my-project --handoff wiki/handoffs/HO-0001.md --agent fake-agent --reviewed-and-accept-risks
```

Review validates the handoff, creates an immutable reviewed bundle, and issues a pending token. The output includes a review ID (`RV-<uuid>`).

If you want an explicit host probe before launch, run:

```
npm run dispatch -- check-environment
```

This writes an operator-owned `host-capabilities.v1.json` record next to the dispatch registry and
prints a route-viability report (container detection, HOME/config-dir writability, and a per-route
verdict for plain adapters / headless Claude / `write_scope` enforcement level / Codex / redteam).
Run it first on any new host. Launch also refreshes that record automatically when it is missing or
stale for the current registry hash.

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

The generated default `claude` and `codex` launcher entries are configured for non-interactive
child runs against the reviewed bundle. The launched child does not need `kb` MCP tools for the
core workflow. The interactive parent/operator uses `kb-dispatch` MCP tools such as `status`,
`wait-for-run`, and `get-response` to monitor the child run and retrieve its artifacts.

Current defaults stream the reviewed wrapper over stdin for both Claude and Codex. Codex writes its
last message to the launcher-owned response file via `-o {response_path}`.

`read_only.argv_suffix` is a separate restriction layer used only for `mode: redteam`. It
constrains the launched child run; it does not turn the child into a headless MCP client.

If a host cannot satisfy the required bubblewrap capability, the right response depends on the host.
On a **shared / multi-tenant** host (workstation, shared VM), treat it as a host problem: the kernel
sandbox is a real boundary, so prefer fixing the host and do not weaken permissions to work around it.
On a **single-tenant container pod** (Saturn Cloud, Posit, generic Kubernetes), bubblewrap cannot run
and cannot be fixed from inside the pod — the pod itself is the isolation boundary. There, "fix the
host" does not apply: run `check-environment` and use its per-route verdicts. Plain-process adapters
and headless Claude work; non-redteam Claude `write_scope` degrades to app-level enforcement (recorded
as a launch warning); redteam still fails closed. If `$HOME` is read-only, redirect the config store
with `export XDG_CONFIG_HOME="$PWD/.kbconfig"` before `init-config`. See the "Linux Sandbox Caveat"
section of `docs/dispatch-protocol.md` for the full recipe. `kb` does not ship a weaker-permission
fallback profile by default.

### Consultation Handoffs

Use the existing handoff schema for advice or design review:

- `mode: code_review`
- `write_scope: []`
- put questions and decision context in `## Objective` and `## Context`
- ask for short answers, rationale, risks, and recommended plan adjustments in `## Expected Output`

Do not add a separate `consult` mode. HOs are route-neutral packets: they can be read manually,
reviewed into immutable bundles, or launched through dispatch when the selected agent supports that
route. With `write_scope: []`, a launched child should be expected to work from the reviewed bundle
only, not from broad live-repo access.

### Claude After June 15, 2026

The default dispatch `claude` profile uses Claude Code print mode. Anthropic has announced that,
starting June 15, 2026, Claude Code `--print` / `-p` and Agent SDK usage on Max plans draws from
separate Agent SDK credits instead of normal interactive Claude usage.

If you do not want a separate Anthropic API or Agent SDK billing path, do not rely on dispatch-launched
Claude automation. Use Claude interactively as the parent/operator with kb MCP tools, or have Claude
read and answer HOs manually. For dispatch-launched automation, use Codex, fake-agent, or a local-agent
registry profile.

Local models such as Qwen/Ollama should be exposed through a thin local agent wrapper, not by putting a
model name in the HO. The wrapper should read `AGENT_BLACKBOARD_HANDOFF_PATH`, read context from
`AGENT_BLACKBOARD_CONTEXT_DIR`, call the local model, and write `AGENT_BLACKBOARD_RESPONSE_PATH`.

### Status and Cleanup

Check dispatch state:

```
npm run dispatch -- status --dir ../my-project
```

For MCP callers, `status` returns active launches with `reviewId`, `runId`, run directory, response
path, metadata paths, heartbeat timestamps, and process IDs. Use that output to decide whether to
call `wait-for-run`, retrieve partial artifacts with `get-response`, or continue other work.

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

Manual terminal start from the `kb` repo:

```bash
npm run wiki:mcp
npm run dispatch:mcp
```

These start stdio MCP server processes that expose the wiki and dispatch tools.

For native client registration, use the copy-paste Claude `.mcp.json` and Codex `mcp add` examples in [README.md](../README.md#agent-native-mcp-setup) rather than pointing strict stdio clients at `npm run ...:mcp`.

For consuming repos, keep the boundary explicit:

- Claude `.mcp.json` lives in the consuming repo
- that Claude config points back to the `kb` checkout
- Codex registration is user-level and can be reused across consuming repos on the same machine
- the committed `kb/.mcp.json` is only for the self-hosted `kb` repo case

Wiki MCP exposes:

- `bootstrap`
- `sync-contract`
- `allocate-id`
- `create`
- `lint`
- `generate`
- `build-search-index`
- `search`

Dispatch MCP exposes:

- `init-config`
- `check-environment`
- `create-handoff`
- `review`
- `launch`
- `review-and-launch`
- `status`
- `cleanup`
- `wait-for-run`
- `get-response`

For MCP callers, `launch` and `review-and-launch` default to background mode: the tool returns after
the child agent has started and run artifacts exist. Use `wait-for-run` to short-poll or wait for
terminal status, then `get-response` to retrieve `response.md`, metadata, state, and logs. Pass
`background: false` only when a blocking launch is desired.

Typical MCP dispatch workflow:

1. Create or reuse a `wiki/handoffs/HO-*.md`.
2. Review it with the selected registry agent.
3. Launch it through MCP; background mode returns `reviewId`, `runId`, and artifact paths.
4. Call `wait-for-run` with a short timeout while the parent agent keeps working.
5. Call `get-response` by `reviewId` or `runId`.
6. Inspect the answer, incorporate it, or create a follow-up HO.

Each wiki or dispatch tool call accepts a `dir` parameter to target a consuming repo.

For existing installations upgraded from the older registry format, run `npm run dispatch -- init-config --force` once before using dispatch MCP or CLI launch commands.

## Recommended .gitignore Additions

Add these to your consuming repo's `.gitignore`:

```
.agent-runs/
wiki/.search-index.json
wiki/.graph.json
```

Generated views (`wiki/catalog.md`, etc.) may be committed or ignored depending on your preference.

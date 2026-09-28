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

Available prefixes: `WK` (work item), `IN` (initiative), `DEC` (decision), `SRC` (source), `AREA` (area), `PLN` (plan), `VAL` (value report).

`HO` is not a valid `wiki create` target. Handoffs are dispatch-owned and live in `wiki/handoffs/`.

### Allocate IDs

Peek the next sequential ID without creating a file. This is an idempotent reservation — repeat calls
return the same ID until `create` claims it (peeking never burns an ID); use `create` to actually claim one:

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

The Dispatch Protocol enables reviewed multi-agent handoff workflows (see
[docs/dispatch-protocol.md](./dispatch-protocol.md) for the full technical reference). `dispatch` is one
atomic, gated call — admission, clone, jail, worker, delivery, and capture all happen inside a single
`dispatch` invocation. There is no separate global operator registry and no pre-launch review-token step;
dispatch config is repo-local, under the consuming repo's own `wiki/.dispatch/`.

### 1. Scaffold Dispatch Config

Scaffold the consuming repo's `wiki/.dispatch/` config tables (one-time, write-once):

```
npm run dispatch -- init-dispatch --dir ../my-project
```

This creates, only if absent (a re-run never overwrites existing content):

- `wiki/.dispatch/models.json` -- model slug to backend + provider `model_id` (starts blank `{}`)
- `wiki/.dispatch/backends.json` -- backend name to family/base_url/api_key_env/secrets_file (starts blank `{}`)
- `wiki/.dispatch/profiles.json` -- credential profiles (starts `{"schema_version": 1}`)
- `wiki/.dispatch/README.md` -- reference docs for the tables above, including example entries

Edit `models.json` and `backends.json` to register at least one model/backend pair before dispatching
(see the generated README for the shape). A local model server (Ollama, vLLM) is just a `pi`-family
backend entry pointed at a `base_url`.

### 2. Check the Host

Probe bubblewrap/container/writability facts before your first dispatch:

```
npm run dispatch -- check-environment
```

`dispatch` gates every call on the same live bubblewrap probe (does the binary run, does a
`--unshare-user` round trip succeed); `check-environment` runs that identical probe on demand plus
informational container detection so you can see what a real `dispatch` call will do on this host.

If a host cannot satisfy the required bubblewrap capability, the right response depends on the host. On
a **shared / multi-tenant** host (workstation, shared VM), treat it as a host problem: the kernel sandbox
is a real boundary, so prefer fixing the host and do not weaken permissions to work around it. On a
**single-tenant container pod** (Saturn Cloud, Posit, generic Kubernetes), bubblewrap cannot run and
cannot be fixed from inside the pod — `dispatch` fails closed with `NO_ISOLATION_ROUTE` there. `kb` does
not ship a weaker-permission fallback profile by default.

### 3. Write a Handoff

Create a durable handoff in your repo:

```
npm run dispatch -- create-handoff --dir ../my-project --title "Fix authentication bug" --subject "Authentication" --allowed-agents codex,claude --mode implement --work-item WK-0001 --write-scope src/auth.ts,tests/auth.test.ts --read-first AGENTS.md,wiki/issues/WK-0001.md
```

This writes `wiki/handoffs/HO-XXXX.md`. You can also author handoffs manually if needed, but `dispatch create-handoff` is the default path.

Fill in or refine:

- `allowed_agents`
- `mode`: `implement`, `code_review`, `redteam`, or `research`
- `write_scope`
- `## Read First`
- `## Objective`
- `## Constraints`
- `## Expected Output`
- `## Context`

`write_scope` entries may be file paths or directory paths, repo-relative. Only `implement` mode may
deliver a commit; `code_review`/`redteam`/`research` must carry an empty `write_scope` and never gain
write authority inside the jail regardless of what the HO asks for.

### 4. Dispatch and Wait

Run the handoff through the v2 pipeline:

```
npm run dispatch -- dispatch --dir ../my-project --handoff wiki/handoffs/HO-0001.md
```

`dispatch` always runs in the background and returns a `runId` immediately. Wait for it to reach a
terminal status:

```
npm run dispatch -- wait-for-run --dir ../my-project --run-id RUN-<uuid>
```

For `implement` mode, a successful run lands a scope-checked commit onto `refs/heads/dispatch/HO-XXXX`
and writes the result to `wiki/handoffs/HO-XXXX.response.md` (both auto-committed). Advisory modes
(`code_review`/`redteam`/`research`) never deliver a commit — the worker's response is the deliverable.

If admission fails, `dispatch` refuses synchronously, before any worker spawns, with a structured
refusal code (`MISSING_WRITE_SCOPE`, `DIRTY_REPO`, `NO_ISOLATION_ROUTE`, and others — see
[docs/dispatch-protocol.md](./dispatch-protocol.md#refusal-codes)).

### Consultation Handoffs

Use the existing handoff schema for advice or design review:

- `mode: code_review`
- `write_scope: []`
- put questions and decision context in `## Objective` and `## Context`
- ask for short answers, rationale, risks, and recommended plan adjustments in `## Expected Output`

Do not add a separate `consult` mode. HOs are route-neutral packets: they can be read manually or
dispatched through the pipeline. With `write_scope: []`, the worker gets no write authority regardless
of what the HO asks for.

### Claude After June 15, 2026

The default dispatch `claude` backend uses Claude Code print mode. Anthropic has announced that,
starting June 15, 2026, Claude Code `--print` / `-p` and Agent SDK usage on Max plans draws from
separate Agent SDK credits instead of normal interactive Claude usage.

If you do not want a separate Anthropic API or Agent SDK billing path, do not rely on dispatch-launched
Claude automation. Use Claude interactively as the parent/operator with kb MCP tools, or have Claude
read and answer HOs manually. For dispatch-launched automation, use Codex or a local-agent backend entry.

Local models such as Qwen/Ollama should be registered as a `pi`-family entry in `wiki/.dispatch/backends.json`
pointed at the local server's `base_url` — there is no separate pluggable-agent-wrapper mechanism.

### Status and Cleanup

Check dispatch state:

```
npm run dispatch -- status --dir ../my-project
```

`status` returns active runs (model, delivery status, branch, heartbeat age, log tail) plus the 10 most
recent terminal runs. Use that output to decide whether to call `wait-for-run` or continue other work.

Clean up stale state (orphan run/review directories past the retention window, stale/expired tokens):

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

- `init-dispatch`
- `check-environment`
- `create-handoff`
- `dispatch`
- `status`
- `cleanup`
- `derive-review`
- `merge-delivery`
- `restamp`
- `stop-run`

`dispatch` always runs in background mode: the tool returns a `runId` immediately, plus a `watch`
command to poll for terminal status. `wait-for-run` and `init-dispatch` are also available as
`dispatch-cli` subcommands; `derive-review`, `merge-delivery`, and `stop-run` are MCP-only today.

Typical MCP dispatch workflow (see [docs/dispatch-protocol.md](./dispatch-protocol.md#post-run-lifecycle-tools-wk-0132)
for the full orchestration recipe):

1. Create or reuse a `wiki/handoffs/HO-*.md` with `create-handoff`.
2. Dispatch it; background mode returns `runId` and a `watch` command.
3. Poll or wait for terminal status, then read `wiki/handoffs/HO-XXXX.response.md`.
4. On a delivered `implement` HO, derive a `code_review` HO with `derive-review`.
5. Dispatch the review HO the same way; read its response doc.
6. On a passing review, merge the delivery branch with `merge-delivery`.

Each wiki or dispatch tool call accepts a `dir` parameter to target a consuming repo.

## Recommended .gitignore Additions

Add these to your consuming repo's `.gitignore`:

```
.agent-runs/
wiki/.search-index.json
wiki/.graph.json
```

Generated views (`wiki/catalog.md`, etc.) may be committed or ignored depending on your preference.

# kb

`kb` is an agent-facing toolkit for adopting and operating a structured repo-local wiki, reviewed multi-agent dispatch, and deterministic code-first graph extraction in a separate consuming repository.

This repository is the **tooling repo**. The other repository is the **consuming repo**. `kb` runs from its own checkout and targets the consuming repo via `--dir`.

When you are working on `kb` itself, this same checkout can also act as the consuming repo. In that self-hosted case, the MCP servers still run from `kb`, and tool calls use `dir` pointing back at this `kb` checkout.

## What Agents Should Do

Use this model:

- Run the **wiki MCP server** and, when needed, the **dispatch MCP server** from the `kb` repo.
- Use **MCP for wiki operations**: `bootstrap`, `sync-contract`, `allocate-id`, `create`, `lint`, `generate`, `build-search-index`, `search`.
- Use **MCP or CLI for dispatch operations**: `init-config`, `check-environment`, `create-handoff`, `review`, `launch`, `review-and-launch`, `status`, `cleanup`.
- Use the **CLI from the `kb` repo** for `graph`.
- Always target the consuming repo explicitly with `dir`.

Repository-context retrieval is a wiki/docs retrieval problem first, not a filesystem-search problem first.

Before substantive work:

1. Search the wiki with the kb wiki MCP `search` tool. This is the first retrieval step.
2. If you need a structured overview, regenerate views with the MCP `generate` tool and read them (`catalog`, `now`, `inbox`, `backlog`, `archive`).
3. Then read the relevant durable `docs/` pages.
4. Then check related `wiki/decisions/`, `wiki/issues/`, `wiki/initiatives/`, `wiki/areas/`, and `wiki/sources/`.
5. Only then inspect `packages/` and `tests/`.

If the kb wiki MCP server is not available this session, run the same steps via the kb CLI from the kb checkout. Do not use raw `rg`, file globbing, or direct file reads as the first retrieval step. Do not parallelize implementation search with the initial retrieval pass.

If generated views are missing or stale, prefer canonical pages directly over derived views.

The wiki MCP tools and the wiki CLI both go through the same `wiki-core` implementation, so manifest rules, prefix validation, handoff exclusion, generated-view exclusion, ID allocation, linting, and search scope are enforced consistently.

## Repo Layout

Recommended layout:

```text
projects/
  kb/                 # this repo
  my-project/         # consuming repo
```

The examples below assume:

- `kb` lives at `../kb` relative to the consuming repo
- the consuming repo is the current repo

If your layout differs, adjust the path to `kb`.

## Install

Clone `kb` as a sibling repo next to your consuming repo:

```bash
git clone https://github.com/mcap91/kb.git
```

Layout:

```text
projects/
  kb/
  my-project/
```

## Install kb

From the `kb` repo:

```bash
npm install
npm run typecheck
npm test
```

If `kb` is already installed and you are updating it:

```bash
git pull
npm install
npm run typecheck
npm test
```

## How MCP Works

The MCP servers run in the **`kb` repo**, not in the consuming repo.

That means:

- start the wiki and dispatch servers from `kb`
- connect your agent/client to those servers
- every wiki or dispatch tool call must include `dir` pointing at the consuming repo
- you do **not** run separate `kb` MCP servers inside each consuming repo

The `kb` MCP servers can target different consuming repos because the target repo is provided per tool call through `dir`.

Current boundary:

- `wiki` is on MCP
- `dispatch` is on MCP and CLI
- `graph` is CLI-only

## Self-Hosting kb

When the current repository is `kb` itself:

- `kb` is both the MCP provider and the target repo
- use `dir` pointing at this `kb` checkout
- create a local `.mcp.json` using the template in the Claude Project section below
- Codex can register this checkout with `npm run codex:mcp:register`

This does not change the sister-repo model for other projects. Consuming repos still point back to the `kb` checkout via `--dir`.

Important boundary:

- a consuming repo needs its own Claude `.mcp.json` that points back to the chosen `kb` checkout
- Codex MCP registration is user-level on the machine and should point at one chosen `kb` checkout

## MCP Lifecycle

`npm run wiki:mcp` and `npm run dispatch:mcp` start **live stdio MCP server processes**. They are not persistent background daemons.

What persists:

- the `kb` checkout
- installed dependencies
- the consuming repo wiki files
- generated artifacts such as `.search-index.json` and `.graph.json`

What does not persist automatically:

- the running wiki MCP server process
- the running dispatch MCP server process

After a VM reboot, shell restart, or disconnected session, agents do **not** have wiki or dispatch MCP access until the server is started again.

Recommended model:

- configure the agent client to launch the MCP server commands directly when the client session starts

Fallback model:

- start it manually in a shell each session

Example manual start:

```bash
cd /absolute/path/to/kb
node --import tsx packages/wiki-mcp/src/server.ts
node --import tsx packages/dispatch-mcp/src/server.ts
```

## Agent-Native MCP Setup

For native MCP clients, register the direct `node` commands rather than `npm run ...:mcp`.

Why the direct command matters:

- `npm run wiki:mcp` and `npm run dispatch:mcp` are fine for manual terminal use
- strict stdio MCP clients should avoid `npm run ...:mcp` because the npm script banner writes to stdout before the MCP handshake
- `node --import tsx ...` starts the same server without the npm wrapper output

### Self-Hosted `kb` Repo

If Claude is opened in this `kb` repo, create a local `.mcp.json` using the template in the Claude Project section below, with paths pointing at this checkout.

If Codex is opened in this `kb` repo, run this once from the `kb` checkout:

```bash
npm run codex:mcp:register
```

That registers user-level `kb-wiki` and `kb-dispatch` entries pointing at the current `kb` checkout.

### Consuming Repo Setup

When Claude or Codex is opened in a consuming repo:

- do not reuse the committed `kb/.mcp.json` file as-is
- for Claude, create a `.mcp.json` in the consuming repo that points back to the chosen `kb` checkout
- for Codex, register the chosen `kb` checkout once on that machine and reuse those MCP servers from the consuming repo

The server still runs from `kb`. Only the `dir` argument changes per consuming repo.

### Claude Project `.mcp.json`

Claude supports a project-scoped `.mcp.json`. Put this file in the repo where Claude will run and replace:

- `<TSX-LOADER-FILE-URL>` with a file URL to `node_modules/tsx/dist/loader.mjs`
- `<ABSOLUTE-PATH-TO-KB>` with the absolute path to your `kb` checkout, using forward slashes

Examples for `<TSX-LOADER-FILE-URL>`:

- Windows: `file:///C:/Users/you/projects/kb/node_modules/tsx/dist/loader.mjs`
- Linux/macOS: `file:///home/you/projects/kb/node_modules/tsx/dist/loader.mjs`

```json
{
  "mcpServers": {
    "kb-wiki": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--import",
        "<TSX-LOADER-FILE-URL>",
        "<ABSOLUTE-PATH-TO-KB>/packages/wiki-mcp/src/server.ts"
      ],
      "env": {}
    },
    "kb-dispatch": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--import",
        "<TSX-LOADER-FILE-URL>",
        "<ABSOLUTE-PATH-TO-KB>/packages/dispatch-mcp/src/server.ts"
      ],
      "env": {}
    }
  }
}
```

Verify from that project directory:

```bash
claude mcp list
```

For a consuming repo, this `.mcp.json` belongs in the consuming repo root and points back to the `kb` checkout. Do not copy `kb/.mcp.json` into the consuming repo without rewriting the paths around that consuming repo's layout.

### Codex Native Registration

Codex uses native MCP registration rather than Claude's project `.mcp.json`.

For this `kb` repo itself, prefer:

```bash
npm run codex:mcp:register
```

For a manual or sister-repo registration, replace:

- `<TSX-LOADER-FILE-URL>` with a file URL to `node_modules/tsx/dist/loader.mjs`
- `<ABSOLUTE-PATH-TO-KB>` with the absolute path to your `kb` checkout, using forward slashes

```bash
codex mcp add kb-wiki -- node --import <TSX-LOADER-FILE-URL> <ABSOLUTE-PATH-TO-KB>/packages/wiki-mcp/src/server.ts
codex mcp add kb-dispatch -- node --import <TSX-LOADER-FILE-URL> <ABSOLUTE-PATH-TO-KB>/packages/dispatch-mcp/src/server.ts
codex mcp list
```

Codex registration is user-level, not repo-local. Register one chosen `kb` checkout per machine, then reuse those MCP servers from `kb` itself and from any consuming repo on that machine.

### Windows Note

The shorter commands below only work when the client preserves `cwd = <ABSOLUTE-PATH-TO-KB>` and Node can resolve `tsx` from that directory:

```bash
node --import tsx packages/wiki-mcp/src/server.ts
node --import tsx packages/dispatch-mcp/src/server.ts
```

If a native client does not preserve `cwd`, use the absolute loader and absolute script paths shown in the Claude and Codex examples above. On Windows, prefer forward slashes such as `C:/Users/you/projects/kb` inside `<ABSOLUTE-PATH-TO-KB>` so you do not need to escape backslashes in JSON.

On Windows PowerShell, execution policy can block the `.ps1` shims for `npm`, `claude`, and `codex`. In that case use `npm.cmd`, `claude.cmd`, and `codex.cmd`. On Linux and macOS, use the normal `npm`, `claude`, and `codex` commands.

## Start the Wiki MCP Server

From the `kb` repo:

```bash
npm run wiki:mcp
```

If you want the same server without the npm wrapper output:

```bash
node --import tsx packages/wiki-mcp/src/server.ts
```

## Start the Dispatch MCP Server

From the `kb` repo:

```bash
npm run dispatch:mcp
```

If you want the same server without the npm wrapper output:

```bash
node --import tsx packages/dispatch-mcp/src/server.ts
```

## Bootstrap a Consuming Repo

From the `kb` repo:

```bash
npm run wiki -- bootstrap --dir ../my-project --repo org/my-project
npm run dispatch -- init-config
npm run wiki -- generate --dir ../my-project
npm run wiki -- build-search-index --dir ../my-project
npm run graph -- --dir ../my-project
```

What this does:

- creates `wiki/` structure in the consuming repo
- copies bootstrap surfaces and templates
- initializes operator dispatch config
- generates standard wiki views
- builds the search index
- writes graph artifacts

## Usage Examples

### Wiki via CLI

Run from the `kb` repo:

```bash
# create a work item
npm run wiki -- create --dir ../my-project --prefix WK --title "Fix auth regression"

# create an initiative
npm run wiki -- create --dir ../my-project --prefix IN --title "Q3 platform hardening"

# create an area
npm run wiki -- create --dir ../my-project --prefix AREA --title "Authentication" --slug auth

# lint
npm run wiki -- lint --dir ../my-project

# regenerate views
npm run wiki -- generate --dir ../my-project

# rebuild search index
npm run wiki -- build-search-index --dir ../my-project

# search
npm run wiki -- search --dir ../my-project --query "authentication"

# sync templates after updating kb
npm run wiki -- sync-contract --dir ../my-project
```

### Wiki via MCP

Preferred for agents when MCP is available.

Use the `kb` wiki MCP server started from the `kb` repo, then call tools like:

- `bootstrap`
- `sync-contract`
- `allocate-id`
- `create`
- `lint`
- `generate`
- `build-search-index`
- `search`

Always pass:

- `dir`: consuming repo path

And when needed:

- `repo`: for `bootstrap`
- `prefix`, `title`, `query`, `status`, `check`, `dryRun`, `limit`

### Dispatch

Run from the `kb` repo:

```bash
# initialize operator config
npm run dispatch -- init-config

# probe and persist host sandbox capabilities
npm run dispatch -- check-environment

# create a durable handoff in the consuming repo
npm run dispatch -- create-handoff --dir ../my-project --title "Fix auth regression" --subject "Authentication" --allowed-agents codex,claude --mode implement --work-item WK-0001 --write-scope src/auth.ts,tests/auth.test.ts --read-first AGENTS.md,wiki/issues/WK-0001.md

# review and launch in one step
npm run dispatch -- review-and-launch --dir ../my-project --handoff wiki/handoffs/HO-0001.md --agent codex --reviewed-and-accept-risks

# inspect dispatch state
npm run dispatch -- status --dir ../my-project

# clean stale runtime state
npm run dispatch -- cleanup --dir ../my-project
```

Notes:

- `HO-*` handoffs are dispatch-owned
- do not try to create `HO-*` via `wiki create`
- `dispatch create-handoff` writes durable files under `wiki/handoffs/`
- `review` snapshots inputs under `.agent-runs/reviews/RV-.../agent-visible/` and `.agent-runs/reviews/RV-.../metadata/`
- `launch` runs the agent from the reviewed `agent-visible/` bundle, not the live repo root
- `dispatch check-environment` writes `host-capabilities.v1.json` in the operator config and launch consults it automatically
- Claude non-redteam launches honor reviewed `write_scope` by deriving directory-granularity `--add-dir` access; they do not receive blanket repo-root access unless the reviewed scope requires it
- if a host cannot satisfy the required sandbox capability, fix the host or use a different host rather than weakening permissions

### Graph

Run from the `kb` repo:

```bash
npm run graph -- --dir ../my-project
```

Outputs in the consuming repo:

- `wiki/.graph.json`
- `wiki/graph-summary.md`

## Update / Deploy kb Into an Existing Consuming Repo

For the exact upgrade runbook, including registry migration, consuming-repo instruction updates, MCP wiring, dispatch status checks, and smoke-test steps, see [docs/upgrade-consuming-repo.md](docs/upgrade-consuming-repo.md).

If you are upgrading an existing consuming repo, the minimum safe sequence from the `kb` repo is:

```bash
git pull
npm install
npm run typecheck
npm test
npm run wiki -- sync-contract --dir ../my-project
```

If the consuming repo uses dispatch and is upgrading from the older dispatch registry format, also run:

```bash
npm run dispatch -- init-config --force
```

After syncing the contract, regenerate the consuming repo artifacts:

```bash
npm run wiki -- lint --dir ../my-project
npm run wiki -- generate --dir ../my-project
npm run wiki -- build-search-index --dir ../my-project
npm run graph -- --dir ../my-project
```

Important caveats:

- Pulling `kb` is not enough. Update the consuming repo's `AGENTS.md` and `CLAUDE.md` separately using the paste-ready snippets below. `sync-contract` does not touch agent instruction files.
- `sync-contract` updates record templates and shared surfaces, but does not overwrite `wiki/schema.md`, `wiki/conventions.md`, or `wiki/index.md`.
- `init-config --force` is specifically for upgrades from the older dispatch registry format, because `launchers.v1.json` is operator-owned and is not overwritten by default.
- If you changed agent launcher config intentionally, re-review pending handoffs before launching them, because registry hash changes invalidate prior review tokens.
- If this is a first-time adoption rather than an upgrade, use `wiki bootstrap` instead.

## Paste-Ready `AGENTS.md` Snippet for a Consuming Repo

Paste this into the consuming repo's `AGENTS.md`:

Replace these two placeholders once after pasting:

- `<owner/name>`
- `../<this-repo-name>`

````md
# kb Integration

This repository uses the `kb` toolkit from `../kb`.

Assumptions:

- this repo is the consuming repo
- the `kb` repo lives at `../kb`
- all `kb` commands are run from `../kb`
- this repo is targeted via `dir`
- this repo does not reuse `../kb/.mcp.json` verbatim

## Required Behavior

When you need wiki operations, prefer the `kb` wiki MCP server running from `../kb`.

Use MCP for:

- `bootstrap`
- `sync-contract`
- `allocate-id`
- `create`
- `lint`
- `generate`
- `build-search-index`
- `search`

Always pass `dir` pointing at this repository.

When you need dispatch operations, prefer the `kb` dispatch MCP server or the `kb` CLI from `../kb`.

Dispatch operations:

- `init-config`
- `check-environment`
- `create-handoff`
- `review`
- `launch`
- `review-and-launch`
- `status`
- `cleanup`

When you need graph operations, use the `kb` CLI from `../kb`.

Do not run `kb` commands from this repo root unless explicitly instructed. Run them from `../kb` and point back to this repo with `--dir`.

Repository-context retrieval is a wiki/docs retrieval problem first, not a filesystem-search problem first.

Before substantive work:

1. Search the wiki with the kb wiki MCP `search` tool. This is the first retrieval step.
2. If you need a structured overview, regenerate views with the MCP `generate` tool and read them (`catalog`, `now`, `inbox`, `backlog`, `archive`).
3. Then read the relevant durable `docs/` pages.
4. Then check related `wiki/decisions/`, `wiki/issues/`, `wiki/initiatives/`, `wiki/areas/`, and `wiki/sources/`.
5. Only then inspect implementation files.

If the kb wiki MCP server is not available this session, run the same steps via the kb CLI from the kb checkout. Do not use raw `rg`, file globbing, or direct file reads as the first retrieval step. Do not parallelize implementation search with the initial retrieval pass.

## First-Time Setup

If `../kb` dependencies are not installed:

```bash
cd ../kb
npm install
npm run typecheck
npm test
```

Bootstrap writes `.mcp.json` (Claude) automatically with resolved paths. For Codex, pass `--mcp-client codex` to get the registration commands instead.

If this repo has not been bootstrapped yet:

1. Derive the repo slug from git remote if possible.
2. Run:

```bash
cd ../kb
npm run wiki -- bootstrap --dir ../<this-repo-name> --repo <owner/name>
npm run dispatch -- init-config
npm run wiki -- generate --dir ../<this-repo-name>
npm run wiki -- build-search-index --dir ../<this-repo-name>
npm run graph -- --dir ../<this-repo-name>
```

If you already know the absolute path to this repo, you may use that instead of a relative path.

## Day-2 Operations

After updating `kb`:

```bash
cd ../kb
npm run wiki -- sync-contract --dir ../<this-repo-name>
npm run wiki -- lint --dir ../<this-repo-name>
npm run wiki -- generate --dir ../<this-repo-name>
npm run wiki -- build-search-index --dir ../<this-repo-name>
npm run graph -- --dir ../<this-repo-name>
```

If this repo uses dispatch and is upgrading from the older dispatch registry format:

```bash
cd ../kb
npm run dispatch -- init-config --force
```

`sync-contract` refreshes the managed block in `AGENTS.md`/`CLAUDE.md` and merges `.mcp.json`.
It does not overwrite `wiki/schema.md`, `wiki/conventions.md`, or `wiki/index.md`.

## Rules

- Prefer MCP over CLI for wiki operations.
- Prefer dispatch MCP or CLI for `dispatch`.
- Use CLI for `graph`.
- Do not create `HO-*` via `wiki create`.
- `wiki/handoffs/` is dispatch-owned and excluded from wiki scanning operations.
- Always keep `kb` validation green before relying on it:

```bash
cd ../kb
npm run typecheck
npm test
```
````

## Auto-Managed Agent Instructions

`kb bootstrap` and `kb sync-contract` automatically write a managed block into the consuming repo's
`AGENTS.md` and `CLAUDE.md` between `<!-- BEGIN kb-managed -->` / `<!-- END kb-managed -->` markers.
The block is the same in both files and contains the MCP-first retrieval procedure and operating rules.
Content outside the markers is never touched.

Bootstrap also writes `.mcp.json` (for Claude, default) with resolved paths to `kb-wiki` and `kb-dispatch`
servers. For Codex, pass `--mcp-client codex` to get `codex mcp add` commands instead.

The managed block content is shown here for reference:

````md
## kb integration

This repository uses the `kb` toolkit (repo-local wiki, reviewed dispatch, deterministic graph). The kb
MCP servers (`kb-wiki`, `kb-dispatch`) are registered in this repo's `.mcp.json` and run from the kb
checkout; every kb tool call targets this repository via `dir`.

### Retrieval — do this before substantive work

Repository-context retrieval is a wiki/docs retrieval problem first, not a filesystem-search problem first.

1. Search the wiki with the kb wiki MCP `search` tool. This is the first retrieval step.
2. If you need a structured overview, regenerate views with the MCP `generate` tool and read them
   (`catalog`, `now`, `inbox`, `backlog`, `archive`).
3. Then read the relevant durable `docs/` pages.
4. Then check related `wiki/decisions/`, `wiki/issues/`, `wiki/initiatives/`, `wiki/areas/`, `wiki/sources/`.
5. Only then inspect implementation files.

If the kb wiki MCP server is not available this session, run the same steps via the kb CLI from the kb
checkout (`npm run wiki -- search --dir <this repo>`, `npm run wiki -- generate --dir <this repo>`). Do
not use raw `rg`, file globbing, or direct file reads as the first retrieval step — use the wiki MCP tools
(`search`, `generate`, `lint`), or the CLI fallback, first. Do not parallelize implementation search with
the initial retrieval pass.

### Operating rules

- Wiki: prefer the `kb-wiki` MCP tools (`search`, `generate`, `lint`, `create`, `allocate-id`,
  `build-search-index`, `sync-contract`, `bootstrap`); CLI fallback `npm run wiki -- … --dir <this repo>`.
- Dispatch: prefer the `kb-dispatch` MCP tools or the kb CLI.
- Graph: kb CLI (`npm run graph -- --dir <this repo>`).
- Always pass `dir` pointing at this repository; run kb from its own checkout, not this repo root.
- Do not create `HO-*` via `wiki create` — handoffs are dispatch-owned under `wiki/handoffs/`.
- If wiki records and code/tests disagree, report the mismatch rather than trusting a grep-first conclusion.
````

## Notes for Agents

- If MCP is unavailable, fall back to the `kb` CLI for wiki operations too.
- If dispatch MCP is unavailable, fall back to the `kb` CLI for dispatch too.
- The `fake-agent` launcher written by `npm run dispatch -- init-config --force` is concrete and sister-repo safe.
- The wiki MCP server serves the `kb` repo but operates on the consuming repo through `dir`.
- If wiki records and code/tests disagree, report the mismatch explicitly instead of silently trusting grep-first conclusions.

## Maintainer Setup

Maintainers who track development in the project wiki:

```bash
git clone https://github.com/mcap91/kb.git
cd kb
git clone https://github.com/mcap91/kb-wiki.git wiki
npm install
```

The `wiki/` directory is gitignored. Changes to wiki records are committed and pushed from within `wiki/` (which has its own git repo).

### Day-to-day workflow

This repo uses a dual-commit model because the code (`kb`) and the wiki (`kb-wiki`) are separate git repositories that share a directory tree:

- **Code changes** go to `kb` (public): stage, commit, and push from the repo root as normal.
- **Wiki changes** go to `kb-wiki` (private): `cd wiki && git add . && git commit && git push`.
- Both can change in the same session — just commit to each repo separately before pushing.

The `/close_up` Claude Code skill automates this entire flow: it runs typecheck, lint, regenerates wiki views, then commits and pushes both repos. Use it at the end of any session that touched code or wiki files.

For testing consumer-repo workflows (bootstrap, dispatch, handoffs, PLN), use the **`test_kb`** fixture at `../test_kb` — a separate **private** repo (`github.com/mcap91/test_kb`). All `kb` commands target it via `--dir ../test_kb`. If it is missing, recreate it with `npm run setup:test-kb`. It is a sibling repo, so it is not cloned with `kb`; create or clone it separately. See [docs/test-kb.md](docs/test-kb.md).

**Note:** `git clean -fdx` (single `-f`) is safe — git protects the nested `wiki/` repo. Never use `git clean -ffdx` (double `-f`), which overrides that protection and deletes `wiki/`.

## License

[MIT](LICENSE)

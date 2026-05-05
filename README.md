# kb

`kb` is an agent-facing toolkit for adopting and operating a structured repo-local wiki, reviewed multi-agent dispatch, and deterministic code-first graph extraction in a separate consuming repository.

This repository is the **tooling repo**. The other repository is the **consuming repo**. `kb` runs from its own checkout and targets the consuming repo via `--dir`.

## What Agents Should Do

Use this model:

- Run the **wiki MCP server** from the `kb` repo.
- Use **MCP for wiki operations**: `bootstrap`, `sync-contract`, `allocate-id`, `create`, `lint`, `generate`, `build-search-index`, `search`.
- Use the **CLI from the `kb` repo** for `dispatch` and `graph`.
- Always target the consuming repo explicitly with `dir`.

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

## Install Modes

There are two normal ways to use `kb` as a private sister repo.

### Mode 1: Local Sibling Repo

Use this when:

- you already have `kb` checked out locally
- you are working across your own local repos
- the same GitHub identity already has access to both repos

Layout:

```text
projects/
  kb/
  my-project/
```

In this mode, just use the existing `kb` checkout directly.

### Mode 2: Private Collaborator Access

Use this when:

- `kb` is private
- the consuming repo is private
- you are accessing `kb` from a different GitHub account
- that account is added as a collaborator to the private `kb` repo

Flow:

1. Add the other GitHub account as a collaborator on the private `kb` repo.
2. Accept the invitation from that account.
3. Clone `kb` locally from that account.
4. Keep using `kb` as a sibling repo next to the consuming repo.

Example:

```bash
git clone git@github.com:<kb-owner>/kb.git
git clone git@github.com:<client-owner>/my-project.git
```

Local layout stays the same:

```text
projects/
  kb/
  my-project/
```

If you are the one operating both accounts on the same machine and Git auth is already set up, this is enough. You can clone the private `kb` repo and update it later with normal Git commands.

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

The MCP server runs in the **`kb` repo**, not in the consuming repo.

That means:

- start `npm run wiki:mcp` from `kb`
- connect your agent/client to that MCP server
- every wiki tool call must include `dir` pointing at the consuming repo
- you do **not** run a separate `kb` MCP server inside each consuming repo

One `kb` wiki MCP server can target different consuming repos because the target repo is provided per tool call through `dir`.

Current boundary:

- `wiki` is on MCP
- `dispatch` is CLI-only
- `graph` is CLI-only

## Start the Wiki MCP Server

From the `kb` repo:

```bash
npm run wiki:mcp
```

If your agent runtime supports MCP, point it at that command in the `kb` repo.

## Update a Private `kb` Checkout

If you cloned `kb` through collaborator access, updates are normal Git updates:

```bash
cd kb
git pull
npm install
npm run typecheck
npm test
```

If you remove collaborator access later, that stops future GitHub access to the repo. It does not remove any local clone that already exists.

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
# create a handoff from the template in the consuming repo
cp ../my-project/wiki/templates/handoff.md ../my-project/wiki/handoffs/HO-0001.md

# review the handoff
npm run dispatch -- review --dir ../my-project --handoff wiki/handoffs/HO-0001.md --agent fake-agent --reviewed-and-accept-risks

# launch the reviewed handoff
npm run dispatch -- launch --review-id RV-<uuid> --dir ../my-project

# inspect dispatch state
npm run dispatch -- status --dir ../my-project

# clean stale runtime state
npm run dispatch -- cleanup --dir ../my-project
```

Notes:

- `HO-*` handoffs are dispatch-owned
- do not try to create `HO-*` via `wiki create`
- launch always runs with `cwd = repo_root`

### Graph

Run from the `kb` repo:

```bash
npm run graph -- --dir ../my-project
```

Outputs in the consuming repo:

- `wiki/.graph.json`
- `wiki/graph-summary.md`

## Update / Deploy kb Into an Existing Consuming Repo

When `kb` changes and you need to roll the update into an existing consuming repo, run from the `kb` repo:

```bash
git pull
npm install
npm run typecheck
npm test
npm run wiki -- sync-contract --dir ../my-project
npm run wiki -- lint --dir ../my-project
npm run wiki -- generate --dir ../my-project
npm run wiki -- build-search-index --dir ../my-project
npm run graph -- --dir ../my-project
```

If the consuming repo uses dispatch:

```bash
npm run dispatch -- status --dir ../my-project
```

If you changed agent launcher config intentionally:

- re-review pending handoffs before launching them, because registry hash changes invalidate prior review tokens

## Paste-Ready `AGENTS.md` Snippet for a Consuming Repo

Paste this into the consuming repo's `AGENTS.md`:

Replace these two placeholders once after pasting:

- `<owner/name>`
- `../<this-repo-name>`

```md
# kb Integration

This repository uses the `kb` toolkit from `../kb`.

Assumptions:

- this repo is the consuming repo
- the `kb` repo lives at `../kb`
- all `kb` commands are run from `../kb`
- this repo is targeted via `dir`

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

When you need dispatch or graph operations, use the `kb` CLI from `../kb`.

Do not run `kb` commands from this repo root unless explicitly instructed. Run them from `../kb` and point back to this repo with `--dir`.

## First-Time Setup

If `../kb` dependencies are not installed:

```bash
cd ../kb
npm install
npm run typecheck
npm test
```

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

Examples:

```bash
cd ../kb
npm run wiki -- sync-contract --dir ../<this-repo-name>
npm run wiki -- lint --dir ../<this-repo-name>
npm run wiki -- generate --dir ../<this-repo-name>
npm run wiki -- build-search-index --dir ../<this-repo-name>
npm run graph -- --dir ../<this-repo-name>
```

## Rules

- Prefer MCP over CLI for wiki operations.
- Use CLI for `dispatch` and `graph`.
- Do not create `HO-*` via `wiki create`.
- `wiki/handoffs/` is dispatch-owned and excluded from wiki scanning operations.
- Always keep `kb` validation green before relying on it:

```bash
cd ../kb
npm run typecheck
npm test
```
```

## Paste-Ready `CLAUDE.md` Snippet for a Consuming Repo

Paste this into the consuming repo's `CLAUDE.md`:

Replace these two placeholders once after pasting:

- `<owner/name>`
- `../<this-repo-name>`

```md
# kb Integration

This repo is managed with the `kb` toolkit from `../kb`.

Use this operating model:

- run the `kb` wiki MCP server from `../kb`
- use MCP for wiki operations against this repo
- use `../kb` CLI for dispatch and graph
- target this repo explicitly with `dir`

## Commands

Install or update `kb`:

```bash
cd ../kb
npm install
npm run typecheck
npm test
```

Bootstrap this repo:

```bash
cd ../kb
npm run wiki -- bootstrap --dir ../<this-repo-name> --repo <owner/name>
npm run dispatch -- init-config
npm run wiki -- generate --dir ../<this-repo-name>
npm run wiki -- build-search-index --dir ../<this-repo-name>
npm run graph -- --dir ../<this-repo-name>
```

Update this repo after `kb` changes:

```bash
cd ../kb
git pull
npm install
npm run typecheck
npm test
npm run wiki -- sync-contract --dir ../<this-repo-name>
npm run wiki -- lint --dir ../<this-repo-name>
npm run wiki -- generate --dir ../<this-repo-name>
npm run wiki -- build-search-index --dir ../<this-repo-name>
npm run graph -- --dir ../<this-repo-name>
```

## Rules

- Prefer `kb` MCP for wiki operations.
- Use `kb` CLI for `dispatch` and `graph`.
- Do not create `HO-*` with `wiki create`.
- Run `kb` from `../kb`, not from this repo root.
```

## Notes for Agents

- If MCP is unavailable, fall back to the `kb` CLI for wiki operations too.
- The `fake-agent` launcher written by `npm run dispatch -- init-config` is concrete and sister-repo safe.
- The wiki MCP server serves the `kb` repo but operates on the consuming repo through `dir`.

# Upgrading an Existing Consuming Repo

Use this runbook when:

- `kb` has already been adopted in a consuming repo
- you are pulling a newer `kb` checkout
- the consuming repo needs the new HO lifecycle and reviewed-bundle launcher flow

This guide is for upgrades, not first-time bootstrap.

## What Changes in This Upgrade

This upgrade adds the HO workflow as a first-class dispatch surface:

- `dispatch create-handoff` writes durable `wiki/handoffs/HO-XXXX.md` files
- `dispatch review` snapshots reviewed inputs into `.agent-runs/reviews/RV-.../agent-visible/` and `.agent-runs/reviews/RV-.../metadata/`
- `dispatch launch` runs the agent from the reviewed `agent-visible/` bundle
- `dispatch review-and-launch` provides a single-step operator path
- `dispatch:mcp` exposes the dispatch lifecycle to interactive agents

It also changes the operator registry format in `launchers.v1.json`.

## Upgrade Checklist

Run all commands from the `kb` repo.

### 1. Update the `kb` Checkout

```bash
git pull
npm install
npm run typecheck
npm test
```

### 2. Sync the Consuming Repo Surface

```bash
npm run wiki -- sync-contract --dir ../my-project
npm run wiki -- lint --dir ../my-project
npm run wiki -- generate --dir ../my-project
npm run wiki -- build-search-index --dir ../my-project
npm run graph -- --dir ../my-project
```

This updates shared wiki templates and regenerated artifacts. It does not update the consuming repo's `AGENTS.md` or `CLAUDE.md`.

### 3. Rewrite the Operator Dispatch Registry

```bash
npm run dispatch -- init-config --force
```

This step is required for upgrades from the older dispatch registry shape.

Why it matters:

- `launchers.v1.json` is operator-owned
- `init-config` does not overwrite it by default
- the new launcher flow expects the adapter-based registry written by `init-config --force`

After rewriting the registry, any previously reviewed pending handoffs should be re-reviewed before launch because the registry hash has changed.

### 4. Update the Consuming Repo Agent Instructions

Update the consuming repo's `AGENTS.md` and `CLAUDE.md` using the paste-ready snippets in [README.md](../README.md).

The important changes are:

- wiki operations can still use `wiki:mcp`
- dispatch can now use `dispatch:mcp` or CLI
- agents should use `create-handoff`, `review`, `launch`, and `review-and-launch`
- `HO-*` remains dispatch-owned and is still excluded from wiki scanning

This step is manual. `sync-contract` does not touch agent instruction files.

### 5. Wire MCP in the Agent Client

If you want interactive agent workflows like "create an HO and send it to Codex," follow the agent-native setup in [README.md](../README.md#agent-native-mcp-setup).

```bash
claude mcp list
codex mcp list
```

Do not point strict stdio clients at `npm run wiki:mcp` or `npm run dispatch:mcp`; use the direct `node` commands or native client registration shown in the README.

If dispatch MCP is not configured, the workflow can still run through the `dispatch` CLI, but the agent will need shell access rather than MCP tools.

### 6. Check Current Dispatch State

```bash
npm run dispatch -- status --dir ../my-project
```

If the repo already has in-flight handoffs:

- re-review any pending handoffs after `init-config --force`
- expect old review tokens to be invalid if the registry changed

If Codex on that host fails before reading the handoff with a `bwrap` / bubblewrap sandbox error, treat that as a host/runtime problem. The supported path is to use Claude on that host or run Codex on a different host. `kb` does not ship a weaker-permission fallback profile by default.

### 7. Smoke Test the New Flow

Create a small handoff:

```bash
npm run dispatch -- create-handoff --dir ../my-project --title "Dispatch smoke test" --subject "Dispatch validation" --allowed-agents fake-agent --mode implement --read-first AGENTS.md --objective "Verify that reviewed-bundle launch works end to end." --expected-output "A short response confirming the handoff was read."
```

Then launch it with the path printed by `create-handoff`:

```bash
npm run dispatch -- review-and-launch --dir ../my-project --handoff wiki/handoffs/HO-XXXX.md --agent fake-agent --reviewed-and-accept-risks
```

Expected results:

- a durable handoff exists at `wiki/handoffs/HO-XXXX.md`
- a reviewed bundle exists under `.agent-runs/reviews/RV-.../`
- a run exists under `.agent-runs/runs/HO-XXXX/RUN-.../`
- the run contains `response.md`

## Common Gotchas

- Pulling `kb` is not enough. The consuming repo's `AGENTS.md` and `CLAUDE.md` still need to be updated separately.
- `sync-contract` updates wiki templates and shared surfaces, not agent instruction files.
- `init-config` without `--force` will usually leave an older registry file in place.
- Changing the registry invalidates previously reviewed launch tokens.
- `wiki create` still does not create `HO-*`; that remains dispatch-owned by design.

## Minimum Upgrade Command Set

If you only want the shortest safe sequence:

```bash
cd ../kb
git pull
npm install
npm run typecheck
npm test
npm run wiki -- sync-contract --dir ../my-project
npm run dispatch -- init-config --force
```

Then update the consuming repo's `AGENTS.md` / `CLAUDE.md` and configure `dispatch:mcp` if you want the interactive MCP workflow.

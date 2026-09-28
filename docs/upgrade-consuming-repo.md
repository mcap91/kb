# Upgrading an Existing Consuming Repo

Use this runbook when a repo already adopted `kb` and you pull a newer `kb` checkout.

This is not the first-time bootstrap path. For existing repos, `sync-contract` is the safe upgrade
command: it syncs templates, ensures required wiki directories exist, and merges missing allocator
entries into `wiki/.id-state.json` without resetting existing IDs.

## Short Version

Run from the `kb` checkout:

```bash
git pull
npm install
npm run typecheck
npm test
npm run wiki -- install-roles
npm run wiki -- sync-contract --dir /path/to/consuming-repo
npm run wiki -- lint --dir /path/to/consuming-repo
npm run wiki -- generate --dir /path/to/consuming-repo
```

After that, the consuming repo can use newly added wiki surfaces such as `PLN-*`. If the repo also uses
dispatch, see "Dispatch Config Tables" below.

## What `sync-contract` Upgrades

`sync-contract` now handles repo-local contract drift that is safe to update automatically:

- creates missing required wiki directories such as `wiki/plans/`
- syncs record templates such as `wiki/templates/plan.md`
- preserves existing `wiki/.id-state.json` counters and allocations
- adds missing allocator entries such as `PLN`
- updates `wiki/.wiki-contract.json` with the current contract version and `lastSyncedAt`
- reports drift in consumer-owned bootstrap docs without overwriting them
- refreshes the managed block in `AGENTS.md` and `CLAUDE.md` (between `<!-- BEGIN kb-managed -->` / `<!-- END kb-managed -->` markers; content outside the markers is never touched)
- merges `kb-wiki` and `kb-dispatch` entries into `.mcp.json` (Claude), preserving existing servers

Note: `wiki/conventions.md` stays consumer-owned (not rewritten by sync), but the `AGENTS.md`/`CLAUDE.md` managed block is now authoritative for retrieval instructions.

It does not update:

- project-specific docs
- repo-local dispatch config tables (`wiki/.dispatch/models.json`, `backends.json`, `profiles.json` — see "Dispatch Config Tables" below)

## Bootstrap Versus Upgrade

Use `bootstrap` for first-time adoption:

```bash
npm run wiki -- bootstrap --dir /path/to/new-repo --repo org/name
```

For an existing consuming repo, use `sync-contract` instead:

```bash
npm run wiki -- sync-contract --dir /path/to/consuming-repo
```

`bootstrap` is idempotent and no longer resets existing `.id-state.json`, but `sync-contract` is the
intended upgrade command because it updates templates and records `lastSyncedAt`.

## Using PLN After Upgrade

After `sync-contract`, a consuming repo can create and import a plan:

```bash
npm run wiki -- create --dir /path/to/consuming-repo --prefix PLN --title "My implementation plan"

npm run wiki -- import-plan --dir /path/to/consuming-repo --plan PLN-0001 \
  --design docs/design.md \
  --execution docs/implementation-plan.md \
  --source-tool manual \
  --overwrite

npm run wiki -- validate-plan --dir /path/to/consuming-repo --plan PLN-0001
npm run wiki -- generate --dir /path/to/consuming-repo
```

Expected results:

- `wiki/plans/PLN-0001.md`
- `wiki/plans/PLN-0001/bundle.json`
- `wiki/plans/PLN-0001/design/spec.md`
- `wiki/plans/PLN-0001/execution/tracker.md`
- preserved raw source artifacts under `wiki/plans/PLN-0001/source/raw/`

## Dispatch Config Tables (`init-dispatch`)

v2 dispatch config is repo-local under `wiki/.dispatch/` (`models.json`, `backends.json`,
`profiles.json`, plus a write-once `README.md`) — there is no user-global dispatch registry.

Scaffold a consuming repo's tables by calling the `init-dispatch` MCP tool (`kb-dispatch` server) or the
CLI subcommand (`npm run dispatch -- init-dispatch --dir /path/to/consuming-repo`), both pointed at the
consuming repo path. Every file, including the README, is written only if absent — a re-run never
overwrites existing content.

**Removed: `init-config`.** The old user-global dispatch config layer (`init-config`,
`~/.config/kb-dispatch/token.key`, `~/.config/kb-dispatch/launchers.v1.json`) is retired (WK-0133
ruling 1, executed in WK-0134). `~/.config/kb-dispatch/` is no longer a kb concept. Credential secrets
are operator-owned files at any path; a repo's `wiki/.dispatch/profiles.json` names them — kb verifies
they exist, never writes them.

## Role Preambles (`install-roles`)

`contract/roles/*.md` are the canonical orchestrator/planner role preambles. Stamp them into the
user-global command directories both Claude Code and Codex read from:

```bash
npm run wiki -- install-roles
```

Run this from the `kb` checkout (the default `--dir` is cwd, read from `<dir>/contract/roles/`). It
copies each file to `~/.claude/commands/<file>` and `~/.codex/prompts/<file>` as a whole-file,
idempotent overwrite — safe to re-run after every `git pull`.

## MCP Client Setup

If the consuming repo uses native MCP clients, verify the client registration still points to the
chosen `kb` checkout:

```bash
claude mcp list
codex mcp list
```

For strict stdio clients, use direct `node --import ... server.ts` registrations instead of
`npm run wiki:mcp` or `npm run dispatch:mcp`.

## Common Gotchas

- Pulling `kb` is not enough; run `sync-contract` for each consuming repo.
- Do not run `bootstrap` as the normal upgrade step.
- `sync-contract` now refreshes the managed block in `AGENTS.md`/`CLAUDE.md` and merges `.mcp.json`. Content outside the `<!-- BEGIN kb-managed -->` / `<!-- END kb-managed -->` markers is never touched.
- `wiki create` does not create `HO-*`; handoffs remain dispatch-owned.
- If `sync-contract --check` reports `wiki/.id-state.json`, it means a new prefix will be merged in
  normal mode without resetting existing allocations.
- Use `--mcp-client codex` to get `codex mcp add` commands instead of writing `.mcp.json`.
- Use `--no-agent-instructions` to skip the managed block entirely.
- `derive-review`, `merge-delivery`, and `stop-run` are MCP-only today — `dispatch-cli` does not expose
  them as subcommands. Use the corresponding `kb-dispatch` MCP tool.

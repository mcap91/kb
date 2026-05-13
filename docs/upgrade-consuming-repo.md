# Upgrading an Existing Consuming Repo

Use this runbook when a repo already adopted `kb` and you pull a newer `kb` checkout.

This is not the first-time bootstrap path. For existing repos, `sync-contract` is the safe upgrade
command: it syncs templates, ensures required wiki directories exist, and merges missing allocator
entries into `wiki/.id-state.json` without resetting existing IDs.

On Windows PowerShell, prefer `npm.cmd` if execution policy blocks `npm.ps1`.

## Short Version

Run from the `kb` checkout:

```powershell
git pull
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run wiki -- sync-contract --dir C:\path\to\consuming-repo
npm.cmd run wiki -- lint --dir C:\path\to\consuming-repo
npm.cmd run wiki -- generate --dir C:\path\to\consuming-repo
```

After that, the consuming repo can use newly added wiki surfaces such as `PLN-*`.

## What `sync-contract` Upgrades

`sync-contract` now handles repo-local contract drift that is safe to update automatically:

- creates missing required wiki directories such as `wiki/plans/`
- syncs record templates such as `wiki/templates/plan.md`
- preserves existing `wiki/.id-state.json` counters and allocations
- adds missing allocator entries such as `PLN`
- updates `wiki/.wiki-contract.json` with the current contract version and `lastSyncedAt`
- reports drift in consumer-owned bootstrap docs without overwriting them

It does not update:

- `AGENTS.md`
- `CLAUDE.md`
- project-specific docs
- operator dispatch registry files

## Bootstrap Versus Upgrade

Use `bootstrap` for first-time adoption:

```powershell
npm.cmd run wiki -- bootstrap --dir C:\path\to\new-repo --repo org/name
```

For an existing consuming repo, use `sync-contract` instead:

```powershell
npm.cmd run wiki -- sync-contract --dir C:\path\to\consuming-repo
```

`bootstrap` is idempotent and no longer resets existing `.id-state.json`, but `sync-contract` is the
intended upgrade command because it updates templates and records `lastSyncedAt`.

## Using PLN After Upgrade

After `sync-contract`, a consuming repo can create and import a plan:

```powershell
npm.cmd run wiki -- create --dir C:\path\to\consuming-repo --prefix PLN --title "My implementation plan"

npm.cmd run wiki -- import-plan --dir C:\path\to\consuming-repo --plan PLN-0001 `
  --design docs\design.md `
  --execution docs\implementation-plan.md `
  --source-tool manual `
  --overwrite

npm.cmd run wiki -- validate-plan --dir C:\path\to\consuming-repo --plan PLN-0001
npm.cmd run wiki -- generate --dir C:\path\to\consuming-repo
```

Expected results:

- `wiki/plans/PLN-0001.md`
- `wiki/plans/PLN-0001/bundle.json`
- `wiki/plans/PLN-0001/design/spec.md`
- `wiki/plans/PLN-0001/execution/tracker.md`
- preserved raw source artifacts under `wiki/plans/PLN-0001/source/raw/`

## Dispatch Registry Upgrades

Some dispatch upgrades require rewriting the operator-owned launcher registry:

```powershell
npm.cmd run dispatch -- init-config --force
```

Only do this when the release notes or work item calls for a registry shape change. Rewriting the
registry can invalidate previously reviewed launch tokens because the registry hash changes.

## MCP Client Setup

If the consuming repo uses native MCP clients, verify the client registration still points to the
chosen `kb` checkout:

```powershell
claude.cmd mcp list
codex.cmd mcp list
```

For strict stdio clients, use direct `node --import ... server.ts` registrations instead of
`npm run wiki:mcp` or `npm run dispatch:mcp`.

## Common Gotchas

- Pulling `kb` is not enough; run `sync-contract` for each consuming repo.
- Do not run `bootstrap` as the normal upgrade step.
- `sync-contract` does not edit `AGENTS.md` or `CLAUDE.md`.
- `wiki create` does not create `HO-*`; handoffs remain dispatch-owned.
- If `sync-contract --check` reports `wiki/.id-state.json`, it means a new prefix will be merged in
  normal mode without resetting existing allocations.

# Upgrading an Existing Consuming Repo

Use this runbook when a repo already adopted `kb` and you pull a newer `kb` checkout.

This is not the first-time bootstrap path. For existing repos, `sync-contract` is the safe upgrade
command: it syncs templates, ensures required wiki directories exist, and merges missing allocator
entries into `wiki/.id-state.json` without resetting existing IDs.

## Short Version

Run from the `kb` checkout:

```bash
git pull
npm ci
npm run typecheck
npm test
npm run wiki -- install-roles
npm run wiki -- sync-contract --dir /path/to/consuming-repo
npm run wiki -- lint --dir /path/to/consuming-repo
npm run wiki -- generate --dir /path/to/consuming-repo
```

Before the first sync after the install-layer change (WK-0261), read "Migrating to install layers"
below. If the repo also uses dispatch, see "Dispatch Config Tables" below.

## Migrating to install layers

kb ships three install layers: wiki, planning, and dispatch ([adoption.md](./adoption.md)). Each sync
writes the surfaces of the repo's active layers and removes kb-owned surfaces of inactive ones. Nothing
changes in a repo until you run `sync-contract` there.

- **A dispatch repo** (it has `wiki/.dispatch/`) keeps everything it has today: dispatch implies
  planning. Sync removes only the templates no layer ships (`chain-doc.md`, `plan.md`,
  `plan-execution-tracker.md`, `value.md`).
- **A wiki-only repo that should keep the planning surfaces** (engineering rules, `/resolve`, the
  escalation template): run `init-planning` once before the next sync, and commit
  `wiki/.wiki-contract.json`:

  ```bash
  npm run wiki -- init-planning --dir /path/to/consuming-repo
  npm run wiki -- sync-contract --dir /path/to/consuming-repo
  ```

- **A wiki-only repo that wants the wiki layer only:** run `sync-contract`. It removes the planning and
  dispatch surfaces and lists each one under `Removed:`.

What the removal pass touches:

- It deletes a kb template or skill file only when its content still matches the kb source (line
  endings ignored). A file you edited stays, and sync prints a warning for it.
- It never deletes record directories (`wiki/plans/`, `wiki/value-reports/`, `wiki/handoffs/`) or the
  records in them, any file kb did not ship, or text outside the managed-block markers.
- It never reads, writes, or deletes anything in `wiki/.dispatch/`.

The bootstrap docs (`wiki/schema.md`, `wiki/conventions.md`, `wiki/index.md`) are yours after bootstrap,
and sync never rewrites them. Sync reports old PLN, VAL, and dispatch text in them as `drift`. To take
the current kb text for one doc, review the drift, then adopt it:

```bash
npm run wiki -- sync-contract --dir /path/to/consuming-repo --check
npm run wiki -- sync-contract --dir /path/to/consuming-repo --adopt schema.md
```

`--adopt` overwrites that one doc with the kb text for your repo's layers. Copy any of your own edits
back in after.

## Rules: what the block carries, what the repo owns

The managed block carries the kb-wiki section always. The engineering rules and the roles footer
appear while the planning layer is active (`init-planning`, or `wiki/.dispatch/` present). The
kb-dispatch section appears on the next sync after `init-dispatch` has created `wiki/.dispatch/` —
removing that directory removes the section (and the `.mcp.json` `kb-dispatch` entry) on the next sync.

The block has a 4,000-word budget (WK-0229 ruling 16), measured between the `<!-- BEGIN kb-managed -->` /
`<!-- END kb-managed -->` markers. `sync-contract` and `bootstrap` refuse — and write nothing — when the
assembled block would exceed it.

The repo's own rules, its environment registry, and its where-code-goes map live outside the markers, in
the repo's own `AGENTS.md`/`CLAUDE.md` content. kb never reads or writes that text.

## What `sync-contract` Upgrades

`sync-contract` now handles repo-local contract drift that is safe to update automatically:

- creates missing wiki directories of the active layers (`wiki/handoffs/` only with dispatch)
- syncs the record templates of the active layers, and removes unedited kb templates of inactive
  layers (see "Migrating to install layers" above)
- with the planning layer active, copies every `contract/skills/<name>/` folder into
  `.claude/skills/<name>/` and `.agents/skills/<name>/`, whole-file overwrite (same pattern as record
  templates — see "Skill Delivery" below)
- preserves existing `wiki/.id-state.json` counters and allocations
- adds missing allocator entries
- updates `wiki/.wiki-contract.json` with the current contract version and `lastSyncedAt`
- reports drift in consumer-owned bootstrap docs without overwriting them
- refreshes the managed block in `AGENTS.md` and `CLAUDE.md` (between `<!-- BEGIN kb-managed -->` / `<!-- END kb-managed -->` markers; content outside the markers is never touched)
- merges `kb-wiki` into `.mcp.json` (Claude) always, preserving existing servers; merges `kb-dispatch` only
  when `wiki/.dispatch/` exists, and removes it if that directory is absent

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

`contract/roles/*.md` are the canonical orchestrator/planner/overseer role preambles. Stamp them into the
user-global command directories both Claude Code and Codex read from:

```bash
npm run wiki -- install-roles
```

Run this from the `kb` checkout (the default `--dir` is cwd, read from `<dir>/contract/roles/`). It
copies each file to `~/.claude/commands/<file>` and `~/.codex/prompts/<file>` as a whole-file,
idempotent overwrite — safe to re-run after every `git pull`.

## Skill Delivery (`.claude/skills/`, `.agents/skills/`)

Every folder under `contract/skills/<name>/` (e.g. `resolve`) ships into the consuming repo at two
target paths — Claude Code reads `.claude/skills/<name>/` and Codex reads `.agents/skills/<name>/`.
Skills ship with the planning layer only ([install-planning.md](./install-planning.md)).
`bootstrap` writes them once (write-if-absent, like record templates on first-time adoption);
`sync-contract` overwrites them on drift on every run, byte-identical to the `contract/skills/`
source, and removes them when the planning layer is off. Both repo copies are managed by kb and should
be committed, the same as `wiki/templates/` — commit them so your team gets them too. Delivery never
depends on `--no-agent-instructions`.

There is no user-global skill install — `install-roles` installs roles only. `sync-contract` warns
(and changes nothing under `$HOME`) in two cases:

- a user-global role copy (`~/.claude/commands/<role>.md` or `~/.codex/prompts/<role>.md`) differs
  from its `contract/roles/<role>.md` source: remedy — run `install-roles` from your kb checkout.
- a user-global skill of the same name exists (`~/.claude/skills/<name>` or
  `~/.agents/skills/<name>`): it shadows (Claude) or duplicates (Codex) the repo copy — remedy:
  remove it. Claude resolves a same-name duplicate "Enterprise over personal, and personal over
  project", so a stale personal copy silently hides the fresh repo copy; Codex shows both in its
  skill selectors instead of merging them.

Both warnings print under a `Warnings: <n>` count line in the CLI output; they never change the
command's exit code.

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
- `sync-contract` now refreshes the managed block in `AGENTS.md`/`CLAUDE.md` and merges `.mcp.json`. Content outside the `<!-- BEGIN kb-managed -->` / `<!-- END kb-managed -->` markers is never touched. `kb-dispatch` (block section and `.mcp.json` entry) only appears once `wiki/.dispatch/` exists.
- `wiki create` does not create `HO-*`; handoffs remain dispatch-owned.
- If `sync-contract --check` reports `wiki/.id-state.json`, it means a new prefix will be merged in
  normal mode without resetting existing allocations.
- Use `--mcp-client codex` to get `codex mcp add` commands instead of writing `.mcp.json`.
- Use `--no-agent-instructions` to skip the managed block entirely.
- `derive-review`, `merge-delivery`, and `stop-run` are MCP-only today — `dispatch-cli` does not expose
  them as subcommands. Use the corresponding `kb-dispatch` MCP tool.

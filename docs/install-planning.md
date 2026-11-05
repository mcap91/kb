# Install the Planning Layer

The planning layer adds kb's planning machinery to a repo that already has the wiki layer
([adoption.md](./adoption.md)):

- the engineering rules and the roles footer in the managed block of `AGENTS.md`/`CLAUDE.md`
- the `/resolve` skill, in `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex)
- the escalation template, `wiki/templates/escalation.md`

Run the commands from the `kb` checkout, with `MY_REPO` set to your repo's absolute path.

## Install

<!-- install-smoke: planning -->
```bash
npm run wiki -- init-planning --dir "$MY_REPO"
npm run wiki -- sync-contract --dir "$MY_REPO"
```

`init-planning` adds `"planning"` to the `layers` field of `wiki/.wiki-contract.json`. Commit that file:
the field is what keeps the layer on. `sync-contract` then writes the planning surfaces and prints each
path. For a Codex repo, add `--mcp-client codex` to the `sync-contract` command.

Both commands are idempotent. A second run reports no change.

## Remove

<!-- install-smoke: planning-remove -->
```bash
npm run wiki -- init-planning --dir "$MY_REPO" --remove
npm run wiki -- sync-contract --dir "$MY_REPO"
```

Sync removes each planning surface and lists it under `Removed:`. It deletes a file only when the file
still matches the kb source. A file you edited stays in place, and sync prints a warning for it.

A repo with the dispatch layer always keeps the planning layer: dispatch implies planning. To drop both,
remove dispatch first ([install-dispatch.md](./install-dispatch.md#remove)).

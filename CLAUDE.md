# Claude Operating Guide

<!-- BEGIN kb-managed -->
Managed by kb — edits inside this block are overwritten by `kb bootstrap` / `kb sync-contract`; edit outside the markers.

@AGENTS.md
<!-- END kb-managed -->

This file is the compatibility entrypoint for Claude Code sessions. The full agent operating guide is in `AGENTS.md` -- read that first.

## Quick Reference

### Validation (run before declaring any work complete)

```
npm run typecheck && npm test
```

### Key Commands

```
npm run wiki -- <command> --dir <path>     Wiki operations
npm run dispatch -- <command>              Dispatch operations
npm run graph -- --dir <path>              Graph extraction
npm test                                   All tests
npm run typecheck                          Type checking
```

### Key Invariants

- `HO-*` is dispatch-owned, not a wiki record type. `wiki create` rejects `HO`.
- `wiki/handoffs/` is excluded from lint, generate, search, and graph.
- Graph is deterministic and file/module level only. No semantic inference.
- All public functions return Result types. Do not throw.
- Agent processes spawn with `cwd = agent-visible` inside the reviewed run bundle. The agent never controls its working directory.
- Import `@kb/wiki-core` from wiki-cli and wiki-mcp. Import `@kb/dispatch-core` from dispatch-cli. Import `@kb/dispatch-core` from dispatch-mcp. No cross-subsystem imports, with ONE ratified one-way exception (DEC-0007): dispatch-core may import wiki-core's record primitives; wiki-core must never import from dispatch-core.

### Monorepo Structure

Seven packages under `packages/`: `wiki-core`, `wiki-cli`, `wiki-mcp`, `dispatch-core`, `dispatch-cli`, `dispatch-mcp`, `graph-explore`.

Contract lives in `contract/` with `manifest.json` as the source of truth for record types.

### Subagents

Subagents default to Sonnet via `CLAUDE_CODE_SUBAGENT_MODEL` in `.claude/settings.json`. Pass `model: "opus"` on individual Agent calls only when the subagent needs complex reasoning or a Sonnet attempt produced inadequate results.

### Do Not

- Modify files under `scratch_space/`
- Add HO to the manifest
- Include `wiki/handoffs/` in wiki scanning operations
- Add semantic/heuristic graph features
- Throw from public API functions
- Import across subsystem boundaries (sole exception: the DEC-0007 one-way dispatch-core→wiki-core record-primitive import)

# Agent Operating Guide

<!-- BEGIN kb-managed -->
Managed by kb — edits inside this block are overwritten by `kb bootstrap` / `kb sync-contract`; edit outside the markers.

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
- `allocate-id` is an idempotent **peek/reserve**, not a counter: repeat calls return the same id until
  `create` writes the record that claims it. Do not loop it expecting increments — call `create` to claim
  an id (it allocates and writes the record atomically). Repeated identical ids are correct, not a bug.
- Dispatch: prefer the `kb-dispatch` MCP tools or the kb CLI.
- Graph: kb CLI (`npm run graph -- --dir <this repo>`).
- Always pass `dir` pointing at this repository; run kb from its own checkout, not this repo root.
- Do not create `HO-*` via `wiki create` — handoffs are dispatch-owned under `wiki/handoffs/`.
- If wiki records and code/tests disagree, report the mismatch rather than trusting a grep-first conclusion.

### Value reports (value-report-recipe-v3)

**What VAL is.** An append-only ROI closeout over a commit-watermark span: what a span of agent work cost (tokens/$) vs. what its surviving output would cost the operator to replicate by hand (DEC-0003: replication cost — NOT a claim about what would have happened without AI). Not a work-log, not a milestone gate; never edit a VAL — append the next one. Operator-initiated: agents run the recipe when asked, never self-initiate. Design: one deploy surface (this managed block; deliberately no skill — rationale in kb WK-0033).

**Cadence is the operator's.** Each VAL auto-advances the watermark from the prior VAL's `head_commit` to HEAD; the chain tiles commits with no gap or overlap. Daily and weekly both work; a VAL today never blocks tomorrow's. With no prior VAL, the first report covers repo history from the first commit — scope with `--since`.

**Scope is a commit range, not a feature.** The report sweeps every commit in the span and every surviving file; WK ids are scraped from commit messages as references only. Cost is time-windowed per repo — tokens cannot be split between interleaved features after the fact. For a clean per-feature ROI, finish the feature and cut the VAL at its boundary (`--until-ref`) before the next feature's commits land; interleaved features report together as one span.

When the operator asks for a value report:

0. Refresh the graph: `npm run graph -- --dir <repo>` (regenerates `wiki/.graph.json`).
1. Run `value-report` (MCP tool) or `npm run wiki -- value-report --dir <repo>` (CLI fallback) to compute watermark, chain status, git metrics, unit evidence, candidates, and the unified review surface.
2. Run `value-usage` (MCP tool) or `npm run wiki -- value-usage --dir <repo> --since <window_start> --until <window_end>` using the dates from step 1.
3. Run `create --prefix VAL` to scaffold `wiki/value-reports/VAL-XXXX.md`.
4. Present the full `review_units[]` table to the operator — this single list is both the review surface and the estimate basis. For each row (path, unitClass, tier, wk_ids, net_loc, loc_reference), proposed_days = loc_reference (= net_loc / 260, the SRC-0002 corpus rate). Docs-class rows: no calibrated rate — flag for operator hand-set (WK-0052). Agent adjustments to proposals are downward-only with justification. Apply the tripwire: any row the agent or operator moves >3× from proposed_days (either direction) must state why. Also present the candidates list for confirm/reject. The agent NEVER confirms a candidate or self-attests a unit — operator-only gate.
5. After the operator ratifies (veto/adjust each row in one pass), fill the record per `wiki/templates/value.md`: tool-filled fields from step 1, scraped fields from step 2, ratified rows in ## How This Was Calculated. Compute replication_days = Σ ratified_days; saved_floor_days = replication_days − work_days (may be negative; never clamp); leverage = replication_days / work_days (uncapped; may be < 1; never clamp); cum_leverage = Σ replication_days / Σ work_days over published flat-formula VALs plus this one (body-only). work_hours is printed context, never in the arithmetic. Set units_valued = count of ratified rows. Nothing unratified reaches published frontmatter. If leverage < 1 or saved_floor_days < 0, the operator must add a reconciliation note in operator_notes before publishing (instrument misfit, or span dominated by non-authoring work — expected under floor semantics).
6. Print the ROI line: `shipped <units_valued> working units; agents cost $<cost_usd> (est. $<cost_usd_est> at API rates) / <total_tokens> tokens; replication value <replication_days> operator-days vs <work_days> days worked → leverage <leverage>× (floor); chain <cum_leverage>×`. If `cost_usd` is null (pure subscription-covered), render it as $0 out-of-pocket; the estimate carries the interpretable figure. Then print the ceiling reference line: `reference ceiling: COCOMO II nominal ≈ <cocomo_pm_nominal> person-months for <cocomo_kloc> KSLOC (frozen nominal constants, Boehm 2000)` — display-only; never in the arithmetic.

Rules: report every watermark span — never skip a poor one; null and negative results are stated plainly. Never edit a prior VAL record.

<!-- END kb-managed -->


This document is the primary reference for any agent session working in the `kb` repository. Read it before making changes.

## Project Summary

`kb` is a TypeScript monorepo toolkit providing three subsystems:

1. **Wiki** -- Structured repo-local wiki with manifest-driven record types (WK, IN, DEC, SRC, AREA, PLN, VAL). Operations: bootstrap, sync-contract, allocate-id, create, lint, generate, build-search-index, search, import-plan, validate-plan, archive-plan. Interfaces: CLI and MCP server.
2. **Dispatch Protocol** -- Reviewed multi-agent handoff workflow using HO-\* documents. Token-based state machine (review then launch). Platform-aware config. Deterministic fake-agent for testing.
3. **Graph Explore** -- Deterministic code-first graph extraction at file/module level. Wiki overlay from frontmatter. Produces JSON and markdown summary.

### Sister-Repo Model

`kb` lives in its own repository. It targets consuming repos via `--dir`. Operators run commands from inside `kb/` and point at the target repo:

```
npm run wiki -- bootstrap --dir ../my-project --repo org/name
npm run graph -- --dir ../my-project
```

### Agent-Native MCP Setup

If you are wiring `kb` into a native MCP client, use direct `node` launch commands rather than `npm run ...:mcp`.

- Claude: a project-scoped `.mcp.json` works.
- Codex: use `codex mcp add ...` native registration.
- Verify with `claude mcp list` and `codex mcp list`.
- For strict stdio clients, avoid `npm run wiki:mcp` and `npm run dispatch:mcp` because the npm wrapper writes to stdout before the MCP handshake.
- If the client does not preserve `cwd`, especially on Windows, use absolute `tsx` loader and server script paths.

When you are working in `kb` itself, this checkout can self-host its own MCP tools:

- Claude can use a local `.mcp.json` created from the template below
- Codex can be pointed at this checkout with `npm run codex:mcp:register`
- in that mode, `dir` should point back at this `kb` repo

This self-hosted setup does not replace the sister-repo model:

- a consuming repo needs its own Claude `.mcp.json` that points back to the chosen `kb` checkout
- Codex MCP registration is user-level and should point at one chosen `kb` checkout per machine

Claude `.mcp.json` example. Replace:

- `<TSX-LOADER-FILE-URL>` with a file URL to `node_modules/tsx/dist/loader.mjs`
- `<ABSOLUTE-PATH-TO-KB>` with the absolute path to this `kb` checkout, using forward slashes

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

Codex registration example. For this repo itself, prefer `npm run codex:mcp:register`.

Manual Codex registration example. Replace:

- `<TSX-LOADER-FILE-URL>` with a file URL to `node_modules/tsx/dist/loader.mjs`
- `<ABSOLUTE-PATH-TO-KB>` with the absolute path to this `kb` checkout, using forward slashes

```bash
codex mcp add kb-wiki -- node --import <TSX-LOADER-FILE-URL> <ABSOLUTE-PATH-TO-KB>/packages/wiki-mcp/src/server.ts
codex mcp add kb-dispatch -- node --import <TSX-LOADER-FILE-URL> <ABSOLUTE-PATH-TO-KB>/packages/dispatch-mcp/src/server.ts
codex mcp list
```

Windows note: if the client does not preserve `cwd`, prefer forward-slash absolute paths such as `C:/Users/you/projects/kb/...` so JSON and CLI arguments do not need escaped backslashes. In PowerShell, execution policy can block the `.ps1` shims for `npm`, `claude`, and `codex`; use `npm.cmd`, `claude.cmd`, and `codex.cmd` in that case. On Linux and macOS, use the normal command names.

## Core Architecture

### Monorepo Layout

```
kb/
  packages/
    wiki-core/       Core wiki operations (bootstrap, sync, allocate, create, lint, generate, search)
    wiki-cli/        CLI entry point for wiki commands
    wiki-mcp/        MCP server exposing wiki operations as tools
    dispatch-core/   Core dispatch operations (review, launch, cleanup, token management)
    dispatch-cli/    CLI entry point for dispatch commands
    dispatch-mcp/    MCP server exposing dispatch operations as tools
    graph-explore/   Deterministic code-first graph extraction
  contract/
    manifest.json    Record type definitions, field schemas, enum values
    templates/       Record templates (issue, initiative, decision, source, area, handoff)
    bootstrap/       Bootstrap surface docs (schema.md, conventions.md, index.md)
    schema.md        Contract schema reference
    conventions.md   Wiki conventions
    taxonomy.md      Record taxonomy
    query.md         Query patterns
    retrieval.md     Retrieval strategy
    lint.md          Lint rule reference
  tests/
    wiki-core.test.ts
    dispatch.test.ts
    graph-explore.test.ts
    interface-smoke.test.ts
    fixtures/
      fake-agent.ts
      sample-repo/
  docs/              Operator-facing documentation
```

### Package Purposes

| Package | Purpose |
|---------|---------|
| `wiki-core` | All wiki logic. No CLI, no I/O formatting. Exports typed functions. |
| `wiki-cli` | Thin CLI wrapper. Parses args, calls wiki-core, formats output. |
| `wiki-mcp` | MCP server. Registers wiki-core operations as MCP tools. |
| `dispatch-core` | Review, launch, cleanup, token, paths. No CLI. |
| `dispatch-cli` | Thin CLI wrapper for dispatch operations. |
| `dispatch-mcp` | MCP server. Registers dispatch-core operations as MCP tools. |
| `graph-explore` | File scanning, code import extraction, wiki overlay, graph output. |

### Contract-Driven Design

The `contract/manifest.json` file is the source of truth for wiki record types. It defines:

- Which prefixes exist (WK, IN, DEC, SRC, AREA, PLN, VAL)
- Which prefixes are excluded (HO)
- Required and optional frontmatter fields per type
- Enum values for status, priority, type fields
- ID allocation strategy per type
- Directory mapping per type

All wiki-core operations resolve behavior from the manifest. Do not hardcode record type behavior.

## Root Scripts

```
npm run wiki -- <command> [--dir <path>] [options]    Wiki CLI
npm run wiki:mcp                                       Start MCP server
npm run dispatch -- <command> [options]                 Dispatch CLI
npm run dispatch:mcp                                    Start dispatch MCP server
npm run graph -- --dir <path>                          Graph extraction
npm test                                               Run all tests (vitest)
npm run typecheck                                      Typecheck entire monorepo (tsc --build)
```

## Working Conventions

### Core Rule

Use the repo-local wiki and docs as the canonical work-and-knowledge model for this repository.

Repository-context retrieval is a wiki/docs retrieval problem first, not a broad filesystem search problem first.

Do not treat generated views, launcher runtime artifacts, or `scratch_space/` material as canonical state.

### Retrieval Order

Before substantive work:

1. Search the wiki with the kb wiki MCP `search` tool. This is the first retrieval step.
2. If you need a structured overview, regenerate views with the MCP `generate` tool and read them (`catalog`, `now`, `inbox`, `backlog`, `archive`).
3. Then read the relevant durable `docs/` pages.
4. Then check related `wiki/decisions/`, `wiki/issues/`, `wiki/initiatives/`, `wiki/areas/`, and `wiki/sources/` pages when they exist.
5. Only then drill into implementation files under `packages/` and `tests/`.

If the kb wiki MCP server is not available this session, run the same steps via the kb CLI (`npm run wiki -- search --dir .`, `npm run wiki -- generate --dir .`). Do not use raw `rg`, file globbing, or direct file reads as the first retrieval step. Do not parallelize implementation search with the initial retrieval pass.

If generated views are missing or stale, fall back to:

1. relevant durable `docs/` reference pages
2. `wiki/decisions/`
3. `wiki/issues/` and `wiki/initiatives/`
4. `wiki/sources/` and `wiki/areas/`
5. implementation files

### Canonical Layers

- `docs/` reference pages are the canonical durable knowledge layer for operator and protocol behavior.
- `wiki/issues/WK-*` and `wiki/initiatives/IN-*` are the canonical work-tracking layers.
- `wiki/decisions/DEC-*` records durable repo decisions.
- `wiki/sources/SRC-*` records provenance and evidence when needed.
- `wiki/areas/*.md` records durable repo boundaries and ownership.
- `wiki/catalog.md`, `wiki/now.md`, `wiki/backlog.md`, `wiki/archive.md`, and `wiki/inbox.md` are generated views, not canonical state.
- `.agent-runs/` is runtime state only and must never be treated as committed or canonical content.

### TypeScript Patterns

- TypeScript, Node.js 20+, npm workspaces
- All packages use `tsconfig.json` extending `../../tsconfig.base.json`
- Root `tsconfig.json` has project references to all packages and `tsconfig.tests.json`
- Use `.js` extensions in import specifiers (TypeScript ESM resolution)
- Run with `tsx` (no separate compile step for CLI usage)
- Test with `vitest`
- Schema validation with `zod`

### Module Boundaries

- `wiki-cli` imports from `@kb/wiki-core`. It does not import from dispatch or graph.
- `wiki-mcp` imports from `@kb/wiki-core`. It does not import from dispatch or graph.
- `dispatch-cli` imports from `@kb/dispatch-core`. It does not import from wiki or graph.
- `dispatch-mcp` imports from `@kb/dispatch-core`. It does not import from wiki or graph.
- `graph-explore` is standalone. It reads wiki files directly but does not import wiki-core or dispatch-core.
- No circular dependencies between packages.

### Result Types

Both wiki-core and dispatch-core use typed Result types:

- `wiki-core`: `Result<T>` with `ok(data)` / `fail(errorCode, message)`
- `dispatch-core`: `DispatchResult<T>` with `ok(data)` / `fail(errorCode, message)`

All public functions return Result types. Never throw from public API functions.

## Wiki Conventions

### Manifest-Driven Records

The six manifest-driven record types:

| Prefix | Type | Directory | ID Strategy |
|--------|------|-----------|-------------|
| WK | Work item (issue) | `wiki/issues/` | Allocated sequential |
| IN | Initiative | `wiki/initiatives/` | Allocated sequential |
| DEC | Decision | `wiki/decisions/` | Allocated sequential |
| SRC | Source | `wiki/sources/` | Allocated sequential |
| AREA | Area | `wiki/areas/` | Slug-based |
| PLN | Plan | `wiki/plans/` | Allocated sequential |

### HO-\* Ownership

`HO-*` handoff records are **dispatch-owned**, not manifest-driven wiki records:

- `HO` is listed in `manifest.json` under `excludedPrefixes`
- `wiki create` rejects the `HO` prefix with `INVALID_PREFIX`
- Handoff template (`contract/templates/handoff.md`) is synced as a shared template surface
- HO-\* files live in `wiki/handoffs/` and are created by dispatch tooling or authored manually

### Handoffs Exclusion Rules

`wiki/handoffs/` is excluded from all wiki scanning operations:

- `lint` does not scan `wiki/handoffs/`
- `generate` does not include handoffs in generated views
- `search` / `build-search-index` does not index handoffs
- Graph scanning excludes `wiki/handoffs/`

### Generated Views

The following files are generated by `wiki generate` and are not canonical:

- `wiki/catalog.md`
- `wiki/now.md`
- `wiki/inbox.md`
- `wiki/backlog.md`
- `wiki/archive.md`

These are excluded from lint and graph scanning.

## Dispatch Conventions

### Trust Model

- The **operator** controls config, registry, and tokens. These are trusted.
- **HO-\* handoffs** are untrusted input. They go through review validation.
- The agent registry (`launchers.v1.json`) lives in the operator config directory, not in the repo.
- Token keys (`token.key`) are operator-owned HMAC secrets.

### Review-Before-Launch

Every handoff must be reviewed before it can be launched. The review step:

1. Validates frontmatter against the Zod schema
2. Rejects forbidden fields (command, cwd, permissions, path-bearing fields)
3. Enforces `allowed_agents` from the handoff
4. Validates Read First paths exist in repo
5. Checks agent exists in registry
6. Creates an immutable review bundle in `.agent-runs/reviews/RV-<uuid>/`
7. Writes `agent-visible/wrapper.md`, `agent-visible/handoff.snapshot.md`, and `agent-visible/context/`
8. Writes `metadata/input-manifest.json` and `metadata/review.json`
7. Captures input manifest hash and registry hash
8. Issues a signed pending token

### Token State Machine

Tokens move through four states, each backed by a subdirectory under the operator config:

```
pending/ --> launching/ --> consumed/
                       \--> rejected/
```

- `pending`: Review completed, awaiting launch
- `launching`: Launch in progress
- `consumed`: Successfully launched and agent responded
- `rejected`: Expired, failed, or rejected

### Reviewed Bundle Invariant

Agent processes are spawned with `cwd` set to the reviewed `agent-visible/` bundle inside `.agent-runs/runs/<handoffId>/RUN-<uuid>/agent-visible/`. The handoff never controls its own working directory.

### Environment Allowlist

Launch builds a filtered environment. Only allowlisted variables from the operator's environment are passed through, plus dispatch-specific variables (`AGENT_BLACKBOARD_*`).

## Graph Conventions

### Deterministic Only

Graph extraction is fully deterministic:

- No semantic inference
- No heuristic clustering
- No function-level / symbol-level graphs
- File/module level only

### Code-First

Graph extracts import relationships from:

- TypeScript/JavaScript: `import`, `export ... from`, `require()`
- Python: `import`, `from ... import ...`

Only repo-local references are resolved. External/unresolved modules are ignored.

### Wiki Overlay

Graph reads explicit frontmatter fields from wiki records:

- `repo_paths` -> `repo_path` edges
- `docs` -> `doc` edges
- `depends_on` -> `depends_on` edges
- `blocks` -> `blocks` edges
- `related` -> `related` edges
- `area` -> `area` edges
- `initiative` -> `initiative` edges
- Markdown links in body -> `markdown_link` edges

### Node Kinds

- `code_file` -- source code files
- `doc_file` -- documentation files (.md, .txt, .rst)
- `wiki_record` -- manifest-driven wiki records

### Exclusions

Graph excludes:

- `wiki/handoffs/`
- Generated views (catalog.md, now.md, inbox.md, backlog.md, archive.md)
- `.agent-runs/`
- `scratch_space/`
- `node_modules/`
- `dist/`
- Runtime files (`.wiki-contract.json`, `.id-state.json`, `.search-index.json`, `.graph.json`)
- `graph-summary.md`

### Output

- `wiki/.graph.json` -- full graph as JSON
- `wiki/graph-summary.md` -- deterministic markdown summary with node/edge counts, orphans, missing nodes, highest in-degree

## Validation

Before declaring any work complete, run:

```
npm run typecheck && npm test
```

Both must pass.

## What Not To Do

- **Do not add HO to the manifest.** HO-\* is dispatch-owned, not manifest-driven.
- **Do not include `wiki/handoffs/` in wiki operations.** Lint, generate, search, and graph all exclude it.
- **Do not add semantic or heuristic graph features.** Graph is deterministic, code-first, file/module level only.
- **Do not modify `contract/manifest.json` to add new record types without a design decision.** The seven types (WK, IN, DEC, SRC, AREA, PLN, VAL) are the current set.
- **Do not throw from public API functions.** Use the Result type pattern.
- **Do not import across subsystem boundaries.** wiki-cli uses wiki-core. dispatch-cli uses dispatch-core. graph-explore is standalone.
- **Do not describe features that do not exist.** No semantic search, no embeddings, no function-level graphs.
- **Do not modify files under `scratch_space/`.** That directory is for planning and reference only.


## Interaction Contract

- Do not stop at findings. If you identify a problem, propose a concrete fix in the same response.
- For non-trivial work, be approval-seeking before acting. State the recommendation, the exact change, and ask `Approve?` before editing.
- Treat non-trivial work as any multi-file edit, behavior change, architectural change, expensive run, or irreversible action.
- After approval, execute the agreed change with minimal narration.
- Use progress updates only when blocked, waiting on a command, or when new information changes the recommendation.
- If multiple approaches are possible, recommend one approach first. Mention alternatives only when they materially affect the decision.

## Communication Style

- Keep responses short and direct.
- Start with the conclusion or recommendation.
- Default response shape for non-trivial tasks:
  1. conclusion
  2. proposed solution
  3. exact change needed
  4. `Approve?`
- Avoid repeating the same point.
- Use bullets only for real lists.
- For code semantics, use:
  1. current behavior
  2. intended behavior
  3. exact change needed
- Do not reason out loud unless asked.
- Do not narrate exploration or list findings without a recommendation unless the user explicitly asked for investigation only.
- Minimize filler, hedging, and progress chatter.
- Keep default answers compact. Expand only when asked or when precision requires it.

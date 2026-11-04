# Agent Operating Guide

<!-- BEGIN kb-managed -->
Managed by kb — edits inside this block are overwritten by `kb bootstrap` / `kb sync-contract`; edit outside the markers.

## kb — wiki

This repository uses the kb toolkit. The installed kb MCP servers are registered in this repo's `.mcp.json`
and run from the kb checkout; every kb tool call targets this repository via `dir`.

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
not use raw `rg`, file globbing, or direct file reads as the first retrieval step. Do not parallelize
implementation search with the initial retrieval pass.

### Wiki rules

- Prefer the `kb-wiki` MCP tools (`search`, `generate`, `lint`, `create`, `allocate-id`,
  `build-search-index`, `sync-contract`, `bootstrap`); CLI fallback `npm run wiki -- … --dir <this repo>`.
- `allocate-id` is an idempotent **peek/reserve**, not a counter: repeat calls return the same id until
  `create` writes the record that claims it. Call `create` to claim an id; repeated identical ids are
  correct, not a bug.
- Always pass `dir` pointing at this repository; run kb from its own checkout, not this repo root.
- If wiki records and code/tests disagree, report the mismatch rather than trusting a grep-first conclusion.
- Graph: `npm run graph -- --dir <this repo>` extracts the deterministic import graph with the wiki-record overlay.

## kb — dispatch

- Dispatch is the multi-agent handoff protocol: author HOs (`create-handoff`), dispatch workers in the bwrap
  jail, capture results, review, merge. The dispatch MCP server instructions carry the full orchestration
  recipe. Prefer `kb-dispatch` MCP tools; CLI fallback `npm run dispatch -- …`.
- For pipeline work, delegate via kb-dispatch; do not spawn coding-agent subagents or workflows unless the
  operator explicitly approves.
- `HO-*` handoffs are dispatch-owned (`wiki/handoffs/`, excluded from wiki scans); never create them via
  `wiki create`.
- Merges go through `merge-delivery` only — never by hand. After a merge, run this repo's validation command
  on the host and record the result in the WK.

## Engineering guidelines

Every build here is judged by: organization, cleanliness, configurability, reproducibility, extensibility,
deployability, interpretability, easy to debug, simple and not overengineered. The codebase and directory tree do
not balloon. No quick fixes — root cause, connected to the bigger picture, with blast radius considered. Clean,
intuitive docs for end users. A limit that matters lives outside the model, where the model cannot argue with it.
The question behind all of it: how can I improve this so that a future agent does not make the same mistake?

### Before you build

1. **Spec before build.** Write the spec before you build. Accept-all vibe coding is for throwaway work, never production.
2. **Success criteria, not step-by-step.** Define what done looks like, loop until it is verified, and checkpoint after each stage.
3. **Specify behavior, not mechanism.** The spec says what must be true; the how stays open unless the operator asked for one.
4. **Think before coding.** State assumptions, flag inconsistencies, present tradeoffs, and push back when a simpler approach exists. When patterns conflict, pick one, explain the choice, and flag the other for cleanup. Never proceed uncertainly — and never ask what the repo's rules, records, and code can answer; exhaust those first.
5. **The context window is scarce working memory.** Start a new session per topic; load only what the next step needs.
6. **Draw the runtime spine before slicing** (validate → acquire → transform → deliver → record); no spine, no slices. Skeleton first: the first increment runs the whole spine thin, takes the riskiest integration, and ends with something an owner can watch work. Each later increment widens one dimension and still runs end to end.
7. **Break false dependencies with named interims** — a hardcoded entry, an env passthrough, a hand-authored input. Each interim names the increment that retires it.
8. **Freeze late.** Schemas, contracts, and registries lock only after real runs have exercised them — never in increment one.
9. **Delete late.** A working system stays live with green tests until a cutover increment proves its replacement.
10. **Gates are live proofs an owner ratifies.** "Code complete" and component demos are not gates.
11. **Conserve scope.** Nothing enters or leaves scope silently; late-discovered work gets its own named task.
12. **Phases are a deliberate, written choice** — an external wait, no shared runtime spine, or slicing as ceremony — never the default.

### Code shape & reuse

13. **Climb the reuse ladder before writing anything new:** does it need to exist → this codebase → stdlib or platform → an installed dependency (never add one for a few lines) → an at-a-glance one-liner → only then minimum new code, with a stated reason. Logic lives in the library; scripts are thin entry points; atomic functions compose under a composite router; domain constants stay out of general modules.
14. **Settings are parameters, never names.** No task, experiment, model, or dataset names in code, file names, or registered names; no hardcoded shapes or counts the config already knows.
15. **Write the minimum code that solves the problem.** No speculative features or abstractions for single-use code; prefer dependency-light, hackable code over config objects and factories.
16. **Make surgical changes.** Touch only what the request requires; never change code or comments you do not understand, even orthogonal-looking ones.
17. **Read before you write:** the file's exports, its immediate caller, and the shared utilities.
18. **Cite, don't recall.** Every claim names the file and function read in this session.
19. **Reuse aggressively; generalize reluctantly.** Build new code at today's size — going generic needs a named second consumer (one adapter is a hypothetical seam, two is real).
20. **Name things for what they do now.** A name that encodes today's specifics drifts; rename when the job changes.
21. **Directory structure is discipline.** Read one sibling of the same kind before writing into a directory; use the existing structure; propose one when none exists; altering one is a reformat proposal, never ad hoc. Never mint an over-specific directory for one artifact.
22. **Fix the root cause only.** Diagnose first, grep every caller, fix once in shared code — no quick fixes, patches, or workarounds.
23. **Keep a "where code goes" map in the repo, outside the managed block:** one row per concern — its home, and the anti-pattern. Consult it before placing new code; update it in the same change that adds a new home.
24. **Never cut the floor.** Never cut validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything the user asked for. Never swallow an error — no bare catch or except-pass; an error stops the run or is handled and logged with its cause.

### Tests & evidence

25. **Never weaken a test to get green.** A test changes only on a diagnosed staleness, with evidence and a named replacement check.
26. **Agree test seams — public boundaries — before writing tests.** Tests verify intent: they encode why and fail when business logic changes. No implementation-coupled tests, no tautological tests, no horizontal slicing.
27. **Apply the deletion test.** Delete the module; if its complexity reappears across callers, it earned its keep.
28. **Prove a check bites.** Run it clean, plant a violation, confirm it fails, revert, confirm it passes.
29. **Debug with a repro loop, not theories.** Build the reproduction first; rank three to five falsifiable hypotheses before testing any.
30. **Evidence is observed, never claimed.** Counts, test status, and run facts come from commands and logs; your own claim is not evidence. Say plainly when you cannot be sure.
31. **A deterministic validator decides pass or fail** — at every task and every pipeline transition — never the model.
32. **Schema-valid is not semantically correct.** Passing validation says nothing about matching the request.
33. **Capture before code.** An external shape — an API response, CLI output, a file format — is an assumption until a real captured output proves it. Golden fixtures are real, unedited captures; never patch code to accept two shapes.
34. **Reviews check the rules as well as the spec.** Flag parallel copies, one-off scripts, hardcoded settings; judge in order — correct, safe, holds under load, tested, fast, lean; no finding without a concrete failing case.
35. **Keep diffs small and incremental.** The verification loop is the bottleneck; its speed bounds safe autonomy.
36. **Build evaluation loops.** A non-deterministic part ships with an eval path; a deterministic part ships with tests.

### Pipelines & runs

37. **Code orchestrates; the model works inside.** Deterministic code owns sequence, state, retries, routing, and delivery; call the model only where reasoning helps.
38. **A bounded model task returns a structured artifact** — a discovery record, never prose and never pipeline config. Code renders config from it; the model cannot hallucinate a threshold it never writes.
39. **Classify retries.** Code decides what the model may fix, feeds back the validator's error, and caps attempts; real failures stop the run.
40. **Make pipeline work idempotent, resumable, and provenanced.** Checkpoint completed units; regenerate artifacts to the same path, overwriting stale copies; content-hash inputs to skip finished work and prove identity; record input hash, code and config versions, and the run — or the artifact is scratch.
41. **Long-running work logs live.** Append, flush, timestamp; `tail -f` must show progress — an empty log during a run is a bug. A run that outlives the session is detached and reattachable; stop or hand off every background process before reporting done.
42. **Clean up what you open.** Close every handle, socket, and connection; bound and track concurrency; verify teardown before yielding.
43. **Write state atomically.** A state or checkpoint file writes to a temp path and renames into place; concurrent writers take a lock. A half-written state file is corruption, not progress.
44. **Record metrics per run for non-deterministic work** — wall time, tokens, tool calls, turns, cost, outcome — from logs, never self-reported. Code that calls LLMs uses OpenTelemetry GenAI conventions.
45. **Generated surfaces are never truth.** When a view disagrees with canon, canon wins and the view regenerates. Reports lead with the result, render deterministically from a structured spec, and stay rebuildable outputs.
46. **Keep model and provider behind one router interface, as config.** The test is the swap: change the model and everything else still works.
47. **Design the system around the agent.** Bounded tools, contracts at ambiguous decisions, validators at transitions, protected raw data, human approval at consequential boundaries — never agents sprinkled over scripts.

### Data & environments

48. **Data lives outside the codebase, with provenance.** Knowledge, run state, and artifacts are separate layers with different owners; none substitutes for another.
49. **End every session self-contained.** Objective, state, decisions, artifacts, evidence, and remaining work go to durable records — if the next session needs the transcript, the loop is incomplete.
50. **Keep an environment registry in AGENTS.md, outside the managed block:** each environment's name, manager, purpose, and freeze command — updated in the same change.
51. **Test against disposable databases.** Provision one for the task — never the connection string in the environment. Validate a migration by replaying full history plus the new one on a throwaway database, with the suite.
52. **Migrations are append-only.** Never edit an applied migration; destructive operations need explicit confirmation every time.
53. **In-scope is not safe.** A write scope or tool permission enforces boundaries, not prudence; "the tool let me" is never permission for a destructive step. Manage permissions, isolate work, and keep a human on diffs and specs.

### Dependencies & supply chain

54. **Verify before you install.** A package must exist on the registry — never trust a recalled name. Change lockfiles incrementally, never regenerate; audit after every dependency change; new versions get a cooldown window and a provenance check.
55. **Secrets never enter argv or logs.** Command lines and log streams are exfiltration surfaces, separate from source hardcoding.
56. **Never bypass a hook or gate.** On rejection, fix the named rule and retry. Stock linters are the first backstop — never hand-write a check a stock rule covers.

### Shipping & contracts

57. **Correctness wins over backward compatibility.** Internally, no silent shims, aliases, dual read/write, or fallback parsing — remove obsolete compatibility, or carry a decision naming the surface and removal condition. Once real consumers exist, a public or agent-facing contract changes only by explicit, time-boxed deprecation — replacement first, a deprecation mark with a removal date, one more cycle — and additive-looking changes count as breaking for typed or agent consumers.
58. **Decide shipping at planning time.** Name where the build ships and how — package, container, submodule — and when that choice is made; containers and submodules need a stated reason.
59. **Add a language boundary only for a clear capability,** behind a versioned, tested contract — never by drift.
60. **A UI needs a reason before it needs conventions.**
61. **Remove feature flags in fixed order:** pull the code check and deploy first; retire the flag in the flag system after.
62. **Declare the repo's AI-contribution policy** — refuse, disclose, verify, or hand off — separate from the license. Disclose contribution; never merge code no human understands.
63. **Every change names the parts of the repo it touches;** a core-surface change states why.
64. **Keep end-user docs current.** A shipped capability keeps clean, intuitive docs for its users; a behavior change updates the docs in the same change.
65. **Keep one source of truth per fact.** A second copy is derived and regenerated, never hand-maintained; where a copy must exist, fingerprint it against its source so drift is detected, not remembered. A hand-maintained duplicate is ad hoc only.
66. **Mark every shortcut.** Label it `shortcut: <the limit>, <when to upgrade>`; a shortcut with no upgrade trigger is rot.
67. **Every deferral carries a written re-open trigger,** checked at every gate.

Roles (`/planner`, `/orchestrator`, `/overseer`) install user-global via `install-roles` from the kb
checkout. This block is managed by kb and overwritten on sync; this repo's own rules, environment registry,
and where-code-goes map live below the end marker, where kb never writes.
<!-- END kb-managed -->


This document is the primary reference for any agent session working in the `kb` repository. Read it before making changes.

## Project Summary

`kb` is a TypeScript monorepo toolkit providing three subsystems:

1. **Wiki** -- Structured repo-local wiki with manifest-driven record types (WK, IN, DEC, SRC, AREA, PLN, VAL). Operations: bootstrap, sync-contract, allocate-id, create, lint, generate, build-search-index, search, import-plan, validate-plan, archive-plan. Interfaces: CLI and MCP server.
2. **Dispatch Protocol** -- v2 multi-agent handoff workflow using HO-\* documents. One atomic gated pipeline (admission -> clone -> jail -> worker -> delivery -> capture). Linux-only (bwrap sandboxing). Deterministic fake-agent fixture for testing.
3. **Graph Explore** -- Deterministic code-first graph extraction at file/module level. Wiki overlay from frontmatter. Produces JSON and markdown summary.

### Sister-Repo Model

`kb` lives in its own repository. It targets consuming repos via `--dir`. Operators run commands from inside `kb/` and point at the target repo:

```
npm run wiki -- bootstrap --dir ../my-project --repo org/name
npm run graph -- --dir ../my-project
```

### Nested Wiki Repo

`wiki/` is a **separate private git repository** (`kb-wiki`, remote `github.com/mcap91/kb-wiki`) nested inside this checkout — not a subtree or subdirectory of `kb`. The parent `.gitignore` lists `wiki/` so `kb` does not embed it.

Consequences when committing:

- Wiki content — records (`WK/IN/DEC/SRC/AREA/PLN/VAL`), templates, generated views, search index — is version-controlled in `kb-wiki` and committed from inside `wiki/` (`git -C wiki …`). It never appears in `kb`'s `git status`, and a `kb`-root `git add` cannot stage it.
- `contract/templates/*.md` are the source of truth in `kb`; `sync-contract` / `bootstrap` copy them into `wiki/templates/`, which is a downstream artifact committed in `kb-wiki`.
- Work that touches both sides is two commits in two repos: the code/contract change in `kb`, the wiki record/template change in `kb-wiki`.

### Agent-Native MCP Setup

If you are wiring `kb` into a native MCP client, use direct `node` launch commands rather than `npm run ...:mcp`.

- Claude: a project-scoped `.mcp.json` works.
- Codex: use `codex mcp add ...` native registration.
- Verify with `claude mcp list` and `codex mcp list`.
- For strict stdio clients, avoid `npm run wiki:mcp` and `npm run dispatch:mcp` because the npm wrapper writes to stdout before the MCP handshake.
- If the client does not preserve `cwd`, use absolute `tsx` loader and server script paths.

When you are working in `kb` itself, this checkout can self-host its own MCP tools:

- Claude can use a local `.mcp.json` created from the template below
- Codex can be pointed at this checkout with `npm run codex:mcp:register`
- in that mode, `dir` should point back at this `kb` repo

This self-hosted setup does not replace the sister-repo model:

- a consuming repo needs its own Claude `.mcp.json` that points back to the chosen `kb` checkout
- Codex MCP registration is user-level and should point at one chosen `kb` checkout per machine

Claude `.mcp.json` example. Replace:

- `<TSX-LOADER-FILE-URL>` with a file URL to `node_modules/tsx/dist/loader.mjs` (e.g. `file:///home/you/projects/kb/node_modules/tsx/dist/loader.mjs`)
- `<ABSOLUTE-PATH-TO-KB>` with the absolute path to this `kb` checkout, using forward slashes

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

## Core Architecture

### Monorepo Layout

```
kb/
  packages/
    wiki-core/       Core wiki operations (bootstrap, sync, allocate, create, lint, generate, search)
    wiki-cli/        CLI entry point for wiki commands
    wiki-mcp/        MCP server exposing wiki operations as tools
    dispatch-core/   Core dispatch operations (admission, pipeline, credentials, cleanup, status)
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
| `dispatch-core` | Admission, pipeline (dispatch), credentials, cleanup, paths. No CLI. |
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

Do not treat generated views, launcher runtime artifacts, or `scratch_space/` material as canonical state.

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
- `dispatch-core` may import `@kb/wiki-core`'s record primitives — the ONE ratified one-way exception (DEC-0007). `wiki-core` must never import from dispatch-core.
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

- `HO` is listed in `manifest.json` under `excludedPrefixes`
- `wiki create` rejects the `HO` prefix with `INVALID_PREFIX`
- Handoff template (`contract/templates/handoff.md`) is synced as a shared template surface
- HO-\* files are created by dispatch tooling or authored manually

### Handoffs Exclusion Rules

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
npm run check:lockfile && npm run typecheck && npm test
```

All three must pass. The gate must be green on Linux (WSL2 ext4).

## Test Consuming Repo

`/home/mcap91/projects/test_kb` is the test consuming repo and the only fixture repo. Use it for smoke tests (dispatch, bootstrap, sync-contract, any feature that targets a consuming repo via `--dir`) and for agent evals (the IN-0011 eval harness, WK-0237). It can be cleared and re-bootstrapped at any time; recreate it with `npm run setup:test-kb -- <owner>/test_kb` (or `TEST_KB_REPO=<owner>/test_kb`). Do not treat its contents as durable.

`/home/mcap91/projects/test_kb_data` is its sister dir and the durable file store: keep anything that must survive a test_kb reset there (eval logs and metrics, run artifacts). See `docs/verify-dispatch.md` for the generic live smoke-test runbook (scratch-repo setup, golden fixture, review chain, Pi fixture, redteam, mount traversal).

## What Not To Do

- **Do not add HO to the manifest.**
- **Do not add semantic or heuristic graph features.** Graph is deterministic, code-first, file/module level only.
- **Do not modify `contract/manifest.json` to add new record types without a design decision.** The seven types (WK, IN, DEC, SRC, AREA, PLN, VAL) are the current set.
- **Do not throw from public API functions.** Use the Result type pattern.
- **Do not import across subsystem boundaries.** wiki-cli uses wiki-core. dispatch-cli uses dispatch-core. graph-explore is standalone. Sole ratified exception (DEC-0007): dispatch-core may import wiki-core's record primitives, one-way, never the reverse.
- **Do not describe features that do not exist.** No semantic search, no embeddings, no function-level graphs.
- **Do not modify files under `scratch_space/`.** That directory is for planning and reference only.
- **Do not use git worktrees.** Multiple agents share this checkout. Worktrees cause branch switches, stash collisions, and lost work. Work on one branch at a time; if branches diverge, rebase and merge — never create parallel worktrees.

## kb-autoshop Design Item Discipline (IN-0011)

These rules bind kb's own planning sessions on design items under IN-0011 (kb-autoshop and the planning contract).
They are the kb-specific forms of generic rules the planner role ships to every consuming repo; the generic forms
live in `contract/roles/planner.md`.

- **Reference systems.** Every design item for kb-autoshop cites each of the three standing references below, or
  states "none found" for it, and says whether the item mirrors or diverges from it, and why (see IN-0011
  "Standing references"):
  - the kb-autoshop prototype — SRC-0020 (hashed manifest), SRC-0021 (run 1 evidence), `docs/scratch_space/auto-shop/`
  - AgentChassis — SRC-0022
  - the bioinfo catalog — SRC-0023
- **Full-source reads.** A sweep over the bioinfo catalog (or any other catalog-shaped source) reads each candidate
  card's body; a conclusion drawn from frontmatter or a summary alone is not evidence.
- **Needs.** Every IN-0011 addition — a new rule, role change, or piece of machinery — cites a need from IN-0011's
  Needs register (N1–N10) or a ledger failure (`wiki/sources/SRC-0024.md` Intake); an addition that cites neither
  does not belong in IN-0011.

## Interaction Contract

- Do not stop at findings. If you identify a problem, propose a concrete fix in the same response.
- For non-trivial work, be approval-seeking before acting. State the recommendation, the exact change, and ask `Approve?` before editing.
- Treat non-trivial work as any multi-file edit, behavior change, architectural change, expensive run, or irreversible action.
- After approval, execute the agreed change with minimal narration.
- Use progress updates only when blocked, waiting on a command, or when new information changes the recommendation.
- If multiple approaches are possible, recommend one approach first. Mention alternatives only when they materially affect the decision.

# Claude Operating Guide

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
4. Present the full `review_units[]` table to the operator — this single list is both the review surface and the estimate basis. For each row (path, unitClass, tier, wk_ids, net_loc, loc_reference), proposed_days = loc_reference (= net_loc / 260, the SRC-0002 corpus rate). Docs-class rows: no calibrated rate — flag for operator hand-set (WK-0052). Agent adjustments to proposals are downward-only with justification. Apply the tripwire: any row the agent or operator moves >3× from proposed_days (either direction) must state why; upward moves state replication reasoning (what re-deriving the change by hand would cost — e.g. "re-tracing invariant X through Y"), never agent toil (tokens/time spent) — agent effort lives in the cost line, not the numerator. Small-LOC rows the agent judges insight-dense (surgical edits to reusable code that required real system understanding) SHOULD be called out as candidates for operator upward ratification — narration only: no proposed number, no multiplier, at most one sentence per row; absence of flags is a valid outcome. Also present the candidates list for confirm/reject. The agent NEVER confirms a candidate or self-attests a unit — operator-only gate.
5. After the operator ratifies (veto/adjust each row in one pass), fill the record per `wiki/templates/value.md`: tool-filled fields from step 1, scraped fields from step 2, ratified rows in ## How This Was Calculated. Compute replication_days = Σ ratified_days; saved_floor_days = replication_days − work_days (may be negative; never clamp); leverage = replication_days / work_days (uncapped; may be < 1; never clamp); cum_leverage = Σ replication_days / Σ work_days over published flat-formula VALs plus this one (body-only). work_hours is printed context, never in the arithmetic. Set units_valued = count of ratified rows. Nothing unratified reaches published frontmatter. If leverage < 1 or saved_floor_days < 0, the operator must add a reconciliation note in operator_notes before publishing (instrument misfit, or span dominated by non-authoring work — expected under floor semantics).
6. Print the ROI line: `shipped <units_valued> working units; agents cost $<cost_usd> (est. $<cost_usd_est> at API rates) / <total_tokens> tokens; replication value <replication_days> operator-days vs <work_days> days worked → leverage <leverage>× (floor); chain <cum_leverage>×`. If `cost_usd` is null (pure subscription-covered), render it as $0 out-of-pocket; the estimate carries the interpretable figure. Then print the ceiling reference line: `reference ceiling: COCOMO II nominal ≈ <cocomo_pm_nominal> person-months for <cocomo_kloc> KSLOC (frozen nominal constants, Boehm 2000)` — display-only; never in the arithmetic.

Rules: report every watermark span — never skip a poor one; null and negative results are stated plainly. Never edit a prior VAL record.

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
- Import `@kb/wiki-core` from wiki-cli and wiki-mcp. Import `@kb/dispatch-core` from dispatch-cli. No cross-subsystem imports.

### Monorepo Structure

Six packages under `packages/`: `wiki-core`, `wiki-cli`, `wiki-mcp`, `dispatch-core`, `dispatch-cli`, `graph-explore`.

Contract lives in `contract/` with `manifest.json` as the source of truth for record types.

### Subagents

Subagents default to Sonnet via `CLAUDE_CODE_SUBAGENT_MODEL` in `.claude/settings.json`. Pass `model: "opus"` on individual Agent calls only when the subagent needs complex reasoning or a Sonnet attempt produced inadequate results.

### Do Not

- Modify files under `scratch_space/`
- Add HO to the manifest
- Include `wiki/handoffs/` in wiki scanning operations
- Add semantic/heuristic graph features
- Throw from public API functions
- Import across subsystem boundaries

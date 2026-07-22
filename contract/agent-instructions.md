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

### Value reports (value-report-recipe-v1)

**What VAL is.** An append-only ROI closeout over a commit-watermark span: what a span of agent work cost (tokens/$) vs. what surviving, classified output it produced. Not a work-log, not a milestone gate; never edit a VAL — append the next one. Operator-initiated: agents run the recipe when asked, never self-initiate. Design: one deploy surface (this managed block; deliberately no skill — rationale in kb WK-0033).

**Cadence is the operator's.** Each VAL auto-advances the watermark from the prior VAL's `head_commit` to HEAD; the chain tiles commits with no gap or overlap. Daily and weekly both work; a VAL today never blocks tomorrow's. With no prior VAL, the first report covers repo history from the first commit — scope with `--since`.

**Scope is a commit range, not a feature.** The report sweeps every commit in the span and every surviving file; WK ids are scraped from commit messages as references only. Cost is time-windowed per repo — tokens cannot be split between interleaved features after the fact. For a clean per-feature ROI, finish the feature and cut the VAL at its boundary (`--untilRef`) before the next feature's commits land; interleaved features report together as one span.

When the operator asks for a value report:

0. Refresh the graph: `npm run graph -- --dir <repo>` (regenerates `wiki/.graph.json`).
1. Run `value-report` (MCP tool) or `npm run wiki -- value-report --dir <repo>` (CLI fallback) to compute watermark, chain status, git metrics, unit evidence, candidates, and the unified review surface.
2. Run `value-usage` (MCP tool) or `npm run wiki -- value-usage --dir <repo> --since <window_start> --until <window_end>` using the dates from step 1.
3. Run `create --prefix VAL` to scaffold `wiki/value-reports/VAL-XXXX.md`.
4. Present the full `review_units[]` table to the operator — this single list is both the review surface and the estimate basis. For each row (path, unitClass, tier, wk_ids, net_loc, loc_reference), propose a human_days estimate with ≥1 anchor citation and delta reasoning. Apply the LOC-reference tripwire: flag any estimate diverging >3× from loc_reference and explain why. Flag units matching no anchor as `no-close-anchor` and interpolate between the two nearest anchors with an explanation. Also present the candidates list for confirm/reject. The agent NEVER confirms a candidate or self-attests a unit — operator-only gate.
5. After the operator ratifies (veto/adjust each row in one pass), fill the record per `wiki/templates/value.md`: tool-filled fields from step 1, scraped fields from step 2, operator-ratified estimates in the ## How This Was Calculated table. Compute human_days_units = Σ ratified_days; human_days_loc = net_loc_added / loc_per_day; human_days_anchor = min(human_days_units, human_days_loc); time_saved_days = human_days_anchor − work_days; speedup = min(human_days_anchor / work_days, 10). (Print work_hours / hours_per_work_day alongside as the finer alternative denominator — never leading.) Set units_valued = count of ratified rows. Agent adjustments to the estimate are downward-only with justification in estimate_basis. Nothing unratified reaches published frontmatter. If time_saved_days < 0 or speedup < 1, the operator must add a reconciliation note in operator_notes before publishing.
6. Print the ROI line: `shipped <units_valued> working units; agents cost $<cost_usd> (est. $<cost_usd_est> at API rates) / <total_tokens> tokens; <time_saved_days> human-days vs. baseline (~<speedup>×, floor-anchored)`. If `cost_usd` is null (pure subscription-covered), render it as $0 out-of-pocket; the estimate carries the interpretable figure.

Rules: report every watermark span — never skip a poor one; null and negative results are stated plainly. Never edit a prior VAL record.

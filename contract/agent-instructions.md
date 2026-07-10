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
- Dispatch: prefer the `kb-dispatch` MCP tools or the kb CLI.
- Graph: kb CLI (`npm run graph -- --dir <this repo>`).
- Always pass `dir` pointing at this repository; run kb from its own checkout, not this repo root.
- Do not create `HO-*` via `wiki create` — handoffs are dispatch-owned under `wiki/handoffs/`.
- If wiki records and code/tests disagree, report the mismatch rather than trusting a grep-first conclusion.

### Value reports (value-report-recipe-v1)

When the operator asks for a value report:

0. Refresh the graph: `npm run graph -- --dir <repo>` (regenerates `wiki/.graph.json`).
1. Run `value-report` (MCP tool) or `npm run wiki -- value-report --dir <repo>` (CLI fallback) to compute watermark, chain status, git metrics, unit evidence, candidates, and estimate anchors.
2. Run `value-usage` (MCP tool) or `npm run wiki -- value-usage --dir <repo> --since <window_start> --until <window_end>` using the dates from step 1.
3. Run `create --prefix VAL` to scaffold `wiki/value-reports/VAL-XXXX.md`.
4. Present the candidate list and computed numbers to the **operator** for confirm/reject; collect `operator_assessment`. You may never confirm candidates or self-attest units yourself — operator-only gate.
5. Fill the record per `wiki/templates/value.md` (tool-filled fields from step 1, scraped fields from step 2, operator fields from step 4, agent-judged narrative grounded in the returned WK ids). Agent adjustments to the estimate are downward-only with justification.
6. Print the ROI line: `shipped <units_valued> working units; agents cost $<cost_usd> / <total_tokens> tokens; <time_saved_days> human-days vs. baseline (~<speedup>×, floor-anchored)`.

Rules: report every watermark span — never skip a poor one; null and negative results are stated plainly. Never edit a prior VAL record.

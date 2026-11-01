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

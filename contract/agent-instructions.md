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
- Dispatch: multi-agent handoff protocol — author HOs (`create-handoff`), dispatch workers
  (Pi/codex/claude in bwrap jail), capture results, review, merge. The dispatch MCP server
  instructions carry the full orchestration recipe (dispatch loop, polling, kind routing,
  fix-up budget, merge/cleanup, wiki-update-after-completion). Prefer `kb-dispatch` MCP
  tools; CLI fallback `npm run dispatch -- …`.
- For pipeline work, delegate via kb-dispatch; do not spawn Claude Code subagents or
  workflows unless the operator explicitly approves.
- Graph: kb CLI (`npm run graph -- --dir <this repo>`).
- Dashboard: `npm run dashboard -- <ID> --dir <this repo>` generates a self-contained HTML tracker
  for PLN, IN, or WK-set records. Output: `wiki/dashboard/<ID>.html`. See `docs/dashboard.md` in the
  kb checkout.
- Always pass `dir` pointing at this repository; run kb from its own checkout, not this repo root.
- Do not create `HO-*` via `wiki create` — handoffs are dispatch-owned under `wiki/handoffs/`.
- If wiki records and code/tests disagree, report the mismatch rather than trusting a grep-first conclusion.

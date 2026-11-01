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

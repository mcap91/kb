## kb — dispatch

- Dispatch is the multi-agent handoff protocol: author HOs (`create-handoff`), dispatch workers in the bwrap
  jail, capture results, review, merge. The dispatch MCP server instructions carry the full orchestration
  recipe. Prefer `kb-dispatch` MCP tools; CLI fallback `npm run dispatch -- …`.
- For pipeline work, delegate via kb-dispatch; do not spawn coding-agent subagents or workflows unless the
  operator explicitly approves.
- `HO-*` handoffs are dispatch-owned (`wiki/handoffs/`, excluded from wiki scans); never create them via
  `wiki create`.
- Least privilege: grant a worker only what the job needs. `write_scope`, `data_mounts`, `export_mounts`,
  `credentials`, `web` and `runtime_envs` start empty; each grant names the job step that needs it. When in
  doubt, leave it out; a refused run costs less than a leak.
- A `write_scope` entry refuses, for every family, naming only the entry, if it has a `.git` path
  segment or resolves to the repo root (`""`, `.`, `./`, `/`) — refused at authoring and again at
  dispatch. A root-level file entry (e.g. `README.md`) is fine: every family binds it as an exact file,
  never the directory around it.
- Merges go through `merge-delivery` only — never by hand. After a merge, run this repo's validation command
  on the host and record the result in the WK.

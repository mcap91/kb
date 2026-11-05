Roles arrive in this repo by `sync-contract`: `/planner` with the planning layer, `/orchestrator` and
`/overseer` with the dispatch layer (in Codex, `$planner`, `$orchestrator`, `$overseer`).
Skills arrive in this repo by `sync-contract`, never user-global. This block is managed by kb and
overwritten on sync; this repo's own rules, environment registry, and where-code-goes map live below the
end marker, where kb never writes.

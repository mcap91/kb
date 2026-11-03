Roles (`/planner`, `/orchestrator`, `/overseer`) install user-global via `install-roles` from the kb
checkout. Skills (`/resolve`) arrive in this repo by `sync-contract`, never user-global. This block is
managed by kb and overwritten on sync; this repo's own rules, environment registry, and where-code-goes
map live below the end marker, where kb never writes.

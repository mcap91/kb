# Install the Dispatch Layer

The dispatch layer adds kb's multi-agent handoff protocol to a repo that already has the wiki layer
([adoption.md](./adoption.md)). Dispatch implies planning: installing dispatch also installs the
[planning layer](./install-planning.md), whether or not you ran `init-planning`.

Dispatch adds:

- the kb-dispatch section of the managed block, and the `kb-dispatch` MCP server entry
- the orchestrator and overseer roles: `/orchestrator` and `/overseer` in Claude Code
  (`.claude/commands/`), `$orchestrator` and `$overseer` in Codex (`.agents/skills/`)
- the handoff template, `wiki/templates/handoff.md`, and the `wiki/handoffs/` directory
- the repo-local config tables in `wiki/.dispatch/`

Dispatch runs workers in a bubblewrap jail, so it needs Linux with user namespaces.

Run the commands from the `kb` checkout, with `MY_REPO` set to your repo's absolute path.

## Install

<!-- install-smoke: dispatch -->
```bash
npm run dispatch -- init-dispatch --dir "$MY_REPO"
npm run wiki -- sync-contract --dir "$MY_REPO"
```

`init-dispatch` creates `wiki/.dispatch/`. `sync-contract` then writes the dispatch and planning
surfaces and prints each path. For a Codex repo, add `--mcp-client codex` to the `sync-contract`
command and run the `codex mcp add kb-dispatch ...` command it prints.

`init-dispatch` writes each config file only if it is absent:

- `wiki/.dispatch/models.json` -- model slug to backend + provider `model_id` (starts blank `{}`)
- `wiki/.dispatch/backends.json` -- backend name to family/base_url/api_key_env/secrets_file (starts blank `{}`)
- `wiki/.dispatch/profiles.json` -- credential profiles (starts `{"schema_version": 1}`)
- `wiki/.dispatch/README.md` -- reference docs for the tables above, including example entries

Edit `models.json` and `backends.json` to register at least one model/backend pair before dispatching
(see the generated README for the shape). A local model server (Ollama, vLLM) is just a `pi`-family
backend entry pointed at a `base_url`.

## Remove

Move `wiki/.dispatch/` out of `wiki/`, then sync. Move it, do not delete it: it holds the config tables
you edited.

```bash
mv "$MY_REPO/wiki/.dispatch" "$MY_REPO/dispatch-config-backup"
npm run wiki -- sync-contract --dir "$MY_REPO"
```

Sync removes the dispatch and planning surfaces and lists each one under `Removed:`. It never deletes
`wiki/handoffs/` or the records in it. To keep the planning layer, run `init-planning` before the sync
([install-planning.md](./install-planning.md)).

## Using dispatch

The Dispatch Protocol enables reviewed multi-agent handoff workflows (see
[docs/dispatch-protocol.md](./dispatch-protocol.md) for the full technical reference). `dispatch` is one
atomic, gated call — admission, clone, jail, worker, delivery, and capture all happen inside a single
`dispatch` invocation. There is no separate global operator registry and no pre-launch review-token step;
dispatch config is repo-local, under the consuming repo's own `wiki/.dispatch/`.

### 1. Check the Host

Probe bubblewrap/container/writability facts before your first dispatch:

```
npm run dispatch -- check-environment
```

`dispatch` gates every call on the same live bubblewrap probe (does the binary run, does a
`--unshare-user` round trip succeed); `check-environment` runs that identical probe on demand plus
informational container detection so you can see what a real `dispatch` call will do on this host.

If a host cannot satisfy the required bubblewrap capability, the right response depends on the host. On
a **shared / multi-tenant** host (workstation, shared VM), treat it as a host problem: the kernel sandbox
is a real boundary, so prefer fixing the host and do not weaken permissions to work around it. On a
**single-tenant container pod** (Saturn Cloud, Posit, generic Kubernetes), bubblewrap cannot run and
cannot be fixed from inside the pod — `dispatch` fails closed with `NO_ISOLATION_ROUTE` there. `kb` does
not ship a weaker-permission fallback profile by default.

### 2. Write a Handoff

Create a durable handoff in your repo:

```
npm run dispatch -- create-handoff --dir "$MY_REPO" --title "Fix authentication bug" --subject "Authentication" --allowed-agents codex,claude --mode implement --work-item WK-0001 --write-scope src/auth.ts,tests/auth.test.ts --read-first AGENTS.md,wiki/issues/WK-0001.md
```

This writes `wiki/handoffs/HO-XXXX.md`. You can also author handoffs manually if needed, but `dispatch create-handoff` is the default path.

Fill in or refine:

- `allowed_agents`
- `mode`: `implement`, `code_review`, `redteam`, `research`, or `explore_code`
- `write_scope`
- `## Read First`
- `## Objective`
- `## Constraints`
- `## Expected Output`
- `## Context`

`write_scope` entries may be file paths or directory paths, repo-relative. Only `implement` mode may
deliver a commit; `code_review`/`redteam`/`research`/`explore_code` must carry an empty `write_scope` and never gain
write authority inside the jail regardless of what the HO asks for.

### 3. Dispatch and Wait

Run the handoff through the v2 pipeline:

```
npm run dispatch -- dispatch --dir "$MY_REPO" --handoff wiki/handoffs/HO-0001.md
```

`dispatch` always runs in the background and returns a `runId` immediately. Wait for it to reach a
terminal status:

```
npm run dispatch -- wait-for-run --dir "$MY_REPO" --run-id RUN-<uuid>
```

For `implement` mode, a successful run lands a scope-checked commit onto `refs/heads/dispatch/HO-XXXX`
and writes the result to `wiki/handoffs/HO-XXXX.response.md` (both auto-committed). Advisory modes
(`code_review`/`redteam`/`research`/`explore_code`) never deliver a commit — the worker's response is the deliverable.

If admission fails, `dispatch` refuses synchronously, before any worker spawns, with a structured
refusal code (`MISSING_WRITE_SCOPE`, `DIRTY_REPO`, `NO_ISOLATION_ROUTE`, and others — see
[docs/dispatch-protocol.md](./dispatch-protocol.md#refusal-codes)).

### Consultation Handoffs

Use the existing handoff schema for advice or design review:

- `mode: code_review`
- `write_scope: []`
- put questions and decision context in `## Objective` and `## Context`
- ask for short answers, rationale, risks, and recommended plan adjustments in `## Expected Output`

Do not add a separate `consult` mode. HOs are route-neutral packets: they can be read manually or
dispatched through the pipeline. With `write_scope: []`, the worker gets no write authority regardless
of what the HO asks for.

### Claude After June 15, 2026

The default dispatch `claude` backend uses Claude Code print mode. Anthropic has announced that,
starting June 15, 2026, Claude Code `--print` / `-p` and Agent SDK usage on Max plans draws from
separate Agent SDK credits instead of normal interactive Claude usage.

If you do not want a separate Anthropic API or Agent SDK billing path, do not rely on dispatch-launched
Claude automation. Use Claude interactively as the parent/operator with kb MCP tools, or have Claude
read and answer HOs manually. For dispatch-launched automation, use Codex or a local-agent backend entry.

Local models such as Qwen/Ollama should be registered as a `pi`-family entry in `wiki/.dispatch/backends.json`
pointed at the local server's `base_url` — there is no separate pluggable-agent-wrapper mechanism.

### Status and Cleanup

Check dispatch state:

```
npm run dispatch -- status --dir "$MY_REPO"
```

`status` returns active runs (model, delivery status, branch, heartbeat age, log tail) plus the 10 most
recent terminal runs. Use that output to decide whether to call `wait-for-run` or continue other work.

Clean up stale state (orphan run/review directories past the retention window, stale/expired tokens):

```
npm run dispatch -- cleanup --dir "$MY_REPO"
```


## MCP Tools

Dispatch MCP exposes:

- `init-dispatch`
- `check-environment`
- `create-handoff`
- `dispatch`
- `status`
- `cleanup`
- `derive-review`
- `merge-delivery`
- `restamp`
- `stop-run`

`dispatch` always runs in background mode: the tool returns a `runId` immediately, plus a `watch`
command to poll for terminal status. `wait-for-run` and `init-dispatch` are also available as
`dispatch-cli` subcommands; `derive-review`, `merge-delivery`, and `stop-run` are MCP-only today.

Typical MCP dispatch workflow (see [docs/dispatch-protocol.md](./dispatch-protocol.md#post-run-lifecycle-tools-wk-0132)
for the full orchestration recipe):

1. Create or reuse a `wiki/handoffs/HO-*.md` with `create-handoff`.
2. Dispatch it; background mode returns `runId` and a `watch` command.
3. Poll or wait for terminal status, then read `wiki/handoffs/HO-XXXX.response.md`.
4. On a delivered `implement` HO, derive a `code_review` HO with `derive-review`.
5. Dispatch the review HO the same way; read its response doc.
6. On a passing review, merge the delivery branch with `merge-delivery`.

Each wiki or dispatch tool call accepts a `dir` parameter to target a consuming repo.

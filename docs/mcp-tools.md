# kb MCP Tools Reference

The one-page contract for kb's two **local stdio** MCP servers, so the wiki-search-first
retrieval flow can confirm the tool set without calling `tools/list`. Both servers run as
single-user stdio subprocesses (`node --import tsx … server.ts`, registered in `.mcp.json`)
using the SDK's high-level `McpServer` + `registerTool` API.

## Conventions

- **`dir`** — every tool that targets a repo takes a `dir` pointing at the consuming repository.
- **Output** — tool results are the operation's JSON, serialized as a single `text` content block.
- **Errors** — handled failures return `{ ok: false, error, message, detail? }` in the content;
  an unexpected throw returns the same `{ ok: false, error: "INTERNAL_ERROR", message }` envelope
  with `isError: true` (WK-0046 T4). No raw `Error: <internal>` strings are leaked.
- **Annotations** (WK-0046 T15) — each tool advertises `annotations.readOnlyHint`
  (and `destructiveHint` for dispatch); operator-setup / execution tools also carry
  `_meta["io.kb/audience"] = "operator"` so an agent can tell them from routine agent tools.

## kb-wiki (13 tools)

| Tool | Purpose | Required | Optional | Notes |
|------|---------|----------|----------|-------|
| `bootstrap` | Bootstrap wiki structure in a consuming repo | `dir`, `repo` | `dryRun`, `mcpClient`, `agentInstructions` | operator |
| `sync-contract` | Sync contract templates into a bootstrapped repo | `dir` | `check`, `mcpClient`, `agentInstructions`, `adopt` | operator |
| `allocate-id` | Peek/reserve the next id for a prefix (idempotent) | `dir`, `prefix` | `verbose` | read-only |
| `create` | Create a new record from a template | `dir`, `prefix`, `title` | `verbose` | |
| `lint` | Lint records for frontmatter errors | `dir` | `verbose` | read-only |
| `generate` | Generate standard views (catalog, now, inbox, backlog, archive) | `dir` | `verbose` | |
| `build-search-index` | Build the wiki search index | `dir` | `verbose` | |
| `search` | Search wiki records and docs | `dir`, `query` | `prefix`, `status`, `verbose` | read-only |
| `import-plan` | Import design/execution artifacts into a PLN bundle | `dir`, `plan`, `design` | `execution`, `sourceTool`, `overwrite` | |
| `validate-plan` | Validate a PLN record and companion bundle | `dir`, `plan` | — | read-only |
| `archive-plan` | Mark a PLN done without moving its bundle | `dir`, `plan` | — | |
| `value-report` | Compute deterministic git+graph metrics for a VAL | `dir` | `since`, `untilRef` | read-only |
| `value-usage` | Own the Claude+Codex JSONL read, price via a vendored LiteLLM table (by model+provider) for a date window | `dir`, `since`, `until` | — | read-only |

## kb-dispatch (9 tools)

| Tool | Purpose | Required | Optional | Notes |
|------|---------|----------|----------|-------|
| `init-config` | Initialize operator dispatch config + default registry | — | `force` | operator |
| `check-environment` | Probe host sandbox capabilities; persist the record | — | — | |
| `create-handoff` | Create a repo-local HO handoff document | `dir`, `title`, `subject`, `allowed_agents`, `mode`, `acceptance`, `validation` | `status`, `depends_on`, `area`, `initiative`, `work_item`, `write_scope`, `read_first`, `objective`, `constraints`, `expected_output`, `context`, `web`, `credentials`, `data_mounts`, `export_mounts`, `base_ref`, `vars`, `verbose` | |
| `status` | Show dispatch token and run status | `dir` | — | read-only |
| `cleanup` | Clean up stale dispatch reviews, runs, and tokens | — | `dir`, `maxAgeDays`, `verbose` | destructive |
| `dispatch` | Run the v2 dispatch pipeline (gate → clone → jail → worker → delivery → capture); returns a `watch` command | `dir`, `handoff`, `model`, `backend` | `effort`, `preflight`, `verbose` | operator, destructive |
| `derive-review` | Create a code_review HO from a delivered implement HO | `dir`, `handoff_id` | — | operator |
| `init-dispatch` | Scaffold wiki/.dispatch/ config tables (models, backends, profiles) + managed README | `dir` | `force` | operator |
| `merge-delivery` | Merge a delivery branch into the target after review pass; gates on review evidence | `dir`, `handoff_id` | — | operator, destructive |

## Not applicable (by design)

These are local single-user stdio servers: no HTTP transport, sessions, auth, or multi-tenant
routing. The MCP 2026-07-28 stateless/v2 features target networked fleets and do not apply here —
see [DEC-0004](../wiki/decisions/DEC-0004.md).

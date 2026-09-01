# Dispatch Protocol Reference

Technical reference for the `kb` Dispatch Protocol -- a reviewed multi-agent handoff system.

## Trust Model

The Dispatch Protocol separates trusted operator-owned state from untrusted agent input:

**Operator-owned (trusted):**

- Config directory and its contents
- Agent registry (`launchers.v1.json`)
- HMAC signing key (`token.key`)
- Token state directories and token files
- The `--reviewed-and-accept-risks` acknowledgment

**Untrusted input:**

- HO-\* handoff documents in `wiki/handoffs/`
- Handoff frontmatter fields
- Read First file references
- Agent responses

The operator reviews every handoff before launch. The system validates, hashes, and signs the reviewed state so it cannot be tampered with between review and launch.

## State Machine

Dispatch tokens move through four lifecycle states:

```
              review
  (handoff) ---------> pending/
                           |
                       launch (verify hashes)
                           |
                       launching/
                          / \
            (success)    /   \    (failure/expiry)
                        v     v
                  consumed/  rejected/
```

Each state corresponds to a subdirectory under the operator config directory:

| State | Directory | Meaning |
|-------|-----------|---------|
| pending | `<config>/pending/` | Review complete, awaiting launch |
| launching | `<config>/launching/` | Launch has claimed the review token but has not yet confirmed child process start |
| consumed | `<config>/consumed/` | Child process start was confirmed; terminal run outcome lives in repo-local metadata |
| rejected | `<config>/rejected/` | Expired review or launch failed before confirmed child start |

Tokens are JSON files named `<reviewId>.json`. They are moved between state directories atomically.

## Config Directory

### Platform-Aware Paths

| Platform | Primary Path | Fallback |
|----------|-------------|----------|
| Windows | `%APPDATA%\kb-dispatch\` | `%USERPROFILE%\.config\kb-dispatch\` |
| POSIX | `~/.config/kb-dispatch/` | -- |

### Contents

```
kb-dispatch/
  token.key              HMAC-SHA256 signing key (hex-encoded, 64 bytes)
  launchers.v1.json      Agent registry
  pending/               Tokens awaiting launch
  launching/             Tokens between claim and confirmed child start
  consumed/              Tokens for confirmed started launches
  rejected/              Tokens for failed pre-start launches or expired reviews
```

`init-config` creates this structure, generates the key, and writes a default registry.

## Handoff Authoring

Handoffs are durable repo-local documents in `wiki/handoffs/HO-XXXX.md`.

Creation paths:

- `dispatch create-handoff` allocates the next `HO-XXXX` ID by scanning `wiki/handoffs/`
- manual authoring is still supported for exceptional cases
- `wiki create` does not support `HO`

The handoff markdown is the operator-visible source of truth. Runtime state is kept separately under `.agent-runs/`.

## Handoff Format

Handoff documents are markdown files in `wiki/handoffs/` with YAML frontmatter.

### Required Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `1` (literal) | Schema version, must be 1 |
| `id` | string | Handoff ID (e.g. `HO-0001`) |
| `title` | string | Human-readable title |
| `subject` | string | Topic or subject area |
| `allowed_agents` | string[] | Agents permitted to execute |
| `mode` | enum | One of: `implement`, `code_review`, `redteam` |

### Optional Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `status` | enum | `draft`, `reviewed`, `launched`, `completed`, `failed` |
| `created` | string | ISO date |
| `updated` | string | ISO date |
| `depends_on` | string[] | Record IDs this depends on |
| `area` | string | Area slug |
| `initiative` | string | Initiative ID |
| `work_item` | string | Work item ID |
| `write_scope` | string[] | Repo-relative file or directory paths the agent should modify |

### Forbidden Frontmatter Fields

Review rejects any handoff containing these fields:

- `_path`, `_paths`, `_dir`, `_dirs`
- `outputs`, `command`, `cwd`, `model`, `permissions`
- Any field ending in `_path`, `_paths`, `_dir`, or `_dirs`

These are forbidden because they could allow the handoff to influence execution paths, working directories, or permissions -- all of which are operator-controlled.

### Read First Rules

The `## Read First` section in the handoff body lists files the agent should read before starting. Rules:

- Entries must be bare repo-relative paths (one per bullet)
- Absolute paths are rejected
- Markdown links are rejected
- Path traversal (`..`) is rejected
- Every referenced path must exist at review time

Example:

```markdown
## Read First

- AGENTS.md
- packages/wiki-core/src/types.ts
- contract/manifest.json
```

### Handoff Size Limit

Handoff files must not exceed 1 MB (1,048,576 bytes).

## Review Process

The review operation (`dispatch-core/src/review.ts`) validates a handoff and creates an immutable bundle.

### What Review Validates

1. Handoff file exists and is within size limit
2. YAML frontmatter parses correctly
3. No forbidden fields are present
4. Required fields pass Zod schema validation
5. Requesting agent is in the handoff's `allowed_agents` list
6. Read First paths are valid repo-relative paths that exist
7. `write_scope` paths are relative, stay inside the repo root, and are normalized into reviewed access directories
8. Agent exists in the operator's registry

### Immutable Bundle Creation

On successful validation, review creates:

```
.agent-runs/reviews/RV-<uuid>/
  agent-visible/
    wrapper.md
    handoff.snapshot.md
    context/
      <hashed-file-1>.<ext>
      <hashed-file-2>.<ext>
  metadata/
    input-manifest.json
    review.json
```

Read First files are copied into `agent-visible/context/` using stable hashed filenames. `metadata/input-manifest.json` records the original repo-relative source paths, the snapshot paths, and the reviewed `write_scope` data used later at launch time.

### Hash Capture

Review captures two hashes:

- **Input manifest hash**: SHA-256 of the serialized `metadata/input-manifest.json` file. Detects tampering with the handoff bundle and reviewed launch inputs.
- **Registry hash**: SHA-256 of the `launchers.v1.json` content. Detects changes to agent configurations between review and launch.

### Pending Token

Review creates a signed token containing:

- `reviewId` -- unique review ID (`RV-<uuid>`)
- `handoffId` -- the handoff's `id` field
- `agent` -- the selected agent name
- `mode` -- the handoff's mode
- `repoRoot` -- resolved repository root path
- `inputManifestHash` -- hash of the bundle
- `registryHash` -- hash of the registry
- `expiry` -- 30 minutes from review time

The token is HMAC-signed with the operator's `token.key` and written to `<config>/pending/<reviewId>.json`.

## Launch Process

The launch operation (`dispatch-core/src/launch.ts`) executes a reviewed handoff.

### Launch Sequence

1. **Load pending token** -- read from `pending/<reviewId>.json`
2. **Verify token signature** -- HMAC verification with `token.key`
3. **Check token expiry** -- reject if past expiry time
4. **Verify repo root** -- confirm the directory exists
5. **Re-verify bundle hash** -- recompute hashes of all files in the review bundle and compare against the token's `inputManifestHash`
6. **Re-verify registry hash** -- recompute hash of `launchers.v1.json` and compare against the token's `registryHash`
7. **Load agent config** -- look up the agent in the registry
8. **Resolve executable** -- bare `base_argv[0]` commands are resolved to executable paths using PATH plus platform fallback directories; path-bearing commands are left unchanged
9. **Check or refresh host capabilities** -- consult the operator-owned `host-capabilities.v1.json` record and refresh it when missing or stale for the current registry hash
10. **Gate unsupported hosts** -- refuse launches when the selected agent requires a known-unsupported sandbox capability
11. **Pre-flight reviewed write scope** -- verify each reviewed `write_scope` target or access directory is reachable from the host
12. **Move token to launching/** -- atomic state transition
13. **Create run directory** -- `.agent-runs/runs/<handoffId>/RUN-<uuid>/`
14. **Copy reviewed bundle** -- copy `agent-visible/` and metadata into the run directory
15. **Build filtered environment** -- only allowlisted env vars plus `AGENT_BLACKBOARD_*` variables
16. **Write initial launch metadata** -- `metadata/launch.json` with `token_state = launching`
17. **Spawn agent** -- child process with `cwd = agent-visible`, no TTY, and redirected stdout/stderr
18. **Record live runtime state** -- write `metadata/state.json` with `status = launching`, `pid`, `pgid`, and `heartbeat_at`
19. **Confirm child start** -- move token to `consumed/` and update `metadata/launch.json.token_state = consumed`
20. **Stream response/logs live** -- `stdout_capture` adapters stream stdout directly to `response.md`; file adapters stream stdout to `metadata/stdout.log`; stderr streams to `metadata/stderr.log`
21. **Write final metadata** -- on terminal exit, write `metadata/meta.json`, update `metadata/state.json` to a terminal status, and keep `launch.json.token_state = consumed` for started runs

### Reviewed Bundle Invariant

The agent process is always spawned with `cwd` set to the reviewed `agent-visible/` directory inside the run bundle. The handoff cannot override this. This ensures the agent sees the reviewed snapshot, not the live repo root.

### Environment Allowlist

Launch constructs a filtered environment for the agent process. Only these categories of variables are passed:

**Always included (if set):**
`HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`

**Windows-only additions:**
`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`

**Dispatch-specific (always set):**

| Variable | Value |
|----------|-------|
| `AGENT_BLACKBOARD_REPO_ROOT` | Resolved repo root path |
| `AGENT_BLACKBOARD_RUN_DIR` | Run directory path |
| `AGENT_BLACKBOARD_AGENT_VISIBLE_DIR` | `agent-visible/` directory inside the run bundle |
| `AGENT_BLACKBOARD_HANDOFF_PATH` | Path to `agent-visible/handoff.snapshot.md` |
| `AGENT_BLACKBOARD_CONTEXT_DIR` | Path to `agent-visible/context/` |
| `AGENT_BLACKBOARD_RESPONSE_PATH` | Launcher-owned response path |
| `AGENT_BLACKBOARD_REVIEW_ID` | The review ID |
| `AGENT_BLACKBOARD_RUN_ID` | The run ID (`RUN-<uuid>`) |

**Launcher-configured env:** Additional variables from the agent's `env` field in the registry.

### Reviewed `write_scope` and Claude Sandbox Access

`write_scope` remains HO-authored intent, but launch only acts on the reviewed manifest form.

For non-redteam Claude launches:

- dispatch derives a directory allowlist from reviewed `write_scope`
- file paths widen to their parent directory
- directory paths stay as themselves
- missing paths widen to the nearest existing parent directory inside the repo
- each reviewed directory is passed as `--add-dir <absolute-directory>`

Dispatch does **not** automatically add `--add-dir <repoRoot>`. If a root-level file is in `write_scope`, the reviewed access directory becomes the repo root as a consequence of that declared scope.

This is directory-granularity access, not exact per-file enforcement. That is a Claude sandbox limitation, not a dispatch review-model gap.

Redteam mode is unchanged. No `--add-dir` flags are added there.

### Host Capability Record

Dispatch maintains an operator-owned host capability record at:

```text
<configDir>/host-capabilities.v1.json
```

`dispatch check-environment` probes the current host, persists that record, and prints a route-viability report. Launch also refreshes the record automatically when it is missing or when the current registry hash differs from the recorded one.

The record tracks **facts, not decisions**:

- Linux bubblewrap capabilities that matter to shipped agents:
  - basic sandbox startup for Codex (bwrap probe)
  - basic sandbox startup for Claude (bwrap probe)
  - additional writable directory mounts for Claude non-redteam `write_scope` (bwrap bind-mount probe)
- container-detection signals: `KUBERNETES_SERVICE_HOST`, `/.dockerenv`, and the first line of `/proc/1/cgroup`
- writability of `$HOME` and of the resolved config store

From those facts, `check-environment` derives a plain per-route verdict (computed, not persisted): plain adapters, headless Claude, `write_scope` enforcement level (kernel vs app-level), Codex, and redteam. Run it first on any new host to see what dispatch can do there.

Gating consumes the record at launch time:

- **redteam** still fails closed: a launch is blocked when the required kernel sandbox is **known unsupported** for the selected agent.
- **non-redteam** launches are never hard-stopped by a bwrap probe. Codex is not gated on a bwrap probe at all (it sandboxes with Landlock, not bubblewrap). Headless Claude does not hard-require bubblewrap. When Claude has a non-empty reviewed `write_scope` and the additional-directory bind-mount probe is unsupported, the launch still proceeds and passes `--add-dir`, but records a warning in the run's `metadata/launch.json` that `write_scope` enforcement is app-level only on that host — the kernel-backed guarantee is lost, the capability is not.

### Empty Response Failure

If the agent starts successfully but produces no response body, the launch is considered failed closed. The launcher writes a diagnostic `response.md`, records terminal run status as `failed`, and returns `EMPTY_RESPONSE`. The token remains `consumed/` because child start was already confirmed.

## Status

The status operation (`dispatch-core/src/status.ts`) reports operator token counts and repo-local
run counts. Active launches are derived from `.agent-runs/runs/**/metadata/state.json`, not from
token directories alone, so a consumed token with a live child process still appears as active.

Each active launch entry includes the review ID, run ID, handoff ID, agent, mode, `status`, run
directory, response path, metadata paths, controller path when present, stdout/stderr paths,
heartbeat timestamps, and recorded process IDs. This lets MCP callers poll `status` and decide
whether to wait, retrieve partial artifacts, or launch follow-up work without scanning run
directories themselves.

## Cleanup

The cleanup operation (`dispatch-core/src/cleanup.ts`) removes stale dispatch artifacts.

### Operations

1. **Remove orphan reviews** -- review bundles in `.agent-runs/reviews/` with no corresponding token in any state directory, older than the retention threshold (default 7 days).

2. **Remove orphan runs** -- run directories in `.agent-runs/runs/` whose review metadata references a review ID not present in `.agent-runs/reviews/`, older than the retention threshold.

3. **Recover stale launching tokens** -- tokens stuck in `launching/` are reconciled against repo-local run metadata. Cleanup does not recover a launching token while the associated run still has a fresh heartbeat or a live recorded process. Terminal run states recover the token into `consumed/` for started runs (`completed`, `failed`, `timed_out`, `cancelled`) or `rejected/` for pre-start rejection.

4. **Remove expired consumed/rejected tokens** -- tokens in `consumed/` or `rejected/` older than the retention threshold. Deleted.

### CLI Usage

```
npm run dispatch -- cleanup --dir ../my-project
npm run dispatch -- cleanup --dir ../my-project --verbose
```

## Agent Registry

The agent registry (`launchers.v1.json`) maps agent names to launcher configurations.

### Format

```json
{
  "version": 1,
  "agents": {
    "agent-name": {
      "base_argv": ["executable"],
      "noninteractive_argv": ["--flag"],
      "instruction_transport": { "kind": "argv_content" },
      "wrapper_arg": ["{wrapper_content}"],
      "response_transport": { "kind": "file" },
      "response_arg": ["-o", "{response_path}"],
      "timeout_seconds": 1800,
      "read_only": {
        "supported": true,
        "argv_suffix": ["--sandbox", "read-only"],
        "response_writable": true
      },
      "description": "Human-readable description",
      "env": {
        "EXTRA_VAR": "value"
      }
    }
  }
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `base_argv` | yes | Base executable and fixed argv prefix |
| `noninteractive_argv` | yes | Additional non-interactive flags |
| `instruction_transport` | yes | How the wrapper reaches the agent: `stdin`, `argv_content`, or `argv_path` |
| `wrapper_arg` | sometimes | Required for non-stdin transports; accepts `{wrapper_content}` or `{wrapper_path}` |
| `response_transport` | yes | How the agent returns output: `file` or `stdout_capture` |
| `response_arg` | for file transport | Args containing `{response_path}` |
| `timeout_seconds` | no | Per-launch timeout |
| `read_only` | no | Required for `redteam` compatibility |
| `description` | no | Human-readable description |
| `env` | no | Additional environment variables to set |
| `model_injection` | no | How model/effort overrides are injected at launch time (see Model/Effort Passthrough) |

`base_argv[0]` may remain a portable bare command such as `claude` or `codex`. At launch time,
dispatch resolves bare commands using PATH and safe platform fallback directories, including common
POSIX command directories, before calling `spawn` without `shell: true`. Absolute and relative
path commands, such as the generated `fake-agent` entry, are used as written.

The registry is the model boundary. Handoffs cannot choose a model, command, working directory, or
permission profile; those remain operator-owned registry decisions. This keeps HOs portable across
Claude, Codex, local model wrappers, and fake agents.

### Default Agents

`init-config` writes a default registry with three agents:

| Agent | Command | Purpose |
|-------|---------|---------|
| `claude` | `claude` with stdin transport and stdout capture | Claude Code CLI adapter |
| `codex` | `codex exec` with stdin transport and `-o {response_path}` | Codex CLI adapter |
| `fake-agent` | Absolute `tsx` binary plus absolute `tests/fixtures/fake-agent.ts` path in the `kb` checkout | Deterministic test agent for dogfooding and sister-repo validation |

The generated `claude` and `codex` entries are configured for non-interactive child runs against the
reviewed bundle. The child process does not need `kb` MCP tools for the core dispatch workflow.
The interactive parent/operator is the component that uses `kb-dispatch` MCP tools such as
`status`, `wait-for-run`, and `get-response` to monitor progress and retrieve artifacts.

The `read_only.argv_suffix` block is an additional restriction layer that is only appended for
`mode: redteam`. It constrains the launched child run; it is not the mechanism that gives the child
access to MCP tools.

### Claude Billing Constraint

The default `claude` profile uses Claude Code print mode: `claude --print --output-format text
--no-session-persistence`. Anthropic has announced that, starting June 15, 2026, Claude Code
`--print` / `-p` and Agent SDK usage on Max plans draws from separate Agent SDK credits instead of
normal interactive Claude usage.

`kb` does not require that separate billing path. If an operator does not want Agent SDK/API billing,
use Claude interactively as the parent/operator with kb MCP tools, or have Claude read and answer HOs
manually. Dispatch-launched Claude remains an optional operator-owned registry profile, not a required
route.

### Model/Effort Passthrough (WK-0069)

`dispatch launch` and `dispatch review-and-launch` accept optional `--model` and `--effort` flags. These let the operator or orchestrating agent select a model per run without editing the registry.

```
dispatch review-and-launch --dir . --handoff wiki/handoffs/HO-0010.md --agent codex \
  --model gpt-5.4 --effort high --reviewed-and-accept-risks
```

MCP callers pass `model` and `effort` as tool input params on the `launch` and `review-and-launch` tools.

**How injection works.** Each agent declares how it receives model/effort via the `model_injection` registry field:

| Kind | `model_injection` value | Effect |
|------|------------------------|--------|
| `argv` | `{ kind: "argv", model_flag: "--model", effort_flag: "--effort" }` | Flags inserted after `noninteractive_argv`, before wrapper/response args |
| `argv` (template) | `{ kind: "argv", model_flag: "-m", effort_args: ["-c"], effort_template: "model_reasoning_effort={effort}" }` | Model flag + effort via `-c` config override (Codex pattern) |
| `env` | `{ kind: "env", model_var: "OPENROUTER_MODEL" }` | Model set as env var in the filtered environment |

The default registry ships `model_injection` for `claude` and `codex`. Agents without `model_injection` (e.g. `fake-agent`) receive a warning when `--model` is passed; injection is skipped, and `model_passed_through: false` is recorded in `meta.json`.

**meta.json fields.** Every run records:

| Field | Value |
|-------|-------|
| `model` | The operator-supplied model string, or `null` |
| `effort` | The operator-supplied effort string, or `null` |
| `model_passed_through` | `true` if model was injected into argv/env; `false` if skipped |

Omitting `--model` behaves exactly as before. `model` remains a forbidden HO frontmatter field — model selection is an operator/orchestrator concern, not a handoff concern.

### Local Model Agents

Local models fit the same registry contract when they are wrapped as agent processes. A raw model CLI
such as Ollama/Qwen is not enough by itself unless it can read the reviewed bundle and write the
launcher-owned response. A local wrapper should:

- read `AGENT_BLACKBOARD_HANDOFF_PATH`
- read files from `AGENT_BLACKBOARD_CONTEXT_DIR` when needed
- call the local model runtime
- write the final answer to `AGENT_BLACKBOARD_RESPONSE_PATH`
- exit non-zero on runtime failure

### Adding an Agent

Edit `launchers.v1.json` in your config directory to add new agents:

```json
{
  "version": 1,
  "agents": {
    "my-agent": {
      "base_argv": ["/path/to/my-agent"],
      "noninteractive_argv": ["--mode", "auto"],
      "instruction_transport": { "kind": "stdin" },
      "response_transport": { "kind": "stdout_capture" },
      "description": "My custom agent"
    }
  }
}
```

After editing the registry, any pending review tokens become invalid because the registry hash will no longer match. You must re-review handoffs after registry changes.

### Linux Sandbox Caveat: Shared Hosts vs Single-Tenant Container Pods

Some Linux hosts cannot run the bubblewrap sandbox that Claude's `write_scope` -> `--add-dir` feature relies on. Failures appear as `bwrap` mount or namespace errors. How to respond depends on what kind of host it is — run `npm run dispatch -- check-environment` first and read the route verdicts.

**Shared / multi-tenant hosts (workstations, shared VMs).** Here the agent's kernel sandbox is a real isolation boundary, so a bwrap failure is an infrastructure problem to fix on the host:

- prefer fixing the host so the required sandbox can start
- do not weaken agent permissions just to get around a sandbox failure
- `redteam` fails closed on these hosts unless the kernel sandbox is available

**Single-tenant container pods (Saturn Cloud, Posit, generic Kubernetes).** On an ephemeral, single-tenant pod the *pod itself* is the isolation boundary; the agent's inner kernel sandbox is defense-in-depth, not the operative control. bubblewrap cannot start in a typical pod (default seccomp blocks `unshare`/`clone`, capabilities are dropped, `no-new-privileges` defeats the setuid fallback), and this is unfixable from inside the pod. "Fix the host" does not apply — use `check-environment` verdicts to pick a working route.

What degrades on a pod, and what does not:

- **Plain-process adapters** (`fake-agent`, the ollama adapter, custom wrappers) need no kernel sandbox and work as-is, given network reach to any model endpoint.
- **Headless Claude** (`claude --print`, empty `write_scope`) does not hard-require bubblewrap and is no longer gated on the bwrap probe.
- **Claude `write_scope`** still applies via `--add-dir`, but enforcement drops from kernel-backed to app-level; the run records a warning in `metadata/launch.json` saying so. The directories are still granted.
- **Codex** sandboxes with Landlock, not bubblewrap, so it is not gated on the bwrap probe. kb does not probe Landlock (parked); run `codex exec` to confirm viability. Platforms may also mount agent state paths (`~/.codex`) read-only as policy, which blocks Codex independently of kb.
- **redteam** still fails closed: app-level read-only is deliberately not accepted in place of a kernel sandbox.

**Runtime on pods (no `tsx` binary, no hanging probe).** Two implementation details make the routes above actually hold on a real pod:

- kb's CLIs and the `fake-agent` launcher run TypeScript through node's in-process tsx loader (`node --import tsx …`), never the `tsx` executable. The binary forks a helper and talks to it over a `/tmp` IPC socket, whose `listen()` a pod's seccomp policy blocks with `EPERM`; the loader registers its hooks in-process, so there is no socket. Invoke kb via `npm run …` (which uses the loader) rather than the `tsx` binary directly.
- `check-environment`'s bubblewrap probe is time-bounded. Under a pod's seccomp policy the probe can neither complete nor fail cleanly and would otherwise hang the whole report; it is killed after a bounded wait and recorded as `unsupported`, so the route report always returns.

**Read-only HOME recipe.** Many pods mount `$HOME` read-only, which breaks the config/token store (`FILE_WRITE_ERROR` at `init-config`/review, before gating is ever reached). Redirect the store to a writable directory with `XDG_CONFIG_HOME`:

```bash
export XDG_CONFIG_HOME="$PWD/.kbconfig"   # any writable dir (workdir, /tmp)
npm run dispatch -- init-config
npm run dispatch -- check-environment      # verify config-dir writable + route verdicts
```

On POSIX, `getConfigDir()` honors a set, non-empty `XDG_CONFIG_HOME` (`$XDG_CONFIG_HOME/kb-dispatch`) and otherwise falls back to `$HOME/.config/kb-dispatch`. `XDG_CONFIG_HOME` is on the launch env allowlist, so the redirected store is visible to launched agents too.

If an operator chooses to customize `launchers.v1.json` locally, that is an explicit local trust decision outside the shipped defaults. Any registry change requires re-reviewing pending handoffs because the registry hash is bound into review tokens.

### Fake Agent

The `fake-agent` entry points to the `kb` repo's `tests/fixtures/fake-agent.ts` via absolute paths written by `init-config`, run through node's in-process tsx loader (`node --import <tsx loader> …`) so it needs no `tsx` binary and works on container pods that block the binary's IPC pipe. The fixture runs inside the reviewed `agent-visible/` bundle, reads the handoff from `AGENT_BLACKBOARD_HANDOFF_PATH`, writes a fixed response to `AGENT_BLACKBOARD_RESPONSE_PATH`, and exits with code 0. It is used for:

- Automated testing in `tests/dispatch.test.ts`
- Dogfooding the full review-launch cycle
- Validating the dispatch pipeline without a real agent

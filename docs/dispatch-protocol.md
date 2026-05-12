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
| `write_scope` | string[] | Paths the agent should modify |

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
7. Agent exists in the operator's registry

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

Read First files are copied into `agent-visible/context/` using stable hashed filenames. `metadata/input-manifest.json` records the original repo-relative source paths and the snapshot paths.

### Hash Capture

Review captures two hashes:

- **Input manifest hash**: SHA-256 of all bundle file hashes, sorted by path. Detects tampering with the handoff or Read First files.
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
9. **Move token to launching/** -- atomic state transition
10. **Create run directory** -- `.agent-runs/runs/<handoffId>/RUN-<uuid>/`
11. **Copy reviewed bundle** -- copy `agent-visible/` and metadata into the run directory
12. **Build filtered environment** -- only allowlisted env vars plus `AGENT_BLACKBOARD_*` variables
13. **Write initial launch metadata** -- `metadata/launch.json` with `token_state = launching`
14. **Spawn agent** -- child process with `cwd = agent-visible`, no TTY, and redirected stdout/stderr
15. **Record live runtime state** -- write `metadata/state.json` with `status = launching`, `pid`, `pgid`, and `heartbeat_at`
16. **Confirm child start** -- move token to `consumed/` and update `metadata/launch.json.token_state = consumed`
17. **Stream response/logs live** -- `stdout_capture` adapters stream stdout directly to `response.md`; file adapters stream stdout to `metadata/stdout.log`; stderr streams to `metadata/stderr.log`
18. **Write final metadata** -- on terminal exit, write `metadata/meta.json`, update `metadata/state.json` to a terminal status, and keep `launch.json.token_state = consumed` for started runs

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

### Empty Response Failure

If the agent starts successfully but produces no response body, the launch is considered failed closed. The launcher writes a diagnostic `response.md`, records terminal run status as `failed`, and returns `EMPTY_RESPONSE`. The token remains `consumed/` because child start was already confirmed.

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

`base_argv[0]` may remain a portable bare command such as `claude` or `codex`. At launch time,
dispatch resolves bare commands using PATH and safe platform fallback directories, including common
POSIX command directories, before calling `spawn` without `shell: true`. Absolute and relative
path commands, such as the generated `fake-agent` entry, are used as written.

### Default Agents

`init-config` writes a default registry with three agents:

| Agent | Command | Purpose |
|-------|---------|---------|
| `claude` | `claude` with wrapper-content argv transport and stdout capture | Claude Code CLI adapter |
| `codex` | `codex exec` with wrapper-content argv transport and `-o {response_path}` | Codex CLI adapter |
| `fake-agent` | Absolute `tsx` binary plus absolute `tests/fixtures/fake-agent.ts` path in the `kb` checkout | Deterministic test agent for dogfooding and sister-repo validation |

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

### Codex Sandbox Caveat On Linux VMs

Some Linux VM or nested-container environments do not support the sandbox startup path used by the Codex CLI. The failure often appears as a `bwrap` / bubblewrap mount or namespace error before the agent reads the reviewed handoff.

What this means operationally:

- `codex` may launch correctly through dispatch but still fail before reading `handoff.snapshot.md`
- this is an infrastructure problem on the host, not a dispatch review/launch protocol problem
- `redteam` should still fail closed on those hosts unless a real read-only Codex sandbox is available

`kb` does not ship a default fallback profile that weakens Codex permissions for these hosts.

The recommended responses are:

- fix the host so the Codex sandbox can start successfully
- use a different host for Codex runs
- use Claude or another non-bwrap-dependent agent on that host for work that cannot tolerate sandbox startup failure

The supported recommendation in `kb` is:

- if Codex sandboxing is broken on a host, use Claude on that host or run Codex on a different host
- do not weaken Codex permissions just to get around the sandbox failure

If an operator chooses to customize `launchers.v1.json` locally, that is an explicit local trust decision outside the shipped defaults. Any registry change requires re-reviewing pending handoffs because the registry hash is bound into review tokens.

### Fake Agent

The `fake-agent` entry points to the `kb` repo's `tests/fixtures/fake-agent.ts` via absolute paths written by `init-config`. The fixture runs inside the reviewed `agent-visible/` bundle, reads the handoff from `AGENT_BLACKBOARD_HANDOFF_PATH`, writes a fixed response to `AGENT_BLACKBOARD_RESPONSE_PATH`, and exits with code 0. It is used for:

- Automated testing in `tests/dispatch.test.ts`
- Dogfooding the full review-launch cycle
- Validating the dispatch pipeline without a real agent

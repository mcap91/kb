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
| launching | `<config>/launching/` | Launch in progress, agent spawned |
| consumed | `<config>/consumed/` | Agent completed with non-empty response |
| rejected | `<config>/rejected/` | Expired, failed spawn, empty response, or hash mismatch |

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
  launching/             Tokens with active agent processes
  consumed/              Tokens for completed launches
  rejected/              Tokens for failed/expired launches
```

`init-config` creates this structure, generates the key, and writes a default registry.

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
  <handoff-filename>           Copy of the handoff file
  <read-first-file-1>         Copy of each Read First file (flattened names)
  <read-first-file-2>
  review-manifest.json         Manifest with file list, hashes, metadata
```

File names in the bundle are flattened: path separators are replaced with `__`.

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
- `expiry` -- 24 hours from review time

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
8. **Move token to launching/** -- atomic state transition
9. **Create run directory** -- `.agent-runs/runs/<handoffId>/RUN-<uuid>/`
10. **Build filtered environment** -- only allowlisted env vars plus `AGENT_BLACKBOARD_*` variables
11. **Write launch metadata** -- `launch-meta.json` in the run directory
12. **Spawn agent** -- child process with `cwd = repo_root`
13. **Capture response** -- read from `response.md` in run dir, or fall back to stdout
14. **Move token to consumed/** -- on non-empty response (or rejected/ on failure)
15. **Write final metadata** -- update `launch-meta.json` with exit code and timestamps

### cwd Invariant

The agent process is always spawned with `cwd` set to the repository root stored in the token payload. The handoff cannot override this. This ensures the agent operates from a known, operator-controlled location.

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
| `AGENT_BLACKBOARD_AGENT_VISIBLE_DIR` | Review bundle directory |
| `AGENT_BLACKBOARD_HANDOFF_PATH` | Path to `review-manifest.json` in bundle |
| `AGENT_BLACKBOARD_CONTEXT_DIR` | Same as agent visible dir |
| `AGENT_BLACKBOARD_RESPONSE_PATH` | Path where agent should write response |
| `AGENT_BLACKBOARD_REVIEW_ID` | The review ID |
| `AGENT_BLACKBOARD_RUN_ID` | The run ID (`RUN-<uuid>`) |

**Launcher-configured env:** Additional variables from the agent's `env` field in the registry.

### Empty Response Failure

If the agent produces no response (no `response.md` and no stdout), the launch is considered failed. The token is moved to `rejected/` and the error code is `EMPTY_RESPONSE`.

## Cleanup

The cleanup operation (`dispatch-core/src/cleanup.ts`) removes stale dispatch artifacts.

### Operations

1. **Remove orphan reviews** -- review bundles in `.agent-runs/reviews/` with no corresponding token in any state directory, older than the retention threshold (default 7 days).

2. **Remove orphan runs** -- run directories in `.agent-runs/runs/` whose `launch-meta.json` references a review ID not present in `.agent-runs/reviews/`, older than the retention threshold.

3. **Recover stale launching tokens** -- tokens stuck in `launching/` beyond the retention threshold or past their expiry. Moved to `rejected/`.

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
      "command": "executable",
      "args": ["arg1", "arg2"],
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
| `command` | yes | Executable to spawn |
| `args` | yes | Command-line arguments (array of strings) |
| `description` | no | Human-readable description |
| `env` | no | Additional environment variables to set |

### Default Agents

`init-config` writes a default registry with three agents:

| Agent | Command | Purpose |
|-------|---------|---------|
| `claude` | `claude` | Claude Code CLI (placeholder -- configure with your path) |
| `codex` | `codex` | Codex CLI (placeholder -- configure with your path) |
| `fake-agent` | Absolute `tsx` binary plus absolute `tests/fixtures/fake-agent.ts` path in the `kb` checkout | Deterministic test agent for dogfooding and sister-repo validation |

### Adding an Agent

Edit `launchers.v1.json` in your config directory to add new agents:

```json
{
  "version": 1,
  "agents": {
    "my-agent": {
      "command": "/path/to/my-agent",
      "args": ["--mode", "auto"],
      "description": "My custom agent"
    }
  }
}
```

After editing the registry, any pending review tokens become invalid because the registry hash will no longer match. You must re-review handoffs after registry changes.

### Fake Agent

The `fake-agent` entry points to the `kb` repo's `tests/fixtures/fake-agent.ts` via absolute paths written by `init-config`. This makes the default launcher work even though handoffs are launched with `cwd = repo_root` in the consuming repository. The fixture reads the handoff from `AGENT_BLACKBOARD_HANDOFF_PATH`, writes a fixed response to `AGENT_BLACKBOARD_RESPONSE_PATH`, and exits with code 0. It is used for:

- Automated testing in `tests/dispatch.test.ts`
- Dogfooding the full review-launch cycle
- Validating the dispatch pipeline without a real agent

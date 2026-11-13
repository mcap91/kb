/**
 * `init-dispatch` — scaffold `wiki/.dispatch/` (PLN-0004 S3 ruling 11 + D2/D4
 * freeze correction; write-once README per WK-0133 D2 / WK-0134). Creates the
 * repo-local `wiki/.dispatch/` dir, blank `models.json`/`backends.json`/
 * `profiles.json` tables, and a `README.md` — every file, including the
 * README, is written only if absent and never touched again on a re-run.
 * Does NOT stamp AGENTS.md or `.mcp.json` — those are already wiki-core
 * bootstrap/sync-contract jobs that cover kb-dispatch (ruling 11).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';

export interface InitDispatchOpts {
  dir: string;
  force?: boolean;
}

export interface InitDispatchResult {
  created: string[];
  updated: string[];
}

const BLANK_MODELS = '{}';
const BLANK_BACKENDS = '{}';
const BLANK_PROFILES = JSON.stringify({ schema_version: 1 }, null, 2);

// README content — write-once (WK-0133 D2 / WK-0134): written only if absent,
// never edited again on a re-run.
const README_CONTENT = `# wiki/.dispatch/ — Dispatch Configuration

This directory holds the repo-local dispatch configuration tables. Edit the JSON files
to configure models and backends for your repository.

## Files

| File | Purpose | Blank default |
|------|---------|---------------|
| \`models.json\` | Model slug → available backends + provider model_id | \`{}\` |
| \`backends.json\` | Backend name → family, base_url, api_key_env, secrets_file | \`{}\` |
| \`profiles.json\` | Credential profiles (schema_version 1, inject + optional endpoints) | \`{"schema_version": 1}\` |
| \`validation.json\` | Optional, not scaffolded: commands the host runs against a delivery before review (WK-0294; docs/dispatch-protocol.md "Host Validation Evidence") | absent = none |
| \`limits.json\` | Optional, not scaffolded: the operator cap on a handoff's \`timeout_secs\` (WK-0244) | absent = 1800s cap |

## Example models.json

\`\`\`json
{
  "deepseek": {
    "available_on": ["openrouter"],
    "model_id": "deepseek/deepseek-v4-flash-0731",
    "notes": "DeepSeek V4 Flash via OpenRouter"
  }
}
\`\`\`

## Example backends.json

Every entry needs a \`family\` (\`"pi"\` | \`"codex"\` | \`"claude"\`) naming which adapter
handles it. Set \`api_key_env\` (paired with \`secrets_file\`) to inject an API key, or
leave both \`null\` to use the CLI's own authentication (subscription seat, SSO).
\`base_url\` may be \`null\` too — for a SaaS backend the CLI reaches on its own (the
common case for codex/claude); set it only to point at a custom endpoint (Azure
OpenAI, a proxy, a local Ollama/vLLM server).

\`\`\`json
{
  "openrouter": {
    "family": "pi",
    "base_url": "https://openrouter.ai/api/v1",
    "api_key_env": "OPENROUTER_API_KEY",
    "secrets_file": "/home/user/.secrets/dispatch.env",
    "rate_key_prefix": "openrouter/",
    "request_params": {
      "provider": { "only": ["DeepInfra"], "data_collection": "deny" }
    }
  },
  "ollama": {
    "family": "pi",
    "base_url": "http://localhost:11434/v1",
    "api_key_env": null,
    "secrets_file": null
  }
}
\`\`\`

## rate_key_prefix (optional)

An optional string on a backend entry (WK-0266). The vendored
\`contract/token-rates.json\` rate table is keyed by LiteLLM canonical id, which for
OpenRouter is \`openrouter/<model_id>\`, not the bare \`model_id\`. The \`est_cost_usd\`
rate-table lookup key is exactly \`rate_key_prefix + model_id\` — there is no fallback
to the bare model id and no pattern or alias matching. A backend without
\`rate_key_prefix\` behaves exactly as before (empty-string default).

A lookup miss (no row at that exact key) renders \`est_cost_usd: unavailable\`, same as
today. The exact key looked up is always shown as the response doc's \`## Token
Detail\` \`rate_key\` row, so a misconfigured prefix is visible rather than silently
wrong.

Example: a backend with \`"rate_key_prefix": "openrouter/"\` running
\`deepseek/deepseek-v4.1-flash\` looks up \`openrouter/deepseek/deepseek-v4.1-flash\` in
the rate table, and the response doc shows \`| rate_key | openrouter/deepseek/deepseek-v4.1-flash |\`.

## request_params (optional)

An opaque \`Record<string, unknown>\` object on any backend entry. Its contents are passed
through verbatim into the API request body via Pi's \`samplingParams\` mechanism — kb
validates that it is an object but never inspects the contents. The backend's own API
validates the fields.

Use \`request_params\` for backend-specific features (provider pinning, data policies,
routing preferences) without writing backend-specific code in kb. To add a new backend's
extra fields: edit the JSON, no code change needed.

**OpenRouter** — provider pinning + data policy via \`request_params\`:
\`\`\`json
{
  "request_params": {
    "provider": { "only": ["DeepInfra"], "data_collection": "deny" }
  }
}
\`\`\`

**HuggingFace** — no \`request_params\` needed. Provider selection is in \`model_id\`
(e.g. \`"Qwen/Qwen2.5-Coder-32B-Instruct:nscale"\` in models.json).

**vLLM / Ollama** — no \`request_params\` needed. They ARE the provider.

**Naming hazard:** OpenRouter's \`provider.only\` and \`provider.order\` values are
inference provider names (DeepInfra, Fireworks, Relace), NOT model vendor names
(DeepSeek). A misconfigured \`"only": ["DeepSeek"]\` will 404 every request because
DeepSeek is the model vendor, not an inference provider for that model.

## limits.json (optional, not scaffolded)

A handoff may declare \`timeout_secs\` to override the pipeline's default 1800s worker watchdog
(WK-0244). The operator caps how high that override may go with \`wiki/.dispatch/limits.json\`:

\`\`\`json
{
  "schema_version": 1,
  "max_worker_timeout_secs": 7200
}
\`\`\`

Absent file means a cap of 1800s — a handoff's \`timeout_secs\` above that is refused at admission
(\`WORKER_TIMEOUT_EXCEEDS_CAP\`), never clamped. Raise the cap by creating this file (or editing
\`max_worker_timeout_secs\` in it) and re-dispatching; this file is operator-owned config, never
written by \`init-dispatch\` or by a worker.

## Provenance (provider-usage.jsonl)

kb opportunistically records which inference provider served each run, and (for OpenRouter)
what it billed. The forwarder taps every relayed response — no configuration needed — and
writes one JSON line per response to the run dir's \`provider-usage.jsonl\` (WK-0266; this
replaced the older per-run provenance file, which no longer exists). Each line carries \`status\`,
\`content_type\`, \`generation_id\`, \`providers\` (distinct, first-seen order, read from every data
chunk — not just the first), \`header_provider\` (the \`x-inference-provider\` response header, kept
for the HuggingFace path below), \`cost\` (the \`usage.cost\` figure from the last data line that
carries it, or \`null\`), \`cost_details\`, \`ended\` (\`true\` only on a normal stream end), and
\`dropped_lines\`/\`parse_errors\` (never thrown, always counted).

- OpenRouter: body \`"provider"\` field (always present, even on streams that open with
  \`: OPENROUTER PROCESSING\` keepalive comments before the first data line)
- HuggingFace: \`x-inference-provider\` response header (always present)
- Local backends: \`"unknown"\` (no routing)

The pipeline derives two response-doc facts from this file, never from Pi's own reported cost:

- \`inference_provider\` (frontmatter) — the distinct providers across the run's 2xx records,
  first-seen order, joined with \`", "\`; \`"unknown"\` when no record carries either a body or
  header provider.
- \`cost_usd\` (frontmatter) and the \`## Token Detail\` table's additive \`provider_cost_coverage\`
  row (\`k/n\` 2xx responses that carried a cost; shown as \`k/n ($X billed)\` when \`k < n\`) — a run
  is only billed as \`cost_usd\` when EVERY 2xx response carried a cost; otherwise \`cost_usd\` is 0
  and \`est_cost_usd\` falls back to the rate table (see \`rate_key_prefix\` above), with the known
  partial dollars still visible in \`provider_cost_coverage\`.

\`## Token Detail\` also carries the \`rate_key\` row (the exact rate-table key looked up, from
\`rate_key_prefix\` above) alongside \`provider_cost_coverage\`.

## Example profiles.json

\`\`\`json
{
  "schema_version": 1,
  "hf": {
    "inject": {
      "HF_TOKEN": "/home/user/.secrets/hf-token.env"
    }
  },
  "aws": {
    "inject": {
      "AWS_ACCESS_KEY_ID": "/home/user/.aws/kb-dispatch-creds.env",
      "AWS_SECRET_ACCESS_KEY": "/home/user/.aws/kb-dispatch-creds.env",
      "AWS_DEFAULT_REGION": "/home/user/.aws/kb-dispatch-creds.env"
    },
    "endpoints": ["*.amazonaws.com", "*.aws.amazon.com"]
  }
}
\`\`\`

## SaaS backends (codex/claude)

SaaS backends work under \`web:false\` — each family has a built-in vendor domain
allowlist. Setting \`web: true\` on a handoff is NOT needed to make codex or claude
function; use it only when the worker itself needs to fetch external resources
(research mode, dataset downloads, etc.).
`;

export async function initDispatch(opts: InitDispatchOpts): Promise<DispatchResult<InitDispatchResult>> {
  const configDir = join(opts.dir, 'wiki', '.dispatch');
  const created: string[] = [];
  const updated: string[] = [];

  try {
    await mkdir(configDir, { recursive: true });
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to create wiki/.dispatch/: ${(err as Error).message}`, err);
  }

  // Write blank JSON tables (only if absent — never overwrite user content)
  for (const [filename, content] of [
    ['models.json', BLANK_MODELS],
    ['backends.json', BLANK_BACKENDS],
    ['profiles.json', BLANK_PROFILES],
  ] as const) {
    const filePath = join(configDir, filename);
    try {
      await readFile(filePath, 'utf8');
      // File exists — skip
    } catch {
      await writeFile(filePath, content, 'utf8');
      created.push(filename);
    }
  }

  // Write README.md (write-once — same skip rule as the JSON tables above)
  const readmePath = join(configDir, 'README.md');
  try {
    await readFile(readmePath, 'utf8');
    // File exists — skip, never edited again
  } catch {
    await writeFile(readmePath, README_CONTENT, 'utf8');
    created.push('README.md');
  }

  return ok({ created, updated });
}

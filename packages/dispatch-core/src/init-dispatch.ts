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
    "secrets_file": "/home/user/.secrets/dispatch.env"
  },
  "ollama": {
    "family": "pi",
    "base_url": "http://localhost:11434/v1",
    "api_key_env": null,
    "secrets_file": null
  }
}
\`\`\`

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

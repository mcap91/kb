/**
 * `init-dispatch` — scaffold `wiki/.dispatch/` (PLN-0004 S3 ruling 11 + D2/D4
 * freeze correction). A NEW tool beside v1's `init-config`, not a replacement:
 * creates the repo-local `wiki/.dispatch/` dir, blank `models.json`/
 * `backends.json`/`profiles.json` tables (never overwritten once present —
 * only absent files are written), and a kb-managed `README.md` section
 * (re-run refreshes the managed block only, leaving any user content outside
 * the markers untouched). Does NOT stamp AGENTS.md or `.mcp.json` — those are
 * already wiki-core bootstrap/sync-contract jobs that cover kb-dispatch
 * (ruling 11). v1 `init-config` (token.key/launchers.v1.json) is untouched
 * until S7.
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

// kb-managed README content (ruling 11: re-run refreshes managed section only)
const MANAGED_START = '<!-- kb-managed:start -->';
const MANAGED_END = '<!-- kb-managed:end -->';

const MANAGED_README = `${MANAGED_START}
# wiki/.dispatch/ — Dispatch Configuration

This directory holds the repo-local dispatch configuration tables. Edit the JSON files
to configure models and backends for your repository.

## Files

| File | Purpose | Blank default |
|------|---------|---------------|
| \`models.json\` | Model slug → available backends + provider model_id | \`{}\` |
| \`backends.json\` | Backend name → base_url, api_key_env, secrets_file | \`{}\` |
| \`profiles.json\` | Credential profiles (schema_version 1, inject: {VAR: path}) | \`{"schema_version": 1}\` |

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

\`\`\`json
{
  "openrouter": {
    "base_url": "https://openrouter.ai/api/v1",
    "api_key_env": "OPENROUTER_API_KEY",
    "secrets_file": "/home/user/.config/kb-dispatch/secrets.env"
  },
  "ollama": {
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
  }
}
\`\`\`

Run \`init-dispatch\` again to refresh this section without touching your JSON files.
${MANAGED_END}`;

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

  // Write/update README.md (managed section only)
  const readmePath = join(configDir, 'README.md');
  try {
    const existing = await readFile(readmePath, 'utf8');
    if (existing.includes(MANAGED_START)) {
      // Refresh managed section
      const before = existing.substring(0, existing.indexOf(MANAGED_START));
      const after = existing.substring(existing.indexOf(MANAGED_END) + MANAGED_END.length);
      await writeFile(readmePath, `${before}${MANAGED_README}${after}`, 'utf8');
      updated.push('README.md');
    } else if (opts.force) {
      await writeFile(readmePath, `${MANAGED_README}\n`, 'utf8');
      updated.push('README.md');
    }
    // else: exists but no managed markers and not forced — skip
  } catch {
    // File doesn't exist — create with managed content
    await writeFile(readmePath, `${MANAGED_README}\n`, 'utf8');
    created.push('README.md');
  }

  return ok({ created, updated });
}

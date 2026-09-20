/**
 * S6c — Codex and Claude adapter parsing (adapters/codex.ts, adapters/claude.ts)
 * plus the T33 family-aware pipeline's one deterministic, unit-testable seam:
 * model-registry.ts's `resolveModelFromConfig` threading backends.json's
 * `family` field through to `ResolvedModel.family`, which is what
 * pipeline.ts's `model.family === 'codex' | 'claude'` branching (step 10)
 * actually switches on.
 *
 * Golden fixtures (DEC-0009, real unedited captures) under `tests/fixtures/`:
 *  - `codex-exec-output-stream-json.jsonl` — `codex exec --json` success.
 *  - `codex-exec-output-model-not-found.txt` — plain-text (no `--json`) 400
 *    error banner; exercises the adapter's ADAPTER_FAILED path, not event
 *    parsing (adapters/codex.ts's own module doc comment).
 *  - `claude-p-output.txt` — `claude -p --output-format json` success.
 *  - `claude-p-output-model-not-found.txt` — `is_error: true`, 404 API error.
 *  - `claude-p-output-permission-denied.txt` — `is_error: false` but a
 *    non-empty `permission_denials` array (module doc: "is_error stays false
 *    on a tool-permission block").
 *  - `claude-p-output-with-effort.txt` / `codex-exec-output-with-effort.jsonl`
 *    (WK-0122) — `claude -p --effort high --output-format json` /
 *    `codex exec "echo hello" --sandbox read-only -c model_reasoning_effort=high
 *    --json`. Confirms the WK-0122 design note: neither shape carries a
 *    direct effort/level echo field — only token counts (`usage.output_tokens`
 *    for claude, `usage.reasoning_output_tokens` for codex) — so the response
 *    doc's `effort_requested` field is correctly sourced from deterministic
 *    pipeline opts (capture.ts), never from parsed worker output.
 *
 * No personal/absolute paths appear in this file (WK-0043) — fixture paths
 * are resolved relative to this test file via `__dirname` (this file compiles
 * to CommonJS under NodeNext, same as dispatch-v2-compaction.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCodexOutput, buildInvocation as buildCodexInvocation } from '../packages/dispatch-core/src/adapters/codex.js';
import { parseClaudeOutput, buildInvocation as buildClaudeInvocation } from '../packages/dispatch-core/src/adapters/claude.js';
import { resolveModelFromConfig, type ResolvedModel } from '../packages/dispatch-core/src/model-registry.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function makeResolvedModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    slug: 'gpt-5.5',
    backend: 'codex',
    family: 'codex',
    modelId: 'gpt-5.5',
    baseUrl: null,
    apiKeyEnv: null,
    secretsFile: null,
    availableOn: ['codex'],
    contextWindow: 131072,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// adapters/codex.ts — parseCodexOutput, golden fixture + edge cases
// ---------------------------------------------------------------------------

describe('adapters/codex.ts — parseCodexOutput (S6c, golden fixture)', () => {
  it('parses the golden success fixture (turn.completed usage + last agent_message)', () => {
    const fixturePath = join(__dirname, 'fixtures', 'codex-exec-output-stream-json.jsonl');
    const stdout = readFileSync(fixturePath, 'utf8');

    const result = parseCodexOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe('completed');
    // turn.completed's usage object, verbatim from the fixture's last line.
    expect(result.data.usage.inputTokens).toBe(92367);
    expect(result.data.usage.outputTokens).toBeGreaterThan(0);
    expect(result.data.lastAssistantText.length).toBeGreaterThan(0);
    // The LAST item.completed/agent_message in the stream (item_17), not an
    // earlier intermediate narration step — proves the "overwritten on every
    // agent_message" semantics the adapter's doc comment claims, not just
    // "some text got extracted".
    expect(result.data.lastAssistantText).toContain('Step 4 of 4 done');
  });

  it('returns ADAPTER_FAILED for plain-text (non-JSON, no --json flag) output', () => {
    const fixturePath = join(__dirname, 'fixtures', 'codex-exec-output-model-not-found.txt');
    const stdout = readFileSync(fixturePath, 'utf8');

    const result = parseCodexOutput(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ADAPTER_FAILED');
  });

  it('WK-0122 DEC-0009: parses the with-effort capture, and it carries no effort echo field', () => {
    const fixturePath = join(__dirname, 'fixtures', 'codex-exec-output-with-effort.jsonl');
    const stdout = readFileSync(fixturePath, 'utf8');
    const raw = stdout.trim();

    const result = parseCodexOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('completed');
    expect(result.data.lastAssistantText).toBe('hello');
    // Real capture from `codex exec "echo hello" --sandbox read-only
    // -c model_reasoning_effort=high --json` — reasoning tokens ride the
    // usual usage object; no distinct "effort"/"reasoning_effort" echo field
    // exists anywhere in the stream (verifies the WK-0122 design note).
    expect(raw).not.toContain('"effort"');
    expect(raw).not.toContain('"reasoning_effort"');
    expect(raw).toContain('reasoning_output_tokens');
  });

  it('reports failed/empty_stream for empty input', () => {
    const result = parseCodexOutput('');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('failed');
    expect(result.data.stopReason).toBe('empty_stream');
  });
});

// ---------------------------------------------------------------------------
// adapters/codex.ts — buildInvocation
// ---------------------------------------------------------------------------

describe('adapters/codex.ts — buildInvocation', () => {
  it('builds the exec argv with sandbox/json/output/model flags', () => {
    const model = makeResolvedModel({ family: 'codex', modelId: 'gpt-5.5' });
    const clonePath = '/tmp/kb-codex-clone';
    const outputPath = '/tmp/codex-last-message.txt';

    const result = buildCodexInvocation('Test prompt text', model, clonePath, outputPath, 'workspace-write');

    expect(result.cmd).toBe('codex');
    expect(result.args).toContain('exec');
    expect(result.args).toContain('--sandbox');
    expect(result.args).toContain('workspace-write');
    expect(result.args).toContain('--json');
    expect(result.args).toContain('-o');
    expect(result.args).toContain('--model');
    expect(result.args).toContain('gpt-5.5');
    expect(result.cwd).toBe(clonePath);
  });

  it('WK-0122: splices -c model_reasoning_effort=<level> when effort is supplied', () => {
    const model = makeResolvedModel({ family: 'codex', modelId: 'gpt-5.5' });
    const clonePath = '/tmp/kb-codex-clone';
    const outputPath = '/tmp/codex-last-message.txt';

    const result = buildCodexInvocation('Test prompt text', model, clonePath, outputPath, 'workspace-write', 'high');

    expect(result.args).toContain('-c');
    expect(result.args).toContain('model_reasoning_effort=high');
    // No quotes around the value (WK-0069 note).
    expect(result.args).not.toContain('model_reasoning_effort="high"');
  });

  it('WK-0122: omits -c/model_reasoning_effort entirely when effort is not supplied', () => {
    const model = makeResolvedModel({ family: 'codex', modelId: 'gpt-5.5' });
    const clonePath = '/tmp/kb-codex-clone';
    const outputPath = '/tmp/codex-last-message.txt';

    const result = buildCodexInvocation('Test prompt text', model, clonePath, outputPath, 'workspace-write');

    expect(result.args).not.toContain('-c');
    expect(result.args.some((arg) => arg.startsWith('model_reasoning_effort='))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// adapters/claude.ts — parseClaudeOutput, golden fixtures
// ---------------------------------------------------------------------------

describe('adapters/claude.ts — parseClaudeOutput (S6c, golden fixtures)', () => {
  it('parses the golden success fixture (completed, cost/tokens/result present)', () => {
    const fixturePath = join(__dirname, 'fixtures', 'claude-p-output.txt');
    const stdout = readFileSync(fixturePath, 'utf8');

    const result = parseClaudeOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe('completed');
    expect(result.data.usage.costUsd).toBeGreaterThan(0);
    expect(result.data.usage.outputTokens).toBeGreaterThan(0);
    expect(result.data.lastAssistantText.length).toBeGreaterThan(0);
    expect(result.data.lastAssistantText).toContain('Files created');
    expect(result.data.permissionDenials).toBe(0);
    expect(result.data.numTurns).toBeGreaterThan(0);
  });

  it('parses the model-not-found fixture as an error with the 404 status as stopReason', () => {
    const fixturePath = join(__dirname, 'fixtures', 'claude-p-output-model-not-found.txt');
    const stdout = readFileSync(fixturePath, 'utf8');

    const result = parseClaudeOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe('error');
    expect(result.data.stopReason).toContain('404');
  });

  it('parses the permission-denied fixture as failed, despite is_error: false', () => {
    const fixturePath = join(__dirname, 'fixtures', 'claude-p-output-permission-denied.txt');
    const stdout = readFileSync(fixturePath, 'utf8');

    const result = parseClaudeOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe('failed');
    expect(result.data.stopReason).toBe('permission_denied');
    expect(result.data.permissionDenials).toBeGreaterThan(0);
  });

  it('returns ADAPTER_FAILED for non-JSON input', () => {
    const result = parseClaudeOutput('not json at all');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ADAPTER_FAILED');
  });

  it('WK-0122 DEC-0009: parses the with-effort capture, and it carries no effort echo field', () => {
    const fixturePath = join(__dirname, 'fixtures', 'claude-p-output-with-effort.txt');
    const stdout = readFileSync(fixturePath, 'utf8');

    const result = parseClaudeOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('completed');
    // Real capture from `claude -p --effort high --output-format json` — no
    // distinct "effort"/"level" echo field exists anywhere in the result
    // object (verifies the WK-0122 design note); only usage/cost counts do.
    expect(stdout).not.toContain('"effort"');
    expect(stdout).not.toContain('"reasoning_effort"');
    expect(result.data.usage.outputTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// adapters/claude.ts — buildInvocation
// ---------------------------------------------------------------------------

describe('adapters/claude.ts — buildInvocation', () => {
  it('builds the -p argv with the prompt as the last positional arg after --', () => {
    const model = makeResolvedModel({
      family: 'claude',
      backend: 'claude',
      slug: 'claude-sonnet-5',
      modelId: 'claude-sonnet-5',
      availableOn: ['claude'],
    });
    const clonePath = '/tmp/kb-claude-clone';
    const promptText = 'Test prompt text';

    const result = buildClaudeInvocation(promptText, model, clonePath);

    expect(result.cmd).toBe('claude');
    expect(result.args).toContain('-p');
    expect(result.args).toContain('--output-format');
    expect(result.args).toContain('json');
    expect(result.args).toContain('--permission-mode');
    expect(result.args).toContain('acceptEdits');
    expect(result.args).toContain('--model');
    expect(result.args).toContain('claude-sonnet-5');
    expect(result.args).toContain('--');
    expect(result.args[result.args.length - 1]).toBe(promptText);
  });

  it('WK-0122: splices --effort <level> before the -- terminator when effort is supplied', () => {
    const model = makeResolvedModel({
      family: 'claude',
      backend: 'claude',
      slug: 'claude-sonnet-5',
      modelId: 'claude-sonnet-5',
      availableOn: ['claude'],
    });
    const clonePath = '/tmp/kb-claude-clone';
    const promptText = 'Test prompt text';

    const result = buildClaudeInvocation(promptText, model, clonePath, undefined, 'high');

    expect(result.args).toContain('--effort');
    expect(result.args).toContain('high');
    // The prompt must stay the LAST positional arg after -- (DEC-0024) — effort
    // must not land after the terminator alongside it.
    expect(result.args[result.args.length - 1]).toBe(promptText);
    expect(result.args[result.args.length - 2]).toBe('--');
    const effortIdx = result.args.indexOf('--effort');
    const terminatorIdx = result.args.indexOf('--');
    expect(effortIdx).toBeLessThan(terminatorIdx);
  });

  it('WK-0122: omits --effort entirely when effort is not supplied', () => {
    const model = makeResolvedModel({
      family: 'claude',
      backend: 'claude',
      slug: 'claude-sonnet-5',
      modelId: 'claude-sonnet-5',
      availableOn: ['claude'],
    });
    const clonePath = '/tmp/kb-claude-clone';
    const promptText = 'Test prompt text';

    const result = buildClaudeInvocation(promptText, model, clonePath);

    expect(result.args).not.toContain('--effort');
  });
});

// ---------------------------------------------------------------------------
// model-registry.ts — resolveModelFromConfig threads a codex-family backend
// through (T33 family-aware pipeline). dispatch-v2-registry.test.ts already
// covers the pre-existing "pi" family; this adds the one new case pipeline.ts's
// branching now depends on: a family whose backend legitimately has a null
// base_url (codex/claude CLIs reach their SaaS provider directly).
// ---------------------------------------------------------------------------

describe('model-registry.ts — resolveModelFromConfig threads codex family through (T33)', () => {
  it('resolves a codex-family backend with a null base_url', async () => {
    const dir = await createTempDir('kb-model-registry-codex-');
    try {
      const configDir = join(dir, 'wiki', '.dispatch');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, 'models.json'),
        JSON.stringify({ 'gpt-5.5': { available_on: ['codex'], model_id: 'gpt-5.5' } }),
        'utf8',
      );
      await writeFile(
        join(configDir, 'backends.json'),
        JSON.stringify({ codex: { family: 'codex', base_url: null, api_key_env: null, secrets_file: null } }),
        'utf8',
      );

      const result = await resolveModelFromConfig(dir, 'gpt-5.5', 'codex');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.family).toBe('codex');
      expect(result.data.baseUrl).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

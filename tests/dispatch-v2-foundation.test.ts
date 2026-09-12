/**
 * PLN-0004 S0 Wave 1 — foundation module tests.
 *
 * Covers the five new dispatch v2 skeleton modules (ho.ts, admission.ts,
 * model-registry.ts, assemble.ts, adapters/pi.ts). These modules live alongside
 * the v1 dispatch-core files and are not yet wired into src/index.ts or the CLI —
 * that integration is wave 3. No personal/absolute paths appear in fixtures
 * (WK-0043 rule); all filesystem tests use temp dirs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseHandoff, parseHandoffContent, type Handoff } from '../packages/dispatch-core/src/ho.js';
import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { getDefaultRegistry, resolveModel } from '../packages/dispatch-core/src/model-registry.js';
import { assemblePrompt } from '../packages/dispatch-core/src/assemble.js';
import { buildInvocation, buildModelsJson, parsePiOutput } from '../packages/dispatch-core/src/adapters/pi.js';

// ---------------------------------------------------------------------------
// Frozen HO drafts — verbatim from wiki/plans/PLN-0004/execution/s0-rulings.md
// ---------------------------------------------------------------------------

const HO_0002_CONTENT = `---
id: HO-0002
title: Add a slugify utility with node:test coverage
mode: implement
write_scope: ["src/", "test/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: ["README.md"]
acceptance:
  - "AC-1: slugify('Hello, World!') returns 'hello-world'"
  - "AC-2: consecutive non-alphanumerics collapse to one hyphen; leading/trailing hyphens stripped"
  - "AC-3: \`node --test test/\` passes, covering AC-1, AC-2, empty string, and unicode input"
validation: ["node --test test/"]
status: draft
---

## Context
test_kb is a minimal knowledge-base repo with no build system. You are adding its
first utility module. Node 22 is available; there is no package.json and you must
not create one — use ES modules and the built-in node:test runner only.

## Relevant files
- README.md — repo purpose (read only)

## Task
1. Create \`src/slugify.mjs\` exporting \`slugify(input)\`: lowercase the input,
   strip diacritics (NFD normalize, drop combining marks), replace every run of
   non-alphanumeric characters with a single hyphen, trim leading/trailing hyphens.
   Non-string input throws TypeError.
2. Create \`test/slugify.test.mjs\` using node:test + node:assert covering the
   acceptance criteria above.
3. Run \`node --test test/\` until green.

## Constraints
- Touch only \`src/\` and \`test/\`. No package.json, no dependencies, no config files.
- Decision space: none granted (rev-5 framing) — implement exactly the specified behavior;
  a missing decision is a \`blocked\` exit naming what you need, not a judgment call.
`;

const HO_0003_CONTENT = `---
id: HO-0003
title: Add a formatBytes utility with node:test coverage
mode: implement
write_scope: ["src/", "test/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: ["README.md"]
acceptance:
  - "AC-1: formatBytes(0) returns '0 B'"
  - "AC-2: formatBytes(1536) returns '1.5 KB' — binary units (1 KB = 1024 B), one decimal, trailing .0 dropped"
  - "AC-3: units scale B → KB → MB → GB → TB; negative or non-finite input throws RangeError"
  - "AC-4: \`node --test test/\` passes covering AC-1..AC-3"
validation: ["node --test test/"]
status: draft
---

## Context
test_kb is a minimal knowledge-base repo with no build system. Node 22 is available;
there is no package.json and you must not create one — use ES modules and the built-in
node:test runner only. A sibling module src/slugify.mjs may or may not exist on your
base; do not touch it.

## Relevant files
- README.md — repo purpose (read only)

## Task
1. Create \`src/format-bytes.mjs\` exporting \`formatBytes(n)\`: binary-unit formatting
   (1 KB = 1024 B), one decimal place with trailing \`.0\` dropped, units B/KB/MB/GB/TB,
   "0 B" for zero. Throw RangeError for negative or non-finite numbers; TypeError for
   non-number input.
2. Create \`test/format-bytes.test.mjs\` using node:test + node:assert covering the
   acceptance criteria above.
3. Run \`node --test test/\` until green.

## Constraints
- Touch only \`src/\` and \`test/\`. No package.json, no dependencies, no config files.
- Decision space: none granted (rev-5 framing) — implement exactly the specified behavior;
  a missing decision is a \`blocked\` exit naming what you need, not a judgment call.
`;

function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'HO-0002',
    title: 'Add a slugify utility with node:test coverage',
    mode: 'implement',
    write_scope: ['src/', 'test/'],
    base_ref: null,
    web: false,
    credentials: [],
    data_mounts: [],
    read_first: ['README.md'],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['node --test test/'],
    status: 'draft',
    ...overrides,
  };
}

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// ho.ts
// ---------------------------------------------------------------------------

describe('ho.ts — §5 HO frontmatter parsing', () => {
  it('parses valid HO-0002 frontmatter', () => {
    const result = parseHandoffContent(HO_0002_CONTENT, 'HO-0002.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.id).toBe('HO-0002');
    expect(result.data.title).toBe('Add a slugify utility with node:test coverage');
    expect(result.data.mode).toBe('implement');
    expect(result.data.write_scope).toEqual(['src/', 'test/']);
    expect(result.data.base_ref).toBeNull();
    expect(result.data.web).toBe(false);
    expect(result.data.credentials).toEqual([]);
    expect(result.data.data_mounts).toEqual([]);
    expect(result.data.read_first).toEqual(['README.md']);
    expect(result.data.acceptance).toEqual([
      "AC-1: slugify('Hello, World!') returns 'hello-world'",
      'AC-2: consecutive non-alphanumerics collapse to one hyphen; leading/trailing hyphens stripped',
      'AC-3: `node --test test/` passes, covering AC-1, AC-2, empty string, and unicode input',
    ]);
    expect(result.data.validation).toEqual(['node --test test/']);
    expect(result.data.status).toBe('draft');
  });

  it('parses valid HO-0003 frontmatter', () => {
    const result = parseHandoffContent(HO_0003_CONTENT, 'HO-0003.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.id).toBe('HO-0003');
    expect(result.data.title).toBe('Add a formatBytes utility with node:test coverage');
    expect(result.data.mode).toBe('implement');
    expect(result.data.acceptance).toHaveLength(4);
    expect(result.data.acceptance[1]).toBe(
      "AC-2: formatBytes(1536) returns '1.5 KB' — binary units (1 KB = 1024 B), one decimal, trailing .0 dropped",
    );
    expect(result.data.validation).toEqual(['node --test test/']);
  });

  it('rejects a handoff missing a required field (no title)', () => {
    const content = HO_0002_CONTENT.replace(/^title:.*$/m, '');
    const result = parseHandoffContent(content, 'HO-0002.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
    expect(result.message).toContain('title');
  });

  it('parses mode: redteam (ho.ts validates schema only; mode-execution support is gated in admission/pipeline as of S4)', () => {
    const content = HO_0002_CONTENT.replace('mode: implement', 'mode: redteam');
    const result = parseHandoffContent(content, 'HO-0002.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mode).toBe('redteam');
  });

  it('rejects an id/filename mismatch', () => {
    const result = parseHandoffContent(HO_0002_CONTENT, 'HO-0003.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
    expect(result.message).toContain('HO-0002');
    expect(result.message).toContain('HO-0003');
  });

  it('reads and parses a handoff file from disk via parseHandoff', async () => {
    const dir = await createTempDir('kb-ho-parse-');
    try {
      const filePath = join(dir, 'HO-0002.md');
      await writeFile(filePath, HO_0002_CONTENT, 'utf8');

      const result = await parseHandoff(filePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.id).toBe('HO-0002');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// admission.ts
// ---------------------------------------------------------------------------

describe('admission.ts — S0 admission checks', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await createTempDir('kb-admission-');
    execFileSync('git', ['init'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
    await writeFile(join(repoRoot, 'README.md'), 'test repo\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('admits a clean repo and resolves baseSha to current HEAD', async () => {
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();

    const result = await checkAdmission(makeHandoff(), repoRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.repoRoot).toBe(repoRoot);
    expect(result.data.baseSha).toBe(expectedSha);
    expect(result.data.handoff.id).toBe('HO-0002');
  });

  it('refuses a dirty repo with DIRTY_REPO, listing the offending paths', async () => {
    await writeFile(join(repoRoot, 'README.md'), 'modified without committing\n', 'utf8');

    const result = await checkAdmission(makeHandoff(), repoRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('DIRTY_REPO');
    expect(result.detail).toMatchObject({ dirtyPaths: expect.arrayContaining([expect.stringContaining('README.md')]) });
  });

  it('refuses an implement handoff with an empty write_scope', async () => {
    const result = await checkAdmission(makeHandoff({ write_scope: [] }), repoRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('MISSING_WRITE_SCOPE');
  });
});

// ---------------------------------------------------------------------------
// model-registry.ts
// ---------------------------------------------------------------------------

describe('model-registry.ts — S0 seed registry', () => {
  it('ships exactly two entries by default', () => {
    const registry = getDefaultRegistry();
    expect(Object.keys(registry.models)).toHaveLength(2);
    expect(Object.keys(registry.models).sort()).toEqual(['deepseek', 'qwen3:8b']);
  });

  it('resolves the deepseek (OpenRouter) entry', () => {
    const result = resolveModel(getDefaultRegistry(), 'deepseek');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.provider).toBe('openrouter');
    expect(result.data.modelId).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.data.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(result.data.api).toBe('openai-completions');
    expect(result.data.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    expect(result.data.contextWindow).toBe(131072);
    expect(result.data.maxTokens).toBe(8192);
    expect(result.data.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('resolves the qwen3:8b (Ollama) entry with local-model compat flags', () => {
    const result = resolveModel(getDefaultRegistry(), 'qwen3:8b');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.provider).toBe('ollama');
    expect(result.data.baseUrl).toBe('http://{{WIN_HOST}}:11434/v1');
    expect(result.data.apiKeyEnv).toBeNull();
    expect(result.data.compat).toEqual({ supportsDeveloperRole: false, supportsReasoningEffort: false });
  });

  it('fails to resolve an unknown alias with MODEL_NOT_FOUND', () => {
    const result = resolveModel(getDefaultRegistry(), 'nonexistent');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('MODEL_NOT_FOUND');
    expect(result.message).toContain('nonexistent');
  });
});

// ---------------------------------------------------------------------------
// assemble.ts
// ---------------------------------------------------------------------------

describe('assemble.ts — mechanical prompt assembly', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await createTempDir('kb-assemble-');
    await mkdir(join(repoRoot, 'wiki', 'handoffs'), { recursive: true });
    await writeFile(join(repoRoot, 'wiki', 'handoffs', 'HO-0002.md'), HO_0002_CONTENT, 'utf8');
    await writeFile(join(repoRoot, 'README.md'), 'test_kb is a minimal knowledge-base repo.\n', 'utf8');
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('assembles a prompt containing the title, ACs, validation, read_first content, and framing', async () => {
    const parsed = parseHandoffContent(HO_0002_CONTENT, 'HO-0002.md');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await assemblePrompt(parsed.data, repoRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { text } = result.data;
    expect(text).toContain('You are a coding agent executing a handoff task.');
    expect(text).toContain('NO unratified decisions to make outside the decision space granted');
    expect(text).toContain('## Task: Add a slugify utility with node:test coverage');
    expect(text).toContain('### Write Scope');
    expect(text).toContain('- src/');
    expect(text).toContain('- test/');
    expect(text).toContain("- AC-1: slugify('Hello, World!') returns 'hello-world'");
    expect(text).toContain('- node --test test/');
    expect(text).toContain('<file path="README.md">');
    expect(text).toContain('test_kb is a minimal knowledge-base repo.');
    expect(text).toContain('outcome: completed | partial | blocked | failed');
    expect(result.data.tokenEstimate).toBeGreaterThan(0);
  });

  it('annotates an unreadable read_first entry instead of failing the whole assembly', async () => {
    const parsed = parseHandoffContent(
      HO_0002_CONTENT.replace('read_first: ["README.md"]', 'read_first: ["MISSING.md"]'),
      'HO-0002.md',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await assemblePrompt(parsed.data, repoRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('<file path="MISSING.md">');
    expect(result.data.text).toContain('[unreadable:');
  });

  it('fails with ASSEMBLE_FAILED when the HO markdown itself cannot be read', async () => {
    const parsed = parseHandoffContent(HO_0002_CONTENT, 'HO-0002.md');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const emptyRoot = await createTempDir('kb-assemble-missing-');
    try {
      const result = await assemblePrompt(parsed.data, emptyRoot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('ASSEMBLE_FAILED');
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// adapters/pi.ts
// ---------------------------------------------------------------------------

describe('adapters/pi.ts — facts-only Pi adapter', () => {
  it('buildInvocation produces the documented argv/env/cwd shape', () => {
    const model = {
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash-0731',
      displayName: 'DeepSeek V4 Flash (OpenRouter)',
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      contextWindow: 131072,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const invocation = buildInvocation('/tmp/run/prompt.txt', model, '/tmp/run/clone', '/tmp/run/worker-dir');

    expect(invocation.cmd).toBe('pi');
    expect(invocation.args).toEqual([
      '-p',
      '--mode',
      'json',
      '--model',
      'openrouter/deepseek/deepseek-v4-flash-0731',
      '--no-session',
      '--approve',
      '--',
      '@/tmp/run/prompt.txt',
    ]);
    expect(invocation.env).toEqual({
      PI_CODING_AGENT_DIR: '/tmp/run/worker-dir',
      PI_OFFLINE: '1',
      OPENROUTER_API_KEY: '$OPENROUTER_API_KEY',
    });
    expect(invocation.cwd).toBe('/tmp/run/clone');
    expect(JSON.parse(invocation.modelsJsonContent)).toEqual(buildModelsJson(model));
  });

  it('buildInvocation omits the api-key env var for keyless (Ollama) models', () => {
    const model = {
      provider: 'ollama',
      modelId: 'qwen3:8b',
      displayName: 'Qwen3 8B (Ollama)',
      baseUrl: 'http://{{WIN_HOST}}:11434/v1',
      api: 'openai-completions',
      apiKeyEnv: null,
      contextWindow: 32768,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    };

    const invocation = buildInvocation('/tmp/run/prompt.txt', model, '/tmp/run/clone', '/tmp/run/worker-dir');
    expect(invocation.env).toEqual({ PI_CODING_AGENT_DIR: '/tmp/run/worker-dir', PI_OFFLINE: '1' });
    expect(invocation.args).toContain('ollama/qwen3:8b');
  });

  it('buildModelsJson produces the Pi provider/model config shape', () => {
    const registry = getDefaultRegistry();
    const deepseek = registry.models.deepseek!;
    const qwen = registry.models['qwen3:8b']!;

    expect(buildModelsJson(deepseek)).toEqual({
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          api: 'openai-completions',
          apiKey: '$OPENROUTER_API_KEY',
          models: [
            {
              id: 'deepseek/deepseek-v4-flash-0731',
              contextWindow: 131072,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    });

    expect(buildModelsJson(qwen)).toEqual({
      providers: {
        ollama: {
          baseUrl: 'http://{{WIN_HOST}}:11434/v1',
          api: 'openai-completions',
          apiKey: 'placeholder',
          models: [
            {
              id: 'qwen3:8b',
              contextWindow: 32768,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        },
      },
    });
  });

  it('parsePiOutput sums usage across message_end events and defaults to completed', () => {
    const lines = [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { totalTokens: 50, cost: { total: 0.0005 } } },
      }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { totalTokens: 75, cost: { total: 0.0007 } } },
      }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');

    const result = parsePiOutput(lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('completed');
    expect(result.data.usage.totalTokens).toBe(125);
    expect(result.data.usage.costUsd).toBeCloseTo(0.0012, 6);
    expect(result.data.events).toHaveLength(4);
  });

  it('parsePiOutput detects a stopReason:"error" event and reports outcome error', () => {
    const lines = [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { totalTokens: 10, cost: { total: 0.0001 } } },
      }),
      JSON.stringify({ type: 'turn_end', stopReason: 'error' }),
    ].join('\n');

    const result = parsePiOutput(lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('error');
    expect(result.data.stopReason).toBe('error');
  });

  it('tolerates stray non-JSON lines but fails when nothing parses at all', () => {
    const tolerant = parsePiOutput('not json\n{"type":"agent_end"}\n');
    expect(tolerant.ok).toBe(true);
    if (tolerant.ok) {
      expect(tolerant.data.events).toHaveLength(1);
    }

    const failing = parsePiOutput('this is not json at all\nneither is this');
    expect(failing.ok).toBe(false);
    if (!failing.ok) {
      expect(failing.error).toBe('ADAPTER_FAILED');
    }
  });

  it('parsePiOutput returns failed/empty_stream on empty input', () => {
    const result = parsePiOutput('');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('failed');
    expect(result.data.stopReason).toBe('empty_stream');
    expect(result.data.hasAgentEnd).toBe(false);
    expect(result.data.usage.totalTokens).toBe(0);
  });

  it('parsePiOutput returns failed/truncated_stream when no agent_end is present', () => {
    const lines = [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { totalTokens: 30, cost: { total: 0.0003 } } },
      }),
    ].join('\n');

    const result = parsePiOutput(lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('failed');
    expect(result.data.stopReason).toBe('truncated_stream');
    expect(result.data.hasAgentEnd).toBe(false);
  });
});

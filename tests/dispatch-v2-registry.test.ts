/**
 * PLN-0004 S3 Wave 2b — model-registry.ts registry/version/fingerprint tests.
 *
 * Covers the new S3 surfaces added to model-registry.ts: resolveModelFromConfig
 * (repo-local two-table resolution), checkHarnessVersion (S3 ruling 7 version
 * gate), and buildFingerprintFragment/parseFingerprintOutput (S3 ruling 8
 * backend fingerprint). Mirrors dispatch-v2-config.test.ts's temp-dir fixture
 * conventions — no personal/absolute paths in fixtures (WK-0043). The
 * preflight.ts PI_VERSION extension is covered alongside its existing
 * parsePreflightOutput tests in dispatch-v2-e2e.test.ts, not here.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveModelFromConfig,
  checkHarnessVersion,
  buildFingerprintFragment,
  parseFingerprintOutput,
  PI_HARNESS_INFO,
  type ResolvedModel,
} from '../packages/dispatch-core/src/model-registry.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeDispatchConfig(dir: string, filename: string, content: string): Promise<void> {
  const configDir = join(dir, 'wiki', '.dispatch');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, filename), content, 'utf8');
}

function makeResolvedModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    slug: 'deepseek',
    backend: 'openrouter',
    modelId: 'deepseek/deepseek-v4-flash-0731',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    secretsFile: '/home/operator/.config/kb-dispatch/secrets.env',
    availableOn: ['openrouter'],
    supportsEffort: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveModelFromConfig
// ---------------------------------------------------------------------------

describe('model-registry.ts — resolveModelFromConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir('kb-model-registry-');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedTables(): Promise<void> {
    await writeDispatchConfig(
      dir,
      'models.json',
      JSON.stringify({
        deepseek: { available_on: ['openrouter'], model_id: 'deepseek/deepseek-v4-flash-0731', notes: 'live-verified' },
        'qwen3:8b': { available_on: ['ollama'], model_id: 'qwen3:8b' },
      }),
    );
    await writeDispatchConfig(
      dir,
      'backends.json',
      JSON.stringify({
        openrouter: {
          base_url: 'https://openrouter.ai/api/v1',
          api_key_env: 'OPENROUTER_API_KEY',
          secrets_file: '/home/operator/.config/kb-dispatch/secrets.env',
        },
        ollama: { base_url: 'http://localhost:11434/v1', api_key_env: null, secrets_file: null },
      }),
    );
  }

  it('resolves a slug + backend both present in their tables', async () => {
    await seedTables();

    const result = await resolveModelFromConfig(dir, 'deepseek', 'openrouter');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      slug: 'deepseek',
      backend: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash-0731',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      secretsFile: '/home/operator/.config/kb-dispatch/secrets.env',
      availableOn: ['openrouter'],
      supportsEffort: false,
    });
  });

  it('fails with MODEL_NOT_FOUND listing available slugs when the slug is missing', async () => {
    await seedTables();

    const result = await resolveModelFromConfig(dir, 'nonexistent', 'openrouter');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('MODEL_NOT_FOUND');
    expect(result.message).toContain('nonexistent');
    expect(result.detail).toMatchObject({ available: expect.arrayContaining(['deepseek', 'qwen3:8b']) });
  });

  it('fails with MODEL_NOT_FOUND listing available backends when the backend is missing', async () => {
    await seedTables();

    const result = await resolveModelFromConfig(dir, 'deepseek', 'nonexistent-backend');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('MODEL_NOT_FOUND');
    expect(result.message).toContain('nonexistent-backend');
    expect(result.detail).toMatchObject({ available: expect.arrayContaining(['openrouter', 'ollama']) });
  });

  it('resolves (does not refuse) on an available_on mismatch, warning instead', async () => {
    await writeDispatchConfig(
      dir,
      'models.json',
      JSON.stringify({ deepseek: { available_on: ['openrouter'], model_id: 'deepseek/deepseek-v4-flash-0731' } }),
    );
    await writeDispatchConfig(
      dir,
      'backends.json',
      JSON.stringify({ ollama: { base_url: 'http://localhost:11434/v1', api_key_env: null, secrets_file: null } }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await resolveModelFromConfig(dir, 'deepseek', 'ollama');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.backend).toBe('ollama');
      expect(result.data.availableOn).toEqual(['openrouter']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('deepseek');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fails with MODEL_NOT_FOUND when wiki/.dispatch/ is entirely absent (valid empty tables)', async () => {
    const result = await resolveModelFromConfig(dir, 'deepseek', 'openrouter');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('MODEL_NOT_FOUND');
    expect(result.detail).toMatchObject({ available: [] });
  });
});

// ---------------------------------------------------------------------------
// checkHarnessVersion
// ---------------------------------------------------------------------------

describe('model-registry.ts — checkHarnessVersion', () => {
  it('reports ok for a version within the tested range', () => {
    const result = checkHarnessVersion('0.85.1');
    expect(result.status).toBe('ok');
    expect(result.version).toBe('0.85.1');
  });

  it('refuses a version below knownGood, with the install command in the message', () => {
    const result = checkHarnessVersion('0.84.0');
    expect(result.status).toBe('refuse');
    expect(result.message).toContain(PI_HARNESS_INFO.installCmd);
  });

  it('warns (does not refuse) for a version above testedWith', () => {
    const result = checkHarnessVersion('0.86.0');
    expect(result.status).toBe('warn');
  });

  it('refuses an unparseable version string', () => {
    const result = checkHarnessVersion('not-a-version');
    expect(result.status).toBe('refuse');
    expect(result.message).toContain('not-a-version');
  });
});

// ---------------------------------------------------------------------------
// buildFingerprintFragment
// ---------------------------------------------------------------------------

describe('model-registry.ts — buildFingerprintFragment', () => {
  it('emits a curl probe against /api/version for an Ollama-style backend', () => {
    const model = makeResolvedModel({
      slug: 'qwen3:8b',
      backend: 'ollama',
      modelId: 'qwen3:8b',
      baseUrl: 'http://192.168.1.5:11434/v1',
      apiKeyEnv: null,
      secretsFile: null,
      availableOn: ['ollama'],
    });

    const lines = buildFingerprintFragment(model);
    expect(lines.some((l) => l.includes('curl') && l.includes('/api/version'))).toBe(true);
    expect(lines.some((l) => l.startsWith('_FP_HOST='))).toBe(true);
    expect(lines.some((l) => l.includes('192.168.1.5'))).toBe(true);
  });

  it('emits a curl probe against /version (root, not under /v1) for a vLLM-style backend', () => {
    const model = makeResolvedModel({
      slug: 'local-llama',
      backend: 'vllm',
      modelId: 'meta-llama/Llama-3-8B',
      baseUrl: 'http://10.0.0.9:8000/v1',
      apiKeyEnv: null,
      secretsFile: null,
      availableOn: ['vllm'],
    });

    const lines = buildFingerprintFragment(model);
    const versionLine = lines.find((l) => l.startsWith('_FP_VERSION='));
    expect(versionLine).toContain('curl');
    expect(versionLine).toContain('10.0.0.9:8000/version');
    expect(versionLine).not.toContain('/v1/version');
  });

  it('emits a literal "unknown" assignment for a non-Ollama/vLLM (serverless) backend', () => {
    const model = makeResolvedModel();

    const lines = buildFingerprintFragment(model);
    expect(lines).toContain('_FP_VERSION="unknown"');
    expect(lines.some((l) => l.includes('curl'))).toBe(false);
  });

  it('always contains the BACKEND_FINGERPRINT echo line', () => {
    const model = makeResolvedModel();
    const lines = buildFingerprintFragment(model);
    expect(lines).toContain('echo "BACKEND_FINGERPRINT=$_FP_HOST|$_FP_MODEL|$_FP_VERSION"');
  });
});

// ---------------------------------------------------------------------------
// parseFingerprintOutput
// ---------------------------------------------------------------------------

describe('model-registry.ts — parseFingerprintOutput', () => {
  it('parses a valid BACKEND_FINGERPRINT line', () => {
    const stdout = ['some banner line', 'BACKEND_FINGERPRINT=192.168.1.5|qwen3:8b|0.1.32', ''].join('\n');

    const result = parseFingerprintOutput(stdout);
    expect(result).toEqual({ serverVersion: '0.1.32', host: '192.168.1.5', model: 'qwen3:8b' });
  });

  it('normalizes a literal "unknown" version to null', () => {
    const stdout = 'BACKEND_FINGERPRINT=openrouter.ai|deepseek/deepseek-v4-flash-0731|unknown';

    const result = parseFingerprintOutput(stdout);
    expect(result).toEqual({ serverVersion: null, host: 'openrouter.ai', model: 'deepseek/deepseek-v4-flash-0731' });
  });

  it('returns null when the BACKEND_FINGERPRINT line is missing', () => {
    const result = parseFingerprintOutput('no fingerprint line here\njust some other output\n');
    expect(result).toBeNull();
  });
});

/**
 * PLN-0004 S3 Wave 1 — foundation module tests.
 *
 * Covers the new S3 foundation surfaces: errors.ts's `V2_REFUSAL_CODES` export,
 * repo-config.ts's `wiki/.dispatch/` table loaders + strict validation, and ho.ts's
 * new `vars` frontmatter field. Mirrors dispatch-v2-foundation.test.ts's
 * conventions — temp dirs only, no personal/absolute paths in fixtures (WK-0043).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { V2_REFUSAL_CODES, type DispatchErrorCode } from '../packages/dispatch-core/src/errors.js';
import { loadModelsTable, loadBackendsTable, loadProfilesConfig } from '../packages/dispatch-core/src/repo-config.js';
import { parseHandoffContent } from '../packages/dispatch-core/src/ho.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeDispatchConfig(dir: string, filename: string, content: string): Promise<void> {
  const configDir = join(dir, 'wiki', '.dispatch');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, filename), content, 'utf8');
}

// ---------------------------------------------------------------------------
// errors.ts — V2_REFUSAL_CODES
// ---------------------------------------------------------------------------

describe('errors.ts — V2_REFUSAL_CODES', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(V2_REFUSAL_CODES)).toBe(true);
    expect(V2_REFUSAL_CODES.length).toBeGreaterThan(0);
  });

  it('contains exactly the S0/S1/S3/S4 pre-spawn refusal codes', () => {
    const expected: DispatchErrorCode[] = [
      'BAD_RECORD',
      'MISSING_WRITE_SCOPE',
      'DIRTY_REPO',
      'ADMISSION_FAILED',
      'MODEL_NOT_FOUND',
      'PREFLIGHT_FAILED',
      'ACTIVE_RUN_EXISTS',
      'EFFORT_UNSUPPORTED',
      'CREDENTIALS_WITH_WEB',
      'UNKNOWN_PROFILE',
      'CREDENTIAL_NOT_CONFIGURED',
      'ENVELOPE_EXCEEDS_MODE',
      'STALE_WRITE_SCOPE',
      'MISSING_READ_FIRST',
      'BAD_BASE_REF',
      'CONTEXT_BUDGET_EXCEEDED',
      'BAD_DATA_MOUNT',
    ];
    expect([...V2_REFUSAL_CODES].sort()).toEqual([...expected].sort());
  });

  it('contains the four new S3 credential/registry codes', () => {
    expect(V2_REFUSAL_CODES).toEqual(
      expect.arrayContaining(['EFFORT_UNSUPPORTED', 'CREDENTIALS_WITH_WEB', 'UNKNOWN_PROFILE', 'CREDENTIAL_NOT_CONFIGURED']),
    );
  });

  it('has no duplicate entries', () => {
    expect(new Set(V2_REFUSAL_CODES).size).toBe(V2_REFUSAL_CODES.length);
  });

  it('is typed as a readonly DispatchErrorCode[] (compile-time pin)', () => {
    const typed: readonly DispatchErrorCode[] = V2_REFUSAL_CODES;
    expect(typed).toBe(V2_REFUSAL_CODES);
  });
});

// ---------------------------------------------------------------------------
// repo-config.ts — wiki/.dispatch/ table loaders
// ---------------------------------------------------------------------------

describe('repo-config.ts — wiki/.dispatch/ table loaders', () => {
  describe('loadModelsTable', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await createTempDir('kb-repo-config-models-');
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('returns ok({}) when models.json is absent (no wiki/.dispatch/ dir at all)', async () => {
      const result = await loadModelsTable(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({});
    });

    it('parses a valid models.json', async () => {
      await writeDispatchConfig(
        dir,
        'models.json',
        JSON.stringify({
          deepseek: {
            available_on: ['openrouter'],
            model_id: 'deepseek/deepseek-v4-flash-0731',
            notes: 'live-verified (WK-0073)',
          },
          'qwen3:8b': {
            available_on: ['ollama'],
            model_id: 'qwen3:8b',
          },
        }),
      );

      const result = await loadModelsTable(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({
        deepseek: {
          available_on: ['openrouter'],
          model_id: 'deepseek/deepseek-v4-flash-0731',
          notes: 'live-verified (WK-0073)',
        },
        'qwen3:8b': {
          available_on: ['ollama'],
          model_id: 'qwen3:8b',
        },
      });
    });

    it('refuses malformed JSON, naming the file', async () => {
      await writeDispatchConfig(dir, 'models.json', '{ not valid json');

      const result = await loadModelsTable(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('models.json');
    });

    it('refuses an entry missing the required model_id field', async () => {
      await writeDispatchConfig(dir, 'models.json', JSON.stringify({ deepseek: { available_on: ['openrouter'] } }));

      const result = await loadModelsTable(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('model_id');
      expect(result.message).toContain('deepseek');
    });

    it('refuses an entry whose available_on is not an array of strings', async () => {
      await writeDispatchConfig(
        dir,
        'models.json',
        JSON.stringify({ deepseek: { available_on: 'openrouter', model_id: 'deepseek/deepseek-v4-flash-0731' } }),
      );

      const result = await loadModelsTable(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('available_on');
    });
  });

  describe('loadBackendsTable', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await createTempDir('kb-repo-config-backends-');
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('returns ok({}) when backends.json is absent', async () => {
      const result = await loadBackendsTable(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({});
    });

    it('parses a valid backends.json', async () => {
      await writeDispatchConfig(
        dir,
        'backends.json',
        JSON.stringify({
          openrouter: {
            base_url: 'https://openrouter.ai/api/v1',
            api_key_env: 'OPENROUTER_API_KEY',
            secrets_file: '/home/operator/.config/kb-dispatch/secrets.env',
          },
          ollama: {
            base_url: 'http://localhost:11434/v1',
            api_key_env: null,
            secrets_file: null,
            notes: 'no secret needed',
          },
        }),
      );

      const result = await loadBackendsTable(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.openrouter).toEqual({
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: 'OPENROUTER_API_KEY',
        secrets_file: '/home/operator/.config/kb-dispatch/secrets.env',
      });
      expect(result.data.ollama).toEqual({
        base_url: 'http://localhost:11434/v1',
        api_key_env: null,
        secrets_file: null,
        notes: 'no secret needed',
      });
    });

    it('refuses malformed JSON, naming the file', async () => {
      await writeDispatchConfig(dir, 'backends.json', 'not json at all');

      const result = await loadBackendsTable(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('backends.json');
    });

    it('refuses an entry missing the required base_url field', async () => {
      await writeDispatchConfig(dir, 'backends.json', JSON.stringify({ openrouter: { api_key_env: null, secrets_file: null } }));

      const result = await loadBackendsTable(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('base_url');
      expect(result.message).toContain('openrouter');
    });

    it('refuses an entry with a non-string, non-null api_key_env', async () => {
      await writeDispatchConfig(
        dir,
        'backends.json',
        JSON.stringify({ openrouter: { base_url: 'https://openrouter.ai/api/v1', api_key_env: 42, secrets_file: null } }),
      );

      const result = await loadBackendsTable(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('api_key_env');
    });
  });

  describe('loadProfilesConfig', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await createTempDir('kb-repo-config-profiles-');
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('returns ok({ schemaVersion: 1, profiles: {} }) when profiles.json is absent', async () => {
      const result = await loadProfilesConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({ schemaVersion: 1, profiles: {} });
    });

    it('parses a valid profiles.json with one profile', async () => {
      await writeDispatchConfig(
        dir,
        'profiles.json',
        JSON.stringify({
          schema_version: 1,
          hf: { inject: { HF_TOKEN: '/home/operator/.secrets/hf-token.env' } },
        }),
      );

      const result = await loadProfilesConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({
        schemaVersion: 1,
        profiles: { hf: { inject: { HF_TOKEN: '/home/operator/.secrets/hf-token.env' } } },
      });
    });

    it('refuses an unknown key inside a profile entry, naming the key and the profile', async () => {
      await writeDispatchConfig(
        dir,
        'profiles.json',
        JSON.stringify({
          schema_version: 1,
          hf: { inject: { HF_TOKEN: '/path' }, mounts: ['/data'] },
        }),
      );

      const result = await loadProfilesConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('mounts');
      expect(result.message).toContain('hf');
    });

    it('refuses a schema_version other than 1', async () => {
      await writeDispatchConfig(dir, 'profiles.json', JSON.stringify({ schema_version: 2 }));

      const result = await loadProfilesConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('schema_version');
    });

    it('refuses malformed JSON', async () => {
      await writeDispatchConfig(dir, 'profiles.json', '{{{');

      const result = await loadProfilesConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('profiles.json');
    });

    it('refuses a profile entry missing the required inject field', async () => {
      await writeDispatchConfig(dir, 'profiles.json', JSON.stringify({ schema_version: 1, hf: {} }));

      const result = await loadProfilesConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('inject');
    });

    it('refuses a profile whose inject value is not a string', async () => {
      await writeDispatchConfig(dir, 'profiles.json', JSON.stringify({ schema_version: 1, hf: { inject: { HF_TOKEN: 123 } } }));

      const result = await loadProfilesConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_RECORD');
      expect(result.message).toContain('HF_TOKEN');
    });
  });
});

// ---------------------------------------------------------------------------
// ho.ts — vars frontmatter field (PLN-0004 S3)
// ---------------------------------------------------------------------------

const HO_BASE_FRONTMATTER = `id: HO-0002
title: Add a slugify utility with node:test coverage
mode: implement
write_scope: ["src/", "test/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: ["README.md"]
acceptance:
  - "AC-1: example"
validation: ["node --test test/"]
status: draft`;

function makeHoContent(extraFrontmatterLine?: string): string {
  const frontmatter = extraFrontmatterLine ? `${HO_BASE_FRONTMATTER}\n${extraFrontmatterLine}` : HO_BASE_FRONTMATTER;
  return `---\n${frontmatter}\n---\n\n## Context\ntest_kb is a minimal knowledge-base repo.\n`;
}

describe('ho.ts — vars frontmatter field (PLN-0004 S3)', () => {
  it('parses vars as an array of "KEY=value" strings', () => {
    const content = makeHoContent('vars: ["FOO=bar", "BAZ=qux"]');
    const result = parseHandoffContent(content, 'HO-0002.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.vars).toEqual(['FOO=bar', 'BAZ=qux']);
  });

  it('rejects vars that is not an array with BAD_RECORD', () => {
    const content = makeHoContent('vars: not-an-array');
    const result = parseHandoffContent(content, 'HO-0002.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
    expect(result.message).toContain('vars');
  });

  it('defaults vars to [] when absent from frontmatter', () => {
    const content = makeHoContent();
    const result = parseHandoffContent(content, 'HO-0002.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.vars).toEqual([]);
  });
});

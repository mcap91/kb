/**
 * WK-0252 slice a (DEC-0046) — host-config.ts unit tests: load/missing/
 * malformed, `~` expansion, and coverage. Every test isolates the host
 * config under a temp `XDG_CONFIG_HOME` (host-config-test-helper.ts) — never
 * the real operator config or `~/.secrets`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadHostConfig,
  getHostConfigPath,
  expandHomePath,
  computeHostConfigCoverage,
  HOST_CONFIG_FILENAME,
} from '../packages/dispatch-core/src/host-config.js';
import { setUpHostConfig } from './host-config-test-helper.js';

let teardown: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (teardown) {
    await teardown();
    teardown = undefined;
  }
});

describe('host-config.ts — loadHostConfig', () => {
  it('refuses HOST_CONFIG_NOT_FOUND naming the path when the file is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-host-config-missing-'));
    const previousXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = root;
    teardown = async () => {
      if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = previousXdg;
      await rm(root, { recursive: true, force: true });
    };

    const result = await loadHostConfig();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('HOST_CONFIG_NOT_FOUND');
    expect(result.message).toContain(getHostConfigPath());
  });

  it('refuses BAD_RECORD on malformed JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-host-config-malformed-'));
    const previousXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = root;
    teardown = async () => {
      if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = previousXdg;
      await rm(root, { recursive: true, force: true });
    };
    await mkdir(join(root, 'kb-dispatch'), { recursive: true });
    await writeFile(join(root, 'kb-dispatch', HOST_CONFIG_FILENAME), '{ not json', 'utf8');

    const result = await loadHostConfig();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
  });

  it('loads backends + profiles covering the current tables (openrouter-openai with a secrets file, claude-saas with none; aws with 3 vars, hf with HF_TOKEN)', async () => {
    teardown = await setUpHostConfig({
      backends: {
        'openrouter-openai': { reachable: true, secrets_file: '/home/op/.secrets/dispatch.env' },
        'claude-saas': { reachable: true, secrets_file: null },
      },
      profiles: {
        aws: {
          AWS_ACCESS_KEY_ID: '/home/op/.secrets/aws-dispatch-creds.env',
          AWS_SECRET_ACCESS_KEY: '/home/op/.secrets/aws-dispatch-creds.env',
          AWS_DEFAULT_REGION: '/home/op/.secrets/aws-dispatch-creds.env',
        },
        hf: { HF_TOKEN: '/home/op/.secrets/hf.env' },
      },
    });

    const result = await loadHostConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.backends['openrouter-openai']).toEqual({ reachable: true, secrets_file: '/home/op/.secrets/dispatch.env' });
    expect(result.data.backends['claude-saas']).toEqual({ reachable: true, secrets_file: null });
    expect(Object.keys(result.data.profiles.aws)).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION']);
    expect(result.data.profiles.hf).toEqual({ HF_TOKEN: '/home/op/.secrets/hf.env' });
  });

  it('expands a leading ~ in a backend secrets_file and a profile variable path to the home directory', async () => {
    teardown = await setUpHostConfig({
      backends: { openrouter: { reachable: true, secrets_file: '~/.secrets/dispatch.env' } },
      profiles: { hf: { HF_TOKEN: '~/.secrets/hf.env' } },
    });

    const result = await loadHostConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const home = process.env['HOME'] ?? '';
    expect(result.data.backends.openrouter.secrets_file).toBe(join(home, '.secrets', 'dispatch.env'));
    expect(result.data.backends.openrouter.secrets_file).not.toContain('~');
    expect(result.data.profiles.hf.HF_TOKEN).toBe(join(home, '.secrets', 'hf.env'));
    expect(result.data.profiles.hf.HF_TOKEN).not.toContain('~');
  });
});

describe('host-config.ts — expandHomePath (pure)', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(expandHomePath('~')).toBe(homedir());
  });

  it('expands ~/... to <home>/...', () => {
    expect(expandHomePath('~/.secrets/x.env')).toBe(join(homedir(), '.secrets', 'x.env'));
  });

  it('passes through a value with no leading ~ unchanged', () => {
    expect(expandHomePath('/already/absolute/x.env')).toBe('/already/absolute/x.env');
  });
});

describe('host-config.ts — computeHostConfigCoverage', () => {
  it('reports missing, unreachable, and missing-profile names; covered names are absent from every list', async () => {
    teardown = await setUpHostConfig({
      backends: { openrouter: { reachable: true, secrets_file: null }, offline: { reachable: false, secrets_file: null } },
      profiles: { hf: { HF_TOKEN: '/x' } },
    });
    const result = await loadHostConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const coverage = computeHostConfigCoverage(result.data, ['openrouter', 'offline', 'nonexistent'], ['hf', 'aws']);
    expect(coverage.missingBackends).toEqual(['nonexistent']);
    expect(coverage.unreachableBackends).toEqual(['offline']);
    expect(coverage.missingProfiles).toEqual(['aws']);
  });
});

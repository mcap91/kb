/**
 * PLN-0004 S3 Wave 2a — credentials.ts unit tests.
 *
 * credentials.ts is a pure module (no filesystem I/O): every function here
 * takes already-loaded config objects and a parsed Handoff, unlike
 * dispatch-v2-config.test.ts's loader tests, which exercise real temp-dir
 * reads. Mirrors that file's conventions otherwise — no personal/absolute
 * paths in fixtures (WK-0043); paths below are placeholder POSIX-shaped
 * strings only, never resolved against a real filesystem.
 */
import { describe, expect, it } from 'vitest';

import {
  resolveCredentials,
  checkCredentialPolicy,
  buildInjectionScript,
  buildInjectedValueScanFragment,
} from '../packages/dispatch-core/src/credentials.js';
import type { CredentialResolution } from '../packages/dispatch-core/src/credentials.js';
import type { Handoff } from '../packages/dispatch-core/src/ho.js';
import type { ProfilesConfig, ProfileEntry, BackendEntry } from '../packages/dispatch-core/src/repo-config.js';

function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'HO-0005',
    title: 'Add an HF whoami credential check script',
    mode: 'implement',
    write_scope: ['scripts/'],
    base_ref: null,
    web: false,
    credentials: [],
    data_mounts: [],
    read_first: [],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['node --test test/'],
    status: 'draft',
    ...overrides,
  };
}

function makeProfilesConfig(profiles: Record<string, ProfileEntry> = {}): ProfilesConfig {
  return { schemaVersion: 1, profiles };
}

function makeBackend(overrides: Partial<BackendEntry> = {}): BackendEntry {
  return {
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: null,
    secrets_file: null,
    ...overrides,
  };
}

function makeResolution(overrides: Partial<CredentialResolution> = {}): CredentialResolution {
  return {
    granted: [],
    injections: [],
    backendApiKeyEnv: null,
    backendSecretsFile: null,
    ...overrides,
  };
}

const HF_PROFILES = makeProfilesConfig({
  hf: { inject: { HF_TOKEN: '/home/operator/.secrets/hf-token.env' } },
});

// ---------------------------------------------------------------------------
// resolveCredentials
// ---------------------------------------------------------------------------

describe('credentials.ts — resolveCredentials', () => {
  it('HO with no credentials resolves to an empty grant', () => {
    const handoff = makeHandoff({ credentials: [] });
    const result = resolveCredentials(handoff, HF_PROFILES, makeBackend());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.granted).toEqual([]);
    expect(result.data.injections).toEqual([]);
  });

  it('HO with one valid credential grants the profile and populates injections', () => {
    const handoff = makeHandoff({ credentials: ['hf'] });
    const result = resolveCredentials(handoff, HF_PROFILES, makeBackend());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.granted).toEqual(['hf']);
    expect(result.data.injections).toEqual([
      { profileName: 'hf', varName: 'HF_TOKEN', filePath: '/home/operator/.secrets/hf-token.env' },
    ]);
  });

  it('HO naming a profile not in profiles.json refuses with UNKNOWN_PROFILE naming the profile', () => {
    const handoff = makeHandoff({ credentials: ['nonexistent'] });
    const result = resolveCredentials(handoff, HF_PROFILES, makeBackend());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('UNKNOWN_PROFILE');
    expect(result.message).toContain('nonexistent');
  });

  it('resolves multiple credentials, all granted with their injections populated', () => {
    const profiles = makeProfilesConfig({
      hf: { inject: { HF_TOKEN: '/home/operator/.secrets/hf-token.env' } },
      aws: { inject: { AWS_ACCESS_KEY_ID: '/home/operator/.secrets/aws.env' } },
    });
    const handoff = makeHandoff({ credentials: ['hf', 'aws'] });
    const result = resolveCredentials(handoff, profiles, makeBackend());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.granted).toEqual(['hf', 'aws']);
    expect(result.data.injections).toEqual([
      { profileName: 'hf', varName: 'HF_TOKEN', filePath: '/home/operator/.secrets/hf-token.env' },
      { profileName: 'aws', varName: 'AWS_ACCESS_KEY_ID', filePath: '/home/operator/.secrets/aws.env' },
    ]);
  });

  it('passes the resolved backend api_key_env/secrets_file through unchanged', () => {
    const handoff = makeHandoff({ credentials: [] });
    const backend = makeBackend({ api_key_env: 'OPENROUTER_API_KEY', secrets_file: '/home/operator/.config/kb-dispatch/secrets.env' });
    const result = resolveCredentials(handoff, HF_PROFILES, backend);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.backendApiKeyEnv).toBe('OPENROUTER_API_KEY');
    expect(result.data.backendSecretsFile).toBe('/home/operator/.config/kb-dispatch/secrets.env');
  });
});

// ---------------------------------------------------------------------------
// checkCredentialPolicy
// ---------------------------------------------------------------------------

describe('credentials.ts — checkCredentialPolicy', () => {
  it('refuses CREDENTIALS_WITH_WEB when credentials are granted and web is true', () => {
    const handoff = makeHandoff({ credentials: ['hf'], web: true });
    const resolved = resolveCredentials(handoff, HF_PROFILES, makeBackend());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = checkCredentialPolicy(handoff, resolved.data);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('CREDENTIALS_WITH_WEB');
  });

  it('allows credentials with web: false', () => {
    const handoff = makeHandoff({ credentials: ['hf'], web: false });
    const resolved = resolveCredentials(handoff, HF_PROFILES, makeBackend());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = checkCredentialPolicy(handoff, resolved.data);
    expect(result.ok).toBe(true);
  });

  it('allows web: true with no credentials (no conflict)', () => {
    const handoff = makeHandoff({ credentials: [], web: true });
    const resolved = resolveCredentials(handoff, HF_PROFILES, makeBackend());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = checkCredentialPolicy(handoff, resolved.data);
    expect(result.ok).toBe(true);
  });

  it('refuses BAD_RECORD naming the key when a vars entry collides with an injected profile var', () => {
    const handoff = makeHandoff({ credentials: ['hf'], vars: ['HF_TOKEN=foo'] });
    const resolved = resolveCredentials(handoff, HF_PROFILES, makeBackend());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = checkCredentialPolicy(handoff, resolved.data);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
    expect(result.message).toContain('HF_TOKEN');
  });

  it('refuses BAD_RECORD when a vars entry collides with the backend api_key_env', () => {
    const handoff = makeHandoff({ credentials: [], vars: ['OPENROUTER_API_KEY=foo'] });
    const backend = makeBackend({ api_key_env: 'OPENROUTER_API_KEY', secrets_file: '/home/operator/.config/kb-dispatch/secrets.env' });
    const resolved = resolveCredentials(handoff, HF_PROFILES, backend);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = checkCredentialPolicy(handoff, resolved.data);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
    expect(result.message).toContain('OPENROUTER_API_KEY');
  });

  it('allows vars entries that do not collide with anything injected', () => {
    const handoff = makeHandoff({ credentials: ['hf'], vars: ['UNRELATED_VAR=foo'] });
    const resolved = resolveCredentials(handoff, HF_PROFILES, makeBackend());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = checkCredentialPolicy(handoff, resolved.data);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildInjectionScript
// ---------------------------------------------------------------------------

describe('credentials.ts — buildInjectionScript', () => {
  it('emits the grep/cut/export pattern for one injection', () => {
    const resolution = makeResolution({
      granted: ['hf'],
      injections: [{ profileName: 'hf', varName: 'HF_TOKEN', filePath: '/home/operator/.secrets/hf-token.env' }],
    });

    const script = buildInjectionScript(resolution, []);
    expect(script.exportLines).toEqual([
      `export HF_TOKEN="$(grep -m1 '^HF_TOKEN=' '/home/operator/.secrets/hf-token.env' | cut -d= -f2-)"`,
    ]);
  });

  it('adds an API key injection line when the backend has api_key_env + secrets_file', () => {
    const resolution = makeResolution({
      backendApiKeyEnv: 'OPENROUTER_API_KEY',
      backendSecretsFile: '/home/operator/.config/kb-dispatch/secrets.env',
    });

    const script = buildInjectionScript(resolution, []);
    expect(script.exportLines).toEqual([
      `export OPENROUTER_API_KEY="$(grep -m1 '^OPENROUTER_API_KEY=' '/home/operator/.config/kb-dispatch/secrets.env' | cut -d= -f2-)"`,
    ]);
  });

  it('omits the API key injection line when the backend has no api_key_env', () => {
    const resolution = makeResolution();
    const script = buildInjectionScript(resolution, []);
    expect(script.exportLines).toEqual([]);
  });

  it('builds varsExportLines from HO vars entries, single-quoted', () => {
    const resolution = makeResolution();
    const script = buildInjectionScript(resolution, ['FOO=bar']);
    expect(script.varsExportLines).toEqual([`export FOO='bar'`]);
  });

  it('builds existenceCheckLines with the correct grep-check pattern', () => {
    const resolution = makeResolution({
      granted: ['hf'],
      injections: [{ profileName: 'hf', varName: 'HF_TOKEN', filePath: '/home/operator/.secrets/hf-token.env' }],
    });

    const script = buildInjectionScript(resolution, []);
    expect(script.existenceCheckLines).toEqual([
      `if ! grep -q '^HF_TOKEN=' '/home/operator/.secrets/hf-token.env'; then echo "CREDENTIAL_NOT_CONFIGURED:HF_TOKEN"; exit 1; fi`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildInjectedValueScanFragment
// ---------------------------------------------------------------------------

describe('credentials.ts — buildInjectedValueScanFragment', () => {
  it('emits a grep-for-value line and a SECRET_HIT output line for one injection', () => {
    const resolution = makeResolution({
      granted: ['hf'],
      injections: [{ profileName: 'hf', varName: 'HF_TOKEN', filePath: '/home/operator/.secrets/hf-token.env' }],
    });

    const lines = buildInjectedValueScanFragment(resolution);
    expect(lines).toEqual([
      `_VAL="$(grep -m1 '^HF_TOKEN=' '/home/operator/.secrets/hf-token.env' | cut -d= -f2-)"`,
      `if [ -n "$_VAL" ] && grep -qF "$_VAL" "$DIFF_FILE"; then echo "SECRET_HIT=HF_TOKEN"; fi`,
    ]);
  });

  it('returns an empty array when there are no injections', () => {
    const resolution = makeResolution();
    expect(buildInjectedValueScanFragment(resolution)).toEqual([]);
  });
});

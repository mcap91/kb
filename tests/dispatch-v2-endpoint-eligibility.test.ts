/**
 * WK-0189 — endpoint-eligibility probe for check-environment (config-time,
 * operator-initiated; the dispatch path itself is untouched). HO-0064 burned
 * a full dispatch cycle discovering that OpenRouter's ZDR/provider-pin
 * guardrail excluded every endpoint for a backend×model pair — a fact
 * knowable from static config (backends.json + models.json) without a
 * worker.
 *
 * `deriveEndpointEligibility` is pure, golden-fixture tested below against
 * the real unedited 404 captures (RUN-089e6deb / RUN-51fec485) and the real
 * unedited success capture (`pi-output-code-review.jsonl`, provider
 * "openrouter", model "deepseek/deepseek-v4-flash-0731" — the exact pair
 * "deepseek"/"openrouter-oss" resolves to) per DEC-0009.
 *
 * The end-to-end `probeEndpointEligibility` tests spawn a REAL child process
 * (a fake `pi` shell script placed first on PATH that replays a real
 * captured fixture) rather than `vi.mock('node:child_process')` — mirrors
 * dispatch-v2-spawn.test.ts's documented rationale: a hand-rolled
 * ChildProcess fake would invent event/stream shape DEC-0009 says not to
 * guess at.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveEndpointEligibility,
  probeEndpointEligibility,
} from '../packages/dispatch-core/src/environment.js';
import { checkEnvironment } from '../packages/dispatch-core/src/environment.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');

async function readFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES_DIR, name), 'utf8');
}

describe('deriveEndpointEligibility (pure verdict logic, golden fixtures)', () => {
  it('reports ineligible from the real captured OpenRouter 404 body (RUN-089e6deb), echoing ineligibility_reasons + configure URLs verbatim', async () => {
    const stdout = await readFixture('pi-output-errored-single-message.jsonl');
    const verdict = deriveEndpointEligibility('openrouter-openai', 'gpt-5.6-terra-or', 'openai/gpt-5.6-terra', stdout);

    expect(verdict.status).toBe('ineligible');
    expect(verdict.ineligibilityReasons).toEqual([
      { reason: 'zdr-violation-by-account', endpoint_count: 1, configure_url: 'https://openrouter.ai/settings/privacy' },
      { reason: 'zdr-violation-by-guardrail', endpoint_count: 1, configure_url: 'https://openrouter.ai/workspaces/default/guardrails' },
    ]);
    expect(verdict.detail).toContain('https://openrouter.ai/settings/privacy');
    expect(verdict.detail).toContain('https://openrouter.ai/workspaces/default/guardrails');
    expect(verdict.backend).toBe('openrouter-openai');
    expect(verdict.modelId).toBe('openai/gpt-5.6-terra');
  });

  it('reports ineligible from the second captured 404 (RUN-51fec485, account-ZDR variant, different model)', async () => {
    const stdout = await readFixture('pi-output-errored-404-account-zdr.jsonl');
    const verdict = deriveEndpointEligibility('openrouter-openai', 'gpt-5.6-sol-or', 'openai/gpt-5.6-sol', stdout);

    expect(verdict.status).toBe('ineligible');
    expect(verdict.ineligibilityReasons?.map((r) => r.reason)).toEqual([
      'zdr-violation-by-account',
      'zdr-violation-by-guardrail',
    ]);
    expect(verdict.ineligibilityReasons?.map((r) => r.configure_url)).toEqual([
      'https://openrouter.ai/settings/privacy',
      'https://openrouter.ai/workspaces/default/guardrails',
    ]);
  });

  it('reports eligible from a real captured successful completion (pi-output-code-review.jsonl: provider "openrouter", model "deepseek/deepseek-v4-flash-0731" — the exact "deepseek"/"openrouter-oss" pair)', async () => {
    const stdout = await readFixture('pi-output-code-review.jsonl');
    expect(stdout).toContain('"provider":"openrouter"');
    expect(stdout).toContain('"model":"deepseek/deepseek-v4-flash-0731"');

    const verdict = deriveEndpointEligibility('openrouter-oss', 'deepseek', 'deepseek/deepseek-v4-flash-0731', stdout);

    expect(verdict.status).toBe('eligible');
    expect(verdict.ineligibilityReasons).toBeNull();
  });

  it('reports unknown (never a false eligible) when the stream errored without the structured ineligibility shape', async () => {
    // DEC-0009 edge case: derived by mutating a real capture (renaming the
    // key `parseOpenRouterIneligibility` keys off), never hand-invented.
    const real = await readFixture('pi-output-errored-single-message.jsonl');
    const mutated = real.replace(/ineligibility_reasons/g, 'ineligibility_reasons_renamed');
    expect(mutated).not.toBe(real);

    const verdict = deriveEndpointEligibility('openrouter-openai', 'gpt-5.6-terra-or', 'openai/gpt-5.6-terra', mutated);

    expect(verdict.status).toBe('unknown');
    expect(verdict.ineligibilityReasons).toBeNull();
  });

  it('reports eligible when the stream carries no error event at all (empty stream)', () => {
    const verdict = deriveEndpointEligibility('openrouter-oss', 'deepseek', 'deepseek/deepseek-v4-flash-0731', '');
    expect(verdict.status).toBe('eligible');
    expect(verdict.ineligibilityReasons).toBeNull();
  });
});

describe('probeEndpointEligibility (candidate selection + config-time wiring)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-eligibility-config-'));
    await mkdir(join(dir, 'wiki', '.dispatch'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves to [] when wiki/.dispatch has no config at all', async () => {
    const result = await probeEndpointEligibility(dir);
    expect(result).toEqual([]);
  });

  it('resolves to [] when no backend carries provider/zdr request_params (e.g. seat-billed claude/codex backends only)', async () => {
    await writeFile(
      join(dir, 'wiki', '.dispatch', 'backends.json'),
      JSON.stringify({
        'claude-saas': { family: 'claude', base_url: null, api_key_env: null, secrets_file: null },
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'wiki', '.dispatch', 'models.json'),
      JSON.stringify({ 'claude-sonnet-5': { available_on: ['claude-saas'], model_id: 'claude-sonnet-5' } }),
      'utf8',
    );

    const result = await probeEndpointEligibility(dir);
    expect(result).toEqual([]);
  });

  it('reports unknown (and fires no probe) for a qualifying pair whose API key cannot be resolved', async () => {
    await writeFile(
      join(dir, 'wiki', '.dispatch', 'backends.json'),
      JSON.stringify({
        'openrouter-openai': {
          family: 'pi',
          base_url: 'https://openrouter.ai/api/v1',
          api_key_env: 'OPENROUTER_API_KEY',
          secrets_file: join(dir, 'does-not-exist.env'),
          request_params: { provider: { only: ['OpenAI'], data_collection: 'deny' }, zdr: true },
        },
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'wiki', '.dispatch', 'models.json'),
      JSON.stringify({
        'gpt-5.6-terra-or': { available_on: ['openrouter-openai'], model_id: 'openai/gpt-5.6-terra' },
      }),
      'utf8',
    );

    const result = await probeEndpointEligibility(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      backend: 'openrouter-openai',
      modelAlias: 'gpt-5.6-terra-or',
      modelId: 'openai/gpt-5.6-terra',
      status: 'unknown',
      ineligibilityReasons: null,
    });
  });
});

describe('probeEndpointEligibility (end-to-end against a real spawned process)', () => {
  let dir: string;
  let fakeBinDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-eligibility-e2e-'));
    fakeBinDir = await mkdtemp(join(tmpdir(), 'kb-eligibility-fakebin-'));
    await mkdir(join(dir, 'wiki', '.dispatch'), { recursive: true });
    originalPath = process.env['PATH'];
    process.env['PATH'] = `${fakeBinDir}${originalPath ? `:${originalPath}` : ''}`;
  });

  afterEach(async () => {
    if (originalPath !== undefined) process.env['PATH'] = originalPath;
    else delete process.env['PATH'];
    await rm(dir, { recursive: true, force: true });
    await rm(fakeBinDir, { recursive: true, force: true });
  });

  /** Fake `pi` executable that replays a real captured fixture's stdout verbatim, standing in for the real binary (same convention as dispatch-v2-spawn.test.ts's fake `bwrap`). */
  async function installFakePi(fixtureName: string): Promise<void> {
    const piPath = join(fakeBinDir, 'pi');
    await writeFile(piPath, `#!/bin/sh\ncat ${JSON.stringify(join(FIXTURES_DIR, fixtureName))}\nexit 0\n`, 'utf8');
    await chmod(piPath, 0o755);
  }

  async function writeSecretsFile(): Promise<string> {
    const secretsPath = join(dir, 'secrets.env');
    await writeFile(secretsPath, 'OPENROUTER_API_KEY=test-key-value\n', 'utf8');
    return secretsPath;
  }

  it.skipIf(process.platform === 'win32')(
    'fires the dry-run probe and reports ineligible, echoing the real 404 body\'s reasons + configure URLs',
    async () => {
      await installFakePi('pi-output-errored-single-message.jsonl');
      const secretsPath = await writeSecretsFile();

      await writeFile(
        join(dir, 'wiki', '.dispatch', 'backends.json'),
        JSON.stringify({
          'openrouter-openai': {
            family: 'pi',
            base_url: 'https://openrouter.ai/api/v1',
            api_key_env: 'OPENROUTER_API_KEY',
            secrets_file: secretsPath,
            request_params: { provider: { only: ['OpenAI'], data_collection: 'deny' }, zdr: true },
          },
        }),
        'utf8',
      );
      await writeFile(
        join(dir, 'wiki', '.dispatch', 'models.json'),
        JSON.stringify({
          'gpt-5.6-terra-or': { available_on: ['openrouter-openai'], model_id: 'openai/gpt-5.6-terra' },
        }),
        'utf8',
      );

      const result = await probeEndpointEligibility(dir);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('ineligible');
      expect(result[0].ineligibilityReasons).toEqual([
        { reason: 'zdr-violation-by-account', endpoint_count: 1, configure_url: 'https://openrouter.ai/settings/privacy' },
        { reason: 'zdr-violation-by-guardrail', endpoint_count: 1, configure_url: 'https://openrouter.ai/workspaces/default/guardrails' },
      ]);
    },
    30000,
  );

  it.skipIf(process.platform === 'win32')(
    'fires the dry-run probe and reports eligible for a real captured successful completion (deepseek/openrouter-oss)',
    async () => {
      await installFakePi('pi-output-code-review.jsonl');
      const secretsPath = await writeSecretsFile();

      await writeFile(
        join(dir, 'wiki', '.dispatch', 'backends.json'),
        JSON.stringify({
          'openrouter-oss': {
            family: 'pi',
            base_url: 'https://openrouter.ai/api/v1',
            api_key_env: 'OPENROUTER_API_KEY',
            secrets_file: secretsPath,
            request_params: { provider: { only: ['Fireworks', 'CoreWeave'], data_collection: 'deny' }, zdr: true },
          },
        }),
        'utf8',
      );
      await writeFile(
        join(dir, 'wiki', '.dispatch', 'models.json'),
        JSON.stringify({
          deepseek: { available_on: ['openrouter-oss'], model_id: 'deepseek/deepseek-v4-flash-0731' },
        }),
        'utf8',
      );

      const result = await probeEndpointEligibility(dir);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        backend: 'openrouter-oss',
        modelAlias: 'deepseek',
        modelId: 'deepseek/deepseek-v4-flash-0731',
        status: 'eligible',
        ineligibilityReasons: null,
      });
    },
    30000,
  );
});

describe('checkEnvironment (WK-0189 wiring)', () => {
  it('carries endpointEligibility: [] when the target dir has no wiki/.dispatch config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-eligibility-checkenv-'));
    try {
      const result = await checkEnvironment(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.endpointEligibility).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

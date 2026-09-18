/** PLN-0004 D6 Phase 3 — buildWorkerEnv unit tests (env-policy.ts). */
import { afterEach, describe, expect, it } from 'vitest';

import { buildWorkerEnv } from '../packages/dispatch-core/src/env-policy.js';

describe('buildWorkerEnv — secret-shaped (exact names)', () => {
  it('drops every well-known secret var, keeps a safe survivor', () => {
    const result = buildWorkerEnv({
      inheritEnv: {
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'shh',
        AWS_SESSION_TOKEN: 'shh',
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/creds.json',
        ANTHROPIC_API_KEY: 'sk-ant-shh',
        OPENAI_API_KEY: 'sk-shh',
        GITHUB_TOKEN: 'ghp_shh',
        GH_TOKEN: 'ghp_shh',
        NPM_TOKEN: 'npm_shh',
        HOME: '/home/worker',
      },
    });
    expect(result).toEqual({ HOME: '/home/worker' });
  });
});

describe('buildWorkerEnv — secret-shaped (pattern-matched)', () => {
  it('drops vars shaped like secrets even when not on the exact-name list', () => {
    const result = buildWorkerEnv({
      inheritEnv: {
        MY_API_KEY: 'shh',
        CUSTOM_TOKEN: 'shh',
        DB_PASSWORD: 'shh',
        SOME_SECRET: 'shh',
        TLS_PRIVATE_KEY: 'shh',
        VENDOR_CREDENTIAL: 'shh',
        ENCRYPTION_KEY: 'shh',
        HOME: '/home/worker',
      },
    });
    expect(result).toEqual({ HOME: '/home/worker' });
  });
});

describe('buildWorkerEnv — posture', () => {
  it('drops NODE_ENV and CI, keeps a safe survivor', () => {
    const result = buildWorkerEnv({
      inheritEnv: { NODE_ENV: 'production', CI: 'true', HOME: '/home/worker' },
    });
    expect(result).toEqual({ HOME: '/home/worker' });
  });
});

describe('buildWorkerEnv — behavior-affecting', () => {
  it('drops NODE_OPTIONS/NODE_PATH and every proxy var, both cases', () => {
    const result = buildWorkerEnv({
      inheritEnv: {
        NODE_OPTIONS: '--inspect',
        NODE_PATH: '/usr/lib/node_modules',
        HTTP_PROXY: 'http://proxy:8080',
        HTTPS_PROXY: 'http://proxy:8080',
        ALL_PROXY: 'socks5://proxy:1080',
        NO_PROXY: 'localhost',
        http_proxy: 'http://proxy:8080',
        https_proxy: 'http://proxy:8080',
        all_proxy: 'socks5://proxy:1080',
        no_proxy: 'localhost',
        HOME: '/home/worker',
      },
    });
    expect(result).toEqual({ HOME: '/home/worker' });
  });

  it('never lets a proxy var through, even when absent from the input', () => {
    const result = buildWorkerEnv({ inheritEnv: { HOME: '/home/worker', PATH: '/usr/bin' } });
    const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy'];
    for (const key of proxyKeys) expect(result).not.toHaveProperty(key);
    expect(result).toEqual({ HOME: '/home/worker', PATH: '/usr/bin' });
  });
});

describe('buildWorkerEnv — safe vars preserved', () => {
  it('keeps ordinary shell/session vars, values included', () => {
    const safeEnv = {
      HOME: '/home/worker',
      PATH: '/usr/local/bin:/usr/bin',
      USER: 'worker',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      SHELL: '/bin/bash',
      EDITOR: 'vim',
    };
    expect(buildWorkerEnv({ inheritEnv: safeEnv })).toEqual(safeEnv);
  });
});

describe('buildWorkerEnv — undefined values', () => {
  it('drops keys whose value is undefined, even for an otherwise-safe name', () => {
    const result = buildWorkerEnv({
      inheritEnv: { HOME: '/home/worker', UNSET_VAR: undefined, PATH: undefined },
    });
    expect(result).toEqual({ HOME: '/home/worker' });
  });
});

describe('buildWorkerEnv — defaults to process.env', () => {
  const realEnv = process.env;

  afterEach(() => {
    process.env = realEnv;
  });

  it('falls back to process.env, still applying the deny list', () => {
    process.env = { HOME: '/home/worker', AWS_SECRET_ACCESS_KEY: 'shh' };
    expect(buildWorkerEnv({})).toEqual({ HOME: '/home/worker' });
  });
});

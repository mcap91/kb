/**
 * Shared test helper (WK-0252 slice a): points `XDG_CONFIG_HOME` at a fresh
 * mkdtemp root and writes `host.json` there, so every test exercising
 * `resolveModelFromConfig` / `resolveCredentials` / `runDispatch` gets an
 * isolated host-local config — never the real operator config or `~/.secrets`
 * (constraint: "no test reads the real operator config").
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOST_CONFIG_FILENAME } from '../packages/dispatch-core/src/host-config.js';

export interface HostConfigFixture {
  backends?: Record<string, { reachable: boolean; secrets_file: string | null }>;
  profiles?: Record<string, Record<string, string>>;
}

/** Writes an isolated host.json under a temp XDG_CONFIG_HOME; returns a teardown that restores the env var and removes the temp root. */
export async function setUpHostConfig(fixture: HostConfigFixture = {}): Promise<() => Promise<void>> {
  const root = await mkdtemp(join(tmpdir(), 'kb-host-config-'));
  const previousXdg = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = root;

  const dispatchDir = join(root, 'kb-dispatch');
  await mkdir(dispatchDir, { recursive: true });
  await writeFile(
    join(dispatchDir, HOST_CONFIG_FILENAME),
    JSON.stringify({ schemaVersion: 1, backends: fixture.backends ?? {}, profiles: fixture.profiles ?? {} }, null, 2),
    'utf8',
  );

  return async () => {
    if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = previousXdg;
    await rm(root, { recursive: true, force: true });
  };
}

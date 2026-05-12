import { describe, expect, it } from 'vitest';

import { buildSpawnInvocation } from '../packages/dispatch-core/src/spawn.js';

describe('dispatch spawn invocation', () => {
  it('wraps Windows .cmd launchers through cmd.exe with quoted arguments', () => {
    expect(
      buildSpawnInvocation(
        'C:\\Program Files\\tools\\tsx.cmd',
        [
          'C:\\Users\\alice\\My Projects\\kb\\tests\\fixtures\\fake-agent.ts',
          'C:\\Users\\alice\\My Projects\\kb\\.agent-runs\\wrapper.md',
        ],
        'win32',
        'cmd.exe',
      ),
    ).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '"C:\\Program Files\\tools\\tsx.cmd" "C:\\Users\\alice\\My Projects\\kb\\tests\\fixtures\\fake-agent.ts" "C:\\Users\\alice\\My Projects\\kb\\.agent-runs\\wrapper.md"',
      ],
      shell: false,
    });
  });

  it('leaves non-Windows launches unchanged', () => {
    expect(
      buildSpawnInvocation(
        '/usr/bin/tsx',
        ['/repo/tests/fixtures/fake-agent.ts'],
        'linux',
      ),
    ).toEqual({
      command: '/usr/bin/tsx',
      args: ['/repo/tests/fixtures/fake-agent.ts'],
      shell: false,
    });
  });
});

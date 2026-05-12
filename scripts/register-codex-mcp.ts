import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  buildCodexCommandInvocation,
  createCodexMcpRegistrations,
  getCodexExecutable,
} from './mcp-self-hosting.js';

const REPO_ROOT = resolve(process.cwd());
const CODEX = getCodexExecutable();

function runCodex(args: string[], stdio: 'inherit' | 'pipe', allowFailure = false): number {
  const invocation = buildCodexCommandInvocation(CODEX, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    stdio,
    encoding: 'utf-8',
  });

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      throw new Error(
        'Codex CLI was not found on PATH. Install Codex first, then rerun `npm run codex:mcp:register`.',
      );
    }
    throw result.error;
  }

  const status = result.status ?? 1;
  if (!allowFailure && status !== 0) {
    process.exit(status);
  }

  return status;
}

for (const registration of createCodexMcpRegistrations(REPO_ROOT)) {
  const exists = runCodex(['mcp', 'get', registration.name], 'pipe', true) === 0;

  if (exists) {
    console.log(`Updating Codex MCP server ${registration.name} -> ${REPO_ROOT}`);
    runCodex(['mcp', 'remove', registration.name], 'inherit');
  } else {
    console.log(`Adding Codex MCP server ${registration.name} -> ${REPO_ROOT}`);
  }

  runCodex(
    ['mcp', 'add', registration.name, '--', registration.command, ...registration.args],
    'inherit',
  );
}

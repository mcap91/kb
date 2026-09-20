import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { EnvironmentCapabilityStatus, Handoff, HostCapabilitiesRecord } from '@kb/dispatch-core';

const TESTS_DIR = resolve(process.cwd(), 'tests');
const DISPATCH_CLI = resolve(process.cwd(), 'packages', 'dispatch-cli', 'src', 'index.ts');

async function makeTempDir(prefix = 'kb-dispatch-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function getTsxPath(): string {
  const repoRoot = resolve(TESTS_DIR, '..');
  if (process.platform === 'win32') {
    return join(repoRoot, 'node_modules', '.bin', 'tsx.cmd');
  }
  return join(repoRoot, 'node_modules', '.bin', 'tsx');
}

function fakeAgentBaseArgv(fixturePath: string): string[] {
  // Mirror the production fake-agent launcher: run the fixture via node's in-process
  // tsx loader, not the tsx binary (whose IPC pipe is blocked in container sandboxes).
  const repoRoot = resolve(TESTS_DIR, '..');
  const loaderUrl = pathToFileURL(join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return [process.execPath, '--import', loaderUrl, fixturePath];
}

function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeBareAgentLauncher(binDir: string, commandName: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const agentScriptPath = join(binDir, 'bare-agent.cjs');
  await writeFile(
    agentScriptPath,
    [
      "const { writeFileSync } = require('node:fs');",
      "const responsePath = process.env.AGENT_BLACKBOARD_RESPONSE_PATH;",
      "if (!responsePath) process.exit(2);",
      "writeFileSync(responsePath, '# Bare Agent Response\\n\\nresolved bare command\\n', 'utf-8');",
      '',
    ].join('\n'),
    'utf-8',
  );

  const commandPath = join(binDir, process.platform === 'win32' ? `${commandName}.CMD` : commandName);
  const commandBody = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${agentScriptPath}" %*\r\n`
    : `#!/bin/sh\nexec ${quotePosixArg(process.execPath)} ${quotePosixArg(agentScriptPath)} "$@"\n`;
  await writeFile(commandPath, commandBody, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(commandPath, 0o755);
  }

  return commandPath;
}

async function writeStdoutAgentLauncher(binDir: string, commandName: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const agentScriptPath = join(binDir, `${commandName}-stdout-agent.cjs`);
  await writeFile(
    agentScriptPath,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf-8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write([",
      "    '# Fake Claude Response',",
      "    '',",
      "    `argv: ${JSON.stringify(process.argv.slice(2))}`,",
      "    `cwd: ${process.cwd()}`,",
      "    `wrapper_bytes: ${Buffer.byteLength(input, 'utf-8')}`,",
      "  ].join('\\n'));",
      "});",
      '',
    ].join('\n'),
    'utf-8',
  );

  const commandPath = join(binDir, process.platform === 'win32' ? `${commandName}.CMD` : commandName);
  const commandBody = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${agentScriptPath}" %*\r\n`
    : `#!/bin/sh\nexec ${quotePosixArg(process.execPath)} ${quotePosixArg(agentScriptPath)} "$@"\n`;
  await writeFile(commandPath, commandBody, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(commandPath, 0o755);
  }

  return commandPath;
}

async function writeFakeBwrapLauncher(binDir: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const agentScriptPath = join(binDir, 'fake-bwrap.cjs');
  await writeFile(
    agentScriptPath,
    [
      "const { spawn } = require('node:child_process');",
      "const args = process.argv.slice(2);",
      "let i = 0;",
      "while (i < args.length) {",
      "  const arg = args[i];",
      "  if (arg === '--die-with-parent' || arg === '--unshare-all') { i += 1; continue; }",
      "  if (arg === '--ro-bind' || arg === '--bind') { i += 3; continue; }",
      "  if (arg === '--proc' || arg === '--dev') { i += 2; continue; }",
      "  break;",
      "}",
      "const command = args[i];",
      "if (!command) { process.exit(2); }",
      "const child = spawn(command, args.slice(i + 1), { stdio: 'inherit', shell: false, env: process.env });",
      "child.on('error', (err) => { console.error(String(err)); process.exit(1); });",
      "child.on('close', (code) => process.exit(code ?? 1));",
      '',
    ].join('\n'),
    'utf-8',
  );

  const commandPath = join(binDir, process.platform === 'win32' ? 'bwrap.CMD' : 'bwrap');
  const commandBody = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${agentScriptPath}" %*\r\n`
    : `#!/bin/sh\nexec ${quotePosixArg(process.execPath)} ${quotePosixArg(agentScriptPath)} "$@"\n`;
  await writeFile(commandPath, commandBody, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(commandPath, 0o755);
  }

  return commandPath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function makeManualHandoff(overrides?: Partial<{
  id: string;
  title: string;
  subject: string;
  allowed_agents: string[];
  mode: string;
  write_scope: string[];
}>): string {
  const id = overrides?.id ?? 'HO-0001';
  const title = overrides?.title ?? 'Test Handoff';
  const subject = overrides?.subject ?? 'kb:test';
  const agents = overrides?.allowed_agents ?? ['fake-agent'];
  const mode = overrides?.mode ?? 'implement';
  const writeScope = overrides?.write_scope ?? [];

  return [
    '---',
    'schema_version: 1',
    `id: ${id}`,
    `title: ${title}`,
    `subject: ${subject}`,
    `allowed_agents: [${agents.join(', ')}]`,
    `mode: ${mode}`,
    ...(writeScope.length > 0 ? ['write_scope:', ...writeScope.map((item) => `  - ${item}`)] : []),
    '---',
    '',
    '# Goal',
    'Exercise the dispatch pipeline.',
    '',
    '## Read First',
    '- AGENTS.md',
    '- README.md',
    '',
    '## Constraints',
    '- Keep tests deterministic',
    '',
  ].join('\n');
}

async function setupBootstrappedRepo(repoRoot: string): Promise<void> {
  const { bootstrap } = await import('@kb/wiki-core');
  const result = await bootstrap({ dir: repoRoot, repo: 'test/repo' });
  if (!result.ok) {
    throw new Error(result.message);
  }

  await writeFile(join(repoRoot, 'AGENTS.md'), '# Test agent guide\n');
  await writeFile(join(repoRoot, 'README.md'), '# Test repo\n');
  await mkdir(join(repoRoot, 'docs'), { recursive: true });
  await writeFile(join(repoRoot, 'docs', 'dispatch.md'), '# Dispatch doc\n');
}

type TestRegistry = {
  version: 1;
  agents: Record<string, unknown>;
};

async function writeRegistry(configDir: string, fakeAgentPath: string, registry?: TestRegistry): Promise<void> {
  const defaultRegistry: TestRegistry = {
    version: 1,
    agents: {
      claude: {
        base_argv: ['claude'],
        noninteractive_argv: [
          '--print',
          '--output-format',
          'text',
          '--no-session-persistence',
          '--settings',
          '{"disableAllHooks":true}',
        ],
        instruction_transport: { kind: 'stdin' },
        response_transport: { kind: 'stdout_capture' },
        timeout_seconds: 1800,
        read_only: {
          supported: true,
          argv_suffix: ['--permission-mode', 'default', '--disallowedTools', 'Edit Write NotebookEdit Bash'],
          response_writable: true,
        },
        env: {
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
          CLAUDE_CODE_DISABLE_CRON: '1',
          CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
        },
      },
      codex: {
        base_argv: ['codex', 'exec'],
        noninteractive_argv: [],
        instruction_transport: { kind: 'stdin' },
        response_transport: { kind: 'file' },
        response_arg: ['-o', '{response_path}'],
        timeout_seconds: 1800,
        read_only: {
          supported: true,
          argv_suffix: ['--sandbox', 'read-only'],
          response_writable: true,
        },
      },
      'fake-agent': {
        base_argv: fakeAgentBaseArgv(fakeAgentPath),
        noninteractive_argv: [],
        instruction_transport: { kind: 'argv_content' },
        wrapper_arg: ['{wrapper_content}'],
        response_transport: { kind: 'file' },
        response_arg: [],
        timeout_seconds: 30,
        read_only: {
          supported: true,
          argv_suffix: [],
          response_writable: true,
        },
      },
    },
  };

  await writeFile(
    join(configDir, 'launchers.v1.json'),
    JSON.stringify(registry ?? defaultRegistry, null, 2),
  );
}

describe('dispatch', () => {
  let tempDir: string;
  let repoRoot: string;
  let originalAppData: string | undefined;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalPath: string | undefined;
  let originalPathExt: string | undefined;
  let originalXdgConfigHome: string | undefined;

  const fakeAgentPath = resolve(TESTS_DIR, 'fixtures', 'fake-agent.ts');
  const delayedStdoutAgentPath = resolve(TESTS_DIR, 'fixtures', 'delayed-stdout-agent.mjs');

  beforeEach(async () => {
    tempDir = await makeTempDir();
    repoRoot = join(tempDir, 'repo');
    await mkdir(repoRoot, { recursive: true });

    originalAppData = process.env['APPDATA'];
    originalHome = process.env['HOME'];
    originalUserProfile = process.env['USERPROFILE'];
    originalPath = process.env['PATH'];
    originalPathExt = process.env['PATHEXT'];
    originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
  });

  afterEach(async () => {
    if (originalAppData !== undefined) {
      process.env['APPDATA'] = originalAppData;
    } else {
      delete process.env['APPDATA'];
    }

    if (originalHome !== undefined) {
      process.env['HOME'] = originalHome;
    } else {
      delete process.env['HOME'];
    }

    if (originalUserProfile !== undefined) {
      process.env['USERPROFILE'] = originalUserProfile;
    } else {
      delete process.env['USERPROFILE'];
    }

    if (originalPath !== undefined) {
      process.env['PATH'] = originalPath;
    } else {
      delete process.env['PATH'];
    }

    if (originalPathExt !== undefined) {
      process.env['PATHEXT'] = originalPathExt;
    } else {
      delete process.env['PATHEXT'];
    }

    if (originalXdgConfigHome !== undefined) {
      process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
    } else {
      delete process.env['XDG_CONFIG_HOME'];
    }

    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });

  async function setupConfig(): Promise<string> {
    let actualConfigDir: string;
    if (process.platform === 'win32') {
      const appdata = join(tempDir, 'config');
      process.env['APPDATA'] = appdata;
      actualConfigDir = join(appdata, 'kb-dispatch');
    } else {
      const home = join(tempDir, 'posix-home');
      process.env['HOME'] = home;
      // Ensure the HOME-based fallback is exercised, not an ambient XDG override.
      delete process.env['XDG_CONFIG_HOME'];
      actualConfigDir = join(home, '.config', 'kb-dispatch');
    }

    await mkdir(actualConfigDir, { recursive: true });
    await mkdir(join(actualConfigDir, 'pending'), { recursive: true });
    await mkdir(join(actualConfigDir, 'launching'), { recursive: true });
    await mkdir(join(actualConfigDir, 'consumed'), { recursive: true });
    await mkdir(join(actualConfigDir, 'rejected'), { recursive: true });

    return actualConfigDir;
  }

  async function setupConfigWithKey(): Promise<string> {
    const dir = await setupConfig();
    const { generateKey } = await import('@kb/dispatch-core');
    await generateKey();
    return dir;
  }

  async function setupFullConfig(registry?: TestRegistry): Promise<string> {
    const dir = await setupConfigWithKey();
    await writeRegistry(dir, fakeAgentPath, registry);
    return dir;
  }

  describe('createHandoff', () => {
    it('creates the next HO handoff from the repo template', async () => {
      await setupBootstrappedRepo(repoRoot);
      const { createHandoff } = await import('@kb/dispatch-core');

      const result = await createHandoff({
        dir: repoRoot,
        title: 'Implement reviewed bundle launch',
        subject: 'kb:dispatch',
        allowed_agents: ['codex', 'claude'],
        mode: 'implement',
        work_item: 'WK-0001',
        write_scope: ['packages/dispatch-core/src/launch.ts'],
        read_first: ['AGENTS.md', 'docs/dispatch.md'],
        objective: 'Launch agents from reviewed bundles instead of the live repo root.',
        constraints: ['Preserve signed review and launch tokens.'],
        expected_output: 'Updated dispatch core, CLI, MCP, and tests.',
        context: 'This handoff was authored by dispatch-core for operator review.',
        acceptance: ['Feature works as described'],
        validation: ['npm run typecheck && npm test'],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.handoffId).toBe('HO-0001');
      expect(result.data.handoffRelativePath).toBe('wiki/handoffs/HO-0001.md');

      const content = await readFile(join(repoRoot, result.data.handoffRelativePath), 'utf-8');
      expect(content).toContain('id: "HO-0001"');
      expect(content).toContain('title: "Implement reviewed bundle launch"');
      expect(content).toContain('subject: "kb:dispatch"');
      expect(content).toContain('work_item: "WK-0001"');
      expect(content).toContain('- codex');
      expect(content).toContain('- claude');
      expect(content).toContain('- AGENTS.md');
      expect(content).toContain('- docs/dispatch.md');
      expect(content).toContain('Launch agents from reviewed bundles instead of the live repo root.');
      expect(content).toContain('acceptance:');
      expect(content).toContain('- Feature works as described');
      expect(content).toContain('validation:');
      expect(content).toContain('- npm run typecheck && npm test');
      expect(content).toContain('base_ref:');
      expect(content).toContain('web: false');
    });

    it('allocates sequential HO ids via wiki-core allocator', async () => {
      await setupBootstrappedRepo(repoRoot);
      const { createHandoff } = await import('@kb/dispatch-core');

      const r1 = await createHandoff({
        dir: repoRoot,
        title: 'First handoff',
        subject: 'kb:dispatch',
        allowed_agents: ['codex'],
        mode: 'implement',
        work_item: 'WK-0001',
        acceptance: ['Feature works as described'],
        validation: ['npm run typecheck && npm test'],
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect(r1.data.handoffId).toBe('HO-0001');

      const r2 = await createHandoff({
        dir: repoRoot,
        title: 'Second handoff',
        subject: 'kb:dispatch',
        allowed_agents: ['codex'],
        mode: 'implement',
        work_item: 'WK-0002',
        acceptance: ['Feature works as described'],
        validation: ['npm run typecheck && npm test'],
      });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.data.handoffId).toBe('HO-0002');
    });

    it('round-trips through ho.ts parseHandoff', async () => {
      await setupBootstrappedRepo(repoRoot);
      const { createHandoff, parseHandoff } = await import('@kb/dispatch-core');

      const result = await createHandoff({
        dir: repoRoot,
        title: 'Round-trip test handoff',
        subject: 'kb:dispatch',
        allowed_agents: ['claude'],
        mode: 'implement',
        work_item: 'WK-0003',
        acceptance: ['Feature X works end-to-end', 'No regressions in existing tests'],
        validation: ['npm run typecheck && npm test'],
        write_scope: ['packages/dispatch-core/src/'],
        web: true,
        credentials: ['GITHUB_TOKEN'],
        data_mounts: ['/data/models'],
        base_ref: 'main',
        read_first: ['AGENTS.md'],
        vars: ['DEBUG=1'],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Parse the written file through ho.ts — the only parser
      const parsed = await parseHandoff(result.data.handoffPath);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      // Verify all v2 fields survived the round-trip
      expect(parsed.data.id).toBe(result.data.handoffId);
      expect(parsed.data.title).toBe('Round-trip test handoff');
      expect(parsed.data.mode).toBe('implement');
      expect(parsed.data.write_scope).toEqual(['packages/dispatch-core/src/']);
      expect(parsed.data.acceptance).toEqual(['Feature X works end-to-end', 'No regressions in existing tests']);
      expect(parsed.data.validation).toEqual(['npm run typecheck && npm test']);
      expect(parsed.data.web).toBe(true);
      expect(parsed.data.credentials).toEqual(['GITHUB_TOKEN']);
      expect(parsed.data.data_mounts).toEqual(['/data/models']);
      expect(parsed.data.base_ref).toBe('main');
      expect(parsed.data.read_first).toEqual(['AGENTS.md']);
      expect(parsed.data.vars).toEqual(['DEBUG=1']);
    });
  });

  describe('WK-0116 initiative-resolution gate', () => {
    function gitInit(dir: string): void {
      execSync('git init', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
    }

    function gitCommitAll(dir: string, message: string): void {
      execSync('git add -A', { cwd: dir, stdio: 'ignore' });
      execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'ignore' });
    }

    function makeGateHandoff(overrides: Partial<Handoff> = {}): Handoff {
      return {
        id: 'HO-0002',
        title: 'WK-0116 gate test handoff',
        mode: 'implement',
        write_scope: ['src/'],
        base_ref: null,
        web: false,
        credentials: [],
        data_mounts: [],
        read_first: [],
        vars: [],
        acceptance: ['AC-1: example'],
        validation: ['true'],
        status: 'draft',
        ...overrides,
      };
    }

    async function writeWorkItem(repo: string, id: string, opts: { initiative?: string } = {}): Promise<void> {
      await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
      const initiativeLine = opts.initiative !== undefined ? `initiative: ${opts.initiative}\n` : '';
      await writeFile(
        join(repo, 'wiki', 'issues', `${id}.md`),
        `---\nid: "${id}"\ntitle: "Fixture ${id}"\nstatus: todo\n${initiativeLine}---\n\n# ${id}: Fixture\n`,
        'utf-8',
      );
    }

    async function writeInitiative(repo: string, id: string): Promise<void> {
      await mkdir(join(repo, 'wiki', 'initiatives'), { recursive: true });
      await writeFile(
        join(repo, 'wiki', 'initiatives', `${id}.md`),
        `---\nid: "${id}"\ntitle: "Fixture ${id}"\nstatus: todo\n---\n\n# ${id}: Fixture\n`,
        'utf-8',
      );
    }

    beforeEach(() => {
      gitInit(repoRoot);
    });

    it('refuses an implement handoff that does not declare a work_item', async () => {
      await writeFile(join(repoRoot, 'README.md'), '# test\n');
      gitCommitAll(repoRoot, 'init');

      const { checkAdmission } = await import('@kb/dispatch-core');
      const result = await checkAdmission(makeGateHandoff(), repoRoot);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('UNRESOLVED_INITIATIVE');
      expect(result.message).toContain('work_item');
    });

    it('refuses an implement handoff whose work_item WK has no initiative set', async () => {
      await writeWorkItem(repoRoot, 'WK-0201');
      gitCommitAll(repoRoot, 'init');

      const { checkAdmission } = await import('@kb/dispatch-core');
      const result = await checkAdmission(makeGateHandoff({ work_item: 'WK-0201' }), repoRoot);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('UNRESOLVED_INITIATIVE');
      expect(result.message).toContain('WK-0201');
    });

    it('refuses an implement handoff whose work_item WK has a malformed initiative', async () => {
      await writeWorkItem(repoRoot, 'WK-0202', { initiative: 'NOT-AN-IN' });
      gitCommitAll(repoRoot, 'init');

      const { checkAdmission } = await import('@kb/dispatch-core');
      const result = await checkAdmission(makeGateHandoff({ work_item: 'WK-0202' }), repoRoot);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('UNRESOLVED_INITIATIVE');
      expect(result.message).toContain('NOT-AN-IN');
    });

    it('refuses an implement handoff whose work_item WK points at a nonexistent initiative', async () => {
      await writeWorkItem(repoRoot, 'WK-0203', { initiative: 'IN-9999' });
      gitCommitAll(repoRoot, 'init');

      const { checkAdmission } = await import('@kb/dispatch-core');
      const result = await checkAdmission(makeGateHandoff({ work_item: 'WK-0203' }), repoRoot);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('UNRESOLVED_INITIATIVE');
      expect(result.message).toContain('IN-9999');
    });

    it('admits an implement handoff whose work_item WK resolves to a real initiative', async () => {
      await writeWorkItem(repoRoot, 'WK-0204', { initiative: 'IN-0204' });
      await writeInitiative(repoRoot, 'IN-0204');
      gitCommitAll(repoRoot, 'init');

      const { checkAdmission } = await import('@kb/dispatch-core');
      const result = await checkAdmission(makeGateHandoff({ work_item: 'WK-0204' }), repoRoot);

      expect(result.ok).toBe(true);
    });

    it('admits a research handoff with no work_item (gate is implement-only)', async () => {
      await writeFile(join(repoRoot, 'README.md'), '# test\n');
      gitCommitAll(repoRoot, 'init');

      const { checkAdmission } = await import('@kb/dispatch-core');
      const result = await checkAdmission(makeGateHandoff({ mode: 'research', write_scope: [] }), repoRoot);

      expect(result.ok).toBe(true);
    });

    it('parseHandoffContent accepts a well-formed work_item and rejects a malformed one', async () => {
      const { parseHandoffContent } = await import('@kb/dispatch-core');
      const base = [
        '---',
        'id: HO-0002',
        'title: Parse-time work_item validation',
        'mode: implement',
        'write_scope: ["src/"]',
        'work_item: WK-0205',
        'acceptance:',
        '  - "AC-1: example"',
        'validation: ["true"]',
        'status: draft',
        '---',
        '',
        '## Context',
      ].join('\n');

      const good = parseHandoffContent(base, 'HO-0002.md');
      expect(good.ok).toBe(true);
      if (good.ok) expect(good.data.work_item).toBe('WK-0205');

      const bad = parseHandoffContent(base.replace('work_item: WK-0205', 'work_item: not-a-wk'), 'HO-0002.md');
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toBe('BAD_RECORD');
    });
  });

  describe('lookup', () => {
    it('returns RUN_NOT_FOUND for nonexistent runId', async () => {
      await setupBootstrappedRepo(repoRoot);
      const { resolveRun } = await import('@kb/dispatch-core');

      const resolved = await resolveRun({
        dir: repoRoot,
        runId: 'RUN-00000000-0000-0000-0000-999999999999',
      });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error).toBe('RUN_NOT_FOUND');
      }
    });
  });

  describe('environment checks', () => {
    it('writes an operator-owned host capability record', async () => {
      const binDir = join(tempDir, 'capability-bin');
      if (process.platform === 'linux') {
        await writeFakeBwrapLauncher(binDir);
      } else {
        await mkdir(binDir, { recursive: true });
      }

      const pathValue = process.platform === 'linux'
        ? binDir
        : process.env['PATH'] ?? originalPath ?? '';
      await setupFullConfig({
        version: 1,
        agents: {
          claude: {
            base_argv: ['claude'],
            noninteractive_argv: ['--print', '--output-format', 'text', '--no-session-persistence'],
            instruction_transport: { kind: 'stdin' },
            response_transport: { kind: 'stdout_capture' },
            timeout_seconds: 30,
            read_only: {
              supported: true,
              argv_suffix: ['--permission-mode', 'default', '--disallowedTools', 'Edit Write NotebookEdit Bash'],
              response_writable: true,
            },
            env: {
              PATH: pathValue,
              PATHEXT: '.CMD;.EXE',
            },
          },
          codex: {
            base_argv: ['codex', 'exec'],
            noninteractive_argv: [],
            instruction_transport: { kind: 'stdin' },
            response_transport: { kind: 'file' },
            response_arg: ['-o', '{response_path}'],
            timeout_seconds: 30,
            read_only: {
              supported: true,
              argv_suffix: ['--sandbox', 'read-only'],
              response_writable: true,
            },
            env: {
              PATH: pathValue,
              PATHEXT: '.CMD;.EXE',
            },
          },
        },
      });

      const { checkEnvironment, getHostCapabilitiesPath } = await import('@kb/dispatch-core');
      const result = await checkEnvironment();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.recordPath).toBe(getHostCapabilitiesPath());
      expect(await pathExists(result.data.recordPath)).toBe(true);
      expect(result.data.record.schema_version).toBe(1);
      expect(result.data.record.registry_hash).toBeTruthy();
      if (process.platform === 'linux') {
        expect(result.data.record.capabilities.claude_linux_sandbox.status).toBe('supported');
        expect(result.data.record.capabilities.claude_linux_add_dir.status).toBe('supported');
        expect(result.data.record.capabilities.codex_linux_sandbox.status).toBe('supported');
      } else {
        expect(result.data.record.capabilities.claude_linux_sandbox.status).toBe('not_applicable');
        expect(result.data.record.capabilities.claude_linux_add_dir.status).toBe('not_applicable');
        expect(result.data.record.capabilities.codex_linux_sandbox.status).toBe('not_applicable');
      }
    });

    it('returns route verdicts and records container + writability facts', async () => {
      await setupFullConfig();

      const { checkEnvironment } = await import('@kb/dispatch-core');
      const result = await checkEnvironment();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Facts are persisted on the record...
      expect(result.data.record.container).toBeDefined();
      expect(result.data.record.writability).toBeDefined();
      expect(result.data.record.writability!.config_dir.writable).toBe(true);

      // ...and verdicts are derived (not persisted) for every core route.
      const routes = result.data.verdicts.map((v) => v.route);
      expect(routes).toEqual(expect.arrayContaining([
        'plain-adapters',
        'claude-headless',
        'write_scope-enforcement',
        'codex',
        'redteam',
      ]));
      const plain = result.data.verdicts.find((v) => v.route === 'plain-adapters');
      expect(plain?.viability).toBe('available');
    });
  });

  const synthCapabilityRecord = (options: {
    platform?: NodeJS.Platform;
    claudeBasic?: EnvironmentCapabilityStatus;
    claudeAddDir?: EnvironmentCapabilityStatus;
    codex?: EnvironmentCapabilityStatus;
    homeWritable?: boolean;
    configWritable?: boolean;
    kubernetes?: boolean;
  } = {}): HostCapabilitiesRecord => {
    const checkedAt = '2026-07-10T00:00:00.000Z';
    const cap = (status: EnvironmentCapabilityStatus) => ({
      status,
      checked_at: checkedAt,
      detail: `${status} (synthetic)`,
    });
    return {
      schema_version: 1,
      checked_at: checkedAt,
      platform: options.platform ?? 'linux',
      arch: 'x64',
      registry_hash: 'sha256:test',
      capabilities: {
        claude_linux_sandbox: cap(options.claudeBasic ?? 'supported'),
        claude_linux_add_dir: cap(options.claudeAddDir ?? 'supported'),
        codex_linux_sandbox: cap(options.codex ?? 'supported'),
      },
      container: {
        detected: options.kubernetes ?? false,
        kubernetes_service_host: options.kubernetes ?? false,
        dockerenv: false,
        cgroup_hint: null,
      },
      writability: {
        home: { path: '/home/user', writable: options.homeWritable ?? true, detail: 'synthetic' },
        config_dir: {
          path: '/work/.kbconfig/kb-dispatch',
          writable: options.configWritable ?? true,
          detail: 'synthetic',
        },
      },
    };
  };

  describe('config dir resolution (XDG)', () => {
    it('honors a set, non-empty XDG_CONFIG_HOME on POSIX', async () => {
      const { resolveConfigDir } = await import('@kb/dispatch-core');
      expect(resolveConfigDir('linux', { XDG_CONFIG_HOME: '/work/.kbconfig', HOME: '/home/user' }))
        .toBe(join('/work/.kbconfig', 'kb-dispatch'));
    });

    it('falls back to ~/.config when XDG_CONFIG_HOME is unset on POSIX', async () => {
      const { resolveConfigDir } = await import('@kb/dispatch-core');
      expect(resolveConfigDir('linux', { HOME: '/home/user' }))
        .toBe(join('/home/user', '.config', 'kb-dispatch'));
    });

    it('falls back to ~/.config when XDG_CONFIG_HOME is set but empty on POSIX', async () => {
      const { resolveConfigDir } = await import('@kb/dispatch-core');
      expect(resolveConfigDir('linux', { XDG_CONFIG_HOME: '', HOME: '/home/user' }))
        .toBe(join('/home/user', '.config', 'kb-dispatch'));
    });

    it('throws on POSIX when neither XDG_CONFIG_HOME nor HOME is set', async () => {
      const { resolveConfigDir } = await import('@kb/dispatch-core');
      expect(() => resolveConfigDir('linux', {})).toThrow(/HOME is not set/);
    });

    it('ignores XDG_CONFIG_HOME on Windows and prefers APPDATA', async () => {
      const { resolveConfigDir } = await import('@kb/dispatch-core');
      expect(resolveConfigDir('win32', { APPDATA: 'C:\\AppData', XDG_CONFIG_HOME: '/ignored' }))
        .toBe(join('C:\\AppData', 'kb-dispatch'));
    });

    it('falls back to USERPROFILE/.config on Windows when APPDATA is unset', async () => {
      const { resolveConfigDir } = await import('@kb/dispatch-core');
      expect(resolveConfigDir('win32', { USERPROFILE: 'C:\\Users\\u' }))
        .toBe(join('C:\\Users\\u', '.config', 'kb-dispatch'));
    });
  });

  describe('launch environment gate', () => {
    it('redteam blocks claude on a linux host that cannot start the kernel sandbox', async () => {
      const { gateLaunchEnvironment } = await import('@kb/dispatch-core');
      const result = gateLaunchEnvironment(
        synthCapabilityRecord({ claudeBasic: 'unsupported' }),
        'claude',
        'redteam',
        false,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('ENVIRONMENT_UNSUPPORTED');
    });

    it('redteam blocks codex on a linux host that cannot start the kernel sandbox', async () => {
      const { gateLaunchEnvironment } = await import('@kb/dispatch-core');
      const result = gateLaunchEnvironment(
        synthCapabilityRecord({ codex: 'unsupported' }),
        'codex',
        'redteam',
        false,
      );
      expect(result.ok).toBe(false);
    });

    it('redteam still passes when the kernel sandbox is supported', async () => {
      const { gateLaunchEnvironment } = await import('@kb/dispatch-core');
      const result = gateLaunchEnvironment(synthCapabilityRecord({}), 'claude', 'redteam', false);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.warnings).toEqual([]);
    });

    it('non-redteam never blocks codex even when the bwrap probe is unsupported', async () => {
      const { gateLaunchEnvironment } = await import('@kb/dispatch-core');
      const result = gateLaunchEnvironment(
        synthCapabilityRecord({ codex: 'unsupported' }),
        'codex',
        'implement',
        false,
      );
      expect(result.ok).toBe(true);
    });

    it('non-redteam never blocks claude when the basic bwrap probe is unsupported', async () => {
      const { gateLaunchEnvironment } = await import('@kb/dispatch-core');
      const result = gateLaunchEnvironment(
        synthCapabilityRecord({ claudeBasic: 'unsupported', claudeAddDir: 'unsupported' }),
        'claude',
        'implement',
        false,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.warnings).toEqual([]);
    });

    it('non-redteam claude with write_scope on a bwrap-less host proceeds with an app-level warning', async () => {
      const { gateLaunchEnvironment } = await import('@kb/dispatch-core');
      const result = gateLaunchEnvironment(
        synthCapabilityRecord({ claudeAddDir: 'unsupported' }),
        'claude',
        'implement',
        true,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.warnings.length).toBe(1);
        expect(result.data.warnings[0]).toMatch(/app-level/i);
      }
    });

    it('non-redteam claude with write_scope on a kernel-capable host emits no warning', async () => {
      const { gateLaunchEnvironment } = await import('@kb/dispatch-core');
      const result = gateLaunchEnvironment(
        synthCapabilityRecord({ claudeAddDir: 'supported' }),
        'claude',
        'implement',
        true,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.warnings).toEqual([]);
    });

    it('does not hard-stop on a non-linux host record', async () => {
      const { gateLaunchEnvironment } = await import('@kb/dispatch-core');
      const result = gateLaunchEnvironment(
        synthCapabilityRecord({
          platform: 'win32',
          claudeBasic: 'not_applicable',
          claudeAddDir: 'not_applicable',
          codex: 'not_applicable',
        }),
        'claude',
        'redteam',
        true,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('route viability verdicts', () => {
    const verdictFor = (
      verdicts: Array<{ route: string; viability: string; detail: string }>,
      route: string,
    ): { route: string; viability: string; detail: string } => {
      const found = verdicts.find((v) => v.route === route);
      if (!found) throw new Error(`missing verdict for ${route}`);
      return found;
    };

    it('reports the core routes available on a kernel-capable host', async () => {
      const { deriveRouteVerdicts } = await import('@kb/dispatch-core');
      const verdicts = deriveRouteVerdicts(synthCapabilityRecord({}));
      expect(verdictFor(verdicts, 'plain-adapters').viability).toBe('available');
      expect(verdictFor(verdicts, 'claude-headless').viability).toBe('available');
      expect(verdictFor(verdicts, 'write_scope-enforcement').detail).toMatch(/kernel/i);
      expect(verdictFor(verdicts, 'redteam').viability).toBe('available');
    });

    it('degrades write_scope enforcement and blocks redteam on a pod-like host', async () => {
      const { deriveRouteVerdicts } = await import('@kb/dispatch-core');
      const verdicts = deriveRouteVerdicts(synthCapabilityRecord({
        claudeBasic: 'unsupported',
        claudeAddDir: 'unsupported',
        codex: 'unsupported',
        kubernetes: true,
      }));
      expect(verdictFor(verdicts, 'plain-adapters').viability).toBe('available');
      expect(verdictFor(verdicts, 'claude-headless').viability).toBe('available');
      const ws = verdictFor(verdicts, 'write_scope-enforcement');
      expect(ws.viability).toBe('degraded');
      expect(ws.detail).toMatch(/app-level/i);
      expect(verdictFor(verdicts, 'redteam').viability).toBe('blocked');
      expect(verdictFor(verdicts, 'codex').viability).toBe('unknown');
    });

    it('blocks every launch route when the config store is not writable', async () => {
      const { deriveRouteVerdicts } = await import('@kb/dispatch-core');
      const verdicts = deriveRouteVerdicts(synthCapabilityRecord({ configWritable: false }));
      expect(verdictFor(verdicts, 'plain-adapters').viability).toBe('blocked');
      expect(verdictFor(verdicts, 'claude-headless').viability).toBe('blocked');
      expect(verdictFor(verdicts, 'codex').viability).toBe('blocked');
      expect(verdictFor(verdicts, 'redteam').viability).toBe('blocked');
      expect(verdictFor(verdicts, 'plain-adapters').detail).toMatch(/XDG_CONFIG_HOME/);
    });
  });

  describe('container detection', () => {
    it('flags a Kubernetes host via KUBERNETES_SERVICE_HOST', async () => {
      const { detectContainer } = await import('@kb/dispatch-core');
      const original = process.env['KUBERNETES_SERVICE_HOST'];
      process.env['KUBERNETES_SERVICE_HOST'] = '172.20.0.1';
      try {
        const detection = await detectContainer();
        expect(detection.kubernetes_service_host).toBe(true);
        expect(detection.detected).toBe(true);
      } finally {
        if (original !== undefined) process.env['KUBERNETES_SERVICE_HOST'] = original;
        else delete process.env['KUBERNETES_SERVICE_HOST'];
      }
    });

    it('does not flag Kubernetes without the service-host env var', async () => {
      const { detectContainer } = await import('@kb/dispatch-core');
      const original = process.env['KUBERNETES_SERVICE_HOST'];
      delete process.env['KUBERNETES_SERVICE_HOST'];
      try {
        const detection = await detectContainer();
        expect(detection.kubernetes_service_host).toBe(false);
        if (process.platform === 'win32') expect(detection.detected).toBe(false);
      } finally {
        if (original !== undefined) process.env['KUBERNETES_SERVICE_HOST'] = original;
      }
    });
  });

  describe('cleanup', () => {
    it('removes orphan review directories from .agent-runs', async () => {
      await setupFullConfig();
      await setupBootstrappedRepo(repoRoot);
      const { cleanup } = await import('@kb/dispatch-core');

      const orphanId = `RV-${randomUUID()}`;
      const orphanDir = join(repoRoot, '.agent-runs', 'reviews', orphanId, 'metadata');
      await mkdir(orphanDir, { recursive: true });
      await writeFile(join(orphanDir, 'review.json'), '{}');

      const result = await cleanup({
        dir: repoRoot,
        maxAgeDays: 0,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.orphanReviews).toContain(orphanId);
      }
    });
  });

  describe('registry loading', () => {
    it('returns migration guidance for legacy launcher registry files', async () => {
      const configDir = await setupConfigWithKey();
      await writeFile(
        join(configDir, 'launchers.v1.json'),
        `${JSON.stringify({
          version: 1,
          agents: {
            codex: {
              command: 'codex',
              args: ['exec'],
            },
          },
        }, null, 2)}\n`,
      );

      const { loadRegistry } = await import('@kb/dispatch-core');
      const result = await loadRegistry();

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBe('PARSE_ERROR');
      expect(result.message).toContain('launchers.v1.json');
      expect(result.message).toContain('init-config --force');
    });

    it('normalizes legacy Claude argv_content profiles to stdin transport', async () => {
      const { resolveAgentConfig } = await import('@kb/dispatch-core');

      const result = resolveAgentConfig({
        version: 1,
        agents: {
          claude: {
            base_argv: ['claude'],
            noninteractive_argv: ['--print', '--output-format', 'text', '--no-session-persistence'],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'stdout_capture' },
            timeout_seconds: 1800,
            read_only: {
              supported: true,
              argv_suffix: ['--permission-mode', 'default'],
              response_writable: true,
            },
          },
        },
      }, 'claude', 'code_review');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.instruction_transport).toEqual({ kind: 'stdin' });
      expect(result.data.wrapper_arg).toBeUndefined();
      expect(result.data.noninteractive_argv).toContain('--settings');
      expect(result.data.env).toMatchObject({
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CLAUDE_CODE_DISABLE_CRON: '1',
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
      });
    });

    it('normalizes legacy Codex argv_content profiles to stdin transport', async () => {
      const { resolveAgentConfig } = await import('@kb/dispatch-core');

      const result = resolveAgentConfig({
        version: 1,
        agents: {
          codex: {
            base_argv: ['codex', 'exec'],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'file' },
            response_arg: ['-o', '{response_path}'],
            timeout_seconds: 1800,
            read_only: {
              supported: true,
              argv_suffix: ['--sandbox', 'read-only'],
              response_writable: true,
            },
          },
        },
      }, 'codex', 'code_review');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.instruction_transport).toEqual({ kind: 'stdin' });
      expect(result.data.wrapper_arg).toBeUndefined();
      expect(result.data.response_arg).toEqual(['-o', '{response_path}']);
    });
  });

  describe('dispatch-cli', () => {
    it('init-config writes adapter-aware default agent profiles', async () => {
      let configDir: string;
      if (process.platform === 'win32') {
        const appdata = join(tempDir, 'config');
        process.env['APPDATA'] = appdata;
        configDir = join(appdata, 'kb-dispatch');
      } else {
        const home = join(tempDir, 'posix-home');
        process.env['HOME'] = home;
        configDir = join(home, '.config', 'kb-dispatch');
      }

      execSync(`"${getTsxPath()}" "${DISPATCH_CLI}" init-config`, {
        cwd: resolve(TESTS_DIR, '..'),
        env: process.env,
        encoding: 'utf-8',
        windowsHide: true,
      });

      const registryRaw = await readFile(join(configDir, 'launchers.v1.json'), 'utf-8');
      const registry = JSON.parse(registryRaw) as {
        agents: {
          claude: {
            base_argv: string[];
            noninteractive_argv: string[];
            instruction_transport: { kind: string };
            wrapper_arg?: string[];
            env?: Record<string, string>;
          };
          codex: {
            base_argv: string[];
            noninteractive_argv: string[];
            instruction_transport: { kind: string };
            wrapper_arg?: string[];
            response_transport: { kind: string };
            response_arg: string[];
          };
          'fake-agent': {
            base_argv: string[];
          };
        };
      };

      expect(registry.agents.claude.base_argv).toEqual(['claude']);
      expect(registry.agents.claude.noninteractive_argv).toEqual([
        '--print',
        '--output-format',
        'text',
        '--no-session-persistence',
        '--settings',
        '{"disableAllHooks":true}',
      ]);
      expect(registry.agents.claude.instruction_transport.kind).toBe('stdin');
      expect(registry.agents.claude.wrapper_arg).toBeUndefined();
      expect(registry.agents.claude.env).toEqual({
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CLAUDE_CODE_DISABLE_CRON: '1',
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
      });
      expect(registry.agents.codex.base_argv).toEqual(['codex', 'exec']);
      expect(registry.agents.codex.noninteractive_argv).toEqual([]);
      expect(registry.agents.codex.instruction_transport.kind).toBe('stdin');
      expect(registry.agents.codex.wrapper_arg).toBeUndefined();
      expect(registry.agents.codex.response_transport.kind).toBe('file');
      expect(registry.agents.codex.response_arg).toEqual(['-o', '{response_path}']);
      expect(Object.hasOwn(registry.agents, 'codex-danger-full-access')).toBe(false);
      const fakeArgv = registry.agents['fake-agent'].base_argv;
      // The fake-agent launcher must NOT use the tsx binary: its IPC pipe (listen() on a
      // /tmp socket) is blocked in container sandboxes such as Saturn pods. It runs the
      // fixture via node's in-process tsx loader instead. See WK-0034 Saturn validation.
      expect(fakeArgv[0]).not.toMatch(/tsx(\.cmd)?$/i);
      expect(fakeArgv).toContain('--import');
      const loaderSpec = fakeArgv[fakeArgv.indexOf('--import') + 1]!;
      expect(loaderSpec).toContain('tsx/dist/loader.mjs');
      expect(fakeArgv[fakeArgv.length - 1]).toMatch(/fake-agent\.ts$/);
    });
  });

});

describe('runProcess timeout guard', () => {
  it('kills a child that never exits and reports failure within the timeout', async () => {
    // Regression: on container sandboxes (Saturn pods) the bwrap probe spawns a process
    // that neither exits nor errors under seccomp, hanging check-environment forever.
    // runProcess must bound the wait so the probe degrades to "unsupported" rather than hang.
    const { runProcess } = await import('@kb/dispatch-core');
    const result = await runProcess(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000)'],
      process.env,
      1000,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('timeout');
  }, 8000);
});

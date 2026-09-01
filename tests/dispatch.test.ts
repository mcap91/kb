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
import type { EnvironmentCapabilityStatus, HostCapabilitiesRecord } from '@kb/dispatch-core';

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
    });

    it('allocates the next HO id by scanning existing handoffs', async () => {
      await setupBootstrappedRepo(repoRoot);
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ id: 'HO-0001' }),
      );

      const { createHandoff } = await import('@kb/dispatch-core');
      const result = await createHandoff({
        dir: repoRoot,
        title: 'Create the second handoff',
        subject: 'kb:dispatch',
        allowed_agents: ['codex'],
        mode: 'implement',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.handoffId).toBe('HO-0002');
    });
  });

  describe('review', () => {
    it('creates portfolio-style reviewed bundles with agent-visible and metadata trees', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, makeManualHandoff());

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const bundlePath = result.data.bundlePath;
      expect(await pathExists(join(bundlePath, 'agent-visible', 'wrapper.md'))).toBe(true);
      expect(await pathExists(join(bundlePath, 'agent-visible', 'handoff.snapshot.md'))).toBe(true);
      expect(await pathExists(join(bundlePath, 'agent-visible', 'context'))).toBe(true);
      expect(await pathExists(join(bundlePath, 'metadata', 'input-manifest.json'))).toBe(true);
      expect(await pathExists(join(bundlePath, 'metadata', 'review.json'))).toBe(true);
      expect(await pathExists(join(bundlePath, 'review-manifest.json'))).toBe(false);

      const wrapper = await readFile(join(bundlePath, 'agent-visible', 'wrapper.md'), 'utf-8');
      expect(wrapper).toContain('AGENT_BLACKBOARD_REPO_ROOT');
      expect(wrapper).toContain('AGENT_BLACKBOARD_RESPONSE_PATH');
      expect(wrapper).toContain('The launcher starts you inside the reviewed bundle directory.');

      const manifestRaw = await readFile(join(bundlePath, 'metadata', 'input-manifest.json'), 'utf-8');
      const manifest = JSON.parse(manifestRaw) as {
        handoff_snapshot: { path: string };
        context_files: Array<{ source_path: string }>;
      };

      expect(manifest.handoff_snapshot.path).toBe('agent-visible/handoff.snapshot.md');
      expect(manifest.context_files.map((entry) => entry.source_path)).toEqual(['AGENTS.md', 'README.md']);
    });

    it('records reviewed write_scope data in the signed input manifest', async () => {
      await setupBootstrappedRepo(repoRoot);
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'main.ts'), 'export const value = 1;\n');
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({
          write_scope: ['src/main.ts', 'docs/generated.ts'],
        }),
      );

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const manifestRaw = await readFile(join(result.data.bundlePath, 'metadata', 'input-manifest.json'), 'utf-8');
      const manifest = JSON.parse(manifestRaw) as {
        reviewed_write_scope: {
          declared_paths: string[];
          entries: Array<{
            declared_path: string;
            path_kind: string;
            access_directory: string;
          }>;
          access_directories: string[];
        };
      };

      expect(manifest.reviewed_write_scope.declared_paths).toEqual(['src/main.ts', 'docs/generated.ts']);
      expect(manifest.reviewed_write_scope.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          declared_path: 'src/main.ts',
          path_kind: 'file',
          access_directory: join(repoRoot, 'src'),
        }),
        expect.objectContaining({
          declared_path: 'docs/generated.ts',
          path_kind: 'missing',
          access_directory: join(repoRoot, 'docs'),
        }),
      ]));
      expect(manifest.reviewed_write_scope.access_directories).toEqual([
        join(repoRoot, 'docs'),
        join(repoRoot, 'src'),
      ]);
    });

    it('rejects write_scope paths that escape the repo root', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({
          write_scope: ['../outside.md'],
        }),
      );

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('INVALID_HANDOFF');
        expect(result.message).toContain('write_scope path escapes repo root');
      }
    });

    it('rejects redteam review for an agent without read-only support', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig({
        version: 1,
        agents: {
          'fake-agent': {
            base_argv: [getTsxPath(), fakeAgentPath],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'file' },
            response_arg: [],
            timeout_seconds: 30,
            read_only: {
              supported: false,
            },
          },
        },
      });

      const { review } = await import('@kb/dispatch-core');
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ mode: 'redteam' }),
      );

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('INVALID_AGENT');
        expect(result.message.toLowerCase()).toContain('read-only');
      }
    });
  });

  describe('launch', () => {
    it('launches the child from agent-visible and points it at handoff.snapshot.md', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      const response = launchResult.data.response ?? '';
      const runAgentVisibleDir = join(launchResult.data.runDir, 'agent-visible');
      const runHandoffPath = join(runAgentVisibleDir, 'handoff.snapshot.md');
      expect(response).toMatch(/^---\nschema_version: 1\n/);
      expect(response).toContain(`status: completed`);
      expect(response).toContain('Fake Agent Response');
      expect(response).toContain(`cwd: ${runAgentVisibleDir}`);
      expect(response).toContain(`handoff_path: ${runHandoffPath}`);
      expect(response).toContain('handoff_exists: true');
      expect(await pathExists(join(launchResult.data.runDir, 'response.md'))).toBe(true);
      expect(await pathExists(join(launchResult.data.runDir, 'metadata', 'state.json'))).toBe(true);

      const launchMetadataRaw = await readFile(
        join(launchResult.data.runDir, 'metadata', 'launch.json'),
        'utf-8',
      );
      const launchMetadata = JSON.parse(launchMetadataRaw) as {
        token_state: string;
        response_path: string;
      };
      expect(launchMetadata.token_state).toBe('consumed');
      expect(launchMetadata.response_path).toBe(join(launchResult.data.runDir, 'response.md'));

      const stateMetadataRaw = await readFile(
        join(launchResult.data.runDir, 'metadata', 'state.json'),
        'utf-8',
      );
      const stateMetadata = JSON.parse(stateMetadataRaw) as {
        status: string;
        pid: number;
        pgid: number;
        heartbeat_at: string;
      };
      expect(stateMetadata.status).toBe('completed');
      expect(stateMetadata.pid).toBeGreaterThan(0);
      expect(stateMetadata.pgid).toBeGreaterThan(0);
      expect(stateMetadata.heartbeat_at).toBeTruthy();

      expect(await pathExists(join(launchResult.data.runDir, 'metadata', 'meta.json'))).toBe(true);
      expect(await pathExists(join(launchResult.data.runDir, 'metadata', 'review.json'))).toBe(true);
      expect(await pathExists(join(launchResult.data.runDir, 'metadata', 'input-manifest.json'))).toBe(true);

      const metaRaw = await readFile(join(launchResult.data.runDir, 'metadata', 'meta.json'), 'utf-8');
      const meta = JSON.parse(metaRaw) as {
        status: string;
        response_sha256: string;
        argv_redacted: string[];
        operator_id: string;
        launcher_version: string;
      };
      expect(meta.status).toBe('completed');
      expect(meta.response_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(meta.argv_redacted).toContain('<wrapper_content>');
      expect(meta.operator_id).toBeTruthy();
      expect(meta.launcher_version).toBe('1.0.0');
    }, 30000);

    it('adds reviewed write_scope directories to Claude launches without widening to repo root', async () => {
      await setupBootstrappedRepo(repoRoot);
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'main.ts'), 'export const value = 1;\n');
      const binDir = join(tempDir, 'claude-bin');
      await writeStdoutAgentLauncher(binDir, 'claude');
      if (process.platform === 'linux') {
        await writeFakeBwrapLauncher(binDir);
      }

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
              PATH: binDir,
              PATHEXT: '.CMD;.EXE',
            },
          },
        },
      });
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({
          allowed_agents: ['claude'],
          write_scope: ['src/main.ts', 'docs'],
        }),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'claude',
        reviewedAndAcceptRisks: true,
      });
      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });
      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      const response = launchResult.data.response ?? '';
      const argvMatch = response.match(/^argv: (.+)$/m);
      expect(argvMatch).toBeTruthy();
      if (!argvMatch) return;

      const argv = JSON.parse(argvMatch[1]!) as string[];
      const addDirValues = argv.flatMap((value, index) => argv[index - 1] === '--add-dir' ? [value] : []);
      expect(addDirValues).toEqual(expect.arrayContaining([
        join(repoRoot, 'docs'),
        join(repoRoot, 'src'),
      ]));
      expect(addDirValues).not.toContain(repoRoot);
    }, 30_000);

    it('fails before spawn when the reviewed write_scope parent is no longer accessible', async () => {
      await setupBootstrappedRepo(repoRoot);
      await mkdir(join(repoRoot, 'generated'), { recursive: true });
      const binDir = join(tempDir, 'claude-preflight-bin');
      await writeStdoutAgentLauncher(binDir, 'claude');
      if (process.platform === 'linux') {
        await writeFakeBwrapLauncher(binDir);
      }

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
              PATH: binDir,
              PATHEXT: '.CMD;.EXE',
            },
          },
        },
      });
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({
          allowed_agents: ['claude'],
          write_scope: ['generated/output.ts'],
        }),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'claude',
        reviewedAndAcceptRisks: true,
      });
      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      await rm(join(repoRoot, 'generated'), { recursive: true, force: true });

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });
      expect(launchResult.ok).toBe(false);
      if (!launchResult.ok) {
        expect(launchResult.error).toBe('ENVIRONMENT_UNSUPPORTED');
        expect(launchResult.message).toContain('write_scope path generated/output.ts is not accessible');
      }
    }, 30_000);

    it('proceeds with an app-level warning when additional-directory sandbox is unsupported (non-redteam)', async () => {
      if (process.platform !== 'linux') {
        return;
      }

      await setupBootstrappedRepo(repoRoot);
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'main.ts'), 'export const value = 1;\n');
      const binDir = join(tempDir, 'claude-no-bwrap-bin');
      await writeStdoutAgentLauncher(binDir, 'claude');

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
              PATH: binDir,
              PATHEXT: '.CMD;.EXE',
            },
          },
        },
      });
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({
          allowed_agents: ['claude'],
          write_scope: ['src/main.ts'],
        }),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'claude',
        reviewedAndAcceptRisks: true,
      });
      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });
      // Non-redteam launches are no longer hard-stopped by a failing bwrap probe.
      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      // --add-dir is still passed even though bwrap could not start...
      const response = launchResult.data.response ?? '';
      const argvMatch = response.match(/^argv: (.+)$/m);
      expect(argvMatch).toBeTruthy();
      if (argvMatch) {
        const argv = JSON.parse(argvMatch[1]!) as string[];
        const addDirValues = argv.flatMap((value, index) => argv[index - 1] === '--add-dir' ? [value] : []);
        expect(addDirValues).toContain(join(repoRoot, 'src'));
      }

      // ...and the run records that write_scope enforcement is app-level only here.
      const launchJson = JSON.parse(
        await readFile(join(launchResult.data.runDir, 'metadata', 'launch.json'), 'utf-8'),
      ) as { warnings?: string[] };
      expect(launchJson.warnings).toBeDefined();
      expect(launchJson.warnings!.some((w) => /app-level/i.test(w))).toBe(true);
    }, 30_000);

    it('resolves a bare launcher command at launch time before spawning', async () => {
      await setupBootstrappedRepo(repoRoot);
      const commandName = 'kb-bare-agent';
      const binDir = join(tempDir, 'bare-bin');
      await writeBareAgentLauncher(binDir, commandName);
      await setupFullConfig({
        version: 1,
        agents: {
          'bare-agent': {
            base_argv: [commandName],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'file' },
            response_arg: [],
            timeout_seconds: 30,
            env: {
              PATH: binDir,
              PATHEXT: '.CMD;.EXE',
            },
            read_only: {
              supported: true,
              argv_suffix: ['--read-only'],
              response_writable: true,
            },
          },
        },
      });
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ allowed_agents: ['bare-agent'] }),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'bare-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;
      expect(launchResult.data.response).toContain('Bare Agent Response');
      expect(launchResult.data.response).toContain('resolved bare command');
    }, 30000);

    it('streams stdout capture into response.md and records active state before exit', async () => {
      await setupBootstrappedRepo(repoRoot);
      const cfgDir = await setupFullConfig({
        version: 1,
        agents: {
          'stream-agent': {
            base_argv: ['node', delayedStdoutAgentPath],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'stdout_capture' },
            timeout_seconds: 30,
            env: {
              FAKE_AGENT_DELAY_MS: '1500',
            },
            read_only: {
              supported: true,
              argv_suffix: ['--read-only'],
              response_writable: true,
            },
          },
        },
      });

      const { review, launch } = await import('@kb/dispatch-core');
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ allowed_agents: ['stream-agent'] }),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'stream-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const launchPromise = launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      const handoffRunsDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0001');
      await waitUntil(async () => {
        try {
          return (await readdir(handoffRunsDir)).length > 0;
        } catch {
          return false;
        }
      }, 10000);

      const [runId] = await readdir(handoffRunsDir);
      const runDir = join(handoffRunsDir, runId!);
      const responsePath = join(runDir, 'response.md');
      const statePath = join(runDir, 'metadata', 'state.json');

      await waitUntil(async () => {
        if (!await pathExists(responsePath) || !await pathExists(statePath)) {
          return false;
        }
        const liveResponse = await readFile(responsePath, 'utf-8');
        return liveResponse.includes('stream-start');
      }, 10000);

      const stateRaw = await readFile(statePath, 'utf-8');
      const state = JSON.parse(stateRaw) as {
        status: string;
        pid: number;
        pgid: number;
        heartbeat_at: string;
      };
      expect(state.status).toBe('running');
      expect(state.pid).toBeGreaterThan(0);
      expect(state.pgid).toBeGreaterThan(0);
      expect(state.heartbeat_at).toBeTruthy();

      expect(await pathExists(join(cfgDir, 'consumed', `${reviewResult.data.reviewId}.json`))).toBe(true);
      expect(await pathExists(join(cfgDir, 'launching', `${reviewResult.data.reviewId}.json`))).toBe(false);

      const launchResult = await launchPromise;
      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      const finalResponse = await readFile(responsePath, 'utf-8');
      expect(finalResponse).toContain('stream-end');
    }, 30000);

    it('fails on empty agent response', async () => {
      await setupBootstrappedRepo(repoRoot);
      const emptyAgentPath = join(tempDir, 'empty-agent.ts');
      await writeFile(emptyAgentPath, 'process.exit(0);\n');

      const cfgDir = await setupFullConfig({
        version: 1,
        agents: {
          'fake-agent': {
            base_argv: [getTsxPath(), emptyAgentPath],
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
      });

      const { review, launch } = await import('@kb/dispatch-core');
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(false);
      if (!launchResult.ok) {
        expect(launchResult.error).toBe('EMPTY_RESPONSE');
      }

      const consumedFiles = await readdir(join(cfgDir, 'consumed'));
      expect(consumedFiles).toContain(`${reviewResult.data.reviewId}.json`);

      const runIds = await readdir(join(repoRoot, '.agent-runs', 'runs', 'HO-0001'));
      expect(runIds).toHaveLength(1);
      const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0001', runIds[0]!);

      const launchMetadataRaw = await readFile(join(runDir, 'metadata', 'launch.json'), 'utf-8');
      const launchMetadata = JSON.parse(launchMetadataRaw) as {
        token_state: string;
        completed_at: string;
        error: string;
      };
      expect(launchMetadata.token_state).toBe('consumed');

      const metaRaw = await readFile(join(runDir, 'metadata', 'meta.json'), 'utf-8');
      const meta = JSON.parse(metaRaw) as {
        status: string;
        response_path: string;
      };
      expect(meta.status).toBe('failed');

      const stateRaw = await readFile(join(runDir, 'metadata', 'state.json'), 'utf-8');
      const state = JSON.parse(stateRaw) as {
        status: string;
      };
      expect(state.status).toBe('failed');

      const response = await readFile(join(runDir, 'response.md'), 'utf-8');
      expect(response).toContain('# Launcher diagnostic');
      expect(response).toContain('adapter exited without producing a response body');
    }, 30000);

    it('fails when the reviewed bundle hash changes after review', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      await writeFile(
        join(reviewResult.data.bundlePath, 'agent-visible', 'handoff.snapshot.md'),
        'tampered\n',
      );

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(false);
      if (!launchResult.ok) {
        expect(launchResult.error).toBe('HASH_MISMATCH');
      }
    });

    it('launch.json includes response_transport and path fields', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });
      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      const launchJsonPath = join(launchResult.data.runDir, 'metadata', 'launch.json');
      const launchJson = JSON.parse(await readFile(launchJsonPath, 'utf-8'));

      expect(launchJson.response_transport).toBe('file');
      expect(launchJson.stderr_path).toEqual(expect.any(String));
      expect(launchJson.stdout_path).toEqual(expect.any(String));
      expect(launchJson.token_state).toBe('consumed');
    }, 30000);

    it('launch.json includes response_transport for stdout_capture agent', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig({
        version: 1,
        agents: {
          'stream-agent': {
            base_argv: ['node', delayedStdoutAgentPath],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'stdout_capture' },
            timeout_seconds: 30,
            env: { FAKE_AGENT_DELAY_MS: '100' },
            read_only: {
              supported: true,
              argv_suffix: [],
              response_writable: true,
            },
          },
        },
      });

      const { review, launch } = await import('@kb/dispatch-core');
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ allowed_agents: ['stream-agent'] }),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'stream-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });
      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      const launchJsonPath = join(launchResult.data.runDir, 'metadata', 'launch.json');
      const launchJson = JSON.parse(await readFile(launchJsonPath, 'utf-8'));

      expect(launchJson.response_transport).toBe('stdout_capture');
      expect(launchJson.stdout_path).toBeNull();
      expect(launchJson.stderr_path).toEqual(expect.any(String));
    }, 30000);

    it('creates response.md before agent spawn', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      let responseExistedAtSpawn = false;
      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
        onEvent: async (event) => {
          if (event.type === 'run_created') {
            responseExistedAtSpawn = await pathExists(event.responsePath);
          }
        },
      });
      expect(launchResult.ok).toBe(true);
      expect(responseExistedAtSpawn).toBe(true);
    }, 30000);
  });

  describe('lookup', () => {
    it('resolves a run by runId', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, resolveRun } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const resolved = await resolveRun({ dir: repoRoot, runId: run.data.runId });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.data.runId).toBe(run.data.runId);
      expect(resolved.data.reviewId).toBe(rev.data.reviewId);
      expect(resolved.data.handoffId).toBe('HO-0001');
      expect(resolved.data.runDir).toBe(run.data.runDir);
    }, 30000);

    it('resolves a run by reviewId', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, resolveRun } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const resolved = await resolveRun({ dir: repoRoot, reviewId: rev.data.reviewId });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.data.runId).toBe(run.data.runId);
      expect(resolved.data.reviewId).toBe(rev.data.reviewId);
    }, 30000);

    it('rejects mismatched reviewId and runId', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, resolveRun } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const resolved = await resolveRun({
        dir: repoRoot,
        reviewId: rev.data.reviewId,
        runId: 'RUN-00000000-0000-0000-0000-000000000000',
      });
      expect(resolved.ok).toBe(false);
    }, 30000);

    it('reads run artifacts with metadata and response', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, readRunArtifacts } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const artifacts = await readRunArtifacts(run.data.runDir, { includeMeta: true });
      expect(artifacts.ok).toBe(true);
      if (!artifacts.ok) return;
      expect(artifacts.data.response).toEqual(expect.any(String));
      expect(artifacts.data.status).toBe('completed');
      expect(artifacts.data.launch).not.toBeNull();
      expect(artifacts.data.meta).not.toBeNull();
    }, 30000);

    it('reads run artifacts with logs', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, readRunArtifacts } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const artifacts = await readRunArtifacts(run.data.runDir, { includeMeta: true, includeLogs: true });
      expect(artifacts.ok).toBe(true);
      if (!artifacts.ok) return;
      expect(artifacts.data.logs).toBeDefined();
      expect(artifacts.data.logs!.stderr).toEqual(expect.any(String));
    }, 30000);

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

    it('rejects cross-run mismatch with LOOKUP_FAILED', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, resolveRun } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ id: 'HO-0001' }),
      );
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0002.md'),
        makeManualHandoff({ id: 'HO-0002', title: 'Second handoff' }),
      );

      const revA = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(revA.ok).toBe(true);
      if (!revA.ok) return;

      const runA = await launch({ reviewId: revA.data.reviewId, dir: repoRoot });
      expect(runA.ok).toBe(true);
      if (!runA.ok) return;

      const revB = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0002.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(revB.ok).toBe(true);
      if (!revB.ok) return;

      const runB = await launch({ reviewId: revB.data.reviewId, dir: repoRoot });
      expect(runB.ok).toBe(true);
      if (!runB.ok) return;

      const resolved = await resolveRun({
        dir: repoRoot,
        reviewId: revA.data.reviewId,
        runId: runB.data.runId,
      });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error).toBe('LOOKUP_FAILED');
      }
    }, 30000);

    it('readRunArtifacts falls back to meta.json for paths and runId', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, readRunArtifacts } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      // Delete launch.json to force fallback to meta.json
      const launchJsonPath = join(run.data.runDir, 'metadata', 'launch.json');
      await rm(launchJsonPath);

      const artifacts = await readRunArtifacts(run.data.runDir, { includeMeta: true, includeLogs: true });
      expect(artifacts.ok).toBe(true);
      if (!artifacts.ok) return;
      expect(artifacts.data.runId).toMatch(/^RUN-/);
      expect(artifacts.data.stderrPath).toEqual(expect.any(String));
      expect(artifacts.data.status).toBe('completed');
    }, 30000);
  });

  describe('waitForRun', () => {
    it('returns terminal status for a completed run', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, waitForRun } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const waitResult = await waitForRun({
        dir: repoRoot,
        runId: run.data.runId,
        timeoutSeconds: 5,
      });
      expect(waitResult.ok).toBe(true);
      if (!waitResult.ok) return;
      expect(waitResult.data.status).toBe('completed');
      expect(waitResult.data.completedAt).toEqual(expect.any(String));
      expect(waitResult.data.pid).toBeGreaterThan(0);
    }, 30000);

    it('returns running on timeout for an active run', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig({
        version: 1,
        agents: {
          'stream-agent': {
            base_argv: ['node', delayedStdoutAgentPath],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'stdout_capture' },
            timeout_seconds: 30,
            env: { FAKE_AGENT_DELAY_MS: '8000' },
            read_only: { supported: true, argv_suffix: [], response_writable: true },
          },
        },
      });

      const { review, launch, waitForRun } = await import('@kb/dispatch-core');
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ allowed_agents: ['stream-agent'] }),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'stream-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const launchPromise = launch({ reviewId: rev.data.reviewId, dir: repoRoot });

      const handoffRunsDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0001');
      await waitUntil(async () => {
        try {
          return (await readdir(handoffRunsDir)).length > 0;
        } catch {
          return false;
        }
      }, 10000);
      const [runId] = await readdir(handoffRunsDir);

      const waitResult = await waitForRun({
        dir: repoRoot,
        runId: runId!,
        timeoutSeconds: 1,
        pollIntervalMs: 200,
      });
      expect(waitResult.ok).toBe(true);
      if (!waitResult.ok) return;
      expect(waitResult.data.status).toBe('running');

      await launchPromise;
    }, 30000);

    it('timeout returns terminal status when run completed during final read', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, waitForRun } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      // Run is already completed; a very short timeout still picks up terminal status
      const waitResult = await waitForRun({
        dir: repoRoot,
        runId: run.data.runId,
        timeoutSeconds: 0,
        pollIntervalMs: 50,
      });
      expect(waitResult.ok).toBe(true);
      if (!waitResult.ok) return;
      expect(waitResult.data.status).toBe('completed');
      expect(waitResult.data.completedAt).toEqual(expect.any(String));
    }, 30000);
  });

  describe('getResponse', () => {
    it('returns response content after completion', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, getResponse } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const resp = await getResponse({
        dir: repoRoot,
        runId: run.data.runId,
        includeMeta: true,
      });
      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      expect(resp.data.response).toEqual(expect.any(String));
      expect(resp.data.response!.length).toBeGreaterThan(0);
      expect(resp.data.meta).not.toBeNull();
      expect(resp.data.launch).not.toBeNull();
      expect(resp.data.status).toBe('completed');
    }, 30000);

    it('returns response by reviewId', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch, getResponse } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const resp = await getResponse({
        dir: repoRoot,
        reviewId: rev.data.reviewId,
        includeMeta: true,
      });
      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      expect(resp.data.reviewId).toBe(rev.data.reviewId);
      expect(resp.data.status).toBe('completed');
    }, 30000);

    it('returns active state for in-progress run', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig({
        version: 1,
        agents: {
          'stream-agent': {
            base_argv: ['node', delayedStdoutAgentPath],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'stdout_capture' },
            timeout_seconds: 30,
            env: { FAKE_AGENT_DELAY_MS: '8000' },
            read_only: { supported: true, argv_suffix: [], response_writable: true },
          },
        },
      });

      const { review, launch, getResponse } = await import('@kb/dispatch-core');
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ allowed_agents: ['stream-agent'] }),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'stream-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const launchPromise = launch({ reviewId: rev.data.reviewId, dir: repoRoot });

      const handoffRunsDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0001');
      await waitUntil(async () => {
        try {
          return (await readdir(handoffRunsDir)).length > 0;
        } catch {
          return false;
        }
      }, 10000);
      const [runId] = await readdir(handoffRunsDir);

      await waitUntil(async () => {
        const statePath = join(handoffRunsDir, runId!, 'metadata', 'state.json');
        return pathExists(statePath);
      }, 5000);

      const resp = await getResponse({
        dir: repoRoot,
        runId: runId!,
        includeMeta: true,
      });
      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      expect(resp.data.status).toBe('running');
      expect(resp.data.state).not.toBeNull();

      await launchPromise;
    }, 30000);
  });

  describe('controller-entry', () => {
    it('writes controller.json after launch completes', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      if (!rev.ok) throw new Error(rev.message);

      const controllerEntryPath = resolve(
        process.cwd(),
        'packages',
        'dispatch-core',
        'src',
        'controller-entry.ts',
      );

      execSync(
        `"${getTsxPath()}" "${controllerEntryPath}" --review-id "${rev.data.reviewId}" --dir "${repoRoot}"`,
        { timeout: 30_000, env: process.env, encoding: 'utf-8', windowsHide: true },
      );

      const runsDir = join(repoRoot, '.agent-runs', 'runs');
      const handoffDirs = await readdir(runsDir);
      expect(handoffDirs.length).toBeGreaterThan(0);

      const runDirs = await readdir(join(runsDir, handoffDirs[0]!));
      expect(runDirs.length).toBeGreaterThan(0);

      const controllerPath = join(runsDir, handoffDirs[0]!, runDirs[0]!, 'metadata', 'controller.json');
      const controllerJson = JSON.parse(await readFile(controllerPath, 'utf-8'));

      expect(controllerJson.schema_version).toBe(1);
      expect(controllerJson.review_id).toBe(rev.data.reviewId);
      expect(controllerJson.run_id).toEqual(expect.any(String));
      expect(controllerJson.controller_pid).toEqual(expect.any(Number));
      expect(controllerJson.status).toBe('completed');
      expect(controllerJson.confirmed_child_start_at).toEqual(expect.any(String));
      expect(controllerJson.completed_at).toEqual(expect.any(String));
      expect(controllerJson.error).toBeNull();
    }, 30_000);
  });

  describe('background launch', () => {
    const delayedFakeAgentPath = resolve(TESTS_DIR, 'fixtures', 'delayed-fake-agent.ts');

    it('returns before agent completion', async () => {
      await setupBootstrappedRepo(repoRoot);
      const tsxPath = getTsxPath();
      await setupFullConfig({
        version: 1,
        agents: {
          'fake-agent': {
            base_argv: [tsxPath, delayedFakeAgentPath],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'file' },
            response_arg: [],
            timeout_seconds: 30,
            read_only: { supported: true, argv_suffix: [], response_writable: true },
            env: { FAKE_AGENT_DELAY_MS: '5000' },
          },
        },
      });
      const { createHandoff, review, launchBackground } = await import('@kb/dispatch-core');

      const ho = await createHandoff({
        dir: repoRoot,
        title: 'Background launch test',
        subject: 'kb:test',
        allowed_agents: ['fake-agent'],
        mode: 'implement',
      });
      if (!ho.ok) throw new Error(ho.message);

      const rev = await review({
        dir: repoRoot,
        handoff: ho.data.handoffRelativePath,
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      if (!rev.ok) throw new Error(rev.message);

      const startTime = Date.now();
      const result = await launchBackground({
        reviewId: rev.data.reviewId,
        dir: repoRoot,
      });

      const elapsed = Date.now() - startTime;
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);

      expect(result.data.status).toBe('launching');
      expect(result.data.reviewId).toBe(rev.data.reviewId);
      expect(result.data.runId).toEqual(expect.any(String));
      expect(result.data.pid).toEqual(expect.any(Number));
      expect(result.data.responsePath).toEqual(expect.any(String));
      expect(result.data.stderrPath).toEqual(expect.any(String));

      expect(elapsed).toBeLessThan(4000);

      expect(await pathExists(result.data.responsePath)).toBe(true);
      expect(await pathExists(result.data.stderrPath)).toBe(true);
      expect(await pathExists(result.data.launchPath)).toBe(true);
      expect(await pathExists(result.data.statePath)).toBe(true);
    }, 15_000);

    it('MCP launch defaults to background when background is omitted', async () => {
      await setupBootstrappedRepo(repoRoot);
      const tsxPath = getTsxPath();
      await setupFullConfig({
        version: 1,
        agents: {
          'fake-agent': {
            base_argv: [tsxPath, delayedFakeAgentPath],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'file' },
            response_arg: [],
            timeout_seconds: 30,
            read_only: { supported: true, argv_suffix: [], response_writable: true },
            env: { FAKE_AGENT_DELAY_MS: '3000' },
          },
        },
      });
      const { createHandoff, review, waitForRun } = await import('@kb/dispatch-core');
      const { tools } = await import('@kb/dispatch-mcp');

      const ho = await createHandoff({
        dir: repoRoot,
        title: 'MCP default background test',
        subject: 'kb:test',
        allowed_agents: ['fake-agent'],
        mode: 'implement',
      });
      if (!ho.ok) throw new Error(ho.message);

      const rev = await review({
        dir: repoRoot,
        handoff: ho.data.handoffRelativePath,
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      if (!rev.ok) throw new Error(rev.message);

      const launchTool = tools.find((tool: { name: string }) => tool.name === 'launch');
      expect(launchTool).toBeDefined();
      if (!launchTool) return;

      const startTime = Date.now();
      const result = await launchTool.handler({
        dir: repoRoot,
        reviewId: rev.data.reviewId,
      }) as { ok: boolean; data?: { runId: string; status: string } };
      const elapsed = Date.now() - startTime;

      expect(result.ok).toBe(true);
      expect(result.data?.status).toBe('launching');
      expect(elapsed).toBeLessThan(2500);

      if (result.data?.runId) {
        await waitForRun({ dir: repoRoot, runId: result.data.runId, timeoutSeconds: 30 });
      }
    }, 30_000);

    it('controller writes controller.json during background launch', async () => {
      await setupBootstrappedRepo(repoRoot);
      const tsxPath = getTsxPath();
      await setupFullConfig({
        version: 1,
        agents: {
          'fake-agent': {
            base_argv: [tsxPath, delayedFakeAgentPath],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'file' },
            response_arg: [],
            timeout_seconds: 30,
            read_only: { supported: true, argv_suffix: [], response_writable: true },
            env: { FAKE_AGENT_DELAY_MS: '2000' },
          },
        },
      });
      const { createHandoff, review, launchBackground, waitForRun } = await import('@kb/dispatch-core');

      const ho = await createHandoff({
        dir: repoRoot,
        title: 'Controller json test',
        subject: 'kb:test',
        allowed_agents: ['fake-agent'],
        mode: 'implement',
      });
      if (!ho.ok) throw new Error(ho.message);

      const rev = await review({
        dir: repoRoot,
        handoff: ho.data.handoffRelativePath,
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      if (!rev.ok) throw new Error(rev.message);

      const bg = await launchBackground({ reviewId: rev.data.reviewId, dir: repoRoot });
      expect(bg.ok).toBe(true);
      if (!bg.ok) throw new Error(bg.message);

      expect(await pathExists(bg.data.controllerPath)).toBe(true);
      const controllerJson = JSON.parse(await readFile(bg.data.controllerPath, 'utf-8'));
      expect(controllerJson.schema_version).toBe(1);
      expect(controllerJson.review_id).toBe(rev.data.reviewId);
      expect(controllerJson.status).toBe('running');
      expect(controllerJson.confirmed_child_start_at).toEqual(expect.any(String));

      await waitForRun({ dir: repoRoot, runId: bg.data.runId, timeoutSeconds: 30 });

      const finalController = JSON.parse(await readFile(bg.data.controllerPath, 'utf-8'));
      expect(finalController.status).toBe('completed');
      expect(finalController.completed_at).toEqual(expect.any(String));
    }, 45_000);

    it('succeeds for a fast agent that completes before poll', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launchBackground } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const result = await launchBackground({
        reviewId: rev.data.reviewId,
        dir: repoRoot,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);

      expect(result.data.status).toBe('launching');
      expect(result.data.reviewId).toBe(rev.data.reviewId);
      expect(result.data.runId).toEqual(expect.any(String));
      expect(result.data.pid).toEqual(expect.any(Number));
    }, 30_000);

    it('pre-start failure returns clear failure', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launchBackground } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      await writeFile(
        join(rev.data.bundlePath, 'agent-visible', 'handoff.snapshot.md'),
        'tampered\n',
      );

      const result = await launchBackground({
        reviewId: rev.data.reviewId,
        dir: repoRoot,
        startupTimeoutMs: 15_000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('BACKGROUND_LAUNCH_FAILED');
      }
    }, 20_000);

    it('surfaces environment-gate failures even when no run directory is created', async () => {
      if (process.platform !== 'linux') {
        return;
      }

      // WK-0043 repoint. The old assertion expected launchBackground to hard-fail a
      // non-redteam write_scope launch with 'additional-directory sandbox mounts'.
      // WK-0034 deliberately made that path proceed-with-warning (covered by the
      // '...app-level warning...' integration test and the 'launch environment gate'
      // unit matrix), and that message string no longer exists in source — so the
      // test asserted a contract that was intentionally removed and failed on Linux.
      // The invariant still worth an integration test is "a gate failure surfaces
      // through launchBackground AND leaks no run directory". Redteam still fails
      // closed when the kernel sandbox cannot start (environment.ts capabilityFailure),
      // so repoint there. claude_linux_sandbox (the redteam gate input) is set from
      // the *basic* bwrap probe, which runs under the CODEX agent env — so a codex
      // entry is configured, and every agent env points PATH at a bwrap-less dir.
      // Both probes then resolve `unsupported` on a bwrap-less Linux host (the
      // operator's pod and WSL verification lanes) — the same host assumption the
      // sibling '...app-level warning...' test relies on. resolveExecutableCommand
      // also probes /usr/bin etc., so a bwrap-capable host would need a failing
      // bwrap shim for full determinism; the target hosts here carry no bwrap.
      await setupBootstrappedRepo(repoRoot);
      const binDir = join(tempDir, 'claude-redteam-no-bwrap-bin');
      await writeStdoutAgentLauncher(binDir, 'claude');
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
              PATH: binDir,
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
              PATH: binDir,
              PATHEXT: '.CMD;.EXE',
            },
          },
        },
      });
      const { review, launchBackground } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({
          allowed_agents: ['claude'],
          mode: 'redteam',
        }),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'claude',
        reviewedAndAcceptRisks: true,
      });
      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const result = await launchBackground({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
        startupTimeoutMs: 15_000,
      });
      // Redteam fails closed on a host that cannot start the kernel sandbox. The
      // background path wraps the gate failure as BACKGROUND_LAUNCH_FAILED but
      // preserves the gate's reason in the message (exactly how the pre-WK-0034
      // test matched its old message). Assert the message so the failure is tied to
      // the redteam sandbox gate specifically, not to any background-launch failure.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('BACKGROUND_LAUNCH_FAILED');
        expect(result.message).toContain(
          'Claude launch is blocked because this host cannot start the required Linux sandbox.',
        );
      }

      // Invariant: the gate returns before the run directory is created
      // (launch.ts returns the gate failure prior to mkdir), so nothing leaks.
      let runDirLeaked = true;
      try {
        await stat(join(repoRoot, '.agent-runs', 'runs', 'HO-0001'));
      } catch {
        runDirLeaked = false;
      }
      expect(runDirLeaked).toBe(false);
    }, 20_000);

    it('concurrent background runs for independent HOs', async () => {
      await setupBootstrappedRepo(repoRoot);
      const tsxPath = getTsxPath();
      await setupFullConfig({
        version: 1,
        agents: {
          'fake-agent': {
            base_argv: [tsxPath, delayedFakeAgentPath],
            noninteractive_argv: [],
            instruction_transport: { kind: 'argv_content' },
            wrapper_arg: ['{wrapper_content}'],
            response_transport: { kind: 'file' },
            response_arg: [],
            timeout_seconds: 30,
            read_only: { supported: true, argv_suffix: [], response_writable: true },
            env: { FAKE_AGENT_DELAY_MS: '2000' },
          },
        },
      });
      const { createHandoff, review, launchBackground, waitForRun } = await import('@kb/dispatch-core');

      const ho1 = await createHandoff({
        dir: repoRoot,
        title: 'Concurrent test 1',
        subject: 'kb:test',
        allowed_agents: ['fake-agent'],
        mode: 'implement',
      });
      if (!ho1.ok) throw new Error(ho1.message);

      const ho2 = await createHandoff({
        dir: repoRoot,
        title: 'Concurrent test 2',
        subject: 'kb:test',
        allowed_agents: ['fake-agent'],
        mode: 'implement',
      });
      if (!ho2.ok) throw new Error(ho2.message);

      const rev1 = await review({
        dir: repoRoot,
        handoff: ho1.data.handoffRelativePath,
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      if (!rev1.ok) throw new Error(rev1.message);

      const rev2 = await review({
        dir: repoRoot,
        handoff: ho2.data.handoffRelativePath,
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      if (!rev2.ok) throw new Error(rev2.message);

      const [bg1, bg2] = await Promise.all([
        launchBackground({ reviewId: rev1.data.reviewId, dir: repoRoot }),
        launchBackground({ reviewId: rev2.data.reviewId, dir: repoRoot }),
      ]);

      expect(bg1.ok).toBe(true);
      expect(bg2.ok).toBe(true);
      if (!bg1.ok || !bg2.ok) return;

      expect(bg1.data.handoffId).not.toBe(bg2.data.handoffId);
      expect(bg1.data.runId).not.toBe(bg2.data.runId);

      const [wait1, wait2] = await Promise.all([
        waitForRun({ dir: repoRoot, runId: bg1.data.runId, timeoutSeconds: 30 }),
        waitForRun({ dir: repoRoot, runId: bg2.data.runId, timeoutSeconds: 30 }),
      ]);

      expect(wait1.ok).toBe(true);
      expect(wait2.ok).toBe(true);
      if (!wait1.ok || !wait2.ok) return;
      expect(['completed', 'failed']).toContain(wait1.data.status);
      expect(['completed', 'failed']).toContain(wait2.data.status);
    }, 45_000);
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

  describe('token state transitions', () => {
    it('moves tokens from pending to consumed on successful launch', async () => {
      const cfgDir = await setupFullConfig();
      await setupBootstrappedRepo(repoRoot);
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const pendingFiles = await readdir(join(cfgDir, 'pending'));
      expect(pendingFiles).toContain(`${reviewResult.data.reviewId}.json`);

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(true);

      const consumedFiles = await readdir(join(cfgDir, 'consumed'));
      expect(consumedFiles).toContain(`${reviewResult.data.reviewId}.json`);
    }, 30000);
  });

  describe('status', () => {
    it('counts an active run from state.json after the launch token has been consumed', async () => {
      const cfgDir = await setupFullConfig();
      await setupBootstrappedRepo(repoRoot);
      const { review, status } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      await rename(
        join(cfgDir, 'pending', `${reviewResult.data.reviewId}.json`),
        join(cfgDir, 'consumed', `${reviewResult.data.reviewId}.json`),
      );

      const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0001', 'RUN-test');
      await mkdir(join(runDir, 'metadata'), { recursive: true });
      await writeFile(
        join(runDir, 'metadata', 'review.json'),
        `${JSON.stringify({
          schema_version: 1,
          review_id: reviewResult.data.reviewId,
          handoff_id: 'HO-0001',
          agent: 'fake-agent',
          mode: 'implement',
        }, null, 2)}\n`,
      );
      await writeFile(
        join(runDir, 'metadata', 'state.json'),
        `${JSON.stringify({
          schema_version: 1,
          run_id: 'RUN-test',
          status: 'launching',
          pid: process.pid,
          pgid: process.pid,
          started_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(),
        }, null, 2)}\n`,
      );

      const result = await status(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.launching).toHaveLength(1);
      expect(result.data.launching[0]?.reviewId).toBe(reviewResult.data.reviewId);
      expect(result.data.launching[0]?.runId).toBe('RUN-test');
      expect(result.data.launching[0]?.handoffId).toBe('HO-0001');
      expect(result.data.launching[0]?.agent).toBe('fake-agent');
      expect(result.data.launching[0]?.mode).toBe('implement');
      expect(result.data.launching[0]?.status).toBe('launching');
      expect(result.data.launching[0]?.runDir).toBe(runDir);
      expect(result.data.launching[0]?.responsePath).toBe(join(runDir, 'response.md'));
      expect(result.data.launching[0]?.metaPath).toBe(join(runDir, 'metadata', 'meta.json'));
      expect(result.data.launching[0]?.statePath).toBe(join(runDir, 'metadata', 'state.json'));
      expect(result.data.launching[0]?.launchPath).toBe(join(runDir, 'metadata', 'launch.json'));
      expect(result.data.launching[0]?.controllerPath).toBeNull();
      expect(result.data.launching[0]?.startedAt).toEqual(expect.any(String));
      expect(result.data.launching[0]?.heartbeatAt).toEqual(expect.any(String));
      expect(result.data.launching[0]?.pid).toBe(process.pid);
      expect(result.data.launching[0]?.pgid).toBe(process.pid);
      expect(result.data.staleLaunching).toHaveLength(0);
    });

    it('does not count terminal or expired launching tokens as active launches', async () => {
      const cfgDir = await setupFullConfig();
      await setupBootstrappedRepo(repoRoot);
      const { review, status } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      await rename(
        join(cfgDir, 'pending', `${reviewResult.data.reviewId}.json`),
        join(cfgDir, 'launching', `${reviewResult.data.reviewId}.json`),
      );

      const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0001', 'RUN-test');
      await mkdir(join(runDir, 'metadata'), { recursive: true });
      await writeFile(
        join(runDir, 'metadata', 'meta.json'),
        `${JSON.stringify({
          schema_version: 1,
          review_id: reviewResult.data.reviewId,
          run_id: 'RUN-test',
          handoff_id: 'HO-0001',
          status: 'completed',
        }, null, 2)}\n`,
      );

      const result = await status(repoRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.launching).toHaveLength(0);
      expect(result.data.staleLaunching).toHaveLength(1);
      expect(result.data.staleLaunching[0]?.reviewId).toBe(reviewResult.data.reviewId);
    });
  });

  describe('cleanup', () => {
    it('recovers terminal launching tokens into the correct final token state', async () => {
      const cfgDir = await setupFullConfig();
      await setupBootstrappedRepo(repoRoot);
      const { review, cleanup } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      await rename(
        join(cfgDir, 'pending', `${reviewResult.data.reviewId}.json`),
        join(cfgDir, 'launching', `${reviewResult.data.reviewId}.json`),
      );

      const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0001', 'RUN-test');
      await mkdir(join(runDir, 'metadata'), { recursive: true });
      await writeFile(
        join(runDir, 'metadata', 'meta.json'),
        `${JSON.stringify({
          schema_version: 1,
          review_id: reviewResult.data.reviewId,
          run_id: 'RUN-test',
          handoff_id: 'HO-0001',
          status: 'completed',
        }, null, 2)}\n`,
      );

      const result = await cleanup({
        dir: repoRoot,
        maxAgeDays: 7,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.staleTokens).toContain(reviewResult.data.reviewId);
      expect(await pathExists(join(cfgDir, 'launching', `${reviewResult.data.reviewId}.json`))).toBe(false);
      expect(await pathExists(join(cfgDir, 'consumed', `${reviewResult.data.reviewId}.json`))).toBe(true);
      expect(await pathExists(join(cfgDir, 'rejected', `${reviewResult.data.reviewId}.json`))).toBe(false);
    });

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

    it('rejects known-bad stale Claude launcher profiles with force-init guidance', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig({
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
              argv_suffix: ['--permission-mode', 'plan'],
              response_writable: true,
            },
          },
        },
      });

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ allowed_agents: ['claude'], mode: 'redteam' }),
      );

      const { review } = await import('@kb/dispatch-core');
      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'claude',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('INVALID_AGENT');
        expect(result.message).toContain('init-config --force');
      }
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
    it('launch prints launcher progress to stderr for human runs', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const stderrPath = join(tempDir, 'launch-progress.stderr');
      const output = execSync(
        `"${getTsxPath()}" "${DISPATCH_CLI}" launch --review-id "${reviewResult.data.reviewId}" --dir "${repoRoot}" 2> "${stderrPath}"`,
        {
          cwd: resolve(TESTS_DIR, '..'),
          env: process.env,
          encoding: 'utf-8',
          windowsHide: true,
        },
      );
      const stderr = await readFile(stderrPath, 'utf-8');

      expect(output).toContain('Launch succeeded.');
      expect(stderr).toContain('[dispatch] run created RUN-');
      expect(stderr).toContain('[dispatch] run dir:');
      expect(stderr).toContain('[dispatch] response:');
      expect(stderr).toContain('[dispatch] spawned pid=');
      expect(stderr).toContain('[dispatch] token consumed; streaming output to response.md');
      expect(stderr).toContain('[dispatch] finalized status=completed exit=0');
      expect(stderr).toContain('[dispatch] meta:');
    }, 30000);

    it('launch --json prints authoritative run artifact paths', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      const stderrPath = join(tempDir, 'launch-json.stderr');
      const output = execSync(
        `"${getTsxPath()}" "${DISPATCH_CLI}" launch --review-id "${reviewResult.data.reviewId}" --dir "${repoRoot}" --json 2> "${stderrPath}"`,
        {
          cwd: resolve(TESTS_DIR, '..'),
          env: process.env,
          encoding: 'utf-8',
          windowsHide: true,
        },
      );

      const parsed = JSON.parse(output) as {
        runId: string;
        status: string;
        runDir: string;
        responsePath: string;
        metaPath: string;
      };

      expect(parsed.runId).toMatch(/^RUN-/);
      expect(parsed.status).toBe('completed');
      expect(parsed.runDir).toContain(join('.agent-runs', 'runs', 'HO-0001'));
      expect(parsed.responsePath).toBe(join(parsed.runDir, 'response.md'));
      expect(parsed.metaPath).toBe(join(parsed.runDir, 'metadata', 'meta.json'));
      expect(await pathExists(parsed.responsePath)).toBe(true);
      expect(await pathExists(parsed.metaPath)).toBe(true);
      expect(await readFile(stderrPath, 'utf-8')).toBe('');
    }, 30000);

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

  describe('model/effort passthrough (WK-0069)', () => {
    it('injects model argv for claude-style agents', async () => {
      await setupBootstrappedRepo(repoRoot);
      const binDir = join(tempDir, 'claude-model-bin');
      await writeStdoutAgentLauncher(binDir, 'claude');
      if (process.platform === 'linux') {
        await writeFakeBwrapLauncher(binDir);
      }

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
              PATH: binDir,
              PATHEXT: '.CMD;.EXE',
            },
            model_injection: { kind: 'argv', model_flag: '--model', effort_flag: '--effort' },
          },
        },
      });

      const { review, launch } = await import('@kb/dispatch-core');
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ allowed_agents: ['claude'] }),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'claude',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({
        reviewId: rev.data.reviewId,
        dir: repoRoot,
        model: 'claude-sonnet-5',
        effort: 'high',
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const response = run.data.response ?? '';
      const argvMatch = response.match(/^argv: (.+)$/m);
      expect(argvMatch).toBeTruthy();
      const argv = JSON.parse(argvMatch![1]!) as string[];
      expect(argv).toContain('--model');
      expect(argv).toContain('claude-sonnet-5');
      expect(argv).toContain('--effort');
      expect(argv).toContain('high');
      const modelIdx = argv.indexOf('--model');
      expect(argv[modelIdx + 1]).toBe('claude-sonnet-5');
      const effortIdx = argv.indexOf('--effort');
      expect(argv[effortIdx + 1]).toBe('high');

      const metaRaw = await readFile(join(run.data.runDir, 'metadata', 'meta.json'), 'utf-8');
      const meta = JSON.parse(metaRaw) as { model: string; effort: string; model_passed_through: boolean };
      expect(meta.model).toBe('claude-sonnet-5');
      expect(meta.effort).toBe('high');
      expect(meta.model_passed_through).toBe(true);
    }, 30_000);

    it('injects codex-style model with -c effort template', async () => {
      await setupBootstrappedRepo(repoRoot);
      const binDir = join(tempDir, 'codex-model-bin');
      await writeStdoutAgentLauncher(binDir, 'codex-stub');

      await setupFullConfig({
        version: 1,
        agents: {
          'codex-stub': {
            base_argv: ['codex-stub'],
            noninteractive_argv: [],
            instruction_transport: { kind: 'stdin' },
            response_transport: { kind: 'stdout_capture' },
            timeout_seconds: 30,
            read_only: {
              supported: true,
              argv_suffix: [],
              response_writable: true,
            },
            env: {
              PATH: binDir,
              PATHEXT: '.CMD;.EXE',
            },
            model_injection: {
              kind: 'argv',
              model_flag: '-m',
              effort_args: ['-c'],
              effort_template: 'model_reasoning_effort={effort}',
            },
          },
        },
      });

      const { review, launch } = await import('@kb/dispatch-core');
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ allowed_agents: ['codex-stub'] }),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'codex-stub',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({
        reviewId: rev.data.reviewId,
        dir: repoRoot,
        model: 'gpt-5.4',
        effort: 'high',
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const response = run.data.response ?? '';
      const argvMatch = response.match(/^argv: (.+)$/m);
      expect(argvMatch).toBeTruthy();
      const argv = JSON.parse(argvMatch![1]!) as string[];
      expect(argv).toContain('-m');
      expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5.4');
      expect(argv).toContain('-c');
      const effortArgValue = argv[argv.indexOf('-c') + 1]!;
      expect(effortArgValue).toContain('model_reasoning_effort=');
      expect(effortArgValue).toContain('high');
    }, 30_000);

    it('injects model via env for env-kind injection', async () => {
      await setupBootstrappedRepo(repoRoot);

      const envAgentScriptPath = join(tempDir, 'env-model-agent.cjs');
      await writeFile(
        envAgentScriptPath,
        [
          "let input = '';",
          "process.stdin.setEncoding('utf-8');",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  process.stdout.write([",
          "    '# Env Agent Response',",
          "    '',",
          "    `OPENROUTER_MODEL: ${process.env.OPENROUTER_MODEL || 'unset'}`,",
          "  ].join('\\n'));",
          "});",
          '',
        ].join('\n'),
        'utf-8',
      );

      const binDir = join(tempDir, 'env-model-bin');
      await mkdir(binDir, { recursive: true });
      const commandPath = join(binDir, process.platform === 'win32' ? 'env-agent.CMD' : 'env-agent');
      const commandBody = process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${envAgentScriptPath}" %*\r\n`
        : `#!/bin/sh\nexec ${quotePosixArg(process.execPath)} ${quotePosixArg(envAgentScriptPath)} "$@"\n`;
      await writeFile(commandPath, commandBody, 'utf-8');
      if (process.platform !== 'win32') {
        await chmod(commandPath, 0o755);
      }

      await setupFullConfig({
        version: 1,
        agents: {
          'env-agent': {
            base_argv: ['env-agent'],
            noninteractive_argv: [],
            instruction_transport: { kind: 'stdin' },
            response_transport: { kind: 'stdout_capture' },
            timeout_seconds: 30,
            read_only: {
              supported: true,
              argv_suffix: [],
              response_writable: true,
            },
            env: {
              PATH: binDir,
              PATHEXT: '.CMD;.EXE',
            },
            model_injection: { kind: 'env', model_var: 'OPENROUTER_MODEL' },
          },
        },
      });

      const { review, launch } = await import('@kb/dispatch-core');
      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff({ allowed_agents: ['env-agent'] }),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'env-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({
        reviewId: rev.data.reviewId,
        dir: repoRoot,
        model: 'openai/gpt-5.4',
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const response = run.data.response ?? '';
      expect(response).toContain('OPENROUTER_MODEL: openai/gpt-5.4');

      const metaRaw = await readFile(join(run.data.runDir, 'metadata', 'meta.json'), 'utf-8');
      const meta = JSON.parse(metaRaw) as { model: string; model_passed_through: boolean };
      expect(meta.model).toBe('openai/gpt-5.4');
      expect(meta.model_passed_through).toBe(true);
    }, 30_000);

    it('warns and skips when agent has no model_injection config', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({
        reviewId: rev.data.reviewId,
        dir: repoRoot,
        model: 'some-model',
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const metaRaw = await readFile(join(run.data.runDir, 'metadata', 'meta.json'), 'utf-8');
      const meta = JSON.parse(metaRaw) as { model: string; model_passed_through: boolean };
      expect(meta.model).toBe('some-model');
      expect(meta.model_passed_through).toBe(false);

      const launchRaw = await readFile(join(run.data.runDir, 'metadata', 'launch.json'), 'utf-8');
      const launchJson = JSON.parse(launchRaw) as { warnings?: string[] };
      expect(launchJson.warnings).toBeDefined();
      expect(launchJson.warnings!.some((w: string) => w.includes('no model_injection config'))).toBe(true);
    }, 30_000);

    it('no-model launch behaves exactly as before (regression)', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        makeManualHandoff(),
      );

      const rev = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      const run = await launch({
        reviewId: rev.data.reviewId,
        dir: repoRoot,
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const metaRaw = await readFile(join(run.data.runDir, 'metadata', 'meta.json'), 'utf-8');
      const meta = JSON.parse(metaRaw) as { model: unknown; effort: unknown; model_passed_through: boolean };
      expect(meta.model).toBeNull();
      expect(meta.effort).toBeNull();
      expect(meta.model_passed_through).toBe(false);
    }, 30_000);

    it('model remains forbidden in HO frontmatter', async () => {
      await setupBootstrappedRepo(repoRoot);
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      await writeFile(
        join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md'),
        [
          '---',
          'schema_version: 1',
          'id: HO-0001',
          'title: Test Handoff',
          'subject: kb:test',
          'allowed_agents: [fake-agent]',
          'mode: implement',
          'model: claude-sonnet-5',
          '---',
          '',
          '# Goal',
          'Exercise the dispatch pipeline.',
        ].join('\n'),
      );

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('FORBIDDEN_FIELD');
        expect(result.message.toLowerCase()).toContain('model');
      }
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

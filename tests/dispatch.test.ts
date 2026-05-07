import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
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
import { randomUUID } from 'node:crypto';

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function makeManualHandoff(overrides?: Partial<{
  id: string;
  title: string;
  subject: string;
  allowed_agents: string[];
  mode: string;
}>): string {
  const id = overrides?.id ?? 'HO-0001';
  const title = overrides?.title ?? 'Test Handoff';
  const subject = overrides?.subject ?? 'kb:test';
  const agents = overrides?.allowed_agents ?? ['fake-agent'];
  const mode = overrides?.mode ?? 'implement';

  return [
    '---',
    'schema_version: 1',
    `id: ${id}`,
    `title: ${title}`,
    `subject: ${subject}`,
    `allowed_agents: [${agents.join(', ')}]`,
    `mode: ${mode}`,
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
  const tsxPath = getTsxPath();
  const defaultRegistry: TestRegistry = {
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
          argv_suffix: ['--permission-mode', 'default', '--disallowedTools', 'Edit Write NotebookEdit Bash'],
          response_writable: true,
        },
      },
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
      'fake-agent': {
        base_argv: [tsxPath, fakeAgentPath],
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

  const fakeAgentPath = resolve(TESTS_DIR, 'fixtures', 'fake-agent.ts');

  beforeEach(async () => {
    tempDir = await makeTempDir();
    repoRoot = join(tempDir, 'repo');
    await mkdir(repoRoot, { recursive: true });

    originalAppData = process.env['APPDATA'];
    originalHome = process.env['HOME'];
    originalUserProfile = process.env['USERPROFILE'];
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
      expect(wrapper).toContain('AGENT_BLACKBOARD_HANDOFF_PATH');
      expect(wrapper).toContain('AGENT_BLACKBOARD_RESPONSE_PATH');

      const manifestRaw = await readFile(join(bundlePath, 'metadata', 'input-manifest.json'), 'utf-8');
      const manifest = JSON.parse(manifestRaw) as {
        handoff_snapshot: { path: string };
        context_files: Array<{ source_path: string }>;
      };

      expect(manifest.handoff_snapshot.path).toBe('agent-visible/handoff.snapshot.md');
      expect(manifest.context_files.map((entry) => entry.source_path)).toEqual(['AGENTS.md', 'README.md']);
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
      expect(response).toContain('Fake Agent Response');
      expect(response).toContain(`cwd: ${runAgentVisibleDir}`);
      expect(response).toContain(`handoff_path: ${runHandoffPath}`);
      expect(response).toContain('handoff_exists: true');
      expect(await pathExists(join(launchResult.data.runDir, 'response.md'))).toBe(true);

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

      expect(await pathExists(join(launchResult.data.runDir, 'metadata', 'meta.json'))).toBe(true);
      expect(await pathExists(join(launchResult.data.runDir, 'metadata', 'review.json'))).toBe(true);
      expect(await pathExists(join(launchResult.data.runDir, 'metadata', 'input-manifest.json'))).toBe(true);
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

      const rejectedFiles = await readdir(join(cfgDir, 'rejected'));
      expect(rejectedFiles).toContain(`${reviewResult.data.reviewId}.json`);

      const runIds = await readdir(join(repoRoot, '.agent-runs', 'runs', 'HO-0001'));
      expect(runIds).toHaveLength(1);
      const runDir = join(repoRoot, '.agent-runs', 'runs', 'HO-0001', runIds[0]!);

      const launchMetadataRaw = await readFile(join(runDir, 'metadata', 'launch.json'), 'utf-8');
      const launchMetadata = JSON.parse(launchMetadataRaw) as {
        token_state: string;
        completed_at: string;
        error: string;
      };
      expect(launchMetadata.token_state).toBe('rejected');
      expect(launchMetadata.error).toBe('Empty agent response');
      expect(launchMetadata.completed_at).toBeTruthy();

      const metaRaw = await readFile(join(runDir, 'metadata', 'meta.json'), 'utf-8');
      const meta = JSON.parse(metaRaw) as {
        status: string;
        error: string;
      };
      expect(meta.status).toBe('rejected');
      expect(meta.error).toBe('Empty agent response');
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
      });

      const registryRaw = await readFile(join(configDir, 'launchers.v1.json'), 'utf-8');
      const registry = JSON.parse(registryRaw) as {
        agents: {
          claude: {
            base_argv: string[];
            noninteractive_argv: string[];
          };
          codex: {
            base_argv: string[];
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
      ]);
      expect(registry.agents.codex.base_argv).toEqual(['codex', 'exec']);
      expect(registry.agents.codex.response_transport.kind).toBe('file');
      expect(registry.agents.codex.response_arg).toEqual(['-o', '{response_path}']);
      expect(Object.hasOwn(registry.agents, 'codex-danger-full-access')).toBe(false);
      expect(registry.agents['fake-agent'].base_argv[0]).toBe(getTsxPath());
    });
  });
});

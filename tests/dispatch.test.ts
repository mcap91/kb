import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const TESTS_DIR = resolve(process.cwd(), 'tests');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory and return its path. */
async function makeTempDir(prefix = 'kb-dispatch-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Create a minimal handoff markdown file. */
function makeHandoff(overrides?: Partial<{
  id: string;
  title: string;
  subject: string;
  allowed_agents: string[];
  mode: string;
  schema_version: number;
  extra: Record<string, string>;
}>): string {
  const id = overrides?.id ?? 'HO-0001';
  const title = overrides?.title ?? 'Test Handoff';
  const subject = overrides?.subject ?? 'Test subject for handoff';
  const agents = overrides?.allowed_agents ?? ['fake-agent'];
  const mode = overrides?.mode ?? 'implement';
  const sv = overrides?.schema_version ?? 1;

  const extraLines: string[] = [];
  if (overrides?.extra) {
    for (const [k, v] of Object.entries(overrides.extra)) {
      extraLines.push(`${k}: ${v}`);
    }
  }

  const lines = [
    '---',
    `schema_version: ${sv}`,
    `id: ${id}`,
    `title: ${title}`,
    `subject: ${subject}`,
    `allowed_agents: [${agents.join(', ')}]`,
    `mode: ${mode}`,
    ...extraLines,
    '---',
    '',
    '## Objective',
    'This is a test handoff.',
    '',
  ];

  return lines.join('\n');
}

/** Create a handoff with a Read First section. */
function makeHandoffWithReadFirst(paths: string[]): string {
  const bullets = paths.map((p) => `- ${p}`).join('\n');
  return [
    '---',
    'schema_version: 1',
    'id: HO-0001',
    'title: Test Handoff with Read First',
    'subject: Test subject',
    'allowed_agents: [fake-agent]',
    'mode: implement',
    '---',
    '',
    '## Read First',
    bullets,
    '',
    '## Objective',
    'Test handoff with context files.',
    '',
  ].join('\n');
}

/**
 * Resolve the tsx executable path for spawning agents.
 *
 * On Windows child_process.spawn with shell:true, we use npx tsx.
 * But for test reliability, we find the tsx binary directly.
 */
function getTsxPath(): string {
  // tsx is installed as a devDependency at the repo root
  const repoRoot = resolve(TESTS_DIR, '..');
  if (process.platform === 'win32') {
    return join(repoRoot, 'node_modules', '.bin', 'tsx.cmd');
  }
  return join(repoRoot, 'node_modules', '.bin', 'tsx');
}

/** Write a minimal agent registry file using tsx to run the fake agent. */
async function writeRegistry(configDir: string, fakeAgentPath: string): Promise<void> {
  const tsxPath = getTsxPath();
  const registry = {
    version: 1,
    agents: {
      'fake-agent': {
        command: tsxPath,
        args: [fakeAgentPath],
        description: 'Deterministic test agent',
      },
    },
  };
  await writeFile(join(configDir, 'launchers.v1.json'), JSON.stringify(registry, null, 2));
}

/** Write a different registry (to test hash mismatch). */
async function writeModifiedRegistry(configDir: string, fakeAgentPath: string): Promise<void> {
  const tsxPath = getTsxPath();
  const registry = {
    version: 1,
    agents: {
      'fake-agent': {
        command: tsxPath,
        args: [fakeAgentPath],
        description: 'Modified test agent',
      },
      'another-agent': {
        command: 'echo',
        args: ['hello'],
        description: 'Another agent',
      },
    },
  };
  await writeFile(join(configDir, 'launchers.v1.json'), JSON.stringify(registry, null, 2));
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  let tempDir: string;
  let repoRoot: string;
  let originalAppData: string | undefined;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  // Resolved path to the fake agent fixture
  const fakeAgentPath = resolve(TESTS_DIR, 'fixtures', 'fake-agent.ts');

  beforeEach(async () => {
    // Create isolated temp directories
    tempDir = await makeTempDir();
    repoRoot = join(tempDir, 'repo');

    await mkdir(repoRoot, { recursive: true });
    await mkdir(join(repoRoot, 'wiki', 'handoffs'), { recursive: true });

    // Save original environment
    originalAppData = process.env['APPDATA'];
    originalHome = process.env['HOME'];
    originalUserProfile = process.env['USERPROFILE'];
  });

  afterEach(async () => {
    // Restore environment
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

    // Cleanup temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  // -----------------------------------------------------------------------
  // Helper: setup config and registry correctly for the platform
  // -----------------------------------------------------------------------

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

  async function setupFullConfig(): Promise<string> {
    const dir = await setupConfigWithKey();
    await writeRegistry(dir, fakeAgentPath);
    return dir;
  }

  // -----------------------------------------------------------------------
  // Review tests
  // -----------------------------------------------------------------------

  describe('review', () => {
    it('succeeds for valid handoff with allowed agent', async () => {
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.reviewId).toMatch(/^RV-/);
        expect(result.data.handoffId).toBe('HO-0001');
        expect(result.data.agent).toBe('fake-agent');
        expect(result.data.mode).toBe('implement');
        expect(result.data.bundlePath).toContain('.agent-runs');
        expect(result.data.tokenPath).toBeTruthy();
      }
    });

    it('fails for handoff missing required fields', async () => {
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      // Missing subject field
      const handoff = [
        '---',
        'schema_version: 1',
        'id: HO-0001',
        'title: Test',
        'allowed_agents: [fake-agent]',
        'mode: implement',
        '---',
        '',
        '## Objective',
        'Test.',
      ].join('\n');

      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('MISSING_FIELD');
      }
    });

    it('fails for handoff with forbidden fields', async () => {
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      const handoff = makeHandoff({ extra: { command: 'rm -rf /' } });
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('FORBIDDEN_FIELD');
      }
    });

    it('rejects agent not in allowed_agents', async () => {
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      const handoff = makeHandoff({ allowed_agents: ['claude'] });
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('AGENT_NOT_ALLOWED');
      }
    });

    it('correctly parses Read First paths', async () => {
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      // Create the referenced files
      await writeFile(join(repoRoot, 'README.md'), '# Test');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'main.ts'), 'export {};');

      const handoff = makeHandoffWithReadFirst(['README.md', 'src/main.ts']);
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Verify the bundle contains copied files
        const bundleFiles = await readdir(result.data.bundlePath);
        expect(bundleFiles).toContain('README.md');
        expect(bundleFiles).toContain('src__main.ts');
      }
    });

    it('creates immutable review bundle with correct contents', async () => {
      await setupFullConfig();
      const { review } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const bundleFiles = await readdir(result.data.bundlePath);
        expect(bundleFiles).toContain('review-manifest.json');

        // Read the manifest and verify structure
        const manifestRaw = await readFile(join(result.data.bundlePath, 'review-manifest.json'), 'utf-8');
        const manifest = JSON.parse(manifestRaw);
        expect(manifest.reviewId).toBe(result.data.reviewId);
        expect(manifest.handoffId).toBe('HO-0001');
        expect(manifest.agent).toBe('fake-agent');
        expect(manifest.mode).toBe('implement');
        expect(manifest.files).toBeInstanceOf(Array);
        expect(manifest.files.length).toBeGreaterThan(0);
      }
    });

    it('creates pending token with correct hashes', async () => {
      await setupFullConfig();
      const { review, readTokenFile } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const result = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const tokenResult = await readTokenFile(result.data.reviewId, 'pending');
        expect(tokenResult.ok).toBe(true);
        if (tokenResult.ok) {
          const token = tokenResult.data;
          expect(token.payload.reviewId).toBe(result.data.reviewId);
          expect(token.payload.handoffId).toBe('HO-0001');
          expect(token.payload.agent).toBe('fake-agent');
          expect(token.payload.inputManifestHash).toBeTruthy();
          expect(token.payload.registryHash).toBeTruthy();
          expect(token.payload.repoRoot).toBe(resolve(repoRoot));
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // Launch tests
  // -----------------------------------------------------------------------

  describe('launch', () => {
    it('succeeds with valid pending token and fake-agent', async () => {
      await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

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
      if (launchResult.ok) {
        expect(launchResult.data.runId).toMatch(/^RUN-/);
        expect(launchResult.data.reviewId).toBe(reviewResult.data.reviewId);
        expect(launchResult.data.handoffId).toBe('HO-0001');
        expect(launchResult.data.agent).toBe('fake-agent');
        expect(launchResult.data.exitCode).toBe(0);
        expect(launchResult.data.response).toContain('Fake Agent Response');
        expect(launchResult.data.response).toContain('Status: completed');
      }
    }, 30000);

    it('fails on empty agent response', async () => {
      const cfgDir = await setupFullConfig();

      // Create an agent that produces no output
      const emptyAgentPath = join(tempDir, 'empty-agent.ts');
      await writeFile(emptyAgentPath, 'process.exit(0);\n');

      const tsxPath = getTsxPath();
      const emptyRegistry = {
        version: 1,
        agents: {
          'fake-agent': {
            command: tsxPath,
            args: [emptyAgentPath],
            description: 'Empty response agent',
          },
        },
      };
      await writeFile(join(cfgDir, 'launchers.v1.json'), JSON.stringify(emptyRegistry, null, 2));

      const { review, launch } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

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
    }, 30000);

    it('fails when review bundle hash mismatches (tampered bundle)', async () => {
      await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      // Tamper with the bundle: modify the copied handoff file
      const bundleFiles = await readdir(reviewResult.data.bundlePath);
      const handoffCopy = bundleFiles.find((f) => f !== 'review-manifest.json');
      if (handoffCopy) {
        await writeFile(
          join(reviewResult.data.bundlePath, handoffCopy),
          'TAMPERED CONTENT',
        );
      }

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(false);
      if (!launchResult.ok) {
        expect(launchResult.error).toBe('HASH_MISMATCH');
      }
    });

    it('fails when registry hash mismatches (changed registry)', async () => {
      const cfgDir = await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      // Modify the registry after review
      await writeModifiedRegistry(cfgDir, fakeAgentPath);

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(false);
      if (!launchResult.ok) {
        expect(launchResult.error).toBe('HASH_MISMATCH');
      }
    });

    it('fails on expired token', async () => {
      const cfgDir = await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      // Overwrite token with expired expiry directly in the file
      // This breaks the signature, so verifyToken will catch it
      const tokenPath = join(cfgDir, 'pending', `${reviewResult.data.reviewId}.json`);
      const tokenRaw = await readFile(tokenPath, 'utf-8');
      const token = JSON.parse(tokenRaw);
      token.payload.expiry = new Date(Date.now() - 1000).toISOString();
      await writeFile(tokenPath, JSON.stringify(token, null, 2));

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(false);
      if (!launchResult.ok) {
        // Will be TOKEN_INVALID because modifying payload breaks signature
        expect(['TOKEN_INVALID', 'TOKEN_EXPIRED']).toContain(launchResult.error);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Token state transition tests
  // -----------------------------------------------------------------------

  describe('token state transitions', () => {
    it('transitions through pending -> launching -> consumed on success', async () => {
      const cfgDir = await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      // Verify token is in pending
      const pendingFiles = await readdir(join(cfgDir, 'pending'));
      expect(pendingFiles).toContain(`${reviewResult.data.reviewId}.json`);

      // Launch
      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(true);

      // Verify token moved to consumed
      const consumedFiles = await readdir(join(cfgDir, 'consumed'));
      expect(consumedFiles).toContain(`${reviewResult.data.reviewId}.json`);

      // Verify token is no longer in pending
      const pendingAfter = await readdir(join(cfgDir, 'pending'));
      expect(pendingAfter).not.toContain(`${reviewResult.data.reviewId}.json`);
    }, 30000);

    it('transitions to rejected on failure', async () => {
      const cfgDir = await setupFullConfig();
      const { review, launch } = await import('@kb/dispatch-core');

      const handoff = makeHandoff();
      const handoffPath = join(repoRoot, 'wiki', 'handoffs', 'HO-0001.md');
      await writeFile(handoffPath, handoff);

      const reviewResult = await review({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-0001.md',
        agent: 'fake-agent',
        reviewedAndAcceptRisks: true,
      });

      expect(reviewResult.ok).toBe(true);
      if (!reviewResult.ok) return;

      // Tamper with bundle to cause hash mismatch -> rejection
      const bundleFiles = await readdir(reviewResult.data.bundlePath);
      const handoffCopy = bundleFiles.find((f) => f !== 'review-manifest.json');
      if (handoffCopy) {
        await writeFile(
          join(reviewResult.data.bundlePath, handoffCopy),
          'TAMPERED',
        );
      }

      const launchResult = await launch({
        reviewId: reviewResult.data.reviewId,
        dir: repoRoot,
      });

      expect(launchResult.ok).toBe(false);

      // Verify token moved to rejected
      const rejectedFiles = await readdir(join(cfgDir, 'rejected'));
      expect(rejectedFiles).toContain(`${reviewResult.data.reviewId}.json`);
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup tests
  // -----------------------------------------------------------------------

  describe('cleanup', () => {
    it('removes orphan reviews', async () => {
      await setupFullConfig();
      const { cleanup } = await import('@kb/dispatch-core');

      // Create an orphan review directory (no corresponding token)
      const orphanId = `RV-${randomUUID()}`;
      const orphanDir = join(repoRoot, '.agent-runs', 'reviews', orphanId);
      await mkdir(orphanDir, { recursive: true });
      await writeFile(join(orphanDir, 'review-manifest.json'), '{}');

      const result = await cleanup({
        dir: repoRoot,
        maxAgeDays: 0, // Treat everything as old
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.orphanReviews).toContain(orphanId);
        expect(result.data.totalRemoved).toBeGreaterThanOrEqual(1);
      }
    });

    it('recovers stale launching tokens', async () => {
      const cfgDir = await setupFullConfig();
      const { cleanup } = await import('@kb/dispatch-core');

      // Create a stale token directly in the launching directory
      const reviewId = `RV-${randomUUID()}`;
      const staleToken = {
        payload: {
          reviewId,
          handoffId: 'HO-0001',
          agent: 'fake-agent',
          mode: 'implement',
          repoRoot,
          inputManifestHash: 'abc123',
          registryHash: 'def456',
          expiry: new Date(Date.now() - 1000).toISOString(), // Already expired
        },
        signature: 'fake-sig',
        createdAt: new Date(Date.now() - 86400000 * 8).toISOString(), // 8 days old
      };

      const launchingDir = join(cfgDir, 'launching');
      await writeFile(
        join(launchingDir, `${reviewId}.json`),
        JSON.stringify(staleToken, null, 2),
      );

      const result = await cleanup({
        dir: repoRoot,
        maxAgeDays: 7,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.staleTokens).toContain(reviewId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Platform tests
  // -----------------------------------------------------------------------

  describe('platform', () => {
    it('config path resolution returns platform-appropriate path', async () => {
      const { getConfigDir } = await import('@kb/dispatch-core');
      const configPath = getConfigDir();

      if (process.platform === 'win32') {
        expect(configPath).toContain('kb-dispatch');
        expect(configPath).toMatch(/\\kb-dispatch$/);
      } else {
        expect(configPath).toContain('kb-dispatch');
        expect(configPath).toMatch(/\/\.config\/kb-dispatch$/);
      }
    });
  });
});

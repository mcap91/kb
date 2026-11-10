/**
 * WK-0295 / WK-0294 — the run-dir evidence channel (DEC-0047 A3.3, A4.1, A4.4).
 * A derived code_review dispatched through the real runDispatch() gets the
 * implement response and the host validation evidence JSON copied into its
 * own run dir, and the worker's actual jail (the plan runDispatch built) can
 * read both — in the tracked and the nested-private wiki shapes. The prompt
 * names both copies and says execution is out of scope. Only the worker
 * process is replaced: the mocked spawnIsolated swaps the worker command for
 * `cat` and runs the REAL spawnIsolated against the real bwrap plan.
 * Temp dirs only (WK-0043); skips loudly without a working bwrap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runDispatch } from '../packages/dispatch-core/src/pipeline.js';
import { stageReviewEvidence } from '../packages/dispatch-core/src/host-validation.js';
import { validationRegistryFingerprint } from '../packages/dispatch-core/src/repo-config.js';
import type { BwrapPlan } from '../packages/dispatch-core/src/jail.js';
import * as spawnIsolatedModule from '../packages/dispatch-core/src/spawn-isolated.js';
import * as tierModule from '../packages/dispatch-core/src/tier.js';

function probeBwrapFunctional(): boolean {
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const BWRAP_FUNCTIONAL = probeBwrapFunctional();
if (!BWRAP_FUNCTIONAL) {
  console.warn('SKIPPED: "review evidence run-dir channel (WK-0295)" requires a working bwrap.');
}

const realSpawnIsolated = spawnIsolatedModule.spawnIsolated;
const PI_FIXTURE = readFileSync(resolve(__dirname, 'fixtures', 'pi-output-code-review.jsonl'), 'utf8');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

const IMPL = 'HO-9295';
const REVIEW = 'HO-9296';
const IMPL_RUN = 'RUN-00000000-0000-4000-8000-000000000001';
const RESPONSE_MARKER = 'IMPLEMENT-RESPONSE-BODY-9295';

const REVIEW_HO = `---
id: ${REVIEW}
title: Code review fixture
mode: code_review
write_scope: []
base_ref: dispatch/${IMPL}
reviewed_run: "${IMPL_RUN}"
web: false
credentials: []
data_mounts: []
read_first: []
acceptance:
  - "AC-1: works"
validation: ["npm test"]
status: draft
---

## Task
Review the delivery.
`;

/** A repo with a delivered implement HO, its committed-on-main response, and host evidence; returns the repo root. */
async function setupRepo(shape: 'tracked' | 'nested-private'): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), `kb-review-evidence-${shape}-`));
  initRepo(repo);
  await writeFile(join(repo, '.gitignore'), shape === 'tracked' ? '.agent-runs/\n' : '.agent-runs/\nwiki/\n');
  await writeFile(join(repo, 'README.md'), '# fixture\n');
  commitAll(repo, 'init');
  git(repo, 'checkout', '-q', '-b', `dispatch/${IMPL}`);
  await writeFile(join(repo, 'feature.ts'), 'export const f = 1;\n');
  commitAll(repo, 'delivery');
  const deliverySha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-');

  const wiki = join(repo, 'wiki');
  await mkdir(join(wiki, 'handoffs'), { recursive: true });
  await mkdir(join(wiki, '.dispatch'), { recursive: true });
  await writeFile(
    join(wiki, '.dispatch', 'models.json'),
    JSON.stringify({ deepseek: { available_on: ['openrouter'], model_id: 'deepseek/deepseek-v4-flash-0731' } }),
  );
  await writeFile(
    join(wiki, '.dispatch', 'backends.json'),
    JSON.stringify({ openrouter: { family: 'pi', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY', secrets_file: null } }),
  );
  await writeFile(join(wiki, '.dispatch', 'profiles.json'), JSON.stringify({ schema_version: 1 }));
  // The response lands on main after the delivery branch was cut — invisible to a base_ref clone.
  await writeFile(join(wiki, 'handoffs', `${IMPL}.response.md`), `---\nhandoff_id: ${IMPL}\n---\n\n${RESPONSE_MARKER}\n`);
  await writeFile(join(wiki, 'handoffs', `${REVIEW}.md`), REVIEW_HO);
  if (shape === 'tracked') {
    commitAll(repo, 'wiki records');
  } else {
    initRepo(wiki);
    commitAll(wiki, 'wiki records');
  }

  const implRunDir = join(repo, '.agent-runs', 'runs', IMPL, IMPL_RUN);
  await mkdir(implRunDir, { recursive: true });
  await writeFile(
    join(implRunDir, 'validation-evidence.json'),
    JSON.stringify({
      schema_version: 1,
      handoff_id: IMPL,
      run_id: IMPL_RUN,
      delivery_branch: `dispatch/${IMPL}`,
      delivery_sha: deliverySha,
      registry_fingerprint: validationRegistryFingerprint(null),
      started_at: '2026-11-09T00:00:00.000Z',
      completed_at: '2026-11-09T00:00:01.000Z',
      setup: null,
      commands: [],
      outcome: 'pass',
    }),
  );
  return repo;
}

/** Same bwrap plan, worker command replaced by `cat <files>`. */
function withCommand(plan: BwrapPlan, command: string[]): BwrapPlan {
  const terminator = plan.bwrapArgs.indexOf('--chdir') + 2;
  return { ...plan, bwrapArgs: [...plan.bwrapArgs.slice(0, terminator + 1), ...command], command };
}

describe.skipIf(!BWRAP_FUNCTIONAL).each(['tracked', 'nested-private'] as const)(
  'derived review run-dir evidence channel — %s wiki (WK-0295)',
  (shape) => {
    let repo: string | undefined;

    afterEach(async () => {
      vi.restoreAllMocks();
      if (repo !== undefined) await rm(repo, { recursive: true, force: true });
      repo = undefined;
    });

    // Why: A4.4 — the reviewer reads the response and evidence from its run dir, in its real jail, in both shapes.
    it('stages the response and evidence into the review run dir and the worker jail can read both', async () => {
      repo = await setupRepo(shape);
      vi.spyOn(tierModule, 'probeBwrap').mockResolvedValue({
        available: true,
        bwrapVersion: 'bubblewrap (real, probe mocked)',
        unshareUserWorks: true,
        kernelVersion: 'test-kernel',
        usernsSysctl: null,
      });
      let jailRead = '';
      vi.spyOn(spawnIsolatedModule, 'spawnIsolated').mockImplementation(async (plan, opts) => {
        const runDirBind = plan.mounts.find((m) => m.kind === 'bind' && m.dst.includes(`/runs/${REVIEW}/`));
        const runDir = runDirBind?.dst ?? '';
        const read = await realSpawnIsolated(
          withCommand(plan, ['cat', join(runDir, 'implement-response.md'), join(runDir, 'validation-evidence.json')]),
          { timeoutMs: 30_000 },
        );
        if (read.ok) jailRead = read.data.stdout;
        if (opts?.stdoutLogPath) await writeFile(opts.stdoutLogPath, PI_FIXTURE, 'utf8');
        return {
          ok: true,
          data: { stdout: '', stderr: '', exitCode: 0, signal: null, truncated: false, timedOut: false, streamDrainTimedOut: false },
        };
      });

      const result = await runDispatch({
        dir: repo,
        handoff: `wiki/handoffs/${REVIEW}.md`,
        model: 'deepseek',
        backend: 'openrouter',
        preflight: false,
      });
      expect(result.ok).toBe(true);
      expect(jailRead).toContain(RESPONSE_MARKER);
      expect(jailRead).toContain(`"run_id": "${IMPL_RUN}"`);

      const runsDir = join(repo, '.agent-runs', 'runs', REVIEW);
      const [runId] = await readdir(runsDir);
      const prompt = await readFile(join(runsDir, runId ?? '', 'prompt.txt'), 'utf8');
      expect(prompt).toContain(join(runsDir, runId ?? '', 'implement-response.md'));
      expect(prompt).toContain(join(runsDir, runId ?? '', 'validation-evidence.json'));
      expect(prompt).toContain('out of scope');
    });

    // Why: fail closed — a derived review must not dispatch without the facts its derivation promised.
    it('refuses to stage when the host evidence is gone', async () => {
      repo = await setupRepo(shape);
      await rm(join(repo, '.agent-runs', 'runs', IMPL, IMPL_RUN, 'validation-evidence.json'));
      const staged = await stageReviewEvidence({
        dir: repo,
        handoff: { mode: 'code_review', base_ref: `dispatch/${IMPL}`, reviewed_run: IMPL_RUN },
        runDir: await mkdtemp(join(tmpdir(), 'kb-review-run-')),
      });
      expect(staged.ok).toBe(false);
      if (staged.ok) return;
      expect(staged.message).toContain('re-run derive-review');
    });
  },
);

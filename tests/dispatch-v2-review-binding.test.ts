/**
 * WK-0294 / HO-0220 — a derived review is bound to the run and head it was
 * derived for. F1: `reviewed_run` / `reviewed_sha` are refused at parse unless
 * they are a dispatch run id and a full sha, and the evidence path builder
 * refuses a run id that could leave the run dir on its own (defense in
 * depth). F2: admission refuses a review whose `base_ref` no longer resolves
 * to its `reviewed_sha`, so the reviewer can only see the head it stamps.
 * Temp dirs only (WK-0043).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { parseHandoffContent, type Handoff } from '../packages/dispatch-core/src/ho.js';
import { validationEvidencePath } from '../packages/dispatch-core/src/host-validation.js';

const RUN = 'RUN-00000000-0000-4000-8000-000000000001';

function reviewHo(stamps: string[]): string {
  return [
    '---',
    'id: HO-9220',
    'title: Code review fixture',
    'mode: code_review',
    'write_scope: []',
    'base_ref: dispatch/HO-9000',
    ...stamps,
    'acceptance:',
    '  - "AC-1: works"',
    'validation: ["npm test"]',
    'status: draft',
    '---',
    '',
    '## Task',
    'Review the delivery.',
    '',
  ].join('\n');
}

describe('derived review stamps refuse at parse (HO-0220 F1)', () => {
  // Why: the run id is path-joined into the host-original evidence lookup.
  it('refuses a reviewed_run that is not a dispatch run id', () => {
    for (const forged of [`../HO-0003/${RUN}`, 'RUN-0001', `${RUN}/..`]) {
      const parsed = parseHandoffContent(reviewHo([`reviewed_run: "${forged}"`]), 'HO-9220.md');
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toBe('BAD_RECORD');
      expect(parsed.message).toContain('reviewed_run');
    }
  });

  it('refuses a reviewed_sha that is not a full commit sha', () => {
    for (const forged of ['main', 'abc1234', `${'a'.repeat(40)}/..`]) {
      const parsed = parseHandoffContent(reviewHo([`reviewed_run: "${RUN}"`, `reviewed_sha: "${forged}"`]), 'HO-9220.md');
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.message).toContain('reviewed_sha');
    }
  });

  it('accepts derive-review stamps', () => {
    const parsed = parseHandoffContent(reviewHo([`reviewed_run: "${RUN}"`, `reviewed_sha: "${'a'.repeat(40)}"`]), 'HO-9220.md');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data).toMatchObject({ reviewed_run: RUN, reviewed_sha: 'a'.repeat(40) });
  });
});

describe('validationEvidencePath (HO-0220 F1, defense in depth)', () => {
  // Why: a caller-built Handoff skips the parser; the path builder must refuse on its own.
  it('refuses a run id or handoff id that could leave the run dir', () => {
    for (const [handoffId, runId] of [
      ['HO-0001', `../HO-0003/${RUN}`],
      ['HO-0001', '..'],
      ['HO-0001', 'RUN-0001'],
      ['..', RUN],
      ['HO-0001/../HO-0003', RUN],
    ] as const) {
      const built = validationEvidencePath('/repo', handoffId, runId);
      expect(built.ok, `${handoffId} ${runId}`).toBe(false);
      if (built.ok) return;
      expect(built.error).toBe('BAD_RECORD');
    }
  });

  it('builds the run-dir path for a dispatch run id', () => {
    const built = validationEvidencePath('/repo', 'HO-0001', RUN);
    expect(built).toEqual({ ok: true, data: `/repo/.agent-runs/runs/HO-0001/${RUN}/validation-evidence.json` });
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

function reviewHandoff(overrides: Partial<Handoff>): Handoff {
  return {
    id: 'HO-9220',
    title: 'Code review fixture',
    mode: 'code_review',
    write_scope: [],
    base_ref: 'dispatch/HO-9000',
    web: false,
    credentials: [],
    data_mounts: [],
    export_mounts: [],
    runtime_envs: [],
    read_first: [],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['review only'],
    status: 'draft',
    ...overrides,
  };
}

describe('admission binds a derived review to its head (HO-0220 F2)', () => {
  let repo: string | undefined;

  afterEach(async () => {
    if (repo !== undefined) await rm(repo, { recursive: true, force: true });
    repo = undefined;
  });

  /** A repo whose delivery branch was at A when the review was derived and has since moved to B. */
  async function setup(): Promise<{ shaA: string; shaB: string }> {
    repo = await mkdtemp(join(tmpdir(), 'kb-review-binding-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'checkout', '-q', '-b', 'dispatch/HO-9000');
    await writeFile(join(repo, 'feature.ts'), 'export const a = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'head A');
    const shaA = git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'feature.ts'), 'export const b = 2;\n');
    git(repo, 'commit', '-q', '-a', '-m', 'head B');
    const shaB = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-');
    return { shaA, shaB };
  }

  // Why: the reviewer must see the head the merge gate later trusts; a moved branch means a stale review.
  it('refuses a review derived at A while base_ref is at B, naming both shas', async () => {
    const { shaA, shaB } = await setup();
    const result = await checkAdmission(reviewHandoff({ reviewed_run: RUN, reviewed_sha: shaA }), repo ?? '');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEWED_SHA_MISMATCH');
    expect(result.message).toContain(shaA);
    expect(result.message).toContain(shaB);
  });

  it('admits the review once base_ref is back at its reviewed_sha, cloning that sha', async () => {
    const { shaB } = await setup();
    const result = await checkAdmission(reviewHandoff({ reviewed_run: RUN, reviewed_sha: shaB }), repo ?? '');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.baseSha).toBe(shaB);
  });
});

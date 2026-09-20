/**
 * WK-0120 — createHandoff() refuses implement-mode HOs with a missing or
 * malformed work_item at authoring time. Mirrors admission.ts's
 * checkUnresolvedInitiative gate (WK-0116, UNRESOLVED_INITIATIVE): before
 * this change, an implement HO with no work_item would author cleanly and
 * only fail later at dispatch time. This file proves the refusal now fires
 * at authoring, that a valid work_item still authors cleanly, and that
 * non-implement modes remain work_item-optional (DEC-0035). Patterned after
 * tests/dispatch-v2-admission.test.ts (vitest, temp dirs, beforeEach/afterEach).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import type { CreateHandoffOpts } from '../packages/dispatch-core/src/types.js';

function baseOpts(overrides: Partial<CreateHandoffOpts> = {}): CreateHandoffOpts {
  return {
    dir: '/does-not-matter-until-past-the-work-item-check',
    title: 'WK-0120 validation test handoff',
    subject: 'kb:dispatch',
    allowed_agents: ['claude'],
    mode: 'implement',
    acceptance: ['AC-1: example'],
    validation: ['npm test'],
    ...overrides,
  };
}

/** Mirrors tests/dispatch.test.ts's helper of the same name. */
async function setupBootstrappedRepo(repoRoot: string): Promise<void> {
  const { bootstrap } = await import('@kb/wiki-core');
  const result = await bootstrap({ dir: repoRoot, repo: 'test/repo' });
  if (!result.ok) {
    throw new Error(result.message);
  }
}

describe('createHandoff — WK-0120 work_item-for-implement authoring gate', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'create-handoff-validation-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('implement HO without a valid work_item is refused at authoring', () => {
    it('refuses when work_item is undefined', async () => {
      const result = await createHandoff(baseOpts({ dir: tempDir }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('MISSING_FIELD');
      expect(result.message).toContain('work_item');
      expect(result.message).toContain('UNRESOLVED_INITIATIVE');
    });

    it('refuses when work_item is an empty string', async () => {
      const result = await createHandoff(baseOpts({ dir: tempDir, work_item: '' }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('MISSING_FIELD');
      expect(result.message).toContain('work_item');
      expect(result.message).toContain('UNRESOLVED_INITIATIVE');
    });

    it('refuses when work_item is blank (whitespace only)', async () => {
      const result = await createHandoff(baseOpts({ dir: tempDir, work_item: '   ' }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('MISSING_FIELD');
      expect(result.message).toContain('work_item');
      expect(result.message).toContain('UNRESOLVED_INITIATIVE');
    });

    it('refuses when work_item does not match /^WK-\\d{4}$/', async () => {
      const result = await createHandoff(baseOpts({ dir: tempDir, work_item: 'not-a-wk-id' }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('MISSING_FIELD');
      expect(result.message).toContain('work_item');
      expect(result.message).toContain('UNRESOLVED_INITIATIVE');
    });
  });

  describe('implement HO with a valid work_item authors cleanly', () => {
    it('succeeds and writes work_item into the frontmatter', async () => {
      await setupBootstrappedRepo(tempDir);

      const result = await createHandoff(baseOpts({ dir: tempDir, work_item: 'WK-0120' }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const content = await readFile(join(tempDir, result.data.handoffRelativePath), 'utf-8');
      expect(content).toContain('work_item: "WK-0120"');
    });
  });

  describe('non-implement HO without work_item still authors cleanly', () => {
    it('succeeds for mode=code_review with no work_item declared', async () => {
      await setupBootstrappedRepo(tempDir);

      const result = await createHandoff(baseOpts({ dir: tempDir, mode: 'code_review' }));
      expect(result.ok).toBe(true);
    });
  });
});

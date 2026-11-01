/**
 * WK-0229 ruling 16: the managed-block word budget refuses bootstrap/sync before any write.
 */

import { vi, describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('../packages/wiki-core/src/contract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/wiki-core/src/contract.js')>();
  const overBudgetBody = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');

  return {
    ...actual,
    getAgentInstructionsSections: () => ({
      ok: true,
      data: [
        { id: 'wiki', body: overBudgetBody(1500) },
        { id: 'dispatch', requires: 'dispatch', body: overBudgetBody(1500) },
        { id: 'guidelines', body: overBudgetBody(1500) },
        { id: 'footer', body: overBudgetBody(1500) },
      ],
    }),
  };
});

import { bootstrap } from '../packages/wiki-core/src/bootstrap.js';
import { sync } from '../packages/wiki-core/src/sync.js';
import { checkBlockBudget, BLOCK_WORD_BUDGET } from '../packages/wiki-core/src/agent-instructions.js';
import { createTmpDir, type TmpRepo } from './helpers/tmp-repo.js';

function listDir(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

describe('managed-block budget refusal', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('bootstrap refuses with BLOCK_BUDGET_EXCEEDED and writes nothing when the block is over budget', async () => {
    tmp = createTmpDir();
    const before = listDir(tmp.dir);

    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('BLOCK_BUDGET_EXCEEDED');
    }

    const after = listDir(tmp.dir);
    expect(after).toEqual(before);
  });

  it('sync refuses with BLOCK_BUDGET_EXCEEDED and writes nothing when the block is over budget', async () => {
    tmp = createTmpDir();
    // Minimal bootstrapped-repo marker, written by hand (the real bootstrap would also
    // hit the mocked over-budget block and refuse).
    fs.mkdirSync(path.join(tmp.dir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(tmp.dir, 'wiki', '.wiki-contract.json'), '{}\n', 'utf-8');

    const before = listDir(tmp.dir);

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('BLOCK_BUDGET_EXCEEDED');
    }

    const after = listDir(tmp.dir);
    expect(after).toEqual(before);
  });
});

describe('checkBlockBudget boundary', () => {
  it('is ok at exactly 4,000 words between the markers', () => {
    // MANAGED_COMMENT is 20 words; a 3,980-word body brings the total to exactly 4,000.
    const body = Array.from({ length: BLOCK_WORD_BUDGET - 20 }, () => 'word').join(' ');
    const result = checkBlockBudget([{ id: 'guidelines', body }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.words).toBe(BLOCK_WORD_BUDGET);
    }
  });

  it('fails at 4,001 words between the markers', () => {
    const body = Array.from({ length: BLOCK_WORD_BUDGET - 19 }, () => 'word').join(' ');
    const result = checkBlockBudget([{ id: 'guidelines', body }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('BLOCK_BUDGET_EXCEEDED');
    }
  });
});

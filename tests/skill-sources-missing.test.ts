/**
 * WK-0240 AC: a missing contract/skills/ directory is an empty list, not an
 * error — stage 2 ships ahead of any guaranteed skill folder. Isolated into
 * its own file because it mocks node:fs module-wide (vitest file-scoped).
 */

import { vi, describe, it, expect } from 'vitest';
import * as path from 'node:path';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const patchedExistsSync: typeof actual.existsSync = (p) => {
    if (typeof p === 'string' && p.endsWith(`${path.sep}contract${path.sep}skills`)) {
      return false;
    }
    return actual.existsSync(p);
  };
  return {
    ...actual,
    existsSync: patchedExistsSync,
    default: { ...actual.default, existsSync: patchedExistsSync },
  };
});

import { getSkillSources } from '../packages/wiki-core/src/contract.js';

describe('getSkillSources — missing contract/skills/ directory', () => {
  it('returns ok([]), not a CONTRACT_NOT_FOUND error, when contract/skills/ does not exist', () => {
    const result = getSkillSources();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });
});

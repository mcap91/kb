import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { StatusResult, TokenInfo, DispatchToken } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { getTokenDir, type TokenState } from './paths.js';

async function listTokensInState(state: TokenState): Promise<TokenInfo[]> {
  const dir = getTokenDir(state);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const tokens: TokenInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, entry), 'utf-8');
      const token = JSON.parse(raw) as DispatchToken;
      tokens.push({
        reviewId: token.payload.reviewId,
        handoffId: token.payload.handoffId,
        agent: token.payload.agent,
        mode: token.payload.mode,
        expiry: token.payload.expiry,
      });
    } catch {
      // skip malformed token files
    }
  }

  return tokens;
}

export async function status(dir: string): Promise<DispatchResult<StatusResult>> {
  const repoRoot = resolve(dir);
  try {
    const [pending, launching, consumed, rejected] = await Promise.all([
      listTokensInState('pending'),
      listTokensInState('launching'),
      listTokensInState('consumed'),
      listTokensInState('rejected'),
    ]);

    let runCount = 0;
    try {
      const handoffDirs = await readdir(join(repoRoot, '.agent-runs', 'runs'));
      for (const handoffId of handoffDirs) {
        const runs = await readdir(join(repoRoot, '.agent-runs', 'runs', handoffId));
        runCount += runs.length;
      }
    } catch {
      runCount = 0;
    }

    let reviewCount = 0;
    try {
      const reviews = await readdir(join(repoRoot, '.agent-runs', 'reviews'));
      reviewCount = reviews.length;
    } catch {
      reviewCount = 0;
    }

    return ok({
      repoRoot,
      pending,
      launching,
      consumed,
      rejected,
      runCount,
      reviewCount,
    });
  } catch (err) {
    return fail('STATUS_ERROR', 'Failed to compute dispatch status.', err);
  }
}

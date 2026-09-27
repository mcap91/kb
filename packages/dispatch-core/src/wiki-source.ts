/**
 * WK-0152: single source for "where does wiki/ live, and at which commit".
 * Reuses jail.ts's classifyWikiShape (DEC-0008 D19). Callers: create-handoff
 * (stamps base_wiki_sha), admission (base-drift gate), pipeline (wiki_commit
 * provenance, WK-0135). nested-private always means wiki/ is its own git repo
 * (operator ruling 2026-09-26) — a failed lookup there fails loud.
 */
import { execFile as execFileCb } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import { classifyWikiShape, type WikiShape } from './jail.js';

const execFile = promisify(execFileCb);

export interface WikiSource {
  shape: WikiShape;
  /** nested-private only: HEAD of the separate wiki repo at <repoRoot>/wiki. null when tracked. */
  head: string | null;
}

export async function probeWikiSource(repoRoot: string): Promise<DispatchResult<WikiSource>> {
  let lsFiles: string;
  try {
    const { stdout } = await execFile('git', ['ls-files', 'wiki/'], { cwd: repoRoot });
    lsFiles = stdout;
  } catch (err) {
    return fail('LOOKUP_FAILED', `Failed to run "git ls-files wiki/" in ${repoRoot}.`, err);
  }

  const shape = classifyWikiShape(lsFiles);
  if (shape === 'tracked') return ok({ shape, head: null });

  const wikiDir = join(repoRoot, 'wiki');
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: wikiDir });
    return ok({ shape, head: stdout.trim() });
  } catch (err) {
    return fail(
      'LOOKUP_FAILED',
      `wiki/ is not tracked by ${repoRoot}, so it must be its own git repo, but "git rev-parse HEAD" failed in ${wikiDir}.`,
      err,
    );
  }
}

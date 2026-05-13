import type { RunArtifactResult, GetResponseOpts } from './types-background.js';
import type { DispatchResult } from './errors.js';
import { resolveRun, readRunArtifacts } from './lookup.js';

export async function getResponse(opts: GetResponseOpts): Promise<DispatchResult<RunArtifactResult>> {
  const resolved = await resolveRun({
    dir: opts.dir,
    reviewId: opts.reviewId,
    runId: opts.runId,
  });
  if (!resolved.ok) return resolved;

  return readRunArtifacts(resolved.data.runDir, {
    includeMeta: opts.includeMeta,
    includeLogs: opts.includeLogs,
  });
}

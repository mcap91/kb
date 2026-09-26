import type {
  CheckEnvironmentResult,
  CleanupOpts,
  CleanupReport,
  CreateHandoffOpts,
  CreateHandoffResult,
  StatusResult,
} from './types.js';
import type { DispatchResult } from './errors.js';
import { createHandoff } from './create-handoff.js';
import { cleanup } from './cleanup.js';
import { status } from './status.js';
import { checkEnvironment } from './environment.js';

// ---------------------------------------------------------------------------
// Dispatch convenience wrapper
// ---------------------------------------------------------------------------

/**
 * High-level dispatch wrapper that combines common operation sequences.
 *
 * Provides single-call entry points that the CLI layer can invoke directly.
 */

/**
 * Create a repo-local HO handoff document.
 */
export async function createHandoffRecord(
  opts: CreateHandoffOpts,
): Promise<DispatchResult<CreateHandoffResult>> {
  return createHandoff(opts);
}

export async function checkDispatchEnvironment(): Promise<DispatchResult<CheckEnvironmentResult>> {
  return checkEnvironment();
}

/**
 * Run cleanup on stale dispatch state.
 *
 * This is a direct passthrough to the cleanup module.
 */
export async function cleanupState(opts?: CleanupOpts): Promise<DispatchResult<CleanupReport>> {
  return cleanup(opts);
}

/**
 * Read dispatch status across token state directories and repo-local run bundles.
 */
export async function readDispatchStatus(dir: string): Promise<DispatchResult<StatusResult>> {
  return status(dir);
}

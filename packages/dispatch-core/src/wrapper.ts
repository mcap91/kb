import type { ReviewOpts, ReviewResult, LaunchOpts, RunResult, CleanupOpts, CleanupReport } from './types.js';
import type { DispatchResult } from './errors.js';
import { review } from './review.js';
import { launch } from './launch.js';
import { cleanup } from './cleanup.js';

// ---------------------------------------------------------------------------
// Dispatch convenience wrapper
// ---------------------------------------------------------------------------

/**
 * High-level dispatch wrapper that combines common operation sequences.
 *
 * Provides single-call entry points that the CLI layer can invoke directly.
 */

/**
 * Review a handoff and return the review result.
 *
 * This is a direct passthrough to the review module, provided for
 * consistent API surface.
 */
export async function reviewHandoff(opts: ReviewOpts): Promise<DispatchResult<ReviewResult>> {
  return review(opts);
}

/**
 * Launch a previously reviewed handoff.
 *
 * This is a direct passthrough to the launch module.
 */
export async function launchReview(opts: LaunchOpts): Promise<DispatchResult<RunResult>> {
  return launch(opts);
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
 * Review and immediately launch a handoff in one step.
 *
 * Combines review + launch into a single convenience call.
 * If review fails, returns the review error.
 * If launch fails, returns the launch error.
 */
export async function reviewAndLaunch(
  reviewOpts: ReviewOpts,
): Promise<DispatchResult<RunResult>> {
  const reviewResult = await review(reviewOpts);
  if (!reviewResult.ok) return reviewResult;

  const launchOpts: LaunchOpts = {
    reviewId: reviewResult.data.reviewId,
    dir: reviewOpts.dir,
    verbose: reviewOpts.verbose,
  };

  return launch(launchOpts);
}

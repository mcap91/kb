import type {
  CheckEnvironmentResult,
  CleanupOpts,
  CleanupReport,
  CreateHandoffOpts,
  CreateHandoffResult,
  InitConfigResult,
  LaunchOpts,
  ReviewOpts,
  ReviewResult,
  RunResult,
  StatusResult,
} from './types.js';
import type { BackgroundLaunchResult, BackgroundLaunchOpts } from './types-background.js';
import type { DispatchResult } from './errors.js';
import { createHandoff } from './create-handoff.js';
import { initConfig } from './registry.js';
import { review } from './review.js';
import { launch } from './launch.js';
import { cleanup } from './cleanup.js';
import { status } from './status.js';
import { checkEnvironment } from './environment.js';
import {
  launchBackground as launchBg,
  reviewAndLaunchBackground as reviewAndLaunchBg,
} from './launch-background.js';

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
 * Create a repo-local HO handoff document.
 */
export async function createHandoffRecord(
  opts: CreateHandoffOpts,
): Promise<DispatchResult<CreateHandoffResult>> {
  return createHandoff(opts);
}

/**
 * Initialize operator-owned dispatch config and default registry.
 */
export async function initializeDispatchConfig(force = false): Promise<DispatchResult<InitConfigResult>> {
  return initConfig(force);
}

export async function checkDispatchEnvironment(): Promise<DispatchResult<CheckEnvironmentResult>> {
  return checkEnvironment();
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
 * Read dispatch status across token state directories and repo-local run bundles.
 */
export async function readDispatchStatus(dir: string): Promise<DispatchResult<StatusResult>> {
  return status(dir);
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
    model: reviewOpts.model,
    effort: reviewOpts.effort,
  };

  return launch(launchOpts);
}

export async function launchReviewBackground(
  opts: BackgroundLaunchOpts,
): Promise<DispatchResult<BackgroundLaunchResult>> {
  return launchBg(opts);
}

export async function reviewAndLaunchInBackground(
  reviewOpts: ReviewOpts,
  backgroundOpts?: { startupTimeoutMs?: number },
): Promise<DispatchResult<BackgroundLaunchResult>> {
  return reviewAndLaunchBg(reviewOpts, backgroundOpts);
}

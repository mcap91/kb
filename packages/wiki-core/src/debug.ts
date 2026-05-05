/**
 * Debug/verbose logging utility for wiki-core.
 *
 * Logging is controlled by:
 * 1. An explicit `verbose` flag passed to operations
 * 2. The KB_VERBOSE environment variable (set to "1" or "true" to enable)
 */

let globalVerbose = false;

/**
 * Check whether verbose logging is enabled via environment variable.
 */
function envVerbose(): boolean {
  const val = process.env['KB_VERBOSE'];
  return val === '1' || val === 'true';
}

/**
 * Set the global verbose flag.
 */
export function setVerbose(verbose: boolean): void {
  globalVerbose = verbose;
}

/**
 * Check if verbose logging is currently active.
 */
export function isVerbose(): boolean {
  return globalVerbose || envVerbose();
}

/**
 * Log a debug message if verbose mode is active.
 */
export function debug(message: string, ...args: unknown[]): void {
  if (isVerbose()) {
    console.error(`[kb:debug] ${message}`, ...args);
  }
}

/**
 * Log a debug message with a specific tag/category.
 */
export function debugTagged(tag: string, message: string, ...args: unknown[]): void {
  if (isVerbose()) {
    console.error(`[kb:${tag}] ${message}`, ...args);
  }
}

/**
 * Error codes for dispatch-core operations.
 */
export type DispatchErrorCode =
  | 'INVALID_HANDOFF'
  | 'MISSING_FIELD'
  | 'FORBIDDEN_FIELD'
  | 'INVALID_AGENT'
  | 'AGENT_NOT_ALLOWED'
  | 'REVIEW_FAILED'
  | 'REVIEW_NOT_FOUND'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_NOT_FOUND'
  | 'HASH_MISMATCH'
  | 'LAUNCH_FAILED'
  | 'EMPTY_RESPONSE'
  | 'REPO_ROOT_MISMATCH'
  | 'CONFIG_NOT_FOUND'
  | 'NOT_BOOTSTRAPPED'
  | 'REGISTRY_NOT_FOUND'
  | 'CLEANUP_ERROR'
  | 'STATUS_ERROR'
  | 'PARSE_ERROR'
  | 'FILE_NOT_FOUND'
  | 'FILE_WRITE_ERROR'
  | 'RUN_NOT_FOUND'
  | 'LOOKUP_FAILED'
  | 'ENVIRONMENT_UNSUPPORTED'
  | 'BACKGROUND_LAUNCH_FAILED'
  | 'WAIT_TIMEOUT'
  // --- v2 dispatch pipeline (PLN-0004 S0) ---
  | 'BAD_RECORD'
  | 'MISSING_WRITE_SCOPE'
  | 'DIRTY_REPO'
  | 'ADMISSION_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'ASSEMBLE_FAILED'
  | 'ADAPTER_FAILED'
  | 'WSL2_EXEC_FAILED'
  | 'CLONE_FAILED'
  | 'DELIVERY_FAILED'
  | 'CAPTURE_FAILED'
  | 'PREFLIGHT_FAILED'
  | 'PIPELINE_FAILED';

/**
 * Discriminated union result type for dispatch-core operations.
 */
export type DispatchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DispatchErrorCode; message: string; detail?: unknown };

/**
 * Create a success result.
 */
export function ok<T>(data: T): DispatchResult<T> {
  return { ok: true, data };
}

/**
 * Create a failure result.
 */
export function fail<T = never>(
  error: DispatchErrorCode,
  message: string,
  detail?: unknown,
): DispatchResult<T> {
  return { ok: false, error, message, detail };
}

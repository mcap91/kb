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
  | 'ALLOCATION_FAILED'
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
  | 'PIPELINE_FAILED'
  // --- v2 background dispatch (PLN-0004 S1) ---
  | 'ACTIVE_RUN_EXISTS'
  // --- v2 credential/registry gates (PLN-0004 S3) ---
  | 'EFFORT_UNSUPPORTED'
  | 'CREDENTIALS_WITH_WEB'
  | 'UNKNOWN_PROFILE'
  | 'CREDENTIAL_NOT_CONFIGURED';

/**
 * Discriminated union result type for dispatch-core operations.
 */
export type DispatchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DispatchErrorCode; message: string; detail?: unknown };

/**
 * Every v2 `DispatchErrorCode` the MCP `dispatch` tool can return as a synchronous
 * refusal (i.e. before a worker is spawned). Single source for the MCP instructions'
 * refusal-code list and a pinning test (PLN-0004 S3 D7) — the codes here are the
 * hand-maintained ground truth; nothing else should hand-list them.
 */
export const V2_REFUSAL_CODES = [
  'BAD_RECORD',
  'MISSING_WRITE_SCOPE',
  'DIRTY_REPO',
  'ADMISSION_FAILED',
  'MODEL_NOT_FOUND',
  'PREFLIGHT_FAILED',
  'ACTIVE_RUN_EXISTS',
  'EFFORT_UNSUPPORTED',
  'CREDENTIALS_WITH_WEB',
  'UNKNOWN_PROFILE',
  'CREDENTIAL_NOT_CONFIGURED',
] as const satisfies readonly DispatchErrorCode[];

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

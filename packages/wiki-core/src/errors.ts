/**
 * Error codes for wiki-core operations.
 */
export type ErrorCode =
  | 'INVALID_PREFIX'
  | 'DUPLICATE_ID'
  | 'MISSING_FIELD'
  | 'INVALID_FIELD'
  | 'INVALID_ENUM'
  | 'BROKEN_REFERENCE'
  | 'CONTRACT_NOT_FOUND'
  | 'MANIFEST_ERROR'
  | 'ALREADY_BOOTSTRAPPED'
  | 'NOT_BOOTSTRAPPED'
  | 'ALLOCATION_FAILED'
  | 'FILE_NOT_FOUND'
  | 'FILE_WRITE_ERROR'
  | 'PARSE_ERROR'
  | 'SCHEMA_VALIDATION'
  | 'LINT_ERROR'
  | 'SEARCH_ERROR'
  | 'GENERATE_ERROR'
  | 'SYNC_ERROR';

/**
 * Discriminated union result type for wiki-core operations.
 */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: ErrorCode; message: string; detail?: unknown };

/**
 * Create a success result.
 */
export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

/**
 * Create a failure result.
 */
export function fail<T = never>(error: ErrorCode, message: string, detail?: unknown): Result<T> {
  return { ok: false, error, message, detail };
}

/**
 * Share Module - Domain Errors
 *
 * All errors are discriminated unions with a 'type' field for easy matching.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Database-related error.
 */
export interface DatabaseError {
  readonly type: 'DatabaseError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * URL is not from an approved domain.
 */
export interface UrlNotAllowedError {
  readonly type: 'UrlNotAllowedError';
  readonly message: string;
  readonly url: string;
}

/**
 * Invalid input (malformed URL or code).
 */
export interface InvalidInputError {
  readonly type: 'InvalidInputError';
  readonly message: string;
  readonly field: string;
}

/**
 * User exceeded daily rate limit.
 */
export interface RateLimitExceededError {
  readonly type: 'RateLimitExceededError';
  readonly message: string;
  readonly userId: string;
  readonly limit: number;
}

/**
 * Hash collision detected (same code for different URLs).
 */
export interface HashCollisionError {
  readonly type: 'HashCollisionError';
  readonly message: string;
  readonly code: string;
}

/**
 * Short link not found.
 */
export interface ShortLinkNotFoundError {
  readonly type: 'ShortLinkNotFoundError';
  readonly message: string;
  readonly code: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All possible share module errors.
 */
export type ShareError =
  | DatabaseError
  | UrlNotAllowedError
  | InvalidInputError
  | RateLimitExceededError
  | HashCollisionError
  | ShortLinkNotFoundError;

// ─────────────────────────────────────────────────────────────────────────────
// Error Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a DatabaseError.
 */
export const createDatabaseError = (message: string, cause?: unknown): DatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
  cause,
});

/**
 * Creates a UrlNotAllowedError.
 */
export const createUrlNotAllowedError = (url: string): UrlNotAllowedError => ({
  type: 'UrlNotAllowedError',
  message: 'URL not allowed. Must match an approved client domain.',
  url,
});

/**
 * Creates an InvalidInputError.
 */
export const createInvalidInputError = (field: string, message: string): InvalidInputError => ({
  type: 'InvalidInputError',
  message,
  field,
});

/**
 * Creates a RateLimitExceededError.
 */
export const createRateLimitExceededError = (
  userId: string,
  limit: number
): RateLimitExceededError => ({
  type: 'RateLimitExceededError',
  message: `Daily limit of ${String(limit)} short links reached. Please try again tomorrow.`,
  userId,
  limit,
});

/**
 * Creates a HashCollisionError.
 */
export const createHashCollisionError = (code: string): HashCollisionError => ({
  type: 'HashCollisionError',
  message: 'Hash collision detected. Cannot create short link. Please contact support.',
  code,
});

/**
 * Creates a ShortLinkNotFoundError.
 */
export const createShortLinkNotFoundError = (code: string): ShortLinkNotFoundError => ({
  type: 'ShortLinkNotFoundError',
  message: `Short link with code '${code}' not found`,
  code,
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Status Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps error types to HTTP status codes.
 */
export const SHARE_ERROR_HTTP_STATUS: Record<ShareError['type'], number> = {
  DatabaseError: 500,
  UrlNotAllowedError: 400,
  InvalidInputError: 400,
  RateLimitExceededError: 429,
  HashCollisionError: 500,
  ShortLinkNotFoundError: 404,
};

/**
 * Gets HTTP status code for an error.
 */
export const getHttpStatusForError = (error: ShareError): number => {
  return SHARE_ERROR_HTTP_STATUS[error.type];
};

/**
 * Domain errors for Entity module.
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

/**
 * Query timeout error.
 */
export interface TimeoutError {
  readonly type: 'TimeoutError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entity not found error.
 */
export interface EntityNotFoundError {
  readonly type: 'EntityNotFoundError';
  readonly message: string;
  readonly cui: string;
}

/**
 * Invalid filter error.
 */
export interface InvalidFilterError {
  readonly type: 'InvalidFilterError';
  readonly message: string;
  readonly field: string;
}

/**
 * Invalid period error.
 */
export interface InvalidPeriodError {
  readonly type: 'InvalidPeriodError';
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All possible entity module errors.
 */
export type EntityError =
  | DatabaseError
  | TimeoutError
  | EntityNotFoundError
  | InvalidFilterError
  | InvalidPeriodError;

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
 * Creates a TimeoutError.
 */
export const createTimeoutError = (message: string, cause?: unknown): TimeoutError => ({
  type: 'TimeoutError',
  message,
  retryable: true,
  cause,
});

/**
 * Creates an EntityNotFoundError.
 */
export const createEntityNotFoundError = (cui: string): EntityNotFoundError => ({
  type: 'EntityNotFoundError',
  message: `Entity with CUI '${cui}' not found`,
  cui,
});

/**
 * Creates an InvalidFilterError.
 */
export const createInvalidFilterError = (field: string, message: string): InvalidFilterError => ({
  type: 'InvalidFilterError',
  message,
  field,
});

/**
 * Creates an InvalidPeriodError.
 */
export const createInvalidPeriodError = (message: string): InvalidPeriodError => ({
  type: 'InvalidPeriodError',
  message,
});

/**
 * Checks if error is a timeout (for special handling).
 */
export const isTimeoutError = (cause: unknown): boolean => {
  if (cause instanceof Error) {
    const msg = cause.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('canceling statement due to statement timeout');
  }
  return false;
};

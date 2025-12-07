/**
 * Domain errors for UAT module.
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
 * UAT not found error.
 */
export interface UATNotFoundError {
  readonly type: 'UATNotFoundError';
  readonly message: string;
  readonly id: number;
}

/**
 * Invalid filter error.
 */
export interface InvalidFilterError {
  readonly type: 'InvalidFilterError';
  readonly message: string;
  readonly field: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All possible UAT module errors.
 */
export type UATError = DatabaseError | TimeoutError | UATNotFoundError | InvalidFilterError;

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
 * Creates a UATNotFoundError.
 */
export const createUATNotFoundError = (id: number): UATNotFoundError => ({
  type: 'UATNotFoundError',
  message: `UAT with ID '${String(id)}' not found`,
  id,
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
 * Checks if error is a timeout (for special handling).
 */
export const isTimeoutError = (cause: unknown): boolean => {
  if (cause instanceof Error) {
    const msg = cause.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('canceling statement due to statement timeout');
  }
  return false;
};

/**
 * Domain errors for INS module.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure Errors
// ─────────────────────────────────────────────────────────────────────────────

export interface DatabaseError {
  readonly type: 'DatabaseError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export interface TimeoutError {
  readonly type: 'TimeoutError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain Errors
// ─────────────────────────────────────────────────────────────────────────────

export interface InvalidFilterError {
  readonly type: 'InvalidFilterError';
  readonly message: string;
  readonly field: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Union
// ─────────────────────────────────────────────────────────────────────────────

export type InsError = DatabaseError | TimeoutError | InvalidFilterError;

// ─────────────────────────────────────────────────────────────────────────────
// Error Constructors
// ─────────────────────────────────────────────────────────────────────────────

export const createDatabaseError = (message: string, cause?: unknown): DatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
  cause,
});

export const createTimeoutError = (message: string, cause?: unknown): TimeoutError => ({
  type: 'TimeoutError',
  message,
  retryable: true,
  cause,
});

export const createInvalidFilterError = (field: string, message: string): InvalidFilterError => ({
  type: 'InvalidFilterError',
  message,
  field,
});

export const isTimeoutError = (cause: unknown): boolean => {
  if (cause instanceof Error) {
    const msg = cause.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('canceling statement due to statement timeout');
  }
  return false;
};

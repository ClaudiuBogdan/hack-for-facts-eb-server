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

export interface ValidationError {
  readonly type: 'ValidationError';
  readonly message: string;
  readonly field: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Union
// ─────────────────────────────────────────────────────────────────────────────

export type InsError = DatabaseError | TimeoutError | InvalidFilterError | ValidationError;

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

export const createValidationError = (field: string, message: string): ValidationError => ({
  type: 'ValidationError',
  message,
  field,
});

/** HTTP status for the REST surface; GraphQL resolvers surface errors as thrown messages. */
export const getHttpStatusForError = (error: InsError): 400 | 500 | 504 => {
  switch (error.type) {
    case 'ValidationError':
    case 'InvalidFilterError':
      return 400;
    case 'TimeoutError':
      return 504;
    case 'DatabaseError':
      return 500;
  }
};

export const isTimeoutError = (cause: unknown): boolean => {
  if (cause instanceof Error) {
    const msg = cause.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('canceling statement due to statement timeout');
  }
  return false;
};

/**
 * Learning Progress Module - Domain Errors
 *
 * Error types for learning progress operations.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Error Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Database operation failed.
 */
export interface DatabaseError {
  readonly type: 'DatabaseError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

/**
 * Too many events in a single request.
 */
export interface TooManyEventsError {
  readonly type: 'TooManyEventsError';
  readonly message: string;
  readonly limit: number;
  readonly provided: number;
}

/**
 * Invalid event data provided.
 */
export interface InvalidEventError {
  readonly type: 'InvalidEventError';
  readonly message: string;
  readonly eventId: string | undefined;
}

/**
 * Requested record was not found.
 */
export interface NotFoundError {
  readonly type: 'NotFoundError';
  readonly message: string;
}

/**
 * Requested operation conflicts with current state.
 */
export interface ConflictError {
  readonly type: 'ConflictError';
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Union of all learning progress errors.
 */
export type LearningProgressError =
  | DatabaseError
  | TooManyEventsError
  | InvalidEventError
  | NotFoundError
  | ConflictError;

// ─────────────────────────────────────────────────────────────────────────────
// Error Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a database error.
 */
export const createDatabaseError = (message: string, cause?: unknown): DatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
  cause,
});

/**
 * Create a too many events error.
 */
export const createTooManyEventsError = (limit: number, provided: number): TooManyEventsError => ({
  type: 'TooManyEventsError',
  message: `Too many events in request. Maximum is ${String(limit)}, but ${String(provided)} were provided.`,
  limit,
  provided,
});

/**
 * Create an invalid event error.
 */
export const createInvalidEventError = (message: string, eventId?: string): InvalidEventError => ({
  type: 'InvalidEventError',
  message,
  eventId,
});

/**
 * Create a not found error.
 */
export const createNotFoundError = (message: string): NotFoundError => ({
  type: 'NotFoundError',
  message,
});

/**
 * Create a conflict error.
 */
export const createConflictError = (message: string): ConflictError => ({
  type: 'ConflictError',
  message,
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Status Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps error types to HTTP status codes.
 */
export const LEARNING_PROGRESS_ERROR_HTTP_STATUS: Record<LearningProgressError['type'], number> = {
  DatabaseError: 500,
  TooManyEventsError: 400,
  InvalidEventError: 400,
  NotFoundError: 404,
  ConflictError: 409,
};

/**
 * Get HTTP status code for a learning progress error.
 */
export const getHttpStatusForError = (error: LearningProgressError): number => {
  return LEARNING_PROGRESS_ERROR_HTTP_STATUS[error.type];
};

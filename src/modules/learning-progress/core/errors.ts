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
 * User has reached maximum event storage limit.
 */
export interface EventLimitExceededError {
  readonly type: 'EventLimitExceededError';
  readonly message: string;
  readonly limit: number;
  readonly current: number;
}

/**
 * Invalid event data provided.
 */
export interface InvalidEventError {
  readonly type: 'InvalidEventError';
  readonly message: string;
  readonly eventId: string | undefined;
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
  | EventLimitExceededError
  | InvalidEventError;

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
 * Create an event limit exceeded error.
 */
export const createEventLimitExceededError = (
  limit: number,
  current: number
): EventLimitExceededError => ({
  type: 'EventLimitExceededError',
  message: `User has reached the maximum event storage limit of ${String(limit)}. Current count: ${String(current)}.`,
  limit,
  current,
});

/**
 * Create an invalid event error.
 */
export const createInvalidEventError = (message: string, eventId?: string): InvalidEventError => ({
  type: 'InvalidEventError',
  message,
  eventId,
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
  EventLimitExceededError: 400,
  InvalidEventError: 400,
};

/**
 * Get HTTP status code for a learning progress error.
 */
export const getHttpStatusForError = (error: LearningProgressError): number => {
  return LEARNING_PROGRESS_ERROR_HTTP_STATUS[error.type];
};

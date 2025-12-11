/**
 * Base error types for the application
 * All domain errors should extend these base types
 */

/**
 * Base interface for all application errors
 */
export interface AppError {
  readonly type: string;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Infrastructure errors (database, network, external services)
 */
export interface InfraError extends AppError {
  readonly type: 'DatabaseError' | 'RedisError' | 'NetworkError' | 'TimeoutError';
  readonly retryable: boolean;
}

/**
 * Validation errors (input validation failures)
 */
export interface ValidationError extends AppError {
  readonly type: 'ValidationError';
  readonly field?: string | undefined;
  readonly value?: unknown;
}

/**
 * Not found errors
 */
export interface NotFoundError extends AppError {
  readonly type: 'NotFoundError';
  readonly resource: string;
  readonly id: string;
}

/**
 * Authorization errors
 */
export interface AuthorizationError extends AppError {
  readonly type: 'AuthorizationError' | 'AuthenticationError';
}

/**
 * Conflict errors (state conflicts, concurrent modifications)
 */
export interface ConflictError extends AppError {
  readonly type: 'ConflictError' | 'InvalidStateError';
  readonly current?: unknown;
  readonly expected?: unknown;
}

export const createNotFoundError = (resource: string, id: string): NotFoundError => ({
  type: 'NotFoundError',
  message: `${resource} with id '${id}' not found`,
  resource,
  id,
});

export const createValidationError = (
  message: string,
  field?: string,
  value?: unknown
): ValidationError => ({
  type: 'ValidationError',
  message,
  ...(field !== undefined && { field }),
  ...(value !== undefined && { value }),
});

export const createConflictError = (
  message: string,
  current?: unknown,
  expected?: unknown
): ConflictError => ({
  type: 'ConflictError',
  message,
  current,
  expected,
});

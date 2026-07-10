export interface DatabaseError {
  type: 'DatabaseError';
  message: string;
  retryable: boolean;
}

export interface ValidationError {
  type: 'ValidationError';
  message: string;
  field?: string;
}

export interface QueueError {
  type: 'QueueError';
  message: string;
  retryable: boolean;
}

export interface NotFoundError {
  type: 'NotFound';
  entity: string;
  id: string;
}

export interface ForbiddenError {
  type: 'Forbidden';
  reason: string;
}

export type SharedError =
  | DatabaseError
  | ValidationError
  | QueueError
  | NotFoundError
  | ForbiddenError;

export const createDatabaseError = (message: string, retryable = true): DatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable,
});

export const createValidationError = (message: string, field?: string): ValidationError => ({
  type: 'ValidationError',
  message,
  ...(field === undefined ? {} : { field }),
});

export const createQueueError = (message: string, retryable = true): QueueError => ({
  type: 'QueueError',
  message,
  retryable,
});

export const createNotFoundError = (entity: string, id: string): NotFoundError => ({
  type: 'NotFound',
  entity,
  id,
});

export const createForbiddenError = (reason: string): ForbiddenError => ({
  type: 'Forbidden',
  reason,
});

export const isRetryableError = (error: { type: string; retryable?: boolean }): boolean => {
  return error.retryable === true;
};

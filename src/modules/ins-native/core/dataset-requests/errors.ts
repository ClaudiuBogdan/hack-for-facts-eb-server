/**
 * Errors of the INS dataset-request feature (moved from the legacy `ins`
 * module in slice 1 commit 5, 2026-09-09; the shape is the legacy REST
 * contract: `{ ok: false, error: <type>, message }` with 400 / 500 / 504).
 */

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

export interface ValidationError {
  readonly type: 'ValidationError';
  readonly message: string;
  readonly field: string;
}

export type DatasetRequestError = DatabaseError | TimeoutError | ValidationError;

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

export const createValidationError = (field: string, message: string): ValidationError => ({
  type: 'ValidationError',
  message,
  field,
});

/** HTTP status for the REST surface. */
export const getHttpStatusForError = (error: DatasetRequestError): 400 | 500 | 504 => {
  switch (error.type) {
    case 'ValidationError':
      return 400;
    case 'TimeoutError':
      return 504;
    case 'DatabaseError':
      return 500;
  }
};

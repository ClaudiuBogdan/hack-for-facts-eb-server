export interface CorrespondenceDatabaseError {
  readonly type: 'CorrespondenceDatabaseError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export interface CorrespondenceValidationError {
  readonly type: 'CorrespondenceValidationError';
  readonly message: string;
}

export interface CorrespondenceConflictError {
  readonly type: 'CorrespondenceConflictError';
  readonly message: string;
}

export interface CorrespondenceNotFoundError {
  readonly type: 'CorrespondenceNotFoundError';
  readonly message: string;
}

export interface CorrespondenceEmailSendError {
  readonly type: 'CorrespondenceEmailSendError';
  readonly message: string;
  readonly retryable: boolean;
}

export type InstitutionCorrespondenceError =
  | CorrespondenceDatabaseError
  | CorrespondenceValidationError
  | CorrespondenceConflictError
  | CorrespondenceNotFoundError
  | CorrespondenceEmailSendError;

export const createDatabaseError = (
  message: string,
  cause?: unknown
): CorrespondenceDatabaseError => ({
  type: 'CorrespondenceDatabaseError',
  message,
  retryable: true,
  cause,
});

export const createValidationError = (message: string): CorrespondenceValidationError => ({
  type: 'CorrespondenceValidationError',
  message,
});

export const createConflictError = (message: string): CorrespondenceConflictError => ({
  type: 'CorrespondenceConflictError',
  message,
});

export const createNotFoundError = (message: string): CorrespondenceNotFoundError => ({
  type: 'CorrespondenceNotFoundError',
  message,
});

export const createEmailSendError = (
  message: string,
  retryable: boolean
): CorrespondenceEmailSendError => ({
  type: 'CorrespondenceEmailSendError',
  message,
  retryable,
});

export const INSTITUTION_CORRESPONDENCE_ERROR_HTTP_STATUS: Record<
  InstitutionCorrespondenceError['type'],
  number
> = {
  CorrespondenceDatabaseError: 500,
  CorrespondenceValidationError: 400,
  CorrespondenceConflictError: 409,
  CorrespondenceNotFoundError: 404,
  CorrespondenceEmailSendError: 502,
};

export const getHttpStatusForError = (error: InstitutionCorrespondenceError): number => {
  return INSTITUTION_CORRESPONDENCE_ERROR_HTTP_STATUS[error.type];
};

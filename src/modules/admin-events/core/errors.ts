export interface AdminEventValidationError {
  type: 'AdminEventValidationError';
  message: string;
  retryable: false;
}

export interface AdminEventQueueError {
  type: 'AdminEventQueueError';
  message: string;
  retryable: boolean;
}

export interface AdminEventFilesystemError {
  type: 'AdminEventFilesystemError';
  message: string;
  retryable: boolean;
}

export interface AdminEventNotFoundError {
  type: 'AdminEventNotFoundError';
  message: string;
  retryable: false;
}

export type AdminEventError =
  | AdminEventValidationError
  | AdminEventQueueError
  | AdminEventFilesystemError
  | AdminEventNotFoundError;

export const createValidationError = (message: string): AdminEventValidationError => ({
  type: 'AdminEventValidationError',
  message,
  retryable: false,
});

export const createQueueError = (message: string, retryable: boolean): AdminEventQueueError => ({
  type: 'AdminEventQueueError',
  message,
  retryable,
});

export const createFilesystemError = (
  message: string,
  retryable: boolean
): AdminEventFilesystemError => ({
  type: 'AdminEventFilesystemError',
  message,
  retryable,
});

export const createNotFoundError = (message: string): AdminEventNotFoundError => ({
  type: 'AdminEventNotFoundError',
  message,
  retryable: false,
});

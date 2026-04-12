export interface CampaignAdminNotificationDatabaseError {
  readonly type: 'DatabaseError';
  readonly message: string;
  readonly retryable: boolean;
}

export interface CampaignAdminNotificationValidationError {
  readonly type: 'ValidationError';
  readonly message: string;
}

export interface CampaignAdminNotificationNotFoundError {
  readonly type: 'NotFoundError';
  readonly message: string;
}

export interface CampaignAdminNotificationConflictError {
  readonly type: 'ConflictError';
  readonly message: string;
}

export type CampaignAdminNotificationError =
  | CampaignAdminNotificationDatabaseError
  | CampaignAdminNotificationValidationError
  | CampaignAdminNotificationNotFoundError
  | CampaignAdminNotificationConflictError;

export const createDatabaseError = (
  message: string,
  retryable = true
): CampaignAdminNotificationDatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable,
});

export const createValidationError = (
  message: string
): CampaignAdminNotificationValidationError => ({
  type: 'ValidationError',
  message,
});

export const createNotFoundError = (message: string): CampaignAdminNotificationNotFoundError => ({
  type: 'NotFoundError',
  message,
});

export const createConflictError = (message: string): CampaignAdminNotificationConflictError => ({
  type: 'ConflictError',
  message,
});

export const getHttpStatusForError = (
  error: CampaignAdminNotificationError
): 400 | 404 | 409 | 500 => {
  switch (error.type) {
    case 'ValidationError':
      return 400;
    case 'NotFoundError':
      return 404;
    case 'ConflictError':
      return 409;
    case 'DatabaseError':
      return 500;
  }
};

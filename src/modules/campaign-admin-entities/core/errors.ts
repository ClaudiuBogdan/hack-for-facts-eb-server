export interface CampaignAdminEntitiesDatabaseError {
  readonly type: 'DatabaseError';
  readonly message: string;
  readonly retryable: boolean;
}

export interface CampaignAdminEntitiesValidationError {
  readonly type: 'ValidationError';
  readonly message: string;
}

export interface CampaignAdminEntitiesNotFoundError {
  readonly type: 'NotFoundError';
  readonly message: string;
}

export interface CampaignAdminEntitiesConflictError {
  readonly type: 'ConflictError';
  readonly message: string;
}

export type CampaignAdminEntitiesError =
  | CampaignAdminEntitiesDatabaseError
  | CampaignAdminEntitiesValidationError
  | CampaignAdminEntitiesNotFoundError
  | CampaignAdminEntitiesConflictError;

export const createDatabaseError = (
  message: string,
  retryable = true
): CampaignAdminEntitiesDatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable,
});

export const createValidationError = (message: string): CampaignAdminEntitiesValidationError => ({
  type: 'ValidationError',
  message,
});

export const createNotFoundError = (message: string): CampaignAdminEntitiesNotFoundError => ({
  type: 'NotFoundError',
  message,
});

export const createConflictError = (message: string): CampaignAdminEntitiesConflictError => ({
  type: 'ConflictError',
  message,
});

export const CAMPAIGN_ADMIN_ENTITIES_ERROR_HTTP_STATUS: Record<
  CampaignAdminEntitiesError['type'],
  400 | 404 | 409 | 500
> = {
  DatabaseError: 500,
  ValidationError: 400,
  NotFoundError: 404,
  ConflictError: 409,
};

export const getHttpStatusForError = (error: CampaignAdminEntitiesError): 400 | 404 | 409 | 500 => {
  return CAMPAIGN_ADMIN_ENTITIES_ERROR_HTTP_STATUS[error.type];
};

export interface CampaignEntityConfigDatabaseError {
  readonly type: 'DatabaseError';
  readonly message: string;
  readonly retryable: boolean;
}

export interface CampaignEntityConfigValidationError {
  readonly type: 'ValidationError';
  readonly message: string;
}

export interface CampaignEntityConfigNotFoundError {
  readonly type: 'NotFoundError';
  readonly message: string;
}

export interface CampaignEntityConfigConflictError {
  readonly type: 'ConflictError';
  readonly message: string;
}

export type CampaignEntityConfigError =
  | CampaignEntityConfigDatabaseError
  | CampaignEntityConfigValidationError
  | CampaignEntityConfigNotFoundError
  | CampaignEntityConfigConflictError;

export const createDatabaseError = (
  message: string,
  retryable = true
): CampaignEntityConfigDatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable,
});

export const createValidationError = (message: string): CampaignEntityConfigValidationError => ({
  type: 'ValidationError',
  message,
});

export const createNotFoundError = (message: string): CampaignEntityConfigNotFoundError => ({
  type: 'NotFoundError',
  message,
});

export const createConflictError = (message: string): CampaignEntityConfigConflictError => ({
  type: 'ConflictError',
  message,
});

export const CAMPAIGN_ENTITY_CONFIG_ERROR_HTTP_STATUS: Record<
  CampaignEntityConfigError['type'],
  400 | 404 | 409 | 500
> = {
  DatabaseError: 500,
  ValidationError: 400,
  NotFoundError: 404,
  ConflictError: 409,
};

export const getHttpStatusForError = (error: CampaignEntityConfigError): 400 | 404 | 409 | 500 => {
  return CAMPAIGN_ENTITY_CONFIG_ERROR_HTTP_STATUS[error.type];
};

/**
 * Advanced Map Analytics Module - Core Errors
 */

export interface UnauthorizedError {
  type: 'UnauthorizedError';
  message: string;
}

export interface ForbiddenError {
  type: 'ForbiddenError';
  message: string;
}

export interface InvalidInputError {
  type: 'InvalidInputError';
  message: string;
}

export interface NotFoundError {
  type: 'NotFoundError';
  message: string;
}

export interface SnapshotLimitReachedError {
  type: 'SnapshotLimitReachedError';
  message: string;
  limit: number;
}

export interface ProviderError {
  type: 'ProviderError';
  message: string;
  cause?: unknown;
}

export type AdvancedMapAnalyticsError =
  | UnauthorizedError
  | ForbiddenError
  | InvalidInputError
  | NotFoundError
  | SnapshotLimitReachedError
  | ProviderError;

export const createUnauthorizedError = (
  message = 'Authentication required'
): UnauthorizedError => ({
  type: 'UnauthorizedError',
  message,
});

export const createForbiddenError = (message = 'Access denied'): ForbiddenError => ({
  type: 'ForbiddenError',
  message,
});

export const createInvalidInputError = (message: string): InvalidInputError => ({
  type: 'InvalidInputError',
  message,
});

export const createNotFoundError = (message: string): NotFoundError => ({
  type: 'NotFoundError',
  message,
});

export const createSnapshotLimitReachedError = (limit: number): SnapshotLimitReachedError => ({
  type: 'SnapshotLimitReachedError',
  message: `Snapshot limit reached. Maximum ${String(limit)} snapshots per map.`,
  limit,
});

export const createProviderError = (message: string, cause?: unknown): ProviderError => ({
  type: 'ProviderError',
  message,
  ...(cause !== undefined ? { cause } : {}),
});

export const ADVANCED_MAP_ANALYTICS_ERROR_HTTP_STATUS: Record<
  AdvancedMapAnalyticsError['type'],
  number
> = {
  UnauthorizedError: 401,
  ForbiddenError: 403,
  InvalidInputError: 400,
  NotFoundError: 404,
  SnapshotLimitReachedError: 409,
  ProviderError: 500,
};

export const getHttpStatusForError = (error: AdvancedMapAnalyticsError): number => {
  return ADVANCED_MAP_ANALYTICS_ERROR_HTTP_STATUS[error.type];
};

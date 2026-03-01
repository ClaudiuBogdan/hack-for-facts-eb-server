/**
 * Advanced Map Analytics Module - Core Errors
 */

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

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

export interface ProviderError {
  type: 'ProviderError';
  message: string;
  cause?: unknown;
}

export type GroupedSeriesError =
  | UnauthorizedError
  | ForbiddenError
  | InvalidInputError
  | ProviderError;

// ─────────────────────────────────────────────────────────────────────────────
// Constructors
// ─────────────────────────────────────────────────────────────────────────────

export const createUnauthorizedError = (
  message = 'Authentication required'
): UnauthorizedError => ({
  type: 'UnauthorizedError',
  message,
});

export const createForbiddenError = (message = 'Access denied for this user'): ForbiddenError => ({
  type: 'ForbiddenError',
  message,
});

export const createInvalidInputError = (message: string): InvalidInputError => ({
  type: 'InvalidInputError',
  message,
});

export const createProviderError = (message: string, cause?: unknown): ProviderError => ({
  type: 'ProviderError',
  message,
  ...(cause !== undefined ? { cause } : {}),
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Mapping
// ─────────────────────────────────────────────────────────────────────────────

export const GROUPED_SERIES_ERROR_HTTP_STATUS: Record<GroupedSeriesError['type'], number> = {
  UnauthorizedError: 401,
  ForbiddenError: 403,
  InvalidInputError: 400,
  ProviderError: 500,
};

export const getHttpStatusForError = (error: GroupedSeriesError): number => {
  return GROUPED_SERIES_ERROR_HTTP_STATUS[error.type];
};

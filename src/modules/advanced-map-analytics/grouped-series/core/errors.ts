/**
 * Advanced Map Analytics Module - Core Errors
 */

// ─────────────────────────────────────────────────────────────────────────────
export interface InvalidInputError {
  type: 'InvalidInputError';
  message: string;
}

export interface ProviderError {
  type: 'ProviderError';
  message: string;
  cause?: unknown;
}

export type GroupedSeriesError = InvalidInputError | ProviderError;

// ─────────────────────────────────────────────────────────────────────────────
// Constructors
// ─────────────────────────────────────────────────────────────────────────────

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
  InvalidInputError: 400,
  ProviderError: 500,
};

export const getHttpStatusForError = (error: GroupedSeriesError): number => {
  return GROUPED_SERIES_ERROR_HTTP_STATUS[error.type];
};

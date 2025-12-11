import type { InfraError, ValidationError } from '@/common/types/errors.js';

/**
 * Error types for the entity-analytics module.
 *
 * Following the core/shell pattern:
 * - Core returns Result<T, EntityAnalyticsError>
 * - Shell (GraphQL) converts errors to appropriate responses
 */
export type EntityAnalyticsError = InfraError | ValidationError | NormalizationDataError;

/**
 * Error when required normalization data is missing.
 * E.g., missing CPI data for a requested year.
 */
export interface NormalizationDataError {
  readonly type: 'NormalizationDataError';
  readonly message: string;
  readonly datasetId?: string;
  readonly year?: number;
}

// -----------------------------------------
// Error Constructors
// -----------------------------------------

export const createDatabaseError = (message: string, cause?: unknown): InfraError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
  cause,
});

export const createTimeoutError = (message: string, cause?: unknown): InfraError => ({
  type: 'TimeoutError',
  message,
  retryable: true,
  cause,
});

export const createValidationError = (
  message: string,
  field?: string,
  value?: unknown
): ValidationError => ({
  type: 'ValidationError',
  message,
  ...(field !== undefined && { field }),
  ...(value !== undefined && { value }),
});

export const createNormalizationDataError = (
  message: string,
  datasetId?: string,
  year?: number
): NormalizationDataError => ({
  type: 'NormalizationDataError',
  message,
  ...(datasetId !== undefined && { datasetId }),
  ...(year !== undefined && { year }),
});

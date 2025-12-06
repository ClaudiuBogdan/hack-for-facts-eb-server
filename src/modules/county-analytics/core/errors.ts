/**
 * County Analytics Module - Domain Errors
 *
 * Error types for county heatmap analytics operations.
 */

/**
 * Error when a required filter field is missing.
 */
export interface MissingRequiredFilterError {
  readonly type: 'MISSING_REQUIRED_FILTER';
  readonly field: string;
  readonly message: string;
}

/**
 * Error when the period selection is invalid.
 */
export interface InvalidPeriodError {
  readonly type: 'INVALID_PERIOD';
  readonly message: string;
}

/**
 * Error when a database operation fails.
 */
export interface DatabaseError {
  readonly type: 'DATABASE_ERROR';
  readonly cause: string;
}

/**
 * Error when normalization fails (e.g., missing exchange rates).
 */
export interface NormalizationError {
  readonly type: 'NORMALIZATION_ERROR';
  readonly message: string;
}

/**
 * Discriminated union of all county analytics errors.
 */
export type CountyAnalyticsError =
  | MissingRequiredFilterError
  | InvalidPeriodError
  | DatabaseError
  | NormalizationError;

/**
 * Factory functions for creating errors.
 */
export const createMissingRequiredFilterError = (field: string): MissingRequiredFilterError => ({
  type: 'MISSING_REQUIRED_FILTER',
  field,
  message: `${field} is required for county heatmap data`,
});

export const createInvalidPeriodError = (message: string): InvalidPeriodError => ({
  type: 'INVALID_PERIOD',
  message,
});

export const createDatabaseError = (cause: string): DatabaseError => ({
  type: 'DATABASE_ERROR',
  cause,
});

export const createNormalizationError = (message: string): NormalizationError => ({
  type: 'NORMALIZATION_ERROR',
  message,
});

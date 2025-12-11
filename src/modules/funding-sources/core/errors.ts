/**
 * Domain error types for Funding Source module.
 */

import type { InfraError } from '@/common/types/errors.js';

/**
 * Error type for funding source operations.
 * Currently only infrastructure errors (database failures).
 */
export type FundingSourceError = InfraError;

/**
 * Creates a database error for funding source operations.
 */
export const createDatabaseError = (message: string, cause?: unknown): InfraError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
  cause,
});

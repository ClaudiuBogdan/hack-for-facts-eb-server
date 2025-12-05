/**
 * Domain error types for Budget Sector module.
 */

import type { InfraError } from '@/common/types/errors.js';

/**
 * Error type for budget sector operations.
 * Currently only infrastructure errors (database failures).
 */
export type BudgetSectorError = InfraError;

/**
 * Creates a database error for budget sector operations.
 */
export const createDatabaseError = (message: string, cause?: unknown): InfraError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
  cause,
});

/**
 * Domain error types for Execution Line Items module.
 */

import type { InfraError } from '@/common/types/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validation error for missing required fields.
 */
export interface MissingRequiredFieldError {
  readonly type: 'MissingRequiredFieldError';
  readonly message: string;
  readonly field: string;
}

/**
 * Union of all execution line item errors.
 */
export type ExecutionLineItemError = InfraError | MissingRequiredFieldError;

// ─────────────────────────────────────────────────────────────────────────────
// Error Factory Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a database error for execution line item operations.
 */
export const createDatabaseError = (message: string, cause?: unknown): InfraError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
  cause,
});

/**
 * Creates a timeout error for slow queries.
 */
export const createTimeoutError = (message: string, cause?: unknown): InfraError => ({
  type: 'TimeoutError',
  message,
  retryable: true,
  cause,
});

/**
 * Creates a validation error for missing required fields.
 */
export const createMissingRequiredFieldError = (field: string): MissingRequiredFieldError => ({
  type: 'MissingRequiredFieldError',
  message: `Required field '${field}' is missing`,
  field,
});

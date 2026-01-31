/**
 * Domain error types for Commitments (budget commitments) module.
 */

import {
  createValidationError as createCommonValidationError,
  type InfraError,
  type ValidationError,
} from '@/common/types/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

export type CommitmentsError = InfraError | ValidationError;

// ─────────────────────────────────────────────────────────────────────────────
// Error Factories
// ─────────────────────────────────────────────────────────────────────────────

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
): ValidationError => createCommonValidationError(message, field, value);

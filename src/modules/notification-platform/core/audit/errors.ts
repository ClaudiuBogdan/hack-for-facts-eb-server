import type { DatabaseError, ValidationError } from '../shared/errors.js';

export interface AuditAppendError {
  type: 'AuditAppendError';
  message: string;
  retryable: boolean;
}

export type AuditError = DatabaseError | ValidationError | AuditAppendError;

export const createAuditAppendError = (message: string, retryable = true): AuditAppendError => ({
  type: 'AuditAppendError',
  message,
  retryable,
});

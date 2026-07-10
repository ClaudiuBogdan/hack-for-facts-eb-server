import type {
  DatabaseError,
  NotFoundError,
  QueueError,
  ValidationError,
} from '../shared/errors.js';

export interface DigestConflictError {
  type: 'DigestConflict';
  batchId: string;
  message: string;
}

export type DigestError =
  | DatabaseError
  | ValidationError
  | QueueError
  | NotFoundError
  | DigestConflictError;

export const createDigestConflictError = (
  batchId: string,
  message: string
): DigestConflictError => ({
  type: 'DigestConflict',
  batchId,
  message,
});

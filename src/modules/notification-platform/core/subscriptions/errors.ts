import type {
  DatabaseError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../shared/errors.js';

export interface SubscriptionConflictError {
  type: 'SubscriptionConflict';
  normalizedKey: string;
}

export type SubscriptionError =
  | DatabaseError
  | ValidationError
  | NotFoundError
  | ForbiddenError
  | SubscriptionConflictError;

export const createSubscriptionConflictError = (
  normalizedKey: string
): SubscriptionConflictError => ({
  type: 'SubscriptionConflict',
  normalizedKey,
});

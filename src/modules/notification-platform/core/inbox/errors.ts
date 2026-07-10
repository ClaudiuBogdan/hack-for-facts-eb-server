import type { DatabaseError, NotFoundError, ValidationError } from '../shared/errors.js';

export type InboxError = DatabaseError | ValidationError | NotFoundError;

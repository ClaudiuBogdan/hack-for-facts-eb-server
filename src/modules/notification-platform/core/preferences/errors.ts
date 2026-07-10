import type { DatabaseError, NotFoundError, ValidationError } from '../shared/errors.js';

export type PreferenceError = DatabaseError | ValidationError | NotFoundError;

/**
 * Classification Module Errors
 */

export interface ClassificationError {
  type: 'DATABASE_ERROR';
  message: string;
}

export const createDatabaseError = (message: string): ClassificationError => ({
  type: 'DATABASE_ERROR',
  message,
});

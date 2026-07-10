import { type RecordView } from './types.js';

export type UserDataError =
  | { type: 'UnknownCategory'; category: string }
  | { type: 'UnknownSchemaVersion'; category: string; schemaVersion: number }
  | { type: 'SchemaVersionWriteDisabled'; category: string; schemaVersion: number }
  | { type: 'InvalidPayload'; violations: readonly string[] }
  | { type: 'PayloadTooLarge'; limitBytes: number }
  | { type: 'InvalidLogicalKey'; rule: string }
  | { type: 'InvalidTarget'; rule: string }
  | { type: 'RevisionConflict'; current: RecordView }
  | { type: 'IdempotencyConflict' }
  | { type: 'UnknownAnnotationNamespace'; category: string; namespace: string }
  | { type: 'ActorNotAllowed'; namespace: string; actorType: string }
  | { type: 'NotFound'; category: string; logicalKey?: string; recordId?: string }
  | { type: 'RecordDeleted'; current: RecordView }
  | { type: 'RecordNotDeleted' }
  | { type: 'QuotaExceeded'; category: string; limit: number }
  | { type: 'RateLimited'; retryAfterSeconds: number }
  | { type: 'AdminAccessNotConfigured'; category: string }
  | { type: 'Forbidden'; reason: string }
  | { type: 'InvalidCursor' }
  | { type: 'DatabaseError'; message: string; retryable: boolean };

export const createUnknownCategory = (category: string): UserDataError => ({
  type: 'UnknownCategory',
  category,
});
export const createUnknownSchemaVersion = (
  category: string,
  schemaVersion: number
): UserDataError => ({ type: 'UnknownSchemaVersion', category, schemaVersion });
export const createSchemaVersionWriteDisabled = (
  category: string,
  schemaVersion: number
): UserDataError => ({ type: 'SchemaVersionWriteDisabled', category, schemaVersion });
export const createInvalidPayload = (violations: readonly string[]): UserDataError => ({
  type: 'InvalidPayload',
  violations,
});
export const createPayloadTooLarge = (limitBytes: number): UserDataError => ({
  type: 'PayloadTooLarge',
  limitBytes,
});
export const createInvalidLogicalKey = (rule: string): UserDataError => ({
  type: 'InvalidLogicalKey',
  rule,
});
export const createInvalidTarget = (rule: string): UserDataError => ({
  type: 'InvalidTarget',
  rule,
});
export const createRevisionConflict = (current: RecordView): UserDataError => ({
  type: 'RevisionConflict',
  current,
});
export const createIdempotencyConflict = (): UserDataError => ({ type: 'IdempotencyConflict' });
export const createUnknownAnnotationNamespace = (
  category: string,
  namespace: string
): UserDataError => ({ type: 'UnknownAnnotationNamespace', category, namespace });
export const createActorNotAllowed = (namespace: string, actorType: string): UserDataError => ({
  type: 'ActorNotAllowed',
  namespace,
  actorType,
});
export const createNotFound = (
  category: string,
  logicalKey?: string,
  recordId?: string
): UserDataError => ({
  type: 'NotFound',
  category,
  ...(logicalKey === undefined ? {} : { logicalKey }),
  ...(recordId === undefined ? {} : { recordId }),
});
export const createRecordDeleted = (current: RecordView): UserDataError => ({
  type: 'RecordDeleted',
  current,
});
export const createRecordNotDeleted = (): UserDataError => ({ type: 'RecordNotDeleted' });
export const createQuotaExceeded = (category: string, limit: number): UserDataError => ({
  type: 'QuotaExceeded',
  category,
  limit,
});
export const createRateLimited = (retryAfterSeconds: number): UserDataError => ({
  type: 'RateLimited',
  retryAfterSeconds,
});
export const createAdminAccessNotConfigured = (category: string): UserDataError => ({
  type: 'AdminAccessNotConfigured',
  category,
});
export const createForbidden = (reason: string): UserDataError => ({ type: 'Forbidden', reason });
export const createInvalidCursor = (): UserDataError => ({ type: 'InvalidCursor' });
export const createDatabaseError = (message: string, retryable: boolean): UserDataError => ({
  type: 'DatabaseError',
  message,
  retryable,
});

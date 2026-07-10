import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { decodeOpaqueJson, encodeOpaqueJson } from '@/common/canonical-json/index.js';

import { createInvalidCursor, type UserDataError } from './errors.js';
import { DecimalSequenceSchema } from './schemas.js';

export interface SyncCursor {
  lastSeq: string;
  cycleHighWater: string | null;
  category: string | null;
}

export const encodeSyncCursor = (cursor: SyncCursor): string => encodeOpaqueJson(cursor);

export const decodeSyncCursor = (raw: string): Result<SyncCursor, UserDataError> => {
  const decodedResult = decodeOpaqueJson(raw);
  if (decodedResult.isErr()) return err(createInvalidCursor());
  const decoded = decodedResult.value;
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
    return err(createInvalidCursor());
  const value = decoded as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || !Value.Check(DecimalSequenceSchema, value['lastSeq']))
    return err(createInvalidCursor());
  if (
    value['cycleHighWater'] !== null &&
    !Value.Check(DecimalSequenceSchema, value['cycleHighWater'])
  )
    return err(createInvalidCursor());
  if (value['category'] !== null && typeof value['category'] !== 'string')
    return err(createInvalidCursor());
  return ok({
    lastSeq: value['lastSeq'],
    cycleHighWater: value['cycleHighWater'],
    category: value['category'],
  });
};

export const validateSyncCursorCategory = (
  cursor: SyncCursor,
  category: string | null
): Result<SyncCursor, UserDataError> =>
  cursor.category === category ? ok(cursor) : err(createInvalidCursor());

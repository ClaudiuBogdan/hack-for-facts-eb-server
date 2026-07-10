import { err, ok, type Result } from 'neverthrow';

import { createInvalidPayload, type UserDataError } from '../errors.js';
import { toRecordView } from '../planners/shared.js';
import {
  decodeSyncCursor,
  encodeSyncCursor,
  validateSyncCursorCategory,
  type SyncCursor,
} from '../sync-cursor.js';
import { type RecordView } from '../types.js';
import { type ReadDeps } from './read-shared.js';

export interface SyncRecordsInput {
  ownerId: string;
  rawCursor: string | null;
  limit?: number;
  category: string | null;
}

export interface SyncRecordsOutput {
  items: RecordView[];
  nextCursor: string;
  hasMore: boolean;
}

export const syncRecords = async (
  deps: ReadDeps,
  input: SyncRecordsInput
): Promise<Result<SyncRecordsOutput, UserDataError>> => {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500)
    return err(createInvalidPayload(['/limit:range']));
  let cursor: SyncCursor = { lastSeq: '0', cycleHighWater: null, category: input.category };
  if (input.rawCursor !== null) {
    const decoded = decodeSyncCursor(input.rawCursor);
    if (decoded.isErr()) return err(decoded.error);
    const categoryMatch = validateSyncCursorCategory(decoded.value, input.category);
    if (categoryMatch.isErr()) return err(categoryMatch.error);
    cursor = categoryMatch.value;
  }
  const page = await deps.readPort.syncSince(input.ownerId, cursor, limit);
  if (page.isErr()) return err(page.error);
  const bound = cursor.cycleHighWater ?? page.value.ownerHighWater;
  const lastItem = page.value.items.at(-1);
  const newLastSeq = lastItem?.lastEventSeq ?? cursor.lastSeq;
  const complete = page.value.items.length === 0 || BigInt(newLastSeq) >= BigInt(bound);
  const completedLastSeq = BigInt(newLastSeq) > BigInt(bound) ? newLastSeq : bound;
  const nextCursor: SyncCursor = complete
    ? { lastSeq: completedLastSeq, cycleHighWater: null, category: input.category }
    : { lastSeq: newLastSeq, cycleHighWater: bound, category: input.category };
  return ok({
    items: page.value.items.map(toRecordView),
    nextCursor: encodeSyncCursor(nextCursor),
    hasMore: !complete,
  });
};

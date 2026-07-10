import { err, ok, type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { toRecordView } from '../planners/shared.js';
import { type RecordView } from '../types.js';
import { type ReadDeps } from './read-shared.js';

export type GetRecordInput =
  | { by: 'key'; ownerId: string; category: string; logicalKey: string }
  | { by: 'id'; ownerId: string; recordId: string };

export const getRecord = async (
  deps: ReadDeps,
  input: GetRecordInput
): Promise<Result<RecordView | null, UserDataError>> => {
  const found =
    input.by === 'key'
      ? await deps.readPort.findByKey(input.ownerId, input.category, input.logicalKey)
      : await deps.readPort.findById(input.ownerId, input.recordId);
  if (found.isErr()) return err(found.error);
  return ok(found.value === null ? null : toRecordView(found.value));
};

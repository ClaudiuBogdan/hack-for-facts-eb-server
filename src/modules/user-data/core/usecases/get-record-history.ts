import { type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { type Page, type UserDataEvent } from '../types.js';
import { type ReadDeps } from './read-shared.js';

export interface GetRecordHistoryInput {
  ownerId: string;
  recordId: string;
  limit: number;
  beforeRevision: number | null;
}

export const getRecordHistory = (
  deps: ReadDeps,
  input: GetRecordHistoryInput
): Promise<Result<Page<UserDataEvent>, UserDataError>> =>
  deps.readPort.historyByRecord(input.ownerId, input.recordId, {
    limit: input.limit,
    beforeRevision: input.beforeRevision,
  });

/**
 * Get Progress Use Case
 */

import { err, ok, type Result } from 'neverthrow';

import { createInvalidEventError, type LearningProgressError } from '../errors.js';
import {
  buildDeltaEventsFromRecords,
  buildSnapshotFromRecords,
  createEmptySnapshot,
  getLatestCursor,
} from '../reducer.js';

import type { LearningProgressRepository } from '../ports.js';
import type { GetProgressResponse } from '../types.js';

export interface GetProgressDeps {
  repo: LearningProgressRepository;
}

export interface GetProgressInput {
  userId: string;
  since: string | undefined;
}

function isValidCursor(cursor: string): boolean {
  return /^[0-9]+$/.test(cursor);
}

export async function getProgress(
  deps: GetProgressDeps,
  input: GetProgressInput
): Promise<Result<GetProgressResponse, LearningProgressError>> {
  const { repo } = deps;
  const { userId, since } = input;

  if (since !== undefined && since !== '' && !isValidCursor(since)) {
    return err(createInvalidEventError('Invalid progress cursor.'));
  }

  const recordsResult = await repo.getRecords(userId);
  if (recordsResult.isErr()) {
    return err(recordsResult.error);
  }

  const records = recordsResult.value;
  const cursor = getLatestCursor(records);

  if (since === undefined || since === '') {
    return ok({
      snapshot: buildSnapshotFromRecords(records),
      events: [],
      cursor,
    });
  }

  return ok({
    snapshot: createEmptySnapshot(),
    events: buildDeltaEventsFromRecords(records, since),
    cursor,
  });
}

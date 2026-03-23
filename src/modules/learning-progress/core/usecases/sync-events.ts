/**
 * Sync Events Use Case
 */

import { err, ok, type Result } from 'neverthrow';

import {
  createInvalidEventError,
  createTooManyEventsError,
  type LearningProgressError,
} from '../errors.js';
import {
  MAX_EVENTS_PER_REQUEST,
  isInteractiveUpdatedEvent,
  isProgressResetEvent,
  type LearningProgressEvent,
} from '../types.js';

import type { LearningProgressRepository } from '../ports.js';

export interface SyncEventsDeps {
  repo: LearningProgressRepository;
}

export interface SyncEventsInput {
  userId: string;
  clientUpdatedAt: string;
  events: readonly LearningProgressEvent[];
}

export interface SyncEventsOutput {
  newEventsCount: number;
}

export async function syncEvents(
  deps: SyncEventsDeps,
  input: SyncEventsInput
): Promise<Result<SyncEventsOutput, LearningProgressError>> {
  const { repo } = deps;
  const { userId, events } = input;

  if (events.length > MAX_EVENTS_PER_REQUEST) {
    return err(createTooManyEventsError(MAX_EVENTS_PER_REQUEST, events.length));
  }

  if (events.length === 0) {
    return ok({ newEventsCount: 0 });
  }

  return repo.withTransaction(async (transactionalRepo) => {
    let appliedCount = 0;

    for (const event of events) {
      if (isProgressResetEvent(event)) {
        const resetResult = await transactionalRepo.resetProgress(userId);
        if (resetResult.isErr()) {
          return err(resetResult.error);
        }
        appliedCount += 1;
        continue;
      }

      if (isInteractiveUpdatedEvent(event)) {
        if (typeof event.payload.record.review !== 'undefined') {
          return err(
            createInvalidEventError('Public progress sync cannot set record.review.', event.eventId)
          );
        }

        const existingRowResult = await transactionalRepo.getRecordForUpdate(
          userId,
          event.payload.record.key
        );
        if (existingRowResult.isErr()) {
          return err(existingRowResult.error);
        }

        const nextRecord =
          existingRowResult.value?.record.review !== undefined
            ? {
                ...event.payload.record,
                review: existingRowResult.value.record.review,
              }
            : event.payload.record;

        const upsertResult = await transactionalRepo.upsertInteractiveRecord({
          userId,
          eventId: event.eventId,
          clientId: event.clientId,
          occurredAt: event.occurredAt,
          record: nextRecord,
          auditEvents: event.payload.auditEvents ?? [],
        });

        if (upsertResult.isErr()) {
          return err(upsertResult.error);
        }

        if (upsertResult.value.applied) {
          appliedCount += 1;
        }
      }
    }

    return ok({ newEventsCount: appliedCount });
  });
}

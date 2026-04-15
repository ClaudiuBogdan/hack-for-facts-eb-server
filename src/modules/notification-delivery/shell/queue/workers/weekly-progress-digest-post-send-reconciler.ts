import { err, ok, type Result } from 'neverthrow';

import {
  getWeeklyDigestCursor,
  upsertWeeklyDigestCursor,
} from '@/modules/learning-progress/core/usecases/weekly-digest-cursor.js';

import { createDatabaseError, type DeliveryError } from '../../../core/errors.js';

import type { WeeklyProgressDigestPostSendReconciler } from '../../../core/ports.js';
import type { LearningProgressRepository } from '@/modules/learning-progress/core/ports.js';
import type { Logger } from 'pino';

export interface WeeklyProgressDigestPostSendReconcilerDeps {
  learningProgressRepo: LearningProgressRepository;
  logger: Logger;
}

const compareInstants = (left: string | null, right: string | null): number => {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return -1;
  }

  if (right === null) {
    return 1;
  }

  const leftValue = Date.parse(left);
  const rightValue = Date.parse(right);

  if (!Number.isNaN(leftValue) && !Number.isNaN(rightValue)) {
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  }

  return left.localeCompare(right);
};

export const createWeeklyProgressDigestPostSendReconciler = (
  deps: WeeklyProgressDigestPostSendReconcilerDeps
): WeeklyProgressDigestPostSendReconciler => {
  const log = deps.logger.child({ component: 'WeeklyProgressDigestPostSendReconciler' });

  return {
    async reconcile(input): Promise<Result<void, DeliveryError>> {
      const existingResult = await getWeeklyDigestCursor(
        { repo: deps.learningProgressRepo },
        { userId: input.userId }
      );
      if (existingResult.isErr()) {
        log.error({ error: existingResult.error, input }, 'Failed to load weekly digest cursor');
        return err(
          createDatabaseError(
            'Failed to load weekly progress digest cursor',
            'retryable' in existingResult.error ? existingResult.error.retryable : false
          )
        );
      }

      const existing = existingResult.value;
      if (
        existing.outboxId === input.outboxId &&
        existing.watermarkAt === input.metadata.watermarkAt
      ) {
        return ok(undefined);
      }

      if (compareInstants(existing.watermarkAt, input.metadata.watermarkAt) > 0) {
        log.info(
          {
            userId: input.userId,
            existingWatermarkAt: existing.watermarkAt,
            incomingWatermarkAt: input.metadata.watermarkAt,
            outboxId: input.outboxId,
          },
          'Skipping weekly digest cursor update because stored watermark is newer'
        );
        return ok(undefined);
      }

      const upsertResult = await upsertWeeklyDigestCursor(
        { repo: deps.learningProgressRepo },
        {
          userId: input.userId,
          payload: {
            campaignKey: input.metadata.campaignKey,
            lastSentAt: input.sentAt.toISOString(),
            watermarkAt: input.metadata.watermarkAt,
            weekKey: input.metadata.weekKey,
            outboxId: input.outboxId,
          },
          occurredAt: input.sentAt.toISOString(),
        }
      );
      if (upsertResult.isErr()) {
        log.error({ error: upsertResult.error, input }, 'Failed to upsert weekly digest cursor');
        return err(
          createDatabaseError(
            'Failed to update weekly progress digest cursor',
            'retryable' in upsertResult.error ? upsertResult.error.retryable : false
          )
        );
      }

      return ok(undefined);
    },
  };
};

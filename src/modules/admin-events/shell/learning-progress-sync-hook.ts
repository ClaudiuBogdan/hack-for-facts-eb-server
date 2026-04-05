import {
  isInteractiveUpdatedEvent,
  type LearningProgressEvent,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

import { LEARNING_PROGRESS_REVIEW_PENDING_EVENT_TYPE } from './events/learning-progress-review-pending.js';
import { queueAdminEvent } from '../core/usecases/queue-admin-event.js';

import type { AdminEventQueuePort } from '../core/ports.js';
import type { AdminEventRegistry } from '../core/registry.js';
import type { Logger } from 'pino';

export interface LearningProgressAdminEventSyncHookDeps {
  registry: AdminEventRegistry;
  queue: AdminEventQueuePort;
  learningProgressRepo: LearningProgressRepository;
  logger: Logger;
}

export interface LearningProgressAdminEventSyncHookInput {
  userId: string;
  events: readonly LearningProgressEvent[];
}

export const createLearningProgressAdminEventSyncHook = (
  deps: LearningProgressAdminEventSyncHookDeps
) => {
  return async (input: LearningProgressAdminEventSyncHookInput): Promise<void> => {
    for (const event of input.events) {
      if (!isInteractiveUpdatedEvent(event)) {
        continue;
      }

      const recordKey = event.payload.record.key;
      const recordResult = await deps.learningProgressRepo.getRecord(input.userId, recordKey);
      if (recordResult.isErr()) {
        throw new Error(recordResult.error.message);
      }

      if (recordResult.value?.record.phase !== 'pending') {
        continue;
      }

      const queueResult = await queueAdminEvent(
        {
          registry: deps.registry,
          queue: deps.queue,
        },
        {
          eventType: LEARNING_PROGRESS_REVIEW_PENDING_EVENT_TYPE,
          payload: {
            userId: input.userId,
            recordKey,
          },
        }
      );
      if (queueResult.isErr()) {
        throw new Error(queueResult.error.message);
      }
    }
  };
};

import {
  isInteractiveUpdatedEvent,
  type LearningProgressEvent,
} from '@/modules/learning-progress/index.js';

import type { UserEventJobPayload } from './types.js';

export const buildLearningProgressUserEventJob = (
  userId: string,
  event: LearningProgressEvent
): UserEventJobPayload => {
  const base = {
    source: 'learning_progress' as const,
    userId,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
  };

  if (isInteractiveUpdatedEvent(event)) {
    return {
      ...base,
      eventType: 'interactive.updated',
      recordKey: event.payload.record.key,
    };
  }

  return {
    ...base,
    eventType: 'progress.reset',
  };
};

export const buildLearningProgressUserEventJobs = (
  userId: string,
  events: readonly LearningProgressEvent[]
): UserEventJobPayload[] => {
  return events.map((event) => buildLearningProgressUserEventJob(userId, event));
};

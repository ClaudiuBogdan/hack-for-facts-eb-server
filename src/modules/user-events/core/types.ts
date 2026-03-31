import type { LearningProgressEventType } from '@/modules/learning-progress/index.js';

export type UserEventSource = 'learning_progress';

interface UserEventBase {
  source: UserEventSource;
  userId: string;
  eventId: string;
  eventType: LearningProgressEventType;
  occurredAt: string;
}

export interface LearningProgressInteractiveUpdatedUserEvent extends UserEventBase {
  eventType: 'interactive.updated';
  recordKey: string;
}

export interface LearningProgressResetUserEvent extends UserEventBase {
  eventType: 'progress.reset';
}

export type UserEventJobPayload =
  | LearningProgressInteractiveUpdatedUserEvent
  | LearningProgressResetUserEvent;

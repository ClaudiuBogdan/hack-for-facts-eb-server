import { buildLearningProgressUserEventJobs } from '../../core/learning-progress.js';

import type { UserEventPublisher } from '../../core/ports.js';
import type { LearningProgressEvent } from '@/modules/learning-progress/index.js';
import type { Logger } from 'pino';

export interface LearningProgressUserEventSyncHookDeps {
  publisher: UserEventPublisher;
  logger: Logger;
}

export interface LearningProgressUserEventSyncHookInput {
  userId: string;
  events: readonly LearningProgressEvent[];
}

export const createLearningProgressUserEventSyncHook = (
  deps: LearningProgressUserEventSyncHookDeps
) => {
  const { publisher } = deps;

  return async (input: LearningProgressUserEventSyncHookInput): Promise<void> => {
    const jobs = buildLearningProgressUserEventJobs(input.userId, input.events);

    if (jobs.length === 0) {
      return;
    }

    await publisher.publishMany(jobs);
  };
};

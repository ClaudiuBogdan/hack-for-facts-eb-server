import {
  buildUserEventQueueJob,
  getUserEventJobOptions,
  USER_EVENT_JOB_NAME,
} from './job-options.js';

import type { UserEventPublisher } from '../../core/ports.js';
import type { UserEventJobPayload } from '../../core/types.js';
import type { Queue } from 'bullmq';

export interface UserEventPublisherConfig {
  userEventQueue: Queue<UserEventJobPayload>;
}

export const makeUserEventPublisher = (config: UserEventPublisherConfig): UserEventPublisher => {
  const { userEventQueue } = config;

  return {
    async publish(job) {
      await userEventQueue.add(USER_EVENT_JOB_NAME, job, getUserEventJobOptions(job));
    },

    async publishMany(jobs) {
      if (jobs.length === 0) {
        return;
      }

      await userEventQueue.addBulk(jobs.map((job) => buildUserEventQueueJob(job)));
    },
  };
};

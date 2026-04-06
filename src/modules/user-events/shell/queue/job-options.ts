import { buildBullmqJobId } from '@/infra/queue/job-id.js';

import type { UserEventJobPayload } from '../../core/types.js';

export const USER_EVENT_JOB_NAME = 'user-event';
export const USER_EVENT_JOB_ATTEMPTS = 3;
export const USER_EVENT_JOB_BACKOFF_DELAY_MS = 5000;
export const USER_EVENT_JOB_REMOVE_ON_FAIL_COUNT = 500;

const normalizeSourceForJobId = (source: UserEventJobPayload['source']): string => {
  return source.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
};

export const getUserEventJobId = (job: UserEventJobPayload): string => {
  return buildBullmqJobId(normalizeSourceForJobId(job.source), job.userId, job.eventId);
};

export const getUserEventJobOptions = (job: UserEventJobPayload) => ({
  jobId: getUserEventJobId(job),
  attempts: USER_EVENT_JOB_ATTEMPTS,
  backoff: {
    type: 'exponential' as const,
    delay: USER_EVENT_JOB_BACKOFF_DELAY_MS,
  },
  removeOnComplete: true,
  removeOnFail: {
    count: USER_EVENT_JOB_REMOVE_ON_FAIL_COUNT,
  },
});

export const buildUserEventQueueJob = (job: UserEventJobPayload) => ({
  name: USER_EVENT_JOB_NAME,
  data: job,
  opts: getUserEventJobOptions(job),
});

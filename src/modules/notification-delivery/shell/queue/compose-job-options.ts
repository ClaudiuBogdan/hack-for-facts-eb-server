import {
  MAX_RETRY_ATTEMPTS,
  type ComposeJobPayload,
  type ComposeOutboxJobPayload,
  type ComposeSubscriptionJobPayload,
} from '../../core/types.js';

import type { Queue } from 'bullmq';

export const COMPOSE_JOB_BACKOFF_DELAY_MS = 5000;

export const getComposeJobId = (job: ComposeJobPayload): string => {
  return job.kind === 'outbox'
    ? `compose-outbox-${job.outboxId}`
    : `compose-${job.notificationId}-${job.periodKey}`;
};

export const getComposeJobOptions = (job: ComposeJobPayload) => ({
  jobId: getComposeJobId(job),
  attempts: MAX_RETRY_ATTEMPTS,
  backoff: {
    type: 'exponential' as const,
    delay: COMPOSE_JOB_BACKOFF_DELAY_MS,
  },
  removeOnComplete: true,
  removeOnFail: true,
});

export const buildSubscriptionComposeJob = (payload: ComposeSubscriptionJobPayload) => ({
  name: 'compose',
  data: payload,
  opts: getComposeJobOptions(payload),
});

export const enqueueOutboxComposeJob = async (
  composeQueue: Queue<ComposeJobPayload>,
  outboxId: string,
  runId = `recovery-${outboxId}`
): Promise<void> => {
  const payload: ComposeOutboxJobPayload = {
    runId,
    kind: 'outbox',
    outboxId,
  };

  await composeQueue.add('compose', payload, getComposeJobOptions(payload));
};

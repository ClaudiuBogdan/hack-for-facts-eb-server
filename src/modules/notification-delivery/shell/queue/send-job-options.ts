import { MAX_RETRY_ATTEMPTS, type SendJobPayload } from '../../core/types.js';

import type { Queue } from 'bullmq';

export const SEND_JOB_BACKOFF_DELAY_MS = 5000;

export const getSendJobId = (outboxId: string): string => {
  return `send-${outboxId}`;
};

export const getSendJobOptions = (outboxId: string) => ({
  jobId: getSendJobId(outboxId),
  attempts: MAX_RETRY_ATTEMPTS,
  backoff: {
    type: 'exponential' as const,
    delay: SEND_JOB_BACKOFF_DELAY_MS,
  },
  removeOnComplete: true,
  removeOnFail: true,
});

export const enqueueSendJob = async (
  sendQueue: Queue<SendJobPayload>,
  outboxId: string
): Promise<void> => {
  await sendQueue.add('send', { outboxId }, getSendJobOptions(outboxId));
};

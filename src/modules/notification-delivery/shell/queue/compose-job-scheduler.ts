import { ok, err, type Result } from 'neverthrow';

import { getComposeJobOptions } from './compose-job-options.js';
import { createQueueError, type DeliveryError } from '../../core/errors.js';

import type { ComposeJobScheduler } from '../../core/ports.js';
import type { ComposeJobPayload } from '../../core/types.js';
import type { Queue } from 'bullmq';

export interface ComposeJobSchedulerConfig {
  composeQueue: Queue<ComposeJobPayload>;
}

export const makeComposeJobScheduler = (config: ComposeJobSchedulerConfig): ComposeJobScheduler => {
  const { composeQueue } = config;

  return {
    async enqueue(job: ComposeJobPayload): Promise<Result<void, DeliveryError>> {
      try {
        await composeQueue.add('compose', job, getComposeJobOptions(job));
        return ok(undefined);
      } catch (error) {
        return err(
          createQueueError(
            error instanceof Error ? error.message : 'Failed to enqueue compose job',
            true
          )
        );
      }
    },
  };
};

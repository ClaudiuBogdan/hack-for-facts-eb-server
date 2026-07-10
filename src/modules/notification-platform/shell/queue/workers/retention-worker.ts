import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError, Worker } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { unwrapWorkerResult } from './worker-helpers.js';

import type { Clock, LoggerPort } from '../../../core/shared/ports.js';
import type { RetentionRunner, RetentionSummary } from '../../retention/apply-retention.js';
import type { RetentionJobPayload } from '../schedulers.js';
import type { Redis } from 'ioredis';

const RetentionJobPayloadSchema = Type.Object(
  { batchLimit: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false }
);

export interface RetentionProcessorDeps {
  retention: RetentionRunner;
  clock: Clock;
  logger: LoggerPort;
}

export interface RetentionWorkerDeps extends RetentionProcessorDeps {
  redis: Redis;
  bullmqPrefix: string;
  concurrency?: number;
}

export const processRetentionJob = async (
  deps: RetentionProcessorDeps,
  payload: unknown
): Promise<RetentionSummary> => {
  if (!Value.Check(RetentionJobPayloadSchema, payload)) {
    throw new UnrecoverableError('Invalid retention job payload');
  }

  deps.logger.info('Processing notification platform retention job', {
    batchLimit: payload.batchLimit,
  });
  const result = await deps.retention.applyRetention({
    batchLimit: payload.batchLimit,
    now: deps.clock.now(),
  });
  return unwrapWorkerResult(result, deps.logger, 'Notification platform retention job failed', {
    batchLimit: payload.batchLimit,
  });
};

export const createRetentionWorker = (deps: RetentionWorkerDeps): Worker<RetentionJobPayload> =>
  new Worker<RetentionJobPayload>(
    QUEUE_NAMES.NP_RETENTION,
    async (job) => processRetentionJob(deps, job.data),
    {
      connection: deps.redis,
      prefix: deps.bullmqPrefix,
      concurrency: deps.concurrency ?? 1,
    }
  );
